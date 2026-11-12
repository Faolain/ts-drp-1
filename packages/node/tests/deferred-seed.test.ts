import { describe, expect, it } from "vitest";

import { createDeferredSeedRunner, type DeferredSeedStats } from "../src/internal/deferred-seed.js";

// The live plane seeds its application state bound after each machine install with this runner: the
// seed runs in short host turns (never in the install turn), a newer install's seed abandons an
// unfinished older one and restarts from the new base, and a seed whose plane moved on is discarded.

/** A manual host: turns run only when the test pumps them; the clock advances by each step's cost. */
function host() {
	const queue: (() => void)[] = [];
	let clock = 0;
	return {
		schedule: (turn: () => void) => void queue.push(turn),
		now: () => clock,
		spend: (ms: number) => void (clock += ms),
		pending: () => queue.length,
		pump(): boolean {
			const turn = queue.shift();
			if (turn === undefined) return false;
			turn();
			return true;
		},
		drain(): number {
			let turns = 0;
			while (this.pump()) turns++;
			return turns;
		},
	};
}

/** A seed over `bytes` base bytes that costs `msPerByte` per byte stepped; finishes with `result`. */
function seedOver(clock: ReturnType<typeof host>, bytes: number, msPerByte: number, result: string, log: string[]) {
	let walked = 0;
	return {
		step(budget: number): boolean {
			const take = Math.min(budget, bytes - walked);
			walked += take;
			clock.spend(take * msPerByte);
			log.push(`${result}:${walked}`);
			return walked === bytes;
		},
		finish: () => result,
	};
}

describe("deferred seed runner", () => {
	it("runs a seed in turns of at most the turn budget plus one step, after the caller's turn", () => {
		const clock = host();
		const runner = createDeferredSeedRunner<object, string>({ ...clock, turnMs: 0.5, stepBytes: 512 });
		const owner = {};
		const log: string[] = [];
		const results: [string | undefined, DeferredSeedStats][] = [];
		let started = 0;
		runner.begin(owner, {
			start: () => (started++, seedOver(clock, 32_768, 0.0001, "base-1", log)),
			current: () => true,
			done: (result, stats) => void results.push([result, stats]),
		});
		expect(started, "nothing runs in the caller's (install) turn").toBe(0);
		expect(runner.pending(owner)).toBe(true);
		const turns = clock.drain();
		expect(started).toBe(1);
		expect(results).toHaveLength(1);
		const [result, stats] = results[0]!;
		expect(result).toBe("base-1");
		expect(stats.turns).toBe(turns);
		expect(turns).toBeGreaterThan(5);
		// 512 bytes cost 0.0512 ms: a turn stops at the first step past 0.5 ms.
		expect(stats.maxTurnUs).toBeLessThanOrEqual(500 + 52);
		expect(runner.pending(owner)).toBe(false);
	});

	it("a seed interrupted by the next install is discarded and restarts from the new base", () => {
		const clock = host();
		const runner = createDeferredSeedRunner<object, string>({ ...clock, turnMs: 0.5, stepBytes: 512 });
		const owner = {};
		const log: string[] = [];
		const results: (string | undefined)[] = [];
		const discarded: DeferredSeedStats[] = [];
		let base = "base-1";
		const install = (name: string) => {
			base = name;
			runner.begin(owner, {
				start: () => seedOver(clock, 32_768, 0.0001, name, log),
				current: () => base === name,
				done: (result) => void results.push(result),
				discarded: (stats) => void discarded.push(stats),
			});
		};
		install("base-1");
		clock.pump();
		clock.pump();
		expect(results).toEqual([]);
		expect(log.some((entry) => entry.startsWith("base-1:"))).toBe(true);
		install("base-2");
		expect(discarded).toHaveLength(1);
		expect(discarded[0]!.turns).toBe(2);
		const before = log.length;
		clock.drain();
		expect(results, "only the new base's seed delivers").toEqual(["base-2"]);
		expect(log.slice(before).every((entry) => entry.startsWith("base-2:")), "the old seed never steps again").toBe(true);
		expect(log.slice(before)[0], "the new seed starts from the new base's first byte").toBe("base-2:512");
	});

	it("a seed whose owner moved on without a new seed is discarded, never delivered", () => {
		const clock = host();
		const runner = createDeferredSeedRunner<object, string>({ ...clock, turnMs: 0.5, stepBytes: 512 });
		const owner = {};
		let current = true;
		const results: (string | undefined)[] = [];
		const discarded: DeferredSeedStats[] = [];
		runner.begin(owner, {
			start: () => seedOver(clock, 32_768, 0.0001, "base-1", []),
			current: () => current,
			done: (result) => void results.push(result),
			discarded: (stats) => void discarded.push(stats),
		});
		clock.pump();
		current = false;
		clock.drain();
		expect(results).toEqual([]);
		expect(discarded).toHaveLength(1);
	});

	it("a refusing seed delivers undefined once; a cancelled seed delivers nothing", () => {
		const clock = host();
		const runner = createDeferredSeedRunner<object, string>({ ...clock, turnMs: 0.5, stepBytes: 512 });
		const refusing = {};
		const results: (string | undefined)[] = [];
		runner.begin(refusing, {
			start: () => ({
				step: () => {
					throw new TypeError("refused base");
				},
				finish: () => "never",
			}),
			current: () => true,
			done: (result) => void results.push(result),
		});
		clock.drain();
		expect(results).toEqual([undefined]);
		const cancelled = {};
		runner.begin(cancelled, {
			start: () => seedOver(clock, 4096, 0.0001, "base-1", []),
			current: () => true,
			done: (result) => void results.push(result),
		});
		expect(runner.cancel(cancelled)).toBe(true);
		expect(runner.cancel(cancelled)).toBe(false);
		clock.drain();
		expect(results).toEqual([undefined]);
	});
});
