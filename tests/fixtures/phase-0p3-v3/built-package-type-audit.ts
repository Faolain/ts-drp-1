import {
	CausalityIndex,
	type CausalityIndexOptions,
	type EpochFullOutcome,
	type EpochVertex,
} from "@ts-drp/compaction";

declare const vertices: ReadonlyMap<string, EpochVertex>;
declare const vertex: EpochVertex;
declare const charges: ReadonlyMap<string, number>;

const bounded = {
	initialByteCharges: charges,
	maxEpochBytes: 1_000_000,
	maxEpochVertices: 8192,
} satisfies CausalityIndexOptions;
const absent = {
	initialByteCharges: undefined,
	maxEpochBytes: undefined,
} satisfies CausalityIndexOptions;
const index = new CausalityIndex(vertices, undefined, bounded);
new CausalityIndex(vertices, undefined, absent);
const result: undefined | EpochFullOutcome = index.append(vertex.hash, vertex, 512);
if (result !== undefined) {
	const status: "pending" = result.status;
	const code: "EPOCH_FULL" = result.code;
	const latchByHash: false = result.latchByHash;
	void [status, code, latchByHash];
}
