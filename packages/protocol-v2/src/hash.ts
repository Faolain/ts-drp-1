import { sha256 } from "@noble/hashes/sha2";

const MAGIC = Uint8Array.of(0x44, 0x52, 0x50, 0x00);
const textEncoder = new TextEncoder();
const digestPattern = /^[0-9a-f]{64}$/u;

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

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

/** Hashes exact parts using the registry-pinned DRP framing and synchronous SHA-256. */
export function hashDomain(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
	const domainBytes = textEncoder.encode(domain);
	const framed: Uint8Array[] = [MAGIC, u32be(domainBytes.byteLength), domainBytes];
	for (const part of parts) framed.push(u64be(part.byteLength), part);
	return sha256(concatBytes(framed));
}

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
