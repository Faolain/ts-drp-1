import "fake-indexeddb/auto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createGridMemoryProfiler } from "./fixtures/grid-memory-profiler.js";

it.runIf(process.env.TS_DRP_GRID_MEMORY_PROFILER_SMOKE === "1")(
	"captures a real worker heap with an empty synthetic workload (not grid evidence)",
	async () => {
		const directory = process.env.TS_DRP_GRID_MEMORY_OUTPUT;
		if (!directory) throw new Error("SMOKE_OUTPUT_REQUIRED");
		const profiler = createGridMemoryProfiler({ directory });
		try {
			for (let transitions = 1; transitions <= 10; transitions++) {
				await profiler.checkpoint({
					epoch: transitions - 1,
					transitions,
					terminalAccounting: false,
					objectId: "synthetic-profiler-smoke-not-grid",
					databaseNames: [],
					owners: { synthetic: 1 },
				});
			}
		} finally {
			profiler.close();
		}
		const records = readFileSync(join(directory, "telemetry.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records.filter((row) => row.kind === "snapshot-complete")).toHaveLength(1);
		expect(records.find((row) => row.kind === "snapshot-complete")).toMatchObject({
			transitions: 10,
			pid: process.pid,
		});
		expect(records.find((row) => row.kind === "worker-identity")).toMatchObject({
			pid: process.pid,
			gcAvailable: true,
		});
		expect(records.some((row) => row.kind === "capture-complete")).toBe(false);
		expect(statSync(join(directory, "transition-10.heapsnapshot")).size).toBeGreaterThan(100_000);
	},
	60_000
);
