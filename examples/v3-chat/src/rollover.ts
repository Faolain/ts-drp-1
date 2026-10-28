import type { V3RoomRolloverBudget } from "@ts-drp/example-v3-room";

/**
 * When the v3-chat demo's creator rolls its room over (the shared scheduling is
 * `createV3RoomRolloverPolicy` in examples/v3-room). Tests import this so they follow the demo's
 * choice.
 *
 * The demo signs no per-checkpoint allowance (it has no shares format), so the native ceilings
 * bind, and the creator's own issuance image binds first: measured on native SQLite for Canvas
 * (tests/app-rollover-ceiling-native.test.ts), the image holds about 38 of the creator's own small
 * moves across the current epoch and the two or three before it, so a budget of B per epoch
 * leaves a lowest ceiling of about 38 - 3B. A demo message is one small move, as a paint is, so
 * the demo takes Canvas's B = 7, half of the lowest ceiling, which leaves room for the messages a
 * user keeps sending while the seal runs. A move refused at the ceiling anyway makes the creator
 * roll over at once and offer it again. Messages are human-paced, so an epoch is also closed 15 s
 * after the last message, as the shipped Chat does.
 */
export const V3_CHAT_ROLLOVER_BUDGET: V3RoomRolloverBudget = Object.freeze({
	movesPerAuthor: 7,
	idleMs: 15_000,
});
