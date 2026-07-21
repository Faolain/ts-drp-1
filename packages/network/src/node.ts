import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { inspectorMetrics } from "@ipshipyard/libp2p-inspector-metrics";
import { autoNAT } from "@libp2p/autonat";
import { bootstrap, type BootstrapComponents } from "@libp2p/bootstrap";
import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { dcutr } from "@libp2p/dcutr";
import { type GossipSub, gossipsub, type GossipsubOpts } from "@libp2p/gossipsub";
import {
	createPeerScoreParams,
	createTopicScoreParams,
	type PeerScore,
	type PeerScoreParams,
	type TopicScoreParams,
} from "@libp2p/gossipsub/score";
import { identify, identifyPush } from "@libp2p/identify";
import { type Address, type Connection, type PeerDiscovery, type PeerId, type Stream } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { ping } from "@libp2p/ping";
import { pubsubPeerDiscovery, type PubSubPeerDiscoveryComponents } from "@libp2p/pubsub-peer-discovery";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { dns, RecordType } from "@multiformats/dns";
import { type Multiaddr, multiaddr, type MultiaddrInput } from "@multiformats/multiaddr";
import { WebRTC } from "@multiformats/multiaddr-matcher";
import { Logger } from "@ts-drp/logger";
import { AllowlistVerifier, InviteVerifier, type MembershipVerifier } from "@ts-drp/membership";
import { MessageQueue } from "@ts-drp/message-queue";
import { type AddressDecision, AddressPolicy, classifyIpAddressScope, type Resolver } from "@ts-drp/rendezvous";
import {
	type ControlPlaneAddressFamily,
	type ControlPlaneAddressReason,
	type ControlPlaneAddressScope,
	type ControlPlaneEvent,
	type ControlPlaneMembershipConfig,
	type ControlPlaneTransport,
	DRP_DISCOVERY_TOPIC,
	DRP_INTERVAL_DISCOVERY_TOPIC,
	type DRPNetworkNodeConfig,
	type DRPNetworkNode as DRPNetworkNodeInterface,
	type GroupPeerChange,
	type GroupPeerChangeHandler,
	type IMessageQueueHandler,
	IntervalRunnerState,
	Message,
} from "@ts-drp/types";
import { createLibp2p, type Libp2p, type Libp2pOptions, type ServiceFactoryMap } from "libp2p";
import { isBrowser, isWebWorker } from "wherearewe";

import { createMetricsRegister, type PrometheusMetricsRegister } from "./metrics/prometheus.js";
import { streamToUint8Array, uint8ArrayToStream } from "./stream.js";

export * from "./stream.js";
export type { GroupPeerChange, GroupPeerChangeHandler } from "@ts-drp/types";

export const DRP_MESSAGE_PROTOCOL = "/drp/message/0.0.1";
export const BOOTSTRAP_NODES = [
	"/dns4/bootstrap1.topology.gg/tcp/443/wss/p2p/16Uiu2HAm4MeUv712cWmXpvGEZ1r1741YoWvsCcmptCza43b7opdK",
	"/dns4/bootstrap2.topology.gg/tcp/443/wss/p2p/16Uiu2HAmGjAVQyzgTCumpB9TuojKT4LZTBC5HRiZyuwGG9VHodLC",
];
let log: Logger;

type PeerDiscoveryFunction =
	| ((components: PubSubPeerDiscoveryComponents) => PeerDiscovery)
	| ((components: BootstrapComponents) => PeerDiscovery);

type ConfigurableGossipSub = GossipSub & {
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
	readonly gossipSubPeerExchange: boolean;
	readonly outboundAddressPolicy: "address-policy" | "allow-all" | "injected";
	readonly peerDiscoveryModules: readonly ("@libp2p/bootstrap" | "@libp2p/pubsub-peer-discovery")[];
}

export interface DRPNetworkNodeDependencies {
	hostFactory?: DRPNetworkHostFactory;
	hostPolicy?: DRPNetworkHostPolicy;
}

const CORE_SERVICE_NAMES = new Set(["ping", "dcutr", "identify", "identifyPush", "pubsub", "autonat", "relay"]);

const defaultHostFactory: DRPNetworkHostFactory = (context) => context.createHost();

/**
 * The `@multiformats/dns` package uses the operating system's dns/promises resolver in Node. Its browser bundle uses
 * DNS-over-HTTPS resolvers for Cloudflare and Google, shuffled before lookup, which discloses queried hostnames to
 * those providers. The address gate sets cached:false below to enforce the frozen dial-time DNS recheck rule. This
 * same gate is also reached through libp2p's peerStore addressFilter, so stored candidates receive the same check.
 */
