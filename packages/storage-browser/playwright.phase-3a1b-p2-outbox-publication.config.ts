import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "tests",
	testMatch: ["phase-3a1b-p2-browser-outbox-publication-death-red.pw.ts"],
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./tests/phase-3a1b-p2-global-setup.ts",
	globalTimeout: 300_000,
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	retries: 0,
	timeout: 240_000,
	use: { browserName: "chromium", headless: true },
	workers: 1,
});
