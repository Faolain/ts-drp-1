import { defineConfig } from "@playwright/test";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	projects: [
		{ name: "chromium", use: { browserName: "chromium", headless: true } },
		{ name: "firefox", use: { browserName: "firefox", headless: true } },
		{ name: "webkit", use: { browserName: "webkit", headless: true } },
	],
	retries: 0,
	testDir: "./tests",
	testMatch: "phase-3a1b-p5-local-author-browser.pw.ts",
	timeout: 90_000,
	workers: 1,
});
