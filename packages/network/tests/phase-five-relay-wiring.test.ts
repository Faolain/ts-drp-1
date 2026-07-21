import type { PeerId } from "@libp2p/interface";
import type { ControlPlaneEvent, DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRPNetworkNode } from "../src/node.js";

const QUERY = Uint8Array.from([1, 2, 3, 4]);

interface Candidate {
	readonly operatorGroup: string;
	readonly peerId: string;
	readonly provenance: { readonly origin: string };
}

interface CandidateSource {
	getCandidates(queryKey: Uint8Array, signal: AbortSignal): AsyncIterable<Candidate>;
}

interface RelayLifecycleEvent {
	readonly outcome: "acquired" | "expired" | "refused" | "released" | "replaced";
	readonly relayId: string;
}

interface RelayPolicyFactoryOptions {
	onReservationEvent(event: RelayLifecycleEvent): void;
	readonly source: CandidateSource;
}

interface RelayPolicyDriver {
	acquire(queryKey: Uint8Array, signal: AbortSignal): Promise<DriverResult>;
	refresh(signal: AbortSignal): Promise<DriverResult>;
	replace(peerId: string, reason: "relay-disconnected", signal: AbortSignal): Promise<DriverResult>;
	stop(): Promise<void>;
}

interface DriverResult {
	readonly reservations: readonly {
		readonly candidate: { readonly peerId: string };
		readonly expiresAtMs: number;
	}[];
	readonly terminal: string;
}

interface PhaseFiveDependencies {
	readonly relayCandidateSources: {
		readonly configuredFallback: CandidateSource;
		readonly delegatedClosestPeers?: CandidateSource;
		readonly dhtRelayProviders?: CandidateSource;
		readonly registryRelayRecords?: CandidateSource;
	};
	relayPolicyFactory(options: RelayPolicyFactoryOptions): RelayPolicyDriver;
}

