import type { DRPNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const createDnsResolver = vi.hoisted(() => vi.fn());
const sharedResolve = vi.hoisted(() =>
	vi.fn((hostname: string, _signal: AbortSignal, family: "ipv4" | "ipv6" | undefined) =>
		Promise.resolve(hostname === "relay.example" && family === "ipv4" ? ["8.8.8.8"] : [])
	)
);

vi.mock("@ts-drp/rendezvous", async (importOriginal) => {
	const actual = await importOriginal<object>();
	createDnsResolver.mockImplementation(() => ({ resolve: sharedResolve }));
	return { ...actual, createDnsResolver };
});

import { DRPNode } from "../src/index.js";

const CID = "bafkreigh2akiscaildcuxp5g4t5s6xrk5g3w7i7xvq5y5u5h5gj5f3f6aa";
const PEER = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";
const PRIMARY = "https://primary.routing.example/v1/";
const SECONDARY = "https://secondary.routing.example/v1/";
const ACCEPTED_DNS_WSS = "/dns4/relay.example/tcp/443/tls/ws";
const LOOPBACK_WS_RELAY = "/ip4/127.0.0.1/tcp/50000/ws";

interface PhaseThreeBrowserConfig {
	readonly allow_insecure_loopback_fixture?: boolean;
	readonly allow_single_endpoint_fixture?: boolean;
	readonly endpoints?: readonly string[];
	readonly limits?: {
		readonly maxAddressesPerPeer?: number;
		readonly maxEndpoints?: number;
		readonly maxResponseBytes?: number;
		readonly maxResults?: number;
	};
}

interface BrowserRoutingPeer {
	acceptedAddresses: string[];
	peerId: string;
}

interface BrowserRouting {
	readonly lastTrace:
		| {
				attempts: Array<{ status: "aborted" | "empty" | "failure" | "success" }>;
		  }
		| undefined;
	findProviders(cid: string, signal: AbortSignal): AsyncIterable<BrowserRoutingPeer>;
	stop(): Promise<void>;
}

type RoutedNode = DRPNode & { readonly routing: BrowserRouting | undefined };

afterEach(() => {
	vi.unstubAllGlobals();
	sharedResolve.mockClear();
});

describe("DRPNode browser routing wiring", () => {
	it("does not construct delegated browser routing while its public rollout canary is off", () => {
		const node = createNode({ endpoints: [PRIMARY, SECONDARY] }, false);
		expect(node.routing).toBeUndefined();
	});

	it("rejects fewer than two configured endpoints outside the explicit fixture escape hatch", () => {
		expect(() => createNode({ endpoints: [PRIMARY] })).toThrow(/at least two|two.*endpoint|endpoint.*2/iu);
	});

	it("rejects duplicate endpoints and same-origin endpoint pairs", () => {
		expect(() => createNode({ endpoints: [PRIMARY, PRIMARY] })).toThrow(/two distinct endpoint origins/iu);
		expect(() => createNode({ endpoints: [PRIMARY, `${PRIMARY}alternate/`] })).toThrow(
			/two distinct endpoint origins/iu
		);
	});

	it("names an unparseable endpoint in a clear configuration error", () => {
		expect(() => createNode({ endpoints: [PRIMARY, "not a URL"] })).toThrow(
			'Browser routing endpoint 2 is not a valid URL: "not a URL"'
		);
	});

	it("rejects an empty endpoint fixture explicitly", () => {
		expect(() => createNode({ allow_single_endpoint_fixture: true, endpoints: [] })).toThrow(
			/at least one delegated endpoint.*single-endpoint fixture/iu
		);
	});

	it("allows one endpoint only when allow_single_endpoint_fixture is true", async () => {
		const node = createNode({ allow_single_endpoint_fixture: true, endpoints: [PRIMARY] });
		try {
			expect(node.routing).toBeDefined();
		} finally {
			await node.routing?.stop();
		}
	});

	it("passes the insecure-loopback fixture flag to delegated routing", async () => {
		const node = createNode({
			allow_insecure_loopback_fixture: true,
			allow_single_endpoint_fixture: true,
			endpoints: ["http://127.0.0.1:4100/routing/v1/"],
		});
		try {
			expect(node.routing).toBeDefined();
		} finally {
			await node.routing?.stop();
		}
	});

	it("accepts a loopback WebSocket relay address only when the insecure-loopback fixture flag is set", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>(() => Promise.resolve(loopbackProviderResponse()))
		);
		const enabled = createNode({
			allow_insecure_loopback_fixture: true,
			endpoints: [PRIMARY, SECONDARY],
		});
		try {
			if (enabled.routing === undefined) throw new Error("DRPNode.routing is missing");
			const providers = await collect(enabled.routing.findProviders(CID, AbortSignal.timeout(2_000)));
			// Regression: config-driven routing must relax the loopback WebSocket + loopback-address
			// allowances together (not only allowInsecureLoopback), or fixture relay addresses are dropped.
			expect(providers).toHaveLength(1);
			expect(providers[0]?.acceptedAddresses).toEqual([LOOPBACK_WS_RELAY]);
		} finally {
			await enabled.routing?.stop();
		}
	});

	it("drops a loopback WebSocket relay address without the insecure-loopback fixture flag", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>(() => Promise.resolve(loopbackProviderResponse()))
		);
		const secured = createNode({ endpoints: [PRIMARY, SECONDARY] });
		try {
			if (secured.routing === undefined) throw new Error("DRPNode.routing is missing");
			const providers = await collect(secured.routing.findProviders(CID, AbortSignal.timeout(2_000)));
			expect(providers.every((provider) => provider.acceptedAddresses.length === 0)).toBe(true);
		} finally {
			await secured.routing?.stop();
		}
	});

	it("exposes ordered failover, derived origins, the shared resolver, and configured limits", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>((input) => {
			const url = new URL(String(input));
			if (url.origin === new URL(PRIMARY).origin) {
				return Promise.resolve(new Response("primary unavailable", { status: 500 }));
			}
			return Promise.resolve(providerResponse());
		});
		vi.stubGlobal("fetch", fetch);
		const node = createNode({
			endpoints: [PRIMARY, SECONDARY],
			limits: { maxAddressesPerPeer: 2, maxEndpoints: 2, maxResponseBytes: 8_192, maxResults: 1 },
		});

		try {
			expect(node.routing).toBeDefined();
			if (node.routing === undefined) throw new Error("DRPNode.routing is missing");
			const providers = await collect(node.routing.findProviders(CID, AbortSignal.timeout(2_000)));
			expect(providers).toHaveLength(1);
			expect(providers[0]).toMatchObject<Partial<BrowserRoutingPeer>>({
				acceptedAddresses: [ACCEPTED_DNS_WSS],
				peerId: PEER,
			});
			expect(fetch.mock.calls.map(([input]) => new URL(String(input)).origin)).toEqual([
				new URL(PRIMARY).origin,
				new URL(SECONDARY).origin,
			]);
			expect(node.routing.lastTrace?.attempts.map(({ status }) => status)).toEqual(["failure", "success"]);
			expect(createDnsResolver).toHaveBeenCalled();
			expect(sharedResolve).toHaveBeenCalledWith("relay.example", expect.any(AbortSignal), "ipv4");
		} finally {
			await node.routing?.stop();
		}
	});
});

