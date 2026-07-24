import { type TopicScoreParams } from "@libp2p/gossipsub/score";
import { type Address, type PeerId } from "@libp2p/interface";
import { type MultiaddrInput } from "@multiformats/multiaddr";

import { type LoggerOptions } from "./logger.js";
import { type IMessageQueueHandler } from "./message-queue.js";
import { type Message } from "./proto/drp/v1/messages_pb.js";

export interface GroupPeerChange {
	/** Remote peer whose topic membership changed */
	peerId: string;
	/** Whether the remote peer joined or left the topic */
	subscribed: boolean;
	/** Topic whose remote membership changed */
	topic: string;
}

export type GroupPeerChangeHandler = (change: GroupPeerChange) => void;

export type ControlPlaneAddressFamily = "ipv4" | "ipv6" | "dns" | "unknown";

export type ControlPlaneAddressScope =
	| "public"
	| "private"
	| "loopback"
	| "link-local"
	| "multicast"
	| "reserved"
	| "unresolved"
	| "unknown";

export type ControlPlaneTransport =
	| "ws"
	| "wss"
	| "webtransport"
	| "webrtc-direct"
	| "relay"
	| "tcp"
	| "quic-v1"
	| "unknown";

export type ControlPlaneAddressReason =
	| "accepted"
	| "address-policy"
	| "browser-oriented-transport"
	| "dns-empty"
	| "dns-family-mismatch"
	| "dns-rebinding-risk"
	| "insecure-websocket"
	| "injected-policy"
	| "missing-dns-name"
	| "node-only-transport"
	| `scope-${ControlPlaneAddressScope}`
	| "unsupported-transport";

export type ControlPlaneDialReason = ControlPlaneAddressReason | "aborted" | "connected" | "dial-failed";

export type ControlPlaneHealthState = "degraded" | "healthy" | "recovering";

export type ControlPlaneRecoveryAction =
	| "continue-registries"
	| "fallback-rendezvous"
	| "fallback-router"
	| "replace-relay"
	| "retain-relayed"
	| "retain-registries"
	| "sync-another-peer"
	| "bounded-retry";

export type ControlPlaneResolverAddressFamily = "ipv4" | "ipv6" | undefined;

/** Structural DNS seam used by the dial-time address policy. */
export interface ControlPlaneAddressResolver {
	resolve(hostname: string, signal: AbortSignal, family: ControlPlaneResolverAddressFamily): Promise<string[]>;
}

interface ControlPlaneAddressEventFields {
	readonly family: ControlPlaneAddressFamily;
	readonly scope: ControlPlaneAddressScope;
	readonly transport: ControlPlaneTransport;
}

/** Sanitized, bounded control-plane telemetry. Raw locators and identities are intentionally absent. */
export type ControlPlaneEvent =
	| (ControlPlaneAddressEventFields & {
			readonly kind: "address-admission";
			readonly outcome: "accepted" | "denied";
			readonly reason: ControlPlaneAddressReason;
	  })
	| (ControlPlaneAddressEventFields & {
			readonly kind: "dial-attempt";
			readonly outcome: "ok" | "denied" | "failed";
			readonly reason: ControlPlaneDialReason;
	  })
	| {
			readonly kind: "listen-readiness";
			readonly outcome: "ready" | "failed";
			readonly transport: ControlPlaneTransport;
	  }
	| {
			readonly acceptedSourceCount: number;
			readonly failedSourceCount: number;
			readonly kind: "rendezvous-registration";
			readonly outcome: "accepted" | "failed" | "partial";
			readonly reason?: string;
	  }
	| {
			readonly failedRoomCount: number;
			readonly kind: "rendezvous-room-registration";
			readonly outcome: "accepted" | "failed" | "partial";
			readonly roomCount: number;
	  }
	| {
			readonly kind: "rendezvous-cache";
			readonly outcome: "hit" | "write";
	  }
	| {
			readonly kind: "rendezvous-invite";
			readonly outcome: "accepted" | "failed";
	  }
	| {
			readonly failure?: "acquire-threw";
			readonly kind: "relay-reservation";
			readonly outcome: "acquired" | "expired" | "failed" | "refused" | "released" | "replaced";
			readonly relayIdHash?: string;
	  }
	| { readonly kind: "first-authenticated-peer"; readonly peerIdHash: string }
	| { readonly kind: "health"; readonly state: ControlPlaneHealthState }
	| {
			readonly attempt: number;
			readonly kind: "recovery";
			readonly outcome: "attempt" | "failed" | "succeeded";
			readonly recovery: ControlPlaneRecoveryAction;
	  }
	| {
			readonly kind: "terminal";
			readonly reason: "aborted" | "deadline" | "exhausted" | "failed" | "stopped" | "succeeded";
	  }
	| { readonly kind: "cleanup"; readonly outcome: "complete" | "failed" };

