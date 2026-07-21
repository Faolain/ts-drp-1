import {
	BrowserRoutingExhaustedError,
	BrowserRoutingNotFoundError,
	type BrowserRoutingOptions,
	DelegatedBrowserRouting,
} from "@ts-drp/routing-browser";
import { describe, expect, it, vi } from "vitest";

const TEST_PEER_ID = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";
const TEST_CID = "bafkreigh2akiscaildcuxp5g4t5s6xrk5g3w7i7xvq5y5u5h5gj5f3f6aa";
const ACCEPTED_WSS = "/dns4/relay.example/tcp/443/tls/ws";
const ACCEPTED_WEBTRANSPORT = "/ip4/8.8.8.8/udp/443/quic-v1/webtransport";
const REJECTED_TCP = "/ip4/8.8.4.4/tcp/4001";
const REJECTED_LOOPBACK = "/ip4/127.0.0.1/tcp/443/tls/ws";

describe("DelegatedBrowserRouting", () => {
	it("performs bounded delegated lookups and keeps only browser-dialable addresses", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>((input) => Promise.resolve(routingResponse(String(input))));
		const routing = new DelegatedBrowserRouting(options({ fetch, limits: { maxAddressesPerPeer: 3 } }));

		const peer = await routing.findPeer(TEST_PEER_ID, new AbortController().signal);
		expect(peer.peerId).toBe(TEST_PEER_ID);
		expect(peer.rawAddresses).toEqual([ACCEPTED_WSS, ACCEPTED_WEBTRANSPORT, REJECTED_TCP]);
		expect(peer.acceptedAddresses).toEqual([ACCEPTED_WSS, ACCEPTED_WEBTRANSPORT]);
		expect(peer.inputAddressCount).toBe(4);
		expect(peer.truncatedAddressCount).toBe(1);
		expect(routing.lastTrace).toMatchObject({
			cache: "miss",
			operation: "find-peer",
			resultCount: 1,
			terminal: "success",
		});

		await expect(collect(routing.findProviders(TEST_CID, new AbortController().signal))).resolves.toHaveLength(1);
		expect(routing.lastTrace?.operation).toBe("find-providers");
		await expect(
			collect(routing.getClosestPeers(new TextEncoder().encode("closest-key"), new AbortController().signal))
		).resolves.toHaveLength(1);
		expect(routing.lastTrace?.operation).toBe("get-closest-peers");
		expect(fetch).toHaveBeenCalledTimes(3);
		await routing.stop();
	});

	it("fails over in endpoint order and records the failed primary attempt", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>((input) => {
			if (String(input).includes("/primary/")) return Promise.reject(new TypeError("fixture endpoint offline"));
			return Promise.resolve(routingResponse(String(input)));
		});
		const routing = new DelegatedBrowserRouting(
			options({
				endpoints: [
					{ id: "primary", url: "http://127.0.0.1:4175/fixture/suite/primary/" },
					{ id: "secondary", url: "http://127.0.0.1:4175/fixture/suite/secondary/" },
				],
				fetch,
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

	it("enforces response and endpoint-policy bounds", async () => {
		const routing = new DelegatedBrowserRouting(
			options({
				fetch: () =>
					Promise.resolve(
						new Response("x".repeat(2048), {
							headers: { "content-length": "2048", "content-type": "application/x-ndjson" },
							status: 200,
						})
					),
				limits: { maxResponseBytes: 1024 },
			})
		);
		await expect(routing.findPeer(TEST_PEER_ID, new AbortController().signal)).rejects.toBeInstanceOf(
			BrowserRoutingExhaustedError
		);
		expect(routing.lastTrace?.attempts[0]).toMatchObject({ status: "failure" });

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
	});

	it("distinguishes an empty response from total endpoint exhaustion", async () => {
		const empty = new DelegatedBrowserRouting(
			options({ fetch: () => Promise.resolve(new Response(null, { status: 404 })) })
		);
		await expect(empty.findPeer(TEST_PEER_ID, new AbortController().signal)).rejects.toBeInstanceOf(
			BrowserRoutingNotFoundError
		);
		expect(empty.lastTrace).toMatchObject({
			attempts: [{ endpointId: "primary", httpStatus: 404, status: "empty" }],
			terminal: "empty",
		});

		const exhausted = new DelegatedBrowserRouting(
			options({
				endpoints: [
					{ id: "primary", url: "http://127.0.0.1:4175/fixture/down/primary/" },
					{ id: "secondary", url: "http://127.0.0.1:4175/fixture/down/secondary/" },
				],
				fetch: () => Promise.reject(new TypeError("offline")),
			})
		);
		const error = await exhausted.findPeer(TEST_PEER_ID, new AbortController().signal).catch((value: unknown) => value);
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
