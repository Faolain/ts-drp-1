import { defineConfig } from "@playwright/test";

// Slice 14f mechanism cases 1-4 for the slice 14a room retirement session.
export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 600_000,
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	retries: 0,
	testDir: "./tests",
	testMatch: "room-retirement-session-native.pw.ts",
	timeout: 120_000,
	use: { headless: true },
	workers: 1,
});
