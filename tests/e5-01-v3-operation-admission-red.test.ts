import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";
import { fakeNetwork, type OperationAdmissionPolicyFixture, recover } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { ObservedMessageQueueManager } from "./fixtures/shared/observed-message-queue.js";
import { activateV3LivePlane, recoverV3LiveReplica, routeV3Ingress } from "../packages/node/src/v3-live.js";
import * as outcomeCommit from "../packages/outcome-commit/src/index.js";

const policyOwnerReady = typeof Reflect.get(outcomeCommit, "createOutcomeCommitAdmissionPolicy") === "function";

interface TracePolicy extends OperationAdmissionPolicyFixture {
	readonly committed: ReadonlySet<string>;
}

function operationKey(operation: Readonly<Record<string, unknown>>): string {
	return Buffer.from(encodeCanonical(operation)).toString("hex");
}

function tracingPolicy(trace: string[]): TracePolicy {
	const committed = new Set<string>();
	const reserved = new Set<string>();
	return Object.freeze({
		committed,
		reserve(operation) {
			const key = operationKey(operation);
			const value = Reflect.get(operation, "value");
			trace.push(`reserve:${String(value ?? "recovery")}`);
			if (value === 902) return Object.freeze({ kind: "conflict" as const });
			if (committed.has(key) || value === 901) return Object.freeze({ kind: "duplicate" as const });
			if (reserved.has(key)) return Object.freeze({ kind: "duplicate" as const });
			reserved.add(key);
			let active = true;
			return Object.freeze({
				commit(): "committed" {
					if (!active) throw new TypeError("admission reservation was already consumed");
					active = false;
					reserved.delete(key);
					committed.add(key);
					trace.push(`commit:${String(value ?? "recovery")}`);
					return "committed";
				},
				kind: "fresh" as const,
				release(): void {
					if (!active) return;
					active = false;
					reserved.delete(key);
					trace.push(`release:${String(value ?? "recovery")}`);
				},
			});
		},
	});
}

async function ingressMessage(
	fixture: Awaited<ReturnType<typeof createGenuinePreparedV3Fixture>>,
	topic: string,
	dependency: string,
	value: number
): Promise<Message> {
	const canonicalPreimageBytes = encodeCanonical({
		anchor: fixture.anchorDigest,
		author: fixture.author,
		authorSequence: 1,
		dependencies: [dependency],
		epoch: 0,
		kind: "drp-vertex",
		logicalTime: 2,
		objectId: fixture.objectId,
		operation: Object.freeze({ action: "add", value }),
		protocolMajor: 3,
	});
	const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
	const signature = await fixture.signRegisteredVertexDigest(digest);
	return Message.create({
		data: V3Envelope.encode({ canonicalPreimage: canonicalPreimageBytes, signature }).finish(),
		objectId: topic,
		sender: "peer:remote",
		type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
	});
}

it("E5-01 RED keeps the generic admission behavior dormant behind the missing outcome owner", () => {
	expect(policyOwnerReady).toBe(true);
});

