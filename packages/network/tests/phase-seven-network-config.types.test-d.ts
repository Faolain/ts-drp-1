import type { ControlPlaneConfig, DRPNetworkNodeConfig } from "@ts-drp/types";

import type {
	AuthenticatedPeerBehaviorProvider,
	DRPNetworkHostConfigSnapshot,
	DRPNetworkNodeDependencies,
} from "../src/node.js";

const scoringConfig: NonNullable<ControlPlaneConfig["pubsub_scoring"]> = {
	ip_colocation: {
		enabled: true,
		threshold: 2,
		weight: -5,
		whitelist: ["127.0.0.1", "10.20.30.40"],
	},
	observed_behavior_reward: {
		enabled: true,
		max_application_score: 0.5,
	},
};

const rolloutConfig: NonNullable<ControlPlaneConfig["rollout"]> = {
	owned_fallback: {
		configured_relays: { enabled: true },
		local_routing: { enabled: true },
		owned_rendezvous: { enabled: true },
	},
	public_components: {
		delegated_routing: { enabled: false },
		public_relay_overflow: { enabled: false },
		public_rendezvous: { enabled: false },
		pubsub_behavior_rewards: { enabled: false },
	},
};

const phaseSevenConfig: DRPNetworkNodeConfig = {
	control_plane: {
		pubsub_scoring: scoringConfig,
		rollout: rolloutConfig,
	},
};

const behaviorProvider: AuthenticatedPeerBehaviorProvider = {
	getObservedPeerBehavior: (_peerId: string) => ({
		authenticated: true,
		diversityScore: 0.25,
		validBehaviorScore: 0.25,
	}),
};

const dependencies: DRPNetworkNodeDependencies = {
	authenticatedPeerBehaviorProvider: behaviorProvider,
};

type RolloutSnapshot = NonNullable<DRPNetworkHostConfigSnapshot["rollout"]>;
const resolvedOwnedFallback: RolloutSnapshot["ownedFallback"] = {
	configuredRelays: true,
	localRouting: true,
	ownedRendezvous: true,
};

type OwnedFallback = NonNullable<NonNullable<ControlPlaneConfig["rollout"]>["owned_fallback"]>;
type ConfiguredRelayEnabled = NonNullable<OwnedFallback["configured_relays"]>["enabled"];
type FalseCanDisableOwnedFallback = false extends ConfiguredRelayEnabled ? true : false;
const falseCannotDisableOwnedFallback: FalseCanDisableOwnedFallback = false;

void phaseSevenConfig;
void dependencies;
void resolvedOwnedFallback;
void falseCannotDisableOwnedFallback;
