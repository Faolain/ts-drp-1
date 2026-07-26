import { sha256 } from "@noble/hashes/sha2";

import {
	type AccumulatorSnapshot,
	type BatchOptions,
	type ConsistencyProof,
	type InclusionProof,
	type MerkleTree,
} from "./types.js";

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < left.byteLength; index++) {
		difference |= (left[index] as number) ^ (right[index] as number);
	}
	return difference === 0;
}

function copyInput(input: Uint8Array | ArrayBuffer): Uint8Array {
	if (input instanceof Uint8Array) return new Uint8Array(input);
	if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
	throw new TypeError("Merkle input must be a Uint8Array or ArrayBuffer");
}

function isHash(value: unknown): value is Uint8Array {
	return value instanceof Uint8Array && value.byteLength === 32;
}

function copyHash(value: unknown, name: string): Uint8Array {
	if (!isHash(value)) throw new TypeError(`${name} must be a 32-byte hash`);
	return new Uint8Array(value);
}

function validateBatchSize(batchSize: number): void {
	if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
		throw new RangeError("batchSize must be a positive safe integer");
	}
}

function largestPowerOfTwoLessThan(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 1) {
		throw new RangeError("value must be an integer greater than one");
	}
	return 2 ** Math.floor(Math.log2(value - 1));
}

const emptyMerkleRoot = sha256(new Uint8Array());

/** The RFC 9162 empty-tree hash. */
export const EMPTY_MERKLE_ROOT = new Uint8Array(emptyMerkleRoot);

/**
 * Hashes one RFC 9162 leaf.
 * @param input - Caller-owned leaf bytes.
 * @returns A fresh 32-byte hash.
 */
export function merkleLeafHash(input: Uint8Array | ArrayBuffer): Uint8Array {
	return sha256(concatBytes(Uint8Array.of(0), copyInput(input)));
}

/**
 * Hashes one RFC 9162 interior node.
 * @param left - Left 32-byte child hash.
 * @param right - Right 32-byte child hash.
 * @returns A fresh 32-byte hash.
 */
export function merkleNodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
	return sha256(concatBytes(Uint8Array.of(1), copyHash(left, "left node"), copyHash(right, "right node")));
}

/**
 * Builds an RFC 9162 Merkle tree, yielding between complete leaf-hashing batches.
 * The subsequent O(V) interior-node reduction is synchronous.
 * @param inputs - Caller-owned leaf byte strings.
 * @param options - Validated batching options.
 * @param options.batchSize - Positive leaves-per-batch bound.
 * @param options.yieldTask - Optional cooperative task boundary.
 * @returns A tree isolated from subsequent caller mutations.
 */
export async function buildMerkleTree(
	inputs: readonly (Uint8Array | ArrayBuffer)[],
	{ batchSize = 256, yieldTask }: BatchOptions = {}
): Promise<MerkleTree> {
	if (!Array.isArray(inputs)) throw new TypeError("inputs must be an array");
	validateBatchSize(batchSize);
	if (yieldTask !== undefined && typeof yieldTask !== "function") throw new TypeError("yieldTask must be a function");
	const copiedInputs = inputs.map(copyInput);
	const leafHashes = new Array<Uint8Array>(copiedInputs.length);
	for (let start = 0; start < copiedInputs.length; start += batchSize) {
		const end = Math.min(copiedInputs.length, start + batchSize);
		for (let index = start; index < end; index++) {
			leafHashes[index] = merkleLeafHash(copiedInputs[index] as Uint8Array);
		}
		if (yieldTask !== undefined && end < copiedInputs.length) await yieldTask();
	}
	const memo = new Map<string, Uint8Array>();
	const hashRange = (start: number, length: number): Uint8Array => {
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(length) ||
			start < 0 ||
			length < 0 ||
			start + length > leafHashes.length
		) {
			throw new RangeError("invalid Merkle range");
		}
		if (length === 0) return new Uint8Array(emptyMerkleRoot);
		if (length === 1) return new Uint8Array(leafHashes[start] as Uint8Array);
		const key = `${start}:${length}`;
		const cached = memo.get(key);
		if (cached !== undefined) return new Uint8Array(cached);
		const split = largestPowerOfTwoLessThan(length);
		const value = merkleNodeHash(hashRange(start, split), hashRange(start + split, length - split));
		memo.set(key, value);
		return new Uint8Array(value);
	};
	const root = hashRange(0, leafHashes.length);
	return Object.freeze({
		hashRange,
		inputs: copiedInputs,
		leafHashes: leafHashes.map((hash) => new Uint8Array(hash)),
		root,
		size: copiedInputs.length,
	});
}

