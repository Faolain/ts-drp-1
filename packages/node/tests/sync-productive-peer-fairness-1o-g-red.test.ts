/**
 * Phase 1o-g RED: exact-recovery capacity is reclaimed only under pressure,
 * using truthful membership or bounded call-local evidence of no progress.
 * Commit credit belongs to the apply call that physically committed a vertex;
 * authentication, post-state presence, and an overlapping duplicate are not
 * interchangeable with that evidence.
 */
import {
	AdoptionCommitExhaustedError,
	createPermissionlessACL,
	createVertex,
	HashGraph,
	mergeAuthenticatedVertices,
} from "@ts-drp/object";
import * as objectModule from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	Message,
	MessageType,
	Operation,
	type ResolveConflictsType,
	SemanticsType,
	Update,
	type Vertex,
} from "@ts-drp/types";
import { DRP_VERTEX_FUTURE_TOLERANCE_MS } from "@ts-drp/validation";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";
import * as syncState from "../src/sync-state.js";

interface SyncStateCapacity {
	readonly perNode: number;
	readonly perObject: number;
}

interface SyncStatePolicy {
	readonly maxNoProgressStrikes: number;
}

interface FairnessInternals {
	deriveDefaultSyncStateCapacity(): SyncStateCapacity;
	installSyncStateCapacity(node: DRPNode, capacity: SyncStateCapacity, policy?: SyncStatePolicy): void;
}

interface CommittedProvenanceInternals {
	readCommittedProvenance(target: unknown): readonly string[];
}

interface PrivateApplier {
	tryCommitPreparedVertex(...arguments_: unknown[]): "committed" | "duplicate" | "retry";
}

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

interface ApplyGate {
	readonly entered: Deferred;
	invocations: number;
	readonly release: Deferred;
}

const CREATOR_PEER_ID = `12D3KooW${"a".repeat(45)}`;
const EXPECTED_DEFAULT_CAPACITY = Object.freeze({ perNode: 745, perObject: 37 });
const applyGates = new Map<string, ApplyGate>();

const {
	SYNC_RECOVERY_COOLDOWN_MS,
	completePresentExactRequests,
	prepareSyncSend,
	previewSyncSend,
	queueExactRequests,
	recordSharedHeads,
	sharedHashes,
} = syncState;

let readCommittedProvenance: (target: unknown) => readonly string[] = (): readonly string[] => [];

class ControlledLogDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: string[] = [];

	async appendControlled(controlId: string): Promise<void> {
		const gate = applyGates.get(controlId);
		if (gate === undefined) throw new Error(`Missing apply gate ${controlId}`);
		gate.invocations += 1;
		if (gate.invocations === 1) {
			gate.entered.resolve();
			await gate.release.promise;
		}
		this.values.push(controlId);
	}

	append(value: string): void {
		this.values.push(value);
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createApplyGate(id: string): ApplyGate {
	const gate = { entered: deferred(), invocations: 0, release: deferred() };
	applyGates.set(id, gate);
	return gate;
}

function makeNode(seed: string): DRPNode {
	return new DRPNode({
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			log_config: { level: "silent" },
		},
		keychain_config: { private_key_seed: seed },
		log_config: { level: "silent" },
	});
}

function creatorBoundObject(index: number): string {
	return `${CREATOR_PEER_ID}:${index.toString(16).padStart(32, "0")}`;
}

function peer(index: number): string {
	return `12D3KooW${index.toString(36).padStart(45, "b")}`;
}

function hash(index: number): string {
	return index.toString(16).padStart(64, "0");
}

function installCapacity(node: DRPNode, capacity: SyncStateCapacity, maxNoProgressStrikes = 1): void {
	const internals = syncState as unknown as Partial<FairnessInternals>;
	if (typeof internals.installSyncStateCapacity !== "function") {
		throw new Error("Phase 1o-g internal capacity/policy seam is unavailable");
	}
	internals.installSyncStateCapacity(node, capacity, { maxNoProgressStrikes });
}

