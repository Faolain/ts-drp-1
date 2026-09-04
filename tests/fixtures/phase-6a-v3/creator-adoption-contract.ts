import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	type CloseSetHistoryCommitment,
	CompactMerkleAccumulator,
	deriveCloseSetHistoryCommitment,
	type EpochVertex,
} from "@ts-drp/compaction";
import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import type { DurableIssuanceStore, DurableIssueCommit, DurableIssueScope } from "@ts-drp/issuance-store";
import type { DurableIssuancePruningMaintenance } from "@ts-drp/issuance-store/maintenance";
// eslint-disable-next-line import/no-unresolved -- Workspace subpath resolves after the required package build.
import { createRecoverableFinalitySigner } from "@ts-drp/keychain/finality";
import type {
	DurableLiveJournalStore,
	LiveJournalAcceptedRow,
	LiveJournalScope,
	LiveJournalSnapshotToken,
} from "@ts-drp/live-journal";
import { MessageQueueManager } from "@ts-drp/message-queue";
import {
	type AheDurableStore,
	digestBlob,
	type GenerationRecord,
	type GenerationRef,
	parseStorageObjectId,
	type PresentHead,
} from "@ts-drp/storage";
import type {
	SnapshotQuarantineDeclaration,
	SnapshotQuarantineScope,
	SnapshotQuarantineStore,
	SnapshotVerificationReceipt,
} from "@ts-drp/storage/snapshot-transfer";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { activateCreatorSuccessorAdoption } from "../../../packages/node/src/creator-adoption-activate.js";
import type { commitCreatorSuccessorAdoption } from "../../../packages/node/src/creator-adoption-commit.js";
import type { verifyCreatorSuccessorAdoption } from "../../../packages/node/src/creator-adoption.js";
import type {
	bindCreatorLiveClose,
	CreatorLiveCloseHandle,
	CreatorLiveCloseResult,
} from "../../../packages/node/src/creator-close.js";
import type {
	activateV3LivePlane,
	bindV3BlueprintLivePlane,
	PreparedV3Live,
	RecoveredV3Live,
	recoverV3LiveReplica,
	routeV3Ingress,
	V3AdmittedVertexSink,
	V3LocalIssueInput,
	V3OperationAdmissionPolicy,
	V3PlaneHandle,
} from "../../../packages/node/src/v3-live.js";
import type { CurrentAnchorTrust } from "../../../packages/protocol-v3/src/index.js";
import type { openBrowserSealEvidenceStore } from "../../../packages/storage-browser/src/seal-evidence.js";
import type { openBrowserSealVoteStore } from "../../../packages/storage-browser/src/seal-vote.js";
import type { createBrowserSnapshotQuarantineStore } from "../../../packages/storage-browser/src/snapshot-transfer.js";
import type { resolveNodeDurableIssuancePruningMaintenance } from "../../../packages/storage-node/src/issuance-maintenance.js";
import type { createNodeDurableIssuanceStore } from "../../../packages/storage-node/src/issuance.js";
import type { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/src/live-journal.js";
import { contract, hexBytes } from "../phase-3a0-v3/controlled-anchor-trust.js";
import {
	createGenuinePreparedV3Fixture,
	type CreateSqliteAheDurableStoreForFixture,
	type GenuinePreparedV3Fixture,
	type PrepareV3LiveGenerationForFixture,
} from "../phase-3a1b-p3/live-fixture.js";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export interface GenuineCreatorAdoptionFixtureModules {
	readonly activateCreatorSuccessorAdoption: typeof activateCreatorSuccessorAdoption;
	readonly activateV3LivePlane: typeof activateV3LivePlane;
	readonly bindCreatorLiveClose: typeof bindCreatorLiveClose;
	readonly bindV3BlueprintLivePlane: typeof bindV3BlueprintLivePlane;
	readonly commitCreatorSuccessorAdoption: typeof commitCreatorSuccessorAdoption;
	readonly createBrowserSnapshotQuarantineStore: typeof createBrowserSnapshotQuarantineStore;
	readonly createNodeDurableIssuanceStore: typeof createNodeDurableIssuanceStore;
	readonly createNodeDurableLiveJournalStore: typeof createNodeDurableLiveJournalStore;
	readonly createSqliteAheDurableStore: CreateSqliteAheDurableStoreForFixture;
	readonly openBrowserSealEvidenceStore: typeof openBrowserSealEvidenceStore;
	readonly openBrowserSealVoteStore: typeof openBrowserSealVoteStore;
	readonly prepareV3LiveGeneration: PrepareV3LiveGenerationForFixture;
	readonly recoverV3LiveReplica: typeof recoverV3LiveReplica;
	readonly resolveNodeDurableIssuancePruningMaintenance: typeof resolveNodeDurableIssuancePruningMaintenance;
	readonly routeV3Ingress: typeof routeV3Ingress;
	readonly verifyCreatorSuccessorAdoption: typeof verifyCreatorSuccessorAdoption;
}

async function defaultCreatorAdoptionFixtureModules(): Promise<GenuineCreatorAdoptionFixtureModules> {
	const source = (relative: string): string => pathToFileURL(resolve(REPOSITORY_ROOT, relative)).href;
	const [
		activation,
		v3Live,
		creatorClose,
		commit,
		adoption,
		browserSnapshot,
		browserEvidence,
		browserVote,
		storageNode,
		issuance,
		issuanceMaintenance,
		liveJournal,
	] = await Promise.all([
		import(source("packages/node/src/creator-adoption-activate.ts")) as Promise<
			Pick<GenuineCreatorAdoptionFixtureModules, "activateCreatorSuccessorAdoption">
		>,
		import(source("packages/node/src/v3-live.ts")) as Promise<
			Pick<
				GenuineCreatorAdoptionFixtureModules,
				| "activateV3LivePlane"
				| "bindV3BlueprintLivePlane"
				| "prepareV3LiveGeneration"
				| "recoverV3LiveReplica"
				| "routeV3Ingress"
			>
		>,
		import(source("packages/node/src/creator-close.ts")) as Promise<
			Pick<GenuineCreatorAdoptionFixtureModules, "bindCreatorLiveClose">
		>,
		import(source("packages/node/src/creator-adoption-commit.ts")) as Promise<
			Pick<GenuineCreatorAdoptionFixtureModules, "commitCreatorSuccessorAdoption">
		>,
		import(source("packages/node/src/creator-adoption.ts")) as Promise<
			Pick<GenuineCreatorAdoptionFixtureModules, "verifyCreatorSuccessorAdoption">
		>,
		import(source("packages/storage-browser/src/snapshot-transfer.ts")) as Promise<
			Pick<GenuineCreatorAdoptionFixtureModules, "createBrowserSnapshotQuarantineStore">
		>,
		import(source("packages/storage-browser/src/seal-evidence.ts")) as Promise<
			Pick<GenuineCreatorAdoptionFixtureModules, "openBrowserSealEvidenceStore">
		>,
		import(source("packages/storage-browser/src/seal-vote.ts")) as Promise<
			Pick<GenuineCreatorAdoptionFixtureModules, "openBrowserSealVoteStore">
		>,
		import(source("packages/storage-node/dist/src/index.js")) as Promise<
			Pick<GenuineCreatorAdoptionFixtureModules, "createSqliteAheDurableStore">
		>,
		import(source("packages/storage-node/src/issuance.ts")) as Promise<
			Pick<GenuineCreatorAdoptionFixtureModules, "createNodeDurableIssuanceStore">
		>,
		import(source("packages/storage-node/src/issuance-maintenance.ts")) as Promise<
			Pick<GenuineCreatorAdoptionFixtureModules, "resolveNodeDurableIssuancePruningMaintenance">
		>,
		import(source("packages/storage-node/src/live-journal.ts")) as Promise<
			Pick<GenuineCreatorAdoptionFixtureModules, "createNodeDurableLiveJournalStore">
		>,
	]);
	return Object.freeze({
		activateCreatorSuccessorAdoption: activation.activateCreatorSuccessorAdoption,
		activateV3LivePlane: v3Live.activateV3LivePlane,
		bindCreatorLiveClose: creatorClose.bindCreatorLiveClose,
		bindV3BlueprintLivePlane: v3Live.bindV3BlueprintLivePlane,
		commitCreatorSuccessorAdoption: commit.commitCreatorSuccessorAdoption,
		createBrowserSnapshotQuarantineStore: browserSnapshot.createBrowserSnapshotQuarantineStore,
		createNodeDurableIssuanceStore: issuance.createNodeDurableIssuanceStore,
		createNodeDurableLiveJournalStore: liveJournal.createNodeDurableLiveJournalStore,
		createSqliteAheDurableStore:
			storageNode.createSqliteAheDurableStore as unknown as CreateSqliteAheDurableStoreForFixture,
		openBrowserSealEvidenceStore: browserEvidence.openBrowserSealEvidenceStore,
		openBrowserSealVoteStore: browserVote.openBrowserSealVoteStore,
		prepareV3LiveGeneration: v3Live.prepareV3LiveGeneration,
		recoverV3LiveReplica: v3Live.recoverV3LiveReplica,
		resolveNodeDurableIssuancePruningMaintenance: issuanceMaintenance.resolveNodeDurableIssuancePruningMaintenance,
		routeV3Ingress: v3Live.routeV3Ingress,
		verifyCreatorSuccessorAdoption: adoption.verifyCreatorSuccessorAdoption,
	});
}

/**
 * Creates the deterministic in-memory network owner shared by lifecycle fixtures.
 * @param peerId - Stable peer identity for the fixture instance.
 * @returns Minimal DRP network surface used by the live-plane tests.
 */
export function fakeNetwork(peerId: string): DRPNetworkNode {
	const topics = new Set<string>();
	return {
		peerId,
		membershipVerifier: undefined,
		start: () => Promise.resolve(),
		stop: () => Promise.resolve(),
		restart: () => Promise.resolve(),
		isDialable: () => Promise.resolve(true),
		changeTopicScoreParams: () => undefined,
		removeTopicScoreParams: () => undefined,
		subscribe: (topic: string) => topics.add(topic),
		unsubscribe: (topic: string) => topics.delete(topic),
		connectToBootstraps: () => Promise.resolve(),
		connect: () => Promise.resolve(),
		disconnect: () => Promise.resolve(),
		getPeerMultiaddrs: () => Promise.resolve([]),
		getBootstrapNodes: () => [],
		getSubscribedTopics: () => [...topics],
		getMultiaddrs: () => ["/ip4/127.0.0.1/tcp/1"],
		getAllPeers: () => [],
		getGroupPeers: () => [],
		broadcastMessage: () => Promise.resolve(),
		publishMessage: () => Promise.resolve(true),
		sendMessage: () => Promise.resolve(),
		sendMessageToRandomPeer: () => Promise.resolve(),
		sendGroupMessage: () => Promise.resolve(),
		subscribeToMessageQueue: () => undefined,
		onGroupPeerChange: () => () => undefined,
		gossipTopicFor: () => undefined,
	} as unknown as DRPNetworkNode;
}

export const D108B_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-adoption-contract.ts",
	"tests/phase-6a-creator-adoption-red.test.ts",
	"tests/fixtures/phase-3a1b-p3/live-fixture.ts",
] as const);

