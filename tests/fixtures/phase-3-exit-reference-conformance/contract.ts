/* eslint-disable jsdoc/require-param-description, jsdoc/require-returns -- closed tests-only conformance contract */
import { createHash } from "node:crypto";

import type { EpochVertex } from "../../../packages/compaction/tests/contract.js";

export const REFERENCE_LOCK_SHA256 = "ada22a8aa8c5e190e41d5cd8de84ed288d5a0047b10ef579602c28e50f294ffd";
export const ORDINARY_GRAPH_COUNT = 407;
export const ORDINARY_PERMUTATION_COUNT = 3_246;
export const ORDINARY_RELATION_OBSERVATION_COUNT = 27_972;
export const EXPANDED_GRAPH_COUNT = 5_231;
export const EXPANDED_PERMUTATION_COUNT = 41_838;
export const EXPANDED_RELATION_OBSERVATION_COUNT = 500_724;
export const EXPANDED_VALUE_COUNT = 10_000;
export const EXPANDED_SEED = 0x3e60_2026;
export const DOMAIN = "ts-drp/phase-3-exit-e/v2";
export const HASH_DOMAINS = Object.freeze(["", "a", "é", "😀", "d".repeat(255), "d".repeat(256)] as const);
export const HASH_PART_BOUNDARY_LENGTHS = Object.freeze([
	0, 1, 2, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256,
] as const);
export const D93_56_HISTORY_LEAF_CANONICAL_HEX =
	"080605046b696e6405106472702d686973746f72792d6c656166050565706f6368030e05076f7264696e616c030005086f626a6563744964050e6f626a6563743a686973746f7279050a76657274657848617368054033303330333033303330333033303330333033303330333033303330333033303330333033303330333033303330333033303330333033303330333033303330050d70726f746f636f6c4d616a6f720306";
export const BATCH_OPTIONS = Object.freeze({ batchSize: 256 });
export const ORDER_OPTIONS = Object.freeze({ enforceDependencyAntichain: true });
export const RANGE_START = 0;
const ORIGINAL_ASYNC = Object.freeze({ current: false, original: true });

export const DRIVER_NAMESPACE_IMPORTS = Object.freeze([
	["currentCanonical", "../../../packages/canonical/dist/src/index.js"],
	["currentLinearize", "../../../packages/compaction/dist/src/index.js"],
	["currentMerkle", "../../../packages/compaction/dist/src/index.js"],
	["originalCanonical", "../../../packages/protocol-v2/conformance/ahe-reference/src/canonical.js"],
	["originalHash", "../../../packages/protocol-v2/conformance/ahe-reference/src/hash.js"],
	["originalLinearize", "../../../packages/protocol-v2/conformance/ahe-reference/src/linearize.js"],
	["originalMerkle", "../../../packages/protocol-v2/conformance/ahe-reference/src/ct-merkle.js"],
] as const);

export const DRIVER_CONTRACT_IMPORTS = Object.freeze([
	"BATCH_OPTIONS",
	"ORDER_OPTIONS",
	"RANGE_START",
	"PeerSlot",
] as const);

export const REFERENCE_LOCK_ENTRIES = Object.freeze({
	"admission.js": "63af415cd0b78512247fd43df32fa98d1459614a48270997f619ba28e20fb3f8",
	"archive.js": "f373d778a428c3a8ea91894337fead422c7f58444a2f8cd0a680c9222ff9db64",
	"canonical.js": "daa0cda2893c4301b0271a47cb45ed2568f77bda0bce7502f0de756d0a678ca5",
	"ct-merkle.js": "7333eccf9f8b3a49279cdfbd513ac806fa623830efb5ec3fb60a1b9d7a08b355",
	"fold.js": "369a84682a7003bfd90e25ca4b0bd203c3b0a38c80a9772e825bca23723f746c",
	"hash.js": "6cd4059d02ef09dfc80423ae6eec57917449ebd8be1b06141387ea23154ef637",
	"indexeddb-store.js": "d9bcac07f77f7beb4d4c6252dfcf067e42b36763a31a64465b71bd3426674561",
	"linearize.js": "ee5a41ce44700fa8329883fb63414ec81e0873335f6cbfebc47e6af0e2c69bf9",
	"protocol.js": "8681b6d1ad9b68d2fb12170aa804bf76a0f24c9345748dc32c269275b73f4b92",
	"runtime.js": "97c46b0e8fc58a2e539bd89b29104f238ca2ee226b2deb5efac7dba1e1ba6e77",
	"seal.js": "b39cb31e6e6bc8f742515588ee7a877749dfb3302d4542fd1c34539ac64c94ca",
	"snapshot.js": "637ca79f89ed6f187442c199730758f0123069441790fb99c402c34b105b9507",
	"state.js": "dfbd8ebffe1e05fa32bc3b84af73594af54781e05a91b405dff50895c284e2ca",
});

