import { defineConfig } from "@playwright/test";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 360_000,
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	retries: 0,
	testDir: "./tests",
	testMatch: "phase-6a-creator-successor-product.pw.ts",
	timeout: 90_000,
	use: { headless: true },
	workers: 1,
});
