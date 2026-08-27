import { hashDomain } from "@ts-drp/canonical";

const HEX_DIGITS = "0123456789abcdef";
const TextEncoderConstructor = TextEncoder;

/**
 * Derives the stable v3 live topic from immutable object and genesis identity.
 * @param objectId - Authenticated v3 object identity.
 * @param genesisAnchorDigest - Authenticated immutable genesis anchor digest.
 * @returns Exact versioned live topic bytes rendered as lower hex.
 */
export function deriveV3StableTopic(objectId: string, genesisAnchorDigest: string): string {
	const encoder = new TextEncoderConstructor();
	const digest = hashDomain("ts-drp/live-topic/v3", encoder.encode(objectId), encoder.encode(genesisAnchorDigest));
	let hex = "";
	for (const byte of digest) hex += HEX_DIGITS[(byte >>> 4) & 0x0f] + HEX_DIGITS[byte & 0x0f];
	return `drp/v3/1/${hex}`;
}
