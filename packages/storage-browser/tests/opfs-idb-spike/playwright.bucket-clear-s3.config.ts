import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "bucket-clear-codeletion-s3-red.pw.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 45_000,
	globalTimeout: 120_000,
	expect: { timeout: 5_000 },
	use: { baseURL: "http://127.0.0.1:43873", browserName: "chromium", headless: true },
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	webServer: {
		command: "pnpm exec tsx tests/opfs-idb-spike/bucket-clear-server.ts",
		url: "http://127.0.0.1:43873/",
		reuseExistingServer: false,
		timeout: 15_000,
	},
});
