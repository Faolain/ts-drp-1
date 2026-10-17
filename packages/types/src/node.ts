import { type PeerId, type TypedEventTarget } from "@libp2p/interface";

import { type DRPIntervalReconnectOptions } from "./drp-interval-reconnect.js";
import { type FetchState, type FetchStateResponse, type NodeEventName, type Update, type Vertex } from "./index.js";
import { type KeychainOptions } from "./keychain.js";
import { type LoggerOptions } from "./logger.js";
import { type DRPNetworkNode, type DRPNetworkNodeConfig } from "./network.js";

export interface DRPNodeConfig {
	log_config?: LoggerOptions;
	network_config?: DRPNetworkNodeConfig;
	keychain_config?: KeychainOptions;
	interval_reconnect_options?: Omit<DRPIntervalReconnectOptions, "id" | "networkNode">;
}

export interface PeerInfo {
	/**
	 * The identifier of the remote peer
	 */
	id: PeerId;
}

export interface ObjectId {
	/**
	 * The identifier of the object
	 */
	id: string;
}

export interface SyncRejectedEvent extends ObjectId {
	/** The peer involved in the exhausted recovery episode */
	peerId: string;

	/** Number of recovery retries attempted before giving up */
	retries: number;
}

export interface FetchStateEvent extends ObjectId {
	/**
	 * The identifier of the remote peer
	 */
	fetchState: FetchState;
}

export interface FetchStateResponseEvent extends ObjectId {
	/**
	 * FetchStateResponse
	 */
	fetchStateResponse: FetchStateResponse;
}

export interface RequestSyncEvent extends ObjectId {
	/**
	 * Requested vertices
	 */
	requested: Vertex[];

	/**
	 * Requesting hash
	 */
	requesting: string[];
}

export interface UpdateObjectEvent extends ObjectId {
	/**
	 * Updated vertices
	 */
	update: Update;
}

export interface NodeEvents {
	/**
	 * Emitted when a peer receives an fetch message
	 */
	[NodeEventName.DRP_FETCH_STATE]: CustomEvent<FetchStateEvent>;

	/**
	 * Emitted when a peer responds to a fetch message
	 */
	[NodeEventName.DRP_FETCH_STATE_RESPONSE]: CustomEvent<FetchStateResponseEvent>;

	/**
	 * Emitted when a peer receives an update message
	 */
	[NodeEventName.DRP_UPDATE]: CustomEvent<UpdateObjectEvent>;

	/**
	 * Emitted when a peer receives a sync message
	 */
	[NodeEventName.DRP_SYNC]: CustomEvent<RequestSyncEvent>;

	/**
	 * Emitted when a peer receives a sync message with missing objects
	 */
	[NodeEventName.DRP_SYNC_MISSING]: CustomEvent<RequestSyncEvent>;

	/**
	 * Emitted after a sync accept merges at least one vertex with no dependencies left missing
	 */
	[NodeEventName.DRP_SYNC_ACCEPTED]: CustomEvent<ObjectId>;

	/**
	 * Emitted when a peer rejects sync or local missing-dependency recovery exhausts its retry budget
	 */
	[NodeEventName.DRP_SYNC_REJECTED]: CustomEvent<SyncRejectedEvent>;

	/**
	 * Emitted when a peer receives an update attestation message
	 */
	[NodeEventName.DRP_ATTESTATION_UPDATE]: CustomEvent<ObjectId>;
}

export interface IDRPNode extends TypedEventTarget<NodeEvents> {
	/**
	 * The configuration of the node
	 */
	config: DRPNodeConfig;

	/**
	 * The network node
	 */
	networkNode: DRPNetworkNode;

	/**
	 * Start the node
	 */
	start(): Promise<void>;

	/**
	 * Stop the node
	 */
	stop(): Promise<void>;

	/**
	 * Restart the node
	 * @param config
	 */
	restart(config?: DRPNodeConfig): Promise<void>;

	/** Subscribe to a transport-only custom group. */
	addCustomGroup(group: string): void;

	/** Send custom bytes with honest local transport completion. */
	sendGroupMessage(group: string, data: Uint8Array): Promise<void>;

	/** Send custom bytes to one transport peer. */
	sendCustomMessage(peerId: string, data: Uint8Array): Promise<void>;
}
