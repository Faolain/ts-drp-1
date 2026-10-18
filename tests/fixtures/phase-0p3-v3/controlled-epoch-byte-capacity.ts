import { createHash } from "node:crypto";

export interface EpochVertex {
	readonly anchor?: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly hash: string;
	readonly kind: "drp-epoch-anchor" | "drp-vertex";
	readonly objectId: string;
}

export interface CausalityIndexOptions {
	readonly initialByteCharges?: ReadonlyMap<string, number> | undefined;
	readonly maxEpochBytes?: number | undefined;
	readonly maxEpochVertices?: number | undefined;
}

export interface EpochFullOutcome {
	readonly code: "EPOCH_FULL";
	readonly latchByHash: false;
	readonly status: "pending";
}

type Mutant =
	| "anchor-charge-omitted"
	| "arrival-winner"
	| "byte-only"
	| "charge-on-refusal"
	| "count-only"
	| "duplicate-charge"
	| "initial-keyset-lax"
	| "initial-precedence-swap"
	| "late-initial-byte-check"
	| "latched-byte-full"
	| "live-charge-authority"
	| "lt-vs-le"
	| "mutable-initial-charges"
	| "mutable-initial-keyset"
	| "partial-rollback"
	| "stale-initial-graph-snapshot"
	| "stale-pre-reentrancy"
	| "terminal-byte-full"
	| "wrapping-accumulation";

const mutant = process.env.PHASE_0P3_MUTANT as Mutant | undefined;
const digestPattern = /^[0-9a-f]{64}$/u;
const normalOutcome: EpochFullOutcome = Object.freeze({
	code: "EPOCH_FULL",
	latchByHash: false,
	status: "pending",
});

function testHash(label: string): string {
	return createHash("sha256").update(`phase-0p3:${label}`).digest("hex");
}

/** Controlled coded error matching the production error surface. */
export class LinearizationError extends Error {
	readonly code: string;

	/**
	 * Creates one stable controlled error.
	 * @param code - Machine-readable error code.
	 * @param message - Human-readable error detail.
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

function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
}

function invalidCharges(message: string): never {
	throw new LinearizationError("INVALID_BYTE_CHARGES", message);
}

/**
 * Independent behavioral model for the additive Phase 0p-3 byte-capacity surface.
 * It deliberately accepts inert numeric charges and owns no carrier provenance.
 */
export class CausalityIndex {
	private readonly ancestors: Uint32Array[] = [];
	private readonly anchorHash: string;
	private byteFullLatched = false;
	private epochBytes: number | undefined;
	private readonly epoch: number;
	private readonly index = new Map<string, number>();
	private readonly maxEpochBytes: number | undefined;
	private readonly maxEpochVertices: number | undefined;
	private readonly objectId: string;

