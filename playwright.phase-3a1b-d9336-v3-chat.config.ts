import { defineConfig } from "@playwright/test";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	projects: [{ name: "chromium", use: { browserName: "chromium", headless: true } }],
	retries: 0,
	testDir: "./tests",
	testMatch: "phase-3a1b-d9336-two-client-room.pw.ts",
	timeout: 120_000,
	workers: 1,
});
