import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import type { CurrentAnchorTrust } from "./index.js";
import {
	type CreatorIssuanceRetirementSigningRequest,
	mintCreatorIssuanceRetirementSigningRequest,
} from "./internal/creator-issuance-retirement-signing-request.js";
import { resolveCreatorAnchorTrustMaterial } from "./internal/seal-authority-custody.js";

export const CREATOR_ISSUANCE_RETIREMENT_KIND = "drp-creator-issuance-retirement-state" as const;
export const CREATOR_ISSUANCE_RETIREMENT_MAX_RECORD_BYTES = 8192 as const;
export const CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE = "D110C_0C1A_RETIREMENT_CHECKPOINT_UNAVAILABLE" as const;
export const CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL = hex(
	hashDomain(
		"ts-drp/creator-issuance-retirement/genesis/v1",
		encodeCanonical({ kind: "drp-creator-issuance-retirement-genesis", version: 1 })
	)
);

const DOMAIN = "ts-drp/creator-issuance-retirement/v1";
const DIGEST = /^[0-9a-f]{64}$/u;
const PREIMAGE_KEYS = Object.freeze([
	"admittedAuthorSequence",
	"author",
	"closedAnchorDigest",
	"closedEpoch",
	"commitQcRef",
	"cutValueDigest",
	"genesisAnchorDigest",
	"kind",
	"objectId",
	"observedLineage",
	"priorAdmittedAuthorSequence",
	"priorRetirementCandidateDigest",
	"protocolMajor",
	"snapshotManifestDigest",
	"successorAnchorDigest",
	"successorEpoch",
	"version",
] as const);
const RECORD_KEYS = Object.freeze([...PREIMAGE_KEYS, "detachedCreatorSignature"] as const);
const PREPARE_INPUT_KEYS = Object.freeze([
	"admittedAuthorSequence",
	"author",
	"commitQcRef",
	"currentTrust",
	"cutValueDigest",
	"observedLineage",
	"priorAdmittedAuthorSequence",
	"priorRetirementCandidateDigest",
	"snapshotManifestDigest",
	"successorTrust",
] as const);

export interface CreatorIssuanceRetirementRef {
	readonly byteLength: number;
	readonly digest: string;
}

export interface CreatorIssuanceRetirementLineage {
	readonly exhausted: boolean;
	readonly next: number;
}

export interface CreatorIssuanceRetirementIdentity {
	readonly admittedAuthorSequence: number;
	readonly author: string;
	readonly closedAnchorDigest: string;
	readonly closedEpoch: number;
	readonly commitQcRef: CreatorIssuanceRetirementRef;
	readonly cutValueDigest: string;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly observedLineage: CreatorIssuanceRetirementLineage;
	readonly priorAdmittedAuthorSequence: number | null;
	readonly priorRetirementCandidateDigest: string;
	readonly snapshotManifestDigest: string;
	readonly successorAnchorDigest: string;
	readonly successorEpoch: number;
}

export interface CreatorIssuanceRetirementPreparation {
	readonly __creatorIssuanceRetirementPreparation?: never;
}

export interface VerifiedCreatorIssuanceRetirement {
	readonly __verifiedCreatorIssuanceRetirement?: never;
}

interface PreparationState {
	readonly digest: Uint8Array;
	readonly preimage: Readonly<Record<string, unknown>>;
	readonly publicKey: Uint8Array;
}

const preparations = new WeakMap<CreatorIssuanceRetirementPreparation, PreparationState>();
const verified = new WeakMap<VerifiedCreatorIssuanceRetirement, CreatorIssuanceRetirementIdentity>();

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	const actual = Reflect.ownKeys(value);
	return (
		actual.length === keys.length &&
		actual.every((key) => typeof key === "string" && keys.includes(key)) &&
		keys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor?.enumerable === true && "value" in descriptor;
		})
	);
}

