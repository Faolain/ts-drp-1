/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";
import { createV3RoomWriterCapacity, V3_ROOM_WRITER_CAPACITY_AUTHORS_MAX } from "../examples/v3-room/src/writer-capacity.js";

// fix/capacity-refusal-prompt-roll: the creator forecasts each settlement Writer's own admission from the
// rows it admitted and rolls before it ends (capacity), or when a Writer past half of it falls silent
// (silence). Each at most once per epoch, only from admitted rows, only after 7 own moves in the epoch,
// and active under a budget override. The room's authority is null until its first successor (as a real
// session's is), so the genesis epoch is decided by the genesis profile the application passes.

const policies = new Set<{ close(): void }>();
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
});
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
	vi.useRealTimers();
});

const OBJECT = "writer-capacity-object";
const WRITER = "b".repeat(64);
const SETTLEMENT = "creator-trusted-settlement-v1" as const;
const hex = (seed: number): string => seed.toString(16).padStart(64, "0");
/** The Writer's gap between moves (10 moves a second). */
const GAP_MS = 100;

function creatorRoom(profileId: "creator-trusted-v1" | "creator-trusted-settlement-v1") {
	let epoch = 0;
	const room = {
		// A real session has no successor authority in its genesis epoch.
		authority: () => (epoch === 0 ? null : ({ epoch, objectId: OBJECT, profileId } as never)),
		issue: () => Promise.resolve() as never,
		sealEpoch: async () => ({ epoch, successorEpoch: epoch + 1 }) as never,
		adoptCreatorSuccessor: async () => {
			epoch++;
			return undefined as never;
		},
		exportCreatorSuccessor: async () => ({ epoch }) as never,
	};
	return { room, epoch: () => epoch };
}

/** A Writer's admitted view, as the room hands it to `observe`. */
const view = (author: string, epoch: number, authorSequence: number) => ({
	kind: "drp-vertex" as const,
	protocolMajor: 3 as const,
	objectId: OBJECT,
	epoch,
	anchor: hex(epoch + 1),
	author,
	authorSequence,
	logicalTime: 1_000 + authorSequence,
	dependencies: [hex(9_000 + authorSequence)],
	operation: { action: "place", id: `block-${authorSequence}`, payload: "x".repeat(40) },
	digest: new Uint8Array(32),
});

function create(options: { writerCapacity?: boolean; profileId?: "creator-trusted-v1" | "creator-trusted-settlement-v1" } = {}) {
	const events: rollover.V3RoomRolloverEvent[] = [];
	const profileId = options.profileId ?? SETTLEMENT;
	const policy = rollover.createV3RoomRolloverPolicy({
		role: "creator",
		// A test override: the budget and idle triggers never fire, as in the hot-writer case.
		budget: { movesPerAuthor: 100_000, idleMs: 3_600_000 },
		...(options.writerCapacity === false ? {} : { writerCapacity: { maxDependencies: 16, profileId } }),
		hooks: { onRollover: (event) => events.push(event) },
	});
	policies.add(policy);
	const fixture = creatorRoom(profileId);
	policy.bind(fixture.room);
	return { policy, events, epoch: fixture.epoch };
}

/** One Writer move every GAP_MS; returns the epoch's own move count at each roll. */
async function play(
	subject: ReturnType<typeof create>,
	moves: number,
	from = 0
): Promise<Readonly<{ next: number; firedAt: number[] }>> {
	const firedAt: number[] = [];
	let inEpoch = 0;
	let seen = subject.events.length;
	let sequence = from;
	for (; sequence < from + moves; sequence++) {
		const epoch = subject.epoch();
		subject.policy.observe(view(WRITER, epoch, sequence));
		inEpoch++;
		await vi.advanceTimersByTimeAsync(GAP_MS);
		if (subject.events.length !== seen) {
			seen = subject.events.length;
			firedAt.push(inEpoch);
			inEpoch = 0;
		}
	}
	return { next: sequence, firedAt };
}

it("rolls in the genesis epoch before the Writer's own store refuses, under a budget override", async () => {
	const subject = create();
	const { firedAt } = await play(subject, 260);
	expect(subject.events[0]?.trigger).toBe("capacity");
	// The Writer's own admission ends at about 254 own moves of one epoch; the creator rolls before it,
	// with its margin for the rollover (about 40 moves at 10 moves a second), and not needlessly early.
	expect(firedAt[0]).toBeGreaterThan(100);
	expect(firedAt[0]).toBeLessThan(254);
});

it("fires at most once per epoch, never before 7 own moves in it", async () => {
	const subject = create();
	const { firedAt } = await play(subject, 1_200);
	const epochs = subject.epoch();
	expect(subject.events.length).toBe(epochs);
	expect(subject.events.every((event) => event.trigger === "capacity" || event.trigger === "silence")).toBe(true);
	// Every roll came at least 7 own moves into its epoch.
	expect(Math.min(...firedAt)).toBeGreaterThanOrEqual(7);
});

it("does not forecast without the parameters or outside the settlement profile", async () => {
	for (const options of [{ writerCapacity: false }, { profileId: "creator-trusted-v1" as const }]) {
		const other = create(options);
		await play(other, 300);
		expect(other.events).toEqual([]);
	}
});

it("rolls once when a Writer past half of its forecast falls silent", async () => {
	const subject = create();
	// 150 own moves: past half of the Writer's admission (about 254 in the genesis epoch), short of the
	// capacity margin (about 40 moves at 10 moves a second).
	await play(subject, 150);
	expect(subject.events).toEqual([]);
	await vi.advanceTimersByTimeAsync(2_500);
	expect(subject.events.map((event) => event.trigger)).toEqual(["silence"]);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(subject.events.length).toBe(1);
});

it("counts the epoch's own rows from the Writer's contiguous sequences", () => {
	const capacity = createV3RoomWriterCapacity({ objectId: OBJECT, maxDependencies: 16, now: () => 0 });
	let sequence = 0;
	for (let epoch = 1; epoch <= 3; epoch++)
		for (let index = 0; index < 100; index++) capacity.observe(view(WRITER, epoch, sequence++), epoch);
	// One row seen of epoch 4 after a gap of 9 unseen own rows: all 10 are counted.
	sequence += 9;
	const reading = capacity.observe(view(WRITER, 4, sequence), 4);
	expect(reading?.epochRows).toBe(10);
	// About (508 - 300 - 2 * 10) / 2 moves remain for the Writer; the forecast is never above it.
	expect(reading?.moves).toBeLessThanOrEqual(94);
	expect(reading?.moves).toBeGreaterThan(40);
});

it("keeps at most V3_ROOM_WRITER_CAPACITY_AUTHORS_MAX authors, dropping the least recently active", () => {
	let now = 0;
	const capacity = createV3RoomWriterCapacity({ objectId: OBJECT, maxDependencies: 16, now: () => now++ });
	for (let author = 0; author < V3_ROOM_WRITER_CAPACITY_AUTHORS_MAX; author++) capacity.observe(view(hex(author), 1, 0), 1);
	// Author 0 moves again; the next new author drops author 1, the least recently active.
	capacity.observe(view(hex(0), 1, 1), 1);
	capacity.observe(view(hex(100_000), 1, 0), 1);
	expect(capacity.size()).toBe(V3_ROOM_WRITER_CAPACITY_AUTHORS_MAX);
	// Author 0 kept its window (2 rows); author 1 starts over (1 row).
	expect(capacity.observe(view(hex(0), 1, 2), 1)?.epochRows).toBe(3);
	expect(capacity.observe(view(hex(1), 1, 1), 1)?.epochRows).toBe(1);
});
