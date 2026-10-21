import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { EphemeralChannel, EphemeralChannelOptions } from "@ts-drp/ephemeral";
import { SETTLEMENT_REPLACEMENT_DIGEST_LIMITS } from "@ts-drp/issuance-store";
import { DRP_MESSAGE_PROTOCOL } from "@ts-drp/network";
import { type DRPNetworkNode, Message, MessageType } from "@ts-drp/types";

import type { EphemeralAuthorizationProvider, NodeEphemeralAdapter } from "./ephemeral.js";

const HISTORY_TOPIC_DOMAIN = new TextEncoder().encode("ts-drp-room-history-request-v1\u0000");
const HISTORY_REQUEST = new TextEncoder().encode("ts-drp-room-history-request-v1");
// Retained transport schedules outlive the room's read-control call. Their own
// admission must remain finite until timers and entered retry work have joined.
const MAX_RETAINED_REQUEST_SCHEDULES = 32;
const RETAINED_REQUEST_DELAYS = [0, 500, 1_500, 3_000, 6_000, 10_000, 15_000] as const;
// A recipient that is missing a dependency (or has just installed a successor) asks the
// creator at once. Further asks within this interval collapse into one trailing ask, so a
// room has at most one such timer and one request in flight (`#request` coalesces).
const MISSING_HISTORY_REQUEST_INTERVAL_MS = 1_000;

/**
 * Read a creator routing hint without granting room or genesis authority.
 * @param objectId Opaque room identity supplied to transport routing.
 * @returns The prefix before the last separator, when present.
 */
export function creatorRoutingHint(objectId: string): string | undefined {
	const separatorIndex = objectId.lastIndexOf(":");
	return separatorIndex <= 0 ? undefined : objectId.slice(0, separatorIndex);
}
const SELECTION_REQUEST_PREFIX = new TextEncoder().encode("ts-drp-room-settlement-selection-request-v1\u0000");
const SELECTION_RESPONSE_PREFIX = new TextEncoder().encode("ts-drp-room-settlement-selection-response-v1\u0000");
const SELECTION_DOMAIN = "ts-drp/settlement-source-selection/v1";
const MAX_SELECTION_CONTROL_TASKS = 32;
const MAX_SELECTION_CONTROL_BYTES = 16 * 1024 * 1024;
const SELECTION_REQUEST_DEADLINE_MS = 10_000;
const SELECTION_BODY_LIMITS = Object.freeze({
	maxBytes: SETTLEMENT_REPLACEMENT_DIGEST_LIMITS.maxBytes + 512,
	maxDepth: 2,
	maxItems: 16,
});
const SELECTION_REQUEST_FIXED_BYTES =
	SELECTION_REQUEST_PREFIX.byteLength +
	encodeCanonical({
		requestId: "0".repeat(32),
		digest: new Uint8Array(32),
		exactCanonicalSelectionBytes: new Uint8Array(),
	}).byteLength +
	8;
const MAX_SELECTION_RESPONSE_BYTES =
	SELECTION_RESPONSE_PREFIX.byteLength +
	encodeCanonical({
		requestId: "0".repeat(32),
		digest: new Uint8Array(32),
		signature: new Uint8Array(64),
	}).byteLength;

/** Exact proposal bytes; neither this DTO nor authenticated transport grants approval. */
export interface NodeRoomSettlementSourceRequest {
	readonly exactCanonicalSelectionBytes: Uint8Array;
	readonly digest: Uint8Array;
}

/** Trusted policy delegates to the genuine current-target shared authorization owner. */
export type NodeRoomSettlementSourceAuthorizer = (
	request: NodeRoomSettlementSourceRequest & Readonly<{ authenticatedRequesterPeerId: string; signal: AbortSignal }>
) => Promise<Uint8Array>;

/** Current room-owned authorization and local installation, never remote convergence. */
export interface NodeRoomControlPlaneObservation {
	readonly objectId: string;
	readonly epoch: number;
	readonly anchorDigest: string;
	readonly aclDigest: string;
	readonly authenticatedPeerIds: readonly string[];
	readonly localState: "installed" | "transitioning";
}

/** Trusted local room composition supplies this observation from its verified current owners. */
export type NodeRoomControlPlaneObservationProvider = () => NodeRoomControlPlaneObservation | undefined;

