import { encodeCanonical } from "@ts-drp/canonical";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore, LiveJournalAcceptedRow, LiveJournalScope } from "@ts-drp/live-journal";
import { MessageQueueManager } from "@ts-drp/message-queue";
import type { DRPNetworkNode, Message } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import {
	createGenuinePreparedV3Fixture,
	type GenuinePreparedV3Fixture,
} from "./fixtures/phase-3a1b-p3/live-fixture.js";
import {
	activateV3LivePlane,
	bindV3BlueprintLivePlane,
	type PreparedV3Live,
	type RecoveredV3Live,
	recoverV3LiveReplica,
} from "../packages/node/src/v3-live.js";

function fakeNetwork(peerId: string): DRPNetworkNode {
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

async function recover(
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

describe("Phase 4a live blueprint fold", () => {
	it("binds signed genesis and converges two independent recovered peers", async () => {
		const initialStateBytes = encodeCanonical(0);
		const fixture = await createGenuinePreparedV3Fixture({
			authorizationMode: "latched-acl",
			exactCanonicalInitialStateBytes: initialStateBytes,
		});
		try {
			const secondPrepared = await fixture.prepareAgain();
			const stalePrepared = await fixture.prepareAgain();
			const recovered = await Promise.all([
				recover(fixture, fixture.capability),
				recover(fixture, secondPrepared.capability),
				recover(fixture, stalePrepared.capability),
			]);
			const activations = recovered.map((entry, index) =>
				activateV3LivePlane({
					capability: entry.capability,
					messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
					networkNode: fakeNetwork(`peer:phase4a:${index}`),
					onAdmittedVertex: vi.fn(),
				})
			);
			expect(activations.every((entry) => entry.ok)).toBe(true);
			if (!activations[0]?.ok || !activations[1]?.ok) throw new TypeError("activation failed");
			expect(
				bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: encodeCanonical(9), plane: activations[0].handle })
			).toEqual({ detail: "v3 signed genesis state is invalid", kind: "malformed-input", ok: false });
			const bindings = activations.map((entry) =>
				bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: initialStateBytes, plane: entry.handle })
			);
			expect(bindings.every((entry) => entry.ok)).toBe(true);
			if (!bindings[0]?.ok || !bindings[1]?.ok || !bindings[2]?.ok) throw new TypeError("binding failed");

			if (!activations[2]?.ok) throw new TypeError("closed fold setup failed");
			const issuedPromise = activations[2].handle.issueLocal({
				operations: Object.freeze([
					Object.freeze({ logicalTime: 2, operation: Object.freeze({ action: "add", value: 2 }) }),
				]),
				signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
			});
			const closedStagePromise = bindings[2].handle.stageBlueprintEpoch();
			const [issued, closedStage] = await Promise.all([issuedPromise, closedStagePromise]);
			expect(issued.ok).toBe(true);
			if (!closedStage.ok) throw new TypeError("closed fold failed");
			expect(closedStage.outputs).toEqual([1, 3]);
			expect(closedStage.adopt().ok).toBe(true);
			expect(
				await activations[2].handle.issueLocal({
					operations: Object.freeze([
						Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 4 }) }),
					]),
					signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
				})
			).toEqual({
				detail: "v3 plane is not accepting local issues",
				kind: "not-active",
				ok: false,
			});

			const staged = await Promise.all(bindings.slice(0, 2).map((entry) => entry.handle.stageBlueprintEpoch()));
			if (!staged[0]?.ok || !staged[1]?.ok) {
				throw new TypeError(`fold failed: ${JSON.stringify(staged)}`);
			}
			expect(staged[0].order).toEqual(staged[1].order);
			expect(staged[0].outputs).toEqual([1]);
			expect(staged[0].staged.stateDigest).toBe(staged[1].staged.stateDigest);
			expect(staged[0].staged.exactCanonicalStateBytes).toEqual(staged[1].staged.exactCanonicalStateBytes);

			const adopted = staged.map((entry) => entry.adopt());
			expect(adopted.every((entry) => entry.ok)).toBe(true);
			if (!adopted[0]?.ok || !adopted[1]?.ok) throw new TypeError("adoption failed");
			expect(adopted[0].snapshot).toEqual(adopted[1].snapshot);
			expect(staged[0].adopt()).toEqual({
				detail: "v3 blueprint fold result was already used",
				kind: "already-adopted",
				ok: false,
			});
			expect(await bindings[0].handle.stageBlueprintEpoch()).toEqual({
				detail: "v3 blueprint epoch was already folded",
				kind: "already-folded",
				ok: false,
			});

			activations[1].handle.deactivate();
			expect(bindings[1].handle.blueprintSnapshot()).toBeUndefined();
		} finally {
			await fixture.close();
		}
	});

	it("rejects an authenticated latched member without application-writer authority", async () => {
		const initialStateBytes = encodeCanonical(0);
		const fixture = await createGenuinePreparedV3Fixture({
			authorizationMode: "latched-acl",
			exactCanonicalInitialStateBytes: initialStateBytes,
			latchedAclGroups: ["admin", "finality"],
		});
		let activation: ReturnType<typeof activateV3LivePlane> | undefined;
		try {
			const recovered = await recover(fixture, fixture.capability);
			activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork("peer:phase4a:non-writer"),
				onAdmittedVertex: vi.fn(),
			});
			if (!activation.ok) throw new TypeError("activation failed");
			const binding = bindV3BlueprintLivePlane({
				exactCanonicalInitialStateBytes: initialStateBytes,
				plane: activation.handle,
			});
			if (!binding.ok) throw new TypeError("binding failed");
			expect(await binding.handle.stageBlueprintEpoch()).toEqual({
				detail: "v3 blueprint epoch fold was rejected",
				kind: "fold-rejected",
				ok: false,
			});
		} finally {
			if (activation?.ok) activation.handle.deactivate();
			await fixture.close();
		}
	});
});
