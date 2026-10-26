import { creatorSourceCustodyGeometryForSizing } from "./internal/creator-source-custody.js";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type AccumulatorSnapshot, type ArchiveLimits, type ClosedEpochArchive,
	deriveClosedEpochArchiveAppend, deriveCloseSetHistoryCommitment, measureArchiveAppendCapacityForSizing, type EpochVertex } from "@ts-drp/compaction";
import {
	type SnapshotVerificationReceipt,
	verifySnapshotStreamWithReceipt,
} from "@ts-drp/compaction/snapshot-quarantine-receipt";
import { inspectTrustClosure } from "@ts-drp/control-plane";
import type {
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
	DurableIssueSignContext,
	SettlementPlan,
} from "@ts-drp/issuance-store";
import {
	captureIssuanceNativeSignContext,
	type DurableIssuanceRetirementControl,
	encodeIssuanceRetirementControl,
	type IssuanceRetirementRows,
	issuanceUnsignedPostimageWidths,
} from "@ts-drp/issuance-store/maintenance";
import { type FinalitySigner, signCreatorIssuanceRetirementRequest } from "@ts-drp/keychain/finality";
import { encodeJournalRetirementControl, type DurableLiveJournalStore } from "@ts-drp/live-journal";
import { ANCHOR_TRUST_STATE_MAX_RECORD_BYTES, type CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import {
	completeCreatorAuthorIssuanceFrontiers,
	completeCreatorAuthorSettlement,
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND,
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES,
	CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL,
	CREATOR_AUTHOR_SETTLEMENT_KIND,
	CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES,
	type CreatorAuthorIssuanceFrontier,
	type CreatorAuthorSettlementFrontier,
	frontierFor,
	openCreatorAuthorIssuanceFrontiers,
	openCreatorAuthorSettlement,
	prepareCreatorAuthorIssuanceFrontiers,
	prepareCreatorAuthorSettlement,
	readCreatorAuthorIssuanceFrontiersForSizing,
	readCreatorAuthorSettlementForSizing,
	resolveCreatorAuthorIssuanceFrontiers,
	type VerifiedCreatorAuthorSettlement,
} from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import {
	openCreatorForwardPromotionSuccessorTrust,
	openCreatorSuccessorTrust,
	prepareCreatorClose,
	prepareCreatorForwardPromotion,
	readPreparedCreatorSuccessorAnchorForSizing,
} from "@ts-drp/protocol-v3/creator-close";
import {
	completeCreatorIssuanceRetirement,
	CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL,
	CREATOR_ISSUANCE_RETIREMENT_KIND,
	CREATOR_ISSUANCE_RETIREMENT_MAX_RECORD_BYTES,
	CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE,
	openCreatorIssuanceRetirement,
	prepareCreatorIssuanceRetirement,
	readCreatorIssuanceRetirementForSizing,
	resolveCreatorIssuanceRetirement,
} from "@ts-drp/protocol-v3/creator-issuance-retirement";
import {
	captureCreatorSnapshotRecoveryRoles,
	type CreatorSnapshotRecoveryRoles,
	type ForwardPromotion,
} from "@ts-drp/protocol-v3/internal/creator-forward-promotion";
import {
	bindCreatorIssuanceRetirementSigningRequest,
	captureCreatorIssuanceRetirementSigningContext,
	type CreatorIssuanceRetirementSigningRequest,
	scopeCreatorIssuanceRetirementSigningRequest,
} from "@ts-drp/protocol-v3/internal/creator-issuance-retirement-signing-request";
import type {
	SigningNativeAdmissionFactory,
	SigningRequestScope,
} from "@ts-drp/protocol-v3/internal/seal-signing-request";
import {
	authorizeLatchedApplicationWrite,
	type LatchedAclSnapshot,
	openCanonicalLatchedAclSnapshot,
} from "@ts-drp/protocol-v3/latched-acl";
import { SEAL_CANONICAL_RECORD_MAX_BYTES } from "@ts-drp/protocol-v3/seal";
import { settlementProfileFor } from "@ts-drp/protocol-v3/settlement-profile";
import {
	decodeSnapshotManifest,
	encodeSnapshotTransfer,
	type SnapshotTransferProfile,
} from "@ts-drp/protocol-v3/snapshot-transfer";
import type { SealStorePort } from "@ts-drp/seal";
import {
	acquireCreatorSigningDependenciesForPreparation,
	createCreatorSealActor,
	type CreatorCloseSigningFrameWidth,
	type CreatorSigningDependencyRead,
	type CreatorSigningDependencyPreparation,
	type CreatorSigningRetirementOwners,
	readCreatorCloseSigningFramesForSizing,
} from "@ts-drp/seal/creator";
import { mintSealVoterEnrollment, nativeSigningAdmissionFactory } from "@ts-drp/seal/internal/storage-port";
import {
	AHE_BOUNDED_READ_LIMITS,
	type ArchiveAppendDeclaration,
	type ArchiveCapacityDeclaration,
	type ArchiveCapacityPromise,
	type ArchiveStorageStatus,
	type ArchiveIndexPosition,
	type ArchivePreparedAppend,
	type ArchiveStorage,
	type AheBoundedRecoveryRoleStore,
	type AheDurableStore,
	digestBlob,
	digestClosure,
	type GenerationId,
	type GenerationRecord,
	type GenerationRef,
	type NativeReadReservation,
	parseGenerationId,
	type PresentHead,
} from "@ts-drp/storage";
import { snapshotQuarantineContract, type SnapshotQuarantineDeclaration, type SnapshotQuarantineStore, type SnapshotRecoveryStore } from "@ts-drp/storage/snapshot-transfer";

import { beginForegroundWork, createWorkCheckpoint, runInBackgroundLane, yieldToHost } from "./internal/cooperative-work.js";
import {
	createCreatorAuthenticatedNativeFuture,
	installCreatorAdoptionFacts,
	revokeCreatorAdoptionFacts,
} from "./internal/creator-adoption-intent.js";
import {
	CREATOR_CLOSE_HISTORY_KIND,
	CREATOR_CLOSE_HISTORY_MAX_BYTES,
	encodeCreatorCloseHistory,
} from "./internal/creator-close-history.js";
import {
	acquireCreatorForwardPromotionSource,
	acquireCreatorIssuanceMaintenanceProof,
	acquireCreatorOrdinaryIssuanceMaintenanceProof,
	captureCreatorOrdinaryIssuanceProofSource,
	captureCreatorOrdinaryIssuanceProofSourceForFence,
	prepareCreatorOrdinaryIssuanceProofSourceReadiness,
	captureCreatorOrdinaryFinishingWindowLimitsForSizing,
	creatorOrdinaryIssuanceSourceReadinessPrepared,
	captureCreatorOrdinaryAcceptedResourceUpdateForSizing,
	creatorCloseRecoveryRoleSourceRelation,
	creatorCloseRecoveryRoleClassifiedScopesForSizing,
	creatorCloseRecoveryRoleInventoryScopesForSizing,
	isCreatorOrdinarySourceCapacityRefusal,
	reserveCreatorOrdinaryFinishingCapacity,
	captureCreatorOrdinaryFinishingCapacityTemplate,
	evaluateCreatorOrdinaryFinishingCapacityTemplate,
	acquireCreatorLocalSessionWithdrawal,
	type CreatorLocalSessionWithdrawal,
	consumeCreatorRecoverySourceRetirement,
	type CreatorClosedRollbackDataInput,
	type CreatorForwardPromotionSourceMaterial,
	type CreatorIssuanceMaintenanceProof,
	type CreatorIssuanceMaintenancePreparationData,
	type CreatorOrdinaryIssuanceMaintenanceProof,
	type CreatorOrdinaryIssuanceSuffixForSizing,
	type CreatorOrdinaryIssuanceProofSource,
	type CreatorOrdinaryIssuanceSourceMaterial,
	type CreatorSnapshotRetirementReconstructionRequest,
	readProspectiveCreatorMaintenancePrefixesForSizing,
	readCreatorOrdinaryFinishingCapacityForSizing,
	readCreatorOrdinaryPreimageCapacityForSizing,
	readProspectiveCreatorSnapshotTurnoverForSizing,
	createCreatorSnapshotRecoveryMaintenanceJob,
	reconcileCreatorRoomRetentionFromLedger,
	reconcileCreatorSnapshotRecoveryRoles,
	resolveCreatorForwardPromotionSource,
} from "./internal/creator-closed-rollback-data.js";
import { deriveCreatorIssuanceRetirementBoundary } from "./internal/creator-issuance-retirement-boundary.js";
import {
	creatorSnapshotCatalogIdentity,
	encodeCreatorSuccessorProjection,
	verifiedCreatorSnapshotCatalog,
} from "./internal/creator-snapshot-data.js";
import { captureCreatorRoomHeadState } from "./internal/creator-room-head.js";
import {
	inspectCreatorTransitionAdvance,
	openCreatorForwardPromotion,
	openCreatorSnapshotRecoveryRoleTransfer,
	resolveCreatorForwardPromotion,
	resolveCreatorSnapshotRecoveryRoleTransfer,
	type VerifiedCreatorForwardPromotion,
} from "./internal/creator-transition-advance.js";
import {
	type CreatorCloseRuntimeReleaseCensus,
	type CreatorCloseRuntimeReleasePlan,
	type CreatorOrdinaryIssuanceRuntimeHold,
	type CreatorOrdinaryApplicationResourceBoundReader,
	type CreatorOrdinaryFinishingWindowLimits,
	type CreatorSnapshotRecoveryCloseHold,
	installCreatorCloseRuntimeRelease,
	resolveCreatorOrdinaryIssuanceRuntimeHold,
	releaseCreatorOrdinaryIssuanceRuntimeHold,
	resolveCreatorReceivedAppendSizing,
	resolveCreatorSnapshotRecoveryCloseHold,
} from "./internal/runtime-reclamation.js";
import type { V3PlaneHandle } from "./v3-live.js";
import {
	captureCreatorEarlyTurnoverToken,
	creatorCloseRetirementResumeRequired,
	creatorRecoveryPoolPressure,
	type CreatorEarlyTurnoverToken,
	type CreatorRecoveryPoolResult,
} from "./internal/creator-recovery-pool.js";
import { encodeCreatorCloseMembership } from "./internal/creator-close-membership.js";

const PROFILE: SnapshotTransferProfile = Object.freeze({
	maxManifestBytes: 212_387,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
const CREATOR_CLOSE_RECORD_CEILINGS: Readonly<Record<string, number>> = Object.freeze({
	"drp-anchor-trust-state": ANCHOR_TRUST_STATE_MAX_RECORD_BYTES,
	[CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND]: CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES,
	[CREATOR_AUTHOR_SETTLEMENT_KIND]: CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES,
	[CREATOR_ISSUANCE_RETIREMENT_KIND]: CREATOR_ISSUANCE_RETIREMENT_MAX_RECORD_BYTES,
	[CREATOR_CLOSE_HISTORY_KIND]: CREATOR_CLOSE_HISTORY_MAX_BYTES,
	"drp-hard-epoch-cut": SEAL_CANONICAL_RECORD_MAX_BYTES,
	"drp-seal-qc": SEAL_CANONICAL_RECORD_MAX_BYTES,
});
const LEGACY_ACL_MAX_RECORD_BYTES = 8192;
const SETTLEMENT_ACL_MAX_RECORD_BYTES = 65_536;
const LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED = "D110C_0C1F1_LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED";
const AUTHOR_REENTRY_PROOF_REQUIRED = "D110C_0C1F1_AUTHOR_REENTRY_PROOF_REQUIRED";
const bindings = new WeakMap<V3PlaneHandle, CreatorLiveCloseHandle>();
const runtimeReleaseOwners = new WeakMap<
	V3PlaneHandle,
	(() => CreatorCloseRuntimeReleasePlan | undefined) & {
		acceptRecoveryRetirement(observation: object): Promise<void>;
		borrowSigningDependencies(trusts: readonly CurrentAnchorTrust[], prepareData?: CreatorSigningDependencyPreparation): Promise<CreatorSigningDependencyRead>;
		captureSigningRetirementOwners(): CreatorSigningRetirementOwners;
		releaseHeaderCustodyForSuccessorInstall(): Promise<void>;
		prepareOrdinaryReadiness(): Promise<void>;
		holdIngressForReadiness(): Promise<(successful: boolean) => void>;
		maintainRecoveryPool(): Promise<CreatorRecoveryPoolResult>;
	}
>();
let creatorCloseRegistrationResolver: ((plane: V3PlaneHandle) => unknown) | undefined;

type CreatorTrustProjection = Readonly<{
	byzantineFaultTolerant: false;
	kind: "creator-certified";
	quorum: 1;
	signerCount: 1;
	text: "Creator-certified; one of one; not Byzantine-fault-tolerant.";
}>;

export type { CreatorRecoveryPoolResult } from "./internal/creator-recovery-pool.js";

export type CreatorLiveCloseStatus = Readonly<{
	closeAuthority: "available" | "unavailable";
	continuity: "continuous" | "relearning" | "stalled";
	lifecycle: "active" | "sealed" | "successor-adopted" | "successor-pending-adoption";
	trust: CreatorTrustProjection;
}>;

export type CreatorLiveCloseResult = Readonly<{
	closedVertexCount: number;
	commitQcRef: GenerationRef;
	currentTrustRef: GenerationRef;
	cutValueRef: GenerationRef;
	epoch: number;
	lifecycle: "successor-pending-adoption";
	ok: true;
	successorAnchorDigest: string;
	successorEpoch: number;
	successorTrustRef: GenerationRef;
}>;

export interface CreatorLiveCloseHandle {
	close(): Promise<CreatorLiveCloseResult>;
	/** Original charged proof custody only; not native terminal authority. */
	acquireLocalSessionWithdrawal(author: string): Promise<CreatorLocalSessionWithdrawal>;
	acquirePromotionCheckpoint(input: Readonly<{ closedEpoch: number }>): Promise<void>;
	releasePromotionDependencies(): Promise<void>;
	inspectDurableHead(): Promise<
		Readonly<{ head: PresentHead; references: readonly GenerationRef[]; trustRef: GenerationRef }>
	>;
	status(): CreatorLiveCloseStatus;
	stop(): Promise<void>;
}

export interface BindCreatorLiveCloseInput {
	/** Local archive custody only; shared validity/authority remains in the exact creator-certified Cut. */
	readonly archive?: Readonly<{ store: ArchiveStorage; limits: ArchiveLimits }>;
	/** Original room's pure settlement-plan/clock constructor, not authority. */
	readonly prospectiveSettlementPreview?: CreatorRoomSettlementPreview;
	/** Optional original application's pure local bound; never wire validity or proof credit. */
	readonly readOrdinaryApplicationResourceBound?: CreatorOrdinaryApplicationResourceBoundReader;
	/** Optional host-local finishing window, not shared operation validity. */
	readonly ordinaryFinishingWindow?: CreatorOrdinaryFinishingWindowLimits;
	readonly promotionContext?: Pick<
		CreatorClosedRollbackDataInput,
		"catalog" | "roomHeadAuthority" | "pinnedGenesisAnchorDigest" | "exactCanonicalPinnedGenesisTrustStateRecordBytes" | "signal"
	>;
	readonly evidenceStore: unknown;
	readonly exactCanonicalAvailabilityPolicyBytes: Uint8Array;
	onObservation(event: Readonly<Record<string, unknown>>): void;
	readonly plane: V3PlaneHandle;
	readonly signer: FinalitySigner;
	readonly snapshotStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
	readonly storageIncarnation: string;
	readonly voteStore: SealStorePort;
}

interface CreatorActor {
	acquireRecoveryDependencies(trusts: readonly CurrentAnchorTrust[]): Promise<CreatorSigningDependencyRead>;
	captureRetirementOwners(): CreatorSigningRetirementOwners;
	close(input: Readonly<{ closeInput: Readonly<Record<string, unknown>> }>): Promise<Readonly<Record<string, unknown>>>;
	status(): Readonly<{ readonly phase: string; readonly terminal: boolean }>;
	stop(): Promise<void>;
}

export interface CreatorCloseGraph {
	readonly authors: ReadonlyMap<string, Readonly<{ readonly author: string; readonly authorSequence: number }>>;
	readonly charges: ReadonlyMap<string, number>;
	readonly frontier: readonly string[];
	readonly vertices: ReadonlyMap<string, EpochVertex>;
}

/** Prospective bytes only; this is not a signed close or vertex capability. */
export interface CreatorIssuanceClosePreview {
	readonly graph: CreatorCloseGraph;
	readonly exactCanonicalPayloadBytes: Uint8Array;
	readonly exactCanonicalSuccessorAclBytes: Uint8Array;
	readonly applicationStateDigest: string;
}

/** Complete possible non-active census encodings; never authenticated successor material. */
export interface CreatorPostAdoptionCensusSizing {
	/** Mandatory successor work prepared by the SAME held source owner;
	 * lengths only, never signed target records or new ordinary capacity. */
	readonly archiveContinuationPreimageByteLengths?: readonly number[];
	/** Complete prepared current-epoch replacement jobs, still under the original source floor. */
	readonly currentContinuation?: Readonly<{
		journalAppends: readonly Readonly<{scope: Readonly<{objectId:string;epoch:number;anchorDigest:string}>;sourceKind:"local-issued";vertexDigest:string;author:string;authorSequence:number}>[];
		nativeJobPhases: readonly Readonly<{
			authorSequence:number;
			phase:"reserved"|"entered"|"final";
			canonicalUnsignedVertexByteLength:number;
			runtimeCensusOverheadByteLength:number;
			nativeRowsByteLength:number;
			nativeImageByteLength:number;
			nativeControlRevisionDelta:number;
		}>[];
	}>;
	/** Original current-floor source after candidate publication, before close maintenance. */
	readonly currentPublishedCensusSizing?: Readonly<{
		runtimeCensusOverheadByteLength: number;
		nativeRowsByteLength: number;
		nativeImageByteLength: number;
		nativeControlRevisionDelta: number;
		nativePlanRewriteResource?: Readonly<{byteLength: number; items: number; maxDepth: number}>;
	}>;
	readonly runtimeCensusOverheadByteLength: number;
	readonly nativeRowsByteLength: number;
	readonly nativeImageByteLength: number;
	/** Relative to immediate unsigned FINAL, including original ACKs and successor settlement writes. */
	readonly nativeControlRevisionDelta: number;
	/** Exact original plan shapes bound the optional atomic retirement carrier. */
	readonly nativePlanRewriteResource?: Readonly<{byteLength: number; items: number; maxDepth: number}>;
	/** Original terminal successor fence append; digest remains an unknown encoded-width leaf. */
	readonly successorJournalAppendForSizing?: Readonly<{ author: string; authorSequence: number }>;
	/** Transient original fence job states; never non-active/final source alternatives. */
	readonly nativeJobPhases?: readonly Readonly<{
		phase: "reserved" | "entered";
		/** Complete raw future unsigned sequence; no fabricated preimage. */
		canonicalUnsignedVertexByteLength: number;
		runtimeCensusOverheadByteLength: number;
		nativeRowsByteLength: number;
		nativeImageByteLength: number;
		nativeControlRevisionDelta: number;
	}>[];
}

/** Detached arithmetic inputs to the original room settlement constructor. */
export type CreatorRoomSettlementPreview = (
	input: Readonly<{
		scope: DurableIssueScope;
		successorEpoch: number;
		priorPlan: SettlementPlan | null;
		priorFenceEpoch: number | undefined;
		minimumLogicalTime: number;
	}>
) => Readonly<{ plan: SettlementPlan; fenceLogicalTime: number; continuationLogicalTime: number }>;

/** Original unsigned frontier readout; no signed checkpoint or admission grant. */
export interface CreatorPostAdoptionSettlementSizing {
	readonly frontiers: readonly CreatorAuthorSettlementFrontier[];
	readonly preview: CreatorRoomSettlementPreview;
	readonly planEffect?: NonNullable<DurableIssueCommit["planEffect"]>;
}

/** One original close-owner proof lease for one exact lexical native issue job. */
export interface CreatorIssuanceMaintenanceAdmission {
	readonly context: DurableIssueSignContext;
	/** Exact current journal CAS DATA from the same original proof. */
	readonly journalContext?: Readonly<{imageDigest: string; controlBytes: Uint8Array | null}>;
	/** Detached numerical obligations only, consumed after original native/graph
	 * acceptance. This method cannot admit, sign, charge, or begin a write. */
	accepted?(signed: Readonly<{exactCanonicalPreimageBytes: Uint8Array; detachedSignature: Uint8Array;
		exactCanonicalEpochVertexBytes: Uint8Array;
		nativeJournal?: Readonly<{imageDigest: string; controlBytes: Uint8Array | null}>}> | undefined): void;
	beginWrite(): Promise<void>;
	endWrite(): Promise<void>;
	release(): Promise<void>;
}
export type CreatorIssuanceMaintenanceConsumer = (
	candidate: Readonly<{kind: "local-issuance"; exactCanonicalUnsignedVertexBytes: Uint8Array;
		planEffect?: NonNullable<DurableIssueCommit["planEffect"]>; finishingSuffix?: CreatorOrdinaryIssuanceSuffixForSizing}> |
		Readonly<{kind: "received-append"; receipt: object}>
) => Promise<CreatorIssuanceMaintenanceAdmission>;

export interface V3CreatorCloseRegistration {
	readonly receiveOnly?: true;
	bindSnapshotReadinessOwner(store: SnapshotQuarantineStore<SnapshotVerificationReceipt>): boolean;
	beginReceived(): Promise<boolean>;
	terminalizeReceived(): boolean;
	sealRecoveryDependencies(required?: boolean): Promise<CreatorSnapshotRecoveryCloseHold | undefined>;
	/** Received queue gate and authentic native signing custody, not a local fold. */
	sealReceivedRecoveryDependencies(
		signing: import("@ts-drp/seal/creator").CreatorSigningRecoveryOwner,
		snapshots: import("@ts-drp/storage/snapshot-transfer").SnapshotRecoveryStore<SnapshotVerificationReceipt>
	): Promise<Readonly<{hold: CreatorSnapshotRecoveryCloseHold; readRetiredGenerations(): readonly GenerationRecord[]}> | undefined>;
	/** Explicit queued quiescent recipient boundary: the SAME received gate an
	 * install enters, reopened only after every admitted hold and release joined.
	 * `deferrable` reports an unavailable boundary before entry instead of halting.
	 * `resume` runs it only to discharge a durable reopen's completed-retirement
	 * halt, by the ORIGINAL reconstruction; it reports "deferred" when no such
	 * request matches. */
	runReceivedRecoveryMaintenance(
		signing: import("@ts-drp/seal/creator").CreatorSigningRecoveryOwner,
		snapshots: import("@ts-drp/storage/snapshot-transfer").SnapshotRecoveryStore<SnapshotVerificationReceipt>,
		consume: (seal: () => Promise<Readonly<{hold: CreatorSnapshotRecoveryCloseHold;
			readRetiredGenerations(): readonly GenerationRecord[]}>>, requireClosedWorkflowCompletion: boolean) => Promise<"complete">,
		options?: Readonly<{deferrable?: boolean; resume?: boolean}>
	): Promise<"ran" | "deferred">;
	/** Observational native head inspection in this plane's own queue, after the
	 * turns already queued. Queue turns hold the store's native writer reservation
	 * across awaits; the recovery read's synchronous BEGIN IMMEDIATE must never
	 * meet one, or it blocks the loop until the busy timeout and fails. Observation
	 * only: it grants no admission and enters no gate. */
	inspectQueuedNativeHead(): ReturnType<typeof inspectHead>;
	sealIssuanceMaintenanceDependencies(receivedReceipt?: object): Promise<CreatorSnapshotRecoveryCloseHold | undefined>;
	/** @internal Private live scheduling hint, read at each call: whether this registration now
	 * retains a cross-object migration source, whose census the ordinary warm source capture
	 * declines by design. Negative only: it may skip an OPTIONAL ordinary prime, and grants no
	 * admission, proof, credit or authority. A missing or failing hint keeps the original route. */
	hasMigrationSourceForOrdinaryPrime?(): boolean;
	/** Prepare bounded idle issuer metadata before the explicit cold readiness capture. */
	prepareOrdinaryNativeMetadataForReadiness(): Promise<void>;
	/** Scheduling request only: a recovery halt still requires the original
	 * authenticated reconciliation before a finishing window can be prepared. */
	needsOrdinaryReadinessRecovery(): boolean;
	/** Schedules the original queued drain of retained received work after a
	 * maintenance job that refused it has joined. Grants no admission. */
	resumePendingIngress(): void;
	/** Holds every arrival behind an ordinary readiness preparation (decision row
	 * 51), after the tasks already queued have finished. Resolves to the release,
	 * which the caller runs on every path. Grants no admission. */
	holdIngressForReadiness(): Promise<(successful: boolean) => void>;
	/** Explicit queued quiescent boundary, never a presign maintenance grant.
	 * `deferrable` reports an unavailable boundary before entry instead of halting. */
	runOrdinaryReadinessMaintenance(snapshots: SnapshotRecoveryStore<SnapshotVerificationReceipt>,
		consume: (seal: () => Promise<CreatorSnapshotRecoveryCloseHold>, requireClosedWorkflowCompletion: boolean) => Promise<"complete">,
		options?: Readonly<{deferrable?: boolean; after?: () => Promise<void>}>): Promise<"ran" | "deferred">;
	/** Fresh runtime custody only; source and native admission remain rollback-owned. */
	sealOrdinaryIssuanceMaintenanceRuntime(receivedReceipt?: object): Promise<CreatorOrdinaryIssuanceRuntimeHold | undefined>;
	/** Numerical dimensions from the original census field owner; never authority. */
	readOrdinaryRuntimeCapacityWidths(input: import("./v3-live.js").CreatorOrdinaryRuntimeCapacityWidthInput):
		ReturnType<typeof import("./v3-live.js").creatorOrdinaryRuntimeCapacityWidths>;
	readReceivedAppendCandidate(receipt: object): Readonly<{bytes: Uint8Array; signature: Uint8Array;
		/** Existing authenticated inherited/settlement work, not new ordinary admission. */
		protectedContinuation: boolean}>;
	prepareIssuanceContinuation(hold: CreatorSnapshotRecoveryCloseHold, exactCanonicalUnsignedVertexBytes: Uint8Array,
		planEffect: NonNullable<DurableIssueCommit["planEffect"]> | undefined,
		preview: CreatorRoomSettlementPreview | undefined): void;
	previewIssuanceClose(exactCanonicalUnsignedVertexBytes: Uint8Array, hold?: CreatorSnapshotRecoveryCloseHold): CreatorIssuanceClosePreview;
	previewOrdinaryIssuanceClose(exactCanonicalUnsignedVertexBytes: Uint8Array, hold: CreatorOrdinaryIssuanceRuntimeHold): CreatorIssuanceClosePreview;
	readProspectiveRuntimeCensusOverhead(
		hold: CreatorSnapshotRecoveryCloseHold,
		exactCanonicalUnsignedVertexBytes: Uint8Array
	): number;
	readProspectivePostAdoptionCensusSizing(
		hold: CreatorSnapshotRecoveryCloseHold,
		exactCanonicalUnsignedVertexBytes: Uint8Array,
		genuinePreparedClose: object,
		exactCanonicalSuccessorProjectionBytes: Uint8Array,
		settlement?: CreatorPostAdoptionSettlementSizing
	): readonly CreatorPostAdoptionCensusSizing[];
	installIssuanceMaintenanceConsumer(consumer: CreatorIssuanceMaintenanceConsumer): (() => void) | undefined;
	abortSnapshotStage(): boolean;
	readonly currentTrust: CurrentAnchorTrust;
	readonly retirementReconstruction?: CreatorSnapshotRetirementReconstructionRequest;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalParametersBytes: Uint8Array;
	readonly exactCanonicalPinnedGenesisBootstrapOperationBytes?: Uint8Array;
	readonly issuanceScope: DurableIssueScope;
	readonly issuanceStore: DurableIssuanceStore;
	/** Original native strategy's pure numerical obligation; no native capture. */
	readOrdinarySignMaterialByteLength?: typeof import("@ts-drp/issuance-store/maintenance").issuanceUnsignedOwnMaterialByteLength;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly maxEpochBytes: number;
	readonly maxEpochVertices: number;
	readonly objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0];
	readonly previousHistorySnapshot: AccumulatorSnapshot;
	readonly store: AheDurableStore;
	captureCloseGraph(): CreatorCloseGraph | undefined;
	stageSnapshot(): Promise<
		Readonly<
			| {
					readonly applicationStateDigest: string;
					readonly exactCanonicalPayloadBytes: Uint8Array;
					readonly kind: "exported";
					readonly ok: true;
			  }
			| { readonly detail: string; readonly kind: string; readonly ok: false }
		>
	>;
	sealDurableReplay(): Promise<
		| Readonly<{
				commitment?: Readonly<{ digest: string; rowCount: number; byteCharge: number }>;
				verify(): Promise<boolean>;
		  }>
		| undefined
	>;
	/** Retains exact authenticated source work before a gap or removal publication. */
	retainAcceptedSourceCustody(targetTrust: CurrentAnchorTrust, exactCanonicalTargetAclBytes: Uint8Array): Promise<Readonly<{ verify(): Promise<boolean> }>>;
	/** Fresh original local replay carriers, retained before historical issuance pruning.
	 * This supplies bytes to the closed-member witness, never independent authority. */
	captureClosedMembershipLocalWitnesses(): Promise<readonly Readonly<{
		vertexDigest: string;
		exactCanonicalPreimageBytes: Uint8Array;
		detachedSignature: Uint8Array;
	}>[] | undefined>;
	/** Recipient twin of the close-time membership capture, inside the held received
	 * gate: verifies transferred digest membership against the authenticated Cut,
	 * or derives it from this recipient's complete graph. Evidence, never authority.
	 * Decision row 60 (R5b): the successor's authenticated settlement record, when present,
	 * names each author's last row in the Cut; a hint for the candidate, never membership. */
	recordReceivedClosedMembership(
		exactCanonicalCutValueBytes: Uint8Array,
		exactCanonicalSettlementBytes?: Uint8Array | null,
		exactCanonicalCloseMembershipBytes?: Uint8Array,
		receivedAuthority?: import("./internal/creator-received-close-membership.js").ReceivedCloseAuthorityRecords
	): Promise<boolean>;
	/** Exact authenticated whole-source bytes, prepared and joined under this same genuine hold. */
	prepareClosedEpochArchive(hold: CreatorSnapshotRecoveryCloseHold, limits: ArchiveLimits,
		sharedAccounting?: import("./internal/creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting): Promise<ClosedEpochArchive | undefined>;
	/** Exact closed owner readout for OPTIONAL next-close activation. It does
	 * not confer target signing authority and never emits future preimages. */
	readArchiveCloseContinuationPreimageByteLengths?(hold: CreatorSnapshotRecoveryCloseHold,
		sharedAccounting: import("./internal/creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting): Promise<readonly number[]>;
	beginRetainedReplayClose(): (successful: boolean) => void;
	terminalize(
		sealed: Readonly<{
			predecessorHead: PresentHead;
			head: PresentHead;
			cutValueRef: GenerationRef;
			commitQcRef: GenerationRef;
			successorTrustRef: GenerationRef;
			borrowJournalHeaderCustody(): Promise<NativeReadReservation | undefined>;
		}>
	): boolean;
}

function archiveCapacityPromiseCovers(promise: ArchiveCapacityPromise,needed: ArchiveCapacityDeclaration): boolean {
	const {current,continuation,...basis} = promise.declaration;
	const {current:requiredCurrent,continuation:requiredContinuation,...requiredBasis} = needed;
	const covers = (bound: typeof current,required: typeof current): boolean =>
		bound.artifactBytes >= required.artifactBytes && bound.artifactCount >= required.artifactCount &&
		bound.indexEntries >= required.indexEntries && bound.maxArtifactBytes >= required.maxArtifactBytes;
	return compareBytes(encodeCanonical(basis),encodeCanonical(requiredBasis)) === 0 &&
		covers(current,requiredCurrent) && covers(continuation,requiredContinuation) &&
		promise.promiseDigest === hex(hashDomain("ts-drp-storage/archive-capacity-promise/v1",encodeCanonical(promise.declaration)));
}

/** Private close-owner preparation, not portable authority or permission to prune/release history. */
export async function prepareCreatorClosedArchiveAppend(input: Readonly<{
	registration: V3CreatorCloseRegistration;
	hold: CreatorSnapshotRecoveryCloseHold;
	archiveStore: ArchiveStorage;
	limits: ArchiveLimits;
	commitment: Awaited<ReturnType<typeof deriveCloseSetHistoryCommitment>>;
	/** Same genuine admission/maintenance ledger; never a parallel archive byte counter. */
	accounting: import("./internal/creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting;
}>): Promise<Readonly<{
	binding: Awaited<ReturnType<typeof deriveClosedEpochArchiveAppend>>["binding"];
	declaration: ArchiveAppendDeclaration;
	prepared: ArchivePreparedAppend;
}>> {
	const registration = input.registration, archiveStore = input.archiveStore, sourceHold = input.hold, accounting = input.accounting;
	const hold = resolveCreatorSnapshotRecoveryCloseHold(sourceHold, { store: registration.store,
		liveJournalStore: registration.liveJournalStore, currentTrust: registration.currentTrust });
	if (hold === undefined) throw new TypeError("archive append source custody is unavailable");
	const limits = decodeCanonical(encodeCanonical(input.limits, { maxBytes: 1024, maxDepth: 4, maxItems: 32 })) as unknown as ArchiveLimits;
	const expectedCommitment = Object.freeze({ anchorHash: input.commitment.anchorHash,
		closeSetRoot: input.commitment.closeSetRoot, historyRoot: input.commitment.historyRoot,
		historySize: input.commitment.historySize, closeSetCount: input.commitment.closeSetCount });
	const anchor = decodeCanonical(registration.exactCanonicalAnchorPreimageBytes);
	if (!plainRecord(anchor) || typeof anchor.archiveIndexRoot !== "string" || typeof anchor.historySize !== "number")
		throw new TypeError("archive append source anchor is unavailable");
	const sourceHistorySize = anchor.historySize;
	const perform = async () => {
	await hold.check();
	const status = await archiveStore.inspect();
	if (!accounting.charge(encodeCanonical(status))) throw new TypeError("archive source position full proof charge is exhausted");
	if (status.position.root !== anchor.archiveIndexRoot || status.position.lastOrdinal !== sourceHistorySize - 1)
		throw new TypeError("archive append source index differs from the certified complete prefix");
	const expected: ArchiveIndexPosition = Object.freeze({ ...status.position });
	const read = await archiveStore.acquireRead(expected);
	let append: Awaited<ReturnType<typeof deriveClosedEpochArchiveAppend>>;
	try {
		await hold.check();
		const previous = await read.readIndexFrontier();
		const last = previous.size === 0 ? undefined : (await read.readIndexPage({
			afterLeafIndex: previous.size === 1 ? null : previous.size - 2, limit: 1 }))[0];
		if (!accounting.charge(encodeCanonical(previous)) || (last !== undefined && !accounting.charge(encodeCanonical(last))))
			throw new TypeError("archive predecessor frontier/inclusion full proof charge is exhausted");
		if (previous.size !== 0 && (last === undefined || last.leafIndex !== previous.size - 1))
			throw new TypeError("archive append certified predecessor frontier is missing");
		const source = await registration.prepareClosedEpochArchive(sourceHold, limits, accounting);
		if (source === undefined || source.objectId !== registration.currentTrust.objectId ||
			source.epoch !== registration.currentTrust.currentEpoch || source.sourceAnchorDigest !== registration.currentTrust.currentAnchorDigest ||
			source.closeSetRoot !== expectedCommitment.closeSetRoot || source.historyRoot !== expectedCommitment.historyRoot ||
			source.historySize !== expectedCommitment.historySize || expectedCommitment.anchorHash !== source.sourceAnchorDigest ||
			expectedCommitment.closeSetCount !== source.historySize - sourceHistorySize)
			throw new TypeError("archive append differs from the original authenticated whole close");
		append = await deriveClosedEpochArchiveAppend({ archive: source, expectedPreviousRoot: expected.root,
			previousSnapshot: { size: previous.size, peaks: previous.peaks.map(peak => peak === null ? null : Uint8Array.from(peak)) },
			previousEndOrdinal: expected.lastOrdinal,
			...(last === undefined ? {} : { previousLastEntry: { exactCanonicalEntryBytes: last.exactCanonicalEntryBytes, proof: last.proof } }), limits });
		await hold.check();
		await read.check();
	} catch (cause) {
		try { await read.release(); } catch (cleanup) {
			throw new AggregateError([cause, cleanup], "archive source preparation and joined read release failed", { cause });
		}
		throw cause;
	}
	await read.release(); // Join the reserved predecessor read before the native write owner enters.
	const declaration: ArchiveAppendDeclaration = Object.freeze({ objectId: registration.currentTrust.objectId,
		pinnedGenesisAnchorDigest: registration.currentTrust.genesisAnchorDigest, sourceEpoch: append.binding.sourceEpoch,
		sourceAnchorDigest: append.binding.sourceAnchorDigest, sourceCloseSetRoot: append.binding.sourceCloseSetRoot,
		expected, targetRoot: append.binding.targetArchiveIndexRoot,
		artifacts: Object.freeze(append.artifacts.map(artifact => artifact.ref)), indexEntries: append.indexEntries });
	for (const bytes of [encodeCanonical(append.binding), encodeCanonical(declaration), ...append.artifacts.map(artifact => artifact.bytes)])
		if (!accounting.charge(bytes)) throw new TypeError("archive append full proof charge is exhausted before native effects");
	// A funded terminal author-fence may discharge old settlement without
	// promising endless new epochs. Choosing another close is a NEW activation
	// request: it must fund that exact successor continuation BEFORE Cut/QC sign.
	if (registration.readArchiveCloseContinuationPreimageByteLengths === undefined)
		throw new TypeError("archive next-close continuation owner is unavailable");
	const continuationLengths = await registration.readArchiveCloseContinuationPreimageByteLengths(sourceHold,accounting);
	const measuredContinuation = measureArchiveAppendCapacityForSizing({objectId:registration.currentTrust.objectId,
		epoch:registration.currentTrust.currentEpoch + 1,limits,
		records:continuationLengths.map((preimageByteLength,index) => ({ordinal:append.binding.historySize + index,preimageByteLength}))});
	const {segments:_segments,...continuation} = measuredContinuation;
	const current = {artifactBytes:append.artifacts.reduce((n,artifact) => n + artifact.bytes.byteLength,0),
		artifactCount:append.artifacts.length,indexEntries:append.indexEntries.length,
		maxArtifactBytes:Math.max(...append.artifacts.map(artifact => artifact.bytes.byteLength))};
	const capacityDeclaration: ArchiveCapacityDeclaration = {objectId:registration.currentTrust.objectId,
		pinnedGenesisAnchorDigest:registration.currentTrust.genesisAnchorDigest,sourceEpoch:registration.currentTrust.currentEpoch,
		sourceAnchorDigest:registration.currentTrust.currentAnchorDigest,expected,current,continuation};
	if (!accounting.charge(encodeCanonical(capacityDeclaration))) throw new TypeError("archive next-close capacity declaration full charge exhausted");
	await hold.check();
	const capacityPromise = await archiveStore.reserveCapacity(capacityDeclaration);
	if (!archiveCapacityPromiseCovers(capacityPromise,capacityDeclaration) || !accounting.charge(encodeCanonical(capacityPromise)))
		throw new TypeError("archive next-close exact capacity/readback full charge exhausted");
	await hold.check();
	const begun = await archiveStore.beginAppend(declaration);
	if (begun.phase === "committed") throw new TypeError("archive append activation requires authenticated durable recovery");
	for (const artifact of append.artifacts) {
		await hold.check();
		await archiveStore.writeArtifact({ intentDigest: begun.intentDigest, ref: artifact.ref, bytes: artifact.bytes });
	}
	await hold.check();
	const prepared = await archiveStore.prepareAppend(begun.intentDigest);
	if (!accounting.charge(encodeCanonical(begun)) || !accounting.charge(encodeCanonical(prepared)))
		throw new TypeError("archive native preparation readback full proof charge is exhausted");
	if (prepared.intentDigest !== begun.intentDigest || prepared.target.root !== append.binding.targetArchiveIndexRoot ||
		prepared.target.size !== append.binding.indexSize || prepared.target.revision !== expected.revision + 1 ||
		prepared.target.lastOrdinal !== append.binding.historySize - 1 ||
		prepared.verifiedArtifactBytes !== append.artifacts.reduce((total, artifact) => total + artifact.bytes.byteLength, 0))
		throw new TypeError("archive append native preparation disagrees with exact source-derived bytes");
	await hold.check();
	return Object.freeze({ binding: append.binding, declaration, prepared });
	};
	// The original dependency child admits the WHOLE archive preparation. Hold revocation
	// stops new checks, but native writes already entered are joined before custody releases.
	const dependency = await hold.borrowDependencies();
	let result: Awaited<ReturnType<typeof perform>> | undefined;
	try {
		await dependency.checkWhile(async () => { result = await perform(); });
	} catch (cause) {
		try { await dependency.release(); } catch (cleanup) {
			throw new AggregateError([cause, cleanup], "archive preparation and source-child release failed", { cause });
		}
		throw cause;
	}
	await dependency.release();
	await hold.check();
	if (result === undefined) throw new TypeError("archive preparation did not produce an exact native result");
	return result;
}

/**
 * Existing close/adoption owner completes or recovers a native append only after independently
 * authenticating its exact source-to-target Cut/QC/anchor. A native intent label is never authority.
 * checkCurrent is the existing owner's fresh whole native head/floor check, not a portable token.
 * accounting retains only the exact-byte union and prior charges. The originating proof may have
 * joined and released its native reservations: this ledger grants no custody, currency or authority.
 * Certification and every source/native-current check below therefore execute independently.
 */
export async function completeCreatorCertifiedArchiveAppend(input: Readonly<{
	archiveStore: ArchiveStorage;
	currentTrust: CurrentAnchorTrust;
	exactCanonicalCutValueBytes: Uint8Array;
	exactCanonicalCommitQcBytes: Uint8Array;
	exactCanonicalTrustStateRecordBytes: Uint8Array;
	checkCurrent(): Promise<void>;
	accounting: import("./internal/creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting;
}>): Promise<Readonly<{ position: ArchiveIndexPosition; exactCanonicalDeclarationBytes: Uint8Array }> | undefined> {
	const archiveStore = input.archiveStore, currentTrust = input.currentTrust, checkCurrent = input.checkCurrent, accounting = input.accounting;
	const cutBytes = snapshotQuarantineContract.captureExactBytes(input.exactCanonicalCutValueBytes, "archive certified Cut", SEAL_CANONICAL_RECORD_MAX_BYTES);
	const qcBytes = snapshotQuarantineContract.captureExactBytes(input.exactCanonicalCommitQcBytes, "archive certified QC", SEAL_CANONICAL_RECORD_MAX_BYTES);
	const trustBytes = snapshotQuarantineContract.captureExactBytes(input.exactCanonicalTrustStateRecordBytes, "archive certified successor", 8192);
	for (const bytes of [cutBytes, qcBytes, trustBytes]) if (!accounting.charge(bytes))
		throw new TypeError("archive certification full proof charge is exhausted");
	const cut = decodeCanonical(cutBytes);
	if (!plainRecord(cut)) throw new TypeError("archive certified Cut is unavailable");
	const open = Object.hasOwn(cut, "forwardPromotion") ? openCreatorForwardPromotionSuccessorTrust : openCreatorSuccessorTrust;
	const certified = open({ currentTrust, exactCanonicalCutValueBytes: cutBytes,
		exactCanonicalCommitQcBytes: qcBytes, exactCanonicalTrustStateRecordBytes: trustBytes });
	if (!certified.ok) throw new TypeError(`archive successor certification failed: ${certified.reason}`);
	if (!Object.hasOwn(cut, "archiveAppend")) return undefined;
	const binding = cut.archiveAppend as import("@ts-drp/protocol-v3/creator-close").CreatorArchiveAppendBinding;
	const artifacts: ArchiveAppendDeclaration["artifacts"][number][] = [], indexEntries: ArchiveAppendDeclaration["indexEntries"][number][] = [];
	for (const segment of binding.segments) {
		const descriptor = decodeCanonical(segment.exactCanonicalDescriptorBytes) as Record<string, unknown>;
		const segmentDigest = hex(hashDomain("ts-drp/archive-segment/v3", segment.exactCanonicalDescriptorBytes));
		const indexDigest = digestBlob(segment.exactCanonicalIndexEntryBytes);
		if (!indexDigest.ok) throw new TypeError("archive certified index digest is unavailable");
		const entry = Object.freeze({ kind: "index-entry" as const, digest: indexDigest.value, byteLength: segment.exactCanonicalIndexEntryBytes.byteLength });
		artifacts.push(Object.freeze({ kind: "segment" as const, digest: segmentDigest, byteLength: segment.exactCanonicalDescriptorBytes.byteLength }), entry);
		indexEntries.push(entry);
		for (const chunk of descriptor.chunks as Array<{ index: number; digest: string; byteLength: number }>)
			artifacts.push(Object.freeze({ kind: "chunk" as const, digest: chunk.digest, byteLength: chunk.byteLength,
				startOrdinal: descriptor.startOrdinal as number, chunkIndex: chunk.index }));
	}
	await checkCurrent();
	const retained = await archiveStore.readAppendDeclaration({ sourceEpoch: binding.sourceEpoch,
		sourceAnchorDigest: binding.sourceAnchorDigest, sourceCloseSetRoot: binding.sourceCloseSetRoot });
	if (retained === null) throw new TypeError("archive certified native intent is missing");
	const expected = retained.declaration.expected;
	const declaration: ArchiveAppendDeclaration = Object.freeze({ objectId: binding.objectId,
		pinnedGenesisAnchorDigest: currentTrust.genesisAnchorDigest, sourceEpoch: binding.sourceEpoch,
		sourceAnchorDigest: binding.sourceAnchorDigest, sourceCloseSetRoot: binding.sourceCloseSetRoot, expected,
		targetRoot: binding.targetArchiveIndexRoot, artifacts: Object.freeze(artifacts), indexEntries: Object.freeze(indexEntries) });
	if (expected.root !== binding.previousArchiveIndexRoot || expected.size !== binding.previousIndexSize ||
		expected.lastOrdinal !== binding.previousHistorySize - 1 ||
		compareBytes(encodeCanonical(declaration), encodeCanonical(retained.declaration)) !== 0 ||
		hex(hashDomain("ts-drp-storage/archive-append/v1", encodeCanonical(declaration))) !== retained.intentDigest)
		throw new TypeError("archive native intent is foreign or differs from the certified source/target bytes");
	if (!accounting.charge(encodeCanonical(retained))) throw new TypeError("archive native intent full proof charge is exhausted");
	// Exact bounded preparation, not a forecast bypass: capture/charge all actual declared bytes
	// under one fresh native position reservation before completing any new irreversible work.
	const before = await archiveStore.inspect();
	if (!accounting.charge(encodeCanonical(before))) throw new TypeError("archive precommit native status full proof charge is exhausted");
	const sourceRead = await archiveStore.acquireRead(before.position);
	try {
		for (const artifact of declaration.artifacts) if (!accounting.charge(await sourceRead.readArtifact(artifact)))
			throw new TypeError("archive artifact full proof charge is exhausted before commit");
		await checkCurrent();
		await sourceRead.check();
	} catch (cause) {
		try { await sourceRead.release(); } catch (cleanup) { throw new AggregateError([cause, cleanup], "archive charged preparation and release failed", { cause }); }
		throw cause;
	}
	await sourceRead.release();
	await checkCurrent();
	if (retained.phase !== "committed") {
		const prepared = await archiveStore.prepareAppend(retained.intentDigest);
		if (!accounting.charge(encodeCanonical(prepared))) throw new TypeError("archive certified preparation readback full proof charge is exhausted");
		if (prepared.target.root !== binding.targetArchiveIndexRoot || prepared.target.size !== binding.indexSize ||
			prepared.target.lastOrdinal !== binding.historySize - 1 || prepared.target.revision !== expected.revision + 1)
			throw new TypeError("archive prepared target differs from independently certified append");
		await checkCurrent();
	}
	// Exact same-intent completion/recovery is idempotent; unknown delivery is decided by native readback.
	let primary: unknown;
	if (retained.phase !== "committed") {
		try { await archiveStore.commitPreparedAppend({ intentDigest: retained.intentDigest, expected }); } catch (cause) { primary = cause; }
	}
	const status = await archiveStore.inspect();
	if (!accounting.charge(encodeCanonical(status))) throw new TypeError("archive committed native status full proof charge is exhausted");
	const target = status.position;
	if (target.root !== binding.targetArchiveIndexRoot || target.size !== binding.indexSize ||
		target.lastOrdinal !== binding.historySize - 1 || target.revision !== expected.revision + 1)
		throw new TypeError("archive certified commit did not reach its exact native target", { cause: primary });
	const read = await archiveStore.acquireRead(target);
	try {
		for (const artifact of declaration.artifacts) if (!accounting.charge(await read.readArtifact(artifact)))
			throw new TypeError("archive committed readback full proof charge is exhausted");
		await checkCurrent();
		await read.check();
	} catch (cause) {
		try { await read.release(); } catch (cleanup) { throw new AggregateError([cause, cleanup], "archive target readback and release failed", { cause }); }
		throw cause;
	}
	await read.release();
	await checkCurrent();
	// Detached mechanical data for the SAME owner's later readback; not a portable root receipt or custody.
	return Object.freeze({ position: Object.freeze({ ...target }), exactCanonicalDeclarationBytes: encodeCanonical(declaration) });
}

/** Newly created unsigned close snapshot only; historical snapshots/approvals are never rewritten. */
export function captureCreatorArchiveSnapshotTarget(input: Readonly<{
	exactCanonicalPayloadBytes: Uint8Array;
	applicationStateDigest: string;
	binding: import("@ts-drp/protocol-v3/creator-close").CreatorArchiveAppendBinding;
	accounting: import("./internal/creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting;
}>): Uint8Array {
	const source = snapshotQuarantineContract.captureExactBytes(input.exactCanonicalPayloadBytes, "archive source close snapshot", PROFILE.maxSnapshotBytes);
	const payload = decodeCanonical(source), binding = input.binding;
	if (!plainRecord(payload) || payload.objectId !== binding.objectId || payload.epoch !== binding.sourceEpoch ||
		payload.anchor !== binding.sourceAnchorDigest || payload.archiveIndexRoot !== binding.previousArchiveIndexRoot ||
		hex(hashDomain("ts-drp/state/v3", encodeCanonical(payload.application))) !== input.applicationStateDigest)
		throw new TypeError("archive close snapshot differs from its original source context or application state");
	const target = encodeCanonical({ ...payload, archiveIndexRoot: binding.targetArchiveIndexRoot }, { maxBytes: PROFILE.maxSnapshotBytes });
	if (!input.accounting.charge(source) || !input.accounting.charge(target))
		throw new TypeError("archive source/target snapshot full proof charge is exhausted");
	return target;
}

interface CreatorAdoptionFacts {
	readonly proofAccounting?: import("./internal/creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting;
	readonly certifiedRecoverySourceGenerations?: readonly GenerationRecord[];
	readonly classifiedRecoverySourceGenerations?: readonly GenerationRecord[];
	readonly origin: "local-close";
	readonly promotion?: Readonly<{
		verified: VerifiedCreatorForwardPromotion;
		source: CreatorForwardPromotionSourceMaterial;
		closedEpoch: number;
	}>;
	readonly transition: CreatorLiveCloseResult;
	readonly currentHead: PresentHead;
	readonly currentReferences: readonly GenerationRef[];
	readonly currentTrust: CurrentAnchorTrust;
	readonly durableReplay: Readonly<{ verify(): Promise<boolean> }>;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalPinnedGenesisBootstrapOperationBytes?: Uint8Array;
	readonly history: Awaited<ReturnType<typeof deriveCloseSetHistoryCommitment>>;
	readonly issuanceScope: DurableIssueScope;
	readonly issuanceStore: DurableIssuanceStore;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0];
	readonly proposedHead: PresentHead;
	readonly proposedReferences: readonly GenerationRef[];
	readonly snapshotDeclaration: SnapshotQuarantineDeclaration;
	readonly snapshotStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
	readonly sourceRuntimeHandle: WeakRef<object>;
	readonly store: AheDurableStore;
	terminalizeSource(): Promise<boolean>;
}

function claimCreatorCloseRegistration(plane: V3PlaneHandle): V3CreatorCloseRegistration | undefined {
	const registration = creatorCloseRegistrationResolver?.(plane);
	return plainRecord(registration) ? (registration as unknown as V3CreatorCloseRegistration) : undefined;
}

function verifiedCreatorTrustRecord(
	registration: Pick<V3CreatorCloseRegistration, "currentTrust">,
	exactCanonicalTrustStateRecordBytes: Uint8Array
): Readonly<Record<string, unknown>> | undefined {
	try {
		const record = decodeCanonical(exactCanonicalTrustStateRecordBytes);
		if (!plainRecord(record) || !(record.exactCanonicalSignerSetBytes instanceof Uint8Array)) return undefined;
		const signerSet = decodeCanonical(record.exactCanonicalSignerSetBytes);
		const profileId = typeof record.profileId === "string" ? record.profileId : "";
		return record.currentAnchorDigest === registration.currentTrust.currentAnchorDigest &&
			record.currentEpoch === registration.currentTrust.currentEpoch &&
			record.genesisAnchorDigest === registration.currentTrust.genesisAnchorDigest &&
			record.objectId === registration.currentTrust.objectId &&
			profileId === registration.currentTrust.profileId &&
			(profileId === "creator-trusted-v1" || settlementProfileFor(profileId) !== "none") &&
			record.quorum === 1 &&
			Array.isArray(signerSet) &&
			signerSet.length === 1
			? record
			: undefined;
	} catch {
		return undefined;
	}
}

function copiedRef(ref: GenerationRef): GenerationRef {
	return Object.freeze({ byteLength: ref.byteLength, digest: ref.digest });
}

function compareRef(left: GenerationRef, right: GenerationRef): number {
	return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function successfulValue<T>(value: unknown): T | undefined {
	if (!plainRecord(value) || value.ok !== true || !Object.hasOwn(value, "value")) return undefined;
	return value.value as T;
}

/**
 * Diagnostic spelling of a refused store result; never classifies or grants.
 * @param value - The store's original result.
 * @returns A bounded ": REASON[: cause]" suffix, or "" for anything else.
 */
function storeRefusalSuffix(value: unknown): string {
	if (!plainRecord(value) || value.ok !== false || typeof value.reason !== "string") return "";
	const cause = value.cause instanceof Error ? value.cause.message : undefined;
	return `: ${value.reason.slice(0, 64)}${cause === undefined ? "" : `: ${cause.slice(0, 256)}`}`;
}

function successfulUndefined(value: unknown): boolean {
	return plainRecord(value) && value.ok === true && Object.hasOwn(value, "value") && value.value === undefined;
}

function refFor(bytes: Uint8Array): GenerationRef {
	const digest = digestBlob(bytes);
	if (!digest.ok) throw new TypeError("creator close blob digest failed");
	return Object.freeze({ byteLength: bytes.byteLength, digest: digest.value });
}

function sameRef(left: GenerationRef, right: GenerationRef): boolean {
	return left.byteLength === right.byteLength && left.digest === right.digest;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type InspectedHead = Awaited<ReturnType<typeof inspectHead>>;

function uniqueRecordCandidate(
	candidates: InspectedHead["candidates"],
	kind: string,
	epoch?: number,
	phase?: string
): InspectedHead["candidates"][number] | undefined {
	const matches = candidates.filter((candidate) => {
		try {
			const value = decodeCanonical(candidate.bytes);
			const selectedEpoch =
				plainRecord(value) &&
				(value.kind === "drp-anchor-trust-state"
					? value.currentEpoch
					: value.kind === CREATOR_ISSUANCE_RETIREMENT_KIND || value.kind === CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND
						? value.closedEpoch
						: value.epoch);
			return (
				plainRecord(value) &&
				value.kind === kind &&
				(epoch === undefined || selectedEpoch === epoch) &&
				(phase === undefined || value.phase === phase)
			);
		} catch {
			return false;
		}
	});
	return matches.length === 1 ? matches[0] : undefined;
}

type RetirementInput = Readonly<{
	current: InspectedHead;
	currentTrust: CurrentAnchorTrust;
	cutValueDigest: string;
	durableReplay: Readonly<{ verify(): Promise<boolean> }>;
	graph: Exclude<ReturnType<V3CreatorCloseRegistration["captureCloseGraph"]>, undefined>;
	issuanceScope: DurableIssueScope;
	issuanceStore: DurableIssuanceStore;
	maxEpochVertices: number;
	qcRef: GenerationRef;
	signer: FinalitySigner;
	snapshotManifestDigest: string;
	successorTrust: CurrentAnchorTrust;
}>;
/**
 * Original signed predecessor facts; no prospective row or successor is authenticated here.
 * @param input - Original captured input facts.
 * @returns Original owner-derived bytes or sizing result; no authority is minted.
 */
function authenticatedPriorIssuanceRetirement(
	input: Pick<RetirementInput, "current" | "currentTrust" | "issuanceScope">
): Readonly<{
	priorAdmittedAuthorSequence: number | null;
	priorRetirementCandidateDigest: string;
	priorRef: GenerationRef | undefined;
}> {
	let priorAdmittedAuthorSequence: number | null = null;
	let priorRetirementCandidateDigest = CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL;
	let priorRef: GenerationRef | undefined;
	if (input.currentTrust.currentEpoch > 0) {
		const candidate = uniqueRecordCandidate(input.current.candidates, CREATOR_ISSUANCE_RETIREMENT_KIND);
		const cut = uniqueRecordCandidate(
			input.current.candidates,
			"drp-hard-epoch-cut",
			input.currentTrust.currentEpoch - 1
		);
		const qc = uniqueRecordCandidate(
			input.current.candidates,
			"drp-seal-qc",
			input.currentTrust.currentEpoch - 1,
			"commit"
		);
		if (candidate === undefined || cut === undefined || qc === undefined) {
			throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
		}
		const cutRecord = decodeCanonical(cut.bytes);
		if (!plainRecord(cutRecord) || typeof cutRecord.snapshotManifestDigest !== "string") {
			throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
		}
		const opened = openCreatorIssuanceRetirement({
			exactCanonicalRecordBytes: candidate.bytes,
			expectedCommitQcRef: qc.ref,
			expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)),
			expectedSnapshotManifestDigest: cutRecord.snapshotManifestDigest,
			floorTrust: input.currentTrust,
		});
		const identity = opened.ok ? resolveCreatorIssuanceRetirement(opened.capability) : undefined;
		if (identity === undefined || identity.author !== input.issuanceScope.author) {
			throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
		}
		priorAdmittedAuthorSequence = identity.admittedAuthorSequence;
		priorRetirementCandidateDigest = candidate.ref.digest;
		priorRef = candidate.ref;
	}
	return Object.freeze({ priorAdmittedAuthorSequence, priorRetirementCandidateDigest, priorRef });
}

async function deriveIssuanceRetirement(
	input: Omit<RetirementInput, "cutValueDigest" | "qcRef" | "signer" | "snapshotManifestDigest" | "successorTrust">
): Promise<
	Readonly<{
		boundary: Awaited<ReturnType<typeof deriveCreatorIssuanceRetirementBoundary>>;
		priorAdmittedAuthorSequence: number | null;
		priorRetirementCandidateDigest: string;
		priorRef: GenerationRef | undefined;
		author: string;
		admittedAuthorSequence: number;
	}>
> {
	if (!(await input.durableReplay.verify())) throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
	const { priorAdmittedAuthorSequence, priorRetirementCandidateDigest, priorRef } =
		authenticatedPriorIssuanceRetirement(input);
	const boundary = await deriveCreatorIssuanceRetirementBoundary({
		currentAnchorDigest: input.currentTrust.currentAnchorDigest,
		currentEpoch: input.currentTrust.currentEpoch,
		graphVertexDigests: input.graph.vertices,
		issuanceScope: input.issuanceScope,
		issuanceStore: input.issuanceStore,
		maxEpochVertices: input.maxEpochVertices,
		priorAdmittedAuthorSequence,
	});
	return Object.freeze({
		boundary,
		priorAdmittedAuthorSequence,
		priorRetirementCandidateDigest,
		priorRef,
		author: input.issuanceScope.author,
		admittedAuthorSequence: boundary.admittedAuthorSequence,
	});
}
type CreatorRetirementSigningCustody = Readonly<{
	scope: SigningRequestScope;
	admission: SigningNativeAdmissionFactory;
}>;

function signCreatorRetirementRequest(
	request: CreatorIssuanceRetirementSigningRequest,
	signer: FinalitySigner,
	custody: CreatorRetirementSigningCustody
): Promise<Uint8Array> {
	scopeCreatorIssuanceRetirementSigningRequest(request, custody.scope);
	bindCreatorIssuanceRetirementSigningRequest(request, custody.admission);
	return signCreatorIssuanceRetirementRequest({ request, signer });
}

async function issuanceRetirementCandidate(
	input: RetirementInput,
	signing: CreatorRetirementSigningCustody,
	derived = undefined as Awaited<ReturnType<typeof deriveIssuanceRetirement>> | undefined
): Promise<
	Readonly<{
		bytes: Uint8Array;
		ref: GenerationRef;
		priorRef?: GenerationRef;
		author: string;
		admittedAuthorSequence: number;
	}>
> {
	const { boundary, priorAdmittedAuthorSequence, priorRetirementCandidateDigest, priorRef } =
		derived ?? (await deriveIssuanceRetirement(input));
	const prepared = prepareCreatorIssuanceRetirement({
		admittedAuthorSequence: boundary.admittedAuthorSequence,
		author: input.issuanceScope.author,
		commitQcRef: input.qcRef,
		currentTrust: input.currentTrust,
		cutValueDigest: input.cutValueDigest,
		observedLineage: boundary.observedLineage,
		priorAdmittedAuthorSequence,
		priorRetirementCandidateDigest,
		snapshotManifestDigest: input.snapshotManifestDigest,
		successorTrust: input.successorTrust,
	});
	if (!prepared.ok) throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
	const signature = await signCreatorRetirementRequest(prepared.signingRequest, input.signer, signing);
	const completed = completeCreatorIssuanceRetirement({
		detachedSignature: signature,
		preparation: prepared.preparation,
	});
	if (!completed.ok) throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
	const ref = refFor(completed.exactCanonicalRecordBytes);
	return Object.freeze({
		admittedAuthorSequence: boundary.admittedAuthorSequence,
		author: input.issuanceScope.author,
		bytes: Uint8Array.from(completed.exactCanonicalRecordBytes),
		...(priorRef === undefined ? {} : { priorRef: copiedRef(priorRef) }),
		ref,
	});
}

function openedLatchedAcl(
	exactCanonicalLatchedAclBytes: Uint8Array,
	trust: CurrentAnchorTrust,
	expectedAclDigest: string
): LatchedAclSnapshot | undefined {
	const opened = openCanonicalLatchedAclSnapshot({
		exactCanonicalLatchedAclBytes,
		expectedAclDigest,
		expectedEpoch: trust.currentEpoch,
		expectedObjectId: trust.objectId,
		expectedProfileId: trust.profileId,
	});
	return opened.ok ? opened.snapshot : undefined;
}

function writeAuthorizedAuthors(snapshot: LatchedAclSnapshot): readonly string[] | undefined {
	const selected: string[] = [];
	for (const member of snapshot.members) {
		const authorized = authorizeLatchedApplicationWrite({ author: member.author, snapshot });
		if (!authorized.ok) return undefined;
		if (authorized.authorized) selected.push(member.author);
	}
	return Object.freeze(selected.sort());
}

function candidateAclDigest(candidate: Readonly<{ readonly bytes: Uint8Array }>): string {
	return hex(hashDomain("ts-drp/latched-acl/v3", candidate.bytes));
}

type AuthorFrontierInput = Readonly<{
	current: InspectedHead;
	currentAclDigest: string;
	currentExactAclBytes: Uint8Array;
	currentTrust: CurrentAnchorTrust;
	cutValueDigest: string;
	graph: Exclude<ReturnType<V3CreatorCloseRegistration["captureCloseGraph"]>, undefined>;
	issuanceScope: DurableIssueScope;
	issuanceStore: DurableIssuanceStore;
	legacy: Awaited<ReturnType<typeof issuanceRetirementCandidate>>;
	qcRef: GenerationRef;
	signer: FinalitySigner;
	snapshotManifestDigest: string;
	successorAclDigest: string;
	successorExactAclBytes: Uint8Array;
	successorTrust: CurrentAnchorTrust;
}>;
type AuthorFrontierDerivationInput = Omit<
	AuthorFrontierInput,
	"cutValueDigest" | "qcRef" | "signer" | "snapshotManifestDigest" | "successorTrust" | "legacy"
> &
	Readonly<{ legacy: Readonly<{ author: string; admittedAuthorSequence: number }> }>;
function successorLatchedAcl(
	input: Pick<AuthorFrontierInput, "successorExactAclBytes" | "currentTrust" | "successorAclDigest">
): LatchedAclSnapshot | undefined {
	const opened = openCanonicalLatchedAclSnapshot({
		exactCanonicalLatchedAclBytes: input.successorExactAclBytes,
		expectedAclDigest: input.successorAclDigest,
		expectedEpoch: input.currentTrust.currentEpoch + 1,
		expectedObjectId: input.currentTrust.objectId,
		expectedProfileId: input.currentTrust.profileId,
	});
	return opened.ok ? opened.snapshot : undefined;
}
async function deriveAuthorIssuanceFrontiers(
	input: AuthorFrontierDerivationInput,
	prospectiveAuthorSequence?: number
): Promise<
	Readonly<{
		frontiers: readonly CreatorAuthorIssuanceFrontier[];
		priorRef: GenerationRef | undefined;
	}>
> {
	const currentAcl = openedLatchedAcl(input.currentExactAclBytes, input.currentTrust, input.currentAclDigest);
	const successorAcl = successorLatchedAcl(input);
	const successorAuthors = successorAcl === undefined ? undefined : writeAuthorizedAuthors(successorAcl);
	if (currentAcl === undefined || successorAcl === undefined || successorAuthors === undefined) {
		throw new TypeError("creator issuance-frontier ACL authority is unavailable");
	}

	const aggregateCandidates = input.current.candidates.filter((candidate) => {
		try {
			return (
				(decodeCanonical(candidate.bytes) as Readonly<Record<string, unknown>>)?.kind ===
				CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND
			);
		} catch {
			return false;
		}
	});
	if (aggregateCandidates.length > 1 || (input.currentTrust.currentEpoch === 0 && aggregateCandidates.length !== 0)) {
		throw new TypeError("creator issuance-frontier candidate is ambiguous");
	}
	let priorIdentity: ReturnType<typeof resolveCreatorAuthorIssuanceFrontiers>;
	let priorRef: GenerationRef | undefined;
	if (aggregateCandidates.length === 1) {
		const candidate = aggregateCandidates[0] as (typeof aggregateCandidates)[number];
		const closedEpoch = input.currentTrust.currentEpoch - 1;
		const cut = uniqueRecordCandidate(input.current.candidates, "drp-hard-epoch-cut", closedEpoch);
		const qc = uniqueRecordCandidate(input.current.candidates, "drp-seal-qc", closedEpoch, "commit");
		const acl = uniqueRecordCandidate(input.current.candidates, "drp-v3-latched-acl", closedEpoch);
		const cutRecord = cut === undefined ? undefined : decodeCanonical(cut.bytes);
		if (cut === undefined || qc === undefined || acl === undefined || !plainRecord(cutRecord)) {
			throw new TypeError("creator issuance-frontier predecessor proof is unavailable");
		}
		const opened = openCreatorAuthorIssuanceFrontiers({
			exactCanonicalRecordBytes: candidate.bytes,
			expectedCommitQcRef: qc.ref,
			expectedCurrentAclDigest: candidateAclDigest(acl),
			expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)),
			expectedSnapshotManifestDigest: cutRecord.snapshotManifestDigest,
			expectedSuccessorAclDigest: input.currentAclDigest,
			floorTrust: input.currentTrust,
		});
		priorIdentity = opened.ok ? resolveCreatorAuthorIssuanceFrontiers(opened.capability) : undefined;
		if (priorIdentity === undefined) {
			throw new TypeError("creator issuance-frontier predecessor proof is invalid");
		}
		priorRef = candidate.ref;
	}

	const byAuthor = new Map<string, number[]>();
	const duplicateAuthors = new Set<string>();
	for (const identity of input.graph.authors.values()) {
		const sequences = byAuthor.get(identity.author) ?? [];
		if (sequences.includes(identity.authorSequence)) {
			if (identity.author === input.issuanceScope.author) {
				throw new TypeError("creator issuance-frontier author slot is ambiguous");
			}
			duplicateAuthors.add(identity.author);
			continue;
		}
		sequences.push(identity.authorSequence);
		byAuthor.set(identity.author, sequences);
	}
	for (const sequences of byAuthor.values()) sequences.sort((left, right) => left - right);

	const prior = new Map(priorIdentity?.frontiers ?? []);
	let localNext: number | undefined;
	if (successorAuthors.includes(input.issuanceScope.author)) {
		const lineage = await input.issuanceStore.readLineage(input.issuanceScope);
		if (lineage.exhausted !== false || !Number.isSafeInteger(lineage.next) || lineage.next < 0) {
			throw new TypeError("creator issuance-frontier local lineage is invalid");
		}
		localNext = lineage.next;
		if (prospectiveAuthorSequence !== undefined) {
			if (prospectiveAuthorSequence !== lineage.next || prospectiveAuthorSequence === Number.MAX_SAFE_INTEGER)
				throw new TypeError("prospective creator issuance-frontier lineage is unavailable");
			localNext = prospectiveAuthorSequence + 1;
		}
	}
	const frontiers: CreatorAuthorIssuanceFrontier[] = [];
	for (const author of successorAuthors) {
		const priorBoundary = prior.get(author);
		const sequences = byAuthor.get(author) ?? [];
		if (priorIdentity === undefined && author === input.legacy.author) {
			frontiers.push(Object.freeze([author, input.legacy.admittedAuthorSequence] as const));
			continue;
		}
		if (priorBoundary === undefined) {
			const observedNext = author === input.issuanceScope.author ? localNext : undefined;
			if ((sequences[0] ?? observedNext ?? 0) > 1) {
				throw new TypeError(
					priorIdentity === undefined ? LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED : AUTHOR_REENTRY_PROOF_REQUIRED
				);
			}
		}
		let boundary = priorBoundary ?? null;
		const firstObserved = sequences[0];
		if (duplicateAuthors.has(author)) {
			frontiers.push(Object.freeze([author, boundary] as const));
			continue;
		}
		if (boundary === null && firstObserved !== undefined && firstObserved > 1) {
			if (author === input.issuanceScope.author) {
				throw new TypeError(LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED);
			}
			frontiers.push(Object.freeze([author, boundary] as const));
			continue;
		}
		const minimum = boundary === null && firstObserved === 1 ? 1 : boundary === null ? 0 : boundary + 1;
		if (sequences.some((sequence) => boundary !== null && sequence <= boundary)) {
			if (author === input.issuanceScope.author) {
				throw new TypeError("creator issuance-frontier boundary regressed");
			}
			frontiers.push(Object.freeze([author, boundary] as const));
			continue;
		}
		let expected = minimum;
		for (const sequence of sequences) {
			if (sequence !== expected) break;
			boundary = sequence;
			expected += 1;
		}
		frontiers.push(Object.freeze([author, boundary] as const));
	}

	return Object.freeze({ frontiers: Object.freeze(frontiers), priorRef });
}
async function authorIssuanceFrontiersCandidate(
	input: AuthorFrontierInput,
	signing: CreatorRetirementSigningCustody,
	derived = undefined as Awaited<ReturnType<typeof deriveAuthorIssuanceFrontiers>> | undefined
): Promise<Readonly<{ bytes: Uint8Array; ref: GenerationRef; priorRef?: GenerationRef }>> {
	const { frontiers, priorRef } = derived ?? (await deriveAuthorIssuanceFrontiers(input));
	const prepared = prepareCreatorAuthorIssuanceFrontiers({
		commitQcRef: input.qcRef,
		currentAclDigest: input.currentAclDigest,
		currentTrust: input.currentTrust,
		cutValueDigest: input.cutValueDigest,
		frontiers,
		priorAggregateCandidateDigest: priorRef?.digest ?? CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
		snapshotManifestDigest: input.snapshotManifestDigest,
		successorAclDigest: input.successorAclDigest,
		successorTrust: input.successorTrust,
	});
	if (!prepared.ok) throw new TypeError("creator issuance-frontier preparation failed");
	const signature = await signCreatorRetirementRequest(prepared.signingRequest, input.signer, signing);
	const completed = completeCreatorAuthorIssuanceFrontiers({
		detachedSignature: signature,
		preparation: prepared.preparation,
	});
	if (!completed.ok) throw new TypeError("creator issuance-frontier completion failed");
	const ref = refFor(completed.exactCanonicalRecordBytes);
	return Object.freeze({
		bytes: Uint8Array.from(completed.exactCanonicalRecordBytes),
		...(priorRef === undefined ? {} : { priorRef: copiedRef(priorRef) }),
		ref,
	});
}

type SettlementInput = Omit<AuthorFrontierInput, "legacy"> & Readonly<{ historyRoot: string; historySize: number }>;
function deriveAuthorSettlement(
	input: Omit<SettlementInput, "cutValueDigest" | "qcRef" | "signer" | "snapshotManifestDigest" | "successorTrust">
): Readonly<{
	frontiers: readonly CreatorAuthorSettlementFrontier[];
	previous: ReturnType<typeof uniqueRecordCandidate>;
}> {
	const currentAcl = openedLatchedAcl(input.currentExactAclBytes, input.currentTrust, input.currentAclDigest);
	const successorAcl = successorLatchedAcl(input);
	if (currentAcl === undefined || successorAcl === undefined) {
		throw new TypeError("creator settlement ACL authority is unavailable");
	}
	const candidates = input.current.candidates.filter((candidate) => {
		try {
			return (decodeCanonical(candidate.bytes) as Record<string, unknown>).kind === CREATOR_AUTHOR_SETTLEMENT_KIND;
		} catch {
			return false;
		}
	});
	if (candidates.length !== (input.currentTrust.currentEpoch === 0 ? 0 : 1)) {
		throw new TypeError("creator settlement predecessor is unavailable");
	}
	const previous = candidates[0];
	let prior: VerifiedCreatorAuthorSettlement | undefined;
	if (previous !== undefined) {
		const epoch = input.currentTrust.currentEpoch - 1;
		const cut = uniqueRecordCandidate(input.current.candidates, "drp-hard-epoch-cut", epoch);
		const qc = uniqueRecordCandidate(input.current.candidates, "drp-seal-qc", epoch, "commit");
		const acl = uniqueRecordCandidate(input.current.candidates, "drp-v3-latched-acl", epoch);
		const cutRecord = cut === undefined ? undefined : decodeCanonical(cut.bytes);
		if (cut === undefined || qc === undefined || acl === undefined || !plainRecord(cutRecord)) {
			throw new TypeError("creator settlement predecessor proof is unavailable");
		}
		const opened = openCreatorAuthorSettlement({
			exactCanonicalRecordBytes: previous.bytes,
			expectedCommitQcRef: qc.ref,
			expectedCurrentAclDigest: candidateAclDigest(acl),
			expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)),
			expectedSnapshotManifestDigest: cutRecord.snapshotManifestDigest,
			expectedSuccessorAclDigest: input.currentAclDigest,
			floorTrust: input.currentTrust,
		});
		if (!opened.ok) throw new TypeError("creator settlement predecessor proof is invalid");
		prior = opened.capability;
	}
	const currentMembers = new Set(currentAcl.members.map(({ author }) => author));
	const byAuthor = new Map<string, Map<number, string>>();
	const duplicates = new Set<string>();
	for (const [digest, identity] of input.graph.authors) {
		const slots = byAuthor.get(identity.author) ?? new Map<number, string>();
		if (slots.has(identity.authorSequence)) duplicates.add(identity.author);
		slots.set(identity.authorSequence, digest);
		byAuthor.set(identity.author, slots);
	}
	const frontiers: CreatorAuthorSettlementFrontier[] = [];
	for (const { author } of successorAcl.members) {
		if (!currentMembers.has(author)) {
			frontiers.push(Object.freeze([author, input.currentTrust.currentEpoch + 1, null] as const));
			continue;
		}
		const previousFrontier = prior === undefined ? undefined : frontierFor(prior, author);
		if (prior !== undefined && previousFrontier === undefined) {
			throw new TypeError("creator settlement predecessor member is unavailable");
		}
		const admissionEpoch = previousFrontier?.[1] ?? 0;
		const slots = byAuthor.get(author) ?? new Map<number, string>();
		frontiers.push(deriveCreatorAuthorSettlementFrontier({author, issuanceAuthor: input.issuanceScope.author,
			admissionEpoch, boundary: previousFrontier?.[2] ?? null, slots, duplicate: duplicates.has(author),
			vertices: input.graph.vertices}));
	}
	return Object.freeze({ frontiers: Object.freeze(frontiers), previous });
}
/** Exact original successor slot law. DATA only: callers still establish the
 * authenticated predecessor, current graph/ACL and selected issuer context. */
export function deriveCreatorAuthorSettlementFrontier(input: Readonly<{
	author: string; issuanceAuthor: string; admissionEpoch: number; boundary: number | null;
	slots: ReadonlyMap<number, string>; duplicate: boolean; vertices: ReadonlyMap<string, Pick<EpochVertex, "operation">>;
}>): readonly [string, number, number | null] {
	const {author, issuanceAuthor, admissionEpoch, slots, duplicate, vertices} = input;
	let boundary = input.boundary;
	const regressed = [...slots.keys()].some(sequence => boundary !== null && sequence <= boundary);
	if (duplicate || regressed) {
		if (author === issuanceAuthor) throw new TypeError(duplicate
			? "creator issuance-frontier author slot is ambiguous" : "creator issuance-frontier boundary regressed");
	} else {
		for (const [sequence, digest] of slots) {
			const operation = vertices.get(digest)?.operation, fence = operation?.fenceSequence;
			if (operation?.action === "$drp.author-fence.v1" && operation.version === 1 &&
				typeof fence === "number" && Number.isSafeInteger(fence) && fence >= 0 && fence <= sequence &&
				(boundary === null || fence > boundary)) boundary = fence === 0 ? null : fence - 1;
		}
		let next = boundary === null ? 0 : boundary + 1;
		while (slots.has(next)) { boundary = next; next += 1; }
	}
	return Object.freeze([author, admissionEpoch, boundary] as const);
}

async function authorSettlementCandidate(
	input: SettlementInput,
	signing: CreatorRetirementSigningCustody,
	derived = undefined as Awaited<ReturnType<typeof deriveAuthorSettlement>> | undefined
): Promise<Readonly<{ bytes: Uint8Array; ref: GenerationRef; priorRef?: GenerationRef }>> {
	const { frontiers, previous } = derived ?? deriveAuthorSettlement(input);
	const prepared = prepareCreatorAuthorSettlement({
		commitQcRef: input.qcRef,
		currentAclDigest: input.currentAclDigest,
		currentTrust: input.currentTrust,
		cutValueDigest: input.cutValueDigest,
		frontiers,
		historyRoot: input.historyRoot,
		historySize: input.historySize,
		priorCheckpointDigest: previous?.ref.digest ?? CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL,
		priorCheckpointKind: previous === undefined ? "genesis" : "settled-v1",
		snapshotManifestDigest: input.snapshotManifestDigest,
		successorAclDigest: input.successorAclDigest,
		successorTrust: input.successorTrust,
	});
	if (!prepared.ok) throw new TypeError("creator settlement preparation failed");
	const detachedSignature = await signCreatorRetirementRequest(prepared.signingRequest, input.signer, signing);
	const completed = completeCreatorAuthorSettlement({ detachedSignature, preparation: prepared.preparation });
	if (!completed.ok) throw new TypeError("creator settlement completion failed");
	return Object.freeze({
		bytes: completed.exactCanonicalRecordBytes,
		ref: refFor(completed.exactCanonicalRecordBytes),
		...(previous === undefined ? {} : { priorRef: copiedRef(previous.ref) }),
	});
}

function canonicalUnsignedCountWidth(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("prospective encoding count is invalid");
	let length = 1;
	while (value >= 128) {
		value = Math.floor(value / 128);
		length++;
	}
	return length;
}

function canonicalUnknownBytesWidth(length: number): number {
	return 1 + canonicalUnsignedCountWidth(length) + length;
}

/**
 * Counts unknown leaves, never fabricating their contents or receiving dedup credit.
 * @param known - Original captured known facts.
 * @param unknown - Original captured unknown facts.
 * @returns Original owner-derived bytes or sizing result; no authority is minted.
 */
function canonicalProspectiveRecordWidth(
	known: Readonly<Record<string, unknown>>,
	unknown: Readonly<Record<string, number>>
): number {
	const knownKeys = Object.keys(known),
		unknownKeys = Object.keys(unknown);
	if (unknownKeys.some((key) => Object.hasOwn(known, key))) throw new TypeError("prospective encoding field overlaps");
	let width =
		encodeCanonical(known).byteLength -
		canonicalUnsignedCountWidth(knownKeys.length) +
		canonicalUnsignedCountWidth(knownKeys.length + unknownKeys.length);
	for (const key of unknownKeys) {
		const valueWidth = unknown[key];
		if (valueWidth === undefined || !Number.isSafeInteger(valueWidth) || valueWidth < 1)
			throw new TypeError("prospective encoding width is invalid");
		width += encodeCanonical(key).byteLength + valueWidth;
		if (!Number.isSafeInteger(width)) throw new TypeError("prospective encoding width overflow");
	}
	return width;
}

/**
 * Sizes only the original q=1 QC and successor trust codecs. The unknown
 * signature/digest strings are lengths, not fabricated votes, QCs or trust.
 * The Cut and successor anchor come from the original prepared-close owner;
 * actual QC verification and signing request preparation remain unchanged.
 * @param registration - Original captured registration facts.
 * @param currentTrustBytes - Original captured currentTrustBytes facts.
 * @param prepared - Original captured prepared facts.
 * @returns Original owner-derived bytes or sizing result; no authority is minted.
 */
export function prospectiveCreatorCloseCarrierWidths(
	registration: Pick<V3CreatorCloseRegistration, "currentTrust" | "objectId">,
	currentTrustBytes: Uint8Array,
	prepared: Extract<ReturnType<typeof prepareCreatorClose>, { ok: true }>
): Readonly<{
	prepareQcBytes: number;
	commitQcBytes: number;
	trustBytes: number;
	exactCanonicalAnchorPreimageBytes: Uint8Array;
	successorAnchorDigest: string;
}> {
	const trust = verifiedCreatorTrustRecord(registration, currentTrustBytes);
	if (
		trust === undefined ||
		!(trust.exactCanonicalSignerSetBytes instanceof Uint8Array) ||
		!(trust.exactCanonicalProfileBytes instanceof Uint8Array)
	)
		throw new TypeError("prospective creator trust codec facts are unavailable");
	const signers = decodeCanonical(trust.exactCanonicalSignerSetBytes);
	if (
		!Array.isArray(signers) ||
		signers.length !== 1 ||
		!plainRecord(signers[0]) ||
		typeof signers[0].signerId !== "string"
	)
		throw new TypeError("prospective creator q=1 codec is unavailable");
	const unsigned = readPreparedCreatorSuccessorAnchorForSizing({ close: prepared.close });
	if (!unsigned.ok) throw new TypeError(`prospective creator successor encoding failed: ${unsigned.reason}`);
	const digestWidth = encodeCanonical(prepared.valueDigest).byteLength;
	// Frozen QC signatures are hex strings of a 64-byte registered signature.
	const signatureHexWidth = 1 + canonicalUnsignedCountWidth(128) + 128;
	const voteWidth = canonicalProspectiveRecordWidth(
		{ signerId: signers[0].signerId },
		{ signature: signatureHexWidth, voteDigest: digestWidth }
	);
	const votesWidth = 1 + canonicalUnsignedCountWidth(1) + voteWidth;
	const qcWidth = (phase: "prepare" | "commit"): number =>
		canonicalProspectiveRecordWidth(
			{
				epoch: registration.currentTrust.currentEpoch,
				kind: "drp-seal-qc",
				objectId: registration.objectId,
				phase,
				proposalDigest: prepared.valueDigest,
				round: 0,
			},
			{ proposalHash: digestWidth, votes: votesWidth }
		);
	const trustBytes = canonicalProspectiveRecordWidth(
		{
			currentAnchorDigest: unsigned.anchorDigest,
			currentEpoch: registration.currentTrust.currentEpoch + 1,
			exactCanonicalCurrentAnchorPreimageBytes: unsigned.exactCanonicalAnchorPreimageBytes,
			exactCanonicalProfileBytes: trust.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: trust.exactCanonicalSignerSetBytes,
			genesisAnchorDigest: registration.currentTrust.genesisAnchorDigest,
			kind: "drp-anchor-trust-state",
			objectId: registration.objectId,
			profileId: registration.currentTrust.profileId,
			quorum: 1,
			version: 1,
		},
		{ detachedCurrentAnchorSignature: canonicalUnknownBytesWidth(64) }
	);
	return Object.freeze({
		prepareQcBytes: qcWidth("prepare"),
		commitQcBytes: qcWidth("commit"),
		trustBytes,
		exactCanonicalAnchorPreimageBytes: unsigned.exactCanonicalAnchorPreimageBytes,
		successorAnchorDigest: unsigned.anchorDigest,
	});
}

/**
 * Builds the original candidate fields before applying a native or prospective inventory.
 * @param registration - Original registered current authority.
 * @param recoverySource - Held original source material, including its nominal prior transfer.
 * @param manifestDigest - Original encoded snapshot identity.
 * @param hasPromotionContext - Original context used for the ordinary epoch-two seed.
 * @returns Candidate spelling only; the original role parser still validates it.
 */
function creatorCloseRecoveryRoleCandidates(
	registration: V3CreatorCloseRegistration,
	recoverySource: Pick<CreatorOrdinaryIssuanceSourceMaterial, "currentTrust" | "sources" | "protectedScopes" |
		"installedPromotionSource" | "hasRecoveryRoleTransfer">,
	manifestDigest: string,
	hasPromotionContext: boolean
): CreatorSnapshotRecoveryRoles {
	const epoch = registration.currentTrust.currentEpoch;
	const relation = creatorCloseRecoveryRoleSourceRelation(registration, recoverySource, hasPromotionContext);
	if (relation === undefined)
		throw new TypeError("creator recovery role transfer installed proof is unavailable");
	const installed = relation.installedPromotionSource ?? undefined;
	const sourceScope =
		installed === undefined
			? undefined
			: {
					objectId: registration.objectId,
					epoch: installed.closedEpoch,
					anchor: installed.closedAnchorDigest,
					manifestDigest: installed.manifestRef.digest,
				};
	const previousScope = relation.previousClose;
	return Object.freeze({
		kind: "creator-snapshot-recovery-roles",
		version: 1,
		genesisAnchorDigest: registration.currentTrust.genesisAnchorDigest,
		currentClose: {
			objectId: registration.objectId,
			epoch,
			anchor: registration.currentTrust.currentAnchorDigest,
			manifestDigest: manifestDigest,
		},
		previousClose: previousScope,
		operationalSources: installed === undefined ? [] : [installed],
		classifiedScopes: creatorCloseRecoveryRoleClassifiedScopesForSizing(recoverySource.protectedScopes, sourceScope, previousScope),
	});
}

/** Extracts spelling only from the original held source. Warm spelling comes
 * from its detached authenticated source material, never a forged capability. */
function creatorCloseRecoveryRoleFacts(source: CreatorForwardPromotionSourceMaterial):
	Parameters<typeof creatorCloseRecoveryRoleCandidates>[1] {
	const installed = source.installedPromotion === null ? undefined : resolveCreatorForwardPromotion(source.installedPromotion);
	if (source.installedPromotion !== null && installed === undefined)
		throw new TypeError("creator recovery role transfer installed proof is unavailable");
	return {currentTrust: source.currentTrust, sources: source.sources, protectedScopes: source.protectedScopes,
		installedPromotionSource: installed?.source ?? null, hasRecoveryRoleTransfer: source.recoveryRoleTransfer !== null};
}

function creatorCloseNeedsRecoveryRoles(registration: V3CreatorCloseRegistration, current: InspectedHead): boolean {
	const priorCut = current.candidates.map(candidate => decodeCanonical(candidate.bytes)).find(value =>
		plainRecord(value) && value.kind === "drp-hard-epoch-cut" && value.epoch === registration.currentTrust.currentEpoch - 1);
	return registration.currentTrust.currentEpoch >= 2 && (registration.currentTrust.currentEpoch === 2 ||
		plainRecord(priorCut) && (priorCut.forwardPromotion !== undefined || priorCut.recoveryRoles !== undefined));
}

/**
 * Applies exact inventory membership through the original bounded role parser.
 * @param candidates - Original shared candidate field constructor output.
 * @param inventoryScopes - Actual inventory or source-owned conditional sizing inventory.
 * @returns Captured role spelling, never snapshot-retirement authority.
 */
function creatorCloseRecoveryRoleSpelling(
	candidates: CreatorSnapshotRecoveryRoles,
	inventoryScopes: CreatorSnapshotRecoveryRoles["classifiedScopes"]
): CreatorSnapshotRecoveryRoles {
	const recoveryRoles = captureCreatorSnapshotRecoveryRoles({
		...candidates,
		classifiedScopes: creatorCloseRecoveryRoleInventoryScopesForSizing(candidates.classifiedScopes, inventoryScopes),
	});
	if (recoveryRoles === undefined) throw new TypeError("creator recovery role transfer classification is invalid");
	return recoveryRoles;
}

async function deriveCreatorCloseRecoveryRoles(
	registration: V3CreatorCloseRegistration,
	recoverySource: CreatorForwardPromotionSourceMaterial,
	snapshotStore: CreatorClosedRollbackDataInput["snapshotStore"],
	manifestDigest: string,
	hasPromotionContext: boolean
): Promise<CreatorSnapshotRecoveryRoles> {
	const candidates = creatorCloseRecoveryRoleCandidates(
		registration,
		creatorCloseRecoveryRoleFacts(recoverySource),
		manifestDigest,
		hasPromotionContext
	);
	if (snapshotStore.captureRecoveryRoleInventory === undefined)
		throw new TypeError("creator recovery role inventory is unavailable");
	const inventory = await snapshotStore.captureRecoveryRoleInventory({ objectId: registration.objectId });
	return creatorCloseRecoveryRoleSpelling(candidates, inventory.scopes.map((row) => row.scope));
}

/**
 * Detached original fold/export/close preparation; no snapshot or native writes.
 * @param registration - Original captured registration facts.
 * @param input - Original captured input facts.
 * @param current - Original captured current facts.
 * @param exactCanonicalUnsignedVertexBytes - Original captured exactCanonicalUnsignedVertexBytes facts.
 * @param maintenanceProof - Original held source for conditional turnover sizing.
 * @param recoverySource - Original captured recoverySource facts.
 * @returns Original owner-derived bytes or sizing result; no authority is minted.
 */
async function prepareProspectiveCreatorCloseMaterial(
	registration: V3CreatorCloseRegistration,
	input: BindCreatorLiveCloseInput,
	current: Awaited<ReturnType<typeof inspectHead>>,
	exactCanonicalUnsignedVertexBytes: Uint8Array,
	maintenanceProof: CreatorIssuanceMaintenanceProof,
	closeHold: CreatorSnapshotRecoveryCloseHold,
	recoverySource?: CreatorForwardPromotionSourceMaterial
): Promise<
	Readonly<{
		preview: CreatorIssuanceClosePreview;
		snapshot: ReturnType<typeof encodeSnapshotTransfer>;
		commitment: Awaited<ReturnType<typeof deriveCloseSetHistoryCommitment>>;
		prepared: Extract<ReturnType<typeof prepareCreatorClose>, { ok: true }>;
		widths: ReturnType<typeof prospectiveCreatorCloseCarrierWidths>;
	}>
> {
	const preview = registration.previewIssuanceClose(exactCanonicalUnsignedVertexBytes, closeHold);
	const turnover = recoverySource === undefined ? undefined : readProspectiveCreatorSnapshotTurnoverForSizing(maintenanceProof);
	if (turnover !== undefined && !turnover.ok) throw new TypeError(`prospective creator turnover refused: ${turnover.reason}`);
	const material = await prepareProspectiveCreatorCloseMaterialFromPreview(registration, input, current, preview,
		recoverySource === undefined || turnover === undefined || !turnover.ok ? undefined : {
			facts: creatorCloseRecoveryRoleFacts(recoverySource), survivingScopes: turnover.survivingScopes});
	await recoverySource?.checkCurrent();
	return material;
}

/** One original pure fold/export/close constructor for cold and warm custody. */
async function prepareProspectiveCreatorCloseMaterialFromPreview(
	registration: V3CreatorCloseRegistration,
	input: BindCreatorLiveCloseInput,
	current: Awaited<ReturnType<typeof inspectHead>>,
	preview: CreatorIssuanceClosePreview,
	recovery?: Readonly<{facts: Parameters<typeof creatorCloseRecoveryRoleCandidates>[1];
		survivingScopes: CreatorSnapshotRecoveryRoles["classifiedScopes"]}>
): Promise<Awaited<ReturnType<typeof prepareProspectiveCreatorCloseMaterial>>> {
	const anchor = decodeCanonical(registration.exactCanonicalAnchorPreimageBytes);
	const payload = decodeCanonical(preview.exactCanonicalPayloadBytes);
	if (
		!plainRecord(anchor) ||
		!plainRecord(payload) ||
		payload.acl === undefined ||
		typeof anchor.archiveIndexRoot !== "string" ||
		typeof anchor.blueprintDigest !== "string"
	)
		throw new TypeError("prospective creator snapshot identity is unavailable");
	const aclBytes = encodeCanonical(payload.acl);
	if (compareBytes(aclBytes, preview.exactCanonicalSuccessorAclBytes) !== 0)
		throw new TypeError("prospective creator successor ACL differs from the original fold");
	const aclDigest = hex(hashDomain("ts-drp/latched-acl/v3", aclBytes));
	const snapshot = encodeSnapshotTransfer({
		aclDigest,
		anchor: registration.currentTrust.currentAnchorDigest,
		epoch: registration.currentTrust.currentEpoch,
		objectId: registration.objectId,
		exactCanonicalPayloadBytes: preview.exactCanonicalPayloadBytes,
		stateDigest: preview.applicationStateDigest,
		profile: PROFILE,
		schemaVersion: 1,
	});
	const commitment = await deriveCloseSetHistoryCommitment({
		authenticatedCanonicalPreimageByteLengths: preview.graph.charges,
		exactCanonicalEpochAnchorPreimageBytes: registration.exactCanonicalAnchorPreimageBytes,
		frontier: preview.graph.frontier,
		vertices: preview.graph.vertices,
		maxEpochBytes: registration.maxEpochBytes,
		maxEpochVertices: registration.maxEpochVertices,
		previousHistorySnapshot: registration.previousHistorySnapshot,
	});
	const trustCandidate = current.candidates.find(({ ref }) => sameRef(ref, current.trustRef));
	const trust =
		trustCandidate === undefined ? undefined : verifiedCreatorTrustRecord(registration, trustCandidate.bytes);
	if (
		trustCandidate === undefined ||
		trust === undefined ||
		!(trust.exactCanonicalSignerSetBytes instanceof Uint8Array)
	)
		throw new TypeError("prospective creator current trust is unavailable");
	let recoveryRoles: CreatorSnapshotRecoveryRoles | undefined;
	if (recovery !== undefined) {
		recoveryRoles = creatorCloseRecoveryRoleSpelling(
			creatorCloseRecoveryRoleCandidates(
				registration,
				recovery.facts,
				snapshot.manifestDigest,
				input.promotionContext !== undefined
			),
			recovery.survivingScopes
		);
	}
	const prepared = prepareCreatorClose({
		aclDigest,
		archiveIndexRoot: anchor.archiveIndexRoot,
		blueprintDigest: anchor.blueprintDigest,
		closeReason: "creator-requested",
		closeSetCount: commitment.closeSetCount,
		closeSetRoot: commitment.closeSetRoot,
		currentTrust: registration.currentTrust,
		exactCanonicalAvailabilityPolicyBytes: input.exactCanonicalAvailabilityPolicyBytes,
		exactCanonicalNextSignerSetBytes: trust.exactCanonicalSignerSetBytes,
		exactCanonicalParametersBytes: registration.exactCanonicalParametersBytes,
		exactCanonicalSnapshotManifestBytes: snapshot.exactCanonicalManifestBytes,
		historyRoot: commitment.historyRoot,
		historySize: commitment.historySize,
		snapshotManifestDigest: snapshot.manifestDigest,
		stateDigest: preview.applicationStateDigest,
		...(recoveryRoles === undefined ? {} : { recoveryRoles }),
	});
	if (!prepared.ok) throw new TypeError(`prospective creator close preparation failed: ${prepared.reason}`);
	return Object.freeze({
		preview,
		snapshot,
		commitment,
		prepared,
		widths: prospectiveCreatorCloseCarrierWidths(registration, trustCandidate.bytes, prepared),
	});
}

/**
 * Uses the original signed predecessor and frontier owners for a byte quote.
 * The prospective ordinal is unsigned: this output is never a retirement
 * boundary, signing request or successor trust capability.
 * @param registration - Original captured registration facts.
 * @param current - Original captured current facts.
 * @param material - Original captured material facts.
 * @param nativeRows - Original captured nativeRows facts.
 * @param unsignedBytes - Original captured unsignedBytes facts.
 * @returns Original owner-derived bytes or sizing result; no authority is minted.
 */
async function prospectiveCreatorMetadataWidths(
	registration: V3CreatorCloseRegistration,
	current: InspectedHead,
	material: Awaited<ReturnType<typeof prepareProspectiveCreatorCloseMaterial>>,
	nativeRows: IssuanceRetirementRows,
	unsignedBytes: Uint8Array,
	received: ReturnType<typeof resolveCreatorReceivedAppendSizing>
): Promise<
	Readonly<{
		frames: readonly Readonly<{
			unsignedPreimageByteLength: number;
			signedRecordByteLength: number;
			priorRef?: GenerationRef;
		}>[];
		settlementFrontiers?: readonly CreatorAuthorSettlementFrontier[];
	}>
> {
	const unsigned = decodeCanonical(unsignedBytes);
	// A received candidate contributes its authenticated foreign graph identity,
	// not a new ordinal in the creator's native issuance lineage. Only the held
	// admission owner can supply that distinction and the actual local cursor.
	if (
		!plainRecord(unsigned) ||
		typeof unsigned.authorSequence !== "number" ||
		(received === undefined && unsigned.author !== registration.issuanceScope.author) ||
		(received !== undefined && (received.localIssuerBasis.author !== registration.issuanceScope.author ||
			received.localIssuerBasis.objectId !== registration.objectId)) ||
		unsigned.objectId !== registration.objectId ||
		unsigned.epoch !== registration.currentTrust.currentEpoch ||
		unsigned.anchor !== registration.currentTrust.currentAnchorDigest
	)
		throw new TypeError("prospective creator metadata identity is unavailable");
	const sequence = received === undefined ? unsigned.authorSequence : received.localIssuerBasis.nextAuthorSequence - 1;
	const lineage = nativeRows.lineages.find((row) => row.author === registration.issuanceScope.author);
	if (
		!Number.isSafeInteger(sequence) ||
		sequence < 0 ||
		sequence === Number.MAX_SAFE_INTEGER ||
		(lineage?.next ?? 0) !== sequence + Number(received !== undefined) ||
		lineage?.exhausted === true ||
		(received !== undefined && (lineage === undefined || lineage.pendingUnsigned !== undefined))
	)
		throw new TypeError("prospective creator metadata lineage is unavailable");
	const aclDigest = hex(hashDomain("ts-drp/latched-acl/v3", registration.exactCanonicalLatchedAclBytes));
	const successorAclBytes = material.preview.exactCanonicalSuccessorAclBytes;
	const successorAclDigest = hex(hashDomain("ts-drp/latched-acl/v3", successorAclBytes));
	const common = {
		current: current,
		currentTrust: registration.currentTrust,
		currentAclDigest: aclDigest,
		currentExactAclBytes: registration.exactCanonicalLatchedAclBytes,
		graph: material.preview.graph,
		issuanceScope: registration.issuanceScope,
		issuanceStore: registration.issuanceStore,
		successorAclDigest,
		successorExactAclBytes: successorAclBytes,
	};
	const codec = {
		currentTrust: registration.currentTrust,
		cutValueDigest: material.prepared.valueDigest,
		snapshotManifestDigest: material.snapshot.manifestDigest,
		successorAnchorDigest: material.widths.successorAnchorDigest,
		commitQcByteLength: material.widths.commitQcBytes,
	};
	if (settlementProfileFor(registration.currentTrust.profileId) === "v1") {
		const derived = deriveAuthorSettlement({
			...common,
			historyRoot: material.commitment.historyRoot,
			historySize: material.commitment.historySize,
		});
		const sized = readCreatorAuthorSettlementForSizing({
			...codec,
			currentAclDigest: aclDigest,
			frontiers: derived.frontiers,
			historyRoot: material.commitment.historyRoot,
			historySize: material.commitment.historySize,
			priorCheckpointDigest: derived.previous?.ref.digest ?? CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL,
			priorCheckpointKind: derived.previous === undefined ? "genesis" : "settled-v1",
			successorAclDigest,
		});
		if (!sized.ok) throw new TypeError(`prospective creator settlement codec refused: ${sized.reason}`);
		return Object.freeze({
			frames: Object.freeze([
				Object.freeze({ ...sized, ...(derived.previous === undefined ? {} : { priorRef: derived.previous.ref }) }),
			]),
			settlementFrontiers: derived.frontiers,
		});
	}
	const prior = authenticatedPriorIssuanceRetirement({
		current,
		currentTrust: registration.currentTrust,
		issuanceScope: registration.issuanceScope,
	});
	const digest = hex(hashDomain("ts-drp/vertex/v3", unsignedBytes));
	if (!material.preview.graph.vertices.has(digest))
		throw new TypeError("prospective creator close does not contain its selected vertex");
	// Existing rows were authenticated in the sealed original dependency census.
	// The one additional unsigned ordinal is only a sizing contribution. A gap
	// would make the original close unrepresentable and refuses before crypto.
	for (let ordinal = (prior.priorAdmittedAuthorSequence ?? -1) + 1; ordinal < sequence + Number(received !== undefined); ordinal++) {
		const row = nativeRows.issued.find(
			(row) => row.author === registration.issuanceScope.author && row.authorSequence === ordinal
		);
		if (row === undefined || !material.preview.graph.vertices.has(hex(row.digest)))
			throw new TypeError("prospective creator close has unclosed original issuance debt");
	}
	const legacy = readCreatorIssuanceRetirementForSizing({
		...codec,
		admittedAuthorSequence: sequence,
		author: registration.issuanceScope.author,
		observedLineage: { next: sequence + 1, exhausted: false },
		priorAdmittedAuthorSequence: prior.priorAdmittedAuthorSequence,
		priorRetirementCandidateDigest: prior.priorRetirementCandidateDigest,
	});
	if (!legacy.ok) throw new TypeError(`prospective creator retirement codec refused: ${legacy.reason}`);
	const derived = await deriveAuthorIssuanceFrontiers(
		{ ...common, legacy: { author: registration.issuanceScope.author, admittedAuthorSequence: sequence } },
		received === undefined ? sequence : undefined
	);
	const aggregate = readCreatorAuthorIssuanceFrontiersForSizing({
		...codec,
		currentAclDigest: aclDigest,
		frontiers: derived.frontiers,
		priorAggregateCandidateDigest: derived.priorRef?.digest ?? CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
		successorAclDigest,
	});
	if (!aggregate.ok) throw new TypeError(`prospective creator frontier codec refused: ${aggregate.reason}`);
	return Object.freeze({
		frames: Object.freeze([
			Object.freeze({ ...legacy, ...(prior.priorRef === undefined ? {} : { priorRef: prior.priorRef }) }),
			Object.freeze({ ...aggregate, ...(derived.priorRef === undefined ? {} : { priorRef: derived.priorRef }) }),
		]),
	});
}

/**
 * Original ordinary adoption projection/history bytes; no prepared adoption is minted.
 * @param registration - Original captured registration facts.
 * @param input - Original captured input facts.
 * @param current - Original captured current facts.
 * @param material - Original captured material facts.
 * @returns Original owner-derived bytes or sizing result; no authority is minted.
 */
function prospectiveCreatorAdoptionBytes(
	registration: V3CreatorCloseRegistration,
	input: BindCreatorLiveCloseInput,
	current: InspectedHead,
	material: Awaited<ReturnType<typeof prepareProspectiveCreatorCloseMaterial>>
): Readonly<{ projection: Uint8Array; history: Uint8Array }> {
	if (input.promotionContext === undefined) throw new TypeError("prospective creator catalog authority is unavailable");
	const currentProjections = current.candidates
		.map((candidate) => decodeCanonical(candidate.bytes))
		.filter(
			(value) =>
				plainRecord(value) &&
				value.kind ===
					(registration.currentTrust.currentEpoch === 0 ? "v3-live-generation-1" : "v3-live-generation-2") &&
				value.epoch === registration.currentTrust.currentEpoch &&
				value.anchorDigest === registration.currentTrust.currentAnchorDigest
		);
	const currentProjection = currentProjections[0];
	if (currentProjections.length !== 1 || !plainRecord(currentProjection))
		throw new TypeError("prospective creator current projection is unavailable");
	const identity = creatorSnapshotCatalogIdentity(currentProjection);
	const catalog =
		identity === undefined
			? undefined
			: verifiedCreatorSnapshotCatalog(input.promotionContext.catalog, currentProjection.blueprintDigest, identity);
	const currentAnchor = decodeCanonical(registration.exactCanonicalAnchorPreimageBytes);
	const successorAnchor = decodeCanonical(material.widths.exactCanonicalAnchorPreimageBytes);
	const cut = decodeCanonical(material.prepared.exactCanonicalCutValueBytes);
	const manifest = decodeCanonical(material.snapshot.exactCanonicalManifestBytes);
	if (
		catalog === undefined ||
		!plainRecord(currentAnchor) ||
		!plainRecord(successorAnchor) ||
		!plainRecord(cut) ||
		!plainRecord(cut.parameters) ||
		!plainRecord(manifest)
	)
		throw new TypeError("prospective creator adoption codec facts are unavailable");
	const projection = encodeCreatorSuccessorProjection({
		currentAnchor,
		successorAnchor,
		successorAnchorBytes: material.widths.exactCanonicalAnchorPreimageBytes,
		successorAnchorDigest: material.widths.successorAnchorDigest,
		parameters: cut.parameters,
		history: material.commitment,
		catalog,
		snapshotManifestDigest: material.snapshot.manifestDigest,
		snapshotPayloadDigest: manifest.payloadDigest,
	});
	return Object.freeze({
		projection,
		history: encodeCreatorCloseHistory(material.prepared.valueDigest, material.commitment.historySnapshot),
	});
}

type CreatorIssuanceMaintenanceQuote = Readonly<{
	ordinaryFinishingCapacityDimensions?: NonNullable<Parameters<typeof readCreatorOrdinaryFinishingCapacityForSizing>[0]["ordinaryFinishingCapacityDimensions"]>;
	archiveCapacity?: Readonly<{store:ArchiveStorage;declaration:ArchiveCapacityDeclaration;
		status:ArchiveStorageStatus;cutValueByteLength:number;futureUnknownByteLengths:readonly number[];check():Promise<void>}>;
	proof: CreatorIssuanceMaintenanceProof;
	material: Awaited<ReturnType<typeof prepareProspectiveCreatorCloseMaterial>>;
	metadata: Awaited<ReturnType<typeof prospectiveCreatorMetadataWidths>>["frames"];
	adoption: ReturnType<typeof prospectiveCreatorAdoptionBytes>;
	issuancePhases: ReturnType<typeof issuanceUnsignedPostimageWidths> | undefined;
	ordinarySignMaterialByteLength?: number;
	receivedSignature?: Uint8Array;
	runtimeCensusOverheadByteLength: number;
	postAdoptionCensusSizing: readonly CreatorPostAdoptionCensusSizing[];
	exactCanonicalCurrentLatchedAclBytes: Uint8Array;
	signingFrames: readonly CreatorCloseSigningFrameWidth[];
	context: DurableIssueSignContext;
}>;

type CreatorOrdinaryIssuanceMaintenanceQuote = Omit<CreatorIssuanceMaintenanceQuote, "proof" | "archiveCapacity"> &
	Readonly<{proof: CreatorOrdinaryIssuanceMaintenanceProof}>;

/** A genuine current admission lifetime, without hypothetical future objects. */
type CreatorIncrementalIssuanceMaintenanceQuote = Readonly<{
	kind: "incremental";
	proof: CreatorOrdinaryIssuanceMaintenanceProof;
	context: DurableIssueSignContext;
}>;

/** Reads only genuine captured source dimensions. This local fast-path domain
 * does not redefine operation validity: outside shapes retain exact preparation.
 * No source classification, authentication, ledger credit or native loan is
 * derived from these numbers. The original proof/composer must verify dominance. */
function creatorOrdinaryFinishingCapacityDimensions(
	registration: V3CreatorCloseRegistration,
	census: Readonly<Record<string, unknown>>,
	unsignedBytes: Uint8Array,
	postAdoption: readonly CreatorPostAdoptionCensusSizing[]
): CreatorIssuanceMaintenanceQuote["ordinaryFinishingCapacityDimensions"] {
	try {
		const closed = (value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> =>
			plainRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
		const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
		const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
		const sourceKeys = ["currentJournal", "rows", "debt", "graphVersion", "dependencyAnchors", "nativeIssuance", "activeUnsettled",
			...(Object.hasOwn(census, "pendingIngress") ? ["pendingIngress"] : [])];
		const preimage = readCreatorOrdinaryPreimageCapacityForSizing(unsignedBytes);
		if (preimage === undefined || !closed(census, sourceKeys) || !uint(census.graphVersion) ||
			!Array.isArray(census.rows) || census.rows.length > 256 ||
			!Array.isArray(census.debt) || !Array.isArray(census.dependencyAnchors) ||
			!closed(census.currentJournal, ["dependencyKind", "scope", "rows"]) ||
			census.currentJournal.dependencyKind !== "current-journal" ||
			!closed(census.currentJournal.scope, ["objectId", "epoch", "anchorDigest"]) ||
			census.currentJournal.scope.objectId !== registration.objectId ||
			census.currentJournal.scope.epoch !== registration.currentTrust.currentEpoch ||
			census.currentJournal.scope.anchorDigest !== registration.currentTrust.currentAnchorDigest ||
			!Array.isArray(census.currentJournal.rows) || census.currentJournal.rows.length > 256 ||
			!closed(census.activeUnsettled, ["sources", "cursor", "cacheSourceSequences", "availableHistoricalDepth", "coverage"]) ||
			!Array.isArray(census.activeUnsettled.sources) || census.activeUnsettled.sources.length !== 0 ||
			census.activeUnsettled.cursor !== null || !Array.isArray(census.activeUnsettled.cacheSourceSequences) ||
			census.activeUnsettled.cacheSourceSequences.length !== 0 ||
			census.activeUnsettled.availableHistoricalDepth !== Math.min(2, registration.currentTrust.currentEpoch) ||
			census.activeUnsettled.coverage !== "active-current-and-bounded-unsettled-source-set") return undefined;
		let canonicalPreimageByteLength = preimage.canonicalPreimageByteLength;
		let canonicalEpochVertexByteLength = preimage.canonicalEpochVertexByteLength;
		for (const row of census.currentJournal.rows) {
			if (!plainRecord(row)) return undefined;
			if (row.sourceKind === "received") {
				if (!(row.exactCanonicalPreimageBytes instanceof Uint8Array) ||
					!(row.exactCanonicalVertexBytes instanceof Uint8Array)) return undefined;
				// Already-admitted opaque carriers may exceed the NEW operation
				// rectangle. Keep their actual complete widths; no old work is lost.
				canonicalPreimageByteLength = Math.max(canonicalPreimageByteLength, row.exactCanonicalPreimageBytes.byteLength);
				canonicalEpochVertexByteLength = Math.max(canonicalEpochVertexByteLength, row.exactCanonicalVertexBytes.byteLength);
			} else if (row.sourceKind !== "local-issued") return undefined;
		}
		let receivedPendingIngressByteLength: number | undefined;
		if (Object.hasOwn(census, "pendingIngress")) {
			const pending = census.pendingIngress;
			if (!closed(pending, ["roots", "wireByteCharge", "admission", "graphClosure"]) ||
				!Array.isArray(pending.roots) || pending.roots.length > 1 || !uint(pending.wireByteCharge) ||
				pending.admission !== "unadmitted" || pending.graphClosure !== (pending.roots.length === 0 ? "no-pending-roots" : "incomplete") ||
				pending.roots.some(root => !closed(root, ["dependencyKind", "digest", "exactCanonicalPreimageBytes", "signature", "wireByteCharge", "missingParents", "scope"]) ||
					root.dependencyKind !== "authenticated-unadmitted-pending-ingress" || !digest(root.digest) ||
					!(root.exactCanonicalPreimageBytes instanceof Uint8Array) || !(root.signature instanceof Uint8Array) || root.signature.byteLength !== 64 ||
					!uint(root.wireByteCharge) || !Array.isArray(root.missingParents) || root.missingParents.length > 16 ||
					root.missingParents.some(parent => !digest(parent)) || !closed(root.scope, ["objectId", "epoch", "anchorDigest"]) ||
					root.scope.objectId !== registration.objectId || root.scope.epoch !== registration.currentTrust.currentEpoch ||
					root.scope.anchorDigest !== registration.currentTrust.currentAnchorDigest))
				return undefined;
			receivedPendingIngressByteLength = encodeCanonical(pending).byteLength;
		}
		const successorFenceCount = settlementProfileFor(registration.currentTrust.profileId) === "v1" ? 1 : 0;
		if (postAdoption.length === 0 || postAdoption.some(variant => variant.currentContinuation !== undefined ||
			(successorFenceCount === 0
				? variant.nativeJobPhases !== undefined || variant.successorJournalAppendForSizing !== undefined
				: variant.successorJournalAppendForSizing === undefined || variant.nativeJobPhases?.length !== 2 ||
					variant.nativeJobPhases[0]?.phase !== "reserved" || variant.nativeJobPhases[1]?.phase !== "entered" ||
					variant.nativeJobPhases.some(phase => !uint(phase.canonicalUnsignedVertexByteLength) || phase.canonicalUnsignedVertexByteLength === 0))))
			return undefined;
		const canonicalSuccessorFencePreimageByteLength = successorFenceCount === 0 ? 0 :
			Math.max(...postAdoption.flatMap(variant => variant.nativeJobPhases!.map(phase => phase.canonicalUnsignedVertexByteLength)));
		const runtime = registration.readOrdinaryRuntimeCapacityWidths({
			scope: registration.issuanceScope,
			currentScope: {objectId: registration.objectId, epoch: registration.currentTrust.currentEpoch,
				anchorDigest: registration.currentTrust.currentAnchorDigest},
			maxIssuerDescriptors: census.rows.length, maxDebtDescriptors: census.debt.length,
			maxCurrentJournalRows: census.currentJournal.rows.length,
			// Both original successor constructors independently enforce seven
			// anchors. Current counts alone omit the newly introduced close anchor.
			maxDependencyAnchors: 7,
			canonicalPreimageByteLength,
			canonicalEpochVertexByteLength,
			successorFenceCount,
			successorFencePreimageByteLength: canonicalSuccessorFencePreimageByteLength,
			...(receivedPendingIngressByteLength === undefined ? {} : {receivedPendingIngressByteLength}),
		});
		return Object.freeze({runtime, successorFenceCount, canonicalPreimageByteLength,
			canonicalEpochVertexByteLength, canonicalSuccessorFencePreimageByteLength,
			...(receivedPendingIngressByteLength === undefined ? {} : {receivedPendingIngressByteLength})});
	} catch {
		// Pure codec/domain refusal is inconclusive sizing, never a native cleanup
		// failure or permission to omit protected obligations.
		return undefined;
	}
}

/**
 * Captures and sizes one exact operation in the existing complete proof frame.
 * @param registration - Original captured registration facts.
 * @param input - Original captured input facts.
 * @param unsignedBytes - Original captured unsignedBytes facts.
 * @param planEffect - Original captured planEffect facts.
 * @returns Original owner-derived bytes or sizing result; no authority is minted.
 */
async function prepareCreatorIssuanceMaintenanceQuote(
	registration: V3CreatorCloseRegistration,
	input: BindCreatorLiveCloseInput,
	unsignedBytes: Uint8Array,
	planEffect?: NonNullable<DurableIssueCommit["planEffect"]>,
	receivedReceipt?: object
): Promise<CreatorIssuanceMaintenanceQuote> {
	if (input.promotionContext === undefined)
		throw new TypeError("creator issuance maintenance authority is unavailable");
	const hold = await registration.sealIssuanceMaintenanceDependencies(receivedReceipt);
	if (hold === undefined) throw new TypeError("creator issuance maintenance census is unavailable");
	// This callback produces sizing DATA only. The source owner must qualify
	// the complete captured context under NEW native custody before returning a
	// proof; neither this result nor the callback can authorize an effect.
	const prepare = async (
		proof: CreatorIssuanceMaintenanceProof | CreatorIssuanceMaintenancePreparationData
	): Promise<Omit<CreatorIssuanceMaintenanceQuote, "proof">> => {
		registration.prepareIssuanceContinuation(hold, unsignedBytes, planEffect, input.prospectiveSettlementPreview);
		const runtimeCensusOverheadByteLength = registration.readProspectiveRuntimeCensusOverhead(hold, unsignedBytes);
		// The source is either the original held proof or isolated preparation
		// data awaiting full native qualification. Neither path runs recovery here.
		const head = proof.summary.head;
		if (head.kind !== "present") throw new TypeError("creator issuance maintenance head is stale");
		const active = proof.generations.filter(
			(generation) => generation.objectId === head.objectId && generation.generationId === head.generationId
		);
		if (active.length !== 1 || active[0]?.state !== "Adopted" || active[0].closureDigest !== head.closureDigest)
			throw new TypeError("creator issuance maintenance active generation is unavailable");
		const current = inspectCreatorCloseHead(head, active[0].closure, proof.blobs);
		const census = decodeCanonical(proof.censusBytes);
		if (
			!plainRecord(census) ||
			!plainRecord(census.nativeIssuance) ||
			!plainRecord(census.nativeIssuance.rows) ||
			!plainRecord(census.nativeIssuance.image) ||
			!Object.hasOwn(census.nativeIssuance, "control")
		)
			throw new TypeError("creator issuance maintenance native census is unavailable");
		const nativeRows = census.nativeIssuance.rows as unknown as IssuanceRetirementRows;
		const nativeControl = census.nativeIssuance.control as DurableIssuanceRetirementControl | null;
		const unsigned = decodeCanonical(unsignedBytes);
		if (!plainRecord(unsigned) || typeof unsigned.authorSequence !== "number")
			throw new TypeError("creator issuance maintenance unsigned identity is malformed");
		const plan =
			planEffect === undefined
				? undefined
				: nativeRows.plans.find(
						(candidate) =>
							candidate.scope.author === registration.issuanceScope.author &&
							candidate.scope.objectId === registration.issuanceScope.objectId
					);
		if (planEffect !== undefined && plan === undefined)
			throw new TypeError("creator issuance maintenance settlement context is unavailable");
		const issuancePhases = receivedReceipt !== undefined ? undefined : issuanceUnsignedPostimageWidths(
			nativeRows,
			registration.issuanceScope,
			{
				kind: "v3-issuance-pending-unsigned-1",
				authorSequence: unsigned.authorSequence,
				canonicalPreimageBytes: unsignedBytes,
				digest: hashDomain("ts-drp/vertex/v3", unsignedBytes),
				...(planEffect === undefined ? {} : { planEffect, exactCanonicalPlanBytes: encodeCanonical(plan) }),
			},
			nativeControl, creatorSourceCustodyGeometryForSizing(registration.currentTrust, registration.exactCanonicalLatchedAclBytes,
				Number((decodeCanonical(registration.exactCanonicalParametersBytes) as Record<string, unknown>).maxEpochVertices))
		);
		const ordinarySignMaterialByteLength = receivedReceipt === undefined && planEffect === undefined &&
			registration.currentTrust.profileId === "creator-trusted-v1" && nativeRows.plans.length === 0
			? registration.readOrdinarySignMaterialByteLength?.(nativeRows, registration.issuanceScope, {
				kind: "v3-issuance-pending-unsigned-1", authorSequence: unsigned.authorSequence,
				canonicalPreimageBytes: unsignedBytes, digest: hashDomain("ts-drp/vertex/v3", unsignedBytes),
			}, nativeControl) : undefined;
		if (ordinarySignMaterialByteLength !== undefined &&
			(!Number.isSafeInteger(ordinarySignMaterialByteLength) || ordinarySignMaterialByteLength < 0))
			throw new TypeError("creator ordinary native material bound is malformed");
		const needsRecoveryRoles = creatorCloseNeedsRecoveryRoles(registration, current);
		const detached = "recovery" in proof;
		const recovery = !needsRecoveryRoles || detached
			? undefined
			: resolveCreatorForwardPromotionSource(
					proof.observation,
					registration.store,
					input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"]
				);
		if (needsRecoveryRoles && !detached && recovery === undefined)
			throw new TypeError("creator issuance maintenance recovery role source is unavailable");
		const material = detached
			? await prepareProspectiveCreatorCloseMaterialFromPreview(
				registration, input, current, registration.previewIssuanceClose(unsignedBytes, hold),
				!needsRecoveryRoles ? undefined : {
					facts: proof.recovery,
					survivingScopes: proof.recovery.snapshotTurnover.survivingScopes,
				})
			: await prepareProspectiveCreatorCloseMaterial(
			registration,
			input,
			current,
			unsignedBytes,
			proof,
			hold,
			recovery
		);
		const metadataReadout = await prospectiveCreatorMetadataWidths(
			registration,
			current,
			material,
			nativeRows,
			unsignedBytes,
			resolveCreatorReceivedAppendSizing(hold, unsignedBytes)
		);
		const metadata = metadataReadout.frames;
		const adoption = prospectiveCreatorAdoptionBytes(registration, input, current, material);
		let settlementSizing: CreatorPostAdoptionSettlementSizing | undefined;
		if (metadataReadout.settlementFrontiers !== undefined) {
			if (input.prospectiveSettlementPreview === undefined)
				throw new TypeError("prospective creator settlement room constructor is unavailable");
			settlementSizing = {
				frontiers: metadataReadout.settlementFrontiers,
				preview: input.prospectiveSettlementPreview,
				...(planEffect === undefined ? {} : { planEffect }),
			};
		}
		const postAdoptionCensusSizing = registration.readProspectivePostAdoptionCensusSizing(
			hold,
			unsignedBytes,
			material.prepared.close,
			adoption.projection,
			settlementSizing
		);
		const ordinaryFinishingCapacityDimensions = planEffect !== undefined || input.archive !== undefined ? undefined :
			creatorOrdinaryFinishingCapacityDimensions(registration, census, unsignedBytes, postAdoptionCensusSizing);
		const signing = readCreatorCloseSigningFramesForSizing({
			currentTrust: registration.currentTrust,
			genuinePreparedClose: material.prepared.close,
			exactCanonicalCutValueBytes: material.prepared.exactCanonicalCutValueBytes,
			prepareQcByteLength: material.widths.prepareQcBytes,
			commitQcByteLength: material.widths.commitQcBytes,
			successorTrustByteLength: material.widths.trustBytes,
			storageIncarnation: input.storageIncarnation,
			actualRows: proof.signingRows,
		});
		if (!signing.ok) throw new TypeError(`creator issuance maintenance signing codec refused: ${signing.reason}`);
		const expectedIssuanceImageDigest = census.nativeIssuance.image.imageDigest;
		if (typeof expectedIssuanceImageDigest !== "string" || !/^[0-9a-f]{64}$/.test(expectedIssuanceImageDigest))
			throw new TypeError("creator issuance maintenance image currency is malformed");
		const context = Object.freeze({
			expectedIssuanceImageDigest,
			expectedIssuanceControlBytes: nativeControl === null ? null : encodeIssuanceRetirementControl(nativeControl),
			...(planEffect === undefined ? {} : { planEffect }),
		});
		let archiveCapacity: CreatorIssuanceMaintenanceQuote["archiveCapacity"];
		if (input.archive !== undefined) {
			if (detached) throw new TypeError("archive sizing requires its original held source");
			const archiveLifetime = resolveCreatorSnapshotRecoveryCloseHold(hold, {
				store: registration.store, liveJournalStore: registration.liveJournalStore,
				currentTrust: registration.currentTrust,
			});
			if (archiveLifetime === undefined) throw new TypeError("archive admission genuine source lifetime is unavailable");
			await archiveLifetime.check();
			const status = await input.archive.store.inspect();
			const anchor = decodeCanonical(registration.exactCanonicalAnchorPreimageBytes);
			if (!plainRecord(anchor) || status.position.root !== anchor.archiveIndexRoot ||
				status.position.lastOrdinal !== Number(anchor.historySize) - 1 || status.pending !== null)
				throw new TypeError("archive admission predecessor differs from the authenticated complete history");
			// Membership/charges come from the complete held prospective fold,
			// including the received candidate and prepared current continuation.
			// Do not reserve all hypothetical future ordinary maxEpoch admissions.
			const measuredCurrent = measureArchiveAppendCapacityForSizing({objectId:registration.currentTrust.objectId,
				epoch:registration.currentTrust.currentEpoch,limits:input.archive.limits,
				records:material.commitment.closeSetEntries.map(row => ({ordinal:row.ordinal,preimageByteLength:row.authenticatedCanonicalPreimageByteLength}))});
			const {segments,...current} = measuredCurrent;
			const continuationPlans = postAdoptionCensusSizing.map(variant => measureArchiveAppendCapacityForSizing({
				objectId:registration.currentTrust.objectId,epoch:registration.currentTrust.currentEpoch + 1,limits:input.archive!.limits,
				// Completing the existing authenticated fence does not grant fresh
				// ordinary capacity or create another self-perpetuating fence debt.
				// The original settlement constructor has already refused unresolved
				// replacements; existing native promise surplus is never refunded.
				records:(planEffect?.kind === "fence" && status.capacityPromise?.declaration.sourceEpoch === registration.currentTrust.currentEpoch - 1
					? [] : variant.archiveContinuationPreimageByteLengths ?? []).map((preimageByteLength,index) => ({
					ordinal:material.commitment.historySize + index,preimageByteLength}))}));
			// Independent maxima are a conservative local quota bound only; they
			// never manufacture a source witness or an accepted target operation.
			const continuation = Object.freeze({
				artifactBytes:Math.max(0,...continuationPlans.map(plan => plan.artifactBytes)),
				artifactCount:Math.max(0,...continuationPlans.map(plan => plan.artifactCount)),
				indexEntries:Math.max(0,...continuationPlans.map(plan => plan.indexEntries)),
				maxArtifactBytes:Math.max(0,...continuationPlans.map(plan => plan.maxArtifactBytes))});
			const declaration: ArchiveCapacityDeclaration = Object.freeze({objectId:registration.currentTrust.objectId,
				pinnedGenesisAnchorDigest:registration.currentTrust.genesisAnchorDigest,sourceEpoch:registration.currentTrust.currentEpoch,
				sourceAnchorDigest:registration.currentTrust.currentAnchorDigest,expected:status.position,current,continuation});
			await archiveLifetime.check();
			const bytesWidth = (width: number): number => 1 + canonicalUnsignedCountWidth(width) + width;
			const segmentWidths = segments.map(segment => canonicalProspectiveRecordWidth({}, {
				exactCanonicalDescriptorBytes:bytesWidth(segment.descriptorByteLength),
				exactCanonicalIndexEntryBytes:bytesWidth(segment.indexEntryByteLength)}));
			const bindingWidth = canonicalProspectiveRecordWidth({kind:"closed-epoch-archive-append",version:1,
				objectId:registration.currentTrust.objectId,sourceEpoch:registration.currentTrust.currentEpoch,
				sourceAnchorDigest:registration.currentTrust.currentAnchorDigest,sourceCloseSetRoot:material.commitment.closeSetRoot,
				sourceHistoryRoot:material.commitment.historyRoot,previousHistorySize:Number(anchor.historySize),historySize:material.commitment.historySize,
				previousArchiveIndexRoot:status.position.root,previousIndexSize:status.position.size,indexSize:status.position.size + current.indexEntries}, {
				targetArchiveIndexRoot:encodeCanonical("0".repeat(64)).byteLength,
				segments:1 + canonicalUnsignedCountWidth(segmentWidths.length) + segmentWidths.reduce((n,width) => n + width,0)});
			const cut = decodeCanonical(material.prepared.exactCanonicalCutValueBytes);
			if (!plainRecord(cut) || Object.hasOwn(cut,"archiveAppend")) throw new TypeError("archive prospective Cut basis is unavailable");
			const cutValueByteLength = canonicalProspectiveRecordWidth(cut,{archiveAppend:bindingWidth});
			if (cutValueByteLength > SEAL_CANONICAL_RECORD_MAX_BYTES) throw new TypeError("archive prospective Cut record capacity exhausted");
			archiveCapacity = Object.freeze({store:input.archive.store,declaration,status,
				cutValueByteLength,
				// New archive-root bytes change snapshot/manifests/chunk identities.
				// Keep all OLD/PRE captures, and charge complete UNKNOWN new leaves;
				// never dedup new bytes using the old nominal preparation's digest.
				futureUnknownByteLengths:Object.freeze([
					material.snapshot.exactCanonicalManifestBytes.byteLength,material.preview.exactCanonicalPayloadBytes.byteLength,
					...material.snapshot.chunks.map(chunk => chunk.byteLength),
					material.widths.exactCanonicalAnchorPreimageBytes.byteLength,adoption.projection.byteLength,adoption.history.byteLength,
					bindingWidth,
					// Construction, precommit and postcommit artifact captures. They
					// remain three unknown occurrences: no forecast identity/refund.
					current.artifactBytes,current.artifactBytes,current.artifactBytes,
					encodeCanonical(declaration).byteLength,
					// prepare: status/frontier/last-entry/begin/prepared (5);
					// complete: retained intent/status/prepared/status (4);
					// returned exact declaration carrier (1). Native-control quota
					// bounds serializer widths here, never proof entitlement or heap.
					...Array.from({length:10},() => status.maxControlByteLength)]),
				check:() => archiveLifetime.check()});
		}
		return Object.freeze({
			...(archiveCapacity === undefined ? {} : {archiveCapacity}),
			...(ordinaryFinishingCapacityDimensions === undefined ? {} : {ordinaryFinishingCapacityDimensions}),
			material,
			metadata,
			adoption,
			issuancePhases,
			...(ordinarySignMaterialByteLength === undefined ? {} : {ordinarySignMaterialByteLength}),
			...(receivedReceipt === undefined ? {} : {receivedSignature: registration.readReceivedAppendCandidate(receivedReceipt).signature}),
			runtimeCensusOverheadByteLength,
			postAdoptionCensusSizing,
			exactCanonicalCurrentLatchedAclBytes: registration.exactCanonicalLatchedAclBytes,
			signingFrames: signing.frames,
			context,
		});
	};
	let prepared: Omit<CreatorIssuanceMaintenanceQuote, "proof"> | undefined;
	const proof = await acquireCreatorIssuanceMaintenanceProof(
		{
			...input.promotionContext,
			objectId: registration.objectId,
			store: registration.store,
			snapshotStore: input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"],
			liveJournalStore: registration.liveJournalStore,
		},
		hold,
		registration.currentTrust,
		planEffect?.kind === "fence",
		false,
		undefined,
		input.archive === undefined ? async data => { prepared = await prepare(data); } : undefined
	);
	try {
		// An ineligible source keeps the existing held path. A detached source's
		// prepared data is not returned until its genuine proof has qualified.
		return Object.freeze({...(prepared ?? await prepare(proof)), proof});
	} catch (primary) {
		try {
			await proof.release();
		} catch (cleanup) {
			throw new AggregateError([primary, cleanup], "creator issuance quote release failed", { cause: primary });
		}
		throw primary;
	}
}

/** Same finite original reconciliation schedule for a real close or an explicit
 * queued readiness boundary. Actual signing groups and native generations bound
 * fresh acquisitions; only the original planner classifies work or drains rows. */
async function reconcileCreatorBoundedRecoveryMaintenance(registration: V3CreatorCloseRegistration,
	input: BindCreatorLiveCloseInput, actor: CreatorActor, generationCount: number,
	seal: () => Promise<CreatorSnapshotRecoveryCloseHold | undefined>, acknowledgeCompletedJournalDrain = false,
	requireClosedWorkflowCompletion = false, currentTrust?: CurrentAnchorTrust): Promise<"complete"> {
	if (input.promotionContext === undefined) throw new TypeError("creator retirement authority is unavailable");
	const signingRead = await actor.captureRetirementOwners().acquireEvidence();
	const signingEpochs = new Set<number>();
	try {
		for (const bytes of signingRead.readExactCanonicalRows()) {
			const frame = decodeCanonical(bytes) as unknown[];
			if (frame[0] === "signerState") signingEpochs.add((frame[1] as [string, number, string])[1]);
		}
		await signingRead.check();
	} catch (primary) {
		try { await signingRead.release(); }
		catch (cleanup) { throw new AggregateError([primary, cleanup], "creator maintenance census release failed", {cause: primary}); }
		throw primary;
	}
	await signingRead.release();
	// Evidence runs once; each subsequent fresh request must remove a group
	// or generation. One final terminal probe uses the SAME existing bound.
	const maxMaintenancePasses = 2 + signingEpochs.size + generationCount;
	// One finite lifecycle owns immutable syntax and authentication facts. Each
	// pass still supplies its freshly sealed census and performs the original
	// native currency/planning/effect checks; no paid proof or writer is reused.
	const maintenance = createCreatorSnapshotRecoveryMaintenanceJob({...input.promotionContext,
		objectId: registration.objectId, store: registration.store,
		snapshotStore: input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"],
		liveJournalStore: registration.liveJournalStore}, currentTrust);
	let primary: unknown, failed = false;
	try {
		for (let pass = 0; pass < maxMaintenancePasses; pass++) {
			// The prior pass joined its readers and effects. A fresh hold below
			// supplies all authority for the next bounded maintenance pass.
			await yieldToHost();
			const closeHold = await seal();
			const checkpoint = await maintenance.reconcile(closeHold, acknowledgeCompletedJournalDrain, requireClosedWorkflowCompletion);
			if (checkpoint !== "fresh-summary-required") return checkpoint;
			if (pass === maxMaintenancePasses - 1) throw new TypeError("creator bounded retirement maintenance did not stabilize");
		}
		throw new TypeError("creator bounded retirement maintenance did not stabilize");
	} catch (error) {
		primary = error; failed = true;
		throw error;
	} finally {
		try { await maintenance.release(); }
		catch (cleanup) {
			if (failed) throw new AggregateError([primary, cleanup], "creator bounded maintenance and joined release failed", {cause: primary});
			throw cleanup;
		}
	}
}

/** Prime the original immutable source facts without constructing hypothetical
 * Cut/QC, state, snapshot, adoption or recovery schedules. This is one cold
 * authenticated read lifetime, not reusable admission authority or paid credit.
 * The resulting token still owes fresh per-call runtime/native reservations.
 */
async function captureCreatorOrdinarySourceWithoutForecast(
	registration: V3CreatorCloseRegistration,
	input: BindCreatorLiveCloseInput,
	receivedReceipt?: object,
	readiness = false,
	cooperate?: () => Promise<void>
): Promise<CreatorOrdinaryIssuanceProofSource | undefined> {
	if (input.promotionContext === undefined || input.archive !== undefined ||
		input.readOrdinaryApplicationResourceBound === undefined) return undefined;
	// While the registration retains a cross-object migration source, this OPTIONAL lifetime
	// can only end in the data owner's "native-or-cross-context-source" decline: skip it. Nothing
	// is sealed, acquired or charged, so nothing is transferred, and the caller's mandatory cold
	// quote keeps every check. Readiness is never skipped; a missing or failing hint keeps the
	// original route.
	let migrationSource = false;
	if (!readiness) try { migrationSource = registration.hasMigrationSourceForOrdinaryPrime?.() === true; }
	catch { /* The original route below. */ }
	if (migrationSource) {
		try {
			const observer = Reflect.get(globalThis, "__warmProofEvent");
			if (typeof observer === "function") observer({kind: "ordinary-incremental-source-prime-skipped",
				epoch: registration.currentTrust.currentEpoch, reason: "migration-source"});
		} catch { /* Diagnostics never alter the original owner outcome. */ }
		return undefined;
	}
	const hold = await registration.sealIssuanceMaintenanceDependencies(receivedReceipt);
	if (hold === undefined) return undefined;
	// The existing proof acquisition owns failure cleanup of this original hold.
	let proof: CreatorIssuanceMaintenanceProof;
	try {
		proof = await acquireCreatorIssuanceMaintenanceProof({
			...input.promotionContext, objectId: registration.objectId, store: registration.store,
			snapshotStore: input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"],
			liveJournalStore: registration.liveJournalStore,
		}, hold, registration.currentTrust);
	} catch (primary) {
		// Optional priming cannot strand already-admitted recovery at reopen when
		// the ordinary book is full. Acquisition has already joined its readers;
		// a cleanup AggregateError or genuine safety failure must still propagate.
		if (isCreatorOrdinarySourceCapacityRefusal(primary)) return undefined;
		throw primary;
	}
	let source: CreatorOrdinaryIssuanceProofSource | undefined;
	let primary: unknown, failed = false;
	try {
		// The acquired proof keeps its native custody across the caller's
		// boundary; capture still opens with the proof's own custody checks.
		await cooperate?.();
		// Capture brackets all retained facts with the ORIGINAL cold terminal
		// custody checks; the cold proof does not expose the warm check API.
		source = await captureCreatorOrdinaryIssuanceProofSource(proof, readiness ? {
			reader: input.readOrdinaryApplicationResourceBound, storageIncarnation: input.storageIncarnation,
			actualProducerChunkBytes: 131_072,
			...(input.ordinaryFinishingWindow === undefined ? {} : {window: input.ordinaryFinishingWindow}),
			...(input.prospectiveSettlementPreview === undefined ? {} : {settlementPreview: input.prospectiveSettlementPreview}),
		} : undefined);
	} catch (cause) { failed = true; primary = cause; }
	try { await proof.release(); }
	catch (cleanup) {
		if (failed) throw new AggregateError([primary, cleanup], "creator ordinary source prime and joined release failed", {cause: primary});
		throw cleanup;
	}
	if (failed) throw primary;
	return source;
}

/** Explicit readiness boundary only. The previous fieldless source is an
 * immutable DATA hint, not a paid proof or authority. Its original warm owner
 * must reopen and authenticate the complete actual postimage on a NEW book;
 * unsupported correspondence retains the original cold preparation below. */
async function refreshCreatorOrdinarySourceReadiness(
	registration: V3CreatorCloseRegistration,
	input: BindCreatorLiveCloseInput,
	prior: CreatorOrdinaryIssuanceProofSource,
	cooperate?: () => Promise<void>
): Promise<CreatorOrdinaryIssuanceProofSource | undefined> {
	if (input.promotionContext === undefined || input.archive !== undefined ||
		input.readOrdinaryApplicationResourceBound === undefined) return undefined;
	const hold = await registration.sealOrdinaryIssuanceMaintenanceRuntime();
	if (hold === undefined) return undefined;
	const runtime = resolveCreatorOrdinaryIssuanceRuntimeHold(hold, {store: registration.store,
		liveJournalStore: registration.liveJournalStore, currentTrust: registration.currentTrust});
	if (runtime === undefined) { await releaseCreatorOrdinaryIssuanceRuntimeHold(hold); return undefined; }
	let proof: CreatorOrdinaryIssuanceMaintenanceProof | undefined;
	let source: CreatorOrdinaryIssuanceProofSource | undefined;
	let failed = false, primary: unknown;
	try {
		proof = await acquireCreatorOrdinaryIssuanceMaintenanceProof({
			...input.promotionContext, objectId: registration.objectId, store: registration.store,
			snapshotStore: input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"],
			liveJournalStore: registration.liveJournalStore}, hold, registration.currentTrust, prior);
		if (proof !== undefined) await cooperate?.();
		if (proof !== undefined)
			source = await prepareCreatorOrdinaryIssuanceProofSourceReadiness(proof, {
				reader: input.readOrdinaryApplicationResourceBound, storageIncarnation: input.storageIncarnation,
				actualProducerChunkBytes: 131_072,
				...(input.ordinaryFinishingWindow === undefined ? {} : {window: input.ordinaryFinishingWindow}),
				...(input.prospectiveSettlementPreview === undefined ? {} : {settlementPreview: input.prospectiveSettlementPreview}),
			});
	} catch (cause) { failed = true; primary = cause; }
	try { if (proof === undefined) await runtime.release(); else await proof.release(); }
	catch (cleanup) {
		if (failed) throw new AggregateError([primary, cleanup], "creator readiness refresh and joined release failed", {cause: primary});
		throw cleanup;
	}
	if (failed) {
		// This optional warm book can conservatively retain more historical OBS
		// than the original cold boundary. Only its original nominal capacity
		// refusal may request that cold route, after all reads have joined.
		if (isCreatorOrdinarySourceCapacityRefusal(primary)) return undefined;
		throw primary;
	}
	// No new source is exposed to ordinary admission until every read of the
	// old/new postimage has joined. The calling existing maintenance job blocks
	// other admissions and performs its own immediate-revocation check next.
	return source;
}

/** Validate the newly admitted bytes under fresh original custody, then check
 * the complete finite finishing bound and charge only THIS proof's real work.
 * Undefined is inconclusive local sizing, never a change in protocol validity.
 */
async function prepareCreatorIncrementalIssuanceMaintenanceQuote(
	registration: V3CreatorCloseRegistration,
	input: BindCreatorLiveCloseInput,
	unsignedBytes: Uint8Array,
	source: CreatorOrdinaryIssuanceProofSource,
	receivedReceipt?: object,
	onSourceUnavailable?: () => void,
	suffix?: CreatorOrdinaryIssuanceSuffixForSizing
): Promise<CreatorIncrementalIssuanceMaintenanceQuote | undefined> {
	const reader = input.readOrdinaryApplicationResourceBound;
	const decline = (reason: string): undefined => {
		if (input.ordinaryFinishingWindow !== undefined) try {
			const observer = Reflect.get(globalThis, "__warmProofEvent");
			if (typeof observer === "function") observer({kind: "ordinary-window-delivery-declined", reason,
				epoch: registration.currentTrust.currentEpoch, phase: receivedReceipt === undefined ? "local-issuance" : "received-append"});
		} catch { /* Diagnostics cannot affect custody or admission. */ }
		return undefined;
	};
	if (input.promotionContext === undefined || input.archive !== undefined || reader === undefined ||
		(registration.currentTrust.profileId !== "creator-trusted-v1" && registration.currentTrust.profileId !== "creator-trusted-settlement-v1") ||
		readCreatorOrdinaryPreimageCapacityForSizing(unsignedBytes) === undefined) return decline("window-incremental-domain");
	if (!creatorOrdinaryIssuanceSourceReadinessPrepared(source, reader)) return decline("window-source-unprepared");
	// Missing numerical preparation is NOT a fresh source/currency failure.
	// Keep the source for the original exact path; only the explicit lifecycle
	// boundary may prepare its finishing program. Do not open and invalidate a
	// fresh native proof merely to discover this already-known DATA condition.
	const hold = await registration.sealOrdinaryIssuanceMaintenanceRuntime(receivedReceipt);
	if (hold === undefined) return decline("window-runtime-hold");
	const runtime = resolveCreatorOrdinaryIssuanceRuntimeHold(hold, {store: registration.store,
		liveJournalStore: registration.liveJournalStore, currentTrust: registration.currentTrust});
	if (runtime === undefined) { await releaseCreatorOrdinaryIssuanceRuntimeHold(hold); return decline("window-runtime-resolver"); }
	let proof: CreatorOrdinaryIssuanceMaintenanceProof | undefined;
	let declineJoining = false;
	const joinDeclined = async (): Promise<undefined> => {
		declineJoining = true;
		if (proof === undefined) await runtime.release(); else await proof.release();
		return undefined;
	};
	try {
		proof = await acquireCreatorOrdinaryIssuanceMaintenanceProof({
			...input.promotionContext, objectId: registration.objectId, store: registration.store,
			snapshotStore: input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"],
			liveJournalStore: registration.liveJournalStore}, hold, registration.currentTrust, source, true);
		if (proof === undefined) {
			await joinDeclined();
			// A fresh source mismatch is not numerical inconclusiveness. Notify
			// only after the original owner has joined; cleanup failures stay fatal.
			onSourceUnavailable?.();
			return undefined;
		}
		const received = proof.readReceivedAppendSizing(unsignedBytes);
		if ((received === undefined) !== (receivedReceipt === undefined)) throw new TypeError("creator incremental received custody is unavailable");
		const capacity = await reserveCreatorOrdinaryFinishingCapacity(proof, unsignedBytes,
			{reader, storageIncarnation: input.storageIncarnation, actualProducerChunkBytes: 131_072,
				...(input.ordinaryFinishingWindow === undefined ? {} : {window: input.ordinaryFinishingWindow}),
				...(suffix === undefined ? {} : {suffix}),
				...(registration.currentTrust.profileId === "creator-trusted-settlement-v1" ? {settlementPreview: input.prospectiveSettlementPreview} : {})});
		if (capacity === undefined) return await joinDeclined();
		// The original combined owner delivered capacity only AFTER charging this
		// SAME book and checking complete post-charge currency. Effects still owe
		// their own fresh beginWrite boundary; this quote is not cached authority.
		const context = proof.readIssuanceContext(), image = context.expectedIssuanceImageDigest;
		if (typeof image !== "string" || !/^[0-9a-f]{64}$/u.test(image)) throw new TypeError("creator incremental issuance image currency is malformed");
		return Object.freeze({kind: "incremental" as const, proof, context});
	} catch (primary) {
		if (declineJoining) throw primary; // The original idempotent join already failed.
		try { if (proof === undefined) await runtime.release(); else await proof.release(); }
		catch (cleanup) { throw new AggregateError([primary, cleanup], "creator incremental admission and joined release failed", {cause: primary}); }
		// Ordinary inconclusive sizing returns above. Authentication, storage,
		// exhausted accounting and failed joins are real failures, not cache misses.
		throw primary;
	}
}

/** Every warm invocation owes a distinct proof, native reads and the original
 * fold. Immutable source spelling is not a full census or a forward capability. */
async function prepareCreatorOrdinaryIssuanceMaintenanceQuote(
	registration: V3CreatorCloseRegistration,
	input: BindCreatorLiveCloseInput,
	unsignedBytes: Uint8Array,
	source: CreatorOrdinaryIssuanceProofSource,
	receivedReceipt?: object
): Promise<CreatorOrdinaryIssuanceMaintenanceQuote | undefined> {
	let stage = "new-operation-domain";
	const reportRefusal = (primary: unknown, cleanup: "none" | "joined" | "failed", cleanupCause?: unknown): void => {
		try {
			const observer = Reflect.get(globalThis, "__warmProofEvent");
			if (typeof observer === "function") observer({kind: "ordinary-finishing-warm-quote-refusal",
				epoch: registration.currentTrust.currentEpoch, phase: receivedReceipt === undefined ? "local-issuance" : "received-append",
				stage, message: primary instanceof Error ? primary.message : "non-Error refusal", cleanup,
				...(cleanupCause === undefined ? {} : {cleanupMessage: cleanupCause instanceof Error ? cleanupCause.message : "non-Error cleanup failure"})});
		} catch { /* Diagnostics cannot alter admission or cleanup. */ }
	};
	if (input.promotionContext === undefined || input.archive !== undefined ||
		readCreatorOrdinaryPreimageCapacityForSizing(unsignedBytes) === undefined) {
		reportRefusal(new TypeError("outside the local NEW-operation capacity domain"), "none"); return undefined;
	}
	stage = "seal-runtime";
	const hold = await registration.sealOrdinaryIssuanceMaintenanceRuntime(receivedReceipt);
	if (hold === undefined) { reportRefusal(new TypeError("ordinary runtime seal is unavailable"), "none"); return undefined; }
	stage = "resolve-runtime";
	const runtime = resolveCreatorOrdinaryIssuanceRuntimeHold(hold, {store: registration.store,
		liveJournalStore: registration.liveJournalStore, currentTrust: registration.currentTrust});
	if (runtime === undefined) {
		try { await releaseCreatorOrdinaryIssuanceRuntimeHold(hold); }
		catch (cleanup) { reportRefusal(new TypeError("ordinary runtime resolution is unavailable"), "failed", cleanup); throw cleanup; }
		reportRefusal(new TypeError("ordinary runtime resolution is unavailable"), "joined"); return undefined;
	}
	let proof: CreatorOrdinaryIssuanceMaintenanceProof | undefined;
	try {
		stage = "acquire-proof";
		proof = await acquireCreatorOrdinaryIssuanceMaintenanceProof({
			...input.promotionContext, objectId: registration.objectId, store: registration.store,
			snapshotStore: input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"],
			liveJournalStore: registration.liveJournalStore}, hold, registration.currentTrust, source);
		if (proof === undefined) {
			await runtime.release(); reportRefusal(new TypeError("fresh ordinary proof acquisition is unavailable"), "joined"); return undefined;
		}
		stage = "check-proof";
		await proof.check();
		stage = "inspect-current-head";
		const data = proof.readSizingData(), head = data.summary.head;
		if (head.kind !== "present") throw new TypeError("creator ordinary issuance head is unavailable");
		const active = data.generations.filter(generation => generation.objectId === head.objectId && generation.generationId === head.generationId);
		if (active.length !== 1 || active[0]?.state !== "Adopted" || active[0].closureDigest !== head.closureDigest)
			throw new TypeError("creator ordinary issuance active generation is unavailable");
		const current = inspectCreatorCloseHead(head, active[0].closure, data.blobs);
		const needsRecoveryRoles = creatorCloseNeedsRecoveryRoles(registration, current);
		stage = "preview-close";
		const preview = registration.previewOrdinaryIssuanceClose(unsignedBytes, hold);
		stage = "prepare-material";
		const material = await prepareProspectiveCreatorCloseMaterialFromPreview(registration, input, current, preview,
			!needsRecoveryRoles ? undefined : {facts: data.sourceMaterial,
				survivingScopes: data.sourceMaterial.snapshotTurnover.survivingScopes});
		const nativeRows = data.nativeIssuance.rows, nativeControl = data.nativeIssuance.control ?? null;
		stage = "received-append-sizing";
		const received = proof.readReceivedAppendSizing(unsignedBytes);
		if ((received === undefined) !== (receivedReceipt === undefined)) throw new TypeError("creator ordinary received sizing is unavailable");
		stage = "metadata-widths";
		const metadataReadout = await prospectiveCreatorMetadataWidths(registration, current, material, nativeRows, unsignedBytes, received);
		stage = "adoption-bytes";
		const adoption = prospectiveCreatorAdoptionBytes(registration, input, current, material);
		let settlementSizing: CreatorPostAdoptionSettlementSizing | undefined;
		stage = "settlement-frontiers";
		if (metadataReadout.settlementFrontiers !== undefined) {
			if (input.prospectiveSettlementPreview === undefined) throw new TypeError("prospective creator settlement room constructor is unavailable");
			settlementSizing = {frontiers: metadataReadout.settlementFrontiers, preview: input.prospectiveSettlementPreview};
		}
		stage = "post-adoption-sizing";
		const postAdoptionCensusSizing = await proof.readPostAdoptionSizing(unsignedBytes, material.prepared.close, adoption.projection, settlementSizing);
		const successorFenceCount = settlementProfileFor(registration.currentTrust.profileId) === "v1" ? 1 : 0;
		if (postAdoptionCensusSizing === undefined || postAdoptionCensusSizing.length === 0 ||
			postAdoptionCensusSizing.some(variant => variant.currentContinuation !== undefined ||
				(successorFenceCount === 0
					? variant.nativeJobPhases !== undefined || variant.successorJournalAppendForSizing !== undefined
					: variant.successorJournalAppendForSizing === undefined || variant.nativeJobPhases?.length !== 2 ||
						variant.nativeJobPhases[0]?.phase !== "reserved" || variant.nativeJobPhases[1]?.phase !== "entered" ||
						variant.nativeJobPhases.some(phase => !Number.isSafeInteger(phase.canonicalUnsignedVertexByteLength) || phase.canonicalUnsignedVertexByteLength < 1))))
			throw new TypeError("creator ordinary finishing shape is unavailable");
		stage = "capacity-dimensions";
		const preimage = readCreatorOrdinaryPreimageCapacityForSizing(unsignedBytes);
		if (preimage === undefined) throw new TypeError("creator ordinary preimage shape is unavailable");
		const retainedLeafWidths = proof.readCapacityLeafWidths();
		const canonicalPreimageByteLength = Math.max(preimage.canonicalPreimageByteLength, retainedLeafWidths.canonicalPreimageByteLength);
		const canonicalEpochVertexByteLength = Math.max(preimage.canonicalEpochVertexByteLength, retainedLeafWidths.canonicalEpochVertexByteLength);
		const canonicalSuccessorFencePreimageByteLength = successorFenceCount === 0 ? 0 : Math.max(...postAdoptionCensusSizing.flatMap(variant =>
			variant.nativeJobPhases!.map(phase => phase.canonicalUnsignedVertexByteLength)));
		const actualRuntime = proof.readRuntime();
		const debtScopes = new Set([actualRuntime.issuanceScope, ...nativeRows.lineages, ...nativeRows.issued,
			...nativeRows.outbox, ...nativeRows.plans.map(plan => plan.scope)].map(scope => JSON.stringify([scope.objectId, scope.author])));
		const currentJournalRowCount = data.journal.canonicalRows.filter(bytes => {
			const frame = decodeCanonical(bytes);
			if (!Array.isArray(frame) || frame.length !== 3 || !Array.isArray(frame[1]))
				throw new TypeError("creator ordinary native journal frame is unavailable");
			return frame[0] !== "scopes" && frame[1][0] === actualRuntime.objectId && frame[1][1] === actualRuntime.epoch &&
				frame[1][2] === actualRuntime.anchorDigest;
		}).length;
		if (nativeRows.outbox.length > 256 || currentJournalRowCount > 256)
			throw new TypeError("creator ordinary source count is outside the local capacity domain");
		const runtimeWidths = proof.readCapacityWidths({scope: actualRuntime.issuanceScope,
			currentScope: {objectId: actualRuntime.objectId, epoch: actualRuntime.epoch, anchorDigest: actualRuntime.anchorDigest},
			maxIssuerDescriptors: nativeRows.outbox.length, maxDebtDescriptors: debtScopes.size,
			maxCurrentJournalRows: currentJournalRowCount, maxDependencyAnchors: 7,
			canonicalPreimageByteLength,
			canonicalEpochVertexByteLength,
			successorFenceCount,
			successorFencePreimageByteLength: canonicalSuccessorFencePreimageByteLength});
		const ordinaryFinishingCapacityDimensions = Object.freeze({runtime: runtimeWidths, successorFenceCount,
			canonicalPreimageByteLength, canonicalEpochVertexByteLength, canonicalSuccessorFencePreimageByteLength});
		stage = "issuance-phases";
		const unsigned = decodeCanonical(unsignedBytes);
		if (!plainRecord(unsigned) || typeof unsigned.authorSequence !== "number") throw new TypeError("creator ordinary unsigned identity is malformed");
		const issuancePhases = received === undefined ? issuanceUnsignedPostimageWidths(nativeRows, registration.issuanceScope,
			{kind: "v3-issuance-pending-unsigned-1", authorSequence: unsigned.authorSequence, canonicalPreimageBytes: unsignedBytes,
				digest: hashDomain("ts-drp/vertex/v3", unsignedBytes)}, nativeControl,
			creatorSourceCustodyGeometryForSizing(registration.currentTrust, registration.exactCanonicalLatchedAclBytes,
				Number((decodeCanonical(registration.exactCanonicalParametersBytes) as Record<string, unknown>).maxEpochVertices))) : undefined;
		stage = "signing-widths";
		const signing = readCreatorCloseSigningFramesForSizing({currentTrust: registration.currentTrust,
			genuinePreparedClose: material.prepared.close, exactCanonicalCutValueBytes: material.prepared.exactCanonicalCutValueBytes,
			prepareQcByteLength: material.widths.prepareQcBytes, commitQcByteLength: material.widths.commitQcBytes,
			successorTrustByteLength: material.widths.trustBytes, storageIncarnation: input.storageIncarnation, actualRows: data.signingRows});
		if (!signing.ok) throw new TypeError(`creator ordinary signing codec refused: ${signing.reason}`);
		stage = "image-currency-context";
		const expectedIssuanceImageDigest = data.nativeIssuance.image.imageDigest;
		if (typeof expectedIssuanceImageDigest !== "string" || !/^[0-9a-f]{64}$/.test(expectedIssuanceImageDigest))
			throw new TypeError("creator ordinary issuance image currency is malformed");
		const context = Object.freeze({expectedIssuanceImageDigest,
			expectedIssuanceControlBytes: nativeControl === null ? null : encodeIssuanceRetirementControl(nativeControl)});
		stage = "final-proof-check";
		await proof.check();
		return Object.freeze({proof, material, metadata: metadataReadout.frames, adoption, issuancePhases,
			...(received === undefined ? {} : {receivedSignature: received.signature}),
			ordinaryFinishingCapacityDimensions,
			runtimeCensusOverheadByteLength: runtimeWidths.currentClose,
			postAdoptionCensusSizing,
			exactCanonicalCurrentLatchedAclBytes: proof.readRuntime().exactCanonicalLatchedAclBytes,
			signingFrames: signing.frames, context});
	} catch (primary) {
		try { if (proof === undefined) await runtime.release(); else await proof.release(); }
		catch (cleanup) {
			reportRefusal(primary, "failed", cleanup);
			throw new AggregateError([primary, cleanup], "creator ordinary quote release failed", {cause: primary});
		}
		reportRefusal(primary, "joined");
		if (primary instanceof AggregateError) throw primary;
		return undefined;
	}
}

/** The same actual encodings and complete UNKNOWN occurrences feed both
 * numerical paths. Custody and the paid book are supplied separately. */
function creatorIssuanceMaintenanceQuoteSizing(
	quote: Omit<CreatorIssuanceMaintenanceQuote, "proof" | "archiveCapacity"> &
		Pick<CreatorIssuanceMaintenanceQuote, "archiveCapacity">,
	unsignedBytes: Uint8Array,
	planEffect?: NonNullable<DurableIssueCommit["planEffect"]>
) {
	const { material, metadata, adoption, issuancePhases, signingFrames } = quote;
	// This is the exact existing ordinary proof charge basis, projected without
	// spending any charge before a conservative continuation is selected.
	const knownBasis = [
		...(quote.archiveCapacity === undefined ? [] : [encodeCanonical(quote.archiveCapacity.status),encodeCanonical(quote.archiveCapacity.declaration)]),
		material.prepared.exactCanonicalCutValueBytes,
		material.snapshot.exactCanonicalManifestBytes,
		material.preview.exactCanonicalPayloadBytes,
		...material.snapshot.chunks,
		material.preview.exactCanonicalSuccessorAclBytes,
		material.widths.exactCanonicalAnchorPreimageBytes,
		adoption.projection,
		adoption.history,
	];
	const receivedSignature = quote.receivedSignature === undefined ? [] : [quote.receivedSignature];
	const unknownBasis = [
		...(quote.archiveCapacity === undefined ? [] : [quote.archiveCapacity.status.maxControlByteLength]),
		quote.ordinarySignMaterialByteLength ?? (issuancePhases === undefined ? 0 : Math.max(
			issuancePhases.reserved.nativeCensusBytes,
			issuancePhases.entered.nativeCensusBytes,
			issuancePhases.final.nativeCensusBytes
		)),
		quote.runtimeCensusOverheadByteLength,
	];
	const fields = {
		...(quote.ordinaryFinishingCapacityDimensions === undefined ? {} :
			{ordinaryFinishingCapacityDimensions: quote.ordinaryFinishingCapacityDimensions}),
		ordinaryChargeBasis: { known: [...knownBasis, ...receivedSignature], unknown: unknownBasis },
		genuinePreparedClose: material.prepared.close,
		exactCanonicalUnsignedVertexBytes: unsignedBytes,
		...(planEffect === undefined ? {} : { planEffect }),
		exactCanonicalCutValueBytes: material.prepared.exactCanonicalCutValueBytes,
		exactCanonicalSnapshotManifestBytes: material.snapshot.exactCanonicalManifestBytes,
		exactCanonicalSnapshotPayloadBytes: material.preview.exactCanonicalPayloadBytes,
		exactCanonicalSnapshotChunks: material.snapshot.chunks as readonly Uint8Array[],
		exactCanonicalSuccessorAnchorPreimageBytes: material.widths.exactCanonicalAnchorPreimageBytes,
		successorAnchorDigest: material.widths.successorAnchorDigest,
		exactCanonicalSuccessorProjectionBytes: adoption.projection,
		exactCanonicalCurrentLatchedAclBytes: quote.exactCanonicalCurrentLatchedAclBytes,
		exactCanonicalSuccessorLatchedAclBytes: material.preview.exactCanonicalSuccessorAclBytes,
		exactCanonicalCloseHistoryBytes: adoption.history,
		prepareQcByteLength: material.widths.prepareQcBytes,
		commitQcByteLength: material.widths.commitQcBytes,
		successorTrustByteLength: material.widths.trustBytes,
		metadata,
		signingFrames,
		issuancePhases,
		...(quote.receivedSignature === undefined ? {} : {receivedSignature: quote.receivedSignature}),
		runtimeCensusOverheadByteLength: quote.runtimeCensusOverheadByteLength,
		postAdoptionCensusSizing: quote.postAdoptionCensusSizing,
		...(quote.archiveCapacity === undefined ? {} : {archiveConstruction: {
			cutValueByteLength:quote.archiveCapacity.cutValueByteLength,
			unknownByteLengths:quote.archiveCapacity.futureUnknownByteLengths}}),
	} as const;
	return {knownBasis, receivedSignature, unknownBasis, fields};
}

async function chargeCreatorIssuanceMaintenanceQuote(
	quote: CreatorIssuanceMaintenanceQuote,
	unsignedBytes: Uint8Array,
	planEffect?: NonNullable<DurableIssueCommit["planEffect"]>,
	source?: CreatorOrdinaryIssuanceProofSource
): Promise<boolean> {
	const {proof} = quote, accounting = proof.accounting;
	const {knownBasis, receivedSignature, unknownBasis, fields} = creatorIssuanceMaintenanceQuoteSizing(quote, unsignedBytes, planEffect);
	const prefixInput = {...fields, proof};
	// Source capture and compilation precede every NEW UNKNOWN charge. The
	// compiler retains numerical fields only in this handle's one source cell.
	const captured = source === undefined ? undefined : await captureCreatorOrdinaryFinishingCapacityTemplate(prefixInput, source);
	// The verified bound is used only through its genuine per-call owner. Cold
	// fallback retains original exact sizing, without the extra diagnostic pass.
	const { ordinaryFinishingCapacityDimensions: _diagnosticDimensions, ...exactPrefixInput } = prefixInput;
	const prefixes = captured?.prefixes ?? await readProspectiveCreatorMaintenancePrefixesForSizing(exactPrefixInput);
	if (!prefixes.ok) throw new TypeError(`creator issuance maintenance prefix sizing is unavailable: ${prefixes.reason}`);
	// Known original encodings receive only the existing byte-exact dedup law.
	// Unknown signature/control leaves never receive identity or refund credit.
	const known = [
		...knownBasis,
		...(prefixes.knownCarriers ?? []),
		...receivedSignature,
	];
	for (const bytes of known)
		if (!accounting.charge(bytes)) throw new TypeError("creator issuance maintenance proof reserve is exhausted");
	// The private source owner has reserved complete future close/adopt and
	// maintenance lifetimes against their fixed maintenance entitlement. They are not retained
	// by this current issuance job; charge only its complete immediate phases.
	const unknown = [
		...unknownBasis,
		...prefixes.unknownEncodedLengths,
	];
	for (const length of unknown)
		if (!accounting.chargeUnknownEncodedLength(length))
			throw new TypeError("creator issuance maintenance proof reserve is exhausted");
	return captured?.captured ?? false;
}

async function chargeCreatorOrdinaryIssuanceMaintenanceQuote(
	quote: CreatorOrdinaryIssuanceMaintenanceQuote,
	unsignedBytes: Uint8Array
): Promise<boolean> {
	const {proof} = quote;
	await proof.check();
	const {knownBasis, receivedSignature, unknownBasis, fields} = creatorIssuanceMaintenanceQuoteSizing(quote, unsignedBytes);
	const prefixes = evaluateCreatorOrdinaryFinishingCapacityTemplate({...fields, proof});
	if (prefixes === undefined || !prefixes.ok) return false;
	await proof.check();
	// The numerical owner has checked this SAME fresh book's exact known-byte
	// union and complete UNKNOWN occurrence fit before spending any quote charge.
	for (const bytes of [...knownBasis, ...prefixes.knownCarriers, ...receivedSignature])
		if (!proof.accounting.charge(bytes)) throw new TypeError("creator ordinary issuance proof reserve is exhausted");
	for (const length of [...unknownBasis, ...prefixes.unknownEncodedLengths])
		if (!proof.accounting.chargeUnknownEncodedLength(length))
			throw new TypeError("creator ordinary issuance proof reserve is exhausted");
	await proof.check();
	return true;
}

function sameHead(left: PresentHead, right: PresentHead): boolean {
	return (
		left.closureDigest === right.closureDigest &&
		left.generationId === right.generationId &&
		left.objectId === right.objectId &&
		left.revision === right.revision
	);
}

function generationId(): GenerationId {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const parsed = parseGenerationId(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
	if (!parsed.ok) throw new TypeError("creator close generation identity failed");
	return parsed.value;
}

function canonicalVarUint(
	bytes: Uint8Array,
	offset: number
): Readonly<{ readonly nextOffset: number; readonly value: number }> | undefined {
	let value = 0;
	let multiplier = 1;
	for (let count = 0; count < 9 && offset < bytes.byteLength; count += 1) {
		const byte = bytes[offset] as number;
		offset += 1;
		value += (byte & 0x7f) * multiplier;
		if (!Number.isSafeInteger(value)) return undefined;
		if ((byte & 0x80) === 0) {
			if (count > 0 && (byte & 0x7f) === 0) return undefined;
			return Object.freeze({ nextOffset: offset, value });
		}
		multiplier *= 128;
	}
	return undefined;
}

function canonicalRootKind(bytes: Uint8Array): string | undefined {
	if (bytes[0] !== 0x08) return undefined;
	const fieldCount = canonicalVarUint(bytes, 1);
	if (fieldCount === undefined || fieldCount.value < 1 || bytes[fieldCount.nextOffset] !== 0x05) return undefined;
	const keyLength = canonicalVarUint(bytes, fieldCount.nextOffset + 1);
	if (keyLength?.value !== 4) return undefined;
	const keyOffset = keyLength.nextOffset;
	if (
		bytes[keyOffset] !== 0x6b ||
		bytes[keyOffset + 1] !== 0x69 ||
		bytes[keyOffset + 2] !== 0x6e ||
		bytes[keyOffset + 3] !== 0x64 ||
		bytes[keyOffset + 4] !== 0x05
	) {
		return undefined;
	}
	const kindLength = canonicalVarUint(bytes, keyOffset + 5);
	if (kindLength === undefined || kindLength.value < 1 || kindLength.value > 128) return undefined;
	const end = kindLength.nextOffset + kindLength.value;
	if (end > bytes.byteLength) return undefined;
	let kind = "";
	for (let index = kindLength.nextOffset; index < end; index += 1) {
		const byte = bytes[index] as number;
		if (byte > 0x7f) return undefined;
		kind += String.fromCharCode(byte);
	}
	return kind;
}

function latchedAclRecordCeiling(bytes: Uint8Array): number {
	if (bytes.byteLength <= SETTLEMENT_ACL_MAX_RECORD_BYTES) {
		try {
			const decoded = decodeCanonical(bytes, {
				maxBytes: SETTLEMENT_ACL_MAX_RECORD_BYTES,
				maxDepth: 4,
				maxItems: 8192,
			});
			if (plainRecord(decoded) && decoded.version === 3) return SETTLEMENT_ACL_MAX_RECORD_BYTES;
		} catch {
			// A malformed recognized ACL remains subject to the legacy ceiling here
			// and will fail its canonical opener if it fits that ceiling.
		}
	}
	return LEGACY_ACL_MAX_RECORD_BYTES;
}

function creatorCloseCandidate(
	bytes: Uint8Array,
	ref: GenerationRef
): Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }> | undefined {
	const kind = canonicalRootKind(bytes);
	const ceiling =
		kind === "drp-v3-latched-acl"
			? latchedAclRecordCeiling(bytes)
			: kind === undefined
				? undefined
				: CREATOR_CLOSE_RECORD_CEILINGS[kind];
	if (ceiling !== undefined && ref.byteLength > ceiling) {
		throw new TypeError(`creator close ${kind} record exceeds its canonical byte ceiling`);
	}
	if (ceiling === undefined && ref.byteLength > ANCHOR_TRUST_STATE_MAX_RECORD_BYTES) return undefined;
	return Object.freeze({ bytes: Uint8Array.from(bytes), ref });
}

function creatorCloseCandidates(
	candidates: readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[]
): readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[] {
	const selected = candidates.map(({ bytes, ref }) => creatorCloseCandidate(bytes, ref));
	if (selected.some((candidate) => candidate === undefined)) {
		throw new TypeError("creator close generated record exceeds its canonical byte ceiling");
	}
	return Object.freeze(selected as readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[]);
}

/**
 *
 * @param store
 * @param objectId
 */
export async function inspectHead(
	store: AheDurableStore,
	objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0]
): Promise<
	Readonly<{
		candidates: readonly Readonly<{ bytes: Uint8Array; ref: GenerationRef }>[];
		head: PresentHead;
		references: readonly GenerationRef[];
		trustRef: GenerationRef;
	}>
> {
	const result = await store.recoverActiveGeneration(objectId);
	const recovered = successfulValue<Readonly<Record<string, unknown>>>(result);
	if (recovered?.kind !== "active" || !plainRecord(recovered.head) || !Array.isArray(recovered.references)) {
		// Diagnostic only: the store's own refusal travels with the error.
		throw new TypeError(`creator close active generation is unavailable${storeRefusalSuffix(result)}`, {
			cause: result,
		});
	}
	const references = Object.freeze((recovered.references as GenerationRef[]).map(copiedRef));
	const blobs: Array<Readonly<{ bytes: Uint8Array; ref: GenerationRef }>> = [];
	for (const ref of references) {
		const bytes = successfulValue<Uint8Array | null>(await store.getBlob(ref.digest));
		if (!(bytes instanceof Uint8Array)) throw new TypeError("creator close generation blob is unavailable");
		blobs.push({ bytes, ref });
	}
	return inspectCreatorCloseHead(recovered.head as PresentHead, references, blobs);
}

/**
 * Shares original candidate/trust inspection between recovered and held sources.
 * This pure inspection does not acquire, recover or release native custody.
 * @param head - Original current head.
 * @param references - Complete original current generation closure.
 * @param blobs - Complete native readout; it may include protected ancestors.
 * @returns Original inspected close source, not independent mutation authority.
 */
function inspectCreatorCloseHead(
	head: PresentHead,
	references: readonly GenerationRef[],
	blobs: readonly Readonly<{ bytes: Uint8Array; ref: GenerationRef }>[]
): InspectedHead {
	const closure = Object.freeze(references.map(copiedRef));
	const candidates: Array<Readonly<{ bytes: Uint8Array; ref: GenerationRef }>> = [];
	for (const ref of closure) {
		const matching = blobs.filter((blob) => blob.ref.digest === ref.digest && blob.ref.byteLength === ref.byteLength);
		if (matching.length !== 1 || matching[0] === undefined)
			throw new TypeError("creator close generation blob is unavailable or ambiguous");
		const candidate = creatorCloseCandidate(matching[0].bytes, ref);
		if (candidate !== undefined) candidates.push(candidate);
	}
	const inspected = inspectTrustClosure({
		candidates: candidates.filter(({ ref }) => ref.byteLength <= ANCHOR_TRUST_STATE_MAX_RECORD_BYTES),
		closure,
	});
	if (!inspected.ok) throw new TypeError(`creator close trust scan failed: ${inspected.reason}`);
	return Object.freeze({
		candidates: Object.freeze(candidates),
		head: Object.freeze({ ...head }),
		references: closure,
		trustRef: copiedRef(inspected.trustRef),
	});
}

async function persistSnapshot(
	store: SnapshotQuarantineStore<SnapshotVerificationReceipt>,
	input: Readonly<{
		aclDigest: string;
		anchor: string;
		epoch: number;
		exactCanonicalPayloadBytes: Uint8Array;
		objectId: string;
		stateDigest: string;
	}>
): Promise<
	Readonly<{
		declaration: SnapshotQuarantineDeclaration;
		exactCanonicalManifestBytes: Uint8Array;
		manifestDigest: string;
	}>
> {
	const encoded = encodeSnapshotTransfer({ ...input, profile: PROFILE, schemaVersion: 1 });
	const decoded = decodeSnapshotManifest({
		exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
		expectedManifestDigest: encoded.manifestDigest,
		profile: PROFILE,
	});
	const scopeKey = Object.freeze({
		anchor: input.anchor,
		epoch: input.epoch,
		manifestDigest: encoded.manifestDigest,
		objectId: input.objectId,
	});
	const scope = await store.openScope({
		chunks: decoded.chunks,
		exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
		scope: scopeKey,
		totalBytes: decoded.chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
	});
	try {
		const verified = verifySnapshotStreamWithReceipt({
			exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
			expectedManifestDigest: encoded.manifestDigest,
			expectedScope: scopeKey,
			profile: PROFILE,
			quarantine: scope.verificationQuarantine,
			source: Object.freeze({
				read: (descriptor: Readonly<{ readonly index: number }>) =>
					Promise.resolve(
						encoded.chunks[descriptor.index] === undefined ? undefined : encoded.chunks[descriptor.index]
					),
			}),
		});
		await verified.completion;
		await scope.complete(await verified.receipt);
		await scope.retainForRecovery();
		return Object.freeze({
			declaration: Object.freeze({
				chunks: Object.freeze(decoded.chunks.map((chunk) => Object.freeze({ ...chunk }))),
				exactCanonicalManifestBytes: Uint8Array.from(encoded.exactCanonicalManifestBytes),
				scope: scopeKey,
				totalBytes: decoded.chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
			}),
			exactCanonicalManifestBytes: Uint8Array.from(encoded.exactCanonicalManifestBytes),
			manifestDigest: encoded.manifestDigest,
		});
	} finally {
		await scope.release();
	}
}

/**
 *
 * @param store
 * @param current
 * @param newBlobs
 * @param proposed
 * @param nativeFutureFactory - Original verified close custody, never a raw epoch override.
 */
export async function stageCombinedGeneration(
	store: AheDurableStore,
	current: Awaited<ReturnType<typeof inspectHead>>,
	newBlobs: readonly Readonly<{ bytes: Uint8Array; ref: GenerationRef }>[],
	proposed: readonly GenerationRef[],
	nativeFutureFactory?: (selectedGenerationId: GenerationId, existingCompleteGeneration?: GenerationRecord) => unknown,
	archive?: Readonly<Omit<Parameters<typeof completeCreatorCertifiedArchiveAppend>[0], "checkCurrent"> & {
		/** Original private close owner; exact whole provider floor, checked afresh after joining proof custody. */
		checkSourceCurrency(): Promise<void>;
	}>
): Promise<PresentHead> {
	const closureDigest = digestClosure(proposed);
	if (!closureDigest.ok) throw new TypeError("creator close closure digest failed");
	let existingCompleteGeneration: GenerationRecord | undefined;
	if (archive !== undefined) {
		await archive.checkSourceCurrency();
		// The original close owner has already authenticated proposed/newBlobs. A matching
		// native label alone cannot authorize retry: bind the complete base, whole closure
		// and every exact new proof byte before selecting the same durable close intent.
		const census = await store.readGenerationPage({ objectId: current.head.objectId,
			limit: AHE_BOUNDED_READ_LIMITS.maxObjectGenerations });
		if (!census.ok || census.value.nextCursor !== null || !archive.accounting.charge(encodeCanonical(census.value)))
			throw new TypeError("archive same-intent close recovery census is unavailable or exhausted");
		const matches = census.value.generations.filter(row => row.state === "Complete" &&
			row.baseExpectedHead.kind === "present" && sameHead(row.baseExpectedHead, current.head) &&
			row.closureDigest === closureDigest.value && compareBytes(encodeCanonical(row.closure), encodeCanonical(proposed)) === 0);
		if (matches.length > 1) throw new TypeError("archive same-intent close recovery is ambiguous");
		existingCompleteGeneration = matches[0];
		if (existingCompleteGeneration !== undefined) {
			for (const blob of newBlobs) {
				const read = await store.getBlob(blob.ref.digest);
				if (!read.ok || !(read.value instanceof Uint8Array) || compareBytes(read.value, blob.bytes) !== 0 || !archive.accounting.charge(read.value))
					throw new TypeError("archive same-intent close recovery proof bytes differ or exhaust their full charge");
			}
			const source = await store.readHead(current.head.objectId);
			if (!source.ok || source.value.kind !== "present" || !sameHead(source.value, current.head) ||
				!archive.accounting.charge(encodeCanonical(source.value)))
				throw new TypeError("archive same-intent close recovery source is stale or exhausted");
		}
	}
	const selectedGenerationId = existingCompleteGeneration?.generationId ?? generationId();
	const native = store as AheBoundedRecoveryRoleStore;
	const commitArchiveBeforePublish = async (): Promise<void> => {
		if (archive === undefined) return;
		const checkCurrent = async (): Promise<void> => {
			await archive.checkSourceCurrency();
			const source = await store.readHead(current.head.objectId);
			const census = await store.readGenerationPage({ objectId: current.head.objectId, limit: AHE_BOUNDED_READ_LIMITS.maxObjectGenerations });
			const complete = census.ok && census.value.nextCursor === null
				? census.value.generations.filter(row => row.generationId === selectedGenerationId) : [];
			if (!source.ok || source.value.kind !== "present" || !sameHead(source.value, current.head) || complete.length !== 1 || complete[0]?.state !== "Complete" ||
				complete[0].baseExpectedHead.kind !== "present" || !sameHead(complete[0].baseExpectedHead, current.head) ||
				complete[0].closureDigest !== closureDigest.value || compareBytes(encodeCanonical(complete[0].closure), encodeCanonical(proposed)) !== 0)
				throw new TypeError("archive certified Complete intent or original source head is stale");
			if (!census.ok || !archive.accounting.charge(encodeCanonical(source.value)) || !archive.accounting.charge(encodeCanonical(census.value)))
				throw new TypeError("archive Complete intent full native census charge is exhausted");
			for (const blob of newBlobs) {
				const read = await store.getBlob(blob.ref.digest);
				if (!read.ok || !(read.value instanceof Uint8Array) || compareBytes(read.value, blob.bytes) !== 0 || !archive.accounting.charge(read.value))
					throw new TypeError("archive certified Complete intent proof bytes changed or exhausted their full charge");
			}
		};
		await completeCreatorCertifiedArchiveAppend({ ...archive, checkCurrent });
	};
	if (native.readRetirementControl !== undefined) {
		const observed = await native.readRetirementControl(current.head.objectId);
		if (!observed.ok) throw new TypeError("creator close retirement observation failed");
		if (observed.value !== null && observed.value.completed !== null) {
			if (nativeFutureFactory === undefined || native.acquireRetirementControl === undefined)
				throw new TypeError("creator close native future custody is unavailable");
			const capability = nativeFutureFactory(selectedGenerationId, existingCompleteGeneration);
			for (const phase of ["stage", "publish"] as const) {
				if (phase === "publish") await commitArchiveBeforePublish();
				const acquired = await native.acquireRetirementControl(current.head.objectId);
				if (!acquired.ok) throw new TypeError("creator close native future acquisition failed");
				let failed = false,
					primary: unknown;
				try {
					const result =
						phase === "stage"
							? await acquired.value.stageNominatedFutureGeneration(capability)
							: await acquired.value.publishNominatedFutureGeneration(capability);
					if (!result.ok) throw new TypeError(`creator close native future ${phase} failed:${result.reason}`);
				} catch (cause) {
					failed = true;
					primary = cause;
				}
				try {
					await acquired.value.release();
				} catch (cleanup) {
					if (failed)
						throw new AggregateError([primary, cleanup], "creator close native future and release failed", {
							cause: primary,
						});
					throw cleanup;
				}
				if (failed) throw primary;
			}
			return verifyCombinedGenerationHead(store, current.head, selectedGenerationId, closureDigest.value);
		}
	}
	if (existingCompleteGeneration === undefined) {
		const begun = successfulValue<Readonly<{ readonly closureDigest: string }>>(
			await store.beginGeneration({
				baseExpectedHead: current.head,
				closure: proposed,
				generationId: selectedGenerationId,
				objectId: current.head.objectId,
			})
		);
		if (begun?.closureDigest !== closureDigest.value) throw new TypeError("creator close generation staging failed");
		for (const blob of newBlobs) {
			const cached = successfulValue<Readonly<{ readonly inserted: boolean }>>(
				await store.putCachedBlob({
					bytes: blob.bytes,
					digest: blob.ref.digest,
					generationId: selectedGenerationId,
					objectId: current.head.objectId,
				})
			);
			if (cached === undefined) throw new TypeError("creator close blob staging failed");
		}
		for (const ref of proposed) {
			const promoted = await store.promoteReference({
				digest: ref.digest,
				generationId: selectedGenerationId,
				objectId: current.head.objectId,
			});
			if (!successfulUndefined(promoted)) throw new TypeError("creator close reference promotion failed");
		}
		const completed = successfulValue<Readonly<{ readonly closureDigest: string }>>(
			await store.completeGeneration({ generationId: selectedGenerationId, objectId: current.head.objectId })
		);
		if (completed?.closureDigest !== closureDigest.value)
			throw new TypeError("creator close generation completion failed");
	}
	await commitArchiveBeforePublish();
	let swapped: PresentHead | undefined;
	try {
		const result = successfulValue<Readonly<{ readonly head: PresentHead }>>(
			await store.swapHead({
				expectedHead: current.head,
				generationId: selectedGenerationId,
				objectId: current.head.objectId,
			})
		);
		swapped = result?.head;
	} catch {
		// Reopen below decides whether an ambiguous write committed.
	}
	return verifyCombinedGenerationHead(store, current.head, selectedGenerationId, closureDigest.value, swapped);
}

/**
 * Keeps the original exact head/revision readback for both original staging paths.
 * @param store - Original native generation owner.
 * @param currentHead - Verified captured predecessor head.
 * @param selectedGenerationId - Exactly the original chosen candidate.
 * @param closureDigest - Exactly the accepted closure digest.
 * @param swapped - Optional original ordinary swap delivery.
 * @returns Joined exact published head.
 */
async function verifyCombinedGenerationHead(
	store: AheDurableStore,
	currentHead: PresentHead,
	selectedGenerationId: GenerationId,
	closureDigest: string,
	swapped?: PresentHead
): Promise<PresentHead> {
	const reopened = await inspectHead(store, currentHead.objectId);
	const expected = Object.freeze({
		closureDigest,
		generationId: selectedGenerationId,
		kind: "present" as const,
		objectId: currentHead.objectId,
		revision: currentHead.revision + 1,
	}) as PresentHead;
	if (!sameHead(reopened.head, expected) || (swapped !== undefined && !sameHead(swapped, expected))) {
		throw new TypeError("creator close head swap lost or remained ambiguous");
	}
	return reopened.head;
}

/**
 * Binds one creator-only close authority to a genuine active v3 plane.
 * @param input - Opaque signer, durable actor stores, quarantine and receiver-bound plane.
 * @returns The sole live close handle or a closed authority failure.
 */
export async function bindCreatorLiveClose(
	input: BindCreatorLiveCloseInput
): Promise<Readonly<{ handle: CreatorLiveCloseHandle; ok: true } | { ok: false; reason: string }>> {
	try {
		const windowDescriptor = Object.getOwnPropertyDescriptor(input, "ordinaryFinishingWindow");
		if (windowDescriptor !== undefined) {
			const window = "value" in windowDescriptor && windowDescriptor.enumerable
				? captureCreatorOrdinaryFinishingWindowLimitsForSizing(windowDescriptor.value) : undefined;
			if (window === undefined || input.readOrdinaryApplicationResourceBound === undefined)
				return Object.freeze({ok: false as const, reason: "CREATOR_ORDINARY_FINISHING_WINDOW_INVALID"});
			input = Object.freeze({...input, ordinaryFinishingWindow: window});
		}
		const archive = input.archive === undefined ? undefined : Object.freeze({ store: input.archive.store,
			limits: decodeCanonical(encodeCanonical(input.archive.limits, { maxBytes: 1024, maxDepth: 4, maxItems: 32 })) as unknown as ArchiveLimits });
		if (archive !== undefined && input.promotionContext === undefined)
			return Object.freeze({ ok: false as const, reason: "CREATOR_ARCHIVE_SOURCE_OWNER_UNAVAILABLE" });
		const existing = bindings.get(input.plane);
		if (existing !== undefined) return Object.freeze({ handle: existing, ok: true as const });
		const registration = claimCreatorCloseRegistration(input.plane);
		if (registration === undefined) return Object.freeze({ ok: false as const, reason: "CREATOR_CLOSE_UNAVAILABLE" });
		if (!registration.bindSnapshotReadinessOwner(input.snapshotStore))
			return Object.freeze({ ok: false as const, reason: "CREATOR_SNAPSHOT_OWNER_UNAVAILABLE" });
		const epoch = registration.currentTrust.currentEpoch;
		if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch === Number.MAX_SAFE_INTEGER) {
			return Object.freeze({ ok: false as const, reason: "CREATOR_CLOSE_UNAVAILABLE" });
		}
		const successorEpoch = epoch + 1;
		const boundHead = await inspectHead(registration.store, registration.objectId);
		const boundTrustCandidate = boundHead.candidates.find(({ ref }) => sameRef(ref, boundHead.trustRef));
		if (
			boundTrustCandidate === undefined ||
			verifiedCreatorTrustRecord(registration, boundTrustCandidate.bytes) === undefined
		) {
			return Object.freeze({ ok: false as const, reason: "CREATOR_TRUST_UNAVAILABLE" });
		}
		const opened = await createCreatorSealActor({
			currentTrust: registration.currentTrust,
			evidenceStore: input.evidenceStore,
			onObservation: input.onObservation,
			signer: input.signer,
			storageIncarnation: input.storageIncarnation,
			voteStore: input.voteStore,
		});
		if (!opened.ok) return Object.freeze({ ok: false as const, reason: opened.reason });
		if (opened.actor.status().terminal) {
			await opened.actor.stop();
			return Object.freeze({ ok: false as const, reason: "CREATOR_CONTINUITY_TERMINAL" });
		}
		const actor = opened.actor as CreatorActor;
		let lifecycle: CreatorLiveCloseStatus["lifecycle"] = "active";
		let closeTask: Promise<CreatorLiveCloseResult> | undefined;
		let stagedSnapshot:
			| Extract<Awaited<ReturnType<V3CreatorCloseRegistration["stageSnapshot"]>>, { readonly ok: true }>
			| undefined;
		let capturedGraph: Exclude<ReturnType<V3CreatorCloseRegistration["captureCloseGraph"]>, undefined> | undefined;
		let persistedSnapshot: Awaited<ReturnType<typeof persistSnapshot>> | undefined;
		let retirementReconciliationPending = false;
		// Process-local fact from an explicit early pool turnover at this epoch.
		let earlyTurnover: CreatorEarlyTurnoverToken | undefined;
		let derivedCommitment: Awaited<ReturnType<typeof deriveCloseSetHistoryCommitment>> | undefined;
		let durableReplay: Readonly<{ verify(): Promise<boolean> }> | undefined;
		let archivePreparation: Awaited<ReturnType<typeof prepareCreatorClosedArchiveAppend>> | undefined;
		let archiveAccounting: import("./internal/creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting | undefined;
		let checkArchiveSourceCurrency: (() => Promise<void>) | undefined;
		let promotionSource: CreatorForwardPromotionSourceMaterial | undefined;
		let promotionSourceIdentity: Uint8Array | undefined;
		let recoverySource: CreatorForwardPromotionSourceMaterial | undefined;
		let retiredSourceGenerations: readonly GenerationRecord[] = Object.freeze([]);
		let promotedEpoch: number | undefined;
		let stopping = false;
		let stopTask: Promise<void> | undefined;
		let acquisitionTask: Promise<void> | undefined;
		let dependencyReleaseTask: Promise<void> | undefined;
		let dependenciesReleased = false;
		let maintenanceClosing = false;
		let maintenanceReleaseFailure: unknown;
		// One immutable source token, never a cold proof, reader, paid book or
		// per-operation observations. An unsupported template keeps exact sizing.
		let ordinaryProofSource: CreatorOrdinaryIssuanceProofSource | undefined;
		let ordinaryTemplateReady = false;
		const maintenanceJobs = new Set<Promise<void>>();
		const maintenanceConsumer: CreatorIssuanceMaintenanceConsumer = (candidate) => {
			const receivedReceipt = candidate.kind === "received-append" ? candidate.receipt : undefined;
			const received = receivedReceipt === undefined ? undefined : registration.readReceivedAppendCandidate(receivedReceipt);
			const bytes = candidate.kind === "local-issuance" ? candidate.exactCanonicalUnsignedVertexBytes : received!.bytes;
			const effect = candidate.kind === "local-issuance" ? candidate.planEffect : undefined;
			if (
				stopping ||
				maintenanceClosing ||
				maintenanceJobs.size !== 0 ||
				maintenanceReleaseFailure !== undefined ||
				dependenciesReleased ||
				dependencyReleaseTask !== undefined ||
				acquisitionTask !== undefined ||
				promotedEpoch !== undefined ||
				lifecycle !== "active" ||
				actor.status().terminal
			)
				return Promise.reject(new TypeError("creator issuance maintenance authority is unavailable"));
			if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > registration.maxEpochBytes)
				return Promise.reject(new TypeError("creator issuance maintenance unsigned bytes are invalid"));
			// Capture the original issuer-produced preimage and settlement context
			// synchronously, before the queued job or any release can reenter stop.
			const unsignedBytes = Uint8Array.from(bytes);
			const planEffect = captureIssuanceNativeSignContext(
				effect === undefined ? undefined : { planEffect: effect }
			)?.planEffect;
			const suffix = candidate.kind === "local-issuance" && candidate.finishingSuffix !== undefined
				? Object.freeze({...candidate.finishingSuffix,
					exactCanonicalApplicationOperationBytes: candidate.finishingSuffix.exactCanonicalApplicationOperationBytes.slice()}) : undefined;
			let finish!: () => void;
			const joined = new Promise<void>((resolve) => {
				finish = resolve;
			});
			maintenanceJobs.add(joined);
			// The admitted job is the host's foreground until its slot is released:
			// co-located background walks defer their host turns behind it.
			const releaseForeground = beginForegroundWork();
			const finishJoined = (): void => {
				releaseForeground();
				maintenanceJobs.delete(joined);
				finish();
			};
			return Promise.resolve().then(async () => {
				let quote: CreatorIssuanceMaintenanceQuote | CreatorOrdinaryIssuanceMaintenanceQuote | CreatorIncrementalIssuanceMaintenanceQuote | undefined;
				// The queued issuance job keeps its quote's native custody across
				// these boundaries; the issuer's own write transaction starts later.
				const checkpoint = createWorkCheckpoint();
				const cooperate = async (): Promise<void> => {
					await checkpoint();
					if (stopping) throw new TypeError("creator issuance maintenance admission was revoked");
				};
				try {
					if (stopping) throw new TypeError("creator issuance maintenance admission was revoked");
					const ordinaryDomain = planEffect === undefined && input.archive === undefined &&
						readCreatorOrdinaryPreimageCapacityForSizing(unsignedBytes) !== undefined;
					const newWindowAdmission = input.ordinaryFinishingWindow !== undefined && input.archive === undefined &&
						planEffect === undefined && received?.protectedContinuation !== true;
					if (newWindowAdmission && !ordinaryDomain)
						throw new TypeError("creator ordinary candidate exceeds the local finishing window domain before admission");
					const report = (event: Readonly<Record<string, unknown>>): void => {
						try {
							const observer = Reflect.get(globalThis, "__warmProofEvent");
							if (typeof observer === "function") observer({epoch: registration.currentTrust.currentEpoch, phase: candidate.kind, ...event});
						} catch { /* Diagnostics cannot alter admission or cleanup. */ }
					};
					if (ordinaryDomain && input.readOrdinaryApplicationResourceBound !== undefined &&
						(registration.currentTrust.profileId === "creator-trusted-v1" || registration.currentTrust.profileId === "creator-trusted-settlement-v1")) {
						if (ordinaryProofSource === undefined) {
							ordinaryProofSource = await captureCreatorOrdinarySourceWithoutForecast(registration, input, receivedReceipt);
							report({kind: "ordinary-incremental-source-prime", ok: ordinaryProofSource !== undefined});
						}
						if (ordinaryProofSource !== undefined) {
							let sourceUnavailable = false;
							quote = await prepareCreatorIncrementalIssuanceMaintenanceQuote(registration, input, unsignedBytes, ordinaryProofSource, receivedReceipt,
								() => { sourceUnavailable = true; ordinaryProofSource = undefined; ordinaryTemplateReady = false; }, suffix);
							// A genuine joined source mismatch (for example the first
							// native issuer-control birth) needs fresh authenticated
							// custody, not hypothetical future scenario construction.
							// Re-prime and retry ONCE. Both attempts own distinct books;
							// no old allowance or authority survives. Numerical misses
							// and any second source miss retain the original exact path.
							if (quote === undefined && sourceUnavailable) {
								ordinaryProofSource = await captureCreatorOrdinarySourceWithoutForecast(registration, input, receivedReceipt);
								report({kind: "ordinary-incremental-source-prime", reason: "joined-source-refresh", ok: ordinaryProofSource !== undefined});
								if (ordinaryProofSource !== undefined) {
									quote = await prepareCreatorIncrementalIssuanceMaintenanceQuote(registration, input, unsignedBytes, ordinaryProofSource, receivedReceipt,
										() => { ordinaryProofSource = undefined; ordinaryTemplateReady = false; }, suffix);
								}
							}
							report({kind: quote === undefined ? "ordinary-incremental-fallback" : "ordinary-incremental-hit",
								received: receivedReceipt !== undefined});
						}
					}
					if (quote === undefined && suffix !== undefined)
						throw new TypeError("creator whole-suffix finishing capacity requires explicit boundary maintenance before the first join");
					if (quote === undefined && ordinaryDomain && newWindowAdmission)
						throw new TypeError("creator ordinary finishing window requires explicit boundary maintenance before admission");
					if (quote === undefined && ordinaryDomain && ordinaryTemplateReady && ordinaryProofSource !== undefined) {
						const warm = await prepareCreatorOrdinaryIssuanceMaintenanceQuote(registration, input, unsignedBytes, ordinaryProofSource, receivedReceipt);
						if (warm !== undefined) {
							quote = warm;
							if (await chargeCreatorOrdinaryIssuanceMaintenanceQuote(warm, unsignedBytes))
								report({kind: "ordinary-finishing-warm-hit", received: receivedReceipt !== undefined});
							else {
								await warm.proof.release(); quote = undefined;
								report({kind: "ordinary-finishing-warm-fallback", reason: "template-or-original-book-fit"});
							}
						} else report({kind: "ordinary-finishing-warm-fallback", reason: "source-currency-or-supported-shape"});
					}
					if (quote === undefined) {
						const cold = await prepareCreatorIssuanceMaintenanceQuote(registration, input, unsignedBytes, planEffect, receivedReceipt);
						quote = cold;
						await cooperate();
						// The required fence already owns a complete authenticated cold
						// source before its UNKNOWN forecast is charged. Retain only the
						// same owner's bounded immutable DATA, bound to this exact native
						// candidate. It supplies no paid credit or post-write authority:
						// explicit readiness still owes a NEW complete ordinary proof of
						// the actual signed fence and exact atomic settlement postimage.
						const fenceSource = planEffect?.kind === "fence" && receivedReceipt === undefined &&
							input.archive === undefined && input.readOrdinaryApplicationResourceBound !== undefined
							? await captureCreatorOrdinaryIssuanceProofSourceForFence(cold.proof, unsignedBytes) : undefined;
						await cooperate();
						// A missing LOCAL/RECEIVED program compiles into the SAME
						// immutable source cell; it never swaps in a new paid source.
						let capture = ordinaryDomain ? ordinaryProofSource : undefined;
						if (ordinaryDomain && cold.ordinaryFinishingCapacityDimensions !== undefined && ordinaryProofSource === undefined) {
							capture = await captureCreatorOrdinaryIssuanceProofSource(cold.proof);
							report({kind: "ordinary-finishing-source-capture", ok: capture !== undefined});
						}
						const compiled = await chargeCreatorIssuanceMaintenanceQuote(cold, unsignedBytes, planEffect, capture);
						await cooperate();
						if (fenceSource !== undefined) {
							ordinaryProofSource = fenceSource; ordinaryTemplateReady = false;
							report({kind: "ordinary-fence-source-hint", retained: true});
						}
						if (capture !== undefined) {
							if (compiled) {ordinaryProofSource = capture; ordinaryTemplateReady = true;}
							report({kind: "ordinary-finishing-template-compile", ok: compiled});
						}
					}
					if ("archiveCapacity" in quote && quote.archiveCapacity !== undefined) {
						const archive = quote.archiveCapacity;
						await archive.check();
						const promise = await archive.store.reserveCapacity(archive.declaration);
						if (!archiveCapacityPromiseCovers(promise,archive.declaration) ||
							!quote.proof.accounting.charge(encodeCanonical(promise))) throw new TypeError("archive admission exact promise/readback is unavailable");
						await archive.check();
					}
					if (stopping) throw new TypeError("creator issuance maintenance admission was revoked");
					const proof = quote.proof;
					const accepted = captureCreatorOrdinaryAcceptedResourceUpdateForSizing(quote.proof, unsignedBytes);
					let releaseTask: Promise<void> | undefined;
					return Object.freeze({
						context: quote.context,
						...("readJournalContext" in proof ? {journalContext: proof.readJournalContext()} : {}),
						...(accepted === undefined ? {} : {accepted}),
						beginWrite: async (): Promise<void> => {
							if (stopping || releaseTask !== undefined)
								throw new TypeError("creator issuance maintenance admission was revoked");
							if (receivedReceipt === undefined) await proof.beginWrite();
							else await proof.beginReceivedAppend(unsignedBytes);
							if (stopping) throw new TypeError("creator issuance maintenance admission was revoked");
						},
						endWrite: (): Promise<void> => proof.endWrite(),
						release: (): Promise<void> => {
							if (releaseTask !== undefined) return releaseTask;
							releaseTask = Promise.resolve()
								.then(() => proof.release())
								.catch((error) => {
									maintenanceReleaseFailure = error;
									throw error;
								})
								.finally(finishJoined);
							return releaseTask;
						},
					});
				} catch (primary) {
					// Original source acquisition wraps a failed joined cleanup with
					// its primary error. Never treat that uncertain release as a
					// capacity refusal that permits a fresh close capture.
					if (primary instanceof AggregateError) maintenanceReleaseFailure = primary;
					try {
						await quote?.proof.release();
					} catch (cleanup) {
						maintenanceReleaseFailure = cleanup;
						throw new AggregateError([primary, cleanup], "creator issuance admission release failed", {
							cause: primary,
						});
					} finally {
						finishJoined();
					}
					throw primary;
				}
			});
		};
		const releaseDependencies = (): Promise<void> => {
			if (dependencyReleaseTask !== undefined) return dependencyReleaseTask;
			ordinaryProofSource = undefined; ordinaryTemplateReady = false;
			dependencyReleaseTask = (async (): Promise<void> => {
				const outcomes = await Promise.allSettled([
					Promise.resolve().then(() => promotionSource?.release()),
					Promise.resolve().then(() => recoverySource?.release()),
				]);
				const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1) throw new AggregateError(failures, "creator close dependency release failed");
				promotionSource = undefined;
				promotionSourceIdentity = undefined;
				recoverySource = undefined;
				dependenciesReleased = true;
				retiredSourceGenerations = Object.freeze([]);
			})();
			return dependencyReleaseTask;
		};
		const acquireSource = async (
			closedEpoch: number,
			purpose: "promotion" | "recovery role transfer"
		): Promise<CreatorForwardPromotionSourceMaterial> => {
			if (input.promotionContext === undefined) throw new TypeError(`creator ${purpose} authority is unavailable`);
			const acquired = await acquireCreatorForwardPromotionSource(
				{
					...input.promotionContext,
					objectId: registration.objectId,
					store: registration.store,
					snapshotStore: input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"],
					liveJournalStore: registration.liveJournalStore,
				},
				closedEpoch
			);
			if (!acquired.ok) throw new TypeError(`creator ${purpose} source failed: ${JSON.stringify(acquired)}`);
			const source = resolveCreatorForwardPromotionSource(
				acquired.observation,
				registration.store,
				input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"]
			);
			if (source === undefined) throw new TypeError(`creator ${purpose} custody is unavailable`);
			return source;
		};
		const acquireRecoverySource = async (): Promise<CreatorForwardPromotionSourceMaterial> => {
			return recoverySource = await acquireSource(epoch - 1, "recovery role transfer");
		};
		const sourceIdentity = (source: CreatorForwardPromotionSourceMaterial): Uint8Array => encodeCanonical({
			sources: source.sources, historicalSnapshots: source.historicalSnapshots,
			currentAclBytes: source.currentAclBytes, expectedRoomHead: source.expectedRoomHead,
			pinnedTrustBytes: source.exactCanonicalPinnedGenesisTrustStateRecordBytes,
			currentTrust: {objectId: source.currentTrust.objectId,
				genesisAnchorDigest: source.currentTrust.genesisAnchorDigest, profileId: source.currentTrust.profileId,
				currentEpoch: source.currentTrust.currentEpoch, currentAnchorDigest: source.currentTrust.currentAnchorDigest},
		});
		const acquirePromotionSource = async (closedEpoch: number): Promise<CreatorForwardPromotionSourceMaterial> => {
			const source = await acquireSource(closedEpoch, "promotion");
			try {
				// Equality witnesses only: the new original source independently
				// authenticates every role and its current native census.
				const identity = sourceIdentity(source);
				if (promotionSourceIdentity !== undefined && compareBytes(promotionSourceIdentity, identity) !== 0)
					throw new TypeError("creator promotion identity changed during retirement source reacquisition");
				await source.checkCurrent();
				promotionSourceIdentity ??= identity;
				promotionSource = source;
				return source;
			} catch (error) {
				try {
					await source.release();
				} catch (releaseError) {
					throw new AggregateError([error, releaseError], "creator promotion source and release failed", { cause: error });
				}
				throw error;
			}
		};
		const captureSourceStageCensus = async (): Promise<ReadonlyMap<GenerationId, Uint8Array>> => {
			const page = await registration.store.readGenerationPage({ objectId: registration.objectId, limit: 8 });
			if (!page.ok || page.value.nextCursor !== null || page.value.generations.length > 7)
				throw new TypeError("creator source stage census exceeded bounded native roles");
			const rows = new Map(page.value.generations.map((row) => [row.generationId, encodeCanonical(row)]));
			if (rows.size !== page.value.generations.length)
				throw new TypeError("creator source stage census repeats a generation");
			return rows;
		};
		const trust = Object.freeze({
			byzantineFaultTolerant: false as const,
			kind: "creator-certified" as const,
			quorum: 1 as const,
			signerCount: 1 as const,
			text: "Creator-certified; one of one; not Byzantine-fault-tolerant." as const,
		});
		const close = (): Promise<CreatorLiveCloseResult> => {
			if (
				stopping ||
				maintenanceReleaseFailure !== undefined ||
				dependencyReleaseTask !== undefined ||
				acquisitionTask !== undefined ||
				closeTask !== undefined ||
				lifecycle === "successor-pending-adoption" ||
				lifecycle === "successor-adopted" ||
				actor.status().terminal
			) {
				return Promise.reject(new TypeError("creator close authority is unavailable"));
			}
			const finishRetainedReplayClose = registration.beginRetainedReplayClose();
			maintenanceClosing = true;
			ordinaryProofSource = undefined; ordinaryTemplateReady = false;
			closeTask = (async (): Promise<CreatorLiveCloseResult> => {
				await Promise.all([...maintenanceJobs]);
				if (maintenanceReleaseFailure !== undefined) throw maintenanceReleaseFailure;
				// Stage before any promotion or recovery source. A source holds the live
				// journal's native read reservation, which excludes every journal writer;
				// the stage closes admission and then waits for the plane's admitted tasks,
				// and an admitted ingress task still appends to that journal. Staged first,
				// those tasks finish before a source exists, and later ingress meets the
				// closed gate. The stage folds the in-memory graph and reads no durable
				// state, so every source below authenticates the same closed facts.
				if (stagedSnapshot === undefined) {
					const snapshot = await registration.stageSnapshot();
					if (!snapshot.ok) {
						registration.abortSnapshotStage();
						throw new TypeError(`creator snapshot export failed: ${snapshot.kind}: ${snapshot.detail}`);
					}
					stagedSnapshot = snapshot;
				}
				lifecycle = "sealed";
				// Admission is closed and admitted work has joined. The same close
				// keeps ownership while ordinary timers and ephemeral transport run.
				await yieldToHost();
				if (stopping) throw new TypeError("creator close authority is unavailable");
				if (retirementReconciliationPending && promotionSource !== undefined) {
					// The prior failed close has joined its maintenance finally blocks.
					// Its point census may reflect OLD while durable work reached NEW.
					await promotionSource.release();
					promotionSource = undefined;
				}
				if (promotionSource === undefined && promotedEpoch !== undefined) await acquirePromotionSource(promotedEpoch);
				await promotionSource?.checkCurrent();
				const priorCutCandidate = boundHead.candidates.find(({ bytes }) => {
					const value = decodeCanonical(bytes);
					return plainRecord(value) && value.kind === "drp-hard-epoch-cut" && value.epoch === epoch - 1;
				});
				const priorCutRecord =
					priorCutCandidate === undefined
						? undefined
						: (decodeCanonical(priorCutCandidate.bytes) as Record<string, unknown>);
				if (
					promotionSource === undefined &&
					recoverySource === undefined &&
					epoch >= 2 &&
					(priorCutRecord?.forwardPromotion !== undefined || (epoch === 2 && input.promotionContext !== undefined))
				)
					await acquireRecoverySource();
				capturedGraph ??= registration.captureCloseGraph();
				if (capturedGraph === undefined) throw new TypeError("creator close graph capture failed");
				let snapshot = stagedSnapshot;
				const graph = capturedGraph;
				const payload = decodeCanonical(snapshot.exactCanonicalPayloadBytes);
				const anchor = decodeCanonical(registration.exactCanonicalAnchorPreimageBytes);
				if (!plainRecord(payload) || !plainRecord(anchor))
					throw new TypeError("creator close snapshot identity failed");
				const acl = payload.acl;
				const stateDigest = snapshot.applicationStateDigest;
				let archiveIndexRoot = anchor.archiveIndexRoot;
				if (
					acl === undefined ||
					typeof stateDigest !== "string" ||
					typeof archiveIndexRoot !== "string" ||
					typeof anchor.aclDigest !== "string"
				) {
					throw new TypeError("creator close snapshot identity failed");
				}
				const aclDigest = hex(hashDomain("ts-drp/latched-acl/v3", encodeCanonical(acl)));
				if (persistedSnapshot === undefined && input.promotionContext !== undefined) {
					const owner = await input.snapshotStore.recoveryStatus();
					const native = registration.store as AheBoundedRecoveryRoleStore;
					const observedIntent =
						native.readRetirementControl === undefined
							? undefined
							: await native.readRetirementControl(registration.objectId);
					if (observedIntent !== undefined && !observedIntent.ok)
						throw new TypeError("creator close retirement intent is unavailable", { cause: observedIntent });
					const intent = observedIntent?.ok === true ? observedIntent.value : null;
					const capacity = await native.readGenerationPage({
						objectId: registration.objectId,
						limit: AHE_BOUNDED_READ_LIMITS.maxObjectGenerations,
					});
					if (!capacity.ok)
						throw new TypeError("creator close generation capacity is unavailable", { cause: capacity });
					const capacityMaintenance =
						capacity.value.generations.length > AHE_BOUNDED_READ_LIMITS.maxObjectGenerations - 2;
					// This requests original authenticated reconstruction; neither an
					// epoch nor a completed label grants resume authority. The proof
					// owner must match the entire source and durable participant map.
					// A completed control byte-equal to this epoch's early turnover was
					// already consumed at its explicit boundary; anything else resumes.
					const resume = creatorCloseRetirementResumeRequired({
						reconciliationPending: retirementReconciliationPending,
						reconstructionPresent: registration.retirementReconstruction !== undefined,
						intent,
						currentEpoch: registration.currentTrust.currentEpoch,
						...(earlyTurnover === undefined ? {} : {earlyTurnover}),
					});
					if (owner.recoveryScopes >= owner.limits.maxRecoveryScopes || resume || capacityMaintenance) {
						// Keep this SAME close's unfinished request across lost delivery.
						// Turnover can reduce the pool before an intent exists; retries
						// must still reacquire the original whole authenticated proof.
						retirementReconciliationPending = true;
						// Join this producer's readers before the native role transaction.
						// The surviving union is authenticated afresh below, never inferred
						// from detached bytes held across a retirement boundary.
						if (recoverySource !== undefined) {
							await recoverySource.release();
							recoverySource = undefined;
						}
						// Release only this source's classified readers. Selected and
						// retained historical snapshots stay held throughout maintenance.
						await promotionSource?.releaseClassifiedDependencies();
						await reconcileCreatorBoundedRecoveryMaintenance(registration, input, actor, capacity.value.generations.length,
							() => registration.sealRecoveryDependencies(priorCutRecord?.recoveryRoles !== undefined),
							false, false, registration.currentTrust);
						if (promotionSource !== undefined) {
							if (promotedEpoch === undefined) throw new TypeError("creator promotion target is unavailable");
							await promotionSource.release();
							promotionSource = undefined;
							// Every maintenance pass has joined. Replace the old whole-pool
							// currency view, never relax it after an owned generation drain.
							await acquirePromotionSource(promotedEpoch);
						}
						retirementReconciliationPending = false;
					}
				}
				// A classified snapshot must not remain held by this producer across
				// native retirement. Reacquire the whole authenticated surviving roles
				// after the reconciliation/readback boundary, before new dependence.
				if (
					promotionSource === undefined &&
					recoverySource === undefined &&
					epoch >= 2 &&
					(priorCutRecord?.recoveryRoles !== undefined || priorCutRecord?.forwardPromotion !== undefined)
				)
					await acquireRecoverySource();
				if (archive !== undefined && archivePreparation === undefined) {
					if (input.promotionContext === undefined) throw new TypeError("archive close original source owner is unavailable");
					// The promotion/recovery proof owns journal native exclusion too.
					// As at membership persistence, carry equality witnesses only across
					// this boundary, join old readers, then independently authenticate
					// the exact same sources after archive preparation joins its views.
					const promotionBeforeArchive = promotionSource === undefined ? undefined : sourceIdentity(promotionSource);
					const recoveryBeforeArchive = recoverySource === undefined ? undefined : sourceIdentity(recoverySource);
					const archiveSources = [promotionSource, recoverySource];
					promotionSource = undefined; recoverySource = undefined;
					const archiveJoins = await Promise.allSettled(archiveSources.map(source => source?.release()));
					const archiveJoinFailures = archiveJoins.flatMap(result => result.status === "rejected" ? [result.reason] : []);
					if (archiveJoinFailures.length) throw new AggregateError(archiveJoinFailures, "creator archive source readers failed to join");
					derivedCommitment ??= await deriveCloseSetHistoryCommitment({ authenticatedCanonicalPreimageByteLengths: graph.charges,
						exactCanonicalEpochAnchorPreimageBytes: registration.exactCanonicalAnchorPreimageBytes, frontier: graph.frontier,
						maxEpochBytes: registration.maxEpochBytes, maxEpochVertices: registration.maxEpochVertices,
						previousHistorySnapshot: registration.previousHistorySnapshot, vertices: graph.vertices });
					const closeHold = await registration.sealRecoveryDependencies(true);
					if (closeHold === undefined) throw new TypeError("archive close genuine source hold is unavailable");
					const lifetime = resolveCreatorSnapshotRecoveryCloseHold(closeHold, { store: registration.store,
						liveJournalStore: registration.liveJournalStore, currentTrust: registration.currentTrust });
					if (lifetime === undefined) throw new TypeError("archive close genuine lifetime is unavailable");
					let proof: Awaited<ReturnType<typeof acquireCreatorIssuanceMaintenanceProof>> | undefined;
					let primary: unknown;
					let failed = false;
					try {
						proof = await acquireCreatorIssuanceMaintenanceProof({ ...input.promotionContext, objectId: registration.objectId,
							store: registration.store, snapshotStore: input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"],
							liveJournalStore: registration.liveJournalStore }, closeHold, registration.currentTrust, false, false, "archive-close");
						archiveAccounting = proof.accounting;
						const sourceFloorBytes = encodeCanonical(proof.floor);
						const authority = input.promotionContext.roomHeadAuthority;
						const sourceAccounting = proof.accounting;
						const floorScope = Object.freeze({ objectId: registration.objectId,
							pinnedGenesisAnchorDigest: input.promotionContext.pinnedGenesisAnchorDigest });
						checkArchiveSourceCurrency = async (): Promise<void> => {
							const fresh = captureCreatorRoomHeadState(await authority.read({ scope: floorScope }),
								floorScope.objectId, floorScope.pinnedGenesisAnchorDigest);
							if (!fresh.ok || compareBytes(encodeCanonical(fresh.state), sourceFloorBytes) !== 0 ||
								!sourceAccounting.charge(encodeCanonical(fresh)))
								throw new TypeError("archive original whole provider floor changed or exhausted its full charge");
						};
						const preparedArchive = await prepareCreatorClosedArchiveAppend({ registration, hold: closeHold,
							archiveStore: archive.store, limits: archive.limits, commitment: derivedCommitment, accounting: archiveAccounting });
						const targetBytes = captureCreatorArchiveSnapshotTarget({ exactCanonicalPayloadBytes: snapshot.exactCanonicalPayloadBytes,
							applicationStateDigest: snapshot.applicationStateDigest, binding: preparedArchive.binding, accounting: archiveAccounting });
						snapshot = stagedSnapshot = Object.freeze({ ...snapshot, exactCanonicalPayloadBytes: targetBytes });
						archivePreparation = preparedArchive;
					} catch (cause) { failed = true; primary = cause; }
					const errors: unknown[] = [];
					// Archive close is genuine joined maintenance, not an adoption fence or terminal
					// withdrawal. Its explicit existing-owner purpose selects the unchanged maintenance
					// cap; ordinary CURRENT/FUTURE capacity reservation is still required before deployment.
					// Release invalidates the proof's nominal frame and joins all read reservations.
					// The retained ledger preserves charges only; later Cut/QC/source/native checks are
					// fresh authority. Holding this reservation across AHE writes would self-deadlock.
					try { await proof?.release(); } catch (cause) { errors.push(cause); }
					try { await lifetime.release(); } catch (cause) { errors.push(cause); }
					if (failed) errors.unshift(primary);
					if (errors.length) throw new AggregateError(errors, "archive close preparation and source join failed", { cause: errors[0] });
					if (promotionBeforeArchive !== undefined) {
						if (promotedEpoch === undefined) throw new TypeError("creator archive promotion target unavailable");
						promotionSource = await acquirePromotionSource(promotedEpoch);
						if (compareBytes(sourceIdentity(promotionSource), promotionBeforeArchive) !== 0)
							throw new TypeError("creator archive promotion source changed");
					}
					if (recoveryBeforeArchive !== undefined) {
						recoverySource = await acquireRecoverySource();
						if (compareBytes(sourceIdentity(recoverySource), recoveryBeforeArchive) !== 0)
							throw new TypeError("creator archive recovery source changed");
						await recoverySource.checkCurrent();
					}
					await promotionSource?.checkCurrent();
				}
				if (archivePreparation !== undefined) archiveIndexRoot = archivePreparation.binding.targetArchiveIndexRoot;
				persistedSnapshot ??= await persistSnapshot(input.snapshotStore, {
					aclDigest,
					anchor: registration.currentTrust.currentAnchorDigest,
					epoch: registration.currentTrust.currentEpoch,
					exactCanonicalPayloadBytes: snapshot.exactCanonicalPayloadBytes,
					objectId: registration.objectId,
					stateDigest,
				});
				derivedCommitment ??= await deriveCloseSetHistoryCommitment({
					authenticatedCanonicalPreimageByteLengths: graph.charges,
					exactCanonicalEpochAnchorPreimageBytes: registration.exactCanonicalAnchorPreimageBytes,
					frontier: graph.frontier,
					maxEpochBytes: registration.maxEpochBytes,
					maxEpochVertices: registration.maxEpochVertices,
					previousHistorySnapshot: registration.previousHistorySnapshot,
					vertices: graph.vertices,
				});
				const commitment = derivedCommitment;
				durableReplay ??= await registration.sealDurableReplay();
				if (durableReplay === undefined) throw new TypeError("creator close durable replay seal failed");
				const current = await inspectHead(registration.store, registration.objectId);
				const currentTrustCandidate = current.candidates.find(({ ref }) => sameRef(ref, current.trustRef));
				if (currentTrustCandidate === undefined) throw new TypeError("creator current trust bytes are unavailable");
				const decodedTrust = verifiedCreatorTrustRecord(registration, currentTrustCandidate.bytes);
				if (decodedTrust === undefined || !(decodedTrust.exactCanonicalSignerSetBytes instanceof Uint8Array)) {
					throw new TypeError("creator signer set is unavailable");
				}
				const settlement = settlementProfileFor(registration.currentTrust.profileId) === "v1";
				const retirementDerivation = settlement
					? undefined
					: await deriveIssuanceRetirement({
							current,
							currentTrust: registration.currentTrust,
							durableReplay,
							graph,
							issuanceScope: registration.issuanceScope,
							issuanceStore: registration.issuanceStore,
							maxEpochVertices: registration.maxEpochVertices,
						});
				const frontierDerivationInput = {
					current,
					currentAclDigest: anchor.aclDigest,
					currentExactAclBytes: registration.exactCanonicalLatchedAclBytes,
					currentTrust: registration.currentTrust,
					graph,
					issuanceScope: registration.issuanceScope,
					issuanceStore: registration.issuanceStore,
					successorAclDigest: aclDigest,
					successorExactAclBytes: encodeCanonical(acl),
				};
				const settlementDerivation = settlement
					? deriveAuthorSettlement({
							...frontierDerivationInput,
							historyRoot: commitment.historyRoot,
							historySize: commitment.historySize,
						})
					: undefined;
				const aggregateDerivation =
					retirementDerivation === undefined
						? undefined
						: await deriveAuthorIssuanceFrontiers({ ...frontierDerivationInput, legacy: retirementDerivation });
				let forwardPromotion: ForwardPromotion | undefined;
				if (promotionSource !== undefined) {
					const selected = promotionSource.sources.find((source) => source.closedEpoch === promotedEpoch);
					const latest = promotionSource.sources[0];
					if (
						selected === undefined ||
						latest === undefined ||
						promotionSource.currentTrust.currentAnchorDigest !== registration.currentTrust.currentAnchorDigest
					)
						throw new TypeError("creator promotion source is unavailable");
					forwardPromotion = Object.freeze({
						kind: "forward-historical-promotion",
						version: 1,
						genesisAnchorDigest: registration.currentTrust.genesisAnchorDigest,
						source: selected,
						authorizedSuccessorAclDigest: aclDigest,
						roles: Object.freeze({
							selectedSourceCutDigest: selected.cutValueDigest,
							retainedSources: Object.freeze(promotionSource.sources.filter((source) => source !== selected)),
							currentControlRefs: latest.checkpointRefs,
							frontiers: settlementDerivation?.frontiers ?? aggregateDerivation?.frontiers ?? null,
						}),
					});
				}
				let recoveryRoles: CreatorSnapshotRecoveryRoles | undefined;
				let certifiedRecoverySourceGenerations: CreatorAdoptionFacts["certifiedRecoverySourceGenerations"];
				let classifiedRecoverySourceGenerations: CreatorAdoptionFacts["classifiedRecoverySourceGenerations"];
				if (recoverySource !== undefined)
					recoveryRoles = await deriveCreatorCloseRecoveryRoles(
						registration,
						recoverySource,
						input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"],
						persistedSnapshot.manifestDigest,
						input.promotionContext !== undefined
					);
				const closeInput = Object.freeze({
					aclDigest,
					archiveIndexRoot,
					...(archivePreparation === undefined ? {} : { archiveAppend: archivePreparation.binding }),
					blueprintDigest: anchor.blueprintDigest,
					closeReason: "creator-requested",
					closeSetCount: commitment.closeSetCount,
					closeSetRoot: commitment.closeSetRoot,
					currentTrust: registration.currentTrust,
					exactCanonicalAvailabilityPolicyBytes: Uint8Array.from(input.exactCanonicalAvailabilityPolicyBytes),
					exactCanonicalNextSignerSetBytes: Uint8Array.from(decodedTrust.exactCanonicalSignerSetBytes),
					exactCanonicalParametersBytes: Uint8Array.from(registration.exactCanonicalParametersBytes),
					exactCanonicalSnapshotManifestBytes: persistedSnapshot.exactCanonicalManifestBytes,
					historyRoot: commitment.historyRoot,
					historySize: commitment.historySize,
					snapshotManifestDigest: persistedSnapshot.manifestDigest,
					stateDigest,
					...(forwardPromotion === undefined ? {} : { forwardPromotion }),
					...(recoveryRoles === undefined ? {} : { recoveryRoles }),
				});
				const prepared =
					forwardPromotion === undefined ? prepareCreatorClose(closeInput) : prepareCreatorForwardPromotion(closeInput);
				if (!prepared.ok) throw new TypeError(`creator close preparation failed: ${prepared.reason}`);
				// Capture original local preimages before adoption can prune issuance.
				// Persist opaque lifecycle evidence before irreversible actor signing;
				// it grants no authority without the independently authenticated Cut/QC.
				const localVertexWitnesses = await registration.captureClosedMembershipLocalWitnesses();
				if (localVertexWitnesses === undefined) throw new TypeError("creator close original local witnesses unavailable");
				const membershipBytes = await encodeCreatorCloseMembership({
					exactCanonicalCutValueBytes: prepared.exactCanonicalCutValueBytes,
					exactCanonicalLatchedAclBytes: registration.exactCanonicalLatchedAclBytes,
					commitment, maxEpochVertices: registration.maxEpochVertices, localVertexWitnesses,
				});
				const journal = registration.liveJournalStore;
				if (journal.readRetirementImage === undefined || journal.recordClosedMembership === undefined)
					throw new TypeError("creator close native membership port unavailable");
				// No authority survives the write boundary. Preserve comparison bytes
				// only, join every admitted source reader/import, then authenticate the
				// exact same source/Cut again after native membership readback.
				const promotionBeforeMembership = promotionSource === undefined ? undefined : sourceIdentity(promotionSource);
				const recoveryBeforeMembership = recoverySource === undefined ? undefined : sourceIdentity(recoverySource);
				const membershipSources = [promotionSource, recoverySource];
				promotionSource = undefined; recoverySource = undefined;
				const membershipJoins = await Promise.allSettled(membershipSources.map(source => source?.release()));
				const membershipJoinFailures = membershipJoins.flatMap(result => result.status === "rejected" ? [result.reason] : []);
				if (membershipJoinFailures.length) throw new AggregateError(membershipJoinFailures, "creator membership source readers failed to join");
				// All previous native readers joined. Fresh membership/source reads
				// below re-establish currency after this scheduling boundary.
				await yieldToHost();
				if (stopping) throw new TypeError("creator close authority is unavailable");
				const beforeMembership = await journal.readRetirementImage({ objectId: registration.objectId });
				if (!beforeMembership.ok) throw new TypeError("creator close native membership image unavailable", { cause: beforeMembership });
				const recordedMembership = await journal.recordClosedMembership({
					scope: { objectId: registration.objectId, epoch, anchorDigest: registration.currentTrust.currentAnchorDigest },
					exactCanonicalMembershipBytes: membershipBytes,
					expectedNativeImage: { imageDigest: beforeMembership.value.image.imageDigest,
						controlBytes: beforeMembership.value.control === null ? null : encodeJournalRetirementControl(beforeMembership.value.control) },
				});
				if (!recordedMembership.ok) throw new TypeError("creator close native membership persistence refused", { cause: recordedMembership });
				// The membership write has joined and no source reader is held yet.
				// The replay and source reads below re-establish currency afresh.
				await yieldToHost();
				if (stopping) throw new TypeError("creator close authority is unavailable");
				if (!(await durableReplay.verify())) throw new TypeError("creator close replay changed during membership persistence");
				if (promotionBeforeMembership !== undefined) {
					if (promotedEpoch === undefined) throw new TypeError("creator membership promotion target unavailable");
					promotionSource = await acquirePromotionSource(promotedEpoch);
					if (promotionSource === undefined || compareBytes(sourceIdentity(promotionSource), promotionBeforeMembership) !== 0)
						throw new TypeError("creator membership promotion source changed");
				}
				if (recoveryBeforeMembership !== undefined) {
					recoverySource = await acquireRecoverySource();
					if (recoverySource === undefined || compareBytes(sourceIdentity(recoverySource), recoveryBeforeMembership) !== 0)
						throw new TypeError("creator membership recovery source changed");
				}
				// The reacquired sources keep their native exclusion across this
				// boundary. Their currency is checked after it, before signing.
				await yieldToHost();
				if (stopping) throw new TypeError("creator close authority is unavailable");
				await recoverySource?.checkCurrent();
				await promotionSource?.checkCurrent();
				const finalized = await actor.close({ closeInput });
				if (
					finalized.ok !== true ||
					!(finalized.exactCanonicalCommitQcBytes instanceof Uint8Array) ||
					!(finalized.exactCanonicalTrustStateRecordBytes instanceof Uint8Array)
				)
					throw new TypeError(`creator close actor failed: ${String(finalized.reason)}`);
				const successor = (
					forwardPromotion === undefined ? openCreatorSuccessorTrust : openCreatorForwardPromotionSuccessorTrust
				)({
					currentTrust: registration.currentTrust,
					exactCanonicalCommitQcBytes: finalized.exactCanonicalCommitQcBytes,
					exactCanonicalCutValueBytes: prepared.exactCanonicalCutValueBytes,
					exactCanonicalTrustStateRecordBytes: finalized.exactCanonicalTrustStateRecordBytes,
				});
				if (!successor.ok) throw new TypeError(`creator successor reopen failed: ${successor.reason}`);
				if (
					successor.trust.currentEpoch !== successorEpoch ||
					successor.trust.objectId !== registration.currentTrust.objectId ||
					successor.trust.genesisAnchorDigest !== registration.currentTrust.genesisAnchorDigest
				) {
					throw new TypeError("creator successor epoch identity failed");
				}
				// The QC is final, so this close owns completion: stop joins it rather
				// than abandoning a signed cut. Every later effect rechecks its sources
				// or is a compare-and-set on the head read above.
				await yieldToHost();
				// Reuse the authenticated current creator/QC owner. Records govern
				// this closing epoch, not the newly minted successor epoch.
				const signingContext = captureCreatorIssuanceRetirementSigningContext({
					currentTrust: registration.currentTrust,
					exactCanonicalCommitQcBytes: finalized.exactCanonicalCommitQcBytes,
					valueDigest: prepared.valueDigest,
				});
				const retirementSigning: CreatorRetirementSigningCustody = {
					scope: signingContext.scope,
					admission: nativeSigningAdmissionFactory(
						input.voteStore,
						mintSealVoterEnrollment({ ...signingContext.identity, expectedIncarnation: input.storageIncarnation })
					),
				};
				const successorTrustRef = refFor(finalized.exactCanonicalTrustStateRecordBytes);
				const cutValueRef = refFor(prepared.exactCanonicalCutValueBytes);
				const commitQcRef = refFor(finalized.exactCanonicalCommitQcBytes);
				const retirement = settlement
					? undefined
					: await issuanceRetirementCandidate(
							{
								current,
								currentTrust: registration.currentTrust,
								cutValueDigest: prepared.valueDigest,
								durableReplay,
								graph,
								issuanceScope: registration.issuanceScope,
								issuanceStore: registration.issuanceStore,
								maxEpochVertices: registration.maxEpochVertices,
								qcRef: commitQcRef,
								signer: input.signer,
								snapshotManifestDigest: persistedSnapshot.manifestDigest,
								successorTrust: successor.trust,
							},
							retirementSigning,
							retirementDerivation
						);
				const frontierInput = {
					current,
					currentAclDigest: anchor.aclDigest,
					currentExactAclBytes: registration.exactCanonicalLatchedAclBytes,
					currentTrust: registration.currentTrust,
					cutValueDigest: prepared.valueDigest,
					graph,
					issuanceScope: registration.issuanceScope,
					issuanceStore: registration.issuanceStore,
					qcRef: commitQcRef,
					signer: input.signer,
					snapshotManifestDigest: persistedSnapshot.manifestDigest,
					successorAclDigest: aclDigest,
					successorExactAclBytes: encodeCanonical(acl),
					successorTrust: successor.trust,
				};
				const aggregate =
					retirement === undefined
						? await authorSettlementCandidate(
								{
									...frontierInput,
									historyRoot: commitment.historyRoot,
									historySize: commitment.historySize,
								},
								retirementSigning,
								settlementDerivation
							)
						: await authorIssuanceFrontiersCandidate(
								{ ...frontierInput, legacy: retirement },
								retirementSigning,
								aggregateDerivation
							);
				const historyBytes = encodeCreatorCloseHistory(prepared.valueDigest, commitment.historySnapshot);
				const historyCandidate = { bytes: historyBytes, ref: refFor(historyBytes) };
				const controls = retirement === undefined ? [aggregate] : [retirement, aggregate];
				const proposed = Object.freeze(
					[
						...current.references.filter(
							({ digest }) =>
								digest !== current.trustRef.digest && !controls.some((control) => digest === control.priorRef?.digest)
						),
						successorTrustRef,
						cutValueRef,
						commitQcRef,
						historyCandidate.ref,
						...controls.map(({ ref }) => ref),
					].sort(compareRef)
				);
				const proposedCandidates = creatorCloseCandidates([
					...current.candidates.filter(
						({ ref }) =>
							ref.digest !== current.trustRef.digest &&
							!controls.some((control) => ref.digest === control.priorRef?.digest)
					),
					{ bytes: finalized.exactCanonicalTrustStateRecordBytes, ref: successorTrustRef },
					{ bytes: prepared.exactCanonicalCutValueBytes, ref: cutValueRef },
					{ bytes: finalized.exactCanonicalCommitQcBytes, ref: commitQcRef },
					historyCandidate,
					...controls.map(({ bytes, ref }) => ({ bytes, ref })),
				]);
				const advance = inspectCreatorTransitionAdvance({
					current: { candidates: current.candidates, closure: current.references },
					currentTrust: registration.currentTrust,
					mode: "stage",
					...(settlement
						? {
								settlementAcl: {
									current: registration.exactCanonicalLatchedAclBytes,
									successor: encodeCanonical(acl),
								},
							}
						: {}),
					proofRefs: [cutValueRef, commitQcRef],
					proposed: { candidates: proposedCandidates, closure: proposed },
					successorTrust: successor.trust,
				});
				if (!advance.ok) throw new TypeError(`creator trust advance failed: ${advance.reason}`);
				// Role and promotion certification below check each held source's
				// currency after this boundary and before the generation stage.
				await yieldToHost();
				if (recoverySource !== undefined) {
					const transferred = openCreatorSnapshotRecoveryRoleTransfer({
						currentTrust: registration.currentTrust,
						successorTrust: successor.trust,
						current: recoverySource.current,
						predecessor: recoverySource.predecessor,
						proposed: advance.proposed,
						currentAclBytes: registration.exactCanonicalLatchedAclBytes,
						currentCloseSnapshot: {
							exactCanonicalManifestBytes: persistedSnapshot.exactCanonicalManifestBytes,
							exactCanonicalPayloadBytes: snapshot.exactCanonicalPayloadBytes,
						},
						historicalSnapshots: recoverySource.historicalSnapshots,
						currentInstalledPromotion: recoverySource.installedPromotion,
						proposedPromotion: null,
						...(recoverySource.recoveryRoleTransfer === null
							? {}
							: { currentRoleTransfer: recoverySource.recoveryRoleTransfer }),
						exactCanonicalPinnedGenesisTrustStateRecordBytes:
							recoverySource.exactCanonicalPinnedGenesisTrustStateRecordBytes,
					});
					if (!transferred.ok)
						throw new TypeError(`creator recovery role transfer certification failed: ${transferred.reason}`);
					{
						const priorRoles =
							recoverySource.recoveryRoleTransfer === null
								? undefined
								: resolveCreatorSnapshotRecoveryRoleTransfer(recoverySource.recoveryRoleTransfer);
						if (
							(recoverySource.recoveryRoleTransfer !== null && priorRoles === undefined) ||
							recoveryRoles === undefined ||
							recoverySource.authenticatedRecoverySourceGenerations === null
						)
							throw new TypeError("creator recovery source retention custody is unavailable");
						const scopes = [
							recoveryRoles.previousClose,
							...recoveryRoles.classifiedScopes,
							...recoveryRoles.operationalSources.map((source) => ({
								objectId: registration.objectId,
								epoch: source.closedEpoch,
								anchor: source.closedAnchorDigest,
								manifestDigest: source.manifestRef.digest,
							})),
							priorRoles?.previousClose ?? null,
						].filter((scope) => scope !== null);
						const rows = recoverySource.authenticatedRecoverySourceGenerations;
						const selected = scopes.map((scope) => {
							const matches = rows.filter(
								(row) =>
									row.scope.objectId === scope.objectId &&
									row.scope.epoch === scope.epoch &&
									row.scope.anchor === scope.anchor &&
									row.scope.manifestDigest === scope.manifestDigest
							);
							const match = matches[0];
							if (matches.length !== 1 || match === undefined)
								throw new TypeError("creator certified recovery source generation is missing");
							return match.generation;
						});
						certifiedRecoverySourceGenerations = Object.freeze([
							...new Map(
								[...selected, ...recoverySource.authenticatedRecoverySupportGenerations].map((row) => [
									row.generationId,
									row,
								])
							).values(),
						]);
						const retained = new Set(certifiedRecoverySourceGenerations.map((row) => row.generationId));
						classifiedRecoverySourceGenerations = Object.freeze(
							rows.map((row) => row.generation).filter((row) => !retained.has(row.generationId))
						);
					}
					await recoverySource.checkCurrent();
				}
				const acceptedProposed = advance.proposed.closure;
				let verifiedPromotion: VerifiedCreatorForwardPromotion | undefined;
				const currentCloseSnapshot = {
					exactCanonicalManifestBytes: persistedSnapshot.exactCanonicalManifestBytes,
					exactCanonicalPayloadBytes: snapshot.exactCanonicalPayloadBytes,
				};
				const certifyPromotion = (source: CreatorForwardPromotionSourceMaterial): VerifiedCreatorForwardPromotion => {
					const verified = openCreatorForwardPromotion({
						currentTrust: registration.currentTrust,
						exactCanonicalPinnedGenesisTrustStateRecordBytes: source.exactCanonicalPinnedGenesisTrustStateRecordBytes,
						expectedRoomHeadState: { stable: source.expectedRoomHead, pending: null },
						current: source.current,
						predecessor: source.predecessor,
						proposed: advance.proposed,
						currentAclBytes: registration.exactCanonicalLatchedAclBytes,
						authorizedSuccessorAclBytes: encodeCanonical(acl),
						currentCloseSnapshot,
						historicalSnapshots: source.historicalSnapshots,
					});
					if (!verified.ok) throw new TypeError(`creator forward promotion certification failed: ${verified.reason}`);
					return verified.promotion;
				};
				if (promotionSource !== undefined) {
					verifiedPromotion = certifyPromotion(promotionSource);
					await promotionSource.checkCurrent();
				}
				const sourceStageCensus =
					promotionSource !== undefined &&
					(promotionSource.recoveryRoleTransfer !== null || promotionSource.installedPromotion !== null)
						? await captureSourceStageCensus()
						: undefined;
				const closeBlobs = [
					{ bytes: finalized.exactCanonicalTrustStateRecordBytes, ref: successorTrustRef },
					{ bytes: prepared.exactCanonicalCutValueBytes, ref: cutValueRef },
					{ bytes: finalized.exactCanonicalCommitQcBytes, ref: commitQcRef },
					historyCandidate,
					...controls.map(({ bytes, ref }) => ({ bytes, ref })),
				];
				const proposedHead = await stageCombinedGeneration(
					registration.store,
					current,
					closeBlobs,
					acceptedProposed,
					(selectedGenerationId, existingCompleteGeneration) =>
						createCreatorAuthenticatedNativeFuture({
							owner: handle,
							store: registration.store,
							successorTrust: successor.trust,
							currentHead: current.head,
							generationId: selectedGenerationId,
							acceptedClosure: acceptedProposed,
							newBlobs: existingCompleteGeneration === undefined ? closeBlobs : [],
							...(existingCompleteGeneration === undefined ? {} : { existingCompleteGeneration }),
						}),
					archivePreparation === undefined ? undefined : (() => {
						if (archive === undefined || archiveAccounting === undefined || checkArchiveSourceCurrency === undefined)
							throw new TypeError("archive close original accounting or floor owner is unavailable");
						return Object.freeze({ archiveStore: archive.store, accounting: archiveAccounting, currentTrust: registration.currentTrust,
							checkSourceCurrency: checkArchiveSourceCurrency,
							exactCanonicalCutValueBytes: prepared.exactCanonicalCutValueBytes,
							exactCanonicalCommitQcBytes: finalized.exactCanonicalCommitQcBytes,
							exactCanonicalTrustStateRecordBytes: finalized.exactCanonicalTrustStateRecordBytes });
					})()
				);
				if (sourceStageCensus !== undefined) {
					if (promotionSource === undefined || verifiedPromotion === undefined)
						throw new TypeError("creator staged promotion ownership is unavailable");
					const expectedStage = encodeCanonical({
						objectId: registration.objectId,
						generationId: proposedHead.generationId,
						baseExpectedHead: current.head,
						closureDigest: proposedHead.closureDigest,
						closure: acceptedProposed,
						state: "Adopted",
					});
					const checkOwnedStage = async (): Promise<void> => {
						const now = await captureSourceStageCensus();
						const head = await inspectHead(registration.store, registration.objectId);
						const staged = now.get(proposedHead.generationId);
						if (
							!sameHead(head.head, proposedHead) ||
							sourceStageCensus.has(proposedHead.generationId) ||
							now.size !== sourceStageCensus.size + 1 ||
							staged === undefined ||
							compareBytes(staged, expectedStage) !== 0 ||
							[...sourceStageCensus].some(([id, bytes]) => {
								const actual = now.get(id);
								const expected =
									id === current.head.generationId
										? encodeCanonical({ ...(decodeCanonical(bytes) as Record<string, unknown>), state: "Superseded" })
										: bytes;
								return actual === undefined || compareBytes(actual, expected) !== 0;
							})
						)
							throw new TypeError("creator staged promotion census changed outside the owned successor");
					};
					await checkOwnedStage();
					const originalIdentity = resolveCreatorForwardPromotion(verifiedPromotion);
					if (originalIdentity === undefined) throw new TypeError("creator promotion identity is unavailable");
					promotionSource = await promotionSource.reacquireAfterOwnedStage(proposedHead, acceptedProposed);
					const reacquired = certifyPromotion(promotionSource);
					const reacquiredIdentity = resolveCreatorForwardPromotion(reacquired);
					if (
						reacquiredIdentity === undefined ||
						compareBytes(encodeCanonical(originalIdentity), encodeCanonical(reacquiredIdentity)) !== 0
					)
						throw new TypeError("creator promotion identity changed during native source reacquisition");
					await checkOwnedStage();
					await promotionSource.checkCurrent();
					verifiedPromotion = reacquired;
				}
				if (promotionSource !== undefined && verifiedPromotion !== undefined) {
					const sourceRows = promotionSource.authenticatedRecoverySourceGenerations;
					certifiedRecoverySourceGenerations = Object.freeze([
						...new Map(
							[
								...(sourceRows ?? []).map(({ generation }) => generation),
								...promotionSource.authenticatedRecoveryRoleGenerations,
								...promotionSource.authenticatedRecoverySupportGenerations,
							].map((generation) => [generation.generationId, generation])
						).values(),
					]);
					// The original certificate remains a dependency of this promotion.
					// Its classified payload is not yet a deletion grant for this close.
					classifiedRecoverySourceGenerations = Object.freeze([]);
				}
				if (retiredSourceGenerations.length !== 0) {
					const retained = new Set(certifiedRecoverySourceGenerations?.map((row) => row.generationId));
					if (retiredSourceGenerations.some((row) => retained.has(row.generationId)))
						throw new TypeError("creator retired source remains a required dependency");
					classifiedRecoverySourceGenerations = Object.freeze([
						...(classifiedRecoverySourceGenerations ?? []),
						...retiredSourceGenerations,
					]);
				}
				if (
					!registration.terminalize({
						predecessorHead: current.head,
						head: proposedHead,
						cutValueRef,
						commitQcRef,
						successorTrustRef,
						borrowJournalHeaderCustody: async (): Promise<NativeReadReservation | undefined> => {
							if (stopping || dependenciesReleased || lifecycle !== "successor-pending-adoption")
								throw new TypeError("creator sealed journal custody is unavailable");
							return (recoverySource ?? promotionSource)?.borrowJournalHeaderReservation();
						},
					})
				)
					throw new TypeError("creator close terminalization failed");
				lifecycle = "successor-pending-adoption";
				const result = Object.freeze({
					closedVertexCount: commitment.closeSetCount,
					commitQcRef: copiedRef(commitQcRef),
					currentTrustRef: copiedRef(current.trustRef),
					cutValueRef: copiedRef(cutValueRef),
					epoch,
					lifecycle: "successor-pending-adoption" as const,
					ok: true as const,
					successorAnchorDigest: successor.trust.currentAnchorDigest,
					successorEpoch,
					successorTrustRef: copiedRef(successorTrustRef),
				});
				if (
					!installCreatorAdoptionFacts(
						handle,
						Object.freeze({
							...(certifiedRecoverySourceGenerations === undefined ? {} : { certifiedRecoverySourceGenerations }),
							...(archiveAccounting === undefined ? {} : { proofAccounting: archiveAccounting }),
							...(classifiedRecoverySourceGenerations === undefined ? {} : { classifiedRecoverySourceGenerations }),
							...(verifiedPromotion === undefined || promotionSource === undefined || promotedEpoch === undefined
								? {}
								: {
										promotion: Object.freeze({
											verified: verifiedPromotion,
											source: promotionSource,
											closedEpoch: promotedEpoch,
										}),
									}),
							transition: result,
							origin: "local-close" as const,
							currentHead: Object.freeze({ ...current.head }),
							currentReferences: Object.freeze(current.references.map(copiedRef)),
							currentTrust: registration.currentTrust,
							durableReplay,
							exactCanonicalLatchedAclBytes: Uint8Array.from(registration.exactCanonicalLatchedAclBytes),
							exactCanonicalParametersCarrierBytes: Uint8Array.from(registration.exactCanonicalParametersBytes),
							exactCanonicalPinnedGenesisBootstrapOperationBytes:
								registration.exactCanonicalPinnedGenesisBootstrapOperationBytes === undefined
									? undefined
									: Uint8Array.from(registration.exactCanonicalPinnedGenesisBootstrapOperationBytes),
							history: commitment,
							issuanceScope: Object.freeze({ ...registration.issuanceScope }),
							issuanceStore: registration.issuanceStore,
							liveJournalStore: registration.liveJournalStore,
							objectId: registration.objectId,
							proposedHead: Object.freeze({ ...proposedHead }),
							proposedReferences: Object.freeze(acceptedProposed.map(copiedRef)),
							snapshotDeclaration: persistedSnapshot.declaration,
							snapshotStore: input.snapshotStore,
							sourceRuntimeHandle: new WeakRef(input.plane),
							store: registration.store,
							terminalizeSource: async (): Promise<boolean> => {
								if (stopping || lifecycle !== "successor-pending-adoption") return false;
								await releaseDependencies();
								if (stopping || lifecycle !== "successor-pending-adoption") return false;
								lifecycle = "successor-adopted";
								revokeCreatorAdoptionFacts(handle);
								return true;
							},
						}) satisfies CreatorAdoptionFacts
					)
				) {
					throw new TypeError("creator adoption facts already exist");
				}
				finishRetainedReplayClose(true);
				return result;
			})().catch((error) => {
				closeTask = undefined;
				if (stagedSnapshot === undefined && registration.abortSnapshotStage()) lifecycle = "active";
				else lifecycle = "sealed";
				maintenanceClosing = lifecycle !== "active";
				finishRetainedReplayClose(false);
				throw error;
			});
			return closeTask;
		};
		const handle: CreatorLiveCloseHandle = Object.freeze({
			close,
			acquireLocalSessionWithdrawal: (author: string): Promise<CreatorLocalSessionWithdrawal> => {
				if (stopping || maintenanceJobs.size !== 0 || acquisitionTask !== undefined || closeTask !== undefined ||
					maintenanceReleaseFailure !== undefined || dependenciesReleased || dependencyReleaseTask !== undefined || actor.status().terminal ||
					lifecycle !== "active" || input.promotionContext === undefined)
					return Promise.reject(new TypeError("LOCAL_SESSION_DISPOSITION_SOURCE_UNAVAILABLE"));
				const task = (async (): Promise<CreatorLocalSessionWithdrawal> => {
					const hold = await registration.sealIssuanceMaintenanceDependencies();
					if (hold === undefined) throw new TypeError("LOCAL_SESSION_DISPOSITION_CENSUS_UNAVAILABLE");
					return acquireCreatorLocalSessionWithdrawal({ ...input.promotionContext!, objectId: registration.objectId,
						store: registration.store, snapshotStore: input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"],
						liveJournalStore: registration.liveJournalStore }, hold, registration.currentTrust, author,
						[registration.issuanceStore, input.voteStore, input.evidenceStore as object]);
				})();
				const joined = task.then(() => undefined);
				acquisitionTask = joined;
				void joined.then(() => { if (acquisitionTask === joined) acquisitionTask = undefined; },
					() => { if (acquisitionTask === joined) acquisitionTask = undefined; });
				return task;
			},
			acquirePromotionCheckpoint: (target: Readonly<{ closedEpoch: number }>): Promise<void> => {
				if (stopping || dependencyReleaseTask !== undefined || acquisitionTask !== undefined)
					return Promise.reject(new TypeError("creator promotion authority is unavailable"));
				const task = (async (): Promise<void> => {
					if (maintenanceJobs.size !== 0) throw new TypeError("creator promotion awaits admitted issuance maintenance");
					if (
						input.promotionContext === undefined ||
						promotionSource !== undefined ||
						lifecycle !== "active" ||
						closeTask !== undefined
					)
						throw new TypeError("creator promotion authority is unavailable");
					if (!plainRecord(target) || Reflect.ownKeys(target).length !== 1 || !Object.hasOwn(target, "closedEpoch"))
						throw new TypeError("creator promotion target is invalid");
					const closedEpoch = target.closedEpoch;
					if (typeof closedEpoch !== "number") throw new TypeError("creator promotion target is invalid");
					const recoveryStore = input.snapshotStore as typeof input.snapshotStore &
						CreatorClosedRollbackDataInput["snapshotStore"];
					if (
						typeof recoveryStore.acquireRecoveryRead !== "function" ||
						typeof recoveryStore.lookupRecoveryDeclaration !== "function"
					)
						throw new TypeError("creator native recovery snapshot owner is unavailable");
					promotionSource = await acquirePromotionSource(closedEpoch);
					promotedEpoch = closedEpoch;
					// The prepared selection is an equality witness, not a reader that
					// blocks current remote appends throughout user idle time. close()
					// independently reacquires and compares it before later effects.
					const preparedSource = promotionSource;
					promotionSource = undefined;
					await preparedSource?.release();
				})();
				acquisitionTask = task;
				void task.then(
					() => {
						if (acquisitionTask === task) acquisitionTask = undefined;
					},
					() => {
						if (acquisitionTask === task) acquisitionTask = undefined;
					}
				);
				return task;
			},
			releasePromotionDependencies: (): Promise<void> => {
				if (
					!stopping &&
					!dependenciesReleased &&
					(acquisitionTask !== undefined || closeTask !== undefined || maintenanceJobs.size !== 0)
				)
					return Promise.reject(new TypeError("creator close dependencies remain owned until adoption or stop"));
				return releaseDependencies();
			},
			inspectDurableHead: async () => {
				const inspected = await inspectHead(registration.store, registration.objectId);
				return Object.freeze({
					head: inspected.head,
					references: inspected.references,
					trustRef: inspected.trustRef,
				});
			},
			status: (): CreatorLiveCloseStatus => {
				const actorStatus = actor.status();
				const continuity = actorStatus.terminal
					? ("stalled" as const)
					: lifecycle === "successor-pending-adoption" ||
						  lifecycle === "successor-adopted" ||
						  actorStatus.phase === "empty"
						? ("continuous" as const)
						: ("relearning" as const);
				return Object.freeze({
					closeAuthority:
						stopping ||
						lifecycle === "successor-pending-adoption" ||
						lifecycle === "successor-adopted" ||
						actorStatus.terminal
							? ("unavailable" as const)
							: ("available" as const),
					continuity,
					lifecycle,
					trust,
				});
			},
			stop: (): Promise<void> => {
				if (stopTask !== undefined) return stopTask;
				stopping = true;
				ordinaryProofSource = undefined; ordinaryTemplateReady = false;
				revokeMaintenanceConsumer?.();
				stopTask = (async (): Promise<void> => {
					await Promise.allSettled([acquisitionTask, closeTask, ...maintenanceJobs]);
					const outcomes = await Promise.allSettled([
						Promise.resolve().then(() => actor.stop()),
						releaseDependencies(),
					]);
					const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
					if (maintenanceReleaseFailure !== undefined) failures.push(maintenanceReleaseFailure);
					if (failures.length === 1) throw failures[0];
					if (failures.length > 1) throw new AggregateError(failures, "creator close stop failed");
					revokeCreatorAdoptionFacts(handle);
				})();
				return stopTask;
			},
		});
		runtimeReleaseOwners.set(
			input.plane,
			Object.assign(
				(): CreatorCloseRuntimeReleasePlan | undefined => {
					if (lifecycle !== "successor-adopted" || !dependenciesReleased) return undefined;
					const before: CreatorCloseRuntimeReleaseCensus = Object.freeze({
						derivedCommitment: derivedCommitment !== undefined,
						durableReplay: durableReplay !== undefined,
						graph: capturedGraph !== undefined,
						persistedSnapshot: persistedSnapshot !== undefined,
						stagedSnapshot: stagedSnapshot !== undefined,
					});
					const after: CreatorCloseRuntimeReleaseCensus = Object.freeze({
						derivedCommitment: false,
						durableReplay: false,
						graph: false,
						persistedSnapshot: false,
						stagedSnapshot: false,
					});
					let used = false;
					return Object.freeze({
						after,
						before,
						release: (): boolean => {
							if (used) return true;
							if (lifecycle !== "successor-adopted" || !dependenciesReleased) return false;
							used = true;
							capturedGraph = undefined;
							stagedSnapshot = undefined;
							persistedSnapshot = undefined;
							derivedCommitment = undefined;
							durableReplay = undefined;
							archivePreparation = undefined;
							archiveAccounting = undefined;
						checkArchiveSourceCurrency = undefined;
							return true;
						},
					});
				},
				{
					prepareOrdinaryReadiness: (): Promise<void> => {
						const available = (): boolean => !stopping && !maintenanceClosing && lifecycle === "active" &&
							!dependenciesReleased && dependencyReleaseTask === undefined && acquisitionTask === undefined &&
							promotedEpoch === undefined && maintenanceReleaseFailure === undefined && !actor.status().terminal;
						if (!available() || maintenanceJobs.size !== 0)
							return Promise.reject(new TypeError("creator ordinary readiness owner is unavailable"));
						// Reuse the original admitted-job join. stop revokes immediately
						// and waits for the complete cold capture/release before its actor
						// and source owners can be released. No separate job queue exists.
						let finish!: () => void;
						const joined = new Promise<void>(resolve => {finish = resolve;});
						maintenanceJobs.add(joined);
						// Arrivals wait behind readiness: it is foreground until its slot is released.
						const releaseForeground = beginForegroundWork();
						const priorOrdinarySource = ordinaryProofSource;
						ordinaryProofSource = undefined; ordinaryTemplateReady = false;
						return Promise.resolve().then(async () => {
							try {
								if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
								let source: CreatorOrdinaryIssuanceProofSource | undefined;
								let captured = false, maintenanceRan = false, preparationAttempts = 0;
								// This admitted job keeps its proof's native custody across the
								// boundary and is revoked, never resumed, once unavailable.
								const checkpoint = createWorkCheckpoint();
								const cooperate = async (): Promise<void> => {
									await checkpoint();
									if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
								};
								const prepareSource = async (): Promise<CreatorOrdinaryIssuanceProofSource | undefined> => {
									await yieldToHost();
									if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
									const report = (outcome: string, reason?: string): void => {
										try {
											const observer = Reflect.get(globalThis, "__warmProofEvent");
											if (typeof observer === "function") observer({kind: "ordinary-readiness-source-refresh",
												epoch: registration.currentTrust.currentEpoch, outcome, hintPresent: priorOrdinarySource !== undefined,
												...(reason === undefined ? {} : {reason})});
										} catch { /* Observation supplies neither source facts nor admission. */ }
									};
									if (!maintenanceRan && priorOrdinarySource !== undefined) {
										const refreshed = await refreshCreatorOrdinarySourceReadiness(registration, input, priorOrdinarySource, cooperate);
										if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
										if (refreshed !== undefined) {
											report("joined-refresh-delivery");
											if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
											return refreshed;
										}
									}
									report("cold-boundary-fallback", maintenanceRan ? "required-maintenance" :
										priorOrdinarySource === undefined ? "no-retained-hint" : "warm-postimage-inconclusive");
									if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
									return captureCreatorOrdinarySourceWithoutForecast(registration, input, undefined, true, cooperate);
								};
								// Match the existing optional source-capture domain: unsupported
								// readiness must not acquire new native prerequisites or effects.
								if (input.promotionContext !== undefined && input.archive === undefined &&
									input.readOrdinaryApplicationResourceBound !== undefined) {
									// Unfinished recovery (e.g. a durable reopen after an early pool
									// turnover at this epoch) is discharged here by the ORIGINAL
									// reconstruction even without a finishing window; otherwise the
									// halted owner could never prepare readiness again.
									if ((input.ordinaryFinishingWindow !== undefined || registration.needsOrdinaryReadinessRecovery()) &&
										registration.currentTrust.currentEpoch >= 3) {
										if (promotionSource !== undefined || recoverySource !== undefined)
											throw new TypeError("creator readiness maintenance has retained source readers");
										const native = registration.store as AheBoundedRecoveryRoleStore;
										const capacity = await native.readGenerationPage({objectId: registration.objectId,
											limit: AHE_BOUNDED_READ_LIMITS.maxObjectGenerations});
										if (!capacity.ok) throw new TypeError("creator readiness generation capacity is unavailable", {cause: capacity});
										const control = await native.readRetirementControl?.(registration.objectId);
										if (control !== undefined && !control.ok)
											throw new TypeError("creator readiness retirement intent is unavailable", {cause: control});
										const owner = await input.snapshotStore.recoveryStatus();
										if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
										// These point observations request maintenance; they never authorize
										// admission or retirement. The cold capture below still authenticates
										// its whole actual source, and every ordinary call checks fresh currency.
										const required = registration.needsOrdinaryReadinessRecovery() || control === undefined ||
											control.ok && (control.value?.active != null || control.value?.completed?.generationDrain?.phase === "pending") ||
											owner.migration !== "ready";
										// Pool pressure is not unfinished recovery. A complete window
										// certificate must cover CURRENT pre-seal turnover and the complete
										// finishing path under the unchanged native ceilings. It may defer
										// that turnover to the original seal owner; failure to certify still
										// runs original maintenance now. No ordinary call may prepare lazily.
										if (!required) {
											await registration.prepareOrdinaryNativeMetadataForReadiness();
											if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
											preparationAttempts++;
											source = await prepareSource();
											captured = true;
										}
										// A certified complete finishing window makes unconditional E3+
										// cross-store frontier rewriting unnecessary. An inconclusive window
										// keeps the original exact maintenance/preparation path, at THIS
										// explicit boundary, never lazily on an ordinary gameplay call.
										if (required || source === undefined ||
											!creatorOrdinaryIssuanceSourceReadinessPrepared(source, input.readOrdinaryApplicationResourceBound, true)) {
											source = undefined; captured = false; maintenanceRan = true;
											await registration.runOrdinaryReadinessMaintenance(
											input.snapshotStore as SnapshotRecoveryStore<SnapshotVerificationReceipt>, async (seal, requireClosedWorkflowCompletion) => {
												if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
												const native = registration.store as AheBoundedRecoveryRoleStore;
												const capacity = await native.readGenerationPage({objectId: registration.objectId,
													limit: AHE_BOUNDED_READ_LIMITS.maxObjectGenerations});
												if (!capacity.ok) throw new TypeError("creator readiness generation capacity is unavailable", {cause: capacity});
												const checkpoint = await reconcileCreatorBoundedRecoveryMaintenance(registration, input, actor,
													capacity.value.generations.length, async () => {
														if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
														return seal();
												}, true, requireClosedWorkflowCompletion, registration.currentTrust);
												if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
												return checkpoint;
											});
										}
									}
									if (!captured) await registration.prepareOrdinaryNativeMetadataForReadiness();
								}
								if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
								if (!captured) {
									preparationAttempts++;
									source = await prepareSource();
								}
								if (!available()) throw new TypeError("creator ordinary readiness admission was revoked");
								ordinaryProofSource = source;
								ordinaryTemplateReady = source !== undefined && input.readOrdinaryApplicationResourceBound !== undefined &&
									creatorOrdinaryIssuanceSourceReadinessPrepared(source, input.readOrdinaryApplicationResourceBound);
								try {
									const observer = Reflect.get(globalThis, "__warmProofEvent");
									if (typeof observer === "function") observer({kind: "ordinary-boundary-readiness",
										epoch: registration.currentTrust.currentEpoch, prepared: ordinaryTemplateReady, maintenanceRan, preparationAttempts});
								} catch { /* Observation cannot grant or revoke preparation. */ }
							} catch (cause) {
								ordinaryProofSource = undefined; ordinaryTemplateReady = false;
								if (cause instanceof AggregateError) maintenanceReleaseFailure = cause;
								throw cause;
							} finally {
								releaseForeground();
								maintenanceJobs.delete(joined); finish();
								registration.resumePendingIngress();
							}
						});
					},
					holdIngressForReadiness: (): Promise<(successful: boolean) => void> => registration.holdIngressForReadiness(),
					// Explicit opt-in early turnover (soft watermark). The close keeps its
					// original inline maintenance as the hard-cap backstop; this only lets a
					// caller pay for the SAME original reconciliation at a quiescent lull.
					maintainRecoveryPool: async (): Promise<CreatorRecoveryPoolResult> => {
						const available = (): boolean => !stopping && !maintenanceClosing && lifecycle === "active" &&
							!dependenciesReleased && dependencyReleaseTask === undefined && acquisitionTask === undefined &&
							promotedEpoch === undefined && maintenanceReleaseFailure === undefined && !actor.status().terminal;
						const busy = Object.freeze({kind: "deferred" as const, reason: "busy" as const});
						if (input.promotionContext === undefined || input.archive !== undefined ||
							input.readOrdinaryApplicationResourceBound === undefined || registration.currentTrust.currentEpoch < 3)
							return Object.freeze({kind: "deferred", reason: "unsupported"});
						const resourceBound = input.readOrdinaryApplicationResourceBound;
						if (!available() || maintenanceJobs.size !== 0 || promotionSource !== undefined || recoverySource !== undefined)
							return busy;
						// Observational point reads before any admission: "not-needed" leaves
						// ordinary issuance, its retained source hint and native state untouched.
						const native = registration.store as AheBoundedRecoveryRoleStore;
						const capacity = await native.readGenerationPage({objectId: registration.objectId,
							limit: AHE_BOUNDED_READ_LIMITS.maxObjectGenerations});
						if (!capacity.ok) throw new TypeError("creator pool generation capacity is unavailable", {cause: capacity});
						const owner = await input.snapshotStore.recoveryStatus();
						if (owner.migration !== "ready" || !creatorRecoveryPoolPressure({recoveryScopes: owner.recoveryScopes,
							maxRecoveryScopes: owner.limits.maxRecoveryScopes, generations: capacity.value.generations.length,
							maxObjectGenerations: AHE_BOUNDED_READ_LIMITS.maxObjectGenerations}))
							return Object.freeze({kind: "not-needed"});
						if (!available() || maintenanceJobs.size !== 0 || promotionSource !== undefined || recoverySource !== undefined)
							return busy;
						// Same admitted-job join as readiness: stop waits for it, and the
						// original consumer refuses concurrent ordinary quotes meanwhile.
						let finish!: () => void;
						const joined = new Promise<void>(resolve => {finish = resolve;});
						maintenanceJobs.add(joined);
						const priorOrdinarySource = ordinaryProofSource;
						let detached = false;
						try {
							ordinaryProofSource = undefined; ordinaryTemplateReady = false; detached = true;
							// Pool maintenance is background: its walks defer host turns behind
							// co-located foreground work, and recheck availability after each.
							const outcome = await registration.runOrdinaryReadinessMaintenance(
								input.snapshotStore as SnapshotRecoveryStore<SnapshotVerificationReceipt>, (seal, requireClosedWorkflowCompletion) => runInBackgroundLane(async () => {
									if (!available()) throw new TypeError("creator pool maintenance admission was revoked");
									// Slice 14b stage 2: an opted-in room host decides this boundary from its
									// plane's verified-fact ledger when it can; otherwise the original below.
									if (!requireClosedWorkflowCompletion && input.promotionContext !== undefined) {
										const ledger = await reconcileCreatorRoomRetentionFromLedger({...input.promotionContext,
											objectId: registration.objectId, store: registration.store,
											snapshotStore: input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"],
											liveJournalStore: registration.liveJournalStore}, async () => {
											if (!available()) throw new TypeError("creator pool maintenance admission was revoked");
											return seal();
										}, registration.currentTrust);
										if (!available()) throw new TypeError("creator pool maintenance admission was revoked");
										if (ledger === "complete") return ledger;
									}
									const generations = await native.readGenerationPage({objectId: registration.objectId,
										limit: AHE_BOUNDED_READ_LIMITS.maxObjectGenerations});
									if (!generations.ok) throw new TypeError("creator pool generation capacity is unavailable", {cause: generations});
									const checkpoint = await reconcileCreatorBoundedRecoveryMaintenance(registration, input, actor,
										generations.value.generations.length, async () => {
											if (!available()) throw new TypeError("creator pool maintenance admission was revoked");
											return seal();
										}, true, requireClosedWorkflowCompletion, registration.currentTrust);
									if (!available()) throw new TypeError("creator pool maintenance admission was revoked");
									return checkpoint;
								}), {deferrable: true, after: () => runInBackgroundLane(async () => {
									// Runs in the boundary's queue slot after it released, before
									// queued arrivals: they cannot change the census mid-capture.
									const control = await native.readRetirementControl?.(registration.objectId);
									if (control !== undefined && !control.ok)
										throw new TypeError("creator pool retirement intent is unavailable", {cause: control});
									earlyTurnover = control === undefined ? undefined :
										captureCreatorEarlyTurnoverToken(registration.currentTrust.currentEpoch, control.value);
									if (!available()) throw new TypeError("creator pool maintenance admission was revoked");
									// Same cold readiness capture the original boundary uses after maintenance.
									await registration.prepareOrdinaryNativeMetadataForReadiness();
									if (!available()) throw new TypeError("creator pool maintenance admission was revoked");
									const source = await captureCreatorOrdinarySourceWithoutForecast(registration, input, undefined, true);
									if (!available()) throw new TypeError("creator pool maintenance admission was revoked");
									ordinaryProofSource = source; detached = false;
									ordinaryTemplateReady = source !== undefined &&
										creatorOrdinaryIssuanceSourceReadinessPrepared(source, resourceBound);
								})});
							if (outcome === "deferred") {
								// No hold, freeze or native work occurred: restore the joined hint,
								// which every ordinary call still checks for fresh currency.
								ordinaryProofSource = priorOrdinarySource; detached = false;
								ordinaryTemplateReady = priorOrdinarySource !== undefined &&
									creatorOrdinaryIssuanceSourceReadinessPrepared(priorOrdinarySource, input.readOrdinaryApplicationResourceBound);
								return busy;
							}
							return Object.freeze({kind: "maintained"});
						} catch (cause) {
							if (detached) { ordinaryProofSource = undefined; ordinaryTemplateReady = false; }
							earlyTurnover = undefined;
							if (cause instanceof AggregateError) maintenanceReleaseFailure = cause;
							throw cause;
						} finally {
							maintenanceJobs.delete(joined); finish();
							// Received moves refused while this job held the consumer were
							// retained, not dropped: admit them now through the full path.
							registration.resumePendingIngress();
						}
					},
					releaseHeaderCustodyForSuccessorInstall: async (): Promise<void> => {
						if (lifecycle !== "successor-pending-adoption" && lifecycle !== "successor-adopted")
							throw new TypeError("creator native successor installation has no completed close");
						await Promise.allSettled([...(closeTask === undefined ? [] : [closeTask]),
							...(acquisitionTask === undefined ? [] : [acquisitionTask]), ...maintenanceJobs]);
						const originalPromotion = promotionSource, originalRecovery = recoverySource;
						promotionSource = undefined; recoverySource = undefined;
						const outcomes = await Promise.allSettled([originalPromotion?.release(), originalRecovery?.release()]);
						const failures = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
						if (failures.length) throw new AggregateError(failures, "creator successor source custody release failed");
					},
					captureSigningRetirementOwners: (): CreatorSigningRetirementOwners => {
						if (stopping || dependenciesReleased || lifecycle === "successor-adopted")
							throw new TypeError("creator signing retirement consumer is unavailable");
						return actor.captureRetirementOwners();
					},
					borrowSigningDependencies: async (
						trusts: readonly CurrentAnchorTrust[],
						prepareData?: CreatorSigningDependencyPreparation
					): Promise<CreatorSigningDependencyRead> => {
						if (stopping || dependenciesReleased || lifecycle === "successor-adopted")
							throw new TypeError("creator signing dependency consumer is unavailable");
						return prepareData === undefined ? actor.acquireRecoveryDependencies(trusts) :
							acquireCreatorSigningDependenciesForPreparation(actor, trusts, prepareData);
					},
					acceptRecoveryRetirement: async (observation: object): Promise<void> => {
						const task = closeTask;
						if (
							stopping ||
							lifecycle !== "sealed" ||
							dependenciesReleased ||
							task === undefined ||
							retiredSourceGenerations.length !== 0
						)
							throw new TypeError("creator close retirement consumer is unavailable");
						const rows = await consumeCreatorRecoverySourceRetirement(observation, {
							plane: input.plane,
							store: registration.store,
							snapshotStore: input.snapshotStore,
							liveJournalStore: registration.liveJournalStore,
							currentTrust: registration.currentTrust,
						});
						if (
							stopping ||
							lifecycle !== "sealed" ||
							closeTask !== task ||
							dependenciesReleased ||
							retiredSourceGenerations.length !== 0
						)
							throw new TypeError("creator close retirement consumer changed");
						retiredSourceGenerations = rows;
					},
				}
			)
		);
		// Inherited classification is original close-owner maintenance, before
		// issuer callbacks can capture a quote and hold the very native writer that
		// R4 completion needs. Metadata fences grant no deletion permission.
		if ((await input.snapshotStore.recoveryStatus()).migration !== "ready") {
			try {
				if (input.promotionContext === undefined) throw new TypeError("creator inherited classification authority is unavailable");
				for (let phase = 0; phase < 2; phase++) {
					const hold = await registration.sealIssuanceMaintenanceDependencies();
					if (hold === undefined) throw new TypeError("creator inherited classification census is unavailable");
					await reconcileCreatorSnapshotRecoveryRoles({...input.promotionContext, objectId: registration.objectId,
						store: registration.store, snapshotStore: input.snapshotStore as CreatorClosedRollbackDataInput["snapshotStore"],
						liveJournalStore: registration.liveJournalStore}, hold);
					if ((await input.snapshotStore.recoveryStatus()).classificationIntent === undefined) break;
				}
				if ((await input.snapshotStore.recoveryStatus()).classificationIntent !== undefined)
					throw new TypeError("creator inherited SAME-intent readback did not complete");
			} catch (primary) {
				runtimeReleaseOwners.delete(input.plane);
				try { await actor.stop(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "creator inherited binding cleanup failed"); }
				throw primary;
			}
		}
		const revokeMaintenanceConsumer = registration.installIssuanceMaintenanceConsumer(maintenanceConsumer);
		if (revokeMaintenanceConsumer === undefined) {
			await actor.stop();
			runtimeReleaseOwners.delete(input.plane);
			throw new TypeError("creator issuance maintenance binding is unavailable");
		}
		bindings.set(input.plane, handle);
		return Object.freeze({ handle, ok: true as const });
	} catch {
		return Object.freeze({ ok: false as const, reason: "CREATOR_CLOSE_BIND_FAILED" });
	}
}

/** Prepares the existing bound owner's numerical finishing profile at an
 * explicit room lifecycle boundary. No lazy ordinary-call preparation or
 * authority is supplied by this entry point. Unsupported profiles stay unprepared. */
export async function prepareCreatorOrdinaryReadiness(plane: object): Promise<void> {
	const owner = runtimeReleaseOwners.get(plane as V3PlaneHandle);
	if (owner === undefined || bindings.get(plane as V3PlaneHandle) === undefined)
		throw new TypeError("creator ordinary readiness binding is unavailable");
	// Decision row 51: arrivals wait behind the whole preparation (its captures
	// and any maintenance boundary), so no received append meets the job's native
	// reservations or its consumer refusal, and none changes the pending ingress
	// its census and boundary require. Released on every path.
	const release = await owner.holdIngressForReadiness();
	let successful = false;
	try {
		await owner.prepareOrdinaryReadiness();
		successful = true;
	} finally {
		release(successful);
	}
}

/** Explicit opt-in early recovery-pool turnover at a caller-chosen quiescent lull.
 * The close's inline maintenance remains the hard-cap backstop; this grants no
 * authority and an unavailable or busy owner is reported, never forced. */
export async function maintainCreatorRecoveryPool(plane: object): Promise<CreatorRecoveryPoolResult> {
	const owner = runtimeReleaseOwners.get(plane as V3PlaneHandle);
	if (owner === undefined || bindings.get(plane as V3PlaneHandle) === undefined)
		return Object.freeze({kind: "deferred", reason: "unsupported"});
	return owner.maintainRecoveryPool();
}

/** Joins only the original bound close's source custody before successor native
 * installation. This changes no terminal/adoption state and grants no authority. */
export async function releaseCreatorCloseHeaderCustody(plane: object): Promise<void> {
	await runtimeReleaseOwners.get(plane as V3PlaneHandle)?.releaseHeaderCustodyForSuccessorInstall();
}

if (
	!installCreatorCloseRuntimeRelease(
		Object.assign(
			(plane: object): CreatorCloseRuntimeReleasePlan | undefined =>
				runtimeReleaseOwners.get(plane as V3PlaneHandle)?.(),
			{
				captureSigningRetirementOwners: (plane: object): CreatorSigningRetirementOwners => {
					const owner = runtimeReleaseOwners.get(plane as V3PlaneHandle);
					if (owner === undefined) throw new TypeError("creator signing retirement owner is unavailable");
					return owner.captureSigningRetirementOwners();
				},
				borrowSigningDependencies: async (plane: object, trusts: readonly CurrentAnchorTrust[],
					prepareData?: CreatorSigningDependencyPreparation): Promise<CreatorSigningDependencyRead> => {
					const owner = runtimeReleaseOwners.get(plane as V3PlaneHandle);
					if (owner === undefined) throw new TypeError("creator signing dependency owner is unavailable");
					return owner.borrowSigningDependencies(trusts, prepareData);
				},
				acceptRecoveryRetirement: async (plane: object, observation: object): Promise<void> => {
					const owner = runtimeReleaseOwners.get(plane as V3PlaneHandle);
					if (owner === undefined) throw new TypeError("creator close retirement owner is unavailable");
					await owner.acceptRecoveryRetirement(observation);
				},
			}
		)
	)
) {
	throw new TypeError("creator close runtime release owner was already installed");
}

Object.defineProperty(bindCreatorLiveClose, "installV3CreatorCloseRegistrationResolver", {
	configurable: false,
	enumerable: false,
	value: function installV3CreatorCloseRegistrationResolver(this: unknown, resolver: unknown): boolean {
		if (
			this !== bindCreatorLiveClose ||
			creatorCloseRegistrationResolver !== undefined ||
			typeof resolver !== "function"
		) {
			return false;
		}
		creatorCloseRegistrationResolver = (plane): unknown => Reflect.apply(resolver, undefined, [plane]) as unknown;
		return true;
	},
	writable: false,
});

