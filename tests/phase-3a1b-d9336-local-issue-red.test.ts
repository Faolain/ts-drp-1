import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, hashDomain } from "@ts-drp/canonical";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "@ts-drp/issuance-store";
import type { AppendAcceptedVertexInput, DurableLiveJournalStore, LiveJournalScope } from "@ts-drp/live-journal";
import { MessageQueueManager } from "@ts-drp/message-queue";
import type { DRPNetworkNode, Message } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";

type Recover = (
	input: Readonly<Record<string, unknown>>
) => Promise<
	Readonly<{ readonly ok: true; readonly capability: object }> | Readonly<{ readonly ok: false; readonly kind: string }>
>;
type Activate = (
	input: Readonly<Record<string, unknown>>
) =>
	| Readonly<{ readonly ok: true; readonly handle: Readonly<Record<string, unknown>> }>
	| Readonly<{ readonly ok: false; readonly kind: string }>;

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

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return Object.freeze({ promise, resolve });
}

async function eventually(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("condition did not become true");
}

function network(trace: string[]): DRPNetworkNode {
	const topics = new Set<string>();
	return {
		peerId: "peer:d9336-local",
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
		sendMessage: vi.fn(() => Promise.resolve()),
		sendMessageToRandomPeer: vi.fn(() => Promise.resolve()),
		sendGroupMessage: vi.fn(() => Promise.resolve()),
		subscribeToMessageQueue: vi.fn(),
		onGroupPeerChange: vi.fn((): (() => void) => () => undefined),
		publishMessage: vi.fn((_topic: string, _message: Message) => {
			trace.push("publish");
			return Promise.resolve(true);
		}),
		gossipTopicFor: vi.fn((): string | undefined => undefined),
	} as unknown as DRPNetworkNode;
}

