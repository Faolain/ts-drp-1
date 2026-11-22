/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc */

import { compareByteSequences, joinBytes, sameBytes } from "./bytes.js";

const tags = Object.freeze({
	nullValue: 0x00,
	falseValue: 0x01,
	trueValue: 0x02,
	integer: 0x03,
	float64: 0x04,
	string: 0x05,
	bytes: 0x06,
	array: 0x07,
	object: 0x08,
	map: 0x09,
	set: 0x0a,
	float32Array: 0x0b,
	float64Array: 0x0c,
	int32Array: 0x0d,
	uint32Array: 0x0e,
});

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const largestSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
const standardLimits = Object.freeze({
	maxBytes: 256 * 1024 * 1024,
	maxDepth: 128,
	maxItems: 1_000_000,
});

export class CanonicalEncodingError extends TypeError {}
export class CanonicalDecodingError extends TypeError {}

function assertScalarString(value, ErrorClass) {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const second = value.charCodeAt(index + 1);
			if (second < 0xdc00 || second > 0xdfff) {
				throw new ErrorClass("unpaired UTF-16 surrogate");
			}
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			throw new ErrorClass("unpaired UTF-16 surrogate");
		}
	}
}

function varUint(value) {
	let remainder = BigInt(value);
	if (remainder < 0n) throw new CanonicalEncodingError("negative unsigned integer");
	const result = [];
	do {
		let octet = Number(remainder & 0x7fn);
		remainder >>= 7n;
		if (remainder !== 0n) octet |= 0x80;
		result.push(octet);
	} while (remainder !== 0n);
	return Uint8Array.from(result);
}

function zigZag(value) {
	const integer = BigInt(value);
	return integer < 0n ? (-integer << 1n) - 1n : integer << 1n;
}

function taggedPayload(tag, payload) {
	return joinBytes([Uint8Array.of(tag), ...payload]);
}

function floatingBytes(width, values, write) {
	const bytes = new Uint8Array(width * values.length);
	const view = new DataView(bytes.buffer);
	for (let index = 0; index < values.length; index += 1) {
		const item = values[index];
		if (!Number.isFinite(item)) throw new CanonicalEncodingError("non-finite typed-array item");
		write(view, index * width, Object.is(item, -0) ? 0 : item);
	}
	return bytes;
}

