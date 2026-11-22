import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// A Grid room whose application state reaches its limit keeps rolling over.
//
// The Grid reducer keeps one block per distinct id, so the folded state grows with every new block.
// Originally (fix/int7-handback-policy, round-2 slow-member) the live plane folded up to
// maxSnapshotBytes and signed successor states past 32 KiB that the projection base then refused,
// so the room stuck at that epoch; d60743d4 made the room accept every state it seals. The room's
// application state is now bounded at admission by its limit (32,768 bytes for a room that declares
// none): the move that would pass it is refused with a typed error before it is signed, so no state
// past the limit is ever sealed, and d60743d4's "the room accepts every state it seals" still holds.
// Eight 400-byte block ids per epoch reach the limit around epoch 9.

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const PER_EPOCH = Number(process.env.GRID_STATE_PER_EPOCH ?? 8);
const ID_BYTES = Number(process.env.GRID_STATE_ID_BYTES ?? 400);
const EPOCHS = Number(process.env.GRID_STATE_EPOCHS ?? 14);
const LIMIT_ERROR = /application state limit/u;

const explain = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Issues one epoch's blocks; after the first refusal, re-places an admitted block (no growth). */
async function issueEpoch(
	room: { issue(operation: Record<string, unknown>): Promise<unknown> },
	epoch: number,
	progress: { admitted: number; refusal?: string }
): Promise<void> {
	for (let index = 0; index < PER_EPOCH; index++) {
		const ordinal = epoch * PER_EPOCH + index;
		if (progress.refusal !== undefined) {
			const id = `${String(index).padStart(4, "0")}-${"b".repeat(ID_BYTES)}`;
			await room.issue({ action: "placeBlock", id, kind: epoch % 2 === 0 ? "gold" : "stone", x: index % 16, y: 0 });
			continue;
		}
		const id = `${String(ordinal).padStart(4, "0")}-${"b".repeat(ID_BYTES)}`;
		try {
			await room.issue({ action: "placeBlock", id, kind: "stone", x: ordinal % 16, y: epoch });
			progress.admitted++;
		} catch (error) {
			progress.refusal = explain(error);
		}
	}
}

it("a Grid creator whose state reaches 32 KiB is refused the crossing move and still seals and adopts", async () => {
	const fixture = await readinessHoldRoom({ writers: 0 });
	const creator = await fixture.open(0);
	const sizes: { epoch: number; projectionJsonBytes: number }[] = [];
	let failure: string | undefined;
	const progress: { admitted: number; refusal?: string } = { admitted: 0 };
	for (let epoch = 0; epoch < EPOCHS && failure === undefined; epoch++) {
		await issueEpoch(creator.room, epoch, progress);
		sizes.push({
			epoch,
			projectionJsonBytes: new TextEncoder().encode(JSON.stringify(creator.room.projection())).byteLength,
		});
		try {
			const sealed = await creator.room.sealEpoch();
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			await creator.room.adoptCreatorSuccessor();
		} catch (error) {
			failure = `epoch ${epoch}: ${explain(error)}`;
		}
	}
	console.log(
		`GRID_STATE_OVER_32K ${JSON.stringify({ perEpoch: PER_EPOCH, idBytes: ID_BYTES, sizes, failure, ...progress })}`
	);
	expect(progress.refusal, "the move that would pass the limit is refused, typed").toMatch(LIMIT_ERROR);
	expect(failure, "every successor is sealed and adopted").toBeUndefined();
	expect(creator.room.projection().blocks.length).toBe(progress.admitted);
	expect(creator.room.authority()?.epoch).toBe(EPOCHS);
}, 600_000);

it("a Writer installs every successor of a Grid room whose state reaches 32 KiB", async () => {
	const fixture = await readinessHoldRoom();
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	let delivered: number | null = null;
	const deliverCreator = async (): Promise<void> => {
		const rows = await fixture.publishedAfter(0, delivered);
		for (let start = 0; start < rows.length; start += 16) {
			const chunk = rows.slice(start, start + 16);
			const last = chunk.findLastIndex((row) => !isControl(row));
			if (last >= 0) await writer.receive(chunk.slice(0, last + 1), 0);
			writer.inject(chunk.slice(last + 1), 0);
		}
		if (rows.length !== 0) delivered = required(rows.at(-1)).commit.authorSequence;
	};
	const failures: string[] = [];
	const progress: { admitted: number; refusal?: string } = { admitted: 0 };
	for (let epoch = 0; epoch < EPOCHS && failures.length === 0; epoch++) {
		await issueEpoch(creator.room, epoch, progress);
		await deliverCreator();
		try {
			const sealed = await creator.room.sealEpoch();
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			const transfer = await settlementDelivery(fixture as unknown as SettlementRoom);
			Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
			await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
			expect(writer.room.authority()?.epoch).toBe(epoch + 1);
		} catch (error) {
			failures.push(`epoch ${epoch}: ${explain(error)}`);
		}
	}
	console.log(
		`GRID_STATE_OVER_32K_WRITER ${JSON.stringify({ failures, ...progress, blocks: writer.room.projection().blocks.length })}`
	);
	expect(progress.refusal, "the move that would pass the limit is refused, typed").toMatch(LIMIT_ERROR);
	expect(failures, "the Writer installs every successor").toEqual([]);
	expect(writer.room.projection().blocks.length).toBe(progress.admitted);
}, 900_000);
