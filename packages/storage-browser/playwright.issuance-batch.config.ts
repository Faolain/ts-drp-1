import { defineConfig } from "@playwright/test";
export default defineConfig({forbidOnly: true, fullyParallel: false, retries: 0, workers: 1,
	testDir: "./tests", testMatch: "issuance-batch.pw.ts", timeout: 120_000, globalTimeout: 600_000,
	projects: ["chromium", "firefox", "webkit"].map(browserName => ({name: browserName,
		use: {browserName: browserName as "chromium" | "firefox" | "webkit", headless: true}}))});
