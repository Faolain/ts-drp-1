/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native lane probes over the real room surface. */
import { afterEach, expect, it } from "vitest";

import { creatorDeliveryRoom } from "./fixtures/track-aa/creator-delivery-room.js";
import { closeFixtures } from "./fixtures/track-m/room-retention-fixture.js";
import { linkSuccessorProtocol } from "./fixtures/track-x/successor-link.js";
import * as cooperativeWork from "../packages/node/src/internal/cooperative-work.js";

// The creator's rollover window (the shipped policy's seal, adopt and export) is the host's
// foreground, as an issue drain, an admitted issuance job and readiness already are. Without
// that registration, co-located background-lane work (a Writer's recovery-pool lull on the
// same event loop, another room's lull, the creator's own) takes a host turn at every turn the
// close yields, and the window stretches by that work: in gate m11 one window took 2,754 ms
// against ~478 ms for its neighbours, and an issue waiting on it inherited the difference.
//
// The measure is the scheduler's own counts, not time. Inside a window, a background host turn
// that ran without deferring, or that resumed because the foreground cohort it found released,
// ran while the creator was rolling over. Each happens only in a gap between registrations (a
// join between seal, serve, adopt and export, or the close's wait for the creator's own
// maintenance job, which must not defer behind the close that waits for it). Resumes at the
// idle window or the hard bound are the scheduler's liveness guarantee and are reported apart;
// that a walk still completes under back-to-back foreground is a scheduler case
// (cooperative-work-foreground.test.ts).

afterEach(async () => expect(await closeFixtures()).toEqual([]));

type Counts = cooperativeWork.BackgroundLaneCounts;
const counts = (): Counts => cooperativeWork.readBackgroundLaneCounts();
function delta(before: Counts, after: Counts) {
	const deferred = after.deferred - before.deferred;
	return {
		// Turns that found no foreground registered.
		ran: after.backgroundTurns - before.backgroundTurns - deferred,
		deferred,
		released: after.released - before.released,
		idle: after.idle - before.idle,
		bound: after.bound - before.bound,
	};
}
// Gaps per window: before the close registers (the FIFO hop and the close's join of the
// creator's own maintenance), close -> serve, serve -> adopt, adopt -> export, plus one spare.
// A waiting background walk takes at most one turn in each.
const GAPS = 5;

/**
 * A co-located background-lane walk: one host turn per step until stopped.
 * @returns Its state and completion.
 */
function backgroundWalk() {
	const state = { turns: 0, stop: false };
	const done = cooperativeWork.runInBackgroundLane(async () => {
		while (!state.stop) {
			state.turns++;
			await cooperativeWork.yieldToHost();
		}
	});
	return { state, done };
}

async function rolloverRoom() {
	const fixture = await creatorDeliveryRoom({ profile: "shipped" });
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	linkSuccessorProtocol(creator, writer, { joinHandlersOnClose: true });
	let epoch = 0;
	// The shipped rollover policy's cut (seal, then adopt), then its export, then the Writer's install.
	const rollover = async (during?: () => void) => {
		for (let index = 0; index < 4; index++)
			await creator.room.issue({ action: "placeBlock", id: `c-${epoch}-${index}`, kind: "stone", x: index, y: epoch });
		const before = counts();
		during?.();
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		const offer = await creator.room.exportCreatorSuccessor();
		const window = delta(before, counts());
		epoch++;
		await writer.room.installCreatorSuccessor({ offer, peers: [creator.peerId] });
		expect(writer.room.authority()?.epoch).toBe(epoch);
		return window;
	};
	return { fixture, creator, writer, rollover };
}

it("a co-located background walk takes no host turn inside the creator's rollover window beyond one per gap", async () => {
	const { rollover } = await rolloverRoom();
	const windows: ReturnType<typeof delta>[] = [];
	for (let index = 0; index < 4; index++) {
		const walk = backgroundWalk();
		windows.push(await rollover());
		walk.state.stop = true;
		await walk.done;
	}
	console.info(JSON.stringify({ windows }));
	for (const window of windows) {
		// The close and adoption each end many native spans at a host boundary, so without
		// registration the walk turns at every one of them.
		expect(window.ran + window.released, JSON.stringify(window)).toBeLessThanOrEqual(GAPS);
	}
}, 300_000);

it("a Writer's recovery-pool lull concurrent with the creator's rollover runs outside the creator's window (m11)", async () => {
	const { writer, rollover } = await rolloverRoom();
	const lulls: string[] = [];
	const windows: (ReturnType<typeof delta> & { lull: string })[] = [];
	// From the third rollover on the Writer's lull finds turnover due (bounded pool pressure).
	for (let index = 0; index < 6; index++) {
		let lull: Promise<string> | undefined;
		const window = await rollover(
			index < 2
				? undefined
				: () => {
						lull = writer.room.maintainRecoveryPool().then(
							(result) => result.kind,
							(error: unknown) => `failed: ${String(error)}`
						);
					}
		);
		const result = (await lull) ?? "none";
		lulls.push(result);
		if (index >= 2) windows.push({ ...window, lull: result });
	}
	console.info(JSON.stringify({ lulls, windows }));
	// The case is vacuous unless the Writer's lull did background work concurrently.
	const maintained = windows.filter((window) => window.lull === "maintained");
	expect(maintained.length, JSON.stringify(lulls)).toBeGreaterThan(0);
	for (const window of maintained) expect(window.ran + window.released, JSON.stringify(window)).toBeLessThanOrEqual(GAPS);
}, 300_000);
