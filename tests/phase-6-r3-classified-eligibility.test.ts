import { digestClosure, type GenerationRecord, type PresentHead, type StorageObjectId } from "@ts-drp/storage";
import { describe, expect, it } from "vitest";

import { planClosedEpochRoleCleanup } from "../packages/node/src/internal/closed-epoch-cleanup.js";

// Native-format facts, not signature proofs. The shipping caller authenticates
// classified/held rows; this pure owner must refuse an incomplete native census.
const objectId = `creator:${"a".repeat(32)}` as StorageObjectId;
const id = (n: number): GenerationRecord["generationId"] =>
	n.toString(16).padStart(64, "0") as GenerationRecord["generationId"];
const ref = (n: number, byteLength = 10): GenerationRecord["closure"][number] => ({
	digest: (100 + n).toString(16).padStart(64, "0") as GenerationRecord["closure"][number]["digest"],
	byteLength,
});
const generation = (n: number, parent: PresentHead | null, refs = [ref(n)]): GenerationRecord => {
	const closure = [...refs].sort((a, b) => a.digest.localeCompare(b.digest));
	const digest = digestClosure(closure);
	if (!digest.ok) throw new Error("fixture closure invalid");
	return {
		objectId,
		generationId: id(n),
		state: n === 5 ? "Adopted" : "Superseded",
		baseExpectedHead: parent ?? { kind: "none", objectId },
		closure,
		closureDigest: digest.value,
	};
};
const head = (row: GenerationRecord, revision: number): PresentHead => ({
	kind: "present",
	objectId,
	generationId: row.generationId,
	revision: revision as PresentHead["revision"],
	closureDigest: row.closureDigest,
});
type Input = {
	close: {
		objectId: StorageObjectId;
		closedEpoch: number;
		commitQcRef: GenerationRecord["closure"][number];
		verified: boolean;
	};
	adoption: { adopted: boolean; activeHead: PresentHead };
	expectedHead: PresentHead;
	availabilityPolicyDigest: string;
	snapshot: { adopted: boolean; manifestDigest: string };
	issuance: Record<string, never>;
	generations: GenerationRecord[];
	retainedIndependentSourceGenerations: GenerationRecord[];
	classifiedSourceGenerations: GenerationRecord[];
};
function input(): Input {
	const old = generation(1, null);
	const older = generation(2, head(old, 1));
	const second = generation(3, head(older, 2));
	const first = generation(4, head(second, 3));
	const active = generation(5, head(first, 4));
	const activeHead = head(active, 5);
	return {
		close: { objectId, closedEpoch: 4, commitQcRef: ref(90), verified: true },
		adoption: { adopted: true, activeHead },
		expectedHead: activeHead,
		availabilityPolicyDigest: "53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b",
		snapshot: { adopted: true, manifestDigest: id(200) },
		issuance: {},
		generations: [old, older, second, first, active],
		retainedIndependentSourceGenerations: [] as GenerationRecord[],
		classifiedSourceGenerations: [] as GenerationRecord[],
	};
}
function row(value: Input, index: number): GenerationRecord {
	const found = value.generations[index];
	if (found === undefined) throw new Error("fixture native row missing");
	return found;
}
function refused(value: Input): void {
	expect(planClosedEpochRoleCleanup(value)).toEqual({ ok: false, reason: "D109A_LINEAGE_INVALID" });
}
describe("R3 classified native eligibility", () => {
	it("retains connected held source and permits only connected obsolete ancestry", () => {
		const value = input();
		value.retainedIndependentSourceGenerations = [row(value, 1)];
		const result = planClosedEpochRoleCleanup(value);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.sourceGenerationIds).toEqual([id(2)]);
		expect(result.plan.lineageFloor.deleteGenerationIds).toEqual([id(1)]);
	});
	it("permits exact independently classified detached native dependency", () => {
		const value = input(),
			detached = generation(6, null);
		value.generations.push(detached);
		value.classifiedSourceGenerations = [detached];
		const result = planClosedEpochRoleCleanup(value);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.lineageFloor.deleteGenerationIds).toEqual([id(1), id(2), id(6)]);
	});
	it("refuses unclassified detached native dependency", () => {
		const value = input();
		value.generations.push(generation(6, null));
		refused(value);
	});
	it("refuses changed classified row despite matching native generation address", () => {
		const value = input(),
			detached = generation(6, null);
		value.generations.push(detached);
		value.classifiedSourceGenerations = [generation(6, null, [ref(60)])];
		refused(value);
	});
	it("refuses classified row missing from actual native census", () => {
		const value = input();
		value.classifiedSourceGenerations = [generation(6, null)];
		refused(value);
	});
	it("refuses classification overlapping actually retained source custody", () => {
		const value = input(),
			source = generation(6, null);
		value.generations.push(source);
		value.retainedIndependentSourceGenerations = [source];
		value.classifiedSourceGenerations = [source];
		refused(value);
	});
	it("refuses broken connected obsolete ancestry even when every row is Superseded", () => {
		const value = input();
		value.generations[1] = generation(2, head(row(value, 0), 7));
		value.generations[2] = generation(3, head(row(value, 1), 2));
		value.generations[3] = generation(4, head(row(value, 2), 3));
		value.generations[4] = generation(5, head(row(value, 3), 4));
		value.adoption.activeHead = value.expectedHead = head(row(value, 4), 5);
		refused(value);
	});
	it("retains a consistent shared blob reference across classified and held rows", () => {
		const value = input(),
			source = generation(6, null, [ref(60)]),
			detached = generation(7, null, [ref(60)]);
		value.generations.push(source, detached);
		value.retainedIndependentSourceGenerations = [source];
		value.classifiedSourceGenerations = [detached];
		const result = planClosedEpochRoleCleanup(value);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.independentSourceGenerations).toEqual([source]);
		expect(result.plan.lineageFloor.deleteGenerationIds).toEqual([id(1), id(2), id(7)]);
	});
	it("refuses contradictory byte length for one shared digest before eligibility", () => {
		const value = input(),
			source = generation(6, null, [ref(60)]),
			detached = generation(7, null, [ref(60, 11)]);
		value.generations.push(source, detached);
		value.retainedIndependentSourceGenerations = [source];
		value.classifiedSourceGenerations = [detached];
		refused(value);
	});
});

