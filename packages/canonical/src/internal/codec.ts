import { sha256 } from "@noble/hashes/sha2";

const TAG = Object.freeze({
	NULL: 0x00,
	FALSE: 0x01,
	TRUE: 0x02,
	INTEGER: 0x03,
	FLOAT64: 0x04,
	STRING: 0x05,
	BYTES: 0x06,
	ARRAY: 0x07,
	OBJECT: 0x08,
	MAP: 0x09,
	SET: 0x0a,
	FLOAT32_ARRAY: 0x0b,
	FLOAT64_ARRAY: 0x0c,
	INT32_ARRAY: 0x0d,
	UINT32_ARRAY: 0x0e,
});

export interface CanonicalLimits {
	maxBytes: number;
	maxDepth: number;
	maxItems: number;
}

const DEFAULT_LIMITS: Readonly<CanonicalLimits> = Object.freeze({
	maxDepth: 128,
	maxItems: 1_000_000,
	maxBytes: 256 * 1024 * 1024,
});
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const intrinsicTextDecoder = TextDecoder;
const textEncoder = new TextEncoder();
const SharedArrayBufferConstructor = typeof SharedArrayBuffer === "function" ? SharedArrayBuffer : undefined;
const MEMO_VIEW_OVERRIDES = ["buffer", "byteLength", "byteOffset", "length"];

/** Only ordinary unshared views: exotic or instrumented carriers keep the original path. */
function plainMemoView(part: unknown): part is Uint8Array {
	return part instanceof Uint8Array && Object.getPrototypeOf(part) === Uint8Array.prototype &&
		!MEMO_VIEW_OVERRIDES.some((name) => Object.hasOwn(part, name)) &&
		!(SharedArrayBufferConstructor !== undefined && part.buffer instanceof SharedArrayBufferConstructor);
}

// Body copies use the intrinsic length, as the frozen tree encoder's `new Uint8Array(value)` did.
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype) as object, "byteLength")!.get!;
const DRP_ERROR_BRAND = Symbol.for("@ts-drp/errors/DRPError");

/** A value cannot be represented by the frozen canonical codec. */
export class CanonicalEncodingError extends TypeError {
	readonly [DRP_ERROR_BRAND] = true;
	readonly code = "CANONICAL_ENCODING";
}

/** Bytes are malformed or use a non-canonical representation. */
export class CanonicalDecodingError extends TypeError {
	readonly [DRP_ERROR_BRAND] = true;
	readonly code = "CANONICAL_DECODING";
	declare readonly resourceLimit?: "bytes" | "depth" | "items";

	/**
	 * Preserves ordinary malformed-byte errors while labelling resource exhaustion.
	 * @param message - Decoder failure detail.
	 * @param resourceLimit - Exact exhausted resource, absent for malformed bytes.
	 */
	public constructor(message?: string, resourceLimit?: "bytes" | "depth" | "items") {
		super(message);
		if (resourceLimit !== undefined) this.resourceLimit = resourceLimit;
	}
}

/**
 * Compares byte strings lexicographically by unsigned byte value.
 * @param left - Left-hand byte string.
 * @param right - Right-hand byte string.
 * @returns A negative value, zero, or a positive value according to the ordering.
 */
export function compareBytes(left: Uint8Array, right: Uint8Array): number {
	const length = Math.min(left.byteLength, right.byteLength);
	let start = 0;
	// Long equal prefixes dominate; skip them a word at a time on ordinary
	// aligned views. The first differing word is then ordered byte by byte.
	if (length >= 64 && (left.byteOffset & 3) === 0 && (right.byteOffset & 3) === 0 &&
		plainMemoView(left) && plainMemoView(right)) {
		const words = length >>> 2;
		const a = new Int32Array(left.buffer, left.byteOffset, words);
		const b = new Int32Array(right.buffer, right.byteOffset, words);
		while (start < words && a[start] === b[start]) start++;
		start <<= 2;
	}
	for (let index = start; index < length; index++) {
		const leftByte = left[index] as number;
		const rightByte = right[index] as number;
		if (leftByte !== rightByte) return leftByte < rightByte ? -1 : 1;
	}
	return left.byteLength === right.byteLength ? 0 : left.byteLength < right.byteLength ? -1 : 1;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return compareBytes(left, right) === 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

type EncodedValue = Uint8Array | Readonly<{ byteLength: number; parts: readonly EncodedValue[] }>;

interface CapturedEncoding {
	readonly encoded: EncodedValue;
	readonly maxDepth: number;
	readonly limits: Readonly<CanonicalLimits>;
}
interface EncodingCaptureTraversal {
	readonly fragments: WeakMap<object, CapturedEncoding>;
	maxDepth: number;
}
class CapturedCanonicalValue {
	public constructor(public readonly byteLength: number) { Object.freeze(this); }
}
Object.freeze(CapturedCanonicalValue.prototype);
Object.freeze(CapturedCanonicalValue);

/** Caller values are traversed once. Leaves already own their byte snapshots;
 * container assembly records order/length without copying every descendant. */
function encodedParts(parts: readonly EncodedValue[]): EncodedValue {
	let byteLength = 0;
	for (const part of parts) byteLength += part.byteLength;
	return { byteLength, parts };
}

function writeEncoded(value: EncodedValue, output: Uint8Array, offset: number): number {
	if (value instanceof Uint8Array) {
		output.set(value, offset);
		return offset + value.byteLength;
	}
	for (const part of value.parts) offset = writeEncoded(part, output, offset);
	return offset;
}

/** Sorting requires complete key/item bytes at the original traversal point.
 * Other containers are flattened only at the public encoder's final output. */
function flattenEncoded(value: EncodedValue): Uint8Array {
	if (value instanceof Uint8Array) return value;
	const output = new Uint8Array(value.byteLength);
	writeEncoded(value, output, 0);
	return output;
}

function assertWellFormedString(value: string): void {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				throw new CanonicalEncodingError("string contains an unpaired surrogate");
			}
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new CanonicalEncodingError("string contains an unpaired surrogate");
		}
	}
}

function encodeVarUint(input: number | bigint): Uint8Array {
	if (typeof input === "number" && Number.isSafeInteger(input) && input >= 0) {
		// Exact Number arithmetic for every safe integer: identical bytes, no BigInt.
		let count = 1;
		for (let rest = input; rest >= 0x80; rest = Math.floor(rest / 0x80)) count++;
		const output = new Uint8Array(count);
		let value = input;
		for (let index = 0; index < count - 1; index++) {
			output[index] = (value % 0x80) | 0x80;
			value = Math.floor(value / 0x80);
		}
		output[count - 1] = value;
		return output;
	}
	let value = typeof input === "bigint" ? input : BigInt(input);
	if (value < BigInt(0)) throw new CanonicalEncodingError("varuint cannot be negative");
	const output: number[] = [];
	do {
		let byte = Number(value & BigInt(0x7f));
		value >>= BigInt(7);
		if (value !== BigInt(0)) byte |= 0x80;
		output.push(byte);
	} while (value !== BigInt(0));
	return Uint8Array.from(output);
}

function zigZagEncode(value: number): bigint {
	const integer = BigInt(value);
	return integer >= BigInt(0) ? integer << BigInt(1) : (-integer << BigInt(1)) - BigInt(1);
}

function float64Bytes(value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setFloat64(0, value, false);
	return bytes;
}

function typedArrayBytes(
	length: number,
	bytesPerElement: number,
	write: (view: DataView, index: number) => void
): Uint8Array {
	const bytes = new Uint8Array(length * bytesPerElement);
	const view = new DataView(bytes.buffer);
	for (let index = 0; index < length; index++) write(view, index);
	return bytes;
}

