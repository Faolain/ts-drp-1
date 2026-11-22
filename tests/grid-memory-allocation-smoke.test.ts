import "fake-indexeddb/auto";
import { it } from "vitest";

import { createGridMemoryProfiler } from "./fixtures/grid-memory-profiler.js";

class GridAllocationTraceSmokeMarker {
	readonly payload: number[];
	constructor(value: number) {
		this.payload = new Array<number>(64).fill(value);
	}
}

function allocateGridTraceSmokePopulation(): GridAllocationTraceSmokeMarker[] {
	return Array.from({ length: 64 }, (_, index) => new GridAllocationTraceSmokeMarker(index));
}

it.runIf(process.env.TS_DRP_GRID_MEMORY_ALLOCATION_SMOKE === "1")(
	"captures allocation provenance through the actual worker writer (synthetic, not grid evidence)",
	async () => {
		const directory = process.env.TS_DRP_GRID_MEMORY_OUTPUT;
		if (!directory) throw new Error("ALLOCATION_SMOKE_OUTPUT_REQUIRED");
		const profiler = createGridMemoryProfiler({ directory, allocationMode: "tracking" });
		// The control deliberately owns markers only between snapshots 10 and 20.
		const owner = globalThis as typeof globalThis & { gridAllocationSmokeOwner?: GridAllocationTraceSmokeMarker[] };
		try {
			for (let transitions = 1; transitions <= 30; transitions++) {
				await profiler.checkpoint({
					epoch: transitions - 1,
					transitions,
					terminalAccounting: false,
					objectId: "allocation-trace-synthetic-control-not-grid",
					databaseNames: [],
					owners: { synthetic: 1 },
				});
				if (transitions === 10) owner.gridAllocationSmokeOwner = allocateGridTraceSmokePopulation();
				if (transitions === 20) delete owner.gridAllocationSmokeOwner;
			}
			await profiler.checkpoint({
				epoch: 30,
				transitions: 30,
				terminalAccounting: true,
				objectId: "allocation-trace-synthetic-control-not-grid",
				databaseNames: [],
				owners: { synthetic: 1 },
			});
			profiler.finish();
		} finally {
			delete owner.gridAllocationSmokeOwner;
			await profiler.close();
		}
		// Parse and verify trace-node→function associations offline, outside this worker.
	},
	120_000
);
