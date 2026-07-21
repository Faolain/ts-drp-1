import { describe, expect, it } from "vitest";

import {
	type BrowserRoutingPeer,
	type BrowserRoutingTrace,
	DelegatedBrowserRouting,
} from "../src/browser-routing/index.js";
import { namespaceCid } from "../src/namespace.js";
import { PublicOnlyBrowserPeer, PublicProviderLocator } from "../src/public-only/browser.js";
import type { ActiveRelayReservation, RelayPolicy, RelayPolicyResult } from "../src/relay/index.js";

describe("PublicProviderLocator", () => {
	it("derives the CID locally and labels only delegated provider results as untrusted", async () => {
		const namespace = "opaque-browser-room";
		const expectedCid = await namespaceCid(namespace);
		let requestedCid = "";
		const locator = new PublicProviderLocator({
			findProviders: async function* (cid): AsyncGenerator<BrowserRoutingPeer> {
				requestedCid = cid;
				await Promise.resolve();
				yield peer("provider-a", ["/dns4/relay.example/tcp/443/wss/p2p/relay/p2p-circuit"]);
			},
			lastTrace: trace(1, 1),
			stop: (): Promise<void> => Promise.resolve(),
		});
		const result = await locator.locate(namespace, AbortSignal.timeout(1_000));
		expect(requestedCid).toBe(expectedCid.toString());
		expect(result).toMatchObject({
			cid: expectedCid.toString(),
			providers: [{ peerId: "provider-a", provenance: "untrusted-public-provider" }],
			terminal: "provider-visible",
		});
	});

	it("distinguishes empty routing from records whose addresses were all rejected", async () => {
		for (const [rawAddressCount, terminal] of [
			[0, "empty"],
			[2, "provider-undialable"],
		] as const) {
			const locator = new PublicProviderLocator({
				findProviders: async function* (): AsyncGenerator<BrowserRoutingPeer> {
					await Promise.resolve();
					for (const item of [] as BrowserRoutingPeer[]) yield item;
				},
				lastTrace: trace(1, rawAddressCount),
				stop: (): Promise<void> => Promise.resolve(),
			});
			await expect(locator.locate("opaque-browser-room", AbortSignal.timeout(1_000))).resolves.toMatchObject({
				providers: [],
				terminal,
			});
		}
	});

	it("classifies real delegated records with only rejected addresses as provider-undialable", async () => {
		const routing = new DelegatedBrowserRouting({
			allowInsecureLoopback: true,
			allowedOrigins: ["http://127.0.0.1:4175"],
			cacheTTLms: 0,
			endpoints: [{ id: "fixture", url: "http://127.0.0.1:4175/routing/v1/" }],
			fetch: (): Promise<Response> =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							Providers: [
								{
									Addrs: ["/ip4/8.8.8.8/tcp/4001"],
									ID: "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
									Protocols: [],
									Schema: "peer",
								},
							],
						}),
						{ headers: { "content-type": "application/json" } }
					)
				),
			resolver: { resolve: (): Promise<string[]> => Promise.resolve([]) },
		});
		const locator = new PublicProviderLocator(routing);

		await expect(locator.locate("opaque-browser-room", AbortSignal.timeout(1_000))).resolves.toMatchObject({
			providers: [],
			terminal: "provider-undialable",
			trace: { acceptedAddressCount: 0, rawAddressCount: 1 },
		});
	});

	it("has no input seam for a configured DRP Peer ID, address, registry, or fallback", () => {
		expect(PublicProviderLocator.length).toBe(1);
		expect(PublicProviderLocator.prototype.locate.length).toBe(2);
	});
});

