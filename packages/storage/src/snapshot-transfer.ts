import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES } from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import { decodeSnapshotManifest, snapshotChunkDigest } from "@ts-drp/protocol-v3/snapshot-transfer";

import { AHE_BOUNDED_READ_LIMITS, type NativeReadReservation } from "./types.js";

export const SNAPSHOT_QUARANTINE_RETENTION_MS = 86_400_000 as const;

export interface SnapshotChunkDescriptor {
	readonly byteLength: number;
	readonly digest: string;
	readonly index: number;
}

export interface SnapshotQuarantineScopeKey {
	readonly anchor: string;
	readonly epoch: number;
	readonly manifestDigest: string;
	readonly objectId: string;
}

export interface SnapshotQuarantineDeclaration {
	readonly chunks: readonly SnapshotChunkDescriptor[];
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly scope: SnapshotQuarantineScopeKey;
	readonly totalBytes: number;
}

export interface SnapshotQuarantinePort {
	discard(): Promise<void>;
	read(descriptor: SnapshotChunkDescriptor): Promise<Uint8Array | undefined>;
	write(descriptor: SnapshotChunkDescriptor, exactBytes: Uint8Array): Promise<void>;
}

export interface SnapshotVerificationQuarantine {
	open(signal: AbortSignal): SnapshotQuarantinePort;
}

export type SnapshotVerificationReceipt = Readonly<Record<never, never>>;

export type VerifiedSnapshotQuarantineReference = Readonly<{
	readonly chunkCount: number;
	readonly exactByteLength: number;
	readonly scope: SnapshotQuarantineScopeKey;
}>;

export type SnapshotQuarantineStatus = Readonly<{
	readonly expiresAt: number;
	readonly kind: "open" | "poisoned" | "verified";
	readonly missingIndices: readonly number[];
	readonly retention: SnapshotRetention;
}>;

export interface SnapshotQuarantineScope<Receipt extends object> {
	readonly scope: SnapshotQuarantineScopeKey;
	readonly verificationQuarantine: SnapshotVerificationQuarantine;
	cancel(options?: Readonly<{ readonly signal?: AbortSignal }>): Promise<void>;
	complete(
		receipt: Receipt,
		options?: Readonly<{ readonly signal?: AbortSignal }>
	): Promise<VerifiedSnapshotQuarantineReference>;
	missingIndices(options?: Readonly<{ readonly signal?: AbortSignal }>): Promise<readonly number[]>;
	release(): Promise<void>;
	retainForRecovery(options?: SnapshotRecoveryRetentionOptions): Promise<void>;
	status(options?: Readonly<{ readonly signal?: AbortSignal }>): Promise<SnapshotQuarantineStatus>;
}

export interface SnapshotQuarantineStore<Receipt extends object> {
	close(): Promise<void>;
	inspectRecovery(
		declaration: SnapshotQuarantineDeclaration,
		options?: Readonly<{ readonly signal?: AbortSignal }>
	): Promise<SnapshotRecoveryInspection>;
	recoveryStatus(options?: Readonly<{ readonly signal?: AbortSignal }>): Promise<SnapshotRecoveryOwnerStatus>;
	openScope(
		declaration: SnapshotQuarantineDeclaration,
		options?: Readonly<{ readonly signal?: AbortSignal }>
	): Promise<SnapshotQuarantineScope<Receipt>>;
	sweepExpired(options?: Readonly<{ readonly signal?: AbortSignal }>): Promise<number>;
}

export interface SnapshotRecoveryLimits {
	readonly maxRecoveryScopes: number;
	readonly maxRecoveryContentBytes: number;
}
export interface SnapshotRecoveryDeclarationReader {
	lookupRecoveryDeclaration(
		scope: SnapshotQuarantineScopeKey,
		options?: Readonly<{ readonly signal?: AbortSignal }>
	): Promise<SnapshotRecoveryDeclarationLookup>;
}
export interface SnapshotRecoveryStore<Receipt extends object>
	extends SnapshotQuarantineStore<Receipt>,
		SnapshotRecoveryDeclarationReader {
	lookupReceivedRecoveryCertificate(
		input: SnapshotRecoverySelector
	): Promise<SnapshotReceivedRecoveryCertificate | null>;
	/** Mechanical native frontier only; original authenticated role custody owns eligibility. */
	acquireRetirementControl?(input: Readonly<{ objectId: string }>): Promise<SnapshotRetirementControlRead>;
	/** Noncreating exact point read through original native custody; never protocol permission. */
	readRetirementImage?(input: Readonly<{ objectId: string }>): Promise<SnapshotRetirementImageObservation>;
	/** Complete noncreating admission observation, including an absent object/control; never retirement permission. */
	readRetirementAdmissionImage?(input: Readonly<{ objectId: string }>): Promise<SnapshotRetirementImageObservation>;
	acquireRecoveryRead(
		declaration: SnapshotQuarantineDeclaration,
		options?: Readonly<{ signal?: AbortSignal }>
	): Promise<SnapshotRecoveryReadAcquisition>;
	/** Explicit dependency lifetime, separate from observational recovery reads. */
	acquireRecoveryDependencyProtection?(
		scope: SnapshotQuarantineScopeKey
	): Promise<Readonly<{ kind: "unsupported" }> | Readonly<{ kind: "held"; protection: SnapshotRecoveryProtection }>>;
	/** Nonblocking exclusion of the exact classified retirement subset. */
	acquireRecoveryRetirementExclusion?(
		input: Readonly<{ scopes: readonly SnapshotQuarantineScopeKey[] }>
	): Promise<SnapshotRecoveryProtection>;
	/** Native, single-use inventory custody; optional for non-native borrowed ports. */
	captureRecoveryRoleInventory?(
		input: Readonly<{ objectId: string }>,
		options?: Readonly<{ signal?: AbortSignal }>
	): Promise<SnapshotRecoveryRoleInventory>;
	/** Trusted storage command; room callers never supply this protection union. */
	reconcileRecoveryRoles?(
		input: Readonly<{
			custody: object;
			protectedScopes: readonly SnapshotQuarantineScopeKey[];
			retirementDecision?: object;
		}>,
		options?: Readonly<{ signal?: AbortSignal }>
	): Promise<SnapshotRecoveryRoleReceipt>;
}
export type SnapshotRecoveryProtection = NativeReadReservation;
export interface SnapshotRetirementPreparation {
	readonly decisionDigest: string;
	readonly sourceProofDigest: string;
	readonly throughEpoch: number;
	readonly protectedScopes: readonly Readonly<{ scope: SnapshotQuarantineScopeKey; incarnation: string }>[];
}
export interface SnapshotRetirementControl {
	readonly kind: "snapshot-retirement-control-1";
	readonly objectId: string;
	readonly incarnation: string;
	readonly revision: number;
	readonly sequence: number;
	readonly active: Readonly<{ sequence: number; preparation: SnapshotRetirementPreparation }> | null;
	readonly completed: SnapshotRetirementPreparation | null;
}
export interface SnapshotRetirementImage {
	readonly imageDigest: string;
	readonly scopeCount: number;
	readonly chunkCount: number;
	readonly metadataBytes: number;
	readonly scopes: readonly Readonly<{ scope: SnapshotQuarantineScopeKey; incarnation: string }>[];
}
export interface SnapshotRetirementImageObservation {
	readonly control: SnapshotRetirementControl | null;
	readonly image: SnapshotRetirementImage;
	/** Mechanical reversal of only the pending intent's exact role changes.
	 * The authenticated planner must compare this with the completed original P. */
	readonly classificationSource?: SnapshotRetirementImage;
}
export interface SnapshotRetirementControlRead {
	readonly control: SnapshotRetirementControl;
	readonly image: SnapshotRetirementImage;
	prepareFence(input: SnapshotRetirementPreparation): Promise<SnapshotRetirementControl>;
	abortPrepared(
		input: Readonly<{ decisionDigest: string; sourceProofDigest: string }>
	): Promise<SnapshotRetirementControl>;
	commitPrepared(
		input: Readonly<{ decisionDigest: string; sourceProofDigest: string }>
	): Promise<SnapshotRetirementControl>;
	release(): Promise<void>;
}
export interface SnapshotRecoveryRoleInventory {
	readonly custody: Readonly<Record<never, never>>;
	readonly scopes: readonly Readonly<{
		scope: SnapshotQuarantineScopeKey;
		incarnation: string;
		contentBytes: number;
		retirement?: SnapshotRecoveryRoleRetirementFact;
	}>[];
	/** Read-only migration debt, never a recovery role or eligibility grant. */
	readonly legacyScopes?: readonly Readonly<{
		scope: SnapshotQuarantineScopeKey;
		incarnation: string;
		contentBytes: number;
		state: "open" | "poisoned" | "verified";
		expiresAt: number;
	}>[];
	readonly owner: SnapshotRecoveryOwnerStatus;
}
export interface SnapshotRecoveryRoleRetirementFact {
	readonly kind: "creator-snapshot-recovery-retirement";
	readonly version: 1;
	readonly certificateDigest: string;
	readonly currentHead: Readonly<{ objectId: string; epoch: number; currentAnchorDigest: string }>;
	readonly survivor: Readonly<{ scope: SnapshotQuarantineScopeKey; incarnation: string }>;
	readonly retired: readonly Readonly<{ scope: SnapshotQuarantineScopeKey; incarnation: string }>[];
}
export interface SnapshotRecoveryRoleRetirementDecision {
	readonly certificateDigest: string;
	readonly currentHead: SnapshotRecoveryRoleRetirementFact["currentHead"];
	readonly survivorScope: SnapshotQuarantineScopeKey;
	/** Exact prior native control captured by the same authenticated turnover owner. */
	readonly priorRetirementControl?: SnapshotRetirementControl;
	/** No-deletion variant minted by the same authenticated role owner after
	 * original cross-store intent completion. A receipt or copied fields are not authority. */
	readonly classification?: Readonly<{
		phase: "apply" | "confirm";
		decisionDigest: string;
		sourceProofDigest: string;
		throughEpoch: number;
		expectedImageDigest: string;
		protectedScopes: readonly Readonly<{ scope: SnapshotQuarantineScopeKey; incarnation: string }>[];
	}>;
}
export interface SnapshotRecoveryRoleReceipt {
	readonly retiredScopes: readonly SnapshotQuarantineScopeKey[];
	readonly recoveryScopes: number;
	readonly recoveryContentBytes: number;
}
export interface SnapshotRecoveryRetentionOptions {
	readonly signal?: AbortSignal;
	readonly exactReceivedCertificateBytes?: Uint8Array;
}
export interface SnapshotRecoverySelector {
	readonly objectId: string;
	readonly epoch: number;
	readonly anchor: string;
}
export interface SnapshotReceivedRecoveryCertificate {
	readonly scope: SnapshotQuarantineScopeKey;
	readonly incarnation: string;
	readonly exactReceivedCertificateBytes: Uint8Array;
}

