import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import {
	type Connection,
	type ConnectionGater,
	type Libp2p,
	type MultiaddrConnection,
	type PeerId,
	type Stream,
} from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { type DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	DRP_MESSAGE_PROTOCOL,
	type DRPNetworkHostConfigSnapshot,
	type DRPNetworkHostFactory,
	DRPNetworkNode,
} from "../src/node.js";

interface ConnectionBudget {
	readonly maxConnections: number;
	readonly maxParallelDials: number;
	readonly role: "browser" | "node" | "relay" | "worker";
}

interface ConnectionBudgetModule {
	resolveConnectionBudget(
		input: Readonly<{
			configured?: Readonly<{ max_connections: number; max_parallel_dials: number }>;
			relayServiceEnabled: boolean;
			runtime: "browser" | "node" | "worker";
		}>
	): ConnectionBudget;
}

type BudgetSnapshot = DRPNetworkHostConfigSnapshot & {
	readonly connectionBudget: ConnectionBudget;
};

type InspectableHost = Libp2p & {
	components: {
		connectionGater: ConnectionGater;
		connectionManager: {
			readonly dialQueue: { readonly queue: { readonly concurrency: number } };
			getMaxConnections(): number;
		};
	};
};

const baseConfig = {
	bootstrap_peers: [],
	listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
	log_config: { level: "silent" as const },
};

const quietHostPolicy = {
	bootstrapDiscovery: false,
	coldStartPubsubDiscovery: false,
	gossipSubPeerExchange: false,
};

function withBudget(
	maxConnections: number,
	maxParallelDials: number,
	config: DRPNetworkNodeConfig = baseConfig
): DRPNetworkNodeConfig {
	return {
		...config,
		connection_budget: {
			max_connections: maxConnections,
			max_parallel_dials: maxParallelDials,
		},
	} as DRPNetworkNodeConfig;
}

function peer(index: number): PeerId {
	return peerIdFromPublicKey(
		privateKeyFromRaw(Uint8Array.from({ length: 32 }, (_, byte) => (byte + index + 1) % 256)).publicKey
	);
}

function connection(index: number): MultiaddrConnection {
	return {
		remoteAddr: multiaddr(`/ip4/127.0.0.1/tcp/${40_000 + index}`),
	} as MultiaddrConnection;
}

function websocketAddress(node: DRPNetworkNode): string {
	const address = node.getMultiaddrs()?.find((candidate) => candidate.includes("/ws/p2p/"));
	if (address === undefined) throw new Error("expected a WebSocket listen address");
	return address;
}

function liveConnections(node: DRPNetworkNode): Connection[] {
	return node["_node"]?.getConnections() ?? [];
}

