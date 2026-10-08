import { type GossipSub } from "@libp2p/gossipsub";
import { type PeerId } from "@libp2p/interface";
import { Message, MessageType } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DRPNetworkNode } from "../src/node.js";

interface MeshAwareGossipSub extends GossipSub {
	readonly mesh: Map<string, Set<string>>;
}

type MeshAwareNetworkNode = DRPNetworkNode & {
	getGroupPeers(group: string, view?: "mesh"): string[];
};

const config = {
	bootstrap_peers: [],
	listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
	log_config: { level: "silent" as const },
};

const quietHostPolicy = {
	bootstrapDiscovery: false,
	coldStartPubsubDiscovery: false,
	gossipSubPeerExchange: false,
};

function makeNode(seed = false): DRPNetworkNode {
	return new DRPNetworkNode({ ...config, ...(seed ? { seed: true } : {}) }, { hostPolicy: quietHostPolicy });
}

function pubsub(node: DRPNetworkNode): MeshAwareGossipSub {
	const service = node["_pubsub"] as MeshAwareGossipSub | undefined;
	if (service === undefined) throw new Error("expected a started GossipSub service");
	return service;
}

function meshPeers(node: DRPNetworkNode, topic: string): string[] {
	return (node as MeshAwareNetworkNode).getGroupPeers(topic, "mesh");
}

function dependencyMeshPeers(node: DRPNetworkNode, topic: string): string[] {
	return [...(pubsub(node).mesh.get(topic) ?? new Set<string>())];
}

function fakePeer(id: string): PeerId {
	return { toString: (): string => id } as PeerId;
}

