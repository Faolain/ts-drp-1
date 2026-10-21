import { ed25519 } from "@noble/curves/ed25519.js";

/** Strict (non-ZIP-215) verification is a pure function of its exact bytes.
 * Authentication layers re-verify the same immutable signed records many times
 * per transition; this bounded exact-byte memo returns the identical boolean.
 * It carries no authority: callers still bind every byte they verify. */
const MEMO_LIMIT = 2048;
const MEMO_MAX_MESSAGE_BYTES = 256;
const memo = new Map<string, boolean>();

function bytesKey(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): string {
	let key = `${signature.byteLength}.${message.byteLength}.${publicKey.byteLength}:`;
	for (const part of [signature, message, publicKey])
		for (let index = 0; index < part.byteLength; index++) key += String.fromCharCode(part[index]!);
	return key;
}

/**
 * Verifies an Ed25519 signature with `zip215: false`, memoizing exact inputs.
 * @param signature - Exact signature bytes.
 * @param message - Exact signed message bytes.
 * @param publicKey - Exact public key bytes.
 * @returns Whether the signature verifies.
 */
export function verifyEd25519(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
	if (!(signature instanceof Uint8Array && message instanceof Uint8Array && publicKey instanceof Uint8Array) ||
		message.byteLength > MEMO_MAX_MESSAGE_BYTES)
		return ed25519.verify(signature, message, publicKey, { zip215: false });
	const key = bytesKey(signature, message, publicKey);
	const known = memo.get(key);
	if (known !== undefined) return known;
	const verified = ed25519.verify(signature, message, publicKey, { zip215: false });
	if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value!);
	memo.set(key, verified);
	return verified;
}
