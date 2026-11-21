// A given-back move the shipped member rollover policy declined (hooks.onDeclined), and the one rule by which
// an application's books may drop a move they once held as accepted.
//
// At the room's application state limit (row 96) a Writer's admission is advisory: its view lacks the
// creator's concurrent moves. A move it admitted (its issue resolved: "accepted") that the creator's cut then
// excludes is replayed at the next install; when the Writer's own admission refuses that replay, row 97 gives
// it back (settlementStatus().undelivered), and the policy offers it again with its record, is refused
// (V3RoomHandBackRefused) and declines it (V3RoomMoveDeclined to hooks.onDeclined). The move is then in no
// replica and never sent again; the application is told only through that hook.

import type { DeclinedMove } from "./long-room-driver.js";

/**
 * The policy's decline as plain data (it crosses a page boundary in browser runs).
 * @param declined - The policy's V3RoomMoveDeclined.
 * @returns The declined move.
 */
export function declinedMove(
	declined: Error & Readonly<{ operation: Readonly<Record<string, unknown>>; epoch: number; reason: string }>
): DeclinedMove {
	const cause = declined.cause;
	return Object.freeze({
		operation: declined.operation,
		name: declined.name,
		reason: declined.reason,
		epoch: declined.epoch,
		cause: cause instanceof Error ? Object.freeze({ name: cause.name, reason: Reflect.get(cause, "reason") }) : null,
	});
}

/**
 * Why a declined move may NOT leave the books, or undefined when it may: it was declined at the room's
 * application state limit (reason "application-state-limit", carrying the room's typed hand-back refusal
 * with that reason), and the converged state has no room for it (adding it passes `limitBytes`). Any other
 * decline, or one the state had room for, is a lost move.
 * @param declined - The declined move.
 * @param stateBytesWith - The converged state's exact canonical bytes with the move's effect added.
 * @param limitBytes - The room's application state limit.
 * @returns The violation, or undefined.
 */
export function stateLimitDeclineViolation(
	declined: DeclinedMove,
	stateBytesWith: (operation: Readonly<Record<string, unknown>>) => number,
	limitBytes: number
): string | undefined {
	if (declined.name !== "V3RoomMoveDeclined") return `not a typed decline: ${declined.name}`;
	if (declined.reason !== "application-state-limit") return `declined for ${declined.reason}`;
	if (declined.cause?.name !== "V3RoomHandBackRefused" || declined.cause.reason !== "application-state-limit")
		return `its cause is not the room's typed hand-back refusal at the limit: ${JSON.stringify(declined.cause)}`;
	const bytes = stateBytesWith(declined.operation);
	if (bytes <= limitBytes) return `the converged state has room for it (${bytes} <= ${limitBytes} bytes)`;
	return undefined;
}
