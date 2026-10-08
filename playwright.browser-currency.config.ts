import { defineConfig, devices } from "@playwright/test";

/**
 * Phase 2k observes only the three engines shipped by the exact root Playwright
 * pin. Playwright WebKit is an engine observation and never a Safari claim.
 */
export default defineConfig({
	forbidOnly: Boolean(process.env.CI),
	fullyParallel: true,
	globalSetup: "./tests/platform/phase-2k-browser-currency-global-setup.ts",
	outputDir: "./test-results/phase-2k/playwright",
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
		{ name: "webkit", use: { ...devices["Desktop Safari"] } },
	],
	reporter: "line",
	retries: 0,
	testDir: "./tests/platform",
	testMatch: /phase-2k-browser-currency\.pw\.ts/u,
	timeout: 30_000,
	use: { trace: "retain-on-failure" },
});
