import { chromium } from "@playwright/test";

import type { Phase2lBDeathTuple } from "../fixtures/phase-2l-b-browser-issuance-contract.js";
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
	const executablePath = required("PHASE_2L_B_EXECUTABLE");
	const profilePath = required("PHASE_2L_B_PROFILE");
	const primaryDatabaseName = required("PHASE_2L_B_PRIMARY");
	const url = required("PHASE_2L_B_URL");
	const edge = JSON.parse(required("PHASE_2L_B_EDGE")) as Phase2lBDeathTuple;
	const context = await chromium.launchPersistentContext(profilePath, { executablePath, headless: true });
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		await page.exposeBinding("phase2lBRelay", (_source, observation: unknown, cellValue: number) => {
			write({ cellValue, kind: "armed", observation });
		});
		await page.goto(url, { waitUntil: "load" });
		if ((await page.evaluate(() => globalThis.crossOriginIsolated)) !== true)
			throw new TypeError("Phase 2l-b death page is not cross-origin isolated");
		await page.waitForFunction(() => typeof window.phase2lBRunDeath === "function");
		const forest = captureProcessForest();
		const child = forest.find(({ pid }) => pid === process.pid);
		const controller = forest.find(({ pid }) => pid === process.ppid);
		if (child === undefined || controller === undefined) throw new TypeError("death process identity missing");
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
		write({
			browserRoot,
			child,
			crossOriginIsolated: true,
			forest: processClosure(forest, process.pid),
			kind: "ready",
		});
		void page.evaluate(({ edge, primaryDatabaseName }) => window.phase2lBRunDeath(edge, primaryDatabaseName), {
			edge,
			primaryDatabaseName,
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
