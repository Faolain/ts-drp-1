import {openSigningBackend, type SigningBackend} from "./signing-backend.js";
import { compareBytes } from "@ts-drp/canonical";
import {
	copyCreatorCloseEvidenceRecord,
	type CreatorCloseEvidencePhase,
	type CreatorCloseEvidenceRecord,
} from "@ts-drp/seal/internal/creator-close-intent";
import {
	evidencePlainRecord as plainRecord,
	evidenceSafeRevision as safeRevision,
	copyStoredCreatorCloseEvidenceRecord as copiedRecord,
	copyStoredPeerSealEvidence as copiedPeerEvidence,
	sameStoredPeerSealEvidence as samePeerEvidence,
	storedPeerSealIdentity as peerIdentity,
	storedPeerSealEvidenceFromRow as peerEvidenceFromRow,
	storedCreatorEvidenceQcRound as recordQcRound,
	sameStoredCreatorCloseEvidenceRecord as sameRecord,
	type PeerSealEvidence,
	type SigningDependencyObservation,
	type SigningRetirementObservation,
} from "@ts-drp/seal/internal/storage-port";
export type { PeerSealEvidence } from "@ts-drp/seal/internal/storage-port";

import {
	PHASE_5E_SEAL_EVIDENCE_STORE,
} from "./schema-idb.js";
import { readSigningFrontier, VOTE_TRANSACTION_STORES } from "./seal-vote-store.js";
import { signingMutationRefusal } from "./signing-retirement.js";

export interface InternalSealEvidenceStore {
	acquireSigningDependencyObservation(input: Readonly<{ objectId: string }>): Promise<SigningDependencyObservation>;
	readonly incarnation: string;
	close(): Promise<void>;
	acquireRetirementObservation(input: Readonly<{ objectId: string }>): Promise<SigningRetirementObservation>;
	acquireRecoveryRetirementObservation(input: Readonly<{ objectId: string }>): Promise<SigningRetirementObservation>;
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

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	const completion = new Promise<void>((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("transaction aborted")), {
			once: true,
		});
		transaction.addEventListener("error", () => reject(transaction.error ?? new Error("transaction failed")), {
			once: true,
		});
	});
	void completion.catch(() => undefined);
	return completion;
}

/**
 * Opens the strict mechanical creator-close evidence adapter on the primary database.
 * @param input - Exact primary database identity.
 * @returns Internal evidence store bound to the durable storage incarnation.
 */
export async function openInternalSealEvidenceStore(
	input: Readonly<{ databaseName: string }>,
	room = false
): Promise<InternalSealEvidenceStore> {
	return createInternalSealEvidenceStore(await openSigningBackend(input, room));
}

/** Builds only mechanical storage methods over the original private backend. */
export function createInternalSealEvidenceStore(backend: SigningBackend, sharedDependencies = false): InternalSealEvidenceStore {
	const {database, incarnation, participant} = backend;
	const writePeerEvidence = async (
		value: PeerSealEvidence
	): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>> => {
		const evidence = copiedPeerEvidence(value);
		const identity = evidence === undefined ? undefined : peerIdentity(evidence);
		if (evidence === undefined || identity === undefined) {
			return Object.freeze({ ok: false as const, reason: "MALFORMED_EVIDENCE" });
		}
		const transaction = database.transaction([...VOTE_TRANSACTION_STORES], "readwrite", {
			durability: "strict",
		});
		if (transaction.durability !== "strict") {
			transaction.abort();
			throw new Error("strict IndexedDB durability is unavailable");
		}
		const completion = transactionComplete(transaction);
		const floor = await readSigningFrontier(transaction, identity, incarnation);
		const refusal = await signingMutationRefusal(transaction, identity.objectId, identity.epoch, incarnation);
		if (refusal !== undefined || identity.round < floor) {
			transaction.abort();
			try {
				await completion;
			} catch {
				/* Typed refusal only after native abort. */
			}
			return Object.freeze({ ok: false as const, reason: refusal ?? "SIGNING_RETIRED" });
		}
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
		close: () => participant.close(),
		acquireRetirementObservation: (input: Readonly<{ objectId: string }>) =>
			sharedDependencies ? participant.acquireSharedRetirement(input, "evidence") : participant.acquire(input),
		acquireRecoveryRetirementObservation: (input: Readonly<{ objectId: string }>) =>
			sharedDependencies ? participant.acquireSharedRetirement(input, "evidence", true) : participant.acquireRecovery(input),
		acquireSigningDependencyObservation: (input: Readonly<{ objectId: string }>) =>
			sharedDependencies ? participant.acquireSharedDependency(input, "evidence") : participant.acquireDependency(input),
		incarnation,
		async put(
			record: CreatorCloseEvidenceRecord,
			expectedPhase: CreatorCloseEvidencePhase | null
		): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>> {
			const copied = copiedRecord(record);
			if (copied === undefined || copied.storageIncarnation !== incarnation) {
				return Object.freeze({ ok: false as const, reason: "STORAGE_LOSS" });
			}
			const transaction = database.transaction([...VOTE_TRANSACTION_STORES], "readwrite", {
				durability: "strict",
			});
			if (transaction.durability !== "strict") {
				transaction.abort();
				throw new Error("strict IndexedDB durability is unavailable");
			}
			const completion = transactionComplete(transaction);
			const floor = await readSigningFrontier(transaction, copied, incarnation);
			const round = recordQcRound(copied);
			const refusal = await signingMutationRefusal(transaction, copied.objectId, copied.epoch, incarnation);
			if (refusal !== undefined || (floor > 0 && (round === undefined || round < floor))) {
				transaction.abort();
				try {
					await completion;
				} catch {
					/* Typed refusal only after native abort. */
				}
				return Object.freeze({
					ok: false as const,
					reason: refusal ?? (round === undefined ? "UNCLASSIFIED_SIGNING_EVIDENCE" : "SIGNING_RETIRED"),
				});
			}
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
