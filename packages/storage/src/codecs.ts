import { CanonicalDecodingError, encodeCanonical } from "@ts-drp/canonical";
import { decodeCanonicalExactness } from "@ts-drp/canonical/exact";

import {
	bytesEqual,
	copyExpectedHead,
	copyGenerationRecord,
	hasSharedBacking,
	isClosedRecord,
} from "./internal/validation.js";
import {
	type ExpectedHead,
	type GenerationRecord,
	AHE_BOUNDED_READ_LIMITS as LIMITS,
	type StoreResult,
} from "./types.js";
import { digestClosure } from "./values.js";
import { ExactBytesMemo } from "./internal/exact-bytes-memo.js";

type Envelope = {
	readonly storageSchemaVersion: number;
	readonly kind: string;
	readonly body: unknown;
};

function nonCanonical<T>(): StoreResult<T> {
	return { ok: false, reason: "NON_CANONICAL_RECORD" };
}

function decodeEnvelope(bytes: Uint8Array, bounded?: "head" | "generation"): StoreResult<Envelope> {
	if (!(bytes instanceof Uint8Array)) return nonCanonical();
	if (hasSharedBacking(bytes)) return { ok: false, reason: "SHARED_BUFFER_INPUT" };
	if (
		bounded !== undefined &&
		bytes.byteLength > (bounded === "head" ? LIMITS.maxHeadBytes : LIMITS.maxGenerationBytes)
	) {
		return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
	}
	const copied = new Uint8Array(bytes);
	let decoded: unknown;
	let exact = false;
	try {
		({ value: decoded, exact } = decodeCanonicalExactness(
			copied,
			bounded === undefined
				? undefined
				: {
						maxBytes: bounded === "head" ? LIMITS.maxHeadBytes : LIMITS.maxGenerationBytes,
						maxDepth: bounded === "head" ? 2 : 4,
						maxItems: bounded === "head" ? 33 : 127,
					}
		));
	} catch (cause) {
		if (bounded !== undefined && cause instanceof CanonicalDecodingError && cause.resourceLimit !== undefined) {
			return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
		}
		return nonCanonical();
	}
	if (!isClosedRecord(decoded, ["storageSchemaVersion", "kind", "body"])) return nonCanonical();
	if (
		typeof decoded.storageSchemaVersion !== "number" ||
		!Number.isSafeInteger(decoded.storageSchemaVersion) ||
		decoded.storageSchemaVersion < 1 ||
		typeof decoded.kind !== "string"
	) {
		return nonCanonical();
	}
	let reencoded: Uint8Array;
	if (
		bounded === "generation" &&
		typeof decoded.body === "object" &&
		decoded.body !== null &&
		"closure" in decoded.body &&
		Array.isArray(decoded.body.closure) &&
		decoded.body.closure.length > LIMITS.maxClosureReferences
	) {
		return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
	}
	// An exact decode guarantees this untouched value re-encodes to `copied`.
	if (!exact) {
		try {
			reencoded = encodeCanonical(decoded);
		} catch {
			return nonCanonical();
		}
		if (!bytesEqual(copied, reencoded)) return nonCanonical();
	}
	return {
		ok: true,
		value: {
			storageSchemaVersion: decoded.storageSchemaVersion,
			kind: decoded.kind,
			body: decoded.body,
		},
	};
}

function requireHead(value: unknown): ExpectedHead {
	const copied = copyExpectedHead(value);
	if (copied === undefined) throw new TypeError("head record is outside the closed v1 domain");
	return copied;
}

function requireGeneration(value: unknown): GenerationRecord {
	const copied = copyGenerationRecord(value);
	if (copied === undefined) throw new TypeError("generation record is outside the closed v1 domain");
	const digest = digestClosure(copied.closure);
	if (!digest.ok || digest.value !== copied.closureDigest) {
		throw new TypeError("generation closure digest does not match its closure");
	}
	return copied;
}

/**
 * Encodes one exact v1 head persistence envelope.
 * @param value - Input value.
 * @returns Canonical persistence bytes.
 */
export function encodeHeadRecordV1(value: ExpectedHead): Uint8Array {
	return encodeCanonical({ storageSchemaVersion: 1, kind: "head", body: requireHead(value) });
}

