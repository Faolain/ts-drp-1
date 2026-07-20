import { describe, expect, it, vi } from "vitest";

import { DRPNetworkNode } from "../src/node.js";

describe("DRPNetworkNode lifecycle", () => {
	it("applies replacement bootstrap peers before restarting with the requested identity", async () => {
		const originalPeers = ["/dns4/old.example/tcp/443/wss/p2p/old-peer"];
		const replacementPeers = ["/dns4/new.example/tcp/443/wss/p2p/new-peer"];
		const privateKey = Uint8Array.from([1, 2, 3]);
		const node = new DRPNetworkNode({ bootstrap_peers: originalPeers });
		const stop = vi.spyOn(node, "stop").mockResolvedValue();
		const start = vi.spyOn(node, "start").mockImplementation((requestedKey) => {
			expect(node.getBootstrapNodes()).toEqual(replacementPeers);
			expect(requestedKey).toBe(privateKey);
			return Promise.resolve();
		});

		await node.restart({ bootstrap_peers: replacementPeers }, privateKey);

		expect(stop).toHaveBeenCalledOnce();
		expect(stop.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
		expect(node.getBootstrapNodes()).toEqual(replacementPeers);
		expect(start).toHaveBeenCalledOnce();
		expect(start).toHaveBeenCalledWith(privateKey);
	});
});