// A custody envelope ceiling derived from existing component schema maxima, not
// an admission-policy increase or any executed workload. Inner bytes confer no trust.
const historyCeiling = encodeCanonical({
	kind: "creator-close-history-1",
	cutValueDigest: "0".repeat(64),
	compactHistory: {
		size: Number.MAX_SAFE_INTEGER,
		peaks: Array.from({ length: Number.MAX_SAFE_INTEGER.toString(2).length }, () => new Uint8Array(32)),
	},
}).byteLength;
export const SNAPSHOT_RECEIVED_CERTIFICATE_MAX_BYTES = encodeCanonical(
	{
		kind: "creator-received-recovery-certificate-1",
		pinnedGenesisAnchorDigest: "0".repeat(64),
		exactCanonicalOldHeadBytes: new Uint8Array(AHE_BOUNDED_READ_LIMITS.maxHeadBytes),
		currentTrustRef: { digest: "0".repeat(64), byteLength: AHE_BOUNDED_READ_LIMITS.maxBlobBytes },
		exactCanonicalCutValueBytes: new Uint8Array(AHE_BOUNDED_READ_LIMITS.maxBlobBytes),
		exactCanonicalCommitQcBytes: new Uint8Array(AHE_BOUNDED_READ_LIMITS.maxBlobBytes),
		exactCanonicalTrustStateRecordBytes: new Uint8Array(AHE_BOUNDED_READ_LIMITS.maxBlobBytes),
		exactCanonicalSettlementBytes: new Uint8Array(CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES),
		exactCanonicalHistoryBytes: new Uint8Array(historyCeiling),
		sealedReplayDigest: "0".repeat(64),
		sealedReplayRowCount: Number.MAX_SAFE_INTEGER,
		sealedReplayByteCharge: Number.MAX_SAFE_INTEGER,
		candidateGenerationId: "0".repeat(64),
		candidateClosureDigest: "0".repeat(64),
	},
	{ maxDepth: 2, maxItems: 64 }
).byteLength;
export const SNAPSHOT_RECEIVED_CERTIFICATE_WRAPPER_MAX_BYTES = encodeCanonical(
	{
		incarnation: "0".repeat(36),
		exactReceivedCertificateBytes: new Uint8Array(SNAPSHOT_RECEIVED_CERTIFICATE_MAX_BYTES),
	},
	{ maxDepth: 2, maxItems: 64 }
).byteLength;
export interface SnapshotRecoveryChunkReader {
	read(
		descriptor: SnapshotChunkDescriptor,
		options?: Readonly<{ signal?: AbortSignal }>
	): Promise<Uint8Array | undefined>;
	release(): Promise<void>;
}
export type SnapshotRecoveryReadAcquisition =
	| Readonly<{ kind: "missing" }>
	| Readonly<{
			kind: "present";
			declaration: SnapshotQuarantineDeclaration;
			state: "open" | "verified";
			retention: SnapshotRetention;
			expiresAt: number;
			reader: SnapshotRecoveryChunkReader;
	  }>;
export type SnapshotRecoveryDeclarationLookup =
	| Readonly<{ kind: "missing" }>
	| Readonly<{
			kind: "present";
			declaration: SnapshotQuarantineDeclaration;
			state: "open" | "poisoned" | "verified";
			retention: SnapshotRetention;
			expiresAt: number;
	  }>;
export type SnapshotRetention = "temporary" | "recovery" | "legacy-unclassified";
export type SnapshotRecoveryInspection =
	| Readonly<{ kind: "missing" }>
	| Readonly<{ kind: "present"; status: SnapshotQuarantineStatus & { readonly retention: SnapshotRetention } }>;
export interface SnapshotRecoveryOwnerStatus {
	/** Pending native classification readback, associated with the SAME original
	 * completed R4 intent. Presence keeps write admission closed even at zero debt. */
	readonly classificationIntent?: Readonly<{
		objectId: string;
		decisionDigest: string;
		sourceProofDigest: string;
		promoted: readonly Readonly<{ scope: SnapshotQuarantineScopeKey; incarnation: string; contentBytes: number }>[];
	}>;
	readonly limits: SnapshotRecoveryLimits;
	readonly recoveryScopes: number;
	readonly recoveryContentBytes: number;
	readonly legacyUnclassifiedScopes: number;
	readonly legacyUnclassifiedContentBytes: number;
	readonly migration: "ready" | "classification-required";
}
export type SnapshotQuarantineFailureCode =
	| "aborted"
	| "closed"
	| "conflict"
	| "expired"
	| "incomplete"
	| "invalid-carrier"
	| "malformed-input"
	| "poisoned"
	| "receipt-invalid"
	| "recovery-full"
	| "temporary-full"
	| "recovery-owned"
	| "storage-failed"
	| "unsupported-schema"
	| "policy-mismatch"
	| "migration-required"
	| "stale-scope";

type CapturedDeclaration = Readonly<{
	readonly chunks: readonly SnapshotChunkDescriptor[];
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly scope: SnapshotQuarantineScopeKey;
	readonly totalBytes: number;
}>;

const MAX_MANIFEST_BYTES = 212_387;
const MAX_CHUNKS = 2_048;
const MAX_BYTES = 268_435_456;
const MAX_TEMPORARY_SCOPES = 32;
const intrinsicArrayBufferPrototype = ArrayBuffer.prototype;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicReflectApply = Reflect.apply;
const intrinsicTypedArrayPrototype = intrinsicObjectGetPrototypeOf(Uint8Array.prototype);
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
const intrinsicArrayBufferByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBufferPrototype,
	"byteLength"
)?.get as (this: ArrayBuffer) => number;
const intrinsicArrayBufferResizableGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBufferPrototype,
	"resizable"
)?.get as ((this: ArrayBuffer) => boolean) | undefined;
const intrinsicUint8Array = Uint8Array;
const intrinsicUint8ArrayPrototype = Uint8Array.prototype;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;
const intrinsicTextEncoder = TextEncoder;

class QuarantineError extends Error {
	readonly code: SnapshotQuarantineFailureCode;

	constructor(code: SnapshotQuarantineFailureCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.code = code;
	}
}

function failure(code: SnapshotQuarantineFailureCode, message: string, cause?: unknown): QuarantineError {
	return new QuarantineError(code, message, cause);
}

function exactRecord(value: unknown, fields: readonly string[]): value is Readonly<Record<string, unknown>> {
	return (
		value !== null &&
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype &&
		Reflect.ownKeys(value).length === fields.length &&
		fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
	);
}

function exactBytes(value: unknown, label: string, maximum: number): Uint8Array {
	try {
		if (intrinsicObjectGetPrototypeOf(value) !== intrinsicUint8ArrayPrototype) throw new TypeError();
		const byteLength = intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, value, []);
		const byteOffset = intrinsicReflectApply(intrinsicTypedArrayByteOffsetGetter, value, []);
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, value, []);
		if (intrinsicObjectGetPrototypeOf(buffer) !== intrinsicArrayBufferPrototype) throw new TypeError();
		const bufferByteLength = intrinsicReflectApply(intrinsicArrayBufferByteLengthGetter, buffer, []);
		const resizable =
			intrinsicArrayBufferResizableGetter === undefined
				? false
				: intrinsicReflectApply(intrinsicArrayBufferResizableGetter, buffer, []);
		if (byteLength <= 0 || byteOffset !== 0 || byteLength !== bufferByteLength || byteLength > maximum || resizable) {
			throw new TypeError();
		}
		const copy = new intrinsicUint8Array(byteLength);
		intrinsicReflectApply(intrinsicUint8ArraySet, copy, [value]);
		return copy;
	} catch (error) {
		throw failure("invalid-carrier", `${label} carrier is invalid`, error);
	}
}