	/**
	 * Builds a controlled byte-accounted ancestry index.
	 * @param vertices - Initial graph keyed by vertex hash.
	 * @param suppliedOrder - Optional dependency-before-child order.
	 * @param options - Optional count and byte ceilings.
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
		const maxEpochBytes = options.maxEpochBytes;
		if (maxEpochVertices !== undefined) assertPositiveSafeInteger(maxEpochVertices, "maxEpochVertices");
		if (maxEpochBytes !== undefined) assertPositiveSafeInteger(maxEpochBytes, "maxEpochBytes");
		this.maxEpochVertices = maxEpochVertices;
		this.maxEpochBytes = maxEpochBytes;
		const precedenceSwap = mutant === "initial-precedence-swap" && vertices.has(testHash("precedence-anchor"));
		if (precedenceSwap && maxEpochVertices !== undefined && vertices.size > maxEpochVertices) {
			throw new LinearizationError("EPOCH_CAPACITY_EXCEEDED", "initial graph exceeds maxEpochVertices");
		}

		let initialTotal: number | undefined;
		if (maxEpochBytes !== undefined) {
			const staleInitialGraphSnapshot =
				mutant === "stale-initial-graph-snapshot" && vertices.has(testHash("capture-order-anchor"));
			const initialHashesBeforeCharges = staleInitialGraphSnapshot ? [...vertices.keys()] : undefined;
			const charges = options.initialByteCharges;
			const initialHashes = initialHashesBeforeCharges ?? [...vertices.keys()];
			let isMap = false;
			try {
				isMap = charges instanceof Map;
			} catch {
				invalidCharges("initialByteCharges must be a compatible Map keyed exactly like vertices");
			}
			if (!isMap) invalidCharges("initialByteCharges must be a Map keyed exactly like vertices");
			const skipExactKeyset = mutant === "initial-keyset-lax" && vertices.has(testHash("keyset-anchor"));
			const mutableInitialKeyset =
				mutant === "mutable-initial-keyset" && vertices.has(testHash("intrinsic-keyset-anchor"));
			let chargeEntries: ReadonlyMap<string, number>;
			if (mutableInitialKeyset) {
				if (charges.size !== vertices.size) {
					invalidCharges("initialByteCharges keyset must equal the initial graph keyset");
				}
				chargeEntries = new Map([...vertices.keys()].map((hash) => [hash, charges.get(hash) as number]));
			} else {
				try {
					chargeEntries = new Map(Map.prototype.entries.call(charges) as MapIterator<[string, number]>);
				} catch {
					invalidCharges("initialByteCharges must contain compatible intrinsic Map entries");
				}
			}
			if (!skipExactKeyset && chargeEntries.size !== initialHashes.length) {
				invalidCharges("initialByteCharges keyset must equal the initial graph keyset");
			}
			let total = 0;
			if (!skipExactKeyset) {
				for (const hash of initialHashes) {
					if (!chargeEntries.has(hash)) {
						invalidCharges("initialByteCharges keyset must equal the initial graph keyset");
					}
				}
			}
			for (const [hash, charge] of chargeEntries) {
				if (charge === undefined || !Number.isSafeInteger(charge) || charge < 1) {
					invalidCharges(`invalid initial byte charge for ${hash}`);
				}
				if (mutant === "mutable-initial-charges" && hash === testHash("mutable-anchor")) {
					total = 1;
				} else if (!(mutant === "anchor-charge-omitted" && hash === testHash("anchor-omitted-anchor"))) {
					if (charge > Number.MAX_SAFE_INTEGER - total) {
						invalidCharges("initial byte charge sum exceeds the safe-integer domain");
					}
					total += charge;
				}
			}
			initialTotal = total;
		}

		if (maxEpochVertices !== undefined && vertices.size > maxEpochVertices && !precedenceSwap) {
			throw new LinearizationError("EPOCH_CAPACITY_EXCEEDED", "initial graph exceeds maxEpochVertices");
		}
		const lateByteCheck = mutant === "late-initial-byte-check" && vertices.has(testHash("late-byte-anchor"));
		if (!lateByteCheck && maxEpochBytes !== undefined && (initialTotal as number) > maxEpochBytes) {
			throw new LinearizationError("EPOCH_CAPACITY_EXCEEDED", "initial graph exceeds maxEpochBytes");
		}

		const anchorEntry = [...vertices].find(([, vertex]) => vertex.kind === "drp-epoch-anchor");
		if (anchorEntry === undefined) {
			throw new LinearizationError("MISSING_ANCHOR", "the active epoch anchor is missing");
		}
		const [anchorHash, anchor] = anchorEntry;
		if (lateByteCheck && maxEpochBytes !== undefined && (initialTotal as number) > maxEpochBytes) {
			throw new LinearizationError("EPOCH_CAPACITY_EXCEEDED", "initial graph exceeds maxEpochBytes");
		}
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
			const dependencies = hash === anchorHash ? [] : this.captureOrdinaryVertex(hash, vertex);
			this.publishDependencies(hash, dependencies);
		}
		this.epochBytes = initialTotal;
	}

	/** @returns The published vertex count. */
	get size(): number {
		return this.index.size;
	}

