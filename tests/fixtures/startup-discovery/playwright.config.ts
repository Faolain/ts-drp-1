import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const evidence = process.env.STARTUP_EVIDENCE;
if (evidence === undefined) throw new Error("STARTUP_EVIDENCE_REQUIRED");
const selectedEntry = process.env.STARTUP_ENTRY;
if (selectedEntry !== undefined && selectedEntry !== "r8-source-binding") throw new Error("STARTUP_ENTRY_INVALID");
export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 600_000,
	outputDir: resolve(evidence, "artifacts"),
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	reporter: [["line"], ["json", { outputFile: resolve(evidence, "report.json") }]],
	retries: 0,
	testDir: ".",
	testMatch: selectedEntry === undefined ? "browser-red.pw.ts" : "r8-source-binding.pw.ts",
	timeout: 90_000,
	use: { headless: true },
	workers: 1,
});
