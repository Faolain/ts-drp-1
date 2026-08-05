/**
 * Phase 1k RED: deterministic-invalid work is governed per remote peer, not by
 * the existing per-(objectId, sender) missing-sync retry episode.
 */
import { SetDRP } from "@ts-drp/blueprints";
import { createVertex, HashGraph } from "@ts-drp/object";
import { DrpType, Message, MessageType, NodeEventName, Operation, Update, Vertex } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

const INVALID_HASH_CAPACITY = 10_000;
const UPDATE_BATCH_LIMIT = 32;

interface RunningNode {
	node: DRPNode;
	stop(): Promise<void>;
}

async function makeNode(seed: string): Promise<RunningNode> {
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
	return { node, stop: () => node.stop() };
}

function operation(value: number, opType = "add"): Operation {
	return Operation.create({ drpType: DrpType.DRP, opType, value: [value] });
}

async function signedVertex(
	author: DRPNode,
	value: number,
	dependencies: string[] = [HashGraph.rootHash],
	opType = "add"
): Promise<Vertex> {
	const vertex = createVertex(
		author.networkNode.peerId,
		operation(value, opType),
		dependencies,
		1_710_000_000_000 + value
	);
	vertex.signature = await author.keychain.signWithSecp256k1(vertex.hash);
	return vertex;
}

function update(sender: string, objectId: string, vertices: readonly Vertex[]): Message {
	return Message.create({
		data: Update.encode(Update.create({ vertices: [...vertices] })).finish(),
		objectId,
		sender,
		type: MessageType.MESSAGE_TYPE_UPDATE,
	});
}

async function deliverBatches(
	receiver: DRPNode,
	sender: string,
	objectIds: readonly string[],
	vertices: readonly Vertex[]
): Promise<void> {
	for (let offset = 0; offset < vertices.length; offset += UPDATE_BATCH_LIMIT) {
		const objectId = objectIds[(offset / UPDATE_BATCH_LIMIT) % objectIds.length];
		await handleMessage(receiver, update(sender, objectId, vertices.slice(offset, offset + UPDATE_BATCH_LIMIT)));
	}
}

function forgedVertex(peerId: string, index: number): Vertex {
	return Vertex.create({
		dependencies: [HashGraph.rootHash],
		hash: `phase-1k-auth-invalid-${index}`,
		operation: operation(index),
		peerId,
		signature: new Uint8Array(65).fill(0x41),
		timestamp: 1_710_100_000_000 + index,
	});
}

