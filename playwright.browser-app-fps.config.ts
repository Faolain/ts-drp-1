import { defineConfig, devices } from "@playwright/test";

// Browser app FPS gate (tests/browser-app-fps.pw.ts): serves the shipped Grid, Canvas and Chat
// pages from their own dev servers with the local registry/routing fixtures and relays, exactly as
// playwright.phase-3a1b-d9346-zone.config.ts (Grid) and playwright.app-rollover-delivery.config.ts
// (Canvas, Chat) do, on Chromium, Firefox and WebKit. Every server is started fresh for the run.
// Run one engine at a time (--project), on a quiet host: frame timing is the measurement.

const fixtureEnvironment = {
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
	VITE_ROUTING_ENDPOINTS: [
		"http://127.0.0.1:4175/fixture/grid-relays-success/primary/",
		"http://127.0.0.1:4175/fixture/grid-relays-success/secondary/",
	].join(","),
};
const gridEnvironment = {
	...fixtureEnvironment,
	VITE_RENDER_INFO_INTERVAL: "250",
	VITE_RENDEZVOUS_NAMESPACE: "drp-network:v1:ZDM5MzQ2LXpvbmUtbG9jYWwtZml4dHVyZQ",
};
const canvasChatEnvironment = {
	...fixtureEnvironment,
	VITE_RENDEZVOUS_NAMESPACE: "drp-network:v1:Y2FudmFzLWNoYXQtbG9jYWwtZml4dHVyZQ",
};

export default defineConfig({
	expect: { timeout: 20_000 },
	forbidOnly: true,
	fullyParallel: false,
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
		{ name: "webkit", use: { ...devices["Desktop Safari"] } },
	],
	reporter: "line",
	retries: 0,
	testDir: "./tests",
	testMatch: /browser-app-fps\.pw\.ts/u,
	timeout: 3_600_000,
	use: { headless: true, trace: "off" },
	webServer: [
		{
			command: "pnpm --filter ts-drp-example-grid dev --host 127.0.0.1 --port 4174",
			env: gridEnvironment,
			reuseExistingServer: false,
			timeout: 120_000,
			url: "http://127.0.0.1:4174",
		},
		{
			command: "pnpm --filter ts-drp-examples-canvas dev --host 127.0.0.1 --port 4180",
			env: canvasChatEnvironment,
			reuseExistingServer: false,
			timeout: 120_000,
			url: "http://127.0.0.1:4180",
		},
		{
			command: "pnpm --filter ts-drp-example-chat dev --host 127.0.0.1 --port 4181",
			env: canvasChatEnvironment,
			reuseExistingServer: false,
			timeout: 120_000,
			url: "http://127.0.0.1:4181",
		},
		{
			command: "pnpm --filter ts-drp-example-network-spike fixtures",
			env: { DRP_FIXTURE_ALLOWED_ORIGINS: "http://127.0.0.1:4174,http://127.0.0.1:4180,http://127.0.0.1:4181" },
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