export interface ControlPlaneAddressPolicyConfig {
	readonly allowInsecureWebSocket?: boolean;
	readonly allowLoopback?: boolean;
	readonly allowPrivate?: boolean;
	readonly resolver?: ControlPlaneAddressResolver;
	readonly target: "browser" | "node";
}

export type ControlPlaneMembershipConfig =
	| {
			readonly allowlist: { readonly allowedPeerIds: readonly string[] };
			readonly mode: "allowlist";
	  }
	| {
			readonly invite: { readonly inviteToken: string };
			readonly mode: "invite";
	  };

export interface ControlPlaneBrowserRoutingLimits {
	readonly maxAddressesPerPeer?: number;
	readonly maxEndpoints?: number;
	readonly maxResponseBytes?: number;
	readonly maxResults?: number;
}

export interface ControlPlaneBrowserRoutingConfig {
	readonly allow_insecure_loopback_fixture?: boolean;
	readonly allow_single_endpoint_fixture?: boolean;
	readonly endpoints?: readonly string[];
	readonly limits?: ControlPlaneBrowserRoutingLimits;
}

export interface ControlPlaneNodeRoutingConfig {
	readonly bootstrappers?: readonly string[];
	readonly enabled?: boolean;
	readonly network?: "local" | "public";
	readonly public_network_acknowledgement?: string;
}

interface ControlPlanePeerCacheBaseConfig {
	readonly enabled: boolean;
	readonly max: number;
}

export type ControlPlanePeerCacheConfig =
	| (ControlPlanePeerCacheBaseConfig & {
			readonly persistence: "memory";
	  })
	| (ControlPlanePeerCacheBaseConfig & {
			readonly key: string;
			readonly persistence: "browser-local";
	  })
	| (ControlPlanePeerCacheBaseConfig & {
			readonly path: string;
			readonly persistence: "node-fs";
	  });

export interface ControlPlaneRendezvousConfig {
	/** Test-only permission for plaintext loopback registry URLs. */
	readonly allow_insecure_loopback_fixture?: boolean;
	readonly cache?: ControlPlanePeerCacheConfig;
	readonly endpoints?: readonly string[];
	readonly invite?: string;
	readonly namespace?: string;
	readonly nostr?: {
		readonly publish?: boolean;
		readonly relays?: readonly string[];
		readonly secret_key?: string;
	};
	readonly publish?: boolean;
	readonly record_ttl_ms?: number;
	readonly refresh_interval_ms?: number;
	readonly room_presence?: {
		readonly enabled: boolean;
		/**
		 * Max concurrently advertised rooms; integer 1..32, default 7.
		 *
		 * HTTP registries count the main record and every room record against
		 * maxRecordsPerClient, so 1 + max_rooms must fit that limit. Each room
		 * also consumes one namespace; operators must size maxNamespaces for
		 * expected concurrent-room cardinality. Nostr relays are unaffected by
		 * these HTTP registry limits.
		 */
		readonly max_rooms?: number;
	};
}

export interface ControlPlaneRelaySourceToggle {
	readonly enabled?: boolean;
}

