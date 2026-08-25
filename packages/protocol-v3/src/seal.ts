import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import type { CertifiedAnchorTrust } from "./index.js";
import { resolveCertifiedSealAuthorityMaterial } from "./internal/seal-authority-custody.js";
import { registerSealAuthorityIdentity } from "./internal/seal-authority-identity.js";
import { mintSealSigningRequest, type SealSigningRequest } from "./internal/seal-signing-request.js";
import registryJson from "../registry/registry-v1.json" with { type: "json" };

type SealPhase = "commit" | "prepare";

interface RegistryField {
	readonly const: unknown;
	readonly constraints: Readonly<Record<string, unknown>>;
	readonly name: string;
	readonly sortRule: string | null;
	readonly type: string;
}

interface RegistryKind {
	readonly domain: string;
	readonly fields: readonly RegistryField[];
}

interface SealAuthorityState {
	readonly anchor: string;
	readonly epoch: 0;
	readonly objectId: string;
	readonly publicKeys: ReadonlyMap<string, Uint8Array>;
	readonly quorum: number;
	readonly signerId: string;
}

interface VerifiedPrepareQC {
	readonly digest: string;
	readonly round: number;
	readonly valueDigest: string;
}

declare const sealAuthorityBrand: unique symbol;

export interface SealAuthority {
	readonly [sealAuthorityBrand]: true;
}

const registry = registryJson as unknown as {
	readonly kinds: Readonly<Record<string, RegistryKind>>;
};
const authorityStates = new WeakMap<SealAuthority, SealAuthorityState>();
const verifiedPrepareQCs = new WeakMap<SealAuthority, VerifiedPrepareQC>();
const textEncoder = new TextEncoder();
const digestHex = /^[0-9a-f]{64}$/u;
const signatureHex = /^[0-9a-f]{128}$/u;
const intrinsicArrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get as (
	this: ArrayBuffer
) => number;
const intrinsicArrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get as
	| ((this: ArrayBuffer) => boolean)
	| undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const intrinsicBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get as (
	this: Uint8Array
) => ArrayBufferLike;
const intrinsicByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get as (
	this: Uint8Array
) => number;
const intrinsicByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get as (
	this: Uint8Array
) => number;

function copyExactBytes(value: unknown, expectedLength?: number, maximumLength = 65_536): Uint8Array {
	try {
		if (Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new TypeError("invalid byte carrier");
		const bytes = value as Uint8Array;
		const byteLength = Reflect.apply(intrinsicByteLength, bytes, []) as number;
		if (byteLength > maximumLength || (expectedLength !== undefined && byteLength !== expectedLength)) {
			throw new TypeError("invalid byte carrier length");
		}
		if ((Reflect.apply(intrinsicByteOffset, bytes, []) as number) !== 0) throw new TypeError("invalid byte offset");
		const buffer = Reflect.apply(intrinsicBuffer, bytes, []) as ArrayBufferLike;
		if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) throw new TypeError("invalid byte buffer");
		if ((Reflect.apply(intrinsicArrayBufferByteLength, buffer, []) as number) !== byteLength) {
			throw new TypeError("invalid byte buffer length");
		}
		if (
			intrinsicArrayBufferResizable !== undefined &&
			(Reflect.apply(intrinsicArrayBufferResizable, buffer, []) as boolean)
		) {
			throw new TypeError("resizable byte buffer is unsupported");
		}
		return Uint8Array.from(bytes);
	} catch {
		throw new TypeError("invalid exact byte carrier");
	}
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
	if (value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) throw new TypeError("invalid lowercase hex");
	return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
		Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
	);
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function exactRecordKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
	const actual = Reflect.ownKeys(value);
	return (
		actual.every((key): key is string => typeof key === "string") &&
		actual.length === expected.length &&
		[...actual].sort().every((key, index) => key === [...expected].sort()[index])
	);
}

function wellFormedString(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is string {
	if (typeof value !== "string" || value.length < minimum || value.length > maximum) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const trailing = value.charCodeAt(++index);
			if (trailing < 0xdc00 || trailing > 0xdfff) return false;
		} else if (code >= 0xdc00 && code <= 0xdfff) return false;
	}
	return true;
}

function safeInteger(
	value: unknown,
	minimum = Number.MIN_SAFE_INTEGER,
	maximum = Number.MAX_SAFE_INTEGER
): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function numericConstraint(field: RegistryField, name: string, fallback: number): number {
	const candidate = field.constraints[name];
	return typeof candidate === "number" && Number.isSafeInteger(candidate) ? candidate : fallback;
}

