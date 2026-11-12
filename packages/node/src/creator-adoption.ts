import type { ResolvedBlueprintBytes, TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type CloseSetHistoryCommitment, CompactMerkleAccumulator } from "@ts-drp/compaction";
import { verifySnapshotStreamWithReceipt } from "@ts-drp/compaction/snapshot-quarantine-receipt";
import { copySettlementPlan, type DurableIssuanceStore, type DurableIssueScope } from "@ts-drp/issuance-store";
import {
	durableIssuancePruningMaintenanceForStore,
	ISSUANCE_RETIREMENT_LIMITS,
	issuanceRetirementFloor,
} from "@ts-drp/issuance-store/maintenance";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { type CurrentAnchorTrust, openCurrentAnchorTrust, type SignRegisteredVertexDigest } from "@ts-drp/protocol-v3";
import type { OwnedIdentityChallengeAdmission, OwnedSigningRequest } from "@ts-drp/protocol-v3/internal/owned-signing-request";
import { openCreatorSettlementSourceTrust, readCreatorSettlementSourceAnchor } from "@ts-drp/protocol-v3/internal/received-vertex-authentication";
import { createCreatorSigningRecoveryOwner } from "@ts-drp/seal/creator";
import { CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES } from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import { CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES } from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import { CREATOR_ISSUANCE_RETIREMENT_MAX_RECORD_BYTES } from "@ts-drp/protocol-v3/creator-issuance-retirement";
import {
	CREATOR_REATTACHMENT_CHECKPOINT_MAX_BYTES,
	decodeCreatorReattachmentCheckpoint,
	encodeCreatorReattachmentCheckpoint,
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
import { authorizeLatchedApplicationWrite, openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
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
import { runInBackgroundLane } from "./internal/cooperative-work.js";
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
	CREATOR_CLOSE_MEMBERSHIP_MAX_BYTES,
	openCreatorCloseMembership,
	rewriteCreatorCloseMembershipWitnesses,
} from "./internal/creator-close-membership.js";
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
import { openCreatorSourceCustody, resolveCreatorSourceCustody } from "./internal/creator-source-custody.js";
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
	captureCreatorSuccessorDepartedCarrier,
	type CreatorSuccessorDepartedCarrier,
	type CreatorSuccessorDepartedScope,
	receiveCreatorSuccessorDepartedCarrier,
	receiveCreatorSuccessorMaterial,
} from "./internal/creator-successor-transport.js";
import {
	type CreatorTransitionClosure,
	inspectCreatorAdoptionCandidateLineage,
	inspectCreatorCheckpointTransition,
	inspectCreatorTransitionAdvance,
	openCreatorCheckpointAttachment,
	openVerifiedCreatorHistoricalIssuance,
	resolveCreatorCheckpointAttachment,
	resolveCreatorForwardPromotion,
	resolveVerifiedCreatorHistoricalIssuance,
	uniqueCreatorTransitionCandidate,
	type VerifiedCreatorForwardPromotion,
	type VerifiedCreatorCheckpointAttachment,
} from "./internal/creator-transition-advance.js";
import { createV3SnapshotTransferOwner } from "./snapshot-transfer.js";
import { CreatorRecoveryHoldUnavailable, sealCreatorReceivedRecoveryReplay, type V3PlaneHandle, V3LocalLineageBehindFrontier } from "./v3-live.js";
import { reconcileCreatorReceivedSnapshotRecoveryRoles, reconcileCreatorSnapshotRecoveryRoles } from "./internal/creator-closed-rollback-data.js";
import { acquireCreatorPendingClassificationCustody, resolveCreatorSnapshotRecoveryCloseHold } from "./internal/runtime-reclamation.js";
import type { CreatorRecoveryPoolResult } from "./internal/creator-recovery-pool.js";

export {
	captureCreatorSuccessorPeers,
	createCreatorSuccessorMaterialServer,
	consumeOwnedCreatorTransportSigningRequest,
	type CreatorSuccessorDepartedCarrier,
	type CreatorSuccessorDepartedScope,
} from "./internal/creator-successor-transport.js";

/**
 * The departed-scope carrier an export supplies (fix/skip-scope-carrier): the scope its Cut closes
 * and the Cut, QC, successor trust record and closed membership a member skipping past that epoch
 * needs to retire it. Undefined when the export carries no membership (a sparse close).
 * @param exported - A creator successor export.
 * @returns The scope and its carrier, or undefined.
 */
export function creatorSuccessorDepartedCarrierOf(exported: CreatorSuccessorExport):
	Readonly<{ scope: CreatorSuccessorDepartedScope; carrier: CreatorSuccessorDepartedCarrier }> | undefined {
	const cut = canonicalRecord(exported.offer.exactCanonicalCutValueBytes);
	if (cut === undefined || typeof cut.epoch !== "number" || typeof cut.previousAnchor !== "string") return undefined;
	const carrier = captureCreatorSuccessorDepartedCarrier({
		exactCanonicalCutValueBytes: exported.offer.exactCanonicalCutValueBytes,
		exactCanonicalCommitQcBytes: exported.offer.exactCanonicalCommitQcBytes,
		exactCanonicalTrustStateRecordBytes: exported.offer.exactCanonicalTrustStateRecordBytes,
		exactCanonicalCloseMembershipBytes: exported.material.exactCanonicalCloseMembershipBytes,
	});
	return carrier === undefined ? undefined
		: Object.freeze({ scope: Object.freeze({ epoch: cut.epoch, anchorDigest: cut.previousAnchor }), carrier });
}

/**
 * fix/skip-scope-carrier: one past close's departed-scope carrier, rebuilt from durable state when
 * the creator's in-memory list misses it (a restarted creator). The Cut, its commit QC and the
 * successor trust record come from a native generation the store still retains (the recovery
 * census), Adopted or Superseded only: a close whose successor this creator adopted, never one it
 * may still abandon. The closed membership comes from this creator's journal, read exactly as the
 * successor export reads it. Undefined when that close is no longer retained or its membership is
 * absent; a miss leaves the member's departed scope with today's retention.
 * @param input - The room's native store and journal, and the departed scope.
 * @returns The carrier, or undefined.
 */
export async function readCreatorSuccessorDepartedCarrier(input: Readonly<{
	store: AheDurableStore;
	journalStore?: DurableLiveJournalStore;
	objectId: StorageObjectId;
	pinnedGenesisAnchorDigest: string;
	scope: CreatorSuccessorDepartedScope;
}>): Promise<CreatorSuccessorDepartedCarrier | undefined> {
	const journalStore = input.journalStore;
	if (journalStore?.readClosedMembership === undefined) return undefined;
	const close = await withCreatorRecoveryCensus(input.store, input.objectId, async (reader) => {
		for (const generation of reader.generations) {
			if (generation.state !== "Adopted" && generation.state !== "Superseded") continue;
			const candidates = recoveryCensusClosure(reader, generation.closure);
			if (candidates === undefined) continue;
			const cut = uniqueCandidateByKind(candidates, "drp-hard-epoch-cut");
			const qc = uniqueCandidateByKind(candidates, "drp-seal-qc");
			const trust = uniqueCandidateByKind(candidates, "drp-anchor-trust-state");
			if (cut === undefined || qc === undefined || trust === undefined) continue;
			if (cut.record.epoch !== input.scope.epoch || cut.record.previousAnchor !== input.scope.anchorDigest ||
				trust.record.genesisAnchorDigest !== input.pinnedGenesisAnchorDigest ||
				trust.record.currentEpoch !== input.scope.epoch + 1) continue;
			return Object.freeze({ cut, qc, trust });
		}
		return undefined;
	});
	const parameters = close?.cut.record.parameters as Readonly<{ maxEpochVertices?: unknown }> | undefined;
	if (close === undefined || typeof parameters?.maxEpochVertices !== "number") return undefined;
	const observed = await journalStore.readClosedMembership({
		scope: { objectId: input.objectId, epoch: input.scope.epoch, anchorDigest: input.scope.anchorDigest },
		maxBytes: CREATOR_CLOSE_MEMBERSHIP_MAX_BYTES,
	});
	if (!observed.ok || observed.kind === "missing") return undefined;
	const membership = await rewriteCreatorCloseMembershipWitnesses({
		bytes: observed.exactCanonicalMembershipBytes, exactCanonicalCutValueBytes: close.cut.bytes,
		maxEpochVertices: parameters.maxEpochVertices, localVertexWitnesses: [],
	});
	return captureCreatorSuccessorDepartedCarrier({
		exactCanonicalCutValueBytes: close.cut.bytes,
		exactCanonicalCommitQcBytes: close.qc.bytes,
		exactCanonicalTrustStateRecordBytes: close.trust.bytes,
		exactCanonicalCloseMembershipBytes: membership,
	});
}

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
	readonly kind: "creator-received-recovery-certificate-1" | "creator-received-checkpoint-certificate-1";
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
	readonly exactCanonicalReattachmentCheckpointBytes?: Uint8Array;
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
const CHECKPOINT_RECEIVED_CERTIFICATE_KEYS=Object.freeze([...RECEIVED_CERTIFICATE_KEYS,"exactCanonicalReattachmentCheckpointBytes"]);

function encodeReceivedCertificate(value: ReceivedCertificate): Uint8Array {
	return encodeCanonical(value, {
		maxBytes: SNAPSHOT_RECEIVED_CERTIFICATE_MAX_BYTES,
		maxDepth: 2,
		maxItems: value.exactCanonicalSettlementBytes === null || value.kind === "creator-received-checkpoint-certificate-1"
			? NONE_RECEIVED_CERTIFICATE_MAX_ITEMS : RECEIVED_CERTIFICATE_MAX_ITEMS,
	});
}

/** Internal syntax owner only; parsing never authenticates replay or grants adoption. */
export function openReceivedCertificate(bytes: Uint8Array): ReceivedCertificate {
	const decoded=decodeCanonical(bytes, {
			maxBytes: SNAPSHOT_RECEIVED_CERTIFICATE_MAX_BYTES,
			maxDepth: 2,
			maxItems: NONE_RECEIVED_CERTIFICATE_MAX_ITEMS,
		});
	const value=capturePromotionRecord(decoded,RECEIVED_CERTIFICATE_KEYS) ?? capturePromotionRecord(decoded,NONE_RECEIVED_CERTIFICATE_KEYS) ??
		capturePromotionRecord(decoded,CHECKPOINT_RECEIVED_CERTIFICATE_KEYS);
	const checkpoint = value?.kind === "creator-received-checkpoint-certificate-1";
	if (value === undefined || (value.kind !== "creator-received-recovery-certificate-1" && !checkpoint) ||
		checkpoint !== Object.hasOwn(value, "exactCanonicalReattachmentCheckpointBytes") ||
		(checkpoint && value.exactCanonicalSettlementBytes === null))
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
	if (checkpoint) {
		const bytes = capturePromotionBytes(value.exactCanonicalReattachmentCheckpointBytes, CREATOR_REATTACHMENT_CHECKPOINT_MAX_BYTES);
		if (bytes === undefined || decodeCreatorReattachmentCheckpoint(bytes) === undefined)
			throw new TypeError("creator received checkpoint carrier is invalid");
		carriers.exactCanonicalReattachmentCheckpointBytes = bytes;
	}
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
	const exported = await readCreatorSuccessorExportWithoutMembership(input);
	if (input.journalStore?.readClosedMembership === undefined) return exported;
	const cut = canonicalRecord(exported.offer.exactCanonicalCutValueBytes);
	const parameters = cut?.parameters as Readonly<{ maxEpochVertices: number }> | undefined;
	if (cut === undefined || parameters === undefined || typeof cut.epoch !== "number" || typeof cut.previousAnchor !== "string")
		throw new TypeError("creator successor membership Cut is invalid");
	const observed = await input.journalStore.readClosedMembership({
		scope: {objectId: input.objectId, epoch: cut.epoch, anchorDigest: cut.previousAnchor},
		maxBytes: CREATOR_CLOSE_MEMBERSHIP_MAX_BYTES,
	});
	if (!observed.ok) throw new TypeError(`creator successor membership read refused: ${observed.kind}`);
	// Prior valid installs can lack this optional evidence when their graph was
	// sparse. Keep their original export usable; absence grants no collection.
	if (observed.kind === "missing") return exported;
	const membership = observed.exactCanonicalMembershipBytes;
	const accounting = input.archiveRecovery?.accounting;
	if (accounting !== undefined && !accounting.charge(membership))
		throw new TypeError("creator successor membership proof charge is exhausted");
	const bytes = await rewriteCreatorCloseMembershipWitnesses({
		bytes: membership, exactCanonicalCutValueBytes: exported.offer.exactCanonicalCutValueBytes,
		maxEpochVertices: parameters.maxEpochVertices, localVertexWitnesses: [],
	});
	if (accounting !== undefined && !accounting.charge(bytes))
		throw new TypeError("creator successor membership transfer charge is exhausted");
	return Object.freeze({ ...exported,
		material: Object.freeze({ ...exported.material, exactCanonicalCloseMembershipBytes: bytes }),
	});
}

