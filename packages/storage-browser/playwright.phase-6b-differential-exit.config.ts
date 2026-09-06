import { defineConfig } from "@playwright/test";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./tests/phase-6b-differential-exit-global-setup.ts",
	globalTimeout: 120_000,
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	retries: 0,
	testDir: "./tests",
	testMatch: "phase-6b-differential-exit-red.pw.ts",
	timeout: 60_000,
	use: { headless: true },
	workers: 1,
});
