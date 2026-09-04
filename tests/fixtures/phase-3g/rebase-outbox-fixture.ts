import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import type { DurableIssuanceOutboxRecord, DurableIssuanceStore, DurableIssueCommit } from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { type AheDurableStore, parseStorageObjectId, type StorageObjectId } from "@ts-drp/storage";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createV3ChatApplication } from "../../../examples/v3-chat/src/index.js";
import {
	activateV3LivePlane,
	type PreparedV3Live,
	prepareV3LiveGeneration,
	recoverV3LiveReplica,
	routeV3Ingress,
	routeV3RetainedIngress,
	type V3LocalIssueResult,
} from "../../../packages/node/src/v3-live.js";
import { createSqliteAheDurableStore } from "../../../packages/storage-node/src/index.js";
import { createNodeDurableIssuanceStore } from "../../../packages/storage-node/src/issuance.js";
import { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/src/live-journal.js";
import {
	bytesHex,
	contract,
	hexBytes,
	independentHashDomain,
	makeCreatorMaterial,
} from "../phase-3a0-v3/controlled-anchor-trust.js";
import { counterBatchCatalog, maximalEntries } from "../phase-3f-c/application-batching-fixture.js";
import { ObservedMessageQueueManager } from "../shared/observed-message-queue.js";

const PARAMETERS = Object.freeze({
	maxEpochVertices: 8192,
	maxEpochBytes: 8_388_608,
	maxDependencies: 16,
	snapshotChunkBytes: 131_072,
	maxSnapshotBytes: 268_435_456,
	maxPendingEntries: 4096,
	maxPendingBytes: 16_777_216,
});

export type SourceOperationProfile =
	| "acl"
	| "batch-2"
	| "batch-16"
	| "join"
	| "malformed-batch"
	| "mixed-control-batch"
	| "nested-batch"
	| "over-limit-batch"
	| "structural"
	| "singleton";

interface PreparedPlane {
	readonly anchorDigest: string;
	readonly author: string;
	readonly authorizationBytes: Uint8Array;
	readonly capability: PreparedV3Live;
	readonly detachedAnchorSignature: Uint8Array;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalLatchedAclBytes?: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly journalFilename: string;
	readonly objectId: string;
	readonly parametersDigest: string;
	readonly privateKeySeedHex: string;
	prepareAgain(detachedSignature?: Uint8Array): Promise<PreparedV3Live | undefined>;
	close(): Promise<void>;
}

export interface SharedPlaneScenarioOptions {
	readonly nonCreatorWriter?: boolean;
	readonly omitTargetBootstrap?: boolean;
	readonly omitSourceAuthority?: boolean;
	readonly reopenTarget?: boolean;
	readonly settlementProfile?: boolean;
	readonly publishSourceBeforeClose?: boolean;
	readonly sourceAuthorityMutation?:
		| "acl-context"
		| "authorization-bytes"
		| "blueprint-context"
		| "creator-context"
		| "object-context"
		| "target-capability";
	readonly sourceCreatorSignatureCorrupt?: boolean;
	readonly sourceOperationProfile?: SourceOperationProfile;
	readonly syntheticCurrentQuarantinedRowCount?: number;
	readonly syntheticDisplacedRowCount?: number;
	readonly targetAuthorityMutation?: "authorization-bytes" | "source-capability";
	readonly targetDirectQuarantinedRow?: boolean;
	readonly targetQuarantinedMatchingReplacement?: boolean;
	readonly targetReceivedWithoutBootstrap?: boolean;
	readonly targetReplacementAfterRecoveryBeforeRead?: boolean;
	readonly twoSourceRows?: boolean;
}

function terminalBatchCatalog(): ReturnType<typeof counterBatchCatalog> {
	const application = createV3ChatApplication("alice");
	const blueprintDigest = lowerHex(
		hashDomain("ts-drp/blueprint-admission/v3", application.canonicalBlueprintPackageBytes)
	);
	return Object.freeze({
		blueprintDigest,
		catalog: application.catalog,
	});
}

export interface SharedPlaneScenarioResult {
	readonly networkPublishedDigests: readonly string[];
	readonly completion?: unknown;
	readonly lineageNext: number;
	readonly outbox: readonly Readonly<{
		readonly authorSequence: number;
		readonly digest: string;
		readonly publishState: "pending" | "published";
	}>[];
	readonly publication?: unknown;
	readonly publicationAfterQuarantine?: unknown;
	readonly rebaseOutbox?: unknown;
	readonly rebaseOutboxes: readonly unknown[];
	readonly recovery: Readonly<Record<string, unknown>>;
	readonly reopenRecovery?: Readonly<Record<string, unknown>>;
	readonly sourceAnchor: string;
	readonly sourceBootstrapDigest: string;
	readonly sourceAuthorityPrepared: boolean;
	readonly sourceContextAuthor: string;
	readonly sourceDigest: string;
	readonly sourceDigests: readonly string[];
	readonly sourceIssue: V3LocalIssueResult | Readonly<{ readonly ok: true; readonly kind: "hostile-stored" }>;
	readonly sourceRowAuthor: string;
	readonly sourceSessionClosedBeforeTargetOpen: boolean;
	readonly targetAnchor: string;
	readonly targetAuthor: string;
	readonly targetDigest?: string;
	readonly targetReplacementDigest?: string;
	readonly targetReplacementLogicalTime?: number;
}

export type CrossObjectMutation = "activation-closure" | "source-scope" | "source-store" | "target-scope";

export interface CrossObjectScenarioResult {
	readonly activationVertexDigest: string;
	readonly completion?: unknown;
	readonly recovery: Readonly<Record<string, unknown>>;
	readonly rebaseOutboxes: readonly unknown[];
	readonly reopenRecovery?: Readonly<Record<string, unknown>>;
	readonly sourceDigests: readonly string[];
	readonly sourceJournalRowCount: number;
	readonly sourceObjectId: string;
	readonly targetObjectId: string;
	readonly targetPublishedDigests: readonly string[];
	readonly targetPublication?: unknown;
	readonly targetReplacement?: unknown;
}

export type RetainedBootstrapMutation = "missing-activation" | "unauthenticated-activation";

export interface RetainedBootstrapScenarioResult {
	readonly admittedActions: readonly string[];
	readonly postPrefixIssue?: unknown;
	readonly prePrefixIssue?: unknown;
	readonly prePrefixPublication?: unknown;
	readonly prePrefixRebase?: unknown;
	readonly recovery: Readonly<Record<string, unknown>>;
	readonly routedPrefix: readonly boolean[];
}

export interface TerminalCommitScenarioResult {
	readonly admittedActions: readonly string[];
	readonly admittedClientOperationIds: readonly string[];
	readonly begun: unknown;
	readonly begunAgain: unknown;
	readonly begunWhileActive: unknown;
	readonly beginSettledBeforeEarlierSinkRelease: boolean;
	readonly earlierIssue: unknown;
	readonly forgedReceiverIssuanceDelta: number;
	readonly forgedReceiverPublish: unknown;
	readonly forgedReceiverResume: unknown;
	readonly forgedReceiverSignerCalls: number;
	readonly heldBeforeResume: boolean;
	readonly heldRemoteRouted: boolean;
	readonly heldRemoteProcessedBeforeResume: boolean;
	readonly issuanceTransactionsAfterResume: number;
	readonly issuanceTransactionsAfterTerminal: number;
	readonly issuanceTransactionsBeforeResume: number;
	readonly issuedTerminalAction?: string;
	readonly journalRowCount: number;
	readonly laterIssue: unknown;
	readonly laterIssueSignerCalls: number;
	readonly terminalHeldIssue: unknown;
	readonly terminalHeldSignerCalls: number;
	readonly malformedTerminal: unknown;
	readonly ordinaryTerminal: unknown;
	readonly outboxPublishStates: readonly string[];
	readonly publication: unknown;
	readonly postTerminalRemoteProcessed: boolean;
	readonly postTerminalRemoteRouted: boolean;
	readonly publishedDigests: readonly string[];
	readonly publishTerminal: unknown;
	readonly rejectedSignerTerminal: unknown;
	readonly reopenedBegin: unknown;
	readonly resume: unknown;
	readonly reusedPublish: unknown;
	readonly reusedResume: unknown;
}

export interface TerminalPreEffectScenarioResult {
	readonly begun?: unknown;
	readonly issuanceTransactions: number;
	readonly publication?: unknown;
	readonly remainingEpochBytes?: number;
	readonly recovery: Readonly<Record<string, unknown>>;
	readonly signerCalls: number;
	readonly terminalCandidateByteCharge?: number;
}

export interface TerminalSinkDispositionScenarioResult {
	readonly disposition: "missing" | "rejected" | "throw";
	readonly journalRowCount: number;
	readonly laterIssue: unknown;
	readonly publication: unknown;
	readonly reopenedBegin: unknown;
}

export interface TerminalOutcomeUnknownScenarioResult {
	readonly beginAfterUnknown: unknown;
	readonly publishTerminal: unknown;
	readonly resumeAfterUnknown: unknown;
}

function lowerHex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function commitLogicalTime(commit: DurableIssueCommit): number {
	const decoded = decodeCanonical(commit.envelope.canonicalPreimageBytes);
	if (typeof decoded !== "object" || decoded === null) throw new TypeError("Phase 3g commit preimage is invalid");
	const logicalTime = Reflect.get(decoded, "logicalTime");
	if (!Number.isSafeInteger(logicalTime)) throw new TypeError("Phase 3g commit logical time is invalid");
	return logicalTime as number;
}

function mustObjectId(value: string): StorageObjectId {
	const parsed = parseStorageObjectId(value);
	if (!parsed.ok) throw new TypeError("Phase 3g fixture object id is invalid");
	return parsed.value;
}

function recoveryAuthorization(
	plane: PreparedPlane,
	bytes: Uint8Array = plane.authorizationBytes
):
	| Readonly<{ readonly exactCanonicalAuthorAuthorizationBytes: Uint8Array }>
	| Readonly<{ readonly exactCanonicalLatchedAclBytes: Uint8Array }> {
	return plane.exactCanonicalLatchedAclBytes === undefined
		? Object.freeze({ exactCanonicalAuthorAuthorizationBytes: bytes })
		: Object.freeze({ exactCanonicalLatchedAclBytes: bytes });
}

async function preparePlane(
	objectIdValue: string,
	stateDigest: string,
	label: string,
	options: Readonly<{
		readonly anchorPrivateKeySeedHex?: string;
		readonly authorizationAuthors?: readonly string[];
		readonly blueprintVariant?: string;
		readonly privateKeySeedHex?: string;
		readonly settlementProfile?: boolean;
		readonly useLatchedAcl?: boolean;
		readonly terminalCatalog?: boolean;
	}> = {}
): Promise<PreparedPlane> {
	const directory = mkdtempSync(path.join(tmpdir(), `drp-phase-3g-${label}-`));
	const store: AheDurableStore = createSqliteAheDurableStore({ filename: path.join(directory, "trust.sqlite") });
	try {
		const selectedCatalog =
			options.terminalCatalog === true ? terminalBatchCatalog() : counterBatchCatalog(options.blueprintVariant);
		const privateKeySeedHex = options.privateKeySeedHex ?? contract.privateKeySeedHex;
		const anchorPrivateKeySeedHex = options.anchorPrivateKeySeedHex ?? privateKeySeedHex;
		const base = makeCreatorMaterial({
			objectId: objectIdValue,
			privateKeySeedHex: anchorPrivateKeySeedHex,
			...(options.settlementProfile === true ? { profileId: "creator-trusted-settlement-v1" as const } : {}),
		});
		const author = bytesHex(ed25519.getPublicKey(hexBytes(privateKeySeedHex)));
		const exactCanonicalLatchedAclBytes =
			options.useLatchedAcl === true || options.settlementProfile === true
				? encodeCanonical({
						epoch: 0,
						kind: "drp-v3-latched-acl",
						members: (options.authorizationAuthors ?? [author]).map((selectedAuthor) =>
							Object.freeze({
								author: selectedAuthor,
								finalityKey: selectedAuthor === author ? selectedAuthor : null,
								groups: selectedAuthor === author ? ["admin", "finality", "writer"] : ["writer"],
							})
						),
						objectId: objectIdValue,
						permissionless: false,
						version: options.settlementProfile === true ? 3 : 1,
					})
				: undefined;
		const authorizationBytes =
			exactCanonicalLatchedAclBytes ??
			encodeCanonical({
				authors: options.authorizationAuthors ?? [author],
				epoch: 0,
				kind: "drp-author-authorization",
				objectId: objectIdValue,
				profileId: "creator-author-authorization-v1",
				protocolMajor: 3,
				version: 1,
			});
		const parameterBytes = encodeCanonical(PARAMETERS);
		const anchor = Object.freeze({
			...base.anchor,
			aclDigest: lowerHex(
				hashDomain(
					exactCanonicalLatchedAclBytes === undefined ? "ts-drp/author-authorization/v3" : "ts-drp/latched-acl/v3",
					authorizationBytes
				)
			),
			blueprintDigest: selectedCatalog.blueprintDigest,
			objectId: objectIdValue,
			parametersDigest: lowerHex(hashDomain("ts-drp/parameters/v3", parameterBytes)),
			stateDigest,
		});
		const anchorBytes = encodeCanonical(anchor);
		const anchorDigest = bytesHex(independentHashDomain(contract.anchorDigestDomain, anchorBytes));
		const detachedAnchorSignature = ed25519.sign(hexBytes(anchorDigest), hexBytes(anchorPrivateKeySeedHex));
		const objectId = mustObjectId(objectIdValue);
		const trust = createCurrentAnchorTrustStore({ objectId, pinnedGenesisAnchorDigest: anchorDigest, store });
		const installed = await trust.install({
			detachedGenesisSignature: detachedAnchorSignature,
			exactCanonicalGenesisAnchorPreimageBytes: anchorBytes,
			exactCanonicalProfileBytes: base.profileBytes,
			exactCanonicalSignerSetBytes: base.signerSetBytes,
			pinnedGenesisAnchorDigest: anchorDigest,
		});
		if (!installed.ok) throw new TypeError(`Phase 3g trust install failed: ${String(installed.reason)}`);
		const prepare = async (signature: Uint8Array): Promise<PreparedV3Live | undefined> => {
			const result = await prepareV3LiveGeneration({
				authenticationProfile: "creator-only",
				catalog: selectedCatalog.catalog,
				detachedSignature: new Uint8Array(signature),
				exactCanonicalAnchorPreimageBytes: new Uint8Array(anchorBytes),
				exactCanonicalParametersCarrierBytes: new Uint8Array(parameterBytes),
				objectId,
				pinnedGenesisAnchorDigest: anchorDigest,
				store,
			});
			return result.ok ? result.capability : undefined;
		};
		const capability = await prepare(detachedAnchorSignature);
		if (capability === undefined) throw new TypeError("Phase 3g preparation failed");
		return Object.freeze({
			anchorDigest,
			author,
			authorizationBytes: new Uint8Array(authorizationBytes),
			capability,
			detachedAnchorSignature: new Uint8Array(detachedAnchorSignature),
			exactCanonicalAnchorPreimageBytes: new Uint8Array(anchorBytes),
			...(exactCanonicalLatchedAclBytes === undefined
				? {}
				: { exactCanonicalLatchedAclBytes: new Uint8Array(exactCanonicalLatchedAclBytes) }),
			exactCanonicalParametersCarrierBytes: new Uint8Array(parameterBytes),
			journalFilename: path.join(directory, "journal"),
			objectId: objectIdValue,
			parametersDigest: anchor.parametersDigest,
			privateKeySeedHex,
			prepareAgain: (signature = detachedAnchorSignature) => prepare(signature),
			async close() {
				await store.close();
				rmSync(directory, { force: true, recursive: true });
			},
		});
	} catch (error) {
		await store.close();
		rmSync(directory, { force: true, recursive: true });
		throw error;
	}
}

function commitFor(
	plane: PreparedPlane,
	authorSequence: number,
	operation: Readonly<Record<string, unknown>>,
	logicalTime = authorSequence * 2 + 1,
	dependencies: readonly string[] = [plane.anchorDigest]
): DurableIssueCommit {
	return commitForSigner(
		plane,
		plane.author,
		plane.privateKeySeedHex,
		authorSequence,
		operation,
		logicalTime,
		dependencies
	);
}

function commitForSigner(
	plane: PreparedPlane,
	author: string,
	privateKeySeedHex: string,
	authorSequence: number,
	operation: Readonly<Record<string, unknown>>,
	logicalTime = authorSequence * 2 + 1,
	dependencies: readonly string[] = [plane.anchorDigest]
): DurableIssueCommit {
	const scope = Object.freeze({ author, objectId: plane.objectId });
	const canonicalPreimageBytes = encodeCanonical({
		anchor: plane.anchorDigest,
		author,
		authorSequence,
		dependencies,
		epoch: 0,
		kind: "drp-vertex",
		logicalTime,
		objectId: plane.objectId,
		operation,
		protocolMajor: 3,
	});
	const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
	const envelope = Object.freeze({
		canonicalPreimageBytes,
		digest,
		signature: ed25519.sign(digest, hexBytes(privateKeySeedHex)),
	});
	return Object.freeze({
		authorSequence,
		envelope,
		issuedRecord: Object.freeze({ authorSequence, envelope, scope }),
		outboxEntry: Object.freeze({ authorSequence, envelope, scope }),
	});
}

function sourceOperations(profile: SourceOperationProfile): readonly Readonly<{
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
}>[] {
	if (profile === "singleton") {
		return Object.freeze([
			Object.freeze({
				logicalTime: 3,
				operation: Object.freeze({ action: "add", value: 1 }),
			}),
		]);
	}
	if (profile === "acl") {
		return Object.freeze([
			Object.freeze({
				logicalTime: 3,
				operation: Object.freeze({
					action: "acl",
					group: "writer",
					kind: "grant",
					target: "2".repeat(64),
				}),
			}),
		]);
	}
	if (profile === "join") {
		return Object.freeze([Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "join" }) })]);
	}
	if (profile === "structural") {
		return Object.freeze([
			Object.freeze({
				logicalTime: 3,
				operation: Object.freeze({ action: "causalJoin" }),
			}),
		]);
	}
	if (profile === "batch-2" || profile === "batch-16") return maximalEntries("counter", profile === "batch-2" ? 2 : 16);
	const entries = [...maximalEntries("counter", profile === "over-limit-batch" ? 17 : 2)];
	if (profile === "malformed-batch") {
		entries[1] = Object.freeze({ ...entries[1], logicalTime: entries[0]?.logicalTime ?? 1 });
	}
	if (profile === "mixed-control-batch") {
		entries[1] = Object.freeze({ logicalTime: 2, operation: Object.freeze({ action: "causalJoin" }) });
	}
	if (profile === "nested-batch") {
		entries[1] = Object.freeze({
			logicalTime: 2,
			operation: Object.freeze({
				action: "applicationBatch",
				batch: Object.freeze({ entries: maximalEntries("counter", 2), version: 1 }),
			}),
		});
	}
	return Object.freeze(entries);
}

