import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { CompactMerkleAccumulator } from "@ts-drp/compaction";
import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import type { EphemeralChannel, EphemeralChannelOptions } from "@ts-drp/ephemeral";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { verifyCreatorSuccessorAdoption } from "@ts-drp/node/creator-adoption";
import {
	activateCreatorSuccessorAdoption,
	reopenCreatorSuccessorAdoption,
} from "@ts-drp/node/creator-adoption-activate";
import { recoverPendingCreatorSuccessorAdoption } from "@ts-drp/node/creator-adoption-recover";
import {
	publishStagedCreatorSuccessorAdoption,
	stageCreatorSuccessorAdoption,
} from "@ts-drp/node/creator-adoption-stage";
import {
	bindCreatorLiveClose,
	type BindCreatorLiveCloseInput,
	type CreatorLiveCloseHandle,
	type CreatorLiveCloseResult,
	type CreatorLiveCloseStatus,
} from "@ts-drp/node/creator-close";
import {
	activateV3LivePlane,
	bindV3BlueprintLivePlane,
	prepareV3LiveGeneration,
	recoverV3LiveReplica,
	republishV3RetainedTo,
	routeV3Ingress,
	routeV3RetainedIngress,
	type V3AdmittedVertexSink,
	type V3LiveDescriptor,
	type V3OperationAdmissionPolicy,
	type V3PlaneHandle,
} from "@ts-drp/node/v3-live";
import {
	type AdmittedReceivedVertexView,
	createAdmissionBoundTransactionalVertexIssuer,
	prepareBlueprintAdmission,
	type SignRegisteredVertexDigest,
} from "@ts-drp/protocol-v3";
import { parseStorageObjectId, type StorageObjectId } from "@ts-drp/storage";
import type { SnapshotQuarantineDeclaration } from "@ts-drp/storage/snapshot-transfer";
import { createBrowserAheDurableStore } from "@ts-drp/storage-browser";
import { createBrowserDurableIssuanceStore } from "@ts-drp/storage-browser/issuance";
import { createBrowserDurableLiveJournalStore } from "@ts-drp/storage-browser/live-journal";
import { openBrowserSealEvidenceStore } from "@ts-drp/storage-browser/seal-evidence";
import { openBrowserSealVoteStore } from "@ts-drp/storage-browser/seal-vote";
import { createBrowserSnapshotQuarantineStore } from "@ts-drp/storage-browser/snapshot-transfer";
import type { DRPNetworkNode, Message } from "@ts-drp/types";

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
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly objectId: string;
	readonly signGenesisAnchorDigest: GenesisAnchorSigner;
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

export interface V3RoomHead {
	readonly currentAnchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
}

export interface V3RoomHeadScope {
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
}

export interface V3RoomHeadState {
	readonly pending: null | Readonly<{ readonly next: V3RoomHead; readonly previous: V3RoomHead }>;
	readonly stable: V3RoomHead;
}

export type V3RoomHeadAuthorityResult =
	| Readonly<{ readonly ok: false; readonly reason: "conflict" | "unavailable" }>
	| Readonly<{ readonly ok: true; readonly state: V3RoomHeadState | null }>;

export type V3RoomHeadInitialization =
	| Readonly<{ readonly kind: "create" }>
	| Readonly<{ readonly head: V3RoomHead; readonly kind: "migrate" }>
	| Readonly<{ readonly kind: "reopen" }>;

export interface V3RoomHeadAuthority {
	readonly initialization: V3RoomHeadInitialization;
	begin(
		input: Readonly<{ readonly expected: V3RoomHeadState; readonly next: V3RoomHead; readonly scope: V3RoomHeadScope }>
	): Promise<V3RoomHeadAuthorityResult>;
	commit(
		input: Readonly<{ readonly expected: V3RoomHeadState; readonly scope: V3RoomHeadScope }>
	): Promise<V3RoomHeadAuthorityResult>;
	create(
		input: Readonly<{ readonly scope: V3RoomHeadScope; readonly stable: V3RoomHead }>
	): Promise<V3RoomHeadAuthorityResult>;
	migrate(
		input: Readonly<{ readonly scope: V3RoomHeadScope; readonly stable: V3RoomHead }>
	): Promise<V3RoomHeadAuthorityResult>;
	read(input: Readonly<{ readonly scope: V3RoomHeadScope }>): Promise<V3RoomHeadAuthorityResult>;
}

export interface V3RoomMigrationProjection {
	readonly exactCanonicalApplicationStateBytes: Uint8Array;
	readonly importOperations: readonly Readonly<Record<string, unknown>>[];
}

export interface V3RoomMigrationCapability<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	canonicalStateBytes(projection: Projection): Uint8Array;
	prepare(accepted: readonly V3RoomAcceptedOperation[]): V3RoomMigrationProjection;
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
	close(): void;
	openEphemeral(provider: V3RoomEphemeralAuthorizationProvider, options: EphemeralChannelOptions): EphemeralChannel;
	requestRetainedHistory(): void;
	setIngressHandler(
		ingressId: string,
		liveHandler: (message: Message) => void,
		retainedHandler: (message: Message) => void
	): void;
	setRetainedPublisher(publisher: (targetPeerId?: string) => Promise<void>): void;
}

export interface V3RoomApplication<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	readonly batchableOperationActions: readonly string[];
	readonly bootstrapOperation: Readonly<Record<string, unknown>>;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: Parameters<typeof prepareV3LiveGeneration>[0]["catalog"];
	displacedOperationIdentity(operation: Readonly<Record<string, unknown>>): string;
	readonly displacementPolicies: Readonly<Record<string, "expire" | "manual-review" | "rebase" | "transform">>;
	readonly migration?: V3RoomMigrationCapability<Projection>;
	/** Throw a direct TypeError only when authenticated product fields are invalid. */
	projectAcceptedOperations(operations: readonly V3RoomAcceptedOperation[]): Projection;
	transformDisplacedOperation?(operation: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
}

