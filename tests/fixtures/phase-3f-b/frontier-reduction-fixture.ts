import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "@ts-drp/issuance-store";
import type {
	AppendAcceptedVertexInput,
	DurableLiveJournalStore,
	LiveJournalScope,
	LiveJournalSnapshotToken,
} from "@ts-drp/live-journal";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { type AheDurableStore, parseStorageObjectId, type StorageObjectId } from "@ts-drp/storage";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TrustedBlueprintCatalog } from "../../../packages/blueprint-catalog/src/index.js";
import {
	activateV3LivePlane,
	prepareV3LiveGeneration,
	recoverV3LiveReplica,
	type RecoverV3LiveReplicaResult,
	routeV3Ingress,
	type V3LocalIssueResult,
} from "../../../packages/node/src/v3-live.js";
import { createSqliteAheDurableStore as createBuiltSqliteAheDurableStore } from "../../../packages/storage-node/dist/src/index.js";
import {
	bytesHex,
	contract,
	hexBytes,
	independentHashDomain,
	makeCreatorMaterial,
} from "../phase-3a0-v3/controlled-anchor-trust.js";
import packageGolden from "../track-p2-b/forward-counter-package.json" with { type: "json" };

const PARAMETERS = Object.freeze({
	maxEpochVertices: 8192,
	maxEpochBytes: 8_388_608,
	maxDependencies: 16,
	snapshotChunkBytes: 131_072,
	maxSnapshotBytes: 268_435_456,
	maxPendingEntries: 4096,
	maxPendingBytes: 16_777_216,
});
const ARTIFACT_SOURCE = `function addReducer(input){const value=input.operation.value??1;const state=input.state+value;return {output:state,state}}function causalJoinReducer(input){return {output:null,state:input.state}}function readReducer(input){return {output:input.state,state:input.state}}function setReducer(input){const state=input.operation.value??0;return {output:state,state}}export const blueprint={exportSchemaVersion:1,artifactId:"counter.v1",runtimeProfile:"ecmascript-2024-sync-v1",reducers:{add:addReducer,causalJoin:causalJoinReducer,"read-value":readReducer,set:setReducer}};`;

const createSqliteAheDurableStore = createBuiltSqliteAheDurableStore as unknown as (input: {
	readonly filename: string;
}) => AheDurableStore;

interface PreparedFixture {
	readonly author: string;
	readonly authorPublicKey: Uint8Array;
	readonly capability: object;
	readonly descriptor: Readonly<{
		readonly anchorDigest: string;
		readonly objectId: string;
		readonly parametersDigest: string;
	}>;
	readonly exactCanonicalAuthorAuthorizationBytes: Uint8Array;
	close(): Promise<void>;
}

export interface IssuedVertexFact {
	readonly authorSequence: number;
	readonly dependencies: readonly string[];
	readonly digest: string;
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
}

export interface FrontierScenarioResult {
	readonly admittedDigests: readonly string[];
	readonly initialTips: readonly string[];
	readonly issued: readonly IssuedVertexFact[];
	readonly nestedResult?: V3LocalIssueResult;
	readonly result: V3LocalIssueResult;
	readonly retryResult?: V3LocalIssueResult;
	readonly synchronousReentry: boolean;
}

export interface FrontierScenarioOptions {
	readonly application?: Readonly<{
		readonly catalog: TrustedBlueprintCatalog;
	}>;
	readonly causalJoin?: "admitted" | "altered-abi" | "missing" | "unknown-abi";
	readonly failJournalAtIssuedOrdinal?: number;
	readonly failSignerAtIssuedOrdinal?: number;
	readonly maxDependencies?: number;
	readonly operation?: Readonly<Record<string, unknown>>;
	readonly recoveryOrder?: "forward" | "reverse";
	readonly reenterFromSigner?: boolean;
	readonly retryAfterFailure?: boolean;
	readonly seedOperation?: Readonly<Record<string, unknown>>;
}

export interface DependencyBoundScenarioResult {
	readonly appendedCount: number;
	readonly result: RecoverV3LiveReplicaResult | Readonly<{ readonly ok: true; readonly kind: "routed" }>;
	readonly sinkCount: number;
}