interface PendingSelectionRequest {
	readonly registration: RoomRegistration;
	readonly digest: Uint8Array;
	readonly controller: AbortController;
	resolve(signature: Uint8Array): void;
	reject(error: Error): void;
}

interface RoomRegistration {
	readonly objectId: string;
	controlPlaneObservationProvider: NodeRoomControlPlaneObservationProvider | undefined;
	closed: boolean;
	closePromise: Promise<void> | undefined;
	closeLifecycle(): void;
	connect(): Promise<void>;
	readonly controlId: string;
	readonly creatorPeerId: string | undefined;
	ingress(message: Message): void;
	ingressId: string | undefined;
	missingRequestDue: boolean;
	missingRequestTimer: ReturnType<typeof setTimeout> | undefined;
	publisher(targetPeerId?: string): Promise<void>;
	requestAttempt: Promise<void> | undefined;
	requestPending: boolean;
	retainedRequestSchedules: number;
	readonly timers: Set<ReturnType<typeof setTimeout>>;
	selectionAuthorizer: NodeRoomSettlementSourceAuthorizer | undefined;
	readonly selectionControllers: Set<AbortController>;
	readonly selectionJobs: Set<Promise<void>>;
	selectionReceiveTail: Promise<void>;
	selectionSendTail: Promise<void>;
	unsubscribePeerConnections(): void;
}

/** Protocol-neutral network port used by one durable room composition. */
export interface NodeRoomNetworkPort {
	readonly networkNode: DRPNetworkNode;
	close(): Promise<void>;
	openEphemeral(provider: EphemeralAuthorizationProvider, options: EphemeralChannelOptions): EphemeralChannel;
	requestRetainedHistory(): void;
	/**
	 * Ask the creator for its retained history now, rate limited; a no-op on the creator and
	 * after close. For a dependency that is missing, never on a schedule that can run out.
	 */
	requestMissingRetainedHistory(): void;
	setIngressHandler(
		ingressId: string,
		liveHandler: (message: Message) => void,
		retainedHandler: (message: Message) => void
	): void;
	setRetainedPublisher(publisher: (targetPeerId?: string) => Promise<void>): void;
	requestSettlementSourceAuthorization(
		request: NodeRoomSettlementSourceRequest,
		options?: Readonly<{ signal?: AbortSignal }>
	): Promise<Uint8Array>;
	setSettlementSourceAuthorizer(authorizer: NodeRoomSettlementSourceAuthorizer): void;
	setControlPlaneObservationProvider(provider: NodeRoomControlPlaneObservationProvider): void;
}

/** Owns retained-history request routing without owning durable room semantics. */
export class NodeRoomNetworkAdapter {
	readonly #byControlId = new Map<string, RoomRegistration>();
	readonly #byIngressId = new Map<string, RoomRegistration>();
	readonly #byObjectId = new Map<string, RoomRegistration>();
	readonly #ephemeral: NodeEphemeralAdapter;
	readonly #networkNode: DRPNetworkNode;
	readonly #pendingSelections = new Map<string, PendingSelectionRequest>();
	#selectionTasks = 0;
	#selectionBytes = 0;

	/**
	 * Create one room-network owner for one node.
	 * @param networkNode Authenticated network boundary.
	 * @param ephemeral Shared ephemeral-channel adapter.
	 */
	constructor(networkNode: DRPNetworkNode, ephemeral: NodeEphemeralAdapter) {
		this.#networkNode = networkNode;
		this.#ephemeral = ephemeral;
	}