it("requires an independent accepted relay reservation and rejects configured or emitted fallback", async () => {
	const locator = new PublicProviderLocator({
		findProviders: async function* (): AsyncGenerator<BrowserRoutingPeer> {
			await Promise.resolve();
			yield peer("provider-a", ["/dns4/provider.example/tcp/443/wss/p2p/provider-a"]);
		},
		lastTrace: trace(1, 1),
		stop: (): Promise<void> => Promise.resolve(),
	});
	const accepted = relayResult({ reservations: [activeReservation()], terminal: "reserved" });
	const ready = new PublicOnlyBrowserPeer(locator, relayPort(accepted));
	await expect(ready.bootstrap("opaque-browser-room", AbortSignal.timeout(1_000))).resolves.toMatchObject({
		terminal: "ready",
	});

	const fallback = relayResult({
		fallback: { status: "accepted" },
		reservations: [activeReservation()],
		terminal: "owned-fallback",
	});
	const rejected = new PublicOnlyBrowserPeer(locator, relayPort(fallback));
	await expect(rejected.bootstrap("opaque-browser-room", AbortSignal.timeout(1_000))).resolves.toMatchObject({
		terminal: "relay-exhausted",
	});

	expect(
		() =>
			new PublicOnlyBrowserPeer(locator, {
				...relayPort(accepted),
				hasOwnedFallback: true,
			})
	).toThrow("forbids an owned relay fallback");
});

it("preserves cancellation during provider lookup and relay acquisition", async () => {
	const controller = new AbortController();
	controller.abort(new DOMException("cancelled", "AbortError"));
	const abortedLocator = new PublicProviderLocator({
		findProviders: async function* (_cid, signal): AsyncGenerator<BrowserRoutingPeer> {
			await Promise.resolve();
			signal.throwIfAborted();
			yield peer("unreachable", []);
		},
		lastTrace: trace(0, 0),
		stop: (): Promise<void> => Promise.resolve(),
	});
	await expect(
		new PublicOnlyBrowserPeer(abortedLocator, relayPort(relayResult({}))).bootstrap(
			"opaque-browser-room",
			controller.signal
		)
	).resolves.toMatchObject({ relay: { terminal: "aborted" }, terminal: "aborted" });

	const visibleLocator = new PublicProviderLocator({
		findProviders: async function* (): AsyncGenerator<BrowserRoutingPeer> {
			await Promise.resolve();
			yield peer("provider-a", ["/dns4/provider.example/tcp/443/wss/p2p/provider-a"]);
		},
		lastTrace: trace(1, 1),
		stop: (): Promise<void> => Promise.resolve(),
	});
	await expect(
		new PublicOnlyBrowserPeer(visibleLocator, relayPort(relayResult({ terminal: "aborted" }))).bootstrap(
			"opaque-browser-room",
			AbortSignal.timeout(1_000)
		)
	).resolves.toMatchObject({ relay: { terminal: "aborted" }, terminal: "aborted" });
});

function peer(peerId: string, acceptedAddresses: string[]): BrowserRoutingPeer {
	return {
		acceptedAddresses,
		addressDecisions: [],
		inputAddressCount: acceptedAddresses.length,
		peerId,
		protocols: [],
		rawAddresses: [...acceptedAddresses],
		truncatedAddressCount: 0,
	};
}

function trace(resultCount: number, rawAddressCount: number): BrowserRoutingTrace {
	return {
		acceptedAddressCount: resultCount,
		attempts: [],
		cache: "disabled",
		durationMs: 1,
		finishedAtMs: 1,
		operation: "find-providers",
		rawAddressCount,
		resultCount,
		startedAtMs: 0,
		terminal: resultCount > 0 ? "success" : "empty",
	};
}

function relayPort(result: RelayPolicyResult): Pick<RelayPolicy, "acquire" | "hasOwnedFallback" | "stop"> {
	return {
		acquire: (): Promise<RelayPolicyResult> => Promise.resolve(result),
		hasOwnedFallback: false,
		stop: (): Promise<void> => Promise.resolve(),
	};
}

function relayResult(overrides: Partial<RelayPolicyResult>): RelayPolicyResult {
	return {
		attempts: [],
		candidatesObserved: 1,
		durationMs: 1,
		operatorGroups: ["public"],
		reservations: [],
		terminal: "exhausted",
		...overrides,
	};
}

function activeReservation(): ActiveRelayReservation {
	return {
		candidate: {
			addresses: ["/dns4/relay.example/tcp/443/wss/p2p/relay-a"],
			operatorGroup: "public-a",
			peerId: "relay-a",
			protocols: ["/libp2p/circuit/relay/0.2.0/hop"],
			provenance: {
				origin: "browser-closest-peers",
				queryDigest: "query-a",
				resultIndex: 0,
				routingSource: "delegated-routing",
			},
		},
		expiresAtMs: Date.now() + 60_000,
		limit: {},
		reservedAtMs: Date.now(),
	};
}