function batchOperation(entries: ReturnType<typeof sourceOperations>): Readonly<Record<string, unknown>> {
	return Object.freeze({ action: "applicationBatch", batch: Object.freeze({ entries, version: 1 }) });
}

function isHostileProfile(profile: SourceOperationProfile): boolean {
	return (
		profile === "malformed-batch" ||
		profile === "acl" ||
		profile === "mixed-control-batch" ||
		profile === "nested-batch" ||
		profile === "over-limit-batch" ||
		profile === "join" ||
		profile === "structural"
	);
}

function terminalClassifier(
	expectedAuthor: string,
	input: Readonly<{ readonly author: string; readonly vertex: Readonly<Record<string, unknown>> }>
): "ordinary" | "terminal-authorized" | "reject" {
	const operation = Reflect.get(input.vertex, "operation");
	if (Reflect.get(operation as object, "action") !== "migrationActivation") return "ordinary";
	return input.author === expectedAuthor ? "terminal-authorized" : "reject";
}

function terminalMessage(label: string): Readonly<Record<string, unknown>> {
	return Object.freeze({ action: "message", clientOperationId: `phase-3h-${label}`, text: label });
}

/**
 * Commits a terminal row and then reports an indeterminate transaction outcome.
 * @returns Terminal publication and state-latch observations.
 */
export async function runTerminalOutcomeUnknownScenario(): Promise<TerminalOutcomeUnknownScenarioResult> {
	const objectId = `creator:${"b".repeat(32)}`;
	const plane = await preparePlane(objectId, "5".repeat(64), "terminal-outcome-unknown", {
		terminalCatalog: true,
		useLatchedAcl: true,
	});
	const directory = mkdtempSync(path.join(tmpdir(), "drp-phase-3h-terminal-outcome-unknown-"));
	let store: DurableIssuanceStore | undefined;
	let journal: DurableLiveJournalStore | undefined;
	try {
		const scope = Object.freeze({ author: plane.author, objectId });
		store = createNodeDurableIssuanceStore({ primaryFilename: path.join(directory, "issuance") });
		journal = await installJournal(plane);
		const bootstrap = await store.transactIssue(scope, (authorSequence) =>
			Promise.resolve(commitFor(plane, authorSequence, terminalMessage("outcome-unknown-bootstrap")))
		);
		await appendLocalIssued(journal, plane, bootstrap);
		await store.compareAndMarkOutboxPublished({
			authorSequence: bootstrap.authorSequence,
			digest: new Uint8Array(bootstrap.envelope.digest),
			scope,
		});
		const durableStore = store;
		let injectUnknown = true;
		const observedStore: DurableIssuanceStore = Object.freeze({
			close: () => Promise.resolve(),
			compareAndMarkOutboxPublished: (input) => durableStore.compareAndMarkOutboxPublished(input),
			readIssued: (selectedScope, authorSequence) => durableStore.readIssued(selectedScope, authorSequence),
			readLineage: (selectedScope) => durableStore.readLineage(selectedScope),
			readOutboxPage: (input) => durableStore.readOutboxPage(input),
			readSettlementPlan: (selectedScope) => durableStore.readSettlementPlan(selectedScope),
			transactIssue: async (selectedScope, buildAndSign) => {
				const commit = await durableStore.transactIssue(selectedScope, buildAndSign);
				if (injectUnknown) {
					injectUnknown = false;
					throw Object.assign(new Error("controlled terminal transaction outcome"), {
						code: "ISSUANCE_OUTCOME_UNKNOWN",
					});
				}
				return commit;
			},
			transactWriteSettlementPlan: (input) => durableStore.transactWriteSettlementPlan(input),
		});
		const capability = await plane.prepareAgain();
		if (capability === undefined || plane.exactCanonicalLatchedAclBytes === undefined) {
			throw new TypeError("Phase 3h outcome-unknown authority is unavailable");
		}
		const recovery = await recoverV3LiveReplica({
			capability,
			classifyTerminalVertex: (input: never): ReturnType<typeof terminalClassifier> =>
				terminalClassifier(plane.author, input),
			exactCanonicalLatchedAclBytes: plane.exactCanonicalLatchedAclBytes,
			issuanceScope: scope,
			issuanceStore: observedStore,
			liveJournalStore: journal,
		} as never);
		if (!recovery.ok) throw new TypeError(`Phase 3h outcome-unknown recovery failed: ${recovery.kind}`);
		const activated = activateV3LivePlane({
			capability: recovery.capability,
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode: network("terminal-outcome-unknown", []),
			onAdmittedVertex: ({ vertex }) =>
				Object.freeze({
					kind:
						Reflect.get(vertex.operation, "action") === "migrationActivation"
							? ("terminal-accepted" as const)
							: ("continue" as const),
				}),
		});
		if (!activated.ok) throw new TypeError(`Phase 3h outcome-unknown activation failed: ${activated.kind}`);
		try {
			const begun = await activated.handle.beginTerminalTransition();
			if (!begun.ok) throw new TypeError(`Phase 3h outcome-unknown begin failed: ${begun.kind}`);
			const publishTerminal = await begun.capability.publishTerminal({
				operations: Object.freeze([
					Object.freeze({
						logicalTime: 3,
						operation: Object.freeze({
							action: "migrationActivation",
							decision: Object.freeze({ version: 1 }),
						}),
					}),
				]),
				signRegisteredVertexDigest: (digest) =>
					Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(plane.privateKeySeedHex))),
			});
			const resumeAfterUnknown = begun.capability.resume();
			const beginAfterUnknown = await activated.handle.beginTerminalTransition();
			return Object.freeze({ beginAfterUnknown, publishTerminal, resumeAfterUnknown });
		} finally {
			activated.handle.deactivate();
		}
	} finally {
		await journal?.close();
		await store?.close();
		await plane.close();
		rmSync(directory, { force: true, recursive: true });
	}
}

function messageForCommit(commit: DurableIssueCommit, topic: string): Message {
	return Message.create({
		data: V3Envelope.encode({
			canonicalPreimage: commit.envelope.canonicalPreimageBytes,
			signature: commit.envelope.signature,
		}).finish(),
		objectId: topic,
		sender: "peer:phase-3h:remote-writer",
		type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
	});
}

async function installJournal(plane: PreparedPlane): Promise<DurableLiveJournalStore> {
	const journal = createNodeDurableLiveJournalStore({ primaryFilename: plane.journalFilename });
	const installed = await journal.installGenesis({
		detachedAnchorSignature: plane.detachedAnchorSignature,
		exactCanonicalAnchorPreimageBytes: plane.exactCanonicalAnchorPreimageBytes,
		exactCanonicalParametersCarrierBytes: plane.exactCanonicalParametersCarrierBytes,
		objectId: plane.objectId,
	});
	if (!installed.ok) {
		await journal.close();
		throw new TypeError(`Phase 3g journal install failed: ${installed.kind}`);
	}
	return journal;
}

