import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueScope, SettlementPlan } from "@ts-drp/issuance-store";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import { vi } from "vitest";

import {
	activateV3LivePlane,
	bindV3BlueprintLivePlane,
	recoverV3LiveReplica,
	routeV3Ingress,
	type V3LocalIssueResult,
	type V3PlaneHandle,
} from "../../../packages/node/src/v3-live.js";
import { createNodeDurableIssuanceStore } from "../../../packages/storage-node/src/issuance.js";
import { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/src/live-journal.js";
import { createGenuinePreparedV3Fixture } from "../phase-3a1b-p3/live-fixture.js";
import { fakeNetwork, recover } from "../phase-4b-v3/live-snapshot.js";

export const AUTHOR_FENCE_ACTION = "$drp.author-fence.v1";

export interface OpenSettlementNode {
	readonly blueprint: Extract<ReturnType<typeof bindV3BlueprintLivePlane>, { readonly ok: true }>["handle"];
	close(): Promise<void>;
	readonly fixture: Awaited<ReturnType<typeof createGenuinePreparedV3Fixture>>;
	readonly issuanceStore: DurableIssuanceStore;
	readonly journal: Awaited<ReturnType<typeof recover>>["journal"];
	readonly network: DRPNetworkNode;
	readonly plane: V3PlaneHandle;
	readonly sink: ReturnType<typeof vi.fn>;
	readonly scope: DurableIssueScope;
}

/**
 * Builds one closed deterministic settlement plan.
 * @param scope - Author/object durable scope.
 * @param input - Optional deterministic plan mutations.
 * @returns A closed revision-zero plan.
 */
export function settlementPlan(
	scope: DurableIssueScope,
	input: Readonly<{
		readonly disposition?: "expire" | "manual-review" | "rebase" | "transform";
		readonly empty?: boolean;
		readonly fenceSequence?: number | null;
		readonly sourceSequence?: number;
	}> = {}
): SettlementPlan {
	return Object.freeze({
		entries: Object.freeze(
			input.empty === true
				? []
				: [
						Object.freeze({
							disposition: input.disposition ?? "expire",
							replacementSequence: null,
							sourceDigest: new Uint8Array(32).fill(0xd1),
							sourceSequence: input.sourceSequence ?? 10,
						}),
					]
		),
		fenceSequence: input.fenceSequence ?? null,
		revision: 0,
		scope,
	});
}

/**
 * Writes the fixture plan through the public durable CAS seam.
 * @param store - Durable issuance owner.
 * @param plan - Initial plan to install.
 */
export async function writeSettlementPlan(store: DurableIssuanceStore, plan: SettlementPlan): Promise<void> {
	await store.transactWriteSettlementPlan({ expectedRevision: null, plan, scope: plan.scope });
}

/**
 * Opens an authenticated live Node plane using the selected trust profile.
 * @param profileId - Settlement or compatibility trust profile.
 * @returns Authenticated live plane and durable owners.
 */
export async function openSettlementNode(
	profileId: "creator-trusted-settlement-v1" | "creator-trusted-v1" = "creator-trusted-settlement-v1"
): Promise<OpenSettlementNode> {
	const initialState = encodeCanonical(0);
	const fixture = await createGenuinePreparedV3Fixture({
		authorizationMode: "latched-acl",
		creatorTrustProfileId: profileId,
		exactCanonicalInitialStateBytes: initialState,
		latchedAclVersion: profileId === "creator-trusted-settlement-v1" ? 3 : 1,
	});
	const recovered = await recover(fixture, fixture.capability);
	const network = fakeNetwork(`peer:d110c:f5b0b:${profileId}`);
	const sink = vi.fn();
	const activation = activateV3LivePlane({
		capability: recovered.capability,
		messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
		networkNode: network,
		onAdmittedVertex: sink,
	});
	if (!activation.ok) {
		await fixture.close();
		throw new TypeError(`settlement activation failed: ${activation.kind}`);
	}
	const binding = bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: initialState, plane: activation.handle });
	if (!binding.ok) {
		activation.handle.deactivate();
		await fixture.close();
		throw new TypeError(`settlement blueprint binding failed: ${binding.kind}`);
	}
	return Object.freeze({
		blueprint: binding.handle,
		close: async (): Promise<void> => {
			activation.handle.deactivate();
			await fixture.close();
		},
		fixture,
		issuanceStore: recovered.issuanceStore,
		journal: recovered.journal,
		network,
		plane: activation.handle,
		sink,
		scope: Object.freeze({ author: fixture.author, objectId: fixture.objectId }),
	});
}