export const EXECUTED_REFERENCE_CLOSURE = Object.freeze([
	"canonical.js",
	"ct-merkle.js",
	"hash.js",
	"linearize.js",
	"protocol.js",
] as const);

export const CONFORMING_OPERATIONS = Object.freeze([
	"canonical-encode",
	"canonical-valid-decode",
	"canonical-deep-clone",
	"byte-compare",
	"domain-hash",
	"topological-order",
	"causality-ancestor",
	"causality-related",
	"linearize-none",
	"merkle-leaf",
	"merkle-node",
	"merkle-tree",
	"merkle-range",
	"merkle-inclusion",
	"merkle-inclusion-verify",
	"merkle-consistency",
	"merkle-consistency-verify",
	"merkle-accumulator-from-empty",
] as const);

export const EXCLUDED_BEHAVIORS = Object.freeze([
	"D1-locale-signer-order",
	"D2-float32-negative-zero",
	"D3-admission-precedence",
	"v2-v3-vertex-anchor-history-preimages",
	"admission-and-pending",
	"pair-and-multiple-resolution",
	"state-v2-digest",
	"causality-default-order",
	"append-tip-capacity",
	"hostile-copy-yield-large-counter-hardening",
	"fold-snapshot-seal-archive-storage-runtime-recovery-migration",
	"all-protocol-v3-reference-surfaces",
] as const);

export const MERKLE_BOUNDARY_SIZES = Object.freeze([
	0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256,
] as const);

export const ORDINARY_MERKLE_BOUNDARY_SIZES = Object.freeze([
	0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65,
] as const);

export const MUTATION_KINDS = Object.freeze([
	"wrong-binding",
	"same-peer-position-swap",
	"duplicate-binding",
	"missing-binding/arity",
	"extra-binding",
	"wrong-literal",
	"extra-option-property",
	"dead-result",
	"overwritten-result",
	"unresolved-result",
	"observation-substitution",
	"wrong-callee/call-parity",
	"invalid-control-form",
	"pre-call-rebinding",
	"unreachable-call",
	"wrong-dependency-edge",
	"reverse-ready-tie-break",
	"mask-index-off-by-one",
	"peer-derived-order",
	"flipped-ancestor",
	"false-reflexive-relatedness",
	"anchor-in-none-output",
	"wrong-canonical-tag",
	"wrong-valid-decode",
	"wrong-byte-sign",
	"wrong-domain-frame",
	"identity-clone",
	"shallow-clone",
	"missing-leaf-prefix",
	"swapped-node-children",
	"reversed-accumulator-peaks",
	"proof-path-change",
	"graph-member-change",
	"shared-carrier",
	"shared-backing-buffer",
	"wrong-stateful-result",
	"peer-substitution",
	"reference-lock-bypass",
	"wrong-reference",
	"wrong-import",
	"wrapper-decoy",
	"forbidden-normalization",
] as const);

export type Peer = "current" | "original";
export type ConformingOperation = (typeof CONFORMING_OPERATIONS)[number];
export type DriverOperation =
	| ConformingOperation
	| "provenance-d2"
	| "provenance-missing-resolver"
	| "provenance-safe-integer-proof";
export type MutationKind = (typeof MUTATION_KINDS)[number];
export type BindingExpressionKind = "literal" | "slot" | "ssa";
export type ResultDestinationKind = "observation" | "ssa";

export interface CallArgumentBinding {
	expression: string;
	kind: BindingExpressionKind;
	name: string;
	position: number;
}

export interface CallBinding {
	arguments: readonly CallArgumentBinding[];
	awaited: boolean;
	callee: string;
	callId: string;
	destination: string;
	destinationKind: ResultDestinationKind;
	functionName: string;
	operation: DriverOperation;
	peer: Peer;
}

interface PairCallOptions {
	argumentsByPeer: Readonly<Record<Peer, readonly [string, BindingExpressionKind][]>>;
	awaited?: boolean;
	awaitedByPeer?: Readonly<Record<Peer, boolean>>;
	callee?: string;
	calleeByPeer?: Readonly<Record<Peer, string>>;
	callId?: string;
	destinationByPeer: Readonly<Record<Peer, readonly [string, ResultDestinationKind]>>;
	functionName: string;
	operation: DriverOperation;
}

