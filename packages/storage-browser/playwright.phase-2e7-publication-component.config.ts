import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: "phase-2e7-publication-component.pw.ts",
	forbidOnly: true,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	globalTimeout: 120_000,
	globalSetup: "./tests/phase-2e7-global-setup.ts",
	projects: [{ name: "chromium", use: { browserName: "chromium", headless: true } }],
});
