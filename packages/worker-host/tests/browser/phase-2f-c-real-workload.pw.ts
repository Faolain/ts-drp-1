import { expect, type Page, test } from "@playwright/test";

import { checkEmittedWorkerGraph, type EmittedWorkerArtifact } from "../emitted-worker-graph.js";
import { bundleBrowserFixture } from "./fixtures/bundle.js";

interface WorkloadOracle {
	readonly count: number;
	readonly order: readonly number[];
	readonly root: string;
}

interface WorkloadSummary extends WorkloadOracle {
	readonly items: number;
	readonly pageCounter: number;
	readonly pageScope: string;
	readonly workerCounter: number;
	readonly workerScope: string;
}

interface MeasuredWorkload {
	readonly longTaskControlMs: number;
	readonly maxLongTaskMs: number;
	readonly oracle: WorkloadOracle;
	readonly summary: WorkloadSummary;
}

const PACKAGE_ROOT = new URL("../..", import.meta.url).pathname;

async function installHarness(page: Page): Promise<void> {
	await page.route("https://phase-2f-c.test/", async (route) =>
		route.fulfill({ body: "<!doctype html><title>worker-host real workload</title>", contentType: "text/html" })
	);
	await page.goto("https://phase-2f-c.test/");
	const source = await bundleBrowserFixture(
		new URL("./fixtures/real-workload-page.ts", import.meta.url),
		"iife",
		"Phase2fCWorkload"
	);
	await page.addScriptTag({ content: source });
}

function assertExactSummary(actual: WorkloadSummary, oracle: WorkloadOracle): void {
	expect(actual).toEqual({
		...oracle,
		items: 4_097,
		pageCounter: 0,
		pageScope: "Window",
		workerCounter: 4_097,
		workerScope: "DedicatedWorkerGlobalScope",
	});
}

function causalWorkerSource(summary: Omit<WorkloadSummary, "pageCounter" | "pageScope">): string {
	return `
const protocol = "ts-drp/worker-host";
self.postMessage({ protocol, version: 1, kind: "ready", accepts: ["operation-workload"] });
self.onmessage = (event) => {
  if (event.data.kind !== "request") return;
  const payload = new TextEncoder().encode(${JSON.stringify(JSON.stringify(summary))});
  self.postMessage({ protocol, version: 1, kind: "chunk", id: event.data.id, sequence: 0, payload });
  self.postMessage({ protocol, version: 1, kind: "done", id: event.data.id, chunks: 1, bytes: payload.byteLength });
};`;
}

async function oracleIn(page: Page): Promise<WorkloadOracle> {
	return page.evaluate(() => {
		return (
			globalThis as typeof globalThis & {
				Phase2fCWorkload: { computeMainThreadOracle(): WorkloadOracle };
			}
		).Phase2fCWorkload.computeMainThreadOracle();
	});
}

async function runCausal(page: Page, source: string, pageExecutionMutant = false): Promise<WorkloadSummary> {
	return page.evaluate(
		async ({ mutatePage, workerSource }) => {
			return (
				globalThis as typeof globalThis & {
					Phase2fCWorkload: {
						runCausalWorker(source: string, pageExecutionMutant?: boolean): Promise<WorkloadSummary>;
					};
				}
			).Phase2fCWorkload.runCausalWorker(workerSource, mutatePage);
		},
		{ mutatePage: pageExecutionMutant, workerSource: source }
	);
}

function productionWorkloadArtifact(artifacts: readonly EmittedWorkerArtifact[]): EmittedWorkerArtifact {
	const ownsInput = (candidate: EmittedWorkerArtifact, pattern: RegExp): boolean =>
		candidate.inputs.some((input) => pattern.test(input.replaceAll("\\", "/")));
	const artifact = artifacts.find(
		(candidate) =>
			candidate.entry.startsWith("src/") &&
			ownsInput(candidate, /(?:^|\/)(?:worker-host\/)?src\/executor\.ts$/u) &&
			ownsInput(candidate, /(?:^|\/)compaction\/(?:dist\/)?src\/linearize\.(?:js|ts)$/u) &&
			ownsInput(candidate, /(?:^|\/)compaction\/(?:dist\/)?src\/ct-merkle\.(?:js|ts)$/u) &&
			ownsInput(candidate, /(?:^|\/)canonical\/(?:dist\/)?src\/index\.(?:js|ts)$/u)
	);
	if (artifact === undefined) throw new Error("no production workload worker owns the required dependency graph");
	return artifact;
}

