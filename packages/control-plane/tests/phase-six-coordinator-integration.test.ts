import {
	ControlPlaneCoordinator,
	type ControlPlaneHealthSnapshot,
	type ControlPlaneMechanismPorts,
	RecoveryTerminal,
} from "@ts-drp/control-plane";
import { describe, expect, it, vi } from "vitest";

import { createRecoveryHarness, healthSnapshot } from "./phase-six-fixtures.js";

describe("Phase 6 coordinator integration", () => {
	it("enforces the parent deadline against a mechanism that ignores AbortSignal and releases its timer", async () => {
		const harness = createRecoveryHarness({ max_attempts: 1, parent_deadline_ms: 100, retry_delays_ms: [] });
		harness.ports.rendezvousBootstrap.mockImplementation(() => new Promise(() => {}));
		const coordinator = new ControlPlaneCoordinator(harness.options);

		const recovery = coordinator.recover(
			{ kind: "everything-unavailable" },
			healthSnapshot({ state: "degraded" }),
			new AbortController().signal
		);
		await vi.waitFor(() => expect(harness.ports.rendezvousBootstrap).toHaveBeenCalledOnce());
		harness.scheduler.advanceBy(100);
		const result = await recovery;

		expect(result.terminal).toBe(RecoveryTerminal.Deadline);
		expect(result.operations).toContainEqual({ id: "rendezvous", terminal: RecoveryTerminal.Deadline });
		expect(result.cleanup).toEqual({ leakSample: { activeTimers: 0 }, outcome: "complete" });
		expect(harness.scheduler.pendingCount()).toBe(0);
	});

	it("stops while an observed hostile recovery is in flight", async () => {
		const harness = createRecoveryHarness({
			max_attempts: 1,
			parent_deadline_ms: 100,
			retry_delays_ms: [],
			startup_grace_ms: 0,
		});
		harness.ports.rendezvousBootstrap.mockImplementation(() => new Promise(() => {}));
		const status = healthSnapshot({
			authenticatedDrpPeerIds: [],
			healthyBackendCount: 0,
			liveReservations: [],
			meshDiversity: { authenticatedPeerCount: 0, operatorGroupCount: 0, transportCount: 0 },
			objectSynchronization: "unknown",
			rendezvous: { fresh: false, replicaAvailability: "unavailable", replicaCount: 0 },
			state: "degraded",
			traffic: { directConnections: 0, relayedConnections: 0 },
		});
		const coordinator = new ControlPlaneCoordinator({
			...harness.options,
			readStatus: (): ControlPlaneHealthSnapshot => status,
		});

		coordinator.start();
		await vi.waitFor(() => expect(harness.ports.rendezvousBootstrap).toHaveBeenCalledOnce());
		const stopping = coordinator.stop();
		await stopping;

		expect(harness.ports.rendezvousBootstrap).toHaveBeenCalledOnce();
		expect(harness.scheduler.pendingCount()).toBe(0);
		expect(harness.events).toContainEqual({ kind: "terminal", reason: "stopped" });
	});

	it.each([
		{
			assert: (ports: RecoveryHarnessPorts): void => expect(ports.relayReplace).toHaveBeenCalledOnce(),
			name: "relay-disconnected",
			status: healthSnapshot({ liveReservations: [], reasons: ["no-live-reservation"], state: "degraded" }),
		},
		{
			assert: (ports: RecoveryHarnessPorts): void => {
				expect(ports.registryCooldown).toHaveBeenCalledWith(expect.objectContaining({ backendId: "registry-a" }));
				expect(ports.rendezvousBootstrap).toHaveBeenCalledWith(
					expect.objectContaining({
						excludeBackendIds: ["registry-a"],
						preferredRegistryIds: ["registry-b"],
						sources: ["registries"],
					}),
					expect.any(AbortSignal)
				);
			},
			name: "registry-failed",
			status: healthSnapshot({
				healthyBackendCount: 1,
				rendezvous: {
					backends: [
						{ id: "registry-a", status: "failed" },
						{ id: "registry-b", status: "succeeded" },
					],
					fresh: true,
					replicaAvailability: "partial",
					replicaCount: 1,
				},
				state: "degraded",
			}),
		},
		{
			assert: (ports: RecoveryHarnessPorts): void =>
				expect(ports.rendezvousBootstrap).toHaveBeenCalledWith(
					{ sources: ["dht-anchor", "cache", "signed-invite"] },
					expect.any(AbortSignal)
				),
			name: "all-registries-failed",
			status: healthSnapshot({
				healthyBackendCount: 0,
				rendezvous: {
					backends: [
						{ id: "registry-a", status: "failed" },
						{ id: "registry-b", status: "failed" },
					],
					fresh: false,
					replicaAvailability: "unavailable",
					replicaCount: 0,
				},
				state: "degraded",
			}),
		},
		{
			assert: (ports: RecoveryHarnessPorts): void =>
				expect(ports.syncFromDifferentPeer).toHaveBeenCalledWith(
					{ candidates: ["member-b"], excludedPeerId: "member-a" },
					expect.any(AbortSignal)
				),
			name: "peer-disappeared",
			status: healthSnapshot({
				authenticatedDrpPeerIds: ["member-b"],
				lostAuthenticatedPeerIds: ["member-a"],
				objectSynchronization: "behind",
				state: "degraded",
			}),
		},
		{
			assert: (ports: RecoveryHarnessPorts): void =>
				expect(ports.continueRelayed).toHaveBeenCalledWith({ peerId: "member-a" }, expect.any(AbortSignal)),
			name: "direct-connection-failed",
			status: healthSnapshot({
				directConnectionFailedPeerIds: ["member-a"],
				reasons: ["direct-connection-failed"],
				state: "degraded",
			}),
		},
		{
			assert: (ports: RecoveryHarnessPorts): void =>
				expect(ports.routerFallback).toHaveBeenCalledWith(
					{ failedRouterId: "router-a", sources: ["alternate-router", "registry-records"] },
					expect.any(AbortSignal)
				),
			name: "delegated-router-failed",
			status: healthSnapshot({
				reasons: ["delegated-router-failed"],
				routing: { failedRouterIds: ["router-a"] },
				state: "degraded",
			}),
		},
		{
			assert: (ports: RecoveryHarnessPorts): void =>
				expect(ports.rendezvousBootstrap).toHaveBeenCalledWith({ sources: ["registries"] }, expect.any(AbortSignal)),
			name: "dht-unavailable",
			status: healthSnapshot({
				reasons: ["dht-unavailable"],
				rendezvous: {
					backends: [
						{ id: "dht-anchor", status: "failed" },
						{ id: "registry-a", status: "succeeded" },
					],
					fresh: true,
					replicaAvailability: "partial",
					replicaCount: 1,
				},
				state: "degraded",
			}),
		},
	])("dispatches $name from observed typed health", async ({ assert, status }) => {
		const harness = createRecoveryHarness({ startup_grace_ms: 0 });
		const coordinator = new ControlPlaneCoordinator({
			...harness.options,
			readStatus: (): ControlPlaneHealthSnapshot => status,
		});

		coordinator.start();
		await vi.waitFor(() => assert(harness.ports));
		await coordinator.stop();

		expect(harness.scheduler.pendingCount()).toBe(0);
	});

	it("honors cooldown exclusions on every later registries-touching plan", async () => {
		const harness = createRecoveryHarness({ backend_cooldown_ms: 1_000 });
		const coordinator = new ControlPlaneCoordinator(harness.options);
		const signal = new AbortController().signal;

		await coordinator.recover(
			{ backendId: "registry-a", kind: "registry-failed", remainingBackendIds: ["registry-b"] },
			healthSnapshot(),
			signal
		);
		harness.scheduler.advanceBy(999);
		await coordinator.recover({ kind: "dht-unavailable" }, healthSnapshot(), signal);
		await coordinator.recover({ kind: "everything-unavailable" }, healthSnapshot(), signal);

		expect(harness.ports.rendezvousBootstrap).toHaveBeenNthCalledWith(
			2,
			{ excludeBackendIds: ["registry-a"], sources: ["registries"] },
			expect.any(AbortSignal)
		);
		expect(harness.ports.rendezvousBootstrap).toHaveBeenNthCalledWith(
			3,
			{
				excludeBackendIds: ["registry-a"],
				sources: ["registries", "dht-anchor", "cache", "signed-invite"],
			},
			expect.any(AbortSignal)
		);
	});

	it("does not retain a phantom cooldown when the cooldown port throws", async () => {
		const harness = createRecoveryHarness();
		harness.ports.registryCooldown.mockImplementationOnce((): never => {
			throw new Error("cooldown owner unavailable");
		});
		const coordinator = new ControlPlaneCoordinator(harness.options);
		const signal = new AbortController().signal;

		await coordinator.recover(
			{ backendId: "registry-a", kind: "registry-failed", remainingBackendIds: ["registry-b"] },
			healthSnapshot(),
			signal
		);
		await coordinator.recover({ kind: "dht-unavailable" }, healthSnapshot(), signal);

		expect(harness.ports.rendezvousBootstrap).toHaveBeenLastCalledWith(
			{ sources: ["registries"] },
			expect.any(AbortSignal)
		);
	});

	it("applies inter-run backoff instead of recovering on every health event", async () => {
		const harness = createRecoveryHarness({
			max_attempts: 1,
			recovery_backoff_ms: 500,
			retry_delays_ms: [],
			startup_grace_ms: 0,
		});
		harness.ports.relayReplace.mockResolvedValue({ terminal: "failed" });
		const status = healthSnapshot({
			liveReservations: [],
			reasons: ["no-live-reservation"],
			state: "degraded",
		});
		let listener: ((snapshot: ControlPlaneHealthSnapshot) => void) | undefined;
		const coordinator = new ControlPlaneCoordinator({
			...harness.options,
			readStatus: (): ControlPlaneHealthSnapshot => status,
			subscribeStatus: (candidate): (() => void) => {
				listener = candidate;
				return (): void => {};
			},
		});

		coordinator.start();
		await vi.waitFor(() => expect(harness.ports.relayReplace).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(harness.events).toContainEqual({ kind: "terminal", reason: "exhausted" }));
		for (let index = 0; index < 5; index += 1) listener?.(status);
		harness.scheduler.advanceBy(499);
		await Promise.resolve();
		expect(harness.ports.relayReplace).toHaveBeenCalledOnce();
		harness.scheduler.advanceBy(1);
		await vi.waitFor(() => expect(harness.ports.relayReplace).toHaveBeenCalledTimes(2));
		await coordinator.stop();
	});

	it("polls a healthy status so a later relay failure reaches observation", async () => {
		const harness = createRecoveryHarness({ health_poll_interval_ms: 100, startup_grace_ms: 0 });
		let status = healthSnapshot();
		const coordinator = new ControlPlaneCoordinator({
			...harness.options,
			readStatus: (): ControlPlaneHealthSnapshot => status,
		});

		coordinator.start();
		expect(harness.ports.relayReplace).not.toHaveBeenCalled();
		status = healthSnapshot({
			liveReservations: [],
			reasons: ["no-live-reservation"],
			state: "degraded",
		});
		harness.scheduler.advanceBy(100);
		await vi.waitFor(() => expect(harness.ports.relayReplace).toHaveBeenCalledOnce());
		await coordinator.stop();
	});

	it("reserves everything-unavailable for a genuine total outage", async () => {
		const harness = createRecoveryHarness({ startup_grace_ms: 0 });
		const status = healthSnapshot({
			authenticatedDrpPeerIds: [],
			healthyBackendCount: 0,
			liveReservations: [],
			meshDiversity: { authenticatedPeerCount: 0, operatorGroupCount: 0, transportCount: 0 },
			objectSynchronization: "unknown",
			rendezvous: {
				backends: [{ id: "registry-a", status: "failed" }],
				fresh: false,
				replicaAvailability: "unavailable",
				replicaCount: 0,
			},
			state: "degraded",
			traffic: { directConnections: 0, relayedConnections: 0 },
		});
		const coordinator = new ControlPlaneCoordinator({
			...harness.options,
			readStatus: (): ControlPlaneHealthSnapshot => status,
		});

		coordinator.start();
		await vi.waitFor(() => expect(harness.ports.rendezvousBootstrap).toHaveBeenCalledOnce());
		expect(harness.ports.rendezvousBootstrap).toHaveBeenCalledWith(
			{ sources: ["registries", "dht-anchor", "cache", "signed-invite"] },
			expect.any(AbortSignal)
		);
		await coordinator.stop();
	});

	it("does not turn an unclassified partial degradation into total-outage recovery", async () => {
		const harness = createRecoveryHarness({ startup_grace_ms: 0 });
		const status = healthSnapshot({
			meshDiversity: { authenticatedPeerCount: 1, operatorGroupCount: 0, transportCount: 1 },
			reasons: ["insufficient-mesh-diversity"],
			state: "degraded",
		});
		const coordinator = new ControlPlaneCoordinator({
			...harness.options,
			readStatus: (): ControlPlaneHealthSnapshot => status,
		});

		coordinator.start();
		await Promise.resolve();
		expect(harness.ports.rendezvousBootstrap).not.toHaveBeenCalled();
		expect(harness.ports.relayReplace).not.toHaveBeenCalled();
		await coordinator.stop();
	});

	it.each([
		[{ max_attempts: 0 }, "max_attempts"],
		[{ parent_deadline_ms: 0 }, "parent_deadline_ms"],
		[{ backend_cooldown_ms: Number.NaN }, "backend_cooldown_ms"],
		[{ retry_delays_ms: [-1] }, "retry_delays_ms[0]"],
		[{ parent_deadline_ms: 300_001 }, "parent_deadline_ms"],
	] as const)("fails fast for invalid recovery config %o", (override, field): void => {
		const harness = createRecoveryHarness(override);
		expect(() => new ControlPlaneCoordinator(harness.options)).toThrow(field);
	});

	it("supplies an explicit retry schedule when retry_delays_ms is omitted", async () => {
		const harness = createRecoveryHarness({ max_attempts: 2 });
		const configWithoutDelays = { ...harness.config };
		delete (configWithoutDelays as { retry_delays_ms?: readonly number[] }).retry_delays_ms;
		harness.ports.rendezvousBootstrap.mockResolvedValue({ terminal: "failed" });
		const coordinator = new ControlPlaneCoordinator({ ...harness.options, config: configWithoutDelays });

		const result = await coordinator.recover(
			{ kind: "dht-unavailable" },
			healthSnapshot(),
			new AbortController().signal
		);

		expect(result.attempts).toBe(2);
		expect(harness.scheduler.sleeps).toEqual([100]);
		expect(result.terminal).toBe(RecoveryTerminal.Exhausted);
		expect(harness.events).toContainEqual({ kind: "terminal", reason: "exhausted" });
	});
});

type RecoveryHarnessPorts = ControlPlaneMechanismPorts & {
	readonly continueRelayed: ReturnType<typeof vi.fn>;
	readonly registryCooldown: ReturnType<typeof vi.fn>;
	readonly relayReplace: ReturnType<typeof vi.fn>;
	readonly rendezvousBootstrap: ReturnType<typeof vi.fn>;
	readonly routerFallback: ReturnType<typeof vi.fn>;
	readonly syncFromDifferentPeer: ReturnType<typeof vi.fn>;
};
