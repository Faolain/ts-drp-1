/* eslint-disable jsdoc/require-param-description, jsdoc/require-returns -- independent tests-only oracle */
import { createHash } from "node:crypto";

/**
 *
 * @param parts
 */
export function sha256(...parts: readonly Uint8Array[]): Uint8Array {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part);
	return new Uint8Array(hash.digest());
}

/**
 *
 * @param left
 * @param right
 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/**
 *
 * @param left
 * @param right
 */
export function compareBytes(left: Uint8Array, right: Uint8Array): number {
	const length = Math.min(left.byteLength, right.byteLength);
	for (let index = 0; index < length; index++) {
		if (left[index] !== right[index]) return (left[index] as number) < (right[index] as number) ? -1 : 1;
	}
	return left.byteLength < right.byteLength ? -1 : left.byteLength > right.byteLength ? 1 : 0;
}

/**
 *
 * @param input
 */
export function rfcLeafHash(input: Uint8Array): Uint8Array {
	return sha256(Uint8Array.of(0), input);
}

/**
 *
 * @param left
 * @param right
 */
export function rfcNodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
	return sha256(Uint8Array.of(1), left, right);
}

function u32be(value: number): Uint8Array {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, false);
	return bytes;
}

function u64be(value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
	return bytes;
}

/**
 *
 * @param domain
 * @param parts
 */
export function domainHash(domain: string, parts: readonly Uint8Array[]): Uint8Array {
	const domainBytes = new TextEncoder().encode(domain);
	const framed = [Uint8Array.of(0x44, 0x52, 0x50, 0), u32be(domainBytes.byteLength), domainBytes];
	for (const part of parts) framed.push(u64be(part.byteLength), part);
	return sha256(...framed);
}

function largestPowerOfTwoLessThan(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 1) throw new RangeError("expected an integer greater than one");
	return 2 ** Math.floor(Math.log2(value - 1));
}

/**
 *
 * @param inputs
 * @param start
 * @param length
 */
export function rfcRangeHash(inputs: readonly Uint8Array[], start: number, length: number): Uint8Array {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) {
		throw new RangeError("invalid range");
	}
	if (start + length > inputs.length) throw new RangeError("range exceeds inputs");
	if (length === 0) return sha256(new Uint8Array());
	if (length === 1) return rfcLeafHash(inputs[start] as Uint8Array);
	const split = largestPowerOfTwoLessThan(length);
	return rfcNodeHash(rfcRangeHash(inputs, start, split), rfcRangeHash(inputs, start + split, length - split));
}

/**
 *
 * @param inputs
 */
export function rfcRoot(inputs: readonly Uint8Array[]): Uint8Array {
	return rfcRangeHash(inputs, 0, inputs.length);
}

/**
 *
 * @param leaves
 */
export function rfcAccumulatorSnapshot(
	leaves: readonly Uint8Array[]
): Readonly<{ peaks: Array<Uint8Array | null>; size: number }> {
	const peaks: Array<Uint8Array | null> = [];
	for (const [size, leaf] of leaves.entries()) {
		let carry = rfcLeafHash(leaf);
		let level = 0;
		let count = size;
		while (count % 2 === 1) {
			const left = peaks[level];
			if (left === null || left === undefined) throw new TypeError("independent accumulator lost an occupied peak");
			carry = rfcNodeHash(left, carry);
			peaks[level] = null;
			count = Math.floor(count / 2);
			level++;
		}
		peaks[level] = carry;
	}
	return { peaks, size: leaves.length };
}

/**
 *
 * @param inputs
 * @param index
 * @param start
 * @param length
 */
export function rfcInclusionPath(
	inputs: readonly Uint8Array[],
	index: number,
	start = 0,
	length = inputs.length
): Uint8Array[] {
	if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new RangeError("invalid inclusion index");
	if (length === 1) return [];
	const split = largestPowerOfTwoLessThan(length);
	if (index < split) {
		return [...rfcInclusionPath(inputs, index, start, split), rfcRangeHash(inputs, start + split, length - split)];
	}
	return [
		...rfcInclusionPath(inputs, index - split, start + split, length - split),
		rfcRangeHash(inputs, start, split),
	];
}

function rfcConsistencySubproof(
	inputs: readonly Uint8Array[],
	firstSize: number,
	start: number,
	secondSize: number,
	complete: boolean
): Uint8Array[] {
	if (firstSize === secondSize) return complete ? [] : [rfcRangeHash(inputs, start, secondSize)];
	const split = largestPowerOfTwoLessThan(secondSize);
	if (firstSize <= split) {
		return [
			...rfcConsistencySubproof(inputs, firstSize, start, split, complete),
			rfcRangeHash(inputs, start + split, secondSize - split),
		];
	}
	return [
		...rfcConsistencySubproof(inputs, firstSize - split, start + split, secondSize - split, false),
		rfcRangeHash(inputs, start, split),
	];
}

/**
 *
 * @param inputs
 * @param firstSize
 */
