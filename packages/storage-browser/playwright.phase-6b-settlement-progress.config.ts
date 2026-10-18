import { defineConfig } from "@playwright/test";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./tests/phase-6b-settlement-progress-global-setup.ts",
	globalTimeout: 120_000,
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	retries: 0,
	testDir: "./tests",
	testMatch: "phase-6b-settlement-progress-red.pw.ts",
	timeout: 60_000,
	use: { headless: true },
	workers: 1,
});
