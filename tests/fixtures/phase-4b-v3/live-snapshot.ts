import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "@ts-drp/issuance-store";
import type {
	DurableLiveJournalStore,
	LiveJournalAcceptedRow,
	LiveJournalScope,
	LiveJournalSnapshotToken,
} from "@ts-drp/live-journal";
import type { DRPNetworkNode } from "@ts-drp/types";
import { vi } from "vitest";

import { type PreparedV3Live, type RecoveredV3Live, recoverV3LiveReplica } from "../../../packages/node/src/v3-live.js";
import { type GenuinePreparedV3Fixture } from "../phase-3a1b-p3/live-fixture.js";

export type OperationAdmissionReservationFixture =
	| Readonly<{ readonly kind: "fresh"; commit(): "committed"; release(): void }>
	| Readonly<{ readonly kind: "duplicate" | "conflict" | "rejected" }>;

export interface OperationAdmissionPolicyFixture {
	reserve(operation: Readonly<Record<string, unknown>>): OperationAdmissionReservationFixture;
}

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

function journalStore(fixture: GenuinePreparedV3Fixture, trace?: string[]): DurableLiveJournalStore {
	const scope: LiveJournalScope = Object.freeze({
		anchorDigest: fixture.anchorDigest,
		epoch: 0,
		objectId: fixture.objectId,
	});
	const rows: LiveJournalAcceptedRow[] = [];
	const snapshot = (): LiveJournalSnapshotToken =>
		Object.freeze({
			genesisDigest: "1".repeat(64),
			highWatermark: Math.max(0, rows.length - 1),
			kind: "v3-live-journal-snapshot-token-1" as const,
			orderedRowDigest: "2".repeat(64),
			parametersDigest: fixture.descriptor.parametersDigest,
			scope,
			snapshotDigest: "3".repeat(64),
		});
	return Object.freeze({
		appendAccepted: vi.fn((input) => {
			trace?.push("journal");
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
			const row = Object.freeze({ ...input, journalSequence: rows.length }) as LiveJournalAcceptedRow;
			rows.push(row);
			return Promise.resolve(
				Object.freeze({
					idempotent: false,
					journalSequence: row.journalSequence,
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
				Object.freeze({ ok: true as const, ready: true as const, rowCount: rows.length, scope, snapshot: snapshot() })
			)
		),
		readPage: vi.fn((input) => {
			const index = input.afterSequence === null || input.afterSequence === undefined ? 0 : input.afterSequence + 1;
			const row = rows[index];
			return Promise.resolve(
				Object.freeze({
					nextSequence: row !== undefined && index + 1 < rows.length ? index : null,
					ok: true as const,
					rows: Object.freeze(row === undefined ? [] : [row]),
					scope,
					snapshot: input.snapshot,
				})
			);
		}),
	});
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function recoveryCarrier(
	fixture: GenuinePreparedV3Fixture,
	recoveryOperation?: Readonly<Record<string, unknown>>
): Promise<Readonly<{ canonicalPreimageBytes: Uint8Array; digest: Uint8Array; signature: Uint8Array }>> {
	if (recoveryOperation === undefined) return fixture.createRecoveryVertex(0, [fixture.anchorDigest]);
	const canonicalPreimageBytes = encodeCanonical({
		anchor: fixture.anchorDigest,
		author: fixture.author,
		authorSequence: 0,
		dependencies: [fixture.anchorDigest],
		epoch: 0,
		kind: "drp-vertex",
		logicalTime: 1,
		objectId: fixture.objectId,
		operation: recoveryOperation,
		protocolMajor: 3,
	});
	const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
	return Object.freeze({
		canonicalPreimageBytes,
		digest,
		signature: await fixture.signRegisteredVertexDigest(digest),
	});
}

async function recoveryStore(
	fixture: GenuinePreparedV3Fixture,
	recoveryOperation?: Readonly<Record<string, unknown>>,
	trace?: string[]
): Promise<Readonly<{ readonly store: DurableIssuanceStore; readonly vertexDigest: string }>> {
	const scope: DurableIssueScope = Object.freeze({ author: fixture.author, objectId: fixture.objectId });
	const carrier = await recoveryCarrier(fixture, recoveryOperation);
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
	const commits = new Map<number, DurableIssueCommit>([[0, commit]]);
	const outbox = new Map<number, DurableIssuanceOutboxRecord>([
		[0, Object.freeze({ commit, publishState: "published" })],
	]);
	let nextAuthorSequence = 1;
	const store = Object.freeze({
		close: vi.fn(() => Promise.resolve()),
		compareAndMarkOutboxPublished: vi.fn((input) => {
			const selected = outbox.get(input.authorSequence);
			if (selected !== undefined) {
				outbox.set(input.authorSequence, Object.freeze({ commit: selected.commit, publishState: "published" }));
			}
			return Promise.resolve();
		}),
		readIssued: vi.fn((selectedScope, sequence) =>
			Promise.resolve(
				selectedScope.author === scope.author && selectedScope.objectId === scope.objectId
					? (commits.get(sequence) ?? null)
					: null
			)
		),
		readLineage: vi.fn(() => Promise.resolve({ exhausted: false, next: 1 })),
		readOutboxPage: vi.fn((input = {}) => {
			const after = input.afterKey?.[2] ?? -1;
			return Promise.resolve(
				Object.freeze(
					[...outbox.entries()]
						.filter(([sequence]) => sequence > after)
						.sort(([left], [right]) => left - right)
						.slice(0, input.limit ?? outbox.size)
						.map(([, value]) => value)
				)
			);
		}),
		transactIssue: vi.fn(async (selectedScope, buildAndSign) => {
			trace?.push("issuance");
			if (selectedScope.author !== scope.author || selectedScope.objectId !== scope.objectId) {
				throw new TypeError("issuance scope mismatch");
			}
			const issued = await buildAndSign(nextAuthorSequence);
			commits.set(nextAuthorSequence, issued);
			outbox.set(nextAuthorSequence, Object.freeze({ commit: issued, publishState: "pending" }));
			nextAuthorSequence += 1;
			return issued;
		}),
	});
	return Object.freeze({ store, vertexDigest: lowerHex(carrier.digest) });
}

/**
 * Recovers one genuine prepared capability through the shipped replica path.
 * @param fixture - Authenticated live fixture that minted the capability.
 * @param capability - One-use prepared capability to recover.
 * @param recoveryOperation - Optional exact vertex operation for a closed-graph recovery proof.
 * @param operationAdmissionPolicy - Optional fresh policy used by the E5-01 pre-journal RED.
 * @param trace - Optional shared event trace for durable-order assertions.
 * @returns The recovered capability and the stores that authenticated it.
 */
export async function recover(
	fixture: GenuinePreparedV3Fixture,
	capability: PreparedV3Live,
	recoveryOperation?: Readonly<Record<string, unknown>>,
	operationAdmissionPolicy?: OperationAdmissionPolicyFixture,
	trace?: string[]
): Promise<
	Readonly<{
		capability: RecoveredV3Live;
		issuanceStore: DurableIssuanceStore;
		journal: DurableLiveJournalStore;
		recoveryVertexDigest: string;
	}>
> {
	const recoveredStore = await recoveryStore(fixture, recoveryOperation, trace);
	const issuanceStore = recoveredStore.store;
	const journal = journalStore(fixture, trace);
	const result = await recoverV3LiveReplica({
		capability,
		...(fixture.exactCanonicalLatchedAclBytes === undefined
			? { exactCanonicalAuthorAuthorizationBytes: fixture.exactCanonicalAuthorAuthorizationBytes }
			: { exactCanonicalLatchedAclBytes: fixture.exactCanonicalLatchedAclBytes }),
		issuanceScope: Object.freeze({ author: fixture.author, objectId: fixture.objectId }),
		issuanceStore,
		liveJournalStore: journal,
		...(operationAdmissionPolicy === undefined ? {} : { operationAdmissionPolicy }),
	} as Parameters<typeof recoverV3LiveReplica>[0]);
	if (!result.ok) throw new TypeError(`recovery failed: ${result.kind}`);
	return Object.freeze({
		capability: result.capability,
		issuanceStore,
		journal,
		recoveryVertexDigest: recoveredStore.vertexDigest,
	});
}

/**
 * Recovers the fixed closed-epoch ACL vertex used by the live snapshot composition owner.
 * @param fixture - Authenticated live fixture that minted the capability.
 * @param capability - One-use prepared capability to recover.
 * @returns The recovered closed-graph capability and its evidence owners.
 */
export function recoverLiveSnapshotPeer(
	fixture: GenuinePreparedV3Fixture,
	capability: PreparedV3Live
): ReturnType<typeof recover> {
	if (fixture.exactCanonicalLatchedAclBytes === undefined) return recover(fixture, capability);
	return recover(
		fixture,
		capability,
		Object.freeze({
			action: "acl",
			group: "writer",
			kind: "grant",
			target: fixture.author === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64),
		})
	);
}

export type { GenuinePreparedV3Fixture, RecoveredV3Live };
