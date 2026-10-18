/**
 * Phase 1o-b RED: one heads-chunk payload has one aggregate hash entitlement.
 * Current heads and the scheduled exact-recovery chunk retain their accepted
 * Phase 1n semantics; verified shared history uses only the remaining slots.
 * Internal retention and cross-peer/object aggregate quotas remain separate
 * Phase 1o obligations.
 */
import {
	DRP_HEADS_CHUNK_PROTOCOL,
	type SelectedSyncProtocol,
	SYNC_HEADS_FIELD_HASH_CAP,
	SYNC_HEADS_TOTAL_HASH_CAP,
} from "@ts-drp/network";
import { createACL, HashGraph } from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	type IDRPObject,
	Message,
	type ResolveConflictsType,
	SemanticsType,
	Sync,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMessage, signGeneratedVertices } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";
import { buildSyncPayloadForProtocol, buildSyncResponseChunks } from "../src/sync-codec.js";
import {
	previewSyncSend,
	queueExactRequests,
	recordBranchCuts,
	recordSharedHeads,
	sharedHashes,
} from "../src/sync-state.js";

const HEADS_SELECTION = Object.freeze({
	mode: "heads-chunk",
	protocol: DRP_HEADS_CHUNK_PROTOCOL,
} satisfies SelectedSyncProtocol);

class CounterDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	value = 0;

	increment(): void {
		this.value++;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

async function makeNode(seed: string): Promise<DRPNode> {
	const node = new DRPNode({
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			log_config: { level: "silent" },
		},
		keychain_config: { private_key_seed: seed },
		log_config: { level: "silent" },
	});
	await node.start();
	return node;
}

function coordinatedACL(nodes: readonly DRPNode[]): ReturnType<typeof createACL> {
	const acl = createACL({ admins: nodes.map(({ networkNode }) => networkNode.peerId) });
	for (const node of nodes) {
		acl.context = { caller: node.networkNode.peerId };
		acl.setKey(node.keychain.blsPublicKey);
	}
	acl.context = { caller: "" };
	return acl;
}

async function makeReplicas(
	creatorNode: DRPNode,
	replicaNode: DRPNode
): Promise<{ creator: IDRPObject<CounterDRP>; replica: IDRPObject<CounterDRP> }> {
	const nodes = [creatorNode, replicaNode];
	const creator = await creatorNode.createObject({
		acl: coordinatedACL(nodes),
		drp: new CounterDRP(),
		finality_config: { enabled: false },
	});
	const replica = await replicaNode.createObject({
		acl: coordinatedACL(nodes),
		drp: new CounterDRP(),
		finality_config: { enabled: false },
		id: creator.id,
	});
	return { creator, replica };
}

function nonRoot(vertices: readonly Vertex[]): Vertex[] {
	return vertices.filter(({ hash }) => hash !== HashGraph.rootHash);
}

function buildHeadsPayload(node: DRPNode, objectId: string, peerId: string): Message {
	return buildSyncPayloadForProtocol(node, {
		objectId,
		peerId,
		protocol: DRP_HEADS_CHUNK_PROTOCOL,
		purpose: "scheduled-probe",
	});
}

function hashCount(sync: Sync): number {
	return sync.heads.length + sync.sharedHeads.length + sync.requestedHashes.length;
}

function syntheticHash(index: number): string {
	return index.toString(16).padStart(64, "0");
}

