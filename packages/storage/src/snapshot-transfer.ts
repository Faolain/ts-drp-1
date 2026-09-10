import { decodeSnapshotManifest, snapshotChunkDigest } from "@ts-drp/protocol-v3/snapshot-transfer";

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
	retainForRecovery(options?: Readonly<{ readonly signal?: AbortSignal }>): Promise<void>;
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
		SnapshotRecoveryDeclarationReader {}
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
	| Readonly<{ kind: "present"; status: SnapshotQuarantineStatus }>;
export interface SnapshotRecoveryOwnerStatus {
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

function captureDescriptor(value: unknown): SnapshotChunkDescriptor {
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
	return Object.freeze({ byteLength, digest, index });
}

function captureDeclaration(value: unknown): CapturedDeclaration {
	if (!exactRecord(value, ["chunks", "exactCanonicalManifestBytes", "scope", "totalBytes"])) {
		throw failure("malformed-input", "snapshot quarantine declaration is malformed");
	}
	if (!Array.isArray(value.chunks) || value.chunks.length === 0 || value.chunks.length > MAX_CHUNKS) {
		throw failure("malformed-input", "snapshot quarantine descriptor count is invalid");
	}
	const chunks = Object.freeze(value.chunks.map(captureDescriptor));
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
function recoveryContentBytes(totalBytes: number, manifestByteLength: number): number {
	return addRecoveryContentBytes(totalBytes, manifestByteLength);
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
function validateRecoveryManifest(declaration: SnapshotQuarantineDeclaration): void;
function validateRecoveryManifest(
	scope: SnapshotQuarantineScopeKey,
	metadata: RecoveryMetadata
): Extract<SnapshotRecoveryDeclarationLookup, { kind: "present" }>;
function validateRecoveryManifest(
	input: SnapshotQuarantineDeclaration | SnapshotQuarantineScopeKey,
	metadata?: RecoveryMetadata
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
						chunks: metadata.descriptors === null ? decoded.chunks : metadata.descriptors,
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
		if (metadata !== undefined)
			return Object.freeze({
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
export const snapshotQuarantineContract = Object.freeze({
	limits: Object.freeze({
		maxManifestBytes: MAX_MANIFEST_BYTES,
		maxChunks: MAX_CHUNKS,
		maxSnapshotBytes: MAX_BYTES,
		snapshotChunkBytes: 131_072,
	}),
	defaultRecoveryLimits: Object.freeze({ maxRecoveryScopes: 4, maxRecoveryContentBytes: MAX_BYTES }),
	captureDeclaration,
	captureScope,
	captureDescriptor,
	captureExactBytes: exactBytes,
	captureRecoveryLimits,
	recoveryContentBytes,
	addRecoveryContentBytes,
	validateRecoveryManifest,
	validateRecoveryChunk,
	createError: failure,
	isError: (value: unknown): value is Error & { readonly code: SnapshotQuarantineFailureCode } =>
		value instanceof QuarantineError,
});
