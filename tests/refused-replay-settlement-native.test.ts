import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// RED (refused replay, fix/refused-replay-settlement): a Writer's displaced move whose replay the
// room's admission refuses stops the Writer's install for good.
//
// A Writer's move that the creator's epoch closes without (late, or refused at the creator) is
// displaced; the Writer's next install replays it in the new epoch (a settlement replacement). When
// the room's operation admission policy refuses that replay (here a policy whose rule refuses the
// move from epoch 2 on; in the shipped zone, an outcome identity another author committed first),
// issueSettlement throws "v3 room settlement issue failed: admission-rejected" and
// installCreatorSuccessor fails: the Writer is stuck at its epoch.
//
// Wanted: the install completes and the Writer keeps playing; the refused move is never replayed
// again and never silently lost: it is given back to the application as a durable hand-back record
// typed with the refusal reason (settlementStatus().undelivered, reason "admission-rejected").

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const DOOM_EPOCH = 2;
const fresh = Object.freeze({ kind: "fresh" as const, commit: () => "committed" as const, release: () => undefined });

/** Admits every move, except a "doomed" block from DOOM_EPOCH on (the rule its replay meets). */
const doomingPolicy = (context: Readonly<{ epoch: number }>) =>
	Object.freeze({
		reserve: (operation: Readonly<Record<string, unknown>>) =>
			context.epoch >= DOOM_EPOCH && String(operation.id ?? "").startsWith("doomed")
				? Object.freeze({ kind: "rejected" as const })
				: fresh,
	});

const block = (id: string, x: number) => ({ action: "placeBlock", id, kind: "stone", x, y: 0 });
const explain = (error: unknown): string => (error instanceof Error ? error.message : String(error));

it("a displaced move whose replay the room refuses is handed back typed, and the Writer keeps installing", async () => {
	const fixture = await readinessHoldRoom({ writers: 1, createOperationAdmissionPolicy: doomingPolicy as never });
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	let delivered: number | null = null;
	const deliver = async (): Promise<void> => {
		const rows: readonly DurableIssuanceOutboxRecord[] = await fixture.publishedAfter(1, delivered);
		for (let start = 0; start < rows.length; start += 16) {
			const chunk = rows.slice(start, start + 16);
			const last = chunk.findLastIndex((row) => !isControl(row));
			if (last >= 0) await creator.receive(chunk.slice(0, last + 1), 1);
			creator.inject(chunk.slice(last + 1), 1);
		}
		if (rows.length !== 0) delivered = required(rows.at(-1)).commit.authorSequence;
	};
	const rollover = async (epoch: number): Promise<void> => {
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, 1);
		Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		expect(writer.room.authority()?.epoch).toBe(epoch);
	};
	const ids = (room: typeof creator): string[] =>
		(room.room.projection() as { blocks: readonly { id: string }[] }).blocks.map((value) => value.id).sort();

	// Epoch 0: an ordinary move lands.
	await writer.room.issue(block("w-0", 0));
	await deliver();
	await rollover(1);
	await deliver(); // the Writer's epoch-1 fence reaches the creator
	// Epoch 1: the doomed move is admitted by the Writer but never reaches the creator.
	await writer.room.issue(block("doomed-1", 1));
	// It is lost on the way: the creator never receives it (the stale row is never delivered later).
	const lost = await fixture.publishedAfter(1, delivered);
	expect(lost.filter((row) => !isControl(row)).length).toBe(1);
	delivered = required(lost.at(-1)).commit.authorSequence;
	const failures: string[] = [];
	try {
		await rollover(2); // the install replays the displaced move; the epoch-2 rule refuses it
	} catch (error) {
		failures.push(`install 2: ${explain(error)}`);
	}
	const status = writer.room.settlementStatus?.();
	console.log(`REFUSED_REPLAY ${JSON.stringify({ failures, status })}`);
	expect(failures, "the install completes").toEqual([]);
	const undelivered = required(status).undelivered;
	expect(undelivered.map((move) => move.operations[0]?.id), "the refused move is given back").toEqual(["doomed-1"]);
	expect(Reflect.get(required(undelivered[0]), "reason"), "typed with the refusal reason").toBe("admission-rejected");

	// The Writer keeps playing, and the refused move is never replayed again.
	await deliver();
	await writer.room.issue(block("w-2", 2));
	await deliver();
	await rollover(3);
	await deliver();
	await rollover(4);
	expect(ids(creator)).toEqual(["w-0", "w-2"]);
	expect(ids(writer)).toEqual(["w-0", "w-2"]);
	const later = required(writer.room.settlementStatus?.()).undelivered;
	expect(later.map((move) => move.operations[0]?.id), "listed once, never replayed").toEqual(["doomed-1"]);
	const replays = (await fixture.publishedAfter(1, null)).filter((row) => !isControl(row));
	console.log(`REFUSED_REPLAY_ROWS ${replays.length}`);
}, 600_000);
