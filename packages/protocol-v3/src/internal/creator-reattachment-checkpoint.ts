import { compareBytes, encodeCanonical } from "@ts-drp/canonical";

import { decodeCanonicalWithExactness } from "./canonical-exactness.js";
import { CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES } from "./creator-settlement-limits.js";

// Pure reattachment syntax. It must not reach trust initialization: the signing
// request owner decodes it while the package index is still evaluating.

const REATTACHMENT_KEYS = Object.freeze([
	"kind", "version", "exactCanonicalPredecessorTrustStateRecordBytes",
	"exactCanonicalPredecessorAclBytes", "exactCanonicalPredecessorSettlementBytes",
]);

export function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	const actual = Reflect.ownKeys(value);
	return (
		actual.length === keys.length &&
		actual.every((key) => typeof key === "string" && keys.includes(key)) &&
		keys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor?.enumerable === true && "value" in descriptor;
		})
	);
}

export function copiedBytes(value: unknown, maximum = 65_536): Uint8Array | undefined {
	if (
		!(value instanceof Uint8Array) ||
		Object.getPrototypeOf(value) !== Uint8Array.prototype ||
		value.byteOffset !== 0 ||
		value.buffer.byteLength !== value.byteLength ||
		value.byteLength === 0 ||
		value.byteLength > maximum
	) {
		return undefined;
	}
	return Uint8Array.from(value);
}

/** Immutable transport syntax, not authority or a skipped-source classification. */
export interface CreatorReattachmentCheckpoint {
	readonly exactCanonicalPredecessorTrustStateRecordBytes: Uint8Array;
	readonly exactCanonicalPredecessorAclBytes: Uint8Array;
	readonly exactCanonicalPredecessorSettlementBytes: Uint8Array;
}

function reattachmentFields(input: CreatorReattachmentCheckpoint): Readonly<Record<string, unknown>> {
	return { kind: "creator-reattachment-checkpoint-1", version: 1, ...input };
}

/** Exact maximum of the existing trust, ACL and signed-settlement carrier limits. */
export const CREATOR_REATTACHMENT_CHECKPOINT_MAX_BYTES = encodeCanonical(reattachmentFields({
	exactCanonicalPredecessorTrustStateRecordBytes: new Uint8Array(8192),
	exactCanonicalPredecessorAclBytes: new Uint8Array(65_536),
	exactCanonicalPredecessorSettlementBytes: new Uint8Array(CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES),
})).byteLength;

/**
 * Decodes detached bounded syntax; the checkpoint and settlement owners still authenticate every carrier.
 * @param input - Exact canonical transport bytes.
 * @returns Copied predecessor carriers, or undefined for any malformed field.
 */
export function decodeCreatorReattachmentCheckpoint(input: unknown): CreatorReattachmentCheckpoint | undefined {
	try {
		const bytes = copiedBytes(input, CREATOR_REATTACHMENT_CHECKPOINT_MAX_BYTES);
		if (bytes === undefined) return undefined;
		const limits = { maxBytes: CREATOR_REATTACHMENT_CHECKPOINT_MAX_BYTES, maxDepth: 2, maxItems: 64 };
		const { value, exact } = decodeCanonicalWithExactness(bytes, limits);
		if (!plainRecord(value) || !exactKeys(value, REATTACHMENT_KEYS) ||
			value.kind !== "creator-reattachment-checkpoint-1" || value.version !== 1 ||
			(!exact && compareBytes(encodeCanonical(value, limits), bytes) !== 0)) return undefined;
		// The canonical decoder may return views into its captured input. These
		// freshly decoded fields cannot carry caller-defined accessors.
		const field = (value: unknown, maximum: number): Uint8Array | undefined =>
			value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= maximum
				? Uint8Array.from(value) : undefined;
		const trust = field(value.exactCanonicalPredecessorTrustStateRecordBytes, 8192);
		const acl = field(value.exactCanonicalPredecessorAclBytes, 65_536);
		const settlement = field(value.exactCanonicalPredecessorSettlementBytes, CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES);
		return trust === undefined || acl === undefined || settlement === undefined ? undefined : Object.freeze({
			exactCanonicalPredecessorTrustStateRecordBytes: trust,
			exactCanonicalPredecessorAclBytes: acl,
			exactCanonicalPredecessorSettlementBytes: settlement,
		});
	} catch { return undefined; }
}

/**
 * Encodes only the same bounded syntax accepted by the decoder, without granting checkpoint authority.
 * @param input - Predecessor carriers authenticated separately by the exporting owner.
 * @returns Exact detached transport bytes.
 */
export function encodeCreatorReattachmentCheckpoint(input: CreatorReattachmentCheckpoint): Uint8Array {
	if (!plainRecord(input) || !exactKeys(input, REATTACHMENT_KEYS.slice(2)))
		throw new TypeError("creator reattachment checkpoint fields are invalid");
	const bytes = encodeCanonical(reattachmentFields(input), {
		maxBytes: CREATOR_REATTACHMENT_CHECKPOINT_MAX_BYTES, maxDepth: 2, maxItems: 64,
	});
	if (decodeCreatorReattachmentCheckpoint(bytes) === undefined)
		throw new TypeError("creator reattachment checkpoint bounds are invalid");
	return bytes;
}
