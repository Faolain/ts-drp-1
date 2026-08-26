import { compareBytes } from "@ts-drp/canonical";
import {
	copyCreatorCloseEvidenceRecord,
	type CreatorCloseEvidencePhase,
	type CreatorCloseEvidenceRecord,
} from "@ts-drp/seal/internal/creator-close-intent";

import {
	openPhase2dInternalDatabase,
	PHASE_5C_STORAGE_META_STORE,
	PHASE_5E_SEAL_EVIDENCE_STORE,
} from "./schema-idb.js";

const phases = new Set<CreatorCloseEvidencePhase>([
	"commit-qc-committed",
	"commit-vote-pending",
	"commit-voted",
	"evidence-committed",
	"finalized",
	"prepare-voted",
	"prepared",
]);
const digestHex = /^[0-9a-f]{64}$/u;

export interface InternalSealEvidenceStore {
	readonly incarnation: string;
	close(): void;
	put(
		record: CreatorCloseEvidenceRecord,
		expectedPhase: CreatorCloseEvidencePhase | null
	): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>>;
	readAll(): Promise<readonly CreatorCloseEvidenceRecord[]>;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function safeRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exactBytes(value: unknown, nullable = false): Uint8Array | null | undefined {
	if (nullable && value === null) return null;
	if (!(value instanceof Uint8Array) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
		return undefined;
	}
	return Uint8Array.from(value);
}

function copiedRecord(value: unknown): CreatorCloseEvidenceRecord | undefined {
	if (!plainRecord(value)) return undefined;
	const cut = exactBytes(value.exactCanonicalCutValueBytes);
	const prepare = exactBytes(value.exactCanonicalPrepareQcBytes, true);
	const commit = exactBytes(value.exactCanonicalCommitQcBytes, true);
	const trust = exactBytes(value.exactCanonicalTrustStateRecordBytes, true);
	const signerPublicKey = exactBytes(value.signerPublicKey);
	if (
		cut === undefined ||
		cut === null ||
		prepare === undefined ||
		commit === undefined ||
		trust === undefined ||
		signerPublicKey === undefined ||
		signerPublicKey === null ||
		signerPublicKey.byteLength !== 32 ||
		typeof value.anchor !== "string" ||
		!digestHex.test(value.anchor) ||
		value.epoch !== 0 ||
		typeof value.objectId !== "string" ||
		typeof value.phase !== "string" ||
		!phases.has(value.phase as CreatorCloseEvidencePhase) ||
		!safeRevision(value.revision) ||
		typeof value.signerId !== "string" ||
		typeof value.storageIncarnation !== "string" ||
		typeof value.valueDigest !== "string" ||
		!digestHex.test(value.valueDigest)
	) {
		return undefined;
	}
	return copyCreatorCloseEvidenceRecord({
		anchor: value.anchor,
		epoch: 0,
		exactCanonicalCommitQcBytes: commit,
		exactCanonicalCutValueBytes: cut,
		exactCanonicalPrepareQcBytes: prepare,
		exactCanonicalTrustStateRecordBytes: trust,
		objectId: value.objectId,
		phase: value.phase as CreatorCloseEvidencePhase,
		revision: value.revision,
		signerId: value.signerId,
		signerPublicKey,
		storageIncarnation: value.storageIncarnation,
		valueDigest: value.valueDigest,
	});
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("transaction aborted")), {
			once: true,
		});
		transaction.addEventListener("error", () => reject(transaction.error ?? new Error("transaction failed")), {
			once: true,
		});
	});
}

function sameRecord(left: CreatorCloseEvidenceRecord, right: CreatorCloseEvidenceRecord): boolean {
	return (
		left.anchor === right.anchor &&
		left.epoch === right.epoch &&
		left.objectId === right.objectId &&
		left.phase === right.phase &&
		left.revision === right.revision &&
		left.signerId === right.signerId &&
		compareBytes(left.signerPublicKey, right.signerPublicKey) === 0 &&
		left.storageIncarnation === right.storageIncarnation &&
		left.valueDigest === right.valueDigest &&
		compareBytes(left.exactCanonicalCutValueBytes, right.exactCanonicalCutValueBytes) === 0 &&
		((left.exactCanonicalPrepareQcBytes === null && right.exactCanonicalPrepareQcBytes === null) ||
			(left.exactCanonicalPrepareQcBytes !== null &&
				right.exactCanonicalPrepareQcBytes !== null &&
				compareBytes(left.exactCanonicalPrepareQcBytes, right.exactCanonicalPrepareQcBytes) === 0)) &&
		((left.exactCanonicalCommitQcBytes === null && right.exactCanonicalCommitQcBytes === null) ||
			(left.exactCanonicalCommitQcBytes !== null &&
				right.exactCanonicalCommitQcBytes !== null &&
				compareBytes(left.exactCanonicalCommitQcBytes, right.exactCanonicalCommitQcBytes) === 0)) &&
		((left.exactCanonicalTrustStateRecordBytes === null && right.exactCanonicalTrustStateRecordBytes === null) ||
			(left.exactCanonicalTrustStateRecordBytes !== null &&
				right.exactCanonicalTrustStateRecordBytes !== null &&
				compareBytes(left.exactCanonicalTrustStateRecordBytes, right.exactCanonicalTrustStateRecordBytes) === 0))
	);
}