function hex64(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function captureDataFields(
	value: unknown,
	allowed: readonly string[],
	required: readonly string[]
): Record<string, unknown> {
	try {
		if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
			throw new TypeError();
		const keys = Reflect.ownKeys(value);
		if (
			keys.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
			required.some((key) => !keys.includes(key))
		)
			throw new TypeError();
		const result: Record<string, unknown> = {};
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError();
			result[key as string] = descriptor.value;
		}
		return result;
	} catch (error) {
		throw failure("malformed-input", "snapshot recovery data fields are invalid", error);
	}
}
function captureRetentionOptions(value: unknown): SnapshotRecoveryRetentionOptions {
	const fields = captureDataFields(value, ["signal", "exactReceivedCertificateBytes"], []);
	const bytes = Object.hasOwn(fields, "exactReceivedCertificateBytes")
		? exactBytes(fields.exactReceivedCertificateBytes, "received certificate", SNAPSHOT_RECEIVED_CERTIFICATE_MAX_BYTES)
		: undefined;
	return Object.freeze({ signal: fields.signal as AbortSignal | undefined, exactReceivedCertificateBytes: bytes });
}
function captureRecoverySelector(value: unknown): SnapshotRecoverySelector {
	const fields = captureDataFields(value, ["objectId", "epoch", "anchor"], ["objectId", "epoch", "anchor"]);
	const scope = captureScope({ ...fields, manifestDigest: "0".repeat(64) });
	return Object.freeze({ objectId: scope.objectId, epoch: scope.epoch, anchor: scope.anchor });
}
function wrapReceivedCertificate(incarnation: string, bytes: Uint8Array): Uint8Array {
	if (typeof incarnation !== "string" || incarnation.length === 0 || incarnation.length > 36)
		throw failure("poisoned", "snapshot incarnation is invalid");
	return encodeCanonical(
		{ incarnation, exactReceivedCertificateBytes: bytes },
		{ maxBytes: SNAPSHOT_RECEIVED_CERTIFICATE_WRAPPER_MAX_BYTES, maxDepth: 2, maxItems: 64 }
	);
}
function openReceivedCertificate(incarnation: string, value: unknown): Uint8Array | null {
	if (value === null) return null;
	try {
		const bytes = exactBytes(value, "native received certificate", SNAPSHOT_RECEIVED_CERTIFICATE_WRAPPER_MAX_BYTES);
		const decoded = decodeCanonical(bytes, {
			maxBytes: SNAPSHOT_RECEIVED_CERTIFICATE_WRAPPER_MAX_BYTES,
			maxDepth: 2,
			maxItems: 64,
		});
		// The frozen canonical decoder creates null-prototype records. This is a
		// decoder-owned value, not an expansion of external selector/options capture.
		if (
			decoded === null ||
			typeof decoded !== "object" ||
			intrinsicObjectGetPrototypeOf(decoded) !== null ||
			Reflect.ownKeys(decoded).sort().join(",") !== "exactReceivedCertificateBytes,incarnation"
		)
			throw new TypeError("received certificate wrapper fields are invalid");
		const ownIncarnation = intrinsicObjectGetOwnPropertyDescriptor(decoded, "incarnation");
		const ownCertificate = intrinsicObjectGetOwnPropertyDescriptor(decoded, "exactReceivedCertificateBytes");
		if (
			!ownIncarnation?.enumerable ||
			!("value" in ownIncarnation) ||
			!ownCertificate?.enumerable ||
			!("value" in ownCertificate) ||
			ownIncarnation.value !== incarnation ||
			compareBytes(bytes, encodeCanonical(decoded)) !== 0
		)
			throw new TypeError("received certificate incarnation is invalid");
		return exactBytes(
			ownCertificate.value,
			"native received certificate evidence",
			SNAPSHOT_RECEIVED_CERTIFICATE_MAX_BYTES
		);
	} catch (error) {
		throw failure("poisoned", "snapshot received certificate wrapper is invalid", error);
	}
}

function captureScope(value: unknown): SnapshotQuarantineScopeKey {
	if (!exactRecord(value, ["anchor", "epoch", "manifestDigest", "objectId"])) {
		throw failure("malformed-input", "snapshot quarantine scope is malformed");
	}
	const { anchor, epoch, manifestDigest, objectId } = value;
	if (
		!hex64(anchor) ||
		typeof epoch !== "number" ||
		!Number.isSafeInteger(epoch) ||
		epoch < 0 ||
		!hex64(manifestDigest) ||
		typeof objectId !== "string" ||
		objectId.length === 0
	) {
		throw failure("malformed-input", "snapshot quarantine scope is malformed");
	}
	return Object.freeze({ anchor, epoch, manifestDigest, objectId });
}

function captureRecoveryDependencyScope(value: unknown): SnapshotQuarantineScopeKey {
	const scope = captureScope(
		captureDataFields(
			value,
			["anchor", "epoch", "manifestDigest", "objectId"],
			["anchor", "epoch", "manifestDigest", "objectId"]
		)
	);
	// The original manifest protocol admits object identifiers of at most 1024 characters.
	if (scope.objectId.length > 1024) throw failure("malformed-input", "snapshot dependency object is malformed");
	return scope;
}

function captureRecoveryRetirementScopes(value: unknown): readonly SnapshotQuarantineScopeKey[] {
	const fields = captureDataFields(value, ["scopes"], ["scopes"]);
	const array = fields.scopes;
	if (!Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype)
		throw failure("malformed-input", "snapshot retirement scopes are malformed");
	const length = Object.getOwnPropertyDescriptor(array, "length");
	if (
		length === undefined ||
		!("value" in length) ||
		!Number.isSafeInteger(length.value) ||
		length.value < 1 ||
		length.value > 4
	)
		throw failure("malformed-input", "snapshot retirement scopes exceed the recovery pool");
	const count = length.value as number;
	if (Reflect.ownKeys(array).length !== count + 1)
		throw failure("malformed-input", "snapshot retirement scopes have extra fields");
	const scopes: SnapshotQuarantineScopeKey[] = [];
	for (let index = 0; index < count; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
		if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
			throw failure("malformed-input", "snapshot retirement scope is not an own data field");
		scopes.push(captureRecoveryDependencyScope(descriptor.value));
	}
	const keyed = scopes.map((scope) => ({
		scope,
		key: JSON.stringify([scope.objectId, scope.epoch, scope.anchor, scope.manifestDigest]),
	}));
	keyed.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
	if (
		keyed.some((entry, index) => index > 0 && entry.key === keyed[index - 1]?.key) ||
		keyed.some((entry) => entry.scope.objectId !== keyed[0]?.scope.objectId)
	)
		throw failure("malformed-input", "snapshot retirement scopes are repeated or foreign");
	return Object.freeze(keyed.map((entry) => entry.scope));
}

function captureDescriptor(value: unknown, declaration?: SnapshotQuarantineDeclaration): SnapshotChunkDescriptor {
	if (!exactRecord(value, ["byteLength", "digest", "index"])) {
		throw failure("malformed-input", "snapshot chunk descriptor is malformed");
	}
	const { byteLength, digest, index } = value;
	if (
		typeof byteLength !== "number" ||
		!Number.isSafeInteger(byteLength) ||
		byteLength <= 0 ||
		byteLength > 131_072 ||
		!hex64(digest) ||
		typeof index !== "number" ||
		!Number.isSafeInteger(index) ||
		index < 0
	) {
		throw failure("malformed-input", "snapshot chunk descriptor is malformed");
	}
	if (declaration !== undefined) {
		const expected = declaration.chunks[index];
		if (expected === undefined || expected.byteLength !== byteLength || expected.digest !== digest)
			throw failure("malformed-input", "snapshot chunk descriptor is foreign to this reader");
	}
	return Object.freeze({ byteLength, digest, index });
}

function captureDeclaration(value: unknown): CapturedDeclaration {
	if (!exactRecord(value, ["chunks", "exactCanonicalManifestBytes", "scope", "totalBytes"])) {
		throw failure("malformed-input", "snapshot quarantine declaration is malformed");
	}
	if (!Array.isArray(value.chunks) || value.chunks.length === 0 || value.chunks.length > MAX_CHUNKS) {
		throw failure("malformed-input", "snapshot quarantine descriptor count is invalid");
	}
	const chunks = Object.freeze(value.chunks.map((descriptor) => captureDescriptor(descriptor)));
	for (let index = 0; index < chunks.length; index += 1) {
		if (chunks[index]?.index !== index) throw failure("malformed-input", "snapshot descriptors are not contiguous");
	}
	const sum = chunks.reduce((total, descriptor) => total + descriptor.byteLength, 0);
	if (
		typeof value.totalBytes !== "number" ||
		!Number.isSafeInteger(value.totalBytes) ||
		value.totalBytes <= 0 ||
		value.totalBytes > MAX_BYTES ||
		value.totalBytes !== sum
	) {
		throw failure("malformed-input", "snapshot quarantine totalBytes is invalid");
	}
	return Object.freeze({
		chunks,
		exactCanonicalManifestBytes: exactBytes(value.exactCanonicalManifestBytes, "snapshot manifest", MAX_MANIFEST_BYTES),
		scope: captureScope(value.scope),
		totalBytes: value.totalBytes,
	});
}

