import type { AheRetirementControlRead } from "./retirement-control.js";

declare const storageObjectIdBrand: unique symbol;
declare const generationIdBrand: unique symbol;
declare const blobDigestBrand: unique symbol;
declare const closureDigestBrand: unique symbol;
declare const headRevisionBrand: unique symbol;
declare const generationPageCursorBrand: unique symbol;

export type StorageObjectId = string & { readonly [storageObjectIdBrand]: true };
export type GenerationId = string & { readonly [generationIdBrand]: true };
export type BlobDigest = string & { readonly [blobDigestBrand]: true };
export type ClosureDigest = string & { readonly [closureDigestBrand]: true };
export type HeadRevision = number & { readonly [headRevisionBrand]: true };
export type GenerationPageCursor = string & { readonly [generationPageCursorBrand]: true };

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: "INVALID_ARGUMENT" | "SHARED_BUFFER_INPUT" };

export type StorageRejectionReason =
	| "READ_BUDGET_EXCEEDED"
	| "READ_STALE_HEAD"
	| "READ_STALE_ROLE_VIEW"
	| "READ_RELEASED"
	| "RETIREMENT_FENCED"
	| "STORE_CLOSED"
	| "STORE_POISONED"
	| "INVALID_ARGUMENT"
	| "SHARED_BUFFER_INPUT"
	| "GENERATION_NOT_FOUND"
	| "GENERATION_EXISTS"
	| "ILLEGAL_TRANSITION"
	| "EMPTY_CLOSURE"
	| "DUPLICATE_CLOSURE_REFERENCE"
	| "BLOB_NOT_REFERENCED"
	| "BLOB_MISSING"
	| "BLOB_CORRUPT"
	| "BLOB_UNPROMOTED"
	| "ADOPTED_BLOB_UNPROMOTED"
	| "ADOPTED_BLOB_MISSING"
	| "ADOPTED_BLOB_CORRUPT"
	| "IMMUTABLE_CONFLICT"
	| "DURABILITY_UNAVAILABLE"
	| "BASE_HEAD_MISMATCH"
	| "CANDIDATE_NOT_COMPLETE"
	| "HEAD_CONFLICT"
	| "REVISION_EXHAUSTED"
	| "UNSUPPORTED_STORAGE_SCHEMA"
	| "NON_CANONICAL_RECORD"
	| "SUBSTRATE_FAILURE";

export type StoreResult<T> =
	| { readonly ok: true; readonly value: T }
	| {
			readonly ok: false;
			readonly reason: Exclude<StorageRejectionReason, "SUBSTRATE_FAILURE">;
	  }
	| { readonly ok: false; readonly reason: "SUBSTRATE_FAILURE"; readonly cause: unknown };

export type NoHead = {
	readonly kind: "none";
	readonly objectId: StorageObjectId;
};

export type PresentHead = {
	readonly kind: "present";
	readonly objectId: StorageObjectId;
	readonly generationId: GenerationId;
	readonly revision: HeadRevision;
	readonly closureDigest: ClosureDigest;
};

export type ExpectedHead = NoHead | PresentHead;

export type GenerationRef = {
	readonly digest: BlobDigest;
	readonly byteLength: number;
};

export type GenerationState = "Staged" | "Complete" | "Adopted" | "Superseded" | "Discarded";

export type GenerationRecord = {
	readonly objectId: StorageObjectId;
	readonly generationId: GenerationId;
	readonly baseExpectedHead: ExpectedHead;
	readonly closureDigest: ClosureDigest;
	readonly closure: readonly GenerationRef[];
	readonly state: GenerationState;
};

export type GenerationPage = {
	readonly generations: readonly GenerationRecord[];
	readonly nextCursor: GenerationPageCursor | null;
};
export type ActiveGenerationSnapshot =
	| Readonly<{
			kind: "empty";
			head: NoHead;
			adoptedGeneration: null;
			recomputedClosureDigest: null;
			references: readonly [];
	  }>
	| Readonly<{
			kind: "active";
			head: PresentHead;
			adoptedGeneration: GenerationRecord;
			recomputedClosureDigest: ClosureDigest;
			references: readonly GenerationRef[];
	  }>;

export type StoreCapabilities = {
	readonly durability: "ephemeral" | "strict";
	readonly signingEligibility: "never" | "backend-capability-required";
};

/** Finite host-local encoded-work capacity; never protocol authority or a heap limit.
 * Admission reserves the exact workload continuation under these ceilings. The
 * profile is unchanged by room age and is also used by fresh recovery/reopen.
 * The supported64-Writer protected-window candidate measured1161416 bytes
 * including full PRE and147231 bytes of unknown runtime reservation. 1.25MiB
 * leaves149304 bytes of headroom; lawful cleanup still requires native evidence.
 * This is neither authenticated epoch/payload capacity nor consumed heap/RSS. */
export const LOCAL_WORKLOAD_CAPACITY = Object.freeze({
	kind: "bounded-local-workload-capacity-1" as const,
	profile: "supported-64-writer-protected-window-1" as const,
	ordinaryProofBytes: 1_310_720,
	maintenanceProofBytes: 4_194_304,
	journalImageBytes: 2_097_152,
	journalRows: 24_576,
});

export type AheBoundedReadLimits = Readonly<{
	maxObjectGenerations: 7;
	maxHeadBytes: 3326;
	maxGenerationBytes: 7307;
	maxClosureReferences: 7;
	maxBlobBytes: 65536;
	maxUnionBytes: 786432;
}>;

