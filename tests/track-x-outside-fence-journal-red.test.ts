import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import {
	blockIds,
	deliver,
	install,
	isControl,
	journalHolds,
	openOutsideRowsRoom,
	type OutsideRowsRoom,
	play,
	protectedEpochs,
	seal,
} from "./fixtures/track-x/outside-rows-room.js";

// Track X, decision row 60, R7 (Track J's counterexample, confirmed by its model): a Writer's
// settlement fence, published by its install of e+1, reaches the creator only after the creator
// has sealed e+1, so the fence is outside cut(e+1). The fence has no settlement plan entry (no
// intents, no disposition), and the replaced-source reader refuses control operations, so the
// Writer's journal scope of e+1 was retained for good. The fence then stayed a protected hole that
// held the issuance store's contiguous pruning watermark below it: with a move made during the same
// seal, the move's completed plan entry was never dropped (its replacement was retired logically,
// never pruned), and a later install refused "settlement plan references retired or absent issued
// work"; with no moves, each missed fence kept one more scope until the journal's protected-scope
// limit. The owner's rule (R7): an outside own fence is collectible once a later own fence by the
// same Writer is a member of a signed Cut this Writer knows. Grid zone application,
// creator-trusted-settlement-v1, the node SQLite host.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const PROTECTED_BOUND = 4;

/**
 * The Writer's rows not yet handed to the creator, given to it now (after its seal).
 * @param room - The room.
 * @returns The rows.
 */
async function injectLate(room: OutsideRowsRoom): Promise<readonly DurableIssuanceOutboxRecord[]> {
	const rows = await room.fixture.publishedAfter(1, room.delivered[1] ?? null);
	if (rows.length === 0) return rows;
	required(room.peers[0]).inject(rows, 1);
	room.delivered[1] = required(rows.at(-1)).commit.authorSequence;
	return rows;
}

it("(i) a Writer whose fence and seal-time move both missed the Cut keeps installing, its scopes bounded", async () => {
	const epochs = Number(process.env.TRACK_X_R7_EPOCHS ?? 10);
	const missed = 1;
	const room = await openOutsideRowsRoom();
	const creator = required(room.peers[0]);
	const history: string[] = [];
	let fence: DurableIssuanceOutboxRecord | undefined;
	for (let epoch = 0; epoch < epochs; epoch++) {
		// In the missed epoch the Writer moves only during the seal: a move before it would carry
		// the withheld fence to the creator first.
		await play(room, `epoch-${epoch}`, epoch === missed ? [0] : [0, 1]);
		// The seal hands the creator the withheld fence and the Writer's seal-time move after it
		// has sealed, so both are outside cut(missed).
		await seal(room, epoch, epoch === missed ? [1] : []);
		await creator.room.adoptCreatorSuccessor();
		const installed = await install(room, 1);
		const kept = await protectedEpochs(room, 1);
		history.push(`epoch ${epoch + 1}: ${installed}; protected [${kept.join(",")}]`);
		expect(installed, history.join("\n")).toBe("ok");
		if (epoch === missed - 1) {
			fence = required((await room.fixture.publishedAfter(1, room.delivered[1] ?? null))[0]);
			expect(isControl(fence)).toBe(true);
		} else await deliver(room, 1);
		expect(kept.length, history.join("\n")).toBeLessThanOrEqual(PROTECTED_BOUND);
	}
	console.log(`TRACK_X_R7_I ${JSON.stringify(history)}`);
	expect(blockIds(creator)).toContain(`seal-${missed}-1`);
	expect(await protectedEpochs(room, 1), history.join("\n")).not.toContain(missed);
	expect(await journalHolds(room, 1, required(fence).commit.envelope.digest), "the fence's scope collected").toBe(
		false
	);
	expect(required(room.peers[1]).room.projection()).toEqual(creator.room.projection());
}, 900_000);

it("(ii) a Writer that makes no moves and whose fence missed the Cut at 6 seals keeps its scopes bounded", async () => {
	const epochs = Number(process.env.TRACK_X_R7_NO_MOVE_EPOCHS ?? 14);
	// The fences published by the installs after these seals reach the creator after its next seal.
	const withheld = new Set([0, 2, 4, 6, 8, 10]);
	const room = await openOutsideRowsRoom();
	const creator = required(room.peers[0]);
	const history: string[] = [];
	const fences: DurableIssuanceOutboxRecord[] = [];
	let late = false;
	// The Writer's rows from the room's opening.
	await deliver(room, 1);
	for (let epoch = 0; epoch < epochs; epoch++) {
		await play(room, `epoch-${epoch}`, [0]);
		await seal(room, epoch);
		if (late) {
			const rows = await injectLate(room);
			expect(rows.map(isControl)).toEqual([true]);
			fences.push(required(rows[0]));
		}
		await creator.room.adoptCreatorSuccessor();
		const installed = await install(room, 1);
		const kept = await protectedEpochs(room, 1);
		history.push(`epoch ${epoch + 1}: ${installed}; protected [${kept.join(",")}]`);
		expect(installed, history.join("\n")).toBe("ok");
		late = withheld.has(epoch);
		if (!late) await deliver(room, 1);
		expect(kept.length, history.join("\n")).toBeLessThanOrEqual(PROTECTED_BOUND);
	}
	console.log(`TRACK_X_R7_II ${JSON.stringify(history)}`);
	expect(fences).toHaveLength(withheld.size);
	// The last missed fence's scope may still be in the replay window.
	const kept = await protectedEpochs(room, 1);
	for (const epoch of [...withheld].slice(0, -1)) expect(kept, history.join("\n")).not.toContain(epoch + 1);
	for (const fence of fences.slice(0, -1))
		expect(await journalHolds(room, 1, fence.commit.envelope.digest), "the fence's scope collected").toBe(false);
	expect(required(room.peers[1]).room.projection()).toEqual(creator.room.projection());
}, 900_000);