function captureRecoveryLimits(value: unknown): SnapshotRecoveryLimits {
	if (!exactRecord(value, ["maxRecoveryScopes", "maxRecoveryContentBytes"]))
		throw failure("malformed-input", "snapshot recovery limits are malformed");
	const { maxRecoveryScopes, maxRecoveryContentBytes } = value;
	if (
		typeof maxRecoveryScopes !== "number" ||
		!Number.isSafeInteger(maxRecoveryScopes) ||
		maxRecoveryScopes <= 0 ||
		typeof maxRecoveryContentBytes !== "number" ||
		!Number.isSafeInteger(maxRecoveryContentBytes) ||
		maxRecoveryContentBytes <= 0
	)
		throw failure("malformed-input", "snapshot recovery limits are invalid");
	return Object.freeze({ maxRecoveryScopes, maxRecoveryContentBytes });
}
function captureRecoveryRoleObject(value: unknown): string {
	if (!exactRecord(value, ["objectId"])) throw failure("malformed-input", "snapshot role object is malformed");
	return captureScope({ objectId: value.objectId, epoch: 0, anchor: "0".repeat(64), manifestDigest: "0".repeat(64) })
		.objectId;
}
function captureRecoveryRoleCustody(value: unknown): object {
	if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
		throw failure("invalid-carrier", "snapshot role inventory input is foreign or malformed");
	const descriptor = Object.getOwnPropertyDescriptor(value, "custody");
	if (
		descriptor === undefined ||
		!Object.hasOwn(descriptor, "value") ||
		descriptor.value === null ||
		typeof descriptor.value !== "object"
	)
		throw failure("invalid-carrier", "snapshot role inventory input is foreign or malformed");
	return descriptor.value as object;
}
function captureRecoveryRoleProtection(
	value: unknown
): Readonly<{ custody: object; protectedScopes: readonly SnapshotQuarantineScopeKey[]; retirementDecision?: object }> {
	if (
		!exactRecord(value, ["custody", "protectedScopes"]) &&
		!exactRecord(value, ["custody", "protectedScopes", "retirementDecision"])
	)
		throw failure("malformed-input", "snapshot role protection is malformed");
	const custody = captureRecoveryRoleCustody(value);
	if (
		!Array.isArray(value.protectedScopes) ||
		value.protectedScopes.length === 0 ||
		value.protectedScopes.length > 4 ||
		Reflect.ownKeys(value.protectedScopes).length !== value.protectedScopes.length + 1
	)
		throw failure("malformed-input", "snapshot role protection is malformed");
	const scopes = Array.from(value.protectedScopes, captureScope);
	if (new Set(scopes.map((scope) => JSON.stringify(scope))).size !== scopes.length)
		throw failure("malformed-input", "snapshot role protection repeats a scope");
	if (
		Object.hasOwn(value, "retirementDecision") &&
		(value.retirementDecision === null || typeof value.retirementDecision !== "object")
	)
		throw failure("invalid-carrier", "snapshot role retirement decision is invalid");
	return Object.freeze({
		custody,
		protectedScopes: Object.freeze(scopes),
		...(Object.hasOwn(value, "retirementDecision") ? { retirementDecision: value.retirementDecision as object } : {}),
	});
}
let recoveryRoleRetirementResolver:
	| ((
			decision: object,
			owner: object,
			custody: object,
			protectedScopes: readonly SnapshotQuarantineScopeKey[]
	  ) => unknown)
	| undefined;
Object.defineProperty(captureRecoveryRoleProtection, "installCreatorRecoveryRoleRetirementResolver", {
	configurable: false,
	enumerable: false,
	writable: false,
	value: function (this: unknown, resolver: unknown): boolean {
		if (
			this !== captureRecoveryRoleProtection ||
			recoveryRoleRetirementResolver !== undefined ||
			typeof resolver !== "function"
		)
			return false;
		recoveryRoleRetirementResolver = (decision, owner, custody, protectedScopes): unknown =>
			Reflect.apply(resolver, undefined, [decision, owner, custody, protectedScopes]);
		return true;
	},
});
function consumeRecoveryRoleRetirementDecision(
	decision: object,
	owner: object,
	custody: object,
	protectedScopes: readonly SnapshotQuarantineScopeKey[]
): SnapshotRecoveryRoleRetirementDecision {
	const value = recoveryRoleRetirementResolver?.(decision, owner, custody, protectedScopes);
	if (
		(!exactRecord(value, ["certificateDigest", "currentHead", "survivorScope"]) &&
			!exactRecord(value, ["certificateDigest", "currentHead", "survivorScope", "priorRetirementControl"]) &&
			!exactRecord(value, [
				"certificateDigest",
				"currentHead",
				"survivorScope",
				"priorRetirementControl",
				"classification",
			])) ||
		typeof value.certificateDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.certificateDigest) ||
		!exactRecord(value.currentHead, ["objectId", "epoch", "currentAnchorDigest"])
	)
		throw failure("invalid-carrier", "snapshot role retirement authority is foreign, copied or consumed");
	const scope = captureScope(value.survivorScope),
		head = value.currentHead;
	if (
		head.objectId !== scope.objectId ||
		head.epoch !== scope.epoch + 1 ||
		typeof head.currentAnchorDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(head.currentAnchorDigest)
	)
		throw failure("invalid-carrier", "snapshot role retirement authority is unbound");
	let classification: SnapshotRecoveryRoleRetirementDecision["classification"];
	if (Object.hasOwn(value, "classification")) {
		const proof = value.classification;
		if (
			!exactRecord(proof, [
				"phase",
				"decisionDigest",
				"sourceProofDigest",
				"throughEpoch",
				"expectedImageDigest",
				"protectedScopes",
			]) ||
			(proof.phase !== "apply" && proof.phase !== "confirm") ||
			typeof proof.decisionDigest !== "string" ||
			!/^[0-9a-f]{64}$/u.test(proof.decisionDigest) ||
			typeof proof.sourceProofDigest !== "string" ||
			!/^[0-9a-f]{64}$/u.test(proof.sourceProofDigest) ||
			typeof proof.expectedImageDigest !== "string" ||
			!/^[0-9a-f]{64}$/u.test(proof.expectedImageDigest) ||
			!Number.isSafeInteger(proof.throughEpoch) ||
			proof.throughEpoch !== head.epoch - 1 ||
			!Array.isArray(proof.protectedScopes) ||
			proof.protectedScopes.length < 1 ||
			proof.protectedScopes.length > 4
		)
			throw failure("invalid-carrier", "snapshot inherited classification is unbound");
		const pairs = proof.protectedScopes.map((pair: unknown) => {
			if (
				!exactRecord(pair, ["scope", "incarnation"]) ||
				typeof pair.incarnation !== "string" ||
				pair.incarnation.length < 1 ||
				new intrinsicTextEncoder().encode(pair.incarnation).byteLength > 36
			)
				throw failure("invalid-carrier", "snapshot inherited incarnation is unbound");
			return Object.freeze({ scope: captureScope(pair.scope), incarnation: pair.incarnation });
		});
		if (
			pairs.some((pair) => pair.scope.objectId !== scope.objectId) ||
			new Set(pairs.map((pair) => JSON.stringify(pair.scope))).size !== pairs.length ||
			pairs.length !== protectedScopes.length ||
			protectedScopes.some((selected) => !pairs.some((pair) => JSON.stringify(pair.scope) === JSON.stringify(selected)))
		)
			throw failure("invalid-carrier", "snapshot inherited protected union is incomplete");
		const control = retirementControl(value.priorRetirementControl),
			completed = control.completed;
		if (
			control.objectId !== scope.objectId ||
			control.active !== null ||
			completed === null ||
			completed.decisionDigest !== proof.decisionDigest ||
			completed.sourceProofDigest !== proof.sourceProofDigest ||
			completed.throughEpoch !== proof.throughEpoch ||
			pairs.some(
				(pair) =>
					pair.scope.epoch <= completed.throughEpoch &&
					!completed.protectedScopes.some((target) => JSON.stringify(target) === JSON.stringify(pair))
			)
		)
			throw failure("invalid-carrier", "snapshot inherited classification intent is not completed");
		classification = Object.freeze({
			phase: proof.phase,
			decisionDigest: proof.decisionDigest,
			sourceProofDigest: proof.sourceProofDigest,
			throughEpoch: proof.throughEpoch as number,
			expectedImageDigest: proof.expectedImageDigest,
			protectedScopes: Object.freeze(pairs),
		});
	}
	return Object.freeze({
		certificateDigest: value.certificateDigest,
		currentHead: Object.freeze({
			objectId: scope.objectId,
			epoch: head.epoch as number,
			currentAnchorDigest: head.currentAnchorDigest,
		}),
		survivorScope: scope,
		...(classification === undefined ? {} : { classification }),
		...(Object.hasOwn(value, "priorRetirementControl")
			? { priorRetirementControl: retirementControl(value.priorRetirementControl) }
			: {}),
	});
}
function captureRecoveryRoleRetirementFact(value: unknown): SnapshotRecoveryRoleRetirementFact {
	if (
		!exactRecord(value, ["kind", "version", "certificateDigest", "currentHead", "survivor", "retired"]) ||
		value.kind !== "creator-snapshot-recovery-retirement" ||
		value.version !== 1 ||
		!exactRecord(value.survivor, ["scope", "incarnation"]) ||
		!Array.isArray(value.retired) ||
		value.retired.length < 1 ||
		value.retired.length > 3 ||
		Reflect.ownKeys(value.retired).length !== value.retired.length + 1
	)
		throw failure("poisoned", "snapshot role retirement fact is malformed");
	const pair = (v: unknown): Readonly<{ scope: SnapshotQuarantineScopeKey; incarnation: string }> => {
		if (
			!exactRecord(v, ["scope", "incarnation"]) ||
			typeof v.incarnation !== "string" ||
			v.incarnation.length < 1 ||
			new intrinsicTextEncoder().encode(v.incarnation).byteLength > 36
		)
			throw failure("poisoned", "snapshot role retirement incarnation is malformed");
		return Object.freeze({ scope: captureScope(v.scope), incarnation: v.incarnation });
	};
	const survivor = pair(value.survivor),
		retired = value.retired.map(pair);
	if (
		typeof value.certificateDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.certificateDigest) ||
		!exactRecord(value.currentHead, ["objectId", "epoch", "currentAnchorDigest"]) ||
		value.currentHead.objectId !== survivor.scope.objectId ||
		value.currentHead.epoch !== survivor.scope.epoch + 1 ||
		typeof value.currentHead.currentAnchorDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.currentHead.currentAnchorDigest) ||
		retired.some(
			(row) => row.scope.objectId !== survivor.scope.objectId || row.scope.epoch >= survivor.scope.epoch - 1
		) ||
		new Set(retired.map((row) => JSON.stringify(row.scope))).size !== retired.length
	)
		throw failure("poisoned", "snapshot role retirement fact is unbound");
	return Object.freeze({
		kind: value.kind,
		version: 1,
		certificateDigest: value.certificateDigest,
		currentHead: Object.freeze({
			objectId: survivor.scope.objectId,
			epoch: value.currentHead.epoch as number,
			currentAnchorDigest: value.currentHead.currentAnchorDigest,
		}),
		survivor,
		retired: Object.freeze(retired),
	});
}

