import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { deliver, install, journalHolds, play, protectedEpochs, seal,
	type OutsideRowsRoom } from "./fixtures/track-x/outside-rows-room.js";

afterEach(async () => expect(await closeFixtures()).toEqual([]));

it("keeps a manual-review source open while installing and collecting unrelated closed scopes", async () => {
	const fixture = await readinessHoldRoom();
	const policies = Object.freeze({ placeBlock: "manual-review" as const });
	const room: OutsideRowsRoom = { fixture,
		peers: [await fixture.open(0), await fixture.open(1, { policies })], delivered: [null, null] };
	const creator = required(room.peers[0]);
	let source: Awaited<ReturnType<typeof fixture.publishedAfter>>[number] | undefined;
	const history: unknown[] = [];
	for (let epoch = 0; epoch < 10; epoch++) {
		await play(room, `manual-${epoch}`, epoch === 0 ? [0, 1] : [0]);
		await seal(room, epoch, epoch === 0 ? [1] : []);
		if (epoch === 0) source = required((await fixture.publishedAfter(1, null)).at(-1));
		await creator.room.adoptCreatorSuccessor();
		const outcome = await install(room, 1);
		const scopes = await protectedEpochs(room, 1);
		history.push({ epoch: epoch + 1, outcome, scopes });
		expect(outcome, JSON.stringify(history)).toBe("ok");
		expect(scopes.length, JSON.stringify(history)).toBeLessThanOrEqual(4);
		expect(await journalHolds(room, 1, required(source).commit.envelope.digest)).toBe(true);
		const issuance = await fixture.host.storageHost.openIssuance("peer-1");
		try {
			const plan = await issuance.readSettlementPlan({ objectId: fixture.objectId,
				author: required(fixture.identities[1]).author });
			expect(plan?.entries).toEqual([expect.objectContaining({
				sourceSequence: required(source).commit.authorSequence, disposition: "manual-review", replacementSequence: null,
			})]);
			expect(plan?.fenceSequence).toBeNull();
		} finally { await issuance.close(); }
		if (epoch === 5) {
			await fixture.stop(required(room.peers[1]));
			room.peers[1] = await fixture.open(1, { reopen: true, policies });
			expect(required(room.peers[1]).room.authority()?.epoch).toBe(6);
		}
		await deliver(room, 1);
	}
}, 900_000);
