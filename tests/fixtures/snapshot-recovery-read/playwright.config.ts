import { defineConfig } from "@playwright/test";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 360000,
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	retries: 0,
	testDir: ".",
	testMatch: "browser-red.pw.ts",
	timeout: 15000,
	use: { headless: true },
	workers: 3,
});
