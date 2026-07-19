/**
 * Contract: the anti-entropy service lives in packages/node/src/interval-sync.ts
 * and exports createDRPIntervalSync({ id, node, interval }). A tick selects a
 * peer from networkNode.getGroupPeers(id) and initiates the existing SYNC flow.
 * SYNC carries the full vertex-hash inventory (O(|V|)), so equal replicas may
 * exchange one SYNC probe, but the receiver must answer with no SYNC_ACCEPT and
 * therefore send no vertices/full-state traffic.
 */
import { type GossipSub } from "@libp2p/gossipsub";
import { peerIdFromString } from "@libp2p/peer-id";
import { createObject } from "@ts-drp/object";
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

import { handleMessage } from "../src/handlers.js";
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

function captureOutbound(node: DRPNode): Outbox {
	const outbox: Outbox = { direct: [], broadcast: [] };
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
		const receiverObject = await receiver.createObject({ id: objectId, drp: new CounterDRP() });
		const senderObject = await sender.createObject({ id: objectId, drp: new CounterDRP() });

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
		await handleMessage(sender, probes[0]);
		const accepts = directMessages(senderOutbox, MessageType.MESSAGE_TYPE_SYNC_ACCEPT);
		expect(accepts).toHaveLength(1);
		await handleMessage(receiver, accepts[0]);

		expect(receiverObject.drp?.value).toBe(1);
		expect(new Set(receiverObject.vertices.map(({ hash }) => hash))).toEqual(
			new Set(senderObject.vertices.map(({ hash }) => hash))
		);
	}, 20_000);

	test("createObject starts a SYNC probe and stop prevents later probes", async () => {
		const intervalMs = 1_000;
		const node = new DRPNode({
			network_config: {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
			},
			keychain_config: { private_key_seed: "anti-entropy-node-lifecycle" },
			interval_sync_options: { interval: intervalMs },
			log_config: { level: "silent" },
		});
		await node.start();
		nodes.push(node);
		const sendMessage = vi.spyOn(node.networkNode, "sendMessage").mockResolvedValue();
		vi.spyOn(node.networkNode, "getGroupPeers").mockReturnValue(["remote-peer"]);
		vi.useFakeTimers();

		await node.createObject({ id: "auto-anti-entropy-object", drp: new CounterDRP() });
		await vi.advanceTimersByTimeAsync(0);

		expect(sendMessage.mock.calls.filter(([, message]) => message.type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(
			1
		);

		await node.stop();
		await vi.advanceTimersByTimeAsync(intervalMs * 3);
		expect(sendMessage.mock.calls.filter(([, message]) => message.type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(
			1
		);
		nodes.splice(nodes.indexOf(node), 1);
	}, 20_000);

	test("a joined object derives creator genesis locally and still probes its first peer once", async () => {
		// Creator-bound id contract: the joiner derives the creator's genesis ACL
		// from the id alone, so "unsynced" can no longer mean "zero finality
		// signers" — the creator is a finality signer at genesis. The joiner is
		// unsynced because it has no non-root history yet, and must still probe
		// the first peer that appears.
		const creatorPeerId = "anti-entropy-first-peer-creator";
		const creatorObject = createObject({ peerId: creatorPeerId, drp: new CounterDRP() });
		const objectId = creatorObject.id;
		const node = await makeNode("anti-entropy-first-peer");
		nodes.push(node);
		const groupPeers = vi.spyOn(node.networkNode, "getGroupPeers").mockReturnValue([]);
		const sendMessage = vi.spyOn(node.networkNode, "sendMessage").mockResolvedValue();
		vi.useFakeTimers();

		const connecting = node.connectObject({ id: objectId, drp: new CounterDRP() });
		await vi.advanceTimersByTimeAsync(5_000);
		const object = await connecting;
		// Genesis authority exists locally before any peer answered anything.
		expect(object.acl.query_isFinalitySigner(creatorPeerId)).toBe(true);
		expect(sendMessage).not.toHaveBeenCalled();

		const firstPeer = node.networkNode.peerId;
		groupPeers.mockReturnValue([firstPeer]);
		const pubsub = node.networkNode["_pubsub"] as GossipSub;
		pubsub.safeDispatchEvent("subscription-change", {
			detail: {
				peerId: peerIdFromString(firstPeer),
				subscriptions: [{ topic: objectId, subscribe: true }],
			},
		});
		await vi.advanceTimersByTimeAsync(0);

		const initialSyncs = sendMessage.mock.calls.filter(([, message]) => message.type === MessageType.MESSAGE_TYPE_SYNC);
		expect(initialSyncs).toHaveLength(1);
		expect(initialSyncs[0]?.[0]).toBe(firstPeer);
		expect(initialSyncs[0]?.[1].objectId).toBe(objectId);

		// Once real history has been merged the object is synced; later peers are
		// left to periodic anti-entropy instead of an immediate probe.
		creatorObject.drp?.increment();
		await object.merge(creatorObject.vertices);
		const secondPeer = "16Uiu2HAm4MeUv712cWmXpvGEZ1r1741YoWvsCcmptCza43b7opdK";
		groupPeers.mockReturnValue([firstPeer, secondPeer]);
		pubsub.safeDispatchEvent("subscription-change", {
			detail: {
				peerId: peerIdFromString(secondPeer),
				subscriptions: [{ topic: objectId, subscribe: true }],
			},
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(sendMessage.mock.calls.filter(([, message]) => message.type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(
			1
		);
	}, 20_000);

	test("unsubscribeObject stops and deletes both per-object intervals", async () => {
		const node = await makeNode("anti-entropy-unsubscribe");
		nodes.push(node);
		await node.createObject({ id: "unsubscribe-interval-object", drp: new CounterDRP() });

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

	test("matching inventories answer a tick probe with no SYNC_ACCEPT traffic", async () => {
		const objectId = "anti-entropy-equal-frontier-object";
		const intervalMs = 1_000;
		const nodeA = await makeNode("anti-entropy-equal-A");
		const nodeB = await makeNode("anti-entropy-equal-B");
		nodes.push(nodeA, nodeB);
		const outA = captureOutbound(nodeA);
		const outB = captureOutbound(nodeB);
		await nodeA.createObject({ id: objectId, drp: new CounterDRP() });
		await nodeB.createObject({ id: objectId, drp: new CounterDRP() });

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
		await handleMessage(nodeB, probes[0]);
		expect(directMessages(outB, MessageType.MESSAGE_TYPE_SYNC_ACCEPT)).toHaveLength(0);
	}, 20_000);
});
