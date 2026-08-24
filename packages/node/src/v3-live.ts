import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { CausalityIndex, type EpochVertex } from "@ts-drp/compaction";
import {
	BlueprintStateMachine,
	type BlueprintStateSnapshot,
	foldBlueprintEpoch,
} from "@ts-drp/compaction/blueprint-fold";
import { assertTrustPreserved, createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import type { DurableIssuanceOutboxRecord, DurableIssuanceStore, DurableIssueScope } from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore, LiveJournalScope } from "@ts-drp/live-journal";
import type { MessageQueueManager } from "@ts-drp/message-queue";
import {
	type AdmitReceivedVertexInput,
	type AdmittedReceivedVertexView,
	authenticateCurrentEpochAnchor,
	createAdmissionBoundTransactionalVertexIssuer,
	type CurrentAnchorTrust,
	extractAdmittedReceivedVertex,
	type ExtractAdmittedReceivedVertexFailureReason,
	prepareBlueprintAdmission,
	prepareBlueprintRuntime,
	type PreparedBlueprintAdmission,
	type PreparedBlueprintRuntime,
	type SignRegisteredVertexDigest,
} from "@ts-drp/protocol-v3";
import {
	type CurrentEpochAuthorAuthorization,
	openCurrentEpochAuthorAuthorization,
	resolveCurrentEpochAuthorizedAuthor,
} from "@ts-drp/protocol-v3/author-authorization";
import {
	authorizeLatchedApplicationWrite,
	authorizeLatchedEnvelopeAuthor,
	deriveNextLatchedSignerSet,
	type LatchedAclOperation,
	type LatchedAclSnapshot,
	openCanonicalLatchedAclSnapshot,
	stageLatchedAclOperations,
} from "@ts-drp/protocol-v3/latched-acl";
import parameterRegistry from "@ts-drp/protocol-v3/registry/registry-v1.json" with { type: "json" };
import {
	type AheDurableStore,
	type BlobDigest,
	digestBlob,
	digestClosure,
	type ExpectedHead,
	type GenerationId,
	type GenerationRef,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type PresentHead,
	type StorageObjectId,
} from "@ts-drp/storage";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";

import { classifyV3EnvelopeScope } from "./v3-envelope-scope.js";

const ArrayIsArray = Array.isArray;
const ArrayPrototype = Array.prototype;
const FunctionHasInstance = Function.prototype[Symbol.hasInstance];
const NumberIsSafeInteger = Number.isSafeInteger;
const ObjectCreate = Object.create;
const ObjectDefineProperty = Object.defineProperty;
const ObjectFreeze = Object.freeze;
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const RegExpTest = RegExp.prototype.test;
const ObjectPrototype = Object.prototype;
const SharedArrayBufferConstructor = globalThis.SharedArrayBuffer;
const StringConstructor = String;
const Uint8ArrayConstructor = Uint8Array;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const IntrinsicMap = Map;
const MapPrototype = Map.prototype;
const MapPrototypeEntries = Map.prototype.entries;
const MapPrototypeGet = Map.prototype.get;
const MapPrototypeHas = Map.prototype.has;
const MapPrototypeKeys = Map.prototype.keys;
const MapPrototypeSet = Map.prototype.set;
const MapSizeGetter = ObjectGetOwnPropertyDescriptor(Map.prototype, "size")?.get;
const MapIteratorPrototype = ObjectGetPrototypeOf(ReflectApply(MapPrototypeEntries, new IntrinsicMap(), []));
const MapIteratorNext = ObjectGetOwnPropertyDescriptor(MapIteratorPrototype, "next")?.value;
const IntrinsicSet = Set;
const SetPrototypeAdd = Set.prototype.add;
const SetPrototypeHas = Set.prototype.has;
const DRP_ERROR_BRAND = Symbol.for("@ts-drp/errors/DRPError");
const TypedArrayPrototype = ObjectGetPrototypeOf(Uint8Array.prototype) as object;
const TypedArrayBufferGetter = ObjectGetOwnPropertyDescriptor(TypedArrayPrototype, "buffer")?.get;
const TypedArrayByteLengthGetter = ObjectGetOwnPropertyDescriptor(TypedArrayPrototype, "byteLength")?.get;
const CryptoGetRandomValues = globalThis.crypto.getRandomValues;
const ConsoleObject = globalThis.console;
const ConsoleWarn = ConsoleObject?.warn;
const TextEncoderConstructor = TextEncoder;

const INPUT_KEYS = [
	"authenticationProfile",
	"store",
	"objectId",
	"pinnedGenesisAnchorDigest",
	"exactCanonicalAnchorPreimageBytes",
	"detachedSignature",
	"exactCanonicalParametersCarrierBytes",
	"catalog",
] as const;
const CATALOG_RESULT_KEYS = [
	"artifactDigest",
	"artifactId",
	"blueprintDigest",
	"canonicalBlueprintPackageBytes",
	"exactArtifactBytes",
	"runtimeProfile",
	"evidence",
] as const;
const CATALOG_EVIDENCE_KEYS = [
	"catalogDigest",
	"lintEvidenceDigest",
	"conformanceReceiptDigest",
	"conformanceDigest",
	"conformanceTier",
	"conformanceResult",
	"engines",
] as const;
const CATALOG_ENGINE_KEYS = ["name", "build"] as const;
const CATALOG_ENGINE_NAMES = ["node", "chromium", "firefox", "webkit"] as const;
const OPEN_RESULT_KEYS = ["head", "ok", "trust", "trustRef"] as const;
const PRESENT_HEAD_KEYS = ["closureDigest", "generationId", "kind", "objectId", "revision"] as const;
const TRUST_KEYS = ["currentAnchorDigest", "currentEpoch", "genesisAnchorDigest", "objectId", "profileId"] as const;
const TRUST_REF_KEYS = ["byteLength", "digest"] as const;
const AUTHENTICATION_RESULT_KEYS = ["ok", "provenance"] as const;
const ACTIVE_RECOVERY_KEYS = ["adoptedGeneration", "head", "kind", "recomputedClosureDigest", "references"] as const;
const GENERATION_RECORD_KEYS = [
	"baseExpectedHead",
	"closure",
	"closureDigest",
	"generationId",
	"objectId",
	"state",
] as const;
const PROVENANCE_KEYS = [
	"anchorDigest",
	"blueprintDigest",
	"epoch",
	"objectId",
	"parametersDigest",
	"profileDigest",
	"signerSetDigest",
] as const;
const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const SUPPORTED_PARAMETER_PROFILE = ObjectFreeze({
	parametersDigest: "cd31923f2f1928daab3a6943fa361f7cf40516ba3c4929abbd3109ee65cdc669",
	runtimeProfile: "ecmascript-2024-sync-v1" as const,
});
const ACTIVATION_INPUT_KEYS = ["capability", "messageQueueManager", "networkNode", "onAdmittedVertex"] as const;
const BLUEPRINT_BINDING_INPUT_KEYS = ["exactCanonicalInitialStateBytes", "plane"] as const;
const LOCAL_ISSUE_INPUT_KEYS = ["operations", "signRegisteredVertexDigest"] as const;
const LOCAL_ISSUE_ENTRY_KEYS = ["logicalTime", "operation"] as const;
const CANONICAL_APPLICATION_BATCH_ENTRY_KEYS = ["operation", "logicalTime"] as const;
const APPLICATION_BATCH_KEYS = ["batch", "action"] as const;
const APPLICATION_BATCH_PAYLOAD_KEYS = ["entries", "version"] as const;
const APPLICATION_BATCH_ACTION = "applicationBatch";
const APPLICATION_BATCH_MAX_ENTRIES = 16;
const APPLICATION_BATCH_LIMITS = ObjectFreeze({ maxBytes: 65_536, maxDepth: 8, maxItems: 1_024 });
const RESERVED_BATCH_ACTIONS = ObjectFreeze(["acl", APPLICATION_BATCH_ACTION, "causalJoin", "join"] as const);
const ISSUANCE_SCOPE_KEYS = ["objectId", "author"] as const;
const OUTBOX_RECORD_KEYS = ["commit", "publishState"] as const;
const ISSUE_COMMIT_KEYS = ["authorSequence", "envelope", "issuedRecord", "outboxEntry"] as const;
const ISSUED_RECORD_KEYS = ["authorSequence", "envelope", "scope"] as const;
const OUTBOX_ENTRY_KEYS = ["authorSequence", "envelope", "scope"] as const;
const SIGNED_ENVELOPE_KEYS = ["canonicalPreimageBytes", "digest", "signature"] as const;
const JOURNAL_SCOPE_KEYS = ["anchorDigest", "epoch", "objectId"] as const;
const JOURNAL_RECEIVED_ROW_KEYS = [
	"detachedSignature",
	"exactCanonicalPreimageBytes",
	"journalSequence",
	"scope",
	"sourceKind",
	"vertexDigest",
] as const;
const JOURNAL_LOCAL_ROW_KEYS = [
	"author",
	"authorSequence",
	"journalSequence",
	"scope",
	"sourceKind",
	"vertexDigest",
] as const;
const V3_TOPIC_PREFIX = "drp/v3/1/";
const vertexRegistry = parameterRegistry.kinds.vertex;
const V3_VERTEX_DOMAIN = parameterRegistry.domains.vertex;
const V3_VERTEX_SUITE_ID = parameterRegistry.cryptoSuites.active.find(
	(entry: { readonly role: string }) => entry.role === "identityAndVertex"
)?.suiteId;

export interface PrepareV3LiveGenerationInput {
	readonly authenticationProfile: "creator-only";
	readonly store: AheDurableStore;
	readonly objectId: StorageObjectId;
	readonly pinnedGenesisAnchorDigest: string;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly detachedSignature: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly catalog: TrustedBlueprintCatalog;
}

export type PrepareV3LiveFailureKind =
	| "malformed-input"
	| "trust-open-failed"
	| "anchor-authentication-failed"
	| "parameters-rejected"
	| "blueprint-unresolved"
	| "admission-rejected"
	| "runtime-preparation-failed"
	| "graph-rejected"
	| "trust-not-preserved"
	| "stale-head"
	| "storage-failed"
	| "internal-invariant";

export interface V3LiveDescriptor {
	readonly objectId: string;
	readonly epoch: 0;
	readonly anchorDigest: string;
	readonly blueprintDigest: string;
	readonly parametersDigest: string;
	readonly profileDigest: string;
	readonly signerSetDigest: string;
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly catalogDigest: string;
	readonly runtimeProfile: "ecmascript-2024-sync-v1";
	readonly trustProfile: "creator-only";
	readonly trustRef: GenerationRef;
	readonly maxEpochVertices: number;
	readonly maxEpochBytes: number;
	readonly maxDependencies: number;
	readonly vertexCount: 1;
	readonly byteCharge: number;
	readonly projectionDigest: BlobDigest;
	readonly head: PresentHead;
}

declare const preparedV3LiveBrand: unique symbol;
export type PreparedV3Live = Readonly<{ readonly [preparedV3LiveBrand]: true }>;

export type PrepareV3LiveResult =
	| Readonly<{
			readonly ok: true;
			readonly capability: PreparedV3Live;
			readonly descriptor: V3LiveDescriptor;
	  }>
	| Readonly<{
			readonly ok: false;
			readonly kind: PrepareV3LiveFailureKind;
			readonly detail: string;
	  }>;

export interface V3PlaneActivationInput {
	readonly capability: RecoveredV3Live;
	readonly messageQueueManager: MessageQueueManager<Message>;
	readonly networkNode: DRPNetworkNode;
	readonly onAdmittedVertex: V3AdmittedVertexSink;
}

interface V3BlueprintLiveBindingInput {
	readonly exactCanonicalInitialStateBytes: Uint8Array;
	readonly plane: V3PlaneHandle;
}

export type V3AdmittedVertexSink = (
	delivery: Readonly<{
		readonly vertex: AdmittedReceivedVertexView;
		readonly exactReceivedCanonicalPreimageBytes: Uint8Array;
		readonly signature: Uint8Array;
		readonly transportSender: string;
	}>
) => // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- the sink retains legacy void alongside explicit terminal dispositions.
| void
	| Readonly<{ readonly kind: "continue" | "retained-bootstrap-ready" | "terminal-accepted" | "terminal-rejected" }>
	// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- asynchronous legacy sinks resolve void.
	| Promise<void | Readonly<{
			readonly kind: "continue" | "retained-bootstrap-ready" | "terminal-accepted" | "terminal-rejected";
	  }>>;

export interface V3PlaneHandle {
	readonly objectId: string;
	readonly epoch: 0;
	readonly topic: string;
	readonly queueId: string;
	currentEphemeralAuthority():
		| {
				readonly aclDigest: string;
				readonly anchorDigest: string;
				readonly epoch: 0;
				readonly objectId: string;
				isCurrentWriter(author: string): boolean;
		  }
		| undefined;
	issueLocal(input: V3LocalIssueInput): Promise<V3LocalIssueResult>;
	readRebaseOutbox(): Promise<V3RebaseOutboxResult>;
	completeRebaseSource(
		input: Readonly<{ readonly authorSequence: number; readonly digest: string }>
	): Promise<V3EgressResult>;
	publishPending(): Promise<V3EgressResult>;
	republishRetained(): Promise<V3EgressResult>;
	beginTerminalTransition(): Promise<V3TerminalTransitionResult>;
	deactivate(): void;
}

interface V3BlueprintLiveHandle {
	readonly epoch: 0;
	readonly objectId: string;
	blueprintSnapshot(): BlueprintStateSnapshot | undefined;
	stageBlueprintEpoch(): Promise<V3BlueprintFoldResult>;
}

type V3BlueprintFoldResult =
	| Readonly<{
			readonly ok: true;
			readonly kind: "staged";
			readonly order: readonly string[];
			readonly outputs: readonly unknown[];
			readonly staged: BlueprintStateSnapshot;
			adopt(): V3BlueprintAdoptResult;
	  }>
	| Readonly<{
			readonly ok: false;
			readonly kind: "not-active" | "already-folded" | "fold-rejected";
			readonly detail: string;
	  }>;

type V3BlueprintAdoptResult =
	| Readonly<{ readonly ok: true; readonly kind: "adopted"; readonly snapshot: BlueprintStateSnapshot }>
	| Readonly<{
			readonly ok: false;
			readonly kind: "not-active" | "stale-graph" | "already-adopted" | "adopt-rejected";
			readonly detail: string;
	  }>;

export type V3TerminalPublishResult =
	| Readonly<{
			readonly ok: true;
			readonly kind: "accepted";
			readonly authorSequence: number;
			readonly digest: string;
			readonly terminalIntent: "committed";
	  }>
	| Readonly<{
			readonly ok: false;
			readonly kind:
				| "not-active"
				| "malformed-input"
				| "authorization-rejected"
				| "issuance-rejected"
				| "admission-rejected"
				| "journal-rejected"
				| "graph-rejected"
				| "terminal-rejected";
			readonly detail: string;
			readonly terminalIntent: "absent" | "outcome-unknown";
	  }>;

export type V3TerminalTransitionResult =
	| Readonly<{
			readonly ok: true;
			readonly capability: Readonly<{
				publishTerminal(input: V3LocalIssueInput): Promise<V3TerminalPublishResult>;
				resume():
					| Readonly<{ readonly ok: true; readonly kind: "resumed" }>
					| Readonly<{ readonly ok: false; readonly kind: "invalid-state"; readonly detail: string }>;
			}>;
	  }>
	| Readonly<{
			readonly ok: false;
			readonly kind: "not-active" | "transition-active" | "already-terminal";
			readonly detail: string;
	  }>;

export interface V3LocalIssueInput {
	readonly operations: readonly Readonly<{
		readonly logicalTime: number;
		readonly operation: Readonly<Record<string, unknown>>;
	}>[];
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
}

export type V3LocalIssueResult =
	| Readonly<{ readonly ok: true; readonly kind: "accepted"; readonly authorSequence: number; readonly digest: string }>
	| Readonly<{
			readonly ok: false;
			readonly kind: "split-required";
			readonly detail: string;
			readonly prefixLength: number;
	  }>
	| Readonly<{
			readonly ok: false;
			readonly kind:
				| "not-active"
				| "malformed-input"
				| "authorization-rejected"
				| "issuance-rejected"
				| "admission-rejected"
				| "journal-rejected"
				| "graph-rejected";
			readonly detail: string;
	  }>;

export type V3PlaneActivationFailureKind =
	| "malformed-input"
	| "capability-consumed"
	| "not-started"
	| "topic-derivation-failed"
	| "queue-capacity"
	| "subscribe-failed"
	| "internal-invariant";

export type V3PlaneActivationResult =
	| Readonly<{ readonly ok: true; readonly handle: V3PlaneHandle }>
	| Readonly<{ readonly ok: false; readonly kind: V3PlaneActivationFailureKind; readonly detail: string }>;

type V3BlueprintLiveBindingResult =
	| Readonly<{ readonly ok: true; readonly handle: V3BlueprintLiveHandle }>
	| Readonly<{ readonly ok: false; readonly kind: V3PlaneActivationFailureKind; readonly detail: string }>;

export type V3EgressResult =
	| Readonly<{ readonly ok: true; readonly kind: "empty" | "published" }>
	| Readonly<{
			readonly ok: false;
			readonly kind: "not-active" | "store-failed" | "record-rejected" | "publish-failed" | "publication-state-unknown";
			readonly detail: string;
	  }>;

type V3RebaseSource = Readonly<{
	readonly author: string;
	readonly authorSequence: number;
	readonly vertexDigest: string;
	readonly intents: readonly Readonly<{
		readonly logicalTime: number;
		readonly operation: Readonly<Record<string, unknown>>;
		readonly operationCount: number;
		readonly operationIndex: number;
	}>[];
}>;

type V3RebaseOutboxResult =
	| Readonly<{ readonly ok: true; readonly kind: "empty" }>
	| Readonly<{
			readonly ok: true;
			readonly kind: "displaced";
			readonly source: V3RebaseSource & Readonly<{ readonly publishState?: never }>;
	  }>
	| Readonly<{
			readonly ok: true;
			readonly kind: "displaced";
			readonly source: V3RebaseSource & Readonly<{ readonly publishState: "pending" | "published" }>;
	  }>
	| Readonly<{ readonly ok: false; readonly kind: "not-active" | "record-rejected" | "store-failed" }>;

type PlainRecord = Readonly<Record<string, unknown>>;

const LEGACY_RECOVERY_INPUT_KEYS = [
	"capability",
	"exactCanonicalAuthorAuthorizationBytes",
	"issuanceScope",
	"issuanceStore",
	"liveJournalStore",
] as const;
const LEGACY_DISPLACED_RECOVERY_INPUT_KEYS = [
	"capability",
	"displacedSource",
	"exactCanonicalAuthorAuthorizationBytes",
	"issuanceScope",
	"issuanceStore",
	"liveJournalStore",
] as const;
const LATCHED_RECOVERY_INPUT_KEYS = [
	"capability",
	"exactCanonicalLatchedAclBytes",
	"issuanceScope",
	"issuanceStore",
	"liveJournalStore",
] as const;
const LATCHED_DISPLACED_RECOVERY_INPUT_KEYS = [
	"capability",
	"displacedSource",
	"exactCanonicalLatchedAclBytes",
	"issuanceScope",
	"issuanceStore",
	"liveJournalStore",
] as const;
const LATCHED_TERMINAL_RECOVERY_INPUT_KEYS = [
	"capability",
	"classifyTerminalVertex",
	"exactCanonicalLatchedAclBytes",
	"issuanceScope",
	"issuanceStore",
	"liveJournalStore",
] as const;
const LATCHED_CROSS_OBJECT_RECOVERY_INPUT_KEYS = [
	"capability",
	"classifyTerminalVertex",
	"displacedSource",
	"exactCanonicalLatchedAclBytes",
	"issuanceScope",
	"issuanceStore",
	"liveJournalStore",
] as const;
const LATCHED_RETAINED_BOOTSTRAP_RECOVERY_INPUT_KEYS = [
	"capability",
	"classifyTerminalVertex",
	"displacedSource",
	"exactCanonicalLatchedAclBytes",
	"issuanceScope",
	"issuanceStore",
	"liveJournalStore",
	"retainedBootstrapHold",
] as const;
const DISPLACED_LEGACY_SOURCE_KEYS = ["capability", "exactCanonicalAuthorAuthorizationBytes"] as const;
const DISPLACED_LATCHED_SOURCE_KEYS = ["capability", "exactCanonicalLatchedAclBytes"] as const;
const DISPLACED_CROSS_OBJECT_SOURCE_KEYS = [
	"activationVertexDigest",
	"capability",
	"exactCanonicalLatchedAclBytes",
	"issuanceScope",
	"issuanceStore",
	"liveJournalStore",
] as const;

export type V3TerminalVertexClassifier = (
	input: Readonly<{
		readonly author: string;
		readonly exactReceivedCanonicalPreimageBytes: Uint8Array;
		readonly signature: Uint8Array;
		readonly vertex: AdmittedReceivedVertexView;
	}>
) => "ordinary" | "terminal-authorized" | "reject";

declare const recoveredV3LiveBrand: unique symbol;
export type RecoveredV3Live = Readonly<{ readonly [recoveredV3LiveBrand]: true }>;

export type RecoverV3LiveReplicaInput =
	| Readonly<{
			readonly capability: PreparedV3Live;
			readonly displacedSource?: Readonly<{
				readonly capability: PreparedV3Live;
				readonly exactCanonicalAuthorAuthorizationBytes: Uint8Array;
			}>;
			readonly exactCanonicalAuthorAuthorizationBytes: Uint8Array;
			readonly issuanceScope: DurableIssueScope;
			readonly issuanceStore: DurableIssuanceStore;
			readonly liveJournalStore: DurableLiveJournalStore;
	  }>
	| Readonly<{
			readonly capability: PreparedV3Live;
			readonly exactCanonicalLatchedAclBytes: Uint8Array;
			readonly issuanceScope: DurableIssueScope;
			readonly issuanceStore: DurableIssuanceStore;
			readonly liveJournalStore: DurableLiveJournalStore;
	  }>
	| Readonly<{
			readonly capability: PreparedV3Live;
			readonly displacedSource: Readonly<{
				readonly capability: PreparedV3Live;
				readonly exactCanonicalLatchedAclBytes: Uint8Array;
			}>;
			readonly exactCanonicalLatchedAclBytes: Uint8Array;
			readonly issuanceScope: DurableIssueScope;
			readonly issuanceStore: DurableIssuanceStore;
			readonly liveJournalStore: DurableLiveJournalStore;
	  }>
	| Readonly<{
			readonly capability: PreparedV3Live;
			readonly classifyTerminalVertex: V3TerminalVertexClassifier;
			readonly exactCanonicalLatchedAclBytes: Uint8Array;
			readonly issuanceScope: DurableIssueScope;
			readonly issuanceStore: DurableIssuanceStore;
			readonly liveJournalStore: DurableLiveJournalStore;
	  }>
	| Readonly<{
			readonly capability: PreparedV3Live;
			readonly classifyTerminalVertex: V3TerminalVertexClassifier;
			readonly displacedSource: Readonly<{
				readonly activationVertexDigest: string;
				readonly capability: PreparedV3Live;
				readonly exactCanonicalLatchedAclBytes: Uint8Array;
				readonly issuanceScope: DurableIssueScope;
				readonly issuanceStore: DurableIssuanceStore;
				readonly liveJournalStore: DurableLiveJournalStore;
			}>;
			readonly exactCanonicalLatchedAclBytes: Uint8Array;
			readonly issuanceScope: DurableIssueScope;
			readonly issuanceStore: DurableIssuanceStore;
			readonly liveJournalStore: DurableLiveJournalStore;
	  }>
	| Readonly<{
			readonly capability: PreparedV3Live;
			readonly classifyTerminalVertex: V3TerminalVertexClassifier;
			readonly displacedSource: Readonly<{
				readonly activationVertexDigest: string;
				readonly capability: PreparedV3Live;
				readonly exactCanonicalLatchedAclBytes: Uint8Array;
				readonly issuanceScope: DurableIssueScope;
				readonly issuanceStore: DurableIssuanceStore;
				readonly liveJournalStore: DurableLiveJournalStore;
			}>;
			readonly exactCanonicalLatchedAclBytes: Uint8Array;
			readonly issuanceScope: DurableIssueScope;
			readonly issuanceStore: DurableIssuanceStore;
			readonly liveJournalStore: DurableLiveJournalStore;
			readonly retainedBootstrapHold: true;
	  }>;

export type RecoverV3LiveReplicaFailureKind =
	| "malformed-input"
	| "capability-consumed"
	| "authorization-rejected"
	| "journal-rejected"
	| "issuance-rejected"
	| "admission-rejected"
	| "graph-rejected"
	| "internal-invariant";

export type RecoverV3LiveReplicaResult =
	| Readonly<{
			readonly ok: true;
			readonly capability: RecoveredV3Live;
			readonly descriptor: Readonly<{
				readonly objectId: string;
				readonly recoveredVertices: readonly AdmittedReceivedVertexView[];
				readonly recoveredVertexCount: number;
				readonly transcript: readonly ["authorized", "issued-record-authenticated", "journaled", "indexed", "ready"];
			}>;
	  }>
	| Readonly<{ readonly ok: false; readonly kind: RecoverV3LiveReplicaFailureKind; readonly detail: string }>;

interface CapturedInput {
	readonly authenticationProfile: "creator-only";
	readonly store: AheDurableStore;
	readonly objectId: StorageObjectId;
	readonly pinnedGenesisAnchorDigest: string;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly detachedSignature: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly catalog: TrustedBlueprintCatalog;
}

interface CatalogSnapshot {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly exactArtifactBytes: Uint8Array;
	readonly runtimeProfile: "ecmascript-2024-sync-v1";
	readonly catalogDigest: string;
	readonly evidence: Readonly<{
		readonly catalogDigest: string;
		readonly lintEvidenceDigest: string;
		readonly conformanceReceiptDigest: string;
		readonly conformanceDigest: string;
		readonly conformanceTier: "nightly";
		readonly conformanceResult: "passed";
		readonly engines: readonly Readonly<{ readonly name: string; readonly build: string }>[];
	}>;
}

interface ProvenanceSnapshot {
	readonly anchorDigest: string;
	readonly blueprintDigest: string;
	readonly epoch: 0;
	readonly objectId: string;
	readonly parametersDigest: string;
	readonly profileDigest: string;
	readonly signerSetDigest: string;
}

interface OpenedTrustSnapshot {
	readonly head: PresentHead;
	readonly trust: CurrentAnchorTrust;
	readonly trustRef: GenerationRef;
}

interface DurableStateSnapshot extends OpenedTrustSnapshot {
	readonly candidates: readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[];
	readonly references: readonly GenerationRef[];
}

interface PreparedV3LivePayload {
	readonly admission: PreparedBlueprintAdmission;
	readonly catalog: CatalogSnapshot;
	readonly charges: Map<string, number>;
	readonly exactProjectionBytes: Uint8Array;
	readonly input: CapturedInput;
	readonly liveStateRef: GenerationRef;
	readonly order: readonly string[];
	readonly parameters: AcceptedParameters;
	readonly provenance: ProvenanceSnapshot;
	readonly proposedClosure: readonly GenerationRef[];
	readonly runtime: PreparedBlueprintRuntime;
	readonly trust: OpenedTrustSnapshot;
	readonly vertices: Map<string, EpochVertex>;
}

interface AcceptedParameters {
	readonly maxDependencies: number;
	readonly maxEpochBytes: number;
	readonly maxEpochVertices: number;
	readonly maxPendingBytes: number;
	readonly maxPendingEntries: number;
}

const preparedV3LiveAuthority = new WeakMap<object, PreparedV3LivePayload>();

function consumePreparedV3Live(capability: PreparedV3Live): PreparedV3LivePayload | undefined {
	const payload = preparedV3LiveAuthority.get(capability);
	if (payload === undefined) return undefined;
	preparedV3LiveAuthority.delete(capability);
	return payload;
}
void consumePreparedV3Live;

