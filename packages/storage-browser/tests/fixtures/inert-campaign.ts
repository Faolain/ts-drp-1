import { FIXTURE_OBJECT_ID } from "./fixture-records.js";
import { type InstrumentedTransitionResult, runInstrumentedTransition } from "../../src/internal/instrumented-idb.js";
import { type KillHit, type KillPoint, orderedKillPoints } from "../../src/killpoints.js";

export interface RedCampaignObservation {
	readonly actualCampaign: {
		readonly armingRecoveredState: "new" | null;
		readonly artifactCount: number;
		readonly discoveryRecoveredState: "new" | null;
		readonly mixed: number;
		readonly new: number;
		readonly old: number;
	};
	readonly armedCellValue: number;
	readonly forestGroups: readonly number[];
	readonly manifestPoints: readonly KillPoint[];
	readonly result: InstrumentedTransitionResult;
	readonly hits: readonly KillHit[];
}

/**
 * Returns the deliberately non-vacuous expected recovery for one tuple.
 * @param point - Manifest-derived tuple.
 * @returns New only after transaction completion; old otherwise.
 */
export function expectedFixtureState(point: KillPoint): "old" | "new" {
	return point.id === "transaction-complete" && point.edge === "after" ? "new" : "old";
}

/**
 * Returns the expected Worker-owned durability at a hit.
 * @param point - Manifest-derived tuple.
 * @returns The exact three-not-reached/eleven-strict provenance.
 */
export function expectedHitDurability(point: KillPoint): "not-reached" | "strict" {
	return point.id === "database-open" || (point.id === "transition-begin" && point.edge === "before")
		? "not-reached"
		: "strict";
}

/**
 * Runs the inert boundary and preserves only evidence it actually emitted.
 * @param armed - Requested manifest tuple, or null for discovery.
 * @returns The causal RED observation.
 */
export function runInertCampaign(armed: KillPoint | null): Promise<RedCampaignObservation> {
	const hits: KillHit[] = [];
	const signal = new SharedArrayBuffer(4);
	const manifestPoints = orderedKillPoints();
	return runInstrumentedTransition({
		armed,
		databaseName: "phase-2b-red-contract",
		objectId: FIXTURE_OBJECT_ID,
		signal,
		onHit: (hit): void => {
			hits.push(hit);
		},
	}).then((result) => ({
		result,
		hits: Object.freeze(hits),
		armedCellValue: Atomics.load(new Int32Array(signal), 0),
		actualCampaign: Object.freeze({
			artifactCount: 0,
			old: 0,
			new: 0,
			mixed: 0,
			discoveryRecoveredState: null,
			armingRecoveredState: null,
		}),
		forestGroups: Object.freeze([]),
		manifestPoints,
	}));
}

/**
 * Requires complete reached recovery evidence, never manifest-derived expectations.
 * @param observation - Actual campaign evidence accumulated from completed artifacts.
 */
export function requireActualCampaignOutcomes(observation: RedCampaignObservation): void {
	const actual = observation.actualCampaign;
	if (
		actual.old !== 13 ||
		actual.new !== 1 ||
		actual.mixed !== 0 ||
		actual.artifactCount !== 16 ||
		actual.discoveryRecoveredState !== "new" ||
		actual.armingRecoveredState !== "new"
	) {
		throw new Error(
			`ACTUAL_CAMPAIGN_EVIDENCE expected old=13 new=1 mixed=0 artifacts=16 discovery=new arming=new; ` +
				`observed old=${actual.old} new=${actual.new} mixed=${actual.mixed} artifacts=${actual.artifactCount} ` +
				`discovery=${String(actual.discoveryRecoveredState)} arming=${String(actual.armingRecoveredState)}`
		);
	}
}

/**
 * Stops a behavioral assertion at the closed inert-driver failure.
 * @param observation - Actual RED observation.
 * @param assertion - Required evidence label.
 */
export function requireImplementedDriver(observation: RedCampaignObservation, assertion: string): void {
	if (observation.result.kind === "failure") {
		throw new Error(`${observation.result.code} [${assertion}]: ${observation.result.detail}`);
	}
}
