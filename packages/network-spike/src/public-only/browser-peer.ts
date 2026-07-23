import type { RelayPolicy, RelayPolicyResult } from "@ts-drp/relay-policy";
import { CID } from "multiformats/cid";

import type { PublicProviderLocator, PublicProviderLookupResult } from "./provider-locator.js";

export interface PublicOnlyBrowserBootstrapResult {
	readonly providerLookup: PublicProviderLookupResult;
	readonly relay: RelayPolicyResult;
	readonly terminal: "aborted" | "ready" | "provider-unavailable" | "relay-exhausted";
}

/** Composes delegated provider lookup with an independent public-relay reservation. */
export class PublicOnlyBrowserPeer {
	readonly #locator: PublicProviderLocator;
	readonly #relay: Pick<RelayPolicy, "acquire" | "hasOwnedFallback" | "stop">;

	/**
	 * Composes CID-only provider lookup with an independently sourced relay policy.
	 * @param locator Namespace-only delegated provider lookup.
	 * @param relay Independently sourced Relay v2 policy.
	 */
	constructor(locator: PublicProviderLocator, relay: Pick<RelayPolicy, "acquire" | "hasOwnedFallback" | "stop">) {
		if (relay.hasOwnedFallback) throw new Error("public-only browser bootstrap forbids an owned relay fallback");
		this.#locator = locator;
		this.#relay = relay;
	}

	/**
	 * Runs provider lookup before any relay acquisition and rejects owned fallback.
	 * @param namespace Opaque namespace shared out of band.
	 * @param signal Parent bootstrap deadline.
	 * @returns Typed provider and relay bootstrap outcome.
	 */
	async bootstrap(namespace: string, signal: AbortSignal): Promise<PublicOnlyBrowserBootstrapResult> {
		const providerLookup = await this.#locator.locate(namespace, signal);
		if (providerLookup.terminal === "aborted") {
			return { providerLookup, relay: emptyRelayResult("aborted"), terminal: "aborted" };
		}
		if (providerLookup.terminal !== "provider-visible") {
			return { providerLookup, relay: emptyRelayResult(), terminal: "provider-unavailable" };
		}
		const relay = await this.#relay.acquire(CID.parse(providerLookup.cid).multihash.digest, signal);
		if (relay.terminal === "aborted") return { providerLookup, relay, terminal: "aborted" };
		if (relay.terminal !== "reserved" || relay.reservations.length === 0 || relay.fallback !== undefined) {
			return { providerLookup, relay, terminal: "relay-exhausted" };
		}
		return { providerLookup, relay, terminal: "ready" };
	}

	/** Stops both delegated routing and relay resources. */
	async stop(): Promise<void> {
		const results = await Promise.allSettled([this.#locator.stop(), this.#relay.stop()]);
		const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failures.length > 0) {
			throw new AggregateError(
				failures.map(({ reason }) => reason),
				"browser public-only cleanup failed"
			);
		}
	}
}

/**
 * Returns the typed no-relay outcome used when provider lookup cannot proceed.
 * @param terminal Cancellation or ordinary exhaustion.
 * @returns Empty exhausted relay evidence.
 */
function emptyRelayResult(terminal: "aborted" | "exhausted" = "exhausted"): RelayPolicyResult {
	return {
		attempts: [],
		candidatesObserved: 0,
		durationMs: 0,
		operatorGroups: [],
		reservations: [],
		terminal,
	};
}