function failure(kind: PrepareV3LiveFailureKind, detail: string): PrepareV3LiveResult {
	return ObjectFreeze({ detail, kind, ok: false as const });
}

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function snapshotClosedRecord(value: unknown, keys: readonly string[]): PlainRecord | undefined {
	try {
		if (!isObject(value) || ObjectGetPrototypeOf(value) !== ObjectPrototype) return undefined;
		const actual = ReflectOwnKeys(value);
		if (actual.length !== keys.length) return undefined;
		for (let actualIndex = 0; actualIndex < actual.length; actualIndex += 1) {
			const actualKey = actual[actualIndex];
			if (typeof actualKey !== "string") return undefined;
			let found = false;
			for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
				if (keys[keyIndex] === actualKey) found = true;
			}
			if (!found) return undefined;
		}
		const snapshot = ObjectCreate(null) as Record<string, unknown>;
		for (let index = 0; index < keys.length; index += 1) {
			const key = keys[index] as string;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
			snapshot[key] = descriptor.value;
		}
		return snapshot;
	} catch {
		return undefined;
	}
}

function isInstanceOf(value: unknown, constructor: object | undefined): boolean {
	try {
		return constructor !== undefined && ReflectApply(FunctionHasInstance, constructor, [value]) === true;
	} catch {
		return false;
	}
}

function isDigestHex(value: unknown): value is string {
	return typeof value === "string" && ReflectApply(RegExpTest, DIGEST_HEX, [value]) === true;
}

function typedArrayBuffer(value: unknown): ArrayBufferLike | undefined {
	try {
		return TypedArrayBufferGetter === undefined
			? undefined
			: (ReflectApply(TypedArrayBufferGetter, value, []) as ArrayBufferLike);
	} catch {
		return undefined;
	}
}

function typedArrayByteLength(value: unknown): number | undefined {
	try {
		if (TypedArrayByteLengthGetter === undefined) return undefined;
		const byteLength = ReflectApply(TypedArrayByteLengthGetter, value, []) as number;
		return NumberIsSafeInteger(byteLength) && byteLength >= 0 ? byteLength : undefined;
	} catch {
		return undefined;
	}
}

function copyDetachedBytes(value: unknown): Uint8Array | undefined {
	try {
		if (!isInstanceOf(value, Uint8ArrayConstructor) || TypedArrayByteLengthGetter === undefined) return undefined;
		const buffer = typedArrayBuffer(value);
		if (buffer === undefined || isInstanceOf(buffer, SharedArrayBufferConstructor)) {
			return undefined;
		}
		const byteLength = typedArrayByteLength(value);
		if (byteLength === undefined) return undefined;
		const copy = new Uint8ArrayConstructor(value as Uint8Array);
		const copyBuffer = typedArrayBuffer(copy);
		if (copyBuffer === undefined) return undefined;
		ObjectDefineProperty(copy, "buffer", { configurable: true, value: copyBuffer });
		ObjectDefineProperty(copy, "byteLength", { configurable: true, value: byteLength });
		return copy;
	} catch {
		return undefined;
	}
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	const leftLength = typedArrayByteLength(left);
	const rightLength = typedArrayByteLength(right);
	if (leftLength === undefined || leftLength !== rightLength) return false;
	for (let index = 0; index < leftLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function bytesToLowerHex(bytes: Uint8Array): string {
	const alphabet = "0123456789abcdef";
	const byteLength = typedArrayByteLength(bytes);
	if (byteLength === undefined) throw new TypeError("digest bytes are invalid");
	let output = "";
	for (let index = 0; index < byteLength; index += 1) {
		const byte = bytes[index] as number;
		output += alphabet[(byte >>> 4) & 0x0f] as string;
		output += alphabet[byte & 0x0f] as string;
	}
	return output;
}

function captureInput(input: PrepareV3LiveGenerationInput): CapturedInput | undefined {
	const record = snapshotClosedRecord(input, INPUT_KEYS);
	if (record === undefined) return undefined;
	if (record.authenticationProfile !== "creator-only") return undefined;
	if (typeof record.objectId !== "string") return undefined;
	const objectId = parseStorageObjectId(record.objectId);
	if (!objectId.ok || objectId.value !== record.objectId) return undefined;
	if (!isDigestHex(record.pinnedGenesisAnchorDigest)) {
		return undefined;
	}
	if (!isObject(record.store) || !isObject(record.catalog)) return undefined;
	const anchorSource = record.exactCanonicalAnchorPreimageBytes;
	const signatureSource = record.detachedSignature;
	const parametersSource = record.exactCanonicalParametersCarrierBytes;
	if (
		!isInstanceOf(anchorSource, Uint8ArrayConstructor) ||
		!isInstanceOf(signatureSource, Uint8ArrayConstructor) ||
		!isInstanceOf(parametersSource, Uint8ArrayConstructor)
	) {
		return undefined;
	}
	const anchorBuffer = typedArrayBuffer(anchorSource);
	const signatureBuffer = typedArrayBuffer(signatureSource);
	const parametersBuffer = typedArrayBuffer(parametersSource);
	if (
		anchorBuffer === undefined ||
		signatureBuffer === undefined ||
		parametersBuffer === undefined ||
		anchorBuffer === signatureBuffer ||
		anchorBuffer === parametersBuffer ||
		signatureBuffer === parametersBuffer
	) {
		return undefined;
	}
	const exactCanonicalAnchorPreimageBytes = copyDetachedBytes(anchorSource);
	const detachedSignature = copyDetachedBytes(signatureSource);
	const exactCanonicalParametersCarrierBytes = copyDetachedBytes(parametersSource);
	if (
		exactCanonicalAnchorPreimageBytes === undefined ||
		typedArrayByteLength(exactCanonicalAnchorPreimageBytes) === 0 ||
		detachedSignature === undefined ||
		typedArrayByteLength(detachedSignature) !== 64 ||
		exactCanonicalParametersCarrierBytes === undefined ||
		typedArrayByteLength(exactCanonicalParametersCarrierBytes) === 0
	) {
		return undefined;
	}
	return ObjectFreeze({
		authenticationProfile: "creator-only" as const,
		store: record.store as AheDurableStore,
		objectId: objectId.value,
		pinnedGenesisAnchorDigest: record.pinnedGenesisAnchorDigest,
		exactCanonicalAnchorPreimageBytes,
		detachedSignature,
		exactCanonicalParametersCarrierBytes,
		catalog: record.catalog as TrustedBlueprintCatalog,
	});
}

interface ParameterFieldSchema {
	readonly maximum: number;
	readonly minimum: number;
	readonly name: string;
}

interface ParameterSchema {
	readonly domain: string;
	readonly fields: readonly ParameterFieldSchema[];
}

function ownDataValue(value: unknown, key: string): unknown {
	if (!isObject(value)) return undefined;
	const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
	return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor
		? descriptor.value
		: undefined;
}

function defineDenseElement(target: unknown[], index: number, value: unknown): boolean {
	try {
		ObjectDefineProperty(target, StringConstructor(index), {
			configurable: true,
			enumerable: true,
			value,
			writable: true,
		});
		return true;
	} catch {
		return false;
	}
}

function finishDenseArray<T>(value: T[], expectedLength: number): readonly T[] | undefined {
	try {
		ObjectDefineProperty(value, "length", {
			configurable: false,
			enumerable: false,
			value: expectedLength,
			writable: true,
		});
		const keys = ReflectOwnKeys(value);
		if (keys.length !== expectedLength + 1 || keys[expectedLength] !== "length") return undefined;
		for (let index = 0; index < expectedLength; index += 1) {
			const key = StringConstructor(index);
			if (keys[index] !== key) return undefined;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
				return undefined;
			}
		}
		return ObjectFreeze(value);
	} catch {
		return undefined;
	}
}

function snapshotDenseArray(value: unknown, expectedLength: number): readonly unknown[] | undefined {
	try {
		if (!ArrayIsArray(value) || ObjectGetPrototypeOf(value) !== ArrayPrototype || value.length !== expectedLength) {
			return undefined;
		}
		const keys = ReflectOwnKeys(value);
		if (keys.length !== expectedLength + 1 || keys[expectedLength] !== "length") return undefined;
		const output: unknown[] = [];
		for (let index = 0; index < expectedLength; index += 1) {
			const key = StringConstructor(index);
			if (keys[index] !== key) return undefined;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
			if (
				descriptor === undefined ||
				descriptor.enumerable !== true ||
				!("value" in descriptor) ||
				!defineDenseElement(output, index, descriptor.value)
			) {
				return undefined;
			}
		}
		return finishDenseArray(output, expectedLength);
	} catch {
		return undefined;
	}
}

function snapshotPublishedParameterSchema(value: unknown): ParameterSchema | undefined {
	try {
		const kinds = ownDataValue(value, "kinds");
		const parameters = snapshotClosedRecord(ownDataValue(kinds, "parameters"), [
			"domain",
			"encoding",
			"fields",
			"signedEnvelope",
		]);
		if (
			parameters === undefined ||
			typeof parameters.domain !== "string" ||
			parameters.encoding !== "canonical-object"
		) {
			return undefined;
		}
		const fields = snapshotDenseArray(parameters.fields, 7);
		if (fields === undefined) return undefined;
		const captured: ParameterFieldSchema[] = [];
		for (let index = 0; index < fields.length; index += 1) {
			const field = snapshotClosedRecord(fields[index], [
				"name",
				"type",
				"const",
				"constraints",
				"required",
				"sortRule",
			]);
			if (
				field === undefined ||
				typeof field.name !== "string" ||
				field.name.length === 0 ||
				field.type !== "safe-integer" ||
				field.const !== null ||
				field.required !== true ||
				field.sortRule !== null
			) {
				return undefined;
			}
			const constraints = snapshotClosedRecord(field.constraints, ["minimum", "maximum"]);
			if (
				constraints === undefined ||
				typeof constraints.minimum !== "number" ||
				!NumberIsSafeInteger(constraints.minimum) ||
				typeof constraints.maximum !== "number" ||
				!NumberIsSafeInteger(constraints.maximum) ||
				constraints.minimum > constraints.maximum
			) {
				return undefined;
			}
			for (let previous = 0; previous < captured.length; previous += 1) {
				if (captured[previous]?.name === field.name) return undefined;
			}
			if (
				!defineDenseElement(
					captured,
					index,
					ObjectFreeze({
						maximum: constraints.maximum,
						minimum: constraints.minimum,
						name: field.name,
					})
				)
			) {
				return undefined;
			}
		}
		const frozenFields = finishDenseArray(captured, fields.length);
		return frozenFields === undefined ? undefined : ObjectFreeze({ domain: parameters.domain, fields: frozenFields });
	} catch {
		return undefined;
	}
}

const PARAMETER_SCHEMA = snapshotPublishedParameterSchema(parameterRegistry);

function snapshotParameterRecord(value: unknown, schema: ParameterSchema): PlainRecord | undefined {
	try {
		if (!isObject(value) || ObjectGetPrototypeOf(value) !== null) return undefined;
		const keys = ReflectOwnKeys(value);
		if (keys.length !== schema.fields.length) return undefined;
		const output = ObjectCreate(null) as Record<string, unknown>;
		for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex += 1) {
			const field = schema.fields[fieldIndex] as ParameterFieldSchema;
			let keyFound = false;
			for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
				if (keys[keyIndex] === field.name) keyFound = true;
			}
			if (!keyFound) return undefined;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, field.name);
			if (
				descriptor === undefined ||
				descriptor.enumerable !== true ||
				!("value" in descriptor) ||
				typeof descriptor.value !== "number" ||
				!NumberIsSafeInteger(descriptor.value) ||
				descriptor.value < field.minimum ||
				descriptor.value > field.maximum
			) {
				return undefined;
			}
			output[field.name] = descriptor.value;
		}
		return output;
	} catch {
		return undefined;
	}
}

function acceptedParameterDigest(bytes: Uint8Array, expectedDigest: string): AcceptedParameters | undefined {
	try {
		if (PARAMETER_SCHEMA === undefined) return undefined;
		const snapshot = snapshotParameterRecord(decodeCanonical(bytes), PARAMETER_SCHEMA);
		if (snapshot === undefined) return undefined;
		const reencoded = encodeCanonical(snapshot);
		if (!sameBytes(reencoded, bytes)) return undefined;
		const digest = bytesToLowerHex(hashDomain(PARAMETER_SCHEMA.domain, reencoded));
		if (digest !== expectedDigest || digest !== SUPPORTED_PARAMETER_PROFILE.parametersDigest) return undefined;
		const maxDependencies = snapshot.maxDependencies;
		const maxEpochBytes = snapshot.maxEpochBytes;
		const maxEpochVertices = snapshot.maxEpochVertices;
		const maxPendingBytes = snapshot.maxPendingBytes;
		const maxPendingEntries = snapshot.maxPendingEntries;
		return typeof maxDependencies === "number" &&
			NumberIsSafeInteger(maxDependencies) &&
			typeof maxEpochBytes === "number" &&
			NumberIsSafeInteger(maxEpochBytes) &&
			typeof maxEpochVertices === "number" &&
			NumberIsSafeInteger(maxEpochVertices) &&
			typeof maxPendingBytes === "number" &&
			NumberIsSafeInteger(maxPendingBytes) &&
			typeof maxPendingEntries === "number" &&
			NumberIsSafeInteger(maxPendingEntries)
			? ObjectFreeze({ maxDependencies, maxEpochBytes, maxEpochVertices, maxPendingBytes, maxPendingEntries })
			: undefined;
	} catch {
		return undefined;
	}
}

function snapshotCatalogEngines(value: unknown): readonly Readonly<{ name: string; build: string }>[] | undefined {
	const engines = snapshotDenseArray(value, CATALOG_ENGINE_NAMES.length);
	if (engines === undefined) return undefined;
	const snapshot: Readonly<{ name: string; build: string }>[] = [];
	for (let index = 0; index < CATALOG_ENGINE_NAMES.length; index += 1) {
		const engine = snapshotClosedRecord(engines[index], CATALOG_ENGINE_KEYS);
		if (
			engine === undefined ||
			typeof engine.name !== "string" ||
			engine.name !== CATALOG_ENGINE_NAMES[index] ||
			typeof engine.build !== "string" ||
			engine.build.length === 0
		) {
			return undefined;
		}
		if (!defineDenseElement(snapshot, index, ObjectFreeze({ build: engine.build, name: engine.name }))) {
			return undefined;
		}
	}
	return finishDenseArray(snapshot, CATALOG_ENGINE_NAMES.length);
}

function snapshotCatalog(catalog: TrustedBlueprintCatalog, value: unknown): CatalogSnapshot | undefined {
	const record = snapshotClosedRecord(value, CATALOG_RESULT_KEYS);
	if (record === undefined) return undefined;
	const evidence = snapshotClosedRecord(record.evidence, CATALOG_EVIDENCE_KEYS);
	if (evidence === undefined) return undefined;
	const catalogDescriptor = ObjectGetOwnPropertyDescriptor(catalog, "catalogDigest");
	if (catalogDescriptor === undefined || !("value" in catalogDescriptor)) return undefined;
	const catalogDigest = catalogDescriptor.value;
	if (
		!isDigestHex(record.artifactDigest) ||
		typeof record.artifactId !== "string" ||
		record.artifactId.length === 0 ||
		!isDigestHex(record.blueprintDigest) ||
		record.runtimeProfile !== SUPPORTED_PARAMETER_PROFILE.runtimeProfile ||
		!isDigestHex(catalogDigest) ||
		evidence.catalogDigest !== catalogDigest ||
		evidence.conformanceTier !== "nightly" ||
		evidence.conformanceResult !== "passed"
	) {
		return undefined;
	}
	for (let index = 0; index < 3; index += 1) {
		const key = ["lintEvidenceDigest", "conformanceReceiptDigest", "conformanceDigest"][index] as string;
		if (!isDigestHex(evidence[key])) return undefined;
	}
	const engines = snapshotCatalogEngines(evidence.engines);
	if (engines === undefined) return undefined;
	const canonicalBlueprintPackageBytes = copyDetachedBytes(record.canonicalBlueprintPackageBytes);
	const exactArtifactBytes = copyDetachedBytes(record.exactArtifactBytes);
	if (
		canonicalBlueprintPackageBytes === undefined ||
		typedArrayByteLength(canonicalBlueprintPackageBytes) === 0 ||
		exactArtifactBytes === undefined ||
		typedArrayByteLength(exactArtifactBytes) === 0
	) {
		return undefined;
	}
	return ObjectFreeze({
		artifactDigest: record.artifactDigest,
		artifactId: record.artifactId,
		blueprintDigest: record.blueprintDigest,
		canonicalBlueprintPackageBytes,
		exactArtifactBytes,
		runtimeProfile: SUPPORTED_PARAMETER_PROFILE.runtimeProfile,
		catalogDigest,
		evidence: ObjectFreeze({
			catalogDigest,
			lintEvidenceDigest: evidence.lintEvidenceDigest as string,
			conformanceReceiptDigest: evidence.conformanceReceiptDigest as string,
			conformanceDigest: evidence.conformanceDigest as string,
			conformanceTier: "nightly" as const,
			conformanceResult: "passed" as const,
			engines,
		}),
	});
}

function admissionMatches(value: PreparedBlueprintAdmission, expectedBlueprintDigest: string): boolean {
	const record = snapshotClosedRecord(value, ["blueprintDigest"]);
	return record?.blueprintDigest === expectedBlueprintDigest;
}

function runtimeMatches(value: PreparedBlueprintRuntime, catalog: CatalogSnapshot): boolean {
	const record = snapshotClosedRecord(value, [
		"artifactDigest",
		"artifactId",
		"blueprintDigest",
		"reducers",
		"runtimeProfile",
	]);
	return (
		record?.artifactDigest === catalog.artifactDigest &&
		record.artifactId === catalog.artifactId &&
		record.blueprintDigest === catalog.blueprintDigest &&
		record.runtimeProfile === catalog.runtimeProfile
	);
}

function snapshotOpenedTrust(value: unknown, expectedObjectId: string): OpenedTrustSnapshot | undefined {
	const result = snapshotClosedRecord(value, OPEN_RESULT_KEYS);
	if (result === undefined || result.ok !== true) return undefined;
	const head = snapshotClosedRecord(result.head, PRESENT_HEAD_KEYS);
	const trust = snapshotClosedRecord(result.trust, TRUST_KEYS);
	const trustRef = snapshotClosedRecord(result.trustRef, TRUST_REF_KEYS);
	if (
		head === undefined ||
		head.kind !== "present" ||
		head.objectId !== expectedObjectId ||
		typeof head.generationId !== "string" ||
		typeof head.closureDigest !== "string" ||
		typeof head.revision !== "number" ||
		!NumberIsSafeInteger(head.revision) ||
		head.revision < 1 ||
		trust === undefined ||
		trust.objectId !== expectedObjectId ||
		trust.profileId !== "creator-trusted-v1" ||
		!isDigestHex(trust.currentAnchorDigest) ||
		!isDigestHex(trust.genesisAnchorDigest) ||
		typeof trust.currentEpoch !== "number" ||
		!NumberIsSafeInteger(trust.currentEpoch) ||
		trust.currentEpoch < 0 ||
		trustRef === undefined ||
		!isDigestHex(trustRef.digest) ||
		typeof trustRef.byteLength !== "number" ||
		!NumberIsSafeInteger(trustRef.byteLength) ||
		trustRef.byteLength < 1
	) {
		return undefined;
	}
	return ObjectFreeze({
		head: ObjectFreeze({
			closureDigest: head.closureDigest,
			generationId: head.generationId,
			kind: "present" as const,
			objectId: head.objectId,
			revision: head.revision,
		}) as PresentHead,
		trust: result.trust as CurrentAnchorTrust,
		trustRef: ObjectFreeze({
			byteLength: trustRef.byteLength,
			digest: trustRef.digest,
		}) as GenerationRef,
	});
}

function snapshotAuthenticatedProvenance(value: unknown, expectedObjectId: string): ProvenanceSnapshot | undefined {
	const result = snapshotClosedRecord(value, AUTHENTICATION_RESULT_KEYS);
	if (result === undefined || result.ok !== true) return undefined;
	const provenance = snapshotClosedRecord(result.provenance, PROVENANCE_KEYS);
	if (
		provenance === undefined ||
		provenance.epoch !== 0 ||
		provenance.objectId !== expectedObjectId ||
		!isDigestHex(provenance.anchorDigest) ||
		!isDigestHex(provenance.blueprintDigest) ||
		!isDigestHex(provenance.parametersDigest) ||
		!isDigestHex(provenance.profileDigest) ||
		!isDigestHex(provenance.signerSetDigest)
	) {
		return undefined;
	}
	return ObjectFreeze({
		anchorDigest: provenance.anchorDigest,
		blueprintDigest: provenance.blueprintDigest,
		epoch: 0 as const,
		objectId: provenance.objectId,
		parametersDigest: provenance.parametersDigest,
		profileDigest: provenance.profileDigest,
		signerSetDigest: provenance.signerSetDigest,
	});
}

interface CapturedIteratorStep {
	readonly done: boolean;
	readonly value: unknown;
}

function nextCapturedMapIterator(iterator: unknown): CapturedIteratorStep | undefined {
	try {
		if (typeof MapIteratorNext !== "function") return undefined;
		const result = ReflectApply(MapIteratorNext, iterator, []) as unknown;
		if (!isObject(result)) return undefined;
		const done = ObjectGetOwnPropertyDescriptor(result, "done");
		const value = ObjectGetOwnPropertyDescriptor(result, "value");
		if (done === undefined || !("value" in done) || typeof done.value !== "boolean") return undefined;
		if (done.value === true) return ObjectFreeze({ done: true, value: undefined });
		return value !== undefined && "value" in value ? ObjectFreeze({ done: false, value: value.value }) : undefined;
	} catch {
		return undefined;
	}
}

function isExactOwnedSingleEntryMap(map: unknown, expectedKey: string, expectedValue: unknown): boolean {
	try {
		if (
			!isObject(map) ||
			ObjectGetPrototypeOf(map) !== MapPrototype ||
			ReflectOwnKeys(map).length !== 0 ||
			MapSizeGetter === undefined ||
			ReflectApply(MapSizeGetter, map, []) !== 1 ||
			ReflectApply(MapPrototypeHas, map, [expectedKey]) !== true ||
			ReflectApply(MapPrototypeGet, map, [expectedKey]) !== expectedValue
		) {
			return false;
		}
		const keys = ReflectApply(MapPrototypeKeys, map, []) as unknown;
		const firstKey = nextCapturedMapIterator(keys);
		const lastKey = nextCapturedMapIterator(keys);
		if (firstKey?.done !== false || firstKey.value !== expectedKey || lastKey?.done !== true) return false;
		const entries = ReflectApply(MapPrototypeEntries, map, []) as unknown;
		const firstEntry = nextCapturedMapIterator(entries);
		const lastEntry = nextCapturedMapIterator(entries);
		if (firstEntry?.done !== false || lastEntry?.done !== true || !ArrayIsArray(firstEntry.value)) return false;
		const entryKey = ObjectGetOwnPropertyDescriptor(firstEntry.value, "0");
		const entryValue = ObjectGetOwnPropertyDescriptor(firstEntry.value, "1");
		return (
			entryKey !== undefined &&
			"value" in entryKey &&
			entryKey.value === expectedKey &&
			entryValue !== undefined &&
			"value" in entryValue &&
			entryValue.value === expectedValue
		);
	} catch {
		return false;
	}
}

function copyApplicationVertices(source: Map<string, EpochVertex>): Map<string, EpochVertex> | undefined {
	try {
		const copy = new IntrinsicMap<string, EpochVertex>();
		const iterator = ReflectApply(MapPrototypeEntries, source, []) as unknown;
		for (;;) {
			const step = nextCapturedMapIterator(iterator);
			if (step?.done === true) return copy;
			if (step?.done !== false || !ArrayIsArray(step.value)) return undefined;
			const key = ObjectGetOwnPropertyDescriptor(step.value, "0");
			const vertex = ObjectGetOwnPropertyDescriptor(step.value, "1");
			if (
				key === undefined ||
				!("value" in key) ||
				typeof key.value !== "string" ||
				vertex === undefined ||
				!("value" in vertex)
			) {
				return undefined;
			}
			ReflectApply(MapPrototypeSet, copy, [key.value, vertex.value]);
		}
	} catch {
		return undefined;
	}
}

function retainApplicationVertex(
	vertices: Map<string, EpochVertex>,
	authors: Map<string, string>,
	authenticated: AuthenticatedRecoveryVertex
): void {
	ReflectApply(MapPrototypeSet, vertices, [authenticated.digest, authenticated.vertex]);
	ReflectApply(MapPrototypeSet, authors, [authenticated.digest, authenticated.author]);
}

function intrinsicMapSize(map: Map<unknown, unknown>): number | undefined {
	try {
		if (MapSizeGetter === undefined) return undefined;
		const size = ReflectApply(MapSizeGetter, map, []) as number;
		return NumberIsSafeInteger(size) && size >= 0 ? size : undefined;
	} catch {
		return undefined;
	}
}

function isLinearizationFailure(value: unknown): boolean {
	if (!isObject(value)) return false;
	try {
		const brand = ObjectGetOwnPropertyDescriptor(value, DRP_ERROR_BRAND);
		const code = ObjectGetOwnPropertyDescriptor(value, "code");
		const name = ObjectGetOwnPropertyDescriptor(value, "name");
		return (
			brand !== undefined &&
			"value" in brand &&
			brand.value === true &&
			code !== undefined &&
			"value" in code &&
			typeof code.value === "string" &&
			name !== undefined &&
			"value" in name &&
			name.value === "LinearizationError"
		);
	} catch {
		return false;
	}
}

function copiedGenerationRef(digest: unknown, byteLength: unknown): GenerationRef | undefined {
	return isDigestHex(digest) && typeof byteLength === "number" && NumberIsSafeInteger(byteLength) && byteLength > 0
		? (ObjectFreeze({ digest, byteLength }) as GenerationRef)
		: undefined;
}

type StoreResultSnapshot =
	| Readonly<{ readonly ok: true; readonly value: unknown }>
	| Readonly<{ readonly ok: false; readonly reason: string }>;

function snapshotStoreResult(value: unknown): StoreResultSnapshot | undefined {
	try {
		if (!isObject(value)) return undefined;
		const ok = ObjectGetOwnPropertyDescriptor(value, "ok");
		if (ok === undefined || ok.enumerable !== true || !("value" in ok) || typeof ok.value !== "boolean") {
			return undefined;
		}
		if (ok.value) {
			const record = snapshotClosedRecord(value, ["ok", "value"]);
			return record === undefined ? undefined : ObjectFreeze({ ok: true as const, value: record.value });
		}
		const reason = ObjectGetOwnPropertyDescriptor(value, "reason");
		if (
			reason === undefined ||
			reason.enumerable !== true ||
			!("value" in reason) ||
			typeof reason.value !== "string"
		) {
			return undefined;
		}
		const keys = reason.value === "SUBSTRATE_FAILURE" ? ["cause", "ok", "reason"] : ["ok", "reason"];
		return snapshotClosedRecord(value, keys) === undefined
			? undefined
			: ObjectFreeze({ ok: false as const, reason: reason.value });
	} catch {
		return undefined;
	}
}

function copiedPresentHead(value: unknown, expectedObjectId: StorageObjectId): PresentHead | undefined {
	const record = snapshotClosedRecord(value, PRESENT_HEAD_KEYS);
	if (
		record === undefined ||
		record.kind !== "present" ||
		record.objectId !== expectedObjectId ||
		!isDigestHex(record.generationId) ||
		!isDigestHex(record.closureDigest) ||
		typeof record.revision !== "number" ||
		!NumberIsSafeInteger(record.revision) ||
		record.revision < 1
	) {
		return undefined;
	}
	return ObjectFreeze({
		kind: "present" as const,
		objectId: expectedObjectId,
		generationId: record.generationId,
		revision: record.revision,
		closureDigest: record.closureDigest,
	}) as PresentHead;
}

