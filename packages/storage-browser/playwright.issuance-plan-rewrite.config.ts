import { defineConfig } from "@playwright/test";
export default defineConfig({forbidOnly: true, fullyParallel: false, retries: 0, workers: 1,
	testDir: "./tests", testMatch: "issuance-plan-rewrite.pw.ts", timeout: 60_000, globalTimeout: 300_000,
	projects: ["chromium", "firefox", "webkit"].map(browserName => ({name: browserName,
		use: {browserName: browserName as "chromium" | "firefox" | "webkit", headless: true}}))});
