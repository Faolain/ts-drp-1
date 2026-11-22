import "./helpers/trusted-vertex-ingest.js";

/**
 * Phase 0f truthful batch contract:
 * - The caller's submitted element references are copied into a dense worklist
 *   before any caller-controlled vertex accessor runs.
 * - Repeated references to the same Vertex share one detached preflight record,
 *   so that object identity is observed once and receives one stable verdict.
 * - `missing`, `invalid`, and `quarantined` are unique hash buckets. No rejection
 *   bucket may name a vertex committed to the graph by the same call.
 * - Mutable fields are copied immediately when observed; later accessors cannot
 *   mutate the value that is subsequently hash-validated and applied.
 */
import { SetDRP } from "@ts-drp/blueprints";
import { DrpType, Operation, type Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { createACL, createVertex, DRPObject, HashGraph } from "../src/index.js";

type OperationMessage = ReturnType<typeof Operation.create>;

function createReceiver(): DRPObject<SetDRP<string>> {
	return new DRPObject({
		peerId: "receiver",
		acl: createACL({ admins: ["receiver", "sender"] }),
		drp: new SetDRP<string>(),
	});
}

function makeAddVertex(value: string, dependencies: string[] = [HashGraph.rootHash], timestamp = 1): Vertex {
	return createVertex(
		"sender",
		Operation.create({ drpType: DrpType.DRP, opType: "add", value: [value] }),
		dependencies,
		timestamp
	);
}

function sortedValues(receiver: DRPObject<SetDRP<string>>): string[] {
	return [...(receiver.drp?.query_getValues() ?? [])].sort();
}

describe("Phase 0f dense worklist and repeated-reference isolation", () => {
	it("copies a dense element worklist before an operation getter can sparsify the caller array", async () => {
		const firstOperation = Operation.create({
			drpType: DrpType.DRP,
			opType: "add",
			value: ["first"],
		});
		const first = createVertex("sender", firstOperation, [HashGraph.rootHash], 10);
		const second = makeAddVertex("second", [HashGraph.rootHash], 11);
		const firstHash = first.hash;
		const secondHash = second.hash;
		const operationReads: string[] = [];
		const submitted = [first, second];

		Object.defineProperty(first, "operation", {
			configurable: true,
			enumerable: true,
			get(): OperationMessage {
				operationReads.push("first");
				delete submitted[1];
				return firstOperation;
			},
		});

		const receiver = createReceiver();
		const settled = await receiver.applyVertices(submitted).then(
			(result) => ({ status: "resolved" as const, result }),
			(error: unknown) => ({
				status: "rejected" as const,
				error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			})
		);

		expect({
			accepted: receiver.vertices
				.filter(({ hash }) => hash === firstHash || hash === secondHash)
				.map(({ hash }) => hash)
				.sort(),
			operationReads,
			settled,
			values: sortedValues(receiver),
		}).toEqual({
			accepted: [firstHash, secondHash].sort(),
			operationReads: ["first"],
			settled: {
				status: "resolved",
				result: { applied: true, missing: [], invalid: [] },
			},
			values: ["first", "second"],
		});
	});

	it("shares one invalid operation capture for the same object repeated in a batch", async () => {
		const goodOperation = Operation.create({
			drpType: DrpType.DRP,
			opType: "add",
			value: ["must-not-apply"],
		});
		const badOperation = Operation.create({
			drpType: DrpType.DRP,
			opType: "-1",
			value: [],
		});
		const repeated = createVertex("sender", goodOperation, [HashGraph.rootHash], 20);
		const repeatedHash = repeated.hash;
		const operationReads: ("bad" | "good")[] = [];

		Object.defineProperty(repeated, "operation", {
			configurable: true,
			enumerable: true,
			get(): OperationMessage {
				const observation = operationReads.length === 0 ? "bad" : "good";
				operationReads.push(observation);
				return observation === "bad" ? badOperation : goodOperation;
			},
		});

		const receiver = createReceiver();
		const result = await receiver.applyVertices([repeated, repeated]);

		expect({
			inGraph: receiver.vertices.some(({ hash }) => hash === repeatedHash),
			operationReads,
			result,
			values: sortedValues(receiver),
		}).toEqual({
			inGraph: false,
			operationReads: ["bad"],
			result: { applied: false, missing: [], invalid: [repeatedHash] },
			values: [],
		});
	});

	it("shares one throwing operation capture and reports one quarantined hash without committing it", async () => {
		const goodOperation = Operation.create({
			drpType: DrpType.DRP,
			opType: "add",
			value: ["must-not-apply"],
		});
		const repeated = createVertex("sender", goodOperation, [HashGraph.rootHash], 30);
		const repeatedHash = repeated.hash;
		let operationReads = 0;

		Object.defineProperty(repeated, "operation", {
			configurable: true,
			enumerable: true,
			get(): OperationMessage {
				operationReads++;
				if (operationReads === 1) throw new Error("first capture failed");
				return goodOperation;
			},
		});

		const receiver = createReceiver();
		const result = await receiver.applyVertices([repeated, repeated]);
		const rejectedHashes = [...result.missing, ...result.invalid, ...(result.quarantined ?? [])];

		expect({
			graphContainsRejectedHash: rejectedHashes.some((hash) =>
				receiver.vertices.some((vertex) => vertex.hash === hash)
			),
			inGraph: receiver.vertices.some(({ hash }) => hash === repeatedHash),
			operationReads,
			result,
			values: sortedValues(receiver),
		}).toEqual({
			graphContainsRejectedHash: false,
			inGraph: false,
			operationReads: 1,
			result: {
				applied: false,
				missing: [],
				invalid: [],
				quarantined: [repeatedHash],
			},
			values: [],
		});
	});

	it("deduplicates a missing verdict for the same object repeated in a batch", async () => {
		const operation = Operation.create({
			drpType: DrpType.DRP,
			opType: "add",
			value: ["blocked-on-dependency"],
		});
		const repeated = createVertex("sender", operation, ["not-present"], 40);
		const repeatedHash = repeated.hash;
		let operationReads = 0;

		Object.defineProperty(repeated, "operation", {
			configurable: true,
			enumerable: true,
			get(): OperationMessage {
				operationReads++;
				return operation;
			},
		});

		const receiver = createReceiver();
		const result = await receiver.applyVertices([repeated, repeated]);

		expect({
			inGraph: receiver.vertices.some(({ hash }) => hash === repeatedHash),
			operationReads,
			result,
		}).toEqual({
			inGraph: false,
			operationReads: 1,
			result: { applied: false, missing: [repeatedHash], invalid: [] },
		});
	});

	it("copies dependencies immediately before a later signature getter mutates the caller array", async () => {
		const operation = Operation.create({
			drpType: DrpType.DRP,
			opType: "add",
			value: ["stable-dependency"],
		});
		const repeatedDependencies = [HashGraph.rootHash];
		const vertex = createVertex("sender", operation, repeatedDependencies, 50);
		const vertexHash = vertex.hash;
		const reads: string[] = [];

		Object.defineProperty(vertex, "dependencies", {
			configurable: true,
			enumerable: true,
			get(): string[] {
				reads.push("dependencies");
				return repeatedDependencies;
			},
		});
		Object.defineProperty(vertex, "signature", {
			configurable: true,
			enumerable: true,
			get(): Uint8Array {
				reads.push("signature");
				repeatedDependencies[0] = "mutated-after-dependency-observation";
				return new Uint8Array();
			},
		});

		const receiver = createReceiver();
		const result = await receiver.applyVertices([vertex]);

		expect({
			inGraph: receiver.vertices.some(({ hash }) => hash === vertexHash),
			reads,
			result,
			storedDependencies: receiver.vertices.find(({ hash }) => hash === vertexHash)?.dependencies,
			values: sortedValues(receiver),
		}).toEqual({
			inGraph: true,
			reads: ["dependencies", "signature"],
			result: { applied: true, missing: [], invalid: [] },
			storedDependencies: [HashGraph.rootHash],
			values: ["stable-dependency"],
		});
	});
});
