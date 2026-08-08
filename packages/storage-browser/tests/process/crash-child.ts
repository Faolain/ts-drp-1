import { chromium } from "@playwright/test";

import { KILL_POINT_MANIFEST, type KillPoint } from "../../src/killpoints.js";
import { captureProcessForest, locateBrowserRoot, processClosure } from "../fixtures/process-forest.js";

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
	return value;
}

function write(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function run(): Promise<never> {
	const executablePath = required("PHASE_2B_EXECUTABLE_PATH");
	const profilePath = required("PHASE_2B_PROFILE");
	const databaseName = required("PHASE_2B_DATABASE");
	const url = required("PHASE_2B_URL");
	const armedValue = JSON.parse(required("PHASE_2B_ARMED")) as unknown;
	if (
		typeof armedValue !== "object" ||
		armedValue === null ||
		!("id" in armedValue) ||
		!("edge" in armedValue) ||
		typeof armedValue.id !== "string" ||
		!Object.hasOwn(KILL_POINT_MANIFEST, armedValue.id) ||
		(armedValue.edge !== "before" && armedValue.edge !== "after")
	) {
		throw new TypeError("invalid crash armed point");
	}
	const armed = { id: armedValue.id, edge: armedValue.edge } as KillPoint;
	const context = await chromium.launchPersistentContext(profilePath, {
		executablePath: executablePath,
		headless: true,
	});
	const page = context.pages()[0] ?? (await context.newPage());
	await page.exposeBinding("phase2bRelay", (_source, message: unknown, cellValue: number) => {
		write({ kind: "hit", version: 1, message, cellValue });
	});
	await page.goto(url, { waitUntil: "load" });
	const crossOriginIsolated = await page.evaluate(() => globalThis.crossOriginIsolated);
	if (crossOriginIsolated !== true) throw new TypeError("crash page was not cross-origin isolated");
	const forest = captureProcessForest();
	const child = forest.find((identity) => identity.pid === process.pid);
	if (child === undefined) throw new TypeError("crash child identity was absent from process forest");
	const browserRoot = locateBrowserRoot(forest, process.pid, profilePath);
	write({
		kind: "ready",
		version: 1,
		child,
		browserRoot,
		crossOriginIsolated,
		forest: processClosure(forest, process.pid),
		browser: {
			name: "chromium",
			version: context.browser()?.version() ?? "unknown",
			executablePath: browserRoot.command.split(" --", 1)[0] ?? executablePath,
		},
	});
	void page.evaluate(({ name, point }) => window.phase2bRun(name, point, "tuple"), {
		name: databaseName,
		point: armed,
	});
	return new Promise<never>(() => undefined);
}

void run().catch((error: unknown) => {
	write({ kind: "child-error", version: 1, detail: error instanceof Error ? error.message : "unknown crash failure" });
	process.exitCode = 1;
});
