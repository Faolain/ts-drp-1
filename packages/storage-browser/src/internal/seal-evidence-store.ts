import { compareBytes, decodeCanonical, hashDomain } from "@ts-drp/canonical";
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
	persistPeerEvidence(
		evidence: PeerSealEvidence
	): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>>;
	restorePeerEvidence(
		evidence: PeerSealEvidence
	): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>>;
	servePeerEvidence(objectId: string, epoch: number, signerId: string): Promise<PeerSealEvidence | null>;
}

export interface PeerSealEvidence {
	readonly carrier: Readonly<{
		readonly exactCanonicalPreimageBytes: Uint8Array;
		readonly signature: Uint8Array;
	}>;
	readonly exactCanonicalCommitQcBytes: Uint8Array;
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly exactCanonicalTrustStateRecordBytes: Uint8Array;
	readonly kind: "drp-creator-seal-evidence";
	readonly signerPublicKey: Uint8Array;
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
		!safeRevision(value.epoch) ||
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
		epoch: value.epoch,
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

function copiedPeerEvidence(value: unknown): PeerSealEvidence | undefined {
	if (!plainRecord(value) || Reflect.ownKeys(value).length !== 6 || value.kind !== "drp-creator-seal-evidence") {
		return undefined;
	}
	if (!plainRecord(value.carrier) || Reflect.ownKeys(value.carrier).length !== 2) return undefined;
	const preimage = exactBytes(value.carrier.exactCanonicalPreimageBytes);
	const signature = exactBytes(value.carrier.signature);
	const commitQc = exactBytes(value.exactCanonicalCommitQcBytes);
	const cut = exactBytes(value.exactCanonicalCutValueBytes);
	const trust = exactBytes(value.exactCanonicalTrustStateRecordBytes);
	const publicKey = exactBytes(value.signerPublicKey);
	if (
		preimage === undefined ||
		preimage === null ||
		signature === undefined ||
		signature === null ||
		signature.byteLength !== 64 ||
		commitQc === undefined ||
		commitQc === null ||
		cut === undefined ||
		cut === null ||
		trust === undefined ||
		trust === null ||
		publicKey === undefined ||
		publicKey === null ||
		publicKey.byteLength !== 32
	) {
		return undefined;
	}
	return Object.freeze({
		carrier: Object.freeze({ exactCanonicalPreimageBytes: preimage, signature }),
		exactCanonicalCommitQcBytes: commitQc,
		exactCanonicalCutValueBytes: cut,
		exactCanonicalTrustStateRecordBytes: trust,
		kind: "drp-creator-seal-evidence" as const,
		signerPublicKey: publicKey,
	});
}

function samePeerEvidence(left: PeerSealEvidence, right: PeerSealEvidence): boolean {
	return (
		compareBytes(left.carrier.exactCanonicalPreimageBytes, right.carrier.exactCanonicalPreimageBytes) === 0 &&
		compareBytes(left.carrier.signature, right.carrier.signature) === 0 &&
		compareBytes(left.exactCanonicalCommitQcBytes, right.exactCanonicalCommitQcBytes) === 0 &&
		compareBytes(left.exactCanonicalCutValueBytes, right.exactCanonicalCutValueBytes) === 0 &&
		compareBytes(left.exactCanonicalTrustStateRecordBytes, right.exactCanonicalTrustStateRecordBytes) === 0 &&
		compareBytes(left.signerPublicKey, right.signerPublicKey) === 0
	);
}

function peerIdentity(
	evidence: PeerSealEvidence
): Readonly<{ anchor: string; epoch: number; objectId: string; signerId: string; valueDigest: string }> | undefined {
	try {
		const vote = decodeCanonical(evidence.carrier.exactCanonicalPreimageBytes);
		const qc = decodeCanonical(evidence.exactCanonicalCommitQcBytes);
		const cut = decodeCanonical(evidence.exactCanonicalCutValueBytes);
		if (
			!plainRecord(vote) ||
			!plainRecord(qc) ||
			!plainRecord(cut) ||
			vote.kind !== "drp-seal-vote" ||
			vote.phase !== "commit" ||
			!safeRevision(vote.epoch) ||
			qc.kind !== "drp-seal-qc" ||
			qc.phase !== "commit" ||
			qc.objectId !== vote.objectId ||
			qc.epoch !== vote.epoch ||
			cut.kind !== "drp-hard-epoch-cut" ||
			cut.objectId !== vote.objectId ||
			cut.epoch !== vote.epoch ||
			typeof vote.objectId !== "string" ||
			typeof vote.signerId !== "string" ||
			typeof cut.previousAnchor !== "string" ||
			!digestHex.test(cut.previousAnchor)
		) {
			return undefined;
		}
		return Object.freeze({
			anchor: cut.previousAnchor,
			epoch: vote.epoch,
			objectId: vote.objectId,
			signerId: vote.signerId,
			valueDigest: Array.from(hashDomain("ts-drp/hard-epoch-cut/v3", evidence.exactCanonicalCutValueBytes), (byte) =>
				byte.toString(16).padStart(2, "0")
			).join(""),
		});
	} catch {
		return undefined;
	}
}

function peerEvidenceFromRow(value: unknown): PeerSealEvidence | undefined {
	return plainRecord(value) ? copiedPeerEvidence(value.peerEvidence) : undefined;
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
	const writePeerEvidence = async (
		value: PeerSealEvidence
	): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>> => {
		const evidence = copiedPeerEvidence(value);
		const identity = evidence === undefined ? undefined : peerIdentity(evidence);
		if (evidence === undefined || identity === undefined) {
			return Object.freeze({ ok: false as const, reason: "MALFORMED_EVIDENCE" });
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
		const key: [string, number, string] = [identity.objectId, identity.epoch, identity.signerId];
		const raw = await requestResult(store.get(key));
		const existing = copiedRecord(raw);
		const existingPeer = peerEvidenceFromRow(raw);
		if (existingPeer !== undefined && samePeerEvidence(existingPeer, evidence)) {
			await completion;
			return Object.freeze({ duplicate: true, ok: true as const });
		}
		const conflicts =
			raw !== undefined &&
			(existingPeer !== undefined ||
				existing === undefined ||
				existing.anchor !== identity.anchor ||
				existing.objectId !== identity.objectId ||
				existing.signerId !== identity.signerId ||
				existing.valueDigest !== identity.valueDigest ||
				compareBytes(existing.signerPublicKey, evidence.signerPublicKey) !== 0 ||
				compareBytes(existing.exactCanonicalCutValueBytes, evidence.exactCanonicalCutValueBytes) !== 0 ||
				existing.exactCanonicalCommitQcBytes === null ||
				compareBytes(existing.exactCanonicalCommitQcBytes, evidence.exactCanonicalCommitQcBytes) !== 0 ||
				existing.exactCanonicalTrustStateRecordBytes === null ||
				compareBytes(existing.exactCanonicalTrustStateRecordBytes, evidence.exactCanonicalTrustStateRecordBytes) !== 0);
		if (conflicts) {
			transaction.abort();
			try {
				await completion;
			} catch {
				// The mechanical owner returns the typed conflict below.
			}
			return Object.freeze({ ok: false as const, reason: "EVIDENCE_CONFLICT" });
		}
		const row =
			existing === undefined
				? { epoch: identity.epoch, objectId: identity.objectId, peerEvidence: evidence, signerId: identity.signerId }
				: { ...existing, peerEvidence: evidence };
		await requestResult(store.put(row));
		await completion;
		return Object.freeze({ duplicate: false, ok: true as const });
	};
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
			const key: [string, number, string] = [copied.objectId, copied.epoch, copied.signerId];
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
			const authored: CreatorCloseEvidenceRecord[] = [];
			for (const row of rows) {
				const copied = copiedRecord(row);
				if (copied !== undefined) authored.push(copied);
				else if (peerEvidenceFromRow(row) === undefined) throw new Error("invalid durable creator-close evidence");
			}
			return Object.freeze(authored);
		},
		persistPeerEvidence: writePeerEvidence,
		restorePeerEvidence: writePeerEvidence,
		async servePeerEvidence(objectId: string, epoch: number, signerId: string): Promise<PeerSealEvidence | null> {
			if (
				typeof objectId !== "string" ||
				objectId.length === 0 ||
				!safeRevision(epoch) ||
				typeof signerId !== "string" ||
				signerId.length === 0
			) {
				throw new TypeError("peer evidence identity is invalid");
			}
			const transaction = database.transaction(PHASE_5E_SEAL_EVIDENCE_STORE, "readonly");
			const row = await requestResult(
				transaction.objectStore(PHASE_5E_SEAL_EVIDENCE_STORE).get([objectId, epoch, signerId])
			);
			await transactionComplete(transaction);
			return peerEvidenceFromRow(row) ?? null;
		},
	});
}