function copiedExpectedHead(value: unknown, expectedObjectId: StorageObjectId): ExpectedHead | undefined {
	try {
		const kind = isObject(value) ? ObjectGetOwnPropertyDescriptor(value, "kind") : undefined;
		if (kind === undefined || !("value" in kind)) return undefined;
		if (kind.value === "none") {
			const record = snapshotClosedRecord(value, ["kind", "objectId"]);
			return record?.objectId === expectedObjectId
				? ObjectFreeze({ kind: "none" as const, objectId: expectedObjectId })
				: undefined;
		}
		return copiedPresentHead(value, expectedObjectId);
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

function copiedGenerationRefs(value: unknown): readonly GenerationRef[] | undefined {
	try {
		if (!ArrayIsArray(value) || ObjectGetPrototypeOf(value) !== ArrayPrototype) return undefined;
		const length = ObjectGetOwnPropertyDescriptor(value, "length");
		if (
			length === undefined ||
			!("value" in length) ||
			typeof length.value !== "number" ||
			!NumberIsSafeInteger(length.value) ||
			length.value < 1 ||
			length.value > 2
		) {
			return undefined;
		}
		const entries = snapshotDenseArray(value, length.value);
		if (entries === undefined) return undefined;
		const refs: GenerationRef[] = [];
		let previous: string | undefined;
		for (let index = 0; index < entries.length; index += 1) {
			const record = snapshotClosedRecord(entries[index], TRUST_REF_KEYS);
			const ref = copiedGenerationRef(record?.digest, record?.byteLength);
			if (ref === undefined || (previous !== undefined && previous >= ref.digest)) return undefined;
			if (!defineDenseElement(refs, index, ref)) return undefined;
			previous = ref.digest;
		}
		return finishDenseArray(refs, entries.length);
	} catch {
		return undefined;
	}
}

function sameClosure(left: readonly GenerationRef[], right: readonly GenerationRef[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (!sameRef(left[index] as GenerationRef, right[index] as GenerationRef)) return false;
	}
	return true;
}

function copiedGenerationRecord(
	value: unknown,
	expected: Readonly<{
		baseExpectedHead?: ExpectedHead;
		closure: readonly GenerationRef[];
		generationId: GenerationId;
		objectId: StorageObjectId;
		state: "Adopted" | "Complete" | "Staged";
	}>
): Readonly<{ readonly closureDigest: string }> | undefined {
	const record = snapshotClosedRecord(value, GENERATION_RECORD_KEYS);
	if (
		record === undefined ||
		record.objectId !== expected.objectId ||
		record.generationId !== expected.generationId ||
		record.state !== expected.state ||
		!isDigestHex(record.closureDigest)
	) {
		return undefined;
	}
	const baseExpectedHead = copiedExpectedHead(record.baseExpectedHead, expected.objectId);
	const closure = copiedGenerationRefs(record.closure);
	return baseExpectedHead !== undefined &&
		(expected.baseExpectedHead === undefined ||
			(baseExpectedHead.kind === expected.baseExpectedHead.kind &&
				(baseExpectedHead.kind === "none" ||
					(expected.baseExpectedHead.kind === "present" && sameHead(baseExpectedHead, expected.baseExpectedHead))))) &&
		closure !== undefined &&
		sameClosure(closure, expected.closure)
		? ObjectFreeze({ closureDigest: record.closureDigest })
		: undefined;
}

function freshGenerationId(): GenerationId | undefined {
	try {
		const bytes = new Uint8ArrayConstructor(32);
		const buffer = typedArrayBuffer(bytes);
		if (buffer === undefined) return undefined;
		ObjectDefineProperty(bytes, "buffer", { configurable: true, value: buffer });
		ObjectDefineProperty(bytes, "byteLength", { configurable: true, value: 32 });
		ReflectApply(CryptoGetRandomValues, globalThis.crypto, [bytes]);
		const parsed = parseGenerationId(bytesToLowerHex(bytes));
		return parsed.ok ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

async function reopenDurableState(
	captured: CapturedInput,
	trustStore: ReturnType<typeof createCurrentAnchorTrustStore>
): Promise<DurableStateSnapshot | undefined> {
	try {
		const opened = snapshotOpenedTrust(await trustStore.open(), captured.objectId);
		if (opened === undefined) return undefined;
		const recoveredResult = snapshotStoreResult(await captured.store.recoverActiveGeneration(captured.objectId));
		if (recoveredResult?.ok !== true) return undefined;
		const recovered = snapshotClosedRecord(recoveredResult.value, ACTIVE_RECOVERY_KEYS);
		if (recovered === undefined || recovered.kind !== "active") return undefined;
		const head = copiedPresentHead(recovered.head, captured.objectId);
		const references = copiedGenerationRefs(recovered.references);
		if (
			head === undefined ||
			!sameHead(head, opened.head) ||
			references === undefined ||
			recovered.recomputedClosureDigest !== head.closureDigest
		) {
			return undefined;
		}
		const candidates: Array<Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>> = [];
		let evidenceValid = true;
		let index = 0;
		while (index < references.length) {
			const ref = references[index] as GenerationRef;
			const loaded = snapshotStoreResult(await captured.store.getBlob(ref.digest));
			const bytes = loaded?.ok === true ? copyDetachedBytes(loaded.value) : undefined;
			const digest = bytes === undefined ? undefined : digestBlob(bytes);
			const copiedRef = copiedGenerationRef(ref.digest, ref.byteLength);
			if (
				bytes === undefined ||
				bytes.byteLength !== ref.byteLength ||
				digest?.ok !== true ||
				digest.value !== ref.digest ||
				copiedRef === undefined
			) {
				evidenceValid = false;
				index += 1;
				continue;
			}
			if (!defineDenseElement(candidates, index, ObjectFreeze({ bytes, ref: copiedRef }))) {
				evidenceValid = false;
			}
			index += 1;
		}
		const adopted = copiedGenerationRecord(recovered.adoptedGeneration, {
			closure: references,
			generationId: head.generationId,
			objectId: captured.objectId,
			state: "Adopted",
		});
		if (!evidenceValid || adopted === undefined || adopted.closureDigest !== head.closureDigest) return undefined;
		const frozenCandidates = finishDenseArray(candidates, references.length);
		return frozenCandidates === undefined
			? undefined
			: ObjectFreeze({ ...opened, candidates: frozenCandidates, head, references });
	} catch {
		return undefined;
	}
}

interface PreparedV3LiveMintInput {
	readonly admission: PreparedBlueprintAdmission;
	readonly byteCharge: number;
	readonly captured: CapturedInput;
	readonly catalog: CatalogSnapshot;
	readonly charges: Map<string, number>;
	readonly durableProjectionBytes: Uint8Array;
	readonly liveStateRef: GenerationRef;
	readonly order: readonly string[];
	readonly parameters: AcceptedParameters;
	readonly projectionDigest: BlobDigest;
	readonly proposedClosure: readonly GenerationRef[];
	readonly provenance: ProvenanceSnapshot;
	readonly runtime: PreparedBlueprintRuntime;
	readonly vertices: Map<string, EpochVertex>;
}

interface PreparedV3LiveMint {
	readonly capability: PreparedV3Live;
	readonly descriptor: V3LiveDescriptor;
	readonly payload: PreparedV3LivePayload;
}

function buildPreparedV3LiveMint(
	input: PreparedV3LiveMintInput,
	durable: DurableStateSnapshot
): PreparedV3LiveMint | PrepareV3LiveResult {
	let durableProjection: Uint8Array | undefined;
	let index = 0;
	while (index < durable.candidates.length) {
		const candidate = durable.candidates[index];
		if (candidate?.ref.digest === input.liveStateRef.digest) durableProjection = candidate.bytes;
		index += 1;
	}
	if (durableProjection === undefined || !sameBytes(durableProjection, input.durableProjectionBytes)) {
		return failure("stale-head", "durable creator projection does not match");
	}
	const descriptor = ObjectFreeze({
		objectId: input.provenance.objectId,
		epoch: input.provenance.epoch,
		anchorDigest: input.provenance.anchorDigest,
		blueprintDigest: input.provenance.blueprintDigest,
		parametersDigest: input.provenance.parametersDigest,
		profileDigest: input.provenance.profileDigest,
		signerSetDigest: input.provenance.signerSetDigest,
		artifactDigest: input.catalog.artifactDigest,
		artifactId: input.catalog.artifactId,
		catalogDigest: input.catalog.catalogDigest,
		runtimeProfile: input.catalog.runtimeProfile,
		trustProfile: "creator-only" as const,
		trustRef: ObjectFreeze({ ...durable.trustRef }),
		maxEpochVertices: input.parameters.maxEpochVertices,
		maxEpochBytes: input.parameters.maxEpochBytes,
		maxDependencies: input.parameters.maxDependencies,
		vertexCount: 1 as const,
		byteCharge: input.byteCharge,
		projectionDigest: input.projectionDigest,
		head: ObjectFreeze({ ...durable.head }),
	}) satisfies V3LiveDescriptor;
	const capability = ObjectFreeze({}) as PreparedV3Live;
	const payload = ObjectFreeze({
		admission: input.admission,
		catalog: input.catalog,
		charges: input.charges,
		exactProjectionBytes: new Uint8ArrayConstructor(input.durableProjectionBytes),
		input: input.captured,
		liveStateRef: input.liveStateRef,
		order: input.order,
		parameters: input.parameters,
		provenance: input.provenance,
		proposedClosure: input.proposedClosure,
		runtime: input.runtime,
		trust: durable,
		vertices: input.vertices,
	}) satisfies PreparedV3LivePayload;
	return ObjectFreeze({ capability, descriptor, payload });
}

type StagePreparedGenerationResult =
	| Readonly<{ readonly ok: true; readonly swapResult: StoreResultSnapshot | undefined }>
	| Readonly<{ readonly ok: false; readonly result: PrepareV3LiveResult }>;

async function stagePreparedGeneration(
	captured: CapturedInput,
	current: DurableStateSnapshot,
	proposedClosure: readonly GenerationRef[],
	proposedClosureDigest: string,
	liveStateRef: GenerationRef,
	projectionBytesForStage: Uint8Array
): Promise<StagePreparedGenerationResult> {
	const generationId = freshGenerationId();
	if (generationId === undefined) {
		return ObjectFreeze({
			ok: false as const,
			result: failure("storage-failed", "creator generation identity could not be derived"),
		});
	}
	try {
		const begun = snapshotStoreResult(
			await captured.store.beginGeneration({
				baseExpectedHead: current.head,
				closure: proposedClosure,
				generationId,
				objectId: captured.objectId,
			})
		);
		const begunRecord =
			begun?.ok === true
				? copiedGenerationRecord(begun.value, {
						baseExpectedHead: current.head,
						closure: proposedClosure,
						generationId,
						objectId: captured.objectId,
						state: "Staged",
					})
				: undefined;
		if (begunRecord === undefined || begunRecord.closureDigest !== proposedClosureDigest) {
			return ObjectFreeze({
				ok: false as const,
				result: failure("storage-failed", "creator generation staging failed"),
			});
		}
		const cached = snapshotStoreResult(
			await captured.store.putCachedBlob({
				bytes: projectionBytesForStage,
				digest: liveStateRef.digest,
				generationId,
				objectId: captured.objectId,
			})
		);
		const cachedValue = cached?.ok === true ? snapshotClosedRecord(cached.value, ["inserted"]) : undefined;
		if (cachedValue === undefined || typeof cachedValue.inserted !== "boolean") {
			return ObjectFreeze({
				ok: false as const,
				result: failure("storage-failed", "creator projection staging failed"),
			});
		}
		let index = 0;
		while (index < proposedClosure.length) {
			const promoted = snapshotStoreResult(
				await captured.store.promoteReference({
					digest: (proposedClosure[index] as GenerationRef).digest,
					generationId,
					objectId: captured.objectId,
				})
			);
			if (promoted?.ok !== true || promoted.value !== undefined) {
				return ObjectFreeze({
					ok: false as const,
					result: failure("storage-failed", "creator reference promotion failed"),
				});
			}
			index += 1;
		}
		const completed = snapshotStoreResult(
			await captured.store.completeGeneration({ generationId, objectId: captured.objectId })
		);
		const completedRecord =
			completed?.ok === true
				? copiedGenerationRecord(completed.value, {
						baseExpectedHead: current.head,
						closure: proposedClosure,
						generationId,
						objectId: captured.objectId,
						state: "Complete",
					})
				: undefined;
		if (completedRecord === undefined || completedRecord.closureDigest !== begunRecord.closureDigest) {
			return ObjectFreeze({
				ok: false as const,
				result: failure("storage-failed", "creator generation completion failed"),
			});
		}
		const expectedRevision = parseHeadRevision(current.head.revision + 1);
		if (!expectedRevision.ok) {
			return ObjectFreeze({
				ok: false as const,
				result: failure("storage-failed", "creator head revision is invalid"),
			});
		}
		let swapResult: StoreResultSnapshot | undefined;
		try {
			swapResult = snapshotStoreResult(
				await captured.store.swapHead({
					expectedHead: current.head,
					generationId,
					objectId: captured.objectId,
				})
			);
		} catch {
			swapResult = undefined;
		}
		return ObjectFreeze({ ok: true as const, swapResult });
	} catch {
		return ObjectFreeze({
			ok: false as const,
			result: failure("storage-failed", "creator generation staging failed"),
		});
	}
}

/**
 * Authenticates, preserves and stages one creator generation through the private A-c boundary.
 * @param input - Closed creator preparation input.
 * @returns A frozen preparation result; live activation remains deferred.
 */
async function prepareV3LiveGeneration(input: PrepareV3LiveGenerationInput): Promise<PrepareV3LiveResult> {
	const captured = captureInput(input);
	if (captured === undefined) return failure("malformed-input", "creator preparation input is invalid");

	let openedTrust: OpenedTrustSnapshot;
	let trustStore: ReturnType<typeof createCurrentAnchorTrustStore>;
	try {
		trustStore = createCurrentAnchorTrustStore({
			objectId: captured.objectId,
			pinnedGenesisAnchorDigest: captured.pinnedGenesisAnchorDigest,
			store: captured.store,
		});
		const opened = await trustStore.open();
		const snapshot = snapshotOpenedTrust(opened, captured.objectId);
		if (snapshot === undefined) {
			return failure("trust-open-failed", "creator trust could not be opened");
		}
		openedTrust = snapshot;
	} catch {
		return failure("trust-open-failed", "creator trust could not be opened");
	}

	let provenance: ProvenanceSnapshot;
	try {
		const authenticated = authenticateCurrentEpochAnchor({
			detachedSignature: captured.detachedSignature,
			exactCanonicalAnchorPreimageBytes: captured.exactCanonicalAnchorPreimageBytes,
			trust: openedTrust.trust,
		});
		const snapshot = snapshotAuthenticatedProvenance(authenticated, captured.objectId);
		if (snapshot === undefined || snapshot.anchorDigest !== captured.pinnedGenesisAnchorDigest) {
			return failure("anchor-authentication-failed", "current anchor authentication failed");
		}
		provenance = snapshot;
	} catch {
		return failure("anchor-authentication-failed", "current anchor authentication failed");
	}
	try {
		const independentlyHashedAnchor = bytesToLowerHex(
			hashDomain("ts-drp/epoch-anchor/v3", captured.exactCanonicalAnchorPreimageBytes)
		);
		if (
			independentlyHashedAnchor !== captured.pinnedGenesisAnchorDigest ||
			independentlyHashedAnchor !== provenance.anchorDigest
		) {
			return failure("anchor-authentication-failed", "current anchor digest is invalid");
		}
	} catch {
		return failure("anchor-authentication-failed", "current anchor digest is invalid");
	}

	const parameters = acceptedParameterDigest(
		captured.exactCanonicalParametersCarrierBytes,
		provenance.parametersDigest
	);
	if (parameters === undefined) {
		return failure("parameters-rejected", "creator parameters are unsupported");
	}

	let catalog: CatalogSnapshot;
	try {
		const resolved = captured.catalog.resolve(provenance.blueprintDigest);
		const snapshot = snapshotCatalog(captured.catalog, resolved);
		if (
			snapshot === undefined ||
			snapshot.blueprintDigest !== provenance.blueprintDigest ||
			snapshot.runtimeProfile !== SUPPORTED_PARAMETER_PROFILE.runtimeProfile
		) {
			return failure("blueprint-unresolved", "trusted blueprint could not be resolved");
		}
		catalog = snapshot;
	} catch {
		return failure("blueprint-unresolved", "trusted blueprint could not be resolved");
	}

	let admission: PreparedBlueprintAdmission;
	try {
		admission = prepareBlueprintAdmission({
			canonicalBlueprintPackageBytes: catalog.canonicalBlueprintPackageBytes,
			expectedBlueprintDigest: provenance.blueprintDigest,
		});
	} catch {
		return failure("admission-rejected", "blueprint admission preparation failed");
	}
	if (!admissionMatches(admission, catalog.blueprintDigest)) {
		return failure("admission-rejected", "blueprint admission identity is invalid");
	}

	let runtime: PreparedBlueprintRuntime;
	try {
		runtime = await prepareBlueprintRuntime({
			canonicalBlueprintPackageBytes: catalog.canonicalBlueprintPackageBytes,
			exactArtifactBytes: catalog.exactArtifactBytes,
			expectedBlueprintDigest: provenance.blueprintDigest,
			preparedBlueprintAdmission: admission,
		});
	} catch {
		return failure("runtime-preparation-failed", "blueprint runtime preparation failed");
	}
	if (!runtimeMatches(runtime, catalog)) {
		return failure("runtime-preparation-failed", "blueprint runtime identity is invalid");
	}

	const byteCharge = typedArrayByteLength(captured.exactCanonicalAnchorPreimageBytes);
	if (
		byteCharge === undefined ||
		byteCharge < 1 ||
		byteCharge > parameters.maxEpochBytes ||
		parameters.maxEpochVertices < 1
	) {
		return failure("graph-rejected", "creator graph exceeds authenticated limits");
	}

	const dependencies = finishDenseArray<string>([], 0);
	const orderValues: string[] = [];
	if (dependencies === undefined || !defineDenseElement(orderValues, 0, provenance.anchorDigest)) {
		return failure("internal-invariant", "creator graph containers could not be constructed");
	}
	const order = finishDenseArray(orderValues, 1);
	if (order === undefined) return failure("internal-invariant", "creator graph containers could not be constructed");
	const vertex = ObjectFreeze({
		hash: provenance.anchorDigest,
		kind: "drp-epoch-anchor" as const,
		objectId: provenance.objectId,
		epoch: 0,
		dependencies: dependencies as string[],
	});
	const vertices = new IntrinsicMap<string, EpochVertex>();
	const charges = new IntrinsicMap<string, number>();
	try {
		ReflectApply(MapPrototypeSet, vertices, [provenance.anchorDigest, vertex]);
		ReflectApply(MapPrototypeSet, charges, [provenance.anchorDigest, byteCharge]);
	} catch {
		return failure("internal-invariant", "creator graph containers could not be constructed");
	}
	if (
		!isExactOwnedSingleEntryMap(vertices, provenance.anchorDigest, vertex) ||
		!isExactOwnedSingleEntryMap(charges, provenance.anchorDigest, byteCharge) ||
		order[0] !== provenance.anchorDigest
	) {
		return failure("graph-rejected", "creator graph ownership is invalid");
	}
	try {
		new CausalityIndex(vertices, order, {
			initialByteCharges: charges,
			maxEpochBytes: parameters.maxEpochBytes,
			maxEpochVertices: parameters.maxEpochVertices,
		});
	} catch (error) {
		return isLinearizationFailure(error)
			? failure("graph-rejected", "creator graph validation failed")
			: failure("internal-invariant", "creator graph validation failed unexpectedly");
	}

	let durableProjectionBytes: Uint8Array;
	let projectionDigest: BlobDigest;
	let liveStateRef: GenerationRef;
	let proposedClosure: readonly GenerationRef[];
	let proposedClosureDigest: string;
	try {
		const orderedVertexHashesPreimage = {
			kind: "v3-live-order-1",
			orderedVertexHashes: [provenance.anchorDigest],
		};
		const graphChargePreimage = {
			kind: "v3-live-graph-1",
			vertices: [
				{
					hash: provenance.anchorDigest,
					kind: "drp-epoch-anchor",
					objectId: provenance.objectId,
					epoch: 0,
					dependencies: [],
				},
			],
			charges: [{ hash: provenance.anchorDigest, byteCharge }],
		};
		const exactOrderPreimageBytes = encodeCanonical(orderedVertexHashesPreimage);
		const exactGraphChargePreimageBytes = encodeCanonical(graphChargePreimage);
		const orderedVertexHashesDigest = (digestBlob(exactOrderPreimageBytes) as { readonly value?: BlobDigest }).value;
		if (orderedVertexHashesDigest === undefined) {
			return failure("internal-invariant", "creator order digest could not be derived");
		}
		const graphDigest = (digestBlob(exactGraphChargePreimageBytes) as { readonly value?: BlobDigest }).value;
		if (graphDigest === undefined) {
			return failure("internal-invariant", "creator graph digest could not be derived");
		}
		const projectionRecord = {
			kind: "v3-live-generation-1",
			objectId: provenance.objectId,
			epoch: provenance.epoch,
			anchorDigest: provenance.anchorDigest,
			blueprintDigest: provenance.blueprintDigest,
			parametersDigest: provenance.parametersDigest,
			profileDigest: provenance.profileDigest,
			signerSetDigest: provenance.signerSetDigest,
			artifactDigest: catalog.artifactDigest,
			artifactId: catalog.artifactId,
			catalogDigest: catalog.catalogDigest,
			runtimeProfile: catalog.runtimeProfile,
			trustProfile: "creator-only",
			maxEpochVertices: parameters.maxEpochVertices,
			maxEpochBytes: parameters.maxEpochBytes,
			maxDependencies: parameters.maxDependencies,
			vertexCount: 1,
			byteCharge,
			orderedVertexHashesDigest,
			graphDigest,
		};
		const exactProjectionBytes = encodeCanonical(projectionRecord);
		const derivedProjectionDigest = (digestBlob(exactProjectionBytes) as { readonly value?: BlobDigest }).value;
		const projectionByteLength = typedArrayByteLength(exactProjectionBytes);
		const trustRef = copiedGenerationRef(openedTrust.trustRef.digest, openedTrust.trustRef.byteLength);
		const derivedLiveStateRef = copiedGenerationRef(derivedProjectionDigest, projectionByteLength);
		if (trustRef === undefined || derivedLiveStateRef === undefined || trustRef.digest === derivedLiveStateRef.digest) {
			return failure("internal-invariant", "creator live projection reference is invalid");
		}
		const proposedClosureValues: GenerationRef[] = [];
		const firstRef = trustRef.digest < derivedLiveStateRef.digest ? trustRef : derivedLiveStateRef;
		const secondRef = firstRef === trustRef ? derivedLiveStateRef : trustRef;
		if (
			!defineDenseElement(proposedClosureValues, 0, firstRef) ||
			!defineDenseElement(proposedClosureValues, 1, secondRef)
		) {
			return failure("internal-invariant", "creator closure could not be constructed");
		}
		const frozenClosure = finishDenseArray(proposedClosureValues, 2);
		if (frozenClosure === undefined) {
			return failure("internal-invariant", "creator closure could not be constructed");
		}
		const closureDigest = digestClosure(frozenClosure);
		if (!closureDigest.ok) return failure("internal-invariant", "creator closure digest could not be derived");
		projectionDigest = derivedLiveStateRef.digest;
		liveStateRef = derivedLiveStateRef;
		proposedClosure = frozenClosure;
		proposedClosureDigest = closureDigest.value;
		durableProjectionBytes = exactProjectionBytes;
	} catch {
		return failure("internal-invariant", "creator graph projection could not be derived");
	}

	const mintInput = ObjectFreeze({
		admission,
		byteCharge,
		captured,
		catalog,
		charges,
		durableProjectionBytes,
		liveStateRef,
		order,
		parameters,
		projectionDigest,
		proposedClosure,
		provenance,
		runtime,
		vertices,
	}) satisfies PreparedV3LiveMintInput;
	let carried: DurableStateSnapshot | undefined;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		let current = carried;
		let stagedHead: PresentHead | undefined;
		let swapResult: StoreResultSnapshot | undefined;
		let awaitingOutcome = false;
		carried = undefined;
		while (true) {
			if (current === undefined) current = await reopenDurableState(captured, trustStore);
			if (current === undefined) return failure("storage-failed", "creator durable state could not be reopened");
			const trustOnlyValues: GenerationRef[] = [];
			const copiedTrustRef = copiedGenerationRef(current.trustRef.digest, current.trustRef.byteLength);
			if (copiedTrustRef === undefined || !defineDenseElement(trustOnlyValues, 0, copiedTrustRef)) {
				return failure("internal-invariant", "creator trust closure could not be copied");
			}
			const trustOnly = finishDenseArray(trustOnlyValues, 1);
			if (trustOnly === undefined) return failure("internal-invariant", "creator trust closure could not be copied");
			if (sameClosure(current.references, proposedClosure)) {
				const mint = buildPreparedV3LiveMint(mintInput, current);
				if ("ok" in mint) return mint;
				const capability = mint.capability;
				preparedV3LiveAuthority.set(capability, mint.payload);
				return ObjectFreeze({ capability, descriptor: mint.descriptor, ok: true as const });
			}
			if (!sameClosure(current.references, trustOnly)) {
				return failure("stale-head", "creator durable head is not an exact preparation predecessor");
			}
			if (awaitingOutcome) {
				if (stagedHead === undefined || !sameHead(current.head, stagedHead)) {
					return failure("stale-head", "another creator generation became authoritative");
				}
				const definiteLoss = swapResult?.ok === false && swapResult.reason === "HEAD_CONFLICT";
				if (!definiteLoss) return failure("storage-failed", "creator head swap outcome is ambiguous");
				if (attempt === 1) return failure("stale-head", "creator head swap lost twice");
				carried = current;
				break;
			}

			const candidates: Array<Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>> = [];
			let closureIndex = 0;
			while (closureIndex < proposedClosure.length) {
				const ref = proposedClosure[closureIndex] as GenerationRef;
				let bytes: Uint8Array | undefined;
				if (ref.digest === liveStateRef.digest) {
					bytes = copyDetachedBytes(durableProjectionBytes);
				} else {
					let candidateIndex = 0;
					while (candidateIndex < current.candidates.length) {
						const candidate = current.candidates[candidateIndex];
						if (candidate?.ref.digest === ref.digest) bytes = copyDetachedBytes(candidate.bytes);
						candidateIndex += 1;
					}
				}
				const copiedRef = copiedGenerationRef(ref.digest, ref.byteLength);
				if (
					bytes === undefined ||
					copiedRef === undefined ||
					!defineDenseElement(candidates, closureIndex, ObjectFreeze({ bytes, ref: copiedRef }))
				) {
					return failure("internal-invariant", "creator preservation candidates could not be copied");
				}
				closureIndex += 1;
			}
			const frozenCandidates = finishDenseArray(candidates, proposedClosure.length);
			const closureForPreservation = copiedGenerationRefs(proposedClosure);
			const expectedTrustRef = copiedGenerationRef(current.trustRef.digest, current.trustRef.byteLength);
			const projectionBytesForStage = copyDetachedBytes(durableProjectionBytes);
			if (
				frozenCandidates === undefined ||
				closureForPreservation === undefined ||
				expectedTrustRef === undefined ||
				projectionBytesForStage === undefined
			) {
				return failure("internal-invariant", "creator preservation input could not be copied");
			}
			let preserved: unknown;
			try {
				preserved = assertTrustPreserved({
					candidates: frozenCandidates,
					closure: closureForPreservation,
					expectedTrustRef,
				});
			} catch {
				return failure("trust-not-preserved", "creator trust preservation failed");
			}
			const preservation = snapshotClosedRecord(preserved, ["exactCanonicalTrustStateRecordBytes", "ok", "trustRef"]);
			const preservedRef =
				preservation === undefined ? undefined : snapshotClosedRecord(preservation.trustRef, TRUST_REF_KEYS);
			if (
				preservation?.ok !== true ||
				copyDetachedBytes(preservation.exactCanonicalTrustStateRecordBytes) === undefined ||
				preservedRef === undefined ||
				preservedRef.digest !== expectedTrustRef.digest ||
				preservedRef.byteLength !== expectedTrustRef.byteLength
			) {
				return failure("trust-not-preserved", "creator trust preservation failed");
			}

			const staged = await stagePreparedGeneration(
				captured,
				current,
				proposedClosure,
				proposedClosureDigest,
				liveStateRef,
				projectionBytesForStage
			);
			if (!staged.ok) return staged.result;
			stagedHead = current.head;
			swapResult = staged.swapResult;
			awaitingOutcome = true;
			current = undefined;
		}
	}

	return failure("internal-invariant", "creator preparation exhausted unexpectedly");
}

interface V3PlaneRegistration {
	active: boolean;
	readonly applicationAuthors: Map<string, string>;
	readonly applicationVertices: Map<string, EpochVertex>;
	readonly authorization: V3LiveAuthorization;
	blueprintClosing: boolean;
	blueprintFolded: boolean;
	blueprintMachine?: BlueprintStateMachine;
	blueprintHandle?: V3BlueprintLiveHandle;
	readonly classifyTerminalVertex?: V3TerminalVertexClassifier;
	readonly displacedSource?: V3DisplacedSourceAuthority;
	epochBytes: number;
	graphVersion: number;
	handle: V3PlaneHandle;
	readonly index: CausalityIndex;
	readonly issuanceScope: DurableIssueScope;
	readonly issuanceStore: DurableIssuanceStore;
	readonly latchedOperations: Map<string, StagedLatchedAclOperation>;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly messageQueueManager: MessageQueueManager<Message>;
	readonly networkNode: DRPNetworkNode;
	readonly onAdmittedVertex: V3AdmittedVertexSink;
	readonly payload: PreparedV3LivePayload;
	readonly pendingIngress: Map<string, PendingV3Ingress>;
	readonly quarantinedDigests: ReadonlySet<string>;
	readonly queueId: string;
	readonly topic: string;
	drainingPendingIngress: boolean;
	gate: Promise<void> | undefined;
	pendingIngressBytes: number;
	publicationCursor: number | undefined;
	rebaseCursor: number | undefined;
	rebaseSnapshot: readonly ClassifiedRebaseRow[] | undefined;
	retainedBootstrapHold: boolean;
	releaseTerminalBarrier: (() => void) | undefined;
	terminalBarrier: Promise<void> | undefined;
	terminalState: "active" | "transition" | "terminal";
}

interface PendingV3Ingress {
	readonly evidence: VerifiedV3IngressEvidence;
	readonly pendingByteCharge: number;
}

interface VerifiedV3IngressEvidence {
	readonly authenticated: AuthenticatedRecoveryVertex;
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly signature: Uint8Array;
	readonly transportSender: string;
}

const v3PlaneRegistrations = new WeakMap<DRPNetworkNode, Map<string, V3PlaneRegistration>>();
const v3HandleRegistrations = new WeakMap<V3PlaneHandle, V3PlaneRegistration>();
const HEX_DIGITS = "0123456789abcdef";

function activationFailure(
	kind: V3PlaneActivationFailureKind,
	detail: string
): Extract<V3PlaneActivationResult, { readonly ok: false }> {
	return ObjectFreeze({ detail, kind, ok: false as const });
}

function egressFailure(
	kind: Extract<V3EgressResult, { readonly ok: false }>["kind"],
	detail: string
): Extract<V3EgressResult, { readonly ok: false }> {
	return ObjectFreeze({ detail, kind, ok: false as const });
}

function egressSuccess(kind: "empty" | "published"): Extract<V3EgressResult, { readonly ok: true }> {
	return ObjectFreeze({ kind, ok: true as const });
}

function localIssueFailure(
	kind: Exclude<Extract<V3LocalIssueResult, { readonly ok: false }>["kind"], "split-required">,
	detail: string
): Exclude<Extract<V3LocalIssueResult, { readonly ok: false }>, { readonly kind: "split-required" }> {
	return ObjectFreeze({ detail, kind, ok: false as const });
}

function localIssueSplit(
	prefixLength: number
): Extract<V3LocalIssueResult, { readonly ok: false; readonly kind: "split-required" }> {
	return ObjectFreeze({
		detail: "v3 local issue application batch requires an exact prefix split",
		kind: "split-required" as const,
		ok: false as const,
		prefixLength,
	});
}

function localIssueSuccess(authorSequence: number, digest: string): Extract<V3LocalIssueResult, { readonly ok: true }> {
	return ObjectFreeze({ authorSequence, digest, kind: "accepted" as const, ok: true as const });
}

function denseStrings(value: unknown): readonly string[] | undefined {
	try {
		if (!ArrayIsArray(value)) return undefined;
		const lengthDescriptor = ObjectGetOwnPropertyDescriptor(value, "length");
		if (
			lengthDescriptor === undefined ||
			!("value" in lengthDescriptor) ||
			!NumberIsSafeInteger(lengthDescriptor.value)
		) {
			return undefined;
		}
		if (value.length !== lengthDescriptor.value) return undefined;
		const result: string[] = [];
		for (let index = 0; index < lengthDescriptor.value; index += 1) {
			const descriptor = ObjectGetOwnPropertyDescriptor(value, StringConstructor(index));
			if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string")
				return undefined;
			ObjectDefineProperty(result, StringConstructor(index), {
				configurable: true,
				enumerable: true,
				value: descriptor.value,
				writable: true,
			});
		}
		return ObjectFreeze(result);
	} catch {
		return undefined;
	}
}

function topicMembership(networkNode: DRPNetworkNode, topic: string): boolean | undefined {
	try {
		const topics = denseStrings(networkNode.getSubscribedTopics());
		if (topics === undefined) return undefined;
		for (let index = 0; index < topics.length; index += 1) if (topics[index] === topic) return true;
		return false;
	} catch {
		return undefined;
	}
}

function hasQueueGuarded(messageQueueManager: MessageQueueManager<Message>, queueId: string): boolean | undefined {
	try {
		const present = messageQueueManager.hasQueue(queueId);
		return typeof present === "boolean" ? present : undefined;
	} catch {
		return undefined;
	}
}

function cleanupActivationEffects(
	networkNode: DRPNetworkNode,
	messageQueueManager: MessageQueueManager<Message>,
	topic: string,
	queueId: string,
	networkSubscriptionAttempted: boolean
): boolean {
	if (networkSubscriptionAttempted) {
		try {
			networkNode.unsubscribe(topic);
		} catch {
			// Continue to the queue cleanup and observable postconditions.
		}
	}
	try {
		messageQueueManager.close(queueId);
	} catch {
		// Continue to both observable postconditions.
	}
	const topicAbsent = !networkSubscriptionAttempted || topicMembership(networkNode, topic) === false;
	const queueAbsent = hasQueueGuarded(messageQueueManager, queueId) === false;
	return topicAbsent && queueAbsent;
}

function activationFailureAfterCleanup(
	kind: V3PlaneActivationFailureKind,
	detail: string,
	networkNode: DRPNetworkNode,
	messageQueueManager: MessageQueueManager<Message>,
	topic: string,
	queueId: string,
	networkSubscriptionAttempted: boolean
): Extract<V3PlaneActivationResult, { readonly ok: false }> {
	const cleanupComplete = cleanupActivationEffects(
		networkNode,
		messageQueueManager,
		topic,
		queueId,
		networkSubscriptionAttempted
	);
	if (!cleanupComplete) {
		try {
			if (typeof ConsoleWarn === "function") {
				ReflectApply(ConsoleWarn, ConsoleObject, ["::v3-live:activation-cleanup-postcondition-failed"]);
			}
		} catch {
			// The fixed cleanup diagnostic cannot replace the original activation failure.
		}
	}
	return activationFailure(kind, detail);
}

function subscribeActivationQueue(
	messageQueueManager: MessageQueueManager<Message>,
	queueId: string,
	handler: (message: Message) => void | Promise<void>
): "capacity" | "failed" | "ok" {
	try {
		messageQueueManager.subscribe(queueId, handler);
		return "ok";
	} catch (error) {
		try {
			const message = isObject(error) ? ObjectGetOwnPropertyDescriptor(error, "message") : undefined;
			return message !== undefined && "value" in message && message.value === "Max number of queues reached"
				? "capacity"
				: "failed";
		} catch {
			return "failed";
		}
	}
}

function lowerHexDigest(bytes: Uint8Array): string | undefined {
	const length = typedArrayByteLength(bytes);
	if (length === undefined) return undefined;
	let result = "";
	for (let index = 0; index < length; index += 1) {
		const byte = bytes[index];
		if (byte === undefined) return undefined;
		result += HEX_DIGITS[(byte >>> 4) & 0x0f] + HEX_DIGITS[byte & 0x0f];
	}
	return result;
}

function publicKeyBytes(author: string): Uint8Array | undefined {
	if (!/^[0-9a-f]{64}$/u.test(author)) return undefined;
	const bytes = new Uint8ArrayConstructor(32);
	for (let index = 0; index < 32; index += 1) {
		const pair = author.slice(index * 2, index * 2 + 2);
		const value = Number.parseInt(pair, 16);
		if (!Number.isSafeInteger(value)) return undefined;
		bytes[index] = value;
	}
	return bytes;
}

function resolveV3AuthorizedAuthor(
	authorization: V3LiveAuthorization,
	author: string
): Readonly<{ readonly bytes: Uint8Array; readonly format: "raw" }> | undefined {
	if (authorization.kind === "author-list") {
		const resolved = resolveCurrentEpochAuthorizedAuthor({ authorization: authorization.value, author });
		return resolved.ok ? resolved.publicKey : undefined;
	}
	const authority = authorizeLatchedEnvelopeAuthor({ author, snapshot: authorization.value });
	const bytes = authority.ok && authority.authorized ? publicKeyBytes(author) : undefined;
	return bytes === undefined ? undefined : ObjectFreeze({ bytes, format: "raw" as const });
}

function isV3ApplicationAuthorAuthorized(authorization: V3LiveAuthorization, author: string): boolean {
	if (authorization.kind === "author-list") {
		return resolveCurrentEpochAuthorizedAuthor({ authorization: authorization.value, author }).ok;
	}
	const authority = authorizeLatchedApplicationWrite({ author, snapshot: authorization.value });
	return authority.ok && authority.authorized;
}

function aclOperation(author: string, digest: string, value: unknown): StagedLatchedAclOperation | null | undefined {
	if (!isObject(value)) return null;
	const action = ObjectGetOwnPropertyDescriptor(value, "action");
	if (action === undefined || !("value" in action) || action.value !== "acl") return null;
	const record = snapshotClosedRecord(value, ["action", "group", "kind", "target"]);
	if (
		record === undefined ||
		(record.kind !== "grant" && record.kind !== "revoke") ||
		(record.group !== "admin" && record.group !== "finality" && record.group !== "writer") ||
		typeof record.target !== "string" ||
		!/^[0-9a-f]{64}$/u.test(record.target)
	) {
		return undefined;
	}
	return ObjectFreeze({
		actor: author,
		digest,
		operation: ObjectFreeze({
			actor: author,
			group: record.group,
			kind: record.kind,
			target: record.target,
		}),
	});
}

function orderedLatchedOperations(
	operations: Map<string, StagedLatchedAclOperation>,
	candidate?: StagedLatchedAclOperation
): readonly StagedLatchedAclOperation[] {
	const selected = [...operations.values()];
	if (candidate !== undefined) selected.push(candidate);
	return ObjectFreeze(
		selected.sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0))
	);
}

function validateLatchedOperation(
	authorization: V3LiveAuthorization,
	operations: Map<string, StagedLatchedAclOperation>,
	candidate: StagedLatchedAclOperation | null | undefined
): boolean {
	if (candidate === null) return true;
	if (candidate === undefined || authorization.kind !== "latched-acl" || operations.has(candidate.digest)) return false;
	return stageLatchedAclOperations({
		operations: orderedLatchedOperations(operations, candidate).map(({ operation }) => operation),
		snapshot: authorization.value,
	}).ok;
}

function latchedAclPreview(
	authorization: V3LiveAuthorization,
	operations: Map<string, StagedLatchedAclOperation>
): Readonly<Record<string, unknown>> | undefined {
	if (authorization.kind !== "latched-acl") return undefined;
	const stagedOperations = orderedLatchedOperations(operations);
	const staged = stageLatchedAclOperations({
		operations: stagedOperations.map(({ operation }) => operation),
		snapshot: authorization.value,
	});
	if (!staged.ok) return undefined;
	const signers = deriveNextLatchedSignerSet({ snapshot: staged.next });
	if (!signers.ok) return undefined;
	return ObjectFreeze({
		current: authorization.value,
		next: staged.next,
		nextDigest: lowerHexDigest(hashDomain("ts-drp/latched-acl/v3", encodeCanonical(staged.next))),
		nextSigners: signers.signers,
		stagedOperations: ObjectFreeze(
			stagedOperations.map(({ actor, digest, operation }) =>
				ObjectFreeze({
					actor,
					digest,
					operation: ObjectFreeze({ group: operation.group, kind: operation.kind, target: operation.target }),
				})
			)
		),
	});
}

function deriveV3Topic(payload: PreparedV3LivePayload): string | undefined {
	try {
		const objectId = payload.provenance.objectId;
		const genesisAnchorDigest = payload.trust.trust.genesisAnchorDigest;
		if (typeof objectId !== "string" || !isDigestHex(genesisAnchorDigest)) return undefined;
		const encoder = new TextEncoderConstructor();
		const digest = hashDomain("ts-drp/live-topic/v3", encoder.encode(objectId), encoder.encode(genesisAnchorDigest));
		const hex = lowerHexDigest(digest);
		return hex === undefined || hex.length !== 64 ? undefined : `${V3_TOPIC_PREFIX}${hex}`;
	} catch {
		return undefined;
	}
}

function currentRegistration(registration: V3PlaneRegistration): boolean {
	if (!registration.active) return false;
	const registrations = v3PlaneRegistrations.get(registration.networkNode);
	if (registrations?.get(registration.topic) !== registration) return false;
	return topicMembership(registration.networkNode, registration.topic) === true;
}

function deactivateRegistration(registration: V3PlaneRegistration): boolean {
	registration.active = false;
	registration.releaseTerminalBarrier?.();
	registration.releaseTerminalBarrier = undefined;
	registration.terminalBarrier = undefined;
	registration.pendingIngress.clear();
	registration.pendingIngressBytes = 0;
	const registrations = v3PlaneRegistrations.get(registration.networkNode);
	if (registrations?.get(registration.topic) === registration) registrations.delete(registration.topic);
	try {
		registration.networkNode.unsubscribe(registration.topic);
	} catch {
		// Continue to queue cleanup and both observable postconditions.
	}
	try {
		registration.messageQueueManager.close(registration.queueId);
	} catch {
		// Continue to both observable postconditions.
	}
	const topicAbsent = topicMembership(registration.networkNode, registration.topic) === false;
	const queueAbsent = hasQueueGuarded(registration.messageQueueManager, registration.queueId) === false;
	return topicAbsent && queueAbsent;
}

function sameScope(left: DurableIssueScope, right: DurableIssueScope): boolean {
	return left.author === right.author && left.objectId === right.objectId;
}

function sameActivation(
	registration: V3PlaneRegistration,
	recovered: RecoveredV3LivePayload,
	input: PlainRecord
): boolean {
	const payload = recovered.prepared;
	return (
		registration.active &&
		registration.messageQueueManager === input.messageQueueManager &&
		registration.onAdmittedVertex === input.onAdmittedVertex &&
		registration.authorization === recovered.authorization &&
		registration.index === recovered.index &&
		registration.issuanceStore === recovered.issuanceStore &&
		registration.classifyTerminalVertex === recovered.classifyTerminalVertex &&
		registration.latchedOperations === recovered.latchedOperations &&
		registration.liveJournalStore === recovered.liveJournalStore &&
		sameScope(registration.issuanceScope, recovered.issuanceScope) &&
		registration.payload.provenance.objectId === payload.provenance.objectId &&
		registration.payload.provenance.epoch === payload.provenance.epoch &&
		registration.payload.provenance.anchorDigest === payload.provenance.anchorDigest &&
		registration.payload.liveStateRef.digest === payload.liveStateRef.digest
	);
}

function copiedScope(value: unknown): DurableIssueScope | undefined {
	const snapshot = snapshotClosedRecord(value, ISSUANCE_SCOPE_KEYS);
	if (snapshot === undefined || typeof snapshot.author !== "string" || typeof snapshot.objectId !== "string") {
		return undefined;
	}
	return ObjectFreeze({ author: snapshot.author, objectId: snapshot.objectId });
}

function payloadIsUsable(payload: PreparedV3LivePayload): boolean {
	return (
		isObject(payload) &&
		typeof payload.provenance.objectId === "string" &&
		payload.provenance.epoch === 0 &&
		isDigestHex(payload.provenance.anchorDigest) &&
		isObject(payload.admission) &&
		isObject(payload.trust) &&
		isObject(payload.trust.trust)
	);
}

type V3IngressFailureCategory =
	| ExtractAdmittedReceivedVertexFailureReason
	| "envelope-rejected"
	| "graph-rejected"
	| "journal-rejected"
	| "queue-rejected"
	| "sink-rejected";

function ingressFailureLog(category: V3IngressFailureCategory): void {
	try {
		if (typeof ConsoleWarn === "function") ReflectApply(ConsoleWarn, ConsoleObject, ["::v3-ingress", category]);
	} catch {
		// Logging is diagnostic-only and must not escape the queue boundary.
	}
}

function hasBoundedDependencies(payload: PreparedV3LivePayload, vertex: AuthenticatedRecoveryVertex): boolean {
	return (
		vertex.vertex.dependencies.length > 0 && vertex.vertex.dependencies.length <= payload.parameters.maxDependencies
	);
}

function hasInstalledDependencies(index: CausalityIndex, vertex: AuthenticatedRecoveryVertex): boolean {
	for (const dependency of vertex.vertex.dependencies) {
		if (!index.has(dependency)) return false;
	}
	return true;
}

function nextEpochBytes(current: number, byteCharge: number, maximum: number): number | undefined {
	if (
		!NumberIsSafeInteger(current) ||
		current < 0 ||
		!NumberIsSafeInteger(byteCharge) ||
		byteCharge < 1 ||
		!NumberIsSafeInteger(maximum) ||
		maximum < 1 ||
		byteCharge > maximum - current
	) {
		return undefined;
	}
	return current + byteCharge;
}

function hasGraphCapacity(registration: V3PlaneRegistration, byteCharge: number): boolean {
	return (
		registration.index.size < registration.payload.parameters.maxEpochVertices &&
		nextEpochBytes(registration.epochBytes, byteCharge, registration.payload.parameters.maxEpochBytes) !== undefined
	);
}

function releasePendingIngress(registration: V3PlaneRegistration, digest: string): void {
	const pending = registration.pendingIngress.get(digest);
	if (pending === undefined) return;
	registration.pendingIngress.delete(digest);
	registration.pendingIngressBytes -= pending.pendingByteCharge;
}

function retainPendingIngress(
	registration: V3PlaneRegistration,
	evidence: VerifiedV3IngressEvidence,
	pendingByteCharge: number
): void {
	const authenticated = evidence.authenticated;
	if (registration.pendingIngress.has(authenticated.digest)) return;
	if (
		registration.pendingIngress.size >= registration.payload.parameters.maxPendingEntries ||
		registration.pendingIngressBytes + pendingByteCharge > registration.payload.parameters.maxPendingBytes
	) {
		return ingressFailureLog("graph-rejected");
	}
	registration.pendingIngress.set(
		authenticated.digest,
		ObjectFreeze({
			evidence,
			pendingByteCharge,
		})
	);
	registration.pendingIngressBytes += pendingByteCharge;
}

async function drainPendingIngress(registration: V3PlaneRegistration): Promise<void> {
	if (registration.drainingPendingIngress || !currentRegistration(registration)) return;
	registration.drainingPendingIngress = true;
	try {
		for (;;) {
			const ready = [...registration.pendingIngress.entries()]
				.filter(([, pending]) =>
					pending.evidence.authenticated.vertex.dependencies.every((dependency) => registration.index.has(dependency))
				)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
			if (ready.length === 0) return;
			for (const [digest, pending] of ready) {
				if (!currentRegistration(registration)) return;
				releasePendingIngress(registration, digest);
				await handleV3Ingress(registration, pending.evidence);
			}
		}
	} finally {
		registration.drainingPendingIngress = false;
	}
}

function extractAuthorizedV3Vertex(
	payload: PreparedV3LivePayload,
	receivedCanonicalPreimageBytes: Uint8Array,
	signature: Uint8Array,
	resolveAuthorPublicKey: AdmitReceivedVertexInput["resolveAuthorPublicKey"]
): ReturnType<typeof extractAdmittedReceivedVertex> | undefined {
	if (V3_VERTEX_DOMAIN !== vertexRegistry.domain || typeof V3_VERTEX_SUITE_ID !== "string") return undefined;
	const domain = V3_VERTEX_DOMAIN;
	const expectedAnchor = payload.provenance.anchorDigest;
	const preparedBlueprintAdmission = payload.admission;
	const suiteId = V3_VERTEX_SUITE_ID;
	const extracted = extractAdmittedReceivedVertex({
		domain,
		expectedAnchor,
		preparedBlueprintAdmission,
		receivedCanonicalPreimageBytes,
		resolveAuthorPublicKey,
		signature,
		suiteId,
	});
	if (!extracted.ok) return extracted;
	const classification = classifyV3EnvelopeScope(
		ObjectFreeze({
			anchor: extracted.vertex.anchor,
			epoch: extracted.vertex.epoch,
			objectId: extracted.vertex.objectId,
			protocolMajor: extracted.vertex.protocolMajor,
		}),
		ObjectFreeze({
			anchorDigest: payload.provenance.anchorDigest,
			epoch: payload.provenance.epoch,
			objectId: payload.provenance.objectId,
			protocolMajor: 3 as const,
		})
	);
	return classification.current
		? extracted
		: ObjectFreeze({ ok: false as const, reason: "admission-rejected" as const });
}

async function handleV3Ingress(
	registration: V3PlaneRegistration,
	evidence: VerifiedV3IngressEvidence
): Promise<boolean> {
	if (!currentRegistration(registration)) return false;
	const authenticated = evidence.authenticated;
	const alreadyAccepted = registration.index.has(authenticated.digest);
	let terminalClassification: ReturnType<V3TerminalVertexClassifier> = "ordinary";
	if (!alreadyAccepted && registration.classifyTerminalVertex !== undefined) {
		try {
			terminalClassification = registration.classifyTerminalVertex(
				ObjectFreeze({
					author: authenticated.author,
					exactReceivedCanonicalPreimageBytes: new Uint8ArrayConstructor(evidence.exactCanonicalPreimageBytes),
					signature: new Uint8ArrayConstructor(evidence.signature),
					vertex: authenticated.admitted,
				})
			);
		} catch {
			terminalClassification = "reject";
		}
		if (terminalClassification === "reject" || registration.terminalState === "terminal") {
			ingressFailureLog("admission-rejected");
			return false;
		}
	}
	if (!alreadyAccepted && !hasInstalledDependencies(registration.index, authenticated)) {
		ingressFailureLog("graph-rejected");
		return false;
	}
	if (
		!alreadyAccepted &&
		!acceptedApplicationOperation(
			registration.payload,
			authenticated.vertex.operation,
			authenticated.admitted.logicalTime
		)
	) {
		ingressFailureLog("admission-rejected");
		return false;
	}
	const candidate = aclOperation(authenticated.author, authenticated.digest, authenticated.vertex.operation);
	if (
		!alreadyAccepted &&
		!validateLatchedOperation(registration.authorization, registration.latchedOperations, candidate)
	) {
		ingressFailureLog("admission-rejected");
		return false;
	}
	if (!alreadyAccepted && !hasGraphCapacity(registration, authenticated.byteCharge)) {
		ingressFailureLog("graph-rejected");
		return false;
	}
	if (!alreadyAccepted && terminalClassification === "terminal-authorized") {
		// Once authenticated terminal evidence reaches the durable boundary, any
		// write outcome is ambiguous until recovery. Keep this live capability
		// fail closed even when the journal adapter throws after committing.
		registration.terminalState = "terminal";
	}
	let appended;
	try {
		appended = await registration.liveJournalStore.appendAccepted({
			detachedSignature: new Uint8ArrayConstructor(evidence.signature),
			exactCanonicalPreimageBytes: new Uint8ArrayConstructor(evidence.exactCanonicalPreimageBytes),
			scope: liveJournalScope(registration.payload),
			sourceKind: "received",
			vertexDigest: authenticated.digest,
		});
	} catch {
		ingressFailureLog("journal-rejected");
		return false;
	}
	if (
		!appended.ok ||
		appended.vertexDigest !== authenticated.digest ||
		!sameLiveJournalScope(appended.scope, liveJournalScope(registration.payload)) ||
		(alreadyAccepted ? !appended.idempotent : appended.idempotent || appended.sourceKind !== "received")
	) {
		ingressFailureLog("journal-rejected");
		return false;
	}
	if (alreadyAccepted) {
		releasePendingIngress(registration, authenticated.digest);
		return false;
	}
	const updatedEpochBytes = nextEpochBytes(
		registration.epochBytes,
		authenticated.byteCharge,
		registration.payload.parameters.maxEpochBytes
	);
	if (updatedEpochBytes === undefined) {
		ingressFailureLog("graph-rejected");
		return false;
	}
	try {
		const outcome = registration.index.append(authenticated.digest, authenticated.vertex, authenticated.byteCharge);
		if (outcome !== undefined) {
			ingressFailureLog("graph-rejected");
			return false;
		}
		registration.epochBytes = updatedEpochBytes;
	} catch {
		ingressFailureLog("graph-rejected");
		return false;
	}
	retainApplicationVertex(registration.applicationVertices, registration.applicationAuthors, authenticated);
	registration.graphVersion += 1;
	if (candidate !== null && candidate !== undefined) registration.latchedOperations.set(candidate.digest, candidate);
	releasePendingIngress(registration, authenticated.digest);
	if (!currentRegistration(registration)) return true;
	const delivery = ObjectFreeze({
		vertex: authenticated.admitted,
		exactReceivedCanonicalPreimageBytes: new Uint8ArrayConstructor(evidence.exactCanonicalPreimageBytes),
		signature: new Uint8ArrayConstructor(evidence.signature),
		transportSender: evidence.transportSender,
	});
	let disposition: Awaited<ReturnType<V3AdmittedVertexSink>> = undefined;
	try {
		disposition = await registration.onAdmittedVertex(delivery);
	} catch {
		ingressFailureLog("sink-rejected");
	}
	if (terminalClassification === "terminal-authorized") {
		registration.terminalState = "terminal";
		if (disposition?.kind !== "terminal-accepted") ingressFailureLog("sink-rejected");
	}
	if (registration.retainedBootstrapHold && disposition?.kind === "retained-bootstrap-ready") {
		registration.retainedBootstrapHold = false;
	}
	return true;
}

async function authenticateV3Ingress(
	registration: V3PlaneRegistration,
	message: Message,
	transport: "gossip" | "retained"
): Promise<void> {
	try {
		if (!currentRegistration(registration) || registration.blueprintClosing) return;
		if (registration.retainedBootstrapHold && transport === "gossip") {
			ingressFailureLog("admission-rejected");
			return;
		}
		if (message.type !== MessageType.MESSAGE_TYPE_V3_ENVELOPE) return;
		const gossipTopic = registration.networkNode.gossipTopicFor(message);
		if (transport === "gossip" ? gossipTopic !== registration.topic : gossipTopic !== undefined) return;
		if (message.objectId !== registration.topic) return;
		let exactWireBytes: Uint8Array;
		let receivedCanonicalPreimageBytes: Uint8Array;
		let signature: Uint8Array;
		try {
			const detachedWireBytes = copyDetachedBytes(message.data);
			if (detachedWireBytes === undefined || detachedWireBytes.byteLength === 0) {
				ingressFailureLog("envelope-rejected");
				return;
			}
			exactWireBytes = detachedWireBytes;
			const decoded = V3Envelope.decode(exactWireBytes);
			const canonicalEnvelope = V3Envelope.encode(decoded).finish();
			if (!sameBytes(exactWireBytes, canonicalEnvelope)) {
				ingressFailureLog("envelope-rejected");
				return;
			}
			const detachedPreimage = copyDetachedBytes(decoded.canonicalPreimage);
			const detachedSignature = copyDetachedBytes(decoded.signature);
			if (detachedPreimage === undefined || detachedSignature === undefined) {
				ingressFailureLog("envelope-rejected");
				return;
			}
			receivedCanonicalPreimageBytes = detachedPreimage;
			signature = detachedSignature;
		} catch {
			ingressFailureLog("envelope-rejected");
			return;
		}
		let extracted;
		try {
			extracted = extractAuthorizedV3Vertex(registration.payload, receivedCanonicalPreimageBytes, signature, (author) =>
				resolveV3AuthorizedAuthor(registration.authorization, author)
			);
		} catch {
			ingressFailureLog("malformed-input");
			return;
		}
		if (extracted === undefined) {
			ingressFailureLog("malformed-input");
			return;
		}
		if (!extracted.ok) {
			ingressFailureLog(extracted.reason);
			return;
		}
		const authenticated = authenticatedRecoveryVertex(extracted.vertex, receivedCanonicalPreimageBytes.byteLength);
		if (authenticated === undefined) return ingressFailureLog("malformed-input");
		if (!hasBoundedDependencies(registration.payload, authenticated)) return ingressFailureLog("admission-rejected");
		const evidence = ObjectFreeze({
			authenticated,
			exactCanonicalPreimageBytes: new Uint8ArrayConstructor(receivedCanonicalPreimageBytes),
			signature: new Uint8ArrayConstructor(signature),
			transportSender: message.sender,
		});
		if (!registration.index.has(authenticated.digest) && !hasInstalledDependencies(registration.index, authenticated)) {
			retainPendingIngress(registration, evidence, exactWireBytes.byteLength);
			return ingressFailureLog("graph-rejected");
		}
		if (await handleV3Ingress(registration, evidence)) await drainPendingIngress(registration);
	} catch {
		ingressFailureLog("envelope-rejected");
	}
}

function enqueueRegistrationTask<Result>(
	registration: V3PlaneRegistration,
	capture: () => () => Promise<Result>
): Promise<Result> {
	const predecessor = registration.gate;
	let release!: () => void;
	const reservation = new Promise<void>((resolve) => {
		release = resolve;
	});
	registration.gate = reservation;
	let task: () => Promise<Result>;
	try {
		task = capture();
	} catch (error) {
		task = (): Promise<Result> => Promise.reject(error);
	}
	let result: Promise<Result>;
	try {
		result = predecessor === undefined ? task() : predecessor.then(task);
	} catch (error) {
		result = Promise.reject(error);
	}
	const completion = result.then(
		() => undefined,
		() => undefined
	);
	if (registration.gate === reservation) registration.gate = completion;
	void result.then(release, release);
	return result;
}

function enqueueV3Ingress(
	registration: V3PlaneRegistration,
	message: Message,
	transport: "gossip" | "retained" = "gossip"
): Promise<void> {
	const barrier = registration.terminalBarrier;
	const enqueue = (): Promise<void> =>
		enqueueRegistrationTask(
			registration,
			(): (() => Promise<void>) => () => authenticateV3Ingress(registration, message, transport)
		);
	return barrier === undefined ? enqueue() : barrier.then(enqueue);
}

interface SnapshottedOutboxRow {
	readonly authorSequence: number;
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly publishState: "pending" | "published";
	readonly scope: DurableIssueScope;
	readonly signature: Uint8Array;
}

function envelopeSnapshot(value: unknown):
	| Readonly<{
			canonicalPreimageBytes: Uint8Array;
			digest: Uint8Array;
			signature: Uint8Array;
	  }>
	| undefined {
	const envelope = snapshotClosedRecord(value, SIGNED_ENVELOPE_KEYS);
	if (envelope === undefined) return undefined;
	const canonicalPreimageBytes = copyDetachedBytes(envelope.canonicalPreimageBytes);
	const digest = copyDetachedBytes(envelope.digest);
	const signature = copyDetachedBytes(envelope.signature);
	return canonicalPreimageBytes === undefined || digest === undefined || signature === undefined
		? undefined
		: ObjectFreeze({ canonicalPreimageBytes, digest, signature });
}

function outboxRowSnapshot(value: unknown, selectedScope: DurableIssueScope): SnapshottedOutboxRow | undefined {
	try {
		const record = snapshotClosedRecord(value, OUTBOX_RECORD_KEYS);
		if (record === undefined || (record.publishState !== "pending" && record.publishState !== "published"))
			return undefined;
		const commit = snapshotClosedRecord(record.commit, ISSUE_COMMIT_KEYS);
		if (commit === undefined || !NumberIsSafeInteger(commit.authorSequence) || (commit.authorSequence as number) < 0) {
			return undefined;
		}
		const issued = snapshotClosedRecord(commit.issuedRecord, ISSUED_RECORD_KEYS);
		const outbox = snapshotClosedRecord(commit.outboxEntry, OUTBOX_ENTRY_KEYS);
		if (issued === undefined || outbox === undefined) return undefined;
		const issuedScope = copiedScope(issued.scope);
		const outboxScope = copiedScope(outbox.scope);
		if (
			issued.authorSequence !== commit.authorSequence ||
			outbox.authorSequence !== commit.authorSequence ||
			issuedScope === undefined ||
			outboxScope === undefined ||
			!sameScope(issuedScope, outboxScope) ||
			!sameScope(issuedScope, selectedScope)
		) {
			return undefined;
		}
		const envelope = envelopeSnapshot(commit.envelope);
		const issuedEnvelope = envelopeSnapshot(issued.envelope);
		const outboxEnvelope = envelopeSnapshot(outbox.envelope);
		if (
			envelope === undefined ||
			issuedEnvelope === undefined ||
			outboxEnvelope === undefined ||
			!sameBytes(envelope.canonicalPreimageBytes, issuedEnvelope.canonicalPreimageBytes) ||
			!sameBytes(envelope.canonicalPreimageBytes, outboxEnvelope.canonicalPreimageBytes) ||
			!sameBytes(envelope.digest, issuedEnvelope.digest) ||
			!sameBytes(envelope.digest, outboxEnvelope.digest) ||
			!sameBytes(envelope.signature, issuedEnvelope.signature) ||
			!sameBytes(envelope.signature, outboxEnvelope.signature)
		) {
			return undefined;
		}
		return ObjectFreeze({
			authorSequence: commit.authorSequence as number,
			canonicalPreimageBytes: envelope.canonicalPreimageBytes,
			digest: envelope.digest,
			publishState: record.publishState,
			scope: issuedScope,
			signature: envelope.signature,
		});
	} catch {
		return undefined;
	}
}

function onePage(value: unknown): DurableIssuanceOutboxRecord | null | undefined {
	try {
		if (!ArrayIsArray(value)) return undefined;
		const length = ObjectGetOwnPropertyDescriptor(value, "length");
		if (length === undefined || !("value" in length) || (length.value !== 0 && length.value !== 1)) return undefined;
		if (length.value === 0) return null;
		const first = ObjectGetOwnPropertyDescriptor(value, "0");
		return first === undefined || !("value" in first) ? undefined : (first.value as DurableIssuanceOutboxRecord);
	} catch {
		return undefined;
	}
}

type V3LiveAuthorization =
	| Readonly<{ readonly kind: "author-list"; readonly value: CurrentEpochAuthorAuthorization }>
	| Readonly<{ readonly kind: "latched-acl"; readonly value: LatchedAclSnapshot }>;

interface V3DisplacedSourceAuthority {
	readonly activationVertexDigest?: string;
	readonly authorization: V3LiveAuthorization;
	readonly issuanceScope?: DurableIssueScope;
	readonly issuanceStore?: DurableIssuanceStore;
	readonly liveJournalStore?: DurableLiveJournalStore;
	readonly prepared: PreparedV3LivePayload;
}

type StagedLatchedAclOperation = Readonly<{
	readonly actor: string;
	readonly digest: string;
	readonly operation: Exclude<LatchedAclOperation, { readonly kind: "set-finality-key" }>;
}>;

interface RecoveredV3LivePayload {
	readonly applicationAuthors: Map<string, string>;
	readonly applicationVertices: Map<string, EpochVertex>;
	readonly authorization: V3LiveAuthorization;
	readonly classifyTerminalVertex?: V3TerminalVertexClassifier;
	readonly displacedSource?: V3DisplacedSourceAuthority;
	readonly epochBytes: number;
	readonly index: CausalityIndex;
	readonly issuanceScope: DurableIssueScope;
	readonly issuanceStore: DurableIssuanceStore;
	readonly latchedOperations: Map<string, StagedLatchedAclOperation>;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly prepared: PreparedV3LivePayload;
	readonly quarantinedDigests: ReadonlySet<string>;
	readonly retainedBootstrapHold: boolean;
	readonly terminal: boolean;
}

const recoveredV3LiveAuthority = new WeakMap<object, RecoveredV3LivePayload>();

function consumeRecoveredV3Live(capability: RecoveredV3Live): RecoveredV3LivePayload | undefined {
	try {
		if (!isObject(capability)) return undefined;
		const recovered = recoveredV3LiveAuthority.get(capability);
		if (recovered === undefined) return undefined;
		recoveredV3LiveAuthority.delete(capability);
		return recovered;
	} catch {
		return undefined;
	}
}

type SnapshottedJournalRow =
	| Readonly<{
			readonly detachedSignature: Uint8Array;
			readonly exactCanonicalPreimageBytes: Uint8Array;
			readonly journalSequence: number;
			readonly sourceKind: "received";
			readonly vertexDigest: string;
	  }>
	| Readonly<{
			readonly author: string;
			readonly authorSequence: number;
			readonly journalSequence: number;
			readonly sourceKind: "local-issued";
			readonly vertexDigest: string;
	  }>;

interface AuthenticatedRecoveryVertex {
	readonly admitted: AdmittedReceivedVertexView;
	readonly author: string;
	readonly authorSequence: number;
	readonly byteCharge: number;
	readonly digest: string;
	readonly vertex: EpochVertex;
}

type ClassifiedPlaneVertex = Readonly<{
	authenticated: AuthenticatedRecoveryVertex;
	kind: "current" | "displaced";
}>;

function recoveryFailure(
	kind: RecoverV3LiveReplicaFailureKind,
	detail: string
): Extract<RecoverV3LiveReplicaResult, { readonly ok: false }> {
	return ObjectFreeze({ detail, kind, ok: false as const });
}

function liveJournalScope(payload: PreparedV3LivePayload): LiveJournalScope {
	return ObjectFreeze({
		anchorDigest: payload.provenance.anchorDigest,
		epoch: 0 as const,
		objectId: payload.provenance.objectId,
	});
}

function sameLiveJournalScope(value: unknown, expected: LiveJournalScope): boolean {
	const captured = snapshotClosedRecord(value, JOURNAL_SCOPE_KEYS);
	return (
		captured !== undefined &&
		captured.anchorDigest === expected.anchorDigest &&
		captured.epoch === expected.epoch &&
		captured.objectId === expected.objectId
	);
}

function journalRowSnapshot(
	value: unknown,
	expectedScope: LiveJournalScope,
	expectedSequence: number
): SnapshottedJournalRow | undefined {
	try {
		if (!isObject(value)) return undefined;
		const sourceDescriptor = ObjectGetOwnPropertyDescriptor(value, "sourceKind");
		if (sourceDescriptor === undefined || !("value" in sourceDescriptor)) return undefined;
		const keys =
			sourceDescriptor.value === "received"
				? JOURNAL_RECEIVED_ROW_KEYS
				: sourceDescriptor.value === "local-issued"
					? JOURNAL_LOCAL_ROW_KEYS
					: undefined;
		if (keys === undefined) return undefined;
		const row = snapshotClosedRecord(value, keys);
		if (
			row === undefined ||
			row.journalSequence !== expectedSequence ||
			!isDigestHex(row.vertexDigest) ||
			!sameLiveJournalScope(row.scope, expectedScope)
		) {
			return undefined;
		}
		if (row.sourceKind === "received") {
			const exactCanonicalPreimageBytes = copyDetachedBytes(row.exactCanonicalPreimageBytes);
			const detachedSignature = copyDetachedBytes(row.detachedSignature);
			return exactCanonicalPreimageBytes === undefined || detachedSignature?.byteLength !== 64
				? undefined
				: ObjectFreeze({
						detachedSignature,
						exactCanonicalPreimageBytes,
						journalSequence: expectedSequence,
						sourceKind: "received" as const,
						vertexDigest: row.vertexDigest,
					});
		}
		return typeof row.author !== "string" ||
			row.author.length === 0 ||
			!NumberIsSafeInteger(row.authorSequence) ||
			(row.authorSequence as number) < 0
			? undefined
			: ObjectFreeze({
					author: row.author,
					authorSequence: row.authorSequence as number,
					journalSequence: expectedSequence,
					sourceKind: "local-issued" as const,
					vertexDigest: row.vertexDigest,
				});
	} catch {
		return undefined;
	}
}

function authenticateRecoveryVertex(
	payload: PreparedV3LivePayload,
	authorization: V3LiveAuthorization,
	canonicalPreimageBytes: Uint8Array,
	signature: Uint8Array
): AuthenticatedRecoveryVertex | undefined {
	const extracted = extractAuthorizedV3Vertex(payload, canonicalPreimageBytes, signature, (author) => {
		return resolveV3AuthorizedAuthor(authorization, author);
	});
	if (extracted === undefined || !extracted.ok) return undefined;
	return authenticatedRecoveryVertex(extracted.vertex, canonicalPreimageBytes.byteLength);
}

function classifyPlaneVertex(
	payload: PreparedV3LivePayload,
	authorization: V3LiveAuthorization,
	displacedSource: V3DisplacedSourceAuthority | undefined,
	canonicalPreimageBytes: Uint8Array,
	signature: Uint8Array,
	expectedDigest: string | undefined,
	expectedAuthor: string,
	expectedAuthorSequence: number
): ClassifiedPlaneVertex | undefined {
	const matches = (
		authenticated: AuthenticatedRecoveryVertex | undefined
	): authenticated is AuthenticatedRecoveryVertex =>
		authenticated !== undefined &&
		authenticated.digest === expectedDigest &&
		authenticated.author === expectedAuthor &&
		authenticated.authorSequence === expectedAuthorSequence;
	const current = authenticateRecoveryVertex(payload, authorization, canonicalPreimageBytes, signature);
	if (matches(current)) return ObjectFreeze({ authenticated: current, kind: "current" as const });
	if (displacedSource === undefined) return undefined;
	const displaced = authenticateRecoveryVertex(
		displacedSource.prepared,
		displacedSource.authorization,
		canonicalPreimageBytes,
		signature
	);
	return matches(displaced) ? ObjectFreeze({ authenticated: displaced, kind: "displaced" as const }) : undefined;
}

function authenticatedRecoveryVertex(
	admitted: AdmittedReceivedVertexView,
	byteCharge: number
): AuthenticatedRecoveryVertex | undefined {
	const digest = lowerHexDigest(admitted.digest);
	if (digest === undefined) return undefined;
	return ObjectFreeze({
		admitted,
		author: admitted.author,
		authorSequence: admitted.authorSequence,
		byteCharge,
		digest,
		vertex: ObjectFreeze({
			anchor: admitted.anchor,
			dependencies: [...admitted.dependencies],
			epoch: admitted.epoch,
			hash: digest,
			kind: admitted.kind,
			objectId: admitted.objectId,
			operation: admitted.operation as NonNullable<EpochVertex["operation"]>,
		}),
	});
}

function matchingOutboxRows(left: SnapshottedOutboxRow, right: SnapshottedOutboxRow): boolean {
	return (
		left.authorSequence === right.authorSequence &&
		sameScope(left.scope, right.scope) &&
		sameBytes(left.canonicalPreimageBytes, right.canonicalPreimageBytes) &&
		sameBytes(left.digest, right.digest) &&
		sameBytes(left.signature, right.signature)
	);
}

function openRecoveryAuthorization(
	payload: PreparedV3LivePayload,
	exactAuthorizationBytes: Uint8Array,
	kind: "author-list" | "latched-acl"
): V3LiveAuthorization | undefined {
	if (kind === "author-list") {
		const opened = openCurrentEpochAuthorAuthorization({
			detachedAnchorSignature: payload.input.detachedSignature,
			exactCanonicalAnchorPreimageBytes: payload.input.exactCanonicalAnchorPreimageBytes,
			exactCanonicalAuthorAuthorizationBytes: exactAuthorizationBytes,
			trust: payload.trust.trust,
		});
		return opened.ok ? ObjectFreeze({ kind: "author-list" as const, value: opened.authorization }) : undefined;
	}
	const anchor = decodeCanonical(payload.input.exactCanonicalAnchorPreimageBytes);
	const aclDigest = isObject(anchor) ? Reflect.get(anchor, "aclDigest") : undefined;
	const opened = openCanonicalLatchedAclSnapshot({
		exactCanonicalLatchedAclBytes: exactAuthorizationBytes,
		expectedAclDigest: typeof aclDigest === "string" ? aclDigest : "",
		expectedEpoch: payload.provenance.epoch,
		expectedObjectId: payload.provenance.objectId,
	});
	return opened.ok ? ObjectFreeze({ kind: "latched-acl" as const, value: opened.snapshot }) : undefined;
}

/**
 * Recovers one authorized durable local vertex before any live effect is installed.
 * @param rawInput - Closed durable recovery bindings and the one-use prepared capability.
 * @returns An opaque recovered capability or a closed fail-closed result.
 */
export async function recoverV3LiveReplica(rawInput: RecoverV3LiveReplicaInput): Promise<RecoverV3LiveReplicaResult> {
	try {
		const legacyInput =
			snapshotClosedRecord(rawInput, LEGACY_RECOVERY_INPUT_KEYS) ??
			snapshotClosedRecord(rawInput, LEGACY_DISPLACED_RECOVERY_INPUT_KEYS);
		const latchedInput =
			snapshotClosedRecord(rawInput, LATCHED_RECOVERY_INPUT_KEYS) ??
			snapshotClosedRecord(rawInput, LATCHED_DISPLACED_RECOVERY_INPUT_KEYS) ??
			snapshotClosedRecord(rawInput, LATCHED_TERMINAL_RECOVERY_INPUT_KEYS) ??
			snapshotClosedRecord(rawInput, LATCHED_CROSS_OBJECT_RECOVERY_INPUT_KEYS) ??
			snapshotClosedRecord(rawInput, LATCHED_RETAINED_BOOTSTRAP_RECOVERY_INPUT_KEYS);
		const input = legacyInput ?? latchedInput;
		if (input === undefined) return recoveryFailure("malformed-input", "v3 recovery input is invalid");
		const terminalClassifier = Reflect.get(input, "classifyTerminalVertex");
		if (terminalClassifier !== undefined && typeof terminalClassifier !== "function") {
			return recoveryFailure("malformed-input", "v3 terminal classifier is invalid");
		}
		const retainedBootstrapHold = Reflect.get(input, "retainedBootstrapHold") === true;
		const exactAuthorizationBytes =
			legacyInput === undefined
				? copyDetachedBytes(input.exactCanonicalLatchedAclBytes)
				: copyDetachedBytes(input.exactCanonicalAuthorAuthorizationBytes);
		const selectedScope = copiedScope(input.issuanceScope);
		if (
			exactAuthorizationBytes === undefined ||
			exactAuthorizationBytes.byteLength === 0 ||
			selectedScope === undefined ||
			!isObject(input.issuanceStore) ||
			!isObject(input.liveJournalStore)
		) {
			return recoveryFailure("malformed-input", "v3 recovery binding is invalid");
		}
		const payload = consumePreparedV3Live(input.capability as PreparedV3Live);
		if (payload === undefined) return recoveryFailure("capability-consumed", "v3 capability is unavailable");
		if (!payloadIsUsable(payload) || selectedScope.objectId !== payload.provenance.objectId) {
			return recoveryFailure("authorization-rejected", "v3 recovery authorization does not match");
		}
		const authorization = openRecoveryAuthorization(
			payload,
			exactAuthorizationBytes,
			legacyInput !== undefined ? "author-list" : "latched-acl"
		);
		if (authorization === undefined) {
			return recoveryFailure("authorization-rejected", "v3 recovery authorization does not match");
		}
		if (resolveV3AuthorizedAuthor(authorization, selectedScope.author) === undefined) {
			return recoveryFailure("authorization-rejected", "v3 recovery author is not authorized");
		}

		let displacedSource: V3DisplacedSourceAuthority | undefined;
		const rawDisplacedSource = Reflect.get(input, "displacedSource");
		if (rawDisplacedSource !== undefined) {
			const legacySource = snapshotClosedRecord(rawDisplacedSource, DISPLACED_LEGACY_SOURCE_KEYS);
			const latchedSource = snapshotClosedRecord(rawDisplacedSource, DISPLACED_LATCHED_SOURCE_KEYS);
			const crossSource = snapshotClosedRecord(rawDisplacedSource, DISPLACED_CROSS_OBJECT_SOURCE_KEYS);
			const source = legacySource ?? latchedSource ?? crossSource;
			if (source === undefined) return recoveryFailure("malformed-input", "v3 displaced source input is invalid");
			const sourceBytes = copyDetachedBytes(
				legacySource === undefined
					? source.exactCanonicalLatchedAclBytes
					: source.exactCanonicalAuthorAuthorizationBytes
			);
			if (sourceBytes === undefined || sourceBytes.byteLength === 0) {
				return recoveryFailure("malformed-input", "v3 displaced source authorization is invalid");
			}
			const sourcePayload = consumePreparedV3Live(source.capability as PreparedV3Live);
			if (
				sourcePayload === undefined ||
				!payloadIsUsable(sourcePayload) ||
				(crossSource === undefined
					? sourcePayload.provenance.objectId !== payload.provenance.objectId
					: sourcePayload.provenance.objectId === payload.provenance.objectId) ||
				sourcePayload.provenance.anchorDigest === payload.provenance.anchorDigest ||
				sourcePayload.provenance.blueprintDigest !== payload.provenance.blueprintDigest ||
				sourcePayload.provenance.signerSetDigest !== payload.provenance.signerSetDigest
			) {
				return recoveryFailure("authorization-rejected", "v3 displaced source provenance does not match");
			}
			const sourceAuthorization = openRecoveryAuthorization(
				sourcePayload,
				sourceBytes,
				legacySource !== undefined ? "author-list" : "latched-acl"
			);
			if (
				sourceAuthorization === undefined ||
				resolveV3AuthorizedAuthor(sourceAuthorization, selectedScope.author) === undefined
			) {
				return recoveryFailure("authorization-rejected", "v3 displaced source authorization does not match");
			}
			if (crossSource !== undefined) {
				const sourceScope = copiedScope(crossSource.issuanceScope);
				if (
					!isDigestHex(crossSource.activationVertexDigest) ||
					sourceScope === undefined ||
					sourceScope.objectId !== sourcePayload.provenance.objectId ||
					sourceScope.author !== selectedScope.author ||
					!isObject(crossSource.issuanceStore) ||
					!isObject(crossSource.liveJournalStore)
				) {
					return recoveryFailure("authorization-rejected", "v3 displaced source authority does not match");
				}
				displacedSource = ObjectFreeze({
					activationVertexDigest: crossSource.activationVertexDigest,
					authorization: sourceAuthorization,
					issuanceScope: sourceScope,
					issuanceStore: crossSource.issuanceStore as DurableIssuanceStore,
					liveJournalStore: crossSource.liveJournalStore as DurableLiveJournalStore,
					prepared: sourcePayload,
				});
			} else {
				displacedSource = ObjectFreeze({ authorization: sourceAuthorization, prepared: sourcePayload });
			}
		}

		const journal = input.liveJournalStore as DurableLiveJournalStore;
		const issuance = input.issuanceStore as DurableIssuanceStore;
		const scope = liveJournalScope(payload);
		let installed;
		try {
			installed = await journal.installGenesis({
				detachedAnchorSignature: new Uint8ArrayConstructor(payload.input.detachedSignature),
				exactCanonicalAnchorPreimageBytes: new Uint8ArrayConstructor(payload.input.exactCanonicalAnchorPreimageBytes),
				exactCanonicalParametersCarrierBytes: new Uint8ArrayConstructor(
					payload.input.exactCanonicalParametersCarrierBytes
				),
				objectId: payload.provenance.objectId,
			});
		} catch {
			return recoveryFailure("journal-rejected", "v3 journal genesis installation failed");
		}
		if (
			!installed.ok ||
			installed.scope.objectId !== scope.objectId ||
			installed.scope.epoch !== scope.epoch ||
			installed.scope.anchorDigest !== scope.anchorDigest ||
			installed.parametersDigest !== payload.provenance.parametersDigest
		) {
			return recoveryFailure("journal-rejected", "v3 journal genesis does not match");
		}

		let readiness;
		try {
			readiness = await journal.readiness({ scope });
		} catch {
			return recoveryFailure("journal-rejected", "v3 journal readiness failed");
		}
		if (
			!readiness.ok ||
			!readiness.ready ||
			!NumberIsSafeInteger(readiness.rowCount) ||
			readiness.rowCount < 0 ||
			!sameLiveJournalScope(readiness.scope, scope)
		) {
			return recoveryFailure("journal-rejected", "v3 journal is not ready for recovery");
		}

		let index: CausalityIndex;
		try {
			index = new CausalityIndex(payload.vertices, payload.order, {
				initialByteCharges: payload.charges,
				maxEpochBytes: payload.parameters.maxEpochBytes,
				maxEpochVertices: payload.parameters.maxEpochVertices,
			});
		} catch {
			return recoveryFailure("graph-rejected", "v3 recovery graph could not be constructed");
		}
		const applicationVertices = copyApplicationVertices(payload.vertices);
		if (applicationVertices === undefined) {
			return recoveryFailure("graph-rejected", "v3 recovery graph could not be retained");
		}
		const applicationAuthors = new IntrinsicMap<string, string>();
		let epochBytes = 0;
		for (const byteCharge of payload.charges.values()) {
			const updated = nextEpochBytes(epochBytes, byteCharge, payload.parameters.maxEpochBytes);
			if (updated === undefined) return recoveryFailure("graph-rejected", "v3 recovery byte charge is invalid");
			epochBytes = updated;
		}
		const preparedVertexCount = index.size;
		let recoveredCount = 0;
		let recoveredTerminal = false;
		const recoveredVertices: AdmittedReceivedVertexView[] = [];
		const quarantinedDigests = new IntrinsicSet<string>();
		const latchedOperations = new IntrinsicMap<string, StagedLatchedAclOperation>();
		let journalAfterSequence: number | null = null;
		if (readiness.rowCount === 0) {
			let emptyPage;
			try {
				emptyPage = await journal.readPage({ afterSequence: null, limit: 1, scope, snapshot: readiness.snapshot });
			} catch {
				return recoveryFailure("journal-rejected", "v3 journal page read failed");
			}
			if (!emptyPage.ok || emptyPage.rows.length !== 0 || emptyPage.nextSequence !== null) {
				return recoveryFailure("journal-rejected", "v3 empty journal snapshot is inconsistent");
			}
		} else {
			for (let expectedSequence = 0; expectedSequence < readiness.rowCount; expectedSequence += 1) {
				let rawJournalPage;
				try {
					rawJournalPage = await journal.readPage({
						afterSequence: journalAfterSequence,
						limit: 1,
						scope,
						snapshot: readiness.snapshot,
					});
				} catch {
					return recoveryFailure("journal-rejected", "v3 journal page read failed");
				}
				if (!rawJournalPage.ok || rawJournalPage.rows.length !== 1) {
					return recoveryFailure("journal-rejected", "v3 journal page is incomplete");
				}
				const row = journalRowSnapshot(rawJournalPage.rows[0], scope, expectedSequence);
				if (row === undefined) return recoveryFailure("journal-rejected", "v3 journal row is invalid");
				const expectedNext = expectedSequence + 1 < readiness.rowCount ? expectedSequence : null;
				if (rawJournalPage.nextSequence !== expectedNext) {
					return recoveryFailure("journal-rejected", "v3 journal cursor is invalid");
				}

				let authenticated: AuthenticatedRecoveryVertex | undefined;
				let recoveredPreimageBytes: Uint8Array | undefined;
				let recoveredSignature: Uint8Array | undefined;
				try {
					if (row.sourceKind === "received") {
						recoveredPreimageBytes = row.exactCanonicalPreimageBytes;
						recoveredSignature = row.detachedSignature;
						authenticated = authenticateRecoveryVertex(
							payload,
							authorization,
							row.exactCanonicalPreimageBytes,
							row.detachedSignature
						);
					} else {
						const localScope = ObjectFreeze({ author: row.author, objectId: scope.objectId });
						const issuedCommit = await issuance.readIssued(localScope, row.authorSequence);
						const issuedRow = outboxRowSnapshot(
							ObjectFreeze({ commit: issuedCommit, publishState: "published" as const }),
							localScope
						);
						if (issuedRow !== undefined) {
							recoveredPreimageBytes = issuedRow.canonicalPreimageBytes;
							recoveredSignature = issuedRow.signature;
							authenticated = authenticateRecoveryVertex(
								payload,
								authorization,
								issuedRow.canonicalPreimageBytes,
								issuedRow.signature
							);
							if (
								authenticated?.author !== row.author ||
								authenticated.authorSequence !== row.authorSequence ||
								lowerHexDigest(issuedRow.digest) !== row.vertexDigest
							) {
								authenticated = undefined;
							}
						}
					}
				} catch {
					return recoveryFailure("admission-rejected", "v3 journal replay authentication failed");
				}
				if (
					authenticated === undefined ||
					authenticated.digest !== row.vertexDigest ||
					index.has(authenticated.digest)
				) {
					return recoveryFailure("admission-rejected", "v3 journal row is not authenticated");
				}
				if (
					!acceptedApplicationOperation(payload, authenticated.vertex.operation, authenticated.admitted.logicalTime) ||
					authenticated.vertex.dependencies.some(
						(dependency) => ReflectApply(SetPrototypeHas, quarantinedDigests, [dependency]) === true
					)
				) {
					ReflectApply(SetPrototypeAdd, quarantinedDigests, [authenticated.digest]);
					journalAfterSequence = expectedSequence;
					continue;
				}
				let terminalClassification: ReturnType<V3TerminalVertexClassifier> = "ordinary";
				if (
					typeof terminalClassifier === "function" &&
					recoveredPreimageBytes !== undefined &&
					recoveredSignature !== undefined
				) {
					try {
						terminalClassification = (terminalClassifier as V3TerminalVertexClassifier)(
							ObjectFreeze({
								author: authenticated.author,
								exactReceivedCanonicalPreimageBytes: new Uint8ArrayConstructor(recoveredPreimageBytes),
								signature: new Uint8ArrayConstructor(recoveredSignature),
								vertex: authenticated.admitted,
							})
						);
					} catch {
						terminalClassification = "reject";
					}
				}
				if (
					terminalClassification === "reject" ||
					(recoveredTerminal && terminalClassification !== "terminal-authorized")
				) {
					ReflectApply(SetPrototypeAdd, quarantinedDigests, [authenticated.digest]);
					journalAfterSequence = expectedSequence;
					continue;
				}
				if (!hasBoundedDependencies(payload, authenticated)) {
					return recoveryFailure("admission-rejected", "v3 journal row dependency bound is invalid");
				}
				const candidate = aclOperation(authenticated.author, authenticated.digest, authenticated.vertex.operation);
				if (!validateLatchedOperation(authorization, latchedOperations, candidate)) {
					return recoveryFailure("authorization-rejected", "v3 journal ACL operation is not authorized");
				}
				const updatedEpochBytes = nextEpochBytes(
					epochBytes,
					authenticated.byteCharge,
					payload.parameters.maxEpochBytes
				);
				if (updatedEpochBytes === undefined) {
					return recoveryFailure("graph-rejected", "v3 journal replay is at capacity");
				}
				try {
					const outcome = index.append(authenticated.digest, authenticated.vertex, authenticated.byteCharge);
					if (outcome !== undefined) return recoveryFailure("graph-rejected", "v3 journal replay is at capacity");
				} catch {
					return recoveryFailure("graph-rejected", "v3 journal replay graph append failed");
				}
				retainApplicationVertex(applicationVertices, applicationAuthors, authenticated);
				epochBytes = updatedEpochBytes;
				recoveredCount += 1;
				recoveredVertices.push(authenticated.admitted);
				if (candidate !== null && candidate !== undefined) latchedOperations.set(candidate.digest, candidate);
				if (terminalClassification === "terminal-authorized") recoveredTerminal = true;
				journalAfterSequence = expectedSequence;
			}
		}

		let afterKey: readonly [string, string, number] | undefined;
		let currentRecordCount = 0;
		let displacedRecordCount = 0;
		for (;;) {
			let rawPage: unknown;
			try {
				rawPage = await issuance.readOutboxPage(
					afterKey === undefined ? { limit: 1, scope: selectedScope } : { afterKey, limit: 1, scope: selectedScope }
				);
			} catch {
				return recoveryFailure("issuance-rejected", "v3 recovery outbox read failed");
			}
			const page = onePage(rawPage);
			if (page === undefined) return recoveryFailure("issuance-rejected", "v3 recovery outbox page is invalid");
			if (page === null) break;
			const row = outboxRowSnapshot(page, selectedScope);
			if (row === undefined || (afterKey !== undefined && row.authorSequence <= afterKey[2])) {
				return recoveryFailure("issuance-rejected", "v3 recovery outbox record is invalid");
			}
			let issuedCommit: unknown;
			try {
				issuedCommit = await issuance.readIssued(selectedScope, row.authorSequence);
			} catch {
				return recoveryFailure("issuance-rejected", "v3 recovery issued record read failed");
			}
			const issuedRow = outboxRowSnapshot(
				ObjectFreeze({ commit: issuedCommit, publishState: row.publishState }),
				selectedScope
			);
			if (issuedRow === undefined || !matchingOutboxRows(row, issuedRow)) {
				return recoveryFailure("issuance-rejected", "v3 recovery issued record does not match");
			}
			let classified: ClassifiedPlaneVertex | undefined;
			try {
				classified = classifyPlaneVertex(
					payload,
					authorization,
					displacedSource,
					row.canonicalPreimageBytes,
					row.signature,
					lowerHexDigest(row.digest),
					selectedScope.author,
					row.authorSequence
				);
			} catch {
				return recoveryFailure("admission-rejected", "v3 recovery admission failed");
			}
			if (classified?.kind === "displaced") {
				displacedRecordCount += 1;
				if (
					displacedRecordCount > (displacedSource as V3DisplacedSourceAuthority).prepared.parameters.maxEpochVertices
				) {
					return recoveryFailure("graph-rejected", "v3 displaced recovery graph is at capacity");
				}
				if (
					!acceptedApplicationOperation(
						(displacedSource as V3DisplacedSourceAuthority).prepared,
						classified.authenticated.vertex.operation,
						classified.authenticated.admitted.logicalTime
					) ||
					!hasBoundedDependencies((displacedSource as V3DisplacedSourceAuthority).prepared, classified.authenticated)
				) {
					return recoveryFailure("admission-rejected", "v3 recovery vertex is not authenticated");
				}
				afterKey = ObjectFreeze([selectedScope.objectId, selectedScope.author, row.authorSequence] as const);
				continue;
			}
			if (classified?.kind !== "current") {
				return recoveryFailure("admission-rejected", "v3 recovery vertex is not authenticated");
			}
			currentRecordCount += 1;
			if (currentRecordCount > payload.parameters.maxEpochVertices) {
				return recoveryFailure("graph-rejected", "v3 current recovery graph is at capacity");
			}
			const authenticated = classified.authenticated;
			if (
				!acceptedApplicationOperation(payload, authenticated.vertex.operation, authenticated.admitted.logicalTime) ||
				authenticated.vertex.dependencies.some(
					(dependency) => ReflectApply(SetPrototypeHas, quarantinedDigests, [dependency]) === true
				)
			) {
				ReflectApply(SetPrototypeAdd, quarantinedDigests, [authenticated.digest]);
				afterKey = ObjectFreeze([selectedScope.objectId, selectedScope.author, row.authorSequence] as const);
				continue;
			}
			if (!hasBoundedDependencies(payload, authenticated)) {
				return recoveryFailure("admission-rejected", "v3 recovery vertex dependency bound is invalid");
			}
			const alreadyRecovered = index.has(authenticated.digest);
			let terminalClassification: ReturnType<V3TerminalVertexClassifier> = "ordinary";
			if (!alreadyRecovered && typeof terminalClassifier === "function") {
				try {
					terminalClassification = (terminalClassifier as V3TerminalVertexClassifier)(
						ObjectFreeze({
							author: authenticated.author,
							exactReceivedCanonicalPreimageBytes: new Uint8ArrayConstructor(issuedRow.canonicalPreimageBytes),
							signature: new Uint8ArrayConstructor(issuedRow.signature),
							vertex: authenticated.admitted,
						})
					);
				} catch {
					terminalClassification = "reject";
				}
				if (
					terminalClassification === "reject" ||
					(recoveredTerminal && terminalClassification !== "terminal-authorized")
				) {
					return recoveryFailure("authorization-rejected", "v3 recovery terminal sequence is invalid");
				}
			}
			const candidate = aclOperation(authenticated.author, authenticated.digest, authenticated.vertex.operation);
			if (!alreadyRecovered && !validateLatchedOperation(authorization, latchedOperations, candidate)) {
				return recoveryFailure("authorization-rejected", "v3 recovery ACL operation is not authorized");
			}
			let updatedEpochBytes = epochBytes;
			if (!alreadyRecovered) {
				if (!hasInstalledDependencies(index, authenticated)) {
					return recoveryFailure("graph-rejected", "v3 recovery graph dependency is unavailable");
				}
				const nextBytes = nextEpochBytes(epochBytes, authenticated.byteCharge, payload.parameters.maxEpochBytes);
				if (nextBytes === undefined || index.size >= payload.parameters.maxEpochVertices) {
					return recoveryFailure("graph-rejected", "v3 recovery graph is at capacity");
				}
				updatedEpochBytes = nextBytes;
			}
			let appended;
			try {
				appended = await journal.appendAccepted({
					author: selectedScope.author,
					authorSequence: row.authorSequence,
					scope,
					sourceKind: "local-issued",
					vertexDigest: authenticated.digest,
				});
			} catch {
				return recoveryFailure("journal-rejected", "v3 recovery journal append failed");
			}
			if (
				!appended.ok ||
				appended.vertexDigest !== authenticated.digest ||
				(alreadyRecovered ? !appended.idempotent : appended.idempotent || appended.sourceKind !== "local-issued")
			) {
				return recoveryFailure("journal-rejected", "v3 recovery journal append was rejected");
			}
			if (!alreadyRecovered) {
				try {
					const outcome = index.append(authenticated.digest, authenticated.vertex, authenticated.byteCharge);
					if (outcome !== undefined) return recoveryFailure("graph-rejected", "v3 recovery graph is at capacity");
				} catch {
					return recoveryFailure("graph-rejected", "v3 recovery graph append failed");
				}
				retainApplicationVertex(applicationVertices, applicationAuthors, authenticated);
				epochBytes = updatedEpochBytes;
				recoveredCount += 1;
				recoveredVertices.push(authenticated.admitted);
				if (candidate !== null && candidate !== undefined) latchedOperations.set(candidate.digest, candidate);
				if (terminalClassification === "terminal-authorized") recoveredTerminal = true;
			}
			afterKey = ObjectFreeze([selectedScope.objectId, selectedScope.author, row.authorSequence] as const);
		}
		if (displacedSource?.activationVertexDigest !== undefined) {
			const sourceScope = displacedSource.issuanceScope;
			const sourceStore = displacedSource.issuanceStore;
			const sourceJournal = displacedSource.liveJournalStore;
			if (sourceScope === undefined || sourceStore === undefined || sourceJournal === undefined) {
				return recoveryFailure("authorization-rejected", "v3 displaced source authority is incomplete");
			}
			let sourceReadiness;
			try {
				sourceReadiness = await sourceJournal.readiness({ scope: liveJournalScope(displacedSource.prepared) });
			} catch {
				return recoveryFailure("journal-rejected", "v3 displaced source journal readiness failed");
			}
			if (
				!sourceReadiness.ok ||
				!sourceReadiness.ready ||
				!NumberIsSafeInteger(sourceReadiness.rowCount) ||
				(sourceReadiness.rowCount as number) < 1 ||
				(sourceReadiness.rowCount as number) > displacedSource.prepared.parameters.maxEpochVertices ||
				!sameLiveJournalScope(sourceReadiness.scope, liveJournalScope(displacedSource.prepared))
			) {
				return recoveryFailure("journal-rejected", "v3 displaced source journal is invalid");
			}
			let foundActivation = false;
			let sourceAfter: number | null = null;
			for (let sequence = 0; sequence < sourceReadiness.rowCount; sequence += 1) {
				let page;
				try {
					page = await sourceJournal.readPage({
						afterSequence: sourceAfter,
						limit: 1,
						scope: liveJournalScope(displacedSource.prepared),
						snapshot: sourceReadiness.snapshot,
					});
				} catch {
					return recoveryFailure("journal-rejected", "v3 displaced source journal read failed");
				}
				if (!page.ok || page.rows.length !== 1) {
					return recoveryFailure("journal-rejected", "v3 displaced source journal is incomplete");
				}
				const sourceRow = journalRowSnapshot(page.rows[0], liveJournalScope(displacedSource.prepared), sequence);
				if (sourceRow === undefined) {
					return recoveryFailure("journal-rejected", "v3 displaced source journal row is invalid");
				}
				let sourcePreimageBytes: Uint8Array;
				let sourceSignature: Uint8Array;
				let issued: SnapshottedOutboxRow | undefined;
				if (sourceRow.sourceKind === "received") {
					sourcePreimageBytes = sourceRow.exactCanonicalPreimageBytes;
					sourceSignature = sourceRow.detachedSignature;
				} else {
					let sourceCommit: unknown;
					try {
						sourceCommit = await sourceStore.readIssued(sourceScope, sourceRow.authorSequence);
					} catch {
						return recoveryFailure("issuance-rejected", "v3 displaced source issued record read failed");
					}
					issued = outboxRowSnapshot(
						ObjectFreeze({ commit: sourceCommit, publishState: "pending" as const }),
						sourceScope
					);
					if (issued === undefined) {
						return recoveryFailure("admission-rejected", "v3 displaced source vertex is not authenticated");
					}
					sourcePreimageBytes = issued.canonicalPreimageBytes;
					sourceSignature = issued.signature;
				}
				const authenticated = authenticateRecoveryVertex(
					displacedSource.prepared,
					displacedSource.authorization,
					sourcePreimageBytes,
					sourceSignature
				);
				if (
					authenticated === undefined ||
					authenticated.digest !== sourceRow.vertexDigest ||
					(sourceRow.sourceKind === "local-issued" && authenticated.author !== sourceScope.author)
				) {
					return recoveryFailure("admission-rejected", "v3 displaced source vertex is not authenticated");
				}
				if (authenticated.digest === displacedSource.activationVertexDigest) {
					let classification: ReturnType<V3TerminalVertexClassifier> = "reject";
					try {
						classification = (terminalClassifier as V3TerminalVertexClassifier)(
							ObjectFreeze({
								author: authenticated.author,
								exactReceivedCanonicalPreimageBytes: new Uint8ArrayConstructor(sourcePreimageBytes),
								signature: new Uint8ArrayConstructor(sourceSignature),
								vertex: authenticated.admitted,
							})
						);
					} catch {
						classification = "reject";
					}
					if (classification !== "terminal-authorized" || sequence !== sourceReadiness.rowCount - 1) {
						return recoveryFailure("authorization-rejected", "v3 displaced source activation is invalid");
					}
					foundActivation = true;
				}
				sourceAfter = sequence;
			}
			if (!foundActivation) {
				return recoveryFailure("authorization-rejected", "v3 displaced source activation is unavailable");
			}
		}
		if (
			!retainedBootstrapHold &&
			currentRecordCount === 0 &&
			(recoveredCount === 0 || (displacedSource !== undefined && displacedSource.activationVertexDigest === undefined))
		) {
			return recoveryFailure("issuance-rejected", "v3 recovery issued record chain is empty");
		}
		if (!retainedBootstrapHold && (recoveredCount === 0 || index.size !== preparedVertexCount + recoveredCount)) {
			return recoveryFailure("issuance-rejected", "v3 recovery requires a complete issued record chain");
		}
		const capability = ObjectFreeze({}) as RecoveredV3Live;
		recoveredV3LiveAuthority.set(
			capability,
			ObjectFreeze({
				applicationAuthors,
				applicationVertices,
				authorization,
				classifyTerminalVertex:
					typeof terminalClassifier === "function" ? (terminalClassifier as V3TerminalVertexClassifier) : undefined,
				displacedSource,
				epochBytes,
				index,
				issuanceScope: selectedScope,
				issuanceStore: issuance,
				latchedOperations,
				liveJournalStore: journal,
				prepared: payload,
				quarantinedDigests,
				retainedBootstrapHold,
				terminal: recoveredTerminal,
			})
		);
		return ObjectFreeze({
			capability,
			descriptor: ObjectFreeze({
				objectId: payload.provenance.objectId,
				recoveredVertices: ObjectFreeze([...recoveredVertices]),
				recoveredVertexCount: index.size,
				transcript: ObjectFreeze([
					"authorized",
					"issued-record-authenticated",
					"journaled",
					"indexed",
					"ready",
				] as const),
			}),
			ok: true as const,
		});
	} catch {
		return recoveryFailure("internal-invariant", "v3 recovery failed unexpectedly");
	}
}

interface CapturedLocalIssueInput {
	readonly operations: readonly Readonly<{
		readonly logicalTime: number;
		readonly operation: Readonly<Record<string, unknown>>;
	}>[];
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
}

type InternalLocalIssueResult = V3LocalIssueResult &
	Readonly<{
		readonly terminalIntent?: "absent" | "outcome-unknown";
		readonly terminalDisposition?: "continue" | "retained-bootstrap-ready" | "terminal-accepted" | "terminal-rejected";
	}>;

function internalLocalIssueFailure(
	kind: Exclude<Extract<V3LocalIssueResult, { readonly ok: false }>["kind"], "split-required">,
	detail: string,
	terminalIntent?: "absent" | "outcome-unknown"
): InternalLocalIssueResult {
	return ObjectFreeze({
		...localIssueFailure(kind, detail),
		...(terminalIntent === undefined ? {} : { terminalIntent }),
	});
}

function canonicalRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	try {
		if (!isObject(value)) return undefined;
		const prototype = ObjectGetPrototypeOf(value);
		if (prototype !== ObjectPrototype && prototype !== null) return undefined;
		const actual = ReflectOwnKeys(value);
		if (actual.length !== keys.length) return undefined;
		const record = ObjectCreate(null) as Record<string, unknown>;
		for (let index = 0; index < keys.length; index += 1) {
			const key = keys[index] as string;
			if (actual[index] !== key) return undefined;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
			record[key] = descriptor.value;
		}
		return ObjectFreeze(record);
	} catch {
		return undefined;
	}
}

