import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	closeFixtures,
	dumpDatabase,
	installEnvironment,
	lullFixture,
	type LullFixture,
	type OpenedRoom,
	required,
	rollover,
	transition,
} from "./fixtures/track-m/room-retention-fixture.js";
import { type Dump, flipped, foreignWrite, type Row, rowId, stable } from "./fixtures/track-m/room-retention-probe.js";

// Track M2, slice 14b stage 2 RED: the verified-fact ledger on the browser room database
// host with retention (fake-indexeddb: mechanism evidence; the native engines are 14f).
//
// The ledger holds only facts verified on arrival or at open, keyed by the exact bytes they
// were verified from, for one live session. Its observable surface:
// - `room-retention-pass` names where its decision's facts came from: `acquisition` is
//   "cold" (stage 1, the complete cold acquisition, which is the open verification) or
//   "ledger" (stage 2: ledger facts plus the boundary's fresh census and delta).
// - `room-retention-ledger` reports each record, decline and drop, with the ledger's
//   identity (`ledger.id`, and `ledger.generation`, the number of genuine handoffs it was
//   forked across) and the facts it holds (`facts.epochs`, `facts.bytes`).
// - `__roomRetentionLedgerMode`: "apply" (default on an opted-in host), "shadow" (stage 1
//   decides; the ledger planner plans beside it on the same pre-state and every boundary
//   reports `room-retention-ledger-shadow` with `equal`), or "off".
// - `__roomRetentionLedgerLimits`: lowered `maxEpochs`, `maxBytes`, `maxProofBytes`.

type Event = Readonly<Record<string, unknown>>;
const events: Event[] = [];
let restore: (() => void) | undefined;
beforeEach(() => {
	events.length = 0;
	restore = installEnvironment((event) => {
		if (String(event.kind ?? "").startsWith("room-retention")) events.push(event);
	});
});
afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__roomRetentionLedgerMode");
	Reflect.deleteProperty(globalThis, "__roomRetentionLedgerLimits");
	restore?.();
	expect(await closeFixtures()).toEqual([]);
});

const STEADY = 5;
type Room = Readonly<{ fixture: LullFixture; creator: OpenedRoom; recipient: OpenedRoom }>;

async function room(seed: string, retention = true): Promise<Room> {
	const fixture = await lullFixture({ retention, creatorLull: true, seed });
	const creator = await fixture.open("creator", fixture.creator);
	const recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	return { fixture, creator, recipient };
}

/** The events of one call, with the index they started at. */
async function observe<T>(run: () => Promise<T>): Promise<Readonly<{ result: T | unknown; events: Event[] }>> {
	const first = events.length;
	let result: T | unknown;
	try {
		result = await run();
	} catch (error) {
		result = error;
	}
	return { result, events: events.slice(first) };
}
const passOf = (list: readonly Event[]): Event | undefined =>
	list.find((event) => event.kind === "room-retention-pass");
const ledgerOf = (list: readonly Event[]): Event[] => list.filter((event) => event.kind === "room-retention-ledger");

/** Owned rows removed between two dumps (a deletion by any owner). */
function removed(before: Dump, after: Dump): string[] {
	const right = new Set<string>();
	for (const [store, entries] of Object.entries(after)) for (const [key] of entries) right.add(rowId(store, key));
	const out: string[] = [];
	for (const [store, entries] of Object.entries(before))
		for (const [key] of entries) {
			const id = rowId(store, key);
			if (
				/^(ahe:|journal:|snapshot:|issuance:|sealEvidence |signerState |voteSlots |voteOutbox )/.test(id) &&
				!right.has(id)
			)
				out.push(id);
		}
	return out;
}

/** Steady turnover on the retention path, then one more rollover (the ledger is seeded). */
async function seeded(seed: string): Promise<Room> {
	const opened = await room(seed);
	for (let epoch = 0; epoch < STEADY; epoch++) await rollover(opened.fixture, opened.creator, opened.recipient, epoch);
	expect(
		events.some(
			(event) =>
				event.kind === "room-retention-ledger" && event.action === "recorded" && event.source === "open-verification"
		)
	).toBe(true);
	return opened;
}

