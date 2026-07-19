import { AddMulDRP } from "@ts-drp/blueprints";
import {
	ActionType,
	DrpType,
	type Hash,
	Operation,
	type ResolveConflictsType,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { ObjectSet } from "@ts-drp/utils";
import { describe, expect, test } from "vitest";

import { createVertex, HashGraph } from "../src/hashgraph/index.js";

type Resolver = (vertices: Vertex[]) => ResolveConflictsType;
type Shape = "chain" | "fan" | "fan-merge" | "layered" | "random";
type Mode = "nop" | "drop-heavy" | "swap-heavy" | "mixed" | "addmul";

interface ReferenceGraph {
	vertices: Map<Hash, Vertex>;
	forwardEdges: Map<Hash, Hash[]>;
	resolveConflicts: Resolver;
}

interface BuiltGraph {
	graph: HashGraph;
	labels: Map<Hash, number>;
	reference: ReferenceGraph;
}

function topologicalSortReference(graph: ReferenceGraph, origin: Hash, subgraph: Set<Hash>): Hash[] {
	const visited = new Set<Hash>();
	const result = new Array<Hash>(subgraph.size);
	const stack = new Array<Hash>(subgraph.size);
	const processing = new Set<Hash>();
	let resultIndex = subgraph.size - 1;
	let stackIndex = 0;
	stack[stackIndex] = origin;

	while (resultIndex >= 0) {
		const node = stack[stackIndex];
		if (visited.has(node)) {
			result[resultIndex] = node;
			stackIndex--;
			resultIndex--;
			processing.delete(node);
			continue;
		}

		processing.add(node);
		visited.add(node);
		for (const neighbor of [...(graph.forwardEdges.get(node) ?? [])].sort()) {
			if (processing.has(neighbor)) throw new Error("Graph contains a cycle!");
			if (subgraph.has(neighbor) && !visited.has(neighbor)) {
				stackIndex++;
				stack[stackIndex] = neighbor;
			}
		}
	}

	return result;
}

interface LegacyCausality {
	reachable: Map<Hash, Set<number>>;
	topologicalIndex: Map<Hash, number>;
}

function buildLegacyCausality(graph: ReferenceGraph, order: Hash[]): LegacyCausality {
	const reachable = new Map<Hash, Set<number>>();
	const topologicalIndex = new Map<Hash, number>();

	for (let index = 0; index < order.length; index++) {
		const hash = order[index];
		topologicalIndex.set(hash, index);
		reachable.set(hash, new Set());
		for (const dependency of graph.vertices.get(hash)?.dependencies ?? []) {
			const dependencyReachable = reachable.get(dependency);
			// Literal HEAD behavior: `index || 0`, and mutate the dependency row
			// with its self bit before copying it into the current row.
			dependencyReachable?.add(topologicalIndex.get(dependency) || 0);
			if (dependencyReachable) {
				const current = reachable.get(hash);
				reachable.set(hash, new Set([...(current ?? []), ...dependencyReachable]));
			}
		}
	}

	return { reachable, topologicalIndex };
}

function relatedReference(cache: LegacyCausality, left: Hash, right: Hash): boolean {
	return (
		(cache.reachable.get(left)?.has(cache.topologicalIndex.get(right) || 0) ?? false) ||
		(cache.reachable.get(right)?.has(cache.topologicalIndex.get(left) || 0) ?? false)
	);
}

function swapReachablePredecessorsReference(cache: LegacyCausality, left: Hash, right: Hash): void {
	const leftReachable = cache.reachable.get(left);
	const rightReachable = cache.reachable.get(right);
	if (!leftReachable || !rightReachable) return;
	cache.reachable.set(left, rightReachable);
	cache.reachable.set(right, leftReachable);
}

function linearizePairReference(graph: ReferenceGraph, origin: Hash, subgraph: Set<Hash>): Vertex[] {
	const order = topologicalSortReference(graph, origin, subgraph);
	const cache = buildLegacyCausality(graph, order);
	const result: Vertex[] = [];
	const dropped = new Array<boolean>(order.length).fill(false);

	for (let i = 1; i < order.length; i++) {
		if (dropped[i]) continue;

		let anchor = order[i];
		let modified = false;
		for (let j = i + 1; j < order.length; j++) {
			if (dropped[j] || relatedReference(cache, anchor, order[j])) continue;

			const left = graph.vertices.get(anchor);
			const right = graph.vertices.get(order[j]);
			if (!left || !right) continue;

			switch (graph.resolveConflicts([left, right]).action) {
				case ActionType.DropLeft:
					dropped[i] = true;
					modified = true;
					break;
				case ActionType.DropRight:
					dropped[j] = true;
					break;
				case ActionType.Swap:
					swapReachablePredecessorsReference(cache, order[i], order[j]);
					[order[i], order[j]] = [order[j], order[i]];
					j = i + 1;
					anchor = order[i];
					break;
			}

			if (modified) break;
		}

		if (!dropped[i]) {
			const vertex = graph.vertices.get(order[i]);
			if (vertex) result.push(vertex);
		}
	}

	return result;
}

function linearizeMultipleReference(graph: ReferenceGraph, origin: Hash, subgraph: Set<Hash>): Vertex[] {
	const order = topologicalSortReference(graph, origin, subgraph);
	const cache = buildLegacyCausality(graph, order);
	const result: Vertex[] = [];
	const dropped = new Array<boolean>(order.length).fill(false);
	const indices = new Map<Hash, number>();
	let i = 1;

	while (i < order.length) {
		if (dropped[i]) {
			i++;
			continue;
		}
		const anchor = order[i];
		let j = i + 1;

		while (j < order.length) {
			if (relatedReference(cache, anchor, order[j]) || dropped[j]) {
				j++;
				continue;
			}

			const concurrent: Hash[] = [anchor, order[j]];
			indices.set(anchor, i);
			indices.set(order[j], j);
			for (let k = j + 1; k < order.length; k++) {
				if (dropped[k]) continue;
				if (concurrent.every((hash) => !relatedReference(cache, hash, order[k]))) {
					concurrent.push(order[k]);
					indices.set(order[k], k);
				}
			}

			const resolved = graph.resolveConflicts(concurrent.map((hash) => graph.vertices.get(hash) as Vertex));
			switch (resolved.action) {
				case ActionType.Drop:
					for (const hash of resolved.vertices ?? []) dropped[indices.get(hash) || -1] = true;
					if (dropped[i]) j = order.length;
					break;
				case ActionType.Nop:
					j++;
					break;
			}
		}

		if (!dropped[i]) {
			const vertex = graph.vertices.get(order[i]);
			if (vertex) result.push(vertex);
		}
		i++;
	}

	return result;
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function numericValue(vertex: Vertex): number {
	return Number(vertex.operation?.value[0] ?? 0);
}

function pairResolver(mode: Mode): Resolver {
	if (mode === "addmul") return new AddMulDRP().resolveConflicts.bind(new AddMulDRP());
	return (vertices) => {
		const left = numericValue(vertices[0]);
		const right = numericValue(vertices[1]);
		if (mode === "nop") return { action: ActionType.Nop };
		if (mode === "drop-heavy") {
			if ((left * 7 + right) % 5 === 0) return { action: ActionType.DropLeft };
			if ((left + right * 3) % 4 === 0) return { action: ActionType.DropRight };
			return { action: ActionType.Nop };
		}
		if ((mode === "swap-heavy" || (left + right) % 3 !== 0) && vertices[0].hash > vertices[1].hash) {
			return { action: ActionType.Swap };
		}
		if (mode === "mixed" && (left * 5 + right) % 7 === 0) return { action: ActionType.DropLeft };
		if (mode === "mixed" && (left + right * 11) % 9 === 0) return { action: ActionType.DropRight };
		return { action: ActionType.Nop };
	};
}

function multipleResolver(mode: Exclude<Mode, "swap-heavy" | "addmul">): Resolver {
	return (vertices) => {
		if (mode === "nop") return { action: ActionType.Nop };
		const candidates = vertices.filter((vertex) => {
			const value = numericValue(vertex);
			return mode === "drop-heavy" ? value % 3 !== 1 : (value * 7 + vertices.length) % 5 === 0;
		});
		return candidates.length > 0
			? { action: ActionType.Drop, vertices: candidates.map((vertex) => vertex.hash) }
			: { action: ActionType.Nop };
	};
}

function buildGraph(
	seed: number,
	shape: Shape,
	vertexCount: number,
	semantics: SemanticsType,
	resolver: Resolver
): BuiltGraph {
	const random = seededRandom(seed ^ (vertexCount * 65_537) ^ shape.length);
	const graph = new HashGraph(`peer-${seed}`, undefined, resolver, semantics);
	const hashes: Hash[] = [HashGraph.rootHash];
	const labels = new Map<Hash, number>([[HashGraph.rootHash, 0]]);
	const writers = ["a", "b", "c", "d", "e", "f"];
	const writerHeads = new Map<string, Hash>();

	const add = (label: number, dependencies: Hash[]): Hash => {
		const opType = label % 2 === 0 ? "add" : "mul";
		const writer = writers[label % writers.length];
		const vertex = createVertex(
			writer,
			Operation.create({ drpType: DrpType.DRP, opType, value: [label] }),
			dependencies,
			1_700_000_000_000 + seed * 1_000 + label
		);
		graph.addVertex(vertex);
		hashes.push(vertex.hash);
		labels.set(vertex.hash, label);
		writerHeads.set(writer, vertex.hash);
		return vertex.hash;
	};

	if (shape === "chain") {
		for (let label = 1; label <= vertexCount; label++) add(label, [hashes[hashes.length - 1]]);
	} else if (shape === "fan") {
		for (let label = 1; label <= vertexCount; label++) add(label, [HashGraph.rootHash]);
	} else if (shape === "fan-merge") {
		const fan: Hash[] = [];
		for (let label = 1; label < vertexCount; label++) fan.push(add(label, [HashGraph.rootHash]));
		add(vertexCount, fan);
	} else if (shape === "layered") {
		let previous: Hash[] = [HashGraph.rootHash];
		let label = 1;
		while (label <= vertexCount) {
			const next: Hash[] = [];
			const width = Math.min(vertexCount - label + 1, 2 + Math.floor(random() * 5));
			for (let offset = 0; offset < width; offset++, label++) next.push(add(label, previous));
			previous = next;
		}
	} else {
		for (let label = 1; label <= vertexCount; label++) {
			const writer = writers[Math.floor(random() * writers.length)];
			const dependencies: Hash[] = [];
			const ownHead = writerHeads.get(writer);
			if (ownHead && random() < 0.65) dependencies.push(ownHead);
			const desired = 1 + Math.floor(random() * Math.min(4, hashes.length));
			while (dependencies.length < desired) {
				const candidate = hashes[Math.floor(random() * hashes.length)];
				if (!dependencies.includes(candidate)) dependencies.push(candidate);
			}
			add(label, dependencies);
		}
	}

	const forwardEdges = new Map<Hash, Hash[]>();
	for (const hash of graph.vertices.keys()) forwardEdges.set(hash, []);
	for (const vertex of graph.vertices.values()) {
		for (const dependency of vertex.dependencies) forwardEdges.get(dependency)?.push(vertex.hash);
	}

	return { graph, labels, reference: { vertices: new Map(graph.vertices), forwardEdges, resolveConflicts: resolver } };
}

function labelOrder(vertices: Vertex[], labels: Map<Hash, number>): number[] {
	return vertices.map((vertex) => labels.get(vertex.hash) as number);
}

function lcaDependencies(graph: HashGraph, seed: number): Hash[] {
	const nonRoot = graph
		.getAllVertices()
		.map((vertex) => vertex.hash)
		.filter((hash) => hash !== HashGraph.rootHash);
	const random = seededRandom(seed * 97);
	const first = nonRoot[Math.floor(random() * nonRoot.length)];
	let second = first;
	while (second === first) second = nonRoot[Math.floor(random() * nonRoot.length)];
	return [first, second];
}

describe("linearizer legacy reference differential", () => {
	test("pair semantics split exactly at a causal checkpoint boundary", () => {
		for (const mode of ["nop", "drop-heavy", "swap-heavy", "mixed", "addmul"] as const) {
			const built = buildGraph(91 + mode.length, "chain", 0, SemanticsType.pair, pairResolver(mode));
			const byLabel = new Map<number, Hash>([[0, HashGraph.rootHash]]);
			const edges: Array<[number, number[]]> = [
				[1, [0]],
				[2, [0]],
				[3, [1, 2]],
				[4, [3]],
				[5, [3]],
				[6, [4, 5]],
				[7, [6]],
			];
			for (const [label, dependencies] of edges) {
				const vertex = createVertex(
					`writer-${label % 3}`,
					Operation.create({ drpType: DrpType.DRP, opType: label % 2 === 0 ? "add" : "mul", value: [label] }),
					dependencies.map((dependency) => byLabel.get(dependency) as Hash),
					2_000 + label
				);
				built.graph.addVertex(vertex);
				built.labels.set(vertex.hash, label);
				built.reference.vertices.set(vertex.hash, vertex);
				built.reference.forwardEdges.set(vertex.hash, []);
				for (const dependency of vertex.dependencies) built.reference.forwardEdges.get(dependency)?.push(vertex.hash);
				byLabel.set(label, vertex.hash);
			}

			const prefix = new Set([0, 1, 2, 3].map((label) => byLabel.get(label) as Hash));
			const suffix = new Set([3, 4, 5, 6, 7].map((label) => byLabel.get(label) as Hash));
			const full = new Set(built.reference.vertices.keys());
			const split = [
				...linearizePairReference(built.reference, HashGraph.rootHash, prefix),
				...linearizePairReference(built.reference, byLabel.get(3) as Hash, suffix),
			];
			expect(labelOrder(split, built.labels), mode).toEqual(
				labelOrder(linearizePairReference(built.reference, HashGraph.rootHash, full), built.labels)
			);
		}
	});

	test("pins the 9-vertex Swap regression to the literal legacy order", () => {
		const resolver: Resolver = (vertices) =>
			vertices[0].hash > vertices[1].hash ? { action: ActionType.Swap } : { action: ActionType.Nop };
		const built = buildGraph(9, "chain", 0, SemanticsType.pair, resolver);
		const byLabel = new Map<number, Hash>([[0, HashGraph.rootHash]]);
		const edges: Array<[number, number[]]> = [
			[1, [0]],
			[2, [0, 1]],
			[3, [1]],
			[4, [2, 1]],
			[5, [3, 2, 1, 0]],
			[6, [5]],
			[8, [2]],
			[9, [6, 5, 4]],
			[15, [8, 0, 4, 9]],
		];
		for (const [label, dependencies] of edges) {
			const vertex = createVertex(
				"p",
				Operation.create({ drpType: DrpType.DRP, opType: "op", value: [label] }),
				dependencies.map((dependency) => byLabel.get(dependency) as Hash),
				1_000 + label
			);
			built.graph.addVertex(vertex);
			built.labels.set(vertex.hash, label);
			built.reference.vertices.set(vertex.hash, vertex);
			built.reference.forwardEdges.set(vertex.hash, []);
			for (const dependency of vertex.dependencies) built.reference.forwardEdges.get(dependency)?.push(vertex.hash);
			byLabel.set(label, vertex.hash);
		}

		const subgraph = new Set(built.reference.vertices.keys());
		const reference = labelOrder(linearizePairReference(built.reference, HashGraph.rootHash, subgraph), built.labels);
		const actual = labelOrder(built.graph.linearizeVertices(), built.labels);

		expect(reference).toEqual([2, 8, 4, 5, 6, 3, 15, 9, 15]);
		expect(actual).toEqual(reference);
	});

	test("matches legacy pair/multiple control flow across full and LCA subgraphs", () => {
		const shapes: Shape[] = ["chain", "fan", "fan-merge", "layered", "random"];
		const boundarySizes = [31, 32, 33, 63, 64, 65];
		const configurations: Array<{ semantics: SemanticsType; mode: Mode; resolver: Resolver }> = [
			...(["nop", "drop-heavy", "swap-heavy", "mixed", "addmul"] as const).map((mode) => ({
				semantics: SemanticsType.pair,
				mode,
				resolver: pairResolver(mode),
			})),
			...(["nop", "drop-heavy", "mixed"] as const).map((mode) => ({
				semantics: SemanticsType.multiple,
				mode,
				resolver: multipleResolver(mode),
			})),
		];
		let graphsTested = 0;
		let lcaSubgraphsTested = 0;

		for (const [configurationIndex, configuration] of configurations.entries()) {
			const cases: Array<{ shape: Shape; size: number }> = [];
			for (const size of boundarySizes) {
				for (const shape of shapes) cases.push({ shape, size });
			}
			cases.push({ shape: "random", size: 257 });
			for (let extra = 0; extra < 7; extra++) {
				cases.push({ shape: "random", size: 10 + ((configurationIndex * 37 + extra * 19) % 81) });
			}

			for (const [caseIndex, graphCase] of cases.entries()) {
				const seed = 10_000 + configurationIndex * 1_000 + caseIndex;
				const built = buildGraph(
					seed,
					graphCase.shape,
					graphCase.size,
					configuration.semantics,
					configuration.resolver
				);
				const fullSubgraph = new Set(built.reference.vertices.keys());
				const referenceLinearize =
					configuration.semantics === SemanticsType.pair ? linearizePairReference : linearizeMultipleReference;
				const context = `${configuration.semantics}/${configuration.mode}/${graphCase.shape}/N=${graphCase.size}/seed=${seed}`;

				expect(labelOrder(built.graph.linearizeVertices(), built.labels), `full graph: ${context}`).toEqual(
					labelOrder(referenceLinearize(built.reference, HashGraph.rootHash, fullSubgraph), built.labels)
				);
				graphsTested++;

				const dependencies = lcaDependencies(built.graph, seed);
				const actualLca = built.graph.getLCA(dependencies);
				const referenceSubgraph = new ObjectSet<Hash>();
				const referenceLca = built.graph.lowestCommonAncestorMultipleVertices(dependencies, referenceSubgraph);
				expect(actualLca.lca, `LCA: ${context}`).toBe(referenceLca);
				expect(labelOrder(actualLca.linearizedVertices, built.labels), `LCA subgraph: ${context}`).toEqual(
					labelOrder(referenceLinearize(built.reference, referenceLca, referenceSubgraph), built.labels)
				);
				lcaSubgraphsTested++;
			}
		}

		console.info(`[linearize-reference] graphs=${graphsTested} full=${graphsTested} lca=${lcaSubgraphsTested} diffs=0`);
		expect(graphsTested).toBeGreaterThanOrEqual(300);
	}, 120_000);
});
