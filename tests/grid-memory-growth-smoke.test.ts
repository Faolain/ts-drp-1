import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createGridMemoryProfiler } from "./fixtures/grid-memory-profiler.js";

it.runIf(process.env.TS_DRP_GRID_MEMORY_GROWTH_SMOKE === "1")(
	"completes the longer capture and real timed idle phase in the actual worker (not grid evidence)",
	async () => {
		const directory = process.env.TS_DRP_GRID_MEMORY_OUTPUT;
		if (!directory) throw new Error("GROWTH_SMOKE_OUTPUT_REQUIRED");
		const profiler = createGridMemoryProfiler({ directory, targetTransitions: 60 });
		try {
			for (let transitions = 1; transitions <= 60; transitions++) {
				await profiler.checkpoint({
					epoch: transitions - 1,
					transitions,
					terminalAccounting: false,
					objectId: "synthetic-growth-smoke-not-grid",
					databaseNames: [],
					owners: { synthetic: 1 },
				});
			}
			await profiler.checkpoint({
				epoch: 60,
				transitions: 60,
				terminalAccounting: true,
				objectId: "synthetic-growth-smoke-not-grid",
				databaseNames: [],
				owners: { synthetic: 1 },
			});
			await profiler.observeIdle();
			profiler.finish();
		} finally {
			await profiler.close();
		}
		const rows: {
			kind: string;
			transitions?: number;
			sha256?: string;
			elapsedMs?: number;
			requestedDelayMs?: number;
			finished?: boolean;
		}[] = readFileSync(join(directory, "telemetry.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows.filter((r) => r.kind === "snapshot-complete").map((r) => r.transitions)).toEqual([10, 30, 45, 60]);
		for (const row of rows.filter((r) => r.kind === "snapshot-complete")) {
			const path = join(directory, `transition-${row.transitions}.heapsnapshot`);
			expect(statSync(path).size).toBeGreaterThan(100_000);
			expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(row.sha256);
		}
		const idle = rows.filter((r) => r.kind === "idle-memory");
		expect(idle.map((r) => r.requestedDelayMs)).toEqual([0, 1000, 5000, 15000]);
		for (const row of idle) expect(row.elapsedMs).toBeGreaterThanOrEqual(row.requestedDelayMs ?? Infinity);
		expect(rows.find((r) => r.kind === "profiler-closed")?.finished).toBe(true);
		expect(rows.filter((r) => r.kind.startsWith("allocation-"))).toEqual([]);
	},
	90_000
);