export const D108B_GREEN_PATHS = Object.freeze([
	"packages/node/src/creator-adoption.ts",
	"packages/node/src/internal/creator-adoption-intent.ts",
	"packages/node/src/creator-close.ts",
	"packages/node/src/v3-live.ts",
	"packages/node/package.json",
] as const);

export const CREATOR_ADOPTION_EXPORTS = Object.freeze(["verifyCreatorSuccessorAdoption"] as const);

export const CREATOR_ADOPTION_FAILURE_KINDS = Object.freeze([
	"malformed-input",
	"sealed-live-unavailable",
	"recovery-failed",
	"chain-invalid",
	"journal-invalid",
	"snapshot-invalid",
	"blueprint-invalid",
	"internal-invariant",
] as const);

export const V3_LIVE_GENERATION_2_KEYS = Object.freeze([
	"aclDigest",
	"anchorDigest",
	"archiveIndexRoot",
	"artifactDigest",
	"artifactId",
	"blueprintDigest",
	"byteCharge",
	"catalogDigest",
	"compactHistory",
	"epoch",
	"graphDigest",
	"historyRoot",
	"historySize",
	"kind",
	"maxDependencies",
	"maxEpochBytes",
	"maxEpochVertices",
	"objectId",
	"orderedVertexHashesDigest",
	"parametersDigest",
	"previousHistoryRoot",
	"previousHistorySize",
	"profileDigest",
	"runtimeProfile",
	"signerSetDigest",
	"snapshotManifestDigest",
	"snapshotPayloadDigest",
	"stateDigest",
	"trustProfile",
	"vertexCount",
	"version",
] as const);

export const CUT_VALUE_FIELDS = Object.freeze([
	"kind",
	"protocolMajor",
	"encodingVersion",
	"objectId",
	"epoch",
	"previousAnchor",
	"previousCutDigest",
	"previousHistoryRoot",
	"previousHistorySize",
	"closeSetRoot",
	"closeSetCount",
	"historyRoot",
	"historySize",
	"stateDigest",
	"aclDigest",
	"snapshotManifestDigest",
	"blueprintDigest",
	"archiveIndexRoot",
	"availabilityPolicyDigest",
	"nextSignerSet",
	"parameters",
	"closeReason",
] as const);

export const D108B_MUTANTS = Object.freeze([
	...CUT_VALUE_FIELDS.map((field) => `cut:${field}` as const),
	"cut-swap",
	"qc-swap",
	"qc-prepare-as-commit",
	"qc-duplicate-signer",
	"trust-old",
	"trust-foreign",
	"pending-head-ref-length",
	"pending-head-ref-digest",
	"predecessor-link-missing",
	"predecessor-link-duplicate",
	"predecessor-link-cycle",
	"predecessor-link-skipped",
	"post-close-durable-vertex",
	"durable-local-issued-missing",
	"close-order",
	"history-extension",
	"manifest-old",
	"manifest-foreign",
	"manifest-chunk-size",
	"manifest-chunk-digest",
	"manifest-chunk-gap",
	"payload-state",
	"payload-acl",
	"payload-archive",
	"payload-anchor",
	"payload-blueprint",
	"catalog-wrong-blueprint",
	"catalog-wrong-artifact",
] as const);

export interface CandidateCreatorAdoptionModule {
	verifyCreatorSuccessorAdoption?(input: unknown): Promise<Readonly<Record<string, unknown>>>;
}

export interface GenuineCreatorAdoptionFixture {
	readonly catalog: TrustedBlueprintCatalog;
	readonly evidence: Readonly<{
		readonly aheBackend: AheDurableStore;
		readonly aheStore: AheDurableStore;
		readonly chunks: readonly Uint8Array[];
		readonly closeResult: CreatorLiveCloseResult;
		readonly current: DetachedHeadEvidence;
		readonly currentTrust: CurrentAnchorTrust;
		readonly declaration: SnapshotQuarantineDeclaration;
		readonly establishedPeer?: Readonly<{
			readonly author: string;
			readonly authorSequence: 0;
			readonly canonicalPreimageBytes: Uint8Array;
			readonly digest: Uint8Array;
			readonly signature: Uint8Array;
		}>;
		readonly exactCanonicalPayloadBytes: Uint8Array;
		readonly exactCanonicalProjectionBytes: Uint8Array;
		readonly generations: readonly GenerationRecord[];
		readonly history: CloseSetHistoryCommitment;
		readonly issuanceScope: DurableIssueScope;
		readonly issuanceMaintenance: DurableIssuancePruningMaintenance;
		readonly issuanceStore: DurableIssuanceStore;
		readonly journalRows: readonly LiveJournalAcceptedRow[];
		readonly journalSnapshot: LiveJournalSnapshotToken;
		readonly localIssued: Readonly<{ readonly authorSequence: number; readonly digest: string }>;
		readonly predecessorExactCanonicalLatchedAclBytes: Uint8Array;
		readonly proposed: DetachedHeadEvidence;
		readonly snapshotStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
	}>;
	readonly controls: {
		activeRefMutation?: "digest" | "length";
		activeRefLengthMutation?: Readonly<{ readonly byteLength: number; readonly kind: string }>;
		adoptionPhase: boolean;
		aheMutationCount: number;
		aheMutationHook?(observation: CreatorAdoptionAheMutationObservation): void;
		readonly aheOperationCounts: Map<CreatorAdoptionAheMutationOperation, number>;
		readonly blobOverrides: Map<string, Uint8Array>;
		cutField?: (typeof CUT_VALUE_FIELDS)[number];
		durableReadHook?(observation: CreatorAdoptionDurableReadObservation): void;
		generationMutation?: "cycle" | "duplicate" | "missing" | "skipped";
		issuanceMissing: boolean;
		journalMutation?: "reverse";
		mutateSnapshotChunk: boolean;
		snapshotChunkOverride?: readonly Uint8Array[];
	};
	readonly handle: CreatorLiveCloseHandle;
	readonly journal: DurableLiveJournalStore;
	readonly modules: GenuineCreatorAdoptionFixtureModules;
	readonly runtimeBindings: Readonly<{
		readonly messageQueueManager: MessageQueueManager<Message>;
		readonly networkNode: DRPNetworkNode;
		onAdmittedVertex(input: Readonly<Record<string, unknown>>): Promise<void> | void;
	}>;
	readonly scope: LiveJournalScope;
	readonly createRegisteredVertex: GenuinePreparedV3Fixture["createRegisteredVertex"];
	routeRegisteredVertex(
		vertex: ReturnType<GenuinePreparedV3Fixture["createRegisteredVertex"]>,
		transportSender?: string
	): Promise<void>;
	readonly signRegisteredVertexDigest: V3LocalIssueInput["signRegisteredVertexDigest"];
	close(): Promise<void>;
}

