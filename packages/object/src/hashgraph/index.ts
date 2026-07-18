import { Logger } from "@ts-drp/logger";
import { isTracingEnabled, OpentelemetryMetrics } from "@ts-drp/tracer";
import {
	ActionType,
	type Hash,
	type IHashGraph,
	type LoggerOptions,
	type LowestCommonAncestorResult,
	Operation,
	type ResolveConflictFn,
	type ResolveConflictsType,
	SemanticsType,
	Vertex,
} from "@ts-drp/types";
import { ObjectSet } from "@ts-drp/utils";
import { computeHash } from "@ts-drp/utils/hash";

import { BitSet } from "./bitset.js";
import { linearizeMultipleSemantics } from "../linearize/multipleSemantics.js";
import { linearizePairSemantics } from "../linearize/pairSemantics.js";

const metrics = new OpentelemetryMetrics("@ts-drp/object/hashgraph");

export enum OperationType {
	// TODO: rename this and make it part of action type this is the init action for the object
	NOP = "-1",
}

export type VertexDistance = {
	distance: number;
	closestDependency?: Hash;
};

/**
 * Creates a new vertex
 * @param peerId - The peer id of the vertex
 * @param operation - The operation of the vertex
 * @param dependencies - The dependencies of the vertex
 * @param timestamp - The timestamp of the vertex
 * @param signature - The signature of the vertex
 * @returns The new vertex
 */
export function createVertex(
	peerId: string,
	operation: Operation,
	dependencies: Hash[],
	timestamp: number,
	signature?: Uint8Array
): Vertex {
	const hash = computeHash(peerId, operation, dependencies, timestamp);
	return Vertex.create({ hash, peerId, operation, dependencies, timestamp, signature });
}

export interface HashGraphOptions {
	peerId: string;
	resolveConflictsACL?: ResolveConflictFn;
	resolveConflictsDRP?: ResolveConflictFn;
	semanticsTypeDRP?: SemanticsType;
	logConfig?: LoggerOptions;
}

/**
 * Create a new hash graph
 * @param options - The options for the hash graph.
 * @returns The created hash graph.
 */
export function createHashGraph(options: HashGraphOptions): HashGraph {
	if (!options.peerId) {
		throw new Error("peerId is required");
	}
	return new HashGraph(
		options.peerId,
		options.resolveConflictsACL,
		options.resolveConflictsDRP,
		options.semanticsTypeDRP,
		options.logConfig
	);
}

/**
 * Implementation of the hashgraph data structure.
 */
export class HashGraph implements IHashGraph {
	peerId: string;
	semanticsTypeDRP?: SemanticsType;

	vertices: Map<Hash, Vertex> = new Map();
	frontier: Hash[] = [];
	forwardEdges: Map<Hash, Hash[]> = new Map();

	private log: Logger;

	/*
	computeHash(
		"",
		{ type: OperationType.NOP, value: null },
		[],
		-1,
	);
	*/
	static readonly rootHash: Hash = "425d2b1f5243dbf23c685078034b06fbfa71dc31dcce30f614e28023f140ff13";
	private arePredecessorsFresh = false;
	// Scoped bitset caches are linearizer-private. Public causality queries may
	// reuse them only when both requested hashes are inside that exact scope.
	private arePredecessorsScoped = false;
	private reachablePredecessors: Map<Hash, BitSet> = new Map();
	private topoSortedIndex: Map<Hash, number> = new Map();
	private vertexDistances: Map<Hash, VertexDistance> = new Map();
	private _resolveConflictsACL: ResolveConflictFn;
	private _resolveConflictsDRP: ResolveConflictFn;
	private hasCustomResolverACL: boolean;
	private hasCustomResolverDRP: boolean;
	// We start with a bitset of size 1, and double it every time we reach the limit
	private currentBitsetSize = 1;