export interface ControlPlaneRelayPolicySourcesConfig {
	readonly cached_successful_relays?: ControlPlaneRelaySourceToggle;
	/** Configured fallback records are verified and supplied through the network node's dependency injection seam. */
	readonly configured_fallback?: ControlPlaneRelaySourceToggle;
	/** Public relay multiaddrs used directly as primary reservation candidates. */
	readonly configured_relays?: readonly string[];
	readonly delegated_closest_peers?: ControlPlaneRelaySourceToggle;
	readonly dht_relay_providers?: ControlPlaneRelaySourceToggle;
	readonly node_closest_peers?: ControlPlaneRelaySourceToggle;
	readonly registry_relay_records?: ControlPlaneRelaySourceToggle;
}

export interface ControlPlaneRelayPolicyConfig {
	/**
	 * Deadline in milliseconds for each relay candidate. Must be an integer from 1 through 10,000.
	 */
	readonly per_candidate_deadline_ms?: number;
	readonly sources?: ControlPlaneRelayPolicySourcesConfig;
	readonly target_reservations?: number;
	/**
	 * Total relay-policy deadline in milliseconds. Must be an integer greater than or equal to
	 * `per_candidate_deadline_ms` and no greater than 120,000. An explicit value overrides the
	 * 55,000 ms node-overflow heuristic.
	 */
	readonly total_deadline_ms?: number;
}

export interface ControlPlaneToggleConfig {
	readonly enabled: boolean;
}

export type ControlPlaneIpColocationConfig =
	| {
			readonly enabled: false;
	  }
	| {
			readonly enabled: true;
			readonly threshold: number;
			readonly weight: number;
			readonly whitelist?: readonly string[];
	  };

export interface ControlPlanePubsubScoringConfig {
	readonly ip_colocation?: ControlPlaneIpColocationConfig;
	readonly observed_behavior_reward?: {
		readonly enabled: boolean;
		/**
		 * Unweighted application-score cap. GossipSub multiplies this by its
		 * application-specific weight (10); the result must remain strictly below
		 * its accept-PX threshold (10), so values greater than or equal to 1 fail closed.
		 */
		readonly max_application_score: number;
	};
}

export interface ControlPlaneOwnedFallbackToggleConfig {
	readonly enabled?: true;
}

export interface ControlPlaneRolloutConfig {
	readonly owned_fallback?: {
		readonly configured_relays?: ControlPlaneOwnedFallbackToggleConfig;
		readonly local_routing?: ControlPlaneOwnedFallbackToggleConfig;
		readonly owned_rendezvous?: ControlPlaneOwnedFallbackToggleConfig;
	};
	readonly public_components?: {
		readonly delegated_routing?: ControlPlaneToggleConfig;
		readonly public_relay_overflow?: ControlPlaneToggleConfig;
		readonly public_rendezvous?: ControlPlaneToggleConfig;
		readonly pubsub_behavior_rewards?: ControlPlaneToggleConfig;
	};
}

export interface ControlPlaneRecoveryConfig {
	readonly backend_cooldown_ms: number;
	readonly health_poll_interval_ms?: number;
	readonly max_attempts: number;
	readonly parent_deadline_ms: number;
	readonly recovery_backoff_ms?: number;
	readonly retry_delays_ms?: readonly number[];
	readonly startup_grace_ms?: number;
}

export interface ControlPlaneConnectionEvidence {
	readonly multiaddr: string;
	readonly peerId: string;
	readonly transport: ControlPlaneTransport;
}

export interface ControlPlaneRelayReservationEvidence {
	readonly expiresAtMs: number;
	readonly operatorGroup: string;
	readonly peerId: string;
}

/** Phase 2 structural owners; later phases add runtime implementations behind these sections. */
export interface ControlPlaneConfig {
	readonly address_policy?: ControlPlaneAddressPolicyConfig;
	readonly membership?: ControlPlaneMembershipConfig;
	readonly observability?: {
		sink(event: ControlPlaneEvent): void;
	};
	readonly pubsub_scoring?: ControlPlanePubsubScoringConfig;
	readonly recovery?: ControlPlaneRecoveryConfig;
	readonly relay_policy?: ControlPlaneRelayPolicyConfig;
	readonly rendezvous?: ControlPlaneRendezvousConfig;
	readonly rollout?: ControlPlaneRolloutConfig;
	readonly routing?: {
		readonly browser?: ControlPlaneBrowserRoutingConfig;
		readonly node?: ControlPlaneNodeRoutingConfig;
	};
}

