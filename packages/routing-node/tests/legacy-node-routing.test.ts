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
import { describe, expect, it, vi } from "vitest";

describe("NodeRouting", () => {
	it("derives stable namespace CIDs and freezes the explicit public-network contract", async () => {
		const first = await namespaceCid("drp/testing");
		const repeated = await namespaceCid("drp/testing");
		const different = await namespaceCid("drp/other");
		expect(first.toString()).toBe(repeated.toString());
		expect(first.toString()).not.toBe(different.toString());
		expect(AMINO_DHT_PROTOCOL).toBe("/ipfs/kad/1.0.0");
		expect(PUBLIC_NETWORK_ACKNOWLEDGEMENT).toBe("I_ACKNOWLEDGE_PUBLIC_NETWORK_TRAFFIC");
		// The full canonical Amino DHT bootstrap set from IPFS mainnet autoconfiguration
		// (SystemRegistry.AminoDHT.NativeConfig.Bootstrap): 7 multiaddrs across 6 peer identities,
		// so the node DHT seeds a large enough population for relay/overflow discovery to walk.
		expect(OFFICIAL_AMINO_BOOTSTRAPPERS).toHaveLength(7);
		const identities = new Set<string>();
		for (const address of OFFICIAL_AMINO_BOOTSTRAPPERS) {
			expect(() => multiaddr(address), `${address} must be a valid multiaddr`).not.toThrow();
			const id = address.split("/p2p/").at(-1) ?? "";
			expect(id, `${address} must contain a /p2p/ peer id`).not.toBe("");
			expect(() => peerIdFromString(id), `${address} must carry a valid peer id`).not.toThrow();
			identities.add(id);
		}
		expect(identities.size).toBe(6);
		// Not only bootstrap.libp2p.io — the canonical set includes the va1 host and the Mars static node.
		expect(OFFICIAL_AMINO_BOOTSTRAPPERS.some((address) => address.includes("va1.bootstrap.libp2p.io"))).toBe(true);
		expect(OFFICIAL_AMINO_BOOTSTRAPPERS.some((address) => address.includes("/ip4/104.131.131.82/"))).toBe(true);
	});

	it("rejects invalid bounds before constructing a host", async () => {
		await expect(createNodeRouting({ limits: { maxOperations: 0 } })).rejects.toThrow(/maxOperations/u);
		await expect(createNodeRouting({ limits: { maxNetworkRequests: 0 } })).rejects.toThrow(/maxNetworkRequests/u);
		await expect(createNodeRouting({ limits: { maxResults: 129 } })).rejects.toThrow(/maxResults/u);
		await expect(createNodeRouting({ limits: { maxAddressesPerPeer: Number.NaN } })).rejects.toThrow(
			/maxAddressesPerPeer/u
		);
	});

	it("returns empty at once on a cold local zero-peer query, caps operations, and stops idempotently", async () => {
		// network: "local" uses allowQueryWithZeroPeers:true, so an empty-table query returns
		// immediately (no yield) instead of parking — the fix for the public-only publisher hang
		// (phase-09 addendum). Public parking is pinned in amino-options.test.ts
		// (allowQueryWithZeroPeers:false). Local getClosestPeers counts toward maxOperations
		// (isolated budgets are public-only), which is what makes the operation-cap assertion below work.
		const routing = await createNodeRouting({
			bootstrapPeers: [],
			limits: { maxOperations: 2 },
			mode: "client",
			network: "local",
		});
		try {
			const firstYields: unknown[] = [];
			for await (const peer of routing.getClosestPeers(new Uint8Array([1, 2, 3]), AbortSignal.timeout(500))) {
				firstYields.push(peer);
			}
			expect(firstYields).toEqual([]); // operation 1: returned empty without parking

			const controller = new AbortController();
			controller.abort(new Error("fixture abort"));
			await expect(async () => {
				for await (const _peer of routing.getClosestPeers(new Uint8Array([4, 5, 6]), controller.signal)) {
					// The pre-aborted query must never yield.
				}
			}).rejects.toThrow(); // operation 2: pre-aborted throws
			await expect(routing.refresh()).rejects.toThrow(/operation cap/u); // operation 3 > cap of 2
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

	it("isolates recurring high-breadth walks from shared anchor request and operation budgets", async () => {
		const routing = fakeHighBreadthClosestPeersRouting(100);
		try {
			for (let walk = 0; walk < 5; walk += 1) {
				await expect(collect(routing.getClosestPeers(new Uint8Array([7, 8, walk])))).resolves.toMatchObject([
					{ peerId: TEST_PEER_ID },
				]);
			}
			await expect(routing.findPeer(TEST_PEER_ID)).resolves.toMatchObject({ peerId: TEST_PEER_ID });
		} finally {
			await routing.stop();
		}
	});

	it("streams peers found before a closest-peers deadline aborts the unfinished walk", async () => {
		const routing = fakeStreamingClosestPeersRouting(25);
		const observed: string[] = [];
		try {
			try {
				for await (const peer of routing.getClosestPeers(new Uint8Array([3, 2, 1]))) {
					observed.push(peer.peerId);
				}
			} catch {
				// A deadline may remain observable after the already-yielded prefix.
			}
			expect(observed).toEqual([TEST_PEER_ID, TEST_PEER_ID, TEST_PEER_ID]);
		} finally {
			await routing.stop();
		}
	});

	it("aborts an unbounded walk as soon as its isolated request window is consumed", async () => {
		const fixture = fakeUnboundedClosestPeersRouting(3);
		try {
			await collect(fixture.routing.getClosestPeers(new Uint8Array([6, 6, 6]))).catch(() => []);
			expect(fixture.progressEvents()).toBe(3);
			expect(fixture.walkSignal()?.aborted).toBe(true);
			expect(fixture.routing.measurements.at(-1)).toMatchObject({
				networkRequestsConsumed: 3,
				operation: "getClosestPeers",
			});
		} finally {
			await fixture.routing.stop();
		}
	});

	it("cleanly aborts when concurrent progress events race past the walk request cap", async () => {
		const fixture = fakeConcurrentOverCapClosestPeersRouting(2);
		try {
			await expect(collect(fixture.routing.getClosestPeers(new Uint8Array([6, 7, 8])))).resolves.toMatchObject([
				{ peerId: TEST_PEER_ID },
			]);
			expect(fixture.progressEvents()).toBe(4);
			expect(fixture.walkSignal()?.aborted).toBe(true);
			expect(fixture.routing.measurements.at(-1)).toMatchObject({ networkRequestsConsumed: 2 });
		} finally {
			await fixture.routing.stop();
		}
	});

	it("aborts the underlying DHT walk when the closest-peers iterator closes early", async () => {
		const fixture = fakeEarlyCloseClosestPeersRouting();
		try {
			const iterator = fixture.routing.getClosestPeers(new Uint8Array([8, 7, 6]))[Symbol.asyncIterator]();
			await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { peerId: TEST_PEER_ID } });
			await iterator.return?.();
			expect(fixture.walkSignal()?.aborted).toBe(true);
			expect(fixture.closed()).toBe(true);
		} finally {
			await fixture.routing.stop();
		}
	});

	it("gives closest-peer walks a dedicated longer bound while ordinary operations keep the 10s guard", async () => {
		vi.useFakeTimers();
		const slowClosestPeers = fakeTimedNodeRouting({ closestPeerDelayMs: 15_000, closestPeersTimeoutMs: 20_000 });
		const boundedClosestPeers = fakeTimedNodeRouting({ closestPeerDelayMs: 25_000, closestPeersTimeoutMs: 20_000 });
		const ordinaryOperation = fakeTimedNodeRouting({ closestPeerDelayMs: 0 });
		try {
			const slowQuery = collect(slowClosestPeers.getClosestPeers(new Uint8Array([1])));
			const slowSettled = vi.fn();
			void slowQuery.then(slowSettled, slowSettled);
			await vi.advanceTimersByTimeAsync(10_001);
			expect(slowSettled).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(4_999);
			await expect(slowQuery).resolves.toMatchObject([{ peerId: TEST_PEER_ID }]);

			const boundedQuery = collect(boundedClosestPeers.getClosestPeers(new Uint8Array([2])));
			const boundedAssertion = expect(boundedQuery).rejects.toThrow("node routing operation exceeded 20000ms");
			await vi.advanceTimersByTimeAsync(20_000);
			await boundedAssertion;

			const findPeer = ordinaryOperation.findPeer(TEST_PEER_ID);
			const ordinaryAssertion = expect(findPeer).rejects.toThrow("node routing operation exceeded 10000ms");
			await vi.advanceTimersByTimeAsync(10_000);
			await ordinaryAssertion;
		} finally {
			await Promise.all([slowClosestPeers.stop(), boundedClosestPeers.stop(), ordinaryOperation.stop()]);
			vi.useRealTimers();
		}
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

function fakeTimedNodeRouting(options: {
	readonly closestPeerDelayMs: number;
	readonly closestPeersTimeoutMs?: number;
}): NodeRouting {
	const peerId = peerIdFromString(TEST_PEER_ID);
	const host = {
		addEventListener: (): void => undefined,
		getConnections: (): never[] => [],
		getMultiaddrs: (): never[] => [],
		getProtocols: (): string[] => [AMINO_DHT_PROTOCOL],
		isDialable: (): Promise<boolean> => Promise.resolve(false),
		peerId,
		peerRouting: {
			findPeer: (_peerId: unknown, callOptions: { signal: AbortSignal }): Promise<never> =>
				waitForAbort(callOptions.signal),

			async *getClosestPeers(
				_key: Uint8Array,
				callOptions: { signal: AbortSignal }
			): AsyncIterable<{ id: typeof peerId; multiaddrs: never[] }> {
				await abortableFixtureDelay(options.closestPeerDelayMs, callOptions.signal);
				yield { id: peerId, multiaddrs: [] };
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
		closestPeersTimeoutMs: options.closestPeersTimeoutMs,
		limits: {
			maxAddressesPerPeer: 16,
			maxNetworkRequests: 8,
			maxOperations: 4,
			maxResults: 16,
		},
		network: "public",
		resolver: { resolve: (): Promise<string[]> => Promise.resolve([]) },
	});
}

function fakeHighBreadthClosestPeersRouting(progressEvents: number): NodeRouting {
	const peerId = peerIdFromString(TEST_PEER_ID);
	const address = multiaddr("/ip4/8.8.8.8/tcp/4001");
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
				options.onProgress?.({ type: "kad-dht:query:send-query" });
				return Promise.resolve({ id: peerId, multiaddrs: [address] });
			},

			async *getClosestPeers(
				_key: Uint8Array,
				options: { onProgress?(event: { type: string }): void }
			): AsyncIterable<{ id: typeof peerId; multiaddrs: ReturnType<typeof multiaddr>[] }> {
				await Promise.resolve();
				for (let index = 0; index < progressEvents; index += 1) {
					options.onProgress?.({ type: "kad-dht:query:send-query" });
				}
				yield { id: peerId, multiaddrs: [address] };
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
			maxOperations: 2,
			maxResults: 16,
		},
		network: "public",
		resolver: { resolve: (): Promise<string[]> => Promise.resolve([]) },
	});
}

function fakeStreamingClosestPeersRouting(closestPeersTimeoutMs: number): NodeRouting {
	const peerId = peerIdFromString(TEST_PEER_ID);
	const host = {
		addEventListener: (): void => undefined,
		getConnections: (): never[] => [],
		getMultiaddrs: (): never[] => [],
		getProtocols: (): string[] => [AMINO_DHT_PROTOCOL],
		isDialable: (): Promise<boolean> => Promise.resolve(false),
		peerId,
		peerRouting: {
			async *getClosestPeers(
				_key: Uint8Array,
				options: { signal: AbortSignal }
			): AsyncIterable<{ id: typeof peerId; multiaddrs: never[] }> {
				for (let index = 0; index < 3; index += 1) {
					yield { id: peerId, multiaddrs: [] };
				}
				await waitForAbort(options.signal);
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
		closestPeersTimeoutMs,
		limits: {
			maxAddressesPerPeer: 16,
			maxNetworkRequests: 8,
			maxOperations: 4,
			maxResults: 16,
		},
		network: "public",
		resolver: { resolve: (): Promise<string[]> => Promise.resolve([]) },
	});
}

function fakeUnboundedClosestPeersRouting(maxRequests: number): {
	progressEvents(): number;
	readonly routing: NodeRouting;
	walkSignal(): AbortSignal | undefined;
} {
	const peerId = peerIdFromString(TEST_PEER_ID);
	let observedSignal: AbortSignal | undefined;
	let progressEvents = 0;
	const host = {
		addEventListener: (): void => undefined,
		getConnections: (): never[] => [],
		getMultiaddrs: (): never[] => [],
		getProtocols: (): string[] => [AMINO_DHT_PROTOCOL],
		isDialable: (): Promise<boolean> => Promise.resolve(false),
		peerId,
		peerRouting: {
			async *getClosestPeers(
				_key: Uint8Array,
				options: { onProgress?(event: { type: string }): void; signal: AbortSignal }
			): AsyncIterable<never> {
				observedSignal = options.signal;
				while (!options.signal.aborted) {
					progressEvents += 1;
					options.onProgress?.({ type: "kad-dht:query:send-query" });
					await Promise.resolve();
				}
				yield* [];
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
	const routing = new NodeRouting({ stop: (): Promise<void> => Promise.resolve() } as never, host as never, {
		closestPeersMaxNetworkRequests: maxRequests,
		closestPeersTimeoutMs: 1_000,
		limits: {
			maxAddressesPerPeer: 16,
			maxNetworkRequests: 1,
			maxOperations: 4,
			maxResults: 16,
		},
		network: "public",
		resolver: { resolve: (): Promise<string[]> => Promise.resolve([]) },
	});
	return {
		progressEvents: (): number => progressEvents,
		routing,
		walkSignal: (): AbortSignal | undefined => observedSignal,
	};
}

function fakeConcurrentOverCapClosestPeersRouting(maxRequests: number): {
	progressEvents(): number;
	readonly routing: NodeRouting;
	walkSignal(): AbortSignal | undefined;
} {
	const peerId = peerIdFromString(TEST_PEER_ID);
	let observedSignal: AbortSignal | undefined;
	let progressEvents = 0;
	const host = {
		addEventListener: (): void => undefined,
		getConnections: (): never[] => [],
		getMultiaddrs: (): never[] => [],
		getProtocols: (): string[] => [AMINO_DHT_PROTOCOL],
		isDialable: (): Promise<boolean> => Promise.resolve(false),
		peerId,
		peerRouting: {
			// eslint-disable-next-line @typescript-eslint/require-await -- interface-required async generator
			async *getClosestPeers(
				_key: Uint8Array,
				options: { onProgress?(event: { type: string }): void; signal: AbortSignal }
			): AsyncIterable<{ id: typeof peerId; multiaddrs: never[] }> {
				observedSignal = options.signal;
				yield { id: peerId, multiaddrs: [] };
				for (let index = 0; index < maxRequests + 2; index += 1) {
					progressEvents += 1;
					options.onProgress?.({ type: "kad-dht:query:send-query" });
				}
				options.signal.throwIfAborted();
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
	const routing = routingWithWalkHost(host, maxRequests);
	return {
		progressEvents: (): number => progressEvents,
		routing,
		walkSignal: (): AbortSignal | undefined => observedSignal,
	};
}

function fakeEarlyCloseClosestPeersRouting(): {
	closed(): boolean;
	readonly routing: NodeRouting;
	walkSignal(): AbortSignal | undefined;
} {
	const peerId = peerIdFromString(TEST_PEER_ID);
	let observedSignal: AbortSignal | undefined;
	let iteratorClosed = false;
	const host = {
		addEventListener: (): void => undefined,
		getConnections: (): never[] => [],
		getMultiaddrs: (): never[] => [],
		getProtocols: (): string[] => [AMINO_DHT_PROTOCOL],
		isDialable: (): Promise<boolean> => Promise.resolve(false),
		peerId,
		peerRouting: {
			// eslint-disable-next-line @typescript-eslint/require-await -- interface-required async generator
			async *getClosestPeers(
				_key: Uint8Array,
				options: { signal: AbortSignal }
			): AsyncIterable<{ id: typeof peerId; multiaddrs: never[] }> {
				observedSignal = options.signal;
				try {
					yield { id: peerId, multiaddrs: [] };
					yield { id: peerId, multiaddrs: [] };
				} finally {
					iteratorClosed = true;
				}
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
	const routing = routingWithWalkHost(host, 8);
	return {
		closed: (): boolean => iteratorClosed,
		routing,
		walkSignal: (): AbortSignal | undefined => observedSignal,
	};
}

function routingWithWalkHost(host: object, maxRequests: number): NodeRouting {
	return new NodeRouting({ stop: (): Promise<void> => Promise.resolve() } as never, host as never, {
		closestPeersMaxNetworkRequests: maxRequests,
		closestPeersTimeoutMs: 1_000,
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

async function abortableFixtureDelay(durationMs: number, signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(resolve, durationMs);
		const onAbort = (): void => {
			clearTimeout(timeout);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
	return new Promise<never>((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

async function collect<Value>(source: AsyncIterable<Value>): Promise<Value[]> {
	const values: Value[] = [];
	for await (const value of source) values.push(value);
	return values;
}