function denseArray(value: unknown): readonly unknown[] | undefined {
	try {
		if (!ArrayIsArray(value) || ObjectGetPrototypeOf(value) !== ArrayPrototype) return undefined;
		const length = value.length;
		if (!NumberIsSafeInteger(length) || length < 0) return undefined;
		const actual = ReflectOwnKeys(value);
		if (actual.length !== length + 1 || actual[length] !== "length") return undefined;
		for (let index = 0; index < length; index += 1) {
			if (actual[index] !== StringConstructor(index)) return undefined;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, StringConstructor(index));
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
		}
		return value;
	} catch {
		return undefined;
	}
}

function detachedCanonicalOperation(value: unknown): Readonly<Record<string, unknown>> | undefined {
	try {
		const cloned = decodeCanonical(encodeCanonical(value));
		if (!isObject(cloned) || ArrayIsArray(cloned) || ObjectGetPrototypeOf(cloned) !== null) return undefined;
		return ObjectFreeze({ ...(cloned as Record<string, unknown>) });
	} catch {
		return undefined;
	}
}

function isReservedBatchAction(action: string): boolean {
	return RESERVED_BATCH_ACTIONS.some((reserved) => reserved === action);
}

function isKnownBatchChild(payload: PreparedV3LivePayload, operation: Readonly<Record<string, unknown>>): boolean {
	const action = Reflect.get(operation, "action");
	return (
		typeof action === "string" &&
		!isReservedBatchAction(action) &&
		typeof Reflect.get(payload.runtime.reducers, action) === "function"
	);
}

