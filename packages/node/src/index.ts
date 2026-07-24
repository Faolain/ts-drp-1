import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { TypedEventEmitter } from "@libp2p/interface";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, hexToBytes } from "@noble/hashes/utils";
import {
	ControlPlaneCoordinator,
	ControlPlaneHealthAggregator,
	type ControlPlaneHealthSnapshot,
	type ControlPlaneMechanismPorts,
	type ControlPlanePhaseSixEvent,
	type ControlPlaneRecoveryConfig,
	type ControlPlaneScheduler,
	SystemControlPlaneScheduler,
} from "@ts-drp/control-plane";
import { createDRPDiscovery } from "@ts-drp/interval-discovery";
import { createDRPReconnectBootstrap } from "@ts-drp/interval-reconnect";
import { IntervalRunner } from "@ts-drp/interval-runner";
import { Keychain } from "@ts-drp/keychain";
import { Logger } from "@ts-drp/logger";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { DRPNetworkNode as DefaultDRPNetworkNode } from "@ts-drp/network";
import { createPermissionlessACL, creatorFromObjectID, DRPObject, HashGraph } from "@ts-drp/object";
import {
	AddressPolicy,
	createCompositeRendezvousDirectory,
	createDnsResolver,
	createHttpRegistryEndpoint,
	createNostrRelayDirectory,
	createNostrSignerFromSecretKey,
	createNostrWebSocketRelayFactory,
	createPeerCache,
	createRecordProducer,
	createRendezvousEnsemble,
	decodeInvite,
	DEFAULT_RECORD_LIMITS,
	type DrpCapability,
	InMemoryPeerCacheStore,
	InMemorySequenceStore,
	InviteDirectory,
	isValidRendezvousNamespace,
	LocalStoragePeerCacheStore,
	NostrRecordValidationError,
	type NostrRelayConnectionFactory,
	type NostrSigner,
	PEER_NAMESPACE_PREFIX,
	type PeerCache,
	type PeerCacheStore,
	type RecordRejectionCode,
	RecordSigner,
	RecordValidator,
	type RegistryAttempt,
	RegistryClient,
	RegistryExhaustedError,
	type RendezvousBootstrapSelection,
	type RendezvousDirectory,
	type RendezvousEnsemble,
	roomNamespace,
} from "@ts-drp/rendezvous";
import { type BrowserRouting, type BrowserRoutingEndpoint, createBrowserRouting } from "@ts-drp/routing-browser";
import {
	type ControlPlaneEvent,
	type ControlPlanePeerCacheConfig,
	type ControlPlaneRendezvousConfig,
	DRPDiscoveryResponse,
	type DRPNetworkNode,
	type DRPNodeConfig,
	type DRPObjectSubscribeCallback,
	type FetchStateResponseEvent,
	type GroupPeerChange,
	type IDRP,
	type IDRPIntervalReconnectBootstrap,
	type IDRPNode,
	type IDRPObject,
	type IntervalRunnerMap,
	Message,
	MessageType,
	type NodeConnectObjectOptions,
	type NodeCreateObjectOptions,
	NodeEventName,
	type NodeEvents,
} from "@ts-drp/types";
import { NodeConnectObjectOptionsSchema, NodeCreateObjectOptionsSchema } from "@ts-drp/validation";
import { DRPValidationError } from "@ts-drp/validation/errors";
import { AbortError, raceEvent } from "race-event";

import { clearSyncRecoveryEpisodes, drpObjectChangesHandler, handleMessage } from "./handlers.js";
import { createDRPIntervalSync, DRPIntervalSync, hasRemoteSyncHistory } from "./interval-sync.js";
import { log } from "./logger.js";
import * as operations from "./operations.js";
import { DRPObjectStore } from "./store/index.js";

interface NodePeerCacheModule {
	createFsPeerCacheStore(path: string): Promise<PeerCacheStore>;
}

const DISCOVERY_MESSAGE_TYPES = [
	MessageType.MESSAGE_TYPE_DRP_DISCOVERY,
	MessageType.MESSAGE_TYPE_DRP_DISCOVERY_RESPONSE,
];

const DISCOVERY_QUEUE_ID = "discovery";
const NOSTR_SECRET_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const NOSTR_TRANSPORT_KEY_DOMAIN = new TextEncoder().encode("ts-drp-nostr-transport-v1");
const RENDEZVOUS_REGISTRATION_REASON_MAX_LENGTH = 160;
const DEFAULT_ROOM_PRESENCE_MAX_ROOMS = 7;
const MAX_ROOM_PRESENCE_ROOMS = 32;
const MAX_ROOM_RENDEZVOUS_DIALS = 8;
const objectIntervalKey = (type: "discovery" | "sync", id: string): string => `interval:${type}::${id}`;

function configuredRoomPresenceMaxRooms(config: ControlPlaneRendezvousConfig): number | undefined {
	const roomPresence = config.room_presence;
	if (roomPresence === undefined || !roomPresence.enabled) return undefined;
	const maxRooms = roomPresence.max_rooms ?? DEFAULT_ROOM_PRESENCE_MAX_ROOMS;
	if (!Number.isSafeInteger(maxRooms) || maxRooms < 1 || maxRooms > MAX_ROOM_PRESENCE_ROOMS) {
		throw new Error(`rendezvous room_presence.max_rooms must be an integer within 1..${MAX_ROOM_PRESENCE_ROOMS}`);
	}
	return maxRooms;
}

function sanitizedRendezvousRegistrationReason(attempts: readonly RegistryAttempt[]): string | undefined {
	const rejectionCodes = new Set<string>();
	for (const attempt of attempts) {
		if (attempt.status === "accepted") continue;
		const code = sanitizedRegistryRejectionCode(attempt.code);
		if (code !== undefined) rejectionCodes.add(code);
	}
	if (rejectionCodes.size === 0) return undefined;
	return `rejected: ${[...rejectionCodes].join(", ")}`.slice(0, RENDEZVOUS_REGISTRATION_REASON_MAX_LENGTH);
}

function sanitizedRendezvousRegistrationFailureReason(
	error: unknown,
	lifecycleSignal: AbortSignal,
	timeoutSignal: AbortSignal
): string {
	if (error instanceof NostrRecordValidationError) {
		const code = sanitizedNostrRecordValidationCode(error.code);
		if (code !== undefined) {
			return `validation: ${code}`.slice(0, RENDEZVOUS_REGISTRATION_REASON_MAX_LENGTH);
		}
	}
	const reason = lifecycleSignal.aborted
		? "aborted"
		: timeoutSignal.aborted || isAbortLikeError(error)
			? "timeout"
			: "error";
	return reason.slice(0, RENDEZVOUS_REGISTRATION_REASON_MAX_LENGTH);
}

function isAbortLikeError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("name" in error)) return false;
	return error.name === "AbortError" || error.name === "TimeoutError";
}

function sanitizedNostrRecordValidationCode(code: RecordRejectionCode): RecordRejectionCode | undefined {
	switch (code) {
		case "admission-rejected":
		case "admission-required":
		case "expired":
		case "invalid-address":
		case "invalid-namespace":
		case "invalid-peer-id":
		case "invalid-public-key":
		case "invalid-sequence":
		case "invalid-shape":
		case "invalid-signature":
		case "invalid-time":
		case "issued-in-future":
		case "namespace-mismatch":
		case "non-canonical":
		case "oversized":
		case "peer-id-mismatch":
		case "replay-capacity-exceeded":
		case "replayed-sequence":
		case "response-cap-exceeded":
		case "ttl-out-of-range":
		case "too-many-addresses":
		case "too-many-capabilities":
		case "unsafe-address":
		case "unsupported-capability":
		case "unsupported-version":
			return code;
		default:
			return dropUnexpectedValidationCode(code);
	}
}

function dropUnexpectedValidationCode(_code: never): undefined {
	return undefined;
}

function sanitizedRegistryRejectionCode(code: RegistryAttempt["code"]): string | undefined {
	switch (code) {
		case "admission-rejected":
		case "client-capacity-exceeded":
		case "endpoint-unavailable":
		case "invalid-client":
		case "namespace-capacity-exceeded":
		case "proof-challenge-capacity":
		case "proof-challenge-expired":
		case "proof-challenge-invalid":
		case "proof-challenge-replayed":
		case "quota-exceeded":
		case "rate-limited":
		case "record-rejected":
		case "response-cap-exceeded":
			return code;
		default:
			return undefined;
	}
}

/** Dependencies and resolved policy for config-driven rendezvous directories. */
export interface CreateConfiguredRendezvousRegistriesParams {
	readonly clientId: string;
	readonly nostrConnectionFactory?: NostrRelayConnectionFactory;
	now?(): number;
	readonly publicRendezvousEnabled: boolean;
	/** Resolved HTTP endpoints, including invite-provided endpoints when applicable. */
	readonly registryEndpoints?: readonly string[];
	readonly rendezvousConfig: ControlPlaneRendezvousConfig;
	readonly secp256k1PrivateKey: Uint8Array;
	validatorFactory(): RecordValidator;
}