export interface GenuineCreatorAdoptionFixtureOptions {
	readonly applicationBatch?: boolean;
	readonly authorizedPrivateKeySeedHexes?: readonly string[];
	readonly causalJoinOperation?: boolean;
	beforeCreatorClose?(
		input: Readonly<{
			readonly createRegisteredVertex: GenuinePreparedV3Fixture["createRegisteredVertex"];
			readonly firstLogicalTime: number;
			readonly initialDependency: string;
			readonly plane: V3PlaneHandle;
			routeRegisteredVertex(
				vertex: ReturnType<GenuinePreparedV3Fixture["createRegisteredVertex"]>,
				transportSender?: string
			): Promise<void>;
			routeRegisteredVertexUnchecked(
				vertex: ReturnType<GenuinePreparedV3Fixture["createRegisteredVertex"]>,
				transportSender?: string
			): boolean;
			readonly signRegisteredVertexDigest: V3LocalIssueInput["signRegisteredVertexDigest"];
			wasRegisteredVertexAdmitted(vertex: ReturnType<GenuinePreparedV3Fixture["createRegisteredVertex"]>): boolean;
		}>
	): Promise<Readonly<{ readonly authorSequence: number; readonly digest: string }>>;
	decorateIssuanceStore?(store: DurableIssuanceStore): DurableIssuanceStore;
	decorateLiveJournalStore?(store: DurableLiveJournalStore): DurableLiveJournalStore;
	readonly operationAdmissionPolicy?: V3OperationAdmissionPolicy;
	readonly establishedPeerPrivateKeySeedHex?: string;
	readonly latchedAclGroups?: readonly ("admin" | "finality" | "referee" | "writer")[];
	readonly modules?: GenuineCreatorAdoptionFixtureModules;
	readonly objectId?: string;
	readonly stageAclChange?: boolean;
	readonly stringPayloadOperation?: boolean;
	readonly successorAclGroups?: Readonly<Record<string, readonly ("admin" | "finality" | "writer")[]>>;
}

/**
 * Runs the public predecessor verification and durable adoption commit shared by lifecycle fixtures.
 * @param fixture - Genuine sealed predecessor and successor evidence.
 * @returns One-use committed activation capability.
 */
export async function commitGenuineCreatorAdoptionFixture(
	fixture: GenuineCreatorAdoptionFixture
): Promise<Readonly<Record<string, unknown>>> {
	const verified = await fixture.modules.verifyCreatorSuccessorAdoption({
		catalog: fixture.catalog,
		handle: fixture.handle,
	});
	if (verified.ok !== true) throw new TypeError(`D.108d1a verification failed: ${String(verified.kind)}`);
	const committed = await fixture.modules.commitCreatorSuccessorAdoption({
		handle: fixture.handle,
		intent: verified.intent,
	});
	if (committed.ok !== true) throw new TypeError(`D.108d1a commit failed: ${String(committed.kind)}`);
	return committed;
}

export type CreatorAdoptionAheMutationOperation =
	| "beginGeneration"
	| "completeGeneration"
	| "discardGeneration"
	| "promoteReference"
	| "putCachedBlob"
	| "swapHead";

export interface CreatorAdoptionAheMutationObservation {
	readonly edge: "after-request" | "before-request";
	readonly occurrence: number;
	readonly operation: CreatorAdoptionAheMutationOperation;
}

export interface CreatorAdoptionDurableReadObservation {
	readonly identity: number | string;
	readonly owner:
		| "ahe-blob"
		| "ahe-generation"
		| "ahe-head"
		| "issuance-lineage"
		| "issuance-outbox"
		| "issuance-record"
		| "live-journal-row"
		| "snapshot-chunk";
}

export interface DetachedHeadEvidence {
	readonly candidates: readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[];
	readonly head: PresentHead;
	readonly references: readonly GenerationRef[];
	readonly trustRef: GenerationRef;
}

export type ModelIntent = Readonly<Record<never, never>>;

/**
 * Independent one-use custody oracle used before the production owner exists.
 * @returns Model intent, owner and destructive consumer.
 */
export function modelIntentCustody(): Readonly<{
	consume(intent: unknown, owner: object): unknown;
	intent: ModelIntent;
	owner: object;
}> {
	const owner = Object.freeze({});
	const intent = Object.freeze({}) as ModelIntent;
	const states = new WeakMap<object, Readonly<{ owner: object; value: string }>>();
	states.set(intent, Object.freeze({ owner, value: "verified" }));
	return Object.freeze({
		consume(candidate, candidateOwner) {
			if (candidate === null || typeof candidate !== "object") return undefined;
			const state = states.get(candidate);
			if (state === undefined || state.owner !== candidateOwner) return undefined;
			states.delete(candidate);
			return state.value;
		},
		intent,
		owner,
	});
}

/**
 * Returns one independently changed field value for the exact CutValue mutation table.
 * @param field - Exact registered CutValue field under mutation.
 * @param value - Current independently decoded field value.
 * @returns A distinct canonical-encodable field value.
 */
function changedField(field: (typeof CUT_VALUE_FIELDS)[number], value: unknown): unknown {
	if (field === "kind") return "drp-hard-epoch-cut-mutant";
	if (field === "protocolMajor") return 4;
	if (field === "encodingVersion") return "drp-canonical-profile-mutant";
	if (field === "closeReason") return "mutated-close";
	if (field === "nextSignerSet") {
		return Array.isArray(value) && value[0] !== undefined ? [value[0], value[0]] : [];
	}
	if (field === "parameters" && value !== null && typeof value === "object") {
		return { ...(value as Record<string, unknown>), maxDependencies: 17 };
	}
	if (typeof value === "number") return value + 1;
	if (typeof value === "string") return value === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
	return null;
}

/**
 * Mutates exactly one registered CutValue field while preserving canonical encoding.
 * @param bytes - Genuine canonical CutValue bytes.
 * @param field - Registered field to change, or undefined for a transparent read.
 * @returns Exact original or single-field mutant bytes.
 */
export function mutatedCutBlob(bytes: Uint8Array, field: (typeof CUT_VALUE_FIELDS)[number] | undefined): Uint8Array {
	if (field === undefined) return bytes;
	try {
		const value = decodeCanonical(bytes);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return bytes;
		const record = value as Record<string, unknown>;
		if (record.kind !== "drp-hard-epoch-cut" || !Object.hasOwn(record, field)) return bytes;
		return encodeCanonical({ ...record, [field]: changedField(field, record[field]) });
	} catch {
		return bytes;
	}
}

/**
 * Resolves one exact detached closure blob from captured genuine evidence.
 * @param evidence - Captured head closure and candidate bytes.
 * @param ref - Exact reference to resolve.
 * @returns Detached exact blob bytes.
 */
export function bytesForRef(evidence: DetachedHeadEvidence, ref: GenerationRef): Uint8Array {
	const candidate = evidence.candidates.find(
		(entry) => entry.ref.byteLength === ref.byteLength && entry.ref.digest === ref.digest
	);
	if (candidate === undefined) throw new TypeError(`D.108b fixture ref is absent: ${ref.digest}`);
	return Uint8Array.from(candidate.bytes);
}

