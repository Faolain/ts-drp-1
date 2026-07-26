import { deepCloneCanonical, encodeCanonical } from "@ts-drp/canonical";

import { type ConflictAction, type ConflictResult, type EpochVertex, type LinearizeOptions } from "./types.js";

const digestPattern = /^[0-9a-f]{64}$/u;
const conflictActions = new Set<ConflictAction>(["Nop", "DropLeft", "DropRight", "Swap", "Drop"]);

/** A deterministic graph or conflict-policy failure. */
export class LinearizationError extends Error {
	readonly code: string;

	/**
	 * Creates a coded linearization error.
	 * @param code - Stable machine-readable error code.
	 * @param message - Human-readable failure detail.
	 */
	constructor(code: string, message: string) {
		super(message);
		this.name = "LinearizationError";
		this.code = code;
	}
}

class MinHeap {
	private readonly values: string[] = [];

	get size(): number {
		return this.values.length;
	}

	push(value: string): void {
		const values = this.values;
		values.push(value);
		let index = values.length - 1;
		while (index > 0) {
			const parent = (index - 1) >> 1;
			const parentValue = values[parent] as string;
			if (parentValue <= value) break;
			values[index] = parentValue;
			index = parent;
		}
		values[index] = value;
	}

	pop(): string | undefined {
		if (this.values.length === 0) return undefined;
		const root = this.values[0] as string;
		const last = this.values.pop() as string;
		if (this.values.length !== 0) {
			let index = 0;
			while (true) {
				const left = index * 2 + 1;
				const right = left + 1;
				if (left >= this.values.length) break;
				let child = left;
				if (right < this.values.length && (this.values[right] as string) < (this.values[left] as string)) {
					child = right;
				}
				if ((this.values[child] as string) >= last) break;
				this.values[index] = this.values[child] as string;
				index = child;
			}
			this.values[index] = last;
		}
		return root;
	}
}

function assertDigest(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !digestPattern.test(value)) {
		throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
	}
}

function validateGraph(vertices: ReadonlyMap<string, EpochVertex>, anchorHash: string): EpochVertex {
	if (!(vertices instanceof Map)) throw new TypeError("vertices must be a Map keyed by hash");
	assertDigest(anchorHash, "anchorHash");
	const orderedEntries = [...vertices].sort(([left], [right]) => {
		if (typeof left !== "string") return typeof right === "string" ? -1 : 0;
		if (typeof right !== "string") return 1;
		return left < right ? -1 : left > right ? 1 : 0;
	});
	for (const [hash] of orderedEntries) assertDigest(hash, "vertex map key");
	for (const [hash, vertex] of orderedEntries) {
		if (vertex === null || typeof vertex !== "object") {
			throw new LinearizationError("INVALID_VERTEX", `invalid vertex at ${hash}`);
		}
	}
	for (const [hash, vertex] of orderedEntries) {
		if (hash !== vertex.hash) {
			throw new LinearizationError("KEY_HASH_MISMATCH", `map key does not match vertex hash ${hash}`);
		}
	}
	for (const [hash, vertex] of orderedEntries) {
		try {
			encodeCanonical(vertex);
		} catch {
			throw new LinearizationError("INVALID_VERTEX", `vertex ${hash} is outside the canonical domain`);
		}
	}
	const anchor = vertices.get(anchorHash) as EpochVertex | undefined;
	if (anchor?.kind !== "drp-epoch-anchor") {
		throw new LinearizationError("MISSING_ANCHOR", "the active epoch anchor is missing");
	}
	if (!Array.isArray(anchor.dependencies) || anchor.dependencies.length !== 0) {
		throw new LinearizationError("INVALID_ANCHOR", "epoch anchor must have no dependencies");
	}
	for (const [hash, vertex] of orderedEntries) {
		if (hash === anchorHash) continue;
		if (vertex.kind !== "drp-vertex") {
			throw new LinearizationError("INVALID_VERTEX_KIND", `unexpected active vertex kind at ${hash}`);
		}
		if (vertex.objectId !== anchor.objectId || vertex.epoch !== anchor.epoch || vertex.anchor !== anchorHash) {
			throw new LinearizationError("WRONG_EPOCH", `vertex ${hash} is outside the active hard epoch`);
		}
		if (!Array.isArray(vertex.dependencies) || vertex.dependencies.length === 0) {
			throw new LinearizationError("MULTIPLE_ROOTS", `ordinary vertex ${hash} has no dependencies`);
		}
		const uniqueDependencies = new Set(vertex.dependencies);
		if (uniqueDependencies.size !== vertex.dependencies.length) {
			throw new LinearizationError("DUPLICATE_DEPENDENCY", `vertex ${hash} repeats a dependency`);
		}
		for (const dependency of vertex.dependencies) {
			assertDigest(dependency, "dependency");
			if (!vertices.has(dependency)) {
				throw new LinearizationError("MISSING_DEPENDENCY", `vertex ${hash} is missing dependency ${dependency}`);
			}
		}
	}
	return anchor;
}