async function readCreatorSuccessorExportWithoutMembership(input: CreatorSuccessorExportInput): Promise<CreatorSuccessorExport> {
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
		/** Supplies complete signed-cut membership even if the recipient missed members. */
		journalStore?: DurableLiveJournalStore;
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

interface LocalClosedAdoptionEvidence {
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
		checkFloor(): Promise<void>; captureClosed?(facts: LocalClosedAdoptionEvidence): void }>
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
		if (recovery?.captureClosed !== undefined && successorProjection?.record.epoch === trust.record.currentEpoch) {
			// This discovery asks only for an unfinished local close. A live
			// projection has no such intent; its independent cold opener below
			// authenticates the full received checkpoint and native currency.
			throw new CreatorSuccessorExportUnavailable("creator active live projection is not a local closed candidate");
		}
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
		if (predecessor === undefined || predecessorTrustCandidate === undefined) {
			// A head installed from a reattachment checkpoint (an install more than one epoch ahead)
			// holds only the compact point proof of its own transition, never a predecessor generation
			// ("not a second current trust or a native intermediate generation"), so the transition it
			// would serve cannot be re-verified here. It is not a successor-material source: nothing to
			// serve, which every caller already treats as such (startup serving opens and serves nothing).
			// The creator and any adjacent installer still serve; this head's next adjacent install has
			// it as predecessor and is a source again.
			const point = uniqueCandidateByKind(current.candidates, "creator-reattachment-proof-1");
			const pointTrust = point?.record.exactCanonicalPredecessorTrustStateRecordBytes;
			const pointEpoch =
				pointTrust instanceof Uint8Array ? canonicalRecord(pointTrust)?.currentEpoch : undefined;
			if (pointEpoch !== undefined && pointEpoch === cut.record.epoch)
				throw new CreatorSuccessorExportUnavailable(
					"creator successor export from a reattachment checkpoint head is unavailable"
				);
			throw new TypeError("creator successor native predecessor is unavailable");
		}
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
		if (recovery?.captureClosed !== undefined && generation.state === "Adopted" &&
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
		let reattachmentCheckpoint: Uint8Array | undefined;
		// A sealed Q generation still owns its predecessor projection/ACL.
		// The target L installs the just-closed ACL during adoption; only then
		// can this optional point proof be exported alongside ordinary material.
		if (checkpoint.predecessorTrust.currentEpoch >= 1 && settlement !== undefined && !promoted &&
			successorProjection?.record.epoch === checkpoint.currentTrust.currentEpoch) {
			const predecessorAcl = uniqueCandidateByKind(current.candidates, "drp-v3-latched-acl");
			const predecessorSettlement = uniqueCandidateByKind(predecessor, "drp-creator-author-settlement-state");
			if (predecessorAcl === undefined || predecessorSettlement === undefined ||
				predecessorAcl.record.epoch !== checkpoint.predecessorTrust.currentEpoch ||
				hex(hashDomain("ts-drp/latched-acl/v3", predecessorAcl.bytes)) !== chain.currentAnchor.aclDigest)
				throw new TypeError("creator successor native checkpoint companions are unavailable");
			reattachmentCheckpoint = encodeCreatorReattachmentCheckpoint({
				exactCanonicalPredecessorTrustStateRecordBytes: Uint8Array.from(predecessorTrustCandidate.bytes),
				exactCanonicalPredecessorAclBytes: Uint8Array.from(predecessorAcl.bytes),
				exactCanonicalPredecessorSettlementBytes: Uint8Array.from(predecessorSettlement.bytes),
			});
			if (exportAccounting !== undefined && !exportAccounting.charge(reattachmentCheckpoint))
				throw new TypeError("creator successor checkpoint transfer proof charge is exhausted");
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
				...(reattachmentCheckpoint === undefined ? {} : { exactCanonicalReattachmentCheckpointBytes: reattachmentCheckpoint }),
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
	"roomHeadAuthority" | "pinnedGenesisAnchorDigest" | "exactCanonicalPinnedGenesisTrustStateRecordBytes" | "signal"> &
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

/** What a recipient lull's complete received turnover reconciled: the room head, the
 * exact current Cut it classified from, the recovery-role inventory it left (all but
 * the single-use custody) and the member's own settlement plan (its held unresolved
 * work, which the journal classification reads: an abandonment or a settlement
 * resolution rewrites it without moving the head, the Cut or the inventory). Keyed by
 * the live plane handle, so a successor plane, a recovery reopen (including a
 * retirement-halt discharge) and a new session never see it; a lull clears it on entry
 * and an install consumes it. Scheduling only: it lets an install skip a turnover whose
 * every input is unchanged, never grants admission, and a full pool, a promotion, a
 * checkpoint install or a retained scope at the received window's edge never skips. */
type ReceivedTurnoverBoundary = Readonly<{ objectId: string; epoch: number; anchorDigest: string; cut: Uint8Array; inventory: string;
	plan: Uint8Array }>;
const reconciledReceivedTurnovers = new WeakMap<object, ReceivedTurnoverBoundary>();

async function captureReceivedTurnoverBoundary(source: CreatorRecipientSource,
	snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>,
	currentCandidates: Awaited<ReturnType<typeof inspectHead>>["candidates"]): Promise<ReceivedTurnoverBoundary | undefined> {
	const epoch = source.currentTrust.currentEpoch;
	const cut = uniqueCreatorTransitionCandidate(currentCandidates, "drp-hard-epoch-cut", epoch - 1);
	const inventory = await snapshotStore.captureRecoveryRoleInventory?.({objectId: source.objectId});
	if (epoch < 2 || cut === undefined || inventory === undefined || inventory.owner.migration !== "ready" ||
		inventory.owner.recoveryScopes >= inventory.owner.limits.maxRecoveryScopes) return undefined;
	const { custody: _custody, ...observed } = inventory;
	const plan = encodeCanonical(await source.issuanceStore.readSettlementPlan(source.issuanceScope));
	return Object.freeze({objectId: source.objectId, epoch, anchorDigest: source.currentTrust.currentAnchorDigest,
		cut: Uint8Array.from(cut.bytes), inventory: JSON.stringify(observed), plan});
}

function sameReceivedTurnoverBoundary(left: ReceivedTurnoverBoundary, right: ReceivedTurnoverBoundary): boolean {
	return left.objectId === right.objectId && left.epoch === right.epoch && left.anchorDigest === right.anchorDigest &&
		sameBytes(left.cut, right.cut) && left.inventory === right.inventory && sameBytes(left.plan, right.plan);
}

/** The install's own input, which no lull boundary can carry: the received successor
 * takes one slot of the bounded recovery window (AHE_BOUNDED_READ_LIMITS
 * .maxObjectGenerations), so the install's classification authenticates one historical
 * source generation fewer than a lull's at the same head. A closed journal scope at or
 * below the received epoch minus that bound that nothing else protects (the retirement
 * control's protected scopes) loses its header's protection inside the install's
 * turnover, which retires it. While the journal holds one, the install turns over.
 * Observation only; an unavailable read turns over. */
async function receivedWindowEdgeScopeRetained(source: CreatorRecipientSource): Promise<boolean> {
	const edge = source.currentTrust.currentEpoch + 1 - AHE_BOUNDED_READ_LIMITS.maxObjectGenerations;
	if (edge < 1) return false;
	try {
		const read = await source.liveJournalStore.readRetirementImage?.({objectId: source.objectId});
		if (read === undefined || !read.ok) return true;
		const protectedScopes = read.value.control?.completed?.protectedScopes ?? [];
		for (const bytes of read.value.canonicalRows) {
			const frame = decodeCanonical(bytes);
			if (!Array.isArray(frame) || frame[0] !== "scopes") continue;
			const key: unknown = frame[1];
			if (!Array.isArray(key) || typeof key[1] !== "number" || typeof key[2] !== "string") return true;
			const epoch = key[1];
			if (epoch >= 1 && epoch <= edge && !protectedScopes.some(scope =>
				scope.objectId === key[0] && scope.epoch === epoch && scope.anchorDigest === key[2])) return true;
		}
		return false;
	} catch {
		return true;
	}
}

/** The closed journal scopes that still hold accepted entries (the physical replay detail
 * the issuance classification reads: closedIssuanceProtectedRecordsForRetirement keeps an
 * own issued row while its epoch's scope holds any). Observation only; undefined when
 * unreadable. */
async function journalDetailScopes(source: CreatorRecipientSource): Promise<ReadonlySet<string> | undefined> {
	try {
		const read = await source.liveJournalStore.readRetirementImage?.({objectId: source.objectId});
		if (read === undefined || !read.ok) return undefined;
		const scopes = new Set<string>();
		for (const bytes of read.value.canonicalRows) {
			const frame = decodeCanonical(bytes);
			if (Array.isArray(frame) && (frame[0] === "acceptedEntries" || frame[0] === "accepted_entries") && Array.isArray(frame[1]))
				scopes.add(JSON.stringify(frame[1].slice(0, 3)));
		}
		return scopes;
	} catch {
		return undefined;
	}
}

/** Whether a further settling pass can release one of the member's own rows: an entry of
 * its own settlement plan whose source row is still a protected issuance hole and whose
 * journal scope is among `removed` (drained after the issuance decision that kept the
 * hole). A member that issues nothing (receive-only) has an empty plan and ends at the
 * first read. A delivering Writer's committed rows of the drained scope are such rows:
 * the further pass releases them, as the install's turnover did before the skip, which
 * keeps its own rows and plan entries at that level. Observation only; an unreadable
 * state answers true, so the passes go on settling as before. */
async function settlementSourceHeldIn(source: CreatorRecipientSource, removed: ReadonlySet<string>): Promise<boolean> {
	try {
		const plan = await source.issuanceStore.readSettlementPlan(source.issuanceScope);
		if (plan === null || plan.entries.length === 0) return false;
		const census = await durableIssuancePruningMaintenanceForStore(source.issuanceStore)?.readBoundedRecoveryCensus?.(
			{objectId: source.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
		if (census === undefined) return true;
		const completed = census.control?.completed;
		const holes = new Set((completed?.protectedRecords ?? []).map(hole =>
			JSON.stringify([hole.author, hole.authorSequence, hole.digest])));
		for (const entry of plan.entries) {
			const row = census.rows.issued.find(issued => issued.author === source.issuanceScope.author &&
				issued.authorSequence === entry.sourceSequence);
			if (row === undefined) continue;
			const digest = Array.from(row.digest, byte => byte.toString(16).padStart(2, "0")).join("");
			const value = decodeCanonical(row.canonicalPreimageBytes) as {epoch?: unknown; anchor?: unknown};
			// Rule H: a row above the completed floor is held without a listed hole.
			const aboveFloor = completed != null && typeof value.epoch === "number" && value.epoch > issuanceRetirementFloor(completed) &&
				value.epoch <= completed.throughEpoch;
			if (!aboveFloor && !holes.has(JSON.stringify([row.author, row.authorSequence, digest]))) continue;
			if (removed.has(JSON.stringify([source.objectId, value.epoch, value.anchor]))) return true;
		}
		return false;
	} catch {
		return true;
	}
}

/** The original bounded received turnover: one signing census bounds the passes;
 * each pass seals the received dependencies, reconciles, and joins its hold.
 *
 * With `settle` (a lull: its boundary lets the next install skip its own turnover) the
 * passes run to the fixpoint of the journal drain, and each pass acknowledges its completed
 * drain, as the creator's own readiness and pool boundaries do. A pass that drains a
 * closed journal scope decided the issuance holes from the journal as it was before that
 * drain, so the member's own issued rows of the drained scope stay protected. While the
 * drain is unacknowledged, a further pass at the same boundary resumes the drain's
 * reconstruction, re-derives the same decision and keeps those holes. Before the skip,
 * the install's turnover was that further pass (its received closed membership changes
 * the source, so it decides afresh on the physical journal and releases the rows before
 * the install's cleanup and settlement write); with the skip, the release waited for the
 * next lull, and the rows, their settlement entries and the unsettled epoch they carry
 * outlived the settlement window by one epoch. A further pass runs only when a drained
 * scope still holds an own settlement source as a protected hole (settlementSourceHeldIn):
 * a member with no own held row (receive-only) pays no extra pass.
 * `settled`: no such source remains. An unreadable journal or the pass bound leaves it
 * false, so the caller records no boundary and the install turns over as before. */
type ReceivedTurnoverPassInput = Readonly<{
	source: CreatorRecipientSource;
	snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
	catalog: TrustedBlueprintCatalog;
	context: CreatorRecipientRecoveryContext;
	signing: ReceivedSigningOwner;
	requireClosedWorkflowCompletion?: boolean;
	settle?: boolean;
}>;
/** The original turnover passes' progress, carried across passes (and, for a lull, across lulls). */
type ReceivedTurnoverPassState = {
	readonly maxPasses: number;
	pass: number;
	detail: ReadonlySet<string> | undefined;
	settled: boolean;
	drained: boolean;
	done: boolean;
	readonly retired: GenerationRecord[];
};

async function beginReceivedRecoveryTurnoverPasses(input: ReceivedTurnoverPassInput): Promise<ReceivedTurnoverPassState> {
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
	return {maxPasses: 2 + epochs.size + AHE_BOUNDED_READ_LIMITS.maxObjectGenerations, pass: 0,
		detail: input.settle === true ? await journalDetailScopes(input.source) : undefined,
		settled: input.settle !== true, drained: false, done: false, retired: []};
}

/** One original turnover pass (one sealed census, one reconciliation). Sets `state.done` at the end. */
async function runReceivedRecoveryTurnoverPass(input: ReceivedTurnoverPassInput, state: ReceivedTurnoverPassState,
	seal: () => Promise<ReceivedRecoverySeal | undefined>): Promise<void> {
	const { source, context } = input;
	const pass = state.pass;
	state.pass = pass + 1;
	const sealed = await seal();
	if (sealed === undefined) throw new CreatorRecoveryHoldUnavailable("creator recipient recovery dependencies unavailable");
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
			...(context.signal === undefined ? {} : {signal: context.signal}),
			roomHeadAuthority: context.roomHeadAuthority, pinnedGenesisAnchorDigest: context.pinnedGenesisAnchorDigest,
			exactCanonicalPinnedGenesisTrustStateRecordBytes: context.exactCanonicalPinnedGenesisTrustStateRecordBytes,
			catalog: input.catalog,
			objectId: source.objectId, store: source.store, snapshotStore: input.snapshotStore,
			liveJournalStore: source.liveJournalStore}, sealed.hold, input.requireClosedWorkflowCompletion === true,
			input.settle === true);
		state.retired.push(...sealed.readRetiredGenerations());
	} catch (error) {retirementFailed = true; retirementPrimary = error; throw error;}
	finally {await releaseCreatorRecoveryReader(lifetime, retirementFailed, retirementPrimary, "creator recipient retirement dependencies cleanup failed");}
	if (checkpoint === "complete") {
		if (input.settle !== true) { state.done = true; return; }
		const after = await journalDetailScopes(source);
		if (state.detail === undefined || after === undefined) { state.done = true; return; }
		const detail = state.detail;
		const removed = new Set([...detail].filter(scope => !after.has(scope)));
		// Settled unless a drained scope still holds an own settlement source (the
		// member's own rows a further pass would release).
		if (removed.size === 0 || !(await settlementSourceHeldIn(source, removed))) { state.settled = true; state.done = true; return; }
		// One more pass decides the issuance on the drained journal.
		state.detail = after;
		state.drained = true;
		if (pass === state.maxPasses - 1) state.done = true;
		return;
	}
	// After a completed pass, the bound ends the settling unsettled; it is never a failure.
	if (pass === state.maxPasses - 1) {
		if (state.drained) { state.done = true; return; }
		throw new TypeError("creator recipient bounded retirement did not stabilize");
	}
}

function observeTurnoverSettle(input: ReceivedTurnoverPassInput, state: ReceivedTurnoverPassState): void {
	if (input.settle !== true) return;
	try {
		const observer = Reflect.get(globalThis, "__warmProofEvent");
		if (typeof observer === "function")
			observer({kind: "recipient-lull-turnover-settle", epoch: input.source.currentTrust.currentEpoch, passes: state.pass,
				settled: state.settled});
	} catch { /* Diagnostics never alter the original owner outcome. */ }
}

async function runReceivedRecoveryTurnoverPasses(input: ReceivedTurnoverPassInput,
	seal: () => Promise<ReceivedRecoverySeal | undefined>): Promise<Readonly<{ retired: readonly GenerationRecord[]; settled: boolean }>> {
	const state = await beginReceivedRecoveryTurnoverPasses(input);
	while (!state.done && state.pass < state.maxPasses) await runReceivedRecoveryTurnoverPass(input, state, seal);
	observeTurnoverSettle(input, state);
	return Object.freeze({retired: state.retired, settled: state.settled});
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
 * The SAME original passes run now; when they complete, the boundary they
 * reconciled is recorded for this plane, and the next install skips its own
 * turnover only if that boundary is still exactly current and its received successor
 * pushes no retained scope out of the bounded window (the install's
 * predicate alone stays due while the current Cut classifies a retained scope).
 * Inline install turnover remains the backstop. This grants no authority: an
 * unavailable or busy boundary is reported before entry, never forced. After entry, any failure is recovery work.
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
	// Any lull entry, even one that defers, ends the previous lull's boundary.
	reconciledReceivedTurnovers.delete(input.plane);
	const source = resolveCreatorRecipientRegistration(input.plane, resume);
	if (source === undefined || input.snapshotStore.captureRecoveryRoleInventory === undefined)
		return Object.freeze({kind: "deferred", reason: "unsupported"});
	if (!sameCreatorRoomHead(input.expectedRoomHead, source.currentTrust))
		return Object.freeze({kind: "deferred", reason: "busy"});
	// Observational point reads before any admission: "not-needed" leaves the
	// received gate, ordinary issuance and native state untouched. A resume is
	// requested by the plane's own halt, not by pool pressure. The head read is
	// queued behind the plane's turns, which may hold its native writer reservation.
	if (resume ? !source.needsOrdinaryReadinessRecovery() :
		!(await receivedRecoveryTurnoverDue(source, input.snapshotStore, (await source.inspectQueuedNativeHead()).candidates)))
		return Object.freeze({kind: "not-needed"});
	const context = input.recoveryContext;
	const opened = await createCreatorSigningRecoveryOwner({currentTrust: source.currentTrust,
		voteStore: context.voteStore, evidenceStore: context.evidenceStore, storageIncarnation: context.storageIncarnation});
	if (!opened.ok) throw new TypeError(`creator recipient signing custody unavailable: ${opened.reason}`);
	let outcome: "ran" | "deferred";
	// A lull runs its passes to the journal-drain fixpoint, since its boundary lets the next
	// install skip its own turnover; a resume records no boundary and keeps the original passes.
	let settled = false;
	try {
		outcome = await source.runReceivedRecoveryMaintenance(opened.owner, input.snapshotStore, (seal, requireClosedWorkflowCompletion) => {
			// These generations belong to this stable boundary. The next install's
			// own turnover (if any) classifies from the state it then observes.
			const passes = async (): Promise<"complete"> => {
				settled = (await runReceivedRecoveryTurnoverPasses({source, snapshotStore: input.snapshotStore, catalog: input.catalog,
					context, signing: opened.owner, requireClosedWorkflowCompletion, settle: !resume}, seal)).settled;
				return "complete";
			};
			// A lull is background: its walks defer host turns behind co-located
			// foreground work. A startup resume holds this room's issues, so it is not.
			return resume ? passes() : runInBackgroundLane(passes);
		}, resume ? {resume: true} : {deferrable: true});
	} finally {
		await opened.owner.stop();
	}
	// Record what the completed passes reconciled (a resume discharges a halt; it records nothing;
	// passes that did not settle record nothing either, and the install turns over).
	if (outcome === "ran" && !resume && settled) {
		try {
			const boundary = await captureReceivedTurnoverBoundary(source, input.snapshotStore,
				(await source.inspectQueuedNativeHead()).candidates);
			if (boundary !== undefined) reconciledReceivedTurnovers.set(input.plane, boundary);
		} catch { /* No boundary: the next install turns over as before. */ }
	}
	return Object.freeze(outcome === "deferred" ? {kind: "deferred", reason: "busy"} : {kind: "maintained"});
}

/**
 * D.108d1b at the install boundary (G6). The successor's settlement capability carries the
 * creator-signed frontier of this author: the highest of its sequences the room admitted. That
 * frontier is held outside this origin, so a local store whose lineage is at or below it is an
 * older copy (a restored backup, a clone) whatever its own rows say. Such a store is refused here,
 * once the successor is authenticated and before anything is retained, adopted or written to the
 * settlement plan; the signing-time check alone ran after the plan was already rewritten. A store
 * whose lineage is above the frontier is unaffected, as is a receive-only member (no own lineage).
 * Model: packages/node/formal/own-fence-freshness.qnt (MINIMAL).
 * @param source - The recipient's current registration (its issuance store and scope).
 * @param closure - The authenticated successor closure.
 * @param successorTrust - The authenticated successor trust.
 * @param closedTrust - The closed epoch's trust (the checkpoint predecessor for a checkpoint).
 * @param closedAclBytes - The closed epoch's latched ACL (this member's current one, or the
 * checkpoint predecessor's): the received closure does not carry it until staging, and the
 * historical issuance binds the settlement's ACL digest to it.
 */
async function assertReceivedLineageAboveAdmittedFrontier(
	source: CreatorRecipientSource,
	received: CreatorTransitionClosure,
	successorTrust: CurrentAnchorTrust,
	closedTrust: CurrentAnchorTrust | undefined,
	closedAclBytes: Uint8Array | undefined
): Promise<void> {
	if (closedAclBytes === undefined) return;
	const aclDigest = digestBlob(closedAclBytes);
	if (!aclDigest.ok) return;
	const acl = Object.freeze({ bytes: Uint8Array.from(closedAclBytes),
		ref: Object.freeze({ digest: aclDigest.value, byteLength: closedAclBytes.byteLength }) });
	const kept = received.candidates.filter(candidate => canonicalRecord(candidate.bytes)?.kind !== "drp-v3-latched-acl");
	const closure: CreatorTransitionClosure = { candidates: [...kept, acl], closure: [...received.closure.filter(ref =>
		kept.some(candidate => sameRef(candidate.ref, ref))), acl.ref] };
	if (source.receiveOnly || closedTrust === undefined) return;
	const scope = source.issuanceScope;
	const historical = openVerifiedCreatorHistoricalIssuance({ author: scope.author, closure, floorTrust: successorTrust,
		sourceTrust: closedTrust });
	const identity = historical === undefined ? undefined : resolveVerifiedCreatorHistoricalIssuance(historical);
	if (
		identity === undefined ||
		identity.admittedAuthorSequence === null ||
		identity.author !== scope.author ||
		identity.objectId !== scope.objectId ||
		identity.successorEpoch !== successorTrust.currentEpoch
	)
		return;
	const lineage = await source.issuanceStore.readLineage(scope);
	if (lineage.exhausted !== false || !Number.isSafeInteger(lineage.next) || lineage.next <= identity.admittedAuthorSequence)
		throw new V3LocalLineageBehindFrontier(scope.author, lineage.next, identity.admittedAuthorSequence);
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
		/**
		 * The caller's lifetime (decision row 61, option E): the material fetch retries transient
		 * unavailability, inside this one admitted receive, until it aborts.
		 */
		retryUntil?: AbortSignal;
	}>
): Promise<ReceivedCreatorSuccessorAdoption> {
	// Every install attempt consumes the plane's lull boundary.
	const reconciledBoundary = reconciledReceivedTurnovers.get(input.plane);
	reconciledReceivedTurnovers.delete(input.plane);
	const source = resolveCreatorRecipientRegistration(input.plane);
	if (source === undefined || !sameCreatorRoomHead(input.expectedRoomHead, source.currentTrust))
		throw new TypeError("creator recipient current authority is unavailable");
	const offer = captureCreatorSuccessorOffer(input.offer);
	const cut = canonicalRecord(offer.exactCanonicalCutValueBytes);
	const promoted = cut !== undefined && Object.hasOwn(cut, "forwardPromotion");
	const offeredEpoch = canonicalRecord(offer.exactCanonicalTrustStateRecordBytes)?.currentEpoch;
	const checkpointRequested = Number.isSafeInteger(offeredEpoch) && Number(offeredEpoch) > source.currentTrust.currentEpoch + 1;
	let opened = checkpointRequested ? undefined : (promoted ? openCreatorForwardPromotionSuccessorTrust : openCreatorSuccessorTrust)({
		currentTrust: source.currentTrust,
		exactCanonicalCutValueBytes: offer.exactCanonicalCutValueBytes,
		exactCanonicalCommitQcBytes: offer.exactCanonicalCommitQcBytes,
		exactCanonicalTrustStateRecordBytes: offer.exactCanonicalTrustStateRecordBytes,
	});
	if (
		(!checkpointRequested && (!opened?.ok || opened.trust.currentEpoch !== source.currentTrust.currentEpoch + 1)) ||
		cut === undefined ||
		(checkpointRequested && promoted)
	)
		throw new TypeError("creator recipient signed adjacency is invalid");
	const manifest = decodeSnapshotManifest({
		exactCanonicalManifestBytes: offer.exactCanonicalSnapshotManifestBytes,
		expectedManifestDigest: String(cut.snapshotManifestDigest),
		profile: PROFILE,
	});
	if (
		manifest.manifest.objectId !== source.objectId ||
		manifest.manifest.epoch !== (checkpointRequested ? cut.epoch : source.currentTrust.currentEpoch) ||
		manifest.manifest.anchor !== (checkpointRequested ? cut.previousAnchor : source.currentTrust.currentAnchorDigest)
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
	const observeReceivedTurnover = (outcome: "not-due" | "reconciled" | "ran"): void => {
		try {
			const observer = Reflect.get(globalThis, "__warmProofEvent");
			if (typeof observer === "function")
				observer({kind: "recipient-received-turnover", epoch: source.currentTrust.currentEpoch, outcome});
		} catch { /* Diagnostics never alter the original owner outcome. */ }
	};
	const prepareReceivedRecoveryTurnover = async (): Promise<boolean> => {
		if (!(await receivedRecoveryTurnoverDue(source, input.snapshotStore, current.candidates))) {
			observeReceivedTurnover("not-due");
			return false;
		}
		// This plane's own lull already ran the SAME passes at this exact boundary (head,
		// current Cut, recovery inventory, own settlement plan) and nothing has reconciled or
		// retained since, and the received successor pushes no retained scope out of the window.
		if (reconciledBoundary !== undefined && !promoted && !checkpointRequested) {
			const boundary = await captureReceivedTurnoverBoundary(source, input.snapshotStore, current.candidates);
			if (boundary !== undefined && sameReceivedTurnoverBoundary(boundary, reconciledBoundary) &&
				!(await receivedWindowEdgeScopeRetained(source))) {
				observeReceivedTurnover("reconciled");
				return false;
			}
		}
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
		retiredGenerations.push(...(await runReceivedRecoveryTurnoverPasses({source, snapshotStore: input.snapshotStore,
			catalog: input.catalog, context, signing: openedCustody.owner},
			() => source.sealReceivedRecoveryDependencies(openedCustody.owner, input.snapshotStore))).retired);
		observeReceivedTurnover("ran");
		return true;
	};
	// fix/skip-scope-carrier: a skip install's material authenticates the target from the Cut before
	// it, so the scope this member departs from (its current epoch) closes on a Cut it never received.
	// The departed carrier supplies that Cut, its QC, the successor trust record and the closed
	// membership; it is authenticated here against this member's own current trust exactly as an
	// adjacent offer is, and recorded below through the adjacent path. Optional: an older creator, a
	// creator that no longer holds it, or any failure yields none, and that scope keeps today's
	// retention (the journal retirement re-verifies a recorded carrier on every classification).
	let departed: CreatorSuccessorDepartedCarrier | undefined;
	// Observation only (the "__warmProofEvent" proof hook): what each skip install did with the
	// departed scope's carrier. Never alters the install's outcome.
	const observeDeparted = (outcome: string, detail?: string): void => {
		try {
			const observer = Reflect.get(globalThis, "__warmProofEvent");
			if (typeof observer === "function")
				observer({ kind: "recipient-departed-carrier", departedEpoch: source.currentTrust.currentEpoch, outcome,
					...(detail === undefined ? {} : { detail }) });
		} catch { /* Diagnostics never alter the original owner outcome. */ }
	};
	const receiveDepartedCarrier = async (): Promise<CreatorSuccessorDepartedCarrier | undefined> => {
		const departedScope = Object.freeze({ epoch: source.currentTrust.currentEpoch, anchorDigest: source.currentTrust.currentAnchorDigest });
		const carrier = await receiveCreatorSuccessorDepartedCarrier({
			transport: input.transport,
			peers: input.peers,
			manifestDigest: manifest.manifestDigest,
			departed: departedScope,
			identity: {
				author: input.author,
				sign: input.signRegisteredVertexDigest,
				isAuthorizedAuthor: (author) => {
					const currentAuthority = input.plane.currentEphemeralAuthority();
					return currentAuthority !== undefined && currentAuthority.objectId === source.objectId &&
						currentAuthority.epoch === source.currentTrust.currentEpoch &&
						currentAuthority.anchorDigest === source.currentTrust.currentAnchorDigest &&
						(author === creatorSourceAuthor || currentAuthority.isCurrentWriter(author));
				},
			},
		}).catch(() => undefined);
		if (carrier === undefined) {
			observeDeparted("none");
			return undefined;
		}
		const departedCut = canonicalRecord(carrier.exactCanonicalCutValueBytes);
		if (departedCut === undefined || departedCut.epoch !== departedScope.epoch || departedCut.previousAnchor !== departedScope.anchorDigest) {
			observeDeparted("rejected", "cut-scope");
			return undefined;
		}
		const authority = (Object.hasOwn(departedCut, "forwardPromotion") ? openCreatorForwardPromotionSuccessorTrust : openCreatorSuccessorTrust)({
			currentTrust: source.currentTrust,
			exactCanonicalCutValueBytes: carrier.exactCanonicalCutValueBytes,
			exactCanonicalCommitQcBytes: carrier.exactCanonicalCommitQcBytes,
			exactCanonicalTrustStateRecordBytes: carrier.exactCanonicalTrustStateRecordBytes,
		});
		if (!authority.ok || authority.trust.currentEpoch !== departedScope.epoch + 1) {
			observeDeparted("rejected", "authority");
			return undefined;
		}
		const membership = await openCreatorCloseMembership({ bytes: carrier.exactCanonicalCloseMembershipBytes,
			exactCanonicalCutValueBytes: carrier.exactCanonicalCutValueBytes,
			maxEpochVertices: (departedCut.parameters as { maxEpochVertices: number } | undefined)?.maxEpochVertices ?? 0 }).catch(() => undefined);
		if (membership === undefined || membership.localVertexWitnesses.length !== 0 ||
			!sameBytes(membership.exactCanonicalLatchedAclBytes, source.exactCanonicalLatchedAclBytes)) {
			observeDeparted("rejected", "membership");
			return undefined;
		}
		observeDeparted("authenticated");
		return carrier;
	};
	try {
		transfer = createV3SnapshotTransferOwner({ transport: input.transport });
		const auxiliary = await receiveCreatorSuccessorMaterial({
			transport: input.transport,
			peers: input.peers,
			manifestDigest: manifest.manifestDigest,
			...(checkpointRequested ? {materialKind: "checkpoint" as const} : {}),
			...(input.retryUntil === undefined ? {} : { retryUntil: input.retryUntil }),
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
		const point = checkpointRequested ? decodeCreatorReattachmentCheckpoint(auxiliary.exactCanonicalReattachmentCheckpointBytes) : undefined;
		if (checkpointRequested) {
			if (point === undefined || input.exactCanonicalGenesisAnchorPreimageBytes === undefined || input.detachedGenesisSignature === undefined)
				throw new TypeError("creator checkpoint recovery carriers are unavailable");
			const currentPoint = openCreatorCheckpointTrust({
				exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalGenesisAnchorPreimageBytes,
				detachedGenesisSignature: input.detachedGenesisSignature,
				exactCanonicalPredecessorTrustStateRecordBytes: point.exactCanonicalPredecessorTrustStateRecordBytes,
				exactCanonicalCurrentTrustStateRecordBytes: offer.exactCanonicalTrustStateRecordBytes,
				exactCanonicalCutValueBytes: offer.exactCanonicalCutValueBytes,
				exactCanonicalCommitQcBytes: offer.exactCanonicalCommitQcBytes,
				expectedCurrentHead: {objectId: source.objectId, epoch: Number(offeredEpoch),
					currentAnchorDigest: String(canonicalRecord(offer.exactCanonicalTrustStateRecordBytes)?.currentAnchorDigest)},
				expectedObjectId: source.objectId, pinnedGenesisAnchorDigest: source.currentTrust.genesisAnchorDigest,
			});
			if (!currentPoint.ok || currentPoint.predecessorTrust.currentEpoch !== manifest.manifest.epoch ||
				currentPoint.predecessorTrust.currentAnchorDigest !== manifest.manifest.anchor)
				throw new TypeError("creator checkpoint current authority is invalid");
			opened = {ok: true, trust: currentPoint.currentTrust};
			departed = await receiveDepartedCarrier();
		}
		if (!opened?.ok) throw new TypeError("creator successor authority is invalid");
		const receivedTrust = opened.trust;
		assertSettlementCompanionProfile(auxiliary.exactCanonicalSettlementBytes,receivedTrust.profileId);
		const receivedHistory = openCreatorCloseHistory({
			bytes: auxiliary.exactCanonicalHistoryBytes,
			exactCanonicalCutValueBytes: offer.exactCanonicalCutValueBytes,
			historyRoot: cut.historyRoot,
			historySize: cut.historySize,
		});
		if (receivedHistory === undefined) throw new TypeError("creator received history commitment differs");
		if (auxiliary.exactCanonicalCloseMembershipBytes !== undefined) {
			const membership = await openCreatorCloseMembership({ bytes: auxiliary.exactCanonicalCloseMembershipBytes,
				exactCanonicalCutValueBytes: offer.exactCanonicalCutValueBytes,
				maxEpochVertices: (cut.parameters as { maxEpochVertices: number }).maxEpochVertices });
			if (membership === undefined || membership.localVertexWitnesses.length !== 0 ||
				!sameBytes(membership.exactCanonicalLatchedAclBytes, source.exactCanonicalLatchedAclBytes))
				throw new TypeError("creator received close membership differs from authenticated source");
		}
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
					(checkpointRequested ? canonicalRecord(bytes)?.kind === currentProjectionKind(source.currentTrust.currentEpoch) :
					ref.digest !== current.trustRef.digest &&
					!new Set(["drp-creator-author-settlement-state","drp-creator-issuance-retirement-state","drp-creator-author-issuance-frontiers-state"]).has(String(canonicalRecord(bytes)?.kind))
					)
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
				epoch: Number(manifest.manifest.epoch),
				anchor: String(manifest.manifest.anchor),
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
		let checkpoint: VerifiedCreatorCheckpointAttachment | undefined;
		if (checkpointRequested) {
			const snapshot = await verifySnapshot({snapshotDeclaration: declaration, snapshotStore: input.snapshotStore},
				{cut, successorTrust: receivedTrust});
			if (snapshot === undefined) throw new TypeError("creator checkpoint snapshot is invalid");
			const verified = openCreatorCheckpointAttachment({localBaseHead: current.head, localTrust: source.currentTrust,
				exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalGenesisAnchorPreimageBytes,
				detachedGenesisSignature: input.detachedGenesisSignature,
				exactCanonicalReattachmentCheckpointBytes: auxiliary.exactCanonicalReattachmentCheckpointBytes,
				...offer, exactCanonicalSnapshotPayloadBytes: snapshot.exactCanonicalPayloadBytes,
				exactCanonicalSettlementBytes: auxiliary.exactCanonicalSettlementBytes});
			if (!verified.ok) throw new TypeError(`creator checkpoint attachment is invalid: ${verified.reason}`);
			checkpoint = verified.capability;
			const bound = resolveCreatorCheckpointAttachment(checkpoint);
			if (bound === undefined) throw new TypeError("creator checkpoint attachment is unavailable");
			proposedCandidates = [...bound.proofCandidates, ...proposedCandidates.filter(candidate => {
				const kind = canonicalRecord(candidate.bytes)?.kind;
				return kind === currentProjectionKind(source.currentTrust.currentEpoch) || kind === "creator-close-history-1";
			})].sort((a, b) => a.ref.digest.localeCompare(b.ref.digest));
			proposed = {candidates: proposedCandidates, closure: proposedCandidates.map(({ref}) => ref)};
		}
		const replay = await source.sealDurableReplay();
		if (replay === undefined || replay.commitment === undefined)
			throw new TypeError("creator recipient native replay is invalid");
		const owner = Object.freeze({});
		receivedOwner = owner;
		let facts: SealedAdoptionFacts = Object.freeze({
			...(checkpoint === undefined ? {} : {checkpoint}),
			...(source.receiveOnly ? { receiveOnly: true as const } : {}),
			origin: "received",
			receivedCandidates: Object.freeze([...proposedCandidates]),
			transition: Object.freeze({
				cutValueRef: cutCandidate.ref,
				commitQcRef: commitCandidate.ref,
				successorTrustRef: trustCandidate.ref,
				currentTrustRef: current.trustRef,
				epoch: source.currentTrust.currentEpoch,
				successorEpoch: receivedTrust.currentEpoch,
				successorAnchorDigest: receivedTrust.currentAnchorDigest,
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
				successorTrust: receivedTrust,
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
				successorTrust: receivedTrust,
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
		const advance = checkpoint === undefined ? inspectCreatorTransitionAdvance({
			current: { candidates: current.candidates, closure: current.references },
			currentTrust: source.currentTrust,
			mode: "stage",
			proofRefs: [facts.transition.cutValueRef, facts.transition.commitQcRef],
			proposed,
			successorTrust: receivedTrust,
			settlementAcl: {
				current: source.exactCanonicalLatchedAclBytes,
				successor: snapshot.authorizedAclBytes ?? encodeCanonical(snapshot.payload.acl),
			},
		}) : inspectCreatorCheckpointTransition({checkpoint, localHead: current.head, currentTrust: source.currentTrust,
			current: {candidates: current.candidates, closure: current.references}, proposed})
			? {ok: true as const, proposed} : {ok: false as const, reason: "CHECKPOINT_CLOSURE_INVALID"};
		if (!advance.ok) throw new TypeError(`creator received settlement transition is invalid: ${advance.reason}`);
		facts = Object.freeze({
			...facts,
			receivedCandidates: Object.freeze([...advance.proposed.candidates]),
			proposedReferences: advance.proposed.closure,
		});
		// Before any native custody below: a store behind its creator-signed frontier is refused.
		const remoteCheckpoint = checkpoint === undefined ? undefined : resolveCreatorCheckpointAttachment(checkpoint)?.remoteCheckpoint;
		await assertReceivedLineageAboveAdmittedFrontier(source, advance.proposed, receivedTrust,
			checkpoint === undefined ? source.currentTrust : remoteCheckpoint?.predecessorTrust,
			checkpoint === undefined ? source.exactCanonicalLatchedAclBytes : remoteCheckpoint?.exactCanonicalPredecessorAclBytes);
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
				kind: checkpoint === undefined ? "creator-received-recovery-certificate-1" : "creator-received-checkpoint-certificate-1",
				...(checkpoint === undefined ? {} : {exactCanonicalReattachmentCheckpointBytes: auxiliary.exactCanonicalReattachmentCheckpointBytes!}),
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
		const membershipRecorded = checkpoint === undefined && await source.recordReceivedClosedMembership(offer.exactCanonicalCutValueBytes,
			auxiliary.exactCanonicalSettlementBytes, auxiliary.exactCanonicalCloseMembershipBytes, {
				exactCanonicalCommitQcBytes: offer.exactCanonicalCommitQcBytes,
				exactCanonicalSuccessorTrustStateRecordBytes: offer.exactCanonicalTrustStateRecordBytes,
			});
		if (auxiliary.exactCanonicalCloseMembershipBytes !== undefined && !membershipRecorded)
			throw new TypeError("creator received close membership persistence refused");
		// A skip install records the departed scope's authenticated carrier through the same path.
		// Never fatal: a refusal leaves that scope with today's retention.
		if (checkpoint !== undefined && departed !== undefined)
			observeDeparted(await source.recordReceivedDepartedClosedMembership(departed.exactCanonicalCutValueBytes,
				departed.exactCanonicalCloseMembershipBytes, {
					exactCanonicalCommitQcBytes: departed.exactCanonicalCommitQcBytes,
					exactCanonicalSuccessorTrustStateRecordBytes: departed.exactCanonicalTrustStateRecordBytes,
				}).catch(() => false) ? "recorded" : "record-refused");
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
		// Every durable received intent must already own the accepted source
		// contexts that cold verification will need. This read/write stays under
		// the original receive gate and precedes receipt publication.
		const sourceCustody = await source.retainAcceptedSourceCustody(receivedTrust,
			snapshot.authorizedAclBytes ?? encodeCanonical(snapshot.payload.acl));
		if (!(await replay.verify()) || !(await sourceCustody.verify()))
			throw new TypeError("creator recipient source changed before retention");
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
		facts = Object.freeze({...facts, durableReplay: Object.freeze({...replay,
			verify: async () => await replay.verify() && await sourceCustody.verify()})});
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
	readonly checkpoint?: VerifiedCreatorCheckpointAttachment;
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
	readonly checkpointPredecessorAnchor?: Readonly<Record<string, unknown>>;
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
		| "checkpoint"
	> & {readonly currentHead?: PresentHead},
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
	const checkpoint = facts.checkpoint === undefined ? undefined : resolveCreatorCheckpointAttachment(facts.checkpoint);
	if (facts.checkpoint !== undefined && (checkpoint === undefined || promotedCut || facts.promotion !== undefined || facts.currentHead === undefined ||
		!inspectCreatorCheckpointTransition({checkpoint: facts.checkpoint, localHead: facts.currentHead,
			currentTrust: facts.currentTrust, current: {candidates: closure.currentCandidates, closure: facts.currentReferences},
			proposed: {candidates: closure.proposedCandidates, closure: facts.proposedReferences}}))) return undefined;
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
	const opened = checkpoint === undefined ? (promotedCut ? openCreatorForwardPromotionSuccessorTrust : openCreatorSuccessorTrust)({
		currentTrust: facts.currentTrust,
		exactCanonicalCommitQcBytes: commitBytes,
		exactCanonicalCutValueBytes: cutBytes,
		exactCanonicalTrustStateRecordBytes: successorTrustBytes,
	}) : {ok: true as const, trust: checkpoint.target.trust};
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
	if (checkpoint === undefined && inspectAdvance && !advance.ok) return undefined;
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
		(checkpoint === undefined ? successorEpoch !== currentEpoch + 1 : successorEpoch <= currentEpoch + 1) ||
		facts.transition.epoch !== currentEpoch ||
		facts.transition.successorEpoch !== successorEpoch ||
		currentTrustRecord.currentEpoch !== currentEpoch ||
		successorTrustRecord.currentEpoch !== successorEpoch ||
		currentAnchor?.epoch !== currentEpoch ||
		successorAnchor?.epoch !== successorEpoch ||
		successorAnchor?.previousAnchor !== (checkpoint?.remoteCheckpoint.predecessorTrust.currentAnchorDigest ?? facts.currentTrust.currentAnchorDigest)
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
		...(checkpoint === undefined ? {} : {checkpointPredecessorAnchor: canonicalRecord(
			readCreatorSettlementSourceAnchor(checkpoint.remoteCheckpoint.predecessorTrust)!.anchorPreimage)!}),
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
		const closedAnchor = chain.checkpointPredecessorAnchor ?? chain.currentAnchor;
		if (
			parameters === undefined ||
			chain.cut.previousHistoryRoot !== closedAnchor.historyRoot ||
			chain.cut.previousHistorySize !== closedAnchor.historySize ||
			chain.cut.historyRoot !== facts.history.historyRoot ||
			chain.cut.historySize !== facts.history.historySize
		) {
			return undefined;
		}
		const bytes = encodeCreatorSuccessorProjection({
			currentAnchor: closedAnchor,
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
			predecessorExactCanonicalLatchedAclBytes: facts.checkpoint === undefined ? facts.exactCanonicalLatchedAclBytes :
				resolveCreatorCheckpointAttachment(facts.checkpoint)!.remoteCheckpoint.exactCanonicalPredecessorAclBytes,
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
		const closedAclBytes = facts.checkpoint === undefined ? facts.exactCanonicalLatchedAclBytes :
			resolveCreatorCheckpointAttachment(facts.checkpoint)!.remoteCheckpoint.exactCanonicalPredecessorAclBytes;
		const predecessorAclDigest = digestBlob(closedAclBytes);
		if (!projectionDigest.ok || !predecessorAclDigest.ok) return undefined;
		const projectionRef = Object.freeze({ byteLength: projected.bytes.byteLength, digest: projectionDigest.value });
		const predecessorAclRef = Object.freeze({
			byteLength: closedAclBytes.byteLength,
			digest: predecessorAclDigest.value,
		});
		const successorCandidates = commitMaterial.candidateReferences.map((ref) => {
			if (sameRef(ref, projectionRef)) return Object.freeze({ bytes: Uint8Array.from(projected.bytes), ref });
			if (sameRef(ref, predecessorAclRef)) {
				return Object.freeze({ bytes: Uint8Array.from(closedAclBytes), ref });
			}
			const candidate = closure.proposedCandidates.find((entry) => sameRef(entry.ref, ref));
			if (candidate === undefined) throw new TypeError("creator successor candidate is unavailable");
			return Object.freeze({ bytes: Uint8Array.from(candidate.bytes), ref: Object.freeze({ ...ref }) });
		});
		return Object.freeze({
			...(facts.checkpoint === undefined ? {} : {checkpoint: facts.checkpoint}),
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
			exactCanonicalParametersCarrierBytes: encodeCanonical(chain.cut.parameters),
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
			predecessorExactCanonicalParametersBytes: Uint8Array.from(facts.exactCanonicalParametersCarrierBytes),
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
			facts.checkpoint === undefined &&
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
	checkNativeCurrency: () => Promise<void>,
	currentTrust: CurrentAnchorTrust,
	successorClosure: CreatorTransitionClosure
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
		let localCustodian = settlementProfileFor(expectedProfileId) === "v1" &&
			opened.snapshot.members.some(({author}) => author === input.author);
		if (!localCustodian && !input.receiveOnly && settlementProfileFor(expectedProfileId) === "v1") {
			const scope = {objectId, author: input.author};
			const plan = copySettlementPlan(await input.issuanceStore.readSettlementPlan(scope), scope);
			for (const entry of plan?.entries ?? []) {
				// A signed local-author expiry remains this author's terminal native custody
				// (until retirement prunes it), exactly like a signed completion. Reopen
				// authenticates its signature before any consumer reads it.
				if (entry.sourceContextDigest === undefined || entry.replacementSequence !== null ||
					(entry.disposition === "expire" && entry.sourceResolutionDigest === undefined) || entry.disposition === "inherited") continue;
				const context = plan?.sourceContexts?.find(value => sameBytes(value.digest, entry.sourceContextDigest!));
				const capability = context === undefined ? undefined : openCreatorSourceCustody({currentTrust, context});
				const source = capability === undefined ? undefined : resolveCreatorSourceCustody(capability);
				const authorized = source === undefined ? undefined : authorizeLatchedApplicationWrite({author: input.author, snapshot: source.acl});
				if (source === undefined || source.trust.currentEpoch >= expectedEpoch || authorized?.ok !== true || !authorized.authorized)
					return Object.freeze({ok: false as const, reason: "authority" as const});
				localCustodian = true;
			}
			await checkNativeCurrency();
		}
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
		// The room's authenticated closed frontier for the SELECTED author. A local
		// lineage at or below it never issued work the room already admitted from this
		// key: a stale copy or another store's clone, never this author's authority.
		const historical = openVerifiedCreatorHistoricalIssuance({ author: input.author, closure: successorClosure,
			floorTrust: currentTrust });
		const identity = historical === undefined ? undefined : resolveVerifiedCreatorHistoricalIssuance(historical);
		const admitted = identity?.author === input.author && identity.objectId === objectId &&
			identity.successorEpoch === expectedEpoch ? identity.admittedAuthorSequence : null;
		for (const author of lineageAuthors) {
			const scope = Object.freeze({ author, objectId });
			const lineage = await input.issuanceStore.readLineage(scope);
			if (lineage.exhausted !== false || !Number.isSafeInteger(lineage.next) || lineage.next < 0) {
				return Object.freeze({ ok: false as const, reason: "lineage" as const });
			}
			if (author === input.author && admitted !== null && lineage.next <= admitted) {
				return Object.freeze({ ok: false as const, reason: "lineage" as const });
			}
			// Other authenticated writers can already have issued in this same object
			// (same-origin tabs share one room database). Their watermarks are not the
			// selected author's issuance authority: the scope below remains bound to
			// that author's current ACL, possession and authenticated frontier.
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
			const baseTrust = baseCandidates === undefined ? undefined : uniqueCandidateByKind(baseCandidates, "drp-anchor-trust-state");
			if (baseTrust !== undefined && typeof baseTrust.record.currentEpoch === "number" &&
				baseTrust.record.currentEpoch < input.expectedRoomHead.epoch - 1) {
				const previous = exactRoomHead({objectId, epoch: baseTrust.record.currentEpoch,
					currentAnchorDigest: baseTrust.record.currentAnchorDigest});
				if (previous === undefined) return coldFailure("chain-invalid", "creator checkpoint native base is invalid");
				const recoveryInput = {...input, expectedPreviousRoomHead: previous, expectedNextRoomHead: input.expectedRoomHead};
				const opened = await authenticatePendingCandidate(recoveryInput, lineage, active.adoptedGeneration, previous,
					input.expectedRoomHead, objectId, readClosure);
				const context = opened?.receivedContext;
				if (opened === undefined || context?.checkpoint === undefined || context.receivedCustody === undefined ||
					!sameHead(opened.head, active.head)) return coldFailure("chain-invalid", "creator checkpoint cold proof is invalid");
				await authenticateReceivedCandidateCustody(recoveryInput, context.receivedCustody, context, active.head);
				const {chain, predecessorTrust, snapshot} = context;
				const activeCandidates = await readClosure(active.references);
				const oldProjection = uniqueCandidateByKind(context.currentCandidates, chain.currentProjectionKind);
				const oldTrust = uniqueCandidateByKind(context.currentCandidates, "drp-anchor-trust-state");
				const newProjection = activeCandidates === undefined ? undefined : uniqueCandidateByKind(activeCandidates, "v3-live-generation-2");
				const newTrust = activeCandidates === undefined ? undefined : uniqueCandidateByKind(activeCandidates, "drp-anchor-trust-state");
				const resolved = verifiedCatalog(input.catalog, snapshot.payload.blueprintDigest, chain.currentCatalog);
				if (activeCandidates === undefined || oldProjection === undefined || oldTrust === undefined || newProjection === undefined ||
					newTrust === undefined || resolved === undefined) return coldFailure("chain-invalid", "creator checkpoint cold projection is invalid");
				const exactCanonicalLatchedAclBytes = encodeCanonical(snapshot.payload.acl);
				const issuance = await authenticatedSuccessorIssuanceScope(input, objectId, String(chain.successorAnchor.aclDigest),
					chain.successorEpoch, exactCanonicalLatchedAclBytes, chain.successorTrust.profileId, async () => {
						if (!(await capturedReader.checkCurrency()).ok) throw new TypeError("creator checkpoint cold native census changed");
					}, chain.successorTrust, {candidates: activeCandidates, closure: active.references});
				if (!issuance.ok) return coldFailure("chain-invalid", `creator checkpoint issuance ${issuance.reason} is invalid`);
				const material: CreatorSuccessorLiveMaterial = Object.freeze({checkpoint: context.checkpoint,
					...(input.receiveOnly ? {receiveOnly: true as const} : {}), origin: "durable-reopen", catalog: factsForCatalog(resolved),
					exactCanonicalLatchedAclBytes, exactCanonicalParametersCarrierBytes: encodeCanonical(chain.cut.parameters),
					exactCanonicalPinnedGenesisBootstrapOperationBytes, exactCanonicalSnapshotPayloadBytes: snapshot.exactCanonicalPayloadBytes,
					issuanceScope: issuance.scope, issuanceStore: input.issuanceStore, liveJournalStore: input.liveJournalStore,
					snapshotStore: input.snapshotStore, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest, store: input.store,
					predecessor: {candidates: context.currentCandidates, head: context.currentHead, references: context.currentGeneration.closure,
						trust: predecessorTrust, trustRef: oldTrust.ref, exactCanonicalProjectionBytes: oldProjection.bytes,
						exactCanonicalAnchorPreimageBytes: chain.currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array,
						detachedAnchorSignature: chain.currentTrustRecord.detachedCurrentAnchorSignature as Uint8Array},
					predecessorExactCanonicalLatchedAclBytes: context.predecessorAclBytes,
					predecessorExactCanonicalParametersBytes: context.predecessorParametersBytes,
					successor: {candidates: activeCandidates, head: active.head, references: active.references,
						trust: chain.successorTrust, trustRef: newTrust.ref, exactCanonicalProjectionBytes: newProjection.bytes,
						exactCanonicalAnchorPreimageBytes: chain.successorAnchorBytes,
						detachedAnchorSignature: chain.successorTrustRecord.detachedCurrentAnchorSignature as Uint8Array},
					snapshotPayloadDigest: String(snapshot.manifest.payloadDigest), stateDigest: String(snapshot.manifest.stateDigest),
					terminalizeSource: async () => true});
				if (!(await reader.checkCurrency()).ok) return coldFailure("storage-failed", "creator checkpoint cold native census changed");
				return Object.freeze({ok: true as const, material});
			}
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
				},
				successorTrust,
				{ candidates: activeCandidates, closure: active.references }
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
				...(direct && settlementProfileFor(successorTrust.profileId) === "v1" && cutCandidate.record.forwardPromotion === undefined ? {nativePublication: true as const} : {}),
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
	readonly checkpoint?: VerifiedCreatorCheckpointAttachment;
	readonly receivedCustody?: ReceivedCustody;
	readonly predecessorParametersBytes?: Uint8Array;
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

/** The bounded native inventory discovers receipt-only intents by their exact
 * local base. Epoch ordering never selects a successor or grants authority. */
async function readReceivedCustodyForNativeHead(
	input: Pick<CreatorAdoptionPendingRecoveryInput, "snapshotStore" | "pinnedGenesisAnchorDigest" | "proofAccounting">,
	head: PresentHead
): Promise<ReceivedCustody | null> {
	const inventory = await input.snapshotStore.captureRecoveryRoleInventory?.({objectId: head.objectId});
	if (inventory === undefined || (input.proofAccounting !== undefined && !input.proofAccounting.charge(encodeCanonical(inventory))))
		throw new TypeError("creator received recovery inventory is unavailable or exhausted");
	let selected: ReceivedCustody | null = null;
	const exactHead = encodeHeadRecordV1(head);
	for (const {scope} of inventory.scopes) {
		const custody = await readReceivedCustody(input, {objectId: scope.objectId, epoch: scope.epoch, currentAnchorDigest: scope.anchor});
		if (custody === null || !sameBytes(custody.certificate.exactCanonicalOldHeadBytes, exactHead)) continue;
		if (selected !== null && !sameBytes(selected.retained.exactReceivedCertificateBytes, custody.retained.exactReceivedCertificateBytes))
			throw new TypeError("creator received recovery intents conflict for the native head");
		selected = custody;
	}
	return selected;
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
): Promise<Awaited<ReturnType<typeof sealCreatorReceivedRecoveryReplay>>> {
	custody = context.receivedCustody ?? custody;
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
	const rawCandidates = context.checkpoint !== undefined ? proposedCandidates : [
		...currentCandidates.filter(
			({ ref, bytes }) =>
				(context.checkpoint === undefined ? !sameRef(ref, oldTrust.ref) &&
				!new Set(["drp-creator-author-settlement-state","drp-creator-issuance-retirement-state","drp-creator-author-issuance-frontiers-state"]).has(String(canonicalRecord(bytes)?.kind))
				: sameRef(ref, oldProjection.ref))
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
	const advance = context.checkpoint === undefined ? inspectCreatorTransitionAdvance({
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
	}) : {ok: inspectCreatorCheckpointTransition({checkpoint: context.checkpoint, localHead: currentHead,
		currentTrust: predecessorTrust, current: {candidates: currentCandidates, closure: currentGeneration.closure},
		proposed: {candidates: rawCandidates, closure: rawCandidates.map(({ref}) => ref)}}),
		proposed: {candidates: rawCandidates, closure: rawCandidates.map(({ref}) => ref)}};
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
				predecessorExactCanonicalLatchedAclBytes: context.checkpoint === undefined ? predecessorAclBytes :
					resolveCreatorCheckpointAttachment(context.checkpoint)!.remoteCheckpoint.exactCanonicalPredecessorAclBytes,
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
		exactCanonicalParametersCarrierBytes: context.predecessorParametersBytes ?? input.exactCanonicalParametersCarrierBytes,
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
	return replay;
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

/** Reopens the same received point proof for cold activation and interrupted
 * publication. Its local predecessor is always the actual native base. */
async function authenticateReceivedCheckpointCandidate(
	input: CreatorAdoptionPendingRecoveryInput,
	structure: NonNullable<ReturnType<typeof inspectCreatorAdoptionCandidateLineage>>,
	currentCandidates: RecoveredClosure["currentCandidates"],
	candidateCandidates: RecoveredClosure["currentCandidates"],
	expectedPrevious: CreatorAdoptionRoomHead,
	expectedNext: CreatorAdoptionRoomHead
): Promise<AuthenticatedPendingCandidate | undefined> {
	const {currentGeneration, currentHead, candidateGeneration: candidate, candidateHead} = structure;
	const currentCarrier = uniqueCandidateByKind(currentCandidates, "drp-anchor-trust-state");
	const targetCarrier = uniqueCandidateByKind(candidateCandidates, "drp-anchor-trust-state");
	const sourceProjection = uniqueCandidateByKind(currentCandidates, currentProjectionKind(expectedPrevious.epoch));
	const targetProjection = uniqueCandidateByKind(candidateCandidates, "v3-live-generation-2");
	const cut = uniqueCandidateByKind(candidateCandidates, "drp-hard-epoch-cut");
	const qc = uniqueCandidateByKind(candidateCandidates, "drp-seal-qc");
	const settlement = uniqueCandidateByKind(candidateCandidates, "drp-creator-author-settlement-state");
	if (currentCarrier === undefined || targetCarrier === undefined || sourceProjection === undefined || targetProjection === undefined ||
		cut === undefined || qc === undefined || settlement === undefined || expectedNext.epoch <= expectedPrevious.epoch + 1 ||
		cut.record.epoch !== expectedNext.epoch - 1 || cut.record.objectId !== expectedNext.objectId ||
		typeof cut.record.previousAnchor !== "string") return undefined;
	const custody = await readReceivedCustody(input, {objectId: expectedNext.objectId, epoch: Number(cut.record.epoch),
		currentAnchorDigest: cut.record.previousAnchor});
	const certificate = custody?.certificate;
	const point = certificate?.exactCanonicalReattachmentCheckpointBytes === undefined ? undefined :
		decodeCreatorReattachmentCheckpoint(certificate.exactCanonicalReattachmentCheckpointBytes);
	if (custody === null || certificate === undefined || point === undefined ||
		!sameBytes(certificate.exactCanonicalCutValueBytes, cut.bytes) || !sameBytes(certificate.exactCanonicalCommitQcBytes, qc.bytes) ||
		!sameBytes(certificate.exactCanonicalTrustStateRecordBytes, targetCarrier.bytes) ||
		certificate.exactCanonicalSettlementBytes === null || !sameBytes(certificate.exactCanonicalSettlementBytes, settlement.bytes)) return undefined;
	const opened = openCreatorCheckpointTrust({detachedGenesisSignature: input.detachedSignature,
		exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
		exactCanonicalCommitQcBytes: qc.bytes, exactCanonicalCurrentTrustStateRecordBytes: targetCarrier.bytes,
		exactCanonicalCutValueBytes: cut.bytes, exactCanonicalPredecessorTrustStateRecordBytes: point.exactCanonicalPredecessorTrustStateRecordBytes,
		expectedCurrentHead: expectedNext, expectedObjectId: expectedNext.objectId, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest});
	if (!opened.ok) return undefined;
	const sourceBytes = currentCarrier.record.exactCanonicalCurrentAnchorPreimageBytes,
		sourceSignature = currentCarrier.record.detachedCurrentAnchorSignature;
	if (!(sourceBytes instanceof Uint8Array) || !(sourceSignature instanceof Uint8Array)) return undefined;
	const predecessorTrust = openCreatorSettlementSourceTrust(opened.currentTrust, sourceBytes, sourceSignature,
		expectedPrevious.objectId, input.pinnedGenesisAnchorDigest);
	if (predecessorTrust === undefined || !sameRoomHead(roomHeadFromTrust(predecessorTrust), expectedPrevious) ||
		!sameBytes(currentCarrier.bytes, encodeCanonical({...targetCarrier.record,
			currentEpoch: predecessorTrust.currentEpoch, currentAnchorDigest: predecessorTrust.currentAnchorDigest,
			exactCanonicalCurrentAnchorPreimageBytes: sourceBytes, detachedCurrentAnchorSignature: sourceSignature}))) return undefined;
	const currentAnchor = canonicalRecord(sourceBytes);
	const targetAnchorBytes = targetCarrier.record.exactCanonicalCurrentAnchorPreimageBytes;
	const successorAnchor = targetAnchorBytes instanceof Uint8Array ? canonicalRecord(targetAnchorBytes) : undefined;
	if (currentAnchor === undefined || successorAnchor === undefined || sourceProjection.record.epoch !== expectedPrevious.epoch ||
		sourceProjection.record.objectId !== expectedPrevious.objectId || sourceProjection.record.blueprintDigest !== currentAnchor.blueprintDigest)
		return undefined;
	let predecessorAclBytes: Uint8Array | undefined, predecessorParametersBytes: Uint8Array | undefined;
	if (expectedPrevious.epoch === 0) {
		predecessorAclBytes = input.exactCanonicalGenesisLatchedAclBytes;
		predecessorParametersBytes = input.exactCanonicalParametersCarrierBytes;
	} else {
		const priorCut = uniqueCandidateByKind(currentCandidates, "drp-hard-epoch-cut");
		if (priorCut === undefined || priorCut.record.epoch !== expectedPrevious.epoch - 1) return undefined;
		const priorDeclaration = await input.snapshotStore.lookupRecoveryDeclaration({objectId: expectedPrevious.objectId,
			epoch: Number(priorCut.record.epoch), anchor: String(priorCut.record.previousAnchor), manifestDigest: String(priorCut.record.snapshotManifestDigest)});
		if (input.proofAccounting !== undefined && !input.proofAccounting.charge(encodeCanonical(priorDeclaration))) return undefined;
		if (priorDeclaration.kind !== "present" || priorDeclaration.state === "poisoned") return undefined;
		const priorSnapshot = await verifySnapshot({snapshotDeclaration: priorDeclaration.declaration, snapshotStore: input.snapshotStore},
			{cut: priorCut.record, successorTrust: predecessorTrust}, input.proofAccounting);
		if (priorSnapshot === undefined) return undefined;
		predecessorAclBytes = encodeCanonical(priorSnapshot.payload.acl);
		predecessorParametersBytes = encodeCanonical(priorCut.record.parameters);
	}
	if (predecessorAclBytes === undefined || predecessorParametersBytes === undefined ||
		hex(hashDomain("ts-drp/parameters/v3", predecessorParametersBytes)) !== currentAnchor.parametersDigest ||
		!openCanonicalLatchedAclSnapshot({exactCanonicalLatchedAclBytes: predecessorAclBytes, expectedAclDigest: String(currentAnchor.aclDigest),
			expectedEpoch: expectedPrevious.epoch, expectedObjectId: expectedPrevious.objectId, expectedProfileId: predecessorTrust.profileId}).ok) return undefined;
	const observation = await input.snapshotStore.lookupRecoveryDeclaration(custody.retained.scope);
	if (input.proofAccounting !== undefined && !input.proofAccounting.charge(encodeCanonical(observation))) return undefined;
	if (observation.kind !== "present" || observation.state === "poisoned") return undefined;
	const snapshot = await verifySnapshot({snapshotDeclaration: observation.declaration, snapshotStore: input.snapshotStore},
		{cut: cut.record, successorTrust: opened.currentTrust}, input.proofAccounting);
	if (snapshot === undefined) return undefined;
	const attachment = openCreatorCheckpointAttachment({localBaseHead: currentHead, localTrust: predecessorTrust,
		exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes, detachedGenesisSignature: input.detachedSignature,
		exactCanonicalReattachmentCheckpointBytes: certificate.exactCanonicalReattachmentCheckpointBytes,
		exactCanonicalCutValueBytes: cut.bytes, exactCanonicalCommitQcBytes: qc.bytes, exactCanonicalTrustStateRecordBytes: targetCarrier.bytes,
		exactCanonicalSnapshotManifestBytes: observation.declaration.exactCanonicalManifestBytes,
		exactCanonicalSnapshotPayloadBytes: snapshot.exactCanonicalPayloadBytes, exactCanonicalSettlementBytes: settlement.bytes});
	const attachmentIdentity = attachment.ok ? resolveCreatorCheckpointAttachment(attachment.capability) : undefined;
	if (!attachment.ok || attachmentIdentity === undefined) return undefined;
	const historyDigest = digestBlob(certificate.exactCanonicalHistoryBytes);
	if (!historyDigest.ok) return undefined;
	const proposedCandidates = [...attachmentIdentity.proofCandidates, sourceProjection,
		{bytes: certificate.exactCanonicalHistoryBytes, ref: {digest: historyDigest.value, byteLength: certificate.exactCanonicalHistoryBytes.byteLength}}]
		.sort((a, b) => a.ref.digest.localeCompare(b.ref.digest));
	if (!inspectCreatorCheckpointTransition({checkpoint: attachment.capability, localHead: currentHead, currentTrust: predecessorTrust,
		current: {candidates: currentCandidates, closure: currentGeneration.closure},
		proposed: {candidates: proposedCandidates, closure: proposedCandidates.map(({ref}) => ref)}})) return undefined;
	const chain: VerifiedChain = Object.freeze({currentAnchor, currentEpoch: expectedPrevious.epoch,
		checkpointPredecessorAnchor: canonicalRecord(readCreatorSettlementSourceAnchor(attachmentIdentity.remoteCheckpoint.predecessorTrust)!.anchorPreimage)!,
		currentCatalog: {artifactDigest: String(sourceProjection.record.artifactDigest), artifactId: String(sourceProjection.record.artifactId),
			blueprintDigest: String(sourceProjection.record.blueprintDigest), catalogDigest: String(sourceProjection.record.catalogDigest),
			runtimeProfile: String(sourceProjection.record.runtimeProfile)}, currentProjectionKind: currentProjectionKind(expectedPrevious.epoch),
		currentTrustRecord: currentCarrier.record, cut: cut.record, successorAnchor,
		successorAnchorBytes: targetAnchorBytes as Uint8Array, successorEpoch: expectedNext.epoch,
		successorTrust: attachmentIdentity.target.trust, successorTrustRecord: targetCarrier.record});
	if (verifiedCatalog(input.catalog, snapshot.payload.blueprintDigest, chain.currentCatalog) === undefined ||
		!creatorSnapshotProjectionMatches(targetProjection.record, successorAnchor, chain.successorTrust.currentAnchorDigest,
			observation.declaration.scope.manifestDigest, snapshot.manifest) ||
		hex(hashDomain("ts-drp/parameters/v3", encodeCanonical(cut.record.parameters))) !== successorAnchor.parametersDigest ||
		!matchesCreatorAdoptionReferences({pendingReferences: proposedCandidates.map(({ref}) => ref), predecessorLiveRef: sourceProjection.ref,
			exactCanonicalProjectionBytes: targetProjection.bytes, exactCanonicalCutValueBytes: cut.bytes,
			predecessorExactCanonicalLatchedAclBytes: attachmentIdentity.remoteCheckpoint.exactCanonicalPredecessorAclBytes}, candidate.closure))
		return undefined;
	return Object.freeze({closureDigest: candidateHead.closureDigest, generation: candidate, head: candidateHead,
		receivedContext: Object.freeze({checkpoint: attachment.capability, receivedCustody: custody, predecessorParametersBytes,
			currentGeneration, currentHead, currentCandidates, proposedCandidates, candidate, candidateHead, chain, predecessorTrust,
			predecessorAclBytes, snapshot})});
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
			if (expectedNext.epoch > expectedPrevious.epoch + 1) {
				return direct ? authenticateReceivedCheckpointCandidate(input, structure, currentCandidates, candidateCandidates,
					expectedPrevious, expectedNext) : undefined;
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
async function restoreLocalClosedAdoption(
	input: Parameters<typeof selectRetainedCreatorSuccessorAdoption>[0]
): ReturnType<typeof selectRetainedCreatorSuccessorAdoption> {
	const archive = input.archiveRecovery;
	const floor = input.roomHeadAuthority ?? archive?.roomHeadAuthority;
	if (floor === undefined) return null;
	const accounting = archive?.accounting ?? createCreatorClosedRollbackProofAccounting([], true);
	const parsed = parseStorageObjectId(input.expectedPreviousRoomHead.objectId);
	if (!parsed.ok) throw new TypeError("archive local close startup scope is invalid");
	const objectId = parsed.value;
	const floorScope = Object.freeze({ objectId, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest });
	const floorRead = floor.read.bind(floor);
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
	const captureQ = async (): Promise<LocalClosedAdoptionEvidence | undefined> => {
		let result: LocalClosedAdoptionEvidence | undefined;
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
	await checkNativeArchiveSource();
	if (Object.hasOwn(cut.record, "archiveAppend")) {
		if (archive === undefined) throw new TypeError("local close startup certified archive owner is unavailable");
		await completeCreatorCertifiedArchiveAppend({ archiveStore: archive.store, accounting, currentTrust: predecessorTrust,
			exactCanonicalCutValueBytes: cut.bytes, exactCanonicalCommitQcBytes: qc.bytes,
			exactCanonicalTrustStateRecordBytes: trust.bytes, checkCurrent: async (): Promise<void> => {
				await checkNativeArchiveSource();
				const fresh = await captureQ();
				if (fresh === undefined || !sameHead(fresh.head, closed.head) ||
					compareBytes(encodeCanonical(fresh.generation), encodeCanonical(closed.generation)) !== 0)
					throw new TypeError("archive local Q changed before its exact native archive readback");
			} });
	}
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
		/** Original room floor, also required to recover a local seal without archive storage. */
		roomHeadAuthority?: CreatorClosedRollbackDataInput["roomHeadAuthority"];
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
		const custodyInput = { ...input, ...(proofAccounting === undefined ? {} : { proofAccounting }) };
		const custody = reader.head.kind === "present" ? await readReceivedCustodyForNativeHead(custodyInput, reader.head) : null;
		const complete: Readonly<{ candidate: AuthenticatedPendingCandidate; next: CreatorAdoptionRoomHead }>[] = [];
		for (const generation of reader.generations) {
			if (generation.state !== "Complete") continue;
			const closure = await readClosure(generation.closure);
			const trust = closure === undefined ? undefined : uniqueCandidateByKind(closure, "drp-anchor-trust-state");
			if (typeof trust?.record.currentEpoch !== "number" || trust.record.currentEpoch <= previous.epoch) continue;
			const next = exactRoomHead({
				objectId: previous.objectId,
				epoch: trust.record.currentEpoch,
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
			const selected = complete[0]!, context = selected.candidate.receivedContext;
			if (context.checkpoint !== undefined) {
				if (reader.head.kind !== "present" || context.receivedCustody === undefined)
					throw new TypeError("creator retained checkpoint custody is unavailable");
				const recoveryInput = {...input, expectedNextRoomHead: selected.next, ...(proofAccounting === undefined ? {} : {proofAccounting})};
				const replay = await authenticateReceivedCandidateCustody(recoveryInput, context.receivedCustody, context, reader.head);
				const certificate = context.receivedCustody.certificate;
				const observation = await input.snapshotStore.lookupRecoveryDeclaration(context.receivedCustody.retained.scope);
				const history = openCreatorCloseHistory({bytes: certificate.exactCanonicalHistoryBytes,
					exactCanonicalCutValueBytes: certificate.exactCanonicalCutValueBytes,
					historyRoot: context.chain.cut.historyRoot, historySize: context.chain.cut.historySize});
				if (replay === undefined || history === undefined || observation.kind !== "present" || observation.state !== "verified" ||
					observation.retention !== "recovery") throw new TypeError("creator retained checkpoint proof is unavailable");
				const proof = context.proposedCandidates;
				const cut = uniqueCandidateByKind(proof, "drp-hard-epoch-cut")!, qc = uniqueCandidateByKind(proof, "drp-seal-qc")!,
					trust = uniqueCandidateByKind(proof, "drp-anchor-trust-state")!;
				const owner = Object.freeze({});
				const facts: SealedAdoptionFacts = Object.freeze({checkpoint: context.checkpoint, origin: "received",
					receivedCandidates: proof, receivedCandidateGenerationId: certificate.candidateGenerationId,
					receivedCandidateClosureDigest: certificate.candidateClosureDigest, ...(proofAccounting === undefined ? {} : {proofAccounting}),
					transition: {cutValueRef: cut.ref, commitQcRef: qc.ref, successorTrustRef: trust.ref, currentTrustRef: certificate.currentTrustRef,
						epoch: previous.epoch, successorEpoch: selected.next.epoch, successorAnchorDigest: selected.next.currentAnchorDigest},
					currentHead: context.currentHead, currentReferences: context.currentGeneration.closure, currentTrust: context.predecessorTrust,
					durableReplay: replay, exactCanonicalLatchedAclBytes: context.predecessorAclBytes,
					exactCanonicalParametersCarrierBytes: context.predecessorParametersBytes ?? input.exactCanonicalParametersCarrierBytes,
					exactCanonicalPinnedGenesisBootstrapOperationBytes: input.exactCanonicalPinnedGenesisBootstrapOperationBytes,
					history: {historyRoot: String(context.chain.cut.historyRoot), historySize: Number(context.chain.cut.historySize), historySnapshot: history},
					issuanceScope: {objectId: parsed.value, author: input.author}, issuanceStore: input.issuanceStore, liveJournalStore: input.liveJournalStore,
					objectId: parsed.value, proposedHead: context.currentHead, proposedReferences: proof.map(({ref}) => ref),
					snapshotDeclaration: observation.declaration, snapshotStore: input.snapshotStore, store: input.store,
					terminalizeSource: async () => {revokeCreatorAdoptionFacts(owner); return true;}});
				if (!installCreatorAdoptionFacts(owner, facts)) throw new TypeError("creator retained checkpoint provenance conflicts");
				const verified = await verifyCreatorSuccessorAdoption({handle: owner, catalog: input.catalog});
				if (!verified.ok || !(await reader.checkCurrency()).ok || !(await replay.verify())) {
					revokeCreatorAdoptionFacts(owner); throw new TypeError("creator retained checkpoint adoption authentication failed");
				}
				return Object.freeze({head: selected.next, received: Object.freeze({handle: owner, verified,
					releasePromotionDependencies: async () => {revokeCreatorAdoptionFacts(owner);}})});
			}
			return Object.freeze({ head: (complete[0] as (typeof complete)[number]).next });
		}
		if (custody === null) {
			const present = reader.head.kind === "present";
			await reader.release();
			readerReleased = true;
			return present ? restoreLocalClosedAdoption(input) : null;
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
		const remotePoint = certificate.exactCanonicalReattachmentCheckpointBytes === undefined ? undefined :
			decodeCreatorReattachmentCheckpoint(certificate.exactCanonicalReattachmentCheckpointBytes);
		if (certificate.exactCanonicalReattachmentCheckpointBytes !== undefined && (remotePoint === undefined || promoted))
			throw new TypeError("creator retained recovery checkpoint proof is invalid");
		const next = exactRoomHead({
			objectId: previous.objectId,
			epoch: remotePoint === undefined ? previous.epoch + 1 : successorRecord.currentEpoch,
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
		const remoteTrust = remotePoint === undefined ? undefined : openCreatorCheckpointTrust({
			detachedGenesisSignature: input.detachedSignature, exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
			exactCanonicalCommitQcBytes: certificate.exactCanonicalCommitQcBytes, exactCanonicalCutValueBytes: certificate.exactCanonicalCutValueBytes,
			exactCanonicalCurrentTrustStateRecordBytes: certificate.exactCanonicalTrustStateRecordBytes,
			exactCanonicalPredecessorTrustStateRecordBytes: remotePoint.exactCanonicalPredecessorTrustStateRecordBytes,
			expectedCurrentHead: next, expectedObjectId: parsed.value, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest});
		const localTrust = remoteTrust?.ok ? openCreatorSettlementSourceTrust(remoteTrust.currentTrust,
			oldTrust.record.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array,
			oldTrust.record.detachedCurrentAnchorSignature as Uint8Array, parsed.value, input.pinnedGenesisAnchorDigest) : undefined;
		const checkpoint = remotePoint !== undefined
			? remoteTrust?.ok && localTrust !== undefined && next.epoch > previous.epoch + 1 ?
				{ok: true as const, predecessorTrust: localTrust, currentTrust: remoteTrust.currentTrust} : {ok: false as const}
			: previous.epoch === 0
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
			cut.epoch !== retained.scope.epoch ||
			cut.previousAnchor !== retained.scope.anchor
		)
			throw new TypeError("creator retained recovery snapshot ownership differs");
		const receivedSnapshot = remotePoint === undefined ? undefined : await verifySnapshot(
			{snapshotDeclaration: observation.declaration, snapshotStore: input.snapshotStore},
			{cut, successorTrust: checkpoint.currentTrust}, proofAccounting);
		const attachment = remotePoint === undefined ? undefined : receivedSnapshot === undefined ? undefined : openCreatorCheckpointAttachment({
			localBaseHead: nativeHead, localTrust: checkpoint.predecessorTrust,
			exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes, detachedGenesisSignature: input.detachedSignature,
			exactCanonicalReattachmentCheckpointBytes: certificate.exactCanonicalReattachmentCheckpointBytes,
			exactCanonicalCutValueBytes: certificate.exactCanonicalCutValueBytes, exactCanonicalCommitQcBytes: certificate.exactCanonicalCommitQcBytes,
			exactCanonicalTrustStateRecordBytes: certificate.exactCanonicalTrustStateRecordBytes,
			exactCanonicalSnapshotManifestBytes: observation.declaration.exactCanonicalManifestBytes,
			exactCanonicalSnapshotPayloadBytes: receivedSnapshot.exactCanonicalPayloadBytes,
			exactCanonicalSettlementBytes: certificate.exactCanonicalSettlementBytes});
		const attachmentIdentity = attachment?.ok ? resolveCreatorCheckpointAttachment(attachment.capability) : undefined;
		if (remotePoint !== undefined && (attachment?.ok !== true || attachmentIdentity === undefined))
			throw new TypeError("creator retained recovery checkpoint attachment is invalid");
		const oldAnchor = canonicalRecord(oldTrust.record.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array);
		if (oldAnchor === undefined) throw new TypeError("creator retained recovery old anchor is invalid");
		let oldAcl = input.exactCanonicalGenesisLatchedAclBytes;
		let oldParameters = input.exactCanonicalParametersCarrierBytes;
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
			oldParameters = encodeCanonical(oldCut.record.parameters);
		}
		if (hex(hashDomain("ts-drp/latched-acl/v3", oldAcl)) !== oldAnchor.aclDigest ||
			hex(hashDomain("ts-drp/parameters/v3", oldParameters)) !== oldAnchor.parametersDigest)
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
			exactCanonicalParametersCarrierBytes: oldParameters,
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
		const proposedCandidates = (attachmentIdentity === undefined ? [
			...current.filter(
				({ ref, bytes }) =>
					!sameRef(ref, oldTrust.ref) && !new Set(["drp-creator-author-settlement-state","drp-creator-issuance-retirement-state","drp-creator-author-issuance-frontiers-state"]).has(String(canonicalRecord(bytes)?.kind))
			),
			...proof,
		] : [...attachmentIdentity.proofCandidates, oldProjection, proof.find(candidate =>
			sameBytes(candidate.bytes, certificate.exactCanonicalHistoryBytes))!]).sort((a, b) => a.ref.digest.localeCompare(b.ref.digest));
		const owner = Object.freeze({});
		let facts: SealedAdoptionFacts = Object.freeze({
			...(attachment?.ok === true ? {checkpoint: attachment.capability} : {}),
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
			exactCanonicalParametersCarrierBytes: oldParameters,
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
			objectId: retained.scope.objectId,
			epoch: retained.scope.epoch,
			anchor: retained.scope.anchor,
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
			expectedNext.epoch <= expectedPrevious.epoch
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
		let custody = await readReceivedCustody(input, expectedPrevious);
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
		const checkpointCustody = candidates.find(candidate => candidate.receivedContext.checkpoint !== undefined)?.receivedContext.receivedCustody;
		if (checkpointCustody !== undefined) custody = checkpointCustody;
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
