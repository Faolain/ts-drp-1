import { chromium } from "@playwright/test";

import { captureProcessForest, locateBrowserRoot, processClosure } from "../fixtures/process-forest.js";

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
	return value;
}

async function run(): Promise<void> {
	const executablePath = required("PHASE_2B_EXECUTABLE_PATH");
	const profilePath = required("PHASE_2B_PROFILE");
	const databaseName = required("PHASE_2B_DATABASE");
	const url = required("PHASE_2B_URL");
	const context = await chromium.launchPersistentContext(profilePath, {
		executablePath: executablePath,
		headless: true,
	});
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		const relayed: unknown[] = [];
		await page.exposeBinding("phase2bRelay", (_source, message: unknown, cellValue: number) => {
			relayed.push({ message, cellValue });
		});
		await page.goto(url, { waitUntil: "load" });
		const result = await page.evaluate(
			(name) => window.phase2bRun(name, { id: "left-write", edge: "before" }, "arming"),
			databaseName
		);
		const forest = captureProcessForest();
		const child = forest.find((identity) => identity.pid === process.pid);
		if (child === undefined) throw new TypeError("arming child identity was absent from process forest");
		const browserRoot = locateBrowserRoot(forest, process.pid, profilePath);
		process.send?.({
			kind: "settled-result",
			version: 1,
			role: "arming",
			result,
			relayed,
			child,
			browserRoot,
			forest: processClosure(forest, process.pid),
			browser: {
				name: "chromium",
				version: context.browser()?.version() ?? "unknown",
				executablePath: browserRoot.command.split(" --", 1)[0] ?? executablePath,
			},
		});
	} finally {
		await context.close();
	}
}

void run().catch((error: unknown) => {
	process.send?.({
		kind: "child-error",
		version: 1,
		detail: error instanceof Error ? error.message : "unknown arming child failure",
	});
	process.exitCode = 1;
});