/**
 * Computes the deterministic minimum-hash Kahn order of an active epoch.
 * @param vertices - Complete active-epoch graph keyed by vertex hash.
 * @param anchorHash - The unique epoch-anchor hash.
 * @param options - Validation controls.
 * @param options.enforceDependencyAntichain - Whether direct dependencies must be pairwise unrelated.
 * @returns Every graph hash exactly once, beginning with the anchor.
 */
export function topologicalOrder(
	vertices: ReadonlyMap<string, EpochVertex>,
	anchorHash: string,
	{ enforceDependencyAntichain = true }: { enforceDependencyAntichain?: boolean } = {}
): string[] {
	validateGraph(vertices, anchorHash);
	const indegree = new Map<string, number>();
	const children = new Map<string, string[]>([...vertices.keys()].map((hash) => [hash, []]));
	for (const [hash, vertex] of vertices) {
		indegree.set(hash, vertex.dependencies.length);
		for (const dependency of vertex.dependencies) (children.get(dependency) as string[]).push(hash);
	}
	for (const list of children.values()) list.sort();
	const ready = new MinHeap();
	for (const [hash, degree] of indegree) if (degree === 0) ready.push(hash);
	const order: string[] = [];
	while (ready.size !== 0) {
		const hash = ready.pop() as string;
		order.push(hash);
		for (const child of children.get(hash) as string[]) {
			const degree = (indegree.get(child) as number) - 1;
			indegree.set(child, degree);
			if (degree === 0) ready.push(child);
		}
	}
	if (order.length !== vertices.size) {
		throw new LinearizationError("CYCLE", "active epoch graph contains a cycle or unreachable component");
	}
	if (order[0] !== anchorHash) {
		throw new LinearizationError("MULTIPLE_ROOTS", "epoch anchor is not the unique graph origin");
	}

	if (enforceDependencyAntichain) {
		const causality = new CausalityIndex(vertices, order);
		for (const hash of order) {
			if (hash === anchorHash) continue;
			const dependencies = (vertices.get(hash) as EpochVertex).dependencies;
			for (let left = 0; left < dependencies.length; left++) {
				for (let right = left + 1; right < dependencies.length; right++) {
					if (causality.areRelated(dependencies[left] as string, dependencies[right] as string)) {
						throw new LinearizationError(
							"NON_ANTICHAIN_DEPENDENCIES",
							`vertex ${hash} has causally related dependencies`
						);
					}
				}
			}
		}
	}
	return order;
}

/** Exact append-only ancestor bitsets for a validated graph order. */
export class CausalityIndex {
	private readonly ancestors: Uint32Array[];
	private readonly index: Map<string, number>;

