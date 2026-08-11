import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { selectInspectionApi } from "./fixtures/phase-2g-a-inspection-scaffold.js";
import { aggregatePhase2h, type Phase2hRawEntry, phase2hStructuralEntries } from "./fixtures/phase-2h-a-aggregate.js";
import {
	phase2hControlRecords,
	PHASE_2H_CONTROL_GIT_SHA,
	PHASE_2H_CONTROL_RUN_ID,
} from "./fixtures/phase-2h-a-controls.js";
import { validatePhase2hRecord } from "./fixtures/phase-2h-a-record.js";

function fallbackIdentity(reason: string, scope: string, basename: Uint8Array): string {
	const hash = createHash("sha256")
		.update("ts-drp/phase-2h-diagnostic-entry/v1\0", "utf8")
		.update(reason, "utf8")
		.update(Uint8Array.of(0))
		.update(scope, "utf8")
		.update(Uint8Array.of(0))
		.update(basename)
		.digest("hex");
	return `entry-${reason}-sha256:${hash}`;
}

function collisionMarker(identity: string): Phase2hRawEntry {
	const markerDigest = createHash("sha256").update(identity, "utf8").digest("hex");
	return Object.freeze({
		basename: new TextEncoder().encode(`${markerDigest}.collision.json`),
		body: new TextEncoder().encode(
			JSON.stringify({
				artifactKind: "ts-drp/ahe-storage-validation-collision/v1",
				diagnosticIdentity: identity,
				gitSha: PHASE_2H_CONTROL_GIT_SHA,
				project: "webkit",
				runId: PHASE_2H_CONTROL_RUN_ID,
				schemaVersion: 1,
			})
		),
		kind: "file",
		scope: "collisions/webkit",
	});
}

function aggregate(entries: readonly Phase2hRawEntry[]): ReturnType<typeof aggregatePhase2h> {
	return aggregatePhase2h({
		entries,
		gitSha: PHASE_2H_CONTROL_GIT_SHA,
		runId: PHASE_2H_CONTROL_RUN_ID,
	});
}

describe("Phase 2h-e activation RED", () => {
	it("RED: closes collision-marker identities to the exact union and 160-byte ceiling", () => {
		for (const valid of [`extra-sha256:${"c".repeat(64)}`, `entry-wrong-layout-sha256:${"d".repeat(64)}`]) {
			const observed = aggregate([...phase2hStructuralEntries(), collisionMarker(valid)]);
			expect(observed.duplicateTupleIds).toEqual([valid]);
			expect(observed.invalidRecordIds).toEqual([valid]);
		}
		const mutants = [
			{ identity: `entry-not-a-closed-reason-sha256:${"a".repeat(64)}`, overlong: false },
			{ identity: `entry-${"a".repeat(100)}-sha256:${"b".repeat(64)}`, overlong: true },
		];
		for (const { identity, overlong } of mutants) {
			const marker = collisionMarker(identity);
			const observed = aggregate([...phase2hStructuralEntries(), marker]);
			const expected = fallbackIdentity("invalid-collision-marker", marker.scope, marker.basename);
			if (overlong) expect.soft(Buffer.byteLength(identity, "utf8")).toBeGreaterThan(160);
			else expect.soft(Buffer.byteLength(identity, "utf8")).toBeLessThanOrEqual(160);
			expect.soft(observed.duplicateTupleIds).toEqual([]);
			expect.soft(observed.invalidRecordIds).toContain(expected);
			expect.soft(observed.invalidRecordIds).not.toContain(identity);
		}
	});

	it("preserves structural, project-entry and collision-marker diagnostic precedence", () => {
		const unexpectedRoot: Phase2hRawEntry = {
			basename: new TextEncoder().encode("unexpected"),
			kind: "directory",
			scope: "run-root",
		};
		const nestedRecord: Phase2hRawEntry = {
			basename: new TextEncoder().encode("capacity%2Fchromium.json"),
			kind: "directory",
			scope: "records/chromium",
		};
		const malformedMarker: Phase2hRawEntry = {
			basename: new TextEncoder().encode("capacity%2Fwebkit.json"),
			body: new TextEncoder().encode("{}"),
			kind: "file",
			scope: "collisions/webkit",
		};
		const observed = aggregate([...phase2hStructuralEntries(), unexpectedRoot, nestedRecord, malformedMarker]);
		expect(observed.invalidRecordIds).toEqual(
			expect.arrayContaining([
				fallbackIdentity("wrong-layout", unexpectedRoot.scope, unexpectedRoot.basename),
				fallbackIdentity("subdirectory", nestedRecord.scope, nestedRecord.basename),
				fallbackIdentity("invalid-collision-marker", malformedMarker.scope, malformedMarker.basename),
			])
		);
		expect(observed.extraTupleIds).toEqual([]);
	});

	it("RED: rejects the shape-compatible inspection fallback when real provenance is absent", () => {
		expect(() => selectInspectionApi({})).toThrow(/real|inspectStorageCapability|provenance/u);
	});

	it("RED: recomputes every quota image digest from carried source-owned case evidence", () => {
		const record = phase2hControlRecords().find(({ tupleId }) => tupleId === "quota-fault/webkit");
		if (record === undefined || record.scenarioEvidence.tag !== "quota-fault")
			throw new TypeError("quota-fault/webkit control is absent");
		const mutant = {
			...record,
			scenarioEvidence: {
				...record.scenarioEvidence,
				afterReopenImageDigest: "d".repeat(64),
				newImageDigest: "e".repeat(64),
				oldImageDigest: "d".repeat(64),
				retryImageDigest: "e".repeat(64),
			},
		};
		const observed = validatePhase2hRecord(mutant, {
			gitSha: PHASE_2H_CONTROL_GIT_SHA,
			project: "webkit",
			runId: PHASE_2H_CONTROL_RUN_ID,
		});
		expect(observed.record === null).toBe(true);
		expect(observed.errors).not.toEqual([]);
	});
});
