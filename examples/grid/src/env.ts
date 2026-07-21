import type { GridNetworkEnv } from "./network-config";

export interface EnvConfig extends GridNetworkEnv {
	readonly bootstrapPeers: string;
	readonly enableTracing: boolean;
	readonly renderInfoInterval: number;
	readonly discoveryInterval: number;
	readonly enablePrometheusMetrics: boolean;
	readonly mode: string;
}

function getBooleanFromEnv(key: keyof ImportMetaEnv): boolean {
	const value = import.meta.env[key];
	return value === "true" || value === "1" || Boolean(value);
}

function getNumberFromEnv(key: keyof ImportMetaEnv): number {
	const value = import.meta.env[key];
	return Number(value);
}

export const env: EnvConfig = {
	allowInsecureFixture: import.meta.env.VITE_ALLOW_INSECURE_FIXTURE,
	bootstrapPeers: import.meta.env.VITE_BOOTSTRAP_PEERS,
	enableTracing: getBooleanFromEnv("VITE_ENABLE_TRACING"),
	renderInfoInterval: getNumberFromEnv("VITE_RENDER_INFO_INTERVAL"),
	discoveryInterval: getNumberFromEnv("VITE_DISCOVERY_INTERVAL"),
	enablePrometheusMetrics: getBooleanFromEnv("VITE_ENABLE_PROMETHEUS_METRICS"),
	membershipInvite: import.meta.env.VITE_MEMBERSHIP_INVITE,
	mode: import.meta.env.MODE,
	networkMode: import.meta.env.VITE_NETWORK_MODE,
	relayOperatorGroups: import.meta.env.VITE_RELAY_OPERATOR_GROUPS,
	rendezvousEndpoints: import.meta.env.VITE_RENDEZVOUS_ENDPOINTS,
	rendezvousInvite: import.meta.env.VITE_RENDEZVOUS_INVITE,
	rendezvousNamespace: import.meta.env.VITE_RENDEZVOUS_NAMESPACE,
	routingEndpoints: import.meta.env.VITE_ROUTING_ENDPOINTS,
};