	/**
	 * Builds exact ancestry for a complete topological order.
	 * @param vertices - Complete graph.
	 * @param suppliedOrder - Complete dependency-before-child order; inferred deterministically when omitted.
	 */
	constructor(vertices: ReadonlyMap<string, EpochVertex>, suppliedOrder?: readonly string[]) {
		if (!(vertices instanceof Map)) throw new TypeError("vertices must be a Map keyed by hash");
		const inferredAnchor = [...vertices].find(([, vertex]) => vertex.kind === "drp-epoch-anchor")?.[0];
		const order = suppliedOrder === undefined ? topologicalOrder(vertices, inferredAnchor ?? "") : [...suppliedOrder];
		if (order.length !== vertices.size || new Set(order).size !== order.length) {
			throw new LinearizationError("INVALID_ORDER", "order must contain every graph vertex exactly once");
		}
		this.index = new Map(order.map((hash, position) => [hash, position]));
		const wordCount = Math.ceil(order.length / 32);
		this.ancestors = new Array<Uint32Array>(order.length);
		for (let position = 0; position < order.length; position++) {
			const hash = order[position] as string;
			const vertex = vertices.get(hash);
			if (vertex === undefined) {
				throw new LinearizationError("MISSING_VERTEX", `missing ordered vertex ${hash}`);
			}
			const bits = new Uint32Array(wordCount);
			for (const dependency of vertex.dependencies) {
				const dependencyPosition = this.index.get(dependency);
				if (dependencyPosition === undefined || dependencyPosition >= position) {
					throw new LinearizationError("INVALID_ORDER", `dependency ${dependency} does not precede ${hash}`);
				}
				const dependencyBits = this.ancestors[dependencyPosition] as Uint32Array;
				for (let word = 0; word < wordCount; word++) {
					bits[word] = (bits[word] as number) | (dependencyBits[word] as number);
				}
				const word = dependencyPosition >>> 5;
				bits[word] = (bits[word] as number) | (1 << (dependencyPosition & 31));
			}
			this.ancestors[position] = bits;
		}
	}

	/**
	 * Reports strict ancestry.
	 * @param ancestorHash - Candidate ancestor.
	 * @param descendantHash - Candidate descendant.
	 * @returns Whether the first vertex is a strict ancestor of the second.
	 */
	isAncestor(ancestorHash: string, descendantHash: string): boolean {
		if (ancestorHash === descendantHash) return false;
		const ancestor = this.index.get(ancestorHash);
		const descendant = this.index.get(descendantHash);
		if (ancestor === undefined || descendant === undefined) return false;
		return (((this.ancestors[descendant] as Uint32Array)[ancestor >>> 5] as number) & (1 << (ancestor & 31))) !== 0;
	}

	/**
	 * Reports equality or ancestry in either direction.
	 * @param leftHash - First vertex hash.
	 * @param rightHash - Second vertex hash.
	 * @returns Whether the vertices are causally related.
	 */
	areRelated(leftHash: string, rightHash: string): boolean {
		return leftHash === rightHash || this.isAncestor(leftHash, rightHash) || this.isAncestor(rightHash, leftHash);
	}
}

function assertResultObject(result: unknown): asserts result is Record<string, unknown> {
	if (result === null || typeof result !== "object" || Array.isArray(result)) {
		throw new LinearizationError("INVALID_CONFLICT_RESULT", "conflict resolver must return a result object");
	}
}

function parseAction(result: Record<string, unknown>): ConflictAction {
	if (typeof result.action !== "string" || !conflictActions.has(result.action as ConflictAction)) {
		throw new LinearizationError("INVALID_CONFLICT_ACTION", "conflict resolver returned an unknown action");
	}
	return result.action as ConflictAction;
}

function pairAction(result: unknown): ConflictAction {
	assertResultObject(result);
	if (Object.keys(result).length !== 1 || !Object.hasOwn(result, "action")) {
		throw new LinearizationError("INVALID_CONFLICT_RESULT", "pair conflict result must contain only action");
	}
	return parseAction(result);
}

