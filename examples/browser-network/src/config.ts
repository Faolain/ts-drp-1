import type { DRPNodeConfig } from "@ts-drp/types";

export interface BrowserNetworkEnv {
	readonly allowInsecureFixture?: string;
	readonly bootstrapPeers: string;
	readonly discoveryInterval: number;
	readonly enablePrometheusMetrics: boolean;
	readonly membershipInvite?: string;
	readonly networkMode?: string;
	readonly nostrRelays?: readonly string[];
	readonly nostrSecretKey?: string;
	readonly relayOperatorGroups?: string;
	readonly rendezvousEndpoints?: string;
	readonly rendezvousInvite?: string;
	readonly rendezvousNamespace?: string;
	readonly routingEndpoints?: string;
}

/**
 * @param environment - Parsed browser-example environment.
 * @returns Whether the example should use the modular network control plane.
 */
export function isModularNetworkEnv(environment: BrowserNetworkEnv): boolean {
	return (
		environment.networkMode === "modular" ||
		splitList(environment.rendezvousEndpoints).length > 0 ||
		normalizeList(environment.nostrRelays).length > 0
	);
}

/**
 * @param environment - Parsed browser-example environment.
 * @returns Whether explicit local-fixture security allowances are enabled.
 */
export function allowsInsecureNetworkFixture(environment: BrowserNetworkEnv): boolean {
	return parseExplicitBoolean(environment.allowInsecureFixture);
}

/**
 * Builds the browser modular-network configuration without reading global state.
 * Local plaintext and loopback permissions are omitted unless the fixture flag is explicitly true.
 * @param environment - Parsed browser-example environment.
 * @returns A fail-closed modular DRP node configuration.
 */
export function buildModularNetworkConfig(environment: BrowserNetworkEnv): DRPNodeConfig {
	const rendezvousEndpoints = splitList(environment.rendezvousEndpoints);
	const nostrRelays = normalizeList(environment.nostrRelays);
	const routingEndpoints = requiredList(environment.routingEndpoints, "VITE_ROUTING_ENDPOINTS");
	const namespace = requiredValue(environment.rendezvousNamespace, "VITE_RENDEZVOUS_NAMESPACE");
	const membershipInvite = requiredValue(environment.membershipInvite, "VITE_MEMBERSHIP_INVITE");
	const allowInsecureFixture = allowsInsecureNetworkFixture(environment);

	if (rendezvousEndpoints.length < 2 && nostrRelays.length === 0) {
		throw new Error("modular rendezvous requires at least two VITE_RENDEZVOUS_ENDPOINTS or one VITE_NOSTR_RELAYS URL");
	}
	if (membershipInvite.length < 16) {
		throw new Error("VITE_MEMBERSHIP_INVITE must contain at least 16 characters");
	}

	return {
		network_config: {
			bootstrap_peers: [],
			browser_metrics: true,
			control_plane: {
				address_policy: {
					target: "browser",
					// Local fixtures advertise loopback AND private-LAN circuit addresses (the relay binds
					// to 127.0.0.1 and the host LAN IP), so the fixture must opt into all three; production
					// keeps them rejected. A record is dropped whole if ANY address is unsafe.
					...(allowInsecureFixture ? { allowInsecureWebSocket: true, allowLoopback: true, allowPrivate: true } : {}),
				},
				membership: {
					invite: { inviteToken: membershipInvite },
					mode: "invite",
				},
				recovery: {
					backend_cooldown_ms: 1_000,
					health_poll_interval_ms: 250,
					max_attempts: 3,
					parent_deadline_ms: 10_000,
					recovery_backoff_ms: 250,
					retry_delays_ms: [0, 250, 500],
					startup_grace_ms: 1_500,
				},
				relay_policy: {
					...(allowInsecureFixture
						? {}
						: {
								per_candidate_deadline_ms: 8_000,
								total_deadline_ms: 30_000,
							}),
					sources: { delegated_closest_peers: { enabled: true } },
					target_reservations: 1,
				},
				rendezvous: {
					cache: {
						enabled: true,
						key: `ts-drp:browser-network:${namespace}`,
						max: 64,
						persistence: "browser-local",
					},
					endpoints: rendezvousEndpoints,
					namespace,
					...(nostrRelays.length === 0
						? {}
						: {
								nostr: {
									relays: nostrRelays,
									...(environment.nostrSecretKey === undefined || environment.nostrSecretKey.trim() === ""
										? {}
										: { secret_key: environment.nostrSecretKey.trim() }),
								},
							}),
					publish: true,
					record_ttl_ms: 60_000,
					refresh_interval_ms: 1_000,
					...(environment.rendezvousInvite === undefined || environment.rendezvousInvite.trim() === ""
						? {}
						: { invite: environment.rendezvousInvite.trim() }),
					...(allowInsecureFixture ? { allow_insecure_loopback_fixture: true } : {}),
				},
				rollout: {
					public_components: {
						delegated_routing: { enabled: true },
						public_relay_overflow: { enabled: true },
						public_rendezvous: { enabled: true },
					},
				},
				routing: {
					browser: {
						endpoints: routingEndpoints,
						limits: {
							maxAddressesPerPeer: 8,
							maxEndpoints: 4,
							maxResponseBytes: 65_536,
							maxResults: 8,
						},
						...(allowInsecureFixture
							? {
									allow_insecure_loopback_fixture: true,
									allow_single_endpoint_fixture: true,
								}
							: {}),
					},
				},
			},
		},
	};
}

