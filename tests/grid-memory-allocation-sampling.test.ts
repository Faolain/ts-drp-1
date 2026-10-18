import { IDBFactory } from "fake-indexeddb";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type * as v8 from "node:v8";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createGridMemoryProfiler, type GridMemoryCheckpoint } from "./fixtures/grid-memory-profiler.js";

const control = vi.hoisted(() => ({
	events: [] as string[],
	posts: [] as { method: string; params: unknown }[],
	failMethod: "",
	failure: new Error("SAMPLING_CONTROL_FAILURE"),
	profile: {
		head: {
			id: 1,
			selfSize: 8192,
			children: [],
			callFrame: { functionName: "synthetic", scriptId: "1", url: "control", lineNumber: 0, columnNumber: 0 },
		},
		samples: [{ size: 8192, nodeId: 1, ordinal: 1 }],
	},
}));
vi.mock("node:v8", async (original) => ({
	...(await original<typeof v8>()),
	getHeapSnapshot: (): Readable => {
		control.events.push("snapshot");
		return Readable.from(["synthetic snapshot"]);
	},
}));
vi.mock("./fixtures/grid-memory-storage-census.js", () => ({
	censusGridStorage: (): Promise<never[]> => Promise.resolve([]),
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
			return method === control.failMethod
				? Promise.reject(control.failure)
				: Promise.resolve({ profile: control.profile });
		}
	},
}));
const roots: string[] = [];
beforeEach(() => {
	control.events.length = 0;
	control.posts.length = 0;
	control.failMethod = "";
	vi.stubGlobal("gc", () => {
		control.events.push("gc");
	});
	vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
	vi.unstubAllGlobals();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): { profiler: ReturnType<typeof createGridMemoryProfiler>; directory: string } {
	const root = mkdtempSync(join(tmpdir(), "grid-sampling-red-"));
	roots.push(root);
	const directory = join(root, "capture");
	const options = { directory, allocationMode: "sampling" as const };
	return { directory, profiler: createGridMemoryProfiler(options) };
}
function checkpoint(transitions: number, terminalAccounting = false): GridMemoryCheckpoint {
	return {
		epoch: transitions - (terminalAccounting ? 0 : 1),
		transitions,
		terminalAccounting,
		objectId: "synthetic-sampling",
		databaseNames: [],
		owners: { synthetic: 1 },
	};
}
async function advance(profiler: ReturnType<typeof createGridMemoryProfiler>, from: number, to: number): Promise<void> {
	for (let i = from; i <= to; i++) await profiler.checkpoint(checkpoint(i));
}

it("samples only after baseline, saves post-GC profiles before snapshots, and stops before terminal accounting", async () => {
	const { profiler, directory } = fixture();
	try {
		await advance(profiler, 1, 30);
		await profiler.checkpoint(checkpoint(30, true));
		profiler.finish();
	} finally {
		await profiler.close();
	}
	expect(control.posts.map((r) => r.method)).toEqual([
		"HeapProfiler.enable",
		"HeapProfiler.startSampling",
		"HeapProfiler.getSamplingProfile",
		"HeapProfiler.getSamplingProfile",
		"HeapProfiler.stopSampling",
	]);
	expect(control.posts[1]?.params).toEqual({
		samplingInterval: 8192,
		includeObjectsCollectedByMajorGC: false,
		includeObjectsCollectedByMinorGC: false,
	});
	const events = control.events.filter((e) => e !== "gc");
	expect(events).toEqual([
		"snapshot",
		"connect",
		"HeapProfiler.enable",
		"HeapProfiler.startSampling",
		"HeapProfiler.getSamplingProfile",
		"snapshot",
		"HeapProfiler.getSamplingProfile",
		"snapshot",
		"HeapProfiler.stopSampling",
		"disconnect",
	]);
	const records: { kind: string; transitions?: number; terminalAccounting?: boolean; sha256?: string }[] = readFileSync(
		join(directory, "telemetry.jsonl"),
		"utf8"
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	for (const t of [20, 30]) {
		const bytes = readFileSync(join(directory, `transition-${t}.heapprofile`));
		expect(JSON.parse(bytes.toString())).toEqual(control.profile);
		expect(records.find((r) => r.kind === "allocation-sampling-profile" && r.transitions === t)?.sha256).toBe(
			createHash("sha256").update(bytes).digest("hex")
		);
	}
	expect(records.findIndex((r) => r.kind === "allocation-sampling-stopped")).toBeLessThan(
		records.findIndex((r) => r.kind === "transition-memory" && r.terminalAccounting)
	);
	expect(existsSync(join(directory, "transition-10.heapprofile"))).toBe(false);
	for (const i of control.events.flatMap((e, i) => (e === "HeapProfiler.getSamplingProfile" ? [i] : []))) {
		expect(
			control.events.slice(i + 1, control.events.indexOf("snapshot", i + 1)).filter((e) => e === "gc")
		).toHaveLength(3);
	}
});

it.each([
	"HeapProfiler.enable",
	"HeapProfiler.startSampling",
	"HeapProfiler.getSamplingProfile",
	"HeapProfiler.stopSampling",
])("%s rejection preserves primary failure and disconnects", async (method) => {
	const { profiler } = fixture();
	control.failMethod = method;
	const t = method === "HeapProfiler.stopSampling" ? 30 : method === "HeapProfiler.getSamplingProfile" ? 20 : 10;
	try {
		await advance(profiler, 1, t - 1);
		await expect(profiler.checkpoint(checkpoint(t))).rejects.toBe(control.failure);
		expect(() => profiler.finish()).toThrow();
	} finally {
		await profiler.close();
	}
	expect(control.events.filter((e) => e === "disconnect")).toHaveLength(1);
});

it("never overwrites a profile artifact and cannot finish after the write fails", async () => {
	const { profiler, directory } = fixture();
	try {
		await advance(profiler, 1, 19);
		writeFileSync(join(directory, "transition-20.heapprofile"), "preserve", { flag: "wx" });
		await expect(profiler.checkpoint(checkpoint(20))).rejects.toThrow();
		expect(readFileSync(join(directory, "transition-20.heapprofile"), "utf8")).toBe("preserve");
		expect(existsSync(join(directory, "transition-20.heapsnapshot"))).toBe(false);
		expect(() => profiler.finish()).toThrow();
	} finally {
		await profiler.close();
	}
});

it("abort closes sampling once without claiming completion", async () => {
	const { profiler } = fixture();
	await advance(profiler, 1, 12);
	await profiler.close();
	await profiler.close();
	expect(control.posts.filter((p) => p.method === "HeapProfiler.stopSampling")).toHaveLength(1);
	expect(control.events.filter((e) => e === "disconnect")).toHaveLength(1);
	expect(() => profiler.finish()).toThrow();
});