const outboundDns = dns();
const outboundDnsResolver: Resolver = {
	async resolve(hostname, signal, family): Promise<string[]> {
		const types =
			family === "ipv4" ? [RecordType.A] : family === "ipv6" ? [RecordType.AAAA] : [RecordType.A, RecordType.AAAA];
		const results = await Promise.allSettled(
			types.map(async (recordType) => {
				const response = await outboundDns.query(hostname, {
					cached: false,
					signal,
					types: [recordType],
				});
				return response.Answer.filter(({ type }) => isAddressRecordType(type, recordType)).map(({ data }) => data);
			})
		);
		const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failures.length === results.length) {
			throw new AggregateError(
				failures.map(({ reason }) => reason),
				`DNS address lookup failed for ${hostname}`
			);
		}
		return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
	},
};

function isAddressRecordType(type: unknown, requestedType: RecordType): boolean {
	return requestedType === RecordType.A
		? type === RecordType.A || type === "A"
		: type === RecordType.AAAA || type === "AAAA";
}

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

/**
 * The DRPNetworkNode class is the main class for the DRP network.
 * It handles the creation and management of the libp2p node, pubsub, and message queue.
 */
export class DRPNetworkNode implements DRPNetworkNodeInterface {
	private _config?: DRPNetworkNodeConfig;
	private _node?: Libp2p;
	private _pubsub?: ConfigurableGossipSub;
	private _messageQueue: MessageQueue<Message>;
	private _metrics?: PrometheusMetricsRegister;
	private _bootstrapRetryController?: AbortController;
	private _groupPeerChangeHandlers = new Set<GroupPeerChangeHandler>();
	private readonly _hostFactory: DRPNetworkHostFactory;
	private readonly _hostPolicy: DRPNetworkHostPolicy;
	private _membershipVerifier?: MembershipVerifier;
	private _outboundAddressPolicy: DRPNetworkHostConfigSnapshot["outboundAddressPolicy"] = "allow-all";

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
		this._hostFactory = dependencies.hostFactory ?? defaultHostFactory;
		this._hostPolicy = dependencies.hostPolicy ?? {};
		this._membershipVerifier = createMembershipVerifier(config?.control_plane?.membership);
		log = new Logger("drp::network", config?.log_config);
		this._messageQueue = new MessageQueue<Message>({ id: "network", logConfig: config?.log_config });
	}

	/**
	 * Verifier selected by the configured control-plane membership owner. This seam is constructed and exposed but is
	 * not yet enforced on any connection path; enforcement arrives with rendezvous integration.
	 * @returns The configured verifier, or undefined when membership is not configured.
	 */
	get membershipVerifier(): MembershipVerifier | undefined {
		return this._membershipVerifier;
	}

	/**
	 * Start the node.
	 * @param rawPrivateKey - The raw private key to use.
	 */
	async start(rawPrivateKey?: Uint8Array): Promise<void> {
		if (this._node?.status === "started") throw new Error("Node already started");

		let privateKey = undefined;
		if (rawPrivateKey) {
			privateKey = privateKeyFromRaw(rawPrivateKey);
		}

		const bootstrapDiscovery = this._hostPolicy.bootstrapDiscovery ?? true;
		const coldStartPubsubDiscovery = this._hostPolicy.coldStartPubsubDiscovery ?? true;
		const gossipSubPeerExchange = this._hostPolicy.gossipSubPeerExchange ?? true;
		const _peerDiscovery: Array<PeerDiscoveryFunction> = [];
		if (coldStartPubsubDiscovery) {
			_peerDiscovery.push(
				pubsubPeerDiscovery({
					topics: [DRP_DISCOVERY_TOPIC],
					interval: this._config?.pubsub?.peer_discovery_interval || 5000,
				})
			);
		}

		const bootstrapNodes = this.getBootstrapNodes();
		const _bootstrapPeerID: string[] = [];
		if (bootstrapDiscovery && bootstrapNodes.length) {
			_peerDiscovery.push(
				bootstrap({
					list: bootstrapNodes,
				})
			);
			for (const addr of bootstrapNodes) {
				const peerId = this.getPeerId(multiaddr(addr));
				if (!peerId) continue;
				_bootstrapPeerID.push(peerId);
			}
		}

		let _node_services: ServiceFactoryMap = {
			ping: ping(),
			dcutr: dcutr(),
			identify: identify(),
			identifyPush: identifyPush(),
			pubsub: gossipsub(this.getGossipSubConfig(_bootstrapPeerID, gossipSubPeerExchange)),
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
		const _relayServices = {
			..._node_services,
			relay: circuitRelayServer({
				reservations: {
					maxReservations: maxRelayReservations,
				},
			}),
		};

		const configuredAddressPolicy = this._config?.control_plane?.address_policy;
		const addressPolicy =
			this._config?.control_plane === undefined
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
		const baseOptions: Libp2pOptions = {
			privateKey,
			addresses: {
				listen: this._config?.listen_addresses ? this._config.listen_addresses : ["/p2p-circuit", "/webrtc"],
				...(this._config?.announce_addresses ? { announce: this._config.announce_addresses } : {}),
			},
			connectionManager: {
				dialTimeout: 60_000,
				addressSorter: this._sortAddresses,
			},
			connectionEncrypters: [noise()],
			connectionGater: {
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
			peerDiscovery: _peerDiscovery,
			services: this._config?.relay_service?.enabled === true ? _relayServices : _node_services,
			streamMuxers: [yamux()],
			transports: [circuitRelayTransport(), webRTC(), webSockets()],
		};
		const snapshot: DRPNetworkHostConfigSnapshot = Object.freeze({
			bootstrapDiscovery,
			bootstrapPeerCount: bootstrapDiscovery ? bootstrapNodes.length : 0,
			coldStartPubsubDiscovery,
			gossipSubPeerExchange,
			outboundAddressPolicy,
			peerDiscoveryModules: Object.freeze([
				...(coldStartPubsubDiscovery ? (["@libp2p/pubsub-peer-discovery"] as const) : []),
				...(bootstrapDiscovery && bootstrapNodes.length ? (["@libp2p/bootstrap"] as const) : []),
			]),
		});
		let builtHost: Libp2p | undefined;
		let hostBuild: Promise<Libp2p> | undefined;
		const createHost = async (extensions: DRPNetworkHostExtensions = {}): Promise<Libp2p> => {
			if (hostBuild) throw new Error("DRP network host factory may build only one host per start");
			for (const serviceName of Object.keys(extensions.services ?? {})) {
				if (CORE_SERVICE_NAMES.has(serviceName)) {
					throw new Error(`DRP network host extension cannot replace reserved service "${serviceName}"`);
				}
			}
			hostBuild = createLibp2p({
				...baseOptions,
				contentRouters: [...(baseOptions.contentRouters ?? []), ...(extensions.contentRouters ?? [])],
				peerDiscovery: [...(baseOptions.peerDiscovery ?? []), ...(extensions.peerDiscovery ?? [])],
				peerRouters: [...(baseOptions.peerRouters ?? []), ...(extensions.peerRouters ?? [])],
				services: { ...baseOptions.services, ...extensions.services },
				transports: [...(baseOptions.transports ?? []), ...(extensions.transports ?? [])],
			});
			builtHost = await hostBuild;
			return builtHost;
		};
		try {
			const host = await this._hostFactory({ createHost, snapshot });
			if (!builtHost) throw new Error("DRP network host factory must build its host through createHost()");
			if (host !== builtHost) throw new Error("DRP network host factory must return the host built by createHost()");
			this._node = host;
		} catch (error) {
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

		log.info("::start: Successfuly started DRP network w/ peer_id", this.peerId);

		this._node.addEventListener("peer:connect", (e) => log.info("::start::peer::connect", e.detail));

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
		this._pubsub?.subscribe(DRP_DISCOVERY_TOPIC);
		this._pubsub?.subscribe(DRP_INTERVAL_DISCOVERY_TOPIC);

		// start the routing loop to enqueue messages
		void this.startEnqueueMessages();
		this._metrics?.start(`drp-network-${this.peerId}`, 10_000);
		this._messageQueue.start();
	}

	private async _dialBootstrapWithRetry(addr: Multiaddr, node: Libp2p, signal: AbortSignal): Promise<void> {
		const retryDelays = [1_000, 2_000, 4_000, 8_000];

		for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
			if (signal.aborted || this._node !== node || node.status === "stopping" || node.status === "stopped") return;

			try {
				await this.safeDial(addr, node);
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
		this._bootstrapRetryController?.abort();
		this._bootstrapRetryController = undefined;
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

	private getPeerId(addr: Multiaddr): string | undefined {
		return addr.getComponents().find((component) => component.name === "p2p")?.value;
	}

	private getGossipSubConfig(bootstapNodeList: string[], doPX = true): Partial<GossipsubOpts> {
		const baseConfig: Partial<GossipsubOpts> = {
			doPX,
			fallbackToFloodsub: false,
			allowPublishToZeroTopicPeers: true,
			scoreParams: this.getGossipSubPeerScoreParams(bootstapNodeList),
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

	private getGossipSubPeerScoreParams(bootstapNodeList: string[]): PeerScoreParams {
		if (this._config?.seed) {
			return createPeerScoreParams({ topicScoreCap: 50, IPColocationFactorWeight: 0 });
		}

		return createPeerScoreParams({
			IPColocationFactorWeight: 0,
			appSpecificScore: (peerId: string) => {
				if (bootstapNodeList.some((node) => node.includes(peerId))) return 1000;

				return 0;
			},
			topics: { [DRP_DISCOVERY_TOPIC]: createTopicScoreParams({ topicWeight: 1 }) },
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

	private addrsPerPeerId(peerIds: string[] | Multiaddr[]): Record<string, Multiaddr[]> {
		const addrs: Record<string, Multiaddr[]> = {};
		for (const peerId of peerIds) {
			const ma: Multiaddr = typeof peerId === "string" ? multiaddr(peerId) : peerId;
			const currentPeerId = this.getPeerId(ma);
			if (!currentPeerId) continue;
			addrs[currentPeerId] = [...(addrs[currentPeerId] ?? []), ma];
		}
		return addrs;
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
	 * @returns The connection or undefined if no connection was made
	 */
	async safeDial(
		peerId: string[] | string | PeerId | Multiaddr | Multiaddr[],
		node: Libp2p | undefined = this._node
	): Promise<Connection | undefined> {
		const eventAddress = this._firstDialAddress(peerId);
		try {
			const isArray = Array.isArray(peerId);
			let connection: Connection | undefined;
			if (!isArray) {
				const addr =
					typeof peerId === "string" ? (peerId.includes("/") ? multiaddr(peerId) : peerIdFromString(peerId)) : peerId;
				connection = await node?.dial(addr);
			} else {
				const addrsPerPeerId = this.addrsPerPeerId(peerId);
				connection = await Promise.race(Object.values(addrsPerPeerId).map((addrs) => node?.dial(addrs)));
			}
			this._emitDialOutcome(eventAddress, connection === undefined ? "failed" : "ok");
			return connection;
		} catch (error) {
			this._emitDialOutcome(
				eventAddress,
				error instanceof Error && error.name === "DialDeniedError" ? "denied" : "failed"
			);
			throw error;
		}
	}

	/**
	 * Connect to the bootstrap nodes.
	 */
	async connectToBootstraps(): Promise<void> {
		try {
			await this.safeDial(this.getBootstrapNodes());
			log.debug("::connectToBootstraps: Successfully connected to bootstrap nodes");
		} catch (e) {
			log.error("::connectToBootstraps:", e);
		}
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
			await this.safeDial(multiaddrs);
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
	 * @returns The peers in the group.
	 */
	getGroupPeers(group: string): string[] {
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
			const messageBuffer = Message.encode(message).finish();
			await this.waitForSubscriber(topic);
			await this._pubsub?.publish(topic, messageBuffer);

			log.debug("::broadcastMessage: Successfuly broadcasted message to topic", topic);
		} catch (e) {
			log.error("::broadcastMessage:", e);
		}
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
	async sendMessage(peerId: string, message: Message): Promise<void> {
		try {
			const connection = await this.safeDial([multiaddr(`/p2p/${peerId}`)]);
			const stream = <Stream>await connection?.newStream(DRP_MESSAGE_PROTOCOL);
			const messageBuffer = Message.encode(message).finish();
			await uint8ArrayToStream(stream, messageBuffer);
		} catch (e) {
			log.error("::sendMessage:", e);
		}
	}

	/**
	 * Send a message to a random peer in a group.
	 * @param group - The group to send the message to.
	 * @param message - The message to send.
	 */
	async sendGroupMessageRandomPeer(group: string, message: Message): Promise<void> {
		try {
			const peers = this._pubsub?.getSubscribers(group);
			if (!peers || peers.length === 0) throw Error("Topic wo/ peers");
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

	private notifyGroupPeerChange(change: GroupPeerChange): void {
		for (const handler of this._groupPeerChangeHandlers) handler(change);
	}

	private async startEnqueueMessages(): Promise<void> {
		this._pubsub?.addEventListener("gossipsub:message", (e) => {
			if (e.detail.msg.topic === DRP_DISCOVERY_TOPIC) return;
			this.handleGossipsubMessage(e.detail.msg.data);
		});
		await this._node?.handle(DRP_MESSAGE_PROTOCOL, (stream) => this.handleStream(stream));
	}

	private handleGossipsubMessage(data: Uint8Array): void {
		try {
			const message = Message.decode(data);
			this._messageQueue.enqueue(message).catch((e) => {
				log.error("::startEnqueueMessages::enqueue:", e);
			});
		} catch (e) {
			log.error(`::startEnqueueMessages::handleGossipsubMessage: msg.length=${data.length} error=${e}`);
		}
	}

	private async handleStream(stream: Stream): Promise<void> {
		try {
			const data = await streamToUint8Array(stream);
			const message = Message.decode(data);
			this._messageQueue.enqueue(message).catch((e) => {
				log.error("::startEnqueueMessages::enqueue:", e);
			});
		} catch (e) {
			log.error("::startEnqueueMessages::handleStream", e);
		}
	}

	/**
	 * Subscribe to the message queue.
	 * @param handler - The handler to subscribe to the message queue.
	 */
	subscribeToMessageQueue(handler: IMessageQueueHandler<Message>): void {
		this._messageQueue.subscribe(handler);
	}
}