function createNode(browser: PhaseThreeBrowserConfig, delegatedRoutingEnabled = true): RoutedNode {
	const config = {
		log_config: { level: "silent" as const },
		network_config: {
			bootstrap_peers: [],
			control_plane: {
				rollout: {
					public_components: { delegated_routing: { enabled: delegatedRoutingEnabled } },
				},
				routing: { browser },
			},
		},
	} as unknown as DRPNodeConfig;
	return new DRPNode(config) as RoutedNode;
}

function loopbackProviderResponse(): Response {
	return new Response(
		JSON.stringify({
			Providers: [{ Addrs: [LOOPBACK_WS_RELAY], ID: PEER, Protocols: ["transport-bitswap"], Schema: "peer" }],
		}),
		{ headers: { "content-type": "application/json" }, status: 200 }
	);
}

function providerResponse(): Response {
	return new Response(
		JSON.stringify({
			Providers: [
				{ Addrs: [ACCEPTED_DNS_WSS], ID: PEER, Protocols: ["transport-bitswap"], Schema: "peer" },
				{
					Addrs: ["/ip4/8.8.4.4/tcp/443/tls/ws"],
					ID: "QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
					Protocols: ["transport-bitswap"],
					Schema: "peer",
				},
			],
		}),
		{ headers: { "content-type": "application/json" }, status: 200 }
	);
}

async function collect<Value>(source: AsyncIterable<Value>): Promise<Value[]> {
	const values: Value[] = [];
	for await (const value of source) values.push(value);
	return values;
}
