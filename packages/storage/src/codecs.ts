import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";

import type { ExpectedHead, GenerationRecord, StoreResult } from "./types.js";

type Envelope = {
	readonly storageSchemaVersion: number;
	readonly kind: string;
	readonly body: unknown;
};

function decodeEnvelope(bytes: Uint8Array): StoreResult<Envelope> {
	try {
		return { ok: true, value: decodeCanonical(new Uint8Array(bytes)) as Envelope };
	} catch {
		return { ok: false, reason: "NON_CANONICAL_RECORD" };
	}
}

/**
 * RED scaffold: closed-domain validation is intentionally absent.
 * @param value
 */
export function encodeHeadRecordV1(value: ExpectedHead): Uint8Array {
	return encodeCanonical({ storageSchemaVersion: 1, kind: "head", body: value });
}

/**
 * RED scaffold: schema, kind, and closed-record validation are intentionally absent.
 * @param bytes
 */
export function decodeHeadRecordV1(bytes: Uint8Array): StoreResult<ExpectedHead> {
	const decoded = decodeEnvelope(bytes);
	if (!decoded.ok) return decoded;
	return { ok: true, value: decoded.value.body as ExpectedHead };
}

/**
 * RED scaffold: closed-domain validation is intentionally absent.
 * @param value
 */
export function encodeGenerationRecordV1(value: GenerationRecord): Uint8Array {
	return encodeCanonical({ storageSchemaVersion: 1, kind: "generation", body: value });
}

/**
 * RED scaffold: schema, kind, and closed-record validation are intentionally absent.
 * @param bytes
 */
export function decodeGenerationRecordV1(bytes: Uint8Array): StoreResult<GenerationRecord> {
	const decoded = decodeEnvelope(bytes);
	if (!decoded.ok) return decoded;
	return { ok: true, value: decoded.value.body as GenerationRecord };
}
