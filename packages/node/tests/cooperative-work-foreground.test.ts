import { afterEach, describe, expect, it } from "vitest";

import * as cooperativeWork from "../src/internal/cooperative-work.js";

const { createWorkCheckpoint, yieldToHost } = cooperativeWork;
// Read through the namespace so a missing export fails the case, not the suite.
const beginForegroundWork = (): (() => void) => cooperativeWork.beginForegroundWork();
const runInBackgroundLane = <T>(work: () => Promise<T>): Promise<T> => cooperativeWork.runInBackgroundLane(work);

const releases: (() => void)[] = [];
afterEach(() => {
	for (const release of releases.splice(0)) release();
});
function foreground(): () => void {
	const release = beginForegroundWork();
	releases.push(release);
	return release;
}
function busy(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until);
}
/**
 * Foreground that keeps running: 4 ms spans, each followed by a host turn.
 * @param ms - How long to keep running.
 * @param resumed - Stops early once this holds.
 * @returns Host turns taken.
 */
async function progressFor(ms: number, resumed: () => boolean): Promise<number> {
	const started = performance.now();
	let turns = 0;
	while (performance.now() - started < ms && !resumed()) {
		busy(4);
		await yieldToHost();
		turns++;
	}
	return turns;
}
type Tracked = {
	state: { resumedAt: number | undefined; started: number };
	done: Promise<void>;
	resumed(): boolean;
};
/**
 * A walk that is only its entry: exactly one background host turn.
 * @returns Completion of that turn.
 */
function backgroundTurn(): Promise<void> {
	return runInBackgroundLane(() => Promise.resolve());
}
function track(turn: Promise<void>): Tracked {
	const state = { resumedAt: undefined as number | undefined, started: performance.now() };
	const done = turn.then(() => {
		state.resumedAt = performance.now() - state.started;
	});
	return { state, done, resumed: (): boolean => state.resumedAt !== undefined };
}

describe("host-level foreground priority", () => {
	it("defers a background host turn while foreground work runs, and resumes it when that work ends", async () => {
		const release = foreground();
		const background = track(backgroundTurn());
		const turns = await progressFor(250, background.resumed);
		expect(turns).toBeGreaterThan(5);
		expect(background.resumed()).toBe(false);
		release();
		await background.done;
		expect(background.state.resumedAt).toBeGreaterThanOrEqual(250);
	});

	it("never defers foreground or unclassified host turns", async () => {
		foreground();
		const background = track(backgroundTurn());
		const started = performance.now();
		for (let turn = 0; turn < 20; turn++) await yieldToHost();
		const checkpoint = createWorkCheckpoint();
		busy(9);
		await checkpoint();
		// A deferred turn waits at least one idle window; 21 of them would take > 1 s.
		expect(performance.now() - started).toBeLessThan(10 * BACKGROUND_IDLE_WINDOW());
		expect(background.resumed()).toBe(false);
	});

	it("carries the lane of the walk that created a checkpoint", async () => {
		const checkpoint = await runInBackgroundLane(() => Promise.resolve(createWorkCheckpoint()));
		const release = foreground();
		busy(9);
		const background = track(checkpoint() ?? Promise.reject(new Error("budget did not expire")));
		await progressFor(150, background.resumed);
		expect(background.resumed()).toBe(false);
		release();
		await background.done;
	});

	it("waits only for the foreground cohort it found, not for later foreground work", async () => {
		const first = foreground();
		const background = track(backgroundTurn());
		// The cohort is the foreground registered when the background turn defers.
		await yieldToHost();
		await yieldToHost();
		foreground();
		await progressFor(100, background.resumed);
		expect(background.resumed()).toBe(false);
		first();
		await progressFor(200, background.resumed);
		expect(background.resumed()).toBe(true);
	});

	it("resumes after one idle window when registered foreground makes no host-turn progress", async () => {
		foreground();
		const background = track(backgroundTurn());
		// A foreground that waits on something other than a host turn, or one that
		// is itself the misclassified waiter, makes no progress while the host turns.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(background.resumed()).toBe(true);
		expect(background.state.resumedAt).toBeGreaterThanOrEqual(BACKGROUND_IDLE_WINDOW() - 5);
		expect(background.state.resumedAt).toBeLessThan(3 * BACKGROUND_IDLE_WINDOW() + 50);
	});

	it("bounds one deferral even while foreground keeps progressing", async () => {
		foreground();
		const background = track(backgroundTurn());
		await progressFor(cooperativeWork.BACKGROUND_DEFERRAL_BOUND_MS + 1_000, background.resumed);
		expect(background.resumed()).toBe(true);
		expect(background.state.resumedAt).toBeGreaterThanOrEqual(cooperativeWork.BACKGROUND_DEFERRAL_BOUND_MS - 5);
		expect(background.state.resumedAt).toBeLessThan(cooperativeWork.BACKGROUND_DEFERRAL_BOUND_MS + 500);
	});

	it("restores the background lane after a deferred turn", async () => {
		const release = foreground();
		let second: Promise<void> | undefined;
		const background = track(
			runInBackgroundLane(async () => {
				await yieldToHost();
				second = yieldToHost();
			})
		);
		release();
		await background.done;
		// The resumed walk was background again: its next turn defers behind new foreground.
		foreground();
		const next = track(second ?? Promise.reject(new Error("walk did not resume")));
		await progressFor(150, next.resumed);
		expect(next.resumed()).toBe(false);
	});

	it("leaves no lane on code awaiting a walk or running after the walk's drain", async () => {
		let later: Tracked | undefined;
		await runInBackgroundLane(async () => {
			await yieldToHost();
			// Runs in a task after this resumed drain ended without a host turn of ours.
			setImmediate(() => {
				later = track(yieldToHost());
				foreground();
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		const after = track(yieldToHost());
		foreground();
		await progressFor(150, () => after.resumed() && later?.resumed() === true);
		expect(after.resumed()).toBe(true);
		expect(later?.resumed()).toBe(true);
	});

	it("completes a background walk under back-to-back foreground that never leaves the host unregistered", async () => {
		// Rollover windows (or issue drains) back to back: each next registration starts before
		// the previous one releases, and every segment keeps turning, so neither the idle window
		// nor the hard bound resumes the walk. A deferred turn waits only for the cohort it
		// found, so each released segment admits one more walk turn: STEPS turns finish within
		// STEPS + 1 segments. Counted in segments, not time.
		const STEPS = 8;
		let turns = 0;
		const walk = runInBackgroundLane(async () => {
			while (turns < STEPS) {
				turns++;
				await yieldToHost();
			}
		});
		let done = false;
		void walk.then(() => {
			done = true;
		});
		let segments = 0;
		let current = foreground();
		while (!done && segments < 4 * STEPS) {
			for (let turn = 0; turn < 3; turn++) {
				busy(2);
				await yieldToHost();
			}
			const next = foreground();
			current();
			current = next;
			segments++;
		}
		current();
		await walk;
		expect(turns).toBe(STEPS);
		expect(segments).toBeLessThanOrEqual(STEPS + 1);
	});

	it("does not defer background work when no foreground work is registered", async () => {
		const started = performance.now();
		await backgroundTurn();
		expect(performance.now() - started).toBeLessThan(BACKGROUND_IDLE_WINDOW());
	});
});

function BACKGROUND_IDLE_WINDOW(): number {
	return cooperativeWork.BACKGROUND_IDLE_POLLS * cooperativeWork.BACKGROUND_IDLE_POLL_MS;
}
