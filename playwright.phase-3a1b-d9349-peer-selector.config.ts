import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	expect: { timeout: 20_000 },
	forbidOnly: Boolean(process.env.CI),
	fullyParallel: false,
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	reporter: "line",
	retries: 0,
	testDir: "./tests",
	testMatch: /phase-3a1b-d9349-peer-selector-50-browser\.pw\.ts/u,
	timeout: 300_000,
	use: { baseURL: "http://127.0.0.1:4194", trace: "retain-on-failure" },
	webServer: {
		command: "pnpm --filter ts-drp-example-grid dev --host 127.0.0.1 --port 4194",
		env: {
			VITE_ALLOW_INSECURE_FIXTURE: "true",
			VITE_BOOTSTRAP_PEERS: "",
			VITE_MEMBERSHIP_INVITE: "t3-browser-fixture-invite-0123456789",
			VITE_NETWORK_MODE: "modular",
			VITE_NOSTR_RELAYS: "wss://relay.invalid",
			VITE_RENDEZVOUS_NAMESPACE: "drp-network:v1:dDMtYnJvd3Nlci1maXh0dXJl",
			VITE_ROUTING_ENDPOINTS: "https://routing.invalid/routing/v1/",
		},
		reuseExistingServer: false,
		timeout: 120_000,
		url: "http://127.0.0.1:4194",
	},
	workers: 1,
});
