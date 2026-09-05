import { encodeCanonical, hashDomain } from "@ts-drp/canonical";

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Computes the synchronous canonical protocol-v2 state digest.
 * @param state - Value in the frozen canonical domain.
 * @returns A lowercase SHA-256 digest.
 */
export function stateDigest(state: unknown): string {
	return bytesToHex(hashDomain("ts-drp/state/v2", encodeCanonical(state)));
}
