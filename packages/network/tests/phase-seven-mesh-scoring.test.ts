import type { PeerScoreParams } from "@libp2p/gossipsub/score";
import type { DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DRPNetworkNode, type DRPNetworkNodeDependencies } from "../src/node.js";

const BOOTSTRAP_PEER_ID = "16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5";
const BOOTSTRAP_ADDRESS = `/ip4/127.0.0.1/tcp/65535/ws/p2p/${BOOTSTRAP_PEER_ID}`;
const OBSERVED_PEER_ID = "12D3KooWObservedAuthenticatedPeer";
const MAX_APPLICATION_REWARD = 0.5;
const localAddressPolicy = {
	allowInsecureWebSocket: true,
	allowLoopback: true,
	allowPrivate: true,
	target: "node" as const,
};
const quietHostPolicy = {
	bootstrapDiscovery: false,
	coldStartPubsubDiscovery: false,
	gossipSubPeerExchange: false,
};

interface ObservedPeerBehavior {
	readonly authenticated: boolean;
	readonly diversityScore: number;
	readonly validBehaviorScore: number;
}

interface AuthenticatedPeerBehaviorProvider {
	getObservedPeerBehavior(peerId: string): ObservedPeerBehavior | undefined;
}

type PhaseSevenDependencies = DRPNetworkNodeDependencies & {
	readonly authenticatedPeerBehaviorProvider?: AuthenticatedPeerBehaviorProvider;
};

interface GossipSubPhaseSevenView {
	heartbeat(): Promise<void>;
	heartbeatTicks: number;
	mesh: Map<string, Set<string>>;
	topics: Map<string, Set<string>>;
	opts: {
		D: number;
		Dhi: number;
		Dlo: number;
		Dout: number;
		Dscore: number;
		opportunisticGraftTicks: number;
		scoreThresholds: {
			acceptPXThreshold: number;
			opportunisticGraftThreshold: number;
		};
	};
	score: { params: PeerScoreParams };
	status: { heartbeatTimeout?: ReturnType<typeof setTimeout> };
}

const quietConfig: DRPNetworkNodeConfig = {
	bootstrap_peers: [],
	listen_addresses: [],
	log_config: { level: "silent" },
};

function createNode(
	config: DRPNetworkNodeConfig = quietConfig,
	dependencies: PhaseSevenDependencies = {}
): DRPNetworkNode {
	return new DRPNetworkNode(config, dependencies);
}

function rewardControlPlane(
	maxApplicationScore = MAX_APPLICATION_REWARD
): NonNullable<DRPNetworkNodeConfig["control_plane"]> {
	return {
		pubsub_scoring: {
			observed_behavior_reward: {
				enabled: true,
				max_application_score: maxApplicationScore,
			},
		},
		rollout: {
			public_components: { pubsub_behavior_rewards: { enabled: true } },
		},
	};
}

