/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";

// Seen in the v3-chat rollover e2e on WebKit (1 run of 3): the creator's own move, issued while
// its policy's adoption replaced the live plane, was refused with "creator recovery dependency
// hold unavailable:replay" (v3-live: the plane changed while the issue captured its recovery
// dependencies) and the policy threw it to the page. The plane is being replaced, as with the
// closing refusals the policy already offers again, so the move is offered again; a refusal at
// any other stage of that capture still reaches the page.

const REPLACED = new TypeError(
	"v3 room issue failed: issuance-rejected: v3 local issue transaction failed: creator recovery dependency hold unavailable:replay"
);
const OTHER_STAGE = new TypeError(
	"v3 room issue failed: issuance-rejected: v3 local issue transaction failed: creator recovery dependency hold unavailable: outbox-classification:source:displaced"
);
const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

/** A creator's room whose next `refusals` moves are refused with `error`. */
function creatorRoom(error: Error, refusals: number) {
	let refused = 0;
	const admitted: unknown[] = [];
	const room = {
		authority: () =>
			({ epoch: 2 }) as unknown as ReturnType<
				NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]
			>,
		issue: (operation: Readonly<Record<string, unknown>>) => {
			if (refused < refusals) {
				refused++;
				return Promise.reject(error);
			}
			admitted.push(operation);
			return Promise.resolve();
		},
		sealEpoch: () => Promise.reject(new Error("no seal in this test")),
		adoptCreatorSuccessor: () => Promise.reject(new Error("no adoption in this test")),
		exportCreatorSuccessor: () => Promise.reject(new Error("no export in this test")),
	};
	return { room, admitted, refusedCount: () => refused };
}

const create = () => {
	const policy = rollover.createV3RoomRolloverPolicy({
		role: "creator",
		budget: { movesPerAuthor: 1_000, idleMs: 600_000 },
	});
	policies.add(policy);
	return policy;
};

it("a move refused while the creator's live plane is replaced is offered again", async () => {
	const { room, admitted, refusedCount } = creatorRoom(REPLACED, 2);
	const policy = create();
	policy.bind(room);
	const move = { action: "message", clientOperationId: "replaced-1", text: "hello" };
	await expect(policy.issue(move)).resolves.toBeUndefined();
	expect(refusedCount()).toBe(2);
	expect(admitted).toEqual([move]);
});

it("a refusal at another stage of the recovery-dependency capture still reaches the page", async () => {
	const { room, admitted } = creatorRoom(OTHER_STAGE, 1);
	const policy = create();
	policy.bind(room);
	await expect(policy.issue({ action: "message", clientOperationId: "other-1", text: "x" })).rejects.toBe(OTHER_STAGE);
	expect(admitted).toEqual([]);
});
