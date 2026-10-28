/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent test observers retain real runtime signatures. */
// Case 1 (a withheld Writer vertex stalls the creator's own issue), lossy-relay shape.
// A Writer makes three consecutive moves; the transport loses some of their copies and
// delivers the rest, in order, through real signed ingress. Whenever a lost move has a
// later delivered move, the creator holds that later move as pending ingress. The
// creator must still issue: its census carries the pending roots, its dependencies
// stay on the admitted index, and the pending rows stay held. No copy is redelivered
// here (repair is a separate owner). Model: packages/node/formal/creator-pending-ingress-census.qnt.
import "fake-indexeddb/auto";
import { hashDomain } from "@ts-drp/canonical";
import { V3Envelope } from "@ts-drp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	hex,
	observed,
	openRoom,
	originalStorage,
	type Peer,
	record,
	required,
	sessions,
} from "./fixtures/grid-room-workload.js";
import { readV3RuntimeOwnerCensus } from "../packages/node/src/v3-live.js";

function ownCommits(peer: Peer) {
	return observed.commits.filter(
		(row) => row.issuedRecord.scope.objectId === peer.input.objectId && row.issuedRecord.scope.author === peer.author
	);
}

beforeEach(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: { estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) },
	});
	observed.stores.clear();
	observed.planes.clear();
	observed.commits = [];
	observed.advances = [];
	observed.failSuffixFor = "";
	observed.faults = 0;
	observed.ambiguous = undefined;
	observed.failRecoveryReadFor = "";
	observed.issueAttempts = [];
	observed.commitHandles.clear();
	observed.issuePlans.clear();
	observed.timeline = [];
	observed.ambiguities = [];
	observed.publications = [];
	observed.planWrites = [];
	observed.prunes = [];
	observed.cleanup = [];
	observed.closeGraphs = [];
	observed.snapshots = [];
});
afterEach(async () => {
	await Promise.all([...sessions].map((room) => room.close().catch(() => undefined)));
	sessions.clear();
	vi.restoreAllMocks();
	if (originalStorage === undefined) Reflect.deleteProperty(navigator, "storage");
	else Object.defineProperty(navigator, "storage", originalStorage);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("case 1: the creator issues while a lost Writer copy leaves later moves pending", () => {
	// Bit i set = the copy of move i is lost. Each mask has a lost move with a later delivered move.
	it.each([1, 2, 3, 5])("loss mask %i over three consecutive Writer moves", async (mask) => {
		const fixture = await openRoom(2);
		const creator = required(fixture.peers[0]);
		const writer = required(fixture.peers[1]);
		await fixture.issue(creator, "lossy-creator");
		await fixture.issue(writer, "lossy-prefix");
		fixture.held.add(writer.databaseName);
		const digests: string[] = [];
		const moves = [];
		for (const id of ["lossy-0", "lossy-1", "lossy-2"]) {
			await fixture.issue(writer, id);
			const commit = required(ownCommits(writer).at(-1));
			const digest = hex(commit.envelope.digest);
			digests.push(digest);
			moves.push(
				required(
					fixture.envelopes.find(
						(message) =>
							hex(hashDomain("ts-drp/vertex/v3", V3Envelope.decode(message.data).canonicalPreimage)) === digest
					)
				)
			);
		}
		const lost = (index: number) => (mask & (1 << index)) !== 0;
		const firstLost = [0, 1, 2].findIndex(lost);
		const admittedMoves = digests.slice(0, firstLost);
		const pendingMoves = digests.filter((_, index) => index > firstLost && !lost(index));
		expect(pendingMoves.length, "CASE1_MASK_LEAVES_A_PENDING_SUCCESSOR").toBeGreaterThan(0);
		for (const [index, envelope] of moves.entries()) if (!lost(index)) fixture.deliver(envelope);
		// Wait for the creator to reach the exact admitted/pending state (bounded).
		const plane = required(observed.planes.get(creator.databaseName));
		const deadline = Date.now() + 60_000;
		for (;;) {
			const census = readV3RuntimeOwnerCensus(plane);
			if (
				admittedMoves.every((digest) => fixture.received.has(digest)) &&
				census?.pendingIngress === pendingMoves.length &&
				census.drainingPendingIngress === 0
			)
				break;
			expect(Date.now(), "CASE1_CREATOR_REACHES_PENDING_STATE").toBeLessThan(deadline);
			await sleep(50);
		}

		const charges: Record<string, unknown>[] = [];
		expect(Reflect.get(globalThis, "__warmProofEvent"), "CASE1_DIAGNOSTIC_OBSERVER_UNOWNED").toBeUndefined();
		Reflect.set(globalThis, "__warmProofEvent", (event: Record<string, unknown>) => {
			if (event.kind === "creator-census-pending-charge") charges.push(event);
		});
		try {
			await fixture.issue(creator, "lossy-creator-while-pending");
		} finally {
			Reflect.deleteProperty(globalThis, "__warmProofEvent");
		}
		// The local append's census charges every pending root, at its wire bytes.
		const local = charges.filter((event) => event.received === false);
		expect(local.length, "CASE1_LOCAL_APPEND_CENSUS_SIZED").toBeGreaterThan(0);
		for (const event of local) {
			expect(event.roots, "CASE1_CENSUS_CHARGES_EVERY_PENDING_ROOT").toBe(pendingMoves.length);
			expect(event.wireByteCharge, "CASE1_CENSUS_CHARGES_PENDING_WIRE_BYTES").toBeGreaterThan(0);
		}

		const issued = required(ownCommits(creator).at(-1));
		const dependencies = record(issued.envelope.canonicalPreimageBytes).dependencies as string[];
		for (const digest of digests.filter((digest) => !fixture.received.has(digest)))
			expect(dependencies, "CASE1_LOCAL_ISSUE_NEVER_REFERENCES_AN_UNADMITTED_VERTEX").not.toContain(digest);
		for (const digest of [...pendingMoves, ...digests.filter((_, index) => lost(index))])
			expect(fixture.received.has(digest), "CASE1_PENDING_AND_LOST_MOVES_STAY_UNADMITTED").toBe(false);
		expect(readV3RuntimeOwnerCensus(plane)?.pendingIngress, "CASE1_PENDING_ROWS_STAY_HELD").toBe(pendingMoves.length);
		await Promise.all(fixture.peers.map(fixture.stop));
	});

	it("keeps the pending census within its budget by releasing the newest foreign rows, which repair readmits", async () => {
		const fixture = await openRoom(2);
		const creator = required(fixture.peers[0]);
		const writer = required(fixture.peers[1]);
		await fixture.issue(creator, "budget-creator");
		await fixture.issue(writer, "budget-prefix");
		fixture.held.add(writer.databaseName);
		const digests: string[] = [];
		const moves = [];
		// Move 0 is lost; moves 1..12 (about 2 KiB of census root each) arrive and stay pending.
		for (let index = 0; index <= 12; index += 1) {
			await writer.room.issue({ action: "message", clientOperationId: `budget-${index}`, text: "b".repeat(1200) });
			const digest = hex(required(ownCommits(writer).at(-1)).envelope.digest);
			digests.push(digest);
			moves.push(
				required(
					fixture.envelopes.find(
						(message) =>
							hex(hashDomain("ts-drp/vertex/v3", V3Envelope.decode(message.data).canonicalPreimage)) === digest
					)
				)
			);
		}
		for (const envelope of moves.slice(1)) fixture.deliver(envelope);
		const plane = required(observed.planes.get(creator.databaseName));
		const deadline = Date.now() + 60_000;
		while (
			readV3RuntimeOwnerCensus(plane)?.pendingIngress !== 12 ||
			readV3RuntimeOwnerCensus(plane)?.drainingPendingIngress !== 0
		) {
			expect(Date.now(), "CASE1_BUDGET_CREATOR_HOLDS_TWELVE_PENDING").toBeLessThan(deadline);
			await sleep(50);
		}

		await fixture.issue(creator, "budget-creator-while-pending");

		const kept = required(readV3RuntimeOwnerCensus(plane)?.pendingIngress);
		expect(kept, "CASE1_BUDGET_RELEASES_SOME_PENDING_ROWS").toBeLessThan(12);
		expect(kept, "CASE1_BUDGET_KEEPS_THE_OLDEST_PENDING_ROWS").toBeGreaterThan(0);
		// Redeliver only the lost move: it admits exactly the kept (oldest) pending rows.
		fixture.deliver(required(moves[0]));
		const admittedPrefix = digests.slice(0, kept + 1);
		while (!admittedPrefix.every((digest) => fixture.received.has(digest))) {
			expect(Date.now(), "CASE1_BUDGET_KEPT_ROWS_DRAIN").toBeLessThan(deadline + 60_000);
			await sleep(50);
		}
		for (const digest of digests.slice(kept + 1))
			expect(fixture.received.has(digest), "CASE1_BUDGET_RELEASED_THE_NEWEST_ROWS").toBe(false);
		// Repair resends the released rows; they are admitted in order.
		for (const envelope of moves.slice(kept + 1)) fixture.deliver(envelope);
		while (!digests.every((digest) => fixture.received.has(digest))) {
			expect(Date.now(), "CASE1_BUDGET_RELEASED_ROWS_READMIT").toBeLessThan(deadline + 120_000);
			await sleep(50);
		}
		await fixture.issue(creator, "budget-creator-after-repair");
		await Promise.all(fixture.peers.map(fixture.stop));
	});
});
