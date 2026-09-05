import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import type { CurrentAnchorTrust } from "./index.js";
import {
	type CreatorIssuanceRetirementSigningRequest,
	mintCreatorIssuanceRetirementSigningRequest,
} from "./internal/creator-issuance-retirement-signing-request.js";
import { resolveCreatorAnchorTrustMaterial } from "./internal/seal-authority-custody.js";
import { settlementProfileFor } from "./settlement-profile.js";

export const CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND = "drp-creator-author-issuance-frontiers-state" as const;
export const CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES = 8192 as const;
export const CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL = hex(
	hashDomain(
		"ts-drp/creator-author-issuance-frontiers/genesis/v1",
		encodeCanonical({ kind: "drp-creator-author-issuance-frontiers-genesis", version: 1 })
	)
);

const DOMAIN = "ts-drp/creator-author-issuance-frontiers/v1";
const DIGEST = /^[0-9a-f]{64}$/u;
const OBJECT_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const PREIMAGE_KEYS = Object.freeze([
	"closedAnchorDigest",
	"closedEpoch",
	"commitQcRef",
	"currentAclDigest",
	"cutValueDigest",
	"frontiers",
	"genesisAnchorDigest",
	"kind",
	"objectId",
	"priorAggregateCandidateDigest",
	"protocolMajor",
	"snapshotManifestDigest",
	"successorAclDigest",
	"successorAnchorDigest",
	"successorEpoch",
	"version",
] as const);
const RECORD_KEYS = Object.freeze([...PREIMAGE_KEYS, "detachedCreatorSignature"] as const);
const OPEN_KEYS = Object.freeze([
	"exactCanonicalRecordBytes",
	"expectedCommitQcRef",
	"expectedCurrentAclDigest",
	"expectedCutValueDigest",
	"expectedSnapshotManifestDigest",
	"expectedSuccessorAclDigest",
	"floorTrust",
] as const);
const OPEN_KEYS_WITH_CURRENT = Object.freeze([...OPEN_KEYS, "currentTrust"] as const);
const PREPARE_KEYS = Object.freeze([
	"commitQcRef",
	"currentAclDigest",
	"currentTrust",
	"cutValueDigest",
	"frontiers",
	"priorAggregateCandidateDigest",
	"snapshotManifestDigest",
	"successorAclDigest",
	"successorTrust",
] as const);

export type CreatorAuthorIssuanceFrontier = readonly [author: string, admittedAuthorSequence: number | null];

export interface CreatorAuthorIssuanceFrontiersRef {
	readonly byteLength: number;
	readonly digest: string;
}

export interface CreatorAuthorIssuanceFrontiersIdentity {
	readonly closedAnchorDigest: string;
	readonly closedEpoch: number;
	readonly commitQcRef: CreatorAuthorIssuanceFrontiersRef;
	readonly currentAclDigest: string;
	readonly cutValueDigest: string;
	readonly frontiers: readonly CreatorAuthorIssuanceFrontier[];
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly priorAggregateCandidateDigest: string;
	readonly snapshotManifestDigest: string;
	readonly successorAclDigest: string;
	readonly successorAnchorDigest: string;
	readonly successorEpoch: number;
}

export interface CreatorAuthorIssuanceFrontiersPreparation {
	readonly __creatorAuthorIssuanceFrontiersPreparation?: never;
}

export interface VerifiedCreatorAuthorIssuanceFrontiers {
	readonly __verifiedCreatorAuthorIssuanceFrontiers?: never;
}

interface PreparationState {
	readonly digest: Uint8Array;
	readonly preimage: Readonly<Record<string, unknown>>;
	readonly publicKey: Uint8Array;
}

const preparations = new WeakMap<CreatorAuthorIssuanceFrontiersPreparation, PreparationState>();
const verified = new WeakMap<VerifiedCreatorAuthorIssuanceFrontiers, CreatorAuthorIssuanceFrontiersIdentity>();

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

function anchorAclDigest(exactCanonicalAnchorPreimageBytes: Uint8Array): string | undefined {
	try {
		const decoded = decodeCanonical(exactCanonicalAnchorPreimageBytes);
		return plainRecord(decoded) && typeof decoded.aclDigest === "string" && DIGEST.test(decoded.aclDigest)
			? decoded.aclDigest
			: undefined;
	} catch {
		return undefined;
	}
}

