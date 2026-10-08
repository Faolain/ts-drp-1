import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "strict-idb-capability-s1-red.pw.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 30_000,
	globalTimeout: 120_000,
	expect: { timeout: 5_000 },
	use: {
		baseURL: "http://127.0.0.1:43871",
		browserName: "chromium",
		headless: true,
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	webServer: {
		command: "pnpm exec tsx tests/opfs-idb-spike/strict-idb-server.ts",
		url: "http://127.0.0.1:43871/",
		reuseExistingServer: false,
		timeout: 15_000,
	},
});