function network(
	label: string,
	published: string[],
	gossipTopicFor: (message: Message) => string | undefined = () => undefined
): DRPNetworkNode {
	const topics = new Set<string>();
	return {
		peerId: `peer:phase-3g:${label}`,
		getMultiaddrs: () => ["/ip4/127.0.0.1/tcp/1"],
		gossipTopicFor,
		getSubscribedTopics: () => [...topics],
		publishMessage: (_topic: string, message: Message) => {
			const envelope = V3Envelope.decode(message.data ?? new Uint8Array());
			published.push(lowerHex(hashDomain("ts-drp/vertex/v3", envelope.canonicalPreimage)));
			return Promise.resolve(true);
		},
		subscribe: (topic: string) => topics.add(topic),
		unsubscribe: (topic: string) => topics.delete(topic),
	} as unknown as DRPNetworkNode;
}

async function outboxSnapshot(
	store: DurableIssuanceStore,
	scope: Readonly<{ readonly author: string; readonly objectId: string }>
): Promise<SharedPlaneScenarioResult["outbox"]> {
	const rows: Array<{ authorSequence: number; digest: string; publishState: "pending" | "published" }> = [];
	let afterKey: readonly [string, string, number] | undefined;
	for (;;) {
		const page: readonly DurableIssuanceOutboxRecord[] = await store.readOutboxPage(
			afterKey === undefined ? { limit: 1, scope } : { afterKey, limit: 1, scope }
		);
		const row = page[0];
		if (row === undefined) break;
		rows.push({
			authorSequence: row.commit.authorSequence,
			digest: lowerHex(row.commit.envelope.digest),
			publishState: row.publishState,
		});
		afterKey = [scope.objectId, scope.author, row.commit.authorSequence];
	}
	return Object.freeze(rows.map((row) => Object.freeze(row)));
}

/**
 * Runs one genuine shared-physical-lineage source/target recovery through the shipped node adapter.
 * Valid source intent is issued by an activated source session; hostile prior rows are signed and committed
 * through the real durable transaction before the source capability closes. The target then reopens the same
 * SQLite lineage with a fresh capability.
 * @param options Controlled source-authority and batch mutations.
 * @returns Recovery, publication and durable-state evidence.
 */
