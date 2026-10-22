import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import {
	blockIds,
	deliver,
	install,
	openOutsideRowsRoom,
	play,
	protectedEpochs,
	seal,
} from "./fixtures/track-x/outside-rows-room.js";

// Track X, decision row 60, R5b: the creator and two Writers. Writer B moves during every seal of
// the creator, and Writer A, still in the sealed epoch, admits B's move. The move is outside the
// signed Cut and was received, so A's journal scope of that epoch was never collectible: under the
// owner's option A (R5) only this author's own replaced moves may lie outside the Cut. A's protected
// scopes grew by one per rollover, until the journal's seven protected scopes were exceeded and A's
// install refused. The owner's decision (B2): a received row outside cut(e) becomes collectible once
// A has durably installed cut(e)'s successor; A's closed-membership carrier subtracts other authors'
// rows beyond their creator-signed settlement frontiers. Grid zone application,
// creator-trusted-settlement-v1, the node SQLite host.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const EPOCHS = Number(process.env.TRACK_X_R5B_EPOCHS ?? 12);
// As in the R5 RED: the current scope and the two before it for replay, and one more in flight.
const PROTECTED_BOUND = 4;

it(`a Writer that admits another Writer's move made during every seal keeps its protected journal scopes bounded through ${EPOCHS} rollovers`, async () => {
	const room = await openOutsideRowsRoom(2);
	const creator = required(room.peers[0]);
	const history: string[] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		await play(room, `epoch-${epoch}`);
		// Writer B (2) moves during the seal; Writer A (1) admits it, the creator only after the seal.
		await seal(room, epoch, [2], [1]);
		await creator.room.adoptCreatorSuccessor();
		const installed = [await install(room, 1), await install(room, 2)];
		const kept = [await protectedEpochs(room, 1), await protectedEpochs(room, 2)];
		history.push(
			`epoch ${epoch + 1}: ${installed.join(",")}; protected A [${kept[0]!.join(",")}] B [${kept[1]!.join(",")}]`
		);
		expect(installed, history.join("\n")).toEqual(["ok", "ok"]);
		// B's replacement (and both Writers' fences) reach every peer before the next seal.
		await deliver(room, 1);
		await deliver(room, 2);
		expect(blockIds(creator)).toContain(`seal-${epoch}-2`);
		expect(kept[0]!.length, history.join("\n")).toBeLessThanOrEqual(PROTECTED_BOUND);
		expect(kept[1]!.length, history.join("\n")).toBeLessThanOrEqual(PROTECTED_BOUND);
	}
	console.log(`TRACK_X_R5B ${JSON.stringify(history)}`);
	expect(required(room.peers[1]).room.projection()).toEqual(creator.room.projection());
	expect(required(room.peers[2]).room.projection()).toEqual(creator.room.projection());
}, 900_000);
