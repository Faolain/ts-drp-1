import { defineConfig, devices } from "@playwright/test";

const modularEnvironment = {
	VITE_ALLOW_INSECURE_FIXTURE: "true",
	VITE_BOOTSTRAP_PEERS: "",
	VITE_MEMBERSHIP_INVITE: "grid-local-fixture-invite-0123456789",
	VITE_NETWORK_MODE: "modular",
	VITE_RELAY_OPERATOR_GROUPS: [
		"16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5=fixture-operator-a",
		"16Uiu2HAmT72TapomemeWskZbmzd4hZcakAzYnTwLtbdsvdaSUvXU=fixture-operator-b",
	].join(","),
	VITE_RENDER_INFO_INTERVAL: "250",
	VITE_RENDEZVOUS_ENDPOINTS: [
		"http://127.0.0.1:4175/grid-registry/primary",
		"http://127.0.0.1:4175/grid-registry/secondary",
	].join(","),
	VITE_RENDEZVOUS_NAMESPACE: "drp-network:v1:ZTMtMDMtbG9zcy1ob2wtZml4dHVyZQ",
	VITE_ROUTING_ENDPOINTS: [
		"http://127.0.0.1:4175/fixture/grid-relays-success/primary/",
		"http://127.0.0.1:4175/fixture/grid-relays-success/secondary/",
	].join(","),
};

export default defineConfig({
	expect: { timeout: 20_000 },
	forbidOnly: Boolean(process.env.CI),
	fullyParallel: false,
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	reporter: "line",
	retries: 0,
	testDir: "./tests",
	testMatch: /e3-03-loss-and-hol-proof\.pw\.ts/u,
	timeout: 180_000,
	use: { baseURL: "http://127.0.0.1:4174", trace: "retain-on-failure" },
	webServer: [
		{
			command: "pnpm --filter ts-drp-example-grid dev --host 127.0.0.1 --port 4174",
			env: modularEnvironment,
			reuseExistingServer: false,
			timeout: 120_000,
			url: "http://127.0.0.1:4174",
		},
		{
			command: "pnpm --filter ts-drp-example-network-spike fixtures",
			env: { DRP_FIXTURE_ALLOWED_ORIGINS: "http://127.0.0.1:4174" },
			reuseExistingServer: false,
			timeout: 120_000,
			url: "http://127.0.0.1:4175/fixture/grid-relays-success/primary/routing/v1/peers/test",
		},
		{
			command: "pnpm --filter @ts-drp/network-spike grid:relay ../../configs/network-spike-relay.json 51000",
			reuseExistingServer: false,
			timeout: 120_000,
			url: "http://127.0.0.1:51000/health",
		},
		{
			command:
				"pnpm --filter @ts-drp/network-spike grid:relay ../../configs/network-spike-relay-replacement.json 51002",
			reuseExistingServer: false,
			timeout: 120_000,
			url: "http://127.0.0.1:51002/health",
		},
	],
	workers: 1,
});
