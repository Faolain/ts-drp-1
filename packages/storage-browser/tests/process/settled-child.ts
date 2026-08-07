import { chromium } from "@playwright/test";

import { captureProcessForest, locateBrowserRoot, processClosure } from "../fixtures/process-forest.js";

type SettledRole = "seed" | "discovery" | "recovery";

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
	return value;
}

async function run(): Promise<void> {
	const role = required("PHASE_2B_ROLE") as SettledRole;
	if (role !== "seed" && role !== "discovery" && role !== "recovery") throw new TypeError("invalid settled role");
	const profilePath = required("PHASE_2B_PROFILE");
	const databaseName = required("PHASE_2B_DATABASE");
	const url = required("PHASE_2B_URL");
	const context = await chromium.launchPersistentContext(profilePath, {
		headless: true,
		args: ["--hide-crash-restore-bubble"],
	});
	try {
		const pages = context.pages();
		if (role === "recovery" && pages.some((candidate) => candidate.url() !== "about:blank")) {
			throw new TypeError("recovery observed a restored non-oracle page");
		}
		const page = pages[0] ?? (await context.newPage());
		await page.goto(url, { waitUntil: "load" });
		let result: unknown;
		if (role === "seed") result = await page.evaluate((name) => window.phase2bSeed(name), databaseName);
		else if (role === "recovery") result = await page.evaluate((name) => window.phase2bRecover(name), databaseName);
		else result = await page.evaluate((name) => window.phase2bRun(name, null, "discovery"), databaseName);
		const forest = captureProcessForest();
		const child = forest.find((identity) => identity.pid === process.pid);
		if (child === undefined) throw new TypeError("settled child identity was absent from process forest");
		const browserRoot = locateBrowserRoot(forest, process.pid, profilePath);
		const ownedForest = processClosure(forest, process.pid);
		process.send?.({
			kind: "settled-result",
			version: 1,
			role,
			result,
			child,
			browserRoot,
			forest: ownedForest,
			browser: {
				name: "chromium",
				version: context.browser()?.version() ?? "unknown",
				executablePath: browserRoot.command.split(" --", 1)[0] ?? chromium.executablePath(),
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
		detail: error instanceof Error ? error.message : "unknown settled child failure",
	});
	process.exitCode = 1;
});
