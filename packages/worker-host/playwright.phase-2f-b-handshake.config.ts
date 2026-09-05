import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/browser",
	testMatch: "phase-2f-b-handshake.pw.ts",
	forbidOnly: true,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	globalTimeout: 180_000,
	reporter: [["list"], ["./tests/browser/fixtures/custody-reporter.ts"]],
	projects: [
		{ name: "firefox", use: { browserName: "firefox", headless: true } },
		{ name: "webkit", use: { browserName: "webkit", headless: true } },
	],
});
