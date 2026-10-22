import type { DurableIssuancePruningReceipt, DurableIssuanceRetirementControlRead } from "@ts-drp/issuance-store/maintenance";
import type { CanonicalResourceFootprint } from "@ts-drp/canonical/resource";
import type { EpochVertex } from "@ts-drp/compaction";
import type { DurableLiveJournalStore, LiveJournalAcceptedRow } from "@ts-drp/live-journal";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { settlementProfileFor } from "@ts-drp/protocol-v3/settlement-profile";
import type { CreatorSigningDependencyRead, CreatorSigningRetirementOwners, CreatorSigningDependencyPreparation } from "@ts-drp/seal/creator";
import type { AheDurableStore, NativeReadReservation } from "@ts-drp/storage";
import type { AheReclamationReceipt } from "@ts-drp/storage/maintenance";

import type { CreatorPostAdoptionCensusSizing, CreatorPostAdoptionSettlementSizing, CreatorRoomSettlementPreview } from "../creator-close.js";
import type { CreatorOrdinaryRuntimeCapacityWidthInput, creatorOrdinaryRuntimeCapacityWidths } from "../v3-live.js";
import type { CreatorPendingClassificationCustodyInput } from "./creator-adoption-recover.js";
import type { CreatorOrdinarySourceCapture } from "./creator-closed-rollback-data.js";
import type { V3RoomRetirementSession } from "./room-retirement.js";

/** The original issuance retirement owner of one recovery hold. */
export type CreatorIssuanceRetirementOwner = (() => Promise<DurableIssuanceRetirementControlRead>) & {
	/** Slice 14a: the same owner's original read through a room retirement session. */
	readonly acquireIn?: (session: V3RoomRetirementSession) => Promise<DurableIssuanceRetirementControlRead>;
};

const INPUT_KEYS = Object.freeze(["aheReceipt", "issuanceReceipt", "successor"] as const);

/** SAME original execution classification, DATA only. This predicate cannot
 * authenticate an operation, authorize a Writer or omit a proof carrier. */
export function creatorApplicationControlOperationForSizing(value: unknown, profileId: string): boolean {
	if (settlementProfileFor(profileId) !== "v1") return false;
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
	const action = Reflect.get(value, "action");
	return action === "$drp.author-fence.v1" || action === "causalJoin" || action === "join";
}

/** SAME seven-field derivative constructor used after original authentication.
 * Field projection alone confers no admitted capability or signature fact. */
export function creatorAuthenticatedEpochVertexFields(input: Readonly<{
	anchor: string; dependencies: readonly string[]; epoch: number; hash: string;
	kind: EpochVertex["kind"]; objectId: string; operation: EpochVertex["operation"];
}>): EpochVertex {
	return {anchor: input.anchor, dependencies: [...input.dependencies], epoch: input.epoch,
		hash: input.hash, kind: input.kind, objectId: input.objectId, operation: input.operation};
}

export const D109D_RUNTIME_RECLAMATION_ERROR_CODES = Object.freeze([
	"D109D_INVALID_ARGUMENT",
	"D109D_RECEIPT_MISMATCH",
	"D109D_IDENTITY_MISMATCH",
	"D109D_RUNTIME_NOT_READY",
	"D109D_INTERNAL_INVARIANT",
] as const);

export type D109dRuntimeReclamationErrorCode = (typeof D109D_RUNTIME_RECLAMATION_ERROR_CODES)[number];

export type D109dRuntimeCensus = Readonly<{
	applicationAuthors: number;
	applicationCharges: number;
	applicationVertices: number;
	blueprintState: boolean;
	causalityIndex: number;
	creatorCloseDerivedCommitment: boolean;
	creatorCloseDurableReplay: boolean;
	creatorCloseGraph: boolean;
	creatorClosePersistedSnapshot: boolean;
	creatorCloseStagedSnapshot: boolean;
	displacedRebaseCursor: boolean;
	displacedSource: boolean;
	epochBytes: number;
	graphVersion: number;
	hotPredecessor: boolean;
	latchedOperations: number;
	pendingIngress: number;
	pendingIngressBytes: number;
	publication: boolean;
	quarantine: number;
	rebase: boolean;
	retainedPayloadMetadata: boolean;
}>;

export type D109dRuntimeReclamationResult =
	| Readonly<{
			after: D109dRuntimeCensus;
			before: D109dRuntimeCensus;
			closedEpoch: number;
			objectId: string;
			ok: true;
			replay: boolean;
			successorEpoch: number;
	  }>
	| Readonly<{ readonly code: D109dRuntimeReclamationErrorCode; readonly ok: false }>;

export type D109dRuntimeReclamationInput = Readonly<{
	readonly aheReceipt: AheReclamationReceipt;
	readonly issuanceReceipt: DurableIssuancePruningReceipt;
	readonly successor: object;
}>;

export type CreatorCloseRuntimeReleaseCensus = Readonly<{
	readonly derivedCommitment: boolean;
	readonly durableReplay: boolean;
	readonly graph: boolean;
	readonly persistedSnapshot: boolean;
	readonly stagedSnapshot: boolean;
}>;

export type CreatorCloseRuntimeReleasePlan = Readonly<{
	readonly after: CreatorCloseRuntimeReleaseCensus;
	readonly before: CreatorCloseRuntimeReleaseCensus;
	release(): boolean;
}>;

