import { MessageQueueManager } from "@ts-drp/message-queue";
import { DRPNetworkNode as DefaultDRPNetworkNode, type DRPNetworkHostFactory } from "@ts-drp/network";
import type { DRPNodeConfig } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { DRPNode } from "../src/index.js";

interface PhaseThreeNodeRoutingConfig {
	readonly bootstrappers?: readonly string[];
	readonly enabled?: boolean;
	readonly network?: "local" | "public";
	readonly public_network_acknowledgement?: string;
}

interface PhaseThreeConfig extends Omit<DRPNodeConfig, "network_config"> {
	readonly network_config?: NonNullable<DRPNodeConfig["network_config"]> & {
		readonly control_plane?: NonNullable<NonNullable<DRPNodeConfig["network_config"]>["control_plane"]> & {
			readonly routing?: {
				readonly node?: PhaseThreeNodeRoutingConfig;
			};
		};
	};
}

interface NodeRuntimeResult {
	node: DRPNode;
	routing: NodeRouting | undefined;
}

interface NodeRouting {
	readonly peerId: string;
	findPeer(peerId: string, signal: AbortSignal): Promise<{ peerId: string }>;
	status(signal: AbortSignal): Promise<{
		addresses: Array<{ address: string; decision: { dialable: boolean } }>;
		peerId: string;
	}>;
	stop(): Promise<void>;
	waitForRoutingTable(minimumPeers: number, signal: AbortSignal): Promise<void>;
}

interface RoutingNodeModule {
	readonly OFFICIAL_AMINO_BOOTSTRAPPERS: readonly string[];
	readonly PUBLIC_NETWORK_ACKNOWLEDGEMENT: string;
	createNodeRouting(options: { mode: "server"; network: "local" }): Promise<NodeRouting>;
}

interface NodeRuntimeModule {
	NodeRoutingRestartUnsupportedError: new () => Error;
	PublicNetworkAcknowledgementError: new () => Error;
	createNodeRuntime(
		config: DRPNodeConfig,
		dependencies?: { network?: { hostFactory?: DRPNetworkHostFactory } }
	): Promise<NodeRuntimeResult>;
	resolveNodeRoutingRuntimeConfig(config: DRPNodeConfig):
		| {
				bootstrappers: readonly string[];
				config: DRPNodeConfig;
				network: "local" | "public";
		  }
		| undefined;
}

