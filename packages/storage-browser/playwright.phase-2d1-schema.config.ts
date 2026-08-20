import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: "phase-2d1-schema-lifecycle-red.pw.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 10_000,
	globalTimeout: 90_000,
	expect: { timeout: 2_000 },
	use: {
		baseURL: "http://127.0.0.1:43875",
		browserName: "chromium",
		headless: true,
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	webServer: {
		command: "pnpm exec tsx tests/phase-2d1-schema-server.ts",
		url: "http://127.0.0.1:43875/",
		reuseExistingServer: false,
		timeout: 15_000,
	},
});
