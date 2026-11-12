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
// Profile M's average Writer (128 moves per author per epoch) and the greedy typed-refusal case are not
// yet met (the ordinary proof budget is exhausted at epoch 2; the greedy Writer reaches its 64-move
// backlog at epoch 2). They stay RED on red/maintenance-image-capacity-targets until they pass.
//
// IMAGE_CAPACITY_MOVES (16), IMAGE_CAPACITY_EPOCHS (10).

const MOVES = Number(process.env.IMAGE_CAPACITY_MOVES ?? 16);
const EPOCHS = Number(process.env.IMAGE_CAPACITY_EPOCHS ?? 10);

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
