import { type ConnectionGater, type Libp2p } from "@libp2p/interface";
import type * as MultiformatsDns from "@multiformats/dns";
import { multiaddr } from "@multiformats/multiaddr";
import { type DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	type DRPNetworkHostConfigSnapshot,
	type DRPNetworkHostFactory,
	DRPNetworkNode,
	type DRPNetworkNodeDependencies,
} from "../src/node.js";

const dnsQuery = vi.hoisted(() => vi.fn());

vi.mock("@multiformats/dns", async (importOriginal) => {
	const actual = await importOriginal<typeof MultiformatsDns>();
	return { ...actual, dns: (): { query: typeof dnsQuery } => ({ query: dnsQuery }) };
});

type InspectableHost = Libp2p & {
	components: {
		connectionGater: ConnectionGater;
	};
};

const baseConfig = {
	bootstrap_peers: [],
	listen_addresses: [],
	log_config: { level: "silent" as const },
};

function createNode(config: DRPNetworkNodeConfig, dependencies?: DRPNetworkNodeDependencies): DRPNetworkNode {
	return new DRPNetworkNode(config, dependencies);
}

function capturingFactory(capture: { snapshot?: DRPNetworkHostConfigSnapshot }): DRPNetworkHostFactory {
	return (context) => {
		capture.snapshot = context.snapshot;
		return context.createHost();
	};
}

function outboundGate(node: DRPNetworkNode): NonNullable<ConnectionGater["denyDialMultiaddr"]> {
	const host = node["_node"] as InspectableHost | undefined;
	const gate = host?.components.connectionGater.denyDialMultiaddr;
	if (gate === undefined) throw new Error("expected a libp2p outbound multiaddr gate");
	return gate;
}

function peerStoreAddressFilter(node: DRPNetworkNode): NonNullable<ConnectionGater["filterMultiaddrForPeer"]> {
	const host = node["_node"] as InspectableHost | undefined;
	const filter = host?.components.connectionGater.filterMultiaddrForPeer;
	if (filter === undefined) throw new Error("expected a libp2p peer-store address filter");
	return filter;
}

