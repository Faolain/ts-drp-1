import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { summarizePublicCampaign, wilson95 } from "./campaign-primitives.js";
export {
	RequestBudget,
	summarizePublicCampaign,
	wilson95,
	type PlannedMatrixSummary,
	type WilsonInterval,
} from "./campaign-primitives.js";
import { PUBLIC_DECISION_RULES } from "./contract.js";
import { assertRawOutputPath, assessRedaction, isRawOutputIgnored } from "./redaction.js";
import {
	type CoverageRequirement,
	CoverageRequirementSchema,
	type EvidenceReport,
	EvidenceReportSchema,
	ExperimentManifestSchema,
	type ThresholdSet,
	type TrialResult,
} from "./schemas.js";

export interface ContractIssue {
	code: string;
	message: string;
	path?: string;
}

export interface CoverageAssessment {
	complete: boolean;
	issues: ContractIssue[];
}

/**
 * Produces a deterministic SHA-256 fingerprint for a JSON-compatible value.
 * @param value - JSON-compatible value to fingerprint.
 * @returns A lowercase SHA-256 digest.
 */
export function fingerprint(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Validates and returns an experiment manifest.
 * @param value - Candidate manifest data.
 * @returns The parsed manifest.
 */
export function parseExperimentManifest(value: unknown): ReturnType<typeof ExperimentManifestSchema.parse> {
	const manifest = ExperimentManifestSchema.parse(value);
	const issues = validateCampaignFreeze(manifest);
	if (issues.length > 0) {
		throw new Error(issues.map((issue) => issue.message).join("\n"));
	}
	return manifest;
}

/**
 * Assesses required cells without treating missing evidence as zero-valued data.
 * @param requirementsInput - Pre-registered coverage requirements.
 * @param trials - Collected trial results.
 * @returns Completeness and any coverage defects.
 */
export function assessCoverage(requirementsInput: CoverageRequirement[], trials: TrialResult[]): CoverageAssessment {
	const requirements = requirementsInput.map((requirement) => CoverageRequirementSchema.parse(requirement));
	const issues: ContractIssue[] = [];
	const requirementKeys = new Set<string>();

	for (const requirement of requirements) {
		const requirementKey = requirement.decisionId;
		if (requirementKeys.has(requirementKey)) {
			issues.push({
				code: "duplicate-requirement",
				message: `duplicate coverage requirement for ${requirement.decisionId}`,
			});
			continue;
		}
		requirementKeys.add(requirementKey);

		for (const cell of enumerateCells(requirement.dimensions)) {
			const matches = trials.filter((trial) => {
				return (
					trial.status !== "environment-blocked" &&
					trial.decisionId === requirement.decisionId &&
					trial.evidencePhase === requirement.evidencePhase &&
					Object.entries(cell).every(([dimension, value]) => trial.dimensions[dimension] === value)
				);
			});
			if (matches.length === 0) {
				issues.push({
					code: "missing-cell",
					message: `missing ${requirement.decisionId} cell ${canonicalJson(cell)}`,
				});
			} else if (matches.length < requirement.minimumSampleCount) {
				issues.push({
					code: "undersized-cell",
					message: `${requirement.decisionId} cell ${canonicalJson(cell)} has ${matches.length}/${requirement.minimumSampleCount} samples`,
				});
			}
		}
	}

	const trialIds = new Set<string>();
	const decisionIdentities = new Set<string>();
	for (const trial of trials) {
		if (trialIds.has(trial.trialId)) {
			issues.push({ code: "duplicate-trial", message: `duplicate trial ID ${trial.trialId}` });
		}
		const decisionIdentity = `${trial.decisionId}:${trial.identityPseudonym}`;
		if (decisionIdentities.has(decisionIdentity)) {
			issues.push({
				code: "reused-identity",
				message: `identity pseudonym ${trial.identityPseudonym} appears more than once for ${trial.decisionId}`,
			});
		}
		trialIds.add(trial.trialId);
		decisionIdentities.add(decisionIdentity);
	}

	return { complete: issues.length === 0, issues };
}

/**
 * Validates report semantics, including frozen thresholds and complete coverage.
 * @param value - Candidate evidence report.
 * @returns Completeness and semantic or schema defects.
 */
export function assessEvidenceReport(value: unknown): CoverageAssessment {
	const parsed = EvidenceReportSchema.safeParse(value);
	if (!parsed.success) {
		return {
			complete: false,
			issues: parsed.error.issues.map((issue) => ({
				code: "schema",
				message: issue.message,
				path: issue.path.join("."),
			})),
		};
	}

	const report = parsed.data;
	const issues = assessCoverage(report.coverageRequirements, report.trials).issues;
	issues.push(...validateThresholdBinding(report));
	issues.push(...validateRuleBindings(report));
	issues.push(...validateRunBindings(report));
	issues.push(...validateCampaignTarget(report));
	issues.push(...validateTemporalBindings(report));
	issues.push(...validateCampaignFreeze(report.manifest));
	issues.push(...validateCampaignCoverage(report));
	issues.push(...validateRequestConsumption(report));
	issues.push(...validateRawOutputBinding(report));
	issues.push(...validateOutcomeBindings(report));
	if (report.comparability === "invalidated") {
		issues.push({
			code: "comparability-invalidated",
			message: "the run contains an amendment and cannot satisfy a comparable complete-evidence gate",
		});
	}
	if (reportFingerprint(report) !== report.reportChecksum) {
		issues.push({ code: "report-checksum-mismatch", message: "report checksum does not match its durable content" });
	}
	const redaction = assessRedaction(report, {
		sensitiveValueDigests: report.manifest.redaction.sensitiveValueDigests,
	});
	issues.push(...redaction.issues.map((message) => ({ code: "redaction", message })));

	return {
		complete: issues.length === 0 && report.status === "complete" && report.comparability === "comparable",
		issues,
	};
}

/**
 * Throws when a report is not complete, comparable, and schema-valid.
 * @param value - Candidate evidence report.
 * @returns The parsed complete report.
 */
export function assertCompleteEvidenceReport(value: unknown): EvidenceReport {
	const report = EvidenceReportSchema.parse(value);
	const assessment = assessEvidenceReport(report);
	if (!assessment.complete) {
		throw new Error(assessment.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
	}
	return report;
}

function validateThresholdBinding(report: EvidenceReport): ContractIssue[] {
	const currentFingerprint = fingerprint(report.thresholdSet);
	if (currentFingerprint === report.manifest.thresholdSetFingerprint) {
		return [];
	}
	const amendment = report.manifest.amendments.find((candidate) => {
		return (
			candidate.kind === "threshold-change" &&
			candidate.beforeFingerprint === report.manifest.thresholdSetFingerprint &&
			candidate.afterFingerprint === currentFingerprint &&
			Date.parse(candidate.recordedAt) >= Date.parse(report.manifest.startedAt)
		);
	});
	if (amendment === undefined) {
		return [
			{
				code: "unrecorded-threshold-change",
				message: "threshold set changed after the run began without a comparability-invalidating amendment",
			},
		];
	}
	return [];
}

function validateRuleBindings(report: EvidenceReport): ContractIssue[] {
	const issues: ContractIssue[] = [];
	const requirements = new Map(report.coverageRequirements.map((requirement) => [requirement.decisionId, requirement]));
	for (const rule of report.thresholdSet.rules) {
		const requirement = requirements.get(rule.id);
		if (requirement === undefined) {
			issues.push({ code: "missing-requirement", message: `decision ${rule.id} has no coverage requirement` });
			continue;
		}
		const requirementDimensions = Object.keys(requirement.dimensions).sort();
		const ruleDimensions = [...rule.cellDimensions].sort();
		if (canonicalJson(requirementDimensions) !== canonicalJson(ruleDimensions)) {
			issues.push({
				code: "dimension-mismatch",
				message: `decision ${rule.id} rule and coverage dimensions differ`,
			});
		}
		if (
			requirement.evidencePhase !== rule.evidencePhase ||
			requirement.minimumSampleCount !== rule.minimumSampleCount
		) {
			issues.push({
				code: "sample-binding-mismatch",
				message: `decision ${rule.id} rule and coverage source/sample binding differ`,
			});
		}
	}
	return issues;
}

function validateRunBindings(report: EvidenceReport): ContractIssue[] {
	const issues: ContractIssue[] = [];
	for (const trial of report.trials) {
		if (trial.runId !== report.manifest.runId) {
			issues.push({
				code: "run-mismatch",
				message: `trial ${trial.trialId} belongs to ${trial.runId}, not ${report.manifest.runId}`,
			});
		}
	}
	return issues;
}

function validateOutcomeBindings(report: EvidenceReport): ContractIssue[] {
	const issues: ContractIssue[] = [];
	const outcomes = new Map<string, EvidenceReport["decisions"][number]>();
	for (const outcome of report.decisions) {
		if (outcomes.has(outcome.decisionId)) {
			issues.push({ code: "duplicate-outcome", message: `duplicate outcome for ${outcome.decisionId}` });
		}
		outcomes.set(outcome.decisionId, outcome);
	}

	for (const rule of report.thresholdSet.rules) {
		const outcome = outcomes.get(rule.id);
		if (outcome === undefined) {
			issues.push({ code: "missing-outcome", message: `decision ${rule.id} has no outcome` });
			continue;
		}
		const trials = report.trials.filter((trial) => {
			return trial.decisionId === rule.id && trial.status !== "environment-blocked";
		});
		if (outcome.sampleCount !== trials.length) {
			issues.push({
				code: "outcome-sample-mismatch",
				message: `${rule.id} outcome reports ${outcome.sampleCount} samples but has ${trials.length} usable trials`,
			});
		}
		if (outcome.acceptance === "environment-blocked") {
			continue;
		}
		if (rule.statistic === "report-only" && outcome.acceptance !== "report-only") {
			issues.push({ code: "invalid-verdict", message: `${rule.id} is pre-registered as report-only` });
		}
		const successCount = trials.filter((trial) => trial.status === "success").length;
		if (rule.statistic === "minimum-diversity") {
			if (outcome.relayDiversity === undefined) {
				issues.push({ code: "missing-diversity", message: `${rule.id} has no aggregate diversity evidence` });
				continue;
			}
			if (outcome.relayDiversity.acceptedReservations !== successCount) {
				issues.push({
					code: "diversity-count-mismatch",
					message: `${rule.id} accepted-reservation count does not match successful trials`,
				});
			}
			const sourceTrialIdsChecksum = fingerprint(
				trials
					.filter((trial) => trial.status === "success")
					.map((trial) => trial.trialId)
					.sort()
			);
			if (outcome.relayDiversity.sourceTrialIdsChecksum !== sourceTrialIdsChecksum) {
				issues.push({
					code: "diversity-source-mismatch",
					message: `${rule.id} aggregate is not bound to its successful source trials`,
				});
			}
			if (
				report.manifest.evidenceChecksums["relay-diversity-aggregate.json"] !==
				outcome.relayDiversity.rawAggregateChecksum
			) {
				issues.push({
					code: "diversity-attestation-mismatch",
					message: `${rule.id} aggregate is not bound to the local raw evidence checksum`,
				});
			}
			const diversityPasses =
				rule.minimumOperatorGroups !== undefined &&
				outcome.relayDiversity.operatorGroupCount >= rule.minimumOperatorGroups;
			const expectedAcceptance = diversityPasses ? "pass" : "fail";
			if (outcome.acceptance !== expectedAcceptance) {
				issues.push({ code: "invalid-verdict", message: `${rule.id} diversity verdict contradicts the frozen rule` });
			}
			continue;
		}
		if (outcome.metrics === undefined) {
			issues.push({ code: "missing-metrics", message: `${rule.id} outcome has no computed metrics` });
			continue;
		}
		if (outcome.metrics.successCount !== successCount) {
			issues.push({
				code: "success-count-mismatch",
				message: `${rule.id} success count does not match successful trials`,
			});
		}
		const calculatedRate = outcome.sampleCount === 0 ? 0 : successCount / outcome.sampleCount;
		if (Math.abs(calculatedRate - outcome.metrics.observedRate) > Number.EPSILON) {
			issues.push({ code: "rate-mismatch", message: `${rule.id} observed rate does not match its counts` });
		}
		if (rule.ciMethod === "wilson-95") {
			const expectedInterval = wilson95(successCount, outcome.sampleCount);
			if (outcome.metrics.wilson95 === undefined) {
				issues.push({ code: "missing-ci", message: `${rule.id} must report a Wilson 95% interval` });
			} else if (
				!nearlyEqual(outcome.metrics.wilson95.lower, expectedInterval.lower) ||
				!nearlyEqual(outcome.metrics.wilson95.upper, expectedInterval.upper)
			) {
				issues.push({ code: "ci-mismatch", message: `${rule.id} Wilson interval does not match verified counts` });
			}
		}
		const successfulDurations = trials.filter((trial) => trial.status === "success").map((trial) => trial.durationMs);
		const expectedP95 = percentile95(successfulDurations);
		if (outcome.metrics.p95Ms !== expectedP95) {
			issues.push({ code: "p95-mismatch", message: `${rule.id} p95 does not match successful trial durations` });
		}
		const fallbackDurations = trials.flatMap((trial) => {
			return trial.fallbackDurationMs === undefined ? [] : [trial.fallbackDurationMs];
		});
		const failedTrials = trials.filter((trial) => trial.status === "failure");
		const missingFallbackDurations =
			rule.fallbackLatencyThresholdMs !== undefined &&
			failedTrials.some((trial) => trial.fallbackDurationMs === undefined);
		if (missingFallbackDurations) {
			issues.push({
				code: "missing-fallback-duration",
				message: `${rule.id} failed trials must record owned-fallback delay`,
			});
		}
		const expectedFallbackP95 = percentile95(fallbackDurations);
		if (outcome.metrics.fallbackP95Ms !== expectedFallbackP95) {
			issues.push({ code: "fallback-p95-mismatch", message: `${rule.id} fallback p95 does not match trials` });
		}
		const thresholdsPass =
			(rule.successThreshold === undefined || calculatedRate >= rule.successThreshold) &&
			(rule.latencyThresholdMs === undefined ||
				(expectedP95 !== undefined && expectedP95 <= rule.latencyThresholdMs)) &&
			(rule.fallbackLatencyThresholdMs === undefined ||
				(!missingFallbackDurations &&
					(expectedFallbackP95 === undefined || expectedFallbackP95 <= rule.fallbackLatencyThresholdMs))) &&
			(rule.statistic !== "all-pass" || successCount === outcome.sampleCount);
		const expectedAcceptance = rule.statistic === "report-only" ? "report-only" : thresholdsPass ? "pass" : "fail";
		if (outcome.acceptance !== expectedAcceptance) {
			issues.push({ code: "invalid-verdict", message: `${rule.id} verdict contradicts verified frozen thresholds` });
		}
	}

	return issues;
}

function validateTemporalBindings(report: EvidenceReport): ContractIssue[] {
	const issues: ContractIssue[] = [];
	if (Date.parse(report.thresholdSet.frozenAt) > Date.parse(report.manifest.startedAt)) {
		issues.push({ code: "late-threshold-freeze", message: "thresholds were frozen after the run started" });
	}
	const lastTrialAt = Math.max(
		Date.parse(report.manifest.startedAt),
		...report.trials.map((trial) => Date.parse(trial.finishedAt))
	);
	for (const amendment of report.manifest.amendments) {
		if (Date.parse(amendment.recordedAt) < lastTrialAt) {
			issues.push({
				code: "amendment-order",
				message: `${amendment.kind} amendment was recorded before the last trial completed`,
			});
		}
	}
	return issues;
}

function validateCampaignFreeze(manifest: ReturnType<typeof ExperimentManifestSchema.parse>): ContractIssue[] {
	const issues: ContractIssue[] = [];
	const currentFingerprint = fingerprint(manifest.publicCampaign);
	if (manifest.publicCampaignFingerprint !== currentFingerprint) {
		const amendment = manifest.amendments.find((candidate) => {
			return (
				candidate.kind === "campaign-change" &&
				candidate.beforeFingerprint === manifest.publicCampaignFingerprint &&
				candidate.afterFingerprint === currentFingerprint &&
				Date.parse(candidate.recordedAt) >= Date.parse(manifest.startedAt)
			);
		});
		if (amendment === undefined) {
			issues.push({
				code: "unrecorded-campaign-change",
				message: "public campaign plan changed after freezing without a comparability-invalidating amendment",
			});
		}
	}
	const expectedCap = summarizePublicCampaign(manifest.publicCampaign).hardRequestCap;
	if (manifest.hardRequestCap !== expectedCap) {
		issues.push({
			code: "request-cap-mismatch",
			message: `manifest freezes ${manifest.hardRequestCap} requests but its plan requires ${expectedCap}`,
		});
	}
	return issues;
}

function validateCampaignTarget(report: EvidenceReport): ContractIssue[] {
	if (
		report.manifest.target !== "public-campaign" &&
		report.thresholdSet.rules.some((rule) => rule.evidencePhase === "phase-09")
	) {
		return [
			{
				code: "campaign-target-required",
				message: "phase-09 rules require a public-campaign manifest and its full frozen matrix",
			},
		];
	}
	return [];
}

function validateCampaignCoverage(report: EvidenceReport): ContractIssue[] {
	if (report.manifest.target !== "public-campaign") {
		return [];
	}
	const issues: ContractIssue[] = [];
	if (canonicalJson(report.thresholdSet.rules) !== canonicalJson(PUBLIC_DECISION_RULES)) {
		issues.push({
			code: "threshold-contract-mismatch",
			message: "public campaigns must preserve the complete pre-registered issue #5 decision rule set",
		});
	}
	const plan = report.manifest.publicCampaign;
	const profiles = Object.keys(plan.transportProfileSplit);
	const expectedByDecision = new Map<string, CoverageRequirement>([
		[
			"node-dht-cold-bootstrap",
			{
				decisionId: "node-dht-cold-bootstrap",
				dimensions: { networkCondition: plan.conditions },
				evidencePhase: "phase-09",
				minimumSampleCount: plan.nodeIdentitiesPerCondition,
			},
		],
		[
			"delegated-first-valid-peer",
			{
				decisionId: "delegated-first-valid-peer",
				dimensions: { browser: plan.browsers, networkCondition: plan.conditions },
				evidencePhase: "phase-09",
				minimumSampleCount: plan.browserIdentitiesPerBrowserCondition,
			},
		],
		...["public-relay-supported-baseline", "public-relay-optional-overflow"].map((decisionId) => {
			return [
				decisionId,
				{
					decisionId,
					dimensions: {
						browser: plan.browsers,
						networkCondition: plan.conditions,
						transportProfile: profiles,
					},
					evidencePhase: "phase-09",
					minimumSampleCount: 50,
				},
			] as const;
		}),
		[
			"public-relay-diversity",
			{
				decisionId: "public-relay-diversity",
				dimensions: {},
				evidencePhase: "phase-09",
				minimumSampleCount: plan.conditions.length * plan.browsers.length * plan.browserIdentitiesPerBrowserCondition,
			},
		],
		[
			"public-direct-webrtc-canary",
			{
				decisionId: "public-direct-webrtc-canary",
				dimensions: { browser: plan.browsers, networkCondition: plan.conditions },
				evidencePhase: "phase-09",
				minimumSampleCount: 1,
			},
		],
	]);

	for (const [decisionId, expected] of expectedByDecision) {
		const actual = report.coverageRequirements.find((requirement) => requirement.decisionId === decisionId);
		if (actual === undefined || canonicalJson(actual) !== canonicalJson(expected)) {
			issues.push({
				code: "campaign-coverage-mismatch",
				message: `${decisionId} coverage does not match the frozen public campaign matrix`,
			});
		}
	}

	const balancedDecisions = [
		"delegated-first-valid-peer",
		"public-relay-supported-baseline",
		"public-relay-optional-overflow",
	];
	for (const decisionId of balancedDecisions) {
		for (const browser of plan.browsers) {
			for (const condition of plan.conditions) {
				for (const [profile, required] of Object.entries(plan.transportProfileSplit)) {
					const count = report.trials.filter((trial) => {
						return (
							trial.status !== "environment-blocked" &&
							trial.decisionId === decisionId &&
							trial.dimensions.browser === browser &&
							trial.dimensions.networkCondition === condition &&
							trial.dimensions.transportProfile === profile
						);
					}).length;
					if (count !== required) {
						issues.push({
							code: "transport-balance-mismatch",
							message: `${decisionId} ${browser}/${condition}/${profile} has ${count} trials; exactly ${required} are frozen`,
						});
					}
				}
			}
		}
	}
	return issues;
}

function validateRequestConsumption(report: EvidenceReport): ContractIssue[] {
	const consumed = report.trials.reduce((total, trial) => total + trial.requestCount, 0);
	if (consumed > report.manifest.hardRequestCap) {
		return [
			{
				code: "request-cap-exceeded",
				message: `trials consumed ${consumed} requests but the frozen hard cap is ${report.manifest.hardRequestCap}`,
			},
		];
	}
	return [];
}

function validateRawOutputBinding(report: EvidenceReport): ContractIssue[] {
	const rawPath = report.manifest.redaction.rawOutputDirectory;
	try {
		assertRawOutputPath(rawPath, report.manifest.runId);
	} catch (error) {
		return [{ code: "raw-path-containment", message: error instanceof Error ? error.message : String(error) }];
	}
	const repoRoot = findRepositoryRoot();
	if (repoRoot === undefined || !isRawOutputIgnored(repoRoot, rawPath)) {
		return [{ code: "raw-path-trackable", message: `${rawPath} is not proven ignored by Git` }];
	}
	return [];
}

function findRepositoryRoot(): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

function enumerateCells(dimensions: CoverageRequirement["dimensions"]): Array<Record<string, string>> {
	let cells: Array<Record<string, string>> = [{}];
	for (const [dimension, values] of Object.entries(dimensions)) {
		cells = cells.flatMap((cell) => values.map((value) => ({ ...cell, [dimension]: value })));
	}
	return cells;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => sortJson(item));
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sortJson(child)])
		);
	}
	return value;
}

/**
 * Returns the fingerprint a manifest must freeze before trials begin.
 * @param thresholdSet - Pre-registered threshold set.
 * @returns The canonical threshold-set fingerprint.
 */
export function thresholdSetFingerprint(thresholdSet: ThresholdSet): string {
	return fingerprint(thresholdSet);
}

/**
 * Fingerprints an evidence report without its self-referential checksum field.
 * @param report - Evidence report to fingerprint.
 * @returns Canonical durable report checksum.
 */
export function reportFingerprint(report: EvidenceReport): string {
	const { reportChecksum: _, ...durableContent } = report;
	return fingerprint(durableContent);
}

function percentile95(values: number[]): number | undefined {
	if (values.length === 0) {
		return undefined;
	}
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function nearlyEqual(left: number, right: number): boolean {
	return Math.abs(left - right) <= 1e-12;
}
