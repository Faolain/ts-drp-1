import { z } from "zod";

import { frozenPublicCampaign } from "../campaign-plan.js";
import { summarizePublicCampaign, wilson95 } from "../campaign-primitives.js";
import { PUBLIC_DECISION_RULES } from "../contract.js";

const SafeProtocolIdentifierSchema = z
	.string()
	.max(128)
	.regex(/^\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){0,7}$/iu)
	.refine(isSafeProtocolIdentifier, "protocol identifiers cannot contain network locators or peer identities");

export const CampaignObservationSchema = z
	.object({
		addressFamilies: z.array(z.enum(["dns", "ipv4", "ipv6", "unknown"])),
		asnGroupPseudonyms: z.array(z.string().regex(/^asn_[a-f0-9]{12}$/u)),
		browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
		candidateCount: z.number().int().nonnegative(),
		candidatesPerSuccess: z.number().nonnegative().nullable(),
		condition: z.string().min(1),
		decisionId: z.string().min(1),
		dialSucceeded: z.boolean(),
		hopSucceeded: z.boolean().nullable(),
		identityPseudonym: z.string().regex(/^peer_[a-f0-9]{12}$/u),
		ipGroupPseudonyms: z.array(z.string().regex(/^ip_[a-f0-9]{12}$/u)),
		latencyMs: z.number().int().nonnegative(),
		limits: z
			.object({
				dataLimitBytes: z.number().int().nonnegative().nullable(),
				durationLimitSeconds: z.number().int().nonnegative().nullable(),
			})
			.strict(),
		operatorGroupPseudonyms: z.array(z.string().regex(/^operator_[a-f0-9]{12}$/u)),
		protocols: z.array(SafeProtocolIdentifierSchema),
		refreshOutcome: z.enum(["accepted", "rejected", "not-attempted"]),
		replacementOutcome: z.enum(["accepted", "rejected", "not-attempted"]),
		reservationOutcome: z.enum(["accepted", "rejected", "expired", "connection-lost", "not-attempted"]),
		target: z.enum(["node", "browser", "grid-canary"]),
		transportProfile: z.enum(["wss-only", "wss-wt-webrtc-direct"]).optional(),
		ttlSeconds: z.number().int().nonnegative().nullable(),
	})
	.strict();

export type CampaignObservation = z.infer<typeof CampaignObservationSchema>;

export interface CampaignAggregate {
	addressFamilies: Record<string, number>;
	candidateCount: {
		p50: number | null;
		p95: number | null;
		total: number;
	};
	candidatesPerSuccess: {
		p50: number | null;
		p95: number | null;
	};
	dial: {
		attempts: number;
		rate: number;
		successes: number;
		wilson95: ReturnType<typeof wilson95>;
	};
	diversity: {
		asnGroups: number;
		ipGroups: number;
		operatorGroups: number;
	};
	hop: {
		attempts: number;
		rate: number;
		successes: number;
		wilson95: ReturnType<typeof wilson95>;
	};
	latencyMs: {
		p50: number | null;
		p95: number | null;
	};
	limits: {
		dataLimitBytes: number[];
		durationLimitSeconds: number[];
	};
	protocols: string[];
	refreshOutcomes: Record<string, number>;
	replacementOutcomes: Record<string, number>;
	reservationOutcomes: Record<string, number>;
	sampleCount: number;
	ttlSeconds: {
		p50: number | null;
		p95: number | null;
	};
}

export interface CampaignAggregateCell {
	aggregate: CampaignAggregate;
	dimensions: {
		browser?: CampaignObservation["browser"];
		networkCondition?: string;
		transportProfile?: CampaignObservation["transportProfile"];
	};
	decisionId: string;
}

export interface EnvironmentBlockedCampaignReport {
	schemaVersion: "1.0.0";
	runId: "phase-09-environment-blocked";
	status: "environment-blocked";
	criterionSatisfied: false;
	publicRequests: 0;
	requestBudget: {
		consumed: 0;
		hardCap: number;
	};
	plannedMatrix: ReturnType<typeof summarizePublicCampaign>;
	requiredInputs: Array<{
		code: "explicit-consent" | "independent-registries" | "second-real-egress";
		message: string;
		satisfied: false;
	}>;
	observations: [];
	note: string;
}

