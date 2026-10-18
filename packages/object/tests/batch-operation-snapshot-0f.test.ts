import "./helpers/trusted-vertex-ingest.js";

import { SetDRP } from "@ts-drp/blueprints";
import { ACLGroup, DrpType, Operation, type Vertex } from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
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

function makeVertex(operation: OperationMessage, timestamp: number): Vertex {
	return createVertex("sender", operation, [HashGraph.rootHash], timestamp);
}

function sortedValues(receiver: DRPObject<SetDRP<string>>): string[] {
	return [...(receiver.drp?.query_getValues() ?? [])].sort();
}

describe("Phase 0f batch operation snapshot preflight", () => {
	it("captures each operation once and applies the exact two operations bound into their hashes", async () => {
		const firstOperation = Operation.create({
			drpType: DrpType.DRP,
			opType: "add",
			value: ["first-captured"],
		});
		const secondOperation = Operation.create({
			drpType: DrpType.DRP,
			opType: "add",
			value: ["second-captured"],
		});
		const firstLaterOperation = Operation.create({
			drpType: DrpType.DRP,
			opType: "add",
			value: ["first-later"],
		});
		const secondLaterOperation = Operation.create({
			drpType: DrpType.DRP,
			opType: "add",
			value: ["second-later"],
		});
		const first = makeVertex(firstOperation, 1);
		const second = makeVertex(secondOperation, 2);
		const firstHash = first.hash;
		const secondHash = second.hash;
		const firstReads: ("captured" | "later")[] = [];
		const secondReads: ("captured" | "later")[] = [];

		Object.defineProperty(first, "operation", {
			configurable: true,
			enumerable: true,
			get(): OperationMessage {
				const observation = firstReads.length === 0 ? "captured" : "later";
				firstReads.push(observation);
				return observation === "captured" ? firstOperation : firstLaterOperation;
			},
		});
		Object.defineProperty(second, "operation", {
			configurable: true,
			enumerable: true,
			get(): OperationMessage {
				const observation = secondReads.length === 0 ? "captured" : "later";
				secondReads.push(observation);
				return observation === "captured" ? secondOperation : secondLaterOperation;
			},
		});

		expect(firstHash).toBe(computeHash("sender", firstOperation, [HashGraph.rootHash], 1));
		expect(secondHash).toBe(computeHash("sender", secondOperation, [HashGraph.rootHash], 2));

		const receiver = createReceiver();
		const result = await receiver.applyVertices([first, second]);

		expect({
			accepted: receiver.vertices
				.filter(({ hash }) => hash === firstHash || hash === secondHash)
				.map(({ hash }) => hash)
				.sort(),
			firstReads,
			result,
			secondReads,
			values: sortedValues(receiver),
		}).toEqual({
			accepted: [firstHash, secondHash].sort(),
			firstReads: ["captured"],
			result: { applied: true, invalid: [], missing: [] },
			secondReads: ["captured"],
			values: ["first-captured", "second-captured"],
		});
	});

	it("contains a first-read operation accessor failure and still commits its valid sibling", async () => {
		const inaccessibleOperation = Operation.create({
			drpType: DrpType.DRP,
			opType: "add",
			value: ["must-not-apply"],
		});
		const inaccessible = makeVertex(inaccessibleOperation, 10);
		const inaccessibleHash = inaccessible.hash;
		let inaccessibleReads = 0;
		Object.defineProperty(inaccessible, "operation", {
			configurable: true,
			enumerable: true,
			get(): OperationMessage {
				inaccessibleReads++;
				throw new Error("operation accessor snapshot failure");
			},
		});
		const sibling = makeVertex(Operation.create({ drpType: DrpType.DRP, opType: "add", value: ["valid-sibling"] }), 11);
		const receiver = createReceiver();

		const settled = await receiver.applyVertices([inaccessible, sibling]).then(
			(result) => ({ status: "resolved" as const, result }),
			(error: unknown) => ({
				status: "rejected" as const,
				error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			})
		);

		expect({
			inaccessibleInGraph: receiver.vertices.some(({ hash }) => hash === inaccessibleHash),
			inaccessibleReads,
			settled,
			siblingInGraph: receiver.vertices.some(({ hash }) => hash === sibling.hash),
			values: sortedValues(receiver),
		}).toEqual({
			inaccessibleInGraph: false,
			inaccessibleReads: 1,
			settled: {
				status: "resolved",
				result: {
					applied: false,
					invalid: [],
					missing: [],
					quarantined: [inaccessibleHash],
				},
			},
			siblingInGraph: true,
			values: ["valid-sibling"],
		});
	});

	it("derives reconciliation mode from the same captured DRP operation that is validated and applied", async () => {
		const capturedOperation = Operation.create({
			drpType: DrpType.DRP,
			opType: "add",
			value: ["captured-drp"],
		});
		const laterACLOperation = Operation.create({
			drpType: DrpType.ACL,
			opType: "grant",
			value: ["unexpected-writer", ACLGroup.Writer],
		});
		const alternating = makeVertex(capturedOperation, 20);
		const alternatingHash = alternating.hash;
		const operationReads: ("captured-drp" | "later-acl")[] = [];
		Object.defineProperty(alternating, "operation", {
			configurable: true,
			enumerable: true,
			get(): OperationMessage {
				const observation = operationReads.length === 0 ? "captured-drp" : "later-acl";
				operationReads.push(observation);
				return observation === "captured-drp" ? capturedOperation : laterACLOperation;
			},
		});
		const sibling = makeVertex(
			Operation.create({ drpType: DrpType.DRP, opType: "add", value: ["ordinary-sibling"] }),
			21
		);
		const receiver = createReceiver();

		const result = await receiver.applyVertices([alternating, sibling]);

		expect({
			accepted: receiver.vertices.some(({ hash }) => hash === alternatingHash),
			operationReads,
			result,
			unexpectedWriterGranted: receiver.acl.query_isWriter("unexpected-writer"),
			values: sortedValues(receiver),
		}).toEqual({
			accepted: true,
			operationReads: ["captured-drp"],
			result: { applied: true, invalid: [], missing: [] },
			unexpectedWriterGranted: false,
			values: ["captured-drp", "ordinary-sibling"],
		});
	});
});
