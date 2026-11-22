/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";

// Author order across a hand-back. A member places block "b-1" at (1, 0) and then at (2, 0); the room
// accepts both. The first placement's rows never reached the creator inside the settlement window, so
// the room gives that move back (settlementStatus().undelivered) for the application to offer again as a
// new move. Offering it again now would sign the OLDER placement after the newer one: every replica
// would converge on (1, 0), and the member's latest accepted placement (2, 0) would be lost although
// both calls succeeded. Seen in the browser Grid FPS run (browser-app-fps.pw.ts): member block ids end
// at an older placement in both replicas.
//
// The invariant: once the room has moved on, the member's last accepted operation for a block id is
// its newest placement of that id.

const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The policy is built as Grid builds it (examples/grid/src/v3-zone.ts): a placement's identity is its block.
const blockIdentity = (operation: Readonly<Record<string, unknown>>) =>
	operation.action === "placeBlock" ? `placeBlock\u0000${String(operation.id)}` : undefined;

/**
 * A member's room. It accepts every move; once `giveBack` is called its settlement lists the given
 * operation (one durable hand-back record) until a move carrying that record is accepted.
 * @returns The room, its accepted moves, the hand-back, and its install.
 */
function memberRoom() {
	let epoch = 3;
	const accepted: { operation: Readonly<Record<string, unknown>>; handBack: unknown }[] = [];
	let listed:
		| { handBack: { sourceSequence: number; intent: number }; operation: Readonly<Record<string, unknown>> }
		| undefined;
	const room = {
		authority: () =>
			({ epoch }) as unknown as ReturnType<
				NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]
			>,
		issue: (
			operation: Readonly<Record<string, unknown>>,
			options?: { handBack?: { sourceSequence: number; intent: number } }
		) => {
			accepted.push({ operation, handBack: options?.handBack });
			if (
				listed !== undefined &&
				options?.handBack !== undefined &&
				options.handBack.sourceSequence === listed.handBack.sourceSequence &&
				options.handBack.intent === listed.handBack.intent
			)
				listed = undefined;
			return Promise.resolve();
		},
		settlementStatus: () => ({
			epoch,
			unsettledEpochs: 0,
			window: 4,
			undelivered:
				listed === undefined
					? []
					: [
							{
								vertexDigest: "00".repeat(32),
								epoch: epoch - 4,
								handBack: listed.handBack,
								operations: [listed.operation],
							},
						],
			deferred: 0,
			awaitingFence: false,
		}),
		sealEpoch: () => Promise.reject(new Error("members never seal")),
		adoptCreatorSuccessor: () => Promise.reject(new Error("members never adopt")),
		exportCreatorSuccessor: () => Promise.reject(new Error("members never export")),
	};
	return {
		room,
		accepted,
		giveBack: (operation: Readonly<Record<string, unknown>>) =>
			(listed = { handBack: { sourceSequence: 7, intent: 0 }, operation }),
		listed: () => listed,
		install: (next: number) => (epoch = next),
	};
}

it("a given-back move never lands after a newer accepted move of the same block id", async () => {
	const { room, accepted, giveBack, install } = memberRoom();
	const policy = (
		rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy
	)({
		role: "member",
		budget: { movesPerAuthor: 7, idleMs: 10_000 },
		identity: blockIdentity,
	});
	policies.add(policy);
	policy.bind(room);
	const older = Object.freeze({ action: "placeBlock", id: "b-1", kind: "stone", x: 1, y: 0 });
	const newer = Object.freeze({ action: "placeBlock", id: "b-1", kind: "wood", x: 2, y: 0 });
	await policy.issue(older);
	await policy.issue(newer);
	// The older placement's rows never reached the creator inside the window: the room gives it back.
	giveBack(older);
	// The policy polls the settlement every second; then the room moves on, epoch by epoch.
	await sleep(1_500);
	for (let next = 4; next <= 6; next++) {
		install(next);
		await sleep(1_500);
	}
	const ofBlock = accepted.filter((move) => move.operation.id === "b-1").map((move) => move.operation);
	expect(ofBlock.at(-1), "the member's last accepted operation for b-1 is its newest placement").toEqual(newer);
}, 30_000);

it("a kept move never lands after a newer accepted move of the same block id", async () => {
	const { room, accepted, install } = memberRoom();
	// The room refuses the first placement up front (its undelivered moves fill the backlog); the policy
	// keeps it for a later epoch. The next placement of the same block is accepted.
	const issue = room.issue;
	let refusedOnce = false;
	room.issue = (operation, options) => {
		if (!refusedOnce) {
			refusedOnce = true;
			const refusal = new Error("v3 room local backlog is full: 64 of 64 own moves are not reaching the host");
			refusal.name = "V3RoomLocalBacklogFull";
			return Promise.reject(refusal);
		}
		return issue(operation, options);
	};
	const policy = (
		rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy
	)({
		role: "member",
		budget: { movesPerAuthor: 7, idleMs: 10_000 },
		identity: blockIdentity,
	});
	policies.add(policy);
	policy.bind(room);
	const older = Object.freeze({ action: "placeBlock", id: "b-2", kind: "stone", x: 1, y: 0 });
	const newer = Object.freeze({ action: "placeBlock", id: "b-2", kind: "wood", x: 2, y: 0 });
	await expect(policy.issue(older)).rejects.toThrow(rollover.V3RoomNotReachingHost);
	await policy.issue(newer);
	for (let next = 4; next <= 6; next++) {
		install(next);
		await sleep(1_500);
	}
	const ofBlock = accepted.filter((move) => move.operation.id === "b-2").map((move) => move.operation);
	expect(ofBlock.at(-1), "the member's last accepted operation for b-2 is its newest placement").toEqual(newer);
}, 30_000);