function compareCodePoint(left: string, right: string): number {
	return compareBytes(textEncoder.encode(left), textEncoder.encode(right));
}

function validateSignerArray(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	let previous: string | undefined;
	const seen = new Set<string>();
	for (const signer of value) {
		if (!plainRecord(signer) || !exactRecordKeys(signer, ["publicKey", "signerId"])) return false;
		if (!wellFormedString(signer.signerId, 1, 512) || typeof signer.publicKey !== "string") return false;
		if (!digestHex.test(signer.publicKey) || seen.has(signer.signerId)) return false;
		if (previous !== undefined && compareCodePoint(previous, signer.signerId) >= 0) return false;
		seen.add(signer.signerId);
		previous = signer.signerId;
	}
	return true;
}

function validateSignedVotes(value: unknown): boolean {
	if (!Array.isArray(value) || value.length === 0) return false;
	let previous: string | undefined;
	const seen = new Set<string>();
	for (const vote of value) {
		if (!plainRecord(vote) || !exactRecordKeys(vote, ["signature", "signerId", "voteDigest"])) return false;
		if (!wellFormedString(vote.signerId, 1, 512)) return false;
		if (typeof vote.voteDigest !== "string" || !digestHex.test(vote.voteDigest)) return false;
		if (typeof vote.signature !== "string" || !signatureHex.test(vote.signature)) return false;
		if (seen.has(vote.signerId)) return false;
		if (previous !== undefined && compareCodePoint(previous, vote.signerId) >= 0) return false;
		seen.add(vote.signerId);
		previous = vote.signerId;
	}
	return true;
}

function validateRegisteredRecord(kindName: string, value: unknown): value is Readonly<Record<string, unknown>> {
	const kind = registry.kinds[kindName];
	if (
		kind === undefined ||
		!plainRecord(value) ||
		!exactRecordKeys(
			value,
			kind.fields.map(({ name }) => name)
		)
	) {
		return false;
	}
	for (const field of kind.fields) {
		const candidate = value[field.name];
		if (field.const !== null && !Object.is(candidate, field.const)) return false;
		switch (field.type) {
			case "string":
				if (
					!wellFormedString(
						candidate,
						numericConstraint(field, "minimumUtf16Units", 0),
						numericConstraint(field, "maximumUtf16Units", Number.MAX_SAFE_INTEGER)
					)
				)
					return false;
				break;
			case "enum": {
				const values = field.constraints.values;
				if (!Array.isArray(values) || !values.includes(candidate)) return false;
				break;
			}
			case "safe-integer":
				if (
					!safeInteger(
						candidate,
						numericConstraint(field, "minimum", Number.MIN_SAFE_INTEGER),
						numericConstraint(field, "maximum", Number.MAX_SAFE_INTEGER)
					)
				)
					return false;
				break;
			case "digest-hex":
				if (typeof candidate !== "string" || !digestHex.test(candidate)) return false;
				break;
			case "array<signer>":
				if (!validateSignerArray(candidate)) return false;
				break;
			case "parameters":
				if (!validateRegisteredRecord("parameters", candidate)) return false;
				break;
			case "array<signed-seal-vote>":
				if (!validateSignedVotes(candidate)) return false;
				break;
			default:
				return false;
		}
	}
	return true;
}

function decodeExactRecord(bytes: Uint8Array, kind: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const decoded = decodeCanonical(bytes);
		if (!validateRegisteredRecord(kind, decoded)) return undefined;
		if (compareBytes(encodeCanonical(decoded), bytes) !== 0) return undefined;
		return decoded;
	} catch {
		return undefined;
	}
}

function failure(reason: string): Readonly<{ ok: false; reason: string }> {
	return Object.freeze({ ok: false as const, reason });
}

/**
 * Binds a finality public key to the unique signer ID in certified epoch-zero custody.
 * @param input - Certified trust capability and exact finality public key.
 * @returns Opaque seal authority or a typed failure.
 */
