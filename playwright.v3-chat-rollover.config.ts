import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	expect: { timeout: 15_000 },
	forbidOnly: Boolean(process.env.CI),
	fullyParallel: false,
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
		{ name: "webkit", use: { ...devices["Desktop Safari"] } },
	],
	reporter: "line",
	retries: 0,
	testDir: "./tests",
	testMatch: "v3-chat-rollover.pw.ts",
	timeout: 420_000,
	use: { trace: "retain-on-failure" },
	workers: 1,
});
