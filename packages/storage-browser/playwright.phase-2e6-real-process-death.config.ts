import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: "phase-2e6-real-process-death-red.pw.ts",
	forbidOnly: true,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 180_000,
	globalTimeout: 300_000,
	globalSetup: "./tests/phase-2e6-global-setup.ts",
	expect: { timeout: 3_000 },
	use: {
		baseURL: "http://127.0.0.1:43877",
		browserName: "chromium",
		headless: true,
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
