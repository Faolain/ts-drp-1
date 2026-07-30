import {
	CausalityIndex,
	type CausalityIndexOptions,
	type EpochFullOutcome,
	type EpochVertex,
} from "../../../packages/compaction/src/index.js";

declare const vertices: ReadonlyMap<string, EpochVertex>;
declare const vertex: EpochVertex;
declare const charges: ReadonlyMap<string, number>;

const bounded = {
	initialByteCharges: charges,
	maxEpochBytes: Number.MAX_SAFE_INTEGER,
	maxEpochVertices: 8192,
} satisfies CausalityIndexOptions;
const absent = {
	initialByteCharges: undefined,
	maxEpochBytes: undefined,
	maxEpochVertices: undefined,
} satisfies CausalityIndexOptions;
const index = new CausalityIndex(vertices, undefined, bounded);
const legacy = new CausalityIndex(vertices, undefined, absent);
const chargedResult: undefined | EpochFullOutcome = index.append(vertex.hash, vertex, 1);
const legacyResult: undefined | EpochFullOutcome = legacy.append(vertex.hash, vertex);
void [chargedResult, legacyResult];
