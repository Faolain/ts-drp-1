import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: "phase-2g-b-presence-red.pw.ts",
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./tests/phase-2g-b-presence-global-setup.ts",
	globalTimeout: 120_000,
	projects: [{ name: "chromium", use: { browserName: "chromium", headless: true } }],
	retries: 0,
	timeout: 60_000,
	workers: 1,
});