/**
 * Selects the modular config when requested and otherwise preserves the legacy fixed-bootstrap path.
 * @param environment - Parsed browser-example environment.
 * @param metricsOrigin - Browser origin used only by legacy Prometheus push configuration.
 * @returns The selected DRP node configuration.
 */
export function getNetworkConfigFromEnv(environment: BrowserNetworkEnv, metricsOrigin?: string): DRPNodeConfig {
	if (isModularNetworkEnv(environment)) return buildModularNetworkConfig(environment);

	const { bootstrapPeers, discoveryInterval, enablePrometheusMetrics } = environment;
	const hasEnv = bootstrapPeers || discoveryInterval || enablePrometheusMetrics;
	const config: DRPNodeConfig = {
		network_config: {
			browser_metrics: true,
		},
	};

	if (!hasEnv) return config;

	if (bootstrapPeers) {
		config.network_config = {
			...config.network_config,
			bootstrap_peers: bootstrapPeers.split(","),
		};
	}

	if (discoveryInterval) {
		config.network_config = {
			...config.network_config,
			pubsub: {
				...config.network_config?.pubsub,
				peer_discovery_interval: discoveryInterval,
			},
		};
	}

	if (enablePrometheusMetrics) {
		config.network_config = {
			...config.network_config,
			pubsub: {
				...config.network_config?.pubsub,
				prometheus_metrics: true,
				...(metricsOrigin === undefined ? {} : { pushgateway_url: metricsOrigin }),
			},
		};
	}

	return config;
}

/**
 * @param value - Comma-separated relay operator assignments.
 * @returns Fixture relay operator groups keyed by peer ID.
 */
export function parseRelayOperatorGroups(value: string | undefined): ReadonlyMap<string, string> {
	const groups = new Map<string, string>();
	for (const entry of splitList(value)) {
		const separator = entry.indexOf("=");
		if (separator < 1 || separator === entry.length - 1) {
			throw new Error("VITE_RELAY_OPERATOR_GROUPS entries must use peerId=operatorGroup");
		}
		groups.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim());
	}
	return groups;
}

function parseExplicitBoolean(value: string | undefined): boolean {
	return value === "true" || value === "1";
}

function requiredList(value: string | undefined, name: string): string[] {
	const values = splitList(value);
	if (values.length === 0) throw new Error(`${name} is required in modular network mode`);
	return values;
}

function requiredValue(value: string | undefined, name: string): string {
	const parsed = value?.trim();
	if (parsed === undefined || parsed === "") throw new Error(`${name} is required in modular network mode`);
	return parsed;
}

function splitList(value: string | undefined): string[] {
	return (
		value
			?.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0) ?? []
	);
}

function normalizeList(value: readonly string[] | undefined): string[] {
	return value?.map((entry) => entry.trim()).filter((entry) => entry.length > 0) ?? [];
}
