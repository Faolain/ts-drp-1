import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// RED (fix/int7-handback-policy, round-2 slow-member): a Grid room whose application state passes
// 32,768 bytes can never roll over.
//
// The Grid reducer keeps one block per distinct id, so the folded state grows with every new block.
// The native live plane bounds application state by the room's parameters (maxSnapshotBytes,
// 256 MiB for Grid; at most 16,384 canonical items), and the creator's close folds and signs a
// successor state of any size within that bound. But installSuccessorProjectionBase normalizes the
// successor's projection base with a fixed 32,768-byte cap ("v3 room migration state is unbounded"),
// so the creator's own adoption throws and the room is stuck at that epoch for good. Measured in
// app-rollover-slow-member-native test 2: after about 730 distinct blocks (7 moves per author per
// epoch, creator epoch ~107). Here eight 400-byte block ids per epoch pass it at epoch 9.

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const PER_EPOCH = Number(process.env.GRID_STATE_PER_EPOCH ?? 8);
const ID_BYTES = Number(process.env.GRID_STATE_ID_BYTES ?? 400);
const EPOCHS = Number(process.env.GRID_STATE_EPOCHS ?? 14);

it("a Grid creator whose state passes 32 KiB still seals and adopts its successor", async () => {
	const fixture = await readinessHoldRoom({ writers: 0 });
	const creator = await fixture.open(0);
	const sizes: { epoch: number; projectionJsonBytes: number }[] = [];
	let failure: string | undefined;
	for (let epoch = 0; epoch < EPOCHS && failure === undefined; epoch++) {
		for (let index = 0; index < PER_EPOCH; index++) {
			const ordinal = epoch * PER_EPOCH + index;
			const id = `${String(ordinal).padStart(4, "0")}-${"b".repeat(ID_BYTES)}`;
			await creator.room.issue({ action: "placeBlock", id, kind: "stone", x: ordinal % 16, y: epoch });
		}
		sizes.push({
			epoch,
			projectionJsonBytes: new TextEncoder().encode(JSON.stringify(creator.room.projection())).byteLength,
		});
		try {
			const sealed = await creator.room.sealEpoch();
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			await creator.room.adoptCreatorSuccessor();
		} catch (error) {
			failure = `epoch ${epoch}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	console.log(`GRID_STATE_OVER_32K ${JSON.stringify({ perEpoch: PER_EPOCH, idBytes: ID_BYTES, sizes, failure })}`);
	expect(sizes.at(-1)?.projectionJsonBytes ?? 0, "the folded state passed 32 KiB").toBeGreaterThan(32_768);
	expect(failure, "every successor is sealed and adopted").toBeUndefined();
	expect(creator.room.authority()?.epoch).toBe(EPOCHS);
}, 600_000);

it("a Writer installs every successor of a Grid room whose state passes 32 KiB", async () => {
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
	for (let epoch = 0; epoch < EPOCHS && failures.length === 0; epoch++) {
		for (let index = 0; index < PER_EPOCH; index++) {
			const ordinal = epoch * PER_EPOCH + index;
			const id = `${String(ordinal).padStart(4, "0")}-${"b".repeat(ID_BYTES)}`;
			await creator.room.issue({ action: "placeBlock", id, kind: "stone", x: ordinal % 16, y: epoch });
		}
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
			failures.push(`epoch ${epoch}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	console.log(
		`GRID_STATE_OVER_32K_WRITER ${JSON.stringify({ failures, blocks: writer.room.projection().blocks.length })}`
	);
	expect(failures, "the Writer installs every successor").toEqual([]);
	expect(writer.room.projection().blocks.length).toBe(EPOCHS * PER_EPOCH);
}, 900_000);
