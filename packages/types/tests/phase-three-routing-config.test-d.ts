import type { ControlPlaneConfig, DRPNetworkNodeConfig } from "@ts-drp/types";

const bootstrappers = ["/dnsaddr/bootstrap.libp2p.io/p2p/QmFixture"] as const;

const phaseThreeRouting: ControlPlaneConfig = {
	routing: {
		browser: {
			allow_insecure_loopback_fixture: true,
			allow_single_endpoint_fixture: true,
			endpoints: ["https://routing-a.example/v1/", "https://routing-b.example/v1/"],
			limits: {
				maxAddressesPerPeer: 16,
				maxEndpoints: 4,
				maxResponseBytes: 262_144,
				maxResults: 32,
			},
		},
		node: {
			bootstrappers,
			enabled: true,
			network: "public",
			public_network_acknowledgement: "I_ACKNOWLEDGE_PUBLIC_NETWORK_TRAFFIC",
		},
	},
};

const phaseThreeNetworkConfig: DRPNetworkNodeConfig = { control_plane: phaseThreeRouting };
void phaseThreeNetworkConfig;

const unknownNodeKey: ControlPlaneConfig = {
	routing: {
		node: {
			enabled: true,
			// @ts-expect-error node routing rejects unowned configuration keys.
			registry: "https://registry.example",
		},
	},
};

const unknownBrowserKey: ControlPlaneConfig = {
	routing: {
		browser: {
			endpoints: ["https://routing-a.example/v1/", "https://routing-b.example/v1/"],
			// @ts-expect-error browser routing rejects unowned configuration keys.
			retries: 5,
		},
	},
};

const invalidNetwork: ControlPlaneConfig = {
	routing: {
		node: {
			// @ts-expect-error only the local and public Amino policies are valid.
			network: "private",
		},
	},
};

void unknownNodeKey;
void unknownBrowserKey;
void invalidNetwork;