export async function runSharedPlaneScenario(
	options: SharedPlaneScenarioOptions = {}
): Promise<SharedPlaneScenarioResult> {
	const objectId = `creator:${"d".repeat(32)}`;
	const nonCreatorAnchorSeed = options.nonCreatorWriter === true ? "56".repeat(32) : undefined;
	const source = await preparePlane(objectId, "7".repeat(64), "source", {
		...(nonCreatorAnchorSeed === undefined ? {} : { anchorPrivateKeySeedHex: nonCreatorAnchorSeed }),
		settlementProfile: options.settlementProfile,
	});
	const target = await preparePlane(objectId, "8".repeat(64), "target", {
		...(nonCreatorAnchorSeed === undefined ? {} : { anchorPrivateKeySeedHex: nonCreatorAnchorSeed }),
		settlementProfile: options.settlementProfile,
	});
	const mismatchedSource =
		options.sourceAuthorityMutation === "object-context"
			? await preparePlane(`creator:${"e".repeat(32)}`, "7".repeat(64), "source-object")
			: options.sourceAuthorityMutation === "creator-context"
				? await preparePlane(objectId, "7".repeat(64), "source-creator", {
						privateKeySeedHex: "12".repeat(32),
					})
				: options.sourceAuthorityMutation === "blueprint-context"
					? await preparePlane(objectId, "7".repeat(64), "source-blueprint", {
							blueprintVariant: "mismatched-source",
						})
					: options.sourceAuthorityMutation === "acl-context"
						? await preparePlane(objectId, "7".repeat(64), "source-acl", {
								authorizationAuthors: [source.author, bytesHex(ed25519.getPublicKey(hexBytes("34".repeat(32))))].sort(),
							})
						: undefined;
	const lineageDirectory = mkdtempSync(path.join(tmpdir(), "drp-phase-3g-lineage-"));
	const lineageFilename = path.join(lineageDirectory, "shared-lineage");
	let sourceStore: DurableIssuanceStore | undefined;
	let sourceJournal: Awaited<ReturnType<typeof installJournal>> | undefined;
	let targetStore: DurableIssuanceStore | undefined;
	let targetJournal: Awaited<ReturnType<typeof installJournal>> | undefined;
	try {
		const scope = Object.freeze({ author: source.author, objectId });
		sourceStore = createNodeDurableIssuanceStore({ primaryFilename: lineageFilename });
		const sourceBootstrap = await sourceStore.transactIssue(scope, (authorSequence) =>
			Promise.resolve(commitFor(source, authorSequence, Object.freeze({ action: "add", value: 0 })))
		);
		sourceJournal = await installJournal(source);
		const sourceRecovery = await recoverV3LiveReplica({
			capability: source.capability,
			...recoveryAuthorization(source),
			issuanceScope: scope,
			issuanceStore: sourceStore,
			liveJournalStore: sourceJournal,
		});
		if (!sourceRecovery.ok) throw new TypeError(`Phase 3g source recovery failed: ${sourceRecovery.kind}`);
		const sourcePublished: string[] = [];
		const sourceActivated = activateV3LivePlane({
			capability: sourceRecovery.capability,
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode: network("source", sourcePublished),
			onAdmittedVertex: () => undefined,
		});
		if (!sourceActivated.ok) throw new TypeError(`Phase 3g source activation failed: ${sourceActivated.kind}`);
		const bootstrapPublication = await sourceActivated.handle.publishPending();
		if (!bootstrapPublication.ok || bootstrapPublication.kind !== "published") {
			throw new TypeError("Phase 3g source bootstrap publication failed");
		}
		const profile = options.sourceOperationProfile ?? "singleton";
		const operations: ReturnType<typeof sourceOperations> = sourceOperations(profile);
		let sourceIssue: SharedPlaneScenarioResult["sourceIssue"];
		let sourceCommit: DurableIssueCommit;
		const sourceCommits: DurableIssueCommit[] = [];
		if (isHostileProfile(profile)) {
			const directControl = profile === "acl" || profile === "join" || profile === "structural";
			const hostile = directControl
				? (operations[0]?.operation ?? Object.freeze({ action: "causalJoin" }))
				: batchOperation(operations);
			const bootstrap = await sourceStore.readIssued(scope, 0);
			if (bootstrap === null) throw new TypeError("Phase 3g source bootstrap row is unavailable");
			sourceCommit = await sourceStore.transactIssue(scope, (authorSequence) =>
				Promise.resolve(
					commitFor(
						source,
						authorSequence,
						hostile,
						operations[0]?.logicalTime ?? 3,
						directControl ? [bytesHex(bootstrap.envelope.digest)] : undefined
					)
				)
			);
			sourceIssue = Object.freeze({ kind: "hostile-stored" as const, ok: true as const });
		} else {
			sourceIssue = await sourceActivated.handle.issueLocal({
				operations,
				signRegisteredVertexDigest: (digest) =>
					Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(source.privateKeySeedHex))),
			});
			if (!sourceIssue.ok) throw new TypeError(`Phase 3g source issue failed: ${sourceIssue.kind}`);
			const issued = await sourceStore.readIssued(scope, sourceIssue.authorSequence);
			if (issued === null) throw new TypeError("Phase 3g source issued row is unavailable");
			sourceCommit = issued;
		}
		sourceCommits.push(sourceCommit);
		if (options.twoSourceRows === true) {
			const secondIssue = await sourceActivated.handle.issueLocal({
				operations: Object.freeze([
					Object.freeze({ logicalTime: 5, operation: Object.freeze({ action: "add", value: 2 }) }),
				]),
				signRegisteredVertexDigest: (digest) =>
					Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(source.privateKeySeedHex))),
			});
			if (!secondIssue.ok) throw new TypeError(`Phase 3g second source issue failed: ${secondIssue.kind}`);
			const secondCommit = await sourceStore.readIssued(scope, secondIssue.authorSequence);
			if (secondCommit === null) throw new TypeError("Phase 3g second source issued row is unavailable");
			sourceCommits.push(secondCommit);
		}
		if (options.publishSourceBeforeClose === true) {
			const sourcePublication = await sourceActivated.handle.publishPending();
			if (!sourcePublication.ok || sourcePublication.kind !== "published") {
				throw new TypeError("Phase 3g source publication failed");
			}
		}
		sourceActivated.handle.deactivate();
		await sourceJournal.close();
		sourceJournal = undefined;
		await sourceStore.close();
		sourceStore = undefined;

		const sourceSessionClosedBeforeTargetOpen = true;
		targetStore = createNodeDurableIssuanceStore({ primaryFilename: lineageFilename });
		const targetCommit =
			options.omitTargetBootstrap === true
				? undefined
				: await targetStore.transactIssue(scope, (authorSequence) =>
						Promise.resolve(commitFor(target, authorSequence, Object.freeze({ action: "add", value: 0 })))
					);
		let recoveryIssuanceStore: DurableIssuanceStore = targetStore;
		const syntheticRowCount = options.syntheticCurrentQuarantinedRowCount ?? options.syntheticDisplacedRowCount;
		if (syntheticRowCount !== undefined && targetCommit !== undefined) {
			const currentPlane = options.syntheticCurrentQuarantinedRowCount !== undefined;
			const requested = syntheticRowCount;
			const finalSequence = currentPlane ? targetCommit.authorSequence + requested - 1 : requested;
			if (
				!Number.isSafeInteger(requested) ||
				requested < 1 ||
				(!currentPlane && requested < targetCommit.authorSequence)
			) {
				throw new TypeError("Phase 3g synthetic displaced row count is invalid");
			}
			const originalRows: DurableIssuanceOutboxRecord[] = [];
			let cursor: readonly [string, string, number] | undefined;
			for (;;) {
				const page = await targetStore.readOutboxPage(
					cursor === undefined ? { limit: 128, scope } : { afterKey: cursor, limit: 128, scope }
				);
				if (page.length === 0) break;
				originalRows.push(...page);
				const last = page.at(-1);
				if (last === undefined) break;
				cursor = [scope.objectId, scope.author, last.commit.authorSequence];
			}
			const syntheticRows: DurableIssuanceOutboxRecord[] = [];
			const syntheticBySequence = new Map<number, DurableIssueCommit>();
			for (let authorSequence = targetCommit.authorSequence + 1; authorSequence <= finalSequence; authorSequence += 1) {
				const commit = commitFor(
					currentPlane ? target : source,
					authorSequence,
					currentPlane
						? Object.freeze({
								action: "applicationBatch",
								batch: Object.freeze({ entries: Object.freeze([]), version: 1 }),
							})
						: Object.freeze({ action: "add", value: authorSequence }),
					authorSequence * 2 + 1
				);
				syntheticBySequence.set(authorSequence, commit);
				syntheticRows.push(Object.freeze({ commit, publishState: "pending" as const }));
			}
			const rows = Object.freeze([...originalRows, ...syntheticRows]);
			recoveryIssuanceStore = Object.freeze({
				close: () => Promise.resolve(),
				compareAndMarkOutboxPublished: (input) => targetStore.compareAndMarkOutboxPublished(input),
				readIssued: (selectedScope, authorSequence) =>
					Promise.resolve(
						syntheticBySequence.get(authorSequence) ?? targetStore.readIssued(selectedScope, authorSequence)
					),
				readLineage: () => Promise.resolve(Object.freeze({ exhausted: false, next: finalSequence + 1 })),
				readOutboxPage: (input = {}) => {
					const after = input.afterKey?.[2] ?? -1;
					const limit = input.limit ?? 64;
					return Promise.resolve(rows.filter(({ commit }) => commit.authorSequence > after).slice(0, limit));
				},
				transactIssue: (selectedScope, buildAndSign) => targetStore.transactIssue(selectedScope, buildAndSign),
			});
		}
		let targetReplacement: DurableIssueCommit | undefined;
		targetJournal = await installJournal(target);
		if (options.targetReceivedWithoutBootstrap === true) {
			const received = commitFor(target, 10_000, Object.freeze({ action: "add", value: 99 }), 3);
			const appended = await targetJournal.appendAccepted({
				detachedSignature: received.envelope.signature,
				exactCanonicalPreimageBytes: received.envelope.canonicalPreimageBytes,
				scope: Object.freeze({ anchorDigest: target.anchorDigest, epoch: 0, objectId }),
				sourceKind: "received",
				vertexDigest: lowerHex(received.envelope.digest),
			});
			if (!appended.ok) throw new TypeError("Phase 3g target received journal append failed");
		}
		if (options.targetDirectQuarantinedRow === true) {
			targetReplacement = await targetStore.transactIssue(scope, (authorSequence) =>
				Promise.resolve(
					commitFor(
						target,
						authorSequence,
						batchOperation(
							Object.freeze([
								Object.freeze({ logicalTime: 1, operation: Object.freeze({ action: "add", value: 1 }) }),
								Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: -2 }) }),
							])
						),
						3
					)
				)
			);
		}
		if (options.targetQuarantinedMatchingReplacement === true) {
			const quarantineSeed = commitFor(
				target,
				10_000,
				batchOperation(
					Object.freeze([
						Object.freeze({ logicalTime: 1, operation: Object.freeze({ action: "add", value: -1 }) }),
						Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: -2 }) }),
					])
				),
				3
			);
			const quarantineSeedDigest = lowerHex(quarantineSeed.envelope.digest);
			const appended = await targetJournal.appendAccepted({
				detachedSignature: quarantineSeed.envelope.signature,
				exactCanonicalPreimageBytes: quarantineSeed.envelope.canonicalPreimageBytes,
				scope: Object.freeze({ anchorDigest: target.anchorDigest, epoch: 0, objectId }),
				sourceKind: "received",
				vertexDigest: quarantineSeedDigest,
			});
			if (!appended.ok) throw new TypeError("Phase 3g quarantine seed journal append failed");
			targetReplacement = await targetStore.transactIssue(scope, (authorSequence) =>
				Promise.resolve(
					commitFor(
						target,
						authorSequence,
						sourceOperations("singleton")[0]?.operation ?? Object.freeze({ action: "add", value: 1 }),
						7,
						[quarantineSeedDigest]
					)
				)
			);
		}
		let selectedSourcePlane = source;
		let sourceCapability: PreparedV3Live | undefined;
		if (options.omitSourceAuthority !== true) {
			if (options.sourceCreatorSignatureCorrupt === true) {
				const corrupted = new Uint8Array(source.detachedAnchorSignature);
				corrupted[0] = (corrupted[0] ?? 0) ^ 1;
				sourceCapability = await source.prepareAgain(corrupted);
			} else if (options.sourceAuthorityMutation === "target-capability") {
				sourceCapability = await target.prepareAgain();
			} else {
				selectedSourcePlane = mismatchedSource ?? source;
				sourceCapability = await selectedSourcePlane.prepareAgain();
			}
		}
		const sourceAuthorityPrepared = sourceCapability !== undefined;
		const sourceAuthorization = new Uint8Array(selectedSourcePlane.authorizationBytes);
		if (options.sourceAuthorityMutation === "authorization-bytes") {
			sourceAuthorization[0] = (sourceAuthorization[0] ?? 0) ^ 1;
		}
		const targetCapability =
			options.targetAuthorityMutation === "source-capability" ? await source.prepareAgain() : target.capability;
		if (targetCapability === undefined) throw new TypeError("Phase 3g target recovery preparation failed");
		const targetAuthorization = new Uint8Array(target.authorizationBytes);
		if (options.targetAuthorityMutation === "authorization-bytes") {
			targetAuthorization[0] = (targetAuthorization[0] ?? 0) ^ 1;
		}
		const recovery = (await recoverV3LiveReplica({
			capability: targetCapability,
			...(sourceCapability === undefined
				? {}
				: {
						displacedSource: Object.freeze({
							capability: sourceCapability,
							...recoveryAuthorization(selectedSourcePlane, sourceAuthorization),
						}),
					}),
			...recoveryAuthorization(target, targetAuthorization),
			issuanceScope: scope,
			issuanceStore: recoveryIssuanceStore,
			liveJournalStore: targetJournal,
		} as never)) as unknown as Readonly<Record<string, unknown>>;
		let rebaseOutbox: unknown;
		const rebaseOutboxes: unknown[] = [];
		let completion: unknown;
		let publication: unknown;
		let publicationAfterQuarantine: unknown;
		let reopenRecovery: Readonly<Record<string, unknown>> | undefined;
		const targetPublished: string[] = [];
		if (Reflect.get(recovery, "ok") === true) {
			const activated = activateV3LivePlane({
				capability: Reflect.get(recovery, "capability") as never,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: network("target", targetPublished),
				onAdmittedVertex: () => undefined,
			});
			if (!activated.ok) throw new TypeError(`Phase 3g target activation failed: ${activated.kind}`);
			let activeHandle = activated.handle;
			let activeHandleNeedsDeactivate = true;
			try {
				if (options.targetReplacementAfterRecoveryBeforeRead === true) {
					targetReplacement = await targetStore.transactIssue(scope, (authorSequence) =>
						Promise.resolve(
							commitFor(
								target,
								authorSequence,
								sourceOperations("singleton")[0]?.operation ?? Object.freeze({ action: "add", value: 1 }),
								7
							)
						)
					);
					activeHandle.deactivate();
					activeHandleNeedsDeactivate = false;
					const closingTargetJournal = targetJournal;
					targetJournal = undefined;
					await closingTargetJournal.close();
					const closingTargetStore = targetStore;
					targetStore = undefined;
					await closingTargetStore.close();
					targetStore = createNodeDurableIssuanceStore({ primaryFilename: lineageFilename });
					targetJournal = await installJournal(target);
					const restartedTargetCapability = await target.prepareAgain();
					const restartedSourceCapability = await source.prepareAgain();
					if (restartedTargetCapability === undefined || restartedSourceCapability === undefined) {
						throw new TypeError("Phase 3g target replacement restart preparation failed");
					}
					reopenRecovery = (await recoverV3LiveReplica({
						capability: restartedTargetCapability,
						displacedSource: Object.freeze({
							capability: restartedSourceCapability,
							...recoveryAuthorization(source),
						}),
						...recoveryAuthorization(target),
						issuanceScope: scope,
						issuanceStore: targetStore,
						liveJournalStore: targetJournal,
					} as never)) as unknown as Readonly<Record<string, unknown>>;
					if (Reflect.get(reopenRecovery, "ok") !== true) {
						throw new TypeError("Phase 3g target replacement restart recovery failed");
					}
					const restarted = activateV3LivePlane({
						capability: Reflect.get(reopenRecovery, "capability") as never,
						messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
						networkNode: network("target-restarted", targetPublished),
						onAdmittedVertex: () => undefined,
					});
					if (!restarted.ok) throw new TypeError(`Phase 3g target restart activation failed: ${restarted.kind}`);
					activeHandle = restarted.handle;
					activeHandleNeedsDeactivate = true;
				}
				const read = Reflect.get(activeHandle, "readRebaseOutbox");
				if (typeof read !== "function") throw new TypeError("PHASE3G_REBASE_OUTBOX_ABSENT");
				rebaseOutbox = await Reflect.apply(read, activeHandle, []);
				rebaseOutboxes.push(rebaseOutbox);
				const outboxSource =
					typeof rebaseOutbox === "object" && rebaseOutbox !== null ? Reflect.get(rebaseOutbox, "source") : undefined;
				const intents =
					typeof outboxSource === "object" && outboxSource !== null ? Reflect.get(outboxSource, "intents") : undefined;
				if (Array.isArray(intents) && intents.length === 0) {
					const complete = Reflect.get(activeHandle, "completeRebaseSource");
					if (typeof complete !== "function") throw new TypeError("PHASE3G_REBASE_COMPLETION_ABSENT");
					completion = await Reflect.apply(complete, activeHandle, [
						Object.freeze({
							authorSequence: sourceCommit.authorSequence,
							digest: lowerHex(sourceCommit.envelope.digest),
						}),
					]);
				}
				if (options.twoSourceRows === true) {
					const complete = Reflect.get(activeHandle, "completeRebaseSource");
					if (typeof complete !== "function") throw new TypeError("PHASE3G_REBASE_COMPLETION_ABSENT");
					completion = await Reflect.apply(complete, activeHandle, [
						Object.freeze({
							authorSequence: sourceCommits[0]?.authorSequence,
							digest: lowerHex((sourceCommits[0] as DurableIssueCommit).envelope.digest),
						}),
					]);
					const next = await Reflect.apply(read, activeHandle, []);
					rebaseOutboxes.push(next);
				}
				publication = await activeHandle.publishPending();
				if (options.targetDirectQuarantinedRow === true) {
					publicationAfterQuarantine = await activeHandle.publishPending();
				}
			} finally {
				if (activeHandleNeedsDeactivate) activeHandle.deactivate();
			}
		}
		if (
			options.reopenTarget === true &&
			options.targetReplacementAfterRecoveryBeforeRead !== true &&
			Reflect.get(recovery, "ok") === true
		) {
			const closingTargetJournal = targetJournal;
			targetJournal = undefined;
			await closingTargetJournal.close();
			const closingTargetStore = targetStore;
			targetStore = undefined;
			await closingTargetStore.close();
			const reopenedStore = createNodeDurableIssuanceStore({ primaryFilename: lineageFilename });
			const reopenedJournal = await installJournal(target);
			try {
				const reopenedCapability = await target.prepareAgain();
				if (reopenedCapability === undefined) throw new TypeError("Phase 3g target reopen preparation failed");
				const reopenedSource = await source.prepareAgain();
				if (reopenedSource === undefined) throw new TypeError("Phase 3g source reopen preparation failed");
				reopenRecovery = (await recoverV3LiveReplica({
					capability: reopenedCapability,
					displacedSource: Object.freeze({
						capability: reopenedSource,
						...recoveryAuthorization(source),
					}),
					...recoveryAuthorization(target),
					issuanceScope: scope,
					issuanceStore: reopenedStore,
					liveJournalStore: reopenedJournal,
				} as never)) as unknown as Readonly<Record<string, unknown>>;
			} finally {
				await reopenedJournal.close();
				await reopenedStore.close();
			}
		}
		const snapshotStore = targetStore ?? createNodeDurableIssuanceStore({ primaryFilename: lineageFilename });
		try {
			const lineage = await snapshotStore.readLineage(scope);
			return Object.freeze({
				completion,
				lineageNext: lineage.next,
				networkPublishedDigests: Object.freeze(targetPublished),
				outbox: await outboxSnapshot(snapshotStore, scope),
				publication,
				publicationAfterQuarantine,
				rebaseOutbox,
				rebaseOutboxes: Object.freeze(rebaseOutboxes),
				recovery,
				reopenRecovery,
				sourceAnchor: source.anchorDigest,
				sourceBootstrapDigest: lowerHex(sourceBootstrap.envelope.digest),
				sourceAuthorityPrepared,
				sourceContextAuthor: selectedSourcePlane.author,
				sourceDigest: lowerHex(sourceCommit.envelope.digest),
				sourceDigests: Object.freeze(sourceCommits.map((commit) => lowerHex(commit.envelope.digest))),
				sourceIssue,
				sourceRowAuthor: source.author,
				sourceSessionClosedBeforeTargetOpen,
				targetAnchor: target.anchorDigest,
				targetAuthor: target.author,
				targetDigest: targetCommit === undefined ? undefined : lowerHex(targetCommit.envelope.digest),
				targetReplacementDigest:
					targetReplacement === undefined ? undefined : lowerHex(targetReplacement.envelope.digest),
				targetReplacementLogicalTime:
					targetReplacement === undefined ? undefined : commitLogicalTime(targetReplacement),
			});
		} finally {
			if (snapshotStore !== targetStore) await snapshotStore.close();
		}
	} finally {
		await sourceJournal?.close();
		await sourceStore?.close();
		await targetJournal?.close();
		await targetStore?.close();
		await Promise.all([source.close(), target.close(), mismatchedSource?.close()]);
		rmSync(lineageDirectory, { force: true, recursive: true });
	}
}

async function appendLocalIssued(
	journal: DurableLiveJournalStore,
	plane: PreparedPlane,
	commit: DurableIssueCommit
): Promise<void> {
	const appended = await journal.appendAccepted({
		author: plane.author,
		authorSequence: commit.authorSequence,
		scope: Object.freeze({ anchorDigest: plane.anchorDigest, epoch: 0, objectId: plane.objectId }),
		sourceKind: "local-issued",
		vertexDigest: lowerHex(commit.envelope.digest),
	});
	if (!appended.ok || appended.idempotent) throw new TypeError("Phase 3h cross-object journal append failed");
}

/**
 * Exercises the one-use terminal capability through real issuance, journal, index, sink, publication, and recovery.
 * @returns Durable transition and reopen evidence.
 */
