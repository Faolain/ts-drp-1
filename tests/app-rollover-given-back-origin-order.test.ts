/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import { shippingChatHistory } from "../examples/chat/src/v3-chat-archive.js";
import * as rollover from "../examples/v3-room/src/rollover.js";

// The durable author-order fix (track 46: hand-back records carry the move's origin sequence; the room
// listing is sorted by origin and names a newer move of the same identity, supersededBy). Two cases
// the identity-aware re-offer (V3RoomKeptMoveSuperseded) cannot cover:
//
// 1. Chat: no move supersedes another (each message is its own identity), so a given-back message is
//    offered again as a new move after the author's newer messages were admitted, and replicas see only
//    admitted order: the room cannot put it back. Chat's view (option C1, shippingChatHistory) orders
//    each author's messages by the signed displayTimeMs they carry, interleaving authors by admitted
//    order, so every replica shows the author's messages in the order the author wrote them.
// 2. A page reload (a fresh policy): the policy has no history of the session that issued the newer
//    move, so without the room's durable answer a given-back Grid placement lands after the newer
//    placement of the same block. The room's listing names the newer move (supersededBy), so the
//    policy offers it again right after the older one.
//
// The fake room models the listing fields: each row's origin (a reissue keeps its record's), the
// listing sorted by origin, and supersededBy from the room's displacement identity.

const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A member's room. Every issued row gets the next author sequence; a row `displace`d never reaches the
 * creator, and `giveBack` lists its move as one durable hand-back record until a reissue consumes it.
 * @param displacementIdentity - The policy identity the room's `supersededBy` uses (none: no supersession).
 * @returns The room, the rows the creator admitted (in order), and the controls.
 */
function memberRoom(displacementIdentity?: (operation: Readonly<Record<string, unknown>>) => string | undefined) {
	let epoch = 3;
	let sequence = 0;
	const displaced = new Set<number>();
	type Row = { sequence: number; origin: number; operation: Readonly<Record<string, unknown>> };
	const rows: Row[] = [];
	const listed = new Map<string, Row>();
	// The author's newest own issued row of the move's identity with a later origin.
	const supersededBy = (row: Row) => {
		const key = displacementIdentity?.(row.operation);
		if (key === undefined) return undefined;
		const later = rows
			.filter((candidate) => candidate.origin > row.origin && displacementIdentity?.(candidate.operation) === key)
			.sort((left, right) => left.origin - right.origin || left.sequence - right.sequence)
			.at(-1);
		return later === undefined ? undefined : { authorSequence: later.sequence, operation: later.operation };
	};
	const room = {
		authority: () =>
			({ epoch }) as unknown as ReturnType<
				NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]
			>,
		issue: (
			operation: Readonly<Record<string, unknown>>,
			options?: { handBack?: { sourceSequence: number; intent: number } }
		) => {
			const key =
				options?.handBack === undefined ? undefined : `${options.handBack.sourceSequence}:${options.handBack.intent}`;
			const record = key === undefined ? undefined : listed.get(key);
			// A reissue keeps its record's move origin.
			rows.push({ sequence: ++sequence, origin: record?.origin ?? sequence, operation });
			if (key !== undefined) listed.delete(key);
			return Promise.resolve();
		},
		settlementStatus: () => ({
			epoch,
			unsettledEpochs: 0,
			window: 4,
			undelivered: [...listed.values()]
				.sort((left, right) => left.origin - right.origin)
				.map((row) => {
					const newer = supersededBy(row);
					return {
						vertexDigest: row.sequence.toString(16).padStart(64, "0"),
						epoch: epoch - 4,
						handBack: { sourceSequence: row.sequence, intent: 0 },
						operations: [row.operation],
						originSequence: row.origin,
						...(newer === undefined ? {} : { supersededBy: newer }),
					};
				}),
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

const policyFor = (
	room: ReturnType<typeof memberRoom>["room"],
	identity?: (operation: Readonly<Record<string, unknown>>) => string | undefined
) => {
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

it("Chat: a given-back message is shown in the author's order among the author's messages", async () => {
	// Chat's displacement identity: each message is its own (its client operation id).
	const { room, admitted, displace, giveBack, install } = memberRoom(
		(operation) => `message\u0000${String(operation.clientOperationId)}`
	);
	const policy = policyFor(room);
	const first = Object.freeze({
		action: "message",
		clientOperationId: "m-1",
		displayTimeMs: 1_791_662_400_000,
		text: "first",
	});
	const second = Object.freeze({
		action: "message",
		clientOperationId: "m-2",
		displayTimeMs: 1_791_662_401_000,
		text: "second",
	});
	await policy.issue(first);
	await policy.issue(second);
	// The first message's row never reached the creator inside the window; the second's did.
	displace(first);
	giveBack(first);
	await rollThrough(install);
	// Every replica admits the rows in this order and shows them through the Chat view.
	const shown = shippingChatHistory(
		admitted().map((operation) => ({
			author: "a".repeat(64),
			clientOperationId: String(operation.clientOperationId),
			displayTimeMs: operation.displayTimeMs as number,
			text: String(operation.text),
		})),
		[]
	);
	expect(
		shown.map((message) => message.clientOperationId),
		"the author's messages, as every replica shows them"
	).toEqual(["m-1", "m-2"]);
}, 30_000);

it("Grid across a reload: a given-back placement never lands after the newer placement of the same block", async () => {
	const identity = (operation: Readonly<Record<string, unknown>>) =>
		operation.action === "placeBlock" ? `placeBlock\u0000${String(operation.id)}` : undefined;
	const { room, admitted, displace, giveBack, install } = memberRoom(identity);
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
