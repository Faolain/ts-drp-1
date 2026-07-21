import type { PeerScoreParams } from "@libp2p/gossipsub/score";
import type { RelayCandidate, RelayCandidateSource, RelayPolicyResult } from "@ts-drp/relay-policy";
import type { DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	type DRPNetworkHostConfigSnapshot,
	type DRPNetworkHostFactory,
	DRPNetworkNode,
	type DRPNetworkNodeDependencies,
	type RelayPolicyDriver,
	type RelayPolicyFactoryOptions,
} from "../src/node.js";

interface GossipSubPhaseSevenView {
	score: { params: PeerScoreParams };
}

const quietConfig = {
	bootstrap_peers: [],
	listen_addresses: [],
	log_config: { level: "silent" as const },
};

function createNode(config: DRPNetworkNodeConfig, dependencies: DRPNetworkNodeDependencies = {}): DRPNetworkNode {
	return new DRPNetworkNode(config, dependencies);
}

function gossipSub(node: DRPNetworkNode): GossipSubPhaseSevenView {
	const service = node["_pubsub"] as unknown as GossipSubPhaseSevenView | undefined;
	if (service === undefined) throw new Error("expected a started GossipSub service");
	return service;
}

describe("Phase 7 IP-colocation policy", () => {
	const startedNodes: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(
			startedNodes.splice(0).map(async (node) => {
				if (node["_node"]?.status !== "stopped") await node.stop();
			})
		);
	});

	test("enabled IP-colocation scoring installs a valid negative weight, threshold, and shared-IP whitelist", async () => {
		const node = createNode({
			...quietConfig,
			control_plane: {
				pubsub_scoring: {
					ip_colocation: {
						enabled: true,
						threshold: 2,
						weight: -7,
						whitelist: ["127.0.0.1", "10.20.30.40"],
					},
				},
			},
		});
		startedNodes.push(node);
		await node.start();

		const params = gossipSub(node).score.params;
		expect(params.IPColocationFactorWeight).toBe(-7);
		expect(params.IPColocationFactorWeight).toBeLessThan(0);
		expect(params.IPColocationFactorThreshold).toBe(2);
		expect(params.IPColocationFactorThreshold).toBeGreaterThanOrEqual(1);
		expect([...params.IPColocationFactorWhitelist]).toEqual(["127.0.0.1", "10.20.30.40"]);
	});

	test("disabled IP-colocation scoring remains an explicit zero-weight policy", async () => {
		const node = createNode({
			...quietConfig,
			control_plane: { pubsub_scoring: { ip_colocation: { enabled: false } } },
		});
		startedNodes.push(node);
		await node.start();

		expect(gossipSub(node).score.params.IPColocationFactorWeight).toBe(0);
	});

	test.each([
		["positive weight", { enabled: true as const, threshold: 2, weight: 1 }],
		["threshold below one", { enabled: true as const, threshold: 0, weight: -1 }],
	])("rejects %s instead of silently constructing invalid GossipSub params", async (_case, ip_colocation) => {
		const node = createNode({
			...quietConfig,
			control_plane: { pubsub_scoring: { ip_colocation } },
		});
		startedNodes.push(node);

		await expect(node.start()).rejects.toThrow(/IP.?colocation|IPColocation/i);
	});

	test.each([
		["a string", "127.0.0.1"],
		["an empty entry", [""]],
		["a non-string entry", ["127.0.0.1", 4]],
	] as const)("rejects %s as an IP-colocation whitelist", async (_case, whitelist) => {
		const node = createNode({
			...quietConfig,
			control_plane: {
				pubsub_scoring: {
					ip_colocation: { enabled: true, threshold: 2, weight: -1, whitelist },
				},
			},
		} as unknown as DRPNetworkNodeConfig);
		startedNodes.push(node);

		await expect(node.start()).rejects.toThrow(/whitelist.*array of non-empty strings/i);
	});
});