const callPair = ({
	argumentsByPeer,
	awaited,
	awaitedByPeer,
	callee,
	calleeByPeer,
	callId = "call",
	destinationByPeer,
	functionName,
	operation,
}: PairCallOptions): readonly CallBinding[] => {
	if ((callee === undefined) === (calleeByPeer === undefined))
		throw new TypeError("exactly one callee form is required");
	if (awaited !== undefined && awaitedByPeer !== undefined) throw new TypeError("exactly one awaited form is required");
	return (["original", "current"] as const).map((peer) => ({
		arguments: argumentsByPeer[peer].map(([expression, kind], position) => ({
			expression,
			kind,
			name: `arg${position}`,
			position,
		})),
		awaited: awaitedByPeer?.[peer] ?? awaited ?? false,
		callee: calleeByPeer?.[peer] ?? `${peer}${callee as string}`,
		callId: `${peer}-${callId}`,
		destination: destinationByPeer[peer][0],
		destinationKind: destinationByPeer[peer][1],
		functionName,
		operation,
		peer,
	}));
};

const directPair = (
	operation: DriverOperation,
	functionName: string,
	callee: string,
	argumentsByPeer: Readonly<Record<Peer, readonly [string, BindingExpressionKind][]>>,
	awaited: boolean | Readonly<Record<Peer, boolean>> = false,
	observationField: string = operation
): readonly CallBinding[] =>
	callPair({
		argumentsByPeer,
		...(typeof awaited === "boolean" ? { awaited } : { awaitedByPeer: awaited }),
		callee,
		callId: `${operation}-${callee.replaceAll(/[^A-Za-z0-9]+/gu, "-")}`,
		destinationByPeer: {
			current: [`current.${observationField}`, "observation"],
			original: [`original.${observationField}`, "observation"],
		},
		functionName,
		operation,
	});

