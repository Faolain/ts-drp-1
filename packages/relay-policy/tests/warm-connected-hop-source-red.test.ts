import * as relayPolicy from "@ts-drp/relay-policy";
import { describe, expect, it, vi } from "vitest";

const QUERY = Uint8Array.from([8, 3, 1]);
const HOP = relayPolicy.CIRCUIT_RELAY_V2_HOP_PROTOCOL;

interface PeerIdLike {
	toString(): string;
}

interface StoredPeer {
	readonly addresses: readonly { readonly multiaddr: { toString(): string } }[];
	readonly id: PeerIdLike;
	readonly protocols: readonly string[];
}

interface ConnectedPeerHost {
	getClosestPeers(queryKey: Uint8Array, signal?: AbortSignal): AsyncIterable<unknown>;
	getConnections(): readonly {
		readonly remoteAddr?: { toString(): string };
		readonly remotePeer: PeerIdLike;
	}[];
	readonly peerStore: {
		all(options?: { readonly signal?: AbortSignal }): Promise<readonly StoredPeer[]>;
		get(peerId: PeerIdLike, options?: { readonly signal?: AbortSignal }): Promise<StoredPeer>;
	};
}

interface WarmRelayCandidate {
	readonly addresses: readonly string[];
	readonly operatorGroup: string;
	readonly peerId: string;
	readonly protocols: readonly string[];
	readonly provenance: {
		readonly origin: "node-connected-hop";
		readonly queryDigest: string;
		readonly resultIndex: number;
		readonly routingSource: "connected-peers";
	};
}

interface WarmRelaySource {
	getCandidates(queryKey: Uint8Array, signal: AbortSignal): AsyncIterable<WarmRelayCandidate>;
}

type WarmRelaySourceConstructor = new (options: {
	readonly host: ConnectedPeerHost;
	readonly maxCandidates?: number;
}) => WarmRelaySource;

describe("ConnectedHopRelaySource RED contracts", () => {
	it("harvests exactly live connected peers whose Identify protocols advertise relay HOP", async () => {
		const hopA = storedPeer("relay-a", [HOP, "/ipfs/id/1.0.0"]);
		const nonHop = storedPeer("ordinary-peer", ["/ipfs/id/1.0.0"]);
		const knownButDisconnected = storedPeer("stale-relay", [HOP]);
		const hopB = storedPeer("relay-b", [HOP]);
		const host = connectedHost([hopA, nonHop, knownButDisconnected, hopB], [hopA, nonHop, hopB]);
		const source = new (connectedHopConstructor())({ host });

		await expect(collect(source)).resolves.toMatchObject([
			{
				addresses: addressesOf(hopA),
				peerId: "relay-a",
				protocols: [HOP, "/ipfs/id/1.0.0"],
			},
			{ addresses: addressesOf(hopB), peerId: "relay-b", protocols: [HOP] },
		]);
		expect(host.getClosestPeers).not.toHaveBeenCalled();
	});

	it("returns an empty iterable cleanly when the warm connected set has no HOP peer", async () => {
		const peer = storedPeer("ordinary-peer", ["/ipfs/id/1.0.0"]);
		const host = connectedHost([peer], [peer]);
		const source = new (connectedHopConstructor())({ host });

		await expect(collect(source)).resolves.toEqual([]);
		expect(host.getClosestPeers).not.toHaveBeenCalled();
	});

	it("caps warm candidates without consulting cold peer routing", async () => {
		const peers = [storedPeer("relay-a", [HOP]), storedPeer("relay-b", [HOP]), storedPeer("relay-c", [HOP])];
		const host = connectedHost(peers, peers);
		const source = new (connectedHopConstructor())({ host, maxCandidates: 2 });

		await expect(collect(source)).resolves.toMatchObject([{ peerId: "relay-a" }, { peerId: "relay-b" }]);
		expect(host.getClosestPeers).not.toHaveBeenCalled();
	});

	it("prefers a live connection address and skips HOP peers with no address", async () => {
		const relay = storedPeer("relay-a", [HOP]);
		const addressless = storedPeer("relay-b", [HOP], []);
		const liveAddress = "/ip4/1.2.3.4/tcp/4001/p2p/relay-a";
		const host = connectedHost([relay, addressless], [relay, addressless], new Map([["relay-a", liveAddress]]));

		await expect(collect(new (connectedHopConstructor())({ host }))).resolves.toMatchObject([
			{ addresses: [liveAddress, ...addressesOf(relay)], peerId: "relay-a" },
		]);
	});

	it("retains HOP in the bounded protocol list when Identify reports it after the first 64 entries", async () => {
		const leadingProtocols = Array.from({ length: 64 }, (_, index) => `/fixture/${index}`);
		const relay = storedPeer("relay-a", [...leadingProtocols, HOP]);
		const [candidate] = await collect(new (connectedHopConstructor())({ host: connectedHost([relay], [relay]) }));

		expect(candidate?.protocols).toEqual([...leadingProtocols.slice(0, 63), HOP]);
	});

	it("observes caller cancellation between yielded warm candidates", async () => {
		const peers = [storedPeer("relay-a", [HOP]), storedPeer("relay-b", [HOP])];
		const source = new (connectedHopConstructor())({ host: connectedHost(peers, peers) });
		const controller = new AbortController();
		const iterator = source.getCandidates(QUERY, controller.signal)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { peerId: "relay-a" } });
		controller.abort(new DOMException("warm harvest cancelled", "AbortError"));
		await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
	});

	it("emits valid node-overflow provenance for the existing degraded overflow policy", async () => {
		const relay = storedPeer("relay-a", [HOP]);
		const [candidate] = await collect(new (connectedHopConstructor())({ host: connectedHost([relay], [relay]) }));

		expect(candidate).toMatchObject({
			operatorGroup: "unknown",
			provenance: {
				origin: "node-connected-hop",
				queryDigest: "query_d0df2467",
				resultIndex: 0,
				routingSource: "connected-peers",
			},
		});
		const isValidCandidate = (
			relayPolicy as unknown as { isValidCandidate?(candidate: unknown): candidate is WarmRelayCandidate }
		).isValidCandidate;
		expect(isValidCandidate).toBeTypeOf("function");
		if (isValidCandidate === undefined || candidate === undefined) throw new Error("candidate validator unavailable");
		expect(isValidCandidate(candidate)).toBe(true);
	});
});