export interface CreateV3RoomSessionInput<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	readonly application: V3RoomApplication<Projection>;
	readonly author: string;
	readonly creatorFinalitySigner?: BindCreatorLiveCloseInput["signer"];
	readonly creatorInvite: string | V3RoomCreatorInviteMaterial;
	createOperationAdmissionPolicy?(
		context: Readonly<{
			readonly aclDigest: string;
			readonly anchorDigest: string;
			readonly epoch: number;
			readonly objectId: string;
		}>
	): V3OperationAdmissionPolicy;
	readonly databaseName: string;
	readonly initialLogicalTime: number;
	readonly issuanceDatabaseName: string;
	readonly migrationDatabaseNamespace?: string;
	readonly objectId: string;
	openTransport(objectId: string): V3RoomTransport;
	onAcceptedVertex(vertex: AdmittedReceivedVertexView): void | Promise<void>;
	onMigrationTarget?(session: V3RoomSession<Projection>, objectId: string): void;
	onProjection(projection: Projection): void;
	readonly publicKeyBytes: Uint8Array;
	readonly rebaseSourceInvite?: string | V3RoomCreatorInviteMaterial;
	readonly roomHeadAuthority: V3RoomHeadAuthority;
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
	readonly successorSnapshotDeclaration?: SnapshotQuarantineDeclaration;
}

export interface V3RoomSession<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	readonly invite: string;
	readonly objectId: string;
	readonly roomId: string;
	readonly trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.";
	adoptCreatorSuccessor(): Promise<void>;
	authority(): V3RoomSuccessorAuthority | null;
	close(): Promise<void>;
	activateMigration(input: V3RoomMigrationActivationInput): Promise<V3RoomMigrationActivationReceipt>;
	inspectDurableHead(): ReturnType<CreatorLiveCloseHandle["inspectDurableHead"]>;
	issue(operation: Readonly<Record<string, unknown>>): Promise<void>;
	openEphemeral(options: EphemeralChannelOptions): EphemeralChannel;
	previewLatchedAcl(): Readonly<Record<string, unknown>>;
	projection(): Projection;
	rehearseMigration(input: V3RoomMigrationRehearsalInput): Promise<V3RoomMigrationRehearsalReceipt>;
	sealEpoch(): Promise<CreatorLiveCloseResult>;
	status(): CreatorLiveCloseStatus;
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
		profileId !== "creator-trusted-v1" ||
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
		encodeCanonical({
			detachedGenesisSignature: material.detachedGenesisSignature,
			exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
			exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
			exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
			kind: "ts-drp-example-v3-room-creator-invite",
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
			version: 1,
		})
	);
}

function inviteBytes(values: Record<string, unknown>, field: string): Uint8Array {
	const value = values[field];
	if (!(value instanceof Uint8Array) || value.byteLength === 0) {
		throw new TypeError(`v3 room creator invite ${field} is invalid`);
	}
	return new Uint8Array(value);
}

