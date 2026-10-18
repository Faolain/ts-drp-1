/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion, import/no-duplicates, import/order, jsdoc/require-jsdoc -- frozen tests-only AST contract requires separate peer namespaces and direct expressions */
import * as currentCanonical from "../../../packages/canonical/dist/src/index.js";
import * as currentLinearize from "../../../packages/compaction/dist/src/index.js";
import * as currentMerkle from "../../../packages/compaction/dist/src/index.js";
import * as originalCanonical from "../../../packages/protocol-v2/conformance/ahe-reference/src/canonical.js";
import * as originalHash from "../../../packages/protocol-v2/conformance/ahe-reference/src/hash.js";
import * as originalLinearize from "../../../packages/protocol-v2/conformance/ahe-reference/src/linearize.js";
import * as originalMerkle from "../../../packages/protocol-v2/conformance/ahe-reference/src/ct-merkle.js";

import { BATCH_OPTIONS, ORDER_OPTIONS, type PeerSlot, RANGE_START } from "./contract.js";

export async function runCanonicalPair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalEncoded = originalCanonical.encodeCanonical(originalSlot.value);
	const currentEncoded = currentCanonical.encodeCanonical(currentSlot.value);
	const originalClone = originalCanonical.deepCloneCanonical(originalSlot.value);
	const currentClone = currentCanonical.deepCloneCanonical(currentSlot.value);
	const originalCompare = originalHash.compareBytes(originalSlot.compareLeft, originalSlot.compareRight);
	const currentCompare = currentCanonical.compareBytes(currentSlot.compareLeft, currentSlot.compareRight);
	const originalDigest = await originalHash.hashDomain(originalSlot.hashDomain, ...originalSlot.hashParts);
	const currentDigest = currentCanonical.hashDomain(currentSlot.hashDomain, ...currentSlot.hashParts);
	return {
		original: {
			encoded: originalEncoded,
			clone: originalClone,
			compare: originalCompare,
			digest: originalDigest,
		},
		current: {
			encoded: currentEncoded,
			clone: currentClone,
			compare: currentCompare,
			digest: currentDigest,
		},
	};
}

export function runDecodePair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalValue = originalCanonical.decodeCanonical(originalSlot.decodeBytes);
	const currentValue = currentCanonical.decodeCanonical(currentSlot.decodeBytes);
	return { original: originalValue, current: currentValue };
}

export function runOrderPair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalValue = originalLinearize.topologicalOrder(originalSlot.graph, originalSlot.anchorHash, ORDER_OPTIONS);
	const currentValue = currentLinearize.topologicalOrder(currentSlot.graph, currentSlot.anchorHash, ORDER_OPTIONS);
	return { original: originalValue, current: currentValue };
}

export function runAncestorPair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalIndex = new originalLinearize.CausalityIndex(originalSlot.graph, originalSlot.order);
	const currentIndex = new currentLinearize.CausalityIndex(currentSlot.graph, currentSlot.order);
	const originalValue = originalIndex.isAncestor(originalSlot.queryLeft, originalSlot.queryRight);
	const currentValue = currentIndex.isAncestor(currentSlot.queryLeft, currentSlot.queryRight);
	return { original: originalValue, current: currentValue };
}

export function runRelatedPair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalIndex = new originalLinearize.CausalityIndex(originalSlot.graph, originalSlot.order);
	const currentIndex = new currentLinearize.CausalityIndex(currentSlot.graph, currentSlot.order);
	const originalValue = originalIndex.areRelated(originalSlot.queryLeft, originalSlot.queryRight);
	const currentValue = currentIndex.areRelated(currentSlot.queryLeft, currentSlot.queryRight);
	return { original: originalValue, current: currentValue };
}

export function runLinearizePair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalValue = originalLinearize.linearizeEpoch(originalSlot.linearizeOptions);
	const currentValue = currentLinearize.linearizeEpoch(currentSlot.linearizeOptions);
	return { original: originalValue, current: currentValue };
}

export function runD2Pair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalValue = originalCanonical.encodeCanonical(originalSlot.value);
	const currentValue = currentCanonical.encodeCanonical(currentSlot.value);
	return { original: originalValue, current: currentValue };
}

export async function runAliasedInclusionPair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalValue = await originalMerkle.verifyInclusion(
		originalSlot.leaves[originalSlot.inclusionIndex]!,
		originalSlot.aliasedInclusionProof,
		originalSlot.secondRoot
	);
	const currentValue = currentMerkle.verifyInclusion(
		currentSlot.leaves[currentSlot.inclusionIndex]!,
		currentSlot.aliasedInclusionProof,
		currentSlot.secondRoot
	);
	return { original: originalValue, current: currentValue };
}

export function runOriginalMissingResolver(originalSlot: PeerSlot) {
	const originalValue = originalLinearize.linearizeEpoch(originalSlot.missingResolverOptions);
	return originalValue;
}

export function runCurrentMissingResolver(currentSlot: PeerSlot) {
	const currentValue = currentLinearize.linearizeEpoch(currentSlot.missingResolverOptions);
	return currentValue;
}

