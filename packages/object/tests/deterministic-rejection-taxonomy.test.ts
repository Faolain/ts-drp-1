import "./helpers/trusted-vertex-ingest.js";

import { ACLGroup, DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { createACL, ObjectACL, ObjectACLDeterministicError } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

class NumberLogDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}
}

let ambientReplayFailureEnabled = false;

class AmbientReplayACL extends ObjectACL {
	override grant(peerId: string, group: ACLGroup): void {
		if (ambientReplayFailureEnabled && peerId === "ambient" && this.query_isWriter("marker")) {
			throw new Error("ambient custom ACL failure");
		}
		super.grant(peerId, group);
	}
}

class AsyncPolicyACL extends ObjectACL {
	override grant(peerId: string, group: ACLGroup): never {
		return Promise.resolve().then(() => super.grant(peerId, group)) as never;
	}
}

class RetractablePolicyACL extends ObjectACL {
	override grant(peerId: string, group: ACLGroup): void {
		if (peerId === "culprit" && this.query_isWriter("marker")) {
			throw new ObjectACLDeterministicError("contextual custom ACL rejection");
		}
		super.grant(peerId, group);
	}
}

function makeVertex(peerId: string, opType: string, value: unknown[], timestamp: number): Vertex {
	return createVertex(
		peerId,
		Operation.create({ drpType: DrpType.DRP, opType, value }),
		[HashGraph.rootHash],
		timestamp
	);
}

function makeACLVertex(
	peerId: string,
	opType: "grant" | "revoke",
	value: [string, ACLGroup],
	dependencies: string[],
	timestamp: number
): Vertex {
	return createVertex(peerId, Operation.create({ drpType: DrpType.ACL, opType, value }), dependencies, timestamp);
}

