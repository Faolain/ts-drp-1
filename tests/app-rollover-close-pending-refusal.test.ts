/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";

// fix/creator-close-crash makes the room retry an interrupted creator close by itself; until that
// retry lands, a new operation is refused with "v3 room new operation is not authorized:
// not-active: close-pending: ..." (v3-room's isV3RoomClosePendingRefusal). The policy waits for
// the room's own retry (its epoch advancing, within the closing bound) and offers the move again.
// It never seals for it and never counts it as a capacity offer.

const closePending = () =>
	new TypeError("v3 room new operation is not authorized: not-active: close-pending: the interrupted close is retried");
const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

/**
 * A creator's room whose moves are refused as close-pending while `pending()` holds; the test
 * advances the epoch to stand in for the room's own retried close.
 */
function creatorRoom() {
	let epoch = 3;
	let pending = true;
	const calls = { issue: 0, seal: 0, adopt: 0, export: 0 };
	const admitted: unknown[] = [];
	const room = {
		authority: () =>
			({ epoch }) as unknown as ReturnType<
				NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]
			>,
		issue: (operation: Readonly<Record<string, unknown>>) => {
			calls.issue++;
			if (pending) return Promise.reject(closePending());
			admitted.push(operation);
			return Promise.resolve();
		},
		sealEpoch: () => {
			calls.seal++;
			return Promise.reject(new Error("the policy must not seal for a close-pending refusal"));
		},
		adoptCreatorSuccessor: () => {
			calls.adopt++;
			return Promise.reject(new Error("the policy must not adopt for a close-pending refusal"));
		},
		exportCreatorSuccessor: () => {
			calls.export++;
			return Promise.reject(new Error("the policy must not export for a close-pending refusal"));
		},
	};
	return {
		room,
		calls,
		admitted,
		retried: () => {
			epoch++;
			pending = false;
		},
		/** The room's retry lands, but the next close is interrupted again. */
		retriedAndPendingAgain: () => {
			epoch++;
		},
	};
}

const create = (closingLimitMs?: number) => {
	const policy = rollover.createV3RoomRolloverPolicy({
		role: "creator",
		budget: { movesPerAuthor: 1_000, idleMs: 600_000 },
		...(closingLimitMs === undefined ? {} : { closingLimitMs }),
	});
	policies.add(policy);
	return policy;
};

it("a close-pending move waits for the room's own retry and is offered again, with no seal", async () => {
	const fixture = creatorRoom();
	const policy = create();
	policy.bind(fixture.room);
	const move = { action: "paint", id: "pending-1" };
	const issued = policy.issue(move);
	// The policy waits for the epoch to advance; it does not keep reissuing into the pending close.
	await new Promise((resolve) => setTimeout(resolve, 1_200));
	expect(fixture.calls.issue).toBe(1);
	expect(fixture.admitted).toEqual([]);
	fixture.retried();
	await expect(issued).resolves.toBeUndefined();
	expect(fixture.admitted).toEqual([move]);
	expect(fixture.calls).toMatchObject({ issue: 2, seal: 0, adopt: 0, export: 0 });
	expect(policy.stats().rollovers).toBe(0);
});

it("close-pending refusals are not capacity offers: more of them than the offer limit still admit the move", async () => {
	const fixture = creatorRoom();
	const policy = create();
	policy.bind(fixture.room);
	const move = { action: "paint", id: "pending-many" };
	const issued = policy.issue(move);
	// Eight interrupted closes in a row (the policy offers a move at most six times for capacity).
	for (let retry = 0; retry < 8; retry++) {
		await expect.poll(() => fixture.calls.issue, { timeout: 5_000 }).toBe(retry + 1);
		fixture.retriedAndPendingAgain();
	}
	await expect.poll(() => fixture.calls.issue, { timeout: 5_000 }).toBe(9);
	fixture.retried();
	await expect(issued).resolves.toBeUndefined();
	expect(fixture.admitted).toEqual([move]);
	expect(fixture.calls).toMatchObject({ seal: 0, adopt: 0, export: 0 });
});

it("a close the room never retries ends the wait at the closing bound and the page gets the refusal", async () => {
	const fixture = creatorRoom();
	const policy = create(800);
	policy.bind(fixture.room);
	const started = performance.now();
	await expect(policy.issue({ action: "paint", id: "pending-forever" })).rejects.toThrow(/: close-pending: /u);
	expect(performance.now() - started).toBeGreaterThanOrEqual(700);
	expect(fixture.calls).toMatchObject({ issue: 1, seal: 0, adopt: 0, export: 0 });
});
