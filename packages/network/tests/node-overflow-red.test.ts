import {
	CIRCUIT_RELAY_V2_HOP_PROTOCOL,
	CompositeRelayCandidateSource,
	EvidenceDerivedOperatorGroupClassifier,
	RELAY_TRANSPORT_PROFILES,
	type RelayCandidate,
	type RelayCandidateSource,
	type RelayInspection,
	type RelayInspector,
	RelayPolicy,
	type RelayPolicyResult,
	type RelayReplacementResult,
	type RelayReservationClient,
	type RelayReservationWireResponse,
} from "@ts-drp/relay-policy";
import type { ControlPlaneEvent, DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRPNetworkNode, type RelayPolicyDriver, type RelayPolicyFactoryOptions } from "../src/node.js";

const TEST_PEER_ID = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";

describe("DRPNetworkNode node-overflow RED contracts", () => {
	const startedNodes: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(
			startedNodes.splice(0).map(async (node) => {
				if (node["_node"]?.status !== "stopped") await node.stop();
			})
		);
	});

	it("starts with the real relay-policy factory at the public-walk deadline", async () => {
		const overflowConsulted = vi.fn();
		const node = new DRPNetworkNode(nodeOverflowConfig(), {
			relayCandidateSources: { nodeClosestPeers: trackedSource(overflowConsulted, []) },
		});
		startedNodes.push(node);

		await expect(node.start()).resolves.toBeUndefined();
		expect(node["_relayPolicy"]).toBeDefined();
		await vi.waitFor(() => expect(overflowConsulted).toHaveBeenCalledOnce());
	});

	it.each([
		["local routing", { network: "local" as const, routingEnabled: true, rolloutEnabled: true }],
		["disabled routing", { network: "public" as const, routingEnabled: false, rolloutEnabled: true }],
		["disabled delegated-routing rollout", { network: "public" as const, routingEnabled: true, rolloutEnabled: false }],
	])("treats node_closest_peers as inert with %s", async (_label, precondition) => {
		const node = new DRPNetworkNode(nodeOverflowConfig(precondition));
		startedNodes.push(node);

		await expect(node.start()).resolves.toBeUndefined();
		expect(node["_relayPolicy"]).toBeUndefined();
	});

	it("defaults the real factory to browser-safe transports and enables TCP/QUIC only for explicit node overflow", async () => {
		expect(RELAY_TRANSPORT_PROFILES.broadBrowser.allowed).toEqual(["wss", "webtransport", "webrtc-direct"]);
		const node = new DRPNetworkNode({ bootstrap_peers: [], listen_addresses: [], log_config: { level: "silent" } });
		startedNodes.push(node);
		await node.start();
		const host = node["_node"];
		if (host === undefined) throw new Error("node host did not start");
		const dial = vi.spyOn(host, "dial").mockRejectedValue(new Error("transport fixture reached dial"));
		const defaultPolicy = realPolicyFactory(node)({
			onReservationEvent: (): void => undefined,
			source: sourceOf([
				candidate(TEST_PEER_ID, [
					`/ip4/1.2.3.4/tcp/4001/p2p/${TEST_PEER_ID}`,
					`/ip4/1.2.3.4/udp/4001/quic-v1/p2p/${TEST_PEER_ID}`,
				]),
			]),
			targetReservations: 1,
			totalDeadlineMs: 500,
		});

		try {
			const defaultResult = await defaultPolicy.acquire(Uint8Array.from([1, 2, 3]), AbortSignal.timeout(1_000));
			expect(dial).not.toHaveBeenCalled();
			expect(defaultResult.attempts).toContainEqual(expect.objectContaining({ status: "no-compatible-address" }));

			const nodePolicy = realPolicyFactory(node)({
				onReservationEvent: (): void => undefined,
				source: sourceOf([
					candidate(TEST_PEER_ID, [
						`/ip4/1.2.3.4/tcp/4001/p2p/${TEST_PEER_ID}`,
						`/ip4/1.2.3.4/udp/4001/quic-v1/p2p/${TEST_PEER_ID}`,
					]),
				]),
				targetReservations: 1,
				totalDeadlineMs: 500,
				transportProfile: RELAY_TRANSPORT_PROFILES.node,
			});
			const result = await nodePolicy.acquire(Uint8Array.from([1, 2, 3]), AbortSignal.timeout(1_000));
			expect(dial).toHaveBeenCalled();
			expect(result.attempts).not.toContainEqual(expect.objectContaining({ status: "no-compatible-address" }));
			await nodePolicy.stop();
		} finally {
			await defaultPolicy.stop();
		}
	});

	it("does not report live degraded overflow reservations as a failed policy result", async () => {
		const events: ControlPlaneEvent[] = [];
		const base = nodeOverflowConfig();
		const node = new DRPNetworkNode({
			...base,
			control_plane: {
				...base.control_plane,
				observability: { sink: (event): void => void events.push(event) },
			},
		});
		const source = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 2,
			sources: [
				{ enabled: true, name: "configured", priority: "primary", source: sourceOf([]) },
				{
					degradedOverflowEligible: true,
					enabled: true,
					name: "node-closest-peers",
					priority: "overflow",
					source: sourceOf([
						candidate(TEST_PEER_ID, [`/dns4/overflow-a.example.test/tcp/443/wss/p2p/${TEST_PEER_ID}`]),
						candidate("QmQCU2EcMqAqQPR2i9bV9aayZivWoHLMEZ2f9uZeX6NLGy", [
							"/dns4/overflow-b.example.test/tcp/443/wss/p2p/QmQCU2EcMqAqQPR2i9bV9aayZivWoHLMEZ2f9uZeX6NLGy",
						]),
					]),
				},
			],
		});
		const policy = deterministicRealPolicy(source);
		const controller = new AbortController();
		node["_relayPolicy"] = policy;
		node["_relayPolicyController"] = controller;
		try {
			const result = await policy.acquire(Uint8Array.from([4, 5, 6]), AbortSignal.timeout(1_000));
			node["_handleRelayPolicyResult"](result, policy, controller);
			expect(events).not.toContainEqual({ kind: "relay-reservation", outcome: "failed" });
			expect(result.terminal).toBe("reserved");
			expect(result.reservations).toHaveLength(2);
		} finally {
			node["_clearRelayMaintenance"]();
			node["_relayPolicy"] = undefined;
			node["_relayPolicyController"] = undefined;
			await policy.stop();
		}
	});

	it("distinguishes an acquire throw from an ordinary exhausted acquisition in telemetry", async () => {
		const events: ControlPlaneEvent[] = [];
		const acquireError = new Error("relay acquisition exploded");
		const relayPolicyFactory = (): RelayPolicyDriver => ({
			acquire: (): Promise<RelayPolicyResult> => Promise.reject(acquireError),
			refresh: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
			replace: (_peerId, reason): Promise<RelayReplacementResult> => Promise.resolve(replacementResult(reason)),
			stop: (): Promise<void> => Promise.resolve(),
		});
		const config = nodeOverflowConfig();
		const node = new DRPNetworkNode(
			{
				...config,
				control_plane: {
					...config.control_plane,
					observability: { sink: (event): void => void events.push(event) },
				},
			},
			{
				relayCandidateSources: { nodeClosestPeers: sourceOf([]) },
				relayPolicyFactory,
			}
		);
		startedNodes.push(node);

		await node.start();
		await vi.waitFor(() =>
			expect(events).toContainEqual({
				failure: "acquire-threw",
				kind: "relay-reservation",
				outcome: "failed",
			})
		);
	});

	it("rebuilds a torn-down relay policy when acquisition is retried after an initial throw", async () => {
		const firstStop = vi.fn((): Promise<void> => Promise.resolve());
		const secondAcquire = vi.fn(
			(): Promise<RelayPolicyResult> => Promise.resolve({ ...exhausted(), terminal: "reserved" })
		);
		const relayPolicyFactory = vi.fn((): RelayPolicyDriver => {
			if (relayPolicyFactory.mock.calls.length === 1) {
				return {
					acquire: (): Promise<RelayPolicyResult> => Promise.reject(new Error("initial acquire failed")),
					refresh: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
					replace: (_peerId, reason): Promise<RelayReplacementResult> => Promise.resolve(replacementResult(reason)),
					stop: firstStop,
				};
			}
			return {
				acquire: secondAcquire,
				refresh: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
				replace: (_peerId, reason): Promise<RelayReplacementResult> => Promise.resolve(replacementResult(reason)),
				stop: (): Promise<void> => Promise.resolve(),
			};
		});
		const node = new DRPNetworkNode(nodeOverflowConfig(), {
			relayCandidateSources: { nodeClosestPeers: sourceOf([]) },
			relayPolicyFactory,
		});
		startedNodes.push(node);

		await node.start();
		await vi.waitFor(() => expect(firstStop).toHaveBeenCalledOnce());
		expect(node["_relayPolicy"]).toBeUndefined();

		await node.retryRelayPolicyAcquisition();

		expect(relayPolicyFactory).toHaveBeenCalledTimes(2);
		expect(secondAcquire).toHaveBeenCalledOnce();
		expect(node["_relayPolicy"]).toBeDefined();
	});

	it("does not rebuild the relay policy when retried after the node was stopped", async () => {
		const relayPolicyFactory = vi.fn(
			(): RelayPolicyDriver => ({
				acquire: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
				refresh: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
				replace: (_peerId, reason): Promise<RelayReplacementResult> => Promise.resolve(replacementResult(reason)),
				stop: (): Promise<void> => Promise.resolve(),
			})
		);
		const node = new DRPNetworkNode(nodeOverflowConfig(), {
			relayCandidateSources: { nodeClosestPeers: sourceOf([]) },
			relayPolicyFactory,
		});
		startedNodes.push(node);

		await node.start();
		await node["_relayPolicyAcquirePromise"];
		expect(relayPolicyFactory).toHaveBeenCalledOnce();

		// stop() also nulls _relayPolicy/_relayPolicyController; a parked retry must NOT resurrect
		// the policy on a stopped host (only an acquire-throw teardown should rebuild).
		await node.stop();
		expect(node["_relayPolicy"]).toBeUndefined();

		await node.retryRelayPolicyAcquisition();

		expect(relayPolicyFactory).toHaveBeenCalledOnce();
		expect(node["_relayPolicy"]).toBeUndefined();
	});

	it("emits one failed event for each consecutive relay-policy failure episode", () => {
		const events: ControlPlaneEvent[] = [];
		const config = nodeOverflowConfig();
		const node = new DRPNetworkNode({
			...config,
			control_plane: {
				...config.control_plane,
				observability: { sink: (event): void => void events.push(event) },
			},
		});
		const policy: RelayPolicyDriver = {
			acquire: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
			refresh: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
			replace: (_peerId, reason): Promise<RelayReplacementResult> => Promise.resolve(replacementResult(reason)),
			stop: (): Promise<void> => Promise.resolve(),
		};
		const controller = new AbortController();
		node["_relayPolicy"] = policy;
		node["_relayPolicyController"] = controller;

		node["_handleRelayPolicyResult"](exhausted(), policy, controller);
		node["_handleRelayPolicyResult"](exhausted(), policy, controller);
		node["_handleRelayPolicyResult"]({ ...exhausted(), terminal: "reserved" }, policy, controller);
		node["_handleRelayPolicyResult"](exhausted(), policy, controller);

		expect(events.filter((event) => event.kind === "relay-reservation" && event.outcome === "failed")).toHaveLength(2);
		node["_clearRelayMaintenance"]();
	});
});

