import { bls } from "@chainsafe/bls/herumi";
import type { SecretKey as BlsSecretKey } from "@chainsafe/bls/types";
import { deriveKeyFromEntropy } from "@chainsafe/bls-keygen";
import { generateKeyPair, generateKeyPairFromSeed, privateKeyFromRaw } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey, Secp256k1PrivateKey } from "@libp2p/interface";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { etc, signAsync } from "@noble/secp256k1";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";

export interface KeychainConfig {
	private_key_seed?: string;
}

const intrinsicArrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")
	?.get as (this: ArrayBuffer) => number;
const intrinsicArrayBufferPrototype = ArrayBuffer.prototype;
const intrinsicArrayBufferResizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get as
	| ((this: ArrayBuffer) => boolean)
	| undefined;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicPromise = Promise;
const intrinsicPromiseThen = Promise.prototype.then;
const intrinsicReflectApply = Reflect.apply;
const intrinsicTypedArrayPrototype = intrinsicObjectGetPrototypeOf(Uint8Array.prototype);
const intrinsicTypedArrayBrandGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicTypedArrayPrototype,
	Symbol.toStringTag
)?.get as (this: Uint8Array) => string | undefined;
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
const intrinsicUint8Array = Uint8Array;
const intrinsicUint8ArrayPrototype = Uint8Array.prototype;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;
const LOCAL_AUTHOR_DOMAIN = uint8ArrayFromString("ts-drp-keychain/local-author-ed25519/v1");
const LOCAL_AUTHOR_UNAVAILABLE = "local author identity is unavailable";
const LOCAL_AUTHOR_DIGEST_ERROR = "registeredDigest must be a 32-byte Uint8Array";
const LOCAL_AUTHOR_SIGNATURE_ERROR = "local author signer must return a 64-byte Uint8Array";
const HEX_DIGITS = "0123456789abcdef";

function isWellFormedUtf16Text(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const trailing = value.charCodeAt(index + 1);
			if (trailing < 0xdc00 || trailing > 0xdfff) return false;
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function ordinaryArrayBuffer(value: unknown, expectedLength?: number): value is ArrayBuffer {
	if (intrinsicObjectGetPrototypeOf(value) !== intrinsicArrayBufferPrototype) return false;
	const byteLength = intrinsicReflectApply(intrinsicArrayBufferByteLengthGetter, value, []);
	if (expectedLength !== undefined && byteLength !== expectedLength) return false;
	return intrinsicArrayBufferResizableGetter === undefined
		? true
		: intrinsicReflectApply(intrinsicArrayBufferResizableGetter, value, []) === false;
}

function copyExactOrdinaryBytes(value: unknown, expectedLength: 32 | 64, message: string): Uint8Array {
	try {
		if (intrinsicObjectGetPrototypeOf(value) !== intrinsicUint8ArrayPrototype) throw new TypeError(message);
		const bytes = value as Uint8Array;
		if (
			intrinsicReflectApply(intrinsicTypedArrayByteOffsetGetter, bytes, []) !== 0 ||
			intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, bytes, []) !== expectedLength
		) {
			throw new TypeError(message);
		}
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, bytes, []);
		if (!ordinaryArrayBuffer(buffer, expectedLength)) throw new TypeError(message);
		const copy = new intrinsicUint8Array(expectedLength);
		intrinsicReflectApply(intrinsicUint8ArraySet, copy, [bytes]);
		return copy;
	} catch {
		throw new TypeError(message);
	}
}