/** One lull of one role, observed. */
const lull = (opened: OpenedRoom): ReturnType<typeof observe> => observe(() => opened.room.maintainRecoveryPool());

describe("Track M2 RED: the ledger decides in session", () => {
	it("after the open verification seeds the ledger, later lulls decide from the ledger without a cold acquisition", async () => {
		const opened = await seeded("track-m2-red-1");
		for (let epoch = STEADY; epoch < STEADY + 3; epoch++) {
			await transition(opened.fixture, opened.creator, opened.recipient, epoch);
			for (const who of [opened.creator, opened.recipient]) {
				const seen = await lull(who);
				expect(seen.result).toBe(false);
				const pass = required(passOf(seen.events));
				expect(pass).toMatchObject({ outcome: "applied", acquisition: "ledger" });
				expect(ledgerOf(seen.events).some((event) => event.action === "recorded" && event.source === "boundary")).toBe(
					true
				);
			}
		}
		await opened.fixture.stop(opened.recipient);
		await opened.fixture.stop(opened.creator);
	}, 900_000);

	it("the ledger planner's decision equals stage 1's on the same pre-state at every boundary (shadow, 16 epochs)", async () => {
		Reflect.set(globalThis, "__roomRetentionLedgerMode", "shadow");
		const opened = await room("track-m2-red-2");
		for (let epoch = 0; epoch < 16; epoch++) await rollover(opened.fixture, opened.creator, opened.recipient, epoch);
		const shadows = events.filter((event) => event.kind === "room-retention-ledger-shadow");
		// Each role's boundaries after its first applied (seeding) boundary are compared.
		expect(shadows.length).toBeGreaterThanOrEqual(2 * 10);
		for (const shadow of shadows) expect(shadow, stable(shadow)).toMatchObject({ equal: true });
		// Stage 1 decided every boundary in shadow mode.
		expect(events.filter((event) => event.kind === "room-retention-pass" && event.acquisition === "ledger")).toEqual(
			[]
		);
		await opened.fixture.stop(opened.recipient);
		await opened.fixture.stop(opened.creator);
	}, 1_800_000);
});

