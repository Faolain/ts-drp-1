import { encodeCanonical, hashDomain } from "@ts-drp/canonical";

import {
	copyClosure,
	hasSharedBacking,
	isBlobDigest,
	isClosureDigest,
	isGenerationId,
	isHeadRevision,
	isStorageObjectId,
} from "./internal/validation.js";
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

function invalid<T>(): ParseResult<T> {
	return { ok: false, reason: "INVALID_ARGUMENT" };
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Parses the sole greenfield creator-bound storage object spelling.
 * @param value - Input value.
 * @returns A branded identity or exact rejection.
 */
export function parseStorageObjectId(value: string): ParseResult<StorageObjectId> {
	return isStorageObjectId(value) ? ok(value) : invalid();
}

/**
 * Parses one canonical generation identifier.
 * @param value - Input value.
 * @returns A branded identifier or exact rejection.
 */
export function parseGenerationId(value: string): ParseResult<GenerationId> {
	return isGenerationId(value) ? ok(value) : invalid();
}

/**
 * Parses one canonical blob digest.
 * @param value - Input value.
 * @returns A branded digest or exact rejection.
 */
export function parseBlobDigest(value: string): ParseResult<BlobDigest> {
	return isBlobDigest(value) ? ok(value) : invalid();
}

/**
 * Parses one canonical closure digest.
 * @param value - Input value.
 * @returns A branded digest or exact rejection.
 */
export function parseClosureDigest(value: string): ParseResult<ClosureDigest> {
	return isClosureDigest(value) ? ok(value) : invalid();
}

/**
 * Parses one positive safe head revision.
 * @param value - Input value.
 * @returns A branded revision or exact rejection.
 */
export function parseHeadRevision(value: number): ParseResult<HeadRevision> {
	return isHeadRevision(value) ? ok(value) : invalid();
}

/**
 * Hashes a detached copy of exact blob bytes in the storage blob domain.
 * @param bytes - Input value.
 * @returns The domain-separated digest or exact rejection.
 */
export function digestBlob(bytes: Uint8Array): ParseResult<BlobDigest> {
	if (!(bytes instanceof Uint8Array)) return invalid();
	if (hasSharedBacking(bytes)) return { ok: false, reason: "SHARED_BUFFER_INPUT" };
	const copied = new Uint8Array(bytes);
	return ok(hex(hashDomain("ts-drp-storage/blob/v1", copied)) as BlobDigest);
}

/**
 * Hashes a validated digest-sorted closure in the storage closure domain.
 * @param closure - Input value.
 * @returns The domain-separated digest or exact rejection.
 */
export function digestClosure(closure: readonly GenerationRef[]): ParseResult<ClosureDigest> {
	const copied = copyClosure(closure);
	if (copied === undefined) return invalid();
	return ok(hex(hashDomain("ts-drp-storage/closure/v1", encodeCanonical(copied))) as ClosureDigest);
}

/**
 * Brands a revision after an internal invariant has established its validity.
 * @param value - Input value.
 * @returns The checked branded revision.
 */
export function checkedHeadRevision(value: number): HeadRevision {
	if (!isHeadRevision(value)) throw new TypeError("invalid internal head revision");
	return value;
}
