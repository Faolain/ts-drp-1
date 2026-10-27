/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";

// App rollover delivery, item 2: a member (Writer) whose move is refused at a capacity only a
// rollover clears used to wait for its room's next epoch with no deadline. When no successor
// arrives (the creator is gone, or its offer never reaches this member), the wait is now bounded:
// the move is kept, the page is told (status plus the kept move), and the kept move is offered
// again once a later epoch is installed. While it waits, the member asks for the successor.

const CAPACITY = new Error("issuance refused: MAINTENANCE_RECOVERY_POOL_FULL");
const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

/** A member's room whose moves are refused until its epoch advances past `refuseThrough`. */
function memberRoom(refuseThrough: number) {
	let epoch = 1;
	const admitted: unknown[] = [];
	const room = {
		authority: () =>
			({ epoch }) as unknown as ReturnType<
				NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]
			>,
		issue: (operation: Readonly<Record<string, unknown>>) => {
			if (epoch <= refuseThrough) return Promise.reject(CAPACITY);
			admitted.push(operation);
			return Promise.resolve();
		},
		sealEpoch: () => Promise.reject(new Error("members never seal")),
		adoptCreatorSuccessor: () => Promise.reject(new Error("members never adopt")),
		exportCreatorSuccessor: () => Promise.reject(new Error("members never export")),
	};
	return { room, admitted, install: (next: number) => (epoch = next) };
}

const create = (options: Record<string, unknown>) => {
	const policy = (
		rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy
	)({
		role: "member",
		budget: { movesPerAuthor: 7, idleMs: 10_000 },
		...options,
	});
	policies.add(policy);
	return policy;
};

const within = <T>(promise: Promise<T>, ms: number): Promise<T | "STILL_WAITING"> =>
	Promise.race([promise, new Promise<"STILL_WAITING">((resolve) => setTimeout(() => resolve("STILL_WAITING"), ms))]);

it("a member's wait for a successor that never arrives is bounded, and the page gets the status and the kept move", async () => {
	const { room } = memberRoom(Number.POSITIVE_INFINITY);
	const statuses: unknown[] = [];
	let requested = 0;
	const policy = create({
		memberWaitMs: 600,
		hooks: {
			requestSuccessor: () => requested++,
			onStatus: (status: unknown) => statuses.push(status),
		},
	});
	policy.bind(room);
	const move = { kind: "paint", id: "kept-1" };
	const outcome = await within(
		policy.issue(move).then(
			() => "admitted",
			(error: unknown) => error
		),
		5_000
	);
	expect(outcome, "the wait ended by itself").not.toBe("STILL_WAITING");
	expect(outcome).toBeInstanceOf((rollover as Record<string, unknown>).V3RoomSuccessorUnavailable as new () => Error);
	expect((outcome as { operation: unknown }).operation).toBe(move);
	expect(requested, "the member asked for the successor while it waited").toBeGreaterThanOrEqual(1);
	const status = (policy as unknown as { status(): { state: string; kept: readonly unknown[] } }).status();
	expect(status.state).toBe("successor-unavailable");
	expect(status.kept).toEqual([move]);
	expect(statuses.some((value) => (value as { state: string }).state === "waiting")).toBe(true);
	expect(statuses.at(-1)).toMatchObject({ state: "successor-unavailable", kept: [move] });
});

it("a kept move is offered again once a later epoch is installed, and the status returns to ready", async () => {
	const { room, admitted, install } = memberRoom(1);
	const statuses: { state: string; kept: readonly unknown[] }[] = [];
	const policy = create({ memberWaitMs: 400, hooks: { onStatus: (status: never) => statuses.push(status) } });
	policy.bind(room);
	const move = { kind: "paint", id: "kept-2" };
	await expect(policy.issue(move)).rejects.toBeInstanceOf(
		(rollover as Record<string, unknown>).V3RoomSuccessorUnavailable as new () => Error
	);
	expect(admitted).toEqual([]);
	install(2);
	const deadline = performance.now() + 5_000;
	while (admitted.length === 0 && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	expect(admitted, "the kept move was offered again in the installed epoch").toEqual([move]);
	const status = (policy as unknown as { status(): { state: string; kept: readonly unknown[] } }).status();
	expect(status).toMatchObject({ state: "ready", kept: [] });
	expect(statuses.at(-1)).toMatchObject({ state: "ready", kept: [] });
});

it("a successor that arrives inside the bound admits the move as before (control)", async () => {
	const { room, admitted, install } = memberRoom(1);
	const policy = create({ memberWaitMs: 5_000 });
	policy.bind(room);
	const move = { kind: "paint", id: "in-time" };
	setTimeout(() => install(2), 300);
	await policy.issue(move);
	expect(admitted).toEqual([move]);
	expect((policy as unknown as { status(): { state: string } }).status().state).toBe("ready");
});

it("the default bound is named and finite", () => {
	const bound = (rollover as Record<string, unknown>).V3_ROOM_MEMBER_SUCCESSOR_WAIT_MS;
	expect(typeof bound).toBe("number");
	expect(Number.isFinite(bound as number)).toBe(true);
	expect(bound as number).toBeGreaterThan(0);
	expect(bound as number).toBeLessThanOrEqual(120_000);
});