/**
 * Opens the strict mechanical creator-close evidence adapter on the primary database.
 * @param input - Exact primary database identity.
 * @returns Internal evidence store bound to the durable storage incarnation.
 */
export async function openInternalSealEvidenceStore(
	input: Readonly<{ databaseName: string }>
): Promise<InternalSealEvidenceStore> {
	const connection = { database: undefined as IDBDatabase | undefined };
	const database = (await openPhase2dInternalDatabase({ databaseName: input.databaseName }, () => {
		connection.database?.close();
	})) as IDBDatabase;
	connection.database = database;
	const metaTransaction = database.transaction(PHASE_5C_STORAGE_META_STORE, "readonly");
	const meta = await requestResult(metaTransaction.objectStore(PHASE_5C_STORAGE_META_STORE).get("incarnation"));
	await transactionComplete(metaTransaction);
	if (!plainRecord(meta) || meta.key !== "incarnation" || typeof meta.value !== "string" || meta.value.length < 32) {
		database.close();
		throw new Error("invalid storage incarnation row");
	}
	const incarnation = meta.value;
	return Object.freeze({
		close: () => database.close(),
		incarnation,
		async put(
			record: CreatorCloseEvidenceRecord,
			expectedPhase: CreatorCloseEvidencePhase | null
		): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>> {
			const copied = copiedRecord(record);
			if (copied === undefined || copied.storageIncarnation !== incarnation) {
				return Object.freeze({ ok: false as const, reason: "STORAGE_LOSS" });
			}
			const transaction = database.transaction(PHASE_5E_SEAL_EVIDENCE_STORE, "readwrite", {
				durability: "strict",
			});
			if (transaction.durability !== "strict") {
				transaction.abort();
				throw new Error("strict IndexedDB durability is unavailable");
			}
			const completion = transactionComplete(transaction);
			const store = transaction.objectStore(PHASE_5E_SEAL_EVIDENCE_STORE);
			const key: [string, 0, string] = [copied.objectId, 0, copied.signerId];
			const existing = copiedRecord(await requestResult(store.get(key)));
			if (existing !== undefined && sameRecord(existing, copied)) {
				await completion;
				return Object.freeze({ duplicate: true, ok: true as const });
			}
			if (
				(expectedPhase === null && existing !== undefined) ||
				(expectedPhase !== null && existing?.phase !== expectedPhase) ||
				(existing !== undefined &&
					(existing.anchor !== copied.anchor ||
						existing.objectId !== copied.objectId ||
						existing.signerId !== copied.signerId ||
						compareBytes(existing.signerPublicKey, copied.signerPublicKey) !== 0 ||
						existing.storageIncarnation !== copied.storageIncarnation ||
						existing.valueDigest !== copied.valueDigest ||
						compareBytes(existing.exactCanonicalCutValueBytes, copied.exactCanonicalCutValueBytes) !== 0))
			) {
				transaction.abort();
				try {
					await completion;
				} catch {
					// The semantic owner receives a typed conflict below.
				}
				return Object.freeze({ ok: false as const, reason: "EVIDENCE_CONFLICT" });
			}
			await requestResult(store.put(copyCreatorCloseEvidenceRecord(copied)));
			await completion;
			return Object.freeze({ duplicate: false, ok: true as const });
		},
		async readAll(): Promise<readonly CreatorCloseEvidenceRecord[]> {
			const transaction = database.transaction(PHASE_5E_SEAL_EVIDENCE_STORE, "readonly");
			const rows = await requestResult(transaction.objectStore(PHASE_5E_SEAL_EVIDENCE_STORE).getAll());
			await transactionComplete(transaction);
			return Object.freeze(
				rows.map((row) => {
					const copied = copiedRecord(row);
					if (copied === undefined) throw new Error("invalid durable creator-close evidence");
					return copied;
				})
			);
		},
	});
}