describe("Phase 1o-b aggregate per-object/peer sync egress entitlement", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("preserves current heads and both exact chunks while shared cuts yield the remaining slot budget", async () => {
		const responder = await makeNode("phase-1o-b-responder");
		const requester = await makeNode("phase-1o-b-requester");
		nodes.push(responder, requester);
		vi.spyOn(requester.networkNode, "broadcastMessage").mockResolvedValue();
		const { creator: responderObject, replica: requesterObject } = await makeReplicas(responder, requester);

		for (let index = 0; index < SYNC_HEADS_FIELD_HASH_CAP; index++) responderObject.drp?.increment();
		await signGeneratedVertices(responder, responderObject.vertices);
		const common = nonRoot(responderObject.vertices);
		await expect(requesterObject.merge(common)).resolves.toEqual([true, [], []]);

		for (let index = 0; index < SYNC_HEADS_FIELD_HASH_CAP * 2; index++) responderObject.drp?.increment();
		await signGeneratedVertices(responder, responderObject.vertices);
		const missing = nonRoot(responderObject.vertices).slice(common.length);
		expect(missing).toHaveLength(SYNC_HEADS_FIELD_HASH_CAP * 2);

		const currentSharedHead = requesterObject.getHistoryHeads()[0];
		if (currentSharedHead === undefined) throw new Error("Expected one current requester head");
		recordSharedHeads(requester, requesterObject.id, responder.networkNode.peerId, [currentSharedHead]);
		recordBranchCuts(
			requester,
			requesterObject.id,
			responder.networkNode.peerId,
			common.map(({ hash }) => hash)
		);
		const selectedShared = sharedHashes(requester, requesterObject.id, responder.networkNode.peerId);
		expect(selectedShared).toHaveLength(SYNC_HEADS_FIELD_HASH_CAP);
		expect(
			queueExactRequests(
				requester,
				requesterObject.id,
				responder.networkNode.peerId,
				missing.map(({ hash }) => hash)
			)
		).toBe(true);
		const firstExactChunk = previewSyncSend(
			requester,
			requesterObject.id,
			responder.networkNode.peerId,
			"scheduled-probe"
		).requestedHashes;
		expect(requesterObject.getHistoryHeads().length + selectedShared.length + firstExactChunk.length).toBe(
			SYNC_HEADS_TOTAL_HASH_CAP + 1
		);

		const requestedAcrossRounds = new Set<string>();
		for (let round = 0; round < 2; round++) {
			const expectedHeads = requesterObject.getHistoryHeads();
			const request = buildHeadsPayload(requester, requesterObject.id, responder.networkNode.peerId);
			const wire = Sync.decode(request.data);
			const sharedBudget = SYNC_HEADS_TOTAL_HASH_CAP - expectedHeads.length - wire.requestedHashes.length;

			expect.soft(wire.heads, `round ${round + 1} keeps every current head`).toEqual(expectedHeads);
			expect
				.soft(wire.requestedHashes, `round ${round + 1} keeps the truthful exact chunk`)
				.toHaveLength(SYNC_HEADS_FIELD_HASH_CAP);
			expect
				.soft(wire.sharedHeads, `round ${round + 1} yields only the remaining aggregate slots`)
				.toEqual(selectedShared.slice(0, sharedBudget));
			expect.soft(hashCount(wire)).toBe(SYNC_HEADS_TOTAL_HASH_CAP);
			for (const field of [wire.heads, wire.sharedHeads, wire.requestedHashes]) {
				expect.soft(field.length).toBeLessThanOrEqual(SYNC_HEADS_FIELD_HASH_CAP);
			}
			for (const hash of wire.requestedHashes) requestedAcrossRounds.add(hash);

			const responses = await buildSyncResponseChunks(responder, {
				objectId: responderObject.id,
				peerId: requester.networkNode.peerId,
				request,
			});
			for (const response of responses) {
				await handleMessage(requester, Message.decode(Message.encode(response).finish()), HEADS_SELECTION);
			}
		}

		expect(requestedAcrossRounds).toEqual(new Set(missing.map(({ hash }) => hash)));
		expect(requesterObject.drp?.value).toBe(responderObject.drp?.value);
		expect(new Set(requesterObject.vertices.map(({ hash }) => hash))).toEqual(
			new Set(responderObject.vertices.map(({ hash }) => hash))
		);
	}, 20_000);

	test("a saturated pair cannot spend another peer or object's combined payload budget", async () => {
		const owner = await makeNode("phase-1o-b-isolation-owner");
		const peerA = await makeNode("phase-1o-b-isolation-peer-a");
		const peerB = await makeNode("phase-1o-b-isolation-peer-b");
		nodes.push(owner, peerA, peerB);
		const attacked = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		const independent = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		for (let index = 0; index < SYNC_HEADS_FIELD_HASH_CAP + 1; index++) attacked.drp?.increment();
		independent.drp?.increment();

		recordBranchCuts(
			owner,
			attacked.id,
			peerA.networkNode.peerId,
			attacked.vertices.map(({ hash }) => hash)
		);
		queueExactRequests(
			owner,
			attacked.id,
			peerA.networkNode.peerId,
			Array.from({ length: SYNC_HEADS_FIELD_HASH_CAP * 2 }, (_, index) => syntheticHash(index + 1))
		);

		const honestSameObjectExact = syntheticHash(10_001);
		const honestSamePeerExact = syntheticHash(20_001);
		recordSharedHeads(owner, attacked.id, peerB.networkNode.peerId, [HashGraph.rootHash]);
		queueExactRequests(owner, attacked.id, peerB.networkNode.peerId, [honestSameObjectExact]);
		recordSharedHeads(owner, independent.id, peerA.networkNode.peerId, [HashGraph.rootHash]);
		queueExactRequests(owner, independent.id, peerA.networkNode.peerId, [honestSamePeerExact]);

		const sameObjectWire = Sync.decode(buildHeadsPayload(owner, attacked.id, peerB.networkNode.peerId).data);
		const samePeerWire = Sync.decode(buildHeadsPayload(owner, independent.id, peerA.networkNode.peerId).data);

		expect(sameObjectWire.requestedHashes).toEqual([honestSameObjectExact]);
		expect(sameObjectWire.sharedHeads).toEqual([HashGraph.rootHash]);
		expect(hashCount(sameObjectWire)).toBe(3);
		expect(samePeerWire.requestedHashes).toEqual([honestSamePeerExact]);
		expect(samePeerWire.sharedHeads).toEqual([HashGraph.rootHash]);
		expect(hashCount(samePeerWire)).toBe(3);
	});
});
