export { CausalityIndex, LinearizationError, linearizeEpoch, topologicalOrder } from "./linearize.js";
export {
	CompactMerkleAccumulator,
	EMPTY_MERKLE_ROOT,
	buildMerkleTree,
	consistencyProof,
	inclusionProof,
	merkleLeafHash,
	merkleNodeHash,
	verifyConsistency,
	verifyInclusion,
} from "./ct-merkle.js";
export { stateDigest } from "./state.js";
export type {
	AccumulatorSnapshot,
	BatchOptions,
	ConflictAction,
	ConflictResult,
	ConsistencyProof,
	EpochVertex,
	InclusionProof,
	LinearizeOptions,
	MerkleTree,
} from "./types.js";
