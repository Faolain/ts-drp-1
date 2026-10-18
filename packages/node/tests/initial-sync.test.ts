/**
 * Contract: while a subscribed object has no remotely authored history yet,
 * the node
 * must not depend on catching a single gossipsub subscription-change event to
 * perform its first sync. Whenever at least one group peer is present, SYNC is
 * retried on a short interval (INITIAL_SYNC_RETRY_INTERVAL_MS) until remote
 * history is merged or a bounded retry budget is exhausted; afterwards
 * periodic anti-entropy remains the repair path. With no group peers, no SYNC
 * is attempted.
 */
import { DRP_HEADS_CHUNK_PROTOCOL, type NegotiatedSyncSender, type SelectedSyncProtocol } from "@ts-drp/network";
import { createACL, createObject } from "@ts-drp/object";
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

import { signGeneratedVertices } from "../src/handlers.js";
import { DRPNode, INITIAL_SYNC_RETRY_INTERVAL_MS } from "../src/index.js";

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

// Anti-entropy is configured far outside the test window so every observed
// SYNC below is attributable to the fast initial-sync retry alone.
const ANTI_ENTROPY_INTERVAL_MS = 60_000;

interface Outbound {
	message: Message;
	to: string;
}

const HEADS_SELECTION = Object.freeze({
	mode: "heads-chunk",
	protocol: DRP_HEADS_CHUNK_PROTOCOL,
} satisfies SelectedSyncProtocol);

const outboundByNode = new WeakMap<DRPNode, Outbound[]>();

function syncSender(node: () => DRPNode): NegotiatedSyncSender {
	function outbound(): Outbound[] {
		const capture = outboundByNode.get(node());
		if (capture === undefined) throw new Error("Expected outbound capture");
		return capture;
	}
	return {
		async sendSyncMessage(to, payloadFactory): Promise<void> {
			const message = await payloadFactory(HEADS_SELECTION);
			outbound().push({ message, to });
		},
		sendSyncResponseMessage(to, message): Promise<void> {
			outbound().push({ message, to });
			return Promise.resolve();
		},
	};
}

function captureOutbound(node: DRPNode): Outbound[] {
	const outbound: Outbound[] = [];
	outboundByNode.set(node, outbound);
	return outbound;
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
			interval_sync_options: { interval: ANTI_ENTROPY_INTERVAL_MS },
			log_config: { level: "silent" },
		},
		{ syncSender: syncSender(() => node) }
	);
	await node.start();
	return node;
}

function coordinatedACL(creator: DRPNode, joiner: DRPNode): ReturnType<typeof createACL> {
	const replicas = [creator, joiner];
	const acl = createACL({ admins: replicas.map((replica) => replica.networkNode.peerId) });
	for (const replica of replicas) {
		acl.context = { caller: replica.networkNode.peerId };
		acl.setKey(replica.keychain.blsPublicKey);
	}
	acl.context = { caller: "" };
	return acl;
}

describe("initial fast sync retry", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("an unsynced object with a group peer retries SYNC each short interval and stops once history arrives", async () => {
		const creator = await makeNode("initial-sync-retry-creator");
		const node = await makeNode("initial-sync-retry-joiner");
		nodes.push(creator, node);
		const creatorObject = await creator.createObject({
			acl: coordinatedACL(creator, node),
			drp: new CounterDRP(),
		});
		const groupPeers = vi.spyOn(node.networkNode, "getGroupPeers").mockReturnValue([]);
		const outbound = captureOutbound(node);
		vi.spyOn(node.networkNode, "sendGroupMessageRandomPeer").mockResolvedValue();
		vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
		vi.useFakeTimers();

		const connecting = node.connectObject({
			acl: coordinatedACL(creator, node),
			id: creatorObject.id,
			drp: new CounterDRP(),
		});
		await vi.advanceTimersByTimeAsync(5_000);
		const object = await connecting;
		outbound.length = 0;

		// A local operation after connect() returns must not masquerade as
		// remotely synchronized history and stop the fast retry.
		object.drp?.increment();

		// A group peer holding the object is connected, but no subscription-change
		// event is ever observed: the retry must fire from the interval alone.
		const peer = "16Uiu2HAm4MeUv712cWmXpvGEZ1r1741YoWvsCcmptCza43b7opdK";
		groupPeers.mockReturnValue([peer]);
		await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 3);

		const probes = outbound.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC);
		expect(probes.length).toBeGreaterThanOrEqual(2);
		for (const { to, message } of probes) {
			expect(to).toBe(peer);
			expect(message.objectId).toBe(creatorObject.id);
		}

		// Remote history arrives; the object is no longer unsynced, so the fast
		// retry must stop and leave further repair to periodic anti-entropy.
		creatorObject.drp?.increment();
		await signGeneratedVertices(creator, creatorObject.vertices);
		await expect(object.merge(creatorObject.vertices)).resolves.toEqual([true, [], []]);
		outbound.length = 0;
		await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 3);

		expect(outbound.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(0);
	}, 20_000);

	test("an empty remote object exhausts the fast retry budget instead of probing forever", async () => {
		const creator = await makeNode("initial-sync-empty-creator");
		const node = await makeNode("initial-sync-empty-joiner");
		nodes.push(creator, node);
		const creatorObject = await creator.createObject({
			acl: coordinatedACL(creator, node),
			drp: new CounterDRP(),
		});
		const peer = "16Uiu2HAm4MeUv712cWmXpvGEZ1r1741YoWvsCcmptCza43b7opdK";
		const groupPeers = vi.spyOn(node.networkNode, "getGroupPeers").mockReturnValue([]);
		const outbound = captureOutbound(node);
		vi.spyOn(node.networkNode, "sendGroupMessageRandomPeer").mockResolvedValue();
		vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
		vi.useFakeTimers();

		const connecting = node.connectObject({
			acl: coordinatedACL(creator, node),
			id: creatorObject.id,
			drp: new CounterDRP(),
		});
		await vi.advanceTimersByTimeAsync(5_000);
		const object = await connecting;
		outbound.length = 0;

		object.drp?.increment();
		groupPeers.mockReturnValue([peer]);
		await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 10);

		const attemptsAfterBudget = outbound.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC).length;
		expect(attemptsAfterBudget).toBe(5);

		await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 5);
		expect(outbound.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(
			attemptsAfterBudget
		);

		// Capping the fast path must not stop the independent periodic repair path.
		await vi.advanceTimersByTimeAsync(ANTI_ENTROPY_INTERVAL_MS);
		expect(outbound.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(
			attemptsAfterBudget + 1
		);
	}, 20_000);

	test("no SYNC attempts are made while the object has no group peers", async () => {
		const creatorObject = createObject({ peerId: "initial-sync-no-peer-creator", drp: new CounterDRP() });
		const node = await makeNode("initial-sync-no-peer-joiner");
		nodes.push(node);
		vi.spyOn(node.networkNode, "getGroupPeers").mockReturnValue([]);
		const outbound = captureOutbound(node);
		vi.spyOn(node.networkNode, "sendGroupMessageRandomPeer").mockResolvedValue();
		vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
		vi.useFakeTimers();

		const connecting = node.connectObject({ id: creatorObject.id, drp: new CounterDRP() });
		await vi.advanceTimersByTimeAsync(5_000);
		await connecting;
		outbound.length = 0;

		await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 4);

		expect(outbound.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(0);
	}, 20_000);
});
