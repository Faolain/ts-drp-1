import { defineConfig, devices, type Project } from "@playwright/test";

const browserDevices = {
	chromium: devices["Desktop Chrome"],
	firefox: devices["Desktop Firefox"],
	webkit: devices["Desktop Safari"],
} as const;
type BrowserName = keyof typeof browserDevices;

const requestedBrowsers = (process.env.GRID_E2E_BROWSERS ?? "chromium")
	.split(",")
	.map((name) => name.trim())
	.filter((name): name is BrowserName => name in browserDevices);
const projects: Project[] = requestedBrowsers.map((name) => ({ name, use: { ...browserDevices[name] } }));

export default defineConfig({
	expect: { timeout: 10_000 },
	forbidOnly: Boolean(process.env.CI),
	fullyParallel: false,
	metadata: { gridNetworkMode: "modular" },
	projects,
	reporter: "line",
	retries: process.env.CI ? 1 : 0,
	testDir: "./e2e",
	testMatch: /grid-modular\.spec\.ts/u,
	timeout: 90_000,
	use: {
		baseURL: "http://127.0.0.1:4174",
		trace: "retain-on-failure",
	},
	webServer: [
		{
			command: "pnpm --filter ts-drp-example-grid dev --host 127.0.0.1 --port 4174",
			env: {
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
				VITE_RENDEZVOUS_NAMESPACE: "drp-network:v1:Z2F0ZS03LWxvY2FsLWZpeHR1cmU",
				VITE_ROUTING_ENDPOINTS: [
					"http://127.0.0.1:4175/fixture/grid-relays-success/primary/",
					"http://127.0.0.1:4175/fixture/grid-relays-success/secondary/",
				].join(","),
			},
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
			url: "http://127.0.0.1:4174",
		},
		{
			command: "pnpm --filter ts-drp-example-network-spike fixtures",
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