function resolverVertex(vertex: EpochVertex): EpochVertex {
	return deepCloneCanonical(vertex);
}

function applyPairSemantics(
	order: readonly string[],
	vertices: ReadonlyMap<string, EpochVertex>,
	causality: CausalityIndex,
	resolveConflicts: NonNullable<LinearizeOptions["resolveConflicts"]>,
	maxPasses: number | undefined
): string[] {
	if (maxPasses !== undefined && (!Number.isSafeInteger(maxPasses) || maxPasses <= 0)) {
		throw new RangeError("maxPasses must be a positive safe integer");
	}
	const output = [...order];
	const passLimit = maxPasses ?? Math.max(16, output.length * 4);
	const seen = new Set<string>();
	for (let pass = 0; pass < passLimit; pass++) {
		const state = output.join(",");
		if (seen.has(state)) {
			throw new LinearizationError("NON_CONVERGENT_CONFLICT_POLICY", "pair conflict policy entered a swap cycle");
		}
		seen.add(state);
		let changed = false;
		outer: for (let left = 0; left < output.length; left++) {
			for (let right = left + 1; right < output.length; right++) {
				const leftHash = output[left] as string;
				const rightHash = output[right] as string;
				if (causality.areRelated(leftHash, rightHash)) continue;
				let action: ConflictAction;
				try {
					action = pairAction(
						resolveConflicts(
							[
								resolverVertex(vertices.get(leftHash) as EpochVertex),
								resolverVertex(vertices.get(rightHash) as EpochVertex),
							],
							Object.freeze({ left, pass, right })
						)
					);
				} catch (error) {
					if (error instanceof LinearizationError) throw error;
					throw new LinearizationError(
						"CONFLICT_RESOLVER_FAILED",
						`pair conflict resolver failed: ${error instanceof Error ? error.message : String(error)}`
					);
				}
				if (action === "Nop") continue;
				changed = true;
				if (action === "DropLeft") {
					output.splice(left, 1);
					break outer;
				}
				if (action === "DropRight") {
					output.splice(right, 1);
					right--;
					continue;
				}
				if (action === "Drop") {
					output.splice(right, 1);
					output.splice(left, 1);
					break outer;
				}
				[output[left], output[right]] = [rightHash, leftHash];
				break outer;
			}
		}
		if (!changed) return output;
	}
	throw new LinearizationError(
		"NON_CONVERGENT_CONFLICT_POLICY",
		"pair conflict policy did not converge within the deterministic pass bound"
	);
}

function assertRetainedCausality(
	originalOrder: readonly string[],
	retainedOrder: readonly string[],
	vertices: ReadonlyMap<string, EpochVertex>
): void {
	const retainedPositions = new Map(retainedOrder.map((hash, position) => [hash, position]));
	const latestRetainedAncestor = new Map<string, number>();
	for (const hash of originalOrder) {
		let latestAncestor = -1;
		for (const dependency of (vertices.get(hash) as EpochVertex).dependencies) {
			latestAncestor = Math.max(
				latestAncestor,
				latestRetainedAncestor.get(dependency) ?? -1,
				retainedPositions.get(dependency) ?? -1
			);
		}
		const position = retainedPositions.get(hash);
		if (position !== undefined && latestAncestor >= position) {
			throw new LinearizationError(
				"CAUSALITY_VIOLATION",
				`retained vertex ${hash} precedes one of its retained ancestors`
			);
		}
		latestRetainedAncestor.set(hash, latestAncestor);
	}
}