function inclusionPath(tree: MerkleTree, index: number, start: number, length: number): Uint8Array[] {
	if (length === 1) return [];
	const split = largestPowerOfTwoLessThan(length);
	if (index < split) {
		return [...inclusionPath(tree, index, start, split), tree.hashRange(start + split, length - split)];
	}
	return [...inclusionPath(tree, index - split, start + split, length - split), tree.hashRange(start, split)];
}

/**
 * Generates an inclusion proof for one tree leaf.
 * @param tree - Valid tree returned by buildMerkleTree.
 * @param index - Zero-based leaf index.
 * @returns Inclusion proof and bound tree size.
 */
export function inclusionProof(tree: MerkleTree, index: number): InclusionProof {
	if (
		tree === null ||
		typeof tree !== "object" ||
		!Number.isSafeInteger(tree.size) ||
		!Number.isSafeInteger(index) ||
		index < 0 ||
		index >= tree.size
	) {
		throw new RangeError("leaf index is outside the tree");
	}
	return { auditPath: inclusionPath(tree, index, 0, tree.size), leafIndex: index, treeSize: tree.size };
}

/**
 * Verifies an RFC 9162 inclusion proof.
 * @param input - Claimed leaf bytes.
 * @param proof - Claimed inclusion proof.
 * @param expectedRoot - Expected tree root.
 * @returns False for every malformed or non-matching proof.
 */
export function verifyInclusion(
	input: Uint8Array | ArrayBuffer,
	proof: InclusionProof,
	expectedRoot: Uint8Array
): boolean {
	try {
		const { auditPath, leafIndex, treeSize } = proof;
		if (
			!Number.isSafeInteger(leafIndex) ||
			!Number.isSafeInteger(treeSize) ||
			leafIndex < 0 ||
			leafIndex >= treeSize ||
			!Array.isArray(auditPath) ||
			auditPath.length > Math.ceil(Math.log2(Math.max(1, treeSize))) + 1 ||
			!isHash(expectedRoot)
		) {
			return false;
		}
		let fn = leafIndex;
		let sn = treeSize - 1;
		let root = merkleLeafHash(input);
		for (const sibling of auditPath) {
			if (!isHash(sibling) || sn === 0) return false;
			if (fn % 2 === 1 || fn === sn) {
				root = merkleNodeHash(sibling, root);
				if (fn % 2 === 0) {
					while (fn % 2 === 0 && fn !== 0) {
						fn = Math.floor(fn / 2);
						sn = Math.floor(sn / 2);
					}
				}
			} else {
				root = merkleNodeHash(root, sibling);
			}
			fn = Math.floor(fn / 2);
			sn = Math.floor(sn / 2);
		}
		return sn === 0 && bytesEqual(root, expectedRoot);
	} catch {
		return false;
	}
}

function subproof(
	tree: MerkleTree,
	firstSize: number,
	start: number,
	secondSize: number,
	complete: boolean
): Uint8Array[] {
	if (firstSize === secondSize) return complete ? [] : [tree.hashRange(start, secondSize)];
	const split = largestPowerOfTwoLessThan(secondSize);
	if (firstSize <= split) {
		return [...subproof(tree, firstSize, start, split, complete), tree.hashRange(start + split, secondSize - split)];
	}
	return [...subproof(tree, firstSize - split, start + split, secondSize - split, false), tree.hashRange(start, split)];
}

/**
 * Generates an RFC 9162 proof from a prior prefix to this tree.
 * @param tree - Complete later tree.
 * @param firstSize - Size of the earlier prefix.
 * @returns Consistency proof bound to both sizes.
 */