export const CALL_BINDINGS: readonly CallBinding[] = Object.freeze([
	...directPair(
		"canonical-encode",
		"runCanonicalPair",
		"Canonical.encodeCanonical",
		{
			current: [["currentSlot.value", "slot"]],
			original: [["originalSlot.value", "slot"]],
		},
		false,
		"encoded"
	),
	...directPair(
		"canonical-valid-decode",
		"runDecodePair",
		"Canonical.decodeCanonical",
		{
			current: [["currentSlot.decodeBytes", "slot"]],
			original: [["originalSlot.decodeBytes", "slot"]],
		},
		false,
		"value"
	),
	...directPair(
		"canonical-deep-clone",
		"runCanonicalPair",
		"Canonical.deepCloneCanonical",
		{
			current: [["currentSlot.value", "slot"]],
			original: [["originalSlot.value", "slot"]],
		},
		false,
		"clone"
	),
	...callPair({
		argumentsByPeer: {
			current: [
				["currentSlot.compareLeft", "slot"],
				["currentSlot.compareRight", "slot"],
			],
			original: [
				["originalSlot.compareLeft", "slot"],
				["originalSlot.compareRight", "slot"],
			],
		},
		calleeByPeer: {
			current: "currentCanonical.compareBytes",
			original: "originalHash.compareBytes",
		},
		callId: "byte-compare",
		destinationByPeer: {
			current: ["current.compare", "observation"],
			original: ["original.compare", "observation"],
		},
		functionName: "runCanonicalPair",
		operation: "byte-compare",
	}),
	...callPair({
		argumentsByPeer: {
			current: [
				["currentSlot.hashDomain", "slot"],
				["...currentSlot.hashParts", "slot"],
			],
			original: [
				["originalSlot.hashDomain", "slot"],
				["...originalSlot.hashParts", "slot"],
			],
		},
		awaitedByPeer: ORIGINAL_ASYNC,
		calleeByPeer: {
			current: "currentCanonical.hashDomain",
			original: "originalHash.hashDomain",
		},
		callId: "domain-hash",
		destinationByPeer: {
			current: ["current.digest", "observation"],
			original: ["original.digest", "observation"],
		},
		functionName: "runCanonicalPair",
		operation: "domain-hash",
	}),
	...directPair(
		"topological-order",
		"runOrderPair",
		"Linearize.topologicalOrder",
		{
			current: [
				["currentSlot.graph", "slot"],
				["currentSlot.anchorHash", "slot"],
				["ORDER_OPTIONS", "literal"],
			],
			original: [
				["originalSlot.graph", "slot"],
				["originalSlot.anchorHash", "slot"],
				["ORDER_OPTIONS", "literal"],
			],
		},
		false,
		"value"
	),
	...callPair({
		argumentsByPeer: {
			current: [
				["currentSlot.graph", "slot"],
				["currentSlot.order", "slot"],
			],
			original: [
				["originalSlot.graph", "slot"],
				["originalSlot.order", "slot"],
			],
		},
		callee: "Linearize.CausalityIndex",
		callId: "ancestor-index",
		destinationByPeer: {
			current: ["currentIndex", "ssa"],
			original: ["originalIndex", "ssa"],
		},
		functionName: "runAncestorPair",
		operation: "causality-ancestor",
	}),
	...directPair(
		"causality-ancestor",
		"runAncestorPair",
		"Index.isAncestor",
		{
			current: [
				["currentSlot.queryLeft", "slot"],
				["currentSlot.queryRight", "slot"],
			],
			original: [
				["originalSlot.queryLeft", "slot"],
				["originalSlot.queryRight", "slot"],
			],
		},
		false,
		"value"
	),
	...callPair({
		argumentsByPeer: {
			current: [
				["currentSlot.graph", "slot"],
				["currentSlot.order", "slot"],
			],
			original: [
				["originalSlot.graph", "slot"],
				["originalSlot.order", "slot"],
			],
		},
		callee: "Linearize.CausalityIndex",
		callId: "related-index",
		destinationByPeer: {
			current: ["currentIndex", "ssa"],
			original: ["originalIndex", "ssa"],
		},
		functionName: "runRelatedPair",
		operation: "causality-related",
	}),
	...directPair(
		"causality-related",
		"runRelatedPair",
		"Index.areRelated",
		{
			current: [
				["currentSlot.queryLeft", "slot"],
				["currentSlot.queryRight", "slot"],
			],
			original: [
				["originalSlot.queryLeft", "slot"],
				["originalSlot.queryRight", "slot"],
			],
		},
		false,
		"value"
	),
	...directPair(
		"linearize-none",
		"runLinearizePair",
		"Linearize.linearizeEpoch",
		{
			current: [["currentSlot.linearizeOptions", "slot"]],
			original: [["originalSlot.linearizeOptions", "slot"]],
		},
		false,
		"value"
	),
	...directPair(
		"provenance-d2",
		"runD2Pair",
		"Canonical.encodeCanonical",
		{
			current: [["currentSlot.value", "slot"]],
			original: [["originalSlot.value", "slot"]],
		},
		false,
		"value"
	),
	...directPair(
		"provenance-safe-integer-proof",
		"runAliasedInclusionPair",
		"Merkle.verifyInclusion",
		{
			current: [
				["currentSlot.leaves[currentSlot.inclusionIndex]!", "slot"],
				["currentSlot.aliasedInclusionProof", "slot"],
				["currentSlot.secondRoot", "slot"],
			],
			original: [
				["originalSlot.leaves[originalSlot.inclusionIndex]!", "slot"],
				["originalSlot.aliasedInclusionProof", "slot"],
				["originalSlot.secondRoot", "slot"],
			],
		},
		ORIGINAL_ASYNC,
		"value"
	),
	{
		arguments: [{ expression: "originalSlot.missingResolverOptions", kind: "slot", name: "arg0", position: 0 }],
		awaited: false,
		callee: "originalLinearize.linearizeEpoch",
		callId: "original-missing-resolver",
		destination: "return",
		destinationKind: "observation",
		functionName: "runOriginalMissingResolver",
		operation: "provenance-missing-resolver",
		peer: "original",
	},
	{
		arguments: [{ expression: "currentSlot.missingResolverOptions", kind: "slot", name: "arg0", position: 0 }],
		awaited: false,
		callee: "currentLinearize.linearizeEpoch",
		callId: "current-missing-resolver",
		destination: "return",
		destinationKind: "observation",
		functionName: "runCurrentMissingResolver",
		operation: "provenance-missing-resolver",
		peer: "current",
	},
	...directPair(
		"merkle-leaf",
		"runMerklePair",
		"Merkle.merkleLeafHash",
		{
			current: [["currentSlot.leaves[0]!", "slot"]],
			original: [["originalSlot.leaves[0]!", "slot"]],
		},
		ORIGINAL_ASYNC,
		"leafHash"
	),
	...directPair(
		"merkle-node",
		"runMerklePair",
		"Merkle.merkleNodeHash",
		{
			current: [
				["currentSlot.firstRoot", "slot"],
				["currentSlot.secondRoot", "slot"],
			],
			original: [
				["originalSlot.firstRoot", "slot"],
				["originalSlot.secondRoot", "slot"],
			],
		},
		ORIGINAL_ASYNC,
		"nodeHash"
	),
	...directPair(
		"merkle-tree",
		"runMerkleRootPair",
		"Merkle.buildMerkleTree",
		{
			current: [
				["currentSlot.leaves", "slot"],
				["BATCH_OPTIONS", "literal"],
			],
			original: [
				["originalSlot.leaves", "slot"],
				["BATCH_OPTIONS", "literal"],
			],
		},
		true,
		"root"
	),
	...callPair({
		argumentsByPeer: {
			current: [
				["currentSlot.leaves", "slot"],
				["BATCH_OPTIONS", "literal"],
			],
			original: [
				["originalSlot.leaves", "slot"],
				["BATCH_OPTIONS", "literal"],
			],
		},
		awaited: true,
		callee: "Merkle.buildMerkleTree",
		callId: "range-tree",
		destinationByPeer: {
			current: ["currentRangeTree", "ssa"],
			original: ["originalRangeTree", "ssa"],
		},
		functionName: "runMerkleRangePair",
		operation: "merkle-range",
	}),
	...directPair(
		"merkle-range",
		"runMerkleRangePair",
		"RangeTree.hashRange",
		{
			current: [
				["RANGE_START", "literal"],
				["currentSlot.leaves.length", "slot"],
			],
			original: [
				["RANGE_START", "literal"],
				["originalSlot.leaves.length", "slot"],
			],
		},
		ORIGINAL_ASYNC,
		"rangeHash"
	),
	...callPair({
		argumentsByPeer: {
			current: [
				["currentSlot.leaves", "slot"],
				["BATCH_OPTIONS", "literal"],
			],
			original: [
				["originalSlot.leaves", "slot"],
				["BATCH_OPTIONS", "literal"],
			],
		},
		awaited: true,
		callee: "Merkle.buildMerkleTree",
		callId: "inclusion-tree",
		destinationByPeer: {
			current: ["currentInclusionTree", "ssa"],
			original: ["originalInclusionTree", "ssa"],
		},
		functionName: "runInclusionPair",
		operation: "merkle-inclusion",
	}),
	...directPair(
		"merkle-inclusion",
		"runInclusionPair",
		"Merkle.inclusionProof",
		{
			current: [
				["currentInclusionTree", "ssa"],
				["currentSlot.inclusionIndex", "slot"],
			],
			original: [
				["originalInclusionTree", "ssa"],
				["originalSlot.inclusionIndex", "slot"],
			],
		},
		ORIGINAL_ASYNC,
		"proof"
	),
	...callPair({
		argumentsByPeer: {
			current: [
				["currentSlot.leaves", "slot"],
				["BATCH_OPTIONS", "literal"],
			],
			original: [
				["originalSlot.leaves", "slot"],
				["BATCH_OPTIONS", "literal"],
			],
		},
		awaited: true,
		callee: "Merkle.buildMerkleTree",
		callId: "consistency-tree",
		destinationByPeer: {
			current: ["currentConsistencyTree", "ssa"],
			original: ["originalConsistencyTree", "ssa"],
		},
		functionName: "runConsistencyPair",
		operation: "merkle-consistency",
	}),
	...directPair(
		"merkle-inclusion-verify",
		"runInclusionPair",
		"Merkle.verifyInclusion",
		{
			current: [
				["currentSlot.leaves[currentSlot.inclusionIndex]!", "slot"],
				["currentSlot.inclusionProof", "slot"],
				["currentSlot.secondRoot", "slot"],
			],
			original: [
				["originalSlot.leaves[originalSlot.inclusionIndex]!", "slot"],
				["originalSlot.inclusionProof", "slot"],
				["originalSlot.secondRoot", "slot"],
			],
		},
		ORIGINAL_ASYNC,
		"valid"
	),
	...directPair(
		"merkle-consistency",
		"runConsistencyPair",
		"Merkle.consistencyProof",
		{
			current: [
				["currentConsistencyTree", "ssa"],
				["currentSlot.firstSize", "slot"],
			],
			original: [
				["originalConsistencyTree", "ssa"],
				["originalSlot.firstSize", "slot"],
			],
		},
		ORIGINAL_ASYNC,
		"proof"
	),
	...directPair(
		"merkle-consistency-verify",
		"runConsistencyPair",
		"Merkle.verifyConsistency",
		{
			current: [
				["currentSlot.firstSize", "slot"],
				["currentSlot.leaves.length", "slot"],
				["currentSlot.firstRoot", "slot"],
				["currentSlot.secondRoot", "slot"],
				["currentSlot.proofPath", "slot"],
			],
			original: [
				["originalSlot.firstSize", "slot"],
				["originalSlot.leaves.length", "slot"],
				["originalSlot.firstRoot", "slot"],
				["originalSlot.secondRoot", "slot"],
				["originalSlot.proofPath", "slot"],
			],
		},
		ORIGINAL_ASYNC,
		"valid"
	),
	...callPair({
		argumentsByPeer: { current: [], original: [] },
		callee: "Merkle.CompactMerkleAccumulator",
		callId: "accumulator",
		destinationByPeer: {
			current: ["currentAccumulator", "ssa"],
			original: ["originalAccumulator", "ssa"],
		},
		functionName: "runAccumulatorPair",
		operation: "merkle-accumulator-from-empty",
	}),
	...callPair({
		argumentsByPeer: {
			current: [
				["currentSlot.leaves", "slot"],
				["BATCH_OPTIONS", "literal"],
			],
			original: [
				["originalSlot.leaves", "slot"],
				["BATCH_OPTIONS", "literal"],
			],
		},
		awaited: true,
		callee: "Accumulator.appendMany",
		callId: "append-many",
		destinationByPeer: {
			current: ["currentAppended", "ssa"],
			original: ["originalAppended", "ssa"],
		},
		functionName: "runAccumulatorPair",
		operation: "merkle-accumulator-from-empty",
	}),
	...directPair(
		"merkle-accumulator-from-empty",
		"runAccumulatorPair",
		"Appended.root",
		{
			current: [],
			original: [],
		},
		ORIGINAL_ASYNC,
		"root"
	),
	...callPair({
		argumentsByPeer: { current: [], original: [] },
		callee: "Merkle.CompactMerkleAccumulator",
		callId: "snapshot-accumulator",
		destinationByPeer: {
			current: ["currentSnapshotAccumulator", "ssa"],
			original: ["originalSnapshotAccumulator", "ssa"],
		},
		functionName: "runAccumulatorPair",
		operation: "merkle-accumulator-from-empty",
	}),
	...callPair({
		argumentsByPeer: {
			current: [
				["currentSlot.leaves", "slot"],
				["BATCH_OPTIONS", "literal"],
			],
			original: [
				["originalSlot.leaves", "slot"],
				["BATCH_OPTIONS", "literal"],
			],
		},
		awaited: true,
		callee: "SnapshotAccumulator.appendMany",
		callId: "snapshot-append-many",
		destinationByPeer: {
			current: ["currentSnapshotAppended", "ssa"],
			original: ["originalSnapshotAppended", "ssa"],
		},
		functionName: "runAccumulatorPair",
		operation: "merkle-accumulator-from-empty",
	}),
	...directPair(
		"merkle-accumulator-from-empty",
		"runAccumulatorPair",
		"SnapshotAppended.snapshot",
		{
			current: [],
			original: [],
		},
		false,
		"snapshot"
	),
]);