export async function runTerminalCommitScenario(): Promise<TerminalCommitScenarioResult> {
	const objectId = `creator:${"c".repeat(32)}`;
	const remoteSeedHex = "ab".repeat(32);
	const remoteAuthor = bytesHex(ed25519.getPublicKey(hexBytes(remoteSeedHex)));
	const creatorAuthor = bytesHex(ed25519.getPublicKey(hexBytes(contract.privateKeySeedHex)));
	const plane = await preparePlane(objectId, "9".repeat(64), "terminal-commit", {
		authorizationAuthors: [creatorAuthor, remoteAuthor].sort(),
		terminalCatalog: true,
		useLatchedAcl: true,
	});
	const directory = mkdtempSync(path.join(tmpdir(), "drp-phase-3h-terminal-"));
	const issuanceFilename = path.join(directory, "issuance");
	let store: DurableIssuanceStore | undefined;
	let journal: DurableLiveJournalStore | undefined;
	try {
		const scope = Object.freeze({ author: plane.author, objectId });
		store = createNodeDurableIssuanceStore({ primaryFilename: issuanceFilename });
		journal = await installJournal(plane);
		const bootstrap = await store.transactIssue(scope, (authorSequence) =>
			Promise.resolve(commitFor(plane, authorSequence, terminalMessage("terminal-bootstrap")))
		);
		await appendLocalIssued(journal, plane, bootstrap);
		await store.compareAndMarkOutboxPublished({
			authorSequence: bootstrap.authorSequence,
			digest: new Uint8Array(bootstrap.envelope.digest),
			scope,
		});
		let issuanceTransactions = 0;
		const observedStore: DurableIssuanceStore = Object.freeze({
			close: () => Promise.resolve(),
			compareAndMarkOutboxPublished: (input) => store?.compareAndMarkOutboxPublished(input) ?? Promise.reject(),
			readIssued: (selectedScope, authorSequence) =>
				store?.readIssued(selectedScope, authorSequence) ?? Promise.resolve(null),
			readLineage: (selectedScope) =>
				store?.readLineage(selectedScope) ?? Promise.resolve({ exhausted: true, next: 0 }),
			readOutboxPage: (input) => store?.readOutboxPage(input) ?? Promise.resolve([]),
			transactIssue: (selectedScope, buildAndSign) => {
				issuanceTransactions += 1;
				if (store === undefined) return Promise.reject(new TypeError("terminal issuance store is closed"));
				return store.transactIssue(selectedScope, buildAndSign);
			},
		});
		const capability = await plane.prepareAgain();
		if (capability === undefined || plane.exactCanonicalLatchedAclBytes === undefined) {
			throw new TypeError("Phase 3h terminal authority is unavailable");
		}
		const recovery = await recoverV3LiveReplica({
			capability,
			classifyTerminalVertex: (input: never): ReturnType<typeof terminalClassifier> =>
				terminalClassifier(plane.author, input),
			exactCanonicalLatchedAclBytes: plane.exactCanonicalLatchedAclBytes,
			issuanceScope: scope,
			issuanceStore: observedStore,
			liveJournalStore: journal,
		} as never);
		if (!recovery.ok) throw new TypeError(`Phase 3h terminal recovery failed: ${recovery.kind}`);
		const admittedActions: string[] = [];
		const admittedClientOperationIds: string[] = [];
		const publishedDigests: string[] = [];
		let earlierSinkReleased = false;
		let resolveEarlierSink = (): void => undefined;
		let signalEarlierSinkStarted = (): void => undefined;
		const earlierSinkRelease = new Promise<void>((resolve) => {
			resolveEarlierSink = resolve;
		});
		const releaseEarlierSink = (): void => {
			earlierSinkReleased = true;
			resolveEarlierSink();
		};
		const earlierSinkStarted = new Promise<void>((resolve) => {
			signalEarlierSinkStarted = resolve;
		});
		const boundNetwork = network("terminal-commit", publishedDigests, (message) => message.objectId);
		const messageQueueManager = new ObservedMessageQueueManager<Message>({ logConfig: { level: "silent" } });
		const activated = activateV3LivePlane({
			capability: recovery.capability,
			messageQueueManager,
			networkNode: boundNetwork,
			onAdmittedVertex: ({ vertex }) => {
				const action = Reflect.get(vertex.operation, "action");
				if (typeof action !== "string") throw new TypeError("terminal admitted action is invalid");
				admittedActions.push(action);
				const clientOperationId = Reflect.get(vertex.operation, "clientOperationId");
				if (typeof clientOperationId === "string") admittedClientOperationIds.push(clientOperationId);
				const disposition = Object.freeze({
					kind: action === "migrationActivation" ? ("terminal-accepted" as const) : ("continue" as const),
				});
				if (clientOperationId !== "phase-3h-earlier-blocked") return disposition;
				signalEarlierSinkStarted();
				return earlierSinkRelease.then(() => disposition);
			},
		});
		if (!activated.ok) throw new TypeError(`Phase 3h terminal activation failed: ${activated.kind}`);
		let begun: unknown;
		let begunAgain: unknown;
		let begunWhileActive: unknown;
		let beginSettledBeforeEarlierSinkRelease = false;
		let earlierIssue: unknown;
		let forgedReceiverIssuanceDelta = -1;
		let forgedReceiverPublish: unknown;
		let forgedReceiverResume: unknown;
		let forgedReceiverSignerCalls = 0;
		let heldBeforeResume = false;
		let heldRemoteRouted = false;
		let heldRemoteProcessedBeforeResume = false;
		let issuanceTransactionsBeforeResume = -1;
		let issuanceTransactionsAfterResume = -1;
		let issuanceTransactionsAfterTerminal = -1;
		let laterIssue: unknown;
		let laterIssueSignerCalls = 0;
		let terminalHeldIssue: unknown;
		let terminalHeldSignerCalls = 0;
		let malformedTerminal: unknown;
		let ordinaryTerminal: unknown;
		let publication: unknown;
		let postTerminalRemoteProcessed = false;
		let postTerminalRemoteRouted = false;
		let publishTerminal: unknown;
		let rejectedSignerTerminal: unknown;
		let resume: unknown;
		let reusedPublish: unknown;
		let reusedResume: unknown;
		try {
			const earlierIssuePromise = activated.handle.issueLocal({
				operations: Object.freeze([Object.freeze({ logicalTime: 4, operation: terminalMessage("earlier-blocked") })]),
				signRegisteredVertexDigest: (digest) =>
					Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(plane.privateKeySeedHex))),
			});
			await earlierSinkStarted;
			const beginPromise = Promise.resolve(
				Reflect.apply(Reflect.get(activated.handle, "beginTerminalTransition") as () => unknown, activated.handle, [])
			);
			beginSettledBeforeEarlierSinkRelease = await Promise.race([
				beginPromise.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
			]);
			issuanceTransactionsBeforeResume = issuanceTransactions;
			const laterIssuePromise = activated.handle.issueLocal({
				operations: Object.freeze([Object.freeze({ logicalTime: 5, operation: terminalMessage("held-after-begin") })]),
				signRegisteredVertexDigest: (digest) => {
					laterIssueSignerCalls += 1;
					return Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(plane.privateKeySeedHex)));
				},
			});
			const heldRemote = commitForSigner(plane, remoteAuthor, remoteSeedHex, 0, terminalMessage("held-remote"), 6, [
				lowerHex(bootstrap.envelope.digest),
			]);
			const heldRemoteMessage = messageForCommit(heldRemote, activated.handle.topic);
			const heldRemoteReceiptPromise = messageQueueManager.nextReceipt();
			heldRemoteRouted = routeV3Ingress(boundNetwork, heldRemoteMessage);
			const heldRemoteReceipt = await heldRemoteReceiptPromise;
			const heldRemoteStartedBeforeEarlierRelease = await heldRemoteReceipt.started;
			await new Promise<void>((resolve) => setImmediate(resolve));
			heldBeforeResume =
				issuanceTransactions === issuanceTransactionsBeforeResume &&
				laterIssueSignerCalls === 0 &&
				!earlierSinkReleased &&
				heldRemoteStartedBeforeEarlierRelease &&
				heldRemoteReceipt.handlerStarted &&
				!heldRemoteReceipt.settled &&
				heldRemoteReceipt.outcome === undefined;
			releaseEarlierSink();
			earlierIssue = await earlierIssuePromise;
			begun = await beginPromise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			heldRemoteProcessedBeforeResume = heldRemoteReceipt.settled;
			const firstCapability = Reflect.get(begun as object, "capability");
			begunWhileActive = await Reflect.apply(
				Reflect.get(activated.handle, "beginTerminalTransition") as () => unknown,
				activated.handle,
				[]
			);
			forgedReceiverResume = Reflect.apply(
				Reflect.get(firstCapability as object, "resume") as () => unknown,
				Object.freeze({}),
				[]
			);
			const forgedReceiverIssuanceStart = issuanceTransactions;
			try {
				const value = await Reflect.apply(
					Reflect.get(firstCapability as object, "publishTerminal") as (input: unknown) => unknown,
					Object.freeze({}),
					[
						Object.freeze({
							operations: Object.freeze([
								Object.freeze({
									logicalTime: 6,
									operation: Object.freeze({
										action: "migrationActivation",
										decision: Object.freeze({ version: 1 }),
									}),
								}),
							]),
							signRegisteredVertexDigest: (digest: Uint8Array) => {
								forgedReceiverSignerCalls += 1;
								return Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(plane.privateKeySeedHex)));
							},
						}),
					]
				);
				forgedReceiverPublish = Object.freeze({ kind: "resolved" as const, value });
			} catch (error: unknown) {
				forgedReceiverPublish = Object.freeze({ error, kind: "rejected" as const });
			}
			forgedReceiverIssuanceDelta = issuanceTransactions - forgedReceiverIssuanceStart;
			ordinaryTerminal = await Reflect.apply(
				Reflect.get(firstCapability as object, "publishTerminal") as (input: unknown) => unknown,
				firstCapability,
				[
					Object.freeze({
						operations: Object.freeze([
							Object.freeze({ logicalTime: 6, operation: terminalMessage("ordinary-terminal") }),
						]),
						signRegisteredVertexDigest: (digest: Uint8Array) =>
							Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(plane.privateKeySeedHex))),
					}),
				]
			);
			resume = Reflect.apply(Reflect.get(firstCapability as object, "resume") as () => unknown, firstCapability, []);
			await heldRemoteReceipt.processed;
			laterIssue = await laterIssuePromise;
			issuanceTransactionsAfterResume = issuanceTransactions;
			reusedResume = Reflect.apply(
				Reflect.get(firstCapability as object, "resume") as () => unknown,
				firstCapability,
				[]
			);
			reusedPublish = await Reflect.apply(
				Reflect.get(firstCapability as object, "publishTerminal") as (input: unknown) => unknown,
				firstCapability,
				[
					Object.freeze({
						operations: Object.freeze([
							Object.freeze({
								logicalTime: 7,
								operation: Object.freeze({
									action: "migrationActivation",
									decision: Object.freeze({ version: 1 }),
								}),
							}),
						]),
						signRegisteredVertexDigest: (digest: Uint8Array) =>
							Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(plane.privateKeySeedHex))),
					}),
				]
			);

			const malformedBegin = await Reflect.apply(
				Reflect.get(activated.handle, "beginTerminalTransition") as () => unknown,
				activated.handle,
				[]
			);
			const malformedCapability = Reflect.get(malformedBegin as object, "capability");
			malformedTerminal = await Reflect.apply(
				Reflect.get(malformedCapability as object, "publishTerminal") as (input: unknown) => unknown,
				malformedCapability,
				[
					Object.freeze({
						operations: Object.freeze([
							Object.freeze({
								logicalTime: 7,
								operation: Object.freeze({ action: "migrationActivation", decision: Object.freeze({ version: 1 }) }),
							}),
							Object.freeze({
								logicalTime: 8,
								operation: Object.freeze({ action: "migrationActivation", decision: Object.freeze({ version: 1 }) }),
							}),
						]),
						signRegisteredVertexDigest: (digest: Uint8Array) =>
							Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(plane.privateKeySeedHex))),
					}),
				]
			);
			Reflect.apply(Reflect.get(malformedCapability as object, "resume") as () => unknown, malformedCapability, []);

			const signerBegin = await Reflect.apply(
				Reflect.get(activated.handle, "beginTerminalTransition") as () => unknown,
				activated.handle,
				[]
			);
			const signerCapability = Reflect.get(signerBegin as object, "capability");
			rejectedSignerTerminal = await Reflect.apply(
				Reflect.get(signerCapability as object, "publishTerminal") as (input: unknown) => unknown,
				signerCapability,
				[
					Object.freeze({
						operations: Object.freeze([
							Object.freeze({
								logicalTime: 7,
								operation: Object.freeze({ action: "migrationActivation", decision: Object.freeze({ version: 1 }) }),
							}),
						]),
						signRegisteredVertexDigest: () => Promise.reject(new TypeError("controlled terminal signer rejection")),
					}),
				]
			);
			Reflect.apply(Reflect.get(signerCapability as object, "resume") as () => unknown, signerCapability, []);

			begunAgain = await Reflect.apply(
				Reflect.get(activated.handle, "beginTerminalTransition") as () => unknown,
				activated.handle,
				[]
			);
			const terminalCapability = Reflect.get(begunAgain as object, "capability");
			const terminalHeldIssuePromise = activated.handle
				.issueLocal({
					operations: Object.freeze([
						Object.freeze({ logicalTime: 8, operation: terminalMessage("held-after-terminal-begin") }),
					]),
					signRegisteredVertexDigest: (digest: Uint8Array) => {
						terminalHeldSignerCalls += 1;
						return Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(plane.privateKeySeedHex)));
					},
				})
				.then(
					(value) => Object.freeze({ kind: "resolved" as const, value }),
					(error: unknown) => Object.freeze({ error, kind: "rejected" as const })
				);
			publishTerminal = await Reflect.apply(
				Reflect.get(terminalCapability as object, "publishTerminal") as (input: unknown) => unknown,
				terminalCapability,
				[
					Object.freeze({
						operations: Object.freeze([
							Object.freeze({
								logicalTime: 7,
								operation: Object.freeze({
									action: "migrationActivation",
									decision: Object.freeze({ version: 1 }),
								}),
							}),
						]),
						signRegisteredVertexDigest: (digest: Uint8Array) =>
							Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(plane.privateKeySeedHex))),
					}),
				]
			);
			terminalHeldIssue = await terminalHeldIssuePromise;
			issuanceTransactionsAfterTerminal = issuanceTransactions;
			const terminalDigest = Reflect.get(publishTerminal as object, "digest");
			if (typeof terminalDigest !== "string") throw new TypeError("terminal commit digest is absent");
			const postTerminalRemote = commitForSigner(
				plane,
				remoteAuthor,
				remoteSeedHex,
				1,
				terminalMessage("after-terminal-remote"),
				10,
				[terminalDigest]
			);
			const postTerminalRemoteMessage = messageForCommit(postTerminalRemote, activated.handle.topic);
			const postTerminalReceiptPromise = messageQueueManager.nextReceipt();
			postTerminalRemoteRouted = routeV3Ingress(boundNetwork, postTerminalRemoteMessage);
			if (postTerminalRemoteRouted) {
				const postTerminalReceipt = await postTerminalReceiptPromise;
				await postTerminalReceipt.started;
				await postTerminalReceipt.processed;
				postTerminalRemoteProcessed = postTerminalReceipt.settled;
			} else {
				postTerminalRemoteProcessed = false;
			}
			publication = await activated.handle.publishPending();
		} finally {
			releaseEarlierSink();
			activated.handle.deactivate();
		}

		const terminalSequence = Reflect.get(publishTerminal as object, "authorSequence");
		const terminalCommit =
			typeof terminalSequence === "number" ? await store.readIssued(scope, terminalSequence) : null;
		const terminalPreimage =
			terminalCommit === null ? undefined : decodeCanonical(terminalCommit.envelope.canonicalPreimageBytes);
		const issuedTerminalAction =
			terminalPreimage === undefined || terminalPreimage === null || typeof terminalPreimage !== "object"
				? undefined
				: (Reflect.get(Reflect.get(terminalPreimage, "operation") as object, "action") as string | undefined);
		const readiness = await journal.readiness({
			scope: Object.freeze({ anchorDigest: plane.anchorDigest, epoch: 0, objectId }),
		});
		if (!readiness.ok || !readiness.ready) throw new TypeError("Phase 3h terminal journal is unavailable");
		const outbox = await outboxSnapshot(store, scope);

		await journal.close();
		journal = undefined;
		await store.close();
		store = undefined;
		store = createNodeDurableIssuanceStore({ primaryFilename: issuanceFilename });
		journal = await installJournal(plane);
		const reopenedCapability = await plane.prepareAgain();
		if (reopenedCapability === undefined) throw new TypeError("Phase 3h terminal reopen authority is unavailable");
		const reopened = await recoverV3LiveReplica({
			capability: reopenedCapability,
			classifyTerminalVertex: (input: never): ReturnType<typeof terminalClassifier> =>
				terminalClassifier(plane.author, input),
			exactCanonicalLatchedAclBytes: plane.exactCanonicalLatchedAclBytes,
			issuanceScope: scope,
			issuanceStore: store,
			liveJournalStore: journal,
		} as never);
		if (!reopened.ok) throw new TypeError(`Phase 3h terminal reopen failed: ${reopened.kind}`);
		const reactivated = activateV3LivePlane({
			capability: reopened.capability,
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode: network("terminal-reopen", publishedDigests),
			onAdmittedVertex: () => Object.freeze({ kind: "continue" as const }),
		});
		if (!reactivated.ok) throw new TypeError(`Phase 3h terminal reactivation failed: ${reactivated.kind}`);
		let reopenedBegin: unknown;
		try {
			reopenedBegin = await Reflect.apply(
				Reflect.get(reactivated.handle, "beginTerminalTransition") as () => unknown,
				reactivated.handle,
				[]
			);
		} finally {
			reactivated.handle.deactivate();
		}

		return Object.freeze({
			admittedActions: Object.freeze(admittedActions),
			admittedClientOperationIds: Object.freeze(admittedClientOperationIds),
			begun,
			begunAgain,
			begunWhileActive,
			beginSettledBeforeEarlierSinkRelease,
			earlierIssue,
			forgedReceiverIssuanceDelta,
			forgedReceiverPublish,
			forgedReceiverResume,
			forgedReceiverSignerCalls,
			heldBeforeResume,
			heldRemoteRouted,
			heldRemoteProcessedBeforeResume,
			issuanceTransactionsAfterResume,
			issuanceTransactionsAfterTerminal,
			issuanceTransactionsBeforeResume,
			issuedTerminalAction,
			journalRowCount: readiness.rowCount,
			laterIssue,
			laterIssueSignerCalls,
			terminalHeldIssue,
			terminalHeldSignerCalls,
			malformedTerminal,
			ordinaryTerminal,
			outboxPublishStates: Object.freeze(outbox.map(({ publishState }) => publishState)),
			publication,
			postTerminalRemoteProcessed,
			postTerminalRemoteRouted,
			publishedDigests: Object.freeze(publishedDigests),
			publishTerminal,
			rejectedSignerTerminal,
			reopenedBegin,
			resume,
			reusedPublish,
			reusedResume,
		});
	} finally {
		await journal?.close();
		await store?.close();
		await plane.close();
		rmSync(directory, { force: true, recursive: true });
	}
}