/** Typed terminal for invalid config-driven Nostr rendezvous settings. */
export class NostrRendezvousConfigurationError extends Error {
	/** @param message - Stable caller-facing configuration detail. */
	constructor(message: string) {
		super(message);
		this.name = "NostrRendezvousConfigurationError";
	}
}

/**
 * Builds the public rendezvous directory selected by resolved node policy.
 * @param params - Resolved configuration, identity material, and injectable transport dependencies.
 * @returns HTTP, Nostr, a composite of both, or undefined when public rendezvous is inactive.
 */
export function createConfiguredRendezvousRegistries(
	params: CreateConfiguredRendezvousRegistriesParams
): RendezvousDirectory | undefined {
	const { rendezvousConfig } = params;
	if (!params.publicRendezvousEnabled) return undefined;
	const directories: RendezvousDirectory[] = [];
	const registryEndpoints = params.registryEndpoints ?? rendezvousConfig.endpoints ?? [];
	if (registryEndpoints.length >= 2) {
		directories.push(
			new RegistryClient({
				clientId: params.clientId,
				endpoints: registryEndpoints.map((url, index) =>
					createHttpRegistryEndpoint({
						allow_insecure_loopback_fixture: rendezvousConfig.allow_insecure_loopback_fixture,
						id: `registry-${index + 1}`,
						url,
					})
				),
				timeoutMs: 4_000,
				validatorFactory: params.validatorFactory,
			})
		);
	}

	const nostr = rendezvousConfig.nostr;
	if ((nostr?.relays?.length ?? 0) >= 1) {
		const nostrSigner = configuredNostrSigner(nostr?.secret_key, params.secp256k1PrivateKey);
		directories.push(
			createNostrRelayDirectory({
				allow_insecure_loopback_fixture: rendezvousConfig.allow_insecure_loopback_fixture,
				connectionFactory: params.nostrConnectionFactory ?? createNostrWebSocketRelayFactory(),
				nostrSigner,
				now: params.now ?? Date.now,
				relays: (nostr?.relays ?? []).map((url, index) => ({ id: `nostr-${index + 1}`, url })),
				validatorFactory: params.validatorFactory,
			})
		);
	}

	if (directories.length === 0) return undefined;
	return directories.length === 1 ? directories[0] : createCompositeRendezvousDirectory(directories);
}

function configuredNostrSigner(secretKey: string | undefined, identityKey: Uint8Array): NostrSigner {
	if (secretKey !== undefined && !NOSTR_SECRET_KEY_PATTERN.test(secretKey)) {
		throw new NostrRendezvousConfigurationError(
			"control_plane.rendezvous.nostr.secret_key must be exactly 64 lowercase hexadecimal characters"
		);
	}
	const transportKey =
		secretKey === undefined ? sha256(concatBytes(identityKey, NOSTR_TRANSPORT_KEY_DOMAIN)) : hexToBytes(secretKey);
	try {
		return createNostrSignerFromSecretKey(transportKey);
	} catch {
		throw new NostrRendezvousConfigurationError(
			"control_plane.rendezvous.nostr.secret_key must encode a valid 32-byte Nostr transport key"
		);
	}
}

export interface DRPNodeDependencies {
	/** Optional fail-closed lifecycle check run before restart begins */
	beforeRestart?(): Promise<void> | void;
	/** Factory override for the health-based recovery lifecycle owner. */
	controlPlaneCoordinatorFactory?(
		options: DRPNodeControlPlaneCoordinatorFactoryOptions
	): Pick<ControlPlaneCoordinator, "failedRecoveryAttempts" | "start" | "stop">;
	/** Existing rendezvous, relay, routing, and synchronization mechanisms to orchestrate. */
	readonly controlPlaneMechanisms?: ControlPlaneMechanismPorts;
	/** Deterministic scheduler for health recovery tests and embedded runtimes. */
	readonly controlPlaneScheduler?: ControlPlaneScheduler;
	/** Existing network implementation to use instead of the production default */
	networkNode?: DRPNetworkNode;
	/** Network shutdown owner when an attached control-plane adapter shares the host */
	networkStop?(): Promise<void>;
	/** Existing reconnect owner, or false when an external coordinator owns recovery */
	reconnect?: IDRPIntervalReconnectBootstrap | false;
}

export interface DRPNodeControlPlaneCoordinatorFactoryOptions {
	readonly accessors: {
		getConnectedPeerIds(): readonly string[];
		getRendezvous(): RendezvousEnsemble | undefined;
		getRendezvousCache(): PeerCache | undefined;
	};
	readonly config: ControlPlaneRecoveryConfig;
	getLocalState(): ReadonlyMap<string, unknown>;
	readonly ports: ControlPlaneMechanismPorts;
	readStatus(): ControlPlaneHealthSnapshot;
	readonly scheduler: ControlPlaneScheduler;
	sink(event: ControlPlanePhaseSixEvent): void;
	subscribeStatus(listener: (status: ControlPlaneHealthSnapshot) => void): () => void;
}

/**
 * A DRP node.
 */
export class DRPNode extends TypedEventEmitter<NodeEvents> implements IDRPNode {
	config: DRPNodeConfig;
	networkNode: DRPNetworkNode;
	keychain: Keychain;
	messageQueueManager: MessageQueueManager<Message>;
	private _routing: BrowserRouting | undefined;
	private _rendezvous: RendezvousEnsemble | undefined;
	private _rendezvousCache: PeerCache | undefined;

	#objectStore: DRPObjectStore;
	private _intervals: Map<string, IntervalRunnerMap[keyof IntervalRunnerMap]> = new Map();
	private _subscribedNetworkNode?: DRPNetworkNode;
	private _connectFetchControllers = new Map<string, AbortController>();
	private _connectRendezvousControllers = new Map<string, AbortController>();
	private _initialSyncPeers = new Map<string, Set<string>>();
	private readonly _rendezvousSequenceStore = new InMemorySequenceStore();
	private readonly _roomRendezvousProducers = new Map<string, ReturnType<typeof createRecordProducer>>();
	private readonly _roomRendezvousCapacityLogged = new Set<string>();
	private _roomRendezvousProducerFactory: ((objectId: string) => ReturnType<typeof createRecordProducer>) | undefined;
	private _roomRendezvousMaxRooms = 0;
	private _rendezvousRegistrationController: AbortController | undefined;
	private _rendezvousRegistration: Promise<boolean> | undefined;
	private _rendezvousBootstrapController: AbortController | undefined;
	private _rendezvousBootstrap: Promise<void> | undefined;
	private _rendezvousBackendStates: readonly {
		readonly id: string;
		readonly status: "empty" | "failed" | "succeeded";
	}[] = [];
	private _rendezvousObservedAtMs = 0;
	private readonly _beforeRestart: (() => Promise<void> | void) | undefined;
	private _controlPlaneCoordinator:
		| Pick<ControlPlaneCoordinator, "failedRecoveryAttempts" | "start" | "stop">
		| undefined;
	private readonly _controlPlaneCoordinatorFactory: DRPNodeDependencies["controlPlaneCoordinatorFactory"];
	private readonly _controlPlaneMechanisms: ControlPlaneMechanismPorts | undefined;
	private readonly _controlPlaneScheduler: ControlPlaneScheduler | undefined;
	private _authenticatedDrpPeerIds = new Set<string>();
	private _lastHealthAuthenticatedPeerIds = new Set<string>();
	private _lastDirectConnectionPeerIds = new Set<string>();
	private _preservedControlPlaneState: ReadonlyMap<string, unknown> | undefined;
	private readonly _reconnectDependency?: IDRPIntervalReconnectBootstrap | false;
	private readonly _stopNetwork: () => Promise<void>;
	private _reconnectInterval?: IDRPIntervalReconnectBootstrap;

	/**
	 * Create a new DRP node.
	 * @param config - The configuration for the node.
	 * @param dependencies - Existing lifecycle owners to inject
	 */
	constructor(config?: DRPNodeConfig, dependencies: DRPNodeDependencies = {}) {
		super();
		const newLogger = new Logger("drp::node", config?.log_config);
		log.trace = newLogger.trace;
		log.debug = newLogger.debug;
		log.info = newLogger.info;
		log.warn = newLogger.warn;
		log.error = newLogger.error;
		this.networkNode = dependencies.networkNode ?? new DefaultDRPNetworkNode(config?.network_config);
		if (dependencies.reconnect && dependencies.reconnect.networkNode !== this.networkNode) {
			throw new Error("Injected reconnect policy must own the injected DRP network node");
		}
		this._beforeRestart = dependencies.beforeRestart;
		this._controlPlaneCoordinatorFactory = dependencies.controlPlaneCoordinatorFactory;
		this._controlPlaneMechanisms = dependencies.controlPlaneMechanisms;
		this._controlPlaneScheduler = dependencies.controlPlaneScheduler;
		this._reconnectDependency = dependencies.reconnect;
		this._stopNetwork = dependencies.networkStop ?? ((): Promise<void> => this.networkNode.stop());
		this._routing = createConfiguredBrowserRouting(config);
		this.#objectStore = new DRPObjectStore();
		this.keychain = new Keychain(config?.keychain_config);
		this.config = {
			...config,
			interval_discovery_options: {
				...config?.interval_discovery_options,
			},
			interval_sync_options: {
				...config?.interval_sync_options,
			},
		};
		this.messageQueueManager = new MessageQueueManager<Message>({
			logConfig: this.config.log_config,
		});
	}

