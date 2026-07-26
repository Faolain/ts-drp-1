import { type DRPState, type IACL, type IDRP, type LowestCommonAncestorResult, type Vertex } from "@ts-drp/types";

export interface ReplayState {
	drpState: DRPState;
	aclState: DRPState;
}

export interface OperationJournal {
	/**
	 * Records an inverse mutation to run if the enclosing batch fails.
	 * @param undo - Identity-checked inverse mutation
	 */
	record(undo: () => void): void;
}

export interface BaseOperation {
	/**
	 * the type of the operation
	 */
	isACL: boolean;

	/**
	 * the vertex that is being applied
	 */
	vertex: Vertex;

	/** True only for a vertex created by this local call pipeline. */
	isLocal?: boolean;

	/** Present only while a remote batch is applying transactionally. */
	journal?: OperationJournal;
}

export interface PostLCAOperation extends BaseOperation {
	/**
	 * the lca of the vertex
	 */
	lcaResult: LowestCommonAncestorResult;

	/** Cached state at the causal cut used as the replay origin. */
	replayState?: ReplayState;
}

export interface PostSplitOperation extends PostLCAOperation {
	drpVertices: Vertex[];
	aclVertices: Vertex[];
}

export interface Operation<T extends IDRP> extends PostSplitOperation {
	acl: IACL;
	drp?: T;

	/**
	 * Detached state used to stage the current operation before it is committed.
	 */
	currentDRP?: T | IACL;
}

export interface PostOperation<T extends IDRP> extends Operation<T> {
	result: unknown;
	stateChanged?: boolean;
}