/**
 * Runs genuine preparation against one claimed dependency bound.
 * @param maxDependencies Candidate carrier value.
 * @returns Whether the shipped preparation boundary accepted the carrier.
 */
export async function runParameterCarrierScenario(
	maxDependencies: 1 | 15 | 16 | 17
): Promise<Readonly<{ readonly accepted: boolean }>> {
	try {
		const fixture = await prepareFixture({ maxDependencies });
		await fixture.close();
		return Object.freeze({ accepted: true });
	} catch {
		return Object.freeze({ accepted: false });
	}
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mustObjectId(value: string): StorageObjectId {
	const parsed = parseStorageObjectId(value);
	if (!parsed.ok) throw new TypeError("invalid frontier fixture object id");
	return parsed.value;
}

function network(): DRPNetworkNode {
	const topics = new Set<string>();
	return {
		peerId: "peer:phase-3f-b",
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
		sendMessage: () => Promise.resolve(),
		sendMessageToRandomPeer: () => Promise.resolve(),
		sendGroupMessage: () => Promise.resolve(),
		subscribeToMessageQueue: () => undefined,
		onGroupPeerChange: (): (() => void) => () => undefined,
		publishMessage: () => Promise.resolve(true),
		gossipTopicFor: (): string | undefined => undefined,
	} as unknown as DRPNetworkNode;
}

function commitFor(
	scope: DurableIssueScope,
	authorSequence: number,
	canonicalPreimageBytes: Uint8Array,
	signature: Uint8Array
): DurableIssueCommit {
	const envelope = Object.freeze({
		canonicalPreimageBytes: new Uint8Array(canonicalPreimageBytes),
		digest: hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes),
		signature: new Uint8Array(signature),
	});
	return Object.freeze({
		authorSequence,
		envelope,
		issuedRecord: Object.freeze({ authorSequence, envelope, scope }),
		outboxEntry: Object.freeze({ authorSequence, envelope, scope }),
	});
}