export function consistencyProof(tree: MerkleTree, firstSize: number): ConsistencyProof {
	if (!Number.isSafeInteger(firstSize) || firstSize < 0 || firstSize > tree.size) {
		throw new RangeError("invalid prior tree size");
	}
	if (firstSize === 0 || firstSize === tree.size) {
		return { firstSize, path: [], secondSize: tree.size };
	}
	return { firstSize, path: subproof(tree, firstSize, 0, tree.size, true), secondSize: tree.size };
}

function isPowerOfTwo(value: number): boolean {
	if (!Number.isSafeInteger(value) || value <= 0) return false;
	while (value % 2 === 0) value = Math.floor(value / 2);
	return value === 1;
}

/**
 * Verifies an RFC 9162 prefix consistency proof.
 * @param firstSize - Earlier tree size.
 * @param secondSize - Later tree size.
 * @param firstRoot - Earlier tree root.
 * @param secondRoot - Later tree root.
 * @param path - Proof node path.
 * @returns False for every malformed or non-matching proof.
 */
export function verifyConsistency(
	firstSize: number,
	secondSize: number,
	firstRoot: Uint8Array,
	secondRoot: Uint8Array,
	path: readonly Uint8Array[]
): boolean {
	if (
		!Number.isSafeInteger(firstSize) ||
		!Number.isSafeInteger(secondSize) ||
		firstSize < 0 ||
		secondSize < firstSize ||
		!isHash(firstRoot) ||
		!isHash(secondRoot) ||
		!Array.isArray(path) ||
		path.some((hash) => !isHash(hash))
	) {
		return false;
	}
	if (firstSize === 0) {
		return path.length === 0 && bytesEqual(firstRoot, emptyMerkleRoot);
	}
	if (firstSize === secondSize) {
		return path.length === 0 && bytesEqual(firstRoot, secondRoot);
	}
	if (path.length === 0 || path.length > Math.ceil(Math.log2(Math.max(1, secondSize))) + 1) return false;

	const nodes = path.map((hash) => new Uint8Array(hash));
	if (isPowerOfTwo(firstSize)) nodes.unshift(new Uint8Array(firstRoot));
	let fn = firstSize - 1;
	let sn = secondSize - 1;
	while (fn % 2 === 1) {
		fn = Math.floor(fn / 2);
		sn = Math.floor(sn / 2);
	}
	let oldRoot = nodes[0] as Uint8Array;
	let newRoot = nodes[0] as Uint8Array;
	for (let index = 1; index < nodes.length; index++) {
		const node = nodes[index] as Uint8Array;
		if (sn === 0) return false;
		if (fn % 2 === 1 || fn === sn) {
			oldRoot = merkleNodeHash(node, oldRoot);
			newRoot = merkleNodeHash(node, newRoot);
			if (fn % 2 === 0) {
				while (fn % 2 === 0 && fn !== 0) {
					fn = Math.floor(fn / 2);
					sn = Math.floor(sn / 2);
				}
			}
		} else {
			newRoot = merkleNodeHash(newRoot, node);
		}
		fn = Math.floor(fn / 2);
		sn = Math.floor(sn / 2);
	}
	return sn === 0 && bytesEqual(oldRoot, firstRoot) && bytesEqual(newRoot, secondRoot);
}

function validateSnapshot(snapshot: Partial<AccumulatorSnapshot>): AccumulatorSnapshot {
	if (snapshot === null || typeof snapshot !== "object") throw new TypeError("snapshot must be an object");
	const { peaks = [], size = 0 } = snapshot;
	if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("invalid accumulator size");
	if (!Array.isArray(peaks)) throw new TypeError("accumulator peaks must be an array");
	const highestLevel = size === 0 ? -1 : Math.floor(Math.log2(size));
	if (peaks.length !== highestLevel + 1) throw new Error("corrupt compact Merkle accumulator snapshot");
	const copied: Array<Uint8Array | null> = [];
	for (let level = 0; level <= highestLevel; level++) {
		const peak = peaks[level];
		const occupied = Math.floor(size / 2 ** level) % 2 === 1;
		if (occupied) {
			if (!isHash(peak)) throw new Error("corrupt compact Merkle accumulator snapshot");
			copied.push(new Uint8Array(peak));
		} else {
			if (peak !== null) throw new Error("corrupt compact Merkle accumulator snapshot");
			copied.push(null);
		}
	}
	return { peaks: copied, size };
}