function applicationBatchEntries(
	payload: PreparedV3LivePayload,
	operation: unknown
):
	| readonly Readonly<{ readonly logicalTime: number; readonly operation: Readonly<Record<string, unknown>> }>[]
	| undefined {
	if (!isObject(operation) || ArrayIsArray(operation)) return undefined;
	if (typeof Reflect.get(payload.runtime.reducers, APPLICATION_BATCH_ACTION) !== "function") return undefined;
	if (Reflect.get(operation, "action") !== APPLICATION_BATCH_ACTION) return undefined;
	const outer = canonicalRecord(operation, APPLICATION_BATCH_KEYS);
	if (outer === undefined) return undefined;
	const batch = canonicalRecord(outer.batch, APPLICATION_BATCH_PAYLOAD_KEYS);
	if (batch === undefined || batch.version !== 1) return undefined;
	const entries = denseArray(batch.entries);
	if (entries === undefined || entries.length < 2 || entries.length > APPLICATION_BATCH_MAX_ENTRIES) return undefined;
	const output: Readonly<{ readonly logicalTime: number; readonly operation: Readonly<Record<string, unknown>> }>[] =
		[];
	let priorLogicalTime = -1;
	for (const value of entries) {
		const entry = canonicalRecord(value, CANONICAL_APPLICATION_BATCH_ENTRY_KEYS);
		if (
			entry === undefined ||
			!NumberIsSafeInteger(entry.logicalTime) ||
			(entry.logicalTime as number) < 0 ||
			(entry.logicalTime as number) <= priorLogicalTime
		) {
			return undefined;
		}
		if (!isObject(entry.operation) || ArrayIsArray(entry.operation)) return undefined;
		const operationKeys = ReflectOwnKeys(entry.operation);
		if (operationKeys.some((key) => typeof key !== "string")) return undefined;
		const child = canonicalRecord(entry.operation, operationKeys as string[]);
		if (child === undefined || !isKnownBatchChild(payload, child)) return undefined;
		priorLogicalTime = entry.logicalTime as number;
		output.push(ObjectFreeze({ logicalTime: priorLogicalTime, operation: child }));
	}
	try {
		const bytes = encodeCanonical(operation, APPLICATION_BATCH_LIMITS);
		decodeCanonical(bytes, APPLICATION_BATCH_LIMITS);
	} catch {
		return undefined;
	}
	return ObjectFreeze(output);
}