function decoratedAheStore(
	backend: AheDurableStore,
	controls: GenuineCreatorAdoptionFixture["controls"]
): AheDurableStore {
	const observe = (owner: CreatorAdoptionDurableReadObservation["owner"], identity: number | string): void =>
		controls.durableReadHook?.(Object.freeze({ identity, owner }));

	function mutate<T>(operation: CreatorAdoptionAheMutationOperation, request: () => Promise<T>): Promise<T> {
		const occurrence = controls.aheOperationCounts.get(operation) ?? 0;
		controls.aheOperationCounts.set(operation, occurrence + 1);
		controls.aheMutationCount += 1;
		controls.aheMutationHook?.(Object.freeze({ edge: "before-request", occurrence, operation }));
		return request().then((result) => {
			controls.aheMutationHook?.(Object.freeze({ edge: "after-request", occurrence, operation }));
			return result;
		});
	}
	return Object.freeze({
		capabilities: backend.capabilities,
		beginGeneration: (input) => mutate("beginGeneration", () => backend.beginGeneration(input)),
		close: () => backend.close(),
		completeGeneration: (input) => mutate("completeGeneration", () => backend.completeGeneration(input)),
		discardGeneration: (input) => mutate("discardGeneration", () => backend.discardGeneration(input)),
		getBlob: async (digest) => {
			observe("ahe-blob", digest);
			const result = await backend.getBlob(digest);
			if (!result.ok || result.value === null) return result;
			const override = controls.blobOverrides.get(digest);
			if (override !== undefined) return Object.freeze({ ok: true as const, value: Uint8Array.from(override) });
			return Object.freeze({ ok: true as const, value: mutatedCutBlob(result.value, controls.cutField) });
		},
		promoteReference: (input) => mutate("promoteReference", () => backend.promoteReference(input)),
		putCachedBlob: (input) => mutate("putCachedBlob", () => backend.putCachedBlob(input)),
		readGenerationPage: async (input) => {
			const result = await backend.readGenerationPage(input);
			if (result.ok) {
				for (const generation of result.value.generations) {
					observe("ahe-generation", generation.generationId);
					for (const reference of generation.closure) observe("ahe-blob", reference.digest);
				}
			}
			if (!result.ok || controls.generationMutation === undefined || result.value.generations.length < 2) return result;
			const generations = [...result.value.generations];
			const last = generations.findLast(({ state }) => state === "Adopted") ?? generations.at(-1);
			if (last === undefined) return result;
			if (controls.generationMutation === "missing") generations.splice(Math.max(0, generations.length - 2), 1);
			else if (controls.generationMutation === "duplicate") generations.push(last);
			else {
				const index = generations.indexOf(last);
				const base = last.baseExpectedHead;
				if (base.kind !== "present") return result;
				generations[index] = Object.freeze({
					...last,
					baseExpectedHead: Object.freeze({
						...base,
						...(controls.generationMutation === "cycle"
							? { generationId: last.generationId }
							: { revision: Math.max(0, base.revision - 1) }),
					}),
				});
			}
			return Object.freeze({ ok: true as const, value: Object.freeze({ ...result.value, generations }) });
		},
		readHead: async (objectId) => {
			const result = await backend.readHead(objectId);
			if (result.ok && result.value.kind === "present") observe("ahe-head", result.value.generationId);
			return result;
		},
		recoverActiveGeneration: async (objectId) => {
			const result = await backend.recoverActiveGeneration(objectId);
			if (result.ok && result.value.kind === "active") {
				observe("ahe-generation", result.value.adoptedGeneration.generationId);
				for (const reference of result.value.references) observe("ahe-blob", reference.digest);
			}
			if (!result.ok || result.value.kind !== "active") return result;
			const activeRefLengthMutation = controls.activeRefLengthMutation;
			let selectedDigest: string | undefined;
			if (activeRefLengthMutation !== undefined) {
				for (const reference of result.value.references) {
					const loaded = await backend.getBlob(reference.digest);
					if (!loaded.ok || loaded.value === null) continue;
					try {
						const decoded = decodeCanonical(loaded.value);
						if (
							decoded !== null &&
							typeof decoded === "object" &&
							!Array.isArray(decoded) &&
							(decoded as Readonly<Record<string, unknown>>).kind === activeRefLengthMutation.kind
						) {
							selectedDigest = reference.digest;
							break;
						}
					} catch {
						// Non-canonical fixture closure blobs are not candidates for this targeted mutation.
					}
				}
				if (selectedDigest === undefined) {
					throw new TypeError(`D110C_0C1K_ACTIVE_REF_KIND_UNAVAILABLE:${activeRefLengthMutation.kind}`);
				}
			}
			if (controls.activeRefMutation === undefined && selectedDigest === undefined) return result;
			const selectedByteLength = activeRefLengthMutation?.byteLength;
			const references = result.value.references.map((ref, index) =>
				selectedDigest === ref.digest
					? { ...ref, byteLength: selectedByteLength ?? ref.byteLength }
					: index !== 0 || controls.activeRefMutation === undefined
						? ref
						: controls.activeRefMutation === "length"
							? { ...ref, byteLength: ref.byteLength + 1 }
							: { ...ref, digest: "f".repeat(64) as typeof ref.digest }
			);
			return Object.freeze({
				ok: true as const,
				value: Object.freeze({
					...result.value,
					adoptedGeneration: Object.freeze({ ...result.value.adoptedGeneration, closure: references }),
					references,
				}),
			});
		},
		swapHead: (input) => mutate("swapHead", () => backend.swapHead(input)),
	});
}

function decoratedSnapshotStore(
	backend: SnapshotQuarantineStore<SnapshotVerificationReceipt>,
	controls: GenuineCreatorAdoptionFixture["controls"],
	observeDeclaration: (declaration: SnapshotQuarantineDeclaration) => void
): SnapshotQuarantineStore<SnapshotVerificationReceipt> {
	return Object.freeze({
		close: () => backend.close(),
		openScope: async (declaration, options) => {
			observeDeclaration(declaration);
			const scope = await backend.openScope(declaration, options);
			if (!controls.adoptionPhase) return scope;
			const decorated: SnapshotQuarantineScope<SnapshotVerificationReceipt> = Object.freeze({
				cancel: (selected) => scope.cancel(selected),
				complete: (receipt, selected) => scope.complete(receipt, selected),
				missingIndices: (selected) => scope.missingIndices(selected),
				release: () => scope.release(),
				scope: scope.scope,
				status: (selected) => scope.status(selected),
				verificationQuarantine: Object.freeze({
					open(signal) {
						const port = scope.verificationQuarantine.open(signal);
						return Object.freeze({
							discard: () => port.discard(),
							read: async (descriptor) => {
								controls.durableReadHook?.(Object.freeze({ identity: descriptor.digest, owner: "snapshot-chunk" }));
								const bytes = await port.read(descriptor);
								const override = controls.snapshotChunkOverride?.[descriptor.index];
								if (override !== undefined) return Uint8Array.from(override);
								if (bytes === undefined || !controls.mutateSnapshotChunk || descriptor.index !== 0) return bytes;
								const mutant = Uint8Array.from(bytes);
								if (mutant.byteLength > 0) mutant[0] = (mutant[0] as number) ^ 1;
								return mutant;
							},
							write: (descriptor, bytes) => port.write(descriptor, bytes),
						});
					},
				}),
			});
			return decorated;
		},
		sweepExpired: (options) => backend.sweepExpired(options),
	});
}

