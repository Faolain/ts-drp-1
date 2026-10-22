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
	play,
	protectedEpochs,
	seal,
} from "./fixtures/track-x/outside-rows-room.js";

// Track X, decision row 60, R5-chain: a Writer's move made during the creator's seal of epoch e
// is replaced in e+1, and that replacement misses cut(e+1) too (it reaches the creator only during
// the next seal, while the Writer's settlement fence makes the Cut); the next install replaces the
// replacement, and that replacement is in cut(e+2). Under option A's literal rule the scope of e
// stayed retained for good (its replacement is in no signed Cut), while the scope of e+1 was
// collected: the issuance retirement then retired the first replacement, the Writer's plan still
// named it, and every later plan write was refused ("settlement plan references retired or absent
// issued work"), so the Writer's install of epoch 7 failed. The owner's decision (C1): follow the
// chain. An outside row is collectible when its replacement is in a later signed Cut, or is itself a
// replaced outside row of a later scope that meets the same rule; each link equals the derivation of
// its source by the immutable policy, the last link is a member of a signed Cut, and the walk is
// bounded by the journal's protected-scope limit. Refusal (a) is now "no link of the chain is in a
// signed Cut yet". Grid zone application, creator-trusted-settlement-v1, the node SQLite host.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const EPOCHS = Number(process.env.TRACK_X_R5_CHAIN_EPOCHS ?? 10);
const PROTECTED_BOUND = 4;
const MISSED = 1;

it(`a Writer whose replacement missed the next Cut too keeps installing and collects both scopes through ${EPOCHS} rollovers`, async () => {
	const room = await openOutsideRowsRoom();
	const creator = required(room.peers[0]);
	const history: string[] = [];
	let source: DurableIssuanceOutboxRecord | undefined;
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		// The Writer does not move in the epoch after the missed one: its moves would depend on the
		// withheld replacement, which the creator drops.
		await play(room, `epoch-${epoch}`, epoch === MISSED + 1 ? [0] : [0, 1]);
		await seal(room, epoch, [1]);
		if (epoch === MISSED)
			source = (await room.fixture.publishedAfter(1, null)).find(
				(row) => row.commit.authorSequence === room.delivered[1]
			);
		await creator.room.adoptCreatorSuccessor();
		const installed = await install(room, 1);
		const kept = await protectedEpochs(room, 1);
		history.push(`epoch ${epoch + 1}: ${installed}; protected [${kept.join(",")}]`);
		expect(installed, history.join("\n")).toBe("ok");
		if (epoch === MISSED) {
			// Only the settlement fence reaches the creator before its next seal (no admission
			// report exists for a control row; the seal's settle covers it).
			const fence = required((await room.fixture.publishedAfter(1, room.delivered[1]))[0]);
			expect(isControl(fence)).toBe(true);
			creator.inject([fence], 1);
			room.delivered[1] = fence.commit.authorSequence;
		} else await deliver(room, 1);
		expect(kept.length, history.join("\n")).toBeLessThanOrEqual(PROTECTED_BOUND);
	}
	console.log(`TRACK_X_R5_CHAIN ${JSON.stringify(history)}`);
	// The move converged through the replacement of its replacement, and both scopes were collected.
	expect(blockIds(creator)).toContain(`seal-${MISSED}-1`);
	expect(await protectedEpochs(room, 1), history.join("\n")).not.toContain(MISSED);
	expect(await journalHolds(room, 1, required(source).commit.envelope.digest), "collected").toBe(false);
	expect(required(room.peers[1]).room.projection()).toEqual(creator.room.projection());
}, 900_000);
