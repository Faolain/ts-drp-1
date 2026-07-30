export interface EpochVertex {
	readonly anchor?: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly hash: string;
	readonly kind: "drp-epoch-anchor" | "drp-vertex";
	readonly objectId: string;
}

export interface CausalityIndexOptions {
	readonly maxEpochVertices?: number | undefined;
}

export interface EpochFullOutcome {
	readonly status: "pending";
	readonly code: "EPOCH_FULL";
	readonly latchByHash: false;
}

type Mutant =
	| "after-publication"
	| "anchor-exclusion"
	| "duplicate-charge"
	| "invalidity"
	| "late-initial-capacity"
	| "latch"
	| "off-by-one";

const mutant = process.env.PHASE_0P1_MUTANT as Mutant | undefined;
const digestPattern = /^[0-9a-f]{64}$/u;

/** Controlled coded error matching the production error surface. */
export class LinearizationError extends Error {
	readonly code: string;

	/**
	 * Creates a controlled coded error.
	 * @param code - Stable machine-readable code.
	 * @param message - Human-readable detail.
	 */
	constructor(code: string, message: string) {
		super(message);
		this.name = "LinearizationError";
		this.code = code;
	}
}

function assertDigest(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !digestPattern.test(value)) {
		throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
	}
}

/**
 * Independent controlled model for Phase 0p-1. It deliberately implements only
 * the append-only ancestry and capacity surface exercised by the causal RED.
 */
export class CausalityIndex {
	private readonly ancestors: Uint32Array[] = [];
	private readonly anchorHash: string;
	private chargedSize: number;
	private readonly epoch: number;
	private readonly index = new Map<string, number>();
	private latched = false;
	private readonly maxEpochVertices: number | undefined;
	private readonly objectId: string;

	/**
	 * Builds the independent controlled index.
	 * @param vertices - Initial active-epoch graph.
	 * @param suppliedOrder - Optional dependency-before-child order.
	 * @param options - Optional anchor-inclusive capacity.
	 */
	constructor(
		vertices: ReadonlyMap<string, EpochVertex>,
		suppliedOrder?: readonly string[],
		options: CausalityIndexOptions = {}
	) {
		if (!(vertices instanceof Map)) throw new TypeError("vertices must be a Map keyed by hash");
		if (options === null || typeof options !== "object" || Array.isArray(options)) {
			throw new TypeError("CausalityIndex options must be an object");
		}
		const maxEpochVertices = options.maxEpochVertices;
		if (maxEpochVertices !== undefined && (!Number.isSafeInteger(maxEpochVertices) || maxEpochVertices < 1)) {
			throw new RangeError("maxEpochVertices must be a positive safe integer");
		}
		this.maxEpochVertices = maxEpochVertices;
		if (mutant !== "late-initial-capacity" && maxEpochVertices !== undefined && vertices.size > maxEpochVertices) {
			throw new LinearizationError("EPOCH_CAPACITY_EXCEEDED", "initial graph exceeds maxEpochVertices");
		}

		const anchorEntry = [...vertices].find(([, vertex]) => vertex.kind === "drp-epoch-anchor");
		if (anchorEntry === undefined) {
			throw new LinearizationError("MISSING_ANCHOR", "the active epoch anchor is missing");
		}
		const [anchorHash, anchor] = anchorEntry;
		const order = suppliedOrder === undefined ? [...vertices.keys()] : [...suppliedOrder];
		if (order.length !== vertices.size || new Set(order).size !== order.length || order[0] !== anchorHash) {
			throw new LinearizationError("INVALID_ORDER", "order must contain the anchor and every vertex once");
		}
		this.anchorHash = anchorHash;
		this.epoch = anchor.epoch;
		this.objectId = anchor.objectId;
		for (const hash of order) {
			const vertex = vertices.get(hash);
			if (vertex === undefined) throw new LinearizationError("MISSING_VERTEX", `missing ${hash}`);
			this.publish(hash, vertex);
		}
		this.chargedSize = this.index.size;
	}

	/** @returns Atomically published vertex count. */
	get size(): number {
		return this.index.size;
	}