function message(objectId: string, sender: string): Message {
	return Message.create({ objectId, sender, type: MessageType.MESSAGE_TYPE_CUSTOM });
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

describe("Track T2 mesh-bound implicit room partners", () => {
	const running: DRPNetworkNode[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled(running.splice(0).map((node) => node.stop()));
	});

	test("keeps subscriber evidence at 100 while every implicit random send stays inside the exact six-peer mesh", async () => {
		const node = makeNode();
		running.push(node);
		await node.start();
		const topic = "track-t2-controlled-mesh";
		const subscribers = Array.from({ length: 100 }, (_, index) => `subscriber-${index.toString().padStart(3, "0")}`);
		const mesh = subscribers.slice(37, 43);
		const service = pubsub(node);
		vi.spyOn(service, "getSubscribers").mockReturnValue(subscribers.map(fakePeer));
		service.mesh.set(topic, new Set(mesh));

		expect(node.getGroupPeers(topic)).toEqual(subscribers);
		expect(meshPeers(node, topic)).toEqual(mesh);

		const dial = vi.spyOn(node, "safeDial").mockResolvedValue(undefined);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		await node.sendGroupMessageRandomPeer(topic, message(topic, node.peerId));
		const selected = dial.mock.calls[0]?.[0];
		expect(selected).toBeDefined();
		expect(mesh).toContain(selected?.toString());

		service.mesh.set(topic, new Set());
		dial.mockClear();
		await node.sendGroupMessageRandomPeer(topic, message(topic, node.peerId));
		expect(dial).not.toHaveBeenCalled();
	});

	test("reads a genuine live GossipSub mesh and removes a disconnected peer without fallback", async () => {
		const hub = makeNode();
		const peers = Array.from({ length: 14 }, () => makeNode());
		running.push(hub, ...peers);
		await Promise.all(running.map((node) => node.start()));
		await Promise.all(peers.map((peer) => hub.connect(peer.getMultiaddrs())));
		const topic = "track-t2-genuine-mesh";
		for (const node of running) node.subscribe(topic);

		await waitFor(() => hub.getGroupPeers(topic).length === peers.length, "all genuine subscribers");
		await waitFor(() => {
			const subscribers = hub.getGroupPeers(topic);
			const mesh = dependencyMeshPeers(hub, topic);
			return mesh.length > 0 && mesh.length < subscribers.length;
		}, "a bounded genuine GossipSub mesh");
		const subscribers = hub.getGroupPeers(topic);
		const observed = dependencyMeshPeers(hub, topic);
		expect(meshPeers(hub, topic)).toEqual(observed);
		const nonMeshPeer = subscribers.find((peerId) => !observed.includes(peerId));
		if (nonMeshPeer === undefined) throw new Error("expected one genuine subscriber outside the mesh");
		const dial = vi.spyOn(hub, "safeDial").mockResolvedValue(undefined);
		const random = vi
			.spyOn(Math, "random")
			.mockReturnValue((subscribers.indexOf(nonMeshPeer) + 0.1) / subscribers.length);
		await hub.sendGroupMessageRandomPeer(topic, message(topic, hub.peerId));
		const selectedBeforeDisconnect = dial.mock.calls[0]?.[0];
		expect(selectedBeforeDisconnect).toBeDefined();
		expect(observed).toContain(selectedBeforeDisconnect?.toString());

		const departingPeerId = observed[0];
		const departingPeer = peers.find((peer) => peer.peerId === departingPeerId);
		if (departingPeerId === undefined || departingPeer === undefined) {
			throw new Error("expected one observed mesh member to disconnect");
		}
		await hub.disconnect(departingPeerId);
		await waitFor(() => !hub.getGroupPeers(topic).includes(departingPeerId), "disconnected subscriber removal");
		await waitFor(() => !dependencyMeshPeers(hub, topic).includes(departingPeerId), "disconnected mesh removal");
		await waitFor(() => {
			const currentSubscribers = hub.getGroupPeers(topic);
			const currentMesh = dependencyMeshPeers(hub, topic);
			return currentMesh.length > 0 && currentMesh.length < currentSubscribers.length;
		}, "a bounded mesh after disconnect");
		const subscribersAfterDisconnect = hub.getGroupPeers(topic);
		const afterFirstDisconnect = dependencyMeshPeers(hub, topic);
		expect(meshPeers(hub, topic)).toEqual(afterFirstDisconnect);
		const nonMeshPeerAfterDisconnect = subscribersAfterDisconnect.find(
			(peerId) => !afterFirstDisconnect.includes(peerId)
		);
		if (nonMeshPeerAfterDisconnect === undefined) throw new Error("expected one post-disconnect non-mesh subscriber");
		dial.mockClear();
		random.mockReturnValue(
			(subscribersAfterDisconnect.indexOf(nonMeshPeerAfterDisconnect) + 0.1) / subscribersAfterDisconnect.length
		);
		await hub.sendGroupMessageRandomPeer(topic, message(topic, hub.peerId));
		const selectedAfterDisconnect = dial.mock.calls[0]?.[0];
		expect(selectedAfterDisconnect).toBeDefined();
		expect(afterFirstDisconnect).toContain(selectedAfterDisconnect?.toString());
		expect(selectedAfterDisconnect?.toString()).not.toBe(departingPeerId);

		await Promise.all(peers.filter((peer) => peer !== departingPeer).map((peer) => hub.disconnect(peer.peerId)));
		await waitFor(() => hub.getGroupPeers(topic).length === 0, "empty subscriber evidence");
		await waitFor(() => dependencyMeshPeers(hub, topic).length === 0, "empty mesh evidence");
		expect(meshPeers(hub, topic)).toEqual([]);
		dial.mockClear();
		await hub.sendGroupMessageRandomPeer(topic, message(topic, hub.peerId));
		expect(dial).not.toHaveBeenCalled();
	}, 45_000);

	test("a forward-only seed has subscribers but no implicit mesh target or dial", async () => {
		const seed = makeNode(true);
		const peer = makeNode();
		running.push(seed, peer);
		await Promise.all(running.map((node) => node.start()));
		await peer.connect(seed.getMultiaddrs());
		const topic = "track-t2-forward-only-seed";
		seed.subscribe(topic);
		peer.subscribe(topic);
		await waitFor(() => seed.getGroupPeers(topic).includes(peer.peerId), "seed subscriber evidence");

		expect(meshPeers(seed, topic)).toEqual([]);
		const dial = vi.spyOn(seed, "safeDial").mockResolvedValue(undefined);
		await seed.sendGroupMessageRandomPeer(topic, message(topic, seed.peerId));
		expect(dial).not.toHaveBeenCalled();
	}, 30_000);
});
