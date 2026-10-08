import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
	SettlementPlan,
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
 * @param recordCalls - Keep mock-call recording by default; long-running workloads can opt out.
 * @returns A network node with recorded topic membership.
 */
export function fakeNetwork(peerId: string, recordCalls = true): DRPNetworkNode {
	const topics = new Set<string>();
	const network = {
		peerId,
		membershipVerifier: undefined,
		start: (): Promise<void> => Promise.resolve(),
		stop: (): Promise<void> => Promise.resolve(),
		restart: (): Promise<void> => Promise.resolve(),
		isDialable: (): Promise<boolean> => Promise.resolve(true),
		changeTopicScoreParams: (): undefined => undefined,
		removeTopicScoreParams: (): undefined => undefined,
		subscribe: (topic: string): Set<string> => topics.add(topic),
		unsubscribe: (topic: string): boolean => topics.delete(topic),
		connectToBootstraps: (): Promise<void> => Promise.resolve(),
		connect: (): Promise<void> => Promise.resolve(),
		disconnect: (): Promise<void> => Promise.resolve(),
		getPeerMultiaddrs: (): Promise<never[]> => Promise.resolve([]),
		getBootstrapNodes: (): never[] => [],
		getSubscribedTopics: (): string[] => [...topics],
		getMultiaddrs: (): string[] => ["/ip4/127.0.0.1/tcp/1"],
		getAllPeers: (): never[] => [],
		getGroupPeers: (): never[] => [],
		broadcastMessage: (): Promise<void> => Promise.resolve(),
		publishMessage: (): Promise<boolean> => Promise.resolve(true),
		sendMessage: (): Promise<void> => Promise.resolve(),
		sendMessageToRandomPeer: (): Promise<void> => Promise.resolve(),
		sendGroupMessage: (): Promise<void> => Promise.resolve(),
		subscribeToMessageQueue: (): undefined => undefined,
		onGroupPeerChange: (): (() => void) => () => undefined,
		gossipTopicFor: (): undefined => undefined,
	};
	if (recordCalls) {
		for (const [name, method] of Object.entries(network)) {
			if (typeof method === "function") Reflect.set(network, name, vi.fn(method));
		}
	}
	return network as unknown as DRPNetworkNode;
}

function journalStore(fixture: GenuinePreparedV3Fixture, trace?: string[]): DurableLiveJournalStore {
	const scope: LiveJournalScope = Object.freeze({
		anchorDigest: fixture.anchorDigest,
		epoch: 0,
		objectId: fixture.objectId,
	});
	const rows: LiveJournalAcceptedRow[] = [];
	let genesisInstalled = false;
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
		installEpochAnchor: vi.fn(() =>
			Promise.reject(new Error("unexpected installEpochAnchor in live snapshot fixture"))
		),
		installGenesis: vi.fn(() => {
			const idempotent = genesisInstalled;
			genesisInstalled = true;
			return Promise.resolve(
				Object.freeze({
					idempotent,
					ok: true as const,
					parametersDigest: fixture.descriptor.parametersDigest,
					scope,
				})
			);
		}),
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
	let settlementPlan: SettlementPlan | null = null;
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
		readLineage: vi.fn(() => Promise.resolve({ exhausted: false, next: nextAuthorSequence })),
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
		readSettlementPlan: vi.fn(() => Promise.resolve(settlementPlan)),
		transactIssue: vi.fn(async (selectedScope, buildAndSign) => {
			trace?.push("issuance");
			if (selectedScope.author !== scope.author || selectedScope.objectId !== scope.objectId) {
				throw new TypeError("issuance scope mismatch");
			}
			const issued = await buildAndSign(nextAuthorSequence);
			if (issued.planEffect?.kind === "fence") {
				if (settlementPlan === null || settlementPlan.fenceSequence !== null) {
					throw new TypeError("settlement fence plan is unavailable");
				}
				settlementPlan = Object.freeze({
					...settlementPlan,
					fenceSequence: nextAuthorSequence,
					revision: settlementPlan.revision + 1,
				});
			} else if (issued.planEffect?.kind === "replacement") {
				const entry = settlementPlan?.entries.find(
					(candidate) => candidate.sourceSequence === issued.planEffect?.sourceSequence
				);
				if (settlementPlan === null || entry === undefined || entry.replacementSequence !== null) {
					throw new TypeError("settlement replacement plan is unavailable");
				}
				settlementPlan = Object.freeze({
					...settlementPlan,
					entries: Object.freeze(
						settlementPlan.entries.map((candidate) =>
							candidate === entry ? Object.freeze({ ...candidate, replacementSequence: nextAuthorSequence }) : candidate
						)
					),
					revision: settlementPlan.revision + 1,
				});
			}
			commits.set(nextAuthorSequence, issued);
			outbox.set(nextAuthorSequence, Object.freeze({ commit: issued, publishState: "pending" }));
			nextAuthorSequence += 1;
			return issued;
		}),
		transactWriteSettlementPlan: vi.fn((input: Parameters<DurableIssuanceStore["transactWriteSettlementPlan"]>[0]) => {
			if (input.scope.author !== scope.author || input.scope.objectId !== scope.objectId) {
				return Promise.reject(new TypeError("settlement plan scope mismatch"));
			}
			if ((settlementPlan?.revision ?? null) !== input.expectedRevision) {
				return Promise.reject(new TypeError("settlement plan revision mismatch"));
			}
			const nextPlan: SettlementPlan = Object.freeze({
				...input.plan,
				entries: Object.freeze(input.plan.entries.map((entry) => Object.freeze({ ...entry }))),
				revision: (settlementPlan?.revision ?? -1) + 1,
				scope,
			});
			settlementPlan = nextPlan;
			return Promise.resolve(nextPlan);
		}),
	});
	return Object.freeze({ store, vertexDigest: lowerHex(carrier.digest) });
}

