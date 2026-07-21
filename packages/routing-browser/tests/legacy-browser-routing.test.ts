import {
	BrowserRoutingExhaustedError,
	BrowserRoutingNotFoundError,
	type BrowserRoutingOptions,
	DelegatedBrowserRouting,
} from "@ts-drp/routing-browser";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const TEST_PEER_ID = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";
const TEST_CID = "bafkreigh2akiscaildcuxp5g4t5s6xrk5g3w7i7xvq5y5u5h5gj5f3f6aa";
const ACCEPTED_WSS = "/dns4/relay.example/tcp/443/tls/ws";
const ACCEPTED_WEBTRANSPORT = "/ip4/8.8.8.8/udp/443/quic-v1/webtransport";
const REJECTED_TCP = "/ip4/8.8.4.4/tcp/4001";
const REJECTED_LOOPBACK = "/ip4/127.0.0.1/tcp/443/tls/ws";

describe("DelegatedBrowserRouting", () => {
	it("performs peer, provider, and closest lookups through the maintained client and filters browser addresses", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>((input) => Promise.resolve(routingResponse(String(input))));
		const routing = new DelegatedBrowserRouting(options({ fetch }));

		const peer = await routing.findPeer(TEST_PEER_ID, new AbortController().signal);
		expect(peer.peerId).toBe(TEST_PEER_ID);
		expect(peer.rawAddresses).toEqual([ACCEPTED_WSS, ACCEPTED_WEBTRANSPORT, REJECTED_TCP, REJECTED_LOOPBACK]);
		expect(peer.acceptedAddresses).toEqual([ACCEPTED_WSS, ACCEPTED_WEBTRANSPORT]);
		expect(peer.addressDecisions.filter(({ decision }) => !decision.dialable)).toHaveLength(2);
		expect(routing.lastTrace).toMatchObject({
			cache: "miss",
			operation: "find-peer",
			resultCount: 1,
			terminal: "success",
		});
		expect(fetch).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				credentials: "omit",
				redirect: "error",
				referrerPolicy: "no-referrer",
			})
		);

		const providers = await collect(routing.findProviders(TEST_CID, new AbortController().signal));
		expect(providers).toHaveLength(1);
		expect(routing.lastTrace?.operation).toBe("find-providers");

		const closest = await collect(
			routing.getClosestPeers(new TextEncoder().encode("closest-key"), new AbortController().signal)
		);
		expect(closest).toHaveLength(1);
		expect(routing.lastTrace?.operation).toBe("get-closest-peers");
		expect(fetch).toHaveBeenCalledTimes(3);
		await routing.stop();
	});

	it("keeps loopback peer records closed unless the fixture-only address escape hatch is explicit", async () => {
		const defaultRouting = new DelegatedBrowserRouting(options());
		const defaultPeer = await defaultRouting.findPeer(TEST_PEER_ID, AbortSignal.timeout(100));
		expect(defaultPeer.acceptedAddresses).not.toContain(REJECTED_LOOPBACK);

		const fixtureRouting = new DelegatedBrowserRouting(options({ allowLoopbackAddressFixture: true }));
		const fixturePeer = await fixtureRouting.findPeer(TEST_PEER_ID, AbortSignal.timeout(100));
		expect(fixturePeer.acceptedAddresses).toContain(REJECTED_LOOPBACK);
	});

	it("distinguishes a real empty/404 result from endpoint failure", async () => {
		const routing = new DelegatedBrowserRouting(
			options({
				fetch: () => Promise.resolve(new Response(null, { status: 404 })),
			})
		);

		await expect(routing.findPeer(TEST_PEER_ID, new AbortController().signal)).rejects.toBeInstanceOf(
			BrowserRoutingNotFoundError
		);
		expect(routing.lastTrace).toMatchObject({
			attempts: [{ endpointId: "primary", httpStatus: 404, status: "empty" }],
			terminal: "empty",
		});
	});

	it("preserves rejected address counts when every provider address is undialable", async () => {
		const routing = new DelegatedBrowserRouting(
			options({
				fetch: () =>
					Promise.resolve(
						jsonResponse({
							Providers: [
								{
									Addrs: [REJECTED_TCP, REJECTED_LOOPBACK],
									ID: TEST_PEER_ID,
									Protocols: [],
									Schema: "peer",
								},
							],
						})
					),
			})
		);

		await expect(collect(routing.findProviders(TEST_CID, AbortSignal.timeout(100)))).resolves.toEqual([]);
		expect(routing.lastTrace).toMatchObject({
			acceptedAddressCount: 0,
			rawAddressCount: 2,
			resultCount: 0,
			terminal: "empty",
		});
		await expect(collect(routing.findProviders(TEST_CID, AbortSignal.timeout(100)))).resolves.toEqual([]);
		expect(routing.lastTrace).toMatchObject({ cache: "hit", rawAddressCount: 2 });
	});

	it.each([
		{
			name: "malformed",
			response: (): Response =>
				new Response("{", {
					headers: { "content-type": "application/json" },
					status: 200,
				}),
		},
		{
			name: "oversized",
			response: (): Response =>
				new Response("x".repeat(2048), {
					headers: { "content-length": "2048", "content-type": "application/x-ndjson" },
					status: 200,
				}),
		},
		{
			name: "poisoned",
			response: (): Response =>
				jsonResponse({
					Peers: [{ Addrs: [ACCEPTED_WSS], ID: "not-a-peer-id", Protocols: [] }],
				}),
		},
		{
			name: "outage",
			response: (): Promise<never> => Promise.reject(new TypeError("fixture endpoint offline")),
		},
	])("fails over after a $name primary response without swallowing diagnostics", async ({ response }) => {
		const fetch = vi.fn<typeof globalThis.fetch>((input) => {
			if (String(input).includes("/primary/")) return Promise.resolve(response());
			return Promise.resolve(routingResponse(String(input)));
		});
		const routing = new DelegatedBrowserRouting(
			options({
				endpoints: [
					{ id: "primary", url: "http://127.0.0.1:4175/fixture/suite/primary/" },
					{ id: "secondary", url: "http://127.0.0.1:4175/fixture/suite/secondary/" },
				],
				fetch,
				limits: { maxResponseBytes: 1024 },
			})
		);

		await expect(routing.findPeer(TEST_PEER_ID, new AbortController().signal)).resolves.toMatchObject({
			peerId: TEST_PEER_ID,
		});
		expect(routing.lastTrace?.attempts).toMatchObject([
			{ endpointId: "primary", status: "failure" },
			{ endpointId: "secondary", status: "success" },
		]);
	});

	it("records 429 Retry-After and ordered endpoint failover", async () => {
		const routing = new DelegatedBrowserRouting(
			options({
				endpoints: [
					{ id: "primary", url: "http://127.0.0.1:4175/fixture/rate/primary/" },
					{ id: "secondary", url: "http://127.0.0.1:4175/fixture/rate/secondary/" },
				],
				fetch: (input) => {
					if (String(input).includes("/primary/")) {
						return Promise.resolve(jsonResponse({ Peers: [] }, { "retry-after": "0.05" }, 429));
					}
					return Promise.resolve(routingResponse(String(input)));
				},
			})
		);

		await routing.findPeer(TEST_PEER_ID, new AbortController().signal);
		expect(routing.lastTrace?.attempts).toMatchObject([
			{ endpointId: "primary", httpStatus: 429, retryAfterMs: 50, status: "failure" },
			{ endpointId: "secondary", status: "success" },
		]);
	});

	it("uses the injected clock for HTTP-date Retry-After", async () => {
		const now = Date.parse("2026-07-20T13:00:00.000Z");
		const routing = new DelegatedBrowserRouting(
			options({
				endpoints: [
					{ id: "primary", url: "http://127.0.0.1:4175/fixture/rate-date/primary/" },
					{ id: "secondary", url: "http://127.0.0.1:4175/fixture/rate-date/secondary/" },
				],
				fetch: (input) => {
					if (String(input).includes("/primary/")) {
						return Promise.resolve(
							jsonResponse({ Peers: [] }, { "retry-after": "Mon, 20 Jul 2026 13:00:01 GMT" }, 429)
						);
					}
					return Promise.resolve(routingResponse(String(input)));
				},
				now: () => now,
			})
		);

		await routing.findPeer(TEST_PEER_ID, new AbortController().signal);
		expect(routing.lastTrace?.attempts[0]).toMatchObject({
			retryAfterMs: 1_000,
			status: "failure",
		});
	});

	it("surfaces all-endpoint exhaustion with the exact attempt trace", async () => {
		const routing = new DelegatedBrowserRouting(
			options({
				endpoints: [
					{ id: "primary", url: "http://127.0.0.1:4175/fixture/down/primary/" },
					{ id: "secondary", url: "http://127.0.0.1:4175/fixture/down/secondary/" },
				],
				fetch: () => Promise.reject(new TypeError("offline")),
			})
		);

		const error = await routing.findPeer(TEST_PEER_ID, new AbortController().signal).catch((value: unknown) => value);
		expect(error).toBeInstanceOf(BrowserRoutingExhaustedError);
		expect((error as BrowserRoutingExhaustedError).trace).toMatchObject({
			attempts: [
				{ endpointId: "primary", status: "failure" },
				{ endpointId: "secondary", status: "failure" },
			],
			terminal: "exhausted",
		});
	});

	it("honors caller abort while an endpoint request is pending", async () => {
		const routing = new DelegatedBrowserRouting(
			options({
				fetch: async (_input, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
							{ once: true }
						);
					}),
			})
		);
		const controller = new AbortController();
		const pending = routing.findPeer(TEST_PEER_ID, controller.signal);
		controller.abort(new DOMException("fixture abort", "AbortError"));

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(routing.lastTrace?.terminal).toBe("aborted");
	});

	it("records caller abort while waiting for endpoint backoff", async () => {
		const now = 1_000;
		let markSleepStarted = (): void => undefined;
		const sleepStarted = new Promise<void>((resolve) => {
			markSleepStarted = resolve;
		});
		const routing = new DelegatedBrowserRouting(
			options({
				fetch: () => Promise.reject(new TypeError("offline")),
				now: () => now,
				sleep: async (_durationMs, signal) => {
					markSleepStarted();
					await new Promise<void>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")), {
							once: true,
						});
					});
				},
			})
		);

		await expect(routing.findPeer(TEST_PEER_ID, new AbortController().signal)).rejects.toBeInstanceOf(
			BrowserRoutingExhaustedError
		);
		const controller = new AbortController();
		const pending = routing.findPeer(TEST_PEER_ID, controller.signal);
		await sleepStarted;
		controller.abort(new DOMException("backoff abort", "AbortError"));

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(routing.lastTrace).toMatchObject({
			attempts: [
				{
					backoffMs: 1,
					endpointId: "primary",
					status: "aborted",
				},
			],
			terminal: "aborted",
		});
	});

	it("bounds a stalled endpoint with its own timeout and continues to the next endpoint", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
			if (String(input).includes("/primary/")) {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
						{ once: true }
					);
				});
			}
			return Promise.resolve(routingResponse(String(input)));
		});
		const routing = new DelegatedBrowserRouting(
			options({
				endpoints: [
					{ id: "primary", url: "http://127.0.0.1:4175/fixture/timeout/primary/" },
					{ id: "secondary", url: "http://127.0.0.1:4175/fixture/timeout/secondary/" },
				],
				fetch,
				timeoutMs: 10,
			})
		);

		await expect(routing.findPeer(TEST_PEER_ID, new AbortController().signal)).resolves.toMatchObject({
			peerId: TEST_PEER_ID,
		});
		expect(routing.lastTrace?.attempts).toMatchObject([
			{ endpointId: "primary", status: "failure" },
			{ endpointId: "secondary", status: "success" },
		]);
		expect(routing.lastTrace?.attempts[0]?.error).toMatch(/TimeoutError/u);
	});

	it("owns cache hit, stale refresh, and disabled-cache semantics", async () => {
		let now = 1_000;
		const fetch = vi.fn<typeof globalThis.fetch>((input) => Promise.resolve(routingResponse(String(input))));
		const routing = new DelegatedBrowserRouting(
			options({
				cacheTTLms: 50,
				fetch,
				now: () => now,
			})
		);
		await routing.findPeer(TEST_PEER_ID, new AbortController().signal);
		await routing.findPeer(TEST_PEER_ID, new AbortController().signal);
		expect(routing.lastTrace?.cache).toBe("hit");
		expect(fetch).toHaveBeenCalledTimes(1);

		now += 51;
		await routing.findPeer(TEST_PEER_ID, new AbortController().signal);
		expect(routing.lastTrace?.cache).toBe("stale");
		expect(fetch).toHaveBeenCalledTimes(2);

		const uncachedFetch = vi.fn<typeof globalThis.fetch>((input) => Promise.resolve(routingResponse(String(input))));
		const uncached = new DelegatedBrowserRouting(options({ cacheTTLms: 0, fetch: uncachedFetch }));
		await uncached.findPeer(TEST_PEER_ID, new AbortController().signal);
		await uncached.findPeer(TEST_PEER_ID, new AbortController().signal);
		expect(uncached.lastTrace?.cache).toBe("disabled");
		expect(uncachedFetch).toHaveBeenCalledTimes(2);
	});

	it("rejects endpoints outside the allowlist, credentials, and non-HTTPS public origins", () => {
		expect(
			() =>
				new DelegatedBrowserRouting(
					options({
						allowedOrigins: ["https://allowed.example"],
						endpoints: [{ id: "primary", url: "https://denied.example/" }],
					})
				)
		).toThrow(/allowlist/u);
		expect(
			() =>
				new DelegatedBrowserRouting(
					options({
						allowedOrigins: ["https://allowed.example"],
						endpoints: [{ id: "primary", url: "https://token@allowed.example/" }],
					})
				)
		).toThrow(/credentials/u);
		expect(
			() =>
				new DelegatedBrowserRouting(
					options({
						allowInsecureLoopback: false,
						allowedOrigins: ["http://routing.example"],
						endpoints: [{ id: "primary", url: "http://routing.example/" }],
					})
				)
		).toThrow(/HTTPS/u);
	});

	it("bundles the adapter for browsers without Node routing or builtin modules", async () => {
		const bundle = await build({
			bundle: true,
			entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
			format: "esm",
			metafile: true,
			platform: "browser",
			write: false,
		});
		const inputs = Object.keys(bundle.metafile.inputs);
		expect(inputs.some((input) => input.includes("@libp2p+kad-dht"))).toBe(false);
		expect(inputs.some((input) => input.includes("@libp2p+tcp"))).toBe(false);
		expect(inputs.some((input) => input.includes("/node-routing/"))).toBe(false);
	});
});

