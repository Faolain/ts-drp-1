import type { PeerScoreParams } from "@libp2p/gossipsub/score";
import type { DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DRPNetworkNode, type DRPNetworkNodeDependencies } from "../src/node.js";

const BOOTSTRAP_PEER_ID = "16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5";
const BOOTSTRAP_ADDRESS = `/ip4/127.0.0.1/tcp/65535/ws/p2p/${BOOTSTRAP_PEER_ID}`;
const OBSERVED_PEER_ID = "12D3KooWObservedAuthenticatedPeer";
const MAX_APPLICATION_REWARD = 0.5;

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
	opts: {
		D: number;
		Dhi: number;
		Dlo: number;
		Dout: number;
		scoreThresholds: {
			acceptPXThreshold: number;
			opportunisticGraftThreshold: number;
		};
	};
	score: { params: PeerScoreParams };
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
							max_application_score: MAX_APPLICATION_REWARD,
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