describe("@ts-drp/node/runtime", () => {
	it.each(["absent", "disabled"] as const)("preserves plain DRPNode behavior when node routing is %s", async (mode) => {
		const { createNodeRuntime } = await loadRuntime();
		const config: PhaseThreeConfig = {
			keychain_config: { private_key_seed: `phase-three-runtime-${mode}` },
			log_config: { level: "silent" },
			network_config: {
				bootstrap_peers: [],
				listen_addresses: [],
				...(mode === "disabled" ? { control_plane: { routing: { node: { enabled: false } } } } : {}),
			},
		};

		const result = await createNodeRuntime(config as DRPNodeConfig);
		try {
			expect(result.node).toBeInstanceOf(DRPNode);
			expect(result.node.networkNode).toBeInstanceOf(DefaultDRPNetworkNode);
			expect(result.routing).toBeUndefined();
		} finally {
			await Promise.allSettled([result.node.stop()]);
		}
	});

	it("attaches Amino routing to the DRP identity and uses explicit local DHT bootstrappers", async () => {
		const { createNodeRuntime } = await loadRuntime();
		const { createNodeRouting } = await loadNodeRouting();
		const server = await createNodeRouting({ mode: "server", network: "local" });
		let runtime: NodeRuntimeResult | undefined;
		try {
			const status = await server.status(AbortSignal.timeout(3_000));
			const address = status.addresses.find(({ decision }) => decision.dialable)?.address;
			if (address === undefined) throw new Error("local DHT fixture has no dialable address");
			const bootstrapper = withPeerId(address, server.peerId);
			const config: PhaseThreeConfig = {
				keychain_config: { private_key_seed: "phase-three-runtime-enabled" },
				log_config: { level: "silent" },
				network_config: {
					bootstrap_peers: [],
					control_plane: {
						address_policy: { allowLoopback: true, target: "node" },
						routing: { node: { bootstrappers: [bootstrapper], enabled: true, network: "local" } },
					},
					listen_addresses: ["/ip4/127.0.0.1/tcp/0"],
					log_config: { level: "silent" },
				},
			};

			runtime = await createNodeRuntime(config as DRPNodeConfig);
			expect(runtime.routing).toBeDefined();
			if (runtime.routing === undefined) throw new Error("node runtime did not attach routing");
			expect(runtime.routing.peerId).toBe(runtime.node.networkNode.peerId);
			expect(runtime.node.networkNode.getBootstrapNodes()).toEqual([bootstrapper]);
			await runtime.routing.waitForRoutingTable(1, AbortSignal.timeout(6_000));
			await expect(runtime.routing.findPeer(server.peerId, AbortSignal.timeout(3_000))).resolves.toMatchObject({
				peerId: server.peerId,
			});
		} finally {
			await Promise.allSettled([runtime?.node.stop(), server.stop()]);
		}
	}, 12_000);

	it("defaults omitted routing network to local and merges configured bootstrappers without duplicates", async () => {
		const { resolveNodeRoutingRuntimeConfig } = await loadRuntime();
		const userPeer = "/ip4/127.0.0.1/tcp/4101/p2p/QmUserPeer";
		const routingPeer = "/ip4/127.0.0.1/tcp/4102/p2p/QmRoutingPeer";
		const resolved = resolveNodeRoutingRuntimeConfig({
			network_config: {
				bootstrap_peers: [userPeer],
				control_plane: {
					routing: { node: { bootstrappers: [userPeer, routingPeer], enabled: true } },
				},
			},
		} as DRPNodeConfig);

		expect(resolved?.network).toBe("local");
		expect(resolved?.bootstrappers).toEqual([userPeer, routingPeer]);
		expect(resolved?.config.network_config?.bootstrap_peers).toEqual([userPeer, routingPeer]);
	});

	it("validates acknowledged public defaults without constructing or starting a node", async () => {
		const { resolveNodeRoutingRuntimeConfig } = await loadRuntime();
		const { OFFICIAL_AMINO_BOOTSTRAPPERS, PUBLIC_NETWORK_ACKNOWLEDGEMENT } = await loadNodeRouting();
		const resolved = resolveNodeRoutingRuntimeConfig({
			network_config: {
				bootstrap_peers: [],
				control_plane: {
					routing: {
						node: {
							enabled: true,
							network: "public",
							public_network_acknowledgement: PUBLIC_NETWORK_ACKNOWLEDGEMENT,
						},
					},
				},
			},
		} as DRPNodeConfig);

		expect(resolved?.network).toBe("public");
		expect(resolved?.bootstrappers).toEqual([...OFFICIAL_AMINO_BOOTSTRAPPERS]);
	});

	it("rejects public routing without the exact acknowledgement before any host starts", async () => {
		const { createNodeRuntime, PublicNetworkAcknowledgementError } = await loadRuntime();
		await expect(
			createNodeRuntime({
				network_config: {
					control_plane: { routing: { node: { enabled: true, network: "public" } } },
				},
			} as DRPNodeConfig)
		).rejects.toBeInstanceOf(PublicNetworkAcknowledgementError);
	});

	it("rejects restart before replacing the routed host and later stops that current host", async () => {
		const { createNodeRuntime, NodeRoutingRestartUnsupportedError } = await loadRuntime();
		let host: Awaited<ReturnType<DRPNetworkHostFactory>> | undefined;
		const hostFactory: DRPNetworkHostFactory = async (context) => {
			host = await context.createHost();
			return host;
		};
		const runtime = await createNodeRuntime(
			{
				keychain_config: { private_key_seed: "phase-three-runtime-restart" },
				log_config: { level: "silent" },
				network_config: {
					bootstrap_peers: [],
					control_plane: { routing: { node: { enabled: true, network: "local" } } },
					listen_addresses: ["/ip4/127.0.0.1/tcp/0"],
					log_config: { level: "silent" },
				},
			} as DRPNodeConfig,
			{ network: { hostFactory } }
		);
		if (runtime.routing === undefined) throw new Error("node runtime did not attach routing");
		if (host === undefined) throw new Error("runtime host was not captured");

		try {
			expect(host.status).toBe("started");
			await expect(runtime.node.restart()).rejects.toBeInstanceOf(NodeRoutingRestartUnsupportedError);
			expect(host.status).toBe("started");
			await expect(runtime.routing.status(AbortSignal.timeout(3_000))).resolves.toMatchObject({
				peerId: runtime.routing.peerId,
			});
			await runtime.node.stop();
			expect(host.status).toBe("stopped");
		} finally {
			if (host.status === "started") await runtime.node.stop();
		}
	}, 12_000);

	it("stops a host when DRPNode startup throws after the network has started", async () => {
		const { createNodeRuntime } = await loadRuntime();
		let host: Awaited<ReturnType<DRPNetworkHostFactory>> | undefined;
		const hostFactory: DRPNetworkHostFactory = async (context) => {
			host = await context.createHost();
			return host;
		};
		const startAll = vi.spyOn(MessageQueueManager.prototype, "startAll").mockImplementationOnce(() => {
			throw new Error("mid-start fixture failure");
		});

		try {
			await expect(
				createNodeRuntime(
					{
						keychain_config: { private_key_seed: "phase-three-runtime-mid-start" },
						log_config: { level: "silent" },
						network_config: {
							bootstrap_peers: [],
							control_plane: { routing: { node: { enabled: true, network: "local" } } },
							listen_addresses: ["/ip4/127.0.0.1/tcp/0"],
							log_config: { level: "silent" },
						},
					} as DRPNodeConfig,
					{ network: { hostFactory } }
				)
			).rejects.toThrow("mid-start fixture failure");
			if (host === undefined) throw new Error("runtime host was not captured");
			expect(host.status).toBe("stopped");
		} finally {
			startAll.mockRestore();
			if (host?.status === "started") await host.stop();
		}
	}, 12_000);
});

async function loadRuntime(): Promise<NodeRuntimeModule> {
	const runtimeUrl = new URL("../src/runtime.ts", import.meta.url).href;
	let loaded: Partial<NodeRuntimeModule> = {};
	try {
		loaded = (await import(/* @vite-ignore */ runtimeUrl)) as Partial<NodeRuntimeModule>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("runtime.ts") || !message.includes("Does the file exist")) throw error;
	}
	expect(loaded.createNodeRuntime).toBeTypeOf("function");
	if (typeof loaded.createNodeRuntime !== "function") throw new Error("createNodeRuntime export is missing");
	return loaded as NodeRuntimeModule;
}

async function loadNodeRouting(): Promise<RoutingNodeModule> {
	const moduleUrl = new URL("../../routing-node/src/index.ts", import.meta.url).href;
	return (await import(/* @vite-ignore */ moduleUrl)) as RoutingNodeModule;
}

function withPeerId(address: string, peerId: string): string {
	return address.includes("/p2p/") ? address : `${address}/p2p/${peerId}`;
}
