import { describe, expect, it } from "vitest";

import {
	buildModularNetworkConfig,
	getNetworkConfigFromEnv,
	type GridNetworkEnv,
	isModularNetworkEnv,
} from "./network-config";

const modularEnvironment: GridNetworkEnv = {
	allowInsecureFixture: undefined,
	bootstrapPeers: "/dns4/fixed-seed.invalid/tcp/443/wss/p2p/seed",
	discoveryInterval: 0,
	enablePrometheusMetrics: false,
	membershipInvite: "grid-fixture-invite-0123456789",
	networkMode: "modular",
	rendezvousEndpoints: "https://registry-a.example,https://registry-b.example",
	rendezvousInvite: "signed-rendezvous-invite",
	rendezvousNamespace: "drp-network:v1:Z2F0ZS03LWNvbmZpZy10ZXN0",
	routingEndpoints: "https://routing-a.example/routing/v1/,https://routing-b.example/routing/v1/",
};

describe("grid network configuration", () => {
	it("builds a Nostr-only modular control plane", () => {
		const environment = {
			...modularEnvironment,
			networkMode: undefined,
			nostrRelays: ["wss://relay.example"],
			rendezvousEndpoints: undefined,
		};

		expect(isModularNetworkEnv(environment)).toBe(true);
		const config = buildModularNetworkConfig(environment);

		expect(config.network_config?.control_plane?.rendezvous?.nostr?.relays).toEqual(["wss://relay.example"]);
		expect(config.network_config?.control_plane?.rendezvous?.endpoints).toEqual([]);
		expect(config.network_config?.control_plane?.rollout?.public_components?.public_rendezvous).toEqual({
			enabled: true,
		});
	});

	it("includes an explicit Nostr transport secret key", () => {
		const secretKey = "ab".repeat(32);
		const config = buildModularNetworkConfig({
			...modularEnvironment,
			nostrRelays: ["wss://relay.example"],
			nostrSecretKey: secretKey,
			rendezvousEndpoints: undefined,
		});

		expect(config.network_config?.control_plane?.rendezvous?.nostr).toEqual({
			relays: ["wss://relay.example"],
			secret_key: secretKey,
		});
	});

	it("composes HTTP registries and Nostr relays", () => {
		const config = buildModularNetworkConfig({
			...modularEnvironment,
			nostrRelays: ["wss://relay.example"],
		});

		expect(config.network_config?.control_plane?.rendezvous).toMatchObject({
			endpoints: ["https://registry-a.example", "https://registry-b.example"],
			nostr: { relays: ["wss://relay.example"] },
		});
	});

	it("builds the complete no-seed modular control plane", () => {
		const config = buildModularNetworkConfig(modularEnvironment);

		expect(config.network_config?.bootstrap_peers).toEqual([]);
		expect(config.network_config?.control_plane).toMatchObject({
			address_policy: { target: "browser" },
			membership: {
				invite: { inviteToken: "grid-fixture-invite-0123456789" },
				mode: "invite",
			},
			recovery: {
				backend_cooldown_ms: 1_000,
				max_attempts: 3,
				parent_deadline_ms: 10_000,
			},
			relay_policy: {
				sources: { delegated_closest_peers: { enabled: true } },
				target_reservations: 1,
			},
			rendezvous: {
				endpoints: ["https://registry-a.example", "https://registry-b.example"],
				invite: "signed-rendezvous-invite",
				namespace: "drp-network:v1:Z2F0ZS03LWNvbmZpZy10ZXN0",
				publish: true,
			},
			rollout: {
				public_components: {
					delegated_routing: { enabled: true },
					public_relay_overflow: { enabled: true },
					public_rendezvous: { enabled: true },
				},
			},
			routing: {
				browser: {
					endpoints: ["https://routing-a.example/routing/v1/", "https://routing-b.example/routing/v1/"],
				},
			},
		});
	});

	it.each([undefined, "", "false", "0"])("keeps fixture allowances off for %j", (flag) => {
		const controlPlane = buildModularNetworkConfig({
			...modularEnvironment,
			allowInsecureFixture: flag,
		}).network_config?.control_plane;

		expect(controlPlane?.address_policy).not.toHaveProperty("allowInsecureWebSocket");
		expect(controlPlane?.address_policy).not.toHaveProperty("allowLoopback");
		expect(controlPlane?.address_policy).not.toHaveProperty("allowPrivate");
		expect(controlPlane?.rendezvous).not.toHaveProperty("allow_insecure_loopback_fixture");
		expect(controlPlane?.routing?.browser).not.toHaveProperty("allow_insecure_loopback_fixture");
		expect(controlPlane?.routing?.browser).not.toHaveProperty("allow_single_endpoint_fixture");
	});

	it.each(["true", "1"])("enables fixture allowances only for explicit %s", (flag) => {
		const controlPlane = buildModularNetworkConfig({
			...modularEnvironment,
			allowInsecureFixture: flag,
		}).network_config?.control_plane;

		expect(controlPlane?.address_policy).toMatchObject({
			allowInsecureWebSocket: true,
			allowLoopback: true,
			// Local fixtures advertise private-LAN circuit addresses (the relay binds to the host LAN IP);
			// without allowPrivate the whole rendezvous record is rejected as scope-private.
			allowPrivate: true,
		});
		expect(controlPlane?.rendezvous?.allow_insecure_loopback_fixture).toBe(true);
		expect(controlPlane?.routing?.browser).toMatchObject({
			allow_insecure_loopback_fixture: true,
			allow_single_endpoint_fixture: true,
		});
	});

	it("preserves the legacy fixed-bootstrap path when modular mode is absent", () => {
		const config = getNetworkConfigFromEnv(
			{
				bootstrapPeers: "seed-a,seed-b",
				discoveryInterval: 2_500,
				enablePrometheusMetrics: true,
			},
			"http://127.0.0.1:5173"
		);

		expect(config).toEqual({
			network_config: {
				bootstrap_peers: ["seed-a", "seed-b"],
				browser_metrics: true,
				pubsub: {
					peer_discovery_interval: 2_500,
					prometheus_metrics: true,
					pushgateway_url: "http://127.0.0.1:5173",
				},
			},
		});
	});
});
