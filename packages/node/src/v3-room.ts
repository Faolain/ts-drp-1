import { CanonicalEncodingError, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { withAuthoredGenesisSigningRequest } from "@ts-drp/protocol-v3/internal/owned-signing-request";
import { CompactMerkleAccumulator } from "@ts-drp/compaction";
import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import type { EphemeralChannel, EphemeralChannelOptions } from "@ts-drp/ephemeral";
import { SETTLEMENT_REPLACEMENT_DIGEST_LIMITS, SETTLEMENT_REPLACEMENT_MAX_INTENTS } from "@ts-drp/issuance-store";
import { nativeIssuanceSignAdmissionForStore } from "@ts-drp/issuance-store/maintenance";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { createSnapshotChunkProtocolPort, CREATOR_SUCCESSOR_PROTOCOL } from "@ts-drp/network/snapshot-transfer";
import {
	captureCreatorSuccessorOffer,
	captureCreatorSuccessorPeers,
	createCreatorSuccessorMaterialServer,
	CreatorSuccessorExportUnavailable,
	creatorRecipientRetirementResumeRequested,
	type CreatorRecipientRecoveryContext,
	type CreatorSuccessorOffer,
	maintainCreatorRecipientRecoveryPool,
	readCreatorSuccessorExport,
	receiveCreatorSuccessorAdoption,
	selectRetainedCreatorSuccessorAdoption,
	verifyCreatorSuccessorAdoption,
} from "@ts-drp/node/creator-adoption";
import {
	activateCreatorSuccessorAdoption,
	reopenCreatorSuccessorAdoption,
} from "@ts-drp/node/creator-adoption-activate";
import {
	publishStagedCreatorSuccessorAdoption,
	stageCreatorSuccessorAdoption,
} from "@ts-drp/node/creator-adoption-stage";
import {
	bindCreatorLiveClose,
	maintainCreatorRecoveryPool,
	prepareCreatorOrdinaryReadiness,
	type BindCreatorLiveCloseInput,
	type CreatorRecoveryPoolResult,
	type CreatorLiveCloseHandle,
	type CreatorLiveCloseResult,
	type CreatorLiveCloseStatus,
} from "@ts-drp/node/creator-close";
import { consumeCreatorAdoptionPendingRecovery } from "@ts-drp/node/internal/creator-adoption-recover";
import { createV3SnapshotTransferOwner } from "@ts-drp/node/snapshot-transfer";
import {
	activateV3LivePlane,
	authorizeV3NewLocalOperation,
	bindV3BlueprintLivePlane,
	bindV3MissingDependencyRequest,
	deactivateV3LivePlaneJoined,
	prepareV3LiveGeneration,
	prepareV3TerminalMigrationSource,
	queryV3RetainedHashes,
	readV3ApplicationProjectionOrder,
	recoverV3LiveReplica,
	republishV3RetainedTo,
	requestV3RetainedRepair,
	routeV3Ingress,
	routeV3RetainedIngress,
	speculateV3IngressVertex,
	type V3AdmittedVertexSink,
	type V3ApplicationProjectionOrder,
	type V3LiveDescriptor,
	type V3LocalSettlementFloor,
	type V3LocalSettlementPolicy,
	type V3OperationAdmissionPolicy,
	type V3PlaneHandle,
	type V3RetainedHashPage,
	type V3RetainedHashQuery,
	type V3SettlementSourceSelectionApproval,
	type V3SettlementSourceSelectionRequest,
	type V3TerminalMigrationSource,
	withV3TerminalMigrationTargetFloor,
} from "@ts-drp/node/v3-live";
import {
	type AdmittedReceivedVertexView,
	authenticateCurrentEpochAnchor,
	createAdmissionBoundTransactionalVertexIssuer,
	installCreatorAnchorTrustRoot,
	prepareBlueprintAdmission,
	type SignRegisteredVertexDigest,
} from "@ts-drp/protocol-v3";
import { openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import { settlementProfileFor } from "@ts-drp/protocol-v3/settlement-profile";
import { type NativeReadReservation, parseStorageObjectId, type StorageObjectId } from "@ts-drp/storage";
import type {
	RoomHead as V3RoomHead,
	RoomHeadAuthority as V3RoomHeadAuthority,
	RoomHeadResult as V3RoomHeadAuthorityResult,
	RoomHeadInitialization as V3RoomHeadInitialization,
	RoomHeadScope as V3RoomHeadScope,
	RoomHeadState as V3RoomHeadState,
} from "@ts-drp/storage/room-head";
import type { DRPNetworkNode, Message } from "@ts-drp/types";

import { CREATOR_MAINTENANCE_PROOF_MAX_BYTES, createCreatorClosedRollbackProofAccounting, type CreatorLocalSessionWithdrawal } from "./internal/creator-closed-rollback-data.js";
import type { CreatorOrdinaryApplicationResourceBoundReader, CreatorOrdinaryFinishingWindowLimits } from "./internal/runtime-reclamation.js";
import {
	resolveRecoveryPoolAutoMaintenanceOptions,
	startRecoveryPoolAutoScheduler,
	type RecoveryPoolAutoMaintenanceOptions,
} from "./internal/recovery-pool-auto.js";
import { createScheduledRecoveryPoolLull } from "./internal/recovery-pool-scheduled.js";
import {
	attachPresentationIntents,
	createPresentationOverlay,
	type LocalPresentationHooks,
	type PresentationOverlay,
	type PresentationRow,
	type V3RoomPendingOperation,
	type V3RoomPresentationOptions,
	type V3RoomPresentationRollbackReason,
} from "./internal/presentation-overlay.js";
export type {
	V3RoomPendingOperation,
	V3RoomPresentationEvent,
	V3RoomPresentationOptions,
	V3RoomPresentationRollbackReason,
	V3RoomPresentationSource,
} from "./internal/presentation-overlay.js";
import {
	captureV3RoomStorageHost,
	type V3RoomStorageHost,
	type V3RoomLocalSessionLease,
	type V3RoomLocalSessionSelector,
} from "./v3-room-host.js";

const CREATOR_INVITE_KEYS = Object.freeze([
	"detachedGenesisSignature",
	"exactCanonicalLatchedAclBytes",
	"exactCanonicalGenesisAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"exactCanonicalProfileBytes",
	"exactCanonicalSignerSetBytes",
	"kind",
	"pinnedGenesisAnchorDigest",
	"version",
]);
const CREATOR_INVITE_BYTE_FIELDS = Object.freeze([
	"detachedGenesisSignature",
	"exactCanonicalLatchedAclBytes",
	"exactCanonicalGenesisAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"exactCanonicalProfileBytes",
	"exactCanonicalSignerSetBytes",
] as const);
const CREATOR_INVITE_MATERIAL_KEYS = Object.freeze([...CREATOR_INVITE_BYTE_FIELDS, "pinnedGenesisAnchorDigest"]);
const UNSUPPORTED_LINEAGE_POLICY = "D110C_LINEAGE_POLICY_UNSUPPORTED";
const SETTLEMENT_MANUAL_REVIEW_MESSAGE = "v3 room settlement plan requires manual review";
const settlementManualReviewErrors = new WeakSet<TypeError>();
// Object framing plus the nine encoded keys and the fixed kind, digest and version values.
// The retained exact 65_536/65_537 boundary pair pins this codec-specific arithmetic.
const CREATOR_INVITE_FIXED_CANONICAL_BYTE_LENGTH = 346;
const MIGRATION_RECORD_KEYS = Object.freeze([
	"applicationStateDigest",
	"archivePolicy",
	"authorityKind",
	"exactCanonicalApplicationStateBytes",
	"kind",
	"rehearsalNonce",
	"sourceAcceptedOperationCount",
	"sourceAcceptedOperationsDigest",
	"sourceAnchorDigest",
	"sourceBlueprintDigest",
	"sourceCreatorAuthor",
	"sourceObjectId",
	"targetAnchorDigest",
	"targetBlueprintDigest",
	"targetCreatorAuthor",
	"targetImportOperationCount",
	"targetImportOperationsDigest",
	"targetObjectId",
	"version",
]);
const MIGRATION_INHERITANCE_RECORD_KEYS = Object.freeze([
	...MIGRATION_RECORD_KEYS.map((key) => (key === "exactCanonicalApplicationStateBytes" ? "applicationState" : key)),
	"targetAclDigest",
	"targetEpoch",
]);

function migrationRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return exactRecord(value, MIGRATION_RECORD_KEYS) ?? exactRecord(value, MIGRATION_INHERITANCE_RECORD_KEYS);
}

function migrationRecordStateBytes(record: Readonly<Record<string, unknown>>): Uint8Array {
	return normalizeApplicationStateBytes(
		record.version === 2 ? encodeCanonical(record.applicationState) : record.exactCanonicalApplicationStateBytes,
		"migration"
	);
}
const MIGRATION_ACTIVATION_DECISION_KEYS = Object.freeze([
	"activationAuthority",
	"applicationStateDigest",
	"exactCanonicalTargetCreatorInviteBytes",
	"kind",
	"migrationRecordDigest",
	"migrationRecordVertexDigest",
	"rehearsalNonce",
	"sourceAcceptedOperationCount",
	"sourceAcceptedOperationsDigest",
	"sourceAnchorDigest",
	"sourceBlueprintDigest",
	"sourceCreatorAuthor",
	"sourceObjectId",
	"targetAnchorDigest",
	"targetBlueprintDigest",
	"targetCreatorAuthor",
	"targetImportOperationCount",
	"targetImportOperationsDigest",
	"targetObjectId",
	"version",
]);

type RoomTerminalVertexClassifier = (
	input: Readonly<{
		readonly author: string;
		readonly exactReceivedCanonicalPreimageBytes: Uint8Array;
		readonly signature: Uint8Array;
		readonly vertex: AdmittedReceivedVertexView;
	}>
) => "ordinary" | "terminal-authorized" | "reject";

type RoomPlaneHandle = V3PlaneHandle &
	Readonly<{
		beginTerminalTransition(): Promise<
			| Readonly<{
					readonly ok: true;
					readonly capability: Readonly<{
						publishTerminal(
							input: Readonly<{
								readonly operations: readonly Readonly<{
									readonly logicalTime: number;
									readonly operation: Readonly<Record<string, unknown>>;
								}>[];
								readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
							}>
						): Promise<
							| Readonly<{
									readonly ok: true;
									readonly digest: string;
							  }>
							| Readonly<{
									readonly ok: false;
									readonly kind: string;
									readonly terminalIntent: "absent" | "outcome-unknown";
							  }>
						>;
						resume(): Readonly<{ readonly ok: boolean }>;
					}>;
			  }>
			| Readonly<{ readonly ok: false; readonly kind: string }>
		>;
	}>;

function requiredIntrinsicGetter(prototype: object, property: string): (this: unknown) => unknown {
	const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get;
	if (getter === undefined) throw new TypeError(`required intrinsic getter is unavailable: ${property}`);
	return getter;
}

const INTRINSIC_ARRAY_BUFFER = ArrayBuffer;
const INTRINSIC_ARRAY_BUFFER_PROTOTYPE = ArrayBuffer.prototype;
const INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH_GETTER = requiredIntrinsicGetter(
	INTRINSIC_ARRAY_BUFFER_PROTOTYPE,
	"byteLength"
);
const INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER = Object.getOwnPropertyDescriptor(
	INTRINSIC_ARRAY_BUFFER_PROTOTYPE,
	"resizable"
)?.get;
const INTRINSIC_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const INTRINSIC_UINT8_ARRAY = Uint8Array;
const INTRINSIC_UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const INTRINSIC_UINT8_ARRAY_SET = Uint8Array.prototype.set;
const INTRINSIC_TYPED_ARRAY_PROTOTYPE = INTRINSIC_GET_PROTOTYPE_OF(INTRINSIC_UINT8_ARRAY_PROTOTYPE) as object;
const INTRINSIC_TYPED_ARRAY_BUFFER_GETTER = requiredIntrinsicGetter(INTRINSIC_TYPED_ARRAY_PROTOTYPE, "buffer");
const INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER = requiredIntrinsicGetter(INTRINSIC_TYPED_ARRAY_PROTOTYPE, "byteLength");
const INTRINSIC_TYPED_ARRAY_BYTE_OFFSET_GETTER = requiredIntrinsicGetter(INTRINSIC_TYPED_ARRAY_PROTOTYPE, "byteOffset");

function canonicalVarUintByteLength(value: number): number {
	let width = 1;
	let remaining = value;
	while (remaining >= 128) {
		width += 1;
		remaining = Math.floor(remaining / 128);
	}
	return width;
}

export interface V3RoomCreatorInviteMaterial {
	readonly detachedGenesisSignature: Uint8Array;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalGenesisAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly pinnedGenesisAnchorDigest: string;
}

type GenesisAnchorSigner = (digest: Uint8Array) => Promise<Uint8Array>;

export interface V3RoomCreatorInviteMaterialInput {
	readonly blueprintDigest: string;
	readonly exactCanonicalApplicationStateBytes: Uint8Array;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	/**
	 * The signed trust profile, latched for the room's life. Use `creator-trusted-settlement-v1`
	 * (with a version-3 latched ACL): its settlement lets retirement drain old issued rows. The
	 * legacy `creator-trusted-v1` has no settlement and keeps every issued row, so a Writer's
	 * issuance store, seal time and per-move work grow with room age, and at high move rates a
	 * creator's move is eventually refused when its issuance maintenance proof reserve runs out.
	 */
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly objectId: string;
	readonly signGenesisAnchorDigest?: GenesisAnchorSigner;
	/** Explicit account creation owner; never an invite-derived freshness decision. */
	readonly ownedGenesis?: Readonly<{ lease: V3RoomLocalSessionLease; roomHeadAuthority: V3RoomHeadAuthority }>;
}

export type V3RoomAcceptedVertex = AdmittedReceivedVertexView;

export interface V3RoomAcceptedOperation {
	readonly author: string;
	readonly authorSequence: number;
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
	readonly operationCount: number;
	readonly operationIndex: number;
	readonly vertexDigest: string;
}

export interface V3RoomProjectionAuthority {
	readonly transportPeerAuthors: readonly Readonly<{ readonly author: string; readonly peerId: string }>[];
	readonly writerAuthors: readonly string[];
}

export interface V3RoomSuccessorAuthority {
	readonly aclDigest: string;
	readonly anchorDigest: string;
	readonly epoch: number;
	readonly genesisAnchorDigest: string;
	readonly lifecycle: "active";
	readonly objectId: string;
	readonly profileId: "creator-trusted-v1";
}

export type {
	V3RoomHead,
	V3RoomHeadAuthority,
	V3RoomHeadAuthorityResult,
	V3RoomHeadInitialization,
	V3RoomHeadScope,
	V3RoomHeadState,
};

export interface V3RoomMigrationProjection {
	readonly exactCanonicalApplicationStateBytes: Uint8Array;
	readonly importOperations: readonly Readonly<Record<string, unknown>>[];
}

export interface V3RoomMigrationCapability<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	/** Inherit exact creator-authenticated state through the signed migration record, not ordinary import admission. */
	readonly inheritAuthenticatedState?: true;
	/** Recognize exact historical work only within already authenticated inherited state. */
	containsInheritedOperation?(
		operation: Readonly<Record<string, unknown>>,
		exactCanonicalStateBytes: Uint8Array,
		context?: Readonly<{ sourceAuthor: string }>
	): boolean;
	canonicalStateBytes(projection: Projection): Uint8Array;
	prepare(
		accepted: readonly V3RoomAcceptedOperation[],
		exactCanonicalSourceStateBytes?: Uint8Array
	): V3RoomMigrationProjection;
}

export interface V3RoomMigrationRehearsalInput {
	readonly rehearsalNonce: Uint8Array;
	readonly targetCreatorInvite: string | V3RoomCreatorInviteMaterial;
}

export interface V3RoomMigrationRehearsalReceipt {
	readonly activated: false;
	readonly applicationStateDigest: string;
	readonly exactCanonicalRecordBytes: Uint8Array;
	readonly importedOperationCount: number;
	readonly recordDigest: string;
	readonly recordVertexDigest: string;
	readonly targetAnchorDigest: string;
}

export interface V3RoomMigrationActivationInput {
	readonly exactCanonicalRecordBytes: Uint8Array;
	readonly recordVertexDigest: string;
	readonly targetCreatorInvite: string | V3RoomCreatorInviteMaterial;
}

export interface V3RoomMigrationActivationReceipt {
	readonly activated: true;
	readonly activationDecisionDigest: string;
	readonly activationVertexDigest: string;
	readonly targetAnchorDigest: string;
}

export interface V3RoomEphemeralAuthorizationProvider {
	authorForPeer(peerId: string): string | undefined;
	currentAuthority():
		| Readonly<{
				readonly aclDigest: string;
				readonly anchorDigest: string;
				readonly epoch: number;
				readonly objectId: string;
		  }>
		| undefined;
	isCurrentWriter(author: string): boolean;
}

export interface V3RoomTransport {
	readonly networkNode: DRPNetworkNode;
	close(): void | Promise<void>;
	openEphemeral(provider: V3RoomEphemeralAuthorizationProvider, options: EphemeralChannelOptions): EphemeralChannel;
	requestRetainedHistory(): void;
	/**
	 * Optional: ask the creator for its retained history now, rate limited by the transport.
	 * The room asks when a received vertex waits for a missing dependency and after it
	 * installs a successor. A no-op on the creator and after close; it must not throw.
	 */
	requestMissingRetainedHistory?(): void;
	setIngressHandler(
		ingressId: string,
		liveHandler: (message: Message) => void,
		retainedHandler: (message: Message) => void
	): void;
	setRetainedPublisher(publisher: (targetPeerId?: string) => Promise<void>): void;
	/** Local health observation only; never portable admission or convergence authority. */
	setControlPlaneObservationProvider?(
		provider: () =>
			| Readonly<{
					objectId: string;
					epoch: number;
					anchorDigest: string;
					aclDigest: string;
					authenticatedPeerIds: readonly string[];
					localState: "installed" | "transitioning";
			  }>
			| undefined
	): void;
	requestSettlementSourceAuthorization?(
		request: Readonly<{ exactCanonicalSelectionBytes: Uint8Array; digest: Uint8Array }>,
		options?: Readonly<{ signal?: AbortSignal }>
	): Promise<Uint8Array>;
	setSettlementSourceAuthorizer?(
		authorizer: (
			request: Readonly<{
				exactCanonicalSelectionBytes: Uint8Array;
				digest: Uint8Array;
				authenticatedRequesterPeerId: string;
				signal: AbortSignal;
			}>
		) => Promise<Uint8Array>
	): void;
}

export interface V3RoomApplication<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	/** Optional pure, artifact-bound LOCAL planning bound. Undefined retains the
	 * exact original forecast; this is not shared operation validity/admission. */
	readonly readOrdinaryApplicationResourceBound?: CreatorOrdinaryApplicationResourceBoundReader;
	/** Local capacity ceilings, not an acceptance promise. Explicit preparation
	 * may certify a smaller window; ordinary calls meter that window and refuse
	 * before effects when exhausted. A synchronous selector runs only when a
	 * genuine epoch is bound/reopened, never on ordinary calls; its result is
	 * captured by that close owner. Does not alter authenticated validity. */
	readonly ordinaryFinishingWindow?: CreatorOrdinaryFinishingWindowLimits | ((context: Readonly<{
		objectId: string; epoch: number;
	}>) => CreatorOrdinaryFinishingWindowLimits);
	/** Requester access only; snapshot sources and application writes remain separately authenticated. */
	readonly snapshotReadPolicy?: "authenticated-public" | "current-writers";
	readonly batchableOperationActions: readonly string[];
	readonly bootstrapOperation: Readonly<Record<string, unknown>>;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: Parameters<typeof prepareV3LiveGeneration>[0]["catalog"];
	/** Reconstruct NEW signed genesis only; authenticated inherited state remains separately owned by migration. */
	createGenesisApplicationStateBytes?(
		context: Readonly<{ objectId: string; exactCanonicalLatchedAclBytes: Uint8Array }>
	): Uint8Array;
	displacedOperationIdentity(operation: Readonly<Record<string, unknown>>): string;
	readonly displacementPolicies: Readonly<Record<string, "expire" | "manual-review" | "rebase" | "transform">>;
	readonly migration?: V3RoomMigrationCapability<Projection>;
	/** Throw a direct TypeError only when authenticated product fields are invalid. */
	projectAcceptedOperations(input: V3RoomProjectionInput): Projection;
	transformDisplacedOperation?(operation: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
}

export interface V3RoomAuthenticatedProjectionBase {
	readonly blueprintDigest: string;
	readonly epoch: number;
	readonly exactCanonicalApplicationStateBytes: Uint8Array;
	readonly objectId: string;
	readonly stateDigest: string;
}

export interface V3RoomProjectionInput {
	readonly authenticatedBase: V3RoomAuthenticatedProjectionBase | undefined;
	readonly currentEpochOperations: readonly V3RoomAcceptedOperation[];
}

export interface CreateV3RoomSessionInput<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	/** Narrows local custody; does not grant operation or portable wire authority. */
	readonly receiveOnly?: true;
	readonly storageHost: V3RoomStorageHost;
	readonly application: V3RoomApplication<Projection>;
	readonly author: string;
	readonly creatorFinalitySigner?: BindCreatorLiveCloseInput["signer"];
	/** Exclusive local archive custody for this exact session scope; not portable authority.
	 * The room joins admitted work and closes the returned store at shutdown. */
	openCreatorArchive?(
		scope: Readonly<{ databaseName: string; objectId: string; pinnedGenesisAnchorDigest: string }>
	): Promise<NonNullable<BindCreatorLiveCloseInput["archive"]>>;
	readonly creatorInvite: string | V3RoomCreatorInviteMaterial;
	/** Explicit fixed-creator signature over the exact source/target request; independently verified by the source owner. */
	authorizeSettlementSource?(
		request: Readonly<{ exactCanonicalSelectionBytes: Uint8Array; digest: Uint8Array }>
	): Promise<Uint8Array>;
	/** Explicit decision only: this callback must settle when cancellationSignal aborts. */
	approveSettlementSourceSelection?(request: V3SettlementSourceSelectionApproval): Promise<boolean>;
	createOperationAdmissionPolicy?(
		context: Readonly<{
			readonly aclDigest: string;
			readonly anchorDigest: string;
			readonly epoch: number;
			readonly objectId: string;
			readonly authenticatedApplicationStateBytes?: Uint8Array;
			readonly authenticatedClosedApplicationStateBytes?: Uint8Array;
			readonly exactCanonicalLatchedAclBytes?: Uint8Array;
			readonly authenticatedSettlementFrontiers?: readonly (readonly [
				author: string,
				admissionEpoch: number,
				terminalThrough: number | null,
			])[];
		}>
	): V3OperationAdmissionPolicy;
	readonly databaseName: string;
	readonly initialLogicalTime: number;
	readonly issuanceDatabaseName: string;
	readonly migrationDatabaseNamespace?: string;
	readonly objectId: string;
	openTransport(objectId: string): V3RoomTransport;
	/**
	 * Authenticated replayable notification attempt, not an exactly-once external commit.
	 * Persistent consumers deduplicate side effects by authenticated vertex digest.
	 * Rejection fails the current session closed; failure, crash or cold reopen may replay notifications.
	 */
	onAcceptedVertex(vertex: AdmittedReceivedVertexView): void | Promise<void>;
	onMigrationTarget?(session: V3RoomSession<Projection>, objectId: string): void;
	onProjection(projection: Projection): void;
	readonly publicKeyBytes: Uint8Array;
	readonly rebaseSourceInvite?: string | V3RoomCreatorInviteMaterial;
	/** Original host custody for an invite-authorized same-object rebase; names/floors grant no protocol permission. */
	readonly rebaseSourceStorage?: Readonly<{ databaseName: string; roomHeadAuthority: V3RoomHeadAuthority }>;
	readonly roomHeadAuthority: V3RoomHeadAuthority;
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
	/**
	 * Opt-in automatic `maintainRecoveryPool()` at observed idle lulls (creator
	 * only). Activity resets the idle clock and busy results back off; the next
	 * seal keeps its inline maintenance as the hard-cap backstop. Moves that
	 * arrive while it runs wait and are admitted right after it; none are dropped.
	 */
	readonly recoveryPoolAutoMaintenance?: RecoveryPoolAutoMaintenanceOptions;
	/**
	 * Opt-in: run `maintainRecoveryPool()` once per epoch, queued in the lifecycle FIFO
	 * right after this session's creator adoption or recipient install (receive-only
	 * included), before any later transition. No idle trigger. A later lull call in an
	 * epoch whose lull settled gets that result without a second lull, and the idle
	 * scheduler skips that epoch. The browser binding enables it for new rooms on the
	 * room database with retention. The next seal keeps its inline maintenance as the
	 * hard-cap backstop. Moves that arrive while it runs wait and are admitted right
	 * after it; none are dropped.
	 */
	readonly recoveryPoolScheduledLull?: boolean;
	/**
	 * Opt-in speculative presentation: local moves show at once, remote moves
	 * show once authenticated (signature + current Writer), both before durable
	 * admission. Memory-only and display-only; projection() stays authoritative.
	 */
	readonly presentation?: V3RoomPresentationOptions<Projection>;
}

export interface V3RoomIssueReceipt {
	/**
	 * Settles when the move is first shown, or with undefined when the move was
	 * not speculated (outside `speculate`, or overlay full) and issue() completed.
	 * Rejects if it rolls back first.
	 */
	readonly visible: Promise<V3RoomPendingOperation | undefined>;
	/** Settles atomically with the durable projection that contains it (undefined as for `visible`). */
	readonly durable: Promise<Readonly<{ vertexDigest: string; authorSequence: number }> | undefined>;
	readonly published: Promise<void>;
}

export interface V3RoomSession<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	/** Ordinary close retains custody; explicit retirement permanently abandons this local incarnation only. */
	readonly localSession?: Readonly<{ selector: V3RoomLocalSessionSelector; retire(): Promise<void> }>;
	readonly invite: string;
	readonly objectId: string;
	readonly roomId: string;
	readonly trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.";
	adoptCreatorSuccessor(): Promise<void>;
	authorizeSettlementSourceSelection(request: V3SettlementSourceSelectionRequest): Promise<Uint8Array>;
	exportCreatorSuccessor(): Promise<CreatorSuccessorOffer>;
	installCreatorSuccessor(input: Readonly<{ offer: CreatorSuccessorOffer; peers: readonly string[] }>): Promise<void>;
	promoteCreatorCheckpoint(input: Readonly<{ closedEpoch: number }>): Promise<void>;
	authority(): V3RoomSuccessorAuthority | null;
	close(): Promise<void>;
	/** Physical peers on this live room topic; routing presence is not protocol authority. */
	connectedPeers(): readonly string[];
	/** Explicit retained-window coverage; continuation metadata grants no authority. */
	queryRetainedHashes(input: V3RetainedHashQuery): Promise<V3RetainedHashPage>;
	/** Scheduling acknowledgement, not a claim that peers have converged. */
	requestRetainedRepair(input?: Readonly<{ targetPeerId?: string }>): Promise<Readonly<{ kind: "scheduled" }>>;
	activateMigration(input: V3RoomMigrationActivationInput): Promise<V3RoomMigrationActivationReceipt>;
	inspectDurableHead(): ReturnType<CreatorLiveCloseHandle["inspectDurableHead"]>;
	issue(operation: Readonly<Record<string, unknown>>): Promise<void>;
	/**
	 * Opt-in (`presentation`) staged issue: `visible` settles once the move is in
	 * speculativeProjection(), `durable` once the durable projection contains it,
	 * `published` exactly when issue() would. A refused move rejects `durable` and
	 * `published` and rolls back with a reason; the durable path is unchanged.
	 */
	issueWithReceipt(operation: Readonly<Record<string, unknown>>): V3RoomIssueReceipt;
	openEphemeral(options: EphemeralChannelOptions): EphemeralChannel;
	/**
	 * Opt-in: sends display-only intents for local pending moves on an authenticated
	 * ephemeral channel and shows peers' intents as pending. Intents carry no
	 * signature and can never become vertices; they expire or yield to the signed move.
	 */
	bindPresentationIntents(channel: EphemeralChannel, options?: Readonly<{ key?: string }>): () => void;
	/** Memory-only pending moves in speculative order; empty without `presentation`. */
	pendingOperations(): readonly V3RoomPendingOperation[];
	previewLatchedAcl(): Readonly<Record<string, unknown>>;
	projection(): Projection;
	/**
	 * Display-only view: projection() followed by memory-only pending moves.
	 * It never feeds admission, ACL, ephemeral or seal authority, and it is the
	 * same object as projection() whenever nothing is pending.
	 */
	speculativeProjection(): Projection;
	rehearseMigration(input: V3RoomMigrationRehearsalInput): Promise<V3RoomMigrationRehearsalReceipt>;
	/**
	 * Optional early bounded-recovery turnover at a caller-chosen lull (soft
	 * watermark). It starts only on a quiescent room (no pending remote ingress)
	 * and otherwise reports `deferred`. Local issues and remote moves arriving
	 * while it runs wait in order and are admitted right after it with the full
	 * original checks. The next seal keeps its inline maintenance as backstop.
	 */
	maintainRecoveryPool(): Promise<CreatorRecoveryPoolResult>;
	sealEpoch(): Promise<CreatorLiveCloseResult>;
	status(): CreatorLiveCloseStatus;
}

export type CreateV3LocalRoomSessionInput<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> =
	Omit<CreateV3RoomSessionInput<Projection>, "storageHost" | "author" | "publicKeyBytes" | "creatorFinalitySigner" | "signRegisteredVertexDigest"> & Readonly<{
		localSession: Readonly<{
			/** Acquire before authenticated application/ACL enrollment, then hand
			 * the exact lease to the existing room owner. Root/account freshness
			 * remains in required external roomHeadAuthority, never this slot. */
			lease: V3RoomLocalSessionLease;
		}>;
	}>;

interface LocalRoomAcquisitionOwner {
	readonly lease: V3RoomLocalSessionLease;
	readonly control: NonNullable<V3RoomSession["localSession"]>;
	assertCurrent(): void;
	closeRoot?: () => Promise<void>;
	closed: boolean;
	closeTask?: Promise<void>;
	bindingDigest?: Uint8Array;
	prepareTerminal?: () => Promise<CreatorLocalSessionWithdrawal>;
	retireTask?: Promise<void>;
}

const startupWaitersForDiagnostics = new WeakMap<V3RoomSession, () => Promise<void>>();

/**
 * Waits for this session's original startup recovery, not later queue quiescence.
 * @param session
 */
export async function waitForV3RoomStartupForDiagnostics(session: V3RoomSession): Promise<void> {
	const wait = startupWaitersForDiagnostics.get(session);
	if (wait === undefined) throw new TypeError("v3 room diagnostic session is unknown");
	await wait();
}

const CREATOR_LOCAL_AVAILABILITY_POLICY_BYTES = encodeCanonical({
	minLocalCopies: 1,
	minMirrorReceipts: 0,
	minRollbackGenerations: 2,
	mode: "local-only",
});

function unavailableCreatorCloseStatus(
	trustProfile: V3LiveDescriptor["trustProfile"],
	continuity: CreatorLiveCloseStatus["continuity"] = "continuous"
): CreatorLiveCloseStatus {
	if (trustProfile !== "creator-only") throw new TypeError("v3 room creator trust profile is unavailable");
	return Object.freeze({
		closeAuthority: "unavailable" as const,
		continuity,
		lifecycle: "active" as const,
		trust: Object.freeze({
			byzantineFaultTolerant: false as const,
			kind: "creator-certified" as const,
			quorum: 1 as const,
			signerCount: 1 as const,
			text: "Creator-certified; one of one; not Byzantine-fault-tolerant." as const,
		}),
	});
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string): Uint8Array {
	if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
		throw new TypeError("v3 room hex value is invalid");
	}
	return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

/**
 * Joins native historical readers owned by one received adoption attempt.
 * @param received
 * @param operation
 */
async function withCreatorReceivedPromotionDependencies<T>(
	received: Readonly<{ releasePromotionDependencies?(): Promise<void> }>,
	operation: () => Promise<T>
): Promise<T> {
	let failed = false;
	let primary: unknown;
	try {
		return await operation();
	} catch (error) {
		failed = true;
		primary = error;
		throw error;
	} finally {
		await releaseCreatorReceivedPromotionDependencies(received, failed, primary);
	}
}

async function releaseCreatorReceivedPromotionDependencies(
	received: Readonly<{ releasePromotionDependencies?(): Promise<void> }>,
	failed: boolean,
	primary: unknown
): Promise<void> {
	try {
		await received.releasePromotionDependencies?.();
	} catch (cleanupError) {
		if (failed)
			throw new AggregateError([primary, cleanupError], "v3 room received promotion cleanup failed", {
				cause: primary,
			});
		throw cleanupError;
	}
}

function successorAuthority(trust: unknown, handle: RoomPlaneHandle): V3RoomSuccessorAuthority {
	if (trust === null || typeof trust !== "object" || Array.isArray(trust)) {
		throw new TypeError("v3 room successor trust is invalid");
	}
	const current = handle.currentEphemeralAuthority();
	const currentAnchorDigest = Reflect.get(trust, "currentAnchorDigest");
	const currentEpoch = Reflect.get(trust, "currentEpoch");
	const genesisAnchorDigest = Reflect.get(trust, "genesisAnchorDigest");
	const objectId = Reflect.get(trust, "objectId");
	const profileId = Reflect.get(trust, "profileId");
	if (
		current === undefined ||
		typeof current.aclDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(current.aclDigest) ||
		typeof currentAnchorDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(currentAnchorDigest) ||
		typeof currentEpoch !== "number" ||
		!Number.isSafeInteger(currentEpoch) ||
		currentEpoch < 1 ||
		typeof genesisAnchorDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(genesisAnchorDigest) ||
		typeof objectId !== "string" ||
		(profileId !== "creator-trusted-v1" &&
			(typeof profileId !== "string" || settlementProfileFor(profileId) === "none")) ||
		current.anchorDigest !== currentAnchorDigest ||
		current.epoch !== currentEpoch ||
		current.objectId !== objectId
	) {
		throw new TypeError("v3 room successor authority differs");
	}
	return Object.freeze({
		aclDigest: current.aclDigest,
		anchorDigest: currentAnchorDigest,
		epoch: currentEpoch,
		genesisAnchorDigest,
		lifecycle: "active" as const,
		objectId,
		profileId,
	});
}

function digest(domain: string, value: Uint8Array): string {
	return hex(hashDomain(domain, value));
}

function strictDetachedBytes(value: unknown, name: string, expectedLength?: number): Uint8Array {
	let backing: unknown;
	let backingByteLength: unknown;
	let byteLength: unknown;
	let byteOffset: unknown;
	let resizable = false;
	try {
		backing = Reflect.apply(INTRINSIC_TYPED_ARRAY_BUFFER_GETTER, value, []);
		backingByteLength = Reflect.apply(INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH_GETTER, backing, []);
		byteLength = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
		byteOffset = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_OFFSET_GETTER, value, []);
		if (INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER !== undefined) {
			resizable = Reflect.apply(INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER, backing, []) === true;
		}
	} catch {
		throw new TypeError(`${name} must be an ordinary detached Uint8Array`);
	}
	if (
		INTRINSIC_GET_PROTOTYPE_OF(value) !== INTRINSIC_UINT8_ARRAY_PROTOTYPE ||
		!(backing instanceof INTRINSIC_ARRAY_BUFFER) ||
		INTRINSIC_GET_PROTOTYPE_OF(backing) !== INTRINSIC_ARRAY_BUFFER_PROTOTYPE ||
		resizable ||
		byteOffset !== 0 ||
		typeof byteLength !== "number" ||
		byteLength !== backingByteLength ||
		(expectedLength !== undefined && byteLength !== expectedLength)
	) {
		throw new TypeError(`${name} must be an ordinary detached Uint8Array`);
	}
	const output = new INTRINSIC_UINT8_ARRAY(byteLength);
	Reflect.apply(INTRINSIC_UINT8_ARRAY_SET, output, [new INTRINSIC_UINT8_ARRAY(backing, 0, byteLength)]);
	return output;
}

function strictCanonicalBytes(value: unknown, name: string): Uint8Array {
	const output = strictDetachedBytes(value, name);
	if (output.byteLength === 0 || output.byteLength > 65_536) throw new TypeError(`${name} is invalid`);
	let decoded: unknown;
	try {
		decoded = decodeCanonical(output, { maxBytes: 65_536, maxDepth: 16, maxItems: 16_384 });
	} catch {
		throw new TypeError(`${name} is invalid`);
	}
	if (!sameBytes(encodeCanonical(decoded), output)) throw new TypeError(`${name} is not canonical`);
	return output;
}

function normalizeApplicationStateBytes(value: unknown, purpose: "genesis" | "migration"): Uint8Array {
	let backing: unknown;
	let backingByteLength: unknown;
	let byteLength: unknown;
	let byteOffset: unknown;
	let resizable = false;
	try {
		backing = Reflect.apply(INTRINSIC_TYPED_ARRAY_BUFFER_GETTER, value, []);
		backingByteLength = Reflect.apply(INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH_GETTER, backing, []);
		byteLength = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
		byteOffset = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_OFFSET_GETTER, value, []);
		if (INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER !== undefined) {
			resizable = Reflect.apply(INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER, backing, []) === true;
		}
	} catch {
		throw new TypeError(`v3 room ${purpose} state is invalid`);
	}
	if (
		INTRINSIC_GET_PROTOTYPE_OF(value) !== INTRINSIC_UINT8_ARRAY_PROTOTYPE ||
		!(backing instanceof INTRINSIC_ARRAY_BUFFER) ||
		INTRINSIC_GET_PROTOTYPE_OF(backing) !== INTRINSIC_ARRAY_BUFFER_PROTOTYPE ||
		resizable ||
		byteOffset !== 0 ||
		typeof byteLength !== "number" ||
		byteLength !== backingByteLength
	) {
		throw new TypeError(`v3 room ${purpose} state is invalid`);
	}
	const exactState = new INTRINSIC_UINT8_ARRAY(byteLength);
	Reflect.apply(INTRINSIC_UINT8_ARRAY_SET, exactState, [new INTRINSIC_UINT8_ARRAY(backing, byteOffset, byteLength)]);
	if (exactState.byteLength > 32_768) throw new TypeError(`v3 room ${purpose} state is unbounded`);
	let decodedState: unknown;
	try {
		decodedState = decodeCanonical(exactState, { maxBytes: 32_768, maxDepth: 16, maxItems: 16_384 });
	} catch {
		throw new TypeError(`v3 room ${purpose} state is invalid`);
	}
	if (!sameBytes(encodeCanonical(decodedState), exactState)) {
		throw new TypeError(`v3 room ${purpose} state is not canonical`);
	}
	if (
		purpose === "genesis" &&
		decodedState !== null &&
		typeof decodedState === "object" &&
		!Array.isArray(decodedState) &&
		Object.hasOwn(decodedState, "context")
	) {
		throw new TypeError("v3 room genesis state contains replica-local context");
	}
	return exactState;
}

function encodeCreatorInvite(material: V3RoomCreatorInviteMaterial): string {
	return hex(
		encodeCanonical(
			{
				detachedGenesisSignature: material.detachedGenesisSignature,
				exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
				exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
				exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
				exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
				exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
				kind: "ts-drp-example-v3-room-creator-invite",
				pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
				version: 1,
			},
			{ maxBytes: 65_536, maxDepth: 4, maxItems: 128 }
		)
	);
}

function assertSupportedGenesisLineagePolicy(exactCanonicalParametersCarrierBytes: Uint8Array): void {
	const parameters = decodeCanonical(exactCanonicalParametersCarrierBytes);
	if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) return;
	if (!Object.hasOwn(parameters, "lineagePolicy")) return;
	const lineagePolicy = (parameters as Readonly<Record<string, unknown>>).lineagePolicy;
	if (lineagePolicy === null || typeof lineagePolicy !== "object" || Array.isArray(lineagePolicy)) {
		throw new TypeError("v3 room genesis lineage policy is invalid");
	}
	const mode = (lineagePolicy as Readonly<Record<string, unknown>>).mode;
	if (mode === "fixed-creator") return;
	if (mode === "ephemeral-chain" || mode === "durable-pinned" || mode === "durable-recursive") {
		throw new TypeError(UNSUPPORTED_LINEAGE_POLICY);
	}
	throw new TypeError("v3 room genesis lineage policy is invalid");
}

function inviteBytes(values: Record<string, unknown>, field: string): Uint8Array {
	const value = values[field];
	if (!(value instanceof Uint8Array) || value.byteLength === 0) {
		throw new TypeError(`v3 room creator invite ${field} is invalid`);
	}
	return new Uint8Array(value);
}

function decodeCreatorInvite(invite: string): V3RoomCreatorInviteMaterial {
	// Refuse before converting an untrusted hex string into an allocated byte array.
	if (typeof invite !== "string" || invite.length === 0 || invite.length > 131_072) {
		throw new TypeError("v3 room creator invite size is invalid");
	}
	const encoded = bytes(invite);
	const decoded = decodeCanonical(encoded, { maxBytes: 65_536, maxDepth: 4, maxItems: 128 });
	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Object.getPrototypeOf(decoded) !== null ||
		!sameBytes(encodeCanonical(decoded), encoded)
	) {
		throw new TypeError("v3 room creator invite is invalid");
	}
	const keys = Reflect.ownKeys(decoded);
	if (
		keys.length !== CREATOR_INVITE_KEYS.length ||
		keys.some((key) => typeof key !== "string" || !CREATOR_INVITE_KEYS.includes(key))
	) {
		throw new TypeError("v3 room creator invite fields are invalid");
	}
	const record = decoded as Record<string, unknown>;
	const values = Object.fromEntries(
		CREATOR_INVITE_KEYS.map((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(record, key);
			if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
				throw new TypeError("v3 room creator invite field ownership is invalid");
			}
			return [key, descriptor.value] as const;
		})
	) as Record<(typeof CREATOR_INVITE_KEYS)[number], unknown>;
	if (values.kind !== "ts-drp-example-v3-room-creator-invite" || values.version !== 1) {
		throw new TypeError("v3 room creator invite version is invalid");
	}
	if (
		typeof values.pinnedGenesisAnchorDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(values.pinnedGenesisAnchorDigest)
	) {
		throw new TypeError("v3 room creator invite anchor is invalid");
	}
	const detachedGenesisSignature = inviteBytes(values, "detachedGenesisSignature");
	if (detachedGenesisSignature.byteLength !== 64) {
		throw new TypeError("v3 room creator invite signature is invalid");
	}
	const exactCanonicalParametersCarrierBytes = inviteBytes(values, "exactCanonicalParametersCarrierBytes");
	assertSupportedGenesisLineagePolicy(exactCanonicalParametersCarrierBytes);
	return Object.freeze({
		detachedGenesisSignature,
		exactCanonicalLatchedAclBytes: inviteBytes(values, "exactCanonicalLatchedAclBytes"),
		exactCanonicalGenesisAnchorPreimageBytes: inviteBytes(values, "exactCanonicalGenesisAnchorPreimageBytes"),
		exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes: inviteBytes(values, "exactCanonicalProfileBytes"),
		exactCanonicalSignerSetBytes: inviteBytes(values, "exactCanonicalSignerSetBytes"),
		pinnedGenesisAnchorDigest: values.pinnedGenesisAnchorDigest,
	});
}

function authenticateCreatorInviteMaterial(
	material: V3RoomCreatorInviteMaterial,
	application: Pick<V3RoomApplication, "catalog" | "canonicalBlueprintPackageBytes">
): Readonly<{ readonly objectId: string; readonly blueprintDigest: string }> {
	// Reuse the protocol's genuine signature/pin/profile owner without installing
	// anything in a native store. This local trust object never leaves this check.
	const installed = installCreatorAnchorTrustRoot({
		detachedGenesisSignature: material.detachedGenesisSignature,
		exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
		exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
		pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
	});
	if (!installed.ok) throw new TypeError(`v3 room creator invite authentication failed: ${installed.reason}`);
	const authenticated = authenticateCurrentEpochAnchor({
		detachedSignature: material.detachedGenesisSignature,
		exactCanonicalAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
		trust: installed.trust,
	});
	if (!authenticated.ok) throw new TypeError(`v3 room creator invite authentication failed: ${authenticated.reason}`);
	const { provenance } = authenticated;
	const parameters = strictCanonicalBytes(material.exactCanonicalParametersCarrierBytes, "creator invite parameters");
	if (digest("ts-drp/parameters/v3", parameters) !== provenance.parametersDigest) {
		throw new TypeError("v3 room creator invite parameters are invalid");
	}
	const anchor = decodeCanonical(material.exactCanonicalGenesisAnchorPreimageBytes);
	const acl = openCanonicalLatchedAclSnapshot({
		exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
		expectedAclDigest: Reflect.get(anchor as object, "aclDigest") as string,
		expectedEpoch: provenance.epoch,
		expectedObjectId: provenance.objectId,
		expectedProfileId: installed.trust.profileId,
	});
	if (!acl.ok) throw new TypeError(`v3 room creator invite ACL is invalid: ${acl.reason}`);
	const resolved = application.catalog.resolve(provenance.blueprintDigest);
	if (
		resolved.blueprintDigest !== provenance.blueprintDigest ||
		!sameBytes(resolved.canonicalBlueprintPackageBytes, application.canonicalBlueprintPackageBytes)
	) {
		throw new TypeError("v3 room creator invite application is invalid");
	}
	prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes: application.canonicalBlueprintPackageBytes,
		expectedBlueprintDigest: provenance.blueprintDigest,
	});
	return Object.freeze({ objectId: provenance.objectId, blueprintDigest: provenance.blueprintDigest });
}

/**
 * Authenticates a bounded signed invite against a host-registered application before host acquisition.
 * Does not authorize writes, establish freshness or replace native open/recovery checks.
 * @param input - Exact wire invite and trusted local catalog/package selection.
 * @returns Detached authenticated identity metadata, not a portable authority capability.
 */
export function authenticateV3RoomCreatorInvite(
	input: Readonly<{
		readonly creatorInvite: string;
		readonly application: Pick<V3RoomApplication, "catalog" | "canonicalBlueprintPackageBytes">;
	}>
): Readonly<{
	readonly objectId: string;
	readonly blueprintDigest: string;
	readonly creatorInvite: string;
	readonly pinnedGenesisAnchorDigest: string;
}> {
	const record = exactRecord(input, ["application", "creatorInvite"]);
	if (
		record === undefined ||
		typeof record.creatorInvite !== "string" ||
		record.application === null ||
		typeof record.application !== "object"
	) {
		throw new TypeError("v3 room creator invite authentication input is invalid");
	}
	const material = decodeCreatorInvite(record.creatorInvite);
	const identity = authenticateCreatorInviteMaterial(
		material,
		record.application as Pick<V3RoomApplication, "catalog" | "canonicalBlueprintPackageBytes">
	);
	return Object.freeze({
		...identity,
		creatorInvite: record.creatorInvite,
		pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
	});
}

/**
 * Builds the one creator-signed genesis invite material shared by room products.
 * @param input - Closed product-owned blueprint, authority and signer evidence.
 * @returns Detached exact genesis material for the room session.
 */
export async function createV3RoomCreatorInviteMaterial(
	input: V3RoomCreatorInviteMaterialInput
): Promise<V3RoomCreatorInviteMaterial> {
	const owned = input !== null && typeof input === "object" && Object.hasOwn(input, "ownedGenesis");
	const record = exactRecord(input, [
		"blueprintDigest",
		"exactCanonicalApplicationStateBytes",
		"exactCanonicalLatchedAclBytes",
		"exactCanonicalParametersCarrierBytes",
		"exactCanonicalProfileBytes",
		"exactCanonicalSignerSetBytes",
		"objectId",
		owned ? "ownedGenesis" : "signGenesisAnchorDigest",
	]);
	if (
		record === undefined ||
		typeof record.blueprintDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(record.blueprintDigest) ||
		typeof record.objectId !== "string" ||
		!parseStorageObjectId(record.objectId).ok ||
		(!owned && typeof record.signGenesisAnchorDigest !== "function")
	) {
		throw new TypeError("v3 room creator invite input is invalid");
	}
	const blueprintDigest = record.blueprintDigest;
	const objectId = record.objectId;
	const ownedGenesis = owned ? exactRecord(record.ownedGenesis, ["lease", "roomHeadAuthority"]) : undefined;
	if (owned && (ownedGenesis === undefined || ownedGenesis.lease === null || typeof ownedGenesis.lease !== "object" || ownedGenesis.roomHeadAuthority === null || typeof ownedGenesis.roomHeadAuthority !== "object")) throw new TypeError("OWNED_GENESIS_ACCOUNT_OWNER_REQUIRED");
	const lease = ownedGenesis?.lease as V3RoomLocalSessionLease | undefined;
	lease?.assertCurrent();
	const signGenesisAnchorDigest = record.signGenesisAnchorDigest as GenesisAnchorSigner;
	const exactCanonicalApplicationStateBytes = normalizeApplicationStateBytes(
		record.exactCanonicalApplicationStateBytes,
		"genesis"
	);
	const stateDigest = digest("ts-drp/state/v3", exactCanonicalApplicationStateBytes);
	const exactCanonicalLatchedAclBytes = strictCanonicalBytes(
		record.exactCanonicalLatchedAclBytes,
		"exactCanonicalLatchedAclBytes"
	);
	const exactCanonicalParametersCarrierBytes = strictCanonicalBytes(
		record.exactCanonicalParametersCarrierBytes,
		"exactCanonicalParametersCarrierBytes"
	);
	assertSupportedGenesisLineagePolicy(exactCanonicalParametersCarrierBytes);
	const exactCanonicalProfileBytes = strictCanonicalBytes(
		record.exactCanonicalProfileBytes,
		"exactCanonicalProfileBytes"
	);
	const exactCanonicalSignerSetBytes = strictCanonicalBytes(
		record.exactCanonicalSignerSetBytes,
		"exactCanonicalSignerSetBytes"
	);
	const emptyRoot = hex(new CompactMerkleAccumulator().root());
	const exactCanonicalGenesisAnchorPreimageBytes = encodeCanonical({
		aclDigest: digest("ts-drp/latched-acl/v3", exactCanonicalLatchedAclBytes),
		archiveIndexRoot: emptyRoot,
		blueprintDigest,
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: "0".repeat(64),
		epoch: 0,
		historyRoot: emptyRoot,
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId,
		parametersDigest: digest("ts-drp/parameters/v3", exactCanonicalParametersCarrierBytes),
		previousAnchor: "0".repeat(64),
		profileDigest: digest("ts-drp/profile/v3", exactCanonicalProfileBytes),
		protocolMajor: 3,
		signerSetDigest: digest("ts-drp/signer-set/v3", exactCanonicalSignerSetBytes),
		stateDigest,
	});
	const anchorDigest = hashDomain("ts-drp/epoch-anchor/v3", exactCanonicalGenesisAnchorPreimageBytes);
	const detachedGenesisSignature = strictDetachedBytes(
		lease === undefined ? await signGenesisAnchorDigest(new Uint8Array(anchorDigest)) : await withAuthoredGenesisSigningRequest({
			exactCanonicalAnchorPreimageBytes: exactCanonicalGenesisAnchorPreimageBytes, exactCanonicalProfileBytes, exactCanonicalSignerSetBytes,
			exactCanonicalLatchedAclBytes, signerPublicKey: lease.signing.publicKeyBytes,
		}, request => lease.signing.signGenesisRequest(request, ownedGenesis!.roomHeadAuthority as V3RoomHeadAuthority)),
		"genesis anchor signature",
		64
	);
	return Object.freeze({
		detachedGenesisSignature,
		exactCanonicalGenesisAnchorPreimageBytes: new Uint8Array(exactCanonicalGenesisAnchorPreimageBytes),
		exactCanonicalLatchedAclBytes: new Uint8Array(exactCanonicalLatchedAclBytes),
		exactCanonicalParametersCarrierBytes: new Uint8Array(exactCanonicalParametersCarrierBytes),
		exactCanonicalProfileBytes: new Uint8Array(exactCanonicalProfileBytes),
		exactCanonicalSignerSetBytes: new Uint8Array(exactCanonicalSignerSetBytes),
		pinnedGenesisAnchorDigest: hex(anchorDigest),
	});
}

const APPLICATION_BATCH_LIMITS = Object.freeze({ maxBytes: 65_536, maxDepth: 8, maxItems: 1_024 });
const APPLICATION_BATCH_ENTRY_KEYS = Object.freeze(["logicalTime", "operation"]);
const APPLICATION_BATCH_KEYS = Object.freeze(["action", "batch"]);
const APPLICATION_BATCH_PAYLOAD_KEYS = Object.freeze(["entries", "version"]);

function captureRoomOperation(
	value: unknown,
	maxBytes?: number
):
	| Readonly<{
			operation: Readonly<Record<string, unknown>>;
			byteCharge: number;
	  }>
	| undefined {
	const bytes = encodeCanonical(value, maxBytes === undefined ? {} : { maxBytes });
	const decoded = decodeCanonical(bytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
	return Object.freeze({
		operation: Object.freeze({ ...(decoded as Record<string, unknown>) }),
		byteCharge: bytes.byteLength,
	});
}

function detachedRoomOperation(value: unknown): Readonly<Record<string, unknown>> | undefined {
	try {
		return captureRoomOperation(value)?.operation;
	} catch {
		return undefined;
	}
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) return undefined;
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== expectedKeys.length ||
		keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
	) {
		return undefined;
	}
	const output: Record<string, unknown> = {};
	for (const key of expectedKeys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
		output[key] = descriptor.value;
	}
	return Object.freeze(output);
}

const ROOM_HEAD_KEYS = Object.freeze(["currentAnchorDigest", "epoch", "objectId"]);
const ROOM_HEAD_STATE_KEYS = Object.freeze(["pending", "stable"]);
const ROOM_HEAD_PENDING_KEYS = Object.freeze(["next", "previous"]);
const ROOM_HEAD_INITIALIZATION_KEYS = Object.freeze(["kind"]);
const ROOM_HEAD_MIGRATION_KEYS = Object.freeze(["head", "kind"]);
const ROOM_HEAD_RESULT_FAILURE_KEYS = Object.freeze(["ok", "reason"]);
const ROOM_HEAD_RESULT_SUCCESS_KEYS = Object.freeze(["ok", "state"]);
const PROJECTION_BASE_RESULT_KEYS = Object.freeze([
	"blueprintDigest",
	"epoch",
	"exactCanonicalApplicationStateBytes",
	"objectId",
	"ok",
	"stateDigest",
]);
const LOWER_HEX_256 = /^[0-9a-f]{64}$/u;
const PROJECTION_REFUSED_ISSUE = "v3 room issued operation was not accepted by projection";

function roomHeadFailure(code: string): never {
	throw new TypeError(code);
}

function captureRoomHead(value: unknown): V3RoomHead | undefined {
	const record = exactRecord(value, ROOM_HEAD_KEYS);
	return record !== undefined &&
		typeof record.currentAnchorDigest === "string" &&
		LOWER_HEX_256.test(record.currentAnchorDigest) &&
		Number.isSafeInteger(record.epoch) &&
		(record.epoch as number) >= 0 &&
		typeof record.objectId === "string" &&
		record.objectId.length > 0
		? Object.freeze({
				currentAnchorDigest: record.currentAnchorDigest,
				epoch: record.epoch as number,
				objectId: record.objectId,
			})
		: undefined;
}

function sameRoomHead(left: V3RoomHead, right: V3RoomHead): boolean {
	return (
		left.currentAnchorDigest === right.currentAnchorDigest &&
		left.epoch === right.epoch &&
		left.objectId === right.objectId
	);
}

function captureRoomHeadState(value: unknown, scope: V3RoomHeadScope): V3RoomHeadState | undefined {
	const record = exactRecord(value, ROOM_HEAD_STATE_KEYS);
	const stable = captureRoomHead(record?.stable);
	if (
		record === undefined ||
		stable === undefined ||
		stable.objectId !== scope.objectId ||
		(stable.epoch === 0 && stable.currentAnchorDigest !== scope.pinnedGenesisAnchorDigest)
	) {
		return undefined;
	}
	if (record.pending === null) return Object.freeze({ pending: null, stable });
	const pending = exactRecord(record.pending, ROOM_HEAD_PENDING_KEYS);
	const previous = captureRoomHead(pending?.previous);
	const next = captureRoomHead(pending?.next);
	return pending !== undefined &&
		previous !== undefined &&
		next !== undefined &&
		sameRoomHead(previous, stable) &&
		next.objectId === scope.objectId &&
		next.epoch === stable.epoch + 1 &&
		next.currentAnchorDigest !== stable.currentAnchorDigest
		? Object.freeze({ pending: Object.freeze({ next, previous }), stable })
		: undefined;
}

function sameRoomHeadState(left: V3RoomHeadState, right: V3RoomHeadState): boolean {
	return (
		sameRoomHead(left.stable, right.stable) &&
		(left.pending === null
			? right.pending === null
			: right.pending !== null &&
				sameRoomHead(left.pending.previous, right.pending.previous) &&
				sameRoomHead(left.pending.next, right.pending.next))
	);
}

function captureRoomHeadInitialization(value: unknown): V3RoomHeadInitialization | undefined {
	const createOrReopen = exactRecord(value, ROOM_HEAD_INITIALIZATION_KEYS);
	if (createOrReopen?.kind === "create" || createOrReopen?.kind === "reopen") {
		return Object.freeze({ kind: createOrReopen.kind });
	}
	const migration = exactRecord(value, ROOM_HEAD_MIGRATION_KEYS);
	const head = captureRoomHead(migration?.head);
	return migration?.kind === "migrate" && head !== undefined
		? Object.freeze({ head, kind: "migrate" as const })
		: undefined;
}

async function callRoomHeadAuthority(
	operation: () => Promise<V3RoomHeadAuthorityResult>,
	scope: V3RoomHeadScope
): Promise<V3RoomHeadState | null> {
	let result: unknown;
	try {
		result = await operation();
	} catch {
		return roomHeadFailure("D110C_FLOOR_UNAVAILABLE");
	}
	const failure = exactRecord(result, ROOM_HEAD_RESULT_FAILURE_KEYS);
	if (failure?.ok === false) {
		if (failure.reason === "conflict") return roomHeadFailure("D110C_FLOOR_CONFLICT");
		if (failure.reason === "unavailable") return roomHeadFailure("D110C_FLOOR_UNAVAILABLE");
		return roomHeadFailure("D110C_FLOOR_INVALID");
	}
	const success = exactRecord(result, ROOM_HEAD_RESULT_SUCCESS_KEYS);
	if (success?.ok !== true) return roomHeadFailure("D110C_FLOOR_INVALID");
	if (success.state === null) return null;
	return captureRoomHeadState(success.state, scope) ?? roomHeadFailure("D110C_FLOOR_INVALID");
}

async function initializeRoomHeadAuthority(
	authority: V3RoomHeadAuthority,
	scope: V3RoomHeadScope,
	genesis: V3RoomHead
): Promise<V3RoomHeadState> {
	const initialization = captureRoomHeadInitialization(Reflect.get(authority, "initialization"));
	if (initialization === undefined) return roomHeadFailure("D110C_FLOOR_INVALID");
	let state: V3RoomHeadState | null;
	if (initialization.kind === "create") {
		state = await callRoomHeadAuthority(() => authority.create(Object.freeze({ scope, stable: genesis })), scope);
	} else if (initialization.kind === "migrate") {
		if (initialization.head.objectId !== scope.objectId) return roomHeadFailure("D110C_FLOOR_INVALID");
		state = await callRoomHeadAuthority(
			() => authority.migrate(Object.freeze({ scope, stable: initialization.head })),
			scope
		);
	} else {
		state = await callRoomHeadAuthority(() => authority.read(Object.freeze({ scope })), scope);
	}
	if (state === null) {
		return roomHeadFailure(
			initialization.kind === "reopen" ? "D110C_FLOOR_MIGRATION_REQUIRED" : "D110C_FLOOR_CONFLICT"
		);
	}
	return state;
}

async function readRoomHeadAuthority(authority: V3RoomHeadAuthority, scope: V3RoomHeadScope): Promise<V3RoomHeadState> {
	return (
		(await callRoomHeadAuthority(() => authority.read(Object.freeze({ scope })), scope)) ??
		roomHeadFailure("D110C_FLOOR_MIGRATION_REQUIRED")
	);
}

async function beginRoomHeadAdvance(
	authority: V3RoomHeadAuthority,
	scope: V3RoomHeadScope,
	current: V3RoomHead,
	next: V3RoomHead
): Promise<V3RoomHeadState> {
	if (
		current.objectId !== scope.objectId ||
		next.objectId !== scope.objectId ||
		next.epoch !== current.epoch + 1 ||
		next.currentAnchorDigest === current.currentAnchorDigest
	) {
		return roomHeadFailure("D110C_FLOOR_REGRESSION");
	}
	const observed = await readRoomHeadAuthority(authority, scope);
	if (observed.pending !== null) {
		if (sameRoomHead(observed.pending.previous, current) && sameRoomHead(observed.pending.next, next)) return observed;
		return roomHeadFailure("D110C_FLOOR_PENDING_INVALID");
	}
	if (!sameRoomHead(observed.stable, current)) {
		return roomHeadFailure(observed.stable.epoch < current.epoch ? "D110C_FLOOR_HEAD_AHEAD" : "D110C_FLOOR_MISMATCH");
	}
	const expected = Object.freeze({ pending: null, stable: current });
	const selected = await callRoomHeadAuthority(() => authority.begin(Object.freeze({ expected, next, scope })), scope);
	const pending = Object.freeze({ next, previous: current });
	const desired = Object.freeze({ pending, stable: current });
	if (selected === null || !sameRoomHeadState(selected, desired)) return roomHeadFailure("D110C_FLOOR_CONFLICT");
	return selected;
}

async function commitRoomHeadAdvance(
	authority: V3RoomHeadAuthority,
	scope: V3RoomHeadScope,
	pending: V3RoomHeadState
): Promise<V3RoomHeadState> {
	if (pending.pending === null) return roomHeadFailure("D110C_FLOOR_PENDING_INVALID");
	const selected = await callRoomHeadAuthority(
		() => authority.commit(Object.freeze({ expected: pending, scope })),
		scope
	);
	const desired = Object.freeze({ pending: null, stable: pending.pending.next });
	if (selected === null || !sameRoomHeadState(selected, desired)) return roomHeadFailure("D110C_FLOOR_CONFLICT");
	const reopened = await readRoomHeadAuthority(authority, scope);
	if (!sameRoomHeadState(reopened, desired)) return roomHeadFailure("D110C_FLOOR_MISMATCH");
	return reopened;
}

function expectedRoomHeadFromDescriptor(descriptor: Readonly<Record<string, unknown>>): V3RoomHead {
	return (
		captureRoomHead({
			currentAnchorDigest: descriptor.anchorDigest,
			epoch: descriptor.epoch,
			objectId: descriptor.objectId,
		}) ?? roomHeadFailure("D110C_FLOOR_INVALID")
	);
}

function exactDenseArray(value: unknown): readonly unknown[] | undefined {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1 || keys[value.length] !== "length") return undefined;
	for (let index = 0; index < value.length; index += 1) {
		if (keys[index] !== String(index)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
	}
	return value;
}

interface MigrationRecordAuthority {
	readonly aclDigest?: string;
	readonly epoch?: number;
	readonly anchorDigest: string;
	readonly blueprintDigest: string;
	readonly creatorAuthor: string;
	readonly objectId: string;
}

interface MigrationActivationAuthority extends MigrationRecordAuthority {
	readonly signerSetDigest: string;
}

interface ValidMigrationActivation {
	readonly decision: Readonly<Record<string, unknown>>;
	readonly decisionDigest: string;
	readonly targetCreatorInvite: V3RoomCreatorInviteMaterial;
}

interface AuthenticatedMigrationActivation extends ValidMigrationActivation {
	readonly activationVertexDigest: string;
}

interface RedirectSourceRecovery {
	readonly currentSource?: V3TerminalMigrationSource;
	prepareCurrentSource?(): Promise<V3TerminalMigrationSource>;
	readonly roomHeadAuthority: V3RoomHeadAuthority;
	readonly activation: AuthenticatedMigrationActivation;
	readonly cancelled: Promise<void>;
	readonly issuanceStore: Awaited<ReturnType<V3RoomStorageHost["openIssuance"]>>;
	readonly journalStore: Awaited<ReturnType<V3RoomStorageHost["openJournal"]>>;
	onRetainedBootstrapHold(): void;
}

function authenticatedMigrationActivation(
	activation: ValidMigrationActivation,
	activationVertexDigest: string
): AuthenticatedMigrationActivation {
	if (!/^[0-9a-f]{64}$/u.test(activationVertexDigest)) {
		throw new TypeError("v3 room migration activation vertex is invalid");
	}
	return Object.freeze({ ...activation, activationVertexDigest });
}

function migrationActivationOperation(
	operation: Readonly<Record<string, unknown>>,
	author: string,
	authority: MigrationActivationAuthority
): ValidMigrationActivation | undefined {
	if (Reflect.get(operation, "action") !== "migrationActivation") return undefined;
	const outer = exactRecord(operation, ["action", "decision"]);
	const decision = exactRecord(outer?.decision, MIGRATION_ACTIVATION_DECISION_KEYS);
	if (outer === undefined || decision === undefined) return undefined;
	const nonce = decision.rehearsalNonce;
	const inviteBytesValue = decision.exactCanonicalTargetCreatorInviteBytes;
	const sourceCount = decision.sourceAcceptedOperationCount;
	const targetCount = decision.targetImportOperationCount;
	const digestFields = [
		"applicationStateDigest",
		"migrationRecordDigest",
		"migrationRecordVertexDigest",
		"sourceAcceptedOperationsDigest",
		"sourceAnchorDigest",
		"sourceBlueprintDigest",
		"sourceCreatorAuthor",
		"targetAnchorDigest",
		"targetBlueprintDigest",
		"targetCreatorAuthor",
		"targetImportOperationsDigest",
	] as const;
	if (
		decision.kind !== "ts-drp-v3-room-migration-activation" ||
		decision.version !== 1 ||
		decision.activationAuthority !== "creator-ed25519-registered-vertex-v1" ||
		author !== authority.creatorAuthor ||
		decision.sourceObjectId !== authority.objectId ||
		decision.sourceAnchorDigest !== authority.anchorDigest ||
		decision.sourceBlueprintDigest !== authority.blueprintDigest ||
		decision.sourceCreatorAuthor !== authority.creatorAuthor ||
		!(nonce instanceof Uint8Array) ||
		Object.getPrototypeOf(nonce) !== Uint8Array.prototype ||
		!(nonce.buffer instanceof ArrayBuffer) ||
		nonce.byteOffset !== 0 ||
		nonce.byteLength !== 32 ||
		nonce.buffer.byteLength !== 32 ||
		!(inviteBytesValue instanceof Uint8Array) ||
		Object.getPrototypeOf(inviteBytesValue) !== Uint8Array.prototype ||
		!(inviteBytesValue.buffer instanceof ArrayBuffer) ||
		inviteBytesValue.byteOffset !== 0 ||
		inviteBytesValue.buffer.byteLength !== inviteBytesValue.byteLength ||
		inviteBytesValue.byteLength === 0 ||
		inviteBytesValue.byteLength > 32_768 ||
		!Number.isSafeInteger(sourceCount) ||
		(sourceCount as number) < 0 ||
		(sourceCount as number) > 8192 ||
		!Number.isSafeInteger(targetCount) ||
		(targetCount as number) < 0 ||
		(targetCount as number) > 8192 ||
		typeof decision.targetObjectId !== "string" ||
		!parseStorageObjectId(decision.targetObjectId).ok ||
		digestFields.some(
			(field) => typeof decision[field] !== "string" || !/^[0-9a-f]{64}$/u.test(decision[field] as string)
		) ||
		encodeCanonical(decision).byteLength > 49_152 ||
		encodeCanonical(operation).byteLength > 65_536
	) {
		return undefined;
	}
	try {
		const targetCreatorInvite = decodeCreatorInvite(hex(inviteBytesValue));
		if (!sameBytes(bytes(encodeCreatorInvite(targetCreatorInvite)), inviteBytesValue)) return undefined;
		const targetAuthority = migrationInviteAuthority(targetCreatorInvite);
		if (
			targetAuthority.objectId !== decision.targetObjectId ||
			targetAuthority.creatorAuthor !== authority.creatorAuthor ||
			targetAuthority.creatorAuthor !== decision.targetCreatorAuthor ||
			targetAuthority.blueprintDigest !== authority.blueprintDigest ||
			targetAuthority.blueprintDigest !== decision.targetBlueprintDigest ||
			targetAuthority.signerSetDigest !== authority.signerSetDigest ||
			targetCreatorInvite.pinnedGenesisAnchorDigest !== decision.targetAnchorDigest ||
			migrationTargetObjectId(authority.objectId, nonce) !== decision.targetObjectId ||
			decision.targetAnchorDigest === authority.anchorDigest
		) {
			return undefined;
		}
		return Object.freeze({
			decision,
			decisionDigest: digest("ts-drp/v3-room-migration-activation/v1", encodeCanonical(decision)),
			targetCreatorInvite,
		});
	} catch {
		return undefined;
	}
}

function migrationActivationClassifier(authority: MigrationActivationAuthority): RoomTerminalVertexClassifier {
	return ({ author, vertex }) => {
		const operation = detachedRoomOperation(vertex.operation);
		if (operation === undefined) return "reject";
		if (Reflect.get(operation, "action") !== "migrationActivation") return "ordinary";
		// The runtime calls this only after current-generation signature, anchor
		// and ACL authentication. Bind the decision to that admitted scope, not
		// the invitation's genesis epoch. This callback does not admit a vertex.
		if (vertex.objectId !== authority.objectId) return "reject";
		return migrationActivationOperation(operation, author, { ...authority, anchorDigest: vertex.anchor }) === undefined
			? "reject"
			: "terminal-authorized";
	};
}

function validMigrationRecordOperation(
	operation: Readonly<Record<string, unknown>>,
	author: string,
	authority: MigrationRecordAuthority
): boolean {
	if (Reflect.get(operation, "action") !== "migrationRecord") return true;
	const outer = exactRecord(operation, ["action", "record"]);
	const record = migrationRecord(outer?.record);
	if (outer === undefined || record === undefined) return false;
	if (
		record.version === 2 &&
		(record.targetEpoch !== 0 || authority.epoch !== 0 || record.targetAclDigest !== authority.aclDigest)
	)
		return false;
	const nonce = record.rehearsalNonce;
	let stateBytes: Uint8Array;
	try {
		stateBytes = migrationRecordStateBytes(record);
	} catch {
		return false;
	}
	const sourceCount = record.sourceAcceptedOperationCount;
	const targetCount = record.targetImportOperationCount;
	const sourceObjectId = record.sourceObjectId;
	const targetObjectId = record.targetObjectId;
	const digestFields = [
		"applicationStateDigest",
		"sourceAcceptedOperationsDigest",
		"sourceAnchorDigest",
		"sourceBlueprintDigest",
		"sourceCreatorAuthor",
		"targetAnchorDigest",
		"targetBlueprintDigest",
		"targetCreatorAuthor",
		"targetImportOperationsDigest",
	] as const;
	if (
		record.kind !== "ts-drp-v3-room-migration-record" ||
		(record.version !== 1 && record.version !== 2) ||
		record.archivePolicy !== "retain-source" ||
		record.authorityKind !== "creator-ed25519-registered-vertex-v1" ||
		!(nonce instanceof Uint8Array) ||
		Object.getPrototypeOf(nonce) !== Uint8Array.prototype ||
		!(nonce.buffer instanceof ArrayBuffer) ||
		nonce.byteOffset !== 0 ||
		nonce.byteLength !== 32 ||
		nonce.buffer.byteLength !== 32 ||
		!(stateBytes instanceof Uint8Array) ||
		Object.getPrototypeOf(stateBytes) !== Uint8Array.prototype ||
		!(stateBytes.buffer instanceof ArrayBuffer) ||
		stateBytes.byteOffset !== 0 ||
		stateBytes.buffer.byteLength !== stateBytes.byteLength ||
		stateBytes.byteLength > 32_768 ||
		!Number.isSafeInteger(sourceCount) ||
		(sourceCount as number) < 0 ||
		(sourceCount as number) > 8192 ||
		!Number.isSafeInteger(targetCount) ||
		(targetCount as number) < 0 ||
		(targetCount as number) > 8192 ||
		typeof sourceObjectId !== "string" ||
		!parseStorageObjectId(sourceObjectId).ok ||
		typeof targetObjectId !== "string" ||
		sourceObjectId === targetObjectId ||
		targetObjectId !== authority.objectId ||
		record.targetAnchorDigest !== authority.anchorDigest ||
		record.targetBlueprintDigest !== authority.blueprintDigest ||
		record.sourceBlueprintDigest !== authority.blueprintDigest ||
		record.sourceCreatorAuthor !== authority.creatorAuthor ||
		record.targetCreatorAuthor !== authority.creatorAuthor ||
		author !== authority.creatorAuthor ||
		digestFields.some((field) => typeof record[field] !== "string" || !/^[0-9a-f]{64}$/u.test(record[field] as string))
	) {
		return false;
	}
	try {
		const decodedState = decodeCanonical(stateBytes, { maxBytes: 32_768, maxDepth: 16, maxItems: 16_384 });
		return (
			sameBytes(encodeCanonical(decodedState), stateBytes) &&
			migrationTargetObjectId(sourceObjectId, nonce) === targetObjectId &&
			record.sourceAnchorDigest !== record.targetAnchorDigest &&
			record.applicationStateDigest === digest("ts-drp/v3-room-migration-state/v1", stateBytes) &&
			encodeCanonical(record).byteLength <= 49_152
		);
	} catch {
		return false;
	}
}

/** LOCAL configuration only, selected once per genuine plane binding. The
 * existing close owner immediately captures/validates the returned DATA before
 * awaiting storage. No selector or mutable result survives into ordinary calls.
 * Startup and successor workloads may differ; epoch selection grants no wire,
 * signing, retirement or protocol-validity authority. */
function roomOrdinaryFinishingWindowForEpoch(application: V3RoomApplication,
	context: Readonly<{objectId: string; epoch: number}>): CreatorOrdinaryFinishingWindowLimits | undefined {
	const policy = application.ordinaryFinishingWindow;
	if (typeof policy !== "function") return policy;
	const selected = Reflect.apply(policy, application, [Object.freeze({objectId: context.objectId, epoch: context.epoch})]);
	if (selected === undefined) throw new TypeError("v3 room finishing window selector did not return limits");
	return selected;
}

function createRoomOperationAdmissionPolicy(
	input: CreateV3RoomSessionInput,
	material: V3RoomCreatorInviteMaterial,
	context: Parameters<NonNullable<CreateV3RoomSessionInput["createOperationAdmissionPolicy"]>>[0]
): V3OperationAdmissionPolicy {
	const authority = migrationInviteAuthority(material);
	const applicationPolicy = input.createOperationAdmissionPolicy?.(context);
	let inherited = false;
	let migrationPrefixOnly = context.epoch === 0 && context.authenticatedApplicationStateBytes === undefined;
	const imports: Readonly<Record<string, unknown>>[] = [];
	const prefix: V3RoomAcceptedOperation[] = [];
	let importBytes = 0;
	const parameters = decodeCanonical(material.exactCanonicalParametersCarrierBytes) as Readonly<
		Record<string, unknown>
	>;
	const maxImportBytes = parameters.maxEpochBytes as number;
	const maxImports = (parameters.maxEpochVertices as number) * 16;
	return Object.freeze({
		reserve(operation: Readonly<Record<string, unknown>>, authenticated?: Readonly<{ author: string }>) {
			const expanded =
				operation.action === "applicationBatch"
					? exactDenseArray(Reflect.get(operation.batch as object, "entries"))?.map(
							(entry) => Reflect.get(entry as object, "operation") as Readonly<Record<string, unknown>>
						)
					: [operation];
			const additions = inherited
				? []
				: expanded?.filter((op) => input.application.batchableOperationActions.includes(op.action as string));
			if (additions === undefined) return Object.freeze({ kind: "rejected" as const });
			let additionBytes = 0;
			try {
				additionBytes = additions.reduce((sum, op) => sum + encodeCanonical(op).byteLength, 0);
			} catch {
				return Object.freeze({ kind: "rejected" as const });
			}
			if (
				!inherited &&
				(imports.length + additions.length > maxImports || importBytes + additionBytes > maxImportBytes)
			)
				return Object.freeze({ kind: "rejected" as const });
			if (operation.action === "migrationRecord") {
				const record = migrationRecord(operation.record);
				if (
					inherited ||
					!migrationPrefixOnly ||
					authenticated === undefined ||
					input.application.migration === undefined ||
					!validMigrationRecordOperation(operation, authenticated.author, {
						...context,
						blueprintDigest: authority.blueprintDigest,
						creatorAuthor: authority.creatorAuthor,
					}) ||
					record === undefined
				)
					return Object.freeze({ kind: "rejected" as const });
				try {
					if (
						record.targetImportOperationCount !== imports.length ||
						record.targetImportOperationsDigest !==
							digest("ts-drp/v3-room-migration-import/v1", encodeCanonical(imports))
					)
						return Object.freeze({ kind: "rejected" as const });
					const stateBytes = migrationRecordStateBytes(record);
					// Exercise the same pure reducer against the exact already-admitted
					// bootstrap/import prefix before signing or journaling the record.
					input.application.projectAcceptedOperations({
						authenticatedBase: undefined,
						currentEpochOperations: Object.freeze([
							...prefix,
							Object.freeze({
								author: authenticated.author,
								authorSequence: prefix.length,
								logicalTime: prefix.length,
								operation,
								operationCount: 1,
								operationIndex: 0,
								vertexDigest: digest("ts-drp/v3-room-migration-prefix-check/v1", encodeCanonical(operation)),
							}),
						]),
					});
					const projection = input.application.projectAcceptedOperations(
						Object.freeze({
							authenticatedBase: Object.freeze({
								blueprintDigest: authority.blueprintDigest,
								epoch: context.epoch,
								exactCanonicalApplicationStateBytes: stateBytes,
								objectId: context.objectId,
								stateDigest: digest("ts-drp/state/v3", stateBytes),
							}),
							currentEpochOperations: Object.freeze([]),
						})
					);
					if (!sameBytes(stateBytes, input.application.migration.canonicalStateBytes(projection)))
						return Object.freeze({ kind: "rejected" as const });
				} catch {
					return Object.freeze({ kind: "rejected" as const });
				}
			}
			const reservation = applicationPolicy?.reserve(operation, authenticated);
			if (reservation !== undefined && reservation.kind !== "fresh") return reservation;
			let active = true;
			return Object.freeze({
				kind: "fresh" as const,
				commit(): "committed" {
					if (!active) throw new TypeError("room admission reservation was consumed");
					if (reservation !== undefined && reservation.commit() !== "committed")
						throw new TypeError("room admission failed");
					active = false;
					if (operation.action === "migrationRecord") inherited = true;
					if (!inherited) {
						// Bootstrap payloads are replica-local construction inputs (for
						// example, a joining Grid recipient knows only its own enrollment).
						// Recognize only the first, standalone creator-authenticated bootstrap
						// action in this scope, not equality to the recipient's local payload.
						// The signed record still checks the exact admitted prefix with the
						// application reducer and binds its imports and canonical state.
						// A noncreator may already have its exact local construction bootstrap;
						// that remains ordinary signed work, not portable import authority.
						const localRecipientBootstrap =
							input.author !== authority.creatorAuthor &&
							authenticated?.author === input.author &&
							prefix.every((entry) => entry.operation.action === "$drp.author-fence.v1") &&
							sameBytes(encodeCanonical(operation), encodeCanonical(input.application.bootstrapOperation));
						const creatorBootstrap =
							authenticated?.author === authority.creatorAuthor &&
							operation.action === input.application.bootstrapOperation.action &&
							operation.action !== "applicationBatch" &&
							prefix.every(
								(entry) =>
									entry.operation.action === "$drp.author-fence.v1" ||
									(entry.author === input.author &&
										input.author !== authority.creatorAuthor &&
										sameBytes(encodeCanonical(entry.operation), encodeCanonical(input.application.bootstrapOperation)))
							);
						imports.push(...additions);
						importBytes += additionBytes;
						if (migrationPrefixOnly && authenticated !== undefined)
							for (const op of expanded ?? [])
								prefix.push(
									Object.freeze({
										author: authenticated.author,
										authorSequence: prefix.length,
										logicalTime: prefix.length,
										operation: op,
										operationCount: 1,
										operationIndex: 0,
										vertexDigest: digest("ts-drp/v3-room-migration-prefix-check/v1", encodeCanonical(op)),
									})
								);
						if (
							expanded?.some(
								(op) =>
									!input.application.batchableOperationActions.includes(op.action as string) &&
									op.action !== "$drp.author-fence.v1" &&
									!creatorBootstrap &&
									!localRecipientBootstrap
							)
						)
							migrationPrefixOnly = false;
					} else {
						imports.length = 0;
						prefix.length = 0;
						importBytes = 0;
					}
					return "committed";
				},
				release(): void {
					active = false;
					reservation?.release();
				},
			});
		},
	});
}

function acceptedOperationsForVertex(
	application: V3RoomApplication,
	vertex: V3RoomAcceptedVertex,
	migrationAuthority?: MigrationRecordAuthority
): readonly V3RoomAcceptedOperation[] | undefined {
	const vertexDigest = hex(vertex.digest);
	const operation = detachedRoomOperation(vertex.operation);
	if (operation === undefined) return undefined;
	if (
		migrationAuthority !== undefined &&
		Reflect.get(operation, "action") === "migrationRecord" &&
		!validMigrationRecordOperation(operation, vertex.author, migrationAuthority)
	) {
		return undefined;
	}
	if (Reflect.get(operation, "action") !== "applicationBatch") {
		return Object.freeze([
			Object.freeze({
				author: vertex.author,
				authorSequence: vertex.authorSequence,
				logicalTime: vertex.logicalTime,
				operation,
				operationCount: 1,
				operationIndex: 0,
				vertexDigest,
			}),
		]);
	}
	try {
		decodeCanonical(encodeCanonical(operation, APPLICATION_BATCH_LIMITS), APPLICATION_BATCH_LIMITS);
	} catch {
		return undefined;
	}
	const outer = exactRecord(operation, APPLICATION_BATCH_KEYS);
	const batch = exactRecord(outer?.batch, APPLICATION_BATCH_PAYLOAD_KEYS);
	const entries = exactDenseArray(batch?.entries);
	if (outer === undefined || batch === undefined || batch.version !== 1 || entries === undefined) return undefined;
	if (entries.length < 2 || entries.length > 16) return undefined;
	let priorLogicalTime = -1;
	const accepted: V3RoomAcceptedOperation[] = [];
	for (let operationIndex = 0; operationIndex < entries.length; operationIndex += 1) {
		const entry = exactRecord(entries[operationIndex], APPLICATION_BATCH_ENTRY_KEYS);
		const child = detachedRoomOperation(entry?.operation);
		const action = child === undefined ? undefined : Reflect.get(child, "action");
		if (
			entry === undefined ||
			!Number.isSafeInteger(entry.logicalTime) ||
			(entry.logicalTime as number) < 0 ||
			(entry.logicalTime as number) <= priorLogicalTime ||
			child === undefined ||
			typeof action !== "string" ||
			!application.batchableOperationActions.includes(action)
		) {
			return undefined;
		}
		priorLogicalTime = entry.logicalTime as number;
		accepted.push(
			Object.freeze({
				author: vertex.author,
				authorSequence: vertex.authorSequence,
				logicalTime: priorLogicalTime,
				operation: child,
				operationCount: entries.length,
				operationIndex,
				vertexDigest,
			})
		);
	}
	return Object.freeze(accepted);
}

function validateDisplacementPolicy(application: V3RoomApplication): void {
	const policies = application.displacementPolicies;
	if (
		policies === null ||
		typeof policies !== "object" ||
		Array.isArray(policies) ||
		!Object.isFrozen(policies) ||
		(Object.getPrototypeOf(policies) !== Object.prototype && Object.getPrototypeOf(policies) !== null)
	) {
		throw new TypeError("v3 room displacement policy is invalid");
	}
	const keys = Reflect.ownKeys(policies);
	if (
		keys.length !== application.batchableOperationActions.length ||
		keys.some((key, index) => key !== application.batchableOperationActions[index])
	) {
		throw new TypeError("v3 room displacement policy is invalid");
	}
	for (const key of keys) {
		if (typeof key !== "string") throw new TypeError("v3 room displacement policy is invalid");
		const descriptor = Object.getOwnPropertyDescriptor(policies, key);
		const value = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
		if (
			descriptor?.enumerable !== true ||
			(value !== "expire" && value !== "manual-review" && value !== "rebase" && value !== "transform")
		) {
			throw new TypeError("v3 room displacement policy is invalid");
		}
	}
	if (typeof application.displacedOperationIdentity !== "function") {
		throw new TypeError("v3 room displacement authority is invalid");
	}
}

/**
 * Captures the trusted local room policy once; signatures do not verify this premise.
 * @param application
 */
function localSettlementPolicy(
	application: V3RoomApplication,
	invite: V3RoomCreatorInviteMaterial
): V3LocalSettlementPolicy {
	validateDisplacementPolicy(application);
	const policies = Object.freeze({ ...application.displacementPolicies });
	const identityFor = application.displacedOperationIdentity;
	const transform = application.transformDisplacedOperation;
	const blueprintDigest = hex(hashDomain("ts-drp/blueprint-admission/v3", application.canonicalBlueprintPackageBytes));
	return Object.freeze({
		blueprintDigest,
		inheritedImportActions: Object.freeze([...application.batchableOperationActions]),
		verifyInherited(context: Parameters<NonNullable<V3LocalSettlementPolicy["verifyInherited"]>>[0]): boolean {
			const authority = migrationInviteAuthority(invite);
			const record = migrationRecord(context.operation.record);
			const migration = application.migration;
			const checks = {
				record: record !== undefined,
				version: record?.version === 2,
				inherits: migration?.inheritAuthenticatedState === true,
				validTarget: validMigrationRecordOperation(context.operation, context.targetAuthor, {
					objectId: context.targetObjectId,
					anchorDigest: context.targetAnchorDigest,
					epoch: context.targetEpoch,
					aclDigest: digest("ts-drp/latched-acl/v3", invite.exactCanonicalLatchedAclBytes),
					creatorAuthor: authority.creatorAuthor,
					blueprintDigest: authority.blueprintDigest,
				}),
				// The original record binds the exact source anchor, whose authenticated
				// preimage binds its epoch; there is no sourceEpoch carrier in this codec.
				sourceObject: record?.sourceObjectId === context.sourceObjectId,
				sourceAnchor: record?.sourceAnchorDigest === context.sourceAnchorDigest,
			};
			if (record === undefined || migration === undefined || Object.values(checks).some((value) => !value)) {
				context.onRefusal?.(`policy-context:${JSON.stringify(checks)}`);
				return false;
			}
			try {
				const state = migrationRecordStateBytes(record);
				const prepared = migration.prepare(Object.freeze([]), state);
				const preparation = {
					state: sameBytes(state, prepared.exactCanonicalApplicationStateBytes),
					count: record.targetImportOperationCount === prepared.importOperations.length,
					commitment:
						record.targetImportOperationsDigest ===
						digest("ts-drp/v3-room-migration-import/v1", encodeCanonical(prepared.importOperations)),
				};
				if (Object.values(preparation).some((value) => !value)) {
					context.onRefusal?.(`policy-preparation:${JSON.stringify(preparation)}`);
					return false;
				}
				const membership = context.sourceOperations.map(
					(operation) =>
						migration.containsInheritedOperation?.(operation, state, { sourceAuthor: context.sourceAuthor }) === true ||
						prepared.importOperations.some((imported) =>
							sameBytes(encodeCanonical(imported), encodeCanonical(operation))
						)
				);
				if (membership.length === 0 || membership.some((value) => !value)) {
					context.onRefusal?.(
						`policy-membership:${JSON.stringify({ membership, actions: context.sourceOperations.map((op) => op.action) })}`
					);
					return false;
				}
				return true;
			} catch (error) {
				context.onRefusal?.(`policy-decode:${error instanceof Error ? error.message : "unknown"}`);
				return false;
			}
		},
		derive(operations: Parameters<V3LocalSettlementPolicy["derive"]>[0]) {
			let transformed = false;
			const selected = operations.flatMap((raw) => {
				const operation = detachedRoomOperation(raw);
				const action = operation === undefined ? undefined : Reflect.get(operation, "action");
				if (operation === undefined || typeof action !== "string")
					throw new TypeError("v3 room displaced operation is invalid");
				const policy = policies[action];
				if (policy === "expire") return [];
				if (policy !== "rebase" && policy !== "transform")
					throw new TypeError("v3 room settlement replacement policy is invalid");
				const identity = identityFor(operation);
				if (typeof identity !== "string" || identity.length === 0 || identityFor(operation) !== identity)
					throw new TypeError("v3 room displaced operation identity is invalid");
				let candidate = operation;
				if (policy === "transform") {
					const first = transform === undefined ? undefined : detachedRoomOperation(transform(operation));
					const second = transform === undefined ? undefined : detachedRoomOperation(transform(operation));
					if (
						first === undefined ||
						second === undefined ||
						!sameBytes(encodeCanonical(first), encodeCanonical(second)) ||
						Reflect.get(first, "action") !== action ||
						identityFor(first) !== identity
					)
						throw new TypeError("v3 room displaced transform is unstable");
					candidate = first;
					transformed = true;
				}
				decodeCanonical(encodeCanonical(candidate, { maxBytes: 65536, maxDepth: 8, maxItems: 1024 }), {
					maxBytes: 65536,
					maxDepth: 8,
					maxItems: 1024,
				});
				return [candidate];
			});
			if (selected.length < 1 || selected.length > SETTLEMENT_REPLACEMENT_MAX_INTENTS)
				throw new TypeError("v3 room settlement replacement intent count is invalid");
			return Object.freeze({
				disposition: transformed ? ("transform" as const) : ("rebase" as const),
				operations: Object.freeze(selected),
			});
		},
	});
}

function migrationLatchedAcl(material: V3RoomCreatorInviteMaterial): unknown {
	const profile = decodeCanonical(material.exactCanonicalProfileBytes);
	const anchor = decodeCanonical(material.exactCanonicalGenesisAnchorPreimageBytes);
	const acl = openCanonicalLatchedAclSnapshot({
		exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
		expectedAclDigest: Reflect.get(anchor as object, "aclDigest") as string,
		expectedEpoch: Reflect.get(anchor as object, "epoch") as number,
		expectedObjectId: Reflect.get(anchor as object, "objectId") as string,
		expectedProfileId: Reflect.get(profile as object, "profileId") as string,
	});
	if (!acl.ok) throw new TypeError(`v3 room migration invite ACL is invalid: ${acl.reason}`);
	return acl.snapshot;
}

function migrationCreatorAuthor(material: V3RoomCreatorInviteMaterial): string {
	// Genesis creator identity is not ordinary-operation admission: a creator
	// may administer the ACL without Writer. Current writes still require the
	// latched ACL owner's independent Writer decision.
	const decoded = migrationLatchedAcl(material);
	const members = exactDenseArray(
		decoded !== null && typeof decoded === "object" ? Reflect.get(decoded, "members") : undefined
	);
	const candidates = (members ?? []).flatMap((value) => {
		const member = exactRecord(value, ["author", "finalityKey", "groups"]);
		const groups = exactDenseArray(member?.groups);
		return member !== undefined &&
			typeof member.author === "string" &&
			/^[0-9a-f]{64}$/u.test(member.author) &&
			member.finalityKey === member.author &&
			groups?.includes("admin") === true &&
			groups.includes("finality")
			? [member.author]
			: [];
	});
	if (candidates.length !== 1) {
		throw new TypeError("v3 room migration creator application author is invalid");
	}
	return candidates[0] as string;
}

function migrationInviteAuthority(material: V3RoomCreatorInviteMaterial): Readonly<{
	readonly blueprintDigest: string;
	readonly creatorAuthor: string;
	readonly objectId: string;
	readonly signerSetDigest: string;
}> {
	const preimage = decodeCanonical(material.exactCanonicalGenesisAnchorPreimageBytes, {
		maxBytes: 65_536,
		maxDepth: 4,
		maxItems: 128,
	});
	const blueprintDigest =
		preimage !== null && typeof preimage === "object" ? Reflect.get(preimage, "blueprintDigest") : undefined;
	const objectId = preimage !== null && typeof preimage === "object" ? Reflect.get(preimage, "objectId") : undefined;
	const acl = migrationLatchedAcl(material);
	const aclObjectId = acl !== null && typeof acl === "object" ? Reflect.get(acl, "objectId") : undefined;
	if (
		preimage === null ||
		typeof preimage !== "object" ||
		typeof blueprintDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(blueprintDigest) ||
		typeof objectId !== "string" ||
		aclObjectId !== objectId
	) {
		throw new TypeError("v3 room migration invite authority is invalid");
	}
	return Object.freeze({
		blueprintDigest,
		creatorAuthor: migrationCreatorAuthor(material),
		objectId,
		signerSetDigest: digest("ts-drp/signer-set/v3", material.exactCanonicalSignerSetBytes),
	});
}

function migrationTargetObjectId(sourceObjectId: string, rehearsalNonce: Uint8Array): string {
	const separator = sourceObjectId.indexOf(":");
	if (separator <= 0 || separator === sourceObjectId.length - 1) {
		throw new TypeError("v3 room migration source object id is invalid");
	}
	const identity = hashDomain(
		"ts-drp/v3-room-migration-target-object/v1",
		encodeCanonical({ rehearsalNonce: new Uint8Array(rehearsalNonce), sourceObjectId })
	);
	const targetObjectId = `${sourceObjectId.slice(0, separator)}:${hex(identity.subarray(0, 16))}`;
	if (targetObjectId === sourceObjectId) throw new TypeError("v3 room migration target object id is invalid");
	return targetObjectId;
}

function migrationTransport(): V3RoomTransport {
	const topics = new Set<string>();
	const networkNode = {
		peerId: "peer:v3-room-migration-local",
		broadcastMessage: (): Promise<never> =>
			Promise.reject(new TypeError("v3 room migration transport cannot broadcast messages")),
		changeTopicScoreParams: (): void => undefined,
		connect: (): Promise<void> => Promise.reject(new TypeError("v3 room migration transport cannot connect")),
		connectToBootstraps: (): Promise<void> =>
			Promise.reject(new TypeError("v3 room migration transport cannot dial bootstraps")),
		disconnect: (): Promise<void> => Promise.resolve(),
		getAllPeers: (): [] => [],
		getBootstrapNodes: (): [] => [],
		getGroupPeers: (): [] => [],
		getMultiaddrs: (): [] => [],
		getPeerMultiaddrs: (): Promise<[]> => Promise.resolve([]),
		getSubscribedTopics: (): string[] => [...topics],
		gossipTopicFor: (): undefined => undefined,
		isDialable: (): Promise<boolean> => Promise.resolve(false),
		publishMessage: (): Promise<true> => Promise.resolve(true),
		removeTopicScoreParams: (): void => undefined,
		restart: (): Promise<void> => Promise.resolve(),
		sendGroupMessageRandomPeer: (): Promise<void> =>
			Promise.reject(new TypeError("v3 room migration transport cannot send group messages")),
		sendMessage: (): Promise<void> => Promise.reject(new TypeError("v3 room migration transport cannot send messages")),
		start: (): Promise<void> => Promise.resolve(),
		stop: (): Promise<void> => Promise.resolve(),
		subscribe: (topic: string): void => {
			topics.add(topic);
		},
		subscribeToMessageQueue: (): void => undefined,
		unsubscribe: (topic: string): void => {
			topics.delete(topic);
		},
	} as unknown as DRPNetworkNode;
	return Object.freeze({
		close(): void {
			topics.clear();
		},
		networkNode,
		openEphemeral(): never {
			throw new TypeError("v3 room migration transport has no ephemeral plane");
		},
		requestRetainedHistory(): void {
			// The migration target is intentionally local-only.
		},
		setIngressHandler(): void {
			// The migration target accepts no remote ingress.
		},
		setRetainedPublisher(): void {
			// The genuine live plane still installs its local publisher.
		},
	});
}

/**
 * Opens one host-backed v3 room from application material and a real transport adapter.
 * @param input - Closed application, identity, durable-store and transport bindings.
 * @returns The active room session after durable recovery and live activation.
 */
type OwnedLocalRoomBindingFacts = Readonly<{
	lease: V3RoomLocalSessionLease;
	bindingDigest: Uint8Array;
	scope: Readonly<{ objectId: string; pinnedGenesisAnchorDigest: string }>;
	publicKey: Uint8Array;
}>;
const ownedLocalRoomBindingRequests = new WeakMap<object, OwnedLocalRoomBindingFacts>();
type OwnedLocalTerminalFacts = CreatorLocalSessionWithdrawal & Readonly<{
	lease: V3RoomLocalSessionLease;
	selector: V3RoomLocalSessionSelector;
	bindingDigest: Uint8Array;
}>;
const ownedLocalTerminalRequests = new WeakMap<object, { facts: OwnedLocalTerminalFacts; admission?: object }>();
const ownedLocalTerminalAdmissions = new WeakMap<object, OwnedLocalTerminalFacts>();
/** Native consumer only: request provenance belongs to this actual SDK owner. */
export function consumeOwnedLocalSessionTerminalRequest(request: unknown, expectedLease: V3RoomLocalSessionLease): object | undefined {
	const entry = request !== null && typeof request === "object" ? ownedLocalTerminalRequests.get(request) : undefined;
	if (entry === undefined || entry.facts.lease !== expectedLease) return undefined;
	expectedLease.assertCurrent();
	if (entry.facts.author !== expectedLease.signing.author || entry.facts.selector.slot !== expectedLease.selector.slot ||
		entry.facts.selector.incarnation !== expectedLease.selector.incarnation) throw new TypeError("LOCAL_SESSION_TERMINAL_CONTEXT_CHANGED");
	ownedLocalTerminalRequests.delete(request as object);
	const admission = Object.freeze({}); entry.admission = admission;
	ownedLocalTerminalAdmissions.set(admission, entry.facts);
	return admission;
}
/** Same genuine admission for host and catalog. After fencing, the independent
 * account's exact durable intent, not this in-process object, owns recovery. */
export function resolveOwnedLocalSessionTerminalAdmission(admission: unknown): OwnedLocalTerminalFacts | undefined {
	return admission !== null && typeof admission === "object" ? ownedLocalTerminalAdmissions.get(admission) : undefined;
}
/** Native consumer only. Caller-authored records and copied requests have no
 * provenance. Authentication and exact ACL enrollment stay with this SDK owner. */
export function consumeOwnedLocalRoomBindingRequest(request: unknown, expectedLease: V3RoomLocalSessionLease):
	Omit<OwnedLocalRoomBindingFacts, "lease"> | undefined {
	const facts = request !== null && typeof request === "object" ? ownedLocalRoomBindingRequests.get(request) : undefined;
	if (facts === undefined || facts.lease !== expectedLease) return undefined;
	expectedLease.assertCurrent();
	if (!sameBytes(facts.publicKey, expectedLease.signing.publicKeyBytes)) throw new TypeError("LOCAL_SESSION_ROOM_KEY_CHANGED");
	ownedLocalRoomBindingRequests.delete(request as object);
	return Object.freeze({ bindingDigest: Uint8Array.from(facts.bindingDigest), scope: facts.scope, publicKey: Uint8Array.from(facts.publicKey) });
}

export async function createV3RoomSession<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection> | CreateV3LocalRoomSessionInput<Projection>
): Promise<V3RoomSession<Projection>> {
	if (!("localSession" in input)) return createV3RoomSessionOwned(input, false);
	const { localSession, ...applicationInput } = input;
	const lease = localSession.lease;
	lease.assertCurrent();
	const signing = lease.signing;
	let owner!: LocalRoomAcquisitionOwner;
	const control = Object.freeze({ selector: lease.selector,
		retire: (): Promise<void> => {
			if (owner.closeRoot === undefined) return Promise.reject(new TypeError("v3 local room acquisition is not complete"));
			if (lease.requiresAuthenticatedDisposition !== true) return lease.retire({ join: owner.closeRoot });
			if (owner.retireTask !== undefined) return owner.retireTask;
			const task = (async (): Promise<void> => {
				owner.assertCurrent();
				const prepare = owner.prepareTerminal, binding = owner.bindingDigest;
				if (prepare === undefined || binding === undefined)
					throw new TypeError("LOCAL_SESSION_PROTOCOL_DISPOSITION_REQUIRED");
				const proof = await prepare();
				const request = Object.freeze({});
				const entry = { facts: Object.freeze({ ...proof, lease, selector: Object.freeze({ ...lease.selector }),
					bindingDigest: Uint8Array.from(binding) }), admission: undefined as object | undefined };
				ownedLocalTerminalRequests.set(request, entry);
				let failed = false, primary: unknown;
				try { await lease.retire({ join: owner.closeRoot!, disposition: request }); }
				catch (cause) { failed = true; primary = cause; throw cause; }
				finally {
					ownedLocalTerminalRequests.delete(request);
					if (entry.admission !== undefined) ownedLocalTerminalAdmissions.delete(entry.admission);
					try { await proof.release(); } // Original admitted native reads/signing join.
					catch (cleanup) { if (failed) throw new AggregateError([primary, cleanup], "terminal disposition and joined proof release failed", { cause: primary }); throw cleanup; }
				}
			})();
			owner.retireTask = task;
			void task.catch(() => { if (!owner.closed && owner.retireTask === task) owner.retireTask = undefined; });
			return task;
		},
	});
	owner = { lease, control, closed: false,
		assertCurrent: (): void => {
			if (owner.closed) throw new TypeError("v3 local room session is closed");
			lease.assertCurrent();
		},
	};
	const sign = signing.signRequest;
	const accept = applicationInput.onAcceptedVertex, project = applicationInput.onProjection;
	const migrate = applicationInput.onMigrationTarget, openTransport = applicationInput.openTransport;
	const authorize = applicationInput.authorizeSettlementSource;
	try {
		lease.assertCurrent();
		const material = decodeCreatorInvite(typeof applicationInput.creatorInvite === "string" ? applicationInput.creatorInvite : encodeCreatorInvite(applicationInput.creatorInvite));
		const authenticated = authenticateCreatorInviteMaterial(material, applicationInput.application);
		if (authenticated.objectId !== applicationInput.objectId) throw new TypeError("LOCAL_SESSION_ROOM_BINDING_CONFLICT");
		const acl = migrationLatchedAcl(material) as Readonly<{ members?: readonly Readonly<{ author?: string; finalityKey?: string; groups?: readonly string[] }>[] }>;
		const member = acl.members?.find((candidate) => candidate.author === signing.author);
		// Acquisition authenticates exact enrollment, not permission to issue an
		// arbitrary ordinary operation. The original latched-operation owner
		// independently enforces Writer; an admin/finality creator need not be one.
		if (member === undefined) throw new TypeError("LOCAL_SESSION_OWNED_IDENTITY_NOT_ENROLLED");
		const isCreator = migrationCreatorAuthor(material) === signing.author;
		if (isCreator && member.finalityKey !== signing.author) throw new TypeError("LOCAL_SESSION_OWNED_IDENTITY_NOT_ENROLLED");
		// Bind exact authenticated root before the SDK opens any owned family or
		// writes a floor. This does not establish latestness: external account
		// roomHeadAuthority remains required and untouched by terminal cleanup.
		const roomBinding = Object.freeze({});
		const bindingDigest = hashDomain("ts-drp/local-session-authenticated-root/v1", encodeCanonical({ creatorInvite: encodeCreatorInvite(material) }));
		ownedLocalRoomBindingRequests.set(roomBinding, Object.freeze({ lease,
			bindingDigest,
			scope: Object.freeze({ objectId: authenticated.objectId, pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest }),
			publicKey: Uint8Array.from(signing.publicKeyBytes),
		}));
		try { lease.bindAuthenticatedRoom(roomBinding); }
		finally { ownedLocalRoomBindingRequests.delete(roomBinding); }
		owner.bindingDigest = bindingDigest;
		const session = await createV3RoomSessionOwned({
			...applicationInput,
			author: signing.author,
			publicKeyBytes: signing.publicKeyBytes,
			creatorFinalitySigner: applicationInput.receiveOnly !== true && isCreator ? signing.finalitySigner : undefined,
			storageHost: lease.storageHost,
			signRegisteredVertexDigest: (_registeredDigest, request): Promise<Uint8Array> => {
				owner.assertCurrent();
				if (request === undefined) throw new TypeError("OWNED_SIGNING_SEMANTIC_REQUEST_REQUIRED");
				return lease.admit(async () => {
					owner.assertCurrent();
					const signature = await sign(request);
					owner.assertCurrent();
					return signature;
				});
			},
			onAcceptedVertex: (vertex): Promise<void> => {
				owner.assertCurrent();
				return lease.admit(async () => { owner.assertCurrent(); await accept(vertex); owner.assertCurrent(); });
			},
			onProjection: (projection): void => { owner.assertCurrent(); project(projection); owner.assertCurrent(); },
			...(authorize === undefined ? {} : { authorizeSettlementSource: (request: Parameters<NonNullable<CreateV3RoomSessionInput["authorizeSettlementSource"]>>[0]): Promise<Uint8Array> => {
				owner.assertCurrent();
				return lease.admit(async () => { owner.assertCurrent(); const result = await authorize(request); owner.assertCurrent(); return result; });
			} }),
			...(migrate === undefined ? {} : { onMigrationTarget: (target: V3RoomSession<Projection>, objectId: string): void => {
				owner.assertCurrent(); migrate(target, objectId); owner.assertCurrent();
			} }),
			openTransport: (objectId): V3RoomTransport => { owner.assertCurrent(); return openTransport(objectId); },
		}, false, undefined, false, undefined, owner, true);
		owner.assertCurrent();
		return session;
	} catch (primary) {
		owner.closed = true;
		try { await lease.close(); }
		catch (cleanup) { throw new AggregateError([primary, cleanup], "v3 local room acquisition and native close failed", { cause: primary }); }
		throw primary; // Retain recoverable identity/files. Never implicitly retire a failed acquisition.
	}
}

async function createV3RoomSessionOwned<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>,
	requireFreshTrust: boolean,
	redirectSource?: RedirectSourceRecovery,
	skipRoomHeadAuthority = false,
	releaseOwnedRoomHeadAuthority?: () => Promise<void>,
	localOwner?: LocalRoomAcquisitionOwner,
	ownsLocalSession = false
): Promise<V3RoomSession<Projection>> {
	localOwner?.assertCurrent();
	// The trusted application owns displacement semantics for this room lifetime.
	if (input.receiveOnly !== undefined && input.receiveOnly !== true)
		throw new TypeError("v3 room receive-only restriction is invalid");
	if (input.receiveOnly && input.creatorFinalitySigner !== undefined)
		throw new TypeError("v3 receive-only room cannot own creator signing custody");
	if (input.openCreatorArchive !== undefined &&
		(typeof input.openCreatorArchive !== "function" || input.creatorFinalitySigner === undefined))
		throw new TypeError("v3 creator archive requires the original creator close owner");
	if (input.recoveryPoolAutoMaintenance !== undefined) resolveRecoveryPoolAutoMaintenanceOptions(input.recoveryPoolAutoMaintenance);
	if (input.recoveryPoolScheduledLull !== undefined && typeof input.recoveryPoolScheduledLull !== "boolean")
		throw new TypeError("v3 room scheduled recovery-pool lull option is invalid");
	if (
		input.application.snapshotReadPolicy !== undefined &&
		input.application.snapshotReadPolicy !== "authenticated-public" &&
		input.application.snapshotReadPolicy !== "current-writers"
	)
		throw new TypeError("v3 room snapshot reader policy is invalid");
	// Copy its data/functions once; later caller property replacement is not policy.
	if (input.rebaseSourceInvite !== undefined) validateDisplacementPolicy(input.application);
	if (input.rebaseSourceStorage !== undefined) {
		const source = exactRecord(input.rebaseSourceStorage, ["databaseName", "roomHeadAuthority"]);
		if (
			input.rebaseSourceInvite === undefined ||
			source === undefined ||
			typeof source.databaseName !== "string" ||
			source.databaseName.length === 0 ||
			source.databaseName === input.databaseName ||
			source.roomHeadAuthority === null ||
			typeof source.roomHeadAuthority !== "object"
		)
			throw new TypeError("v3 room rebase source storage is invalid");
		input = {
			...input,
			rebaseSourceStorage: Object.freeze({
				databaseName: source.databaseName,
				roomHeadAuthority: source.roomHeadAuthority as V3RoomHeadAuthority,
			}),
		};
	}
	input = Object.freeze({
		...input,
		storageHost: captureV3RoomStorageHost(input.storageHost),
		application: Object.freeze({
			...input.application,
			displacementPolicies: Object.freeze({ ...input.application.displacementPolicies }),
		}),
	});
	const captureInvite = (
		creatorInvite: string | V3RoomCreatorInviteMaterial
	): {
		invite: string;
		material: V3RoomCreatorInviteMaterial;
		settlementProfile: ReturnType<typeof settlementProfileFor>;
	} => {
		const invite = typeof creatorInvite === "string" ? creatorInvite : encodeCreatorInvite(creatorInvite);
		const material = decodeCreatorInvite(invite);
		authenticateCreatorInviteMaterial(material, input.application);
		const profileCarrier = decodeCanonical(material.exactCanonicalProfileBytes, {
			maxBytes: 65_536,
			maxDepth: 4,
			maxItems: 128,
		});
		const profileId =
			profileCarrier !== null && typeof profileCarrier === "object" && !Array.isArray(profileCarrier)
				? Reflect.get(profileCarrier, "profileId")
				: undefined;
		const settlementProfile = typeof profileId === "string" ? settlementProfileFor(profileId) : "none";
		return { invite, material, settlementProfile };
	};
	const exactCanonicalPinnedGenesisBootstrapOperationBytes = encodeCanonical(
		input.application.bootstrapOperation,
		APPLICATION_BATCH_LIMITS
	);
	decodeCanonical(exactCanonicalPinnedGenesisBootstrapOperationBytes, APPLICATION_BATCH_LIMITS);
	const { invite, material, settlementProfile } = captureInvite(input.creatorInvite);
	const ownedSettlementPolicy = localSettlementPolicy(input.application, material);
	if (
		input.createOperationAdmissionPolicy !== undefined &&
		typeof input.createOperationAdmissionPolicy !== "function"
	) {
		throw new TypeError("v3 room operation admission factory is invalid");
	}
	if (
		!Array.isArray(input.application.batchableOperationActions) ||
		!Object.isFrozen(input.application.batchableOperationActions) ||
		input.application.batchableOperationActions.length === 0 ||
		input.application.batchableOperationActions.some(
			(action, index, actions) =>
				typeof action !== "string" || action.length === 0 || (index > 0 && (actions[index - 1] as string) >= action)
		)
	) {
		throw new TypeError("v3 room batchable operation actions are invalid");
	}
	if (input.rebaseSourceInvite !== undefined) validateDisplacementPolicy(input.application);
	const issuanceDatabaseName =
		input.issuanceDatabaseName ?? (input.rebaseSourceInvite === undefined ? input.databaseName : undefined);
	if (typeof issuanceDatabaseName !== "string" || issuanceDatabaseName.length === 0) {
		throw new TypeError("v3 room issuance database name is invalid");
	}
	if (
		input.migrationDatabaseNamespace !== undefined &&
		(typeof input.migrationDatabaseNamespace !== "string" || input.migrationDatabaseNamespace.length === 0)
	) {
		throw new TypeError("v3 room migration database namespace is invalid");
	}
	const migrationScratchDatabaseName = (scratchDigest: string): string =>
		input.migrationDatabaseNamespace === undefined
			? `ts-drp-v3-room-migration--${scratchDigest}`
			: `ts-drp-v3-room-migration--${digest(
					"ts-drp/v3-room-migration-local-store/v1",
					encodeCanonical({ localNamespace: input.migrationDatabaseNamespace, scratchDigest })
				)}`;
	const sourceInvite = input.rebaseSourceInvite;
	const sourceMaterial =
		sourceInvite === undefined
			? undefined
			: decodeCreatorInvite(typeof sourceInvite === "string" ? sourceInvite : encodeCreatorInvite(sourceInvite));
	const objectIdResult = parseStorageObjectId(input.objectId);
	if (!objectIdResult.ok) throw new TypeError("v3 room object id is invalid");
	const inviteAuthority = migrationInviteAuthority(material);
	if (inviteAuthority.objectId !== input.objectId) {
		throw new TypeError("v3 room creator invite object is invalid");
	}
	const roomHeadScope = Object.freeze({
		objectId: input.objectId,
		pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
	});
	const genesisRoomHead = Object.freeze({
		currentAnchorDigest: material.pinnedGenesisAnchorDigest,
		epoch: 0,
		objectId: input.objectId,
	});
	let roomHeadAuthority: V3RoomHeadAuthority | undefined;
	let openedRoomHeadState: V3RoomHeadState | undefined;
	if (!requireFreshTrust && !skipRoomHeadAuthority) {
		const candidate = input.roomHeadAuthority;
		if (
			candidate === undefined ||
			candidate === null ||
			typeof candidate !== "object" ||
			!["begin", "commit", "create", "migrate", "read"].every(
				(method) => typeof Reflect.get(candidate, method) === "function"
			)
		) {
			return roomHeadFailure("D110C_FLOOR_MIGRATION_REQUIRED");
		}
		roomHeadAuthority = candidate;
		// Redirect creation already owns and initializes an independent target
		// floor. Retain/read that actual owner for later healthy adoption; never
		// reuse the source floor or create a replacement to bypass currency.
		openedRoomHeadState =
			redirectSource === undefined
				? await initializeRoomHeadAuthority(candidate, roomHeadScope, genesisRoomHead)
				: await readRoomHeadAuthority(candidate, roomHeadScope);
	}
	const selectRoomStartup = (): "genesis" | "internal" | "successor" => {
		if (requireFreshTrust || skipRoomHeadAuthority) return "internal";
		if (openedRoomHeadState === undefined) return roomHeadFailure("D110C_FLOOR_MIGRATION_REQUIRED");
		if (openedRoomHeadState.pending !== null) return "successor";
		if (redirectSource !== undefined && sameRoomHead(openedRoomHeadState.stable, genesisRoomHead)) return "internal";
		return sameRoomHead(openedRoomHeadState.stable, genesisRoomHead) ? "genesis" : "successor";
	};
	if (selectRoomStartup() === "successor" && input.rebaseSourceInvite !== undefined && redirectSource === undefined) {
		throw new TypeError("v3 room successor authority composition is unsupported");
	}
	const {
		rebaseSourceInvite: _rebaseSourceInvite,
		rebaseSourceStorage: _rebaseSourceStorage,
		...inputWithoutRebase
	} = input;
	const successorAdmissionFactory: NonNullable<CreateV3RoomSessionInput["createOperationAdmissionPolicy"]> = (
		context
	) => createRoomOperationAdmissionPolicy(input, material, context);
	const roomInviteAuthority = input.application.migration === undefined ? undefined : inviteAuthority;
	const migrationActivationAuthority =
		roomInviteAuthority === undefined
			? undefined
			: Object.freeze({
					anchorDigest: material.pinnedGenesisAnchorDigest,
					blueprintDigest: roomInviteAuthority.blueprintDigest,
					creatorAuthor: roomInviteAuthority.creatorAuthor,
					aclDigest: digest("ts-drp/latched-acl/v3", material.exactCanonicalLatchedAclBytes),
					epoch: 0,
					objectId: roomInviteAuthority.objectId,
					signerSetDigest: roomInviteAuthority.signerSetDigest,
				});
	const sourceMigrationActivationAuthority =
		redirectSource === undefined || sourceMaterial === undefined
			? undefined
			: ((): MigrationActivationAuthority => {
					const authority = migrationInviteAuthority(sourceMaterial);
					return Object.freeze({
						anchorDigest: redirectSource.currentSource?.anchorDigest ?? sourceMaterial.pinnedGenesisAnchorDigest,
						blueprintDigest: authority.blueprintDigest,
						creatorAuthor: authority.creatorAuthor,
						objectId: authority.objectId,
						signerSetDigest: authority.signerSetDigest,
					});
				})();
	if (
		redirectSource !== undefined &&
		(migrationActivationAuthority === undefined ||
			sourceMigrationActivationAuthority === undefined ||
			redirectSource.activation.decision.sourceObjectId !== sourceMigrationActivationAuthority.objectId ||
			redirectSource.activation.decision.sourceAnchorDigest !== sourceMigrationActivationAuthority.anchorDigest ||
			redirectSource.activation.decision.sourceBlueprintDigest !== sourceMigrationActivationAuthority.blueprintDigest ||
			redirectSource.activation.decision.sourceCreatorAuthor !== sourceMigrationActivationAuthority.creatorAuthor ||
			redirectSource.activation.decision.targetObjectId !== migrationActivationAuthority.objectId ||
			redirectSource.activation.decision.targetAnchorDigest !== migrationActivationAuthority.anchorDigest ||
			redirectSource.activation.decision.targetBlueprintDigest !== migrationActivationAuthority.blueprintDigest ||
			redirectSource.activation.decision.targetCreatorAuthor !== migrationActivationAuthority.creatorAuthor ||
			sourceMigrationActivationAuthority.signerSetDigest !== migrationActivationAuthority.signerSetDigest)
	) {
		throw new TypeError("v3 room redirect authority is invalid");
	}
	const classifyTerminalVertex =
		migrationActivationAuthority === undefined
			? undefined
			: sourceMigrationActivationAuthority === undefined
				? migrationActivationClassifier(migrationActivationAuthority)
				: (((
						classificationInput: Parameters<RoomTerminalVertexClassifier>[0]
					): ReturnType<RoomTerminalVertexClassifier> => {
						const objectId = classificationInput.vertex.objectId;
						const authority =
							objectId === migrationActivationAuthority.objectId
								? migrationActivationAuthority
								: objectId === sourceMigrationActivationAuthority.objectId
									? sourceMigrationActivationAuthority
									: undefined;
						if (authority === undefined) return "reject";
						return migrationActivationClassifier(authority)(classificationInput);
					}) satisfies RoomTerminalVertexClassifier);
	const redirectHistoryComplete =
		redirectSource === undefined || migrationActivationAuthority === undefined
			? undefined
			: (vertices: readonly V3RoomAcceptedVertex[]): boolean => {
					const decision = redirectSource.activation.decision;
					const ordered = [...vertices].sort(compareAcceptedVertices);
					const recordIndexes = ordered.flatMap((vertex, index) => {
						const operation = detachedRoomOperation(vertex.operation);
						return operation !== undefined &&
							Reflect.get(operation, "action") === "migrationRecord" &&
							hex(vertex.digest) === decision.migrationRecordVertexDigest
							? [index]
							: [];
					});
					const recordIndex = recordIndexes[0];
					if (recordIndexes.length !== 1 || recordIndex === undefined) return false;
					const recordVertex = ordered[recordIndex] as V3RoomAcceptedVertex;
					const recordOperation = detachedRoomOperation(recordVertex.operation);
					const record = migrationRecord(
						recordOperation === undefined ? undefined : Reflect.get(recordOperation, "record")
					);
					if (
						recordOperation === undefined ||
						record === undefined ||
						!validMigrationRecordOperation(recordOperation, recordVertex.author, migrationActivationAuthority) ||
						digest("ts-drp/v3-room-migration-record/v1", encodeCanonical(record)) !== decision.migrationRecordDigest
					) {
						return false;
					}
					const imports = ordered
						.slice(0, recordIndex + 1)
						.flatMap(
							(vertex) => acceptedOperationsForVertex(input.application, vertex, migrationActivationAuthority) ?? []
						)
						.filter(({ operation }) => {
							const action = Reflect.get(operation, "action");
							return typeof action === "string" && input.application.batchableOperationActions.includes(action);
						});
					return (
						imports.length === decision.targetImportOperationCount &&
						digest("ts-drp/v3-room-migration-import/v1", encodeCanonical(imports.map(({ operation }) => operation))) ===
							decision.targetImportOperationsDigest
					);
				};
	type PreparedRoomState = Extract<Awaited<ReturnType<typeof prepareV3LiveGeneration>>, { readonly ok: true }>;
	type RecoveredRoomState = Extract<Awaited<ReturnType<typeof recoverV3LiveReplica>>, { readonly ok: true }>;
	let aheStores: readonly Awaited<ReturnType<V3RoomStorageHost["openAhe"]>>[];
	let issuanceStore: Awaited<ReturnType<V3RoomStorageHost["openIssuance"]>>;
	let journalStore: Awaited<ReturnType<V3RoomStorageHost["openJournal"]>>;
	let sourceJournalStores: readonly Awaited<ReturnType<V3RoomStorageHost["openJournal"]>>[] = [];
	let prepared: PreparedRoomState | undefined;
	let recovered: RecoveredRoomState | undefined;
	let retainedBootstrapHeld = false;
	const creatorCloseStoreClosers: Array<() => Promise<void>> = [];
	if (releaseOwnedRoomHeadAuthority !== undefined) creatorCloseStoreClosers.push(releaseOwnedRoomHeadAuthority);
	let creatorArchiveTask: Promise<NonNullable<BindCreatorLiveCloseInput["archive"]>> | undefined;
	// Existing room lifetime owns the entire admitted archive recovery workflow,
	// including startup export. Public exports are already dispatched by its FIFO.
	const creatorArchiveRecoveryTasks = new Set<Promise<unknown>>();
	const ownCreatorArchive = (): Promise<NonNullable<BindCreatorLiveCloseInput["archive"]> | undefined> => {
		const factory = input.openCreatorArchive;
		if (factory === undefined) return Promise.resolve(undefined);
		if (creatorArchiveTask !== undefined) return creatorArchiveTask;
		creatorArchiveTask = Promise.resolve().then(async () => {
			const opened = await factory(Object.freeze({ databaseName: input.databaseName,
				objectId: input.objectId, pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest }));
			const record = exactRecord(opened, ["store", "limits"]);
			if (record === undefined || record.store === null || typeof record.store !== "object")
				throw new TypeError("v3 creator archive custody is unavailable");
			const store = record.store as NonNullable<BindCreatorLiveCloseInput["archive"]>["store"];
			const close = store.close;
			if (typeof close !== "function") throw new TypeError("v3 creator archive cannot join close");
			creatorCloseStoreClosers.push(() => Reflect.apply(close, store, []));
			// Capture only the bounded local construction policy. The original native
			// store remains the sole capacity/currency owner; no wire authority is minted.
			const limits = decodeCanonical(encodeCanonical(record.limits, { maxBytes: 1024, maxDepth: 4, maxItems: 32 })) as
				NonNullable<BindCreatorLiveCloseInput["archive"]>["limits"];
			return Object.freeze({ store, limits: Object.freeze(limits) });
		});
		return creatorArchiveTask;
	};
	let creatorSigningStores:
		| Readonly<{
				vote: Pick<Awaited<ReturnType<V3RoomStorageHost["openSealVote"]>>, "observation" | "store">;
				evidence: Pick<Awaited<ReturnType<V3RoomStorageHost["openSealEvidence"]>>, "observation" | "store">;
		  }>
		| undefined;
	const ownCreatorSigningStores = async (): Promise<NonNullable<typeof creatorSigningStores>> => {
		if (creatorSigningStores !== undefined) return creatorSigningStores;
		if (input.storageHost.openCreatorSigningStores !== undefined) {
			const opened = await input.storageHost.openCreatorSigningStores(input.databaseName);
			creatorCloseStoreClosers.push(() => opened.close());
			if (opened.vote.observation.incarnation !== opened.evidence.observation.incarnation)
				throw new TypeError("v3 room creator-close storage incarnation differs");
			creatorSigningStores = Object.freeze({vote: opened.vote, evidence: opened.evidence});
			return creatorSigningStores;
		}
		const vote = await input.storageHost.openSealVote(input.databaseName);
		creatorCloseStoreClosers.push(vote.close);
		const evidence = await input.storageHost.openSealEvidence(input.databaseName);
		creatorCloseStoreClosers.push(evidence.close);
		if (vote.observation.incarnation !== evidence.observation.incarnation)
			throw new TypeError("v3 room creator-close storage incarnation differs");
		creatorSigningStores = Object.freeze({ vote, evidence });
		return creatorSigningStores;
	};
	const retainedPromotionDependencies: Readonly<{ releasePromotionDependencies(): Promise<void> }>[] = [];
	const releaseRetainedPromotionDependencies = async (): Promise<void> => {
		const owned = retainedPromotionDependencies.splice(0);
		const joined = await Promise.allSettled(
			owned.map((source) => Promise.resolve().then(() => source.releasePromotionDependencies()))
		);
		const errors = joined.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "v3 room retained promotion cleanup failed");
	};
	let recipientSnapshotStore: Awaited<ReturnType<V3RoomStorageHost["openSnapshots"]>> | undefined;
	let successorServing: ReturnType<typeof createV3SnapshotTransferOwner> | undefined;
	let successorServingScope: Awaited<ReturnType<NonNullable<typeof recipientSnapshotStore>["openScope"]>> | undefined;
	const ownRecipientSnapshots = async (): Promise<NonNullable<typeof recipientSnapshotStore>> => {
		if (recipientSnapshotStore === undefined) {
			recipientSnapshotStore = await input.storageHost.openSnapshots(input.databaseName);
			creatorCloseStoreClosers.push(async () => {
				const failures: unknown[] = [];
				try {
					await releaseRetainedPromotionDependencies();
				} catch (error) {
					failures.push(error);
				}
				try {
					await successorServing?.close();
				} catch (error) {
					failures.push(error);
				}
				try {
					await successorServingScope?.release();
				} catch (error) {
					failures.push(error);
				}
				try {
					await recipientSnapshotStore?.close();
				} catch (error) {
					failures.push(error);
				}
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1) throw new AggregateError(failures, "v3 room recipient snapshot cleanup failed");
			});
		}
		return recipientSnapshotStore;
	};
	let discoveredStores:
		| Readonly<{
				ahe: Awaited<ReturnType<V3RoomStorageHost["openAhe"]>>;
				issuance: Awaited<ReturnType<V3RoomStorageHost["openIssuance"]>>;
				journal: Awaited<ReturnType<V3RoomStorageHost["openJournal"]>>;
		  }>
		| undefined;
	const selectRetainedRoomCustody = async (stores: NonNullable<typeof discoveredStores>): Promise<void> => {
		if (openedRoomHeadState === undefined || roomHeadAuthority === undefined ||
			(openedRoomHeadState.pending !== null && input.openCreatorArchive === undefined)) return;
		const previous = openedRoomHeadState.pending?.previous ?? openedRoomHeadState.stable;
		const archive = await ownCreatorArchive();
		const task = selectRetainedCreatorSuccessorAdoption({
			authenticationProfile: "creator-only",
			catalog: input.application.catalog,
			detachedSignature: material.detachedGenesisSignature,
			exactCanonicalAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
			exactCanonicalGenesisLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
			exactCanonicalPinnedGenesisBootstrapOperationBytes,
			expectedPreviousRoomHead: previous,
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
			snapshotStore: await ownRecipientSnapshots(),
			store: stores.ahe,
			issuanceStore: stores.issuance,
			liveJournalStore: stores.journal,
			author: input.author,
			...(archive === undefined ? {} : { archiveRecovery: { store: archive.store,
				accounting: createCreatorClosedRollbackProofAccounting([], true), roomHeadAuthority } }),
		});
		creatorArchiveRecoveryTasks.add(task);
		let selected: Awaited<typeof task>;
		try { selected = await task; } finally { creatorArchiveRecoveryTasks.delete(task); }
		if (selected === null) return;
		if (openedRoomHeadState.pending !== null && !sameRoomHead(openedRoomHeadState.pending.next, selected.head))
			throw new TypeError("v3 archive startup original pending target conflicts with retained custody");
		if (selected.received !== undefined) {
			const received = selected.received;
			let transferred = false;
			await withCreatorReceivedPromotionDependencies(
				{
					releasePromotionDependencies: () =>
						transferred ? Promise.resolve() : (received.releasePromotionDependencies?.() ?? Promise.resolve()),
				},
				async () => {
					const staged = await stageCreatorSuccessorAdoption({
						handle: received.handle,
						intent: received.verified.intent,
					});
					if (staged.ok !== true)
						throw new TypeError(`v3 room retained successor staging failed: ${String(staged.kind)}`, {
							cause: staged.cause,
						});
					if (roomHeadAuthority === undefined || openedRoomHeadState === undefined)
						return roomHeadFailure("D110C_FLOOR_MIGRATION_REQUIRED");
					if (openedRoomHeadState.pending === null) openedRoomHeadState = await beginRoomHeadAdvance(
						roomHeadAuthority, roomHeadScope, openedRoomHeadState.stable, selected.head);
					if (received.releasePromotionDependencies !== undefined) {
						retainedPromotionDependencies.push({ releasePromotionDependencies: received.releasePromotionDependencies });
						transferred = true;
					}
				}
			);
			return;
		}
		if (openedRoomHeadState.pending === null) openedRoomHeadState = await beginRoomHeadAdvance(
			roomHeadAuthority, roomHeadScope, openedRoomHeadState.stable, selected.head);
	};
	// No genesis preparation, fence acquisition, journal import or old writer may
	// precede native retained-custody selection under the original bootstrap.
	if (selectRoomStartup() !== "internal" && openedRoomHeadState !== undefined && roomHeadAuthority !== undefined &&
		(openedRoomHeadState.pending === null || input.openCreatorArchive !== undefined)) {
		const ahe = await input.storageHost.openAhe(`${input.databaseName}--ahe`);
		let issuance: Awaited<ReturnType<V3RoomStorageHost["openIssuance"]>> | undefined;
		let journal: Awaited<ReturnType<V3RoomStorageHost["openJournal"]>> | undefined;
		try {
			issuance = await input.storageHost.openIssuance(issuanceDatabaseName);
			journal = await input.storageHost.openJournal(input.databaseName);
			await selectRetainedRoomCustody(Object.freeze({ ahe, issuance, journal }));
			if (openedRoomHeadState?.pending !== null) {
				discoveredStores = Object.freeze({ ahe, issuance, journal });
			} else {
				await Promise.all([ahe.close(), issuance.close(), journal.close()]);
			}
		} catch (error) {
			// Join the admitted original recovery and its acquisition before any
			// source/native port closes; retained books do not keep native custody.
			const admittedJoins = await Promise.allSettled([...creatorArchiveRecoveryTasks,
				...(creatorArchiveTask === undefined ? [] : [creatorArchiveTask])]);
			const dependencyJoins = await Promise.allSettled([releaseRetainedPromotionDependencies()]);
			const cleanup = await Promise.allSettled([
				ahe.close(),
				issuance?.close(),
				journal?.close(),
				...creatorCloseStoreClosers.map((closeStore) => Promise.resolve().then(closeStore)),
			]);
			const errors = [...admittedJoins, ...dependencyJoins, ...cleanup]
				.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length > 0)
				throw new AggregateError([error, ...errors], "v3 room retained recovery cleanup failed", { cause: error });
			throw error;
		}
	}
	if (selectRoomStartup() !== "successor") {
		const durable = await prepareDurableRoomState(
			Object.freeze({ ...input, issuanceDatabaseName }),
			material,
			sourceMaterial,
			objectIdResult.value,
			requireFreshTrust,
			classifyTerminalVertex,
			redirectSource,
			redirectHistoryComplete,
			undefined,
			ownedSettlementPolicy
		);
		aheStores = durable.aheStores;
		issuanceStore = durable.issuanceStore;
		journalStore = durable.journalStore;
		sourceJournalStores = durable.sourceJournalStores;
		prepared = durable.prepared;
		recovered = durable.recovered;
		retainedBootstrapHeld = durable.retainedBootstrapHeld;
	} else if (discoveredStores !== undefined) {
		aheStores = Object.freeze([discoveredStores.ahe]);
		issuanceStore = discoveredStores.issuance;
		journalStore = discoveredStores.journal;
	} else {
		const aheStore = await input.storageHost.openAhe(`${input.databaseName}--ahe`);
		let openedIssuanceStore: Awaited<ReturnType<V3RoomStorageHost["openIssuance"]>> | undefined;
		try {
			openedIssuanceStore = await input.storageHost.openIssuance(issuanceDatabaseName);
			journalStore = await input.storageHost.openJournal(input.databaseName);
		} catch (error) {
			await Promise.allSettled([aheStore.close(), openedIssuanceStore?.close()]);
			throw error;
		}
		aheStores = Object.freeze([aheStore]);
		issuanceStore = openedIssuanceStore;
	}
	const roomDescriptor = Object.freeze({
		anchorDigest: prepared?.descriptor.anchorDigest ?? material.pinnedGenesisAnchorDigest,
		blueprintDigest: prepared?.descriptor.blueprintDigest ?? inviteAuthority.blueprintDigest,
		signerSetDigest: prepared?.descriptor.signerSetDigest ?? inviteAuthority.signerSetDigest,
		trustProfile: prepared?.descriptor.trustProfile ?? ("creator-only" as const),
	});
	if (retainedBootstrapHeld) redirectSource?.onRetainedBootstrapHold();
	const recoveredActivations =
		migrationActivationAuthority === undefined || recovered === undefined
			? []
			: recovered.descriptor.recoveredVertices.flatMap((vertex) => {
					const operation = detachedRoomOperation(vertex.operation);
					if (operation === undefined || Reflect.get(operation, "action") !== "migrationActivation") return [];
					const activation = migrationActivationOperation(operation, vertex.author, migrationActivationAuthority);
					return activation === undefined ? [] : [authenticatedMigrationActivation(activation, hex(vertex.digest))];
				});
	if (recoveredActivations.length > 1) {
		await Promise.allSettled([
			issuanceStore.close(),
			journalStore.close(),
			...sourceJournalStores.map((store) => store.close()),
			...aheStores.map((store) => store.close()),
		]);
		throw new TypeError("v3 room migration activation history is invalid");
	}
	let recoveredActivation = recoveredActivations[0];
	const acceptedVertices = new Map<string, V3RoomAcceptedVertex>();
	const acceptedOperationRows = new Map<string, readonly V3RoomAcceptedOperation[] | null>();
	let projection!: Projection;
	// Opt-in display overlay. It receives copies and notifications only; every
	// call is isolated so a presentation fault can never fail a durable step.
	let presentation: PresentationOverlay<Projection> | undefined;
	const presentationHook = (action: (overlay: PresentationOverlay<Projection>) => void): void => {
		if (presentation === undefined) return;
		try {
			action(presentation);
		} catch {
			// Display-only failure; the durable projection is already final.
		}
	};
	let activeHandle: RoomPlaneHandle | undefined;
	let authenticatedProjectionBase: V3RoomAuthenticatedProjectionBase | undefined;
	let successorProjectionAuthority: V3RoomSuccessorAuthority | null = null;
	const refreshRoomHeadState = async (): Promise<void> => {
		if (selectRoomStartup() === "internal") return;
		if (roomHeadAuthority === undefined) return roomHeadFailure("D110C_FLOOR_MIGRATION_REQUIRED");
		const refreshed = await readRoomHeadAuthority(roomHeadAuthority, roomHeadScope);
		const current = activeHandle?.currentEphemeralAuthority() ?? successorProjectionAuthority;
		const expected = refreshed.pending?.next ?? refreshed.stable;
		if (current !== undefined && current !== null) {
			if (expected.epoch < current.epoch) return roomHeadFailure("D110C_FLOOR_REGRESSION");
			if (
				expected.objectId !== current.objectId ||
				(expected.epoch === current.epoch && expected.currentAnchorDigest !== current.anchorDigest)
			) {
				return roomHeadFailure("D110C_FLOOR_MISMATCH");
			}
		}
		openedRoomHeadState = refreshed;
	};
	let logicalTime = input.initialLogicalTime;
	const roomCreatorAuthor = roomInviteAuthority === undefined ? input.author : roomInviteAuthority.creatorAuthor;
	const currentMigrationRecordAuthority = (): MigrationRecordAuthority | undefined =>
		input.application.migration === undefined
			? undefined
			: Object.freeze({
					aclDigest:
						successorProjectionAuthority?.aclDigest ??
						digest("ts-drp/latched-acl/v3", material.exactCanonicalLatchedAclBytes),
					epoch: successorProjectionAuthority?.epoch ?? 0,
					anchorDigest: successorProjectionAuthority?.anchorDigest ?? roomDescriptor.anchorDigest,
					blueprintDigest: roomDescriptor.blueprintDigest,
					creatorAuthor: roomCreatorAuthor,
					objectId: input.objectId,
				});
	const currentMigrationActivationAuthority = (): MigrationActivationAuthority | undefined => {
		const current = currentMigrationRecordAuthority();
		return current === undefined || migrationActivationAuthority === undefined
			? undefined
			: Object.freeze({
					...current,
					signerSetDigest: migrationActivationAuthority.signerSetDigest,
				});
	};
	const orderedProjectionVertices = (
		selected: ReadonlyMap<string, V3RoomAcceptedVertex>,
		recoveryOrder?: V3ApplicationProjectionOrder
	): readonly V3RoomAcceptedVertex[] => {
		const activeOrder =
			recoveryOrder === undefined && activeHandle !== undefined
				? readV3ApplicationProjectionOrder({ plane: activeHandle })
				: undefined;
		if (activeOrder !== undefined && !activeOrder.ok) {
			throw new TypeError(`v3 room application projection order is unavailable: ${activeOrder.kind}`);
		}
		const order =
			recoveryOrder ??
			(activeOrder?.ok === true ? activeOrder.order : recovered?.descriptor.applicationProjectionOrder);
		const expectedEpoch = successorProjectionAuthority?.epoch ?? 0;
		const expectedAnchor = successorProjectionAuthority?.anchorDigest ?? roomDescriptor.anchorDigest;
		if (
			order === undefined ||
			exactRecord(order, ["objectId", "epoch", "anchorDigest", "digests", "controlDigests"]) === undefined ||
			order.objectId !== input.objectId ||
			order.epoch !== expectedEpoch ||
			order.anchorDigest !== expectedAnchor ||
			!Array.isArray(order.digests) ||
			!Array.isArray(order.controlDigests)
		) {
			throw new TypeError("v3 room application projection order scope differs");
		}
		const ranks = new Map<string, number>();
		for (const [index, digest] of order.digests.entries()) {
			if (typeof digest !== "string" || !LOWER_HEX_256.test(digest) || digest === expectedAnchor || ranks.has(digest)) {
				throw new TypeError("v3 room application projection order is invalid");
			}
			ranks.set(digest, index);
		}
		const controls = new Set<string>();
		for (const [index, digest] of order.controlDigests.entries()) {
			if (
				typeof digest !== "string" ||
				!LOWER_HEX_256.test(digest) ||
				digest === expectedAnchor ||
				ranks.has(digest) ||
				(index > 0 && (order.controlDigests[index - 1] as string) >= digest)
			) {
				throw new TypeError("v3 room application projection order controls are invalid");
			}
			controls.add(digest);
		}
		for (const [digest, vertex] of selected) {
			if (
				(!ranks.has(digest) && !controls.has(digest)) ||
				vertex.objectId !== input.objectId ||
				vertex.epoch !== expectedEpoch
			) {
				throw new TypeError("v3 room application projection order omits an accepted vertex");
			}
		}
		return [...selected.values()]
			.filter((vertex) => !controls.has(hex(vertex.digest)))
			.sort((left, right) => (ranks.get(hex(left.digest)) as number) - (ranks.get(hex(right.digest)) as number));
	};
	const expand = (vertex: V3RoomAcceptedVertex): readonly V3RoomAcceptedOperation[] | undefined => {
		const identity = hex(vertex.digest);
		const cached = acceptedOperationRows.get(identity);
		if (cached !== undefined) return cached === null ? undefined : cached;
		const expanded = acceptedOperationsForVertex(input.application, vertex, currentMigrationRecordAuthority());
		acceptedOperationRows.set(identity, expanded ?? null);
		return expanded;
	};
	const stage = (
		vertices: readonly V3RoomAcceptedVertex[],
		recoveryOrder?: V3ApplicationProjectionOrder
	): Readonly<{
		readonly additions: readonly Readonly<{ readonly identity: string; readonly vertex: V3RoomAcceptedVertex }>[];
		readonly projection: Projection;
	}> => {
		const candidate = new Map(acceptedVertices);
		const additions: Readonly<{ readonly identity: string; readonly vertex: V3RoomAcceptedVertex }>[] = [];
		const selected = new Map(acceptedVertices);
		for (const vertex of vertices) selected.set(hex(vertex.digest), vertex);
		for (const vertex of orderedProjectionVertices(selected, recoveryOrder)) {
			const identity = hex(vertex.digest);
			if (candidate.has(identity)) continue;
			const expanded = expand(vertex);
			if (expanded === undefined) continue;
			candidate.set(identity, vertex);
			additions.push(Object.freeze({ identity, vertex }));
		}
		const project = (selected: ReadonlyMap<string, V3RoomAcceptedVertex>): Projection => {
			const currentEpochOperations = Object.freeze(
				orderedProjectionVertices(selected, recoveryOrder).flatMap((vertex) => expand(vertex) ?? [])
			);
			const baseBytes =
				authenticatedProjectionBase === undefined
					? undefined
					: new INTRINSIC_UINT8_ARRAY(authenticatedProjectionBase.exactCanonicalApplicationStateBytes);
			const authenticatedBase =
				authenticatedProjectionBase === undefined || baseBytes === undefined
					? undefined
					: Object.freeze({
							blueprintDigest: authenticatedProjectionBase.blueprintDigest,
							epoch: authenticatedProjectionBase.epoch,
							exactCanonicalApplicationStateBytes: baseBytes,
							objectId: authenticatedProjectionBase.objectId,
							stateDigest: authenticatedProjectionBase.stateDigest,
						});
			const projected = input.application.projectAcceptedOperations(
				Object.freeze({ authenticatedBase, currentEpochOperations })
			);
			if (
				authenticatedProjectionBase !== undefined &&
				(baseBytes === undefined ||
					!sameBytes(baseBytes, authenticatedProjectionBase.exactCanonicalApplicationStateBytes))
			) {
				throw new TypeError("v3 room authenticated projection base was mutated");
			}
			return projected;
		};
		try {
			return Object.freeze({ additions: Object.freeze(additions), projection: project(candidate) });
		} catch {
			const contained = new Map(acceptedVertices);
			const acceptedAdditions: Readonly<{
				readonly identity: string;
				readonly vertex: V3RoomAcceptedVertex;
			}>[] = [];
			let containedProjection: Projection | undefined;
			for (const addition of additions) {
				contained.set(addition.identity, addition.vertex);
				try {
					containedProjection = project(contained);
					acceptedAdditions.push(addition);
				} catch (error) {
					const action = Reflect.get(addition.vertex.operation, "action");
					if (
						Object.getPrototypeOf(error) !== TypeError.prototype ||
						(action !== "applicationBatch" &&
							action !== "migrationRecord" &&
							(typeof action !== "string" || !input.application.batchableOperationActions.includes(action)))
					) {
						throw error;
					}
					contained.delete(addition.identity);
					acceptedOperationRows.set(addition.identity, null);
				}
			}
			return Object.freeze({
				additions: Object.freeze(acceptedAdditions),
				projection: containedProjection ?? project(contained),
			});
		}
	};
	const installSuccessorProjectionBase = (plane: RoomPlaneHandle, authority: V3RoomSuccessorAuthority): void => {
		const projectionBaseResult = bindV3BlueprintLivePlane({ plane, purpose: "projection-base" });
		if (!projectionBaseResult.ok) {
			throw new TypeError(`v3 room successor projection base failed: ${projectionBaseResult.kind}`);
		}
		if (exactRecord(projectionBaseResult, PROJECTION_BASE_RESULT_KEYS) === undefined) {
			throw new TypeError("v3 room successor projection base differs");
		}
		const exactCanonicalApplicationStateBytes = normalizeApplicationStateBytes(
			projectionBaseResult.exactCanonicalApplicationStateBytes,
			"migration"
		);
		if (
			projectionBaseResult.objectId !== input.objectId ||
			projectionBaseResult.epoch !== authority.epoch ||
			projectionBaseResult.blueprintDigest !== roomDescriptor.blueprintDigest ||
			projectionBaseResult.stateDigest !== digest("ts-drp/state/v3", exactCanonicalApplicationStateBytes)
		) {
			throw new TypeError("v3 room successor projection base differs");
		}
		const base = Object.freeze({
			blueprintDigest: projectionBaseResult.blueprintDigest,
			epoch: projectionBaseResult.epoch,
			exactCanonicalApplicationStateBytes,
			objectId: projectionBaseResult.objectId,
			stateDigest: projectionBaseResult.stateDigest,
		});
		const baseProjection = input.application.projectAcceptedOperations(
			Object.freeze({ authenticatedBase: base, currentEpochOperations: Object.freeze([]) })
		);
		const canonicalStateBytes = input.application.migration?.canonicalStateBytes;
		if (typeof canonicalStateBytes !== "function") {
			throw new TypeError("v3 room successor projection state is unavailable");
		}
		const projectedStateBytes = normalizeApplicationStateBytes(
			Reflect.apply(canonicalStateBytes, input.application.migration, [baseProjection]) as Uint8Array,
			"migration"
		);
		if (!sameBytes(projectedStateBytes, exactCanonicalApplicationStateBytes)) {
			throw new TypeError("v3 room successor projection state differs");
		}
		authenticatedProjectionBase = base;
		acceptedVertices.clear();
		acceptedOperationRows.clear();
		presentationHook((overlay) => overlay.epochChanged(authority.epoch));
	};
	const commit = async (
		vertices: readonly V3RoomAcceptedVertex[],
		recoveryOrder?: V3ApplicationProjectionOrder
	): Promise<boolean> => {
		for (const vertex of vertices) {
			const expanded = expand(vertex);
			const latestChild = expanded?.at(-1)?.logicalTime ?? vertex.logicalTime;
			logicalTime = Math.max(logicalTime, vertex.logicalTime + 2, latestChild + 2);
		}
		const candidate = stage(vertices, recoveryOrder);
		presentationHook((overlay) =>
			overlay.durableRefused(
				vertices.map((vertex) => hex(vertex.digest)).filter((identity) => acceptedOperationRows.get(identity) === null)
			)
		);
		if (candidate.additions.length === 0) return false;
		for (const { vertex } of candidate.additions) await input.onAcceptedVertex(vertex);
		input.onProjection(candidate.projection);
		for (const { identity, vertex } of candidate.additions) {
			acceptedVertices.set(identity, vertex);
			logicalTime = Math.max(logicalTime, vertex.logicalTime + 2);
		}
		projection = candidate.projection;
		// Confirmation is atomic with the durable projection that now contains the
		// move: one synchronous step removes the pending copy and re-bases the rest.
		presentationHook((overlay) =>
			overlay.durableCommitted(
				candidate.additions.map(({ identity, vertex }) => Object.freeze({ identity, rows: expand(vertex) ?? [] }))
			)
		);
		return true;
	};
	const acceptedOperationSnapshot = (): readonly V3RoomAcceptedOperation[] =>
		Object.freeze(
			orderedProjectionVertices(acceptedVertices)
				.flatMap((vertex) => expand(vertex) ?? [])
				.map((row) => {
					const operation = detachedRoomOperation(row.operation);
					if (operation === undefined) throw new TypeError("v3 room migration operation is invalid");
					return Object.freeze({ ...row, operation });
				})
		);
	const acceptedRowsEvidence = (rows: readonly V3RoomAcceptedOperation[]): Uint8Array =>
		encodeCanonical(
			rows.map((row) =>
				Object.freeze({
					author: row.author,
					authorSequence: row.authorSequence,
					exactCanonicalOperationBytes: encodeCanonical(row.operation),
					logicalTime: row.logicalTime,
					operationCount: row.operationCount,
					operationIndex: row.operationIndex,
					vertexDigest: row.vertexDigest,
				})
			)
		);
	if (selectRoomStartup() !== "successor") {
		try {
			if (
				!(await commit(
					recovered?.descriptor.recoveredVertices ?? Object.freeze([]),
					recovered?.descriptor.applicationProjectionOrder
				))
			) {
				projection = input.application.projectAcceptedOperations(
					Object.freeze({ authenticatedBase: undefined, currentEpochOperations: Object.freeze([]) })
				);
				input.onProjection(projection);
			}
		} catch (error) {
			await Promise.all([
				issuanceStore.close(),
				journalStore.close(),
				...sourceJournalStores.map((store) => store.close()),
				...aheStores.map((store) => store.close()),
			]);
			throw error;
		}
	}
	const recoveredProjectionRejected = (recovered?.descriptor.recoveredVertices ?? Object.freeze([])).some(
		(vertex) =>
			!recovered?.descriptor.applicationProjectionOrder.controlDigests.includes(hex(vertex.digest)) &&
			vertex.author === input.author &&
			acceptedOperationRows.get(hex(vertex.digest)) === null
	);
	if (input.presentation !== undefined) {
		// Durable rows are re-derived only when the durable projection or its
		// authenticated base changes, never per pending move.
		let durableRows: readonly PresentationRow[] = Object.freeze([]);
		let durableRowsKey: readonly [Projection, V3RoomAuthenticatedProjectionBase | undefined] | undefined;
		presentation = createPresentationOverlay<Projection>({
			localAuthor: input.author,
			options: input.presentation,
			batchableOperationActions: input.application.batchableOperationActions,
			durable: () =>
				Object.freeze({
					projection,
					epoch: successorProjectionAuthority?.epoch ?? 0,
					rows: (): readonly PresentationRow[] => {
						if (durableRowsKey?.[0] !== projection || durableRowsKey[1] !== authenticatedProjectionBase) {
							durableRows = Object.freeze(
								orderedProjectionVertices(acceptedVertices).flatMap((vertex) => expand(vertex) ?? [])
							);
							durableRowsKey = [projection, authenticatedProjectionBase];
						}
						return durableRows;
					},
				}),
			project: (rows) => {
				const base = authenticatedProjectionBase;
				return input.application.projectAcceptedOperations(
					Object.freeze({
						authenticatedBase:
							base === undefined
								? undefined
								: Object.freeze({
										blueprintDigest: base.blueprintDigest,
										epoch: base.epoch,
										exactCanonicalApplicationStateBytes: new INTRINSIC_UINT8_ARRAY(
											base.exactCanonicalApplicationStateBytes
										),
										objectId: base.objectId,
										stateDigest: base.stateDigest,
									}),
						currentEpochOperations: rows,
					})
				);
			},
			now: () => performance.now(),
			setTimer: (callback, milliseconds) => {
				const handle = setTimeout(callback, milliseconds);
				(handle as { unref?: () => void }).unref?.();
				return handle;
			},
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		});
	}
	// Display authentication costs one more signature check, so it runs in its own
	// task after the durable ingress step is queued and overlaps admission's
	// storage wait instead of delaying it. A stale plane refuses as inactive.
	const presentRemoteIngress = (message: Message): void => {
		const plane = activeHandle;
		if (plane === undefined || presentation === undefined) return;
		setTimeout(() => presentSignedIngress(plane, message), 0);
	};
	const presentSignedIngress = (plane: V3PlaneHandle, message: Message): void => {
		presentationHook((overlay) => {
			const speculated = speculateV3IngressVertex({ plane, message });
			if (!speculated.ok || overlay.hasRemoteSigned(speculated.vertexDigest)) return;
			const rows = acceptedOperationsForVertex(input.application, speculated.vertex, currentMigrationRecordAuthority());
			if (rows === undefined) return;
			overlay.addRemoteVertex(
				Object.freeze({
					author: speculated.vertex.author,
					epoch: speculated.vertex.epoch,
					logicalTime: speculated.vertex.logicalTime,
					vertexDigest: speculated.vertexDigest,
					rows,
				})
			);
		});
	};
	const presentationIntentBindings = new Set<() => void>();
	const messageQueueManager = new MessageQueueManager<Message>({ logConfig: { level: "silent" } });
	let recoverStartupPlane: (() => Promise<void>) | undefined;
	let creatorCloseHandle: CreatorLiveCloseHandle | undefined;
	let bindCurrentCreatorClose: ((plane: RoomPlaneHandle) => ReturnType<typeof bindCreatorLiveClose>) | undefined;
	let creatorCloseUnavailableContinuity: CreatorLiveCloseStatus["continuity"] = "continuous";
	const readSuccessorExportMaterial = async (): ReturnType<typeof readCreatorSuccessorExport> => {
		const store = aheStores[0];
		if (store === undefined) throw new TypeError("creator successor native store is unavailable");
		const archive = await ownCreatorArchive();
		return readCreatorSuccessorExport({
			...(archive === undefined ? {} : { archiveRecovery: { store: archive.store,
				// Same original complete accounting owner, one fresh maintenance/recovery
				// call. Original export and promotion reads share this ledger and charge PRE.
				accounting: createCreatorClosedRollbackProofAccounting([], true),
				roomHeadAuthority: input.roomHeadAuthority } }),
			store,
			catalog: input.application.catalog,
			snapshotStore: await ownRecipientSnapshots(),
			objectId: objectIdResult.value,
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
			exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
			detachedGenesisSignature: material.detachedGenesisSignature,
		});
	};
	const readSuccessorExport = (): ReturnType<typeof readCreatorSuccessorExport> => {
		if (input.openCreatorArchive === undefined) return readSuccessorExportMaterial();
		assertSessionOpen(); // New recovery admissions revoke with the original room.
		const task = readSuccessorExportMaterial();
		creatorArchiveRecoveryTasks.add(task);
		void task.then(() => creatorArchiveRecoveryTasks.delete(task), () => creatorArchiveRecoveryTasks.delete(task));
		return task;
	};
	const serveSuccessor = async (): Promise<CreatorSuccessorOffer> => {
		if (transport === undefined || activeHandle === undefined)
			throw new TypeError("creator successor transport is unavailable");
		const exported = await readSuccessorExport();
		await successorServing?.close();
		await successorServingScope?.release();
		successorServingScope = await (await ownRecipientSnapshots()).openScope(exported.declaration);
		const port = createSnapshotChunkProtocolPort(transport.networkNode, CREATOR_SUCCESSOR_PROTOCOL);
		const server = createCreatorSuccessorMaterialServer({
			...(input.application.snapshotReadPolicy === "authenticated-public"
				? { isAuthorizedReader: (): boolean => true }
				: {}),
			identity: {
				author: input.author,
				sign: input.signRegisteredVertexDigest,
				isAuthorizedAuthor: (author): boolean =>
					activeHandle?.currentEphemeralAuthority()?.isCurrentWriter(author) === true,
			},
			localPeerId: port.localPeerId,
			manifestDigest: exported.declaration.scope.manifestDigest,
			material: exported.material,
			connectedPeers: () => port.connectedPeers(),
		});
		successorServing = createV3SnapshotTransferOwner({ transport: port });
		successorServing.serve({
			...server,
			descriptors: exported.declaration.chunks,
			exactCanonicalManifestBytes: exported.offer.exactCanonicalSnapshotManifestBytes,
			quarantine: successorServingScope,
		});
		return exported.offer;
	};
	const serveAvailableSuccessor = async (): Promise<void> => {
		// Serving is optional for a field-free local close. An explicit public export
		// still calls serveSuccessor and requires the real protocol owner.
		if (
			transport === undefined ||
			typeof Reflect.get(transport.networkNode, "createSnapshotChunkProtocolHost") !== "function"
		)
			return;
		try {
			await serveSuccessor();
		} catch (error) {
			if (!(error instanceof CreatorSuccessorExportUnavailable)) throw error;
		}
	};
	let transport: V3RoomTransport | undefined;
	const explicitSettlementSourceAuthorization = input.authorizeSettlementSource !== undefined;
	let authorizeSettlementSource = input.authorizeSettlementSource;
	let terminalFailure: unknown = recoveredProjectionRejected
		? new TypeError("v3 room recovered operation was not accepted by projection")
		: undefined;
	let closed = false;
	let creatorCloseRebindFailure: TypeError | undefined;
	let cancelRedirectCreation!: () => void;
	const redirectCancellation = new Promise<void>((resolve) => {
		cancelRedirectCreation = resolve;
	});
	let reportRedirectBootstrapHold!: () => void;
	const redirectBootstrapHold = new Promise<void>((resolve) => {
		reportRedirectBootstrapHold = resolve;
	});
	let closePromise: Promise<void> | undefined;
	let sessionCloseTask: Promise<void> | undefined;
	let creatorSuccessorAdoptionTask: Promise<void> | undefined;
	let creatorRecipientRecoveryRequired = false;
	let redirectedSession: V3RoomSession<Projection> | undefined;
	let redirectPromise: Promise<V3RoomSession<Projection>> | undefined;
	let preparingMigrationTargetFloorScope: Readonly<{ objectId: string; pinnedGenesisAnchorDigest: string }> | undefined;
	let preparingMigrationTargetFloorBorrow: (() => Promise<NativeReadReservation | undefined>) | undefined;
	let settlementHeld = false;
	let settlementAuthorizationHeld = false;
	const assertSettlementUnheld = (): void => {
		if (settlementAuthorizationHeld)
			throw new TypeError(
				"v3 room exact source-to-target creator authorization is required; protected work remains recoverable"
			);
		if (settlementHeld) {
			const error = new TypeError(SETTLEMENT_MANUAL_REVIEW_MESSAGE);
			settlementManualReviewErrors.add(error);
			throw error;
		}
	};
	let retainedBootstrapReady = !retainedBootstrapHeld;
	let resolveRetainedBootstrap: (() => void) | undefined;
	let rejectRetainedBootstrap: ((reason: unknown) => void) | undefined;
	const retainedBootstrapBarrier = retainedBootstrapHeld
		? new Promise<void>((resolve, reject) => {
				resolveRetainedBootstrap = resolve;
				rejectRetainedBootstrap = reject;
			})
		: Promise.resolve();
	const waitForRetainedBootstrap = async (): Promise<void> => {
		const outcome = await Promise.race([
			retainedBootstrapBarrier.then(() => "ready" as const),
			...(redirectSource === undefined ? [] : [redirectSource.cancelled.then(() => "cancelled" as const)]),
		]);
		if (outcome === "cancelled") throw new TypeError("v3 room retained bootstrap was cancelled");
	};
	const combineFailures = (primary: unknown, cleanup: unknown): AggregateError =>
		new AggregateError([primary, cleanup], primary instanceof Error ? primary.message : String(primary));
	const throwAfterJoinedCleanup = async (
		primary: unknown,
		cleanup: readonly (() => void | Promise<void>)[]
	): Promise<never> => {
		const outcomes = await Promise.allSettled(cleanup.map((release) => Promise.resolve().then(release)));
		const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
		if (failures.length > 0)
			throw new AggregateError([primary, ...failures], primary instanceof Error ? primary.message : String(primary));
		throw primary;
	};
	const selectionApprovalControllers = new Set<AbortController>();
	let transportCloseTask: Promise<void> | undefined;
	let unbindMissingDependencyRequest: (() => void) | undefined;
	// Track X (decision row 51): a gossip republication of retained history waits for
	// a subscriber inside the plane's FIFO. On a settlement creator it runs after the startup
	// barrier, so the barrier's local drain and readiness never queue behind it. A reply to a
	// requesting peer (a direct stream, no subscriber wait) is not held.
	let startupGossipRepublicationBarrier: Promise<void> | undefined;
	let heldStartupGossipRepublication: Promise<void> | undefined;
	// Ask the creator for retained history now (Track X). The transport bounds it; a refusal
	// is not a room failure: the next vertex that waits for a missing dependency asks again.
	const requestMissingRetainedHistory = (): void => {
		if (closed || transportCloseTask !== undefined) return;
		const request = transport?.requestMissingRetainedHistory;
		if (typeof request !== "function") return;
		try {
			Reflect.apply(request, transport, []);
		} catch {
			// Bounded transport refusal; nothing was admitted or released.
		}
	};
	const revokeTransport = (): void => {
		for (const controller of selectionApprovalControllers) controller.abort();
		unbindMissingDependencyRequest?.();
		unbindMissingDependencyRequest = undefined;
		if (transportCloseTask !== undefined) return;
		try {
			// close revokes/cancels synchronously; its promise joins admitted work.
			transportCloseTask = Promise.resolve(transport?.close());
		} catch (error) {
			transportCloseTask = Promise.reject(error);
		}
		void transportCloseTask.catch(() => undefined);
	};
	const closePresentation = (): void => {
		for (const unbind of [...presentationIntentBindings]) unbind();
		presentationHook((overlay) => overlay.close());
	};
	const shutdown = (): Promise<void> => {
		if (closePromise !== undefined) return closePromise;
		closed = true;
		closePresentation();
		revokeTransport();
		cancelRedirectCreation();
		if (!retainedBootstrapReady) {
			rejectRetainedBootstrap?.(new TypeError("v3 room session closed before retained bootstrap completed"));
		}
		closePromise = (async (): Promise<void> => {
			const failures: unknown[] = [];
			// closed=true already revoked new entries. Join admitted commit -> original
			// head-CAS -> readback before closing ANY of this workflow's native stores.
			await Promise.allSettled([...creatorArchiveRecoveryTasks]);
			if (creatorCloseHandle !== undefined) {
				try {
					await creatorCloseHandle.stop();
				} catch (error) {
					failures.push(error);
				}
			}
			try {
				if (activeHandle !== undefined) await deactivateV3LivePlaneJoined(activeHandle);
			} catch (error) {
				failures.push(error);
			}
			try {
				messageQueueManager.closeAll();
			} catch (error) {
				failures.push(error);
			}
			try {
				await transportCloseTask;
			} catch (error) {
				failures.push(error);
			}
			// A pending factory may have entered before shutdown. Join it before
			// taking the closer list so a late-acquired native handle cannot escape.
			if (creatorArchiveTask !== undefined) {
				try { await creatorArchiveTask; } catch (error) { failures.push(error); }
			}
			for (const result of await Promise.allSettled([
				...creatorCloseStoreClosers.map((closeStore) => closeStore()),
				issuanceStore.close(),
				journalStore.close(),
				...sourceJournalStores.map((store) => store.close()),
				...aheStores.map((store) => store.close()),
			])) {
				if (result.status === "rejected") failures.push(result.reason);
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "v3 room shutdown failed");
		})();
		return closePromise;
	};
	const createRedirectSession = async (
		activation: AuthenticatedMigrationActivation
	): Promise<
		Readonly<{
			activateMigrationTargetCallbacks(): void;
			migrationTargetObjectId(): string;
			releaseCallbacks(): Promise<void>;
			session: V3RoomSession<Projection>;
		}>
	> => {
		const sourcePlane = activeHandle;
		const prepareCurrentSource =
			authenticatedProjectionBase === undefined
				? undefined
				: (): Promise<V3TerminalMigrationSource> => {
						if (sourcePlane === undefined || activeHandle !== sourcePlane)
							return Promise.reject(new TypeError("migration source owner changed"));
						return prepareV3TerminalMigrationSource(sourcePlane, activation.activationVertexDigest);
					};
		const currentSource = await prepareCurrentSource?.();
		if (
			currentSource !== undefined &&
			(currentSource.anchorDigest !== activation.decision.sourceAnchorDigest ||
				currentSource.objectId !== activation.decision.sourceObjectId ||
				currentSource.blueprintDigest !== activation.decision.sourceBlueprintDigest ||
				currentSource.signerSetDigest !== migrationActivationAuthority?.signerSetDigest)
		)
			throw new TypeError("migration current source authority differs");
		const rehearsalNonce = activation.decision.rehearsalNonce as Uint8Array;
		const targetObjectId = activation.decision.targetObjectId as string;
		const scratchDigest = digest(
			"ts-drp/v3-room-migration-scratch/v1",
			encodeCanonical({ rehearsalNonce, sourceObjectId: input.objectId, targetObjectId })
		);
		const scratchDatabaseName = migrationScratchDatabaseName(scratchDigest);
		// The redirected object has an independent whole-floor identity. Sharing
		// the source's single-object native floor breaks exclusion and scope checks.
		const targetMaterial = activation.targetCreatorInvite;
		const preparedTargetFloor =
			preparingMigrationTargetFloorScope?.objectId === targetObjectId &&
			preparingMigrationTargetFloorScope.pinnedGenesisAnchorDigest === targetMaterial.pinnedGenesisAnchorDigest;
		const targetFloor = await input.storageHost.openRoomHead(`${scratchDatabaseName}--room-head`, {
			kind: recoveredActivation !== undefined || preparedTargetFloor ? "reopen" : "create",
		});
		const acquireTargetFloorReservation = targetFloor.acquireNativeReadReservation;
		const targetFloorOwner =
			preparedTargetFloor && acquireTargetFloorReservation !== undefined
				? Object.freeze({
						...targetFloor,
						acquireNativeReadReservation: async (
							request: Parameters<NonNullable<typeof targetFloor.acquireNativeReadReservation>>[0]
						) => {
							if (
								request.scope.objectId === targetObjectId &&
								request.scope.pinnedGenesisAnchorDigest === targetMaterial.pinnedGenesisAnchorDigest
							) {
								const borrowed = await preparingMigrationTargetFloorBorrow?.();
								if (borrowed !== undefined) return borrowed;
							}
							return Reflect.apply(acquireTargetFloorReservation, targetFloor, [request]) as ReturnType<
								typeof acquireTargetFloorReservation
							>;
						},
					})
				: targetFloor;
		try {
			const targetScope = {
				objectId: targetObjectId,
				pinnedGenesisAnchorDigest: targetMaterial.pinnedGenesisAnchorDigest,
			};
			const existingTargetFloor = await callRoomHeadAuthority(
				() => targetFloor.read({ scope: targetScope }),
				targetScope
			);
			if (existingTargetFloor === null) {
				// recoveredActivation is original authenticated journal/replay state,
				// not a wire flag. Recovery cannot recreate a lost protected floor.
				if (recoveredActivation !== undefined || preparedTargetFloor)
					return roomHeadFailure("D110C_FLOOR_MIGRATION_REQUIRED");
				await initializeRoomHeadAuthority(targetFloor, targetScope, {
					objectId: targetObjectId,
					currentAnchorDigest: targetMaterial.pinnedGenesisAnchorDigest,
					epoch: 0,
				});
			}
			const acceptedVertices: AdmittedReceivedVertexView[] = [];
			let callbacksReady = false;
			let migrationTargetCallbacksReady = false;
			let pendingProjection: Projection | undefined;
			let selectedTargetObjectId = targetObjectId;
			let selectedSession: V3RoomSession<Projection> | undefined;
			const attempt = createV3RoomSessionOwned(
				Object.freeze({
					...inputWithoutRebase,
					creatorInvite: activation.targetCreatorInvite,
					databaseName: scratchDatabaseName,
					issuanceDatabaseName: `${scratchDatabaseName}--issuance`,
					objectId: targetObjectId,
					roomHeadAuthority: targetFloorOwner,
					onAcceptedVertex: (vertex: AdmittedReceivedVertexView): void | Promise<void> => {
						if (callbacksReady) return input.onAcceptedVertex(vertex);
						acceptedVertices.push(vertex);
					},
					onMigrationTarget: (_target: V3RoomSession<Projection>, nestedTargetObjectId: string): void => {
						selectedTargetObjectId = nestedTargetObjectId;
						if (migrationTargetCallbacksReady && selectedSession !== undefined) {
							input.onMigrationTarget?.(selectedSession, nestedTargetObjectId);
						}
					},
					onProjection: (targetProjection: Projection): void => {
						if (callbacksReady) {
							input.onProjection(targetProjection);
							return;
						}
						pendingProjection = targetProjection;
					},
					rebaseSourceInvite: material,
				}),
				false,
				Object.freeze({
					activation,
					...(currentSource === undefined ? {} : { currentSource, prepareCurrentSource }),
					cancelled: redirectCancellation,
					issuanceStore,
					journalStore,
					roomHeadAuthority: input.roomHeadAuthority,
					onRetainedBootstrapHold: reportRedirectBootstrapHold,
				}),
				false,
				targetFloor.close,
				localOwner
			);
			return await attempt.then((session) => {
				selectedSession = session;
				return Object.freeze({
					activateMigrationTargetCallbacks(): void {
						migrationTargetCallbacksReady = true;
					},
					migrationTargetObjectId(): string {
						return selectedTargetObjectId;
					},
					async releaseCallbacks(): Promise<void> {
						while (acceptedVertices.length > 0) {
							const selected = acceptedVertices.splice(0);
							for (const vertex of selected) await input.onAcceptedVertex(vertex);
						}
						callbacksReady = true;
						const selectedProjection = pendingProjection;
						pendingProjection = undefined;
						if (selectedProjection !== undefined) input.onProjection(selectedProjection);
					},
					session,
				});
			});
		} catch (error) {
			try {
				await targetFloor.close();
			} catch (cleanup) {
				throw combineFailures(error, cleanup);
			}
			throw error;
		}
	};
	const ensureRedirect = (activation: AuthenticatedMigrationActivation): Promise<V3RoomSession<Projection>> => {
		if (redirectedSession !== undefined) return Promise.resolve(redirectedSession);
		if (redirectPromise !== undefined) return redirectPromise;
		const attempt = createRedirectSession(activation);
		redirectPromise = attempt.then(
			async ({ activateMigrationTargetCallbacks, migrationTargetObjectId, releaseCallbacks, session }) => {
				if (closed) {
					await session.close().catch(() => undefined);
					throw new TypeError("v3 room session closed during redirect");
				}
				redirectPromise = undefined;
				redirectedSession = session;
				try {
					input.onMigrationTarget?.(session, migrationTargetObjectId());
					activateMigrationTargetCallbacks();
					await releaseCallbacks();
				} catch (error) {
					redirectedSession = undefined;
					await session.close().catch(() => undefined);
					throw error;
				}
				return session;
			},
			(error: unknown) => {
				redirectPromise = undefined;
				throw error;
			}
		);
		return redirectPromise;
	};
	const retainedPrefixReady = (vertex: V3RoomAcceptedVertex): boolean => {
		if (!retainedBootstrapHeld || retainedBootstrapReady || redirectSource === undefined) return false;
		const operation = detachedRoomOperation(vertex.operation);
		if (operation === undefined || Reflect.get(operation, "action") !== "migrationRecord") return false;
		const record = migrationRecord(Reflect.get(operation, "record"));
		if (record === undefined) return false;
		const activation = redirectSource.activation;
		const decision = activation.decision;
		const recordBytes = encodeCanonical(record);
		const imports = acceptedOperationSnapshot().filter((row) => {
			const action = Reflect.get(row.operation, "action");
			return typeof action === "string" && input.application.batchableOperationActions.includes(action);
		});
		const migration = input.application.migration;
		if (
			migration === undefined ||
			hex(vertex.digest) !== decision.migrationRecordVertexDigest ||
			digest("ts-drp/v3-room-migration-record/v1", recordBytes) !== decision.migrationRecordDigest ||
			imports.length !== decision.targetImportOperationCount ||
			digest("ts-drp/v3-room-migration-import/v1", encodeCanonical(imports.map(({ operation: value }) => value))) !==
				decision.targetImportOperationsDigest ||
			!MIGRATION_RECORD_KEYS.every((key) => {
				if (
					key === "archivePolicy" ||
					key === "authorityKind" ||
					key === "exactCanonicalApplicationStateBytes" ||
					key === "kind" ||
					key === "version"
				)
					return true;
				return sameBytes(encodeCanonical(record[key]), encodeCanonical(decision[key]));
			})
		) {
			throw new TypeError("v3 room retained migration prefix differs");
		}
		const exactState = normalizeApplicationStateBytes(
			Reflect.apply(migration.canonicalStateBytes, migration, [projection]) as Uint8Array,
			"migration"
		);
		const recordState = migrationRecordStateBytes(record);
		if (
			!sameBytes(exactState, recordState) ||
			digest("ts-drp/v3-room-migration-state/v1", exactState) !== decision.applicationStateDigest
		) {
			throw new TypeError("v3 room retained migration state differs");
		}
		retainedBootstrapReady = true;
		resolveRetainedBootstrap?.();
		return true;
	};
	let startupReplay: V3RoomAcceptedVertex[] | undefined;
	const commitSuccessorProjection = async (): Promise<void> => {
		if (startupReplay === undefined) throw new TypeError("v3 room successor replay is unavailable");
		// Keep activation deliveries buffered while replayable application callbacks
		// await. The authenticated base already contains every predecessor effect.
		while (startupReplay.length !== 0) {
			const replay = startupReplay.splice(0);
			await commit(replay);
			const authority = currentMigrationActivationAuthority();
			for (const vertex of replay) {
				const operation = detachedRoomOperation(vertex.operation);
				if (operation === undefined || Reflect.get(operation, "action") !== "migrationActivation") continue;
				const activation =
					authority === undefined ? undefined : migrationActivationOperation(operation, vertex.author, authority);
				if (activation === undefined || vertex.anchor !== authority?.anchorDigest || recoveredActivation !== undefined)
					throw new TypeError("v3 room migration activation history is invalid");
				recoveredActivation = authenticatedMigrationActivation(activation, hex(vertex.digest));
			}
		}
		startupReplay = undefined;
		projection = stage(Object.freeze([])).projection;
		input.onProjection(projection);
		presentationHook((overlay) => overlay.durableChanged());
	};
	const admittedSink = async ({
		vertex,
	}: Parameters<V3AdmittedVertexSink>[0]): Promise<
		Readonly<{
			readonly kind: "continue" | "retained-bootstrap-ready" | "terminal-accepted" | "terminal-rejected";
		}>
	> => {
		localOwner?.assertCurrent();
		if (startupReplay !== undefined) {
			startupReplay.push(vertex);
			return Object.freeze({ kind: "continue" as const });
		}
		try {
			await commit([vertex]);
			if (retainedPrefixReady(vertex)) return Object.freeze({ kind: "retained-bootstrap-ready" as const });
			const operation = detachedRoomOperation(vertex.operation);
			if (operation !== undefined && Reflect.get(operation, "action") === "migrationActivation") {
				const authority = currentMigrationActivationAuthority();
				const activation =
					authority === undefined ? undefined : migrationActivationOperation(operation, vertex.author, authority);
				if (activation !== undefined) {
					await ensureRedirect(authenticatedMigrationActivation(activation, hex(vertex.digest)));
				}
				return Object.freeze({
					kind: activation === undefined ? ("terminal-rejected" as const) : ("terminal-accepted" as const),
				});
			}
			return Object.freeze({ kind: "continue" as const });
		} catch (error) {
			terminalFailure = error;
			rejectRetainedBootstrap?.(error);
			// This sink is entered by the runtime's own admitted gate. Shutdown
			// joins that gate, so awaiting it here would wait on this callback.
			// Refuse immediately, retain the owned cleanup promise, and let the
			// caller's close join it after this admitted turn has settled.
			void shutdown().catch((cleanup: unknown) => {
				terminalFailure = combineFailures(error, cleanup);
			});
			throw error;
		}
	};
	try {
		const openedTransport = input.openTransport(input.objectId);
		transport = openedTransport;
		if (authorizeSettlementSource === undefined && openedTransport.requestSettlementSourceAuthorization !== undefined) {
			const requestAuthorization = openedTransport.requestSettlementSourceAuthorization;
			authorizeSettlementSource = (request): Promise<Uint8Array> =>
				Reflect.apply(requestAuthorization, openedTransport, [request]);
		}
		const activateStartupPlane = (recovering: boolean): Promise<void> =>
			withCreatorReceivedPromotionDependencies(
				{
					releasePromotionDependencies: releaseRetainedPromotionDependencies,
				},
				async () => {
					if (recovering) {
						await refreshRoomHeadState();
						await selectRetainedRoomCustody(
							Object.freeze({ ahe: aheStores[0], issuance: issuanceStore, journal: journalStore })
						);
					}
					if (selectRoomStartup() !== "successor") {
						if (recovering) {
							const durable = await prepareDurableRoomState(
								Object.freeze({ ...input, issuanceDatabaseName }),
								material,
								sourceMaterial,
								objectIdResult.value,
								false,
								classifyTerminalVertex,
								redirectSource,
								redirectHistoryComplete,
								{ aheStores, issuanceStore, journalStore, sourceJournalStores },
								ownedSettlementPolicy
							);
							prepared = durable.prepared;
							recovered = durable.recovered;
							await commit(recovered.descriptor.recoveredVertices, recovered.descriptor.applicationProjectionOrder);
						}
						if (recovered === undefined) throw new TypeError("v3 room recovered genesis custody is unavailable");
						const activated = activateV3LivePlane({
							capability: recovered.capability,
							messageQueueManager,
							networkNode: openedTransport.networkNode,
							onAdmittedVertex: admittedSink as unknown as V3AdmittedVertexSink,
						});
						if (!activated.ok) throw new TypeError(`v3 room activation failed: ${activated.kind}`);
						activeHandle = activated.handle as RoomPlaneHandle;
					} else {
						if (roomHeadAuthority === undefined || openedRoomHeadState === undefined) {
							return roomHeadFailure("D110C_FLOOR_MIGRATION_REQUIRED");
						}
						const snapshotStore = await ownRecipientSnapshots();
						const selectedPending = openedRoomHeadState.pending;
						if (selectedPending !== null) {
							const pending = Object.freeze({ pending: selectedPending, stable: openedRoomHeadState.stable });
							const nativeSigning =
								input.creatorFinalitySigner === undefined ? undefined : await ownCreatorSigningStores();
							const recoveredPending = await consumeCreatorAdoptionPendingRecovery({
								...(input.openCreatorArchive === undefined ? {} : {
									proofAccounting: createCreatorClosedRollbackProofAccounting([], true),
								}),
								...(nativeSigning === undefined || input.creatorFinalitySigner === undefined
									? {}
									: {
											classificationOwners: Object.freeze({
												author: input.author,
												roomHeadAuthority: input.roomHeadAuthority,
												exactCanonicalPinnedGenesisBootstrapOperationBytes,
												exactCanonicalPinnedGenesisTrustStateRecordBytes: encodeCanonical({
													kind: "drp-anchor-trust-state",
													version: 1,
													objectId: input.objectId,
													genesisAnchorDigest: material.pinnedGenesisAnchorDigest,
													currentAnchorDigest: material.pinnedGenesisAnchorDigest,
													currentEpoch: 0,
													profileId: Reflect.get(
														decodeCanonical(material.exactCanonicalProfileBytes) as object,
														"profileId"
													),
													quorum: 1,
													exactCanonicalCurrentAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
													detachedCurrentAnchorSignature: material.detachedGenesisSignature,
													exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
													exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
												}),
												voteStore: nativeSigning.vote.store,
												evidenceStore: nativeSigning.evidence.store,
												storageIncarnation: nativeSigning.vote.observation.incarnation,
												signer: input.creatorFinalitySigner,
											}),
										}),
								authenticationProfile: "creator-only",
								catalog: input.application.catalog,
								detachedSignature: material.detachedGenesisSignature,
								exactCanonicalAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
								exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
								expectedNextRoomHead: selectedPending.next,
								expectedPreviousRoomHead: selectedPending.previous,
								issuanceStore,
								liveJournalStore: journalStore,
								pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
								snapshotStore,
								store: aheStores[0],
							});
							const recoveredHead = recoveredPending.ok ? captureRoomHead(recoveredPending.head) : undefined;
							if (
								recoveredPending.ok !== true ||
								recoveredHead === undefined ||
								!sameRoomHead(recoveredHead, selectedPending.next)
							) {
								const kind = Reflect.get(recoveredPending, "kind");
								return roomHeadFailure(
									kind === "true-fork" ||
										kind === "chain-invalid" ||
										kind === "stale-head" ||
										kind === "malformed-input"
										? "D110C_FLOOR_PENDING_INVALID"
										: "D110C_FLOOR_RECOVERY_UNAVAILABLE"
								);
							}
							openedRoomHeadState = await commitRoomHeadAdvance(roomHeadAuthority, roomHeadScope, pending);
						}
						const expectedRoomHead = openedRoomHeadState.stable;
						startupReplay = [];
						const reopened = await reopenCreatorSuccessorAdoption({
							...(input.receiveOnly ? { receiveOnly: true as const } : {}),
							createOperationAdmissionPolicy: successorAdmissionFactory,
							...(classifyTerminalVertex === undefined ? {} : { classifyTerminalVertex }),
							authenticationProfile: "creator-only",
							author: input.author,
							catalog: input.application.catalog,
							settlementPolicy: ownedSettlementPolicy,
							settlementFloor: roomHeadAuthority,
							detachedSignature: material.detachedGenesisSignature,
							exactCanonicalAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
							exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
							exactCanonicalPinnedGenesisBootstrapOperationBytes,
							expectedRoomHead,
							issuanceStore,
							liveJournalStore: journalStore,
							messageQueueManager,
							networkNode: openedTransport.networkNode,
							onAdmittedVertex: admittedSink as unknown as V3AdmittedVertexSink,
							pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
							signRegisteredVertexDigest: input.signRegisteredVertexDigest,
							snapshotStore,
							store: aheStores[0],
						});
						if (reopened.ok !== true) {
							throw new TypeError(
								`v3 room successor reopen failed: ${String(reopened.kind)}: ${String(reopened.detail)}`,
								Object.prototype.hasOwnProperty.call(reopened, "cause") ? { cause: Reflect.get(reopened, "cause") } : undefined
							);
						}
						activeHandle = reopened.handle as RoomPlaneHandle;
						successorProjectionAuthority = successorAuthority(reopened.trust, activeHandle);
						installSuccessorProjectionBase(activeHandle, successorProjectionAuthority);
						await commitSuccessorProjection();
					}
					if (input.creatorFinalitySigner !== undefined && selectRoomStartup() !== "successor") {
						if (input.application.migration === undefined) {
							throw new TypeError("v3 room creator close initial state is unavailable");
						}
						const genesisFactory = input.application.createGenesisApplicationStateBytes;
						const exactCanonicalInitialStateBytes = normalizeApplicationStateBytes(
							genesisFactory === undefined
								? (Reflect.apply(input.application.migration.canonicalStateBytes, input.application.migration, [
										input.application.projectAcceptedOperations(
											Object.freeze({ authenticatedBase: undefined, currentEpochOperations: Object.freeze([]) })
										),
									]) as Uint8Array)
								: (Reflect.apply(genesisFactory, input.application, [
										Object.freeze({
											objectId: inviteAuthority.objectId,
											exactCanonicalLatchedAclBytes: new Uint8Array(material.exactCanonicalLatchedAclBytes),
										}),
									]) as Uint8Array),
							"genesis"
						);
						const blueprint = bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes, plane: activeHandle });
						if (!blueprint.ok) throw new TypeError(`v3 room creator-close blueprint binding failed: ${blueprint.kind}`);
					}
				}
			);
		recoverStartupPlane = (): Promise<void> => activateStartupPlane(true);
		await activateStartupPlane(false);
		if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
		openedTransport.setIngressHandler(
			activeHandle.topic,
			(message) => {
				if (!closed) {
					localOwner?.assertCurrent();
					presentRemoteIngress(message);
					routeV3Ingress(openedTransport.networkNode, message);
				}
			},
			(message) => {
				if (!closed && activeHandle !== undefined) { localOwner?.assertCurrent(); routeV3RetainedIngress(activeHandle, message); }
			}
		);
		// The live topic is stable across successors, so one binding serves every epoch.
		if (typeof openedTransport.requestMissingRetainedHistory === "function")
			unbindMissingDependencyRequest = bindV3MissingDependencyRequest(
				openedTransport.networkNode,
				activeHandle.topic,
				requestMissingRetainedHistory
			);
		const republishRetainedHistory = async (targetPeerId: string | undefined): Promise<void> => {
			assertSessionOpen();
			if (terminalFailure !== undefined) throw terminalFailure;
			if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
			const result =
				targetPeerId === undefined
					? await activeHandle.republishRetained()
					: await republishV3RetainedTo(activeHandle, targetPeerId);
			if (result.ok) return;
			// An orderly close cancels a retained publication still in flight: it revokes
			// this transport synchronously, then retires the plane. A send that revocation
			// refused, or a plane retired before or around the send, is that cancellation,
			// not a publication fault. Storage and record faults, and every failure outside
			// an orderly close or after a terminal failure, still reject.
			if (
				sessionCloseTask !== undefined &&
				terminalFailure === undefined &&
				(result.kind === "not-active" ||
					result.kind === "publication-state-unknown" ||
					result.kind === "publish-failed")
			)
				return;
			throw new TypeError(`v3 room retained publication failed: ${result.kind}`);
		};
		openedTransport.setRetainedPublisher((targetPeerId) => {
			const held = startupGossipRepublicationBarrier;
			if (targetPeerId !== undefined || held === undefined) return republishRetainedHistory(targetPeerId);
			// One gossip republication after the settlement creator's startup barrier answers every
			// one asked for before it: at most one is held (G21).
			heldStartupGossipRepublication ??= held.then(() => {
				heldStartupGossipRepublication = undefined;
				return republishRetainedHistory(undefined);
			});
			return heldStartupGossipRepublication;
		});
		if (input.creatorFinalitySigner !== undefined) {
			const creatorFinalitySigner = input.creatorFinalitySigner;
			const { vote: voteStore, evidence: evidenceStore } = await ownCreatorSigningStores();
			// Successor reopen already bound the authenticated snapshot-readiness
			// owner. Creator close must share that exact custody, not open a second
			// capability against the same physical database.
			const snapshotStore = await ownRecipientSnapshots();
			const archive = await ownCreatorArchive();
			if (voteStore.observation.incarnation !== evidenceStore.observation.incarnation) {
				throw new TypeError("v3 room creator-close storage incarnation differs");
			}
			bindCurrentCreatorClose = (plane): ReturnType<typeof bindCreatorLiveClose> => {
				let ordinaryFinishingWindow: CreatorOrdinaryFinishingWindowLimits | undefined;
				try {
					ordinaryFinishingWindow = roomOrdinaryFinishingWindowForEpoch(input.application,
						{objectId: input.objectId, epoch: plane.epoch});
				} catch {
					return Promise.resolve(Object.freeze({ok: false as const, reason: "CREATOR_ORDINARY_FINISHING_WINDOW_INVALID"}));
				}
				return bindCreatorLiveClose({
					...(archive === undefined ? {} : { archive }),
					...(input.application.readOrdinaryApplicationResourceBound === undefined ? {} :
						{readOrdinaryApplicationResourceBound: input.application.readOrdinaryApplicationResourceBound}),
					...(ordinaryFinishingWindow === undefined ? {} : {ordinaryFinishingWindow}),
					prospectiveSettlementPreview: (preview) => {
						if (
							closed ||
							activeHandle?.epoch !== preview.successorEpoch - 1 ||
							preview.scope.objectId !== input.objectId ||
							preview.scope.author !== input.author
						)
							throw new TypeError("v3 room prospective settlement source is not current");
						return Object.freeze({
							plan: mergedSettlementPlan([], preview.priorPlan)(preview.priorFenceEpoch, preview.successorEpoch),
							fenceLogicalTime: Math.max(logicalTime, preview.minimumLogicalTime),
							continuationLogicalTime: Math.max(logicalTime, preview.minimumLogicalTime),
						});
					},
					promotionContext: {
						catalog: input.application.catalog,
						roomHeadAuthority: input.roomHeadAuthority,
						pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
						exactCanonicalPinnedGenesisTrustStateRecordBytes: encodeCanonical({
							kind: "drp-anchor-trust-state",
							version: 1,
							objectId: input.objectId,
							genesisAnchorDigest: material.pinnedGenesisAnchorDigest,
							currentAnchorDigest: material.pinnedGenesisAnchorDigest,
							currentEpoch: 0,
							profileId: Reflect.get(decodeCanonical(material.exactCanonicalProfileBytes) as object, "profileId"),
							quorum: 1,
							exactCanonicalCurrentAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
							detachedCurrentAnchorSignature: material.detachedGenesisSignature,
							exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
							exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
						}),
					},
					evidenceStore: evidenceStore.store,
					exactCanonicalAvailabilityPolicyBytes: CREATOR_LOCAL_AVAILABILITY_POLICY_BYTES,
					onObservation: () => undefined,
					plane,
					signer: creatorFinalitySigner,
					snapshotStore,
					storageIncarnation: voteStore.observation.incarnation,
					voteStore: voteStore.store,
				});
			};
			const bound = await bindCurrentCreatorClose(activeHandle);
			if (bound.ok) creatorCloseHandle = bound.handle;
			else {
				creatorCloseUnavailableContinuity = [
					"AMBIGUOUS_OUTCOME",
					"CREATOR_CONTINUITY_TERMINAL",
					"DURABLE_EVIDENCE_INVALID",
					"DURABLE_QC_INVALID",
					"STORAGE_LOSS",
				].includes(bound.reason)
					? "stalled"
					: "continuous";
			}
		}
		openedTransport.requestRetainedHistory();
	} catch (error) {
		await shutdown().catch(() => undefined);
		throw error;
	}
	type PendingIssue = Readonly<{
		// Minted only by private public-issue or authenticated-rebase owners, never operation data.
		source: "public-new" | "authenticated-historical";
		group?: string;
		logicalTime: number;
		operation: Readonly<Record<string, unknown>>;
		releasePublicInput?(): void;
		reject(reason: unknown): void;
		resolve(): void;
	}>;
	// The signed pending allowance bounds private public-input custody, not
	// cumulative proof charges, encoding temporaries, or physical heap memory.
	const pendingParameters = decodeCanonical(material.exactCanonicalParametersCarrierBytes) as Record<string, unknown>;
	const pendingInputEntryLimit = pendingParameters.maxPendingEntries;
	const pendingInputByteLimit = pendingParameters.maxPendingBytes;
	if (
		typeof pendingInputEntryLimit !== "number" ||
		!Number.isSafeInteger(pendingInputEntryLimit) ||
		pendingInputEntryLimit < 1 ||
		typeof pendingInputByteLimit !== "number" ||
		!Number.isSafeInteger(pendingInputByteLimit) ||
		pendingInputByteLimit < 1
	)
		throw new TypeError("v3 room pending input limits are invalid");
	let pendingInputEntries = 0;
	let pendingInputBytes = 0;
	let pendingIssues: PendingIssue[] = [];
	let drainScheduled = false;
	let draining = false;
	let drainPromise: Promise<void> = Promise.resolve();
	let migrationBarrier: Promise<void> | undefined;
	let migrationCompletionBarrier: Promise<void> | undefined;
	let migrationAcceptingFollowers = false;
	let migrationRehearsalReserved = false;
	let lifetimeTransitionTail: Promise<void> = Promise.resolve();
	// Admitted lifetime transitions not yet settled; idle detection treats them as busy.
	let lifetimeTransitionsPending = 0;
	// Opt-in idle scheduler for early recovery-pool turnover; stopped at close.
	let autoPoolMaintenance: Readonly<{ stop(): void }> | undefined;
	// Opt-in lull once per epoch, requested right after adoption or install (Track Z).
	const scheduledLulls =
		input.recoveryPoolScheduledLull === true
			? createScheduledRecoveryPoolLull({
					epoch: () => (activeHandle === undefined ? undefined : session.authority()?.epoch),
					request: () => session.maintainRecoveryPool(),
					now: () => performance.now(),
				})
			: undefined;
	// Holds new local issues while an explicit recovery-pool boundary owns the plane.
	let poolMaintenanceBarrier: Promise<void> | undefined;
	// Receipt continuations handed from issueWithReceipt to the synchronous start of issue().
	let nextIssueReceiptHooks: LocalPresentationHooks | undefined;
	type LifetimeDispatchResult<Result> = Readonly<{ readonly result: Result | Promise<Result> }>;
	const enqueueLifetimeTransition = <Result>(transition: () => Promise<Result>): Promise<Result> => {
		const dispatch = (): Promise<Result> => {
			localOwner?.assertCurrent();
			const selected = lifetimeTransitionTail.then(() => { localOwner?.assertCurrent(); return transition(); });
			lifetimeTransitionsPending += 1;
			lifetimeTransitionTail = selected.then(
				() => { lifetimeTransitionsPending -= 1; },
				() => { lifetimeTransitionsPending -= 1; }
			);
			return selected;
		};
		// Preserve every admitted FIFO call; refuse excess before retaining a
		// new transition. Native custody/job tokens are not payload/proof bytes.
		return localOwner === undefined ? dispatch() : localOwner.lease.admit(dispatch);
	};
	const boundedMigrationCreatorInvite = (value: unknown): string => {
		if (typeof value === "string") {
			if (value.length > 131_072) throw new TypeError("v3 room migration target invite is unbounded");
			return value;
		}
		const fields = exactRecord(value, CREATOR_INVITE_MATERIAL_KEYS);
		if (fields === undefined) throw new TypeError("v3 room creator invite fields are invalid");
		const pinnedGenesisAnchorDigest = fields.pinnedGenesisAnchorDigest;
		if (typeof pinnedGenesisAnchorDigest !== "string" || !/^[0-9a-f]{64}$/u.test(pinnedGenesisAnchorDigest)) {
			throw new TypeError("v3 room creator invite anchor is invalid");
		}
		const byteLengths: number[] = [];
		for (const field of CREATOR_INVITE_BYTE_FIELDS) {
			const fieldValue = fields[field];
			let backing: unknown;
			let backingByteLength: unknown;
			let byteLength: unknown;
			let byteOffset: unknown;
			let resizable = false;
			try {
				backing = Reflect.apply(INTRINSIC_TYPED_ARRAY_BUFFER_GETTER, fieldValue, []);
				backingByteLength = Reflect.apply(INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH_GETTER, backing, []);
				byteLength = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER, fieldValue, []);
				byteOffset = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_OFFSET_GETTER, fieldValue, []);
				if (INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER !== undefined) {
					resizable = Reflect.apply(INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER, backing, []) === true;
				}
			} catch {
				throw new TypeError(`v3 room creator invite ${field} is invalid`);
			}
			if (
				INTRINSIC_GET_PROTOTYPE_OF(fieldValue) !== INTRINSIC_UINT8_ARRAY_PROTOTYPE ||
				!(backing instanceof INTRINSIC_ARRAY_BUFFER) ||
				INTRINSIC_GET_PROTOTYPE_OF(backing) !== INTRINSIC_ARRAY_BUFFER_PROTOTYPE ||
				resizable ||
				typeof backingByteLength !== "number" ||
				typeof byteLength !== "number" ||
				typeof byteOffset !== "number" ||
				byteLength === 0 ||
				byteOffset < 0 ||
				byteOffset + byteLength > backingByteLength
			) {
				throw new TypeError(`v3 room creator invite ${field} is invalid`);
			}
			if (field === "detachedGenesisSignature" && byteLength !== 64) {
				throw new TypeError("v3 room creator invite signature is invalid");
			}
			byteLengths.push(byteLength);
		}
		const exactCanonicalByteLength = byteLengths.reduce(
			(total, byteLength) => total + 1 + canonicalVarUintByteLength(byteLength) + byteLength,
			CREATOR_INVITE_FIXED_CANONICAL_BYTE_LENGTH
		);
		if (exactCanonicalByteLength > 65_536) {
			throw new TypeError("v3 room migration target invite is unbounded");
		}
		return encodeCreatorInvite(fields as unknown as V3RoomCreatorInviteMaterial);
	};
	const snapshotMigrationInvite = (value: unknown): unknown => {
		if (typeof value !== "string" && (value === null || typeof value !== "object")) return value;
		return boundedMigrationCreatorInvite(value);
	};
	const snapshotMigrationRehearsalInput = (
		rehearsalInput: V3RoomMigrationRehearsalInput
	): V3RoomMigrationRehearsalInput => {
		const fields = exactRecord(rehearsalInput, ["rehearsalNonce", "targetCreatorInvite"]);
		if (fields === undefined) return rehearsalInput;
		const nonce = fields.rehearsalNonce;
		let capturedNonce = nonce;
		try {
			const backing = Reflect.apply(INTRINSIC_TYPED_ARRAY_BUFFER_GETTER, nonce, []);
			const backingLength = Reflect.apply(INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH_GETTER, backing, []);
			const byteLength = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER, nonce, []);
			const byteOffset = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_OFFSET_GETTER, nonce, []);
			const resizable =
				INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER !== undefined &&
				Reflect.apply(INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER, backing, []) === true;
			if (
				INTRINSIC_GET_PROTOTYPE_OF(nonce) === INTRINSIC_UINT8_ARRAY_PROTOTYPE &&
				backing instanceof INTRINSIC_ARRAY_BUFFER &&
				INTRINSIC_GET_PROTOTYPE_OF(backing) === INTRINSIC_ARRAY_BUFFER_PROTOTYPE &&
				!resizable &&
				byteLength === 32 &&
				byteOffset === 0 &&
				backingLength === 32
			) {
				capturedNonce = new INTRINSIC_UINT8_ARRAY(nonce as Uint8Array);
			}
		} catch {
			// The queued owner preserves the existing invalid-input classification.
		}
		return Object.freeze({
			rehearsalNonce: capturedNonce,
			targetCreatorInvite: snapshotMigrationInvite(fields.targetCreatorInvite),
		}) as V3RoomMigrationRehearsalInput;
	};
	const snapshotMigrationActivationInput = (
		activationInput: V3RoomMigrationActivationInput
	): V3RoomMigrationActivationInput => {
		const fields = exactRecord(activationInput, [
			"exactCanonicalRecordBytes",
			"recordVertexDigest",
			"targetCreatorInvite",
		]);
		if (fields === undefined) return activationInput;
		const suppliedRecordBytes = fields.exactCanonicalRecordBytes;
		let capturedRecordBytes = suppliedRecordBytes;
		let backing: unknown;
		let backingByteLength: unknown;
		let byteLength: unknown;
		let byteOffset: unknown;
		let resizable = false;
		try {
			backing = Reflect.apply(INTRINSIC_TYPED_ARRAY_BUFFER_GETTER, suppliedRecordBytes, []);
			backingByteLength = Reflect.apply(INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH_GETTER, backing, []);
			byteLength = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER, suppliedRecordBytes, []);
			byteOffset = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_OFFSET_GETTER, suppliedRecordBytes, []);
			if (INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER !== undefined) {
				resizable = Reflect.apply(INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER, backing, []) === true;
			}
		} catch {
			// The queued owner preserves the existing invalid-input classification.
		}
		if (
			INTRINSIC_GET_PROTOTYPE_OF(suppliedRecordBytes) === INTRINSIC_UINT8_ARRAY_PROTOTYPE &&
			backing instanceof INTRINSIC_ARRAY_BUFFER &&
			INTRINSIC_GET_PROTOTYPE_OF(backing) === INTRINSIC_ARRAY_BUFFER_PROTOTYPE &&
			!resizable &&
			typeof backingByteLength === "number" &&
			typeof byteLength === "number" &&
			typeof byteOffset === "number" &&
			byteOffset >= 0 &&
			byteOffset + byteLength <= backingByteLength
		) {
			if (byteLength > 49_152) throw new TypeError("v3 room migration activation record is unbounded");
			const copiedRecordBytes = new INTRINSIC_UINT8_ARRAY(byteLength);
			Reflect.apply(INTRINSIC_UINT8_ARRAY_SET, copiedRecordBytes, [
				new INTRINSIC_UINT8_ARRAY(backing, byteOffset, byteLength),
			]);
			capturedRecordBytes = copiedRecordBytes;
		}
		return Object.freeze({
			exactCanonicalRecordBytes: capturedRecordBytes,
			recordVertexDigest: fields.recordVertexDigest,
			targetCreatorInvite: snapshotMigrationInvite(fields.targetCreatorInvite),
		}) as V3RoomMigrationActivationInput;
	};
	type MigrationFollowerResult =
		| Readonly<{ readonly ok: true }>
		| Readonly<{ readonly ok: false; readonly reason: unknown }>;
	const migrationFollowers = new Set<Promise<MigrationFollowerResult>>();
	const publishAccepted = async (): Promise<void> => {
		if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
		for (;;) {
			const published = await activeHandle.publishPending();
			if (!published.ok) throw new TypeError(`v3 room publication failed: ${published.kind}`);
			if (published.kind === "empty") return;
		}
	};
	const publishCurrentGenesisBootstrap = async (): Promise<void> => {
		if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
		if (activeHandle.epoch !== 0) return;
		const row = (await issuanceStore.readOutboxPage({ scope: settlementScope, limit: 1 }))[0];
		if (row === undefined || row.commit.authorSequence !== 0 || row.publishState === "published") return;
		const preimage = decodeCanonical(row.commit.envelope.canonicalPreimageBytes);
		if (
			typeof preimage !== "object" ||
			preimage === null ||
			Array.isArray(preimage) ||
			Reflect.get(preimage, "author") !== input.author ||
			Reflect.get(preimage, "authorSequence") !== 0 ||
			Reflect.get(preimage, "objectId") !== input.objectId ||
			Reflect.get(preimage, "epoch") !== 0 ||
			Reflect.get(preimage, "anchor") !== material.pinnedGenesisAnchorDigest ||
			!sameBytes(
				encodeCanonical(Reflect.get(preimage, "operation"), APPLICATION_BATCH_LIMITS),
				exactCanonicalPinnedGenesisBootstrapOperationBytes
			)
		)
			return;
		// Selection is observational only. The original native publication owner
		// independently authenticates this exact current row and records its ACK.
		// One call drains bootstrap only, not supported pending application debt.
		const published = await activeHandle.publishPending();
		if (!published.ok) throw new TypeError(`v3 room publication failed: ${published.kind}`);
		const observed = (await issuanceStore.readOutboxPage({ scope: settlementScope, limit: 1 }))[0];
		if (
			observed === undefined ||
			observed.commit.authorSequence !== 0 ||
			observed.publishState !== "published" ||
			!sameBytes(observed.commit.envelope.digest, row.commit.envelope.digest)
		)
			throw new TypeError("v3 room bootstrap publication remains pending");
	};
	const rejectOwned = (owned: readonly PendingIssue[], reason: unknown): void => {
		for (const request of owned) request.reject(reason);
	};
	const issueOwned = async (owned: readonly PendingIssue[]): Promise<void> => {
		if (owned.length === 0) return;
		if (activeHandle === undefined || (settlementProfile === "v1" && creatorSuccessorAdoptionTask !== undefined)) {
			rejectOwned(owned, new TypeError("v3 room live plane is unavailable"));
			return;
		}
		for (const request of owned) {
			if (request.source !== "public-new") continue;
			const authorized = authorizeV3NewLocalOperation({ plane: activeHandle, operation: request.operation });
			if (!authorized.ok) {
				rejectOwned(owned, new TypeError(`v3 room new operation is not authorized: ${authorized.kind}`));
				return;
			}
		}
		const issued = await activeHandle
			.issueLocal({
				operations: Object.freeze(
					owned.map(({ logicalTime: selectedLogicalTime, operation }) =>
						Object.freeze({ logicalTime: selectedLogicalTime, operation })
					)
				),
				signRegisteredVertexDigest: input.signRegisteredVertexDigest,
			})
			.catch((error: unknown) => {
				rejectOwned(owned, error);
				return undefined;
			});
		if (issued === undefined) return;
		if (!issued.ok && issued.kind === "split-required") {
			const prefixLength = issued.prefixLength;
			if (
				typeof prefixLength !== "number" ||
				!Number.isSafeInteger(prefixLength) ||
				prefixLength < 1 ||
				prefixLength >= owned.length
			) {
				rejectOwned(owned, new TypeError("v3 room issue split was invalid"));
				return;
			}
			await issueOwned(owned.slice(0, prefixLength));
			await issueOwned(owned.slice(prefixLength));
			return;
		}
		if (!issued.ok && issued.kind === "malformed-input" && owned.length > 1) {
			owned[0]?.reject(new TypeError(`v3 room issue failed: ${issued.kind}: ${issued.detail}`));
			await issueOwned(owned.slice(1));
			return;
		}
		if (!issued.ok) {
			rejectOwned(owned, new TypeError(`v3 room issue failed: ${issued.kind}: ${issued.detail}`));
			return;
		}
		if (terminalFailure !== undefined) {
			rejectOwned(owned, terminalFailure);
			return;
		}
		if (acceptedOperationRows.get(issued.digest) === null) {
			rejectOwned(owned, new TypeError(PROJECTION_REFUSED_ISSUE));
			return;
		}
		try {
			await publishAccepted();
			for (const request of owned) request.resolve();
		} catch (error) {
			rejectOwned(owned, error);
		}
	};
	const drainSnapshot = async (snapshot: readonly PendingIssue[]): Promise<void> => {
		let offset = 0;
		while (offset < snapshot.length) {
			const head = snapshot[offset];
			if (head === undefined) return;
			const action = Reflect.get(head.operation, "action");
			if (typeof action !== "string" || !input.application.batchableOperationActions.includes(action)) {
				await issueOwned(Object.freeze([head]));
				offset += 1;
				continue;
			}
			let end = offset + 1;
			while (end < snapshot.length && end - offset < 16) {
				const candidate = snapshot[end];
				const candidateAction = Reflect.get(candidate?.operation ?? {}, "action");
				if (
					typeof candidateAction !== "string" ||
					!input.application.batchableOperationActions.includes(candidateAction) ||
					candidate?.source !== head.source ||
					candidate?.group !== head.group
				) {
					break;
				}
				end += 1;
			}
			await issueOwned(Object.freeze(snapshot.slice(offset, end)));
			offset = end;
		}
	};
	const scheduleDrain = (): void => {
		if (drainScheduled || draining || pendingIssues.length === 0) return;
		drainScheduled = true;
		drainPromise = Promise.resolve().then(async (): Promise<void> => {
			drainScheduled = false;
			draining = true;
			const snapshot = Object.freeze(pendingIssues);
			pendingIssues = [];
			try {
				await drainSnapshot(snapshot);
			} finally {
				// A resolved caller's operation remains in this frozen snapshot until
				// the complete drain joins. Do not refund that still-retained custody.
				for (const request of snapshot) request.releasePublicInput?.();
				draining = false;
				if (pendingIssues.length > 0) scheduleDrain();
			}
		});
	};
	const drainPendingIssues = async (): Promise<void> => {
		for (;;) {
			if (pendingIssues.length > 0) scheduleDrain();
			await drainPromise;
			if (!drainScheduled && !draining && pendingIssues.length === 0) return;
		}
	};
	const waitForMigrationFollowers = async (): Promise<void> => {
		for (;;) {
			const selected = [...migrationFollowers];
			if (selected.length === 0) return;
			const results = await Promise.all(selected);
			for (const follower of selected) migrationFollowers.delete(follower);
			const failed = results.find((result) => !result.ok);
			if (failed !== undefined && !failed.ok) throw failed.reason;
		}
	};
	const acceptedIdentityRows = (): Map<string, Uint8Array> => {
		const rows = new Map<string, Uint8Array>();
		for (const vertex of acceptedVertices.values()) {
			if (redirectSource !== undefined && vertex.objectId !== input.objectId) continue;
			for (const accepted of expand(vertex) ?? []) {
				const action = Reflect.get(accepted.operation, "action");
				if (typeof action !== "string" || !input.application.batchableOperationActions.includes(action)) continue;
				const identity = input.application.displacedOperationIdentity(accepted.operation);
				if (typeof identity !== "string" || identity.length === 0) {
					throw new TypeError("v3 room displaced operation identity is invalid");
				}
				const key = `${accepted.author}\u0000${action}\u0000${identity}`;
				const encoded = encodeCanonical(accepted.operation);
				const prior = rows.get(key);
				if (prior !== undefined && !sameBytes(prior, encoded)) {
					throw new TypeError("v3 room accepted operation identity conflicts");
				}
				rows.set(key, encoded);
			}
		}
		return rows;
	};
	const migrationImportIdentityRows = (): Map<string, Uint8Array> => {
		const rows = new Map<string, Uint8Array>();
		if (redirectSource === undefined) return rows;
		const decision = redirectSource.activation.decision;
		const importCount = decision.targetImportOperationCount;
		const importDigest = decision.targetImportOperationsDigest;
		const importAuthor = decision.targetCreatorAuthor;
		if (
			!Number.isSafeInteger(importCount) ||
			(importCount as number) < 0 ||
			typeof importDigest !== "string" ||
			typeof importAuthor !== "string"
		) {
			throw new TypeError("v3 room migration import authority is invalid");
		}
		const imports = acceptedOperationSnapshot()
			.filter(({ operation }) => {
				const action = Reflect.get(operation, "action");
				return typeof action === "string" && input.application.batchableOperationActions.includes(action);
			})
			.slice(0, importCount as number);
		if (
			imports.length !== importCount ||
			digest("ts-drp/v3-room-migration-import/v1", encodeCanonical(imports.map(({ operation }) => operation))) !==
				importDigest
		) {
			throw new TypeError("v3 room migration import prefix differs");
		}
		for (const accepted of imports) {
			const action = Reflect.get(accepted.operation, "action");
			if (accepted.author !== importAuthor || typeof action !== "string") {
				throw new TypeError("v3 room migration import author is invalid");
			}
			const identity = input.application.displacedOperationIdentity(accepted.operation);
			if (typeof identity !== "string" || identity.length === 0) {
				throw new TypeError("v3 room migration import identity is invalid");
			}
			const key = `${accepted.author}\u0000${action}\u0000${identity}`;
			const encoded = encodeCanonical(accepted.operation);
			const prior = rows.get(key);
			if (prior !== undefined && !sameBytes(prior, encoded)) {
				throw new TypeError("v3 room migration import identity conflicts");
			}
			rows.set(key, encoded);
		}
		return rows;
	};
	type DisplacedSource = Readonly<{
		author: string;
		authorSequence: number;
		intents: readonly Readonly<{
			logicalTime: number;
			operation: Readonly<Record<string, unknown>>;
			operationCount: number;
			operationIndex: number;
		}>[];
		publishState?: "pending" | "published";
		vertexDigest: string;
		requiresCreatorSelection: boolean;
		authorizeReplacement: Extract<
			Awaited<ReturnType<RoomPlaneHandle["readRebaseOutbox"]>>,
			{ ok: true; kind: "displaced" }
		>["source"]["authorizeReplacement"];
		withDependencies: Extract<
			Awaited<ReturnType<RoomPlaneHandle["readRebaseOutbox"]>>,
			{ ok: true; kind: "displaced" }
		>["source"]["withDependencies"];
		issueReplacement: Extract<
			Awaited<ReturnType<RoomPlaneHandle["readRebaseOutbox"]>>,
			{ ok: true; kind: "displaced" }
		>["source"]["issueReplacement"];
		prepareReplacement: Extract<
			Awaited<ReturnType<RoomPlaneHandle["readRebaseOutbox"]>>,
			{ ok: true; kind: "displaced" }
		>["source"]["prepareReplacement"];
	}>;
	type RoomSettlementPlan = NonNullable<Awaited<ReturnType<typeof issuanceStore.readSettlementPlan>>>;
	type RoomSettlementPlanEntry = RoomSettlementPlan["entries"][number];
	type RoomReplacementEffect = Readonly<{
		readonly fromIntent: number;
		readonly intentDigest: Uint8Array;
		readonly kind: "replacement";
		readonly sourceSequence: number;
		readonly throughIntent: number;
	}>;
	type RoomSettlementIssueResult = Awaited<ReturnType<RoomPlaneHandle["issueLocal"]>> | null;
	const settlementScope = Object.freeze({ author: input.author, objectId: input.objectId });
	const authenticatedSettlementInheritance = (
		sources: readonly DisplacedSource[]
	): Promise<ReadonlyMap<number, NonNullable<RoomSettlementPlanEntry["inheritance"]>>> => {
		const result = new Map<number, NonNullable<RoomSettlementPlanEntry["inheritance"]>>();
		if (
			redirectSource === undefined ||
			input.application.migration?.inheritAuthenticatedState !== true ||
			!sources.some((source) => source.intents.length !== 0)
		)
			return Promise.resolve(result);
		const decision = redirectSource.activation.decision;
		const acceptedRecord = acceptedOperationSnapshot().find(
			(row) => row.vertexDigest === decision.migrationRecordVertexDigest
		);
		const record = acceptedRecord === undefined ? undefined : migrationRecord(acceptedRecord.operation.record);
		if (
			acceptedRecord === undefined ||
			record === undefined ||
			record.version !== 2 ||
			acceptedRecord.author !== decision.targetCreatorAuthor ||
			digest("ts-drp/v3-room-migration-record/v1", encodeCanonical(record)) !== decision.migrationRecordDigest
		)
			throw new TypeError("v3 room inheritance record authority is unavailable");
		const stateBytes = migrationRecordStateBytes(record);
		const imports = migrationImportIdentityRows();
		const inheritance = Object.freeze({
			sourceObjectId: record.sourceObjectId as string,
			targetObjectId: input.objectId,
			targetAuthor: acceptedRecord.author,
			targetAuthorSequence: acceptedRecord.authorSequence,
			targetVertexDigest: bytes(acceptedRecord.vertexDigest),
		});
		for (const source of sources) {
			if (
				source.intents.length === 0 ||
				!source.intents.every(({ operation }) => {
					if (
						input.application.migration?.containsInheritedOperation?.(operation, stateBytes, {
							sourceAuthor: source.author,
						}) === true
					)
						return true;
					const action = operation.action;
					if (typeof action !== "string" || !input.application.batchableOperationActions.includes(action)) return false;
					const identity = input.application.displacedOperationIdentity(operation);
					const imported = imports.get(`${acceptedRecord.author}\u0000${action}\u0000${identity}`);
					return imported !== undefined && sameBytes(imported, encodeCanonical(operation));
				})
			)
				continue;
			// This is reversible plan metadata, not completion authority. The original
			// held native census reopens every source/target byte before the mandatory
			// fence, successful delivery and authenticated retirement.
			result.set(source.authorSequence, inheritance);
		}
		return Promise.resolve(result);
	};
	const sameReplacementProgress = (left: RoomSettlementPlanEntry, right: RoomSettlementPlanEntry): boolean => {
		if (left.replacementProgress === undefined || right.replacementProgress === undefined) {
			return left.replacementProgress === right.replacementProgress;
		}
		return sameBytes(encodeCanonical(left.replacementProgress), encodeCanonical(right.replacementProgress));
	};
	const sameSettlementEntry = (left: RoomSettlementPlanEntry, right: RoomSettlementPlanEntry): boolean =>
		left.sourceObjectId === right.sourceObjectId &&
		left.sourceSequence === right.sourceSequence &&
		left.disposition === right.disposition &&
		left.replacementSequence === right.replacementSequence &&
		sameBytes(encodeCanonical(left.transformRefusal ?? null), encodeCanonical(right.transformRefusal ?? null)) &&
		sameBytes(encodeCanonical(left.inheritance ?? null), encodeCanonical(right.inheritance ?? null)) &&
		sameReplacementProgress(left, right) &&
		sameBytes(left.sourceDigest, right.sourceDigest);
	const settlementDisposition = (
		source: Pick<DisplacedSource, "intents"> & Partial<Pick<DisplacedSource, "authorSequence">>
	): RoomSettlementPlanEntry["disposition"] | undefined => {
		if (source.intents.length === 0) return undefined;
		const policies = source.intents.map((intent) => {
			const operation = detachedRoomOperation(intent.operation);
			const action = operation === undefined ? undefined : Reflect.get(operation, "action");
			if (operation === undefined || typeof action !== "string") {
				throw new TypeError("v3 room displaced operation is invalid");
			}
			const policy = input.application.displacementPolicies[action];
			if (policy === undefined)
				throw new TypeError(
					`v3 room displacement policy is unavailable: ${JSON.stringify({ action, sequence: source.authorSequence })}`
				);
			const identity = input.application.displacedOperationIdentity(operation);
			if (
				typeof identity !== "string" ||
				identity.length === 0 ||
				input.application.displacedOperationIdentity(operation) !== identity
			) {
				throw new TypeError("v3 room displaced operation identity is invalid");
			}
			return policy;
		});
		if (policies.includes("manual-review")) return "manual-review";
		if (policies.every((policy) => policy === "expire")) return "expire";
		return policies.includes("transform") ? "transform" : "rebase";
	};
	/**
	 * Original plan field constructor shared by native write and prospective sizing.
	 * @param sources - Original displaced sources, or a proven empty future source list.
	 * @param current - Original prior native settlement plan.
	 * @returns Completer for original fence fields, after the original source validation/read ordering.
	 */
	const mergedSettlementPlan = (
		sources: readonly Pick<DisplacedSource, "authorSequence" | "intents" | "vertexDigest">[],
		current: RoomSettlementPlan | null,
		inheritances: ReadonlyMap<number, NonNullable<RoomSettlementPlanEntry["inheritance"]>> = new Map()
	): ((priorFenceEpoch: unknown, activeEpoch: number | undefined) => RoomSettlementPlan) => {
		const priorEntries = new Map(current?.entries.map((entry) => [entry.sourceSequence, entry] as const));
		const entries: RoomSettlementPlanEntry[] = [];
		for (const source of [...sources].sort((left, right) => left.authorSequence - right.authorSequence)) {
			const prior = priorEntries.get(source.authorSequence);
			const inheritance = inheritances.get(source.authorSequence) ?? prior?.inheritance;
			const disposition = inheritance === undefined ? settlementDisposition(source) : "inherited";
			if (disposition === undefined) continue;
			const sourceDigest = bytes(source.vertexDigest);
			const sourceObjectId =
				inheritance === undefined && sourceMaterial !== undefined
					? migrationInviteAuthority(sourceMaterial).objectId
					: undefined;
			if (sourceDigest.byteLength !== 32) throw new TypeError("v3 room displaced source digest is invalid");
			if (
				prior !== undefined &&
				(prior.sourceObjectId !== sourceObjectId ||
					!sameBytes(prior.sourceDigest, sourceDigest) ||
					prior.disposition !== disposition ||
					!sameBytes(encodeCanonical(prior.inheritance ?? null), encodeCanonical(inheritance ?? null)))
			) {
				throw new TypeError("v3 room settlement plan source differs");
			}
			entries.push(
				Object.freeze({
					disposition,
					...(sourceObjectId === undefined ? {} : { sourceObjectId }),
					...(inheritance === undefined ? {} : { inheritance }),
					...(prior?.replacementProgress === undefined ? {} : { replacementProgress: prior.replacementProgress }),
					...(prior?.transformRefusal === undefined ? {} : { transformRefusal: prior.transformRefusal }),
					replacementSequence: prior?.replacementSequence ?? null,
					sourceDigest,
					sourceSequence: source.authorSequence,
				})
			);
		}
		// A new operational anchor can terminalize a source that was already
		// replaced. Absence from the current rebase scan does not erase its durable
		// intent/source/replacement link; authenticated pruning owns that removal.
		for (const prior of current?.entries ?? []) {
			if (!entries.some((entry) => entry.sourceSequence === prior.sourceSequence)) entries.push(prior);
		}
		entries.sort((left, right) => left.sourceSequence - right.sourceSequence);
		const displacedSequences = new Set(sources.map((source) => source.authorSequence));
		return (priorFenceEpoch, activeEpoch): RoomSettlementPlan => {
			const fenceSequence =
				current?.fenceSequence !== null &&
				current?.fenceSequence !== undefined &&
				(displacedSequences.has(current.fenceSequence) || priorFenceEpoch !== activeEpoch)
					? null
					: (current?.fenceSequence ?? null);
			const unchanged =
				current !== null &&
				current.fenceSequence === fenceSequence &&
				current.entries.length === entries.length &&
				current.entries.every((entry, index) => {
					const candidate = entries[index];
					return candidate !== undefined && sameSettlementEntry(entry, candidate);
				});
			if (unchanged) return current;
			const expectedRevision = current?.revision ?? null;
			const plan = Object.freeze({
				entries: Object.freeze(entries),
				fenceSequence,
				revision: expectedRevision === null ? 0 : expectedRevision + 1,
				scope: settlementScope,
			});
			return plan;
		};
	};
	const writeMergedSettlementPlan = async (sources: readonly DisplacedSource[]): Promise<RoomSettlementPlan> => {
		const current = await issuanceStore.readSettlementPlan(settlementScope);
		const completePlan = mergedSettlementPlan(sources, current, await authenticatedSettlementInheritance(sources));
		const priorFence =
			current?.fenceSequence == null
				? undefined
				: await issuanceStore.readIssued(settlementScope, current.fenceSequence);
		const priorFenceEpoch =
			priorFence == null
				? undefined
				: Reflect.get(decodeCanonical(priorFence.envelope.canonicalPreimageBytes) as object, "epoch");
		const plan = completePlan(priorFenceEpoch, activeHandle?.epoch);
		if (current !== null && plan === current) return current;
		return issuanceStore.transactWriteSettlementPlan({
			expectedRevision: current?.revision ?? null,
			plan,
			scope: settlementScope,
		});
	};
	const readSettlementEffect = (
		prior: RoomSettlementPlan,
		plan: RoomSettlementPlan | null,
		authorSequence: number,
		effect: Readonly<
			| { readonly kind: "fence" }
			| { readonly kind: "replacement"; readonly sourceSequence: number }
			| RoomReplacementEffect
		>
	): boolean => {
		if (plan === null || plan.revision !== prior.revision + 1 || plan.entries.length !== prior.entries.length)
			return false;
		if (effect.kind === "fence")
			return (
				plan.fenceSequence === authorSequence &&
				prior.fenceSequence === null &&
				plan.entries.every((entry, index) =>
					sameSettlementEntry(entry, prior.entries[index] as RoomSettlementPlanEntry)
				)
			);
		if (plan.fenceSequence !== prior.fenceSequence) return false;
		const entry = plan.entries.find((candidate) => candidate.sourceSequence === effect.sourceSequence);
		const before = prior.entries.find((candidate) => candidate.sourceSequence === effect.sourceSequence);
		if (
			entry === undefined ||
			before === undefined ||
			before.replacementSequence !== null ||
			entry.disposition !== before.disposition ||
			!sameBytes(encodeCanonical(entry.transformRefusal ?? null), encodeCanonical(before.transformRefusal ?? null)) ||
			!sameBytes(entry.sourceDigest, before.sourceDigest) ||
			plan.entries.some(
				(row, index) =>
					row.sourceSequence !== effect.sourceSequence &&
					!sameSettlementEntry(row, prior.entries[index] as RoomSettlementPlanEntry)
			)
		)
			return false;
		if (!("fromIntent" in effect))
			return (
				before.replacementProgress === undefined &&
				entry.replacementProgress === undefined &&
				entry.replacementSequence === authorSequence
			);
		const progress = entry?.replacementProgress;
		const previous = before.replacementProgress;
		const chunk = progress?.chunks.at(-1);
		return (
			progress !== undefined &&
			previous !== undefined &&
			progress.intentCount === previous.intentCount &&
			progress.chunks.length === previous.chunks.length + 1 &&
			(previous.chunks.at(-1)?.throughIntent ?? 0) === effect.fromIntent &&
			progress.chunks
				.slice(0, -1)
				.every((row, index) => sameBytes(encodeCanonical(row), encodeCanonical(previous.chunks[index]))) &&
			sameBytes(previous.intentDigest, effect.intentDigest) &&
			sameBytes(progress.intentDigest, effect.intentDigest) &&
			chunk?.replacementSequence === authorSequence &&
			chunk.throughIntent === effect.throughIntent &&
			entry.replacementSequence === (effect.throughIntent === progress.intentCount ? authorSequence : null)
		);
	};
	const recoverSettlementOwner = async (receivedRetry = false): Promise<void> => {
		const predecessor = activeHandle;
		const predecessorClose = creatorCloseHandle;
		if ((!receivedRetry && predecessor === undefined) || recoverStartupPlane === undefined)
			throw new TypeError("v3 room recovery custody is unavailable");
		try {
			await Promise.resolve(predecessor?.deactivate());
			activeHandle = undefined;
			// Recovery uses independently authenticated native current truth, not
			// the displaced close's sealed facts. Join that owner's readers before
			// any recovered successor can perform native cleanup or turnover.
			await predecessorClose?.stop();
			await recoverStartupPlane();
			if (activeHandle === undefined) throw new TypeError("v3 room recovery activation is unavailable");
			if (predecessorClose !== undefined) {
				const rebound = await bindCurrentCreatorClose?.(activeHandle);
				if (rebound?.ok !== true) {
					creatorCloseRebindFailure = new TypeError("D110C_B_CLOSE_REBIND_FAILED");
					throw creatorCloseRebindFailure;
				}
				creatorCloseHandle = rebound.handle;
				creatorCloseUnavailableContinuity = "continuous";
			}
			if (receivedRetry) terminalFailure = undefined;
		} catch (error) {
			terminalFailure = error;
			return throwAfterJoinedCleanup(error, [
				shutdown,
				(): Promise<void> => predecessorClose?.stop() ?? Promise.resolve(),
			]);
		}
	};
	let recoveredSettlementSources:
		| Readonly<{ owner: RoomPlaneHandle; sources: ReadonlyMap<number, DisplacedSource> }>
		| undefined;
	const readRecoveredSettlementSources = async (): Promise<ReadonlyMap<number, DisplacedSource>> => {
		if (activeHandle === undefined) throw new TypeError("v3 room replacement recovery owner is unavailable");
		if (recoveredSettlementSources?.owner === activeHandle) return recoveredSettlementSources.sources;
		const sources = new Map<number, DisplacedSource>();
		let previousSequence = -1;
		for (let count = 0; count <= 8192; count += 1) {
			const page = await activeHandle.readRebaseOutbox();
			if (!page.ok) throw new TypeError("v3 room replacement recovery source is unavailable");
			if (page.kind === "empty") {
				recoveredSettlementSources = Object.freeze({ owner: activeHandle, sources });
				return sources;
			}
			if (count === 8192 || page.source.author !== input.author || page.source.authorSequence <= previousSequence)
				throw new TypeError("v3 room replacement recovery source did not advance");
			previousSequence = page.source.authorSequence;
			sources.set(page.source.authorSequence, page.source);
		}
		throw new TypeError("v3 room replacement recovery source is unbounded");
	};
	// Track X (decision row 51): the settlement creator's startup drain issues its
	// fence and replacements locally and the startup barrier publishes them after readiness
	// (rebasePromise). Every other drain (successor adoption) publishes each issue at once.
	let settlementDrainPublication: "immediate" | "after-readiness" = "immediate";
	const issueSettlement = async (
		operations: readonly Readonly<{
			readonly logicalTime: number;
			readonly operation: Readonly<Record<string, unknown>>;
		}>[],
		effect: Readonly<
			| { readonly kind: "fence" }
			| { readonly kind: "replacement"; readonly sourceSequence: number }
			| RoomReplacementEffect
		>,
		source?: DisplacedSource,
		mayRecover = true
	): Promise<RoomSettlementIssueResult> => {
		if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
		const prior = await issuanceStore.readSettlementPlan(settlementScope);
		const lineage = await issuanceStore.readLineage(settlementScope);
		if (prior === null || lineage.exhausted || !Number.isSafeInteger(lineage.next))
			throw new TypeError("v3 room settlement issue custody is unavailable");
		let signed = false;
		const localInput = {
			operations: Object.freeze(operations),
			...(effect.kind === "replacement" ? { planEffect: effect } : {}),
			signRegisteredVertexDigest: async (value: Uint8Array, request: Parameters<SignRegisteredVertexDigest>[1]) => {
				const signature = await input.signRegisteredVertexDigest(value, request);
				signed = true;
				return signature;
			},
		} as Parameters<RoomPlaneHandle["issueLocal"]>[0] & { planEffect: RoomReplacementEffect };
		if (effect.kind === "replacement" && source === undefined)
			throw new TypeError("v3 room replacement owning source is unavailable");
		const issued =
			effect.kind === "replacement"
				? await (source as DisplacedSource).issueReplacement(localInput)
				: await activeHandle.issueLocal(localInput);
		if (!issued.ok) {
			if (issued.kind === "split-required") return issued;
			const observed = await issuanceStore.readSettlementPlan(settlementScope);
			const linked = readSettlementEffect(prior, observed, lineage.next, effect);
			const unchanged = observed !== null && sameBytes(encodeCanonical(observed), encodeCanonical(prior));
			if (!mayRecover || (!linked && !(signed && unchanged))) {
				throw new TypeError(
					`v3 room settlement issue failed: ${issued.kind}${"detail" in issued ? `: ${issued.detail}` : ""}`,
					{ cause: issued }
				);
			}
			await recoverSettlementOwner();
			if (linked) {
				if (settlementDrainPublication === "immediate") {
					await publishAccepted();
				}
				return null;
			}
			let recoveredSource = source;
			if (effect.kind === "replacement") {
				if (source === undefined) throw new TypeError("v3 room replacement recovery source is unavailable");
				recoveredSource = (await readRecoveredSettlementSources()).get(source.authorSequence);
				if (
					recoveredSource === undefined ||
					recoveredSource.vertexDigest !== source.vertexDigest ||
					!sameBytes(encodeCanonical(recoveredSource.intents), encodeCanonical(source.intents))
				)
					throw new TypeError("v3 room replacement recovery source differs");
				if (
					authorizeSettlementSource !== undefined &&
					(explicitSettlementSourceAuthorization || recoveredSource.requiresCreatorSelection)
				)
					await recoveredSource.authorizeReplacement(authorizeSettlementSource);
				else if (recoveredSource.requiresCreatorSelection)
					throw new TypeError(
						"v3 room exact source-to-target creator authorization is required; protected work remains recoverable"
					);
			}
			return issueSettlement(operations, effect, recoveredSource, false);
		}
		if (effect.kind === "fence") {
			const committed = await issuanceStore.readIssued(settlementScope, issued.authorSequence);
			if (committed === null) throw new TypeError("v3 committed settlement fence is unavailable");
			const preimage = decodeCanonical(committed.issuedRecord.envelope.canonicalPreimageBytes);
			if (
				typeof preimage !== "object" ||
				preimage === null ||
				!Number.isSafeInteger(Reflect.get(preimage, "logicalTime"))
			)
				throw new TypeError("v3 committed settlement fence clock is invalid");
			logicalTime = Math.max(logicalTime, (Reflect.get(preimage, "logicalTime") as number) + 2);
		}
		if (settlementDrainPublication === "immediate") {
			await publishAccepted();
		}
		return issued;
	};
	const drainSettlementOutbox = async (sources: readonly DisplacedSource[]): Promise<void> => {
		if (sources.length === 0) {
			const existing = await issuanceStore.readSettlementPlan(settlementScope);
			const lineage = await issuanceStore.readLineage(settlementScope);
			// A genuinely virgin author has no historical issuance to fence. Do not
			// spend its first sequence merely by reopening; nonzero custody keeps
			// the complete existing settlement/fence path below.
			if (
				!lineage.exhausted &&
				lineage.next === 0 &&
				(existing === null || (existing.entries.length === 0 && existing.fenceSequence === null)) &&
				(await issuanceStore.readIssued(settlementScope, 0)) === null &&
				(await issuanceStore.readOutboxPage({ scope: settlementScope, afterKey: null, limit: 1 })).length === 0
			)
				return;
		}
		let plan = await writeMergedSettlementPlan(sources);
		if (plan.entries.some((entry) => entry.disposition === "manual-review")) {
			settlementHeld = true;
			return;
		}
		const sourceBySequence = new Map(sources.map((source) => [source.authorSequence, source] as const));
		let sourceOwner = activeHandle;
		const refreshSourceOwner = async (): Promise<void> => {
			if (sourceOwner === activeHandle) return;
			if (activeHandle === undefined) throw new TypeError("v3 room replacement recovery owner is unavailable");
			const recoveredSources = await readRecoveredSettlementSources();
			// Capabilities belong to the active registration, not to durable progress.
			// Rebind only still-unsettled exact sources after the old owner has joined.
			const current = await issuanceStore.readSettlementPlan(settlementScope);
			if (current === null) throw new TypeError("v3 room replacement recovery plan is unavailable");
			for (const entry of current.entries) {
				if (entry.disposition === "expire" || entry.disposition === "inherited" || entry.replacementSequence !== null)
					continue;
				const selected = recoveredSources.get(entry.sourceSequence);
				const original = sourceBySequence.get(entry.sourceSequence);
				if (
					selected === undefined ||
					original === undefined ||
					original.vertexDigest !== selected.vertexDigest ||
					!sameBytes(encodeCanonical(original.intents), encodeCanonical(selected.intents))
				)
					throw new TypeError("v3 room replacement recovery source differs");
				if (
					authorizeSettlementSource !== undefined &&
					(explicitSettlementSourceAuthorization || selected.requiresCreatorSelection)
				)
					await selected.authorizeReplacement(authorizeSettlementSource);
				else if (selected.requiresCreatorSelection)
					throw new TypeError(
						"v3 room exact source-to-target creator authorization is required; protected work remains recoverable"
					);
				sourceBySequence.set(entry.sourceSequence, selected);
			}
			sourceOwner = activeHandle;
		};
		const orderedBySequence = new Map<number, readonly Readonly<Record<string, unknown>>[]>();
		for (const entry of plan.entries) {
			if (entry.disposition === "expire" || entry.disposition === "inherited" || entry.replacementSequence !== null)
				continue;
			const source = sourceBySequence.get(entry.sourceSequence);
			if (source === undefined) throw new TypeError("v3 room settlement source is unavailable");
			const prepared = await source.prepareReplacement();
			if (source.requiresCreatorSelection && authorizeSettlementSource === undefined) {
				settlementAuthorizationHeld = true;
				return;
			}
			if (prepared.disposition !== entry.disposition)
				throw new TypeError("replacement preparation disposition changed");
			if (entry.transformRefusal !== undefined) {
				if (
					prepared.transformRefusal === undefined ||
					!sameBytes(entry.transformRefusal.proposedIntentDigest, prepared.transformRefusal.proposedIntentDigest)
				)
					throw new TypeError("replacement durable refusal changed");
			} else if (prepared.transformRefusal !== undefined) {
				const transformRefusal = prepared.transformRefusal;
				if (plan.fenceSequence !== null || entry.replacementProgress !== undefined)
					throw new TypeError("replacement refusal must precede fence and effects");
				plan = await issuanceStore.transactWriteSettlementPlan({
					expectedRevision: plan.revision,
					scope: settlementScope,
					plan: Object.freeze({
						...plan,
						revision: plan.revision + 1,
						entries: Object.freeze(
							plan.entries.map((row) =>
								row.sourceSequence === entry.sourceSequence ? Object.freeze({ ...row, transformRefusal }) : row
							)
						),
					}),
				});
			}
			const ordered = prepared.operations;
			if (
				authorizeSettlementSource !== undefined &&
				(explicitSettlementSourceAuthorization || source.requiresCreatorSelection)
			)
				await source.authorizeReplacement(authorizeSettlementSource);
			const progress = entry.replacementProgress;
			if (
				progress !== undefined &&
				(progress.intentCount !== ordered.length ||
					!sameBytes(
						progress.intentDigest,
						hashDomain(
							"ts-drp/settlement-replacement-intents/v1",
							encodeCanonical(ordered, SETTLEMENT_REPLACEMENT_DIGEST_LIMITS)
						)
					))
			) {
				throw new TypeError("v3 room settlement replacement intent digest changed");
			}
			orderedBySequence.set(entry.sourceSequence, ordered);
		}
		if (plan.fenceSequence === null) {
			const lineage = await issuanceStore.readLineage(settlementScope);
			if (!Number.isSafeInteger(lineage.next) || lineage.next < 0 || lineage.exhausted) {
				throw new TypeError("v3 room settlement fence lineage is unavailable");
			}
			const fenceLogicalTime = logicalTime;
			logicalTime += 2;
			await issueSettlement(
				Object.freeze([
					Object.freeze({
						logicalTime: fenceLogicalTime,
						operation: Object.freeze({
							action: "$drp.author-fence.v1",
							fenceSequence: lineage.next,
							version: 1,
						}),
					}),
				]),
				Object.freeze({ kind: "fence" })
			);
			plan = (await issuanceStore.readSettlementPlan(settlementScope)) ?? plan;
		}
		for (const entry of plan.entries) {
			if (entry.disposition === "expire" || entry.disposition === "inherited" || entry.replacementSequence !== null)
				continue;
			await refreshSourceOwner();
			const ordered = orderedBySequence.get(entry.sourceSequence);
			let source = sourceBySequence.get(entry.sourceSequence);
			if (source === undefined) throw new TypeError("v3 room replacement source is unavailable");
			if (ordered === undefined) throw new TypeError("v3 room settlement replacement is unavailable");
			const intentDigest = hashDomain(
				"ts-drp/settlement-replacement-intents/v1",
				encodeCanonical(ordered, SETTLEMENT_REPLACEMENT_DIGEST_LIMITS)
			);
			const durableProgress = entry.replacementProgress;
			if (
				durableProgress !== undefined &&
				(durableProgress.intentCount !== ordered.length || !sameBytes(durableProgress.intentDigest, intentDigest))
			) {
				throw new TypeError("v3 room settlement replacement intent digest changed");
			}
			const consumed = durableProgress?.chunks.at(-1)?.throughIntent ?? 0;
			const lastLogicalTime = durableProgress?.chunks.at(-1)?.lastLogicalTime;
			if (lastLogicalTime !== undefined) logicalTime = Math.max(logicalTime, lastLogicalTime + 2);
			const allocateOperations = (
				fromIntent: number
			): readonly Readonly<{ readonly logicalTime: number; readonly operation: Readonly<Record<string, unknown>> }>[] =>
				Object.freeze(
					ordered.slice(fromIntent).map((operation) => {
						const selected = Object.freeze({ logicalTime, operation });
						logicalTime += 2;
						return selected;
					})
				);
			const operationBaseIntent = consumed;
			const operations = allocateOperations(consumed);
			let initialPrefixLength: number | undefined;
			if (durableProgress === undefined) {
				const legacy = await issueSettlement(
					operations,
					Object.freeze({ kind: "replacement", sourceSequence: entry.sourceSequence }),
					source
				);
				if (legacy === null || legacy.ok) continue;
				if (legacy.kind !== "split-required") throw new TypeError("v3 room settlement split result is invalid");
				initialPrefixLength = legacy.prefixLength;
				const current = await issuanceStore.readSettlementPlan(settlementScope);
				const selected = current?.entries.find((candidate) => candidate.sourceSequence === entry.sourceSequence);
				if (current === null || selected === undefined || selected.replacementSequence !== null) {
					throw new TypeError("v3 room settlement split plan changed");
				}
				plan = await issuanceStore.transactWriteSettlementPlan({
					expectedRevision: current.revision,
					plan: Object.freeze({
						...current,
						entries: Object.freeze(
							current.entries.map((candidate) =>
								candidate.sourceSequence === entry.sourceSequence
									? Object.freeze({
											...candidate,
											replacementProgress: Object.freeze({
												chunks: Object.freeze([]),
												intentCount: ordered.length,
												intentDigest,
												version: 1 as const,
											}),
										})
									: candidate
							)
						),
						revision: current.revision + 1,
					}),
					scope: settlementScope,
				});
			}
			let fromIntent = consumed;
			const refreshProgressPrefix = async (expectedThrough: number): Promise<void> => {
				const current = await issuanceStore.readSettlementPlan(settlementScope);
				const selected = current?.entries.find((candidate) => candidate.sourceSequence === entry.sourceSequence);
				const progress = selected?.replacementProgress;
				if (
					current === null ||
					progress === undefined ||
					!sameBytes(progress.intentDigest, intentDigest) ||
					(progress.chunks.at(-1)?.throughIntent ?? 0) !== expectedThrough
				) {
					throw new TypeError("v3 room settlement replacement progress did not advance");
				}
				plan = current;
			};
			while (fromIntent < ordered.length) {
				await refreshSourceOwner();
				source = sourceBySequence.get(entry.sourceSequence);
				if (source === undefined) throw new TypeError("v3 room replacement source is unavailable");
				if (fromIntent > 0) {
					const source = sourceBySequence.get(entry.sourceSequence);
					if (source === undefined || roomHeadAuthority?.acquireNativeReadReservation === undefined)
						throw new TypeError("active settlement native source/floor custody is unavailable");
					const floorView = await roomHeadAuthority.acquireNativeReadReservation({ scope: roomHeadScope });
					let failed = false,
						primary: unknown;
					try {
						const before = await readRoomHeadAuthority(roomHeadAuthority, roomHeadScope);
						if (before.pending !== null || before.stable.epoch !== activeHandle?.epoch)
							throw new TypeError("active settlement floor is stale");
						await source.withDependencies(async (view, proofByteCharge) => {
							const bytes = view.readExactCanonicalCensus();
							if (proofByteCharge < bytes.byteLength || proofByteCharge > CREATOR_MAINTENANCE_PROOF_MAX_BYTES)
								throw new TypeError("active settlement proof accounting is invalid");
							const census = decodeCanonical(bytes, {
								maxBytes: CREATOR_MAINTENANCE_PROOF_MAX_BYTES,
								maxDepth: 32,
								maxItems: 65536,
							}) as {
								activeUnsettled: { sourceSequence: number; sourceDigest: Uint8Array };
								currentJournal: { scope: { objectId: string; epoch: number; anchorDigest: string } };
								debt: { scope: { author: string; objectId: string }; planIndex: number }[];
								nativeIssuance: { rows: { plans: RoomSettlementPlan[] } };
							};
							// The original census carries complete native plans once;
							// debt references that same image by index, not an inline copy.
							const debt = census.debt.find(
								(row) => row.scope.author === input.author && row.scope.objectId === input.objectId
							);
							const actualPlan =
								debt !== undefined && Number.isSafeInteger(debt.planIndex) && debt.planIndex >= 0
									? census.nativeIssuance.rows.plans[debt.planIndex]
									: undefined;
							if (
								census.currentJournal.scope.objectId !== before.stable.objectId ||
								census.currentJournal.scope.epoch !== before.stable.epoch ||
								census.currentJournal.scope.anchorDigest !== before.stable.currentAnchorDigest
							)
								throw new TypeError("active settlement native floor differs from owning runtime");
							if (
								census.activeUnsettled.sourceSequence !== entry.sourceSequence ||
								!sameBytes(census.activeUnsettled.sourceDigest, entry.sourceDigest) ||
								actualPlan === undefined ||
								!sameBytes(encodeCanonical(actualPlan), encodeCanonical(plan))
							)
								throw new TypeError("active settlement source/progress currency is stale");
							await floorView.check();
							if (roomHeadAuthority === undefined) throw new TypeError("active settlement room-head authority absent");
							const after = await readRoomHeadAuthority(roomHeadAuthority, roomHeadScope);
							if (!sameBytes(encodeCanonical(before), encodeCanonical(after)))
								throw new TypeError("active settlement floor changed");
						});
					} catch (error) {
						failed = true;
						primary = error;
					}
					try {
						await floorView.release();
					} catch (error) {
						throw new AggregateError(
							failed ? [primary, error] : [error],
							"active settlement floor release",
							failed ? { cause: primary } : undefined
						);
					}
					if (failed) throw primary;
					// All original native RO turns are joined before the original issue below.
				}
				const remaining = operations.slice(fromIntent - operationBaseIntent);
				const effect = (throughIntent: number): RoomReplacementEffect =>
					Object.freeze({
						fromIntent,
						intentDigest,
						kind: "replacement",
						sourceSequence: entry.sourceSequence,
						throughIntent,
					});
				if (initialPrefixLength !== undefined) {
					if (
						!Number.isSafeInteger(initialPrefixLength) ||
						initialPrefixLength < 1 ||
						initialPrefixLength >= remaining.length
					) {
						throw new TypeError("v3 room settlement split prefix is invalid");
					}
					const throughIntent = fromIntent + initialPrefixLength;
					await issueSettlement(remaining.slice(0, initialPrefixLength), effect(throughIntent), source);
					await refreshProgressPrefix(throughIntent);
					fromIntent = throughIntent;
					initialPrefixLength = undefined;
					continue;
				}
				const attempted = await issueSettlement(remaining, effect(ordered.length), source);
				if (attempted === null || attempted.ok) {
					await refreshProgressPrefix(ordered.length);
					fromIntent = ordered.length;
					continue;
				}
				if (
					attempted.kind !== "split-required" ||
					!Number.isSafeInteger(attempted.prefixLength) ||
					attempted.prefixLength < 1 ||
					attempted.prefixLength >= remaining.length
				) {
					throw new TypeError("v3 room settlement split prefix is invalid");
				}
				const throughIntent = fromIntent + attempted.prefixLength;
				await issueSettlement(remaining.slice(0, attempted.prefixLength), effect(throughIntent), source);
				await refreshProgressPrefix(throughIntent);
				fromIntent = throughIntent;
			}
		}
	};
	const drainRebaseOutbox = async (publication: "immediate" | "after-readiness" = "immediate"): Promise<void> => {
		if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
		const sources: DisplacedSource[] = [];
		for (;;) {
			const page = await activeHandle.readRebaseOutbox();
			if (!page.ok) throw new TypeError(`v3 room rebase outbox failed: ${page.kind}: ${page.detail}`, { cause: page });
			if (page.kind === "empty") break;
			if (page.source.author !== input.author) {
				throw new TypeError("v3 room displaced source author is invalid");
			}
			sources.push(page.source);
			if (sources.length > 8192) throw new TypeError("v3 room rebase outbox is unbounded");
			if (
				sources.some((source, index) => index + 1 < sources.length && source.vertexDigest === page.source.vertexDigest)
			) {
				throw new TypeError("v3 room rebase outbox did not advance");
			}
			if (
				settlementProfile === "none" &&
				page.source.intents.length === 0 &&
				page.source.publishState !== "published"
			) {
				const completed = await activeHandle.completeRebaseSource({
					authorSequence: page.source.authorSequence,
					digest: page.source.vertexDigest,
				});
				if (!completed.ok) throw new TypeError(`v3 room rebase completion failed: ${completed.kind}`);
			}
		}
		if (settlementProfile === "v1") {
			settlementDrainPublication = publication;
			try {
				await drainSettlementOutbox(sources);
			} finally {
				settlementDrainPublication = "immediate";
				// These nominal sources authorize only this joined drain. Do not
				// retain old registrations as a long-lived capability cache.
				recoveredSettlementSources = undefined;
			}
			return;
		}
		const acceptedRows = acceptedIdentityRows();
		const migrationImportRows = migrationImportIdentityRows();
		const inheritedSources = await authenticatedSettlementInheritance(sources);
		if (redirectSource === undefined && sourceMaterial !== undefined) {
			for (const source of sources.filter(({ publishState }) => publishState === "published")) {
				for (const intent of source.intents) {
					const operation = detachedRoomOperation(intent.operation);
					const action = operation === undefined ? undefined : Reflect.get(operation, "action");
					if (operation === undefined || typeof action !== "string") {
						throw new TypeError("v3 room published displaced operation is invalid");
					}
					const policy = input.application.displacementPolicies[action];
					if (policy !== "rebase" && policy !== "transform") {
						throw new TypeError("v3 room published displaced operation policy is invalid");
					}
					const identity = input.application.displacedOperationIdentity(operation);
					if (typeof identity !== "string" || identity.length === 0) {
						throw new TypeError("v3 room published displaced operation identity is invalid");
					}
					let selected = operation;
					if (policy === "transform") {
						const transform = input.application.transformDisplacedOperation;
						const transformed = transform === undefined ? undefined : detachedRoomOperation(transform(operation));
						if (
							transformed === undefined ||
							Reflect.get(transformed, "action") !== action ||
							input.application.displacedOperationIdentity(transformed) !== identity
						) {
							throw new TypeError("v3 room published displaced transform is invalid");
						}
						selected = transformed;
					}
					const acceptedBytes = acceptedRows.get(`${source.author}\u0000${action}\u0000${identity}`);
					if (acceptedBytes === undefined) {
						throw new TypeError("v3 room published displaced operation is absent from target");
					}
					if (!sameBytes(acceptedBytes, encodeCanonical(selected))) {
						throw new TypeError("v3 room published displaced operation identity conflicts");
					}
				}
			}
		}
		const sourceRows = new Map<string, Uint8Array>();
		const capturedMaximum = sources.reduce(
			(maximum, source) =>
				source.intents.reduce((sourceMaximum, intent) => Math.max(sourceMaximum, intent.logicalTime), maximum),
			-1
		);
		logicalTime = Math.max(logicalTime, capturedMaximum + 2);
		const states = sources
			.filter(
				({ intents, publishState }) =>
					intents.length > 0 && (redirectSource !== undefined || publishState !== "published")
			)
			.map((source) => ({ held: false, issued: [] as Promise<void>[], source }));
		const orderedIntents = states
			.flatMap((state) => state.source.intents.map((intent) => ({ intent, state })))
			.sort(
				(left, right) =>
					left.intent.logicalTime - right.intent.logicalTime ||
					compareText(left.state.source.author, right.state.source.author) ||
					left.state.source.authorSequence - right.state.source.authorSequence ||
					compareText(left.state.source.vertexDigest, right.state.source.vertexDigest) ||
					left.intent.operationIndex - right.intent.operationIndex
			);
		for (const { intent, state } of orderedIntents) {
			const source = state.source;
			if (inheritedSources.has(source.authorSequence)) continue;
			const operation = detachedRoomOperation(intent.operation);
			const action = operation === undefined ? undefined : Reflect.get(operation, "action");
			if (operation === undefined || typeof action !== "string") {
				throw new TypeError("v3 room displaced operation is invalid");
			}
			const policy = input.application.displacementPolicies[action];
			if (policy === undefined) throw new TypeError("v3 room displacement policy is unavailable");
			const identity = input.application.displacedOperationIdentity(operation);
			if (
				typeof identity !== "string" ||
				identity.length === 0 ||
				input.application.displacedOperationIdentity(operation) !== identity
			) {
				throw new TypeError("v3 room displaced operation identity is invalid");
			}
			const key = `${source.author}\u0000${action}\u0000${identity}`;
			const sourceBytes = encodeCanonical(operation);
			const priorSourceBytes = sourceRows.get(key);
			if (priorSourceBytes !== undefined && !sameBytes(priorSourceBytes, sourceBytes)) {
				throw new TypeError("v3 room displaced operation identity conflicts");
			}
			sourceRows.set(key, sourceBytes);
			if (policy === "expire") continue;
			if (policy === "manual-review") {
				state.held = true;
				continue;
			}
			let selected = operation;
			if (policy === "transform") {
				const transform = input.application.transformDisplacedOperation;
				if (transform === undefined) throw new TypeError("v3 room displaced transform is unavailable");
				const first = detachedRoomOperation(transform(operation));
				const second = detachedRoomOperation(transform(operation));
				if (
					first === undefined ||
					second === undefined ||
					!sameBytes(encodeCanonical(first), encodeCanonical(second)) ||
					Reflect.get(first, "action") !== action ||
					input.application.displacedOperationIdentity(first) !== identity
				) {
					throw new TypeError("v3 room displaced transform is unstable");
				}
				selected = first;
			}
			const selectedBytes = encodeCanonical(selected);
			const acceptedBytes = acceptedRows.get(key);
			const importKey = `${redirectSource?.activation.decision.targetCreatorAuthor ?? ""}\u0000${action}\u0000${identity}`;
			const importedBytes = migrationImportRows.get(importKey);
			if (acceptedBytes !== undefined) {
				if (!sameBytes(acceptedBytes, selectedBytes)) {
					throw new TypeError("v3 room displaced operation identity conflicts");
				}
				continue;
			}
			if (importedBytes !== undefined) {
				if (!sameBytes(importedBytes, selectedBytes)) {
					throw new TypeError("v3 room displaced import identity conflicts");
				}
				continue;
			}
			acceptedRows.set(key, selectedBytes);
			const selectedLogicalTime = logicalTime;
			logicalTime += 2;
			state.issued.push(
				new Promise<void>((resolve, reject) => {
					pendingIssues.push(
						Object.freeze({
							source: "authenticated-historical",
							group: `${action}\u0000${policy}`,
							logicalTime: selectedLogicalTime,
							operation: selected,
							reject,
							resolve,
						})
					);
				})
			);
		}
		const issued = states.flatMap((state) => state.issued);
		if (issued.length > 0) {
			scheduleDrain();
			await Promise.all(issued);
		}
		for (const { held, source } of states) {
			if (!held && source.publishState !== "published") {
				const completed = await activeHandle.completeRebaseSource({
					authorSequence: source.authorSequence,
					digest: source.vertexDigest,
				});
				if (!completed.ok) throw new TypeError(`v3 room rebase completion failed: ${completed.kind}`);
			}
		}
	};
	/** Explicit boundary preparation, never a lazy ordinary-call fallback. The
	 * session may be returned while retained bootstrap is still arriving; its
	 * existing startup/rebase barrier must not report ready before this joins. */
	const prepareCurrentCreatorOrdinaryReadiness = async (): Promise<void> => {
		if (input.receiveOnly || creatorCloseHandle === undefined) return;
		if (terminalFailure !== undefined) throw terminalFailure;
		if (closed || activeHandle === undefined) throw new TypeError("v3 room ordinary readiness owner is unavailable");
		const plane = activeHandle;
		await prepareCreatorOrdinaryReadiness(plane);
		if (terminalFailure !== undefined) throw terminalFailure;
		if (closed || activeHandle !== plane) throw new TypeError("v3 room ordinary readiness owner changed");
	};
	const rebasePromise =
		input.receiveOnly
			? Promise.resolve()
			: enqueueLifetimeTransition(async () => {
					try {
						if (!(settlementProfile === "none" && sourceMaterial === undefined && selectRoomStartup() !== "successor")) {
							await waitForRetainedBootstrap();
							if (terminalFailure !== undefined) throw terminalFailure;
							if (settlementProfile !== "v1") {
								await publishAccepted();
							}
							await drainRebaseOutbox(settlementProfile === "v1" ? "after-readiness" : "immediate");
						}
						await prepareCurrentCreatorOrdinaryReadiness();
						// Settlement (decision row 51): every publication waits for a subscriber
						// on the topic inside the plane's FIFO (network node.ts waitForSubscriber), so
						// readiness is prepared on the local drain's postimage first. Then every accepted
						// row is published in author-sequence order before the barrier resolves.
						if (settlementProfile === "v1") {
							await publishAccepted();
						}
					} catch (error) {
						terminalFailure = error;
						try {
							await shutdown();
						} catch (cleanup) {
							throw combineFailures(error, cleanup);
						}
						throw error;
					}
				});
	void rebasePromise.catch((error: unknown) => {
		terminalFailure = error;
	});
	if (settlementProfile === "v1" && creatorCloseHandle !== undefined) {
		const startupSettled = rebasePromise.then(
			() => undefined,
			() => undefined
		);
		startupGossipRepublicationBarrier = startupSettled;
		void startupSettled.then(() => {
			if (startupGossipRepublicationBarrier === startupSettled) startupGossipRepublicationBarrier = undefined;
		});
	}
	if (recoveredActivation !== undefined) {
		try {
			await publishAccepted();
			if (activeHandle === undefined) throw new TypeError("v3 room retained source plane is unavailable");
			const replayed = await activeHandle.republishRetained();
			if (!replayed.ok) throw new TypeError(`v3 room terminal replay failed: ${replayed.kind}`);
			const redirect = ensureRedirect(recoveredActivation);
			const startup = await Promise.race([
				redirect.then(() => "ready" as const),
				redirectBootstrapHold.then(() => "held" as const),
			]);
			if (startup === "held") {
				void redirect.catch((error: unknown) => {
					if (!closed) terminalFailure = error;
				});
			}
		} catch (error) {
			await shutdown().catch(() => undefined);
			throw error;
		}
	}
	const performMigrationRehearsal = async (
		rehearsalInput: V3RoomMigrationRehearsalInput
	): Promise<V3RoomMigrationRehearsalReceipt> => {
		if (terminalFailure !== undefined) throw terminalFailure;
		if (closed) throw new TypeError("v3 room session is closed");
		assertSettlementUnheld();
		const fields = exactRecord(rehearsalInput, ["rehearsalNonce", "targetCreatorInvite"]);
		const nonce = fields?.rehearsalNonce;
		let nonceBacking: unknown;
		let nonceBackingByteLength: unknown;
		let nonceByteLength: unknown;
		let nonceByteOffset: unknown;
		let nonceResizable = false;
		try {
			nonceBacking = Reflect.apply(INTRINSIC_TYPED_ARRAY_BUFFER_GETTER, nonce, []);
			nonceBackingByteLength = Reflect.apply(INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH_GETTER, nonceBacking, []);
			nonceByteLength = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER, nonce, []);
			nonceByteOffset = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_OFFSET_GETTER, nonce, []);
			if (INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER !== undefined) {
				nonceResizable = Reflect.apply(INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER, nonceBacking, []) === true;
			}
		} catch {
			throw new TypeError("v3 room migration rehearsal input is invalid");
		}
		if (
			fields === undefined ||
			INTRINSIC_GET_PROTOTYPE_OF(nonce) !== INTRINSIC_UINT8_ARRAY_PROTOTYPE ||
			!(nonceBacking instanceof INTRINSIC_ARRAY_BUFFER) ||
			INTRINSIC_GET_PROTOTYPE_OF(nonceBacking) !== INTRINSIC_ARRAY_BUFFER_PROTOTYPE ||
			nonceResizable ||
			nonceByteLength !== 32 ||
			nonceByteOffset !== 0 ||
			nonceBackingByteLength !== 32
		) {
			throw new TypeError("v3 room migration rehearsal input is invalid");
		}
		const migration = input.application.migration;
		const canonicalStateBytes = migration?.canonicalStateBytes;
		const prepareMigration = migration?.prepare;
		if (
			migration === undefined ||
			typeof canonicalStateBytes !== "function" ||
			typeof prepareMigration !== "function"
		) {
			throw new TypeError("v3 room migration capability is unavailable");
		}
		const copiedNonce = new INTRINSIC_UINT8_ARRAY(32);
		Reflect.apply(INTRINSIC_UINT8_ARRAY_SET, copiedNonce, [
			new INTRINSIC_UINT8_ARRAY(nonceBacking, nonceByteOffset as number, nonceByteLength as number),
		]);
		const targetObjectId = migrationTargetObjectId(input.objectId, copiedNonce);
		const targetInviteValue = fields.targetCreatorInvite;
		if (
			typeof targetInviteValue !== "string" &&
			(targetInviteValue === null || typeof targetInviteValue !== "object")
		) {
			throw new TypeError("v3 room migration target invite is invalid");
		}
		const targetMaterial = decodeCreatorInvite(boundedMigrationCreatorInvite(targetInviteValue));
		const sourceAuthority = migrationInviteAuthority(material);
		const targetAuthority = migrationInviteAuthority(targetMaterial);
		if (
			sourceAuthority.creatorAuthor !== input.author ||
			sourceAuthority.objectId !== input.objectId ||
			sourceAuthority.signerSetDigest !== roomDescriptor.signerSetDigest ||
			targetAuthority.creatorAuthor !== input.author ||
			targetAuthority.objectId !== targetObjectId ||
			targetAuthority.blueprintDigest !== roomDescriptor.blueprintDigest ||
			targetAuthority.signerSetDigest !== roomDescriptor.signerSetDigest
		) {
			throw new TypeError("v3 room migration target authority is invalid");
		}
		if (migrationBarrier !== undefined) throw new TypeError("v3 room migration rehearsal is already active");
		let releaseMigrationBarrier: (() => void) | undefined;
		let releaseMigrationCompletion: (() => void) | undefined;
		const ownedMigrationBarrier = new Promise<void>((resolve) => {
			releaseMigrationBarrier = resolve;
		});
		const ownedMigrationCompletion = new Promise<void>((resolve) => {
			releaseMigrationCompletion = resolve;
		});
		migrationBarrier = ownedMigrationBarrier;
		migrationCompletionBarrier = ownedMigrationCompletion;
		migrationAcceptingFollowers = true;
		try {
			await rebasePromise;
			await drainPendingIssues();
			if (terminalFailure !== undefined) throw terminalFailure;
			if (closed) throw new TypeError("v3 room session is closed");

			const firstSnapshot = acceptedOperationSnapshot();
			const exactCanonicalSourceRows = acceptedRowsEvidence(firstSnapshot);
			if (firstSnapshot.length > 8192 || exactCanonicalSourceRows.byteLength > 8_388_608) {
				throw new TypeError("v3 room migration source snapshot is unbounded");
			}
			const normalizeProjection = (value: V3RoomMigrationProjection): V3RoomMigrationProjection => {
				const record = exactRecord(value, ["exactCanonicalApplicationStateBytes", "importOperations"]);
				const imports = exactDenseArray(record?.importOperations);
				if (record === undefined || imports === undefined || imports.length > 8192) {
					throw new TypeError("v3 room migration projection is invalid");
				}
				const exactState = normalizeApplicationStateBytes(record.exactCanonicalApplicationStateBytes, "migration");
				let detachedImportBytes = 0;
				const detachedImports = imports.map((operation) => {
					const detached = detachedRoomOperation(operation);
					const encoded = detached === undefined ? undefined : encodeCanonical(detached);
					if (detached === undefined || encoded === undefined || encoded.byteLength > 65_536) {
						throw new TypeError("v3 room migration import is invalid");
					}
					detachedImportBytes += encoded.byteLength;
					if (detachedImportBytes > 4_194_304) {
						throw new TypeError("v3 room migration imports are unbounded");
					}
					return detached;
				});
				if (encodeCanonical(detachedImports).byteLength > 4_194_304) {
					throw new TypeError("v3 room migration imports are unbounded");
				}
				return Object.freeze({
					exactCanonicalApplicationStateBytes: exactState,
					importOperations: Object.freeze(detachedImports),
				});
			};
			// Current rows are not the whole source after a snapshot-backed rollover.
			// Capture through the existing projection owner, and give each preparation
			// its own bytes so application code cannot mutate the comparison evidence.
			const exactSourceState = normalizeApplicationStateBytes(
				Reflect.apply(canonicalStateBytes, migration, [projection]) as Uint8Array,
				"migration"
			);
			const firstProjection = normalizeProjection(
				Reflect.apply(prepareMigration, migration, [
					firstSnapshot,
					new INTRINSIC_UINT8_ARRAY(exactSourceState),
				]) as V3RoomMigrationProjection
			);
			const secondProjection = normalizeProjection(
				Reflect.apply(prepareMigration, migration, [
					acceptedOperationSnapshot(),
					new INTRINSIC_UINT8_ARRAY(exactSourceState),
				]) as V3RoomMigrationProjection
			);
			if (!sameBytes(encodeCanonical(firstProjection), encodeCanonical(secondProjection))) {
				throw new TypeError("v3 room migration projection is unstable");
			}
			const currentSourceState = normalizeApplicationStateBytes(
				Reflect.apply(canonicalStateBytes, migration, [projection]) as Uint8Array,
				"migration"
			);
			if (
				!sameBytes(exactSourceState, currentSourceState) ||
				!sameBytes(exactSourceState, firstProjection.exactCanonicalApplicationStateBytes)
			) {
				throw new TypeError("v3 room migration source state differs");
			}
			releaseMigrationBarrier?.();

			const scratchDigest = digest(
				"ts-drp/v3-room-migration-scratch/v1",
				encodeCanonical({ rehearsalNonce: copiedNonce, sourceObjectId: input.objectId, targetObjectId })
			);
			const scratchDatabaseName = migrationScratchDatabaseName(scratchDigest);
			const targetAccepted: V3RoomAcceptedOperation[] = [];
			let recordVertexDigest: string | undefined;
			const targetRecordAuthority = Object.freeze({
				aclDigest: digest("ts-drp/latched-acl/v3", targetMaterial.exactCanonicalLatchedAclBytes),
				epoch: 0,
				anchorDigest: targetMaterial.pinnedGenesisAnchorDigest,
				blueprintDigest: targetAuthority.blueprintDigest,
				creatorAuthor: targetAuthority.creatorAuthor,
				objectId: targetObjectId,
			});
			const acceptTarget = (vertex: V3RoomAcceptedVertex): void => {
				for (const row of acceptedOperationsForVertex(input.application, vertex, targetRecordAuthority) ?? []) {
					targetAccepted.push(row);
					if (Reflect.get(row.operation, "action") === "migrationRecord") recordVertexDigest = row.vertexDigest;
				}
			};
			const targetInput = Object.freeze({
				...(input.createOperationAdmissionPolicy === undefined
					? {}
					: { createOperationAdmissionPolicy: input.createOperationAdmissionPolicy }),
				storageHost: input.storageHost,
				application: input.application,
				author: input.author,
				creatorInvite: targetMaterial,
				databaseName: scratchDatabaseName,
				initialLogicalTime: 3,
				issuanceDatabaseName: `${scratchDatabaseName}--issuance`,
				objectId: targetObjectId,
				onAcceptedVertex: acceptTarget,
				onProjection: (): void => undefined,
				openTransport: migrationTransport,
				publicKeyBytes: new Uint8Array(input.publicKeyBytes),
				roomHeadAuthority: input.roomHeadAuthority,
				signRegisteredVertexDigest: input.signRegisteredVertexDigest,
			});
			let target: V3RoomSession<Projection> | undefined;
			let reopenedTarget: V3RoomSession<Projection> | undefined;
			try {
				const openedTarget = await createV3RoomSessionOwned(targetInput, false, undefined, true, undefined, localOwner);
				target = openedTarget;
				// A retry resumes only the exact authenticated same-intent prefix, never
				// copying a fixture store or issuing already durable imports again.
				const existingImports = targetAccepted.filter(({ operation }) =>
					input.application.batchableOperationActions.includes(operation.action as string)
				);
				if (
					existingImports.length > firstProjection.importOperations.length ||
					existingImports.some(
						(row, index) =>
							!sameBytes(encodeCanonical(row.operation), encodeCanonical(firstProjection.importOperations[index]))
					)
				)
					throw new TypeError("v3 room migration retained import prefix differs");
				const importPromises = firstProjection.importOperations
					.slice(existingImports.length)
					.map((operation) => openedTarget.issue(operation));
				await Promise.all(importPromises);
				const targetProjection = openedTarget.projection();
				const acceptedImportOperations = targetAccepted
					.filter(({ operation }) => input.application.batchableOperationActions.includes(operation.action as string))
					.map(({ operation }) => operation);
				if (!sameBytes(encodeCanonical(acceptedImportOperations), encodeCanonical(firstProjection.importOperations))) {
					throw new TypeError("v3 room migration target projection differs");
				}
				const exactTargetState = normalizeApplicationStateBytes(
					Reflect.apply(canonicalStateBytes, migration, [targetProjection]) as Uint8Array,
					"migration"
				);
				if (
					migration.inheritAuthenticatedState !== true &&
					!sameBytes(exactTargetState, firstProjection.exactCanonicalApplicationStateBytes)
				) {
					throw new TypeError("v3 room migration target state differs");
				}
				const exactCanonicalImportOperations = encodeCanonical(firstProjection.importOperations);
				const exactCanonicalRecordBytes = encodeCanonical({
					applicationStateDigest: digest(
						"ts-drp/v3-room-migration-state/v1",
						firstProjection.exactCanonicalApplicationStateBytes
					),
					archivePolicy: "retain-source",
					authorityKind: "creator-ed25519-registered-vertex-v1",
					...(migration.inheritAuthenticatedState === true
						? {
								applicationState: decodeCanonical(firstProjection.exactCanonicalApplicationStateBytes),
								targetAclDigest: targetRecordAuthority.aclDigest,
								targetEpoch: 0,
							}
						: { exactCanonicalApplicationStateBytes: firstProjection.exactCanonicalApplicationStateBytes }),
					kind: "ts-drp-v3-room-migration-record",
					rehearsalNonce: copiedNonce,
					sourceAcceptedOperationCount: firstSnapshot.length,
					sourceAcceptedOperationsDigest: digest("ts-drp/v3-room-migration-source/v1", exactCanonicalSourceRows),
					sourceAnchorDigest: successorProjectionAuthority?.anchorDigest ?? roomDescriptor.anchorDigest,
					sourceBlueprintDigest: roomDescriptor.blueprintDigest,
					sourceCreatorAuthor: input.author,
					sourceObjectId: input.objectId,
					targetAnchorDigest: openedTarget.roomId,
					targetBlueprintDigest: targetAuthority.blueprintDigest,
					targetCreatorAuthor: targetAuthority.creatorAuthor,
					targetImportOperationCount: firstProjection.importOperations.length,
					targetImportOperationsDigest: digest("ts-drp/v3-room-migration-import/v1", exactCanonicalImportOperations),
					targetObjectId,
					version: migration.inheritAuthenticatedState === true ? 2 : 1,
				});
				if (exactCanonicalRecordBytes.byteLength > 49_152) {
					throw new TypeError("v3 room migration record is unbounded");
				}
				const record = decodeCanonical(exactCanonicalRecordBytes) as Readonly<Record<string, unknown>>;
				const recordOperation = Object.freeze({ action: "migrationRecord", record });
				if (!validMigrationRecordOperation(recordOperation, input.author, targetRecordAuthority)) {
					throw new TypeError("v3 room migration record is invalid");
				}
				const priorRecords = targetAccepted.filter(({ operation }) => operation.action === "migrationRecord");
				if (
					priorRecords.length > 1 ||
					(priorRecords.length === 1 &&
						!sameBytes(encodeCanonical(priorRecords[0]?.operation), encodeCanonical(recordOperation)))
				)
					throw new TypeError("v3 room migration retained record differs");
				if (priorRecords.length === 0) await openedTarget.issue(recordOperation);
				if (recordVertexDigest === undefined) throw new TypeError("v3 room migration record was not accepted");
				const inheritedTargetState = normalizeApplicationStateBytes(
					Reflect.apply(canonicalStateBytes, migration, [openedTarget.projection()]) as Uint8Array,
					"migration"
				);
				if (!sameBytes(inheritedTargetState, firstProjection.exactCanonicalApplicationStateBytes))
					throw new TypeError("v3 room migration inherited target state differs");
				const completedTargetEvidence = acceptedRowsEvidence(targetAccepted);
				const targetAnchorDigest = openedTarget.roomId;
				migrationAcceptingFollowers = false;
				await waitForMigrationFollowers();
				await openedTarget.close();
				target = undefined;

				const reopenedAccepted: V3RoomAcceptedOperation[] = [];
				const reopened = await createV3RoomSessionOwned(
					Object.freeze({
						...targetInput,
						onAcceptedVertex: (vertex: V3RoomAcceptedVertex): void => {
							for (const row of acceptedOperationsForVertex(input.application, vertex, targetRecordAuthority) ?? []) {
								reopenedAccepted.push(row);
							}
						},
					}),
					false,
					undefined,
					true,
					undefined,
					localOwner
				);
				reopenedTarget = reopened;
				const reopenedProjection = reopened.projection();
				if (!sameBytes(acceptedRowsEvidence(reopenedAccepted), completedTargetEvidence)) {
					throw new TypeError("v3 room migration reopened target differs");
				}
				const exactReopenedState = normalizeApplicationStateBytes(
					Reflect.apply(canonicalStateBytes, migration, [reopenedProjection]) as Uint8Array,
					"migration"
				);
				if (!sameBytes(exactReopenedState, firstProjection.exactCanonicalApplicationStateBytes)) {
					throw new TypeError("v3 room migration reopened state differs");
				}
				const recoveredRecords = reopenedAccepted.filter(
					({ operation }) => Reflect.get(operation, "action") === "migrationRecord"
				);
				const recoveredRecord = recoveredRecords[0];
				if (
					recoveredRecords.length !== 1 ||
					recoveredRecord === undefined ||
					recoveredRecord.vertexDigest !== recordVertexDigest ||
					!sameBytes(encodeCanonical(Reflect.get(recoveredRecord.operation, "record")), exactCanonicalRecordBytes)
				) {
					throw new TypeError("v3 room migration record recovery differs");
				}
				await reopened.close();
				reopenedTarget = undefined;
				return Object.freeze({
					activated: false as const,
					applicationStateDigest: digest(
						"ts-drp/v3-room-migration-state/v1",
						firstProjection.exactCanonicalApplicationStateBytes
					),
					exactCanonicalRecordBytes,
					importedOperationCount: firstProjection.importOperations.length,
					recordDigest: digest("ts-drp/v3-room-migration-record/v1", exactCanonicalRecordBytes),
					recordVertexDigest,
					targetAnchorDigest,
				});
			} catch (error) {
				migrationAcceptingFollowers = false;
				await waitForMigrationFollowers().catch(() => undefined);
				if (reopenedTarget !== undefined) await reopenedTarget.close().catch(() => undefined);
				if (target !== undefined) await target.close().catch(() => undefined);
				throw error;
			}
		} finally {
			migrationAcceptingFollowers = false;
			if (migrationBarrier === ownedMigrationBarrier) migrationBarrier = undefined;
			if (migrationCompletionBarrier === ownedMigrationCompletion) migrationCompletionBarrier = undefined;
			releaseMigrationBarrier?.();
			releaseMigrationCompletion?.();
			await waitForMigrationFollowers().catch(() => undefined);
			if (pendingIssues.length > 0) scheduleDrain();
		}
	};
	const rehearseMigration = async (
		rehearsalInput: V3RoomMigrationRehearsalInput
	): Promise<V3RoomMigrationRehearsalReceipt> => {
		if (input.receiveOnly) throw new TypeError("v3 room is receive-only");
		const capturedInput = snapshotMigrationRehearsalInput(rehearsalInput);
		if (migrationRehearsalReserved) throw new TypeError("v3 room migration rehearsal is already active");
		migrationRehearsalReserved = true;
		const selected = await (async (): Promise<LifetimeDispatchResult<V3RoomMigrationRehearsalReceipt>> => {
			try {
				return await enqueueLifetimeTransition(async () => {
					if (redirectPromise !== undefined) await redirectPromise;
					if (redirectedSession !== undefined) {
						return Object.freeze({
							result: redirectedSession.rehearseMigration(capturedInput),
						});
					}
					return Object.freeze({
						result: await performMigrationRehearsal(capturedInput),
					});
				});
			} finally {
				migrationRehearsalReserved = false;
			}
		})();
		return selected.result;
	};
	const performMigrationActivation = async (
		activationInput: V3RoomMigrationActivationInput
	): Promise<V3RoomMigrationActivationReceipt> => {
		const migrationActivationAuthority = currentMigrationActivationAuthority();
		if (terminalFailure !== undefined) throw terminalFailure;
		if (closed) throw new TypeError("v3 room session is closed");
		assertSettlementUnheld();
		if (migrationActivationAuthority === undefined || input.application.migration === undefined) {
			throw new TypeError("v3 room migration activation is unavailable");
		}
		if (input.author !== migrationActivationAuthority.creatorAuthor) {
			throw new TypeError("v3 room migration activation author is invalid");
		}
		const fields = exactRecord(activationInput, [
			"exactCanonicalRecordBytes",
			"recordVertexDigest",
			"targetCreatorInvite",
		]);
		if (fields === undefined) throw new TypeError("v3 room migration activation input is invalid");
		const suppliedRecordBytes = fields.exactCanonicalRecordBytes;
		let recordBacking: unknown;
		let recordBackingByteLength: unknown;
		let recordByteLength: unknown;
		let recordByteOffset: unknown;
		let recordResizable = false;
		try {
			recordBacking = Reflect.apply(INTRINSIC_TYPED_ARRAY_BUFFER_GETTER, suppliedRecordBytes, []);
			recordBackingByteLength = Reflect.apply(INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH_GETTER, recordBacking, []);
			recordByteLength = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER, suppliedRecordBytes, []);
			recordByteOffset = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_OFFSET_GETTER, suppliedRecordBytes, []);
			if (INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER !== undefined) {
				recordResizable = Reflect.apply(INTRINSIC_ARRAY_BUFFER_RESIZABLE_GETTER, recordBacking, []) === true;
			}
		} catch {
			throw new TypeError("v3 room migration activation input is invalid");
		}
		if (
			INTRINSIC_GET_PROTOTYPE_OF(suppliedRecordBytes) !== INTRINSIC_UINT8_ARRAY_PROTOTYPE ||
			!(recordBacking instanceof INTRINSIC_ARRAY_BUFFER) ||
			INTRINSIC_GET_PROTOTYPE_OF(recordBacking) !== INTRINSIC_ARRAY_BUFFER_PROTOTYPE ||
			recordResizable ||
			typeof recordBackingByteLength !== "number" ||
			typeof recordByteLength !== "number" ||
			typeof recordByteOffset !== "number" ||
			recordByteLength === 0 ||
			recordByteOffset < 0 ||
			recordByteOffset + recordByteLength > recordBackingByteLength
		) {
			throw new TypeError("v3 room migration activation input is invalid");
		}
		if (recordByteLength > 49_152) {
			throw new TypeError("v3 room migration activation record is unbounded");
		}
		const exactCanonicalRecordBytes = new INTRINSIC_UINT8_ARRAY(recordByteLength);
		Reflect.apply(INTRINSIC_UINT8_ARRAY_SET, exactCanonicalRecordBytes, [
			new INTRINSIC_UINT8_ARRAY(recordBacking, recordByteOffset, recordByteLength),
		]);
		let decodedRecord: unknown;
		try {
			decodedRecord = decodeCanonical(exactCanonicalRecordBytes, { maxBytes: 49_152, maxDepth: 16, maxItems: 16_384 });
		} catch {
			throw new TypeError("v3 room migration activation record is invalid");
		}
		const record = migrationRecord(decodedRecord);
		if (record === undefined || !sameBytes(encodeCanonical(record), exactCanonicalRecordBytes)) {
			throw new TypeError("v3 room migration activation record is invalid");
		}
		const recordVertexDigest = fields.recordVertexDigest;
		if (typeof recordVertexDigest !== "string" || !/^[0-9a-f]{64}$/u.test(recordVertexDigest)) {
			throw new TypeError("v3 room migration activation record vertex is invalid");
		}
		const targetInviteValue = fields.targetCreatorInvite;
		if (
			typeof targetInviteValue !== "string" &&
			(targetInviteValue === null || typeof targetInviteValue !== "object")
		) {
			throw new TypeError("v3 room migration activation target invite is invalid");
		}
		const targetCreatorInvite = decodeCreatorInvite(boundedMigrationCreatorInvite(targetInviteValue));
		const targetAuthority = migrationInviteAuthority(targetCreatorInvite);
		const targetRecordAuthority = Object.freeze({
			aclDigest: digest("ts-drp/latched-acl/v3", targetCreatorInvite.exactCanonicalLatchedAclBytes),
			epoch: 0,
			anchorDigest: targetCreatorInvite.pinnedGenesisAnchorDigest,
			blueprintDigest: targetAuthority.blueprintDigest,
			creatorAuthor: targetAuthority.creatorAuthor,
			objectId: targetAuthority.objectId,
		});
		if (
			!validMigrationRecordOperation(
				Object.freeze({ action: "migrationRecord", record }),
				input.author,
				targetRecordAuthority
			) ||
			record.sourceObjectId !== input.objectId ||
			record.sourceAnchorDigest !== migrationActivationAuthority.anchorDigest ||
			record.sourceBlueprintDigest !== migrationActivationAuthority.blueprintDigest ||
			record.sourceCreatorAuthor !== migrationActivationAuthority.creatorAuthor ||
			targetAuthority.signerSetDigest !== migrationActivationAuthority.signerSetDigest
		) {
			throw new TypeError("v3 room migration activation authority is invalid");
		}
		const decision = Object.freeze({
			activationAuthority: "creator-ed25519-registered-vertex-v1",
			applicationStateDigest: record.applicationStateDigest,
			exactCanonicalTargetCreatorInviteBytes: bytes(encodeCreatorInvite(targetCreatorInvite)),
			kind: "ts-drp-v3-room-migration-activation",
			migrationRecordDigest: digest("ts-drp/v3-room-migration-record/v1", exactCanonicalRecordBytes),
			migrationRecordVertexDigest: recordVertexDigest,
			rehearsalNonce: new Uint8Array(record.rehearsalNonce as Uint8Array),
			sourceAcceptedOperationCount: record.sourceAcceptedOperationCount,
			sourceAcceptedOperationsDigest: record.sourceAcceptedOperationsDigest,
			sourceAnchorDigest: record.sourceAnchorDigest,
			sourceBlueprintDigest: record.sourceBlueprintDigest,
			sourceCreatorAuthor: record.sourceCreatorAuthor,
			sourceObjectId: record.sourceObjectId,
			targetAnchorDigest: record.targetAnchorDigest,
			targetBlueprintDigest: record.targetBlueprintDigest,
			targetCreatorAuthor: record.targetCreatorAuthor,
			targetImportOperationCount: record.targetImportOperationCount,
			targetImportOperationsDigest: record.targetImportOperationsDigest,
			targetObjectId: record.targetObjectId,
			version: 1,
		});
		const operation = Object.freeze({ action: "migrationActivation", decision });
		const capturedActivation = migrationActivationOperation(operation, input.author, migrationActivationAuthority);
		if (capturedActivation === undefined) {
			throw new TypeError("v3 room migration activation decision is invalid");
		}
		const targetObjectId = record.targetObjectId as string;
		const rehearsalNonce = record.rehearsalNonce as Uint8Array;
		const scratchDigest = digest(
			"ts-drp/v3-room-migration-scratch/v1",
			encodeCanonical({ rehearsalNonce, sourceObjectId: input.objectId, targetObjectId })
		);
		const scratchDatabaseName = migrationScratchDatabaseName(scratchDigest);
		const verifyRehearsedTarget = async (): Promise<void> => {
			const recoveredRecords: V3RoomAcceptedOperation[] = [];
			const target = await createV3RoomSessionOwned(
				Object.freeze({
					...inputWithoutRebase,
					creatorInvite: targetCreatorInvite,
					databaseName: scratchDatabaseName,
					issuanceDatabaseName: `${scratchDatabaseName}--issuance`,
					objectId: targetObjectId,
					onAcceptedVertex: (vertex: V3RoomAcceptedVertex): void => {
						for (const row of acceptedOperationsForVertex(input.application, vertex, targetRecordAuthority) ?? []) {
							if (Reflect.get(row.operation, "action") === "migrationRecord") recoveredRecords.push(row);
						}
					},
					onMigrationTarget: () => undefined,
					onProjection: (): void => undefined,
				}),
				false,
				undefined,
				true,
				undefined,
				localOwner
			);
			try {
				const recoveredRecord = recoveredRecords[0];
				if (
					recoveredRecords.length !== 1 ||
					recoveredRecord === undefined ||
					recoveredRecord.vertexDigest !== recordVertexDigest ||
					!sameBytes(encodeCanonical(Reflect.get(recoveredRecord.operation, "record")), exactCanonicalRecordBytes)
				) {
					throw new TypeError("v3 room migration activation record differs from rehearsed target");
				}
			} finally {
				await target.close();
			}
		};
		await verifyRehearsedTarget();
		await rebasePromise;
		await drainPendingIssues();
		if (terminalFailure !== undefined) throw terminalFailure;
		if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
		const transition = await activeHandle.beginTerminalTransition();
		if (!transition.ok) throw new TypeError(`v3 room migration activation failed: ${transition.kind}`);
		let exactCurrentState: Uint8Array;
		let currentRows: readonly V3RoomAcceptedOperation[];
		try {
			currentRows = acceptedOperationSnapshot();
			exactCurrentState = normalizeApplicationStateBytes(
				Reflect.apply(input.application.migration.canonicalStateBytes, input.application.migration, [
					projection,
				]) as Uint8Array,
				"migration"
			);
		} catch (error) {
			transition.capability.resume();
			throw error;
		}
		const exactCurrentRows = acceptedRowsEvidence(currentRows);
		const recordedState = migrationRecordStateBytes(record);
		if (
			currentRows.length !== record.sourceAcceptedOperationCount ||
			digest("ts-drp/v3-room-migration-source/v1", exactCurrentRows) !== record.sourceAcceptedOperationsDigest ||
			!sameBytes(exactCurrentState, recordedState) ||
			digest("ts-drp/v3-room-migration-state/v1", exactCurrentState) !== record.applicationStateDigest
		) {
			transition.capability.resume();
			throw new TypeError("v3 room migration source changed after rehearsal");
		}
		const selectedLogicalTime = logicalTime;
		logicalTime += 2;
		let published;
		const targetScope = {
			objectId: targetObjectId,
			pinnedGenesisAnchorDigest: targetCreatorInvite.pinnedGenesisAnchorDigest,
		};
		let targetFloor: Awaited<ReturnType<V3RoomStorageHost["openRoomHead"]>> | undefined;
		let publicationEntered = false;
		try {
			const openedTargetFloor = await input.storageHost.openRoomHead(`${scratchDatabaseName}--room-head`, {
				kind: "create",
			});
			targetFloor = openedTargetFloor;
			// Prepare this exact target before the irreversible source activation.
			// A crash after publication must reopen it, not recreate missing floors.
			const observed = await callRoomHeadAuthority(() => openedTargetFloor.read({ scope: targetScope }), targetScope);
			const targetHead = {
				objectId: targetObjectId,
				currentAnchorDigest: targetCreatorInvite.pinnedGenesisAnchorDigest,
				epoch: 0,
			};
			const preparedFloor = observed ?? (await initializeRoomHeadAuthority(targetFloor, targetScope, targetHead));
			if (preparedFloor.pending !== null || !sameRoomHead(preparedFloor.stable, targetHead))
				return roomHeadFailure("D110C_FLOOR_MISMATCH");
			if (targetFloor.acquireNativeReadReservation === undefined || targetFloor.readRetirementImage === undefined)
				throw new TypeError("migration target floor exclusion is unsupported");
			published = await withV3TerminalMigrationTargetFloor(
				activeHandle,
				targetFloor as V3LocalSettlementFloor,
				targetScope,
				async (borrow) => {
					preparingMigrationTargetFloorScope = targetScope;
					preparingMigrationTargetFloorBorrow = borrow;
					publicationEntered = true;
					return transition.capability.publishTerminal({
						operations: Object.freeze([Object.freeze({ logicalTime: selectedLogicalTime, operation })]),
						signRegisteredVertexDigest: input.signRegisteredVertexDigest,
					});
				}
			);
		} catch (error) {
			if (publicationEntered) terminalFailure = error;
			else transition.capability.resume();
			throw error;
		} finally {
			preparingMigrationTargetFloorScope = undefined;
			preparingMigrationTargetFloorBorrow = undefined;
			await targetFloor?.close();
		}
		if (!published.ok) {
			// The admission callback can record a target hold while publication awaits it.
			const admissionFailure = terminalFailure as unknown;
			if (admissionFailure instanceof TypeError && settlementManualReviewErrors.has(admissionFailure)) {
				throw admissionFailure;
			}
			const failure = new TypeError(
				`v3 room migration activation failed: ${published.kind}`,
				admissionFailure === undefined ? undefined : { cause: admissionFailure }
			);
			if (published.terminalIntent === "absent") {
				transition.capability.resume();
			} else {
				terminalFailure = failure;
			}
			throw failure;
		}
		await publishAccepted();
		await ensureRedirect(authenticatedMigrationActivation(capturedActivation, published.digest));
		return Object.freeze({
			activated: true as const,
			activationDecisionDigest: capturedActivation.decisionDigest,
			activationVertexDigest: published.digest,
			targetAnchorDigest: targetCreatorInvite.pinnedGenesisAnchorDigest,
		});
	};
	const activateMigration = async (
		activationInput: V3RoomMigrationActivationInput
	): Promise<V3RoomMigrationActivationReceipt> => {
		if (input.receiveOnly) throw new TypeError("v3 room is receive-only");
		const capturedInput = snapshotMigrationActivationInput(activationInput);
		const selected = await enqueueLifetimeTransition(async () => {
			if (redirectPromise !== undefined) await redirectPromise;
			if (redirectedSession !== undefined) {
				return Object.freeze({
					result: redirectedSession.activateMigration(capturedInput),
				});
			}
			return Object.freeze({
				result: await performMigrationActivation(capturedInput),
			});
		});
		return selected.result;
	};
	if (redirectSource !== undefined) {
		try {
			await waitForRetainedBootstrap();
			await rebasePromise;
			if (terminalFailure !== undefined) throw terminalFailure;
			// Exact creator authorization may legitimately arrive after activation.
			// Expose installed custody so close/reopen can join and resume its
			// reversible protected plan; all public effects still check the hold.
			if (!settlementAuthorizationHeld || settlementHeld) assertSettlementUnheld();
		} catch (error) {
			await shutdown().catch(() => undefined);
			throw error;
		}
	}
	const assertSessionOpen = (): void => {
		localOwner?.assertCurrent();
		if (closed) {
			// Automatic terminal cleanup must not erase the original failed close
			// binding. An explicit caller close still has ordinary closed precedence.
			if (
				sessionCloseTask === undefined &&
				creatorCloseRebindFailure !== undefined &&
				terminalFailure === creatorCloseRebindFailure
			)
				throw creatorCloseRebindFailure;
			throw new TypeError("v3 room session is closed");
		}
	};
	const performCreatorSuccessorAdoption = async (
		received?: Awaited<ReturnType<typeof receiveCreatorSuccessorAdoption>>
	): Promise<void> => {
		if (terminalFailure !== undefined) throw terminalFailure;
		await refreshRoomHeadState();
		if (received === undefined && creatorCloseHandle === undefined)
			throw new TypeError("creator close authority is unavailable");
		if (activeHandle === undefined || transport === undefined) {
			throw new TypeError("v3 room live plane is unavailable");
		}
		if (openedRoomHeadState !== undefined) {
			const current = activeHandle.currentEphemeralAuthority();
			if (
				openedRoomHeadState.pending !== null ||
				(current !== undefined &&
					!sameRoomHead(openedRoomHeadState.stable, {
						currentAnchorDigest: current.anchorDigest,
						epoch: current.epoch,
						objectId: current.objectId,
					}))
			) {
				await recoverSettlementOwner();
				return;
			}
		}
		const closeStatus = creatorCloseHandle?.status();
		if (received === undefined && successorProjectionAuthority !== null && closeStatus?.lifecycle === "active") {
			const current = activeHandle.currentEphemeralAuthority();
			const stable = openedRoomHeadState?.stable;
			if (
				current !== undefined &&
				stable !== undefined &&
				current.aclDigest === successorProjectionAuthority.aclDigest &&
				current.anchorDigest === successorProjectionAuthority.anchorDigest &&
				current.epoch === successorProjectionAuthority.epoch &&
				current.objectId === successorProjectionAuthority.objectId &&
				stable.currentAnchorDigest === successorProjectionAuthority.anchorDigest &&
				stable.epoch === successorProjectionAuthority.epoch &&
				stable.objectId === successorProjectionAuthority.objectId
			) {
				return;
			}
			throw new TypeError("D110C_B_ACTIVATION_STALLED");
		}
		if (received === undefined && closeStatus?.lifecycle !== "successor-pending-adoption") {
			throw new TypeError("D110C_B_ACTIVATION_STALLED");
		}
		const predecessorClose = creatorCloseHandle;
		const adoptionOwner = received?.handle ?? predecessorClose;
		const verified =
			received?.verified ??
			(await verifyCreatorSuccessorAdoption({
				catalog: input.application.catalog,
				handle: adoptionOwner,
			}));
		if (!verified.ok) throw new TypeError(`v3 room successor verification failed: ${verified.kind}`);
		if (roomHeadAuthority === undefined || openedRoomHeadState === undefined) {
			return roomHeadFailure("D110C_FLOOR_MIGRATION_REQUIRED");
		}
		assertSessionOpen();
		const staged = await stageCreatorSuccessorAdoption({
			handle: adoptionOwner,
			intent: verified.intent,
		});
		if (!staged.ok)
			throw new TypeError(`v3 room successor stage failed: ${String(staged.kind)}`, {
				cause: staged.cause === undefined ? staged : staged.cause,
			});
		const nextRoomHead = expectedRoomHeadFromDescriptor(staged.descriptor as Readonly<Record<string, unknown>>);
		const pendingRoomHead = await beginRoomHeadAdvance(
			roomHeadAuthority,
			roomHeadScope,
			openedRoomHeadState.stable,
			nextRoomHead
		);
		openedRoomHeadState = pendingRoomHead;
		assertSessionOpen();
		const published = await publishStagedCreatorSuccessorAdoption({
			capability: staged.capability,
			handle: adoptionOwner,
		});
		if (!published.ok) throw new TypeError(`v3 room successor publication failed: ${String(published.kind)}`);
		openedRoomHeadState = await commitRoomHeadAdvance(roomHeadAuthority, roomHeadScope, pendingRoomHead);
		if (openedRoomHeadState.pending !== null || !sameRoomHead(openedRoomHeadState.stable, nextRoomHead)) {
			return roomHeadFailure("D110C_FLOOR_MISMATCH");
		}
		assertSessionOpen();
		startupReplay = [];
		const activated = await activateCreatorSuccessorAdoption({
			createOperationAdmissionPolicy: successorAdmissionFactory,
			...(classifyTerminalVertex === undefined ? {} : { classifyTerminalVertex }),
			capability: published.capability,
			expectedRoomHead: openedRoomHeadState.stable,
			handle: adoptionOwner,
			messageQueueManager,
			networkNode: transport.networkNode,
			onAdmittedVertex: admittedSink as unknown as V3AdmittedVertexSink,
		});
		if (activated.ok !== true) {
			startupReplay = undefined;
			const failure = new TypeError(
				`D110C_B_ACTIVATION_STALLED: ${activated.kind}: ${activated.detail}${
					activated.cause instanceof Error ? `: ${activated.cause.message}` : ""
				}`,
				{
					cause: activated.cause === undefined ? activated : activated.cause,
				}
			);
			terminalFailure = failure;
			creatorCloseHandle = undefined;
			creatorCloseUnavailableContinuity = "stalled";
			const stale = activeHandle;
			activeHandle = undefined;
			return throwAfterJoinedCleanup(failure, [
				async (): Promise<void> => {
					await predecessorClose?.stop();
				},
				(): void | Promise<void> => stale.deactivate(),
			]);
		}
		const replacement = activated.handle as RoomPlaneHandle;
		let replacementOwned = true;
		const releaseReplacement = async (): Promise<void> => {
			if (!replacementOwned) return;
			await Promise.resolve(replacement.deactivate());
			replacementOwned = false;
		};
		const throwAfterReplacementCleanup = async (primary: unknown): Promise<never> => {
			startupReplay = undefined;
			return throwAfterJoinedCleanup(primary, [
				releaseReplacement,
				async (): Promise<void> => {
					await predecessorClose?.stop();
				},
			]);
		};
		if (closed) {
			return throwAfterReplacementCleanup(new TypeError("v3 room session is closed"));
		}
		let authority: V3RoomSuccessorAuthority;
		try {
			authority = successorAuthority(activated.trust, replacement);
		} catch (error) {
			return throwAfterReplacementCleanup(error);
		}
		const predecessor = activeHandle;
		try {
			await Promise.resolve(predecessor.deactivate());
		} catch (error) {
			return throwAfterReplacementCleanup(error);
		}
		if (closed) {
			activeHandle = undefined;
			return throwAfterReplacementCleanup(new TypeError("v3 room session is closed"));
		}
		const failCloseRebind = async (): Promise<never> => {
			startupReplay = undefined;
			activeHandle = replacement;
			replacementOwned = false;
			successorProjectionAuthority = authority;
			creatorCloseHandle = undefined;
			creatorCloseUnavailableContinuity = "stalled";
			creatorCloseRebindFailure = new TypeError("D110C_B_CLOSE_REBIND_FAILED");
			terminalFailure = creatorCloseRebindFailure;
			return throwAfterJoinedCleanup(terminalFailure, [
				async (): Promise<void> => {
					await predecessorClose?.stop();
				},
			]);
		};
		if (input.creatorFinalitySigner !== undefined && bindCurrentCreatorClose === undefined) return failCloseRebind();
		const rebound = await bindCurrentCreatorClose?.(replacement);
		if (closed) {
			activeHandle = undefined;
			return throwAfterJoinedCleanup(new TypeError("v3 room session is closed"), [
				releaseReplacement,
				async (): Promise<void> => {
					await predecessorClose?.stop();
				},
				...(rebound?.ok ? [(): Promise<void> => rebound.handle.stop()] : []),
			]);
		}
		if (rebound !== undefined && !rebound.ok) return failCloseRebind();
		activeHandle = replacement;
		replacementOwned = false;
		successorProjectionAuthority = authority;
		creatorCloseHandle = rebound?.ok ? rebound.handle : undefined;
		creatorCloseUnavailableContinuity = "continuous";
		try {
			installSuccessorProjectionBase(replacement, authority);
			await commitSuccessorProjection();
			if (!input.receiveOnly && settlementProfile === "v1") {
				await publishAccepted();
				await drainRebaseOutbox();
			}
			await prepareCurrentCreatorOrdinaryReadiness();
		} catch (error) {
			startupReplay = undefined;
			terminalFailure = error;
			return throwAfterJoinedCleanup(error, [
				shutdown,
				async (): Promise<void> => {
					await predecessorClose?.stop();
				},
			]);
		}
		await predecessorClose?.stop();
	};
	const adoptCreatorSuccessor = (): Promise<void> => {
		if (creatorSuccessorAdoptionTask !== undefined) return creatorSuccessorAdoptionTask;
		const attempt = enqueueLifetimeTransition(async () => {
			if (redirectPromise !== undefined) await redirectPromise;
			assertSessionOpen();
			if (redirectedSession !== undefined) {
				return redirectedSession.adoptCreatorSuccessor();
			}
			await performCreatorSuccessorAdoption();
			scheduledLulls?.schedule();
		});
		const shared = attempt.finally(() => {
			if (creatorSuccessorAdoptionTask === shared) creatorSuccessorAdoptionTask = undefined;
		});
		creatorSuccessorAdoptionTask = shared;
		return shared;
	};
	// Genuine room-native turnover ports for this recipient; no finality signer.
	const recipientRecoveryContext = async (): Promise<CreatorRecipientRecoveryContext> => {
		const nativeSigning = await ownCreatorSigningStores();
		return {
			roomHeadAuthority: input.roomHeadAuthority,
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
			exactCanonicalPinnedGenesisTrustStateRecordBytes: encodeCanonical({
				kind: "drp-anchor-trust-state",
				version: 1,
				objectId: input.objectId,
				genesisAnchorDigest: material.pinnedGenesisAnchorDigest,
				currentAnchorDigest: material.pinnedGenesisAnchorDigest,
				currentEpoch: 0,
				profileId: Reflect.get(decodeCanonical(material.exactCanonicalProfileBytes) as object, "profileId"),
				quorum: 1,
				exactCanonicalCurrentAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
				detachedCurrentAnchorSignature: material.detachedGenesisSignature,
				exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
				exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
			}),
			voteStore: nativeSigning.vote.store,
			evidenceStore: nativeSigning.evidence.store,
			storageIncarnation: nativeSigning.vote.observation.incarnation,
		};
	};
	// Recipient half of the opt-in pool boundary; runs in the lifecycle FIFO.
	// The next install's turnover predicate is state-based, so early turnover
	// needs no resume token: once retired, the install finds nothing due.
	const maintainRecipientRecoveryPool = async (): Promise<CreatorRecoveryPoolResult> => {
		if (terminalFailure !== undefined || creatorRecipientRecoveryRequired)
			return Object.freeze({ kind: "deferred", reason: "busy" });
		await rebasePromise;
		await migrationCompletionBarrier;
		await refreshRoomHeadState();
		if (
			activeHandle === undefined ||
			transport === undefined ||
			openedRoomHeadState === undefined ||
			openedRoomHeadState.pending !== null
		)
			return Object.freeze({ kind: "deferred", reason: "busy" });
		if (openedRoomHeadState.stable.epoch < 2) return Object.freeze({ kind: "not-needed" });
		let open!: () => void;
		const barrier = new Promise<void>((resolve) => { open = resolve; });
		poolMaintenanceBarrier = barrier;
		try {
			await drainPendingIssues();
			assertSessionOpen();
			const plane = activeHandle,
				roomTransport = transport,
				roomHead = openedRoomHeadState?.stable;
			if (plane === undefined || roomTransport === undefined || roomHead === undefined)
				return Object.freeze({ kind: "deferred", reason: "busy" });
			let result: CreatorRecoveryPoolResult;
			try {
				result = await maintainCreatorRecipientRecoveryPool({
					plane,
					catalog: input.application.catalog,
					expectedRoomHead: roomHead,
					snapshotStore: await ownRecipientSnapshots(),
					recoveryContext: await recipientRecoveryContext(),
				});
			} catch (error) {
				// Same rule as a failed install: native custody may be uncertain, so the
				// next install reacquires it through authenticated recovery first.
				creatorRecipientRecoveryRequired = true;
				throw error;
			}
			// Arrivals queued behind the boundary; any refused at the bounded input
			// pool are repaired through the same authenticated retained path a reconnect uses.
			// Not after close: close revoked the transport and the next open asks again.
			if (result.kind === "maintained" && !closed && activeHandle === plane && transport === roomTransport)
				roomTransport.requestRetainedHistory();
			return result;
		} finally {
			if (poolMaintenanceBarrier === barrier) poolMaintenanceBarrier = undefined;
			open();
		}
	};
	// A durable reopen right after this recipient completed a retirement at its
	// current epoch (a lull's early turnover) halts its admission until the ORIGINAL
	// received reconciliation runs again, as a creator's readiness boundary does for
	// a creator. Discharge it once, in the lifecycle FIFO before startup reports
	// ready, holding local issues meanwhile. A failure after entry is terminal; a
	// plane without that request is left exactly as it was.
	let recipientRetirementResume: Promise<void> = Promise.resolve();
	if (
		input.creatorFinalitySigner === undefined &&
		activeHandle !== undefined &&
		creatorRecipientRetirementResumeRequested(activeHandle)
	) {
		let open!: () => void;
		const barrier = new Promise<void>((resolve) => { open = resolve; });
		poolMaintenanceBarrier = barrier;
		const release = (): void => {
			if (poolMaintenanceBarrier === barrier) poolMaintenanceBarrier = undefined;
			open();
		};
		try {
			recipientRetirementResume = enqueueLifetimeTransition(async () => {
				try {
					await rebasePromise;
					await migrationCompletionBarrier;
					await refreshRoomHeadState();
					await drainPendingIssues();
					assertSessionOpen();
					const plane = activeHandle,
						roomTransport = transport,
						roomHead = openedRoomHeadState?.stable;
					if (plane === undefined || roomTransport === undefined || roomHead === undefined || openedRoomHeadState?.pending !== null)
						throw new TypeError("v3 room recipient retirement resume owner is unavailable");
					const result = await maintainCreatorRecipientRecoveryPool({
						plane,
						catalog: input.application.catalog,
						expectedRoomHead: roomHead,
						snapshotStore: await ownRecipientSnapshots(),
						recoveryContext: await recipientRecoveryContext(),
						resume: true,
					});
					// Ingress refused while admission was halted is repaired through the
					// same authenticated retained path a reconnect uses.
					if (result.kind === "maintained" && !closed && activeHandle === plane && transport === roomTransport)
						roomTransport.requestRetainedHistory();
				} catch (error) {
					terminalFailure = error;
					try {
						await shutdown();
					} catch (cleanup) {
						throw combineFailures(error, cleanup);
					}
					throw error;
				} finally {
					release();
				}
			});
		} catch (error) {
			recipientRetirementResume = Promise.reject(error);
		}
		void recipientRetirementResume.then(release, (error: unknown) => {
			release();
			terminalFailure = error;
		});
	}
	const installCreatorSuccessor = (
		request: Readonly<{ offer: CreatorSuccessorOffer; peers: readonly string[] }>
	): Promise<void> => {
		let offer: CreatorSuccessorOffer;
		let peers: readonly string[];
		try {
			const fields = exactRecord(request, ["offer", "peers"]);
			if (fields === undefined) throw new TypeError("creator recipient request is invalid");
			offer = captureCreatorSuccessorOffer(fields.offer);
			peers = captureCreatorSuccessorPeers(fields.peers);
		} catch (error) {
			return Promise.reject(error);
		}
		if (creatorSuccessorAdoptionTask !== undefined)
			return Promise.reject(new TypeError("creator recipient installation is already owned"));
		const attempt = enqueueLifetimeTransition(async () => {
			assertSessionOpen();
			await rebasePromise;
			await migrationCompletionBarrier;
			await refreshRoomHeadState();
			// Exact repeated installation is acknowledged only by the fully verified
			// native successor export. Epoch/anchor equality alone is never sufficient.
			const matchesInstalledOffer = async (): Promise<boolean> => {
				if (
					openedRoomHeadState === undefined ||
					openedRoomHeadState.pending !== null ||
					openedRoomHeadState.stable.epoch === 0
				)
					return false;
				// A repeat carries the installed current trust record, so an offer naming
				// another epoch/anchor cannot match; skip the whole-export authentication.
				let offeredTrust: unknown;
				try {
					offeredTrust = decodeCanonical(offer.exactCanonicalTrustStateRecordBytes);
				} catch {
					offeredTrust = undefined;
				}
				if (
					typeof offeredTrust === "object" &&
					offeredTrust !== null &&
					(Reflect.get(offeredTrust, "currentEpoch") !== openedRoomHeadState.stable.epoch ||
						Reflect.get(offeredTrust, "currentAnchorDigest") !== openedRoomHeadState.stable.currentAnchorDigest)
				)
					return false;
				let exported: Awaited<ReturnType<typeof readSuccessorExport>>;
				try {
					exported = await readSuccessorExport();
				} catch (error) {
					if (error instanceof CreatorSuccessorExportUnavailable) return false;
					throw error;
				}
				return (Object.keys(offer) as (keyof CreatorSuccessorOffer)[]).every((key) =>
					sameBytes(offer[key], exported.offer[key])
				);
			};
			if (creatorRecipientRecoveryRequired) {
				const previous = openedRoomHeadState?.stable;
				await recoverSettlementOwner(true);
				await refreshRoomHeadState();
				if (await matchesInstalledOffer()) {
					creatorRecipientRecoveryRequired = false;
					return;
				}
				if (
					previous !== undefined &&
					openedRoomHeadState !== undefined &&
					!sameRoomHead(previous, openedRoomHeadState.stable)
				) {
					throw new TypeError("creator recipient retry conflicts with retained successor");
				}
				creatorRecipientRecoveryRequired = false;
			}
			if (await matchesInstalledOffer()) return;
			if (
				activeHandle === undefined ||
				transport === undefined ||
				openedRoomHeadState === undefined ||
				openedRoomHeadState.pending !== null
			)
				throw new TypeError("creator recipient current floor is unavailable");
			let received: Awaited<ReturnType<typeof receiveCreatorSuccessorAdoption>>;
			try {
				const recoveryContext = openedRoomHeadState.stable.epoch >= 2 ? await recipientRecoveryContext() : undefined;
				received = await receiveCreatorSuccessorAdoption({
					plane: activeHandle,
					catalog: input.application.catalog,
					offer,
					expectedRoomHead: openedRoomHeadState.stable,
					snapshotStore: await ownRecipientSnapshots(),
					transport: createSnapshotChunkProtocolPort(transport.networkNode, CREATOR_SUCCESSOR_PROTOCOL),
					peers,
					author: input.author,
					signRegisteredVertexDigest: input.signRegisteredVertexDigest,
					exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
					detachedGenesisSignature: material.detachedGenesisSignature,
					...(recoveryContext === undefined ? {} : { recoveryContext }),
				});
			} catch (error) {
				// A failed receive may own native retention despite a lost acknowledgement.
				// Retry must reacquire native custody before preparing any old/new writer.
				creatorRecipientRecoveryRequired = true;
				throw error;
			}
			try {
				await withCreatorReceivedPromotionDependencies(received, async () => {
					assertSessionOpen();
					await performCreatorSuccessorAdoption(received);
				});
			} catch (error) {
				// Received native dependency already exists: never resume the old writer on ambiguous publication.
				terminalFailure = error;
				creatorRecipientRecoveryRequired = true;
				const stale = activeHandle;
				activeHandle = undefined;
				const cleanup = await Promise.allSettled([
					Promise.resolve().then(() => creatorCloseHandle?.stop()),
					Promise.resolve().then(() => stale?.deactivate()),
				]);
				const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
				if (cleanupErrors.length > 0) {
					const failure = new AggregateError([error, ...cleanupErrors], "creator recipient adoption cleanup failed", {
						cause: error,
					});
					terminalFailure = failure;
					throw failure;
				}
				throw error;
			}
			// The creator published its settlement fence at adoption, before this install, and
			// this peer could not authenticate it then; live copies that arrived during the
			// install met the closing plane. Ask the creator for the successor's retained
			// history once, now that the successor plane admits it.
			requestMissingRetainedHistory();
			scheduledLulls?.schedule();
		});
		const shared = attempt.finally(() => {
			if (creatorSuccessorAdoptionTask === shared) creatorSuccessorAdoptionTask = undefined;
		});
		creatorSuccessorAdoptionTask = shared;
		return shared;
	};
	const promoteCreatorCheckpoint = (request: Readonly<{ closedEpoch: number }>): Promise<void> => {
		if (input.receiveOnly) return Promise.reject(new TypeError("v3 room is receive-only"));
		let closedEpoch: number;
		try {
			const descriptor = Object.getOwnPropertyDescriptor(request, "closedEpoch");
			if (
				request === null ||
				![Object.prototype, null].includes(Object.getPrototypeOf(request)) ||
				Reflect.ownKeys(request).length !== 1 ||
				descriptor?.enumerable !== true ||
				!("value" in descriptor) ||
				!Number.isSafeInteger(descriptor.value) ||
				descriptor.value < 0
			)
				throw new TypeError("creator promotion target is invalid");
			closedEpoch = descriptor.value as number;
		} catch {
			return Promise.reject(new TypeError("creator promotion target is invalid"));
		}
		return enqueueLifetimeTransition(async () => {
			if (redirectPromise !== undefined) await redirectPromise;
			assertSessionOpen();
			if (redirectedSession !== undefined) return redirectedSession.promoteCreatorCheckpoint({ closedEpoch });
			if (terminalFailure !== undefined) throw terminalFailure;
			await rebasePromise;
			await migrationCompletionBarrier;
			await drainPendingIssues();
			assertSessionOpen();
			const owner = creatorCloseHandle;
			if (owner === undefined) throw new TypeError("creator promotion authority is unavailable");
			let primary: unknown;
			try {
				await owner.acquirePromotionCheckpoint({ closedEpoch });
				assertSessionOpen();
				await owner.close();
				assertSessionOpen();
				await performCreatorSuccessorAdoption();
			} catch (error) {
				primary = error;
			}
			if (primary !== undefined)
				throw primary instanceof TypeError ? primary : new TypeError("creator promotion failed", { cause: primary });
			scheduledLulls?.schedule();
		});
	};
	const closeSession = (): Promise<void> => {
		if (sessionCloseTask !== undefined) return sessionCloseTask;
		closed = true;
		autoPoolMaintenance?.stop();
		closePresentation();
		revokeTransport();
		cancelRedirectCreation();
		const task = (async (): Promise<void> => {
			let primaryFailure: unknown;
			let primaryFailed = false;
			try {
				await creatorSuccessorAdoptionTask?.catch(() => undefined);
				await rebasePromise.catch(() => undefined);
				await lifetimeTransitionTail;
				await migrationCompletionBarrier;
				await drainPendingIssues();
			} catch (error) {
				primaryFailed = true;
				primaryFailure = error;
			}
			const redirect = redirectPromise === undefined ? redirectedSession : await redirectPromise.catch(() => undefined);
			await redirect?.close().catch(() => undefined);
			try {
				await shutdown();
			} catch (cleanupFailure) {
				if (primaryFailed) throw combineFailures(primaryFailure, cleanupFailure);
				throw cleanupFailure;
			}
			if (primaryFailed) throw primaryFailure;
		})();
		sessionCloseTask = task;
		return task;
	};
	const closeAcquiredSession = (): Promise<void> => {
		if (!ownsLocalSession || localOwner === undefined) return closeSession();
		localOwner.closed = true; // Reject callbacks/sign requests before any Promise join.
		if (localOwner.closeTask !== undefined) return localOwner.closeTask;
		const joined = closeSession(); // Original owner synchronously revokes transport.
		return localOwner.closeTask = (async (): Promise<void> => {
			let failed = false, primary: unknown;
			try { await joined; } catch (cause) { failed = true; primary = cause; }
			try { await localOwner.lease.close(); }
			catch (cleanup) {
				if (failed) throw new AggregateError([primary, cleanup], "v3 room join and native session close failed", { cause: primary });
				throw cleanup;
			}
			if (failed) throw primary;
		})();
	};
	if (ownsLocalSession && localOwner !== undefined) {
		localOwner.closeRoot = closeAcquiredSession;
		localOwner.prepareTerminal = async (): Promise<CreatorLocalSessionWithdrawal> => {
			localOwner.assertCurrent(); assertSessionOpen();
			await lifetimeTransitionTail;
			await creatorSuccessorAdoptionTask;
			await rebasePromise;
			localOwner.assertCurrent(); assertSessionOpen();
			const plane = activeHandle, close = creatorCloseHandle;
			if (plane === undefined || close === undefined || redirectedSession !== undefined || redirectPromise !== undefined)
				throw new TypeError("LOCAL_SESSION_DISPOSITION_SOURCE_UNAVAILABLE");
			const proof = await close.acquireLocalSessionWithdrawal(localOwner.lease.signing.author);
			try {
				localOwner.assertCurrent(); assertSessionOpen();
				if (activeHandle !== plane || creatorCloseHandle !== close) throw new TypeError("LOCAL_SESSION_DISPOSITION_SOURCE_CHANGED");
				await proof.check(); return proof;
			} catch (primary) {
				try { await proof.release(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "terminal room source and joined release failed", { cause: primary }); }
				throw primary;
			}
		};
	}
	const session: V3RoomSession<Projection> = Object.freeze({
		...(localOwner === undefined ? {} : { localSession: localOwner.control }),
		activateMigration,
		authorizeSettlementSourceSelection(request: V3SettlementSourceSelectionRequest): Promise<Uint8Array> {
			assertSessionOpen();
			if (redirectedSession !== undefined) return redirectedSession.authorizeSettlementSourceSelection(request);
			const owner = activeHandle,
				approve = input.approveSettlementSourceSelection;
			if (
				input.author !== roomCreatorAuthor ||
				owner?.authorizeSettlementSourceSelection === undefined ||
				approve === undefined
			)
				return Promise.reject(new TypeError("v3 room explicit creator approval is unavailable"));
			return owner.authorizeSettlementSourceSelection({
				...request,
				signRegisteredVertexDigest: input.signRegisteredVertexDigest,
				approve: async (captured) => {
					// Created only after the live owner admits and authenticates this proposal.
					const controller = new AbortController(),
						cancel = (): void => controller.abort();
					selectionApprovalControllers.add(controller);
					captured.cancellationSignal.addEventListener("abort", cancel, { once: true });
					if (closed || captured.cancellationSignal.aborted) cancel();
					try {
						const allowed = await approve({ ...captured, cancellationSignal: controller.signal });
						return !closed && !controller.signal.aborted && allowed === true;
					} finally {
						captured.cancellationSignal.removeEventListener("abort", cancel);
						selectionApprovalControllers.delete(controller);
					}
				},
			});
		},
		adoptCreatorSuccessor(): Promise<void> {
			return adoptCreatorSuccessor();
		},
		installCreatorSuccessor,
		exportCreatorSuccessor: () =>
			enqueueLifetimeTransition(async () => {
				assertSessionOpen();
				return serveSuccessor();
			}),
		authority(): V3RoomSuccessorAuthority | null {
			return redirectedSession?.authority() ?? successorProjectionAuthority;
		},
		get invite(): string {
			return redirectedSession?.invite ?? invite;
		},
		get objectId(): string {
			return redirectedSession?.objectId ?? input.objectId;
		},
		get roomId(): string {
			return redirectedSession?.roomId ?? successorProjectionAuthority?.anchorDigest ?? roomDescriptor.anchorDigest;
		},
		trustStatus: "Creator-trusted; not Byzantine-fault-tolerant." as const,
		close(): Promise<void> {
			return closeAcquiredSession();
		},
		connectedPeers(): readonly string[] {
			if (closed || terminalFailure !== undefined) return Object.freeze([]);
			if (redirectedSession !== undefined) return redirectedSession.connectedPeers();
			return Object.freeze(
				activeHandle === undefined || transport === undefined
					? []
					: [...transport.networkNode.getGroupPeers(activeHandle.topic)]
			);
		},
		queryRetainedHashes(query: V3RetainedHashQuery): Promise<V3RetainedHashPage> {
			assertSessionOpen();
			if (terminalFailure !== undefined) return Promise.reject(terminalFailure);
			if (redirectedSession !== undefined) return redirectedSession.queryRetainedHashes(query);
			if (redirectPromise !== undefined || activeHandle === undefined)
				return Promise.reject(new TypeError("v3 room retained query is transitioning; retry after adoption"));
			const plane = activeHandle;
			return queryV3RetainedHashes(plane, query).then((page) => {
				assertSessionOpen();
				if (activeHandle !== plane) throw new TypeError("v3 room retained query is stale");
				return page;
			});
		},
		requestRetainedRepair(repair: Readonly<{ targetPeerId?: string }> = {}): Promise<Readonly<{ kind: "scheduled" }>> {
			assertSessionOpen();
			if (terminalFailure !== undefined) return Promise.reject(terminalFailure);
			if (redirectedSession !== undefined) return redirectedSession.requestRetainedRepair(repair);
			if (redirectPromise !== undefined || activeHandle === undefined || transport === undefined)
				return Promise.reject(new TypeError("v3 room retained repair is transitioning; retry after adoption"));
			const selected = exactRecord(repair, Reflect.ownKeys(repair).length === 0 ? [] : ["targetPeerId"]);
			if (selected === undefined || (selected.targetPeerId !== undefined && typeof selected.targetPeerId !== "string"))
				return Promise.reject(new TypeError("v3 room retained repair input is invalid"));
			const plane = activeHandle,
				roomTransport = transport;
			return requestV3RetainedRepair(
				plane,
				() => {
					assertSessionOpen();
					if (activeHandle !== plane || transport !== roomTransport)
						throw new TypeError("v3 room retained repair is stale");
					roomTransport.requestRetainedHistory();
				},
				selected.targetPeerId as string | undefined
			);
		},
		async inspectDurableHead(): ReturnType<CreatorLiveCloseHandle["inspectDurableHead"]> {
			if (redirectPromise !== undefined) await redirectPromise;
			if (redirectedSession !== undefined) return redirectedSession.inspectDurableHead();
			if (creatorCloseHandle === undefined) throw new TypeError("creator close authority is unavailable");
			return creatorCloseHandle.inspectDurableHead();
		},
		async issue(operation: Readonly<Record<string, unknown>>): Promise<void> {
			// Captured synchronously: only issueWithReceipt sets it, immediately around this call.
			const receiptHooks = nextIssueReceiptHooks;
			nextIssueReceiptHooks = undefined;
			localOwner?.assertCurrent();
			if (input.receiveOnly) throw new TypeError("v3 room is receive-only");
			if (redirectPromise === undefined && redirectedSession === undefined) {
				if (terminalFailure !== undefined) throw terminalFailure;
				if (closed) throw new TypeError("v3 room session is closed");
			}
			if (pendingInputEntries >= pendingInputEntryLimit)
				throw new TypeError("v3 room pending input entry capacity exhausted; retry after admitted work joins");
			// Reserve cardinality before caller-controlled canonical inspection,
			// which can reenter issue. Recheck bytes after that inspection as well.
			pendingInputEntries += 1;
			let byteCharge = 0;
			let transferred = false;
			let released = false;
			const releasePublicInput = (): void => {
				if (released) return;
				released = true;
				pendingInputEntries -= 1;
				pendingInputBytes -= byteCharge;
			};
			try {
				let capture: ReturnType<typeof captureRoomOperation>;
				try {
					capture = captureRoomOperation(operation, pendingInputByteLimit - pendingInputBytes);
				} catch (error) {
					if (
						error instanceof CanonicalEncodingError &&
						(error.message === "string exceeds byte limit" || error.message === "canonical value exceeds byte limit")
					)
						throw new TypeError("v3 room pending input byte capacity exhausted; retry after admitted work joins");
					throw new TypeError("v3 room operation is invalid", { cause: error });
				}
				if (capture === undefined) throw new TypeError("v3 room operation is invalid");
				if (capture.byteCharge > pendingInputByteLimit - pendingInputBytes)
					throw new TypeError("v3 room pending input byte capacity exhausted; retry after admitted work joins");
				byteCharge = capture.byteCharge;
				pendingInputBytes += byteCharge;
				const captured = capture.operation;
				if (redirectPromise !== undefined) await redirectPromise;
				if (redirectedSession !== undefined) {
					if (recoveredActivation !== undefined) return await redirectedSession.issue(captured);
					throw new TypeError("v3 room terminal source cannot issue operations");
				}
				if (terminalFailure !== undefined) throw terminalFailure;
				if (closed) throw new TypeError("v3 room session is closed");
				if (Reflect.get(captured, "action") === "migrationActivation") {
					throw new TypeError("v3 room migration activation requires its receiver-bound capability");
				}
				const migrationRecordAuthority = currentMigrationRecordAuthority();
				if (
					migrationRecordAuthority !== undefined &&
					Reflect.get(captured, "action") === "migrationRecord" &&
					!validMigrationRecordOperation(captured, input.author, migrationRecordAuthority)
				) {
					throw new TypeError("v3 room migration record is invalid");
				}
				// Shown before any barrier wait; the durable issue below is unchanged.
				let presented: string | undefined;
				presentationHook((overlay) => {
					presented = overlay.addLocal(captured, logicalTime, receiptHooks);
				});
				const priorMigrationBarrier = migrationBarrier;
				const priorMigrationCompletion = migrationCompletionBarrier;
				const joinsMigration = priorMigrationBarrier !== undefined && migrationAcceptingFollowers;
				let settleFollower: ((result: MigrationFollowerResult) => void) | undefined;
				const follower = joinsMigration
					? new Promise<MigrationFollowerResult>((resolve) => {
							settleFollower = resolve;
						})
					: undefined;
				if (follower !== undefined) migrationFollowers.add(follower);
				try {
					await rebasePromise;
					assertSettlementUnheld();
					await (joinsMigration ? priorMigrationBarrier : priorMigrationCompletion);
					while (poolMaintenanceBarrier !== undefined) await poolMaintenanceBarrier;
					if (terminalFailure !== undefined) throw terminalFailure;
					if (closed) throw new TypeError("v3 room session is closed");
					if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
					const authorized = authorizeV3NewLocalOperation({ plane: activeHandle, operation: captured });
					if (!authorized.ok) {
						throw new TypeError(`v3 room new operation is not authorized: ${authorized.kind}`);
					}
					const current = logicalTime;
					logicalTime += 2;
					if (presented !== undefined) {
						const id = presented;
						presentationHook((overlay) => overlay.bindLocal(id, current));
					}
					const promise = new Promise<void>((resolve, reject) => {
						pendingIssues.push(
							Object.freeze({
								source: "public-new",
								logicalTime: current,
								operation: captured,
								releasePublicInput,
								reject,
								resolve,
							})
						);
						transferred = true;
					});
					scheduleDrain();
					await promise;
					settleFollower?.(Object.freeze({ ok: true }));
					if (presented !== undefined) {
						const id = presented;
						presentationHook((overlay) => overlay.settleLocal(id, Object.freeze({ ok: true })));
					}
				} catch (error) {
					settleFollower?.(Object.freeze({ ok: false, reason: error }));
					if (presented !== undefined) {
						const id = presented;
						const reason: "projection-refused" | "refused" =
							error instanceof TypeError && error.message === PROJECTION_REFUSED_ISSUE ? "projection-refused" : "refused";
						presentationHook((overlay) => overlay.settleLocal(id, Object.freeze({ ok: false, reason, error })));
					}
					throw error;
				}
			} finally {
				if (!transferred) releasePublicInput();
			}
		},
		issueWithReceipt(operation: Readonly<Record<string, unknown>>): V3RoomIssueReceipt {
			localOwner?.assertCurrent();
			if (redirectedSession !== undefined) return redirectedSession.issueWithReceipt(operation);
			if (presentation === undefined) throw new TypeError("v3 room presentation is not enabled");
			let resolveVisible!: (entry: V3RoomPendingOperation | undefined) => void;
			let rejectVisible!: (error: unknown) => void;
			let resolveDurable!: (value: Readonly<{ vertexDigest: string; authorSequence: number }> | undefined) => void;
			let rejectDurable!: (error: unknown) => void;
			const visible = new Promise<V3RoomPendingOperation | undefined>((resolve, reject) => {
				resolveVisible = resolve;
				rejectVisible = reject;
			});
			const durable = new Promise<Readonly<{ vertexDigest: string; authorSequence: number }> | undefined>(
				(resolve, reject) => {
					resolveDurable = resolve;
					rejectDurable = reject;
				}
			);
			// Stage promises a caller ignores must not surface as unhandled.
			void visible.catch(() => undefined);
			void durable.catch(() => undefined);
			const rolledBack = (reason: V3RoomPresentationRollbackReason, error: unknown): void => {
				const failure = new TypeError(`v3 room presented move rolled back: ${reason}`, { cause: error });
				rejectVisible(failure);
				rejectDurable(failure);
			};
			nextIssueReceiptHooks = Object.freeze({ visible: resolveVisible, durable: resolveDurable, rolledBack });
			let published: Promise<void>;
			try {
				published = session.issue(operation);
			} finally {
				nextIssueReceiptHooks = undefined;
			}
			// A move outside the overlay (not speculated, or overlay full) is shown
			// and durable when the unchanged issue completes.
			published.then(
				() => {
					resolveVisible(undefined);
					resolveDurable(undefined);
				},
				(error: unknown) => {
					rejectVisible(error);
					rejectDurable(error);
				}
			);
			return Object.freeze({ visible, durable, published });
		},
		bindPresentationIntents(channel: EphemeralChannel, options?: Readonly<{ key?: string }>): () => void {
			localOwner?.assertCurrent();
			if (redirectedSession !== undefined) return redirectedSession.bindPresentationIntents(channel, options);
			assertSessionOpen();
			if (presentation === undefined) throw new TypeError("v3 room presentation is not enabled");
			const key = options?.key ?? "drp/presentation-intent/v1";
			if (typeof key !== "string" || key.length === 0 || key.length > 64)
				throw new TypeError("v3 room presentation intent key is invalid");
			const detach = attachPresentationIntents({
				overlay: presentation,
				channel,
				key,
				localAuthor: input.author,
				// The same durable roster mapping the ephemeral authority provider uses.
				authorForPeer: (peerId) => {
					const matches = projection.transportPeerAuthors.filter((entry) => entry.peerId === peerId);
					return matches.length === 1 ? matches[0]?.author : undefined;
				},
			});
			const unbind = (): void => {
				if (!presentationIntentBindings.delete(unbind)) return;
				detach();
			};
			presentationIntentBindings.add(unbind);
			return unbind;
		},
		pendingOperations(): readonly V3RoomPendingOperation[] {
			if (redirectedSession !== undefined) return redirectedSession.pendingOperations();
			return presentation?.pending() ?? Object.freeze([]);
		},
		speculativeProjection(): Projection {
			if (redirectedSession !== undefined) return redirectedSession.speculativeProjection();
			if (terminalFailure !== undefined) throw terminalFailure;
			return presentation?.projection() ?? projection;
		},
		openEphemeral(options: EphemeralChannelOptions): EphemeralChannel {
			localOwner?.assertCurrent();
			if (redirectedSession !== undefined) return redirectedSession.openEphemeral(options);
			if (terminalFailure !== undefined) throw terminalFailure;
			if (closed) throw new TypeError("v3 room session is closed");
			if (transport === undefined) throw new TypeError("v3 room transport is unavailable");
			return transport.openEphemeral(
				{
					authorForPeer(peerId: string): string | undefined {
						const matches = projection.transportPeerAuthors.filter((entry) => entry.peerId === peerId);
						return matches.length === 1 ? matches[0]?.author : undefined;
					},
					currentAuthority() {
						return activeHandle?.currentEphemeralAuthority();
					},
					isCurrentWriter(author: string): boolean {
						return activeHandle?.currentEphemeralAuthority()?.isCurrentWriter(author) === true;
					},
				},
				options
			);
		},
		previewLatchedAcl(): Readonly<Record<string, unknown>> {
			if (redirectedSession !== undefined) return redirectedSession.previewLatchedAcl();
			if (terminalFailure !== undefined) throw terminalFailure;
			if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
			const preview = Reflect.get(activeHandle, "previewLatchedAcl");
			if (typeof preview !== "function") throw new TypeError("v3 room latched ACL preview is unavailable");
			const result = Reflect.apply(preview, activeHandle, []) as unknown;
			if (typeof result !== "object" || result === null) {
				throw new TypeError("v3 room latched ACL preview is invalid");
			}
			return result as Readonly<Record<string, unknown>>;
		},
		projection(): Projection {
			if (redirectedSession !== undefined) return redirectedSession.projection();
			if (terminalFailure !== undefined) throw terminalFailure;
			return projection;
		},
		rehearseMigration,
		promoteCreatorCheckpoint,
		maintainRecoveryPool(): Promise<CreatorRecoveryPoolResult> {
			// The session's own scheduled request claims synchronously, before it queues.
			const scheduled = scheduledLulls?.claim() === true;
			return enqueueLifetimeTransition(async (): Promise<CreatorRecoveryPoolResult> => {
				if (redirectPromise !== undefined) await redirectPromise;
				if (redirectedSession !== undefined) return redirectedSession.maintainRecoveryPool();
				assertSessionOpen();
				const lull = async (): Promise<CreatorRecoveryPoolResult> => {
					if (input.receiveOnly || creatorCloseHandle === undefined) return maintainRecipientRecoveryPool();
					await rebasePromise;
					await migrationCompletionBarrier;
					let open!: () => void;
					const barrier = new Promise<void>((resolve) => { open = resolve; });
					poolMaintenanceBarrier = barrier;
					try {
						await drainPendingIssues();
						assertSessionOpen();
						const plane = activeHandle;
						if (plane === undefined) return Object.freeze({kind: "deferred", reason: "unsupported"});
						return await maintainCreatorRecoveryPool(plane);
					} finally {
						if (poolMaintenanceBarrier === barrier) poolMaintenanceBarrier = undefined;
						open();
					}
				};
				// One lull per epoch when scheduled: a settled epoch answers with its result.
				return scheduledLulls === undefined ? lull() : scheduledLulls.run(scheduled, lull);
			});
		},
		sealEpoch(): Promise<CreatorLiveCloseResult> {
			if (input.receiveOnly) return Promise.reject(new TypeError("v3 room is receive-only"));
			return enqueueLifetimeTransition(async () => {
				if (redirectPromise !== undefined) await redirectPromise;
				if (redirectedSession !== undefined) return redirectedSession.sealEpoch();
				assertSessionOpen();
				if (creatorCloseHandle === undefined) throw new TypeError("creator close authority is unavailable");
				await rebasePromise;
				await migrationCompletionBarrier;
				await drainPendingIssues();
				assertSessionOpen();
				// Current bootstrap/publication debt must join while its original
				// plane can still publish it. Historical replay is not an ACK.
				await publishCurrentGenesisBootstrap();
				assertSessionOpen();
				const result = await creatorCloseHandle.close();
				await serveAvailableSuccessor();
				return result;
			});
		},
		status(): CreatorLiveCloseStatus {
			if (redirectedSession !== undefined) return redirectedSession.status();
			return (
				creatorCloseHandle?.status() ??
				unavailableCreatorCloseStatus(roomDescriptor.trustProfile, creatorCloseUnavailableContinuity)
			);
		},
	});
	startupWaitersForDiagnostics.set(session, async (): Promise<void> => {
		if (terminalFailure !== undefined) throw terminalFailure;
		if (closed) throw new TypeError("v3 room session is closed");
		await rebasePromise;
		await recipientRetirementResume;
		if (terminalFailure !== undefined) throw terminalFailure;
		if (closed) throw new TypeError("v3 room session is closed");
	});
	if (transport?.setControlPlaneObservationProvider !== undefined) {
		const observedTransport = transport;
		const setObservation = observedTransport.setControlPlaneObservationProvider as NonNullable<
			V3RoomTransport["setControlPlaneObservationProvider"]
		>;
		Reflect.apply(setObservation, observedTransport, [
			(): ReturnType<Parameters<NonNullable<V3RoomTransport["setControlPlaneObservationProvider"]>>[0]> => {
				if (closed || terminalFailure !== undefined || redirectedSession !== undefined) return undefined;
				const owner = activeHandle;
				const authority = owner?.currentEphemeralAuthority();
				if (owner === undefined || authority === undefined || authority.objectId !== input.objectId) return undefined;
				const authenticatedPeerIds = observedTransport.networkNode.getGroupPeers(owner.topic).filter((peerId) => {
					const matches = projection.transportPeerAuthors.filter((entry) => entry.peerId === peerId);
					return matches.length === 1 && matches[0] !== undefined && authority.isCurrentMember(matches[0].author);
				});
				return Object.freeze({
					objectId: authority.objectId,
					epoch: authority.epoch,
					anchorDigest: authority.anchorDigest,
					aclDigest: authority.aclDigest,
					authenticatedPeerIds: Object.freeze([...new Set(authenticatedPeerIds)]),
					localState:
						!retainedBootstrapReady ||
						creatorSuccessorAdoptionTask !== undefined ||
						migrationBarrier !== undefined ||
						redirectPromise !== undefined ||
						settlementHeld ||
						settlementAuthorizationHeld
							? ("transitioning" as const)
							: ("installed" as const),
				});
			},
		]);
	}
	if (
		input.author === roomCreatorAuthor &&
		input.approveSettlementSourceSelection !== undefined &&
		transport?.setSettlementSourceAuthorizer !== undefined
	) {
		const currentTransport = transport;
		const setAuthorizer = currentTransport.setSettlementSourceAuthorizer as NonNullable<
			V3RoomTransport["setSettlementSourceAuthorizer"]
		>;
		Reflect.apply(setAuthorizer, currentTransport, [
			(
				request: Readonly<{
					exactCanonicalSelectionBytes: Uint8Array;
					digest: Uint8Array;
					authenticatedRequesterPeerId: string;
					signal: AbortSignal;
				}>
			): ReturnType<V3RoomSession["authorizeSettlementSourceSelection"]> =>
				session.authorizeSettlementSourceSelection({
					exactCanonicalSelectionBytes: request.exactCanonicalSelectionBytes,
					digest: request.digest,
					signal: request.signal,
				}),
		]);
	}
	if (selectRoomStartup() === "successor") {
		try {
			await serveAvailableSuccessor();
		} catch (error) {
			if (!(error instanceof CreatorSuccessorExportUnavailable)) {
				await shutdown().catch(() => undefined);
				throw error;
			}
		}
	}
	if (input.recoveryPoolAutoMaintenance !== undefined && input.receiveOnly !== true)
		autoPoolMaintenance = startRecoveryPoolAutoScheduler({
			options: input.recoveryPoolAutoMaintenance,
			// Identity changes only: a new projection, issued logical time or plane.
			activity: () => [projection, logicalTime, activeHandle, redirectedSession],
			busy: () => pendingIssues.length > 0 || drainScheduled || draining || lifetimeTransitionsPending > 0 ||
				redirectPromise !== undefined || migrationBarrier !== undefined || migrationCompletionBarrier !== undefined,
			epoch: () => (activeHandle === undefined && redirectedSession === undefined ? undefined : session.authority()?.epoch ?? 0),
			open: () => !closed && terminalFailure === undefined,
			// An epoch the scheduled lull settled needs no idle lull.
			...(scheduledLulls === undefined ? {} : { settled: (epoch: number) => scheduledLulls.settled(epoch) }),
			maintain: () => session.maintainRecoveryPool(),
			now: () => performance.now(),
			setTimer: (callback, milliseconds) => {
				const handle = setTimeout(callback, milliseconds);
				// Never keep a host process alive for optional maintenance.
				(handle as { unref?: () => void }).unref?.();
				return handle;
			},
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		});
	return session;
}

async function prepareDurableRoomState<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>,
	material: V3RoomCreatorInviteMaterial,
	sourceMaterial: V3RoomCreatorInviteMaterial | undefined,
	objectId: StorageObjectId,
	requireFreshTrust = false,
	classifyTerminalVertex?: RoomTerminalVertexClassifier,
	redirectSource?: RedirectSourceRecovery,
	redirectHistoryComplete?: (vertices: readonly V3RoomAcceptedVertex[]) => boolean,
	ownedStores?: Readonly<{
		readonly aheStores: readonly Awaited<ReturnType<V3RoomStorageHost["openAhe"]>>[];
		readonly issuanceStore: Awaited<ReturnType<V3RoomStorageHost["openIssuance"]>>;
		readonly journalStore: Awaited<ReturnType<V3RoomStorageHost["openJournal"]>>;
		readonly sourceJournalStores: readonly Awaited<ReturnType<V3RoomStorageHost["openJournal"]>>[];
	}>,
	settlementPolicy?: V3LocalSettlementPolicy
): Promise<
	Readonly<{
		readonly aheStores: readonly Awaited<ReturnType<V3RoomStorageHost["openAhe"]>>[];
		readonly issuanceStore: Awaited<ReturnType<V3RoomStorageHost["openIssuance"]>>;
		readonly journalStore: Awaited<ReturnType<V3RoomStorageHost["openJournal"]>>;
		readonly sourceJournalStores: readonly Awaited<ReturnType<V3RoomStorageHost["openJournal"]>>[];
		readonly prepared: Extract<Awaited<ReturnType<typeof prepareV3LiveGeneration>>, { readonly ok: true }>;
		readonly recovered: Extract<Awaited<ReturnType<typeof recoverV3LiveReplica>>, { readonly ok: true }>;
		readonly retainedBootstrapHeld: boolean;
	}>
> {
	const exactCanonicalPinnedGenesisBootstrapOperationBytes = encodeCanonical(
		input.application.bootstrapOperation,
		APPLICATION_BATCH_LIMITS
	);
	decodeCanonical(exactCanonicalPinnedGenesisBootstrapOperationBytes, APPLICATION_BATCH_LIMITS);
	const aheStore = ownedStores?.aheStores[0] ?? (await input.storageHost.openAhe(`${input.databaseName}--ahe`));
	const aheStores = [aheStore];
	let issuanceStore: Awaited<ReturnType<V3RoomStorageHost["openIssuance"]>> | undefined;
	let journalStore: Awaited<ReturnType<V3RoomStorageHost["openJournal"]>> | undefined;
	const sourceJournalStores: Awaited<ReturnType<V3RoomStorageHost["openJournal"]>>[] = [
		...(ownedStores?.sourceJournalStores ?? []),
	];
	try {
		if (redirectSource !== undefined && sourceMaterial === undefined) {
			throw new TypeError("v3 room redirect source material is unavailable");
		}
		const redirectSourceObjectId =
			redirectSource === undefined
				? undefined
				: parseStorageObjectId(redirectSource.activation.decision.sourceObjectId as string);
		if (redirectSourceObjectId !== undefined && !redirectSourceObjectId.ok) {
			throw new TypeError("v3 room redirect source object is invalid");
		}
		const prepareMaterial = async (
			selected: V3RoomCreatorInviteMaterial,
			store: Awaited<ReturnType<V3RoomStorageHost["openAhe"]>>,
			fresh = false,
			selectedObjectId: StorageObjectId = objectId
		): Promise<Extract<Awaited<ReturnType<typeof prepareV3LiveGeneration>>, { readonly ok: true }>> => {
			const selectedFloor =
				redirectSource !== undefined && selectedObjectId !== objectId
					? redirectSource.roomHeadAuthority
					: selected === sourceMaterial && input.rebaseSourceStorage !== undefined
						? input.rebaseSourceStorage.roomHeadAuthority
						: input.roomHeadAuthority;
			const trustStore = createCurrentAnchorTrustStore({
				objectId: selectedObjectId,
				pinnedGenesisAnchorDigest: selected.pinnedGenesisAnchorDigest,
				store,
			});
			const installed = await trustStore.install({
				detachedGenesisSignature: selected.detachedGenesisSignature,
				exactCanonicalGenesisAnchorPreimageBytes: selected.exactCanonicalGenesisAnchorPreimageBytes,
				exactCanonicalProfileBytes: selected.exactCanonicalProfileBytes,
				exactCanonicalSignerSetBytes: selected.exactCanonicalSignerSetBytes,
				pinnedGenesisAnchorDigest: selected.pinnedGenesisAnchorDigest,
			});
			if (fresh && !installed.ok) {
				throw new TypeError("v3 room migration target is already reserved");
			}
			if (!installed.ok && installed.reason !== "already-installed") {
				throw new TypeError(`v3 room trust installation failed: ${installed.reason}`);
			}
			const openedTrust = installed.ok ? installed : await trustStore.open();
			if (
				!openedTrust.ok ||
				(openedTrust.trust.profileId !== "creator-trusted-v1" &&
					settlementProfileFor(openedTrust.trust.profileId) === "none")
			) {
				throw new TypeError("v3 room verified trust profile is invalid");
			}
			const prepared = await prepareV3LiveGeneration({
				authenticationProfile: "creator-only",
				store,
				objectId: selectedObjectId,
				pinnedGenesisAnchorDigest: selected.pinnedGenesisAnchorDigest,
				exactCanonicalAnchorPreimageBytes: selected.exactCanonicalGenesisAnchorPreimageBytes,
				detachedSignature: selected.detachedGenesisSignature,
				exactCanonicalParametersCarrierBytes: selected.exactCanonicalParametersCarrierBytes,
				catalog: input.application.catalog,
				...(settlementPolicy === undefined ? {} : { settlementPolicy }),
				...(selectedFloor.acquireNativeReadReservation === undefined || selectedFloor.readRetirementImage === undefined
					? {}
					: {
							settlementFloor: selectedFloor as Required<
								Pick<V3RoomHeadAuthority, "acquireNativeReadReservation" | "readRetirementImage">
							>,
						}),
			});
			if (!prepared.ok) throw new TypeError(`v3 room preparation failed: ${prepared.kind}`);
			return prepared;
		};
		let prepared = await prepareMaterial(material, aheStore, requireFreshTrust);
		let sourceAheStore: Awaited<ReturnType<V3RoomStorageHost["openAhe"]>> | undefined;
		let sourcePrepared: Readonly<{ capability: V3TerminalMigrationSource["capability"] }> | undefined;
		let sourceAclBytes = sourceMaterial?.exactCanonicalLatchedAclBytes;
		const prepareCurrentSource = async (): Promise<void> => {
			const current = await redirectSource?.prepareCurrentSource?.();
			if (
				current === undefined ||
				redirectSource?.currentSource === undefined ||
				current.anchorDigest !== redirectSource.currentSource.anchorDigest ||
				current.objectId !== redirectSource.currentSource.objectId ||
				current.blueprintDigest !== redirectSource.currentSource.blueprintDigest ||
				current.signerSetDigest !== redirectSource.currentSource.signerSetDigest ||
				!sameBytes(current.exactCanonicalLatchedAclBytes, redirectSource.currentSource.exactCanonicalLatchedAclBytes)
			)
				throw new TypeError("migration current source authority changed");
			sourcePrepared = current;
			sourceAclBytes = current.exactCanonicalLatchedAclBytes;
		};
		if (redirectSource?.currentSource !== undefined) {
			sourcePrepared = redirectSource.currentSource;
			sourceAclBytes = redirectSource.currentSource.exactCanonicalLatchedAclBytes;
		} else if (sourceMaterial !== undefined) {
			sourceAheStore =
				ownedStores?.aheStores[1] ??
				(await input.storageHost.openAhe(
					input.rebaseSourceStorage === undefined
						? `${input.databaseName}--rebase-${sourceMaterial.pinnedGenesisAnchorDigest}--ahe`
						: `${input.rebaseSourceStorage.databaseName}--ahe`
				));
			aheStores.push(sourceAheStore);
			if (input.rebaseSourceStorage !== undefined) {
				const head = await sourceAheStore.readHead(objectId);
				if (!head.ok || head.value.kind !== "present")
					throw new TypeError("v3 room original rebase source AHE is unavailable");
			}
			sourcePrepared = await prepareMaterial(
				sourceMaterial,
				sourceAheStore,
				false,
				redirectSourceObjectId?.ok === true ? redirectSourceObjectId.value : objectId
			);
		}
		const openedIssuanceStore =
			ownedStores?.issuanceStore ?? (await input.storageHost.openIssuance(input.issuanceDatabaseName));
		issuanceStore = openedIssuanceStore;
		const openedJournalStore = ownedStores?.journalStore ?? (await input.storageHost.openJournal(input.databaseName));
		journalStore = openedJournalStore;
		if (input.rebaseSourceStorage !== undefined && sourceJournalStores.length === 0)
			sourceJournalStores.push(await input.storageHost.openJournal(input.rebaseSourceStorage.databaseName));
		const scope = Object.freeze({ author: input.author, objectId: input.objectId });
		if (requireFreshTrust) {
			const lineage = await openedIssuanceStore.readLineage(scope);
			if (lineage.next !== 0 || lineage.exhausted) {
				throw new TypeError("v3 room migration target issuance is not fresh");
			}
		}
		if (typeof openedJournalStore.readiness === "function") {
			const expectedScope = Object.freeze({
				anchorDigest: material.pinnedGenesisAnchorDigest,
				epoch: 0 as const,
				objectId: input.objectId,
			});
			const sameExpectedScope = (value: unknown): boolean =>
				typeof value === "object" &&
				value !== null &&
				Reflect.get(value, "anchorDigest") === expectedScope.anchorDigest &&
				Reflect.get(value, "epoch") === expectedScope.epoch &&
				Reflect.get(value, "objectId") === expectedScope.objectId;
			let readiness;
			try {
				readiness = await openedJournalStore.readiness({ scope: expectedScope });
			} catch {
				throw new TypeError("v3 room journal readiness failed");
			}
			if (!readiness.ok) throw new TypeError("v3 room journal readiness failed");
			if (requireFreshTrust && readiness.ready) {
				throw new TypeError("v3 room migration target journal is not fresh");
			}
			if (!readiness.ready) {
				if (readiness.kind !== "not-installed") {
					throw new TypeError("v3 room journal readiness is invalid");
				}
			} else {
				if (
					!Number.isSafeInteger(readiness.rowCount) ||
					readiness.rowCount < 0 ||
					!sameExpectedScope(readiness.scope) ||
					typeof readiness.snapshot !== "object" ||
					readiness.snapshot === null ||
					!sameExpectedScope(Reflect.get(readiness.snapshot, "scope"))
				) {
					throw new TypeError("v3 room journal readiness is invalid");
				}
			}
		} else {
			if (sourceMaterial !== undefined) {
				throw new TypeError("v3 room journal readiness is unavailable");
			}
		}
		const recoverPrepared = (retainedBootstrapHold = false): ReturnType<typeof recoverV3LiveReplica> =>
			recoverV3LiveReplica({
				...(input.receiveOnly ? { receiveOnly: true as const } : {}),
				capability: prepared.capability,
				...(classifyTerminalVertex === undefined ? {} : { classifyTerminalVertex }),
				...(sourcePrepared === undefined || sourceMaterial === undefined
					? {}
					: {
							displacedSource: Object.freeze({
								...(redirectSource === undefined && input.rebaseSourceStorage !== undefined
									? {
											issuanceScope: scope,
											issuanceStore: openedIssuanceStore,
											liveJournalStore: sourceJournalStores[0],
										}
									: {}),
								...(redirectSource === undefined
									? {}
									: {
											activationVertexDigest: redirectSource.activation.activationVertexDigest,
											issuanceScope: Object.freeze({
												author: input.author,
												objectId: redirectSource.activation.decision.sourceObjectId as string,
											}),
											issuanceStore: redirectSource.issuanceStore,
											liveJournalStore: redirectSource.journalStore,
										}),
								capability: sourcePrepared.capability,
								exactCanonicalLatchedAclBytes: sourceAclBytes as Uint8Array,
							}),
						}),
				exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
				exactCanonicalPinnedGenesisBootstrapOperationBytes,
				issuanceScope: scope,
				issuanceStore: openedIssuanceStore,
				liveJournalStore: openedJournalStore,
				operationAdmissionPolicy: createRoomOperationAdmissionPolicy(
					input,
					material,
					Object.freeze({
						aclDigest: digest("ts-drp/latched-acl/v3", material.exactCanonicalLatchedAclBytes),
						exactCanonicalLatchedAclBytes: new Uint8Array(material.exactCanonicalLatchedAclBytes),
						anchorDigest: material.pinnedGenesisAnchorDigest,
						epoch: 0 as const,
						objectId: input.objectId,
					})
				),
				...(retainedBootstrapHold ? { retainedBootstrapHold: true as const } : {}),
			});
		let retainedBootstrapHeld = false;
		let recovered = await recoverPrepared();
		if (
			redirectSource !== undefined &&
			recovered.ok &&
			redirectHistoryComplete?.(recovered.descriptor.recoveredVertices) !== true
		) {
			prepared = await prepareMaterial(material, aheStore);
			if (redirectSource?.currentSource !== undefined) await prepareCurrentSource();
			if (sourceMaterial !== undefined && sourceAheStore !== undefined) {
				sourcePrepared = await prepareMaterial(
					sourceMaterial,
					sourceAheStore,
					false,
					redirectSourceObjectId?.ok === true ? redirectSourceObjectId.value : objectId
				);
			}
			retainedBootstrapHeld = true;
			recovered = await recoverPrepared(true);
		}
		if (
			!recovered.ok &&
			recovered.kind === "issuance-rejected" &&
			recovered.detail === "v3 recovery issued record chain is empty"
		) {
			prepared = await prepareMaterial(material, aheStore);
			if (redirectSource?.currentSource !== undefined) await prepareCurrentSource();
			if (sourceMaterial !== undefined && sourceAheStore !== undefined) {
				sourcePrepared = await prepareMaterial(
					sourceMaterial,
					sourceAheStore,
					false,
					redirectSourceObjectId?.ok === true ? redirectSourceObjectId.value : objectId
				);
			}
			if (redirectSource !== undefined) {
				retainedBootstrapHeld = true;
				recovered = await recoverPrepared(true);
			} else {
				const admission = prepareBlueprintAdmission({
					canonicalBlueprintPackageBytes: input.application.canonicalBlueprintPackageBytes,
					expectedBlueprintDigest: prepared.descriptor.blueprintDigest,
				});
				const issuer = createAdmissionBoundTransactionalVertexIssuer({
					author: input.author,
					preparedBlueprintAdmission: admission,
					publicKey: Object.freeze({ bytes: new Uint8Array(input.publicKeyBytes), format: "raw" as const }),
					signRegisteredVertexDigest: input.signRegisteredVertexDigest,
					transactIssue: (selectedScope, buildAndSign) =>
						openedIssuanceStore.transactIssue(selectedScope, (sequence) =>
							buildAndSign(sequence, nativeIssuanceSignAdmissionForStore(openedIssuanceStore, selectedScope))
						),
				});
				await issuer.issue({
					anchor: material.pinnedGenesisAnchorDigest,
					dependencies: [material.pinnedGenesisAnchorDigest],
					epoch: 0,
					logicalTime: 1,
					objectId: input.objectId,
					operation: input.application.bootstrapOperation,
				});
				recovered = await recoverPrepared();
			}
		}
		if (!recovered.ok) throw new TypeError(`v3 room recovery failed: ${recovered.kind}`);
		return Object.freeze({
			aheStores: Object.freeze([...aheStores]),
			issuanceStore: openedIssuanceStore,
			journalStore: openedJournalStore,
			sourceJournalStores: Object.freeze([...sourceJournalStores]),
			prepared,
			recovered,
			retainedBootstrapHeld,
		});
	} catch (error) {
		if (ownedStores !== undefined) throw error;
		const closers: Promise<void>[] = aheStores.map((store) => store.close());
		if (issuanceStore !== undefined) closers.push(issuanceStore.close());
		if (journalStore !== undefined) closers.push(journalStore.close());
		closers.push(...sourceJournalStores.map((store) => store.close()));
		await Promise.allSettled(closers);
		throw error;
	}
}

function compareAcceptedVertices(left: V3RoomAcceptedVertex, right: V3RoomAcceptedVertex): number {
	return (
		left.epoch - right.epoch ||
		left.logicalTime - right.logicalTime ||
		compareText(left.author, right.author) ||
		left.authorSequence - right.authorSequence ||
		compareText(hex(left.digest), hex(right.digest))
	);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