function isPlainObject(value: object): boolean {
	const prototype: object | null = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function encodeInternal(
	value: unknown,
	active: Set<object>,
	depth: number,
	limits: Readonly<CanonicalLimits>,
	capture?: EncodingCaptureTraversal
): EncodedValue {
	if (depth > limits.maxDepth) throw new CanonicalEncodingError("canonical value exceeds maximum nesting depth");
	if (capture !== undefined) {
		capture.maxDepth = Math.max(capture.maxDepth, depth);
		if (value instanceof CapturedCanonicalValue) {
			const original = capture.fragments.get(value);
			if (original === undefined) throw new CanonicalEncodingError("foreign or released canonical capture");
			// Captures are syntax/data only. Reuse cannot relax any original child
			// item/string/byte rule; the ORIGINAL parent traversal and final byte
			// check still run. Depth is checked at this exact insertion point.
			if (!(limits.maxItems >= original.limits.maxItems && limits.maxBytes >= original.limits.maxBytes))
				throw new CanonicalEncodingError("canonical capture requires dominating byte and item limits");
			if (depth + original.maxDepth > limits.maxDepth)
				throw new CanonicalEncodingError("canonical value exceeds maximum nesting depth");
			capture.maxDepth = Math.max(capture.maxDepth, depth + original.maxDepth);
			return original.encoded;
		}
	}
	if (value === null) return Uint8Array.of(TAG.NULL);
	if (value === false) return Uint8Array.of(TAG.FALSE);
	if (value === true) return Uint8Array.of(TAG.TRUE);

	if (typeof value === "string") {
		assertWellFormedString(value);
		const bytes = textEncoder.encode(value);
		if (bytes.byteLength > limits.maxBytes) throw new CanonicalEncodingError("string exceeds byte limit");
		return encodedParts([Uint8Array.of(TAG.STRING), encodeVarUint(bytes.byteLength), bytes]);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new CanonicalEncodingError("NaN and Infinity are outside the canonical domain");
		}
		const normalized = Object.is(value, -0) ? 0 : value;
		if (Number.isInteger(normalized)) {
			if (!Number.isSafeInteger(normalized)) {
				throw new CanonicalEncodingError("integer must be within JavaScript's safe range");
			}
			// Exact in Number arithmetic in the same range as the single-pass writer.
			const zigZag = normalized >= 0 ? normalized * 2 : normalized >= -0x10000000000000 ? -normalized * 2 - 1 : undefined;
			return encodedParts([Uint8Array.of(TAG.INTEGER), encodeVarUint(zigZag ?? zigZagEncode(normalized))]);
		}
		return encodedParts([Uint8Array.of(TAG.FLOAT64), float64Bytes(normalized)]);
	}
	if (typeof value !== "object") {
		throw new CanonicalEncodingError(`${typeof value} is outside the canonical domain`);
	}
	if (active.has(value)) throw new CanonicalEncodingError("cyclic values are outside the canonical domain");
	active.add(value);

	try {
		if (value instanceof Uint8Array) {
			return encodedParts([Uint8Array.of(TAG.BYTES), encodeVarUint(value.byteLength), new Uint8Array(value)]);
		}
		if (value instanceof Float32Array) {
			for (const item of value) {
				if (!Number.isFinite(item)) {
					throw new CanonicalEncodingError("typed arrays cannot contain NaN or Infinity");
				}
			}
			const bytes = typedArrayBytes(value.length, 4, (view, index) => {
				const item = value[index] as number;
				view.setFloat32(index * 4, Object.is(item, -0) ? 0 : item, false);
			});
			return encodedParts([Uint8Array.of(TAG.FLOAT32_ARRAY), encodeVarUint(value.length), bytes]);
		}
		if (value instanceof Float64Array) {
			for (const item of value) {
				if (!Number.isFinite(item)) {
					throw new CanonicalEncodingError("typed arrays cannot contain NaN or Infinity");
				}
			}
			const bytes = typedArrayBytes(value.length, 8, (view, index) => {
				const item = value[index] as number;
				view.setFloat64(index * 8, Object.is(item, -0) ? 0 : item, false);
			});
			return encodedParts([Uint8Array.of(TAG.FLOAT64_ARRAY), encodeVarUint(value.length), bytes]);
		}
		if (value instanceof Int32Array) {
			const bytes = typedArrayBytes(value.length, 4, (view, index) => {
				view.setInt32(index * 4, value[index] as number, false);
			});
			return encodedParts([Uint8Array.of(TAG.INT32_ARRAY), encodeVarUint(value.length), bytes]);
		}
		if (value instanceof Uint32Array) {
			const bytes = typedArrayBytes(value.length, 4, (view, index) => {
				view.setUint32(index * 4, value[index] as number, false);
			});
			return encodedParts([Uint8Array.of(TAG.UINT32_ARRAY), encodeVarUint(value.length), bytes]);
		}
		if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp) {
			throw new CanonicalEncodingError("value requires an explicit protocol codec");
		}
		if (Array.isArray(value)) {
			if (value.length > limits.maxItems) throw new CanonicalEncodingError("array exceeds item limit");
			const parts: EncodedValue[] = [Uint8Array.of(TAG.ARRAY), encodeVarUint(value.length)];
			for (let index = 0; index < value.length; index++) {
				if (!Object.hasOwn(value, index)) {
					throw new CanonicalEncodingError("sparse arrays are outside the canonical domain");
				}
				parts.push(encodeInternal(value[index], active, depth + 1, limits, capture));
			}
			return encodedParts(parts);
		}
		if (value instanceof Map) {
			if (value.size > limits.maxItems) throw new CanonicalEncodingError("map exceeds item limit");
			const entries: { keyBytes: Uint8Array; valueBytes: EncodedValue }[] = [];
			for (const [key, item] of value.entries()) {
				entries.push({
					keyBytes: flattenEncoded(encodeInternal(key, active, depth + 1, limits, capture)),
					valueBytes: encodeInternal(item, active, depth + 1, limits, capture),
				});
			}
			entries.sort((left, right) => compareBytes(left.keyBytes, right.keyBytes));
			for (let index = 1; index < entries.length; index++) {
				const previous = entries[index - 1];
				const current = entries[index];
				if (previous !== undefined && current !== undefined && bytesEqual(previous.keyBytes, current.keyBytes)) {
					throw new CanonicalEncodingError("map contains duplicate canonical keys");
				}
			}
			return encodedParts([
				Uint8Array.of(TAG.MAP),
				encodeVarUint(entries.length),
				...entries.flatMap(({ keyBytes, valueBytes }) => [keyBytes, valueBytes]),
			]);
		}
		if (value instanceof Set) {
			if (value.size > limits.maxItems) throw new CanonicalEncodingError("set exceeds item limit");
			const items = [...value].map((item) => flattenEncoded(encodeInternal(item, active, depth + 1, limits, capture)));
			items.sort(compareBytes);
			for (let index = 1; index < items.length; index++) {
				const previous = items[index - 1];
				const current = items[index];
				if (previous !== undefined && current !== undefined && bytesEqual(previous, current)) {
					throw new CanonicalEncodingError("set contains duplicate canonical values");
				}
			}
			return encodedParts([Uint8Array.of(TAG.SET), encodeVarUint(items.length), ...items]);
		}
		if (!isPlainObject(value)) {
			throw new CanonicalEncodingError("class instances require an explicit snapshot codec");
		}

		if (Object.getOwnPropertySymbols(value).length !== 0) {
			throw new CanonicalEncodingError("symbol keys are outside the canonical domain");
		}
		const entries: { keyBytes: Uint8Array; valueBytes: EncodedValue }[] = [];
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (!descriptor.enumerable) continue;
			if (!Object.hasOwn(descriptor, "value")) {
				throw new CanonicalEncodingError(`accessor property ${key} is outside the canonical domain`);
			}
			assertWellFormedString(key);
			entries.push({
				keyBytes: flattenEncoded(encodeInternal(key, active, depth + 1, limits, capture)),
				valueBytes: encodeInternal(descriptor.value, active, depth + 1, limits, capture),
			});
		}
		entries.sort((left, right) => compareBytes(left.keyBytes, right.keyBytes));
		return encodedParts([
			Uint8Array.of(TAG.OBJECT),
			encodeVarUint(entries.length),
			...entries.flatMap(({ keyBytes, valueBytes }) => [keyBytes, valueBytes]),
		]);
	} finally {
		active.delete(value);
	}
}

/** Growable output of the single-pass encoder. Writers are pooled per
 * (re)entrant call; encoded bytes are always copied out before release. */
class ByteWriter {
	public buffer: Uint8Array;
	public view: DataView;
	public offset = 0;

	public constructor(capacity: number) {
		this.buffer = new Uint8Array(capacity);
		this.view = new DataView(this.buffer.buffer);
	}

	public reserve(length: number): void {
		const needed = this.offset + length;
		if (needed <= this.buffer.byteLength) return;
		let capacity = this.buffer.byteLength * 2;
		while (capacity < needed) capacity *= 2;
		const next = new Uint8Array(capacity);
		next.set(this.buffer.subarray(0, this.offset));
		this.buffer = next;
		this.view = new DataView(next.buffer);
	}

