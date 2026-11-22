/* eslint-disable @typescript-eslint/no-non-null-assertion -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
/* eslint-disable jsdoc/require-jsdoc -- Shared outer assertions; expected state never crosses into recovery. */
import assert from "node:assert/strict";

import type { Fault, TargetOracle } from "./types.js";
export interface ObservationReport {
	classification: string;
	precondition: { targets: TargetOracle[]; proofBytes: number; rows: number; transition: unknown };
	result: null | { ok: boolean; kind?: string; cause?: { owner: string; reason: string } };
	summary: null | { cuts: TargetOracle[] };
	events: { name: string; epoch?: number }[];
	native?: { modes: string[]; terminals: unknown[]; writes: number; reads: unknown[] };
	foreign?: unknown[];
	tokenEmpty?: boolean;
	tokenFrozen?: boolean;
	unchangedAhe?: boolean;
	floorReads?: number;
	getterReads?: number;
	mutation?: Record<string, unknown>;
}
export function assertPresentPrecondition(
	precondition: ObservationReport["precondition"],
	epochs: number,
	states: readonly number[],
	legacy: boolean
): void {
	assert.equal(precondition.targets.length, Math.min(2, epochs));
	assert.deepEqual(
		precondition.targets.map((t) => t.epoch),
		epochs === 0 ? [] : epochs === 1 ? [0] : [epochs - 1, epochs - 2]
	);
	assert.deepEqual(
		precondition.targets.map((t) => t.state),
		states.slice(-2).reverse()
	);
	assert.ok(precondition.proofBytes <= 262144);
	assert.equal(precondition.rows, epochs === 0 ? 1 : 3);
	if (epochs >= 2) {
		assert.notEqual(precondition.targets[0]!.stateDigest, precondition.targets[1]!.stateDigest);
		assert.notEqual(precondition.targets[0]!.closedAclDigest, precondition.targets[1]!.closedAclDigest);
		assert.notEqual(precondition.targets[0]!.cutRef.digest, precondition.targets[1]!.cutRef.digest);
		assert.equal(precondition.targets[1]!.successorAclDigest, precondition.targets[0]!.closedAclDigest);
	}
	if (legacy) assert.equal(precondition.targets.at(-1)!.representation, "retirement-only");
}
const kinds: Partial<Record<Fault, string>> = {
	"older-missing-chunk": "snapshot-unavailable",
	"older-corrupt-chunk": "snapshot-invalid",
	"older-replaced": "snapshot-unavailable",
	"older-missing-manifest": "snapshot-unavailable",
	"forged-old-acl": "snapshot-invalid",
	"wrong-retirement-anchor": "chain-invalid",
	"old-qc-length": "chain-invalid",
	"bad-aggregate-link": "chain-invalid",
	"bad-settlement-frontier": "chain-invalid",
	"same-u": "proof-budget-exceeded",
	"unpruned-g8": "proof-budget-exceeded",
	"anchor-cap": "proof-budget-exceeded",
	"capture-accessor": "malformed-input",
	"already-aborted": "aborted",
	"temporary": "snapshot-not-ready",
	"open": "snapshot-not-ready",
	"legacy": "snapshot-not-ready",
	"not-ready": "snapshot-not-ready",
	"abort-first": "aborted",
	"abort-second": "aborted",
	"close-first": "snapshot-unavailable",
	"release-failed": "release-failed",
	"head-stale": "ahe-rejected",
	"floor-stale": "floor-stale",
	"floor-pending": "floor-stale",
	"missing-anchor": "anchor-unavailable",
	"anchor-neighbor": "anchor-unavailable",
};
export function assertObservation(value: ObservationReport, expected: readonly TargetOracle[], fault: Fault): void {
	assert.equal(value.classification, "REACHED", "WIRING_RED only: private observer absent; deeper assertions masked");
	if (fault === "none") {
		assert.equal(value.result?.ok, true);
		assert.ok(value.summary);
		assert.equal(value.summary.cuts.length, expected.length);
		for (let i = 0; i < expected.length; i++)
			for (const key of [
				"epoch",
				"stateDigest",
				"closedAclDigest",
				"successorAclDigest",
				"manifestDigest",
				"payloadDigest",
				"payloadByteLength",
				"closedAnchorDigest",
				"successorAnchorDigest",
				"cutRef",
				"commitQcRef",
			] as const)
				assert.deepEqual(value.summary.cuts[i]![key], expected[i]![key], key);
		assert.equal(value.tokenEmpty, true);
		assert.equal(value.tokenFrozen, true);
		assert.deepEqual(value.foreign, [null, null, null, null, null]);
		assert.equal(value.floorReads, 2);
	} else {
		assert.equal(value.result?.ok, false);
		assert.equal(value.result?.kind, kinds[fault]);
		assert.equal(value.summary, null);
	}
	assert.ok(value.native);
	assert.equal(value.native.writes, 0);
	assert.ok(value.native.modes.every((m) => m === "readonly" || m === "BEGIN"));
	assert.equal(value.native.terminals.length, value.native.modes.length);
	if (fault === "none" && expected.length === 0)
		assert.ok(
			value.native.reads.every((read) => {
				if (typeof read !== "object" || read === null) return true;
				const { sql, table } = read as { sql?: unknown; table?: unknown };
				return (
					!(typeof table === "string" && ["owner", "scopes", "chunks", "acceptedEntries"].includes(table)) &&
					!(
						typeof sql === "string" &&
						/\b(?:snapshot_(?:owner|scopes|chunks)(?:_v[12])?|scopes|accepted_entries)\b/iu.test(sql)
					)
				);
			}),
			"genesis observes no snapshot or journal native reads"
		);
	if (fault === "capture-accessor" || fault === "already-aborted") {
		assert.equal(value.floorReads, 0);
		assert.equal(value.getterReads, 0);
		assert.deepEqual(value.native.modes, []);
		assert.deepEqual(value.events, []);
	}
	const acquisitions = value.events.filter((e) => e.name === "snapshot-acquire"),
		releases = value.events.filter((e) => e.name === "snapshot-release");
	assert.equal(releases.length, acquisitions.length, "every original admitted reader released");
	for (let i = 1; i < acquisitions.length; i++)
		assert.ok(
			value.events.indexOf(releases[i - 1]!) < value.events.indexOf(acquisitions[i]!),
			"serial payload ownership"
		);
	if (fault === "none") {
		assert.deepEqual(
			acquisitions.map((e) => e.epoch),
			expected.map((t) => t.epoch),
			"Q cannot stand in for distinct older target"
		);
		for (const t of expected)
			assert.ok(
				value.events.some((e) => e.name === "snapshot-read" && e.epoch === t.epoch),
				"every actual target descriptor read"
			);
	}
	if (["older-missing-chunk", "older-corrupt-chunk", "older-replaced", "older-missing-manifest"].includes(fault)) {
		assert.ok(
			value.events.some((e) => e.name === "snapshot-read" && e.epoch === expected[0]!.epoch),
			"first target actual full bytes before older refusal"
		);
		assert.ok(
			value.events.some((e) => e.name === "snapshot-release" && e.epoch === expected[0]!.epoch),
			"first target released before older failure"
		);
	}
	if (fault === "abort-first" || fault === "close-first") assert.equal(acquisitions.length, 1);
	if (fault === "abort-second") assert.equal(acquisitions.length, 2);
	if (fault === "older-replaced") assert.deepEqual(value.result?.cause, { owner: "snapshot", reason: "stale-scope" });
	if (fault === "close-first") assert.deepEqual(value.result?.cause, { owner: "snapshot", reason: "closed" });
	if (fault === "head-stale") assert.deepEqual(value.result?.cause, { owner: "ahe", reason: "READ_STALE_HEAD" });
	if (!["head-stale"].includes(fault)) assert.equal(value.unchangedAhe, true);
}