function installDefaultPolicyCapacity(node: DRPNode, capacity: SyncStateCapacity): void {
	const internals = syncState as unknown as Partial<FairnessInternals>;
	if (typeof internals.installSyncStateCapacity !== "function") {
		throw new Error("Phase 1o-g internal capacity seam is unavailable");
	}
	internals.installSyncStateCapacity(node, capacity);
}

function completeWithCredit(
	node: DRPNode,
	objectId: string,
	peerId: string,
	hasHash: (candidate: string) => boolean,
	creditsHash: (candidate: string) => boolean
): void {
	const complete = completePresentExactRequests as unknown as (
		node: DRPNode,
		objectId: string,
		peerId: string,
		hasHash: (candidate: string) => boolean,
		creditsHash?: (candidate: string) => boolean
	) => void;
	complete(node, objectId, peerId, hasHash, creditsHash);
}

function chargeRejectionBoundary(node: DRPNode, objectId: string, peerId: string): void {
	for (let attempt = 0; attempt < 3; attempt++) {
		expect(prepareSyncSend(node, objectId, peerId, "scheduled-probe").send).toBe(true);
	}
	expect(prepareSyncSend(node, objectId, peerId, "scheduled-probe").send).toBe(false);
}

function expectRetained(node: DRPNode, objectId: string, peerId: string, expected: readonly string[]): void {
	expect(previewSyncSend(node, objectId, peerId, "scheduled-probe").requestedHashes).toEqual(expected);
}

async function signedVertex(
	sender: DRPNode,
	opType: "append" | "appendControlled",
	value: string,
	timestamp: number,
	dependencies: readonly string[] = [HashGraph.rootHash]
): Promise<Vertex> {
	const vertex = createVertex(
		sender.networkNode.peerId,
		Operation.create({ opType, value: [value] }),
		[...dependencies],
		timestamp
	);
	vertex.signature = await sender.keychain.signWithSecp256k1(vertex.hash);
	return vertex;
}

function readCommitted(target: unknown): readonly string[] {
	return readCommittedProvenance(target);
}

async function loadCommittedProvenanceReader(): Promise<void> {
	const moduleUrl = new URL("../../object/src/committed-provenance.js", import.meta.url).href;
	try {
		const internals = (await import(/* @vite-ignore */ moduleUrl)) as Partial<CommittedProvenanceInternals>;
		if (typeof internals.readCommittedProvenance === "function") {
			readCommittedProvenance = internals.readCommittedProvenance;
		}
	} catch {
		// The tests-only RED precedes the deep-internal provenance module.
		readCommittedProvenance = (): readonly string[] => [];
	}
}

function updateMessage(objectId: string, sender: string, vertices: readonly Vertex[]): Message {
	return Message.create({
		data: Update.encode(Update.create({ vertices: [...vertices] })).finish(),
		objectId,
		sender,
		type: MessageType.MESSAGE_TYPE_UPDATE,
	});
}

