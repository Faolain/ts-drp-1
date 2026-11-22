import { defineConfig } from "@playwright/test";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./tests/phase-3a1b-p4-global-setup.ts",
	globalTimeout: 3_600_000,
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	retries: 0,
	testDir: "./tests",
	testMatch: "phase-3a1b-p4-browser-live-journal-death-red.pw.ts",
	timeout: 1_200_000,
	use: { headless: true },
	workers: 1,
});
