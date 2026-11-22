import { hashDomain } from "@ts-drp/canonical";

const HEX_DIGITS = "0123456789abcdef";
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ReflectApply = Reflect.apply;
const TextEncoderConstructor = TextEncoder;
const TypedArrayPrototype = ObjectGetPrototypeOf(Uint8Array.prototype) as object;
const TypedArrayByteLengthGetter = ObjectGetOwnPropertyDescriptor(TypedArrayPrototype, "byteLength")?.get;

/**
 * Derives the stable v3 live topic from immutable object and genesis identity.
 * @param objectId - Authenticated v3 object identity.
 * @param genesisAnchorDigest - Authenticated immutable genesis anchor digest.
 * @returns Exact versioned live topic bytes rendered as lower hex.
 */
export function deriveV3StableTopic(objectId: string, genesisAnchorDigest: string): string {
	const encoder = new TextEncoderConstructor();
	const digest = hashDomain("ts-drp/live-topic/v3", encoder.encode(objectId), encoder.encode(genesisAnchorDigest));
	if (TypedArrayByteLengthGetter === undefined) throw new TypeError("typed-array byte-length intrinsic is unavailable");
	const byteLength = ReflectApply(TypedArrayByteLengthGetter, digest, []) as number;
	let hex = "";
	for (let index = 0; index < byteLength; index += 1) {
		const byte = digest[index];
		if (byte === undefined) throw new TypeError("topic digest byte is unavailable");
		hex += HEX_DIGITS[(byte >>> 4) & 0x0f] + HEX_DIGITS[byte & 0x0f];
	}
	return `drp/v3/1/${hex}`;
}