/** Mechanical application of an already authenticated, completed classification
 * permit. Inventory observations alone never reach this branch. No bytes retire. */
function recoveryClassificationAccounting(
	inventory: Omit<SnapshotRecoveryRoleInventory, "custody">,
	decision: SnapshotRecoveryRoleRetirementDecision,
	control: SnapshotRetirementControl | null
): Readonly<{
	owner: SnapshotRecoveryOwnerStatus;
	promoted: NonNullable<SnapshotRecoveryRoleInventory["legacyScopes"]>;
}> {
	const proof = decision.classification;
	if (
		proof === undefined ||
		control === null ||
		decision.priorRetirementControl === undefined ||
		compareBytes(encodeRetirementControl(control), encodeRetirementControl(decision.priorRetirementControl)) !== 0
	)
		throw failure("stale-scope", "snapshot inherited completed control changed");
	const legacy = inventory.legacyScopes ?? [],
		all = [...inventory.scopes, ...legacy];
	if (
		proof.protectedScopes.some(
			(pair) =>
				!all.some(
					(row) => row.incarnation === pair.incarnation && JSON.stringify(row.scope) === JSON.stringify(pair.scope)
				)
		)
	)
		throw failure("stale-scope", "snapshot inherited protected incarnation changed");
	const promoted = legacy.filter((row) =>
		proof.protectedScopes.some(
			(pair) => pair.incarnation === row.incarnation && JSON.stringify(pair.scope) === JSON.stringify(row.scope)
		)
	);
	const prior = inventory.owner.classificationIntent;
	const selected =
		proof.phase === "confirm"
			? prior?.promoted
			: promoted.map((row) =>
					Object.freeze({ scope: row.scope, incarnation: row.incarnation, contentBytes: row.contentBytes })
				);
	const pointer = Object.freeze({
		objectId: decision.currentHead.objectId,
		decisionDigest: proof.decisionDigest,
		sourceProofDigest: proof.sourceProofDigest,
		promoted: selected,
	});
	if (proof.phase === "confirm") {
		if (
			prior === undefined ||
			JSON.stringify(inventory.owner.classificationIntent) !== JSON.stringify(pointer) ||
			promoted.length !== 0
		)
			throw failure("stale-scope", "snapshot inherited SAME-intent readback is unavailable");
		const { classificationIntent: _pending, ...owner } = inventory.owner;
		return Object.freeze({
			promoted: Object.freeze([]),
			owner: Object.freeze({
				...owner,
				migration: owner.legacyUnclassifiedScopes === 0 ? "ready" : "classification-required",
			}),
		});
	}
	if (inventory.owner.classificationIntent !== undefined)
		throw failure("migration-required", "snapshot inherited prior intent requires authenticated readback");
	if (promoted.length === 0 || promoted.some((row) => row.state !== "verified"))
		throw failure("incomplete", "snapshot inherited protected bytes are not verified");
	const bytes = promoted.reduce((sum, row) => addRecoveryContentBytes(sum, row.contentBytes), 0);
	const recoveryScopes = addRecoveryContentBytes(inventory.owner.recoveryScopes, promoted.length),
		recoveryContentBytes = addRecoveryContentBytes(inventory.owner.recoveryContentBytes, bytes),
		legacyUnclassifiedScopes = inventory.owner.legacyUnclassifiedScopes - promoted.length,
		legacyUnclassifiedContentBytes = inventory.owner.legacyUnclassifiedContentBytes - bytes;
	if (
		!Number.isSafeInteger(legacyUnclassifiedScopes) ||
		legacyUnclassifiedScopes < 0 ||
		!Number.isSafeInteger(legacyUnclassifiedContentBytes) ||
		legacyUnclassifiedContentBytes < 0 ||
		(legacyUnclassifiedScopes === 0 && legacyUnclassifiedContentBytes !== 0)
	)
		throw failure("poisoned", "snapshot inherited accounting would underflow");
	if (
		recoveryScopes > inventory.owner.limits.maxRecoveryScopes ||
		recoveryContentBytes > inventory.owner.limits.maxRecoveryContentBytes
	)
		throw failure("recovery-full", "snapshot inherited protected union exceeds recovery entitlement");
	return Object.freeze({
		promoted: Object.freeze(promoted),
		owner: Object.freeze({
			...inventory.owner,
			recoveryScopes,
			recoveryContentBytes,
			legacyUnclassifiedScopes,
			legacyUnclassifiedContentBytes,
			classificationIntent: captureClassificationIntent(pointer),
			migration: "classification-required",
		}),
	});
}

// Five bounded object IDs (pointer + four scopes), worst-case JSON character
// escaping, four native incarnation strings, fixed digest/key/number overhead.
const MAX_CLASSIFICATION_INTENT_BYTES = 5 * 1024 * 6 + 4 * 36 * 6 + 4096;
function captureClassificationIntent(value: unknown): NonNullable<SnapshotRecoveryOwnerStatus["classificationIntent"]> {
	if (
		!exactRecord(value, ["objectId", "decisionDigest", "sourceProofDigest", "promoted"]) ||
		typeof value.decisionDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.decisionDigest) ||
		typeof value.sourceProofDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.sourceProofDigest) ||
		!Array.isArray(value.promoted) ||
		value.promoted.length < 1 ||
		value.promoted.length > 4
	)
		throw failure("poisoned", "snapshot inherited intent pointer is invalid");
	const objectId = captureRecoveryDependencyScope({
		objectId: value.objectId,
		epoch: 0,
		anchor: "0".repeat(64),
		manifestDigest: "0".repeat(64),
	}).objectId;
	const promoted = value.promoted.map((row: unknown) => {
		if (
			!exactRecord(row, ["scope", "incarnation", "contentBytes"]) ||
			typeof row.incarnation !== "string" ||
			row.incarnation.length < 1 ||
			new intrinsicTextEncoder().encode(row.incarnation).byteLength > 36 ||
			!Number.isSafeInteger(row.contentBytes) ||
			Number(row.contentBytes) < 1
		)
			throw failure("poisoned", "snapshot inherited source subset is invalid");
		const scope = captureRecoveryDependencyScope(row.scope);
		if (scope.objectId !== objectId) throw failure("poisoned", "snapshot inherited source object changed");
		return Object.freeze({ scope, incarnation: row.incarnation, contentBytes: Number(row.contentBytes) });
	});
	if (new Set(promoted.map((row) => JSON.stringify(row.scope))).size !== promoted.length)
		throw failure("poisoned", "snapshot inherited source subset is duplicated");
	if (new intrinsicTextEncoder().encode(JSON.stringify(value)).byteLength > MAX_CLASSIFICATION_INTENT_BYTES)
		throw failure("poisoned", "snapshot inherited intent pointer exceeds its bounded carrier");
	return Object.freeze({
		objectId,
		decisionDigest: value.decisionDigest,
		sourceProofDigest: value.sourceProofDigest,
		promoted: Object.freeze(promoted),
	});
}

/** Reconstructs accounting only; native row reversal must separately verify
 * every exact selected incarnation and canonical descriptor before hashing. */
function classificationSourceOwner(owner: SnapshotRecoveryOwnerStatus): SnapshotRecoveryOwnerStatus {
	const pointer = owner.classificationIntent;
	if (pointer === undefined) throw failure("stale-scope", "snapshot inherited source pointer is absent");
	const bytes = pointer.promoted.reduce((sum, row) => addRecoveryContentBytes(sum, row.contentBytes), 0);
	if (owner.recoveryScopes < pointer.promoted.length || owner.recoveryContentBytes < bytes)
		throw failure("poisoned", "snapshot inherited source accounting underflow");
	const { classificationIntent: _pending, ...base } = owner;
	return Object.freeze({
		...base,
		recoveryScopes: owner.recoveryScopes - pointer.promoted.length,
		recoveryContentBytes: owner.recoveryContentBytes - bytes,
		legacyUnclassifiedScopes: addRecoveryContentBytes(owner.legacyUnclassifiedScopes, pointer.promoted.length),
		legacyUnclassifiedContentBytes: addRecoveryContentBytes(owner.legacyUnclassifiedContentBytes, bytes),
		migration: "classification-required",
	});
}
function captureRecoveryDescriptorCarrier(
	value: unknown,
	scope: SnapshotQuarantineScopeKey,
	incarnation: string
): Readonly<{ chunks: unknown; retirement?: SnapshotRecoveryRoleRetirementFact; extraContentBytes: number }> {
	if (value === null || Array.isArray(value)) return Object.freeze({ chunks: value, extraContentBytes: 0 });
	if (
		!exactRecord(value, ["kind", "version", "chunks", "retirement"]) ||
		value.kind !== "creator-snapshot-recovery-descriptors" ||
		value.version !== 1 ||
		!Array.isArray(value.chunks) ||
		value.chunks.length < 1 ||
		value.chunks.length > MAX_CHUNKS ||
		Reflect.ownKeys(value.chunks).length !== value.chunks.length + 1
	)
		throw failure("poisoned", "snapshot descriptor carrier is malformed");
	const chunks = Object.freeze(value.chunks.map((descriptor) => captureDescriptor(descriptor)));
	const retirement = captureRecoveryRoleRetirementFact(value.retirement);
	if (
		JSON.stringify(retirement.survivor.scope) !== JSON.stringify(scope) ||
		retirement.survivor.incarnation !== incarnation
	)
		throw failure("poisoned", "snapshot retirement fact belongs to another incarnation");
	const extraContentBytes =
		new intrinsicTextEncoder().encode(JSON.stringify(value)).byteLength -
		new intrinsicTextEncoder().encode(JSON.stringify(value.chunks)).byteLength;
	return Object.freeze({ chunks, retirement, extraContentBytes });
}
const maxRecoveryDescriptorBytes =
	2 +
	MAX_CHUNKS * JSON.stringify({ index: MAX_CHUNKS - 1, byteLength: 131_072, digest: "f".repeat(64) }).length +
	MAX_CHUNKS -
	1;
