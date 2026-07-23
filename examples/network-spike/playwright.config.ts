import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	expect: {
		timeout: 5_000,
	},
	fullyParallel: true,
	// The browser-DHT projects intentionally share one bounded local DHT peer.
	// Serial workers keep exact-reason evidence deterministic under the matrix.
	workers: 1,
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
		{ name: "webkit", use: { ...devices["Desktop Safari"] } },
	],
	reporter: "line",
	testDir: "./e2e",
	use: {
		baseURL: "http://127.0.0.1:4174",
		trace: "retain-on-failure",
	},
	webServer: [
		{
			command: "pnpm --filter ts-drp-example-network-spike dev --host 127.0.0.1 --port 4174",
			reuseExistingServer: true,
			timeout: 120_000,
			url: "http://127.0.0.1:4174/evidence?fixture=all-refused",
		},
		{
			command: "pnpm --filter ts-drp-example-network-spike fixtures",
			reuseExistingServer: true,
			timeout: 120_000,
			url: "http://127.0.0.1:4175/fixture/success/primary/routing/v1/peers/test",
		},
		{
			command: "pnpm --filter ts-drp-example-network-spike fixtures:dht",
			reuseExistingServer: true,
			timeout: 120_000,
			url: "http://127.0.0.1:4177/health",
		},
		{
			command: "pnpm --filter @ts-drp/network-spike grid:relay ../../configs/network-spike-relay.json 51000",
			reuseExistingServer: true,
			timeout: 120_000,
			url: "http://127.0.0.1:51000/health",
		},
		{
			command:
				"pnpm --filter @ts-drp/network-spike grid:relay ../../configs/network-spike-relay-replacement.json 51002",
			reuseExistingServer: true,
			timeout: 120_000,
			url: "http://127.0.0.1:51002/health",
		},
		{
			command: "pnpm --filter @ts-drp/network-spike grid:relay ../../configs/network-spike-relay-refusal-a.json 51004",
			reuseExistingServer: true,
			timeout: 120_000,
			url: "http://127.0.0.1:51004/health",
		},
		{
			command: "pnpm --filter @ts-drp/network-spike grid:relay ../../configs/network-spike-relay-refusal-b.json 51006",
			reuseExistingServer: true,
			timeout: 120_000,
			url: "http://127.0.0.1:51006/health",
		},
	],
});