// The new native public schedule exposed a retained source behind one obsolete
// bridge. An ancestry visit proves an edge; it does not classify that held row
// as a deletion target. Original source authentication remains a caller premise.
function bridgedHeldInput(): Input {
	const value = input();
	value.generations[4] = { ...row(value, 4), state: "Superseded" };
	const active = { ...generation(6, head(row(value, 4), 5)), state: "Adopted" as const };
	value.generations.push(active);
	value.adoption.activeHead = value.expectedHead = head(active, 6);
	value.retainedIndependentSourceGenerations = [row(value, 2), row(value, 0)];
	return value;
}
describe("R3 bridged held native eligibility", () => {
	it("preserves both exact held sources while deleting only the obsolete bridge", () => {
		const value = bridgedHeldInput();
		const result = planClosedEpochRoleCleanup(value);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.sourceGenerationIds).toEqual([id(3)]);
		expect(result.plan.independentSourceGenerations).toEqual([row(value, 0)]);
		expect(result.plan.lineageFloor.generationId).toBe(id(3));
		expect(result.plan.lineageFloor.deleteGenerationIds).toEqual([id(2)]);
		for (const source of value.retainedIndependentSourceGenerations)
			expect(result.plan.lineageFloor.deleteGenerationIds).not.toContain(source.generationId);
	});
	it("refuses a wrong revision on the obsolete bridge to the held source", () => {
		const value = bridgedHeldInput();
		value.generations[1] = generation(2, head(row(value, 0), 7));
		refused(value);
	});
	it("refuses a wrong closure edge on the obsolete bridge to the held source", () => {
		const value = bridgedHeldInput();
		value.generations[1] = generation(2, { ...head(row(value, 0), 1), closureDigest: row(value, 2).closureDigest });
		refused(value);
	});
});
