import { encodeCanonical, hashDomain } from "@ts-drp/canonical";

import type {
	BlobDigest,
	ClosureDigest,
	GenerationId,
	GenerationRef,
	HeadRevision,
	ParseResult,
	StorageObjectId,
} from "./types.js";

function ok<T>(value: T): ParseResult<T> {
	return { ok: true, value };
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * RED scaffold: validation is deliberately permissive.
 * @param value
 */
export function parseStorageObjectId(value: string): ParseResult<StorageObjectId> {
	return ok(value as StorageObjectId);
}

/**
 * RED scaffold: validation is deliberately permissive.
 * @param value
 */
export function parseGenerationId(value: string): ParseResult<GenerationId> {
	return ok(value as GenerationId);
}

/**
 * RED scaffold: validation is deliberately permissive.
 * @param value
 */
export function parseBlobDigest(value: string): ParseResult<BlobDigest> {
	return ok(value as BlobDigest);
}

/**
 * RED scaffold: validation is deliberately permissive.
 * @param value
 */
export function parseClosureDigest(value: string): ParseResult<ClosureDigest> {
	return ok(value as ClosureDigest);
}

/**
 * RED scaffold: validation is deliberately permissive.
 * @param value
 */
export function parseHeadRevision(value: number): ParseResult<HeadRevision> {
	return ok(value as HeadRevision);
}

/**
 * RED scaffold: SharedArrayBuffer and exact input checks are intentionally absent.
 * @param bytes
 */
export function digestBlob(bytes: Uint8Array): ParseResult<BlobDigest> {
	return ok(hex(hashDomain("ts-drp-storage/blob/v1", new Uint8Array(bytes))) as BlobDigest);
}

/**
 * RED scaffold: closure validation and sorting are intentionally absent.
 * @param closure
 */
export function digestClosure(closure: readonly GenerationRef[]): ParseResult<ClosureDigest> {
	return ok(hex(hashDomain("ts-drp-storage/closure/v1", encodeCanonical(closure))) as ClosureDigest);
}

/**
 * @param value
 * @internal
 */
export function permissiveStorageObjectId(value: string): StorageObjectId {
	return value as StorageObjectId;
}

/**
 * @param value
 * @internal
 */
export function permissiveGenerationId(value: string): GenerationId {
	return value as GenerationId;
}

/**
 * @param value
 * @internal
 */
export function permissiveBlobDigest(value: string): BlobDigest {
	return value as BlobDigest;
}

/**
 * @param value
 * @internal
 */
export function permissiveClosureDigest(value: string): ClosureDigest {
	return value as ClosureDigest;
}

/**
 * @param value
 * @internal
 */
export function permissiveHeadRevision(value: number): HeadRevision {
	return value as HeadRevision;
}
