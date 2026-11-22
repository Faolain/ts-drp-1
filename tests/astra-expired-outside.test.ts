import { afterEach, expect, it } from "vitest";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import {
	openOutsideRowsRoom,
	play,
	seal,
	install,
	deliver,
	protectedEpochs,
} from "./fixtures/astra/outside-rows-room.js";

afterEach(async () => {
	expect(await closeFixtures()).toEqual([]);
}, 300_000);

// Same authenticated Grid application, with the public immutable local policy selecting expire.
// Exactly one expired outside move per epoch; all install fences delivered before the next seal.
// No missing replacement or missed fence: expiry deliberately creates no replacement.
it.each(["rebase", "expire"] as const)(
	"a %s-policy Writer remains live and bounded through seals",
	async (policy) => {
		const room = await openOutsideRowsRoom(1, policy);
		const history: unknown[] = [];
		for (let epoch = 0; epoch < 12; epoch++) {
			await play(room, `ordinary-${epoch}`);
			await seal(room, epoch, [1]);
			await required(room.peers[0]).room.adoptCreatorSuccessor();
			const result = await install(room, 1);
			const protectedScopes = await protectedEpochs(room, 1);
			const row = { epoch: epoch + 1, result, protectedScopes };
			history.push(row);
			console.log("ASTRA_OUTSIDE", policy, JSON.stringify(row));
			expect(result, JSON.stringify(history)).toBe("ok");
			await deliver(room, 1);
			expect(protectedScopes.length, JSON.stringify(history)).toBeLessThanOrEqual(4);
		}
	},
	900_000
);