describe("D.93.36 local issue, apply and publish RED", () => {
	it("issues through recovered author authority, journals and applies before pending publication", async () => {
		const surface = (await import("../packages/node/src/v3-live.js")) as unknown as Record<string, unknown>;
		const recover = surface.recoverV3LiveReplica as Recover;
		const activate = surface.activateV3LivePlane as Activate;
		const fixture = await createGenuinePreparedV3Fixture({ authorizationMode: "latched-acl" });
		const trace: string[] = [];
		const localJournal = deferred<Awaited<ReturnType<DurableLiveJournalStore["appendAccepted"]>>>();
		try {
			const scope = Object.freeze({ author: fixture.author, objectId: fixture.descriptor.objectId });
			const recoveryVertex = fixture.createRecoveryVertex(0, [fixture.descriptor.anchorDigest]);
			const recoveryDigest = Array.from(recoveryVertex.digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
			const recoveryCommit = commitFor(scope, 0, recoveryVertex.canonicalPreimageBytes, recoveryVertex.signature);
			let pendingCommit: DurableIssueCommit | undefined;
			const readIssued = vi.fn((_selectedScope: DurableIssueScope, sequence: number) =>
				Promise.resolve(sequence === 0 ? recoveryCommit : (pendingCommit ?? null))
			);
			const readOutboxPage = vi.fn((input: Parameters<DurableIssuanceStore["readOutboxPage"]>[0] = {}) => {
				const rows: DurableIssuanceOutboxRecord[] = [
					Object.freeze({ commit: recoveryCommit, publishState: "published" as const }),
				];
				if (pendingCommit !== undefined) {
					rows.push(Object.freeze({ commit: pendingCommit, publishState: "pending" as const }));
				}
				const after = input.afterKey?.[2];
				return Promise.resolve(
					rows
						.filter((row) => after === undefined || row.commit.authorSequence > after)
						.slice(0, input.limit ?? rows.length)
				);
			});
			const issuanceStore: DurableIssuanceStore = {
				transactIssue: async (selectedScope, buildAndSign) => {
					expect(selectedScope).toEqual(scope);
					trace.push("issue:start");
					const commit = await buildAndSign(1);
					pendingCommit = commit;
					trace.push("issue:commit");
					return commit;
				},
				compareAndMarkOutboxPublished: (input) => {
					expect(input.authorSequence).toBe(1);
					trace.push("mark");
					return Promise.resolve();
				},
				readIssued,
				readOutboxPage,
				readLineage: () => Promise.resolve(Object.freeze({ exhausted: false, next: 1 })),
				close: () => Promise.resolve(),
			};
			const journalScope: LiveJournalScope = Object.freeze({
				anchorDigest: fixture.descriptor.anchorDigest,
				epoch: 0,
				objectId: fixture.descriptor.objectId,
			});
			const snapshot = Object.freeze({
				kind: "v3-live-journal-snapshot-token-1" as const,
				scope: journalScope,
				highWatermark: 0,
				genesisDigest: "1".repeat(64),
				parametersDigest: fixture.descriptor.parametersDigest,
				orderedRowDigest: "2".repeat(64),
				snapshotDigest: "3".repeat(64),
			});
			let localInput: AppendAcceptedVertexInput | undefined;
			const appendAccepted = vi.fn((input: AppendAcceptedVertexInput) => {
				if (input.vertexDigest === recoveryDigest) {
					return Promise.resolve(
						Object.freeze({
							ok: true as const,
							scope: journalScope,
							journalSequence: 0,
							vertexDigest: input.vertexDigest,
							sourceKind: input.sourceKind,
							idempotent: false,
						})
					);
				}
				localInput = input;
				trace.push("journal:local");
				return localJournal.promise;
			});
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
						Object.freeze({ ok: true as const, ready: true as const, scope: journalScope, snapshot, rowCount: 0 })
					),
				readPage: () =>
					Promise.resolve(
						Object.freeze({ ok: true as const, scope: journalScope, snapshot, rows: [], nextSequence: null })
					),
				appendAccepted,
				close: () => Promise.resolve(),
			};
			const recovered = await recover({
				capability: fixture.capability,
				exactCanonicalLatchedAclBytes: fixture.exactCanonicalLatchedAclBytes,
				issuanceScope: scope,
				issuanceStore,
				liveJournalStore: journalStore,
			});
			expect(recovered.ok).toBe(true);
			if (!recovered.ok) throw new TypeError(`recovery failed: ${recovered.kind}`);
			expect(recovered.capability).not.toBe(fixture.capability);
			expect(Object.isFrozen(recovered.capability)).toBe(true);
			expect(readIssued).toHaveBeenCalledTimes(1);
			expect(readIssued).toHaveBeenCalledWith(scope, 0);
			expect(readOutboxPage).toHaveBeenCalledTimes(2);
			expect(readOutboxPage).toHaveBeenNthCalledWith(1, { limit: 1, scope });
			expect(readOutboxPage).toHaveBeenNthCalledWith(2, {
				afterKey: [scope.objectId, scope.author, 0],
				limit: 1,
				scope,
			});
			expect(appendAccepted).toHaveBeenCalledTimes(1);
			expect(appendAccepted).toHaveBeenCalledWith({
				author: fixture.author,
				authorSequence: 0,
				scope: journalScope,
				sourceKind: "local-issued",
				vertexDigest: recoveryDigest,
			});
			const sink = vi.fn((delivery: Readonly<{ readonly vertex: Readonly<{ readonly authorSequence: number }> }>) => {
				trace.push(`sink:${delivery.vertex.authorSequence}`);
			});
			const activeNetwork = network(trace);
			const activated = activate({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: activeNetwork,
				onAdmittedVertex: sink,
			});
			expect(activated.ok).toBe(true);
			if (!activated.ok) throw new TypeError(`activation failed: ${activated.kind}`);
			const issueLocal = Reflect.get(activated.handle, "issueLocal");
			expect(issueLocal).toBeTypeOf("function");
			const signer = vi.fn((digest: Uint8Array) => {
				trace.push("sign");
				return fixture.signRegisteredVertexDigest(digest);
			});
			const issuePromise = Reflect.apply(issueLocal as (...args: unknown[]) => unknown, activated.handle, [
				Object.freeze({
					logicalTime: 2,
					operation: Object.freeze({ action: "acl", group: "writer", kind: "grant", target: "d".repeat(64) }),
					signRegisteredVertexDigest: signer,
				}),
			]) as Promise<Readonly<Record<string, unknown>>>;
			const publishPromise = Reflect.apply(
				Reflect.get(activated.handle, "publishPending") as (...args: unknown[]) => unknown,
				activated.handle,
				[]
			) as Promise<unknown>;
			const preJournalState = await Promise.race([
				issuePromise.then((result) => Object.freeze({ kind: "settled" as const, result })),
				new Promise<Readonly<{ readonly kind: "pending" }>>((resolve) =>
					setTimeout(() => resolve(Object.freeze({ kind: "pending" as const })), 5)
				),
			]);
			expect(preJournalState).toEqual({ kind: "pending" });
			await eventually(() => localInput !== undefined);
			expect(trace).toEqual(["issue:start", "sign", "issue:commit", "journal:local"]);
			expect(sink).not.toHaveBeenCalled();
			expect(Reflect.get(activeNetwork, "publishMessage")).not.toHaveBeenCalled();
			if (localInput === undefined) throw new TypeError("missing local journal input");
			if (pendingCommit === undefined) throw new TypeError("missing issued commit");
			const exactOperation = Object.freeze({
				action: "acl",
				group: "writer",
				kind: "grant",
				target: "d".repeat(64),
			});
			const exactDigestBytes = hashDomain("ts-drp/vertex/v3", pendingCommit.envelope.canonicalPreimageBytes);
			const exactDigest = Array.from(exactDigestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
			expect(pendingCommit.envelope.digest).toEqual(exactDigestBytes);
			expect(
				ed25519.verify(pendingCommit.envelope.signature, pendingCommit.envelope.digest, fixture.authorPublicKey, {
					zip215: false,
				})
			).toBe(true);
			expect(decodeCanonical(pendingCommit.envelope.canonicalPreimageBytes)).toEqual({
				anchor: fixture.descriptor.anchorDigest,
				author: fixture.author,
				authorSequence: 1,
				dependencies: [recoveryDigest],
				epoch: 0,
				kind: "drp-vertex",
				logicalTime: 2,
				objectId: fixture.descriptor.objectId,
				operation: exactOperation,
				protocolMajor: 3,
			});
			expect(localInput).toEqual({
				author: fixture.author,
				authorSequence: 1,
				scope: journalScope,
				sourceKind: "local-issued",
				vertexDigest: exactDigest,
			});
			localJournal.resolve(
				Object.freeze({
					ok: true as const,
					scope: journalScope,
					journalSequence: 1,
					vertexDigest: localInput.vertexDigest,
					sourceKind: "local-issued" as const,
					idempotent: false,
				})
			);
			const issued = await issuePromise;
			expect(issued).toEqual({
				ok: true,
				kind: "accepted",
				authorSequence: 1,
				digest: localInput.vertexDigest,
			});
			expect(Object.isFrozen(issued)).toBe(true);
			expect(trace).toEqual(["issue:start", "sign", "issue:commit", "journal:local", "sink:1"]);
			expect(sink).toHaveBeenCalledTimes(1);
			const previewLatchedAcl = Reflect.get(activated.handle, "previewLatchedAcl");
			expect(previewLatchedAcl).toBeTypeOf("function");
			const preview = Reflect.apply(previewLatchedAcl as (...args: unknown[]) => unknown, activated.handle, []);
			expect(preview).toMatchObject({
				current: {
					epoch: 0,
					members: [
						{
							author: fixture.author,
							finalityKey: fixture.author,
							groups: ["admin", "finality", "writer"],
						},
					],
				},
				next: {
					epoch: 1,
					members: [
						{
							author: fixture.author,
							finalityKey: fixture.author,
							groups: ["admin", "finality", "writer"],
						},
						{ author: "d".repeat(64), finalityKey: null, groups: ["writer"] },
					],
				},
				stagedOperations: [
					{
						actor: fixture.author,
						digest: localInput.vertexDigest,
						operation: { group: "writer", kind: "grant", target: "d".repeat(64) },
					},
				],
			});
			expect(Reflect.get(preview as object, "nextDigest")).toMatch(/^[0-9a-f]{64}$/u);
			expect(await publishPromise).toEqual({ ok: true, kind: "published" });
			expect(trace).toEqual(["issue:start", "sign", "issue:commit", "journal:local", "sink:1", "publish", "mark"]);
			const legacySigner = vi.fn(fixture.signRegisteredVertexDigest);
			const joinSelectorSigner = vi.fn(fixture.signRegisteredVertexDigest);
			const callerReservedJoinSigner = vi.fn(fixture.signRegisteredVertexDigest);
			const [legacyDependencies, callerJoinSelector, callerReservedJoin] = await Promise.all([
				Reflect.apply(issueLocal as (...args: unknown[]) => unknown, activated.handle, [
					Object.freeze({
						dependencies: [recoveryDigest],
						logicalTime: 4,
						operation: Object.freeze({ action: "acl", group: "writer", kind: "grant", target: "e".repeat(64) }),
						signRegisteredVertexDigest: legacySigner,
					}),
				]) as Promise<Readonly<Record<string, unknown>>>,
				Reflect.apply(issueLocal as (...args: unknown[]) => unknown, activated.handle, [
					Object.freeze({
						joinRole: "causalJoin",
						logicalTime: 6,
						operation: Object.freeze({ action: "acl", group: "writer", kind: "grant", target: "f".repeat(64) }),
						signRegisteredVertexDigest: joinSelectorSigner,
					}),
				]) as Promise<Readonly<Record<string, unknown>>>,
				Reflect.apply(issueLocal as (...args: unknown[]) => unknown, activated.handle, [
					Object.freeze({
						logicalTime: 8,
						operation: Object.freeze({ action: "causalJoin" }),
						signRegisteredVertexDigest: callerReservedJoinSigner,
					}),
				]) as Promise<Readonly<Record<string, unknown>>>,
			]);
			expect(legacyDependencies).toMatchObject({ ok: false, kind: "malformed-input" });
			expect(callerJoinSelector).toMatchObject({ ok: false, kind: "malformed-input" });
			expect(callerReservedJoin).toMatchObject({ ok: false, kind: "authorization-rejected" });
			expect(legacySigner).not.toHaveBeenCalled();
			expect(joinSelectorSigner).not.toHaveBeenCalled();
			expect(callerReservedJoinSigner).not.toHaveBeenCalled();
			const deactivate = Reflect.get(activated.handle, "deactivate");
			if (typeof deactivate === "function") Reflect.apply(deactivate, activated.handle, []);
		} finally {
			await fixture.close();
		}
	});
});
