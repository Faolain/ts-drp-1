import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";
import type { EphemeralChannel, EphemeralChannelOptions } from "@ts-drp/ephemeral";
import { DRP_MESSAGE_PROTOCOL } from "@ts-drp/network";
import { type DRPNetworkNode, Message, MessageType } from "@ts-drp/types";

import type { EphemeralAuthorizationProvider, NodeEphemeralAdapter } from "./ephemeral.js";

const HISTORY_TOPIC_DOMAIN = new TextEncoder().encode("ts-drp-room-history-request-v1\u0000");
const HISTORY_REQUEST = new TextEncoder().encode("ts-drp-room-history-request-v1");

interface RoomRegistration {
	closed: boolean;
	connect(): Promise<void>;
	readonly controlId: string;
	readonly creatorPeerId: string | undefined;
	ingress(message: Message): void;
	ingressId: string | undefined;
	publisher(targetPeerId?: string): Promise<void>;
	requestAttempt: Promise<void> | undefined;
	requestPending: boolean;
	readonly timers: Set<ReturnType<typeof setTimeout>>;
}

/** Protocol-neutral network port used by one durable room composition. */
export interface NodeRoomNetworkPort {
	readonly networkNode: DRPNetworkNode;
	close(): void;
	openEphemeral(provider: EphemeralAuthorizationProvider, options: EphemeralChannelOptions): EphemeralChannel;
	requestRetainedHistory(): void;
	setIngressHandler(
		ingressId: string,
		liveHandler: (message: Message) => void,
		retainedHandler: (message: Message) => void
	): void;
	setRetainedPublisher(publisher: (targetPeerId?: string) => Promise<void>): void;
}

/** Owns retained-history request routing without owning durable room semantics. */
export class NodeRoomNetworkAdapter {
	readonly #byControlId = new Map<string, RoomRegistration>();
	readonly #byIngressId = new Map<string, RoomRegistration>();
	readonly #byObjectId = new Map<string, RoomRegistration>();
	readonly #ephemeral: NodeEphemeralAdapter;
	readonly #networkNode: DRPNetworkNode;

	/**
	 * Create one room-network owner for one node.
	 * @param networkNode Authenticated network boundary.
	 * @param ephemeral Shared ephemeral-channel adapter.
	 */
	constructor(networkNode: DRPNetworkNode, ephemeral: NodeEphemeralAdapter) {
		this.#networkNode = networkNode;
		this.#ephemeral = ephemeral;
	}

	/** Close every active room transport owned by this node. */
	closeAll(): void {
		let failure: unknown;
		for (const objectId of [...this.#byObjectId.keys()]) {
			try {
				this.close(objectId);
			} catch (error) {
				failure ??= error;
			}
		}
		if (failure !== undefined) throw failure;
	}

	/**
	 * @param objectId Candidate durable identity.
	 * @returns Whether this node already has an active v3 room lifecycle for the identity.
	 */
	has(objectId: string): boolean {
		return this.#byObjectId.has(objectId);
	}

	/**
	 * Close one room transport.
	 * @param objectId Creator-bound room identity.
	 */
	close(objectId: string): void {
		const registration = this.#byObjectId.get(objectId);
		if (registration === undefined || registration.closed) return;
		registration.closed = true;
		for (const timer of registration.timers) clearTimeout(timer);
		registration.timers.clear();
		this.#byObjectId.delete(objectId);
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
		if (failure !== undefined) throw failure;
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
			closed: false,
			connect,
			controlId: historyControlId(objectId),
			creatorPeerId,
			ingress: () => undefined,
			ingressId: undefined,
			publisher: () => Promise.resolve(),
			requestAttempt: undefined,
			requestPending: false,
			timers: new Set(),
		};
		this.#byObjectId.set(objectId, registration);
		this.#byControlId.set(registration.controlId, registration);
		try {
			this.#networkNode.subscribe(registration.controlId);
		} catch (error) {
			this.#byObjectId.delete(objectId);
			this.#byControlId.delete(registration.controlId);
			throw error;
		}
		return Object.freeze({
			networkNode: this.#networkNode,
			close: (): void => {
				if (registration.closed) return;
				try {
					this.close(objectId);
				} finally {
					closeLifecycle();
				}
			},
			openEphemeral: (provider: EphemeralAuthorizationProvider, options: EphemeralChannelOptions): EphemeralChannel => {
				if (registration.closed) throw new Error("room network is closed");
				return this.#ephemeral.openAuthorized(objectId, provider, options);
			},
			requestRetainedHistory: (): void => this.#scheduleRequests(registration),
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
		if (!sameBytes(message.data, HISTORY_REQUEST)) return true;
		const gossipTopic = this.#networkNode.gossipTopicFor(message);
		if (gossipTopic === registration.controlId) {
			void registration.publisher().catch(() => undefined);
			return true;
		}
		if (gossipTopic !== undefined || !this.#networkNode.getAllPeers().includes(message.sender)) return true;
		void registration.publisher(message.sender).catch(() => undefined);
		return true;
	}

	#scheduleRequests(registration: RoomRegistration): void {
		// A joining browser may have a direct connection before gossipsub has installed
		// the remote topic subscription. Retrying the same idempotent retained request
		// spans that bounded propagation window and also repairs cold reconnects.
		for (const delay of [0, 500, 1_500, 3_000, 6_000, 10_000, 15_000]) {
			const timer = setTimeout(() => {
				registration.timers.delete(timer);
				void this.#request(registration);
			}, delay);
			registration.timers.add(timer);
		}
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
