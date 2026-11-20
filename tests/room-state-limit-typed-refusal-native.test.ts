import { encodeCanonical } from "@ts-drp/canonical";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { ROOM_APPLICATION_STATE_BYTES } from "../packages/node/src/v3-live.js";

// A NEW move the room refuses because it would pass the room's application state limit (row 96) is
// refused with a typed error the application can branch on: V3RoomStateLimitRefused (name, kind
// "application-state-limit", limitBytes), never a plain TypeError the app can only string-match. The
// player keeps playing: a later growing move gets the same typed refusal, a move that does not grow the
// state is admitted, and the room keeps sealing. (A given-back move refused at the limit has its own
// typed refusal, V3RoomHandBackRefused.)

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

type Block = { action: "placeBlock"; id: string; kind: string; x: number; y: number };
type Projection = {
	creatorAuthor: string;
	creatorPeerId: string;
	blocks: readonly Omit<Block, "action">[];
	outcomes: readonly unknown[];
	roster: readonly unknown[];
};

const block = (prefix: string, ordinal: number, idBytes: number): Block => ({
	action: "placeBlock",
	id: `${prefix}-${String(ordinal).padStart(5, "0")}-${"b".repeat(idBytes)}`,
	kind: "stone",
	x: ordinal % 16,
	y: Math.floor(ordinal / 16) % 16,
});

/** The Grid zone's exact canonical state with these placements added (the room's state-limit measure). */
function stateBytesWith(projection: Projection, added: readonly Block[]): number {
	const blocks = new Map(projection.blocks.map((value) => [value.id, value]));
	for (const { action: _action, ...value } of added) blocks.set(value.id, value);
	return encodeCanonical({
		version: 2,
		creatorAuthor: projection.creatorAuthor,
		creatorPeerId: projection.creatorPeerId,
		blocks: [...blocks.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
		outcomes: projection.outcomes,
		roster: projection.roster,
	}).byteLength;
}

/** The typed state-limit refusal's observable fields (name, kind, limit), or the plain error's message. */
const refusalOf = (error: unknown) =>
	error instanceof Error
		? {
				name: error.name,
				kind: Reflect.get(error, "kind") as unknown,
				limitBytes: Reflect.get(error, "limitBytes") as unknown,
				message: error.message,
			}
		: { name: typeof error, kind: undefined, limitBytes: undefined, message: String(error) };

const TYPED = {
	name: "V3RoomStateLimitRefused",
	kind: "application-state-limit",
	limitBytes: ROOM_APPLICATION_STATE_BYTES,
	message: expect.stringMatching(/application state limit/u),
};

async function creatorRoom() {
	const fixture = await readinessHoldRoom({ writers: 0 });
	const creator = await fixture.open(0);
	const projection = () => creator.room.projection() as unknown as Projection;
	const roll = async (): Promise<void> => {
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();
	};
	return { creator, projection, roll };
}

it("a new move past the room's state limit is refused typed (V3RoomStateLimitRefused); the player keeps playing", async () => {
	const { creator, projection, roll } = await creatorRoom();
	let placed = 0;
	let refusal: unknown;
	for (let epoch = 0; epoch < 8 && refusal === undefined; epoch++) {
		for (let index = 0; index < 8 && refusal === undefined; index++) {
			try {
				await creator.room.issue(block("big", placed, 1000));
				placed++;
			} catch (error) {
				refusal = error;
			}
		}
		await roll();
	}
	console.log(`STATE_LIMIT_TYPED ${JSON.stringify({ placed, refusal: refusalOf(refusal) })}`);
	expect(refusal, "the fill reaches the limit").toBeDefined();
	expect(stateBytesWith(projection(), [block("big", placed, 1000)]), "the refused move would pass the limit").toBeGreaterThan(
		ROOM_APPLICATION_STATE_BYTES
	);
	expect(refusalOf(refusal), "the crossing move's refusal is typed").toEqual(TYPED);
	// The player keeps playing: a later growing move is refused typed again, never wedged.
	await expect(creator.room.issue(block("big", placed + 1, 1000)).catch(refusalOf)).resolves.toEqual(TYPED);
	// A move that does not grow the state (re-placing an existing block) is admitted, and the room rolls.
	await creator.room.issue({ ...block("big", 0, 1000), kind: "gold" });
	await roll();
	expect(projection().blocks.find((value) => value.id === block("big", 0, 1000).id)?.kind).toBe("gold");
	expect(stateBytesWith(projection(), [])).toBeLessThanOrEqual(ROOM_APPLICATION_STATE_BYTES);
}, 600_000);

// A batch of new moves (moves issued together are drained as one applicationBatch vertex) whose last
// moves would pass the limit: like the existing split-required path, the moves that fit are admitted
// and only the crossing ones get the typed refusal. Refusing the whole batch would refuse moves the
// state has room for.
it("a batch of new moves crossing the limit admits the moves that fit; only the crossing ones are refused typed", async () => {
	const { creator, projection, roll } = await creatorRoom();
	const LIMIT = ROOM_APPLICATION_STATE_BYTES;
	// Fill below the limit with exact headroom for some but not all of the batch: big blocks while the
	// state with the next one stays under LIMIT - 1,600, then medium ones while it stays under LIMIT - 300.
	let placed = 0;
	for (const [prefix, idBytes, margin] of [["big", 1000, 1600], ["mid", 100, 300]] as const) {
		for (let count = 0; stateBytesWith(projection(), [block(prefix, placed, idBytes)]) <= LIMIT - margin; count++) {
			await creator.room.issue(block(prefix, placed, idBytes));
			placed++;
			if (count % 8 === 7) await roll();
		}
		await roll();
	}
	const batch = Array.from({ length: 16 }, (_, index) => block("tiny", placed + index, 20));
	// The moves that fit, in order: the longest prefix whose state stays within the limit.
	let fits = 0;
	while (fits < batch.length && stateBytesWith(projection(), batch.slice(0, fits + 1)) <= LIMIT) fits++;
	const headroom = LIMIT - stateBytesWith(projection(), []);
	expect(fits, `some but not all of the batch fit (headroom ${headroom} B)`).toBeGreaterThan(0);
	expect(fits).toBeLessThan(batch.length);
	// Issued together, in one turn: the room drains them as one batch.
	const results = await Promise.allSettled(batch.map((operation) => creator.room.issue(operation)));
	const outcome = results.map((result) => (result.status === "fulfilled" ? "admitted" : refusalOf(result.reason)));
	console.log(`STATE_LIMIT_BATCH ${JSON.stringify({ placed, headroom, fits, outcome })}`);
	expect(outcome.slice(0, fits), "every move that fits is admitted").toEqual(Array(fits).fill("admitted"));
	expect(outcome.slice(fits), "each crossing move is refused typed").toEqual(Array(batch.length - fits).fill(TYPED));
	const ids = new Set(projection().blocks.map((value) => value.id));
	expect(batch.map((operation) => ids.has(operation.id))).toEqual(batch.map((_, index) => index < fits));
	expect(stateBytesWith(projection(), [])).toBeLessThanOrEqual(LIMIT);
	await roll();
}, 600_000);