function copyPrivateSignerResult(value: unknown): Uint8Array {
	try {
		if (intrinsicReflectApply(intrinsicTypedArrayBrandGetter, value, []) !== "Uint8Array") {
			throw new TypeError(LOCAL_AUTHOR_SIGNATURE_ERROR);
		}
		const bytes = value as Uint8Array;
		if (intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, bytes, []) !== 64) {
			throw new TypeError(LOCAL_AUTHOR_SIGNATURE_ERROR);
		}
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, bytes, []);
		if (!ordinaryArrayBuffer(buffer)) throw new TypeError(LOCAL_AUTHOR_SIGNATURE_ERROR);
		const copy = new intrinsicUint8Array(64);
		intrinsicReflectApply(intrinsicUint8ArraySet, copy, [bytes]);
		return copy;
	} catch {
		throw new TypeError(LOCAL_AUTHOR_SIGNATURE_ERROR);
	}
}

function capturePrivateSignerResult(value: unknown): Uint8Array | Promise<Uint8Array> {
	try {
		if (intrinsicReflectApply(intrinsicTypedArrayBrandGetter, value, []) === "Uint8Array") {
			return copyPrivateSignerResult(value);
		}
	} catch {
		throw new TypeError(LOCAL_AUTHOR_SIGNATURE_ERROR);
	}

	return new intrinsicPromise<Uint8Array>((resolve, reject) => {
		try {
			void intrinsicReflectApply(intrinsicPromiseThen, value, [
				(result: unknown): void => {
					try {
						resolve(copyPrivateSignerResult(result));
					} catch {
						reject(new TypeError(LOCAL_AUTHOR_SIGNATURE_ERROR));
					}
				},
				(error: unknown): void => reject(error),
			]);
		} catch {
			reject(new TypeError(LOCAL_AUTHOR_SIGNATURE_ERROR));
		}
	});
}

function bytesToLowerHex(bytes: Uint8Array): string {
	let result = "";
	for (let index = 0; index < bytes.byteLength; index++) {
		const octet = bytes[index] ?? 0;
		result += HEX_DIGITS[octet >>> 4] + HEX_DIGITS[octet & 0x0f];
	}
	return result;
}

/**
 * Keychain is a class that provides a keychain for the DRPNode.
 * It provides methods to sign data with BLS and Secp256k1.
 */
export class Keychain {
	private _config?: KeychainConfig;
	// if you are to change the private key type, you need to change the peerId's of the bootstrap nodes
	// and any peerId's that are generated from the private key see e.g: https://github.com/drp-tech/ts-drp/pull/492
	private _secp256k1PrivateKey?: Secp256k1PrivateKey;
	private _blsPrivateKey?: BlsSecretKey;
	private _localAuthorPrivateKey?: Ed25519PrivateKey;
	private _localAuthorId?: string;

	/**
	 * Constructor for Keychain
	 * @param config - The configuration for the keychain
	 */
	constructor(config?: KeychainConfig) {
		this._config = config;
	}

	/**
	 * Start the keychain
	 */
	async start(): Promise<void> {
		const configuredSeed = this._config?.private_key_seed;
		if (configuredSeed) {
			if (!isWellFormedUtf16Text(configuredSeed)) throw new TypeError("private_key_seed must be well-formed UTF-16");
			const seed = sha512.create().update(configuredSeed).digest();
			const rawSecp256k1PrivateKey = etc.hashToPrivateKey(seed);
			const key = privateKeyFromRaw(rawSecp256k1PrivateKey);
			if (key.type !== "secp256k1") throw new Error("Expected secp256k1 key");
			const blsKey = bls.SecretKey.fromBytes(deriveKeyFromEntropy(seed));
			const localAuthorPreimage = new intrinsicUint8Array(LOCAL_AUTHOR_DOMAIN.byteLength + 1 + seed.byteLength);
			localAuthorPreimage.set(LOCAL_AUTHOR_DOMAIN, 0);
			localAuthorPreimage[LOCAL_AUTHOR_DOMAIN.byteLength] = 0;
			localAuthorPreimage.set(seed, LOCAL_AUTHOR_DOMAIN.byteLength + 1);
			const localAuthorSeed = sha256(localAuthorPreimage);
			const localAuthorKey = await generateKeyPairFromSeed("Ed25519", localAuthorSeed);
			if (localAuthorKey.type !== "Ed25519") throw new Error("Expected Ed25519 key");
			const localAuthorPublicKey = copyExactOrdinaryBytes(
				localAuthorKey.publicKey.raw,
				32,
				"local author public key must be a 32-byte Uint8Array"
			);

			this._secp256k1PrivateKey = key;
			this._blsPrivateKey = blsKey;
			this._localAuthorPrivateKey = localAuthorKey;
			this._localAuthorId = bytesToLowerHex(localAuthorPublicKey);
		} else {
			const key = await generateKeyPair("secp256k1");
			const blsKey = bls.SecretKey.fromKeygen();

			this._secp256k1PrivateKey = key;
			this._blsPrivateKey = blsKey;
			this._localAuthorPrivateKey = undefined;
			this._localAuthorId = undefined;
		}
	}

