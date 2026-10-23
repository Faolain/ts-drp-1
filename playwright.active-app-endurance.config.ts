import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./tests/fixtures/track-m-apps/browser/global-setup.ts",
	globalTimeout: 21_600_000,
	outputDir: join(process.env.ACTIVE_ENDURANCE_OUT ?? tmpdir(), "active-browser-results"),
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	reporter: [["line"]],
	retries: 0,
	testDir: "./tests/fixtures/active-endurance",
	testMatch: "browser.pw.ts",
	timeout: 3_600_000,
	use: { headless: true },
	workers: 1,
});
