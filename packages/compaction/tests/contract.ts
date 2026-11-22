import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

export type ConflictAction = "Nop" | "DropLeft" | "DropRight" | "Swap" | "Drop";

export interface ConflictResult {
	action: ConflictAction;
	vertices?: string[];
}

export interface MerkleTree {
	hashRange(start: number, length: number): Uint8Array | Promise<Uint8Array>;
	inputs: readonly Uint8Array[];
	leafHashes: readonly Uint8Array[];
	root: Uint8Array;
	size: number;
}

export interface InclusionProof {
	auditPath: Uint8Array[];
	leafIndex: number;
	treeSize: number;
}

export interface ConsistencyProof {
	firstSize: number;
	path: Uint8Array[];
	secondSize: number;
}

export interface AccumulatorSnapshot {
	peaks: Array<Uint8Array | null>;
	size: number;
}

export interface BatchOptions {
	batchSize?: number;
	yieldTask?(): void | Promise<void>;
}

export interface LinearizeOptions {
	anchorHash: string;
	maxPasses?: number;
	mode?: "none" | "pair" | "multiple";
	resolveConflicts?(vertices: readonly EpochVertex[], context: Readonly<Record<string, unknown>>): ConflictResult;
	vertices: ReadonlyMap<string, EpochVertex>;
}

export interface CompactMerkleAccumulatorInstance {
	readonly size: number;
	append(input: Uint8Array | ArrayBuffer): CompactMerkleAccumulatorInstance | Promise<CompactMerkleAccumulatorInstance>;
	appendMany(
		inputs: readonly (Uint8Array | ArrayBuffer)[],
		options?: BatchOptions
	): CompactMerkleAccumulatorInstance | Promise<CompactMerkleAccumulatorInstance>;
	root(): Uint8Array | Promise<Uint8Array>;
	snapshot(): AccumulatorSnapshot;
}

export interface CausalityIndexInstance {
	areRelated(leftHash: string, rightHash: string): boolean;
	isAncestor(ancestorHash: string, descendantHash: string): boolean;
}

export interface CompactionModule {
	CausalityIndex: new (vertices: ReadonlyMap<string, EpochVertex>, order?: readonly string[]) => CausalityIndexInstance;
	CompactMerkleAccumulator: {
		new (snapshot?: Partial<AccumulatorSnapshot>): CompactMerkleAccumulatorInstance;
		fromSnapshot(snapshot: AccumulatorSnapshot): CompactMerkleAccumulatorInstance;
	};
	EMPTY_MERKLE_ROOT: Uint8Array;
	LinearizationError: new (code: string, message: string) => Error & { code: string };
	buildMerkleTree(
		inputs: readonly (Uint8Array | ArrayBuffer)[],
		options?: BatchOptions
	): MerkleTree | Promise<MerkleTree>;
	consistencyProof(tree: MerkleTree, firstSize: number): ConsistencyProof | Promise<ConsistencyProof>;
	inclusionProof(tree: MerkleTree, index: number): InclusionProof | Promise<InclusionProof>;
	linearizeEpoch(options: LinearizeOptions): EpochVertex[];
	merkleLeafHash(input: Uint8Array | ArrayBuffer): Uint8Array | Promise<Uint8Array>;
	merkleNodeHash(left: Uint8Array, right: Uint8Array): Uint8Array | Promise<Uint8Array>;
	stateDigest(state: unknown): string;
	topologicalOrder(
		vertices: ReadonlyMap<string, EpochVertex>,
		anchorHash: string,
		options?: { enforceDependencyAntichain?: boolean }
	): string[];
	verifyConsistency(
		firstSize: number,
		secondSize: number,
		firstRoot: Uint8Array,
		secondRoot: Uint8Array,
		path: readonly Uint8Array[]
	): boolean | Promise<boolean>;
	verifyInclusion(
		input: Uint8Array | ArrayBuffer,
		proof: InclusionProof,
		expectedRoot: Uint8Array
	): boolean | Promise<boolean>;
}

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
export const sourceEntryPath = join(packageDirectory, "src/index.ts");
export const sourceExists = existsSync(sourceEntryPath);
const sourceModulePath: string = "../src/index.js";

/**
 * Loads the Phase 0b production owner after the RED existence guard has passed.
 * @returns The dynamically loaded package surface.
 */
export async function loadCompaction(): Promise<CompactionModule> {
	return (await import(sourceModulePath)) as CompactionModule;
}

/**
 * Returns the structured linearization error code produced by an action.
 * @param action - The expected failing operation.
 * @returns The error's code, when present.
 */
export function errorCode(action: () => unknown): string | undefined {
	try {
		action();
	} catch (error) {
		return error instanceof Error && "code" in error ? String(error.code) : undefined;
	}
	throw new Error("expected the action to throw");
}

/**
 * Captures either a synchronous or asynchronous contract failure.
 * @param action - The expected failing operation.
 * @returns The captured thrown value.
 */
export async function asyncError(action: () => unknown | Promise<unknown>): Promise<unknown> {
	try {
		await action();
	} catch (error) {
		return error;
	}
	throw new Error("expected the action to throw");
}