async function detachedHeadEvidence(
	store: AheDurableStore,
	inspection: Awaited<ReturnType<CreatorLiveCloseHandle["inspectDurableHead"]>>
): Promise<DetachedHeadEvidence> {
	const candidates = await Promise.all(
		inspection.references.map(async (ref) => {
			const loaded = await store.getBlob(ref.digest);
			if (!loaded.ok || loaded.value === null || loaded.value.byteLength !== ref.byteLength) {
				throw new TypeError("D.108b fixture closure blob is unavailable");
			}
			return Object.freeze({ bytes: Uint8Array.from(loaded.value), ref: Object.freeze({ ...ref }) });
		})
	);
	return Object.freeze({
		candidates: Object.freeze(candidates),
		head: Object.freeze({ ...inspection.head }),
		references: Object.freeze(inspection.references.map((ref) => Object.freeze({ ...ref }))),
		trustRef: Object.freeze({ ...inspection.trustRef }),
	});
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function recoverWithDurableStores(
	fixture: Awaited<ReturnType<typeof createGenuinePreparedV3Fixture>>,
	capability: PreparedV3Live,
	controls: GenuineCreatorAdoptionFixture["controls"],
	modules: GenuineCreatorAdoptionFixtureModules,
	decorateIssuanceStore?: (store: DurableIssuanceStore) => DurableIssuanceStore,
	decorateLiveJournalStore?: (store: DurableLiveJournalStore) => DurableLiveJournalStore,
	operationAdmissionPolicy?: V3OperationAdmissionPolicy
): Promise<
	Readonly<{
		readonly capability: RecoveredV3Live;
		close(): Promise<void>;
		readonly issuanceStore: DurableIssuanceStore;
		readonly issuanceMaintenance: DurableIssuancePruningMaintenance;
		readonly journal: DurableLiveJournalStore;
	}>
> {
	const directory = mkdtempSync(join(tmpdir(), "drp-d108b-replay-"));
	const rawIssuanceStore = modules.createNodeDurableIssuanceStore({
		primaryFilename: join(directory, "issuance.sqlite"),
	});
	const issuanceMaintenance = modules.resolveNodeDurableIssuancePruningMaintenance(rawIssuanceStore);
	if (issuanceMaintenance === undefined) throw new TypeError("D.108b fixture issuance maintenance is unavailable");
	const rawJournal = modules.createNodeDurableLiveJournalStore({ primaryFilename: join(directory, "journal.sqlite") });
	const baseIssuanceStore: DurableIssuanceStore = Object.freeze({
		close: () => rawIssuanceStore.close(),
		compareAndMarkOutboxPublished: (input) => rawIssuanceStore.compareAndMarkOutboxPublished(input),
		readIssued: async (scope, sequence) => {
			controls.durableReadHook?.(Object.freeze({ identity: sequence, owner: "issuance-record" }));
			const result = controls.issuanceMissing ? null : await rawIssuanceStore.readIssued(scope, sequence);
			return result;
		},
		readLineage: async (scope) => {
			const result = await rawIssuanceStore.readLineage(scope);
			controls.durableReadHook?.(Object.freeze({ identity: result.next, owner: "issuance-lineage" }));
			return result;
		},
		readOutboxPage: async (input) => {
			const result = await rawIssuanceStore.readOutboxPage(input);
			for (const row of result) {
				controls.durableReadHook?.(Object.freeze({ identity: row.commit.authorSequence, owner: "issuance-outbox" }));
			}
			return result;
		},
		transactIssue: (scope, buildAndSign) => rawIssuanceStore.transactIssue(scope, buildAndSign),
	});
	const issuanceStore = decorateIssuanceStore?.(baseIssuanceStore) ?? baseIssuanceStore;
	const baseJournal: DurableLiveJournalStore = Object.freeze({
		appendAccepted: (input) => rawJournal.appendAccepted(input),
		close: () => rawJournal.close(),
		installEpochAnchor: (input) => rawJournal.installEpochAnchor(input),
		installGenesis: (input) => rawJournal.installGenesis(input),
		readiness: (input) => rawJournal.readiness(input),
		readPage: async (input) => {
			const result = await rawJournal.readPage(input);
			if (result.ok) {
				for (const row of result.rows) {
					controls.durableReadHook?.(Object.freeze({ identity: row.vertexDigest, owner: "live-journal-row" }));
				}
			}
			return result.ok && controls.journalMutation === "reverse"
				? Object.freeze({ ...result, rows: Object.freeze([...result.rows].reverse()) })
				: result;
		},
	});
	const journal = decorateLiveJournalStore?.(baseJournal) ?? baseJournal;
	try {
		const scope = Object.freeze({ author: fixture.author, objectId: fixture.objectId });
		const envelope = Object.freeze({
			canonicalPreimageBytes: Uint8Array.from(fixture.recoveryCanonicalPreimageBytes),
			digest: hashDomain("ts-drp/vertex/v3", fixture.recoveryCanonicalPreimageBytes),
			signature: Uint8Array.from(fixture.recoverySignature),
		});
		const bootstrapVertex = decodeCanonical(envelope.canonicalPreimageBytes) as Readonly<Record<string, unknown>>;
		const exactCanonicalPinnedGenesisBootstrapOperationBytes = encodeCanonical(bootstrapVertex.operation);
		await issuanceStore.transactIssue(scope, (authorSequence) => {
			if (authorSequence !== 0) throw new TypeError("D.108b recovery issuance sequence is invalid");
			return Promise.resolve(
				Object.freeze({
					authorSequence,
					envelope,
					issuedRecord: Object.freeze({ authorSequence, envelope, scope }),
					outboxEntry: Object.freeze({ authorSequence, envelope, scope }),
				}) satisfies DurableIssueCommit
			);
		});
		const installed = await journal.installGenesis({
			detachedAnchorSignature: fixture.detachedAnchorSignature,
			exactCanonicalAnchorPreimageBytes: fixture.exactCanonicalAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: fixture.exactCanonicalParametersCarrierBytes,
			objectId: fixture.objectId,
		});
		if (!installed.ok) throw new TypeError(`D.108b durable journal install failed: ${installed.kind}`);
		const appended = await journal.appendAccepted({
			detachedSignature: envelope.signature,
			exactCanonicalPreimageBytes: envelope.canonicalPreimageBytes,
			scope: installed.scope,
			sourceKind: "received",
			vertexDigest: hex(envelope.digest),
		});
		if (!appended.ok) throw new TypeError(`D.108b durable journal seed failed: ${appended.kind}`);
		if (fixture.exactCanonicalLatchedAclBytes === undefined) {
			throw new TypeError("D.108b fixture requires a latched ACL");
		}
		const recovered = await modules.recoverV3LiveReplica({
			capability,
			exactCanonicalLatchedAclBytes: fixture.exactCanonicalLatchedAclBytes,
			exactCanonicalPinnedGenesisBootstrapOperationBytes,
			issuanceScope: scope,
			issuanceStore,
			liveJournalStore: journal,
			...(operationAdmissionPolicy === undefined ? {} : { operationAdmissionPolicy }),
		});
		if (!recovered.ok) throw new TypeError(`D.108b durable recovery failed: ${recovered.kind}`);
		return Object.freeze({
			capability: recovered.capability,
			close: async () => {
				await Promise.all([rawIssuanceStore.close(), rawJournal.close()]);
				rmSync(directory, { force: true, recursive: true });
			},
			issuanceStore,
			issuanceMaintenance,
			journal,
		});
	} catch (error) {
		await Promise.allSettled([rawIssuanceStore.close(), rawJournal.close()]);
		rmSync(directory, { force: true, recursive: true });
		throw error;
	}
}

function expectedSuccessorProjection(
	catalog: TrustedBlueprintCatalog,
	closeResult: CreatorLiveCloseResult,
	current: DetachedHeadEvidence,
	proposed: DetachedHeadEvidence,
	history: CloseSetHistoryCommitment,
	declaration: SnapshotQuarantineDeclaration
): Uint8Array {
	const cut = decodeCanonical(bytesForRef(proposed, closeResult.cutValueRef)) as Readonly<Record<string, unknown>>;
	const successorTrust = decodeCanonical(bytesForRef(proposed, closeResult.successorTrustRef)) as Readonly<
		Record<string, unknown>
	>;
	const currentTrust = decodeCanonical(bytesForRef(current, closeResult.currentTrustRef)) as Readonly<
		Record<string, unknown>
	>;
	if (
		!(successorTrust.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
		!(currentTrust.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array)
	) {
		throw new TypeError("D.108b fixture trust anchors are unavailable");
	}
	const successorAnchorBytes = successorTrust.exactCanonicalCurrentAnchorPreimageBytes;
	const successorAnchor = decodeCanonical(successorAnchorBytes) as Readonly<Record<string, unknown>>;
	const currentAnchor = decodeCanonical(currentTrust.exactCanonicalCurrentAnchorPreimageBytes) as Readonly<
		Record<string, unknown>
	>;
	const parameters = cut.parameters as Readonly<Record<string, unknown>>;
	const resolved = catalog.resolve(String(successorAnchor.blueprintDigest));
	const ordered = encodeCanonical({
		kind: "v3-live-order-1",
		vertexHashes: [closeResult.successorAnchorDigest],
	});
	const graph = encodeCanonical({
		charges: [{ byteCharge: successorAnchorBytes.byteLength, hash: closeResult.successorAnchorDigest }],
		kind: "v3-live-graph-1",
		vertices: [
			{
				dependencies: [],
				epoch: 1,
				hash: closeResult.successorAnchorDigest,
				kind: "drp-epoch-anchor",
				objectId: successorAnchor.objectId,
			},
		],
	});
	const orderDigest = digestBlob(ordered);
	const graphDigest = digestBlob(graph);
	if (!orderDigest.ok || !graphDigest.ok) throw new TypeError("D.108b fixture projection digest failed");
	const manifest = decodeCanonical(declaration.exactCanonicalManifestBytes) as Readonly<Record<string, unknown>>;
	if (
		cut.previousHistoryRoot !== currentAnchor.historyRoot ||
		cut.previousHistorySize !== currentAnchor.historySize ||
		cut.historyRoot !== history.historyRoot ||
		cut.historySize !== history.historySize
	) {
		throw new TypeError("D.108b fixture history cross-link failed");
	}
	return encodeCanonical({
		aclDigest: successorAnchor.aclDigest,
		anchorDigest: closeResult.successorAnchorDigest,
		archiveIndexRoot: successorAnchor.archiveIndexRoot,
		artifactDigest: resolved.artifactDigest,
		artifactId: resolved.artifactId,
		blueprintDigest: successorAnchor.blueprintDigest,
		byteCharge: successorAnchorBytes.byteLength,
		catalogDigest: resolved.evidence.catalogDigest,
		compactHistory: history.historySnapshot,
		epoch: 1,
		graphDigest: graphDigest.value,
		historyRoot: history.historyRoot,
		historySize: history.historySize,
		kind: "v3-live-generation-2",
		maxDependencies: parameters.maxDependencies,
		maxEpochBytes: parameters.maxEpochBytes,
		maxEpochVertices: parameters.maxEpochVertices,
		objectId: successorAnchor.objectId,
		orderedVertexHashesDigest: orderDigest.value,
		parametersDigest: successorAnchor.parametersDigest,
		previousHistoryRoot: currentAnchor.historyRoot,
		previousHistorySize: currentAnchor.historySize,
		profileDigest: successorAnchor.profileDigest,
		runtimeProfile: resolved.runtimeProfile,
		signerSetDigest: successorAnchor.signerSetDigest,
		snapshotManifestDigest: cut.snapshotManifestDigest,
		snapshotPayloadDigest: manifest.payloadDigest,
		stateDigest: successorAnchor.stateDigest,
		trustProfile: "creator-only",
		vertexCount: 1,
		version: 2,
	});
}

async function genuineHistoryEvidence(
	exactCanonicalAnchorPreimageBytes: Uint8Array,
	rows: readonly LiveJournalAcceptedRow[],
	issuanceStore: DurableIssuanceStore
): Promise<CloseSetHistoryCommitment> {
	const anchor = decodeCanonical(exactCanonicalAnchorPreimageBytes) as Readonly<Record<string, unknown>>;
	const anchorDigest = rows[0]?.scope.anchorDigest;
	if (anchorDigest === undefined) throw new TypeError("D.108b fixture journal is empty");
	const vertices = new Map<string, EpochVertex>([
		[
			anchorDigest,
			{
				dependencies: [],
				epoch: Number(anchor.epoch),
				hash: anchorDigest,
				kind: "drp-epoch-anchor",
				objectId: String(anchor.objectId),
			},
		],
	]);
	const charges = new Map<string, number>();
	for (const row of rows) {
		let bytes: Uint8Array;
		if (row.sourceKind === "received") bytes = row.exactCanonicalPreimageBytes;
		else {
			const issued = await issuanceStore.readIssued(
				Object.freeze({ author: row.author, objectId: row.scope.objectId }),
				row.authorSequence
			);
			if (issued === null) throw new TypeError("D.108b fixture local-issued evidence is unavailable");
			bytes = issued.envelope.canonicalPreimageBytes;
		}
		const decoded = decodeCanonical(bytes) as Readonly<Record<string, unknown>>;
		vertices.set(
			row.vertexDigest,
			Object.freeze({
				anchor: decoded.anchor,
				dependencies: decoded.dependencies,
				epoch: decoded.epoch,
				hash: row.vertexDigest,
				kind: decoded.kind,
				objectId: decoded.objectId,
				operation: decoded.operation,
			}) as unknown as EpochVertex
		);
		charges.set(row.vertexDigest, bytes.byteLength);
	}
	const depended = new Set<string>();
	for (const [hash, vertex] of vertices) {
		if (hash === anchorDigest) continue;
		for (const dependency of vertex.dependencies) if (dependency !== anchorDigest) depended.add(dependency);
	}
	const frontier = [...charges.keys()].filter((hash) => !depended.has(hash));
	return deriveCloseSetHistoryCommitment({
		authenticatedCanonicalPreimageByteLengths: charges,
		exactCanonicalEpochAnchorPreimageBytes: exactCanonicalAnchorPreimageBytes,
		frontier,
		maxEpochBytes: 16_777_216,
		maxEpochVertices: 4096,
		previousHistorySnapshot: new CompactMerkleAccumulator().snapshot(),
		vertices,
	});
}

/**
 * Deletes one fixture-only IndexedDB database after all handles have closed.
 * @param name - Exact fixture database name.
 * @returns Completion after deletion, error or blocking is observed.
 */
function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolvePromise) => {
		const request = indexedDB.deleteDatabase(name);
		request.addEventListener("success", () => resolvePromise(), { once: true });
		request.addEventListener("error", () => resolvePromise(), { once: true });
		request.addEventListener("blocked", () => resolvePromise(), { once: true });
	});
}