function acceptedApplicationOperation(
	payload: PreparedV3LivePayload,
	operation: unknown,
	logicalTime: number
): boolean {
	if (!isObject(operation) || ArrayIsArray(operation)) return false;
	if (Reflect.get(operation, "action") !== APPLICATION_BATCH_ACTION) return true;
	const entries = applicationBatchEntries(payload, operation);
	return entries?.[0]?.logicalTime === logicalTime;
}

function applicationBatchOperation(
	operations: readonly Readonly<{
		readonly logicalTime: number;
		readonly operation: Readonly<Record<string, unknown>>;
	}>[]
): Readonly<Record<string, unknown>> {
	return ObjectFreeze({
		action: APPLICATION_BATCH_ACTION,
		batch: ObjectFreeze({ entries: ObjectFreeze([...operations]), version: 1 }),
	});
}

function applicationBatchFits(operation: Readonly<Record<string, unknown>>): boolean {
	try {
		const bytes = encodeCanonical(operation, APPLICATION_BATCH_LIMITS);
		decodeCanonical(bytes, APPLICATION_BATCH_LIMITS);
		return true;
	} catch {
		return false;
	}
}

function capturedLocalIssueInput(
	payload: PreparedV3LivePayload,
	rawInput: V3LocalIssueInput
): CapturedLocalIssueInput | V3LocalIssueResult {
	const input = snapshotClosedRecord(rawInput, LOCAL_ISSUE_INPUT_KEYS);
	if (input === undefined || typeof input.signRegisteredVertexDigest !== "function") {
		return localIssueFailure("malformed-input", "v3 local issue input is invalid");
	}
	const values = denseArray(input.operations);
	if (values === undefined || values.length === 0) {
		return localIssueFailure("malformed-input", "v3 local issue operations are invalid");
	}
	const sourceOperations = new Set<object>();
	const operations: Readonly<{
		readonly logicalTime: number;
		readonly operation: Readonly<Record<string, unknown>>;
	}>[] = [];
	let priorLogicalTime = -1;
	for (const value of values) {
		const entry = snapshotClosedRecord(value, LOCAL_ISSUE_ENTRY_KEYS);
		if (
			entry === undefined ||
			!NumberIsSafeInteger(entry.logicalTime) ||
			(entry.logicalTime as number) < 0 ||
			(entry.logicalTime as number) <= priorLogicalTime ||
			!isObject(entry.operation) ||
			sourceOperations.has(entry.operation)
		) {
			return localIssueFailure("malformed-input", "v3 local issue operations are invalid");
		}
		sourceOperations.add(entry.operation);
		const operation = detachedCanonicalOperation(entry.operation);
		if (operation === undefined) {
			return localIssueFailure("malformed-input", "v3 local issue operation is invalid");
		}
		const action = Reflect.get(operation, "action");
		if (typeof action !== "string") {
			return localIssueFailure("malformed-input", "v3 local issue operation is invalid");
		}
		if (
			action === APPLICATION_BATCH_ACTION ||
			action === "causalJoin" ||
			(values.length > 1 && (action === "acl" || action === "join"))
		) {
			return localIssueFailure("authorization-rejected", "v3 local issue operation is reserved to the node");
		}
		if (typeof Reflect.get(payload.runtime.reducers, action) !== "function") {
			return localIssueFailure("malformed-input", "v3 local issue operation is unknown");
		}
		priorLogicalTime = entry.logicalTime as number;
		operations.push(ObjectFreeze({ logicalTime: priorLogicalTime, operation }));
	}
	return ObjectFreeze({
		operations: ObjectFreeze(operations),
		signRegisteredVertexDigest: input.signRegisteredVertexDigest as SignRegisteredVertexDigest,
	});
}