/**
 * Configuration interface for DRP Network Node
 */
export interface DRPNetworkNodeConfig {
	/** List of addresses to announce to the network */
	announce_addresses?: string[];
	/** Whether to enable AutoNAT address verification independently of local node roles. */
	autonat?: boolean;
	/** List of bootstrap peers to connect to */
	bootstrap_peers?: string[];
	/** Whether to enable browser metrics */
	browser_metrics?: boolean;
	/** List of addresses to listen on */
	listen_addresses?: string[];
	/** Logger configuration options */
	log_config?: LoggerOptions;
	/** Independently owned routing, rendezvous, relay-client, admission, and telemetry policy. */
	control_plane?: ControlPlaneConfig;
	/** Pubsub configuration */
	pubsub?: {
		/** Interval in milliseconds between peer discovery attempts */
		peer_discovery_interval?: number;
		/** Whether to enable prometheus metrics */
		prometheus_metrics?: boolean;
		/** URL of the pushgateway to send metrics to */
		pushgateway_url?: string;
	};
	/** Optional local Circuit Relay v2 service capacity, independent of seed behavior. */
	relay_service?: {
		/** Whether this node serves relay reservations. */
		enabled: boolean;
		/** Maximum simultaneous reservations accepted by the relay service. */
		max_reservations?: number;
	};
	/** Whether this node is a forward-only fixed rendezvous seed. */
	seed?: boolean;
}

/** Minimal structural membership verifier exposed without importing the membership package. */
export interface DRPNetworkMembershipVerifier {
	verify(request: {
		readonly credential?: unknown;
		readonly peerId: string;
		readonly signal: AbortSignal;
	}): Promise<unknown>;
}

/**
 * Interface for DRP Network Node
 */
export interface DRPNetworkNode {
	/**
	 * The unique identifier of this node in the network
	 */
	peerId: string;

	/** Constructed membership verifier seam; connection-path enforcement is not active until rendezvous integration. */
	readonly membershipVerifier: DRPNetworkMembershipVerifier | undefined;

	/**
	 * Starts the network node and begins listening for connections
	 * @param [rawPrivateKey] - Optional raw private key for node identity
	 * @returns Resolves when the node has started
	 * @throws {Error} If the node is already started
	 */
	start(rawPrivateKey?: Uint8Array): Promise<void>;

	/**
	 * Stops the network node and closes all connections
	 * @returns Resolves when the node has stopped
	 * @throws {Error} If the node is not started
	 */
	stop(): Promise<void>;

	/**
	 * Restarts the network node with optional new configuration
	 * @param [config] - New configuration to apply
	 * @param [rawPrivateKey] - New raw private key for node identity
	 * @returns Resolves when the node has restarted
	 */
	restart(config?: DRPNetworkNodeConfig, rawPrivateKey?: Uint8Array): Promise<void>;

	/**
	 * Checks if the node is dialable (can be connected to) by other peers
	 * @param [callback] - Optional callback to execute when node becomes dialable
	 * @returns True if the node is dialable
	 */
	isDialable(callback?: () => void | Promise<void>): Promise<boolean>;

	/**
	 * Updates the score parameters for a specific topic
	 * @param topic - The topic to update score parameters for
	 * @param params - New score parameters to apply
	 */
	changeTopicScoreParams(topic: string, params: TopicScoreParams): void;

	/**
	 * Removes the score parameters for a specific topic
	 * @param topic - The topic to remove score parameters from
	 */
	removeTopicScoreParams(topic: string): void;

	/**
	 * Subscribes to a topic to receive messages published to it
	 * @param topic - The topic to subscribe to
	 * @throws {Error} If the node is not initialized
	 */
	subscribe(topic: string): void;

