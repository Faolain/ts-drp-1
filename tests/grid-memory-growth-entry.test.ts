import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

import { gridMemoryCapturePlan } from "./fixtures/grid-memory-profiler.js";

const entry = readFileSync(new URL("./phase-6b-grid-30-transition-attribution.test.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(entry, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(target?: string, failIdle = false): { run(): Promise<void>; events: string[] } {
	const events: string[] = [];
	let registered: (() => Promise<void>) | undefined;
	const ready = (phase: { terminalAccounting: boolean }): Promise<void> => {
		expect(phase.terminalAccounting).toBe(true);
		events.push("post-reopen-ready");
		return Promise.resolve();
	};
	const profiler = {
		checkpoint: async (): Promise<void> => {},
		observeIdle: (): Promise<void> => {
			events.push("idle");
			return failIdle ? Promise.reject(new Error("ENTRY_IDLE_FAILURE")) : Promise.resolve();
		},
		finish: (): void => {
			events.push("finish");
		},
		close: (): Promise<void> => {
			events.push("close");
			return Promise.resolve();
		},
	};
	const dependencies: Record<string, unknown> = {
		"vitest": {
			it: {
				runIf:
					(enabled: boolean) =>
					(_title: string, fn: () => Promise<void>): void => {
						expect(enabled).toBe(true);
						registered = fn;
					},
			},
		},
		"./fixtures/grid-room-workload.js": { waitForGridStartupForDiagnostics: ready },
		"./fixtures/grid-transition-workload.js": {
			runGridTransitions: async (
				selected: number,
				observer: { prepareCheckpoint: unknown; checkpoint: unknown }
			): Promise<void> => {
				expect(selected).toBe(target === undefined ? 30 : Number(target));
				expect(observer.prepareCheckpoint).toBe(ready);
				expect(observer.checkpoint).toBe(profiler.checkpoint);
				events.push("workload-start");
				await Promise.resolve();
				events.push("workload-returned-after-cold-reopen");
			},
		},
		"./fixtures/grid-memory-profiler.js": {
			gridMemoryCapturePlan,
			createGridMemoryProfiler: (options: unknown): typeof profiler => {
				expect(options).toMatchObject({
					targetTransitions: target === undefined ? 30 : Number(target),
					allocationMode: "none",
				});
				events.push("create");
				return profiler;
			},
		},
	};
	runInNewContext(compiled, {
		exports: {},
		console,
		process: {
			env: {
				TS_DRP_GRID30_MEMORY_ATTRIBUTION: "1",
				TS_DRP_GRID_MEMORY_TRANSITIONS: target,
				TS_DRP_GRID_MEMORY_OUTPUT: "synthetic-output",
			},
		},
		require: (name: string): unknown => {
			if (!(name in dependencies)) throw new Error(`UNEXPECTED_ENTRY_DEPENDENCY:${name}`);
			return dependencies[name];
		},
	});
	return {
		events,
		run: async (): Promise<void> => {
			if (!registered) throw new Error("ENTRY_NOT_REGISTERED");
			await registered();
		},
	};
}

it("waits for the longer workload and final reopened startup before a distinct idle phase", async () => {
	const fixture = harness("60");
	await fixture.run();
	expect(fixture.events).toEqual([
		"create",
		"workload-start",
		"workload-returned-after-cold-reopen",
		"post-reopen-ready",
		"idle",
		"finish",
		"close",
	]);
});
it("preserves default30 entry ordering without extra post-workload waits", async () => {
	const fixture = harness();
	await fixture.run();
	expect(fixture.events).toEqual([
		"create",
		"workload-start",
		"workload-returned-after-cold-reopen",
		"finish",
		"close",
	]);
});
it("preserves idle failure and closes without publishing successful completion", async () => {
	const fixture = harness("60", true);
	await expect(fixture.run()).rejects.toThrow("ENTRY_IDLE_FAILURE");
	expect(fixture.events.at(-1)).toBe("close");
	expect(fixture.events).not.toContain("finish");
});
it.each(["", "45", "060", "61", "NaN"])("rejects unsupported target %s before creating a profiler", async (target) => {
	const fixture = harness(target);
	await expect(fixture.run()).rejects.toThrow("GRID_MEMORY_CAPTURE_TARGET_REQUIRED");
	expect(fixture.events).toEqual([]);
});
