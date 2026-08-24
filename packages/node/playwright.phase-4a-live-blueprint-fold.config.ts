import { defineConfig } from "@playwright/test";

export default defineConfig({
	fullyParallel: false,
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	reporter: "line",
	testDir: "./tests/browser",
	testMatch: "phase-4a-live-blueprint-fold.pw.ts",
	timeout: 60_000,
	use: { headless: true },
	workers: 1,
});
