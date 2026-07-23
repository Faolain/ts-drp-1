import type { Clock } from "./kernel.js";

interface ScheduledTimer {
	atMs: number;
	callback(): void;
	id: number;
}

/** Deterministic clock whose timers advance only when the test asks. */
export class ManualClock implements Clock {
	#nextId = 1;
	#nowMs = 0;
	readonly #timers = new Map<number, ScheduledTimer>();

	/**
	 * Cancels a virtual timer.
	 * @param handle - Handle returned by setTimer.
	 */
	clearTimer(handle: unknown): void {
		if (typeof handle === "number") this.#timers.delete(handle);
	}

	/**
	 * Reads virtual time.
	 * @returns Current virtual milliseconds.
	 */
	now(): number {
		return this.#nowMs;
	}

	/**
	 * Schedules a virtual callback.
	 * @param callback - Timer callback.
	 * @param delayMs - Nonnegative delay.
	 * @returns Numeric timer handle.
	 */
	setTimer(callback: () => void, delayMs: number): unknown {
		const id = this.#nextId;
		this.#nextId += 1;
		this.#timers.set(id, { atMs: this.#nowMs + Math.max(0, delayMs), callback, id });
		return id;
	}

	/**
	 * Sleeps in virtual time until elapsed or aborted.
	 * @param delayMs - Nonnegative delay.
	 * @param signal - Cancellation signal.
	 * @returns Completion promise.
	 */
	sleep(delayMs: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const finish = (): void => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
			const id = this.setTimer(finish, delayMs);
			const onAbort = (): void => {
				this.clearTimer(id);
				signal.removeEventListener("abort", onAbort);
				reject(new Error("manual-clock sleep aborted"));
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * Advances time and runs every due timer in stable deadline/id order.
	 * @param deltaMs - Nonnegative virtual duration.
	 */
	advanceBy(deltaMs: number): void {
		if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new Error("manual clock delta must be nonnegative");
		const target = this.#nowMs + deltaMs;
		while (true) {
			const next = [...this.#timers.values()]
				.filter((timer) => timer.atMs <= target)
				.sort((left, right) => left.atMs - right.atMs || left.id - right.id)[0];
			if (next === undefined) break;
			this.#timers.delete(next.id);
			this.#nowMs = next.atMs;
			next.callback();
		}
		this.#nowMs = target;
	}

	/**
	 * Reports scheduled work so leak assertions do not inspect clock internals.
	 * @returns Active timer count.
	 */
	pendingTimerCount(): number {
		return this.#timers.size;
	}

	/**
	 * Advances exactly to the next scheduled timer.
	 * @returns Whether a timer was available.
	 */
	advanceToNext(): boolean {
		const next = [...this.#timers.values()].sort((left, right) => left.atMs - right.atMs || left.id - right.id)[0];
		if (next === undefined) return false;
		this.advanceBy(next.atMs - this.#nowMs);
		return true;
	}
}
