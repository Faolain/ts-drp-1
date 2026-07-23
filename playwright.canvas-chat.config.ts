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
	VITE_RENDEZVOUS_ENDPOINTS: [
		"http://127.0.0.1:4175/grid-registry/primary",
		"http://127.0.0.1:4175/grid-registry/secondary",
	].join(","),
	VITE_RENDEZVOUS_NAMESPACE: "drp-network:v1:Y2FudmFzLWNoYXQtbG9jYWwtZml4dHVyZQ",
	VITE_ROUTING_ENDPOINTS: [
		"http://127.0.0.1:4175/fixture/grid-relays-success/primary/",
		"http://127.0.0.1:4175/fixture/grid-relays-success/secondary/",
	].join(","),
};

export default defineConfig({
	expect: { timeout: 15_000 },
	forbidOnly: Boolean(process.env.CI),
	fullyParallel: false,
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	reporter: "line",
	retries: 0,
	testDir: "./examples",
	testMatch: /(?:canvas|chat)\/e2e\/.*\.spec\.ts/u,
	timeout: 45_000,
	use: { trace: "retain-on-failure" },
	webServer: [
		{
			command: "pnpm --filter ts-drp-examples-canvas dev --host 127.0.0.1 --port 4180",
			env: modularEnvironment,
			reuseExistingServer: false,
			timeout: 120_000,
			url: "http://127.0.0.1:4180",
		},
		{
			command: "pnpm --filter ts-drp-example-chat dev --host 127.0.0.1 --port 4181",
			env: modularEnvironment,
			reuseExistingServer: false,
			timeout: 120_000,
			url: "http://127.0.0.1:4181",
		},
		{
			command: "pnpm --filter ts-drp-example-network-spike fixtures",
			env: {
				DRP_FIXTURE_ALLOWED_ORIGINS: "http://127.0.0.1:4174,http://127.0.0.1:4180,http://127.0.0.1:4181",
			},
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
			url: "http://127.0.0.1:4175/fixture/grid-relays-success/primary/routing/v1/peers/test",
		},
		{
			command: "pnpm --filter @ts-drp/network-spike grid:relay ../../configs/network-spike-relay.json 51000",
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
			url: "http://127.0.0.1:51000/health",
		},
		{
			command:
				"pnpm --filter @ts-drp/network-spike grid:relay ../../configs/network-spike-relay-replacement.json 51002",
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
			url: "http://127.0.0.1:51002/health",
		},
	],
	workers: 1,
});
