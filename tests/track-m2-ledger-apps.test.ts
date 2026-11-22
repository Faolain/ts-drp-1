import { afterEach, expect, it } from "vitest";

import { closeLongRooms, type LongRoomRun, runLongRoom } from "./fixtures/track-m-apps/app-long-room.js";

// Track M2, slice 14b stage 2 differential on the shipped Canvas composition (Track M's
// long-room harness, room-database host with verified retention, measurement-only creator
// lull reader so both roles run their lulls).
//
// 1. Shadow: stage 1 decides every boundary; the ledger planner plans beside it on the same
//    pre-state and every compared boundary must report `room-retention-ledger-shadow` with
//    `equal: true`.
// 2. Applied twins: the same Canvas history with the ledger deciding (`apply`) and with stage
//    1 alone (`off`): after every lull both roles hold the same number of rows in every store.
//
// Measurement only: runs with TRACK_M_APPS=1, never in the default suite (as Track M's apps tests).
const ENABLED = process.env.TRACK_M_APPS === "1";
const EPOCHS = Number(process.env.TRACK_M_APPS_EPOCHS ?? 16);
const MOVES = Number(process.env.TRACK_M_APPS_MOVES ?? 2);

type Event = Readonly<Record<string, unknown>>;

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__roomRetentionLedgerMode");
	expect(await closeLongRooms()).toEqual([]);
}, 300_000);

async function canvas(mode: "apply" | "shadow" | "off"): Promise<Readonly<{ run: LongRoomRun; events: Event[] }>> {
	Reflect.set(globalThis, "__roomRetentionLedgerMode", mode);
	const events: Event[] = [];
	const run = await runLongRoom(
		{
			app: "canvas",
			host: "room-retention",
			recipient: "receive-only",
			creatorLull: true,
			epochs: EPOCHS,
			moves: MOVES,
		},
		(creator, recipient) => {
			// The harness's observer is installed by now: chain a capture of the full events.
			const inner = Reflect.get(globalThis, "__warmProofEvent") as (event: Event) => void;
			Reflect.set(globalThis, "__warmProofEvent", (event: Event) => {
				if (event !== null && typeof event === "object" && String(event.kind ?? "").startsWith("room-retention"))
					events.push(event);
				inner(event);
			});
			return [creator, recipient] as const;
		}
	);
	expect(run.epochs).toHaveLength(EPOCHS);
	return { run, events };
}

it.skipIf(!ENABLED)(
	`shadow: on Canvas (${EPOCHS} epochs) the ledger decision equals stage 1's at every compared boundary`,
	async () => {
		const { events } = await canvas("shadow");
		const shadows = events.filter((event) => event.kind === "room-retention-ledger-shadow");
		if (process.env.TRACK_M_VERBOSE === "1")
			for (const shadow of shadows) process.stdout.write(`TRACK_M2_CANVAS_SHADOW ${JSON.stringify(shadow)}\n`);
		for (const shadow of shadows) expect(shadow, JSON.stringify(shadow)).toMatchObject({ equal: true });
		expect(shadows.filter((shadow) => shadow.role === "creator").length).toBeGreaterThanOrEqual(4);
		expect(shadows.filter((shadow) => shadow.role === "recipient").length).toBeGreaterThanOrEqual(4);
		expect(events.filter((event) => event.kind === "room-retention-pass" && event.acquisition === "ledger")).toEqual(
			[]
		);
	},
	3_600_000
);

it.skipIf(!ENABLED)(
	`applied twins: on Canvas (${EPOCHS} epochs) with the ledger deciding, both roles hold stage 1's row counts`,
	async () => {
		const stage1 = await canvas("off");
		const ledger = await canvas("apply");
		expect(
			ledger.events.filter(
				(event) => event.kind === "room-retention-pass" && event.acquisition === "ledger" && event.outcome === "applied"
			).length,
			"ledger decisions applied"
		).toBeGreaterThanOrEqual(8);
		for (const [index, record] of ledger.run.epochs.entries()) {
			const base = stage1.run.epochs[index];
			for (const role of ["creator", "recipient"] as const) {
				const rows = (census: Readonly<Record<string, readonly [number, number]>> | undefined) =>
					Object.fromEntries(Object.entries(census ?? {}).map(([store, [count]]) => [store, count]));
				expect({ epoch: record.epoch, role, rows: rows(record.lulled[role]) }).toEqual({
					epoch: base?.epoch,
					role,
					rows: rows(base?.lulled[role]),
				});
			}
		}
	},
	3_600_000
);
