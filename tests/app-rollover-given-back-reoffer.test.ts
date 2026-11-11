/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";

// A move the room's settlement window gave back (settlementStatus().undelivered) is kept by the
// member's policy and offered again with its hand-back record. The room lists it until a row offering
// it again consumes the record. If one re-offer fails with an error the policy does not keep the move
// for, the room still lists the move: the policy must offer it again later, not drop it (it marks the
// record as taken, so the listing alone never brings it back).

const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A member's room listing one given-back move until a re-offer carrying its record is admitted. The
 * first re-offer fails with a refusal the policy neither retries nor keeps.
 * @returns The room, its offers, and its install.
 */
function givenBackRoom() {
	let epoch = 3;
	const move = { kind: "paint", id: "given-back-1" };
	const handBack = { sourceSequence: 7, intent: 0 };
	const offers: { operation: unknown; handBack: unknown }[] = [];
	let consumed = false;
	const room = {
		authority: () =>
			({ epoch }) as unknown as ReturnType<
				NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]
			>,
		issue: (operation: Readonly<Record<string, unknown>>, options?: { handBack?: unknown }) => {
			offers.push({ operation, handBack: options?.handBack });
			if (offers.length === 1) return Promise.reject(new TypeError("v3 room issue failed: malformed-input: one-off"));
			consumed = true;
			return Promise.resolve();
		},
		settlementStatus: () => ({
			epoch,
			unsettledEpochs: 0,
			window: 4,
			undelivered: consumed ? [] : [{ handBack, operations: [move] }],
		}),
		sealEpoch: () => Promise.reject(new Error("members never seal")),
		adoptCreatorSuccessor: () => Promise.reject(new Error("members never adopt")),
		exportCreatorSuccessor: () => Promise.reject(new Error("members never export")),
	};
	return { room, move, handBack, offers, install: (next: number) => (epoch = next) };
}

it("a given-back move whose re-offer fails once is offered again while the room still lists it", async () => {
	const { room, move, handBack, offers, install } = givenBackRoom();
	const errors: unknown[] = [];
	const policy = (
		rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy
	)({ role: "member", budget: { movesPerAuthor: 7, idleMs: 10_000 }, hooks: { onError: (error: unknown) => errors.push(error) } });
	policies.add(policy);
	policy.bind(room);
	// Listed and kept at epoch 3; offered once the room is past it.
	await sleep(1_500);
	install(4);
	const firstBy = performance.now() + 5_000;
	while (offers.length === 0 && performance.now() < firstBy) await sleep(50);
	expect(offers, "the first re-offer, with its record").toEqual([{ operation: move, handBack }]);
	// Later epochs: the room still lists the move, so it must be offered again.
	for (let next = 5; next <= 7 && offers.length < 2; next++) {
		install(next);
		const by = performance.now() + 3_000;
		while (offers.length < 2 && performance.now() < by) await sleep(50);
	}
	expect(errors.length, "the failed re-offer was reported").toBeGreaterThanOrEqual(1);
	expect(offers.length, "offers of the still-listed given-back move").toBeGreaterThanOrEqual(2);
	expect(offers[1], "offered again with its record").toEqual({ operation: move, handBack });
}, 60_000);
