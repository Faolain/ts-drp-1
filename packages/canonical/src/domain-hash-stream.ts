import { sha256 } from "@noble/hashes/sha2";

const HASH_MAGIC = Uint8Array.of(0x44, 0x52, 0x50, 0x00);
const intrinsicArrayBuffer = ArrayBuffer;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicReflectApply = Reflect.apply;
const intrinsicUint8Array = Uint8Array;
const intrinsicUint8ArrayPrototype = Uint8Array.prototype;
const intrinsicArrayBufferByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBuffer.prototype,
	"byteLength"
)?.get as (this: ArrayBuffer) => number;
const intrinsicArrayBufferResizableGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBuffer.prototype,
	"resizable"
)?.get as ((this: ArrayBuffer) => boolean) | undefined;
const intrinsicTypedArrayPrototype = intrinsicObjectGetPrototypeOf(intrinsicUint8ArrayPrototype);
const intrinsicTypedArrayBufferGetter = intrinsicObjectGetOwnPropertyDescriptor(intrinsicTypedArrayPrototype, "buffer")
	?.get as (this: Uint8Array) => ArrayBufferLike;
const intrinsicTypedArrayByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicTypedArrayPrototype,
	"byteLength"
)?.get as (this: Uint8Array) => number;
const intrinsicTypedArrayByteOffsetGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicTypedArrayPrototype,
	"byteOffset"
)?.get as (this: Uint8Array) => number;
const textEncoder = new TextEncoder();

function intrinsicView(input: Uint8Array): Uint8Array {
	try {
		if (intrinsicObjectGetPrototypeOf(input) !== intrinsicUint8ArrayPrototype) {
			throw new TypeError("domain hash update must be a genuine Uint8Array");
		}
		const byteLength = intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, input, []);
		const byteOffset = intrinsicReflectApply(intrinsicTypedArrayByteOffsetGetter, input, []);
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, input, []);
		if (intrinsicObjectGetPrototypeOf(buffer) !== intrinsicArrayBuffer.prototype) {
			throw new TypeError("domain hash update must be unshared");
		}
		intrinsicReflectApply(intrinsicArrayBufferByteLengthGetter, buffer, []);
		if (
			intrinsicArrayBufferResizableGetter !== undefined &&
			intrinsicReflectApply(intrinsicArrayBufferResizableGetter, buffer, [])
		) {
			throw new TypeError("domain hash update must be non-resizable");
		}
		return new intrinsicUint8Array(buffer, byteOffset, byteLength);
	} catch (error) {
		if (error instanceof TypeError && error.message.startsWith("domain hash update")) throw error;
		throw new TypeError("domain hash update is unreadable", { cause: error });
	}
}

function u32be(value: number): Uint8Array {
	if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
		throw new RangeError("u32 value must be a non-negative 32-bit integer");
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

export interface DomainHashStream {
	digest(): Uint8Array;
	update(bytes: Uint8Array): void;
}

/**
 * Creates the one-part incremental equivalent of `hashDomain(domain, exactBytes)`.
 * The exact part length is framed up front, so underflow and overflow fail closed.
 */
export function createDomainHashStream(domain: string, exactPartByteLength: number): DomainHashStream {
	if (typeof domain !== "string") throw new TypeError("domain must be a string");
	if (!Number.isSafeInteger(exactPartByteLength) || exactPartByteLength < 0) {
		throw new RangeError("exactPartByteLength must be a non-negative safe integer");
	}
	const domainBytes = textEncoder.encode(domain);
	const hasher = sha256
		.create()
		.update(HASH_MAGIC)
		.update(u32be(domainBytes.byteLength))
		.update(domainBytes)
		.update(u64be(exactPartByteLength));
	let updatedByteLength = 0;
	let terminal = false;

	return Object.freeze({
		digest(): Uint8Array {
			if (terminal) throw new RangeError("domain hash stream is already terminal");
			if (updatedByteLength !== exactPartByteLength) {
				throw new RangeError("domain hash stream did not receive the exact part byte length");
			}
			terminal = true;
			return new intrinsicUint8Array(hasher.digest());
		},
		update(bytes: Uint8Array): void {
			if (terminal) throw new RangeError("domain hash stream is already terminal");
			const view = intrinsicView(bytes);
			if (view.byteLength > exactPartByteLength - updatedByteLength) {
				throw new RangeError("domain hash stream exceeds the exact part byte length");
			}
			hasher.update(view);
			updatedByteLength += view.byteLength;
		},
	});
}