function validRef(value: unknown): value is CreatorAuthorIssuanceFrontiersRef {
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

function exactFrontier(value: unknown): CreatorAuthorIssuanceFrontier | undefined {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2) return undefined;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== 3 || !keys.includes("0") || !keys.includes("1") || !keys.includes("length")) return undefined;
	const author = value[0];
	const sequence = value[1];
	return typeof author === "string" && DIGEST.test(author) && (sequence === null || safeSequence(sequence))
		? Object.freeze([author, sequence] as const)
		: undefined;
}

function copiedFrontiers(value: unknown): readonly CreatorAuthorIssuanceFrontier[] | undefined {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) {
		return undefined;
	}
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== value.length + 1 ||
		!keys.includes("length") ||
		value.some((_entry, index) => !keys.includes(String(index)))
	) {
		return undefined;
	}
	const output: CreatorAuthorIssuanceFrontier[] = [];
	let previous = "";
	for (const entry of value) {
		const selected = exactFrontier(entry);
		if (selected === undefined || selected[0] <= previous) return undefined;
		previous = selected[0];
		output.push(selected);
	}
	return Object.freeze(output);
}

function validRecordFields(record: Readonly<Record<string, unknown>>): boolean {
	return (
		record.kind === CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND &&
		record.protocolMajor === 3 &&
		record.version === 1 &&
		typeof record.objectId === "string" &&
		OBJECT_ID.test(record.objectId) &&
		typeof record.genesisAnchorDigest === "string" &&
		DIGEST.test(record.genesisAnchorDigest) &&
		safeSequence(record.closedEpoch) &&
		typeof record.closedAnchorDigest === "string" &&
		DIGEST.test(record.closedAnchorDigest) &&
		safeSequence(record.successorEpoch) &&
		record.successorEpoch === record.closedEpoch + 1 &&
		typeof record.successorAnchorDigest === "string" &&
		DIGEST.test(record.successorAnchorDigest) &&
		typeof record.currentAclDigest === "string" &&
		DIGEST.test(record.currentAclDigest) &&
		typeof record.successorAclDigest === "string" &&
		DIGEST.test(record.successorAclDigest) &&
		typeof record.cutValueDigest === "string" &&
		DIGEST.test(record.cutValueDigest) &&
		validRef(record.commitQcRef) &&
		typeof record.snapshotManifestDigest === "string" &&
		DIGEST.test(record.snapshotManifestDigest) &&
		typeof record.priorAggregateCandidateDigest === "string" &&
		DIGEST.test(record.priorAggregateCandidateDigest) &&
		copiedFrontiers(record.frontiers) !== undefined
	);
}

function identity(record: Readonly<Record<string, unknown>>): CreatorAuthorIssuanceFrontiersIdentity {
	const ref = record.commitQcRef as CreatorAuthorIssuanceFrontiersRef;
	return Object.freeze({
		closedAnchorDigest: record.closedAnchorDigest as string,
		closedEpoch: record.closedEpoch as number,
		commitQcRef: Object.freeze({ byteLength: ref.byteLength, digest: ref.digest }),
		currentAclDigest: record.currentAclDigest as string,
		cutValueDigest: record.cutValueDigest as string,
		frontiers: copiedFrontiers(record.frontiers) as readonly CreatorAuthorIssuanceFrontier[],
		genesisAnchorDigest: record.genesisAnchorDigest as string,
		objectId: record.objectId as string,
		priorAggregateCandidateDigest: record.priorAggregateCandidateDigest as string,
		snapshotManifestDigest: record.snapshotManifestDigest as string,
		successorAclDigest: record.successorAclDigest as string,
		successorAnchorDigest: record.successorAnchorDigest as string,
		successorEpoch: record.successorEpoch as number,
	});
}

function copiedIdentity(value: CreatorAuthorIssuanceFrontiersIdentity): CreatorAuthorIssuanceFrontiersIdentity {
	return Object.freeze({
		...value,
		commitQcRef: Object.freeze({ ...value.commitQcRef }),
		frontiers: Object.freeze(
			value.frontiers.map((entry) => Object.freeze([...entry]) as CreatorAuthorIssuanceFrontier)
		),
	});
}

function failure(reason: string): Readonly<{ ok: false; reason: string }> {
	return Object.freeze({ ok: false as const, reason });
}

