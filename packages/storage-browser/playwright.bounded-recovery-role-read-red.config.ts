import { defineConfig } from "@playwright/test";
export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 600_000,
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	retries: 0,
	testDir: "./tests",
	testMatch: "bounded-recovery-role-read-red.pw.ts",
	timeout: 90_000,
	use: { headless: true },
	workers: 1,
});
