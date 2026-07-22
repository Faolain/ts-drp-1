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
	getClosestPeers(queryKey: Uint8Array, signal?: AbortSignal): AsyncIterable<NodeRoutingPeer>;
	status(signal: AbortSignal): Promise<{
		addresses: Array<{ address: string; decision: { dialable: boolean } }>;
		peerId: string;
	}>;
	stop(): Promise<void>;
	waitForRoutingTable(minimumPeers: number, signal: AbortSignal): Promise<void>;
}

interface NodeRoutingPeer {
	readonly addresses: readonly string[];
	readonly peerId: string;
}

interface RuntimeRelayCandidate {
	readonly addresses: readonly string[];
	readonly operatorGroup: string;
	readonly peerId: string;
	readonly protocols: readonly string[];
	readonly provenance: {
		readonly origin: string;
		readonly queryDigest: string;
		readonly resultIndex: number;
		readonly routingSource: string;
	};
}

interface RuntimeRelayCandidateSource {
	getCandidates(queryKey: Uint8Array, signal: AbortSignal): AsyncIterable<RuntimeRelayCandidate>;
}

interface RuntimeRelayPolicyFactoryOptions {
	readonly source: RuntimeRelayCandidateSource;
	readonly totalDeadlineMs: number;
	readonly transportProfile?: {
		readonly allowed: readonly string[];
		readonly name: "broad-browser" | "node" | "wss-only";
	};
}

interface RuntimeRelayPolicyResult {
	readonly attempts: readonly never[];
	readonly candidatesObserved: number;
	readonly durationMs: number;
	readonly operatorGroups: readonly string[];
	readonly reservations: readonly never[];
	readonly terminal: "exhausted";
}

interface RuntimeRelayPolicyDriver {
	acquire(queryKey: Uint8Array, signal: AbortSignal): Promise<RuntimeRelayPolicyResult>;
	refresh(signal: AbortSignal): Promise<RuntimeRelayPolicyResult>;
	replace(peerId: string, reason: "relay-disconnected", signal: AbortSignal): Promise<RuntimeRelayPolicyResult>;
	stop(): Promise<void>;
}

interface RuntimeNetworkDependencies {
	hostFactory?: DRPNetworkHostFactory;
	relayCandidateSources?: { readonly configuredFallback?: RuntimeRelayCandidateSource };
	relayPolicyFactory?(options: RuntimeRelayPolicyFactoryOptions): RuntimeRelayPolicyDriver;
}

interface RuntimeDependencies {
	attachNodeRouting?(
		networkNode: unknown,
		host: unknown,
		options: { readonly closestPeersTimeoutMs?: number }
	): Promise<NodeRouting>;
	readonly network?: RuntimeNetworkDependencies;
}

interface RoutingNodeModule {
	readonly OFFICIAL_AMINO_BOOTSTRAPPERS: readonly string[];
	readonly PUBLIC_NETWORK_ACKNOWLEDGEMENT: string;
	createNodeRouting(options: { mode: "server"; network: "local" }): Promise<NodeRouting>;
}

interface NodeRuntimeModule {
	NodeRoutingRestartUnsupportedError: new () => Error;
	PublicNetworkAcknowledgementError: new () => Error;
	createNodeRuntime(config: DRPNodeConfig, dependencies?: RuntimeDependencies): Promise<NodeRuntimeResult>;
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
					rollout: { public_components: { delegated_routing: { enabled: true } } },
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