function nodeOverflowConfig(
	precondition: {
		readonly network: "local" | "public";
		readonly rolloutEnabled: boolean;
		readonly routingEnabled: boolean;
	} = {
		network: "public",
		rolloutEnabled: true,
		routingEnabled: true,
	}
): DRPNetworkNodeConfig {
	return {
		bootstrap_peers: [],
		control_plane: {
			relay_policy: { sources: { node_closest_peers: { enabled: true } }, target_reservations: 1 },
			rollout: { public_components: { delegated_routing: { enabled: precondition.rolloutEnabled } } },
			routing: {
				node: {
					enabled: precondition.routingEnabled,
					network: precondition.network,
					public_network_acknowledgement: "I_ACKNOWLEDGE_PUBLIC_NETWORK_TRAFFIC",
				},
			},
		},
		listen_addresses: [],
		log_config: { level: "silent" },
		seed: true,
	} as DRPNetworkNodeConfig;
}

function realPolicyFactory(node: DRPNetworkNode): (options: RelayPolicyFactoryOptions) => RelayPolicyDriver {
	return (
		node as unknown as { _createRelayPolicy(options: RelayPolicyFactoryOptions): RelayPolicyDriver }
	)._createRelayPolicy.bind(node);
}

function sourceOf(candidates: readonly RelayCandidate[]): RelayCandidateSource {
	return {
		async *getCandidates(): AsyncIterable<RelayCandidate> {
			await Promise.resolve();
			yield* candidates;
		},
	};
}