	/**
	 * Creates a new hashgraph.
	 * @param peerId - The peer ID.
	 * @param resolveConflictsACL - The resolve conflicts ACL.
	 * @param resolveConflictsDRP - The resolve conflicts DRP.
	 * @param semanticsTypeDRP - The semantics type DRP.
	 * @param logConfig - The log config.
	 */
	constructor(
		peerId: string,
		resolveConflictsACL?: ResolveConflictFn,
		resolveConflictsDRP?: ResolveConflictFn,
		semanticsTypeDRP?: SemanticsType,
		logConfig?: LoggerOptions
	) {
		const rootVertex = Vertex.create({
			hash: HashGraph.rootHash,
			peerId: "",
			operation: Operation.create({ drpType: "", opType: OperationType.NOP }),
			dependencies: [],
			timestamp: -1,
			signature: new Uint8Array(),
		});

		this.log = new Logger("drp::hashgraph", logConfig);
		this.peerId = peerId;
		this.semanticsTypeDRP = semanticsTypeDRP;
		this.hasCustomResolverACL = resolveConflictsACL !== undefined;
		this.hasCustomResolverDRP = resolveConflictsDRP !== undefined;
		this._resolveConflictsACL = resolveConflictsACL ?? HashGraph.resolveNoConflicts;
		this._resolveConflictsDRP = resolveConflictsDRP ?? HashGraph.resolveNoConflicts;
		this.vertices.set(HashGraph.rootHash, rootVertex);
		this.frontier.push(HashGraph.rootHash);
		this.forwardEdges.set(HashGraph.rootHash, []);
		this.vertexDistances.set(HashGraph.rootHash, { distance: 0 });
	}

