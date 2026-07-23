import { describe, expect, it } from "vitest";

import { type BrowserNetworkEnv, buildModularNetworkConfig } from "./config.js";

const productionEnvironment: BrowserNetworkEnv = {
	allowInsecureFixture: undefined,
	bootstrapPeers: "",
	discoveryInterval: 0,
	enablePrometheusMetrics: false,
	membershipInvite: "browser-network-fixture-invite",
	networkMode: "modular",
	nostrRelays: ["wss://relay.example"],
	rendezvousNamespace: `drp-network:v1:${"b".repeat(43)}`,
	routingEndpoints: "https://routing-a.example/,https://routing-b.example/",
};

describe("browser network rendezvous refresh configuration", () => {
	it("uses the node's TTL-based default in production and keeps fast fixture churn", () => {
		const production = buildModularNetworkConfig(productionEnvironment).network_config?.control_plane?.rendezvous;
		const fixture = buildModularNetworkConfig({
			...productionEnvironment,
			allowInsecureFixture: "true",
		}).network_config?.control_plane?.rendezvous;

		expect(production?.record_ttl_ms).toBe(60_000);
		expect(production).not.toHaveProperty("refresh_interval_ms");
		expect(fixture).toMatchObject({
			record_ttl_ms: 60_000,
			refresh_interval_ms: 1_000,
		});
		expect.soft(production?.room_presence).toEqual({ enabled: true });
		expect.soft(fixture?.room_presence).toEqual({ enabled: true });
	});
});