	public byte(value: number): void {
		if (this.offset === this.buffer.byteLength) this.reserve(1);
		this.buffer[this.offset++] = value;
	}

	/** Exact for every non-negative integer a double represents exactly. */
	public varUint(value: number): void {
		this.reserve(10);
		const buffer = this.buffer;
		let offset = this.offset;
		while (value > 0x7fffffff) {
			buffer[offset++] = (value % 0x80) | 0x80;
			value = Math.floor(value / 0x80);
		}
		while (value >= 0x80) {
			buffer[offset++] = (value & 0x7f) | 0x80;
			value >>>= 7;
		}
		buffer[offset++] = value;
		this.offset = offset;
	}

	public bytes(value: Uint8Array): void {
		this.reserve(value.byteLength);
		this.buffer.set(value, this.offset);
		this.offset += value.byteLength;
	}

	/** Copies a caller-owned view without consulting its (possibly own) `byteLength` property. */
	public foreignBytes(value: Uint8Array): void {
		const length = Reflect.apply(typedArrayByteLength, value, []) as number;
		this.reserve(length);
		this.buffer.set(value, this.offset);
		this.offset += length;
	}
}

const WRITER_POOL: ByteWriter[] = [];
const POOLED_WRITER_MAX_BYTES = 1 << 20;

/** Encoded object keys are a small schema vocabulary; their exact canonical
 * STRING bytes (tag, one-byte length, UTF-8) are immutable and reused. */
const KEY_CACHE = new Map<string, Uint8Array>();
const KEY_CACHE_LIMIT = 8192;

function writeUtf8(writer: ByteWriter, value: string, byteLength: number, ascii: boolean): void {
	writer.reserve(byteLength);
	const buffer = writer.buffer;
	let offset = writer.offset;
	if (byteLength > 64) {
		offset += textEncoder.encodeInto(value, buffer.subarray(offset, offset + byteLength)).written;
	} else if (ascii) {
		for (let index = 0; index < value.length; index++) buffer[offset++] = value.charCodeAt(index);
	} else {
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index);
			if (code < 0x80) buffer[offset++] = code;
			else if (code < 0x800) {
				buffer[offset++] = 0xc0 | (code >> 6);
				buffer[offset++] = 0x80 | (code & 0x3f);
			} else if (code >= 0xd800 && code <= 0xdbff) {
				const point = ((code - 0xd800) << 10) + (value.charCodeAt(++index) - 0xdc00) + 0x10000;
				buffer[offset++] = 0xf0 | (point >> 18);
				buffer[offset++] = 0x80 | ((point >> 12) & 0x3f);
				buffer[offset++] = 0x80 | ((point >> 6) & 0x3f);
				buffer[offset++] = 0x80 | (point & 0x3f);
			} else {
				buffer[offset++] = 0xe0 | (code >> 12);
				buffer[offset++] = 0x80 | ((code >> 6) & 0x3f);
				buffer[offset++] = 0x80 | (code & 0x3f);
			}
		}
	}
	if (offset !== writer.offset + byteLength) throw new CanonicalEncodingError("string encoding length changed");
	writer.offset = offset;
}

/** One scan performs assertWellFormedString's exact validation and measures
 * the UTF-8 length; the frozen string byte limit is checked afterwards. */
function writeString(writer: ByteWriter, value: string, limits: Readonly<CanonicalLimits>): void {
	const length = value.length;
	let byteLength = length;
	let ascii = true;
	for (let index = 0; index < length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x80) continue;
		ascii = false;
		if (code < 0x800) byteLength += 1;
		else if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CanonicalEncodingError("string contains an unpaired surrogate");
			index++;
			byteLength += 2;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new CanonicalEncodingError("string contains an unpaired surrogate");
		} else byteLength += 2;
	}
	if (byteLength > limits.maxBytes) throw new CanonicalEncodingError("string exceeds byte limit");
	writer.byte(TAG.STRING);
	writer.varUint(byteLength);
	writeUtf8(writer, value, byteLength, ascii);
}

/** Object keys: identical checks and order to encoding the key as a value at
 * `depth` after the caller's well-formedness check, with exact-byte reuse. */
function writeKey(writer: ByteWriter, key: string, depth: number, limits: Readonly<CanonicalLimits>): void {
	const cached = KEY_CACHE.get(key);
	if (cached !== undefined) {
		if (depth > limits.maxDepth) throw new CanonicalEncodingError("canonical value exceeds maximum nesting depth");
		if (cached.byteLength - 2 > limits.maxBytes) throw new CanonicalEncodingError("string exceeds byte limit");
		writer.bytes(cached);
		return;
	}
	assertWellFormedString(key);
	if (depth > limits.maxDepth) throw new CanonicalEncodingError("canonical value exceeds maximum nesting depth");
	const start = writer.offset;
	writeString(writer, key, limits);
	// Only one-byte lengths: the cached bytes then carry their UTF-8 length.
	if (writer.offset - start <= 129 && writer.buffer[start + 1]! < 0x80) {
		if (KEY_CACHE.size >= KEY_CACHE_LIMIT) KEY_CACHE.clear();
		KEY_CACHE.set(key, writer.buffer.slice(start, writer.offset));
	}
}

function writeInteger(writer: ByteWriter, value: number): void {
	writer.byte(TAG.INTEGER);
	if (value >= 0) writer.varUint(value * 2);
	else if (value >= -0x10000000000000) writer.varUint(-value * 2 - 1);
	else {
		let encoded = zigZagEncode(value);
		writer.reserve(10);
		do {
			let byte = Number(encoded & BigInt(0x7f));
			encoded >>= BigInt(7);
			if (encoded !== BigInt(0)) byte |= 0x80;
			writer.buffer[writer.offset++] = byte;
		} while (encoded !== BigInt(0));
	}
}

interface SortedEntry {
	readonly keyStart: number;
	readonly keyEnd: number;
	readonly end: number;
}

function compareRanges(buffer: Uint8Array, leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): number {
	const leftLength = leftEnd - leftStart;
	const rightLength = rightEnd - rightStart;
	const length = leftLength < rightLength ? leftLength : rightLength;
	for (let index = 0; index < length; index++) {
		const leftByte = buffer[leftStart + index]!;
		const rightByte = buffer[rightStart + index]!;
		if (leftByte !== rightByte) return leftByte < rightByte ? -1 : 1;
	}
	return leftLength === rightLength ? 0 : leftLength < rightLength ? -1 : 1;
}

/** Entries were written in the ORIGINAL traversal order (so validation and
 * error precedence are unchanged); emit the header, then canonical order. */
function finishSorted(writer: ByteWriter, regionStart: number, tag: number, entries: SortedEntry[],
	duplicate: string | undefined): void {
	const buffer = writer.buffer;
	let sorted = true;
	for (let index = 1; index < entries.length; index++) {
		const previous = entries[index - 1]!, current = entries[index]!;
		if (compareRanges(buffer, previous.keyStart, previous.keyEnd, current.keyStart, current.keyEnd) >= 0) {
			sorted = false;
			break;
		}
	}
	const count = entries.length;
	if (!sorted) {
		// Only the emitted order is needed afterwards; sort the caller's own array.
		entries.sort((left, right) => compareRanges(buffer, left.keyStart, left.keyEnd, right.keyStart, right.keyEnd));
		if (duplicate !== undefined) {
			for (let index = 1; index < count; index++) {
				const previous = entries[index - 1]!, current = entries[index]!;
				if (compareRanges(buffer, previous.keyStart, previous.keyEnd, current.keyStart, current.keyEnd) === 0)
					throw new CanonicalEncodingError(duplicate);
			}
		}
	}
	const regionEnd = writer.offset, regionLength = regionEnd - regionStart;
	let headerLength = 2;
	for (let rest = count; rest >= 0x80; rest = Math.floor(rest / 0x80)) headerLength++;
	// Unsorted entries are staged past the final output, inside the same buffer.
	writer.reserve(sorted ? headerLength : headerLength + regionLength);
	const output = writer.buffer;
	const scratch = regionEnd + headerLength;
	if (sorted) output.copyWithin(regionStart + headerLength, regionStart, regionEnd);
	else output.copyWithin(scratch, regionStart, regionEnd);
	output[regionStart] = tag;
	let value = count;
	for (let index = regionStart + 1; index < regionStart + headerLength - 1; index++) {
		output[index] = (value % 0x80) | 0x80;
		value = Math.floor(value / 0x80);
	}
	output[regionStart + headerLength - 1] = value;
	if (!sorted) {
		let offset = regionStart + headerLength;
		for (const entry of entries) {
			output.copyWithin(offset, scratch + entry.keyStart - regionStart, scratch + entry.end - regionStart);
			offset += entry.end - entry.keyStart;
		}
	}
	writer.offset = regionEnd + headerLength;
}