	/**
	 * Unsubscribes from a topic to stop receiving messages from it
	 * @param topic - The topic to unsubscribe from
	 * @throws {Error} If the node is not initialized
	 */
	unsubscribe(topic: string): void;

	/**
	 * Connects to the bootstrap nodes
	 * @returns Resolves when connection is established
	 */
	connectToBootstraps(): Promise<void>;

	/** Redials configured bootstrap addresses and reports whether a connection was established. */
	redialBootstraps?(signal: AbortSignal): Promise<boolean>;

	/**
	 * Connects to one or more peer addresses
	 * @param addr - The address(es) to connect to
	 * @returns Resolves when connection is established
	 */
	connect(addr: MultiaddrInput | MultiaddrInput[]): Promise<void>;

	/**
	 * Disconnects from a peer
	 * @param peerId - The ID of the peer to disconnect from
	 * @returns Resolves when disconnection is complete
	 */
	disconnect(peerId: string): Promise<void>;

	/**
	 * Gets the multiaddresses for a specific peer
	 * @param peerId - The ID of the peer
	 * @returns Array of peer's multiaddresses
	 */
	getPeerMultiaddrs(peerId: PeerId | string): Promise<Address[]>;

	/**
	 * Gets the list of bootstrap nodes
	 * @returns Array of bootstrap node addresses
	 */
	getBootstrapNodes(): string[];

	/**
	 * Get all topics this node is subscribed to
	 * @returns Array of topics
	 */
	getSubscribedTopics(): string[];

	/**
	 * Gets the multiaddresses this node is listening on
	 * @returns Array of multiaddresses or undefined if not started
	 */
	getMultiaddrs(): string[] | undefined;

	/**
	 * Gets all peers currently connected to this node
	 * @returns Array of peer IDs
	 */
	getAllPeers(): string[];

	/** Sanitized live connection evidence for health aggregation. */
	getControlPlaneConnections?(): readonly ControlPlaneConnectionEvidence[];

	/** Defensive snapshots of the relay policy's current live reservations. */
	getActiveRelayReservations?(): readonly ControlPlaneRelayReservationEvidence[];

	/** Delegates a health-recovery relay replacement to the relay-policy owner. */
	replaceRelay?(
		request: { readonly excludedOperatorGroup?: string; readonly relayId?: string },
		signal: AbortSignal
	): Promise<boolean>;

	/** Forces the attached routing owner to refresh/fail over when available. */
	refreshRouting?(signal: AbortSignal): Promise<boolean>;

	/**
	 * Gets all peers subscribed to a specific group/topic
	 * @param group - The group/topic to get peers for
	 * @returns Array of peer IDs subscribed to the group
	 */
	getGroupPeers(group: string): string[];

	/**
	 * Broadcasts a message to all peers subscribed to a topic
	 * @param topic - The topic to broadcast to
	 * @param message - The message to broadcast
	 * @returns Resolves when the message has been broadcast
	 */
	broadcastMessage(topic: string, message: Message): Promise<void>;

	/**
	 * Sends a message to a specific peer
	 * @param peerId - The ID of the peer to send to
	 * @param message - The message to send
	 * @returns Resolves when the message has been sent
	 */
	sendMessage(peerId: string, message: Message): Promise<void>;

	/**
	 * Sends a message to a random peer in a group
	 * @param group - The group to select a random peer from
	 * @param message - The message to send
	 * @returns Resolves when the message has been sent
	 * @throws {Error} If the group has no peers
	 */
	sendGroupMessageRandomPeer(group: string, message: Message): Promise<void>;

	/**
	 * Subscribes to the message queue
	 * @param handler - The handler to subscribe to the message queue
	 */
	subscribeToMessageQueue(handler: IMessageQueueHandler<Message>): void;

	/**
	 * Subscribes to remote group membership and GossipSub mesh changes.
	 * @param handler - Handler invoked when a remote peer appears or disappears on a topic
	 * @returns A function that removes the handler
	 */
	subscribeToGroupPeerChanges(handler: GroupPeerChangeHandler): () => void;
}
