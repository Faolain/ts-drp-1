import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { inspectorMetrics } from "@ipshipyard/libp2p-inspector-metrics";
import { autoNAT } from "@libp2p/autonat";
import { bootstrap, type BootstrapComponents } from "@libp2p/bootstrap";
import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { dcutr } from "@libp2p/dcutr";
import { type GossipSub, gossipsub, type GossipsubOpts, type SignedMessage, StrictSign } from "@libp2p/gossipsub";
import { RPC } from "@libp2p/gossipsub/message";
import {
	createPeerScoreParams,
	createTopicScoreParams,
	defaultPeerScoreParams,
	defaultPeerScoreThresholds,
	type PeerScore,
	type PeerScoreParams,
	type TopicScoreParams,
} from "@libp2p/gossipsub/score";
import { identify, identifyPush } from "@libp2p/identify";
import {
	type Address,
	type Connection,
	type IdentifyResult,
	type PeerDiscovery,
	type PeerId,
	type Stream,
} from "@libp2p/interface";
import { peerIdFromPublicKey, peerIdFromString } from "@libp2p/peer-id";
import { ping } from "@libp2p/ping";
import { pubsubPeerDiscovery, type PubSubPeerDiscoveryComponents } from "@libp2p/pubsub-peer-discovery";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { dns } from "@multiformats/dns";
import { type Multiaddr, multiaddr, type MultiaddrInput } from "@multiformats/multiaddr";
import { WebRTC } from "@multiformats/multiaddr-matcher";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { Logger } from "@ts-drp/logger";
import { AllowlistVerifier, InviteVerifier, type MembershipVerifier } from "@ts-drp/membership";
import { MessageQueue } from "@ts-drp/message-queue";
import {
	type ActiveRelayReservation,
	CIRCUIT_RELAY_V2_HOP_PROTOCOL,
	CompositeRelayCandidateSource,
	ConfiguredPublicRelaySource,
	DEFAULT_RELAY_POLICY_LIMITS,
	type DnsaddrFallback,
	EvidenceDerivedOperatorGroupClassifier,
	Libp2pRelayClient,
	type Libp2pRelayClientOptions,
	RELAY_TRANSPORT_PROFILES,
	type RelayCandidateSource,
	RelayPolicy,
	type RelayPolicyResult,
	type RelayReplacementResult,
	type RelayReservationLifecycleEvent,
	type RelayTransportProfile,
} from "@ts-drp/relay-policy";
import { type AddressDecision, AddressPolicy, classifyIpAddressScope, createDnsResolver } from "@ts-drp/rendezvous";
import {
	type ControlPlaneAddressFamily,
	type ControlPlaneAddressReason,
	type ControlPlaneAddressScope,
	type ControlPlaneEvent,
	type ControlPlaneMembershipConfig,
	type ControlPlaneTransport,
	DRP_DISCOVERY_TOPIC,
	DRP_INTERVAL_DISCOVERY_TOPIC,
	type DRPConnectionBudget,
	type DRPNetworkNodeConfig,
	type DRPNetworkNode as DRPNetworkNodeInterface,
	type DRPPeerSelectionSnapshot,
	type GroupPeerChange,
	type GroupPeerChangeHandler,
	type IMessageQueueHandler,
	IntervalRunnerState,
	Message,
	MessageType,
	type PeerConnectionHandler,
	type PeerDisconnectHandler,
} from "@ts-drp/types";
import { createLibp2p, type Libp2p, type Libp2pOptions, type ServiceFactoryMap } from "libp2p";
import { isBrowser, isWebWorker } from "wherearewe";

import {
	type ConnectionAdmissionController,
	createConnectionAdmissionController,
	type ExplicitDialTicket,
	resolveConnectionBudget,
} from "./connection-budget.js";
import { createMetricsRegister, type PrometheusMetricsRegister } from "./metrics/prometheus.js";
import { PeerSelector } from "./peer-selector.js";
import {
	SNAPSHOT_CHUNK_PROTOCOL,
	type SnapshotChunkProtocolPort,
	type SnapshotChunkProtocolStream,
} from "./snapshot-transfer.js";
import { readUint8ArrayFrame, streamToUint8Array, uint8ArrayToStream, writeUint8ArrayFrame } from "./stream.js";
import {
	createDirectSyncIngress,
	type DirectSyncIngress,
	DRP_MESSAGE_PROTOCOL,
	DRP_SYNC_PROTOCOLS,
	isDirectSyncIngress,
	isSyncProtocolMessage,
	selectedSyncProtocol,
	type SelectedSyncProtocol,
	SyncTransportError,
	validateNegotiatedSync,
} from "./sync.js";
import {
	createDRPUnreliableWebRtcOwner,
	createLibp2pWebRtcSignalingPort,
	DRP_UNRELIABLE_WEBRTC_MAX_PAYLOAD_BYTES,
	DRP_UNRELIABLE_WEBRTC_SIGNALING_PROTOCOL,
	type DRPUnreliableWebRtcOwner,
} from "./unreliable-webrtc.js";

export * from "./stream.js";
export {
	directSyncProtocolFor,
	DRP_HEADS_CHUNK_PROTOCOL,
	DRP_MESSAGE_PROTOCOL,
	DRP_SYNC_PROTOCOLS,
	isDirectSyncIngress,
	isSyncProtocolMessage,
	type DRPSyncMode,
	type DRPSyncProtocol,
	type NegotiatedSyncSender,
	type SelectedSyncProtocol,
	SYNC_FALLBACK_HASH_CAP,
	SYNC_HEADS_FIELD_HASH_CAP,
	SYNC_HEADS_TOTAL_HASH_CAP,
	SYNC_OUTSTANDING_EXACT_CAP,
	SYNC_REQUEST_BYTE_CAP,
	SYNC_RESPONSE_BYTE_CAP,
	SYNC_RESPONSE_CHUNK_CAP,
	SYNC_RESPONSE_VERTEX_CAP,
	SyncTransportError,
	validateNegotiatedSync,
} from "./sync.js";
export type { GroupPeerChange, GroupPeerChangeHandler } from "@ts-drp/types";

export const BOOTSTRAP_NODES = [
	"/dns4/bootstrap1.topology.gg/tcp/443/wss/p2p/16Uiu2HAm4MeUv712cWmXpvGEZ1r1741YoWvsCcmptCza43b7opdK",
	"/dns4/bootstrap2.topology.gg/tcp/443/wss/p2p/16Uiu2HAmGjAVQyzgTCumpB9TuojKT4LZTBC5HRiZyuwGG9VHodLC",
];
let log: Logger;
const PUBSUB_SIGN_PREFIX = new TextEncoder().encode("libp2p-pubsub:");
const MIN_PUBSUB_SEQUENCE = BigInt(0);
const MAX_PUBSUB_SEQUENCE = BigInt("18446744073709551615");

type IngressTransport =
	| Readonly<{ kind: "authenticated-stream"; protocol: string; sender: string }>
	| Readonly<{ kind: "signed-gossip"; sender: string; topic: string }>;

type IngressEvidence = Readonly<{
	message: Readonly<{ data: Uint8Array; objectId: string; sender: string; type: MessageType }>;
	transport: IngressTransport;
}>;

function isClaimableIngress(message: Message): boolean {
	return message.type === MessageType.MESSAGE_TYPE_CUSTOM || message.type === MessageType.MESSAGE_TYPE_V3_ENVELOPE;
}

function sameIngressBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function pubsubSignaturePreimage(message: SignedMessage): Uint8Array | undefined {
	try {
		if (message.sequenceNumber < MIN_PUBSUB_SEQUENCE || message.sequenceNumber > MAX_PUBSUB_SEQUENCE) return undefined;
		const sequenceNumber = new Uint8Array(8);
		new DataView(sequenceNumber.buffer).setBigUint64(0, message.sequenceNumber, false);
		const encoded = RPC.Message.encode({
			from: message.from.toMultihash().bytes,
			data: message.data,
			seqno: sequenceNumber,
			topic: message.topic,
			signature: undefined,
			key: undefined,
		});
		const preimage = new Uint8Array(PUBSUB_SIGN_PREFIX.byteLength + encoded.byteLength);
		preimage.set(PUBSUB_SIGN_PREFIX);
		preimage.set(encoded, PUBSUB_SIGN_PREFIX.byteLength);
		return preimage;
	} catch {
		return undefined;
	}
}

async function validateToRawMessage(message: SignedMessage): Promise<boolean> {
	const preimage = pubsubSignaturePreimage(message);
	if (preimage === undefined) return false;
	try {
		return await message.key.verify(preimage, message.signature);
	} catch {
		return false;
	}
}

const WARM_RELAY_RETRY_BASE_DELAY_MS = 100;
const WARM_RELAY_RETRY_MAX_DELAY_MS = 2_000;
const WARM_RELAY_RETRY_MAX_ATTEMPTS = 8;

type PeerDiscoveryFunction =
	| ((components: PubSubPeerDiscoveryComponents) => PeerDiscovery)
	| ((components: BootstrapComponents) => PeerDiscovery);

type ConfigurableGossipSub = GossipSub & {
	mesh: Map<string, Set<string>>;
	score: PeerScore;
	streamsOutbound: Map<string, unknown>;
};

/**
 * Additive libp2p control-plane modules accepted by the production host
 * builder. DRP owns the core services and rejects attempts to replace them.
 */
export interface DRPNetworkHostExtensions {
	contentRouters?: NonNullable<Libp2pOptions["contentRouters"]>;
	peerDiscovery?: NonNullable<Libp2pOptions["peerDiscovery"]>;
	peerRouters?: NonNullable<Libp2pOptions["peerRouters"]>;
	services?: ServiceFactoryMap & {
		autonat?: never;
		dcutr?: never;
		identify?: never;
		identifyPush?: never;
		ping?: never;
		pubsub?: never;
		relay?: never;
	};
	transports?: NonNullable<Libp2pOptions["transports"]>;
}

export interface DRPNetworkHostFactoryContext {
	/**
	 * Build the one host owned by this DRPNetworkNode. Extensions are additive;
	 * reserved DRP services such as GossipSub cannot be replaced.
	 */
	createHost(extensions?: DRPNetworkHostExtensions): Promise<Libp2p>;
	/**
	 * Immutable evidence of the production options applied before extensions.
	 * Control-plane factories can fail closed when an isolation invariant is absent.
	 */
	readonly snapshot: DRPNetworkHostConfigSnapshot;
}

export type DRPNetworkHostFactory = (context: DRPNetworkHostFactoryContext) => Promise<Libp2p>;

type DenyDialMultiaddr = NonNullable<NonNullable<Libp2pOptions["connectionGater"]>["denyDialMultiaddr"]>;

export interface DRPNetworkHostPolicy {
	/**
	 * Production defaults to bootstrap discovery. Isolated control planes disable
	 * it and supply routing-backed discovery through host extensions instead.
	 */
	readonly bootstrapDiscovery?: boolean;
	/**
	 * Production defaults to cold-start pubsub peer discovery. Isolated control
	 * planes enable it only after an authenticated rendezvous connection exists.
	 */
	readonly coldStartPubsubDiscovery?: boolean;
	/** Production defaults to GossipSub peer exchange. */
	readonly gossipSubPeerExchange?: boolean;
	/** Delegates the real libp2p outbound multiaddr gate to the control plane. */
	readonly denyDialMultiaddr?: DenyDialMultiaddr;
}

export interface DRPNetworkHostConfigSnapshot {
	readonly bootstrapDiscovery: boolean;
	readonly bootstrapPeerCount: number;
	readonly coldStartPubsubDiscovery: boolean;
	readonly connectionBudget?: DRPConnectionBudget;
	readonly globalDiscovery?: boolean;
	readonly gossipSubPeerExchange: boolean;
	readonly outboundAddressPolicy: "address-policy" | "allow-all" | "injected";
	readonly peerDiscoveryModules: readonly ("@libp2p/bootstrap" | "@libp2p/pubsub-peer-discovery")[];
	readonly rollout: {
		readonly ownedFallback: {
			readonly configuredRelays: true;
			readonly localRouting: true;
			readonly ownedRendezvous: true;
		};
		readonly publicComponents: {
			readonly delegatedRouting: boolean;
			readonly publicRelayOverflow: boolean;
			readonly publicRendezvous: boolean;
			readonly pubsubBehaviorRewards: boolean;
		};
	};
}

export interface ObservedPeerBehavior {
	readonly authenticated: boolean;
	readonly diversityScore: number;
	readonly validBehaviorScore: number;
}

export interface AuthenticatedPeerBehaviorProvider {
	getObservedPeerBehavior(peerId: string): ObservedPeerBehavior | undefined;
}

export interface DRPNetworkNodeDependencies {
	authenticatedPeerBehaviorProvider?: AuthenticatedPeerBehaviorProvider;
	hostFactory?: DRPNetworkHostFactory;
	hostPolicy?: DRPNetworkHostPolicy;
	relayCandidateSources?: {
		readonly cachedSuccessfulRelays?: RelayCandidateSource;
		readonly configuredFallback?: RelayCandidateSource;
		readonly delegatedClosestPeers?: RelayCandidateSource;
		readonly dhtRelayProviders?: RelayCandidateSource;
		readonly nodeClosestPeers?: RelayCandidateSource;
		readonly registryRelayRecords?: RelayCandidateSource;
	};
	/** Optional bounded owned DNSADDR fallback used after candidate reservations are exhausted. */
	relayFallback?: DnsaddrFallback;
	relayPolicyFactory?(options: RelayPolicyFactoryOptions): RelayPolicyDriver;
}

export interface RelayPolicyFactoryOptions {
	onReservationEvent(event: RelayReservationLifecycleEvent): void;
	readonly perCandidateDeadlineMs: number;
	readonly source: RelayCandidateSource;
	readonly targetReservations: number;
	readonly totalDeadlineMs: number;
	readonly transportProfile?: RelayTransportProfile;
}

export interface RelayPolicyDriver {
	readonly activeReservations?: readonly ActiveRelayReservation[];
	acquire(queryKey: Uint8Array, signal: AbortSignal): Promise<RelayPolicyResult>;
	refresh(signal: AbortSignal): Promise<RelayPolicyResult>;
	replace(
		peerId: string,
		reason: RelayReplacementResult["reason"],
		signal: AbortSignal,
		excludedOperatorGroup?: string
	): Promise<RelayReplacementResult>;
	stop(): Promise<void>;
}

