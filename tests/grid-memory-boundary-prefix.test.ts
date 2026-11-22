import { expect, it } from "vitest";

// The shared runner installs its normal beforeEach/afterEach room cleanup.
import { type GridTransitionCheckpoint, runGridTransitions } from "./fixtures/grid-transition-workload.js";

async function profilerGcOnly(): Promise<void> {
	const gc = globalThis.gc;
	if (gc === undefined) throw new Error("BOUNDARY_PREFIX_REQUIRES_EXPOSED_GC");
	for (let turn = 0; turn < 3; turn += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		gc();
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function censusOnly(checkpoint: GridTransitionCheckpoint): Promise<void> {
	const { censusGridStorage } = await import("./fixtures/grid-memory-storage-census.js");
	await censusGridStorage({
		factory: indexedDB,
		databaseNames: checkpoint.databaseNames,
		currentEpoch: checkpoint.epoch + 1,
		now: Date.now(),
	});
}

async function startupOnly(checkpoint: GridTransitionCheckpoint): Promise<void> {
	const { observed, record, required, sessions } = await import("./fixtures/grid-room-workload.js");
	const { waitForV3RoomStartupForDiagnostics } = await import("../examples/v3-room/src/index.js");
	const { readV3RuntimeOwnerCensus } = await import("../packages/node/src/v3-live.js");
	expect(sessions.size, "BOUNDARY_STARTUP_ALL_64_NATURAL_ROOM_OWNERS").toBe(64);
	await Promise.all([...sessions].map((session) => waitForV3RoomStartupForDiagnostics(session)));
	// Inspect immediately: a resolved publisher startup is not assumed to imply
	// that all queued creator ingress has completed authenticated admission.
	const creators = [...observed.planes.entries()].filter(([databaseName]) => databaseName.endsWith("peer-0"));
	expect(creators, "BOUNDARY_ONE_NATURAL_CREATOR_PLANE").toHaveLength(1);
	const creator = required(creators[0])[1];
	expect(readV3RuntimeOwnerCensus(creator), "BOUNDARY_STARTUP_MUST_LEAVE_ALL_64_FENCES_ADMITTED").toMatchObject({
		active: 1,
		terminal: 0,
		pendingIngress: 0,
		controlVertices: 64,
	});
	const fences = observed.commits.filter(
		(commit) =>
			commit.planEffect?.kind === "fence" &&
			record(commit.envelope.canonicalPreimageBytes).epoch === checkpoint.epoch + 1
	);
	expect(fences, "BOUNDARY_64_CURRENT_EPOCH_SIGNED_FENCE_COMMITS").toHaveLength(64);
	expect(new Set(fences.map((commit) => commit.issuedRecord.scope.author)).size).toBe(64);
}

it.runIf(process.env.TS_DRP_GRID_MEMORY_BOUNDARY_PREFIX === "1")(
	"diagnostic: unchanged 64-writer workload reaches two genuine transitions with selected boundary observation",
	async () => {
		expect(globalThis.gc, "BOUNDARY_PREFIX_REQUIRES_EXPOSED_GC").toBeTypeOf("function");
		const mode = process.env.TS_DRP_GRID_MEMORY_BOUNDARY_MODE ?? "noop";
		if (
			mode !== "noop" &&
			mode !== "gc-only" &&
			mode !== "census-only" &&
			mode !== "startup-only" &&
			mode !== "settled-census" &&
			mode !== "integrated"
		) {
			throw new Error(`GRID_MEMORY_BOUNDARY_MODE_INVALID:${mode}`);
		}
		// Match initial profiler module loading in every fresh-worker mode,
		// including noop, without constructing a profiler or capturing snapshots.
		await import("./fixtures/grid-memory-profiler.js");
		const { waitForGridStartupForDiagnostics } = await import("./fixtures/grid-room-workload.js");
		const reachedBoundary = new Error("GRID_MEMORY_BOUNDARY_PREFIX_REACHED_TRANSITION_2");
		// Keep the workload target unchanged. Stop at the second checkpoint
		// before any further observation, distinguishing it from every failure.
		await expect(
			runGridTransitions(30, {
				...(mode === "integrated" ? { prepareCheckpoint: waitForGridStartupForDiagnostics } : {}),
				checkpoint: async (checkpoint): Promise<void> => {
					if (mode === "integrated") {
						expect(checkpoint.owners, "INTEGRATED_PREPARE_MUST_PRECEDE_FRESH_OWNER_SCALARS").toMatchObject({
							runtimePlanesMeasured: 64,
							runtime_pendingIngress: 0,
							runtime_active: 64,
							runtime_terminal: 0,
						});
					}
					if (checkpoint.transitions === 2) throw reachedBoundary;
					if (mode === "gc-only") await profilerGcOnly();
					if (mode === "startup-only" || mode === "settled-census") await startupOnly(checkpoint);
					if (mode === "census-only" || mode === "settled-census" || mode === "integrated") {
						await censusOnly(checkpoint);
					}
				},
			})
		).rejects.toBe(reachedBoundary);
	},
	180_000
);
