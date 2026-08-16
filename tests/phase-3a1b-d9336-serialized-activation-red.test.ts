import { hashDomain } from "@ts-drp/canonical";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "@ts-drp/issuance-store";
import type { AppendAcceptedVertexInput, DurableLiveJournalStore, LiveJournalScope } from "@ts-drp/live-journal";
import { MessageQueueManager } from "@ts-drp/message-queue";
import type { DRPNetworkNode, Message as MessageShape } from "@ts-drp/types";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";

interface RecoverySuccess {
	readonly ok: true;
	readonly capability: object;
}

interface ActivationSuccess {
	readonly ok: true;
	readonly handle: Readonly<{ readonly topic: string; deactivate(): void }>;
}

type Recover = (input: Readonly<Record<string, unknown>>) => Promise<RecoverySuccess | Readonly<{ ok: false }>>;
type Activate = (input: Readonly<Record<string, unknown>>) => ActivationSuccess | Readonly<{ ok: false }>;
type Route = (networkNode: DRPNetworkNode, message: MessageShape) => boolean;

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

function fakeNetwork(): DRPNetworkNode {
	const topics = new Set<string>();
	const network = {
		peerId: "peer:d9336-activation",
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
		publishMessage: vi.fn(() => Promise.resolve(true)),
		gossipTopicFor: vi.fn((): string | undefined => undefined),
	};
	return network as unknown as DRPNetworkNode;
}

