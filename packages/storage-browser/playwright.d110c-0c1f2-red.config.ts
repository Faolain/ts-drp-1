import { defineConfig } from "@playwright/test";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 360_000,
	grep: /D\.110c-0c1f2 non-creator writer requires an authenticated historical frontier/u,
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	retries: 0,
	testDir: "./tests",
	testMatch: "phase-6a-creator-successor-product.pw.ts",
	timeout: 300_000,
	use: { headless: true },
	workers: 1,
});
