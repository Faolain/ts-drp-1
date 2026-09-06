import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";

import {
	bytesEqual,
	copyExpectedHead,
	copyGenerationRecord,
	hasSharedBacking,
	isClosedRecord,
} from "./internal/validation.js";
import type { ExpectedHead, GenerationRecord, StoreResult } from "./types.js";
import { digestClosure } from "./values.js";

type Envelope = {
	readonly storageSchemaVersion: number;
	readonly kind: string;
	readonly body: unknown;
};

function nonCanonical<T>(): StoreResult<T> {
	return { ok: false, reason: "NON_CANONICAL_RECORD" };
}

function decodeEnvelope(bytes: Uint8Array): StoreResult<Envelope> {
	if (!(bytes instanceof Uint8Array)) return nonCanonical();
	if (hasSharedBacking(bytes)) return { ok: false, reason: "SHARED_BUFFER_INPUT" };
	const copied = new Uint8Array(bytes);
	let decoded: unknown;
	try {
		decoded = decodeCanonical(copied);
	} catch {
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
	try {
		reencoded = encodeCanonical(decoded);
	} catch {
		return nonCanonical();
	}
	if (!bytesEqual(copied, reencoded)) return nonCanonical();
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
 * @returns The decoded head or a stable rejection.
 */
export function decodeHeadRecordV1(bytes: Uint8Array): StoreResult<ExpectedHead> {
	const decoded = decodeEnvelope(bytes);
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
 * @returns The decoded generation or a stable rejection.
 */
export function decodeGenerationRecordV1(bytes: Uint8Array): StoreResult<GenerationRecord> {
	const decoded = decodeEnvelope(bytes);
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
