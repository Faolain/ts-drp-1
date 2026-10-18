import { IDBFactory } from "fake-indexeddb";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type * as v8 from "node:v8";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createGridMemoryProfiler, type GridMemoryCheckpoint } from "./fixtures/grid-memory-profiler.js";

// Synthetic streams establish lifecycle ordering, not allocation-stack evidence.
const control = vi.hoisted(() => ({
	events: [] as string[],
	posts: [] as { method: string; params: unknown }[],
	failMethod: "",
	failure: new Error("SYNTHETIC_INSPECTOR_FAILURE"),
	onPost: undefined as undefined | ((method: string) => void),
	snapshot: vi.fn(),
	code: {
		code_and_metadata_size: 101,
		bytecode_and_metadata_size: 202,
		external_script_source_size: 303,
		cpu_profiler_metadata_size: 404,
	},
}));
vi.mock("node:v8", async (original) => ({
	...(await original<typeof v8>()),
	getHeapSnapshot: control.snapshot,
	getHeapCodeStatistics: (): typeof control.code => ({ ...control.code }),
}));
vi.mock("./fixtures/grid-memory-storage-census.js", () => ({
	censusGridStorage: (): Promise<never[]> => Promise.resolve([]),
}));
vi.mock("node:inspector", () => ({
	Session: class {
		connect(): void {
			control.events.push("connect");
		}
		disconnect(): void {
			control.events.push("disconnect");
		}
		post(method: string, paramsOrCallback?: unknown, callback?: (error: Error | null, result?: object) => void): void {
			control.events.push(method);
			control.posts.push({ method, params: typeof paramsOrCallback === "function" ? undefined : paramsOrCallback });
			control.onPost?.(method);
			const done = typeof paramsOrCallback === "function" ? (paramsOrCallback as typeof callback) : callback;
			done?.(method === control.failMethod ? control.failure : null, {});
		}
	},
}));
vi.mock("node:inspector/promises", () => ({
	Session: class {
		connect(): void {
			control.events.push("connect");
		}
		disconnect(): void {
			control.events.push("disconnect");
		}
		post(method: string, params?: unknown): Promise<object> {
			control.events.push(method);
			control.posts.push({ method, params });
			control.onPost?.(method);
			if (method === control.failMethod) return Promise.reject(control.failure);
			return Promise.resolve({});
		}
	},
}));