describe("Phase 2 single outbound address owner", () => {
	const startedNodes: DRPNetworkNode[] = [];

	afterEach(async () => {
		dnsQuery.mockReset();
		await Promise.allSettled(
			startedNodes.splice(0).map(async (node) => {
				if (node["_node"]?.status !== "stopped") await node.stop();
			})
		);
	});

	test("control_plane.address_policy admits a public literal and rejects private literals", async () => {
		const capture: { snapshot?: DRPNetworkHostConfigSnapshot } = {};
		const node = createNode(
			{
				...baseConfig,
				control_plane: { address_policy: { target: "node" } },
			},
			{ hostFactory: capturingFactory(capture) }
		);
		startedNodes.push(node);
		await node.start();

		const gate = outboundGate(node);
		const publicAddress = multiaddr("/ip4/9.9.9.9/tcp/443");
		const privateAddress = multiaddr("/ip4/10.0.0.1/tcp/443");
		await expect(Promise.resolve(gate(publicAddress))).resolves.toBe(false);
		await expect(Promise.resolve(gate(multiaddr("/ip4/10.0.0.1/tcp/443")))).resolves.toBe(true);
		await expect(Promise.resolve(gate(multiaddr("/ip4/127.0.0.1/tcp/443")))).resolves.toBe(true);
		const addressFilter = peerStoreAddressFilter(node);
		const localPeer = node["_node"]?.peerId;
		if (localPeer === undefined) throw new Error("expected a started libp2p peer");
		await expect(Promise.resolve(addressFilter(localPeer, publicAddress))).resolves.toBe(true);
		await expect(Promise.resolve(addressFilter(localPeer, privateAddress))).resolves.toBe(false);
		expect(capture.snapshot?.outboundAddressPolicy).toBe("address-policy");
	});

	test("rejects the reserved TEST-NET-3 range as reserved, not as a public fixture", async () => {
		const node = createNode({
			...baseConfig,
			control_plane: { address_policy: { target: "node" } },
		});
		startedNodes.push(node);
		await node.start();

		await expect(Promise.resolve(outboundGate(node)(multiaddr("/ip4/203.0.113.1/tcp/443")))).resolves.toBe(true);
	});

	test("an injected resolver admits public dns4 answers and receives the requested IPv4 family", async () => {
		const resolve = vi.fn(() => Promise.resolve(["9.9.9.9"]));
		const node = createNode({
			...baseConfig,
			control_plane: { address_policy: { resolver: { resolve }, target: "node" } },
		});
		startedNodes.push(node);
		await node.start();

		await expect(Promise.resolve(outboundGate(node)(multiaddr("/dns4/public.example/tcp/443")))).resolves.toBe(false);
		expect(resolve).toHaveBeenCalledWith("public.example", expect.any(AbortSignal), "ipv4");
	});

	test("an injected resolver rejects a dns4 answer that rebinds to a private address", async () => {
		const resolve = vi.fn(() => Promise.resolve(["192.168.1.20"]));
		const node = createNode({
			...baseConfig,
			control_plane: { address_policy: { resolver: { resolve }, target: "node" } },
		});
		startedNodes.push(node);
		await node.start();

		await expect(Promise.resolve(outboundGate(node)(multiaddr("/dns4/rebind.example/tcp/443")))).resolves.toBe(true);
		expect(resolve).toHaveBeenCalledWith("rebind.example", expect.any(AbortSignal), "ipv4");
	});

	test.each([
		{ answer: "9.9.9.9", answerType: 1, family: "dns4", queryType: 1 },
		{ answer: "9.9.9.9", answerType: "A", family: "dns4", queryType: 1 },
		{ answer: "2620:fe::fe", answerType: 28, family: "dns6", queryType: 28 },
		{ answer: "2620:fe::fe", answerType: "AAAA", family: "dns6", queryType: 28 },
	] as const)("admits $family answers whose runtime record type is $answerType", async (fixture) => {
		dnsQuery.mockResolvedValue({ Answer: [{ data: fixture.answer, type: fixture.answerType }] });
		const node = createNode({
			...baseConfig,
			control_plane: { address_policy: { target: "node" } },
		});
		startedNodes.push(node);
		await node.start();

		await expect(
			Promise.resolve(outboundGate(node)(multiaddr(`/${fixture.family}/public.example/tcp/443`)))
		).resolves.toBe(false);
		expect(dnsQuery).toHaveBeenCalledWith(
			"public.example",
			expect.objectContaining({ cached: false, types: [fixture.queryType] })
		);
	});

	test("plain dns tolerates an AAAA lookup failure when its A lookup succeeds", async () => {
		dnsQuery.mockImplementation((_hostname: string, options: { types: number[] }) =>
			options.types[0] === 1
				? Promise.resolve({ Answer: [{ data: "9.9.9.9", type: "A" }] })
				: Promise.reject(new Error("no AAAA record"))
		);
		const node = createNode({
			...baseConfig,
			control_plane: { address_policy: { target: "node" } },
		});
		startedNodes.push(node);
		await node.start();

		await expect(Promise.resolve(outboundGate(node)(multiaddr("/dns/public.example/tcp/443")))).resolves.toBe(false);
		expect(dnsQuery).toHaveBeenCalledTimes(2);
	});

	test("control_plane with only observability installs safe default admission", async () => {
		const capture: { snapshot?: DRPNetworkHostConfigSnapshot } = {};
		const node = createNode(
			{ ...baseConfig, control_plane: { observability: { sink: vi.fn() } } },
			{ hostFactory: capturingFactory(capture) }
		);
		startedNodes.push(node);
		await node.start();

		await expect(Promise.resolve(outboundGate(node)(multiaddr("/ip4/127.0.0.1/tcp/443")))).resolves.toBe(true);
		expect(capture.snapshot?.outboundAddressPolicy).toBe("address-policy");
	});

	test("no control plane preserves the legacy allow-all gate", async () => {
		const capture: { snapshot?: DRPNetworkHostConfigSnapshot } = {};
		const node = createNode(baseConfig, { hostFactory: capturingFactory(capture) });
		startedNodes.push(node);
		await node.start();

		await expect(Promise.resolve(outboundGate(node)(multiaddr("/ip4/127.0.0.1/tcp/443")))).resolves.toBe(false);
		const host = node["_node"] as InspectableHost | undefined;
		expect(host?.components.connectionGater.filterMultiaddrForPeer).toBeUndefined();
		expect(capture.snapshot?.outboundAddressPolicy).toBe("allow-all");
	});

	test("an injected hostPolicy gate remains the strongest override", async () => {
		const capture: { snapshot?: DRPNetworkHostConfigSnapshot } = {};
		const injectedGate = vi.fn(() => false);
		const node = createNode(
			{
				...baseConfig,
				control_plane: { address_policy: { target: "node" } },
			},
			{
				hostFactory: capturingFactory(capture),
				hostPolicy: { denyDialMultiaddr: injectedGate },
			}
		);
		startedNodes.push(node);
		await node.start();

		const address = multiaddr("/ip4/127.0.0.1/tcp/443");
		await expect(Promise.resolve(outboundGate(node)(address))).resolves.toBe(false);
		expect(injectedGate).toHaveBeenCalledWith(address);
		expect(capture.snapshot?.outboundAddressPolicy).toBe("injected");
	});
});
