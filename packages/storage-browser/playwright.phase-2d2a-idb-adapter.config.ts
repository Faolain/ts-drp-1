import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: [
		"phase-2d2a-idb-adapter-red.pw.ts",
		"phase-2e1-bounded-reads-red.pw.ts",
		"phase-2e2-taxonomy-poison-red.pw.ts",
		"phase-2e3-recovery-authority-red.pw.ts",
		"phase-2e4-lifecycle-backend-red.pw.ts",
	],
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 15_000,
	globalTimeout: 120_000,
	expect: { timeout: 3_000 },
	use: {
		baseURL: "http://127.0.0.1:43876",
		browserName: "chromium",
		headless: true,
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	webServer: {
		command: "pnpm exec tsx tests/phase-2d2a-idb-adapter-server.ts",
		url: "http://127.0.0.1:43876/",
		reuseExistingServer: false,
		timeout: 15_000,
	},
});
