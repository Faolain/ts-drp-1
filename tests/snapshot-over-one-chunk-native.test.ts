import { afterEach, expect, it } from "vitest";

import { closeFixtures } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// Snapshot over one chunk (finding C), native, under the room state limit (finding B).
//
// Finding C: a room whose successor snapshot payload passed one chunk (131,072 bytes) could never seal
// again (the producer cut its chunks with subarray). C's fix makes chunks full-buffer carriers; its unit
// test keeps covering the multi-chunk carrier (packages/protocol-v3).
//
// Under B a room that declares no state limit (every legacy room) has the legacy limit, 32,768 bytes,
// enforced when a move is admitted. So such a room cannot reach a snapshot over one chunk: here a Grid
// room grows by eight 1,000-byte blocks per epoch, its creator's crossing move is refused at L, every
// epoch still seals and adopts, and a cold Writer installs the last successor from its snapshot.
//
// The multi-chunk native path returns with the room state tier track: a cold Writer installs a
// snapshot over 128 KiB in a room declaring a larger tier.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const PER_EPOCH = 8;
const ID_BYTES = 1000;
const LIMIT = 32_768;
const CHUNK_BYTES = 131_072;
const LIMIT_ERROR = /application state limit/u;

it("a legacy room is refused at its 32 KiB state limit before any snapshot passes one chunk; a cold Writer installs it", async () => {
	const fixture = await readinessHoldRoom();
	const creator = await fixture.open(0);
	const stateBytes = (): number => new TextEncoder().encode(JSON.stringify(creator.room.projection().blocks)).byteLength;
	let epoch = 0;
	let placed = 0;
	let refusal: string | undefined;
	const failures: string[] = [];
	while (refusal === undefined && epoch < 30) {
		for (let index = 0; index < PER_EPOCH && refusal === undefined; index++) {
			const id = `${String(placed).padStart(5, "0")}-${"b".repeat(ID_BYTES)}`;
			try {
				await creator.room.issue({ action: "placeBlock", id, kind: "stone", x: placed % 16, y: epoch });
				placed++;
			} catch (error) {
				refusal = error instanceof Error ? error.message : String(error);
			}
		}
		try {
			const sealed = await creator.room.sealEpoch();
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			await creator.room.adoptCreatorSuccessor();
		} catch (error) {
			failures.push(`epoch ${epoch} at ${stateBytes()} state bytes: ${error instanceof Error ? error.message : String(error)}`);
		}
		epoch++;
	}
	console.log(`SNAPSHOT_LEGACY_LIMIT ${JSON.stringify({ epoch, placed, stateBytes: stateBytes(), refusal, failures })}`);
	expect(refusal, "the crossing move is refused at the legacy limit").toMatch(LIMIT_ERROR);
	expect(failures, "every successor is sealed and adopted").toEqual([]);
	expect(creator.room.authority()?.epoch).toBe(epoch);
	// The blocks alone stay within the limit, far below one chunk.
	expect(stateBytes()).toBeLessThanOrEqual(LIMIT);
	expect(LIMIT).toBeLessThan(CHUNK_BYTES);

	// The cold Writer opens only now: its store holds nothing of this room past genesis.
	const writer = await fixture.open(1);
	const transfer = await settlementDelivery(fixture as unknown as SettlementRoom);
	Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
	expect(writer.room.authority()?.epoch).toBe(epoch);
	expect(writer.room.projection().blocks.length).toBe(placed);
}, 900_000);
