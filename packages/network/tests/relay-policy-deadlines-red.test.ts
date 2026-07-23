import type { RelayCandidateSource, RelayPolicyResult, RelayReplacementResult } from "@ts-drp/relay-policy";
import type { DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRPNetworkNode, type RelayPolicyDriver, type RelayPolicyFactoryOptions } from "../src/node.js";

interface RelayDeadlineConfig {
	readonly per_candidate_deadline_ms?: number;
	readonly total_deadline_ms?: number;
}

describe("relay-policy reservation deadline configuration RED contract", () => {
	const startedNodes: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(startedNodes.splice(0).map((node) => node.stop()));
	});

	it("forwards configured per-candidate and total deadlines to the relay policy factory", async () => {
		let capturedOptions: RelayPolicyFactoryOptions | undefined;
		const relayPolicyFactory = vi.fn((options: RelayPolicyFactoryOptions): RelayPolicyDriver => {
			capturedOptions = options;
			return idlePolicy();
		});
		const node = new DRPNetworkNode(relayConfig({ per_candidate_deadline_ms: 8_000, total_deadline_ms: 30_000 }), {
			relayCandidateSources: { configuredFallback: emptySource() },
			relayPolicyFactory,
		});
		startedNodes.push(node);

		await node.start();

		expect(relayPolicyFactory).toHaveBeenCalledOnce();
		expect(capturedOptions).toMatchObject({
			perCandidateDeadlineMs: 8_000,
			totalDeadlineMs: 30_000,
		});
	});

	it("forwards the existing relay-policy deadline defaults when configuration omits them", async () => {
		let capturedOptions: RelayPolicyFactoryOptions | undefined;
		const relayPolicyFactory = vi.fn((options: RelayPolicyFactoryOptions): RelayPolicyDriver => {
			capturedOptions = options;
			return idlePolicy();
		});
		const node = new DRPNetworkNode(relayConfig(), {
			relayCandidateSources: { configuredFallback: emptySource() },
			relayPolicyFactory,
		});
		startedNodes.push(node);

		await node.start();

		expect(relayPolicyFactory).toHaveBeenCalledOnce();
		expect(capturedOptions).toMatchObject({
			perCandidateDeadlineMs: 1_000,
			totalDeadlineMs: 5_000,
		});
	});

	it("pins the node-overflow deadline defaults when configuration omits them", async () => {
		let capturedOptions: RelayPolicyFactoryOptions | undefined;
		const relayPolicyFactory = vi.fn((options: RelayPolicyFactoryOptions): RelayPolicyDriver => {
			capturedOptions = options;
			return idlePolicy();
		});
		const node = new DRPNetworkNode(nodeOverflowRelayConfig(), {
			relayCandidateSources: { nodeClosestPeers: emptySource() },
			relayPolicyFactory,
		});
		startedNodes.push(node);

		await node.start();

		expect(relayPolicyFactory).toHaveBeenCalledOnce();
		expect(capturedOptions).toMatchObject({
			perCandidateDeadlineMs: 1_000,
			totalDeadlineMs: 55_000,
		});
	});

	it.each([
		{
			deadlines: { per_candidate_deadline_ms: 0, total_deadline_ms: 5_000 },
			expectedField: /control_plane\.relay_policy\.per_candidate_deadline_ms/u,
			scenario: "a per-candidate deadline below 1",
		},
		{
			deadlines: { per_candidate_deadline_ms: 8_000, total_deadline_ms: 7_999 },
			expectedField: /control_plane\.relay_policy\.total_deadline_ms/u,
			scenario: "a total deadline below the per-candidate deadline",
		},
	] as const)("rejects $scenario during relay-policy configuration validation", ({ deadlines, expectedField }) => {
		expect(
			() =>
				new DRPNetworkNode(relayConfig(deadlines), {
					relayCandidateSources: { configuredFallback: emptySource() },
				})
		).toThrow(expectedField);
	});

	it("explains when a per-candidate deadline exceeds the defaulted total deadline", () => {
		expect(
			() =>
				new DRPNetworkNode(relayConfig({ per_candidate_deadline_ms: 8_000 }), {
					relayCandidateSources: { configuredFallback: emptySource() },
				})
		).toThrow(
			/control_plane\.relay_policy\.per_candidate_deadline_ms \(8000\) exceeds the effective default total deadline \(5000\); set control_plane\.relay_policy\.total_deadline_ms/u
		);
	});
});

function relayConfig(deadlines: RelayDeadlineConfig = {}): DRPNetworkNodeConfig {
	return {
		bootstrap_peers: [],
		control_plane: {
			relay_policy: {
				...deadlines,
				sources: {
					configured_fallback: { enabled: true },
				},
			},
		},
		listen_addresses: [],
		log_config: { level: "silent" },
		seed: true,
	} as unknown as DRPNetworkNodeConfig;
}

function nodeOverflowRelayConfig(): DRPNetworkNodeConfig {
	return {
		bootstrap_peers: [],
		control_plane: {
			relay_policy: {
				sources: { node_closest_peers: { enabled: true } },
				target_reservations: 1,
			},
			rollout: { public_components: { delegated_routing: { enabled: true } } },
			routing: {
				node: {
					enabled: true,
					network: "public",
					public_network_acknowledgement: "I_ACKNOWLEDGE_PUBLIC_NETWORK_TRAFFIC",
				},
			},
		},
		listen_addresses: [],
		log_config: { level: "silent" },
		seed: true,
	} as unknown as DRPNetworkNodeConfig;
}

function emptySource(): RelayCandidateSource {
	return {
		async *getCandidates(_queryKey: Uint8Array, signal: AbortSignal): AsyncIterable<never> {
			signal.throwIfAborted();
			await Promise.resolve();
			for (const candidate of [] as never[]) yield candidate;
		},
	};
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
