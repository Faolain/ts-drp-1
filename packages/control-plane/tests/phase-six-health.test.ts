import { ControlPlaneHealthAggregator, type ControlPlaneHealthInput, RecoveryTerminal } from "@ts-drp/control-plane";
import { describe, expect, it } from "vitest";

const NOW_MS = 1_750_000_000_000;

describe("Phase 6 typed health aggregation", () => {
	it("keeps an authenticated synchronized mesh healthy when no configured bootstrap Peer ID is connected", (): void => {
		const aggregator = new ControlPlaneHealthAggregator({ now: (): number => NOW_MS });
		const snapshot = aggregator.aggregate(input({ connectedBootstrapPeerIds: [] }));

		expect(snapshot.state).toBe("healthy");
		expect(snapshot.authenticatedDrpPeerIds).toEqual(["drp-member-a"]);
		expect(snapshot.connectedBootstrapPeerIds).toEqual([]);
		expect(snapshot.objectSynchronization).toBe("synchronized");
	});

	it("does not treat a connected seed transport identity as DRP authentication or proof of control-plane health", (): void => {
		const aggregator = new ControlPlaneHealthAggregator({ now: (): number => NOW_MS });
		const snapshot = aggregator.aggregate(
			input({
				authenticatedDrpPeerIds: [],
				connectedBootstrapPeerIds: ["configured-seed-peer-id"],
				healthyBackendCount: 0,
				liveReservations: [],
				meshDiversity: { authenticatedPeerCount: 0, operatorGroupCount: 0, transportCount: 1 },
				objectSynchronization: "behind",
				rendezvous: { fresh: false, replicaAvailability: "unavailable", replicaCount: 0 },
				traffic: { directConnections: 1, relayedConnections: 0 },
			})
		);

		expect(snapshot.state).toBe("degraded");
		expect(snapshot.reasons).toEqual(
			expect.arrayContaining(["no-authenticated-drp-peer", "rendezvous-stale", "no-live-reservation"])
		);
	});

	it("retires skip-reconnect-iff-bootstrap-connected from the health path", (): void => {
		const aggregator = new ControlPlaneHealthAggregator({ now: (): number => NOW_MS });
		const healthyWithoutSeed = aggregator.aggregate(input({ connectedBootstrapPeerIds: [] }));
		const healthyWithSeed = aggregator.aggregate(input({ connectedBootstrapPeerIds: ["seed-a"] }));
		const seedOnly = aggregator.aggregate(
			input({
				authenticatedDrpPeerIds: [],
				connectedBootstrapPeerIds: ["seed-a"],
				liveReservations: [],
				objectSynchronization: "unknown",
				rendezvous: { fresh: false, replicaAvailability: "unavailable", replicaCount: 0 },
			})
		);

		expect(healthyWithoutSeed.state).toBe("healthy");
		expect(healthyWithSeed.state).toBe(healthyWithoutSeed.state);
		expect(seedOnly.state).not.toBe("healthy");
	});

	it.each([
		{ healthyBackendCount: 0, name: "no healthy backend" },
		{
			name: "stale rendezvous",
			rendezvous: { fresh: false, replicaAvailability: "available" as const, replicaCount: 2 },
		},
		{ liveReservations: [], name: "no live relay reservation" },
	])("demotes a data-plane mesh when it has $name", (override): void => {
		const aggregator = new ControlPlaneHealthAggregator({ now: (): number => NOW_MS });
		expect(aggregator.aggregate(input(override)).state).toBe("degraded");
	});

	it("does not call an unknown sole-writer synchronization state behind", (): void => {
		const aggregator = new ControlPlaneHealthAggregator({ now: (): number => NOW_MS });
		const snapshot = aggregator.aggregate(input({ objectSynchronization: "unknown" }));

		expect(snapshot.state).toBe("healthy");
		expect(snapshot.reasons).not.toContain("objects-not-synchronized");
	});

	it("keeps an idle subscriber healthy without peer-dependent degradation reasons", (): void => {
		const aggregator = new ControlPlaneHealthAggregator({ now: (): number => NOW_MS });
		const snapshot = aggregator.aggregate(
			input({
				authenticatedDrpPeerIds: [],
				meshDiversity: { authenticatedPeerCount: 0, operatorGroupCount: 0, transportCount: 0 },
				subscribedObjectCount: 0,
				traffic: { directConnections: 0, relayedConnections: 0 },
			})
		);

		expect(snapshot.state).toBe("healthy");
		expect(snapshot.reasons).not.toContain("no-authenticated-drp-peer");
		expect(snapshot.reasons).not.toContain("no-active-traffic");
		expect(snapshot.reasons).not.toContain("insufficient-mesh-diversity");
	});

	it.each([
		{ name: "an omitted subscription count", subscribedObjectCount: undefined },
		{ name: "one subscribed object", subscribedObjectCount: 1 },
	])("preserves peer-dependent outage reasons for $name", ({ subscribedObjectCount }): void => {
		const aggregator = new ControlPlaneHealthAggregator({ now: (): number => NOW_MS });
		const snapshot = aggregator.aggregate(
			input({
				authenticatedDrpPeerIds: [],
				meshDiversity: { authenticatedPeerCount: 0, operatorGroupCount: 0, transportCount: 0 },
				subscribedObjectCount,
				traffic: { directConnections: 0, relayedConnections: 0 },
			})
		);

		expect(snapshot.state).toBe("degraded");
		expect(snapshot.reasons).toEqual(
			expect.arrayContaining(["no-authenticated-drp-peer", "no-active-traffic", "insufficient-mesh-diversity"])
		);
	});

	it("still reports a missing relay reservation for an idle subscriber", (): void => {
		const aggregator = new ControlPlaneHealthAggregator({ now: (): number => NOW_MS });
		const snapshot = aggregator.aggregate(input({ liveReservations: [], subscribedObjectCount: 0 }));

		expect(snapshot.state).toBe("degraded");
		expect(snapshot.reasons).toContain("no-live-reservation");
	});

	it("returns a deeply immutable typed snapshot including failed recovery-attempt identifiers", (): void => {
		const failedRecoveryAttempts = [
			{ action: "fallback-router", id: "router-a:attempt-2", terminal: RecoveryTerminal.Failed },
		] as const;
		const aggregator = new ControlPlaneHealthAggregator({ now: (): number => NOW_MS });
		const snapshot = aggregator.aggregate(input({ failedRecoveryAttempts }));

		expect(snapshot.failedRecoveryAttempts).toEqual(failedRecoveryAttempts);
		expect(snapshot.observedAtMs).toBe(NOW_MS);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.failedRecoveryAttempts)).toBe(true);
		expect(Object.isFrozen(snapshot.rendezvous)).toBe(true);
		expect(Object.isFrozen(snapshot.traffic)).toBe(true);
		expect(() => {
			(snapshot.failedRecoveryAttempts as Array<unknown>).push("mutation");
		}).toThrow(TypeError);
	});
});

function input(overrides: Partial<ControlPlaneHealthInput> = {}): ControlPlaneHealthInput {
	return {
		authenticatedDrpPeerIds: ["drp-member-a"],
		connectedBootstrapPeerIds: [],
		failedRecoveryAttempts: [],
		healthyBackendCount: 2,
		liveReservations: [{ operatorGroup: "operator-a", relayId: "relay-a" }],
		meshDiversity: { authenticatedPeerCount: 2, operatorGroupCount: 2, transportCount: 2 },
		objectSynchronization: "synchronized",
		rendezvous: { fresh: true, replicaAvailability: "available", replicaCount: 2 },
		traffic: { directConnections: 1, relayedConnections: 1 },
		...overrides,
	};
}
