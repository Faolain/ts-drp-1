import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { consumeOwnedSigningRequest, type OwnedSigningRequest } from "@ts-drp/protocol-v3/internal/owned-signing-request";
import {
	consumeCreatorAnchorSigningRequest,
	type CreatorAnchorSigningRequest,
} from "@ts-drp/protocol-v3/internal/creator-anchor-signing-request";
import {
	consumeCreatorIssuanceRetirementSigningRequest,
	type CreatorIssuanceRetirementSigningRequest,
} from "@ts-drp/protocol-v3/internal/creator-issuance-retirement-signing-request";
import {
	consumeSealSigningRequest,
	type SealSigningRequest,
	type CapturedSigningRequest,
	type SigningNativeAdmission,
} from "@ts-drp/protocol-v3/internal/seal-signing-request";

declare const finalitySignerBrand: unique symbol;

export interface FinalitySigner {
	readonly [finalitySignerBrand]: true;
}

interface FinalitySignerState {
	privateKey: Ed25519PrivateKey | undefined;
	readonly publicKey: Uint8Array;
	readonly localCustody?: LocalFinalitySigningCustody;
	readonly execution: {
		readonly pending: Set<Promise<Uint8Array>>;
		exclusion: object | undefined;
		retired: boolean;
		retirement: Promise<void> | undefined;
	};
}

/** Native lifetime mechanics only; never wire/profile authority. */
export interface LocalFinalitySigningCustody {
	assertCurrent(): void;
	enterOwnedSigning(): () => void;
	assertOwnedOperationSigning(digest: Uint8Array): void;
	assertOwnedGenesisSigning(digest: Uint8Array): void;
	assertOwnedSelectionSigning(digest: Uint8Array): void;
	assertOwnedIdentityChallengeSigning(kind: "possession" | "transport", digest: Uint8Array): void;
}

/** Volatile custody of this genuine key's entered work, not a durable epoch fence. */
export interface FinalitySigningExclusion {
	check(): Promise<void>;
	release(): Promise<void>;
}

const signerStates = new WeakMap<FinalitySigner, FinalitySignerState>();

function executionState(input: unknown): FinalitySignerState {
	if (input === null || typeof input !== "object" || Array.isArray(input))
		throw new TypeError("finality signer selector is malformed");
	const prototype = Object.getPrototypeOf(input);
	const field = Object.getOwnPropertyDescriptor(input, "signer");
	if (
		(prototype !== Object.prototype && prototype !== null) ||
		Reflect.ownKeys(input).length !== 1 ||
		field?.enumerable !== true ||
		!("value" in field)
	)
		throw new TypeError("finality signer selector is malformed");
	const state = signerStates.get(field.value as FinalitySigner);
	if (state === undefined) throw new TypeError("untrusted finality signer");
	return state;
}

function assertSigningAdmission(state: FinalitySignerState): void {
	if (state.execution.retired || state.privateKey === undefined) throw new TypeError("finality signer is retired");
	if (state.execution.exclusion !== undefined) throw new TypeError("finality signing is excluded");
	state.localCustody?.assertCurrent();
}

function executeSignature(
	state: FinalitySignerState,
	digest: Uint8Array,
	captured?: CapturedSigningRequest
): Promise<Uint8Array> {
	assertSigningAdmission(state);
	const privateKey = state.privateKey;
	if (privateKey === undefined) throw new TypeError("finality signer is retired");
	const finish = state.localCustody?.enterOwnedSigning();
	// Register the entire operation before entering external crypto. Revocation
	// blocks new admissions synchronously; already admitted work still owns its
	// exact result/cause and must settle before exclusion/retirement can return.
	const task = Promise.resolve().then(async () => {
		let outerFailed = false, outerPrimary: unknown;
		try {
		let held: SigningNativeAdmission | undefined;
		let primary: unknown,
			failed = false;
		let signature: Uint8Array | undefined;
		try {
			if (captured !== undefined) {
				if (captured.scope === undefined || captured.admission === undefined)
					throw new TypeError("UNBOUND_NATIVE_SIGNING_REQUEST");
				held = await captured.admission(captured.scope);
				await held.check();
			}
			signature = copyLibrarySignature(await privateKey.sign(digest));
			if (held !== undefined) await held.check();
		} catch (cause) {
			failed = true;
			primary = cause;
		}
		if (held !== undefined) {
			try {
				await held.release();
			} catch (cleanup) {
				if (failed)
					throw new AggregateError([primary, cleanup], "native signing and release failed", { cause: primary });
				throw cleanup;
			}
		}
		if (failed) throw primary;
		if (signature === undefined) throw new Error("SIGNATURE_RESULT_UNAVAILABLE");
		state.localCustody?.assertCurrent();
		return signature;
		} catch (cause) { outerFailed = true; outerPrimary = cause; throw cause; }
		finally {
			try { finish?.(); }
			catch (cleanup) {
				if (outerFailed) throw new AggregateError([outerPrimary, cleanup], "owned signing and lifetime release failed", { cause: outerPrimary });
				throw cleanup;
			}
		}
	});
	state.execution.pending.add(task);
	void task.then(
		() => state.execution.pending.delete(task),
		() => state.execution.pending.delete(task)
	);
	return task;
}