function multipleDrops(result: unknown, group: readonly string[]): Set<string> {
	assertResultObject(result);
	const action = parseAction(result);
	if (action === "Nop") {
		if (Object.keys(result).length !== 1) {
			throw new LinearizationError("INVALID_MULTIPLE_RESULT", "Nop multiple result must contain only action");
		}
		return new Set();
	}
	if (action !== "Drop" || Object.keys(result).length !== 2 || !Array.isArray(result.vertices)) {
		throw new LinearizationError(
			"INVALID_MULTIPLE_RESULT",
			"multiple conflict result must be Nop or Drop with a vertices array"
		);
	}
	const allowed = new Set(group);
	const dropped = new Set<string>();
	for (const hash of result.vertices) {
		if (typeof hash !== "string" || !allowed.has(hash)) {
			throw new LinearizationError("INVALID_MULTIPLE_RESULT", "multiple result names a vertex outside its group");
		}
		if (dropped.has(hash)) {
			throw new LinearizationError("INVALID_MULTIPLE_RESULT", "multiple result contains a duplicate vertex");
		}
		dropped.add(hash);
	}
	return dropped;
}

function applyMultipleSemantics(
	order: readonly string[],
	vertices: ReadonlyMap<string, EpochVertex>,
	causality: CausalityIndex,
	resolveConflicts: NonNullable<LinearizeOptions["resolveConflicts"]>
): string[] {
	const consumed = new Set<string>();
	const droppedHashes = new Set<string>();
	for (const hash of order) {
		if (consumed.has(hash)) continue;
		const key = vertices.get(hash)?.operation?.conflictKey;
		const group = [hash];
		if (key !== undefined) {
			for (const candidate of order) {
				if (candidate === hash || consumed.has(candidate)) continue;
				if (
					vertices.get(candidate)?.operation?.conflictKey === key &&
					group.every((member) => !causality.areRelated(member, candidate))
				) {
					group.push(candidate);
				}
			}
		}
		let dropped = new Set<string>();
		if (group.length > 1) {
			try {
				dropped = multipleDrops(
					resolveConflicts(
						group.map((member) => resolverVertex(vertices.get(member) as EpochVertex)),
						Object.freeze({ conflictKey: key })
					),
					group
				);
			} catch (error) {
				if (error instanceof LinearizationError) throw error;
				throw new LinearizationError(
					"CONFLICT_RESOLVER_FAILED",
					`multiple conflict resolver failed: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
		for (const member of group) {
			consumed.add(member);
			if (dropped.has(member)) droppedHashes.add(member);
		}
	}
	return order.filter((hash) => !droppedHashes.has(hash));
}

/**
 * Linearizes one active epoch and applies the frozen conflict semantics.
 * @param options - Complete graph, anchor, mode, and optional resolver.
 * @returns Ordered retained vertices, excluding the epoch anchor.
 */
export function linearizeEpoch(options: LinearizeOptions): EpochVertex[] {
	if (options === null || typeof options !== "object") throw new TypeError("linearization options are required");
	const { anchorHash, maxPasses, mode = "none", resolveConflicts, vertices } = options;
	if (mode !== "none" && mode !== "pair" && mode !== "multiple") {
		throw new LinearizationError("UNKNOWN_MODE", `unknown linearization mode ${String(mode)}`);
	}
	const all = topologicalOrder(vertices, anchorHash);
	const base = all.filter((hash) => hash !== anchorHash);
	if (mode === "none") return base.map((hash) => vertices.get(hash) as EpochVertex);
	if (typeof resolveConflicts !== "function") {
		throw new LinearizationError("MISSING_CONFLICT_RESOLVER", `${mode} mode requires a conflict resolver`);
	}
	const causality = new CausalityIndex(vertices, all);
	const hashes =
		mode === "pair"
			? applyPairSemantics(base, vertices, causality, resolveConflicts, maxPasses)
			: applyMultipleSemantics(base, vertices, causality, resolveConflicts);
	assertRetainedCausality(base, hashes, vertices);
	return hashes.map((hash) => vertices.get(hash) as EpochVertex);
}

export type { ConflictAction, ConflictResult, EpochVertex, LinearizeOptions };