export interface RoutedOperationResult {
	readonly claimed: boolean;
	readonly digest: string;
	readonly journalRowsAfter: number;
	readonly journalRowsBefore: number;
}

/**
 * Routes one genuinely signed remote operation through transport and admission.
 * @param node - Active authenticated fixture plane.
 * @param operation - Canonical operation payload.
 * @param authorSequence - Outer author slot.
 * @param logicalTime - Outer logical time.
 * @param anchor - Exact outer anchor digest.
 * @returns Transport claim and durable journal delta.
 */
export async function routeSignedOperation(
	node: OpenSettlementNode,
	operation: Readonly<Record<string, unknown>>,
	authorSequence: number,
	logicalTime = 3,
	anchor = node.fixture.anchorDigest
): Promise<RoutedOperationResult> {
	const bootstrap = await node.issuanceStore.readIssued(node.scope, 0);
	if (bootstrap === null) throw new TypeError("settlement ingress bootstrap is unavailable");
	const preimage = encodeCanonical({
		anchor,
		author: node.fixture.author,
		authorSequence,
		dependencies: [Buffer.from(bootstrap.envelope.digest).toString("hex")],
		epoch: 0,
		kind: "drp-vertex",
		logicalTime,
		objectId: node.fixture.objectId,
		operation,
		protocolMajor: 3,
	});
	const digestBytes = hashDomain("ts-drp/vertex/v3", preimage);
	const signature = await node.fixture.signRegisteredVertexDigest(digestBytes);
	const envelope = V3Envelope.encode({ canonicalPreimage: preimage, signature }).finish();
	const readinessBefore = await node.journal.readiness({
		scope: { anchorDigest: node.fixture.anchorDigest, epoch: 0, objectId: node.fixture.objectId },
	});
	if (!readinessBefore.ok || !readinessBefore.ready) throw new TypeError("settlement ingress journal is unavailable");
	const gossipTopicFor = node.network.gossipTopicFor as ReturnType<typeof vi.fn>;
	gossipTopicFor.mockReturnValue(node.plane.topic);
	const claimed = routeV3Ingress(
		node.network,
		Message.create({
			data: envelope,
			objectId: node.plane.topic,
			sender: "settlement-peer",
			type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
		})
	);
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const readiness = await node.journal.readiness({
			scope: { anchorDigest: node.fixture.anchorDigest, epoch: 0, objectId: node.fixture.objectId },
		});
		if (readiness.ok && readiness.ready && readiness.rowCount !== readinessBefore.rowCount) {
			return Object.freeze({
				claimed,
				digest: Buffer.from(digestBytes).toString("hex"),
				journalRowsAfter: readiness.rowCount,
				journalRowsBefore: readinessBefore.rowCount,
			});
		}
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1));
	}
	const readinessAfter = await node.journal.readiness({
		scope: { anchorDigest: node.fixture.anchorDigest, epoch: 0, objectId: node.fixture.objectId },
	});
	return Object.freeze({
		claimed,
		digest: Buffer.from(digestBytes).toString("hex"),
		journalRowsAfter: readinessAfter.ok && readinessAfter.ready ? readinessAfter.rowCount : -1,
		journalRowsBefore: readinessBefore.rowCount,
	});
}

/**
 * Reopens the same durable issuance and journal truth with a fresh prepared capability.
 * @param node - Previously active settlement fixture.
 * @returns Fresh active handle over the same durable stores.
 */
export async function reopenSettlementNode(node: OpenSettlementNode): Promise<V3PlaneHandle> {
	node.plane.deactivate();
	const prepared = await node.fixture.prepareAgain();
	const recovered = await recoverV3LiveReplica({
		capability: prepared.capability,
		exactCanonicalLatchedAclBytes: node.fixture.exactCanonicalLatchedAclBytes,
		issuanceScope: node.scope,
		issuanceStore: node.issuanceStore,
		liveJournalStore: node.journal,
	} as Parameters<typeof recoverV3LiveReplica>[0]);
	if (!recovered.ok) throw new TypeError(`settlement reopen failed: ${recovered.kind}`);
	const activation = activateV3LivePlane({
		capability: recovered.capability,
		messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
		networkNode: fakeNetwork("peer:d110c:f5b0b:restart"),
		onAdmittedVertex: vi.fn(),
	});
	if (!activation.ok) throw new TypeError(`settlement reactivation failed: ${activation.kind}`);
	const binding = bindV3BlueprintLivePlane({
		exactCanonicalInitialStateBytes: encodeCanonical(0),
		plane: activation.handle,
	});
	if (!binding.ok) throw new TypeError(`settlement rebind failed: ${binding.kind}`);
	return activation.handle;
}

