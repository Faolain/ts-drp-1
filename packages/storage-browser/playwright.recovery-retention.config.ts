import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 180_000,
	outputDir: resolve(
		import.meta.dirname,
		"../../.logs/recovery-retention",
		new Date().toISOString().replaceAll(":", "-")
	),
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	reporter: [["line"]],
	retries: 0,
	testDir: "./tests",
	testMatch: "recovery-retention-red.pw.ts",
	timeout: 120_000,
	workers: 1,
});
