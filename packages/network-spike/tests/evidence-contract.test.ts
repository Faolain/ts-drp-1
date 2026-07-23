import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	assertCompleteEvidenceReport,
	assertRawOutputPath,
	assessCoverage,
	assessEvidenceReport,
	assessRedaction,
	type CoverageRequirement,
	createFixtureManifest,
	createFixturePayload,
	DeadlineBudgetSchema,
	type EvidenceReport,
	EvidenceReportSchema,
	fingerprint,
	isRawOutputIgnored,
	parseExperimentManifest,
	reportFingerprint,
	RequestBudget,
	sensitiveValueDigest,
	summarizePublicCampaign,
	type TrialResult,
	wilson95,
} from "../src/index.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const STARTED_AT = "2026-07-20T08:00:00.000Z";
const FINISHED_AT = "2026-07-20T08:00:01.000Z";

describe("Phase 00 evidence contract", () => {
	it("round-trips the fixture manifest and rejects incompatible schema versions", () => {
		const manifest = createFixtureManifest();
		expect(parseExperimentManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
		expect(() => parseExperimentManifest({ ...manifest, schemaVersion: "2.0.0" })).toThrow();
	});

	it("prints a schema-valid fixture with the exact planned matrix and request cap", () => {
		const output = execFileSync("pnpm", ["--filter", "@ts-drp/network-spike", "manifest", "--fixture"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		const payload = JSON.parse(output.slice(output.indexOf("{"))) as ReturnType<typeof createFixturePayload>;
		expect(parseExperimentManifest(payload.manifest)).toEqual(payload.manifest);
		expect(payload.plannedMatrix).toEqual(summarizePublicCampaign(payload.manifest.publicCampaign));
		expect(payload.plannedMatrix).toMatchObject({
			browserTrials: 600,
			hardRequestCap: 12_920,
			nodeTrials: 200,
			requiredTrialCount: 800,
		});
		expect(payload.plannedMatrix.rows).toHaveLength(20);
		expect(payload.plannedMatrix.rows.filter(({ target }) => target === "grid-canary")).toHaveLength(6);
		expect(payload.thresholdSet.rules).toHaveLength(10);
	});

	it("rejects absent, duplicate, undersized, and identity-reusing coverage", () => {
		const requirement = coverageRequirement();
		const completeTrials = [
			trial("trial-1", "peer_a00000000001", "chromium"),
			trial("trial-2", "peer_a00000000002", "chromium"),
			trial("trial-3", "peer_a00000000003", "firefox"),
			trial("trial-4", "peer_a00000000004", "firefox"),
		];
		expect(assessCoverage([requirement], completeTrials)).toEqual({ complete: true, issues: [] });

		const absent = assessCoverage([requirement], []);
		expect(absent.complete).toBe(false);
		expect(absent.issues.map((issue) => issue.code)).toContain("missing-cell");

		const undersized = assessCoverage([requirement], completeTrials.slice(0, 3));
		expect(undersized.issues.map((issue) => issue.code)).toContain("undersized-cell");

		const duplicateRequirement = assessCoverage([requirement, requirement], completeTrials);
		expect(duplicateRequirement.issues.map((issue) => issue.code)).toContain("duplicate-requirement");

		const duplicateTrial = assessCoverage([requirement], [...completeTrials, completeTrials[0]]);
		expect(duplicateTrial.issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining(["duplicate-trial", "reused-identity"])
		);
	});

	it("requires an explicit comparability-invalidating amendment for threshold changes", () => {
		const report = completeReport();
		expect(assertCompleteEvidenceReport(report)).toEqual(report);

		const changedThresholdSet = {
			...report.thresholdSet,
			version: 2,
			rules: report.thresholdSet.rules.map((rule) => ({ ...rule, minimumSampleCount: 3 })),
		};
		const changedRequirement = {
			...report.coverageRequirements[0],
			minimumSampleCount: 3,
		};
		const changedTrials = [
			...report.trials,
			trial("trial-5", "peer_a00000000005", "chromium"),
			trial("trial-6", "peer_a00000000006", "firefox"),
		];
		const unamended = sealReport({
			...report,
			coverageRequirements: [changedRequirement],
			decisions: [
				{
					...report.decisions[0],
					metrics: {
						observedRate: 1,
						p95Ms: 1_000,
						successCount: 6,
						wilson95: wilson95(6, 6),
					},
					sampleCount: 6,
				},
			],
			thresholdSet: changedThresholdSet,
			trials: changedTrials,
		});
		expect(assessEvidenceReport(unamended).issues.map((issue) => issue.code)).toContain("unrecorded-threshold-change");

		const amended = sealReport({
			...unamended,
			comparability: "invalidated",
			manifest: {
				...report.manifest,
				amendments: [
					{
						afterFingerprint: fingerprint(changedThresholdSet),
						beforeFingerprint: report.manifest.thresholdSetFingerprint,
						invalidatesComparability: true as const,
						kind: "threshold-change" as const,
						rationale: "The pre-registered sample count changed, so earlier runs are not comparable.",
						recordedAt: "2026-07-20T09:00:00.000Z",
					},
				],
			},
		});
		expect(EvidenceReportSchema.parse(amended)).toEqual(amended);
		expect(assessEvidenceReport(amended).issues.map((issue) => issue.code)).toContain("comparability-invalidated");
		expect(() => assertCompleteEvidenceReport(amended)).toThrow(/comparability-invalidated/u);
	});

	it("enforces the 30 second parent and bounded child deadline allocation", () => {
		expect(
			DeadlineBudgetSchema.parse({
				children: {
					candidateAndFallbackMs: 5_000,
					cleanupMs: 5_000,
					endpointMs: 8_000,
					ownedFallbackMs: 12_000,
				},
				parentMs: 30_000,
			})
		).toBeDefined();
		expect(() =>
			DeadlineBudgetSchema.parse({
				children: {
					candidateAndFallbackMs: 5_001,
					cleanupMs: 5_000,
					endpointMs: 8_000,
					ownedFallbackMs: 12_000,
				},
				parentMs: 30_000,
			})
		).toThrow();
	});

	it("rejects raw identifiers, addresses, namespaces, tokens, and stable hashes", () => {
		const unsafe = {
			ipAddress: "203.0.113.42",
			namespace: "production-grid-room",
			peer: "12D3KooWJ5rP7sZ8mY2vQ4tN6xC9bF3hL1aD7eG5uR8iK2oP4qT",
			relayAsn: "AS64500",
			relayMultiaddr: "/ip6/::1/tcp/443/wss",
			snapshot: "a".repeat(64),
			token: "Bearer top-secret-token-value",
		};
		const assessment = assessRedaction(unsafe);
		expect(assessment.safe).toBe(false);
		expect(assessment.issues.join("\n")).toMatch(/Peer ID|IP address|raw-sensitive|stable hash|token/u);
		expect(
			assessRedaction({
				evidenceChecksum: "a".repeat(64),
				namespacePseudonym: "ns_001122334455",
				peerPseudonym: "peer_aabbccddeeff",
			})
		).toEqual({ safe: true, issues: [] });
		expect(
			assessRedaction(
				{ summary: "production-grid-room" },
				{ sensitiveValueDigests: [sensitiveValueDigest("production-grid-room")] }
			).issues
		).toEqual(["$.summary contains a run-specific sensitive value"]);
		expect(assessRedaction({ summary: "relay group as64500" }).safe).toBe(false);
	});

	it("contains raw paths under the per-run ignored directory", () => {
		expect(assertRawOutputPath(".network-spike-raw/run-1/trials.ndjson", "run-1")).toBe(
			".network-spike-raw/run-1/trials.ndjson"
		);
		expect(() => assertRawOutputPath("../peer-ids.json", "run-1")).toThrow();
		expect(() => assertRawOutputPath(".network-spike-raw/other/trials.json", "run-1")).toThrow();
		expect(() => assertRawOutputPath(".network-spike-raw/run-1/../other/trials.json", "run-1")).toThrow();
		expect(isRawOutputIgnored(REPO_ROOT, ".network-spike-raw/run-1/trials.ndjson")).toBe(true);
	});

	it("stops endpoint calls before the hard request cap is exceeded", () => {
		const budget = new RequestBudget(3);
		budget.consume(2);
		expect(budget.remaining).toBe(1);
		expect(() => budget.consume(2)).toThrow(/request cap exhausted/u);
		expect(budget.consumed).toBe(2);
		budget.consume();
		expect(budget.remaining).toBe(0);

		const report = completeReport();
		const overCap = sealReport({
			...report,
			trials: report.trials.map((value) => ({
				...value,
				requestCount: report.manifest.hardRequestCap,
			})),
		});
		expect(assessEvidenceReport(overCap).issues.map((issue) => issue.code)).toContain("request-cap-exceeded");
		expect(
			EvidenceReportSchema.safeParse({
				...report,
				trials: report.trials.map((value) => ({ ...value, requestCount: 0 })),
			}).success
		).toBe(false);
	});

	it("represents missing real egress as partial environment-blocked evidence", () => {
		const complete = completeReport();
		const partial = {
			...complete,
			decisions: [
				{
					acceptance: "environment-blocked" as const,
					decisionId: "delegated-first-valid-peer",
					sampleCount: 0,
					summary: "A second real egress was not authorized; no condition was synthesized.",
				},
			],
			partialReason: "The required second real egress was not authorized.",
			status: "partial" as const,
			trials: [],
		};
		expect(EvidenceReportSchema.parse(partial)).toEqual(partial);
		expect(assessEvidenceReport(partial).complete).toBe(false);
		expect(() => assertCompleteEvidenceReport(partial)).toThrow();
	});

	it("rejects a pass verdict whose computed metrics miss frozen thresholds", () => {
		const report = completeReport();
		const falsePass = sealReport({
			...report,
			decisions: [
				{
					...report.decisions[0],
					metrics: {
						observedRate: 0.5,
						p95Ms: 25_000,
						successCount: 2,
						wilson95: { lower: 0.15, upper: 0.85 },
					},
				},
			],
		});
		expect(assessEvidenceReport(falsePass).issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining(["success-count-mismatch", "rate-mismatch", "ci-mismatch", "p95-mismatch"])
		);
	});

	it("derives verdicts from trials instead of trusting a claimed pass", () => {
		const report = completeReport();
		const fabricated = sealReport({
			...report,
			trials: report.trials.map((value) => ({ ...value, status: "failure" as const })),
		});
		expect(assessEvidenceReport(fabricated).issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining([
				"success-count-mismatch",
				"rate-mismatch",
				"ci-mismatch",
				"p95-mismatch",
				"invalid-verdict",
			])
		);
	});

	it("keeps exact Wilson intervals within probability bounds", () => {
		expect(wilson95(0, 0)).toEqual({ lower: 0, upper: 0 });
		expect(wilson95(0, 1).lower).toBe(0);
		expect(wilson95(1, 1).upper).toBe(1);
		expect(() => wilson95(2, 1)).toThrow();
	});

	it("rejects incomplete public campaign coverage and an unfrozen campaign plan", () => {
		const report = completeReport();
		const publicReport = sealReport({
			...report,
			manifest: { ...report.manifest, target: "public-campaign" as const },
		});
		expect(assessEvidenceReport(publicReport).issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining([
				"threshold-contract-mismatch",
				"campaign-coverage-mismatch",
				"transport-balance-mismatch",
			])
		);
		const changedCampaign = { ...report.manifest.publicCampaign, conditions: ["one", "two", "three"] };
		expect(() =>
			parseExperimentManifest({
				...report.manifest,
				publicCampaign: changedCampaign,
			})
		).toThrow(/campaign|requests/u);
		expect(
			parseExperimentManifest({
				...report.manifest,
				amendments: [
					{
						afterFingerprint: fingerprint(changedCampaign),
						beforeFingerprint: report.manifest.publicCampaignFingerprint,
						invalidatesComparability: true,
						kind: "campaign-change",
						rationale: "A third authorized egress changes the campaign and invalidates comparability.",
						recordedAt: "2026-07-20T09:00:00.000Z",
					},
				],
				hardRequestCap: summarizePublicCampaign(changedCampaign).hardRequestCap,
				publicCampaign: changedCampaign,
			})
		).toBeDefined();
	});

	it("accepts a complete all-decision public campaign and binds privacy-preserving aggregates", () => {
		const report = completePublicCampaignReport();
		expect(assertCompleteEvidenceReport(report)).toEqual(report);

		const overflowFailureWithoutFallback = sealReport({
			...report,
			trials: report.trials.map((value) => {
				return value.decisionId === "public-relay-optional-overflow" && value.trialId.endsWith("-0000")
					? { ...value, status: "failure" as const }
					: value;
			}),
		});
		expect(assessEvidenceReport(overflowFailureWithoutFallback).issues.map((issue) => issue.code)).toContain(
			"missing-fallback-duration"
		);

		const unbalancedRelay = sealReport({
			...report,
			trials: report.trials.map((value) => {
				return value.decisionId === "public-relay-supported-baseline" &&
					value.dimensions.transportProfile === "wss-only" &&
					value.trialId.endsWith("-0000")
					? {
							...value,
							dimensions: { ...value.dimensions, transportProfile: "wss-wt-webrtc-direct" },
						}
					: value;
			}),
		});
		expect(assessEvidenceReport(unbalancedRelay).issues.map((issue) => issue.code)).toContain(
			"transport-balance-mismatch"
		);

		const unboundDiversity = sealReport({
			...report,
			decisions: report.decisions.map((value) => {
				return value.relayDiversity === undefined
					? value
					: {
							...value,
							relayDiversity: { ...value.relayDiversity, sourceTrialIdsChecksum: "f".repeat(64) },
						};
			}),
		});
		expect(assessEvidenceReport(unboundDiversity).issues.map((issue) => issue.code)).toContain(
			"diversity-source-mismatch"
		);
	});
});

function coverageRequirement(): CoverageRequirement {
	return {
		decisionId: "fixture-observed-rate",
		dimensions: { browser: ["chromium", "firefox"] },
		evidencePhase: "phase-00",
		minimumSampleCount: 2,
	};
}

function trial(trialId: string, identityPseudonym: string, browser: string): TrialResult {
	return {
		decisionId: "fixture-observed-rate",
		dimensions: { browser },
		durationMs: 1_000,
		endpointClass: "delegated-routing",
		evidencePhase: "phase-00",
		finishedAt: FINISHED_AT,
		identityPseudonym,
		namespacePseudonym: "ns_001122334455",
		requestCount: 1,
		runId: "fixture-issue-5",
		schemaVersion: "1.0.0",
		startedAt: STARTED_AT,
		status: "success",
		telemetryChecksum: "a".repeat(64),
		trialId,
	};
}

function completeReport(): EvidenceReport {
	const payload = createFixturePayload();
	const thresholdSet = {
		...payload.thresholdSet,
		rules: [
			{
				cellDimensions: ["browser"],
				ciMethod: "wilson-95" as const,
				evidencePhase: "phase-00",
				id: "fixture-observed-rate",
				interpretation: "public-observation" as const,
				latencyThresholdMs: 20_000,
				minimumSampleCount: 2,
				statistic: "observed-rate" as const,
				successThreshold: 0.95,
			},
		],
	};
	const manifest = {
		...payload.manifest,
		target: "browser" as const,
		thresholdSetFingerprint: fingerprint(thresholdSet),
	};
	const report: EvidenceReport = {
		comparability: "comparable",
		coverageRequirements: [coverageRequirement()],
		decisions: [
			{
				acceptance: "pass",
				decisionId: "fixture-observed-rate",
				metrics: {
					observedRate: 1,
					p95Ms: 1_000,
					successCount: 4,
					wilson95: wilson95(4, 4),
				},
				sampleCount: 4,
				summary: "All pre-registered fixture cells passed.",
			},
		],
		manifest,
		reportChecksum: "b".repeat(64),
		schemaVersion: "1.0.0",
		status: "complete",
		thresholdSet,
		trials: [
			trial("trial-1", "peer_a00000000001", "chromium"),
			trial("trial-2", "peer_a00000000002", "chromium"),
			trial("trial-3", "peer_a00000000003", "firefox"),
			trial("trial-4", "peer_a00000000004", "firefox"),
		],
	};
	return sealReport(report);
}

function sealReport(report: EvidenceReport): EvidenceReport {
	return { ...report, reportChecksum: reportFingerprint(report) };
}

function completePublicCampaignReport(): EvidenceReport {
	const payload = createFixturePayload();
	const trials: TrialResult[] = [];
	const requirements: CoverageRequirement[] = [];
	const addCells = (
		decisionId: string,
		evidencePhase: string,
		dimensions: Record<string, string[]>,
		minimumSampleCount: number,
		endpointClass: TrialResult["endpointClass"],
		extraDimensions?: (cell: Record<string, string>, repetition: number) => Record<string, string>
	): void => {
		requirements.push({ decisionId, dimensions, evidencePhase, minimumSampleCount });
		let index = 0;
		for (const cell of enumerateTestCells(dimensions)) {
			for (let repetition = 0; repetition < minimumSampleCount; repetition += 1) {
				const dimensionsWithExtras = {
					...cell,
					...(extraDimensions?.(cell, repetition) ?? {}),
				};
				trials.push(campaignTrial(decisionId, evidencePhase, index, dimensionsWithExtras, endpointClass));
				index += 1;
			}
		}
	};

	const plan = payload.manifest.publicCampaign;
	addCells("node-dht-cold-bootstrap", "phase-09", { networkCondition: plan.conditions }, 100, "public-dht");
	addCells(
		"delegated-first-valid-peer",
		"phase-09",
		{ browser: plan.browsers, networkCondition: plan.conditions },
		100,
		"delegated-routing",
		(_cell, repetition) => ({
			transportProfile: repetition < 50 ? "wss-only" : "wss-wt-webrtc-direct",
		})
	);
	addCells("gossipsub-mesh-first-sync", "phase-07", { browser: plan.browsers }, 5, "none");
	addCells(
		"public-relay-supported-baseline",
		"phase-09",
		{
			browser: plan.browsers,
			networkCondition: plan.conditions,
			transportProfile: Object.keys(plan.transportProfileSplit),
		},
		50,
		"public-relay"
	);
	addCells(
		"public-relay-optional-overflow",
		"phase-09",
		{
			browser: plan.browsers,
			networkCondition: plan.conditions,
			transportProfile: Object.keys(plan.transportProfileSplit),
		},
		50,
		"public-relay"
	);
	addCells("public-relay-diversity", "phase-09", {}, 600, "public-relay", () => ({
		aggregate: "campaign",
	}));
	addCells("controlled-direct-webrtc-upgrade", "phase-07", { browser: plan.browsers }, 5, "none");
	addCells(
		"public-direct-webrtc-canary",
		"phase-09",
		{ browser: plan.browsers, networkCondition: plan.conditions },
		1,
		"public-relay"
	);
	addCells(
		"relay-registry-loss-recovery",
		"phase-08",
		{ scenario: ["relay-loss", "registry-loss"] },
		1,
		"owned-fallback"
	);
	addCells(
		"total-outage-terminal-diagnostic",
		"phase-08",
		{ scenario: ["composed-total-outage"] },
		1,
		"owned-fallback"
	);

	const rawAggregateChecksum = fingerprint({ acceptedReservations: 600, operatorGroupCount: 2 });
	const manifest = {
		...payload.manifest,
		evidenceChecksums: {
			...payload.manifest.evidenceChecksums,
			"relay-diversity-aggregate.json": rawAggregateChecksum,
		},
	};
	const decisions: EvidenceReport["decisions"] = payload.thresholdSet.rules.map((rule) => {
		const decisionTrials = trials.filter((value) => value.decisionId === rule.id);
		const successCount = decisionTrials.length;
		if (rule.statistic === "minimum-diversity") {
			return {
				acceptance: "pass",
				decisionId: rule.id,
				relayDiversity: {
					acceptedReservations: successCount,
					operatorGroupCount: 2,
					rawAggregateChecksum,
					sourceTrialIdsChecksum: fingerprint(decisionTrials.map((value) => value.trialId).sort()),
					verification: "local-raw-aggregate-attestation",
				},
				sampleCount: decisionTrials.length,
				summary: "Aggregate diversity passed using local raw evidence bound to these trials.",
			};
		}
		return {
			acceptance: rule.statistic === "report-only" ? "report-only" : "pass",
			decisionId: rule.id,
			metrics: {
				observedRate: 1,
				p95Ms: 1_000,
				successCount,
				...(rule.ciMethod === "wilson-95" ? { wilson95: wilson95(successCount, successCount) } : {}),
			},
			sampleCount: decisionTrials.length,
			summary: "All frozen cells passed in the complete campaign fixture.",
		};
	});

	return sealReport({
		comparability: "comparable",
		coverageRequirements: requirements,
		decisions,
		manifest,
		reportChecksum: "0".repeat(64),
		schemaVersion: "1.0.0",
		status: "complete",
		thresholdSet: payload.thresholdSet,
		trials,
	});
}

function campaignTrial(
	decisionId: string,
	evidencePhase: string,
	index: number,
	dimensions: Record<string, string>,
	endpointClass: TrialResult["endpointClass"]
): TrialResult {
	const suffix = index.toString(16).padStart(12, "0");
	return {
		decisionId,
		dimensions,
		durationMs: 1_000,
		endpointClass,
		evidencePhase,
		finishedAt: FINISHED_AT,
		identityPseudonym: `peer_${suffix}`,
		namespacePseudonym: "ns_001122334455",
		requestCount: endpointClass === "none" ? 0 : 1,
		runId: "fixture-issue-5",
		schemaVersion: "1.0.0",
		startedAt: STARTED_AT,
		status: "success",
		telemetryChecksum: fingerprint({ decisionId, index }),
		trialId: `${decisionId}-${index.toString().padStart(4, "0")}`,
	};
}

function enumerateTestCells(dimensions: Record<string, string[]>): Array<Record<string, string>> {
	let cells: Array<Record<string, string>> = [{}];
	for (const [dimension, values] of Object.entries(dimensions)) {
		cells = cells.flatMap((cell) => values.map((value) => ({ ...cell, [dimension]: value })));
	}
	return cells;
}