describe("Phase 5 DRPNetworkNode relay-policy wiring", () => {
	const startedNodes: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(
			startedNodes.splice(0).map(async (node) => {
				if (node["_node"]?.status !== "stopped") await node.stop();
			})
		);
	});

	it("constructs RelayPolicy and drives acquisition through the configured composite source", async () => {
		const owned = sourceOf([candidate("owned-a", "verified:owned", "configured-fallback")]);
		const registry = sourceOf([candidate("registry-b", "verified:registry", "registry-relay-record")]);
		let observed: Candidate[] = [];
		const acquire = vi.fn(async (_queryKey: Uint8Array, signal: AbortSignal): Promise<DriverResult> => {
			const factoryOptions = relayPolicyFactory.mock.calls[0]?.[0];
			if (factoryOptions === undefined) throw new Error("relay policy factory was not called before acquisition");
			observed = await collect(factoryOptions.source, signal);
			return result("reserved");
		});
		const stop = vi.fn(() => Promise.resolve());
		const relayPolicyFactory = vi.fn((_options: RelayPolicyFactoryOptions): RelayPolicyDriver => ({
			acquire,
			refresh: () => Promise.resolve(result("reserved")),
			replace: () => Promise.resolve(result("reserved")),
			stop,
		}));
		const node = nodeWith(
			{
				...relayConfig(),
				control_plane: {
					...relayConfig().control_plane,
					relay_policy: {
						sources: {
							configured_fallback: { enabled: true },
							registry_relay_records: { enabled: true },
						},
						target_reservations: 2,
					},
				},
			} as unknown as DRPNetworkNodeConfig,
			{
				relayCandidateSources: { configuredFallback: owned, registryRelayRecords: registry },
				relayPolicyFactory,
			}
		);
		startedNodes.push(node);

		await node.start();

		expect(relayPolicyFactory).toHaveBeenCalledTimes(1);
		expect(acquire).toHaveBeenCalledTimes(1);
		expect(acquire.mock.calls[0]?.[0]).toEqual(expect.any(Uint8Array));
		await vi.waitFor(() => expect(observed.map(({ peerId }) => peerId)).toEqual(["owned-a", "registry-b"]));
	});

	it("keeps public sources disabled by default while the configured fallback remains enabled", async () => {
		const publicStarted = vi.fn();
		const relayPolicyFactory = vi.fn(
			(options: RelayPolicyFactoryOptions): RelayPolicyDriver => ({
				acquire: async (_queryKey, signal): Promise<DriverResult> => {
					await expect(collect(options.source, signal)).resolves.toMatchObject([{ peerId: "owned-floor" }]);
					return result("exhausted");
				},
				refresh: () => Promise.resolve(result("exhausted")),
				replace: () => Promise.resolve(result("exhausted")),
				stop: () => Promise.resolve(),
			})
		);
		const publicSource: CandidateSource = {
			async *getCandidates(): AsyncIterable<Candidate> {
				await Promise.resolve();
				publicStarted();
				yield candidate("public-a", "public:a", "dht-relay-provider");
			},
		};
		const node = nodeWith(relayConfig(), {
			relayCandidateSources: {
				configuredFallback: sourceOf([candidate("owned-floor", "verified:owned", "configured-fallback")]),
				delegatedClosestPeers: publicSource,
				dhtRelayProviders: publicSource,
				registryRelayRecords: publicSource,
			},
			relayPolicyFactory,
		});
		startedNodes.push(node);

		await node.start();

		expect(relayPolicyFactory).toHaveBeenCalledTimes(1);
		expect(publicStarted).toHaveBeenCalledTimes(0);
	});

	it("forwards every reservation lifecycle transition as sanitized control-plane telemetry", async () => {
		const events: ControlPlaneEvent[] = [];
		let emitLifecycle: ((event: RelayLifecycleEvent) => void) | undefined;
		const relayPolicyFactory = vi.fn((options: RelayPolicyFactoryOptions): RelayPolicyDriver => {
			emitLifecycle = options.onReservationEvent;
			return {
				acquire: async (): Promise<DriverResult> => {
					await Promise.resolve();
					options.onReservationEvent({ outcome: "acquired", relayId: "relay-a-raw-id" });
					options.onReservationEvent({ outcome: "refused", relayId: "relay-b-raw-id" });
					return result("reserved");
				},
				refresh: () => Promise.resolve(result("reserved")),
				replace: () => Promise.resolve(result("reserved")),
				stop: (): Promise<void> => {
					options.onReservationEvent({ outcome: "released", relayId: "relay-c-raw-id" });
					return Promise.resolve();
				},
			};
		});
		const node = nodeWith(
			{
				...relayConfig(),
				control_plane: {
					...relayConfig().control_plane,
					observability: { sink: (event): void => void events.push(event) },
				},
			},
			{
				relayCandidateSources: {
					configuredFallback: sourceOf([candidate("owned-floor", "verified:owned", "configured-fallback")]),
				},
				relayPolicyFactory,
			}
		);
		startedNodes.push(node);

		await node.start();
		expect(emitLifecycle, "node must subscribe to RelayPolicy reservation lifecycle transitions").toBeTypeOf(
			"function"
		);
		if (emitLifecycle === undefined) throw new Error("relay lifecycle callback was not wired");
		emitLifecycle({ outcome: "replaced", relayId: "relay-a-raw-id" });
		emitLifecycle({ outcome: "expired", relayId: "relay-d-raw-id" });
		await node.stop();

		const reservationEvents = events.filter(
			(event): event is Extract<ControlPlaneEvent, { kind: "relay-reservation" }> => event.kind === "relay-reservation"
		);
		expect(reservationEvents.map(({ outcome }) => outcome)).toEqual([
			"acquired",
			"refused",
			"replaced",
			"expired",
			"released",
		]);
		for (const event of reservationEvents) {
			expect(event.relayIdHash).toMatch(/^[a-f0-9]{8,64}$/u);
			expect(event.relayIdHash).toHaveLength(16);
			expect(event.relayIdHash).not.toContain("relay-");
		}
		expect(JSON.stringify(reservationEvents)).not.toContain("raw-id");
	});

	it("refreshes before expiry, replaces disconnected reservations, and cleans up maintenance ownership", async () => {
		const relayListeners = new Set<(event: CustomEvent<{ toString(): string }>) => void>();
		const acquire = vi.fn(() =>
			Promise.resolve(result("reserved", [reservation("relay-a", Date.now() + 30_020)]))
		);
		const refresh = vi.fn(() =>
			Promise.resolve(result("reserved", [reservation("relay-a", Date.now() + 60_000)]))
		);
		const replace = vi.fn(() =>
			Promise.resolve(result("reserved", [reservation("relay-c", Date.now() + 60_000)]))
		);
		const stop = vi.fn(() => Promise.resolve());
		let node!: DRPNetworkNode;
		const relayPolicyFactory = vi.fn((): RelayPolicyDriver => {
			const host = node["_node"];
			if (host === undefined) throw new Error("host must exist before relay policy construction");
			const originalAdd = host.addEventListener.bind(host);
			const originalRemove = host.removeEventListener.bind(host);
			host.addEventListener = ((type: string, listener: (event: CustomEvent<{ toString(): string }>) => void): void => {
				if (type === "peer:disconnect") relayListeners.add(listener);
				originalAdd(type as "peer:disconnect", listener as (event: CustomEvent<PeerId>) => void);
			}) as typeof host.addEventListener;
			host.removeEventListener = ((
				type: string,
				listener: (event: CustomEvent<{ toString(): string }>) => void
			): void => {
				if (type === "peer:disconnect") relayListeners.delete(listener);
				originalRemove(type, listener as (event: Event) => void);
			}) as typeof host.removeEventListener;
			return { acquire, refresh, replace, stop };
		});
		node = nodeWith(relayConfig(), {
			relayCandidateSources: {
				configuredFallback: sourceOf([candidate("relay-a", "verified:owned", "configured-fallback")]),
			},
			relayPolicyFactory,
		});
		startedNodes.push(node);

		await node.start();
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		expect(relayListeners).toHaveLength(1);
		const listener = [...relayListeners][0];
		if (listener === undefined) throw new Error("relay disconnect listener was not installed");
		listener(new CustomEvent("peer:disconnect", { detail: { toString: () => "relay-a" } }));
		await vi.waitFor(() =>
			expect(replace).toHaveBeenCalledWith("relay-a", "relay-disconnected", expect.any(AbortSignal))
		);
		const controller = node["_relayPolicyController"];
		if (controller === undefined) throw new Error("relay policy controller was not installed");
		const refreshCallsBeforeStop = refresh.mock.calls.length;

		await node.stop();
		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(controller.signal.aborted).toBe(true);
		expect(relayListeners).toHaveLength(0);
		expect(node["_relayRefreshTimer"]).toBeUndefined();
		expect(refresh).toHaveBeenCalledTimes(refreshCallsBeforeStop);
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("does not block node start on relay acquisition and reports an exhausted terminal", async () => {
		const events: ControlPlaneEvent[] = [];
		let finishAcquire: ((value: DriverResult) => void) | undefined;
		const acquire = vi.fn(
			() =>
				new Promise<DriverResult>((resolve) => {
					finishAcquire = resolve;
				})
		);
		const relayPolicyFactory = vi.fn(
			(): RelayPolicyDriver => ({
				acquire,
				refresh: () => Promise.resolve(result("exhausted")),
				replace: () => Promise.resolve(result("exhausted")),
				stop: () => Promise.resolve(),
			})
		);
		const base = relayConfig();
		const node = nodeWith(
			{
				...base,
				control_plane: {
					...base.control_plane,
					observability: { sink: (event): void => void events.push(event) },
				},
			},
			{
				relayCandidateSources: {
					configuredFallback: sourceOf([candidate("owned", "verified:owned", "configured-fallback")]),
				},
				relayPolicyFactory,
			}
		);
		startedNodes.push(node);

		await expect(
			Promise.race([
				node.start().then(() => "started"),
				new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
			])
		).resolves.toBe("started");
		expect(finishAcquire).toBeTypeOf("function");
		finishAcquire?.(result("exhausted"));
		await vi.waitFor(() =>
			expect(events).toContainEqual({ kind: "relay-reservation", outcome: "failed" })
		);
	});

	it("can stop while initial acquisition is pending without masking the abort", async () => {
		let acquisitionSignal: AbortSignal | undefined;
		const relayPolicyFactory = vi.fn(
			(): RelayPolicyDriver => ({
				acquire: (_queryKey, signal) => {
					acquisitionSignal = signal;
					return new Promise<DriverResult>((resolve) => {
						signal.addEventListener("abort", () => resolve(result("aborted")), { once: true });
					});
				},
				refresh: () => Promise.resolve(result("aborted")),
				replace: () => Promise.resolve(result("aborted")),
				stop: () => Promise.resolve(),
			})
		);
		const node = nodeWith(relayConfig(), {
			relayCandidateSources: { configuredFallback: sourceOf([]) },
			relayPolicyFactory,
		});
		startedNodes.push(node);

		await node.start();
		await expect(node.stop()).resolves.toBeUndefined();

		expect(acquisitionSignal?.aborted).toBe(true);
		expect(node["_relayPolicyController"]).toBeUndefined();
		expect(node["_relayPolicy"]).toBeUndefined();
	});

	it("accepts an enabled DI-backed configured fallback without serialized entries", async () => {
		const relayPolicyFactory = vi.fn(
			(): RelayPolicyDriver => ({
				acquire: () => Promise.resolve(result("reserved")),
				refresh: () => Promise.resolve(result("reserved")),
				replace: () => Promise.resolve(result("reserved")),
				stop: () => Promise.resolve(),
			})
		);
		const node = nodeWith(relayConfig(), {
			relayCandidateSources: { configuredFallback: sourceOf([]) },
			relayPolicyFactory,
		});
		startedNodes.push(node);

		await expect(node.start()).resolves.toBeUndefined();
		expect(relayPolicyFactory).toHaveBeenCalledTimes(1);
	});

	it("fails closed before host startup when an enabled source has no implementation", async () => {
		const node = new DRPNetworkNode(relayConfig());

		await expect(node.start()).rejects.toThrow(
			"control_plane.relay_policy enabled sources require injected implementations: configured_fallback"
		);
		expect(node["_node"]).toBeUndefined();
	});
});