	/**
	 * Start the node.
	 */
	async start(): Promise<void> {
		this._routing ??= createConfiguredBrowserRouting(this.config);
		await this.keychain.start();
		await this.networkNode.start(this.keychain.secp256k1PrivateKey);
		await this._startRendezvous();
		this.messageQueueManager.startAll();
		const reconnectInterval = this.getReconnectInterval();
		if (reconnectInterval) this._intervals.set("interval::reconnect", reconnectInterval);
		if (this._subscribedNetworkNode !== this.networkNode) {
			this.networkNode.subscribeToMessageQueue(this.dispatchMessage.bind(this));
			this.networkNode.subscribeToGroupPeerChanges(this.handleGroupPeerChange.bind(this));
			this._subscribedNetworkNode = this.networkNode;
		}
		if (!this.messageQueueManager.hasQueue(DISCOVERY_QUEUE_ID)) {
			this.messageQueueManager.subscribe(DISCOVERY_QUEUE_ID, (msg) => handleMessage(this, msg));
		}
		reconnectInterval?.start();
		this.restoreSubscriptions();
		this._startControlPlaneRecovery();
	}

	/**
	 * Stop the node.
	 */
	async stop(): Promise<void> {
		const controlPlaneCoordinator = this._controlPlaneCoordinator;
		this._controlPlaneCoordinator = undefined;
		try {
			await controlPlaneCoordinator?.stop();
		} catch (error) {
			log.error("::controlPlaneRecovery: Failed to stop coordinator", error);
		}
		this._rendezvousRegistrationController?.abort(new Error("DRPNode stopped"));
		this._rendezvousBootstrapController?.abort(new Error("DRPNode stopped"));
		this._connectFetchControllers.forEach((controller) => controller.abort());
		this._connectFetchControllers.clear();
		this._connectRendezvousControllers.forEach((controller) => controller.abort());
		this._connectRendezvousControllers.clear();
		this._initialSyncPeers.clear();
		// Shutdown intentionally lets room records lapse by TTL instead of creating a retraction storm.
		this._roomRendezvousProducers.clear();
		this._roomRendezvousCapacityLogged.clear();
		this._roomRendezvousProducerFactory = undefined;
		this._roomRendezvousMaxRooms = 0;
		this._intervals.forEach((interval) => interval.stop());
		this._intervals.clear();
		const routing = this._routing;
		this._routing = undefined;
		const rendezvousRegistration = this._rendezvousRegistration;
		const rendezvousBootstrap = this._rendezvousBootstrap;
		this._rendezvousRegistration = undefined;
		this._rendezvousRegistrationController = undefined;
		this._rendezvousBootstrap = undefined;
		this._rendezvousBootstrapController = undefined;
		this._rendezvous = undefined;
		try {
			await Promise.all([routing?.stop(), rendezvousBootstrap, rendezvousRegistration, this._stopNetwork()]);
		} finally {
			this.messageQueueManager.closeAll();
		}
	}

	/**
	 * Browser-safe delegated routing selected by the main-entry configuration.
	 * @returns The configured adapter, or undefined when browser routing is inactive.
	 */
	get routing(): BrowserRouting | undefined {
		return this._routing;
	}

	/** @returns The configured Node rendezvous ensemble, or undefined when inactive. */
	get rendezvous(): RendezvousEnsemble | undefined {
		return this._rendezvous;
	}

	/** @returns The configured authenticated-peer cache, or undefined when inactive. */
	get rendezvousCache(): PeerCache | undefined {
		return this._rendezvousCache;
	}

	private async _startRendezvous(): Promise<void> {
		const rendezvousConfig = this.config.network_config?.control_plane?.rendezvous;
		if (rendezvousConfig === undefined) return;
		const roomPresenceMaxRooms = configuredRoomPresenceMaxRooms(rendezvousConfig);
		const publicRendezvousEnabled =
			this.config.network_config?.control_plane?.rollout?.public_components?.public_rendezvous?.enabled === true;
		const cacheEnabled = rendezvousConfig.cache?.enabled === true;
		const hasInvite = rendezvousConfig.invite !== undefined;
		// Preserve the Phase 4a activation contract unless a Phase 4b source is explicitly enabled.
		const hasConfiguredRegistry =
			publicRendezvousEnabled &&
			rendezvousConfig.publish === true &&
			((rendezvousConfig.endpoints?.length ?? 0) >= 2 ||
				((rendezvousConfig.nostr?.publish ?? rendezvousConfig.publish) === true &&
					(rendezvousConfig.nostr?.relays?.length ?? 0) >= 1));
		if (!hasConfiguredRegistry && !cacheEnabled && !hasInvite) return;
		const namespace = rendezvousConfig.namespace;
		if (namespace === undefined) throw new Error("configured rendezvous requires a namespace");
		if (!namespace.startsWith(PEER_NAMESPACE_PREFIX) || !isValidRendezvousNamespace(namespace)) {
			throw new Error(
				"network_config.control_plane.rendezvous.namespace must use drp-network:v1: followed by 22..86 base64url characters"
			);
		}
		const addressConfig = this.config.network_config?.control_plane?.address_policy;
		const resolver = addressConfig?.resolver ?? createDnsResolver();
		const validatorFactory = (): RecordValidator =>
			new RecordValidator({
				addressPolicyOptions: {
					allowInsecureWebSocket: addressConfig?.allowInsecureWebSocket,
					allowLoopback: addressConfig?.allowLoopback,
					allowPrivate: addressConfig?.allowPrivate,
				},
				resolver,
			});
		if (cacheEnabled && this._rendezvousCache === undefined) {
			this._rendezvousCache = await this._createRendezvousCache(rendezvousConfig.cache, validatorFactory);
		}
		let inviteDirectory: InviteDirectory | undefined;
		let inviteEndpoints: readonly string[] = [];
		if (rendezvousConfig.invite !== undefined) {
			try {
				const invite = await decodeInvite(rendezvousConfig.invite, {
					allow_insecure_loopback_fixture: rendezvousConfig.allow_insecure_loopback_fixture,
					validatorFactory,
				});
				if (invite.namespace !== namespace) throw new Error("invite namespace mismatch");
				inviteDirectory = new InviteDirectory({ invite, validatorFactory });
				inviteEndpoints = invite.registryEndpoints;
				this._emitRendezvousEvent({ kind: "rendezvous-invite", outcome: "accepted" });
			} catch {
				this._emitRendezvousEvent({ kind: "rendezvous-invite", outcome: "failed" });
			}
		}
		const endpoints = publicRendezvousEnabled
			? [...new Set([...(rendezvousConfig.endpoints ?? []), ...inviteEndpoints])]
			: [];
		const registries = createConfiguredRendezvousRegistries({
			clientId: this.networkNode.peerId,
			publicRendezvousEnabled,
			registryEndpoints: endpoints,
			rendezvousConfig,
			secp256k1PrivateKey: this.keychain.secp256k1PrivateKey,
			validatorFactory,
		});
		if (registries === undefined && this._rendezvousCache === undefined && inviteDirectory === undefined) return;
		const directory = createRendezvousEnsemble({
			addressPolicy: {
				policy: new AddressPolicy({
					allowInsecureWebSocket: addressConfig?.allowInsecureWebSocket,
					allowLoopback: addressConfig?.allowLoopback,
					allowPrivate: addressConfig?.allowPrivate,
					target: addressConfig?.target ?? "node",
				}),
				resolver,
			},
			cache: this._rendezvousCache,
			invite: inviteDirectory,
			registries,
			validatorFactory,
		});
		this._rendezvous = directory;
		const bootstrapController = new AbortController();
		this._rendezvousBootstrapController = bootstrapController;
		const bootstrap = this._warmRendezvous(directory, namespace, bootstrapController.signal).finally(() => {
			if (this._rendezvousBootstrap === bootstrap) this._rendezvousBootstrap = undefined;
		});
		this._rendezvousBootstrap = bootstrap;

		if (!rendezvousConfig.publish || registries === undefined) return;

		const ttlMs = rendezvousConfig.record_ttl_ms ?? 60_000;
		const refreshIntervalMs = rendezvousConfig.refresh_interval_ms ?? Math.floor(ttlMs / 2);
		if (
			!Number.isSafeInteger(refreshIntervalMs) ||
			refreshIntervalMs < 250 ||
			refreshIntervalMs >= ttlMs ||
			refreshIntervalMs > 300_000
		) {
			throw new Error("rendezvous refresh_interval_ms must be within 250..300000 inclusive and below record_ttl_ms");
		}
		const registrationDeadlineMs = Math.min(refreshIntervalMs, Math.max(1_000, Math.floor(ttlMs / 4)));
		const privateKey = privateKeyFromRaw(this.keychain.secp256k1PrivateKey);
		const addressSource = (): readonly string[] =>
			prioritizedRendezvousAddresses(this.networkNode.getMultiaddrs() ?? []);
		const capabilitySource = (): readonly DrpCapability[] => deriveRendezvousCapabilities(this.config);
		const signer = new RecordSigner(privateKey);
		const producer = createRecordProducer({
			addressSource,
			capabilitySource,
			namespace,
			peerId: this.networkNode.peerId,
			sequenceStore: this._rendezvousSequenceStore,
			signer,
			ttlMs,
		});
		if (roomPresenceMaxRooms !== undefined) {
			this._roomRendezvousMaxRooms = roomPresenceMaxRooms;
			this._roomRendezvousProducerFactory = (objectId): ReturnType<typeof createRecordProducer> =>
				createRecordProducer({
					addressSource,
					capabilitySource,
					namespace: roomNamespace(objectId),
					peerId: this.networkNode.peerId,
					// Wall-clock seeding outruns prior records; a same-millisecond rejoin can lose one
					// publish cycle to replay and self-heals after the roughly 5s retirement sweep.
					sequenceStore: new InMemorySequenceStore(Date.now()),
					signer,
					ttlMs,
				});
		}
		const credential = registrationCredential(this.config);
		const controller = new AbortController();
		this._rendezvousRegistrationController = controller;
		const runner = new IntervalRunner({
			fn: (): Promise<boolean> => {
				const registration = this._registerRendezvousRecords(
					producer,
					directory,
					credential,
					(endpoints.length >= 2 ? endpoints.length : 0) +
						((rendezvousConfig.nostr?.publish ?? rendezvousConfig.publish) === true
							? (rendezvousConfig.nostr?.relays?.length ?? 0)
							: 0),
					controller.signal,
					registrationDeadlineMs
				);
				const tracked = registration.finally(() => {
					if (this._rendezvousRegistration === tracked) this._rendezvousRegistration = undefined;
				});
				this._rendezvousRegistration = tracked;
				return tracked;
			},
			id: "rendezvous-registration",
			interval: refreshIntervalMs,
			logConfig: this.config.log_config,
			throwOnStop: false,
		});
		this._intervals.set("interval::rendezvous", runner);
		runner.start();
	}