describe("Phase 1o-g productive-peer fairness lifecycle", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test.each([
		{ capacity: { perNode: 2, perObject: 1 }, candidateObject: 1, name: "per-object" },
		{ capacity: { perNode: 1, perObject: 1 }, candidateObject: 2, name: "node-global" },
	] as const)("reclaims a strike-exhausted active pinner at $name pressure", ({ capacity, candidateObject }) => {
		const node = makeNode(`phase-1o-g-strike-${candidateObject}`);
		nodes.push(node);
		installCapacity(node, capacity);
		const incumbentObject = creatorBoundObject(1);
		const candidateId = creatorBoundObject(candidateObject);
		const incumbentPeer = peer(1);
		const candidatePeer = peer(2);
		const outstanding = hash(1);
		expect(queueExactRequests(node, incumbentObject, incumbentPeer, [outstanding])).toBe(true);
		chargeRejectionBoundary(node, incumbentObject, incumbentPeer);

		recordSharedHeads(node, candidateId, candidatePeer, [hash(2)]);

		expect(sharedHashes(node, candidateId, candidatePeer), "the synchronous pressure candidate wins").toEqual([
			hash(2),
		]);
		expectRetained(node, incumbentObject, incumbentPeer, []);
		expect(
			queueExactRequests(node, incumbentObject, incumbentPeer, [hash(3)]),
			"authentic rediscovery can re-admit the evicted pair"
		).toBe(true);
		expectRetained(node, incumbentObject, incumbentPeer, [hash(3)]);
		expect(
			sharedHashes(node, candidateId, candidatePeer),
			"re-admission reclaims the candidate's dormant slot"
		).toEqual([]);
	});

	test("uses one truthful subscribed membership snapshot, but treats unknown/unstarted membership as present", () => {
		const subscribed = makeNode("phase-1o-g-subscribed-inactive");
		const unknown = makeNode("phase-1o-g-unstarted-unknown");
		nodes.push(subscribed, unknown);
		for (const node of [subscribed, unknown]) installCapacity(node, { perNode: 1, perObject: 1 });
		const objectId = creatorBoundObject(10);
		const incumbentPeer = peer(10);
		const candidatePeer = peer(11);
		for (const node of [subscribed, unknown]) {
			queueExactRequests(node, objectId, incumbentPeer, [hash(10)]);
			prepareSyncSend(node, objectId, incumbentPeer, "scheduled-probe");
		}
		const subscribedTopics = vi.spyOn(subscribed.networkNode, "getSubscribedTopics").mockReturnValue([objectId]);
		const subscribedPeers = vi.spyOn(subscribed.networkNode, "getGroupPeers").mockReturnValue([]);
		const unknownTopics = vi.spyOn(unknown.networkNode, "getSubscribedTopics").mockReturnValue([]);
		const unknownPeers = vi.spyOn(unknown.networkNode, "getGroupPeers").mockImplementation(() => {
			throw new Error("unknown membership must not be consulted");
		});

		recordSharedHeads(subscribed, objectId, candidatePeer, [hash(11)]);
		recordSharedHeads(unknown, objectId, candidatePeer, [hash(11)]);

		expect(sharedHashes(subscribed, objectId, candidatePeer), "known absence is the second victim tier").toEqual([
			hash(11),
		]);
		expectRetained(subscribed, objectId, incumbentPeer, []);
		expect(sharedHashes(unknown, objectId, candidatePeer), "unknown membership fails closed").toEqual([]);
		expectRetained(unknown, objectId, incumbentPeer, [hash(10)]);
		expect(subscribedTopics).toHaveBeenCalledTimes(1);
		expect(subscribedPeers).toHaveBeenCalledTimes(1);
		expect(unknownTopics).toHaveBeenCalledTimes(1);
		expect(unknownPeers).not.toHaveBeenCalled();
	});

	test("refuses atomically below every victim tier and leaves the incumbent lifecycle unchanged", () => {
		const node = makeNode("phase-1o-g-no-victim");
		nodes.push(node);
		installCapacity(node, { perNode: 1, perObject: 1 });
		const objectId = creatorBoundObject(20);
		const incumbentPeer = peer(20);
		const candidatePeer = peer(21);
		queueExactRequests(node, objectId, incumbentPeer, [hash(20)]);
		expect(prepareSyncSend(node, objectId, incumbentPeer, "scheduled-probe").send).toBe(true);
		vi.spyOn(node.networkNode, "getSubscribedTopics").mockReturnValue([]);

		recordSharedHeads(node, objectId, candidatePeer, [hash(21)]);

		expect(sharedHashes(node, objectId, candidatePeer)).toEqual([]);
		expectRetained(node, objectId, incumbentPeer, [hash(20)]);
		expect(prepareSyncSend(node, objectId, incumbentPeer, "scheduled-probe").send).toBe(true);
	});

	test("bounds changed-set delay: one uncredited removal batch strikes even while another of 64 hashes remains", () => {
		const node = makeNode("phase-1o-g-bounded-drain-refill");
		nodes.push(node);
		installCapacity(node, { perNode: 1, perObject: 1 }, 2);
		const objectId = creatorBoundObject(30);
		const incumbentPeer = peer(30);
		const candidatePeer = peer(31);
		const offered = Array.from({ length: 64 }, (_, index) => hash(100 + index));
		const seed = offered[0];
		const survivor = offered[63];
		if (seed === undefined || survivor === undefined) throw new Error("Expected the bounded exact-request endpoints");
		expect(queueExactRequests(node, objectId, incumbentPeer, [seed])).toBe(true);
		chargeRejectionBoundary(node, objectId, incumbentPeer);
		for (const changedHash of offered.slice(1)) {
			expect(queueExactRequests(node, objectId, incumbentPeer, [changedHash])).toBe(true);
			expect(
				prepareSyncSend(node, objectId, incumbentPeer, "scheduled-probe").send,
				"a distinct changed set keeps its existing reset behavior"
			).toBe(true);
		}
		completeWithCredit(
			node,
			objectId,
			incumbentPeer,
			(candidate) => candidate !== survivor,
			() => false
		);
		expectRetained(node, objectId, incumbentPeer, [survivor]);

		recordSharedHeads(node, objectId, candidatePeer, [hash(200)]);

		expect(sharedHashes(node, objectId, candidatePeer)).toEqual([hash(200)]);
		expectRetained(node, objectId, incumbentPeer, []);
	});

	test("makes an uncredited full drain/refill cycle finite instead of restarting tenure", () => {
		const node = makeNode("phase-1o-g-full-drain-refill");
		nodes.push(node);
		installCapacity(node, { perNode: 1, perObject: 1 });
		const objectId = creatorBoundObject(35);
		const incumbentPeer = peer(35);
		const candidatePeer = peer(36);
		queueExactRequests(node, objectId, incumbentPeer, [hash(350)]);
		completeWithCredit(
			node,
			objectId,
			incumbentPeer,
			() => true,
			() => false
		);
		expect(queueExactRequests(node, objectId, incumbentPeer, [hash(351)])).toBe(true);

		recordSharedHeads(node, objectId, candidatePeer, [hash(352)]);

		expect(sharedHashes(node, objectId, candidatePeer)).toEqual([hash(352)]);
		expectRetained(node, objectId, incumbentPeer, []);
	});

	test("keeps the frozen four-argument completion reset while preserving an existing strike across drain/refill", () => {
		const node = makeNode("phase-1o-g-frozen-helper");
		nodes.push(node);
		installCapacity(node, { perNode: 1, perObject: 1 });
		const objectId = creatorBoundObject(40);
		const incumbentPeer = peer(40);
		const candidatePeer = peer(41);
		queueExactRequests(node, objectId, incumbentPeer, [hash(40)]);
		chargeRejectionBoundary(node, objectId, incumbentPeer);

		completePresentExactRequests(node, objectId, incumbentPeer, () => true);
		expect(queueExactRequests(node, objectId, incumbentPeer, [hash(41)])).toBe(true);
		expect(
			prepareSyncSend(node, objectId, incumbentPeer, "scheduled-probe"),
			"the frozen helper still clears attempts and cooldown"
		).toMatchObject({ requestedHashes: [hash(41)], send: true });
		recordSharedHeads(node, objectId, candidatePeer, [hash(42)]);

		expect(
			sharedHashes(node, objectId, candidatePeer),
			"the absent credit predicate does not erase the strike"
		).toEqual([hash(42)]);
	});

	test("resets strikes only for an attributable committed removal; mixed removals are productive on that basis", () => {
		const node = makeNode("phase-1o-g-attributable-reset");
		nodes.push(node);
		installCapacity(node, { perNode: 1, perObject: 1 });
		const objectId = creatorBoundObject(50);
		const incumbentPeer = peer(50);
		const candidatePeer = peer(51);
		const credited = hash(50);
		const uncredited = hash(51);
		const survivor = hash(52);
		queueExactRequests(node, objectId, incumbentPeer, [credited, uncredited, survivor]);
		chargeRejectionBoundary(node, objectId, incumbentPeer);

		completeWithCredit(
			node,
			objectId,
			incumbentPeer,
			(candidate) => candidate !== survivor,
			(candidate) => candidate === credited
		);
		recordSharedHeads(node, objectId, candidatePeer, [hash(53)]);

		expect(sharedHashes(node, objectId, candidatePeer), "productive evidence resets the strike").toEqual([]);
		expectRetained(node, objectId, incumbentPeer, [survivor]);
	});

	test("uses exactly three no-progress strikes in the uninjected production policy", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const node = makeNode("phase-1o-g-default-three-strikes");
		nodes.push(node);
		installDefaultPolicyCapacity(node, { perNode: 1, perObject: 1 });
		const objectId = creatorBoundObject(60);
		const incumbentPeer = peer(60);
		const candidatePeer = peer(61);
		queueExactRequests(node, objectId, incumbentPeer, [hash(60)]);

		chargeRejectionBoundary(node, objectId, incumbentPeer);
		vi.advanceTimersByTime(SYNC_RECOVERY_COOLDOWN_MS);
		chargeRejectionBoundary(node, objectId, incumbentPeer);
		recordSharedHeads(node, objectId, candidatePeer, [hash(61)]);
		expect(sharedHashes(node, objectId, candidatePeer), "two production strikes remain below threshold").toEqual([]);
		vi.advanceTimersByTime(SYNC_RECOVERY_COOLDOWN_MS);
		expectRetained(node, objectId, incumbentPeer, [hash(60)]);

		chargeRejectionBoundary(node, objectId, incumbentPeer);
		recordSharedHeads(node, objectId, candidatePeer, [hash(61)]);
		expect(sharedHashes(node, objectId, candidatePeer), "the third production strike is reclaimable").toEqual([
			hash(61),
		]);
		expectRetained(node, objectId, incumbentPeer, []);
	});

	test("retains the accepted production capacity boundary", () => {
		const internals = syncState as unknown as Partial<FairnessInternals>;
		expect(internals.deriveDefaultSyncStateCapacity?.()).toEqual(EXPECTED_DEFAULT_CAPACITY);
	});
});

