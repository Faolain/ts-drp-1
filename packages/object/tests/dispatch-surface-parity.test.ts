import { type ApplyResult, DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

class NumberLogDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}
}

function makeVertex(opType: string, value: unknown[], timestamp: number): Vertex {
	return createVertex(
		"writer",
		Operation.create({ drpType: DrpType.DRP, opType, value }),
		[HashGraph.rootHash],
		timestamp
	);
}

async function observeApply(
	receiver: DRPObject<NumberLogDRP>,
	vertices: Vertex[]
): Promise<{ status: "resolved"; result: ApplyResult } | { status: "rejected"; error: string }> {
	try {
		return { status: "resolved" as const, result: await receiver.applyVertices(vertices) };
	} catch (error) {
		return {
			status: "rejected" as const,
			error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
		};
	}
}

describe("legacy dispatch surface", () => {
	it("classifies constructor as terminal without aborting its valid batch peer or redelivery", async () => {
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver", "writer"] }),
			drp: new NumberLogDRP(),
		});
		const healthy = makeVertex("append", [1], 1);
		await expect(
			receiver.applyVertices([healthy]),
			"positive control: an authorized ordinary blueprint operation applies"
		).resolves.toEqual({ applied: true, missing: [], invalid: [] });
		expect(receiver.vertices.some(({ hash }) => hash === healthy.hash)).toBe(true);

		const hostile = makeVertex("constructor", [], 2);
		const valid = makeVertex("append", [7], 3);
		const firstDelivery = await observeApply(receiver, [hostile, valid]);
		const redelivery = await observeApply(receiver, [hostile, valid]);

		expect(
			{
				firstDelivery,
				redelivery,
				hostileInGraph: receiver.vertices.some(({ hash }) => hash === hostile.hash),
				validInGraph: receiver.vertices.some(({ hash }) => hash === valid.hash),
				values: receiver.drp?.values,
			},
			"an inherited throwing operation must be a repeatable per-vertex rejection, not a batch-wide exception"
		).toEqual({
			firstDelivery: {
				status: "resolved",
				result: { applied: false, missing: [], invalid: [hostile.hash] },
			},
			redelivery: {
				status: "resolved",
				result: { applied: false, missing: [], invalid: [hostile.hash] },
			},
			hostileInGraph: false,
			validInGraph: true,
			values: [1, 7],
		});
	});

	// LEGACY PARITY PIN, not a RED test: these inherited methods already succeed
	// as harmless no-ops and must remain admitted until the coordinated v2 ABI.
	it("keeps currently-succeeding Object.prototype operations admitted as legacy no-ops", async () => {
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver", "writer"] }),
			drp: new NumberLogDRP(),
		});
		const toStringVertex = makeVertex("toString", [], 10);
		const hasOwnPropertyVertex = makeVertex("hasOwnProperty", ["values"], 11);

		await expect(receiver.applyVertices([toStringVertex, hasOwnPropertyVertex])).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});
		expect(receiver.vertices.map(({ hash }) => hash)).toEqual(
			expect.arrayContaining([toStringVertex.hash, hasOwnPropertyVertex.hash])
		);
		expect(receiver.drp?.values).toEqual([]);
	});
});
