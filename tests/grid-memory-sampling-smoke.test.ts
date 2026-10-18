import "fake-indexeddb/auto";
import { it } from "vitest";

import { createGridMemoryProfiler } from "./fixtures/grid-memory-profiler.js";

function allocateGridSamplingSmokePopulation(): number[][] {
	return Array.from({ length: 128 }, (_, index) => new Array<number>(4096).fill(index));
}

it.runIf(process.env.TS_DRP_GRID_MEMORY_SAMPLING_SMOKE === "1")(
	"records live allocation samples and drops naturally released samples in the actual worker",
	async () => {
		const directory = process.env.TS_DRP_GRID_MEMORY_OUTPUT;
		if (!directory) throw new Error("SAMPLING_SMOKE_OUTPUT_REQUIRED");
		const profiler = createGridMemoryProfiler({ directory, allocationMode: "sampling" });
		const owner = globalThis as typeof globalThis & { gridSamplingSmokeOwner?: number[][] };
		try {
			for (let transitions = 1; transitions <= 30; transitions++) {
				await profiler.checkpoint({
					epoch: transitions - 1,
					transitions,
					terminalAccounting: false,
					objectId: "synthetic-sampling-control",
					databaseNames: [],
					owners: { synthetic: 1 },
				});
				if (transitions === 10) owner.gridSamplingSmokeOwner = allocateGridSamplingSmokePopulation();
				if (transitions === 20) delete owner.gridSamplingSmokeOwner;
			}
			await profiler.checkpoint({
				epoch: 30,
				transitions: 30,
				terminalAccounting: true,
				objectId: "synthetic-sampling-control",
				databaseNames: [],
				owners: { synthetic: 1 },
			});
			profiler.finish();
		} catch (error) {
			try {
				await profiler.close();
			} catch (secondary) {
				console.error("SAMPLING_SMOKE_SECONDARY_CLEANUP", String(secondary));
			}
			throw error;
		} finally {
			delete owner.gridSamplingSmokeOwner;
		}
		await profiler.close();
	},
	120_000
);
