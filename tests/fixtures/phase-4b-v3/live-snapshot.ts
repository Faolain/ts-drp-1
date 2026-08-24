import type {
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore, LiveJournalAcceptedRow, LiveJournalScope } from "@ts-drp/live-journal";
import type { DRPNetworkNode } from "@ts-drp/types";
import { vi } from "vitest";

import { type PreparedV3Live, type RecoveredV3Live, recoverV3LiveReplica } from "../../../packages/node/src/v3-live.js";
import { type GenuinePreparedV3Fixture } from "../phase-3a1b-p3/live-fixture.js";

/**
 * Builds the same in-memory network used by the Phase 4a live-fold owner.
 * @param peerId - Distinct peer identity for this recovered replica.
 * @returns A network node with recorded topic membership.
 */
export function fakeNetwork(peerId: string): DRPNetworkNode {
	const topics = new Set<string>();
	return {
		peerId,
		membershipVerifier: undefined,
		start: vi.fn(() => Promise.resolve()),
		stop: vi.fn(() => Promise.resolve()),
		restart: vi.fn(() => Promise.resolve()),
		isDialable: vi.fn(() => Promise.resolve(true)),
		changeTopicScoreParams: vi.fn(),
		removeTopicScoreParams: vi.fn(),
		subscribe: vi.fn((topic: string) => topics.add(topic)),
		unsubscribe: vi.fn((topic: string) => topics.delete(topic)),
		connectToBootstraps: vi.fn(() => Promise.resolve()),
		connect: vi.fn(() => Promise.resolve()),
		disconnect: vi.fn(() => Promise.resolve()),
		getPeerMultiaddrs: vi.fn(() => Promise.resolve([])),
		getBootstrapNodes: vi.fn(() => []),
		getSubscribedTopics: vi.fn(() => [...topics]),
		getMultiaddrs: vi.fn(() => ["/ip4/127.0.0.1/tcp/1"]),
		getAllPeers: vi.fn(() => []),
		getGroupPeers: vi.fn(() => []),
		broadcastMessage: vi.fn(() => Promise.resolve()),
		publishMessage: vi.fn(() => Promise.resolve(true)),
		sendMessage: vi.fn(() => Promise.resolve()),
		sendMessageToRandomPeer: vi.fn(() => Promise.resolve()),
		sendGroupMessage: vi.fn(() => Promise.resolve()),
		subscribeToMessageQueue: vi.fn(),
		onGroupPeerChange: vi.fn((): (() => void) => () => undefined),
		gossipTopicFor: vi.fn(() => undefined),
	} as unknown as DRPNetworkNode;
}

function journalStore(fixture: GenuinePreparedV3Fixture): DurableLiveJournalStore {
	const scope: LiveJournalScope = Object.freeze({
		anchorDigest: fixture.anchorDigest,
		epoch: 0,
		objectId: fixture.objectId,
	});
	const rows: LiveJournalAcceptedRow[] = [];
	const snapshot = Object.freeze({
		genesisDigest: "1".repeat(64),
		highWatermark: 0,
		kind: "v3-live-journal-snapshot-token-1" as const,
		orderedRowDigest: "2".repeat(64),
		parametersDigest: fixture.descriptor.parametersDigest,
		scope,
		snapshotDigest: "3".repeat(64),
	});
	return Object.freeze({
		appendAccepted: vi.fn((input) => {
			const existing = rows.find((row) => row.vertexDigest === input.vertexDigest);
			if (existing !== undefined) {
				return Promise.resolve(
					Object.freeze({
						idempotent: true,
						journalSequence: existing.journalSequence,
						ok: true as const,
						scope,
						sourceKind: existing.sourceKind,
						vertexDigest: existing.vertexDigest,
					})
				);
			}
			return Promise.resolve(
				Object.freeze({
					idempotent: false,
					journalSequence: rows.length,
					ok: true as const,
					scope,
					sourceKind: input.sourceKind,
					vertexDigest: input.vertexDigest,
				})
			);
		}),
		close: vi.fn(() => Promise.resolve()),
		installGenesis: vi.fn(() =>
			Promise.resolve(
				Object.freeze({
					idempotent: false,
					ok: true as const,
					parametersDigest: fixture.descriptor.parametersDigest,
					scope,
				})
			)
		),
		readiness: vi.fn(() =>
			Promise.resolve(
				Object.freeze({ ok: true as const, ready: true as const, rowCount: rows.length, scope, snapshot })
			)
		),
		readPage: vi.fn(() =>
			Promise.resolve(
				Object.freeze({ nextSequence: null, ok: true as const, rows: Object.freeze([]), scope, snapshot })
			)
		),
	});
}