/**
 * Exercises every invalid admitted-sink outcome after a terminal vertex becomes durable.
 * @returns Total fail-closed results and restart evidence for each invalid disposition.
 */
export async function runTerminalSinkDispositionScenarios(): Promise<readonly TerminalSinkDispositionScenarioResult[]> {
	const results: TerminalSinkDispositionScenarioResult[] = [];
	for (const [index, disposition] of (["rejected", "throw", "missing"] as const).entries()) {
		const objectId = `creator:${String(index + 7).repeat(32)}`;
		const plane = await preparePlane(objectId, String(index + 6).repeat(64), `terminal-sink-${disposition}`, {
			terminalCatalog: true,
			useLatchedAcl: true,
		});
		const directory = mkdtempSync(path.join(tmpdir(), `drp-phase-3h-terminal-sink-${disposition}-`));
		const issuanceFilename = path.join(directory, "issuance");
		let store: DurableIssuanceStore | undefined;
		let journal: DurableLiveJournalStore | undefined;
		try {
			const scope = Object.freeze({ author: plane.author, objectId });
			store = createNodeDurableIssuanceStore({ primaryFilename: issuanceFilename });
			journal = await installJournal(plane);
			const bootstrap = await store.transactIssue(scope, (authorSequence) =>
				Promise.resolve(commitFor(plane, authorSequence, terminalMessage(`sink-${disposition}-bootstrap`)))
			);
			await appendLocalIssued(journal, plane, bootstrap);
			await store.compareAndMarkOutboxPublished({
				authorSequence: bootstrap.authorSequence,
				digest: new Uint8Array(bootstrap.envelope.digest),
				scope,
			});
			const capability = await plane.prepareAgain();
			if (capability === undefined || plane.exactCanonicalLatchedAclBytes === undefined) {
				throw new TypeError("Phase 3h sink authority is unavailable");
			}
			const recovery = await recoverV3LiveReplica({
				capability,
				classifyTerminalVertex: (input: never): ReturnType<typeof terminalClassifier> =>
					terminalClassifier(plane.author, input),
				exactCanonicalLatchedAclBytes: plane.exactCanonicalLatchedAclBytes,
				issuanceScope: scope,
				issuanceStore: store,
				liveJournalStore: journal,
			} as never);
			if (!recovery.ok) throw new TypeError(`Phase 3h sink recovery failed: ${recovery.kind}`);
			const activated = activateV3LivePlane({
				capability: recovery.capability,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: network(`terminal-sink-${disposition}`, []),
				onAdmittedVertex: ({ vertex }) => {
					if (Reflect.get(vertex.operation, "action") !== "migrationActivation") {
						return Object.freeze({ kind: "continue" as const });
					}
					if (disposition === "rejected") return Object.freeze({ kind: "terminal-rejected" as const });
					if (disposition === "missing") return undefined;
					throw new TypeError("controlled terminal sink failure");
				},
			});
			if (!activated.ok) throw new TypeError(`Phase 3h sink activation failed: ${activated.kind}`);
			let publication: unknown;
			let laterIssue: unknown;
			try {
				const begun = await Reflect.apply(
					Reflect.get(activated.handle, "beginTerminalTransition") as () => unknown,
					activated.handle,
					[]
				);
				const terminalCapability = Reflect.get(begun as object, "capability");
				const laterIssuePromise = activated.handle
					.issueLocal({
						operations: Object.freeze([
							Object.freeze({
								logicalTime: 7,
								operation: terminalMessage(`after-sink-${disposition}`),
							}),
						]),
						signRegisteredVertexDigest: (digest: Uint8Array) =>
							Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(plane.privateKeySeedHex))),
					})
					.then(
						(value) => Object.freeze({ kind: "resolved" as const, value }),
						(error: unknown) => Object.freeze({ error, kind: "rejected" as const })
					);
				publication = await Promise.resolve(
					Reflect.apply(
						Reflect.get(terminalCapability as object, "publishTerminal") as (input: unknown) => unknown,
						terminalCapability,
						[
							Object.freeze({
								operations: Object.freeze([
									Object.freeze({
										logicalTime: 6,
										operation: Object.freeze({
											action: "migrationActivation",
											decision: Object.freeze({ version: 1 }),
										}),
									}),
								]),
								signRegisteredVertexDigest: (digest: Uint8Array) =>
									Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(plane.privateKeySeedHex))),
							}),
						]
					)
				).then(
					(value) => Object.freeze({ kind: "resolved" as const, value }),
					(error: unknown) => Object.freeze({ error, kind: "rejected" as const })
				);
				laterIssue = await laterIssuePromise;
			} finally {
				activated.handle.deactivate();
			}
			const readiness = await journal.readiness({
				scope: Object.freeze({ anchorDigest: plane.anchorDigest, epoch: 0, objectId }),
			});
			if (!readiness.ok || !readiness.ready) throw new TypeError("Phase 3h sink journal is unavailable");
			await journal.close();
			journal = undefined;
			await store.close();
			store = undefined;
			store = createNodeDurableIssuanceStore({ primaryFilename: issuanceFilename });
			journal = await installJournal(plane);
			const reopenedCapability = await plane.prepareAgain();
			if (reopenedCapability === undefined) throw new TypeError("Phase 3h sink reopen authority is unavailable");
			const reopened = await recoverV3LiveReplica({
				capability: reopenedCapability,
				classifyTerminalVertex: (input: never): ReturnType<typeof terminalClassifier> =>
					terminalClassifier(plane.author, input),
				exactCanonicalLatchedAclBytes: plane.exactCanonicalLatchedAclBytes,
				issuanceScope: scope,
				issuanceStore: store,
				liveJournalStore: journal,
			} as never);
			if (!reopened.ok) throw new TypeError(`Phase 3h sink reopen failed: ${reopened.kind}`);
			const reactivated = activateV3LivePlane({
				capability: reopened.capability,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: network(`terminal-sink-${disposition}-reopen`, []),
				onAdmittedVertex: () => Object.freeze({ kind: "continue" as const }),
			});
			if (!reactivated.ok) throw new TypeError(`Phase 3h sink reactivation failed: ${reactivated.kind}`);
			let reopenedBegin: unknown;
			try {
				reopenedBegin = await Reflect.apply(
					Reflect.get(reactivated.handle, "beginTerminalTransition") as () => unknown,
					reactivated.handle,
					[]
				);
			} finally {
				reactivated.handle.deactivate();
			}
			results.push(
				Object.freeze({ disposition, journalRowCount: readiness.rowCount, laterIssue, publication, reopenedBegin })
			);
		} finally {
			await journal?.close();
			await store?.close();
			await plane.close();
			rmSync(directory, { force: true, recursive: true });
		}
	}
	return Object.freeze(results);
}

/**
 * Proves terminal publication rejects capacity and irreducible-frontier failures before signing or transacting.
 * @param kind The genuine graph constraint exercised by the recovered plane.
 * @returns Recovery, terminal result, and pre-effect counters.
 */
