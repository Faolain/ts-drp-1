import { afterEach, describe, expect, it } from "vitest";

import { DRPNetworkNode } from "../src/node.js";

// initialReach: what a started node's own first bootstrap dials reached (creator restore currency
// uses "unreachable" to end its connectivity hold at once).
const running: DRPNetworkNode[] = [];
afterEach(async () => {
	await Promise.allSettled(running.splice(0).map((node) => node.stop()));
});

function node(bootstrapPeers: string[], bootstrapDiscovery = true): DRPNetworkNode {
	const created = new DRPNetworkNode(
		{ bootstrap_peers: bootstrapPeers, listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"], log_config: { level: "silent" } },
		{
			hostPolicy: {
				bootstrapDiscovery,
				coldStartPubsubDiscovery: false,
				gossipSubPeerExchange: false,
				denyDialMultiaddr: () => false,
			},
		}
	);
	running.push(created);
	return created;
}

describe("DRPNetworkNode.initialReach", () => {
	it("is none with nothing to dial", async () => {
		const lone = node([]);
		await lone.start();
		expect(await lone.initialReach()).toBe("none");
		const off = node(["/ip4/127.0.0.1/tcp/9/ws/p2p/12D3KooWGzBkWyFphz3oXe5XDb4m7Jb1CmCvqUQkNquMmvX5XsWH"], false);
		await off.start();
		expect(await off.initialReach()).toBe("none");
	});

	it("is unreachable once the first dial of every bootstrap peer failed", async () => {
		const target = node([]);
		await target.start();
		const [address] = target.getMultiaddrs().filter((value) => value.includes("/p2p/"));
		await target.stop();
		const offline = node([address!]);
		const started = performance.now();
		await offline.start();
		expect(await offline.initialReach()).toBe("unreachable");
		expect(performance.now() - started).toBeLessThan(10_000);
	}, 30_000);

	it("is reached once a bootstrap peer's first dial connected", async () => {
		const bootstrap = node([]);
		await bootstrap.start();
		const addresses = bootstrap.getMultiaddrs().filter((value) => value.includes("/p2p/"));
		const joining = node(addresses);
		await joining.start();
		expect(await joining.initialReach()).toBe("reached");
		expect(joining.getAllPeers()).toContain(bootstrap.peerId);
	}, 30_000);
});
