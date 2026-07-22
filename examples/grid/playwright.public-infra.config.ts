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

const RELAY_A = "16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5";
const RELAY_B = "16Uiu2HAmT72TapomemeWskZbmzd4hZcakAzYnTwLtbdsvdaSUvXU";

// Public-infra profile: discovery is Nostr-only (VITE_RENDEZVOUS_ENDPOINTS is empty, so
// no HTTP registry exists). A local `ws` Nostr relay fixture stands in for a public relay.
export default defineConfig({
	expect: { timeout: 15_000 },
	forbidOnly: Boolean(process.env.CI),
	fullyParallel: false,
	metadata: { gridNetworkMode: "public-infra" },
	projects,
	reporter: "line",
	retries: process.env.CI ? 1 : 0,
	testDir: "./e2e",
	testMatch: /grid-public-infra\.spec\.ts/u,
	timeout: 120_000,
	use: {
		baseURL: "http://127.0.0.1:4174",
		trace: "retain-on-failure",
	},
	webServer: [
		{
			command: "pnpm --filter ts-drp-example-network-spike fixtures:routing-only",
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
			url: "http://127.0.0.1:4175/fixture/grid-relays-success/primary/routing/v1/peers/test",
		},
		{
			command: "pnpm --filter ts-drp-example-network-spike fixtures:nostr 4180",
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
			url: "http://127.0.0.1:4180/health",
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
		{
			command: "pnpm --filter ts-drp-example-grid dev --host 127.0.0.1 --port 4174",
			env: {
				VITE_ALLOW_INSECURE_FIXTURE: "true",
				VITE_BOOTSTRAP_PEERS: "",
				VITE_MEMBERSHIP_INVITE: "grid-local-demo-invite-0123456789",
				VITE_NETWORK_MODE: "modular",
				VITE_NOSTR_RELAYS: "ws://127.0.0.1:4180",
				VITE_RELAY_OPERATOR_GROUPS: [`${RELAY_A}=demo-operator-a`, `${RELAY_B}=demo-operator-b`].join(","),
				VITE_RENDER_INFO_INTERVAL: "250",
				VITE_RENDEZVOUS_ENDPOINTS: "",
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
	],
	workers: 1,
});
