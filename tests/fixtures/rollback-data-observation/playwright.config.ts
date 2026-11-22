import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const evidence = process.env.ROLLBACK_EVIDENCE;
if (!evidence) throw new Error("ROLLBACK_EVIDENCE_REQUIRED");
export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 600000,
	outputDir: resolve(evidence, "artifacts"),
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	reporter: [["line"], ["json", { outputFile: resolve(evidence, "report.json") }]],
	retries: 0,
	testDir: ".",
	testMatch: "browser-red.pw.ts",
	timeout: 90000,
	use: { headless: true },
	workers: 1,
});