/** The single-pass equivalent of `encodeInternal` without capture: identical
 * bytes, validation, traversal/trap order and error precedence. */
function writeValue(writer: ByteWriter, value: unknown, active: Set<object>, depth: number,
	limits: Readonly<CanonicalLimits>): void {
	if (depth > limits.maxDepth) throw new CanonicalEncodingError("canonical value exceeds maximum nesting depth");
	if (value === null) return writer.byte(TAG.NULL);
	if (value === false) return writer.byte(TAG.FALSE);
	if (value === true) return writer.byte(TAG.TRUE);
	if (typeof value === "string") return writeString(writer, value, limits);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new CanonicalEncodingError("NaN and Infinity are outside the canonical domain");
		const normalized = value === 0 ? 0 : value;
		if (Number.isInteger(normalized)) {
			if (!Number.isSafeInteger(normalized))
				throw new CanonicalEncodingError("integer must be within JavaScript's safe range");
			return writeInteger(writer, normalized);
		}
		writer.byte(TAG.FLOAT64);
		writer.reserve(8);
		writer.view.setFloat64(writer.offset, normalized, false);
		writer.offset += 8;
		return;
	}
	if (typeof value !== "object") throw new CanonicalEncodingError(`${typeof value} is outside the canonical domain`);
	if (active.has(value)) throw new CanonicalEncodingError("cyclic values are outside the canonical domain");
	active.add(value);
	try {
		if (value instanceof Uint8Array) {
			writer.byte(TAG.BYTES);
			writer.varUint(value.byteLength);
			writer.foreignBytes(value);
			return;
		}
		if (value instanceof Float32Array) {
			for (const item of value) {
				if (!Number.isFinite(item)) throw new CanonicalEncodingError("typed arrays cannot contain NaN or Infinity");
			}
			// Read `length` exactly twice (body, then header) like the frozen encoder.
			const length = value.length, headerLength = value.length;
			writer.byte(TAG.FLOAT32_ARRAY);
			writer.varUint(headerLength);
			writer.reserve(length * 4);
			for (let index = 0; index < length; index++) {
				const item = value[index] as number;
				writer.view.setFloat32(writer.offset, item === 0 ? 0 : item, false);
				writer.offset += 4;
			}
			return;
		}
		if (value instanceof Float64Array) {
			for (const item of value) {
				if (!Number.isFinite(item)) throw new CanonicalEncodingError("typed arrays cannot contain NaN or Infinity");
			}
			const length = value.length, headerLength = value.length;
			writer.byte(TAG.FLOAT64_ARRAY);
			writer.varUint(headerLength);
			writer.reserve(length * 8);
			for (let index = 0; index < length; index++) {
				const item = value[index] as number;
				writer.view.setFloat64(writer.offset, item === 0 ? 0 : item, false);
				writer.offset += 8;
			}
			return;
		}
		if (value instanceof Int32Array || value instanceof Uint32Array) {
			const signed = value instanceof Int32Array;
			const length = value.length, headerLength = value.length;
			writer.byte(signed ? TAG.INT32_ARRAY : TAG.UINT32_ARRAY);
			writer.varUint(headerLength);
			writer.reserve(length * 4);
			for (let index = 0; index < length; index++) {
				if (signed) writer.view.setInt32(writer.offset, value[index] as number, false);
				else writer.view.setUint32(writer.offset, value[index] as number, false);
				writer.offset += 4;
			}
			return;
		}
		if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp) {
			throw new CanonicalEncodingError("value requires an explicit protocol codec");
		}
		if (Array.isArray(value)) {
			if (value.length > limits.maxItems) throw new CanonicalEncodingError("array exceeds item limit");
			writer.byte(TAG.ARRAY);
			writer.varUint(value.length);
			for (let index = 0; index < value.length; index++) {
				if (!Object.hasOwn(value, index)) {
					throw new CanonicalEncodingError("sparse arrays are outside the canonical domain");
				}
				writeValue(writer, value[index], active, depth + 1, limits);
			}
			return;
		}
		if (value instanceof Map) {
			if (value.size > limits.maxItems) throw new CanonicalEncodingError("map exceeds item limit");
			const regionStart = writer.offset;
			const entries: SortedEntry[] = [];
			for (const [key, item] of value.entries()) {
				const keyStart = writer.offset;
				writeValue(writer, key, active, depth + 1, limits);
				const keyEnd = writer.offset;
				writeValue(writer, item, active, depth + 1, limits);
				entries.push({ keyStart, keyEnd, end: writer.offset });
			}
			return finishSorted(writer, regionStart, TAG.MAP, entries, "map contains duplicate canonical keys");
		}
		if (value instanceof Set) {
			if (value.size > limits.maxItems) throw new CanonicalEncodingError("set exceeds item limit");
			const members = [...value];
			const regionStart = writer.offset;
			const entries: SortedEntry[] = [];
			for (const item of members) {
				const keyStart = writer.offset;
				writeValue(writer, item, active, depth + 1, limits);
				entries.push({ keyStart, keyEnd: writer.offset, end: writer.offset });
			}
			return finishSorted(writer, regionStart, TAG.SET, entries, "set contains duplicate canonical values");
		}
		if (!isPlainObject(value)) {
			throw new CanonicalEncodingError("class instances require an explicit snapshot codec");
		}
		if (Object.getOwnPropertySymbols(value).length !== 0) {
			throw new CanonicalEncodingError("symbol keys are outside the canonical domain");
		}
		const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
		const regionStart = writer.offset;
		const entries: SortedEntry[] = [];
		for (const key of Object.keys(descriptors)) {
			const descriptor = descriptors[key]!;
			if (!descriptor.enumerable) continue;
			if (!Object.hasOwn(descriptor, "value")) {
				throw new CanonicalEncodingError(`accessor property ${key} is outside the canonical domain`);
			}
			const keyStart = writer.offset;
			writeKey(writer, key, depth + 1, limits);
			const keyEnd = writer.offset;
			writeValue(writer, descriptor.value, active, depth + 1, limits);
			entries.push({ keyStart, keyEnd, end: writer.offset });
		}
		return finishSorted(writer, regionStart, TAG.OBJECT, entries, undefined);
	} finally {
		active.delete(value);
	}
}

/** Observer of public encoder/decoder calls (measurement only). */
export type CanonicalCallObserver = (kind: "encode" | "decode", byteLength: number) => void;

/* Measurement seam: unset unless a count-based cost test installs it. The hot path only compares
 * this module binding with undefined; no counter, no property lookup, and the encoder's output never
 * depends on it. */
let callObserver: CanonicalCallObserver | undefined;

/**
 * Installs (or, with undefined, removes) the observer of public encode/decode calls. Measurement
 * only: never authority, never consulted for any result.
 * @param observer - Called once per successful encode and once per decode entry.
 */
export function observeCanonicalCalls(observer: CanonicalCallObserver | undefined): void {
	callObserver = observer;
}

/**
 * Encodes a value with the frozen reference tag codec.
 * @param value - Value in the canonical data domain.
 * @param limits - Optional resource-limit overrides.
 * @returns Canonical bytes.
 */
export function encodeCanonical(value: unknown, limits: Partial<CanonicalLimits> = {}): Uint8Array {
	const configured: CanonicalLimits = { ...DEFAULT_LIMITS, ...limits };
	const writer = WRITER_POOL.pop() ?? new ByteWriter(1024);
	writer.offset = 0;
	try {
		writeValue(writer, value, new Set<object>(), 0, configured);
		if (writer.offset > configured.maxBytes) {
			throw new CanonicalEncodingError("canonical value exceeds byte limit");
		}
		if (callObserver !== undefined) callObserver("encode", writer.offset);
		return writer.buffer.slice(0, writer.offset);
	} finally {
		if (writer.buffer.byteLength <= POOLED_WRITER_MAX_BYTES && WRITER_POOL.length < 8) WRITER_POOL.push(writer);
	}
}