it("a superseded kept or given-back move is accounted for (V3RoomKeptMoveSuperseded), never silently dropped", async () => {
	const { room, accepted, giveBack, install } = memberRoom();
	const issue = room.issue;
	let refusedOnce = false;
	room.issue = (operation, options) => {
		if (operation.id === "b-4" && !refusedOnce) {
			refusedOnce = true;
			const refusal = new Error("v3 room local backlog is full: 64 of 64 own moves are not reaching the host");
			refusal.name = "V3RoomLocalBacklogFull";
			return Promise.reject(refusal);
		}
		return issue(operation, options);
	};
	const reported: unknown[] = [];
	const policy = (
		rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy
	)({
		role: "member",
		budget: { movesPerAuthor: 7, idleMs: 10_000 },
		identity: blockIdentity,
		hooks: { onError: (error: unknown) => reported.push(error) },
	});
	policies.add(policy);
	policy.bind(room);
	const givenOlder = Object.freeze({ action: "placeBlock", id: "b-3", kind: "stone", x: 1, y: 0 });
	const givenNewer = Object.freeze({ action: "placeBlock", id: "b-3", kind: "wood", x: 2, y: 0 });
	const keptOlder = Object.freeze({ action: "placeBlock", id: "b-4", kind: "stone", x: 3, y: 0 });
	const keptNewer = Object.freeze({ action: "placeBlock", id: "b-4", kind: "wood", x: 4, y: 0 });
	await policy.issue(givenOlder);
	await policy.issue(givenNewer);
	await expect(policy.issue(keptOlder)).rejects.toThrow(rollover.V3RoomNotReachingHost);
	await policy.issue(keptNewer);
	giveBack(givenOlder);
	await sleep(1_500);
	for (let next = 4; next <= 6; next++) {
		install(next);
		await sleep(1_500);
	}
	const superseded = reported.filter(
		(error): error is rollover.V3RoomKeptMoveSuperseded => error instanceof rollover.V3RoomKeptMoveSuperseded
	);
	expect(
		superseded.map((error) => ({ operation: error.operation, by: error.supersededBy, givenBack: error.givenBack })),
		"each superseded move is reported with the newer move that stands in its place"
	).toEqual(
		expect.arrayContaining([
			{ operation: givenOlder, by: givenNewer, givenBack: true },
			{ operation: keptOlder, by: keptNewer, givenBack: false },
		])
	);
	expect(superseded).toHaveLength(2);
	expect(policy.status().kept, "nothing is left kept").toEqual([]);
	for (const [id, newest] of [
		["b-3", givenNewer],
		["b-4", keptNewer],
	] as const)
		expect(
			accepted
				.filter((move) => move.operation.id === id)
				.map((move) => move.operation)
				.at(-1),
			`the author's final state for ${id} lands last`
		).toEqual(newest);
}, 30_000);

it("the newer move offered again after a superseded given-back move takes what the epoch's budget leaves", async () => {
	const { room, accepted, giveBack, install } = memberRoom();
	let epoch = 3;
	const acceptedIn = new Map<Readonly<Record<string, unknown>>, number[]>();
	const issue = room.issue;
	room.issue = (operation, options) => {
		acceptedIn.set(operation, [...(acceptedIn.get(operation) ?? []), epoch]);
		return issue(operation, options);
	};
	const reported: unknown[] = [];
	const policy = (
		rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy
	)({
		role: "member",
		// One kept re-offer per epoch: the given-back move spends it, so the newer move waits a later epoch.
		budget: { movesPerAuthor: 1, idleMs: 10_000 },
		identity: blockIdentity,
		hooks: { onError: (error: unknown) => reported.push(error) },
	});
	policies.add(policy);
	policy.bind(room);
	const older = Object.freeze({ action: "placeBlock", id: "b-5", kind: "stone", x: 1, y: 0 });
	const newer = Object.freeze({ action: "placeBlock", id: "b-5", kind: "wood", x: 2, y: 0 });
	await policy.issue(older);
	await policy.issue(newer);
	giveBack(older);
	await sleep(1_500);
	for (let next = 4; next <= 6; next++) {
		epoch = next;
		install(next);
		await sleep(1_500);
	}
	const reoffers = accepted.slice(2).map((move) => move.operation);
	expect(reoffers, "the given-back move, then the newer move once, after it").toEqual([older, newer]);
	expect(acceptedIn.get(older), "the given-back move: issued at 3, offered again in 4").toEqual([3, 4]);
	expect(acceptedIn.get(newer), "the newer move offered again in the next epoch's budget").toEqual([3, 5]);
	expect(
		reported.filter((error) => error instanceof rollover.V3RoomKeptMoveSuperseded),
		"the superseded given-back move is reported once"
	).toHaveLength(1);
	expect(policy.status().kept, "nothing is left kept").toEqual([]);
}, 30_000);