	/**
	 * Returns whether a hash has been published.
	 * @param hash - Candidate vertex hash.
	 * @returns Whether the hash is present.
	 */
	has(hash: string): boolean {
		return this.index.has(hash);
	}

	/**
	 * Appends one candidate with an optional inert byte charge.
	 * @param hash - Candidate vertex hash.
	 * @param vertex - Dependency-complete candidate.
	 * @param suppliedCharge - Optional inert byte charge.
	 * @returns The shared capacity outcome, or undefined after publication.
	 */
	append(hash: string, vertex: EpochVertex, suppliedCharge?: number): undefined | EpochFullOutcome {
		assertDigest(hash, "vertex map key");
		if (this.index.has(hash)) {
			if (mutant === "duplicate-charge" && hash === testHash("duplicate-candidate")) {
				this.epochBytes = (this.epochBytes as number) + (suppliedCharge as number);
			}
			throw new LinearizationError("DUPLICATE_VERTEX", `vertex ${hash} is already indexed`);
		}
		if (this.byteFullLatched) {
			throw new LinearizationError("EPOCH_CAPACITY_LATCHED", "byte capacity was permanently latched");
		}

		const countOnly = mutant === "count-only" && hash === testHash("byte-only-candidate");
		const byteOnly = mutant === "byte-only" && hash === testHash("count-only-candidate");
		if (!byteOnly && this.countFull()) return normalOutcome;

		let charge: number | undefined;
		if (this.maxEpochBytes !== undefined) {
			let candidateCharge: unknown = suppliedCharge;
			if (
				mutant === "live-charge-authority" &&
				hash === testHash("live-authority-candidate") &&
				typeof suppliedCharge === "function"
			) {
				candidateCharge = (suppliedCharge as unknown as () => number)();
			}
			if (!Number.isSafeInteger(candidateCharge) || (candidateCharge as number) < 1) {
				invalidCharges("append byte charge must be a positive safe integer");
			}
			charge = candidateCharge as number;
			if (!countOnly && this.byteFull(charge, hash)) return this.refusal(hash);
		}

		let dependencies: readonly string[];
		try {
			dependencies = this.captureOrdinaryVertex(hash, vertex);
		} catch (error) {
			if (mutant === "charge-on-refusal" && hash === testHash("refused-candidate")) {
				this.epochBytes = (this.epochBytes as number) + (charge as number);
			}
			throw error;
		}
		if (this.index.has(hash)) {
			throw new LinearizationError("DUPLICATE_VERTEX", `vertex ${hash} was published during validation`);
		}
		const skipRecheck = mutant === "stale-pre-reentrancy" && hash === testHash("reentrant-outer");
		if (!skipRecheck) {
			if (!byteOnly && this.countFull()) return normalOutcome;
			if (!countOnly && charge !== undefined && this.byteFull(charge, hash)) return this.refusal(hash);
		}

		const oldTotal = this.epochBytes;
		const position = this.index.size;
		const bits = this.buildAncestorRow(position, dependencies);
		this.ancestors.push(bits);
		if (charge !== undefined) {
			const next =
				mutant === "wrapping-accumulation" && hash === testHash("wrap-candidate")
					? ((oldTotal as number) + charge) >>> 0
					: (oldTotal as number) + charge;
			this.epochBytes = next;
		}
		try {
			this.index.set(hash, position);
		} catch (error) {
			if (!(mutant === "partial-rollback" && hash === testHash("rollback-failing"))) {
				this.ancestors.pop();
				this.index.delete(hash);
				this.epochBytes = oldTotal;
			}
			throw error;
		}
		return undefined;
	}

