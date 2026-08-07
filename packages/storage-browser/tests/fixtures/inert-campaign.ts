import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { aggregatePassArtifacts, type PassArtifact } from "./artifacts.js";
import { type InstrumentedTransitionResult } from "../../src/internal/instrumented-idb.js";
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
 * @returns New only at transaction-complete/after; old otherwise.
 */
export function expectedFixtureState(point: KillPoint): "old" | "new" {
	return point.id === "transaction-complete" && point.edge === "after" ? "new" : "old";
}

/**
 * Returns the exact Worker-owned durability expected at one literal hit.
 * @param point - Manifest-derived tuple.
 * @returns The frozen three-not-reached/eleven-strict value.
 */
export function expectedHitDurability(point: KillPoint): "not-reached" | "strict" {
	return point.id === "database-open" || (point.id === "transition-begin" && point.edge === "before")
		? "not-reached"
		: "strict";
}

function artifactDirectory(): string {
	return path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../../..",
		".logs/phase-2b-process-death-green-codex-high/artifacts"
	);
}

function readArtifacts(): readonly PassArtifact[] {
	const directory = artifactDirectory();
	if (!fs.existsSync(directory)) throw new Error("ACTUAL_CAMPAIGN_EVIDENCE artifact directory is absent");
	const files = fs
		.readdirSync(directory)
		.filter((file) => file.endsWith(".json"))
		.sort();
	const untrusted = files.map((file) => {
		const parsed = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) throw new Error("ACTUAL_CAMPAIGN_EVIDENCE malformed artifact");
		return parsed;
	});
	aggregatePassArtifacts(untrusted);
	return Object.freeze(untrusted.map((artifact) => artifact as PassArtifact));
}

function artifactHits(artifact: PassArtifact): readonly KillHit[] {
	if (!Array.isArray(artifact.observedHits)) throw new Error("ACTUAL_CAMPAIGN_EVIDENCE missing observed hits");
	return Object.freeze(
		artifact.observedHits.map((value) => {
			if (typeof value !== "object" || value === null) throw new Error("ACTUAL_CAMPAIGN_EVIDENCE malformed hit");
			const hit = value as Record<string, unknown>;
			if (
				typeof hit.id !== "string" ||
				(hit.edge !== "before" && hit.edge !== "after") ||
				(hit.transactionDurability !== "not-reached" && hit.transactionDurability !== "strict")
			) {
				throw new Error("ACTUAL_CAMPAIGN_EVIDENCE malformed typed hit");
			}
			return Object.freeze({
				id: hit.id as KillHit["id"],
				edge: hit.edge,
				transactionDurability: hit.transactionDurability,
			});
		})
	);
}

/**
 * Loads the immutable sixteen-run browser campaign evidence emitted by the sole Playwright test.
 * @param armed - Requested tuple, or null for aggregate/discovery evidence.
 * @returns Reached evidence from the parsed immutable campaign artifacts.
 */
export function runInertCampaign(armed: KillPoint | null): Promise<RedCampaignObservation> {
	const artifacts = readArtifacts();
	const aggregate = aggregatePassArtifacts(artifacts);
	const tuples = artifacts.filter((artifact) => artifact.runKind === "tuple");
	const discovery = artifacts.find((artifact) => artifact.runKind === "discovery");
	const arming = artifacts.find((artifact) => artifact.runKind === "arming");
	const selected =
		armed === null
			? discovery
			: tuples.find((artifact) => artifact.armedPoint.id === armed.id && artifact.armedPoint.edge === armed.edge);
	if (selected === undefined || discovery === undefined || arming === undefined) {
		throw new Error("ACTUAL_CAMPAIGN_EVIDENCE required run artifact is missing");
	}
	const hits = artifactHits(selected);
	const killedGroups = selected.runKind === "tuple" ? selected.killedGroups : [];
	const forestGroups = killedGroups.map((group) => group.pgid);
	return Promise.resolve(
		Object.freeze({
			result: Object.freeze({ kind: "complete", observed: hits, transactionDurability: "strict" }),
			hits,
			armedCellValue:
				armed === null ? discovery.finalCellValue : selected.runKind === "tuple" ? selected.armedCellValue : 0,
			actualCampaign: Object.freeze({
				artifactCount: aggregate.artifactCount,
				old: aggregate.old,
				new: aggregate.new,
				mixed: aggregate.mixed,
				discoveryRecoveredState: discovery.recoveredState === "new" ? "new" : null,
				armingRecoveredState: arming.recoveredState === "new" ? "new" : null,
			}),
			forestGroups: Object.freeze(forestGroups),
			manifestPoints: orderedKillPoints(),
		})
	);
}

/**
 * Requires complete reached recovery evidence, never manifest-derived expectations.
 * @param observation - Parsed artifact-backed campaign evidence.
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
 * Stops an assertion only if the reached campaign emitted a closed failure.
 * @param observation - Parsed artifact-backed campaign evidence.
 * @param assertion - Frozen causal assertion label.
 */
export function requireImplementedDriver(observation: RedCampaignObservation, assertion: string): void {
	if (observation.result.kind === "failure") {
		throw new Error(`${observation.result.code} [${assertion}]: ${observation.result.detail}`);
	}
}