describe("Phase 1o-g call-local committed provenance", () => {
	const sender = makeNode("phase-1o-g-provenance-sender");
	const receiver = makeNode("phase-1o-g-provenance-receiver");

	beforeAll(async () => {
		await loadCommittedProvenanceReader();
		await Promise.all([sender.start(), receiver.start()]);
		vi.spyOn(sender.networkNode, "broadcastMessage").mockResolvedValue();
		vi.spyOn(receiver.networkNode, "broadcastMessage").mockResolvedValue();
	});

	afterEach(() => {
		applyGates.clear();
	});

	afterAll(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled([sender.stop(), receiver.stop()]);
	});

	test("attributes a successful overlapping same-hash commit to B, never the post-state observer A", async () => {
		const object = await receiver.createObject({
			acl: createPermissionlessACL(),
			drp: new ControlledLogDRP(),
		});
		const gate = createApplyGate("successful-overlap");
		const shared = await signedVertex(sender, "appendControlled", "successful-overlap", Date.now());
		const callA = mergeAuthenticatedVertices(object, [shared]);
		await gate.entered.promise;
		const callB = mergeAuthenticatedVertices(object, [shared]);
		const outcomeB = await callB;
		gate.release.resolve();
		const outcomeA = await callA;

		expect(object.getVertex(shared.hash), "positive control: B physically commits the shared vertex").toBeDefined();
		expect(outcomeB.committed.map(({ hash: candidate }) => candidate)).toEqual([shared.hash]);
		expect(
			outcomeA.committed.map(({ hash: candidate }) => candidate),
			"A only observes B's post-state"
		).toEqual([]);
		expect(readCommitted(outcomeB.result)).toEqual([shared.hash]);
		expect(readCommitted(outcomeA.result)).toEqual([]);
		expect(readCommitted([...outcomeB.result])).toEqual([]);
		expect(readCommitted({ applied: true, invalid: [], missing: [], committed: [shared.hash] })).toEqual([]);

		const duplicate = await mergeAuthenticatedVertices(object, [shared]);
		expect(duplicate.committed, "a later duplicate never refreshes credit").toEqual([]);
		expect(readCommitted(duplicate.result)).toEqual([]);
	});

	test("does not manufacture commit credit from authenticated receiver-clock-pending input", async () => {
		const object = await receiver.createObject({
			acl: createPermissionlessACL(),
			drp: new ControlledLogDRP(),
		});
		const now = Date.now();
		const pending = await signedVertex(
			sender,
			"append",
			"clock-pending",
			now + DRP_VERTEX_FUTURE_TOLERANCE_MS + 10_000
		);

		const outcome = await mergeAuthenticatedVertices(object, [pending]);

		expect(outcome.authenticatedHashes, "positive control: signature authentication succeeds").toEqual([pending.hash]);
		expect(outcome.clockPending, "positive control: receiver time, not invalidity, defers the vertex").toEqual([
			pending.hash,
		]);
		expect(outcome.committed).toEqual([]);
		expect(readCommitted(outcome.result)).toEqual([]);
		expect(object.getVertex(pending.hash)).toBeUndefined();
	});

	test("credits a real UPDATE only to A's own commit, never to A's third-party post-state observation", async () => {
		const peerA = makeNode("phase-1o-g-handler-peer-a");
		const peerB = makeNode("phase-1o-g-handler-peer-b");
		const ownReceiver = makeNode("phase-1o-g-handler-own-receiver");
		const racedReceiver = makeNode("phase-1o-g-handler-raced-receiver");
		const localNodes = [peerA, peerB, ownReceiver, racedReceiver];
		await Promise.all(localNodes.map((node) => node.start()));
		try {
			installCapacity(ownReceiver, { perNode: 1, perObject: 1 });
			const ownObject = await ownReceiver.createObject({
				acl: createPermissionlessACL(),
				drp: new ControlledLogDRP(),
				finality_config: { enabled: false },
			});
			vi.spyOn(ownReceiver.networkNode, "getSubscribedTopics").mockReturnValue([ownObject.id]);
			vi.spyOn(ownReceiver.networkNode, "getGroupPeers").mockReturnValue([peerA.networkNode.peerId]);
			const own = await signedVertex(peerA, "append", "own-handler-commit", Date.now() + 100);
			const ownSurvivor = hash(700);
			queueExactRequests(ownReceiver, ownObject.id, peerA.networkNode.peerId, [own.hash, ownSurvivor]);
			chargeRejectionBoundary(ownReceiver, ownObject.id, peerA.networkNode.peerId);

			await handleMessage(ownReceiver, updateMessage(ownObject.id, peerA.networkNode.peerId, [own]));
			recordSharedHeads(ownReceiver, ownObject.id, peer(701), [hash(701)]);
			expect(
				sharedHashes(ownReceiver, ownObject.id, peer(701)),
				"A's physically committed UPDATE resets its strike"
			).toEqual([]);
			expectRetained(ownReceiver, ownObject.id, peerA.networkNode.peerId, [ownSurvivor]);

			installCapacity(racedReceiver, { perNode: 1, perObject: 1 });
			const racedObject = await racedReceiver.createObject({
				acl: createPermissionlessACL(),
				drp: new ControlledLogDRP(),
				finality_config: { enabled: false },
			});
			vi.spyOn(racedReceiver.networkNode, "getSubscribedTopics").mockReturnValue([racedObject.id]);
			vi.spyOn(racedReceiver.networkNode, "getGroupPeers").mockReturnValue([
				peerA.networkNode.peerId,
				peerB.networkNode.peerId,
			]);
			const gate = createApplyGate("handler-third-party-overlap");
			const shared = await signedVertex(peerB, "appendControlled", "handler-third-party-overlap", Date.now() + 200);
			const racedSurvivor = hash(710);
			queueExactRequests(racedReceiver, racedObject.id, peerA.networkNode.peerId, [shared.hash, racedSurvivor]);
			chargeRejectionBoundary(racedReceiver, racedObject.id, peerA.networkNode.peerId);
			const callA = handleMessage(racedReceiver, updateMessage(racedObject.id, peerA.networkNode.peerId, [shared]));
			await gate.entered.promise;
			await handleMessage(racedReceiver, updateMessage(racedObject.id, peerB.networkNode.peerId, [shared]));
			gate.release.resolve();
			await callA;

			recordSharedHeads(racedReceiver, racedObject.id, peer(711), [hash(711)]);
			expect(
				sharedHashes(racedReceiver, racedObject.id, peer(711)),
				"B's commit cannot reset A merely because A later observes the hash"
			).toEqual([hash(711)]);
			expectRetained(racedReceiver, racedObject.id, peerA.networkNode.peerId, []);
		} finally {
			for (const gate of applyGates.values()) gate.release.resolve();
			await Promise.allSettled(localNodes.map((node) => node.stop()));
		}
	});

	test("propagates rejected-boundary credit from A while an earlier same-hash B becomes a duplicate", async () => {
		const object = await receiver.createObject({
			acl: createPermissionlessACL(),
			drp: new ControlledLogDRP(),
		});
		const gate = createApplyGate("rejected-overlap");
		const shared = await signedVertex(sender, "appendControlled", "rejected-overlap", Date.now() + 1);
		const poison = await signedVertex(sender, "append", "poison", Date.now() + 2, [shared.hash]);
		const applier = (object as unknown as { _applier: PrivateApplier })._applier;
		const originalTryCommit = applier.tryCommitPreparedVertex;
		let committedShared = false;
		applier.tryCommitPreparedVertex = function (...arguments_: unknown[]): "committed" | "duplicate" | "retry" {
			if (committedShared) return "retry";
			const outcome = originalTryCommit.apply(this, arguments_);
			if (outcome === "committed") committedShared = true;
			return outcome;
		};
		const callB = mergeAuthenticatedVertices(object, [shared]);
		await gate.entered.promise;
		let boundaryError: unknown;
		try {
			await mergeAuthenticatedVertices(object, [shared, poison]);
		} catch (error) {
			boundaryError = error;
		} finally {
			applier.tryCommitPreparedVertex = originalTryCommit;
		}
		gate.release.resolve();
		const outcomeB = await callB;

		expect(boundaryError).toBeInstanceOf(AdoptionCommitExhaustedError);
		expect(object.getVertex(shared.hash), "positive control: rejected call A committed shared first").toBeDefined();
		expect(outcomeB.committed, "B cannot borrow A's rejected-boundary commit").toEqual([]);
		expect(readCommitted(boundaryError)).toEqual([shared.hash]);
		if (!(boundaryError instanceof AdoptionCommitExhaustedError)) throw new Error("Expected rejected boundary");
		expect(readCommitted(boundaryError.partialResult)).toEqual([shared.hash]);
		expect(readCommitted({ ...boundaryError.partialResult })).toEqual([]);
	});
});