export function openSealAuthority(
	input: unknown
): Readonly<{ authority: SealAuthority; ok: true; signerId: string } | { ok: false; reason: string }> {
	try {
		if (!plainRecord(input) || !exactRecordKeys(input, ["signerPublicKey", "trust"])) return failure("malformed-input");
		const material = resolveCertifiedSealAuthorityMaterial(input.trust as CertifiedAnchorTrust);
		if (material === undefined || material.currentEpoch !== 0) return failure("untrusted-context");
		const signerPublicKey = copyExactBytes(input.signerPublicKey, 32, 32);
		const decodedSignerSet = decodeCanonical(material.exactCanonicalSignerSetBytes);
		if (!validateSignerArray(decodedSignerSet)) {
			return failure("invalid-signer-set");
		}
		const publicKeys = new Map<string, Uint8Array>();
		let signerId: string | undefined;
		for (const signer of decodedSignerSet as readonly Readonly<Record<string, unknown>>[]) {
			const publicKey = hexToBytes(signer.publicKey as string);
			publicKeys.set(signer.signerId as string, publicKey);
			if (compareBytes(publicKey, signerPublicKey) === 0) {
				if (signerId !== undefined) return failure("ambiguous-signer-key");
				signerId = signer.signerId as string;
			}
		}
		if (signerId === undefined) return failure("signer-not-authorized");
		const authority = Object.freeze({}) as unknown as SealAuthority;
		authorityStates.set(
			authority,
			Object.freeze({
				anchor: material.currentAnchorDigest,
				epoch: 0,
				objectId: material.objectId,
				publicKeys,
				quorum: material.quorum,
				signerId,
			})
		);
		registerSealAuthorityIdentity(authority, {
			anchor: material.currentAnchorDigest,
			epoch: 0,
			objectId: material.objectId,
			signerId,
		});
		return Object.freeze({ authority, ok: true as const, signerId });
	} catch {
		return failure("malformed-input");
	}
}

/**
 * Authors the exact registered vote preimage for one certified CutValue.
 * @param input - Opaque authority, exact CutValue, phase, and round.
 * @returns Prepared vote material or a typed failure.
 */
export function prepareSealVote(
	input: Readonly<{
		authority: SealAuthority;
		exactCanonicalCutValueBytes: Uint8Array;
		phase: SealPhase;
		round: number;
	}>
): Readonly<
	| { ok: false; reason: string }
	| {
			anchor: string;
			exactCanonicalPreimageBytes: Uint8Array;
			objectId: string;
			ok: true;
			prepareQC: Readonly<{ digest: string; round: number; valueDigest: string }> | null;
			proposalHash: string;
			publicKey: Uint8Array;
			registeredDigest: Uint8Array;
			signingRequest: SealSigningRequest;
			signerId: string;
			valueDigest: string;
	  }
> {
	try {
		if (
			!plainRecord(input) ||
			!exactRecordKeys(input, ["authority", "exactCanonicalCutValueBytes", "phase", "round"])
		) {
			return failure("malformed-input");
		}
		const state = authorityStates.get(input.authority);
		if (state === undefined) return failure("untrusted-context");
		if ((input.phase !== "prepare" && input.phase !== "commit") || !safeInteger(input.round, 0)) {
			return failure("malformed-input");
		}
		const cutBytes = copyExactBytes(input.exactCanonicalCutValueBytes);
		const cut = decodeExactRecord(cutBytes, "cutValue");
		if (
			cut === undefined ||
			cut.objectId !== state.objectId ||
			cut.epoch !== state.epoch ||
			cut.previousAnchor !== state.anchor
		) {
			return failure("cut-binding-mismatch");
		}
		const valueDigest = bytesToHex(hashDomain(registry.kinds.cutValue?.domain ?? "", cutBytes));
		const proposalBytes = encodeCanonical({
			epoch: state.epoch,
			kind: "drp-seal-proposal",
			objectId: state.objectId,
			round: input.round,
			valueDigest,
		});
		const proposalHash = bytesToHex(hashDomain(registry.kinds.sealProposal?.domain ?? "", proposalBytes));
		const verifiedPrepareQC = verifiedPrepareQCs.get(input.authority);
		if (
			input.phase === "commit" &&
			(verifiedPrepareQC === undefined ||
				verifiedPrepareQC.round !== input.round ||
				verifiedPrepareQC.valueDigest !== valueDigest)
		) {
			return failure("prepare-qc-required");
		}
		const exactCanonicalPreimageBytes = encodeCanonical({
			epoch: state.epoch,
			kind: "drp-seal-vote",
			objectId: state.objectId,
			phase: input.phase,
			proposalDigest: valueDigest,
			proposalHash,
			round: input.round,
			signerId: state.signerId,
		});
		const registeredDigest = hashDomain(registry.kinds.sealVote?.domain ?? "", exactCanonicalPreimageBytes);
		return Object.freeze({
			anchor: state.anchor,
			exactCanonicalPreimageBytes: Uint8Array.from(exactCanonicalPreimageBytes),
			objectId: state.objectId,
			ok: true as const,
			proposalHash,
			prepareQC: verifiedPrepareQC?.valueDigest === valueDigest ? Object.freeze({ ...verifiedPrepareQC }) : null,
			publicKey: Uint8Array.from(state.publicKeys.get(state.signerId) as Uint8Array),
			registeredDigest: Uint8Array.from(registeredDigest),
			signingRequest: mintSealSigningRequest(registeredDigest),
			signerId: state.signerId,
			valueDigest,
		});
	} catch {
		return failure("malformed-input");
	}
}