function decodeCreatorInvite(invite: string): V3RoomCreatorInviteMaterial {
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
	return Object.freeze({
		detachedGenesisSignature,
		exactCanonicalLatchedAclBytes: inviteBytes(values, "exactCanonicalLatchedAclBytes"),
		exactCanonicalGenesisAnchorPreimageBytes: inviteBytes(values, "exactCanonicalGenesisAnchorPreimageBytes"),
		exactCanonicalParametersCarrierBytes: inviteBytes(values, "exactCanonicalParametersCarrierBytes"),
		exactCanonicalProfileBytes: inviteBytes(values, "exactCanonicalProfileBytes"),
		exactCanonicalSignerSetBytes: inviteBytes(values, "exactCanonicalSignerSetBytes"),
		pinnedGenesisAnchorDigest: values.pinnedGenesisAnchorDigest,
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
	const record = exactRecord(input, [
		"blueprintDigest",
		"exactCanonicalApplicationStateBytes",
		"exactCanonicalLatchedAclBytes",
		"exactCanonicalParametersCarrierBytes",
		"exactCanonicalProfileBytes",
		"exactCanonicalSignerSetBytes",
		"objectId",
		"signGenesisAnchorDigest",
	]);
	if (
		record === undefined ||
		typeof record.blueprintDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(record.blueprintDigest) ||
		typeof record.objectId !== "string" ||
		!parseStorageObjectId(record.objectId).ok ||
		typeof record.signGenesisAnchorDigest !== "function"
	) {
		throw new TypeError("v3 room creator invite input is invalid");
	}
	const blueprintDigest = record.blueprintDigest;
	const objectId = record.objectId;
	const signGenesisAnchorDigest = record.signGenesisAnchorDigest as (digest: Uint8Array) => Promise<Uint8Array>;
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
		await signGenesisAnchorDigest(new Uint8Array(anchorDigest)),
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

function detachedRoomOperation(value: unknown): Readonly<Record<string, unknown>> | undefined {
	try {
		const decoded = decodeCanonical(encodeCanonical(value));
		if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
		return Object.freeze({ ...(decoded as Record<string, unknown>) });
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
const LOWER_HEX_256 = /^[0-9a-f]{64}$/u;

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
	readonly activation: AuthenticatedMigrationActivation;
	readonly cancelled: Promise<void>;
	readonly issuanceStore: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>>;
	readonly journalStore: Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>>;
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
		return migrationActivationOperation(operation, author, authority) === undefined ? "reject" : "terminal-authorized";
	};
}

function validMigrationRecordOperation(
	operation: Readonly<Record<string, unknown>>,
	author: string,
	authority: MigrationRecordAuthority
): boolean {
	if (Reflect.get(operation, "action") !== "migrationRecord") return true;
	const outer = exactRecord(operation, ["action", "record"]);
	const record = exactRecord(outer?.record, MIGRATION_RECORD_KEYS);
	if (outer === undefined || record === undefined) return false;
	const nonce = record.rehearsalNonce;
	const stateBytes = record.exactCanonicalApplicationStateBytes;
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
		record.version !== 1 ||
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

function migrationCreatorAuthor(material: V3RoomCreatorInviteMaterial): string {
	const decoded = decodeCanonical(material.exactCanonicalLatchedAclBytes, {
		maxBytes: 65_536,
		maxDepth: 6,
		maxItems: 512,
	});
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
			groups.includes("finality") &&
			groups.includes("writer")
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
	const acl = decodeCanonical(material.exactCanonicalLatchedAclBytes, { maxBytes: 65_536, maxDepth: 6, maxItems: 512 });
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
 * Opens one browser v3 room from application material and a real transport adapter.
 * @param input - Closed application, identity, durable-store and transport bindings.
 * @returns The active room session after durable recovery and live activation.
 */
export async function createV3RoomSession<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>
): Promise<V3RoomSession<Projection>> {
	return createV3RoomSessionOwned(input, false);
}

async function createV3RoomSessionOwned<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>,
	requireFreshTrust: boolean,
	redirectSource?: RedirectSourceRecovery,
	skipRoomHeadAuthority = false
): Promise<V3RoomSession<Projection>> {
	if (
		input.successorSnapshotDeclaration !== undefined &&
		(input.createOperationAdmissionPolicy !== undefined ||
			input.rebaseSourceInvite !== undefined ||
			input.creatorFinalitySigner !== undefined)
	) {
		throw new TypeError("v3 room successor authority composition is unsupported");
	}
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
	const invite =
		typeof input.creatorInvite === "string" ? input.creatorInvite : encodeCreatorInvite(input.creatorInvite);
	const material = decodeCreatorInvite(invite);
	const sourceInvite = input.rebaseSourceInvite;
	const sourceMaterial =
		sourceInvite === undefined
			? undefined
			: decodeCreatorInvite(typeof sourceInvite === "string" ? sourceInvite : encodeCreatorInvite(sourceInvite));
	const {
		rebaseSourceInvite: _rebaseSourceInvite,
		successorSnapshotDeclaration: _successorSnapshotDeclaration,
		...inputWithoutRebase
	} = input;
	const objectIdResult = parseStorageObjectId(input.objectId);
	if (!objectIdResult.ok) throw new TypeError("v3 room object id is invalid");
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
	if (redirectSource === undefined && !requireFreshTrust && !skipRoomHeadAuthority) {
		const candidate = input.roomHeadAuthority;
		if (
			candidate === undefined ||
			candidate === null ||
			typeof candidate !== "object" ||
			!["begin", "commit", "create", "migrate", "read"].every(
				(method) => typeof Reflect.get(candidate, method) === "function"
			)
		) {
			if (input.creatorFinalitySigner !== undefined || input.successorSnapshotDeclaration !== undefined) {
				return roomHeadFailure("D110C_FLOOR_MIGRATION_REQUIRED");
			}
		} else {
			roomHeadAuthority = candidate;
			openedRoomHeadState = await initializeRoomHeadAuthority(candidate, roomHeadScope, genesisRoomHead);
			if (openedRoomHeadState.pending !== null && input.successorSnapshotDeclaration === undefined) {
				return roomHeadFailure("D110C_FLOOR_RECOVERY_UNAVAILABLE");
			}
			if (
				openedRoomHeadState.pending === null &&
				input.successorSnapshotDeclaration === undefined &&
				!sameRoomHead(openedRoomHeadState.stable, genesisRoomHead)
			) {
				return roomHeadFailure("D110C_FLOOR_MISMATCH");
			}
			if (
				openedRoomHeadState.pending === null &&
				input.successorSnapshotDeclaration !== undefined &&
				openedRoomHeadState.stable.epoch !== 1
			) {
				return roomHeadFailure(
					openedRoomHeadState.stable.epoch < 1 ? "D110C_FLOOR_HEAD_AHEAD" : "D110C_FLOOR_MISMATCH"
				);
			}
		}
	}
	const inviteAuthority = migrationInviteAuthority(material);
	const roomInviteAuthority = input.application.migration === undefined ? undefined : inviteAuthority;
	if (inviteAuthority.objectId !== input.objectId) {
		throw new TypeError("v3 room creator invite object is invalid");
	}
	const migrationActivationAuthority =
		roomInviteAuthority === undefined
			? undefined
			: Object.freeze({
					anchorDigest: material.pinnedGenesisAnchorDigest,
					blueprintDigest: roomInviteAuthority.blueprintDigest,
					creatorAuthor: roomInviteAuthority.creatorAuthor,
					objectId: roomInviteAuthority.objectId,
					signerSetDigest: roomInviteAuthority.signerSetDigest,
				});
	const sourceMigrationActivationAuthority =
		redirectSource === undefined || sourceMaterial === undefined
			? undefined
			: ((): MigrationActivationAuthority => {
					const authority = migrationInviteAuthority(sourceMaterial);
					return Object.freeze({
						anchorDigest: sourceMaterial.pinnedGenesisAnchorDigest,
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
					const record = exactRecord(
						recordOperation === undefined ? undefined : Reflect.get(recordOperation, "record"),
						MIGRATION_RECORD_KEYS
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
	let aheStores: readonly Awaited<ReturnType<typeof createBrowserAheDurableStore>>[];
	let issuanceStore: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>>;
	let journalStore: Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>>;
	let prepared: PreparedRoomState | undefined;
	let recovered: RecoveredRoomState | undefined;
	let retainedBootstrapHeld = false;
	if (input.successorSnapshotDeclaration === undefined) {
		const durable = await prepareDurableRoomState(
			Object.freeze({ ...input, issuanceDatabaseName }),
			material,
			sourceMaterial,
			objectIdResult.value,
			requireFreshTrust,
			classifyTerminalVertex,
			redirectSource,
			redirectHistoryComplete
		);
		aheStores = durable.aheStores;
		issuanceStore = durable.issuanceStore;
		journalStore = durable.journalStore;
		prepared = durable.prepared;
		recovered = durable.recovered;
		retainedBootstrapHeld = durable.retainedBootstrapHeld;
	} else {
		const aheStore = await createBrowserAheDurableStore({ databaseName: `${input.databaseName}--ahe` });
		let openedIssuanceStore: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>> | undefined;
		try {
			openedIssuanceStore = await createBrowserDurableIssuanceStore({ primaryDatabaseName: issuanceDatabaseName });
			journalStore = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: input.databaseName });
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
		await Promise.allSettled([issuanceStore.close(), journalStore.close(), ...aheStores.map((store) => store.close())]);
		throw new TypeError("v3 room migration activation history is invalid");
	}
	const recoveredActivation = recoveredActivations[0];
	const acceptedVertices = new Map<string, V3RoomAcceptedVertex>();
	const acceptedOperationRows = new Map<string, readonly V3RoomAcceptedOperation[] | null>();
	let projection: Projection;
	let successorProjectionAuthority: V3RoomSuccessorAuthority | null = null;
	let logicalTime = input.initialLogicalTime;
	const roomCreatorAuthor = roomInviteAuthority === undefined ? input.author : roomInviteAuthority.creatorAuthor;
	const currentMigrationRecordAuthority = (): MigrationRecordAuthority | undefined =>
		input.application.migration === undefined
			? undefined
			: Object.freeze({
					anchorDigest: successorProjectionAuthority?.anchorDigest ?? roomDescriptor.anchorDigest,
					blueprintDigest: roomDescriptor.blueprintDigest,
					creatorAuthor: roomCreatorAuthor,
					objectId: input.objectId,
				});
	const expand = (vertex: V3RoomAcceptedVertex): readonly V3RoomAcceptedOperation[] | undefined => {
		const identity = hex(vertex.digest);
		const cached = acceptedOperationRows.get(identity);
		if (cached !== undefined) return cached === null ? undefined : cached;
		const expanded = acceptedOperationsForVertex(input.application, vertex, currentMigrationRecordAuthority());
		acceptedOperationRows.set(identity, expanded ?? null);
		return expanded;
	};
	const stage = (
		vertices: readonly V3RoomAcceptedVertex[]
	): Readonly<{
		readonly additions: readonly Readonly<{ readonly identity: string; readonly vertex: V3RoomAcceptedVertex }>[];
		readonly projection: Projection;
	}> => {
		const candidate = new Map(acceptedVertices);
		const additions: Readonly<{ readonly identity: string; readonly vertex: V3RoomAcceptedVertex }>[] = [];
		for (const vertex of [...vertices].sort(compareAcceptedVertices)) {
			const identity = hex(vertex.digest);
			if (candidate.has(identity)) continue;
			const expanded = expand(vertex);
			if (expanded === undefined) continue;
			candidate.set(identity, vertex);
			additions.push(Object.freeze({ identity, vertex }));
		}
		const project = (selected: ReadonlyMap<string, V3RoomAcceptedVertex>): Projection =>
			input.application.projectAcceptedOperations(
				Object.freeze([...selected.values()].sort(compareAcceptedVertices).flatMap((vertex) => expand(vertex) ?? []))
			);
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
	const commit = async (vertices: readonly V3RoomAcceptedVertex[]): Promise<boolean> => {
		for (const vertex of vertices) {
			const expanded = expand(vertex);
			const latestChild = expanded?.at(-1)?.logicalTime ?? vertex.logicalTime;
			logicalTime = Math.max(logicalTime, vertex.logicalTime + 2, latestChild + 2);
		}
		const candidate = stage(vertices);
		if (candidate.additions.length === 0) return false;
		for (const { vertex } of candidate.additions) await input.onAcceptedVertex(vertex);
		input.onProjection(candidate.projection);
		for (const { identity, vertex } of candidate.additions) {
			acceptedVertices.set(identity, vertex);
			logicalTime = Math.max(logicalTime, vertex.logicalTime + 2);
		}
		projection = candidate.projection;
		return true;
	};
	const acceptedOperationSnapshot = (): readonly V3RoomAcceptedOperation[] =>
		Object.freeze(
			[...acceptedVertices.values()]
				.sort(compareAcceptedVertices)
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
	try {
		if (!(await commit(recovered?.descriptor.recoveredVertices ?? Object.freeze([])))) {
			projection = input.application.projectAcceptedOperations(Object.freeze([]));
			input.onProjection(projection);
		}
	} catch (error) {
		await Promise.all([issuanceStore.close(), journalStore.close(), ...aheStores.map((store) => store.close())]);
		throw error;
	}
	const recoveredProjectionRejected = (recovered?.descriptor.recoveredVertices ?? Object.freeze([])).some(
		(vertex) => vertex.author === input.author && acceptedOperationRows.get(hex(vertex.digest)) === null
	);
	const messageQueueManager = new MessageQueueManager<Message>({ logConfig: { level: "silent" } });
	let activeHandle: RoomPlaneHandle | undefined;
	let creatorCloseHandle: CreatorLiveCloseHandle | undefined;
	let bindCurrentCreatorClose: ((plane: RoomPlaneHandle) => ReturnType<typeof bindCreatorLiveClose>) | undefined;
	let creatorCloseUnavailableContinuity: CreatorLiveCloseStatus["continuity"] = "continuous";
	const creatorCloseStoreClosers: Array<() => Promise<void>> = [];
	let transport: V3RoomTransport | undefined;
	let terminalFailure: unknown = recoveredProjectionRejected
		? new TypeError("v3 room recovered operation was not accepted by projection")
		: undefined;
	let closed = false;
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
	let redirectedSession: V3RoomSession<Projection> | undefined;
	let redirectPromise: Promise<V3RoomSession<Projection>> | undefined;
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
	const shutdown = (): Promise<void> => {
		if (closePromise !== undefined) return closePromise;
		closed = true;
		cancelRedirectCreation();
		if (!retainedBootstrapReady) {
			rejectRetainedBootstrap?.(new TypeError("v3 room session closed before retained bootstrap completed"));
		}
		closePromise = (async (): Promise<void> => {
			const failures: unknown[] = [];
			if (creatorCloseHandle !== undefined) {
				try {
					await creatorCloseHandle.stop();
				} catch (error) {
					failures.push(error);
				}
			}
			try {
				await Promise.resolve(activeHandle?.deactivate());
			} catch (error) {
				failures.push(error);
			}
			try {
				messageQueueManager.closeAll();
			} catch (error) {
				failures.push(error);
			}
			try {
				transport?.close();
			} catch (error) {
				failures.push(error);
			}
			for (const result of await Promise.allSettled([
				...creatorCloseStoreClosers.map((closeStore) => closeStore()),
				issuanceStore.close(),
				journalStore.close(),
				...aheStores.map((store) => store.close()),
			])) {
				if (result.status === "rejected") failures.push(result.reason);
			}
			if (failures.length > 0) throw failures[0];
		})();
		return closePromise;
	};
	const createRedirectSession = (
		activation: AuthenticatedMigrationActivation
	): Promise<
		Readonly<{
			activateMigrationTargetCallbacks(): void;
			migrationTargetObjectId(): string;
			releaseCallbacks(): Promise<void>;
			session: V3RoomSession<Projection>;
		}>
	> => {
		const rehearsalNonce = activation.decision.rehearsalNonce as Uint8Array;
		const targetObjectId = activation.decision.targetObjectId as string;
		const scratchDigest = digest(
			"ts-drp/v3-room-migration-scratch/v1",
			encodeCanonical({ rehearsalNonce, sourceObjectId: input.objectId, targetObjectId })
		);
		const scratchDatabaseName = migrationScratchDatabaseName(scratchDigest);
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
				cancelled: redirectCancellation,
				issuanceStore,
				journalStore,
				onRetainedBootstrapHold: reportRedirectBootstrapHold,
			})
		);
		return attempt.then((session) => {
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
		const record = exactRecord(Reflect.get(operation, "record"), MIGRATION_RECORD_KEYS);
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
		const recordState = normalizeApplicationStateBytes(record.exactCanonicalApplicationStateBytes, "migration");
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
	const admittedSink = async ({
		vertex,
	}: Parameters<V3AdmittedVertexSink>[0]): Promise<
		Readonly<{
			readonly kind: "continue" | "retained-bootstrap-ready" | "terminal-accepted" | "terminal-rejected";
		}>
	> => {
		try {
			await commit([vertex]);
			if (retainedPrefixReady(vertex)) return Object.freeze({ kind: "retained-bootstrap-ready" as const });
			const operation = detachedRoomOperation(vertex.operation);
			if (operation !== undefined && Reflect.get(operation, "action") === "migrationActivation") {
				const activation =
					migrationActivationAuthority === undefined
						? undefined
						: migrationActivationOperation(operation, vertex.author, migrationActivationAuthority);
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
			await shutdown().catch(() => undefined);
			throw error;
		}
	};
	try {
		const openedTransport = input.openTransport(input.objectId);
		transport = openedTransport;
		if (input.successorSnapshotDeclaration === undefined) {
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
			const snapshotStore = await createBrowserSnapshotQuarantineStore({
				primaryDatabaseName: input.databaseName,
			});
			creatorCloseStoreClosers.push(snapshotStore.close);
			const selectedPending = openedRoomHeadState.pending;
			if (selectedPending !== null) {
				const pending = Object.freeze({ pending: selectedPending, stable: openedRoomHeadState.stable });
				const recoveredPending = await recoverPendingCreatorSuccessorAdoption({
					authenticationProfile: "creator-only",
					catalog: input.application.catalog,
					detachedSignature: material.detachedGenesisSignature,
					exactCanonicalAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
					exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
					expectedNextRoomHead: selectedPending.next,
					expectedPreviousRoomHead: selectedPending.previous,
					pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
					snapshotDeclaration: input.successorSnapshotDeclaration,
					snapshotStore,
					store: aheStores[0],
				});
				const recoveredHead = captureRoomHead(recoveredPending.head);
				if (
					recoveredPending.ok !== true ||
					recoveredHead === undefined ||
					!sameRoomHead(recoveredHead, selectedPending.next)
				) {
					const kind = Reflect.get(recoveredPending, "kind");
					return roomHeadFailure(
						kind === "true-fork" || kind === "chain-invalid" || kind === "stale-head" || kind === "malformed-input"
							? "D110C_FLOOR_PENDING_INVALID"
							: "D110C_FLOOR_RECOVERY_UNAVAILABLE"
					);
				}
				openedRoomHeadState = await commitRoomHeadAdvance(roomHeadAuthority, roomHeadScope, pending);
			}
			const expectedRoomHead = openedRoomHeadState.stable;
			const reopened = await reopenCreatorSuccessorAdoption({
				authenticationProfile: "creator-only",
				author: input.author,
				catalog: input.application.catalog,
				detachedSignature: material.detachedGenesisSignature,
				exactCanonicalAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
				exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
				expectedRoomHead,
				issuanceStore,
				liveJournalStore: journalStore,
				messageQueueManager,
				networkNode: openedTransport.networkNode,
				onAdmittedVertex: admittedSink as unknown as V3AdmittedVertexSink,
				pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
				signRegisteredVertexDigest: input.signRegisteredVertexDigest,
				snapshotDeclaration: input.successorSnapshotDeclaration,
				snapshotStore,
				store: aheStores[0],
			});
			if (reopened.ok !== true) {
				throw new TypeError(`v3 room successor reopen failed: ${String(reopened.kind)}: ${String(reopened.detail)}`);
			}
			activeHandle = reopened.handle as RoomPlaneHandle;
			successorProjectionAuthority = successorAuthority(reopened.trust, activeHandle);
		}
		if (input.creatorFinalitySigner !== undefined && input.successorSnapshotDeclaration === undefined) {
			if (input.application.migration === undefined) {
				throw new TypeError("v3 room creator close initial state is unavailable");
			}
			const initialProjection = input.application.projectAcceptedOperations(Object.freeze([]));
			const exactCanonicalInitialStateBytes = normalizeApplicationStateBytes(
				Reflect.apply(input.application.migration.canonicalStateBytes, input.application.migration, [
					initialProjection,
				]) as Uint8Array,
				"genesis"
			);
			const blueprint = bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes, plane: activeHandle });
			if (!blueprint.ok) throw new TypeError(`v3 room creator-close blueprint binding failed: ${blueprint.kind}`);
		}
		openedTransport.setIngressHandler(
			activeHandle.topic,
			(message) => {
				routeV3Ingress(openedTransport.networkNode, message);
			},
			(message) => {
				if (activeHandle !== undefined) routeV3RetainedIngress(activeHandle, message);
			}
		);
		openedTransport.setRetainedPublisher(async (targetPeerId) => {
			if (terminalFailure !== undefined) throw terminalFailure;
			if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
			const result =
				targetPeerId === undefined
					? await activeHandle.republishRetained()
					: await republishV3RetainedTo(activeHandle, targetPeerId);
			if (!result.ok) throw new TypeError(`v3 room retained publication failed: ${result.kind}`);
		});
		if (input.creatorFinalitySigner !== undefined && input.successorSnapshotDeclaration === undefined) {
			const creatorFinalitySigner = input.creatorFinalitySigner;
			const voteStore = await openBrowserSealVoteStore({ databaseName: input.databaseName });
			creatorCloseStoreClosers.push(voteStore.close);
			const evidenceStore = await openBrowserSealEvidenceStore({ databaseName: input.databaseName });
			creatorCloseStoreClosers.push(evidenceStore.close);
			const snapshotStore = await createBrowserSnapshotQuarantineStore({
				primaryDatabaseName: input.databaseName,
			});
			creatorCloseStoreClosers.push(snapshotStore.close);
			if (voteStore.observation.incarnation !== evidenceStore.observation.incarnation) {
				throw new TypeError("v3 room creator-close storage incarnation differs");
			}
			bindCurrentCreatorClose = (plane): ReturnType<typeof bindCreatorLiveClose> =>
				bindCreatorLiveClose({
					evidenceStore: evidenceStore.store,
					exactCanonicalAvailabilityPolicyBytes: CREATOR_LOCAL_AVAILABILITY_POLICY_BYTES,
					onObservation: () => undefined,
					plane,
					signer: creatorFinalitySigner,
					snapshotStore,
					storageIncarnation: voteStore.observation.incarnation,
					voteStore: voteStore.store,
				});
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
		group?: string;
		logicalTime: number;
		operation: Readonly<Record<string, unknown>>;
		reject(reason: unknown): void;
		resolve(): void;
	}>;
	let pendingIssues: PendingIssue[] = [];
	let drainScheduled = false;
	let draining = false;
	let drainPromise: Promise<void> = Promise.resolve();
	let migrationBarrier: Promise<void> | undefined;
	let migrationCompletionBarrier: Promise<void> | undefined;
	let migrationAcceptingFollowers = false;
	let migrationRehearsalReserved = false;
	let lifetimeTransitionTail: Promise<void> = Promise.resolve();
	type LifetimeDispatchResult<Result> = Readonly<{ readonly result: Result | Promise<Result> }>;
	const enqueueLifetimeTransition = <Result>(transition: () => Promise<Result>): Promise<Result> => {
		const selected = lifetimeTransitionTail.then(transition);
		lifetimeTransitionTail = selected.then(
			() => undefined,
			() => undefined
		);
		return selected;
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
	const rejectOwned = (owned: readonly PendingIssue[], reason: unknown): void => {
		for (const request of owned) request.reject(reason);
	};
	const issueOwned = async (owned: readonly PendingIssue[]): Promise<void> => {
		if (owned.length === 0) return;
		if (activeHandle === undefined) {
			rejectOwned(owned, new TypeError("v3 room live plane is unavailable"));
			return;
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
			owned[0]?.reject(new TypeError(`v3 room issue failed: ${issued.kind}`));
			await issueOwned(owned.slice(1));
			return;
		}
		if (!issued.ok) {
			rejectOwned(owned, new TypeError(`v3 room issue failed: ${issued.kind}`));
			return;
		}
		if (terminalFailure !== undefined) {
			rejectOwned(owned, terminalFailure);
			return;
		}
		if (acceptedOperationRows.get(issued.digest) === null) {
			rejectOwned(owned, new TypeError("v3 room issued operation was not accepted by projection"));
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
	}>;
	const drainRebaseOutbox = async (): Promise<void> => {
		if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
		const sources: DisplacedSource[] = [];
		for (;;) {
			const page = await activeHandle.readRebaseOutbox();
			if (!page.ok) throw new TypeError(`v3 room rebase outbox failed: ${page.kind}`);
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
			if (page.source.intents.length === 0 && page.source.publishState !== "published") {
				const completed = await activeHandle.completeRebaseSource({
					authorSequence: page.source.authorSequence,
					digest: page.source.vertexDigest,
				});
				if (!completed.ok) throw new TypeError(`v3 room rebase completion failed: ${completed.kind}`);
			}
		}
		const acceptedRows = acceptedIdentityRows();
		const migrationImportRows = migrationImportIdentityRows();
		if (redirectSource === undefined) {
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
	const rebasePromise =
		sourceMaterial === undefined
			? Promise.resolve()
			: Promise.resolve().then(async () => {
					await waitForRetainedBootstrap();
					if (terminalFailure !== undefined) throw terminalFailure;
					await publishAccepted();
					await drainRebaseOutbox();
				});
	void rebasePromise.catch((error: unknown) => {
		terminalFailure = error;
	});
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
			const firstProjection = normalizeProjection(
				Reflect.apply(prepareMigration, migration, [firstSnapshot]) as V3RoomMigrationProjection
			);
			const secondProjection = normalizeProjection(
				Reflect.apply(prepareMigration, migration, [acceptedOperationSnapshot()]) as V3RoomMigrationProjection
			);
			if (!sameBytes(encodeCanonical(firstProjection), encodeCanonical(secondProjection))) {
				throw new TypeError("v3 room migration projection is unstable");
			}
			const exactSourceState = normalizeApplicationStateBytes(
				Reflect.apply(canonicalStateBytes, migration, [projection]) as Uint8Array,
				"migration"
			);
			if (!sameBytes(exactSourceState, firstProjection.exactCanonicalApplicationStateBytes)) {
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
				const openedTarget = await createV3RoomSessionOwned(targetInput, true, undefined, true);
				target = openedTarget;
				const bootstrapAcceptedCount = targetAccepted.length;
				if (bootstrapAcceptedCount < 1) throw new TypeError("v3 room migration target bootstrap was not accepted");
				const importPromises = firstProjection.importOperations.map((operation) => openedTarget.issue(operation));
				await Promise.all(importPromises);
				const targetProjection = openedTarget.projection();
				const acceptedImportOperations = targetAccepted.slice(bootstrapAcceptedCount).map(({ operation }) => operation);
				if (!sameBytes(encodeCanonical(acceptedImportOperations), encodeCanonical(firstProjection.importOperations))) {
					throw new TypeError("v3 room migration target projection differs");
				}
				const exactTargetState = normalizeApplicationStateBytes(
					Reflect.apply(canonicalStateBytes, migration, [targetProjection]) as Uint8Array,
					"migration"
				);
				if (!sameBytes(exactTargetState, firstProjection.exactCanonicalApplicationStateBytes)) {
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
					exactCanonicalApplicationStateBytes: firstProjection.exactCanonicalApplicationStateBytes,
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
					version: 1,
				});
				if (exactCanonicalRecordBytes.byteLength > 49_152) {
					throw new TypeError("v3 room migration record is unbounded");
				}
				const record = decodeCanonical(exactCanonicalRecordBytes) as Readonly<Record<string, unknown>>;
				const recordOperation = Object.freeze({ action: "migrationRecord", record });
				if (!validMigrationRecordOperation(recordOperation, input.author, targetRecordAuthority)) {
					throw new TypeError("v3 room migration record is invalid");
				}
				await openedTarget.issue(recordOperation);
				if (recordVertexDigest === undefined) throw new TypeError("v3 room migration record was not accepted");
				openedTarget.projection();
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
					true
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
		if (terminalFailure !== undefined) throw terminalFailure;
		if (closed) throw new TypeError("v3 room session is closed");
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
		const record = exactRecord(decodedRecord, MIGRATION_RECORD_KEYS);
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
				true
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
		const recordedState = normalizeApplicationStateBytes(record.exactCanonicalApplicationStateBytes, "migration");
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
		try {
			published = await transition.capability.publishTerminal({
				operations: Object.freeze([Object.freeze({ logicalTime: selectedLogicalTime, operation })]),
				signRegisteredVertexDigest: input.signRegisteredVertexDigest,
			});
		} catch (error) {
			terminalFailure = error;
			throw error;
		}
		if (!published.ok) {
			const failure = new TypeError(`v3 room migration activation failed: ${published.kind}`);
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
		} catch (error) {
			await shutdown().catch(() => undefined);
			throw error;
		}
	}
	const assertSessionOpen = (): void => {
		if (closed) throw new TypeError("v3 room session is closed");
	};
	const performCreatorSuccessorAdoption = async (): Promise<void> => {
		if (terminalFailure !== undefined) throw terminalFailure;
		if (creatorCloseHandle === undefined) throw new TypeError("creator close authority is unavailable");
		if (activeHandle === undefined || transport === undefined) {
			throw new TypeError("v3 room live plane is unavailable");
		}
		const closeStatus = creatorCloseHandle.status();
		if (successorProjectionAuthority !== null && closeStatus.lifecycle === "active") {
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
		if (closeStatus.lifecycle !== "successor-pending-adoption") {
			throw new TypeError("D110C_B_ACTIVATION_STALLED");
		}
		const predecessorClose = creatorCloseHandle;
		const verified = await verifyCreatorSuccessorAdoption({
			catalog: input.application.catalog,
			handle: predecessorClose,
		});
		if (!verified.ok) throw new TypeError(`v3 room successor verification failed: ${verified.kind}`);
		if (roomHeadAuthority === undefined || openedRoomHeadState === undefined) {
			return roomHeadFailure("D110C_FLOOR_MIGRATION_REQUIRED");
		}
		assertSessionOpen();
		const staged = await stageCreatorSuccessorAdoption({
			handle: predecessorClose,
			intent: verified.intent,
		});
		if (!staged.ok) throw new TypeError(`v3 room successor stage failed: ${String(staged.kind)}`);
		const nextRoomHead = expectedRoomHeadFromDescriptor(staged.descriptor as Readonly<Record<string, unknown>>);
		const pendingRoomHead = await beginRoomHeadAdvance(
			roomHeadAuthority,
			roomHeadScope,
			openedRoomHeadState.stable,
			nextRoomHead
		);
		assertSessionOpen();
		const published = await publishStagedCreatorSuccessorAdoption({
			capability: staged.capability,
			handle: predecessorClose,
		});
		if (!published.ok) throw new TypeError(`v3 room successor publication failed: ${String(published.kind)}`);
		openedRoomHeadState = await commitRoomHeadAdvance(roomHeadAuthority, roomHeadScope, pendingRoomHead);
		if (openedRoomHeadState.pending !== null || !sameRoomHead(openedRoomHeadState.stable, nextRoomHead)) {
			return roomHeadFailure("D110C_FLOOR_MISMATCH");
		}
		assertSessionOpen();
		const activated = await activateCreatorSuccessorAdoption({
			capability: published.capability,
			expectedRoomHead: openedRoomHeadState.stable,
			handle: predecessorClose,
			messageQueueManager,
			networkNode: transport.networkNode,
			onAdmittedVertex: admittedSink as unknown as V3AdmittedVertexSink,
		});
		if (activated.ok !== true) {
			const failure = new TypeError("D110C_B_ACTIVATION_STALLED");
			terminalFailure = failure;
			creatorCloseHandle = undefined;
			creatorCloseUnavailableContinuity = "stalled";
			const stale = activeHandle;
			activeHandle = undefined;
			await Promise.allSettled([predecessorClose.stop(), Promise.resolve().then(() => stale.deactivate())]);
			throw failure;
		}
		const replacement = activated.handle as RoomPlaneHandle;
		let replacementOwned = true;
		const releaseReplacement = async (): Promise<void> => {
			if (!replacementOwned) return;
			await Promise.resolve(replacement.deactivate());
			replacementOwned = false;
		};
		const throwAfterReplacementCleanup = async (primary: unknown): Promise<never> => {
			try {
				await releaseReplacement();
			} catch (cleanup) {
				throw combineFailures(primary, cleanup);
			}
			throw primary;
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
		if (bindCurrentCreatorClose === undefined) {
			activeHandle = replacement;
			replacementOwned = false;
			successorProjectionAuthority = authority;
			creatorCloseHandle = undefined;
			creatorCloseUnavailableContinuity = "stalled";
			terminalFailure = new TypeError("D110C_B_CLOSE_REBIND_FAILED");
			throw terminalFailure;
		}
		const rebound = await bindCurrentCreatorClose(replacement);
		if (!rebound.ok) {
			activeHandle = replacement;
			replacementOwned = false;
			successorProjectionAuthority = authority;
			creatorCloseHandle = undefined;
			creatorCloseUnavailableContinuity = "stalled";
			terminalFailure = new TypeError("D110C_B_CLOSE_REBIND_FAILED");
			throw terminalFailure;
		}
		activeHandle = replacement;
		replacementOwned = false;
		successorProjectionAuthority = authority;
		creatorCloseHandle = rebound.handle;
		creatorCloseUnavailableContinuity = "continuous";
		await predecessorClose.stop();
	};
	const adoptCreatorSuccessor = (): Promise<void> => {
		if (creatorSuccessorAdoptionTask !== undefined) return creatorSuccessorAdoptionTask;
		const attempt = enqueueLifetimeTransition(async () => {
			if (redirectPromise !== undefined) await redirectPromise;
			assertSessionOpen();
			if (redirectedSession !== undefined) {
				return redirectedSession.adoptCreatorSuccessor();
			}
			return performCreatorSuccessorAdoption();
		});
		const shared = attempt.finally(() => {
			if (creatorSuccessorAdoptionTask === shared) creatorSuccessorAdoptionTask = undefined;
		});
		creatorSuccessorAdoptionTask = shared;
		return shared;
	};
	const closeSession = (): Promise<void> => {
		if (sessionCloseTask !== undefined) return sessionCloseTask;
		closed = true;
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
	return Object.freeze({
		activateMigration,
		adoptCreatorSuccessor(): Promise<void> {
			return adoptCreatorSuccessor();
		},
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
			return closeSession();
		},
		async inspectDurableHead(): ReturnType<CreatorLiveCloseHandle["inspectDurableHead"]> {
			if (redirectPromise !== undefined) await redirectPromise;
			if (redirectedSession !== undefined) return redirectedSession.inspectDurableHead();
			if (creatorCloseHandle === undefined) throw new TypeError("creator close authority is unavailable");
			return creatorCloseHandle.inspectDurableHead();
		},
		async issue(operation: Readonly<Record<string, unknown>>): Promise<void> {
			if (redirectPromise !== undefined) await redirectPromise;
			if (redirectedSession !== undefined) {
				if (recoveredActivation !== undefined) return redirectedSession.issue(operation);
				throw new TypeError("v3 room terminal source cannot issue operations");
			}
			if (terminalFailure !== undefined) throw terminalFailure;
			if (closed) throw new TypeError("v3 room session is closed");
			const captured = detachedRoomOperation(operation);
			if (captured === undefined) throw new TypeError("v3 room operation is invalid");
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
				await (joinsMigration ? priorMigrationBarrier : priorMigrationCompletion);
				if (terminalFailure !== undefined) throw terminalFailure;
				if (closed) throw new TypeError("v3 room session is closed");
				const current = logicalTime;
				logicalTime += 2;
				const promise = new Promise<void>((resolve, reject) => {
					pendingIssues.push(Object.freeze({ logicalTime: current, operation: captured, reject, resolve }));
				});
				scheduleDrain();
				await promise;
				settleFollower?.(Object.freeze({ ok: true }));
			} catch (error) {
				settleFollower?.(Object.freeze({ ok: false, reason: error }));
				throw error;
			}
		},
		openEphemeral(options: EphemeralChannelOptions): EphemeralChannel {
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
		async sealEpoch(): Promise<CreatorLiveCloseResult> {
			if (redirectPromise !== undefined) await redirectPromise;
			if (redirectedSession !== undefined) return redirectedSession.sealEpoch();
			if (terminalFailure !== undefined) throw terminalFailure;
			if (closed) throw new TypeError("v3 room session is closed");
			if (creatorCloseHandle === undefined) throw new TypeError("creator close authority is unavailable");
			await rebasePromise;
			await migrationCompletionBarrier;
			await drainPendingIssues();
			return creatorCloseHandle.close();
		},
		status(): CreatorLiveCloseStatus {
			if (redirectedSession !== undefined) return redirectedSession.status();
			return (
				creatorCloseHandle?.status() ??
				unavailableCreatorCloseStatus(roomDescriptor.trustProfile, creatorCloseUnavailableContinuity)
			);
		},
	});
}

async function prepareDurableRoomState<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>,
	material: V3RoomCreatorInviteMaterial,
	sourceMaterial: V3RoomCreatorInviteMaterial | undefined,
	objectId: StorageObjectId,
	requireFreshTrust = false,
	classifyTerminalVertex?: RoomTerminalVertexClassifier,
	redirectSource?: RedirectSourceRecovery,
	redirectHistoryComplete?: (vertices: readonly V3RoomAcceptedVertex[]) => boolean
): Promise<
	Readonly<{
		readonly aheStores: readonly Awaited<ReturnType<typeof createBrowserAheDurableStore>>[];
		readonly issuanceStore: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>>;
		readonly journalStore: Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>>;
		readonly prepared: Extract<Awaited<ReturnType<typeof prepareV3LiveGeneration>>, { readonly ok: true }>;
		readonly recovered: Extract<Awaited<ReturnType<typeof recoverV3LiveReplica>>, { readonly ok: true }>;
		readonly retainedBootstrapHeld: boolean;
	}>
> {
	const aheStore = await createBrowserAheDurableStore({ databaseName: `${input.databaseName}--ahe` });
	const aheStores = [aheStore];
	let issuanceStore: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>> | undefined;
	let journalStore: Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>> | undefined;
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
			store: Awaited<ReturnType<typeof createBrowserAheDurableStore>>,
			fresh = false,
			selectedObjectId: StorageObjectId = objectId
		): Promise<Extract<Awaited<ReturnType<typeof prepareV3LiveGeneration>>, { readonly ok: true }>> => {
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
			if (!openedTrust.ok || openedTrust.trust.profileId !== "creator-trusted-v1") {
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
			});
			if (!prepared.ok) throw new TypeError(`v3 room preparation failed: ${prepared.kind}`);
			return prepared;
		};
		let prepared = await prepareMaterial(material, aheStore, requireFreshTrust);
		let sourceAheStore: Awaited<ReturnType<typeof createBrowserAheDurableStore>> | undefined;
		let sourcePrepared: Extract<Awaited<ReturnType<typeof prepareV3LiveGeneration>>, { readonly ok: true }> | undefined;
		if (sourceMaterial !== undefined) {
			sourceAheStore = await createBrowserAheDurableStore({
				databaseName: `${input.databaseName}--rebase-${sourceMaterial.pinnedGenesisAnchorDigest}--ahe`,
			});
			aheStores.push(sourceAheStore);
			sourcePrepared = await prepareMaterial(
				sourceMaterial,
				sourceAheStore,
				false,
				redirectSourceObjectId?.ok === true ? redirectSourceObjectId.value : objectId
			);
		}
		const openedIssuanceStore = await createBrowserDurableIssuanceStore({
			primaryDatabaseName: input.issuanceDatabaseName,
		});
		issuanceStore = openedIssuanceStore;
		const openedJournalStore = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: input.databaseName });
		journalStore = openedJournalStore;
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
				capability: prepared.capability,
				...(classifyTerminalVertex === undefined ? {} : { classifyTerminalVertex }),
				...(sourcePrepared === undefined || sourceMaterial === undefined
					? {}
					: {
							displacedSource: Object.freeze({
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
								exactCanonicalLatchedAclBytes: sourceMaterial.exactCanonicalLatchedAclBytes,
							}),
						}),
				exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
				issuanceScope: scope,
				issuanceStore: openedIssuanceStore,
				liveJournalStore: openedJournalStore,
				...(input.createOperationAdmissionPolicy === undefined
					? {}
					: {
							operationAdmissionPolicy: input.createOperationAdmissionPolicy(
								Object.freeze({
									aclDigest: digest("ts-drp/latched-acl/v3", material.exactCanonicalLatchedAclBytes),
									anchorDigest: material.pinnedGenesisAnchorDigest,
									epoch: 0 as const,
									objectId: input.objectId,
								})
							),
						}),
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
						openedIssuanceStore.transactIssue(selectedScope, buildAndSign),
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
			prepared,
			recovered,
			retainedBootstrapHeld,
		});
	} catch (error) {
		const closers: Promise<void>[] = aheStores.map((store) => store.close());
		if (issuanceStore !== undefined) closers.push(issuanceStore.close());
		if (journalStore !== undefined) closers.push(journalStore.close());
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
