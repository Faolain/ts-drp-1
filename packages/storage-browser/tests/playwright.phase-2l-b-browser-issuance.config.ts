import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: ["phase-2l-b-browser-issuance-red.pw.ts", "phase-2l-b-browser-death-red.pw.ts"],
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./phase-2l-b-global-setup.ts",
	globalTimeout: 300_000,
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	retries: 0,
	timeout: 120_000,
	use: { baseURL: "http://127.0.0.1:43891", browserName: "chromium", headless: true },
	workers: 1,
});