/**
 * Verifies one exact seal QC against certified signer custody.
 * @param input - Opaque authority and exact canonical QC bytes.
 * @returns Verified QC identity or a typed failure.
 */
export function verifySealQC(
	input: Readonly<{ authority: SealAuthority; exactCanonicalQcBytes: Uint8Array }>
): Readonly<
	| { ok: false; reason: string }
	| { ok: true; phase: SealPhase; proposalHash: string; round: number; valueDigest: string }
> {
	try {
		if (!plainRecord(input) || !exactRecordKeys(input, ["authority", "exactCanonicalQcBytes"])) {
			return failure("malformed-input");
		}
		const state = authorityStates.get(input.authority);
		if (state === undefined) return failure("untrusted-context");
		const qcBytes = copyExactBytes(input.exactCanonicalQcBytes);
		const qc = decodeExactRecord(qcBytes, "sealQC");
		if (
			qc === undefined ||
			qc.objectId !== state.objectId ||
			qc.epoch !== state.epoch ||
			!safeInteger(qc.round, 0) ||
			(qc.phase !== "prepare" && qc.phase !== "commit") ||
			typeof qc.proposalDigest !== "string" ||
			typeof qc.proposalHash !== "string"
		) {
			return failure("qc-binding-mismatch");
		}
		const expectedProposalHash = bytesToHex(
			hashDomain(
				registry.kinds.sealProposal?.domain ?? "",
				encodeCanonical({
					epoch: state.epoch,
					kind: "drp-seal-proposal",
					objectId: state.objectId,
					round: qc.round,
					valueDigest: qc.proposalDigest,
				})
			)
		);
		if (qc.proposalHash !== expectedProposalHash) return failure("proposal-hash-mismatch");
		const votes = qc.votes as readonly Readonly<Record<string, unknown>>[];
		if (votes.length < state.quorum) return failure("insufficient-quorum");
		for (const vote of votes) {
			const publicKey = state.publicKeys.get(vote.signerId as string);
			if (publicKey === undefined) return failure("unauthorized-signer");
			const preimage = encodeCanonical({
				epoch: state.epoch,
				kind: "drp-seal-vote",
				objectId: state.objectId,
				phase: qc.phase,
				proposalDigest: qc.proposalDigest,
				proposalHash: qc.proposalHash,
				round: qc.round,
				signerId: vote.signerId,
			});
			const digest = hashDomain(registry.kinds.sealVote?.domain ?? "", preimage);
			if (bytesToHex(digest) !== vote.voteDigest) return failure("vote-tuple-mismatch");
			if (!ed25519.verify(hexToBytes(vote.signature as string), digest, publicKey, { zip215: false })) {
				return failure("invalid-signature");
			}
		}
		if (qc.phase === "prepare") {
			const existing = verifiedPrepareQCs.get(input.authority);
			if (existing !== undefined && existing.round === qc.round && existing.valueDigest !== qc.proposalDigest) {
				return failure("conflicting-prepare-qc");
			}
			if (existing === undefined || qc.round > existing.round) {
				verifiedPrepareQCs.set(
					input.authority,
					Object.freeze({
						digest: bytesToHex(hashDomain(registry.kinds.sealQC?.domain ?? "", qcBytes)),
						round: qc.round,
						valueDigest: qc.proposalDigest,
					})
				);
			}
		}
		return Object.freeze({
			ok: true as const,
			phase: qc.phase as SealPhase,
			proposalHash: qc.proposalHash,
			round: qc.round,
			valueDigest: qc.proposalDigest,
		});
	} catch {
		return failure("malformed-input");
	}
}
