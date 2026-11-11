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
// Admission and maintenance agree on one bound. A Writer's admission computes the same image forecast
// creator maintenance sizes and refuses a move it could not later maintain, with the typed reason
// ISSUANCE_CAPACITY_FORECAST_EXCEEDED, before signing. Two cases pin it:
// - Profile M's average Writer (8,192 vertices over 64 Writers: PROFILE_MOVES = 128 per epoch) is
//   admitted and maintained at a fixed rate in every epoch;
// - greedy: each Writer issues until its first refusal (at most GREEDY_LIMIT per epoch). Every refusal
//   must be the typed capacity refusal, never a later maintenance failure; every epoch still admits at
//   least PROFILE_MOVES; and the room keeps rolling over, so each epoch filled exactly to its cap is
//   maintained by the next ones.
//
// IMAGE_CAPACITY_MOVES (16), IMAGE_CAPACITY_EPOCHS (10), IMAGE_CAPACITY_PROFILE_MOVES (128),
// IMAGE_CAPACITY_PROFILE_EPOCHS (6), IMAGE_CAPACITY_GREEDY_LIMIT (512), IMAGE_CAPACITY_GREEDY_EPOCHS (6).

const MOVES = Number(process.env.IMAGE_CAPACITY_MOVES ?? 16);
const EPOCHS = Number(process.env.IMAGE_CAPACITY_EPOCHS ?? 10);
const PROFILE_MOVES = Number(process.env.IMAGE_CAPACITY_PROFILE_MOVES ?? 128);
const PROFILE_EPOCHS = Number(process.env.IMAGE_CAPACITY_PROFILE_EPOCHS ?? 6);
const GREEDY_LIMIT = Number(process.env.IMAGE_CAPACITY_GREEDY_LIMIT ?? 512);
const GREEDY_EPOCHS = Number(process.env.IMAGE_CAPACITY_GREEDY_EPOCHS ?? 6);
const CAPACITY_REFUSAL = "ISSUANCE_CAPACITY_FORECAST_EXCEEDED";

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
	`a Grid room admits Profile M's average Writer, ${PROFILE_MOVES} moves per author, in every one of ${PROFILE_EPOCHS} epochs (creator lull on)`,
	async () => {
		const run = await runLongRoom({
			app: "grid",
			host: "node",
			recipient: "writer",
			creatorLull: true,
			epochs: PROFILE_EPOCHS,
			moves: PROFILE_MOVES,
		});
		expect(run.epochs.length).toBe(PROFILE_EPOCHS);
		for (const epoch of run.epochs) {
			expect(epoch.latency.creatorIssue.length, `epoch ${epoch.epoch}`).toBe(PROFILE_MOVES);
			expect(epoch.latency.recipientIssue.length, `epoch ${epoch.epoch}`).toBe(PROFILE_MOVES);
		}
	},
	3_600_000
);

it(
	`greedy Writers: every refusal is ${CAPACITY_REFUSAL}, each epoch admits at least ${PROFILE_MOVES} per author, and every capped epoch is maintained (${GREEDY_EPOCHS} epochs)`,
	async () => {
		const run = await runLongRoom({
			app: "grid",
			host: "node",
			recipient: "writer",
			creatorLull: true,
			epochs: GREEDY_EPOCHS,
			moves: GREEDY_LIMIT,
			untilRefusal: CAPACITY_REFUSAL,
		});
		// Every epoch rolled over, so each epoch filled exactly to its cap (its last admitted move) was
		// maintained by the next ones; the driver rethrows any refusal but the typed one.
		expect(run.epochs.length).toBe(GREEDY_EPOCHS);
		for (const epoch of run.epochs) {
			expect(epoch.latency.creatorIssue.length, `epoch ${epoch.epoch}`).toBeGreaterThanOrEqual(PROFILE_MOVES);
			expect(epoch.latency.recipientIssue.length, `epoch ${epoch.epoch}`).toBeGreaterThanOrEqual(PROFILE_MOVES);
			// Above the cap: each Writer was refused with the typed reason before GREEDY_LIMIT.
			expect(epoch.latency.creatorIssue.length, `epoch ${epoch.epoch}`).toBeLessThan(GREEDY_LIMIT);
			expect(epoch.latency.recipientIssue.length, `epoch ${epoch.epoch}`).toBeLessThan(GREEDY_LIMIT);
		}
		console.log("IMAGE_CAPACITY_GREEDY_CAPS", JSON.stringify(run.epochs.map(epoch =>
			[epoch.epoch, epoch.latency.creatorIssue.length, epoch.latency.recipientIssue.length])));
	},
	7_200_000
);
