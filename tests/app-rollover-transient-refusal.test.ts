/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";

// A transient refusal ("retry after admitted work joins": the room's input task queue, 32 jobs, is
// full) clears once admitted work joins, which during an install or adoption takes seconds. The policy
// gave up after 6 offers (50 ms x k, about 750 ms) and surfaced the refusal: the move was dropped
// while the room was healthy (5-Writer image run, bx_6ytwadfw). A transient refusal must never end in
// a dropped move: the policy retries with backoff bounded by time (the closing bound), then keeps the
// move and offers it again. Its own re-offers go one at a time, so they never fill the queue at once.

const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const busy = () =>
	new TypeError(
		"v3 room issue failed: admission-rejected: v3 input task capacity exhausted; retry after admitted work joins"
	);

/**
 * A room double whose issue is refused as transient while `busyUntil` is in the future.
 * @param options - Timing of the double.
 * @param options.busyMs - How long from now every issue is refused as transient.
 * @param options.issueMs - How long an accepted issue takes.
 * @returns The room and its record of offers.
 */
function busyRoom(options: { busyMs: number; issueMs?: number }) {
	const state = { epoch: 3, busyUntil: performance.now() + options.busyMs, inFlight: 0, maxInFlight: 0 };
	const offers: { id: unknown; at: number; outcome: "accepted" | "busy" }[] = [];
	const room = {
		authority: () =>
			({ epoch: state.epoch }) as unknown as ReturnType<
				NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]
			>,
		issue: async (operation: Readonly<Record<string, unknown>>) => {
			state.inFlight++;
			state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
			try {
				if (performance.now() < state.busyUntil) {
					offers.push({ id: operation.id, at: performance.now(), outcome: "busy" });
					throw busy();
				}
				await sleep(options.issueMs ?? 0);
				offers.push({ id: operation.id, at: performance.now(), outcome: "accepted" });
			} finally {
				state.inFlight--;
			}
		},
		settlementStatus: () => ({ epoch: state.epoch, unsettledEpochs: 0, window: 4, undelivered: [], deferred: 0 }),
		sealEpoch: () => Promise.reject(new Error("members never seal")),
		adoptCreatorSuccessor: () => Promise.reject(new Error("members never adopt")),
		exportCreatorSuccessor: () => Promise.reject(new Error("members never export")),
	};
	return { room, state, offers };
}

function memberPolicy(closingLimitMs?: number) {
	const errors: unknown[] = [];
	const policy = (
		rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy
	)({
		role: "member",
		budget: { movesPerAuthor: 7, idleMs: 10_000 },
		...(closingLimitMs === undefined ? {} : { closingLimitMs }),
		hooks: { onError: (error: unknown) => errors.push(error) },
	});
	policies.add(policy);
	return { policy, errors };
}

it("a move refused as transient for longer than six quick offers is offered until the room admits it", async () => {
	const { room, offers } = busyRoom({ busyMs: 3_000 });
	const { policy, errors } = memberPolicy();
	policy.bind(room);
	await expect(policy.issue({ action: "move", id: "m-0" })).resolves.toBeUndefined();
	expect(offers.filter((offer) => offer.outcome === "accepted").map((offer) => offer.id)).toEqual(["m-0"]);
	expect(errors).toEqual([]);
}, 30_000);

it("a move refused as transient past the time bound is kept and offered again, never dropped", async () => {
	const { room, state, offers } = busyRoom({ busyMs: 60_000 });
	const { policy } = memberPolicy(1_500);
	policy.bind(room);
	const refused = await policy.issue({ action: "move", id: "m-0" }).then(
		() => undefined,
		(error: unknown) => error
	);
	expect(refused, "kept, with a typed refusal").toBeInstanceOf(rollover.V3RoomBusy);
	expect(policy.status().kept.map((operation) => operation.id)).toEqual(["m-0"]);
	// The room recovers in the same epoch: the kept move is offered again and admitted once.
	state.busyUntil = performance.now();
	const by = performance.now() + 10_000;
	while (!offers.some((offer) => offer.outcome === "accepted") && performance.now() < by) await sleep(50);
	expect(offers.filter((offer) => offer.outcome === "accepted").map((offer) => offer.id)).toEqual(["m-0"]);
	expect(policy.status().kept).toEqual([]);
}, 30_000);

it("kept moves are offered again one at a time, never filling the room's input queue at once", async () => {
	const { room, state, offers } = busyRoom({ busyMs: 60_000, issueMs: 400 });
	const { policy } = memberPolicy(500);
	policy.bind(room);
	for (let k = 0; k < 6; k++)
		await expect(policy.issue({ action: "move", id: `m-${k}` })).rejects.toBeInstanceOf(rollover.V3RoomBusy);
	expect(policy.status().kept).toHaveLength(6);
	state.maxInFlight = 0;
	state.busyUntil = performance.now();
	const by = performance.now() + 15_000;
	while (offers.filter((offer) => offer.outcome === "accepted").length < 6 && performance.now() < by) await sleep(50);
	expect(offers.filter((offer) => offer.outcome === "accepted").map((offer) => offer.id)).toEqual([
		"m-0",
		"m-1",
		"m-2",
		"m-3",
		"m-4",
		"m-5",
	]);
	expect(state.maxInFlight, "re-offers in flight at once").toBe(1);
}, 30_000);