describe("Phase 7 unified rollout kill switches", () => {
	const startedNodes: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(
			startedNodes.splice(0).map(async (node) => {
				if (node["_node"]?.status !== "stopped") await node.stop();
			})
		);
	});

	test("disabling every public component keeps the configured relay active without consulting public overflow", async () => {
		let observedSnapshot: DRPNetworkHostConfigSnapshot | undefined;
		let compositeSource: RelayCandidateSource | undefined;
		const publicSourceStarted = vi.fn();
		const hostFactory: DRPNetworkHostFactory = (context) => {
			observedSnapshot = context.snapshot;
			return context.createHost();
		};
		const relayPolicyFactory = (options: RelayPolicyFactoryOptions): RelayPolicyDriver => {
			compositeSource = options.source;
			return {
				acquire: () => Promise.resolve(exhaustedRelayResult()),
				refresh: () => Promise.resolve(exhaustedRelayResult()),
				replace: (peerId, reason) => Promise.resolve({ ...exhaustedRelayResult(), reason, replacedPeerId: peerId }),
				stop: () => Promise.resolve(),
			};
		};
		const node = createNode(
			{
				...quietConfig,
				control_plane: {
					relay_policy: {
						sources: {
							configured_fallback: { enabled: true },
							delegated_closest_peers: { enabled: true },
							dht_relay_providers: { enabled: true },
						},
					},
					rollout: {
						public_components: {
							delegated_routing: { enabled: false },
							public_relay_overflow: { enabled: false },
							public_rendezvous: { enabled: false },
							pubsub_behavior_rewards: { enabled: false },
						},
					},
				},
			},
			{
				hostFactory,
				relayCandidateSources: {
					configuredFallback: sourceOf(relayCandidate("owned-relay", "configured-fallback", "configured")),
					delegatedClosestPeers: trackedSource(publicSourceStarted),
					dhtRelayProviders: trackedSource(publicSourceStarted),
				},
				relayPolicyFactory,
			}
		);
		startedNodes.push(node);
		await node.start();

		if (compositeSource === undefined) throw new Error("configured owned relay source was not assembled");
		await expect(collect(compositeSource)).resolves.toMatchObject([{ peerId: "owned-relay" }]);
		expect(publicSourceStarted).not.toHaveBeenCalled();
		expect(observedSnapshot?.rollout).toEqual({
			ownedFallback: {
				configuredRelays: true,
				localRouting: true,
				ownedRendezvous: true,
			},
			publicComponents: {
				delegatedRouting: false,
				publicRelayOverflow: false,
				publicRendezvous: false,
				pubsubBehaviorRewards: false,
			},
		});
	});

	test("an omitted rollout still resolves to frozen public-off and owned-on defaults", async () => {
		let observedSnapshot: DRPNetworkHostConfigSnapshot | undefined;
		const node = createNode(quietConfig, {
			hostFactory: (context) => {
				observedSnapshot = context.snapshot;
				return context.createHost();
			},
		});
		startedNodes.push(node);
		await node.start();

		expect(observedSnapshot?.rollout).toEqual({
			ownedFallback: { configuredRelays: true, localRouting: true, ownedRendezvous: true },
			publicComponents: {
				delegatedRouting: false,
				publicRelayOverflow: false,
				publicRendezvous: false,
				pubsubBehaviorRewards: false,
			},
		});
		expect(Object.isFrozen(observedSnapshot?.rollout)).toBe(true);
		expect(Object.isFrozen(observedSnapshot?.rollout.ownedFallback)).toBe(true);
		expect(Object.isFrozen(observedSnapshot?.rollout.publicComponents)).toBe(true);
	});

	test.each([
		["configured_relays", false],
		["local_routing", 0],
		["owned_rendezvous", "false"],
	] as const)(
		"fails closed when rollout tries to disable the %s owned fallback with %j",
		async (ownedFallback, enabled) => {
			const node = createNode({
				...quietConfig,
				control_plane: {
					rollout: { owned_fallback: { [ownedFallback]: { enabled } } },
				},
			} as unknown as DRPNetworkNodeConfig);
			startedNodes.push(node);

			await expect(node.start()).rejects.toThrow(/owned fallback|cannot disable/i);
		}
	);
});

function relayCandidate(
	peerId: string,
	origin: RelayCandidate["provenance"]["origin"],
	routingSource: RelayCandidate["provenance"]["routingSource"]
): RelayCandidate {
	return {
		addresses: [],
		operatorGroup: `operator:${peerId}`,
		peerId,
		protocols: [],
		provenance: { origin, queryDigest: "phase-seven", resultIndex: 0, routingSource },
	};
}

function sourceOf(candidate: RelayCandidate): RelayCandidateSource {
	return {
		async *getCandidates(): AsyncIterable<RelayCandidate> {
			await Promise.resolve();
			yield candidate;
		},
	};
}

function trackedSource(started: () => void): RelayCandidateSource {
	return {
		async *getCandidates(): AsyncIterable<RelayCandidate> {
			await Promise.resolve();
			started();
			yield relayCandidate("public-relay", "dht-relay-provider", "public-dht");
		},
	};
}

async function collect(source: RelayCandidateSource): Promise<RelayCandidate[]> {
	const candidates: RelayCandidate[] = [];
	for await (const candidate of source.getCandidates(new Uint8Array(), new AbortController().signal)) {
		candidates.push(candidate);
	}
	return candidates;
}

function exhaustedRelayResult(): RelayPolicyResult {
	return {
		attempts: [],
		candidatesObserved: 0,
		durationMs: 0,
		operatorGroups: [],
		reservations: [],
		terminal: "exhausted",
	};
}
