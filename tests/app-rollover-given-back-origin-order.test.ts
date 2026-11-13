/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";

// RED for the durable author-order fix (hand-back records carry the move's origin sequence). Two
// cases the identity-aware re-offer (V3RoomKeptMoveSuperseded) cannot cover:
//
// 1. Chat: no move supersedes another (each message is its own identity), so a given-back message is
//    offered again as a new move after the author's newer messages were admitted. Chat's projection
//    folds admitted rows in order (examples/chat/src/v3-chat-application.ts project), so every
//    replica shows the author's messages out of the order the author wrote them.
// 2. A page reload (a fresh policy): the policy has no history of the session that issued the newer
//    move, so a given-back Grid placement lands after the newer placement of the same block.
//
// In both, the room listing (settlementStatus().undelivered) is all the policy has; today it names
// only the hand-back key (the last carrier row's sequence and intent), not where the move stands in
// the author's order.

const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A member's room. Every issued row gets the next author sequence; a row `displace`d never reaches the
 * creator, and `giveBack` lists its move as one durable hand-back record until a reissue consumes it.
 * @returns The room, the rows the creator admitted (in order), and the controls.
 */
function memberRoom() {
	let epoch = 3;
	let sequence = 0;
	const displaced = new Set<number>();
	const rows: { sequence: number; operation: Readonly<Record<string, unknown>> }[] = [];
	const listed = new Map<string, { sequence: number; operation: Readonly<Record<string, unknown>> }>();
	const room = {
		authority: () =>
			({ epoch }) as unknown as ReturnType<
				NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]
			>,
		issue: (
			operation: Readonly<Record<string, unknown>>,
			options?: { handBack?: { sourceSequence: number; intent: number } }
		) => {
			rows.push({ sequence: ++sequence, operation });
			if (options?.handBack !== undefined) listed.delete(`${options.handBack.sourceSequence}:${options.handBack.intent}`);
			return Promise.resolve();
		},
		settlementStatus: () => ({
			epoch,
			unsettledEpochs: 0,
			window: 4,
			undelivered: [...listed.values()].map((row) => ({
				vertexDigest: row.sequence.toString(16).padStart(64, "0"),
				epoch: epoch - 4,
				handBack: { sourceSequence: row.sequence, intent: 0 },
				operations: [row.operation],
			})),
			deferred: 0,
			awaitingFence: false,
		}),
		sealEpoch: () => Promise.reject(new Error("members never seal")),
		adoptCreatorSuccessor: () => Promise.reject(new Error("members never adopt")),
		exportCreatorSuccessor: () => Promise.reject(new Error("members never export")),
	};
	const rowOf = (operation: Readonly<Record<string, unknown>>) => {
		const row = rows.find((candidate) => candidate.operation === operation);
		if (row === undefined) throw new Error("no such row");
		return row;
	};
	return {
		room,
		// The creator's admitted rows, in order: every row but the displaced ones.
		admitted: () => rows.filter((row) => !displaced.has(row.sequence)).map((row) => row.operation),
		displace: (operation: Readonly<Record<string, unknown>>) => displaced.add(rowOf(operation).sequence),
		giveBack: (operation: Readonly<Record<string, unknown>>) => {
			const row = rowOf(operation);
			listed.set(`${row.sequence}:0`, row);
		},
		install: (next: number) => (epoch = next),
	};
}

const policyFor = (room: ReturnType<typeof memberRoom>["room"], identity?: (operation: Readonly<Record<string, unknown>>) => string | undefined) => {
	const policy = (
		rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy
	)({
		role: "member",
		budget: { movesPerAuthor: 7, idleMs: 10_000 },
		...(identity === undefined ? {} : { identity }),
	});
	policies.add(policy);
	policy.bind(room);
	return policy;
};

async function rollThrough(install: (next: number) => void) {
	await sleep(1_500);
	for (let next = 4; next <= 6; next++) {
		install(next);
		await sleep(1_500);
	}
}

it("Chat: a given-back message is admitted in the author's order among the author's messages", async () => {
	const { room, admitted, displace, giveBack, install } = memberRoom();
	const policy = policyFor(room);
	const first = Object.freeze({ action: "message", clientOperationId: "m-1", text: "first" });
	const second = Object.freeze({ action: "message", clientOperationId: "m-2", text: "second" });
	await policy.issue(first);
	await policy.issue(second);
	// The first message's row never reached the creator inside the window; the second's did.
	displace(first);
	giveBack(first);
	await rollThrough(install);
	expect(
		admitted().map((operation) => operation.clientOperationId),
		"the author's messages, as every replica shows them"
	).toEqual(["m-1", "m-2"]);
}, 30_000);

it("Grid across a reload: a given-back placement never lands after the newer placement of the same block", async () => {
	const { room, admitted, displace, giveBack, install } = memberRoom();
	const identity = (operation: Readonly<Record<string, unknown>>) =>
		operation.action === "placeBlock" ? `placeBlock\u0000${String(operation.id)}` : undefined;
	const before = policyFor(room, identity);
	const older = Object.freeze({ action: "placeBlock", id: "b-1", kind: "stone", x: 1, y: 0 });
	const newer = Object.freeze({ action: "placeBlock", id: "b-1", kind: "wood", x: 2, y: 0 });
	await before.issue(older);
	await before.issue(newer);
	displace(older);
	// The page reloads: a fresh policy binds the same room, which gives the older placement back.
	before.close();
	const after = policyFor(room, identity);
	void after;
	giveBack(older);
	await rollThrough(install);
	const ofBlock = admitted().filter((operation) => operation.id === "b-1");
	expect(ofBlock.at(-1), "the block's final placement in every replica").toEqual(newer);
}, 30_000);