function isRecord(value) {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function encodeNode(value, ancestors, depth, limits) {
	if (depth > limits.maxDepth) throw new CanonicalEncodingError("nesting limit exceeded");
	if (value === null) return Uint8Array.of(tags.nullValue);
	if (value === false) return Uint8Array.of(tags.falseValue);
	if (value === true) return Uint8Array.of(tags.trueValue);

	if (typeof value === "string") {
		assertScalarString(value, CanonicalEncodingError);
		const encoded = utf8Encoder.encode(value);
		return taggedPayload(tags.string, [varUint(encoded.byteLength), encoded]);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new CanonicalEncodingError("non-finite number");
		const normalized = Object.is(value, -0) ? 0 : value;
		if (Number.isInteger(normalized)) {
			if (!Number.isSafeInteger(normalized)) throw new CanonicalEncodingError("unsafe integer");
			return taggedPayload(tags.integer, [varUint(zigZag(normalized))]);
		}
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setFloat64(0, normalized, false);
		return taggedPayload(tags.float64, [bytes]);
	}
	if (typeof value !== "object") {
		throw new CanonicalEncodingError(`${typeof value} is not canonical`);
	}
	if (ancestors.has(value)) throw new CanonicalEncodingError("cycle in canonical value");
	ancestors.add(value);

	try {
		if (value instanceof Uint8Array) {
			return taggedPayload(tags.bytes, [varUint(value.byteLength), new Uint8Array(value)]);
		}
		if (value instanceof Float32Array) {
			const payload = floatingBytes(4, value, (view, offset, item) => view.setFloat32(offset, item, false));
			return taggedPayload(tags.float32Array, [varUint(value.length), payload]);
		}
		if (value instanceof Float64Array) {
			const payload = floatingBytes(8, value, (view, offset, item) => view.setFloat64(offset, item, false));
			return taggedPayload(tags.float64Array, [varUint(value.length), payload]);
		}
		if (value instanceof Int32Array) {
			const payload = new Uint8Array(value.length * 4);
			const view = new DataView(payload.buffer);
			value.forEach((item, index) => view.setInt32(index * 4, item, false));
			return taggedPayload(tags.int32Array, [varUint(value.length), payload]);
		}
		if (value instanceof Uint32Array) {
			const payload = new Uint8Array(value.length * 4);
			const view = new DataView(payload.buffer);
			value.forEach((item, index) => view.setUint32(index * 4, item, false));
			return taggedPayload(tags.uint32Array, [varUint(value.length), payload]);
		}
		if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
			throw new CanonicalEncodingError("unsupported binary view");
		}
		if (Array.isArray(value)) {
			if (value.length > limits.maxItems) throw new CanonicalEncodingError("item limit exceeded");
			const items = [];
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.hasOwn(value, index)) throw new CanonicalEncodingError("sparse array");
				items.push(encodeNode(value[index], ancestors, depth + 1, limits));
			}
			return taggedPayload(tags.array, [varUint(items.length), ...items]);
		}
		if (value instanceof Map) {
			if (value.size > limits.maxItems) throw new CanonicalEncodingError("item limit exceeded");
			const entries = [...value].map(([key, item]) => ({
				key: encodeNode(key, ancestors, depth + 1, limits),
				item: encodeNode(item, ancestors, depth + 1, limits),
			}));
			entries.sort((left, right) => compareByteSequences(left.key, right.key));
			for (let index = 1; index < entries.length; index += 1) {
				if (sameBytes(entries[index - 1].key, entries[index].key)) {
					throw new CanonicalEncodingError("duplicate canonical map key");
				}
			}
			return taggedPayload(tags.map, [varUint(entries.length), ...entries.flatMap((entry) => [entry.key, entry.item])]);
		}
		if (value instanceof Set) {
			if (value.size > limits.maxItems) throw new CanonicalEncodingError("item limit exceeded");
			const items = [...value].map((item) => encodeNode(item, ancestors, depth + 1, limits));
			items.sort(compareByteSequences);
			for (let index = 1; index < items.length; index += 1) {
				if (sameBytes(items[index - 1], items[index])) {
					throw new CanonicalEncodingError("duplicate canonical set item");
				}
			}
			return taggedPayload(tags.set, [varUint(items.length), ...items]);
		}
		if (!isRecord(value)) throw new CanonicalEncodingError("non-plain object");
		if (Object.getOwnPropertySymbols(value).length !== 0) {
			throw new CanonicalEncodingError("symbol-keyed object");
		}

		const entries = [];
		for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (!descriptor.enumerable) continue;
			if (!Object.hasOwn(descriptor, "value")) throw new CanonicalEncodingError("accessor property");
			assertScalarString(name, CanonicalEncodingError);
			entries.push({
				key: encodeNode(name, ancestors, depth + 1, limits),
				item: encodeNode(descriptor.value, ancestors, depth + 1, limits),
			});
		}
		entries.sort((left, right) => compareByteSequences(left.key, right.key));
		return taggedPayload(tags.object, [
			varUint(entries.length),
			...entries.flatMap((entry) => [entry.key, entry.item]),
		]);
	} finally {
		ancestors.delete(value);
	}
}

export function encodeCanonical(value, limits = {}) {
	const policy = { ...standardLimits, ...limits };
	const result = encodeNode(value, new Set(), 0, policy);
	if (result.byteLength > policy.maxBytes) throw new CanonicalEncodingError("byte limit exceeded");
	return result;
}

class Cursor {
	constructor(bytes, limits) {
		this.bytes = bytes;
		this.index = 0;
		this.items = 0;
		this.limits = limits;
	}

	read(length) {
		if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.byteLength - this.index) {
			throw new CanonicalDecodingError("truncated canonical input");
		}
		const slice = this.bytes.subarray(this.index, this.index + length);
		this.index += length;
		return slice;
	}

	octet() {
		return this.read(1)[0];
	}

	addItems(count = 1) {
		this.items += count;
		if (this.items > this.limits.maxItems) throw new CanonicalDecodingError("item limit exceeded");
	}

	unsigned() {
		let result = 0n;
		let shift = 0n;
		for (let length = 1; length <= 9; length += 1) {
			const octet = this.octet();
			result |= BigInt(octet & 0x7f) << shift;
			if ((octet & 0x80) === 0) {
				if (length > 1 && (octet & 0x7f) === 0) {
					throw new CanonicalDecodingError("non-minimal unsigned integer");
				}
				if (result > largestSafeInteger * 2n + 1n) {
					throw new CanonicalDecodingError("unsigned integer exceeds safe range");
				}
				return result;
			}
			shift += 7n;
		}
		throw new CanonicalDecodingError("unsigned integer exceeds safe range");
	}

	length() {
		const result = this.unsigned();
		if (result > largestSafeInteger) throw new CanonicalDecodingError("length exceeds safe range");
		return Number(result);
	}
}