/**
 * Prepares one creator-signed bounded current-writer issuance frontier.
 * @param input - Authenticated adjacent trust floors and exact close identities.
 * @returns One-use signing preparation or a closed failure.
 */
export function prepareCreatorAuthorIssuanceFrontiers(input: unknown): Readonly<
	| { ok: false; reason: string }
	| {
			digest: string;
			exactCanonicalPreimageBytes: Uint8Array;
			ok: true;
			preparation: CreatorAuthorIssuanceFrontiersPreparation;
			signingRequest: CreatorIssuanceRetirementSigningRequest;
	  }
> {
	try {
		if (!plainRecord(input) || !exactKeys(input, PREPARE_KEYS)) return failure("MALFORMED_INPUT");
		const current = resolveCreatorAnchorTrustMaterial(input.currentTrust as CurrentAnchorTrust);
		const successor = resolveCreatorAnchorTrustMaterial(input.successorTrust as CurrentAnchorTrust);
		const frontiers = copiedFrontiers(input.frontiers);
		if (
			current === undefined ||
			successor === undefined ||
			frontiers === undefined ||
			current.objectId !== successor.objectId ||
			current.genesisAnchorDigest !== successor.genesisAnchorDigest ||
			successor.currentEpoch !== current.currentEpoch + 1 ||
			compareBytes(current.publicKey, successor.publicKey) !== 0 ||
			input.currentAclDigest !== anchorAclDigest(current.exactCanonicalCurrentAnchorPreimageBytes) ||
			input.successorAclDigest !== anchorAclDigest(successor.exactCanonicalCurrentAnchorPreimageBytes)
		) {
			return failure("TRUST_INVALID");
		}
		const preimage = Object.freeze({
			closedAnchorDigest: current.currentAnchorDigest,
			closedEpoch: current.currentEpoch,
			commitQcRef: plainRecord(input.commitQcRef)
				? Object.freeze({ byteLength: input.commitQcRef.byteLength, digest: input.commitQcRef.digest })
				: input.commitQcRef,
			currentAclDigest: input.currentAclDigest,
			cutValueDigest: input.cutValueDigest,
			frontiers,
			genesisAnchorDigest: current.genesisAnchorDigest,
			kind: CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND,
			objectId: current.objectId,
			priorAggregateCandidateDigest: input.priorAggregateCandidateDigest,
			protocolMajor: 3,
			snapshotManifestDigest: input.snapshotManifestDigest,
			successorAclDigest: input.successorAclDigest,
			successorAnchorDigest: successor.currentAnchorDigest,
			successorEpoch: successor.currentEpoch,
			version: 1,
		});
		if (!validRecordFields(preimage)) return failure("IDENTITY_INVALID");
		const exactCanonicalPreimageBytes = encodeCanonical(preimage);
		const digest = hashDomain(DOMAIN, exactCanonicalPreimageBytes);
		const preparation = Object.freeze({}) as CreatorAuthorIssuanceFrontiersPreparation;
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
 * Completes and size-bounds one prepared frontier record.
 * @param input - Opaque preparation and detached creator signature.
 * @returns Exact canonical record bytes or a closed failure.
 */
export function completeCreatorAuthorIssuanceFrontiers(
	input: unknown
): Readonly<{ exactCanonicalRecordBytes: Uint8Array; ok: true } | { ok: false; reason: string }> {
	try {
		if (!plainRecord(input) || !exactKeys(input, ["detachedSignature", "preparation"])) {
			return failure("MALFORMED_INPUT");
		}
		const state = preparations.get(input.preparation as CreatorAuthorIssuanceFrontiersPreparation);
		preparations.delete(input.preparation as CreatorAuthorIssuanceFrontiersPreparation);
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
		return exactCanonicalRecordBytes.byteLength > CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES
			? failure("RECORD_TOO_LARGE")
			: Object.freeze({ exactCanonicalRecordBytes: Uint8Array.from(exactCanonicalRecordBytes), ok: true as const });
	} catch {
		return failure("MALFORMED_INPUT");
	}
}

/**
 * Opens one exact frontier record against an independently authenticated successor floor.
 * @param input - Exact record, close identities, and authenticated successor floor.
 * @returns Opaque verified capability or a closed failure.
 */
export function openCreatorAuthorIssuanceFrontiers(
	input: unknown
): Readonly<{ capability: VerifiedCreatorAuthorIssuanceFrontiers; ok: true } | { ok: false; reason: string }> {
	try {
		if (
			!plainRecord(input) ||
			(!exactKeys(input, OPEN_KEYS) && !exactKeys(input, OPEN_KEYS_WITH_CURRENT)) ||
			!(input.exactCanonicalRecordBytes instanceof Uint8Array) ||
			input.exactCanonicalRecordBytes.byteLength > CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES
		) {
			return failure("MALFORMED_INPUT");
		}
		const bytes = Uint8Array.from(input.exactCanonicalRecordBytes);
		const decoded = decodeCanonical(bytes, { maxBytes: CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES });
		if (
			!plainRecord(decoded) ||
			!exactKeys(decoded, RECORD_KEYS) ||
			compareBytes(encodeCanonical(decoded), bytes) !== 0 ||
			!validRecordFields(decoded) ||
			!(decoded.detachedCreatorSignature instanceof Uint8Array)
		) {
			return failure("RECORD_INVALID");
		}
		const floor = resolveCreatorAnchorTrustMaterial(input.floorTrust as CurrentAnchorTrust);
		const current =
			"currentTrust" in input ? resolveCreatorAnchorTrustMaterial(input.currentTrust as CurrentAnchorTrust) : undefined;
		const ref = decoded.commitQcRef as CreatorAuthorIssuanceFrontiersRef;
		if (
			floor === undefined ||
			("currentTrust" in input && current === undefined) ||
			(current !== undefined &&
				(current.objectId !== floor.objectId ||
					current.genesisAnchorDigest !== floor.genesisAnchorDigest ||
					current.currentEpoch + 1 !== floor.currentEpoch ||
					current.currentAnchorDigest !== decoded.closedAnchorDigest ||
					current.currentEpoch !== decoded.closedEpoch ||
					compareBytes(current.publicKey, floor.publicKey) !== 0 ||
					decoded.currentAclDigest !== anchorAclDigest(current.exactCanonicalCurrentAnchorPreimageBytes))) ||
			decoded.objectId !== floor.objectId ||
			decoded.genesisAnchorDigest !== floor.genesisAnchorDigest ||
			decoded.successorEpoch !== floor.currentEpoch ||
			decoded.successorAnchorDigest !== floor.currentAnchorDigest ||
			decoded.successorAclDigest !== anchorAclDigest(floor.exactCanonicalCurrentAnchorPreimageBytes) ||
			decoded.currentAclDigest !== input.expectedCurrentAclDigest ||
			decoded.successorAclDigest !== input.expectedSuccessorAclDigest ||
			decoded.cutValueDigest !== input.expectedCutValueDigest ||
			decoded.snapshotManifestDigest !== input.expectedSnapshotManifestDigest ||
			!validRef(input.expectedCommitQcRef) ||
			ref.byteLength !== input.expectedCommitQcRef.byteLength ||
			ref.digest !== input.expectedCommitQcRef.digest
		) {
			return failure("IDENTITY_INVALID");
		}
		const { detachedCreatorSignature: signature, ...preimage } = decoded;
		const digest = hashDomain(DOMAIN, encodeCanonical(preimage));
		if (signature.byteLength !== 64 || !ed25519.verify(signature, digest, floor.publicKey, { zip215: false })) {
			return failure("SIGNATURE_INVALID");
		}
		const capability = Object.freeze({}) as VerifiedCreatorAuthorIssuanceFrontiers;
		verified.set(capability, identity(decoded));
		return Object.freeze({ capability, ok: true as const });
	} catch {
		return failure("MALFORMED_INPUT");
	}
}

/**
 * Resolves detached verified identity from a genuine opaque frontier capability.
 * @param capability - Capability returned by openCreatorAuthorIssuanceFrontiers.
 * @returns A detached frozen identity or undefined for foreign custody.
 */
export function resolveCreatorAuthorIssuanceFrontiers(
	capability: VerifiedCreatorAuthorIssuanceFrontiers
): CreatorAuthorIssuanceFrontiersIdentity | undefined {
	const selected = verified.get(capability);
	return selected === undefined ? undefined : copiedIdentity(selected);
}

export const CREATOR_AUTHOR_SETTLEMENT_KIND = "drp-creator-author-settlement-state" as const;
export const CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES = 32_768 as const;
export const CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL = hex(
	hashDomain(
		"ts-drp/creator-author-settlement/genesis/v1",
		encodeCanonical({ kind: "drp-creator-author-settlement-genesis", version: 1 })
	)
);

const SETTLEMENT_DOMAIN = "ts-drp/creator-author-settlement/v1";
const SETTLEMENT_PREIMAGE_KEYS = Object.freeze([
	"closedAnchorDigest",
	"closedEpoch",
	"commitQcRef",
	"currentAclDigest",
	"cutValueDigest",
	"frontiers",
	"genesisAnchorDigest",
	"historyRoot",
	"historySize",
	"kind",
	"objectId",
	"priorCheckpointDigest",
	"priorCheckpointKind",
	"protocolMajor",
	"snapshotManifestDigest",
	"successorAclDigest",
	"successorAnchorDigest",
	"successorEpoch",
	"version",
] as const);
const SETTLEMENT_RECORD_KEYS = Object.freeze([...SETTLEMENT_PREIMAGE_KEYS, "detachedAuthoritySignature"] as const);
const SETTLEMENT_PREPARE_KEYS = Object.freeze([
	"commitQcRef",
	"currentAclDigest",
	"currentTrust",
	"cutValueDigest",
	"frontiers",
	"historyRoot",
	"historySize",
	"priorCheckpointDigest",
	"priorCheckpointKind",
	"snapshotManifestDigest",
	"successorAclDigest",
	"successorTrust",
] as const);

export type CreatorAuthorSettlementFrontier = readonly [
	author: string,
	admissionEpoch: number,
	terminalThrough: number | null,
];

export interface CreatorAuthorSettlementIdentity {
	readonly closedAnchorDigest: string;
	readonly closedEpoch: number;
	readonly commitQcRef: CreatorAuthorIssuanceFrontiersRef;
	readonly currentAclDigest: string;
	readonly cutValueDigest: string;
	readonly frontiers: readonly CreatorAuthorSettlementFrontier[];
	readonly genesisAnchorDigest: string;
	readonly historyRoot: string;
	readonly historySize: number;
	readonly objectId: string;
	readonly priorCheckpointDigest: string;
	readonly priorCheckpointKind: "genesis" | "settled-v1";
	readonly snapshotManifestDigest: string;
	readonly successorAclDigest: string;
	readonly successorAnchorDigest: string;
	readonly successorEpoch: number;
}

export interface CreatorAuthorSettlementPreparation {
	readonly __creatorAuthorSettlementPreparation?: never;
}

export interface VerifiedCreatorAuthorSettlement {
	readonly __verifiedCreatorAuthorSettlement?: never;
}

interface SettlementPreparationState {
	readonly digest: Uint8Array;
	readonly preimage: Readonly<Record<string, unknown>>;
	readonly publicKey: Uint8Array;
}

const settlementPreparations = new WeakMap<CreatorAuthorSettlementPreparation, SettlementPreparationState>();
const verifiedSettlements = new WeakMap<VerifiedCreatorAuthorSettlement, CreatorAuthorSettlementIdentity>();

function exactSettlementFrontier(value: unknown): CreatorAuthorSettlementFrontier | undefined {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 3) return undefined;
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== 4 ||
		!keys.includes("0") ||
		!keys.includes("1") ||
		!keys.includes("2") ||
		!keys.includes("length")
	) {
		return undefined;
	}
	const [author, admissionEpoch, terminalThrough] = value;
	return typeof author === "string" &&
		DIGEST.test(author) &&
		safeSequence(admissionEpoch) &&
		(terminalThrough === null || safeSequence(terminalThrough))
		? Object.freeze([author, admissionEpoch, terminalThrough])
		: undefined;
}

