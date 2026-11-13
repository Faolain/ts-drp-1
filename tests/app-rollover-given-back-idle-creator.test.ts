/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";

// PROBE (not a fix): a member's given-back moves wait for the room to be past the epoch they were listed
// in. Once play stops, the creator rolls only on its idle timer and only if its epoch holds a move; a
// member whose moves were all given back adds none, so its epoch never advances and the given-back moves
// are never offered again.

const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("a member's given-back moves are offered again while the creator stays idle in the member's epoch", async () => {
	const listed = new Map([["10:0", { handBack: { sourceSequence: 10, intent: 0 }, operations: [{ action: "move", id: "given-0" }] }]]);
	const offers: unknown[] = [];
	const room = {
		authority: () => ({ epoch: 7 }) as unknown as ReturnType<NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]>,
		issue: (operation: Readonly<Record<string, unknown>>, options?: { handBack?: { sourceSequence: number; intent: number } }) => {
			offers.push(operation.id);
			if (options?.handBack !== undefined) listed.delete(`${options.handBack.sourceSequence}:${options.handBack.intent}`);
			return Promise.resolve();
		},
		settlementStatus: () => ({ epoch: 7, unsettledEpochs: 0, window: 4, undelivered: [...listed.values()], deferred: 0 }),
		sealEpoch: () => Promise.reject(new Error("members never seal")),
		adoptCreatorSuccessor: () => Promise.reject(new Error("members never adopt")),
		exportCreatorSuccessor: () => Promise.reject(new Error("members never export")),
	};
	const policy = (rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy)({
		role: "member",
		budget: { movesPerAuthor: 7, idleMs: 10_000 },
		hooks: {},
	});
	policies.add(policy);
	policy.bind(room);
	await sleep(6_000);
	expect(offers, "the given-back move is offered again with the creator idle").toEqual(["given-0"]);
	expect(policy.status().kept).toEqual([]);
}, 30_000);