function trackedSource(consulted: () => void, candidates: readonly RelayCandidate[]): RelayCandidateSource {
	return {
		async *getCandidates(): AsyncIterable<RelayCandidate> {
			await Promise.resolve();
			consulted();
			yield* candidates;
		},
	};
}

function deterministicRealPolicy(source: RelayCandidateSource): RelayPolicy {
	const inspector: RelayInspector = {
		inspect: (): Promise<RelayInspection> =>
			Promise.resolve({
				connectionId: "deterministic-connection",
				hopAdvertised: true,
				latencyMs: 1,
				outcome: "connected",
				protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
			}),
	};
	const reservationClient: RelayReservationClient = {
		refresh: (_candidate, signal): Promise<RelayReservationWireResponse> => reservation(signal),
		release: (): Promise<void> => Promise.resolve(),
		reserve: (_candidate, signal): Promise<RelayReservationWireResponse> => reservation(signal),
	};
	return new RelayPolicy({
		inspector,
		limits: {
			maxCandidates: 4,
			maxConcurrentReservations: 1,
			maxPerOperatorGroup: 1,
			maxQueuedCandidates: 4,
			ownedFallbackDeadlineMs: 10,
			perCandidateDeadlineMs: 50,
			refreshBeforeExpiryMs: 30_000,
			requiredOperatorGroups: 2,
			requiredReservations: 2,
			totalDeadlineMs: 500,
		},
		now: (): number => 1_750_000_000_000,
		operatorGroupClassifier: new EvidenceDerivedOperatorGroupClassifier({
			verify: (): Promise<{ readonly verified: false }> => Promise.resolve({ verified: false }),
		}),
		reservationClient,
		source,
	});
}

function reservation(signal: AbortSignal): Promise<RelayReservationWireResponse> {
	signal.throwIfAborted();
	return Promise.resolve({
		reservation: { expire: Math.floor((1_750_000_000_000 + 60_000) / 1_000) },
		status: 100,
	});
}

function candidate(peerId: string, addresses: readonly string[]): RelayCandidate {
	return {
		addresses,
		operatorGroup: "unknown",
		peerId,
		protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
		provenance: {
			origin: "node-closest-peers",
			queryDigest: "query_5734a87d",
			resultIndex: 0,
			routingSource: "public-dht",
		},
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

function replacementResult(
	reason: "control-disconnected" | "expired" | "refresh-refused" | "relay-disconnected"
): RelayReplacementResult {
	return { ...exhausted(), reason, replacedPeerId: TEST_PEER_ID };
}
