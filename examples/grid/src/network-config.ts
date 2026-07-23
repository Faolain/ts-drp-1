import {
	allowsInsecureNetworkFixture,
	type BrowserNetworkEnv,
	buildModularNetworkConfig,
	isModularNetworkEnv,
	parseRelayOperatorGroups,
} from "@ts-drp/example-browser-network/config";
import type { DRPNodeConfig } from "@ts-drp/types";

export { allowsInsecureNetworkFixture, buildModularNetworkConfig, isModularNetworkEnv, parseRelayOperatorGroups };

export type GridNetworkEnv = BrowserNetworkEnv;

/**
 * Selects the modular config when requested and otherwise preserves the legacy fixed-bootstrap path.
 * @param environment - Parsed grid environment.
 * @param metricsOrigin - Browser origin used only by legacy Prometheus push configuration.
 * @returns The selected DRP node configuration.
 */
export function getNetworkConfigFromEnv(environment: GridNetworkEnv, metricsOrigin?: string): DRPNodeConfig {
	if (isModularNetworkEnv(environment)) return buildModularNetworkConfig(environment);

	const { bootstrapPeers, discoveryInterval, enablePrometheusMetrics } = environment;
	const hasEnv = bootstrapPeers || discoveryInterval || enablePrometheusMetrics;
	const config: DRPNodeConfig = {
		network_config: {
			browser_metrics: true,
		},
	};

	if (!hasEnv) return config;

	if (bootstrapPeers) {
		config.network_config = {
			...config.network_config,
			bootstrap_peers: bootstrapPeers.split(","),
		};
	}

	if (discoveryInterval) {
		config.network_config = {
			...config.network_config,
			pubsub: {
				...config.network_config?.pubsub,
				peer_discovery_interval: discoveryInterval,
			},
		};
	}

	if (enablePrometheusMetrics) {
		config.network_config = {
			...config.network_config,
			pubsub: {
				...config.network_config?.pubsub,
				prometheus_metrics: true,
				...(metricsOrigin === undefined ? {} : { pushgateway_url: metricsOrigin }),
			},
		};
	}

	return config;
}