async function prepareFixture(
	options: Readonly<{
		readonly application?: Readonly<{ readonly catalog: TrustedBlueprintCatalog }>;
		readonly causalJoin?: "admitted" | "altered-abi" | "missing" | "unknown-abi";
		readonly maxDependencies?: number;
	}> = {}
): Promise<PreparedFixture> {
	const directory = mkdtempSync(path.join(tmpdir(), "drp-phase-3f-b-"));
	const store = createSqliteAheDurableStore({ filename: path.join(directory, "store.sqlite") });
	try {
		const base = makeCreatorMaterial({ objectId: `creator:${"f".repeat(32)}` });
		const author = bytesHex(ed25519.getPublicKey(hexBytes(contract.privateKeySeedHex)));
		const exactCanonicalAuthorAuthorizationBytes = encodeCanonical({
			authors: [author],
			epoch: 0,
			kind: "drp-author-authorization",
			objectId: base.anchor.objectId,
			profileId: "creator-author-authorization-v1",
			protocolMajor: 3,
			version: 1,
		});
		let blueprintDigest: string;
		let catalog: TrustedBlueprintCatalog;
		if (options.application !== undefined) {
			catalog = options.application.catalog;
			blueprintDigest = String(catalog.blueprintDigests[0] ?? "");
		} else {
			const exactArtifactBytes = new TextEncoder().encode(
				options.causalJoin === "missing"
					? ARTIFACT_SOURCE.replace("causalJoin:causalJoinReducer,", "")
					: ARTIFACT_SOURCE
			);
			const artifactDigest = lowerHex(hashDomain(packageGolden.artifactDigestDomain, exactArtifactBytes));
			const causalJoin = Object.freeze({
				name: "causalJoin",
				argumentSchema:
					options.causalJoin === "unknown-abi"
						? Object.freeze({ kind: "unknown-record", fields: Object.freeze([]) })
						: Object.freeze({
								kind: "closed-record",
								fields: Object.freeze(
									options.causalJoin === "altered-abi"
										? [Object.freeze({ name: "nonce", required: true, type: "safe-integer" })]
										: []
								),
							}),
			});
			const blueprintPackage = Object.freeze({
				...packageGolden.package,
				implementation: Object.freeze({ ...packageGolden.package.implementation, artifactDigest }),
				manifest: Object.freeze({
					...packageGolden.package.manifest,
					operations: Object.freeze(
						options.causalJoin === "missing"
							? [...packageGolden.package.manifest.operations]
							: [
									packageGolden.package.manifest.operations[0],
									causalJoin,
									...packageGolden.package.manifest.operations.slice(1),
								]
					),
				}),
			});
			const canonicalBlueprintPackageBytes = encodeCanonical(blueprintPackage);
			blueprintDigest = lowerHex(hashDomain(packageGolden.blueprintDigestDomain, canonicalBlueprintPackageBytes));
			const resolved = Object.freeze({
				artifactDigest,
				artifactId: blueprintPackage.implementation.artifactId,
				blueprintDigest,
				canonicalBlueprintPackageBytes,
				exactArtifactBytes,
				runtimeProfile: "ecmascript-2024-sync-v1" as const,
				evidence: Object.freeze({
					catalogDigest: "9".repeat(64),
					lintEvidenceDigest: "a".repeat(64),
					conformanceReceiptDigest: "b".repeat(64),
					conformanceDigest: "c".repeat(64),
					conformanceTier: "nightly" as const,
					conformanceResult: "passed" as const,
					engines: Object.freeze([
						Object.freeze({ name: "node" as const, build: "phase-3f-b" }),
						Object.freeze({ name: "chromium" as const, build: "phase-3f-b" }),
						Object.freeze({ name: "firefox" as const, build: "phase-3f-b" }),
						Object.freeze({ name: "webkit" as const, build: "phase-3f-b" }),
					]),
				}),
			});
			catalog = Object.freeze({
				blueprintDigests: Object.freeze([blueprintDigest]),
				catalogDigest: "9".repeat(64),
				resolve(requested: string) {
					if (requested !== blueprintDigest) throw new TypeError("unknown frontier blueprint");
					return resolved;
				},
			});
		}
		const parametersBytes = encodeCanonical(
			options.maxDependencies === undefined
				? PARAMETERS
				: Object.freeze({ ...PARAMETERS, maxDependencies: options.maxDependencies })
		);
		const anchor = Object.freeze({
			...base.anchor,
			objectId: String(base.anchor.objectId),
			aclDigest: lowerHex(hashDomain("ts-drp/author-authorization/v3", exactCanonicalAuthorAuthorizationBytes)),
			blueprintDigest,
			parametersDigest: lowerHex(hashDomain("ts-drp/parameters/v3", parametersBytes)),
		});
		const anchorBytes = encodeCanonical(anchor);
		const anchorDigest = bytesHex(independentHashDomain(contract.anchorDigestDomain, anchorBytes));
		const signature = ed25519.sign(hexBytes(anchorDigest), hexBytes(contract.privateKeySeedHex));
		const objectId = mustObjectId(String(anchor.objectId));
		const trust = createCurrentAnchorTrustStore({ objectId, pinnedGenesisAnchorDigest: anchorDigest, store });
		const installed = await trust.install({
			detachedGenesisSignature: signature,
			exactCanonicalGenesisAnchorPreimageBytes: anchorBytes,
			exactCanonicalProfileBytes: base.profileBytes,
			exactCanonicalSignerSetBytes: base.signerSetBytes,
			pinnedGenesisAnchorDigest: anchorDigest,
		});
		if (!installed.ok) throw new TypeError("frontier trust install failed");
		const prepared = await prepareV3LiveGeneration({
			authenticationProfile: "creator-only",
			store,
			objectId,
			pinnedGenesisAnchorDigest: anchorDigest,
			exactCanonicalAnchorPreimageBytes: anchorBytes,
			detachedSignature: signature,
			exactCanonicalParametersCarrierBytes: parametersBytes,
			catalog,
		});
		if (!prepared.ok)
			throw new TypeError(`frontier preparation failed: ${"kind" in prepared ? prepared.kind : "unknown"}`);
		return Object.freeze({
			author,
			authorPublicKey: ed25519.getPublicKey(hexBytes(contract.privateKeySeedHex)),
			capability: prepared.capability,
			descriptor: prepared.descriptor,
			exactCanonicalAuthorAuthorizationBytes,
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

function vertexBytes(
	fixture: PreparedFixture,
	authorSequence: number,
	dependencies: readonly string[],
	operation: Readonly<Record<string, unknown>>
): Uint8Array {
	return encodeCanonical({
		anchor: fixture.descriptor.anchorDigest,
		author: fixture.author,
		authorSequence,
		dependencies: [...dependencies],
		epoch: 0,
		kind: "drp-vertex",
		logicalTime: authorSequence + 1,
		objectId: fixture.descriptor.objectId,
		operation,
		protocolMajor: 3,
	});
}

function journalScopeFor(fixture: PreparedFixture): LiveJournalScope {
	return Object.freeze({
		anchorDigest: fixture.descriptor.anchorDigest,
		epoch: 0,
		objectId: fixture.descriptor.objectId,
	});
}

function journalSnapshot(fixture: PreparedFixture, scope: LiveJournalScope): LiveJournalSnapshotToken {
	return Object.freeze({
		kind: "v3-live-journal-snapshot-token-1" as const,
		scope,
		highWatermark: 0,
		genesisDigest: "1".repeat(64),
		parametersDigest: fixture.descriptor.parametersDigest,
		orderedRowDigest: "2".repeat(64),
		snapshotDigest: "3".repeat(64),
	});
}

function siblingCommits(
	fixture: PreparedFixture,
	width: number,
	operation: Readonly<Record<string, unknown>> = Object.freeze({ action: "add", value: 1 })
): {
	readonly commits: DurableIssueCommit[];
	readonly initialTips: string[];
	readonly scope: DurableIssueScope;
} {
	const scope = Object.freeze({ author: fixture.author, objectId: fixture.descriptor.objectId });
	const commits: DurableIssueCommit[] = [];
	const initialTips: string[] = [];
	for (let sequence = 0; sequence < width; sequence += 1) {
		const bytes = vertexBytes(fixture, sequence, [fixture.descriptor.anchorDigest], operation);
		const digest = hashDomain("ts-drp/vertex/v3", bytes);
		initialTips.push(lowerHex(digest));
		commits.push(commitFor(scope, sequence, bytes, ed25519.sign(digest, hexBytes(contract.privateKeySeedHex))));
	}
	return { commits, initialTips, scope };
}

function recoveryIssuanceStore(commits: readonly DurableIssueCommit[], scope: DurableIssueScope): DurableIssuanceStore {
	return {
		transactIssue: () => Promise.reject(new Error("dependency-bound recovery must not issue")),
		compareAndMarkOutboxPublished: () => Promise.resolve(),
		readIssued: (selectedScope, sequence) =>
			Promise.resolve(
				selectedScope.author === scope.author && selectedScope.objectId === scope.objectId
					? (commits[sequence] ?? null)
					: null
			),
		readOutboxPage(input = {}): Promise<readonly DurableIssuanceOutboxRecord[]> {
			const next = input.afterKey == null ? 0 : input.afterKey[2] + 1;
			const commit = commits[next];
			return Promise.resolve(
				commit === undefined
					? Object.freeze([])
					: Object.freeze([Object.freeze({ commit, publishState: "published" as const })])
			);
		},
		readLineage: () => Promise.resolve(Object.freeze({ exhausted: false, next: commits.length })),
		close: () => Promise.resolve(),
	};
}

/**
 * Exercises the authenticated dependency bound at local recovery, received
 * recovery, or live received admission without forging a recovered payload.
 * @param width - Dependency count on the final genuine vertex.
 * @param source - Genuine node boundary under test.
 * @returns Recovery/routing outcome plus journal and sink effects.
 */
export async function runDependencyBoundScenario(
	width: 16 | 17,
	source: "recovered-local" | "recovered-received" | "live-received"
): Promise<DependencyBoundScenarioResult> {
	const fixture = await prepareFixture();
	try {
		const { commits, initialTips, scope } = siblingCommits(fixture, width);
		const wideBytes = vertexBytes(fixture, width, [...initialTips].sort(), { action: "add", value: 7 });
		const wideDigest = hashDomain("ts-drp/vertex/v3", wideBytes);
		const wideCommit = commitFor(
			scope,
			width,
			wideBytes,
			ed25519.sign(wideDigest, hexBytes(contract.privateKeySeedHex))
		);
		const journalScope = journalScopeFor(fixture);
		const snapshot = journalSnapshot(fixture, journalScope);
		let appendedCount = 0;
		let sinkCount = 0;
		const receivedRows = [...commits, wideCommit].map((commit, journalSequence) =>
			Object.freeze({
				detachedSignature: commit.envelope.signature,
				exactCanonicalPreimageBytes: commit.envelope.canonicalPreimageBytes,
				journalSequence,
				scope: journalScope,
				sourceKind: "received" as const,
				vertexDigest: lowerHex(commit.envelope.digest),
			})
		);
		const recoveryRows = source === "recovered-received" ? receivedRows : [];
		const journalStore: DurableLiveJournalStore = {
			installGenesis: () =>
				Promise.resolve(
					Object.freeze({
						ok: true as const,
						scope: journalScope,
						parametersDigest: fixture.descriptor.parametersDigest,
						idempotent: false,
					})
				),
			readiness: () =>
				Promise.resolve(
					Object.freeze({
						ok: true as const,
						ready: true as const,
						scope: journalScope,
						snapshot,
						rowCount: recoveryRows.length,
					})
				),
			readPage(input) {
				const index = input.afterSequence == null ? 0 : input.afterSequence + 1;
				const row = recoveryRows[index];
				return Promise.resolve(
					Object.freeze({
						ok: true as const,
						scope: journalScope,
						snapshot,
						rows: row === undefined ? Object.freeze([]) : Object.freeze([row]),
						nextSequence: row !== undefined && index + 1 < recoveryRows.length ? index : null,
					})
				);
			},
			appendAccepted(input) {
				const journalSequence = appendedCount++;
				return Promise.resolve(
					Object.freeze({
						ok: true as const,
						scope: input.scope,
						journalSequence,
						vertexDigest: input.vertexDigest,
						sourceKind: input.sourceKind,
						idempotent: false,
					})
				);
			},
			close: () => Promise.resolve(),
		};
		const recoveryCommits =
			source === "recovered-received"
				? Object.freeze([])
				: source === "live-received"
					? Object.freeze([...commits])
					: Object.freeze([...commits, wideCommit]);
		const recovered = await recoverV3LiveReplica({
			capability: fixture.capability as never,
			exactCanonicalAuthorAuthorizationBytes: fixture.exactCanonicalAuthorAuthorizationBytes,
			issuanceScope: scope,
			issuanceStore: recoveryIssuanceStore(recoveryCommits, scope),
			liveJournalStore: journalStore,
		});
		if (source !== "live-received" || !recovered.ok) {
			return Object.freeze({ appendedCount, result: recovered, sinkCount });
		}
		const boundNetwork = network();
		const activated = activateV3LivePlane({
			capability: recovered.capability,
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode: boundNetwork,
			onAdmittedVertex: () => {
				sinkCount += 1;
			},
		});
		if (!activated.ok) throw new TypeError(`dependency-bound activation failed: ${activated.kind}`);
		let ingressTopicChecks = 0;
		let resolveIngressTurn = (): void => undefined;
		const ingressTurn = new Promise<void>((resolve) => {
			resolveIngressTurn = resolve;
		});
		Reflect.set(boundNetwork, "gossipTopicFor", () => {
			ingressTopicChecks += 1;
			if (ingressTopicChecks === 2) setTimeout(resolveIngressTurn, 0);
			return activated.handle.topic;
		});
		const routed = routeV3Ingress(
			boundNetwork,
			Message.create({
				data: V3Envelope.encode({
					canonicalPreimage: wideCommit.envelope.canonicalPreimageBytes,
					signature: wideCommit.envelope.signature,
				}).finish(),
				objectId: activated.handle.topic,
				sender: "peer:dependency-bound",
				type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
			})
		);
		if (!routed) throw new TypeError("dependency-bound ingress was not routed");
		await ingressTurn;
		if (ingressTopicChecks !== 2) throw new TypeError("dependency-bound ingress was not revalidated");
		activated.handle.deactivate();
		return Object.freeze({
			appendedCount,
			result: Object.freeze({ ok: true as const, kind: "routed" as const }),
			sinkCount,
		});
	} finally {
		await fixture.close();
	}
}

/**
 * Runs one genuine recovered wide-frontier local issue through the shipped node.
 * @param width - Number of anchor-sibling tips installed before local issue.
 * @param options - Optional synchronous signer reentry probe.
 * @returns Genuine issued vertex facts and node results.
 */
export async function runFrontierScenario(
	width: number,
	options: FrontierScenarioOptions = {}
): Promise<FrontierScenarioResult> {
	const fixture = await prepareFixture(options);
	try {
		const { commits, initialTips, scope } = siblingCommits(fixture, width, options.seedOperation);
		let recoveryComplete = false;
		const issuanceStore: DurableIssuanceStore = {
			async transactIssue(selectedScope, buildAndSign) {
				if (selectedScope.author !== scope.author || selectedScope.objectId !== scope.objectId) {
					throw new TypeError("frontier issuance scope changed");
				}
				const selectedSequence = commits.length;
				const commit = await buildAndSign(selectedSequence);
				if (commits.length !== selectedSequence) throw new Error("frontier issuance lineage changed during signing");
				commits.push(commit);
				return commit;
			},
			compareAndMarkOutboxPublished: () => Promise.resolve(),
			readIssued: (_selectedScope, sequence) => Promise.resolve(commits[sequence] ?? null),
			readOutboxPage(input = {}) {
				if (options.recoveryOrder === "reverse" && !recoveryComplete) {
					return Promise.resolve(Object.freeze([]));
				}
				const next = input.afterKey == null ? 0 : input.afterKey[2] + 1;
				const commit = commits[next];
				return Promise.resolve(
					commit === undefined
						? Object.freeze([])
						: Object.freeze([Object.freeze({ commit, publishState: next < width ? "published" : "pending" })])
				);
			},
			readLineage: () => Promise.resolve(Object.freeze({ exhausted: false, next: commits.length })),
			close: () => Promise.resolve(),
		};
		const journalScope = journalScopeFor(fixture);
		const recoveryRows =
			options.recoveryOrder === "reverse"
				? Object.freeze(
						[...commits].reverse().map((commit, rowSequence) =>
							Object.freeze({
								detachedSignature: commit.envelope.signature,
								exactCanonicalPreimageBytes: commit.envelope.canonicalPreimageBytes,
								journalSequence: rowSequence,
								scope: journalScope,
								sourceKind: "received" as const,
								vertexDigest: lowerHex(commit.envelope.digest),
							})
						)
					)
				: Object.freeze([]);
		const snapshot = journalSnapshot(fixture, journalScope);
		let journalSequence = recoveryRows.length;
		const journalStore: DurableLiveJournalStore = {
			installGenesis: () =>
				Promise.resolve(
					Object.freeze({
						ok: true as const,
						scope: journalScope,
						parametersDigest: fixture.descriptor.parametersDigest,
						idempotent: false,
					})
				),
			readiness: () =>
				Promise.resolve(
					Object.freeze({
						ok: true as const,
						ready: true as const,
						rowCount: recoveryRows.length,
						scope: journalScope,
						snapshot,
					})
				),
			readPage(input) {
				const next = input.afterSequence == null ? 0 : input.afterSequence + 1;
				const row = recoveryRows[next];
				return Promise.resolve(
					Object.freeze({
						nextSequence: row !== undefined && next + 1 < recoveryRows.length ? next : null,
						ok: true as const,
						rows: row === undefined ? Object.freeze([]) : Object.freeze([row]),
						scope: journalScope,
						snapshot,
					})
				);
			},
			appendAccepted(input: AppendAcceptedVertexInput) {
				const current = journalSequence++;
				if (options.failJournalAtIssuedOrdinal === current - width) {
					return Promise.reject(new Error("controlled frontier journal failure"));
				}
				return Promise.resolve(
					Object.freeze({
						ok: true as const,
						scope: input.scope,
						journalSequence: current,
						vertexDigest: input.vertexDigest,
						sourceKind: input.sourceKind,
						idempotent: false,
					})
				);
			},
			close: () => Promise.resolve(),
		};
		const recovered = await recoverV3LiveReplica({
			capability: fixture.capability as never,
			exactCanonicalAuthorAuthorizationBytes: fixture.exactCanonicalAuthorAuthorizationBytes,
			issuanceScope: scope,
			issuanceStore,
			liveJournalStore: journalStore,
		});
		if (!recovered.ok) throw new TypeError(`frontier recovery failed: ${recovered.kind}`);
		recoveryComplete = true;
		const admittedDigests: string[] = [];
		const activated = activateV3LivePlane({
			capability: recovered.capability,
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode: network(),
			onAdmittedVertex: ({ vertex }) => {
				admittedDigests.push(lowerHex(vertex.digest));
			},
		});
		if (!activated.ok) throw new TypeError(`frontier activation failed: ${activated.kind}`);
		let signerActive = false;
		let synchronousReentry = false;
		let nestedResultPromise: Promise<V3LocalIssueResult> | undefined;
		const failedSignerOrdinals = new Set<number>();
		const nestedSigner = (digest: Uint8Array): Promise<Uint8Array> => {
			if (signerActive) synchronousReentry = true;
			return Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(contract.privateKeySeedHex)));
		};
		const result = await activated.handle.issueLocal({
			logicalTime: width + 1,
			operation: options.operation ?? Object.freeze({ action: "add", value: 7 }),
			signRegisteredVertexDigest: (digest: Uint8Array) => {
				const issuedOrdinal = commits.length - width;
				if (options.failSignerAtIssuedOrdinal === issuedOrdinal && !failedSignerOrdinals.has(issuedOrdinal)) {
					failedSignerOrdinals.add(issuedOrdinal);
					return Promise.reject(new Error("controlled frontier signer failure"));
				}
				signerActive = true;
				if (options.reenterFromSigner === true && nestedResultPromise === undefined) {
					const nestedOperation = { action: "add", value: 9 };
					nestedResultPromise = activated.handle.issueLocal({
						logicalTime: width + 2,
						operation: nestedOperation,
						signRegisteredVertexDigest: nestedSigner,
					} as never);
					nestedOperation.value = 999;
				}
				const signature = ed25519.sign(new Uint8Array(digest), hexBytes(contract.privateKeySeedHex));
				signerActive = false;
				return Promise.resolve(signature);
			},
		} as never);
		const nestedResult = await nestedResultPromise;
		const retryResult =
			options.retryAfterFailure === true && !result.ok
				? await activated.handle.issueLocal({
						logicalTime: width + 3,
						operation: options.operation ?? Object.freeze({ action: "add", value: 7 }),
						signRegisteredVertexDigest: (digest: Uint8Array) =>
							Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(contract.privateKeySeedHex))),
					} as never)
				: undefined;
		activated.handle.deactivate();
		const issued = commits.slice(width).map((commit) => {
			const decoded = decodeCanonical(commit.envelope.canonicalPreimageBytes);
			if (decoded === null || typeof decoded !== "object") throw new TypeError("invalid issued frontier vertex");
			return Object.freeze({
				authorSequence: commit.authorSequence,
				dependencies: Object.freeze([...(Reflect.get(decoded, "dependencies") as string[])]),
				digest: lowerHex(commit.envelope.digest),
				logicalTime: Reflect.get(decoded, "logicalTime") as number,
				operation: Object.freeze({ ...(Reflect.get(decoded, "operation") as Record<string, unknown>) }),
			});
		});
		return Object.freeze({
			admittedDigests: Object.freeze(admittedDigests),
			initialTips: Object.freeze(initialTips.sort()),
			issued: Object.freeze(issued),
			nestedResult,
			result,
			retryResult,
			synchronousReentry,
		});
	} finally {
		await fixture.close();
	}
}
