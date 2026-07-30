/** A vertex in one active hard epoch. */
export interface EpochVertex {
	anchor?: string;
	dependencies: string[];
	epoch: number;
	hash: string;
	kind: "drp-epoch-anchor" | "drp-vertex";
	objectId: string;
	operation?: {
		conflictKey?: string;
		value?: unknown;
	};
}

/** Optional bounds for one append-only active-epoch causality index. */
export interface CausalityIndexOptions {
	readonly maxEpochVertices?: number | undefined;
}

/** A non-terminal refusal produced when an active-epoch index is full. */
export interface EpochFullOutcome {
	readonly code: "EPOCH_FULL";
	readonly latchByHash: false;
	readonly status: "pending";
}

/** The frozen conflict actions for protocol v2. */
export type ConflictAction = "Nop" | "DropLeft" | "DropRight" | "Swap" | "Drop";

/** A strictly validated conflict-policy result. */
export interface ConflictResult {
	action: ConflictAction;
	vertices?: string[];
}

/** Options for deterministic active-epoch linearization. */
export interface LinearizeOptions {
	anchorHash: string;
	maxPasses?: number;
	mode?: "none" | "pair" | "multiple";
	resolveConflicts?(vertices: readonly EpochVertex[], context: Readonly<Record<string, unknown>>): ConflictResult;
	vertices: ReadonlyMap<string, EpochVertex>;
}

/** Cooperative batching controls for Merkle work. */
export interface BatchOptions {
	batchSize?: number;
	yieldTask?(): void | Promise<void>;
}

/** An immutable-by-convention RFC 9162 Merkle tree view. */
export interface MerkleTree {
	hashRange(start: number, length: number): Uint8Array;
	inputs: readonly Uint8Array[];
	leafHashes: readonly Uint8Array[];
	root: Uint8Array;
	size: number;
}

/** An RFC 9162 inclusion proof. */
export interface InclusionProof {
	auditPath: Uint8Array[];
	leafIndex: number;
	treeSize: number;
}

/** An RFC 9162 consistency proof. */
export interface ConsistencyProof {
	firstSize: number;
	path: Uint8Array[];
	secondSize: number;
}

/** Serializable compact-Merkle accumulator state. */
export interface AccumulatorSnapshot {
	peaks: Array<Uint8Array | null>;
	size: number;
}
