/**
 * Contract: while a subscribed object has no non-root history yet, the node
 * must not depend on catching a single gossipsub subscription-change event to
 * perform its first sync. Whenever at least one group peer is present, SYNC is
 * retried on a short interval (INITIAL_SYNC_RETRY_INTERVAL_MS) until the first
 * non-root vertex is merged; afterwards the fast retry stops and periodic
 * anti-entropy remains the only repair path. With no group peers, no SYNC is
 * attempted.
 */
import { createObject } from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	MessageType,
	type ResolveConflictsType,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

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

async function makeNode(seed: string): Promise<DRPNode> {
	const node = new DRPNode({
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			log_config: { level: "silent" },
		},
		keychain_config: { private_key_seed: seed },
		interval_sync_options: { interval: ANTI_ENTROPY_INTERVAL_MS },
		log_config: { level: "silent" },
	});
	await node.start();
	return node;
}

describe("initial fast sync retry", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("an unsynced object with a group peer retries SYNC each short interval and stops once history arrives", async () => {
		const creatorObject = createObject({ peerId: "initial-sync-retry-creator", drp: new CounterDRP() });
		const node = await makeNode("initial-sync-retry-joiner");
		nodes.push(node);
		const groupPeers = vi.spyOn(node.networkNode, "getGroupPeers").mockReturnValue([]);
		const sendMessage = vi.spyOn(node.networkNode, "sendMessage").mockResolvedValue();
		vi.spyOn(node.networkNode, "sendGroupMessageRandomPeer").mockResolvedValue();
		vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
		vi.useFakeTimers();

		const connecting = node.connectObject({ id: creatorObject.id, drp: new CounterDRP() });
		await vi.advanceTimersByTimeAsync(5_000);
		const object = await connecting;
		sendMessage.mockClear();

		// A group peer holding the object is connected, but no subscription-change
		// event is ever observed: the retry must fire from the interval alone.
		const peer = "16Uiu2HAm4MeUv712cWmXpvGEZ1r1741YoWvsCcmptCza43b7opdK";
		groupPeers.mockReturnValue([peer]);
		await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 3);

		const probes = sendMessage.mock.calls.filter(([, message]) => message.type === MessageType.MESSAGE_TYPE_SYNC);
		expect(probes.length).toBeGreaterThanOrEqual(2);
		for (const [to, message] of probes) {
			expect(to).toBe(peer);
			expect(message.objectId).toBe(creatorObject.id);
		}

		// Real history arrives; the object is no longer unsynced, so the fast
		// retry must stop and leave further repair to periodic anti-entropy.
		creatorObject.drp?.increment();
		await object.merge(creatorObject.vertices);
		sendMessage.mockClear();
		await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 3);

		expect(sendMessage.mock.calls.filter(([, message]) => message.type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(
			0
		);
	}, 20_000);

	test("no SYNC attempts are made while the object has no group peers", async () => {
		const creatorObject = createObject({ peerId: "initial-sync-no-peer-creator", drp: new CounterDRP() });
		const node = await makeNode("initial-sync-no-peer-joiner");
		nodes.push(node);
		vi.spyOn(node.networkNode, "getGroupPeers").mockReturnValue([]);
		const sendMessage = vi.spyOn(node.networkNode, "sendMessage").mockResolvedValue();
		vi.spyOn(node.networkNode, "sendGroupMessageRandomPeer").mockResolvedValue();
		vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
		vi.useFakeTimers();

		const connecting = node.connectObject({ id: creatorObject.id, drp: new CounterDRP() });
		await vi.advanceTimersByTimeAsync(5_000);
		await connecting;
		sendMessage.mockClear();

		await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 4);

		expect(sendMessage.mock.calls.filter(([, message]) => message.type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(
			0
		);
	}, 20_000);
});