function livePeerIds(node: DRPNetworkNode): string[] {
	return liveConnections(node).map(({ remotePeer }) => remotePeer.toString());
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function loadBudgetOwner(): Promise<ConnectionBudgetModule> {
	const modulePath = ["..", "src", "connection-budget.js"].join("/");
	return (await import(modulePath)) as ConnectionBudgetModule;
}

describe("Track T1 hard connection admission", () => {
	const running: DRPNetworkNode[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await Promise.allSettled(
			running.splice(0).map(async (node) => {
				if (node["_node"]?.status !== "stopped") await node.stop();
			})
		);
	});

	test("resolves closed browser, worker, node, relay and reduction profiles from one owner", async () => {
		const { resolveConnectionBudget } = await loadBudgetOwner();

		expect(resolveConnectionBudget({ relayServiceEnabled: false, runtime: "browser" })).toEqual({
			maxConnections: 48,
			maxParallelDials: 6,
			role: "browser",
		});
		expect(resolveConnectionBudget({ relayServiceEnabled: false, runtime: "worker" })).toEqual({
			maxConnections: 48,
			maxParallelDials: 6,
			role: "worker",
		});
		expect(resolveConnectionBudget({ relayServiceEnabled: false, runtime: "node" })).toEqual({
			maxConnections: 300,
			maxParallelDials: 100,
			role: "node",
		});
		expect(resolveConnectionBudget({ relayServiceEnabled: true, runtime: "node" })).toEqual({
			maxConnections: 2_000,
			maxParallelDials: 32,
			role: "relay",
		});
		expect(
			resolveConnectionBudget({
				configured: { max_connections: 12, max_parallel_dials: 3 },
				relayServiceEnabled: false,
				runtime: "browser",
			})
		).toEqual({ maxConnections: 12, maxParallelDials: 3, role: "browser" });

		expect(() =>
			resolveConnectionBudget({
				configured: { max_connections: 49, max_parallel_dials: 6 },
				relayServiceEnabled: false,
				runtime: "browser",
			})
		).toThrow(/connection.?budget|max_connections/iu);
		expect(() =>
			resolveConnectionBudget({
				configured: { max_connections: 48, max_parallel_dials: 7 },
				relayServiceEnabled: false,
				runtime: "worker",
			})
		).toThrow(/connection.?budget|max_parallel_dials/iu);
		expect(() =>
			resolveConnectionBudget({
				configured: { max_connections: 2_001, max_parallel_dials: 32 },
				relayServiceEnabled: true,
				runtime: "node",
			})
		).toThrow(/connection.?budget|max_connections/iu);
	});

	test("publishes the exact reduced immutable budget and resolves it afresh on restart", async () => {
		const snapshots: BudgetSnapshot[] = [];
		const hostFactory: DRPNetworkHostFactory = (context) => {
			snapshots.push(context.snapshot as BudgetSnapshot);
			return context.createHost();
		};
		const node = new DRPNetworkNode(withBudget(4, 2), { hostFactory, hostPolicy: quietHostPolicy });
		running.push(node);

		await node.start();
		await node.restart(withBudget(3, 1));

		expect(snapshots.map(({ connectionBudget }) => connectionBudget)).toEqual([
			{ maxConnections: 4, maxParallelDials: 2, role: "node" },
			{ maxConnections: 3, maxParallelDials: 1, role: "node" },
		]);
		expect(Object.isFrozen(snapshots[0]?.connectionBudget)).toBe(true);
		expect(Object.isFrozen(snapshots[1]?.connectionBudget)).toBe(true);
	});

	test.each([
		["missing max_connections", { max_parallel_dials: 1 }],
		["missing max_parallel_dials", { max_connections: 2 }],
		["unknown key", { max_connections: 2, max_parallel_dials: 1, spare: 1 }],
		["zero", { max_connections: 0, max_parallel_dials: 1 }],
		["negative", { max_connections: 2, max_parallel_dials: -1 }],
		["fractional", { max_connections: 2.5, max_parallel_dials: 1 }],
		["unsafe", { max_connections: Number.MAX_SAFE_INTEGER + 1, max_parallel_dials: 1 }],
		["over-profile", { max_connections: 301, max_parallel_dials: 100 }],
		["dial ceiling", { max_connections: 2, max_parallel_dials: 2 }],
	] as const)("rejects %s connection_budget before host construction", async (_name, connectionBudget) => {
		const hostFactory = vi.fn<DRPNetworkHostFactory>((context) => context.createHost());
		const node = new DRPNetworkNode({ ...baseConfig, connection_budget: connectionBudget } as DRPNetworkNodeConfig, {
			hostFactory,
			hostPolicy: quietHostPolicy,
		});
		running.push(node);

		await expect(node.start()).rejects.toThrow(/connection.?budget|max_connections|max_parallel_dials/iu);
		expect(hostFactory).not.toHaveBeenCalled();
	});

	test("installs the exact libp2p ceiling and shares final inbound and outbound reservations", async () => {
		let host: InspectableHost | undefined;
		const node = new DRPNetworkNode(withBudget(2, 1), {
			hostFactory: async (context): Promise<Libp2p> => {
				host = (await context.createHost()) as InspectableHost;
				return host;
			},
			hostPolicy: quietHostPolicy,
		});
		running.push(node);
		await node.start();
		if (host === undefined) throw new Error("expected captured host");

		expect(host.components.connectionManager.getMaxConnections()).toBe(2);
		expect(host.components.connectionManager.dialQueue.queue.concurrency).toBe(1);
		const inbound = host.components.connectionGater.denyInboundUpgradedConnection;
		const outbound = host.components.connectionGater.denyOutboundUpgradedConnection;
		expect(inbound).toBeTypeOf("function");
		expect(outbound).toBeTypeOf("function");
		if (inbound === undefined || outbound === undefined) throw new Error("expected final upgraded-connection gates");

		vi.useFakeTimers();
		await expect(
			Promise.all([
				Promise.resolve(inbound(peer(0), connection(0))),
				Promise.resolve(outbound(peer(1), connection(1))),
				Promise.resolve(inbound(peer(2), connection(2))),
			])
		).resolves.toEqual([false, false, true]);

		await vi.advanceTimersByTimeAsync(59_999);
		await expect(Promise.resolve(outbound(peer(3), connection(3)))).resolves.toBe(true);
		await vi.runOnlyPendingTimersAsync();
		await expect(
			Promise.all([
				Promise.resolve(outbound(peer(4), connection(4))),
				Promise.resolve(outbound(peer(5), connection(5))),
				Promise.resolve(inbound(peer(6), connection(6))),
			])
		).resolves.toEqual([false, false, true]);
	});

	test("preserves an unattached reservation through its deadline and reconciles auto-start on every host", async () => {
		const remote = new DRPNetworkNode(baseConfig, { hostPolicy: quietHostPolicy });
		let host: InspectableHost | undefined;
		const builtHosts: InspectableHost[] = [];
		const target = new DRPNetworkNode(withBudget(2, 1), {
			hostFactory: async (context): Promise<Libp2p> => {
				host = (await context.createHost()) as InspectableHost;
				builtHosts.push(host);
				const inbound = host.components.connectionGater.denyInboundUpgradedConnection;
				if (inbound === undefined) throw new Error("expected final inbound gate before host attachment");
				vi.useFakeTimers();
				await expect(Promise.resolve(inbound(peer(80 + builtHosts.length), connection(80)))).resolves.toBe(false);
				await vi.advanceTimersByTimeAsync(120_000);
				vi.useRealTimers();
				await remote.connect(host.getMultiaddrs().map((address) => address.toString()));
				await waitFor(() => host?.getConnections().length === 1, "auto-start connection census");
				return host;
			},
			hostPolicy: quietHostPolicy,
		});
		running.push(remote, target);
		await remote.start();
		await target.start();
		await target.restart(withBudget(2, 1));
		if (host === undefined) throw new Error("expected captured target host");
		expect(builtHosts).toHaveLength(2);
		expect(host.getConnections()).toHaveLength(1);

		const inbound = host.components.connectionGater.denyInboundUpgradedConnection;
		if (inbound === undefined) throw new Error("expected final inbound gate");
		await expect(Promise.resolve(inbound(peer(90), connection(90)))).resolves.toBe(true);
	}, 30_000);

	test("counts duplicate open and close events exactly once without over-crediting the pool", async () => {
		const remote = new DRPNetworkNode(baseConfig, { hostPolicy: quietHostPolicy });
		let host: InspectableHost | undefined;
		const target = new DRPNetworkNode(withBudget(2, 1), {
			hostFactory: async (context): Promise<Libp2p> => {
				host = (await context.createHost()) as InspectableHost;
				return host;
			},
			hostPolicy: quietHostPolicy,
		});
		running.push(remote, target);
		await Promise.all([remote.start(), target.start()]);
		await remote.connect(target.getMultiaddrs());
		await waitFor(() => host?.getConnections().length === 1, "one real connection");
		if (host === undefined) throw new Error("expected captured target host");
		const inbound = host.components.connectionGater.denyInboundUpgradedConnection;
		if (inbound === undefined) throw new Error("expected final inbound gate");
		const [liveConnection] = host.getConnections();
		if (liveConnection === undefined) throw new Error("expected one live connection");

		host.dispatchEvent(new CustomEvent("connection:open", { detail: liveConnection }));
		vi.useFakeTimers();
		await expect(
			Promise.all([100, 101].map((index) => Promise.resolve(inbound(peer(index), connection(index)))))
		).resolves.toEqual([false, true]);
		await vi.advanceTimersByTimeAsync(59_999);
		await expect(Promise.resolve(inbound(peer(102), connection(102)))).resolves.toBe(true);
		await vi.runOnlyPendingTimersAsync();
		await expect(Promise.resolve(inbound(peer(103), connection(103)))).resolves.toBe(false);

		vi.useRealTimers();
		await remote.disconnect(target.peerId);
		await waitFor(() => host?.getConnections().length === 0, "the real connection close");
		host.dispatchEvent(new CustomEvent("connection:close", { detail: liveConnection }));
		await expect(
			Promise.all([104, 105].map((index) => Promise.resolve(inbound(peer(index), connection(index)))))
		).resolves.toEqual([false, true]);
	}, 30_000);

	test("never crosses a reduced hard ceiling during a genuine concurrent inbound flood", async () => {
		const target = new DRPNetworkNode(withBudget(2, 1), { hostPolicy: quietHostPolicy });
		const clients = Array.from({ length: 4 }, () => new DRPNetworkNode(baseConfig, { hostPolicy: quietHostPolicy }));
		running.push(target, ...clients);
		await Promise.all(running.map((node) => node.start()));

		const observedCounts = [liveConnections(target).length];
		target["_node"]?.addEventListener("connection:open", () => observedCounts.push(liveConnections(target).length));
		target["_node"]?.addEventListener("connection:close", () => observedCounts.push(liveConnections(target).length));
		const address = websocketAddress(target);
		await Promise.allSettled(clients.map((client) => client.connect(address)));
		await waitFor(() => liveConnections(target).length >= 2, "at least two flood connections");
		observedCounts.push(liveConnections(target).length);

		expect(observedCounts.every((count) => count <= 2)).toBe(true);
		expect(liveConnections(target)).toHaveLength(2);

		const [departing] = livePeerIds(target);
		if (departing === undefined) throw new Error("expected one admitted peer to disconnect");
		await target.disconnect(departing);
		await waitFor(() => liveConnections(target).length === 1, "one released admission slot");
		const connectedAfterDeparture = new Set(livePeerIds(target));
		const replacement = clients.find(
			(client) => client.peerId !== departing && !connectedAfterDeparture.has(client.peerId)
		);
		if (replacement === undefined) throw new Error("expected one rejected client for replacement");
		await replacement.connect(address);
		await waitFor(() => liveConnections(target).length === 2, "one replacement admission");
		expect(liveConnections(target)).toHaveLength(2);
	}, 30_000);

	test("preserves existing peers, streams, and room membership during a genuine outbound flood", async () => {
		const initiator = new DRPNetworkNode(withBudget(3, 2), { hostPolicy: quietHostPolicy });
		const remotes = Array.from({ length: 5 }, () => new DRPNetworkNode(baseConfig, { hostPolicy: quietHostPolicy }));
		running.push(initiator, ...remotes);
		await Promise.all(running.map((node) => node.start()));
		const [first, second, third, fourth, fifth] = remotes;
		if (
			first === undefined ||
			second === undefined ||
			third === undefined ||
			fourth === undefined ||
			fifth === undefined
		) {
			throw new Error("expected five outbound peers");
		}

		const topic = "track-t1-outbound-flood";
		for (const node of running) node.subscribe(topic);
		await initiator.connect(websocketAddress(first));
		await initiator.connect(websocketAddress(second));
		await initiator.connect(websocketAddress(third));
		await waitFor(() => liveConnections(initiator).length === 3, "three original outbound connections");
		await waitFor(
			() =>
				initiator.getGroupPeers(topic).includes(first.peerId) &&
				initiator.getGroupPeers(topic).includes(second.peerId) &&
				initiator.getGroupPeers(topic).includes(third.peerId),
			"original room memberships"
		);

		const originalPeerIds = new Set([first.peerId, second.peerId, third.peerId]);
		const protectedConnection = liveConnections(initiator).find(
			({ remotePeer }) => remotePeer.toString() === first.peerId
		);
		if (protectedConnection === undefined) throw new Error("expected protected outbound connection");
		const protectedStream: Stream = await protectedConnection.newStream(DRP_MESSAGE_PROTOCOL);
		const observedCounts = [liveConnections(initiator).length];
		initiator["_node"]?.addEventListener("connection:open", () =>
			observedCounts.push(liveConnections(initiator).length)
		);
		initiator["_node"]?.addEventListener("connection:close", () =>
			observedCounts.push(liveConnections(initiator).length)
		);

		await Promise.allSettled([initiator.connect(websocketAddress(fourth)), initiator.connect(websocketAddress(fifth))]);
		await new Promise((resolve) => setTimeout(resolve, 250));

		expect(observedCounts.every((count) => count <= 3)).toBe(true);
		expect(new Set(livePeerIds(initiator))).toEqual(originalPeerIds);
		expect(protectedStream.status).toBe("open");
		expect(initiator.getGroupPeers(topic)).toEqual(expect.arrayContaining([first.peerId, second.peerId, third.peerId]));

		await initiator.disconnect(first.peerId);
		await waitFor(() => liveConnections(initiator).length === 2, "one outbound slot release");
		await initiator.connect(websocketAddress(fourth));
		await waitFor(() => liveConnections(initiator).length === 3, "one outbound replacement");
		expect(new Set(livePeerIds(initiator))).toEqual(new Set([second.peerId, third.peerId, fourth.peerId]));
	}, 30_000);
});
