import { ActionType, type Hash, type Vertex } from "@ts-drp/types";

import { LegacyCausalityMatrix } from "./legacyCausality.js";
import { type HashGraph } from "../hashgraph/index.js";

/**
 * Linearizes with the exact legacy anchor/j scan and Drop/Swap behavior.
 * Swap exchanges the two call-local predecessor rows before swapping the
 * topological-order entries, matching the old shared-cache mutation locally.
 * @param hashGraph - The hash graph to linearize.
 * @param origin - The origin hash.
 * @param subgraph - The subgraph to linearize.
 * @returns The linearized vertices.
 */
export function linearizePairSemantics(hashGraph: HashGraph, origin: Hash, subgraph: Set<string>): Vertex[] {
	// The checkpoint origin is already represented by the supplied base state.
	// Skip it by hash identity rather than assuming it occupies position zero.
	const order = hashGraph.dfsTopologicalSortIterative(origin, subgraph);
	const result: Vertex[] = [];
	const needsConflictResolution = order.some((hash) => {
		if (hash === origin) return false;
		return hashGraph.hasCustomConflictResolver(hashGraph.vertices.get(hash)?.operation?.drpType);
	});
	if (!needsConflictResolution) {
		for (let i = 0; i < order.length; i++) {
			if (order[i] === origin) continue;
			const vertex = hashGraph.vertices.get(order[i]);
			if (vertex) result.push(vertex);
		}
		return result;
	}

	const causality = new LegacyCausalityMatrix(hashGraph, order);
	const dropped = new Array<boolean>(order.length).fill(false);

	for (let i = 0; i < order.length; i++) {
		if (order[i] === origin) continue;
		if (dropped[i]) continue;

		let anchor = order[i];
		let modified = false;
		for (let j = i + 1; j < order.length; j++) {
			if (dropped[j] || causality.areRelated(anchor, order[j])) continue;

			const left = hashGraph.vertices.get(anchor);
			const right = hashGraph.vertices.get(order[j]);
			if (!left || !right) continue;

			switch (hashGraph.resolveConflicts([left, right]).action) {
				case ActionType.DropLeft:
					dropped[i] = true;
					modified = true;
					break;
				case ActionType.DropRight:
					dropped[j] = true;
					break;
				case ActionType.Swap:
					causality.swapReachablePredecessors(order[i], order[j]);
					[order[i], order[j]] = [order[j], order[i]];
					j = i + 1;
					anchor = order[i];
					break;
			}

			if (modified) break;
		}

		if (!dropped[i]) {
			const vertex = hashGraph.vertices.get(order[i]);
			if (vertex) result.push(vertex);
		}
	}
	return result;
}
