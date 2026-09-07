import { IDBFactory } from "fake-indexeddb";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { getHeapSnapshot } from "node:v8";
import type * as v8 from "node:v8";
import { afterEach, expect, it, vi } from "vitest";

import { createGridMemoryProfiler, type GridMemoryCheckpoint } from "./fixtures/grid-memory-profiler.js";

// Synthetic streams test failure ownership, never evidence or heap acceptance.
vi.mock("node:v8", async (importOriginal) => ({
	...(await importOriginal<typeof v8>()),
	getHeapSnapshot: vi.fn(),
}));

const temporaryRoots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("preserves the primary snapshot source failure and partial artifact while closing without EBADF", async () => {
	const root = mkdtempSync(join(tmpdir(), "grid-snapshot-source-error-"));
	temporaryRoots.push(root);
	const directory = join(root, "capture");
	const failure = new Error("GRID_TEST_PRIMARY_SNAPSHOT_SOURCE_FAILURE");
	const source = Readable.from(
		(async function* (): AsyncGenerator<string, never, unknown> {
			yield "partial synthetic snapshot";
			await new Promise<void>((resolve) => setImmediate(resolve));
			throw failure;
		})()
	);
	vi.mocked(getHeapSnapshot).mockReturnValueOnce(source);
	vi.stubGlobal("gc", () => undefined);
	vi.stubGlobal("indexedDB", new IDBFactory());
	const profiler = createGridMemoryProfiler({ directory });
	const checkpoint = (transitions: number): GridMemoryCheckpoint => ({
		epoch: transitions - 1,
		transitions,
		terminalAccounting: false,
		objectId: `creator:${"e".repeat(32)}`,
		databaseNames: [],
		owners: { live: 1 },
	});
	try {
		for (let transitions = 1; transitions < 10; transitions += 1) await profiler.checkpoint(checkpoint(transitions));
		await expect(profiler.checkpoint(checkpoint(10))).rejects.toBe(failure);
		expect(getHeapSnapshot).toHaveBeenCalledTimes(1);
		expect(source.destroyed).toBe(true);
		expect(existsSync(join(directory, "transition-10.heapsnapshot")), "FAILED_PARTIAL_SNAPSHOT_PRESERVED").toBe(true);
		expect(() => profiler.finish()).toThrow(/incomplete/iu);
	} finally {
		expect(() => profiler.close(), "FAILED_SNAPSHOT_CLOSE_MUST_NOT_REPLACE_PRIMARY_ERROR").not.toThrow();
	}
	expect(() => profiler.close()).not.toThrow();
	expect(readdirSync(directory)).toContain("transition-10.heapsnapshot");
}, 10_000);
