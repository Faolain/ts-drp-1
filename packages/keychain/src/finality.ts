import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { consumeSealSigningRequest, type SealSigningRequest } from "@ts-drp/protocol-v3/internal/seal-signing-request";

declare const finalitySignerBrand: unique symbol;

export interface FinalitySigner {
	readonly [finalitySignerBrand]: true;
}

interface FinalitySignerState {
	readonly privateKey: Ed25519PrivateKey;
	readonly publicKey: Uint8Array;
}

const signerStates = new WeakMap<FinalitySigner, FinalitySignerState>();
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get as (
	this: ArrayBuffer
) => number;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get as
	| ((this: ArrayBuffer) => boolean)
	| undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get as (
	this: Uint8Array
) => ArrayBufferLike;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get as (
	this: Uint8Array
) => number;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get as (
	this: Uint8Array
) => number;

function exactBytes(value: unknown, expectedLength: 32 | 64, message: string): Uint8Array {
	try {
		if (Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new TypeError(message);
		const bytes = value as Uint8Array;
		if (
			(Reflect.apply(typedArrayByteOffset, bytes, []) as number) !== 0 ||
			(Reflect.apply(typedArrayByteLength, bytes, []) as number) !== expectedLength
		) {
			throw new TypeError(message);
		}
		const buffer = Reflect.apply(typedArrayBuffer, bytes, []) as ArrayBufferLike;
		if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) throw new TypeError(message);
		if ((Reflect.apply(arrayBufferByteLength, buffer, []) as number) !== expectedLength) throw new TypeError(message);
		if (arrayBufferResizable !== undefined && (Reflect.apply(arrayBufferResizable, buffer, []) as boolean)) {
			throw new TypeError(message);
		}
		return Uint8Array.from(bytes);
	} catch {
		throw new TypeError(message);
	}
}

function copyLibrarySignature(value: unknown): Uint8Array {
	try {
		const signature = value as Uint8Array;
		if ((Reflect.apply(typedArrayByteLength, signature, []) as number) !== 64) {
			throw new TypeError("invalid signature length");
		}
		const output = new Uint8Array(64);
		output.set(signature);
		return output;
	} catch {
		throw new TypeError("finality signature must be exactly 64 bytes");
	}
}

/**
 * Creates opaque recoverable finality-key custody from an exact Ed25519 seed.
 * @param input - Exact private seed carrier.
 * @returns Detached public key and opaque signing authority.
 */
export async function createRecoverableFinalitySigner(input: Readonly<{ seed: Uint8Array }>): Promise<
	Readonly<{
		publicKey: Uint8Array;
		signer: FinalitySigner;
	}>
> {
	if (
		input === null ||
		typeof input !== "object" ||
		Reflect.ownKeys(input).length !== 1 ||
		!Object.hasOwn(input, "seed")
	) {
		throw new TypeError("finality signer input must contain only seed");
	}
	const seed = exactBytes(input.seed, 32, "finality seed must be an exact 32-byte Uint8Array");
	const privateKey = await generateKeyPairFromSeed("Ed25519", seed);
	if (privateKey.type !== "Ed25519") throw new Error("expected Ed25519 finality key");
	const publicKey = exactBytes(privateKey.publicKey.raw, 32, "finality public key must be an exact 32-byte Uint8Array");
	const signer = Object.freeze({}) as unknown as FinalitySigner;
	signerStates.set(signer, Object.freeze({ privateKey, publicKey: Uint8Array.from(publicKey) }));
	return Object.freeze({ publicKey: Uint8Array.from(publicKey), signer });
}

/**
 * Signs one protocol-authored, one-use seal request through opaque finality-key custody.
 * @param input - Opaque signer and protocol-owned signing request.
 * @returns Detached exact Ed25519 signature bytes.
 */
export async function signSealRegisteredDigest(
	input: Readonly<{
		request: SealSigningRequest;
		signer: FinalitySigner;
	}>
): Promise<Uint8Array> {
	if (
		input === null ||
		typeof input !== "object" ||
		Reflect.ownKeys(input).length !== 2 ||
		!Object.hasOwn(input, "request") ||
		!Object.hasOwn(input, "signer")
	) {
		throw new TypeError("finality signing input is malformed");
	}
	const state = signerStates.get(input.signer);
	if (state === undefined) throw new TypeError("untrusted finality signer");
	const consumed = consumeSealSigningRequest(input.request);
	if (consumed === undefined) throw new TypeError("untrusted or consumed seal signing request");
	const digest = exactBytes(consumed, 32, "registered seal digest must be exactly 32 bytes");
	const signature = await state.privateKey.sign(digest);
	return copyLibrarySignature(signature);
}
