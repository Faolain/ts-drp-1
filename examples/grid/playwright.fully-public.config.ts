import { defineConfig, devices, type Project } from "@playwright/test";

// Fully-public grid harness — discovery via real public Nostr, connectivity candidates via real
// public delegated routing (delegated-ipfs.dev implements /routing/v1/dht/closest/peers and
// surfaces browser-usable AutoTLS relays; cid.contact is a second distinct origin that 404s →
// empty, satisfying the >=2-endpoint requirement). NO local fixtures at all: no local Nostr relay,
// no local routing fixture, no local circuit relays. Opt-in + flaky (live third-party infra);
// run via `pnpm e2e-test:fully-public`. All defaults are env-overridable.
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

// Unique namespace per playwright invocation so runs never see each other's stale records.
// NOTE: the entropy segment must be 22..86 base64url chars (>=16 bytes decoded) — the original
// `fully-public-<ts36>` form was 21 chars, one short, and every registration was rejected
// client-side with `invalid-namespace` (the root cause of the 95/95 publish failures).
const namespace =
	process.env.VITE_RENDEZVOUS_NAMESPACE ??
	`drp-network:v1:${Buffer.from(`fully-public-${Date.now().toString(36)}`).toString("base64url")}`;

export default defineConfig({
	expect: { timeout: 20_000 },
	forbidOnly: Boolean(process.env.CI),
	fullyParallel: false,
	metadata: { gridNetworkMode: "fully-public" },
	projects,
	reporter: "line",
	retries: 0,
	testDir: "./e2e",
	testMatch: /grid-fully-public\.spec\.ts/u,
	timeout: 300_000,
	use: {
		baseURL: "http://127.0.0.1:4174",
		trace: "retain-on-failure",
	},
	webServer: [
		{
			command: "pnpm --filter ts-drp-example-grid dev --host 127.0.0.1 --port 4174",
			env: {
				// NO VITE_ALLOW_INSECURE_FIXTURE: real public infra, real WSS/webtransport only.
				VITE_BOOTSTRAP_PEERS: process.env.VITE_BOOTSTRAP_PEERS ?? "",
				VITE_MEMBERSHIP_INVITE: "grid-fully-public-invite-0123456789",
				VITE_NETWORK_MODE: "modular",
				VITE_NOSTR_RELAYS: process.env.VITE_NOSTR_RELAYS ?? "wss://nos.lol,wss://relay.damus.io",
				VITE_RENDER_INFO_INTERVAL: "250",
				VITE_RENDEZVOUS_ENDPOINTS: "",
				VITE_RENDEZVOUS_NAMESPACE: namespace,
				VITE_ROUTING_ENDPOINTS:
					process.env.VITE_ROUTING_ENDPOINTS ?? "https://delegated-ipfs.dev/,https://cid.contact/",
			},
			reuseExistingServer: false,
			timeout: 120_000,
			url: "http://127.0.0.1:4174",
		},
	],
	workers: 1,
});