/** A compact RFC 9162 Merkle frontier with isolated snapshots. */
export class CompactMerkleAccumulator {
	private peaks: Array<Uint8Array | null>;
	private sizeValue: number;

	/**
	 * Creates an empty or restored accumulator.
	 * @param snapshot - Optional complete, validated snapshot.
	 */
	constructor(snapshot: Partial<AccumulatorSnapshot> = {}) {
		const validated = validateSnapshot(snapshot);
		this.sizeValue = validated.size;
		this.peaks = validated.peaks;
	}

	/**
	 * Reports the number of leaves appended to this accumulator.
	 * @returns The current safe-integer leaf count.
	 */
	get size(): number {
		return this.sizeValue;
	}

	/**
	 * Appends one copied leaf.
	 * @param input - Caller-owned leaf bytes.
	 * @returns This accumulator.
	 */
	append(input: Uint8Array | ArrayBuffer): CompactMerkleAccumulator {
		if (this.sizeValue === Number.MAX_SAFE_INTEGER) {
			throw new RangeError("accumulator size exceeds the safe-integer range");
		}
		let carry = merkleLeafHash(input);
		let level = 0;
		let count = this.sizeValue;
		while (count % 2 === 1) {
			const left = this.peaks[level];
			if (!isHash(left)) throw new Error("corrupt compact Merkle accumulator");
			carry = merkleNodeHash(left, carry);
			this.peaks[level] = null;
			count = Math.floor(count / 2);
			level++;
		}
		this.peaks[level] = carry;
		this.sizeValue++;
		return this;
	}

	/**
	 * Appends a validated batch, yielding between complete batches.
	 * @param inputs - Caller-owned leaf byte strings.
	 * @param options - Validated cooperative batching options.
	 * @param options.batchSize - Positive leaves-per-batch bound.
	 * @param options.yieldTask - Optional cooperative task boundary.
	 * @returns This accumulator after every append.
	 */
	async appendMany(
		inputs: readonly (Uint8Array | ArrayBuffer)[],
		{ batchSize = 256, yieldTask }: BatchOptions = {}
	): Promise<CompactMerkleAccumulator> {
		if (!Array.isArray(inputs)) throw new TypeError("inputs must be an array");
		validateBatchSize(batchSize);
		if (yieldTask !== undefined && typeof yieldTask !== "function") throw new TypeError("yieldTask must be a function");
		const copiedInputs = inputs.map(copyInput);
		for (let index = 0; index < copiedInputs.length; index++) {
			this.append(copiedInputs[index] as Uint8Array);
			if (yieldTask !== undefined && (index + 1) % batchSize === 0 && index + 1 < copiedInputs.length) {
				await yieldTask();
			}
		}
		return this;
	}

	/**
	 * Computes the current tree root.
	 * @returns A fresh 32-byte root.
	 */
	root(): Uint8Array {
		if (this.sizeValue === 0) return new Uint8Array(emptyMerkleRoot);
		let root: Uint8Array | null = null;
		for (const peak of this.peaks) {
			if (peak === null) continue;
			if (!isHash(peak)) throw new Error("corrupt compact Merkle accumulator");
			root = root === null ? new Uint8Array(peak) : merkleNodeHash(peak, root);
		}
		if (root === null) throw new Error("corrupt compact Merkle accumulator");
		return new Uint8Array(root);
	}

	/**
	 * Returns an isolated accumulator snapshot.
	 * @returns A deep copy of the size and peaks.
	 */
	snapshot(): AccumulatorSnapshot {
		return {
			peaks: this.peaks.map((peak) => (peak === null ? null : new Uint8Array(peak))),
			size: this.sizeValue,
		};
	}

	/**
	 * Restores an isolated accumulator from a validated snapshot.
	 * @param snapshot - Complete snapshot.
	 * @returns An independent accumulator.
	 */
	static fromSnapshot(snapshot: AccumulatorSnapshot): CompactMerkleAccumulator {
		return new CompactMerkleAccumulator(snapshot);
	}
}

export type { AccumulatorSnapshot, BatchOptions, ConsistencyProof, InclusionProof, MerkleTree };
