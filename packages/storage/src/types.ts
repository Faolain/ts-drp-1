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

export type AheBoundedReadLimits = Readonly<{
	maxObjectGenerations: 7;
	maxHeadBytes: 3326;
	maxGenerationBytes: 7307;
	maxClosureReferences: 7;
	maxBlobBytes: 65536;
	maxUnionBytes: 262144;
}>;

/** Fixed readonly observer entitlement, not a producer admission policy. */
export const AHE_BOUNDED_READ_LIMITS: AheBoundedReadLimits = Object.freeze({
	maxObjectGenerations: 7,
	maxHeadBytes: 3326,
	maxGenerationBytes: 7307,
	maxClosureReferences: 7,
	maxBlobBytes: 65536,
	maxUnionBytes: 262144,
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

export interface AheBoundedRecoveryRoleStore extends AheDurableStore {
	acquireBoundedRecoveryRoleRead(
		input: AheBoundedRecoveryRoleReadInput
	): Promise<StoreResult<AheBoundedRecoveryRoleRead>>;
}
