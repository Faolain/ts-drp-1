import { SetDRP } from "@ts-drp/blueprints";
import { createPermissionlessACL, DRPObject, HashGraph } from "@ts-drp/object";
import { ACLGroup, DrpType, Operation, Vertex } from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import { beforeAll, describe, expect, test } from "vitest";

import { authenticateIncomingVertices, signGeneratedVertices } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

/**
 * Regression tests for the permissionless vertex-authentication gap:
 * on a permissionless object, ACL-typed vertices must still be
 * signature-authenticated to their claimed author. `permissionless`
 * only relaxes the DRP writer-permission gate.
 */
describe("permissionless ACL author-authentication", () => {
	let victim: DRPNode; // admin of the target object
	let attacker: DRPNode;
	let victimId: string;
	let attackerId: string;

	beforeAll(async () => {
		victim = new DRPNode();
		attacker = new DRPNode();
		await victim.start();
		await attacker.start();
		victimId = victim.networkNode.peerId;
		attackerId = attacker.networkNode.peerId;
	});

	function makeObject(): DRPObject<SetDRP<number>> {
		return new DRPObject<SetDRP<number>>({
			peerId: victimId,
			acl: createPermissionlessACL(victimId), // admin = victim
			drp: new SetDRP<number>(),
		});
	}

	function forgedAdminGrant(): Vertex {
		const op = Operation.create({ opType: "grant", value: [attackerId, ACLGroup.Admin], drpType: DrpType.ACL });
		const ts = Date.now();
		return Vertex.create({
			hash: computeHash(victimId, op, [HashGraph.rootHash], ts),
			peerId: victimId, // mis-attributed: claims the admin authored it
			operation: op,
			dependencies: [HashGraph.rootHash],
			timestamp: ts,
			signature: new Uint8Array(), // NOT signed by the victim
		});
	}

	test("mis-attributed/unsigned ACL vertex is REJECTED on a permissionless object", () => {
		const object = makeObject();
		const kept = authenticateIncomingVertices(object, [forgedAdminGrant()]);
		expect(kept).toHaveLength(0);
	});

	test("forged ACL vertex cannot escalate privileges through the merge path", async () => {
		const object = makeObject();
		expect(object.acl.query_isAdmin(attackerId)).toBe(false);

		const kept = authenticateIncomingVertices(object, [forgedAdminGrant()]);
		await object.merge(kept);

		expect(object.acl.query_isAdmin(attackerId)).toBe(false);
	});

	test("legitimately-signed permissionless DRP write STILL applies", async () => {
		const object = makeObject();
		const op = Operation.create({ opType: "add", value: [42], drpType: DrpType.DRP });
		const ts = Date.now();
		const drpVertex = Vertex.create({
			hash: computeHash(attackerId, op, [HashGraph.rootHash], ts),
			peerId: attackerId, // an arbitrary permissionless writer, as themselves
			operation: op,
			dependencies: [HashGraph.rootHash],
			timestamp: ts,
			signature: new Uint8Array(),
		});
		await signGeneratedVertices(attacker, [drpVertex]);

		const kept = authenticateIncomingVertices(object, [drpVertex]);
		expect(kept).toHaveLength(1);
	});

	function forgedACLVertex(op: ReturnType<typeof Operation.create>): Vertex {
		const ts = Date.now();
		return Vertex.create({
			hash: computeHash(victimId, op, [HashGraph.rootHash], ts),
			peerId: victimId, // mis-attributed to the admin
			operation: op,
			dependencies: [HashGraph.rootHash],
			timestamp: ts,
			signature: new Uint8Array(), // NOT signed by the victim
		});
	}

	test("mis-attributed/unsigned ACL setKey vertex is REJECTED", () => {
		const object = makeObject();
		const forged = forgedACLVertex(
			Operation.create({ opType: "setKey", value: ["forged-bls-key"], drpType: DrpType.ACL })
		);
		expect(authenticateIncomingVertices(object, [forged])).toHaveLength(0);
	});

	test("mis-attributed/unsigned ACL revoke vertex is REJECTED", () => {
		const object = makeObject();
		const forged = forgedACLVertex(
			Operation.create({ opType: "revoke", value: [victimId, ACLGroup.Finality], drpType: DrpType.ACL })
		);
		expect(authenticateIncomingVertices(object, [forged])).toHaveLength(0);
	});

	test("mixed batch: a signed DRP write is kept while a forged ACL grant is dropped", async () => {
		const object = makeObject();

		// A legitimate permissionless DRP write, validly signed by the attacker.
		const drpOp = Operation.create({ opType: "add", value: [123], drpType: DrpType.DRP });
		const ts = Date.now();
		const drpVertex = Vertex.create({
			hash: computeHash(attackerId, drpOp, [HashGraph.rootHash], ts),
			peerId: attackerId,
			operation: drpOp,
			dependencies: [HashGraph.rootHash],
			timestamp: ts,
			signature: new Uint8Array(),
		});
		await signGeneratedVertices(attacker, [drpVertex]);

		const kept = authenticateIncomingVertices(object, [forgedAdminGrant(), drpVertex]);
		expect(kept).toEqual([drpVertex]);
	});

	test("legitimately-signed ACL op by the real author STILL applies", async () => {
		const object = makeObject();
		const op = Operation.create({ opType: "grant", value: [attackerId, ACLGroup.Finality], drpType: DrpType.ACL });
		const ts = Date.now();
		const aclVertex = Vertex.create({
			hash: computeHash(victimId, op, [HashGraph.rootHash], ts),
			peerId: victimId, // the real admin
			operation: op,
			dependencies: [HashGraph.rootHash],
			timestamp: ts,
			signature: new Uint8Array(),
		});
		await signGeneratedVertices(victim, [aclVertex]); // signed by the real author

		const kept = authenticateIncomingVertices(object, [aclVertex]);
		expect(kept).toHaveLength(1);
	});
});
