import { afterEach, expect, it } from "vitest";

import { closeLongRooms, runLongRoom } from "./fixtures/track-m-apps/app-long-room.js";

// Maintenance native image capacity (fix/maintenance-image-capacity).
//
// One shipped Grid room (settlement profile) on the default Node SQLite host, creator and one Writer,
// with the creator's recovery-pool lull, driven by the long-room driver at MOVES ordinary moves per
// author per epoch. At the probe load of perf/lull-cost-and-barrier (about 15 creator moves per epoch)
// the creator's own move at epoch 7 was refused: "creator issuance maintenance prefix sizing is
// unavailable: ...MAINTENANCE_NATIVE_IMAGE_EXHAUSTED:795163/786432". Profile M asks for 32 durable
// ops/s sustained over an epoch of up to 8,192 vertices, so a room must keep admitting every move at
// this load for as many epochs as it runs: per-epoch maintenance work stays bounded and nothing it
// sizes may grow with the room's history.
//
// Worst admitted rate: the room admits up to WORST_MOVES vertices per Writer per epoch (the issuance
// store's 1,024 retained rows over the four-epoch own window). Any rate the room admits and
// maintenance later refuses is a liveness defect, so the second case drives that rate for enough
// epochs to fill the retained window. (The driver gives every Writer the same rate; one active
// Writer with the others idle is the same per-author bound for the creator's own census.)
//
// IMAGE_CAPACITY_MOVES (16), IMAGE_CAPACITY_EPOCHS (10), IMAGE_CAPACITY_WORST_MOVES (403),
// IMAGE_CAPACITY_WORST_EPOCHS (6).

const MOVES = Number(process.env.IMAGE_CAPACITY_MOVES ?? 16);
const EPOCHS = Number(process.env.IMAGE_CAPACITY_EPOCHS ?? 10);
const WORST_MOVES = Number(process.env.IMAGE_CAPACITY_WORST_MOVES ?? 403);
const WORST_EPOCHS = Number(process.env.IMAGE_CAPACITY_WORST_EPOCHS ?? 6);

afterEach(async () => {
	expect(await closeLongRooms()).toEqual([]);
}, 300_000);

it(
	`a Grid room admits ${MOVES} moves per author in every one of ${EPOCHS} epochs (creator lull on)`,
	async () => {
		const run = await runLongRoom({
			app: "grid",
			host: "node",
			recipient: "writer",
			creatorLull: true,
			epochs: EPOCHS,
			moves: MOVES,
		});
		expect(run.epochs.length).toBe(EPOCHS);
		for (const epoch of run.epochs) {
			expect(epoch.latency.creatorIssue.length, `epoch ${epoch.epoch}`).toBe(MOVES);
			expect(epoch.latency.recipientIssue.length, `epoch ${epoch.epoch}`).toBe(MOVES);
		}
	},
	1_800_000
);

it(
	`a Grid room admits the worst admitted rate, ${WORST_MOVES} moves per author, in every one of ${WORST_EPOCHS} epochs (creator lull on)`,
	async () => {
		const run = await runLongRoom({
			app: "grid",
			host: "node",
			recipient: "writer",
			creatorLull: true,
			epochs: WORST_EPOCHS,
			moves: WORST_MOVES,
		});
		expect(run.epochs.length).toBe(WORST_EPOCHS);
		for (const epoch of run.epochs) {
			expect(epoch.latency.creatorIssue.length, `epoch ${epoch.epoch}`).toBe(WORST_MOVES);
			expect(epoch.latency.recipientIssue.length, `epoch ${epoch.epoch}`).toBe(WORST_MOVES);
		}
	},
	7_200_000
);
