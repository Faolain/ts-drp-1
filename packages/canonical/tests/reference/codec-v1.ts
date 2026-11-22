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
	for (let index = 0; index < length; index++) {
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

function decodeUtf8String(bytes: Uint8Array): string {
	const decoder = new intrinsicTextDecoder("utf-8");
	// Native default decoding strips exactly one initial payload BOM.
	let matched = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
	const comparePiece = (piece: string): void => {
		const encoded = textEncoder.encode(piece);
		if (encoded.byteLength > bytes.byteLength - matched) {
			throw new CanonicalDecodingError("invalid UTF-8 string");
		}
		for (let index = 0; index < encoded.byteLength; index++) {
			if (encoded[index] !== bytes[matched + index]) {
				throw new CanonicalDecodingError("invalid UTF-8 string");
			}
		}
		matched += encoded.byteLength;
	};
	for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
		comparePiece(decoder.decode(bytes.subarray(offset, offset + 4096), { stream: true }));
	}
	comparePiece(decoder.decode());
	if (matched !== bytes.byteLength) throw new CanonicalDecodingError("invalid UTF-8 string");
	// Flush reset the decoder; only now produce the accepted whole string.
	return decoder.decode(bytes);
}

function encodeVarUint(input: number | bigint): Uint8Array {
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
			return encodedParts([Uint8Array.of(TAG.INTEGER), encodeVarUint(zigZagEncode(normalized))]);
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

/**
 * Encodes a value with the frozen reference tag codec.
 * @param value - Value in the canonical data domain.
 * @param limits - Optional resource-limit overrides.
 * @returns Canonical bytes.
 */
export function encodeCanonical(value: unknown, limits: Partial<CanonicalLimits> = {}): Uint8Array {
	const configured: CanonicalLimits = { ...DEFAULT_LIMITS, ...limits };
	const bytes = flattenEncoded(encodeInternal(value, new Set<object>(), 0, configured));
	if (bytes.byteLength > configured.maxBytes) {
		throw new CanonicalEncodingError("canonical value exceeds byte limit");
	}
	return bytes;
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

function checkedCanonicalResourceFootprint(value: CanonicalResourceFootprint,
	limits: Partial<CanonicalLimits>): CanonicalResourceFootprint {
	const configured = canonicalResourceLimits(limits);
	if (value === null || typeof value !== "object" || !isPlainObject(value) || Object.getOwnPropertySymbols(value).length !== 0)
		throw new CanonicalEncodingError("canonical resource footprint requires plain scalar fields");
	const descriptors = Object.getOwnPropertyDescriptors(value), keys = Object.keys(descriptors);
	if (keys.length !== 3 || ["byteLength", "items", "maxDepth"].some(key =>
		!Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, "value")))
		throw new CanonicalEncodingError("canonical resource footprint requires exact data fields");
	// Capture each scalar once. Accessors cannot alter the tuple between its
	// validation and return, and no input object is retained in the result.
	const byteLength = descriptors.byteLength!.value, items = descriptors.items!.value,
		maxDepth = descriptors.maxDepth!.value;
	if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > configured.maxBytes ||
		typeof items !== "number" || !Number.isSafeInteger(items) || items < 1 || items > configured.maxItems ||
		typeof maxDepth !== "number" || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > configured.maxDepth)
		throw new CanonicalEncodingError("canonical resource footprint exceeds original limits");
	return Object.freeze({byteLength, items, maxDepth});
}

function canonicalResourceLimits(limits: Partial<CanonicalLimits>): Readonly<CanonicalLimits> {
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
	return Object.freeze(configured);
}

/** Actual primitive validation remains with the frozen encoder. No collection
 * traversal, hypothetical payload or scalar-width interning happens here. */
