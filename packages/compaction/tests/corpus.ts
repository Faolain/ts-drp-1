import { createHash } from "node:crypto";

import { type EpochVertex } from "./contract.js";

export interface CorpusGraph {
	ancestorMasks: number[];
	dependencies: number[][];
}

export const ANCHOR_HASH = createHash("sha256").update("phase-0b-anchor").digest("hex");
export const OBJECT_ID = "phase-0b-object";
export const PR_CORPUS_COUNT = 407;
export const PR_CORPUS_SHA256 = "70388c6d344b32ceb693995855ab05ee20d729bf67c75807dfb0489d47e071f3";
export const NIGHTLY_CORPUS_COUNT = 5_231;
export const NIGHTLY_CORPUS_SHA256 = "5baf083b05d63fdba3fda38d09da1be2246f4e9acb4ff7f25043e7eb40554351";

/**
 * Derives the fixed digest used for one insertion-labelled corpus vertex.
 * @param index - Topological insertion label.
 * @returns The anchor digest at zero or the independently derived vertex digest.
 */
export function hashForIndex(index: number): string {
	return index === 0 ? ANCHOR_HASH : createHash("sha256").update(`phase-0b-vertex-${index}`).digest("hex");
}

/**
 * Enumerates cumulative insertion-labelled DAGs with direct antichain dependencies.
 * @param maximumVertexCount - Inclusive graph-size ceiling.
 * @returns Every generated graph from size two through the ceiling.
 */
export function enumerateCorpus(maximumVertexCount: number): CorpusGraph[] {
	let previous: CorpusGraph[] = [{ ancestorMasks: [0], dependencies: [[]] }];
	const cumulative: CorpusGraph[] = [];
	for (let vertexCount = 2; vertexCount <= maximumVertexCount; vertexCount++) {
		const next: CorpusGraph[] = [];
		for (const graph of previous) {
			const nextIndex = graph.dependencies.length;
			for (let dependencyMask = 1; dependencyMask < 1 << nextIndex; dependencyMask++) {
				const dependencies = Array.from({ length: nextIndex }, (_, index) => index).filter(
					(index) => (dependencyMask & (1 << index)) !== 0
				);
				const antichain = dependencies.every((left, leftIndex) =>
					dependencies
						.slice(leftIndex + 1)
						.every(
							(right) =>
								(graph.ancestorMasks[left] & (1 << right)) === 0 && (graph.ancestorMasks[right] & (1 << left)) === 0
						)
				);
				if (!antichain) continue;
				const ancestorMask = dependencies.reduce(
					(mask, dependency) => mask | (1 << dependency) | graph.ancestorMasks[dependency],
					0
				);
				next.push({
					ancestorMasks: [...graph.ancestorMasks, ancestorMask],
					dependencies: [...graph.dependencies, dependencies],
				});
			}
		}
		previous = next;
		cumulative.push(...next);
	}
	return cumulative;
}

function serializeCorpus(corpus: readonly CorpusGraph[]): string {
	return corpus.map((graph) => graph.dependencies.map((dependencies) => dependencies.join(",")).join("|")).join("\n");
}

/**
 * Hashes the stable textual corpus representation.
 * @param corpus - Corpus graphs to bind.
 * @returns Lowercase SHA-256 digest.
 */
export function corpusHash(corpus: readonly CorpusGraph[]): string {
	return createHash("sha256").update(serializeCorpus(corpus)).digest("hex");
}

/**
 * Materializes a corpus shape as an epoch graph.
 * @param shape - Dependency and ancestry masks.
 * @param operationForIndex - Optional deterministic operation factory.
 * @returns Active-epoch vertices keyed by digest.
 */
export function makeGraph(
	shape: CorpusGraph,
	operationForIndex?: (index: number) => NonNullable<EpochVertex["operation"]>
): Map<string, EpochVertex> {
	const vertices = new Map<string, EpochVertex>();
	for (let index = 0; index < shape.dependencies.length; index++) {
		const hash = hashForIndex(index);
		vertices.set(
			hash,
			index === 0
				? {
						dependencies: [],
						epoch: 3,
						hash,
						kind: "drp-epoch-anchor",
						objectId: OBJECT_ID,
					}
				: {
						anchor: ANCHOR_HASH,
						dependencies: shape.dependencies[index].map(hashForIndex),
						epoch: 3,
						hash,
						kind: "drp-vertex",
						objectId: OBJECT_ID,
						...(operationForIndex === undefined ? {} : { operation: operationForIndex(index) }),
					}
		);
	}
	return vertices;
}

/**
 * Enumerates up to eight genuinely distinct insertion orders. Small maps return
 * only their mathematical maximum instead of relabelling duplicate shuffles.
 * For larger maps, the first entry appears at the beginning, middle and end
 * before the remaining anchor positions are sampled.
 * @param input - Source map.
 * @param limit - Maximum distinct insertion orders.
 * @returns New maps with pairwise-distinct insertion orders.
 */
export function insertionPermutations<T>(input: ReadonlyMap<string, T>, limit = 8): Map<string, T>[] {
	const entries = [...input.entries()];
	if (entries.length === 0) return limit > 0 ? [new Map()] : [];

	const anchor = entries[0] as [string, T];
	const remaining = entries.slice(1);
	const anchorPositions = [
		...new Set([0, Math.floor(entries.length / 2), entries.length - 1, ...entries.map((_, index) => index)]),
	];
	const output: Map<string, T>[] = [];
	const used = new Array<boolean>(remaining.length).fill(false);
	const current: Array<[string, T]> = [];
	const visit = (): void => {
		if (output.length >= limit) return;
		if (current.length === remaining.length) {
			for (const anchorPosition of anchorPositions) {
				const permutation = [...current];
				permutation.splice(anchorPosition, 0, anchor);
				output.push(new Map(permutation));
				if (output.length >= limit) return;
			}
			return;
		}
		for (let index = 0; index < remaining.length; index++) {
			if (used[index]) continue;
			used[index] = true;
			current.push(remaining[index] as [string, T]);
			visit();
			current.pop();
			used[index] = false;
			if (output.length >= limit) return;
		}
	};
	visit();
	return output;
}

/**
 * Computes an independent sort-based minimum-hash Kahn order.
 * @param vertices - Complete graph.
 * @returns Dependency-before-child hashes with lexical tie breaking.
 */
export function referenceOrder(vertices: ReadonlyMap<string, EpochVertex>): string[] {
	const indegree = new Map([...vertices].map(([hash, vertex]) => [hash, vertex.dependencies.length]));
	const children = new Map([...vertices.keys()].map((hash) => [hash, [] as string[]]));
	for (const [hash, vertex] of vertices) {
		for (const dependency of vertex.dependencies) children.get(dependency)?.push(hash);
	}
	const ready = [...indegree].filter(([, degree]) => degree === 0).map(([hash]) => hash);
	const order: string[] = [];
	while (ready.length > 0) {
		ready.sort();
		const hash = ready.shift() as string;
		order.push(hash);
		for (const child of children.get(hash) ?? []) {
			const degree = (indegree.get(child) as number) - 1;
			indegree.set(child, degree);
			if (degree === 0) ready.push(child);
		}
	}
	return order;
}
