/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers: inferred fixture shapes. */
import { afterEach, expect, it } from "vitest";

import type { LongRoomOptions } from "./fixtures/canvas-chat-lull/long-room-driver.js";
import {
	databaseLayout,
	lullsByEpoch,
	openTrackZRoom,
	playEpochs,
	type ProofEvent,
	type TrackZRoom,
} from "./fixtures/track-z/default-room.js";

// Track Z, RED first. The owner made the room database with retention the default for NEW
// rooms (2026-10-21), with the recovery-pool lull scheduled by the library once per epoch:
// the creator's after its adoption, each recipient's (Writer and receive-only) after its
// install. Existing rooms keep the host they were created on, with no migration, and get no
// new scheduling. Node SQLite hosts are unchanged. Each case drives the shipped Canvas or
// Chat composition through genuine seal, adoption, export and install, with no explicit lull
// and no automatic (idle) lull, on fake-indexeddb (tests/fixtures/track-z/default-room.ts).

const rooms = new Set<TrackZRoom>();
afterEach(async () => {
	const failures = await Promise.all([...rooms].map((room) => room.close()));
	rooms.clear();
	expect(failures.flat()).toEqual([]);
}, 300_000);

const options = (app: "canvas" | "chat", recipient: "receive-only" | "writer"): LongRoomOptions => ({
	app,
	host: "room",
	recipient,
	bound: "shipped",
	epochs: 0,
	moves: 2,
	lullMoves: 0,
});
const kinds = (events: readonly ProofEvent[], prefix: string) =>
	events.filter((event) => String(event.kind).startsWith(prefix));
const lullSummary = (room: TrackZRoom) =>
	JSON.stringify(
		Object.fromEntries(
			(["creator", "recipient"] as const).map((role) => [
				role,
				[...lullsByEpoch(room.events[role])].map(([epoch, list]) => [
					epoch,
					list.map((event) => `${String(event.trigger)}:${String(event.result)}`),
				]),
			])
		)
	);

const SIX_DATABASE_NAME =
	/^(creator|recipient)(--ahe|--drp-issuance-v1|--drp-live-journal-v1|--drp-snapshot-quarantine-v1)?$/u;
const EPOCHS = 5;

it.each([
	["canvas", "receive-only"],
	["chat", "writer"],
] as const)(
	"a new %s room with default options (a %s recipient) lives in one version-7 room database, retains by room retention, and each role runs exactly one lull per epoch",
	async (app, recipient) => {
		const room = await openTrackZRoom(options(app, recipient), "default");
		rooms.add(room);
		await playEpochs(room, options(app, recipient), EPOCHS);
		// An explicit lull after the scheduled one in the same epoch returns at once: no second lull.
		const explicit = { creator: await room.creator.lull(), recipient: await room.recipient.lull() };

		// One room database per role, at the room layout's version, and no six-database name.
		expect(await databaseLayout()).toEqual([
			["creator", 7],
			["recipient", 7],
		]);
		// Retention decided at least one boundary on the creator (the room path, not the per-class path).
		const applied = room.events.creator.filter(
			(event) => event.kind === "room-retention-pass" && event.outcome === "applied"
		);
		expect(applied.length, JSON.stringify(kinds(room.events.creator, "room-retention"))).toBeGreaterThan(0);

		const summary = lullSummary(room);
		for (const role of ["creator", "recipient"] as const) {
			const byEpoch = lullsByEpoch(room.events[role]);
			expect(
				[...byEpoch.keys()].sort((left, right) => left - right),
				summary
			).toEqual(Array.from({ length: EPOCHS }, (_, index) => index + 1));
			for (const [epoch, list] of byEpoch) {
				expect(list, `${role} epoch ${epoch}: ${summary}`).toHaveLength(1);
				expect(list[0]?.trigger, summary).toBe("scheduled");
			}
			const last = byEpoch.get(EPOCHS)?.[0];
			expect(explicit[role].kind, summary).toBe(String(last?.result));
		}
		// From epoch 3 (the creator lull's own floor) the creator's lull is never deferred.
		for (const [epoch, list] of lullsByEpoch(room.events.creator))
			if (epoch >= 3) expect(String(list[0]?.result), summary).not.toMatch(/^deferred/u);
		expect(room.unattributed()).toBe(0);
	},
	1_800_000
);

it("an existing six-database room reopens on its own host with default options, unchanged, and runs no scheduled lull", async () => {
	const opts = options("canvas", "receive-only");
	const room = await openTrackZRoom(opts, "six-database");
	rooms.add(room);
	// One epoch: the receive-only recipient has opened no signing store yet, so it has no
	// database under its base name (only `--ahe`, issuance, journal and snapshot databases).
	await playEpochs(room, opts, 1);
	const created = await databaseLayout();
	expect(
		created.every(([name]) => SIX_DATABASE_NAME.test(name)),
		JSON.stringify(created)
	).toBe(true);
	expect(created.some(([, version]) => version === 7)).toBe(false);
	expect(created.some(([name]) => name === "recipient")).toBe(false);
	const state = await room.creator.state();

	await room.reopen("default");
	// Opening refused nothing and changed nothing: the same databases at the same versions.
	expect(await databaseLayout()).toEqual(created);
	expect(await room.recipient.state()).toBe(state);
	expect(await room.recipient.authorityEpoch()).toBe(1);

	// And it plays on, on its own host, through its first retirement: three more epochs (the
	// recipient opens its signing database from epoch 2, still a six-database name).
	await playEpochs(room, opts, 3, 1);
	const after = await databaseLayout();
	expect(
		after.every(([name]) => SIX_DATABASE_NAME.test(name)),
		JSON.stringify(after)
	).toBe(true);
	expect(after.some(([, version]) => version === 7)).toBe(false);
	for (const role of ["creator", "recipient"] as const) {
		expect(kinds(room.events[role], "recovery-pool-lull"), role).toEqual([]);
		expect(kinds(room.events[role], "room-retention"), role).toEqual([]);
	}
}, 1_800_000);

it("a Node SQLite room is unchanged: no scheduled lull and no room retention", async () => {
	const opts = options("canvas", "receive-only");
	const room = await openTrackZRoom(opts, "node");
	rooms.add(room);
	await playEpochs(room, opts, 4);
	for (const role of ["creator", "recipient"] as const) {
		expect(kinds(room.events[role], "recovery-pool-lull"), role).toEqual([]);
		expect(kinds(room.events[role], "room-retention"), role).toEqual([]);
	}
}, 1_800_000);
