import { afterEach, expect, it } from "vitest";

import { closeFixtures } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// RED (room state limit, finding C), native: a room whose successor snapshot payload passes one
// chunk (131,072 bytes) can never seal again, and no member could install it. The creator's own
// sealEpoch refuses its chunks ("snapshot chunk carrier is invalid"), because the producer cut them
// with subarray. Here a Grid room grows by eight 1,000-byte blocks per epoch until its state passes
// 131,072 bytes; then a Writer whose store has never seen the room installs the successor from its
// snapshot (the cold-join path).

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const PER_EPOCH = 8;
const ID_BYTES = 1000;
const STATE_TARGET = 140_000;

it("a creator seals and adopts successors whose snapshot passes one chunk, and a cold Writer installs one", async () => {
	const fixture = await readinessHoldRoom();
	const creator = await fixture.open(0);
	const stateBytes = (): number => new TextEncoder().encode(JSON.stringify(creator.room.projection().blocks)).byteLength;
	let epoch = 0;
	let failure: string | undefined;
	while (failure === undefined && stateBytes() < STATE_TARGET && epoch < 30) {
		for (let index = 0; index < PER_EPOCH; index++) {
			const ordinal = epoch * PER_EPOCH + index;
			const id = `${String(ordinal).padStart(5, "0")}-${"b".repeat(ID_BYTES)}`;
			await creator.room.issue({ action: "placeBlock", id, kind: "stone", x: ordinal % 16, y: epoch });
		}
		try {
			const sealed = await creator.room.sealEpoch();
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			await creator.room.adoptCreatorSuccessor();
		} catch (error) {
			failure = `epoch ${epoch} at ${stateBytes()} state bytes: ${error instanceof Error ? error.message : String(error)}`;
		}
		epoch++;
	}
	console.log(`SNAPSHOT_OVER_ONE_CHUNK ${JSON.stringify({ epoch, stateBytes: stateBytes(), failure })}`);
	expect(failure, "every successor is sealed and adopted").toBeUndefined();
	expect(stateBytes()).toBeGreaterThan(131_072);
	expect(creator.room.authority()?.epoch).toBe(epoch);

	// The cold Writer opens only now: its store holds nothing of this room past genesis.
	const writer = await fixture.open(1);
	const transfer = await settlementDelivery(fixture as unknown as SettlementRoom);
	// This successor's state is at least the one whose seal refused its chunks before the fix, so its
	// snapshot spans more than one chunk.
	Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
	expect(writer.room.authority()?.epoch).toBe(epoch);
	expect(writer.room.projection().blocks.length).toBe(epoch * PER_EPOCH);
}, 900_000);