/** An opaque, invocation-owned syntax capture, never wire bytes or authority. */
export interface CanonicalEncodingCaptureValue { readonly byteLength: number; }
export interface CanonicalEncodingCapture {
	capture(value: unknown, limits: Partial<CanonicalLimits>): CanonicalEncodingCaptureValue;
	encode(value: unknown, limits: Partial<CanonicalLimits>): Uint8Array;
	release(): void;
}

/** Shares the ORIGINAL encoder's owned child segments within one synchronous
 * multi-output invocation. No caller bytes can be enrolled as encoded data.
 * Composition requires dominating original byte/item limits and validates the
 * child's actual depth at its new position. The ordinary encoder is unchanged.
 */
export function createCanonicalEncodingCapture(): CanonicalEncodingCapture {
	let live = true, fragments = new WeakMap<object, CapturedEncoding>();
	const traverse = (value: unknown, limits: Partial<CanonicalLimits>) => {
		if (!live) throw new CanonicalEncodingError("foreign or released canonical capture");
		const configured = canonicalResourceLimits(limits), traversal: EncodingCaptureTraversal = {fragments, maxDepth: 0};
		const encoded = encodeInternal(value, new Set<object>(), 0, configured, traversal);
		// Arrays/Maps may execute caller code during the ORIGINAL traversal.
		// A reentrant release must never enroll or deliver the completed segments.
		if (!live) throw new CanonicalEncodingError("foreign or released canonical capture");
		if (encoded.byteLength > configured.maxBytes)
			throw new CanonicalEncodingError("canonical value exceeds byte limit");
		return {encoded, maxDepth: traversal.maxDepth, limits: configured};
	};
	return Object.freeze({
		capture(value: unknown, limits: Partial<CanonicalLimits>): CanonicalEncodingCaptureValue {
			const captured = traverse(value, limits), handle = new CapturedCanonicalValue(captured.encoded.byteLength);
			fragments.set(handle, captured);
			return handle;
		},
		encode(value: unknown, limits: Partial<CanonicalLimits>): Uint8Array {
			return flattenEncoded(traverse(value, limits).encoded);
		},
		release(): void { live = false; fragments = new WeakMap(); },
	});
}

/** Scalar resource bounds for an original-codec value. These describe bytes
 * and decoder work; they are neither encoded values nor authority/credits. */
export interface CanonicalResourceFootprint {
	readonly byteLength: number;
	readonly items: number;
	readonly maxDepth: number;
}

/** Limits and footprints this module froze after its exact plain-data checks.
 * Re-validating one is the identity, so internal composition skips only the
 * repeated descriptor walk; every range check against the CURRENT limits stays. */
const RESOURCE_LIMITS = new WeakSet<object>();
const RESOURCE_FOOTPRINTS = new WeakSet<object>();
const DEFAULT_RESOURCE_LIMITS: Readonly<CanonicalLimits> = Object.freeze({ ...DEFAULT_LIMITS });
RESOURCE_LIMITS.add(DEFAULT_RESOURCE_LIMITS);
/** Widths the frozen encoder already produced for an exact primitive. Encoding
 * a primitive is a pure function of it; a width above the current byte limit
 * replays the encoder for its exact refusal. Bounded; never authority. */
const PRIMITIVE_WIDTHS = new Map<null | boolean | number | string, number>();
const PRIMITIVE_WIDTH_ENTRIES = 4096, PRIMITIVE_WIDTH_MAX_STRING = 256;

/** `encodeVarUint(value).byteLength` for a non-negative safe integer. */
function varUintWidth(value: number): number {
	let count = 1;
	for (let rest = value; rest >= 0x80; rest = Math.floor(rest / 0x80)) count++;
	return count;
}

/** `fresh` marks this module's own three-field literal, whose shape holds by construction. */
function checkedCanonicalResourceFootprint(value: CanonicalResourceFootprint,
	limits: Partial<CanonicalLimits>, fresh = false): CanonicalResourceFootprint {
	const configured = canonicalResourceLimits(limits);
	const trusted = RESOURCE_FOOTPRINTS.has(value);
	let byteLength: unknown, items: unknown, maxDepth: unknown;
	if (trusted || fresh) ({ byteLength, items, maxDepth } = value);
	else {
		if (value === null || typeof value !== "object" || !isPlainObject(value) || Object.getOwnPropertySymbols(value).length !== 0)
			throw new CanonicalEncodingError("canonical resource footprint requires plain scalar fields");
		const descriptors = Object.getOwnPropertyDescriptors(value), keys = Object.keys(descriptors);
		if (keys.length !== 3 || ["byteLength", "items", "maxDepth"].some(key =>
			!Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, "value")))
			throw new CanonicalEncodingError("canonical resource footprint requires exact data fields");
		// Capture each scalar once. Accessors cannot alter the tuple between its
		// validation and return, and no input object is retained in the result.
		byteLength = descriptors.byteLength!.value;
		items = descriptors.items!.value;
		maxDepth = descriptors.maxDepth!.value;
	}
	if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > configured.maxBytes ||
		typeof items !== "number" || !Number.isSafeInteger(items) || items < 1 || items > configured.maxItems ||
		typeof maxDepth !== "number" || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > configured.maxDepth)
		throw new CanonicalEncodingError("canonical resource footprint exceeds original limits");
	// Every exported result is checked from a fresh literal, so a trusted input
	// returns only to internal composition and is never aliased to a caller.
	if (trusted) return value;
	const result = Object.freeze({ byteLength, items, maxDepth });
	RESOURCE_FOOTPRINTS.add(result);
	return result;
}

/** The frozen encoder's width for one primitive under already-checked limits. */
function primitiveResourceWidth(value: null | boolean | number | string, configured: Readonly<CanonicalLimits>): number {
	if (value !== null && typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string")
		throw new CanonicalEncodingError("resource primitive is outside the canonical domain");
	const cached = PRIMITIVE_WIDTHS.get(value);
	if (cached !== undefined && cached <= configured.maxBytes) return cached;
	const width = encodeCanonical(value, configured).byteLength;
	if (typeof value !== "string" || value.length <= PRIMITIVE_WIDTH_MAX_STRING) {
		if (PRIMITIVE_WIDTHS.size >= PRIMITIVE_WIDTH_ENTRIES) PRIMITIVE_WIDTHS.clear();
		PRIMITIVE_WIDTHS.set(value, width);
	}
	return width;
}

function canonicalResourceLimits(limits: Partial<CanonicalLimits>): Readonly<CanonicalLimits> {
	if (RESOURCE_LIMITS.has(limits)) return limits as Readonly<CanonicalLimits>;
	if (!isPlainObject(limits) || Object.getOwnPropertySymbols(limits).length !== 0)
		throw new CanonicalEncodingError("canonical resource limits require plain data fields");
	const configured: CanonicalLimits = {...DEFAULT_LIMITS};
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(limits))) {
		if (!descriptor.enumerable) continue;
		if ((key !== "maxBytes" && key !== "maxItems" && key !== "maxDepth") || !Object.hasOwn(descriptor, "value") ||
			!Number.isSafeInteger(descriptor.value) || descriptor.value < (key === "maxDepth" ? 0 : 1))
			throw new CanonicalEncodingError("canonical resource limit is invalid");
		configured[key] = descriptor.value as number;
	}
	const result = Object.freeze(configured);
	RESOURCE_LIMITS.add(result);
	return result;
}

/** Actual primitive validation remains with the frozen encoder; only the
 * widths it already produced are interned. No collection traversal or
 * hypothetical payload happens here. */
export function canonicalPrimitiveResourceForSizing(value: null | boolean | number | string,
	limits: Partial<CanonicalLimits> = DEFAULT_RESOURCE_LIMITS): CanonicalResourceFootprint {
	const configured = canonicalResourceLimits(limits);
	return checkedCanonicalResourceFootprint({byteLength: primitiveResourceWidth(value, configured),
		items: 1, maxDepth: 0}, configured, true);
}

/** BYTES contents are opaque to the original decoder, even when their payload
 * will separately be decoded or charged by another original owner. */
export function canonicalBytesResourceForSizing(payloadByteLength: number,
	limits: Partial<CanonicalLimits> = DEFAULT_RESOURCE_LIMITS): CanonicalResourceFootprint {
	const configured = canonicalResourceLimits(limits);
	if (!Number.isSafeInteger(payloadByteLength) || payloadByteLength < 0)
		throw new CanonicalEncodingError("canonical resource byte length is invalid");
	return checkedCanonicalResourceFootprint({byteLength: 1 + varUintWidth(payloadByteLength) + payloadByteLength,
		items: 1, maxDepth: 0}, configured, true);
}