export function canonicalPrimitiveResourceForSizing(value: null | boolean | number | string,
	limits: Partial<CanonicalLimits> = {}): CanonicalResourceFootprint {
	const configured = canonicalResourceLimits(limits);
	if (value !== null && typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string")
		throw new CanonicalEncodingError("resource primitive is outside the canonical domain");
	return checkedCanonicalResourceFootprint({byteLength: encodeCanonical(value, configured).byteLength,
		items: 1, maxDepth: 0}, configured);
}

/** BYTES contents are opaque to the original decoder, even when their payload
 * will separately be decoded or charged by another original owner. */
export function canonicalBytesResourceForSizing(payloadByteLength: number,
	limits: Partial<CanonicalLimits> = {}): CanonicalResourceFootprint {
	const configured = canonicalResourceLimits(limits);
	if (!Number.isSafeInteger(payloadByteLength) || payloadByteLength < 0)
		throw new CanonicalEncodingError("canonical resource byte length is invalid");
	return checkedCanonicalResourceFootprint({byteLength: 1 + encodeVarUint(payloadByteLength).byteLength + payloadByteLength,
		items: 1, maxDepth: 0}, configured);
}

/** Repeated complete ARRAY children. Every occurrence and collection edge is
 * charged; this never asserts equal-byte identity or removes actual children. */
export function canonicalArrayResourceForSizing(count: number, child: CanonicalResourceFootprint,
	limits: Partial<CanonicalLimits> = {}): CanonicalResourceFootprint {
	const configured = canonicalResourceLimits(limits);
	if (!Number.isSafeInteger(count) || count < 0 || count > Math.floor((configured.maxItems - 1) / 2))
		throw new CanonicalEncodingError("canonical resource array count is invalid");
	const checked = checkedCanonicalResourceFootprint(child, configured);
	return checkedCanonicalResourceFootprint({byteLength: 1 + encodeVarUint(count).byteLength + count * checked.byteLength,
		items: 1 + count + count * checked.items, maxDepth: count === 0 ? 0 : 1 + checked.maxDepth}, configured);
}

/** Heterogeneous original-schema ARRAY slots. This adds complete distinct
 * costs; it does not deduplicate identities or manufacture array values. */
export function canonicalArrayResourcesForSizing(children: readonly CanonicalResourceFootprint[],
	limits: Partial<CanonicalLimits> = {}): CanonicalResourceFootprint {
	if (!Array.isArray(children)) throw new CanonicalEncodingError("resource children must be a dense array");
	const configured = canonicalResourceLimits(limits);
	if (children.length > Math.floor((configured.maxItems - 1) / 2))
		throw new CanonicalEncodingError("canonical resource array count exceeds original item limit");
	let byteLength = 1 + encodeVarUint(children.length).byteLength, items = 1 + children.length, maxDepth = 0;
	for (let index = 0; index < children.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(children, String(index));
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
			throw new CanonicalEncodingError("resource children must be a dense data array");
		const child = checkedCanonicalResourceFootprint(descriptor.value as CanonicalResourceFootprint, configured);
		byteLength += child.byteLength;
		items += child.items;
		maxDepth = Math.max(maxDepth, 1 + child.maxDepth);
	}
	return checkedCanonicalResourceFootprint({byteLength, items, maxDepth}, configured);
}

/** Finite original schema fields only: complete scalar child footprints or
 * actual primitives. This is shallow resource algebra, not another recursive
 * encoder. Field names/accessors use the SAME frozen encoder's validation. */
export function canonicalRecordResourceForSizing(
	fields: Readonly<Record<string, CanonicalResourceFootprint | null | boolean | number | string>>,
	limits: Partial<CanonicalLimits> = {}): CanonicalResourceFootprint {
	if (!isPlainObject(fields) || Object.getOwnPropertySymbols(fields).length !== 0)
		throw new CanonicalEncodingError("resource schema requires canonical record fields");
	const configured = canonicalResourceLimits(limits);
	const entries = Object.entries(Object.getOwnPropertyDescriptors(fields)).filter(([, descriptor]) => descriptor.enumerable);
	if (entries.length > Math.floor((configured.maxItems - 1) / 4))
		throw new CanonicalEncodingError("canonical resource field count exceeds original item limit");
	let byteLength = 1 + encodeVarUint(entries.length).byteLength, items = 1 + entries.length * 2, maxDepth = 0;
	for (const [key, descriptor] of entries) {
		if (!Object.hasOwn(descriptor, "value"))
			throw new CanonicalEncodingError(`accessor property ${key} is outside the canonical domain`);
		const keyCost = canonicalPrimitiveResourceForSizing(key, configured), value = descriptor.value;
		const child = value !== null && typeof value === "object"
			? checkedCanonicalResourceFootprint(value as CanonicalResourceFootprint, configured)
			: canonicalPrimitiveResourceForSizing(value as null | boolean | number | string, configured);
		byteLength += keyCost.byteLength + child.byteLength;
		items += keyCost.items + child.items;
		maxDepth = Math.max(maxDepth, 1 + child.maxDepth);
	}
	return checkedCanonicalResourceFootprint({byteLength, items, maxDepth}, configured);
}

class Reader {
	public items = 0;
	public offset = 0;

	public constructor(
		public readonly bytes: Uint8Array,
		public readonly limits: Readonly<CanonicalLimits>,
		/** Opt-in resource reader only; ordinary decoding retains no stats. */
		public readonly resourceStats?: {maxDepth: number}
	) {}

	public take(length: number): Uint8Array {
		if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) {
			throw new CanonicalDecodingError("truncated canonical value");
		}
		const output = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return output;
	}

	public byte(): number {
		return this.take(1)[0] as number;
	}

	public countItems(count = 1): void {
		this.items += count;
		if (this.items > this.limits.maxItems) {
			throw new CanonicalDecodingError("canonical value exceeds item limit", "items");
		}
	}

	public varUint(): bigint {
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

interface Decoded {
	bytes: Uint8Array;
	value: unknown;
}

function decodeCollection(reader: Reader, depth: number, tag: number): unknown {
	const length = Number(reader.varUint());
	if (tag === TAG.ARRAY) {
		reader.countItems(length);
		const values: unknown[] = [];
		for (let index = 0; index < length; index++) values.push(decodeInternal(reader, depth + 1).value);
		return values;
	}
	if (tag === TAG.SET) {
		reader.countItems(length);
		const values = new Set<unknown>();
		let previousBytes: Uint8Array | undefined;
		for (let index = 0; index < length; index++) {
			const decoded = decodeInternal(reader, depth + 1);
			if (previousBytes !== undefined && compareBytes(previousBytes, decoded.bytes) >= 0) {
				throw new CanonicalDecodingError("set values are not in canonical order or are duplicated");
			}
			previousBytes = decoded.bytes;
			values.add(decoded.value);
		}
		return values;
	}

	reader.countItems(length * 2);
	const object = Object.create(null) as Record<string, unknown>;
	const map = new Map<unknown, unknown>();
	let previousKeyBytes: Uint8Array | undefined;
	for (let index = 0; index < length; index++) {
		const key = decodeInternal(reader, depth + 1);
		if (previousKeyBytes !== undefined && compareBytes(previousKeyBytes, key.bytes) >= 0) {
			throw new CanonicalDecodingError("map/object keys are not in canonical order or are duplicated");
		}
		previousKeyBytes = key.bytes;
		const item = decodeInternal(reader, depth + 1).value;
		if (tag === TAG.OBJECT) {
			if (typeof key.value !== "string") throw new CanonicalDecodingError("object key must be a string");
			object[key.value] = item;
		} else {
			map.set(key.value, item);
		}
	}
	return tag === TAG.OBJECT ? object : map;
}

function decodeTypedArray(reader: Reader, tag: number): Float32Array | Float64Array | Int32Array | Uint32Array {
	const length = Number(reader.varUint());
	reader.countItems(length);
	const width = tag === TAG.FLOAT64_ARRAY ? 8 : 4;
	const bytes = reader.take(length * width);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let value: Float32Array | Float64Array | Int32Array | Uint32Array;
	if (tag === TAG.FLOAT32_ARRAY) {
		value = Float32Array.from({ length }, (_item, index) => view.getFloat32(index * 4, false));
	} else if (tag === TAG.FLOAT64_ARRAY) {
		value = Float64Array.from({ length }, (_item, index) => view.getFloat64(index * 8, false));
	} else if (tag === TAG.INT32_ARRAY) {
		value = Int32Array.from({ length }, (_item, index) => view.getInt32(index * 4, false));
	} else {
		value = Uint32Array.from({ length }, (_item, index) => view.getUint32(index * 4, false));
	}
	for (const item of value) {
		if (!Number.isFinite(item)) throw new CanonicalDecodingError("typed array contains a non-finite number");
		if (Object.is(item, -0)) {
			throw new CanonicalDecodingError("typed array contains non-canonical negative zero");
		}
	}
	return value;
}

function decodeInternal(reader: Reader, depth: number): Decoded {
	if (depth > reader.limits.maxDepth) {
		throw new CanonicalDecodingError("canonical value exceeds maximum nesting depth", "depth");
	}
	const resourceStats = reader.resourceStats;
	if (resourceStats !== undefined && depth > resourceStats.maxDepth) resourceStats.maxDepth = depth;
	reader.countItems();
	const start = reader.offset;
	const tag = reader.byte();
	let value: unknown;

	switch (tag) {
		case TAG.NULL:
			value = null;
			break;
		case TAG.FALSE:
			value = false;
			break;
		case TAG.TRUE:
			value = true;
			break;
		case TAG.INTEGER: {
			const encoded = reader.varUint();
			const magnitude = encoded >> BigInt(1);
			const integer = (encoded & BigInt(1)) === BigInt(0) ? magnitude : -(magnitude + BigInt(1));
			if (integer < -MAX_SAFE_BIGINT || integer > MAX_SAFE_BIGINT) {
				throw new CanonicalDecodingError("integer exceeds safe range");
			}
			value = Number(integer);
			break;
		}
		case TAG.FLOAT64: {
			const bytes = reader.take(8);
			const number = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, false);
			if (!Number.isFinite(number)) {
				throw new CanonicalDecodingError("non-finite float is outside the canonical domain");
			}
			if (Object.is(number, -0)) throw new CanonicalDecodingError("negative zero is non-canonical");
			if (Number.isSafeInteger(number)) {
				throw new CanonicalDecodingError("integral float must use the integer tag");
			}
			value = number;
			break;
		}
		case TAG.STRING: {
			const length = Number(reader.varUint());
			let bytes: Uint8Array;
			try {
				bytes = reader.take(length);
			} catch (error) {
				if (error instanceof CanonicalDecodingError) throw new CanonicalDecodingError("invalid UTF-8 string");
				throw error;
			}
			const decodedString = decodeUtf8String(bytes);
			assertWellFormedString(decodedString);
			value = decodedString;
			break;
		}
		case TAG.BYTES:
			value = new Uint8Array(reader.take(Number(reader.varUint())));
			break;
		case TAG.ARRAY:
		case TAG.OBJECT:
		case TAG.MAP:
		case TAG.SET:
			value = decodeCollection(reader, depth, tag);
			break;
		case TAG.FLOAT32_ARRAY:
		case TAG.FLOAT64_ARRAY:
		case TAG.INT32_ARRAY:
		case TAG.UINT32_ARRAY:
			value = decodeTypedArray(reader, tag);
			break;
		default:
			throw new CanonicalDecodingError(`unknown canonical tag 0x${tag.toString(16).padStart(2, "0")}`);
	}
	return { value, bytes: reader.bytes.subarray(start, reader.offset) };
}

/**
 * Decodes and validates one frozen canonical value.
 * @param input - Canonical bytes.
 * @param limits - Optional resource-limit overrides.
 * @returns The decoded canonical value.
 */
export function decodeCanonical(input: Uint8Array, limits: Partial<CanonicalLimits> = {}): unknown {
	const bytes = new Uint8Array(input);
	const configured: CanonicalLimits = { ...DEFAULT_LIMITS, ...limits };
	if (bytes.byteLength > configured.maxBytes) {
		throw new CanonicalDecodingError("canonical value exceeds byte limit", "bytes");
	}
	const reader = new Reader(bytes, configured);
	const value = decodeInternal(reader, 0).value;
	if (reader.offset !== bytes.byteLength) {
		throw new CanonicalDecodingError("trailing bytes after canonical value");
	}
	return value;
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
		maxDepth: resourceStats?.maxDepth ?? maximumDepth}, configured);
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
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
	return bytes;
}

/**
 * Hashes exact parts using the registry-pinned DRP framing and synchronous SHA-256.
 * @param domain - Registered hash domain.
 * @param parts - Ordered byte parts to frame.
 * @returns The SHA-256 digest.
 */
export function hashDomain(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
	const domainBytes = textEncoder.encode(domain);
	const framed: Uint8Array[] = [HASH_MAGIC, u32be(domainBytes.byteLength), domainBytes];
	for (const part of parts) framed.push(u64be(part.byteLength), part);
	return sha256(concat(framed));
}
