import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";

interface Summary {
	readonly exactCanonicalStateBytes: readonly number[];
	readonly operationCount: number;
	readonly orderLength: number;
	readonly outputCount: number;
	readonly stateDigest: string;
	readonly stateValue: number;
	readonly workerScope: string;
}

interface Measured {
	readonly longTaskControlMs: number;
	readonly maxLongTaskMs: number;
	readonly oracle: Omit<Summary, "workerScope">;
	readonly worker: Summary;
}

async function bundle(entry: URL, format: "esm" | "iife", globalName?: string): Promise<string> {
	const result = await build({
		bundle: true,
		entryPoints: [entry.pathname],
		format,
		...(globalName === undefined ? {} : { globalName }),
		platform: "browser",
		target: "es2022",
		write: false,
	});
	const output = result.outputFiles?.[0];
	if (output === undefined) throw new Error("missing Phase 4a browser bundle");
	return output.text;
}

async function install(page: Page): Promise<string> {
	await page.route("https://phase-4a-live.test/", async (route) =>
		route.fulfill({ body: "<!doctype html><title>Phase 4a live fold</title>", contentType: "text/html" })
	);
	await page.goto("https://phase-4a-live.test/");
	const pageSource = await bundle(
		new URL("./fixtures/blueprint-fold.page.ts", import.meta.url),
		"iife",
		"Phase4aLiveFold"
	);
	await page.addScriptTag({ content: pageSource });
	return bundle(new URL("./fixtures/blueprint-fold.worker.ts", import.meta.url), "esm");
}

test("all active browser engines produce the same 4,096-operation fold", async ({ page }) => {
	const workerSource = await install(page);
	const summary = await page.evaluate(async (source): Promise<Summary> => {
		return (
			globalThis as typeof globalThis & {
				Phase4aLiveFold: { runBlueprintFoldWorkerUnmeasured(source: string): Promise<Summary> };
			}
		).Phase4aLiveFold.runBlueprintFoldWorkerUnmeasured(source);
	}, workerSource);
	expect(summary).toMatchObject({
		exactCanonicalStateBytes: [3, 128, 64],
		operationCount: 4_096,
		orderLength: 4_096,
		outputCount: 4_096,
		stateValue: 4_096,
		workerScope: "DedicatedWorkerGlobalScope",
	});
	expect(summary.stateDigest).toBe("1e1c6e02fbce7ca0abde5e337a142219495343a4c4d14d03d2675a14d174137b");
});

test("Chromium keeps the genuine blueprint fold below the 50ms Long Task boundary", async ({ browserName, page }) => {
	test.skip(browserName !== "chromium", "Long Tasks API is Chromium-only");
	const workerSource = await install(page);
	const measured = await page.evaluate(async (source): Promise<Measured> => {
		return (
			globalThis as typeof globalThis & {
				Phase4aLiveFold: { runBlueprintFoldWorker(source: string): Promise<Measured> };
			}
		).Phase4aLiveFold.runBlueprintFoldWorker(source);
	}, workerSource);
	expect(measured.longTaskControlMs).toBeGreaterThanOrEqual(150);
	expect(measured.maxLongTaskMs).toBeLessThan(50);
	expect(measured.worker).toEqual({ ...measured.oracle, workerScope: "DedicatedWorkerGlobalScope" });
});