function copiedSettlementFrontiers(value: unknown): readonly CreatorAuthorSettlementFrontier[] | undefined {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 256) return undefined;
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== value.length + 1 ||
		!keys.includes("length") ||
		value.some((_entry, index) => !keys.includes(String(index)))
	) {
		return undefined;
	}
	const output: CreatorAuthorSettlementFrontier[] = [];
	let previous: string | undefined;
	for (const entry of value) {
		const selected = exactSettlementFrontier(entry);
		if (selected === undefined || (previous !== undefined && selected[0] <= previous)) return undefined;
		previous = selected[0];
		output.push(selected);
	}
	return Object.freeze(output);
}

function validSettlementRecordFields(record: Readonly<Record<string, unknown>>): boolean {
	return (
		record.kind === CREATOR_AUTHOR_SETTLEMENT_KIND &&
		record.protocolMajor === 3 &&
		record.version === 1 &&
		typeof record.objectId === "string" &&
		OBJECT_ID.test(record.objectId) &&
		typeof record.genesisAnchorDigest === "string" &&
		DIGEST.test(record.genesisAnchorDigest) &&
		safeSequence(record.closedEpoch) &&
		typeof record.closedAnchorDigest === "string" &&
		DIGEST.test(record.closedAnchorDigest) &&
		safeSequence(record.successorEpoch) &&
		record.successorEpoch === record.closedEpoch + 1 &&
		typeof record.successorAnchorDigest === "string" &&
		DIGEST.test(record.successorAnchorDigest) &&
		typeof record.currentAclDigest === "string" &&
		DIGEST.test(record.currentAclDigest) &&
		typeof record.successorAclDigest === "string" &&
		DIGEST.test(record.successorAclDigest) &&
		typeof record.cutValueDigest === "string" &&
		DIGEST.test(record.cutValueDigest) &&
		validRef(record.commitQcRef) &&
		typeof record.snapshotManifestDigest === "string" &&
		DIGEST.test(record.snapshotManifestDigest) &&
		typeof record.historyRoot === "string" &&
		DIGEST.test(record.historyRoot) &&
		safeSequence(record.historySize) &&
		typeof record.priorCheckpointDigest === "string" &&
		DIGEST.test(record.priorCheckpointDigest) &&
		(record.priorCheckpointKind === "genesis" || record.priorCheckpointKind === "settled-v1") &&
		copiedSettlementFrontiers(record.frontiers) !== undefined
	);
}

