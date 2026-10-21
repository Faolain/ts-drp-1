import { afterEach, expect, it } from "vitest";

import {
	creatorRetirementControl,
	gridRoom,
	type GridHost,
	lullRollover,
	type LullRecord,
	playOneMoveEach,
} from "./fixtures/track-s/first-lull-reopen.js";
import { closeFixtures, installEnvironment, required } from "./fixtures/track-m/room-retention-fixture.js";

// Track S RED: a persisted reopen right after the creator's FIRST maintained lull must lead
// to continued play. Grid composition (Track N's settlement room: Grid zone application,
// creator-trusted-settlement-v1, the creator and one Writer recipient), Grid's LULL=1 order.
//
// At base d7f8c39b the creator's first maintained lull (epoch 4) ends on a completed
// signing-summary decision whose stored resume basis covers every owner's state at that
// decision. Any same-floor reconciliation after lawful gameplay at that epoch replays the
// stored summary source, recomputes the basis over the moved-on journal and issuance, and
// refuses `floor-stale` (creator-closed-rollback-data.ts, `installClosedRetirementSource`):
// - reopened right after the lull: the reopen's own resume still matches, but the first
//   seal after the next moves refuses ("creator snapshot role reconciliation refused:
//   floor-stale");
// - moves after the lull, then the reopen: the reopen's startup readiness resume refuses.
// Every refusal fails closed (nothing is deleted), but the room stops.
//
// Hosts: the node SQLite host; the browser room-database host on fake-indexeddb with R3's
// FIFO process lock manager; the same host with `roomRetention: true` (Tracks M and O).

let restore: (() => void) | undefined;
const declined: Readonly<Record<string, unknown>>[] = [];
afterEach(async () => {
	restore?.();
	restore = undefined;
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

// Names the stage a refusal came from: the reopen's startup, or a later rollover.
async function stage<T>(name: string, action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		throw new TypeError(`TRACK_S_STAGE ${name}: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
}

const MAX_EPOCHS_TO_FIRST_LULL = 8;
const ROLLOVERS_AFTER_REOPEN = 2;

for (const host of ["sqlite", "room", "room-retention"] as const satisfies readonly GridHost[])
	for (const variant of ["right after the lull", "after moves that follow the lull"] as const)
		it(`${host}: a reopen ${variant} (the creator's first maintained lull) seals and plays on`, async () => {
			declined.length = 0;
			if (host !== "sqlite")
				restore = installEnvironment((event) => {
					if (event.kind === "room-retention-declined") declined.push(event);
				});
			const fixture = await gridRoom(host, `track-s-${host}-${variant === "right after the lull" ? "a" : "b"}`);
			let peers = [await fixture.open(0), await fixture.open(1)] as const;
			const delivered: (number | null)[] = [null, null];
			const lulls: LullRecord[] = [];
			// Rollovers until the creator's lull first maintains the pool.
			for (let epoch = 0; !lulls.some((lull) => lull.creator.kind === "maintained"); epoch++) {
				expect(epoch, JSON.stringify(lulls)).toBeLessThan(MAX_EPOCHS_TO_FIRST_LULL);
				lulls.push(await lullRollover(fixture, peers, delivered, epoch));
			}
			const lulled = required(lulls.at(-1)).epoch;
			expect(required(lulls.at(-1)).creator, JSON.stringify(lulls)).toEqual({ kind: "maintained" });
			// With `roomRetention: true` the creator's first maintained boundary is still the
			// existing path's: the retention path declines a boundary whose owner controls the
			// existing path has not yet born (Track M, `roomRetentionDeclineReason`).
			if (host === "room-retention")
				expect(
					declined.some((event) => event.epoch === lulled && String(event.reason).endsWith("-birth")),
					JSON.stringify(declined)
				).toBe(true);
			if (process.env.TRACK_S_VERBOSE === "1")
				process.stdout.write(`TRACK_S_LULLS ${host} ${JSON.stringify({ lulls, declined })}\n`);
			const before = required(await creatorRetirementControl(fixture));
			expect(before.active).toBeNull();
			expect(before.completed?.throughEpoch, "the first maintained lull completed this boundary").toBe(lulled - 1);
			// Lawful gameplay at the lulled epoch, before the close.
			if (variant !== "right after the lull") await playOneMoveEach(fixture, peers, delivered, "after-lull");
			const world = peers[0].room.projection();
			expect(peers[1].room.projection()).toEqual(world);

			await fixture.stop(peers[1]);
			await fixture.stop(peers[0]);
			const creator = await stage("reopen", () => fixture.open(0, { reopen: true }));
			const recipient = await stage("reopen", () => fixture.open(1, { reopen: true }));
			peers = [creator, recipient] as const;
			expect(recipient.room.authority()).toMatchObject({ epoch: lulled, objectId: fixture.objectId });
			expect(creator.room.projection()).toEqual(world);
			expect(recipient.room.projection()).toEqual(world);
			// Reopen keeps the completed boundary monotone: no intent left, nothing undone.
			const reopened = required(await creatorRetirementControl(fixture));
			expect(reopened.active).toBeNull();
			expect(required(reopened.completed).throughEpoch).toBeGreaterThanOrEqual(lulled - 1);

			// Continued play: each Writer's moves reach the other, the creator seals and adopts,
			// the recipient installs, and both lulls run at every new epoch.
			const after: LullRecord[] = [];
			for (let epoch = lulled; epoch < lulled + ROLLOVERS_AFTER_REOPEN; epoch++)
				after.push(await stage(`rollover ${epoch}`, () => lullRollover(fixture, peers, delivered, epoch)));
			for (const lull of after) {
				expect(lull.creator.kind, JSON.stringify(after)).not.toBe("deferred");
				expect(lull.recipient.kind, JSON.stringify(after)).not.toBe("deferred");
			}
			expect(recipient.room.authority()).toMatchObject({
				epoch: lulled + ROLLOVERS_AFTER_REOPEN,
				objectId: fixture.objectId,
			});
			await playOneMoveEach(fixture, peers, delivered, "after-rollovers");
			const final = required(await creatorRetirementControl(fixture));
			expect(final.active).toBeNull();
			expect(required(final.completed).throughEpoch).toBeGreaterThan(required(reopened.completed).throughEpoch);
		}, 900_000);
