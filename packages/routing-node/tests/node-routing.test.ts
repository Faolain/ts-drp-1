import {
	AMINO_DHT_PROTOCOL,
	createNodeRouting,
	namespaceCid,
	type NodeRouting,
	PUBLIC_NETWORK_ACKNOWLEDGEMENT,
} from "@ts-drp/routing-node";
import { describe, expect, it } from "vitest";

describe("NodeRouting", () => {
	it("performs local Amino peer lookup and provider publication through the production host seam", async () => {
		const nodes: NodeRouting[] = [];
		const signal = AbortSignal.timeout(9_000);
		try {
			const server = await createNodeRouting({
				limits: { maxResults: 1 },
				mode: "server",
				network: "local",
			});
			nodes.push(server);
			const serverStatus = await server.status(signal);
			const bootstrapAddress = serverStatus.addresses.find(({ decision }) => decision.dialable)?.address;
			expect(bootstrapAddress).toBeDefined();
			if (bootstrapAddress === undefined) throw new Error("server has no dialable bootstrap address");

			const publisher = await createNodeRouting({
				bootstrapPeers: [],
				mode: "client",
				network: "local",
			});
			nodes.push(publisher);
			await publisher.connect(withPeerId(bootstrapAddress, server.peerId), signal);
			await publisher.waitForRoutingTable(1, signal);

			await expect(publisher.findPeer(server.peerId, signal)).resolves.toMatchObject({ peerId: server.peerId });

			const cid = await namespaceCid("drp/phase-02/local-provider");
			await publisher.provide(cid, signal);
			const providers = await collect(server.findProviders(cid, signal));
			expect(providers.some(({ peerId }) => peerId === publisher.peerId)).toBe(true);
			await publisher.cancelReprovide(cid, signal);

			expect(publisher.measurements.map(({ operation }) => operation)).toEqual(
				expect.arrayContaining(["bootstrap", "connect", "findPeer", "provide", "cancelReprovide"])
			);
		} finally {
			await Promise.allSettled(nodes.reverse().map((node) => node.stop()));
		}
	}, 10_000);

	it("freezes Amino constants, stable namespace CIDs, and constructor bounds", async () => {
		const first = await namespaceCid("drp/testing");
		const repeated = await namespaceCid("drp/testing");
		const different = await namespaceCid("drp/other");
		expect(first.toString()).toBe(repeated.toString());
		expect(first.toString()).not.toBe(different.toString());
		expect(AMINO_DHT_PROTOCOL).toBe("/ipfs/kad/1.0.0");
		expect(PUBLIC_NETWORK_ACKNOWLEDGEMENT).toBe("I_ACKNOWLEDGE_PUBLIC_NETWORK_TRAFFIC");

		await expect(createNodeRouting({ limits: { maxOperations: 0 } })).rejects.toThrow(/maxOperations/u);
		await expect(createNodeRouting({ limits: { maxNetworkRequests: 0 } })).rejects.toThrow(/maxNetworkRequests/u);
		await expect(createNodeRouting({ limits: { maxResults: 129 } })).rejects.toThrow(/maxResults/u);
		await expect(createNodeRouting({ limits: { maxAddressesPerPeer: Number.NaN } })).rejects.toThrow(
			/maxAddressesPerPeer/u
		);
	});
});

function withPeerId(address: string, peerId: string): string {
	return address.includes("/p2p/") ? address : `${address}/p2p/${peerId}`;
}

async function collect<Value>(source: AsyncIterable<Value>): Promise<Value[]> {
	const values: Value[] = [];
	for await (const value of source) values.push(value);
	return values;
}