describe("Track M2 RED: durable bytes are untrusted after a fact was ledgered", () => {
	it("a ledgered survivor (a protected snapshot scope's chunk) poisoned after recording: no deletion, the ledger is dropped", async () => {
		const opened = await seeded("track-m2-red-3");
		await transition(opened.fixture, opened.creator, opened.recipient, STEADY);
		const database = opened.fixture.host.database("creator");
		const before = await dumpDatabase(database);
		// The protected survivor recorded at the previous boundary: snapshot scope STEADY - 1.
		const chunk = required((before["snapshot:chunks"] ?? []).find(([key]) => (key as unknown[])[1] === STEADY - 1));
		const poison: Row = { store: "snapshot:chunks", key: chunk[0], value: flipped(chunk[1]) };
		await foreignWrite(database, [poison]).committed;
		const seen = await lull(opened.creator);
		const after = await dumpDatabase(database);
		expect(removed(before, after)).toEqual([]);
		expect(
			seen.events.filter(
				(event) => event.kind === "room-retention-pass" && event.acquisition === "ledger" && event.outcome === "applied"
			)
		).toEqual([]);
		expect(ledgerOf(seen.events).some((event) => event.action === "dropped")).toBe(true);
		// Restored: the next decision is an open verification again, then the ledger.
		await foreignWrite(database, [{ store: "snapshot:chunks", key: chunk[0], value: chunk[1] }]).committed;
		const retry = await lull(opened.creator);
		expect(passOf(retry.events)).toMatchObject({ acquisition: "cold" });
		await opened.fixture.stop(opened.recipient);
		await opened.fixture.stop(opened.creator);
	}, 900_000);

	it("a ledgered fact whose stored bytes no longer hash to its key (an AHE closure blob) is never used", async () => {
		const opened = await seeded("track-m2-red-5");
		await transition(opened.fixture, opened.creator, opened.recipient, STEADY);
		const database = opened.fixture.host.database("creator");
		const before = await dumpDatabase(database);
		// A blob of a generation the ledger verified at an earlier boundary (the oldest present).
		const blobs = before["ahe:blobs"] ?? [];
		const target = required(blobs[0]);
		await foreignWrite(database, [{ store: "ahe:blobs", key: target[0], value: flipped(target[1]) }]).committed;
		const seen = await lull(opened.creator);
		const after = await dumpDatabase(database);
		expect(removed(before, after)).toEqual([]);
		expect(
			seen.events.filter(
				(event) => event.kind === "room-retention-pass" && event.acquisition === "ledger" && event.outcome === "applied"
			)
		).toEqual([]);
		expect(ledgerOf(seen.events).some((event) => event.action === "dropped" || event.action === "declined")).toBe(true);
		await foreignWrite(database, [{ store: "ahe:blobs", key: target[0], value: target[1] }]).committed;
		await opened.fixture.stop(opened.recipient);
		await opened.fixture.stop(opened.creator);
	}, 900_000);

	it("a store rolled back after recording (retired AHE rows reinserted): the ledger never decides over it", async () => {
		const opened = await seeded("track-m2-red-4");
		const database = opened.fixture.host.database("creator");
		await transition(opened.fixture, opened.creator, opened.recipient, STEADY);
		const pre = await dumpDatabase(database);
		await lull(opened.creator);
		await lull(opened.recipient);
		const post = await dumpDatabase(database);
		// The AHE rows the last creator decision retired, as they were before it.
		const retired: Row[] = [];
		for (const store of ["ahe:generations", "ahe:promotions", "ahe:blobs"]) {
			const kept = new Set((post[store] ?? []).map(([key]) => stable(key)));
			for (const [key, value] of pre[store] ?? []) if (!kept.has(stable(key))) retired.push({ store, key, value });
		}
		expect(retired.length).toBeGreaterThan(0);
		await transition(opened.fixture, opened.creator, opened.recipient, STEADY + 1);
		await foreignWrite(database, retired).committed;
		const seen = await lull(opened.creator);
		expect(
			seen.events.filter((event) => event.kind === "room-retention-pass" && event.acquisition === "ledger")
		).toEqual([]);
		expect(ledgerOf(seen.events).some((event) => event.action === "declined" || event.action === "dropped")).toBe(true);
		await opened.fixture.stop(opened.recipient);
		await opened.fixture.stop(opened.creator);
	}, 900_000);
});

describe("Track M2 RED: the ledger's lifetime is one live session", () => {
	it("after a close and reopen the first decision is an open verification; no fact predates the open", async () => {
		const opened = await seeded("track-m2-red-6");
		await transition(opened.fixture, opened.creator, opened.recipient, STEADY);
		await lull(opened.creator);
		await lull(opened.recipient);
		const before = ledgerOf(events).map((event) => (event.ledger as { id: number }).id);
		await opened.fixture.stop(opened.recipient);
		await opened.fixture.stop(opened.creator);
		const creator = await opened.fixture.open("creator", opened.fixture.creator, { reopen: true });
		const recipient = await opened.fixture.open("observer", opened.fixture.observer, {
			reopen: true,
			receiveOnly: true,
		});
		await transition(opened.fixture, creator, recipient, STEADY + 1);
		const first = await lull(creator);
		expect(passOf(first.events)).toMatchObject({ acquisition: "cold" });
		const recorded = ledgerOf(first.events).filter((event) => event.action === "recorded");
		expect(recorded.length).toBeGreaterThan(0);
		for (const event of recorded) {
			expect(event).toMatchObject({ source: "open-verification", ledger: { generation: 0 } });
			expect(before).not.toContain((event.ledger as { id: number }).id);
		}
		await transition(opened.fixture, creator, recipient, STEADY + 2);
		const second = await lull(creator);
		expect(passOf(second.events)).toMatchObject({ acquisition: "ledger" });
		await opened.fixture.stop(recipient);
		await opened.fixture.stop(creator);
	}, 900_000);

	it("the ledger crosses only genuine handoffs: one ledger per session, its generation grows by one per handoff", async () => {
		const opened = await seeded("track-m2-red-7");
		for (let epoch = STEADY; epoch < STEADY + 2; epoch++)
			await rollover(opened.fixture, opened.creator, opened.recipient, epoch);
		const recorded = ledgerOf(events).filter((event) => event.action === "recorded");
		const byLedger = new Map<number, number[]>();
		for (const event of recorded) {
			const ledger = event.ledger as { id: number; generation: number };
			byLedger.set(ledger.id, [...(byLedger.get(ledger.id) ?? []), ledger.generation]);
		}
		// One ledger per room session (creator and recipient), each forked once per epoch.
		expect(byLedger.size).toBe(2);
		for (const generations of byLedger.values()) {
			expect(generations.length).toBeGreaterThan(2);
			for (let index = 1; index < generations.length; index++)
				expect(required(generations[index])).toBe(required(generations[index - 1]) + 1);
		}
		await opened.fixture.stop(opened.recipient);
		await opened.fixture.stop(opened.creator);
	}, 900_000);
});