/**
 * Revokes new admissions immediately and joins this key's already-entered work.
 * @param input - Exact genuine signer selector.
 * @returns Local exclusion; independent/reconstructed keys and durable floors are outside its authority.
 */
export async function acquireFinalitySigningExclusion(
	input: Readonly<{ signer: FinalitySigner }>
): Promise<FinalitySigningExclusion> {
	const state = executionState(input);
	assertSigningAdmission(state);
	const token = Object.freeze({});
	state.execution.exclusion = token;
	await Promise.allSettled([...state.execution.pending]);
	if (state.execution.retired || state.privateKey === undefined) throw new TypeError("finality signer is retired");
	if (state.execution.exclusion !== token) throw new TypeError("finality signing exclusion is released");
	let released = false;
	const held: FinalitySigningExclusion = Object.freeze({
		check(this: FinalitySigningExclusion): Promise<void> {
			if (this !== held) return Promise.reject(new TypeError("foreign finality signing exclusion"));
			return !released && !state.execution.retired && state.execution.exclusion === token
				? Promise.resolve()
				: Promise.reject(new TypeError("finality signing exclusion is released"));
		},
		release(this: FinalitySigningExclusion): Promise<void> {
			if (this !== held) return Promise.reject(new TypeError("foreign finality signing exclusion"));
			released = true;
			if (state.execution.exclusion === token) state.execution.exclusion = undefined;
			return Promise.resolve();
		},
	});
	return held;
}

/**
 * Permanently revokes this local signer, joins admitted work and drops retained key custody.
 * @param input - Exact genuine signer selector.
 * @returns Joined local retirement; not zeroization or a fence against reconstructing the seed elsewhere.
 */
export async function retireRecoverableFinalitySigner(input: Readonly<{ signer: FinalitySigner }>): Promise<void> {
	const state = executionState(input);
	state.execution.retired = true;
	state.execution.exclusion = undefined;
	return (state.execution.retirement ??= (async (): Promise<void> => {
		await Promise.allSettled([...state.execution.pending]);
		state.privateKey = undefined;
	})());
}
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
export async function createRecoverableFinalitySigner(input: Readonly<{ seed: Uint8Array }>, localCustody?: LocalFinalitySigningCustody): Promise<
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
	let privateKey: Ed25519PrivateKey;
	try { privateKey = await generateKeyPairFromSeed("Ed25519", seed); localCustody?.assertCurrent(); }
	finally { seed.fill(0); }
	if (privateKey.type !== "Ed25519") throw new Error("expected Ed25519 finality key");
	const publicKey = exactBytes(privateKey.publicKey.raw, 32, "finality public key must be an exact 32-byte Uint8Array");
	const signer = Object.freeze({}) as unknown as FinalitySigner;
	signerStates.set(signer, {
		privateKey,
		publicKey: Uint8Array.from(publicKey),
		...(localCustody === undefined ? {} : { localCustody }),
		execution: { pending: new Set(), exclusion: undefined, retired: false, retirement: undefined },
	});
	return Object.freeze({ publicKey: Uint8Array.from(publicKey), signer });
}

/** One-use authored operation/genesis signing through the same owned key.
 * No private material is returned; original room/issuance/ACL owners still own
 * admission. A borrowed account signer cannot use this local-custody seam.
 */