export function rfcConsistencyPath(inputs: readonly Uint8Array[], firstSize: number): Uint8Array[] {
	if (!Number.isSafeInteger(firstSize) || firstSize < 0 || firstSize > inputs.length) {
		throw new RangeError("invalid consistency prefix");
	}
	if (firstSize === 0 || firstSize === inputs.length) return [];
	return rfcConsistencySubproof(inputs, firstSize, 0, inputs.length, true);
}

/**
 *
 * @param ancestorMasks
 * @param ancestor
 * @param descendant
 */
export function expectedAncestor(ancestorMasks: readonly number[], ancestor: number, descendant: number): boolean {
	return ((ancestorMasks[descendant] as number) & (1 << ancestor)) !== 0;
}

/**
 *
 * @param ancestorMasks
 * @param left
 * @param right
 */
export function expectedRelated(ancestorMasks: readonly number[], left: number, right: number): boolean {
	return left === right || expectedAncestor(ancestorMasks, left, right) || expectedAncestor(ancestorMasks, right, left);
}

/**
 *
 * @param left
 * @param right
 */
export function semanticEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (left instanceof Uint8Array && right instanceof Uint8Array) return bytesEqual(left, right);
	if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
		return (
			left.constructor === right.constructor &&
			bytesEqual(
				new Uint8Array(left.buffer, left.byteOffset, left.byteLength),
				new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
			)
		);
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, index) => semanticEqual(value, right[index]));
	}
	if (left instanceof Map && right instanceof Map) {
		if (left.size !== right.size) return false;
		const unmatched = [...right];
		for (const [key, value] of left) {
			const index = unmatched.findIndex(
				([candidateKey, candidateValue]) => semanticEqual(key, candidateKey) && semanticEqual(value, candidateValue)
			);
			if (index < 0) return false;
			unmatched.splice(index, 1);
		}
		return true;
	}
	if (left instanceof Set && right instanceof Set) {
		if (left.size !== right.size) return false;
		const unmatched = [...right];
		for (const value of left) {
			const index = unmatched.findIndex((candidate) => semanticEqual(value, candidate));
			if (index < 0) return false;
			unmatched.splice(index, 1);
		}
		return true;
	}
	if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
		const leftPrototype = Object.getPrototypeOf(left);
		const rightPrototype = Object.getPrototypeOf(right);
		const leftIsPlainRecord = leftPrototype === null || leftPrototype === Object.prototype;
		const rightIsPlainRecord = rightPrototype === null || rightPrototype === Object.prototype;
		if (!leftIsPlainRecord || !rightIsPlainRecord) return false;
		const leftRecord = left as Record<string, unknown>;
		const rightRecord = right as Record<string, unknown>;
		const leftKeys = Object.keys(leftRecord).sort();
		const rightKeys = Object.keys(rightRecord).sort();
		return (
			semanticEqual(leftKeys, rightKeys) && leftKeys.every((key) => semanticEqual(leftRecord[key], rightRecord[key]))
		);
	}
	return false;
}

/**
 *
 * @param count
 * @param seed
 */
export function deterministicValues(count: number, seed: number): unknown[] {
	let state = seed >>> 0;
	const next = (): number => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state;
	};
	const strings = ["", "a", "Peer-A", "peer-ä", "peer_😀", "\u{10ffff}"] as const;
	return Array.from({ length: count }, (_, index) => {
		const first = next();
		const second = next();
		const signed = (first & 0x7fff_ffff) - 0x4000_0000;
		switch (index % 24) {
			case 0:
				return null;
			case 1:
				return (second & 1) === 0;
			case 2:
				return 0;
			case 3:
				return Number.MAX_SAFE_INTEGER;
			case 4:
				return Number.MIN_SAFE_INTEGER;
			case 5:
				return 2 ** 51 + 0.5;
			case 6:
				return -(2 ** 51 + 0.5);
			case 7:
				return Number.MIN_VALUE;
			case 8:
				return signed;
			case 9:
				return signed + 0.25;
			case 10:
				return strings[second % strings.length];
			case 11:
				return Uint8Array.of(first & 0xff, second & 0xff, (second >>> 8) & 0xff);
			case 12:
				return [signed, strings[second % strings.length], (first & 1) === 0];
			case 13:
				return { a: strings[second % strings.length], z: signed };
			case 14:
				return new Map<unknown, unknown>([
					["a", strings[second % strings.length]],
					["z", signed],
				]);
			case 15:
				return new Set<unknown>([signed, signed + 1]);
			case 16:
				return Float32Array.of((signed % 1024) + 0.5, (second % 1024) + 0.25);
			case 17:
				return Float64Array.of((signed % 4096) + 0.5, (second % 4096) + 0.25);
			case 18:
				return Int32Array.of(-2_147_483_648, 2_147_483_647);
			case 19:
				return Uint32Array.of(0, 4_294_967_295);
			case 20:
				return Int32Array.of(signed, second | 0);
			case 21:
				return Uint32Array.of(first, second);
			case 22:
				return [{ bytes: Uint8Array.of(first & 0xff), label: strings[second % strings.length] }];
			default:
				return new Map<unknown, unknown>([
					["nested", new Set<unknown>([Uint8Array.of(first & 0xff, second & 0xff), { signed }])],
				]);
		}
	});
}

/**
 *
 * @param bytes
 */
export function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
