/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, describe, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";
import { retainedRowUnprovenKind } from "../packages/node/src/v3-live.js";
import {
	awaitingFencePinnedSourceDiagnostic,
	settlementAuthorFenceDecision,
	V3RoomAwaitingAuthorFence,
} from "../packages/node/src/v3-room.js";
import { AHE_BOUNDED_READ_LIMITS } from "../packages/storage/src/index.js";

// fix/creator-anchor-uncovered (g): the author fence is withheld only for retained work a later
// frontier may still prove, and while it is (the frontier is not installed yet) new moves are refused
// up front and kept by the app's policy until a later install. A member that can issue at an epoch
// above 0 always has a valid frontier (its own issuance needs one), so the awaited path is not reached
// by a native room today; it is covered here at unit level.

describe("retainedRowUnprovenKind", () => {
	const frontier = { admissionEpoch: 2, currentEpoch: 8, terminalThrough: 4 } as const;
	it("awaits a frontier when none is installed or the row's epoch is not closed in it", () => {
		expect(retainedRowUnprovenKind(undefined, 3, 7, new Map())).toBe("awaiting-frontier");
		expect(retainedRowUnprovenKind(frontier, 8, 9, new Map())).toBe("awaiting-frontier");
	});
	it("never proves an earlier incarnation's row", () => {
		expect(retainedRowUnprovenKind(frontier, 1, 6, new Map([[1, 5]]))).toBe("never");
	});
	it("never proves a displaced row no own fence of its epoch precedes", () => {
		// Not the lowest unsettled sequence (5), and the epoch-3 fence (7) is after it.
		expect(retainedRowUnprovenKind(frontier, 3, 6, new Map([[3, 7]]))).toBe("never");
		expect(retainedRowUnprovenKind(frontier, 3, 6, new Map())).toBe("never");
	});
	it("calls a displaced fence-guarded row provable", () => {
		expect(retainedRowUnprovenKind(frontier, 3, 6, new Map([[3, 6]]))).toBe("provable");
		expect(retainedRowUnprovenKind(frontier, 3, 5, new Map())).toBe("provable");
	});
	it("never proves a row within terminalThrough that the frontier did not prove committed", () => {
		expect(retainedRowUnprovenKind(frontier, 3, 4, new Map())).toBe("never");
	});
});

describe("settlementAuthorFenceDecision", () => {
	const unresolved = (unproven: "awaiting-frontier" | "never" | "provable" | undefined) =>
		({ disposition: "manual-review", unproven }) as const;
	it("fences with no retained work or with a replacement to issue", () => {
		expect(settlementAuthorFenceDecision({ retained: [], eligible: false, currentMember: true })).toBe("fence");
		expect(
			settlementAuthorFenceDecision({ retained: [unresolved(undefined)], eligible: true, currentMember: false })
		).toBe("fence");
	});
	it("fences for a current member whose retained rows are terminal or never provable", () => {
		const retained = [
			{ disposition: "expire", unproven: undefined },
			{ disposition: "committed", unproven: undefined },
			unresolved("never"),
		];
		expect(settlementAuthorFenceDecision({ retained, eligible: false, currentMember: true })).toBe("fence");
	});
	it("withholds for a non-member", () => {
		expect(
			settlementAuthorFenceDecision({ retained: [unresolved("never")], eligible: false, currentMember: false })
		).toBe("withhold");
	});
	it("awaits the fence while a retained row waits for a frontier", () => {
		expect(
			settlementAuthorFenceDecision({
				retained: [unresolved("never"), unresolved("awaiting-frontier")],
				eligible: false,
				currentMember: true,
			})
		).toBe("await-fence");
	});
	it("withholds, without awaiting, for provable or unread rows", () => {
		expect(
			settlementAuthorFenceDecision({ retained: [unresolved("provable")], eligible: false, currentMember: true })
		).toBe("withhold");
		expect(
			settlementAuthorFenceDecision({ retained: [unresolved(undefined)], eligible: false, currentMember: true })
		).toBe("withhold");
	});
});