/** Repeated complete ARRAY children. Every occurrence and collection edge is
 * charged; this never asserts equal-byte identity or removes actual children. */
export function canonicalArrayResourceForSizing(count: number, child: CanonicalResourceFootprint,
	limits: Partial<CanonicalLimits> = DEFAULT_RESOURCE_LIMITS): CanonicalResourceFootprint {
	const configured = canonicalResourceLimits(limits);
	if (!Number.isSafeInteger(count) || count < 0 || count > Math.floor((configured.maxItems - 1) / 2))
		throw new CanonicalEncodingError("canonical resource array count is invalid");
	const checked = checkedCanonicalResourceFootprint(child, configured);
	return checkedCanonicalResourceFootprint({byteLength: 1 + varUintWidth(count) + count * checked.byteLength,
		items: 1 + count + count * checked.items, maxDepth: count === 0 ? 0 : 1 + checked.maxDepth}, configured, true);
}

/** Heterogeneous original-schema ARRAY slots. This adds complete distinct
 * costs; it does not deduplicate identities or manufacture array values. */
export function canonicalArrayResourcesForSizing(children: readonly CanonicalResourceFootprint[],
	limits: Partial<CanonicalLimits> = DEFAULT_RESOURCE_LIMITS): CanonicalResourceFootprint {
	if (!Array.isArray(children)) throw new CanonicalEncodingError("resource children must be a dense array");
	const configured = canonicalResourceLimits(limits);
	if (children.length > Math.floor((configured.maxItems - 1) / 2))
		throw new CanonicalEncodingError("canonical resource array count exceeds original item limit");
	let byteLength = 1 + varUintWidth(children.length), items = 1 + children.length, maxDepth = 0;
	for (let index = 0; index < children.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(children, String(index));
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
			throw new CanonicalEncodingError("resource children must be a dense data array");
		const child = checkedCanonicalResourceFootprint(descriptor.value as CanonicalResourceFootprint, configured);
		byteLength += child.byteLength;
		items += child.items;
		maxDepth = Math.max(maxDepth, 1 + child.maxDepth);
	}
	return checkedCanonicalResourceFootprint({byteLength, items, maxDepth}, configured, true);
}

/** Finite original schema fields only: complete scalar child footprints or
 * actual primitives. This is shallow resource algebra, not another recursive
 * encoder. Field names/accessors use the SAME frozen encoder's validation. */
export function canonicalRecordResourceForSizing(
	fields: Readonly<Record<string, CanonicalResourceFootprint | null | boolean | number | string>>,
	limits: Partial<CanonicalLimits> = DEFAULT_RESOURCE_LIMITS): CanonicalResourceFootprint {
	if (!isPlainObject(fields) || Object.getOwnPropertySymbols(fields).length !== 0)
		throw new CanonicalEncodingError("resource schema requires canonical record fields");
	const configured = canonicalResourceLimits(limits);
	const entries = Object.entries(Object.getOwnPropertyDescriptors(fields)).filter(([, descriptor]) => descriptor.enumerable);
	if (entries.length > Math.floor((configured.maxItems - 1) / 4))
		throw new CanonicalEncodingError("canonical resource field count exceeds original item limit");
	let byteLength = 1 + varUintWidth(entries.length), items = 1 + entries.length * 2, maxDepth = 0;
	for (const [key, descriptor] of entries) {
		if (!Object.hasOwn(descriptor, "value"))
			throw new CanonicalEncodingError(`accessor property ${key} is outside the canonical domain`);
		// A primitive key or value is exactly its encoded width, one item, depth 0.
		byteLength += primitiveResourceWidth(key, configured);
		items += 1;
		const value: unknown = descriptor.value;
		if (value !== null && typeof value === "object") {
			const child = checkedCanonicalResourceFootprint(value as CanonicalResourceFootprint, configured);
			byteLength += child.byteLength;
			items += child.items;
			maxDepth = Math.max(maxDepth, 1 + child.maxDepth);
		} else {
			byteLength += primitiveResourceWidth(value as null | boolean | number | string, configured);
			items += 1;
			maxDepth = Math.max(maxDepth, 1);
		}
	}
	return checkedCanonicalResourceFootprint({byteLength, items, maxDepth}, configured, true);
}

/** Reads an owned copy of the input by offset: no per-node views or result
 * records. Validation and error precedence match the frozen reader exactly. */
class Reader {
	public items = 0;
	/** Cleared by the only decodable forms the encoder does not reproduce. */
	public exact = true;
	public offset = 0;
	public readonly view: DataView;

	public constructor(
		public readonly bytes: Uint8Array,
		public readonly limits: Readonly<CanonicalLimits>,
		/** Opt-in resource reader only; ordinary decoding retains no stats. */
		public readonly resourceStats?: {maxDepth: number}
	) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	/** Advances past `length` bytes and returns their start offset. */
	public skip(length: number): number {
		if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) {
			throw new CanonicalDecodingError("truncated canonical value");
		}
		const start = this.offset;
		this.offset += length;
		return start;
	}

	public byte(): number {
		if (this.offset >= this.bytes.byteLength) throw new CanonicalDecodingError("truncated canonical value");
		return this.bytes[this.offset++]!;
	}

	public countItems(count = 1): void {
		this.items += count;
		if (this.items > this.limits.maxItems) {
			throw new CanonicalDecodingError("canonical value exceeds item limit", "items");
		}
	}

	/** Up to four bytes (< 2^28) decode exactly as numbers; longer encodings
	 * replay from their start through the frozen BigInt algorithm. */
	public varUint(): number | bigint {
		const bytes = this.bytes;
		const start = this.offset;
		let result = 0;
		for (let count = 1, shift = 0; count <= 4; count++, shift += 7) {
			if (this.offset >= bytes.byteLength) throw new CanonicalDecodingError("truncated canonical value");
			const byte = bytes[this.offset++]!;
			result |= (byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) {
				if (count > 1 && (byte & 0x7f) === 0) throw new CanonicalDecodingError("non-minimal varuint");
				return result;
			}
		}
		this.offset = start;
		return this.varUintBig();
	}

	private varUintBig(): bigint {
		let result = BigInt(0);
		let shift = BigInt(0);
		let count = 0;
		while (true) {
			const byte = this.byte();
			count++;
			if (count > 9) throw new CanonicalDecodingError("varuint exceeds safe range");
			result |= BigInt(byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) {
				if (count > 1 && (byte & 0x7f) === 0) {
					throw new CanonicalDecodingError("non-minimal varuint");
				}
				if (result > MAX_SAFE_BIGINT * BigInt(2) + BigInt(1)) {
					throw new CanonicalDecodingError("varuint exceeds safe range");
				}
				return result;
			}
			shift += BigInt(7);
		}
	}
}

const fatalUtf8Decoder = new intrinsicTextDecoder("utf-8", { fatal: true });

/** Strict UTF-8, stripping exactly one initial BOM like the frozen decoder.
 * Fatal decoding accepts exactly the inputs whose re-encoding round-trips. */
function decodeUtf8Range(bytes: Uint8Array, start: number, end: number): string {
	if (end - start <= 32) {
		let ascii = true;
		for (let index = start; index < end; index++) {
			if (bytes[index]! >= 0x80) {
				ascii = false;
				break;
			}
		}
		if (ascii) return String.fromCharCode.apply(null, bytes.subarray(start, end) as unknown as number[]);
	}
	try {
		return fatalUtf8Decoder.decode(bytes.subarray(start, end));
	} catch {
		throw new CanonicalDecodingError("invalid UTF-8 string");
	}
}

