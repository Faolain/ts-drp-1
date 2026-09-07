import { it } from "vitest";

import { waitForGridStartupForDiagnostics } from "./fixtures/grid-room-workload.js";
import { runGridTransitions } from "./fixtures/grid-transition-workload.js";

it.runIf(process.env.TS_DRP_GRID30_MEMORY_ATTRIBUTION === "1")(
	"diagnostic: 64 active grid writers across 30 genuine same-room transitions",
	async () => {
		// Install the workload's module observers before loading census/profiling dependencies.
		const { createGridMemoryProfiler } = await import("./fixtures/grid-memory-profiler.js");
		const directory = process.env.TS_DRP_GRID_MEMORY_OUTPUT;
		if (directory === undefined || directory.length === 0) throw new Error("GRID_MEMORY_OUTPUT_REQUIRED");
		const profiler = createGridMemoryProfiler({ directory });
		try {
			await runGridTransitions(30, {
				prepareCheckpoint: waitForGridStartupForDiagnostics,
				checkpoint: profiler.checkpoint,
			});
			profiler.finish();
		} catch (error) {
			try {
				profiler.close();
			} catch {
				// Preserve the workload/capture failure over secondary cleanup errors.
			}
			throw error;
		}
		profiler.close();
	},
	3_500_000
);