	private async _registerRendezvousRecords(
		producer: ReturnType<typeof createRecordProducer>,
		directory: RendezvousDirectory,
		credential: Parameters<RendezvousDirectory["register"]>[2],
		endpointCount: number,
		lifecycleSignal: AbortSignal,
		deadlineMs: number
	): Promise<boolean> {
		this._backfillRoomRendezvousProducers();
		const deadlineAtMs = Date.now() + deadlineMs;
		await this._registerRendezvousRecord(producer, directory, credential, endpointCount, lifecycleSignal, deadlineMs);
		if (lifecycleSignal.aborted) return false;

		const roomEntries = [...this._roomRendezvousProducers.entries()];
		const roomCount = roomEntries.length;
		if (roomCount === 0) return !lifecycleSignal.aborted;
		const remainingAfterMainMs = deadlineAtMs - Date.now();
		const results = await Promise.allSettled(
			roomEntries.map(async ([objectId, roomProducer]): Promise<boolean> => {
				if (this._roomRendezvousProducers.get(objectId) !== roomProducer) return true;
				if (remainingAfterMainMs <= 0) return false;
				return this._registerRoomRendezvousRecord(
					roomProducer,
					directory,
					credential,
					lifecycleSignal,
					Math.min(remainingAfterMainMs, 30_000)
				);
			})
		);
		const failedRoomCount = results.filter((result) => result.status === "rejected" || result.value === false).length;
		if (failedRoomCount > 0) {
			log.warn("::rendezvous: Room presence registration failures", { failedRoomCount });
		}
		this._emitRendezvousEvent({
			failedRoomCount,
			kind: "rendezvous-room-registration",
			outcome: failedRoomCount === 0 ? "accepted" : failedRoomCount === roomCount ? "failed" : "partial",
			roomCount,
		});
		return !lifecycleSignal.aborted;
	}

	private async _registerRoomRendezvousRecord(
		producer: ReturnType<typeof createRecordProducer>,
		directory: RendezvousDirectory,
		credential: Parameters<RendezvousDirectory["register"]>[2],
		lifecycleSignal: AbortSignal,
		deadlineMs: number
	): Promise<boolean> {
		const timeoutSignal = AbortSignal.timeout(Math.min(deadlineMs, 30_000));
		const signal = AbortSignal.any([lifecycleSignal, timeoutSignal]);
		try {
			const record = await producer.refresh();
			await directory.register(record, signal, credential);
			return !lifecycleSignal.aborted;
		} catch {
			return false;
		}
	}

	private async _createRendezvousCache(
		config: ControlPlanePeerCacheConfig,
		validatorFactory: () => RecordValidator
	): Promise<PeerCache> {
		let store: PeerCacheStore;
		switch (config.persistence) {
			case "memory":
				store = new InMemoryPeerCacheStore();
				break;
			case "browser-local":
				store = new LocalStoragePeerCacheStore({ key: config.key });
				break;
			case "node-fs": {
				const modulePath = "./rendezvous-cache.node.js";
				const { createFsPeerCacheStore } = (await import(/* @vite-ignore */ modulePath)) as NodePeerCacheModule;
				store = await createFsPeerCacheStore(config.path);
				break;
			}
		}
		const cache = createPeerCache({ max: config.max, store, validatorFactory });
		return {
			list: async (namespace, signal): Promise<Awaited<ReturnType<PeerCache["list"]>>> => {
				const records = await cache.list(namespace, signal);
				if (records.length > 0) this._emitRendezvousEvent({ kind: "rendezvous-cache", outcome: "hit" });
				return records;
			},
			prune: () => cache.prune(),
			put: async (record): Promise<void> => {
				await cache.put(record);
				this._emitRendezvousEvent({ kind: "rendezvous-cache", outcome: "write" });
			},
		};
	}

	private async _warmRendezvous(directory: RendezvousEnsemble, namespace: string, signal: AbortSignal): Promise<void> {
		try {
			for await (const _record of directory.bootstrap(namespace, signal)) {
				// Iteration performs bounded validation and cache write-back.
			}
		} catch {
			// Background bootstrap failure is represented by the ensemble trace and must not fail node startup.
		} finally {
			const trace = directory.lastTrace;
			if (trace !== undefined) {
				this._rendezvousBackendStates = trace.sources.map(({ id, status }) => ({ id, status }));
				this._rendezvousObservedAtMs = trace.observedAtMs ?? Date.now();
			}
		}
	}

	private async _registerRendezvousRecord(
		producer: ReturnType<typeof createRecordProducer>,
		directory: RendezvousDirectory,
		credential: Parameters<RendezvousDirectory["register"]>[2],
		endpointCount: number,
		lifecycleSignal: AbortSignal,
		deadlineMs: number
	): Promise<boolean> {
		const timeoutSignal = AbortSignal.timeout(Math.min(deadlineMs, 30_000));
		const signal = AbortSignal.any([lifecycleSignal, timeoutSignal]);
		try {
			const record = await producer.refresh();
			const receipt = await directory.register(record, signal, credential);
			if (lifecycleSignal.aborted) return false;
			const acceptedSourceCount = receipt.acceptedEndpointIds.length;
			const failedSourceCount = receipt.attempts.length - acceptedSourceCount;
			this._rendezvousBackendStates = receipt.attempts.map(({ endpointId, status }) => ({
				id: endpointId,
				status: status === "accepted" ? "succeeded" : "failed",
			}));
			this._rendezvousObservedAtMs = Date.now();
			const reason = sanitizedRendezvousRegistrationReason(receipt.attempts);
			this._emitRendezvousEvent({
				acceptedSourceCount,
				failedSourceCount,
				kind: "rendezvous-registration",
				outcome: failedSourceCount === 0 ? "accepted" : "partial",
				...(reason === undefined ? {} : { reason }),
			});
		} catch (error) {
			const attempts = error instanceof RegistryExhaustedError ? error.attempts.length : endpointCount;
			const reason =
				error instanceof RegistryExhaustedError
					? sanitizedRendezvousRegistrationReason(error.attempts)
					: sanitizedRendezvousRegistrationFailureReason(error, lifecycleSignal, timeoutSignal);
			this._rendezvousBackendStates =
				error instanceof RegistryExhaustedError
					? error.attempts.map(({ endpointId }) => ({ id: endpointId, status: "failed" as const }))
					: Array.from({ length: endpointCount }, (_, index) => ({
							id: `registry-${index + 1}`,
							status: "failed" as const,
						}));
			this._rendezvousObservedAtMs = Date.now();
			this._emitRendezvousEvent({
				acceptedSourceCount: 0,
				failedSourceCount: Math.min(endpointCount, attempts),
				kind: "rendezvous-registration",
				outcome: "failed",
				...(reason === undefined ? {} : { reason }),
			});
		}
		return !lifecycleSignal.aborted;
	}