async function issueOneVertex(
	registration: V3PlaneRegistration,
	input: CapturedLocalIssueInput,
	dependencies: readonly string[],
	logicalTime: number,
	operation: Readonly<Record<string, unknown>>,
	requireTerminalAuthorization = false
): Promise<InternalLocalIssueResult> {
	if (!currentRegistration(registration)) return localIssueFailure("not-active", "v3 plane is not active");
	if (registration.index.size >= registration.payload.parameters.maxEpochVertices) {
		return localIssueFailure("graph-rejected", "v3 local issue graph is at capacity");
	}
	if (dependencies.length === 0 || dependencies.length > registration.payload.parameters.maxDependencies) {
		return localIssueFailure("admission-rejected", "v3 local issue dependency bound is invalid");
	}
	const scope = copiedScope(registration.issuanceScope);
	if (scope === undefined || scope.objectId !== registration.payload.provenance.objectId) {
		return localIssueFailure("authorization-rejected", "v3 local issue scope is invalid");
	}
	const authorized = resolveV3AuthorizedAuthor(registration.authorization, scope.author);
	if (authorized === undefined) {
		return localIssueFailure("authorization-rejected", "v3 local issue author is not authorized");
	}
	const proposedAcl = aclOperation(scope.author, "0".repeat(64), operation);
	if (!validateLatchedOperation(registration.authorization, registration.latchedOperations, proposedAcl)) {
		return localIssueFailure("authorization-rejected", "v3 local ACL operation is not authorized");
	}

	let commit: unknown;
	let capacityRejected = false;
	let signerResolved = false;
	let terminalTransactionStarted = false;
	try {
		const issuer = createAdmissionBoundTransactionalVertexIssuer({
			author: scope.author,
			preparedBlueprintAdmission: registration.payload.admission,
			publicKey: authorized,
			signRegisteredVertexDigest: async (digest) => {
				const signature = await input.signRegisteredVertexDigest(digest);
				signerResolved = true;
				return signature;
			},
			transactIssue: async (selectedScope, buildAndSign) => {
				const commitOutsideTransaction = async (authorSequence: number): Promise<unknown> => {
					const candidateCommit = await buildAndSign(authorSequence);
					const candidateRow = outboxRowSnapshot(
						ObjectFreeze({ commit: candidateCommit, publishState: "pending" as const }),
						selectedScope
					);
					if (
						candidateRow !== undefined &&
						!hasGraphCapacity(registration, candidateRow.canonicalPreimageBytes.byteLength)
					) {
						capacityRejected = true;
						throw new TypeError("v3 local issue graph is at capacity");
					}
					return candidateCommit;
				};
				if (requireTerminalAuthorization) {
					const lineage = await registration.issuanceStore.readLineage(selectedScope);
					if (!NumberIsSafeInteger(lineage.next) || lineage.next < 0 || lineage.exhausted) {
						throw new TypeError("v3 terminal issuance lineage is unavailable");
					}
					const expectedSequence = lineage.next;
					const candidate = await commitOutsideTransaction(expectedSequence);
					terminalTransactionStarted = true;
					return registration.issuanceStore.transactIssue(selectedScope, (authorSequence) => {
						if (authorSequence !== expectedSequence) {
							throw new TypeError("v3 terminal issuance lineage changed");
						}
						return Promise.resolve(candidate as never);
					});
				}
				return registration.issuanceStore.transactIssue(selectedScope, commitOutsideTransaction as never);
			},
		});
		commit = await issuer.issue({
			anchor: registration.payload.provenance.anchorDigest,
			dependencies,
			epoch: 0,
			logicalTime,
			objectId: registration.payload.provenance.objectId,
			operation,
		});
	} catch {
		if (requireTerminalAuthorization && terminalTransactionStarted) {
			return internalLocalIssueFailure(
				"issuance-rejected",
				"v3 terminal issue transaction outcome is unknown",
				"outcome-unknown"
			);
		}
		return capacityRejected
			? localIssueFailure("graph-rejected", "v3 local issue graph is at capacity")
			: signerResolved
				? localIssueFailure("admission-rejected", "v3 local issue signature was not admitted")
				: localIssueFailure("issuance-rejected", "v3 local issue transaction failed");
	}
	const committedFailure = (
		kind: Exclude<Extract<V3LocalIssueResult, { readonly ok: false }>["kind"], "split-required">,
		detail: string
	): InternalLocalIssueResult =>
		requireTerminalAuthorization
			? internalLocalIssueFailure(kind, detail, "outcome-unknown")
			: localIssueFailure(kind, detail);
	const row = outboxRowSnapshot(ObjectFreeze({ commit, publishState: "pending" as const }), scope);
	if (row === undefined) return committedFailure("issuance-rejected", "v3 local issue record is invalid");

	let authenticated: AuthenticatedRecoveryVertex | undefined;
	try {
		authenticated = authenticateRecoveryVertex(
			registration.payload,
			registration.authorization,
			row.canonicalPreimageBytes,
			row.signature
		);
	} catch {
		return committedFailure("admission-rejected", "v3 local issue authentication failed");
	}
	if (
		authenticated === undefined ||
		authenticated.digest !== lowerHexDigest(row.digest) ||
		authenticated.author !== scope.author ||
		authenticated.authorSequence !== row.authorSequence ||
		registration.index.has(authenticated.digest)
	) {
		return committedFailure("admission-rejected", "v3 local issue record is not authenticated");
	}
	if (!hasBoundedDependencies(registration.payload, authenticated)) {
		return committedFailure("admission-rejected", "v3 local issue dependency bound is invalid");
	}
	if (requireTerminalAuthorization) {
		let classification: ReturnType<V3TerminalVertexClassifier> = "reject";
		try {
			classification =
				registration.classifyTerminalVertex?.(
					ObjectFreeze({
						author: authenticated.author,
						exactReceivedCanonicalPreimageBytes: new Uint8ArrayConstructor(row.canonicalPreimageBytes),
						signature: new Uint8ArrayConstructor(row.signature),
						vertex: authenticated.admitted,
					})
				) ?? "reject";
		} catch {
			classification = "reject";
		}
		if (classification !== "terminal-authorized") {
			return committedFailure("admission-rejected", "v3 terminal issue is not authorized");
		}
	}
	const acceptedAcl = aclOperation(authenticated.author, authenticated.digest, authenticated.vertex.operation);
	if (!validateLatchedOperation(registration.authorization, registration.latchedOperations, acceptedAcl)) {
		return committedFailure("authorization-rejected", "v3 local ACL operation is not authorized");
	}
	if (!hasGraphCapacity(registration, authenticated.byteCharge)) {
		return committedFailure("graph-rejected", "v3 local issue graph is at capacity");
	}

	let appended;
	try {
		appended = await registration.liveJournalStore.appendAccepted({
			author: scope.author,
			authorSequence: row.authorSequence,
			scope: liveJournalScope(registration.payload),
			sourceKind: "local-issued",
			vertexDigest: authenticated.digest,
		});
	} catch {
		return committedFailure("journal-rejected", "v3 local issue journal append failed");
	}
	if (
		!appended.ok ||
		appended.idempotent ||
		appended.sourceKind !== "local-issued" ||
		appended.vertexDigest !== authenticated.digest ||
		!sameLiveJournalScope(appended.scope, liveJournalScope(registration.payload))
	) {
		return committedFailure("journal-rejected", "v3 local issue journal append was rejected");
	}

	const updatedEpochBytes = nextEpochBytes(
		registration.epochBytes,
		authenticated.byteCharge,
		registration.payload.parameters.maxEpochBytes
	);
	if (updatedEpochBytes === undefined) {
		return committedFailure("graph-rejected", "v3 local issue graph is at capacity");
	}
	try {
		const outcome = registration.index.append(authenticated.digest, authenticated.vertex, authenticated.byteCharge);
		if (outcome !== undefined) return committedFailure("graph-rejected", "v3 local issue graph is at capacity");
		registration.epochBytes = updatedEpochBytes;
	} catch {
		return committedFailure("graph-rejected", "v3 local issue graph append failed");
	}
	retainApplicationVertex(registration.applicationVertices, registration.applicationAuthors, authenticated);
	registration.graphVersion += 1;
	if (acceptedAcl !== null && acceptedAcl !== undefined) {
		registration.latchedOperations.set(acceptedAcl.digest, acceptedAcl);
	}
	let terminalDisposition: InternalLocalIssueResult["terminalDisposition"];
	if (currentRegistration(registration)) {
		try {
			const disposition = await registration.onAdmittedVertex(
				ObjectFreeze({
					vertex: authenticated.admitted,
					exactReceivedCanonicalPreimageBytes: new Uint8ArrayConstructor(row.canonicalPreimageBytes),
					signature: new Uint8ArrayConstructor(row.signature),
					transportSender: registration.networkNode.peerId,
				})
			);
			terminalDisposition = disposition?.kind;
		} catch {
			ingressFailureLog("sink-rejected");
		}
	}
	return ObjectFreeze({
		...localIssueSuccess(row.authorSequence, authenticated.digest),
		...(terminalDisposition === undefined ? {} : { terminalDisposition }),
	});
}

async function issueLocal(
	registration: V3PlaneRegistration,
	input: CapturedLocalIssueInput
): Promise<V3LocalIssueResult> {
	if (
		!currentRegistration(registration) ||
		registration.blueprintClosing ||
		registration.terminalState !== "active" ||
		registration.retainedBootstrapHold
	) {
		return localIssueFailure("not-active", "v3 plane is not accepting local issues");
	}
	const first = input.operations[0];
	if (first === undefined) return localIssueFailure("malformed-input", "v3 local issue operations are invalid");
	let applicationOperation = first.operation;
	if (input.operations.length > 1) {
		if (typeof Reflect.get(registration.payload.runtime.reducers, APPLICATION_BATCH_ACTION) !== "function") {
			return localIssueFailure("malformed-input", "v3 local issue application batch reducer is unavailable");
		}
		const maximumPrefix = Math.min(input.operations.length, APPLICATION_BATCH_MAX_ENTRIES);
		let prefixLength = maximumPrefix;
		for (; prefixLength > 0; prefixLength -= 1) {
			const candidate = applicationBatchOperation(input.operations.slice(0, prefixLength));
			if (prefixLength === 1 || applicationBatchFits(candidate)) break;
		}
		if (prefixLength < input.operations.length) {
			return prefixLength > 0
				? localIssueSplit(prefixLength)
				: localIssueFailure("malformed-input", "v3 local issue operation exceeds the application batch budget");
		}
		applicationOperation = applicationBatchOperation(input.operations);
		if (!applicationBatchFits(applicationOperation)) {
			return localIssueFailure("malformed-input", "v3 local issue application batch is invalid");
		}
	}
	const initialTips = registration.index.tips();
	const maxDependencies = registration.payload.parameters.maxDependencies;
	if (initialTips.length === 0) return localIssueFailure("graph-rejected", "v3 local issue frontier is empty");
	if (maxDependencies < 2 && initialTips.length > maxDependencies) {
		return localIssueFailure("graph-rejected", "v3 local issue dependency bound cannot reduce the frontier");
	}
	const requiredJoins =
		initialTips.length <= maxDependencies
			? 0
			: Math.ceil((initialTips.length - maxDependencies) / (maxDependencies - 1));
	if (registration.index.size + requiredJoins + 1 > registration.payload.parameters.maxEpochVertices) {
		return localIssueFailure("graph-rejected", "v3 local issue graph is at capacity");
	}
	for (;;) {
		const tips = registration.index.tips();
		if (tips.length <= maxDependencies) {
			const issued = await issueOneVertex(registration, input, tips, first.logicalTime, applicationOperation);
			if (issued.ok) await drainPendingIngress(registration);
			return issued;
		}
		const joined = await issueOneVertex(
			registration,
			input,
			tips.slice(0, maxDependencies),
			first.logicalTime,
			ObjectFreeze({ action: "causalJoin" })
		);
		if (!joined.ok) return joined;
	}
}

function enqueueLocalIssue(
	registration: V3PlaneRegistration,
	rawInput: V3LocalIssueInput
): Promise<V3LocalIssueResult> {
	const barrier = registration.terminalBarrier;
	const enqueue = (): Promise<V3LocalIssueResult> =>
		enqueueRegistrationTask(registration, () => {
			const captured = capturedLocalIssueInput(registration.payload, rawInput);
			return "ok" in captured
				? (): Promise<V3LocalIssueResult> => Promise.resolve(captured)
				: (): Promise<V3LocalIssueResult> => issueLocal(registration, captured);
		});
	return barrier === undefined ? enqueue() : barrier.then(enqueue);
}

type ClassifiedRebaseRow = Readonly<{
	authenticated: AuthenticatedRecoveryVertex;
	kind: "current" | "displaced";
	row: SnapshottedOutboxRow;
}>;

function classifyRebaseRow(
	registration: V3PlaneRegistration,
	row: SnapshottedOutboxRow
): ClassifiedRebaseRow | undefined {
	const classified = classifyPlaneVertex(
		registration.payload,
		registration.authorization,
		registration.displacedSource,
		row.canonicalPreimageBytes,
		row.signature,
		lowerHexDigest(row.digest),
		row.scope.author,
		row.authorSequence
	);
	return classified === undefined ? undefined : ObjectFreeze({ ...classified, row });
}

function validRebaseRow(registration: V3PlaneRegistration, classified: ClassifiedRebaseRow): boolean {
	const source = classified.kind === "current" ? registration.payload : registration.displacedSource?.prepared;
	return (
		source !== undefined &&
		acceptedApplicationOperation(
			source,
			classified.authenticated.vertex.operation,
			classified.authenticated.admitted.logicalTime
		) &&
		hasBoundedDependencies(source, classified.authenticated)
	);
}

function rebaseIntents(
	payload: PreparedV3LivePayload,
	authenticated: AuthenticatedRecoveryVertex
):
	| readonly Readonly<{
			readonly logicalTime: number;
			readonly operation: Readonly<Record<string, unknown>>;
			readonly operationCount: number;
			readonly operationIndex: number;
	  }>[]
	| undefined {
	const sourceOperation = authenticated.vertex.operation;
	if (sourceOperation === undefined) return undefined;
	const action = Reflect.get(sourceOperation, "action");
	const batch = applicationBatchEntries(payload, sourceOperation);
	if (action === APPLICATION_BATCH_ACTION) {
		return batch?.map((entry, operationIndex) =>
			ObjectFreeze({ ...entry, operationCount: batch.length, operationIndex })
		);
	}
	if (typeof action === "string" && isReservedBatchAction(action)) return ObjectFreeze([]);
	const operation = detachedCanonicalOperation(sourceOperation);
	return operation === undefined
		? undefined
		: ObjectFreeze([
				ObjectFreeze({
					logicalTime: authenticated.admitted.logicalTime,
					operation,
					operationCount: 1,
					operationIndex: 0,
				}),
			]);
}

async function authenticatedOutboxRow(
	registration: V3PlaneRegistration,
	rawRow: unknown,
	issuanceStore: DurableIssuanceStore = registration.issuanceStore,
	issuanceScope: DurableIssueScope = registration.issuanceScope
): Promise<ClassifiedRebaseRow | undefined> {
	const row = outboxRowSnapshot(rawRow, issuanceScope);
	if (row === undefined) return undefined;
	const issued = await issuanceStore.readIssued(issuanceScope, row.authorSequence);
	const issuedRow = outboxRowSnapshot(ObjectFreeze({ commit: issued, publishState: row.publishState }), issuanceScope);
	return issuedRow !== undefined && matchingOutboxRows(row, issuedRow)
		? classifyRebaseRow(registration, row)
		: undefined;
}

async function readRebaseOutbox(registration: V3PlaneRegistration): Promise<V3RebaseOutboxResult> {
	if (!currentRegistration(registration)) {
		return ObjectFreeze({ detail: "v3 plane is not active", kind: "not-active" as const, ok: false as const });
	}
	if (registration.retainedBootstrapHold) {
		return ObjectFreeze({
			detail: "v3 retained bootstrap is incomplete",
			kind: "not-active" as const,
			ok: false as const,
		});
	}
	if (registration.rebaseSnapshot === undefined) {
		const crossSource =
			registration.displacedSource?.issuanceStore === undefined ? undefined : registration.displacedSource;
		const selectedStore = crossSource?.issuanceStore ?? registration.issuanceStore;
		const selectedScope = crossSource?.issuanceScope ?? registration.issuanceScope;
		const displaced: ClassifiedRebaseRow[] = [];
		let currentRecordCount = 0;
		let displacedRecordCount = 0;
		let afterKey: readonly [string, string, number] | undefined;
		for (;;) {
			let rawPage: unknown;
			try {
				rawPage = await selectedStore.readOutboxPage(
					afterKey === undefined ? { limit: 1, scope: selectedScope } : { afterKey, limit: 1, scope: selectedScope }
				);
			} catch {
				return ObjectFreeze({
					detail: "v3 rebase outbox read failed",
					kind: "store-failed" as const,
					ok: false as const,
				});
			}
			const page = onePage(rawPage);
			if (page === undefined) {
				return ObjectFreeze({
					detail: "v3 rebase outbox page is invalid",
					kind: "record-rejected" as const,
					ok: false as const,
				});
			}
			if (page === null) break;
			let classified: ClassifiedRebaseRow | undefined;
			try {
				classified = await authenticatedOutboxRow(registration, page, selectedStore, selectedScope);
			} catch {
				return ObjectFreeze({
					detail: "v3 rebase outbox record read failed",
					kind: "store-failed" as const,
					ok: false as const,
				});
			}
			if (classified === undefined || (afterKey !== undefined && classified.row.authorSequence <= afterKey[2])) {
				return ObjectFreeze({
					detail: "v3 rebase outbox record is invalid",
					kind: "record-rejected" as const,
					ok: false as const,
				});
			}
			afterKey = ObjectFreeze([selectedScope.objectId, selectedScope.author, classified.row.authorSequence] as const);
			if (classified.kind === "current") {
				currentRecordCount += 1;
				if (currentRecordCount > registration.payload.parameters.maxEpochVertices) {
					return ObjectFreeze({
						detail: "v3 rebase current plane is at capacity",
						kind: "record-rejected" as const,
						ok: false as const,
					});
				}
				if (ReflectApply(SetPrototypeHas, registration.quarantinedDigests, [classified.authenticated.digest]) === true)
					continue;
			}
			if (!validRebaseRow(registration, classified)) {
				return ObjectFreeze({
					detail: "v3 rebase outbox record is invalid",
					kind: "record-rejected" as const,
					ok: false as const,
				});
			}
			if (classified.kind === "displaced") {
				if (crossSource === undefined && classified.row.publishState !== "pending") continue;
				const intents = rebaseIntents(
					(registration.displacedSource as V3DisplacedSourceAuthority).prepared,
					classified.authenticated
				);
				if (intents === undefined) {
					return ObjectFreeze({
						detail: "v3 rebase outbox intent is invalid",
						kind: "record-rejected" as const,
						ok: false as const,
					});
				}
				if (
					crossSource !== undefined &&
					(classified.row.authorSequence === 0 ||
						classified.authenticated.digest === crossSource.activationVertexDigest)
				) {
					continue;
				}
				displacedRecordCount += 1;
				if (
					displacedRecordCount >
					(registration.displacedSource as V3DisplacedSourceAuthority).prepared.parameters.maxEpochVertices
				) {
					return ObjectFreeze({
						detail: "v3 rebase displaced plane is at capacity",
						kind: "record-rejected" as const,
						ok: false as const,
					});
				}
				displaced.push(classified);
			}
		}
		registration.rebaseSnapshot = ObjectFreeze(displaced);
	}
	const snapshot = registration.rebaseSnapshot;
	const selected = snapshot.find(
		({ row }) => registration.rebaseCursor === undefined || row.authorSequence > registration.rebaseCursor
	);
	if (selected === undefined) return ObjectFreeze({ kind: "empty" as const, ok: true as const });
	registration.rebaseCursor = selected.row.authorSequence;
	const source = registration.displacedSource as V3DisplacedSourceAuthority;
	const intents = rebaseIntents(source.prepared, selected.authenticated);
	if (intents === undefined) {
		return ObjectFreeze({
			detail: "v3 rebase outbox intent is invalid",
			kind: "record-rejected" as const,
			ok: false as const,
		});
	}
	const commonSource = {
		author: selected.authenticated.author,
		authorSequence: selected.row.authorSequence,
		intents: ObjectFreeze(intents),
		vertexDigest: selected.authenticated.digest,
	};
	return source.issuanceStore === undefined
		? ObjectFreeze({
				kind: "displaced" as const,
				ok: true as const,
				source: ObjectFreeze(commonSource),
			})
		: ObjectFreeze({
				kind: "displaced" as const,
				ok: true as const,
				source: ObjectFreeze({ ...commonSource, publishState: selected.row.publishState }),
			});
}

async function publishPending(
	registration: V3PlaneRegistration,
	completionRow?: SnapshottedOutboxRow
): Promise<V3EgressResult> {
	if (!currentRegistration(registration)) return egressFailure("not-active", "v3 plane is not active");
	if (registration.retainedBootstrapHold) {
		return egressFailure("not-active", "v3 retained bootstrap is incomplete");
	}
	const scope = copiedScope(registration.issuanceScope);
	if (scope === undefined || scope.objectId !== registration.payload.provenance.objectId) {
		return egressFailure("record-rejected", "v3 publication selector is invalid");
	}
	let afterKey =
		completionRow === undefined && registration.publicationCursor !== undefined
			? ObjectFreeze([
					registration.issuanceScope.objectId,
					registration.issuanceScope.author,
					registration.publicationCursor,
				] as const)
			: undefined;
	let selectedRow = completionRow;
	let skipPublication = completionRow !== undefined;
	while (selectedRow === undefined) {
		let rawPage: unknown;
		try {
			rawPage = await registration.issuanceStore.readOutboxPage(
				afterKey === undefined ? { scope, limit: 1 } : { afterKey, limit: 1, scope }
			);
		} catch {
			return egressFailure("store-failed", "v3 publication store read failed");
		}
		if (!currentRegistration(registration)) return egressFailure("not-active", "v3 plane is not active");
		const page = onePage(rawPage);
		if (page === undefined) return egressFailure("record-rejected", "v3 publication record is invalid");
		if (page === null) return egressSuccess("empty");
		let classified: ClassifiedRebaseRow | undefined;
		let row: SnapshottedOutboxRow | undefined;
		if (registration.displacedSource === undefined) {
			row = outboxRowSnapshot(page, scope);
		} else {
			try {
				classified = await authenticatedOutboxRow(registration, page);
			} catch {
				return egressFailure("store-failed", "v3 publication issued record read failed");
			}
			row = classified?.row;
		}
		if (row === undefined) return egressFailure("record-rejected", "v3 publication record is invalid");
		const quarantinedCurrent =
			classified?.kind === "current" &&
			ReflectApply(SetPrototypeHas, registration.quarantinedDigests, [classified.authenticated.digest]) === true;
		if (classified !== undefined && !quarantinedCurrent && !validRebaseRow(registration, classified)) {
			return egressFailure("record-rejected", "v3 publication record is invalid");
		}
		if (row.publishState === "published") {
			const nextKey = ObjectFreeze([scope.objectId, scope.author, row.authorSequence] as const);
			if (afterKey !== undefined && row.authorSequence <= afterKey[2]) {
				return egressFailure("record-rejected", "v3 publication cursor did not advance");
			}
			afterKey = nextKey;
			registration.publicationCursor = row.authorSequence;
			continue;
		}
		if (row.publishState !== "pending") return egressFailure("record-rejected", "v3 publication state is invalid");
		if (classified?.kind === "displaced") {
			if (afterKey !== undefined && row.authorSequence <= afterKey[2]) {
				return egressFailure("record-rejected", "v3 publication cursor did not advance");
			}
			afterKey = ObjectFreeze([scope.objectId, scope.author, row.authorSequence] as const);
			registration.publicationCursor = row.authorSequence;
			continue;
		}
		selectedRow = row;
		const rowDigest = lowerHexDigest(selectedRow.digest);
		if (rowDigest === undefined) return egressFailure("record-rejected", "v3 publication digest is invalid");
		skipPublication = ReflectApply(SetPrototypeHas, registration.quarantinedDigests, [rowDigest]) === true;
	}
	const row = selectedRow;
	if (!skipPublication) {
		const data = V3Envelope.encode({
			canonicalPreimage: new Uint8ArrayConstructor(row.canonicalPreimageBytes),
			signature: new Uint8ArrayConstructor(row.signature),
		}).finish();
		const message = Message.create({
			data,
			objectId: registration.topic,
			sender: registration.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
		});
		if (!currentRegistration(registration)) return egressFailure("not-active", "v3 plane is not active");
		let publicationResult: unknown;
		try {
			publicationResult = await registration.networkNode.publishMessage(registration.topic, message);
		} catch {
			return currentRegistration(registration)
				? egressFailure("publish-failed", "v3 publication failed")
				: egressFailure("publication-state-unknown", "v3 publication state is unknown");
		}
		if (!currentRegistration(registration)) {
			return egressFailure("publication-state-unknown", "v3 publication state is unknown");
		}
		if (publicationResult !== true) return egressFailure("publish-failed", "v3 publication failed");
		if (!currentRegistration(registration)) {
			return egressFailure("publication-state-unknown", "v3 publication state is unknown");
		}
	}
	try {
		await registration.issuanceStore.compareAndMarkOutboxPublished({
			authorSequence: row.authorSequence,
			digest: new Uint8ArrayConstructor(row.digest),
			scope: ObjectFreeze({ ...row.scope }),
		});
	} catch {
		return egressFailure("publication-state-unknown", "v3 publication state is unknown");
	}
	if (completionRow === undefined) registration.publicationCursor = row.authorSequence;
	return egressSuccess("published");
}

async function completeRebaseSource(
	registration: V3PlaneRegistration,
	input: Readonly<{ readonly authorSequence: number; readonly digest: string }>
): Promise<V3EgressResult> {
	if (!currentRegistration(registration)) return egressFailure("not-active", "v3 plane is not active");
	if (
		!NumberIsSafeInteger(input.authorSequence) ||
		input.authorSequence < 0 ||
		!isDigestHex(input.digest) ||
		registration.displacedSource === undefined
	) {
		return egressFailure("record-rejected", "v3 displaced source completion is invalid");
	}
	try {
		const crossSource =
			registration.displacedSource?.issuanceStore === undefined ? undefined : registration.displacedSource;
		const selectedStore = crossSource?.issuanceStore ?? registration.issuanceStore;
		const selectedScope = crossSource?.issuanceScope ?? registration.issuanceScope;
		const issued = await selectedStore.readIssued(selectedScope, input.authorSequence);
		const row = outboxRowSnapshot(ObjectFreeze({ commit: issued, publishState: "pending" as const }), selectedScope);
		const classified = row === undefined ? undefined : classifyRebaseRow(registration, row);
		if (classified?.kind !== "displaced" || classified.authenticated.digest !== input.digest) {
			return egressFailure("record-rejected", "v3 displaced source completion does not match");
		}
		if (row === undefined) return egressFailure("record-rejected", "v3 displaced source completion does not match");
		if (crossSource !== undefined) {
			await selectedStore.compareAndMarkOutboxPublished({
				authorSequence: row.authorSequence,
				digest: new Uint8ArrayConstructor(row.digest),
				scope: selectedScope,
			});
			registration.rebaseSnapshot = undefined;
			return egressSuccess("published");
		}
		return await publishPending(registration, row);
	} catch {
		return egressFailure("store-failed", "v3 displaced source completion failed");
	}
}

function enqueuePendingPublication(registration: V3PlaneRegistration): Promise<V3EgressResult> {
	if (registration.terminalState === "terminal") {
		return enqueueRegistrationTask(registration, () => async () => {
			let published = false;
			for (let count = 0; count <= registration.payload.parameters.maxEpochVertices; count += 1) {
				const result = await publishPending(registration);
				if (!result.ok) return result;
				if (result.kind === "empty") return published ? egressSuccess("published") : result;
				published = true;
			}
			return egressFailure("record-rejected", "v3 terminal publication traversal exceeded the epoch bound");
		});
	}
	return enqueueRegistrationTask(registration, () => () => publishPending(registration));
}

