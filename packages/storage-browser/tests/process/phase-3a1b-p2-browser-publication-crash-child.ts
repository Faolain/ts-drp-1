import { chromium } from "@playwright/test";

import type { Phase3a1bP2BrowserDeathTuple } from "../../../../tests/fixtures/phase-3a1b-p2-outbox-publication-contract.js";
import { captureProcessForest, locateBrowserRoot, processClosure } from "../fixtures/process-forest.js";

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
	return value;
}

function write(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function run(): Promise<never> {
	const executablePath = required("PHASE_3A1B_P2_EXECUTABLE");
	const profilePath = required("PHASE_3A1B_P2_PROFILE");
	const primaryDatabaseName = required("PHASE_3A1B_P2_PRIMARY");
	const url = required("PHASE_3A1B_P2_URL");
	const tuple = JSON.parse(required("PHASE_3A1B_P2_TUPLE")) as Phase3a1bP2BrowserDeathTuple;
	const context = await chromium.launchPersistentContext(profilePath, { executablePath, headless: true });
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		await page.exposeBinding("phase3a1bP2Relay", (_source, observation: unknown, cellValue: number) => {
			write({ cellValue, kind: "armed", observation });
		});
		await page.goto(url, { waitUntil: "load" });
		if ((await page.evaluate(() => globalThis.crossOriginIsolated)) !== true) {
			throw new TypeError("Seam 2 death page is not cross-origin isolated");
		}
		await page.waitForFunction(() => typeof window.phase3a1bP2RunDeath === "function");
		const forest = captureProcessForest();
		const child = forest.find(({ pid }) => pid === process.pid);
		const controller = forest.find(({ pid }) => pid === process.ppid);
		if (child === undefined || controller === undefined) throw new TypeError("Seam 2 process identity missing");
		const platform = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : undefined;
		if (platform === undefined) throw new TypeError(`unsupported death platform ${process.platform}`);
		const browserRoot = locateBrowserRoot(forest, process.pid, profilePath, {
			childRoot: child,
			contentProcessClass: "chromium-renderer",
			controllerPgid: controller.pgid,
			executablePath,
			platform,
			profilePath,
			scope: "phase2e6",
		});
		write({ browserRoot, child, forest: processClosure(forest, process.pid), kind: "ready" });
		void page.evaluate(({ primaryDatabaseName, tuple }) => window.phase3a1bP2RunDeath(tuple, primaryDatabaseName), {
			primaryDatabaseName,
			tuple,
		});
		return await new Promise<never>(() => undefined);
	} catch (error) {
		await context.close();
		throw error;
	}
}

void run().catch((error: unknown) => {
	write({ detail: error instanceof Error ? error.message : String(error), kind: "child-error" });
	process.exitCode = 1;
});