function decodeCollection(reader: Reader, depth: number, tag: number): unknown {
	const length = Number(reader.varUint());
	const bytes = reader.bytes;
	if (tag === TAG.ARRAY) {
		reader.countItems(length);
		const values: unknown[] = [];
		for (let index = 0; index < length; index++) values.push(decodeInternal(reader, depth + 1));
		return values;
	}
	if (tag === TAG.SET) {
		reader.countItems(length);
		const values = new Set<unknown>();
		let previousStart = -1, previousEnd = -1;
		for (let index = 0; index < length; index++) {
			const start = reader.offset;
			const value = decodeInternal(reader, depth + 1);
			if (previousStart >= 0 && compareRanges(bytes, previousStart, previousEnd, start, reader.offset) >= 0) {
				throw new CanonicalDecodingError("set values are not in canonical order or are duplicated");
			}
			previousStart = start;
			previousEnd = reader.offset;
			values.add(value);
		}
		return values;
	}

	reader.countItems(length * 2);
	const object = tag === TAG.OBJECT ? Object.create(null) as Record<string, unknown> : undefined;
	const map = tag === TAG.OBJECT ? undefined : new Map<unknown, unknown>();
	let previousStart = -1, previousEnd = -1;
	for (let index = 0; index < length; index++) {
		const start = reader.offset;
		const key = decodeInternal(reader, depth + 1);
		if (previousStart >= 0 && compareRanges(bytes, previousStart, previousEnd, start, reader.offset) >= 0) {
			throw new CanonicalDecodingError("map/object keys are not in canonical order or are duplicated");
		}
		previousStart = start;
		previousEnd = reader.offset;
		const item = decodeInternal(reader, depth + 1);
		if (object !== undefined) {
			if (typeof key !== "string") throw new CanonicalDecodingError("object key must be a string");
			object[key] = item;
		} else {
			map!.set(key, item);
		}
	}
	return object ?? map;
}

function decodeTypedArray(reader: Reader, tag: number): Float32Array | Float64Array | Int32Array | Uint32Array {
	const length = Number(reader.varUint());
	reader.countItems(length);
	const width = tag === TAG.FLOAT64_ARRAY ? 8 : 4;
	const start = reader.skip(length * width);
	const view = reader.view;
	let value: Float32Array | Float64Array | Int32Array | Uint32Array;
	if (tag === TAG.FLOAT32_ARRAY) {
		value = new Float32Array(length);
		for (let index = 0; index < length; index++) value[index] = view.getFloat32(start + index * 4, false);
	} else if (tag === TAG.FLOAT64_ARRAY) {
		value = new Float64Array(length);
		for (let index = 0; index < length; index++) value[index] = view.getFloat64(start + index * 8, false);
	} else if (tag === TAG.INT32_ARRAY) {
		value = new Int32Array(length);
		for (let index = 0; index < length; index++) value[index] = view.getInt32(start + index * 4, false);
		return value;
	} else {
		value = new Uint32Array(length);
		for (let index = 0; index < length; index++) value[index] = view.getUint32(start + index * 4, false);
		return value;
	}
	for (let index = 0; index < length; index++) {
		const item = value[index]!;
		if (!Number.isFinite(item)) throw new CanonicalDecodingError("typed array contains a non-finite number");
		if (Object.is(item, -0)) {
			throw new CanonicalDecodingError("typed array contains non-canonical negative zero");
		}
	}
	return value;
}

function decodeInternal(reader: Reader, depth: number): unknown {
	if (depth > reader.limits.maxDepth) {
		throw new CanonicalDecodingError("canonical value exceeds maximum nesting depth", "depth");
	}
	const resourceStats = reader.resourceStats;
	if (resourceStats !== undefined && depth > resourceStats.maxDepth) resourceStats.maxDepth = depth;
	reader.countItems();
	const tag = reader.byte();

	switch (tag) {
		case TAG.NULL:
			return null;
		case TAG.FALSE:
			return false;
		case TAG.TRUE:
			return true;
		case TAG.INTEGER: {
			const encoded = reader.varUint();
			if (typeof encoded === "number") return (encoded & 1) === 0 ? encoded >>> 1 : -((encoded >>> 1) + 1);
			const magnitude = encoded >> BigInt(1);
			const integer = (encoded & BigInt(1)) === BigInt(0) ? magnitude : -(magnitude + BigInt(1));
			if (integer < -MAX_SAFE_BIGINT || integer > MAX_SAFE_BIGINT) {
				throw new CanonicalDecodingError("integer exceeds safe range");
			}
			return Number(integer);
		}
		case TAG.FLOAT64: {
			const start = reader.skip(8);
			const number = reader.view.getFloat64(start, false);
			if (!Number.isFinite(number)) {
				throw new CanonicalDecodingError("non-finite float is outside the canonical domain");
			}
			if (Object.is(number, -0)) throw new CanonicalDecodingError("negative zero is non-canonical");
			if (Number.isSafeInteger(number)) {
				throw new CanonicalDecodingError("integral float must use the integer tag");
			}
			// Integral floats beyond the safe range decode, but the encoder refuses them.
			if (Number.isInteger(number)) reader.exact = false;
			return number;
		}
		case TAG.STRING: {
			const length = Number(reader.varUint());
			let start: number;
			try {
				start = reader.skip(length);
			} catch (error) {
				if (error instanceof CanonicalDecodingError) throw new CanonicalDecodingError("invalid UTF-8 string");
				throw error;
			}
			// The native decoder strips one leading BOM, which re-encoding omits.
			const bytes = reader.bytes;
			if (reader.offset - start >= 3 && bytes[start] === 0xef && bytes[start + 1] === 0xbb && bytes[start + 2] === 0xbf)
				reader.exact = false;
			return decodeUtf8Range(bytes, start, reader.offset);
		}
		case TAG.BYTES: {
			const start = reader.skip(Number(reader.varUint()));
			return reader.bytes.slice(start, reader.offset);
		}
		case TAG.ARRAY:
		case TAG.OBJECT:
		case TAG.MAP:
		case TAG.SET:
			return decodeCollection(reader, depth, tag);
		case TAG.FLOAT32_ARRAY:
		case TAG.FLOAT64_ARRAY:
		case TAG.INT32_ARRAY:
		case TAG.UINT32_ARRAY:
			return decodeTypedArray(reader, tag);
		default:
			throw new CanonicalDecodingError(`unknown canonical tag 0x${tag.toString(16).padStart(2, "0")}`);
	}
}

/**
 * Decodes and validates one frozen canonical value.
 * @param input - Canonical bytes.
 * @param limits - Optional resource-limit overrides.
 * @returns The decoded canonical value.
 */
export function decodeCanonical(input: Uint8Array, limits: Partial<CanonicalLimits> = {}): unknown {
	if (callObserver !== undefined) callObserver("decode", input.byteLength);
	const bytes = new Uint8Array(input);
	const configured: CanonicalLimits = { ...DEFAULT_LIMITS, ...limits };
	if (bytes.byteLength > configured.maxBytes) {
		throw new CanonicalDecodingError("canonical value exceeds byte limit", "bytes");
	}
	const reader = new Reader(bytes, configured);
	const value = decodeInternal(reader, 0);
	if (reader.offset !== bytes.byteLength) {
		throw new CanonicalDecodingError("trailing bytes after canonical value");
	}
	return value;
}

/** Result of {@link decodeCanonicalExactness}. */
export interface CanonicalExactDecoding {
	readonly value: unknown;
	/** True only when `encodeCanonical(value)` with default limits reproduces the input byte for byte. */
	readonly exact: boolean;
}

/**
 * Decodes exactly like {@link decodeCanonical} (same limits, errors and value)
 * and reports whether re-encoding the untouched value with default limits is
 * guaranteed to reproduce the input. `false` means unknown: callers keep their
 * original re-encode-and-compare canonicality check.
 * @param input - Canonical bytes.
 * @param limits - Optional resource-limit overrides.
 * @returns The decoded value and its exactness.
 */
export function decodeCanonicalExactness(input: Uint8Array, limits: Partial<CanonicalLimits> = {}): CanonicalExactDecoding {
	if (callObserver !== undefined) callObserver("decode", input.byteLength);
	const bytes = new Uint8Array(input);
	const configured: CanonicalLimits = { ...DEFAULT_LIMITS, ...limits };
	if (bytes.byteLength > configured.maxBytes) {
		throw new CanonicalDecodingError("canonical value exceeds byte limit", "bytes");
	}
	const stats = { maxDepth: 0 };
	const reader = new Reader(bytes, configured, stats);
	const value = decodeInternal(reader, 0);
	if (reader.offset !== bytes.byteLength) {
		throw new CanonicalDecodingError("trailing bytes after canonical value");
	}
	// The encoder bounds each collection by maxItems; the decoder bounds the
	// total, so total consumption within the defaults implies encoder success.
	const exact = reader.exact && bytes.byteLength <= DEFAULT_LIMITS.maxBytes &&
		reader.items <= DEFAULT_LIMITS.maxItems && stats.maxDepth <= DEFAULT_LIMITS.maxDepth;
	return Object.freeze({ value, exact });
}

