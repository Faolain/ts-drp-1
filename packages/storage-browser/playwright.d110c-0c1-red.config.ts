import { defineConfig } from "@playwright/test";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 300_000,
	grep: /D\.110c-0c1 cold reopens a genuine hot epoch-3 successor with authenticated historical issuance/u,
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	retries: 0,
	testDir: "./tests",
	testMatch: "phase-6a-creator-successor-product.pw.ts",
	timeout: 240_000,
	use: { headless: true },
	workers: 1,
});
