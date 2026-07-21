import {
	type DRPNetworkHostExtensions,
	type DRPNetworkHostFactory,
	type DRPNetworkHostFactoryContext,
	DRPNetworkNode,
	type DRPNetworkNodeDependencies,
} from "@ts-drp/network";
import {
	attachNodeRouting,
	createAminoHostExtensions,
	type NodeRouting,
	OFFICIAL_AMINO_BOOTSTRAPPERS,
	PUBLIC_NETWORK_ACKNOWLEDGEMENT,
} from "@ts-drp/routing-node";
import type { DRPNodeConfig } from "@ts-drp/types";

import { DRPNode, type DRPNodeDependencies } from "./index.js";

export interface NodeRuntimeDependencies {
	readonly network?: DRPNetworkNodeDependencies;
	readonly node?: DRPNodeDependencies;
}

export interface NodeRuntime {
	readonly node: DRPNode;
	readonly routing: NodeRouting | undefined;
}

export interface ResolvedNodeRoutingRuntimeConfig {
	readonly bootstrappers: readonly string[];
	readonly config: DRPNodeConfig;
	readonly network: "local" | "public";
}

/** Raised before any host starts when public Amino traffic was not explicitly acknowledged. */
export class PublicNetworkAcknowledgementError extends Error {
	/** Creates a fail-closed public-network configuration error. */
	constructor() {
		super(`Public Node routing requires public_network_acknowledgement to equal ${PUBLIC_NETWORK_ACKNOWLEDGEMENT}`);
		this.name = "PublicNetworkAcknowledgementError";
	}
}

/** Node routing is attached to one host and cannot survive DRPNode host replacement. */
export class NodeRoutingRestartUnsupportedError extends Error {
	/** Creates an error explaining the one-host routing lifecycle. */
	constructor() {
		super("DRPNode.restart() is unsupported while Node routing is attached; stop the runtime and create a new one");
		this.name = "NodeRoutingRestartUnsupportedError";
	}
}

/**
 * Validates and resolves Node-routing policy without constructing or starting a host.
 * @param config - Unresolved DRP runtime configuration
 * @returns A normalized local/public routing configuration, or undefined when disabled
 */
export function resolveNodeRoutingRuntimeConfig(config: DRPNodeConfig): ResolvedNodeRoutingRuntimeConfig | undefined {
	const routingConfig = config.network_config?.control_plane?.routing?.node;
	if (routingConfig?.enabled !== true) return undefined;
	const network = routingConfig.network ?? "local";
	if (network === "public" && routingConfig.public_network_acknowledgement !== PUBLIC_NETWORK_ACKNOWLEDGEMENT) {
		throw new PublicNetworkAcknowledgementError();
	}
	const routingBootstrappers =
		routingConfig.bootstrappers ?? (network === "public" ? OFFICIAL_AMINO_BOOTSTRAPPERS : []);
	const bootstrappers = [...new Set([...(config.network_config?.bootstrap_peers ?? []), ...routingBootstrappers])];
	return {
		bootstrappers,
		config: {
			...config,
			network_config: {
				...config.network_config,
				bootstrap_peers: bootstrappers,
			},
		},
		network,
	};
}

/**
 * Creates and starts the Node/Electron DRP runtime, attaching Amino routing
 * only when the Node routing owner is explicitly enabled.
 * @param config - DRP node and control-plane configuration
 * @param dependencies - Existing node and network construction seams
 * @returns Started DRP node and its optional Node-only routing adapter
 */
export async function createNodeRuntime(
	config: DRPNodeConfig,
	dependencies: NodeRuntimeDependencies = {}
): Promise<NodeRuntime> {
	const resolved = resolveNodeRoutingRuntimeConfig(config);
	if (resolved === undefined) {
		const node = createPlainNode(config, dependencies);
		await node.start();
		return { node, routing: undefined };
	}
	if (dependencies.node?.networkNode !== undefined) {
		throw new Error("Node routing requires the runtime-owned DRP network host factory");
	}

	const { config: runtimeConfig, network } = resolved;
	let routingHost: Awaited<ReturnType<DRPNetworkHostFactory>> | undefined;
	let networkStarted = false;
	const hostFactory = createRoutingHostFactory(
		createAminoHostExtensions({ mode: "client", network }),
		dependencies.network?.hostFactory,
		(host) => {
			routingHost = host;
			networkStarted = host.status === "started";
		}
	);
	const networkNode = new DRPNetworkNode(runtimeConfig.network_config, {
		...dependencies.network,
		hostFactory,
	});
	let attachedRouting: NodeRouting | undefined;
	const node = new DRPNode(runtimeConfig, {
		...dependencies.node,
		beforeRestart: (): never => {
			throw new NodeRoutingRestartUnsupportedError();
		},
		networkNode,
		networkStop: (): Promise<void> => attachedRouting?.stop() ?? networkNode.stop(),
	});
	try {
		await node.start();
		if (routingHost === undefined) throw new Error("Node routing host was not exposed by the production host factory");
		attachedRouting = await attachNodeRouting(networkNode, routingHost, { mode: "client", network });
		return { node, routing: attachedRouting };
	} catch (error) {
		if (networkStarted) {
			try {
				await node.stop();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Node routing startup and cleanup both failed", {
					cause: error,
				});
			}
		}
		throw error;
	}
}

function createPlainNode(config: DRPNodeConfig, dependencies: NodeRuntimeDependencies): DRPNode {
	if (dependencies.node?.networkNode !== undefined && dependencies.network !== undefined) {
		throw new Error("Network dependencies cannot be applied to an injected DRP network node");
	}
	const networkNode =
		dependencies.node?.networkNode ??
		(dependencies.network === undefined ? undefined : new DRPNetworkNode(config.network_config, dependencies.network));
	return new DRPNode(config, {
		...dependencies.node,
		...(networkNode === undefined ? {} : { networkNode }),
	});
}

function createRoutingHostFactory(
	routingExtensions: DRPNetworkHostExtensions,
	delegate: DRPNetworkHostFactory | undefined,
	onHost: (host: Awaited<ReturnType<DRPNetworkHostFactory>>) => void
): DRPNetworkHostFactory {
	return async (context) => {
		const createHost = (
			extensions: DRPNetworkHostExtensions = {}
		): ReturnType<DRPNetworkHostFactoryContext["createHost"]> =>
			context.createHost(mergeHostExtensions(routingExtensions, extensions));
		const host = await (delegate?.({ ...context, createHost }) ?? createHost());
		onHost(host);
		return host;
	};
}

function mergeHostExtensions(
	routing: DRPNetworkHostExtensions,
	consumer: DRPNetworkHostExtensions
): DRPNetworkHostExtensions {
	for (const serviceName of Object.keys(consumer.services ?? {})) {
		if (serviceName in (routing.services ?? {})) {
			throw new Error(`DRP network host extension cannot replace routing service "${serviceName}"`);
		}
	}
	return {
		contentRouters: [...(routing.contentRouters ?? []), ...(consumer.contentRouters ?? [])],
		peerDiscovery: [...(routing.peerDiscovery ?? []), ...(consumer.peerDiscovery ?? [])],
		peerRouters: [...(routing.peerRouters ?? []), ...(consumer.peerRouters ?? [])],
		services: { ...routing.services, ...consumer.services },
		transports: [...(routing.transports ?? []), ...(consumer.transports ?? [])],
	};
}
