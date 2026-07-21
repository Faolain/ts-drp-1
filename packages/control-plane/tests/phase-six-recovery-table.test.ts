import { ControlPlaneCoordinator, type RecoveryFault, RecoveryTerminal } from "@ts-drp/control-plane";
import { describe, expect, it } from "vitest";

import {
	assertBoundedEnvelope,
	assertOneParentSignal,
	createRecoveryHarness,
	healthSnapshot,
	type RecoveryHarness,
	START_MS,
} from "./phase-six-fixtures.js";

describe("Phase 6 failure-to-recovery table", () => {
	it("continues Registry B/C and cools down failed Registry A without retrying it early", async () => {
		const harness = createRecoveryHarness();
		const coordinator = new ControlPlaneCoordinator(harness.options);
		const controller = new AbortController();

		const result = await coordinator.recover(
			{
				backendId: "registry-a",
				kind: "registry-failed",
				remainingBackendIds: ["registry-b", "registry-c"],
			},
			healthSnapshot(),
			controller.signal
		);

		expect(harness.ports.registryCooldown).toHaveBeenCalledWith({
			backendId: "registry-a",
			untilMs: START_MS + harness.config.backend_cooldown_ms,
		});
		expect(harness.ports.rendezvousBootstrap).toHaveBeenCalledWith(
			{
				excludeBackendIds: ["registry-a"],
				preferredRegistryIds: ["registry-b", "registry-c"],
				sources: ["registries"],
			},
			expect.any(AbortSignal)
		);
		expect(result.terminal).toBe(RecoveryTerminal.Succeeded);
		assertRecoveryEvent(harness.events, "continue-registries");
		assertOneParentSignal(harness);
		assertBoundedEnvelope(result, harness);
		expect(controller.signal.aborted).toBe(false);
	});

	it("falls back through the rendezvous ensemble when all registries fail", async () => {
		const { coordinator, controller, harness, result } = await run({ kind: "all-registries-failed" });

		expect(coordinator).toBeInstanceOf(ControlPlaneCoordinator);
		expect(harness.ports.rendezvousBootstrap).toHaveBeenCalledWith(
			{ sources: ["dht-anchor", "cache", "signed-invite"] },
			expect.any(AbortSignal)
		);
		expect(result.terminal).toBe(RecoveryTerminal.Succeeded);
		assertRecoveryEvent(harness.events, "fallback-rendezvous");
		assertOneParentSignal(harness);
		assertBoundedEnvelope(result, harness);
		expect(controller.signal.aborted).toBe(false);
	});

	it("uses an alternate delegated router or registry records when one router fails", async () => {
		const { controller, harness, result } = await run({ kind: "delegated-router-failed", routerId: "router-a" });

		expect(harness.ports.routerFallback).toHaveBeenCalledWith(
			{ failedRouterId: "router-a", sources: ["alternate-router", "registry-records"] },
			expect.any(AbortSignal)
		);
		expect(result.terminal).toBe(RecoveryTerminal.Succeeded);
		assertRecoveryEvent(harness.events, "fallback-router");
		assertOneParentSignal(harness);
		assertBoundedEnvelope(result, harness);
		expect(controller.signal.aborted).toBe(false);
	});

	it("delegates relay loss to relayReplace with a different operator group", async () => {
		const { controller, harness, result } = await run({
			kind: "relay-disconnected",
			operatorGroup: "operator-a",
			relayId: "relay-a",
		});

		expect(harness.ports.relayReplace).toHaveBeenCalledWith(
			{ excludedOperatorGroup: "operator-a", relayId: "relay-a" },
			"relay-disconnected",
			expect.any(AbortSignal)
		);
		expect(result.terminal).toBe(RecoveryTerminal.Succeeded);
		assertRecoveryEvent(harness.events, "replace-relay");
		assertOneParentSignal(harness);
		assertBoundedEnvelope(result, harness);
		expect(controller.signal.aborted).toBe(false);
	});

	it("keeps a peer relayed when its direct connection fails and never disconnects it", async () => {
		const { controller, harness, result } = await run({ kind: "direct-connection-failed", peerId: "member-a" });

		expect(harness.ports.continueRelayed).toHaveBeenCalledWith({ peerId: "member-a" }, expect.any(AbortSignal));
		expect(harness.ports.disconnectPeer).not.toHaveBeenCalled();
		expect(result.terminal).toBe(RecoveryTerminal.Succeeded);
		assertRecoveryEvent(harness.events, "retain-relayed");
		assertOneParentSignal(harness);
		assertBoundedEnvelope(result, harness);
		expect(controller.signal.aborted).toBe(false);
	});

	it("keeps registries primary when DHT is unavailable", async () => {
		const { controller, harness, result } = await run({ kind: "dht-unavailable" });

		expect(harness.ports.rendezvousBootstrap).toHaveBeenCalledWith(
			{ sources: ["registries"] },
			expect.any(AbortSignal)
		);
		expect(result.terminal).toBe(RecoveryTerminal.Succeeded);
		assertRecoveryEvent(harness.events, "retain-registries");
		assertOneParentSignal(harness);
		assertBoundedEnvelope(result, harness);
		expect(controller.signal.aborted).toBe(false);
	});

	it("syncs from another authenticated peer when one peer disappears", async () => {
		const { controller, harness, result } = await run({
			authenticatedAlternates: ["member-b", "member-c"],
			kind: "peer-disappeared",
			peerId: "member-a",
		});

		expect(harness.ports.syncFromDifferentPeer).toHaveBeenCalledWith(
			{ candidates: ["member-b", "member-c"], excludedPeerId: "member-a" },
			expect.any(AbortSignal)
		);
		expect(JSON.stringify(harness.ports.syncFromDifferentPeer.mock.calls)).not.toContain('"member-a"],');
		expect(result.terminal).toBe(RecoveryTerminal.Succeeded);
		assertRecoveryEvent(harness.events, "sync-another-peer");
		assertOneParentSignal(harness);
		assertBoundedEnvelope(result, harness);
		expect(controller.signal.aborted).toBe(false);
	});

	it("preserves local object state and terminates after the bounded retry schedule when everything is unavailable", async () => {
		const harness = createRecoveryHarness({ max_attempts: 3, retry_delays_ms: [100, 200] });
		const before = structuredClone(harness.localState.get("object-1"));
		for (const mechanism of [
			harness.ports.continueRelayed,
			harness.ports.relayReplace,
			harness.ports.rendezvousBootstrap,
			harness.ports.routerFallback,
			harness.ports.syncFromDifferentPeer,
		]) {
			mechanism.mockRejectedValue(new Error("injected total outage"));
		}
		const coordinator = new ControlPlaneCoordinator(harness.options);
		const controller = new AbortController();

		const result = await coordinator.recover({ kind: "everything-unavailable" }, healthSnapshot(), controller.signal);

		expect(result.attempts).toBe(3);
		expect(harness.scheduler.sleeps).toEqual([100, 200]);
		expect(harness.ports.preserveLocalState).toHaveBeenCalledWith(harness.localState);
		expect(harness.localState.get("object-1")).toEqual(before);
		expect(result.preservedLocalState).toBe(true);
		expect(result.terminal).toBe(RecoveryTerminal.Exhausted);
		assertRecoveryEvent(harness.events, "bounded-retry");
		assertOneParentSignal(harness);
		assertBoundedEnvelope(result, harness);
		expect(controller.signal.aborted).toBe(false);
	});

	it("does not claim local state preservation when the preservation port fails", async () => {
		const harness = createRecoveryHarness();
		harness.ports.preserveLocalState.mockResolvedValue({ terminal: "failed" });
		const coordinator = new ControlPlaneCoordinator(harness.options);

		const result = await coordinator.recover(
			{ kind: "everything-unavailable" },
			healthSnapshot(),
			new AbortController().signal
		);

		expect(result.preservedLocalState).toBe(false);
		expect(result.terminal).toBe(RecoveryTerminal.Failed);
		expect(harness.ports.rendezvousBootstrap).not.toHaveBeenCalled();
	});
});

async function run(fault: RecoveryFault): Promise<{
	controller: AbortController;
	coordinator: ControlPlaneCoordinator;
	harness: RecoveryHarness;
	result: Awaited<ReturnType<ControlPlaneCoordinator["recover"]>>;
}> {
	const harness = createRecoveryHarness();
	const coordinator = new ControlPlaneCoordinator(harness.options);
	const controller = new AbortController();
	const result = await coordinator.recover(fault, healthSnapshot(), controller.signal);
	return { controller, coordinator, harness, result };
}

function assertRecoveryEvent(
	events: readonly { readonly kind: string; readonly recovery?: string }[],
	recovery: string
): void {
	expect(events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: "health" }),
			expect.objectContaining({ kind: "recovery", recovery }),
		])
	);
}