/**
 * Mechanical fact fields shared by native encoding and width-only previews.
 * These fields are not a consumed retirement decision or native authority.
 * @param decision Original certificate/head fields, or private width leaves.
 * @param survivor Original scope/incarnation fields, or private width leaves.
 * @param retired Complete retired pair fields for this episode only.
 * @returns Plain fields still requiring the original parser and native authority.
 */
function recoveryRetirementFactFields<Certificate, Head, Survivor, Retired>(
	decision: Readonly<{ certificateDigest: Certificate; currentHead: Head }>,
	survivor: Survivor,
	retired: Retired
): Readonly<{
	kind: "creator-snapshot-recovery-retirement";
	version: 1;
	certificateDigest: Certificate;
	currentHead: Head;
	survivor: Survivor;
	retired: Retired;
}> {
	return Object.freeze({
		kind: "creator-snapshot-recovery-retirement" as const,
		version: 1 as const,
		certificateDigest: decision.certificateDigest,
		currentHead: decision.currentHead,
		survivor,
		retired,
	});
}
function recoveryRetirementCarrier(
	decision: SnapshotRecoveryRoleRetirementDecision,
	survivor: Readonly<{ scope: SnapshotQuarantineScopeKey; incarnation: string }>,
	retired: readonly Readonly<{ scope: SnapshotQuarantineScopeKey; incarnation: string }>[],
	oldCarrier: unknown
): Readonly<{ carrier: Readonly<Record<string, unknown>>; contentByteDelta: number }> {
	const old = captureRecoveryDescriptorCarrier(oldCarrier, survivor.scope, survivor.incarnation);
	const retirement = captureRecoveryRoleRetirementFact(recoveryRetirementFactFields(decision, survivor, retired));
	const carrier = Object.freeze({
		kind: "creator-snapshot-recovery-descriptors",
		version: 1,
		chunks: old.chunks,
		retirement,
	});
	const bytes = new intrinsicTextEncoder().encode(JSON.stringify(carrier)).byteLength;
	if (bytes > maxRecoveryDescriptorBytes)
		throw failure("recovery-full", "snapshot retirement carrier exceeds the existing descriptor envelope");
	return Object.freeze({
		carrier,
		contentByteDelta: bytes - new intrinsicTextEncoder().encode(JSON.stringify(oldCarrier)).byteLength,
	});
}
function addRecoveryContentBytes(left: number, right: number): number {
	if (
		!Number.isSafeInteger(left) ||
		left < 0 ||
		!Number.isSafeInteger(right) ||
		right < 0 ||
		!Number.isSafeInteger(left + right)
	)
		throw failure("storage-failed", "snapshot recovery content accounting exceeds safe integers");
	return left + right;
}
function assertTemporaryAdmission(scopes: number, reservedChunkBytes: number): void {
	if (
		!Number.isSafeInteger(scopes) ||
		scopes < 0 ||
		!Number.isSafeInteger(reservedChunkBytes) ||
		reservedChunkBytes < 0
	)
		throw failure("poisoned", "snapshot temporary accounting is invalid");
	if (scopes > MAX_TEMPORARY_SCOPES || reservedChunkBytes > MAX_BYTES)
		throw failure("temporary-full", "snapshot temporary staging capacity is full");
}
function recoveryContentBytes(
	totalBytes: number,
	manifestByteLength: number,
	receivedCertificateWrapperByteLength = 0
): number {
	return addRecoveryContentBytes(
		addRecoveryContentBytes(totalBytes, manifestByteLength),
		receivedCertificateWrapperByteLength
	);
}
type RecoveryMetadata = Readonly<{
	exactCanonicalManifestBytes: unknown;
	totalBytes: unknown;
	chunkCount: unknown;
	descriptors: unknown;
	incarnation: unknown;
	state: unknown;
	retention: unknown;
	expiresAt: unknown;
}>;
type RecoveryReadExpectation = Readonly<{
	declaration: SnapshotQuarantineDeclaration;
	incarnation?: string;
}>;
function validateRecoveryManifest(declaration: SnapshotQuarantineDeclaration): void;
function validateRecoveryManifest(
	scope: SnapshotQuarantineScopeKey,
	metadata: RecoveryMetadata,
	read?: RecoveryReadExpectation
): Extract<SnapshotRecoveryDeclarationLookup, { kind: "present" }>;
function validateRecoveryManifest(
	input: SnapshotQuarantineDeclaration | SnapshotQuarantineScopeKey,
	metadata?: RecoveryMetadata,
	read?: RecoveryReadExpectation
): void | Extract<SnapshotRecoveryDeclarationLookup, { kind: "present" }> {
	try {
		const scope =
			metadata === undefined ? (input as SnapshotQuarantineDeclaration).scope : (input as SnapshotQuarantineScopeKey);
		if (
			metadata !== undefined &&
			(typeof metadata.incarnation !== "string" ||
				metadata.incarnation.length === 0 ||
				metadata.incarnation.length > 36 ||
				new intrinsicTextEncoder().encode(metadata.incarnation).byteLength > 36 ||
				!["open", "poisoned", "verified"].includes(metadata.state as string) ||
				!["temporary", "recovery", "legacy-unclassified"].includes(metadata.retention as string) ||
				(metadata.retention === "legacy-unclassified") !== (metadata.descriptors === null) ||
				(metadata.retention === "recovery" && metadata.state !== "verified") ||
				typeof metadata.totalBytes !== "number" ||
				!Number.isSafeInteger(metadata.totalBytes) ||
				metadata.totalBytes <= 0 ||
				metadata.totalBytes > MAX_BYTES ||
				typeof metadata.chunkCount !== "number" ||
				!Number.isSafeInteger(metadata.chunkCount) ||
				metadata.chunkCount <= 0 ||
				metadata.chunkCount > MAX_CHUNKS ||
				typeof metadata.expiresAt !== "number" ||
				!Number.isSafeInteger(metadata.expiresAt) ||
				metadata.expiresAt < 0)
		)
			throw failure("poisoned", "snapshot recovery metadata is invalid");
		const bytes =
			metadata === undefined
				? (input as SnapshotQuarantineDeclaration).exactCanonicalManifestBytes
				: (metadata.exactCanonicalManifestBytes as Uint8Array);
		let manifestResult: ReturnType<typeof decodeSnapshotManifest>;
		try {
			const decoded = decodeSnapshotManifest({
				exactCanonicalManifestBytes: bytes,
				expectedManifestDigest: scope.manifestDigest,
				profile: { maxManifestBytes: MAX_MANIFEST_BYTES, maxSnapshotBytes: MAX_BYTES, snapshotChunkBytes: 131_072 },
			});
			manifestResult = decoded;
		} catch (error) {
			if (metadata === undefined) throw error;
			switch ((error as { code?: unknown } | null)?.code) {
				case "manifest-digest-mismatch":
				case "manifest-invalid":
				case "manifest-noncanonical":
				case "manifest-too-large":
					throw failure("poisoned", "snapshot recovery manifest is invalid", error);
				default:
					throw failure("storage-failed", "snapshot recovery manifest processing failed", error);
			}
		}
		const decoded = manifestResult;
		const declaration =
			metadata === undefined
				? (input as SnapshotQuarantineDeclaration)
				: {
						scope,
						exactCanonicalManifestBytes: bytes,
						totalBytes: metadata.totalBytes,
						chunks:
							metadata.descriptors === null
								? decoded.chunks
								: captureRecoveryDescriptorCarrier(metadata.descriptors, scope, metadata.incarnation as string).chunks,
					};
		const chunks = declaration.chunks;
		if (
			decoded.manifest.objectId !== declaration.scope.objectId ||
			decoded.manifest.epoch !== declaration.scope.epoch ||
			decoded.manifest.anchor !== declaration.scope.anchor ||
			decoded.manifest.totalBytes !== declaration.totalBytes ||
			!Array.isArray(chunks) ||
			decoded.chunks.length !== chunks.length ||
			(metadata !== undefined && decoded.chunks.length !== metadata.chunkCount) ||
			decoded.chunks.some((expected, index) => {
				const actual = chunks[index];
				return (
					!exactRecord(actual, ["byteLength", "digest", "index"]) ||
					actual.index !== expected.index ||
					actual.byteLength !== expected.byteLength ||
					actual.digest !== expected.digest
				);
			})
		)
			throw failure("poisoned", "snapshot recovery manifest identity is inconsistent");
		if (metadata !== undefined) {
			const observation = Object.freeze({
				kind: "present",
				declaration: Object.freeze({
					scope: Object.freeze({ ...scope }),
					exactCanonicalManifestBytes: decoded.exactCanonicalManifestBytes,
					chunks: decoded.chunks,
					totalBytes: metadata.totalBytes as number,
				}),
				state: metadata.state as "open" | "poisoned" | "verified",
				retention: metadata.retention as SnapshotRetention,
				expiresAt: metadata.expiresAt as number,
			});
			if (read !== undefined)
				validateRecoveryRead(read.declaration, observation, metadata.incarnation as string, read.incarnation);
			return observation;
		}
	} catch (error) {
		if (metadata !== undefined) {
			if (error instanceof QuarantineError) throw error;
			throw failure("storage-failed", "snapshot recovery manifest processing failed", error);
		}
		throw failure("poisoned", "snapshot recovery manifest is invalid", error);
	}
}
function validateRecoveryChunk(
	declaration: SnapshotQuarantineDeclaration,
	descriptor: SnapshotChunkDescriptor,
	bytes: Uint8Array
): void {
	try {
		if (
			!exactRecord(descriptor, ["byteLength", "digest", "index"]) ||
			typeof descriptor.index !== "number" ||
			!Number.isSafeInteger(descriptor.index) ||
			descriptor.index < 0
		)
			throw new TypeError("snapshot recovery chunk descriptor is invalid");
		const expected = declaration.chunks[descriptor.index];
		if (
			expected === undefined ||
			expected.index !== descriptor.index ||
			expected.digest !== descriptor.digest ||
			expected.byteLength !== descriptor.byteLength ||
			bytes.byteLength !== expected.byteLength ||
			snapshotChunkDigest(descriptor.index, bytes) !== expected.digest
		)
			throw new TypeError("snapshot recovery chunk closure is invalid");
	} catch (error) {
		throw failure("poisoned", "snapshot recovery chunk is invalid", error);
	}
}
function validateRecoveryRead(
	expected: SnapshotQuarantineDeclaration,
	observation: Extract<SnapshotRecoveryDeclarationLookup, { kind: "present" }>,
	actualIncarnation: string,
	expectedIncarnation?: string
): asserts observation is Extract<SnapshotRecoveryDeclarationLookup, { kind: "present" }> & {
	state: "open" | "verified";
} {
	if (observation.state === "poisoned") throw failure("poisoned", "snapshot recovery scope is poisoned");
	if (expectedIncarnation !== undefined && actualIncarnation !== expectedIncarnation)
		throw failure("stale-scope", "snapshot reader belongs to an earlier incarnation");
	const actual = observation.declaration;
	if (
		actual.scope.objectId !== expected.scope.objectId ||
		actual.scope.epoch !== expected.scope.epoch ||
		actual.scope.anchor !== expected.scope.anchor ||
		actual.scope.manifestDigest !== expected.scope.manifestDigest ||
		actual.totalBytes !== expected.totalBytes ||
		actual.exactCanonicalManifestBytes.byteLength !== expected.exactCanonicalManifestBytes.byteLength ||
		actual.exactCanonicalManifestBytes.some((byte, index) => byte !== expected.exactCanonicalManifestBytes[index]) ||
		actual.chunks.length !== expected.chunks.length ||
		actual.chunks.some((chunk, index) => {
			const descriptor = expected.chunks[index];
			return (
				descriptor === undefined ||
				chunk.index !== descriptor.index ||
				chunk.byteLength !== descriptor.byteLength ||
				chunk.digest !== descriptor.digest
			);
		})
	)
		throw failure("conflict", "snapshot reader declaration conflicts with durable state");
}
function retirementFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
		Reflect.ownKeys(value).length !== keys.length
	)
		throw failure("malformed-input", "snapshot retirement record is invalid");
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const d = Object.getOwnPropertyDescriptor(value, key);
		if (d === undefined || !("value" in d) || !d.enumerable)
			throw failure("malformed-input", "snapshot retirement field is invalid");
		result[key] = d.value;
	}
	return result;
}
function retirementInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw failure("malformed-input", "snapshot retirement integer is invalid");
	return value;
}
function retirementDigest(value: unknown): string {
	if (!hex64(value)) throw failure("malformed-input", "snapshot retirement digest is invalid");
	return value;
}
function retirementObject(input: unknown): string {
	const fields = retirementFields(input, ["objectId"]);
	if (
		typeof fields.objectId !== "string" ||
		fields.objectId.length === 0 ||
		fields.objectId.length > 1024 ||
		fields.objectId.includes("\0")
	)
		throw failure("malformed-input", "snapshot retirement object is invalid");
	return fields.objectId;
}
const retirementScopeKey = (value: SnapshotRetirementPreparation["protectedScopes"][number]): string =>
	JSON.stringify([value.scope.epoch, value.scope.anchor, value.scope.manifestDigest, value.incarnation]);