describe("Track M2 RED: bounds and charges (14e)", () => {
	it("an over-budget ledger decision refuses before its first plan, and the boundary runs stage 1", async () => {
		const opened = await seeded("track-m2-red-8a");
		Reflect.set(globalThis, "__roomRetentionLedgerLimits", { maxProofBytes: 64 });
		await transition(opened.fixture, opened.creator, opened.recipient, STEADY);
		const seen = await lull(opened.creator);
		expect(
			ledgerOf(seen.events).some((event) => event.action === "declined" && String(event.reason).includes("budget"))
		).toBe(true);
		expect(passOf(seen.events)).toMatchObject({ acquisition: "cold" });
		await opened.fixture.stop(opened.recipient);
		await opened.fixture.stop(opened.creator);
	}, 900_000);

	it("a ledger over its byte cap is dropped, never trusted partially; the next boundary verifies cold", async () => {
		Reflect.set(globalThis, "__roomRetentionLedgerLimits", { maxBytes: 64 });
		const opened = await room("track-m2-red-8b");
		for (let epoch = 0; epoch < STEADY + 2; epoch++)
			await rollover(opened.fixture, opened.creator, opened.recipient, epoch);
		expect(events.filter((event) => event.kind === "room-retention-pass" && event.acquisition === "ledger")).toEqual(
			[]
		);
		expect(
			ledgerOf(events).some((event) => event.action === "dropped" && String(event.reason).includes("capacity"))
		).toBe(true);
		await opened.fixture.stop(opened.recipient);
		await opened.fixture.stop(opened.creator);
	}, 900_000);

	it("a fact evicted under the ledger's window is never trusted: the boundary falls back to a cold verified read", async () => {
		Reflect.set(globalThis, "__roomRetentionLedgerLimits", { maxEpochs: 1 });
		const opened = await room("track-m2-red-9");
		for (let epoch = 0; epoch < STEADY + 2; epoch++)
			await rollover(opened.fixture, opened.creator, opened.recipient, epoch);
		expect(events.filter((event) => event.kind === "room-retention-pass" && event.acquisition === "ledger")).toEqual(
			[]
		);
		expect(
			ledgerOf(events).some((event) => event.action === "declined" && String(event.reason).includes("missing"))
		).toBe(true);
		expect(
			events.filter((event) => event.kind === "room-retention-pass" && event.outcome === "applied").length
		).toBeGreaterThan(2);
		await opened.fixture.stop(opened.recipient);
		await opened.fixture.stop(opened.creator);
	}, 900_000);
});

describe("Track M2 RED: other hosts are unchanged", () => {
	it("a room host without retention creates no ledger", async () => {
		const opened = await room("track-m2-red-10", false);
		for (let epoch = 0; epoch < STEADY; epoch++)
			await rollover(opened.fixture, opened.creator, opened.recipient, epoch);
		expect(ledgerOf(events)).toEqual([]);
		expect(events.filter((event) => event.kind === "room-retention-ledger-shadow")).toEqual([]);
		await opened.fixture.stop(opened.recipient);
		await opened.fixture.stop(opened.creator);
	}, 900_000);
});
