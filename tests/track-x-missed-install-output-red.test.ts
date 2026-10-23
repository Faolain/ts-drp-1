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

// Track X, decision row 60, R6: a Writer's move made during the creator's seal of epoch e is
// replaced by its install of e+1, but the Writer's whole install output (its settlement fence and
// the replacement) reaches the creator only during the creator's next seal, so it misses cut(e+1).
// That happens when an install ends, or its rows arrive, after the creator has begun its next seal
// (slow installs with automatic rollovers). The Writer's next install refused in its recovery
// census ("creator recovery dependency hold unavailable: outbox-classification:<source>:displaced:
// published"), and every retry the same: the source's plan entry is complete, but its replacement
// is in no Cut, the creator's terminal frontier stops below the source (the fence missed the Cut),
// and the completion check's derivation needed the source epoch's ACL, which resolves only for the
// immediately closed epoch. The owner's decision (R6-A): for a source older than the closed epoch,
// recognize completion with the immutable policy's derivation; the source stays authenticated by
// the census's own classification, and the plan entry and replacement rows are checked as before.
// The scopes that held the outside rows (the move, and the missed fence and replacement) must be
// collected too, with the Writer's protected scopes bounded. Grid zone application,
// creator-trusted-settlement-v1, the node SQLite host.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const EPOCHS = Number(process.env.TRACK_X_R6_EPOCHS ?? 10);
const PROTECTED_BOUND = 4;
const MISSED = 1;

it(`a Writer whose whole install output missed the next Cut keeps installing, its scopes bounded, through ${EPOCHS} rollovers`, async () => {
	const room = await openOutsideRowsRoom();
	const creator = required(room.peers[0]);
	const history: string[] = [];
	let source: DurableIssuanceOutboxRecord | undefined;
	let fence: DurableIssuanceOutboxRecord | undefined;
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		// The Writer does not move in the epoch after the missed one: its moves would depend on its
		// withheld install output.
		await play(room, `epoch-${epoch}`, epoch === MISSED + 1 ? [0] : [0, 1]);
		// During the seal after the missed one, the creator receives the withheld fence and
		// replacement with the Writer's seal move, and its sealed plane drops them all.
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
			fence = required((await room.fixture.publishedAfter(1, room.delivered[1]))[0]);
			expect(isControl(fence)).toBe(true);
		} else await deliver(room, 1);
		expect(kept.length, history.join("\n")).toBeLessThanOrEqual(PROTECTED_BOUND);
	}
	console.log(`TRACK_X_R6 ${JSON.stringify(history)}`);
	expect(blockIds(creator)).toContain(`seal-${MISSED}-1`);
	const kept = await protectedEpochs(room, 1);
	expect(kept, history.join("\n")).not.toContain(MISSED);
	expect(kept, history.join("\n")).not.toContain(MISSED + 1);
	expect(await journalHolds(room, 1, required(source).commit.envelope.digest), "the move's scope collected").toBe(
		false
	);
	expect(await journalHolds(room, 1, required(fence).commit.envelope.digest), "the fence's scope collected").toBe(
		false
	);
	expect(required(room.peers[1]).room.projection()).toEqual(creator.room.projection());
}, 900_000);
