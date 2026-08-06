import { type IACL } from "./acl.js";
import { type IDRP } from "./drp.js";
import { type FinalityConfig, type IFinalityStore } from "./finality.js";
import { type Hash } from "./hashgraph.js";
import { type LoggerOptions } from "./logger.js";
import { type IMetrics } from "./metrics.js";
import { type DRPObjectBase, type DRPState, type Vertex } from "./proto/drp/v1/object_pb.js";

export interface LowestCommonAncestorResult {
	lca: string;
	linearizedVertices: Vertex[];
}

export type ReplicaMode = "writer" | "observer";
export type HistoryStorage = "full" | "compact";

export interface HistoryInventory {
	readonly availablePayloadHashes: readonly Hash[];
	readonly knownHashes: readonly Hash[];
}

export type VertexPayloadResult =
	| { readonly status: "available"; readonly vertex: Vertex }
	| { readonly missingHashes: readonly Hash[]; readonly status: "history-unavailable" }
	| { readonly hash: Hash; readonly status: "unknown" };

export type HistoryReadResult =
	| { readonly status: "available"; readonly vertices: readonly Vertex[] }
	| { readonly missingHashes: readonly Hash[]; readonly status: "history-unavailable" }
	| { readonly status: "unknown"; readonly unknownHashes: readonly Hash[] };

export type HistoryRehydrationResult =
	| { readonly historyStorage: "full"; readonly status: "complete" }
	| {
			readonly reason: "incomplete" | "interrupted" | "invalid" | "wrong-history";
			readonly status: "rejected";
	  };

// snake_casing to match the JSON config
interface DRPObjectConfigBase {
	log_config?: LoggerOptions;
	finality_config?: FinalityConfig;
}

export type DRPObjectConfig = DRPObjectConfigBase &
	({ history_storage?: "full"; replica_mode?: ReplicaMode } | { history_storage: "compact"; replica_mode: "observer" });

export interface DRPObjectOptions<T extends IDRP> {
	peerId: string;
	acl?: IACL;
	drp?: T;
	id?: string;
	config?: DRPObjectConfig;
	metrics?: IMetrics;
}

export type MergeResult = [merged: boolean, missing: Hash[], invalid: Hash[]];

export interface ApplyResult {
	applied: boolean;
	missing: Hash[];
	invalid: Hash[];
	/**
	 * Vertices whose application failed for a possibly-transient reason.
	 * Omitted when empty to preserve the additive legacy return shape.
	 */
	quarantined?: Hash[];
}

export type DRPObjectCallback<T extends IDRP> = (object: IDRPObject<T>, origin: string, vertices: Vertex[]) => void;

export interface IDRPObject<T extends IDRP> extends DRPObjectBase {
	/**
	 * The id of the DRP object.
	 */
	readonly id: string;

	/**
	 * The storage/work profile used by this replica. Implementations predating
	 * observer mode may omit it and are treated as writers by consumers.
	 */
	readonly replicaMode?: ReplicaMode;

	/** The payload-retention capability exposed by this replica. */
	readonly historyStorage: HistoryStorage;

	/** Authenticated hash knowledge, separated from complete local payload availability. */
	readonly historyInventory: HistoryInventory;

	/**
	 * The ACL of the DRP object.
	 */
	acl: IACL;

	/**
	 * The DRP of the DRP object.
	 */
	drp?: T;

	/**
	 * The vertices of the DRP object.
	 */
	vertices: Vertex[];

	/**
	 * Gets the stored vertex for a hash.
	 * @param hash - The vertex hash.
	 * @returns The stored vertex reference, or undefined when the hash is absent.
	 */
	getVertex(hash: Hash): Vertex | undefined;

	/** Returns the current causal frontier without materializing full history. */
	getHistoryHeads(): Hash[];

	/** Reads the causal suffix from heads back to any supplied shared boundary. */
	readHistorySuffix(heads: readonly Hash[], boundaries: ReadonlySet<Hash>): HistoryReadResult;

	/** Reads one complete payload without manufacturing a partial vertex. */
	getVertexPayload(hash: Hash): VertexPayloadResult;

	/** Reads a complete history selection or returns one typed absence outcome. */
	readHistory(hashes: readonly Hash[]): HistoryReadResult;

	/** Atomically restores compact storage to the full-history observer capability. */
	rehydrateHistory(
		vertices: readonly Vertex[],
		options?: { readonly signal?: AbortSignal }
	): Promise<HistoryRehydrationResult>;

	/**
	 * The finality store of the DRP object.
	 */
	finalityStore: IFinalityStore;

	/**
	 * Get the drp state and the acl state for a given vertex hash.
	 * @param vertexHash - The hash of the vertex to get the state for.
	 * @returns The drp state and the acl state for the given vertex hash.
	 */
	getStates(vertexHash: string): [DRPState | undefined, DRPState | undefined];

	/**
	 * Get the stored ACL and DRP snapshots as detached wire bytes.
	 * @param vertexHash - The hash of the vertex to get the state for.
	 * @returns ACL-first encoded snapshots, with explicit absence for a missing or pruned cut.
	 */
	getSerializedStates(
		vertexHash: string
	): readonly [aclState: Uint8Array | undefined, drpState: Uint8Array | undefined];

	/**
	 * Set the acl state for a given vertex hash.
	 * @param vertexHash - The hash of the vertex to set the state for.
	 * @param aclState - The acl state to set for the given vertex hash.
	 */
	setACLState(vertexHash: string, aclState: DRPState): void;

	/**
	 * Set the drp state for a given vertex hash.
	 * @param vertexHash - The hash of the vertex to set the state for.
	 * @param drpState - The drp state to set for the given vertex hash.
	 */
	setDRPState(vertexHash: string, drpState: DRPState): void;

	/**
	 * Subscribe to the DRP object.
	 * @param callback - The callback to call when the DRP object changes.
	 */
	subscribe(callback: DRPObjectCallback<T>): void;

	/**
	 * Apply the vertices to the DRP object.
	 * @param vertices - The vertices to apply to the DRP object.
	 * @returns The result of the apply.
	 */
	applyVertices(vertices: Vertex[]): Promise<ApplyResult>;

	/**
	 * @deprecated Use applyVertices instead
	 * Merge the vertices into the DRP object.
	 * @param vertices - The vertices to merge into the DRP object.
	 * @returns The result of the merge.
	 */
	merge(vertices: Vertex[]): Promise<MergeResult>;
}

export interface ConnectObjectOptions<T extends IDRP> {
	peerId?: string;
	id?: string;
	drp?: T;
	metrics?: IMetrics;
	log_config?: LoggerOptions;
}

export interface CreateObjectOptions<T extends IDRP> extends ConnectObjectOptions<T> {
	peerId: string;
}