describe.skipIf(!policyOwnerReady)("E5-01 serialized v3 operation admission", () => {
	it("rebuilds policy from authenticated recovery before activation effects", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		const trace: string[] = [];
		const policy = tracingPolicy(trace);
		try {
			const recovered = await recover(fixture, fixture.capability, undefined, policy);
			expect(trace).toEqual(["reserve:1", "commit:1"]);
			const network = fakeNetwork("peer:e5-01:recovery");
			const activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
				networkNode: network,
				onAdmittedVertex: vi.fn(),
			});
			expect(activation.ok).toBe(true);
			expect(network.subscribe).toHaveBeenCalledTimes(1);
			if (activation.ok) activation.handle.deactivate();
		} finally {
			await fixture.close();
		}
	});

	it("reserves before local issuance and commits after journal but before projection", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		const trace: string[] = [];
		const policy = tracingPolicy(trace);
		try {
			const recovered = await recover(fixture, fixture.capability, undefined, policy, trace);
			const sink = vi.fn(() => trace.push("sink"));
			const activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork("peer:e5-01:local"),
				onAdmittedVertex: sink,
			});
			if (!activation.ok) throw new TypeError("activation failed");
			trace.length = 0;
			const issued = await activation.handle.issueLocal({
				operations: [Object.freeze({ logicalTime: 2, operation: Object.freeze({ action: "add", value: 7 }) })],
				signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
			});
			expect(issued.ok).toBe(true);
			expect(trace).toEqual(["reserve:7", "issuance", "journal", "commit:7", "sink"]);
			expect(recovered.issuanceStore.transactIssue).toHaveBeenCalledTimes(1);
			expect(recovered.journal.appendAccepted).toHaveBeenCalledTimes(2);
			activation.handle.deactivate();
		} finally {
			await fixture.close();
		}
	});

	it("returns duplicate and conflict before local issuance, journal or projection", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		const policy = tracingPolicy([]);
		try {
			const recovered = await recover(fixture, fixture.capability, undefined, policy);
			const sink = vi.fn();
			const activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork("peer:e5-01:reject"),
				onAdmittedVertex: sink,
			});
			if (!activation.ok) throw new TypeError("activation failed");
			const issue = (value: number): ReturnType<typeof activation.handle.issueLocal> =>
				activation.handle.issueLocal({
					operations: [Object.freeze({ logicalTime: value, operation: Object.freeze({ action: "add", value }) })],
					signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
				});
			const issuanceCalls = vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length;
			const journalCalls = vi.mocked(recovered.journal.appendAccepted).mock.calls.length;
			expect(await issue(901)).toMatchObject({ kind: "admission-rejected", ok: false });
			expect(await issue(902)).toMatchObject({ kind: "admission-rejected", ok: false });
			expect(recovered.issuanceStore.transactIssue).toHaveBeenCalledTimes(issuanceCalls);
			expect(recovered.journal.appendAccepted).toHaveBeenCalledTimes(journalCalls);
			expect(sink).not.toHaveBeenCalled();
			activation.handle.deactivate();
		} finally {
			await fixture.close();
		}
	});

	it("releases a definitely pre-issuance failure and permits one clean retry", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		const trace: string[] = [];
		const policy = tracingPolicy(trace);
		try {
			const recovered = await recover(fixture, fixture.capability, undefined, policy, trace);
			const activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork("peer:e5-01:release"),
				onAdmittedVertex: vi.fn(),
			});
			if (!activation.ok) throw new TypeError("activation failed");
			trace.length = 0;
			vi.mocked(recovered.issuanceStore.transactIssue).mockImplementationOnce(() => {
				trace.push("issuance");
				return Promise.reject(new TypeError("definite pre-issuance failure"));
			});
			const issue = (): ReturnType<typeof activation.handle.issueLocal> =>
				activation.handle.issueLocal({
					operations: [Object.freeze({ logicalTime: 9, operation: Object.freeze({ action: "add", value: 9 }) })],
					signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
				});
			expect(await issue()).toMatchObject({ kind: "issuance-rejected", ok: false });
			expect(trace).toEqual(["reserve:9", "issuance", "release:9"]);
			trace.length = 0;
			expect(await issue()).toMatchObject({ kind: "accepted", ok: true });
			expect(trace).toEqual(["reserve:9", "issuance", "journal", "commit:9"]);
			activation.handle.deactivate();
		} finally {
			await fixture.close();
		}
	});

	it("holds an uncertain post-journal reservation until a fresh recovery rebuilds it exactly once", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		const trace: string[] = [];
		const policy = tracingPolicy(trace);
		try {
			const recovered = await recover(fixture, fixture.capability, undefined, policy, trace);
			const activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork("peer:e5-01:uncertain"),
				onAdmittedVertex: vi.fn(),
			});
			if (!activation.ok) throw new TypeError("activation failed");
			trace.length = 0;
			const append = vi.mocked(recovered.journal.appendAccepted);
			const durableAppend = append.getMockImplementation();
			if (durableAppend === undefined) throw new TypeError("journal fixture is unavailable");
			append.mockImplementationOnce(async (input) => {
				await durableAppend(input);
				throw new TypeError("journal outcome unknown after durable commit");
			});
			const issue = (): ReturnType<typeof activation.handle.issueLocal> =>
				activation.handle.issueLocal({
					operations: [Object.freeze({ logicalTime: 10, operation: Object.freeze({ action: "add", value: 10 }) })],
					signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
				});
			expect(await issue()).toMatchObject({ kind: "journal-rejected", ok: false });
			expect(trace).toEqual(["reserve:10", "issuance", "journal"]);
			const issuanceCalls = vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length;
			expect(await issue()).toMatchObject({ kind: "admission-rejected", ok: false });
			expect(recovered.issuanceStore.transactIssue).toHaveBeenCalledTimes(issuanceCalls);
			activation.handle.deactivate();

			const prepared = await fixture.prepareAgain();
			const recoveryTrace: string[] = [];
			const recoveryPolicy = tracingPolicy(recoveryTrace);
			const reopened = await recoverV3LiveReplica({
				capability: prepared.capability,
				exactCanonicalAuthorAuthorizationBytes: fixture.exactCanonicalAuthorAuthorizationBytes,
				issuanceScope: Object.freeze({ author: fixture.author, objectId: fixture.objectId }),
				issuanceStore: recovered.issuanceStore,
				liveJournalStore: recovered.journal,
				operationAdmissionPolicy: recoveryPolicy,
			} as Parameters<typeof recoverV3LiveReplica>[0]);
			expect(reopened.ok).toBe(true);
			expect(recoveryTrace).toEqual(["reserve:1", "commit:1", "reserve:10", "commit:10"]);
		} finally {
			await fixture.close();
		}
	});

	it("rejects remote replay conflicts before journal and effect while accepting one fresh vertex", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		const trace: string[] = [];
		const policy = tracingPolicy(trace);
		try {
			const recovered = await recover(fixture, fixture.capability, undefined, policy);
			const network = fakeNetwork("peer:e5-01:remote");
			const queue = new ObservedMessageQueueManager<Message>({ logConfig: { level: "silent" } });
			const sink = vi.fn();
			const activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: queue,
				networkNode: network,
				onAdmittedVertex: sink,
			});
			if (!activation.ok) throw new TypeError("activation failed");
			vi.mocked(network.gossipTopicFor).mockReturnValue(activation.handle.topic);
			const accepted = await ingressMessage(fixture, activation.handle.topic, recovered.recoveryVertexDigest, 8);
			const acceptedReceiptPromise = queue.nextReceipt();
			expect(routeV3Ingress(network, accepted)).toBe(true);
			const acceptedReceipt = await acceptedReceiptPromise;
			await acceptedReceipt.processed;
			expect(acceptedReceipt.outcome).toBe("handler-settled");
			expect(sink).toHaveBeenCalledTimes(1);
			const journalCalls = vi.mocked(recovered.journal.appendAccepted).mock.calls.length;
			const rejected = await ingressMessage(fixture, activation.handle.topic, recovered.recoveryVertexDigest, 902);
			const rejectedReceiptPromise = queue.nextReceipt();
			expect(routeV3Ingress(network, rejected)).toBe(true);
			const rejectedReceipt = await rejectedReceiptPromise;
			await rejectedReceipt.processed;
			expect(rejectedReceipt.outcome).toBe("handler-settled");
			expect(trace).toEqual(["reserve:1", "commit:1", "reserve:8", "commit:8", "reserve:902"]);
			expect(recovered.journal.appendAccepted).toHaveBeenCalledTimes(journalCalls);
			expect(sink).toHaveBeenCalledTimes(1);
			activation.handle.deactivate();
		} finally {
			await fixture.close();
		}
	});

	it("preserves ordinary local issue when no policy is supplied", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		try {
			const recovered = await recover(fixture, fixture.capability);
			const activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork("peer:e5-01:no-policy"),
				onAdmittedVertex: vi.fn(),
			});
			if (!activation.ok) throw new TypeError("activation failed");
			expect(
				await activation.handle.issueLocal({
					operations: [Object.freeze({ logicalTime: 2, operation: Object.freeze({ action: "add", value: 5 }) })],
					signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
				})
			).toMatchObject({ kind: "accepted", ok: true });
			activation.handle.deactivate();
		} finally {
			await fixture.close();
		}
	});
});
