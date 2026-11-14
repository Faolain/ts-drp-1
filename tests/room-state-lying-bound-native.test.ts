import { afterEach, expect, it } from "vitest";

import { closeFixtures } from "./fixtures/track-m/room-retention-fixture.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// The bound path's guard (room state limit): the room's admission trusts the application's own state
// bound (readOrdinaryApplicationResourceBound) to dominate every reachable state. If an application's
// bound is wrong, the exact fold eventually passes the room's limit although the bound admitted every
// move. That must surface as a typed internal error naming the application's bound
// (APPLICATION_STATE_BOUND_UNSOUND), at the creator's close preview or its seal, never a silent stall.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const explain = (error: unknown): string => (error instanceof Error ? error.message : String(error));

it("a lying application bound surfaces as APPLICATION_STATE_BOUND_UNSOUND, not a stall", async () => {
	const fixture = await readinessHoldRoom({
		writers: 0,
		wrapApplication: (zone) => {
			const reader = zone.readOrdinaryApplicationResourceBound;
			if (reader === undefined) throw new TypeError("the zone ships a resource bound reader");
			const lie = Object.freeze({ byteLength: 64, items: 1, maxDepth: 1 });
			const lying = Object.assign((input: Parameters<typeof reader>[0]) => reader(input), {
				createIncrementalProjection: (input: never) =>
					reader.createIncrementalProjection?.(input) === undefined
						? undefined
						: Object.freeze({
								advance: (operations: readonly unknown[]) => Array.isArray(operations),
								quote: () => lie,
								quoteWithoutApplicationCandidate: () => lie,
							}),
			});
			return { ...zone, readOrdinaryApplicationResourceBound: lying as typeof reader };
		},
	});
	const creator = await fixture.open(0);
	const errors: string[] = [];
	for (let epoch = 0; epoch < 6 && errors.length === 0; epoch++) {
		for (let index = 0; index < 8 && errors.length === 0; index++) {
			const ordinal = epoch * 8 + index;
			try {
				await creator.room.issue({ action: "placeBlock", id: `${ordinal}-${"b".repeat(1000)}`, kind: "stone", x: ordinal % 16, y: epoch });
			} catch (error) {
				errors.push(`issue ${ordinal}: ${explain(error)}`);
			}
		}
		if (errors.length !== 0) break;
		try {
			const sealed = await creator.room.sealEpoch();
			if ((sealed as { ok?: boolean }).ok !== true) errors.push(`seal ${epoch}: ${JSON.stringify(sealed)}`);
			else await creator.room.adoptCreatorSuccessor();
		} catch (error) {
			errors.push(`seal ${epoch}: ${explain(error)}`);
		}
	}
	console.log(`LYING_BOUND ${JSON.stringify(errors)}`);
	expect(errors.length, "the wrong bound surfaces").toBeGreaterThan(0);
	expect(errors.join("\n")).toMatch(/APPLICATION_STATE_BOUND_UNSOUND/u);
}, 600_000);
