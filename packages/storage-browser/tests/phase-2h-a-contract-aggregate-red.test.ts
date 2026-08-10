import { describe, expect, it } from "vitest";

import {
	aggregatePhase2h,
	type Phase2hAggregate,
	phase2hOverflowIdentity,
	type Phase2hRawEntry,
	phase2hStructuralEntries,
} from "./fixtures/phase-2h-a-aggregate.js";
import {
	phase2hControlEntries,
	phase2hControlRecords,
	phase2hRecordEntry,
	PHASE_2H_CONTROL_GIT_SHA,
	PHASE_2H_CONTROL_RUN_ID,
} from "./fixtures/phase-2h-a-controls.js";
import { type Phase2hValidationRecord, validatePhase2hRecord } from "./fixtures/phase-2h-a-record.js";
import { phase2hTuple, PHASE_2H_KILL_TUPLE_IDS, PHASE_2H_REQUIRED_TUPLE_IDS } from "./fixtures/phase-2h-a-registry.js";

const CANDIDATE_RED_LEDGER = Object.freeze([
	"complete record validation",
	"complete aggregate acceptance",
	"filename-owned body attribution",
	"duplicate alias invalidation",
	"publisher census propagation",
	"global entry-bound diagnostic",
	"fatal missing structural topology",
] as const);

function compareUtf8(left: string, right: string): number {
	const leftBytes = new TextEncoder().encode(left);
	const rightBytes = new TextEncoder().encode(right);
	const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
	for (let index = 0; index < length; index++) {
		const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return leftBytes.byteLength - rightBytes.byteLength;
}

function ascendingUtf8(values: readonly string[]): readonly string[] {
	return Object.freeze([...values].sort(compareUtf8));
}

function candidate(
	entries: readonly Phase2hRawEntry[],
	census?: Readonly<{ duplicateIdentities: readonly string[]; invalidIdentities: readonly string[] }>
): Phase2hAggregate {
	return aggregatePhase2h({
		census,
		entries,
		gitSha: PHASE_2H_CONTROL_GIT_SHA,
		runId: PHASE_2H_CONTROL_RUN_ID,
	});
}

function record(tupleId: string): Phase2hValidationRecord {
	const value = phase2hControlRecords().find((candidateRecord) => candidateRecord.tupleId === tupleId);
	if (value === undefined) throw new TypeError(`missing RED control record: ${tupleId}`);
	return value;
}

describe("Phase 2h-a typed candidate RED", () => {
	it("freezes seven causal GREEN obligations", () => {
		expect(CANDIDATE_RED_LEDGER).toHaveLength(7);
		expect(new Set(CANDIDATE_RED_LEDGER).size).toBe(CANDIDATE_RED_LEDGER.length);
	});

	it("truthfully emits zero records and the exact authorized 69/54 inert census", () => {
		const observed = candidate(phase2hStructuralEntries());
		expect(observed.records).toEqual([]);
		expect(observed.requiredTupleIds).toEqual(PHASE_2H_REQUIRED_TUPLE_IDS);
		expect(observed.missingTupleIds).toEqual(ascendingUtf8(PHASE_2H_REQUIRED_TUPLE_IDS));
		expect(observed.missingKillPoints).toEqual(ascendingUtf8(PHASE_2H_KILL_TUPLE_IDS));
		expect(observed).toMatchObject({
			duplicateTupleIds: [],
			extraTupleIds: [],
			invalidRecordIds: [],
			verdict: "fail",
		});
	});

	it("RED: accepts one complete closed record", () => {
		const value = record("capacity/webkit");
		const tuple = phase2hTuple(value.tupleId);
		if (tuple === undefined) throw new TypeError("derived RED tuple is absent");
		expect(
			validatePhase2hRecord(value, {
				gitSha: PHASE_2H_CONTROL_GIT_SHA,
				project: tuple.engine,
				runId: PHASE_2H_CONTROL_RUN_ID,
			}).errors
		).toEqual([]);
	});

	it("RED: accepts the complete controlled 69-record aggregate", () => {
		expect(candidate(phase2hControlEntries()).verdict).toBe("pass");
	});

	it("RED: attributes a body mismatch only to its canonical filename identity", () => {
		const mismatched = { ...record("capacity/webkit"), tupleId: "capacity/chromium" };
		const observed = candidate([
			...phase2hStructuralEntries(),
			phase2hRecordEntry(mismatched, { filenameIdentity: "capacity/webkit", project: "webkit" }),
		]);
		expect(observed.invalidRecordIds).toEqual(["capacity/webkit"]);
	});

	it("RED: invalidates both canonical and aliased bodies as one duplicate identity", () => {
		const canonical = phase2hRecordEntry(record("capacity/webkit"));
		const alias = { ...canonical, basename: new TextEncoder().encode("capacity%2fwebkit.json") };
		const observed = candidate([...phase2hStructuralEntries(), canonical, alias]);
		expect(observed.duplicateTupleIds).toEqual(["capacity/webkit"]);
	});

	it("RED: propagates create-only/EEXIST publisher census into duplicate and invalid arrays", () => {
		const observed = candidate(phase2hStructuralEntries(), {
			duplicateIdentities: ["capacity/webkit"],
			invalidIdentities: ["capacity/webkit"],
		});
		expect({ duplicateTupleIds: observed.duplicateTupleIds, invalidRecordIds: observed.invalidRecordIds }).toEqual({
			duplicateTupleIds: ["capacity/webkit"],
			invalidRecordIds: ["capacity/webkit"],
		});
	});

	it("RED: emits one global directory-bound identity on the 1,025th non-structural entry", () => {
		const entries = [...phase2hStructuralEntries()];
		for (let index = 0; index < 1_025; index++) {
			entries.push({
				basename: new TextEncoder().encode(`unexpected-${String(index).padStart(4, "0")}`),
				kind: "file",
				scope: "run-root",
			});
		}
		expect(candidate(entries).invalidRecordIds).toContain(
			phase2hOverflowIdentity("directory-entry-bound", PHASE_2H_CONTROL_RUN_ID)
		);
	});

	it("RED: treats an absent expected structural directory as a fatal finalization error", () => {
		expect(() => candidate([])).toThrow(/structural directory/u);
	});
});
