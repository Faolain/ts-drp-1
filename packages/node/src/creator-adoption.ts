import type { ResolvedBlueprintBytes, TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type CloseSetHistoryCommitment, CompactMerkleAccumulator } from "@ts-drp/compaction";
import { verifySnapshotStreamWithReceipt } from "@ts-drp/compaction/snapshot-quarantine-receipt";
import type { DurableIssuanceStore, DurableIssueScope } from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { type CurrentAnchorTrust, openCurrentAnchorTrust, type SignRegisteredVertexDigest } from "@ts-drp/protocol-v3";
import type { OwnedIdentityChallengeAdmission, OwnedSigningRequest } from "@ts-drp/protocol-v3/internal/owned-signing-request";
import { createCreatorSigningRecoveryOwner } from "@ts-drp/seal/creator";
import { CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES } from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import { CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES } from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import { CREATOR_ISSUANCE_RETIREMENT_MAX_RECORD_BYTES } from "@ts-drp/protocol-v3/creator-issuance-retirement";
import {
	openCreatorCheckpointTrust,
	openCreatorForwardPromotionCheckpointTrust,
} from "@ts-drp/protocol-v3/creator-checkpoint";
import {
	openCreatorForwardPromotionSuccessorTrust,
	openCreatorSuccessorTrust,
} from "@ts-drp/protocol-v3/creator-close";
import {
	capturePromotionBytes,
	capturePromotionRecord,
	captureCreatorSnapshotRecoveryRoles,
	type PromotionSource,
} from "@ts-drp/protocol-v3/internal/creator-forward-promotion";
import { openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import { settlementProfileFor } from "@ts-drp/protocol-v3/settlement-profile";
import { decodeSnapshotManifest, snapshotChunkDigest } from "@ts-drp/protocol-v3/snapshot-transfer";
import {
	AHE_BOUNDED_READ_LIMITS,
	type AheBoundedRecoveryRoleRead,
	type AheBoundedRecoveryRoleStore,
	type AheDurableStore,
	type ArchiveStorage,
	decodeHeadRecordV1,
	digestBlob,
	digestClosure,
	encodeHeadRecordV1,
	encodeGenerationRecordV1,
	type GenerationId,
	type GenerationPageCursor,
	type GenerationRecord,
	type GenerationRef,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type PresentHead,
	type StorageObjectId,
} from "@ts-drp/storage";
import {
	SNAPSHOT_RECEIVED_CERTIFICATE_MAX_BYTES,
	type SnapshotQuarantineDeclaration,
	type SnapshotQuarantineStore,
	type SnapshotRecoveryStore,
	type SnapshotVerificationReceipt,
} from "@ts-drp/storage/snapshot-transfer";

import { completeCreatorCertifiedArchiveAppend, type CreatorLiveCloseResult, inspectHead } from "./creator-close.js";
import {
	createCreatorAdoptionIntent,
	createCreatorAuthenticatedNativeFuture,
	type CreatorAdoptionIntent,
	installCreatorAdoptionFacts,
	resolveCreatorAdoptionFacts,
	revokeCreatorAdoptionFacts,
} from "./internal/creator-adoption-intent.js";
import {
	type CreatorAdoptionPendingRecoveryInput,
	type CreatorAdoptionPendingRecoveryResult,
	type CreatorAdoptionRoomHead,
	installCreatorAdoptionPendingRecovery,
} from "./internal/creator-adoption-recover.js";
import {
	deriveCreatorAdoptionReferences,
	deriveLegacyCreatorAdoptionReferences,
	deriveReceivedCreatorTransitionCandidates as receivedTransitionClosure,
	matchesCreatorAdoptionReferences,
} from "./internal/creator-adoption-references.js";
import {
	CREATOR_CLOSE_HISTORY_MAX_BYTES,
	deriveCreatorCloseHistory,
	openCreatorCloseHistory,
} from "./internal/creator-close-history.js";
import {
	acquireCreatorInstalledPromotion,
	acquireCreatorReceivedPromotion,
	acquireCreatorSnapshotRetirementReconstructionRequest,
	createCreatorClosedRollbackProofAccounting,
	type CreatorClosedRollbackDataInput,
	type CreatorForwardPromotionSourceMaterial,
} from "./internal/creator-closed-rollback-data.js";
import { resolveCreatorRecipientRegistration } from "./internal/creator-recipient-provenance.js";
import { captureCreatorRoomHeadState, sameCreatorRoomHead } from "./internal/creator-room-head.js";
import {
	canonicalCreatorDataRecord as canonicalRecord,
	creatorPromotedSnapshotProjectionMatches,
	creatorSnapshotProjectionMatches,
	encodeCreatorSuccessorProjection,
	validateCreatorSnapshotData,
	verifiedCreatorSnapshotCatalog as verifiedCatalog,
} from "./internal/creator-snapshot-data.js";
import {
	type CreatorSuccessorLiveMaterial,
	assertEmptyReceiveOnlyIssuance,
	type CreatorSuccessorLiveSeed,
	type CreatorSuccessorReopenInput,
	type CreatorSuccessorReopenResult,
	installCreatorSuccessorReopen,
} from "./internal/creator-successor-live.js";
import {
	type CreatorSuccessorAuxiliaryMaterial,
	receiveCreatorSuccessorMaterial,
} from "./internal/creator-successor-transport.js";
import {
	type CreatorTransitionClosure,
	inspectCreatorAdoptionCandidateLineage,
	inspectCreatorTransitionAdvance,
	resolveCreatorForwardPromotion,
	uniqueCreatorTransitionCandidate,
	type VerifiedCreatorForwardPromotion,
} from "./internal/creator-transition-advance.js";
import { createV3SnapshotTransferOwner } from "./snapshot-transfer.js";
import { sealCreatorReceivedRecoveryReplay, type V3PlaneHandle } from "./v3-live.js";
import { reconcileCreatorReceivedSnapshotRecoveryRoles, reconcileCreatorSnapshotRecoveryRoles } from "./internal/creator-closed-rollback-data.js";
import { acquireCreatorPendingClassificationCustody, resolveCreatorSnapshotRecoveryCloseHold } from "./internal/runtime-reclamation.js";
import type { CreatorRecoveryPoolResult } from "./internal/creator-recovery-pool.js";

export {
	captureCreatorSuccessorPeers,
	createCreatorSuccessorMaterialServer,
	consumeOwnedCreatorTransportSigningRequest,
} from "./internal/creator-successor-transport.js";

const PROFILE = Object.freeze({
	maxManifestBytes: 212_387,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
const ED25519_PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/u;

export interface CreatorSuccessorOffer {
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly exactCanonicalCommitQcBytes: Uint8Array;
	readonly exactCanonicalTrustStateRecordBytes: Uint8Array;
	readonly exactCanonicalSnapshotManifestBytes: Uint8Array;
}

/** Native cold sources may legitimately have no ordinary adjacent close to serve. */
export class CreatorSuccessorExportUnavailable extends TypeError {}

interface ReceivedCertificate {
	readonly kind: "creator-received-recovery-certificate-1";
	readonly pinnedGenesisAnchorDigest: string;
	readonly exactCanonicalOldHeadBytes: Uint8Array;
	readonly currentTrustRef: GenerationRef;
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly exactCanonicalCommitQcBytes: Uint8Array;
	readonly exactCanonicalTrustStateRecordBytes: Uint8Array;
	readonly exactCanonicalSettlementBytes: Uint8Array | null;
	readonly exactCanonicalHistoryBytes: Uint8Array;
	readonly exactCanonicalRetirementBytes?: Uint8Array;
	readonly exactCanonicalAggregateBytes?: Uint8Array;
	readonly sealedReplayDigest: string;
	readonly sealedReplayRowCount: number;
	readonly sealedReplayByteCharge: number;
	readonly candidateGenerationId: GenerationId;
	readonly candidateClosureDigest: string;
}

const RECEIVED_CERTIFICATE_KEYS = Object.freeze([
	"kind",
	"pinnedGenesisAnchorDigest",
	"exactCanonicalOldHeadBytes",
	"currentTrustRef",
	"exactCanonicalCutValueBytes",
	"exactCanonicalCommitQcBytes",
	"exactCanonicalTrustStateRecordBytes",
	"exactCanonicalSettlementBytes",
	"exactCanonicalHistoryBytes",
	"sealedReplayDigest",
	"sealedReplayRowCount",
	"sealedReplayByteCharge",
	"candidateGenerationId",
	"candidateClosureDigest",
]);
// Frozen codec charges one root plus four items per record field (entry
// reservation and decoded key/value). The only nested record is the two-field ref.
const RECEIVED_CERTIFICATE_MAX_ITEMS = 1 + 4 * (RECEIVED_CERTIFICATE_KEYS.length + 2);
const NONE_RECEIVED_CERTIFICATE_KEYS=Object.freeze([...RECEIVED_CERTIFICATE_KEYS,"exactCanonicalRetirementBytes","exactCanonicalAggregateBytes"]);
const NONE_RECEIVED_CERTIFICATE_MAX_ITEMS=1+4*(NONE_RECEIVED_CERTIFICATE_KEYS.length+2);

function encodeReceivedCertificate(value: ReceivedCertificate): Uint8Array {
	return encodeCanonical(value, {
		maxBytes: SNAPSHOT_RECEIVED_CERTIFICATE_MAX_BYTES,
		maxDepth: 2,
		maxItems: value.exactCanonicalSettlementBytes===null ? NONE_RECEIVED_CERTIFICATE_MAX_ITEMS : RECEIVED_CERTIFICATE_MAX_ITEMS,
	});
}

/** Internal syntax owner only; parsing never authenticates replay or grants adoption. */
export function openReceivedCertificate(bytes: Uint8Array): ReceivedCertificate {
	const decoded=decodeCanonical(bytes, {
			maxBytes: SNAPSHOT_RECEIVED_CERTIFICATE_MAX_BYTES,
			maxDepth: 2,
			maxItems: NONE_RECEIVED_CERTIFICATE_MAX_ITEMS,
		});
	const value=capturePromotionRecord(decoded,RECEIVED_CERTIFICATE_KEYS) ?? capturePromotionRecord(decoded,NONE_RECEIVED_CERTIFICATE_KEYS);
	if (value === undefined || value.kind !== "creator-received-recovery-certificate-1")
		throw new TypeError("creator received certificate schema is invalid");
	for (const key of ["pinnedGenesisAnchorDigest", "sealedReplayDigest", "candidateClosureDigest"] as const)
		if (typeof value[key] !== "string" || !ED25519_PUBLIC_KEY_HEX.test(value[key]))
			throw new TypeError("creator received certificate digest is invalid");
	for (const key of ["sealedReplayRowCount", "sealedReplayByteCharge"] as const)
		if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)
			throw new TypeError("creator received certificate replay is invalid");
	const generation =
		typeof value.candidateGenerationId === "string"
			? parseGenerationId(value.candidateGenerationId)
			: { ok: false as const };
	const trust = capturePromotionRecord(value.currentTrustRef, ["digest", "byteLength"]);
	if (
		!generation.ok ||
		trust === undefined ||
		typeof trust.digest !== "string" ||
		!ED25519_PUBLIC_KEY_HEX.test(trust.digest) ||
		!Number.isSafeInteger(trust.byteLength) ||
		Number(trust.byteLength) < 1 ||
		Number(trust.byteLength) > AHE_BOUNDED_READ_LIMITS.maxBlobBytes
	)
		throw new TypeError("creator received certificate native identity is invalid");
	const carriers: Record<string, Uint8Array | null> = {};
	for (const [key, maximum] of [
		["exactCanonicalOldHeadBytes", AHE_BOUNDED_READ_LIMITS.maxHeadBytes],
		["exactCanonicalCutValueBytes", AHE_BOUNDED_READ_LIMITS.maxBlobBytes],
		["exactCanonicalCommitQcBytes", AHE_BOUNDED_READ_LIMITS.maxBlobBytes],
		["exactCanonicalTrustStateRecordBytes", AHE_BOUNDED_READ_LIMITS.maxBlobBytes],
		["exactCanonicalSettlementBytes", CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES],
		["exactCanonicalHistoryBytes", CREATOR_CLOSE_HISTORY_MAX_BYTES],
	] as const) {
		if (key === "exactCanonicalSettlementBytes" && value[key] === null) {
			carriers[key] = null;
			continue;
		}
		const carrier = capturePromotionBytes(value[key], maximum);
		if (carrier === undefined) throw new TypeError("creator received certificate carrier is invalid");
		carriers[key] = carrier;
	}
	for(const [key,maximum] of [["exactCanonicalRetirementBytes",CREATOR_ISSUANCE_RETIREMENT_MAX_RECORD_BYTES],
		["exactCanonicalAggregateBytes",CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES]] as const){
		if(value.exactCanonicalSettlementBytes!==null){if(value[key]!==undefined)throw new TypeError("creator received none companions differ");continue;}
		const carrier=capturePromotionBytes(value[key],maximum);
		if(carrier===undefined)throw new TypeError("creator received none companion is invalid");carriers[key]=carrier;
	}
	const certificate = Object.freeze({
		...value,
		...carriers,
		candidateGenerationId: generation.value,
		currentTrustRef: Object.freeze({ digest: trust.digest, byteLength: trust.byteLength }),
	}) as unknown as ReceivedCertificate;
	if (!sameBytes(bytes, encodeReceivedCertificate(certificate)))
		throw new TypeError("creator received certificate is noncanonical");
	return certificate;
}

/** Absence is a profile fact only after the enclosing signed transition is verified. */
function assertSettlementCompanionProfile(bytes:Uint8Array|null, profileId:string):void {
	if ((bytes===null)!==(settlementProfileFor(profileId)==="none"))
		throw new TypeError("creator settlement companion differs from authenticated profile");
}

/**
 * Captures only bounded detached carriers, never caller-owned authority.
 * @param value The untrusted exact four-carrier offer.
 * @returns Detached intrinsic bytes, without invoking caller buffer shadows or iterators.
 */
export function captureCreatorSuccessorOffer(value: unknown): CreatorSuccessorOffer {
	const keys = [
		"exactCanonicalCutValueBytes",
		"exactCanonicalCommitQcBytes",
		"exactCanonicalTrustStateRecordBytes",
		"exactCanonicalSnapshotManifestBytes",
	] as const;
	const fields = capturePromotionRecord(value, keys);
	if (fields === undefined) throw new TypeError("creator successor offer fields are invalid");
	const output: Record<string, Uint8Array> = {};
	for (const key of keys) {
		const bytes = capturePromotionBytes(
			fields[key],
			key === "exactCanonicalSnapshotManifestBytes" ? PROFILE.maxManifestBytes : 65_536
		);
		if (bytes === undefined) throw new TypeError("creator successor offer carrier is invalid");
		output[key] = bytes;
	}
	return Object.freeze(output) as unknown as CreatorSuccessorOffer;
}

/**
 * Discovers exact signed close material and snapshot custody from native durable roles.
 * @param input
 */
export async function readCreatorSuccessorExport(
	input: CreatorSuccessorExportInput
): Promise<CreatorSuccessorExport> {
	if (input.archiveRecovery === undefined) return readCreatorSuccessorExportMaterial(input);
	// Capture immutable authenticated carriers once before the recovery workflow's first await.
	// Ports remain the existing trusted native owners; copied bytes grant no portable authority.
	const genesis = capturePromotionBytes(input.exactCanonicalGenesisAnchorPreimageBytes, 65_536),
		signature = capturePromotionBytes(input.detachedGenesisSignature, 64);
	if (genesis === undefined || signature?.byteLength !== 64) throw new TypeError("archive export pinned genesis carriers are invalid");
	const captured = Object.freeze({ store: input.store, snapshotStore: input.snapshotStore, objectId: input.objectId,
		pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest, exactCanonicalGenesisAnchorPreimageBytes: genesis,
		detachedGenesisSignature: signature, ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
		archiveRecovery: Object.freeze({ store: input.archiveRecovery.store, accounting: input.archiveRecovery.accounting,
			roomHeadAuthority: input.archiveRecovery.roomHeadAuthority }) });
	return recoverCreatorArchiveCloseExport(captured, captured.archiveRecovery);
}

interface CreatorSuccessorExportInput {
		store: AheDurableStore;
		snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
		objectId: StorageObjectId;
		pinnedGenesisAnchorDigest: string;
		exactCanonicalGenesisAnchorPreimageBytes: Uint8Array;
		detachedGenesisSignature: Uint8Array;
		catalog?: TrustedBlueprintCatalog;
		/** Existing room's native owners only. A ledger/intent is neither wire authority nor a live custody grant. */
		archiveRecovery?: Readonly<{
			store: ArchiveStorage;
			accounting: import("./internal/creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting;
			roomHeadAuthority: CreatorClosedRollbackDataInput["roomHeadAuthority"];
		}>;
}
type CreatorSuccessorExport = Readonly<{
		offer: CreatorSuccessorOffer;
		material: CreatorSuccessorAuxiliaryMaterial;
		declaration: SnapshotQuarantineDeclaration;
	}>;

interface ArchiveCloseExportFacts {
	readonly actualHead: PresentHead;
	readonly selectedHead: PresentHead;
	readonly generation: GenerationRecord;
	readonly predecessorTrust: CurrentAnchorTrust;
	readonly successorTrust: CurrentAnchorTrust;
	readonly candidates: RecoveredClosure["currentCandidates"];
	readonly nativeGenerationBytes: Uint8Array;
	readonly nativeBlobs: AheBoundedRecoveryRoleRead["blobs"];
}

interface ColdArchiveCloseEvidence {
	readonly head: PresentHead;
	readonly generation: GenerationRecord;
	readonly currentHead: PresentHead;
	readonly currentGeneration: GenerationRecord;
	readonly closure: RecoveredClosure;
	readonly chain: VerifiedChain;
	readonly snapshotDeclaration: SnapshotQuarantineDeclaration;
	readonly snapshot: VerifiedSnapshot;
	readonly historyBytes: Uint8Array;
	readonly promotion?: Readonly<{ verified: VerifiedCreatorForwardPromotion;
		historicalSnapshots: CreatorForwardPromotionSourceMaterial["historicalSnapshots"];
		closedEpoch: number;
		supportGenerations: readonly GenerationRecord[] }>
}

/** Same original export authentication; the optional selection is private recovery data, not authority. */
async function readCreatorSuccessorExportMaterial(
	input: CreatorSuccessorExportInput,
	selection?: Readonly<{ generationId: GenerationId; expectedHead: PresentHead;
		accounting: import("./internal/creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting;
		checkFloor(): Promise<void>;
		capture(facts: ArchiveCloseExportFacts): void;
	}>,
	recovery?: Readonly<{ accounting: import("./internal/creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting;
		checkFloor(): Promise<void>; captureClosed?(facts: ColdArchiveCloseEvidence): void }>
): Promise<CreatorSuccessorExport> {
	const exportAccounting = selection?.accounting ?? recovery?.accounting;
	const checkExportFloor = selection?.checkFloor ?? recovery?.checkFloor;
	let nativePromotion: Awaited<ReturnType<typeof acquireCreatorReceivedPromotion>> | undefined;
	let failed = false;
	let primary: unknown;
	try { return await withCreatorRecoveryCensus(input.store, input.objectId, async (reader) => {
		const actualHead = reader.head;
		const generation =
			actualHead.kind !== "present"
				? undefined
				: reader.generations.find(({ generationId }) => generationId === (selection?.generationId ?? actualHead.generationId));
		if (selection !== undefined && (actualHead.kind !== "present" || !sameHead(actualHead, selection.expectedHead) ||
			generation?.state !== "Complete" || generation.baseExpectedHead.kind !== "present" ||
			!sameHead(generation.baseExpectedHead, actualHead)))
			throw new TypeError("archive Complete close source/base head is stale");
		if (selection !== undefined && generation !== undefined) {
			const closure = digestClosure(generation.closure);
			if (!closure.ok || closure.value !== generation.closureDigest)
				throw new TypeError("archive Complete close whole closure digest differs");
		}
		let nativeHead = actualHead;
		if (selection !== undefined && actualHead.kind === "present" && generation !== undefined) {
			const revision = parseHeadRevision(actualHead.revision + 1);
			if (!revision.ok) throw new TypeError("archive Complete close next native revision is invalid");
			nativeHead = Object.freeze({ kind: "present" as const, objectId: actualHead.objectId,
				revision: revision.value, generationId: generation.generationId, closureDigest: generation.closureDigest });
		}
		const candidates = generation === undefined ? undefined : recoveryCensusClosure(reader, generation.closure);
		const nativeTrust =
			candidates === undefined ? undefined : uniqueCandidateByKind(candidates, "drp-anchor-trust-state");
		if (
			nativeHead.kind !== "present" ||
			generation?.state !== (selection === undefined ? "Adopted" : "Complete") ||
			candidates === undefined ||
			nativeTrust === undefined
		)
			throw new TypeError("creator successor bounded native export source is unavailable");
		if (exportAccounting !== undefined) {
			await checkExportFloor?.();
			for (const bytes of [encodeCanonical(actualHead), encodeCanonical(reader.generations),
				encodeCanonical(reader.blobs.map(blob => blob.ref)),
				input.exactCanonicalGenesisAnchorPreimageBytes, input.detachedGenesisSignature,
				...reader.blobs.map(blob => blob.bytes)]) if (!exportAccounting.charge(bytes))
				throw new TypeError("archive Complete export full native PRE charge is exhausted");
		}
		const current = Object.freeze({
			head: nativeHead,
			references: generation.closure,
			candidates,
			trustRef: nativeTrust.ref,
		});
		const trust = uniqueCandidateByKind(current.candidates, "drp-anchor-trust-state");
		const cut = uniqueCandidateByKind(current.candidates, "drp-hard-epoch-cut");
		if (selection !== undefined && (cut === undefined || !Object.hasOwn(cut.record, "archiveAppend")))
			throw new TypeError("archive Complete close has no certified append binding");
		const qc = uniqueCandidateByKind(current.candidates, "drp-seal-qc");
		const successorProjection = uniqueCandidateByKind(current.candidates, "v3-live-generation-2");
		const retainedHistory = uniqueCandidateByKind(current.candidates, "creator-close-history-1");
		const projectedHistory =
			successorProjection === undefined || cut === undefined
				? undefined
				: deriveCreatorCloseHistory({
						exactCanonicalProjectionBytes: successorProjection.bytes,
						exactCanonicalCutValueBytes: cut.bytes,
					});
		if (
			retainedHistory !== undefined &&
			projectedHistory !== undefined &&
			!sameBytes(retainedHistory.bytes, projectedHistory.bytes)
		)
			throw new TypeError("creator successor native history carriers differ");
		const history = retainedHistory ?? projectedHistory;
		const settlement = uniqueCandidateByKind(current.candidates, "drp-creator-author-settlement-state");
		const retirement=uniqueCandidateByKind(current.candidates,"drp-creator-issuance-retirement-state");
		const aggregate=uniqueCandidateByKind(current.candidates,"drp-creator-author-issuance-frontiers-state");
		if (cut === undefined && qc === undefined && history === undefined && trust !== undefined) {
			const genesis = openCurrentAnchorTrust({
				exactCanonicalTrustStateRecordBytes: trust.bytes,
				expectedObjectId: input.objectId,
				pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
			});
			if (genesis.ok)
				throw new CreatorSuccessorExportUnavailable("creator successor ordinary native material is unavailable");
		}
		if (
			trust === undefined ||
			cut === undefined ||
			qc === undefined ||
			trust.record.genesisAnchorDigest !== input.pinnedGenesisAnchorDigest ||
			trust.record.currentEpoch !== Number(cut.record.epoch) + 1
		)
			throw new TypeError("creator successor native material is invalid");
		const lineage = reader.generations;
		let predecessorGeneration = lineage.find(({ generationId }) => generationId === current.head.generationId);
		let predecessor: RecoveredClosure["currentCandidates"] | undefined;
		let predecessorTrustCandidate: ReturnType<typeof uniqueCandidateByKind>;
		// Both existing local-close P/Q/L and received direct P/L have at most two predecessor steps.
		for (let step = 0; step < 2 && predecessorGeneration !== undefined; step += 1) {
			const base = presentBase(predecessorGeneration);
			predecessorGeneration = lineage.find(({ generationId }) => generationId === base?.generationId);
			if (predecessorGeneration === undefined) break;
			const candidates = recoveryCensusClosure(reader, predecessorGeneration.closure);
			const selected =
				candidates === undefined ? undefined : uniqueCandidateByKind(candidates, "drp-anchor-trust-state");
			if (
				selected !== undefined &&
				selected.record.currentEpoch === cut.record.epoch &&
				selected.record.currentAnchorDigest === cut.record.previousAnchor
			) {
				predecessor = candidates;
				predecessorTrustCandidate = selected;
				break;
			}
		}
		if (predecessor === undefined || predecessorTrustCandidate === undefined)
			throw new TypeError("creator successor native predecessor is unavailable");
		const genesis =
			Number(cut.record.epoch) === 0
				? openCurrentAnchorTrust({
						exactCanonicalTrustStateRecordBytes: predecessorTrustCandidate.bytes,
						expectedObjectId: input.objectId,
						pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
					})
				: undefined;
		const firstSuccessor = genesis?.ok
			? (Object.hasOwn(cut.record, "forwardPromotion")
					? openCreatorForwardPromotionSuccessorTrust
					: openCreatorSuccessorTrust)({
					currentTrust: genesis.trust,
					exactCanonicalCommitQcBytes: qc.bytes,
					exactCanonicalCutValueBytes: cut.bytes,
					exactCanonicalTrustStateRecordBytes: trust.bytes,
				})
			: undefined;
		const checkpoint =
			Number(cut.record.epoch) === 0
				? genesis?.ok && firstSuccessor?.ok
					? { ok: true as const, predecessorTrust: genesis.trust, currentTrust: firstSuccessor.trust }
					: { ok: false as const }
				: (Object.hasOwn(cut.record, "forwardPromotion")
						? openCreatorForwardPromotionCheckpointTrust
						: openCreatorCheckpointTrust)({
						detachedGenesisSignature: input.detachedGenesisSignature,
						exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalGenesisAnchorPreimageBytes,
						exactCanonicalCommitQcBytes: qc.bytes,
						exactCanonicalCurrentTrustStateRecordBytes: trust.bytes,
						exactCanonicalCutValueBytes: cut.bytes,
						exactCanonicalPredecessorTrustStateRecordBytes: predecessorTrustCandidate.bytes,
						expectedCurrentHead: {
							objectId: input.objectId,
							epoch: Number(trust.record.currentEpoch),
							currentAnchorDigest: String(trust.record.currentAnchorDigest),
						},
						expectedObjectId: input.objectId,
						pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
					});
		if (!checkpoint.ok) throw new TypeError("creator successor native checkpoint is invalid");
		const promoted = Object.hasOwn(cut.record, "forwardPromotion");
		const proposedCandidates =
			successorProjection?.record.epoch === checkpoint.currentTrust.currentEpoch
				? receivedTransitionClosure(predecessor, current.candidates, checkpoint.predecessorTrust.currentEpoch)
				: current.candidates;
		if (proposedCandidates === undefined)
			throw new TypeError("creator successor native projection replacement is invalid");
		let chain = verifyChain(
			{
				currentTrust: checkpoint.predecessorTrust,
				currentReferences: predecessor.map(({ ref }) => ref),
				proposedReferences: proposedCandidates.map(({ ref }) => ref),
				transition: {
					cutValueRef: cut.ref,
					commitQcRef: qc.ref,
					successorTrustRef: trust.ref,
					currentTrustRef: predecessorTrustCandidate.ref,
					epoch: checkpoint.predecessorTrust.currentEpoch,
					successorEpoch: checkpoint.currentTrust.currentEpoch,
					successorAnchorDigest: checkpoint.currentTrust.currentAnchorDigest,
				},
			},
			{ currentCandidates: predecessor, proposedCandidates },
			!promoted
		);
		if (chain === undefined) throw new TypeError("creator successor native transition is invalid");
		const scope = {
			objectId: input.objectId,
			epoch: Number(cut.record.epoch),
			anchor: String(cut.record.previousAnchor),
			manifestDigest: String(cut.record.snapshotManifestDigest),
		};
		const lookup = await input.snapshotStore.lookupRecoveryDeclaration(scope);
		if (exportAccounting !== undefined && !exportAccounting.charge(encodeCanonical(lookup)))
			throw new TypeError("archive export native snapshot declaration charge is exhausted");
		if (lookup.kind !== "present" || lookup.state !== "verified" || lookup.retention !== "recovery")
			throw new TypeError("creator successor native snapshot is unavailable");
		const snapshot = await verifySnapshot(
			{ snapshotStore: input.snapshotStore, snapshotDeclaration: lookup.declaration },
			chain,
			exportAccounting
		);
		if (snapshot === undefined) throw new TypeError("creator successor native snapshot is invalid");
		if (promoted) {
			if (input.catalog === undefined) throw new TypeError("creator promotion native catalog is unavailable");
			const active = lineage.find((row) => row.generationId === current.head.generationId);
			const base = active === undefined ? undefined : presentBase(active);
			const direct = base?.generationId === predecessorGeneration?.generationId;
			const proposedGeneration = direct ? active : lineage.find((row) => row.generationId === base?.generationId);
			if (predecessorGeneration === undefined || proposedGeneration === undefined)
				throw new TypeError("creator promotion native lineage is unavailable");
			nativePromotion = await acquireCreatorReceivedPromotion({
				store: input.store, snapshotStore: input.snapshotStore, catalog: input.catalog,
				expectedHead: selection === undefined ? current.head : selection.expectedHead,
				currentTrust: checkpoint.predecessorTrust,
				successorTrust: checkpoint.currentTrust,
				currentGenerationId: predecessorGeneration.generationId,
				proposedGenerationId: proposedGeneration.generationId,
				exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalGenesisAnchorPreimageBytes,
				detachedGenesisSignature: input.detachedGenesisSignature,
				receivedProposal: { closure: { candidates: proposedCandidates, closure: proposedCandidates.map(({ref}) => ref) },
					currentCloseSnapshot: { exactCanonicalManifestBytes: lookup.declaration.exactCanonicalManifestBytes,
						exactCanonicalPayloadBytes: snapshot.exactCanonicalPayloadBytes } },
			}, exportAccounting);
			chain = verifyChain({
				currentTrust: checkpoint.predecessorTrust,
				currentReferences: predecessor.map(({ref}) => ref),
				proposedReferences: proposedCandidates.map(({ref}) => ref),
				promotion: { verified: nativePromotion.promotion, source: nativePromotion,
					closedEpoch: nativePromotion.source.closedEpoch },
				transition: { cutValueRef: cut.ref, commitQcRef: qc.ref, successorTrustRef: trust.ref,
					currentTrustRef: predecessorTrustCandidate.ref, epoch: checkpoint.predecessorTrust.currentEpoch,
					successorEpoch: checkpoint.currentTrust.currentEpoch,
					successorAnchorDigest: checkpoint.currentTrust.currentAnchorDigest },
			}, { currentCandidates: predecessor, proposedCandidates });
			if (chain === undefined) throw new TypeError("creator promotion native source is invalid");
			await nativePromotion.check();
			if (exportAccounting !== undefined) for (const bytes of [encodeCanonical(nativePromotion.reader.head), encodeCanonical(nativePromotion.reader.generations),
				encodeCanonical(nativePromotion.reader.blobs.map(blob => blob.ref)), ...nativePromotion.reader.blobs.map(blob => blob.bytes),
				nativePromotion.exactCanonicalManifestBytes, nativePromotion.exactCanonicalPayloadBytes,
				...nativePromotion.historicalSnapshots.flatMap(snapshot => [snapshot.exactCanonicalManifestBytes, snapshot.exactCanonicalPayloadBytes])])
				if (!exportAccounting.charge(bytes)) throw new TypeError("archive export promotion protected proof charge is exhausted");
		}
		if (history === undefined || (settlementProfileFor(chain.successorTrust.profileId) === "v1" && settlement === undefined)) {
			// Only a verified supported native transition lacking the optional companion can be unavailable.
			throw new CreatorSuccessorExportUnavailable(
				"creator successor authenticated native export companions are unavailable"
			);
		}
		assertSettlementCompanionProfile(settlement===undefined?null:settlement.bytes,chain.successorTrust.profileId);
		if(settlement===undefined && (retirement===undefined || aggregate===undefined))
			throw new CreatorSuccessorExportUnavailable("creator successor authenticated none export companions are unavailable");
		if (!(await reader.checkCurrency()).ok)
			throw new TypeError("creator successor bounded native export source changed");
		if (exportAccounting !== undefined) {
			await checkExportFloor?.();
			if (!exportAccounting.charge(lookup.declaration.exactCanonicalManifestBytes) ||
				!exportAccounting.charge(snapshot.exactCanonicalPayloadBytes))
				throw new TypeError("archive Complete export full snapshot proof charge is exhausted");
		}
		if (recovery?.captureClosed !== undefined && generation.state === "Adopted" && Object.hasOwn(cut.record, "archiveAppend") &&
			generation.baseExpectedHead.kind === "present" && predecessorGeneration !== undefined &&
			generation.baseExpectedHead.generationId === predecessorGeneration.generationId &&
			uniqueCandidateByKind(current.candidates, chain.currentProjectionKind)?.record.epoch === chain.currentEpoch) {
			const sourceHead = generation.baseExpectedHead;
			if (sourceHead.closureDigest !== predecessorGeneration.closureDigest ||
				predecessorGeneration.state !== "Superseded" || sourceHead.revision + 1 !== nativeHead.revision)
				throw new TypeError("archive cold Q source lineage is not the exact original close");
			recovery.captureClosed(Object.freeze({ head: Object.freeze({ ...nativeHead }) as PresentHead,
				generation: decodeCanonical(encodeCanonical(generation)) as unknown as GenerationRecord,
				currentHead: Object.freeze({ ...sourceHead }), currentGeneration: predecessorGeneration,
				closure: { currentCandidates: predecessor, proposedCandidates: current.candidates }, chain,
				snapshotDeclaration: lookup.declaration, snapshot, historyBytes: Uint8Array.from(history.bytes),
				...(nativePromotion === undefined ? {} : { promotion: Object.freeze({ verified: nativePromotion.promotion,
					historicalSnapshots: Object.freeze(nativePromotion.historicalSnapshots.map(snapshot => Object.freeze({ ...snapshot,
						exactCanonicalManifestBytes: Uint8Array.from(snapshot.exactCanonicalManifestBytes),
						exactCanonicalPayloadBytes: Uint8Array.from(snapshot.exactCanonicalPayloadBytes) }))),
					closedEpoch: nativePromotion.source.closedEpoch, supportGenerations: nativePromotion.supportGenerations }) }) }));
		}
		if (selection !== undefined) {
			selection.capture(Object.freeze({ actualHead: Object.freeze({ ...selection.expectedHead }),
				selectedHead: Object.freeze({ ...nativeHead }) as PresentHead,
				generation: decodeCanonical(encodeCanonical(generation)) as unknown as GenerationRecord,
				predecessorTrust: checkpoint.predecessorTrust, successorTrust: checkpoint.currentTrust,
				nativeGenerationBytes: encodeCanonical(reader.generations),
				nativeBlobs: Object.freeze(reader.blobs.map(blob => Object.freeze({ ...blob,
					bytes: Uint8Array.from(blob.bytes), ref: Object.freeze({ ...blob.ref }) }))),
				candidates: Object.freeze(current.candidates.map(candidate => Object.freeze({ ...candidate,
					bytes: Uint8Array.from(candidate.bytes), ref: Object.freeze({ ...candidate.ref }) }))) }));
		}
		return Object.freeze({
			offer: captureCreatorSuccessorOffer({
				exactCanonicalCutValueBytes: cut.bytes,
				exactCanonicalCommitQcBytes: qc.bytes,
				exactCanonicalTrustStateRecordBytes: trust.bytes,
				exactCanonicalSnapshotManifestBytes: lookup.declaration.exactCanonicalManifestBytes,
			}),
			material: Object.freeze({
				exactCanonicalSettlementBytes: settlement === undefined ? null : Uint8Array.from(settlement.bytes),
				exactCanonicalHistoryBytes: Uint8Array.from(history.bytes),
				...(settlement===undefined?{exactCanonicalRetirementBytes:Uint8Array.from(retirement!.bytes),
					exactCanonicalAggregateBytes:Uint8Array.from(aggregate!.bytes)}:{}),
			}),
			declaration: lookup.declaration,
		});
	}); } catch (error) { failed = true; primary = error; throw error; }
	finally {
		try { await nativePromotion?.release(); }
		catch (error) {
			if (failed) throw new AggregateError([primary, error], "creator export source cleanup failed", { cause: primary });
			throw error;
		}
	}
}

/**
 * Finishes the SAME authenticated Complete close after process interruption. Complete is a
 * durable cross-store intent, not authority: original checkpoint/advance/snapshot/promotion
 * owners authenticate it before any archive or AHE write. Every proof/read lifetime joins
 * before its writer; no closure is reset, copied into a sibling or re-signed.
 */
async function recoverCreatorArchiveCloseExport(
	input: CreatorSuccessorExportInput,
	archive: NonNullable<CreatorSuccessorExportInput["archiveRecovery"]>
): Promise<CreatorSuccessorExport> {
	const archiveStore = archive.store, accounting = archive.accounting;
	const native = input.store as AheBoundedRecoveryRoleStore;
	const floorRead = archive.roomHeadAuthority.read.bind(archive.roomHeadAuthority);
	const scope = Object.freeze({ objectId: input.objectId, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest });
	const initialFloor = captureCreatorRoomHeadState(await floorRead({ scope }), scope.objectId, scope.pinnedGenesisAnchorDigest);
	if (!initialFloor.ok || !accounting.charge(encodeCanonical(initialFloor)))
		throw new TypeError("archive Complete recovery whole floor is unavailable or exhausted");
	const floorBytes = encodeCanonical(initialFloor.state);
	const checkFloor = async (): Promise<void> => {
		const fresh = captureCreatorRoomHeadState(await floorRead({ scope }), scope.objectId, scope.pinnedGenesisAnchorDigest);
		if (!fresh.ok || compareBytes(encodeCanonical(fresh.state), floorBytes) !== 0 || !accounting.charge(encodeCanonical(fresh)))
			throw new TypeError("archive Complete recovery whole floor changed or exhausted its full charge");
		const readiness = await input.snapshotStore.recoveryStatus();
		if (readiness.migration !== "ready" || !accounting.charge(encodeCanonical(readiness)))
			throw new TypeError("archive Complete recovery inherited snapshot custody is held or exhausted");
	};
	const discovery = await withCreatorRecoveryCensus(input.store, input.objectId, async reader => {
		if (reader.head.kind !== "present") throw new TypeError("archive Complete recovery native source is unavailable");
		await checkFloor();
		for (const bytes of [encodeCanonical(reader.head), encodeCanonical(reader.generations),
			encodeCanonical(reader.blobs.map(blob => blob.ref)), ...reader.blobs.map(blob => blob.bytes)])
			if (!accounting.charge(bytes)) throw new TypeError("archive Complete recovery discovery full PRE charge is exhausted");
		const head = reader.head;
		const complete = reader.generations.filter(generation => generation.state === "Complete" &&
			generation.baseExpectedHead.kind === "present" && sameHead(generation.baseExpectedHead, head));
		const candidates = complete.filter(generation => {
			if (generation.state !== "Complete" || generation.baseExpectedHead.kind !== "present" ||
				!sameHead(generation.baseExpectedHead, head)) return false;
			const closure = recoveryCensusClosure(reader, generation.closure);
			if (closure === undefined) throw new TypeError("archive Complete recovery dependency bytes are missing or altered");
			const cut = uniqueCandidateByKind(closure, "drp-hard-epoch-cut");
			if (cut === undefined) throw new TypeError("archive Complete recovery closure has no unique closed decision");
			// A separately prepared L carries this same historical Cut, but is NOT another Q.
			// Leave its publication to the existing pending-adoption owner.
			const projection = uniqueCandidateByKind(closure, currentProjectionKind(Number(cut.record.epoch)));
			return Object.hasOwn(cut.record, "archiveAppend") && projection?.record.epoch === cut.record.epoch;
		});
		const closed = complete.filter(generation => {
			const closure = recoveryCensusClosure(reader, generation.closure);
			const cut = closure === undefined ? undefined : uniqueCandidateByKind(closure, "drp-hard-epoch-cut");
			return cut !== undefined && uniqueCandidateByKind(closure!, currentProjectionKind(Number(cut.record.epoch)))?.record.epoch === cut.record.epoch;
		});
		if (candidates.length !== 0 && candidates.length !== closed.length)
			throw new TypeError("archive Complete recovery conflicts with another original closed intent");
		if (!(await reader.checkCurrency()).ok) throw new TypeError("archive Complete recovery discovery source changed");
		await checkFloor();
		return Object.freeze({ head: Object.freeze({ ...head }), generationIds: Object.freeze(candidates.map(row => row.generationId)) });
	});
	if (discovery.generationIds.length === 0) return readCreatorSuccessorExportMaterial(input, undefined, { accounting, checkFloor });
	let selected: ArchiveCloseExportFacts | undefined;
	for (const generationId of discovery.generationIds) {
		let facts: ArchiveCloseExportFacts | undefined;
		await readCreatorSuccessorExportMaterial(input, { generationId, expectedHead: discovery.head, accounting, checkFloor,
			capture: value => { facts = value; } });
		if (facts === undefined || !sameCreatorRoomHead(initialFloor.state.stable, facts.predecessorTrust) ||
			(initialFloor.state.pending !== null && (!sameCreatorRoomHead(initialFloor.state.pending.previous, facts.predecessorTrust) ||
				!sameCreatorRoomHead(initialFloor.state.pending.next, facts.successorTrust))))
			throw new TypeError("archive Complete recovery certificate differs from the original source/target floor");
		if (selected !== undefined) throw new TypeError("archive Complete recovery has ambiguous original close intents");
		selected = facts;
	}
	if (selected === undefined) throw new TypeError("archive Complete recovery has no authenticated close");
	const original = selected;
	if (native.readRetirementControl === undefined) throw new TypeError("archive Complete recovery native floor owner is unavailable");
	const readNativeFloor = async () => {
		const result = await native.readRetirementControl!(input.objectId);
		if (!result.ok || !accounting.charge(encodeCanonical(result.value)))
			throw new TypeError("archive Complete recovery native floor is unavailable or exhausted");
		const control = result.value;
		const recordDigest = digestBlob(encodeGenerationRecordV1(original.generation));
		const nominee = control?.nominee;
		if (control?.active != null || control?.completed?.generationDrain?.phase === "pending" ||
			(control?.completed != null && control.completed.throughEpoch >= original.successorTrust.currentEpoch) ||
			(nominee != null && (nominee.epoch !== original.successorTrust.currentEpoch ||
				nominee.generationId !== original.generation.generationId || nominee.baseExpectedHead.kind !== "present" ||
				!sameHead(nominee.baseExpectedHead, original.actualHead) || nominee.closureDigest !== original.generation.closureDigest ||
				compareBytes(encodeCanonical(nominee.permittedReferences), encodeCanonical(original.generation.closure)) !== 0 ||
				!recordDigest.ok || nominee.recordDigest !== recordDigest.value)))
			throw new TypeError("archive Complete recovery native floor/nominee differs from the original certified intent");
		return control;
	};
	let nativeFloor = await readNativeFloor();
	let nativeFloorBytes = encodeCanonical(nativeFloor);
	const checkCurrent = async (): Promise<void> => {
		const control = await readNativeFloor();
		if (compareBytes(encodeCanonical(control), nativeFloorBytes) !== 0)
			throw new TypeError("archive Complete recovery native whole floor changed");
		let fresh: ArchiveCloseExportFacts | undefined;
		await readCreatorSuccessorExportMaterial(input, { generationId: original.generation.generationId,
			expectedHead: original.actualHead, accounting, checkFloor, capture: value => { fresh = value; } });
		if (fresh === undefined || compareBytes(fresh.nativeGenerationBytes, original.nativeGenerationBytes) !== 0 ||
			compareBytes(encodeCanonical(fresh.generation), encodeCanonical(original.generation)) !== 0 ||
			fresh.nativeBlobs.length !== original.nativeBlobs.length || fresh.nativeBlobs.some(blob => {
				const captured = original.nativeBlobs.find(value => sameRef(value.ref, blob.ref));
				return captured === undefined || !sameBytes(captured.bytes, blob.bytes);
			})) throw new TypeError("archive Complete recovery original full source census changed");
	};
	const cut = uniqueCandidateByKind(original.candidates, "drp-hard-epoch-cut"),
		qc = uniqueCandidateByKind(original.candidates, "drp-seal-qc"),
		trust = uniqueCandidateByKind(original.candidates, "drp-anchor-trust-state");
	if (cut === undefined || qc === undefined || trust === undefined)
		throw new TypeError("archive Complete recovery exact certification bytes are missing");
	const archiveCompletion = await completeCreatorCertifiedArchiveAppend({ archiveStore, accounting, currentTrust: original.predecessorTrust,
		exactCanonicalCutValueBytes: cut.bytes, exactCanonicalCommitQcBytes: qc.bytes,
		exactCanonicalTrustStateRecordBytes: trust.bytes, checkCurrent });
	if (archiveCompletion === undefined) throw new TypeError("archive Complete recovery certified append is missing");
	await checkCurrent();
	const future = nativeFloor?.completed != null
		? createCreatorAuthenticatedNativeFuture({ owner: original, store: input.store,
			successorTrust: original.successorTrust, currentHead: original.actualHead,
			generationId: original.generation.generationId, acceptedClosure: original.generation.closure,
			newBlobs: [], existingCompleteGeneration: original.generation }) : undefined;
	if (future !== undefined) {
		await applyCreatorPendingNativeFuture(native, input.snapshotStore, input.objectId, future, "stage");
		// Only the original authenticated existing-row stage may change this local nominee.
		// Re-read its exact bounded native association; never accept a foreign target or epoch.
		nativeFloor = await readNativeFloor();
		nativeFloorBytes = encodeCanonical(nativeFloor);
		await checkCurrent();
	}
	try {
		if (future !== undefined) await applyCreatorPendingNativeFuture(native, input.snapshotStore, input.objectId, future, "publish");
		else await input.store.swapHead({ objectId: input.objectId, expectedHead: original.actualHead,
			generationId: original.generation.generationId });
	} catch (cause) {
		if (cause instanceof AggregateError) throw cause;
		// An ambiguous original CAS is resolved ONLY by exact native head and original authentication below.
	}
	await checkFloor();
	const published = await input.store.readHead(input.objectId);
	if (!published.ok || published.value.kind !== "present" || !sameHead(published.value, original.selectedHead) ||
		!accounting.charge(encodeCanonical(published.value)))
		throw new TypeError("archive Complete recovery original close CAS remains unpublished");
	const exported = await readCreatorSuccessorExportMaterial(input, undefined, { accounting, checkFloor });
	if (!sameBytes(exported.offer.exactCanonicalCutValueBytes, cut.bytes) ||
		!sameBytes(exported.offer.exactCanonicalCommitQcBytes, qc.bytes) ||
		!sameBytes(exported.offer.exactCanonicalTrustStateRecordBytes, trust.bytes))
		throw new TypeError("archive Complete recovery delivery differs from the original certificate");
	await withCreatorRecoveryCensus(input.store, input.objectId, async reader => {
		const generation = reader.generations.find(row => row.generationId === original.generation.generationId);
		if (reader.head.kind !== "present" || !sameHead(reader.head, original.selectedHead) || generation?.state !== "Adopted" ||
			compareBytes(encodeCanonical({ ...original.generation, state: "Adopted" }), encodeCanonical(generation)) !== 0 ||
			recoveryCensusClosure(reader, generation.closure) === undefined)
			throw new TypeError("archive Complete recovery original published native intent differs");
		for (const bytes of [encodeCanonical(reader.head), encodeCanonical(reader.generations),
			encodeCanonical(reader.blobs.map(blob => blob.ref)), ...reader.blobs.map(blob => blob.bytes)])
			if (!accounting.charge(bytes)) throw new TypeError("archive Complete recovery published full PRE charge is exhausted");
		if (!(await reader.checkCurrency()).ok) throw new TypeError("archive Complete recovery published native currency changed");
		await checkFloor();
	});
	const retained = await archiveStore.readAppendDeclaration({ sourceEpoch: Number(cut.record.epoch),
		sourceAnchorDigest: String(cut.record.previousAnchor), sourceCloseSetRoot: String(cut.record.closeSetRoot) });
	if (retained?.phase !== "committed" ||
		compareBytes(encodeCanonical(retained.declaration), archiveCompletion.exactCanonicalDeclarationBytes) !== 0 ||
		!accounting.charge(encodeCanonical(retained)))
		throw new TypeError("archive Complete recovery committed native declaration changed or exhausted");
	const archiveRead = await archiveStore.acquireRead(archiveCompletion.position);
	let readFailed = false, readCause: unknown;
	try {
		for (const artifact of retained.declaration.artifacts) if (!accounting.charge(await archiveRead.readArtifact(artifact)))
			throw new TypeError("archive Complete recovery delivery artifact charge is exhausted");
		await archiveRead.check();
		await checkFloor();
	} catch (cause) { readFailed = true; readCause = cause; throw cause; }
	finally { await releaseCreatorRecoveryReader(archiveRead, readFailed, readCause, "archive Complete recovery delivery read failed to join"); }
	await checkFloor();
	return exported;
}

/** Genuine room-native ports; neither an incoming certificate nor a supplied
 * scope list can grant turnover. No finality signer is required. */
export type CreatorRecipientRecoveryContext = Pick<CreatorClosedRollbackDataInput,
	"roomHeadAuthority" | "pinnedGenesisAnchorDigest" | "exactCanonicalPinnedGenesisTrustStateRecordBytes"> &
	Pick<Parameters<typeof createCreatorSigningRecoveryOwner>[0], "voteStore" | "evidenceStore" | "storageIncarnation">;
type CreatorRecipientSource = NonNullable<ReturnType<typeof resolveCreatorRecipientRegistration>>;
type ReceivedRecoverySeal = NonNullable<Awaited<ReturnType<CreatorRecipientSource["sealReceivedRecoveryDependencies"]>>>;
type ReceivedSigningOwner = Extract<Awaited<ReturnType<typeof createCreatorSigningRecoveryOwner>>, {ok: true}>["owner"];

/** Scheduling only. The received turnover is decided by current state: the pool
 * is full, or the current Cut still classifies scopes this recipient retains.
 * Reconcile an authenticated CURRENT classification while this recipient still
 * owns those alternatives, before the creator retires its copy and a later Cut
 * legitimately stops spelling them. Full native/source/transfer authentication
 * remains in the original owner. */
async function receivedRecoveryTurnoverDue(source: CreatorRecipientSource,
	snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>,
	currentCandidates: Awaited<ReturnType<typeof inspectHead>>["candidates"]): Promise<boolean> {
	if (source.currentTrust.currentEpoch < 2) return false;
	const inventory = await snapshotStore.captureRecoveryRoleInventory?.({objectId: source.objectId});
	const currentCut = uniqueCreatorTransitionCandidate(currentCandidates, "drp-hard-epoch-cut", source.currentTrust.currentEpoch - 1);
	const currentRoles = currentCut === undefined ? undefined : captureCreatorSnapshotRecoveryRoles(canonicalRecord(currentCut.bytes)?.recoveryRoles);
	const classifiedPresent = currentRoles?.classifiedScopes.some(scope => inventory?.scopes.some(row =>
		row.scope.objectId === scope.objectId && row.scope.epoch === scope.epoch && row.scope.anchor === scope.anchor &&
		row.scope.manifestDigest === scope.manifestDigest)) === true;
	return inventory !== undefined && inventory.owner.migration === "ready" &&
		(inventory.owner.recoveryScopes >= inventory.owner.limits.maxRecoveryScopes || classifiedPresent);
}

/** The original bounded received turnover: one signing census bounds the passes;
 * each pass seals the received dependencies, reconciles, and joins its hold. */
async function runReceivedRecoveryTurnoverPasses(input: Readonly<{
	source: CreatorRecipientSource;
	snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
	catalog: TrustedBlueprintCatalog;
	context: CreatorRecipientRecoveryContext;
	signing: ReceivedSigningOwner;
	requireClosedWorkflowCompletion?: boolean;
}>, seal: () => Promise<ReceivedRecoverySeal | undefined>): Promise<readonly GenerationRecord[]> {
	const { source, context } = input;
	const census = await input.signing.captureRetirementOwners().acquireEvidence();
	const epochs = new Set<number>();
	let censusFailed = false, censusPrimary: unknown;
	try {
		for (const bytes of census.readExactCanonicalRows()) {
			const frame = decodeCanonical(bytes) as unknown[];
			if (frame[0] === "signerState") epochs.add((frame[1] as [string, number, string])[1]);
		}
		await census.check();
	} catch (error) {censusFailed = true; censusPrimary = error; throw error;}
	finally {await releaseCreatorRecoveryReader(census, censusFailed, censusPrimary, "creator recipient signing census cleanup failed");}
	const retired: GenerationRecord[] = [];
	const maxPasses = 2 + epochs.size + AHE_BOUNDED_READ_LIMITS.maxObjectGenerations;
	for (let pass = 0; pass < maxPasses; pass++) {
		const sealed = await seal();
		if (sealed === undefined) throw new TypeError("creator recipient recovery dependencies unavailable");
		const lifetime = resolveCreatorSnapshotRecoveryCloseHold(sealed.hold,
			{store: source.store, liveJournalStore: source.liveJournalStore, currentTrust: source.currentTrust});
		if (lifetime === undefined) throw new TypeError("creator recipient recovery dependency custody differs");
		let checkpoint: "complete" | "fresh-summary-required";
		let retirementFailed = false, retirementPrimary: unknown;
		try {
			// A recipient runs no other maintenance inside the journal membership
			// window, so a generation drain that suppressed this pass's collectible
			// journal prefixes requests one more fresh pass (still bounded below).
			checkpoint = await reconcileCreatorReceivedSnapshotRecoveryRoles({
				roomHeadAuthority: context.roomHeadAuthority, pinnedGenesisAnchorDigest: context.pinnedGenesisAnchorDigest,
				exactCanonicalPinnedGenesisTrustStateRecordBytes: context.exactCanonicalPinnedGenesisTrustStateRecordBytes,
				catalog: input.catalog,
				objectId: source.objectId, store: source.store, snapshotStore: input.snapshotStore,
				liveJournalStore: source.liveJournalStore}, sealed.hold, input.requireClosedWorkflowCompletion === true);
			retired.push(...sealed.readRetiredGenerations());
		} catch (error) {retirementFailed = true; retirementPrimary = error; throw error;}
		finally {await releaseCreatorRecoveryReader(lifetime, retirementFailed, retirementPrimary, "creator recipient retirement dependencies cleanup failed");}
		if (checkpoint === "complete") break;
		if (pass === maxPasses - 1) throw new TypeError("creator recipient bounded retirement did not stabilize");
	}
	return retired;
}

/**
 * Whether a durable reopen left this recipient's plane halted on its own completed
 * retirement at the current epoch. Observation only: it grants no admission.
 * @param plane - The recipient's genuine live plane.
 * @returns Whether the original received reconstruction is still owed.
 */
export function creatorRecipientRetirementResumeRequested(plane: V3PlaneHandle): boolean {
	return resolveCreatorRecipientRegistration(plane, true)?.needsOrdinaryReadinessRecovery() === true;
}

/**
 * Explicit opt-in early recipient turnover at a caller-chosen quiescent lull.
 * Because the install's predicate is state-based, the SAME original passes run
 * now make it false at the next install; inline install turnover remains the
 * backstop. This grants no authority: an unavailable or busy boundary is
 * reported before entry, never forced. After entry, any failure is recovery work.
 * With `resume`, the SAME passes instead discharge a durable reopen's halt on a
 * retirement this copy completed at its current epoch (a creator's readiness
 * boundary does this for the creator): they must reach the original terminal
 * reconciliation before the halt clears. A plane without that request reports
 * "not-needed" or "deferred" and is left untouched.
 * @param input - The recipient's genuine live plane, catalog, current room head and native ports.
 * @returns Whether the boundary maintained the pool, found no pressure, or deferred.
 */
export async function maintainCreatorRecipientRecoveryPool(input: Readonly<{
	plane: V3PlaneHandle;
	catalog: TrustedBlueprintCatalog;
	expectedRoomHead: Readonly<{ objectId: string; epoch: number; currentAnchorDigest: string }>;
	snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
	recoveryContext: CreatorRecipientRecoveryContext;
	resume?: true;
}>): Promise<CreatorRecoveryPoolResult> {
	const resume = input.resume === true;
	const source = resolveCreatorRecipientRegistration(input.plane, resume);
	if (source === undefined || input.snapshotStore.captureRecoveryRoleInventory === undefined)
		return Object.freeze({kind: "deferred", reason: "unsupported"});
	if (!sameCreatorRoomHead(input.expectedRoomHead, source.currentTrust))
		return Object.freeze({kind: "deferred", reason: "busy"});
	// Observational point reads before any admission: "not-needed" leaves the
	// received gate, ordinary issuance and native state untouched. A resume is
	// requested by the plane's own halt, not by pool pressure.
	if (resume ? !source.needsOrdinaryReadinessRecovery() :
		!(await receivedRecoveryTurnoverDue(source, input.snapshotStore, (await inspectHead(source.store, source.objectId)).candidates)))
		return Object.freeze({kind: "not-needed"});
	const context = input.recoveryContext;
	const opened = await createCreatorSigningRecoveryOwner({currentTrust: source.currentTrust,
		voteStore: context.voteStore, evidenceStore: context.evidenceStore, storageIncarnation: context.storageIncarnation});
	if (!opened.ok) throw new TypeError(`creator recipient signing custody unavailable: ${opened.reason}`);
	let outcome: "ran" | "deferred";
	try {
		outcome = await source.runReceivedRecoveryMaintenance(opened.owner, input.snapshotStore, async (seal, requireClosedWorkflowCompletion) => {
			// These generations belong to this stable boundary. The next install's
			// own turnover (if any) classifies from the state it then observes.
			await runReceivedRecoveryTurnoverPasses({source, snapshotStore: input.snapshotStore, catalog: input.catalog,
				context, signing: opened.owner, requireClosedWorkflowCompletion}, seal);
			return "complete";
		}, resume ? {resume: true} : {deferrable: true});
	} finally {
		await opened.owner.stop();
	}
	return Object.freeze(outcome === "deferred" ? {kind: "deferred", reason: "busy"} : {kind: "maintained"});
}

// Receive-time currency is the native head record alone: its closure digest binds
// every content-addressed blob that the initial inspection already authenticated.
async function nativeHeadUnchanged(
	store: AheDurableStore,
	objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0],
	expected: PresentHead
): Promise<boolean> {
	const recovered = await store.recoverActiveGeneration(objectId);
	return recovered.ok && recovered.value.kind === "active" && sameHead(recovered.value.head, expected);
}

/**
 * Received provenance is minted only by verified current custody, signed adjacency and retained destination bytes.
 * Promoted custody owns held native historical readers until the caller joins
 * releasePromotionDependencies after staging/publication, including on failure.
 * @param input
 */
export async function receiveCreatorSuccessorAdoption(
	input: Readonly<{
		plane: V3PlaneHandle;
		catalog: TrustedBlueprintCatalog;
		offer: CreatorSuccessorOffer;
		expectedRoomHead: Readonly<{ objectId: string; epoch: number; currentAnchorDigest: string }>;
		snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
		transport: SnapshotChunkProtocolPort;
		peers: readonly string[];
		author: string;
		signRegisteredVertexDigest: SignRegisteredVertexDigest;
		exactCanonicalGenesisAnchorPreimageBytes?: Uint8Array;
		detachedGenesisSignature?: Uint8Array;
		recoveryContext?: CreatorRecipientRecoveryContext;
	}>
): Promise<ReceivedCreatorSuccessorAdoption> {
	const source = resolveCreatorRecipientRegistration(input.plane);
	if (source === undefined || !sameCreatorRoomHead(input.expectedRoomHead, source.currentTrust))
		throw new TypeError("creator recipient current authority is unavailable");
	const offer = captureCreatorSuccessorOffer(input.offer);
	const cut = canonicalRecord(offer.exactCanonicalCutValueBytes);
	const promoted = cut !== undefined && Object.hasOwn(cut, "forwardPromotion");
	const opened = (promoted ? openCreatorForwardPromotionSuccessorTrust : openCreatorSuccessorTrust)({
		currentTrust: source.currentTrust,
		exactCanonicalCutValueBytes: offer.exactCanonicalCutValueBytes,
		exactCanonicalCommitQcBytes: offer.exactCanonicalCommitQcBytes,
		exactCanonicalTrustStateRecordBytes: offer.exactCanonicalTrustStateRecordBytes,
	});
	if (
		!opened.ok ||
		cut === undefined ||
		opened.trust.currentEpoch !== source.currentTrust.currentEpoch + 1
	)
		throw new TypeError("creator recipient signed adjacency is invalid");
	const manifest = decodeSnapshotManifest({
		exactCanonicalManifestBytes: offer.exactCanonicalSnapshotManifestBytes,
		expectedManifestDigest: String(cut.snapshotManifestDigest),
		profile: PROFILE,
	});
	if (
		manifest.manifest.objectId !== source.objectId ||
		manifest.manifest.epoch !== source.currentTrust.currentEpoch ||
		manifest.manifest.anchor !== source.currentTrust.currentAnchorDigest
	)
		throw new TypeError("creator recipient manifest predecessor scope is invalid");
	const current = await inspectHead(source.store, source.objectId);
	const currentTrust = current.candidates.find(({ ref }) => sameRef(ref, current.trustRef));
	if (
		currentTrust === undefined ||
		canonicalRecord(currentTrust.bytes)?.currentAnchorDigest !== source.currentTrust.currentAnchorDigest
	)
		throw new TypeError("creator recipient native current differs");
	// Source possession is not an application write. Bind the fixed creator
	// response key to the already-authenticated current anchor's signer-set
	// digest, rather than requiring that creator to have CURRENT Writer role.
	// Ordinary Writer sources and the separate requester read policy remain.
	const signerSetBytes = canonicalRecord(currentTrust.bytes)?.exactCanonicalSignerSetBytes;
	const sourceAnchor = canonicalRecord(source.exactCanonicalAnchorPreimageBytes);
	if (
		!(signerSetBytes instanceof Uint8Array) ||
		hex(hashDomain("ts-drp/signer-set/v3", signerSetBytes)) !== sourceAnchor?.signerSetDigest
	)
		throw new TypeError("creator recipient source signer set differs");
	const sourceSigners = decodeCanonical(signerSetBytes);
	if (
		!Array.isArray(sourceSigners) ||
		sourceSigners.length !== 1 ||
		typeof sourceSigners[0]?.publicKey !== "string" ||
		!/^[0-9a-f]{64}$/u.test(sourceSigners[0].publicKey)
	)
		throw new TypeError("creator recipient source signer is invalid");
	const creatorSourceAuthor = sourceSigners[0].publicKey as string;
	if (!(await source.beginReceived())) throw new TypeError("creator recipient work is unavailable");
	let primary: unknown;
	let failed = false;
	let outcome: ReceivedCreatorSuccessorAdoption | undefined;
	const cleanupErrors: unknown[] = [];
	let receivedOwner: object | undefined;
	let transfer: ReturnType<typeof createV3SnapshotTransferOwner> | undefined;
	let scope: Awaited<ReturnType<typeof input.snapshotStore.openScope>> | undefined;
	let promotionSource: Awaited<ReturnType<typeof acquireCreatorReceivedPromotion>> | undefined;
	let recoverySigning: ReceivedSigningOwner | undefined;
	const retiredGenerations: GenerationRecord[] = [];
	let promotionIdentityBeforeTurnover: ReturnType<typeof resolveCreatorForwardPromotion>;
	const quiesceReceived = (): void => {
		if (receivedOwner !== undefined) revokeCreatorAdoptionFacts(receivedOwner);
		try {
			source.terminalizeReceived();
		} catch (error) {
			cleanupErrors.push(error);
		}
	};
	const prepareReceivedRecoveryTurnover = async (): Promise<boolean> => {
		if (!(await receivedRecoveryTurnoverDue(source, input.snapshotStore, current.candidates))) return false;
		const context = input.recoveryContext;
		if (context === undefined) throw new TypeError("creator recipient turnover native owners are unavailable");
		const openedCustody = await createCreatorSigningRecoveryOwner({currentTrust: source.currentTrust,
			voteStore: context.voteStore, evidenceStore: context.evidenceStore, storageIncarnation: context.storageIncarnation});
		if (!openedCustody.ok) throw new TypeError(`creator recipient signing custody unavailable: ${openedCustody.reason}`);
		recoverySigning = openedCustody.owner;
		if (promotionSource !== undefined) {
			promotionIdentityBeforeTurnover = resolveCreatorForwardPromotion(promotionSource.promotion);
			if (promotionIdentityBeforeTurnover === undefined) throw new TypeError("creator received promotion identity unavailable before turnover");
			await promotionSource.release();
			promotionSource = undefined;
		}
		retiredGenerations.push(...await runReceivedRecoveryTurnoverPasses({source, snapshotStore: input.snapshotStore,
			catalog: input.catalog, context, signing: openedCustody.owner},
			() => source.sealReceivedRecoveryDependencies(openedCustody.owner, input.snapshotStore)));
		return true;
	};
	try {
		transfer = createV3SnapshotTransferOwner({ transport: input.transport });
		const auxiliary = await receiveCreatorSuccessorMaterial({
			transport: input.transport,
			peers: input.peers,
			manifestDigest: manifest.manifestDigest,
			identity: {
				author: input.author,
				sign: input.signRegisteredVertexDigest,
				isAuthorizedAuthor: (author) => {
					const currentAuthority = input.plane.currentEphemeralAuthority();
					return (
						currentAuthority !== undefined &&
						currentAuthority.objectId === source.objectId &&
						currentAuthority.epoch === source.currentTrust.currentEpoch &&
						currentAuthority.anchorDigest === source.currentTrust.currentAnchorDigest &&
						(author === creatorSourceAuthor || currentAuthority.isCurrentWriter(author))
					);
				},
			},
		});
		assertSettlementCompanionProfile(auxiliary.exactCanonicalSettlementBytes,opened.trust.profileId);
		const receivedHistory = openCreatorCloseHistory({
			bytes: auxiliary.exactCanonicalHistoryBytes,
			exactCanonicalCutValueBytes: offer.exactCanonicalCutValueBytes,
			historyRoot: cut.historyRoot,
			historySize: cut.historySize,
		});
		if (receivedHistory === undefined) throw new TypeError("creator received history commitment differs");
		const accumulator = CompactMerkleAccumulator.fromSnapshot(receivedHistory);
		const candidates = [
			offer.exactCanonicalCutValueBytes,
			offer.exactCanonicalCommitQcBytes,
			offer.exactCanonicalTrustStateRecordBytes,
			auxiliary.exactCanonicalSettlementBytes,
			auxiliary.exactCanonicalHistoryBytes,
			...(auxiliary.exactCanonicalSettlementBytes===null?[auxiliary.exactCanonicalRetirementBytes!,auxiliary.exactCanonicalAggregateBytes!]:[]),
		].filter((bytes):bytes is Uint8Array=>bytes!==null).map((bytes) => {
			const digest = digestBlob(bytes);
			if (!digest.ok) throw new TypeError("creator received candidate is invalid");
			return Object.freeze({ bytes, ref: Object.freeze({ digest: digest.value, byteLength: bytes.byteLength }) });
		});
		const [cutCandidate, commitCandidate, trustCandidate] = candidates;
		if (cutCandidate === undefined || commitCandidate === undefined || trustCandidate === undefined)
			throw new TypeError("creator received proof candidates are missing");
		let proposedCandidates = [
			...current.candidates.filter(
				({ ref, bytes }) =>
					ref.digest !== current.trustRef.digest &&
					!new Set(["drp-creator-author-settlement-state","drp-creator-issuance-retirement-state","drp-creator-author-issuance-frontiers-state"]).has(String(canonicalRecord(bytes)?.kind))
			),
			...candidates,
		].sort((a, b) => a.ref.digest.localeCompare(b.ref.digest));
		let proposed: CreatorTransitionClosure = { candidates: proposedCandidates, closure: proposedCandidates.map(({ ref }) => ref) };
		const declaration = Object.freeze({
			chunks: manifest.chunks,
			exactCanonicalManifestBytes: manifest.exactCanonicalManifestBytes,
			totalBytes: Number(manifest.manifest.totalBytes),
			scope: Object.freeze({
				objectId: source.objectId,
				epoch: source.currentTrust.currentEpoch,
				anchor: source.currentTrust.currentAnchorDigest,
				manifestDigest: manifest.manifestDigest,
			}),
		});
		const selector = Object.freeze({
			objectId: declaration.scope.objectId,
			epoch: declaration.scope.epoch,
			anchor: declaration.scope.anchor,
		});
		scope = await input.snapshotStore.openScope(declaration);
		await transfer.receiveBytes({
			authorization: auxiliary.authorization,
			peers: auxiliary.peers,
			descriptors: manifest.chunks,
			exactCanonicalManifestBytes: manifest.exactCanonicalManifestBytes,
			expectedManifestDigest: manifest.manifestDigest,
			quarantine: scope,
		});
		const replay = await source.sealDurableReplay();
		if (replay === undefined || replay.commitment === undefined)
			throw new TypeError("creator recipient native replay is invalid");
		const owner = Object.freeze({});
		receivedOwner = owner;
		let facts: SealedAdoptionFacts = Object.freeze({
			...(source.receiveOnly ? { receiveOnly: true as const } : {}),
			origin: "received",
			receivedCandidates: Object.freeze([...proposedCandidates]),
			transition: Object.freeze({
				cutValueRef: cutCandidate.ref,
				commitQcRef: commitCandidate.ref,
				successorTrustRef: trustCandidate.ref,
				currentTrustRef: current.trustRef,
				epoch: source.currentTrust.currentEpoch,
				successorEpoch: opened.trust.currentEpoch,
				successorAnchorDigest: opened.trust.currentAnchorDigest,
			}),
			currentHead: current.head,
			currentReferences: current.references,
			currentTrust: source.currentTrust,
			durableReplay: replay,
			exactCanonicalLatchedAclBytes: source.exactCanonicalLatchedAclBytes,
			exactCanonicalParametersCarrierBytes: source.exactCanonicalParametersBytes,
			exactCanonicalPinnedGenesisBootstrapOperationBytes: source.exactCanonicalPinnedGenesisBootstrapOperationBytes,
			history: {
				historyRoot: hex(accumulator.root()),
				historySize: accumulator.size,
				historySnapshot: accumulator.snapshot(),
			},
			issuanceScope: source.issuanceScope,
			issuanceStore: source.issuanceStore,
			liveJournalStore: source.liveJournalStore,
			objectId: source.objectId,
			proposedHead: current.head,
			proposedReferences: proposed.closure,
			snapshotDeclaration: declaration,
			snapshotStore: input.snapshotStore,
			sourceRuntimeHandle: new WeakRef(input.plane),
			store: source.store,
			terminalizeSource: (): Promise<boolean> => {
				revokeCreatorAdoptionFacts(owner);
				return Promise.resolve(source.terminalizeReceived());
			},
		});
		// All signed/snapshot/catalog/projection checks are pure or native read-only at this point.
		let chain = verifyChain(
			{ ...facts, proposedReferences: proposed.closure },
			{ currentCandidates: current.candidates, proposedCandidates },
			false
		);
		if (chain === undefined) throw new TypeError("creator received transition is invalid");
		let snapshot = await verifySnapshot(facts, chain);
		const acquireReceivedPromotion = async (closeSnapshot: VerifiedSnapshot) => {
			if (
				!(input.exactCanonicalGenesisAnchorPreimageBytes instanceof Uint8Array) ||
				!(input.detachedGenesisSignature instanceof Uint8Array)
			) throw new TypeError("creator received promotion genesis custody is unavailable");
			return acquireCreatorReceivedPromotion({
				store: source.store,
				snapshotStore: input.snapshotStore,
				catalog: input.catalog,
				expectedHead: current.head,
				currentTrust: source.currentTrust,
				successorTrust: opened.trust,
				currentGenerationId: current.head.generationId,
				exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalGenesisAnchorPreimageBytes,
				detachedGenesisSignature: input.detachedGenesisSignature,
				receivedProposal: { closure: proposed, currentCloseSnapshot: {
					exactCanonicalManifestBytes: declaration.exactCanonicalManifestBytes,
					exactCanonicalPayloadBytes: closeSnapshot.exactCanonicalPayloadBytes,
				} },
			});
		};
		const receivedCloseSnapshot = snapshot;
		if (promoted) {
			if (snapshot === undefined) throw new TypeError("creator received truthful close is invalid");
			// Normalize the genuine staging proposal before strict promotion
			// continuity verification, using truthful current-close ACL bytes.
			const normalized = inspectCreatorTransitionAdvance({
				current: { candidates: current.candidates, closure: current.references },
				currentTrust: source.currentTrust,
				mode: "stage",
				proofRefs: [facts.transition.cutValueRef, facts.transition.commitQcRef],
				proposed,
				successorTrust: opened.trust,
				settlementAcl: {
					current: source.exactCanonicalLatchedAclBytes,
					successor: encodeCanonical(snapshot.payload.acl),
				},
			});
			if (!normalized.ok) throw new TypeError(`creator received promotion transition is invalid: ${normalized.reason}`);
			proposed = normalized.proposed;
			proposedCandidates = [...normalized.proposed.candidates];
			facts = Object.freeze({ ...facts,
				receivedCandidates: Object.freeze([...proposedCandidates]),
				proposedReferences: proposed.closure,
			});
			promotionSource = await acquireReceivedPromotion(snapshot);
			facts = Object.freeze({ ...facts, promotion: Object.freeze({
				verified: promotionSource.promotion,
				source: promotionSource,
				closedEpoch: promotionSource.source.closedEpoch,
			}), certifiedRecoverySourceGenerations: promotionSource.supportGenerations,
			classifiedRecoverySourceGenerations: Object.freeze([...retiredGenerations]) });
			chain = verifyChain(facts, { currentCandidates: current.candidates, proposedCandidates }, false);
			if (chain === undefined) throw new TypeError("creator received promotion source differs");
			snapshot = await selectedPromotionSnapshot(facts, chain, snapshot);
		}
		const resolved =
			snapshot === undefined
				? undefined
				: verifiedCatalog(input.catalog, snapshot.payload.blueprintDigest, chain.currentCatalog);
		const projected =
			snapshot === undefined || resolved === undefined ? undefined : projection(facts, chain, snapshot, resolved);
		if (snapshot === undefined || resolved === undefined || projected === undefined)
			throw new TypeError("creator received snapshot projection is invalid");
		const advance = inspectCreatorTransitionAdvance({
			current: { candidates: current.candidates, closure: current.references },
			currentTrust: source.currentTrust,
			mode: "stage",
			proofRefs: [facts.transition.cutValueRef, facts.transition.commitQcRef],
			proposed,
			successorTrust: opened.trust,
			settlementAcl: {
				current: source.exactCanonicalLatchedAclBytes,
				successor: snapshot.authorizedAclBytes ?? encodeCanonical(snapshot.payload.acl),
			},
		});
		if (!advance.ok) throw new TypeError(`creator received settlement transition is invalid: ${advance.reason}`);
		facts = Object.freeze({
			...facts,
			receivedCandidates: Object.freeze([...advance.proposed.candidates]),
			proposedReferences: advance.proposed.closure,
		});
		// Native custody may already exist after a lost acknowledgement. An unknown
		// lookup outcome cannot release the predecessor receive gate either.
		const retained = await input.snapshotStore.lookupReceivedRecoveryCertificate(selector);
		const previousCertificate =
			retained === null ? undefined : openReceivedCertificate(retained.exactReceivedCertificateBytes);
		const candidate = successorCommitMaterial(
			previousCertificate === undefined
				? facts
				: {
						...facts,
						receivedCandidateGenerationId: previousCertificate.candidateGenerationId,
						receivedCandidateClosureDigest: previousCertificate.candidateClosureDigest,
					},
			{ currentCandidates: current.candidates, proposedCandidates: advance.proposed.candidates },
			projected.bytes,
			chain.currentProjectionKind
		);
		const candidateDigest = candidate === undefined ? undefined : digestClosure(candidate.candidateReferences);
		if (candidate === undefined || candidateDigest === undefined || !candidateDigest.ok)
			throw new TypeError("creator received candidate closure is invalid");
		const certificate = encodeReceivedCertificate(
			Object.freeze({
				kind: "creator-received-recovery-certificate-1",
				pinnedGenesisAnchorDigest: source.currentTrust.genesisAnchorDigest,
				exactCanonicalOldHeadBytes: encodeHeadRecordV1(current.head),
				currentTrustRef: current.trustRef,
				exactCanonicalCutValueBytes: offer.exactCanonicalCutValueBytes,
				exactCanonicalCommitQcBytes: offer.exactCanonicalCommitQcBytes,
				exactCanonicalTrustStateRecordBytes: offer.exactCanonicalTrustStateRecordBytes,
				exactCanonicalSettlementBytes: auxiliary.exactCanonicalSettlementBytes,
				exactCanonicalHistoryBytes: auxiliary.exactCanonicalHistoryBytes,
				...(auxiliary.exactCanonicalSettlementBytes===null?{exactCanonicalRetirementBytes:auxiliary.exactCanonicalRetirementBytes!,
					exactCanonicalAggregateBytes:auxiliary.exactCanonicalAggregateBytes!}:{}),
				sealedReplayDigest: replay.commitment.digest,
				sealedReplayRowCount: replay.commitment.rowCount,
				sealedReplayByteCharge: replay.commitment.byteCharge,
				candidateGenerationId: candidate.generationId,
				candidateClosureDigest: candidateDigest.value,
			})
		);
		if (retained !== null && !sameBytes(retained.exactReceivedCertificateBytes, certificate))
			throw new TypeError("creator received retained certificate conflicts");
		const selected = openReceivedCertificate(certificate);
		facts = Object.freeze({
			...facts,
			receivedCandidateGenerationId: selected.candidateGenerationId,
			receivedCandidateClosureDigest: selected.candidateClosureDigest,
		});
		// Exact certificate equality above authenticates the occupied candidate's
		// predecessor, offer, companions and replay before retention/adoption effects.
		if (!(await nativeHeadUnchanged(source.store, source.objectId, current.head)) || !(await replay.verify()))
			throw new TypeError("creator recipient current changed before turnover");
		if (promotionSource !== undefined) await promotionSource.check();
		// The predecessor scope closes here. While the received gate still freezes
		// its graph, record the recipient's own closed-membership carrier, as the
		// creator does at close; without it no closed recipient journal scope can
		// ever become collectible. Exact Cut agreement only; otherwise nothing is
		// recorded and the scope keeps its original retention.
		await source.recordReceivedClosedMembership(offer.exactCanonicalCutValueBytes, auxiliary.exactCanonicalSettlementBytes);
		if (await prepareReceivedRecoveryTurnover()) {
			if (promoted) {
				if (receivedCloseSnapshot === undefined) throw new TypeError("creator received close snapshot unavailable after turnover");
				promotionSource = await acquireReceivedPromotion(receivedCloseSnapshot);
				const freshIdentity = resolveCreatorForwardPromotion(promotionSource.promotion);
				if (freshIdentity === undefined || promotionIdentityBeforeTurnover === undefined ||
					!sameBytes(encodeCanonical(freshIdentity), encodeCanonical(promotionIdentityBeforeTurnover)))
					throw new TypeError("creator received promotion changed during turnover");
				facts = Object.freeze({ ...facts, promotion: Object.freeze({
					verified: promotionSource.promotion, source: promotionSource,
					closedEpoch: promotionSource.source.closedEpoch,
				}), certifiedRecoverySourceGenerations: promotionSource.supportGenerations });
			}
			facts = Object.freeze({ ...facts, classifiedRecoverySourceGenerations: Object.freeze([...retiredGenerations]) });
			chain = verifyChain(facts, { currentCandidates: current.candidates, proposedCandidates: advance.proposed.candidates }, false);
			if (chain === undefined) throw new TypeError("creator received source changed after turnover");
			let freshSnapshot = await verifySnapshot(facts, chain);
			if (freshSnapshot !== undefined) freshSnapshot = await selectedPromotionSnapshot(facts, chain, freshSnapshot);
			const freshCatalog = freshSnapshot === undefined ? undefined : verifiedCatalog(input.catalog, freshSnapshot.payload.blueprintDigest, chain.currentCatalog);
			const freshProjection = freshSnapshot === undefined || freshCatalog === undefined ? undefined : projection(facts, chain, freshSnapshot, freshCatalog);
			if (freshProjection === undefined || !sameBytes(freshProjection.bytes, projected.bytes))
				throw new TypeError("creator received projection changed during turnover");
			if (!(await nativeHeadUnchanged(source.store, source.objectId, current.head)) || !(await replay.verify()))
				throw new TypeError("creator recipient current changed after turnover");
		}
		await scope.retainForRecovery({ exactReceivedCertificateBytes: certificate });
		const owned = await input.snapshotStore.lookupReceivedRecoveryCertificate(selector);
		if (
			owned === null ||
			(retained !== null && owned.incarnation !== retained.incarnation) ||
			!sameBytes(owned.exactReceivedCertificateBytes, certificate)
		)
			throw new TypeError("creator received retention custody is unavailable");
		if (!(await nativeHeadUnchanged(source.store, source.objectId, current.head)) || !(await replay.verify()))
			throw new TypeError("creator recipient current changed during receive");
		if (
			!installCreatorAdoptionFacts(
				owner,
				Object.freeze({
					...facts,
					receivedCandidates: Object.freeze([...advance.proposed.candidates]),
					proposedReferences: advance.proposed.closure,
				})
			)
		)
			throw new TypeError("creator received provenance conflicts");
		const verified = await verifyCreatorSuccessorAdoption({ catalog: input.catalog, handle: owner });
		if (!verified.ok) throw new TypeError(`creator received adoption verification failed: ${verified.kind}`);
		outcome = Object.freeze({ handle: owner, verified,
			...(promotionSource === undefined ? {} : { releasePromotionDependencies: promotionSource.release }),
		});
	} catch (error) {
		primary = error;
		failed = true;
		// Detached absence/currency reads cannot exclude another native retain
		// through reopening. Fresh authenticated recovery owns progress instead.
		quiesceReceived();
	} finally {
		const cleanup = await Promise.allSettled([
			Promise.resolve().then(() => transfer?.close()),
			Promise.resolve().then(() => scope?.release()),
			Promise.resolve().then(() => failed ? promotionSource?.release() : undefined),
			Promise.resolve().then(() => recoverySigning?.stop()),
		]);
		cleanupErrors.push(...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
	}
	if (cleanupErrors.length > 0) {
		if (!failed) quiesceReceived();
		try { await promotionSource?.release(); }
		catch (error) { cleanupErrors.push(error); }
		throw new AggregateError(
			failed ? [primary, ...cleanupErrors] : cleanupErrors,
			"creator recipient cleanup failed",
			failed ? { cause: primary } : undefined
		);
	}
	if (failed) throw primary;
	if (outcome === undefined) throw new TypeError("creator received adoption outcome is missing");
	return outcome;
}

type FailureKind =
	| "malformed-input"
	| "sealed-live-unavailable"
	| "recovery-failed"
	| "chain-invalid"
	| "journal-invalid"
	| "snapshot-invalid"
	| "blueprint-invalid"
	| "internal-invariant";

type AdoptionFailure = Readonly<{ readonly detail: string; readonly kind: FailureKind; readonly ok: false }>;
type AdoptionSuccess = Readonly<{
	readonly descriptor: Readonly<Record<string, unknown>>;
	readonly intent: CreatorAdoptionIntent;
	readonly ok: true;
}>;

type ReceivedCreatorSuccessorAdoption = Readonly<{
	readonly handle: object;
	readonly verified: AdoptionSuccess;
	readonly releasePromotionDependencies?: () => Promise<void>;
}>;

interface SealedAdoptionFacts {
	/** Same original full recovery-call ledger; bookkeeping only, not source or native authority. */
	readonly proofAccounting?: import("./internal/creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting;
	readonly certifiedRecoverySourceGenerations?: CreatorSuccessorLiveSeed["certifiedRecoverySourceGenerations"];
	readonly classifiedRecoverySourceGenerations?: CreatorSuccessorLiveSeed["classifiedRecoverySourceGenerations"];
	readonly origin: "local-close" | "received";
	readonly receivedCandidateGenerationId?: GenerationId;
	readonly receivedCandidateClosureDigest?: string;
	readonly receivedCandidates?: RecoveredClosure["proposedCandidates"];
	readonly promotion?: Readonly<{
		verified: VerifiedCreatorForwardPromotion;
		source: Pick<CreatorForwardPromotionSourceMaterial, "checkSnapshots" | "historicalSnapshots" | "release">;
		closedEpoch: number;
	}>;
	readonly transition: Pick<
		CreatorLiveCloseResult,
		| "commitQcRef"
		| "currentTrustRef"
		| "cutValueRef"
		| "epoch"
		| "successorAnchorDigest"
		| "successorEpoch"
		| "successorTrustRef"
	>;
	readonly currentHead: PresentHead;
	readonly currentReferences: readonly GenerationRef[];
	readonly currentTrust: CurrentAnchorTrust;
	readonly durableReplay: Readonly<{ verify(): Promise<boolean> }>;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalPinnedGenesisBootstrapOperationBytes?: Uint8Array;
	readonly history: Pick<CloseSetHistoryCommitment, "historyRoot" | "historySize" | "historySnapshot">;
	readonly receiveOnly?: true;
	readonly issuanceScope: DurableIssueScope;
	readonly issuanceStore: DurableIssuanceStore;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0];
	readonly proposedHead: PresentHead;
	readonly proposedReferences: readonly GenerationRef[];
	readonly snapshotDeclaration: SnapshotQuarantineDeclaration;
	readonly snapshotStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
	readonly sourceRuntimeHandle?: WeakRef<object>;
	readonly store: AheDurableStore;
	terminalizeSource(): Promise<boolean>;
}

interface RecoveredClosure {
	readonly currentCandidates: readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[];
	readonly proposedCandidates: readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[];
}

interface VerifiedChain {
	readonly currentCatalog: Readonly<{
		readonly artifactDigest: string;
		readonly artifactId: string;
		readonly blueprintDigest: string;
		readonly catalogDigest: string;
		readonly runtimeProfile: string;
	}>;
	readonly currentAnchor: Readonly<Record<string, unknown>>;
	readonly currentEpoch: number;
	readonly currentProjectionKind: "v3-live-generation-1" | "v3-live-generation-2";
	readonly currentTrustRecord: Readonly<Record<string, unknown>>;
	readonly cut: Readonly<Record<string, unknown>>;
	readonly successorAnchor: Readonly<Record<string, unknown>>;
	readonly successorAnchorBytes: Uint8Array;
	readonly successorEpoch: number;
	readonly successorTrust: CurrentAnchorTrust;
	readonly successorTrustRecord: Readonly<Record<string, unknown>>;
}

interface VerifiedSnapshot {
	readonly exactCanonicalPayloadBytes: Uint8Array;
	readonly manifest: Readonly<Record<string, unknown>>;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly authorizedAclBytes?: Uint8Array;
	readonly promotedSource?: PromotionSource;
}

interface CapturedInput {
	readonly catalog: TrustedBlueprintCatalog;
	readonly handle: object;
}

function failure(kind: FailureKind, detail: string): AdoptionFailure {
	return Object.freeze({ detail, kind, ok: false as const });
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function captureInput(value: unknown): CapturedInput | undefined {
	try {
		if (!record(value) || Object.keys(value).sort().join(",") !== "catalog,handle") return undefined;
		const catalog = Object.getOwnPropertyDescriptor(value, "catalog");
		const handle = Object.getOwnPropertyDescriptor(value, "handle");
		if (
			catalog === undefined ||
			!("value" in catalog) ||
			!record(catalog.value) ||
			handle === undefined ||
			!("value" in handle) ||
			!record(handle.value)
		) {
			return undefined;
		}
		return Object.freeze({ catalog: catalog.value as unknown as TrustedBlueprintCatalog, handle: handle.value });
	} catch {
		return undefined;
	}
}

function sameHead(left: PresentHead, right: PresentHead): boolean {
	return (
		left.closureDigest === right.closureDigest &&
		left.generationId === right.generationId &&
		left.objectId === right.objectId &&
		left.revision === right.revision
	);
}

function sameRef(left: GenerationRef, right: GenerationRef): boolean {
	return left.byteLength === right.byteLength && left.digest === right.digest;
}

function sameClosure(left: readonly GenerationRef[], right: readonly GenerationRef[]): boolean {
	return left.length === right.length && left.every((ref, index) => sameRef(ref, right[index] as GenerationRef));
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function currentProjectionKind(epoch: number): "v3-live-generation-1" | "v3-live-generation-2" {
	return epoch === 0 ? "v3-live-generation-1" : "v3-live-generation-2";
}

function factsFor(handle: unknown): SealedAdoptionFacts | undefined {
	return handle !== null && typeof handle === "object"
		? resolveCreatorAdoptionFacts<SealedAdoptionFacts>(handle)
		: undefined;
}

function validGenerationLineage(generations: readonly GenerationRecord[], facts: SealedAdoptionFacts): boolean {
	const byId = new Map(generations.map((generation) => [generation.generationId, generation]));
	if (byId.size !== generations.length) return false;
	const current = byId.get(facts.currentHead.generationId);
	const proposed = byId.get(facts.proposedHead.generationId);
	if (
		current === undefined ||
		proposed === undefined ||
		current.state !== "Superseded" ||
		proposed.state !== "Adopted" ||
		proposed.baseExpectedHead.kind !== "present" ||
		!sameHead(proposed.baseExpectedHead, facts.currentHead) ||
		!sameClosure(current.closure, facts.currentReferences) ||
		!sameClosure(proposed.closure, facts.proposedReferences)
	) {
		return false;
	}
	for (const generation of generations) {
		if (new Set(generation.closure.map(({ digest }) => digest)).size !== generation.closure.length) return false;
		if (
			generation.baseExpectedHead.kind === "present" &&
			(generation.baseExpectedHead.generationId === generation.generationId ||
				!byId.has(generation.baseExpectedHead.generationId))
		) {
			return false;
		}
	}
	return facts.proposedHead.revision === facts.currentHead.revision + 1;
}

async function loadClosure(
	store: AheDurableStore,
	references: readonly GenerationRef[],
	accounting?: SealedAdoptionFacts["proofAccounting"]
): Promise<readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[] | undefined> {
	const candidates: Array<Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>> = [];
	for (const ref of references) {
		const loaded = await store.getBlob(ref.digest);
		if (!loaded.ok || loaded.value === null) return undefined;
		if (accounting !== undefined) {
			const digest = digestBlob(loaded.value);
			if (loaded.value.byteLength !== ref.byteLength || !digest.ok || digest.value !== ref.digest ||
				!accounting.charge(loaded.value) || !accounting.charge(encodeCanonical(ref))) return undefined;
		}
		candidates.push(Object.freeze({ bytes: Uint8Array.from(loaded.value), ref: Object.freeze({ ...ref }) }));
	}
	return Object.freeze(candidates);
}

async function readGenerationLineage(
	store: AheDurableStore,
	objectId: StorageObjectId,
	accounting?: SealedAdoptionFacts["proofAccounting"]
): Promise<readonly GenerationRecord[] | undefined> {
	const generations: GenerationRecord[] = [];
	const seenCursors = new Set<GenerationPageCursor>();
	let cursor: GenerationPageCursor | undefined;
	for (;;) {
		const page = await store.readGenerationPage({
			...(cursor === undefined ? {} : { cursor }),
			limit: 128,
			objectId,
		});
		if (!page.ok || (page.value.generations.length === 0 && page.value.nextCursor !== null)) return undefined;
		if (accounting !== undefined && (!accounting.charge(encodeCanonical(page.value)) ||
			generations.length + page.value.generations.length > AHE_BOUNDED_READ_LIMITS.maxObjectGenerations)) return undefined;
		generations.push(...page.value.generations);
		if (page.value.nextCursor === null) return Object.freeze(generations);
		if (seenCursors.has(page.value.nextCursor)) return undefined;
		seenCursors.add(page.value.nextCursor);
		cursor = page.value.nextCursor;
	}
}

async function acquireCreatorRecoveryCensus(
	store: AheDurableStore,
	objectId: StorageObjectId,
	accounting?: SealedAdoptionFacts["proofAccounting"]
): Promise<AheBoundedRecoveryRoleRead> {
	const owner = store as Partial<AheBoundedRecoveryRoleStore>;
	if (typeof owner.acquireBoundedRecoveryRoleRead !== "function")
		throw new TypeError("creator bounded native recovery owner is unavailable");
	const acquired = await owner.acquireBoundedRecoveryRoleRead({ objectId, limits: AHE_BOUNDED_READ_LIMITS });
	if (!acquired.ok) throw new TypeError("creator bounded native recovery census failed");
	if (accounting !== undefined) {
		try {
			if (!accounting.charge(encodeCanonical(acquired.value.head)) ||
				!accounting.charge(encodeCanonical(acquired.value.generations)))
				throw new TypeError("creator native recovery census proof capacity refused");
			for (const entry of acquired.value.blobs) if (!accounting.charge(encodeCanonical(entry.ref)) ||
				!accounting.charge(entry.bytes)) throw new TypeError("creator native recovery PRE capacity refused");
		} catch (error) {
			await releaseCreatorRecoveryReader(acquired.value, true, error, "creator native recovery capacity cleanup failed");
			throw error;
		}
	}
	return acquired.value;
}

async function withCreatorRecoveryCensus<T>(
	store: AheDurableStore,
	objectId: StorageObjectId,
	operation: (reader: AheBoundedRecoveryRoleRead) => Promise<T>
): Promise<T> {
	const reader = await acquireCreatorRecoveryCensus(store, objectId);
	let failed = false;
	let primary: unknown;
	try {
		return await operation(reader);
	} catch (error) {
		failed = true;
		primary = error;
		throw error;
	} finally {
		await releaseCreatorRecoveryReader(reader, failed, primary, "creator recovery census cleanup failed");
	}
}

async function releaseCreatorRecoveryReader(
	reader: Pick<AheBoundedRecoveryRoleRead, "release"> | undefined,
	failed: boolean,
	primary: unknown,
	message: string
): Promise<void> {
	try {
		await reader?.release();
	} catch (error) {
		if (failed) throw new AggregateError([primary, error], message, { cause: primary });
		throw error;
	}
}

function recoveryCensusClosure(
	reader: AheBoundedRecoveryRoleRead,
	references: readonly GenerationRef[]
): RecoveredClosure["currentCandidates"] | undefined {
	if (references.length > AHE_BOUNDED_READ_LIMITS.maxClosureReferences) return undefined;
	const entries = references.map((ref) => reader.blobs.find((entry) => sameRef(entry.ref, ref)));
	if (
		entries.some(
			(entry) =>
				entry === undefined ||
				entry.bytes.byteLength !== entry.ref.byteLength ||
				entry.bytes.byteLength > AHE_BOUNDED_READ_LIMITS.maxBlobBytes ||
				((): boolean => {
					const digest = digestBlob(entry.bytes);
					return !digest.ok || digest.value !== entry.ref.digest;
				})()
		)
	)
		return undefined;
	return Object.freeze(entries as RecoveredClosure["currentCandidates"]);
}

async function recoverClosure(facts: SealedAdoptionFacts): Promise<RecoveredClosure | undefined> {
	const recovered = await facts.store.recoverActiveGeneration(facts.objectId);
	if (!recovered.ok || recovered.value.kind !== "active") return undefined;
	if (facts.proofAccounting !== undefined && !facts.proofAccounting.charge(encodeCanonical(recovered.value))) return undefined;
	const active = recovered.value;
	if (facts.origin === "received") {
		if (
			!sameHead(active.head, facts.currentHead) ||
			!sameHead(facts.proposedHead, facts.currentHead) ||
			active.adoptedGeneration.state !== "Adopted" ||
			!sameClosure(active.references, facts.currentReferences) ||
			!sameClosure(active.adoptedGeneration.closure, facts.currentReferences) ||
			facts.receivedCandidates === undefined ||
			!sameClosure(
				facts.receivedCandidates.map(({ ref }) => ref),
				facts.proposedReferences
			)
		)
			return undefined;
		const currentCandidates = await loadClosure(facts.store, facts.currentReferences, facts.proofAccounting);
		return currentCandidates === undefined
			? undefined
			: Object.freeze({
					currentCandidates,
					proposedCandidates: facts.receivedCandidates,
				});
	}
	const pending = sameHead(active.head, facts.proposedHead);
	const adopted =
		!pending &&
		active.head.objectId === facts.proposedHead.objectId &&
		active.head.revision === facts.proposedHead.revision + 1 &&
		active.adoptedGeneration.baseExpectedHead.kind === "present" &&
		sameHead(active.adoptedGeneration.baseExpectedHead, facts.proposedHead);
	if (!pending && !adopted) return undefined;
	if (
		pending &&
		(active.references.length !== facts.proposedReferences.length ||
			active.adoptedGeneration.closure.length !== facts.proposedReferences.length ||
			!facts.proposedReferences.every((ref, index) => sameRef(ref, active.references[index] as GenerationRef)) ||
			!facts.proposedReferences.every((ref, index) =>
				sameRef(ref, active.adoptedGeneration.closure[index] as GenerationRef)
			))
	) {
		return undefined;
	}
	const closureDigest = digestClosure(active.references);
	if (!closureDigest.ok || closureDigest.value !== active.head.closureDigest) return undefined;
	const generations = await readGenerationLineage(facts.store, facts.objectId, facts.proofAccounting);
	if (generations === undefined) return undefined;
	if (pending && !validGenerationLineage(generations, facts)) return undefined;
	if (adopted) {
		const current = generations.find(({ generationId }) => generationId === facts.currentHead.generationId);
		const proposed = generations.find(({ generationId }) => generationId === facts.proposedHead.generationId);
		const successor = generations.find(({ generationId }) => generationId === active.head.generationId);
		if (
			current?.state !== "Superseded" ||
			proposed?.state !== "Superseded" ||
			successor?.state !== "Adopted" ||
			proposed.baseExpectedHead.kind !== "present" ||
			!sameHead(proposed.baseExpectedHead, facts.currentHead) ||
			successor.baseExpectedHead.kind !== "present" ||
			!sameHead(successor.baseExpectedHead, facts.proposedHead)
		) {
			return undefined;
		}
	}
	const [currentCandidates, proposedCandidates] = await Promise.all([
		loadClosure(facts.store, facts.currentReferences, facts.proofAccounting),
		loadClosure(facts.store, facts.proposedReferences, facts.proofAccounting),
	]);
	return currentCandidates === undefined || proposedCandidates === undefined
		? undefined
		: Object.freeze({ currentCandidates, proposedCandidates });
}

function bytesForRef(candidates: RecoveredClosure["proposedCandidates"], ref: GenerationRef): Uint8Array | undefined {
	return candidates.find((candidate) => sameRef(candidate.ref, ref))?.bytes;
}

function verifyChain(
	facts: Pick<
		SealedAdoptionFacts,
		"transition" | "promotion" | "currentTrust" | "currentReferences" | "proposedReferences"
	>,
	closure: RecoveredClosure,
	inspectAdvance = true
): VerifiedChain | undefined {
	const { transition } = facts;
	const cutBytes = bytesForRef(closure.proposedCandidates, transition.cutValueRef);
	const commitBytes = bytesForRef(closure.proposedCandidates, transition.commitQcRef);
	const successorTrustBytes = bytesForRef(closure.proposedCandidates, transition.successorTrustRef);
	const currentTrustBytes = closure.currentCandidates.find((candidate) =>
		sameRef(candidate.ref, transition.currentTrustRef)
	)?.bytes;
	if (
		cutBytes === undefined ||
		commitBytes === undefined ||
		successorTrustBytes === undefined ||
		currentTrustBytes === undefined
	) {
		return undefined;
	}
	const promotion =
		facts.promotion === undefined ? undefined : resolveCreatorForwardPromotion(facts.promotion.verified);
	const promotedCut = Object.hasOwn(canonicalRecord(cutBytes) ?? {}, "forwardPromotion");
	// Received pure preflight may open signed adjacency before acquiring native
	// historical custody. Complete verification never accepts that alone.
	if (promotedCut && promotion === undefined && inspectAdvance) return undefined;
	if (
		facts.promotion !== undefined &&
		(promotion === undefined ||
			promotion.currentAnchorDigest !== facts.currentTrust.currentAnchorDigest ||
			promotion.successorAnchorDigest !== transition.successorAnchorDigest)
	)
		return undefined;
	const opened = (promotedCut ? openCreatorForwardPromotionSuccessorTrust : openCreatorSuccessorTrust)({
		currentTrust: facts.currentTrust,
		exactCanonicalCommitQcBytes: commitBytes,
		exactCanonicalCutValueBytes: cutBytes,
		exactCanonicalTrustStateRecordBytes: successorTrustBytes,
	});
	if (
		!opened.ok ||
		opened.trust.currentAnchorDigest !== transition.successorAnchorDigest ||
		opened.trust.currentEpoch !== transition.successorEpoch
	) {
		return undefined;
	}
	const advance = inspectCreatorTransitionAdvance({
		current: { candidates: closure.currentCandidates, closure: facts.currentReferences },
		currentTrust: facts.currentTrust,
		mode: "verify",
		proofRefs: [transition.cutValueRef, transition.commitQcRef],
		proposed: { candidates: closure.proposedCandidates, closure: facts.proposedReferences },
		successorTrust: opened.trust,
	});
	if (inspectAdvance && !advance.ok) return undefined;
	const cut = canonicalRecord(cutBytes);
	const currentTrustRecord = canonicalRecord(currentTrustBytes);
	const successorTrustRecord = canonicalRecord(successorTrustBytes);
	if (
		cut === undefined ||
		currentTrustRecord === undefined ||
		successorTrustRecord === undefined ||
		!(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
		!(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array)
	) {
		return undefined;
	}
	const currentAnchor = canonicalRecord(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
	const successorAnchorBytes = Uint8Array.from(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
	const successorAnchor = canonicalRecord(successorAnchorBytes);
	const currentEpoch = facts.currentTrust.currentEpoch;
	const successorEpoch = opened.trust.currentEpoch;
	if (
		!Number.isSafeInteger(currentEpoch) ||
		currentEpoch < 0 ||
		!Number.isSafeInteger(successorEpoch) ||
		successorEpoch !== currentEpoch + 1 ||
		facts.transition.epoch !== currentEpoch ||
		facts.transition.successorEpoch !== successorEpoch ||
		currentTrustRecord.currentEpoch !== currentEpoch ||
		successorTrustRecord.currentEpoch !== successorEpoch ||
		currentAnchor?.epoch !== currentEpoch ||
		successorAnchor?.epoch !== successorEpoch ||
		successorAnchor?.previousAnchor !== facts.currentTrust.currentAnchorDigest
	) {
		return undefined;
	}
	const expectedCurrentProjectionKind = currentProjectionKind(currentEpoch);
	const projections = closure.currentCandidates
		.map(({ bytes }) => canonicalRecord(bytes))
		.filter((candidate) => candidate?.kind === expectedCurrentProjectionKind);
	const currentProjection = projections.length === 1 ? projections[0] : undefined;
	if (
		currentAnchor === undefined ||
		successorAnchor === undefined ||
		currentProjection === undefined ||
		currentProjection.epoch !== currentEpoch ||
		typeof currentProjection.artifactDigest !== "string" ||
		typeof currentProjection.artifactId !== "string" ||
		typeof currentProjection.blueprintDigest !== "string" ||
		typeof currentProjection.catalogDigest !== "string" ||
		typeof currentProjection.runtimeProfile !== "string" ||
		currentProjection.blueprintDigest !== currentAnchor.blueprintDigest ||
		currentProjection.blueprintDigest !== successorAnchor.blueprintDigest
	) {
		return undefined;
	}
	return Object.freeze({
		currentAnchor,
		currentEpoch,
		currentProjectionKind: expectedCurrentProjectionKind,
		currentTrustRecord,
		currentCatalog: Object.freeze({
			artifactDigest: currentProjection.artifactDigest,
			artifactId: currentProjection.artifactId,
			blueprintDigest: currentProjection.blueprintDigest,
			catalogDigest: currentProjection.catalogDigest,
			runtimeProfile: currentProjection.runtimeProfile,
		}),
		cut,
		successorAnchor,
		successorAnchorBytes,
		successorEpoch,
		successorTrust: opened.trust,
		successorTrustRecord,
	});
}

async function verifySnapshot(
	facts: Pick<SealedAdoptionFacts, "snapshotDeclaration" | "snapshotStore">,
	chain: Pick<VerifiedChain, "cut" | "successorTrust">,
	accounting?: import("./internal/creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting
): Promise<VerifiedSnapshot | undefined> {
	let scope: Awaited<ReturnType<SealedAdoptionFacts["snapshotStore"]["openScope"]>> | undefined;
	let port: ReturnType<NonNullable<typeof scope>["verificationQuarantine"]["open"]> | undefined;
	try {
		if (accounting !== undefined && (!accounting.charge(facts.snapshotDeclaration.exactCanonicalManifestBytes) ||
			!accounting.charge(encodeCanonical(facts.snapshotDeclaration)))) return undefined;
		const decoded = decodeSnapshotManifest({
			exactCanonicalManifestBytes: facts.snapshotDeclaration.exactCanonicalManifestBytes,
			expectedManifestDigest: facts.snapshotDeclaration.scope.manifestDigest,
			profile: PROFILE,
		});
		scope = await facts.snapshotStore.openScope(facts.snapshotDeclaration);
		port = scope.verificationQuarantine.open(new AbortController().signal);
		const chunks: Uint8Array[] = [];
		const readChunk = async (descriptor: Readonly<{ readonly index: number }>): Promise<Uint8Array | undefined> => {
			const selected = decoded.chunks[descriptor.index];
			if (selected === undefined) return undefined;
			const bytes = await port?.read(selected);
			if (
				bytes === undefined ||
				(accounting !== undefined && !accounting.charge(bytes)) ||
				bytes.byteLength !== selected.byteLength ||
				snapshotChunkDigest(selected.index, bytes) !== selected.digest
			) {
				return undefined;
			}
			chunks[selected.index] = Uint8Array.from(bytes);
			return bytes;
		};
		const status = await scope.status();
		if (accounting !== undefined && (!accounting.charge(encodeCanonical(status)) || status.kind !== "verified")) return undefined;
		if (status.kind === "verified") {
			for (const descriptor of decoded.chunks) {
				if ((await readChunk(descriptor)) === undefined) return undefined;
			}
		} else {
			const verified = verifySnapshotStreamWithReceipt({
				exactCanonicalManifestBytes: facts.snapshotDeclaration.exactCanonicalManifestBytes,
				expectedManifestDigest: facts.snapshotDeclaration.scope.manifestDigest,
				expectedScope: facts.snapshotDeclaration.scope,
				profile: PROFILE,
				quarantine: scope.verificationQuarantine,
				source: Object.freeze({ read: readChunk }),
			});
			await verified.completion;
			await scope.complete(await verified.receipt);
		}
		for (const descriptor of decoded.chunks) {
			if (chunks[descriptor.index] === undefined && (await readChunk(descriptor)) === undefined) return undefined;
		}
		if (chunks.length !== decoded.chunks.length || chunks.some((chunk) => chunk === undefined)) return undefined;
		const payloadBytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
		let offset = 0;
		for (const chunk of chunks) {
			payloadBytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const validated = validateCreatorSnapshotData(
			payloadBytes,
			facts.snapshotDeclaration.exactCanonicalManifestBytes,
			chain.cut,
			chain.successorTrust.profileId
		);
		if (accounting !== undefined && !accounting.charge(payloadBytes)) return undefined;
		if (facts.snapshotDeclaration.scope.manifestDigest !== chain.cut.snapshotManifestDigest || validated === undefined)
			return undefined;
		const { payload, manifest } = validated;
		return Object.freeze({ exactCanonicalPayloadBytes: payloadBytes, manifest, payload });
	} catch {
		return undefined;
	} finally {
		try {
			await port?.discard();
		} finally {
			await scope?.release();
		}
	}
}

async function selectedPromotionSnapshot(
	facts: Pick<SealedAdoptionFacts, "promotion">,
	chain: VerifiedChain,
	snapshot: VerifiedSnapshot
): Promise<VerifiedSnapshot | undefined> {
	if (facts.promotion === undefined) return snapshot;
	const promotion = facts.promotion;
	await promotion.source.checkSnapshots();
	const identity = resolveCreatorForwardPromotion(promotion.verified);
	const selected = promotion.source.historicalSnapshots.find((item) => item.closedEpoch === promotion.closedEpoch);
	const source = identity?.source;
	const manifest = selected === undefined ? undefined : canonicalRecord(selected.exactCanonicalManifestBytes);
	const payload = selected === undefined ? undefined : canonicalRecord(selected.exactCanonicalPayloadBytes);
	if (
		source === undefined || selected === undefined || manifest === undefined || payload === undefined ||
		manifest.payloadDigest !== source.payloadDigest || manifest.stateDigest !== source.stateDigest ||
		chain.successorAnchor.stateDigest !== source.stateDigest
	) return undefined;
	return Object.freeze({
		exactCanonicalPayloadBytes: Uint8Array.from(selected.exactCanonicalPayloadBytes),
		manifest, payload,
		authorizedAclBytes: encodeCanonical(snapshot.payload.acl),
		promotedSource: source,
	});
}

function projection(
	facts: Pick<SealedAdoptionFacts, "history" | "transition">,
	chain: VerifiedChain,
	snapshot: VerifiedSnapshot,
	resolved: NonNullable<ReturnType<typeof verifiedCatalog>>
): Readonly<{ readonly bytes: Uint8Array; readonly descriptor: Readonly<Record<string, unknown>> }> | undefined {
	try {
		const parameters = record(chain.cut.parameters) ? chain.cut.parameters : undefined;
		if (
			parameters === undefined ||
			chain.cut.previousHistoryRoot !== chain.currentAnchor.historyRoot ||
			chain.cut.previousHistorySize !== chain.currentAnchor.historySize ||
			chain.cut.historyRoot !== facts.history.historyRoot ||
			chain.cut.historySize !== facts.history.historySize
		) {
			return undefined;
		}
		const bytes = encodeCreatorSuccessorProjection({
			currentAnchor: chain.currentAnchor,
			successorAnchor: chain.successorAnchor,
			successorAnchorBytes: chain.successorAnchorBytes,
			successorAnchorDigest: facts.transition.successorAnchorDigest,
			parameters,
			history: facts.history,
			catalog: resolved,
			snapshotManifestDigest: chain.cut.snapshotManifestDigest as string,
			snapshotPayloadDigest: snapshot.manifest.payloadDigest,
			...(snapshot.promotedSource === undefined ? {} : { promotedSource: snapshot.promotedSource }),
		});
		const descriptor = canonicalRecord(bytes);
		return descriptor === undefined ? undefined : Object.freeze({ bytes, descriptor: Object.freeze(descriptor) });
	} catch {
		return undefined;
	}
}

function successorCommitMaterial(
	facts: SealedAdoptionFacts,
	closure: RecoveredClosure,
	exactCanonicalProjectionBytes: Uint8Array,
	predecessorKind: VerifiedChain["currentProjectionKind"]
):
	| Readonly<{
			readonly candidateReferences: readonly GenerationRef[];
			readonly generationId: GenerationId;
			readonly predecessorLiveRef: GenerationRef;
	  }>
	| undefined {
	try {
		const predecessors = closure.currentCandidates.filter(({ bytes, ref }) => {
			const decoded = canonicalRecord(bytes);
			return decoded?.kind === predecessorKind && facts.proposedReferences.some((candidate) => sameRef(candidate, ref));
		});
		if (predecessors.length !== 1) return undefined;
		const predecessorLiveRef = predecessors[0]?.ref;
		if (predecessorLiveRef === undefined) return undefined;
		const cut = closure.proposedCandidates.find(({ ref }) => sameRef(ref, facts.transition.cutValueRef));
		if (cut === undefined) return undefined;
		const referenceInput = {
			pendingReferences: facts.proposedReferences,
			predecessorLiveRef,
			exactCanonicalProjectionBytes,
			exactCanonicalCutValueBytes: cut.bytes,
			predecessorExactCanonicalLatchedAclBytes: facts.exactCanonicalLatchedAclBytes,
		};
		let candidateReferences = deriveCreatorAdoptionReferences(referenceInput);
		if (candidateReferences === undefined) return undefined;
		if (facts.receivedCandidateGenerationId !== undefined) {
			let digest = digestClosure(candidateReferences);
			if (!digest.ok || digest.value !== facts.receivedCandidateClosureDigest) {
				// Preserve an already occupied, supported readable birth certificate.
				// Fresh receives always use the canonical projection-owned form.
				candidateReferences = deriveLegacyCreatorAdoptionReferences(referenceInput);
				if (candidateReferences === undefined) return undefined;
				digest = digestClosure(candidateReferences);
			}
			return digest.ok && digest.value === facts.receivedCandidateClosureDigest
				? Object.freeze({ candidateReferences, generationId: facts.receivedCandidateGenerationId, predecessorLiveRef })
				: undefined;
		}
		const random = new Uint8Array(32);
		crypto.getRandomValues(random);
		const parsed = parseGenerationId(hex(random));
		return parsed.ok
			? Object.freeze({ candidateReferences, generationId: parsed.value, predecessorLiveRef })
			: undefined;
	} catch {
		return undefined;
	}
}

function creatorSuccessorLiveSeed(
	facts: SealedAdoptionFacts,
	closure: RecoveredClosure,
	chain: VerifiedChain,
	snapshot: VerifiedSnapshot,
	resolved: ResolvedBlueprintBytes,
	projected: Readonly<{ readonly bytes: Uint8Array; readonly descriptor: Readonly<Record<string, unknown>> }>,
	commitMaterial: NonNullable<ReturnType<typeof successorCommitMaterial>>
): CreatorSuccessorLiveSeed | undefined {
	try {
		const predecessorProjection = closure.currentCandidates.filter(
			({ bytes, ref }) =>
				canonicalRecord(bytes)?.kind === chain.currentProjectionKind && sameRef(ref, commitMaterial.predecessorLiveRef)
		);
		const exactCanonicalLatchedAclBytes = snapshot.authorizedAclBytes ?? encodeCanonical(snapshot.payload.acl);
		if (
			predecessorProjection.length !== 1 ||
			hex(hashDomain("ts-drp/latched-acl/v3", exactCanonicalLatchedAclBytes)) !== chain.successorAnchor.aclDigest ||
			typeof snapshot.manifest.payloadDigest !== "string" ||
			typeof snapshot.manifest.stateDigest !== "string" ||
			!(chain.currentTrustRecord.detachedCurrentAnchorSignature instanceof Uint8Array) ||
			!(chain.currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
			!(chain.successorTrustRecord.detachedCurrentAnchorSignature instanceof Uint8Array)
		) {
			return undefined;
		}
		const projectionDigest = digestBlob(projected.bytes);
		const predecessorAclDigest = digestBlob(facts.exactCanonicalLatchedAclBytes);
		if (!projectionDigest.ok || !predecessorAclDigest.ok) return undefined;
		const projectionRef = Object.freeze({ byteLength: projected.bytes.byteLength, digest: projectionDigest.value });
		const predecessorAclRef = Object.freeze({
			byteLength: facts.exactCanonicalLatchedAclBytes.byteLength,
			digest: predecessorAclDigest.value,
		});
		const successorCandidates = commitMaterial.candidateReferences.map((ref) => {
			if (sameRef(ref, projectionRef)) return Object.freeze({ bytes: Uint8Array.from(projected.bytes), ref });
			if (sameRef(ref, predecessorAclRef)) {
				return Object.freeze({ bytes: Uint8Array.from(facts.exactCanonicalLatchedAclBytes), ref });
			}
			const candidate = closure.proposedCandidates.find((entry) => sameRef(entry.ref, ref));
			if (candidate === undefined) throw new TypeError("creator successor candidate is unavailable");
			return Object.freeze({ bytes: Uint8Array.from(candidate.bytes), ref: Object.freeze({ ...ref }) });
		});
		return Object.freeze({
			catalog: factsForCatalog(resolved),
			...(facts.receiveOnly ? { receiveOnly: true as const } : {}),
			...(facts.origin === "received" && facts.promotion !== undefined
				? { promotionDependencies: facts.promotion.source }
				: {}),
			...(facts.certifiedRecoverySourceGenerations === undefined
				? {}
				: { certifiedRecoverySourceGenerations: facts.certifiedRecoverySourceGenerations }),
			...(facts.classifiedRecoverySourceGenerations === undefined
				? {}
				: { classifiedRecoverySourceGenerations: facts.classifiedRecoverySourceGenerations }),
			origin: facts.origin,
			exactCanonicalLatchedAclBytes: Uint8Array.from(exactCanonicalLatchedAclBytes),
			exactCanonicalParametersCarrierBytes: Uint8Array.from(facts.exactCanonicalParametersCarrierBytes),
			exactCanonicalPinnedGenesisBootstrapOperationBytes:
				facts.exactCanonicalPinnedGenesisBootstrapOperationBytes === undefined
					? undefined
					: Uint8Array.from(facts.exactCanonicalPinnedGenesisBootstrapOperationBytes),
			exactCanonicalSnapshotPayloadBytes: Uint8Array.from(snapshot.exactCanonicalPayloadBytes),
			issuanceScope: Object.freeze({ ...facts.issuanceScope }),
			issuanceStore: facts.issuanceStore,
			liveJournalStore: facts.liveJournalStore,
			snapshotStore: facts.snapshotStore,
			pinnedGenesisAnchorDigest: facts.currentTrust.genesisAnchorDigest,
			predecessor: Object.freeze({
				candidates: Object.freeze(closure.currentCandidates),
				detachedAnchorSignature: Uint8Array.from(chain.currentTrustRecord.detachedCurrentAnchorSignature),
				exactCanonicalAnchorPreimageBytes: Uint8Array.from(
					chain.currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes
				),
				exactCanonicalProjectionBytes: Uint8Array.from(predecessorProjection[0]?.bytes as Uint8Array),
				head: Object.freeze({ ...facts.currentHead }),
				references: Object.freeze(facts.currentReferences.map((ref) => Object.freeze({ ...ref }))),
				trust: facts.currentTrust,
				trustRef: Object.freeze({ ...facts.transition.currentTrustRef }),
			}),
			predecessorExactCanonicalLatchedAclBytes: Uint8Array.from(facts.exactCanonicalLatchedAclBytes),
			snapshotPayloadDigest: snapshot.manifest.payloadDigest,
			sourceRuntimeHandle: facts.sourceRuntimeHandle,
			stateDigest: snapshot.manifest.stateDigest,
			store: facts.store,
			successor: Object.freeze({
				candidates: Object.freeze(successorCandidates),
				detachedAnchorSignature: Uint8Array.from(chain.successorTrustRecord.detachedCurrentAnchorSignature),
				exactCanonicalAnchorPreimageBytes: Uint8Array.from(chain.successorAnchorBytes),
				exactCanonicalProjectionBytes: Uint8Array.from(projected.bytes),
				references: Object.freeze(commitMaterial.candidateReferences.map((ref) => Object.freeze({ ...ref }))),
				trust: chain.successorTrust,
				trustRef: Object.freeze({ ...facts.transition.successorTrustRef }),
			}),
			terminalizeSource: facts.terminalizeSource,
		});
	} catch {
		return undefined;
	}
}

function factsForCatalog(resolved: ResolvedBlueprintBytes): TrustedBlueprintCatalog {
	return Object.freeze({
		blueprintDigests: Object.freeze([resolved.blueprintDigest]),
		catalogDigest: resolved.evidence.catalogDigest,
		resolve: (blueprintDigest: string) => {
			if (blueprintDigest !== resolved.blueprintDigest) throw new TypeError("blueprint is not catalogued");
			return resolved;
		},
	}) as TrustedBlueprintCatalog;
}

/**
 * Verifies a sealed creator close and mints one owner-bound, one-use successor-adoption intent.
 * @param input - Genuine sealed close handle and trusted blueprint catalog.
 * @returns Frozen failure or verified descriptor with an opaque adoption intent.
 */
export async function verifyCreatorSuccessorAdoption(input: unknown): Promise<AdoptionFailure | AdoptionSuccess> {
	const captured = captureInput(input);
	if (captured === undefined) {
		return failure("malformed-input", "creator adoption input is invalid");
	}
	const facts = factsFor(captured.handle);
	if (facts === undefined) return failure("sealed-live-unavailable", "sealed creator live evidence is unavailable");
	try {
		const closure = await recoverClosure(facts);
		if (closure === undefined) return failure("recovery-failed", "creator close generation recovery failed");
		const chain = verifyChain(facts, closure);
		if (chain === undefined) return failure("chain-invalid", "creator successor trust chain is invalid");
		if (!(await facts.durableReplay.verify())) {
			return failure("journal-invalid", "creator close durable replay is invalid");
		}
		let snapshot = await verifySnapshot(facts, chain, facts.proofAccounting);
		if (snapshot === undefined) return failure("snapshot-invalid", "creator close snapshot is invalid");
		const authorizedAclBytes = encodeCanonical(snapshot.payload.acl);
		snapshot = await selectedPromotionSnapshot(facts, chain, snapshot);
		if (snapshot === undefined) return failure("snapshot-invalid", "creator promoted snapshot is invalid");
		if (
			settlementProfileFor(chain.successorTrust.profileId) === "v1" &&
			!inspectCreatorTransitionAdvance({
				current: { candidates: closure.currentCandidates, closure: facts.currentReferences },
				currentTrust: facts.currentTrust,
				mode: "verify",
				proofRefs: [facts.transition.cutValueRef, facts.transition.commitQcRef],
				proposed: { candidates: closure.proposedCandidates, closure: facts.proposedReferences },
				successorTrust: chain.successorTrust,
				settlementAcl: {
					current: facts.exactCanonicalLatchedAclBytes,
					successor: authorizedAclBytes,
				},
			}).ok
		)
			return failure("chain-invalid", "creator settlement ACL advance is invalid");
		const resolved = verifiedCatalog(captured.catalog, snapshot.payload.blueprintDigest, chain.currentCatalog);
		if (resolved === undefined) return failure("blueprint-invalid", "creator successor blueprint is invalid");
		const projected = projection(facts, chain, snapshot, resolved);
		if (projected === undefined) return failure("internal-invariant", "creator successor projection failed");
		const commitMaterial = successorCommitMaterial(facts, closure, projected.bytes, chain.currentProjectionKind);
		if (commitMaterial === undefined) {
			return failure("internal-invariant", "creator successor commit material failed");
		}
		const activation = creatorSuccessorLiveSeed(facts, closure, chain, snapshot, resolved, projected, commitMaterial);
		if (activation === undefined) return failure("internal-invariant", "creator successor activation material failed");
		if (facts.proofAccounting !== undefined && (!facts.proofAccounting.charge(projected.bytes) ||
			!facts.proofAccounting.charge(encodeCanonical(commitMaterial.candidateReferences)) ||
			!facts.proofAccounting.charge(encodeCanonical(commitMaterial.predecessorLiveRef))))
			return failure("internal-invariant", "creator successor full recovery projection charge is exhausted");
		return Object.freeze({
			descriptor: projected.descriptor,
			intent: createCreatorAdoptionIntent(captured.handle, {
				activation,
				candidateReferences: commitMaterial.candidateReferences,
				exactCanonicalProjectionBytes: projected.bytes,
				generationId: commitMaterial.generationId,
				pendingHead: facts.proposedHead,
				pendingReferences: facts.proposedReferences,
				predecessorLiveRef: commitMaterial.predecessorLiveRef,
			}),
			ok: true as const,
		});
	} catch {
		return failure("internal-invariant", "creator adoption verification failed unexpectedly");
	}
}

function coldReopenFailure(kind: string, detail: string): CreatorSuccessorReopenResult {
	return Object.freeze({ detail, kind, ok: false as const });
}

function uniqueCandidateByKind(
	candidates: readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[],
	kind: string
):
	| Readonly<{
			readonly bytes: Uint8Array;
			readonly record: Readonly<Record<string, unknown>>;
			readonly ref: GenerationRef;
	  }>
	| undefined {
	const matches = candidates.flatMap((candidate) => {
		const decoded = canonicalRecord(candidate.bytes);
		return decoded?.kind === kind ? [Object.freeze({ ...candidate, record: decoded })] : [];
	});
	return matches.length === 1 ? matches[0] : undefined;
}

function presentBase(generation: GenerationRecord): PresentHead | undefined {
	return generation.baseExpectedHead.kind === "present" ? Object.freeze({ ...generation.baseExpectedHead }) : undefined;
}

type AuthenticatedSuccessorIssuanceScopeResult =
	| Readonly<{ readonly ok: true; readonly scope: DurableIssueScope }>
	| Readonly<{ readonly ok: false; readonly reason: "authority" | "lineage" | "possession" }>;

const ownedPossessionRequests = new WeakMap<OwnedSigningRequest, OwnedIdentityChallengeAdmission>();
/** Consumer only; no public constructor, installer or caller custody receipt. */
export function consumeOwnedCreatorPossessionSigningRequest(request: unknown): OwnedIdentityChallengeAdmission | undefined {
	if (request === null || typeof request !== "object") return undefined;
	const captured = ownedPossessionRequests.get(request as OwnedSigningRequest);
	ownedPossessionRequests.delete(request as OwnedSigningRequest);
	return captured;
}

async function authenticatedSuccessorIssuanceScope(
	input: CreatorSuccessorReopenInput,
	objectId: StorageObjectId,
	expectedAclDigest: string,
	expectedEpoch: number,
	exactCanonicalLatchedAclBytes: Uint8Array,
	expectedProfileId: string,
	checkNativeCurrency: () => Promise<void>
): Promise<AuthenticatedSuccessorIssuanceScopeResult> {
	let lineageAuthors: readonly string[];
	try {
		const opened = openCanonicalLatchedAclSnapshot({
			exactCanonicalLatchedAclBytes,
			expectedAclDigest,
			expectedEpoch,
			expectedObjectId: objectId,
			expectedProfileId,
		});
		if (!opened.ok) return Object.freeze({ ok: false as const, reason: "authority" as const });
		const writers = opened.snapshot.members.flatMap(({ author, groups }) =>
			opened.snapshot.permissionless || groups.includes("writer") ? [author] : []
		);
		// Enrolled settlement members may recover their exact native old-source
		// custody. This is not current application or portable replacement authority.
		const localCustodian = settlementProfileFor(expectedProfileId) === "v1" &&
			opened.snapshot.members.some(({author}) => author === input.author);
		if (
			(writers.length === 0 && !localCustodian) ||
			new Set(writers).size !== writers.length ||
			!ED25519_PUBLIC_KEY_HEX.test(input.author) ||
			(!input.receiveOnly && !writers.includes(input.author) && !localCustodian)
		) {
			return Object.freeze({ ok: false as const, reason: "authority" as const });
		}
		lineageAuthors = localCustodian && !writers.includes(input.author) ? [...writers,input.author] : writers;
	} catch {
		return Object.freeze({ ok: false as const, reason: "authority" as const });
	}
	try {
		const webCrypto = globalThis.crypto;
		if (
			webCrypto === undefined ||
			typeof webCrypto.getRandomValues !== "function" ||
			webCrypto.subtle === undefined ||
			typeof webCrypto.subtle.importKey !== "function" ||
			typeof webCrypto.subtle.verify !== "function"
		) {
			return Object.freeze({ ok: false as const, reason: "possession" as const });
		}
		const challenge = new Uint8Array(32);
		webCrypto.getRandomValues(challenge);
		// Locally authored possession, distinct from any operation/finality digest.
		// Bind the exact authenticated successor scope, ACL and original nonce.
		const bytes = encodeCanonical({ kind: "creator-issuance-possession", version: 1, nonce: challenge,
			author: input.author, objectId, epoch: expectedEpoch, aclDigest: expectedAclDigest, profileId: expectedProfileId,
			pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest, currentAnchorDigest: input.expectedRoomHead.currentAnchorDigest });
		const retainedChallenge = hashDomain("ts-drp/creator-issuance-possession/v1", bytes);
		const signerChallenge = Uint8Array.from(retainedChallenge);
		const request = Object.freeze({}) as OwnedSigningRequest;
		let active = true;
		const check = async (): Promise<void> => {
			if (!active) throw new TypeError("creator possession original owner is released");
			await checkNativeCurrency();
			if (!active) throw new TypeError("creator possession original owner is released");
		};
		ownedPossessionRequests.set(request, Object.freeze({ kind: "possession", bytes,
			publicKey: Uint8Array.from(input.author.match(/.{2}/gu) ?? [], byte => Number.parseInt(byte, 16)),
			checkWhile: async <T>(action: () => Promise<T>): Promise<T> => { await check(); const value = await action(); await check(); return value; } }));
		let signature: Uint8Array;
		try {
			await check();
			signature = await input.signRegisteredVertexDigest(signerChallenge, request);
			await check();
		} finally { active = false; ownedPossessionRequests.delete(request); }
		if (
			!sameBytes(signerChallenge, retainedChallenge) ||
			!(signature instanceof Uint8Array) ||
			Object.getPrototypeOf(signature) !== Uint8Array.prototype ||
			signature.byteOffset !== 0 ||
			signature.byteLength !== 64 ||
			signature.buffer.byteLength !== 64
		) {
			return Object.freeze({ ok: false as const, reason: "possession" as const });
		}
		const authorBytes = Uint8Array.from(input.author.match(/.{2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
		const publicKey = await webCrypto.subtle.importKey("raw", authorBytes, { name: "Ed25519" }, false, ["verify"]);
		if (!(await webCrypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, retainedChallenge))) {
			return Object.freeze({ ok: false as const, reason: "possession" as const });
		}
	} catch {
		return Object.freeze({ ok: false as const, reason: "possession" as const });
	}
	try {
		if (input.receiveOnly) {
			const scope = Object.freeze({ author: input.author, objectId });
			await assertEmptyReceiveOnlyIssuance(input.issuanceStore, scope);
			return Object.freeze({ ok: true as const, scope });
		}
		for (const author of lineageAuthors) {
			const scope = Object.freeze({ author, objectId });
			const lineage = await input.issuanceStore.readLineage(scope);
			if (lineage.exhausted !== false || !Number.isSafeInteger(lineage.next) || lineage.next < 0) {
				return Object.freeze({ ok: false as const, reason: "lineage" as const });
			}
			// Other authenticated writers can already have issued in this same object.
			// Their watermarks are not the selected author's issuance authority: the
			// scope below remains bound to that author's current ACL and possession.
		}
		return Object.freeze({ ok: true as const, scope: Object.freeze({ author: input.author, objectId }) });
	} catch {
		return Object.freeze({ ok: false as const, reason: "lineage" as const });
	}
}

async function reopenCreatorSuccessorMaterial(
	input: CreatorSuccessorReopenInput
): Promise<CreatorSuccessorReopenResult> {
	let installedPromotion: Awaited<ReturnType<typeof acquireCreatorInstalledPromotion>> | undefined;
	const coldFailure = coldReopenFailure;
	const reopen = async (): Promise<CreatorSuccessorReopenResult> => {
		let reader: AheBoundedRecoveryRoleRead | undefined;
		let primary: unknown;
		let failed = false;
		try {
			const rawBootstrapOperationBytes = input.exactCanonicalPinnedGenesisBootstrapOperationBytes;
			const exactCanonicalPinnedGenesisBootstrapOperationBytes =
				rawBootstrapOperationBytes === undefined
					? undefined
					: rawBootstrapOperationBytes instanceof Uint8Array &&
						  Object.getPrototypeOf(rawBootstrapOperationBytes) === Uint8Array.prototype
						? Uint8Array.from(rawBootstrapOperationBytes)
						: undefined;
			if (
				rawBootstrapOperationBytes !== undefined &&
				exactCanonicalPinnedGenesisBootstrapOperationBytes === undefined
			) {
				return coldFailure("malformed-input", "creator successor bootstrap policy input is invalid");
			}
			const parsedObjectId = parseStorageObjectId(input.expectedRoomHead.objectId);
			if (!parsedObjectId.ok) return coldFailure("chain-invalid", "creator successor object identity is invalid");
			const objectId = parsedObjectId.value;
			reader = await acquireCreatorRecoveryCensus(input.store, objectId);
			const nativeHead = reader.head;
			const nativeGeneration =
				nativeHead.kind !== "present"
					? undefined
					: reader.generations.find(({ generationId }) => generationId === nativeHead.generationId);
			if (nativeHead.kind !== "present" || nativeGeneration?.state !== "Adopted") {
				return coldFailure("storage-failed", "creator successor durable generation is unavailable");
			}
			const active = Object.freeze({
				head: nativeHead,
				adoptedGeneration: nativeGeneration,
				references: nativeGeneration.closure,
			});
			const lineage = reader.generations;
			const capturedReader = reader;
			const readClosure = (
				references: readonly GenerationRef[]
			): Promise<RecoveredClosure["currentCandidates"] | undefined> =>
				Promise.resolve(recoveryCensusClosure(capturedReader, references));
			const base = presentBase(active.adoptedGeneration);
			const baseGeneration = lineage?.find((generation) => generation.generationId === base?.generationId);
			const baseCandidates = baseGeneration === undefined ? undefined : await readClosure(baseGeneration.closure);
			const direct =
				baseCandidates !== undefined &&
				uniqueCandidateByKind(baseCandidates, "drp-anchor-trust-state")?.record.currentEpoch ===
					input.expectedRoomHead.epoch - 1;
			const structure =
				lineage === undefined
					? undefined
					: inspectCreatorAdoptionCandidateLineage({
							objectId,
							lineage,
							candidate: active.adoptedGeneration,
							direct,
						});
			if (
				structure === undefined ||
				!sameHead(active.head, structure.candidateHead) ||
				!sameClosure(active.references, active.adoptedGeneration.closure)
			) {
				return coldFailure("chain-invalid", "creator successor generation lineage is invalid");
			}
			const { currentHead, currentGeneration, proposedGeneration } = structure;
			const [currentCandidates, nativeProposedCandidates, activeCandidates] = await Promise.all([
				readClosure(currentGeneration.closure),
				readClosure(proposedGeneration.closure),
				readClosure(active.references),
			]);
			if (currentCandidates === undefined || nativeProposedCandidates === undefined || activeCandidates === undefined) {
				return coldFailure("storage-failed", "creator successor closure is unavailable");
			}
			const proposedCandidates = direct
				? receivedTransitionClosure(currentCandidates, activeCandidates, input.expectedRoomHead.epoch - 1)
				: nativeProposedCandidates;
			if (proposedCandidates === undefined)
				return coldFailure("chain-invalid", "creator received projection replacement is invalid");
			const proposedReferences = direct ? proposedCandidates.map(({ ref }) => ref) : proposedGeneration.closure;
			const currentTrustCandidate = uniqueCandidateByKind(currentCandidates, "drp-anchor-trust-state");
			const successorTrustCandidate = uniqueCandidateByKind(proposedCandidates, "drp-anchor-trust-state");
			const cutCandidate = uniqueCandidateByKind(proposedCandidates, "drp-hard-epoch-cut");
			if (currentTrustCandidate === undefined || successorTrustCandidate === undefined || cutCandidate === undefined) {
				return coldFailure("chain-invalid", "creator successor authenticated closure is incomplete");
			}
			const currentTrustRecord = currentTrustCandidate.record;
			const successorTrustRecord = successorTrustCandidate.record;
			if (
				!(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
				!(currentTrustRecord.detachedCurrentAnchorSignature instanceof Uint8Array) ||
				!(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
				!(successorTrustRecord.detachedCurrentAnchorSignature instanceof Uint8Array) ||
				typeof currentTrustRecord.currentEpoch !== "number" ||
				typeof successorTrustRecord.currentEpoch !== "number"
			) {
				return coldFailure("chain-invalid", "creator durable trust carriers are invalid");
			}
			const currentEpoch = currentTrustRecord.currentEpoch;
			const successorEpoch = successorTrustRecord.currentEpoch;
			const currentProjection = uniqueCandidateByKind(currentCandidates, currentProjectionKind(currentEpoch));
			const successorProjection = uniqueCandidateByKind(activeCandidates, "v3-live-generation-2");
			if (
				currentProjection === undefined ||
				successorProjection === undefined ||
				!Number.isSafeInteger(currentEpoch) ||
				currentEpoch < 0 ||
				successorEpoch !== currentEpoch + 1
			) {
				return coldFailure("chain-invalid", "creator successor epoch projection is invalid");
			}
			const qcs = proposedCandidates.flatMap((candidate) => {
				const decoded = canonicalRecord(candidate.bytes);
				return decoded?.kind === "drp-seal-qc" && decoded.phase === "commit" && decoded.epoch === currentEpoch
					? [candidate]
					: [];
			});
			if (qcs.length !== 1) return coldFailure("chain-invalid", "creator successor QC is invalid");
			const selectedQc = qcs[0] as (typeof qcs)[number];
			let predecessorTrust: CurrentAnchorTrust;
			let successorTrust: CurrentAnchorTrust;
			if (currentEpoch === 0) {
				if (
					!sameBytes(
						input.exactCanonicalAnchorPreimageBytes,
						currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes
					) ||
					!sameBytes(input.detachedSignature, currentTrustRecord.detachedCurrentAnchorSignature)
				) {
					return coldFailure("chain-invalid", "creator genesis carriers do not match durable trust");
				}
				const openedCurrent = openCurrentAnchorTrust({
					exactCanonicalTrustStateRecordBytes: currentTrustCandidate.bytes,
					expectedObjectId: objectId,
					pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
				});
				if (!openedCurrent.ok) return coldFailure("chain-invalid", "creator genesis trust is invalid");
				const openedSuccessor = openCreatorSuccessorTrust({
					currentTrust: openedCurrent.trust,
					exactCanonicalCommitQcBytes: selectedQc.bytes,
					exactCanonicalCutValueBytes: cutCandidate.bytes,
					exactCanonicalTrustStateRecordBytes: successorTrustCandidate.bytes,
				});
				if (!openedSuccessor.ok) return coldFailure("chain-invalid", "creator successor QC is invalid");
				predecessorTrust = openedCurrent.trust;
				successorTrust = openedSuccessor.trust;
			} else {
				const openedCheckpoint = (
					Object.hasOwn(cutCandidate.record, "forwardPromotion")
						? openCreatorForwardPromotionCheckpointTrust
						: openCreatorCheckpointTrust
				)({
					detachedGenesisSignature: input.detachedSignature,
					exactCanonicalCommitQcBytes: selectedQc.bytes,
					exactCanonicalCurrentTrustStateRecordBytes: successorTrustCandidate.bytes,
					exactCanonicalCutValueBytes: cutCandidate.bytes,
					exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
					exactCanonicalPredecessorTrustStateRecordBytes: currentTrustCandidate.bytes,
					expectedCurrentHead: input.expectedRoomHead,
					expectedObjectId: objectId,
					pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
				});
				if (!openedCheckpoint.ok) return coldFailure("chain-invalid", "creator checkpoint trust is invalid");
				predecessorTrust = openedCheckpoint.predecessorTrust;
				successorTrust = openedCheckpoint.currentTrust;
			}
			if (
				!inspectCreatorTransitionAdvance({
					current: { candidates: currentCandidates, closure: currentGeneration.closure },
					currentTrust: predecessorTrust,
					mode: "verify",
					proofRefs: [cutCandidate.ref, selectedQc.ref],
					proposed: { candidates: proposedCandidates, closure: proposedReferences },
					successorTrust,
				}).ok
			) {
				return coldFailure("chain-invalid", "creator successor trust advance is invalid");
			}
			const currentAnchor = canonicalRecord(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
			const successorAnchorBytes = Uint8Array.from(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
			const successorAnchor = canonicalRecord(successorAnchorBytes);
			if (
				currentAnchor === undefined ||
				successorAnchor === undefined ||
				currentProjection.record.epoch !== currentEpoch ||
				currentProjection.record.objectId !== objectId ||
				currentProjection.record.blueprintDigest !== currentAnchor.blueprintDigest ||
				currentProjection.record.blueprintDigest !== successorAnchor.blueprintDigest
			) {
				return coldFailure("chain-invalid", "creator anchor carriers are invalid");
			}
			const chain: VerifiedChain = Object.freeze({
				currentAnchor,
				currentEpoch,
				currentCatalog: Object.freeze({
					artifactDigest: String(currentProjection.record.artifactDigest),
					artifactId: String(currentProjection.record.artifactId),
					blueprintDigest: String(currentProjection.record.blueprintDigest),
					catalogDigest: String(currentProjection.record.catalogDigest),
					runtimeProfile: String(currentProjection.record.runtimeProfile),
				}),
				currentProjectionKind: currentProjectionKind(currentEpoch),
				currentTrustRecord,
				cut: cutCandidate.record,
				successorAnchor,
				successorAnchorBytes,
				successorEpoch,
				successorTrust,
				successorTrustRecord,
			});
			if (!sameCreatorRoomHead(input.expectedRoomHead, successorTrust)) {
				return coldFailure("D110C_FLOOR_MISMATCH", "creator successor differs from the authenticated room-head floor");
			}
			let snapshotDeclaration: SnapshotQuarantineDeclaration;
			try {
				const observation = await input.snapshotStore.lookupRecoveryDeclaration({
					objectId: String(chain.cut.objectId),
					epoch: Number(chain.cut.epoch),
					anchor: String(chain.cut.previousAnchor),
					manifestDigest: String(chain.cut.snapshotManifestDigest),
				});
				if (observation.kind !== "present" || observation.state === "poisoned") {
					return coldFailure("snapshot-unavailable", "creator successor snapshot is unavailable");
				}
				snapshotDeclaration = observation.declaration;
			} catch {
				return coldFailure("snapshot-unavailable", "creator successor snapshot is unavailable");
			}
			let snapshot = await verifySnapshot({ snapshotDeclaration, snapshotStore: input.snapshotStore }, chain);
			if (snapshot === undefined)
				return coldFailure("snapshot-unavailable", "creator successor snapshot is unavailable");
			const authorizedAclBytes = encodeCanonical(snapshot.payload.acl);
			if (Object.hasOwn(chain.cut, "forwardPromotion")) {
				const promotionInput = {
					store: input.store,
					snapshotStore: input.snapshotStore,
					catalog: input.catalog,
					expectedHead: active.head,
					currentTrust: predecessorTrust,
					successorTrust,
					currentGenerationId: currentGeneration.generationId,
					proposedGenerationId: proposedGeneration.generationId,
					exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
					detachedGenesisSignature: input.detachedSignature,
				};
				installedPromotion = direct
					? await acquireCreatorReceivedPromotion({ ...promotionInput, receivedProposal: {
						closure: { candidates: proposedCandidates, closure: proposedReferences },
						currentCloseSnapshot: { exactCanonicalManifestBytes: snapshotDeclaration.exactCanonicalManifestBytes,
							exactCanonicalPayloadBytes: snapshot.exactCanonicalPayloadBytes },
					} })
					: await acquireCreatorInstalledPromotion(promotionInput);
				if (!sameBytes(installedPromotion.authorizedAclBytes, authorizedAclBytes))
					return coldFailure("chain-invalid", "creator promotion current ACL differs from truthful close");
				const manifest = canonicalRecord(installedPromotion.exactCanonicalManifestBytes),
					payload = canonicalRecord(installedPromotion.exactCanonicalPayloadBytes);
				if (manifest === undefined || payload === undefined)
					return coldFailure("snapshot-unavailable", "creator promoted source snapshot is unavailable");
				snapshot = Object.freeze({
					manifest,
					payload,
					exactCanonicalPayloadBytes: installedPromotion.exactCanonicalPayloadBytes,
					authorizedAclBytes,
					promotedSource: installedPromotion.source,
				});
			}
			const resolved = verifiedCatalog(input.catalog, snapshot.payload.blueprintDigest, chain.currentCatalog);
			const manifestDigest = snapshotDeclaration.scope.manifestDigest;
			if (
				resolved === undefined ||
				!(snapshot.promotedSource === undefined
					? creatorSnapshotProjectionMatches(
							successorProjection.record,
							successorAnchor,
							successorTrust.currentAnchorDigest,
							manifestDigest,
							snapshot.manifest
						)
					: creatorPromotedSnapshotProjectionMatches(
							successorProjection.record,
							successorAnchor,
							successorTrust.currentAnchorDigest,
							snapshot.promotedSource,
							snapshot.manifest
						)) ||
				hex(hashDomain("ts-drp/parameters/v3", input.exactCanonicalParametersCarrierBytes)) !==
					successorAnchor.parametersDigest
			) {
				return coldFailure("chain-invalid", "creator successor projection is invalid");
			}
			const exactCanonicalLatchedAclBytes = authorizedAclBytes;
			const predecessorAclCandidates = activeCandidates.filter(
				(candidate) => hex(hashDomain("ts-drp/latched-acl/v3", candidate.bytes)) === currentAnchor.aclDigest
			);
			const predecessorExactCanonicalLatchedAclBytes = predecessorAclCandidates[0]?.bytes;
			const openedPredecessorAcl =
				predecessorAclCandidates.length === 1 && predecessorExactCanonicalLatchedAclBytes !== undefined
					? openCanonicalLatchedAclSnapshot({
							exactCanonicalLatchedAclBytes: predecessorExactCanonicalLatchedAclBytes,
							expectedAclDigest: String(currentAnchor.aclDigest),
							expectedEpoch: currentEpoch,
							expectedObjectId: objectId,
							expectedProfileId: predecessorTrust.profileId,
						})
					: undefined;
			if (
				predecessorExactCanonicalLatchedAclBytes === undefined ||
				openedPredecessorAcl === undefined ||
				!openedPredecessorAcl.ok
			) {
				return coldFailure("chain-invalid", "creator predecessor ACL cannot be reconstructed");
			}
			if (
				settlementProfileFor(successorTrust.profileId) === "v1" &&
				!inspectCreatorTransitionAdvance({
					current: { candidates: currentCandidates, closure: currentGeneration.closure },
					currentTrust: predecessorTrust,
					mode: "verify",
					proofRefs: [cutCandidate.ref, selectedQc.ref],
					proposed: { candidates: proposedCandidates, closure: proposedReferences },
					successorTrust,
					settlementAcl: {
						current: predecessorExactCanonicalLatchedAclBytes,
						successor: exactCanonicalLatchedAclBytes,
					},
				}).ok
			)
				return coldFailure("chain-invalid", "creator settlement ACL advance is invalid");
			const previousRoomHead = roomHeadFromTrust(predecessorTrust);
			const custody = await readReceivedCustody(input, previousRoomHead);
			await authenticateReceivedCandidateCustody(
				{ ...input, expectedPreviousRoomHead: previousRoomHead, expectedNextRoomHead: input.expectedRoomHead },
				custody,
				Object.freeze({
					currentGeneration,
					currentHead,
					currentCandidates,
					proposedCandidates,
					candidate: active.adoptedGeneration,
					candidateHead: active.head,
					chain,
					predecessorTrust,
					predecessorAclBytes: predecessorExactCanonicalLatchedAclBytes,
					snapshot,
				}),
				active.head
			);
			const possessionReader = reader; // Exact original held census, not a mutable later selector.
			const issuance = await authenticatedSuccessorIssuanceScope(
				input,
				objectId,
				String(successorAnchor.aclDigest),
				successorEpoch,
				exactCanonicalLatchedAclBytes,
				successorTrust.profileId,
				async () => {
					if (!(await possessionReader.checkCurrency()).ok) throw new TypeError("creator possession native recovery census changed");
				}
			);
			if (!issuance.ok) {
				const detail =
					issuance.reason === "authority"
						? "creator issuance ACL authority is invalid"
						: issuance.reason === "possession"
							? "creator issuance possession proof failed"
							: "creator issuance lineage is invalid";
				return coldFailure("chain-invalid", detail);
			}
			const issuanceScope = issuance.scope;
			// The authenticated current generation carries the previous Cut (epoch one
			// and later); the request then applies the same predecessor absence evidence
			// as the full reconstruction it asks for.
			const previousCut = currentEpoch === 0 ? undefined : uniqueCandidateByKind(currentCandidates, "drp-hard-epoch-cut");
			const previousCertificate =
				previousCut === undefined || previousCut.record.epoch !== currentEpoch - 1
					? undefined
					: Object.freeze({ exactCanonicalCutValueBytes: previousCut.bytes, trust: predecessorTrust });
			const retirementReconstruction = await acquireCreatorSnapshotRetirementReconstructionRequest({
				snapshotStore: input.snapshotStore,
				currentTrust: successorTrust,
				head: active.head,
				exactCanonicalCutValueBytes: cutCandidate.bytes,
				accounting: createCreatorClosedRollbackProofAccounting(reader.blobs),
				...(previousCertificate === undefined ? {} : { previousCertificate }),
			});
			const material: CreatorSuccessorLiveMaterial = Object.freeze({
				...(input.receiveOnly ? { receiveOnly: true as const } : {}),
				...(retirementReconstruction === undefined ? {} : { retirementReconstruction }),
				catalog: factsForCatalog(resolved),
				...(installedPromotion === undefined ? {} : {
					certifiedRecoverySourceGenerations: installedPromotion.supportGenerations,
					classifiedRecoverySourceGenerations: Object.freeze([]),
					promotionDependencies: installedPromotion,
				}),
				origin: "durable-reopen",
				exactCanonicalLatchedAclBytes,
				exactCanonicalParametersCarrierBytes: Uint8Array.from(input.exactCanonicalParametersCarrierBytes),
				exactCanonicalPinnedGenesisBootstrapOperationBytes,
				exactCanonicalSnapshotPayloadBytes: Uint8Array.from(snapshot.exactCanonicalPayloadBytes),
				issuanceScope,
				issuanceStore: input.issuanceStore,
				liveJournalStore: input.liveJournalStore,
				snapshotStore: input.snapshotStore,
				pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
				predecessor: Object.freeze({
					candidates: currentCandidates,
					detachedAnchorSignature: Uint8Array.from(currentTrustRecord.detachedCurrentAnchorSignature),
					exactCanonicalAnchorPreimageBytes: Uint8Array.from(
						currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes
					),
					exactCanonicalProjectionBytes: Uint8Array.from(currentProjection.bytes),
					head: currentHead,
					references: Object.freeze(currentGeneration.closure.map((ref) => Object.freeze({ ...ref }))),
					trust: predecessorTrust,
					trustRef: Object.freeze({ ...currentTrustCandidate.ref }),
				}),
				predecessorExactCanonicalLatchedAclBytes,
				snapshotPayloadDigest: String(snapshot.manifest.payloadDigest),
				stateDigest: String(snapshot.manifest.stateDigest),
				store: input.store,
				successor: Object.freeze({
					candidates: activeCandidates,
					detachedAnchorSignature: Uint8Array.from(successorTrustRecord.detachedCurrentAnchorSignature),
					exactCanonicalAnchorPreimageBytes: successorAnchorBytes,
					exactCanonicalProjectionBytes: Uint8Array.from(successorProjection.bytes),
					head: Object.freeze({ ...active.head }),
					references: Object.freeze(active.references.map((ref) => Object.freeze({ ...ref }))),
					trust: successorTrust,
					trustRef: Object.freeze({ ...successorTrustCandidate.ref }),
				}),
				terminalizeSource: (): Promise<boolean> => Promise.resolve(true),
			});
			await installedPromotion?.check();
			if (!(await reader.checkCurrency()).ok)
				return coldFailure("storage-failed", "creator successor native recovery census changed");
			return Object.freeze({ material, ok: true as const });
		} catch (error) {
			primary = error;
			failed = true;
			return Object.freeze({
				...coldFailure("internal-invariant", "creator successor reopen failed unexpectedly"),
				cause: error,
			});
		} finally {
			await releaseCreatorRecoveryReader(reader, failed, primary, "creator successor recovery reader cleanup failed");
		}
	};
	let result: CreatorSuccessorReopenResult;
	try { result = await reopen(); }
	catch (primary) {
		try { await installedPromotion?.release(); }
		catch (cleanup) { throw new AggregateError([primary, cleanup], "creator promotion reopen cleanup failed", { cause: primary }); }
		throw primary;
	}
	if (!result.ok) {
		try { await installedPromotion?.release(); }
		catch { return coldFailure("snapshot-unavailable", "creator promotion dependency release failed"); }
	}
	return result;
}

interface AuthenticatedPendingCandidate {
	readonly promotionDependencies?: CreatorSuccessorLiveMaterial["promotionDependencies"];
	readonly closureDigest: string;
	readonly generation: GenerationRecord;
	readonly head: PresentHead;
	readonly receivedContext: ReceivedCandidateContext;
}

interface ReceivedCandidateContext {
	readonly currentGeneration: GenerationRecord;
	readonly currentHead: PresentHead;
	readonly currentCandidates: RecoveredClosure["currentCandidates"];
	readonly proposedCandidates: RecoveredClosure["proposedCandidates"];
	readonly candidate: GenerationRecord;
	readonly candidateHead: PresentHead;
	readonly chain: VerifiedChain;
	readonly predecessorTrust: CurrentAnchorTrust;
	readonly predecessorAclBytes: Uint8Array;
	readonly snapshot: VerifiedSnapshot;
}

type ReceivedCustody = Readonly<{
	retained: NonNullable<
		Awaited<ReturnType<SnapshotRecoveryStore<SnapshotVerificationReceipt>["lookupReceivedRecoveryCertificate"]>>
	>;
	certificate: ReceivedCertificate;
}>;

async function readReceivedCustody(
	input: Pick<CreatorAdoptionPendingRecoveryInput, "snapshotStore" | "pinnedGenesisAnchorDigest" | "proofAccounting">,
	previous: CreatorAdoptionRoomHead
): Promise<ReceivedCustody | null> {
	const retained = await input.snapshotStore.lookupReceivedRecoveryCertificate({
		objectId: previous.objectId,
		epoch: previous.epoch,
		anchor: previous.currentAnchorDigest,
	});
	if (input.proofAccounting !== undefined && !input.proofAccounting.charge(encodeCanonical(retained)))
		throw new TypeError("creator received recovery custody proof capacity refused");
	if (retained === null) return null;
	const certificate = openReceivedCertificate(retained.exactReceivedCertificateBytes);
	const cut = canonicalRecord(certificate.exactCanonicalCutValueBytes);
	if (
		certificate.pinnedGenesisAnchorDigest !== input.pinnedGenesisAnchorDigest ||
		cut === undefined ||
		cut.objectId !== previous.objectId ||
		cut.epoch !== previous.epoch ||
		cut.previousAnchor !== previous.currentAnchorDigest ||
		cut.snapshotManifestDigest !== retained.scope.manifestDigest
	)
		throw new TypeError("creator received occupied custody scope differs");
	return Object.freeze({ retained, certificate });
}

/**
 * A Complete/Adopted row is not permission to ignore an occupied birth certificate.
 * Reuses its existing authenticated snapshot/chain context and the pure native
 * replay owner; no second payload read, historical activation or floor grant.
 * @param input - Existing native authentication and replay owners.
 * @param custody - Strict exact-scope native certificate readback, or ordinary NULL custody.
 * @param context - The candidate's already authenticated chain and snapshot material.
 * @param nativeHead - The actual authenticated census head, including after publication.
 */
async function authenticateReceivedCandidateCustody(
	input: CreatorAdoptionPendingRecoveryInput,
	custody: ReceivedCustody | null,
	context: ReceivedCandidateContext,
	nativeHead: PresentHead
): Promise<void> {
	if (custody === null) return;
	const { certificate, retained } = custody;
	const {
		currentGeneration,
		currentHead,
		currentCandidates,
		proposedCandidates,
		candidate,
		candidateHead,
		chain,
		predecessorTrust,
		predecessorAclBytes,
		snapshot,
	} = context;
	assertSettlementCompanionProfile(certificate.exactCanonicalSettlementBytes,chain.successorTrust.profileId);
	const oldHead = decodeHeadRecordV1(certificate.exactCanonicalOldHeadBytes, "head");
	const oldTrust = uniqueCandidateByKind(currentCandidates, "drp-anchor-trust-state");
	const oldProjection = uniqueCandidateByKind(currentCandidates, chain.currentProjectionKind);
	if (
		!oldHead.ok ||
		oldHead.value.kind !== "present" ||
		!sameHead(oldHead.value, currentHead) ||
		currentGeneration.generationId !== currentHead.generationId ||
		currentGeneration.closureDigest !== currentHead.closureDigest ||
		oldTrust === undefined ||
		oldProjection === undefined ||
		!sameRef(oldTrust.ref, certificate.currentTrustRef) ||
		certificate.candidateGenerationId !== candidate.generationId ||
		certificate.candidateClosureDigest !== candidateHead.closureDigest ||
		input.issuanceStore === undefined ||
		input.liveJournalStore === undefined ||
		(Object.hasOwn(chain.cut, "forwardPromotion") && snapshot.promotedSource === undefined)
	)
		throw new TypeError("creator received occupied custody native identity differs");
	const proof = [
		certificate.exactCanonicalCutValueBytes,
		certificate.exactCanonicalCommitQcBytes,
		certificate.exactCanonicalTrustStateRecordBytes,
		certificate.exactCanonicalSettlementBytes,
		certificate.exactCanonicalHistoryBytes,
		...(certificate.exactCanonicalSettlementBytes===null?[certificate.exactCanonicalRetirementBytes!,certificate.exactCanonicalAggregateBytes!]:[]),
	].filter((bytes):bytes is Uint8Array=>bytes!==null).map((bytes) => {
		const digest = digestBlob(bytes);
		if (!digest.ok) throw new TypeError("creator received occupied custody proof digest is invalid");
		return Object.freeze({ bytes, ref: Object.freeze({ digest: digest.value, byteLength: bytes.byteLength }) });
	});
	// Exact companions must be the authenticated native transition, not merely a
	// different valid successor for the same old anchor.
	if (
		proof.some(
			(entry) =>
				!proposedCandidates.some((actual) => sameRef(entry.ref, actual.ref) && sameBytes(entry.bytes, actual.bytes))
		)
	)
		throw new TypeError("creator received occupied custody carrier closure differs");
	const history = openCreatorCloseHistory({
		bytes: certificate.exactCanonicalHistoryBytes,
		exactCanonicalCutValueBytes: certificate.exactCanonicalCutValueBytes,
		historyRoot: chain.cut.historyRoot,
		historySize: chain.cut.historySize,
	});
	if (history === undefined) throw new TypeError("creator received occupied custody history is invalid");
	const accumulator = CompactMerkleAccumulator.fromSnapshot(history);
	const rawCandidates = [
		...currentCandidates.filter(
			({ ref, bytes }) =>
				!sameRef(ref, oldTrust.ref) &&
				!new Set(["drp-creator-author-settlement-state","drp-creator-issuance-retirement-state","drp-creator-author-issuance-frontiers-state"]).has(String(canonicalRecord(bytes)?.kind))
		),
		...proof,
	].sort((a, b) => a.ref.digest.localeCompare(b.ref.digest));
	const transition = Object.freeze({
		cutValueRef: (proof[0] as (typeof proof)[number]).ref,
		commitQcRef: (proof[1] as (typeof proof)[number]).ref,
		successorTrustRef: (proof[2] as (typeof proof)[number]).ref,
		currentTrustRef: oldTrust.ref,
		epoch: chain.currentEpoch,
		successorEpoch: chain.successorEpoch,
		successorAnchorDigest: chain.successorTrust.currentAnchorDigest,
	});
	const advance = inspectCreatorTransitionAdvance({
		current: { candidates: currentCandidates, closure: currentGeneration.closure },
		currentTrust: predecessorTrust,
		mode: "stage",
		proofRefs: [transition.cutValueRef, transition.commitQcRef],
		proposed: { candidates: rawCandidates, closure: rawCandidates.map(({ ref }) => ref) },
		successorTrust: chain.successorTrust,
		settlementAcl: {
			current: predecessorAclBytes,
			successor: snapshot.authorizedAclBytes ?? encodeCanonical(snapshot.payload.acl),
		},
	});
	const resolved = verifiedCatalog(input.catalog, snapshot.payload.blueprintDigest, chain.currentCatalog);
	const projected =
		resolved === undefined
			? undefined
			: projection(
					{
						transition,
						history: {
							historyRoot: hex(accumulator.root()),
							historySize: accumulator.size,
							historySnapshot: accumulator.snapshot(),
						},
					},
					chain,
					snapshot,
					resolved
				);
	if (
		!advance.ok ||
		projected === undefined ||
		!matchesCreatorAdoptionReferences(
			{
				pendingReferences: advance.proposed.closure,
				predecessorLiveRef: oldProjection.ref,
				exactCanonicalProjectionBytes: projected.bytes,
				exactCanonicalCutValueBytes: certificate.exactCanonicalCutValueBytes,
				predecessorExactCanonicalLatchedAclBytes: predecessorAclBytes,
			},
			candidate.closure
		)
	)
		throw new TypeError("creator received occupied custody derived closure differs");
	const replay = await sealCreatorReceivedRecoveryReplay({
		generation: {
			candidates: currentCandidates,
			references: currentGeneration.closure,
			head: currentHead,
			trust: predecessorTrust,
			trustRef: oldTrust.ref,
			exactCanonicalAnchorPreimageBytes: chain.currentTrustRecord
				.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array,
			detachedAnchorSignature: chain.currentTrustRecord.detachedCurrentAnchorSignature as Uint8Array,
			exactCanonicalProjectionBytes: oldProjection.bytes,
		},
		expectedNativeHead: nativeHead,
		catalog: input.catalog,
		exactCanonicalParametersCarrierBytes: input.exactCanonicalParametersCarrierBytes,
		pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
		store: input.store,
		exactCanonicalLatchedAclBytes: predecessorAclBytes,
		issuanceStore: input.issuanceStore,
		liveJournalStore: input.liveJournalStore,
		...(input.proofAccounting === undefined ? {} : { sharedAccounting: input.proofAccounting }),
	});
	if (
		replay === undefined ||
		replay.commitment.digest !== certificate.sealedReplayDigest ||
		replay.commitment.rowCount !== certificate.sealedReplayRowCount ||
		replay.commitment.byteCharge !== certificate.sealedReplayByteCharge ||
		!(await replay.verify())
	)
		throw new TypeError("creator received occupied custody native replay differs");
	const after = await input.snapshotStore.lookupReceivedRecoveryCertificate({
		objectId: retained.scope.objectId,
		epoch: retained.scope.epoch,
		anchor: retained.scope.anchor,
	});
	if (input.proofAccounting !== undefined && (!input.proofAccounting.charge(encodeCanonical(after)) ||
		!input.proofAccounting.charge(projected.bytes)))
		throw new TypeError("creator received recovery readback proof capacity refused");
	if (
		after === null ||
		after.incarnation !== retained.incarnation ||
		after.scope.manifestDigest !== retained.scope.manifestDigest ||
		!sameBytes(after.exactReceivedCertificateBytes, retained.exactReceivedCertificateBytes)
	)
		throw new TypeError("creator received occupied custody incarnation changed");
}

function exactRoomHead(value: unknown): CreatorAdoptionRoomHead | undefined {
	try {
		if (
			value === null ||
			typeof value !== "object" ||
			Object.getPrototypeOf(value) !== Object.prototype ||
			Reflect.ownKeys(value).sort().join(",") !== "currentAnchorDigest,epoch,objectId"
		) {
			return undefined;
		}
		const anchor = Object.getOwnPropertyDescriptor(value, "currentAnchorDigest");
		const epoch = Object.getOwnPropertyDescriptor(value, "epoch");
		const objectId = Object.getOwnPropertyDescriptor(value, "objectId");
		return anchor !== undefined &&
			"value" in anchor &&
			anchor.enumerable === true &&
			typeof anchor.value === "string" &&
			/^[0-9a-f]{64}$/u.test(anchor.value) &&
			epoch !== undefined &&
			"value" in epoch &&
			epoch.enumerable === true &&
			typeof epoch.value === "number" &&
			Number.isSafeInteger(epoch.value) &&
			epoch.value >= 0 &&
			objectId !== undefined &&
			"value" in objectId &&
			objectId.enumerable === true &&
			typeof objectId.value === "string"
			? Object.freeze({
					currentAnchorDigest: anchor.value,
					epoch: epoch.value,
					objectId: objectId.value,
				})
			: undefined;
	} catch {
		return undefined;
	}
}

function sameRoomHead(left: CreatorAdoptionRoomHead, right: CreatorAdoptionRoomHead): boolean {
	return (
		left.currentAnchorDigest === right.currentAnchorDigest &&
		left.epoch === right.epoch &&
		left.objectId === right.objectId
	);
}

function roomHeadFromTrust(trust: CurrentAnchorTrust): CreatorAdoptionRoomHead {
	return Object.freeze({
		currentAnchorDigest: trust.currentAnchorDigest,
		epoch: trust.currentEpoch,
		objectId: trust.objectId,
	});
}


async function authenticatePendingCandidate(
	input: CreatorAdoptionPendingRecoveryInput,
	lineage: readonly GenerationRecord[],
	candidate: GenerationRecord,
	expectedPrevious: CreatorAdoptionRoomHead,
	expectedNext: CreatorAdoptionRoomHead,
	objectId: StorageObjectId,
	readClosure: (closure: readonly GenerationRef[]) => Promise<RecoveredClosure["currentCandidates"] | undefined> = (
		closure
	) => loadClosure(input.store, closure, input.proofAccounting)
): Promise<AuthenticatedPendingCandidate | undefined> {
	let installedPromotion: Awaited<ReturnType<typeof acquireCreatorInstalledPromotion>> | undefined;
	const authenticate = async (): Promise<AuthenticatedPendingCandidate | undefined> => {
		try {
			const base = presentBase(candidate);
			const baseGeneration = lineage.find(({ generationId }) => generationId === base?.generationId);
			const baseCandidates = baseGeneration === undefined ? undefined : await readClosure(baseGeneration.closure);
			const direct =
				baseCandidates !== undefined &&
				uniqueCandidateByKind(baseCandidates, "drp-anchor-trust-state")?.record.currentEpoch === expectedPrevious.epoch;
			const structure = inspectCreatorAdoptionCandidateLineage({ objectId, lineage, candidate, direct });
			if (structure === undefined) return undefined;
			const { currentGeneration, proposedGeneration, candidateHead } = structure;
			const [currentCandidates, nativeProposedCandidates, candidateCandidates] = await Promise.all([
				readClosure(currentGeneration.closure),
				readClosure(proposedGeneration.closure),
				readClosure(candidate.closure),
			]);
			if (
				currentCandidates === undefined ||
				nativeProposedCandidates === undefined ||
				candidateCandidates === undefined
			) {
				return undefined;
			}
			const proposedCandidates = direct
				? receivedTransitionClosure(currentCandidates, candidateCandidates, expectedPrevious.epoch)
				: nativeProposedCandidates;
			if (proposedCandidates === undefined) return undefined;
			const proposedReferences = direct ? proposedCandidates.map(({ ref }) => ref) : proposedGeneration.closure;
			const currentEpoch = expectedPrevious.epoch;
			const successorEpoch = expectedNext.epoch;
			const expectedCurrentProjectionKind = currentProjectionKind(currentEpoch);
			const currentProjection = uniqueCandidateByKind(currentCandidates, expectedCurrentProjectionKind);
			const successorProjection = uniqueCandidateByKind(candidateCandidates, "v3-live-generation-2");
			const currentTrustCandidate = uniqueCandidateByKind(currentCandidates, "drp-anchor-trust-state");
			const successorTrustCandidate = uniqueCandidateByKind(proposedCandidates, "drp-anchor-trust-state");
			const cutCandidate = uniqueCandidateByKind(proposedCandidates, "drp-hard-epoch-cut");
			if (
				currentProjection === undefined ||
				successorProjection === undefined ||
				currentTrustCandidate === undefined ||
				successorTrustCandidate === undefined ||
				cutCandidate === undefined
			) {
				return undefined;
			}
			const qcs = proposedCandidates.flatMap((entry) =>
				canonicalRecord(entry.bytes)?.kind === "drp-seal-qc" ? [entry] : []
			);
			const currentTrustRecord = currentTrustCandidate.record;
			const successorTrustRecord = successorTrustCandidate.record;
			if (
				!(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
				!(currentTrustRecord.detachedCurrentAnchorSignature instanceof Uint8Array) ||
				!(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array)
			) {
				return undefined;
			}
			let predecessorTrust: CurrentAnchorTrust;
			let successorTrust: CurrentAnchorTrust;
			let selectedQc: (typeof qcs)[number];
			if (currentEpoch === 0) {
				if (
					!sameBytes(
						input.exactCanonicalAnchorPreimageBytes,
						currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes
					) ||
					!sameBytes(input.detachedSignature, currentTrustRecord.detachedCurrentAnchorSignature)
				) {
					return undefined;
				}
				const openedCurrent = openCurrentAnchorTrust({
					exactCanonicalTrustStateRecordBytes: currentTrustCandidate.bytes,
					expectedObjectId: objectId,
					pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
				});
				if (!openedCurrent.ok) return undefined;
				const openedSuccessors = qcs.flatMap((entry) => {
					const opened = openCreatorSuccessorTrust({
						currentTrust: openedCurrent.trust,
						exactCanonicalCommitQcBytes: entry.bytes,
						exactCanonicalCutValueBytes: cutCandidate.bytes,
						exactCanonicalTrustStateRecordBytes: successorTrustCandidate.bytes,
					});
					return opened.ok ? [Object.freeze({ qc: entry, trust: opened.trust })] : [];
				});
				if (openedSuccessors.length !== 1) return undefined;
				const openedSuccessor = openedSuccessors[0] as (typeof openedSuccessors)[number];
				predecessorTrust = openedCurrent.trust;
				successorTrust = openedSuccessor.trust;
				selectedQc = openedSuccessor.qc;
			} else {
				const openedCheckpoints = qcs.flatMap((entry) => {
					const opened = (
						Object.hasOwn(cutCandidate.record, "forwardPromotion")
							? openCreatorForwardPromotionCheckpointTrust
							: openCreatorCheckpointTrust
					)({
						detachedGenesisSignature: input.detachedSignature,
						exactCanonicalCommitQcBytes: entry.bytes,
						exactCanonicalCurrentTrustStateRecordBytes: successorTrustCandidate.bytes,
						exactCanonicalCutValueBytes: cutCandidate.bytes,
						exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
						exactCanonicalPredecessorTrustStateRecordBytes: currentTrustCandidate.bytes,
						expectedCurrentHead: expectedNext,
						expectedObjectId: objectId,
						pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
					});
					return opened.ok ? [Object.freeze({ opened, qc: entry })] : [];
				});
				if (openedCheckpoints.length !== 1) return undefined;
				const selected = openedCheckpoints[0] as (typeof openedCheckpoints)[number];
				predecessorTrust = selected.opened.predecessorTrust;
				successorTrust = selected.opened.currentTrust;
				selectedQc = selected.qc;
			}
			if (
				!sameRoomHead(roomHeadFromTrust(predecessorTrust), expectedPrevious) ||
				!sameRoomHead(roomHeadFromTrust(successorTrust), expectedNext) ||
				!inspectCreatorTransitionAdvance({
					current: { candidates: currentCandidates, closure: currentGeneration.closure },
					currentTrust: predecessorTrust,
					mode: "verify",
					proofRefs: [cutCandidate.ref, selectedQc.ref],
					proposed: { candidates: proposedCandidates, closure: proposedReferences },
					successorTrust,
				}).ok
			) {
				return undefined;
			}
			const currentAnchor = canonicalRecord(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
			const successorAnchor = canonicalRecord(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
			if (
				currentAnchor === undefined ||
				successorAnchor === undefined ||
				currentProjection.record.epoch !== currentEpoch ||
				currentProjection.record.objectId !== objectId ||
				currentProjection.record.blueprintDigest !== currentAnchor.blueprintDigest ||
				currentProjection.record.blueprintDigest !== successorAnchor.blueprintDigest
			) {
				return undefined;
			}
			const chain: VerifiedChain = Object.freeze({
				currentAnchor,
				currentEpoch,
				currentCatalog: Object.freeze({
					artifactDigest: String(currentProjection.record.artifactDigest),
					artifactId: String(currentProjection.record.artifactId),
					blueprintDigest: String(currentProjection.record.blueprintDigest),
					catalogDigest: String(currentProjection.record.catalogDigest),
					runtimeProfile: String(currentProjection.record.runtimeProfile),
				}),
				currentProjectionKind: expectedCurrentProjectionKind,
				currentTrustRecord,
				cut: cutCandidate.record,
				successorAnchor,
				successorAnchorBytes: Uint8Array.from(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes),
				successorEpoch,
				successorTrust,
				successorTrustRecord,
			});
			const observation = await input.snapshotStore.lookupRecoveryDeclaration({
				objectId: String(chain.cut.objectId),
				epoch: Number(chain.cut.epoch),
				anchor: String(chain.cut.previousAnchor),
				manifestDigest: String(chain.cut.snapshotManifestDigest),
			});
			if (input.proofAccounting !== undefined && !input.proofAccounting.charge(encodeCanonical(observation)))
				return undefined;
			if (observation.kind !== "present" || observation.state === "poisoned") return undefined;
			const snapshotDeclaration = observation.declaration;
			let snapshot = await verifySnapshot({ snapshotDeclaration, snapshotStore: input.snapshotStore }, chain, input.proofAccounting);
			if (snapshot === undefined) return undefined;
			const authorizedAclBytes = encodeCanonical(snapshot.payload.acl);
			if (Object.hasOwn(chain.cut, "forwardPromotion")) {
				const head = await input.store.readHead(objectId);
				// The original lineage validator binds the complete base head, including
				// its revision and closure digest. A direct Complete received candidate
				// has not published yet: its native head is still the Adopted predecessor.
				const permittedHead = direct
					? candidate.state === "Complete"
						? structure.currentHead
						: structure.candidateHead
					: undefined;
				if (
					!head.ok ||
					head.value.kind !== "present" ||
					(permittedHead === undefined
						? !sameHead(head.value, structure.proposedHead) && !sameHead(head.value, structure.candidateHead)
						: !sameHead(head.value, permittedHead))
				)
					return undefined;
				const promotionInput = {
					store: input.store,
					snapshotStore: input.snapshotStore,
					catalog: input.catalog,
					expectedHead: head.value,
					currentTrust: predecessorTrust,
					successorTrust,
					currentGenerationId: currentGeneration.generationId,
					proposedGenerationId: proposedGeneration.generationId,
					exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
					detachedGenesisSignature: input.detachedSignature,
				};
				installedPromotion = direct
					? await acquireCreatorReceivedPromotion({ ...promotionInput, receivedProposal: {
						closure: { candidates: proposedCandidates, closure: proposedReferences },
						currentCloseSnapshot: { exactCanonicalManifestBytes: snapshotDeclaration.exactCanonicalManifestBytes,
							exactCanonicalPayloadBytes: snapshot.exactCanonicalPayloadBytes },
					} }, input.proofAccounting)
					: await acquireCreatorInstalledPromotion(promotionInput, input.proofAccounting);
				if (!sameBytes(installedPromotion.authorizedAclBytes, authorizedAclBytes)) return undefined;
				const manifest = canonicalRecord(installedPromotion.exactCanonicalManifestBytes),
					payload = canonicalRecord(installedPromotion.exactCanonicalPayloadBytes);
				if (manifest === undefined || payload === undefined) return undefined;
				snapshot = Object.freeze({
					manifest,
					payload,
					exactCanonicalPayloadBytes: installedPromotion.exactCanonicalPayloadBytes,
					authorizedAclBytes,
					promotedSource: installedPromotion.source,
				});
			}
			const resolved = verifiedCatalog(input.catalog, snapshot.payload.blueprintDigest, chain.currentCatalog);
			const manifestDigest = snapshotDeclaration.scope.manifestDigest;
			if (
				resolved === undefined ||
				!(snapshot.promotedSource === undefined
					? creatorSnapshotProjectionMatches(
							successorProjection.record,
							successorAnchor,
							successorTrust.currentAnchorDigest,
							manifestDigest,
							snapshot.manifest
						)
					: creatorPromotedSnapshotProjectionMatches(
							successorProjection.record,
							successorAnchor,
							successorTrust.currentAnchorDigest,
							snapshot.promotedSource,
							snapshot.manifest
						)) ||
				hex(hashDomain("ts-drp/parameters/v3", input.exactCanonicalParametersCarrierBytes)) !==
					successorAnchor.parametersDigest
			) {
				return undefined;
			}
			const predecessorAclCandidates = candidateCandidates.filter(
				(entry) => hex(hashDomain("ts-drp/latched-acl/v3", entry.bytes)) === currentAnchor.aclDigest
			);
			if (predecessorAclCandidates.length !== 1) return undefined;
			const openedPredecessorAcl = openCanonicalLatchedAclSnapshot({
				exactCanonicalLatchedAclBytes: predecessorAclCandidates[0]?.bytes as Uint8Array,
				expectedAclDigest: String(currentAnchor.aclDigest),
				expectedEpoch: expectedPrevious.epoch,
				expectedObjectId: objectId,
				expectedProfileId: predecessorTrust.profileId,
			});
			await installedPromotion?.check();
			return openedPredecessorAcl.ok &&
				(settlementProfileFor(successorTrust.profileId) !== "v1" ||
					inspectCreatorTransitionAdvance({
						current: { candidates: currentCandidates, closure: currentGeneration.closure },
						currentTrust: predecessorTrust,
						mode: "verify",
						proofRefs: [cutCandidate.ref, selectedQc.ref],
						proposed: { candidates: proposedCandidates, closure: proposedReferences },
						successorTrust,
						settlementAcl: {
							current: predecessorAclCandidates[0]?.bytes as Uint8Array,
							successor: authorizedAclBytes,
						},
					}).ok)
				? Object.freeze({
						...(installedPromotion === undefined ? {} : { promotionDependencies: installedPromotion }),
						closureDigest: candidateHead.closureDigest,
						generation: candidate,
						head: candidateHead,
						receivedContext: Object.freeze({
							currentGeneration,
							currentHead: structure.currentHead,
							currentCandidates,
							proposedCandidates,
							candidate,
							candidateHead,
							chain,
							predecessorTrust,
							predecessorAclBytes: predecessorAclCandidates[0]?.bytes as Uint8Array,
							snapshot,
						}),
					})
				: undefined;
		} catch {
			return undefined;
		}
	};
	const result = await authenticate();
	if (result === undefined) {
		try { await installedPromotion?.release(); }
		catch { return undefined; }
	}
	return result;
}

function pendingRecoveryFailure(kind: string, detail: string): CreatorAdoptionPendingRecoveryResult {
	return Object.freeze({ detail, kind, ok: false as const });
}

/**
 * Discovers native retained custody before any writer is opened. This is the same
 * adoption verifier and intent owner used by receive; discovery itself never
 * publishes a head or grants a floor. Complete candidates take precedence.
 */
/** Restores the original local Q's private adoption facts before any live reconstruction. */
async function restoreLocalArchiveClosedAdoption(
	input: Parameters<typeof selectRetainedCreatorSuccessorAdoption>[0]
): ReturnType<typeof selectRetainedCreatorSuccessorAdoption> {
	const archive = input.archiveRecovery;
	if (archive === undefined) return null;
	const accounting = archive.accounting;
	const parsed = parseStorageObjectId(input.expectedPreviousRoomHead.objectId);
	if (!parsed.ok) throw new TypeError("archive local close startup scope is invalid");
	const objectId = parsed.value;
	const floorScope = Object.freeze({ objectId, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest });
	const floorRead = archive.roomHeadAuthority.read.bind(archive.roomHeadAuthority);
	const initial = captureCreatorRoomHeadState(await floorRead({ scope: floorScope }), objectId, input.pinnedGenesisAnchorDigest);
	if (!initial.ok || !sameRoomHead(initial.state.stable, input.expectedPreviousRoomHead) ||
		!accounting.charge(encodeCanonical(initial))) throw new TypeError("archive local close startup floor differs");
	const floorBytes = encodeCanonical(initial.state);
	const checkFloor = async (): Promise<void> => {
		const fresh = captureCreatorRoomHeadState(await floorRead({ scope: floorScope }), objectId, input.pinnedGenesisAnchorDigest);
		if (!fresh.ok || compareBytes(encodeCanonical(fresh.state), floorBytes) !== 0 || !accounting.charge(encodeCanonical(fresh)))
			throw new TypeError("archive local close startup whole floor changed or exhausted");
		const readiness = await input.snapshotStore.recoveryStatus();
		if (readiness.migration !== "ready" || !accounting.charge(encodeCanonical(readiness)))
			throw new TypeError("archive local close startup inherited custody is held or exhausted");
	};
	const exportInput: CreatorSuccessorExportInput = Object.freeze({ store: input.store, snapshotStore: input.snapshotStore,
		objectId, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
		exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
		detachedGenesisSignature: input.detachedSignature, catalog: input.catalog });
	const captureQ = async (): Promise<ColdArchiveCloseEvidence | undefined> => {
		let result: ColdArchiveCloseEvidence | undefined;
		try {
			await readCreatorSuccessorExportMaterial(exportInput, undefined,
				{ accounting, checkFloor, captureClosed: facts => { result = facts; } });
		} catch (cause) {
			if (!(cause instanceof CreatorSuccessorExportUnavailable)) throw cause;
		}
		return result;
	};
	const closed = await captureQ();
	if (closed === undefined) return null; // A genuine genesis/L is not a local closed Q.
	if (initial.state.stable.epoch !== closed.chain.currentEpoch ||
		initial.state.stable.currentAnchorDigest !== closed.chain.currentTrustRecord.currentAnchorDigest ||
		closed.chain.currentAnchor.objectId !== objectId)
		throw new TypeError("archive local close startup source differs from the provider floor");
	const next = roomHeadFromTrust(closed.chain.successorTrust);
	if (initial.state.pending !== null && !sameRoomHead(initial.state.pending.next, next))
		throw new TypeError("archive local close startup pending target differs from the original certificate");
	const currentTrustCandidate = uniqueCandidateByKind(closed.closure.currentCandidates, "drp-anchor-trust-state"),
		currentProjection = uniqueCandidateByKind(closed.closure.currentCandidates, closed.chain.currentProjectionKind),
		cut = uniqueCandidateByKind(closed.closure.proposedCandidates, "drp-hard-epoch-cut"),
		qc = uniqueCandidateByKind(closed.closure.proposedCandidates, "drp-seal-qc"),
		trust = uniqueCandidateByKind(closed.closure.proposedCandidates, "drp-anchor-trust-state");
	if (currentTrustCandidate === undefined || currentProjection === undefined || cut === undefined || qc === undefined || trust === undefined ||
		!(closed.chain.currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
		!(closed.chain.currentTrustRecord.detachedCurrentAnchorSignature instanceof Uint8Array))
		throw new TypeError("archive local close startup original source bytes are missing");
	let predecessorTrust: CurrentAnchorTrust;
	if (closed.chain.currentEpoch === 0) {
		const opened = openCurrentAnchorTrust({ exactCanonicalTrustStateRecordBytes: currentTrustCandidate.bytes,
			expectedObjectId: objectId, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest });
		if (!opened.ok) throw new TypeError("archive local close startup source genesis is invalid");
		predecessorTrust = opened.trust;
	} else {
		const opened = (Object.hasOwn(cut.record, "forwardPromotion") ? openCreatorForwardPromotionCheckpointTrust : openCreatorCheckpointTrust)({
			detachedGenesisSignature: input.detachedSignature, exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
			exactCanonicalCommitQcBytes: qc.bytes, exactCanonicalCutValueBytes: cut.bytes,
			exactCanonicalCurrentTrustStateRecordBytes: trust.bytes, exactCanonicalPredecessorTrustStateRecordBytes: currentTrustCandidate.bytes,
			expectedCurrentHead: next, expectedObjectId: objectId, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest });
		if (!opened.ok) throw new TypeError("archive local close startup original checkpoint is invalid");
		predecessorTrust = opened.predecessorTrust;
	}
	const checkNativeArchiveSource = async (): Promise<void> => {
		const native = input.store as AheBoundedRecoveryRoleStore;
		if (native.readRetirementControl === undefined) throw new TypeError("archive local Q native floor owner is unavailable");
		const read = await native.readRetirementControl(objectId);
		if (!read.ok || !accounting.charge(encodeCanonical(read.value)) || read.value?.active != null || read.value?.nominee != null ||
			read.value?.completed?.generationDrain?.phase === "pending" ||
			(read.value?.completed != null && read.value.completed.throughEpoch >= next.epoch))
			throw new TypeError("archive local Q native floor or unresolved intent refuses continuation");
	};
	await completeCreatorCertifiedArchiveAppend({ archiveStore: archive.store, accounting, currentTrust: predecessorTrust,
		exactCanonicalCutValueBytes: cut.bytes, exactCanonicalCommitQcBytes: qc.bytes,
		exactCanonicalTrustStateRecordBytes: trust.bytes, checkCurrent: async (): Promise<void> => {
			await checkNativeArchiveSource();
			const fresh = await captureQ();
			if (fresh === undefined || !sameHead(fresh.head, closed.head) ||
				compareBytes(encodeCanonical(fresh.generation), encodeCanonical(closed.generation)) !== 0)
				throw new TypeError("archive local Q changed before its exact native archive readback");
		} });
	let oldAcl = Uint8Array.from(input.exactCanonicalGenesisLatchedAclBytes);
	if (closed.chain.currentEpoch > 0) {
		const priorCut = uniqueCandidateByKind(closed.closure.currentCandidates, "drp-hard-epoch-cut");
		if (priorCut === undefined) throw new TypeError("archive local close startup source snapshot proof is missing");
		const lookup = await input.snapshotStore.lookupRecoveryDeclaration({ objectId, epoch: Number(priorCut.record.epoch),
			anchor: String(priorCut.record.previousAnchor), manifestDigest: String(priorCut.record.snapshotManifestDigest) });
		if (!accounting.charge(encodeCanonical(lookup)) || lookup.kind !== "present" || lookup.state !== "verified" || lookup.retention !== "recovery")
			throw new TypeError("archive local close startup source snapshot custody is missing or exhausted");
		const snapshot = await verifySnapshot({ snapshotStore: input.snapshotStore, snapshotDeclaration: lookup.declaration },
			{ cut: priorCut.record, successorTrust: predecessorTrust }, accounting);
		if (snapshot === undefined) throw new TypeError("archive local close startup source snapshot is invalid");
		oldAcl = encodeCanonical(snapshot.payload.acl);
	}
	if (hex(hashDomain("ts-drp/latched-acl/v3", oldAcl)) !== closed.chain.currentAnchor.aclDigest || !accounting.charge(oldAcl))
		throw new TypeError("archive local close startup source ACL differs or exhausts its charge");
	const replay = await sealCreatorReceivedRecoveryReplay({ generation: {
		candidates: closed.closure.currentCandidates, references: closed.currentGeneration.closure,
		head: closed.currentHead, trust: predecessorTrust, trustRef: currentTrustCandidate.ref,
		exactCanonicalAnchorPreimageBytes: closed.chain.currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes,
		detachedAnchorSignature: closed.chain.currentTrustRecord.detachedCurrentAnchorSignature,
		exactCanonicalProjectionBytes: currentProjection.bytes }, expectedNativeHead: closed.head,
		catalog: input.catalog, exactCanonicalParametersCarrierBytes: input.exactCanonicalParametersCarrierBytes,
		pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest, store: input.store,
		exactCanonicalLatchedAclBytes: oldAcl, issuanceStore: input.issuanceStore, liveJournalStore: input.liveJournalStore,
		sharedAccounting: accounting });
	if (replay === undefined || !accounting.charge(encodeCanonical(replay.commitment)))
		throw new TypeError("archive local close startup original journal replay is invalid or exhausted");
	const history = openCreatorCloseHistory({ bytes: closed.historyBytes, exactCanonicalCutValueBytes: cut.bytes,
		historyRoot: cut.record.historyRoot, historySize: cut.record.historySize });
	if (history === undefined) throw new TypeError("archive local close startup original compact history differs");
	let alive = true;
	const owner = Object.freeze({});
	const release = async (): Promise<void> => { alive = false; revokeCreatorAdoptionFacts(owner); };
	const checkClosed = async (): Promise<void> => {
		if (!alive) throw new TypeError("archive restored local close owner is released");
		const fresh = await captureQ();
		if (!alive || fresh === undefined || !sameHead(fresh.head, closed.head) ||
			compareBytes(encodeCanonical(fresh.generation), encodeCanonical(closed.generation)) !== 0 ||
			!sameBytes(fresh.historyBytes, closed.historyBytes) ||
			!sameBytes(fresh.snapshot.exactCanonicalPayloadBytes, closed.snapshot.exactCanonicalPayloadBytes) ||
			compareBytes(encodeCanonical(fresh.promotion?.historicalSnapshots ?? []), encodeCanonical(closed.promotion?.historicalSnapshots ?? [])) !== 0)
			throw new TypeError("archive restored local close source, snapshot or protected history changed");
	};
	const facts: SealedAdoptionFacts = Object.freeze({ origin: "local-close", proofAccounting: accounting,
		...(closed.promotion === undefined ? {} : { promotion: {
			verified: closed.promotion.verified, closedEpoch: closed.promotion.closedEpoch,
			source: { historicalSnapshots: closed.promotion.historicalSnapshots, checkSnapshots: checkClosed, release } },
			certifiedRecoverySourceGenerations: closed.promotion.supportGenerations,
			classifiedRecoverySourceGenerations: Object.freeze([]) }),
		transition: { currentTrustRef: currentTrustCandidate.ref, cutValueRef: cut.ref, commitQcRef: qc.ref,
			successorTrustRef: trust.ref, epoch: closed.chain.currentEpoch, successorEpoch: next.epoch,
			successorAnchorDigest: next.currentAnchorDigest },
		currentHead: closed.currentHead, currentReferences: closed.currentGeneration.closure, currentTrust: predecessorTrust,
		durableReplay: { verify: async (): Promise<boolean> => { await checkClosed(); return replay.verify(); } },
		exactCanonicalLatchedAclBytes: oldAcl, exactCanonicalParametersCarrierBytes: input.exactCanonicalParametersCarrierBytes,
		exactCanonicalPinnedGenesisBootstrapOperationBytes: input.exactCanonicalPinnedGenesisBootstrapOperationBytes,
		history: { historyRoot: String(cut.record.historyRoot), historySize: Number(cut.record.historySize), historySnapshot: history },
		issuanceScope: { objectId, author: input.author }, issuanceStore: input.issuanceStore, liveJournalStore: input.liveJournalStore,
		objectId, proposedHead: closed.head, proposedReferences: closed.generation.closure,
		snapshotDeclaration: closed.snapshotDeclaration, snapshotStore: input.snapshotStore, store: input.store,
		// This composition runs before the room creates any live plane. There is no active
		// source runtime to impersonate or stop; native protected obligations stay intact.
		terminalizeSource: async (): Promise<boolean> => { await release(); return true; } });
	if (!installCreatorAdoptionFacts(owner, facts)) throw new TypeError("archive restored local close provenance conflicts");
	try {
		const verified = await verifyCreatorSuccessorAdoption({ handle: owner, catalog: input.catalog });
		if (!verified.ok || !(await replay.verify())) throw new TypeError("archive restored local close adoption verification failed");
		await checkClosed();
		// Reuse the existing retained-adoption shape and stage/publish owner. This is
		// restored local-close custody, not an incoming portable received certificate.
		return Object.freeze({ head: next, received: Object.freeze({ handle: owner, verified, releasePromotionDependencies: release }) });
	} catch (cause) { await release(); throw cause; }
}

export async function selectRetainedCreatorSuccessorAdoption(
	input: Readonly<{
		authenticationProfile: "creator-only";
		catalog: TrustedBlueprintCatalog;
		detachedSignature: Uint8Array;
		exactCanonicalAnchorPreimageBytes: Uint8Array;
		exactCanonicalParametersCarrierBytes: Uint8Array;
		exactCanonicalGenesisLatchedAclBytes: Uint8Array;
		exactCanonicalPinnedGenesisBootstrapOperationBytes?: Uint8Array;
		expectedPreviousRoomHead: CreatorAdoptionRoomHead;
		pinnedGenesisAnchorDigest: string;
		snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
		store: AheDurableStore;
		issuanceStore: DurableIssuanceStore;
		liveJournalStore: DurableLiveJournalStore;
		author: string;
		archiveRecovery?: CreatorSuccessorExportInput["archiveRecovery"];
	}>
): Promise<Readonly<{
	head: CreatorAdoptionRoomHead;
	received?: ReceivedCreatorSuccessorAdoption;
}> | null> {
	const previous = exactRoomHead(input.expectedPreviousRoomHead);
	const parsed = previous === undefined ? undefined : parseStorageObjectId(previous.objectId);
	if (input.authenticationProfile !== "creator-only" || previous === undefined || parsed === undefined || !parsed.ok)
		throw new TypeError("creator retained recovery input is invalid");
	if (input.archiveRecovery !== undefined) {
		const native = await input.store.readHead(parsed.value);
		if (!native.ok || !input.archiveRecovery.accounting.charge(encodeCanonical(native.value)))
			throw new TypeError("creator archive startup native head is unavailable or exhausted");
		if (native.value.kind === "present") {
			try {
				await readCreatorSuccessorExport({ store: input.store, snapshotStore: input.snapshotStore,
					objectId: parsed.value, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
					exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
					detachedGenesisSignature: input.detachedSignature, catalog: input.catalog,
					archiveRecovery: input.archiveRecovery });
			} catch (cause) {
				if (!(cause instanceof CreatorSuccessorExportUnavailable)) throw cause;
			}
		}
	}
	const proofAccounting = input.archiveRecovery?.accounting;
	const reader = await acquireCreatorRecoveryCensus(input.store, parsed.value, proofAccounting);
	let readerReleased = false;
	let primary: unknown;
	let failed = false;
	let promotionSource: Awaited<ReturnType<typeof acquireCreatorReceivedPromotion>> | undefined;
	let promotionTransferred = false;
	const candidatePromotionDependencies: NonNullable<CreatorSuccessorLiveMaterial["promotionDependencies"]>[] = [];
	try {
		const readClosure = (
			references: readonly GenerationRef[]
		): Promise<RecoveredClosure["currentCandidates"] | undefined> =>
			Promise.resolve(recoveryCensusClosure(reader, references));
		const custody = await readReceivedCustody({ ...input, ...(proofAccounting === undefined ? {} : { proofAccounting }) }, previous);
		const complete: Readonly<{ candidate: AuthenticatedPendingCandidate; next: CreatorAdoptionRoomHead }>[] = [];
		for (const generation of reader.generations) {
			if (generation.state !== "Complete") continue;
			const closure = await readClosure(generation.closure);
			const trust = closure === undefined ? undefined : uniqueCandidateByKind(closure, "drp-anchor-trust-state");
			if (trust?.record.currentEpoch !== previous.epoch + 1) continue;
			const next = exactRoomHead({
				objectId: previous.objectId,
				epoch: previous.epoch + 1,
				currentAnchorDigest: trust.record.currentAnchorDigest,
			});
			if (next === undefined) continue;
			const candidate = await authenticatePendingCandidate(
				{ ...input, expectedNextRoomHead: next, ...(proofAccounting === undefined ? {} : { proofAccounting }) },
				reader.generations,
				generation,
				previous,
				next,
				parsed.value,
				readClosure
			);
			if (candidate?.promotionDependencies !== undefined)
				candidatePromotionDependencies.push(candidate.promotionDependencies);
			if (
				candidate === undefined &&
				generation.baseExpectedHead.kind === "present" &&
				reader.head.kind === "present" &&
				sameHead(generation.baseExpectedHead, reader.head)
			)
				throw new TypeError("creator retained recovery complete successor authentication failed");
			if (
				candidate !== undefined &&
				candidate.generation.baseExpectedHead.kind === "present" &&
				reader.head.kind === "present" &&
				sameHead(candidate.generation.baseExpectedHead, reader.head)
			) {
				await authenticateReceivedCandidateCustody(
					{ ...input, expectedNextRoomHead: next, ...(proofAccounting === undefined ? {} : { proofAccounting }) },
					custody,
					candidate.receivedContext,
					reader.head
				);
				complete.push(Object.freeze({ candidate, next }));
			}
		}
		if (new Set(complete.map(({ candidate }) => candidate.closureDigest)).size > 1)
			throw new TypeError("creator retained recovery complete successors conflict");
		if (complete.length > 0) {
			if (!(await reader.checkCurrency()).ok) throw new TypeError("creator retained recovery native census changed");
			return Object.freeze({ head: (complete[0] as (typeof complete)[number]).next });
		}
		if (custody === null) {
			const present = reader.head.kind === "present";
			await reader.release();
			readerReleased = true;
			return present ? restoreLocalArchiveClosedAdoption(input) : null;
		}
		const { retained, certificate } = custody;
		const decodedHead = decodeHeadRecordV1(certificate.exactCanonicalOldHeadBytes, "head");
		if (
			!decodedHead.ok ||
			decodedHead.value.kind !== "present" ||
			reader.head.kind !== "present" ||
			!sameHead(decodedHead.value, reader.head) ||
			certificate.pinnedGenesisAnchorDigest !== input.pinnedGenesisAnchorDigest
		)
			throw new TypeError("creator retained recovery old native head differs");
		const nativeHead = reader.head;
		const native = reader.generations.find(({ generationId }) => generationId === nativeHead.generationId);
		const current = native === undefined ? undefined : await readClosure(native.closure);
		const oldTrust = current === undefined ? undefined : uniqueCandidateByKind(current, "drp-anchor-trust-state");
		const oldProjection =
			current === undefined ? undefined : uniqueCandidateByKind(current, currentProjectionKind(previous.epoch));
		if (
			native?.state !== "Adopted" ||
			current === undefined ||
			oldTrust === undefined ||
			oldProjection === undefined ||
			!sameRef(oldTrust.ref, certificate.currentTrustRef) ||
			oldTrust.record.currentEpoch !== previous.epoch ||
			oldTrust.record.currentAnchorDigest !== previous.currentAnchorDigest
		)
			throw new TypeError("creator retained recovery old native closure differs");
		const cut = canonicalRecord(certificate.exactCanonicalCutValueBytes);
		const successorRecord = canonicalRecord(certificate.exactCanonicalTrustStateRecordBytes);
		if (cut === undefined || successorRecord === undefined)
			throw new TypeError("creator retained recovery proof is invalid");
		const promoted = Object.hasOwn(cut, "forwardPromotion");
		const next = exactRoomHead({
			objectId: previous.objectId,
			epoch: previous.epoch + 1,
			currentAnchorDigest: successorRecord.currentAnchorDigest,
		});
		if (next === undefined) throw new TypeError("creator retained recovery successor scope is invalid");
		const genesis =
			previous.epoch === 0
				? openCurrentAnchorTrust({
						exactCanonicalTrustStateRecordBytes: oldTrust.bytes,
						expectedObjectId: parsed.value,
						pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
					})
				: undefined;
		const adjacent = genesis?.ok
			? (promoted ? openCreatorForwardPromotionSuccessorTrust : openCreatorSuccessorTrust)({
					currentTrust: genesis.trust,
					exactCanonicalCutValueBytes: certificate.exactCanonicalCutValueBytes,
					exactCanonicalCommitQcBytes: certificate.exactCanonicalCommitQcBytes,
					exactCanonicalTrustStateRecordBytes: certificate.exactCanonicalTrustStateRecordBytes,
				})
			: undefined;
		const checkpoint =
			previous.epoch === 0
				? genesis?.ok && adjacent?.ok
					? { ok: true as const, predecessorTrust: genesis.trust, currentTrust: adjacent.trust }
					: { ok: false as const }
				: (promoted ? openCreatorForwardPromotionCheckpointTrust : openCreatorCheckpointTrust)({
						detachedGenesisSignature: input.detachedSignature,
						exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
						exactCanonicalCommitQcBytes: certificate.exactCanonicalCommitQcBytes,
						exactCanonicalCutValueBytes: certificate.exactCanonicalCutValueBytes,
						exactCanonicalCurrentTrustStateRecordBytes: certificate.exactCanonicalTrustStateRecordBytes,
						exactCanonicalPredecessorTrustStateRecordBytes: oldTrust.bytes,
						expectedCurrentHead: next,
						expectedObjectId: parsed.value,
						pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
					});
		if (
			!checkpoint.ok ||
			!sameRoomHead(roomHeadFromTrust(checkpoint.predecessorTrust), previous) ||
			!sameRoomHead(roomHeadFromTrust(checkpoint.currentTrust), next) ||
			(previous.epoch === 0 &&
				(!sameBytes(
					input.exactCanonicalAnchorPreimageBytes,
					oldTrust.record.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array
				) ||
					!sameBytes(input.detachedSignature, oldTrust.record.detachedCurrentAnchorSignature as Uint8Array)))
		)
			throw new TypeError("creator retained recovery current trust authentication failed");
		assertSettlementCompanionProfile(certificate.exactCanonicalSettlementBytes,checkpoint.currentTrust.profileId);
		const observation = await input.snapshotStore.lookupRecoveryDeclaration(retained.scope);
		if (proofAccounting !== undefined && !proofAccounting.charge(encodeCanonical(observation)))
			throw new TypeError("creator retained recovery snapshot declaration proof capacity refused");
		if (
			observation.kind !== "present" ||
			observation.state !== "verified" ||
			observation.retention !== "recovery" ||
			cut.snapshotManifestDigest !== retained.scope.manifestDigest ||
			cut.epoch !== previous.epoch ||
			cut.previousAnchor !== previous.currentAnchorDigest
		)
			throw new TypeError("creator retained recovery snapshot ownership differs");
		const oldAnchor = canonicalRecord(oldTrust.record.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array);
		if (oldAnchor === undefined) throw new TypeError("creator retained recovery old anchor is invalid");
		let oldAcl = input.exactCanonicalGenesisLatchedAclBytes;
		if (previous.epoch > 0) {
			const oldCut = uniqueCandidateByKind(current, "drp-hard-epoch-cut");
			if (oldCut === undefined)
				throw new TypeError("creator retained recovery predecessor snapshot proof is unavailable");
			const oldObservation = await input.snapshotStore.lookupRecoveryDeclaration({
				objectId: previous.objectId,
				epoch: Number(oldCut.record.epoch),
				anchor: String(oldCut.record.previousAnchor),
				manifestDigest: String(oldCut.record.snapshotManifestDigest),
			});
			if (proofAccounting !== undefined && !proofAccounting.charge(encodeCanonical(oldObservation)))
				throw new TypeError("creator retained recovery predecessor declaration proof capacity refused");
			if (
				oldObservation.kind !== "present" ||
				oldObservation.state !== "verified" ||
				oldObservation.retention !== "recovery"
			)
				throw new TypeError("creator retained recovery predecessor snapshot is unavailable");
			const oldSnapshot = await verifySnapshot(
				{ snapshotDeclaration: oldObservation.declaration, snapshotStore: input.snapshotStore },
				{ cut: oldCut.record, successorTrust: checkpoint.predecessorTrust }, proofAccounting
			);
			if (oldSnapshot === undefined) throw new TypeError("creator retained recovery predecessor snapshot is invalid");
			oldAcl = encodeCanonical(oldSnapshot.payload.acl);
		}
		if (hex(hashDomain("ts-drp/latched-acl/v3", oldAcl)) !== oldAnchor.aclDigest)
			throw new TypeError("creator retained recovery predecessor ACL differs");
		const replay = await sealCreatorReceivedRecoveryReplay({
			generation: {
				candidates: current,
				references: native.closure,
				head: reader.head,
				trust: checkpoint.predecessorTrust,
				trustRef: oldTrust.ref,
				exactCanonicalAnchorPreimageBytes: oldTrust.record.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array,
				detachedAnchorSignature: oldTrust.record.detachedCurrentAnchorSignature as Uint8Array,
				exactCanonicalProjectionBytes: oldProjection.bytes,
			},
			catalog: input.catalog,
			exactCanonicalParametersCarrierBytes: input.exactCanonicalParametersCarrierBytes,
			pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
			store: input.store,
			exactCanonicalLatchedAclBytes: oldAcl,
			issuanceStore: input.issuanceStore,
			liveJournalStore: input.liveJournalStore,
			...(proofAccounting === undefined ? {} : { sharedAccounting: proofAccounting }),
		});
		if (
			replay === undefined ||
			replay.commitment.digest !== certificate.sealedReplayDigest ||
			replay.commitment.rowCount !== certificate.sealedReplayRowCount ||
			replay.commitment.byteCharge !== certificate.sealedReplayByteCharge
		)
			throw new TypeError("creator retained recovery native replay differs");
		const history = openCreatorCloseHistory({
			bytes: certificate.exactCanonicalHistoryBytes,
			exactCanonicalCutValueBytes: certificate.exactCanonicalCutValueBytes,
			historyRoot: cut.historyRoot,
			historySize: cut.historySize,
		});
		if (history === undefined) throw new TypeError("creator retained recovery history differs");
		const accumulator = CompactMerkleAccumulator.fromSnapshot(history);
		const proof = [
			certificate.exactCanonicalCutValueBytes,
			certificate.exactCanonicalCommitQcBytes,
			certificate.exactCanonicalTrustStateRecordBytes,
			certificate.exactCanonicalSettlementBytes,
			certificate.exactCanonicalHistoryBytes,
			...(certificate.exactCanonicalSettlementBytes===null?[certificate.exactCanonicalRetirementBytes!,certificate.exactCanonicalAggregateBytes!]:[]),
		].filter((bytes):bytes is Uint8Array=>bytes!==null).map((bytes) => {
			const digest = digestBlob(bytes);
			if (!digest.ok) throw new TypeError("creator retained recovery proof digest is invalid");
			return Object.freeze({ bytes, ref: Object.freeze({ digest: digest.value, byteLength: bytes.byteLength }) });
		});
		const proposedCandidates = [
			...current.filter(
				({ ref, bytes }) =>
					!sameRef(ref, oldTrust.ref) && !new Set(["drp-creator-author-settlement-state","drp-creator-issuance-retirement-state","drp-creator-author-issuance-frontiers-state"]).has(String(canonicalRecord(bytes)?.kind))
			),
			...proof,
		].sort((a, b) => a.ref.digest.localeCompare(b.ref.digest));
		const owner = Object.freeze({});
		let facts: SealedAdoptionFacts = Object.freeze({
			origin: "received",
			receivedCandidates: Object.freeze(proposedCandidates),
			...(proofAccounting === undefined ? {} : { proofAccounting }),
			receivedCandidateGenerationId: certificate.candidateGenerationId,
			receivedCandidateClosureDigest: certificate.candidateClosureDigest,
			transition: {
				cutValueRef: (proof[0] as (typeof proof)[number]).ref,
				commitQcRef: (proof[1] as (typeof proof)[number]).ref,
				successorTrustRef: (proof[2] as (typeof proof)[number]).ref,
				currentTrustRef: oldTrust.ref,
				epoch: previous.epoch,
				successorEpoch: next.epoch,
				successorAnchorDigest: next.currentAnchorDigest,
			},
			currentHead: reader.head,
			currentReferences: native.closure,
			currentTrust: checkpoint.predecessorTrust,
			durableReplay: replay,
			exactCanonicalLatchedAclBytes: oldAcl,
			exactCanonicalParametersCarrierBytes: input.exactCanonicalParametersCarrierBytes,
			exactCanonicalPinnedGenesisBootstrapOperationBytes: input.exactCanonicalPinnedGenesisBootstrapOperationBytes,
			history: {
				historyRoot: hex(accumulator.root()),
				historySize: accumulator.size,
				historySnapshot: accumulator.snapshot(),
			},
			issuanceScope: { objectId: previous.objectId, author: input.author },
			issuanceStore: input.issuanceStore,
			liveJournalStore: input.liveJournalStore,
			objectId: parsed.value,
			proposedHead: reader.head,
			proposedReferences: proposedCandidates.map(({ ref }) => ref),
			snapshotDeclaration: observation.declaration,
			snapshotStore: input.snapshotStore,
			store: input.store,
			terminalizeSource: (): Promise<boolean> => {
				revokeCreatorAdoptionFacts(owner);
				return Promise.resolve(true);
			},
		});
		if (promoted) {
			const chain = verifyChain(facts, { currentCandidates: current, proposedCandidates }, false);
			const snapshot = chain === undefined ? undefined : await verifySnapshot(facts, chain, proofAccounting);
			if (snapshot === undefined) throw new TypeError("creator retained promotion truthful close is invalid");
			promotionSource = await acquireCreatorReceivedPromotion({
				store: input.store, snapshotStore: input.snapshotStore, catalog: input.catalog,
				expectedHead: nativeHead, currentGenerationId: native.generationId,
				currentTrust: checkpoint.predecessorTrust, successorTrust: checkpoint.currentTrust,
				exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
				detachedGenesisSignature: input.detachedSignature,
				receivedProposal: { closure: { candidates: proposedCandidates, closure: facts.proposedReferences },
					currentCloseSnapshot: { exactCanonicalManifestBytes: observation.declaration.exactCanonicalManifestBytes,
						exactCanonicalPayloadBytes: snapshot.exactCanonicalPayloadBytes } },
			}, proofAccounting);
			facts = Object.freeze({ ...facts, promotion: {
				verified: promotionSource.promotion, source: promotionSource,
				closedEpoch: promotionSource.source.closedEpoch,
			}, certifiedRecoverySourceGenerations: promotionSource.supportGenerations,
			classifiedRecoverySourceGenerations: Object.freeze([]) });
		}
		if (!installCreatorAdoptionFacts(owner, facts))
			throw new TypeError("creator retained recovery provenance conflicts");
		const verified = await verifyCreatorSuccessorAdoption({ handle: owner, catalog: input.catalog });
		if (!verified.ok || !(await reader.checkCurrency()).ok || !(await replay.verify())) {
			revokeCreatorAdoptionFacts(owner);
			throw new TypeError("creator retained recovery authenticated adoption failed");
		}
		const finalCustody = await input.snapshotStore.lookupReceivedRecoveryCertificate({
			objectId: previous.objectId,
			epoch: previous.epoch,
			anchor: previous.currentAnchorDigest,
		});
		if (proofAccounting !== undefined && !proofAccounting.charge(encodeCanonical(finalCustody)))
			throw new TypeError("creator retained recovery certificate readback proof capacity refused");
		if (
			finalCustody === null ||
			finalCustody.incarnation !== retained.incarnation ||
			!sameBytes(finalCustody.exactReceivedCertificateBytes, retained.exactReceivedCertificateBytes)
		) {
			revokeCreatorAdoptionFacts(owner);
			throw new TypeError("creator retained recovery snapshot incarnation changed");
		}
		promotionTransferred = true;
		return Object.freeze({ head: next, received: Object.freeze({ handle: owner, verified,
			...(promotionSource === undefined ? {} : { releasePromotionDependencies: promotionSource.release }),
		}) });
	} catch (error) {
		primary = error;
		failed = true;
		throw error;
	} finally {
		const joined = await Promise.allSettled([
			Promise.resolve().then(() => releaseCreatorRecoveryReader(readerReleased ? undefined : reader, false, undefined,
				"creator retained recovery reader cleanup failed")),
			Promise.resolve().then(() => promotionTransferred ? undefined : promotionSource?.release()),
			...candidatePromotionDependencies.map((source) => Promise.resolve().then(() => source.release())),
		]);
		const errors = joined.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
		if (errors.length > 0) {
			try { await promotionSource?.release(); }
			catch (error) { errors.push(error); }
			throw new AggregateError(failed ? [primary, ...errors] : errors,
				"creator retained promotion cleanup failed", failed ? { cause: primary } : undefined);
		}
	}
}

async function applyCreatorPendingNativeFuture(
	store: AheBoundedRecoveryRoleStore,
	snapshotStore: Pick<SnapshotRecoveryStore<SnapshotVerificationReceipt>, "recoveryStatus">,
	objectId: StorageObjectId,
	capability: CreatorAdoptionIntent,
	phase: "stage" | "publish",
	accounting?: SealedAdoptionFacts["proofAccounting"]
): Promise<void> {
	if (store.acquireRetirementControl === undefined) throw new TypeError("creator pending native future owner is unavailable");
	const acquired = await store.acquireRetirementControl(objectId);
	if (!acquired.ok) throw new TypeError(`creator pending native ${phase} observation refused`);
	let failed = false, primary: unknown;
	try {
		if (phase === "publish" && (await readCreatorPendingRecoveryStatus(snapshotStore, accounting)).migration !== "ready")
			throw new TypeError("creator pending native publication requires ready inherited custody");
		const result = phase === "stage" ? await acquired.value.stageNominatedFutureGeneration(capability) :
			await acquired.value.publishNominatedFutureGeneration(capability);
		if (result.ok && accounting !== undefined && !accounting.charge(encodeCanonical(result.value)))
			throw new TypeError(`creator pending native ${phase} proof capacity refused`);
		if (!result.ok) throw new TypeError(`creator pending native ${phase} refused:${result.reason}`);
	} catch (error) { failed = true; primary = error; }
	try { await acquired.value.release(); }
	catch (cleanup) {
		throw new AggregateError(failed ? [primary, cleanup] : [cleanup], "creator pending native future cleanup failed",
			failed ? {cause: primary} : undefined);
	}
	if (failed) throw primary;
}

async function readCreatorPendingRecoveryStatus(
	store: Pick<SnapshotRecoveryStore<SnapshotVerificationReceipt>, "recoveryStatus">,
	accounting?: SealedAdoptionFacts["proofAccounting"]
): Promise<Awaited<ReturnType<typeof store.recoveryStatus>>> {
	const status = await store.recoveryStatus();
	if (accounting !== undefined && !accounting.charge(encodeCanonical(status)))
		throw new TypeError("creator pending recovery readiness proof capacity refused");
	return status;
}

async function recoverPendingCreatorSuccessorMaterial(
	input: CreatorAdoptionPendingRecoveryInput
): Promise<CreatorAdoptionPendingRecoveryResult> {
	let reader: AheBoundedRecoveryRoleRead | undefined;
	let primary: unknown;
	let failed = false;
	const promotionDependencies: NonNullable<CreatorSuccessorLiveMaterial["promotionDependencies"]>[] = [];
	try {
		const expectedPrevious = exactRoomHead(input.expectedPreviousRoomHead);
		const expectedNext = exactRoomHead(input.expectedNextRoomHead);
		if (
			input.authenticationProfile !== "creator-only" ||
			expectedPrevious === undefined ||
			expectedNext === undefined
		) {
			return pendingRecoveryFailure("chain-invalid", "creator pending room-head input is invalid");
		}
		const parsedObjectId = parseStorageObjectId(expectedPrevious.objectId);
		if (
			!parsedObjectId.ok ||
			expectedPrevious.objectId !== parsedObjectId.value ||
			expectedNext.objectId !== parsedObjectId.value ||
			expectedNext.epoch !== expectedPrevious.epoch + 1
		) {
			return pendingRecoveryFailure("chain-invalid", "creator pending room-head input is invalid");
		}
		const objectId = parsedObjectId.value;
		if (input.proofAccounting !== undefined && (!input.proofAccounting.charge(input.exactCanonicalAnchorPreimageBytes) ||
			!input.proofAccounting.charge(input.detachedSignature) || !input.proofAccounting.charge(input.exactCanonicalParametersCarrierBytes)))
			return pendingRecoveryFailure("storage-failed", "creator pending pinned authentication proof capacity refused");
		const migrationStatus = await readCreatorPendingRecoveryStatus(input.snapshotStore, input.proofAccounting);
		if (migrationStatus.migration !== "ready" && input.classificationOwners === undefined)
			return pendingRecoveryFailure("snapshot-migration-required", "creator pending publication requires authenticated inherited classification");
		reader = await acquireCreatorRecoveryCensus(input.store, objectId, input.proofAccounting);
		if (reader.head.kind !== "present") {
			return pendingRecoveryFailure("storage-failed", "creator pending durable state is unavailable");
		}
		const durableHead = reader.head;
		const lineage = reader.generations;
		const capturedReader = reader;
		const readClosure = (
			references: readonly GenerationRef[]
		): Promise<RecoveredClosure["currentCandidates"] | undefined> =>
			Promise.resolve(recoveryCensusClosure(capturedReader, references));
		const custody = await readReceivedCustody(input, expectedPrevious);
		const candidates: AuthenticatedPendingCandidate[] = [];
		for (const generation of lineage) {
			const candidate = await authenticatePendingCandidate(
				input,
				lineage,
				generation,
				expectedPrevious,
				expectedNext,
				objectId,
				readClosure
			);
			if (candidate?.promotionDependencies !== undefined)
				promotionDependencies.push(candidate.promotionDependencies);
			if (candidate !== undefined) {
				await authenticateReceivedCandidateCustody(input, custody, candidate.receivedContext, durableHead);
				candidates.push(candidate);
			}
		}
		if (candidates.length === 0) {
			return pendingRecoveryFailure("pending-missing", "creator pending successor is unavailable");
		}
		const closureDigests = new Set(candidates.map(({ closureDigest }) => closureDigest));
		if (closureDigests.size !== 1) {
			return pendingRecoveryFailure("true-fork", "creator pending successors disagree");
		}
		if (!(await reader.checkCurrency()).ok)
			return pendingRecoveryFailure("storage-failed", "creator pending native census changed");
		if (migrationStatus.migration !== "ready") {
			const owners = input.classificationOwners;
			if (owners === undefined || input.issuanceStore === undefined || input.liveJournalStore === undefined)
				return pendingRecoveryFailure("snapshot-migration-required", "creator pending native classification owners are unavailable");
			const issuanceStore = input.issuanceStore;
			const liveJournalStore = input.liveJournalStore;
			const firstCandidate = candidates[0];
			if (firstCandidate === undefined) return pendingRecoveryFailure("pending-missing", "creator pending authenticated candidate is unavailable");
			const context = firstCandidate.receivedContext;
			const trust = uniqueCandidateByKind(context.currentCandidates, "drp-anchor-trust-state");
			const projection = uniqueCandidateByKind(context.currentCandidates, context.chain.currentProjectionKind);
			if (trust === undefined || projection === undefined) return pendingRecoveryFailure("chain-invalid", "creator pending source material is unavailable");
			const captureHold = () => acquireCreatorPendingClassificationCustody({generation: {
				candidates: context.currentCandidates, references: context.currentGeneration.closure, head: context.currentHead,
				trust: context.predecessorTrust, trustRef: trust.ref,
				exactCanonicalAnchorPreimageBytes: context.chain.currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array,
				detachedAnchorSignature: context.chain.currentTrustRecord.detachedCurrentAnchorSignature as Uint8Array,
				exactCanonicalProjectionBytes: projection.bytes}, expectedNativeHead: durableHead,
				catalog: input.catalog, exactCanonicalParametersCarrierBytes: input.exactCanonicalParametersCarrierBytes,
				pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest, store: input.store,
				exactCanonicalLatchedAclBytes: context.predecessorAclBytes, issuanceStore,
				liveJournalStore, owners});
			await releaseCreatorRecoveryReader(reader, false, undefined, "creator pending preclassification census cleanup failed"); reader = undefined;
			const releases = await Promise.allSettled(promotionDependencies.splice(0).map(dependency => Promise.resolve().then(() => dependency.release())));
			const failures = releases.flatMap(result => result.status === "rejected" ? [result.reason] : []);
			if (failures.length) throw new AggregateError(failures, "creator pending preclassification dependencies failed to join");
			const value = {objectId, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
					exactCanonicalPinnedGenesisTrustStateRecordBytes: owners.exactCanonicalPinnedGenesisTrustStateRecordBytes,
					roomHeadAuthority: owners.roomHeadAuthority, catalog: input.catalog, store: input.store,
					snapshotStore: input.snapshotStore, liveJournalStore: input.liveJournalStore};
			// At most apply plus fresh SAME-intent confirmation. Each pass has a
			// fresh native census/actor; joined read custody ends before own writes.
			for (let pass = 0; pass < 2; pass++) {
				const sealed = await captureHold();
				if (sealed === undefined) return pendingRecoveryFailure("snapshot-migration-required", "creator pending native dependencies are unresolved");
				const lifetime = resolveCreatorSnapshotRecoveryCloseHold(sealed.hold, {store: input.store,
					liveJournalStore: input.liveJournalStore, currentTrust: context.predecessorTrust});
				try {
					if (lifetime === undefined) throw new TypeError("creator pending classification custody is unavailable");
					await reconcileCreatorSnapshotRecoveryRoles(value, sealed.hold);
				} finally {
					const joined = await Promise.allSettled([Promise.resolve().then(() => lifetime?.release()), Promise.resolve().then(() => sealed.stop())]);
					const errors = joined.flatMap(result => result.status === "rejected" ? [result.reason] : []);
					if (errors.length) throw new AggregateError(errors, "creator pending classification owners failed to join");
				}
				if ((await readCreatorPendingRecoveryStatus(input.snapshotStore, input.proofAccounting)).migration === "ready") break;
			}
			if ((await readCreatorPendingRecoveryStatus(input.snapshotStore, input.proofAccounting)).migration !== "ready")
				return pendingRecoveryFailure("snapshot-migration-required", "creator pending inherited debt remains held");
			// Ports are removed: a concurrent new held state refuses, never loops
			// another classification. Fresh original authentication owns publication.
			const {classificationOwners: _owners, ...freshInput} = input;
			return recoverPendingCreatorSuccessorMaterial(freshInput);
		}
		const alreadyActive = candidates.find(({ head }) => sameHead(head, durableHead));
		if (alreadyActive !== undefined) {
			await alreadyActive.promotionDependencies?.checkSnapshots();
			if ((await readCreatorPendingRecoveryStatus(input.snapshotStore, input.proofAccounting)).migration !== "ready")
				return pendingRecoveryFailure("snapshot-migration-required", "creator pending delivery requires ready inherited custody");
			return Object.freeze({
				head: Object.freeze({ ...expectedNext }),
				lifecycle: "successor-published" as const,
				ok: true as const,
				recovery: "active-new" as const,
			});
		}
		let selected = [...candidates].sort((left, right) =>
			left.generation.generationId < right.generation.generationId
				? -1
				: left.generation.generationId > right.generation.generationId
					? 1
					: 0
		)[0] as AuthenticatedPendingCandidate;
		const previous = presentBase(selected.generation);
		if (previous === undefined || !sameHead(previous, durableHead)) {
			return pendingRecoveryFailure("stale-head", "creator pending head is stale");
		}
		await selected.promotionDependencies?.checkSnapshots();
		if ((await readCreatorPendingRecoveryStatus(input.snapshotStore, input.proofAccounting)).migration !== "ready")
			return pendingRecoveryFailure("snapshot-migration-required", "creator pending publication requires ready inherited custody");
		const nativeStore = input.store as AheBoundedRecoveryRoleStore;
		const retirement = nativeStore.readRetirementControl === undefined ? undefined : await nativeStore.readRetirementControl(objectId);
		if (retirement?.ok && input.proofAccounting !== undefined && !input.proofAccounting.charge(encodeCanonical(retirement.value)))
			return pendingRecoveryFailure("storage-failed", "creator pending retirement control proof capacity refused");
		if (retirement !== undefined && !retirement.ok)
			return pendingRecoveryFailure("storage-failed", "creator pending retirement metadata is unavailable");
		let nativeFuture: CreatorAdoptionIntent | undefined;
		if (retirement?.ok && retirement.value?.completed != null) {
			// A completed floor rejects raw head writes. Reuse the original future
			// owner with a truthful sibling, not an exception for an occupied row.
			// Occupied received custody keeps its exact authenticated generation;
			// nominate that Complete row rather than retargeting its certificate.
			if (nativeStore.acquireRetirementControl === undefined)
				return pendingRecoveryFailure("storage-failed", "creator pending native nominee custody is unavailable");
			const nominee = retirement.value.nominee;
			let successorGenerationId: GenerationId;
			if (nominee != null) {
				const existing = candidates.find(candidate => candidate.generation.generationId === nominee.generationId);
				if (existing === undefined || existing.closureDigest !== selected.closureDigest)
					return pendingRecoveryFailure("chain-invalid", "creator pending native nominee differs");
				selected = existing;
				successorGenerationId = nominee.generationId;
			} else if (custody !== null) {
				const exact = candidates.find(candidate => candidate.generation.generationId === custody.certificate.candidateGenerationId);
				if (exact === undefined || exact.closureDigest !== custody.certificate.candidateClosureDigest)
					return pendingRecoveryFailure("chain-invalid", "creator pending received candidate differs");
				selected = exact;
				successorGenerationId = exact.generation.generationId;
			} else {
				const bytes = new Uint8Array(32);
				crypto.getRandomValues(bytes);
				const parsed = parseGenerationId(hex(bytes));
				if (!parsed.ok) return pendingRecoveryFailure("storage-failed", "creator pending nominee identity is unavailable");
				successorGenerationId = parsed.value;
			}
			nativeFuture = createCreatorAuthenticatedNativeFuture({owner: selected.receivedContext, store: input.store,
				successorTrust: selected.receivedContext.chain.successorTrust, currentHead: previous,
				generationId: successorGenerationId, acceptedClosure: selected.generation.closure, newBlobs: [],
				...(custody === null ? {} : {existingCompleteGeneration: selected.generation})});
			await releaseCreatorRecoveryReader(reader, false, undefined, "creator pending nomination census cleanup failed");
			reader = undefined;
			const joined = await Promise.allSettled(promotionDependencies.splice(0).map(source => Promise.resolve().then(() => source.release())));
			const errors = joined.flatMap(result => result.status === "rejected" ? [result.reason] : []);
			if (errors.length) throw new AggregateError(errors, "creator pending nomination dependencies failed to join");
			await applyCreatorPendingNativeFuture(nativeStore, input.snapshotStore, objectId, nativeFuture, "stage", input.proofAccounting);
			// Native staging is not authentication. Reopen the original census and
			// verify this exact sibling through the same candidate/received owners.
			reader = await acquireCreatorRecoveryCensus(input.store, objectId, input.proofAccounting);
			const sibling = reader.generations.find(generation => generation.generationId === successorGenerationId);
			const captured = reader;
			const authenticated = sibling === undefined ? undefined : await authenticatePendingCandidate(input,
				reader.generations, sibling, expectedPrevious, expectedNext, objectId,
				closure => Promise.resolve(recoveryCensusClosure(captured, closure)));
			if (authenticated?.promotionDependencies !== undefined) promotionDependencies.push(authenticated.promotionDependencies);
			if (authenticated === undefined || authenticated.closureDigest !== selected.closureDigest || reader.head.kind !== "present" ||
				!sameHead(reader.head, previous) || !(await reader.checkCurrency()).ok)
				return pendingRecoveryFailure("chain-invalid", "creator pending native sibling authentication failed");
			await authenticateReceivedCandidateCustody(input, await readReceivedCustody(input, expectedPrevious), authenticated.receivedContext, previous);
			selected = authenticated;
			await selected.promotionDependencies?.checkSnapshots();
			if ((await readCreatorPendingRecoveryStatus(input.snapshotStore, input.proofAccounting)).migration !== "ready")
				return pendingRecoveryFailure("snapshot-migration-required", "creator pending publication requires ready inherited custody");
			await releaseCreatorRecoveryReader(reader, false, undefined, "creator pending publication census cleanup failed"); reader = undefined;
			const released = await Promise.allSettled(promotionDependencies.splice(0).map(source => Promise.resolve().then(() => source.release())));
			const failures = released.flatMap(result => result.status === "rejected" ? [result.reason] : []);
			if (failures.length) throw new AggregateError(failures, "creator pending publication dependencies failed to join");
		}
		if ((await readCreatorPendingRecoveryStatus(input.snapshotStore, input.proofAccounting)).migration !== "ready")
			return pendingRecoveryFailure("snapshot-migration-required", "creator pending publication requires ready inherited custody");
		try {
			if (nativeFuture !== undefined) {
				await applyCreatorPendingNativeFuture(nativeStore, input.snapshotStore, objectId, nativeFuture, "publish", input.proofAccounting);
			} else {
				const swapped = await input.store.swapHead({ expectedHead: previous,
					generationId: selected.generation.generationId, objectId });
				if (swapped.ok && input.proofAccounting !== undefined && !input.proofAccounting.charge(encodeCanonical(swapped.value)))
					throw new TypeError("creator pending head CAS readback proof capacity refused");
			}
		} catch (error) {
			if (nativeFuture !== undefined && error instanceof AggregateError) throw error;
			// The authenticated reread below is the only authority after an ambiguous CAS.
		}
		const published = await acquireCreatorRecoveryCensus(input.store, objectId, input.proofAccounting);
		try {
			const generation = published.generations.find(row => row.generationId === selected.generation.generationId);
			const authenticated = generation === undefined ? undefined : await authenticatePendingCandidate(input,
				published.generations, generation, expectedPrevious, expectedNext, objectId,
				closure => Promise.resolve(recoveryCensusClosure(published, closure)));
			if (authenticated?.promotionDependencies !== undefined) promotionDependencies.push(authenticated.promotionDependencies);
			await authenticated?.promotionDependencies?.checkSnapshots();
			if (
				authenticated === undefined ||
				published.head.kind !== "present" ||
				!sameHead(selected.head, published.head) ||
				!(await published.checkCurrency()).ok
			)
				return pendingRecoveryFailure("pending-old", "creator pending successor remains unpublished");
			await authenticateReceivedCandidateCustody(input, await readReceivedCustody(input, expectedPrevious), authenticated.receivedContext, published.head);
		} finally {
			await published.release();
		}
		if ((await readCreatorPendingRecoveryStatus(input.snapshotStore, input.proofAccounting)).migration !== "ready")
			return pendingRecoveryFailure("snapshot-migration-required", "creator pending readback requires ready inherited custody");
		return Object.freeze({
			head: Object.freeze({ ...expectedNext }),
			lifecycle: "successor-published" as const,
			ok: true as const,
			recovery: "active-new" as const,
		});
	} catch (error) {
		primary = error;
		failed = true;
		return Object.freeze({
			...pendingRecoveryFailure("internal-invariant", "creator pending recovery failed unexpectedly"),
			cause: error,
		});
	} finally {
		const joined = await Promise.allSettled([
			Promise.resolve().then(() => releaseCreatorRecoveryReader(reader, false, undefined,
				"creator pending recovery reader cleanup failed")),
			...promotionDependencies.map((source) => Promise.resolve().then(() => source.release())),
		]);
		const errors = joined.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
		if (errors.length > 0) throw new AggregateError(failed ? [primary, ...errors] : errors,
			"creator pending promotion cleanup failed", failed ? { cause: primary } : undefined);
	}
}

if (!installCreatorSuccessorReopen(reopenCreatorSuccessorMaterial)) {
	throw new TypeError("creator successor reopen owner was already installed");
}
if (!installCreatorAdoptionPendingRecovery(recoverPendingCreatorSuccessorMaterial)) {
	throw new TypeError("creator adoption pending recovery owner was already installed");
}
