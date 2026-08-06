/**
 * Contract: the anti-entropy service lives in packages/node/src/interval-sync.ts
 * and exports createDRPIntervalSync({ id, node, interval }). A tick selects a
 * peer from networkNode.getGroupPeers(id) and sends a negotiated SYNC probe.
 * This fixture selects heads-chunk, so equal replicas may exchange one bounded
 * probe, but the receiver must answer with no SYNC_ACCEPT and therefore send no
 * vertices/full-state traffic.
 */
import { peerIdFromString } from "@libp2p/peer-id";
import { DRP_HEADS_CHUNK_PROTOCOL, type NegotiatedSyncSender, type SelectedSyncProtocol } from "@ts-drp/network";
import { createACL, createPermissionlessACL } from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	type Message,
	MessageType,
	type ResolveConflictsType,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { gossipSubOf } from "./default-network.js";
import { handleMessage, signGeneratedVertices } from "../src/handlers.js";
import { createDRPIntervalSync, DRPNode } from "../src/index.js";

class CounterDRP implements IDRP {
	semanticsType: SemanticsType = SemanticsType.pair;
	value = 0;

	increment(): void {
		this.value += 1;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

interface Outbox {
	direct: { to: string; message: Message }[];
	broadcast: { topic: string; message: Message }[];
}

interface TestIntervalSync {
	start(): void;
	stop(): void;
}

const HEADS_SELECTION = Object.freeze({
	mode: "heads-chunk",
	protocol: DRP_HEADS_CHUNK_PROTOCOL,
} satisfies SelectedSyncProtocol);

const outboundByNode = new WeakMap<DRPNode, Outbox>();

function syncSender(node: () => DRPNode): NegotiatedSyncSender {
	function outbound(): Outbox {
		const capture = outboundByNode.get(node());
		if (capture === undefined) throw new Error("Expected outbound capture");
		return capture;
	}
	return {
		async sendSyncMessage(to, payloadFactory): Promise<void> {
			const message = await payloadFactory(HEADS_SELECTION);
			outbound().direct.push({ message, to });
		},
		sendSyncResponseMessage(to, message): Promise<void> {
			outbound().direct.push({ message, to });
			return Promise.resolve();
		},
	};
}

function captureOutbound(node: DRPNode): Outbox {
	const outbox: Outbox = { direct: [], broadcast: [] };
	outboundByNode.set(node, outbox);
	vi.spyOn(node.networkNode, "sendMessage").mockImplementation((to: string, message: Message) => {
		outbox.direct.push({ to, message });
		return Promise.resolve();
	});
	vi.spyOn(node.networkNode, "broadcastMessage").mockImplementation((topic: string, message: Message) => {
		outbox.broadcast.push({ topic, message });
		return Promise.resolve();
	});
	return outbox;
}

function directMessages(outbox: Outbox, type: MessageType): Message[] {
	return outbox.direct.filter(({ message }) => message.type === type).map(({ message }) => message);
}

async function makeNode(seed: string): Promise<DRPNode> {
	const node: DRPNode = new DRPNode(
		{
			network_config: {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
			},
			keychain_config: { private_key_seed: seed },
			log_config: { level: "silent" },
		},
		{ syncSender: syncSender(() => node) }
	);
	await node.start();
	return node;
}

describe("periodic anti-entropy", () => {
	const nodes: DRPNode[] = [];
	const intervals: TestIntervalSync[] = [];

	afterEach(async () => {
		for (const interval of intervals.splice(0)) interval.stop();
		vi.useRealTimers();
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("a tick heals a dropped final UPDATE while connected nodes are idle", async () => {
		const objectId = "anti-entropy-dropped-update-object";
		const intervalMs = 1_000;
		const receiver = await makeNode("anti-entropy-receiver");
		const sender = await makeNode("anti-entropy-sender");
		nodes.push(receiver, sender);
		const receiverOutbox = captureOutbound(receiver);
		const senderOutbox = captureOutbound(sender);
		const receiverObject = await receiver.createObject({
			id: objectId,
			drp: new CounterDRP(),
			acl: createPermissionlessACL(),
		});
		const senderObject = await sender.createObject({
			id: objectId,
			drp: new CounterDRP(),
			acl: createPermissionlessACL(),
		});

		// Gossip is suppressed by the broadcast spies: this UPDATE is intentionally dropped.
		senderObject.drp?.increment();
		await vi.waitFor(() =>
			expect(senderOutbox.broadcast.some(({ message }) => message.type === MessageType.MESSAGE_TYPE_UPDATE)).toBe(true)
		);
		expect(receiverObject.drp?.value).toBe(0);
		expect(senderObject.drp?.value).toBe(1);

		const groupPeers = vi.spyOn(receiver.networkNode, "getGroupPeers").mockReturnValue([]);
		vi.useFakeTimers();
		const interval = createDRPIntervalSync({ id: objectId, node: receiver, interval: intervalMs });
		intervals.push(interval);
		interval.start();
		await vi.advanceTimersByTimeAsync(0); // initial empty-peer run
		groupPeers.mockReturnValue([sender.networkNode.peerId]);
		await vi.advanceTimersByTimeAsync(intervalMs);

		const probes = directMessages(receiverOutbox, MessageType.MESSAGE_TYPE_SYNC);
		expect(probes).toHaveLength(1);
		await handleMessage(sender, probes[0], HEADS_SELECTION);
		const accepts = directMessages(senderOutbox, MessageType.MESSAGE_TYPE_SYNC_ACCEPT);
		expect(accepts).toHaveLength(1);
		await handleMessage(receiver, accepts[0], HEADS_SELECTION);

		expect(receiverObject.drp?.value).toBe(1);
		expect(new Set(receiverObject.vertices.map(({ hash }) => hash))).toEqual(
			new Set(senderObject.vertices.map(({ hash }) => hash))
		);
	}, 20_000);

	test("createObject starts a SYNC probe and stop prevents later probes", async () => {
		const intervalMs = 1_000;
		const node: DRPNode = new DRPNode(
			{
				network_config: {
					bootstrap_peers: [],
					listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
					log_config: { level: "silent" },
				},
				keychain_config: { private_key_seed: "anti-entropy-node-lifecycle" },
				interval_sync_options: { interval: intervalMs },
				log_config: { level: "silent" },
			},
			{ syncSender: syncSender(() => node) }
		);
		await node.start();
		nodes.push(node);
		const outbox = captureOutbound(node);
		vi.spyOn(node.networkNode, "getGroupPeers").mockReturnValue(["remote-peer"]);
		vi.useFakeTimers();

		await node.createObject({
			id: "auto-anti-entropy-object",
			drp: new CounterDRP(),
			acl: createPermissionlessACL(),
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(directMessages(outbox, MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(1);

		await node.stop();
		await vi.advanceTimersByTimeAsync(intervalMs * 3);
		expect(directMessages(outbox, MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(1);
		nodes.splice(nodes.indexOf(node), 1);
	}, 20_000);

	test("a joined object derives creator genesis locally and still probes its first peer once", async () => {
		// Creator-bound id contract: the joiner derives the creator's genesis ACL
		// from the id alone, so "unsynced" can no longer mean "zero finality
		// signers" — the creator is a finality signer at genesis. The joiner is
		// unsynced because it has no remotely authored history yet, and must
		// still probe the first peer that appears.
		const creator = await makeNode("anti-entropy-first-peer-creator");
		const node = await makeNode("anti-entropy-first-peer");
		nodes.push(creator, node);
		const creatorPeerId = creator.networkNode.peerId;
		const sharedACL = (): ReturnType<typeof createACL> => {
			const acl = createACL({ admins: [creatorPeerId, node.networkNode.peerId] });
			for (const replica of [creator, node]) {
				acl.context = { caller: replica.networkNode.peerId };
				acl.setKey(replica.keychain.blsPublicKey);
			}
			acl.context = { caller: "" };
			return acl;
		};
		const creatorObject = await creator.createObject({
			acl: sharedACL(),
			drp: new CounterDRP(),
		});
		const objectId = creatorObject.id;
		const groupPeers = vi.spyOn(node.networkNode, "getGroupPeers").mockReturnValue([]);
		const outbox = captureOutbound(node);
		const sendMessage = vi.mocked(node.networkNode.sendMessage);
		vi.useFakeTimers();

		const connecting = node.connectObject({
			acl: sharedACL(),
			id: objectId,
			drp: new CounterDRP(),
		});
		await vi.advanceTimersByTimeAsync(5_000);
		const object = await connecting;
		// Genesis authority exists locally before any peer answered anything.
		expect(object.acl.query_isFinalitySigner(creatorPeerId)).toBe(true);
		expect(sendMessage).not.toHaveBeenCalled();
		expect(outbox.direct).toHaveLength(0);

		// Local history does not prove that synchronization reached a peer and
		// must not suppress the immediate probe when the first peer appears.
		object.drp?.increment();
		const firstPeer = node.networkNode.peerId;
		groupPeers.mockReturnValue([firstPeer]);
		const pubsub = gossipSubOf(node.networkNode);
		pubsub.safeDispatchEvent("subscription-change", {
			detail: {
				peerId: peerIdFromString(firstPeer),
				subscriptions: [{ topic: objectId, subscribe: true }],
			},
		});
		await vi.advanceTimersByTimeAsync(0);

		const initialSyncs = outbox.direct.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC);
		expect(initialSyncs).toHaveLength(1);
		expect(initialSyncs[0]?.to).toBe(firstPeer);
		expect(initialSyncs[0]?.message.objectId).toBe(objectId);

		// Once real history has been merged the object is synced; later peers are
		// left to periodic anti-entropy instead of an immediate probe.
		creatorObject.drp?.increment();
		await signGeneratedVertices(creator, creatorObject.vertices);
		await expect(object.merge(creatorObject.vertices)).resolves.toEqual([true, [], []]);
		const secondPeer = "16Uiu2HAm4MeUv712cWmXpvGEZ1r1741YoWvsCcmptCza43b7opdK";
		groupPeers.mockReturnValue([firstPeer, secondPeer]);
		pubsub.safeDispatchEvent("subscription-change", {
			detail: {
				peerId: peerIdFromString(secondPeer),
				subscriptions: [{ topic: objectId, subscribe: true }],
			},
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(directMessages(outbox, MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(1);
	}, 20_000);

	test("unsubscribeObject stops and deletes both per-object intervals", async () => {
		const node = await makeNode("anti-entropy-unsubscribe");
		nodes.push(node);
		await node.createObject({
			id: "unsubscribe-interval-object",
			drp: new CounterDRP(),
			acl: createPermissionlessACL(),
		});

		const intervals = node["_intervals"];
		expect([...intervals.keys()].filter((key) => key.endsWith("::unsubscribe-interval-object"))).toHaveLength(2);

		node.unsubscribeObject("unsubscribe-interval-object");

		expect([...intervals.keys()].filter((key) => key.endsWith("::unsubscribe-interval-object"))).toHaveLength(0);
	});

	test("a failed probe is logged and the next tick still sends SYNC", async () => {
		const intervalMs = 1_000;
		const node = await makeNode("anti-entropy-probe-retry");
		nodes.push(node);
		vi.spyOn(node.networkNode, "getGroupPeers").mockReturnValue(["remote-peer"]);
		const syncObject = vi
			.spyOn(node, "syncObject")
			.mockRejectedValueOnce(new Error("transient probe failure"))
			.mockResolvedValue();
		vi.useFakeTimers();
		const interval = createDRPIntervalSync({ id: "probe-retry-object", node, interval: intervalMs });
		intervals.push(interval);

		interval.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(intervalMs);

		expect(syncObject).toHaveBeenCalledTimes(2);
	});

	test("rotates through every peer in a stable membership set before repeating", async () => {
		const intervalMs = 1_000;
		const node = await makeNode("anti-entropy-peer-rotation");
		nodes.push(node);
		vi.spyOn(node.networkNode, "getGroupPeers").mockReturnValue(["peer-c", "peer-a", "peer-b"]);
		vi.spyOn(Math, "random").mockReturnValue(0.9);
		const syncObject = vi.spyOn(node, "syncObject").mockResolvedValue();
		vi.useFakeTimers();
		const interval = createDRPIntervalSync({ id: "peer-rotation-object", node, interval: intervalMs });
		intervals.push(interval);

		interval.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(intervalMs * 3);

		expect(syncObject.mock.calls.map(([, peer]) => peer)).toEqual(["peer-c", "peer-a", "peer-b", "peer-c"]);
	});

	test("the default cadence completes a five-node peer cycle in 30 seconds", async () => {
		const node = await makeNode("anti-entropy-default-peer-cycle");
		nodes.push(node);
		vi.spyOn(node.networkNode, "getGroupPeers").mockReturnValue(["peer-d", "peer-b", "peer-a", "peer-c"]);
		vi.spyOn(Math, "random").mockReturnValue(0);
		const syncObject = vi.spyOn(node, "syncObject").mockResolvedValue();
		vi.useFakeTimers();
		const interval = createDRPIntervalSync({ id: "default-peer-cycle-object", node });
		intervals.push(interval);

		expect(interval.interval).toBe(10_000);
		interval.start();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(syncObject.mock.calls.map(([, peer]) => peer)).toEqual(["peer-a", "peer-b", "peer-c", "peer-d"]);
	});

	test("matching inventories answer a tick probe with no SYNC_ACCEPT traffic", async () => {
		const objectId = "anti-entropy-equal-frontier-object";
		const intervalMs = 1_000;
		const nodeA = await makeNode("anti-entropy-equal-A");
		const nodeB = await makeNode("anti-entropy-equal-B");
		nodes.push(nodeA, nodeB);
		const outA = captureOutbound(nodeA);
		const outB = captureOutbound(nodeB);
		await nodeA.createObject({ id: objectId, drp: new CounterDRP(), acl: createPermissionlessACL() });
		await nodeB.createObject({ id: objectId, drp: new CounterDRP(), acl: createPermissionlessACL() });

		const groupPeers = vi.spyOn(nodeA.networkNode, "getGroupPeers").mockReturnValue([]);
		vi.useFakeTimers();
		const interval = createDRPIntervalSync({ id: objectId, node: nodeA, interval: intervalMs });
		intervals.push(interval);
		interval.start();
		await vi.advanceTimersByTimeAsync(0);
		groupPeers.mockReturnValue([nodeB.networkNode.peerId]);
		await vi.advanceTimersByTimeAsync(intervalMs);

		const probes = directMessages(outA, MessageType.MESSAGE_TYPE_SYNC);
		expect(probes).toHaveLength(1);
		await handleMessage(nodeB, probes[0], HEADS_SELECTION);
		expect(directMessages(outB, MessageType.MESSAGE_TYPE_SYNC_ACCEPT)).toHaveLength(0);
	}, 20_000);
});
