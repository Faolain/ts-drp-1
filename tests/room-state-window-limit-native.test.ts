import { afterEach, expect, it } from "vitest";

import { closeFixtures } from "./fixtures/track-m/room-retention-fixture.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { ROOM_APPLICATION_STATE_BYTES } from "../packages/node/src/v3-live.js";

// A host-local ordinary finishing window that declares more application bytes than the room's
// application state limit can never describe a state the room holds (admission refuses any fold past
// the limit), and the creator's window capture declines it ("window-application-or-native-domain").
// Before the fix such a room opened and then refused EVERY ordinary creator move ("creator ordinary
// finishing window requires explicit boundary maintenance before admission"): a room that opens and
// can never move. Wanted: the room refuses that window when it binds the creator's close (typed,
// CREATOR_ORDINARY_FINISHING_WINDOW_INVALID), and a window at the limit opens and moves.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const window = (maxApplicationBytes: number) =>
	Object.freeze({
		maxAdditionalLocalRows: 2048,
		maxAdditionalReceivedRows: 2048,
		maxAdditionalActions: 4096,
		maxAdditionalOperationBytes: 2_097_152,
		maxAdditionalPreimageBytes: 4_194_304,
		maxAdditionalEpochVertexBytes: 4_194_304,
		maxCanonicalOperationByteLength: 4096,
		maxCanonicalPreimageByteLength: 8192,
		maxCanonicalEpochVertexByteLength: 8192,
		maxSuccessorFencePreimageByteLength: 8192,
		maxReceivedPendingIngressByteLength: 8192,
		maxApplicationBytes,
		maxApplicationItems: 4096,
		maxApplicationDepth: 8,
	});

const explain = (error: unknown): string[] => {
	const parts: string[] = [];
	for (let value: unknown = error; value instanceof Error && parts.length < 6; value = value.cause) parts.push(value.message);
	return parts;
};

it("a finishing window past the room's state limit is refused when the creator binds, not by refusing every move", async () => {
	const fixture = await readinessHoldRoom({ window: window(ROOM_APPLICATION_STATE_BYTES + 1) });
	let opened: unknown;
	let refused: string[] = [];
	try {
		opened = await fixture.open(0);
	} catch (error) {
		refused = explain(error);
	}
	let moved: string[] | undefined;
	if (opened !== undefined) {
		try {
			await (opened as { room: { issue(operation: unknown): Promise<void> } }).room.issue({
				action: "placeBlock",
				id: "first",
				kind: "stone",
				x: 1,
				y: 1,
			});
			moved = [];
		} catch (error) {
			moved = explain(error);
		}
	}
	console.log(`ROOM_STATE_WINDOW_LIMIT ${JSON.stringify({ refused, moved })}`);
	expect(opened, "the room refuses the window when it binds").toBeUndefined();
	expect(refused.join(" | ")).toContain("CREATOR_ORDINARY_FINISHING_WINDOW_INVALID");
}, 240_000);

it("a finishing window at the room's state limit opens and moves", async () => {
	const fixture = await readinessHoldRoom({ window: window(ROOM_APPLICATION_STATE_BYTES) });
	const creator = await fixture.open(0);
	await creator.room.issue({ action: "placeBlock", id: "first", kind: "stone", x: 1, y: 1 });
	expect((creator.room.projection() as { blocks: readonly { id: string }[] }).blocks.map((block) => block.id)).toEqual([
		"first",
	]);
}, 240_000);