describe("awaitingFencePinnedSourceDiagnostic", () => {
	// held-anchor-retention.qnt p6: a fence awaited while a completed replacement entry pins a source
	// older than the retained AHE generations. A native room is not expected to reach it; the event
	// makes it observable without changing behaviour.
	const bound = AHE_BOUNDED_READ_LIMITS.maxObjectGenerations;
	const retained = [
		{ disposition: "manual-review", unproven: "awaiting-frontier" },
		{ disposition: "manual-review", unproven: "never" },
	] as const;
	const decision = settlementAuthorFenceDecision({ retained, eligible: false, currentMember: true });
	it("fires when the fence is awaited and a pinned source is more than the generation bound old", () => {
		expect(decision).toBe("await-fence");
		const event = awaitingFencePinnedSourceDiagnostic({
			decision,
			epoch: 20,
			awaitingSequences: [9],
			pinnedSources: [
				{ sourceSequence: 7, sourceEpoch: 20 - bound },
				{ sourceSequence: 4, sourceEpoch: 20 - bound - 2 },
				{ sourceSequence: 2, sourceEpoch: 20 - bound - 1 },
			],
			generationBound: bound,
		});
		expect(event).toEqual({
			kind: "awaiting-fence-pinned-source",
			epoch: 20,
			awaitingSequences: [9],
			pinnedSources: [
				{ sourceSequence: 4, sourceEpoch: 20 - bound - 2 },
				{ sourceSequence: 2, sourceEpoch: 20 - bound - 1 },
			],
			generationBound: bound,
		});
	});
	it("stays silent within the bound, when the fence is not awaited, or with nothing pinned", () => {
		const base = { epoch: 20, awaitingSequences: [9], generationBound: bound } as const;
		const young = [{ sourceSequence: 7, sourceEpoch: 20 - bound }];
		const old = [{ sourceSequence: 4, sourceEpoch: 1 }];
		expect(awaitingFencePinnedSourceDiagnostic({ ...base, decision, pinnedSources: young })).toBeUndefined();
		expect(awaitingFencePinnedSourceDiagnostic({ ...base, decision, pinnedSources: [] })).toBeUndefined();
		expect(awaitingFencePinnedSourceDiagnostic({ ...base, decision: "fence", pinnedSources: old })).toBeUndefined();
		expect(awaitingFencePinnedSourceDiagnostic({ ...base, decision: "withhold", pinnedSources: old })).toBeUndefined();
	});
});

const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

/**
 * A member's room that refuses new moves while epoch 1's author fence is awaited.
 * @returns The room, its offered and admitted moves, and its install.
 */
function awaitingFenceRoom() {
	let epoch = 1;
	const offered: unknown[] = [];
	const admitted: unknown[] = [];
	const room = {
		authority: () =>
			({ epoch }) as unknown as ReturnType<
				NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]
			>,
		issue: (operation: Readonly<Record<string, unknown>>) => {
			offered.push(operation);
			if (epoch <= 1) return Promise.reject(new V3RoomAwaitingAuthorFence(epoch));
			admitted.push(operation);
			return Promise.resolve();
		},
		sealEpoch: () => Promise.reject(new Error("members never seal")),
		adoptCreatorSuccessor: () => Promise.reject(new Error("members never adopt")),
		exportCreatorSuccessor: () => Promise.reject(new Error("members never export")),
	};
	return { room, offered, admitted, install: (next: number) => (epoch = next) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("a move refused while the author fence is awaited is kept by the policy and admitted after the next install", async () => {
	const { room, offered, admitted, install } = awaitingFenceRoom();
	const policy = (
		rollover.createV3RoomRolloverPolicy as (input: Record<string, unknown>) => rollover.V3RoomRolloverPolicy
	)({ role: "member", budget: { movesPerAuthor: 7, idleMs: 10_000 }, hooks: {} });
	policies.add(policy);
	policy.bind(room);
	const move = { kind: "paint", id: "awaiting-fence-kept-1" };
	const refusal = await policy.issue(move).then(
		() => undefined,
		(error: unknown) => error
	);
	expect(refusal).toBeInstanceOf(rollover.V3RoomAwaitingFence);
	expect((refusal as rollover.V3RoomAwaitingFence).operation).toBe(move);
	expect((refusal as Error).cause, "the room's typed refusal is the cause").toBeInstanceOf(V3RoomAwaitingAuthorFence);
	const status = () => (policy as unknown as { status(): { state: string; kept: readonly unknown[] } }).status();
	expect(status().state).toBe("awaiting-fence");
	expect(status().kept, "the refused move is kept").toEqual([move]);
	await sleep(2_500);
	expect(offered, "not offered again in the refusing epoch").toEqual([move]);
	install(2);
	const deadline = performance.now() + 10_000;
	while (admitted.length === 0 && performance.now() < deadline) await sleep(100);
	expect(admitted, "the kept move admitted after the install").toEqual([move]);
	expect(status().kept).toEqual([]);
	expect(status().state).toBe("ready");
}, 30_000);
