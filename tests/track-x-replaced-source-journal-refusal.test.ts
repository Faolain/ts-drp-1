import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import {
	blockIds,
	deliver,
	install,
	isControl,
	journalHolds,
	openOutsideRowsRoom as open,
	play,
	protectedEpochs,
	seal,
} from "./fixtures/track-x/outside-rows-room.js";

// Track X, decision row 60, R5 (owner's option A) refusal cases on the node SQLite host (Grid zone
// application, creator-trusted-settlement-v1). A Writer's journal scope holding rows outside its
// signed Cut becomes collectible only when every outside row is this author's own replaced source
// whose replacement is a member of a later signed Cut and equals the source's derivation by the
// immutable policy. Otherwise the scope, with the outside row, is retained:
// (a) its replacement missed the next Cut (and was itself replaced): the scope stays retained.
//     Under that rule the replacement's own scope is collected meanwhile, and the Writer's plan
//     still names the retired replacement: its 6th install after the miss is refused (RESULT
//     section 13, "R5-chain"), so this case stops at the 5th;
// (b) its durable plan entry names a replacement whose operations are not the derivation: the
//     source is never accepted as replaced, so nothing of the scope is deleted;
// (c) the outside row is another Writer's move, received: the scope stays retained (with two
//     Writers playing through every seal this repeats each epoch; see RESULT section 13, R5b).

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

it("(a) a scope whose outside move's replacement missed the next signed Cut stays retained", async () => {
	const room = await open();
	const creator = required(room.peers[0]);
	const history: string[] = [];
	const MISSED = 1;
	let source: DurableIssuanceOutboxRecord | undefined;
	const EPOCHS = 6;
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		// The Writer does not move in the epoch after the missed one: its moves would depend on
		// the withheld replacement, which the creator never admits.
		await play(room, `epoch-${epoch}`, epoch === MISSED + 1 ? [0] : [0, 1]);
		await seal(room, epoch, [1]);
		if (epoch === MISSED)
			source = (await room.fixture.publishedAfter(1, null)).find(
				(row) => row.commit.authorSequence === room.delivered[1]
			);
		await creator.room.adoptCreatorSuccessor();
		const installed = await install(room, 1);
		history.push(`epoch ${epoch + 1}: ${installed}; protected [${(await protectedEpochs(room, 1)).join(",")}]`);
		expect(installed, history.join("\n")).toBe("ok");
		// The missed epoch's replacement reaches the creator only during its next seal, which drops
		// it (the Writer's settlement fence arrives in time); its next install replaces it in turn.
		if (epoch === MISSED) {
			const fence = required((await room.fixture.publishedAfter(1, room.delivered[1]))[0]);
			expect(isControl(fence)).toBe(true);
			// No admission report exists for a control row; the seal's settle covers its admission (had
			// it missed the Cut too, the next install would refuse: RESULT section 13, "R6").
			creator.inject([fence], 1);
			room.delivered[1] = fence.commit.authorSequence;
		} else await deliver(room, 1);
	}
	console.log(`TRACK_X_R5_REFUSAL_A ${JSON.stringify(history)}`);
	// The move converged through the replacement of its replacement.
	expect(blockIds(creator)).toContain(`seal-${MISSED}-1`);
	const kept = await protectedEpochs(room, 1);
	expect(kept, history.join("\n")).toContain(MISSED);
	expect(await journalHolds(room, 1, required(source).commit.envelope.digest)).toBe(true);
	// The other epochs' scopes, whose replacements made the next Cut, were collected.
	expect(kept.filter((epoch) => epoch !== MISSED && epoch < EPOCHS - 3)).toEqual([]);
}, 900_000);

it("(c) a scope holding another Writer's move outside the Cut stays retained", async () => {
	const room = await open(2);
	const creator = required(room.peers[0]);
	const history: string[] = [];
	const OUTSIDE = 1;
	let received: DurableIssuanceOutboxRecord | undefined;
	for (let epoch = 0; epoch < 6; epoch++) {
		await play(room, `epoch-${epoch}`);
		// Writer 2 moves during this seal; Writer 1, still in the sealed epoch, admits it.
		await seal(room, epoch, epoch === OUTSIDE ? [2] : [], epoch === OUTSIDE ? [1] : []);
		if (epoch === OUTSIDE)
			received = (await room.fixture.publishedAfter(2, null)).find(
				(row) => row.commit.authorSequence === room.delivered[2]
			);
		await creator.room.adoptCreatorSuccessor();
		const installed = [await install(room, 1), await install(room, 2)];
		history.push(
			`epoch ${epoch + 1}: ${installed.join(",")}; writer-1 protected [${(await protectedEpochs(room, 1)).join(",")}]`
		);
		expect(installed, history.join("\n")).toEqual(["ok", "ok"]);
		await deliver(room, 1);
		await deliver(room, 2);
	}
	console.log(`TRACK_X_R5_REFUSAL_C ${JSON.stringify(history)}`);
	expect(blockIds(creator)).toContain(`seal-${OUTSIDE}-2`);
	expect(await protectedEpochs(room, 1), history.join("\n")).toContain(OUTSIDE);
	expect(await journalHolds(room, 1, required(received).commit.envelope.digest)).toBe(true);
}, 900_000);