/** A live close's joined, categorized native dependency census; never a caller policy. */
export type CreatorSnapshotRecoveryCloseHold = Readonly<Record<never, never>>;
export type CreatorSnapshotRecoveryCloseOwners = Readonly<{
	store: AheDurableStore;
	liveJournalStore: DurableLiveJournalStore;
	currentTrust: CurrentAnchorTrust;
}>;
/** Nominal runtime custody only: no complete source census or retirement grant. */
declare const ordinaryIssuanceRuntimeHoldBrand: unique symbol;
export type CreatorOrdinaryIssuanceRuntimeHold = Readonly<{ readonly [ordinaryIssuanceRuntimeHoldBrand]: true }>;
/** Detached arithmetic/context readout. Native currency and source authority remain separate. */
export type CreatorOrdinaryIssuanceRuntimeReadout = Readonly<{
	kind: "local-issuance" | "received-append";
	objectId: string;
	epoch: number;
	anchorDigest: string;
	genesisAnchorDigest: string;
	profileId: CurrentAnchorTrust["profileId"];
	issuanceScope: Readonly<{ objectId: string; author: string }>;
	graphVersion: number;
	epochBytes: number;
	vertexCount: number;
	controlVertexCount: number;
	latchedOperationCount: number;
	pendingIngressCount: number;
	pendingIngressBytes: number;
	drainingPendingIngress: boolean;
	authorVertexCounts: readonly Readonly<{ author: string; count: number }>[];
	exactCanonicalLatchedAclBytes: Uint8Array;
}>;
/** Actual current facts only. The base snapshot is not a folded candidate or a
 * guarantee of reducer growth. Numerical observations confer no admission. */
export type CreatorOrdinaryIssuanceCurrentDimensions = Readonly<{
	runtime: CreatorOrdinaryIssuanceRuntimeReadout;
	parameters: Readonly<{authorShareMultiplier: number; maxDependencies: number; maxEpochBytes: number;
		maxEpochVertices: number; maxPendingBytes: number; maxPendingEntries: number; maxSnapshotBytes: number; snapshotChunkBytes: number}>;
	candidate: Readonly<{exactCanonicalUnsignedVertexBytes: Uint8Array; exactCanonicalEpochVertexBytes: Uint8Array;
		exactCanonicalOperationBytes: Uint8Array; digest: string; author: string; authorSequence: number;
		logicalTime: number; dependencies: readonly string[]; operationCount: number; action?: string; control: boolean}>;
	blueprint: Readonly<{blueprintDigest: string; baseStateDigest: string; exactCanonicalBaseStateBytes: Uint8Array;
		maxApplicationStateBytes: number; maxDepth: 16; maxItems: 16384;
		catalog: Readonly<{artifactId: string; artifactDigest: string; catalogDigest: string; runtimeProfile: string;
			exactArtifactBytes: Uint8Array; canonicalBlueprintPackageBytes: Uint8Array}>}>;
	/** Original graph/journal correspondence is checked before these numerical
	 * facts are captured. Complete raw PRE remains held by the original owner. */
	currentEpochVertexCount: number;
	currentSignedPreimageByteLengths: readonly number[];
	currentSignedPreimagesHaveSettlementSource: boolean;
	/** Width from the SAME freshly verified complete replay, not a sender bound. */
	currentJournalMaximumAuthorByteLength: number;
	/** Original execution projection only; original raw proof charges remain. */
	currentApplicationPreimageBytes: readonly Uint8Array[];
	/** Detached APP-effect DATA from original signed/source verifiers in this
	 * held invocation. No admission, replacement or retirement capability. */
	sourceLinkedApplicationEffects?: readonly CreatorOrdinaryApplicationControlFact[];
	applicationControls: readonly CreatorOrdinaryApplicationControlFact[];
	nativeCounts: Readonly<{lineages: number; issued: number; outbox: number; plans: number;
		currentJournalRows: number; localJournalRows: number; receivedJournalRows: number}>;
	pendingIngress: unknown;
	successorFenceCount: 0 | 1;
}>;
/** Numerical-only prepared purpose. Complete historical APP/order vectors are
 * intentionally unavailable; a failed incremental resource theorem must join
 * before the original full observation is acquired. No source/native authority. */
export type CreatorOrdinaryPreparedCapacityDimensions = Omit<CreatorOrdinaryIssuanceCurrentDimensions,
	"currentApplicationPreimageBytes" | "sourceLinkedApplicationEffects" | "applicationControls"> &
	Readonly<{preparedCapacityOnly: true}>;
