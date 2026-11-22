import { compareBytes } from "@ts-drp/canonical";
import {
	copyCreatorCloseEvidenceRecord,
	mintCreatorCloseEvidenceStore,
	type CreatorCloseEvidencePhase,
	type CreatorCloseEvidenceRecord,
	type CreatorCloseEvidenceStore,
} from "@ts-drp/seal/internal/creator-close-intent";
import {
	copyStoredCreatorCloseEvidenceRecord,
	copyStoredPeerSealEvidence,
	evidenceSafeRevision,
	sameStoredCreatorCloseEvidenceRecord,
	sameStoredPeerSealEvidence,
	storedCreatorEvidenceQcRound,
	storedPeerSealEvidenceFromRow,
	storedPeerSealIdentity,
	type PeerSealEvidence,
} from "@ts-drp/seal/internal/storage-port";

import { acquireSqliteSigningLease, type NodeSigningStoreOptions } from "./internal/signing-lease.js";
import type { LocalSessionLifetime } from "./internal/local-session-lifetime.js";
import {
	readSqliteSigningFrontier,
	readSqliteSigningImage,
	sqliteSigningMutationRefusal,
} from "./internal/signing-retirement.js";

export type { NodeSigningStoreOptions } from "./internal/signing-lease.js";
export type { PeerSealEvidence } from "@ts-drp/seal/internal/storage-port";
type WriteResult = Readonly<{ ok: true; duplicate: boolean } | { ok: false; reason: string }>;
export interface NodeSealEvidenceStore {
	readonly observation: Readonly<{ incarnation: string; evidenceCount: number }>;
	readonly store: CreatorCloseEvidenceStore;
	persistPeerEvidence(input: Readonly<{ evidence: PeerSealEvidence }>): Promise<WriteResult>;
	restorePeerEvidence(input: Readonly<{ evidence: PeerSealEvidence }>): Promise<WriteResult>;
	servePeerEvidence(
		input: Readonly<{ objectId: string; signerId: string; epoch?: number }>
	): Promise<PeerSealEvidence | null>;
	close(): Promise<void>;
}

/**
 * Actual SQLite evidence custody under the existing protocol evidence owner.
 * Structural record validation is not signature or source authentication.
 * @param options - Host-selected file and explicit create/reopen policy.
 * @returns Opaque evidence store, observation and joined alias close.
 */
