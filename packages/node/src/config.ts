import type { DRPNodeConfig } from "@ts-drp/types";
import * as dotenv from "dotenv";
import fs from "node:fs";

function parseCommaSeparatedValue(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return value === "" ? [] : value.split(",");
}

function rejectRemovedNetworkFields(config: unknown): void {
	if (typeof config !== "object" || config === null || !("network_config" in config)) return;
	const networkConfig = config.network_config;
	if (typeof networkConfig !== "object" || networkConfig === null) return;
	if (Object.prototype.hasOwnProperty.call(networkConfig, "bootstrap")) {
		throw new Error("network_config.bootstrap was removed; use seed and relay_service explicitly");
	}
	if (Object.prototype.hasOwnProperty.call(networkConfig, "relay")) {
		throw new Error(
			"network_config.relay was removed; use relay_service for local capacity and control_plane.relay_policy for relay-client policy"
		);
	}
}

/**
 * Load the configuration for the DRP node.
 * @param configPath - The path to the configuration file.
 * @returns The configuration for the DRP node.
 */
export function loadConfig(configPath?: string | undefined): DRPNodeConfig | undefined {
	let config: DRPNodeConfig | undefined;

	if (configPath) {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
			rejectRemovedNetworkFields(parsed);
			config = parsed as DRPNodeConfig;
			return config;
		} catch (error) {
			console.error(`Failed to load config from ${configPath}:`, error);
			throw error;
		}
	}

	dotenv.config();

	const hasEnvConfig = [
		"LISTEN_ADDRESSES",
		"ANNOUNCE_ADDRESSES",
		"BOOTSTRAP",
		"BOOTSTRAP_PEERS",
		"BROWSER_METRICS",
		"PRIVATE_KEY_SEED",
	].some((key) => process.env[key] !== undefined);

	if (!hasEnvConfig) {
		return undefined;
	}

	// BOOTSTRAP remains an environment-only migration input; JSON uses the explicit owners.
	const legacyBootstrap = process.env.BOOTSTRAP === undefined ? undefined : process.env.BOOTSTRAP === "true";
	config = {};
	config.network_config = {
		autonat: legacyBootstrap,
		listen_addresses: parseCommaSeparatedValue(process.env.LISTEN_ADDRESSES),
		announce_addresses: parseCommaSeparatedValue(process.env.ANNOUNCE_ADDRESSES),
		bootstrap_peers: parseCommaSeparatedValue(process.env.BOOTSTRAP_PEERS),
		browser_metrics: process.env.BROWSER_METRICS ? process.env.BROWSER_METRICS === "true" : undefined,
		relay_service: legacyBootstrap === undefined ? undefined : { enabled: legacyBootstrap },
		seed: legacyBootstrap,
	};
	config.keychain_config = {
		private_key_seed: process.env.PRIVATE_KEY_SEED ? process.env.PRIVATE_KEY_SEED : undefined,
	};
	return config;
}