function decodeNode(cursor, depth) {
	if (depth > cursor.limits.maxDepth) throw new CanonicalDecodingError("nesting limit exceeded");
	cursor.addItems();
	const tag = cursor.octet();
	if (tag === tags.nullValue) return null;
	if (tag === tags.falseValue) return false;
	if (tag === tags.trueValue) return true;
	if (tag === tags.integer) {
		const encoded = cursor.unsigned();
		const magnitude = encoded >> 1n;
		const value = (encoded & 1n) === 0n ? magnitude : -magnitude - 1n;
		if (value < -largestSafeInteger || value > largestSafeInteger) {
			throw new CanonicalDecodingError("integer exceeds safe range");
		}
		return Number(value);
	}
	if (tag === tags.float64) {
		const bytes = cursor.read(8);
		const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, false);
		if (!Number.isFinite(value)) throw new CanonicalDecodingError("non-finite number");
		return value;
	}
	if (tag === tags.string) {
		try {
			const value = utf8Decoder.decode(cursor.read(cursor.length()));
			assertScalarString(value, CanonicalDecodingError);
			return value;
		} catch (error) {
			if (error instanceof CanonicalDecodingError) throw error;
			throw new CanonicalDecodingError("invalid UTF-8");
		}
	}
	if (tag === tags.bytes) return new Uint8Array(cursor.read(cursor.length()));
	if (tag === tags.array) {
		const length = cursor.length();
		cursor.addItems(length);
		return Array.from({ length }, () => decodeNode(cursor, depth + 1));
	}
	if (tag === tags.object || tag === tags.map) {
		const length = cursor.length();
		cursor.addItems(length * 2);
		const value = tag === tags.object ? Object.create(null) : new Map();
		for (let index = 0; index < length; index += 1) {
			const key = decodeNode(cursor, depth + 1);
			const item = decodeNode(cursor, depth + 1);
			if (tag === tags.object) {
				if (typeof key !== "string") throw new CanonicalDecodingError("non-string object key");
				value[key] = item;
			} else {
				value.set(key, item);
			}
		}
		return value;
	}
	if (tag === tags.set) {
		const length = cursor.length();
		cursor.addItems(length);
		return new Set(Array.from({ length }, () => decodeNode(cursor, depth + 1)));
	}
	if (tag === tags.float32Array || tag === tags.float64Array || tag === tags.int32Array || tag === tags.uint32Array) {
		const length = cursor.length();
		cursor.addItems(length);
		const width = tag === tags.float64Array ? 8 : 4;
		const bytes = cursor.read(length * width);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (tag === tags.float32Array) {
			return Float32Array.from({ length }, (_, index) => view.getFloat32(index * 4, false));
		}
		if (tag === tags.float64Array) {
			return Float64Array.from({ length }, (_, index) => view.getFloat64(index * 8, false));
		}
		if (tag === tags.int32Array) {
			return Int32Array.from({ length }, (_, index) => view.getInt32(index * 4, false));
		}
		return Uint32Array.from({ length }, (_, index) => view.getUint32(index * 4, false));
	}
	throw new CanonicalDecodingError(`unknown tag ${tag}`);
}

export function decodeCanonical(input, limits = {}) {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	const policy = { ...standardLimits, ...limits };
	if (bytes.byteLength > policy.maxBytes) throw new CanonicalDecodingError("byte limit exceeded");
	const cursor = new Cursor(bytes, policy);
	const value = decodeNode(cursor, 0);
	if (cursor.index !== bytes.byteLength) throw new CanonicalDecodingError("trailing input");
	let canonical;
	try {
		canonical = encodeCanonical(value, policy);
	} catch {
		throw new CanonicalDecodingError("decoded value is outside the canonical domain");
	}
	if (!sameBytes(canonical, bytes)) throw new CanonicalDecodingError("non-canonical representation");
	return value;
}