function safeSequence(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validRef(value: unknown): value is CreatorIssuanceRetirementRef {
	return (
		plainRecord(value) &&
		exactKeys(value, ["byteLength", "digest"]) &&
		typeof value.byteLength === "number" &&
		Number.isSafeInteger(value.byteLength) &&
		value.byteLength > 0 &&
		typeof value.digest === "string" &&
		DIGEST.test(value.digest)
	);
}

function validLineage(value: unknown): value is CreatorIssuanceRetirementLineage {
	return (
		plainRecord(value) &&
		exactKeys(value, ["exhausted", "next"]) &&
		value.exhausted === false &&
		safeSequence(value.next)
	);
}

function identityFromRecord(record: Readonly<Record<string, unknown>>): CreatorIssuanceRetirementIdentity {
	const ref = record.commitQcRef as CreatorIssuanceRetirementRef;
	const lineage = record.observedLineage as CreatorIssuanceRetirementLineage;
	return Object.freeze({
		admittedAuthorSequence: record.admittedAuthorSequence as number,
		author: record.author as string,
		closedAnchorDigest: record.closedAnchorDigest as string,
		closedEpoch: record.closedEpoch as number,
		commitQcRef: Object.freeze({ byteLength: ref.byteLength, digest: ref.digest }),
		cutValueDigest: record.cutValueDigest as string,
		genesisAnchorDigest: record.genesisAnchorDigest as string,
		objectId: record.objectId as string,
		observedLineage: Object.freeze({ exhausted: lineage.exhausted, next: lineage.next }),
		priorAdmittedAuthorSequence: record.priorAdmittedAuthorSequence as number | null,
		priorRetirementCandidateDigest: record.priorRetirementCandidateDigest as string,
		snapshotManifestDigest: record.snapshotManifestDigest as string,
		successorAnchorDigest: record.successorAnchorDigest as string,
		successorEpoch: record.successorEpoch as number,
	});
}

function copiedIdentity(identity: CreatorIssuanceRetirementIdentity): CreatorIssuanceRetirementIdentity {
	return Object.freeze({
		...identity,
		commitQcRef: Object.freeze({ ...identity.commitQcRef }),
		observedLineage: Object.freeze({ ...identity.observedLineage }),
	});
}

function validRecordFields(record: Readonly<Record<string, unknown>>): boolean {
	return (
		record.kind === CREATOR_ISSUANCE_RETIREMENT_KIND &&
		record.protocolMajor === 3 &&
		record.version === 1 &&
		typeof record.objectId === "string" &&
		record.objectId.length > 0 &&
		typeof record.author === "string" &&
		DIGEST.test(record.author) &&
		typeof record.genesisAnchorDigest === "string" &&
		DIGEST.test(record.genesisAnchorDigest) &&
		safeSequence(record.closedEpoch) &&
		typeof record.closedAnchorDigest === "string" &&
		DIGEST.test(record.closedAnchorDigest) &&
		safeSequence(record.successorEpoch) &&
		record.successorEpoch === record.closedEpoch + 1 &&
		typeof record.successorAnchorDigest === "string" &&
		DIGEST.test(record.successorAnchorDigest) &&
		typeof record.cutValueDigest === "string" &&
		DIGEST.test(record.cutValueDigest) &&
		validRef(record.commitQcRef) &&
		typeof record.snapshotManifestDigest === "string" &&
		DIGEST.test(record.snapshotManifestDigest) &&
		typeof record.priorRetirementCandidateDigest === "string" &&
		DIGEST.test(record.priorRetirementCandidateDigest) &&
		(record.priorAdmittedAuthorSequence === null || safeSequence(record.priorAdmittedAuthorSequence)) &&
		safeSequence(record.admittedAuthorSequence) &&
		(record.priorAdmittedAuthorSequence === null ||
			record.admittedAuthorSequence >= record.priorAdmittedAuthorSequence) &&
		validLineage(record.observedLineage) &&
		(record.observedLineage as CreatorIssuanceRetirementLineage).next > record.admittedAuthorSequence &&
		(record.closedEpoch === 0
			? record.priorAdmittedAuthorSequence === null &&
				record.priorRetirementCandidateDigest === CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL
			: record.priorAdmittedAuthorSequence !== null &&
				record.priorRetirementCandidateDigest !== CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL)
	);
}

function failure(reason: string): Readonly<{ ok: false; reason: string }> {
	return Object.freeze({ ok: false as const, reason });
}

/**
 * Prepares one creator-signed cumulative admitted frontier.
 * @param input - Authenticated adjacent trust floors and exact close identities.
 * @returns One-use signing preparation or a closed failure.
 */
export function prepareCreatorIssuanceRetirement(input: unknown): Readonly<
	| { ok: false; reason: string }
	| {
			digest: string;
			exactCanonicalPreimageBytes: Uint8Array;
			ok: true;
			preparation: CreatorIssuanceRetirementPreparation;
			signingRequest: CreatorIssuanceRetirementSigningRequest;
	  }
> {
	try {
		if (!plainRecord(input) || !exactKeys(input, PREPARE_INPUT_KEYS)) {
			return failure("MALFORMED_INPUT");
		}
		const current = resolveCreatorAnchorTrustMaterial(input.currentTrust as CurrentAnchorTrust);
		const successor = resolveCreatorAnchorTrustMaterial(input.successorTrust as CurrentAnchorTrust);
		if (
			current === undefined ||
			successor === undefined ||
			current.objectId !== successor.objectId ||
			current.genesisAnchorDigest !== successor.genesisAnchorDigest ||
			successor.currentEpoch !== current.currentEpoch + 1 ||
			compareBytes(current.publicKey, successor.publicKey) !== 0
		) {
			return failure("TRUST_INVALID");
		}
		const preimage = Object.freeze({
			admittedAuthorSequence: input.admittedAuthorSequence,
			author: input.author,
			closedAnchorDigest: current.currentAnchorDigest,
			closedEpoch: current.currentEpoch,
			commitQcRef: plainRecord(input.commitQcRef)
				? Object.freeze({ byteLength: input.commitQcRef.byteLength, digest: input.commitQcRef.digest })
				: input.commitQcRef,
			cutValueDigest: input.cutValueDigest,
			genesisAnchorDigest: current.genesisAnchorDigest,
			kind: CREATOR_ISSUANCE_RETIREMENT_KIND,
			objectId: current.objectId,
			observedLineage: plainRecord(input.observedLineage)
				? Object.freeze({ exhausted: input.observedLineage.exhausted, next: input.observedLineage.next })
				: input.observedLineage,
			priorAdmittedAuthorSequence: input.priorAdmittedAuthorSequence,
			priorRetirementCandidateDigest: input.priorRetirementCandidateDigest,
			protocolMajor: 3,
			snapshotManifestDigest: input.snapshotManifestDigest,
			successorAnchorDigest: successor.currentAnchorDigest,
			successorEpoch: successor.currentEpoch,
			version: 1,
		});
		if (!validRecordFields(preimage)) {
			return failure("IDENTITY_INVALID");
		}
		const exactCanonicalPreimageBytes = encodeCanonical(preimage);
		const digest = hashDomain(DOMAIN, exactCanonicalPreimageBytes);
		const preparation = Object.freeze({}) as CreatorIssuanceRetirementPreparation;
		preparations.set(
			preparation,
			Object.freeze({ digest: Uint8Array.from(digest), preimage, publicKey: Uint8Array.from(current.publicKey) })
		);
		return Object.freeze({
			digest: hex(digest),
			exactCanonicalPreimageBytes: Uint8Array.from(exactCanonicalPreimageBytes),
			ok: true as const,
			preparation,
			signingRequest: mintCreatorIssuanceRetirementSigningRequest(digest),
		});
	} catch {
		return failure("MALFORMED_INPUT");
	}
}

/**
 * Completes one prepared record after verifying the detached creator signature.
 * @param input - Opaque preparation and exact detached signature.
 * @returns Exact signed record bytes or a closed failure.
 */
export function completeCreatorIssuanceRetirement(
	input: unknown
): Readonly<{ exactCanonicalRecordBytes: Uint8Array; ok: true } | { ok: false; reason: string }> {
	try {
		if (!plainRecord(input) || !exactKeys(input, ["detachedSignature", "preparation"])) {
			return failure("MALFORMED_INPUT");
		}
		const state = preparations.get(input.preparation as CreatorIssuanceRetirementPreparation);
		preparations.delete(input.preparation as CreatorIssuanceRetirementPreparation);
		if (state === undefined) return failure("PREPARATION_UNAVAILABLE");
		if (!(input.detachedSignature instanceof Uint8Array) || input.detachedSignature.byteLength !== 64) {
			return failure("SIGNATURE_INVALID");
		}
		const signature = Uint8Array.from(input.detachedSignature);
		if (!ed25519.verify(signature, state.digest, state.publicKey, { zip215: false })) {
			return failure("SIGNATURE_INVALID");
		}
		const exactCanonicalRecordBytes = encodeCanonical({
			...state.preimage,
			detachedCreatorSignature: signature,
		});
		if (exactCanonicalRecordBytes.byteLength > CREATOR_ISSUANCE_RETIREMENT_MAX_RECORD_BYTES) {
			return failure("RECORD_TOO_LARGE");
		}
		return Object.freeze({ exactCanonicalRecordBytes: Uint8Array.from(exactCanonicalRecordBytes), ok: true as const });
	} catch {
		return failure("MALFORMED_INPUT");
	}
}

/**
 * Opens one signed record against an independently authenticated current floor.
 * @param input - Exact record, floor and expected close identities.
 * @returns Opaque verified capability or a closed failure.
 */
export function openCreatorIssuanceRetirement(
	input: unknown
): Readonly<{ capability: VerifiedCreatorIssuanceRetirement; ok: true } | { ok: false; reason: string }> {
	try {
		if (
			!plainRecord(input) ||
			!exactKeys(input, [
				"exactCanonicalRecordBytes",
				"expectedCommitQcRef",
				"expectedCutValueDigest",
				"expectedSnapshotManifestDigest",
				"floorTrust",
			]) ||
			!(input.exactCanonicalRecordBytes instanceof Uint8Array) ||
			input.exactCanonicalRecordBytes.byteLength > CREATOR_ISSUANCE_RETIREMENT_MAX_RECORD_BYTES
		) {
			return failure("MALFORMED_INPUT");
		}
		const bytes = Uint8Array.from(input.exactCanonicalRecordBytes);
		const decoded = decodeCanonical(bytes);
		if (
			!plainRecord(decoded) ||
			!exactKeys(decoded, RECORD_KEYS) ||
			compareBytes(encodeCanonical(decoded), bytes) !== 0
		) {
			return failure("RECORD_INVALID");
		}
		if (!validRecordFields(decoded) || !(decoded.detachedCreatorSignature instanceof Uint8Array)) {
			return failure("RECORD_INVALID");
		}
		const floor = resolveCreatorAnchorTrustMaterial(input.floorTrust as CurrentAnchorTrust);
		if (
			floor === undefined ||
			decoded.objectId !== floor.objectId ||
			decoded.genesisAnchorDigest !== floor.genesisAnchorDigest ||
			decoded.successorEpoch !== floor.currentEpoch ||
			decoded.successorAnchorDigest !== floor.currentAnchorDigest ||
			decoded.cutValueDigest !== input.expectedCutValueDigest ||
			decoded.snapshotManifestDigest !== input.expectedSnapshotManifestDigest ||
			!validRef(input.expectedCommitQcRef) ||
			(decoded.commitQcRef as CreatorIssuanceRetirementRef).byteLength !== input.expectedCommitQcRef.byteLength ||
			(decoded.commitQcRef as CreatorIssuanceRetirementRef).digest !== input.expectedCommitQcRef.digest
		) {
			return failure("IDENTITY_INVALID");
		}
		const { detachedCreatorSignature: signature, ...preimage } = decoded;
		const digest = hashDomain(DOMAIN, encodeCanonical(preimage));
		if (signature.byteLength !== 64 || !ed25519.verify(signature, digest, floor.publicKey, { zip215: false })) {
			return failure("SIGNATURE_INVALID");
		}
		const capability = Object.freeze({}) as VerifiedCreatorIssuanceRetirement;
		verified.set(capability, identityFromRecord(decoded));
		return Object.freeze({ capability, ok: true as const });
	} catch {
		return failure("MALFORMED_INPUT");
	}
}

/**
 * Resolves detached verified identity from an opaque retirement capability.
 * @param capability - Genuine capability returned by the opener.
 * @returns Detached identity or undefined for foreign custody.
 */
export function resolveCreatorIssuanceRetirement(
	capability: VerifiedCreatorIssuanceRetirement
): CreatorIssuanceRetirementIdentity | undefined {
	const identity = verified.get(capability);
	return identity === undefined ? undefined : copiedIdentity(identity);
}
