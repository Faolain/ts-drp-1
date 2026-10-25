import {
	AHE_RETIREMENT_CONTROL_LIMITS,
	type AheRetirementControl,
	decodeAheRetirementControl,
	encodeAheRetirementControl,
	type StorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import {
	BoundedReadBudgetError,
	boundedRetirementAdmissionSteps,
	PersistedStorageError,
	type RetirementAdmission,
} from "@ts-drp/storage/adapter";
import type { DatabaseSync } from "node:sqlite";

import { loadNodeBoundedReadRequest } from "./bounded-read.js";
import { hasExpectedPhysicalSchema } from "./schema-sqlite.js";

/** A decoded native control and the exact row bytes it was verified from. */
export type NodeRetirementControlRecord = Readonly<{ control: AheRetirementControl; bytes: Uint8Array }>;

/**
 * Reads the exact addressed native row inside the caller's existing transaction.
 * @param connection - Owning native transaction connection.
 * @param objectId - Exact addressed owner.
 * @returns Detached validated control or native absence.
 */
export function readNodeRetirementControl(
	connection: DatabaseSync,
	objectId: StorageObjectId
): AheRetirementControl | null {
	return readNodeRetirementControlRecord(connection, objectId)?.control ?? null;
}

/**
 * Reads the exact addressed native row and keeps its exact bytes. The decoder
 * accepted those bytes only because they equal the canonical encoding of the
 * returned control, so callers compare these held bytes instead of encoding
 * the control again.
 * @param connection - Owning native transaction connection.
 * @param objectId - Exact addressed owner.
 * @returns Detached validated control with a private copy of its exact bytes, or native absence.
 */
export function readNodeRetirementControlRecord(
	connection: DatabaseSync,
	objectId: StorageObjectId
): NodeRetirementControlRecord | null {
	if (!hasExpectedPhysicalSchema(connection)) throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
	const row = connection
		.prepare(
			"SELECT CASE WHEN typeof(record)='blob' AND length(record)<=? THEN record ELSE NULL END AS record FROM retirement_controls WHERE object_id = ?"
		)
		.get(AHE_RETIREMENT_CONTROL_LIMITS.maxBytes, objectId);
	if (row === undefined) return null;
	if (!(row.record instanceof Uint8Array)) throw new PersistedStorageError("NON_CANONICAL_RECORD");
	const bytes = new Uint8Array(row.record),
		decoded = decodeAheRetirementControl(bytes);
	if (!decoded.ok || decoded.value.objectId !== objectId) throw new PersistedStorageError("NON_CANONICAL_RECORD");
	return Object.freeze({ control: decoded.value, bytes });
}

/**
 * Advances accounting/currency in the same transaction as the owning mutation.
 * @param connection - Owning native transaction connection.
 * @param control - Original native control observed by this transaction.
 */
export function advanceNodeRetirementControl(
	connection: DatabaseSync,
	control: AheRetirementControl | null
): StoreResult<void> {
	if (control === null) return { ok: true, value: undefined };
	if (control.revision === Number.MAX_SAFE_INTEGER) return { ok: false, reason: "REVISION_EXHAUSTED" };
	const bytes = encodeAheRetirementControl({ ...control, revision: control.revision + 1 });
	const admitted = admitNodeRetirementControl(connection, control.objectId, bytes);
	if (!admitted.ok) return admitted;
	const result = connection
		.prepare("UPDATE retirement_controls SET record = ? WHERE object_id = ?")
		.run(bytes, control.objectId);
	if (Number(result.changes) !== 1) throw new PersistedStorageError("NON_CANONICAL_RECORD");
	return { ok: true, value: undefined };
}

/**
 * Checks the complete addressed native image and proposed metadata charge.
 * Owns no transaction and grants no protocol or cross-store reservation authority.
 * @param connection - Caller-owned original transaction.
 * @param objectId - Exact native address.
 * @param bytes - Canonical proposed metadata from the sole codec owner, or observed native absence.
 * @returns Complete relative native admission or a typed refusal.
 */
export function admitNodeRetirementControl(
	connection: DatabaseSync,
	objectId: StorageObjectId,
	bytes: Uint8Array | null
): StoreResult<RetirementAdmission> {
	const steps = boundedRetirementAdmissionSteps(objectId, bytes?.byteLength ?? null, false);
	try {
		let step = steps.next();
		while (!step.done) step = steps.next(loadNodeBoundedReadRequest(connection, step.value));
		return step.value;
	} catch (cause) {
		if (cause instanceof BoundedReadBudgetError) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
		throw cause;
	}
}
