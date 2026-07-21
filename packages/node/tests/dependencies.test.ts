import { type Address, type PeerId } from "@libp2p/interface";
import { DRPNetworkNode as DefaultDRPNetworkNode } from "@ts-drp/network";
import {
	type DRPNetworkNode,
	type GroupPeerChangeHandler,
	type IDRPIntervalReconnectBootstrap,
	IntervalRunnerState,
	Message,
	MessageType,
} from "@ts-drp/types";
import { describe, expect, test, vi } from "vitest";

import { DRPNode } from "../src/index.js";

interface FakeNetworkControls {
	groupHandlers: GroupPeerChangeHandler[];
	messageHandlers: Array<(message: Message) => Promise<void>>;
	networkNode: DRPNetworkNode;
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
}

function createFakeNetwork(): FakeNetworkControls {
	const messageHandlers: Array<(message: Message) => Promise<void>> = [];
	const groupHandlers: GroupPeerChangeHandler[] = [];
	const start = vi.fn(function (this: DRPNetworkNode): Promise<void> {
		this.peerId = "fake-peer";
		return Promise.resolve();
	});
	const stop = vi.fn(() => Promise.resolve());
	const networkNode = {
		membershipVerifier: undefined,
		peerId: "",
		start,
		stop,
		restart: vi.fn(() => Promise.resolve()),
		isDialable: vi.fn(() => Promise.resolve(false)),
		changeTopicScoreParams: vi.fn(),
		removeTopicScoreParams: vi.fn(),
		subscribe: vi.fn(),
		unsubscribe: vi.fn(),
		connectToBootstraps: vi.fn(() => Promise.resolve()),
		connect: vi.fn(() => Promise.resolve()),
		disconnect: vi.fn(() => Promise.resolve()),
		getPeerMultiaddrs: vi.fn((_peerId: PeerId | string): Promise<Address[]> => Promise.resolve([])),
		getBootstrapNodes: vi.fn((): string[] => []),
		getSubscribedTopics: vi.fn((): string[] => []),
		getMultiaddrs: vi.fn((): string[] => []),
		getAllPeers: vi.fn((): string[] => []),
		getGroupPeers: vi.fn((): string[] => []),
		broadcastMessage: vi.fn(() => Promise.resolve()),
		sendMessage: vi.fn(() => Promise.resolve()),
		sendGroupMessageRandomPeer: vi.fn(() => Promise.resolve()),
		subscribeToMessageQueue: vi.fn((handler) => {
			messageHandlers.push(handler);
		}),
		subscribeToGroupPeerChanges: vi.fn((handler) => {
			groupHandlers.push(handler);
			return (): void => {
				const index = groupHandlers.indexOf(handler);
				if (index !== -1) groupHandlers.splice(index, 1);
			};
		}),
	} satisfies DRPNetworkNode;
	return { groupHandlers, messageHandlers, networkNode, start, stop };
}

function createReconnect(networkNode: DRPNetworkNode): IDRPIntervalReconnectBootstrap & {
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
} {
	return {
		type: "interval:reconnect",
		id: "injected-reconnect",
		networkNode,
		state: IntervalRunnerState.Stopped,
		start: vi.fn(),
		stop: vi.fn(),
	};
}

describe("DRPNode dependencies", () => {
	test("uses a deterministic socket-free network and preserves it across restart", async () => {
		const fake = createFakeNetwork();
		const node = new DRPNode({ log_config: { level: "silent" } }, { networkNode: fake.networkNode, reconnect: false });
		const dispatchMessage = vi.spyOn(node, "dispatchMessage");

		expect(node.networkNode).toBe(fake.networkNode);
		await node.start();
		expect(fake.start).toHaveBeenCalledOnce();
		expect(fake.messageHandlers).toHaveLength(1);
		expect(fake.groupHandlers).toHaveLength(1);
		expect(fake.networkNode.connectToBootstraps).not.toHaveBeenCalled();
		expect(node["_intervals"].has("interval::reconnect")).toBe(false);

		const object = await node.createObject({ id: "fake-object" });
		await fake.messageHandlers[0](
			Message.create({ objectId: object.id, sender: "remote-peer", type: MessageType.MESSAGE_TYPE_CUSTOM })
		);
		expect(dispatchMessage).toHaveBeenCalledOnce();

		vi.spyOn(fake.networkNode, "getSubscribedTopics").mockReturnValue([object.id]);
		vi.spyOn(fake.networkNode, "getGroupPeers").mockReturnValue(["remote-peer"]);
		const syncObject = vi.spyOn(node, "syncObject").mockResolvedValue();
		fake.groupHandlers[0]({ peerId: "remote-peer", subscribed: true, topic: object.id });
		await vi.waitFor(() => expect(syncObject).toHaveBeenCalledWith(object.id, "remote-peer"));

		await node.restart();
		expect(node.networkNode).toBe(fake.networkNode);
		expect(fake.start).toHaveBeenCalledTimes(2);
		expect(fake.stop).toHaveBeenCalledOnce();
		expect(fake.messageHandlers).toHaveLength(1);
		expect(fake.groupHandlers).toHaveLength(1);
		expect(node["_intervals"].has("interval::reconnect")).toBe(false);

		await node.stop();
		expect(fake.stop).toHaveBeenCalledTimes(2);
	});

	test("starts, stops, and reuses an injected reconnect owner", async () => {
		const fake = createFakeNetwork();
		const reconnect = createReconnect(fake.networkNode);
		const node = new DRPNode({ log_config: { level: "silent" } }, { networkNode: fake.networkNode, reconnect });

		await node.start();
		expect(reconnect.start).toHaveBeenCalledOnce();
		await node.restart();
		expect(reconnect.stop).toHaveBeenCalledOnce();
		expect(reconnect.start).toHaveBeenCalledTimes(2);
		await node.stop();
		expect(reconnect.stop).toHaveBeenCalledTimes(2);
	});

	test("rejects reconnect ownership that targets another network", () => {
		const selected = createFakeNetwork();
		const other = createFakeNetwork();
		const reconnect = createReconnect(other.networkNode);

		expect(
			() => new DRPNode({ log_config: { level: "silent" } }, { networkNode: selected.networkNode, reconnect })
		).toThrow("Injected reconnect policy must own the injected DRP network node");
	});

	test("closes every message queue even when network shutdown rejects", async () => {
		const fake = createFakeNetwork();
		const node = new DRPNode({ log_config: { level: "silent" } }, { networkNode: fake.networkNode, reconnect: false });
		await node.start();
		const closeAll = vi.spyOn(node.messageQueueManager, "closeAll");
		fake.stop.mockRejectedValueOnce(new Error("network shutdown failed"));

		await expect(node.stop()).rejects.toThrow("network shutdown failed");
		expect(closeAll).toHaveBeenCalledOnce();
	});

	test("keeps the production network as the default", () => {
		const node = new DRPNode({ network_config: { bootstrap_peers: [] } });
		expect(node.networkNode).toBeInstanceOf(DefaultDRPNetworkNode);
	});
});
