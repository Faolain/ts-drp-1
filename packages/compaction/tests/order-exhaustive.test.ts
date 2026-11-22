import { HashGraph } from "@ts-drp/object";
import { DrpType, Operation, Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { type CompactionModule, type EpochVertex, errorCode, loadCompaction, sourceExists } from "./contract.js";
import {
	ANCHOR_HASH,
	corpusHash,
	enumerateCorpus,
	hashForIndex,
	insertionPermutations,
	makeGraph,
	NIGHTLY_CORPUS_COUNT,
	NIGHTLY_CORPUS_SHA256,
	OBJECT_ID,
	PR_CORPUS_COUNT,
	PR_CORPUS_SHA256,
	referenceOrder,
} from "./corpus.js";

const runNightly = process.env.RUN_PHASE_0B_NIGHTLY === "true";

function smallValidGraph(): Map<string, EpochVertex> {
	return makeGraph({
		ancestorMasks: [0, 1, 1, 7],
		dependencies: [[], [0], [0], [1, 2]],
	});
}

function expectCode(module: CompactionModule, vertices: Map<string, EpochVertex>, code: string): void {
	expect(errorCode(() => module.topologicalOrder(vertices, ANCHOR_HASH))).toBe(code);
}

function boundedFactorial(value: number, limit = 8): number {
	let result = 1;
	for (let factor = 2; factor <= value && result < limit; factor++) result *= factor;
	return Math.min(result, limit);
}

describe.skipIf(!sourceExists)("Phase 0b exhaustive order contract", () => {
	it("hash-pins every insertion-labelled direct-antichain DAG through six vertices", async () => {
		const module = await loadCompaction();
		const corpus = enumerateCorpus(6);
		expect(corpus).toHaveLength(PR_CORPUS_COUNT);
		expect(corpusHash(corpus)).toBe(PR_CORPUS_SHA256);

		for (const [graphIndex, shape] of corpus.entries()) {
			const graph = makeGraph(shape);
			const expected = referenceOrder(graph);
			const observed = new Set<string>();
			const permutations = insertionPermutations(graph);
			const insertionOrders = new Set(permutations.map((vertices) => [...vertices.keys()].join(",")));
			expect(insertionOrders.size, `graph=${graphIndex}`).toBe(boundedFactorial(graph.size));
			for (const [permutation, vertices] of permutations.entries()) {
				const actual = module.topologicalOrder(vertices, ANCHOR_HASH);
				expect(actual, `graph=${graphIndex} permutation=${permutation}`).toEqual(expected);
				observed.add(actual.join(","));
			}
			expect(observed.size, `graph=${graphIndex}`).toBe(1);
		}
	});

	it.skipIf(!runNightly)(
		"hash-pins the separately opt-in cumulative 5,231-graph corpus through seven vertices",
		async () => {
			const module = await loadCompaction();
			const corpus = enumerateCorpus(7);
			expect(corpus).toHaveLength(NIGHTLY_CORPUS_COUNT);
			expect(corpusHash(corpus)).toBe(NIGHTLY_CORPUS_SHA256);
			for (const [graphIndex, shape] of corpus.entries()) {
				const graph = makeGraph(shape);
				const expected = referenceOrder(graph);
				const observed = new Set<string>();
				const permutations = insertionPermutations(graph);
				const insertionOrders = new Set(permutations.map((vertices) => [...vertices.keys()].join(",")));
				expect(insertionOrders.size, `nightly graph=${graphIndex}`).toBe(boundedFactorial(graph.size));
				for (const [permutation, vertices] of permutations.entries()) {
					const actual = module.topologicalOrder(vertices, ANCHOR_HASH);
					expect(actual, `nightly graph=${graphIndex} permutation=${permutation}`).toEqual(expected);
					observed.add(actual.join(","));
				}
				expect(observed.size, `nightly graph=${graphIndex}`).toBe(1);
			}
		}
	);

	it("builds exact causality and rejects an invalid supplied order", async () => {
		const module = await loadCompaction();
		const vertices = smallValidGraph();
		const order = module.topologicalOrder(vertices, ANCHOR_HASH);
		const causality = new module.CausalityIndex(vertices, order);
		const hashes = Array.from({ length: 4 }, (_, index) => hashForIndex(index));
		expect(causality.isAncestor(hashes[0], hashes[3])).toBe(true);
		expect(causality.isAncestor(hashes[1], hashes[3])).toBe(true);
		expect(causality.isAncestor(hashes[1], hashes[2])).toBe(false);
		expect(causality.isAncestor(hashes[3], hashes[3])).toBe(false);
		expect(causality.isAncestor("f".repeat(64), hashes[3])).toBe(false);
		expect(causality.areRelated(hashes[2], hashes[2])).toBe(true);
		expect(causality.areRelated(hashes[1], hashes[2])).toBe(false);
		expect(() => new module.CausalityIndex(vertices, [hashes[0], hashes[3], hashes[1], hashes[2]])).toThrow();
		expect(() => new module.CausalityIndex(vertices, [hashes[0], "f".repeat(64)])).toThrow();
	});

	it("fails closed on malformed, incomplete, wrong-epoch, cyclic, and non-antichain graphs", async () => {
		const module = await loadCompaction();
		expect(() => module.topologicalOrder({} as unknown as Map<string, EpochVertex>, ANCHOR_HASH)).toThrow(TypeError);

		const missingAnchor = smallValidGraph();
		missingAnchor.delete(ANCHOR_HASH);
		expectCode(module, missingAnchor, "MISSING_ANCHOR");

		const invalidAnchor = smallValidGraph();
		invalidAnchor.set(ANCHOR_HASH, {
			...(invalidAnchor.get(ANCHOR_HASH) as EpochVertex),
			dependencies: [hashForIndex(1)],
		});
		expectCode(module, invalidAnchor, "INVALID_ANCHOR");

		const keyMismatch = smallValidGraph();
		const vertexOne = keyMismatch.get(hashForIndex(1)) as EpochVertex;
		keyMismatch.delete(hashForIndex(1));
		keyMismatch.set("e".repeat(64), vertexOne);
		expectCode(module, keyMismatch, "KEY_HASH_MISMATCH");

		const wrongEpoch = smallValidGraph();
		wrongEpoch.set(hashForIndex(1), { ...(wrongEpoch.get(hashForIndex(1)) as EpochVertex), epoch: 4 });
		expectCode(module, wrongEpoch, "WRONG_EPOCH");

		const missingDependency = smallValidGraph();
		missingDependency.set(hashForIndex(1), {
			...(missingDependency.get(hashForIndex(1)) as EpochVertex),
			dependencies: ["f".repeat(64)],
		});
		expectCode(module, missingDependency, "MISSING_DEPENDENCY");

		const multipleRoots = smallValidGraph();
		multipleRoots.set(hashForIndex(1), {
			...(multipleRoots.get(hashForIndex(1)) as EpochVertex),
			dependencies: [],
		});
		expectCode(module, multipleRoots, "MULTIPLE_ROOTS");

		const cyclic = smallValidGraph();
		cyclic.set(hashForIndex(1), {
			...(cyclic.get(hashForIndex(1)) as EpochVertex),
			dependencies: [hashForIndex(3)],
		});
		expectCode(module, cyclic, "CYCLE");

		const nonAntichain = smallValidGraph();
		nonAntichain.set(hashForIndex(3), {
			...(nonAntichain.get(hashForIndex(3)) as EpochVertex),
			dependencies: [hashForIndex(0), hashForIndex(1)],
		});
		expectCode(module, nonAntichain, "NON_ANTICHAIN_DEPENDENCIES");
		expect(module.topologicalOrder(nonAntichain, ANCHOR_HASH, { enforceDependencyAntichain: false })).toHaveLength(4);
	});

	it("pins the real legacy origin-sensitive divergence without pretending Gate G-b exists", async () => {
		const module = await loadCompaction();
		const legacyPeerId = "phase-0b-legacy";
		const hashForLabel = (label: number): string => (label + 1).toString(16).padStart(64, "0");
		const makeLegacyVertex = (label: number, dependencies: number[]): ReturnType<typeof Vertex.create> =>
			Vertex.create({
				dependencies: dependencies.map(hashForLabel),
				hash: hashForLabel(label),
				operation: Operation.create({
					drpType: DrpType.DRP,
					opType: "op",
					value: [label],
				}),
				peerId: legacyPeerId,
				signature: new Uint8Array(),
				timestamp: 20_000 + label,
			});
		const edges: Array<[number, number[]]> = [
			[0, []],
			[1, [0]],
			[2, [1]],
			[3, [1]],
			[4, [0, 2]],
		];
		const graph = new HashGraph(legacyPeerId);
		for (const [label, dependencyLabels] of edges) {
			graph.addVertex(makeLegacyVertex(label, dependencyLabels));
		}
		const originalSuffix = new Set([1, 2, 3, 4].map(hashForLabel));
		const fullTail = graph
			.dfsTopologicalSortIterative(hashForLabel(1), originalSuffix)
			.map((hash) => Number.parseInt(hash, 16) - 1)
			.slice(1);

		const contractedGraph = new HashGraph(legacyPeerId);
		const contractedEdges: Array<[number, number[]]> = [
			[1, []],
			[2, [1]],
			[3, [1]],
			[4, [1, 2]],
		];
		for (const [label, dependencies] of contractedEdges) {
			contractedGraph.addVertex(makeLegacyVertex(label, dependencies));
		}
		const contractedTail = contractedGraph
			.dfsTopologicalSortIterative(hashForLabel(1), new Set(contractedEdges.map(([label]) => hashForLabel(label))))
			.map((hash) => Number.parseInt(hash, 16) - 1)
			.slice(1);
		expect(fullTail).toEqual([2, 4, 3]);
		expect(contractedTail).toEqual([2, 3, 4]);

		const candidateVertices = new Map<string, EpochVertex>();
		for (const [label, dependencyLabels] of edges) {
			const hash = hashForLabel(label);
			if (label === 0) {
				candidateVertices.set(hash, {
					dependencies: [],
					epoch: 8,
					hash,
					kind: "drp-epoch-anchor",
					objectId: OBJECT_ID,
				});
				continue;
			}
			candidateVertices.set(hash, {
				anchor: hashForLabel(0),
				dependencies: dependencyLabels.map(hashForLabel),
				epoch: 8,
				hash,
				kind: "drp-vertex",
				objectId: OBJECT_ID,
			});
		}
		expect(errorCode(() => module.topologicalOrder(candidateVertices, hashForLabel(0)))).toBe(
			"NON_ANTICHAIN_DEPENDENCIES"
		);
		const candidatePermutations = insertionPermutations(candidateVertices);
		expect(new Set(candidatePermutations.map((vertices) => [...vertices.keys()].join(","))).size).toBe(
			boundedFactorial(candidateVertices.size)
		);
		const candidateOrders = new Set(
			candidatePermutations.map((vertices) =>
				module
					.topologicalOrder(vertices, hashForLabel(0), {
						enforceDependencyAntichain: false,
					})
					.join(",")
			)
		);
		expect(candidateOrders.size).toBe(1);
	});
});