const compareRetirementText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
/** Canonical protected-hole order: numeric epoch, then code-unit text, exactly the
 * native image order (SQLite `ORDER BY epoch,anchor,manifest_digest`, IndexedDB keys)
 * from which owners build preparations, and the live journal's numeric scope order.
 * A decimal-text or locale key would put epoch 10 before 9 and make every honest
 * preparation straddling a digit boundary read back as a different preparation. */
const compareRetirementScopes = (
	left: SnapshotRetirementPreparation["protectedScopes"][number],
	right: SnapshotRetirementPreparation["protectedScopes"][number]
): number =>
	left.scope.epoch - right.scope.epoch ||
	compareRetirementText(left.scope.anchor, right.scope.anchor) ||
	compareRetirementText(left.scope.manifestDigest, right.scope.manifestDigest) ||
	compareRetirementText(left.incarnation, right.incarnation);
function retirementPreparation(input: unknown, objectId: string): SnapshotRetirementPreparation {
	const r = retirementFields(input, ["decisionDigest", "sourceProofDigest", "throughEpoch", "protectedScopes"]);
	const throughEpoch = retirementInteger(r.throughEpoch),
		array = r.protectedScopes;
	if (
		!Array.isArray(array) ||
		Object.getPrototypeOf(array) !== Array.prototype ||
		array.length > snapshotQuarantineContract.defaultRecoveryLimits.maxRecoveryScopes ||
		Reflect.ownKeys(array).length !== array.length + 1
	)
		throw failure("malformed-input", "snapshot protected holes are invalid");
	const protectedScopes = Array.from({ length: array.length }, (_, index) => {
		const d = Object.getOwnPropertyDescriptor(array, String(index));
		if (d === undefined || !("value" in d) || !d.enumerable)
			throw failure("malformed-input", "snapshot protected hole is invalid");
		const row = retirementFields(d.value, ["scope", "incarnation"]),
			scope = captureRecoveryDependencyScope(
				retirementFields(row.scope, ["objectId", "epoch", "anchor", "manifestDigest"])
			);
		if (
			scope.objectId !== objectId ||
			scope.epoch > throughEpoch ||
			typeof row.incarnation !== "string" ||
			row.incarnation.length === 0 ||
			new TextEncoder().encode(row.incarnation).length > 36
		)
			throw failure("malformed-input", "snapshot protected identity is invalid");
		return Object.freeze({ scope, incarnation: row.incarnation });
	}).sort(compareRetirementScopes);
	if (new Set(protectedScopes.map(retirementScopeKey)).size !== protectedScopes.length)
		throw failure("malformed-input", "snapshot protected holes repeat");
	return Object.freeze({
		decisionDigest: retirementDigest(r.decisionDigest),
		sourceProofDigest: retirementDigest(r.sourceProofDigest),
		throughEpoch,
		protectedScopes: Object.freeze(protectedScopes),
	});
}
function retirementAllows(
	control: SnapshotRetirementControl | null,
	scope: SnapshotQuarantineScopeKey,
	incarnation?: string
): boolean {
	const allows = (p: SnapshotRetirementPreparation | null): boolean =>
		p === null ||
		scope.epoch > p.throughEpoch ||
		(incarnation !== undefined &&
			p.protectedScopes.some(
				(s) => JSON.stringify(s.scope) === JSON.stringify(scope) && s.incarnation === incarnation
			));
	return (
		control === null ||
		(control.objectId === scope.objectId && allows(control.completed) && allows(control.active?.preparation ?? null))
	);
}
function retirementAdvance(prior: SnapshotRetirementPreparation | null, next: SnapshotRetirementPreparation): boolean {
	return (
		prior === null ||
		(next.throughEpoch >= prior.throughEpoch &&
			next.protectedScopes.every(
				(s) =>
					s.scope.epoch > prior.throughEpoch ||
					prior.protectedScopes.some((p) => retirementScopeKey(p) === retirementScopeKey(s))
			))
	);
}
function retirementProtected(
	control: SnapshotRetirementControl | null,
	scope: SnapshotQuarantineScopeKey,
	incarnation: string
): boolean {
	return [control?.completed, control?.active?.preparation].some((p) =>
		p?.protectedScopes.some((s) => JSON.stringify(s.scope) === JSON.stringify(scope) && s.incarnation === incarnation)
	);
}
/**
 * Refines an older completed frontier only through the consumed original
 * authenticated turnover decision. This mechanical helper does not mint it.
 * The signed turnover receipt and physical removal share the same transaction;
 * the original coordinator subsequently authenticates a NEW postimage intent.
 * @param control Exact actual native control.
 * @param decision Already consumed original nominal turnover decision.
 * @param retired Exact classified native scope/incarnation pairs.
 * @returns An unchanged control or its monotone hole-only postimage.
 */
function retirementTurnoverFrontier(
	control: SnapshotRetirementControl | null,
	decision: SnapshotRecoveryRoleRetirementDecision | undefined,
	retired: readonly Readonly<{ scope: SnapshotQuarantineScopeKey; incarnation: string }>[]
): SnapshotRetirementControl | null {
	if (decision?.priorRetirementControl === undefined) return control;
	if (
		control === null ||
		retirementImageDigest(control) !== retirementImageDigest(decision.priorRetirementControl) ||
		control.active !== null ||
		control.objectId !== decision.currentHead.objectId
	)
		throw failure("stale-scope", "snapshot turnover frontier changed or remains active");
	const completed = control.completed;
	if (completed === null) return control;
	const keys = new Set(retired.map(retirementScopeKey));
	const protectedScopes = completed.protectedScopes.filter((pair) => !keys.has(retirementScopeKey(pair)));
	if (protectedScopes.length === completed.protectedScopes.length) return control;
	if (decision.currentHead.epoch <= completed.throughEpoch + 1 || control.revision === Number.MAX_SAFE_INTEGER)
		throw failure("stale-scope", "snapshot turnover does not advance the authenticated source head");
	const next = { ...completed, protectedScopes };
	if (!retirementAdvance(completed, next)) throw failure("stale-scope", "snapshot turnover resurrects a retired hole");
	return retirementControl({ ...control, revision: control.revision + 1, completed: next });
}
/** Original native control schema; numerical slots grant neither a scope nor
 * retirement authority. The native capture below still validates every field. */