/**
 * Parses raw observations strictly before aggregation.
 * @param values - Candidate raw observation values.
 * @returns Parsed observations.
 */
export function parseCampaignObservations(values: unknown[]): CampaignObservation[] {
	return values.map((value) => CampaignObservationSchema.parse(value));
}

/**
 * Aggregates only pseudonymized observations and never emits raw identities.
 * @param observations - Strictly parsed campaign observations.
 * @returns Stable descriptive statistics and Wilson intervals.
 */
export function aggregateCampaignObservations(observations: CampaignObservation[]): CampaignAggregate {
	const dialSuccesses = observations.filter((observation) => observation.dialSucceeded).length;
	const hopObservations = observations.filter((observation) => observation.hopSucceeded !== null);
	const hopSuccesses = hopObservations.filter((observation) => observation.hopSucceeded === true).length;

	return {
		addressFamilies: countStrings(observations.flatMap((observation) => observation.addressFamilies)),
		candidateCount: {
			p50: percentile(
				observations.map((observation) => observation.candidateCount),
				0.5
			),
			p95: percentile(
				observations.map((observation) => observation.candidateCount),
				0.95
			),
			total: observations.reduce((total, observation) => total + observation.candidateCount, 0),
		},
		candidatesPerSuccess: {
			p50: percentile(
				observations.flatMap((observation) =>
					observation.candidatesPerSuccess === null ? [] : [observation.candidatesPerSuccess]
				),
				0.5
			),
			p95: percentile(
				observations.flatMap((observation) =>
					observation.candidatesPerSuccess === null ? [] : [observation.candidatesPerSuccess]
				),
				0.95
			),
		},
		dial: rateSummary(dialSuccesses, observations.length),
		diversity: {
			asnGroups: uniqueCount(observations.flatMap((observation) => observation.asnGroupPseudonyms)),
			ipGroups: uniqueCount(observations.flatMap((observation) => observation.ipGroupPseudonyms)),
			operatorGroups: uniqueCount(observations.flatMap((observation) => observation.operatorGroupPseudonyms)),
		},
		hop: rateSummary(hopSuccesses, hopObservations.length),
		latencyMs: {
			p50: percentile(
				observations.map((observation) => observation.latencyMs),
				0.5
			),
			p95: percentile(
				observations.map((observation) => observation.latencyMs),
				0.95
			),
		},
		limits: {
			dataLimitBytes: sortedUnique(
				observations.flatMap((observation) =>
					observation.limits.dataLimitBytes === null ? [] : [observation.limits.dataLimitBytes]
				)
			),
			durationLimitSeconds: sortedUnique(
				observations.flatMap((observation) =>
					observation.limits.durationLimitSeconds === null ? [] : [observation.limits.durationLimitSeconds]
				)
			),
		},
		protocols: [...new Set(observations.flatMap((observation) => observation.protocols))].sort(),
		refreshOutcomes: countStrings(observations.map((observation) => observation.refreshOutcome)),
		replacementOutcomes: countStrings(observations.map((observation) => observation.replacementOutcome)),
		reservationOutcomes: countStrings(observations.map((observation) => observation.reservationOutcome)),
		sampleCount: observations.length,
		ttlSeconds: {
			p50: percentile(
				observations.flatMap((observation) => (observation.ttlSeconds === null ? [] : [observation.ttlSeconds])),
				0.5
			),
			p95: percentile(
				observations.flatMap((observation) => (observation.ttlSeconds === null ? [] : [observation.ttlSeconds])),
				0.95
			),
		},
	};
}

/**
 * Aggregates observations only at the exact pre-registered decision grain.
 * This prevents Node, browser, transport-profile, and canary populations from
 * being pooled into statistically meaningless rates.
 * @param observations - Strictly parsed campaign observations.
 * @returns Stable decision cells in deterministic key order.
 */
