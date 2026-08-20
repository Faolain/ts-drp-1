import {
	CausalityIndex,
	type CausalityIndexOptions,
	type EpochFullOutcome,
	type EpochVertex,
} from "../../../packages/compaction/src/index.js";

declare const vertices: ReadonlyMap<string, EpochVertex>;
declare const vertex: EpochVertex;
const options = { maxEpochVertices: 8192 } satisfies CausalityIndexOptions;
const absentOptions = { maxEpochVertices: undefined } satisfies CausalityIndexOptions;
const index = new CausalityIndex(vertices, undefined, options);
new CausalityIndex(vertices, undefined, absentOptions);
const result: undefined | EpochFullOutcome = index.append(vertex.hash, vertex);
if (result !== undefined) {
	const status: "pending" = result.status;
	const code: "EPOCH_FULL" = result.code;
	const latchByHash: false = result.latchByHash;
	void [status, code, latchByHash];
}