function nodeWith(config: DRPNetworkNodeConfig, dependencies: PhaseFiveDependencies): DRPNetworkNode {
	return new DRPNetworkNode(config, dependencies as unknown as ConstructorParameters<typeof DRPNetworkNode>[1]);
}

function relayConfig(): DRPNetworkNodeConfig {
	return {
		bootstrap_peers: [],
		control_plane: {
			relay_policy: {
				sources: {
					configured_fallback: { enabled: true },
				},
			},
		},
		listen_addresses: [],
		log_config: { level: "silent" },
		seed: true,
	} as DRPNetworkNodeConfig;
}

function sourceOf(candidates: readonly Candidate[]): CandidateSource {
	return {
		async *getCandidates(queryKey, signal): AsyncIterable<Candidate> {
			expect(queryKey).toEqual(expect.any(Uint8Array));
			signal.throwIfAborted();
			await Promise.resolve();
			yield* candidates;
		},
	};
}

async function collect(source: CandidateSource, signal: AbortSignal): Promise<Candidate[]> {
	const output: Candidate[] = [];
	for await (const candidateItem of source.getCandidates(QUERY, signal)) output.push(candidateItem);
	return output;
}

function candidate(peerId: string, operatorGroup: string, origin: string): Candidate {
	return { operatorGroup, peerId, provenance: { origin } };
}

function reservation(peerId: string, expiresAtMs: number): DriverResult["reservations"][number] {
	return { candidate: { peerId }, expiresAtMs };
}

function result(terminal: string, reservations: DriverResult["reservations"] = []): DriverResult {
	return { reservations, terminal };
}
