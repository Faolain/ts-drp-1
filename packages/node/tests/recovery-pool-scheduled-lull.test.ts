/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers: inferred fixture shapes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreatorRecoveryPoolResult } from "../src/internal/creator-recovery-pool.js";
import { startRecoveryPoolAutoScheduler } from "../src/internal/recovery-pool-auto.js";
import { createScheduledRecoveryPoolLull } from "../src/internal/recovery-pool-scheduled.js";

// Track Z, RED first: the lull the session schedules itself once per epoch on the new
// default (the room database with retention), and how it meets the other lull sources.
// No source may run a second lull in an epoch a lull already settled.

describe("the scheduled recovery-pool lull", () => {
	function bookkeeping(results: CreatorRecoveryPoolResult[] = []) {
		const room = { epoch: 3 as number | undefined };
		const events: Readonly<Record<string, unknown>>[] = [];
		const previous = Reflect.get(globalThis, "__warmProofEvent");
		Reflect.set(globalThis, "__warmProofEvent", (event: Readonly<Record<string, unknown>>) => events.push(event));
		const restore = () => Reflect.set(globalThis, "__warmProofEvent", previous);
		const lull = vi.fn(
			(): Promise<CreatorRecoveryPoolResult> => Promise.resolve(results.shift() ?? { kind: "maintained" })
		);
		const claims: boolean[] = [];
		// The session method: claims synchronously at entry, then runs in its FIFO.
		const runs: Promise<CreatorRecoveryPoolResult>[] = [];
		const request = vi.fn((): Promise<CreatorRecoveryPoolResult> => {
			const scheduled = schedule.claim();
			claims.push(scheduled);
			const run = Promise.resolve().then(() => schedule.run(scheduled, lull));
			runs.push(run);
			return run;
		});
		const schedule = createScheduledRecoveryPoolLull({ epoch: () => room.epoch, request, now: () => 0 });
		return { room, events, restore, lull, request, claims, runs, schedule };
	}

	it("queues one lull per epoch, marked as the scheduled one", async () => {
		const s = bookkeeping();
		try {
			s.schedule.schedule();
			s.schedule.schedule();
			expect(s.request).toHaveBeenCalledTimes(1);
			expect(s.claims).toEqual([true]);
			await Promise.all(s.runs);
			expect(s.schedule.claim()).toBe(false);
			s.room.epoch = 4;
			s.schedule.schedule();
			await Promise.all(s.runs);
			expect(s.request).toHaveBeenCalledTimes(2);
			expect(s.lull).toHaveBeenCalledTimes(2);
			expect(s.events.map((event) => [event.kind, event.trigger, event.epoch, event.result])).toEqual([
				["recovery-pool-lull", "scheduled", 3, "maintained"],
				["recovery-pool-lull", "scheduled", 4, "maintained"],
			]);
		} finally {
			s.restore();
		}
	});

	it("answers a later call in a settled epoch with that lull's result, without a second lull", async () => {
		const s = bookkeeping([{ kind: "not-needed" }]);
		try {
			s.schedule.schedule();
			await Promise.all(s.runs);
			const explicit = await s.schedule.run(false, s.lull);
			expect(explicit).toEqual({ kind: "not-needed" });
			expect(s.lull).toHaveBeenCalledTimes(1);
			expect(s.events).toHaveLength(1);
			expect(s.schedule.settled(3)).toBe(true);
			expect(s.schedule.settled(4)).toBe(false);
		} finally {
			s.restore();
		}
	});

	it("does not settle a busy epoch, so a later call runs a real lull", async () => {
		const s = bookkeeping([{ kind: "deferred", reason: "busy" }, { kind: "maintained" }]);
		try {
			s.schedule.schedule();
			await Promise.all(s.runs);
			expect(s.schedule.settled(3)).toBe(false);
			expect(await s.schedule.run(false, s.lull)).toEqual({ kind: "maintained" });
			expect(s.lull).toHaveBeenCalledTimes(2);
			expect(s.events.map((event) => [event.trigger, event.result])).toEqual([
				["scheduled", "deferred:busy"],
				["explicit", "maintained"],
			]);
			expect(s.schedule.settled(3)).toBe(true);
		} finally {
			s.restore();
		}
	});

	it("skips an epoch an earlier explicit lull already settled", async () => {
		const s = bookkeeping();
		try {
			await s.schedule.run(false, s.lull);
			s.schedule.schedule();
			await Promise.all(s.runs);
			expect(s.lull).toHaveBeenCalledTimes(1);
			expect(s.events.map((event) => event.trigger)).toEqual(["explicit"]);
		} finally {
			s.restore();
		}
	});

	it("never rejects into the caller of schedule()", async () => {
		const s = bookkeeping();
		try {
			s.lull.mockRejectedValueOnce(new Error("v3 room session is closed"));
			s.schedule.schedule();
			await Promise.allSettled(s.runs);
			expect(s.events.map((event) => [event.trigger, event.result])).toEqual([["scheduled", "failed"]]);
			expect(s.schedule.settled(3)).toBe(false);
		} finally {
			s.restore();
		}
	});
});

describe("the idle scheduler meets the scheduled lull", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("never calls or reports for an epoch the scheduled lull settled", async () => {
		const room = { epoch: 4, settled: new Set([4]) };
		const outcomes: unknown[] = [];
		const maintain = vi.fn((): Promise<CreatorRecoveryPoolResult> => Promise.resolve({ kind: "maintained" }));
		const handle = startRecoveryPoolAutoScheduler({
			options: { idleMilliseconds: 100, onResult: (outcome) => outcomes.push(outcome) },
			activity: () => [1],
			busy: () => false,
			epoch: () => room.epoch,
			open: () => true,
			settled: (epoch: number) => room.settled.has(epoch),
			maintain,
			now: () => Date.now(),
			setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
			clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
		});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(maintain).not.toHaveBeenCalled();
		expect(outcomes).toEqual([]);
		room.epoch = 5;
		await vi.advanceTimersByTimeAsync(100);
		expect(maintain).toHaveBeenCalledTimes(1);
		handle.stop();
	});
});
