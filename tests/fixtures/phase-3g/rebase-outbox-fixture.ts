import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import type { DurableIssuanceOutboxRecord, DurableIssuanceStore, DurableIssueCommit } from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { type AheDurableStore, parseStorageObjectId, type StorageObjectId } from "@ts-drp/storage";
import { type DRPNetworkNode, type Message, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	activateV3LivePlane,
	type PreparedV3Live,
	prepareV3LiveGeneration,
	recoverV3LiveReplica,
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
	| "batch-2"
	| "batch-16"
	| "malformed-batch"
	| "mixed-control-batch"
	| "nested-batch"
	| "over-limit-batch"
	| "singleton";

interface PreparedPlane {
	readonly anchorDigest: string;
	readonly author: string;
	readonly authorizationBytes: Uint8Array;
	readonly capability: PreparedV3Live;
	readonly detachedAnchorSignature: Uint8Array;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly journalFilename: string;
	readonly objectId: string;
	readonly parametersDigest: string;
	readonly privateKeySeedHex: string;
	prepareAgain(detachedSignature?: Uint8Array): Promise<PreparedV3Live | undefined>;
	close(): Promise<void>;
}

export interface SharedPlaneScenarioOptions {
	readonly omitTargetBootstrap?: boolean;
	readonly omitSourceAuthority?: boolean;
	readonly reopenTarget?: boolean;
	readonly sourceAuthorityMutation?:
		| "acl-context"
		| "authorization-bytes"
		| "blueprint-context"
		| "creator-context"
		| "object-context"
		| "target-capability";
	readonly sourceCreatorSignatureCorrupt?: boolean;
	readonly sourceOperationProfile?: SourceOperationProfile;
	readonly targetAuthorityMutation?: "authorization-bytes" | "source-capability";
	readonly targetReplacementAfterRecoveryBeforeRead?: boolean;
	readonly twoSourceRows?: boolean;
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
	readonly rebaseOutbox?: unknown;
	readonly rebaseOutboxes: readonly unknown[];
	readonly recovery: Readonly<Record<string, unknown>>;
	readonly reopenRecovery?: Readonly<Record<string, unknown>>;
	readonly sourceAnchor: string;
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

async function preparePlane(
	objectIdValue: string,
	stateDigest: string,
	label: string,
	options: Readonly<{
		readonly authorizationAuthors?: readonly string[];
		readonly blueprintVariant?: string;
		readonly privateKeySeedHex?: string;
	}> = {}
): Promise<PreparedPlane> {
	const directory = mkdtempSync(path.join(tmpdir(), `drp-phase-3g-${label}-`));
	const store: AheDurableStore = createSqliteAheDurableStore({ filename: path.join(directory, "trust.sqlite") });
	try {
		const selectedCatalog = counterBatchCatalog(options.blueprintVariant);
		const privateKeySeedHex = options.privateKeySeedHex ?? contract.privateKeySeedHex;
		const base = makeCreatorMaterial({ objectId: objectIdValue, privateKeySeedHex });
		const author = bytesHex(ed25519.getPublicKey(hexBytes(privateKeySeedHex)));
		const authorizationBytes = encodeCanonical({
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
			aclDigest: lowerHex(hashDomain("ts-drp/author-authorization/v3", authorizationBytes)),
			blueprintDigest: selectedCatalog.blueprintDigest,
			objectId: objectIdValue,
			parametersDigest: lowerHex(hashDomain("ts-drp/parameters/v3", parameterBytes)),
			stateDigest,
		});
		const anchorBytes = encodeCanonical(anchor);
		const anchorDigest = bytesHex(independentHashDomain(contract.anchorDigestDomain, anchorBytes));
		const detachedAnchorSignature = ed25519.sign(hexBytes(anchorDigest), hexBytes(privateKeySeedHex));
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
	logicalTime = authorSequence * 2 + 1
): DurableIssueCommit {
	const scope = Object.freeze({ author: plane.author, objectId: plane.objectId });
	const canonicalPreimageBytes = encodeCanonical({
		anchor: plane.anchorDigest,
		author: plane.author,
		authorSequence,
		dependencies: [plane.anchorDigest],
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
		signature: ed25519.sign(digest, hexBytes(plane.privateKeySeedHex)),
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
		profile === "mixed-control-batch" ||
		profile === "nested-batch" ||
		profile === "over-limit-batch"
	);
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

function network(label: string, published: string[]): DRPNetworkNode {
	const topics = new Set<string>();
	return {
		peerId: `peer:phase-3g:${label}`,
		getMultiaddrs: () => ["/ip4/127.0.0.1/tcp/1"],
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
	const source = await preparePlane(objectId, "7".repeat(64), "source");
	const target = await preparePlane(objectId, "8".repeat(64), "target");
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
		await sourceStore.transactIssue(scope, (authorSequence) =>
			Promise.resolve(commitFor(source, authorSequence, Object.freeze({ action: "add", value: 0 })))
		);
		sourceJournal = await installJournal(source);
		const sourceRecovery = await recoverV3LiveReplica({
			capability: source.capability,
			exactCanonicalAuthorAuthorizationBytes: source.authorizationBytes,
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
		const operations = sourceOperations(profile);
		let sourceIssue: SharedPlaneScenarioResult["sourceIssue"];
		let sourceCommit: DurableIssueCommit;
		const sourceCommits: DurableIssueCommit[] = [];
		if (isHostileProfile(profile)) {
			const hostile = batchOperation(operations);
			sourceCommit = await sourceStore.transactIssue(scope, (authorSequence) =>
				Promise.resolve(commitFor(source, authorSequence, hostile, operations[0]?.logicalTime ?? 3))
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
		let targetReplacement: DurableIssueCommit | undefined;
		targetJournal = await installJournal(target);
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
							exactCanonicalAuthorAuthorizationBytes: sourceAuthorization,
						}),
					}),
			exactCanonicalAuthorAuthorizationBytes: targetAuthorization,
			issuanceScope: scope,
			issuanceStore: targetStore,
			liveJournalStore: targetJournal,
		} as never)) as unknown as Readonly<Record<string, unknown>>;
		let rebaseOutbox: unknown;
		const rebaseOutboxes: unknown[] = [];
		let completion: unknown;
		let publication: unknown;
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
							exactCanonicalAuthorAuthorizationBytes: source.authorizationBytes,
						}),
						exactCanonicalAuthorAuthorizationBytes: target.authorizationBytes,
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
						exactCanonicalAuthorAuthorizationBytes: source.authorizationBytes,
					}),
					exactCanonicalAuthorAuthorizationBytes: target.authorizationBytes,
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
				rebaseOutbox,
				rebaseOutboxes: Object.freeze(rebaseOutboxes),
				recovery,
				reopenRecovery,
				sourceAnchor: source.anchorDigest,
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
