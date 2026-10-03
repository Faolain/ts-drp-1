import { decodeGenerationRecordV1, decodeHeadRecordV1 } from "../codecs.js";
import {
	type ExpectedHead,
	type GenerationRecord,
	AHE_BOUNDED_READ_LIMITS as LIMITS,
	type StorageObjectId,
} from "../types.js";
import { hasSharedBacking } from "./validation.js";

type PersistedStorageReason = "NON_CANONICAL_RECORD" | "UNSUPPORTED_STORAGE_SCHEMA";
type PersistedReadReason = PersistedStorageReason | "READ_BUDGET_EXCEEDED";

type PersistedGenerationRow = Readonly<{
	objectId: unknown;
	generationId: unknown;
	record: unknown;
}>;

type PersistedHeadRow = Readonly<{ objectId: unknown; record: unknown }> | null;

type PersistedStateSource =
	| Readonly<{ kind: "head"; objectId: StorageObjectId; row: PersistedHeadRow }>
	| Readonly<{ kind: "generation"; objectId: StorageObjectId; row: PersistedGenerationRow }>;

type ClassifiedPersistedState =
	| Readonly<{ kind: "head"; head: ExpectedHead; record: Uint8Array | null }>
	| Readonly<{ kind: "generation"; generation: GenerationRecord; record: Uint8Array }>;

/** A semantic persisted-state failure, kept distinct from substrate exceptions. */
export class PersistedStorageError extends Error {
	/**
	 * Creates an internal semantic failure.
	 * @param reason - Stable persisted-state rejection reason.
	 */
	public constructor(public readonly reason: PersistedStorageReason) {
		super(reason);
		this.name = "PersistedStorageError";
	}
}

type PersistedClassification<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; reason: PersistedReadReason }>;

function persistedFailure<T>(reason: PersistedStorageReason): PersistedClassification<T> {
	return { ok: false, reason };
}

function copyPersistedBytes(value: unknown): Uint8Array | undefined {
	return value instanceof Uint8Array && !hasSharedBacking(value) ? new Uint8Array(value) : undefined;
}

/**
 * Classifies one persisted head row and detaches its canonical value and bytes.
 * @param objectId - Object whose physical row was addressed.
 * @param row - Raw physical head row, or null when absent.
 * @param bounded - Admit bytes/decode through the fixed bounded observer profile.
 * @returns Detached canonical head or its stable persisted rejection.
 */
function classifyPersistedHead(
	objectId: StorageObjectId,
	row: PersistedHeadRow,
	bounded?: "bounded-active-read"
): PersistedClassification<Readonly<{ head: ExpectedHead; record: Uint8Array | null }>> {
	if (row === null) return { ok: true, value: { head: { kind: "none", objectId }, record: null } };
	if (row.record === null) {
		return row.objectId === objectId
			? { ok: true, value: { head: { kind: "none", objectId }, record: null } }
			: persistedFailure("NON_CANONICAL_RECORD");
	}
	if (bounded !== undefined && row.record instanceof Uint8Array && row.record.byteLength > LIMITS.maxHeadBytes)
		return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
	const record =
		bounded !== undefined && row.record instanceof Uint8Array && !hasSharedBacking(row.record)
			? row.record
			: copyPersistedBytes(row.record);
	if (record === undefined) return persistedFailure("NON_CANONICAL_RECORD");
	const decoded = decodeHeadRecordV1(record, bounded === undefined ? undefined : "head");
	if (!decoded.ok) {
		if (bounded !== undefined && decoded.reason === "READ_BUDGET_EXCEEDED")
			return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
		return persistedFailure(decoded.reason === "UNSUPPORTED_STORAGE_SCHEMA" ? decoded.reason : "NON_CANONICAL_RECORD");
	}
	if (row.objectId !== objectId || decoded.value.kind !== "present" || decoded.value.objectId !== objectId) {
		return persistedFailure("NON_CANONICAL_RECORD");
	}
	return { ok: true, value: { head: decoded.value, record } };
}

/**
 * Classifies one physically keyed generation row and detaches its canonical value and bytes.
 * @param objectId - Object whose physical range was addressed.
 * @param row - Raw physical generation row.
 * @param bounded - Admit bytes/decode through the fixed bounded observer profile.
 * @returns Detached canonical generation or its stable persisted rejection.
 */
function classifyPersistedGeneration(
	objectId: StorageObjectId,
	row: PersistedGenerationRow,
	bounded?: "bounded-active-read"
): PersistedClassification<Readonly<{ generation: GenerationRecord; record: Uint8Array }>> {
	if (bounded !== undefined && row.record instanceof Uint8Array && row.record.byteLength > LIMITS.maxGenerationBytes)
		return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
	const record =
		bounded !== undefined && row.record instanceof Uint8Array && !hasSharedBacking(row.record)
			? row.record
			: copyPersistedBytes(row.record);
	if (record === undefined) return persistedFailure("NON_CANONICAL_RECORD");
	const decoded = decodeGenerationRecordV1(record, bounded === undefined ? undefined : "generation");
	if (!decoded.ok) {
		if (bounded !== undefined && decoded.reason === "READ_BUDGET_EXCEEDED")
			return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
		return persistedFailure(decoded.reason === "UNSUPPORTED_STORAGE_SCHEMA" ? decoded.reason : "NON_CANONICAL_RECORD");
	}
	if (
		row.objectId !== objectId ||
		decoded.value.objectId !== objectId ||
		row.generationId !== decoded.value.generationId
	) {
		return persistedFailure("NON_CANONICAL_RECORD");
	}
	return { ok: true, value: { generation: decoded.value, record } };
}

/**
 * Classifies one tagged persisted head, generation or full-journal source.
 * This is the strict backends' only semantic persisted-state entrypoint.
 * @param source - Raw physical rows or one direct adapter fact.
 * @returns Detached canonical state or its stable persisted rejection.
 */
export function classifyPersistedState(
	source: PersistedStateSource
): Readonly<{ ok: true; value: ClassifiedPersistedState }> | Readonly<{ ok: false; reason: PersistedStorageReason }>;
/**
 * Classifies the same persisted domain under the fixed observer entitlement.
 * @param source - Raw physical row in its exact addressed scope.
 * @param bounded - Fixed bounded-active observer profile.
 * @returns Detached semantic state or labelled persisted/resource refusal.
 */
export function classifyPersistedState(
	source: PersistedStateSource,
	bounded: "bounded-active-read"
): PersistedClassification<ClassifiedPersistedState>;
/**
 * Owns ordinary and bounded persisted classification without changing ordinary defaults.
 * Bounded callers consume native buffers within the transaction instead of retaining a second byte copy.
 * @param source - Raw physical row in its exact addressed scope.
 * @param bounded - Optional fixed bounded-active observer profile.
 * @returns Detached semantic state or labelled persisted/resource refusal.
 */
export function classifyPersistedState(
	source: PersistedStateSource,
	bounded?: "bounded-active-read"
): PersistedClassification<ClassifiedPersistedState> {
	if (source.kind === "head") {
		const classified = classifyPersistedHead(source.objectId, source.row, bounded);
		return classified.ok ? { ok: true, value: { kind: "head", ...classified.value } } : classified;
	}
	const classified = classifyPersistedGeneration(source.objectId, source.row, bounded);
	return classified.ok ? { ok: true, value: { kind: "generation", ...classified.value } } : classified;
}