export async function signOwnedLocalRequest(input: Readonly<{ signer: FinalitySigner; request: OwnedSigningRequest }>): Promise<Uint8Array> {
	const state = signerStates.get(input.signer);
	if (state?.localCustody === undefined) throw new TypeError("untrusted owned local signer");
	assertSigningAdmission(state);
	const finish = state.localCustody.enterOwnedSigning(); // Before retained check/await work.
	let failed = false, primary: unknown;
	try {
	const request = consumeOwnedSigningRequest(input.request);
	if (request === undefined || !state.publicKey.every((byte, index) => byte === request.publicKey[index])) throw new TypeError("UNTRUSTED_OWNED_SIGNING_REQUEST");
	const check = async (): Promise<void> => {
		state.localCustody!.assertCurrent();
		if (request.kind === "operation") state.localCustody!.assertOwnedOperationSigning(request.digest);
		else if (request.kind === "genesis") state.localCustody!.assertOwnedGenesisSigning(request.digest);
		else if (request.kind === "creator-selection") state.localCustody!.assertOwnedSelectionSigning(request.digest);
		else state.localCustody!.assertOwnedIdentityChallengeSigning(request.kind, request.digest);
		state.localCustody!.assertCurrent();
	};
	await check();
	const signature = await executeSignature(state, exactBytes(request.digest, 32, "owned request digest must be exactly 32 bytes"));
	await check();
	state.localCustody.assertCurrent(); // Last await is also a delivery boundary.
	return signature;
	} catch (cause) { failed = true; primary = cause; throw cause; }
	finally {
		try { finish(); } catch (cleanup) {
			if (failed) throw new AggregateError([primary, cleanup], "owned request and joined release failed", { cause: primary });
			throw cleanup;
		}
	}
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
	assertSigningAdmission(state);
	const consumed = consumeSealSigningRequest(input.request);
	if (consumed === undefined) throw new TypeError("untrusted or consumed seal signing request");
	const digest = exactBytes(consumed.digest, 32, "registered seal digest must be exactly 32 bytes");
	if (consumed.scope === undefined || consumed.admission === undefined)
		throw new TypeError("UNBOUND_NATIVE_SIGNING_REQUEST");
	if (!state.publicKey.every((byte, index) => byte === consumed.scope?.publicKey[index]))
		throw new TypeError("SIGNER_KEY_MISMATCH");
	return executeSignature(state, digest, consumed);
}

/**
 * Signs one protocol-authored, one-use creator successor-anchor request.
 * @param input - Opaque signer and creator-anchor signing request.
 * @returns Detached exact Ed25519 signature bytes.
 */
export async function signCreatorAnchorRequest(
	input: Readonly<{
		request: CreatorAnchorSigningRequest;
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
		throw new TypeError("creator-anchor signing input is malformed");
	}
	const state = signerStates.get(input.signer);
	if (state === undefined) throw new TypeError("untrusted finality signer");
	assertSigningAdmission(state);
	const consumed = consumeCreatorAnchorSigningRequest(input.request);
	if (consumed === undefined) throw new TypeError("untrusted or consumed creator-anchor signing request");
	const digest = exactBytes(consumed.digest, 32, "creator anchor digest must be exactly 32 bytes");
	if (consumed.scope === undefined || consumed.admission === undefined)
		throw new TypeError("UNBOUND_NATIVE_SIGNING_REQUEST");
	if (!state.publicKey.every((byte, index) => byte === consumed.scope?.publicKey[index]))
		throw new TypeError("SIGNER_KEY_MISMATCH");
	return executeSignature(state, digest, consumed);
}

/**
 * Signs one protocol-authored, one-use creator issuance-retirement request.
 * @param input - Opaque signer and retirement signing request.
 * @returns Detached exact Ed25519 signature bytes.
 */
export async function signCreatorIssuanceRetirementRequest(
	input: Readonly<{
		request: CreatorIssuanceRetirementSigningRequest;
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
		throw new TypeError("creator issuance-retirement signing input is malformed");
	}
	const state = signerStates.get(input.signer);
	if (state === undefined) throw new TypeError("untrusted finality signer");
	assertSigningAdmission(state);
	const consumed = consumeCreatorIssuanceRetirementSigningRequest(input.request);
	if (consumed === undefined) {
		throw new TypeError("untrusted or consumed creator issuance-retirement signing request");
	}
	const digest = exactBytes(consumed.digest, 32, "creator issuance-retirement digest must be exactly 32 bytes");
	if (consumed.scope === undefined || consumed.admission === undefined)
		throw new TypeError("UNBOUND_NATIVE_SIGNING_REQUEST");
	if (!state.publicKey.every((byte, index) => byte === consumed.scope?.publicKey[index]))
		throw new TypeError("SIGNER_KEY_MISMATCH");
	return executeSignature(state, digest, consumed);
}