	private _emitRendezvousEvent(event: ControlPlaneEvent): void {
		try {
			this.config.network_config?.control_plane?.observability?.sink(event);
		} catch {
			// Observability must not change control-plane behavior.
		}
	}

	private _startControlPlaneRecovery(): void {
		const recoveryConfig = this.config.network_config?.control_plane?.recovery;
		if (recoveryConfig === undefined || this._controlPlaneCoordinator !== undefined) return;
		if (this._controlPlaneMechanisms === undefined && this.networkNode.redialBootstraps === undefined) {
			throw new Error("control_plane.recovery requires network redial support or injected controlPlaneMechanisms");
		}
		if (
			this._controlPlaneMechanisms === undefined &&
			this.config.network_config?.control_plane?.relay_policy !== undefined &&
			this.networkNode.replaceRelay === undefined
		) {
			throw new Error("control_plane.recovery requires relay replacement support for configured relay policy");
		}
		if (
			this._controlPlaneMechanisms === undefined &&
			this.config.network_config?.control_plane?.routing?.node?.enabled === true &&
			this.networkNode.refreshRouting === undefined
		) {
			throw new Error("control_plane.recovery requires routing refresh support for configured Node routing");
		}
		const scheduler = this._controlPlaneScheduler ?? new SystemControlPlaneScheduler();
		const health = new ControlPlaneHealthAggregator({ now: (): number => scheduler.now() });
		const readStatus = (): ControlPlaneHealthSnapshot => this._readControlPlaneHealth(health);
		const ports = this._controlPlaneMechanisms ?? this._createDefaultControlPlaneMechanisms();
		const getLocalState = (): ReadonlyMap<string, unknown> =>
			new Map([...this.#objectStore.values()].map((object) => [object.id, object]));
		const factoryOptions: DRPNodeControlPlaneCoordinatorFactoryOptions = {
			accessors: {
				getConnectedPeerIds: (): readonly string[] => this.networkNode.getAllPeers(),
				getRendezvous: (): RendezvousEnsemble | undefined => this.rendezvous,
				getRendezvousCache: (): PeerCache | undefined => this.rendezvousCache,
			},
			config: recoveryConfig,
			getLocalState,
			ports,
			readStatus,
			scheduler,
			sink: (event): void => this._emitRendezvousEvent(event),
			subscribeStatus: (listener): (() => void) => {
				let active = true;
				const refresh = (): void => {
					void this._refreshAuthenticatedDrpPeers().then((): void => {
						if (!active) return;
						try {
							listener(readStatus());
						} catch {
							// Health observation must not interfere with network membership events.
						}
					});
				};
				const unsubscribe = this.networkNode.subscribeToGroupPeerChanges(refresh);
				refresh();
				return (): void => {
					active = false;
					unsubscribe();
				};
			},
		};
		this._controlPlaneCoordinator =
			this._controlPlaneCoordinatorFactory?.(factoryOptions) ??
			new ControlPlaneCoordinator({
				config: recoveryConfig,
				getLocalState,
				ports,
				readStatus,
				scheduler,
				sink: factoryOptions.sink,
				subscribeStatus: factoryOptions.subscribeStatus,
			});
		this._controlPlaneCoordinator.start();
	}

	private _readControlPlaneHealth(health: ControlPlaneHealthAggregator): ControlPlaneHealthSnapshot {
		const authenticatedDrpPeerIds = [...this._authenticatedDrpPeerIds].sort();
		const lostAuthenticatedPeerIds = [...this._lastHealthAuthenticatedPeerIds].filter(
			(peerId) => !this._authenticatedDrpPeerIds.has(peerId)
		);
		this._lastHealthAuthenticatedPeerIds = new Set(authenticatedDrpPeerIds);
		const trace = this._rendezvous?.lastTrace;
		const backendStates =
			this._rendezvousBackendStates.length > 0
				? this._rendezvousBackendStates
				: (trace?.sources.map(({ id, status }) => ({ id, status })) ?? []);
		const healthyBackendCount = backendStates.filter(({ status }) => status !== "failed").length;
		const nowMs = this._controlPlaneScheduler?.now() ?? Date.now();
		const rendezvousObservedAtMs = this._rendezvousObservedAtMs || trace?.observedAtMs || 0;
		const freshnessWindowMs = Math.max(
			1_000,
			(this.config.network_config?.control_plane?.rendezvous?.refresh_interval_ms ?? 30_000) * 2
		);
		const rendezvousFresh =
			rendezvousObservedAtMs > 0 &&
			nowMs >= rendezvousObservedAtMs &&
			nowMs - rendezvousObservedAtMs <= freshnessWindowMs &&
			healthyBackendCount > 0;
		const connectionEvidence = this.networkNode.getControlPlaneConnections?.() ?? [];
		const authenticatedConnections = connectionEvidence.filter(({ peerId }) =>
			this._authenticatedDrpPeerIds.has(peerId)
		);
		const directConnectionPeerIds = new Set(
			authenticatedConnections
				.filter(({ multiaddr, transport }) => transport !== "relay" && !multiaddr.includes("/p2p-circuit"))
				.map(({ peerId }) => peerId)
		);
		const relayedConnectionPeerIds = new Set(
			authenticatedConnections
				.filter(({ multiaddr, transport }) => transport === "relay" || multiaddr.includes("/p2p-circuit"))
				.map(({ peerId }) => peerId)
		);
		const directConnectionFailedPeerIds = [...this._lastDirectConnectionPeerIds].filter(
			(peerId) => !directConnectionPeerIds.has(peerId) && relayedConnectionPeerIds.has(peerId)
		);
		this._lastDirectConnectionPeerIds = directConnectionPeerIds;
		const liveReservations = (this.networkNode.getActiveRelayReservations?.() ?? [])
			.filter(({ expiresAtMs }) => expiresAtMs > nowMs)
			.map(({ operatorGroup, peerId }) => ({ operatorGroup, relayId: peerId }));
		const objects = [...this.#objectStore.values()];
		const synchronizationStates = objects.map((object): "behind" | "synchronized" | "unknown" => {
			if (hasRemoteSyncHistory(object.vertices, this.networkNode.peerId)) return "synchronized";
			if (creatorFromObjectID(object.id) === this.networkNode.peerId) return "synchronized";
			const interval = this._intervals.get(objectIntervalKey("sync", object.id));
			return interval instanceof DRPIntervalSync ? interval.initialSynchronizationState : "unknown";
		});
		const objectSynchronization = synchronizationStates.includes("behind")
			? "behind"
			: synchronizationStates.length > 0 && synchronizationStates.every((state) => state === "synchronized")
				? "synchronized"
				: "unknown";
		const bootstrapPeerIds = new Set(
			this.networkNode
				.getBootstrapNodes()
				.map((address) => address.split("/p2p/")[1])
				.filter((peerId): peerId is string => peerId !== undefined)
		);
		const connectedBootstrapPeerIds = this.networkNode.getAllPeers().filter((peerId) => bootstrapPeerIds.has(peerId));
		const failedRouterIds =
			this._routing?.lastTrace?.attempts
				.filter(({ status }) => status === "failure")
				.map(({ endpointId }) => endpointId) ?? [];
		return health.aggregate({
			authenticatedDrpPeerIds,
			connectedBootstrapPeerIds,
			directConnectionFailedPeerIds,
			failedRecoveryAttempts: this._controlPlaneCoordinator?.failedRecoveryAttempts ?? [],
			healthyBackendCount,
			liveReservations,
			lostAuthenticatedPeerIds,
			meshDiversity: {
				authenticatedPeerCount: authenticatedDrpPeerIds.length,
				operatorGroupCount: new Set(
					liveReservations.map(({ operatorGroup }) => operatorGroup).filter((group) => group !== "unknown")
				).size,
				transportCount: new Set(
					authenticatedConnections.map(({ transport }) => transport).filter((transport) => transport !== "unknown")
				).size,
			},
			objectSynchronization,
			rendezvous: {
				backends: backendStates,
				fresh: rendezvousFresh,
				replicaAvailability:
					healthyBackendCount === 0
						? "unavailable"
						: healthyBackendCount === backendStates.length
							? "available"
							: "partial",
				replicaCount: healthyBackendCount,
			},
			routing: { failedRouterIds },
			subscribedObjectCount: objects.filter((object) => this.messageQueueManager.hasQueue(object.id)).length,
			traffic: {
				directConnections: authenticatedConnections.filter(
					({ multiaddr, transport }) => transport !== "relay" && !multiaddr.includes("/p2p-circuit")
				).length,
				relayedConnections: authenticatedConnections.filter(
					({ multiaddr, transport }) => transport === "relay" || multiaddr.includes("/p2p-circuit")
				).length,
			},
		});
	}

	private async _refreshAuthenticatedDrpPeers(): Promise<void> {
		const groupPeers = new Set<string>();
		for (const object of this.#objectStore.values()) {
			for (const peerId of this.networkNode.getGroupPeers(object.id)) groupPeers.add(peerId);
		}
		const verifier = this.networkNode.membershipVerifier;
		const membershipMode = this.config.network_config?.control_plane?.membership?.mode;
		if (verifier === undefined || membershipMode !== "allowlist") {
			this._authenticatedDrpPeerIds = groupPeers;
			return;
		}
		const decisions = await Promise.all(
			[...groupPeers].map(async (peerId): Promise<readonly [string, boolean]> => {
				try {
					const decision = await verifier.verify({ peerId, signal: new AbortController().signal });
					return [peerId, isAcceptedMembershipDecision(decision)] as const;
				} catch {
					return [peerId, false] as const;
				}
			})
		);
		this._authenticatedDrpPeerIds = new Set(decisions.filter(([, accepted]) => accepted).map(([peerId]) => peerId));
	}

	private _createDefaultControlPlaneMechanisms(): ControlPlaneMechanismPorts {
		return {
			continueRelayed: (): Promise<{ terminal: "succeeded" }> => Promise.resolve({ terminal: "succeeded" }),
			disconnectPeer: (peerId): Promise<void> => this.networkNode.disconnect(peerId),
			preserveLocalState: (snapshot): Promise<{ terminal: "succeeded" }> => {
				this._preservedControlPlaneState = new Map(snapshot);
				return Promise.resolve({ terminal: "succeeded" });
			},
			registryCooldown: (): void => {},
			relayReplace: async (request, _reason, signal): Promise<{ terminal: "failed" | "succeeded" }> => ({
				terminal: (await this.networkNode.replaceRelay?.(request, signal)) === true ? "succeeded" : "failed",
			}),
			rendezvousBootstrap: async (request, signal): Promise<{ terminal: "failed" | "succeeded" }> => {
				let connected = false;
				const directory = this._rendezvous;
				const namespace = this.config.network_config?.control_plane?.rendezvous?.namespace;
				if (directory !== undefined && namespace !== undefined) {
					try {
						const sources = request.sources.map((source) =>
							source === "signed-invite" ? ("invite" as const) : source
						);
						for await (const record of directory.bootstrap(namespace, signal, {
							excludeBackendIds: request.excludeBackendIds,
							preferredRegistryIds: request.preferredRegistryIds,
							sources,
						})) {
							signal.throwIfAborted();
							await this.networkNode.connect([...record.acceptedAddresses]);
							connected = true;
						}
					} catch {
						if (signal.aborted) throw signal.reason;
					} finally {
						const latestTrace = directory.lastTrace;
						if (latestTrace !== undefined) {
							this._rendezvousBackendStates = latestTrace.sources.map(({ id, status }) => ({ id, status }));
							this._rendezvousObservedAtMs = latestTrace.observedAtMs ?? Date.now();
						}
					}
				}
				const bootstrapConnected = (await this.networkNode.redialBootstraps?.(signal)) ?? false;
				return { terminal: connected || bootstrapConnected ? "succeeded" : "failed" };
			},
			routerFallback: async (_request, signal): Promise<{ terminal: "failed" | "succeeded" }> => {
				const routing = this._routing;
				if (routing !== undefined) {
					try {
						for await (const _peer of routing.getClosestPeers(
							new TextEncoder().encode(this.networkNode.peerId),
							signal
						)) {
							return { terminal: "succeeded" };
						}
					} catch {
						if (signal.aborted) throw signal.reason;
					}
				}
				return { terminal: (await this.networkNode.refreshRouting?.(signal)) === true ? "succeeded" : "failed" };
			},
			syncFromDifferentPeer: async ({ candidates }): Promise<{ terminal: "failed" | "succeeded" }> => {
				const peerId = candidates[0];
				if (peerId === undefined) return { terminal: "failed" };
				const objects = [...this.#objectStore.values()];
				if (objects.length === 0) return { terminal: "failed" };
				await Promise.all(objects.map((object) => this.syncObject(object.id, peerId)));
				return { terminal: "succeeded" };
			},
		};
	}

	/**
	 * Restart the node.
	 */
	async restart(): Promise<void> {
		await this._beforeRestart?.();
		await this.stop();
		await this.start();
		log.info("::restart: Node restarted");
	}

	private getReconnectInterval(): IDRPIntervalReconnectBootstrap | undefined {
		if (this.config.network_config?.control_plane?.recovery !== undefined) return undefined;
		if (this._reconnectDependency === false) return undefined;
		this._reconnectInterval ??=
			this._reconnectDependency ??
			createDRPReconnectBootstrap({
				...this.config.interval_reconnect_options,
				id: this.networkNode.peerId.toString(),
				networkNode: this.networkNode,
				logConfig: this.config.log_config,
			});
		return this._reconnectInterval;
	}

	/**
	 * Dispatch a message.
	 * @param msg - The message to dispatch.
	 */
	async dispatchMessage(msg: Message): Promise<void> {
		if (DISCOVERY_MESSAGE_TYPES.includes(msg.type)) {
			await this.messageQueueManager.enqueue(DISCOVERY_QUEUE_ID, msg);
			return;
		}

		await this.messageQueueManager.enqueue(msg.objectId, msg);
	}

	/**
	 * Add a custom group.
	 * @param group - The group to add.
	 */
	addCustomGroup(group: string): void {
		this.networkNode.subscribe(group);
	}

	/**
	 * Send a message to a group.
	 * @param group - The group to send the message to.
	 * @param data - The data to send.
	 */
	async sendGroupMessage(group: string, data: Uint8Array): Promise<void> {
		const message = Message.create({
			sender: this.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_CUSTOM,
			data,
		});
		await this.networkNode.broadcastMessage(group, message);
	}

	/**
	 * Send a message to a peer.
	 * @param peerId - The peer to send the message to.
	 * @param data - The data to send.
	 */
	async sendCustomMessage(peerId: string, data: Uint8Array): Promise<void> {
		const message = Message.create({
			sender: this.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_CUSTOM,
			data,
		});
		await this.networkNode.sendMessage(peerId, message);
	}

	/**
	 * Get an object by id
	 * @param id The id of the object
	 * @returns The object, or undefined if it does not exist
	 */
	get<T extends IDRP>(id: string): IDRPObject<T> | undefined {
		return this.#objectStore.get(id);
	}

	/**
	 * Put an object into the store.
	 * @param id The id of the object
	 * @param object The object
	 */
	put<T extends IDRP>(id: string, object: IDRPObject<T>): void {
		this.#objectStore.put(id, object);
	}

	/**
	 * Subscribe to an object.
	 * @param id The id of the object
	 * @param callback The callback to call when the object changes
	 */
	subscribe<T extends IDRP>(id: string, callback: DRPObjectSubscribeCallback<T>): void {
		this.#objectStore.subscribe(id, callback);
	}

	/**
	 * Create an object.
	 * @param options - The options for the object.
	 * @returns The created object.
	 */
	async createObject<T extends IDRP>(options: NodeCreateObjectOptions<T>): Promise<DRPObject<T>> {
		if (this.networkNode.peerId === "") {
			throw new Error("Node not started");
		}
		const validation = NodeCreateObjectOptionsSchema.safeParse(options);
		if (!validation.success) {
			throw new DRPValidationError(validation.error);
		}

		const object = new DRPObject<T>({
			peerId: this.networkNode.peerId,
			acl: options.acl ?? createPermissionlessACL(this.networkNode.peerId),
			drp: options.drp,
			id: options.id,
			metrics: options.metrics,
			config: {
				log_config: options.log_config,
			},
		});

		// put the object in the object store
		this.#objectStore.put(object.id, object);

		// subscribe to the object
		this.subscribeObject(object);

		// sync the object
		if (options.sync?.enabled) {
			await operations.syncObject(this, object.id, options.sync.peerId);
		}
		this._createObjectIntervals(object.id);
		return object;
	}

	/**
	 * Connect to an existing object
	 * @param options - The options for the object.
	 * @returns The connected object.
	 */
	async connectObject<T extends IDRP>(options: NodeConnectObjectOptions<T>): Promise<IDRPObject<T>> {
		if (this.networkNode.peerId === "") {
			throw new Error("Node not started");
		}
		const validation = NodeConnectObjectOptionsSchema.safeParse(options);
		if (!validation.success) {
			throw new DRPValidationError(validation.error);
		}
		const object = new DRPObject<T>({
			peerId: this.networkNode.peerId,
			id: options.id,
			drp: options.drp,
			metrics: options.metrics,
			config: { log_config: options.log_config },
		});

		// put the object in the object store
		this.#objectStore.put(object.id, object);

		this.subscribeObject(object);

		// Genesis authority was already derived locally from the creator-bound id.
		// Anti-entropy must remain active even when the initial fetch sees no peer,
		// so a later SYNC can deliver the object's history.
		this._createObjectIntervals(options.id);
		void this._connectObjectCreator(options.id);
		const previousFetch = this._connectFetchControllers.get(object.id);
		previousFetch?.abort();
		const fetchController = new AbortController();
		this._connectFetchControllers.set(object.id, fetchController);
		let fetchTimedOut = false;
		const fetchTimeout = setTimeout(() => {
			fetchTimedOut = true;
			fetchController.abort();
		}, 5000);
		const fetchResponse = raceEvent(this, NodeEventName.DRP_FETCH_STATE_RESPONSE, fetchController.signal, {
			filter: (event: CustomEvent<FetchStateResponseEvent>) =>
				event.detail.id === object.id && event.detail.fetchStateResponse.vertexHash === HashGraph.rootHash,
		});
		let fetchInFlight = false;
		const requestState = async (): Promise<void> => {
			if (fetchController.signal.aborted || fetchInFlight) return;
			fetchInFlight = true;
			try {
				await operations.fetchState(this, options.id, options.sync?.peerId);
			} catch (error) {
				log.error("::connectObject: Fetch state failed", error);
			} finally {
				fetchInFlight = false;
			}
		};
		const fetchRetry = setInterval(() => void requestState(), 1000);
		let fetchSucceeded = false;
		try {
			void requestState();
			await fetchResponse;
			fetchSucceeded = true;
		} catch (error) {
			if (error instanceof AbortError) {
				if (fetchTimedOut) log.error("::connectObject: Fetch state timed out");
			} else {
				throw error;
			}
		} finally {
			clearInterval(fetchRetry);
			clearTimeout(fetchTimeout);
			if (this._connectFetchControllers.get(object.id) === fetchController) {
				this._connectFetchControllers.delete(object.id);
			}
		}
		if (fetchController.signal.aborted && !fetchTimedOut) return object;
		if (!fetchSucceeded) return object;
		// TODO: since when the interval can run this twice do we really want it to be
		// run while the other one might still be running?
		const intervalFn = (interval: NodeJS.Timeout) => async (): Promise<void> => {
			if (object.acl) {
				await operations.syncObject(this, object.id, options.sync?.peerId);
				log.info("::connectObject: Synced object", object.id);
				log.info("::connectObject: Subscribed to object", object.id);
				clearInterval(interval);
			}
		};
		const retry = setInterval(() => void intervalFn(retry)(), 1000);

		return object;
	}

	/**
	 * Discovers a creator or room replica without delaying or failing the
	 * object connection flow.
	 * @param id - Object id carrying an optional creator commitment.
	 */
	private async _connectObjectCreator(id: string): Promise<void> {
		this._connectRendezvousControllers.get(id)?.abort();
		this._connectRendezvousControllers.delete(id);

		const creator = creatorFromObjectID(id);
		const creatorIsSelf = creator === this.networkNode.peerId;
		if (creator !== undefined && !creatorIsSelf && this.networkNode.getAllPeers().includes(creator)) return;
		const directory = this._rendezvous;
		const namespace = this.config.network_config?.control_plane?.rendezvous?.namespace;
		if (directory === undefined) return;

		const controller = new AbortController();
		// No await occurs before this registration, and stop() clears _rendezvous,
		// so shutdown cannot interleave here and re-arm an orphaned controller.
		this._connectRendezvousControllers.set(id, controller);
		const dialedAddressSets = new Set<string>();
		try {
			if (creator !== undefined && !creatorIsSelf && namespace !== undefined) {
				const selection: RendezvousBootstrapSelection = { targetPeerId: creator };
				try {
					for await (const record of directory.bootstrap(namespace, controller.signal, selection)) {
						const acceptedAddresses = [...record.acceptedAddresses];
						const addressSetKey = JSON.stringify([...acceptedAddresses].sort());
						// A source that violates targeted selection cannot make the same
						// address set dialable later through this invocation's fallback.
						if (record.record.peerId !== creator) {
							dialedAddressSets.add(addressSetKey);
							continue;
						}
						if (dialedAddressSets.has(addressSetKey)) continue;
						controller.signal.throwIfAborted();
						dialedAddressSets.add(addressSetKey);
						try {
							await this.networkNode.connect(acceptedAddresses);
						} catch (error) {
							if (controller.signal.aborted) throw error;
							log.info("::connectObject: Targeted creator dial failed", error);
							continue;
						}
						controller.signal.throwIfAborted();
					}
				} catch (error) {
					if (controller.signal.aborted) {
						log.info("::connectObject: Targeted creator rendezvous cancelled");
					} else {
						log.error("::connectObject: Targeted creator rendezvous failed", error);
					}
				}
			}
			if (controller.signal.aborted) return;
			if (creator !== undefined && !creatorIsSelf && this.networkNode.getAllPeers().includes(creator)) return;

			let fallbackDialCount = 0;
			try {
				// Any validated replica is acceptable by design; room admission is communal.
				for await (const record of directory.bootstrap(roomNamespace(id), controller.signal)) {
					if (fallbackDialCount >= MAX_ROOM_RENDEZVOUS_DIALS) break;
					if (record.record.peerId === this.networkNode.peerId) continue;
					const acceptedAddresses = [...record.acceptedAddresses];
					const addressSetKey = JSON.stringify([...acceptedAddresses].sort());
					if (dialedAddressSets.has(addressSetKey)) continue;
					controller.signal.throwIfAborted();
					dialedAddressSets.add(addressSetKey);
					fallbackDialCount += 1;
					try {
						await this.networkNode.connect(acceptedAddresses);
					} catch (error) {
						if (controller.signal.aborted) throw error;
						log.info("::connectObject: Room replica dial failed", error);
						continue;
					}
					controller.signal.throwIfAborted();
				}
			} catch (error) {
				if (controller.signal.aborted) {
					log.info("::connectObject: Room replica rendezvous cancelled");
				} else {
					log.error("::connectObject: Room replica rendezvous failed", error);
				}
			}
		} finally {
			if (this._connectRendezvousControllers.get(id) === controller) {
				this._connectRendezvousControllers.delete(id);
			}
		}
	}

	/**
	 * Subscribe to an object.
	 * @param object - The object to subscribe to.
	 */
	subscribeObject<T extends IDRP>(object: IDRPObject<T>): void {
		// Reserve queue capacity before installing callbacks or gossip subscriptions.
		this.messageQueueManager.subscribe(object.id, (msg) => handleMessage(this, msg));
		try {
			object.subscribe((obj, originFn, vertices) => drpObjectChangesHandler(this, obj, originFn, vertices));
			this.networkNode.subscribe(object.id);
			this._addRoomRendezvousProducer(object.id);
		} catch (error) {
			this.messageQueueManager.close(object.id);
			throw error;
		}
	}

	/**
	 * Unsubscribe from an object.
	 * @param id - The object ID.
	 * @param purge - Whether to purge the object.
	 */
	unsubscribeObject(id: string, purge?: boolean): void {
		this._connectFetchControllers.get(id)?.abort();
		this._connectFetchControllers.delete(id);
		this._connectRendezvousControllers.get(id)?.abort();
		this._connectRendezvousControllers.delete(id);
		const roomProducer = this._roomRendezvousProducers.get(id);
		this._roomRendezvousProducers.delete(id);
		const directory = this._rendezvous;
		const lifecycleSignal = this._rendezvousRegistrationController?.signal;
		if (roomProducer !== undefined && directory !== undefined && lifecycleSignal !== undefined) {
			const registration = this._rendezvousRegistration;
			void (async (): Promise<void> => {
				if (registration !== undefined) {
					const fenceSignal = AbortSignal.any([lifecycleSignal, AbortSignal.timeout(5_000)]);
					await Promise.race([
						registration.then(
							() => undefined,
							() => undefined
						),
						new Promise<void>((resolve) => {
							if (fenceSignal.aborted) {
								resolve();
								return;
							}
							fenceSignal.addEventListener("abort", () => resolve(), { once: true });
						}),
					]);
				}
				lifecycleSignal.throwIfAborted();
				const signal = AbortSignal.any([lifecycleSignal, AbortSignal.timeout(5_000)]);
				const record = await roomProducer.retire();
				await directory.register(record, signal, registrationCredential(this.config));
			})().catch((error: unknown) => {
				log.info("::rendezvous: Room presence retraction failed; record will lapse by TTL", error);
			});
		}
		this._roomRendezvousCapacityLogged.delete(id);
		this._stopObjectIntervals(id);
		clearSyncRecoveryEpisodes(this, id);
		this._initialSyncPeers.delete(id);
		this.networkNode.unsubscribe(id);
		if (purge) this.#objectStore.remove(id);
		this.networkNode.removeTopicScoreParams(id);
		this.messageQueueManager.close(id);
	}

	/**
	 * Sync an object.
	 * @param id - The object ID.
	 * @param peerId - The peer ID to sync with.
	 */
	async syncObject(id: string, peerId?: string): Promise<void> {
		await operations.syncObject(this, id, peerId);
	}

	/**
	 * Probe each newly appeared peer once while a joined object has no remotely
	 * authored history yet. A local operation does not prove that initial sync
	 * reached another replica. Periodic anti-entropy remains responsible for
	 * later retries.
	 * @param change - Remote gossipsub topic membership change
	 */
	private handleGroupPeerChange(change: GroupPeerChange): void {
		const peers = this._initialSyncPeers.get(change.topic);
		if (!change.subscribed) {
			peers?.delete(change.peerId);
			return;
		}

		const object = this.get(change.topic);
		if (!object || hasRemoteSyncHistory(object.vertices, this.networkNode.peerId)) return;
		if (!this.networkNode.getSubscribedTopics().includes(change.topic)) return;
		if (!this.networkNode.getGroupPeers(change.topic).includes(change.peerId)) return;

		const initialSyncPeers = peers ?? new Set<string>();
		if (initialSyncPeers.has(change.peerId)) return;
		initialSyncPeers.add(change.peerId);
		this._initialSyncPeers.set(change.topic, initialSyncPeers);
		void this.syncObject(change.topic, change.peerId).catch((error) => {
			log.error("::initialSync: Probe failed", error);
		});
	}

	/** Restore queue and gossip subscriptions plus intervals for stored objects. */
	private restoreSubscriptions(): void {
		for (const object of this.#objectStore.values()) {
			if (!this.messageQueueManager.hasQueue(object.id)) {
				this.messageQueueManager.subscribe(object.id, (msg) => handleMessage(this, msg));
			}
			this.networkNode.subscribe(object.id);
			this._addRoomRendezvousProducer(object.id);
			this._createObjectIntervals(object.id);
		}
	}

	private _addRoomRendezvousProducer(objectId: string): void {
		if (this.networkNode.peerId === "" || this._roomRendezvousProducers.has(objectId)) return;
		const producerFactory = this._roomRendezvousProducerFactory;
		if (producerFactory === undefined) return;
		if (this._roomRendezvousProducers.size >= this._roomRendezvousMaxRooms) {
			if (!this._roomRendezvousCapacityLogged.has(objectId)) {
				this._roomRendezvousCapacityLogged.add(objectId);
				log.info("::rendezvous: Room presence capacity reached", objectId);
			}
			return;
		}
		this._roomRendezvousProducers.set(objectId, producerFactory(objectId));
		this._roomRendezvousCapacityLogged.delete(objectId);
	}

	private _backfillRoomRendezvousProducers(): void {
		for (const object of this.#objectStore.values()) {
			if (this._roomRendezvousProducers.size >= this._roomRendezvousMaxRooms) return;
			if (!this.messageQueueManager.hasQueue(object.id)) continue;
			this._addRoomRendezvousProducer(object.id);
		}
	}

	private _createIntervalDiscovery(id: string): void {
		const key = objectIntervalKey("discovery", id);
		const existingInterval = this._intervals.get(key);
		existingInterval?.stop(); // Stop only if it exists

		const interval =
			existingInterval ??
			createDRPDiscovery({
				...this.config.interval_discovery_options,
				id,
				networkNode: this.networkNode,
				logConfig: this.config.log_config,
			});

		this._intervals.set(key, interval);
		interval.start();
	}

	private _createIntervalSync(id: string): void {
		const key = objectIntervalKey("sync", id);
		const existingInterval = this._intervals.get(key);
		existingInterval?.stop();

		const interval =
			existingInterval ??
			createDRPIntervalSync({
				...this.config.interval_sync_options,
				id,
				node: this,
				logConfig: this.config.log_config,
			});

		this._intervals.set(key, interval);
		interval.start();
	}

	private _createObjectIntervals(id: string): void {
		this._createIntervalDiscovery(id);
		this._createIntervalSync(id);
	}

	private _stopObjectIntervals(id: string): void {
		for (const type of ["discovery", "sync"] as const) {
			const key = objectIntervalKey(type, id);
			this._intervals.get(key)?.stop();
			this._intervals.delete(key);
		}
	}

	/**
	 * Handle a discovery response.
	 * @param sender - The sender of the message.
	 * @param message - The message to handle.
	 */
	async handleDiscoveryResponse(sender: string, message: Message): Promise<void> {
		const response = DRPDiscoveryResponse.decode(message.data);
		const objectId = message.objectId;
		const interval = this._intervals.get(objectIntervalKey("discovery", objectId));
		if (!interval) {
			log.error("::handleDiscoveryResponse: Object not found");
			return;
		}
		if (interval.type !== "interval:discovery") {
			log.error("::handleDiscoveryResponse: Invalid interval type");
			return;
		}
		await interval.handleDiscoveryResponse(sender, response.subscribers);
	}
}

function prioritizedRendezvousAddresses(addresses: readonly string[]): readonly string[] {
	const uniqueAddresses = [...new Set(addresses)];
	if (uniqueAddresses.length <= DEFAULT_RECORD_LIMITS.maxAddresses) return uniqueAddresses;

	const webrtcAddresses: string[] = [];
	const plainCircuitAddresses: string[] = [];
	const otherAddresses: string[] = [];
	for (const address of uniqueAddresses) {
		if (address.includes("/webrtc")) {
			webrtcAddresses.push(address);
		} else if (address.includes("/p2p-circuit")) {
			plainCircuitAddresses.push(address);
		} else {
			otherAddresses.push(address);
		}
	}

	const reachabilityAddresses: string[] = [];
	const reachabilityClassSize = Math.max(webrtcAddresses.length, plainCircuitAddresses.length);
	for (let index = 0; index < reachabilityClassSize; index += 1) {
		const webrtcAddress = webrtcAddresses[index];
		if (webrtcAddress !== undefined) reachabilityAddresses.push(webrtcAddress);
		const plainCircuitAddress = plainCircuitAddresses[index];
		if (plainCircuitAddress !== undefined) reachabilityAddresses.push(plainCircuitAddress);
	}

	return [...reachabilityAddresses, ...otherAddresses].slice(0, DEFAULT_RECORD_LIMITS.maxAddresses);
}

function createConfiguredBrowserRouting(config: DRPNodeConfig | undefined): BrowserRouting | undefined {
	const routing = config?.network_config?.control_plane?.routing?.browser;
	if (routing?.endpoints === undefined) return undefined;
	if (config?.network_config?.control_plane?.rollout?.public_components?.delegated_routing?.enabled !== true) {
		return undefined;
	}
	const endpointUrls = routing.endpoints;
	if (endpointUrls.length === 0) {
		throw new Error("Browser routing requires at least one delegated endpoint, even for a single-endpoint fixture");
	}
	const parsedEndpoints = endpointUrls.map((url, index) => {
		try {
			return { id: `endpoint-${index + 1}`, url, origin: new URL(url).origin };
		} catch (error) {
			throw new Error(`Browser routing endpoint ${index + 1} is not a valid URL: "${url}"`, { cause: error });
		}
	});
	const allowedOrigins = [...new Set(parsedEndpoints.map(({ origin }) => origin))];
	if (allowedOrigins.length < 2 && routing.allow_single_endpoint_fixture !== true) {
		throw new Error("Browser routing requires at least two distinct endpoint origins");
	}
	const endpoints: BrowserRoutingEndpoint[] = parsedEndpoints.map(({ id, url }) => ({ id, url }));
	return createBrowserRouting({
		// A single fixture flag relaxes every loopback/insecure-WebSocket allowance together, so
		// config-driven routing accepts local-fixture relay addresses the same way an explicitly
		// constructed BrowserRouting does. Never enabled outside an explicit fixture opt-in.
		allowInsecureLoopback: routing.allow_insecure_loopback_fixture,
		allowInsecureWebSocketFixture: routing.allow_insecure_loopback_fixture,
		allowLoopbackAddressFixture: routing.allow_insecure_loopback_fixture,
		allowedOrigins,
		endpoints,
		limits: routing.limits,
		resolver: createDnsResolver(),
	});
}

function deriveRendezvousCapabilities(config: DRPNodeConfig): readonly DrpCapability[] {
	const capabilities: DrpCapability[] = ["drp-gossipsub"];
	// Inspecting live transports instead of declarations is deferred to a future phase.
	const listenAddresses = config.network_config?.listen_addresses ?? ["/p2p-circuit", "/webrtc"];
	if (listenAddresses.some((address) => address.includes("/webrtc"))) capabilities.push("webrtc");
	// The production host installs circuitRelayTransport independently of whether
	// this node also opts into serving reservations.
	capabilities.push("relay-client");
	if (config.network_config?.relay_service?.enabled === true) capabilities.push("relay-hop-v2-service");
	return capabilities;
}

function registrationCredential(config: DRPNodeConfig): Parameters<RendezvousDirectory["register"]>[2] {
	const membership = config.network_config?.control_plane?.membership;
	return membership?.mode === "invite" ? { kind: "invite", token: membership.invite.inviteToken } : undefined;
}

function isAcceptedMembershipDecision(value: unknown): boolean {
	return typeof value === "object" && value !== null && "accepted" in value && value.accepted === true;
}

export {
	createDRPIntervalSync,
	DRPIntervalSync,
	type DRPIntervalSyncOptions,
	INITIAL_SYNC_RETRY_INTERVAL_MS,
} from "./interval-sync.js";
