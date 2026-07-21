import type { DRPNetworkHostConfigSnapshot, DRPNetworkHostFactory } from "@ts-drp/network";
import { DRPNetworkNode } from "@ts-drp/network";
import { DRPNode } from "@ts-drp/node";
import {
	BrowserRoutingClosestPeersSource,
	Libp2pRelayClient,
	RelayPolicy,
	type RelayPolicyResult,
} from "@ts-drp/relay-policy";
import { AddressPolicy } from "@ts-drp/rendezvous";
import { type BrowserRoutingTrace, createBrowserRouting } from "@ts-drp/routing-browser";
import type { Libp2p } from "libp2p";

import { type PublicOnlyBrowserBootstrapResult, PublicOnlyBrowserPeer } from "./browser-peer.js";
import { PublicProviderLocator } from "./provider-locator.js";
import { ControlPlaneHostFactory } from "../grid/index.js";

const FIXTURE_ORIGIN = "http://127.0.0.1:4175";

export interface PublicOnlyBrowserFixtureTrace {
	readonly bootstrapInputKeys: readonly string[];
	readonly configuredProviderInputFields: number;
	readonly hostSnapshot: DRPNetworkHostConfigSnapshot;
	readonly namespace: string;
	readonly providerResponsePeerIds: readonly string[];
	readonly result: PublicOnlyBrowserBootstrapResult;
	readonly relayRouting?: BrowserRoutingTrace;
}

export interface PublicOnlyBrowserFixtureSession {
	readonly trace: PublicOnlyBrowserFixtureTrace;
	stop(): Promise<void>;
}

export interface PublicOnlyBrowserFixtureInput {
	readonly namespace: string;
}

/**
 * Local-only browser proof using a real DRP/libp2p host and real Relay v2 wire exchange.
 * The only bootstrap input accepted from the caller is the namespace.
 * @param input Strict namespace-only fixture input.
 * @returns A live fixture session whose owner must stop it.
 */
export async function createPublicOnlyBrowserFixture(
	input: PublicOnlyBrowserFixtureInput
): Promise<PublicOnlyBrowserFixtureSession> {
	const bootstrapInputKeys = Object.keys(input).sort();
	const configuredProviderInputFields = bootstrapInputKeys.filter((key) =>
		/(?:address|fallback|peer|registry)/iu.test(key)
	).length;
	if (bootstrapInputKeys.length !== 1 || bootstrapInputKeys[0] !== "namespace") {
		throw new Error("public-only browser fixture accepts only a namespace");
	}
	const { namespace } = input;
	let host: Libp2p | undefined;
	let hostSnapshot: DRPNetworkHostConfigSnapshot | undefined;
	const isolated = new ControlPlaneHostFactory({
		addressPolicy: new AddressPolicy({
			allowInsecureWebSocket: true,
			allowLoopback: true,
			target: "browser",
		}),
		resolver: { resolve: (): Promise<string[]> => Promise.resolve(["127.0.0.1"]) },
	});
	const hostFactory: DRPNetworkHostFactory = async (context) => {
		hostSnapshot = context.snapshot;
		host = (await isolated.factory(context)) as Libp2p;
		return host;
	};
	const networkConfig = {
		bootstrap_peers: [],
		log_config: { level: "silent" as const },
	};
	const network = new DRPNetworkNode(networkConfig, { hostFactory, hostPolicy: isolated.policy });
	const node = new DRPNode(
		{ log_config: { level: "silent" }, network_config: networkConfig },
		{ networkNode: network, reconnect: false }
	);
	let browserPeer: PublicOnlyBrowserPeer | undefined;
	try {
		await node.start();
		const startedHost = host;
		const startedSnapshot = hostSnapshot;
		if (startedHost === undefined || startedSnapshot === undefined)
			throw new Error("browser host factory was not invoked");

		const providerResponsePeerIds = new Set<string>();
		const nativeFetch = globalThis.fetch.bind(globalThis);
		const observedFetch: typeof globalThis.fetch = async (input, init) => {
			const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
			const providerRequest = url.pathname.includes("/providers/");
			const response = await nativeFetch(input, init);
			if (providerRequest) {
				for (const peerId of await responseProviderIds(response.clone())) providerResponsePeerIds.add(peerId);
			}
			return response;
		};
		const routing = createBrowserRouting({
			allowInsecureLoopback: true,
			allowInsecureWebSocketFixture: true,
			allowLoopbackAddressFixture: true,
			allowedOrigins: [FIXTURE_ORIGIN],
			backoffBaseMs: 1,
			cacheTTLms: 0,
			endpoints: [{ id: "public-only-local", url: `${FIXTURE_ORIGIN}/fixture/public-only-browser/primary/` }],
			fetch: observedFetch,
			limits: { maxResults: 2 },
			resolver: { resolve: (): Promise<string[]> => Promise.resolve(["127.0.0.1"]) },
			timeoutMs: 8_000,
		});
		const relayClient = new Libp2pRelayClient({
			connect: async (address, signal): Promise<void> => {
				signal.throwIfAborted();
				await network.connect(address);
				signal.throwIfAborted();
			},
			disconnect: (peerId): Promise<void> => network.disconnect(peerId),
			host: startedHost as never,
		});
		const relay = new RelayPolicy({
			allowInsecureWebSocketFixture: true,
			inspector: relayClient,
			limits: {
				maxCandidates: 2,
				maxConcurrentReservations: 1,
				maxPerOperatorGroup: 1,
				maxQueuedCandidates: 2,
				ownedFallbackDeadlineMs: 250,
				perCandidateDeadlineMs: 3_500,
				requiredOperatorGroups: 1,
				requiredReservations: 1,
				totalDeadlineMs: 4_500,
			},
			reservationClient: relayClient,
			source: new BrowserRoutingClosestPeersSource(routing, (peer) => `fixture-${peer.peerId.slice(-8)}`),
		});
		browserPeer = new PublicOnlyBrowserPeer(new PublicProviderLocator(routing), relay);
		const result = await browserPeer.bootstrap(namespace, AbortSignal.timeout(20_000));
		if (
			result.providerLookup.providers.length > 0 &&
			!result.providerLookup.providers.every(({ peerId }) => providerResponsePeerIds.has(peerId))
		) {
			throw new Error("browser provider identity did not originate in delegated response");
		}
		const relayRouting = routing.lastTrace;
		let stopped = false;
		return {
			trace: {
				bootstrapInputKeys,
				configuredProviderInputFields,
				hostSnapshot: startedSnapshot,
				namespace,
				providerResponsePeerIds: [...providerResponsePeerIds],
				result,
				...(relayRouting === undefined ? {} : { relayRouting }),
			},
			async stop(): Promise<void> {
				if (stopped) return;
				stopped = true;
				await stopFixture(browserPeer, node);
			},
		};
	} catch (error) {
		await stopFixture(browserPeer, node).catch(() => undefined);
		throw error;
	}
}

async function responseProviderIds(response: Response): Promise<string[]> {
	try {
		const body = (await response.json()) as { Providers?: Array<{ ID?: unknown }> };
		return (body.Providers ?? []).flatMap(({ ID }) => (typeof ID === "string" ? [ID] : []));
	} catch {
		return [];
	}
}

async function stopFixture(browserPeer: PublicOnlyBrowserPeer | undefined, node: DRPNode): Promise<void> {
	const results = await Promise.allSettled([browserPeer?.stop(), node.stop()]);
	const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failures.length > 0) {
		throw new AggregateError(
			failures.map(({ reason }) => reason),
			"public-only browser fixture cleanup failed"
		);
	}
}

export type { RelayPolicyResult };
