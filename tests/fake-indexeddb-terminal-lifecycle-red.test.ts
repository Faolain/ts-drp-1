import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

interface LifecycleReport {
	kind: string;
	format: string;
	cases: { name: string; ok: boolean; error?: string }[];
	gc: {
		gcTurns: number;
		maxGcTurns: number;
		sentinelCollected: boolean;
		collected: { name: string; collected: boolean }[];
	};
}

const probe = fileURLToPath(new URL("./fixtures/fake-indexeddb-lifecycle/probe.mts", import.meta.url));

describe.each(["esm", "cjs"] as const)("installed fake-indexeddb terminal lifecycle (%s)", (format) => {
	let report: LifecycleReport;
	beforeAll(() => {
		const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", probe, format], {
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 1_048_576,
		});
		expect(child.error, child.stderr).toBeUndefined();
		expect(child.signal, child.stderr).toBeNull();
		expect(child.status, child.stderr).toBe(0);
		report = JSON.parse(child.stdout) as LifecycleReport;
		expect(report.kind).toBe("FAKE_IDB_LIFECYCLE");
		expect(report.format).toBe(format);
	}, 35_000);

	it.each(["commit", "explicit-abort", "error-abort", "conflicting-order", "upgrade-abort-close-delete"])(
		"preserves public IndexedDB behavior: %s",
		(name) => {
			const outcome = report.cases.find((entry) => entry.name === name);
			expect(outcome, "PUBLIC_LIFECYCLE_CASE_RAN").toBeDefined();
			expect(outcome?.ok, outcome?.error).toBe(true);
		}
	);

	it.each(["commit", "explicit-abort", "error-abort", "upgrade-abort"])(
		"releases terminal transaction while its database and factory stay live: %s",
		(name) => {
			expect(report.gc.sentinelCollected, "ACTUAL_NODE_GC_COLLECTED_DISPOSABLE_CONTROL").toBe(true);
			expect(report.gc.maxGcTurns).toBe(32);
			expect(report.gc.gcTurns).toBeGreaterThan(0);
			expect(report.gc.gcTurns).toBeLessThanOrEqual(report.gc.maxGcTurns);
			const outcome = report.gc.collected.find((entry) => entry.name === name);
			expect(outcome, "TERMINAL_TRANSACTION_WEAK_REFERENCE_EXISTS").toBeDefined();
			expect(outcome?.collected, `FINISHED_${name}_TRANSACTION_MUST_NOT_BE_DATABASE_ROOTED`).toBe(true);
		}
	);
});