	/**
	 * Checks published membership.
	 * @param hash - Candidate vertex hash.
	 * @returns Whether the hash is published.
	 */
	has(hash: string): boolean {
		return this.index.has(hash);
	}

	/**
	 * Appends or reports a non-terminal capacity stall.
	 * @param hash - Candidate vertex hash.
	 * @param vertex - Dependency-complete active-epoch vertex.
	 * @returns The capacity outcome, or undefined after publication.
	 */
	append(hash: string, vertex: EpochVertex): undefined | EpochFullOutcome {
		assertDigest(hash, "vertex map key");
		if (this.index.has(hash)) {
			if (mutant === "duplicate-charge") this.chargedSize++;
			throw new LinearizationError("DUPLICATE_VERTEX", `vertex ${hash} is already indexed`);
		}
		if (this.latched) {
			throw new LinearizationError("EPOCH_CAPACITY_LATCHED", "capacity was permanently latched");
		}
		const effectiveSize = mutant === "anchor-exclusion" ? Math.max(0, this.chargedSize - 1) : this.chargedSize;
		const effectiveLimit =
			mutant === "off-by-one" && this.maxEpochVertices !== undefined
				? this.maxEpochVertices + 1
				: this.maxEpochVertices;
		if (effectiveLimit !== undefined && effectiveSize >= effectiveLimit) {
			if (mutant === "after-publication") this.publish(hash, vertex);
			if (mutant === "latch") this.latched = true;
			if (mutant === "invalidity") {
				return {
					status: "terminal",
					code: "EPOCH_FULL",
					latchByHash: true,
				} as unknown as EpochFullOutcome;
			}
			return Object.freeze({
				status: "pending",
				code: "EPOCH_FULL",
				latchByHash: false,
			});
		}
		this.publish(hash, vertex);
		this.chargedSize++;
		return undefined;
	}

	/**
	 * Checks strict ancestry.
	 * @param ancestorHash - Candidate ancestor.
	 * @param descendantHash - Candidate descendant.
	 * @returns Whether the first hash strictly precedes the second.
	 */
	isAncestor(ancestorHash: string, descendantHash: string): boolean {
		if (ancestorHash === descendantHash) return false;
		const ancestor = this.index.get(ancestorHash);
		const descendant = this.index.get(descendantHash);
		if (ancestor === undefined || descendant === undefined) return false;
		return (((this.ancestors[descendant] as Uint32Array)[ancestor >>> 5] as number) & (1 << (ancestor & 31))) !== 0;
	}

	/**
	 * Publishes one already capacity-authorized vertex.
	 * @param hash - Vertex hash.
	 * @param vertex - Validated active-epoch vertex.
	 */
	private publish(hash: string, vertex: EpochVertex): void {
		assertDigest(hash, "vertex map key");
		if (vertex.hash !== hash) throw new LinearizationError("KEY_HASH_MISMATCH", "hash differs");
		if (this.index.size === 0) {
			if (vertex.kind !== "drp-epoch-anchor" || vertex.dependencies.length !== 0 || hash !== this.anchorHash) {
				throw new LinearizationError("INVALID_ANCHOR", "invalid anchor");
			}
		} else if (
			vertex.kind !== "drp-vertex" ||
			vertex.anchor !== this.anchorHash ||
			vertex.epoch !== this.epoch ||
			vertex.objectId !== this.objectId
		) {
			throw new LinearizationError("WRONG_EPOCH", "vertex is outside the active epoch");
		}
		const position = this.index.size;
		const bits = new Uint32Array(Math.ceil((position + 1) / 32));
		for (const dependency of vertex.dependencies) {
			const dependencyPosition = this.index.get(dependency);
			if (dependencyPosition === undefined) {
				throw new LinearizationError("MISSING_DEPENDENCY", `missing dependency ${dependency}`);
			}
			const dependencyBits = this.ancestors[dependencyPosition] as Uint32Array;
			for (let word = 0; word < dependencyBits.length; word++) {
				bits[word] = (bits[word] as number) | (dependencyBits[word] as number);
			}
			bits[dependencyPosition >>> 5] = (bits[dependencyPosition >>> 5] as number) | (1 << (dependencyPosition & 31));
		}
		this.ancestors.push(bits);
		this.index.set(hash, position);
	}
}
