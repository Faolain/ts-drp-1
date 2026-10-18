import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: "phase-2g-c-quota-fault-red.pw.ts",
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 60_000,
	projects: [{ name: "chromium", use: { browserName: "chromium", headless: true } }],
	retries: 0,
	timeout: 30_000,
	use: { baseURL: "http://127.0.0.1:43880" },
	workers: 1,
	webServer: {
		command: "pnpm exec tsx tests/phase-2g-c-quota-fault-server.ts",
		reuseExistingServer: false,
		timeout: 15_000,
		url: "http://127.0.0.1:43880/inventory",
	},
});
