import {
	type BrowserRouting,
	BrowserRoutingExhaustedError,
	type BrowserRoutingPeer,
	type BrowserRoutingTrace,
} from "../browser-routing/index.js";
import { namespaceCid } from "../namespace.js";

export interface UntrustedPublicProvider {
	readonly addresses: readonly string[];
	readonly peerId: string;
	readonly provenance: "untrusted-public-provider";
}

export interface PublicProviderLookupResult {
	readonly cid: string;
	readonly providers: readonly UntrustedPublicProvider[];
	readonly terminal: "aborted" | "empty" | "provider-visible" | "provider-undialable" | "routing-exhausted";
	readonly trace?: BrowserRoutingTrace;
}

/** Browser provider lookup whose only discovery input is a deterministic namespace CID. */
export class PublicProviderLocator {
	readonly #routing: Pick<BrowserRouting, "findProviders" | "lastTrace" | "stop">;

	/** @param routing Browser-only delegated Routing V1 owner. */
	constructor(routing: Pick<BrowserRouting, "findProviders" | "lastTrace" | "stop">) {
		this.#routing = routing;
	}

	/**
	 * Derives the lookup CID without accepting a peer identity or address.
	 * @param namespace Opaque namespace known by both participants.
	 * @param signal Parent lookup deadline.
	 * @returns Typed provider evidence from delegated routing.
	 */
	async locate(namespace: string, signal: AbortSignal): Promise<PublicProviderLookupResult> {
		const cid = await namespaceCid(namespace);
		const observed: BrowserRoutingPeer[] = [];
		try {
			for await (const peer of this.#routing.findProviders(cid.toString(), signal)) observed.push(peer);
		} catch (error) {
			if (signal.aborted) return lookupFailure(cid.toString(), "aborted", this.#routing.lastTrace);
			if (error instanceof BrowserRoutingExhaustedError) {
				return lookupFailure(cid.toString(), "routing-exhausted", error.trace);
			}
			throw error;
		}
		const providers = observed
			.filter(({ acceptedAddresses }) => acceptedAddresses.length > 0)
			.map(({ acceptedAddresses, peerId }) => ({
				addresses: [...acceptedAddresses],
				peerId,
				provenance: "untrusted-public-provider" as const,
			}));
		const trace = this.#routing.lastTrace;
		return {
			cid: cid.toString(),
			providers,
			terminal:
				providers.length > 0 ? "provider-visible" : (trace?.rawAddressCount ?? 0) > 0 ? "provider-undialable" : "empty",
			...(trace === undefined ? {} : { trace }),
		};
	}

	/**
	 * Stops delegated routing and clears its bounded cache.
	 * @returns Completion after the routing owner is stopped.
	 */
	stop(): Promise<void> {
		return this.#routing.stop();
	}
}

function lookupFailure(
	cid: string,
	terminal: "aborted" | "routing-exhausted",
	trace: BrowserRoutingTrace | undefined
): PublicProviderLookupResult {
	return { cid, providers: [], terminal, ...(trace === undefined ? {} : { trace }) };
}