/**
 * Builds the real pending-successor handoff consumed by the future verifier.
 * @param options - Optional distinct object identity for cross-close swap controls.
 * @returns Genuine sealed handle, trusted catalog, mutation controls and cleanup owner.
 */
export async function openGenuineCreatorAdoptionFixture(
	options: GenuineCreatorAdoptionFixtureOptions = {}
): Promise<GenuineCreatorAdoptionFixture> {
	const modules = options.modules ?? (await defaultCreatorAdoptionFixtureModules());
	const {
		activateV3LivePlane,
		bindCreatorLiveClose,
		bindV3BlueprintLivePlane,
		createBrowserSnapshotQuarantineStore,
		openBrowserSealEvidenceStore,
		openBrowserSealVoteStore,
		routeV3Ingress,
	} = modules;
	const controls: GenuineCreatorAdoptionFixture["controls"] = {
		adoptionPhase: false,
		aheMutationCount: 0,
		aheOperationCounts: new Map(),
		blobOverrides: new Map(),
		issuanceMissing: false,
		mutateSnapshotChunk: false,
	};
	const emptyHistoryRoot = Array.from(new CompactMerkleAccumulator().root(), (byte: number) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	const primaryDatabaseName = `d108b-seal-${crypto.randomUUID()}`;
	const snapshotDatabaseName = `d108b-snapshot-${crypto.randomUUID()}`;
	let aheBackend: AheDurableStore | undefined;
	let aheStore: AheDurableStore | undefined;
	let declaration: SnapshotQuarantineDeclaration | undefined;
	const fixture = await createGenuinePreparedV3Fixture({
		applicationBatch: options.applicationBatch === true,
		authorizationMode: "latched-acl",
		...(options.authorizedPrivateKeySeedHexes === undefined
			? {}
			: { authorizedPrivateKeySeedHexes: options.authorizedPrivateKeySeedHexes }),
		exactCanonicalInitialStateBytes: encodeCanonical(0),
		historyRoot: emptyHistoryRoot,
		historySize: 0,
		...(options.causalJoinOperation === undefined ? {} : { causalJoinOperation: options.causalJoinOperation }),
		...(options.latchedAclGroups === undefined ? {} : { latchedAclGroups: options.latchedAclGroups }),
		...(options.objectId === undefined ? {} : { objectId: options.objectId }),
		...(options.stringPayloadOperation === undefined ? {} : { stringPayloadOperation: options.stringPayloadOperation }),
		createSqliteAheDurableStore: modules.createSqliteAheDurableStore,
		prepareV3LiveGeneration: modules.prepareV3LiveGeneration,
		storeDecorator: (backend) => {
			aheBackend = backend;
			aheStore = decoratedAheStore(backend, controls);
			return aheStore;
		},
	});
	if (aheBackend === undefined || aheStore === undefined)
		throw new TypeError("D.108b fixture AHE store capture failed");
	const openedCurrentTrust = await createCurrentAnchorTrustStore({
		objectId: fixture.objectId as Parameters<typeof createCurrentAnchorTrustStore>[0]["objectId"],
		pinnedGenesisAnchorDigest: fixture.anchorDigest,
		store: aheBackend,
	}).open();
	if (!openedCurrentTrust.ok)
		throw new TypeError(`D.108b fixture current trust open failed: ${openedCurrentTrust.reason}`);
	const recovered = await recoverWithDurableStores(
		fixture,
		fixture.capability,
		controls,
		modules,
		options.decorateIssuanceStore,
		options.decorateLiveJournalStore,
		options.operationAdmissionPolicy
	);
	const messageQueueManager = new MessageQueueManager<Message>({ logConfig: { level: "silent" } });
	const networkNode = fakeNetwork(`d108b-${crypto.randomUUID()}`);
	let establishedPeerAuthor: string | undefined;
	let resolveEstablishedPeer: (() => void) | undefined;
	const admittedVertexDigests = new Set<string>();
	const admittedVertexWaiters = new Map<string, () => void>();
	const establishedPeerAdmission = new Promise<void>((resolveAdmission) => {
		resolveEstablishedPeer = resolveAdmission;
	});
	const onAdmittedVertex = (delivery: Parameters<V3AdmittedVertexSink>[0]): void => {
		if (delivery.vertex.author === establishedPeerAuthor) resolveEstablishedPeer?.();
		const digest = Buffer.from(delivery.vertex.digest).toString("hex");
		admittedVertexDigests.add(digest);
		admittedVertexWaiters.get(digest)?.();
	};
	const activation = activateV3LivePlane({
		capability: recovered.capability,
		messageQueueManager,
		networkNode,
		onAdmittedVertex,
	});
	if (!activation.ok) throw new TypeError(`D.108b fixture activation failed: ${activation.kind}`);
	const routeRegisteredVertex = async (
		vertex: ReturnType<GenuinePreparedV3Fixture["createRegisteredVertex"]>,
		transportSender = "d110c-fixture-peer"
	): Promise<void> => {
		const digest = Buffer.from(vertex.digest).toString("hex");
		if (admittedVertexDigests.has(digest)) return;
		let admissionTimer: ReturnType<typeof setTimeout> | undefined;
		let resolveAdmission: (() => void) | undefined;
		const admission = new Promise<void>((resolvePromise) => {
			resolveAdmission = resolvePromise;
		});
		admittedVertexWaiters.set(digest, () => resolveAdmission?.());
		const gossipTopicFor = networkNode.gossipTopicFor;
		try {
			Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
			const claimed = routeV3Ingress(
				networkNode,
				Message.create({
					data: V3Envelope.encode({
						canonicalPreimage: vertex.canonicalPreimageBytes,
						signature: vertex.signature,
					}).finish(),
					objectId: activation.handle.topic,
					sender: transportSender,
					type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
				})
			);
			if (!claimed) throw new TypeError("D110C_FIXTURE_REGISTERED_VERTEX_NOT_CLAIMED");
			await Promise.race([
				admission,
				new Promise<never>((_resolve, reject) => {
					admissionTimer = setTimeout(
						() => reject(new TypeError(`D110C_FIXTURE_REGISTERED_VERTEX_ADMISSION_TIMEOUT:${digest}`)),
						5_000
					);
				}),
			]);
		} finally {
			Reflect.set(networkNode, "gossipTopicFor", gossipTopicFor);
			admittedVertexWaiters.delete(digest);
			if (admissionTimer !== undefined) clearTimeout(admissionTimer);
		}
	};
	const routeRegisteredVertexUnchecked = (
		vertex: ReturnType<GenuinePreparedV3Fixture["createRegisteredVertex"]>,
		transportSender = "d110c-fixture-peer"
	): boolean => {
		const gossipTopicFor = networkNode.gossipTopicFor;
		try {
			Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
			return routeV3Ingress(
				networkNode,
				Message.create({
					data: V3Envelope.encode({
						canonicalPreimage: vertex.canonicalPreimageBytes,
						signature: vertex.signature,
					}).finish(),
					objectId: activation.handle.topic,
					sender: transportSender,
					type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
				})
			);
		} finally {
			Reflect.set(networkNode, "gossipTopicFor", gossipTopicFor);
		}
	};
	const blueprint = bindV3BlueprintLivePlane({
		exactCanonicalInitialStateBytes: encodeCanonical(0),
		plane: activation.handle,
	});
	if (!blueprint.ok) throw new TypeError(`D.108b fixture blueprint binding failed: ${blueprint.kind}`);
	const localIssued = await activation.handle.issueLocal({
		operations: Object.freeze([
			Object.freeze({ logicalTime: 2, operation: Object.freeze({ action: "add", value: 2 }) }),
		]),
		signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
	});
	if (!localIssued.ok) throw new TypeError(`D.108b fixture local issue failed: ${localIssued.kind}`);
	let latestLocalIssued = localIssued;
	if (options.stageAclChange === true) {
		const stagedAcl = await activation.handle.issueLocal({
			operations: Object.freeze([
				Object.freeze({
					logicalTime: 3,
					operation: Object.freeze({
						action: "acl",
						group: "writer",
						kind: "grant",
						target: fixture.author === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64),
					}),
				}),
			]),
			signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
		});
		if (!stagedAcl.ok) throw new TypeError(`D.108b fixture ACL issue failed: ${stagedAcl.kind}`);
	}
	let latestDependency = localIssued.digest;
	if (options.successorAclGroups !== undefined) {
		if (fixture.authors.length !== 8) throw new TypeError("D.108d1b chat ACL requires eight authors");
		if (
			Object.keys(options.successorAclGroups).length !== fixture.authors.length ||
			fixture.authors.some((author) => options.successorAclGroups?.[author] === undefined)
		) {
			throw new TypeError("D.108d1b chat ACL author roster is incomplete");
		}
		const operations = fixture.authors.flatMap((target) =>
			(["admin", "finality", "writer"] as const).flatMap((group) =>
				options.successorAclGroups?.[target]?.includes(group) ? [] : [[target, group] as const]
			)
		);
		for (let index = 0; index < operations.length; index += 1) {
			const [target, group] = operations[index] as (typeof operations)[number];
			const stagedAcl = await activation.handle.issueLocal({
				operations: Object.freeze([
					Object.freeze({
						logicalTime: index + 3,
						operation: Object.freeze({ action: "acl", group, kind: "revoke", target }),
					}),
				]),
				signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
			});
			if (!stagedAcl.ok) {
				throw new TypeError(`D.108d1b chat ACL issue failed: ${stagedAcl.kind}: ${stagedAcl.detail}`);
			}
			latestDependency = stagedAcl.digest;
		}
	}
	let establishedPeer: GenuineCreatorAdoptionFixture["evidence"]["establishedPeer"];
	if (options.establishedPeerPrivateKeySeedHex !== undefined) {
		const carrier = fixture.createRegisteredVertex({
			authorSequence: 0,
			dependencies: [latestDependency],
			logicalTime: 32,
			operation: Object.freeze({ action: "add", value: 3 }),
			privateKeySeedHex: options.establishedPeerPrivateKeySeedHex,
		});
		establishedPeerAuthor = carrier.author;
		await Promise.all([routeRegisteredVertex(carrier, "d108d1b-established-peer"), establishedPeerAdmission]);
		establishedPeer = Object.freeze({
			author: carrier.author,
			authorSequence: 0,
			canonicalPreimageBytes: Uint8Array.from(carrier.canonicalPreimageBytes),
			digest: Uint8Array.from(carrier.digest),
			signature: Uint8Array.from(carrier.signature),
		});
	}
	if (options.beforeCreatorClose !== undefined) {
		if (
			options.stageAclChange === true ||
			options.successorAclGroups !== undefined ||
			options.establishedPeerPrivateKeySeedHex !== undefined
		) {
			throw new TypeError("D.110a pre-close fixture option is incompatible with other staged operations");
		}
		const preCloseIssued = await options.beforeCreatorClose({
			createRegisteredVertex: fixture.createRegisteredVertex,
			firstLogicalTime: 3,
			initialDependency: localIssued.digest,
			plane: activation.handle,
			routeRegisteredVertex,
			routeRegisteredVertexUnchecked,
			signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
			wasRegisteredVertexAdmitted: (vertex) => admittedVertexDigests.has(Buffer.from(vertex.digest).toString("hex")),
		});
		if (
			!Number.isSafeInteger(preCloseIssued.authorSequence) ||
			preCloseIssued.authorSequence <= localIssued.authorSequence ||
			!/^[0-9a-f]{64}$/u.test(preCloseIssued.digest)
		) {
			throw new TypeError("D.110a pre-close fixture result is invalid");
		}
		latestLocalIssued = Object.freeze({
			authorSequence: preCloseIssued.authorSequence,
			digest: preCloseIssued.digest,
			kind: "accepted" as const,
			ok: true as const,
		});
	}
	const signer = await createRecoverableFinalitySigner({ seed: hexBytes(contract.privateKeySeedHex) });
	const [vote, evidence, rawSnapshotStore] = await Promise.all([
		openBrowserSealVoteStore({ databaseName: primaryDatabaseName }),
		openBrowserSealEvidenceStore({ databaseName: primaryDatabaseName }),
		createBrowserSnapshotQuarantineStore({ primaryDatabaseName: snapshotDatabaseName }),
	]);
	if (vote.observation.incarnation !== evidence.observation.incarnation) {
		throw new TypeError("D.108b fixture seal incarnation mismatch");
	}
	const snapshotStore = decoratedSnapshotStore(rawSnapshotStore, controls, (value) => {
		declaration = value;
	});
	const bound = await bindCreatorLiveClose({
		evidenceStore: evidence.store,
		exactCanonicalAvailabilityPolicyBytes: encodeCanonical({
			minLocalCopies: 1,
			minMirrorReceipts: 0,
			minRollbackGenerations: 2,
			mode: "local-only",
		}),
		onObservation: () => undefined,
		plane: activation.handle,
		signer: signer.signer as unknown as Parameters<typeof bindCreatorLiveClose>[0]["signer"],
		snapshotStore,
		storageIncarnation: vote.observation.incarnation,
		voteStore: vote.store,
	});
	if (!bound.ok) throw new TypeError(`D.108b fixture close binding failed: ${bound.reason}`);
	const current = await detachedHeadEvidence(aheBackend, await bound.handle.inspectDurableHead());
	const closeResult = await bound.handle.close();
	controls.adoptionPhase = true;
	const proposed = await detachedHeadEvidence(aheBackend, await bound.handle.inspectDurableHead());
	const parsedObjectId = parseStorageObjectId(fixture.objectId);
	if (!parsedObjectId.ok) throw new TypeError("D.108b fixture object identity is invalid");
	const generationPage = await aheBackend.readGenerationPage({ objectId: parsedObjectId.value, limit: 128 });
	if (!generationPage.ok || generationPage.value.nextCursor !== null) {
		throw new TypeError("D.108b fixture generation page is unavailable");
	}
	const journalScope = Object.freeze({ anchorDigest: fixture.anchorDigest, epoch: 0, objectId: parsedObjectId.value });
	const journalReadiness = await recovered.journal.readiness({ scope: journalScope });
	if (!journalReadiness.ok || !journalReadiness.ready) {
		throw new TypeError("D.108b fixture journal snapshot is unavailable");
	}
	const journalRows: LiveJournalAcceptedRow[] = [];
	let afterSequence: number | null = null;
	while (true) {
		const journalPage: Awaited<ReturnType<DurableLiveJournalStore["readPage"]>> = await recovered.journal.readPage({
			afterSequence,
			limit: 128,
			scope: journalScope,
			snapshot: journalReadiness.snapshot,
		});
		if (!journalPage.ok) throw new TypeError("D.108b fixture journal page is unavailable");
		journalRows.push(...journalPage.rows);
		if (journalPage.nextSequence === null) break;
		afterSequence = journalPage.nextSequence;
	}
	const history = await genuineHistoryEvidence(
		fixture.exactCanonicalAnchorPreimageBytes,
		journalRows,
		recovered.issuanceStore
	);
	if (declaration === undefined) throw new TypeError("D.108b fixture snapshot declaration capture failed");
	const exactCanonicalProjectionBytes = expectedSuccessorProjection(
		fixture.catalog,
		closeResult,
		current,
		proposed,
		history,
		declaration
	);
	const reopenedSnapshot = await rawSnapshotStore.openScope(declaration);
	const portController = new AbortController();
	const port = reopenedSnapshot.verificationQuarantine.open(portController.signal);
	const chunks = await Promise.all(
		declaration.chunks.map(async (descriptor: SnapshotQuarantineDeclaration["chunks"][number]) => {
			const bytes = await port.read(descriptor);
			if (bytes === undefined) throw new TypeError("D.108b fixture snapshot chunk is unavailable");
			return Uint8Array.from(bytes);
		})
	);
	await port.discard();
	await reopenedSnapshot.release();
	return Object.freeze({
		catalog: fixture.catalog,
		close: async () => {
			await bound.handle.stop();
			activation.handle.deactivate();
			await Promise.all([vote.close(), evidence.close(), snapshotStore.close(), recovered.close(), fixture.close()]);
			await Promise.all([deleteDatabase(primaryDatabaseName), deleteDatabase(snapshotDatabaseName)]);
		},
		controls,
		createRegisteredVertex: fixture.createRegisteredVertex,
		evidence: Object.freeze({
			aheBackend,
			aheStore,
			chunks: Object.freeze(chunks),
			closeResult,
			current,
			currentTrust: openedCurrentTrust.trust,
			declaration,
			...(establishedPeer === undefined ? {} : { establishedPeer }),
			exactCanonicalPayloadBytes: concatenate(chunks),
			exactCanonicalProjectionBytes,
			generations: Object.freeze([...generationPage.value.generations]),
			history,
			issuanceScope: Object.freeze({ author: fixture.author, objectId: fixture.objectId }),
			issuanceMaintenance: recovered.issuanceMaintenance,
			issuanceStore: recovered.issuanceStore,
			journalRows: Object.freeze(journalRows),
			journalSnapshot: journalReadiness.snapshot,
			localIssued: Object.freeze({
				authorSequence: latestLocalIssued.authorSequence,
				digest: latestLocalIssued.digest,
			}),
			predecessorExactCanonicalLatchedAclBytes: Uint8Array.from(fixture.exactCanonicalLatchedAclBytes as Uint8Array),
			proposed,
			snapshotStore,
		}),
		handle: bound.handle,
		journal: recovered.journal,
		modules,
		runtimeBindings: Object.freeze({ messageQueueManager, networkNode, onAdmittedVertex }),
		scope: journalScope,
		routeRegisteredVertex,
		signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
	});
}

