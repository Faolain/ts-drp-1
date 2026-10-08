const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicReflectApply = Reflect.apply;
const intrinsicUint8Array = Uint8Array;
const intrinsicUint8ArrayPrototype = Uint8Array.prototype;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;
const intrinsicArrayBufferPrototype = ArrayBuffer.prototype;
const intrinsicArrayBufferByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBufferPrototype,
	"byteLength"
)?.get as (this: ArrayBuffer) => number;
const intrinsicArrayBufferResizableGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBufferPrototype,
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

export interface ExactByteCarrierOptions {
	readonly allowEmpty?: boolean;
	readonly maxBytes?: number;
}

/** Copies one exact, attached, unshared, non-resizable full-buffer byte carrier. */
export function copyExactByteCarrier(
	input: Uint8Array,
	name: string,
	options: ExactByteCarrierOptions = {}
): Uint8Array {
	try {
		if (intrinsicObjectGetPrototypeOf(input) !== intrinsicUint8ArrayPrototype) {
			throw new TypeError(`${name} must be an unshared Uint8Array`);
		}
		const byteLength = intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, input, []);
		const byteOffset = intrinsicReflectApply(intrinsicTypedArrayByteOffsetGetter, input, []);
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, input, []);
		if (intrinsicObjectGetPrototypeOf(buffer) !== intrinsicArrayBufferPrototype) {
			throw new TypeError(`${name} must be an unshared Uint8Array`);
		}
		const bufferByteLength = intrinsicReflectApply(intrinsicArrayBufferByteLengthGetter, buffer, []);
		const resizable =
			intrinsicArrayBufferResizableGetter === undefined
				? false
				: intrinsicReflectApply(intrinsicArrayBufferResizableGetter, buffer, []);
		if ((!options.allowEmpty && byteLength === 0) || byteOffset !== 0 || byteLength !== bufferByteLength || resizable) {
			throw new TypeError(`${name} must use one full, attached, non-resizable byte buffer`);
		}
		if (options.maxBytes !== undefined && byteLength > options.maxBytes) {
			throw new TypeError(`${name} exceeds the maximum byte length`);
		}
		const copy = new intrinsicUint8Array(byteLength);
		intrinsicReflectApply(intrinsicUint8ArraySet, copy, [input]);
		return copy;
	} catch (error) {
		if (error instanceof TypeError && error.message.startsWith(name)) throw error;
		throw new TypeError(`${name} is unreadable`, { cause: error });
	}
}

/** Copies bytes already held by this package after their external boundary was validated. */
export function copyTrustedBytes(input: Uint8Array): Uint8Array {
	return new intrinsicUint8Array(input);
}