export async function runTerminalPreEffectScenario(
	kind: "multi-tip" | "oversized"
): Promise<TerminalPreEffectScenarioResult> {
	const objectId = `creator:${(kind === "oversized" ? "e" : "f").repeat(32)}`;
	const creatorAuthor = bytesHex(ed25519.getPublicKey(hexBytes(contract.privateKeySeedHex)));
	const writerSeeds = Array.from({ length: 17 }, (_, index) => (index + 1).toString(16).padStart(2, "0").repeat(32));
	const writerAuthors = writerSeeds.map((seed) => bytesHex(ed25519.getPublicKey(hexBytes(seed))));
	const plane = await preparePlane(objectId, kind === "oversized" ? "4".repeat(64) : "5".repeat(64), kind, {
		...(kind === "multi-tip" ? { authorizationAuthors: [creatorAuthor, ...writerAuthors].sort() } : {}),
		terminalCatalog: true,
		useLatchedAcl: true,
	});
	const directory = mkdtempSync(path.join(tmpdir(), `drp-phase-3h-terminal-${kind}-`));
	let store: DurableIssuanceStore | undefined;
	let journal: DurableLiveJournalStore | undefined;
	try {
		const scope = Object.freeze({ author: plane.author, objectId });
		store = createNodeDurableIssuanceStore({ primaryFilename: path.join(directory, "issuance") });
		journal = await installJournal(plane);
		const bootstrap = await store.transactIssue(scope, (authorSequence) =>
			Promise.resolve(commitFor(plane, authorSequence, terminalMessage(`${kind}-bootstrap`)))
		);
		await appendLocalIssued(journal, plane, bootstrap);
		await store.compareAndMarkOutboxPublished({
			authorSequence: bootstrap.authorSequence,
			digest: new Uint8Array(bootstrap.envelope.digest),
			scope,
		});
		let remainingEpochBytes: number | undefined;
		let terminalCandidateByteCharge: number | undefined;
		if (kind === "oversized") {
			let chargedBytes =
				plane.exactCanonicalAnchorPreimageBytes.byteLength + bootstrap.envelope.canonicalPreimageBytes.byteLength;
			let dependency = lowerHex(bootstrap.envelope.digest);
			for (;;) {
				const nextSequence = (await store.readLineage(scope)).next;
				const operationFor = (textLength: number): Readonly<Record<string, unknown>> =>
					Object.freeze({
						action: "message",
						clientOperationId: `capacity-${nextSequence}`,
						text: "x".repeat(textLength),
					});
				const candidateFor = (textLength: number): DurableIssueCommit =>
					commitFor(plane, nextSequence, operationFor(textLength), nextSequence * 2 + 1, [dependency]);
				const remaining = PARAMETERS.maxEpochBytes - chargedBytes;
				const maximum = candidateFor(60_000);
				let filler: DurableIssueCommit;
				if (maximum.envelope.canonicalPreimageBytes.byteLength < remaining - 128) {
					filler = maximum;
				} else {
					let low = 0;
					let high = 60_000;
					let selected: DurableIssueCommit | undefined;
					while (low <= high) {
						const middle = Math.floor((low + high) / 2);
						const candidate = candidateFor(middle);
						const charge = candidate.envelope.canonicalPreimageBytes.byteLength;
						if (charge <= remaining) {
							selected = candidate;
							low = middle + 1;
						} else {
							high = middle - 1;
						}
					}
					if (selected === undefined) break;
					filler = selected;
				}
				const charge = filler.envelope.canonicalPreimageBytes.byteLength;
				if (charge > remaining) break;
				const committed = await store.transactIssue(scope, (authorSequence) => {
					if (authorSequence !== filler.authorSequence) throw new TypeError("capacity filler sequence changed");
					return Promise.resolve(filler);
				});
				await appendLocalIssued(journal, plane, committed);
				await store.compareAndMarkOutboxPublished({
					authorSequence: committed.authorSequence,
					digest: new Uint8Array(committed.envelope.digest),
					scope,
				});
				chargedBytes += charge;
				dependency = lowerHex(committed.envelope.digest);
				if (PARAMETERS.maxEpochBytes - chargedBytes < 128) break;
			}
			remainingEpochBytes = PARAMETERS.maxEpochBytes - chargedBytes;
			const nextSequence = (await store.readLineage(scope)).next;
			terminalCandidateByteCharge = commitFor(
				plane,
				nextSequence,
				Object.freeze({ action: "migrationActivation", decision: Object.freeze({ version: 1 }) }),
				9,
				[dependency]
			).envelope.canonicalPreimageBytes.byteLength;
		}
		if (kind === "multi-tip") {
			const dependency = lowerHex(bootstrap.envelope.digest);
			for (const [index, writerAuthor] of writerAuthors.entries()) {
				const writerScope = Object.freeze({ author: writerAuthor, objectId });
				const writerBranch = await store.transactIssue(writerScope, (authorSequence) =>
					Promise.resolve(
						commitForSigner(
							plane,
							writerAuthor,
							writerSeeds[index] as string,
							authorSequence,
							terminalMessage(`writer-branch-${index}`),
							index + 3,
							[dependency]
						)
					)
				);
				const writerAppend = await journal.appendAccepted({
					author: writerAuthor,
					authorSequence: writerBranch.authorSequence,
					scope: Object.freeze({ anchorDigest: plane.anchorDigest, epoch: 0, objectId }),
					sourceKind: "local-issued",
					vertexDigest: lowerHex(writerBranch.envelope.digest),
				});
				if (!writerAppend.ok || writerAppend.idempotent) {
					throw new TypeError("Phase 3h multi-tip writer append failed");
				}
			}
		}
		let issuanceTransactions = 0;
		const observedStore: DurableIssuanceStore = Object.freeze({
			close: () => Promise.resolve(),
			compareAndMarkOutboxPublished: (input) => store?.compareAndMarkOutboxPublished(input) ?? Promise.reject(),
			readIssued: (selectedScope, authorSequence) =>
				store?.readIssued(selectedScope, authorSequence) ?? Promise.resolve(null),
			readLineage: (selectedScope) =>
				store?.readLineage(selectedScope) ?? Promise.resolve({ exhausted: true, next: 0 }),
			readOutboxPage: (input) => store?.readOutboxPage(input) ?? Promise.resolve([]),
			transactIssue: (selectedScope, buildAndSign) => {
				issuanceTransactions += 1;
				if (store === undefined) return Promise.reject(new TypeError("terminal pre-effect store is closed"));
				return store.transactIssue(selectedScope, buildAndSign);
			},
		});
		const capability = await plane.prepareAgain();
		if (capability === undefined || plane.exactCanonicalLatchedAclBytes === undefined) {
			throw new TypeError("Phase 3h terminal pre-effect authority is unavailable");
		}
		const recovery = (await recoverV3LiveReplica({
			capability,
			classifyTerminalVertex: (input: never): ReturnType<typeof terminalClassifier> =>
				terminalClassifier(plane.author, input),
			exactCanonicalLatchedAclBytes: plane.exactCanonicalLatchedAclBytes,
			issuanceScope: scope,
			issuanceStore: observedStore,
			liveJournalStore: journal,
		} as never)) as unknown as Readonly<Record<string, unknown>>;
		let begun: unknown;
		let publication: unknown;
		let signerCalls = 0;
		if (Reflect.get(recovery, "ok") === true) {
			const activated = activateV3LivePlane({
				capability: Reflect.get(recovery, "capability") as never,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: network(`terminal-${kind}`, []),
				onAdmittedVertex: () => Object.freeze({ kind: "terminal-accepted" as const }),
			});
			if (!activated.ok) throw new TypeError(`Phase 3h terminal pre-effect activation failed: ${activated.kind}`);
			try {
				begun = await Reflect.apply(
					Reflect.get(activated.handle, "beginTerminalTransition") as () => unknown,
					activated.handle,
					[]
				);
				if (Reflect.get(begun as object, "ok") === true) {
					const terminalCapability = Reflect.get(begun as object, "capability");
					publication = await Reflect.apply(
						Reflect.get(terminalCapability as object, "publishTerminal") as (input: unknown) => unknown,
						terminalCapability,
						[
							Object.freeze({
								operations: Object.freeze([
									Object.freeze({
										logicalTime: 9,
										operation: Object.freeze({
											action: "migrationActivation",
											decision: Object.freeze({ version: 1 }),
										}),
									}),
								]),
								signRegisteredVertexDigest: (digest: Uint8Array) => {
									signerCalls += 1;
									return Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(plane.privateKeySeedHex)));
								},
							}),
						]
					);
				}
			} finally {
				activated.handle.deactivate();
			}
		}
		return Object.freeze({
			begun,
			issuanceTransactions,
			publication,
			remainingEpochBytes,
			recovery,
			signerCalls,
			terminalCandidateByteCharge,
		});
	} finally {
		await journal?.close();
		await store?.close();
		await plane.close();
		rmSync(directory, { force: true, recursive: true });
	}
}

/**
 * Exercises the exact empty-target retained-bootstrap hold through genuine source and target Git-independent stores.
 * @param mutation A missing or unauthenticated source activation selector.
 * @returns Recovery, pre-prefix denial, retained routing and post-prefix release evidence.
 */
export async function runRetainedBootstrapHoldScenario(
	mutation?: RetainedBootstrapMutation
): Promise<RetainedBootstrapScenarioResult> {
	const sourceObjectId = `creator:${"1".repeat(32)}`;
	const targetObjectId = `creator:${"2".repeat(32)}`;
	const source = await preparePlane(sourceObjectId, "6".repeat(64), "retained-source", {
		terminalCatalog: true,
		useLatchedAcl: true,
	});
	const target = await preparePlane(targetObjectId, "6".repeat(64), "retained-target", {
		terminalCatalog: true,
		useLatchedAcl: true,
	});
	const directory = mkdtempSync(path.join(tmpdir(), "drp-phase-3h-retained-bootstrap-"));
	let sourceStore: DurableIssuanceStore | undefined;
	let targetStore: DurableIssuanceStore | undefined;
	let sourceJournal: DurableLiveJournalStore | undefined;
	let targetJournal: DurableLiveJournalStore | undefined;
	try {
		const sourceScope = Object.freeze({ author: source.author, objectId: sourceObjectId });
		const targetScope = Object.freeze({ author: target.author, objectId: targetObjectId });
		sourceStore = createNodeDurableIssuanceStore({ primaryFilename: path.join(directory, "source-issuance") });
		targetStore = createNodeDurableIssuanceStore({ primaryFilename: path.join(directory, "target-issuance") });
		sourceJournal = await installJournal(source);
		targetJournal = await installJournal(target);
		const sourceBootstrap = await sourceStore.transactIssue(sourceScope, (authorSequence) =>
			Promise.resolve(commitFor(source, authorSequence, terminalMessage("retained-source-bootstrap")))
		);
		const activationOperation = Object.freeze({
			action: "migrationActivation",
			decision: Object.freeze({ sourceObjectId, targetObjectId, version: 1 }),
		});
		const sourceActivation = await sourceStore.transactIssue(sourceScope, (authorSequence) =>
			Promise.resolve(
				mutation === "unauthenticated-activation"
					? commitForSigner(source, source.author, "a5".repeat(32), authorSequence, activationOperation, 3, [
							lowerHex(sourceBootstrap.envelope.digest),
						])
					: commitFor(source, authorSequence, activationOperation, 3, [lowerHex(sourceBootstrap.envelope.digest)])
			)
		);
		await appendLocalIssued(sourceJournal, source, sourceBootstrap);
		await appendLocalIssued(sourceJournal, source, sourceActivation);
		for (const commit of [sourceBootstrap, sourceActivation]) {
			await sourceStore.compareAndMarkOutboxPublished({
				authorSequence: commit.authorSequence,
				digest: new Uint8Array(commit.envelope.digest),
				scope: sourceScope,
			});
		}

		const targetBootstrap = commitFor(target, 0, terminalMessage("retained-target-bootstrap"));
		const migrationRecord = Object.freeze({
			applicationStateDigest: "1".repeat(64),
			archivePolicy: "retain-source",
			authorityKind: "creator-ed25519-registered-vertex-v1",
			exactCanonicalApplicationStateBytes: encodeCanonical([]),
			kind: "ts-drp-v3-room-migration-record",
			rehearsalNonce: new Uint8Array(32).fill(0x55),
			sourceAcceptedOperationCount: 0,
			sourceAcceptedOperationsDigest: "2".repeat(64),
			sourceAnchorDigest: source.anchorDigest,
			sourceBlueprintDigest: "3".repeat(64),
			sourceCreatorAuthor: source.author,
			sourceObjectId,
			targetAnchorDigest: target.anchorDigest,
			targetBlueprintDigest: "3".repeat(64),
			targetCreatorAuthor: target.author,
			targetImportOperationCount: 0,
			targetImportOperationsDigest: "4".repeat(64),
			targetObjectId,
			version: 1,
		});
		const targetRecord = commitFor(
			target,
			1,
			Object.freeze({ action: "migrationRecord", record: migrationRecord }),
			3,
			[lowerHex(targetBootstrap.envelope.digest)]
		);
		const sourceCapability = await source.prepareAgain();
		const targetCapability = await target.prepareAgain();
		if (
			sourceCapability === undefined ||
			targetCapability === undefined ||
			source.exactCanonicalLatchedAclBytes === undefined ||
			target.exactCanonicalLatchedAclBytes === undefined
		) {
			throw new TypeError("Phase 3h retained-bootstrap authority is unavailable");
		}
		const recovery = (await recoverV3LiveReplica({
			capability: targetCapability,
			classifyTerminalVertex: (input: never): ReturnType<typeof terminalClassifier> =>
				terminalClassifier(target.author, input),
			displacedSource: Object.freeze({
				activationVertexDigest:
					mutation === "missing-activation" ? "0".repeat(64) : lowerHex(sourceActivation.envelope.digest),
				capability: sourceCapability,
				exactCanonicalLatchedAclBytes: source.exactCanonicalLatchedAclBytes,
				issuanceScope: sourceScope,
				issuanceStore: sourceStore,
				liveJournalStore: sourceJournal,
			}),
			exactCanonicalLatchedAclBytes: target.exactCanonicalLatchedAclBytes,
			issuanceScope: targetScope,
			issuanceStore: targetStore,
			liveJournalStore: targetJournal,
			retainedBootstrapHold: true,
		} as never)) as unknown as Readonly<Record<string, unknown>>;
		const admittedActions: string[] = [];
		const routedPrefix: boolean[] = [];
		let postPrefixIssue: unknown;
		let prePrefixIssue: unknown;
		let prePrefixPublication: unknown;
		let prePrefixRebase: unknown;
		if (Reflect.get(recovery, "ok") === true) {
			const boundNetwork = network("retained-target", []);
			const activated = activateV3LivePlane({
				capability: Reflect.get(recovery, "capability") as never,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: boundNetwork,
				onAdmittedVertex: ({ vertex }) => {
					const action = Reflect.get(vertex.operation, "action");
					if (typeof action !== "string") throw new TypeError("retained-bootstrap action is invalid");
					admittedActions.push(action);
					const candidateRecord = Reflect.get(vertex.operation, "record");
					if (
						action === "migrationRecord" &&
						typeof candidateRecord === "object" &&
						candidateRecord !== null &&
						lowerHex(encodeCanonical(candidateRecord)) === lowerHex(encodeCanonical(migrationRecord))
					) {
						return Object.freeze({ kind: "retained-bootstrap-ready" as const });
					}
					return Object.freeze({ kind: "continue" as const });
				},
			});
			if (!activated.ok) throw new TypeError(`Phase 3h retained-bootstrap activation failed: ${activated.kind}`);
			try {
				const sign = (digest: Uint8Array): Promise<Uint8Array> =>
					Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(target.privateKeySeedHex)));
				prePrefixIssue = await activated.handle.issueLocal({
					operations: Object.freeze([Object.freeze({ logicalTime: 5, operation: terminalMessage("before-prefix") })]),
					signRegisteredVertexDigest: sign,
				});
				prePrefixPublication = await activated.handle.publishPending();
				prePrefixRebase = await activated.handle.readRebaseOutbox();
				for (const commit of [targetBootstrap, targetRecord]) {
					routedPrefix.push(
						routeV3RetainedIngress(
							activated.handle,
							Message.create({
								data: V3Envelope.encode({
									canonicalPreimage: commit.envelope.canonicalPreimageBytes,
									signature: commit.envelope.signature,
								}).finish(),
								objectId: activated.handle.topic,
								sender: "peer:phase-3h-retained-source",
								type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
							})
						)
					);
				}
				for (let turn = 0; turn < 64 && admittedActions.length < 2; turn += 1) {
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
				}
				postPrefixIssue = await activated.handle.issueLocal({
					operations: Object.freeze([Object.freeze({ logicalTime: 7, operation: terminalMessage("after-prefix") })]),
					signRegisteredVertexDigest: sign,
				});
			} finally {
				activated.handle.deactivate();
			}
		}
		return Object.freeze({
			admittedActions: Object.freeze(admittedActions),
			postPrefixIssue,
			prePrefixIssue,
			prePrefixPublication,
			prePrefixRebase,
			recovery,
			routedPrefix: Object.freeze(routedPrefix),
		});
	} finally {
		await sourceJournal?.close();
		await targetJournal?.close();
		await sourceStore?.close();
		await targetStore?.close();
		await Promise.all([source.close(), target.close()]);
		rmSync(directory, { force: true, recursive: true });
	}
}