export interface DurableFenceRestartResult {
	readonly fenceSequence?: number | null;
	readonly firstIssue: V3LocalIssueResult;
	readonly lineageNext?: number;
	readonly pendingFenceCount?: number;
	readonly replayedFence?: boolean;
}

/**
 * Crashes after a real SQLite fence transaction and reopens both durable adapters.
 * @returns First issue plus post-reopen durable census when issuance succeeds.
 */
export async function runDurableFenceRestart(): Promise<DurableFenceRestartResult> {
	const directory = mkdtempSync(path.join(tmpdir(), "drp-f5b0b-fence-restart-"));
	const issuanceFilename = path.join(directory, "issuance.sqlite");
	const journalFilename = path.join(directory, "journal.sqlite");
	const fixture = await createGenuinePreparedV3Fixture({
		authorizationMode: "latched-acl",
		creatorTrustProfileId: "creator-trusted-settlement-v1",
		exactCanonicalInitialStateBytes: encodeCanonical(0),
		latchedAclVersion: 3,
	});
	let issuanceStore = createNodeDurableIssuanceStore({ primaryFilename: issuanceFilename });
	let journal = createNodeDurableLiveJournalStore({ primaryFilename: journalFilename });
	let active: V3PlaneHandle | undefined;
	try {
		const scope = Object.freeze({ author: fixture.author, objectId: fixture.objectId });
		const carrier = fixture.createRecoveryVertex(0, [fixture.anchorDigest]);
		await issuanceStore.transactIssue(scope, (authorSequence) => {
			if (authorSequence !== 0) throw new TypeError("durable restart genesis sequence mismatch");
			const envelope = Object.freeze({
				canonicalPreimageBytes: carrier.canonicalPreimageBytes,
				digest: carrier.digest,
				signature: carrier.signature,
			});
			return Promise.resolve(
				Object.freeze({
					authorSequence,
					envelope,
					issuedRecord: Object.freeze({ authorSequence, envelope, scope }),
					outboxEntry: Object.freeze({ authorSequence, envelope, scope }),
				})
			);
		});
		const installed = await journal.installGenesis({
			detachedAnchorSignature: fixture.detachedAnchorSignature,
			exactCanonicalAnchorPreimageBytes: fixture.exactCanonicalAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: fixture.exactCanonicalParametersCarrierBytes,
			objectId: fixture.objectId,
		});
		if (!installed.ok) throw new TypeError(`durable restart journal install failed: ${installed.kind}`);
		const recovered = await recoverV3LiveReplica({
			capability: fixture.capability,
			exactCanonicalLatchedAclBytes: fixture.exactCanonicalLatchedAclBytes,
			issuanceScope: scope,
			issuanceStore,
			liveJournalStore: journal,
		} as Parameters<typeof recoverV3LiveReplica>[0]);
		if (!recovered.ok) throw new TypeError(`durable restart recovery failed: ${recovered.kind}`);
		const activation = activateV3LivePlane({
			capability: recovered.capability,
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode: fakeNetwork("peer:d110c:f5b0b:durable-before-crash"),
			onAdmittedVertex: vi.fn(),
		});
		if (!activation.ok) throw new TypeError(`durable restart activation failed: ${activation.kind}`);
		active = activation.handle;
		const bound = bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: encodeCanonical(0), plane: active });
		if (!bound.ok) throw new TypeError(`durable restart binding failed: ${bound.kind}`);
		await writeSettlementPlan(issuanceStore, settlementPlan(scope, { empty: true }));
		const firstIssue = await active.issueLocal({
			operations: [{ logicalTime: 2, operation: { action: AUTHOR_FENCE_ACTION, fenceSequence: 1, version: 1 } }],
			signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
		});
		if (!firstIssue.ok) return Object.freeze({ firstIssue });
		active.deactivate();
		active = undefined;
		await journal.close();
		await issuanceStore.close();
		issuanceStore = createNodeDurableIssuanceStore({ primaryFilename: issuanceFilename });
		journal = createNodeDurableLiveJournalStore({ primaryFilename: journalFilename });
		const preparedAgain = await fixture.prepareAgain();
		const reopened = await recoverV3LiveReplica({
			capability: preparedAgain.capability,
			exactCanonicalLatchedAclBytes: fixture.exactCanonicalLatchedAclBytes,
			issuanceScope: scope,
			issuanceStore,
			liveJournalStore: journal,
		} as Parameters<typeof recoverV3LiveReplica>[0]);
		if (!reopened.ok) throw new TypeError(`durable restart reopen failed: ${reopened.kind}`);
		const plan = await issuanceStore.readSettlementPlan(scope);
		const lineage = await issuanceStore.readLineage(scope);
		const rows = await issuanceStore.readOutboxPage({ scope });
		return Object.freeze({
			fenceSequence: plan?.fenceSequence,
			firstIssue,
			lineageNext: lineage.next,
			pendingFenceCount: rows.filter((row) => row.commit.planEffect?.kind === "fence" && row.publishState === "pending")
				.length,
			replayedFence: reopened.descriptor.recoveredVertices.some(
				(vertex) => vertex.authorSequence === firstIssue.authorSequence
			),
		});
	} finally {
		active?.deactivate();
		await Promise.allSettled([journal.close(), issuanceStore.close(), fixture.close()]);
		rmSync(directory, { force: true, recursive: true });
	}
}

