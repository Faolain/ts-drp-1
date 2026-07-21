import { ControlPlaneCoordinator, RecoveryTerminal } from "@ts-drp/control-plane";
import { describe, expect, it } from "vitest";

import {
	assertBoundedEnvelope,
	assertOneParentSignal,
	createRecoveryHarness,
	healthSnapshot,
} from "./phase-six-fixtures.js";

describe("Phase 6 exit gate: an existing mesh survives total control-plane outage", () => {
	it("preserves the authenticated synchronized mesh, emits typed terminals, and cleans every owned resource", async () => {
		const harness = createRecoveryHarness({
			max_attempts: 3,
			parent_deadline_ms: 1_000,
			retry_delays_ms: [100, 200],
		});
		const injectedOutage = new Error("injected dependency outage");
		harness.ports.rendezvousBootstrap.mockRejectedValue(injectedOutage);
		harness.ports.routerFallback.mockRejectedValue(injectedOutage);
		harness.ports.relayReplace.mockRejectedValue(injectedOutage);
		const localValueBefore = structuredClone(harness.localState.get("object-1"));
		const coordinator = new ControlPlaneCoordinator(harness.options);
		const controller = new AbortController();

		const result = await coordinator.recover(
			{
				kind: "total-control-plane-outage",
				registries: ["registry-a", "registry-b", "registry-c"],
				relays: ["relay-a"],
				routers: ["router-a", "router-b"],
			},
			healthSnapshot({
				healthyBackendCount: 0,
				liveReservations: [{ operatorGroup: "operator-b", relayId: "surviving-relay-b" }],
				rendezvous: { fresh: false, replicaAvailability: "unavailable", replicaCount: 0 },
				state: "healthy",
				traffic: { directConnections: 1, relayedConnections: 1 },
			}),
			controller.signal
		);

		expect(harness.ports.rendezvousBootstrap).toHaveBeenCalled();
		expect(harness.ports.routerFallback).toHaveBeenCalled();
		expect(harness.ports.relayReplace).toHaveBeenCalledWith(
			{ relayId: "relay-a" },
			"relay-disconnected",
			expect.any(AbortSignal)
		);
		expect(harness.ports.disconnectPeer).not.toHaveBeenCalled();
		expect(harness.localState.get("object-1")).toEqual(localValueBefore);
		expect(result.preservedLocalState).toBe(true);
		expect(result.attempts).toBeLessThanOrEqual(3);
		expect(result.terminal).toBe(RecoveryTerminal.Exhausted);
		expect(result.operations.map(({ id }) => id)).toEqual(
			expect.arrayContaining(["registries", "routers", "relay:relay-a"])
		);
		for (const operation of result.operations) {
			expect(Object.values(RecoveryTerminal)).toContain(operation.terminal);
		}
		expect(harness.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "health", state: "healthy" }),
				expect.objectContaining({ kind: "recovery" }),
				{ kind: "terminal", reason: "exhausted" },
				{ kind: "cleanup", outcome: "complete" },
			])
		);
		assertOneParentSignal(harness);
		assertBoundedEnvelope(result, harness);
		expect(controller.signal.aborted).toBe(false);
	});
});