export interface BindingMutation {
	callId: string;
	kind:
		| "dead-result"
		| "default"
		| "duplicate-binding"
		| "extra"
		| "extra-option-property"
		| "observation-substitution"
		| "overwritten-result"
		| "pre-call-rebinding"
		| "same-peer-position-swap"
		| "unreachable-call"
		| "unresolved"
		| "wrong-binding"
		| "wrong-literal"
		| "wrong-opposite-peer-result"
		| "wrong-same-peer-result"
		| "wrong-stateful-result";
	peer: Peer;
	position: number | "call" | "result";
}

export const BINDING_MUTATIONS: readonly BindingMutation[] = Object.freeze(
	CALL_BINDINGS.flatMap((call) => [
		...call.arguments.flatMap(({ expression, kind, position }) => [
			...(kind === "literal"
				? [{ callId: call.callId, kind: "wrong-literal" as const, peer: call.peer, position }]
				: [{ callId: call.callId, kind: "wrong-binding" as const, peer: call.peer, position }]),
			{ callId: call.callId, kind: "default" as const, peer: call.peer, position },
			...(["BATCH_OPTIONS", "ORDER_OPTIONS"].includes(expression)
				? [{ callId: call.callId, kind: "extra-option-property" as const, peer: call.peer, position }]
				: []),
			...(call.arguments.length > 1
				? [
						{ callId: call.callId, kind: "same-peer-position-swap" as const, peer: call.peer, position },
						{ callId: call.callId, kind: "duplicate-binding" as const, peer: call.peer, position },
					]
				: []),
		]),
		{ callId: call.callId, kind: "extra" as const, peer: call.peer, position: "call" as const },
		{ callId: call.callId, kind: "pre-call-rebinding" as const, peer: call.peer, position: "result" as const },
		{ callId: call.callId, kind: "unreachable-call" as const, peer: call.peer, position: "result" as const },
		{ callId: call.callId, kind: "dead-result" as const, peer: call.peer, position: "result" as const },
		{ callId: call.callId, kind: "overwritten-result" as const, peer: call.peer, position: "result" as const },
		{ callId: call.callId, kind: "wrong-opposite-peer-result" as const, peer: call.peer, position: "result" as const },
		...(CALL_BINDINGS.some(
			(candidate) =>
				candidate.functionName === call.functionName &&
				candidate.peer === call.peer &&
				candidate.destination !== call.destination
		)
			? [{ callId: call.callId, kind: "wrong-same-peer-result" as const, peer: call.peer, position: "result" as const }]
			: []),
		...(call.destinationKind === "ssa"
			? [{ callId: call.callId, kind: "wrong-stateful-result" as const, peer: call.peer, position: "result" as const }]
			: [
					{
						callId: call.callId,
						kind: "observation-substitution" as const,
						peer: call.peer,
						position: "result" as const,
					},
				]),
		...(call.awaited
			? [{ callId: call.callId, kind: "unresolved" as const, peer: call.peer, position: "result" as const }]
			: []),
	])
);

