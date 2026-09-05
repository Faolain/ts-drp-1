import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "tests",
	testMatch: ["phase-2l-d-browser-parity-red.pw.ts"],
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./tests/phase-2l-d-global-setup.ts",
	globalTimeout: 180_000,
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	retries: 0,
	timeout: 90_000,
	workers: 1,
});