	/**
	 * Get the configured local Ed25519 author id.
	 * @returns The lowercase hexadecimal raw public key.
	 */
	get localAuthorId(): string {
		if (this._localAuthorId === undefined) throw new Error(LOCAL_AUTHOR_UNAVAILABLE);
		return this._localAuthorId;
	}

	/**
	 * Sign one registered protocol-v3 digest with the configured local author.
	 * @param registeredDigest - The exact full-buffer 32-byte registered digest.
	 * @returns A fresh full-buffer 64-byte Ed25519 signature.
	 */
	async signWithLocalAuthor(registeredDigest: Uint8Array): Promise<Uint8Array> {
		const localAuthorKey = this._localAuthorPrivateKey;
		if (localAuthorKey === undefined) throw new Error(LOCAL_AUTHOR_UNAVAILABLE);
		const digest = copyExactOrdinaryBytes(registeredDigest, 32, LOCAL_AUTHOR_DIGEST_ERROR);
		const signature = localAuthorKey.sign(digest) as unknown;
		return capturePrivateSignerResult(signature);
	}

	/**
	 * Sign data with BLS
	 * @param data - The data to sign
	 * @returns The signature
	 */
	signWithBls(data: string): Uint8Array {
		if (!this._blsPrivateKey) {
			throw new Error("Private key not found");
		}

		return this._blsPrivateKey.sign(uint8ArrayFromString(data)).toBytes();
	}

	/**
	 * Sign data with Secp256k1
	 * @param data - The data to sign
	 * @returns The signature
	 */
	async signWithSecp256k1(data: string): Promise<Uint8Array> {
		if (!this._secp256k1PrivateKey) {
			throw new Error("Private key not found");
		}

		const hashData = sha256.create().update(data).digest();

		const signature = await signAsync(hashData, this._secp256k1PrivateKey.raw, {
			extraEntropy: true,
		});

		const compactSignature = signature.toCompactRawBytes();

		const fullSignature = new Uint8Array(1 + compactSignature.length);
		fullSignature[0] = signature.recovery;
		fullSignature.set(compactSignature, 1);

		return fullSignature;
	}

	/**
	 * Get the Secp256k1 public key
	 * @returns The public key
	 */
	get secp256k1PublicKey(): string {
		if (!this._secp256k1PrivateKey) {
			throw new Error("Secp256k1 private key not found");
		}
		return uint8ArrayToString(this._secp256k1PrivateKey.publicKey.raw, "base64");
	}

	/**
	 * Get the BLS public key
	 * @returns The public key
	 */
	get blsPublicKey(): string {
		if (!this._blsPrivateKey) {
			throw new Error("BLS private key not found");
		}
		return uint8ArrayToString(this._blsPrivateKey?.toPublicKey().toBytes(), "base64");
	}

	/**
	 * Get the Secp256k1 private key
	 * @returns The private key
	 */
	get secp256k1PrivateKey(): Uint8Array {
		if (!this._secp256k1PrivateKey) {
			throw new Error("Private key not found");
		}
		return this._secp256k1PrivateKey.raw;
	}
}
