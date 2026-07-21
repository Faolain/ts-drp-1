import {
	type DRPNetworkHostFactory,
	DRPNetworkNode,
	type RelayPolicyDriver,
	type RelayPolicyFactoryOptions,
} from "@ts-drp/network";
import { DRPNode } from "@ts-drp/node";
import {
	type ActiveRelayReservation,
	BrowserRoutingClosestPeersSource,
	type BrowserRoutingPeerCandidate,
	Libp2pRelayClient,
	type Libp2pRelayClientOptions,
	RelayPolicy,
	type RelayPolicyResult,
	type RelayReplacementResult,
} from "@ts-drp/relay-policy";
import type { RendezvousEnsembleTrace } from "@ts-drp/rendezvous";
import type { BrowserRoutingTrace } from "@ts-drp/routing-browser";
import type { ControlPlaneEvent, DRPNodeConfig } from "@ts-drp/types";

import { allowsInsecureNetworkFixture, type GridNetworkEnv, parseRelayOperatorGroups } from "./network-config";

export interface ModularGridNetworkSnapshot {
	readonly bootstrapPeers: readonly string[];
	readonly connections: ReturnType<DRPNetworkNode["getControlPlaneConnections"]>;
	readonly controlPlaneEvents: readonly ControlPlaneEvent[];
	readonly membershipMode: "invite";
	readonly peerId: string;
	readonly relayPolicy?: RelayPolicyResult;
	readonly relayReservations: ReturnType<DRPNetworkNode["getActiveRelayReservations"]>;
	readonly rendezvous?: RendezvousEnsembleTrace;
	readonly routing?: BrowserRoutingTrace;
}

export interface ModularGridNetworkSession {
	readonly node: DRPNode;
	snapshot(): ModularGridNetworkSnapshot;
	stop(): Promise<void>;
}

/**
 * Composes the grid's modular browser runtime from the production network, routing,
 * rendezvous, and relay-policy owners. The plaintext relay profile remains fixture-gated.
 * @param config - Modular DRP node configuration.
 * @param environment - Runtime-only fixture and operator-group inputs.
 * @returns A started-by-caller node plus sanitized diagnostics.
 */
export function createModularGridNetwork(
	config: DRPNodeConfig,
	environment: GridNetworkEnv
): ModularGridNetworkSession {
	const configuredNetwork = config.network_config;
	if (configuredNetwork === undefined || configuredNetwork.bootstrap_peers?.length !== 0) {
		throw new Error("modular grid network requires an explicit empty bootstrap_peers list");
	}
	const fixture = allowsInsecureNetworkFixture(environment);
	const operatorGroups = parseRelayOperatorGroups(environment.relayOperatorGroups);
	const controlPlaneEvents: ControlPlaneEvent[] = [];
	let lastRelayPolicy: RelayPolicyResult | undefined;
	let relayHost: Libp2pRelayClientOptions["host"] | undefined;
	// Forward-referenced by the host/routing/relay closures below; assigned once after construction.
	// eslint-disable-next-line prefer-const
	let node: DRPNode | undefined;
	// eslint-disable-next-line prefer-const
	let network: DRPNetworkNode;

	const configuredSink = configuredNetwork.control_plane?.observability?.sink;
	const runtimeConfig: DRPNodeConfig = {
		...config,
		network_config: {
			...configuredNetwork,
			control_plane: {
				...configuredNetwork.control_plane,
				observability: {
					sink: (event): void => {
						controlPlaneEvents.push(event);
						configuredSink?.(event);
					},
				},
			},
		},
	};

	const hostFactory: DRPNetworkHostFactory = async (context) => {
		const host = await context.createHost();
		relayHost = host as unknown as Libp2pRelayClientOptions["host"];
		return host;
	};
	const delegatedClosestPeers = new BrowserRoutingClosestPeersSource(
		{
			getClosestPeers: (queryKey, signal): AsyncIterable<BrowserRoutingPeerCandidate> => {
				const routing = node?.routing;
				if (routing === undefined) throw new Error("modular browser routing is not configured");
				return routing.getClosestPeers(queryKey, signal);
			},
		},
		(peer) => operatorGroups.get(peer.peerId) ?? "unknown"
	);
	const relayPolicyFactory = (options: RelayPolicyFactoryOptions): RelayPolicyDriver => {
		const host = relayHost;
		if (host === undefined) throw new Error("modular relay policy requires a started libp2p host");
		const client = new Libp2pRelayClient({
			connect: async (address, signal): Promise<void> => {
				const connection = await network.safeDial(address, undefined, signal);
				if (connection === undefined) throw new Error("relay dial did not create a connection");
			},
			disconnect: (peerId): Promise<void> => network.disconnect(peerId),
			host,
		});
		const policy = new RelayPolicy({
			allowInsecureWebSocketFixture: fixture,
			inspector: client,
			limits: {
				maxConcurrentReservations: 1,
				maxPerOperatorGroup: 1,
				requiredOperatorGroups: options.targetReservations,
				requiredReservations: options.targetReservations,
			},
			onReservationEvent: options.onReservationEvent,
			reservationClient: client,
			source: options.source,
		});
		const record = <T extends RelayPolicyResult>(result: T): T => {
			lastRelayPolicy = result;
			return result;
		};
		return {
			get activeReservations(): readonly ActiveRelayReservation[] {
				return policy.activeReservations;
			},
			acquire: async (queryKey, signal) => record(await policy.acquire(queryKey, signal)),
			refresh: async (signal) => record(await policy.refresh(signal)),
			replace: async (peerId, reason, signal, excludedOperatorGroup): Promise<RelayReplacementResult> =>
				record(await policy.replace(peerId, reason, signal, excludedOperatorGroup)),
			stop: async (): Promise<void> => {
				await policy.stop();
				await client.stop();
			},
		};
	};

	network = new DRPNetworkNode(runtimeConfig.network_config, {
		hostFactory,
		relayCandidateSources: { delegatedClosestPeers },
		relayPolicyFactory,
	});
	node = new DRPNode(runtimeConfig, { networkNode: network, reconnect: false });

	return {
		node,
		snapshot: (): ModularGridNetworkSnapshot => ({
			bootstrapPeers: [...(runtimeConfig.network_config?.bootstrap_peers ?? [])],
			connections: network.getControlPlaneConnections(),
			controlPlaneEvents: [...controlPlaneEvents],
			membershipMode: "invite",
			peerId: network.peerId,
			...(lastRelayPolicy === undefined ? {} : { relayPolicy: lastRelayPolicy }),
			relayReservations: network.getActiveRelayReservations(),
			...(node?.rendezvous?.lastTrace === undefined ? {} : { rendezvous: node.rendezvous.lastTrace }),
			...(node?.routing?.lastTrace === undefined ? {} : { routing: node.routing.lastTrace }),
		}),
		stop: (): Promise<void> => node?.stop() ?? Promise.resolve(),
	};
}