export async function runMerkleRootPair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalRoot = await originalMerkle.buildMerkleTree(originalSlot.leaves, BATCH_OPTIONS);
	const currentRoot = await currentMerkle.buildMerkleTree(currentSlot.leaves, BATCH_OPTIONS);
	return { original: originalRoot.root, current: currentRoot.root };
}

export async function runMerklePair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalLeafHash = await originalMerkle.merkleLeafHash(originalSlot.leaves[0]!);
	const currentLeafHash = currentMerkle.merkleLeafHash(currentSlot.leaves[0]!);
	const originalNodeHash = await originalMerkle.merkleNodeHash(originalSlot.firstRoot, originalSlot.secondRoot);
	const currentNodeHash = currentMerkle.merkleNodeHash(currentSlot.firstRoot, currentSlot.secondRoot);
	return {
		original: { leafHash: originalLeafHash, nodeHash: originalNodeHash },
		current: { leafHash: currentLeafHash, nodeHash: currentNodeHash },
	};
}

export async function runMerkleRangePair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalRangeTree = await originalMerkle.buildMerkleTree(originalSlot.leaves, BATCH_OPTIONS);
	const currentRangeTree = await currentMerkle.buildMerkleTree(currentSlot.leaves, BATCH_OPTIONS);
	const originalRangeHash = await originalRangeTree.hashRange(RANGE_START, originalSlot.leaves.length);
	const currentRangeHash = currentRangeTree.hashRange(RANGE_START, currentSlot.leaves.length);
	return {
		original: { rangeHash: originalRangeHash },
		current: { rangeHash: currentRangeHash },
	};
}

export async function runInclusionPair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalInclusionTree = await originalMerkle.buildMerkleTree(originalSlot.leaves, BATCH_OPTIONS);
	const currentInclusionTree = await currentMerkle.buildMerkleTree(currentSlot.leaves, BATCH_OPTIONS);
	const originalProof = await originalMerkle.inclusionProof(originalInclusionTree, originalSlot.inclusionIndex);
	const currentProof = currentMerkle.inclusionProof(currentInclusionTree, currentSlot.inclusionIndex);
	const originalValid = await originalMerkle.verifyInclusion(
		originalSlot.leaves[originalSlot.inclusionIndex]!,
		originalSlot.inclusionProof,
		originalSlot.secondRoot
	);
	const currentValid = currentMerkle.verifyInclusion(
		currentSlot.leaves[currentSlot.inclusionIndex]!,
		currentSlot.inclusionProof,
		currentSlot.secondRoot
	);
	return {
		original: { proof: originalProof, valid: originalValid },
		current: { proof: currentProof, valid: currentValid },
	};
}

export async function runConsistencyPair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalConsistencyTree = await originalMerkle.buildMerkleTree(originalSlot.leaves, BATCH_OPTIONS);
	const currentConsistencyTree = await currentMerkle.buildMerkleTree(currentSlot.leaves, BATCH_OPTIONS);
	const originalProof = await originalMerkle.consistencyProof(originalConsistencyTree, originalSlot.firstSize);
	const currentProof = currentMerkle.consistencyProof(currentConsistencyTree, currentSlot.firstSize);
	const originalValid = await originalMerkle.verifyConsistency(
		originalSlot.firstSize,
		originalSlot.leaves.length,
		originalSlot.firstRoot,
		originalSlot.secondRoot,
		originalSlot.proofPath
	);
	const currentValid = currentMerkle.verifyConsistency(
		currentSlot.firstSize,
		currentSlot.leaves.length,
		currentSlot.firstRoot,
		currentSlot.secondRoot,
		currentSlot.proofPath
	);
	return {
		original: { proof: originalProof, valid: originalValid },
		current: { proof: currentProof, valid: currentValid },
	};
}

export async function runAccumulatorPair(originalSlot: PeerSlot, currentSlot: PeerSlot) {
	const originalAccumulator = new originalMerkle.CompactMerkleAccumulator();
	const currentAccumulator = new currentMerkle.CompactMerkleAccumulator();
	const originalAppended = await originalAccumulator.appendMany(originalSlot.leaves, BATCH_OPTIONS);
	const currentAppended = await currentAccumulator.appendMany(currentSlot.leaves, BATCH_OPTIONS);
	const originalRoot = await originalAppended.root();
	const currentRoot = currentAppended.root();
	const originalSnapshotAccumulator = new originalMerkle.CompactMerkleAccumulator();
	const currentSnapshotAccumulator = new currentMerkle.CompactMerkleAccumulator();
	const originalSnapshotAppended = await originalSnapshotAccumulator.appendMany(originalSlot.leaves, BATCH_OPTIONS);
	const currentSnapshotAppended = await currentSnapshotAccumulator.appendMany(currentSlot.leaves, BATCH_OPTIONS);
	const originalSnapshot = originalSnapshotAppended.snapshot();
	const currentSnapshot = currentSnapshotAppended.snapshot();
	return {
		original: { root: originalRoot, snapshot: originalSnapshot },
		current: { root: currentRoot, snapshot: currentSnapshot },
	};
}