function retirementControlFields<O, I, R, S, A, C>(input: Readonly<{
	objectId: O; incarnation: I; revision: R; sequence: S; active: A; completed: C;
}>) {
	return {kind: "snapshot-retirement-control-1" as const, objectId: input.objectId, incarnation: input.incarnation,
		revision: input.revision, sequence: input.sequence, active: input.active, completed: input.completed};
}
const SNAPSHOT_RETIREMENT_CONTROL_LIMITS = Object.freeze({maxBytes: AHE_BOUNDED_READ_LIMITS.maxUnionBytes,
	maxDepth: 6, maxItems: 256});
function retirementControl(input: unknown): SnapshotRetirementControl {
	const r = retirementFields(input, ["kind", "objectId", "incarnation", "revision", "sequence", "active", "completed"]),
		objectId = retirementObject({ objectId: r.objectId }),
		sequence = retirementInteger(r.sequence);
	if (r.kind !== "snapshot-retirement-control-1")
		throw failure("poisoned", "snapshot retirement control kind is invalid");
	const completed = r.completed === null ? null : retirementPreparation(r.completed, objectId);
	let active: SnapshotRetirementControl["active"] = null;
	if (r.active !== null) {
		const a = retirementFields(r.active, ["sequence", "preparation"]);
		if (retirementInteger(a.sequence) !== sequence || sequence === 0)
			throw failure("poisoned", "snapshot retirement sequence is invalid");
		active = Object.freeze({ sequence, preparation: retirementPreparation(a.preparation, objectId) });
		if (!retirementAdvance(completed, active.preparation))
			throw failure("poisoned", "snapshot retirement frontier regressed");
	}
	return Object.freeze(retirementControlFields({
		objectId,
		incarnation: retirementDigest(r.incarnation),
		revision: retirementInteger(r.revision),
		sequence,
		active,
		completed,
	}));
}
function encodeRetirementControl(value: SnapshotRetirementControl): Uint8Array {
	return encodeCanonical(retirementControl(value), SNAPSHOT_RETIREMENT_CONTROL_LIMITS);
}
function decodeRetirementControl(value: unknown): SnapshotRetirementControl {
	const bytes = exactBytes(value, "snapshot native retirement control", AHE_BOUNDED_READ_LIMITS.maxUnionBytes),
		captured = retirementControl(
			decodeCanonical(bytes, SNAPSHOT_RETIREMENT_CONTROL_LIMITS)
		);
	if (compareBytes(bytes, encodeRetirementControl(captured)) !== 0)
		throw failure("poisoned", "snapshot retirement control is noncanonical");
	return captured;
}
function retirementImageDigest(value: unknown): string {
	return Array.from(hashDomain("ts-drp:snapshot-retirement-image:v1", encodeCanonical(value)), (b) =>
		b.toString(16).padStart(2, "0")
	).join("");
}
function createRetirementRead(
	control: SnapshotRetirementControl,
	image: SnapshotRetirementImage,
	compare: (next: SnapshotRetirementControl) => Promise<SnapshotRetirementControl>,
	join: () => Promise<void>
): SnapshotRetirementControlRead {
	let consumed = false,
		joining: Promise<void> | undefined;
	const release = (): Promise<void> => {
		consumed = true;
		return (joining ??= join());
	};
	const transition = (kind: "prepare" | "abort" | "commit", input: unknown): Promise<SnapshotRetirementControl> =>
		promiseRetirement(async () => {
			if (consumed) throw failure("stale-scope", "snapshot retirement observation is consumed");
			// Revoke before parsing hostile input; every attempted transition consumes custody.
			consumed = true;
			let preparation: SnapshotRetirementPreparation | undefined;
			try {
				if (kind === "prepare") {
					preparation = retirementPreparation(input, control.objectId);
					if (
						control.active !== null ||
						!retirementAdvance(control.completed, preparation) ||
						preparation.protectedScopes.some(
							(s) => !image.scopes.some((actual) => retirementScopeKey(actual) === retirementScopeKey(s))
						)
					)
						throw failure("stale-scope", "snapshot retirement preparation is stale or resurrects a retired hole");
				} else {
					const r = retirementFields(input, ["decisionDigest", "sourceProofDigest"]);
					if (
						control.active === null ||
						retirementDigest(r.decisionDigest) !== control.active.preparation.decisionDigest ||
						retirementDigest(r.sourceProofDigest) !== control.active.preparation.sourceProofDigest
					)
						throw failure("stale-scope", "snapshot retirement preparation does not match");
				}
			} catch (primary) {
				try {
					await release();
				} catch (cleanup) {
					throw new AggregateError([primary, cleanup], "snapshot retirement release failed", { cause: primary });
				}
				throw primary;
			}
			await release();
			if (
				control.revision === Number.MAX_SAFE_INTEGER ||
				(kind === "prepare" && control.sequence === Number.MAX_SAFE_INTEGER)
			)
				throw failure("recovery-full", "snapshot retirement control exhausted");
			const next: SnapshotRetirementControl = {
				...control,
				revision: control.revision + 1,
				sequence: kind === "prepare" ? control.sequence + 1 : control.sequence,
				active: preparation === undefined ? null : { sequence: control.sequence + 1, preparation },
				completed: kind === "commit" ? (control.active?.preparation ?? control.completed) : control.completed,
			};
			return compare(next);
		});
	return Object.freeze({
		control,
		image,
		prepareFence: (input: SnapshotRetirementPreparation) => transition("prepare", input),
		abortPrepared: (input: Readonly<{ decisionDigest: string; sourceProofDigest: string }>) =>
			transition("abort", input),
		commitPrepared: (input: Readonly<{ decisionDigest: string; sourceProofDigest: string }>) =>
			transition("commit", input),
		release,
	});
}
function promiseRetirement<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return operation();
	} catch (error) {
		return Promise.reject(error);
	}
}
/** Shared mechanical codec; none of these labels authorize eligibility or deletion. */
export const snapshotRetirementContract = Object.freeze({
	captureObject: retirementObject,
	capturePreparation: retirementPreparation,
	controlFields: retirementControlFields,
	controlLimits: SNAPSHOT_RETIREMENT_CONTROL_LIMITS,
	encodeControl: encodeRetirementControl,
	decodeControl: decodeRetirementControl,
	allows: retirementAllows,
	protected: retirementProtected,
	turnoverFrontier: retirementTurnoverFrontier,
	imageDigest: retirementImageDigest,
	createRead: createRetirementRead,
	maxImageBytes: AHE_BOUNDED_READ_LIMITS.maxUnionBytes,
	maxScopes: MAX_CHUNKS,
	// Byte entitlement does not expand the original native cardinality bound.
	maxChunks: 8192,
});

export const snapshotQuarantineContract = Object.freeze({
	// Explicit aggregate durable-staging policy, not the four active transfers
	// or recovery entitlement. Manifests/descriptors retain their original
	// per-declaration ceilings and are separate from these declared chunk bytes.
	temporaryLimits: Object.freeze({ maxTemporaryScopes: MAX_TEMPORARY_SCOPES, maxTemporaryChunkBytes: MAX_BYTES }),
	assertTemporaryAdmission,
	limits: Object.freeze({
		maxManifestBytes: MAX_MANIFEST_BYTES,
		maxChunks: MAX_CHUNKS,
		maxSnapshotBytes: MAX_BYTES,
		snapshotChunkBytes: 131_072,
	}),
	defaultRecoveryLimits: Object.freeze({ maxRecoveryScopes: 4, maxRecoveryContentBytes: MAX_BYTES }),
	captureDeclaration,
	captureScope,
	captureRecoveryDependencyScope,
	captureRecoveryRetirementScopes,
	captureDescriptor,
	captureExactBytes: exactBytes,
	captureRecoveryLimits,
	captureRetentionOptions,
	captureRecoverySelector,
	wrapReceivedCertificate,
	openReceivedCertificate,
	receivedCertificateMaxBytes: SNAPSHOT_RECEIVED_CERTIFICATE_MAX_BYTES,
	receivedCertificateWrapperMaxBytes: SNAPSHOT_RECEIVED_CERTIFICATE_WRAPPER_MAX_BYTES,
	captureRecoveryRoleObject,
	captureRecoveryRoleCustody,
	captureRecoveryRoleProtection,
	consumeRecoveryRoleRetirementDecision,
	recoveryClassificationAccounting,
	captureClassificationIntent,
	classificationSourceOwner,
	maxClassificationIntentBytes: MAX_CLASSIFICATION_INTENT_BYTES,
	captureRecoveryRoleRetirementFact,
	captureRecoveryDescriptorCarrier,
	recoveryRetirementFactFields,
	recoveryRetirementCarrier,
	maxRecoveryDescriptorBytes,
	recoveryContentBytes,
	addRecoveryContentBytes,
	validateRecoveryManifest,
	validateRecoveryChunk,
	createError: failure,
	isError: (value: unknown): value is Error & { readonly code: SnapshotQuarantineFailureCode } =>
		value instanceof QuarantineError,
});