/** Actual current carrier only. The ORIGINAL decoder validates the supplied
 * schema-depth bound and counts every original node/edge. Exact depth is an
 * opt-in statistic of that SAME single traversal, not another tree walker,
 * repeated decode, cache, authority or hypothetical encoding. */
export function canonicalCarrierResourceForSizing(input: Uint8Array, maximumDepth: number,
	limits: Partial<CanonicalLimits> = {}, depthMode: "upper-bound" | "exact" = "upper-bound"): CanonicalResourceFootprint {
	const configured = canonicalResourceLimits(limits);
	if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 0 || maximumDepth > configured.maxDepth)
		throw new CanonicalEncodingError("resource schema depth is invalid");
	if (depthMode !== "upper-bound" && depthMode !== "exact")
		throw new CanonicalEncodingError("resource depth mode is invalid");
	const bytes = new Uint8Array(input);
	if (bytes.byteLength > configured.maxBytes)
		throw new CanonicalDecodingError("canonical value exceeds byte limit", "bytes");
	const resourceStats = depthMode === "exact" ? {maxDepth: 0} : undefined;
	const reader = new Reader(bytes, {...configured, maxDepth: maximumDepth}, resourceStats);
	decodeInternal(reader, 0);
	if (reader.offset !== bytes.byteLength)
		throw new CanonicalDecodingError("trailing bytes after canonical value");
	return checkedCanonicalResourceFootprint({byteLength: bytes.byteLength, items: reader.items,
		maxDepth: resourceStats?.maxDepth ?? maximumDepth}, configured, true);
}

/** Encodes only an ACTUAL current value using the original encoder, then uses
 * the original carrier-cost reader. Hypothetical slots use scalar algebra. */
export function canonicalValueResourceForSizing(value: unknown, maximumDepth: number,
	limits: Partial<CanonicalLimits> = {}, depthMode: "upper-bound" | "exact" = "upper-bound"): CanonicalResourceFootprint {
	return canonicalCarrierResourceForSizing(encodeCanonical(value, limits), maximumDepth, limits, depthMode);
}

/**
 * Clones through canonical bytes, applying canonical normalization.
 * @param value - Canonical-domain value to clone.
 * @returns A canonical round-trip clone.
 */
export function deepCloneCanonical<T>(value: T): T {
	return decodeCanonical(encodeCanonical(value)) as T;
}

const HASH_MAGIC = Uint8Array.of(0x44, 0x52, 0x50, 0x00);
/** Exact framed domain prefixes (magic, length, UTF-8 domain), never parts. */
const DOMAIN_PREFIXES = new Map<string, Uint8Array>();

function u32be(value: number): Uint8Array {
	if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
		throw new RangeError("u32 out of range");
	}
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, false);
	return bytes;
}

function u64be(value: number): Uint8Array {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError("u64 value must be a non-negative safe integer");
	}
	const bytes = new Uint8Array(8);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, Math.floor(value / 0x1_0000_0000), false);
	view.setUint32(4, value >>> 0, false);
	return bytes;
}

// Exact-input digest memo. A framed SHA-256 is a pure function of the domain and
// the exact part bytes, and storage currency checks re-hash the same immutable
// blobs, chunks and images many times per transition. A hit requires full
// byte-for-byte equality with PRIVATE copies taken at the miss: no identity,
// length or sample is trusted, and caller mutation after hashing only misses.
const HASH_MEMO_MIN_BYTES = 64;
const HASH_MEMO_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const HASH_MEMO_MAX_BYTES = 32 * 1024 * 1024;
const HASH_MEMO_MAX_ENTRIES = 32_768;
interface HashMemoEntry {
	readonly parts: readonly Uint8Array[];
	readonly digest: Uint8Array;
	readonly bytes: number;
}
const hashMemo = new Map<string, HashMemoEntry>();
let hashMemoBytes = 0;

/** Locates a candidate only; equality is always decided by `sameMemoBytes`.
 * The fingerprint covers every byte (two 32-bit lanes, word-at-a-time when
 * aligned): same-layout records differing anywhere must not share a slot. */
function hashMemoKey(domain: string, parts: readonly Uint8Array[]): string | undefined {
	let total = 0;
	let key = domain;
	let a = 0x811c9dc5;
	let b = 0x9e3779b1;
	for (const part of parts) {
		const length = part.byteLength;
		total += length;
		key += `\u0000${length}`;
		let index = 0;
		if ((part.byteOffset & 3) === 0) {
			const words = length >>> 2;
			const view = new Int32Array(part.buffer, part.byteOffset, words);
			for (let word = 0; word < words; word++) {
				const value = view[word]!;
				a = Math.imul(a ^ value, 0x01000193);
				b = Math.imul(b ^ value, 0x85ebca6b) ^ (b >>> 13);
			}
			index = words << 2;
		}
		for (; index < length; index++) {
			a = Math.imul(a ^ part[index]!, 0x01000193);
			b = Math.imul(b ^ part[index]!, 0x85ebca6b) ^ (b >>> 13);
		}
	}
	return total < HASH_MEMO_MIN_BYTES || total > HASH_MEMO_MAX_ENTRY_BYTES
		? undefined : `${key}\u0000${a >>> 0}.${b >>> 0}`;
}

function sameMemoBytes(left: Uint8Array, right: Uint8Array): boolean {
	const length = left.byteLength;
	if (length !== right.byteLength) return false;
	let index = 0;
	if ((left.byteOffset & 3) === 0 && (right.byteOffset & 3) === 0) {
		const words = length >>> 2;
		const a = new Int32Array(left.buffer, left.byteOffset, words);
		const b = new Int32Array(right.buffer, right.byteOffset, words);
		for (let word = 0; word < words; word++) if (a[word] !== b[word]) return false;
		index = words << 2;
	}
	for (; index < length; index++) if (left[index] !== right[index]) return false;
	return true;
}

function hashDomainUncached(domain: string, parts: readonly Uint8Array[]): Uint8Array {
	let prefix = DOMAIN_PREFIXES.get(domain);
	if (prefix === undefined) {
		const domainBytes = textEncoder.encode(domain);
		prefix = concat([HASH_MAGIC, u32be(domainBytes.byteLength), domainBytes]);
		if (DOMAIN_PREFIXES.size >= 1024) DOMAIN_PREFIXES.clear();
		DOMAIN_PREFIXES.set(domain, prefix);
	}
	// Identical framed bytes, streamed: no whole-message concatenation copy.
	const hasher = sha256.create().update(prefix);
	for (const part of parts) hasher.update(u64be(part.byteLength)).update(part);
	return hasher.digest();
}

/**
 * Hashes exact parts using the registry-pinned DRP framing and synchronous SHA-256.
 * @param domain - Registered hash domain.
 * @param parts - Ordered byte parts to frame.
 * @returns The SHA-256 digest.
 */
export function hashDomain(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
	if (typeof domain !== "string" || !parts.every(plainMemoView)) {
		// Exotic or instrumented carriers keep the frozen framing algorithm verbatim.
		const domainBytes = textEncoder.encode(domain);
		const framed: Uint8Array[] = [HASH_MAGIC, u32be(domainBytes.byteLength), domainBytes];
		for (const part of parts) framed.push(u64be(part.byteLength), part);
		return sha256(concat(framed));
	}
	const key = hashMemoKey(domain, parts);
	if (key === undefined) return hashDomainUncached(domain, parts);
	const known = hashMemo.get(key);
	if (known !== undefined && known.parts.every((part, index) => sameMemoBytes(part, parts[index]!))) {
		hashMemo.delete(key);
		hashMemo.set(key, known);
		return known.digest.slice();
	}
	const digest = hashDomainUncached(domain, parts);
	if (known !== undefined) {
		hashMemo.delete(key);
		hashMemoBytes -= known.bytes;
	}
	const copies = parts.map((part) => part.slice());
	const bytes = copies.reduce((sum, part) => sum + part.byteLength, 0);
	hashMemo.set(key, Object.freeze({ parts: Object.freeze(copies), digest: digest.slice(), bytes }));
	hashMemoBytes += bytes;
	for (const [oldest, entry] of hashMemo) {
		if (hashMemoBytes <= HASH_MEMO_MAX_BYTES && hashMemo.size <= HASH_MEMO_MAX_ENTRIES) break;
		hashMemo.delete(oldest);
		hashMemoBytes -= entry.bytes;
	}
	return digest;
}
