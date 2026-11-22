import { IDBFactory } from "fake-indexeddb";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type * as v8 from "node:v8";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	createGridMemoryProfiler,
	gridMemoryCapturePlan,
	type GridMemoryCheckpoint,
} from "./fixtures/grid-memory-profiler.js";

const control = vi.hoisted(() => ({ posts: [] as string[], delays: [] as number[], gc: 0, failGc: false, census: 0 }));
vi.mock("node:v8", async (original) => ({
	...(await original<typeof v8>()),
	getHeapSnapshot: (): Readable => Readable.from(["synthetic horizon snapshot"]),
}));
vi.mock("node:timers/promises", () => ({
	setTimeout: (milliseconds: number): Promise<void> => {
		control.delays.push(milliseconds);
		return Promise.resolve();
	},
}));
vi.mock("./fixtures/grid-memory-storage-census.js", () => ({
	censusGridStorage: (): Promise<never[]> => {
		control.census++;
		return Promise.resolve([]);
	},
}));
vi.mock("node:inspector/promises", () => ({
	Session: class {
		connect(): void {
			control.posts.push("connect");
		}
		disconnect(): void {
			control.posts.push("disconnect");
		}
		post(method: string): Promise<object> {
			control.posts.push(method);
			return Promise.resolve({ profile: { head: {}, samples: [] } });
		}
	},
}));
const roots: string[] = [];
const profilers: ReturnType<typeof createGridMemoryProfiler>[] = [];
beforeEach(() => {
	control.posts.length = 0;
	control.delays.length = 0;
	control.gc = 0;
	control.failGc = false;
	control.census = 0;
	vi.stubGlobal("gc", () => {
		if (control.failGc) throw new Error("HORIZON_GC_FAILURE");
		control.gc++;
	});
	vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(async () => {
	for (const profiler of profilers.splice(0)) await profiler.close();
	vi.unstubAllGlobals();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(
	targetTransitions: 30 | 60 = 60,
	allocationMode: "none" | "tracking" | "sampling" = "none"
): {
	profiler: ReturnType<typeof createGridMemoryProfiler>;
	directory: string;
} {
	const root = mkdtempSync(join(tmpdir(), "grid-growth-horizon-"));
	roots.push(root);
	const directory = join(root, "capture"),
		options = { directory, targetTransitions, allocationMode };
	const profiler = createGridMemoryProfiler(options);
	profilers.push(profiler);
	return { profiler, directory };
}
function checkpoint(transitions: number, terminalAccounting = false): GridMemoryCheckpoint {
	return {
		epoch: transitions - (terminalAccounting ? 0 : 1),
		transitions,
		terminalAccounting,
		objectId: "horizon-control",
		databaseNames: [],
		owners: { liveOwners: 64 },
	};
}
async function advance(profiler: ReturnType<typeof createGridMemoryProfiler>, to: number): Promise<void> {
	for (let transition = 1; transition <= to; transition++) await profiler.checkpoint(checkpoint(transition));
}
interface Row {
	kind: string;
	transitions?: number;
	captured?: number[];
	requestedDelayMs?: number;
	phase?: string;
	postGc?: boolean;
	capturePlan?: { targetTransitions: number; snapshotTransitions: number[]; idleDelaysMs: number[] };
}
function records(directory: string): Row[] {
	return readFileSync(join(directory, "telemetry.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

it("owns immutable default and longer plans, rejecting unsupported targets before file creation", () => {
	expect(gridMemoryCapturePlan().snapshotTransitions).toEqual([10, 20, 30]);
	const plan = gridMemoryCapturePlan(60);
	expect(plan.snapshotTransitions).toEqual([10, 30, 45, 60]);
	expect(plan.idleDelaysMs).toEqual([0, 1000, 5000, 15000]);
	expect(Object.isFrozen(plan)).toBe(true);
	expect(Object.isFrozen(plan.snapshotTransitions)).toBe(true);
	for (const value of [0, 45, 61, NaN, Infinity]) expect(() => gridMemoryCapturePlan(value)).toThrow();
	const root = mkdtempSync(join(tmpdir(), "grid-growth-invalid-"));
	roots.push(root);
	const directory = join(root, "capture");
	const options = { directory, targetTransitions: Number.NaN };
	expect(() => createGridMemoryProfiler(options)).toThrow();
	expect(existsSync(directory)).toBe(false);
});

it("does not accept transition30 as terminal for the longer plan", async () => {
	const { profiler } = fixture();
	await advance(profiler, 30);
	await expect(profiler.checkpoint(checkpoint(30, true))).rejects.toThrow(/ORDER/);
	expect(() => profiler.finish()).toThrow(/INCOMPLETE/);
});

it("captures the longer schedule once and requires terminal accounting then distinct idle observations", async () => {
	const { profiler, directory } = fixture();
	await expect(profiler.observeIdle()).rejects.toThrow();
	await advance(profiler, 60);
	await expect(profiler.checkpoint(checkpoint(60))).rejects.toThrow(/ORDER/);
	await expect(profiler.checkpoint(checkpoint(61))).rejects.toThrow(/ORDER/);
	await expect(profiler.observeIdle()).rejects.toThrow();
	await profiler.checkpoint(checkpoint(60, true));
	expect(() => profiler.finish()).toThrow(/INCOMPLETE/);
	const censusBefore = control.census,
		gcBefore = control.gc;
	const pending = profiler.observeIdle();
	await expect(profiler.observeIdle()).rejects.toThrow();
	await expect(profiler.close()).rejects.toThrow();
	expect(() => profiler.finish()).toThrow(/INCOMPLETE/);
	await pending;
	expect(control.census).toBe(censusBefore);
	expect(control.gc - gcBefore).toBe(12);
	expect(control.delays).toEqual([1000, 4000, 10000]);
	profiler.finish();
	await expect(profiler.observeIdle()).rejects.toThrow();
	const rows = records(directory);
	expect(rows.find((r) => r.kind === "worker-identity")?.capturePlan?.targetTransitions).toBe(60);
	expect(rows.filter((r) => r.kind === "snapshot-complete").map((r) => r.transitions)).toEqual([10, 30, 45, 60]);
	expect(rows.filter((r) => r.kind === "idle-memory").map((r) => r.requestedDelayMs)).toEqual([0, 1000, 5000, 15000]);
	expect(
		rows
			.filter((r) => r.kind === "idle-memory")
			.every((r) => r.postGc && r.phase === "post-workload-before-test-cleanup")
	).toBe(true);
	expect(rows.findIndex((r) => r.kind === "idle-observation-complete")).toBeLessThan(
		rows.findIndex((r) => r.kind === "capture-complete")
	);
	expect(control.posts).toEqual([]);
});

it.each(["tracking", "sampling"] as const)("keeps %s active beyond30 and stops at60", async (mode) => {
	const { profiler, directory } = fixture(60, mode);
	await advance(profiler, 30);
	expect(control.posts.filter((p) => p.startsWith("HeapProfiler.stop"))).toEqual([]);
	for (let transition = 31; transition <= 60; transition++) await profiler.checkpoint(checkpoint(transition));
	expect(control.posts.filter((p) => p.startsWith("HeapProfiler.stop"))).toEqual([
		mode === "sampling" ? "HeapProfiler.stopSampling" : "HeapProfiler.stopTrackingHeapObjects",
	]);
	expect(
		records(directory)
			.filter((r) => r.kind === "snapshot-complete")
			.map((r) => r.transitions)
	).toEqual([10, 30, 45, 60]);
	if (mode === "sampling")
		expect(
			records(directory)
				.filter((r) => r.kind === "allocation-sampling-profile")
				.map((r) => r.transitions)
		).toEqual([30, 45, 60]);
	expect(control.posts.at(-1)).toBe("disconnect");
});

it("preserves an idle GC failure, disallows successful completion and still closes", async () => {
	const { profiler, directory } = fixture();
	await advance(profiler, 60);
	await profiler.checkpoint(checkpoint(60, true));
	control.failGc = true;
	await expect(profiler.observeIdle()).rejects.toThrow("HORIZON_GC_FAILURE");
	await expect(profiler.observeIdle()).rejects.toThrow();
	expect(() => profiler.finish()).toThrow(/INCOMPLETE/);
	await profiler.close();
	expect(records(directory).some((r) => r.kind === "capture-complete")).toBe(false);
});

it("preserves the original30 completion without requiring an idle phase", async () => {
	const { profiler, directory } = fixture(30);
	await advance(profiler, 30);
	await profiler.checkpoint(checkpoint(30, true));
	profiler.finish();
	expect(
		records(directory)
			.filter((r) => r.kind === "snapshot-complete")
			.map((r) => r.transitions)
	).toEqual([10, 20, 30]);
	expect(control.delays).toEqual([]);
});
