import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "s4-artifact-generator.pw.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	globalTimeout: 180_000,
	expect: { timeout: 5_000 },
	use: { browserName: "chromium", headless: true },
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	webServer: [
		{
			command: "pnpm exec tsx tests/opfs-idb-spike/strict-idb-server.ts",
			url: "http://127.0.0.1:43871/",
			reuseExistingServer: false,
			timeout: 15_000,
		},
		{
			command: "pnpm exec tsx tests/opfs-idb-spike/substrate-bench-server.ts",
			url: "http://127.0.0.1:43872/",
			reuseExistingServer: false,
			timeout: 15_000,
		},
		{
			command: "pnpm exec tsx tests/opfs-idb-spike/bucket-clear-server.ts",
			url: "http://127.0.0.1:43873/",
			reuseExistingServer: false,
			timeout: 15_000,
		},
	],
});