/**
 * Issues the reserved fence operation through the existing callable local issue seam.
 * @param node - Active settlement fixture.
 * @param logicalTime - Outer logical time.
 * @returns Local issue decision.
 */
export function issueFence(node: OpenSettlementNode, logicalTime = 2): Promise<V3LocalIssueResult> {
	return node.plane.issueLocal({
		operations: Object.freeze([
			Object.freeze({
				logicalTime,
				operation: Object.freeze({ action: AUTHOR_FENCE_ACTION, fenceSequence: 1, version: 1 }),
			}),
		]),
		signRegisteredVertexDigest: node.fixture.signRegisteredVertexDigest,
	});
}

/**
 * Issues one ordinary replacement with the durable source link on the callable local seam.
 * @param node - Active settlement fixture.
 * @param sourceSequence - Durable displaced-source key.
 * @param logicalTime - Outer logical time.
 * @returns Local issue decision.
 */
export function issueReplacement(
	node: OpenSettlementNode,
	sourceSequence = 10,
	logicalTime = 3
): Promise<V3LocalIssueResult> {
	return node.plane.issueLocal({
		operations: Object.freeze([
			Object.freeze({ logicalTime, operation: Object.freeze({ action: "add", value: sourceSequence }) }),
		]),
		planEffect: Object.freeze({ kind: "replacement", sourceSequence }),
		signRegisteredVertexDigest: node.fixture.signRegisteredVertexDigest,
	} as Parameters<V3PlaneHandle["issueLocal"]>[0]);
}

export interface NodeSettlementSourceAudit {
	readonly applicationControlSplit: boolean;
	readonly dedicatedFencePlanEffect: boolean;
	readonly settlementCompletionProfileGate: boolean;
	readonly settlementReaderOwnRows: boolean;
	readonly legacyFenceAdmissionGuard: boolean;
	readonly anchorAgnosticOlderEpochClassification: boolean;
}

/**
 * Static owner audit complements the executable live seam without importing a future export.
 * @returns Presence decisions for the exact Node-owned settlement obligations.
 */
export function auditNodeSettlementSource(): NodeSettlementSourceAudit {
	const source = readFileSync(resolve("packages/node/src/v3-live.ts"), "utf8");
	const settlementReader = /(?:function|const)\s+readSettlementSources\b/u.test(source);
	const fenceIssueZone = source.match(/(?:function|const)\s+issueAuthorFence[\s\S]{0,6000}/u)?.[0] ?? "";
	const completionZone = source.match(/async function completeRebaseSource[\s\S]{0,1800}/u)?.[0] ?? "";
	return Object.freeze({
		anchorAgnosticOlderEpochClassification:
			settlementReader &&
			/authenticated(?:Outbox|Issuance).*row/iu.test(source) &&
			/epoch\s*<\s*(?:current|registration)/u.test(source),
		applicationControlSplit:
			/closeVertices/u.test(source) &&
			/controlVertices/u.test(source) &&
			!/retainApplicationVertex\([\s\S]{0,160}AUTHOR_FENCE_ACTION/u.test(source),
		dedicatedFencePlanEffect:
			fenceIssueZone.includes("readSettlementPlan") &&
			fenceIssueZone.includes("transactIssue") &&
			fenceIssueZone.includes('kind: "fence"'),
		legacyFenceAdmissionGuard: /settlementProfileFor\([^)]*\)[\s\S]{0,500}AUTHOR_FENCE_ACTION/u.test(source),
		settlementCompletionProfileGate:
			completionZone.includes("settlementProfileFor") && completionZone.includes("not-active"),
		settlementReaderOwnRows:
			settlementReader &&
			/terminalThrough/u.test(source) &&
			!/(?:readSettlementSources[\s\S]{0,5000})(?:publishState\s*!==\s*["']pending["']|publishState\s*===\s*["']published["'])/u.test(
				source
			),
	});
}