	it("composes configured public node closest peers as deferred overflow candidates", async () => {
		const { createNodeRuntime } = await loadRuntime();
		const { PUBLIC_NETWORK_ACKNOWLEDGEMENT } = await loadNodeRouting();
		const primary = runtimeCandidate("configured-primary", "configured-fallback", "configured");
		const configuredFallback = runtimeSourceOf([primary]);
		const acquisitions: RuntimeRelayCandidate[][] = [];
		let relayTotalDeadlineMs: number | undefined;
		let relayTransportProfileName:
			| NonNullable<RuntimeRelayPolicyFactoryOptions["transportProfile"]>["name"]
			| undefined;
		const relayPolicyFactory = vi.fn((options: RuntimeRelayPolicyFactoryOptions): RuntimeRelayPolicyDriver => {
			relayTotalDeadlineMs = options.totalDeadlineMs;
			relayTransportProfileName = options.transportProfile?.name;
			return {
				acquire: async (queryKey, signal): Promise<RuntimeRelayPolicyResult> => {
					const candidates = await collectRuntimeCandidates(options.source, queryKey, signal);
					acquisitions.push(candidates);
					return exhaustedRuntimeRelayResult(candidates.length);
				},
				refresh: (): Promise<RuntimeRelayPolicyResult> => Promise.resolve(exhaustedRuntimeRelayResult(0)),
				replace: (): Promise<RuntimeRelayPolicyResult> => Promise.resolve(exhaustedRuntimeRelayResult(0)),
				stop: (): Promise<void> => Promise.resolve(),
			};
		});
		const fakeRouting = runtimeNodeRouting([
			{ addresses: ["/ip4/8.8.8.8/tcp/4001"], peerId: "node-relay-a" },
			{ addresses: ["/ip4/9.9.9.9/tcp/4001"], peerId: "node-relay-b" },
		]);
		let finishAttachment: ((routing: NodeRouting) => void) | undefined;
		let attachmentStarted: (() => void) | undefined;
		const attachmentStartedPromise = new Promise<void>((resolve) => {
			attachmentStarted = resolve;
		});
		const attachNodeRouting = vi.fn(
			(
				_networkNode: unknown,
				_host: unknown,
				_options: { readonly closestPeersTimeoutMs?: number }
			): Promise<NodeRouting> => {
				attachmentStarted?.();
				return new Promise<NodeRouting>((resolve) => {
					finishAttachment = resolve;
				});
			}
		);
		const runtimePromise = createNodeRuntime(publicNodeOverflowConfig(PUBLIC_NETWORK_ACKNOWLEDGEMENT, true), {
			attachNodeRouting,
			network: { relayCandidateSources: { configuredFallback }, relayPolicyFactory },
		});
		let runtime: NodeRuntimeResult | undefined;
		try {
			await Promise.race([attachmentStartedPromise, runtimePromise.then(() => undefined)]);
			await vi.waitFor(() => expect(acquisitions[0]?.map(({ peerId }) => peerId)).toEqual(["configured-primary"]));
			expect(finishAttachment).toBeTypeOf("function");
			finishAttachment?.(fakeRouting);
			runtime = await runtimePromise;
			expect(attachNodeRouting).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.objectContaining({ closestPeersTimeoutMs: 45_000, mode: "client", network: "public" })
			);
			await vi.waitFor(() => expect(acquisitions).toHaveLength(2));
			expect(relayTotalDeadlineMs).toBe(55_000);
			expect(relayTransportProfileName).toBe("node");
			const candidates = acquisitions[1] ?? [];
			expect(candidates.map(({ peerId }) => peerId)).toEqual(["configured-primary", "node-relay-a", "node-relay-b"]);
			expect(candidates.slice(1)).toMatchObject([
				{ provenance: { origin: "node-closest-peers", routingSource: "public-dht" } },
				{ provenance: { origin: "node-closest-peers", routingSource: "public-dht" } },
			]);
		} finally {
			if (finishAttachment !== undefined && runtime === undefined) finishAttachment(fakeRouting);
			await Promise.allSettled([runtimePromise.then(({ node }) => node.stop())]);
		}
	}, 12_000);

	it("leaves the node closest-peers source absent when its toggle is off", async () => {
		const { createNodeRuntime } = await loadRuntime();
		const { PUBLIC_NETWORK_ACKNOWLEDGEMENT } = await loadNodeRouting();
		const getClosestPeers = vi.fn(async function* (): AsyncIterable<NodeRoutingPeer> {
			await Promise.resolve();
			yield { addresses: [], peerId: "must-not-surface" };
		});
		const fakeRouting = runtimeNodeRouting([], getClosestPeers);
		let composedSource: RuntimeRelayCandidateSource | undefined;
		let relayTotalDeadlineMs: number | undefined;
		let relayTransportProfileName:
			| NonNullable<RuntimeRelayPolicyFactoryOptions["transportProfile"]>["name"]
			| undefined;
		const relayPolicyFactory = vi.fn((options: RuntimeRelayPolicyFactoryOptions): RuntimeRelayPolicyDriver => {
			composedSource = options.source;
			relayTotalDeadlineMs = options.totalDeadlineMs;
			relayTransportProfileName = options.transportProfile?.name;
			return idleRuntimeRelayPolicyDriver();
		});
		const attachNodeRouting = vi.fn(
			(
				_networkNode: unknown,
				_host: unknown,
				_options: { readonly closestPeersTimeoutMs?: number }
			): Promise<NodeRouting> => Promise.resolve(fakeRouting)
		);
		const runtime = await createNodeRuntime(publicNodeOverflowConfig(PUBLIC_NETWORK_ACKNOWLEDGEMENT, false), {
			attachNodeRouting,
			network: {
				relayCandidateSources: {
					configuredFallback: runtimeSourceOf([
						runtimeCandidate("configured-primary", "configured-fallback", "configured"),
					]),
				},
				relayPolicyFactory,
			},
		});
		try {
			if (composedSource === undefined) throw new Error("configured fallback was not composed");
			await expect(
				collectRuntimeCandidates(composedSource, new Uint8Array([4]), new AbortController().signal)
			).resolves.toMatchObject([{ peerId: "configured-primary" }]);
			expect(getClosestPeers).not.toHaveBeenCalled();
			expect(relayTotalDeadlineMs).toBe(5_000);
			expect(relayTransportProfileName).toBe("broad-browser");
			expect(attachNodeRouting.mock.calls[0]?.[2]?.closestPeersTimeoutMs).toBe(10_000);
		} finally {
			await runtime.node.stop();
		}
	});

	it("retries an empty post-attachment walk until degraded reservations actually satisfy the target", async () => {
		const { createNodeRuntime } = await loadRuntime();
		const { PUBLIC_NETWORK_ACKNOWLEDGEMENT } = await loadNodeRouting();
		const fakeRouting = runtimeNodeRouting([
			{ addresses: ["/ip4/8.8.8.8/tcp/4001"], peerId: "node-relay-after-attach" },
		]);

		let releasePostAttachAcquire: (() => void) | undefined;
		const postAttachGate = new Promise<void>((resolve) => {
			releasePostAttachAcquire = resolve;
		});
		const postAttachAcquire = vi.fn();
		const postAttachRoutingWalk = vi.fn();
		const postAttachRuntime = await createNodeRuntime(publicNodeOverflowConfig(PUBLIC_NETWORK_ACKNOWLEDGEMENT, true), {
			attachNodeRouting: (): Promise<NodeRouting> => {
				setTimeout(() => releasePostAttachAcquire?.(), 0);
				return Promise.resolve(
					runtimeNodeRouting([], async function* (): AsyncIterable<NodeRoutingPeer> {
						await Promise.resolve();
						postAttachRoutingWalk();
						yield* [];
					})
				);
			},
			network: {
				relayCandidateSources: {
					configuredFallback: runtimeSourceOf([
						runtimeCandidate("configured-primary", "configured-fallback", "configured"),
					]),
				},
				relayPolicyFactory: (options): RuntimeRelayPolicyDriver => ({
					acquire: async (queryKey, signal): Promise<RuntimeRelayPolicyResult> => {
						postAttachAcquire();
						await postAttachGate;
						await collectRuntimeCandidates(options.source, queryKey, signal);
						return exhaustedRuntimeRelayResult(0);
					},
					refresh: (): Promise<RuntimeRelayPolicyResult> => Promise.resolve(exhaustedRuntimeRelayResult(0)),
					replace: (): Promise<RuntimeRelayPolicyResult> => Promise.resolve(exhaustedRuntimeRelayResult(0)),
					stop: (): Promise<void> => Promise.resolve(),
				}),
			},
		});
		try {
			await vi.waitFor(() => expect(postAttachAcquire).toHaveBeenCalledTimes(2));
			await vi.waitFor(() => expect(postAttachRoutingWalk).toHaveBeenCalledTimes(2));
		} finally {
			await postAttachRuntime.node.stop();
		}

		const insufficientAcquire = vi.fn();
		const routingWalkAfterRetry = vi.fn();
		const insufficientRuntime = await createNodeRuntime(
			publicNodeOverflowConfig(PUBLIC_NETWORK_ACKNOWLEDGEMENT, true),
			{
				attachNodeRouting: (): Promise<NodeRouting> =>
					Promise.resolve(
						runtimeNodeRouting([], async function* (): AsyncIterable<NodeRoutingPeer> {
							routingWalkAfterRetry();
							yield* fakeRouting.getClosestPeers(new Uint8Array([1]));
						})
					),
				network: {
					relayCandidateSources: {
						configuredFallback: runtimeSourceOf([
							runtimeCandidate("configured-primary", "configured-fallback", "configured"),
						]),
					},
					relayPolicyFactory: (options): RuntimeRelayPolicyDriver => ({
						acquire: async (queryKey, signal): Promise<RuntimeRelayPolicyResult> => {
							insufficientAcquire();
							if (insufficientAcquire.mock.calls.length > 1) {
								await collectRuntimeCandidates(options.source, queryKey, signal);
							}
							return exhaustedRuntimeRelayResult(0);
						},
						refresh: (): Promise<RuntimeRelayPolicyResult> => Promise.resolve(exhaustedRuntimeRelayResult(0)),
						replace: (): Promise<RuntimeRelayPolicyResult> => Promise.resolve(exhaustedRuntimeRelayResult(0)),
						stop: (): Promise<void> => Promise.resolve(),
					}),
				},
			}
		);
		try {
			await vi.waitFor(() => expect(insufficientAcquire).toHaveBeenCalledTimes(2));
			await vi.waitFor(() => expect(routingWalkAfterRetry).toHaveBeenCalledOnce());
		} finally {
			await insufficientRuntime.node.stop();
		}
	}, 12_000);

	it("returns from runtime startup while the post-attachment overflow retry remains in flight", async () => {
		const { createNodeRuntime } = await loadRuntime();
		const { PUBLIC_NETWORK_ACKNOWLEDGEMENT } = await loadNodeRouting();
		let releaseRetry: (() => void) | undefined;
		const retryGate = new Promise<void>((resolve) => {
			releaseRetry = resolve;
		});
		let acquisitions = 0;
		const runtimePromise = createNodeRuntime(publicNodeOverflowConfig(PUBLIC_NETWORK_ACKNOWLEDGEMENT, true), {
			attachNodeRouting: (): Promise<NodeRouting> => Promise.resolve(runtimeNodeRouting([])),
			network: {
				relayCandidateSources: { configuredFallback: runtimeSourceOf([]) },
				relayPolicyFactory: (): RuntimeRelayPolicyDriver => ({
					acquire: async (): Promise<RuntimeRelayPolicyResult> => {
						acquisitions += 1;
						if (acquisitions > 1) await retryGate;
						return exhaustedRuntimeRelayResult(0);
					},
					refresh: (): Promise<RuntimeRelayPolicyResult> => Promise.resolve(exhaustedRuntimeRelayResult(0)),
					replace: (): Promise<RuntimeRelayPolicyResult> => Promise.resolve(exhaustedRuntimeRelayResult(0)),
					stop: (): Promise<void> => Promise.resolve(),
				}),
			},
		});
		let runtime: NodeRuntimeResult | undefined;
		try {
			const startup = await Promise.race([
				runtimePromise.then((result): "returned" => {
					runtime = result;
					return "returned";
				}),
				new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
			]);
			expect(acquisitions).toBe(2);
			expect(startup).toBe("returned");
		} finally {
			releaseRetry?.();
			runtime ??= await runtimePromise;
			await runtime.node.stop();
		}
	}, 12_000);

	it("rejects public routing without the exact acknowledgement before any host starts", async () => {
		const { createNodeRuntime, PublicNetworkAcknowledgementError } = await loadRuntime();
		await expect(
			createNodeRuntime({
				network_config: {
					control_plane: {
						rollout: { public_components: { delegated_routing: { enabled: true } } },
						routing: { node: { enabled: true, network: "public" } },
					},
				},
			} as DRPNodeConfig)
		).rejects.toBeInstanceOf(PublicNetworkAcknowledgementError);
	});

	it("keeps the public Amino host extension absent while delegated routing rollout is off", async () => {
		const { createNodeRuntime } = await loadRuntime();
		const { PUBLIC_NETWORK_ACKNOWLEDGEMENT } = await loadNodeRouting();
		let host: Awaited<ReturnType<DRPNetworkHostFactory>> | undefined;
		const hostFactory: DRPNetworkHostFactory = async (context) => {
			host = await context.createHost();
			return host;
		};
		const runtime = await createNodeRuntime(
			{
				keychain_config: { private_key_seed: "phase-seven-public-routing-off" },
				log_config: { level: "silent" },
				network_config: {
					bootstrap_peers: [],
					control_plane: {
						rollout: { public_components: { delegated_routing: { enabled: false } } },
						routing: {
							node: {
								enabled: true,
								network: "public",
								public_network_acknowledgement: PUBLIC_NETWORK_ACKNOWLEDGEMENT,
							},
						},
					},
					listen_addresses: [],
					log_config: { level: "silent" },
				},
			} as DRPNodeConfig,
			{ network: { hostFactory } }
		);

		try {
			if (host === undefined) throw new Error("runtime host was not captured");
			expect(runtime.routing).toBeUndefined();
			expect(Reflect.get(host.services, "aminoDHT")).toBeUndefined();
		} finally {
			await runtime.node.stop();
		}
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

function publicNodeOverflowConfig(acknowledgement: string, nodeClosestPeersEnabled: boolean): DRPNodeConfig {
	return {
		keychain_config: { private_key_seed: `node-overflow-${nodeClosestPeersEnabled ? "on" : "off"}` },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			control_plane: {
				relay_policy: {
					sources: {
						configured_fallback: { enabled: true },
						node_closest_peers: { enabled: nodeClosestPeersEnabled },
					},
					target_reservations: 2,
				},
				rollout: { public_components: { delegated_routing: { enabled: true } } },
				routing: {
					node: {
						bootstrappers: [],
						enabled: true,
						network: "public",
						public_network_acknowledgement: acknowledgement,
					},
				},
			},
			listen_addresses: [],
			log_config: { level: "silent" },
		},
	} as DRPNodeConfig;
}

function runtimeNodeRouting(
	peers: readonly NodeRoutingPeer[],
	getClosestPeers: NodeRouting["getClosestPeers"] = async function* (): AsyncIterable<NodeRoutingPeer> {
		await Promise.resolve();
		for (const peer of peers) yield peer;
	}
): NodeRouting {
	return {
		findPeer: (): Promise<{ peerId: string }> => Promise.resolve({ peerId: "runtime-routing" }),
		getClosestPeers,
		peerId: "runtime-routing",
		status: (): Promise<{
			addresses: Array<{ address: string; decision: { dialable: boolean } }>;
			peerId: string;
		}> => Promise.resolve({ addresses: [], peerId: "runtime-routing" }),
		stop: (): Promise<void> => Promise.resolve(),
		waitForRoutingTable: (): Promise<void> => Promise.resolve(),
	};
}

function runtimeCandidate(peerId: string, origin: string, routingSource: string): RuntimeRelayCandidate {
	return {
		addresses: [],
		operatorGroup: "unknown",
		peerId,
		protocols: [],
		provenance: { origin, queryDigest: "runtime-test", resultIndex: 0, routingSource },
	};
}

function runtimeSourceOf(candidates: readonly RuntimeRelayCandidate[]): RuntimeRelayCandidateSource {
	return {
		async *getCandidates(): AsyncIterable<RuntimeRelayCandidate> {
			await Promise.resolve();
			for (const candidate of candidates) yield candidate;
		},
	};
}

async function collectRuntimeCandidates(
	source: RuntimeRelayCandidateSource,
	queryKey: Uint8Array,
	signal: AbortSignal
): Promise<RuntimeRelayCandidate[]> {
	const candidates: RuntimeRelayCandidate[] = [];
	for await (const candidate of source.getCandidates(queryKey, signal)) candidates.push(candidate);
	return candidates;
}

function exhaustedRuntimeRelayResult(candidatesObserved: number): RuntimeRelayPolicyResult {
	return {
		attempts: [],
		candidatesObserved,
		durationMs: 0,
		operatorGroups: [],
		reservations: [],
		terminal: "exhausted",
	};
}

function idleRuntimeRelayPolicyDriver(): RuntimeRelayPolicyDriver {
	return {
		acquire: (): Promise<RuntimeRelayPolicyResult> => Promise.resolve(exhaustedRuntimeRelayResult(0)),
		refresh: (): Promise<RuntimeRelayPolicyResult> => Promise.resolve(exhaustedRuntimeRelayResult(0)),
		replace: (): Promise<RuntimeRelayPolicyResult> => Promise.resolve(exhaustedRuntimeRelayResult(0)),
		stop: (): Promise<void> => Promise.resolve(),
	};
}