async function republishRetained(registration: V3PlaneRegistration, targetPeerId?: string): Promise<V3EgressResult> {
	if (!currentRegistration(registration)) return egressFailure("not-active", "v3 plane is not active");
	const scope = liveJournalScope(registration.payload);
	let readiness;
	try {
		readiness = await registration.liveJournalStore.readiness({ scope });
	} catch {
		return egressFailure("store-failed", "v3 retained journal readiness failed");
	}
	if (!currentRegistration(registration)) return egressFailure("not-active", "v3 plane is not active");
	if (
		!readiness.ok ||
		!readiness.ready ||
		!sameLiveJournalScope(readiness.scope, scope) ||
		!NumberIsSafeInteger(readiness.rowCount) ||
		readiness.rowCount < 0 ||
		readiness.rowCount > registration.payload.parameters.maxEpochVertices
	) {
		return egressFailure("record-rejected", "v3 retained journal readiness is invalid");
	}
	if (readiness.rowCount === 0) {
		let emptyPage;
		try {
			emptyPage = await registration.liveJournalStore.readPage({
				afterSequence: null,
				limit: 1,
				scope,
				snapshot: readiness.snapshot,
			});
		} catch {
			return egressFailure("store-failed", "v3 retained journal page read failed");
		}
		return emptyPage.ok && emptyPage.rows.length === 0 && emptyPage.nextSequence === null
			? egressSuccess("empty")
			: egressFailure("record-rejected", "v3 retained journal is inconsistent");
	}

	let afterSequence: number | null = null;
	for (let expectedSequence = 0; expectedSequence < readiness.rowCount; expectedSequence += 1) {
		let page;
		try {
			page = await registration.liveJournalStore.readPage({
				afterSequence,
				limit: 1,
				scope,
				snapshot: readiness.snapshot,
			});
		} catch {
			return egressFailure("store-failed", "v3 retained journal page read failed");
		}
		if (!currentRegistration(registration)) return egressFailure("not-active", "v3 plane is not active");
		if (!page.ok || page.rows.length !== 1) {
			return egressFailure("record-rejected", "v3 retained journal page is incomplete");
		}
		const row = journalRowSnapshot(page.rows[0], scope, expectedSequence);
		const expectedNext = expectedSequence + 1 < readiness.rowCount ? expectedSequence : null;
		if (row === undefined || page.nextSequence !== expectedNext) {
			return egressFailure("record-rejected", "v3 retained journal row is invalid");
		}

		let canonicalPreimageBytes: Uint8Array;
		let signature: Uint8Array;
		if (row.sourceKind === "received") {
			canonicalPreimageBytes = row.exactCanonicalPreimageBytes;
			signature = row.detachedSignature;
		} else {
			const localScope = ObjectFreeze({ author: row.author, objectId: scope.objectId });
			let issuedCommit: unknown;
			try {
				issuedCommit = await registration.issuanceStore.readIssued(localScope, row.authorSequence);
			} catch {
				return egressFailure("store-failed", "v3 retained issued record read failed");
			}
			const issuedRow = outboxRowSnapshot(
				ObjectFreeze({ commit: issuedCommit, publishState: "published" as const }),
				localScope
			);
			if (issuedRow === undefined || lowerHexDigest(issuedRow.digest) !== row.vertexDigest) {
				return egressFailure("record-rejected", "v3 retained issued record is invalid");
			}
			canonicalPreimageBytes = issuedRow.canonicalPreimageBytes;
			signature = issuedRow.signature;
		}
		const authenticated = authenticateRecoveryVertex(
			registration.payload,
			registration.authorization,
			canonicalPreimageBytes,
			signature
		);
		if (authenticated === undefined || authenticated.digest !== row.vertexDigest) {
			return egressFailure("record-rejected", "v3 retained vertex is not authenticated");
		}
		if (ReflectApply(SetPrototypeHas, registration.quarantinedDigests, [authenticated.digest]) === true) {
			afterSequence = expectedSequence;
			continue;
		}
		const message = Message.create({
			data: V3Envelope.encode({
				canonicalPreimage: new Uint8ArrayConstructor(canonicalPreimageBytes),
				signature: new Uint8ArrayConstructor(signature),
			}).finish(),
			objectId: registration.topic,
			sender: registration.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
		});
		let published: unknown;
		try {
			if (targetPeerId === undefined) {
				published = await registration.networkNode.publishMessage(registration.topic, message);
			} else {
				await registration.networkNode.sendMessage(targetPeerId, message);
				published = true;
			}
		} catch {
			return currentRegistration(registration)
				? egressFailure("publish-failed", "v3 retained publication failed")
				: egressFailure("publication-state-unknown", "v3 retained publication state is unknown");
		}
		if (!currentRegistration(registration)) {
			return egressFailure("publication-state-unknown", "v3 retained publication state is unknown");
		}
		if (published !== true) return egressFailure("publish-failed", "v3 retained publication failed");
		afterSequence = expectedSequence;
	}
	return egressSuccess("published");
}

function enqueueRetainedPublication(registration: V3PlaneRegistration): Promise<V3EgressResult> {
	return enqueueRegistrationTask(registration, () => () => republishRetained(registration));
}

function enqueueTargetedRetainedPublication(
	registration: V3PlaneRegistration,
	targetPeerId: string
): Promise<V3EgressResult> {
	return enqueueRegistrationTask(registration, () => () => republishRetained(registration, targetPeerId));
}

function terminalFailure(
	kind: Extract<V3TerminalPublishResult, { readonly ok: false }>["kind"],
	detail: string,
	terminalIntent: "absent" | "outcome-unknown" = "absent"
): Extract<V3TerminalPublishResult, { readonly ok: false }> {
	return ObjectFreeze({ detail, kind, ok: false as const, terminalIntent });
}

function terminalIssueFailure(result: Exclude<V3LocalIssueResult, { readonly ok: true }>): V3TerminalPublishResult {
	return terminalFailure(
		result.kind === "split-required" ? "malformed-input" : result.kind,
		result.detail,
		Reflect.get(result, "terminalIntent") === "outcome-unknown" ? "outcome-unknown" : "absent"
	);
}

async function publishTerminalIssue(
	registration: V3PlaneRegistration,
	rawInput: V3LocalIssueInput
): Promise<V3TerminalPublishResult> {
	if (!currentRegistration(registration) || registration.terminalState !== "transition") {
		return terminalFailure("not-active", "v3 terminal transition is not active");
	}
	const rawRecord = snapshotClosedRecord(rawInput, LOCAL_ISSUE_INPUT_KEYS);
	const rawOperations = denseArray(rawRecord?.operations);
	const rawFirst = rawOperations?.[0];
	const rawEntry = snapshotClosedRecord(rawFirst, LOCAL_ISSUE_ENTRY_KEYS);
	const tips = registration.index.tips();
	if (tips.length === 0 || tips.length > registration.payload.parameters.maxDependencies) {
		return terminalFailure("graph-rejected", "v3 terminal issue frontier is invalid");
	}
	if (rawEntry !== undefined) {
		try {
			const operationBytes = encodeCanonical(rawEntry.operation).byteLength;
			const remainingBytes = registration.payload.parameters.maxEpochBytes - registration.epochBytes;
			if (remainingBytes < operationBytes + 256) {
				return terminalFailure("graph-rejected", "v3 terminal issue graph is at capacity");
			}
		} catch {
			// The closed semantic capture below owns malformed-input classification.
		}
	}
	const captured = capturedLocalIssueInput(registration.payload, rawInput);
	if ("ok" in captured) {
		return terminalIssueFailure(captured as Exclude<V3LocalIssueResult, { readonly ok: true }>);
	}
	const first = captured.operations[0];
	if (
		captured.operations.length !== 1 ||
		first === undefined ||
		Reflect.get(first.operation, "action") !== "migrationActivation"
	) {
		return terminalFailure("malformed-input", "v3 terminal issue is invalid");
	}
	const issued = await issueOneVertex(registration, captured, tips, first.logicalTime, first.operation, true);
	if (!issued.ok) {
		const failure = terminalIssueFailure(issued);
		if (failure.terminalIntent === "outcome-unknown") registration.terminalState = "terminal";
		return failure;
	}
	registration.terminalState = "terminal";
	if (issued.terminalDisposition !== "terminal-accepted") {
		return terminalFailure(
			"terminal-rejected",
			"v3 terminal sink did not accept the durable transition",
			"outcome-unknown"
		);
	}
	return ObjectFreeze({
		authorSequence: issued.authorSequence,
		digest: issued.digest,
		kind: "accepted" as const,
		ok: true as const,
		terminalIntent: "committed" as const,
	});
}

function beginTerminalTransition(registration: V3PlaneRegistration): Promise<V3TerminalTransitionResult> {
	if (
		registration.terminalState === "active" &&
		registration.terminalBarrier === undefined &&
		currentRegistration(registration)
	) {
		let release!: () => void;
		registration.terminalBarrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		registration.releaseTerminalBarrier = release;
	}
	const releaseBarrier = (): void => {
		const release = registration.releaseTerminalBarrier;
		registration.releaseTerminalBarrier = undefined;
		registration.terminalBarrier = undefined;
		release?.();
	};
	// eslint-disable-next-line @typescript-eslint/require-await -- queue tasks share one async result contract.
	return enqueueRegistrationTask(registration, () => async () => {
		if (!currentRegistration(registration)) {
			releaseBarrier();
			return ObjectFreeze({ detail: "v3 plane is not active", kind: "not-active" as const, ok: false as const });
		}
		if (registration.terminalState === "terminal") {
			releaseBarrier();
			return ObjectFreeze({
				detail: "v3 plane already has a terminal transition",
				kind: "already-terminal" as const,
				ok: false as const,
			});
		}
		if (registration.terminalState === "transition") {
			return ObjectFreeze({
				detail: "v3 terminal transition is already active",
				kind: "transition-active" as const,
				ok: false as const,
			});
		}
		registration.terminalState = "transition";
		let used = false;
		const capability: Extract<V3TerminalTransitionResult, { readonly ok: true }>["capability"] = ObjectFreeze({
			publishTerminal(this: unknown, input: V3LocalIssueInput): Promise<V3TerminalPublishResult> {
				if (this !== capability) {
					return Promise.reject(new TypeError("v3 terminal capability receiver is invalid"));
				}
				if (used) return Promise.resolve(terminalFailure("not-active", "v3 terminal capability is not active"));
				return enqueueRegistrationTask(registration, () => async () => {
					const result = await publishTerminalIssue(registration, input);
					if (result.ok || result.terminalIntent === "outcome-unknown") {
						used = true;
						releaseBarrier();
					}
					return result;
				});
			},
			resume(this: unknown) {
				if (this !== capability || used || registration.terminalState !== "transition") {
					return ObjectFreeze({
						detail: "v3 terminal capability is not active",
						kind: "invalid-state" as const,
						ok: false as const,
					});
				}
				used = true;
				registration.terminalState = "active";
				releaseBarrier();
				return ObjectFreeze({ kind: "resumed" as const, ok: true as const });
			},
		});
		return ObjectFreeze({ capability, ok: true as const });
	});
}

function blueprintFoldFailure(
	kind: Extract<V3BlueprintFoldResult, { readonly ok: false }>["kind"],
	detail: string
): Extract<V3BlueprintFoldResult, { readonly ok: false }> {
	return ObjectFreeze({ detail, kind, ok: false as const });
}

function blueprintAdoptFailure(
	kind: Extract<V3BlueprintAdoptResult, { readonly ok: false }>["kind"],
	detail: string
): Extract<V3BlueprintAdoptResult, { readonly ok: false }> {
	return ObjectFreeze({ detail, kind, ok: false as const });
}

function signedInitialStateDigest(payload: PreparedV3LivePayload): string | undefined {
	try {
		const anchor = decodeCanonical(payload.input.exactCanonicalAnchorPreimageBytes);
		const digest = isObject(anchor) ? Reflect.get(anchor, "stateDigest") : undefined;
		return isDigestHex(digest) ? digest : undefined;
	} catch {
		return undefined;
	}
}

function stageClosedBlueprintEpoch(registration: V3PlaneRegistration): V3BlueprintFoldResult {
	if (!currentRegistration(registration) || registration.blueprintMachine === undefined) {
		return blueprintFoldFailure("not-active", "v3 blueprint fold is not active");
	}
	if (registration.blueprintFolded) {
		return blueprintFoldFailure("already-folded", "v3 blueprint epoch was already folded");
	}
	const graphVersion = registration.graphVersion;
	let staged;
	try {
		const vertices = copyApplicationVertices(registration.applicationVertices);
		if (vertices === undefined) return blueprintFoldFailure("fold-rejected", "v3 blueprint graph is unavailable");
		staged = foldBlueprintEpoch({
			anchorHash: registration.payload.provenance.anchorDigest,
			authorize: ({ hash }) => {
				const author = ReflectApply(MapPrototypeGet, registration.applicationAuthors, [hash]) as string | undefined;
				return author !== undefined && isV3ApplicationAuthorAuthorized(registration.authorization, author);
			},
			machine: registration.blueprintMachine,
			vertices,
		});
	} catch {
		return blueprintFoldFailure("fold-rejected", "v3 blueprint epoch fold was rejected");
	}
	let used = false;
	return ObjectFreeze({
		adopt: (): V3BlueprintAdoptResult => {
			if (used) return blueprintAdoptFailure("already-adopted", "v3 blueprint fold result was already used");
			used = true;
			if (!currentRegistration(registration) || registration.blueprintMachine === undefined) {
				return blueprintAdoptFailure("not-active", "v3 blueprint fold is not active");
			}
			if (registration.blueprintFolded || registration.graphVersion !== graphVersion) {
				return blueprintAdoptFailure("stale-graph", "v3 blueprint fold graph is stale");
			}
			try {
				const snapshot = staged.adopt();
				registration.blueprintFolded = true;
				return ObjectFreeze({ kind: "adopted" as const, ok: true as const, snapshot });
			} catch {
				return blueprintAdoptFailure("adopt-rejected", "v3 blueprint fold adoption was rejected");
			}
		},
		kind: "staged" as const,
		ok: true as const,
		order: staged.order,
		outputs: staged.outputs,
		staged: staged.staged,
	});
}

function stageBlueprintEpoch(registration: V3PlaneRegistration): Promise<V3BlueprintFoldResult> {
	if (!currentRegistration(registration) || registration.blueprintMachine === undefined) {
		return Promise.resolve(blueprintFoldFailure("not-active", "v3 blueprint fold is not active"));
	}
	if (registration.blueprintClosing || registration.blueprintFolded) {
		return Promise.resolve(blueprintFoldFailure("already-folded", "v3 blueprint epoch was already folded"));
	}
	// Close application admission synchronously, then wait behind every task that
	// already owned the registration gate before copying the fixed epoch graph.
	registration.blueprintClosing = true;
	return enqueueRegistrationTask(registration, () => () => Promise.resolve(stageClosedBlueprintEpoch(registration)));
}

/**
 * Binds exact signed-genesis application state to one active recovered v3 plane.
 * @param rawInput - Closed plane and exact canonical state bytes.
 * @returns A live blueprint fold handle or a closed binding failure.
 */
export function bindV3BlueprintLivePlane(rawInput: V3BlueprintLiveBindingInput): V3BlueprintLiveBindingResult {
	try {
		const input = snapshotClosedRecord(rawInput, BLUEPRINT_BINDING_INPUT_KEYS);
		if (input === undefined) return activationFailure("malformed-input", "v3 blueprint binding input is invalid");
		const registration = v3HandleRegistrations.get(input.plane as V3PlaneHandle);
		const initialStateBytes = copyDetachedBytes(input.exactCanonicalInitialStateBytes);
		if (registration === undefined || !currentRegistration(registration)) {
			return activationFailure("capability-consumed", "v3 plane is unavailable");
		}
		if (registration.blueprintMachine !== undefined || registration.blueprintHandle !== undefined) {
			return activationFailure("capability-consumed", "v3 blueprint binding is already active");
		}
		const initialStateDigest = signedInitialStateDigest(registration.payload);
		if (initialStateBytes === undefined || initialStateDigest === undefined) {
			return activationFailure("malformed-input", "v3 signed genesis state is invalid");
		}
		let machine: BlueprintStateMachine;
		try {
			machine = new BlueprintStateMachine({
				exactCanonicalInitialStateBytes: initialStateBytes,
				expectedBlueprintDigest: registration.payload.provenance.blueprintDigest,
				expectedInitialStateDigest: initialStateDigest,
				preparedBlueprintRuntime: registration.payload.runtime,
			});
		} catch {
			return activationFailure("malformed-input", "v3 signed genesis state is invalid");
		}
		registration.blueprintMachine = machine;
		const handle: V3BlueprintLiveHandle = ObjectFreeze({
			blueprintSnapshot: (): BlueprintStateSnapshot | undefined =>
				currentRegistration(registration) ? registration.blueprintMachine?.snapshot() : undefined,
			epoch: 0 as const,
			objectId: registration.payload.provenance.objectId,
			stageBlueprintEpoch: (): Promise<V3BlueprintFoldResult> => stageBlueprintEpoch(registration),
		});
		registration.blueprintHandle = handle;
		return ObjectFreeze({ handle, ok: true as const });
	} catch {
		return activationFailure("internal-invariant", "v3 blueprint binding failed");
	}
}

function makeV3PlaneHandle(registration: V3PlaneRegistration): V3PlaneHandle {
	const ephemeralAuthority = ((): ReturnType<V3PlaneHandle["currentEphemeralAuthority"]> => {
		const authorization = registration.authorization;
		if (authorization.kind !== "latched-acl") return undefined;
		const snapshot = authorization.value;
		const aclDigest = lowerHexDigest(hashDomain("ts-drp/latched-acl/v3", encodeCanonical(snapshot)));
		if (aclDigest === undefined) return undefined;
		return ObjectFreeze({
			aclDigest,
			anchorDigest: registration.payload.provenance.anchorDigest,
			epoch: 0 as const,
			objectId: registration.payload.provenance.objectId,
			isCurrentWriter: (author: string): boolean => {
				if (!currentRegistration(registration)) return false;
				const authority = authorizeLatchedApplicationWrite({
					author,
					snapshot,
				});
				return authority.ok && authority.authorized;
			},
		});
	})();
	return ObjectFreeze({
		objectId: registration.payload.provenance.objectId,
		epoch: 0 as const,
		topic: registration.topic,
		queueId: registration.queueId,
		currentEphemeralAuthority: () => (currentRegistration(registration) ? ephemeralAuthority : undefined),
		beginTerminalTransition: (): Promise<V3TerminalTransitionResult> => beginTerminalTransition(registration),
		issueLocal: (input: V3LocalIssueInput): Promise<V3LocalIssueResult> => enqueueLocalIssue(registration, input),
		readRebaseOutbox: (): Promise<V3RebaseOutboxResult> =>
			enqueueRegistrationTask(registration, () => () => readRebaseOutbox(registration)),
		completeRebaseSource: (
			input: Readonly<{ readonly authorSequence: number; readonly digest: string }>
		): Promise<V3EgressResult> =>
			enqueueRegistrationTask(registration, () => () => completeRebaseSource(registration, input)),
		previewLatchedAcl: (): Readonly<Record<string, unknown>> | undefined =>
			latchedAclPreview(registration.authorization, registration.latchedOperations),
		publishPending: (): Promise<V3EgressResult> => enqueuePendingPublication(registration),
		republishRetained: (): Promise<V3EgressResult> => enqueueRetainedPublication(registration),
		deactivate: (): void => {
			if (!registration.active) return;
			deactivateRegistration(registration);
		},
	}) as V3PlaneHandle;
}

/**
 * Activates the private v3 transport plane from one recovered capability.
 * @param rawInput - Closed live bindings and the one-use recovered capability.
 * @returns A frozen active handle or a closed activation failure.
 */
export function activateV3LivePlane(rawInput: V3PlaneActivationInput): V3PlaneActivationResult {
	try {
		const input = snapshotClosedRecord(rawInput, ACTIVATION_INPUT_KEYS);
		if (input === undefined) return activationFailure("malformed-input", "v3 activation input is invalid");
		const { capability, messageQueueManager, networkNode, onAdmittedVertex } = input;
		const recovered = consumeRecoveredV3Live(capability as RecoveredV3Live);
		if (recovered === undefined) return activationFailure("capability-consumed", "v3 capability is unavailable");
		const payload = recovered.prepared;
		const selectedScope = copiedScope(recovered.issuanceScope);
		if (selectedScope === undefined) return activationFailure("internal-invariant", "v3 recovered scope is invalid");
		if (!payloadIsUsable(payload)) return activationFailure("internal-invariant", "v3 prepared state is invalid");
		if (selectedScope.objectId !== payload.provenance.objectId) {
			return activationFailure("internal-invariant", "v3 recovered scope does not match");
		}
		if (
			!isObject(recovered.issuanceStore) ||
			!isObject(recovered.liveJournalStore) ||
			!isObject(messageQueueManager) ||
			!isObject(networkNode) ||
			typeof onAdmittedVertex !== "function"
		) {
			return activationFailure("malformed-input", "v3 activation binding is invalid");
		}
		const boundNetworkNode = networkNode as DRPNetworkNode;
		if (typeof boundNetworkNode.peerId !== "string" || boundNetworkNode.peerId.length === 0) {
			return activationFailure("not-started", "v3 network is not started");
		}
		const topic = deriveV3Topic(payload);
		if (topic === undefined) return activationFailure("topic-derivation-failed", "v3 topic could not be derived");
		const queueId = topic;
		const boundQueueManager = messageQueueManager as MessageQueueManager<Message>;
		const boundIssuanceStore = recovered.issuanceStore;
		const boundSink = onAdmittedVertex as V3AdmittedVertexSink;
		let registrations = v3PlaneRegistrations.get(boundNetworkNode);
		const existing = registrations?.get(topic);
		if (existing !== undefined) {
			if (currentRegistration(existing)) {
				return sameActivation(existing, recovered, input)
					? ObjectFreeze({ handle: existing.handle, ok: true as const })
					: activationFailure("internal-invariant", "v3 registration binding conflicts");
			}
			if (!deactivateRegistration(existing)) {
				return activationFailure("internal-invariant", "v3 stale registration could not be retired");
			}
		}
		if (hasQueueGuarded(boundQueueManager, queueId) !== false) {
			return activationFailure("internal-invariant", "v3 queue is already owned");
		}
		const subscribedTopics = denseStrings(boundNetworkNode.getSubscribedTopics());
		let ownsTopic = false;
		if (subscribedTopics !== undefined) {
			for (let index = 0; index < subscribedTopics.length; index += 1) {
				if (subscribedTopics[index] === topic) ownsTopic = true;
			}
		}
		if (subscribedTopics === undefined || ownsTopic) {
			return activationFailure("internal-invariant", "v3 topic is already owned");
		}
		let registration = undefined as unknown as V3PlaneRegistration;
		let networkSubscriptionAttempted = false;
		try {
			const queueSubscription = subscribeActivationQueue(boundQueueManager, queueId, (message) =>
				enqueueV3Ingress(registration, message)
			);
			if (queueSubscription !== "ok") {
				return queueSubscription === "capacity"
					? activationFailureAfterCleanup(
							"queue-capacity",
							"v3 queue capacity is unavailable",
							boundNetworkNode,
							boundQueueManager,
							topic,
							queueId,
							false
						)
					: activationFailureAfterCleanup(
							"internal-invariant",
							"v3 queue subscription failed",
							boundNetworkNode,
							boundQueueManager,
							topic,
							queueId,
							false
						);
			}
			if (hasQueueGuarded(boundQueueManager, queueId) !== true) {
				return activationFailureAfterCleanup(
					"internal-invariant",
					"v3 queue subscription failed",
					boundNetworkNode,
					boundQueueManager,
					topic,
					queueId,
					false
				);
			}
			networkSubscriptionAttempted = true;
			try {
				boundNetworkNode.subscribe(topic);
			} catch {
				return activationFailureAfterCleanup(
					"subscribe-failed",
					"v3 topic subscription failed",
					boundNetworkNode,
					boundQueueManager,
					topic,
					queueId,
					true
				);
			}
			if (topicMembership(boundNetworkNode, topic) !== true) {
				return activationFailureAfterCleanup(
					"subscribe-failed",
					"v3 topic subscription failed",
					boundNetworkNode,
					boundQueueManager,
					topic,
					queueId,
					true
				);
			}
			registration = {
				active: true,
				applicationAuthors: recovered.applicationAuthors,
				applicationVertices: recovered.applicationVertices,
				authorization: recovered.authorization,
				blueprintClosing: false,
				blueprintFolded: false,
				blueprintHandle: undefined,
				blueprintMachine: undefined,
				classifyTerminalVertex: recovered.classifyTerminalVertex,
				displacedSource: recovered.displacedSource,
				drainingPendingIngress: false,
				epochBytes: recovered.epochBytes,
				graphVersion: intrinsicMapSize(recovered.applicationAuthors) ?? -1,
				handle: undefined as unknown as V3PlaneHandle,
				index: recovered.index,
				issuanceScope: selectedScope,
				issuanceStore: boundIssuanceStore,
				latchedOperations: recovered.latchedOperations,
				liveJournalStore: recovered.liveJournalStore,
				messageQueueManager: boundQueueManager,
				networkNode: boundNetworkNode,
				onAdmittedVertex: boundSink,
				payload,
				pendingIngress: new IntrinsicMap<string, PendingV3Ingress>(),
				pendingIngressBytes: 0,
				publicationCursor: undefined,
				rebaseCursor: undefined,
				rebaseSnapshot: undefined,
				retainedBootstrapHold: recovered.retainedBootstrapHold,
				releaseTerminalBarrier: undefined,
				quarantinedDigests: recovered.quarantinedDigests,
				queueId: topic,
				topic,
				terminalBarrier: undefined,
				terminalState: recovered.terminal ? "terminal" : "active",
				gate: undefined,
			};
			registration.handle = makeV3PlaneHandle(registration);
			v3HandleRegistrations.set(registration.handle, registration);
			registrations ??= new IntrinsicMap<string, V3PlaneRegistration>();
			registrations.set(topic, registration);
			v3PlaneRegistrations.set(boundNetworkNode, registrations);
			return ObjectFreeze({ handle: registration.handle, ok: true as const });
		} catch {
			return activationFailureAfterCleanup(
				"internal-invariant",
				"v3 activation failed",
				boundNetworkNode,
				boundQueueManager,
				topic,
				queueId,
				networkSubscriptionAttempted
			);
		}
	} catch {
		return activationFailure("internal-invariant", "v3 activation failed");
	}
}

/**
 * Claims and queues a v3 envelope before legacy discovery dispatch.
 * @param networkNode - Exact network owner that authenticated the gossip message.
 * @param message - Exact decoded message identity from network ingress.
 * @returns Whether v3 owns the message and legacy dispatch must stop.
 */
export function routeV3Ingress(networkNode: DRPNetworkNode, message: Message): boolean {
	try {
		const gossipTopic = networkNode.gossipTopicFor(message);
		if (gossipTopic === undefined) return message.type === MessageType.MESSAGE_TYPE_V3_ENVELOPE;
		const registration = v3PlaneRegistrations.get(networkNode)?.get(gossipTopic);
		if (registration === undefined || !currentRegistration(registration)) {
			return message.type === MessageType.MESSAGE_TYPE_V3_ENVELOPE;
		}
		if (
			message.type !== MessageType.MESSAGE_TYPE_V3_ENVELOPE ||
			message.objectId !== gossipTopic ||
			gossipTopic !== registration.topic
		) {
			return true;
		}
		void registration.messageQueueManager
			.enqueue(registration.queueId, message)
			.catch(() => ingressFailureLog("queue-rejected"));
		return true;
	} catch {
		return message.type === MessageType.MESSAGE_TYPE_V3_ENVELOPE;
	}
}

/**
 * Queues one authenticated point-to-point retained envelope through the same
 * signature, ACL, journal and graph admission path as live gossip ingress.
 * @param handle Active v3 plane handle.
 * @param message Direct retained envelope.
 * @returns Whether the active v3 plane accepted the envelope for processing.
 */
export function routeV3RetainedIngress(handle: V3PlaneHandle, message: Message): boolean {
	const registration = v3HandleRegistrations.get(handle);
	if (
		registration === undefined ||
		!currentRegistration(registration) ||
		message.type !== MessageType.MESSAGE_TYPE_V3_ENVELOPE ||
		message.objectId !== registration.topic ||
		registration.networkNode.gossipTopicFor(message) !== undefined
	) {
		return false;
	}
	void enqueueV3Ingress(registration, message, "retained");
	return true;
}

/**
 * Replays the authenticated retained journal directly to one connected peer.
 * @param handle Active v3 plane handle.
 * @param targetPeerId Connected peer that requested retained history.
 * @returns The bounded publication result.
 */
export function republishV3RetainedTo(handle: V3PlaneHandle, targetPeerId: string): Promise<V3EgressResult> {
	const registration = v3HandleRegistrations.get(handle);
	if (
		registration === undefined ||
		!currentRegistration(registration) ||
		typeof targetPeerId !== "string" ||
		targetPeerId.length === 0 ||
		targetPeerId === registration.networkNode.peerId ||
		!registration.networkNode.getAllPeers().includes(targetPeerId)
	) {
		return Promise.resolve(egressFailure("not-active", "v3 retained target is unavailable"));
	}
	return enqueueTargetedRetainedPublication(registration, targetPeerId);
}

export { prepareV3LiveGeneration };
