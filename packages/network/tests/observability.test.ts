import { type ConnectionGater, type Libp2p } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import { type ControlPlaneEvent, type DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DRPNetworkNode } from "../src/node.js";

type AddressAdmissionEvent = Extract<ControlPlaneEvent, { kind: "address-admission" }>;

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

function createNode(config: DRPNetworkNodeConfig): DRPNetworkNode {
	return new DRPNetworkNode(config);
}

function outboundGate(node: DRPNetworkNode): NonNullable<ConnectionGater["denyDialMultiaddr"]> {
	const host = node["_node"] as InspectableHost | undefined;
	const gate = host?.components.connectionGater.denyDialMultiaddr;
	if (gate === undefined) throw new Error("expected a libp2p outbound multiaddr gate");
	return gate;
}

describe("Phase 2 sanitized observability", () => {
	const startedNodes: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(
			startedNodes.splice(0).map(async (node) => {
				if (node["_node"]?.status !== "stopped") await node.stop();
			})
		);
	});

	test("a denied address admission emits only bounded categorical address fields", async () => {
		const events: ControlPlaneEvent[] = [];
		const sink = vi.fn((event: ControlPlaneEvent) => events.push(event));
		const node = createNode({
			...baseConfig,
			control_plane: {
				address_policy: { target: "node" },
				observability: { sink },
			},
		});
		startedNodes.push(node);
		await node.start();

		const rawAddress = "/ip4/127.0.0.1/tcp/443/ws";
		await expect(Promise.resolve(outboundGate(node)(multiaddr(rawAddress)))).resolves.toBe(true);

		const denied = events.find(
			(event): event is AddressAdmissionEvent => event.kind === "address-admission" && event.outcome === "denied"
		);
		expect(denied).toEqual({
			family: "ipv4",
			kind: "address-admission",
			outcome: "denied",
			reason: "scope-loopback",
			scope: "loopback",
			transport: "ws",
		});
		expect(JSON.stringify(denied)).not.toContain(rawAddress);
		expect(denied).not.toHaveProperty("address");
		expect(denied).not.toHaveProperty("multiaddr");
		expect(denied).not.toHaveProperty("peerId");
	});

	test("no control plane keeps the gate inert and does not require a sink", async () => {
		const sink = vi.fn();
		const node = createNode(baseConfig);
		startedNodes.push(node);
		await node.start();

		await expect(Promise.resolve(outboundGate(node)(multiaddr("/ip4/127.0.0.1/tcp/443")))).resolves.toBe(false);
		expect(sink).not.toHaveBeenCalled();
	});

	test("attributes injected-gate dial denials to the bounded injected-policy reason", async () => {
		const events: ControlPlaneEvent[] = [];
		const node = new DRPNetworkNode(
			{
				...baseConfig,
				control_plane: { observability: { sink: (event): void => void events.push(event) } },
			},
			{ hostPolicy: { denyDialMultiaddr: (): true => true } }
		);
		startedNodes.push(node);
		await node.start();

		await expect(
			node.safeDial(multiaddr("/ip4/9.9.9.9/tcp/443/wss/p2p/16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5"))
		).rejects.toThrow();
		expect(events).toContainEqual(
			expect.objectContaining({ kind: "dial-attempt", outcome: "denied", reason: "injected-policy" })
		);
	});

	test("a throwing observability sink cannot break a successful dial", async () => {
		const receiver = createNode({
			...baseConfig,
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
		});
		const sender = createNode({
			...baseConfig,
			control_plane: {
				address_policy: {
					allowInsecureWebSocket: true,
					allowLoopback: true,
					target: "node",
				},
				observability: {
					sink: (): never => {
						throw new Error("telemetry unavailable");
					},
				},
			},
		});
		startedNodes.push(receiver, sender);
		await receiver.start();
		await sender.start();
		const receiverAddress = receiver.getMultiaddrs()?.find((address) => address.includes("/ws/p2p/"));
		if (receiverAddress === undefined) throw new Error("receiver did not expose a WebSocket address");

		await expect(sender.safeDial(multiaddr(receiverAddress))).resolves.toBeDefined();
	});

	test("does not report a dial attempt for an empty candidate list", async () => {
		const events: ControlPlaneEvent[] = [];
		const node = createNode({
			...baseConfig,
			control_plane: { observability: { sink: (event): void => void events.push(event) } },
		});
		const dial = vi.fn();

		await expect(node.safeDial([], { dial } as unknown as Libp2p)).resolves.toBeUndefined();
		expect(dial).not.toHaveBeenCalled();
		expect(events.filter(({ kind }) => kind === "dial-attempt")).toEqual([]);
	});

	test("keeps peer-id-less addresses in separate dial candidate groups", async () => {
		const node = createNode(baseConfig);
		const dial = vi.fn().mockResolvedValue({});
		const first = multiaddr("/ip4/127.0.0.1/tcp/4101");
		const second = multiaddr("/ip4/127.0.0.1/tcp/4102");

		await expect(node.safeDial([first, second], { dial } as unknown as Libp2p)).resolves.toBeDefined();
		expect(dial).toHaveBeenCalledTimes(2);
		expect(
			dial.mock.calls.map(([addresses]) => (addresses as (typeof first)[]).map((address) => address.toString()))
		).toEqual([[first.toString()], [second.toString()]]);
	});
});