export function aggregatePublicCampaignCells(observations: CampaignObservation[]): CampaignAggregateCell[] {
	const rules = new Map(
		PUBLIC_DECISION_RULES.filter(({ evidencePhase }) => evidencePhase === "phase-09").map((rule) => [rule.id, rule])
	);
	const groups = new Map<string, { cell: Omit<CampaignAggregateCell, "aggregate">; rows: CampaignObservation[] }>();
	for (const observation of observations) {
		const rule = rules.get(observation.decisionId);
		if (rule === undefined) throw new Error(`unknown Phase 09 decision ${observation.decisionId}`);
		const dimensions: CampaignAggregateCell["dimensions"] = {};
		for (const dimension of rule.cellDimensions) {
			if (dimension === "browser") {
				if (observation.browser === undefined) throw new Error(`${rule.id} observation omitted browser`);
				dimensions.browser = observation.browser;
			} else if (dimension === "networkCondition") {
				dimensions.networkCondition = observation.condition;
			} else if (dimension === "transportProfile") {
				if (observation.transportProfile === undefined) {
					throw new Error(`${rule.id} observation omitted transport profile`);
				}
				dimensions.transportProfile = observation.transportProfile;
			} else {
				throw new Error(`unsupported Phase 09 aggregate dimension ${dimension}`);
			}
		}
		const key = JSON.stringify([observation.decisionId, dimensions]);
		const group = groups.get(key) ?? {
			cell: { decisionId: observation.decisionId, dimensions },
			rows: [],
		};
		group.rows.push(observation);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, { cell, rows }]) => ({ ...cell, aggregate: aggregateCampaignObservations(rows) }));
}

/**
 * Produces the only valid committed Phase 09 result without authorized inputs.
 * @returns An honest zero-request environment-blocked artifact.
 */
export function createEnvironmentBlockedCampaignReport(): EnvironmentBlockedCampaignReport {
	const plannedMatrix = summarizePublicCampaign(frozenPublicCampaign);
	return {
		criterionSatisfied: false,
		note: "No trial rows were synthesized. Public execution requires operator authorization and distinct real egress.",
		observations: [],
		plannedMatrix,
		publicRequests: 0,
		requestBudget: {
			consumed: 0,
			hardCap: plannedMatrix.hardRequestCap,
		},
		requiredInputs: [
			{
				code: "explicit-consent",
				message: "Exact public-network consent and terms review were not supplied.",
				satisfied: false,
			},
			{
				code: "independent-registries",
				message: "Two independently operated signed-registry endpoints were not supplied.",
				satisfied: false,
			},
			{
				code: "second-real-egress",
				message: "A second materially distinct authorized real egress/NAT was not supplied.",
				satisfied: false,
			},
		],
		runId: "phase-09-environment-blocked",
		schemaVersion: "1.0.0",
		status: "environment-blocked",
	};
}

function countStrings(values: string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function percentile(values: number[], quantile: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.ceil(quantile * sorted.length) - 1;
	return sorted[Math.max(0, index)] ?? null;
}

function rateSummary(
	successes: number,
	attempts: number
): {
	attempts: number;
	rate: number;
	successes: number;
	wilson95: ReturnType<typeof wilson95>;
} {
	return {
		attempts,
		rate: attempts === 0 ? 0 : successes / attempts,
		successes,
		wilson95: wilson95(successes, attempts),
	};
}

function sortedUnique(values: number[]): number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}

function uniqueCount(values: string[]): number {
	return new Set(values).size;
}

function isSafeProtocolIdentifier(value: string): boolean {
	const segments = value.slice(1).split("/");
	const locatorSegments = new Set(["dns", "dns4", "dns6", "dnsaddr", "ip4", "ip6", "p2p", "unix"]);
	if (segments.some((segment) => locatorSegments.has(segment.toLowerCase()))) return false;
	if (segments.some((segment) => /^(?:12D3Koo|Qm)[1-9A-HJ-NP-Za-km-z]{20,}$/u.test(segment))) return false;
	if (segments.some((segment) => /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(segment))) return false;
	return !segments.some((segment) => {
		const normalized = segment.toLowerCase();
		if (normalized === "localhost") return true;
		if (!normalized.includes(".")) return false;
		return !/^\d+(?:\.\d+){1,3}$/u.test(normalized);
	});
}