interface ResolvedRelayPolicyConfiguration {
	readonly source: RelayCandidateSource;
	readonly targetReservations: number;
	readonly transportProfile: RelayTransportProfile;
}

const CORE_SERVICE_NAMES = new Set(["ping", "dcutr", "identify", "identifyPush", "pubsub", "autonat", "relay"]);
const NODE_CLOSEST_PEERS_RELAY_TOTAL_DEADLINE_MS = 55_000;

const APP_SPECIFIC_WEIGHT = defaultPeerScoreParams.appSpecificWeight;
const ACCEPT_PX_THRESHOLD = defaultPeerScoreThresholds.acceptPXThreshold;

const defaultHostFactory: DRPNetworkHostFactory = (context) => context.createHost();

const outboundDns = dns();
const outboundDnsResolver = createDnsResolver({ client: outboundDns });

function createMembershipVerifier(config: ControlPlaneMembershipConfig | undefined): MembershipVerifier | undefined {
	if (config === undefined) return undefined;
	const runtimeConfig = config as {
		allowlist?: { allowedPeerIds?: unknown };
		invite?: { inviteToken?: unknown };
		mode?: unknown;
	};
	if (runtimeConfig.mode === "invite") {
		if (typeof runtimeConfig.invite?.inviteToken !== "string" || runtimeConfig.invite.inviteToken.length === 0) {
			throw new Error("control_plane.membership invite mode requires invite.inviteToken");
		}
		return new InviteVerifier({ inviteToken: runtimeConfig.invite.inviteToken });
	}
	if (runtimeConfig.mode === "allowlist") {
		if (
			!Array.isArray(runtimeConfig.allowlist?.allowedPeerIds) ||
			runtimeConfig.allowlist.allowedPeerIds.length === 0 ||
			!runtimeConfig.allowlist.allowedPeerIds.every((peerId) => typeof peerId === "string")
		) {
			throw new Error("control_plane.membership allowlist mode requires a non-empty allowlist.allowedPeerIds");
		}
		return new AllowlistVerifier({ allowedPeerIds: runtimeConfig.allowlist.allowedPeerIds });
	}
	throw new Error("control_plane.membership.mode must be one of: invite, allowlist");
}

function boundedAddressReason(decision: AddressDecision): ControlPlaneAddressReason {
	const [reason] = decision.reasons;
	if (
		reason === "browser-oriented-transport" ||
		reason === "dns-empty" ||
		reason === "dns-family-mismatch" ||
		reason === "dns-rebinding-risk" ||
		reason === "insecure-websocket" ||
		reason === "missing-dns-name" ||
		reason === "node-only-transport" ||
		reason === "unsupported-transport" ||
		reason?.startsWith("scope-") === true
	) {
		return reason as ControlPlaneAddressReason;
	}
	return decision.dialable ? "accepted" : "address-policy";
}

function sanitizedAddressFields(address: Multiaddr): {
	family: ControlPlaneAddressFamily;
	scope: ControlPlaneAddressScope;
	transport: ControlPlaneTransport;
} {
	const components = address.getComponents();
	const names = components.map(({ name }) => name);
	const host = components.find(({ name }) => ["ip4", "ip6", "dns", "dns4", "dns6", "dnsaddr"].includes(name));
	const family: ControlPlaneAddressFamily =
		host?.name === "ip4"
			? "ipv4"
			: host?.name === "ip6"
				? "ipv6"
				: host?.name === "dns" || host?.name === "dns4" || host?.name === "dns6" || host?.name === "dnsaddr"
					? "dns"
					: "unknown";
	const scope: ControlPlaneAddressScope =
		family === "ipv4" || family === "ipv6"
			? classifyIpAddressScope(host?.value ?? "")
			: family === "dns"
				? "unresolved"
				: "unknown";
	const transport: ControlPlaneTransport = names.includes("p2p-circuit")
		? "relay"
		: names.includes("webrtc-direct") || names.includes("webrtc")
			? "webrtc-direct"
			: names.includes("webtransport")
				? "webtransport"
				: names.includes("wss") || (names.includes("ws") && names.includes("tls"))
					? "wss"
					: names.includes("ws")
						? "ws"
						: names.includes("quic-v1")
							? "quic-v1"
							: names.includes("tcp")
								? "tcp"
								: "unknown";
	return { family, scope, transport };
}

function sanitizedRelayIdHash(relayId: string): string {
	return bytesToHex(sha256(new TextEncoder().encode(relayId))).slice(0, 16);
}

interface PendingSyncSend {
	reject(reason?: unknown): void;
	resolve(): void;
	run(): Promise<void>;
}

class SyncSendAdmission {
	private active = false;
	private activeTask?: PendingSyncSend;
	private closed = false;
	private readonly queued: PendingSyncSend[] = [];

	constructor(connection: Connection) {
		connection.addEventListener(
			"close",
			() => {
				this.closed = true;
				const error = new SyncTransportError("SYNC_CONNECTION_CLOSED", "Sync connection closed");
				this.activeTask?.reject(error);
				this.activeTask = undefined;
				for (const task of this.queued.splice(0)) task.reject(error);
			},
			{ once: true }
		);
	}

	submit(run: () => Promise<void>): Promise<void> {
		if (this.closed) {
			return Promise.reject(new SyncTransportError("SYNC_CONNECTION_CLOSED", "Sync connection is closed"));
		}
		if (this.active && this.queued.length >= 2) {
			return Promise.reject(new SyncTransportError("SYNC_SEND_QUEUE_FULL", "Sync send queue is full"));
		}

		return new Promise<void>((resolve, reject) => {
			const task = { reject, resolve, run };
			if (this.active) {
				this.queued.push(task);
				return;
			}
			this.active = true;
			void this.execute(task);
		});
	}

	private async execute(task: PendingSyncSend): Promise<void> {
		this.activeTask = task;
		try {
			if (this.closed) throw new SyncTransportError("SYNC_CONNECTION_CLOSED", "Sync connection is closed");
			await task.run();
			task.resolve();
		} catch (error) {
			task.reject(error);
		} finally {
			if (this.activeTask === task) this.activeTask = undefined;
			const next = this.queued.shift();
			if (next === undefined) {
				this.active = false;
			} else {
				void this.execute(next);
			}
		}
	}
}

/**
 * The DRPNetworkNode class is the main class for the DRP network.
 * It handles the creation and management of the libp2p node, pubsub, and message queue.
 */
export class DRPNetworkNode implements DRPNetworkNodeInterface {
	private _config?: DRPNetworkNodeConfig;
	private _node?: Libp2p;
	private _pubsub?: ConfigurableGossipSub;
	private _connectionAdmission?: ConnectionAdmissionController;
	private _peerSelector?: PeerSelector;
	private _messageQueue: MessageQueue<Message | DirectSyncIngress>;
	private _activeUnreliableWebRtcOwner?: DRPUnreliableWebRtcOwner;
	private _unreliableWebRtcIncoming?: (stream: Stream, connection: Connection) => Promise<void>;
	private _snapshotChunkIncoming?: (stream: Stream, connection: Connection) => Promise<void>;
	private readonly _unreliableWebRtcOwner: DRPUnreliableWebRtcOwner;
	private readonly _ingressEvidence = new WeakMap<Message, IngressEvidence>();
	private readonly _syncAdmissions = new WeakMap<Connection, SyncSendAdmission>();
	private _metrics?: PrometheusMetricsRegister;
	private _bootstrapRetryController?: AbortController;
	private _relayPolicyController?: AbortController;
	private _relayPolicy?: RelayPolicyDriver;
	private _relayPolicyAcquirePromise: Promise<void> = Promise.resolve();
	private _lastRelayPolicyResult?: RelayPolicyResult;
	private _relayPolicyFailed = false;
	private _relayDisconnectListener?: (event: CustomEvent<PeerId>) => void;
	private _warmRelayIdentifyListener?: (event: CustomEvent<IdentifyResult>) => void;
	private _warmRelayRetryAttempts = 0;
	private _warmRelayRetryTimer?: ReturnType<typeof setTimeout>;
	private _relayMaintenanceTail: Promise<void> = Promise.resolve();
	private _relayRefreshTimer?: ReturnType<typeof setTimeout>;
	private _reservedRelayPeerIds = new Set<string>();
	private readonly _relayPriorityTickets = new Map<string, ExplicitDialTicket>();
	private _groupPeerChangeHandlers = new Set<GroupPeerChangeHandler>();
	private _peerConnectionHandlers = new Set<PeerConnectionHandler>();
	private _peerDisconnectHandlers = new Set<PeerDisconnectHandler>();
	private readonly _hostFactory: DRPNetworkHostFactory;
	private readonly _hostPolicy: DRPNetworkHostPolicy;
	private readonly _authenticatedPeerBehaviorProvider: DRPNetworkNodeDependencies["authenticatedPeerBehaviorProvider"];
	private readonly _relayCandidateSources: DRPNetworkNodeDependencies["relayCandidateSources"];
	private readonly _relayFallback: DRPNetworkNodeDependencies["relayFallback"];
	private readonly _relayPolicyFactory: DRPNetworkNodeDependencies["relayPolicyFactory"];
	private _membershipVerifier?: MembershipVerifier;
	private _outboundAddressPolicy: DRPNetworkHostConfigSnapshot["outboundAddressPolicy"] = "allow-all";
	private _expectedReplicas?: number;
	private _globalDiscovery = false;

	peerId = "";

	/**
	 * Constructor for the DRPNetworkNode class.
	 * @param config - The configuration for the node.
	 * @param dependencies - Injectable host construction dependencies
	 */
	constructor(config?: DRPNetworkNodeConfig, dependencies: DRPNetworkNodeDependencies = {}) {
		if (config?.browser_metrics && !isBrowser && !isWebWorker) {
			throw new Error("Browser metrics are only supported in a browser or web worker");
		}

		this._config = config;
		this._authenticatedPeerBehaviorProvider = dependencies.authenticatedPeerBehaviorProvider;
		this._hostFactory = dependencies.hostFactory ?? defaultHostFactory;
		this._hostPolicy = dependencies.hostPolicy ?? {};
		this._relayCandidateSources = dependencies.relayCandidateSources;
		this._relayFallback = dependencies.relayFallback;
		this._relayPolicyFactory = dependencies.relayPolicyFactory;
		this._membershipVerifier = createMembershipVerifier(config?.control_plane?.membership);
		log = new Logger("drp::network", config?.log_config);
		this._messageQueue = new MessageQueue<Message | DirectSyncIngress>({
			id: "network",
			logConfig: config?.log_config,
		});
		this._unreliableWebRtcOwner = Object.freeze({
			close: (): void => this._resetUnreliableWebRtcOwner(),
			openUnreliableWebRtcRoute: (routeId: string) => {
				const active = this._activeUnreliableWebRtcOwner;
				if (active !== undefined) return active.openUnreliableWebRtcRoute(routeId);
				return Object.freeze({
					close(): void {},
					maxPayloadBytes: DRP_UNRELIABLE_WEBRTC_MAX_PAYLOAD_BYTES,
					onMessage: (): (() => void) => (): void => undefined,
					reconcile: (): Promise<void> => Promise.resolve(),
					restart: (): Promise<void> => Promise.resolve(),
					send: (): Promise<boolean> => Promise.resolve(false),
					snapshot: () =>
						Object.freeze({
							activeLinks: 0,
							authenticatedConnectionLosses: 0,
							backpressuredDrops: 0,
							handshakeFailures: 0,
							lastLinkDrop: undefined,
							linkDrops: 0,
							links: Object.freeze([]),
							received: 0,
							routedBytesReceived: 0,
							routedBytesSent: 0,
							sent: 0,
							unknownRouteDrops: 0,
						}),
				});
			},
		});
		this._validateRelayPolicyConfiguration(false);
	}

	/**
	 * Verifier selected by the configured control-plane membership owner. This seam is constructed and exposed but is
	 * not yet enforced on any connection path; enforcement arrives with rendezvous integration.
	 * @returns The configured verifier, or undefined when membership is not configured.
	 */
	get membershipVerifier(): MembershipVerifier | undefined {
		return this._membershipVerifier;
	}

	/** @returns Stable fail-closed raw WebRTC owner for the node lifecycle. */
	get unreliableWebRtcOwner(): DRPUnreliableWebRtcOwner {
		return this._unreliableWebRtcOwner;
	}

