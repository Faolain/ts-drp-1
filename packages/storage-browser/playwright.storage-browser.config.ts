import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: "crash-driver.pw.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 180_000,
	globalTimeout: 3_600_000,
	globalSetup: "./tests/global-setup.ts",
	globalTeardown: "./tests/global-teardown.ts",
	use: { browserName: "chromium" },
});