function gossipSub(node: DRPNetworkNode): GossipSubPhaseSevenView {
	const service = node["_pubsub"] as unknown as GossipSubPhaseSevenView | undefined;
	if (service === undefined) throw new Error("expected a started GossipSub service");
	return service;
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function pauseScheduledHeartbeat(service: GossipSubPhaseSevenView): Promise<void> {
	for (let attempt = 0; attempt < 2; attempt++) {
		if (service.status.heartbeatTimeout !== undefined) clearTimeout(service.status.heartbeatTimeout);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (service.status.heartbeatTimeout !== undefined) clearTimeout(service.status.heartbeatTimeout);
	service.status.heartbeatTimeout = undefined;
}

describe("Phase 7 mesh scoring", () => {
	const startedNodes: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(
			startedNodes.splice(0).map(async (node) => {
				if (node["_node"]?.status !== "stopped") await node.stop();
			})
		);
	});

	test("the default non-seed path gives no application-score privilege to a configured bootstrap identity", async () => {
		const node = createNode({ ...quietConfig, bootstrap_peers: [BOOTSTRAP_ADDRESS] });
		vi.spyOn(node, "safeDial").mockResolvedValue(undefined);
		startedNodes.push(node);

		await node.start();

		const { opts, score } = gossipSub(node);
		const bootstrapScore = score.params.appSpecificScore(BOOTSTRAP_PEER_ID);
		const unrelatedScore = score.params.appSpecificScore(OBSERVED_PEER_ID);
		const weightedBootstrapContribution = bootstrapScore * score.params.appSpecificWeight;

		expect(bootstrapScore).toBe(0);
		expect(bootstrapScore).toBe(unrelatedScore);
		expect(weightedBootstrapContribution).toBeLessThan(opts.scoreThresholds.acceptPXThreshold);
		expect(weightedBootstrapContribution).toBeLessThan(opts.scoreThresholds.opportunisticGraftThreshold);
	});

	test("bootstrap identity alone cannot bypass authentication when observed rewards are enabled", async () => {
		const provider: AuthenticatedPeerBehaviorProvider = {
			getObservedPeerBehavior: (peerId) =>
				peerId === BOOTSTRAP_PEER_ID ? { authenticated: false, diversityScore: 1, validBehaviorScore: 1 } : undefined,
		};
		const node = createNode(
			{
				...quietConfig,
				bootstrap_peers: [BOOTSTRAP_ADDRESS],
				control_plane: rewardControlPlane(),
			},
			{ authenticatedPeerBehaviorProvider: provider }
		);
		vi.spyOn(node, "safeDial").mockResolvedValue(undefined);
		startedNodes.push(node);

		await node.start();

		expect(gossipSub(node).score.params.appSpecificScore(BOOTSTRAP_PEER_ID)).toBe(0);
	});

	test("authenticated observed behavior earns only a bounded and revocable reward", async () => {
		const observations = new Map<string, ObservedPeerBehavior>([
			[OBSERVED_PEER_ID, { authenticated: true, diversityScore: 20, validBehaviorScore: 20 }],
		]);
		const provider: AuthenticatedPeerBehaviorProvider = {
			getObservedPeerBehavior: (peerId) => observations.get(peerId),
		};
		const node = createNode(
			{
				...quietConfig,
				control_plane: rewardControlPlane(),
			},
			{ authenticatedPeerBehaviorProvider: provider }
		);
		startedNodes.push(node);
		await node.start();

		const { opts, score } = gossipSub(node);
		const appSpecificScore = score.params.appSpecificScore;
		const rewardedScore = appSpecificScore(OBSERVED_PEER_ID);
		const weightedReward = rewardedScore * score.params.appSpecificWeight;
		expect(rewardedScore).toBeGreaterThan(0);
		expect(rewardedScore).toBe(MAX_APPLICATION_REWARD);
		expect(weightedReward).toBeLessThan(opts.scoreThresholds.acceptPXThreshold);
		expect(weightedReward).toBeLessThan(opts.scoreThresholds.opportunisticGraftThreshold);

		observations.set(OBSERVED_PEER_ID, {
			authenticated: false,
			diversityScore: 20,
			validBehaviorScore: 20,
		});
		expect(appSpecificScore(OBSERVED_PEER_ID)).toBe(0);
	});

	test("observed rewards remain off until the public canary is explicitly enabled", async () => {
		const provider: AuthenticatedPeerBehaviorProvider = {
			getObservedPeerBehavior: () => ({ authenticated: true, diversityScore: 1, validBehaviorScore: 1 }),
		};
		const node = createNode(
			{
				...quietConfig,
				control_plane: {
					pubsub_scoring: {
						observed_behavior_reward: {
							enabled: true,
							max_application_score: 0.2,
						},
					},
				},
			},
			{ authenticatedPeerBehaviorProvider: provider }
		);
		startedNodes.push(node);
		await node.start();

		expect(gossipSub(node).score.params.appSpecificScore(OBSERVED_PEER_ID)).toBe(0);
	});

	test("combines verified relay preference and authenticated behavior by bounded max", async () => {
		const relay = createNode(
			{
				...quietConfig,
				control_plane: { address_policy: localAddressPolicy },
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				relay_service: { enabled: true },
			},
			{ hostPolicy: quietHostPolicy }
		);
		startedNodes.push(relay);
		await relay.start();
		const relayAddress = relay.getMultiaddrs().find((address) => address.includes("/ws/p2p/"));
		if (relayAddress === undefined) throw new Error("relay did not expose a WebSocket address");

		const provider: AuthenticatedPeerBehaviorProvider = {
			getObservedPeerBehavior: (peerId) =>
				peerId === relay.peerId ? { authenticated: true, diversityScore: 0.3, validBehaviorScore: 0.3 } : undefined,
		};
		const node = createNode(
			{
				...quietConfig,
				connection_budget: { max_connections: 4, max_parallel_dials: 1 },
				control_plane: {
					address_policy: localAddressPolicy,
					pubsub_scoring: {
						observed_behavior_reward: { enabled: true, max_application_score: 0.8 },
					},
					relay_policy: {
						sources: { configured_relays: [relayAddress] },
						target_reservations: 1,
					},
					rollout: { public_components: { pubsub_behavior_rewards: { enabled: true } } },
				},
			},
			{ authenticatedPeerBehaviorProvider: provider, hostPolicy: quietHostPolicy }
		);
		startedNodes.push(node);
		await node.start();
		await node.retryRelayPolicyAcquisition();

		expect(gossipSub(node).score.params.appSpecificScore(relay.peerId), "T4_SCORE_MAX_COMPOSITION_ABSENT").toBe(0.6);
	}, 15_000);

	test("feeds verified relay preference into native Dscore pruning and opportunistic graft cadence", async () => {
		const relays = Array.from({ length: 4 }, () =>
			createNode(
				{
					...quietConfig,
					control_plane: { address_policy: localAddressPolicy },
					listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
					relay_service: { enabled: true },
				},
				{ hostPolicy: quietHostPolicy }
			)
		);
		const neutralPeers = Array.from({ length: 10 }, () =>
			createNode(
				{
					...quietConfig,
					control_plane: { address_policy: localAddressPolicy },
					listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				},
				{ hostPolicy: quietHostPolicy }
			)
		);
		startedNodes.push(...relays, ...neutralPeers);
		await Promise.all(startedNodes.map(async (node) => node.start()));
		const relayAddresses = relays.map((relay) => {
			const address = relay.getMultiaddrs().find((candidate) => candidate.includes("/ws/p2p/"));
			if (address === undefined) throw new Error("relay did not expose a WebSocket address");
			return address;
		});
		const hub = createNode(
			{
				...quietConfig,
				connection_budget: { max_connections: 24, max_parallel_dials: 4 },
				control_plane: {
					address_policy: localAddressPolicy,
					pubsub_scoring: { observed_behavior_reward: { enabled: true, max_application_score: 0.2 } },
					relay_policy: { sources: { configured_relays: relayAddresses }, target_reservations: 4 },
				},
			},
			{ hostPolicy: quietHostPolicy }
		);
		startedNodes.push(hub);
		await hub.start();
		await hub.retryRelayPolicyAcquisition();
		await Promise.all(neutralPeers.map(async (peer) => hub.connect(peer.getMultiaddrs())));
		const topic = "track-t4-native-relay-spine";
		const outsideRelay = relays.at(-1);
		if (outsideRelay === undefined) throw new Error("expected an outside-topic relay");
		hub.subscribe(topic);
		for (const node of [...relays.slice(0, -1), ...neutralPeers]) node.subscribe(topic);
		await waitFor(
			() => hub.getGroupPeers(topic).length === relays.length - 1 + neutralPeers.length,
			"bounded T4 subscribers"
		);

		const service = gossipSub(hub);
		await pauseScheduledHeartbeat(service);
		expect(service.opts.Dscore).toBe(4);
		expect(service.opts.opportunisticGraftTicks).toBe(60);
		const score = service.score.params.appSpecificScore;
		const relayIds = relays.map((relay) => relay.peerId);
		const subscribedRelayIds = relayIds.slice(0, -1);
		const neutralIds = neutralPeers.map((peer) => peer.peerId);
		for (const relayId of relayIds) expect(score(relayId), "T4_NATIVE_DSCORE_AUTHORITY_ABSENT").toBe(0.2);
		const candidateSet = service.topics.get(topic);
		if (candidateSet === undefined) throw new Error("expected native topic candidate set");
		expect(candidateSet, "T4_UNSUBSCRIBED_RELAY_TOPIC_MUTATION").not.toContain(outsideRelay.peerId);

		service.mesh.set(topic, new Set([...subscribedRelayIds, ...neutralIds]));
		await service.heartbeat();
		const retained = service.mesh.get(topic) ?? new Set<string>();
		expect(retained.size).toBeLessThanOrEqual(service.opts.D);
		for (const relayId of subscribedRelayIds) {
			expect(retained, "T4_NATIVE_DSCORE_RETENTION_ABSENT").toContain(relayId);
		}
		expect(retained, "T4_UNSUBSCRIBED_RELAY_MESH_MUTATION").not.toContain(outsideRelay.peerId);
		expect(hub.getGroupPeers(topic, "mesh").sort()).toEqual([...retained].sort());

		service.mesh.set(topic, new Set(neutralIds.slice(0, service.opts.D)));
		for (const relayId of subscribedRelayIds.slice(1)) candidateSet.delete(relayId);
		const ticksUntilGraft =
			service.opts.opportunisticGraftTicks - (service.heartbeatTicks % service.opts.opportunisticGraftTicks);
		for (let tick = 1; tick < ticksUntilGraft; tick++) await service.heartbeat();
		expect([...(service.mesh.get(topic) ?? [])].some((peerId) => subscribedRelayIds.includes(peerId))).toBe(false);
		await service.heartbeat();
		const grafted = service.mesh.get(topic) ?? new Set<string>();
		expect(grafted, "T4_NATIVE_OPPORTUNISTIC_GRAFT_ABSENT").toContain(subscribedRelayIds[0]);
		expect([...grafted].filter((peerId) => subscribedRelayIds.includes(peerId))).toEqual([subscribedRelayIds[0]]);
		expect(grafted, "T4_UNSUBSCRIBED_RELAY_MESH_MUTATION").not.toContain(outsideRelay.peerId);
		expect(hub.getGroupPeers(topic, "mesh").sort()).toEqual([...grafted].sort());
	}, 45_000);

	test("rejects an application reward cap that can reach the GossipSub PX threshold", async () => {
		const node = createNode({ ...quietConfig, control_plane: rewardControlPlane(1) });
		startedNodes.push(node);

		await expect(node.start()).rejects.toThrow(/weighted contribution.*accept-PX threshold/i);
	});

	test("a throwing observed-behavior provider is neutral in the GossipSub hot path", async () => {
		const provider: AuthenticatedPeerBehaviorProvider = {
			getObservedPeerBehavior: () => {
				throw new Error("hostile provider");
			},
		};
		const node = createNode(
			{ ...quietConfig, control_plane: rewardControlPlane() },
			{ authenticatedPeerBehaviorProvider: provider }
		);
		startedNodes.push(node);
		await node.start();

		const appSpecificScore = gossipSub(node).score.params.appSpecificScore;
		expect(() => appSpecificScore(OBSERVED_PEER_ID)).not.toThrow();
		expect(appSpecificScore(OBSERVED_PEER_ID)).toBe(0);
	});

	test.each([
		["NaN", Number.NaN, 1],
		["positive infinity", Number.POSITIVE_INFINITY, 1],
		["negative values", -1, -2],
	] as const)("treats %s observed-behavior scores as neutral", async (_case, diversityScore, validBehaviorScore) => {
		const provider: AuthenticatedPeerBehaviorProvider = {
			getObservedPeerBehavior: () => ({ authenticated: true, diversityScore, validBehaviorScore }),
		};
		const node = createNode(
			{ ...quietConfig, control_plane: rewardControlPlane() },
			{ authenticatedPeerBehaviorProvider: provider }
		);
		startedNodes.push(node);
		await node.start();

		expect(gossipSub(node).score.params.appSpecificScore(OBSERVED_PEER_ID)).toBe(0);
	});

	test("treats an invalid observed-behavior shape as neutral", async () => {
		const provider = {
			getObservedPeerBehavior: () => ({
				authenticated: true,
				diversityScore: "1",
				validBehaviorScore: 1,
			}),
		} as unknown as AuthenticatedPeerBehaviorProvider;
		const node = createNode(
			{ ...quietConfig, control_plane: rewardControlPlane() },
			{ authenticatedPeerBehaviorProvider: provider }
		);
		startedNodes.push(node);
		await node.start();

		expect(gossipSub(node).score.params.appSpecificScore(OBSERVED_PEER_ID)).toBe(0);
	});

	test("the no-config seed branch retains its forward-only mesh and score cap", async () => {
		const seed = createNode({ ...quietConfig, seed: true });
		startedNodes.push(seed);
		await seed.start();

		const { opts, score } = gossipSub(seed);
		expect({ D: opts.D, Dhi: opts.Dhi, Dlo: opts.Dlo, Dout: opts.Dout }).toEqual({
			D: 0,
			Dhi: 0,
			Dlo: 0,
			Dout: 0,
		});
		expect(score.params.topicScoreCap).toBe(50);
	});
});
