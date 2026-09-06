export { hashDomain } from "@ts-drp/canonical";

const digestPattern = /^[0-9a-f]{64}$/u;

/** Compares a declared lowercase SHA-256 hex digest to bytes without an early-exit timing leak. */
export function matchesDigestHex(declared: unknown, computed: Uint8Array): boolean {
	if (typeof declared !== "string" || !digestPattern.test(declared) || computed.byteLength !== 32) return false;
	let difference = 0;
	for (let index = 0; index < computed.byteLength; index++) {
		const declaredByte = Number.parseInt(declared.slice(index * 2, index * 2 + 2), 16);
		difference |= declaredByte ^ (computed[index] as number);
	}
	return difference === 0;
}
