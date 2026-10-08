import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/browser",
	testMatch: "phase-2f-c-real-workload.pw.ts",
	forbidOnly: true,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	globalTimeout: 60_000,
	reporter: "list",
	projects: [{ name: "chromium", use: { browserName: "chromium", headless: true } }],
});
