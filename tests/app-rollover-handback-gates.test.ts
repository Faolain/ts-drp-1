/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";

// A member's kept moves are of two kinds. A given-back move (settlementStatus().undelivered) carries
// its hand-back record: the room never refuses it at the undelivered-move bound, and the record bound
// (64) limits how many can recirculate. A new move counts against that bound. The policy offers
// given-back moves whatever its not-reaching-host gate says (both halves: a backlog refusal of a new
// move, and the member's settlement lag), first in each batch; new moves keep both gates, and a new
// move refused at the bound stops the batch's other new moves (they are kept, not offered). Found in
// the 100x16 catch-up trace (.logs/realtime-resume-2026-11-10/landing/trace): every install offered
// about 24 kept new moves into a full backlog, each refusal closed the gate for the rest of the epoch,
// and the given-back moves waited behind them.

const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const backlogFull = () =>
	Object.assign(new Error("v3 room local backlog is full: 64 of 64"), { name: "V3RoomLocalBacklogFull" });

type Offer = { id: unknown; handBack: boolean; epoch: number; outcome: "accepted" | "refused" | "failed" };

/**
 * A member's room double: `records` given-back moves listed until a re-offer with the record is
 * accepted; new moves refused at the backlog bound while `full` is true.
 * @param options - The listing and the room's answers.
 * @param options.records - The given-back moves listed at the start.
 * @param options.unsettledEpochs - The member's settlement lag the room reports.
 * @param options.handBackFails - Every given-back re-offer fails with a refusal the policy does not keep.
 * @returns The room and its controls.
 */
function memberRoom(options: { records: number; unsettledEpochs?: number; handBackFails?: boolean }) {
	const state = { epoch: 3, full: true, unsettledEpochs: options.unsettledEpochs ?? 0 };
	const listed = new Map<
		string,
		{ handBack: { sourceSequence: number; intent: number }; operations: Record<string, unknown>[] }
	>();
	for (let k = 0; k < options.records; k++)
		listed.set(`${10 + k}:0`, {
			handBack: { sourceSequence: 10 + k, intent: 0 },
			operations: [{ action: "move", id: `given-${k}` }],
		});
	const offers: Offer[] = [];
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
			const offer: Offer = {
				id: operation.id,
				handBack: handBack !== undefined,
				epoch: state.epoch,
				outcome: "accepted",
			};
			offers.push(offer);
			if (handBack === undefined) {
				if (!state.full) return Promise.resolve();
				offer.outcome = "refused";
				return Promise.reject(backlogFull());
			}
			if (options.handBackFails === true) {
				offer.outcome = "failed";
				return Promise.reject(new TypeError("v3 room issue failed: malformed-input: test refusal"));
			}
			listed.delete(`${handBack.sourceSequence}:${handBack.intent}`);
			return Promise.resolve();
		},
		settlementStatus: () => ({
			epoch: state.epoch,
			unsettledEpochs: state.unsettledEpochs,
			window: 4,
			undelivered: [...listed.values()],
			deferred: 0,
		}),
		sealEpoch: () => Promise.reject(new Error("members never seal")),
		adoptCreatorSuccessor: () => Promise.reject(new Error("members never adopt")),
		exportCreatorSuccessor: () => Promise.reject(new Error("members never export")),
	};
	return { room, state, offers, listed };
}

function memberPolicy() {
	const errors: unknown[] = [];
	const policy = (
		rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy
	)({
		role: "member",
		budget: { movesPerAuthor: 7, idleMs: 10_000 },
		hooks: { onError: (error: unknown) => errors.push(error) },
	});
	policies.add(policy);
	return { policy, errors };
}

async function until(done: () => boolean, ms: number) {
	const by = performance.now() + ms;
	while (!done() && performance.now() < by) await sleep(50);
}

// The backlog half: a new move refused at the bound in this epoch closes the gate for new moves only.
it("given-back moves are offered in an epoch whose new move the room refused at the backlog bound", async () => {
	const { room, state, offers } = memberRoom({ records: 2 });
	const { policy } = memberPolicy();
	policy.bind(room);
	// Listed and kept at epoch 3 (the settlement poll runs every second).
	await sleep(1_500);
	state.epoch = 4;
	// In epoch 4, before the kept moves' poll: the application's new move is refused at the bound.
	await expect(policy.issue({ action: "move", id: "new-0" })).rejects.toBeInstanceOf(rollover.V3RoomNotReachingHost);
	expect(policy.status().state).toBe("not-reaching-host");
	await until(() => offers.filter((offer) => offer.handBack).length >= 2, 5_000);
	const inFour = offers.filter((offer) => offer.epoch === 4);
	expect(
		inFour.filter((offer) => offer.handBack).map((offer) => offer.id),
		"given-back moves offered in epoch 4"
	).toEqual(["given-0", "given-1"]);
	expect(
		inFour.filter((offer) => !offer.handBack).map((offer) => offer.id),
		"new moves offered in epoch 4 (only the application's own)"
	).toEqual(["new-0"]);
}, 30_000);

