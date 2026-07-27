import { SetDRP } from "@ts-drp/blueprints";
import { DrpType, Operation, type Vertex } from "@ts-drp/types";
import { DRP_VERTEX_FUTURE_TOLERANCE_MS } from "@ts-drp/validation";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

const BASE_TIME = 1_000_000;

function acceptedOperationHashes(object: DRPObject<SetDRP<string>>): string[] {
	return object.vertices
		.filter(({ operation }) => operation?.opType === "add")
		.map(({ hash }) => hash)
		.sort();
}

function operationVertex(value: string, dependencies: string[], timestamp: number): Vertex {
	return createVertex(
		"sender",
		Operation.create({ drpType: DrpType.DRP, opType: "add", value: [value] }),
		dependencies,
		timestamp
	);
}

function replica(peerId: string): DRPObject<SetDRP<string>> {
	return new DRPObject({
		peerId,
		acl: createACL({ admins: [peerId, "sender"] }),
		drp: new SetDRP<string>(),
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Phase 0f legacy clock-skew convergence", () => {
	it("re-requests a future-dated parent and child as pending so replicas converge once they are eligible", async () => {
		vi.useFakeTimers();
		const replicaA = replica("replica-a");
		const replicaB = replica("replica-b");
		const parent = operationVertex("parent", [HashGraph.rootHash], BASE_TIME + DRP_VERTEX_FUTURE_TOLERANCE_MS + 1);
		const child = operationVertex("child", [parent.hash], parent.timestamp + 1);
		const offered = [parent, child];
		const byHash = new Map(offered.map((vertex) => [vertex.hash, vertex]));

		vi.setSystemTime(BASE_TIME);
		const early = await replicaA.applyVertices(offered);

		vi.setSystemTime(child.timestamp);
		const eligible = await replicaB.applyVertices(offered);
		const pendingReoffer = early.missing.map((hash) => byHash.get(hash)).filter((vertex) => vertex !== undefined);
		const reoffer = await replicaA.applyVertices(pendingReoffer);

		expect({
			early,
			eligible,
			finalAcceptedA: acceptedOperationHashes(replicaA),
			finalAcceptedB: acceptedOperationHashes(replicaB),
			reoffer,
		}).toEqual({
			early: {
				applied: false,
				invalid: [],
				missing: [parent.hash, child.hash],
			},
			eligible: {
				applied: true,
				invalid: [],
				missing: [],
			},
			finalAcceptedA: [parent.hash, child.hash].sort(),
			finalAcceptedB: [parent.hash, child.hash].sort(),
			reoffer: {
				applied: true,
				invalid: [],
				missing: [],
			},
		});
	});
});