	/**
	 * Resolves conflicts between two vertices.
	 * @param _ - The vertices to resolve conflicts between.
	 * @returns The resolve conflicts type.
	 */
	private static resolveNoConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}

	/**
	 * Gets the DRP conflict resolver.
	 * @returns The configured resolver.
	 */
	get resolveConflictsDRP(): ResolveConflictFn {
		return this._resolveConflictsDRP;
	}

	/**
	 * Replaces the DRP conflict resolver.
	 * @param resolver - The resolver to use.
	 */
	set resolveConflictsDRP(resolver: ResolveConflictFn) {
		this._resolveConflictsDRP = resolver;
		this.hasCustomResolverDRP = true;
	}

	/**
	 * Gets the ACL conflict resolver.
	 * @returns The configured resolver.
	 */
	get resolveConflictsACL(): ResolveConflictFn {
		return this._resolveConflictsACL;
	}

	/**
	 * Replaces the ACL conflict resolver.
	 * @param resolver - The resolver to use.
	 */
	set resolveConflictsACL(resolver: ResolveConflictFn) {
		this._resolveConflictsACL = resolver;
		this.hasCustomResolverACL = true;
	}

	/**
	 * Reports whether a vertex type has an explicitly supplied resolver.
	 * @param drpType - The operation type to inspect.
	 * @returns True when conflict resolution is required for that type.
	 */
	hasCustomConflictResolver(drpType: string | undefined): boolean {
		return drpType === "ACL" ? this.hasCustomResolverACL : this.hasCustomResolverDRP;
	}

	/**
	 * Resolves conflicts between two vertices.
	 * @param vertices - The vertices to resolve conflicts between.
	 * @returns The resolve conflicts type.
	 */
	resolveConflicts(vertices: Vertex[]): ResolveConflictsType {
		if (vertices[0].operation?.drpType === "ACL") {
			return this.resolveConflictsACL(vertices);
		}
		return this.resolveConflictsDRP(vertices);
	}

	/**
	 * Creates a new vertex.
	 * @param operation - The operation.
	 * @param dependencies - The dependencies of the vertex. If not provided, the frontier will be used.
	 * @param timestamp - The timestamp. If not provided, the current time will be used.
	 * @returns The new vertex.
	 */
	createVertex(
		operation: Operation,
		dependencies: Hash[] = this.getFrontier(),
		timestamp: number = Date.now()
	): Vertex {
		return createVertex(this.peerId, operation, dependencies, timestamp);
	}

	// Add a new vertex to the hashgraph.
	/**
	 * Adds a new vertex to the hashgraph.
	 * @param vertex - The vertex to add.
	 */
	addVertex(vertex: Vertex): void {
		this.vertices.set(vertex.hash, vertex);
		this.frontier.push(vertex.hash);
		// Update forward edges
		for (const dep of vertex.dependencies) {
			if (!this.forwardEdges.has(dep)) {
				this.forwardEdges.set(dep, []);
			}
			this.forwardEdges.get(dep)?.push(vertex.hash);
		}

		// Compute the distance of the vertex
		const vertexDistance: VertexDistance = {
			distance: Number.MAX_VALUE,
			closestDependency: "",
		};
		for (const dep of vertex.dependencies) {
			const depDistance = this.vertexDistances.get(dep);
			if (depDistance && depDistance.distance + 1 < vertexDistance.distance) {
				vertexDistance.distance = depDistance.distance + 1;
				vertexDistance.closestDependency = dep;
			}
		}
		this.vertexDistances.set(vertex.hash, vertexDistance);

		const depsSet = new Set(vertex.dependencies);
		this.frontier = this.frontier.filter((hash) => !depsSet.has(hash));
		this.arePredecessorsFresh = false;
		this.arePredecessorsScoped = false;
	}

	/**
	 * Topologically sorts the vertices in the whole hashgraph or the past of a given vertex.
	 * @param origin - The origin hash.
	 * @param subgraph - The subgraph.
	 * @returns The topologically sorted vertices.
	 */
	dfsTopologicalSortIterative(origin: Hash, subgraph: Set<Hash>): Hash[] {
		if (!subgraph.has(origin)) throw new Error(`Topological subgraph does not contain origin ${origin}`);

		// Validate reachability before allocating the legacy back-filled order.
		// Otherwise unreachable members leave undefined slots at the front.
		const reachable = new ObjectSet<Hash>();
		const reachabilityStack = [origin];
		while (reachabilityStack.length > 0) {
			const node = reachabilityStack.pop();
			if (node === undefined || reachable.has(node)) continue;
			reachable.add(node);
			for (const neighbor of this.forwardEdges.get(node) ?? []) {
				if (subgraph.has(neighbor)) reachabilityStack.push(neighbor);
			}
		}
		const unreachable = [...subgraph].filter((hash) => !reachable.has(hash));
		if (unreachable.length !== 0) {
			throw new Error(
				`Topological subgraph contains ${unreachable.length} member(s) unreachable from origin ${origin}: ${unreachable
					.slice(0, 3)
					.join(", ")}`
			);
		}

		const visited = new ObjectSet<Hash>();
		const processing = new ObjectSet<Hash>();
		const result: Hash[] = Array(subgraph.size);
		const stack: Hash[] = Array(subgraph.size);
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
			for (const neighbor of (this.forwardEdges.get(node) ?? []).sort()) {
				if (processing.has(neighbor)) throw new Error("Graph contains a cycle!");
				if (subgraph.has(neighbor) && !visited.has(neighbor)) {
					stackIndex++;
					stack[stackIndex] = neighbor;
				}
			}
		}
		// Shared descendants can make the legacy stack schedule a vertex twice and
		// displace the origin. Keep the established relative order while making the
		// already-applied origin explicit for identity-based linearizer filtering.
		if (!result.includes(origin)) result[0] = origin;

		return result;
	}

	/**
	 * Topologically sorts the vertices in the whole hashgraph or the past of a given vertex.
	 * @param updateBitsets - Whether to update the bitsets.
	 * @param origin - The origin hash.
	 * @param subgraph - The subgraph.
	 * @returns The topologically sorted vertices.
	 */
	topologicalSort(
		updateBitsets = false,
		origin: Hash = HashGraph.rootHash,
		subgraph: Set<Hash> = new ObjectSet(this.vertices.keys())
	): Hash[] {
		const result = this.dfsTopologicalSortIterative(origin, subgraph);
		if (!updateBitsets) return result;
		const isFullGraph = result.length === this.vertices.size && result.every((hash) => this.vertices.has(hash));
		this.reachablePredecessors.clear();
		this.topoSortedIndex.clear();

		// Double the size until it's enough to hold all the vertices
		while (this.currentBitsetSize < result.length) this.currentBitsetSize *= 2;

		for (let i = 0; i < result.length; i++) {
			this.topoSortedIndex.set(result[i], i);
			this.reachablePredecessors.set(result[i], new BitSet(this.currentBitsetSize));
			for (const dep of this.vertices.get(result[i])?.dependencies || []) {
				const depReachable = this.reachablePredecessors.get(dep);
				const depIndex = this.topoSortedIndex.get(dep);
				if (depReachable && depIndex !== undefined) {
					depReachable.set(depIndex, true);
					const reachable = this.reachablePredecessors.get(result[i]);
					if (reachable) {
						this.reachablePredecessors.set(result[i], reachable.or(depReachable));
					}
				}
			}
		}

		this.arePredecessorsFresh = isFullGraph;
		this.arePredecessorsScoped = !isFullGraph;
		return result;
	}

	/**
	 * Gets the lowest common ancestor of the dependencies.
	 * @param dependencies - The dependencies of the vertex.
	 * @returns The lowest common ancestor.
	 */
	getLCA(dependencies: Hash[]): LowestCommonAncestorResult {
		const isSingleDependency = dependencies.length === 1;
		if (isSingleDependency) return { lca: dependencies[0], linearizedVertices: [] };

		const subgraph: ObjectSet<Hash> = new ObjectSet();
		const lca = this.lowestCommonAncestorMultipleVertices(dependencies, subgraph);
		const linearizedVertices = this.linearizeVertices(lca, subgraph);
		return { lca, linearizedVertices };
	}

	/**
	 * Linearizes the vertices.
	 * @param origin - The origin hash.
	 * @param subgraph - The subgraph.
	 * @returns The linearized vertices.
	 */
	linearizeVertices(
		origin: Hash = HashGraph.rootHash,
		subgraph: Set<string> = new ObjectSet(this.vertices.keys())
	): Vertex[] {
		if (!isTracingEnabled()) return this.linearizeVerticesUntraced(origin, subgraph);

		return metrics.traceFunc(
			"hashgraph.linearize",
			(candidateOrigin: Hash, candidateSubgraph: Set<string>) =>
				this.linearizeVerticesUntraced(candidateOrigin, candidateSubgraph),
			(span, candidateOrigin, candidateSubgraph) => {
				span.setAttribute("drp.replay.suffix_size", Math.max(0, candidateSubgraph.size - 1));
				// Here, a hit only means linearization uses a non-root origin; no replay-state lookup occurs.
				span.setAttribute("drp.checkpoint.hit", candidateOrigin !== HashGraph.rootHash);
			}
		)(origin, subgraph);
	}

	private linearizeVerticesUntraced(origin: Hash, subgraph: Set<string>): Vertex[] {
		switch (this.semanticsTypeDRP) {
			case SemanticsType.pair:
				return linearizePairSemantics(this, origin, subgraph);
			case SemanticsType.multiple:
				return linearizeMultipleSemantics(this, origin, subgraph);
			default:
				return [];
		}
	}

	/**
	 * Finds the lowest common ancestor of multiple vertices.
	 * @param hashes - The hashes of the vertices.
	 * @param visited - The visited vertices.
	 * @returns The lowest common ancestor.
	 */
	lowestCommonAncestorMultipleVertices(hashes: Hash[], visited: ObjectSet<Hash>): Hash {
		if (hashes.length === 0) {
			throw new Error("Vertex dependencies are empty");
		}
		if (hashes.length === 1) {
			visited.add(hashes[0]);
			return hashes[0];
		}
		let lca: Hash | undefined = hashes[0];
		const targetVertices: Hash[] = [...hashes];
		for (let i = 1; i < targetVertices.length; i++) {
			if (!lca) {
				throw new Error("LCA not found");
			}
			if (!visited.has(targetVertices[i])) {
				lca = this.lowestCommonAncestorPairVertices(lca, targetVertices[i], visited, targetVertices);
			}
		}
		if (!lca) {
			throw new Error("LCA not found");
		}
		return lca;
	}

	private lowestCommonAncestorPairVertices(
		hash1: Hash,
		hash2: Hash,
		visited: ObjectSet<Hash>,
		targetVertices: Hash[]
	): Hash | undefined {
		let currentHash1 = hash1;
		let currentHash2 = hash2;
		visited.add(currentHash1);
		visited.add(currentHash2);

		while (currentHash1 !== currentHash2) {
			const distance1 = this.vertexDistances.get(currentHash1);
			if (!distance1) {
				this.log.error("::hashgraph::LCA: Vertex not found");
				return;
			}
			const distance2 = this.vertexDistances.get(currentHash2);
			if (!distance2) {
				this.log.error("::hashgraph::LCA: Vertex not found");
				return;
			}

			if (distance1.distance > distance2.distance) {
				if (!distance1.closestDependency) {
					this.log.error("::hashgraph::LCA: Closest dependency not found");
					return;
				}
				for (const dep of this.vertices.get(currentHash1)?.dependencies || []) {
					if (dep !== distance1.closestDependency && !visited.has(dep)) {
						targetVertices.push(dep);
					}
				}
				currentHash1 = distance1.closestDependency;
				if (visited.has(currentHash1)) {
					return currentHash2;
				}
				visited.add(currentHash1);
			} else {
				if (!distance2.closestDependency) {
					this.log.error("::hashgraph::LCA: Closest dependency not found");
					return;
				}
				for (const dep of this.vertices.get(currentHash2)?.dependencies || []) {
					if (dep !== distance2.closestDependency && !visited.has(dep)) {
						targetVertices.push(dep);
					}
				}
				currentHash2 = distance2.closestDependency;
				if (visited.has(currentHash2)) {
					return currentHash1;
				}
				visited.add(currentHash2);
			}
		}
		return currentHash1;
	}

	/**
	 * Checks if two vertices are causally related using bitsets.
	 * @param hash1 - The first hash.
	 * @param hash2 - The second hash.
	 * @returns True if the vertices are causally related, false otherwise.
	 */
	areCausallyRelatedUsingBitsets(hash1: Hash, hash2: Hash): boolean {
		if (hash1 === hash2) return true;

		const scopedCacheContainsPair =
			this.arePredecessorsScoped &&
			this.reachablePredecessors.has(hash1) &&
			this.reachablePredecessors.has(hash2) &&
			this.topoSortedIndex.has(hash1) &&
			this.topoSortedIndex.has(hash2);
		if (!this.arePredecessorsFresh && !scopedCacheContainsPair) {
			this.topologicalSort(true);
		}

		const reachable1 = this.reachablePredecessors.get(hash1);
		const reachable2 = this.reachablePredecessors.get(hash2);
		const index1 = this.topoSortedIndex.get(hash1);
		const index2 = this.topoSortedIndex.get(hash2);
		if (!reachable1 || !reachable2 || index1 === undefined || index2 === undefined) {
			return this.areCausallyRelatedUsingBFS(hash1, hash2);
		}

		const test1 = reachable1.get(index2);
		const test2 = reachable2.get(index1);
		return test1 || test2;
	}

	/**
	 * Swaps the reachable predecessors of two vertices.
	 * @param hash1 - The first hash.
	 * @param hash2 - The second hash.
	 */
	swapReachablePredecessors(hash1: Hash, hash2: Hash): void {
		const reachable1 = this.reachablePredecessors.get(hash1);
		const reachable2 = this.reachablePredecessors.get(hash2);
		if (!reachable1 || !reachable2) return;
		this.reachablePredecessors.set(hash1, reachable2);
		this.reachablePredecessors.set(hash2, reachable1);
	}

	private _areCausallyRelatedUsingBFS(start: Hash, target: Hash): boolean {
		const visited = new Set<Hash>();
		const queue: Hash[] = [];
		let head = 0;

		queue.push(start);

		while (head < queue.length) {
			const current = queue[head];
			head++;

			if (current === target) return true;
			if (current === undefined) continue;

			visited.add(current);
			const vertex = this.vertices.get(current);
			if (!vertex) continue;

			for (const dep of vertex.dependencies) {
				if (!visited.has(dep)) {
					queue.push(dep);
				}
			}

			if (head > queue.length / 2) {
				queue.splice(0, head);
				head = 0;
			}
		}
		return false;
	}

	/**
	 * Checks if two vertices are causally related using BFS.
	 * @param hash1 - The first hash.
	 * @param hash2 - The second hash.
	 * @returns True if the vertices are causally related, false otherwise.
	 */
	areCausallyRelatedUsingBFS(hash1: Hash, hash2: Hash): boolean {
		if (hash1 === hash2) return true;
		return this._areCausallyRelatedUsingBFS(hash1, hash2) || this._areCausallyRelatedUsingBFS(hash2, hash1);
	}

	/**
	 * Gets the frontier.
	 * @returns The frontier.
	 */
	getFrontier(): Hash[] {
		return Array.from(this.frontier);
	}

	/**
	 * Gets the dependencies of a vertex.
	 * @param vertexHash - The vertex hash.
	 * @returns The dependencies.
	 */
	getDependencies(vertexHash: Hash): Hash[] {
		return Array.from(this.vertices.get(vertexHash)?.dependencies || []);
	}

	/**
	 * Gets a vertex by hash.
	 * @param hash - The hash.
	 * @returns The vertex.
	 */
	getVertex(hash: Hash): Vertex | undefined {
		return this.vertices.get(hash);
	}

	/**
	 * Gets all vertices.
	 * @returns The vertices.
	 */
	getAllVertices(): Vertex[] {
		return Array.from(this.vertices.values());
	}

	/**
	 * Gets the current bitset size.
	 * @returns The current bitset size.
	 */
	getCurrentBitsetSize(): number {
		return this.currentBitsetSize;
	}
}
