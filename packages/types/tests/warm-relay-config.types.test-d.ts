import type { ControlPlaneConfig } from "@ts-drp/types";

const configuredPublicRelay =
	"/dns4/configured-public.example.test/tcp/443/wss/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";

const controlPlane: ControlPlaneConfig = {
	relay_policy: {
		sources: {
			configured_relays: [configuredPublicRelay],
		},
	},
};

type RelayPolicy = NonNullable<ControlPlaneConfig["relay_policy"]>;
type Sources = NonNullable<RelayPolicy["sources"]>;
const configuredRelays: NonNullable<Sources["configured_relays"]> = [configuredPublicRelay];

void controlPlane;
void configuredRelays;