/**
 * Builds one genuine source/target pair with independent scopes and a signed terminal cut.
 * The source contains one published and one pending application row outside that cut.
 * @param mutation A single authenticated authority substitution.
 * @returns Cross-object recovery, enumeration, completion, and reopen evidence.
 */
export async function runCrossObjectActivationScenario(
	mutation?: CrossObjectMutation
): Promise<CrossObjectScenarioResult> {
	const sourceObjectId = `creator:${"a".repeat(32)}`;
	const targetObjectId = `creator:${"b".repeat(32)}`;
	const source = await preparePlane(sourceObjectId, "7".repeat(64), "cross-source", {
		terminalCatalog: true,
		useLatchedAcl: true,
	});
	const target = await preparePlane(targetObjectId, "7".repeat(64), "cross-target", {
		terminalCatalog: true,
		useLatchedAcl: true,
	});
	const directory = mkdtempSync(path.join(tmpdir(), "drp-phase-3h-cross-object-"));
	const sourceFilename = path.join(directory, "source-issuance");
	const targetFilename = path.join(directory, "target-issuance");
	let sourceStore: DurableIssuanceStore | undefined;
	let targetStore: DurableIssuanceStore | undefined;
	let sourceJournal: DurableLiveJournalStore | undefined;
	let targetJournal: DurableLiveJournalStore | undefined;
	try {
		const sourceScope = Object.freeze({ author: source.author, objectId: sourceObjectId });
		const targetScope = Object.freeze({ author: target.author, objectId: targetObjectId });
		sourceStore = createNodeDurableIssuanceStore({ primaryFilename: sourceFilename });
		targetStore = createNodeDurableIssuanceStore({ primaryFilename: targetFilename });
		sourceJournal = await installJournal(source);
		targetJournal = await installJournal(target);

		const sourceBootstrap = await sourceStore.transactIssue(sourceScope, (authorSequence) =>
			Promise.resolve(commitFor(source, authorSequence, terminalMessage("cross-bootstrap")))
		);
		const outsidePublished = await sourceStore.transactIssue(sourceScope, (authorSequence) =>
			Promise.resolve(
				commitFor(source, authorSequence, terminalMessage("cross-published"), 3, [
					lowerHex(sourceBootstrap.envelope.digest),
				])
			)
		);
		const outsidePending = await sourceStore.transactIssue(sourceScope, (authorSequence) =>
			Promise.resolve(
				commitFor(source, authorSequence, terminalMessage("cross-pending"), 5, [
					lowerHex(sourceBootstrap.envelope.digest),
				])
			)
		);
		const activation = await sourceStore.transactIssue(sourceScope, (authorSequence) =>
			Promise.resolve(
				commitFor(
					source,
					authorSequence,
					Object.freeze({ action: "migrationActivation", decision: Object.freeze({ version: 1 }) }),
					7,
					[lowerHex(sourceBootstrap.envelope.digest)]
				)
			)
		);
		await appendLocalIssued(sourceJournal, source, sourceBootstrap);
		await appendLocalIssued(sourceJournal, source, outsidePublished);
		await appendLocalIssued(sourceJournal, source, outsidePending);
		await appendLocalIssued(sourceJournal, source, activation);
		for (const commit of [sourceBootstrap, outsidePublished]) {
			await sourceStore.compareAndMarkOutboxPublished({
				authorSequence: commit.authorSequence,
				digest: new Uint8Array(commit.envelope.digest),
				scope: sourceScope,
			});
		}

		const targetBootstrap = await targetStore.transactIssue(targetScope, (authorSequence) =>
			Promise.resolve(commitFor(target, authorSequence, terminalMessage("target-bootstrap")))
		);
		await appendLocalIssued(targetJournal, target, targetBootstrap);
		await targetStore.compareAndMarkOutboxPublished({
			authorSequence: targetBootstrap.authorSequence,
			digest: new Uint8Array(targetBootstrap.envelope.digest),
			scope: targetScope,
		});

		const sourceCapability = await source.prepareAgain();
		const targetCapability = await target.prepareAgain();
		if (
			sourceCapability === undefined ||
			targetCapability === undefined ||
			source.exactCanonicalLatchedAclBytes === undefined ||
			target.exactCanonicalLatchedAclBytes === undefined
		) {
			throw new TypeError("Phase 3h cross-object authority is unavailable");
		}
		const selectedSourceScope =
			mutation === "source-scope" ? Object.freeze({ author: source.author, objectId: targetObjectId }) : sourceScope;
		const selectedTargetScope =
			mutation === "target-scope" ? Object.freeze({ author: target.author, objectId: sourceObjectId }) : targetScope;
		const recovery = (await recoverV3LiveReplica({
			capability: targetCapability,
			classifyTerminalVertex: (input: never): ReturnType<typeof terminalClassifier> =>
				terminalClassifier(target.author, input),
			displacedSource: Object.freeze({
				activationVertexDigest:
					mutation === "activation-closure" ? "0".repeat(64) : lowerHex(activation.envelope.digest),
				capability: sourceCapability,
				exactCanonicalLatchedAclBytes: source.exactCanonicalLatchedAclBytes,
				issuanceScope: selectedSourceScope,
				issuanceStore: mutation === "source-store" ? targetStore : sourceStore,
				liveJournalStore: sourceJournal,
			}),
			exactCanonicalLatchedAclBytes: target.exactCanonicalLatchedAclBytes,
			issuanceScope: selectedTargetScope,
			issuanceStore: targetStore,
			liveJournalStore: targetJournal,
		} as never)) as unknown as Readonly<Record<string, unknown>>;

		const rebaseOutboxes: unknown[] = [];
		let completion: unknown;
		let reopenRecovery: Readonly<Record<string, unknown>> | undefined;
		const targetPublishedDigests: string[] = [];
		let targetPublication: unknown;
		let targetReplacement: unknown;
		if (Reflect.get(recovery, "ok") === true) {
			const activated = activateV3LivePlane({
				capability: Reflect.get(recovery, "capability") as never,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: network("cross-target", targetPublishedDigests),
				onAdmittedVertex: () => Object.freeze({ kind: "continue" as const }),
			});
			if (!activated.ok) throw new TypeError(`Phase 3h cross-object activation failed: ${activated.kind}`);
			try {
				for (let index = 0; index < 3; index += 1) {
					const page = await activated.handle.readRebaseOutbox();
					rebaseOutboxes.push(page);
					const selected = Reflect.get(page as object, "source");
					if (selected === undefined) break;
					const publishState = Reflect.get(selected as object, "publishState");
					if (publishState === "pending") {
						targetReplacement = await activated.handle.issueLocal({
							operations: Object.freeze([
								Object.freeze({ logicalTime: 9, operation: terminalMessage("cross-pending") }),
							]),
							signRegisteredVertexDigest: (digest) =>
								Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(target.privateKeySeedHex))),
						});
						targetPublication = await activated.handle.publishPending();
						completion = await activated.handle.completeRebaseSource({
							authorSequence: Reflect.get(selected as object, "authorSequence") as number,
							digest: Reflect.get(selected as object, "vertexDigest") as string,
						});
					}
				}
			} finally {
				activated.handle.deactivate();
			}

			const reopenedSourceCapability = await source.prepareAgain();
			const reopenedTargetCapability = await target.prepareAgain();
			if (reopenedSourceCapability === undefined || reopenedTargetCapability === undefined) {
				throw new TypeError("Phase 3h cross-object reopen authority is unavailable");
			}
			reopenRecovery = (await recoverV3LiveReplica({
				capability: reopenedTargetCapability,
				classifyTerminalVertex: (input: never): ReturnType<typeof terminalClassifier> =>
					terminalClassifier(target.author, input),
				displacedSource: Object.freeze({
					activationVertexDigest: lowerHex(activation.envelope.digest),
					capability: reopenedSourceCapability,
					exactCanonicalLatchedAclBytes: source.exactCanonicalLatchedAclBytes,
					issuanceScope: sourceScope,
					issuanceStore: sourceStore,
					liveJournalStore: sourceJournal,
				}),
				exactCanonicalLatchedAclBytes: target.exactCanonicalLatchedAclBytes,
				issuanceScope: targetScope,
				issuanceStore: targetStore,
				liveJournalStore: targetJournal,
			} as never)) as unknown as Readonly<Record<string, unknown>>;
		}
		const sourceReadiness = await sourceJournal.readiness({
			scope: Object.freeze({ anchorDigest: source.anchorDigest, epoch: 0, objectId: sourceObjectId }),
		});
		if (!sourceReadiness.ok || !sourceReadiness.ready) {
			throw new TypeError("Phase 3h cross-object source journal is not ready");
		}

		return Object.freeze({
			activationVertexDigest: lowerHex(activation.envelope.digest),
			completion,
			rebaseOutboxes: Object.freeze(rebaseOutboxes),
			recovery,
			reopenRecovery,
			sourceDigests: Object.freeze([
				lowerHex(outsidePublished.envelope.digest),
				lowerHex(outsidePending.envelope.digest),
			]),
			sourceJournalRowCount: sourceReadiness.rowCount,
			sourceObjectId,
			targetObjectId,
			targetPublishedDigests: Object.freeze(targetPublishedDigests),
			targetPublication,
			targetReplacement,
		});
	} finally {
		await sourceJournal?.close();
		await targetJournal?.close();
		await sourceStore?.close();
		await targetStore?.close();
		await Promise.all([source.close(), target.close()]);
		rmSync(directory, { force: true, recursive: true });
	}
}