	/**
	 * Close every active room transport owned by this node.
	 * @returns Joined shutdown of all admitted control work.
	 */
	closeAll(): Promise<void> {
		// Each close revokes synchronously before this method yields to any join.
		const joins = [...this.#byObjectId.keys()].map((objectId) => this.close(objectId));
		return Promise.allSettled(joins).then((results) => {
			const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (failures.length > 0) throw new AggregateError(failures, "room network shutdown failed");
		});
	}

	/**
	 * @param objectId Candidate durable identity.
	 * @returns Whether this node already has an active v3 room lifecycle for the identity.
	 */
	has(objectId: string): boolean {
		return this.#byObjectId.has(objectId);
	}

	/**
	 * Read detached active identities for lifecycle bookkeeping, not authorization.
	 * @returns The currently registered durable identities in registration order.
	 */
	activeObjectIds(): readonly string[] {
		return Object.freeze([...this.#byObjectId.keys()]);
	}

	/**
	 * Read detached current room observations; transport presence is not authority.
	 * @returns Valid observations from live registered room owners only.
	 */
	readControlPlaneObservations(): readonly NodeRoomControlPlaneObservation[] {
		const observations: NodeRoomControlPlaneObservation[] = [];
		for (const registration of this.#byObjectId.values()) {
			if (registration.closed || registration.controlPlaneObservationProvider === undefined) continue;
			try {
				const value = registration.controlPlaneObservationProvider();
				if (
					registration.closed ||
					this.#byObjectId.get(registration.objectId) !== registration ||
					value === undefined ||
					value.objectId !== registration.objectId ||
					!Number.isSafeInteger(value.epoch) ||
					value.epoch < 0 ||
					!/^[0-9a-f]{64}$/u.test(value.anchorDigest) ||
					!/^[0-9a-f]{64}$/u.test(value.aclDigest) ||
					(value.localState !== "installed" && value.localState !== "transitioning") ||
					!Array.isArray(value.authenticatedPeerIds) ||
					value.authenticatedPeerIds.some((peerId) => typeof peerId !== "string" || peerId.length === 0) ||
					new Set(value.authenticatedPeerIds).size !== value.authenticatedPeerIds.length
				)
					continue;
				observations.push(
					Object.freeze({
						objectId: value.objectId,
						epoch: value.epoch,
						anchorDigest: value.anchorDigest,
						aclDigest: value.aclDigest,
						localState: value.localState,
						authenticatedPeerIds: Object.freeze([...value.authenticatedPeerIds].sort()),
					})
				);
			} catch {
				// A failed current owner supplies neither authorization nor readiness.
			}
		}
		return Object.freeze(observations);
	}

	/**
	 * Close one room transport.
	 * @param objectId Creator-bound room identity.
	 * @returns Joined shutdown of this exact room registration.
	 */
	close(objectId: string): Promise<void> {
		const registration = this.#byObjectId.get(objectId);
		if (registration === undefined) return Promise.resolve();
		if (registration.closePromise !== undefined) return registration.closePromise;
		let resolveClose!: () => void;
		let rejectClose!: (error: unknown) => void;
		registration.closePromise = new Promise<void>((resolve, reject) => {
			resolveClose = resolve;
			rejectClose = reject;
		});
		registration.closed = true;
		registration.controlPlaneObservationProvider = undefined;
		for (const controller of registration.selectionControllers) controller.abort(new Error("room network is closed"));
		registration.unsubscribePeerConnections();
		for (const timer of registration.timers) clearTimeout(timer);
		registration.timers.clear();
		registration.retainedRequestSchedules = 0;
		registration.missingRequestTimer = undefined;
		registration.missingRequestDue = false;
		this.#byControlId.delete(registration.controlId);
		if (registration.ingressId !== undefined) this.#byIngressId.delete(registration.ingressId);
		let failure: unknown;
		try {
			this.#networkNode.unsubscribe(registration.controlId);
		} catch (error) {
			failure = error;
		}
		try {
			this.#ephemeral.close(objectId);
		} catch (error) {
			failure ??= error;
		}
		try {
			registration.closeLifecycle();
		} catch (error) {
			failure ??= error;
		}
		void Promise.allSettled([...registration.selectionJobs]).then(() => {
			if (this.#byObjectId.get(objectId) === registration) this.#byObjectId.delete(objectId);
			if (failure !== undefined) rejectClose(failure);
			else resolveClose();
		});
		return registration.closePromise;
	}

	/**
	 * Open one protocol-neutral room transport.
	 * @param objectId Creator-bound room identity.
	 * @param creatorPeerId Creator transport identity when known.
	 * @param connect Bounded creator connection action.
	 * @param closeLifecycle Room rendezvous cleanup action.
	 * @returns The retained-history, v3 ingress, and E1 transport port.
	 */
	open(
		objectId: string,
		creatorPeerId: string | undefined,
		connect: () => Promise<void>,
		closeLifecycle: () => void
	): NodeRoomNetworkPort {
		if (objectId.length === 0) throw new TypeError("room network object id is invalid");
		if (this.#byObjectId.has(objectId)) throw new Error("room network is already active");
		const registration: RoomRegistration = {
			objectId,
			controlPlaneObservationProvider: undefined,
			closed: false,
			closePromise: undefined,
			closeLifecycle,
			connect,
			controlId: historyControlId(objectId),
			creatorPeerId,
			ingress: () => undefined,
			ingressId: undefined,
			missingRequestDue: false,
			missingRequestTimer: undefined,
			publisher: () => Promise.resolve(),
			requestAttempt: undefined,
			requestPending: false,
			retainedRequestSchedules: 0,
			timers: new Set(),
			selectionAuthorizer: undefined,
			selectionControllers: new Set(),
			selectionJobs: new Set(),
			selectionReceiveTail: Promise.resolve(),
			selectionSendTail: Promise.resolve(),
			unsubscribePeerConnections: () => undefined,
		};
		this.#byObjectId.set(objectId, registration);
		this.#byControlId.set(registration.controlId, registration);
		try {
			this.#networkNode.subscribe(registration.controlId);
			const subscribePeerConnections = this.#networkNode.subscribeToPeerConnections;
			if (typeof subscribePeerConnections === "function") {
				registration.unsubscribePeerConnections = subscribePeerConnections.call(this.#networkNode, () => {
					void this.#request(registration);
				});
			}
		} catch (error) {
			registration.unsubscribePeerConnections();
			this.#byObjectId.delete(objectId);
			this.#byControlId.delete(registration.controlId);
			throw error;
		}
		return Object.freeze({
			networkNode: this.#networkNode,
			close: (): Promise<void> => registration.closePromise ?? this.close(objectId),
			openEphemeral: (provider: EphemeralAuthorizationProvider, options: EphemeralChannelOptions): EphemeralChannel => {
				if (registration.closed) throw new Error("room network is closed");
				return this.#ephemeral.openAuthorized(objectId, provider, options);
			},
			requestRetainedHistory: (): void => this.#scheduleRequests(registration),
			requestMissingRetainedHistory: (): void => this.#requestMissing(registration),
			setIngressHandler: (
				ingressId: string,
				_liveHandler: (message: Message) => void,
				retainedHandler: (message: Message) => void
			): void => {
				if (registration.closed) throw new Error("room network is closed");
				if (ingressId.length === 0 || this.#byIngressId.has(ingressId)) {
					throw new Error("room network ingress identity is unavailable");
				}
				registration.ingress = retainedHandler;
				registration.ingressId = ingressId;
				this.#byIngressId.set(ingressId, registration);
			},
			setRetainedPublisher: (publisher: (targetPeerId?: string) => Promise<void>): void => {
				if (registration.closed) throw new Error("room network is closed");
				registration.publisher = publisher;
			},
			requestSettlementSourceAuthorization: (
				request: NodeRoomSettlementSourceRequest,
				options: Readonly<{ signal?: AbortSignal }> = {}
			): Promise<Uint8Array> => this.#requestSelection(registration, request, options.signal),
			setSettlementSourceAuthorizer: (authorizer: NodeRoomSettlementSourceAuthorizer): void => {
				if (registration.closed) throw new Error("room network is closed");
				if (typeof authorizer !== "function") throw new TypeError("room selection authorizer is invalid");
				if (registration.selectionAuthorizer !== undefined && registration.selectionAuthorizer !== authorizer)
					throw new TypeError("room selection authorizer already has a different owner");
				registration.selectionAuthorizer = authorizer;
			},
			setControlPlaneObservationProvider: (provider: NodeRoomControlPlaneObservationProvider): void => {
				if (registration.closed) throw new Error("room network is closed");
				if (typeof provider !== "function") throw new TypeError("room control-plane provider is invalid");
				if (
					registration.controlPlaneObservationProvider !== undefined &&
					registration.controlPlaneObservationProvider !== provider
				)
					throw new TypeError("room control-plane provider already has a different owner");
				registration.controlPlaneObservationProvider = provider;
			},
		});
	}

	/**
	 * Route one authenticated network message to its room owner.
	 * @param message Network message received by the node.
	 * @returns Whether a room transport consumed the message.
	 */
	route(message: Message): boolean {
		if (message.type === MessageType.MESSAGE_TYPE_V3_ENVELOPE) {
			const registration = this.#byIngressId.get(message.objectId);
			if (registration === undefined || registration.closed) return false;
			if (this.#networkNode.gossipTopicFor(message) !== undefined) return false;
			const evidence = this.#networkNode.claimIngressEvidence?.(message);
			if (
				evidence === undefined ||
				evidence.transport.kind !== "authenticated-stream" ||
				evidence.transport.protocol !== DRP_MESSAGE_PROTOCOL ||
				evidence.transport.sender !== evidence.message.sender ||
				evidence.message.type !== MessageType.MESSAGE_TYPE_V3_ENVELOPE ||
				evidence.message.objectId !== registration.ingressId
			) {
				return true;
			}
			registration.ingress(
				Message.create({
					data: evidence.message.data.slice(),
					objectId: evidence.message.objectId,
					sender: evidence.message.sender,
					type: evidence.message.type,
				})
			);
			return true;
		}
		if (message.type !== MessageType.MESSAGE_TYPE_CUSTOM) return false;
		const registration = this.#byControlId.get(message.objectId);
		if (registration === undefined || registration.closed) return false;
		if (!sameBytes(message.data, HISTORY_REQUEST)) return this.#routeSelection(registration, message);
		const gossipTopic = this.#networkNode.gossipTopicFor(message);
		if (gossipTopic === registration.controlId) {
			void registration.publisher().catch(() => undefined);
			return true;
		}
		if (gossipTopic !== undefined || !this.#networkNode.getAllPeers().includes(message.sender)) return true;
		void registration.publisher(message.sender).catch(() => undefined);
		return true;
	}

	#reserveSelection(registration: RoomRegistration, dataBytes: number, peerId: string): () => void {
		if (registration.closed || this.#byObjectId.get(registration.objectId) !== registration)
			throw new TypeError("room network is closed");
		const bytes =
			2 * (dataBytes + MAX_SELECTION_RESPONSE_BYTES) +
			new TextEncoder().encode(registration.controlId + peerId + (registration.creatorPeerId ?? "")).byteLength;
		if (
			this.#selectionTasks >= MAX_SELECTION_CONTROL_TASKS ||
			bytes > MAX_SELECTION_CONTROL_BYTES - this.#selectionBytes
		)
			throw new TypeError("room selection admission capacity exhausted; retry after admitted work joins");
		this.#selectionTasks++;
		this.#selectionBytes += bytes;
		let held = true;
		return (): void => {
			if (!held) return;
			held = false;
			this.#selectionTasks--;
			this.#selectionBytes -= bytes;
		};
	}

	#trackSelection(registration: RoomRegistration, work: Promise<unknown>, release: () => void): void {
		const joined = work
			.then(
				() => undefined,
				() => undefined
			)
			.finally(() => {
				release();
				registration.selectionJobs.delete(joined);
			});
		registration.selectionJobs.add(joined);
	}

	#requestSelection(
		registration: RoomRegistration,
		request: NodeRoomSettlementSourceRequest,
		signal?: AbortSignal
	): Promise<Uint8Array> {
		try {
			signal?.throwIfAborted();
			const selection = request.exactCanonicalSelectionBytes,
				digest = request.digest;
			if (
				!(selection instanceof Uint8Array) ||
				selection.byteLength === 0 ||
				selection.byteLength > SETTLEMENT_REPLACEMENT_DIGEST_LIMITS.maxBytes ||
				!(digest instanceof Uint8Array) ||
				digest.byteLength !== 32
			)
				throw new TypeError("room creator selection request is malformed");
			const creatorPeerId = registration.creatorPeerId;
			if (creatorPeerId === undefined || creatorPeerId === this.#networkNode.peerId)
				throw new TypeError("room remote creator approval is unavailable");
			// Reserve the complete detached proposal/response custody before copying,
			// hashing, timers, payload factories, dialing or admitted async work.
			const release = this.#reserveSelection(
				registration,
				selection.byteLength + SELECTION_REQUEST_FIXED_BYTES,
				creatorPeerId
			);
			let owned = false;
			try {
				const exactCanonicalSelectionBytes = selection.slice(),
					expectedDigest = digest.slice();
				if (!sameBytes(hashDomain(SELECTION_DOMAIN, exactCanonicalSelectionBytes), expectedDigest))
					throw new TypeError("room creator selection digest differs from exact bytes");
				const requestId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
				if (this.#pendingSelections.has(requestId))
					throw new TypeError("room creator selection request identity conflicts");
				const data = concatBytes(
					SELECTION_REQUEST_PREFIX,
					encodeCanonical({ requestId, digest: expectedDigest, exactCanonicalSelectionBytes }, SELECTION_BODY_LIMITS)
				);
				if (data.byteLength > selection.byteLength + SELECTION_REQUEST_FIXED_BYTES)
					throw new TypeError("room creator selection frame accounting differs");
				const controller = new AbortController();
				registration.selectionControllers.add(controller);
				const cancel = (): void => controller.abort(signal?.reason ?? new Error("room creator approval was cancelled"));
				const deadline = setTimeout(
					() => controller.abort(new Error("room creator approval deadline elapsed")),
					SELECTION_REQUEST_DEADLINE_MS
				);
				registration.timers.add(deadline);
				let resolveResponse!: (signature: Uint8Array) => void, rejectResponse!: (error: Error) => void;
				const response = new Promise<Uint8Array>((resolve, reject) => {
					resolveResponse = resolve;
					rejectResponse = reject;
				});
				// Cancellation can precede completion of its admitted native send.
				void response.catch(() => undefined);
				const pending: PendingSelectionRequest = {
					registration,
					digest: expectedDigest,
					controller,
					resolve: (signature): void => {
						this.#pendingSelections.delete(requestId);
						resolveResponse(signature);
					},
					reject: (error): void => {
						this.#pendingSelections.delete(requestId);
						rejectResponse(error);
					},
				};
				this.#pendingSelections.set(requestId, pending);
				const unavailable = (): void =>
					pending.reject(
						new TypeError("room creator approval unavailable; protected work remains recoverable", {
							cause: controller.signal.reason,
						})
					);
				controller.signal.addEventListener("abort", unavailable, { once: true });
				signal?.addEventListener("abort", cancel, { once: true });
				if (signal?.aborted) cancel();
				const message = Message.create({
					data,
					objectId: registration.controlId,
					sender: this.#networkNode.peerId,
					type: MessageType.MESSAGE_TYPE_CUSTOM,
				});
				const send = registration.selectionSendTail.then(async () => {
					if (registration.closed) throw new TypeError("room network is closed");
					controller.signal.throwIfAborted();
					await this.#networkNode.sendMessage(creatorPeerId, message, { signal: controller.signal });
				});
				registration.selectionSendTail = send.then(
					() => undefined,
					() => undefined
				);
				void send.catch((cause: unknown) =>
					pending.reject(
						new TypeError("room creator approval unavailable; protected work remains recoverable", { cause })
					)
				);
				const result = response.then((signature) => {
					if (registration.closed || this.#byObjectId.get(registration.objectId) !== registration)
						throw new TypeError("room network closed before creator approval delivery");
					controller.signal.throwIfAborted();
					return signature;
				});
				// Delivery can fail its deadline before entered native dial/write work
				// ends. Keep its charge and close join until both lifetimes settle.
				const lifetime = Promise.allSettled([send, result]).then(() => {
					clearTimeout(deadline);
					registration.timers.delete(deadline);
					signal?.removeEventListener("abort", cancel);
					controller.signal.removeEventListener("abort", unavailable);
					registration.selectionControllers.delete(controller);
					if (this.#pendingSelections.get(requestId) === pending) this.#pendingSelections.delete(requestId);
				});
				this.#trackSelection(registration, lifetime, release);
				owned = true;
				return result;
			} finally {
				if (!owned) release();
			}
		} catch (error) {
			return Promise.reject(error);
		}
	}

	#routeSelection(registration: RoomRegistration, message: Message): boolean {
		const request = startsWithBytes(message.data, SELECTION_REQUEST_PREFIX),
			response = startsWithBytes(message.data, SELECTION_RESPONSE_PREFIX);
		if (!request && !response) return true;
		const evidence = this.#networkNode.claimIngressEvidence?.(message);
		if (
			evidence === undefined ||
			evidence.transport.kind !== "authenticated-stream" ||
			evidence.transport.protocol !== DRP_MESSAGE_PROTOCOL ||
			evidence.transport.sender !== evidence.message.sender ||
			evidence.message.type !== MessageType.MESSAGE_TYPE_CUSTOM ||
			evidence.message.objectId !== registration.controlId
		)
			return true;
		if (response) {
			if (
				evidence.message.sender !== registration.creatorPeerId ||
				evidence.message.data.byteLength > MAX_SELECTION_RESPONSE_BYTES
			)
				return true;
			let value: Record<string, unknown>;
			try {
				value = selectionBody(evidence.message.data.subarray(SELECTION_RESPONSE_PREFIX.byteLength), [
					"requestId",
					"digest",
					"signature",
				]);
			} catch {
				return true;
			}
			const pending = this.#pendingSelections.get(value.requestId as string);
			if (
				pending?.registration !== registration ||
				pending.controller.signal.aborted ||
				!sameBytes(pending.digest, value.digest as Uint8Array)
			)
				return true;
			if (!(value.signature instanceof Uint8Array) || value.signature.byteLength !== 64) {
				pending.reject(new TypeError("room creator approval was refused or malformed"));
				return true;
			}
			pending.resolve(value.signature);
			return true;
		}
		if (
			registration.creatorPeerId !== this.#networkNode.peerId ||
			evidence.message.data.byteLength > SELECTION_BODY_LIMITS.maxBytes + SELECTION_REQUEST_PREFIX.byteLength
		)
			return true;
		// There is no unbounded out-of-admission refusal queue. A full receiver
		// invokes no policy and retains no work; requester fails its finite deadline.
		const release = this.#reserveSelection(registration, evidence.message.data.byteLength, evidence.message.sender);
		let owned = false;
		try {
			const value = selectionBody(evidence.message.data.subarray(SELECTION_REQUEST_PREFIX.byteLength), [
				"requestId",
				"digest",
				"exactCanonicalSelectionBytes",
			]);
			if (
				!(value.exactCanonicalSelectionBytes instanceof Uint8Array) ||
				value.exactCanonicalSelectionBytes.byteLength === 0 ||
				value.exactCanonicalSelectionBytes.byteLength > SETTLEMENT_REPLACEMENT_DIGEST_LIMITS.maxBytes ||
				!sameBytes(hashDomain(SELECTION_DOMAIN, value.exactCanonicalSelectionBytes), value.digest as Uint8Array)
			)
				throw new TypeError("room creator selection request differs from exact bytes");
			const controller = new AbortController();
			registration.selectionControllers.add(controller);
			const authorizer = registration.selectionAuthorizer,
				requestId = value.requestId as string,
				digest = value.digest as Uint8Array;
			const callbackRequest = Object.freeze({
				exactCanonicalSelectionBytes: value.exactCanonicalSelectionBytes,
				digest: digest.slice(),
				authenticatedRequesterPeerId: evidence.message.sender,
				signal: controller.signal,
			});
			const work = registration.selectionReceiveTail
				.then(async () => {
					if (registration.closed || controller.signal.aborted) return;
					let signature: Uint8Array | null = null;
					try {
						if (authorizer !== undefined) {
							const selected = await authorizer(callbackRequest);
							if (selected instanceof Uint8Array && selected.byteLength === 64) signature = selected.slice();
						}
					} catch {
						/* Refusal is not a transport or application acceptance. */
					}
					if (registration.closed || controller.signal.aborted) return;
					const data = concatBytes(
						SELECTION_RESPONSE_PREFIX,
						encodeCanonical({ requestId, digest, signature }, SELECTION_BODY_LIMITS)
					);
					await this.#networkNode.sendMessage(
						evidence.message.sender,
						Message.create({
							data,
							objectId: registration.controlId,
							sender: this.#networkNode.peerId,
							type: MessageType.MESSAGE_TYPE_CUSTOM,
						}),
						{ signal: controller.signal }
					);
				})
				.finally(() => {
					registration.selectionControllers.delete(controller);
				});
			registration.selectionReceiveTail = work.then(
				() => undefined,
				() => undefined
			);
			this.#trackSelection(registration, work, release);
			owned = true;
			return true;
		} finally {
			if (!owned) release();
		}
	}

	#scheduleRequests(registration: RoomRegistration): void {
		if (registration.closed) throw new Error("room network is closed");
		if (registration.retainedRequestSchedules >= MAX_RETAINED_REQUEST_SCHEDULES)
			throw new Error("room retained request schedule capacity exhausted; retry after admitted work joins");
		registration.retainedRequestSchedules++;
		let remaining = RETAINED_REQUEST_DELAYS.length;
		// A joining browser may have a direct connection before gossipsub has installed
		// the remote topic subscription. Retrying the same idempotent retained request
		// spans that bounded propagation window and also repairs cold reconnects.
		for (const delay of RETAINED_REQUEST_DELAYS) {
			const timer = setTimeout(() => {
				registration.timers.delete(timer);
				void this.#request(registration)
					.finally(() => {
						remaining--;
						if (remaining === 0 && !registration.closed) registration.retainedRequestSchedules--;
					})
					.catch(() => undefined);
			}, delay);
			registration.timers.add(timer);
		}
	}

	#requestMissing(registration: RoomRegistration): void {
		if (registration.closed) return;
		const creatorPeerId = registration.creatorPeerId;
		// The creator's journal is the retained authority for its epoch; it has no one to ask.
		if (creatorPeerId === undefined || creatorPeerId === this.#networkNode.peerId) return;
		if (registration.missingRequestTimer !== undefined) {
			registration.missingRequestDue = true;
			return;
		}
		void this.#request(registration).catch(() => undefined);
		const timer = setTimeout(() => {
			registration.timers.delete(timer);
			registration.missingRequestTimer = undefined;
			if (!registration.missingRequestDue || registration.closed) return;
			registration.missingRequestDue = false;
			this.#requestMissing(registration);
		}, MISSING_HISTORY_REQUEST_INTERVAL_MS);
		registration.timers.add(timer);
		registration.missingRequestTimer = timer;
	}

	#request(registration: RoomRegistration): Promise<void> {
		if (registration.closed) return Promise.resolve();
		if (registration.requestAttempt !== undefined) {
			registration.requestPending = true;
			return registration.requestAttempt;
		}
		const attempt = this.#performRequest(registration).finally(() => {
			if (registration.requestAttempt !== attempt) return;
			registration.requestAttempt = undefined;
			if (registration.requestPending && !registration.closed) {
				registration.requestPending = false;
				void this.#request(registration);
			}
		});
		registration.requestAttempt = attempt;
		return attempt;
	}

	async #performRequest(registration: RoomRegistration): Promise<void> {
		if (registration.closed) return;
		await registration.connect().catch(() => undefined);
		if (registration.closed) return;
		const message = Message.create({
			data: HISTORY_REQUEST.slice(),
			objectId: registration.controlId,
			sender: this.#networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_CUSTOM,
		});
		const creatorPeerId = registration.creatorPeerId;
		if (creatorPeerId === undefined || creatorPeerId === this.#networkNode.peerId) {
			await registration.publisher().catch(() => undefined);
			return;
		}
		await Promise.allSettled([
			registration.publisher(creatorPeerId),
			this.#networkNode.sendMessage(creatorPeerId, message),
		]);
	}
}

function historyControlId(objectId: string): string {
	return `/ts-drp/room-history/1/${bytesToHex(sha256(concatBytes(HISTORY_TOPIC_DOMAIN, new TextEncoder().encode(objectId))))}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
	return bytes.byteLength >= prefix.byteLength && prefix.every((byte, index) => bytes[index] === byte);
}

function selectionBody(bytes: Uint8Array, keys: readonly string[]): Record<string, unknown> {
	const value = decodeCanonical(bytes, SELECTION_BODY_LIMITS);
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value instanceof Uint8Array ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new TypeError("room creator selection control shape is invalid");
	const result = value as Record<string, unknown>;
	if (
		typeof result.requestId !== "string" ||
		!/^[0-9a-f]{32}$/.test(result.requestId) ||
		!(result.digest instanceof Uint8Array) ||
		result.digest.byteLength !== 32
	)
		throw new TypeError("room creator selection control identity is invalid");
	return result;
}