function recoveryStore(fixture: GenuinePreparedV3Fixture): DurableIssuanceStore {
	const scope: DurableIssueScope = Object.freeze({ author: fixture.author, objectId: fixture.objectId });
	const carrier = fixture.createRecoveryVertex(0, [fixture.anchorDigest]);
	const envelope = Object.freeze({
		canonicalPreimageBytes: new Uint8Array(carrier.canonicalPreimageBytes),
		digest: new Uint8Array(carrier.digest),
		signature: new Uint8Array(carrier.signature),
	});
	const commit: DurableIssueCommit = Object.freeze({
		authorSequence: 0,
		envelope,
		issuedRecord: Object.freeze({ authorSequence: 0, envelope, scope }),
		outboxEntry: Object.freeze({ authorSequence: 0, envelope, scope }),
	});
	const outbox: DurableIssuanceOutboxRecord = Object.freeze({ commit, publishState: "published" });
	let nextAuthorSequence = 1;
	return Object.freeze({
		close: vi.fn(() => Promise.resolve()),
		compareAndMarkOutboxPublished: vi.fn(() => Promise.resolve()),
		readIssued: vi.fn((selectedScope, sequence) =>
			Promise.resolve(
				selectedScope.author === scope.author && selectedScope.objectId === scope.objectId && sequence === 0
					? commit
					: null
			)
		),
		readLineage: vi.fn(() => Promise.resolve({ exhausted: false, next: 1 })),
		readOutboxPage: vi.fn((input = {}) =>
			Promise.resolve(input.afterKey == null ? Object.freeze([outbox]) : Object.freeze([]))
		),
		transactIssue: vi.fn(async (selectedScope, buildAndSign) => {
			if (selectedScope.author !== scope.author || selectedScope.objectId !== scope.objectId) {
				throw new TypeError("issuance scope mismatch");
			}
			const issued = await buildAndSign(nextAuthorSequence);
			nextAuthorSequence += 1;
			return issued;
		}),
	});
}

/**
 * Recovers one genuine prepared capability through the shipped replica path.
 * @param fixture - Authenticated live fixture that minted the capability.
 * @param capability - One-use prepared capability to recover.
 * @returns The recovered capability and the stores that authenticated it.
 */
export async function recover(
	fixture: GenuinePreparedV3Fixture,
	capability: PreparedV3Live
): Promise<
	Readonly<{ capability: RecoveredV3Live; issuanceStore: DurableIssuanceStore; journal: DurableLiveJournalStore }>
> {
	const issuanceStore = recoveryStore(fixture);
	const journal = journalStore(fixture);
	const result = await recoverV3LiveReplica({
		capability,
		...(fixture.exactCanonicalLatchedAclBytes === undefined
			? { exactCanonicalAuthorAuthorizationBytes: fixture.exactCanonicalAuthorAuthorizationBytes }
			: { exactCanonicalLatchedAclBytes: fixture.exactCanonicalLatchedAclBytes }),
		issuanceScope: Object.freeze({ author: fixture.author, objectId: fixture.objectId }),
		issuanceStore,
		liveJournalStore: journal,
	});
	if (!result.ok) throw new TypeError(`recovery failed: ${result.kind}`);
	return Object.freeze({ capability: result.capability, issuanceStore, journal });
}

export type { GenuinePreparedV3Fixture, RecoveredV3Live };
