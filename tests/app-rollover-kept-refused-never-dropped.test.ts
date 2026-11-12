/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";

// A new move the policy kept (here: refused at the room's undelivered-move bound) is offered again once
// the room installs a later epoch. If that re-offer fails with an error outside the kinds the policy
// keeps (not reaching host, busy, successor unavailable, read-only), the move must not be dropped: it is
// kept and offered again in a later epoch, as a given-back move is, and the failure reaches onError with
// the move attached.

const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function refusingRoom() {
	let epoch = 3;
	const offers: unknown[] = [];
	const room = {
		authority: () =>
			({ epoch }) as unknown as ReturnType<
				NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]
			>,
		issue: (operation: Readonly<Record<string, unknown>>) => {
			offers.push(operation);
			if (offers.length === 1) {
				const full = new Error("the member's undelivered moves fill the backlog");
				full.name = "V3RoomLocalBacklogFull";
				return Promise.reject(full);
			}
			if (offers.length === 2) return Promise.reject(new TypeError("v3 room issue failed: malformed-input: one-off"));
			return Promise.resolve();
		},
		settlementStatus: () => ({ epoch, unsettledEpochs: 0, window: 4, undelivered: [] }),
		sealEpoch: () => Promise.reject(new Error("members never seal")),
		adoptCreatorSuccessor: () => Promise.reject(new Error("members never adopt")),
		exportCreatorSuccessor: () => Promise.reject(new Error("members never export")),
	};
	return { room, offers, install: (next: number) => (epoch = next) };
}

it("a kept move whose re-offer fails with an unkept refusal is kept and offered again, never dropped", async () => {
	const { room, offers, install } = refusingRoom();
	const errors: unknown[] = [];
	const policy = (
		rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy
	)({
		role: "member",
		budget: { movesPerAuthor: 7, idleMs: 10_000 },
		hooks: { onError: (error: unknown) => errors.push(error) },
	});
	policies.add(policy);
	policy.bind(room);
	const move = { kind: "paint", id: "kept-1" };
	await expect(policy.issue(move)).rejects.toBeInstanceOf(rollover.V3RoomNotReachingHost);
	expect(policy.status().kept).toEqual([move]);
	// Past the refusing epoch: offered again, and refused with an error the policy does not keep for.
	install(4);
	const secondBy = performance.now() + 5_000;
	while (offers.length < 2 && performance.now() < secondBy) await sleep(50);
	expect(offers.length, "the re-offer").toBe(2);
	await sleep(200);
	expect(policy.status().kept, "the refused move is still kept").toEqual([move]);
	const reported = errors.find((error) => error instanceof rollover.V3RoomKeptMoveRefused) as
		| rollover.V3RoomKeptMoveRefused
		| undefined;
	expect(reported?.operation, "the failure reaches onError with the move").toBe(move);
	expect(String((reported?.cause as Error | undefined)?.message)).toMatch(/one-off/u);
	// A later epoch: offered once more, and admitted.
	install(5);
	const thirdBy = performance.now() + 5_000;
	while (offers.length < 3 && performance.now() < thirdBy) await sleep(50);
	expect(offers).toEqual([move, move, move]);
	await sleep(200);
	expect(policy.status().kept).toEqual([]);
}, 60_000);
