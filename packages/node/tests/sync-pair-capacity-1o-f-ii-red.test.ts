/**
 * Phase 1o-f(ii) RED: the node-owned sync ledger admits `(object, peer)` pairs
 * atomically under finite per-object and per-node capacities. The injectable
 * seam imported here is internal to `sync-state.ts`; it must not become public
 * package configuration, an environment hook, or an unlimited/test-mode path.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { DRPNode } from "../src/index.js";
import * as syncState from "../src/sync-state.js";

const {
	SYNC_RECOVERY_COOLDOWN_MS,
	advertisedTheseHeads,
	clearNodeSyncState,
	completePresentExactRequests,
	prepareSyncSend,
	previewSyncSend,
	queueExactRequests,
	recordAdvertisedHeads,
	recordBranchCuts,
	recordSharedHeads,
	sharedHashes,
} = syncState;

interface SyncStateCapacity {
	readonly perNode: number;
	readonly perObject: number;
}

interface CapacityInternals {
	deriveDefaultSyncStateCapacity(): SyncStateCapacity;
	installSyncStateCapacity(node: DRPNode, capacity: SyncStateCapacity): void;
	isDormantSyncLifecycle(outstandingCount: number, attemptCount: number, cooldownUntil?: number): boolean;
}

const EXPECTED_DEFAULT_CAPACITY = Object.freeze({ perNode: 759, perObject: 37 });
const CREATOR_PEER_ID = `12D3KooW${"a".repeat(45)}`;

function deriveDefaultCapacity(): SyncStateCapacity {
	const candidate = syncState as unknown as Partial<CapacityInternals>;
	if (typeof candidate.deriveDefaultSyncStateCapacity !== "function") {
		throw new Error("Phase 1o-f(ii) deterministic default owner is not implemented");
	}
	return candidate.deriveDefaultSyncStateCapacity();
}

function installCapacity(node: DRPNode, capacity: SyncStateCapacity): void {
	const candidate = syncState as unknown as Partial<CapacityInternals>;
	if (typeof candidate.installSyncStateCapacity !== "function") {
		throw new Error("Phase 1o-f(ii) internal tiny-capacity seam is not implemented");
	}
	candidate.installSyncStateCapacity(node, capacity);
}

function isDormantSyncLifecycle(outstandingCount: number, attemptCount: number, cooldownUntil?: number): boolean {
	const candidate = syncState as unknown as Partial<CapacityInternals>;
	if (typeof candidate.isDormantSyncLifecycle !== "function") {
		throw new Error("Phase 1o-f(ii) pure sync-lifecycle dormancy owner is not implemented");
	}
	return candidate.isDormantSyncLifecycle(outstandingCount, attemptCount, cooldownUntil);
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

function expectExact(node: DRPNode, objectId: string, peerId: string, expected: readonly string[]): void {
	expect(previewSyncSend(node, objectId, peerId, "scheduled-probe").requestedHashes).toEqual(expected);
}

function expectRetainedExact(node: DRPNode, objectId: string, peerId: string, expected: readonly string[]): void {
	const retained: string[] = [];
	completePresentExactRequests(node, objectId, peerId, (candidate) => {
		retained.push(candidate);
		return false;
	});
	expect(retained).toEqual(expected);
}

describe("Phase 1o-f(ii) finite sync-pair admission", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("derives the accepted finite production defaults", () => {
		expect(deriveDefaultCapacity()).toEqual(EXPECTED_DEFAULT_CAPACITY);
	});

	test("enforces both finite limits on the uninjected production path", () => {
		const perObjectOwner = makeNode("phase-1o-f-ii-default-per-object");
		const globalOwner = makeNode("phase-1o-f-ii-default-global");
		nodes.push(perObjectOwner, globalOwner);

		const oneObject = creatorBoundObject(1);
		for (let index = 0; index <= EXPECTED_DEFAULT_CAPACITY.perObject; index++) {
			recordSharedHeads(perObjectOwner, oneObject, peer(index), [hash(index + 1)]);
		}
		expect
			.soft(sharedHashes(perObjectOwner, oneObject, peer(0)), "pair 38 evicts the oldest of 37 dormant pairs")
			.toEqual([]);
		expect
			.soft(sharedHashes(perObjectOwner, oneObject, peer(EXPECTED_DEFAULT_CAPACITY.perObject)))
			.toEqual([hash(EXPECTED_DEFAULT_CAPACITY.perObject + 1)]);

		for (let index = 0; index < EXPECTED_DEFAULT_CAPACITY.perNode; index++) {
			const objectIndex = Math.floor(index / EXPECTED_DEFAULT_CAPACITY.perObject) + 10;
			recordSharedHeads(globalOwner, creatorBoundObject(objectIndex), peer(index), [hash(index + 1_000)]);
		}
		const lastObject = creatorBoundObject(99);
		const lastPeer = peer(EXPECTED_DEFAULT_CAPACITY.perNode);
		recordSharedHeads(globalOwner, lastObject, lastPeer, [hash(9_999)]);
		expect
			.soft(
				sharedHashes(globalOwner, creatorBoundObject(10), peer(0)),
				"pair 760 evicts the globally oldest dormant pair"
			)
			.toEqual([]);
		expect.soft(sharedHashes(globalOwner, lastObject, lastPeer)).toEqual([hash(9_999)]);
	});

	test.each([
		{
			attemptCount: 0,
			cooldownUntil: undefined,
			dormant: true,
			name: "the empty lifecycle",
			outstandingCount: 0,
		},
		{
			attemptCount: 0,
			cooldownUntil: undefined,
			dormant: false,
			name: "outstanding work alone",
			outstandingCount: 1,
		},
		{
			attemptCount: 1,
			cooldownUntil: undefined,
			dormant: false,
			name: "a nonzero attempt alone",
			outstandingCount: 0,
		},
		{
			attemptCount: 0,
			cooldownUntil: Number.MAX_SAFE_INTEGER,
			dormant: false,
			name: "an active defined cooldown alone",
			outstandingCount: 0,
		},
		{
			attemptCount: 0,
			cooldownUntil: 0,
			dormant: false,
			name: "an expired-but-defined cooldown alone",
			outstandingCount: 0,
		},
	] as const)("classifies $name independently in the pure eviction predicate", (lifecycle) => {
		expect(isDormantSyncLifecycle(lifecycle.outstandingCount, lifecycle.attemptCount, lifecycle.cooldownUntil)).toBe(
			lifecycle.dormant
		);
	});

	test.each([
		{
			name: "advertised heads",
			write(node: DRPNode, objectId: string, peerId: string): void {
				recordAdvertisedHeads(node, objectId, peerId, [hash(201)]);
			},
			wasAdmitted(node: DRPNode, objectId: string, peerId: string): boolean {
				return advertisedTheseHeads(node, objectId, peerId, [hash(201)]);
			},
		},
		{
			name: "shared heads",
			write(node: DRPNode, objectId: string, peerId: string): void {
				recordSharedHeads(node, objectId, peerId, [hash(202)]);
			},
			wasAdmitted(node: DRPNode, objectId: string, peerId: string): boolean {
				return sharedHashes(node, objectId, peerId).includes(hash(202));
			},
		},
		{
			name: "branch cuts",
			write(node: DRPNode, objectId: string, peerId: string): void {
				recordBranchCuts(node, objectId, peerId, [hash(203)]);
			},
			wasAdmitted(node: DRPNode, objectId: string, peerId: string): boolean {
				return sharedHashes(node, objectId, peerId).includes(hash(203));
			},
		},
		{
			name: "exact requests",
			write(node: DRPNode, objectId: string, peerId: string): void {
				queueExactRequests(node, objectId, peerId, [hash(204)]);
			},
			wasAdmitted(node: DRPNode, objectId: string, peerId: string): boolean {
				return previewSyncSend(node, objectId, peerId, "scheduled-probe").requestedHashes.includes(hash(204));
			},
		},
		{
			name: "charged send preparation",
			write(node: DRPNode, objectId: string, peerId: string): void {
				expect(prepareSyncSend(node, objectId, peerId, "scheduled-probe").send).toBe(false);
			},
			wasAdmitted(): boolean {
				return false;
			},
		},
	])("routes $name through the one atomic owner and refuses it before mutation when every slot is pinned", (writer) => {
		const node = makeNode(`phase-1o-f-ii-writer-${writer.name}`);
		nodes.push(node);
		installCapacity(node, { perNode: 1, perObject: 1 });
		const incumbentObject = creatorBoundObject(200);
		const incumbentPeer = peer(200);
		const candidateObject = creatorBoundObject(201);
		const candidatePeer = peer(201);
		const outstanding = hash(200);
		expect(queueExactRequests(node, incumbentObject, incumbentPeer, [outstanding])).toBe(true);
		expect(prepareSyncSend(node, incumbentObject, incumbentPeer, "scheduled-probe").send).toBe(true);
		const dispatch = vi.spyOn(node, "safeDispatchEvent");

		writer.write(node, candidateObject, candidatePeer);

		expect(writer.wasAdmitted(node, candidateObject, candidatePeer), "the refused pair is not retained").toBe(false);
		expectExact(node, incumbentObject, incumbentPeer, [outstanding]);
		expect(dispatch, "capacity refusal emits no retry/lifecycle event").not.toHaveBeenCalled();
		for (let attempt = 0; attempt < 2; attempt++) {
			expect(prepareSyncSend(node, incumbentObject, incumbentPeer, "scheduled-probe").send).toBe(true);
		}
		expect(prepareSyncSend(node, incumbentObject, incumbentPeer, "scheduled-probe").send).toBe(false);
		expect(dispatch, "the incumbent reaches its unchanged rejection boundary exactly once").toHaveBeenCalledTimes(1);
	});

	test("uses monotonic admission age: reads and existing-pair writes never refresh the oldest dormant pair", () => {
		const node = makeNode("phase-1o-f-ii-monotonic-age");
		nodes.push(node);
		installCapacity(node, { perNode: 2, perObject: 2 });
		const objectId = creatorBoundObject(300);
		const peerA = peer(300);
		const peerB = peer(301);
		const peerC = peer(302);
		recordSharedHeads(node, objectId, peerA, [hash(300)]);
		recordSharedHeads(node, objectId, peerB, [hash(301)]);

		expect(sharedHashes(node, objectId, peerA)).toEqual([hash(300)]);
		recordAdvertisedHeads(node, objectId, peerA, [hash(303)]);
		recordSharedHeads(node, objectId, peerA, [hash(300)]);
		recordSharedHeads(node, objectId, peerC, [hash(302)]);

		expect(sharedHashes(node, objectId, peerA), "the oldest admission is evicted despite later access").toEqual([]);
		expect(sharedHashes(node, objectId, peerB)).toEqual([hash(301)]);
		expect(sharedHashes(node, objectId, peerC)).toEqual([hash(302)]);
	});

	test.each([
		{ attempts: 0, cooldown: "none", name: "outstanding work before its first attempt" },
		{ attempts: 1, cooldown: "none", name: "outstanding work after one attempt" },
		{ attempts: 3, cooldown: "active", name: "outstanding work during an active cooldown" },
		{ attempts: 3, cooldown: "expired", name: "outstanding work during an expired-but-defined cooldown" },
	] as const)("keeps the reachable lifecycle shape pinned with $name", ({ attempts, cooldown }) => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const node = makeNode(`phase-1o-f-ii-pin-${attempts}-${cooldown}`);
		nodes.push(node);
		installCapacity(node, { perNode: 1, perObject: 1 });
		const objectId = creatorBoundObject(400 + attempts);
		const incumbentPeer = peer(400 + attempts);
		const candidatePeer = peer(410 + attempts);
		const outstanding = hash(400 + attempts);
		queueExactRequests(node, objectId, incumbentPeer, [outstanding]);
		for (let attempt = 0; attempt < attempts; attempt++) {
			expect(prepareSyncSend(node, objectId, incumbentPeer, "scheduled-probe").send).toBe(true);
		}
		if (cooldown !== "none") {
			expect(prepareSyncSend(node, objectId, incumbentPeer, "scheduled-probe").send).toBe(false);
			if (cooldown === "expired") vi.advanceTimersByTime(SYNC_RECOVERY_COOLDOWN_MS);
		}

		recordSharedHeads(node, objectId, candidatePeer, [hash(499)]);

		expect(sharedHashes(node, objectId, candidatePeer), "a pinned incumbent cannot be evicted").toEqual([]);
		expectRetainedExact(node, objectId, incumbentPeer, [outstanding]);
	});

	test("refuses per-object and node-global admission atomically without evicting an unrelated dormant pair", () => {
		const perObjectOwner = makeNode("phase-1o-f-ii-per-object-atomic");
		const globalOwner = makeNode("phase-1o-f-ii-global-atomic");
		nodes.push(perObjectOwner, globalOwner);
		installCapacity(perObjectOwner, { perNode: 3, perObject: 1 });
		installCapacity(globalOwner, { perNode: 2, perObject: 2 });

		const objectA = creatorBoundObject(500);
		const objectB = creatorBoundObject(501);
		const objectC = creatorBoundObject(502);
		const objectD = creatorBoundObject(503);
		queueExactRequests(perObjectOwner, objectA, peer(500), [hash(500)]);
		recordSharedHeads(perObjectOwner, objectB, peer(501), [hash(501)]);
		recordSharedHeads(perObjectOwner, objectC, peer(503), [hash(503)]);
		recordSharedHeads(perObjectOwner, objectA, peer(502), [hash(502)]);
		expect(sharedHashes(perObjectOwner, objectA, peer(502)), "per-object refusal retains no candidate").toEqual([]);
		expect(sharedHashes(perObjectOwner, objectB, peer(501)), "refusal evicts no unrelated dormant pair").toEqual([
			hash(501),
		]);
		recordSharedHeads(perObjectOwner, objectD, peer(504), [hash(504)]);
		expect(
			sharedHashes(perObjectOwner, objectB, peer(501)),
			"failed per-object admission neither sacrifices nor refreshes the oldest global dormant slot"
		).toEqual([]);
		expect(sharedHashes(perObjectOwner, objectC, peer(503))).toEqual([hash(503)]);
		expect(sharedHashes(perObjectOwner, objectD, peer(504))).toEqual([hash(504)]);

		queueExactRequests(globalOwner, objectA, peer(510), [hash(510)]);
		queueExactRequests(globalOwner, objectB, peer(511), [hash(511)]);
		recordSharedHeads(globalOwner, creatorBoundObject(504), peer(512), [hash(512)]);
		expect(
			sharedHashes(globalOwner, creatorBoundObject(504), peer(512)),
			"global refusal retains no candidate"
		).toEqual([]);
		expectExact(globalOwner, objectA, peer(510), [hash(510)]);
		expectExact(globalOwner, objectB, peer(511), [hash(511)]);
	});

	test("keeps expired cooldown pinned until normal preparation resumes egress, then reclaims the completed pair", () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_000_000);
		const node = makeNode("phase-1o-f-ii-expired-resumption");
		nodes.push(node);
		installCapacity(node, { perNode: 1, perObject: 1 });
		const objectId = creatorBoundObject(600);
		const incumbentPeer = peer(600);
		const candidatePeer = peer(601);
		const outstanding = hash(600);
		queueExactRequests(node, objectId, incumbentPeer, [outstanding]);
		for (let attempt = 0; attempt < 3; attempt++) {
			expect(prepareSyncSend(node, objectId, incumbentPeer, "scheduled-probe")).toMatchObject({
				requestedHashes: [outstanding],
				send: true,
			});
		}
		expect(prepareSyncSend(node, objectId, incumbentPeer, "scheduled-probe").send).toBe(false);
		vi.advanceTimersByTime(SYNC_RECOVERY_COOLDOWN_MS);

		recordSharedHeads(node, objectId, candidatePeer, [hash(601)]);
		expect(sharedHashes(node, objectId, candidatePeer), "expiry alone is not an eviction transition").toEqual([]);
		expect(prepareSyncSend(node, objectId, incumbentPeer, "scheduled-probe")).toMatchObject({
			requestedHashes: [outstanding],
			send: true,
		});
		completePresentExactRequests(node, objectId, incumbentPeer, (candidate) => candidate === outstanding);
		recordSharedHeads(node, objectId, candidatePeer, [hash(601)]);
		expect(sharedHashes(node, objectId, incumbentPeer)).toEqual([]);
		expect(sharedHashes(node, objectId, candidatePeer)).toEqual([hash(601)]);
	});

	test("public object unsubscribe and node stop release pinned capacity and every retained hint", async () => {
		const node = makeNode("phase-1o-f-ii-lifecycle-cleanup");
		nodes.push(node);
		installCapacity(node, { perNode: 1, perObject: 1 });
		await node.start();
		const first = await node.createObject({ finality_config: { enabled: false } });
		const second = await node.createObject({ finality_config: { enabled: false } });
		const firstPeer = peer(700);
		const secondPeer = peer(701);
		queueExactRequests(node, first.id, firstPeer, [hash(700)]);
		recordSharedHeads(node, first.id, firstPeer, [hash(701)]);

		node.unsubscribeObject(first.id, true);
		recordSharedHeads(node, second.id, secondPeer, [hash(702)]);
		expect(sharedHashes(node, first.id, firstPeer)).toEqual([]);
		expect(sharedHashes(node, second.id, secondPeer)).toEqual([hash(702)]);
		recordAdvertisedHeads(node, second.id, secondPeer, [hash(703)]);
		recordBranchCuts(node, second.id, secondPeer, [hash(704)]);
		queueExactRequests(node, second.id, secondPeer, [hash(705)]);

		await node.stop();
		expect(sharedHashes(node, second.id, secondPeer)).toEqual([]);
		expect(advertisedTheseHeads(node, second.id, secondPeer, [hash(703)])).toBe(false);
		expectRetainedExact(node, second.id, secondPeer, []);
		clearNodeSyncState(node);
	});
});