export interface CanonicalSlot {
	compareLeft: Uint8Array;
	compareRight: Uint8Array;
	decodeBytes: Uint8Array;
	hashDomain: string;
	hashParts: Uint8Array[];
	value: unknown;
}

export interface GraphSlot {
	anchorHash: string;
	graph: Map<string, EpochVertex>;
	linearizeOptions: Readonly<{
		anchorHash: string;
		mode: "none";
		vertices: Map<string, EpochVertex>;
	}>;
	missingResolverOptions: Readonly<{
		anchorHash: string;
		mode: "pair";
		vertices: Map<string, EpochVertex>;
	}>;
	order: string[];
	queryLeft: string;
	queryRight: string;
}

export interface MerkleSlot {
	aliasedInclusionProof: Readonly<{ auditPath: Uint8Array[]; leafIndex: number; treeSize: number }>;
	firstRoot: Uint8Array;
	firstSize: number;
	inclusionIndex: number;
	inclusionProof: Readonly<{ auditPath: Uint8Array[]; leafIndex: number; treeSize: number }>;
	leaves: Uint8Array[];
	proofPath: Uint8Array[];
	secondRoot: Uint8Array;
}

export interface PeerSlot extends CanonicalSlot, GraphSlot, MerkleSlot {}

export interface PeerSlots {
	currentSlot: PeerSlot;
	originalSlot: PeerSlot;
}

