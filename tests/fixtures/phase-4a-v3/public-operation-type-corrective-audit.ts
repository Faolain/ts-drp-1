import type { FoldBlueprintEpochInput } from "../../../packages/compaction/src/blueprint-fold.js";
import type { EpochVertex } from "../../../packages/compaction/src/index.js";

declare const machine: FoldBlueprintEpochInput["machine"];

const operation = {
	action: "add_mul",
	add: 3,
	conflictKey: "total",
	multiplier: 2,
	value: 7,
} as const;

const anchor: EpochVertex = {
	dependencies: [],
	epoch: 1,
	hash: "a".repeat(64),
	kind: "drp-epoch-anchor",
	objectId: "room",
};
const application: EpochVertex = {
	anchor: anchor.hash,
	dependencies: [anchor.hash],
	epoch: 1,
	hash: "b".repeat(64),
	kind: "drp-vertex",
	objectId: "room",
	operation,
};

const input: FoldBlueprintEpochInput = {
	anchorHash: anchor.hash,
	authorize: () => true,
	machine,
	vertices: new Map([
		[anchor.hash, anchor],
		[application.hash, application],
	]),
};

void input;