test("Chromium Long Tasks observer has a causal 200ms positive control", async ({ browserName, page }) => {
	expect(browserName).toBe("chromium");
	await installHarness(page);
	const duration = await page.evaluate(async () => {
		return (
			globalThis as typeof globalThis & {
				Phase2fCWorkload: { proveLongTaskObserver(): Promise<number> };
			}
		).Phase2fCWorkload.proveLongTaskObserver();
	});
	expect(duration).toBeGreaterThanOrEqual(150);
});

test("root, order, scope, and custody assertions kill causal hollow and falsified workers", async ({ page }) => {
	await installHarness(page);
	const builtExportControl: EmittedWorkerArtifact = {
		bytes: new Uint8Array([1]),
		entry: "src/operation-workload.worker.ts",
		inputs: [
			"src/executor.ts",
			"../canonical/dist/src/index.js",
			"../compaction/dist/src/ct-merkle.js",
			"../compaction/dist/src/linearize.js",
		],
	};
	expect(productionWorkloadArtifact([builtExportControl])).toBe(builtExportControl);
	const oracle = await oracleIn(page);
	const honest = { ...oracle, items: 4_097, workerCounter: 4_097, workerScope: "DedicatedWorkerGlobalScope" };
	assertExactSummary(await runCausal(page, causalWorkerSource(honest)), oracle);

	const mutants = [
		{ ...honest, order: [], root: "hollow" },
		{ ...honest, workerScope: "Window" },
		{ ...honest, workerCounter: 4_096 },
		{ ...honest, root: `${oracle.root.slice(0, -1)}${oracle.root.endsWith("0") ? "1" : "0"}` },
	];
	for (const mutant of mutants) {
		const summary = await runCausal(page, causalWorkerSource(mutant));
		expect(() => assertExactSummary(summary, oracle)).toThrow();
	}
	const windowExecution = await runCausal(page, causalWorkerSource(honest), true);
	expect(() => assertExactSummary(windowExecution, oracle)).toThrow();
});

test("real 4,097-vertex workload stays off Window and below 50ms max Long Task", async ({
	browser,
	page,
}, testInfo) => {
	const artifacts = await checkEmittedWorkerGraph(PACKAGE_ROOT);
	const artifact = productionWorkloadArtifact(artifacts);
	await installHarness(page);
	const measured = await page.evaluate(async (workerSource): Promise<MeasuredWorkload> => {
		return (
			globalThis as typeof globalThis & {
				Phase2fCWorkload: { runMeasuredWorkload(source: string): Promise<MeasuredWorkload> };
			}
		).Phase2fCWorkload.runMeasuredWorkload(workerSource);
	}, new TextDecoder().decode(artifact.bytes));

	expect(measured.longTaskControlMs).toBeGreaterThanOrEqual(150);
	expect(measured.maxLongTaskMs).toBeLessThan(50);
	assertExactSummary(measured.summary, measured.oracle);
	expect(measured.oracle.count).toBe(4_097);
	expect(measured.oracle.order).toHaveLength(4_097);
	await testInfo.attach("phase-2f-c-custody.json", {
		body: Buffer.from(
			JSON.stringify({
				artifactBytes: artifact.bytes.byteLength,
				artifactEntry: artifact.entry,
				browser: browser.version(),
				count: measured.summary.count,
				items: measured.summary.items,
				longTaskControlMs: measured.longTaskControlMs,
				maxLongTaskMs: measured.maxLongTaskMs,
				pageCounter: measured.summary.pageCounter,
				pageScope: measured.summary.pageScope,
				root: measured.summary.root,
				schema: "ts-drp/worker-host-real-workload-custody/v1",
				workerCounter: measured.summary.workerCounter,
				workerScope: measured.summary.workerScope,
			})
		),
		contentType: "application/json",
	});
});