describe("deterministic rejection taxonomy", () => {
	it("rejects an unauthorized vertex without aborting another valid vertex in the batch", async () => {
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver", "writer"] }),
			drp: new NumberLogDRP(),
		});
		const unauthorized = makeVertex("hostile-peer", "append", [13], 1);
		const valid = makeVertex("writer", "append", [7], 2);

		const result = await receiver.applyVertices([unauthorized, valid]);

		expect(result, "authorization is a deterministic per-vertex rejection").toEqual({
			applied: false,
			missing: [],
			invalid: [unauthorized.hash],
		});
		expect(receiver.vertices.some(({ hash }) => hash === unauthorized.hash)).toBe(false);
		expect(receiver.vertices.some(({ hash }) => hash === valid.hash)).toBe(true);
		expect(receiver.drp?.values).toEqual([7]);
	});

	it("rejects an unknown blueprint operation without aborting another valid vertex in the batch", async () => {
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver", "writer"] }),
			drp: new NumberLogDRP(),
		});
		const unknown = makeVertex("writer", "operationThatDoesNotExist", [], 1);
		const valid = makeVertex("writer", "append", [7], 2);

		const result = await receiver.applyVertices([unknown, valid]);

		expect(result, "an absent blueprint method is a deterministic per-vertex rejection").toEqual({
			applied: false,
			missing: [],
			invalid: [unknown.hash],
		});
		expect(receiver.vertices.some(({ hash }) => hash === unknown.hash)).toBe(false);
		expect(receiver.vertices.some(({ hash }) => hash === valid.hash)).toBe(true);
		expect(receiver.drp?.values).toEqual([7]);
	});

	it("reports a non-root reserved no-op as invalid instead of silently dropping it", async () => {
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver", "writer"] }),
			drp: new NumberLogDRP(),
		});
		const reservedNoOp = makeVertex("writer", "-1", [], 1);
		const valid = makeVertex("writer", "append", [7], 2);

		const result = await receiver.applyVertices([reservedNoOp, valid]);

		expect(result, "a non-root reserved no-op is a deterministic per-vertex rejection").toEqual({
			applied: false,
			missing: [],
			invalid: [reservedNoOp.hash],
		});
		expect(receiver.vertices.some(({ hash }) => hash === reservedNoOp.hash)).toBe(false);
		expect(receiver.vertices.some(({ hash }) => hash === valid.hash)).toBe(true);
		expect(receiver.drp?.values).toEqual([7]);
	});

	it("classifies an ACL authorization throw during canonical replay as invalid, not transient", async () => {
		const grantAdmin = makeACLVertex("receiver", "grant", ["delegated-admin", ACLGroup.Admin], [HashGraph.rootHash], 1);
		const delegatedGrant = makeACLVertex("delegated-admin", "grant", ["writer", ACLGroup.Writer], [grantAdmin.hash], 2);
		const revokeFinality = makeACLVertex(
			"receiver",
			"revoke",
			["delegated-admin", ACLGroup.Finality],
			[HashGraph.rootHash],
			3
		);
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver"] }),
			drp: new NumberLogDRP(),
		});

		await expect(receiver.applyVertices([grantAdmin, delegatedGrant])).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});
		const result = await receiver.applyVertices([revokeFinality]);

		expect(result, "canonical replay reports the submitted revoke, not a committed graph member").toEqual({
			applied: false,
			missing: [],
			invalid: [revokeFinality.hash],
		});
		expect(result.quarantined).toBeUndefined();
		expect(result.invalid, "the committed replay culprit is remembered, not publicly reported").not.toContain(
			delegatedGrant.hash
		);
		expect(
			receiver.vertices.some(({ hash }) => hash === delegatedGrant.hash),
			"S1 keeps the already-committed thrower in the graph"
		).toBe(true);
		expect(receiver["_applier"]["knownInvalidVertexHashes"].has(delegatedGrant.hash)).toBe(true);
		expect(receiver["_applier"]["knownInvalidVertexHashes"].has(revokeFinality.hash)).toBe(true);
	});

	it("keeps an ambient custom ACL replay failure quarantined and retriable", async () => {
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: new AmbientReplayACL({ admins: ["receiver"] }),
			drp: new NumberLogDRP(),
		});
		const marker = makeACLVertex("receiver", "grant", ["marker", ACLGroup.Writer], [HashGraph.rootHash], 10);
		let ambient = makeACLVertex("receiver", "grant", ["ambient", ACLGroup.Writer], [HashGraph.rootHash], 11);
		for (let timestamp = 11; marker.hash >= ambient.hash && timestamp < 267; timestamp++) {
			ambient = makeACLVertex("receiver", "grant", ["ambient", ACLGroup.Writer], [HashGraph.rootHash], timestamp + 1);
		}
		expect(marker.hash < ambient.hash, "the ambient failure must occur during canonical replay").toBe(true);

		await expect(receiver.applyVertices([marker])).resolves.toEqual({ applied: true, missing: [], invalid: [] });
		ambientReplayFailureEnabled = true;
		try {
			await expect(receiver.applyVertices([ambient])).resolves.toEqual({
				applied: false,
				missing: [],
				invalid: [],
				quarantined: [ambient.hash],
			});
			expect(receiver["_applier"]["knownInvalidVertexHashes"].has(ambient.hash)).toBe(false);
		} finally {
			ambientReplayFailureEnabled = false;
		}
		await expect(receiver.applyVertices([ambient])).resolves.toEqual({ applied: true, missing: [], invalid: [] });
	});

	it("retracts an invalid tombstone when the same hash later commits", async () => {
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: new RetractablePolicyACL({ admins: ["receiver"] }),
			drp: new NumberLogDRP(),
		});
		const marker = makeACLVertex("receiver", "grant", ["marker", ACLGroup.Writer], [HashGraph.rootHash], 100);
		let rejectedGrant = makeACLVertex("receiver", "grant", ["culprit", ACLGroup.Writer], [HashGraph.rootHash], 101);
		for (let timestamp = 101; marker.hash >= rejectedGrant.hash && timestamp < 613; timestamp++) {
			rejectedGrant = makeACLVertex(
				"receiver",
				"grant",
				["culprit", ACLGroup.Writer],
				[HashGraph.rootHash],
				timestamp + 1
			);
		}
		expect(marker.hash < rejectedGrant.hash, "the first canonical replay must reach the marker first").toBe(true);
		const removeMarker = makeACLVertex("receiver", "revoke", ["marker", ACLGroup.Writer], [HashGraph.rootHash], 700);

		await expect(receiver.applyVertices([marker])).resolves.toEqual({ applied: true, missing: [], invalid: [] });
		await expect(receiver.applyVertices([rejectedGrant])).resolves.toEqual({
			applied: false,
			missing: [],
			invalid: [rejectedGrant.hash],
		});
		expect(receiver["_applier"]["knownInvalidVertexHashes"].has(rejectedGrant.hash)).toBe(true);
		await expect(receiver.applyVertices([removeMarker])).resolves.toEqual({ applied: true, missing: [], invalid: [] });
		await expect(receiver.applyVertices([rejectedGrant])).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});

		expect(receiver.vertices.some(({ hash }) => hash === rejectedGrant.hash)).toBe(true);
		expect(receiver["_applier"]["knownInvalidVertexHashes"].has(rejectedGrant.hash)).toBe(false);
	});

	it("deduplicates repeated invalid hashes in one result", async () => {
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver"] }),
			drp: new NumberLogDRP(),
		});
		const invalid = makeVertex("receiver", "-1", [], 200);

		await expect(receiver.applyVertices([invalid, invalid])).resolves.toEqual({
			applied: false,
			missing: [],
			invalid: [invalid.hash],
		});
	});

	it("documents inherited FIFO eviction changing an invalid child back to missing", async () => {
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver"] }),
			drp: new NumberLogDRP(),
		});
		const parent = makeVertex("receiver", "-1", [], 300);
		const child = createVertex(
			"receiver",
			Operation.create({ drpType: DrpType.DRP, opType: "append", value: [1] }),
			[parent.hash],
			301
		);

		await expect(receiver.applyVertices([parent, child])).resolves.toEqual({
			applied: false,
			missing: [],
			invalid: [parent.hash, child.hash],
		});
		const flood = Array.from({ length: 10_001 }, (_, index) => makeVertex("receiver", "-1", [], 1_000 + index));
		await receiver.applyVertices(flood);

		await expect(receiver.applyVertices([child])).resolves.toEqual({
			applied: false,
			missing: [child.hash],
			invalid: [],
		});
	});

	it("awaits promise-valued custom ACL operations before publishing state", async () => {
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: new AsyncPolicyACL({ admins: ["receiver"] }),
			drp: new NumberLogDRP(),
		});
		const grant = makeACLVertex("receiver", "grant", ["async-writer", ACLGroup.Writer], [HashGraph.rootHash], 12_000);

		await expect(receiver.applyVertices([grant])).resolves.toEqual({ applied: true, missing: [], invalid: [] });
		expect(receiver.acl.query_isWriter("async-writer")).toBe(true);
	});

	it("re-exports the deterministic ACL marker from the ACL module", () => {
		expect(new ObjectACLDeterministicError("typed custom ACL rejection")).toBeInstanceOf(Error);
	});
});
