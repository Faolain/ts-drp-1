import type {
	DRPNetworkHostConfigSnapshot,
	DRPNetworkHostFactoryContext,
	DRPNetworkNodeDependencies,
	RelayPolicyFactoryOptions,
} from "@ts-drp/network";
import type {
	ActiveRelayReservation,
	RelayCandidateSource,
	RelayPolicyOptions,
	RelayPolicyResult,
	RelayReplacementResult,
} from "@ts-drp/relay-policy";
import type { DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildModularNetworkConfig, type GridNetworkEnv } from "./network-config.js";

let capturedNetworkDependencies: DRPNetworkNodeDependencies | undefined;
let capturedRelayPolicyOptions: RelayPolicyOptions | undefined;

afterEach((): void => {
	capturedNetworkDependencies = undefined;
	capturedRelayPolicyOptions = undefined;
	vi.doUnmock("@ts-drp/network");
	vi.doUnmock("@ts-drp/relay-policy");
	vi.resetModules();
});

describe("modular grid relay policy RED contract", () => {
	it("forwards factory deadlines into the grid RelayPolicy limits", async () => {
		vi.doMock("@ts-drp/network", async (): Promise<Record<string, unknown>> => {
			const actual = await vi.importActual<Record<string, unknown>>("@ts-drp/network");
			class CapturingNetworkNode {
				readonly peerId = "grid-relay-deadline-red";

				constructor(_config: DRPNetworkNodeConfig | undefined, dependencies: DRPNetworkNodeDependencies = {}) {
					capturedNetworkDependencies = dependencies;
				}

				safeDial(): Promise<object> {
					return Promise.resolve({});
				}

				disconnect(): Promise<void> {
					return Promise.resolve();
				}

				getControlPlaneConnections(): readonly never[] {
					return [];
				}

				getActiveRelayReservations(): readonly never[] {
					return [];
				}
			}

			return {
				...actual,
				DRPNetworkNode: CapturingNetworkNode,
			};
		});
		vi.doMock("@ts-drp/relay-policy", async (): Promise<Record<string, unknown>> => {
			const actual = await vi.importActual<Record<string, unknown>>("@ts-drp/relay-policy");
			class CapturingRelayPolicy {
				constructor(options: RelayPolicyOptions) {
					capturedRelayPolicyOptions = options;
				}

				get activeReservations(): readonly ActiveRelayReservation[] {
					return [];
				}

				acquire(): Promise<RelayPolicyResult> {
					return Promise.resolve(exhaustedRelayPolicyResult());
				}

				refresh(): Promise<RelayPolicyResult> {
					return Promise.resolve(exhaustedRelayPolicyResult());
				}

				replace(peerId: string, reason: RelayReplacementResult["reason"]): Promise<RelayReplacementResult> {
					return Promise.resolve({ ...exhaustedRelayPolicyResult(), reason, replacedPeerId: peerId });
				}

				stop(): Promise<void> {
					return Promise.resolve();
				}
			}

			return {
				...actual,
				RelayPolicy: CapturingRelayPolicy,
			};
		});
		const { createModularGridNetwork } = await import("./modular-network.js");
		const environment = publicModularEnvironment();
		createModularGridNetwork(buildModularNetworkConfig(environment), environment);
		const dependencies = capturedNetworkDependencies;
		if (dependencies === undefined) throw new Error("grid did not construct its network");
		const hostFactory = dependencies.hostFactory;
		if (hostFactory === undefined) throw new Error("grid did not provide its host factory");
		const hostContext: DRPNetworkHostFactoryContext = {
			createHost: (): ReturnType<DRPNetworkHostFactoryContext["createHost"]> =>
				Promise.resolve({} as Awaited<ReturnType<DRPNetworkHostFactoryContext["createHost"]>>),
			snapshot: {} as DRPNetworkHostConfigSnapshot,
		};
		await hostFactory(hostContext);
		const relayPolicyFactory = dependencies.relayPolicyFactory;
		if (relayPolicyFactory === undefined) throw new Error("grid did not provide its relay policy factory");

		const factoryOptions: RelayPolicyFactoryOptions = {
			onReservationEvent: (): void => undefined,
			perCandidateDeadlineMs: 8_000,
			source: emptyCandidateSource(),
			targetReservations: 1,
			totalDeadlineMs: 30_000,
		};
		relayPolicyFactory(factoryOptions);
		const policyOptions = capturedRelayPolicyOptions;
		if (policyOptions === undefined) throw new Error("grid relay policy factory did not construct RelayPolicy");

		expect(policyOptions.limits).toMatchObject({
			perCandidateDeadlineMs: factoryOptions.perCandidateDeadlineMs,
			totalDeadlineMs: factoryOptions.totalDeadlineMs,
		});
	});
});

function publicModularEnvironment(): GridNetworkEnv {
	return {
		allowInsecureFixture: undefined,
		bootstrapPeers: "",
		discoveryInterval: 0,
		enablePrometheusMetrics: false,
		membershipInvite: "grid-public-invite-0123456789",
		networkMode: "modular",
		nostrRelays: ["wss://relay.example"],
		rendezvousNamespace: `drp-network:v1:${"g".repeat(43)}`,
		routingEndpoints: "https://routing-a.example/routing/v1/,https://routing-b.example/routing/v1/",
	};
}

function emptyCandidateSource(): RelayCandidateSource {
	return {
		async *getCandidates(_queryKey: Uint8Array, signal: AbortSignal): AsyncIterable<never> {
			signal.throwIfAborted();
			await Promise.resolve();
			for (const candidate of [] as never[]) yield candidate;
		},
	};
}

function exhaustedRelayPolicyResult(): RelayPolicyResult {
	return {
		attempts: [],
		candidatesObserved: 0,
		durationMs: 0,
		operatorGroups: [],
		reservations: [],
		terminal: "exhausted",
	};
}