// The settlement-lag half: the member's lag holds new moves, never given-back moves.
it("given-back moves are offered while the member's settlement lag holds its new moves", async () => {
	const { room, state, offers } = memberRoom({ records: 2 });
	const { policy } = memberPolicy();
	policy.bind(room);
	// A new move refused at epoch 3 is kept with the given-back moves.
	await expect(policy.issue({ action: "move", id: "new-0" })).rejects.toBeInstanceOf(rollover.V3RoomNotReachingHost);
	await sleep(1_500);
	// Epoch 4, the backlog has room again, but the member lags its window (2 >= 4 - margin 2).
	state.epoch = 4;
	state.full = false;
	state.unsettledEpochs = 2;
	await until(() => offers.filter((offer) => offer.handBack).length >= 2, 5_000);
	await sleep(1_500);
	expect(policy.status().state).toBe("not-reaching-host");
	expect(
		offers.filter((offer) => offer.epoch === 4).map((offer) => offer.id),
		"epoch 4 offers: the given-back moves only"
	).toEqual(["given-0", "given-1"]);
	// The lag clears: the new move is offered.
	state.unsettledEpochs = 0;
	await until(() => offers.some((offer) => offer.id === "new-0" && offer.epoch === 4), 5_000);
	expect(offers.filter((offer) => offer.id === "new-0").map((offer) => offer.outcome)).toEqual(["refused", "accepted"]);
}, 30_000);

// The batch: given-back moves first; the first new move refused at the bound stops the other new moves.
it("a batch offers given-back moves first and stops its new moves at the first backlog refusal", async () => {
	const { room, state, offers, listed } = memberRoom({ records: 0 });
	const { policy } = memberPolicy();
	policy.bind(room);
	// Three new moves refused (and kept) at epoch 3, then the window gives two moves back.
	for (const id of ["new-0", "new-1", "new-2"])
		await expect(policy.issue({ action: "move", id })).rejects.toBeInstanceOf(rollover.V3RoomNotReachingHost);
	for (let k = 0; k < 2; k++)
		listed.set(`${10 + k}:0`, {
			handBack: { sourceSequence: 10 + k, intent: 0 },
			operations: [{ action: "move", id: `given-${k}` }],
		});
	await sleep(1_500);
	const before = offers.length;
	state.epoch = 4;
	await until(() => offers.length >= before + 3, 5_000);
	await sleep(1_500);
	expect(
		offers.slice(before).map((offer) => `${offer.id}:${offer.outcome}`),
		"epoch 4: given-back first, then new moves up to the first refusal"
	).toEqual(["given-0:accepted", "given-1:accepted", "new-0:refused"]);
	// Epoch 5 with room in the backlog: the new moves land in their order.
	const atFive = offers.length;
	state.epoch = 5;
	state.full = false;
	await until(() => offers.length >= atFive + 3, 5_000);
	expect(offers.slice(atFive).map((offer) => `${offer.id}:${offer.outcome}`)).toEqual([
		"new-0:accepted",
		"new-1:accepted",
		"new-2:accepted",
	]);
	expect(policy.status().kept).toEqual([]);
}, 30_000);

// The record bound still holds: a full set of records whose re-offers never succeed is offered once per
// record per epoch, never more, and never lets a new move past the backlog bound.
it("given-back moves stay within the record bound: one offer per listed record per epoch", async () => {
	const records = 64;
	const { room, state, offers } = memberRoom({ records, handBackFails: true });
	const { policy } = memberPolicy();
	policy.bind(room);
	await expect(policy.issue({ action: "move", id: "new-0" })).rejects.toBeInstanceOf(rollover.V3RoomNotReachingHost);
	await sleep(1_500);
	for (const epoch of [4, 5, 6]) {
		state.epoch = epoch;
		await until(() => offers.filter((offer) => offer.epoch === epoch && offer.handBack).length >= records, 5_000);
		await sleep(2_500);
	}
	for (const epoch of [4, 5, 6]) {
		const given = offers.filter((offer) => offer.epoch === epoch && offer.handBack);
		expect(given.length, `given-back offers in epoch ${epoch}`).toBe(records);
		expect(new Set(given.map((offer) => offer.id)).size, `distinct given-back moves in epoch ${epoch}`).toBe(records);
		// The new move is offered at most once per epoch and is refused: the bound holds.
		const fresh = offers.filter((offer) => offer.epoch === epoch && !offer.handBack);
		expect(fresh.length, `new-move offers in epoch ${epoch}`).toBeLessThanOrEqual(1);
		expect(fresh.every((offer) => offer.outcome === "refused")).toBe(true);
	}
}, 60_000);
