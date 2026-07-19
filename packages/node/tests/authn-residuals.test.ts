import { SetDRP } from "@ts-drp/blueprints";
import { createPermissionlessACL, DRPObject, HashGraph } from "@ts-drp/object";
import {
	ACLGroup,
	Attestation,
	type DRPState,
	DrpType,
	FetchStateResponse,
	Message,
	MessageType,
	Operation,
	Update,
	Vertex,
} from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import { serializeDRPState } from "@ts-drp/utils/serialization";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { authenticateIncomingVertices, handleMessage, signGeneratedVertices } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

/**
 * Extract the set of peers marked as ACL Admin in a serialized ACL snapshot.
 * The ACL serializes its authority map under the `_authorizedPeers` key.
 * @param state - The serialized ACL snapshot to inspect.
 * @returns The set of peer ids granted ACL Admin in the snapshot.
 */
function adminPeersFromState(state: DRPState | undefined): Set<string> {
	const admins = new Set<string>();
	if (!state) return admins;
	const entry = state.state.find((s) => s.key === "_authorizedPeers");
	if (!entry || !(entry.value instanceof Map)) return admins;
	for (const [peerId, perms] of entry.value.entries()) {
		const permissions: Set<ACLGroup> | undefined = perms?.permissions;
		if (permissions instanceof Set && permissions.has(ACLGroup.Admin)) {
			admins.add(peerId as string);
		}
	}
	return admins;
}

describe("network-reachable authority/finality residuals", () => {
	let victim: DRPNode;
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

	afterAll(async () => {
		await victim.stop?.();
		await attacker.stop?.();
	});

	function poisonedACLSnapshot(): ReturnType<typeof serializeDRPState> {
		// An attacker-controlled ACL snapshot that would mark both peers as
		// Admin + Finality signers if adopted.
		return serializeDRPState({
			state: [
				{
					key: "_authorizedPeers",
					value: new Map([
						[
							victimId,
							{
								blsPublicKey: victim.keychain.blsPublicKey,
								permissions: new Set([ACLGroup.Admin, ACLGroup.Finality]),
							},
						],
						[
							attackerId,
							{
								blsPublicKey: attacker.keychain.blsPublicKey,
								permissions: new Set([ACLGroup.Admin, ACLGroup.Finality]),
							},
						],
					]),
				},
				{ key: "permissionless", value: true },
			],
		});
	}

	async function deliverUpdate(vertices: Vertex[], attestations: Attestation[], objectId: string): Promise<void> {
		await handleMessage(
			victim,
			Message.create({
				sender: attackerId,
				type: MessageType.MESSAGE_TYPE_UPDATE,
				data: Update.encode(Update.create({ vertices, attestations })).finish(),
				objectId,
			})
		);
	}

	function drpAdd(value: number, deps: string[], ts: number): Vertex {
		const op = Operation.create({ opType: "add", value: [value], drpType: DrpType.DRP });
		return Vertex.create({
			hash: computeHash(attackerId, op, deps, ts),
			peerId: attackerId,
			operation: op,
			dependencies: deps,
			timestamp: ts,
			signature: new Uint8Array(),
		});
	}

	// FIX A -------------------------------------------------------------------
	test("FIX A: unsolicited FETCH_STATE_RESPONSE with poisoned non-root ACL snapshot is NOT adopted", async () => {
		const obj = await victim.createObject({ drp: new SetDRP<number>() });
		const root = obj.vertices[0].hash;

		// Land one honest signed DRP vertex so a non-root vertex hash exists.
		const v0 = drpAdd(1, [root], Date.now());
		await signGeneratedVertices(attacker, [v0]);
		await deliverUpdate([v0], [], obj.id);
		const rh = v0.hash;
		expect(obj.vertices.some((v) => v.hash === rh)).toBe(true);

		// Attacker never solicited this; honest fetchState only ever asks for rootHash.
		await handleMessage(
			victim,
			Message.create({
				sender: attackerId,
				type: MessageType.MESSAGE_TYPE_FETCH_STATE_RESPONSE,
				data: FetchStateResponse.encode(
					FetchStateResponse.create({ vertexHash: rh, aclState: poisonedACLSnapshot() })
				).finish(),
				objectId: obj.id,
			})
		);

		// The attacker-controlled snapshot must NOT have been written into the
		// object's per-vertex ACL state.
		const storedAcl = obj.getStates(rh)[0];
		expect(adminPeersFromState(storedAcl).has(attackerId)).toBe(false);
		// Live authority is likewise untouched.
		expect(obj.acl.query_isAdmin(attackerId)).toBe(false);
		expect(obj.acl.query_isFinalitySigner(attackerId)).toBe(false);
	});

	// FIX B -------------------------------------------------------------------
	test("FIX B: forged finality attestation from a non-live-signer sender is NOT counted", async () => {
		const obj = await victim.createObject({ drp: new SetDRP<number>() });
		const root = obj.vertices[0].hash;

		// v0 anchors a non-root hash; poison it (exercises the full poc3c chain).
		const v0 = drpAdd(10, [root], Date.now());
		await signGeneratedVertices(attacker, [v0]);
		await deliverUpdate([v0], [], obj.id);
		const rh = v0.hash;

		await handleMessage(
			victim,
			Message.create({
				sender: attackerId,
				type: MessageType.MESSAGE_TYPE_FETCH_STATE_RESPONSE,
				data: FetchStateResponse.encode(
					FetchStateResponse.create({ vertexHash: rh, aclState: poisonedACLSnapshot() })
				).finish(),
				objectId: obj.id,
			})
		);

		const v1 = drpAdd(20, [rh], Date.now() + 5);
		await signGeneratedVertices(attacker, [v1]);
		await deliverUpdate([v1], [], obj.id);
		const before = obj.finalityStore.getNumberOfSignatures(v1.hash);

		// Piggyback a forged attestation over v1, signed with the attacker's own
		// BLS key, alongside an unrelated child vertex.
		const v2 = drpAdd(30, [v1.hash], Date.now() + 9);
		await signGeneratedVertices(attacker, [v2]);
		const forgedAttV1 = Attestation.create({
			data: v1.hash,
			signature: attacker.keychain.signWithBls(v1.hash),
		});
		await deliverUpdate([v2], [forgedAttV1], obj.id);

		const after = obj.finalityStore.getNumberOfSignatures(v1.hash);
		expect(after).toBe(before);
		expect(obj.acl.query_isFinalitySigner(attackerId)).toBe(false);
		expect(obj.finalityStore.isFinalized(v1.hash)).toBe(false);
	});
});