/**
 * Returns whether the node manifest exposes exactly the intended non-root subpath.
 * @param packageText - Exact node package manifest text.
 * @returns Whether the manifest has the frozen D.108b export map.
 */
function exactExportMap(packageText: string): boolean {
	try {
		const parsed = JSON.parse(packageText) as Readonly<Record<string, unknown>>;
		const exports = parsed.exports as Readonly<Record<string, unknown>> | undefined;
		const entry = exports?.["./creator-adoption"] as Readonly<Record<string, unknown>> | undefined;
		return entry?.types === "./dist/src/creator-adoption.d.ts" && entry.import === "./dist/src/creator-adoption.js";
	} catch {
		return false;
	}
}

/**
 * One composite readiness owner; all other RED controls remain executable.
 * @param candidate - Dynamically imported future production owner, when present.
 * @returns Frozen exact readiness facts.
 */
export function creatorAdoptionReadiness(candidate: CandidateCreatorAdoptionModule | undefined): Readonly<{
	greenPaths: boolean;
	intentCustody: boolean;
	packageExport: boolean;
	publicVerifier: boolean;
	ready: boolean;
}> {
	const greenPaths = D108B_GREEN_PATHS.every((path) => existsSync(resolve(REPOSITORY_ROOT, path)));
	const packageExport = exactExportMap(readFileSync(resolve(REPOSITORY_ROOT, "packages/node/package.json"), "utf8"));
	const intentPath = resolve(REPOSITORY_ROOT, "packages/node/src/internal/creator-adoption-intent.ts");
	const intentCustody =
		existsSync(intentPath) &&
		/WeakMap/u.test(readFileSync(intentPath, "utf8")) &&
		/consumeCreatorAdoptionIntent/u.test(readFileSync(intentPath, "utf8"));
	const publicVerifier = typeof candidate?.verifyCreatorSuccessorAdoption === "function";
	return Object.freeze({
		greenPaths,
		intentCustody,
		packageExport,
		publicVerifier,
		ready: greenPaths && packageExport && intentCustody && publicVerifier,
	});
}

