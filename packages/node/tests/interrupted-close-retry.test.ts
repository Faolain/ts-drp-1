import { describe, expect, it } from "vitest";

import {
	INTERRUPTED_CLOSE_RETRY_BASE_MS,
	INTERRUPTED_CLOSE_RETRY_MAX_MS,
	interruptedCloseRetryDelay,
	startInterruptedCloseRetry,
} from "../src/internal/interrupted-close-retry.js";

// A manual timer: runs only when advanced, records every requested delay.
function manualTimers(): {
	delays: number[];
	scheduled(): number;
	fire(): void;
	setTimer(callback: () => void, milliseconds: number): unknown;
	clearTimer(handle: unknown): void;
} {
	const timers = new Map<object, () => void>();
	const delays: number[] = [];
	return {
		delays,
		scheduled: (): number => timers.size,
		fire: (): void => {
			const [handle, callback] = [...timers][0] ?? [];
			if (handle === undefined || callback === undefined) throw new Error("no timer");
			timers.delete(handle);
			callback();
		},
		setTimer: (callback: () => void, milliseconds: number): unknown => {
			const handle = {};
			delays.push(milliseconds);
			timers.set(handle, callback);
			return handle;
		},
		clearTimer: (handle: unknown): void => {
			timers.delete(handle as object);
		},
	};
}
const settle = async (): Promise<void> => {
	for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("interrupted creator close retry", () => {
	it("backs off exponentially from the base to the ceiling", () => {
		expect(interruptedCloseRetryDelay(0)).toBe(0);
		expect(interruptedCloseRetryDelay(1)).toBe(INTERRUPTED_CLOSE_RETRY_BASE_MS);
		expect(interruptedCloseRetryDelay(2)).toBe(2 * INTERRUPTED_CLOSE_RETRY_BASE_MS);
		expect(interruptedCloseRetryDelay(3)).toBe(4 * INTERRUPTED_CLOSE_RETRY_BASE_MS);
		expect(interruptedCloseRetryDelay(40)).toBe(INTERRUPTED_CLOSE_RETRY_MAX_MS);
		expect(interruptedCloseRetryDelay(Number.MAX_SAFE_INTEGER)).toBe(INTERRUPTED_CLOSE_RETRY_MAX_MS);
	});

	it("does nothing while no close is interrupted", () => {
		const timers = manualTimers();
		const retry = startInterruptedCloseRetry({ pending: () => false, retry: () => Promise.resolve(), ...timers });
		retry.kick();
		retry.kick(true);
		expect(timers.scheduled()).toBe(0);
	});

	it("retries at once after reopen, backs off after each failure, one retry at a time, and stops once adopted", async () => {
		const timers = manualTimers();
		let pending = true;
		let running = 0;
		let maxRunning = 0;
		let attempts = 0;
		const retry = startInterruptedCloseRetry({
			pending: () => pending,
			retry: async (): Promise<void> => {
				attempts++;
				running++;
				maxRunning = Math.max(maxRunning, running);
				await settle();
				running--;
				if (attempts < 4) throw new Error("close failed");
				pending = false; // adopted: the gate retired
			},
			...timers,
		});
		retry.kick();
		retry.kick();
		expect(timers.scheduled()).toBe(1);
		for (let attempt = 0; attempt < 4; attempt++) {
			timers.fire();
			retry.kick(); // a kick while a retry is in flight never starts a second one
			expect(timers.scheduled()).toBe(0);
			// Wait (bounded) for the attempt to finish and its follow-up to be scheduled or the loop to end.
			for (let turn = 0; turn < 50 && timers.scheduled() === 0 && !(attempts === 4 && !pending); turn++) await settle();
			if (attempt < 3) expect(timers.scheduled()).toBe(1);
		}
		await settle();
		expect(attempts).toBe(4);
		expect(maxRunning).toBe(1);
		expect(timers.delays).toEqual([
			0,
			INTERRUPTED_CLOSE_RETRY_BASE_MS,
			2 * INTERRUPTED_CLOSE_RETRY_BASE_MS,
			4 * INTERRUPTED_CLOSE_RETRY_BASE_MS,
		]);
		expect(timers.scheduled()).toBe(0);
	});

	it("counts a failed manual close, yields a scheduled retry to a manual one, and stops", () => {
		const timers = manualTimers();
		const retry = startInterruptedCloseRetry({ pending: () => true, retry: () => Promise.resolve(), ...timers });
		retry.kick(true);
		expect(timers.delays).toEqual([INTERRUPTED_CLOSE_RETRY_BASE_MS]);
		retry.cancelPending();
		expect(timers.scheduled()).toBe(0);
		retry.kick(true);
		expect(timers.delays.at(-1)).toBe(2 * INTERRUPTED_CLOSE_RETRY_BASE_MS);
		retry.stop();
		expect(timers.scheduled()).toBe(0);
		retry.kick();
		expect(timers.scheduled()).toBe(0);
	});

	it("counts a completed retry that leaves the close interrupted as a failure (no spin)", async () => {
		const timers = manualTimers();
		const retry = startInterruptedCloseRetry({ pending: () => true, retry: () => Promise.resolve(), ...timers });
		retry.kick();
		timers.fire();
		await settle();
		expect(timers.delays).toEqual([0, INTERRUPTED_CLOSE_RETRY_BASE_MS]);
		retry.stop();
	});
});
