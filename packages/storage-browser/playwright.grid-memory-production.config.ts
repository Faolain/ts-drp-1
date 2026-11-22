import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 180_000,
	outputDir: resolve(
		import.meta.dirname,
		"../../.logs/grid-memory-production",
		new Date().toISOString().replaceAll(":", "-")
	),
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	reporter: [["line"]],
	retries: 0,
	testDir: "./tests",
	testMatch: "grid-memory-production.pw.ts",
	timeout: 120_000,
	use: { headless: true },
	workers: 1,
});
