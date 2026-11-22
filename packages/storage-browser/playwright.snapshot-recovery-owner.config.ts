import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 180_000,
	outputDir: resolve(
		import.meta.dirname,
		"../../.logs/snapshot-recovery-owner",
		new Date().toISOString().replaceAll(":", "-")
	),
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	reporter: [["line"]],
	retries: 0,
	testDir: "./tests",
	testMatch: "snapshot-recovery-owner-red.pw.ts",
	timeout: 15_000,
	use: { headless: true },
	workers: 1,
});