/** Fixed operation-local encoded proof entitlement, also used by native image
 * guards. The 64-Writer native continuation requires732554 bytes including all
 * unknown census reservations; 768KiB leaves53878 bytes of measured headroom.
 * Not a heap or total-work bound; independent request limits remain. */
export const AHE_BOUNDED_READ_LIMITS: AheBoundedReadLimits = Object.freeze({
	maxObjectGenerations: 7,
	maxHeadBytes: 3326,
	maxGenerationBytes: 7307,
	maxClosureReferences: 7,
	maxBlobBytes: 65536,
	maxUnionBytes: 786432,
});

export type AheBoundedReadInput = Readonly<{
	objectId: StorageObjectId;
	ancestorCount: 0 | 2;
	limits: AheBoundedReadLimits;
}>;

export type AheBoundedReadAcquisition =
	| Readonly<{ kind: "empty"; head: NoHead }>
	| Readonly<{ kind: "present"; reader: AheBoundedActiveRead }>;

export interface AheBoundedActiveRead {
	readonly head: PresentHead;
	readonly generations: readonly GenerationRecord[];
	readonly blobs: readonly Readonly<{ ref: GenerationRef; bytes: Uint8Array }>[];
	checkCurrent(): Promise<StoreResult<Readonly<{ kind: "current" }>>>;
	release(): Promise<void>;
}

export interface AheDurableStore {
	acquireBoundedActiveRead(input: AheBoundedReadInput): Promise<StoreResult<AheBoundedReadAcquisition>>;
	readonly capabilities: Readonly<StoreCapabilities>;
	readHead(objectId: StorageObjectId): Promise<StoreResult<ExpectedHead>>;
	readGenerationPage(input: {
		readonly objectId: StorageObjectId;
		readonly cursor?: GenerationPageCursor;
		readonly limit: number;
	}): Promise<StoreResult<GenerationPage>>;
	recoverActiveGeneration(objectId: StorageObjectId): Promise<StoreResult<ActiveGenerationSnapshot>>;
	getBlob(digest: BlobDigest): Promise<StoreResult<Uint8Array | null>>;
	beginGeneration(input: {
		readonly objectId: StorageObjectId;
		readonly generationId: GenerationId;
		readonly baseExpectedHead: ExpectedHead;
		readonly closure: readonly GenerationRef[];
	}): Promise<StoreResult<GenerationRecord>>;
	putCachedBlob(input: {
		readonly objectId: StorageObjectId;
		readonly generationId: GenerationId;
		readonly digest: BlobDigest;
		readonly bytes: Uint8Array;
	}): Promise<StoreResult<{ readonly inserted: boolean }>>;
	promoteReference(input: {
		readonly objectId: StorageObjectId;
		readonly generationId: GenerationId;
		readonly digest: BlobDigest;
	}): Promise<StoreResult<undefined>>;
	completeGeneration(input: {
		readonly objectId: StorageObjectId;
		readonly generationId: GenerationId;
	}): Promise<StoreResult<GenerationRecord>>;
	swapHead(input: {
		readonly objectId: StorageObjectId;
		readonly generationId: GenerationId;
		readonly expectedHead: ExpectedHead;
	}): Promise<StoreResult<{ readonly head: PresentHead; readonly supersededGenerationId: GenerationId | null }>>;
	discardGeneration(input: {
		readonly objectId: StorageObjectId;
		readonly generationId: GenerationId;
	}): Promise<StoreResult<GenerationRecord>>;
	close(): Promise<void>;
}

/** Closed mechanical recovery census, without role authentication. */
export type AheBoundedRecoveryRoleReadInput = Readonly<{
	objectId: StorageObjectId;
	limits: AheBoundedReadLimits;
}>;

export interface AheBoundedRecoveryRoleRead {
	readonly head: ExpectedHead;
	readonly generations: readonly GenerationRecord[];
	readonly blobs: readonly Readonly<{ ref: GenerationRef; bytes: Uint8Array }>[];
	checkCurrency(): Promise<StoreResult<Readonly<{ kind: "current" }>>>;
	release(): Promise<void>;
}

/** Complete native point observation, including real metadata absence; not held exclusion or authority. */
export type AheRetirementAdmissionImage = Readonly<{
	control: AheRetirementControlRead["control"] | null;
	head: ExpectedHead;
	imageDigest: string;
	metadataBytes: number;
}>;

export interface AheBoundedRecoveryRoleStore extends AheDurableStore {
	/** Reversible native AHE-local reservation only; not cross-store retirement authority. */
	acquireRetirementControl?(objectId: StorageObjectId): Promise<StoreResult<AheRetirementControlRead>>;
	/** Observational native metadata only; never births a control or grants mutation. */
	readRetirementControl?(
		objectId: StorageObjectId
	): Promise<StoreResult<import("./retirement-control.js").AheRetirementControl | null>>;
	/** Complete noncreating native point read; a caller-held reservation supplies exclusion. */
	readRetirementImage?(
		objectId: StorageObjectId
	): Promise<StoreResult<Pick<AheRetirementControlRead, "control" | "head" | "imageDigest" | "metadataBytes">>>;
	/** Same complete census with noncreating metadata absence; future control birth still needs its own full charge. */
	readRetirementAdmissionImage?(objectId: StorageObjectId): Promise<StoreResult<AheRetirementAdmissionImage>>;
	acquireBoundedRecoveryRoleRead(
		input: AheBoundedRecoveryRoleReadInput
	): Promise<StoreResult<AheBoundedRecoveryRoleRead>>;
}
/** A held native read-only view. Neither this handle nor a check grants write authority. */
export interface NativeReadReservation {
	check: () => Promise<void>;
	release: () => Promise<void>;
}
