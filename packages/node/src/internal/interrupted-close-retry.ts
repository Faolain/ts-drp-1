// The creator session's own retry of its interrupted epoch close.
//
// A close that died before adopting (found on reopen or at genesis binding) or
// failed in process after staging holds every ordinary admission with the
// close-pending gate until it adopts. No host has to seal again: the session
// retries that close itself, in a background host turn (foreground issue
// drains keep priority), never more than one retry in flight, with bounded
// exponential backoff after each failure. The retry is the same close as a
// manual one, so it runs on the exact durable scope and incarnation.

import { runInBackgroundLane } from "./cooperative-work.js";

/** First backoff after a failed close (the first retry after reopen runs at once). */
export const INTERRUPTED_CLOSE_RETRY_BASE_MS = 250;
/** Backoff ceiling: a close that keeps failing is retried at least this often. */
export const INTERRUPTED_CLOSE_RETRY_MAX_MS = 30_000;

/**
 * Delay before the next retry after `failures` consecutive failed closes.
 * @param failures - Consecutive failed closes (manual or own).
 * @returns Milliseconds.
 */
export function interruptedCloseRetryDelay(failures: number): number {
	if (failures <= 0) return 0;
	return Math.min(INTERRUPTED_CLOSE_RETRY_MAX_MS, INTERRUPTED_CLOSE_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 30));
}

export interface InterruptedCloseRetryInput {
	/** The current creator plane holds an interrupted close (its gate is set) and the session is open. */
	pending(): boolean;
	/** One retry: complete the close (unless already sealed) and adopt its successor. */
	retry(): Promise<void>;
	setTimer(callback: () => void, milliseconds: number): unknown;
	clearTimer(handle: unknown): void;
}

export interface InterruptedCloseRetry {
	/** Schedule a retry if one is due; `failed` counts a failed manual close toward the backoff. */
	kick(failed?: boolean): void;
	/** A manual close takes over: drop a retry that has not started. */
	cancelPending(): void;
	stop(): void;
}

/**
 * Starts the session's own interrupted-close retry. Nothing runs until kicked.
 * @param input - Session ports.
 * @returns The scheduler.
 */
export function startInterruptedCloseRetry(input: InterruptedCloseRetryInput): InterruptedCloseRetry {
	let failures = 0;
	let timer: unknown;
	let inFlight = false;
	let stopped = false;
	const cancelPending = (): void => {
		if (timer === undefined) return;
		input.clearTimer(timer);
		timer = undefined;
	};
	const fire = (): void => {
		timer = undefined;
		if (stopped || inFlight || !input.pending()) return;
		inFlight = true;
		void runInBackgroundLane(async (): Promise<boolean> => {
			// A background turn: recheck currency first.
			if (stopped || !input.pending()) return false;
			await input.retry();
			return true;
		})
			.then(
				(ran) => {
					// Adopted: the gate retired with the closed registration. Still
					// pending after a completed retry counts as a failure (no spin).
					if (ran) failures = input.pending() ? failures + 1 : 0;
				},
				() => {
					failures++;
				}
			)
			.finally(() => {
				inFlight = false;
				kick();
			});
	};
	const kick = (failed = false): void => {
		if (failed) failures++;
		if (stopped || inFlight || timer !== undefined || !input.pending()) return;
		timer = input.setTimer(fire, interruptedCloseRetryDelay(failures));
	};
	return Object.freeze({
		kick,
		cancelPending,
		stop: (): void => {
			stopped = true;
			cancelPending();
		},
	});
}