	/**
	 * Creates one dedicated snapshot protocol port over already-open authenticated connections.
	 * This method is consumed only by the non-root snapshot-transfer subpath.
	 * @returns A bounded port with no dial fallback.
	 */
	createSnapshotChunkProtocolHost(): SnapshotChunkProtocolPort {
		const active = new Set<Stream>();
		let closed = false;
		let selectedHandler: ((stream: SnapshotChunkProtocolStream) => Promise<void>) | undefined;
		let incoming: ((stream: Stream, connection: Connection) => Promise<void>) | undefined;
		const failure = (code: string, message: string, cause?: unknown): Error => {
			const error = new Error(message, cause === undefined ? undefined : { cause });
			Object.defineProperty(error, "code", { enumerable: true, value: code });
			return error;
		};
		const wrap = (stream: Stream, peerId: string): SnapshotChunkProtocolStream => {
			let streamClosed = false;
			active.add(stream);
			const abort = (reason = failure("aborted", "snapshot stream was aborted")): void => {
				if (streamClosed) return;
				streamClosed = true;
				active.delete(stream);
				stream.abort(reason);
			};
			const abortIfNeeded = (signal: AbortSignal): void => {
				if (signal.aborted) {
					const error = failure("aborted", "snapshot stream was aborted", signal.reason);
					abort(error);
					throw error;
				}
			};
			return Object.freeze({
				peerId,
				abort,
				close: async (): Promise<void> => {
					if (streamClosed) return;
					streamClosed = true;
					active.delete(stream);
					await stream.close();
				},
				read: async (maxBytes: number, { signal }: Readonly<{ readonly signal: AbortSignal }>): Promise<Uint8Array> => {
					abortIfNeeded(signal);
					if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
						throw failure("protocol-violation", "snapshot frame limit is invalid");
					}
					let rejectAbort!: (error: Error) => void;
					const aborted = new Promise<never>((_resolve, reject) => {
						rejectAbort = reject;
					});
					const onAbort = (): void => {
						const error = failure("aborted", "snapshot stream was aborted", signal.reason);
						abort(error);
						rejectAbort(error);
					};
					signal.addEventListener("abort", onAbort, { once: true });
					try {
						const bytes = await Promise.race([readUint8ArrayFrame(stream, maxBytes), aborted]);
						abortIfNeeded(signal);
						return new Uint8Array(bytes);
					} catch (error) {
						if (signal.aborted) throw failure("aborted", "snapshot stream was aborted", signal.reason);
						abort(failure("protocol-violation", "snapshot frame violates its byte bound", error));
						throw failure("protocol-violation", "snapshot frame violates its byte bound", error);
					} finally {
						signal.removeEventListener("abort", onAbort);
					}
				},
				write: async (
					exactBytes: Uint8Array,
					{ signal }: Readonly<{ readonly signal: AbortSignal }>
				): Promise<void> => {
					abortIfNeeded(signal);
					let bytes: Uint8Array;
					try {
						bytes = new Uint8Array(exactBytes);
					} catch (error) {
						throw failure("protocol-violation", "snapshot frame carrier is invalid", error);
					}
					await writeUint8ArrayFrame(stream, bytes);
					abortIfNeeded(signal);
				},
			});
		};
		return Object.freeze({
			localPeerId: this.peerId,
			close: (): Promise<void> => {
				if (closed) return Promise.resolve();
				closed = true;
				if (incoming !== undefined && this._snapshotChunkIncoming === incoming) {
					this._snapshotChunkIncoming = undefined;
				}
				selectedHandler = undefined;
				for (const stream of [...active]) stream.abort(failure("aborted", "snapshot protocol port closed"));
				active.clear();
				return Promise.resolve();
			},
			connectedPeers: (): readonly string[] => {
				if (closed || this._node === undefined) return [];
				return [
					...new Set(
						this._node
							.getConnections()
							.filter(({ status }) => status === "open")
							.map(({ remotePeer }) => remotePeer.toString())
					),
				].sort();
			},
			open: async (
				peerId: string,
				{ signal }: Readonly<{ readonly signal: AbortSignal }>
			): Promise<SnapshotChunkProtocolStream> => {
				if (closed || this._node === undefined || signal.aborted) {
					throw failure(signal.aborted ? "aborted" : "connection-unavailable", "snapshot connection is unavailable");
				}
				let connection: Connection | undefined;
				try {
					connection = this._node
						.getConnections(peerIdFromString(peerId))
						.filter(({ status }) => status === "open")
						.sort((left, right) => left.id.localeCompare(right.id))[0];
				} catch {
					connection = undefined;
				}
				if (connection === undefined) {
					throw failure("connection-unavailable", "snapshot peer is not already connected");
				}
				try {
					const stream = await connection.newStream(SNAPSHOT_CHUNK_PROTOCOL, { signal });
					return wrap(stream, connection.remotePeer.toString());
				} catch (error) {
					throw failure(signal.aborted ? "aborted" : "connection-unavailable", "snapshot stream open failed", error);
				}
			},
			serve: (handler: (stream: SnapshotChunkProtocolStream) => Promise<void>): (() => void) => {
				if (closed || selectedHandler !== undefined || this._snapshotChunkIncoming !== undefined) {
					throw new TypeError("snapshot protocol server is unavailable");
				}
				selectedHandler = handler;
				incoming = async (stream, connection): Promise<void> => {
					const selected = selectedHandler;
					if (closed || selected === undefined) {
						stream.abort(failure("connection-unavailable", "snapshot protocol server is unavailable"));
						return;
					}
					await selected(wrap(stream, connection.remotePeer.toString()));
				};
				this._snapshotChunkIncoming = incoming;
				return (): void => {
					if (incoming !== undefined && this._snapshotChunkIncoming === incoming) {
						this._snapshotChunkIncoming = undefined;
					}
					selectedHandler = undefined;
				};
			},
		});
	}

	private _activateUnreliableWebRtcOwner(): void {
		this._deactivateUnreliableWebRtcOwner();
		const signaling = createLibp2pWebRtcSignalingPort({
			connections: (): readonly Connection[] => (this._node === undefined ? [] : this._node.getConnections()),
			localPeerId: this.peerId,
			onIncoming: (listener): (() => void) => {
				const selected = (stream: Stream, connection: Connection): Promise<void> => listener({ connection, stream });
				this._unreliableWebRtcIncoming = selected;
				return (): void => {
					if (this._unreliableWebRtcIncoming === selected) this._unreliableWebRtcIncoming = undefined;
				};
			},
			read: (stream, maxBytes): Promise<Uint8Array> => readUint8ArrayFrame(stream, maxBytes),
			write: (stream, bytes): Promise<void> => writeUint8ArrayFrame(stream, bytes),
		});
		this._activeUnreliableWebRtcOwner = createDRPUnreliableWebRtcOwner({
			createPeerConnection: (): RTCPeerConnection => {
				if (typeof RTCPeerConnection === "undefined") throw new Error("RTCPeerConnection is unavailable");
				return new RTCPeerConnection();
			},
			signaling,
		});
	}

	private _deactivateUnreliableWebRtcOwner(): void {
		this._activeUnreliableWebRtcOwner?.close();
		this._activeUnreliableWebRtcOwner = undefined;
		this._unreliableWebRtcIncoming = undefined;
	}

	private _resetUnreliableWebRtcOwner(): void {
		this._deactivateUnreliableWebRtcOwner();
		if (this._node?.status === "started") this._activateUnreliableWebRtcOwner();
	}

	/** @returns Detached exact T1/T3 occupancy and deployment evidence. */
	getPeerSelectionSnapshot(): DRPPeerSelectionSnapshot {
		const controller = this._connectionAdmission;
		if (controller === undefined) throw new Error("peer selection is not attached to a running host");
		const connectionManager = (this._node as unknown as { components?: { connectionManager?: unknown } } | undefined)
			?.components?.connectionManager as { getDialQueue(): readonly unknown[] } | undefined;
		return controller.getSnapshot(
			connectionManager?.getDialQueue().length ?? 0,
			this._expectedReplicas,
			this._globalDiscovery
		);
	}

	/**
	 * Start the node.
	 * @param rawPrivateKey - The raw private key to use.
	 */
	async start(rawPrivateKey?: Uint8Array): Promise<void> {
		if (this._node?.status === "started") throw new Error("Node already started");
		this._validateRelayPolicyConfiguration();
		this._validatePhaseSevenConfiguration();

		let privateKey = undefined;
		if (rawPrivateKey) {
			privateKey = privateKeyFromRaw(rawPrivateKey);
		}

		const bootstrapDiscovery = this._hostPolicy.bootstrapDiscovery ?? true;
		const coldStartPubsubDiscovery = this._hostPolicy.coldStartPubsubDiscovery ?? true;
		const gossipSubPeerExchange = this._hostPolicy.gossipSubPeerExchange ?? true;
		const expectedReplicas = this._config?.control_plane?.peer_selection?.expected_replicas;
		if (expectedReplicas !== undefined && (!Number.isSafeInteger(expectedReplicas) || expectedReplicas < 1)) {
			throw new Error("control_plane.peer_selection.expected_replicas must be a positive safe integer");
		}
		const globalDiscovery = coldStartPubsubDiscovery && expectedReplicas !== undefined && expectedReplicas <= 50;
		this._expectedReplicas = expectedReplicas;
		this._globalDiscovery = globalDiscovery;
		const _peerDiscovery: Array<PeerDiscoveryFunction> = [];
		if (globalDiscovery) {
			_peerDiscovery.push(
				pubsubPeerDiscovery({
					topics: [DRP_DISCOVERY_TOPIC],
					interval: this._config?.pubsub?.peer_discovery_interval || 5000,
				})
			);
		}

		const bootstrapNodes = this.getBootstrapNodes();
		if (bootstrapDiscovery && bootstrapNodes.length) {
			_peerDiscovery.push(
				bootstrap({
					list: bootstrapNodes,
				})
			);
		}

		let _node_services: ServiceFactoryMap = {
			ping: ping(),
			dcutr: dcutr(),
			identify: identify(),
			identifyPush: identifyPush(),
			pubsub: gossipsub(this.getGossipSubConfig(gossipSubPeerExchange, globalDiscovery)),
		};

		if (this._config?.autonat) {
			_node_services = { ..._node_services, autonat: autoNAT() };
		}

		const maxRelayReservations = this._config?.relay_service?.max_reservations ?? Number.POSITIVE_INFINITY;
		if (
			maxRelayReservations !== Number.POSITIVE_INFINITY &&
			(!Number.isSafeInteger(maxRelayReservations) || maxRelayReservations < 0)
		) {
			throw new Error("relay_service.max_reservations must be a non-negative safe integer");
		}
		const connectionBudget = this._resolveConnectionBudget();
		const relayPolicyConfiguration = this._resolveRelayPolicyConfiguration();
		const prioritySlots = relayPolicyConfiguration?.targetReservations ?? 0;
		if (
			prioritySlots >= connectionBudget.maxConnections ||
			prioritySlots > connectionBudget.maxConnections - connectionBudget.maxParallelDials
		) {
			throw new Error("relay priority reservations exceed the effective connection budget");
		}
		const _relayServices = {
			..._node_services,
			relay: circuitRelayServer({
				reservations: {
					maxReservations: maxRelayReservations,
				},
			}),
		};

		const configuredAddressPolicy = this._config?.control_plane?.address_policy;
		const controlPlaneKeys = Object.keys(this._config?.control_plane ?? {}).filter((key) => key !== "peer_selection");
		const addressPolicy =
			configuredAddressPolicy === undefined && controlPlaneKeys.length === 0
				? undefined
				: new AddressPolicy({
						allowInsecureWebSocket: configuredAddressPolicy?.allowInsecureWebSocket,
						allowLoopback: configuredAddressPolicy?.allowLoopback,
						allowPrivate: configuredAddressPolicy?.allowPrivate,
						target: configuredAddressPolicy?.target ?? (isBrowser || isWebWorker ? "browser" : "node"),
					});
		const addressResolver = configuredAddressPolicy?.resolver ?? outboundDnsResolver;
		const addressPolicyGate: DenyDialMultiaddr | undefined =
			addressPolicy === undefined
				? undefined
				: async (address): Promise<boolean> => {
						try {
							const decision = await addressPolicy.evaluate(
								address.toString(),
								addressResolver,
								AbortSignal.timeout(2_000)
							);
							this._emitControlPlaneEvent({
								family: decision.family,
								kind: "address-admission",
								outcome: decision.dialable ? "accepted" : "denied",
								reason: boundedAddressReason(decision),
								scope: decision.scope,
								transport: decision.transports[0] ?? "unknown",
							});
							return !decision.dialable;
						} catch {
							this._emitControlPlaneEvent({
								...sanitizedAddressFields(address),
								kind: "address-admission",
								outcome: "denied",
								reason: "address-policy",
							});
							return true;
						}
					};
		const outboundAddressPolicy =
			this._hostPolicy.denyDialMultiaddr !== undefined
				? "injected"
				: addressPolicyGate !== undefined
					? "address-policy"
					: "allow-all";
		this._outboundAddressPolicy = outboundAddressPolicy;
		const activeAddressPolicyGate = this._hostPolicy.denyDialMultiaddr === undefined ? addressPolicyGate : undefined;
		const connectionAdmission =
			this._connectionAdmission ?? createConnectionAdmissionController(connectionBudget, { prioritySlots });
		const peerSelector = new PeerSelector(connectionAdmission);
		this._connectionAdmission = connectionAdmission;
		this._peerSelector = peerSelector;
		for (const address of this._config?.listen_addresses ?? []) {
			if (!address.includes("/p2p-circuit")) continue;
			try {
				connectionAdmission.addLifecycleTarget(multiaddr(address));
			} catch {
				// libp2p owns the final listen-address validation.
			}
		}
		const wrapFactory =
			<T>(factory: (components: object) => T): ((components: object) => T) =>
			(components): T => {
				const candidate = factory(peerSelector.wrapComponents(components));
				peerSelector.attachDiscovery(candidate);
				return candidate;
			};
		const wrapServices = (services: ServiceFactoryMap): ServiceFactoryMap =>
			Object.fromEntries(
				Object.entries(services).map(([name, factory]) => [
					name,
					wrapFactory(factory as (components: object) => unknown),
				])
			) as ServiceFactoryMap;
		const baseOptions: Libp2pOptions = {
			privateKey,
			addresses: {
				listen: this._config?.listen_addresses ? this._config.listen_addresses : ["/p2p-circuit", "/webrtc"],
				...(this._config?.announce_addresses ? { announce: this._config.announce_addresses } : {}),
			},
			connectionManager: {
				maxConnections: connectionBudget.maxConnections,
				maxDialQueueLength: connectionBudget.maxConnections,
				maxParallelDials: connectionBudget.maxParallelDials,
				dialTimeout: 60_000,
				addressSorter: this._sortAddresses,
			},
			connectionEncrypters: [noise()],
			connectionGater: {
				...connectionAdmission.connectionGater,
				denyDialMultiaddr: this._hostPolicy.denyDialMultiaddr ?? activeAddressPolicyGate ?? ((): false => false),
				...(activeAddressPolicyGate === undefined
					? {}
					: {
							filterMultiaddrForPeer: async (_peer, address): Promise<boolean> =>
								!(await activeAddressPolicyGate(address)),
						}),
			},
			metrics: this._config?.browser_metrics ? inspectorMetrics() : undefined,
			...(activeAddressPolicyGate === undefined ? {} : { dns: outboundDns }),
			peerDiscovery: _peerDiscovery.map((factory) =>
				wrapFactory(factory as (components: object) => PeerDiscovery)
			) as NonNullable<Libp2pOptions["peerDiscovery"]>,
			services: wrapServices(this._config?.relay_service?.enabled === true ? _relayServices : _node_services),
			streamMuxers: [yamux()],
			transports: [circuitRelayTransport(), webRTC(), webSockets()].map((factory) =>
				wrapFactory(factory as (components: object) => ReturnType<typeof factory>)
			) as NonNullable<Libp2pOptions["transports"]>,
		};
		const publicComponents = this._config?.control_plane?.rollout?.public_components;
		const rollout = Object.freeze({
			ownedFallback: Object.freeze({
				configuredRelays: true as const,
				localRouting: true as const,
				ownedRendezvous: true as const,
			}),
			publicComponents: Object.freeze({
				delegatedRouting: publicComponents?.delegated_routing?.enabled === true,
				publicRelayOverflow: publicComponents?.public_relay_overflow?.enabled === true,
				publicRendezvous: publicComponents?.public_rendezvous?.enabled === true,
				pubsubBehaviorRewards: publicComponents?.pubsub_behavior_rewards?.enabled === true,
			}),
		});
		const snapshotWithoutBudget = {
			bootstrapDiscovery,
			bootstrapPeerCount: bootstrapDiscovery ? bootstrapNodes.length : 0,
			coldStartPubsubDiscovery,
			gossipSubPeerExchange,
			outboundAddressPolicy,
			peerDiscoveryModules: Object.freeze([
				...(globalDiscovery ? (["@libp2p/pubsub-peer-discovery"] as const) : []),
				...(bootstrapDiscovery && bootstrapNodes.length ? (["@libp2p/bootstrap"] as const) : []),
			]),
			rollout,
		};
		// Preserve the established enumerable snapshot shape while exposing the
		// immutable budget as direct host-factory evidence and through browser diagnostics.
		const snapshot = Object.freeze(
			Object.defineProperties(snapshotWithoutBudget, {
				connectionBudget: { enumerable: false, value: connectionBudget },
				globalDiscovery: { enumerable: false, value: globalDiscovery },
			})
		) as DRPNetworkHostConfigSnapshot;
		let builtHost: Libp2p | undefined;
		let hostBuild: Promise<Libp2p> | undefined;
		const createHost = async (extensions: DRPNetworkHostExtensions = {}): Promise<Libp2p> => {
			if (hostBuild) throw new Error("DRP network host factory may build only one host per start");
			for (const serviceName of Object.keys(extensions.services ?? {})) {
				if (CORE_SERVICE_NAMES.has(serviceName)) {
					throw new Error(`DRP network host extension cannot replace reserved service "${serviceName}"`);
				}
			}
			const extensionPeerDiscovery = (extensions.peerDiscovery ?? []).map((factory) =>
				wrapFactory(factory as (components: object) => PeerDiscovery)
			) as NonNullable<Libp2pOptions["peerDiscovery"]>;
			const extensionServices = wrapServices(extensions.services ?? {});
			hostBuild = (async (): Promise<Libp2p> => {
				const host = await createLibp2p({
					...baseOptions,
					contentRouters: [
						...(baseOptions.contentRouters ?? []),
						...(extensions.contentRouters ?? []).map((factory) =>
							wrapFactory(factory as (components: object) => unknown)
						),
					] as NonNullable<Libp2pOptions["contentRouters"]>,
					peerDiscovery: [...(baseOptions.peerDiscovery ?? []), ...extensionPeerDiscovery],
					peerRouters: [
						...(baseOptions.peerRouters ?? []),
						...(extensions.peerRouters ?? []).map((factory) => wrapFactory(factory as (components: object) => unknown)),
					] as NonNullable<Libp2pOptions["peerRouters"]>,
					services: { ...baseOptions.services, ...extensionServices },
					start: false,
					transports: [
						...(baseOptions.transports ?? []),
						...(extensions.transports ?? []).map((factory) => wrapFactory(factory as (components: object) => unknown)),
					] as NonNullable<Libp2pOptions["transports"]>,
				});
				builtHost = host;
				const components = (host as unknown as { components: { connectionManager: object; transportManager: object } })
					.components;
				connectionAdmission.wrapConnectionManager(components.connectionManager);
				connectionAdmission.wrapTransportManager(components.transportManager);
				peerSelector.attachHost(host);
				await host.start();
				return host;
			})();
			return hostBuild;
		};
		try {
			const host = await this._hostFactory({ createHost, snapshot });
			if (!builtHost) throw new Error("DRP network host factory must build its host through createHost()");
			if (host !== builtHost) throw new Error("DRP network host factory must return the host built by createHost()");
			connectionAdmission.attach(host);
			this._node = host;
		} catch (error) {
			peerSelector.stop();
			connectionAdmission.stop();
			if (this._connectionAdmission === connectionAdmission) this._connectionAdmission = undefined;
			if (this._peerSelector === peerSelector) this._peerSelector = undefined;
			this._emitControlPlaneEvent({ kind: "listen-readiness", outcome: "failed", transport: "unknown" });
			if (!builtHost && hostBuild) {
				try {
					builtHost = await hostBuild;
				} catch {
					// The original rejection is already carried by error.
				}
			}
			try {
				await builtHost?.stop();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "DRP network host factory failed and cleanup also failed", {
					cause: error,
				});
			}
			throw error;
		}
		log.info(
			"::start: running on:",
			this._node.getMultiaddrs().map((addr) => addr.toString())
		);
		const [listenAddress] = this._node.getMultiaddrs();
		this._emitControlPlaneEvent({
			kind: "listen-readiness",
			outcome: "ready",
			transport: listenAddress === undefined ? "unknown" : sanitizedAddressFields(listenAddress).transport,
		});

		if (!this._config?.seed && bootstrapDiscovery) {
			this._bootstrapRetryController?.abort();
			this._bootstrapRetryController = new AbortController();
			for (const addr of bootstrapNodes) {
				void this._dialBootstrapWithRetry(multiaddr(addr), this._node, this._bootstrapRetryController.signal);
			}
		}

		this._pubsub = this._node.services.pubsub as ConfigurableGossipSub;
		this.peerId = this._node.peerId.toString();
		this._activateUnreliableWebRtcOwner();

		log.info("::start: Successfuly started DRP network w/ peer_id", this.peerId);

		this._node.addEventListener("peer:connect", (event: CustomEvent<PeerId>) => {
			const peerId = event.detail.toString();
			log.info("::start::peer::connect", peerId);
			this.notifyPeerConnection(peerId);
		});
		this._node.addEventListener("peer:disconnect", (event: CustomEvent<PeerId>) => {
			const peerId = event.detail.toString();
			log.info("::start::peer::disconnect", peerId);
			this.notifyPeerDisconnect(peerId);
		});

		this._node.addEventListener("peer:discovery", (e) => log.info("::start::peer::discovery", e.detail));

		this._node.addEventListener("peer:identify", (e) => log.info("::start::peer::identify", e.detail));

		this._pubsub.addEventListener("subscription-change", (event) => {
			for (const subscription of event.detail.subscriptions) {
				this.notifyGroupPeerChange({
					peerId: event.detail.peerId.toString(),
					subscribed: subscription.subscribe,
					topic: subscription.topic,
				});
			}
		});
		this._pubsub.addEventListener("gossipsub:graft", (event) => {
			log.info("::start::gossipsub::graft", event.detail);
			this.notifyGroupPeerChange({
				peerId: event.detail.peerId,
				subscribed: true,
				topic: event.detail.topic,
			});
		});

		// needed as I've disabled the pubsubPeerDiscovery
		if (globalDiscovery) this._pubsub?.subscribe(DRP_DISCOVERY_TOPIC);
		this._pubsub?.subscribe(DRP_INTERVAL_DISCOVERY_TOPIC);

		// start the routing loop to enqueue messages
		void this.startEnqueueMessages();
		this._metrics?.start(`drp-network-${this.peerId}`, 10_000);
		this._messageQueue.start();
		try {
			this._startRelayPolicy();
		} catch (error) {
			this._deactivateUnreliableWebRtcOwner();
			this._bootstrapRetryController?.abort(error);
			this._bootstrapRetryController = undefined;
			this._relayPolicyController?.abort(error);
			this._relayPolicyController = undefined;
			const relayPolicy = this._relayPolicy;
			this._relayPolicy = undefined;
			this._clearRelayMaintenance();
			this._peerSelector?.stop();
			this._peerSelector = undefined;
			this._connectionAdmission?.stop();
			this._connectionAdmission = undefined;
			this._metrics?.stop();
			this._messageQueue.close();
			const host = this._node;
			this._node = undefined;
			this._pubsub = undefined;
			try {
				await relayPolicy?.stop();
				await host?.stop();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "relay policy startup and cleanup failed", {
					cause: error,
				});
			}
			throw error;
		}
	}

	private _startRelayPolicy(): void {
		const relayPolicyConfig = this._config?.control_plane?.relay_policy;
		const resolved = this._resolveRelayPolicyConfiguration();
		if (relayPolicyConfig === undefined || resolved === undefined) return;
		const nodeClosestPeersEnabled = this._nodeClosestPeersEnabled();
		const factory = this._relayPolicyFactory ?? ((options): RelayPolicyDriver => this._createRelayPolicy(options));
		this._relayPolicy = factory({
			onReservationEvent: (event): void => {
				this._emitControlPlaneEvent({
					kind: "relay-reservation",
					outcome: event.outcome,
					relayIdHash: sanitizedRelayIdHash(event.relayId),
				});
			},
			perCandidateDeadlineMs:
				relayPolicyConfig.per_candidate_deadline_ms ?? DEFAULT_RELAY_POLICY_LIMITS.perCandidateDeadlineMs,
			source: resolved.source,
			targetReservations: resolved.targetReservations,
			totalDeadlineMs:
				relayPolicyConfig.total_deadline_ms ??
				(nodeClosestPeersEnabled
					? NODE_CLOSEST_PEERS_RELAY_TOTAL_DEADLINE_MS
					: DEFAULT_RELAY_POLICY_LIMITS.totalDeadlineMs),
			transportProfile: resolved.transportProfile,
		});
		this._relayPolicyController?.abort();
		const controller = new AbortController();
		this._relayPolicyController = controller;
		const policy = this._relayPolicy;
		const host = this._node;
		if (host === undefined) throw new Error("relay policy requires a started libp2p host");
		this._relayDisconnectListener = (event): void => {
			const peerId = event.detail.toString();
			const policyOwnsReservation = this._lastRelayPolicyResult?.reservations.some(
				({ candidate }) => candidate.peerId === peerId
			);
			const hadPriorityReservation = this._reservedRelayPeerIds.delete(peerId);
			if (!hadPriorityReservation && policyOwnsReservation !== true) return;
			this._connectionAdmission?.reconcileRelayReservations(
				[...this._reservedRelayPeerIds].map((activePeerId) => ({
					peerId: activePeerId,
					priorityTicket: this._relayPriorityTickets.get(activePeerId),
				}))
			);
			this._relayPriorityTickets.delete(peerId);
			this._queueRelayMaintenance(async (): Promise<void> => {
				const result = await policy.replace(peerId, "relay-disconnected", controller.signal);
				this._handleRelayPolicyResult(result, policy, controller);
			});
		};
		host.addEventListener("peer:disconnect", this._relayDisconnectListener);
		this._armWarmRelayAcquisition(host, policy, controller);
		this._lastRelayPolicyResult = undefined;
		this._relayPolicyFailed = false;
		this._relayPolicyAcquirePromise = this._runInitialRelayAcquire(policy, controller);
	}

	/** Re-runs relay acquisition after a post-start candidate source becomes ready. */
	async retryRelayPolicyAcquisition(): Promise<void> {
		await this._relayPolicyAcquirePromise;
		if (this._lastRelayPolicyResult?.terminal === "reserved") return;
		const policy = this._relayPolicy;
		const controller = this._relayPolicyController;
		if (policy === undefined || controller === undefined) {
			// Rebuild only after a genuine acquire-failure teardown, and never on a stopped node:
			// stop()/restart() also null these fields (without setting _relayPolicyFailed), and a
			// parked retry must not resurrect the policy on a dead host.
			if (!this._relayPolicyFailed || this._node?.status === IntervalRunnerState.Stopped) return;
			this._startRelayPolicy();
			await this._relayPolicyAcquirePromise;
			return;
		}
		this._relayPolicyAcquirePromise = this._runInitialRelayAcquire(policy, controller);
		await this._relayPolicyAcquirePromise;
	}

	private _armWarmRelayAcquisition(host: Libp2p, policy: RelayPolicyDriver, controller: AbortController): void {
		if (!this._nodeClosestPeersEnabled()) return;
		this._warmRelayRetryAttempts = 0;
		this._warmRelayIdentifyListener = (event): void => {
			// Only re-arm on peers that actually advertise HOP — otherwise a cold start into many
			// non-relay peers would burn the attempt budget before the first relay ever connects.
			if (!event.detail.protocols.includes(CIRCUIT_RELAY_V2_HOP_PROTOCOL)) return;
			if (
				controller.signal.aborted ||
				this._relayPolicy !== policy ||
				this._lastRelayPolicyResult?.terminal === "reserved" ||
				this._node?.status === IntervalRunnerState.Stopped ||
				this._warmRelayRetryAttempts >= WARM_RELAY_RETRY_MAX_ATTEMPTS ||
				this._warmRelayRetryTimer !== undefined
			) {
				return;
			}
			const delayMs = Math.min(
				WARM_RELAY_RETRY_BASE_DELAY_MS * 2 ** this._warmRelayRetryAttempts,
				WARM_RELAY_RETRY_MAX_DELAY_MS
			);
			this._warmRelayRetryTimer = setTimeout((): void => {
				this._warmRelayRetryTimer = undefined;
				if (
					controller.signal.aborted ||
					this._relayPolicy !== policy ||
					this._lastRelayPolicyResult?.terminal === "reserved" ||
					this._node?.status === IntervalRunnerState.Stopped
				) {
					return;
				}
				this._warmRelayRetryAttempts++;
				void this.retryRelayPolicyAcquisition();
			}, delayMs);
			(this._warmRelayRetryTimer as ReturnType<typeof setTimeout> & { unref?(): void }).unref?.();
		};
		host.addEventListener("peer:identify", this._warmRelayIdentifyListener);
	}

	private _nodeClosestPeersEnabled(): boolean {
		const controlPlane = this._config?.control_plane;
		return (
			controlPlane?.relay_policy?.sources?.node_closest_peers?.enabled === true &&
			controlPlane.routing?.node?.enabled === true &&
			controlPlane.routing.node.network === "public" &&
			controlPlane.rollout?.public_components?.delegated_routing?.enabled === true
		);
	}

	private _resolveRelayPolicyConfiguration(): ResolvedRelayPolicyConfiguration | undefined {
		const relayPolicyConfig = this._config?.control_plane?.relay_policy;
		const configuredSources = relayPolicyConfig?.sources;
		if (relayPolicyConfig === undefined || configuredSources === undefined) return undefined;
		const injectedSources = this._relayCandidateSources;
		const publicRelayOverflowEnabled =
			this._config?.control_plane?.rollout?.public_components?.public_relay_overflow?.enabled === true;
		const nodeClosestPeersEnabled = this._nodeClosestPeersEnabled();
		const configuredPublicRelays =
			configuredSources.configured_relays === undefined
				? undefined
				: new ConfiguredPublicRelaySource({ multiaddrs: configuredSources.configured_relays });
		const targetReservations =
			relayPolicyConfig.target_reservations ?? DEFAULT_RELAY_POLICY_LIMITS.requiredReservations;
		const sources = [
			{
				enabled: configuredPublicRelays !== undefined && configuredSources.configured_relays?.length !== 0,
				name: "configured-public-relays",
				priority: "primary" as const,
				source: configuredPublicRelays,
			},
			{
				enabled:
					configuredSources.configured_fallback !== undefined &&
					configuredSources.configured_fallback.enabled !== false &&
					injectedSources?.configuredFallback !== undefined,
				name: "configured-fallback",
				priority: "primary" as const,
				source: injectedSources?.configuredFallback,
			},
			{
				enabled:
					configuredSources.cached_successful_relays?.enabled === true &&
					injectedSources?.cachedSuccessfulRelays !== undefined,
				name: "cached-successful-relays",
				priority: "primary" as const,
				source: injectedSources?.cachedSuccessfulRelays,
			},
			{
				enabled:
					configuredSources.registry_relay_records?.enabled === true &&
					injectedSources?.registryRelayRecords !== undefined,
				name: "registry-relay-records",
				priority: "primary" as const,
				source: injectedSources?.registryRelayRecords,
			},
			{
				enabled:
					publicRelayOverflowEnabled &&
					configuredSources.delegated_closest_peers?.enabled === true &&
					injectedSources?.delegatedClosestPeers !== undefined,
				name: "delegated-closest-peers",
				priority: "overflow" as const,
				source: injectedSources?.delegatedClosestPeers,
			},
			{
				degradedOverflowEligible: true,
				enabled: nodeClosestPeersEnabled && injectedSources?.nodeClosestPeers !== undefined,
				name: "node-overflow",
				priority: "overflow" as const,
				source: injectedSources?.nodeClosestPeers,
			},
			{
				enabled:
					publicRelayOverflowEnabled &&
					configuredSources.dht_relay_providers?.enabled === true &&
					injectedSources?.dhtRelayProviders !== undefined,
				name: "dht-relay-providers",
				priority: "overflow" as const,
				source: injectedSources?.dhtRelayProviders,
			},
		].filter(
			(entry): entry is typeof entry & { readonly source: RelayCandidateSource } =>
				entry.enabled && entry.source !== undefined
		);
		if (sources.length === 0) return undefined;
		return {
			source: new CompositeRelayCandidateSource({ requiredOperatorGroups: targetReservations, sources }),
			targetReservations,
			transportProfile:
				nodeClosestPeersEnabled ||
				(configuredSources.configured_relays !== undefined &&
					configuredSources.configured_relays.length > 0 &&
					!isBrowser &&
					!isWebWorker)
					? RELAY_TRANSPORT_PROFILES.node
					: RELAY_TRANSPORT_PROFILES.broadBrowser,
		};
	}

	private _validateRelayPolicyConfiguration(validateSources = true): void {
		const relayPolicyConfig = this._config?.control_plane?.relay_policy;
		if (relayPolicyConfig === undefined) return;
		const perCandidateDeadlineMs =
			relayPolicyConfig.per_candidate_deadline_ms ?? DEFAULT_RELAY_POLICY_LIMITS.perCandidateDeadlineMs;
		if (
			!Number.isSafeInteger(perCandidateDeadlineMs) ||
			perCandidateDeadlineMs < 1 ||
			perCandidateDeadlineMs > 10_000
		) {
			throw new Error("control_plane.relay_policy.per_candidate_deadline_ms must be an integer within 1..10000");
		}
		const totalDeadlineMs =
			relayPolicyConfig.total_deadline_ms ??
			(this._nodeClosestPeersEnabled()
				? NODE_CLOSEST_PEERS_RELAY_TOTAL_DEADLINE_MS
				: DEFAULT_RELAY_POLICY_LIMITS.totalDeadlineMs);
		if (relayPolicyConfig.total_deadline_ms === undefined && totalDeadlineMs < perCandidateDeadlineMs) {
			throw new Error(
				`control_plane.relay_policy.per_candidate_deadline_ms (${perCandidateDeadlineMs}) exceeds the effective default total deadline (${totalDeadlineMs}); set control_plane.relay_policy.total_deadline_ms to raise the total deadline`
			);
		}
		if (
			!Number.isSafeInteger(totalDeadlineMs) ||
			totalDeadlineMs < perCandidateDeadlineMs ||
			totalDeadlineMs > 120_000
		) {
			throw new Error(
				"control_plane.relay_policy.total_deadline_ms must be an integer greater than or equal to per_candidate_deadline_ms and within 1..120000"
			);
		}
		if (!validateSources) return;
		const configuredSources = relayPolicyConfig?.sources;
		if (configuredSources === undefined) return;
		const targetReservations =
			relayPolicyConfig.target_reservations ?? DEFAULT_RELAY_POLICY_LIMITS.requiredReservations;
		if (!Number.isSafeInteger(targetReservations) || targetReservations < 1 || targetReservations > 8) {
			throw new Error("control_plane.relay_policy.target_reservations must be an integer within 1..8");
		}
		const configuredRelays: unknown = configuredSources.configured_relays;
		if (
			configuredRelays !== undefined &&
			(!Array.isArray(configuredRelays) || configuredRelays.some((address) => typeof address !== "string"))
		) {
			throw new Error("control_plane.relay_policy.sources.configured_relays must be an array of multiaddr strings");
		}
		if (Array.isArray(configuredRelays)) {
			new ConfiguredPublicRelaySource({ multiaddrs: configuredRelays as string[] });
		}
		const injected = this._relayCandidateSources;
		const publicRelayOverflowEnabled =
			this._config?.control_plane?.rollout?.public_components?.public_relay_overflow?.enabled === true;
		const missing: string[] = [];
		if (
			configuredSources.configured_fallback !== undefined &&
			configuredSources.configured_fallback.enabled !== false &&
			injected?.configuredFallback === undefined
		) {
			missing.push("configured_fallback");
		}
		if (
			configuredSources.cached_successful_relays?.enabled === true &&
			injected?.cachedSuccessfulRelays === undefined
		) {
			missing.push("cached_successful_relays");
		}
		if (configuredSources.registry_relay_records?.enabled === true && injected?.registryRelayRecords === undefined) {
			missing.push("registry_relay_records");
		}
		if (
			publicRelayOverflowEnabled &&
			configuredSources.delegated_closest_peers?.enabled === true &&
			injected?.delegatedClosestPeers === undefined
		) {
			missing.push("delegated_closest_peers");
		}
		if (this._nodeClosestPeersEnabled() && injected?.nodeClosestPeers === undefined) {
			missing.push("node_closest_peers");
		}
		if (
			publicRelayOverflowEnabled &&
			configuredSources.dht_relay_providers?.enabled === true &&
			injected?.dhtRelayProviders === undefined
		) {
			missing.push("dht_relay_providers");
		}
		if (missing.length > 0) {
			throw new Error(
				`control_plane.relay_policy enabled sources require injected implementations: ${missing.join(", ")}`
			);
		}
	}

	private _validatePhaseSevenConfiguration(): void {
		const ipColocation = this._config?.control_plane?.pubsub_scoring?.ip_colocation;
		if (ipColocation?.enabled === true) {
			if (!Number.isFinite(ipColocation.weight) || ipColocation.weight > 0) {
				throw new Error("control_plane.pubsub_scoring IP-colocation weight must be finite and no greater than 0");
			}
			if (!Number.isFinite(ipColocation.threshold) || ipColocation.threshold < 1) {
				throw new Error("control_plane.pubsub_scoring IP-colocation threshold must be finite and at least 1");
			}
			const whitelist: unknown = ipColocation.whitelist;
			if (
				whitelist !== undefined &&
				(!Array.isArray(whitelist) || !whitelist.every((address) => typeof address === "string" && address.length > 0))
			) {
				throw new Error("control_plane.pubsub_scoring IP-colocation whitelist must be an array of non-empty strings");
			}
		}

		const observedBehaviorReward = this._config?.control_plane?.pubsub_scoring?.observed_behavior_reward;
		if (
			observedBehaviorReward?.enabled === true &&
			(!Number.isFinite(observedBehaviorReward.max_application_score) ||
				observedBehaviorReward.max_application_score <= 0 ||
				observedBehaviorReward.max_application_score * APP_SPECIFIC_WEIGHT >= ACCEPT_PX_THRESHOLD)
		) {
			throw new Error(
				"control_plane.pubsub_scoring.observed_behavior_reward.max_application_score must be finite, greater than 0, and keep its weighted contribution below the GossipSub accept-PX threshold"
			);
		}

		const ownedFallback = this._config?.control_plane?.rollout?.owned_fallback;
		const ownedFallbackToggles: readonly [string, unknown][] = [
			["configured_relays", ownedFallback?.configured_relays?.enabled],
			["local_routing", ownedFallback?.local_routing?.enabled],
			["owned_rendezvous", ownedFallback?.owned_rendezvous?.enabled],
		];
		for (const [name, enabled] of ownedFallbackToggles) {
			if (enabled !== undefined && enabled !== true) {
				throw new Error(`control_plane.rollout owned fallback ${name} cannot be disabled`);
			}
		}
	}

	private async _runInitialRelayAcquire(policy: RelayPolicyDriver, controller: AbortController): Promise<void> {
		try {
			const result = await policy.acquire(new TextEncoder().encode(this.peerId), controller.signal);
			this._handleRelayPolicyResult(result, policy, controller);
		} catch (error) {
			if (controller.signal.aborted || this._relayPolicy !== policy) return;
			if (!this._relayPolicyFailed) {
				this._emitControlPlaneEvent({
					failure: "acquire-threw",
					kind: "relay-reservation",
					outcome: "failed",
				});
			}
			this._relayPolicyFailed = true;
			controller.abort(error);
			this._clearRelayMaintenance();
			try {
				await policy.stop();
			} catch (cleanupError) {
				log.error("::relay-policy::cleanup:error", new AggregateError([error, cleanupError]));
			} finally {
				if (this._relayPolicy === policy) this._relayPolicy = undefined;
				if (this._relayPolicyController === controller) this._relayPolicyController = undefined;
			}
		}
	}

	private _handleRelayPolicyResult(
		result: RelayPolicyResult,
		policy: RelayPolicyDriver,
		controller: AbortController
	): void {
		if (controller.signal.aborted || this._relayPolicy !== policy) return;
		this._lastRelayPolicyResult = result;
		const previouslyReservedRelayPeerIds = this._reservedRelayPeerIds;
		this._connectionAdmission?.reconcileRelayReservations(
			result.reservations.map(({ candidate }) => ({
				peerId: candidate.peerId,
				priorityTicket: this._relayPriorityTickets.get(candidate.peerId),
			})),
			result.terminal
		);
		this._reservedRelayPeerIds = new Set(
			result.reservations
				.map(({ candidate }) => candidate.peerId)
				.filter((peerId) => this._connectionAdmission?.hasActiveRelayPeer(peerId) === true)
		);
		for (const peerId of this._reservedRelayPeerIds) {
			if (!previouslyReservedRelayPeerIds.has(peerId)) this._pubsub?.score.scoreCache.delete(peerId);
		}
		const policyOwnedPeerIds = new Set(policy.activeReservations?.map(({ candidate }) => candidate.peerId) ?? []);
		for (const peerId of [...this._relayPriorityTickets.keys()]) {
			if (!this._reservedRelayPeerIds.has(peerId) && !policyOwnedPeerIds.has(peerId)) {
				this._relayPriorityTickets.delete(peerId);
			}
		}
		if (result.terminal !== "reserved") {
			if (!this._relayPolicyFailed) {
				this._emitControlPlaneEvent({ kind: "relay-reservation", outcome: "failed" });
			}
			this._relayPolicyFailed = true;
		} else {
			this._relayPolicyFailed = false;
		}
		this._scheduleRelayRefresh(result, policy, controller);
	}

	private _scheduleRelayRefresh(
		result: RelayPolicyResult,
		policy: RelayPolicyDriver,
		controller: AbortController
	): void {
		if (this._relayRefreshTimer !== undefined) clearTimeout(this._relayRefreshTimer);
		this._relayRefreshTimer = undefined;
		const earliestExpiryMs = Math.min(...result.reservations.map(({ expiresAtMs }) => expiresAtMs));
		if (!Number.isFinite(earliestExpiryMs)) return;
		const delayMs = Math.max(0, earliestExpiryMs - Date.now() - DEFAULT_RELAY_POLICY_LIMITS.refreshBeforeExpiryMs);
		this._relayRefreshTimer = setTimeout(() => {
			this._relayRefreshTimer = undefined;
			this._queueRelayMaintenance(async (): Promise<void> => {
				const refreshed = await policy.refresh(controller.signal);
				this._handleRelayPolicyResult(refreshed, policy, controller);
			});
		}, delayMs);
		(this._relayRefreshTimer as ReturnType<typeof setTimeout> & { unref?(): void }).unref?.();
	}

	private _queueRelayMaintenance(operation: () => Promise<void>): void {
		const controller = this._relayPolicyController;
		this._relayMaintenanceTail = this._relayMaintenanceTail
			.then(async (): Promise<void> => {
				if (controller?.signal.aborted !== false) return;
				await operation();
			})
			.catch((error: unknown): void => {
				if (controller?.signal.aborted === true) return;
				if (!this._relayPolicyFailed) {
					this._emitControlPlaneEvent({ kind: "relay-reservation", outcome: "failed" });
				}
				this._relayPolicyFailed = true;
				log.error("::relay-policy::maintenance:error", error);
			});
	}

	private _clearRelayMaintenance(): void {
		if (this._relayRefreshTimer !== undefined) clearTimeout(this._relayRefreshTimer);
		this._relayRefreshTimer = undefined;
		this._connectionAdmission?.reconcileRelayReservations([]);
		this._reservedRelayPeerIds.clear();
		this._relayPriorityTickets.clear();
		const listener = this._relayDisconnectListener;
		if (listener !== undefined) this._node?.removeEventListener("peer:disconnect", listener);
		this._relayDisconnectListener = undefined;
		if (this._warmRelayRetryTimer !== undefined) clearTimeout(this._warmRelayRetryTimer);
		this._warmRelayRetryTimer = undefined;
		const warmRelayListener = this._warmRelayIdentifyListener;
		if (warmRelayListener !== undefined) this._node?.removeEventListener("peer:identify", warmRelayListener);
		this._warmRelayIdentifyListener = undefined;
		this._warmRelayRetryAttempts = 0;
	}

	private _createRelayPolicy(options: RelayPolicyFactoryOptions): RelayPolicyDriver {
		const host = this._node;
		if (host === undefined) throw new Error("relay policy requires a started libp2p host");
		const admission = this._connectionAdmission;
		if (admission === undefined) throw new Error("relay policy requires an attached admission controller");
		const client = new Libp2pRelayClient({
			// Contextual return preserves the legacy Promise<void> or owned-receipt callback boundary.
			// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
			connect: async (address, signal) => {
				const target = multiaddr(address);
				const peerId = this.getPeerId(target);
				if (peerId === undefined) throw new Error("relay candidate address omitted its terminal peer id");
				const existingConnectionIds = new Set(host.getConnections(peerIdFromString(peerId)).map(({ id }) => id));
				const priorityEnabled =
					admission.getSnapshot(0, this._expectedReplicas, this._globalDiscovery).prioritySlots > 0;
				if (!priorityEnabled) {
					const connection = await this.safeDial(target, host, signal);
					if (connection === undefined) throw new Error("relay dial did not return a connection");
					const created = !existingConnectionIds.has(connection.id);
					return {
						close: async (): Promise<void> => {
							if (created) await connection.close();
						},
						connectionId: connection.id,
						created,
					};
				}

				const ticket = admission.createPriorityTicket(target);
				if (ticket === undefined) {
					const error = new Error("relay priority dial denied before queue insertion");
					error.name = "DialDeniedError";
					throw error;
				}
				try {
					const connection = await host.dial(target, ticket.bindOptions(target, { signal }));
					const created = !existingConnectionIds.has(connection.id);
					if (
						!admission.bindPriorityConnection(ticket, peerId, {
							connectionId: connection.id,
							created,
						})
					) {
						if (created) await connection.close().catch(() => undefined);
						const error = new Error("relay priority dial returned an unbound connection receipt");
						error.name = "DialDeniedError";
						throw error;
					}
					const previous = this._relayPriorityTickets.get(peerId);
					if (previous !== undefined && previous !== ticket) previous.release();
					this._relayPriorityTickets.set(peerId, ticket);
					let released = false;
					return {
						close: async (): Promise<void> => {
							if (released) return;
							released = true;
							try {
								if (created) await connection.close();
							} finally {
								ticket.release();
								if (this._relayPriorityTickets.get(peerId) === ticket) {
									this._relayPriorityTickets.delete(peerId);
								}
							}
						},
						connectionId: connection.id,
						created,
					};
				} catch (error) {
					ticket.release();
					throw error;
				}
			},
			disconnect: (): Promise<void> => Promise.resolve(),
			host: host as unknown as Libp2pRelayClientOptions["host"],
		});
		const policy = new RelayPolicy({
			fallback: this._relayFallback,
			inspector: client,
			limits: {
				perCandidateDeadlineMs: options.perCandidateDeadlineMs,
				requiredOperatorGroups: options.targetReservations,
				requiredReservations: options.targetReservations,
				totalDeadlineMs: options.totalDeadlineMs,
			},
			onReservationEvent: options.onReservationEvent,
			operatorGroupClassifier: new EvidenceDerivedOperatorGroupClassifier({
				verify: (): Promise<{ readonly verified: false }> => Promise.resolve({ verified: false }),
			}),
			reservationClient: client,
			source: options.source,
			transportProfile: options.transportProfile ?? RELAY_TRANSPORT_PROFILES.broadBrowser,
		});
		return {
			get activeReservations(): readonly ActiveRelayReservation[] {
				return policy.activeReservations;
			},
			acquire: (queryKey, signal) => policy.acquire(queryKey, signal),
			refresh: (signal) => policy.refresh(signal),
			replace: (peerId, reason, signal, excludedOperatorGroup) =>
				policy.replace(peerId, reason, signal, excludedOperatorGroup),
			stop: async (): Promise<void> => {
				await policy.stop();
				await client.stop();
			},
		};
	}

	private async _dialBootstrapWithRetry(addr: Multiaddr, node: Libp2p, signal: AbortSignal): Promise<void> {
		const retryDelays = [1_000, 2_000, 4_000, 8_000];

		for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
			if (signal.aborted || this._node !== node || node.status === "stopping" || node.status === "stopped") return;

			try {
				await this.safeDial(addr, node, signal);
				return;
			} catch (e) {
				log.error("::start::dial::error", e);
			}

			const retryDelay = retryDelays[attempt];
			if (retryDelay === undefined) return;
			await this._waitForBootstrapRetry(retryDelay, signal);
		}
	}

	private _waitForBootstrapRetry(delay: number, signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.resolve();

		return new Promise((resolve) => {
			const finish = (): void => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = (): void => {
				clearTimeout(timeout);
				finish();
			};
			const timeout = setTimeout(finish, delay);
			(timeout as ReturnType<typeof setTimeout> & { unref?(): void }).unref?.();
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * Stop the node.
	 */
	async stop(): Promise<void> {
		if (this._node?.status === IntervalRunnerState.Stopped) throw new Error("Node not started");
		this._deactivateUnreliableWebRtcOwner();
		this._snapshotChunkIncoming = undefined;
		this._peerSelector?.stop();
		this._peerSelector = undefined;
		this._connectionAdmission?.stop();
		this._connectionAdmission = undefined;
		this._bootstrapRetryController?.abort();
		this._bootstrapRetryController = undefined;
		const relayPolicyController = this._relayPolicyController;
		const relayPolicy = this._relayPolicy;
		relayPolicyController?.abort(new DOMException("network node stopped", "AbortError"));
		this._relayPolicyController = undefined;
		this._relayPolicy = undefined;
		// Clear the failure flag so a warm re-arm parked on the acquire promise cannot resurrect the
		// policy on a stopping host (the rebuild branch of retryRelayPolicyAcquisition gates on it).
		this._relayPolicyFailed = false;
		this._clearRelayMaintenance();
		await relayPolicy?.stop();
		await this._relayMaintenanceTail;
		this._relayMaintenanceTail = Promise.resolve();
		await this._node?.stop();
		this._messageQueue.close();
		this._metrics?.stop();
	}

	/**
	 * Restart the node.
	 * @param config - The configuration to use.
	 * @param rawPrivateKey - The raw private key to use.
	 */
	async restart(config?: DRPNetworkNodeConfig, rawPrivateKey?: Uint8Array): Promise<void> {
		await this.stop();
		if (config) {
			this._config = config;
			this._membershipVerifier = createMembershipVerifier(config.control_plane?.membership);
		}
		await this.start(rawPrivateKey);
	}

	/**
	 * Check if the node is dialable.
	 * @param callback - The callback to call if the node is dialable.
	 * @returns True if the node is dialable, false otherwise.
	 */
	async isDialable(callback?: () => void | Promise<void>): Promise<boolean> {
		let dialable = await this._node?.isDialable(this._node.getMultiaddrs());
		if (!callback) return dialable ?? false;
		if (dialable) {
			await callback();
			return true;
		}

		const checkDialable = async (): Promise<void> => {
			dialable = await this._node?.isDialable(this._node.getMultiaddrs());
			if (dialable) {
				await callback();
			}
		};

		this._node?.addEventListener("transport:listening", () => void checkDialable());
		return false;
	}

	private _sortAddresses(a: Address, b: Address): 0 | 1 | -1 {
		const localRegex =
			/(^\/ip4\/127\.)|(^\/ip4\/10\.)|(^\/ip4\/172\.1[6-9]\.)|(^\/ip4\/172\.2[0-9]\.)|(^\/ip4\/172\.3[0-1]\.)|(^\/ip4\/192\.168\.)/;
		const aLocal = localRegex.test(a.toString());
		const bLocal = localRegex.test(b.toString());
		const aWebrtc = WebRTC.matches(a.multiaddr);
		const bWebrtc = WebRTC.matches(b.multiaddr);
		if (aLocal && !bLocal) return 1;
		if (!aLocal && bLocal) return -1;
		if (aWebrtc && !bWebrtc) return -1;
		if (!aWebrtc && bWebrtc) return 1;
		return 0;
	}

	private _resolveConnectionBudget(): DRPConnectionBudget {
		return resolveConnectionBudget({
			...(this._config?.connection_budget === undefined ? {} : { configured: this._config.connection_budget }),
			relayServiceEnabled: this._config?.relay_service?.enabled === true,
			runtime: isBrowser ? "browser" : isWebWorker ? "worker" : "node",
		});
	}

	private getPeerId(addr: Multiaddr): string | undefined {
		return addr.getComponents().find((component) => component.name === "p2p")?.value;
	}

	private getGossipSubConfig(doPX = true, globalDiscovery = false): Partial<GossipsubOpts> {
		const baseConfig: Partial<GossipsubOpts> = {
			doPX,
			fallbackToFloodsub: false,
			globalSignaturePolicy: StrictSign,
			allowPublishToZeroTopicPeers: true,
			scoreParams: this.getGossipSubPeerScoreParams(globalDiscovery),
		};

		if (this._config?.seed) {
			baseConfig.D = 0;
			baseConfig.Dlo = 0;
			baseConfig.Dhi = 0;
			baseConfig.Dout = 0;
		}

		if (this._config?.pubsub?.prometheus_metrics) {
			const pushgatewayUrl = this._config?.pubsub?.pushgateway_url ?? "http://localhost:9091";
			this._metrics = createMetricsRegister(pushgatewayUrl);
			baseConfig.metricsRegister = this._metrics;
			baseConfig.metricsTopicStrToLabel = new Map();
		}

		return baseConfig;
	}

	private getGossipSubPeerScoreParams(globalDiscovery = false): PeerScoreParams {
		const ipColocation = this._config?.control_plane?.pubsub_scoring?.ip_colocation;
		const ipColocationParams: Partial<PeerScoreParams> =
			ipColocation?.enabled === true
				? {
						IPColocationFactorThreshold: ipColocation.threshold,
						IPColocationFactorWeight: ipColocation.weight,
						IPColocationFactorWhitelist: new Set(ipColocation.whitelist ?? []),
					}
				: { IPColocationFactorWeight: 0 };
		const observedBehaviorReward = this._config?.control_plane?.pubsub_scoring?.observed_behavior_reward;
		const publicComponents = this._config?.control_plane?.rollout?.public_components;
		const behaviorProvider = this._authenticatedPeerBehaviorProvider;
		const rewardEnabled =
			observedBehaviorReward?.enabled === true && publicComponents?.pubsub_behavior_rewards?.enabled === true;
		let providerFailureLogged = false;
		const neutralProviderFailure = (error: unknown): 0 => {
			if (!providerFailureLogged) {
				providerFailureLogged = true;
				log.warn("::gossipsub::observed-peer-behavior:error", error);
			}
			return 0;
		};
		const appSpecificScore = (peerId: string): number => {
			const relayScore =
				this._connectionAdmission?.hasActiveRelayPeer(peerId) === true
					? observedBehaviorReward?.enabled === true
						? Math.min(0.5, observedBehaviorReward.max_application_score)
						: 0.5
					: 0;
			let behaviorScore = 0;
			if (rewardEnabled && behaviorProvider !== undefined && observedBehaviorReward !== undefined) {
				try {
					const observation = behaviorProvider.getObservedPeerBehavior(peerId);
					if (observation?.authenticated === true) {
						if (
							typeof observation.diversityScore !== "number" ||
							typeof observation.validBehaviorScore !== "number" ||
							!Number.isFinite(observation.diversityScore) ||
							!Number.isFinite(observation.validBehaviorScore)
						) {
							behaviorScore = neutralProviderFailure(
								new Error("observed peer behavior provider returned an invalid score")
							);
						} else {
							const observedScore =
								Math.max(0, observation.diversityScore) + Math.max(0, observation.validBehaviorScore);
							behaviorScore = Math.min(observedScore, observedBehaviorReward.max_application_score);
						}
					}
				} catch (error) {
					behaviorScore = neutralProviderFailure(error);
				}
			}
			return Math.max(relayScore, behaviorScore);
		};

		if (this._config?.seed) {
			return createPeerScoreParams({
				...ipColocationParams,
				appSpecificScore,
				appSpecificWeight: APP_SPECIFIC_WEIGHT,
				topicScoreCap: 50,
			});
		}

		return createPeerScoreParams({
			...ipColocationParams,
			appSpecificScore,
			appSpecificWeight: APP_SPECIFIC_WEIGHT,
			...(globalDiscovery ? { topics: { [DRP_DISCOVERY_TOPIC]: createTopicScoreParams({ topicWeight: 1 }) } } : {}),
		});
	}

	/**
	 * Change the topic score params.
	 * @param topic - The topic to change the score params for.
	 * @param params - The new score params.
	 */
	changeTopicScoreParams(topic: string, params: TopicScoreParams): void {
		if (!this._pubsub) return;
		this._pubsub.score.params.topics[topic] = params;
	}

	/**
	 * Remove a topic score params.
	 * @param topic - The topic to remove the score params from.
	 */
	removeTopicScoreParams(topic: string): void {
		if (!this._pubsub) return;
		delete this._pubsub.score.params.topics[topic];
	}

	/**
	 * Subscribe to a topic.
	 * @param topic - The topic to subscribe to.
	 */
	subscribe(topic: string): void {
		if (!this._node) {
			log.error("::subscribe: Node not initialized, please run .start()");
			return;
		}

		try {
			this._pubsub?.subscribe(topic);
			log.info("::subscribe: Successfuly subscribed the topic", topic);
		} catch (e) {
			log.error("::subscribe:", e);
		}
	}

	/**
	 * Unsubscribe from a topic.
	 * @param topic - The topic to unsubscribe from.
	 */
	unsubscribe(topic: string): void {
		if (!this._node) {
			log.error("::unsubscribe: Node not initialized, please run .start()");
			return;
		}

		try {
			this._pubsub?.unsubscribe(topic);
			log.info("::unsubscribe: Successfuly unsubscribed the topic", topic);
		} catch (e) {
			log.error("::unsubscribe:", e);
		}
	}

	private dialCandidates(addresses: string[] | Multiaddr[]): Multiaddr[][] {
		const identified = new Map<string, Multiaddr[]>();
		const unidentified: Multiaddr[][] = [];
		for (const address of addresses) {
			const ma = typeof address === "string" ? multiaddr(address) : address;
			const peerId = this.getPeerId(ma);
			if (peerId === undefined) {
				unidentified.push([ma]);
				continue;
			}
			identified.set(peerId, [...(identified.get(peerId) ?? []), ma]);
		}
		return [...identified.values(), ...unidentified];
	}

	private _emitControlPlaneEvent(event: ControlPlaneEvent): void {
		const sink = this._config?.control_plane?.observability?.sink;
		if (sink === undefined) return;
		try {
			sink(event);
		} catch {
			// Telemetry is best-effort and must never affect network behavior.
		}
	}

	private _firstDialAddress(peer: string[] | string | PeerId | Multiaddr | Multiaddr[]): Multiaddr | undefined {
		const candidate = Array.isArray(peer) ? peer[0] : peer;
		if (typeof candidate !== "string") {
			return candidate !== undefined && "getComponents" in candidate ? candidate : undefined;
		}
		if (!candidate.includes("/")) return undefined;
		try {
			return multiaddr(candidate);
		} catch {
			return undefined;
		}
	}

	private _emitDialOutcome(address: Multiaddr | undefined, outcome: "denied" | "failed" | "ok"): void {
		if (this._config?.control_plane?.observability?.sink === undefined) return;
		this._emitControlPlaneEvent({
			...(address === undefined
				? ({ family: "unknown", scope: "unknown", transport: "unknown" } as const)
				: sanitizedAddressFields(address)),
			kind: "dial-attempt",
			outcome,
			reason:
				outcome === "ok"
					? "connected"
					: outcome === "denied" && this._outboundAddressPolicy === "injected"
						? "injected-policy"
						: outcome === "denied"
							? "address-policy"
							: "dial-failed",
		});
	}

	/**
	 * Dial a peer with a peerId, multiaddr or array of multiaddrs it also handles the case where the caller
	 * do something bad like passing multiaddrs that as different PeerIds
	 * @param peerId - The peerId, multiaddr or array of multiaddrs to dial
	 * @param node - The libp2p instance to dial with
	 * @param signal
	 * @returns The connection or undefined if no connection was made
	 */
	async safeDial(
		peerId: string[] | string | PeerId | Multiaddr | Multiaddr[],
		node: Libp2p | undefined = this._node,
		signal?: AbortSignal
	): Promise<Connection | undefined> {
		if (Array.isArray(peerId) && peerId.length === 0) return undefined;
		const connectionAdmission =
			this._connectionAdmission ?? createConnectionAdmissionController(this._resolveConnectionBudget());
		this._connectionAdmission = connectionAdmission;
		const ticket = connectionAdmission.createExplicitTicket(peerId);
		if (ticket === undefined) {
			const error = new Error("explicit dial denied before queue insertion");
			error.name = "DialDeniedError";
			this._emitDialOutcome(this._firstDialAddress(peerId), "denied");
			throw error;
		}
		const eventAddress = this._firstDialAddress(peerId);
		try {
			const isArray = Array.isArray(peerId);
			let connection: Connection | undefined;
			if (!isArray) {
				const addr =
					typeof peerId === "string" ? (peerId.includes("/") ? multiaddr(peerId) : peerIdFromString(peerId)) : peerId;
				const targetPeerId =
					typeof addr === "object" && "getComponents" in addr
						? addr
								.getComponents()
								.filter(({ name }) => name === "p2p")
								.at(-1)?.value
						: undefined;
				const force =
					targetPeerId !== undefined &&
					node
						?.getConnections(peerIdFromString(targetPeerId))
						.some(({ remoteAddr }) => !remoteAddr.equals(addr as Multiaddr));
				connection = await node?.dial(
					addr,
					ticket.bindOptions(addr, { ...(force === true ? { force: true } : {}), signal })
				);
			} else {
				const candidates = this.dialCandidates(peerId);
				connection = await Promise.any(
					candidates.map((addresses) => node?.dial(addresses, ticket.bindOptions(addresses, { signal })))
				);
			}
			this._emitDialOutcome(eventAddress, connection === undefined ? "failed" : "ok");
			return connection;
		} catch (error) {
			this._emitDialOutcome(
				eventAddress,
				error instanceof Error && error.name === "DialDeniedError" ? "denied" : "failed"
			);
			throw error;
		} finally {
			ticket.release();
		}
	}

	/**
	 * Connect to the bootstrap nodes.
	 */
	async connectToBootstraps(): Promise<void> {
		await this.redialBootstraps(new AbortController().signal);
	}

	/** @param signal - Recovery ownership signal. @returns Whether bootstrap redial connected. */
	async redialBootstraps(signal: AbortSignal): Promise<boolean> {
		try {
			const connection = await this.safeDial(this.getBootstrapNodes(), this._node, signal);
			log.debug("::connectToBootstraps: Successfully connected to bootstrap nodes");
			return connection !== undefined;
		} catch (e) {
			log.error("::connectToBootstraps:", e);
			return false;
		}
	}

	/** @returns Sanitized current libp2p connection evidence. */
	getControlPlaneConnections(): readonly {
		readonly multiaddr: string;
		readonly peerId: string;
		readonly transport: ControlPlaneTransport;
	}[] {
		return (
			this._node?.getConnections().map((connection) => {
				const multiaddrValue = connection.remoteAddr.toString();
				return {
					multiaddr: multiaddrValue,
					peerId: connection.remotePeer.toString(),
					transport: sanitizedAddressFields(connection.remoteAddr).transport,
				};
			}) ?? []
		);
	}

	/** @returns Defensive snapshots owned by the active relay policy. */
	getActiveRelayReservations(): readonly {
		readonly expiresAtMs: number;
		readonly operatorGroup: string;
		readonly peerId: string;
	}[] {
		return (
			this._relayPolicy?.activeReservations?.map(({ candidate, expiresAtMs }) => ({
				expiresAtMs,
				operatorGroup: candidate.operatorGroup,
				peerId: candidate.peerId,
			})) ?? []
		);
	}

	/**
	 * Delegates replacement/acquisition to the relay-policy owner.
	 * @param request
	 * @param request.excludedOperatorGroup
	 * @param request.relayId
	 * @param signal
	 */
	async replaceRelay(
		request: { readonly excludedOperatorGroup?: string; readonly relayId?: string },
		signal: AbortSignal
	): Promise<boolean> {
		const policy = this._relayPolicy;
		if (policy === undefined) return false;
		const result =
			request.relayId === undefined
				? await policy.acquire(new TextEncoder().encode(this.peerId), signal)
				: await policy.replace(request.relayId, "relay-disconnected", signal, request.excludedOperatorGroup);
		const controller = this._relayPolicyController;
		if (controller !== undefined) this._handleRelayPolicyResult(result, policy, controller);
		return result.terminal === "reserved" || result.terminal === "owned-fallback";
	}

	/** @param signal - Recovery ownership signal. @returns Whether an attached routing owner refreshed. */
	async refreshRouting(signal: AbortSignal): Promise<boolean> {
		const services = this._node?.services as Record<string, unknown> | undefined;
		const routing = services?.aminoDHT;
		if (
			typeof routing !== "object" ||
			routing === null ||
			!("refreshRoutingTable" in routing) ||
			typeof routing.refreshRoutingTable !== "function"
		) {
			return false;
		}
		await routing.refreshRoutingTable({ signal });
		return true;
	}

	/**
	 * Connect to a peer.
	 * @param addr - The multiaddr to connect to.
	 */
	async connect(addr: MultiaddrInput | MultiaddrInput[]): Promise<void> {
		try {
			const isComponentArray =
				Array.isArray(addr) &&
				addr.length > 0 &&
				addr.every((value) => typeof value === "object" && value !== null && "code" in value && "name" in value);
			const multiaddrs =
				Array.isArray(addr) && !isComponentArray
					? (addr as MultiaddrInput[]).map((value) => multiaddr(value))
					: [multiaddr(addr as MultiaddrInput)];
			const groups = this._peerSelector?.admitRemoteRoutes(multiaddrs) ?? [];
			await Promise.all(
				groups.map(async (group): Promise<void> => {
					try {
						await this._node?.dial(group.addresses.length === 1 ? group.addresses[0] : [...group.addresses]);
					} catch (error) {
						log.error("::connect:group:", error);
					}
				})
			);
			log.debug("::connect: Successfully dialed", addr);
		} catch (e) {
			log.error("::connect:", e);
		}
	}

	/**
	 * Disconnect from a peer.
	 * @param peerId - The peer ID to disconnect from.
	 */
	async disconnect(peerId: string): Promise<void> {
		try {
			await this._node?.hangUp(multiaddr(`/p2p/${peerId}`));
			log.debug("::disconnect: Successfully disconnected", peerId);
		} catch (e) {
			log.error("::disconnect:", e);
		}
	}

	/**
	 * Get the multiaddrs of a peer.
	 * @param peerId - The peer ID to get the multiaddrs from.
	 * @returns The multiaddrs of the peer.
	 */
	async getPeerMultiaddrs(peerId: PeerId | string): Promise<Address[]> {
		const peerIdObj: PeerId = typeof peerId === "string" ? peerIdFromString(peerId) : peerId;

		const peer = await this._node?.peerStore.get(peerIdObj);
		if (!peer) return [];
		return peer.addresses;
	}

	/**
	 * Get the bootstrap nodes.
	 * @returns The bootstrap nodes.
	 */
	getBootstrapNodes(): string[] {
		return this._config?.bootstrap_peers ?? BOOTSTRAP_NODES;
	}

	/**
	 * Get the subscribed topics.
	 * @returns The subscribed topics.
	 */
	getSubscribedTopics(): string[] {
		return this._pubsub?.getTopics() ?? [];
	}

	/**
	 * Get the multiaddrs of the node.
	 * @returns The multiaddrs of the node.
	 */
	getMultiaddrs(): string[] {
		return this._node?.getMultiaddrs().map((addr) => addr.toString()) ?? [];
	}

	/**
	 * Get all peers.
	 * @returns The peers.
	 */
	getAllPeers(): string[] {
		const peers = this._node?.getPeers();
		if (!peers) return [];
		return peers.map((peer) => peer.toString());
	}

	/**
	 * Get the peers in a group.
	 * @param group - The group to get the peers from.
	 * @param view - Optional bounded GossipSub mesh view.
	 * @returns The peers in the group.
	 */
	getGroupPeers(group: string, view?: "mesh"): string[] {
		if (view === "mesh") {
			if (this._config?.seed === true) return [];
			return [...(this._pubsub?.mesh.get(group) ?? [])];
		}
		if (view !== undefined) throw new Error("unsupported group peer view");
		const peers = this._pubsub?.getSubscribers(group);
		if (!peers) return [];
		return peers.map((peer) => peer.toString());
	}

	/**
	 * Broadcast a message to a topic.
	 * @param topic - The topic to broadcast the message to.
	 * @param message - The message to broadcast.
	 */
	async broadcastMessage(topic: string, message: Message): Promise<void> {
		try {
			await this.waitForPeersAndPublish(topic, message);
			log.debug("::broadcastMessage: Successfuly broadcasted message to topic", topic);
		} catch (e) {
			log.error("::broadcastMessage:", e);
		}
	}

	private async waitForPeersAndPublish(topic: string, message: Message): Promise<void> {
		const messageBuffer = Message.encode(message).finish();
		const pubsub = this._pubsub;
		if (pubsub === undefined) throw new Error("Pubsub is unavailable");
		await this.waitForSubscriber(topic);
		if (this._pubsub !== pubsub) throw new Error("Pubsub changed during publication readiness");
		await pubsub.publish(topic, messageBuffer);
		if (this._pubsub !== pubsub) throw new Error("Pubsub changed during publication");
	}

	/**
	 * Publish one exact message and surface readiness or transport failure.
	 * @param topic - Authenticated topic selected by the private live-plane owner.
	 * @param message - Exact message to encode and publish.
	 * @returns Literal truth after the publication completes.
	 */
	async publishMessage(topic: string, message: Message): Promise<true> {
		await this.waitForPeersAndPublish(topic, message);
		return true;
	}

	/**
	 * Read the authenticated gossip topic bound to one decoded message identity.
	 * @param message - Exact decoded message delivered by signed gossip ingress.
	 * @returns Its authenticated topic, or undefined outside signed gossip ingress.
	 */
	gossipTopicFor(message: Message): string | undefined {
		const transport = this._ingressEvidence.get(message)?.transport;
		return transport?.kind === "signed-gossip" ? transport.topic : undefined;
	}

	/**
	 * Atomically consume exact authenticated transport evidence for one decoded message.
	 * @param message - Exact decoded message identity delivered by this node.
	 * @returns A detached authenticated snapshot, or undefined after mutation/replay.
	 */
	claimIngressEvidence(message: Message): IngressEvidence | undefined {
		const evidence = this._ingressEvidence.get(message);
		this._ingressEvidence.delete(message);
		if (evidence === undefined) return undefined;
		const snapshot = evidence.message;
		return snapshot.sender === message.sender &&
			snapshot.type === message.type &&
			snapshot.objectId === message.objectId &&
			sameIngressBytes(snapshot.data, message.data)
			? evidence
			: undefined;
	}

	private recordIngressEvidence(message: Message, transport: IngressTransport): void {
		if (!isClaimableIngress(message)) return;
		this._ingressEvidence.set(
			message,
			Object.freeze({
				message: Object.freeze({
					data: message.data.slice(),
					objectId: message.objectId,
					sender: message.sender,
					type: message.type,
				}),
				transport: Object.freeze(transport),
			})
		);
	}

	private async waitForSubscriber(topic: string, timeout = 1000): Promise<void> {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const isReady = this._pubsub
				?.getSubscribers(topic)
				.some((peerId) => this._pubsub?.streamsOutbound.has(peerId.toString()));
			if (isReady) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	/**
	 * Send a message to a peer.
	 * @param peerId - The peer ID to send the message to.
	 * @param message - The message to send.
	 */
	async sendMessage(peerId: string, message: Message, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
		let stream: Stream | undefined;
		const abort = (): void => {
			if (stream === undefined) return;
			stream.abort(
				options.signal?.reason instanceof Error ? options.signal.reason : new Error("direct message send aborted")
			);
		};
		try {
			options.signal?.throwIfAborted();
			const connection = await this.safeDial([multiaddr(`/p2p/${peerId}`)]);
			options.signal?.throwIfAborted();
			stream = <Stream>await connection?.newStream(DRP_MESSAGE_PROTOCOL, { signal: options.signal });
			options.signal?.addEventListener("abort", abort, { once: true });
			options.signal?.throwIfAborted();
			const messageBuffer = Message.encode(message).finish();
			await uint8ArrayToStream(stream, messageBuffer);
		} catch (e) {
			log.error("::sendMessage:", e);
			if (options.signal !== undefined) throw e;
		} finally {
			options.signal?.removeEventListener("abort", abort);
		}
	}

	/**
	 * Open one negotiated sync stream, then build the payload for the protocol
	 * selected by that exact stream. Additive completion means remote bounded
	 * queue admission; fallback retains local write completion.
	 */
	async sendSyncMessage(
		peerId: string,
		payloadFactory: (selection: SelectedSyncProtocol) => Message | Promise<Message>,
		options: { readonly signal?: AbortSignal } = {}
	): Promise<void> {
		return this.submitNegotiatedSync(peerId, payloadFactory, MessageType.MESSAGE_TYPE_SYNC, options);
	}

	/** Send one bounded sync response over a freshly selected sync stream. */
	async sendSyncResponseMessage(
		peerId: string,
		message: Message,
		options: { readonly signal?: AbortSignal } = {}
	): Promise<void> {
		if (
			message.type !== MessageType.MESSAGE_TYPE_SYNC_ACCEPT &&
			message.type !== MessageType.MESSAGE_TYPE_SYNC_REJECT
		) {
			throw new SyncTransportError("SYNC_PROTOCOL_VIOLATION", "Sync response sender requires SyncAccept or SyncReject");
		}
		return this.submitNegotiatedSync(peerId, () => message, message.type, options);
	}

	private async submitNegotiatedSync(
		peerId: string,
		payloadFactory: (selection: SelectedSyncProtocol) => Message | Promise<Message>,
		expectedType:
			| MessageType.MESSAGE_TYPE_SYNC
			| MessageType.MESSAGE_TYPE_SYNC_ACCEPT
			| MessageType.MESSAGE_TYPE_SYNC_REJECT,
		options: { readonly signal?: AbortSignal }
	): Promise<void> {
		const deadlineSignal = AbortSignal.timeout(10_000);
		const signal = options.signal === undefined ? deadlineSignal : AbortSignal.any([options.signal, deadlineSignal]);
		let connection: Connection | undefined;
		try {
			connection = await this.safeDial([multiaddr(`/p2p/${peerId}`)], this._node, signal);
		} catch (cause) {
			throw this.syncFailure(signal, deadlineSignal, "SYNC_DIAL_FAILED", "Could not dial sync peer", cause);
		}
		if (connection === undefined) throw new SyncTransportError("SYNC_DIAL_FAILED", "Could not dial sync peer");
		let admission = this._syncAdmissions.get(connection);
		if (admission === undefined) {
			admission = new SyncSendAdmission(connection);
			this._syncAdmissions.set(connection, admission);
		}
		return admission.submit(() =>
			this.sendSelectedSync(connection, payloadFactory, expectedType, signal, deadlineSignal)
		);
	}

	private async sendSelectedSync(
		connection: Connection,
		payloadFactory: (selection: SelectedSyncProtocol) => Message | Promise<Message>,
		expectedType:
			| MessageType.MESSAGE_TYPE_SYNC
			| MessageType.MESSAGE_TYPE_SYNC_ACCEPT
			| MessageType.MESSAGE_TYPE_SYNC_REJECT,
		signal: AbortSignal,
		deadlineSignal: AbortSignal
	): Promise<void> {
		if (connection.status !== "open") {
			throw new SyncTransportError("SYNC_CONNECTION_CLOSED", "Sync connection is closed");
		}
		let stream: Stream;
		try {
			stream = await connection.newStream([...DRP_SYNC_PROTOCOLS], {
				maxOutboundStreams: 3,
				signal,
			});
		} catch (cause) {
			throw this.syncFailure(
				signal,
				deadlineSignal,
				"SYNC_PROTOCOL_SELECTION_FAILED",
				"Could not select a sync protocol",
				cause
			);
		}

		try {
			const selection = selectedSyncProtocol(stream.protocol);
			const message = await payloadFactory(selection);
			if (message.type !== expectedType) {
				throw new SyncTransportError("SYNC_PROTOCOL_VIOLATION", "Sync sender factory returned the wrong message type");
			}
			const messageBuffer = Message.encode(message).finish();
			validateNegotiatedSync(message, stream.protocol, messageBuffer.byteLength);
			await uint8ArrayToStream(stream, messageBuffer);
			if (selection.mode === "heads-chunk") {
				await this.waitForRemoteSyncAdmission(stream, signal, deadlineSignal);
			}
		} catch (error) {
			if (stream.status === "open" || stream.status === "closing") {
				stream.abort(error instanceof Error ? error : new Error(String(error)));
			}
			if (error instanceof SyncTransportError) throw error;
			throw this.syncFailure(signal, deadlineSignal, "SYNC_WRITE_FAILED", "Sync stream failed", error);
		}
	}

	private waitForRemoteSyncAdmission(stream: Stream, signal: AbortSignal, deadlineSignal: AbortSignal): Promise<void> {
		if (signal.aborted) {
			return Promise.reject(this.syncFailure(signal, deadlineSignal, "SYNC_SEND_ABORTED", "Sync send aborted"));
		}
		if (stream.status === "closed") return Promise.resolve();
		if (stream.status === "reset" || stream.status === "aborted") {
			return Promise.reject(new SyncTransportError("SYNC_STREAM_RESET", "Remote sync stream reset"));
		}
		return new Promise<void>((resolve, reject) => {
			const onAbort = (): void => {
				cleanup();
				reject(this.syncFailure(signal, deadlineSignal, "SYNC_SEND_ABORTED", "Sync send aborted"));
			};
			const onClose = (): void => {
				cleanup();
				if (stream.status === "closed") resolve();
				else reject(new SyncTransportError("SYNC_STREAM_RESET", "Remote sync stream reset"));
			};
			const cleanup = (): void => {
				signal.removeEventListener("abort", onAbort);
				stream.removeEventListener("close", onClose);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			stream.addEventListener("close", onClose, { once: true });
		});
	}

	private syncFailure(
		signal: AbortSignal,
		deadlineSignal: AbortSignal,
		code: string,
		message: string,
		cause?: unknown
	): SyncTransportError {
		if (deadlineSignal.aborted) return new SyncTransportError("SYNC_SEND_DEADLINE", "Sync send deadline exceeded");
		if (signal.aborted) return new SyncTransportError("SYNC_SEND_ABORTED", "Sync send aborted");
		return new SyncTransportError(code, message, cause === undefined ? undefined : { cause });
	}

	/**
	 * Send a message to a random peer in a group.
	 * @param group - The group to send the message to.
	 * @param message - The message to send.
	 */
	async sendGroupMessageRandomPeer(group: string, message: Message): Promise<void> {
		try {
			const peers = this.getGroupPeers(group, "mesh");
			if (peers.length === 0) return;
			const peerId = peers[Math.floor(Math.random() * peers.length)];

			const connection = await this.safeDial(peerId);
			const stream: Stream = (await connection?.newStream(DRP_MESSAGE_PROTOCOL)) as Stream;
			const messageBuffer = Message.encode(message).finish();
			await uint8ArrayToStream(stream, messageBuffer);
		} catch (e) {
			log.error("::sendGroupMessageRandomPeer:", e);
		}
	}

	/**
	 * Subscribe to remote group-peer subscription and mesh changes.
	 * @param handler - Handler invoked when a remote peer appears or disappears on a topic
	 * @returns A function that removes the handler
	 */
	subscribeToGroupPeerChanges(handler: GroupPeerChangeHandler): () => void {
		this._groupPeerChangeHandlers.add(handler);
		return () => this._groupPeerChangeHandlers.delete(handler);
	}

	/**
	 * Subscribe to genuine remote transport disconnections.
	 * @param handler - Handler invoked with the disconnected peer ID
	 * @returns A function that removes the handler
	 */
	subscribeToPeerDisconnects(handler: PeerDisconnectHandler): () => void {
		this._peerDisconnectHandlers.add(handler);
		return () => this._peerDisconnectHandlers.delete(handler);
	}

	/**
	 * Subscribe to genuine remote transport connections.
	 * @param handler - Handler invoked with the connected peer ID
	 * @returns A function that removes the handler
	 */
	subscribeToPeerConnections(handler: PeerConnectionHandler): () => void {
		this._peerConnectionHandlers.add(handler);
		return () => this._peerConnectionHandlers.delete(handler);
	}

	private notifyGroupPeerChange(change: GroupPeerChange): void {
		for (const handler of this._groupPeerChangeHandlers) handler(change);
	}

	private notifyPeerDisconnect(peerId: string): void {
		for (const handler of this._peerDisconnectHandlers) handler(peerId);
	}

	private notifyPeerConnection(peerId: string): void {
		for (const handler of this._peerConnectionHandlers) handler(peerId);
	}

	private async startEnqueueMessages(): Promise<void> {
		this._pubsub?.addEventListener("gossipsub:message", (e) => {
			if (e.detail.msg.topic === DRP_DISCOVERY_TOPIC) return;
			if (e.detail.msg.type !== "signed") {
				log.error("::startEnqueueMessages::handleGossipsubMessage: unsigned message on StrictSign ingress");
				return;
			}
			void this.handleSignedGossipsubMessage(e.detail.msg);
		});
		await this._node?.handle(
			SNAPSHOT_CHUNK_PROTOCOL,
			async (stream, connection): Promise<void> => {
				const listener = this._snapshotChunkIncoming;
				if (listener === undefined) {
					stream.abort(new Error("snapshot protocol owner is unavailable"));
					return;
				}
				await listener(stream, connection);
			},
			{ maxInboundStreams: 4, maxOutboundStreams: 4 }
		);
		await this._node?.handle(
			DRP_UNRELIABLE_WEBRTC_SIGNALING_PROTOCOL,
			async (stream, connection): Promise<void> => {
				const listener = this._unreliableWebRtcIncoming;
				if (listener === undefined) {
					stream.abort(new Error("unreliable WebRTC signaling owner is unavailable"));
					return;
				}
				await listener(stream, connection);
			},
			{ maxInboundStreams: 1, maxOutboundStreams: 1 }
		);
		await this._node?.handle(
			[...DRP_SYNC_PROTOCOLS],
			(stream, connection) => this.handleStream(stream, connection.remotePeer.toString()),
			{ maxInboundStreams: 3, maxOutboundStreams: 3 }
		);
	}

	private async handleSignedGossipsubMessage(message: SignedMessage): Promise<void> {
		try {
			if (!peerIdFromPublicKey(message.key).equals(message.from)) return;
			if (!(await validateToRawMessage(message))) return;
			this.handleGossipsubMessage(message.data, message.from.toString(), message.topic);
		} catch {
			// Strict signed ingress fails closed.
		}
	}

	private decodeAttributedMessage(data: Uint8Array, authenticatedSender: string): Message {
		const message = Message.decode(data);
		message.sender = authenticatedSender;
		return message;
	}

	private handleGossipsubMessage(data: Uint8Array, authenticatedSender: string, topic: string): void {
		try {
			const message = this.decodeAttributedMessage(data, authenticatedSender);
			if (isSyncProtocolMessage(message)) return;
			const gossipTopic = topic;
			this.recordIngressEvidence(message, { kind: "signed-gossip", sender: authenticatedSender, topic: gossipTopic });
			const messageQueueCallback = this._messageQueue.enqueue(message);
			messageQueueCallback.catch((e) => {
				log.error("::startEnqueueMessages::enqueue:", e);
			});
		} catch (e) {
			log.error(`::startEnqueueMessages::handleGossipsubMessage: msg.length=${data.length} error=${e}`);
		}
	}

	private async handleStream(stream: Stream, authenticatedSender: string): Promise<void> {
		try {
			const data = await streamToUint8Array(stream);
			const message = this.decodeAttributedMessage(data, authenticatedSender);
			const selection = selectedSyncProtocol(stream.protocol);
			if (selection.mode === "heads-chunk" && !isSyncProtocolMessage(message)) {
				throw new SyncTransportError(
					"SYNC_PROTOCOL_VIOLATION",
					"The heads-chunk protocol only accepts sync-family messages"
				);
			}
			if (isSyncProtocolMessage(message)) {
				validateNegotiatedSync(message, stream.protocol, data.byteLength);
				const ingress = createDirectSyncIngress(message, authenticatedSender, selection.protocol);
				await this._messageQueue.enqueue(ingress);
				if (ingress.mode === "heads-chunk") await ingress.completion.wait();
			} else {
				validateNegotiatedSync(message, stream.protocol, data.byteLength);
				this.recordIngressEvidence(message, {
					kind: "authenticated-stream",
					protocol: stream.protocol,
					sender: authenticatedSender,
				});
				await this._messageQueue.enqueue(message);
			}
			await stream.close();
		} catch (e) {
			if (stream.status === "open" || stream.status === "closing") {
				stream.abort(e instanceof Error ? e : new Error(String(e)));
			}
			log.error("::startEnqueueMessages::handleStream", e);
		}
	}

	/**
	 * Subscribe to the message queue.
	 * @param handler - The handler to subscribe to the message queue.
	 */
	subscribeToMessageQueue(handler: IMessageQueueHandler<Message>): void {
		this._messageQueue.subscribe((ingress) => {
			try {
				const result = handler(ingress as Message);
				if (isDirectSyncIngress(ingress) && !ingress.completion.isClaimed()) {
					ingress.completion.claim(result);
				}
				return result;
			} catch (error) {
				if (isDirectSyncIngress(ingress) && !ingress.completion.isClaimed()) {
					ingress.completion.claim(Promise.reject(error));
				}
				throw error;
			}
		});
	}
}
