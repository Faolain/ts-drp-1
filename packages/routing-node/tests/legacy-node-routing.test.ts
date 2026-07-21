import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import {
	AMINO_DHT_PROTOCOL,
	createNodeRouting,
	namespaceCid,
	NodeRouting,
	OFFICIAL_AMINO_BOOTSTRAPPERS,
	PUBLIC_NETWORK_ACKNOWLEDGEMENT,
} from "@ts-drp/routing-node";
import { describe, expect, it } from "vitest";

describe("NodeRouting", () => {
	it("derives stable namespace CIDs and freezes the explicit public-network contract", async () => {
		const first = await namespaceCid("drp/testing");
		const repeated = await namespaceCid("drp/testing");
		const different = await namespaceCid("drp/other");
		expect(first.toString()).toBe(repeated.toString());
		expect(first.toString()).not.toBe(different.toString());
		expect(AMINO_DHT_PROTOCOL).toBe("/ipfs/kad/1.0.0");
		expect(PUBLIC_NETWORK_ACKNOWLEDGEMENT).toBe("I_ACKNOWLEDGE_PUBLIC_NETWORK_TRAFFIC");
		expect(OFFICIAL_AMINO_BOOTSTRAPPERS).toHaveLength(2);
		expect(OFFICIAL_AMINO_BOOTSTRAPPERS.every((address) => address.startsWith("/dnsaddr/bootstrap.libp2p.io/"))).toBe(
			true
		);
	});

	it("rejects invalid bounds before constructing a host", async () => {
		await expect(createNodeRouting({ limits: { maxOperations: 0 } })).rejects.toThrow(/maxOperations/u);
		await expect(createNodeRouting({ limits: { maxNetworkRequests: 0 } })).rejects.toThrow(/maxNetworkRequests/u);
		await expect(createNodeRouting({ limits: { maxResults: 129 } })).rejects.toThrow(/maxResults/u);
		await expect(createNodeRouting({ limits: { maxAddressesPerPeer: Number.NaN } })).rejects.toThrow(
			/maxAddressesPerPeer/u
		);
	});

	it("returns an empty isolated result, propagates abort, caps operations, and stops idempotently", async () => {
		const routing = await createNodeRouting({
			bootstrapPeers: [],
			limits: { maxOperations: 2 },
			mode: "client",
			network: "local",
		});
		try {
			const empty = [];
			for await (const peer of routing.getClosestPeers(new Uint8Array([1, 2, 3]))) empty.push(peer);
			expect(empty).toEqual([]);

			const controller = new AbortController();
			controller.abort(new Error("fixture abort"));
			await expect(async () => {
				for await (const _peer of routing.getClosestPeers(new Uint8Array([4, 5, 6]), controller.signal)) {
					// The pre-aborted query must never yield.
				}
			}).rejects.toThrow();
			await expect(routing.refresh()).rejects.toThrow(/operation cap/u);
		} finally {
			const firstStop = routing.stop();
			const secondStop = routing.stop();
			await expect(Promise.all([firstStop, secondStop])).resolves.toEqual([undefined, undefined]);
		}
	}, 5_000);

	it.each([
		{ publicCount: 5, total: 10 },
		{ publicCount: 3, total: 12 },
		{ publicCount: 1, total: 10 },
	])(
		"bounds and filters a peer result containing mostly unusable addresses ($publicCount/$total usable)",
		async ({ publicCount, total }) => {
			const addresses = [
				...Array.from({ length: publicCount }, (_, index) => `/ip4/8.8.8.${index + 1}/tcp/4001`),
				...Array.from({ length: total - publicCount }, (_, index) => `/ip4/127.0.0.${index + 1}/tcp/4001`),
			];
			const routing = fakeNodeRouting(addresses);
			try {
				const peer = await routing.findPeer(TEST_PEER_ID);
				expect(peer.inputAddressCount).toBe(total);
				expect(peer.addressDecisions).toHaveLength(Math.min(total, 16));
				expect(peer.addresses).toHaveLength(publicCount);
				expect(peer.truncatedAddressCount).toBe(Math.max(0, total - 16));
			} finally {
				await routing.stop();
			}
		}
	);

	it("truncates excess addresses and enforces the DHT send-query request budget", async () => {
		const addresses = Array.from({ length: 20 }, (_, index) => `/ip4/8.8.8.${(index % 200) + 1}/tcp/4001`);
		const bounded = fakeNodeRouting(addresses);
		try {
			const peer = await bounded.findPeer(TEST_PEER_ID);
			expect(peer.inputAddressCount).toBe(20);
			expect(peer.addressDecisions).toHaveLength(16);
			expect(peer.truncatedAddressCount).toBe(4);
		} finally {
			await bounded.stop();
		}

		const exhausted = fakeNodeRouting(["/ip4/8.8.8.8/tcp/4001"], 2);
		await expect(exhausted.findPeer(TEST_PEER_ID)).rejects.toThrow(/request cap exhausted/u);
		await exhausted.stop();
	});
});

const TEST_PEER_ID = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";

function fakeNodeRouting(addresses: string[], progressEvents = 0): NodeRouting {
	const peerId = peerIdFromString(TEST_PEER_ID);
	const host = {
		addEventListener: (): void => undefined,
		getConnections: (): never[] => [],
		getMultiaddrs: (): never[] => [],
		getProtocols: (): string[] => [AMINO_DHT_PROTOCOL],
		isDialable: (): Promise<boolean> => Promise.resolve(false),
		peerId,
		peerRouting: {
			findPeer: (
				_peerId: unknown,
				options: { onProgress?(event: { type: string }): void }
			): Promise<{ id: typeof peerId; multiaddrs: ReturnType<typeof multiaddr>[] }> => {
				for (let index = 0; index < progressEvents; index += 1) {
					options.onProgress?.({ type: "kad-dht:query:send-query" });
				}
				return Promise.resolve({ id: peerId, multiaddrs: addresses.map((address) => multiaddr(address)) });
			},
		},
		removeEventListener: (): void => undefined,
		services: {
			aminoDHT: {
				getMode: (): "client" => "client",
				routingTable: { size: 1 },
			},
		},
		status: "started",
	};
	return new NodeRouting({ stop: (): Promise<void> => Promise.resolve() } as never, host as never, {
		limits: {
			maxAddressesPerPeer: 16,
			maxNetworkRequests: 1,
			maxOperations: 4,
			maxResults: 16,
		},
		network: "public",
		resolver: { resolve: (): Promise<string[]> => Promise.resolve([]) },
	});
}
