import type { V3RoomRolloverBudget } from "@ts-drp/example-v3-room";

/**
 * When the shipped Canvas's creator rolls its room over (the shared scheduling is
 * `createV3RoomRolloverPolicy` in examples/v3-room). Tests import this so they follow the
 * shipped choice.
 *
 * Measured on native SQLite (tests/app-rollover-ceiling-native.test.ts): the creator's issuance
 * image holds about 38 of its own paints across the current epoch and the two before it, and
 * across the three before it at every fourth epoch (a generation turnover: epochs 4, 8, 12...).
 * A fresh room admits 40 in its first epoch; after epochs of 10 paints a normal epoch admits 19
 * and a generation epoch 8; after epochs of 7, a generation epoch admits 17. With a budget of B
 * per epoch the lowest ceiling is about 38 - 3B, so B = 7 keeps every epoch under half of it
 * (7 of 17), leaving room for the paints a user keeps making while the seal runs. (B = 20, half
 * of the first epoch's 40, refuses the first paint of every third epoch.) A Writer's rows reach
 * about 350 before the creator stops admitting them and cost the creator's image little; the
 * shipped page joins only as a receive-only observer, so the creator's own count is what binds.
 * Paints come in bursts of clicks, so an epoch is also closed 10 s after the last paint: the next
 * burst starts in a fresh epoch and the budget rarely triggers mid-burst.
 */
export const CANVAS_ROLLOVER_BUDGET: V3RoomRolloverBudget = Object.freeze({
	movesPerAuthor: 7,
	idleMs: 10_000,
});
