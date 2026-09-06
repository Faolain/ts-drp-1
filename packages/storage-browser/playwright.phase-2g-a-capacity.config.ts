import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: "phase-2g-a-capacity-red.pw.ts",
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./tests/phase-2g-a-capacity-global-setup.ts",
	globalTimeout: 210_000,
	projects: [
		{ name: "chromium", use: { browserName: "chromium", headless: true } },
		{ name: "firefox", use: { browserName: "firefox", headless: true } },
		{ name: "webkit", use: { browserName: "webkit", headless: true } },
	],
	retries: 0,
	timeout: 60_000,
	workers: 1,
});
