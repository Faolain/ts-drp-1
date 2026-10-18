import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 360_000,
	outputDir: resolve(
		import.meta.dirname,
		"../../.logs/snapshot-recovery-retention",
		new Date().toISOString().replaceAll(":", "-")
	),
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	reporter: [["line"]],
	retries: 0,
	testDir: "./tests",
	testMatch: "snapshot-recovery-retention-red.pw.ts",
	timeout: 15_000,
	use: { headless: true },
	workers: 1,
});