function settlementIdentity(record: Readonly<Record<string, unknown>>): CreatorAuthorSettlementIdentity {
	const ref = record.commitQcRef as CreatorAuthorIssuanceFrontiersRef;
	return Object.freeze({
		closedAnchorDigest: record.closedAnchorDigest as string,
		closedEpoch: record.closedEpoch as number,
		commitQcRef: Object.freeze({ byteLength: ref.byteLength, digest: ref.digest }),
		currentAclDigest: record.currentAclDigest as string,
		cutValueDigest: record.cutValueDigest as string,
		frontiers: copiedSettlementFrontiers(record.frontiers) as readonly CreatorAuthorSettlementFrontier[],
		genesisAnchorDigest: record.genesisAnchorDigest as string,
		historyRoot: record.historyRoot as string,
		historySize: record.historySize as number,
		objectId: record.objectId as string,
		priorCheckpointDigest: record.priorCheckpointDigest as string,
		priorCheckpointKind: record.priorCheckpointKind as "genesis" | "settled-v1",
		snapshotManifestDigest: record.snapshotManifestDigest as string,
		successorAclDigest: record.successorAclDigest as string,
		successorAnchorDigest: record.successorAnchorDigest as string,
		successorEpoch: record.successorEpoch as number,
	});
}

function copiedSettlementIdentity(value: CreatorAuthorSettlementIdentity): CreatorAuthorSettlementIdentity {
	return Object.freeze({
		...value,
		commitQcRef: Object.freeze({ ...value.commitQcRef }),
		frontiers: Object.freeze(
			value.frontiers.map((entry) => Object.freeze([...entry])) as CreatorAuthorSettlementFrontier[]
		),
	});
}

