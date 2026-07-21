import { type Libp2p } from "@libp2p/interface";
import { type DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DRPNetworkNode } from "../src/node.js";

interface GossipSubRoleView {
	opts: {
		D: number;
		Dhi: number;
		Dlo: number;
		Dout: number;
	};
	score: {
		params: {
			topicScoreCap: number;
		};
	};
}

const quietConfig = {
	bootstrap_peers: [],
	listen_addresses: [],
	log_config: { level: "silent" as const },
};

function createNode(config: DRPNetworkNodeConfig = quietConfig): DRPNetworkNode {
	return new DRPNetworkNode(config);
}

function services(node: DRPNetworkNode): Libp2p["services"] {
	const host = node["_node"];
	if (host === undefined) throw new Error("expected a started libp2p host");
	return host.services;
}

function gossipSub(node: DRPNetworkNode): GossipSubRoleView {
	const service = node["_pubsub"] as unknown as GossipSubRoleView | undefined;
	if (service === undefined) throw new Error("expected a started GossipSub service");
	return service;
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

describe("Phase 2 node role decoupling", () => {
	const startedNodes: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(
			startedNodes.splice(0).map(async (node) => {
				if (node["_node"]?.status !== "stopped") await node.stop();
			})
		);
	});

	test("construction without a config remains legal", () => {
		expect(() => new DRPNetworkNode()).not.toThrow();
	});

	test("relay service alone serves reservations without changing seed or AutoNAT behavior", async () => {
		const ordinary = createNode();
		const relay = createNode({
			...quietConfig,
			relay_service: { enabled: true },
		});
		startedNodes.push(ordinary, relay);

		await ordinary.start();
		await relay.start();

		expect(services(relay).relay).toBeDefined();
		expect(services(relay).autonat).toBeUndefined();
		expect({
			D: gossipSub(relay).opts.D,
			Dhi: gossipSub(relay).opts.Dhi,
			Dlo: gossipSub(relay).opts.Dlo,
			Dout: gossipSub(relay).opts.Dout,
		}).toEqual({
			D: gossipSub(ordinary).opts.D,
			Dhi: gossipSub(ordinary).opts.Dhi,
			Dlo: gossipSub(ordinary).opts.Dlo,
			Dout: gossipSub(ordinary).opts.Dout,
		});
		expect(gossipSub(relay).opts.D).toBeGreaterThan(0);
	});

	test("a seed is forward-only but does not serve relay or AutoNAT", async () => {
		const seed = createNode({ ...quietConfig, seed: true });
		startedNodes.push(seed);

		await seed.start();

		expect(services(seed).relay).toBeUndefined();
		expect(services(seed).autonat).toBeUndefined();
		expect({
			D: gossipSub(seed).opts.D,
			Dhi: gossipSub(seed).opts.Dhi,
			Dlo: gossipSub(seed).opts.Dlo,
			Dout: gossipSub(seed).opts.Dout,
		}).toEqual({ D: 0, Dhi: 0, Dlo: 0, Dout: 0 });
		expect(gossipSub(seed).score.params.topicScoreCap).toBe(50);
	});

	test("relay_service.enabled=false does not install the relay server", async () => {
		const node = createNode({
			...quietConfig,
			relay_service: { enabled: false },
		});
		startedNodes.push(node);

		await node.start();

		expect(services(node).relay).toBeUndefined();
	});

	test("seed and relay service compose to provide both independent behaviors", async () => {
		const node = createNode({
			...quietConfig,
			relay_service: { enabled: true },
			seed: true,
		});
		startedNodes.push(node);

		await node.start();

		expect(services(node).relay).toBeDefined();
		expect(services(node).autonat).toBeUndefined();
		expect({
			D: gossipSub(node).opts.D,
			Dhi: gossipSub(node).opts.Dhi,
			Dlo: gossipSub(node).opts.Dlo,
			Dout: gossipSub(node).opts.Dout,
		}).toEqual({ D: 0, Dhi: 0, Dlo: 0, Dout: 0 });
		expect(gossipSub(node).score.params.topicScoreCap).toBe(50);
	});

	test("a seed does not actively dial bootstrap peers at start", async () => {
		const node = createNode({
			...quietConfig,
			bootstrap_peers: ["/ip4/127.0.0.1/tcp/65535/ws/p2p/16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5"],
			seed: true,
		});
		const dial = vi.spyOn(node, "safeDial").mockRejectedValue(new Error("bootstrap dial should not run"));
		startedNodes.push(node);

		await node.start();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(dial.mock.calls.length).toBe(0);
	});

	test("a non-seed node actively dials configured bootstrap peers at start", async () => {
		const bootstrapAddress = "/ip4/127.0.0.1/tcp/65535/ws/p2p/16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5";
		const node = createNode({ ...quietConfig, bootstrap_peers: [bootstrapAddress] });
		const dial = vi.spyOn(node, "safeDial").mockResolvedValue(undefined);
		startedNodes.push(node);

		await node.start();

		expect(dial).toHaveBeenCalledOnce();
		expect(dial.mock.calls[0]?.[0].toString()).toBe(bootstrapAddress);
	});

	test("a second node can reserve a relayed listener through a relay-service-only node", async () => {
		const relay = createNode({
			...quietConfig,
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			relay_service: { enabled: true },
		});
		startedNodes.push(relay);
		await relay.start();
		expect(services(relay).relay).toBeDefined();

		const relayAddress = relay.getMultiaddrs().find((address) => address.includes("/ws/p2p/"));
		if (relayAddress === undefined) throw new Error("relay did not expose a WebSocket listen address");

		const client = createNode({
			...quietConfig,
			listen_addresses: [`${relayAddress}/p2p-circuit`],
		});
		startedNodes.push(client);
		await client.start();

		await waitFor(
			() => client.getMultiaddrs().some((address) => address.includes(`/p2p/${relay.peerId}/p2p-circuit`)),
			"client relay reservation"
		);
		expect((services(relay).relay as { reservations?: { size: number } }).reservations?.size).toBe(1);
	});

	test("relay_service.max_reservations refuses reservations at the configured capacity", async () => {
		const relay = createNode({
			...quietConfig,
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			relay_service: { enabled: true, max_reservations: 0 },
		});
		startedNodes.push(relay);
		await relay.start();
		expect(services(relay).relay).toBeDefined();

		const relayAddress = relay.getMultiaddrs().find((address) => address.includes("/ws/p2p/"));
		if (relayAddress === undefined) throw new Error("relay did not expose a WebSocket listen address");

		const refusedClient = createNode({
			...quietConfig,
			listen_addresses: [`${relayAddress}/p2p-circuit`],
		});

		await expect(refusedClient.start()).rejects.toThrow();
		expect((services(relay).relay as { reservations?: { size: number } }).reservations?.size).toBe(0);
	});
});