/**
 * Decodes one exact v1 head persistence envelope.
 * @param bytes - Input value.
 * @param bounded - Optional fixed observer decoding profile; ordinary callers retain defaults.
 * @returns The decoded head or a stable rejection.
 */
export function decodeHeadRecordV1(bytes: Uint8Array, bounded?: "head"): StoreResult<ExpectedHead> {
	return verifiedOnce(
		bounded === undefined ? heads : boundedHeads,
		bytes,
		bounded === undefined ? undefined : LIMITS.maxHeadBytes,
		() => decodeHeadRecordV1Uncached(bytes, bounded),
		(value) => copyExpectedHead(value)!
	);
}
function decodeHeadRecordV1Uncached(bytes: Uint8Array, bounded?: "head"): StoreResult<ExpectedHead> {
	const decoded = decodeEnvelope(bytes, bounded);
	if (!decoded.ok) return decoded;
	if (decoded.value.storageSchemaVersion !== 1 || decoded.value.kind !== "head") {
		return { ok: false, reason: "UNSUPPORTED_STORAGE_SCHEMA" };
	}
	try {
		return { ok: true, value: requireHead(decoded.value.body) };
	} catch {
		return nonCanonical();
	}
}

/**
 * Encodes one exact v1 generation persistence envelope.
 * @param value - Input value.
 * @returns Canonical persistence bytes.
 */
export function encodeGenerationRecordV1(value: GenerationRecord): Uint8Array {
	return encodeCanonical({ storageSchemaVersion: 1, kind: "generation", body: requireGeneration(value) });
}

/**
 * Decodes one exact v1 generation persistence envelope.
 * @param bytes - Input value.
 * @param bounded - Optional fixed observer decoding profile; ordinary callers retain defaults.
 * @returns The decoded generation or a stable rejection.
 */
export function decodeGenerationRecordV1(bytes: Uint8Array, bounded?: "generation"): StoreResult<GenerationRecord> {
	return verifiedOnce(
		bounded === undefined ? generations : boundedGenerations,
		bytes,
		bounded === undefined ? undefined : LIMITS.maxGenerationBytes,
		() => decodeGenerationRecordV1Uncached(bytes, bounded),
		(value) => copyGenerationRecord(value)!
	);
}
function decodeGenerationRecordV1Uncached(
	bytes: Uint8Array,
	bounded?: "generation"
): StoreResult<GenerationRecord> {
	const decoded = decodeEnvelope(bytes, bounded);
	if (!decoded.ok) return decoded;
	if (decoded.value.storageSchemaVersion !== 1 || decoded.value.kind !== "generation") {
		return { ok: false, reason: "UNSUPPORTED_STORAGE_SCHEMA" };
	}
	try {
		return { ok: true, value: requireGeneration(decoded.value.body) };
	} catch {
		return nonCanonical();
	}
}

// Verify once per exact bytes and decoding profile. A decode is a pure
// function of the exact bytes; only successful verifications are retained, and
// every call (hit or miss) returns a fresh detached copy, as before.
const heads = new ExactBytesMemo<ExpectedHead>(256, 512 * 1024, 65536),
	boundedHeads = new ExactBytesMemo<ExpectedHead>(256, 512 * 1024, LIMITS.maxHeadBytes),
	generations = new ExactBytesMemo<GenerationRecord>(256, 1024 * 1024, 65536),
	boundedGenerations = new ExactBytesMemo<GenerationRecord>(256, 1024 * 1024, LIMITS.maxGenerationBytes);

function verifiedOnce<T>(
	memo: ExactBytesMemo<T>,
	bytes: Uint8Array,
	limit: number | undefined,
	decode: () => StoreResult<T>,
	copy: (value: T) => T
): StoreResult<T> {
	// Inputs the original path refuses before decoding keep that exact path.
	if (!(bytes instanceof Uint8Array) || hasSharedBacking(bytes) || (limit !== undefined && bytes.byteLength > limit))
		return decode();
	const own = new Uint8Array(bytes),
		known = memo.get(own);
	if (known !== undefined) return { ok: true, value: copy(known) };
	const result = decode();
	if (result.ok) memo.set(own, copy(result.value));
	return result;
}