// FIX C ----------------------------------------------------------------------
describe("permissionless DRP identity authentication", () => {
	let attacker: DRPNode;
	let victimId: string;
	let attackerId: string;

	beforeAll(async () => {
		const victim = new DRPNode();
		attacker = new DRPNode();
		await victim.start();
		await attacker.start();
		victimId = victim.networkNode.peerId;
		attackerId = attacker.networkNode.peerId;
	});

	function makeObject(): DRPObject<SetDRP<number>> {
		return new DRPObject<SetDRP<number>>({
			peerId: victimId,
			acl: createPermissionlessACL(victimId),
			drp: new SetDRP<number>(),
		});
	}

	test("DRP vertex spoofing another peer's authorship (forged/absent signature) is REJECTED", () => {
		const object = makeObject();
		const op = Operation.create({ opType: "add", value: [99], drpType: DrpType.DRP });
		const ts = Date.now();
		const spoofed = Vertex.create({
			hash: computeHash(victimId, op, [HashGraph.rootHash], ts),
			peerId: victimId, // impersonates the victim as author
			operation: op,
			dependencies: [HashGraph.rootHash],
			timestamp: ts,
			signature: new Uint8Array(), // not signed by the victim
		});
		const kept = authenticateIncomingVertices(object, [spoofed]);
		expect(kept).toHaveLength(0);
	});

	test("legitimately-signed permissionless DRP write by any peer STILL applies", async () => {
		const object = makeObject();
		const op = Operation.create({ opType: "add", value: [7], drpType: DrpType.DRP });
		const ts = Date.now();
		const v = Vertex.create({
			hash: computeHash(attackerId, op, [HashGraph.rootHash], ts),
			peerId: attackerId,
			operation: op,
			dependencies: [HashGraph.rootHash],
			timestamp: ts,
			signature: new Uint8Array(),
		});
		await signGeneratedVertices(attacker, [v]);
		const kept = authenticateIncomingVertices(object, [v]);
		expect(kept).toHaveLength(1);
	});
});
