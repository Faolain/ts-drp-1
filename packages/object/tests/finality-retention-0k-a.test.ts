import "./helpers/trusted-vertex-ingest.js";

import { DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { FinalityState, FinalityStore } from "../src/finality/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

class RetentionProbeDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: string[] = [];

	append(value: string): void {
		this.values.push(value);
	}

	failAfterAppend(value: string): never {
		this.values.push(value);
		throw new Error("phase-0k-a controlled rollback");
	}
}

function vertex(opType: string, value: string, timestamp: number): Vertex {
	return createVertex(
		"sender",
		Operation.create({ drpType: DrpType.DRP, opType, value: [value] }),
		[HashGraph.rootHash],
		timestamp
	);
}

function receiver(peerId = "receiver"): DRPObject<RetentionProbeDRP> {
	const acl = createACL({ admins: [peerId, "sender"] });
	acl.context = { caller: "sender" };
	acl.setKey("verification-disabled-test-credential");
	return new DRPObject({ peerId, acl, drp: new RetentionProbeDRP() });
}

function concreteStore(object: DRPObject<RetentionProbeDRP>): FinalityStore {
	const store = object["_finalityStore"];
	expect(store).toBeInstanceOf(FinalityStore);
	return store;
}

function expectFullResidentRecord(store: FinalityStore, hash: string): void {
	const record = store.states.get(hash);
	expect(record).toBeInstanceOf(FinalityState);
	expect(record).toMatchObject({
		data: hash,
		numberOfSignatures: 0,
	});
	if (!record) throw new Error("Expected a resident finality record");
	expect(new Set(record.signerIndices.keys())).toEqual(new Set(["receiver", "sender"]));
	expect(record.signerCredentials).toHaveLength(record.signerIndices.size);
	for (const index of record.signerIndices.values()) expect(record.aggregation_bits.get(index)).toBe(false);
	expect(record.signature).toBeUndefined();
}

describe("Phase 0k-a enabled legacy-finality retention", () => {
	it("keeps exactly one concrete full record per accepted distinct vertex and none for rejected or rolled-back vertices", async () => {
		const object = receiver();
		const store = concreteStore(object);
		const acceptedOldest = vertex("append", "oldest", 1);
		const rejected = vertex("operationThatDoesNotExist", "rejected", 2);
		const acceptedNewest = vertex("append", "newest", 3);
		const rolledBack = vertex("failAfterAppend", "rolled-back", 4);

		await expect(object.applyVertices([acceptedOldest, rejected, acceptedNewest, rolledBack])).resolves.toEqual({
			applied: false,
			missing: [],
			invalid: [rejected.hash],
			quarantined: [rolledBack.hash],
		});

		expect([...store.states.keys()].sort()).toEqual([acceptedOldest.hash, acceptedNewest.hash].sort());
		expect(store.states.size).toBe(2);
		expectFullResidentRecord(store, acceptedOldest.hash);
		expectFullResidentRecord(store, acceptedNewest.hash);
		expect(store.states.has(rejected.hash)).toBe(false);
		expect(store.states.has(rolledBack.hash)).toBe(false);

		await expect(object.applyVertices([acceptedOldest, acceptedNewest])).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});
		expect([...store.states.keys()].sort()).toEqual([acceptedOldest.hash, acceptedNewest.hash].sort());
		expect(store.states.size).toBe(2);
	});

	it("restores the exact pre-batch concrete-store census when a vertex rolls back", async () => {
		const object = receiver();
		const store = concreteStore(object);
		const baseline = [vertex("append", "baseline-a", 10), vertex("append", "baseline-b", 11)];
		await object.applyVertices(baseline);
		const before = [...store.states.entries()];
		const rolledBack = vertex("failAfterAppend", "must-not-reside", 12);

		await expect(object.applyVertices([rolledBack])).resolves.toEqual({
			applied: false,
			missing: [],
			invalid: [],
			quarantined: [rolledBack.hash],
		});

		expect([...store.states.entries()]).toEqual(before);
		expect(store.states.size).toBe(before.length);
		expect(store.states.has(rolledBack.hash)).toBe(false);
	});

	it("accepts an ancient late attestation after many newer records without losing any full record", async () => {
		const object = receiver();
		const store = concreteStore(object);
		const vertices = Array.from({ length: 32 }, (_, index) => vertex("append", `value-${index}`, 100 + index));
		await expect(object.applyVertices(vertices)).resolves.toEqual({ applied: true, missing: [], invalid: [] });
		const oldest = vertices[0];
		const late = {
			data: oldest.hash,
			signature: new Uint8Array([9, 8, 7]),
		};

		expect(store.addSignatures("sender", [late], false)).toEqual([late]);
		expect(store.signed("sender", oldest.hash)).toBe(true);
		expect(store.getAttestation(oldest.hash)?.data).toBe(oldest.hash);
		expect(store.states.size).toBe(vertices.length);
		expect([...store.states.keys()]).toEqual(vertices.map(({ hash }) => hash));
		expect(store.states.get(vertices.at(-1)?.hash ?? "")).toBeInstanceOf(FinalityState);
	});

	it("uses one authoritative concrete store per object and keeps separate stores isolated", async () => {
		const left = receiver("left");
		const right = receiver("right");
		const leftStore = concreteStore(left);
		const rightStore = concreteStore(right);

		expect(leftStore).not.toBe(rightStore);
		expect(left["_applier"]["finalityStore"]).toBe(leftStore);
		expect(right["_applier"]["finalityStore"]).toBe(rightStore);

		const acceptedByLeft = vertex("append", "left-only", 200);
		await left.applyVertices([acceptedByLeft]);
		expect([...leftStore.states.keys()]).toEqual([acceptedByLeft.hash]);
		expect(rightStore.states.size).toBe(0);

		const acceptedByRight = vertex("append", "right-only", 201);
		await right.applyVertices([acceptedByRight]);
		expect([...leftStore.states.keys()]).toEqual([acceptedByLeft.hash]);
		expect([...rightStore.states.keys()]).toEqual([acceptedByRight.hash]);
	});
});
