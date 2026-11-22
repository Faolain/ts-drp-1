/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";

// A member that falls behind keeps its refused moves and the moves its settlement window gave back, and
// offers them again once the room installs a later epoch. The creator seals an epoch as soon as one
// author's accepted moves reach the budget (movesPerAuthor). A member that re-offers more kept moves in
// one epoch than the budget leaves forces that seal mid-burst: every move it issues after the budget is
// reached targets an epoch the creator is closing, and is displaced and replaced at the next install
// (one native dependency turn each). Found in the 100x16 catch-up livelock
// (.logs/realtime-resume-2026-11-10/livelock): the kept burst's late rows missed the seal, their
// replacement outlasted the next epoch, and the skip install handed them back to be offered again as a
// burst. The member paces only its own kept re-offers to what the epoch's budget leaves; its new moves,
// the creator, and every other member are never paced.

const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(done: () => boolean, ms: number) {
	const by = performance.now() + ms;
	while (!done() && performance.now() < by) await sleep(50);
}

type Offer = { id: unknown; handBack: boolean; epoch: number };

/**
 * A member's room double that accepts every move: `records` given-back moves listed until a re-offer
 * with the record is accepted; accepted moves are reported to `accepted` (the page's onAcceptedVertex).
 * @param records - The given-back moves listed at the start.
 * @returns The room and its controls.
 */
function memberRoom(records: number) {
	const state = { epoch: 3 };
	const listed = new Map<
		string,
		{ handBack: { sourceSequence: number; intent: number }; operations: Record<string, unknown>[] }
	>();
	for (let k = 0; k < records; k++)
		listed.set(`${10 + k}:0`, {
			handBack: { sourceSequence: 10 + k, intent: 0 },
			operations: [{ action: "move", id: `given-${k}` }],
		});
	const offers: Offer[] = [];
	const accepted: { author: string; epoch: number }[] = [];
	const room = {
		authority: () =>
			({ epoch: state.epoch }) as unknown as ReturnType<
				NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]
			>,
		issue: (
			operation: Readonly<Record<string, unknown>>,
			issueOptions?: { handBack?: { sourceSequence: number; intent: number } }
		) => {
			const handBack = issueOptions?.handBack;
			offers.push({ id: operation.id, handBack: handBack !== undefined, epoch: state.epoch });
			if (handBack !== undefined) listed.delete(`${handBack.sourceSequence}:${handBack.intent}`);
			accepted.push({ author: "member", epoch: state.epoch });
			return Promise.resolve();
		},
		settlementStatus: () => ({
			epoch: state.epoch,
			unsettledEpochs: 0,
			window: 4,
			undelivered: [...listed.values()],
			deferred: 0,
		}),
		sealEpoch: () => Promise.reject(new Error("members never seal")),
		adoptCreatorSuccessor: () => Promise.reject(new Error("members never adopt")),
		exportCreatorSuccessor: () => Promise.reject(new Error("members never export")),
	};
	return { room, state, offers, accepted, listed };
}

function memberPolicy(movesPerAuthor: number) {
	const errors: unknown[] = [];
	const policy = (
		rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy
	)({
		role: "member",
		budget: { movesPerAuthor, idleMs: 10_000 },
		hooks: { onError: (error: unknown) => errors.push(error) },
	});
	policies.add(policy);
	return { policy, errors };
}

it("a member re-offers at most what the epoch's budget leaves of its kept moves, and the rest in later epochs", async () => {
	const budget = 4;
	const { room, state, offers } = memberRoom(10);
	const { policy } = memberPolicy(budget);
	policy.bind(room);
	// Listed and kept at epoch 3 (the settlement poll runs every second).
	await sleep(1_500);
	expect(policy.status().kept.length).toBe(10);
	for (const epoch of [4, 5, 6]) {
		state.epoch = epoch;
		await until(() => offers.filter((offer) => offer.epoch === epoch).length >= budget, 5_000);
		// Time for an unpaced batch to offer every kept move in this epoch.
		await sleep(1_500);
	}
	const perEpoch = [4, 5, 6].map((epoch) => offers.filter((offer) => offer.epoch === epoch).length);
	expect(perEpoch, "kept re-offers per epoch").toEqual([4, 4, 2]);
	expect(offers.map((offer) => offer.id)).toEqual(Array.from({ length: 10 }, (_, k) => `given-${k}`));
	expect(policy.status().kept).toEqual([]);
}, 30_000);

it("the epoch's budget counts the member's own accepted moves, and stops at any author's observed budget", async () => {
	const budget = 4;
	const { room, state, offers } = memberRoom(6);
	const { policy } = memberPolicy(budget);
	policy.bind(room);
	await sleep(1_500);
	state.epoch = 4;
	// Before the kept moves' poll: the application's own new move (never paced) counts toward this
	// member's budget, and another author below the budget does not stop it: three kept re-offers.
	await policy.issue({ action: "move", id: "new-0" });
	for (let k = 0; k < 2; k++) policy.observe({ author: "other", epoch: 4 });
	await sleep(2_000);
	expect(offers.filter((offer) => offer.epoch === 4 && offer.handBack).length, "kept re-offers in epoch 4").toBe(3);
	// Another author at the budget: the creator is sealing this epoch, so no kept move is offered into it.
	state.epoch = 5;
	for (let k = 0; k < budget; k++) policy.observe({ author: "other", epoch: 5 });
	await sleep(2_000);
	expect(offers.filter((offer) => offer.epoch === 5).length, "kept re-offers in epoch 5").toBe(0);
	state.epoch = 6;
	await until(() => policy.status().kept.length === 0, 5_000);
	expect(offers.filter((offer) => offer.epoch === 6).length, "kept re-offers in epoch 6").toBe(3);
	expect(offers.filter((offer) => offer.handBack).map((offer) => offer.id)).toEqual(
		Array.from({ length: 6 }, (_, k) => `given-${k}`)
	);
}, 30_000);

it("a member's new moves are never paced by its kept re-offers", async () => {
	const budget = 2;
	const { room, state, offers } = memberRoom(4);
	const { policy } = memberPolicy(budget);
	policy.bind(room);
	await sleep(1_500);
	state.epoch = 4;
	await until(() => offers.filter((offer) => offer.epoch === 4).length >= budget, 5_000);
	await sleep(1_200);
	// The epoch's budget is spent by kept re-offers; the application's new moves still go out at once.
	for (let k = 0; k < 3; k++) await policy.issue({ action: "move", id: `new-${k}` });
	expect(offers.filter((offer) => offer.epoch === 4 && !offer.handBack).map((offer) => offer.id)).toEqual([
		"new-0",
		"new-1",
		"new-2",
	]);
}, 30_000);
