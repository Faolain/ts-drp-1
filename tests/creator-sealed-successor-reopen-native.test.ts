import { afterEach, expect, it } from "vitest";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { linkSuccessorProtocol } from "./fixtures/track-x/successor-link.js";

afterEach(async () => {
	expect(await closeFixtures()).toEqual([]);
});

it.each([false, true])(
	"a creator reopens its durable sealed successor and continues play (recipient already waiting: %s)",
	async (waiting) => {
		const fixture = await readinessHoldRoom();
		let creator = await fixture.open(0);
		const writer = await fixture.open(1);
		const link = linkSuccessorProtocol(creator, writer, { joinHandlersOnClose: true });
		let creatorSequence: number | null = null,
			writerSequence: number | null = null;
		for (let epoch = 0; epoch < 4; epoch++) {
			await creator.room.issue({ action: "placeBlock", id: `creator-${epoch}`, kind: "stone", x: 1, y: epoch });
			const creatorRows = await fixture.publishedAfter(0, creatorSequence);
			await writer.receive(creatorRows, 0);
			creatorSequence = required(creatorRows.at(-1)).commit.authorSequence;
			await writer.room.issue({ action: "placeBlock", id: `writer-${epoch}`, kind: "gold", x: 2, y: epoch });
			const writerRows = await fixture.publishedAfter(1, writerSequence);
			await creator.receive(writerRows, 1);
			writerSequence = required(writerRows.at(-1)).commit.authorSequence;
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(await creator.room.sealEpoch()).toMatchObject({ ok: true });
			const offer = await creator.room.exportCreatorSuccessor();
			const requests = link.requests.length;
			const pending = waiting
				? writer.room.installCreatorSuccessor({ offer, peers: [creator.networkNode.peerId] })
				: undefined;
			if (pending !== undefined) {
				const deadline = performance.now() + 10000;
				while (link.requests.length === requests && performance.now() < deadline)
					await new Promise((resolve) => setTimeout(resolve, 10));
				expect(link.requests.length).toBeGreaterThan(requests);
			}
			await fixture.stop(creator);
			creator = await fixture.open(0, { reopen: true, onNetwork: link.rebindCreator });
			expect(creator.room.authority()?.epoch).toBe(epoch + 1);
			if (pending !== undefined) await pending;
			else await writer.room.installCreatorSuccessor({ offer, peers: [creator.networkNode.peerId] });
			expect(writer.room.authority()?.epoch).toBe(epoch + 1);
			expect(writer.room.projection()).toEqual(creator.room.projection());
		}
	},
	300000
);