function options(overrides: Partial<BrowserRoutingOptions> = {}): BrowserRoutingOptions {
	return {
		allowInsecureLoopback: true,
		allowedOrigins: ["http://127.0.0.1:4175"],
		backoffBaseMs: 1,
		cacheTTLms: 60_000,
		endpoints: [{ id: "primary", url: "http://127.0.0.1:4175/fixture/suite/primary/" }],
		fetch: (input) => Promise.resolve(routingResponse(String(input))),
		resolver: {
			resolve(hostname): Promise<string[]> {
				return Promise.resolve(hostname === "relay.example" ? ["8.8.8.8"] : []);
			},
		},
		sleep: () => Promise.resolve(),
		timeoutMs: 100,
		...overrides,
	};
}

function routingResponse(url: string): Response {
	const collection = url.includes("/providers/") ? "Providers" : "Peers";
	return jsonResponse({
		[collection]: [
			{
				Addrs: [ACCEPTED_WSS, ACCEPTED_WEBTRANSPORT, REJECTED_TCP, REJECTED_LOOPBACK],
				ID: TEST_PEER_ID,
				Protocols: ["transport-bitswap"],
				Schema: "peer",
			},
		],
	});
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json", ...headers },
		status,
	});
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
	const output: T[] = [];
	for await (const value of input) output.push(value);
	return output;
}