export interface CanonicalObservation {
	clone: unknown;
	compare: number;
	digest: Uint8Array;
	encoded: Uint8Array;
}

export interface AccumulatorObservation {
	root: Uint8Array;
	snapshot: Readonly<{ peaks: Array<Uint8Array | null>; size: number }>;
}

export interface MerkleObservation {
	leafHash: Uint8Array;
	nodeHash: Uint8Array;
}

export interface MerkleRangeObservation {
	rangeHash: Uint8Array;
}

export interface InclusionObservation {
	proof: Readonly<{ auditPath: Uint8Array[]; leafIndex: number; treeSize: number }>;
	valid: boolean;
}

export interface ConsistencyObservation {
	proof: Readonly<{ firstSize: number; path: Uint8Array[]; secondSize: number }>;
	valid: boolean;
}

export interface PairObservation<Value> {
	current: Value;
	original: Value;
}

export type MaybePromise<Value> = Value | Promise<Value>;

export interface ReferenceConformanceDriverModule {
	runAccumulatorPair(
		originalSlot: PeerSlot,
		currentSlot: PeerSlot
	): MaybePromise<PairObservation<AccumulatorObservation>>;
	runAliasedInclusionPair(originalSlot: PeerSlot, currentSlot: PeerSlot): MaybePromise<PairObservation<boolean>>;
	runCanonicalPair(originalSlot: PeerSlot, currentSlot: PeerSlot): MaybePromise<PairObservation<CanonicalObservation>>;
	runDecodePair(originalSlot: PeerSlot, currentSlot: PeerSlot): MaybePromise<PairObservation<unknown>>;
	runConsistencyPair(
		originalSlot: PeerSlot,
		currentSlot: PeerSlot
	): MaybePromise<PairObservation<ConsistencyObservation>>;
	runInclusionPair(originalSlot: PeerSlot, currentSlot: PeerSlot): MaybePromise<PairObservation<InclusionObservation>>;
	runD2Pair(originalSlot: PeerSlot, currentSlot: PeerSlot): MaybePromise<PairObservation<Uint8Array>>;
	runAncestorPair(originalSlot: PeerSlot, currentSlot: PeerSlot): MaybePromise<PairObservation<boolean>>;
	runLinearizePair(
		originalSlot: PeerSlot,
		currentSlot: PeerSlot
	): MaybePromise<PairObservation<readonly EpochVertex[]>>;
	runMerklePair(originalSlot: PeerSlot, currentSlot: PeerSlot): MaybePromise<PairObservation<MerkleObservation>>;
	runMerkleRangePair(
		originalSlot: PeerSlot,
		currentSlot: PeerSlot
	): MaybePromise<PairObservation<MerkleRangeObservation>>;
	runMerkleRootPair(originalSlot: PeerSlot, currentSlot: PeerSlot): MaybePromise<PairObservation<Uint8Array>>;
	runOrderPair(originalSlot: PeerSlot, currentSlot: PeerSlot): MaybePromise<PairObservation<string[]>>;
	runCurrentMissingResolver(currentSlot: PeerSlot): MaybePromise<readonly EpochVertex[]>;
	runOriginalMissingResolver(originalSlot: PeerSlot): MaybePromise<readonly EpochVertex[]>;
	runRelatedPair(originalSlot: PeerSlot, currentSlot: PeerSlot): MaybePromise<PairObservation<boolean>>;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
}