/** Immutable authenticated state-effect fact only, not admission authority. */
export type CreatorOrdinaryApplicationControlFact = Readonly<{
	exactCanonicalPreimageBytes: Uint8Array; exactCanonicalEpochVertexBytes: Uint8Array;
}>;
export type CreatorOrdinaryApplicationControlCapture = Readonly<{
	identity: object; controls: readonly CreatorOrdinaryApplicationControlFact[];
	/** Detached boundary-readiness DATA from the genuine whole hold. There is
	 * no prospective operation, ordinary hold, paid credit or authority here. */
	preparation?: Readonly<{
		current: Omit<CreatorOrdinaryIssuanceCurrentDimensions, "candidate" | "runtime"> &
			Readonly<{runtime: Omit<CreatorOrdinaryIssuanceRuntimeReadout, "kind">}>;
		nativeCapacity: Readonly<{receivedPreimages: readonly Uint8Array[]; preimage: number; vertex: number; fencePreimage: number;
			runtimeWidths: ReturnType<typeof creatorOrdinaryRuntimeCapacityWidths>;
			issuance: ReturnType<typeof import("@ts-drp/issuance-store/maintenance").issuanceOrdinaryFinishingCapacityWidths>}>;
		cursor: object;
	}>;
}>;
/** Original application owner's optional local numerical planning policy.
 * Exact artifact/source correspondence is checked by the proof owner; this
 * callback grants neither wire validity, native authority nor charged credit. */
export type CreatorOrdinaryApplicationResourceBoundInput = Readonly<{
	catalog: CreatorOrdinaryIssuanceCurrentDimensions["blueprint"]["catalog"] & Readonly<{blueprintDigest: string}>;
	material: Readonly<{exactCanonicalBaseStateBytes: readonly Uint8Array[];
		currentOperations: readonly unknown[]; protectedOperations: readonly unknown[];
		recoveryOperations: readonly unknown[]; candidateOperation: unknown}>;
}>;
/** Trusted local numerical projection only. advance receives exclusively
 * original-owner authenticated, already accepted deltas. quote is provisional:
 * it must not retain the candidate, run reducers, or change actual ordering. */
export type CreatorOrdinaryApplicationResourceProjection = Readonly<{
	advance(operations: readonly unknown[]): boolean;
	quote(candidateOperation: unknown): CanonicalResourceFootprint | undefined;
	/** SAME complete material bound without any prospective APP operation.
	 * Selected only by the original held runtime's authenticated control fact;
	 * this method itself confers no neutrality or admission authority. */
	quoteWithoutApplicationCandidate?(): CanonicalResourceFootprint | undefined;
	/** Uniform numerical ceiling over the COMPLETE captured material and every
	 * supported future APP within this aggregate window. The admission owner must
	 * enforce actual validated action counts and canonical operation bytes; this
	 * declaration is neither a sender estimate nor operation authority. */
	quoteWindow?(window: CreatorOrdinaryApplicationResourceWindow): CanonicalResourceFootprint | undefined;
}>;
export type CreatorOrdinaryApplicationResourceWindow = Readonly<{
	maxAdditionalActions: number;
	maxAdditionalOperationBytes: number;
}>;
/** Host-local ordinary-work window, never authenticated protocol validity.
 * Totals cover ALL new rows since its preparation boundary, including neutral
 * protocol controls. Every amount is metered from original validated bytes and
 * action counts, not peer declarations. Leaf ceilings are independent of the
 * aggregate budgets. Reopen must recertify complete durable obligations. */
export type CreatorOrdinaryFinishingWindowLimits = CreatorOrdinaryApplicationResourceWindow & Readonly<{
	maxAdditionalLocalRows: number;
	maxAdditionalReceivedRows: number;
	maxAdditionalPreimageBytes: number;
	maxAdditionalEpochVertexBytes: number;
	maxCanonicalOperationByteLength: number;
	maxCanonicalPreimageByteLength: number;
	maxCanonicalEpochVertexByteLength: number;
	maxSuccessorFencePreimageByteLength: number;
	maxReceivedPendingIngressByteLength: number;
	/** Enforced through the catalog-bound complete-material projection on EVERY
	 * candidate. This bounds admitted application resources, not future payload
	 * predictions; actual machine validation remains independently mandatory. */
	maxApplicationBytes: number;
	maxApplicationItems: number;
	maxApplicationDepth: number;
}>;
export type CreatorOrdinaryApplicationResourceProjectionInput = Readonly<{
	catalog: CreatorOrdinaryApplicationResourceBoundInput["catalog"];
	material: Omit<CreatorOrdinaryApplicationResourceBoundInput["material"], "candidateOperation">;
}>;
export type CreatorOrdinaryApplicationResourceBoundReader =
	((input: CreatorOrdinaryApplicationResourceBoundInput) => CanonicalResourceFootprint | undefined) & Readonly<{
		/** Optional SAME catalog-bound resource theorem; absent/unsupported always
		 * uses the original complete-material callback. No wire/profile change. */
		createIncrementalProjection?: (input: CreatorOrdinaryApplicationResourceProjectionInput) =>
			CreatorOrdinaryApplicationResourceProjection | undefined;
	}>;