export async function openNodeSealEvidenceStore(options: NodeSigningStoreOptions, session?: LocalSessionLifetime): Promise<NodeSealEvidenceStore> {
	const lease = acquireSqliteSigningLease(options, session),
		{ database, retirement } = lease;
	const readAll = (): Promise<readonly CreatorCloseEvidenceRecord[]> =>
		lease.run(false, () => {
			const authored: CreatorCloseEvidenceRecord[] = [];
			for (const { value } of database.allRows("sealEvidence")) {
				const copied = copyStoredCreatorCloseEvidenceRecord(value);
				if (copied !== undefined) authored.push(copied);
				else if (storedPeerSealEvidenceFromRow(value) === undefined)
					throw new Error("invalid durable creator-close evidence");
			}
			return Object.freeze(authored);
		});
	const put = (
		record: CreatorCloseEvidenceRecord,
		expectedPhase: CreatorCloseEvidencePhase | null
	): Promise<WriteResult> => {
		const copied = copyStoredCreatorCloseEvidenceRecord(record);
		if (copied === undefined || copied.storageIncarnation !== database.incarnation)
			return lease.run(false, () => ({ ok: false as const, reason: "STORAGE_LOSS" }));
		return lease.run(true, () => {
			const floor = readSqliteSigningFrontier(database, copied),
				round = storedCreatorEvidenceQcRound(copied),
				refusal = sqliteSigningMutationRefusal(database, copied.objectId, copied.epoch);
			if (refusal !== undefined || (floor > 0 && (round === undefined || round < floor)))
				return {
					ok: false as const,
					reason: refusal ?? (round === undefined ? "UNCLASSIFIED_SIGNING_EVIDENCE" : "SIGNING_RETIRED"),
				};
			const key = [copied.objectId, copied.epoch, copied.signerId] as const,
				existing = copyStoredCreatorCloseEvidenceRecord(database.get("sealEvidence", key));
			if (existing !== undefined && sameStoredCreatorCloseEvidenceRecord(existing, copied))
				return { duplicate: true, ok: true as const };
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
			)
				return { ok: false as const, reason: "EVIDENCE_CONFLICT" };
			database.put("sealEvidence", key, copyCreatorCloseEvidenceRecord(copied));
			readSqliteSigningImage(database, copied.objectId);
			return { duplicate: false, ok: true as const };
		});
	};
	const writePeer = (value: PeerSealEvidence): Promise<WriteResult> => {
		const evidence = copyStoredPeerSealEvidence(value),
			identity = evidence === undefined ? undefined : storedPeerSealIdentity(evidence);
		if (evidence === undefined || identity === undefined)
			return lease.run(false, () => ({ ok: false as const, reason: "MALFORMED_EVIDENCE" }));
		return lease.run(true, () => {
			const floor = readSqliteSigningFrontier(database, identity),
				refusal = sqliteSigningMutationRefusal(database, identity.objectId, identity.epoch);
			if (refusal !== undefined || identity.round < floor)
				return { ok: false as const, reason: refusal ?? "SIGNING_RETIRED" };
			const key = [identity.objectId, identity.epoch, identity.signerId] as const,
				raw = database.get("sealEvidence", key),
				existing = copyStoredCreatorCloseEvidenceRecord(raw),
				existingPeer = storedPeerSealEvidenceFromRow(raw);
			if (existingPeer !== undefined && sameStoredPeerSealEvidence(existingPeer, evidence))
				return { duplicate: true, ok: true as const };
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
					compareBytes(existing.exactCanonicalTrustStateRecordBytes, evidence.exactCanonicalTrustStateRecordBytes) !==
						0);
			if (conflicts) return { ok: false as const, reason: "EVIDENCE_CONFLICT" };
			database.put(
				"sealEvidence",
				key,
				existing === undefined
					? { epoch: identity.epoch, objectId: identity.objectId, signerId: identity.signerId, peerEvidence: evidence }
					: { ...existing, peerEvidence: evidence }
			);
			readSqliteSigningImage(database, identity.objectId);
			return { duplicate: false, ok: true as const };
		});
	};
	try {
		const rows = await readAll();
		const owner = Object.freeze({
			observation: Object.freeze({ incarnation: database.incarnation, evidenceCount: rows.length }),
			close: () => lease.close().then(() => session?.closedOwner(owner)),
			persistPeerEvidence: ({ evidence }: Readonly<{ evidence: PeerSealEvidence }>) => writePeer(evidence),
			restorePeerEvidence: ({ evidence }: Readonly<{ evidence: PeerSealEvidence }>) => writePeer(evidence),
			servePeerEvidence: (input: Readonly<{ objectId: string; signerId: string; epoch?: number }>) => {
				if (input === null || typeof input !== "object" || Array.isArray(input))
					return Promise.reject(new TypeError("peer evidence identity is invalid"));
				const fields = Object.getOwnPropertyDescriptors(input),
					keys = Reflect.ownKeys(fields),
					expected = keys.length === 2 ? ["objectId", "signerId"] : ["epoch", "objectId", "signerId"];
				if (
					keys.length !== expected.length ||
					expected.some((key) => fields[key] === undefined || !("value" in fields[key]) || !fields[key].enumerable)
				)
					return Promise.reject(new TypeError("peer evidence identity is invalid"));
				const objectId = fields.objectId?.value as unknown,
					signerId = fields.signerId?.value as unknown,
					epoch = fields.epoch === undefined ? 0 : (fields.epoch.value as unknown);
				if (
					typeof objectId !== "string" ||
					!objectId ||
					!evidenceSafeRevision(epoch) ||
					typeof signerId !== "string" ||
					!signerId
				)
					return Promise.reject(new TypeError("peer evidence identity is invalid"));
				return lease.run(
					false,
					() => storedPeerSealEvidenceFromRow(database.get("sealEvidence", [objectId, epoch, signerId])) ?? null
				);
			},
			store: mintCreatorCloseEvidenceStore({
				acquireSigningDependencyObservation: (input) => retirement.acquireDependency(input),
				acquireRetirementObservation: (input) => retirement.acquire(input),
				acquireRecoveryRetirementObservation: (input) => retirement.acquireRecovery(input),
				put,
				readAll,
			}),
		});
		return owner;
	} catch (primary) {
		try {
			await lease.close();
		} catch (cleanup) {
			throw new AggregateError([primary, cleanup], "SQLite evidence open cleanup failed", { cause: primary });
		}
		throw primary;
	}
}