function cloneGraph(graph: ReadonlyMap<string, EpochVertex>): Map<string, EpochVertex> {
	return new Map(
		[...graph].map(([hash, vertex]) => {
			const cloned: EpochVertex = { ...vertex, dependencies: [...vertex.dependencies] };
			if (vertex.operation !== undefined) cloned.operation = structuredClone(vertex.operation);
			return [hash, cloned];
		})
	);
}

function materializeSlot(input: Readonly<PeerSlot>): PeerSlot {
	const graph = cloneGraph(input.graph);
	return {
		aliasedInclusionProof: {
			auditPath: input.aliasedInclusionProof.auditPath.map(cloneBytes),
			leafIndex: input.aliasedInclusionProof.leafIndex,
			treeSize: input.aliasedInclusionProof.treeSize,
		},
		anchorHash: input.anchorHash,
		compareLeft: cloneBytes(input.compareLeft),
		compareRight: cloneBytes(input.compareRight),
		decodeBytes: cloneBytes(input.decodeBytes),
		firstRoot: cloneBytes(input.firstRoot),
		firstSize: input.firstSize,
		graph,
		hashDomain: input.hashDomain,
		hashParts: input.hashParts.map(cloneBytes),
		inclusionIndex: input.inclusionIndex,
		inclusionProof: {
			auditPath: input.inclusionProof.auditPath.map(cloneBytes),
			leafIndex: input.inclusionProof.leafIndex,
			treeSize: input.inclusionProof.treeSize,
		},
		leaves: input.leaves.map(cloneBytes),
		linearizeOptions: Object.freeze({ anchorHash: input.anchorHash, mode: "none", vertices: graph }),
		missingResolverOptions: Object.freeze({ anchorHash: input.anchorHash, mode: "pair", vertices: graph }),
		order: [...input.order],
		proofPath: input.proofPath.map(cloneBytes),
		queryLeft: input.queryLeft,
		queryRight: input.queryRight,
		secondRoot: cloneBytes(input.secondRoot),
		value: structuredClone(input.value),
	};
}

/**
 *
 * @param input
 */
export function materializePeerSlots(input: Readonly<PeerSlot>): PeerSlots {
	return { currentSlot: materializeSlot(input), originalSlot: materializeSlot(input) };
}

/**
 *
 * @param lines
 */
export function transcriptSha256(lines: readonly string[]): string {
	return createHash("sha256")
		.update(`${lines.join("\n")}\n`)
		.digest("hex");
}

export const ORDINARY_TRANSCRIPT_SHA256 = "0721284313221e6d4d311f228c6b31363a30f5821f4c9215ffe34ebd7fdef107";
export const EXPANDED_TRANSCRIPT_SHA256 = "9cd46d5bf0dc96cfa377994fd0291abe3c6f2dcebac3a002a54abdd12ac0f551";
