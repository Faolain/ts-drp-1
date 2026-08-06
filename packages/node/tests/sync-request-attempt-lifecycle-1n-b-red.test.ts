/**
 * Phase 1n-b RED: retry accounting belongs to scheduled outbound probes for an
 * exact unanswered request, never to repeated inbound delivery.
 */
import { BinaryReader } from "@bufbuild/protobuf/wire";
import type { NegotiatedSyncSender } from "@ts-drp/network";
import { createPermissionlessACL, HashGraph } from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	Message,
	MessageType,
	NodeEventName,
	type ResolveConflictsType,
	SemanticsType,
	SyncAccept,
	Update,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMessage, signGeneratedVertices, SYNC_RECOVERY_COOLDOWN_MS } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

const INTERVAL_MS = 1_000;

interface Outbound {
	message: Message;
	to: string;
}

const outboundByNode = new WeakMap<DRPNode, Outbound[]>();

function syncSender(node: () => DRPNode): NegotiatedSyncSender {
	function outbound(): Outbound[] {
		const capture = outboundByNode.get(node());
		if (capture === undefined) throw new Error("Expected outbound capture");
		return capture;
	}
	return {
		async sendSyncMessage(to, payloadFactory): Promise<void> {
			const message = await payloadFactory({
				mode: "heads-chunk",
				protocol: "/drp/message/1.0.0/heads-chunk",
			});
			outbound().push({ message, to });
		},
		sendSyncResponseMessage(to, message): Promise<void> {
			outbound().push({ message, to });
			return Promise.resolve();
		},
	};
}

interface MissingFixture {
	ancestor?: Vertex;
	leaf: Vertex;
	parent: Vertex;
}

class CounterDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	value = 0;

	increment(): void {
		this.value += 1;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

async function makeNode(seed: string, interval = 60_000): Promise<DRPNode> {
	const node: DRPNode = new DRPNode(
		{
			network_config: {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
			},
			keychain_config: { private_key_seed: seed },
			interval_sync_options: { interval },
			log_config: { level: "silent" },
		},
		{ syncSender: syncSender(() => node) }
	);
	await node.start();
	return node;
}

function captureOutbound(node: DRPNode): Outbound[] {
	const outbound: Outbound[] = [];
	outboundByNode.set(node, outbound);
	vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
	return outbound;
}

async function createReceiverObject(node: DRPNode, id: string): Promise<void> {
	await node.createObject({ id, drp: new CounterDRP(), acl: createPermissionlessACL() });
}

async function missingFixture(sender: DRPNode, objectId: string, depth = 2): Promise<MissingFixture> {
	const object = await sender.createObject({ id: objectId, drp: new CounterDRP(), acl: createPermissionlessACL() });
	for (let index = 0; index < depth; index++) object.drp?.increment();
	await signGeneratedVertices(sender, object.vertices);
	const vertices = object.vertices.filter(({ hash }) => hash !== HashGraph.rootHash);
	const leaf = vertices.at(-1);
	const parent = vertices.at(-2);
	if (leaf === undefined || parent === undefined) throw new Error("Expected a signed missing-parent fixture");
	return { ancestor: vertices.at(-3), leaf, parent };
}

function incompleteMessage(
	sender: DRPNode,
	objectId: string,
	vertex: Vertex,
	type = MessageType.MESSAGE_TYPE_SYNC_ACCEPT
): Message {
	const data =
		type === MessageType.MESSAGE_TYPE_UPDATE
			? Update.encode(Update.create({ vertices: [vertex] })).finish()
			: SyncAccept.encode(SyncAccept.create({ requested: [vertex] })).finish();
	return Message.create({ data, objectId, sender: sender.networkNode.peerId, type });
}

function requestedHashes(message: Message): string[] {
	if (message.type !== MessageType.MESSAGE_TYPE_SYNC) return [];
	const result: string[] = [];
	const reader = new BinaryReader(message.data);
	while (reader.pos < reader.len) {
		const tag = reader.uint32();
		if ((tag & 7) === 2 && tag >>> 3 === 4) result.push(reader.string());
		else reader.skip(tag & 7);
	}
	return result;
}

function exactRequests(outbound: readonly Outbound[], objectId: string, peerId: string): string[][] {
	return outbound
		.filter(
			({ message, to }) =>
				to === peerId && message.objectId === objectId && message.type === MessageType.MESSAGE_TYPE_SYNC
		)
		.map(({ message }) => requestedHashes(message))
		.filter((hashes) => hashes.length !== 0);
}

describe("Phase 1n-b scheduled exact-request attempts", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("duplicates are neutral; scheduled attempts two and three re-carry the parent, then attempt four rejects and cools down", async () => {
		const objectId = "phase-1n-b-attempt-owner";
		const receiver = await makeNode("phase-1n-b-attempt-receiver");
		const sender = await makeNode("phase-1n-b-attempt-sender");
		nodes.push(receiver, sender);
		const outbound = captureOutbound(receiver);
		await createReceiverObject(receiver, objectId);
		const { leaf, parent } = await missingFixture(sender, objectId);
		const incomplete = incompleteMessage(sender, objectId, leaf);
		const rejected = vi.fn();
		receiver.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		try {
			await handleMessage(receiver, incomplete);
			expect(exactRequests(outbound, objectId, sender.networkNode.peerId)).toEqual([[parent.hash]]);

			await handleMessage(receiver, incomplete);
			expect(exactRequests(outbound, objectId, sender.networkNode.peerId)).toEqual([[parent.hash]]);

			await receiver.syncObject(objectId, sender.networkNode.peerId);
			await receiver.syncObject(objectId, sender.networkNode.peerId);
			expect(exactRequests(outbound, objectId, sender.networkNode.peerId)).toEqual([
				[parent.hash],
				[parent.hash],
				[parent.hash],
			]);

			await receiver.syncObject(objectId, sender.networkNode.peerId);
			expect(exactRequests(outbound, objectId, sender.networkNode.peerId)).toHaveLength(3);
			expect(rejected).toHaveBeenCalledTimes(1);
			expect(rejected.mock.calls[0]?.[0].detail).toEqual({
				id: objectId,
				peerId: sender.networkNode.peerId,
				retries: 3,
			});

			await handleMessage(receiver, incomplete);
			await receiver.syncObject(objectId, sender.networkNode.peerId);
			expect(exactRequests(outbound, objectId, sender.networkNode.peerId)).toHaveLength(3);
			expect(rejected).toHaveBeenCalledTimes(1);

			now += SYNC_RECOVERY_COOLDOWN_MS;
			await receiver.syncObject(objectId, sender.networkNode.peerId);
			expect(exactRequests(outbound, objectId, sender.networkNode.peerId)).toEqual([
				[parent.hash],
				[parent.hash],
				[parent.hash],
				[parent.hash],
			]);
			expect(rejected).toHaveBeenCalledTimes(1);
		} finally {
			receiver.removeEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
		}
	}, 20_000);

	test("UPDATE discovers the same exact request without retaining an inbound receive counter", async () => {
		const objectId = "phase-1n-b-update-attempt-owner";
		const receiver = await makeNode("phase-1n-b-update-attempt-receiver");
		const sender = await makeNode("phase-1n-b-update-attempt-sender");
		nodes.push(receiver, sender);
		const outbound = captureOutbound(receiver);
		await createReceiverObject(receiver, objectId);
		const { leaf, parent } = await missingFixture(sender, objectId);
		const update = incompleteMessage(sender, objectId, leaf, MessageType.MESSAGE_TYPE_UPDATE);
		const rejected = vi.fn();
		receiver.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);

		try {
			await handleMessage(receiver, update);
			await handleMessage(receiver, update);
			expect(exactRequests(outbound, objectId, sender.networkNode.peerId)).toEqual([[parent.hash]]);

			await receiver.syncObject(objectId, sender.networkNode.peerId);
			await receiver.syncObject(objectId, sender.networkNode.peerId);
			await receiver.syncObject(objectId, sender.networkNode.peerId);
			expect(exactRequests(outbound, objectId, sender.networkNode.peerId)).toEqual([
				[parent.hash],
				[parent.hash],
				[parent.hash],
			]);
			expect(rejected).toHaveBeenCalledTimes(1);
			expect(rejected.mock.calls[0]?.[0].detail).toEqual({
				id: objectId,
				peerId: sender.networkNode.peerId,
				retries: 3,
			});
		} finally {
			receiver.removeEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
		}
	}, 20_000);

	test("arrival of the exact dependency clears it and a newly exposed ancestor owns a new request", async () => {
		const objectId = "phase-1n-b-transitive-attempt-owner";
		const receiver = await makeNode("phase-1n-b-transitive-receiver");
		const sender = await makeNode("phase-1n-b-transitive-sender");
		nodes.push(receiver, sender);
		const outbound = captureOutbound(receiver);
		await createReceiverObject(receiver, objectId);
		const { ancestor, leaf, parent } = await missingFixture(sender, objectId, 3);
		if (ancestor === undefined) throw new Error("Expected a three-deep fixture");

		await handleMessage(receiver, incompleteMessage(sender, objectId, leaf));
		expect(exactRequests(outbound, objectId, sender.networkNode.peerId)).toEqual([[parent.hash]]);

		await handleMessage(receiver, incompleteMessage(sender, objectId, parent));
		expect(exactRequests(outbound, objectId, sender.networkNode.peerId)).toEqual([[parent.hash], [ancestor.hash]]);

		await handleMessage(receiver, incompleteMessage(sender, objectId, ancestor));
		await receiver.syncObject(objectId, sender.networkNode.peerId);
		const lastSync = outbound.findLast(
			({ message, to }) =>
				to === sender.networkNode.peerId &&
				message.objectId === objectId &&
				message.type === MessageType.MESSAGE_TYPE_SYNC
		);
		expect(lastSync).toBeDefined();
		expect(requestedHashes(lastSync?.message ?? Message.create())).toEqual([]);
		expect(receiver.get<CounterDRP>(objectId)?.getVertex(ancestor.hash)).toEqual(ancestor);
	}, 20_000);

	test("attempts and cooldown are isolated by object, peer, and exact request", async () => {
		const objectA = "phase-1n-b-isolation-a";
		const objectB = "phase-1n-b-isolation-b";
		const receiver = await makeNode("phase-1n-b-isolation-receiver");
		const senderA = await makeNode("phase-1n-b-isolation-sender-a");
		const senderB = await makeNode("phase-1n-b-isolation-sender-b");
		nodes.push(receiver, senderA, senderB);
		const outbound = captureOutbound(receiver);
		await createReceiverObject(receiver, objectA);
		await createReceiverObject(receiver, objectB);
		const aFromA = await missingFixture(senderA, objectA);
		const aFromB = await missingFixture(senderB, objectA);
		const bFromA = await missingFixture(senderA, objectB);
		const rejected = vi.fn();
		receiver.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);

		try {
			await handleMessage(receiver, incompleteMessage(senderA, objectA, aFromA.leaf));
			await handleMessage(receiver, incompleteMessage(senderB, objectA, aFromB.leaf));
			await handleMessage(receiver, incompleteMessage(senderA, objectB, bFromA.leaf));

			for (let attempt = 0; attempt < 3; attempt++) {
				await receiver.syncObject(objectA, senderA.networkNode.peerId);
			}
			expect(rejected).toHaveBeenCalledTimes(1);
			expect(rejected.mock.calls[0]?.[0].detail).toMatchObject({
				id: objectA,
				peerId: senderA.networkNode.peerId,
			});

			await receiver.syncObject(objectA, senderB.networkNode.peerId);
			await receiver.syncObject(objectB, senderA.networkNode.peerId);
			expect(exactRequests(outbound, objectA, senderB.networkNode.peerId)).toEqual([
				[aFromB.parent.hash],
				[aFromB.parent.hash],
			]);
			expect(exactRequests(outbound, objectB, senderA.networkNode.peerId)).toEqual([
				[bFromA.parent.hash],
				[bFromA.parent.hash],
			]);
			expect(rejected).toHaveBeenCalledTimes(1);
		} finally {
			receiver.removeEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
		}
	}, 20_000);

	test("the real interval charges only its rotated peer, and unsubscribe and stop prevent later probes", async () => {
		const objectId = "phase-1n-b-interval-owner";
		const stoppedObjectId = "phase-1n-b-stopped-interval-owner";
		const receiver = await makeNode("phase-1n-b-interval-receiver", INTERVAL_MS);
		const senderA = await makeNode("phase-1n-b-interval-sender-a");
		const senderB = await makeNode("phase-1n-b-interval-sender-b");
		nodes.push(receiver, senderA, senderB);
		const outbound = captureOutbound(receiver);
		const groupPeers = vi.spyOn(receiver.networkNode, "getGroupPeers").mockReturnValue([]);
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.useFakeTimers();
		await createReceiverObject(receiver, objectId);
		await vi.advanceTimersByTimeAsync(0);
		const fromA = await missingFixture(senderA, objectId);
		const fromB = await missingFixture(senderB, objectId);
		await handleMessage(receiver, incompleteMessage(senderA, objectId, fromA.leaf));
		await handleMessage(receiver, incompleteMessage(senderB, objectId, fromB.leaf));
		const peers = [senderA.networkNode.peerId, senderB.networkNode.peerId].sort();
		groupPeers.mockReturnValue(peers);

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(exactRequests(outbound, objectId, peers[0])).toHaveLength(2);
		expect(exactRequests(outbound, objectId, peers[1])).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(exactRequests(outbound, objectId, peers[0])).toHaveLength(2);
		expect(exactRequests(outbound, objectId, peers[1])).toHaveLength(2);

		receiver.unsubscribeObject(objectId);
		const afterUnsubscribe = outbound.length;
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
		expect(outbound).toHaveLength(afterUnsubscribe);

		groupPeers.mockReturnValue([]);
		await createReceiverObject(receiver, stoppedObjectId);
		await vi.advanceTimersByTimeAsync(0);
		const stoppedFixture = await missingFixture(senderA, stoppedObjectId);
		await handleMessage(receiver, incompleteMessage(senderA, stoppedObjectId, stoppedFixture.leaf));
		groupPeers.mockReturnValue([senderA.networkNode.peerId]);
		const beforeStop = outbound.length;
		await receiver.stop();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
		expect(outbound).toHaveLength(beforeStop);
	}, 30_000);
});
