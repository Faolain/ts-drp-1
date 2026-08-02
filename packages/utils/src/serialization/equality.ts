import { encode, ExtensionCodec } from "@msgpack/msgpack";

const extensionCodec = new ExtensionCodec();

extensionCodec.register({
	type: 0,
	encode: (object: unknown): Uint8Array | null =>
		object instanceof Set ? encode([...object], { extensionCodec }) : null,
	decode: () => {
		throw new Error("The encode-only equality codec cannot decode values");
	},
});

extensionCodec.register({
	type: 1,
	encode: (object: unknown): Uint8Array | null =>
		object instanceof Map ? encode([...object], { extensionCodec }) : null,
	decode: () => {
		throw new Error("The encode-only equality codec cannot decode values");
	},
});

extensionCodec.register({
	type: 2,
	encode: (object: unknown): Uint8Array | null =>
		object instanceof Float32Array ? encode([...object], { extensionCodec }) : null,
	decode: () => {
		throw new Error("The encode-only equality codec cannot decode values");
	},
});

/**
 * Encode a value for deterministic byte comparison.
 * @param obj - Value to encode
 * @returns Deterministic wire bytes
 */
export function serializeValue(obj: unknown): Uint8Array {
	return encode(obj, { extensionCodec });
}

/**
 * Compare the exact bytes emitted by the value codec.
 * @param left - First value
 * @param right - Second value
 * @returns Whether both encodings are byte-identical
 */
export function serializedValuesEqual(left: unknown, right: unknown): boolean {
	const leftBytes = serializeValue(left);
	const rightBytes = serializeValue(right);
	if (leftBytes.byteLength !== rightBytes.byteLength) return false;
	return leftBytes.every((byte, index) => byte === rightBytes[index]);
}
