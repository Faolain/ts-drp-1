import { afterEach, expect, it } from "vitest";

import {
	type AppKind,
	closeLongRooms,
	type EpochRecord,
	type RecipientMode,
	runLongRoom,
} from "./fixtures/canvas-chat-lull/node-long-room.js";

// Track Q (Canvas and Chat creator lull), RED first. Track M (finding 14) found that the
// shipped Canvas and Chat creators never run their recovery-pool lull: neither composition
// supplies `readOrdinaryApplicationResourceBound`, so `maintainRecoveryPool()` always
// answers `deferred:unsupported` and the creator's retirement runs inline at seal once the
// pool is full. This drives each shipped composition, unmodified, through genuine seal,
// adoption, install and both roles' lulls on the default Node SQLite host, and requires:
//
// - from epoch 3 (the lull's own floor) the creator's lull is never deferred, and it
//   maintains the pool at least twice;
// - a maintained lull runs the creator's retirement selection (the detector's control);
// - a seal that follows a maintained lull runs no retirement selection inline.
//
// The creator's "closed-retirement-selection" proof events are filed per role and per
// window by the fixture (tests/fixtures/canvas-chat-lull/). Seals wait 300 ms after the
// last remote admission (Track M finding 5).

const EPOCHS = 6;

afterEach(async () => {
	expect(await closeLongRooms()).toEqual([]);
}, 300_000);

function expectLullOffTheSealPath(epochs: readonly EpochRecord[]): void {
	const summary = JSON.stringify(
		epochs.map((record) => ({
			epoch: record.epoch,
			lull: record.lulls.creator,
			sealRetirement: record.windows.seal.retirementSelections,
			lullRetirement: record.windows.lull.retirementSelections,
			seal: Math.round(record.latency.seal),
		}))
	);
	expect(epochs, summary).toHaveLength(EPOCHS);
	for (const record of epochs.filter(({ epoch }) => epoch >= 3))
		expect(record.lulls.creator, summary).not.toMatch(/^deferred/u);
	const maintained = epochs.filter((record) => record.lulls.creator === "maintained");
	expect(maintained.length, summary).toBeGreaterThanOrEqual(2);
	for (const record of maintained) expect(record.windows.lull.retirementSelections, summary).toBeGreaterThan(0);
	for (const record of epochs) {
		const prior = epochs.find(({ epoch }) => epoch === record.epoch - 1);
		if (prior?.lulls.creator === "maintained") expect(record.windows.seal.retirementSelections, summary).toBe(0);
	}
}

it.each<[AppKind, RecipientMode]>([
	["canvas", "receive-only"],
	["chat", "writer"],
])(
	"the shipped %s creator (with a %s recipient) runs its lull and its seals stop running retirement inline",
	async (app, recipient) => {
		const run = await runLongRoom({
			app,
			host: "node",
			recipient,
			bound: "shipped",
			epochs: EPOCHS,
			moves: 2,
			lullMoves: 0,
		});
		expectLullOffTheSealPath(run.epochs);
	},
	1_800_000
);