describe("Phase 1o-g production completion owners", () => {
	test("keeps committed provenance off the public object package surface", () => {
		expect("readCommittedProvenance" in objectModule).toBe(false);
		expect("readAuthenticatedCommitted" in objectModule).toBe(false);
	});

	test("passes explicit credit at every direct production completion owner without changing the frozen helper", () => {
		const sourcePath = new URL("../src/handlers.ts", import.meta.url);
		const source = readFileSync(sourcePath, "utf8");
		const parsed = ts.createSourceFile(sourcePath.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const owners: { argumentCount: number; hasExplicitCredit: boolean; owner: string }[] = [];
		const functions: string[] = [];
		const visit = (node: ts.Node): void => {
			let entered: string | undefined;
			if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
				entered = node.name.text;
				functions.push(entered);
			}
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === "completePresentExactRequests"
			) {
				const credit = node.arguments[4];
				owners.push({
					argumentCount: node.arguments.length,
					hasExplicitCredit: credit !== undefined && !(ts.isIdentifier(credit) && credit.text === "undefined"),
					owner: functions.at(-1) ?? "<module>",
				});
			}
			ts.forEachChild(node, visit);
			if (entered !== undefined) functions.pop();
		};
		visit(parsed);

		expect(owners).toEqual([
			{ argumentCount: 5, hasExplicitCredit: true, owner: "mergeWithRejectedBoundaryRecovery" },
			{ argumentCount: 5, hasExplicitCredit: true, owner: "updateHandlerUntraced" },
			{ argumentCount: 5, hasExplicitCredit: true, owner: "syncAcceptHandlerUntraced" },
		]);
	});
});
