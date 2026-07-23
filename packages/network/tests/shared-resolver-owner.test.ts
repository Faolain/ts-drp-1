import { type ConnectionGater, type Libp2p } from "@libp2p/interface";
import type * as MultiformatsDns from "@multiformats/dns";
import { multiaddr } from "@multiformats/multiaddr";
import { afterAll, describe, expect, it, vi } from "vitest";

const fallbackDnsQuery = vi.hoisted(() => vi.fn());
const sharedResolve = vi.hoisted(() => vi.fn(() => Promise.resolve(["9.9.9.9"])));
const createDnsResolver = vi.hoisted(() => vi.fn(() => ({ resolve: sharedResolve })));

vi.mock("@multiformats/dns", async (importOriginal) => {
	const actual = await importOriginal<typeof MultiformatsDns>();
	return { ...actual, dns: (): { query: typeof fallbackDnsQuery } => ({ query: fallbackDnsQuery }) };
});

vi.mock("@ts-drp/rendezvous", async (importOriginal) => {
	const actual = await importOriginal<object>();
	return { ...actual, createDnsResolver };
});

import { DRPNetworkNode } from "../src/node.js";

type InspectableHost = Libp2p & { components: { connectionGater: ConnectionGater } };

const node = new DRPNetworkNode({
	bootstrap_peers: [],
	control_plane: { address_policy: { target: "node" } },
	listen_addresses: [],
	log_config: { level: "silent" },
});

afterAll(async () => {
	if (node["_node"]?.status !== "stopped") await node.stop();
});

describe("network address gate shared resolver ownership", () => {
	it("uses the @ts-drp/rendezvous DNS adapter without changing gate behavior", async () => {
		fallbackDnsQuery.mockResolvedValue({ Answer: [{ data: "9.9.9.9", type: "A" }] });
		await node.start();
		const host = node["_node"] as InspectableHost | undefined;
		const gate = host?.components.connectionGater.denyDialMultiaddr;
		if (gate === undefined) throw new Error("expected the production outbound address gate");

		await expect(Promise.resolve(gate(multiaddr("/dns4/public.example/tcp/443")))).resolves.toBe(false);
		expect(createDnsResolver).toHaveBeenCalled();
		expect(sharedResolve).toHaveBeenCalledWith("public.example", expect.any(AbortSignal), "ipv4");
		expect(fallbackDnsQuery).not.toHaveBeenCalled();
	});
});
