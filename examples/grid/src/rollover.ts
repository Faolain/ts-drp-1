import type { V3RoomRolloverBudget } from "@ts-drp/example-v3-room";

/**
 * When the shipped Grid zone's creator rolls its room over (the shared scheduling is
 * `createV3RoomRolloverPolicy` in examples/v3-room). Tests import this so they follow the
 * shipped choice.
 *
 * Measured on native SQLite (tests/app-rollover-ceiling-native.test.ts) with the settlement
 * profile: the creator's issuance image holds about 38 of its own durable moves (block placements,
 * trades) across the current epoch and the two before it, and across the three before it at every
 * fourth epoch (a generation turnover: epochs 4, 8, 12...). After epochs of 10 moves a normal epoch
 * admits 19 and a generation epoch 8; after epochs of 7, a generation epoch admits 17. With a
 * budget of B per epoch the lowest ceiling is about 38 - 3B, so B = 7 keeps every epoch under half
 * of it (7 of 17). A Writer's own rows go far higher, so the per-author count of the creator binds
 * first. Movement is ephemeral and never counts. A trade is prepared, approved and committed
 * against one epoch, so a rollover between its steps makes the players prepare it again; the idle
 * period is long enough (30 s) that a trade in progress is not cut by an idle rollover.
 */
export const GRID_ROLLOVER_BUDGET: V3RoomRolloverBudget = Object.freeze({
	movesPerAuthor: 7,
	idleMs: 30_000,
});
