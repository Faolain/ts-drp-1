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
	| "STORE_CLOSED"
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

export type StoreCapabilities = {
	readonly durability: "ephemeral" | "strict";
	readonly signingEligibility: "never" | "backend-capability-required";
};

export interface AheDurableStore {
	readonly capabilities: Readonly<StoreCapabilities>;
	readHead(objectId: StorageObjectId): Promise<StoreResult<ExpectedHead>>;
	readGenerationPage(input: {
		readonly objectId: StorageObjectId;
		readonly cursor?: GenerationPageCursor;
		readonly limit: number;
	}): Promise<StoreResult<GenerationPage>>;
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
