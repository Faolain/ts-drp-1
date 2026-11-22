import { it } from "vitest";

import { waitForGridStartupForDiagnostics } from "./fixtures/grid-room-workload.js";
import { runGridTransitions } from "./fixtures/grid-transition-workload.js";

it.runIf(process.env.TS_DRP_GRID30_MEMORY_ATTRIBUTION === "1")(
	"diagnostic: 64 active grid writers across configured genuine same-room transitions",
	async () => {
		// Install the workload's module observers before loading census/profiling dependencies.
		const { createGridMemoryProfiler, gridMemoryCapturePlan } = await import("./fixtures/grid-memory-profiler.js");
		const requestedTarget = process.env.TS_DRP_GRID_MEMORY_TRANSITIONS ?? "30";
		if (requestedTarget !== "30" && requestedTarget !== "60") throw new Error("GRID_MEMORY_CAPTURE_TARGET_REQUIRED");
		const plan = gridMemoryCapturePlan(Number(requestedTarget));
		const directory = process.env.TS_DRP_GRID_MEMORY_OUTPUT;
		if (directory === undefined || directory.length === 0) throw new Error("GRID_MEMORY_OUTPUT_REQUIRED");
		const allocationMode = process.env.TS_DRP_GRID_MEMORY_ALLOCATION_MODE ?? "none";
		if (allocationMode !== "none" && allocationMode !== "tracking" && allocationMode !== "sampling")
			throw new Error("GRID_MEMORY_ALLOCATION_MODE_REQUIRED");
		const profiler = createGridMemoryProfiler({
			directory,
			allocationMode,
			targetTransitions: plan.targetTransitions,
		});
		try {
			await runGridTransitions(plan.targetTransitions, {
				prepareCheckpoint: waitForGridStartupForDiagnostics,
				checkpoint: profiler.checkpoint,
			});
			if (plan.idleDelaysMs.length > 0) {
				// Final cold reopen happens after terminal accounting; join its existing startup before idle samples.
				await waitForGridStartupForDiagnostics({ terminalAccounting: true });
				await profiler.observeIdle();
			}
			profiler.finish();
		} catch (error) {
			try {
				await profiler.close();
			} catch (cleanupError) {
				// Preserve the workload/capture failure over secondary cleanup errors.
				console.error("GRID_MEMORY_SECONDARY_CLEANUP_FAILURE", String(cleanupError));
			}
			throw error;
		}
		await profiler.close();
	},
	3_500_000
);