/**
 * Returns the source-level no-mutation/no-root/no-product governance facts.
 * @returns Frozen source-governance facts.
 */
export function sourceGovernance(): Readonly<{
	forbiddenRootExport: boolean;
	noAheMutationInVerifier: boolean;
	noDirectChatVerifierConsumer: boolean;
	roomOwnsVerifierWhenProductExists: boolean;
}> {
	const verifierPath = resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption.ts");
	const verifier = existsSync(verifierPath) ? readFileSync(verifierPath, "utf8") : "";
	const root = readFileSync(resolve(REPOSITORY_ROOT, "packages/node/src/index.ts"), "utf8");
	const chat = readFileSync(resolve(REPOSITORY_ROOT, "examples/v3-chat/src/index.ts"), "utf8");
	const room = readFileSync(resolve(REPOSITORY_ROOT, "examples/v3-room/src/index.ts"), "utf8");
	const productExists = /adoptCreatorSuccessor\s*\(/u.test(room);
	const roomConsumesVerifier =
		/@ts-drp\/node\/creator-adoption/u.test(room) && /verifyCreatorSuccessorAdoption/u.test(room);
	const verifierStart = verifier.indexOf("export async function verifyCreatorSuccessorAdoption");
	const verifierEnd = verifier.indexOf("\nfunction coldFailure", verifierStart);
	const verifierOwner =
		verifierStart >= 0 && verifierEnd > verifierStart ? verifier.slice(verifierStart, verifierEnd) : verifier;
	return Object.freeze({
		forbiddenRootExport: /creator-adoption|verifyCreatorSuccessorAdoption/u.test(root),
		noAheMutationInVerifier:
			!/\.(?:beginGeneration|putCachedBlob|promoteReference|completeGeneration|swapHead|discardGeneration)\s*\(/u.test(
				verifierOwner
			),
		noDirectChatVerifierConsumer: !/verifyCreatorSuccessorAdoption|CreatorAdoptionIntent|creator-adoption/u.test(chat),
		roomOwnsVerifierWhenProductExists: !productExists || roomConsumesVerifier,
	});
}
