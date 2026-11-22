import { afterEach, expect, it } from "vitest";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import {
	openOutsideRowsRoom,
	play,
	seal,
	install,
	deliver,
	protectedEpochs,
	blockIds,
} from "./fixtures/astra/outside-rows-room.js";
afterEach(async () => {
	expect(await closeFixtures()).toEqual([]);
}, 300_000);
// A network peer may miss a member of a signed cut and install its snapshot instead.
// Every Writer move and fence is delivered; there are NO outside moves in this schedule.
it.each([false, true])(
	"a Writer missing cut members stays bounded (complete old delivery before install: %s)",
	async (completeBeforeInstall) => {
		const room = await openOutsideRowsRoom();
		const creator = required(room.peers[0]);
		const writer = required(room.peers[1]);
		const history: unknown[] = [];
		for (let epoch = 0; epoch < 12; epoch++) {
			await play(room, `delivered-${epoch}`);
			await creator.room.issue({ action: "placeBlock", id: `withheld-${epoch}`, kind: "stone", x: 3, y: epoch });
			const withheld = await room.fixture.publishedAfter(0, room.delivered[0] ?? null);
			expect(withheld.length).toBeGreaterThan(0);
			room.delivered[0] = required(withheld.at(-1)).commit.authorSequence;
			expect(blockIds(writer)).not.toContain(`withheld-${epoch}`);
			await seal(room, epoch);
			await creator.room.adoptCreatorSuccessor();
			if (completeBeforeInstall) await writer.receive(withheld, 0);
			const result = await install(room, 1);
			const protectedScopes = await protectedEpochs(room, 1);
			history.push({ epoch: epoch + 1, result, protectedScopes });
			console.log("ASTRA_PARTIAL_CUT", completeBeforeInstall, JSON.stringify(history.at(-1)));
			expect(result, JSON.stringify(history)).toBe("ok");
			expect(writer.room.projection()).toEqual(creator.room.projection());
			await deliver(room, 1);
		}
		expect((await protectedEpochs(room, 1)).length).toBeLessThanOrEqual(4);
	},
	900_000
);