/**
 * Prepares a successor-authority-signed settlement checkpoint.
 * @param input - Exact close bindings, adjacent trusts and successor frontier.
 * @returns An opaque one-shot signing preparation or a fail-closed rejection.
 */
export function prepareCreatorAuthorSettlement(input: unknown): Readonly<
	| { readonly ok: false; readonly reason: string }
	| {
			readonly digest: string;
			readonly exactCanonicalPreimageBytes: Uint8Array;
			readonly ok: true;
			readonly preparation: CreatorAuthorSettlementPreparation;
			readonly signingRequest: CreatorIssuanceRetirementSigningRequest;
	  }
> {
	try {
		if (!plainRecord(input) || !exactKeys(input, SETTLEMENT_PREPARE_KEYS)) return failure("MALFORMED_INPUT");
		const currentTrust = input.currentTrust as CurrentAnchorTrust;
		const successorTrust = input.successorTrust as CurrentAnchorTrust;
		const current = resolveCreatorAnchorTrustMaterial(currentTrust);
		const successor = resolveCreatorAnchorTrustMaterial(successorTrust);
		const frontiers = copiedSettlementFrontiers(input.frontiers);
		if (
			current === undefined ||
			successor === undefined ||
			frontiers === undefined ||
			settlementProfileFor(currentTrust.profileId) !== "v1" ||
			settlementProfileFor(successorTrust.profileId) !== "v1" ||
			current.objectId !== successor.objectId ||
			current.genesisAnchorDigest !== successor.genesisAnchorDigest ||
			successor.currentEpoch !== current.currentEpoch + 1 ||
			input.currentAclDigest !== anchorAclDigest(current.exactCanonicalCurrentAnchorPreimageBytes) ||
			input.successorAclDigest !== anchorAclDigest(successor.exactCanonicalCurrentAnchorPreimageBytes)
		) {
			return failure("TRUST_INVALID");
		}
		const preimage = Object.freeze({
			closedAnchorDigest: current.currentAnchorDigest,
			closedEpoch: current.currentEpoch,
			commitQcRef: plainRecord(input.commitQcRef)
				? Object.freeze({ byteLength: input.commitQcRef.byteLength, digest: input.commitQcRef.digest })
				: input.commitQcRef,
			currentAclDigest: input.currentAclDigest,
			cutValueDigest: input.cutValueDigest,
			frontiers,
			genesisAnchorDigest: current.genesisAnchorDigest,
			historyRoot: input.historyRoot,
			historySize: input.historySize,
			kind: CREATOR_AUTHOR_SETTLEMENT_KIND,
			objectId: current.objectId,
			priorCheckpointDigest: input.priorCheckpointDigest,
			priorCheckpointKind: input.priorCheckpointKind,
			protocolMajor: 3,
			snapshotManifestDigest: input.snapshotManifestDigest,
			successorAclDigest: input.successorAclDigest,
			successorAnchorDigest: successor.currentAnchorDigest,
			successorEpoch: successor.currentEpoch,
			version: 1,
		});
		if (!validSettlementRecordFields(preimage)) return failure("IDENTITY_INVALID");
		const exactCanonicalPreimageBytes = encodeCanonical(preimage);
		if (
			encodeCanonical({ ...preimage, detachedAuthoritySignature: new Uint8Array(64) }).byteLength >
			CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES
		) {
			return failure("RECORD_TOO_LARGE");
		}
		const digest = hashDomain(SETTLEMENT_DOMAIN, exactCanonicalPreimageBytes);
		const preparation = Object.freeze({}) as CreatorAuthorSettlementPreparation;
		settlementPreparations.set(
			preparation,
			Object.freeze({ digest: Uint8Array.from(digest), preimage, publicKey: Uint8Array.from(successor.publicKey) })
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
 * Completes and bounds a prepared settlement checkpoint.
 * @param input - Opaque preparation and detached successor-authority signature.
 * @returns Exact canonical record bytes or a fail-closed rejection.
 */
export function completeCreatorAuthorSettlement(
	input: unknown
): Readonly<
	| { readonly exactCanonicalRecordBytes: Uint8Array; readonly ok: true }
	| { readonly ok: false; readonly reason: string }
> {
	try {
		if (!plainRecord(input) || !exactKeys(input, ["detachedSignature", "preparation"])) {
			return failure("MALFORMED_INPUT");
		}
		const state = settlementPreparations.get(input.preparation as CreatorAuthorSettlementPreparation);
		settlementPreparations.delete(input.preparation as CreatorAuthorSettlementPreparation);
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
			detachedAuthoritySignature: signature,
		});
		return exactCanonicalRecordBytes.byteLength > CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES
			? failure("RECORD_TOO_LARGE")
			: Object.freeze({ exactCanonicalRecordBytes: Uint8Array.from(exactCanonicalRecordBytes), ok: true as const });
	} catch {
		return failure("MALFORMED_INPUT");
	}
}

/**
 * Opens one exact settlement checkpoint using successor floor trust only.
 * @param input - Exact record bytes, expected bindings and successor floor trust.
 * @returns An opaque verified settlement capability or a fail-closed rejection.
 */
export function openCreatorAuthorSettlement(
	input: unknown
): Readonly<
	| { readonly capability: VerifiedCreatorAuthorSettlement; readonly ok: true }
	| { readonly ok: false; readonly reason: string }
> {
	try {
		if (
			!plainRecord(input) ||
			!exactKeys(input, OPEN_KEYS) ||
			!(input.exactCanonicalRecordBytes instanceof Uint8Array) ||
			input.exactCanonicalRecordBytes.byteLength > CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES
		) {
			return failure("MALFORMED_INPUT");
		}
		const bytes = Uint8Array.from(input.exactCanonicalRecordBytes);
		const decoded = decodeCanonical(bytes, {
			maxBytes: CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES,
			maxDepth: 4,
			maxItems: 4096,
		});
		if (
			!plainRecord(decoded) ||
			!exactKeys(decoded, SETTLEMENT_RECORD_KEYS) ||
			compareBytes(encodeCanonical(decoded), bytes) !== 0 ||
			!validSettlementRecordFields(decoded) ||
			!(decoded.detachedAuthoritySignature instanceof Uint8Array)
		) {
			return failure("RECORD_INVALID");
		}
		const floorTrust = input.floorTrust as CurrentAnchorTrust;
		const floor = resolveCreatorAnchorTrustMaterial(floorTrust);
		const ref = decoded.commitQcRef as CreatorAuthorIssuanceFrontiersRef;
		if (
			floor === undefined ||
			settlementProfileFor(floorTrust.profileId) !== "v1" ||
			decoded.objectId !== floor.objectId ||
			decoded.genesisAnchorDigest !== floor.genesisAnchorDigest ||
			decoded.successorEpoch !== floor.currentEpoch ||
			decoded.successorAnchorDigest !== floor.currentAnchorDigest ||
			decoded.successorAclDigest !== anchorAclDigest(floor.exactCanonicalCurrentAnchorPreimageBytes) ||
			decoded.currentAclDigest !== input.expectedCurrentAclDigest ||
			decoded.successorAclDigest !== input.expectedSuccessorAclDigest ||
			decoded.cutValueDigest !== input.expectedCutValueDigest ||
			decoded.snapshotManifestDigest !== input.expectedSnapshotManifestDigest ||
			!validRef(input.expectedCommitQcRef) ||
			ref.byteLength !== input.expectedCommitQcRef.byteLength ||
			ref.digest !== input.expectedCommitQcRef.digest
		) {
			return failure("IDENTITY_INVALID");
		}
		const { detachedAuthoritySignature: signature, ...preimage } = decoded;
		const digest = hashDomain(SETTLEMENT_DOMAIN, encodeCanonical(preimage));
		if (signature.byteLength !== 64 || !ed25519.verify(signature, digest, floor.publicKey, { zip215: false })) {
			return failure("SIGNATURE_INVALID");
		}
		const capability = Object.freeze({}) as VerifiedCreatorAuthorSettlement;
		verifiedSettlements.set(capability, settlementIdentity(decoded));
		return Object.freeze({ capability, ok: true as const });
	} catch {
		return failure("MALFORMED_INPUT");
	}
}

/**
 * Resolves a detached identity from a genuine settlement capability.
 * @param capability - Capability returned by openCreatorAuthorSettlement.
 * @returns A detached frozen identity or undefined for foreign custody.
 */
export function resolveCreatorAuthorSettlement(
	capability: VerifiedCreatorAuthorSettlement
): CreatorAuthorSettlementIdentity | undefined {
	const selected = verifiedSettlements.get(capability);
	return selected === undefined ? undefined : copiedSettlementIdentity(selected);
}

/**
 * Returns a detached frontier for one author without exposing codec custody.
 * @param capability - Capability returned by openCreatorAuthorSettlement.
 * @param author - Lowercase author-key digest to select.
 * @returns A detached frontier or undefined when absent or foreign.
 */
export function frontierFor(
	capability: VerifiedCreatorAuthorSettlement,
	author: string
): CreatorAuthorSettlementFrontier | undefined {
	const selected = verifiedSettlements.get(capability)?.frontiers.find((frontier) => frontier[0] === author);
	return selected === undefined ? undefined : (Object.freeze([...selected]) as CreatorAuthorSettlementFrontier);
}

/**
 * Returns the number of frontiers in a genuine settlement capability.
 * @param capability - Capability returned by openCreatorAuthorSettlement.
 * @returns The verified frontier count, or zero for foreign custody.
 */
export function frontierCount(capability: VerifiedCreatorAuthorSettlement): number {
	return verifiedSettlements.get(capability)?.frontiers.length ?? 0;
}
