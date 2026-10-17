import { compareBytes, decodeCanonical, hashDomain } from "@ts-drp/canonical";

import {
	copyCreatorCloseEvidenceRecord,
	type CreatorCloseEvidencePhase,
	type CreatorCloseEvidenceRecord,
} from "./creator-close-intent.js";

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

/**
 *
 * @param value
 */
function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

/**
 *
 * @param value
 */
function safeRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 *
 * @param value
 * @param nullable
 */
function exactBytes(value: unknown, nullable = false): Uint8Array | null | undefined {
	if (nullable && value === null) return null;
	if (!(value instanceof Uint8Array) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
		return undefined;
	}
	return Uint8Array.from(value);
}

/**
 *
 * @param value
 */
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

/**
 *
 * @param value
 */
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

/**
 *
 * @param left
 * @param right
 */
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

/**
 *
 * @param evidence
 */
function peerIdentity(
	evidence: PeerSealEvidence
):
	| Readonly<{ anchor: string; epoch: number; objectId: string; round: number; signerId: string; valueDigest: string }>
	| undefined {
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
			!safeRevision(qc.round) ||
			vote.round !== qc.round ||
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
			round: qc.round,
			signerId: vote.signerId,
			valueDigest: Array.from(hashDomain("ts-drp/hard-epoch-cut/v3", evidence.exactCanonicalCutValueBytes), (byte) =>
				byte.toString(16).padStart(2, "0")
			).join(""),
		});
	} catch {
		return undefined;
	}
}

/**
 *
 * @param value
 */
function peerEvidenceFromRow(value: unknown): PeerSealEvidence | undefined {
	return plainRecord(value) ? copiedPeerEvidence(value.peerEvidence) : undefined;
}

/**
 *
 * @param record
 */
function recordQcRound(record: CreatorCloseEvidenceRecord): number | undefined {
	const bytes = record.exactCanonicalCommitQcBytes ?? record.exactCanonicalPrepareQcBytes;
	if (bytes === null) return undefined;
	try {
		const qc = decodeCanonical(bytes);
		return plainRecord(qc) &&
			qc.kind === "drp-seal-qc" &&
			qc.objectId === record.objectId &&
			qc.epoch === record.epoch &&
			safeRevision(qc.round)
			? qc.round
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 *
 * @param left
 * @param right
 */
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

export {
	plainRecord as evidencePlainRecord,
	safeRevision as evidenceSafeRevision,
	exactBytes as evidenceExactBytes,
	copiedRecord as copyStoredCreatorCloseEvidenceRecord,
	copiedPeerEvidence as copyStoredPeerSealEvidence,
	samePeerEvidence as sameStoredPeerSealEvidence,
	peerIdentity as storedPeerSealIdentity,
	peerEvidenceFromRow as storedPeerSealEvidenceFromRow,
	recordQcRound as storedCreatorEvidenceQcRound,
	sameRecord as sameStoredCreatorCloseEvidenceRecord,
};