export type CreatorOrdinaryIssuanceRuntimeLifetime = Readonly<{
	readonly plane: object;
	readRuntime(): CreatorOrdinaryIssuanceRuntimeReadout;
	/** Nominal registered source context only; not portable authority. */
	readSourceIdentity(): object;
	readNativeIssuance(): Promise<import("@ts-drp/issuance-store/maintenance").DurableIssuanceRecoveryCensus>;
	/** Original producer's exact held-current point, never census/auth/credit. */
	captureNativeIssuanceCurrentProbe?(observation: import("@ts-drp/issuance-store/maintenance").DurableIssuanceRecoveryCensus):
		import("@ts-drp/issuance-store/maintenance").DurableIssuanceRecoveryCensusCurrentProbe | undefined;
	/** Explicit-boundary candidate-free preparation through this same admitted
	 * runtime and its fully checked native captures. Commit is private staging;
	 * the proof owner still owes complete final currency and joined release. */
	captureReadinessPreparation?(accounting: import("./creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting):
		Promise<Readonly<{preparation: NonNullable<CreatorOrdinaryApplicationControlCapture["preparation"]>;
			commit(): boolean}> | undefined>;
	/** Original current-plane verifier; true is not retirement or census authority. */
	checkCurrentOrdinaryWork(row: Readonly<{objectId: string; author: string; authorSequence: number;
		canonicalPreimageBytes: Uint8Array; digest: Uint8Array; signature: Uint8Array}>, preparedCapacityOnly?: true): boolean;
	/** Fresh original reader, paired with the SAME held physical image's current
	 * tuples. The detached DATA is neither signature nor admission authority. */
	checkCurrentJournal(accounting: import("./creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting,
nativeRows: readonly LiveJournalAcceptedRow[], preparedCapacityOnly?: true): Promise<boolean>;
	/** Original registered runtime arithmetic, bound to this call's native counts. */
	/** SAME room preview and fresh current native/context facts. Resource DATA only;
	 * complete proof currency and charges still belong to the calling proof. */
	readOrdinarySettlementCapacity(unsignedBytes: Uint8Array, preview: CreatorRoomSettlementPreview):
		Readonly<{successorFenceCount: 1; canonicalSuccessorFencePreimageByteLength: number; nativeControlRevisionDelta: number}> | undefined;
	readCapacityWidths(input: CreatorOrdinaryRuntimeCapacityWidthInput): ReturnType<typeof creatorOrdinaryRuntimeCapacityWidths>;
	readCapacityLeafWidths(): Readonly<{canonicalPreimageByteLength: number; canonicalEpochVertexByteLength: number}>;
	/** Bound to the genuine current candidate and original machine, not future close work. */
	readCurrentDimensions(unsignedBytes: Uint8Array): CreatorOrdinaryIssuanceCurrentDimensions | undefined;
	resolveCurrentDimensions(readout: unknown, unsignedBytes: Uint8Array): CreatorOrdinaryIssuanceCurrentDimensions | undefined;
	readPreparedCapacityDimensions?(unsignedBytes: Uint8Array): CreatorOrdinaryPreparedCapacityDimensions | undefined;
	resolvePreparedCapacityDimensions?(readout: unknown, unsignedBytes: Uint8Array): CreatorOrdinaryPreparedCapacityDimensions | undefined;
	/** Nominal owner cursor after original whole graph/journal/native checks.
	 * Source changes, uncertain work and unsupported transitions refuse it. */
	captureApplicationResourceCursor?(): object | undefined;
	/** Complete authenticated non-control application PRE suffix, not a parsed
	 * caller-selected subset. Foreign/stale/non-append cursors are unavailable. */
	readApplicationResourceDelta?(cursor: object): readonly Uint8Array[] | undefined;
	readPostAdoptionSizing(unsignedBytes: Uint8Array, genuinePreparedClose: object, projectionBytes: Uint8Array,
		settlement?: CreatorPostAdoptionSettlementSizing): readonly CreatorPostAdoptionCensusSizing[] | undefined;
	resolvePostAdoptionSizing(readout: unknown, unsignedBytes: Uint8Array, genuinePreparedClose: object,
		projectionBytes: Uint8Array): readonly CreatorPostAdoptionCensusSizing[] | undefined;
	/** Original entered receive identity, never caller-selected source custody. */
	readReceivedAppend(): Readonly<{ exactCanonicalPreimageBytes: Uint8Array; signature: Uint8Array;
		digest: string; author: string; sourceAuthorized: boolean }> | undefined;
	/** Runtime/signing bracket only. The proof owner must still probe genuine
	 * native facades, complete images, protections and source/target currency. */
	checkWhile(read: () => Promise<void>, signing?: CreatorSigningDependencyRead): Promise<void>;
	borrowSigningDependencies(trusts: readonly CurrentAnchorTrust[], prepareData?: CreatorSigningDependencyPreparation): Promise<CreatorSigningDependencyRead>;
	borrowCurrentNativeReservation?(owner: "ahe" | "journal" | "floor"): Promise<NativeReadReservation | undefined>;
	acquireNativeIssuanceReservation(): Promise<NativeReadReservation>;
	/** Revoke observational admissions and join reads, retaining physical
	 * signing/current-owner protection until their original terminal release. */
	endReadPhase(): Promise<void>;
	release(): Promise<void>;
}>;
type OrdinaryIssuanceRuntimeResolver = (value: unknown, owners: CreatorSnapshotRecoveryCloseOwners) =>
	CreatorOrdinaryIssuanceRuntimeLifetime | undefined;
/** Decision row 60 (R5): one local-issued journal row outside its scope's signed Cut. */
export type CreatorReplacedLocalSource = Readonly<{ author: string; authorSequence: number; vertexDigest: string }>;
/** Its original issued bytes and the exact replacement rows its own plan entry names, each of
 * whose operations equal the source's derivation by the original immutable settlement policy.
 * Data only: the journal classifier authenticates the source against its closed ACL and
 * requires every replacement digest in a later signed Cut before any deletion. */
export type CreatorReplacedLocalSourceRead = Readonly<{
	exactCanonicalPreimageBytes: Uint8Array;
	detachedSignature: Uint8Array;
	replacementVertexDigests: readonly string[];
}>;
export type CreatorSnapshotRecoveryCloseLifetime = Readonly<{
	/** Decision row 60 (R5): this hold's own registration reads a local source it replaced.
	 * Undefined unless the source, its plan entry and every replacement row are exactly that. */
	readReplacedLocalSource?(source: CreatorReplacedLocalSource): Promise<CreatorReplacedLocalSourceRead | undefined>;
	/** Private owner geometry only: this lifetime retains no replacement or
	 * displaced-source physical custody. It is not currency or authorization. */
	canDetachNativePreparation?: true;
	/** Same held, fully charged native observation only. Optional data/currency
	 * enrollment never supplies authentication, another proof book or authority. */
	enrollCurrentJournalObservation?(observation: import("@ts-drp/live-journal").LiveJournalRetirementImageObservation): void;
	/** Optional SAME private adoption's pure exact-byte verification facts.
	 * The caller supplies its original fresh ACL resolver; no admitted view,
	 * source/role decision, native currency or proof credit is returned. */
	verifyVertex?: typeof import("@ts-drp/protocol-v3/internal/received-vertex-authentication").verifyReceivedVertex;
	/** Capture only the SAME bounded pure verification kernel. It carries no
	 * source/lifecycle authority and still resolves the supplied closed ACL anew. */
	captureVertexVerificationFacts?(): typeof import("@ts-drp/protocol-v3/internal/received-vertex-authentication").verifyReceivedVertex;
	/** Slice 14b stage 2: this live plane's ledger of verified immutable facts (an opted-in
	 * room host's retention path only). `create` starts an empty one for a plane without
	 * one. It holds no currency, control, census, accounting or authorization. */
	captureRoomRetentionLedger?(create: boolean): import("./room-retention-ledger.js").RoomRetentionLedger | undefined;
	/** Borrow only the same lexical replacement's already-held current native owners. */
	borrowCurrentNativeReservation?(owner: "ahe" | "journal" | "floor"): Promise<NativeReadReservation | undefined>;
	plane?: object;
	dependencyAnchors: readonly Readonly<{ epoch: number; anchorDigest: string }>[];
	sourceTrust: CurrentAnchorTrust | undefined;
	/** Borrowed from this same runtime owner; detached bytes are observation, never authority. */
	borrowDependencies(): Promise<CreatorSnapshotRecoveryCloseDependencyRead>;
	borrowSigningDependencies(trusts: readonly CurrentAnchorTrust[], prepareData?: CreatorSigningDependencyPreparation): Promise<CreatorSigningDependencyRead>;
	captureSigningRetirementOwners(): CreatorSigningRetirementOwners;
	captureIssuanceRetirementOwner(): CreatorIssuanceRetirementOwner;
	/** Original factory capture for no-deletion authenticated inherited metadata
	 * composition. Active hold remains read-only for completeRetirement. These
	 * factories are not narrowed grants: the original planner must select no drains. */
	captureClassificationMetadataOwners(): Readonly<{signing: CreatorSigningRetirementOwners;
		issuance: () => Promise<DurableIssuanceRetirementControlRead>}>;
	check(): Promise<void>;
	acquireNativeIssuanceReservation(): Promise<NativeReadReservation>;
	completeRetirement(observation: object): Promise<void>;
	release(): Promise<void>;
}>;
export type CreatorSnapshotRecoveryCloseDependencyRead = Readonly<{
	dependencyAnchors: readonly Readonly<{ epoch: number; anchorDigest: string }>[];
	readExactCanonicalCensus(): Uint8Array;
	/** One complete context check around a read, optionally sharing the same
	 * hold's original signing-native checks. Foreign children confer no custody. */
	checkWhile(read: () => Promise<void>, signing?: CreatorSigningDependencyRead): Promise<void>;
	release(): Promise<void>;
}>;
type RecoveryCloseHoldResolver = (
	value: unknown,
	owners: CreatorSnapshotRecoveryCloseOwners
) => CreatorSnapshotRecoveryCloseLifetime | undefined;
type PendingClassificationCustodyOwner = (input: CreatorPendingClassificationCustodyInput) =>
	Promise<Readonly<{hold: CreatorSnapshotRecoveryCloseHold; stop(): Promise<void>}> | undefined>;
type PostAdoptionCensusSizingResolver = (
	hold: unknown,
	readout: unknown,
	unsignedBytes: Uint8Array,
	preparedClose: object,
	projectionBytes: Uint8Array
) => readonly CreatorPostAdoptionCensusSizing[] | undefined;
type ReceivedAppendSizingResolver = (hold: unknown, bytes: Uint8Array) => Readonly<{
	signature: Uint8Array;
	localIssuerBasis: Readonly<{objectId: string; author: string; nextAuthorSequence: number}>;
}> | undefined;
type RuntimeReclamationOwner = ((input: D109dRuntimeReclamationInput) => Promise<D109dRuntimeReclamationResult>) &
	Readonly<{
		resolveRecoveryCloseHold?: RecoveryCloseHoldResolver;
		resolveOrdinaryIssuanceRuntimeHold?: OrdinaryIssuanceRuntimeResolver;
		captureOrdinaryIssuanceRuntimeSourceIdentity?: (hold: unknown, capture?: CreatorOrdinarySourceCapture) => Promise<object | undefined>;
		captureOrdinaryIssuanceRuntimeApplicationControls?: (hold: unknown,
			accounting?: import("./creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting,
			capture?: CreatorOrdinarySourceCapture) => Promise<CreatorOrdinaryApplicationControlCapture | undefined>;
		releaseOrdinaryIssuanceRuntimeHold?: (hold: unknown) => Promise<void>;
		acquirePendingClassificationCustody?: PendingClassificationCustodyOwner;
		resolvePostAdoptionCensusSizing?: PostAdoptionCensusSizingResolver;
		resolveReceivedAppendSizing?: ReceivedAppendSizingResolver;
	}>;
type RuntimeReclamationKernel = Readonly<{
	reclaim: RuntimeReclamationOwner;
	resolveRecoveryCloseHold: RecoveryCloseHoldResolver | undefined;
	resolveOrdinaryIssuanceRuntimeHold: OrdinaryIssuanceRuntimeResolver | undefined;
	captureOrdinaryIssuanceRuntimeSourceIdentity: ((hold: unknown, capture?: CreatorOrdinarySourceCapture) => Promise<object | undefined>) | undefined;
	captureOrdinaryIssuanceRuntimeApplicationControls: ((hold: unknown,
		accounting?: import("./creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting,
		capture?: CreatorOrdinarySourceCapture) => Promise<CreatorOrdinaryApplicationControlCapture | undefined>) | undefined;
	releaseOrdinaryIssuanceRuntimeHold: ((hold: unknown) => Promise<void>) | undefined;
	acquirePendingClassificationCustody: PendingClassificationCustodyOwner | undefined;
	resolvePostAdoptionCensusSizing: PostAdoptionCensusSizingResolver | undefined;
	resolveReceivedAppendSizing: ReceivedAppendSizingResolver | undefined;
}>;
type CreatorCloseRuntimeReleaseOwner = ((plane: object) => CreatorCloseRuntimeReleasePlan | undefined) & {
	acceptRecoveryRetirement?(plane: object, observation: object): Promise<void>;
	borrowSigningDependencies?(plane: object, trusts: readonly CurrentAnchorTrust[], prepareData?: CreatorSigningDependencyPreparation): Promise<CreatorSigningDependencyRead>;
	captureSigningRetirementOwners?(plane: object): CreatorSigningRetirementOwners;
};

let runtimeKernel: RuntimeReclamationKernel | undefined;
let creatorCloseReleaseOwner:
	| Readonly<{
			prepare: CreatorCloseRuntimeReleaseOwner;
			acceptRecoveryRetirement: CreatorCloseRuntimeReleaseOwner["acceptRecoveryRetirement"];
			borrowSigningDependencies: CreatorCloseRuntimeReleaseOwner["borrowSigningDependencies"];
			captureSigningRetirementOwners: CreatorCloseRuntimeReleaseOwner["captureSigningRetirementOwners"];
	  }>
	| undefined;

function invalid(): D109dRuntimeReclamationResult {
	return Object.freeze({ code: "D109D_INVALID_ARGUMENT" as const, ok: false as const });
}

function captureInput(value: unknown): D109dRuntimeReclamationInput | undefined {
	try {
		if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
			return undefined;
		}
		const keys = Reflect.ownKeys(value);
		if (
			keys.length !== INPUT_KEYS.length ||
			keys.some((key) => typeof key !== "string" || !INPUT_KEYS.includes(key as (typeof INPUT_KEYS)[number]))
		) {
			return undefined;
		}
		const captured = Object.create(null) as Record<string, unknown>;
		for (const key of INPUT_KEYS) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
			captured[key] = descriptor.value;
		}
		if (captured.successor === null || typeof captured.successor !== "object") return undefined;
		return Object.freeze({
			aheReceipt: captured.aheReceipt as AheReclamationReceipt,
			issuanceReceipt: captured.issuanceReceipt as DurableIssuancePruningReceipt,
			successor: captured.successor,
		});
	} catch {
		return undefined;
	}
}

/**
 * Installs the sole v3 registration reclamation kernel.
 * @param owner - Private runtime owner.
 * @returns Whether the first owner was installed.
 */
export function installV3RuntimeReclamationKernel(owner: RuntimeReclamationOwner): boolean {
	if (runtimeKernel !== undefined || typeof owner !== "function") return false;
	const descriptor = Object.getOwnPropertyDescriptor(owner, "resolveRecoveryCloseHold");
	if (descriptor !== undefined && (!("value" in descriptor) || typeof descriptor.value !== "function")) return false;
	const ordinary = Object.getOwnPropertyDescriptor(owner, "resolveOrdinaryIssuanceRuntimeHold");
	if (ordinary !== undefined && (!("value" in ordinary) || typeof ordinary.value !== "function")) return false;
	const sourceIdentity = Object.getOwnPropertyDescriptor(owner, "captureOrdinaryIssuanceRuntimeSourceIdentity");
	if (sourceIdentity !== undefined && (!("value" in sourceIdentity) || typeof sourceIdentity.value !== "function")) return false;
	const applicationControls = Object.getOwnPropertyDescriptor(owner, "captureOrdinaryIssuanceRuntimeApplicationControls");
	if (applicationControls !== undefined && (!("value" in applicationControls) || typeof applicationControls.value !== "function")) return false;
	const ordinaryRelease = Object.getOwnPropertyDescriptor(owner, "releaseOrdinaryIssuanceRuntimeHold");
	if (ordinaryRelease !== undefined && (!("value" in ordinaryRelease) || typeof ordinaryRelease.value !== "function")) return false;
	const sizing = Object.getOwnPropertyDescriptor(owner, "resolvePostAdoptionCensusSizing");
	if (sizing !== undefined && (!("value" in sizing) || typeof sizing.value !== "function")) return false;
	const pending = Object.getOwnPropertyDescriptor(owner, "acquirePendingClassificationCustody");
	const received = Object.getOwnPropertyDescriptor(owner, "resolveReceivedAppendSizing");
	if (received !== undefined && (!("value" in received) || typeof received.value !== "function")) return false;
	if (pending !== undefined && (!("value" in pending) || typeof pending.value !== "function")) return false;
	runtimeKernel = Object.freeze({
		reclaim: owner,
		resolveRecoveryCloseHold: descriptor?.value as RecoveryCloseHoldResolver | undefined,
		resolveOrdinaryIssuanceRuntimeHold: ordinary?.value as OrdinaryIssuanceRuntimeResolver | undefined,
		captureOrdinaryIssuanceRuntimeSourceIdentity: sourceIdentity?.value as ((hold: unknown) => Promise<object | undefined>) | undefined,
		captureOrdinaryIssuanceRuntimeApplicationControls: applicationControls?.value as RuntimeReclamationKernel["captureOrdinaryIssuanceRuntimeApplicationControls"],
		releaseOrdinaryIssuanceRuntimeHold: ordinaryRelease?.value as ((hold: unknown) => Promise<void>) | undefined,
		acquirePendingClassificationCustody: pending?.value as PendingClassificationCustodyOwner | undefined,
		resolvePostAdoptionCensusSizing: sizing?.value as PostAdoptionCensusSizingResolver | undefined,
		resolveReceivedAppendSizing: received?.value as ReceivedAppendSizingResolver | undefined,
	});
	return true;
}

/** Private dispatch to the same installed runtime/native custody owner. No
 * caller-selected policy, separate registration, or public classify entry. */
export function acquireCreatorPendingClassificationCustody(input: CreatorPendingClassificationCustodyInput):
	ReturnType<PendingClassificationCustodyOwner> {
	return runtimeKernel?.acquirePendingClassificationCustody?.(input) ?? Promise.resolve(undefined);
}

/**
 * Resolves live custody through the sole installed runtime owner, not caller policy.
 * @param value - Genuine noncopyable live-close hold.
 * @param owners - Exact native owners and current authority.
 * @returns Joined lifetime checks, or undefined for unavailable or foreign custody.
 */
export function resolveCreatorSnapshotRecoveryCloseHold(
	value: unknown,
	owners: CreatorSnapshotRecoveryCloseOwners
): CreatorSnapshotRecoveryCloseLifetime | undefined {
	try {
		return runtimeKernel?.resolveRecoveryCloseHold?.(value, owners);
	} catch {
		return undefined;
	}
}

/** Runtime-only dispatch through the same installed nominal hold owner. */
export function resolveCreatorOrdinaryIssuanceRuntimeHold(value: unknown, owners: CreatorSnapshotRecoveryCloseOwners):
	CreatorOrdinaryIssuanceRuntimeLifetime | undefined {
	try { return runtimeKernel?.resolveOrdinaryIssuanceRuntimeHold?.(value, owners); }
	catch { return undefined; }
}

/** Cold genuine full hold to detached nominal source context; no source grant. */
export async function captureCreatorOrdinaryIssuanceRuntimeSourceIdentity(hold: unknown, capture?: CreatorOrdinarySourceCapture): Promise<object | undefined> {
	return runtimeKernel?.captureOrdinaryIssuanceRuntimeSourceIdentity?.(hold, capture);
}
/** Same installed original cold runtime owner; immutable state-effect facts only. */
export async function captureCreatorOrdinaryIssuanceRuntimeApplicationControls(hold: unknown,
	accounting?: import("./creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting, capture?: CreatorOrdinarySourceCapture):
	Promise<CreatorOrdinaryApplicationControlCapture | undefined> {
	return runtimeKernel?.captureOrdinaryIssuanceRuntimeApplicationControls?.(hold, accounting, capture);
}

/** Join the original ordinary owner even when fresh resolution has become stale. */
export async function releaseCreatorOrdinaryIssuanceRuntimeHold(hold: unknown): Promise<void> {
	await runtimeKernel?.releaseOrdinaryIssuanceRuntimeHold?.(hold);
}

/**
 * Resolves arithmetic only through the same live held runtime source owner.
 * The installed owner rejects copies, foreign/released holds and changed
 * unsigned/nominal-close/projection inputs. This cannot grant native authority.
 * @param hold - Original private held runtime source.
 * @param readout - Original owner-produced immutable arithmetic readout.
 * @param unsignedBytes - Exact original unsigned candidate.
 * @param preparedClose - Nominal original prepared close.
 * @param projectionBytes - Exact original successor projection.
 * @returns Bound original dimensions, or undefined for a stale/foreign copy.
 */
export function resolveCreatorPostAdoptionCensusSizing(
	hold: unknown,
	readout: unknown,
	unsignedBytes: Uint8Array,
	preparedClose: object,
	projectionBytes: Uint8Array
): readonly CreatorPostAdoptionCensusSizing[] | undefined {
	try {
		return runtimeKernel?.resolvePostAdoptionCensusSizing?.(hold, readout, unsignedBytes, preparedClose, projectionBytes);
	} catch {
		return undefined;
	}
}

/** Exact private received candidate binding, not portable authentication authority. */
export function resolveCreatorReceivedAppendSizing(hold: unknown, bytes: Uint8Array) {
	try { return runtimeKernel?.resolveReceivedAppendSizing?.(hold, bytes); }
	catch { return undefined; }
}

/**
 * Installs the sole creator-close duplicate-release owner.
 * @param owner - Private creator-close owner.
 * @returns Whether the first owner was installed.
 */
export function installCreatorCloseRuntimeRelease(owner: CreatorCloseRuntimeReleaseOwner): boolean {
	if (creatorCloseReleaseOwner !== undefined || typeof owner !== "function") return false;
	const descriptor = Object.getOwnPropertyDescriptor(owner, "acceptRecoveryRetirement");
	if (descriptor !== undefined && (!("value" in descriptor) || typeof descriptor.value !== "function")) return false;
	const signing = Object.getOwnPropertyDescriptor(owner, "borrowSigningDependencies");
	if (signing !== undefined && (!("value" in signing) || typeof signing.value !== "function")) return false;
	const retirement = Object.getOwnPropertyDescriptor(owner, "captureSigningRetirementOwners");
	if (retirement !== undefined && (!("value" in retirement) || typeof retirement.value !== "function")) return false;
	creatorCloseReleaseOwner = Object.freeze({
		prepare: owner,
		acceptRecoveryRetirement: descriptor?.value as CreatorCloseRuntimeReleaseOwner["acceptRecoveryRetirement"],
		borrowSigningDependencies: signing?.value as CreatorCloseRuntimeReleaseOwner["borrowSigningDependencies"],
		captureSigningRetirementOwners: retirement?.value as CreatorCloseRuntimeReleaseOwner["captureSigningRetirementOwners"],
	});
	return true;
}

/**
 * Prepares a no-throw creator-close release before runtime mutation starts.
 * @param plane - Genuine retired predecessor handle.
 * @returns Prepared release and exact before/after census when ready.
 */
export function prepareCreatorCloseRuntimeRelease(plane: object): CreatorCloseRuntimeReleasePlan | undefined {
	try {
		return creatorCloseReleaseOwner?.prepare(plane);
	} catch {
		return undefined;
	}
}

/**
 * Routes an original source fact only to the sole already-installed close owner.
 * @param plane - Genuine currently held close plane.
 * @param observation - Original nominal completed reconciliation fact.
 */
export async function acceptCreatorCloseRecoveryRetirement(plane: object, observation: object): Promise<void> {
	const accept = creatorCloseReleaseOwner?.acceptRecoveryRetirement;
	if (accept === undefined) throw new TypeError("creator close retirement owner is unavailable");
	await accept(plane, observation);
}

/**
 * Routes original held trust capabilities only to the already-bound creator's actor.
 * @param plane - Exact handle bound to the original creator-close owner.
 * @param trusts - Original authenticated trust capabilities already held by recovery.
 * @returns Original actor's identity-bound signing dependency read.
 */
export async function borrowCreatorCloseSigningDependencies(
	plane: object,
	trusts: readonly CurrentAnchorTrust[],
	prepareData?: CreatorSigningDependencyPreparation
): Promise<CreatorSigningDependencyRead> {
	const borrow = creatorCloseReleaseOwner?.borrowSigningDependencies;
	if (borrow === undefined) throw new TypeError("creator signing dependency owner is unavailable");
	return borrow(plane, trusts, prepareData);
}

/** Captures only the already-bound actor's native factories; never eligibility. */
export function captureCreatorCloseSigningRetirementOwners(plane: object): CreatorSigningRetirementOwners {
	const capture = creatorCloseReleaseOwner?.captureSigningRetirementOwners;
	if (capture === undefined) throw new TypeError("creator signing retirement owner is unavailable");
	return capture(plane);
}

/**
 * Releases receipt-covered installed-v3 predecessor retention.
 * @param value - Exact receipt pair and genuine current successor handle.
 * @returns Frozen success census or a closed fail-closed refusal.
 */
export function reclaimInstalledV3Runtime(value: unknown): Promise<D109dRuntimeReclamationResult> {
	const input = captureInput(value);
	if (input === undefined) return Promise.resolve(invalid());
	if (runtimeKernel === undefined) {
		return Promise.resolve(Object.freeze({ code: "D109D_INTERNAL_INVARIANT" as const, ok: false as const }));
	}
	try {
		return Promise.resolve(runtimeKernel.reclaim(input)).catch(() =>
			Object.freeze({ code: "D109D_INTERNAL_INVARIANT" as const, ok: false as const })
		);
	} catch {
		return Promise.resolve(Object.freeze({ code: "D109D_INTERNAL_INVARIANT" as const, ok: false as const }));
	}
}
