import { type Hash } from "@ts-drp/types";

import { type HashGraph } from "../hashgraph/index.js";

/**
 * Call-local reproduction of the legacy HashGraph predecessor cache.
 * Rows are keyed by hash, columns keep their original topological indices,
 * and pair Swap exchanges rows exactly like swapReachablePredecessors did.
 */
export class LegacyCausalityMatrix {
	private readonly matrix: Uint32Array;
	private readonly indexByHash = new Map<Hash, number>();
	private readonly wordsPerRow: number;

	/**
	 * Builds the cache from the call's fixed initial topological order.
	 * @param hashGraph - Graph containing the vertices and dependencies.
	 * @param order - Initial legacy topological order for the call.
	 */
	constructor(hashGraph: HashGraph, order: Hash[]) {
		this.wordsPerRow = Math.ceil(order.length / 32) || 1;
		this.matrix = new Uint32Array(order.length * this.wordsPerRow);
		for (let index = 0; index < order.length; index++) this.indexByHash.set(order[index], index);

		for (let index = 0; index < order.length; index++) {
			const destination = index * this.wordsPerRow;
			for (const dependency of hashGraph.vertices.get(order[index])?.dependencies ?? []) {
				const dependencyIndex = this.indexByHash.get(dependency);
				if (dependencyIndex === undefined) continue;

				const source = dependencyIndex * this.wordsPerRow;
				// HEAD mutated the dependency BitSet with its self bit before OR-ing
				// it into the current row (`topoSortedIndex.get(dep) || 0`).
				this.matrix[source + ((dependencyIndex / 32) | 0)] |= 1 << dependencyIndex % 32;
				for (let word = 0; word < this.wordsPerRow; word++) {
					this.matrix[destination + word] |= this.matrix[source + word];
				}
			}
		}
	}

	/**
	 * Checks either predecessor row at the other hash's fixed column.
	 * @param left - First vertex hash.
	 * @param right - Second vertex hash.
	 * @returns Whether the vertices are causally related in the local cache.
	 */
	areRelated(left: Hash, right: Hash): boolean {
		const leftIndex = this.indexByHash.get(left);
		const rightIndex = this.indexByHash.get(right);
		if (leftIndex === undefined || rightIndex === undefined) return false;

		return this.has(leftIndex, rightIndex) || this.has(rightIndex, leftIndex);
	}

	/**
	 * Exchanges rows without changing either hash's fixed column index.
	 * @param left - First vertex hash.
	 * @param right - Second vertex hash.
	 */
	swapReachablePredecessors(left: Hash, right: Hash): void {
		const leftIndex = this.indexByHash.get(left);
		const rightIndex = this.indexByHash.get(right);
		if (leftIndex === undefined || rightIndex === undefined) return;

		const leftOffset = leftIndex * this.wordsPerRow;
		const rightOffset = rightIndex * this.wordsPerRow;
		for (let word = 0; word < this.wordsPerRow; word++) {
			const value = this.matrix[leftOffset + word];
			this.matrix[leftOffset + word] = this.matrix[rightOffset + word];
			this.matrix[rightOffset + word] = value;
		}
	}

	private has(row: number, column: number): boolean {
		return (this.matrix[row * this.wordsPerRow + ((column / 32) | 0)] & (1 << column % 32)) !== 0;
	}
}
