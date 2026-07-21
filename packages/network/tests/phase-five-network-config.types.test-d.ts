import type { ControlPlaneConfig, DRPNetworkNodeConfig } from "@ts-drp/types";

const configuredRelayPolicy: ControlPlaneConfig = {
	relay_policy: {
			sources: {
				cached_successful_relays: { enabled: true },
				configured_fallback: { enabled: true },
			delegated_closest_peers: { enabled: false },
			dht_relay_providers: { enabled: false },
			node_closest_peers: { enabled: false },
			registry_relay_records: { enabled: true },
		},
		target_reservations: 2,
	},
};

const publicSourcesOmittedForDisabledDefaults: DRPNetworkNodeConfig = {
	control_plane: {
			relay_policy: {
				sources: {
					configured_fallback: {},
			},
		},
	},
};

type RelayPolicyConfig = NonNullable<ControlPlaneConfig["relay_policy"]>;
type PhaseFiveSources = NonNullable<RelayPolicyConfig["sources"]>;
type IsAny<Value> = 0 extends 1 & Value ? true : false;
const sourcesAreTyped: IsAny<PhaseFiveSources> extends false ? true : never = true;
const dhtEnableFlag: NonNullable<PhaseFiveSources["dht_relay_providers"]>["enabled"] = true;
const configuredFallbackEnabled: NonNullable<PhaseFiveSources["configured_fallback"]>["enabled"] = true;

void configuredRelayPolicy;
void publicSourcesOmittedForDisabledDefaults;
void sourcesAreTyped;
void dhtEnableFlag;
void configuredFallbackEnabled;