/**
 * Builds detached recovery bindings for focused closed-input and policy tests.
 * @param fixture - Authenticated live fixture that minted the capability.
 * @param capability - Prepared capability selected by the caller.
 * @param recoveryOperation - Optional exact vertex operation for the recovered row.
 * @param trace - Optional shared event trace for durable-order assertions.
 * @returns A closed public recovery input and its evidence owners.
 */
export async function createRecoveryInput(
	fixture: GenuinePreparedV3Fixture,
	capability: PreparedV3Live,
	recoveryOperation?: Readonly<Record<string, unknown>>,
	trace?: string[]
): Promise<
	Readonly<{
		readonly input: Parameters<typeof recoverV3LiveReplica>[0];
		readonly issuanceStore: DurableIssuanceStore;
		readonly journal: DurableLiveJournalStore;
		readonly recoveryVertexDigest: string;
	}>
> {
	const recoveredStore = await recoveryStore(fixture, recoveryOperation, trace);
	const journal = journalStore(fixture, trace);
	const input = Object.freeze({
		capability,
		...(fixture.exactCanonicalLatchedAclBytes === undefined
			? { exactCanonicalAuthorAuthorizationBytes: fixture.exactCanonicalAuthorAuthorizationBytes }
			: { exactCanonicalLatchedAclBytes: fixture.exactCanonicalLatchedAclBytes }),
		issuanceScope: Object.freeze({ author: fixture.author, objectId: fixture.objectId }),
		issuanceStore: recoveredStore.store,
		liveJournalStore: journal,
	}) as Parameters<typeof recoverV3LiveReplica>[0];
	return Object.freeze({
		input,
		issuanceStore: recoveredStore.store,
		journal,
		recoveryVertexDigest: recoveredStore.vertexDigest,
	});
}

/**
 * Recovers one genuine prepared capability through the shipped replica path.
 * @param fixture - Authenticated live fixture that minted the capability.
 * @param capability - One-use prepared capability to recover.
 * @param recoveryOperation - Optional exact vertex operation for a closed-graph recovery proof.
 * @param operationAdmissionPolicy - Optional fresh policy used by the E5-01 pre-journal RED.
 * @param trace - Optional shared event trace for durable-order assertions.
 * @param exactCanonicalPinnedGenesisBootstrapOperationBytes - Optional exact configured bootstrap policy.
 * @returns The recovered capability and the stores that authenticated it.
 */
export async function recover(
	fixture: GenuinePreparedV3Fixture,
	capability: PreparedV3Live,
	recoveryOperation?: Readonly<Record<string, unknown>>,
	operationAdmissionPolicy?: OperationAdmissionPolicyFixture,
	trace?: string[],
	exactCanonicalPinnedGenesisBootstrapOperationBytes?: Uint8Array
): Promise<
	Readonly<{
		capability: RecoveredV3Live;
		issuanceStore: DurableIssuanceStore;
		journal: DurableLiveJournalStore;
		recoveryVertexDigest: string;
	}>
> {
	const bindings = await createRecoveryInput(fixture, capability, recoveryOperation, trace);
	const issuanceStore = bindings.issuanceStore;
	const journal = bindings.journal;
	const result = await recoverV3LiveReplica({
		...bindings.input,
		...(operationAdmissionPolicy === undefined ? {} : { operationAdmissionPolicy }),
		...(exactCanonicalPinnedGenesisBootstrapOperationBytes === undefined
			? {}
			: { exactCanonicalPinnedGenesisBootstrapOperationBytes }),
	} as Parameters<typeof recoverV3LiveReplica>[0]);
	if (!result.ok) throw new TypeError(`recovery failed: ${result.kind}`);
	return Object.freeze({
		capability: result.capability,
		issuanceStore,
		journal,
		recoveryVertexDigest: bindings.recoveryVertexDigest,
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