const roots: string[] = [];
interface TelemetryRecord {
	readonly kind: string;
	readonly transitions?: number;
	readonly terminalAccounting?: boolean;
	readonly sha256?: string;
	readonly codeStatistics?: Record<string, number>;
	readonly memory?: { readonly ownedBytes: number; readonly heapUsed: number; readonly arrayBuffers: number };
}
beforeEach(() => {
	control.events.length = 0;
	control.posts.length = 0;
	control.failMethod = "";
	control.onPost = undefined;
	control.snapshot.mockReset().mockImplementation(() => {
		control.events.push("snapshot");
		return Readable.from(["synthetic heap bytes"]);
	});
	vi.stubGlobal("gc", () => undefined);
	vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
	vi.unstubAllGlobals();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(allocationTracking = true): {
	profiler: ReturnType<typeof createGridMemoryProfiler>;
	directory: string;
	records(): TelemetryRecord[];
} {
	const root = mkdtempSync(join(tmpdir(), "grid-allocation-red-"));
	roots.push(root);
	const directory = join(root, "capture");
	// Variable permits the pre-feature baseline to execute and fail behaviorally.
	const options = { directory, allocationMode: allocationTracking ? ("tracking" as const) : ("none" as const) };
	const profiler = createGridMemoryProfiler(options);
	const records = (): TelemetryRecord[] =>
		readFileSync(join(directory, "telemetry.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	return { profiler, directory, records };
}
function checkpoint(transitions: number, terminalAccounting = false): GridMemoryCheckpoint {
	return {
		epoch: transitions - (terminalAccounting ? 0 : 1),
		transitions,
		terminalAccounting,
		objectId: "synthetic-allocation-test",
		databaseNames: [],
		owners: { live: 1 },
	};
}
async function advance(
	profiler: ReturnType<typeof createGridMemoryProfiler>,
	from: number,
	through: number
): Promise<void> {
	for (let transition = from; transition <= through; transition++) await profiler.checkpoint(checkpoint(transition));
}

it("starts only after transition 10 is durable and hashed, spans 20/30, and stops before terminal accounting", async () => {
	const { profiler, directory, records } = fixture();
	control.onPost = (method): void => {
		if (method === "HeapProfiler.enable" || method === "HeapProfiler.startTrackingHeapObjects") {
			const row = records().find((entry) => entry.kind === "snapshot-complete" && entry.transitions === 10);
			expect(row?.sha256).toBe(
				createHash("sha256")
					.update(readFileSync(join(directory, "transition-10.heapsnapshot")))
					.digest("hex")
			);
		}
		if (method === "HeapProfiler.stopTrackingHeapObjects") {
			expect(records().some((entry) => entry.kind === "snapshot-complete" && entry.transitions === 30)).toBe(true);
			expect(records().some((entry) => entry.terminalAccounting === true)).toBe(false);
		}
	};
	try {
		await advance(profiler, 1, 9);
		expect(control.events).toEqual([]);
		await advance(profiler, 10, 30);
		expect(control.events).toEqual([
			"snapshot",
			"connect",
			"HeapProfiler.enable",
			"HeapProfiler.startTrackingHeapObjects",
			"snapshot",
			"snapshot",
			"HeapProfiler.stopTrackingHeapObjects",
			"disconnect",
		]);
		expect(
			control.posts.find((entry) => entry.method === "HeapProfiler.startTrackingHeapObjects")?.params
		).toMatchObject({ trackAllocations: true });
		await profiler.checkpoint(checkpoint(30, true));
		profiler.finish();
		expect(records().filter((entry) => entry.kind === "capture-complete")).toHaveLength(1);
	} finally {
		await Promise.resolve(profiler.close());
	}
	await Promise.resolve(profiler.close());
	expect(control.events.filter((event) => event === "disconnect")).toHaveLength(1);
});

it("disabled mode makes no inspector calls and still completes", async () => {
	const { profiler, records } = fixture(false);
	try {
		await advance(profiler, 1, 30);
		await profiler.checkpoint(checkpoint(30, true));
		profiler.finish();
		expect(records().some((entry) => entry.kind === "capture-complete")).toBe(true);
	} finally {
		await Promise.resolve(profiler.close());
	}
	expect(control.events).toEqual(["snapshot", "snapshot", "snapshot"]);
});

it.each(["HeapProfiler.enable", "HeapProfiler.startTrackingHeapObjects", "HeapProfiler.stopTrackingHeapObjects"])(
	"%s failure rejects and disconnects without successful completion",
	async (method) => {
		const { profiler, directory, records } = fixture();
		control.failMethod = method;
		const failingTransition = method === "HeapProfiler.stopTrackingHeapObjects" ? 30 : 10;
		try {
			await advance(profiler, 1, failingTransition - 1);
			await expect(profiler.checkpoint(checkpoint(failingTransition))).rejects.toBe(control.failure);
			expect(() => profiler.finish()).toThrow();
		} finally {
			await Promise.resolve(profiler.close());
		}
		await Promise.resolve(profiler.close());
		expect(control.events.filter((event) => event === "disconnect")).toHaveLength(1);
		expect(existsSync(join(directory, "transition-10.heapsnapshot"))).toBe(true);
		expect(records().some((entry) => entry.kind === "capture-complete")).toBe(false);
	}
);

it.each([false, true])(
	"snapshot failure while tracking preserves the partial file and primary error (cleanup also fails: %s)",
	async (cleanupFails) => {
		const { profiler, directory, records } = fixture();
		const failure = new Error("SYNTHETIC_SNAPSHOT_FAILURE");
		try {
			await advance(profiler, 1, 19);
			if (cleanupFails) control.failMethod = "HeapProfiler.stopTrackingHeapObjects";
			control.snapshot.mockImplementationOnce(() =>
				Readable.from(
					(function* (): Generator<string, never, unknown> {
						yield "partial snapshot";
						throw failure;
					})()
				)
			);
			await expect(profiler.checkpoint(checkpoint(20))).rejects.toBe(failure);
			expect(() => profiler.finish()).toThrow();
		} finally {
			if (cleanupFails) {
				await expect(Promise.resolve(profiler.close())).rejects.toBe(control.failure);
			} else {
				await expect(Promise.resolve(profiler.close())).resolves.toBeUndefined();
			}
		}
		if (cleanupFails) {
			await expect(Promise.resolve(profiler.close())).rejects.toBe(control.failure);
		} else {
			await expect(Promise.resolve(profiler.close())).resolves.toBeUndefined();
		}
		expect(readFileSync(join(directory, "transition-20.heapsnapshot"), "utf8")).toContain("partial snapshot");
		expect(control.events.filter((event) => event === "HeapProfiler.stopTrackingHeapObjects")).toHaveLength(1);
		expect(control.events.filter((event) => event === "disconnect")).toHaveLength(1);
		expect(records().some((entry) => entry.kind === "capture-complete")).toBe(false);
	}
);

it("transition 10 snapshot failure never starts tracking and retains its partial artifact", async () => {
	const { profiler, directory, records } = fixture();
	const failure = new Error("SYNTHETIC_BASELINE_SNAPSHOT_FAILURE");
	try {
		await advance(profiler, 1, 9);
		control.snapshot.mockImplementationOnce(() =>
			Readable.from(
				(function* (): Generator<string, never, unknown> {
					yield "baseline partial";
					throw failure;
				})()
			)
		);
		await expect(profiler.checkpoint(checkpoint(10))).rejects.toBe(failure);
		expect(() => profiler.finish()).toThrow();
	} finally {
		await Promise.resolve(profiler.close());
	}
	expect(control.posts).toEqual([]);
	expect(control.events).not.toContain("connect");
	expect(readFileSync(join(directory, "transition-10.heapsnapshot"), "utf8")).toContain("baseline partial");
	expect(records().some((entry) => entry.kind === "capture-complete")).toBe(false);
});

it("workload abort closes active tracking exactly once without completion", async () => {
	const { profiler, records } = fixture();
	await advance(profiler, 1, 12);
	await Promise.resolve(profiler.close());
	await Promise.resolve(profiler.close());
	expect(control.events.filter((event) => event === "HeapProfiler.startTrackingHeapObjects")).toHaveLength(1);
	expect(control.events.filter((event) => event === "HeapProfiler.stopTrackingHeapObjects")).toHaveLength(1);
	expect(control.events.filter((event) => event === "disconnect")).toHaveLength(1);
	expect(() => profiler.finish()).toThrow();
	expect(records().some((entry) => entry.kind === "capture-complete")).toBe(false);
});

it("duplicate transition does not start another inspector session", async () => {
	const { profiler } = fixture();
	try {
		await advance(profiler, 1, 10);
		await expect(profiler.checkpoint(checkpoint(10))).rejects.toThrow();
		expect(control.events.filter((event) => event === "HeapProfiler.startTrackingHeapObjects")).toHaveLength(1);
	} finally {
		await Promise.resolve(profiler.close());
	}
});

it("records separate scalar V8 code statistics without adding them to ownedBytes", async () => {
	const { profiler, records } = fixture(false);
	try {
		await advance(profiler, 1, 1);
		const row = records().find((entry) => entry.kind === "transition-memory");
		expect(row?.codeStatistics).toEqual(control.code);
		expect(row?.memory).toBeDefined();
		const measurement = row?.memory;
		if (!measurement) throw new Error("MISSING_MEMORY_MEASUREMENT");
		expect(measurement.ownedBytes).toBe(measurement.heapUsed + measurement.arrayBuffers);
		expect(row?.memory).not.toHaveProperty("codeStatistics");
	} finally {
		await Promise.resolve(profiler.close());
	}
});