	/**
	 * Returns strict ancestry between two published hashes.
	 * @param ancestorHash - Potential ancestor.
	 * @param descendantHash - Potential descendant.
	 * @returns Whether the first hash is a strict ancestor of the second.
	 */
	isAncestor(ancestorHash: string, descendantHash: string): boolean {
		if (ancestorHash === descendantHash) return false;
		const ancestor = this.index.get(ancestorHash);
		const descendant = this.index.get(descendantHash);
		if (ancestor === undefined || descendant === undefined) return false;
		return (((this.ancestors[descendant] as Uint32Array)[ancestor >>> 5] as number) & (1 << (ancestor & 31))) !== 0;
	}

	private buildAncestorRow(position: number, dependencies: readonly string[]): Uint32Array {
		const bits = new Uint32Array(Math.ceil((position + 1) / 32));
		for (const dependency of dependencies) {
			const dependencyPosition = this.index.get(dependency) as number;
			const dependencyBits = this.ancestors[dependencyPosition] as Uint32Array;
			for (let word = 0; word < dependencyBits.length; word++) {
				bits[word] = (bits[word] as number) | (dependencyBits[word] as number);
			}
			bits[dependencyPosition >>> 5] = (bits[dependencyPosition >>> 5] as number) | (1 << (dependencyPosition & 31));
		}
		return bits;
	}

	private byteFull(charge: number, hash: string): boolean {
		if (this.maxEpochBytes === undefined) return false;
		if (mutant === "lt-vs-le" && hash === testHash("boundary-equal")) {
			return charge >= this.maxEpochBytes - (this.epochBytes as number);
		}
		return charge > this.maxEpochBytes - (this.epochBytes as number);
	}

	private captureOrdinaryVertex(hash: string, vertex: EpochVertex): readonly string[] {
		const candidateHash = vertex.hash;
		const kind = vertex.kind;
		const objectId = vertex.objectId;
		const epoch = vertex.epoch;
		const anchor = vertex.anchor;
		const rawDependencies = vertex.dependencies;
		assertDigest(candidateHash, "vertex hash");
		if (candidateHash !== hash) throw new LinearizationError("KEY_HASH_MISMATCH", "hash differs");
		if (kind !== "drp-vertex") throw new LinearizationError("INVALID_VERTEX_KIND", "expected ordinary vertex");
		if (objectId !== this.objectId || epoch !== this.epoch || anchor !== this.anchorHash) {
			throw new LinearizationError("WRONG_EPOCH", "vertex is outside the active epoch");
		}
		if (!Array.isArray(rawDependencies) || rawDependencies.length === 0) {
			throw new LinearizationError("MULTIPLE_ROOTS", "ordinary vertex must have dependencies");
		}
		const dependencies: string[] = [];
		for (const dependency of rawDependencies) {
			assertDigest(dependency, "dependency");
			if (this.index.get(dependency) === undefined) {
				throw new LinearizationError("MISSING_DEPENDENCY", `missing dependency ${dependency}`);
			}
			dependencies.push(dependency);
		}
		return dependencies;
	}

	private countFull(): boolean {
		return this.maxEpochVertices !== undefined && this.index.size >= this.maxEpochVertices;
	}

	private publishDependencies(hash: string, dependencies: readonly string[]): void {
		const position = this.index.size;
		this.ancestors.push(this.buildAncestorRow(position, dependencies));
		this.index.set(hash, position);
	}

	private refusal(hash: string): EpochFullOutcome {
		if (mutant === "latched-byte-full" && hash === testHash("latched-candidate")) {
			this.byteFullLatched = true;
		}
		if (mutant === "terminal-byte-full" && hash === testHash("terminal-candidate")) {
			return Object.freeze({
				code: "EPOCH_FULL",
				latchByHash: true,
				status: "terminal",
			}) as unknown as EpochFullOutcome;
		}
		if (mutant === "arrival-winner" && hash === testHash("arrival-right")) {
			return Object.freeze({
				...normalOutcome,
				winner: testHash("arrival-left"),
			}) as EpochFullOutcome;
		}
		return normalOutcome;
	}
}