describe("D.93.36 serialized activation and ingress RED", () => {
	it("activates only the recovered capability and journals ingress before observation", async () => {
		const surface = (await import("../packages/node/src/v3-live.js")) as unknown as Record<string, unknown>;
		const recover = surface.recoverV3LiveReplica as Recover;
		const activate = surface.activateV3LivePlane as Activate;
		const route = surface.routeV3Ingress as Route;
		const fixture = await createGenuinePreparedV3Fixture();
		const firstIngressAppend = deferred<Awaited<ReturnType<DurableLiveJournalStore["appendAccepted"]>>>();
		const secondIngressAppend = deferred<Awaited<ReturnType<DurableLiveJournalStore["appendAccepted"]>>>();
		const trace: string[] = [];
		try {
			const scope = Object.freeze({ author: fixture.author, objectId: fixture.descriptor.objectId });
			const recovery = fixture.createRecoveryVertex(0, [fixture.descriptor.anchorDigest]);
			const recoveryDigest = Array.from(recovery.digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
			const commit = commitFor(scope, 0, recovery.canonicalPreimageBytes, recovery.signature);
			const outbox: DurableIssuanceOutboxRecord = Object.freeze({ commit, publishState: "published" });
			const issuanceStore: DurableIssuanceStore = Object.freeze({
				transactIssue: () => Promise.reject(new Error("activation must not issue")),
				compareAndMarkOutboxPublished: () => Promise.reject(new Error("activation must not publish")),
				readIssued: (_selectedScope, sequence) => Promise.resolve(sequence === 0 ? commit : null),
				readOutboxPage: (input = {}) =>
					Promise.resolve(input.afterKey == null ? Object.freeze([outbox]) : Object.freeze([])),
				readLineage: () => Promise.resolve(Object.freeze({ exhausted: false, next: 1 })),
				close: () => Promise.resolve(),
			});
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
			let appendOrdinal = 0;
			const receivedInputs: AppendAcceptedVertexInput[] = [];
			const journalStore: DurableLiveJournalStore = Object.freeze({
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
						Object.freeze({
							ok: true as const,
							scope: journalScope,
							snapshot,
							rows: Object.freeze([]),
							nextSequence: null,
						})
					),
				appendAccepted(input: AppendAcceptedVertexInput) {
					appendOrdinal += 1;
					if (input.sourceKind === "local-issued") {
						trace.push("journal:recovery");
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
					receivedInputs.push(input);
					trace.push(`journal:ingress:${receivedInputs.length}`);
					return receivedInputs.length === 1 ? firstIngressAppend.promise : secondIngressAppend.promise;
				},
				close: () => Promise.resolve(),
			});
			const recovered = await recover({
				capability: fixture.capability,
				exactCanonicalAuthorAuthorizationBytes: fixture.exactCanonicalAuthorAuthorizationBytes,
				issuanceScope: scope,
				issuanceStore,
				liveJournalStore: journalStore,
			});
			expect(recovered.ok).toBe(true);
			if (!recovered.ok) throw new TypeError("recovery failed");

			const queue = new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } });
			const network = fakeNetwork();
			const sink = vi.fn((delivery: Readonly<{ readonly vertex: Readonly<{ readonly authorSequence: number }> }>) => {
				trace.push(`sink:${delivery.vertex.authorSequence}`);
			});
			const activated = activate({
				capability: recovered.capability,
				messageQueueManager: queue,
				networkNode: network,
				onAdmittedVertex: sink,
			});
			expect(activated).toEqual({ ok: true, handle: expect.any(Object) });
			if (!activated.ok) throw new TypeError("activation failed");

			const firstIngress = fixture.createRecoveryVertex(1, [recoveryDigest]);
			const firstIngressDigest = Array.from(firstIngress.digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
			const secondIngress = fixture.createRecoveryVertex(2, [firstIngressDigest]);
			Reflect.set(
				network,
				"gossipTopicFor",
				vi.fn(() => activated.handle.topic)
			);
			const routeCarrier = (
				carrier: Readonly<{ readonly canonicalPreimageBytes: Uint8Array; readonly signature: Uint8Array }>,
				sender: string
			): boolean =>
				route(
					network,
					Message.create({
						data: V3Envelope.encode({
							canonicalPreimage: carrier.canonicalPreimageBytes,
							signature: carrier.signature,
						}).finish(),
						objectId: activated.handle.topic,
						sender,
						type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
					})
				);
			expect(routeCarrier(firstIngress, "peer:remote:1")).toBe(true);
			expect(routeCarrier(secondIngress, "peer:remote:2")).toBe(true);
			await eventually(() => appendOrdinal === 2);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(appendOrdinal).toBe(2);
			expect(trace).toEqual(["journal:recovery", "journal:ingress:1"]);
			expect(sink).not.toHaveBeenCalled();
			expect(receivedInputs[0]).toEqual({
				detachedSignature: firstIngress.signature,
				exactCanonicalPreimageBytes: firstIngress.canonicalPreimageBytes,
				scope: journalScope,
				sourceKind: "received",
				vertexDigest: firstIngressDigest,
			});

			firstIngressAppend.resolve(
				Object.freeze({
					ok: true as const,
					scope: journalScope,
					journalSequence: 1,
					vertexDigest: firstIngressDigest,
					sourceKind: "received" as const,
					idempotent: false,
				})
			);
			await eventually(() => sink.mock.calls.length === 1 && appendOrdinal === 3);
			expect(trace).toEqual(["journal:recovery", "journal:ingress:1", "sink:1", "journal:ingress:2"]);
			expect(receivedInputs[1]).toEqual({
				detachedSignature: secondIngress.signature,
				exactCanonicalPreimageBytes: secondIngress.canonicalPreimageBytes,
				scope: journalScope,
				sourceKind: "received",
				vertexDigest: Array.from(secondIngress.digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
			});
			secondIngressAppend.resolve(
				Object.freeze({
					ok: true as const,
					scope: journalScope,
					journalSequence: 2,
					vertexDigest: Array.from(secondIngress.digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
					sourceKind: "received" as const,
					idempotent: false,
				})
			);
			await eventually(() => sink.mock.calls.length === 2);
			expect(trace).toEqual(["journal:recovery", "journal:ingress:1", "sink:1", "journal:ingress:2", "sink:2"]);
			expect(sink.mock.calls[0]?.[0]).toMatchObject({
				exactReceivedCanonicalPreimageBytes: firstIngress.canonicalPreimageBytes,
				signature: firstIngress.signature,
				transportSender: "peer:remote:1",
				vertex: { authorSequence: 1, hash: firstIngressDigest },
			});
			activated.handle.deactivate();
		} finally {
			await fixture.close();
		}
	});

	it("rejects the direct prepared-to-live bypass", async () => {
		const surface = (await import("../packages/node/src/v3-live.js")) as unknown as Record<string, unknown>;
		const activate = surface.activateV3LivePlane as Activate;
		const fixture = await createGenuinePreparedV3Fixture();
		try {
			const scope = Object.freeze({ author: fixture.author, objectId: fixture.descriptor.objectId });
			const network = fakeNetwork();
			const queue = new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } });
			const queueSubscribe = vi.spyOn(queue, "subscribe");
			const issuanceStore = Object.freeze({
				transactIssue: () => Promise.reject(new Error("unused")),
				compareAndMarkOutboxPublished: () => Promise.resolve(),
				readIssued: () => Promise.resolve(null),
				readOutboxPage: () => Promise.resolve([]),
				readLineage: () => Promise.resolve(Object.freeze({ exhausted: false, next: 0 })),
				close: () => Promise.resolve(),
			});
			const result = activate({
				capability: fixture.capability,
				issuanceScope: scope,
				issuanceStore,
				messageQueueManager: queue,
				networkNode: network,
				onAdmittedVertex: vi.fn(),
				resolveAuthorPublicKey: vi.fn(() => ({ bytes: fixture.authorPublicKey, format: "raw" as const })),
			});
			expect(result.ok).toBe(false);
			expect(network.getSubscribedTopics()).toEqual([]);
			expect(queueSubscribe).not.toHaveBeenCalled();
			expect(network.subscribe).not.toHaveBeenCalled();
		} finally {
			await fixture.close();
		}
	});
});
