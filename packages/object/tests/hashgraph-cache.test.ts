import { ActionType, DrpType, type Hash, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { describe, expect, test } from "vitest";

import { createHashGraph, HashGraph } from "../src/hashgraph/index.js";

function operation(value: number): Operation {
	return Operation.create({ drpType: DrpType.DRP, opType: "add", value: [value] });
}

function createGraph(): HashGraph {
	return createHashGraph({ peerId: "peer", semanticsTypeDRP: SemanticsType.pair });
}

function addVertex(graph: HashGraph, value: number, dependencies: Hash[]): Vertex {
	const vertex = graph.createVertex(operation(value), dependencies, value);
	graph.addVertex(vertex);
	return vertex;
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function sample<T>(values: T[], count: number, random: () => number): T[] {
	const remaining = [...values];
	const result: T[] = [];
	while (result.length < count && remaining.length > 0) {
		result.push(remaining.splice(Math.floor(random() * remaining.length), 1)[0]);
	}
	return result;
}

function findBitsetDisagreements(graph: HashGraph, lcaCall: number): { count: number; first?: string } {
	const hashes = graph.getAllVertices().map((vertex) => vertex.hash);
	let count = 0;
	let first: string | undefined;
	for (let left = 0; left < hashes.length; left++) {
		for (let right = left + 1; right < hashes.length; right++) {
			const bfs = graph.areCausallyRelatedUsingBFS(hashes[left], hashes[right]);
			const bitsets = graph.areCausallyRelatedUsingBitsets(hashes[left], hashes[right]);
			if (bitsets !== bfs) {
				count++;
				first ??= `getLCA call=${lcaCall}, pair=${hashes[left]} / ${hashes[right]}, bitsets=${bitsets}, BFS=${bfs}`;
			}
		}
	}
	return { count, first };
}

describe("HashGraph reachability cache", () => {
	test("treats a vertex as causally related to itself", () => {
		const graph = createGraph();
		const vertex = addVertex(graph, 1, [HashGraph.rootHash]);

		expect(graph.areCausallyRelatedUsingBFS(vertex.hash, vertex.hash)).toBe(true);
		expect(graph.areCausallyRelatedUsingBitsets(vertex.hash, vertex.hash)).toBe(true);
	});

	test("keeps full-graph causality correct after getLCA linearizes a subgraph", () => {
		const graph = createGraph();
		const a = addVertex(graph, 1, [HashGraph.rootHash]);
		const b = addVertex(graph, 2, [a.hash]);
		const c = addVertex(graph, 3, [b.hash]);
		const d = addVertex(graph, 4, [b.hash]);

		expect(graph.areCausallyRelatedUsingBFS(a.hash, HashGraph.rootHash)).toBe(true);
		expect(graph.areCausallyRelatedUsingBitsets(a.hash, HashGraph.rootHash)).toBe(true);

		graph.getLCA([c.hash, d.hash]);

		expect(graph.areCausallyRelatedUsingBFS(a.hash, HashGraph.rootHash)).toBe(true);
		expect(graph.areCausallyRelatedUsingBitsets(a.hash, HashGraph.rootHash)).toBe(true);
	});

	test("agrees with BFS across seeded random DAGs after interleaved getLCA calls", () => {
		const seed = 0x5eed_0005;
		const random = seededRandom(seed);
		const graph = createGraph();

		for (let value = 1; value <= 50; value++) {
			const existing = graph.getAllVertices().map((vertex) => vertex.hash);
			const dependencyCount = 1 + Math.floor(random() * Math.min(3, existing.length));
			addVertex(graph, value, sample(existing, dependencyCount, random));
		}

		let disagreementCount = 0;
		let firstDisagreement: string | undefined;
		for (let lcaCall = 1; lcaCall <= 4; lcaCall++) {
			const frontier = graph.getFrontier();
			expect(frontier.length, `seed=${seed} must retain a concurrent frontier`).toBeGreaterThanOrEqual(2);
			const dependencyCount = 2 + Math.floor(random() * Math.min(3, frontier.length - 1));
			graph.getLCA(sample(frontier, dependencyCount, random));
			const disagreements = findBitsetDisagreements(graph, lcaCall);
			disagreementCount += disagreements.count;
			firstDisagreement ??= disagreements.first;
		}

		expect({ disagreementCount, firstDisagreement }, `seed=${seed}`).toEqual({
			disagreementCount: 0,
			firstDisagreement: undefined,
		});
	});

	test("does not alias a vertex outside the last linearized subgraph to root", () => {
		const graph = createGraph();
		const a = addVertex(graph, 1, [HashGraph.rootHash]);
		const b = addVertex(graph, 2, [HashGraph.rootHash]);
		const outsideSubgraph = addVertex(graph, 3, [HashGraph.rootHash]);

		graph.getLCA([a.hash, b.hash]);

		expect(graph.areCausallyRelatedUsingBFS(a.hash, outsideSubgraph.hash)).toBe(false);
		expect(graph.areCausallyRelatedUsingBitsets(a.hash, outsideSubgraph.hash)).toBe(false);
	});

	test("keeps shared causality intact after a Swap linearization", () => {
		let swapped = false;
		const graph = new HashGraph(
			"peer",
			undefined,
			() => {
				if (swapped) return { action: ActionType.Nop };
				swapped = true;
				return { action: ActionType.Swap };
			},
			SemanticsType.pair
		);
		const left = addVertex(graph, 1, [HashGraph.rootHash]);
		const right = addVertex(graph, 2, [HashGraph.rootHash]);

		graph.areCausallyRelatedUsingBitsets(left.hash, HashGraph.rootHash);
		graph.linearizeVertices();
		expect(swapped).toBe(true);

		expect(graph.areCausallyRelatedUsingBitsets(left.hash, HashGraph.rootHash)).toBe(
			graph.areCausallyRelatedUsingBFS(left.hash, HashGraph.rootHash)
		);
		expect(graph.areCausallyRelatedUsingBitsets(left.hash, right.hash)).toBe(
			graph.areCausallyRelatedUsingBFS(left.hash, right.hash)
		);
	});
});