describe("Phase 1k per-peer invalid-vertex budget", () => {
	const running: RunningNode[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled(running.splice(0).map(({ stop }) => stop()));
	});

	test("aggregates rotating authentication-invalid hashes across objects and disconnects the attacker once", async () => {
		const receiver = await makeNode("phase-1k-auth-invalid-receiver");
		const attacker = await makeNode("phase-1k-auth-invalid-attacker");
		const honest = await makeNode("phase-1k-auth-invalid-honest");
		running.push(receiver, attacker, honest);
		const attackerPeerId = String(attacker.node.networkNode.peerId);
		const objectIds = Array.from({ length: 4 }, (_, index) => `phase-1k-auth-invalid-object-${index}`);
		const receiverObjects = await Promise.all(
			objectIds.map((id) =>
				receiver.node.createObject({
					drp: new SetDRP<number>(),
					finality_config: { enabled: false },
					id,
				})
			)
		);
		const disconnect = vi.spyOn(receiver.node.networkNode, "disconnect").mockResolvedValue();
		const syncObject = vi.spyOn(receiver.node, "syncObject").mockResolvedValue();
		const rejected = vi.fn();
		receiver.node.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);

		const forged = Array.from({ length: INVALID_HASH_CAPACITY }, (_, index) => forgedVertex(attackerPeerId, index));
		await deliverBatches(receiver.node, attackerPeerId, objectIds, forged);
		await handleMessage(receiver.node, update(attackerPeerId, objectIds[0], [forgedVertex(attackerPeerId, 10_001)]));

		const honestVertex = await signedVertex(honest.node, 42);
		await handleMessage(receiver.node, update(honest.node.networkNode.peerId, objectIds[0], [honestVertex]));

		expect.soft(disconnect).toHaveBeenCalledTimes(1);
		expect.soft(disconnect.mock.calls.map(([peerId]) => String(peerId))).toEqual([attackerPeerId]);
		expect.soft(syncObject).not.toHaveBeenCalled();
		expect.soft(rejected.mock.calls.length).toBe(0);
		expect.soft(receiverObjects[0].drp?.query_has(42)).toBe(true);
	}, 60_000);

	test("stops evicted-parent recovery across object ids after the peer exhausts its invalid budget", async () => {
		const receiver = await makeNode("phase-1k-eviction-receiver");
		const attacker = await makeNode("phase-1k-eviction-attacker");
		running.push(receiver, attacker);
		const attackerPeerId = String(attacker.node.networkNode.peerId);
		const tombstoneObjectId = "phase-1k-tombstone-object";
		const recoveryObjectIds = Array.from({ length: 4 }, (_, index) => `phase-1k-recovery-object-${index}`);
		await Promise.all(
			[tombstoneObjectId, ...recoveryObjectIds].map((id) =>
				receiver.node.createObject({
					drp: new SetDRP<number>(),
					finality_config: { enabled: false },
					id,
				})
			)
		);
		const disconnect = vi.spyOn(receiver.node.networkNode, "disconnect").mockResolvedValue();
		const syncObject = vi.spyOn(receiver.node, "syncObject").mockResolvedValue();
		const rejected = vi.fn();
		receiver.node.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);

		const deterministicInvalid: Vertex[] = [];
		for (let index = 0; index <= INVALID_HASH_CAPACITY; index++) {
			deterministicInvalid.push(await signedVertex(attacker.node, index, [HashGraph.rootHash], "-1"));
		}
		await deliverBatches(receiver.node, attackerPeerId, [tombstoneObjectId], deterministicInvalid);

		const evictedParent = deterministicInvalid[0];
		for (let objectIndex = 0; objectIndex < recoveryObjectIds.length; objectIndex++) {
			const descendants: Vertex[] = [];
			for (let retry = 0; retry < 4; retry++) {
				descendants.push(await signedVertex(attacker.node, 20_000 + objectIndex * 10 + retry, [evictedParent.hash]));
			}
			for (const descendant of descendants) {
				await handleMessage(receiver.node, update(attackerPeerId, recoveryObjectIds[objectIndex], [descendant]));
			}
		}

		expect.soft(disconnect).toHaveBeenCalledTimes(1);
		expect.soft(disconnect.mock.calls.map(([peerId]) => String(peerId))).toEqual([attackerPeerId]);
		expect.soft(syncObject).not.toHaveBeenCalled();
		expect.soft(rejected.mock.calls.length).toBe(0);
	}, 120_000);

	test("does not charge a trusted duplicate or one signed missing input", async () => {
		const receiver = await makeNode("phase-1k-safe-control-receiver");
		const sender = await makeNode("phase-1k-safe-control-sender");
		running.push(receiver, sender);
		const objectId = "phase-1k-safe-control-object";
		const object = await receiver.node.createObject({
			drp: new SetDRP<number>(),
			finality_config: { enabled: false },
			id: objectId,
		});
		const disconnect = vi.spyOn(receiver.node.networkNode, "disconnect").mockResolvedValue();
		const syncObject = vi.spyOn(receiver.node, "syncObject").mockResolvedValue();
		const accepted = await signedVertex(sender.node, 30_001);
		const acceptedUpdate = update(sender.node.networkNode.peerId, objectId, [accepted]);

		await handleMessage(receiver.node, acceptedUpdate);
		await handleMessage(receiver.node, acceptedUpdate);
		const signedMissing = await signedVertex(sender.node, 30_002, ["phase-1k-unknown-parent"]);
		await handleMessage(receiver.node, update(sender.node.networkNode.peerId, objectId, [signedMissing]));

		expect.soft(disconnect).not.toHaveBeenCalled();
		expect.soft(syncObject).toHaveBeenCalledOnce();
		expect.soft(object.drp?.query_has(30_001)).toBe(true);
		expect.soft(object.getVertex(signedMissing.hash)).toBeUndefined();
	}, 30_000);
});
