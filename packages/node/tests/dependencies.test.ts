import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { type Address, type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { DRPNetworkNode as DefaultDRPNetworkNode } from "@ts-drp/network";
import { RecordSigner, type SignedDrpRecordV1 } from "@ts-drp/rendezvous";
import {
	type DRPNetworkNode,
	type DRPNodeConfig,
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

	test.each([
		["publish disabled", { endpoints: ["https://registry.example/"], publish: false }],
		["no endpoints", { publish: true }],
	] as const)("keeps rendezvous inert when %s", async (_name, rendezvous) => {
		const fake = createFakeNetwork();
		const fetchImpl = vi.fn<typeof globalThis.fetch>();
		vi.stubGlobal("fetch", fetchImpl);
		const node = new DRPNode(
			{
				keychain_config: { private_key_seed: `rendezvous-inert-${_name}` },
				log_config: { level: "silent" },
				network_config: { bootstrap_peers: [], control_plane: { rendezvous } },
			} as DRPNodeConfig,
			{ networkNode: fake.networkNode, reconnect: false }
		);
		try {
			await expect(node.start()).resolves.toBeUndefined();
			expect(node.rendezvous).toBeUndefined();
			await expect(node.stop()).resolves.toBeUndefined();
			expect(fetchImpl).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	test("treats an invalid invite as inert when no other rendezvous source is configured", async () => {
		const fake = createFakeNetwork();
		const events: Array<{ readonly kind: string; readonly outcome?: string }> = [];
		const node = new DRPNode(
			{
				keychain_config: { private_key_seed: "invalid-invite-inert" },
				log_config: { level: "silent" },
				network_config: {
					bootstrap_peers: [],
					control_plane: {
						observability: { sink: (event): void => void events.push(event) },
						rendezvous: {
							invite: "not-a-valid-invite",
							namespace: `drp-network:v1:${"a".repeat(43)}`,
							publish: false,
						},
					},
				},
			} as DRPNodeConfig,
			{ networkNode: fake.networkNode, reconnect: false }
		);

		await expect(node.start()).resolves.toBeUndefined();
		expect(node.rendezvous).toBeUndefined();
		expect(events).toContainEqual({ kind: "rendezvous-invite", outcome: "failed" });
		await expect(node.stop()).resolves.toBeUndefined();
	});

	test("defaults Node rendezvous discovery to node-dialable addresses", async () => {
		const fake = createFakeNetwork();
		const record = await nodeOnlyRecord();
		const fetchImpl = vi.fn<typeof globalThis.fetch>((input) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/v1/discover")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							endpointId: path.startsWith("/first/") ? "registry-1" : "registry-2",
							records: [{ admissionMode: "invite", record }],
						}),
						{ headers: { "content-type": "application/json" }, status: 200 }
					)
				);
			}
			return Promise.resolve(
				new Response(
					JSON.stringify({
						accepted: true,
						admissionMode: "invite",
						endpointId: path.startsWith("/first/") ? "registry-1" : "registry-2",
						expiresAtMs: record.expiresAtMs,
						refreshed: false,
						sequence: record.sequence,
					}),
					{ headers: { "content-type": "application/json" }, status: 200 }
				)
			);
		});
		vi.stubGlobal("fetch", fetchImpl);
		const node = new DRPNode(
			{
				keychain_config: { private_key_seed: "rendezvous-node-target" },
				log_config: { level: "silent" },
				network_config: {
					bootstrap_peers: [],
					control_plane: {
						rollout: { public_components: { public_rendezvous: { enabled: true } } },
						rendezvous: {
							endpoints: ["https://registry.example/first/", "https://registry.example/second/"],
							namespace: record.namespace,
							publish: true,
						},
					},
				},
			} as DRPNodeConfig,
			{ networkNode: fake.networkNode, reconnect: false }
		);
		try {
			await node.start();
			expect(node.rendezvous).toBeDefined();
			if (node.rendezvous === undefined) return;
			await expect(node.rendezvous.discover(record.namespace, AbortSignal.timeout(500))).resolves.toMatchObject([
				{ acceptedAddresses: record.addresses, record: { peerId: record.peerId } },
			]);
		} finally {
			await node.stop();
			vi.unstubAllGlobals();
		}
	});
});

async function nodeOnlyRecord(): Promise<SignedDrpRecordV1> {
	const key = await generateKeyPairFromSeed("Ed25519", new Uint8Array(32).fill(91));
	const peerId = peerIdFromPublicKey(key.publicKey).toString();
	const issuedAtMs = Date.now();
	return new RecordSigner(key).sign({
		addresses: [`/ip4/93.184.216.34/tcp/4100/p2p/${peerId}`],
		capabilities: ["drp-gossipsub"],
		expiresAtMs: issuedAtMs + 60_000,
		issuedAtMs,
		namespace: `drp-network:v1:${"n".repeat(43)}`,
		sequence: 1,
	});
}
