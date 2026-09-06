import { defineConfig } from "@playwright/test";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./tests/phase-3a0-d-global-setup.ts",
	globalTimeout: 300_000,
	projects: [
		{ name: "chromium", use: { browserName: "chromium", headless: true } },
		{ name: "firefox", use: { browserName: "firefox", headless: true } },
		{ name: "webkit", use: { browserName: "webkit", headless: true } },
	],
	retries: 0,
	testDir: "./tests",
	testMatch: "phase-3a0-d-anchor-trust-browser-parity-red.pw.ts",
	timeout: 90_000,
	workers: 1,
});