function connectedHopConstructor(): WarmRelaySourceConstructor {
	const Constructor = (relayPolicy as unknown as { ConnectedHopRelaySource?: WarmRelaySourceConstructor })
		.ConnectedHopRelaySource;
	expect(Constructor, "relay-policy must export ConnectedHopRelaySource").toBeTypeOf("function");
	if (Constructor === undefined) throw new Error("ConnectedHopRelaySource is not exported");
	return Constructor;
}

function connectedHost(
	allPeers: readonly StoredPeer[],
	connectedPeers: readonly StoredPeer[],
	liveAddresses: ReadonlyMap<string, string> = new Map()
): ConnectedPeerHost {
	const byId = new Map(allPeers.map((peer) => [peer.id.toString(), peer]));
	return {
		getClosestPeers: vi.fn(async function* (queryKey: Uint8Array): AsyncIterable<unknown> {
			await Promise.resolve();
			if (queryKey.byteLength < 0) yield undefined;
			throw new Error("cold DHT getClosestPeers must not be consulted");
		}),
		getConnections: vi.fn(() =>
			connectedPeers.map((peer) => {
				const liveAddress = liveAddresses.get(peer.id.toString());
				return {
					...(liveAddress === undefined ? {} : { remoteAddr: { toString: (): string => liveAddress } }),
					remotePeer: peer.id,
				};
			})
		),
		peerStore: {
			all: vi.fn(
				(_options?: { readonly signal?: AbortSignal }): Promise<readonly StoredPeer[]> => Promise.resolve(allPeers)
			),
			get: vi.fn((peerId: PeerIdLike): Promise<StoredPeer> => {
				const peer = byId.get(peerId.toString());
				if (peer === undefined) return Promise.reject(new Error(`unknown fake peer ${peerId.toString()}`));
				return Promise.resolve(peer);
			}),
		},
	};
}

function storedPeer(
	peerId: string,
	protocols: readonly string[],
	addresses: StoredPeer["addresses"] = [
		{
			multiaddr: {
				toString: (): string => `/dns4/${peerId}.example.test/tcp/443/wss/p2p/${peerId}`,
			},
		},
	]
): StoredPeer {
	return {
		addresses,
		id: { toString: (): string => peerId },
		protocols,
	};
}

function addressesOf(peer: StoredPeer): string[] {
	return peer.addresses.map(({ multiaddr }) => multiaddr.toString());
}

async function collect(source: WarmRelaySource): Promise<WarmRelayCandidate[]> {
	const candidates: WarmRelayCandidate[] = [];
	for await (const candidate of source.getCandidates(QUERY, new AbortController().signal)) candidates.push(candidate);
	return candidates;
}
