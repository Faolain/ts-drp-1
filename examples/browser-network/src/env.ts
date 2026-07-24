import type { BrowserNetworkEnv } from "./config";

type RuntimeEnvironment = Readonly<Record<string, unknown>>;

/**
 * Parses the Vite network variables shared by the browser examples.
 * @param runtime - The browser build's import.meta.env object.
 * @returns Normalized network inputs suitable for browser network composition.
 */
export function readBrowserNetworkEnv(runtime: RuntimeEnvironment): BrowserNetworkEnv {
	return {
		allowInsecureFixture: readString(runtime, "VITE_ALLOW_INSECURE_FIXTURE"),
		bootstrapPeers: readString(runtime, "VITE_BOOTSTRAP_PEERS") ?? "",
		discoveryInterval: readNumber(runtime, "VITE_DISCOVERY_INTERVAL"),
		enablePrometheusMetrics: readBoolean(runtime, "VITE_ENABLE_PROMETHEUS_METRICS"),
		membershipInvite: readString(runtime, "VITE_MEMBERSHIP_INVITE"),
		networkMode: readString(runtime, "VITE_NETWORK_MODE"),
		nostrRelays: readList(runtime, "VITE_NOSTR_RELAYS"),
		nostrSecretKey: readString(runtime, "VITE_NOSTR_SECRET_KEY"),
		relayOperatorGroups: readString(runtime, "VITE_RELAY_OPERATOR_GROUPS"),
		rendezvousEndpoints: readString(runtime, "VITE_RENDEZVOUS_ENDPOINTS"),
		rendezvousInvite: readString(runtime, "VITE_RENDEZVOUS_INVITE"),
		rendezvousNamespace: readString(runtime, "VITE_RENDEZVOUS_NAMESPACE"),
		routingEndpoints: readString(runtime, "VITE_ROUTING_ENDPOINTS"),
	};
}

function readBoolean(runtime: RuntimeEnvironment, key: string): boolean {
	const value = runtime[key];
	return value === true || value === "true" || value === "1";
}

function readList(runtime: RuntimeEnvironment, key: string): readonly string[] | undefined {
	const value = readString(runtime, key);
	const values = value
		?.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return values === undefined || values.length === 0 ? undefined : values;
}

function readNumber(runtime: RuntimeEnvironment, key: string): number {
	const value = runtime[key];
	return typeof value === "number" ? value : Number(value);
}

function readString(runtime: RuntimeEnvironment, key: string): string | undefined {
	const value = runtime[key];
	return typeof value === "string" ? value : undefined;
}
