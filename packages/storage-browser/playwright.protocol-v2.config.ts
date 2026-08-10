import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: "phase-2h-b-browser-surfaces-red.pw.ts",
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./tests/phase-2h-a-global-setup.ts",
	globalTimeout: 180_000,
	outputDir: "./test-results/playwright-phase-2h-a",
	projects: [
		{ name: "chromium", use: { browserName: "chromium", headless: true } },
		{ name: "firefox", use: { browserName: "firefox", headless: true } },
		{ name: "webkit", use: { browserName: "webkit", headless: true } },
	],
	retries: 0,
	timeout: 45_000,
	use: {
		trace: "retain-on-failure",
	},
	workers: 1,
});
