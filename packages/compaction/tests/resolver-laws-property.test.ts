import { describe, expect, it } from "vitest";

import { type EpochVertex, loadCompaction, sourceExists } from "./contract.js";
import {
	ANCHOR_HASH,
	type CorpusGraph,
	corpusHash,
	enumerateCorpus,
	hashForIndex,
	insertionPermutations,
	makeGraph,
	PR_CORPUS_COUNT,
	PR_CORPUS_SHA256,
	referenceOrder,
} from "./corpus.js";
import { PHASE_0B_RESOLVER_LAWS_TIMEOUT_MS } from "./test-timeouts.js";

const partitions = [
	(_index: number): string => "all",
	(index: number): string => `parity-${index % 2}`,
	(index: number): string => `thirds-${index % 3}`,
] as const;

function relatedByIndependentAncestry(shape: CorpusGraph, leftHash: string, rightHash: string): boolean {
	const left = Array.from({ length: shape.dependencies.length }, (_, index) => hashForIndex(index)).indexOf(leftHash);
	const right = Array.from({ length: shape.dependencies.length }, (_, index) => hashForIndex(index)).indexOf(rightHash);
	if (left < 0 || right < 0) throw new Error("oracle received a hash outside the corpus graph");
	return (
		left === right ||
		((shape.ancestorMasks[left] as number) & (1 << right)) !== 0 ||
		((shape.ancestorMasks[right] as number) & (1 << left)) !== 0
	);
}

function expectedPairCalls(shape: CorpusGraph, order: readonly string[]): string[][] {
	const calls: string[][] = [];
	for (let left = 0; left < order.length; left++) {
		for (let right = left + 1; right < order.length; right++) {
			const leftHash = order[left] as string;
			const rightHash = order[right] as string;
			if (!relatedByIndependentAncestry(shape, leftHash, rightHash)) calls.push([leftHash, rightHash]);
		}
	}
	return calls;
}

function expectedMultipleGroups(
	shape: CorpusGraph,
	order: readonly string[],
	keyForHash: ReadonlyMap<string, string>
): string[][] {
	const groups: string[][] = [];
	const consumed = new Set<string>();
	for (const hash of order) {
		if (consumed.has(hash)) continue;
		const key = keyForHash.get(hash);
		const group = [hash];
		for (const candidate of order) {
			if (candidate === hash || consumed.has(candidate) || keyForHash.get(candidate) !== key) continue;
			if (group.every((member) => !relatedByIndependentAncestry(shape, member, candidate))) group.push(candidate);
		}
		for (const member of group) consumed.add(member);
		groups.push(group);
	}
	return groups;
}

function hashes(output: readonly EpochVertex[]): string[] {
	return output.map((vertex) => vertex.hash);
}

describe.skipIf(!sourceExists)("Phase 0b resolver-law corpus", () => {
	it(
		"drives pair and multiple resolution through the hash-pinned corpus across real insertion permutations and partitions",
		async () => {
			const module = await loadCompaction();
			const corpus = enumerateCorpus(6);
			expect(corpus).toHaveLength(PR_CORPUS_COUNT);
			expect(corpusHash(corpus)).toBe(PR_CORPUS_SHA256);

			for (const [graphIndex, shape] of corpus.entries()) {
				for (const [partitionIndex, partition] of partitions.entries()) {
					const graph = makeGraph(shape, (index) => ({
						conflictKey: partition(index),
						value: { graphIndex, index, partitionIndex },
					}));
					const expectedOrder = referenceOrder(graph).filter((hash) => hash !== ANCHOR_HASH);
					const expectedPairs = expectedPairCalls(shape, expectedOrder);
					const keys = new Map(expectedOrder.map((hash) => [hash, graph.get(hash)?.operation?.conflictKey as string]));
					const expectedGroups = expectedMultipleGroups(shape, expectedOrder, keys);
					const expectedMultipleCalls = expectedGroups.filter((group) => group.length > 1);
					const permutations = insertionPermutations(graph);
					const insertionOrders = new Set(permutations.map((vertices) => [...vertices.keys()].join(",")));
					expect(insertionOrders.size).toBe(permutations.length);

					for (const [permutationIndex, vertices] of permutations.entries()) {
						const pairCalls: string[][] = [];
						const pairOutput = module.linearizeEpoch({
							anchorHash: ANCHOR_HASH,
							mode: "pair",
							resolveConflicts: (pair) => {
								pairCalls.push(pair.map((vertex) => vertex.hash));
								return { action: "Nop" };
							},
							vertices,
						});
						expect(pairCalls, `pair graph=${graphIndex} partition=${partitionIndex} perm=${permutationIndex}`).toEqual(
							expectedPairs
						);
						expect(hashes(pairOutput)).toEqual(expectedOrder);

						const multipleCalls: string[][] = [];
						const multipleOutput = module.linearizeEpoch({
							anchorHash: ANCHOR_HASH,
							mode: "multiple",
							resolveConflicts: (group) => {
								multipleCalls.push(group.map((vertex) => vertex.hash));
								return { action: "Nop" };
							},
							vertices,
						});
						expect(
							multipleCalls,
							`multiple graph=${graphIndex} partition=${partitionIndex} perm=${permutationIndex}`
						).toEqual(expectedMultipleCalls);
						expect(hashes(multipleOutput)).toEqual(expectedOrder);
						expect(new Set(hashes(multipleOutput))).toEqual(new Set(expectedOrder));
					}
				}
			}
		},
		PHASE_0B_RESOLVER_LAWS_TIMEOUT_MS
	);
});
