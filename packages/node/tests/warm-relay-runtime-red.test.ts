import type { Connection, Peer } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import type { DRPNetworkHostFactory, RelayPolicyDriver, RelayPolicyFactoryOptions } from "@ts-drp/network";
import {
	CIRCUIT_RELAY_V2_HOP_PROTOCOL,
	type RelayCandidate,
	type RelayCandidateSource,
	type RelayPolicyResult,
	type RelayReplacementResult,
} from "@ts-drp/relay-policy";
import { type NodeRouting, PUBLIC_NETWORK_ACKNOWLEDGEMENT } from "@ts-drp/routing-node";
import type { DRPNodeConfig } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { createNodeRuntime } from "../src/runtime.js";

const WARM_PEER_ID = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";
const WARM_ADDRESS = `/dns4/warm-relay.example.test/tcp/443/wss/p2p/${WARM_PEER_ID}`;

describe("node runtime warm relay wiring RED contract", () => {
	it("uses connected HOP peers for node overflow and never starts a cold getClosestPeers walk", async () => {
		const warmPeerId = peerIdFromString(WARM_PEER_ID);
		const warmPeer: Peer = {
			addresses: [{ isCertified: false, multiaddr: multiaddr(WARM_ADDRESS) }],
			id: warmPeerId,
			metadata: new Map(),
			protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL, "/ipfs/id/1.0.0"],
			tags: new Map(),
		};
		const hostFactory: DRPNetworkHostFactory = async (context) => {
			const host = await context.createHost();
			const connection = { remotePeer: warmPeerId, status: "open" } as unknown as Connection;
			vi.spyOn(host, "getConnections").mockReturnValue([connection]);
			vi.spyOn(host.peerStore, "all").mockResolvedValue([warmPeer]);
			vi.spyOn(host.peerStore, "get").mockResolvedValue(warmPeer);
			return host;
		};
		const coldWalk = vi.fn(async function* (queryKey: Uint8Array): AsyncIterable<never> {
			await Promise.resolve();
			if (queryKey.byteLength < 0) yield undefined as never;
		});
		const routing = fakeRouting(coldWalk);
		let composedSource: RelayCandidateSource | undefined;
		const relayPolicyFactory = vi.fn((options: RelayPolicyFactoryOptions): RelayPolicyDriver => {
			composedSource = options.source;
			return idlePolicy();
		});
		const runtime = await createNodeRuntime(publicOverflowConfig(), {
			attachNodeRouting: (): Promise<NodeRouting> => Promise.resolve(routing),
			network: { hostFactory, relayPolicyFactory },
		});

		try {
			expect(composedSource).toBeDefined();
			if (composedSource === undefined) return;
			expect(
				(composedSource as unknown as { readonly hasDegradedOverflow?: boolean }).hasDegradedOverflow,
				"connected-HOP candidates must retain degraded-overflow eligibility"
			).toBe(true);
			const candidates = await collect(composedSource);
			expect.soft(coldWalk, "warm overflow must not perform a DHT getClosestPeers walk").not.toHaveBeenCalled();
			expect.soft(candidates).toMatchObject([
				{
					addresses: [WARM_ADDRESS],
					peerId: WARM_PEER_ID,
					protocols: expect.arrayContaining([CIRCUIT_RELAY_V2_HOP_PROTOCOL]),
					provenance: { origin: "node-connected-hop", routingSource: "connected-peers" },
				},
			]);
		} finally {
			await runtime.node.stop();
		}
	}, 12_000);
});

function publicOverflowConfig(): DRPNodeConfig {
	return {
		keychain_config: { private_key_seed: "warm-relay-runtime-red" },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			control_plane: {
				relay_policy: {
					sources: { node_closest_peers: { enabled: true } },
					target_reservations: 1,
				},
				rollout: { public_components: { delegated_routing: { enabled: true } } },
				routing: {
					node: {
						bootstrappers: [],
						enabled: true,
						network: "public",
						public_network_acknowledgement: PUBLIC_NETWORK_ACKNOWLEDGEMENT,
					},
				},
			},
			listen_addresses: [],
			log_config: { level: "silent" },
		},
	};
}

function fakeRouting(getClosestPeers: NodeRouting["getClosestPeers"]): NodeRouting {
	return {
		findPeer: (): Promise<never> => Promise.reject(new Error("unused fake findPeer")),
		getClosestPeers,
		peerId: "fake-routing-peer",
		status: (): Promise<never> => Promise.reject(new Error("unused fake status")),
		stop: (): Promise<void> => Promise.resolve(),
		waitForRoutingTable: (): Promise<void> => Promise.resolve(),
	} as unknown as NodeRouting;
}

function idlePolicy(): RelayPolicyDriver {
	return {
		acquire: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
		refresh: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
		replace: (peerId, reason): Promise<RelayReplacementResult> =>
			Promise.resolve({ ...exhausted(), reason, replacedPeerId: peerId }),
		stop: (): Promise<void> => Promise.resolve(),
	};
}

function exhausted(): RelayPolicyResult {
	return {
		attempts: [],
		candidatesObserved: 0,
		durationMs: 0,
		operatorGroups: [],
		reservations: [],
		terminal: "exhausted",
	};
}

async function collect(source: RelayCandidateSource): Promise<RelayCandidate[]> {
	const candidates: RelayCandidate[] = [];
	for await (const candidate of source.getCandidates(Uint8Array.from([4, 2]), new AbortController().signal)) {
		candidates.push(candidate);
	}
	return candidates;
}
