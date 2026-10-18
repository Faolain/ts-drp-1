import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type AccumulatorSnapshot, CompactMerkleAccumulator } from "@ts-drp/compaction";
import { AHE_BOUNDED_READ_LIMITS, digestBlob, type GenerationRef } from "@ts-drp/storage";

import { canonicalCreatorDataRecord } from "./creator-snapshot-data.js";

export const CREATOR_CLOSE_HISTORY_KIND = "creator-close-history-1" as const;

/** Same native history schema for encoded bytes and scalar resource slots.
 * This projection does not authenticate an accumulator or close commitment. */
export function creatorCloseHistoryFields(cutValueDigest: unknown, compactHistory: unknown): Readonly<Record<string, unknown>> {
	return {kind: CREATOR_CLOSE_HISTORY_KIND, cutValueDigest, compactHistory};
}
const MAX_LEVELS = Number.MAX_SAFE_INTEGER.toString(2).length;
// The maximal valid compact accumulator has one 32-byte peak per safe-integer bit.
// This derives an exact schema ceiling, independently of any executed workload.
export const CREATOR_CLOSE_HISTORY_MAX_BYTES = encodeCanonical(creatorCloseHistoryFields("0".repeat(64), {
		size: Number.MAX_SAFE_INTEGER,
		peaks: Array.from({ length: MAX_LEVELS }, () => new Uint8Array(32)),
})).byteLength;
const LIMITS = { maxBytes: CREATOR_CLOSE_HISTORY_MAX_BYTES, maxDepth: 4, maxItems: MAX_LEVELS * 2 + 16 };
function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Captures bounded native history and authenticates its exact signed Cut commitment.
 * @param input Exact native history bytes and the independently authenticated Cut commitment.
 * @returns A detached authenticated accumulator snapshot, or undefined on any mismatch.
 */
export function openCreatorCloseHistory(
	input: Readonly<{
		bytes: Uint8Array;
		exactCanonicalCutValueBytes: Uint8Array;
		historyRoot: unknown;
		historySize: unknown;
	}>
): AccumulatorSnapshot | undefined {
	try {
		const value = decodeCanonical(input.bytes, LIMITS) as Record<string, unknown>;
		if (
			value === null ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).sort().join(",") !== "compactHistory,cutValueDigest,kind" ||
			value.kind !== CREATOR_CLOSE_HISTORY_KIND ||
			value.cutValueDigest !== hex(hashDomain("ts-drp/hard-epoch-cut/v3", input.exactCanonicalCutValueBytes)) ||
			compareBytes(input.bytes, encodeCanonical(value, LIMITS)) !== 0
		)
			return undefined;
		const snapshot = value.compactHistory as AccumulatorSnapshot;
		if (
			snapshot === null ||
			typeof snapshot !== "object" ||
			Array.isArray(snapshot) ||
			Object.keys(snapshot).sort().join(",") !== "peaks,size"
		)
			return undefined;
		const accumulator = CompactMerkleAccumulator.fromSnapshot(snapshot);
		if (accumulator.size !== input.historySize || hex(accumulator.root()) !== input.historyRoot) return undefined;
		return accumulator.snapshot();
	} catch {
		return undefined;
	}
}

/**
 * Emits only the fixed compact-history native control schema.
 * @param cutValueDigest The exact signed Cut's domain-separated digest.
 * @param snapshot The native close accumulator snapshot.
 * @returns Canonical bytes within the statically derived compact-history ceiling.
 */
export function encodeCreatorCloseHistory(cutValueDigest: string, snapshot: AccumulatorSnapshot): Uint8Array {
	if (!/^[0-9a-f]{64}$/u.test(cutValueDigest)) throw new TypeError("creator close history digest is invalid");
	const compactHistory = CompactMerkleAccumulator.fromSnapshot(snapshot).snapshot();
	return encodeCanonical(creatorCloseHistoryFields(cutValueDigest, compactHistory), LIMITS);
}

/**
 * Recovers the exact close companion already committed by an adopted projection.
 * This checks history identity, not Cut signatures; callers authenticate the chain.
 * @param input Exact native projection and independently authenticated Cut bytes.
 * @returns The identical bounded history companion, or undefined on disagreement.
 */
export function deriveCreatorCloseHistory(
	input: Readonly<{ exactCanonicalProjectionBytes: Uint8Array; exactCanonicalCutValueBytes: Uint8Array }>
): Readonly<{ bytes: Uint8Array; ref: GenerationRef }> | undefined {
	try {
		if (
			input.exactCanonicalProjectionBytes.byteLength > AHE_BOUNDED_READ_LIMITS.maxBlobBytes ||
			input.exactCanonicalCutValueBytes.byteLength > AHE_BOUNDED_READ_LIMITS.maxBlobBytes
		)
			return undefined;
		const projection = canonicalCreatorDataRecord(input.exactCanonicalProjectionBytes);
		const cut = canonicalCreatorDataRecord(input.exactCanonicalCutValueBytes);
		if (
			projection?.kind !== "v3-live-generation-2" ||
			projection.version !== 2 ||
			cut?.kind !== "drp-hard-epoch-cut" ||
			projection.objectId !== cut.objectId ||
			typeof cut.epoch !== "number" ||
			!Number.isSafeInteger(cut.epoch) ||
			cut.epoch < 0 ||
			!Number.isSafeInteger(cut.epoch + 1) ||
			projection.epoch !== cut.epoch + 1 ||
			projection.historyRoot !== cut.historyRoot ||
			projection.historySize !== cut.historySize
		)
			return undefined;
		const snapshot = projection.compactHistory;
		if (
			snapshot === null ||
			typeof snapshot !== "object" ||
			Array.isArray(snapshot) ||
			Object.keys(snapshot).sort().join(",") !== "peaks,size"
		)
			return undefined;
		const bytes = encodeCreatorCloseHistory(
			hex(hashDomain("ts-drp/hard-epoch-cut/v3", input.exactCanonicalCutValueBytes)),
			snapshot as AccumulatorSnapshot
		);
		if (
			openCreatorCloseHistory({
				bytes,
				exactCanonicalCutValueBytes: input.exactCanonicalCutValueBytes,
				historyRoot: cut.historyRoot,
				historySize: cut.historySize,
			}) === undefined
		)
			return undefined;
		const digest = digestBlob(bytes);
		return digest.ok
			? Object.freeze({ bytes, ref: Object.freeze({ digest: digest.value, byteLength: bytes.byteLength }) })
			: undefined;
	} catch {
		return undefined;
	}
}
