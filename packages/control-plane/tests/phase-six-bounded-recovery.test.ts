import {
	ControlPlaneCoordinator,
	type ControlPlanePhaseSixEvent,
	type RecoveryFault,
	RecoveryTerminal,
} from "@ts-drp/control-plane";
import { describe, expect, it } from "vitest";

import {
	assertBoundedEnvelope,
	assertOneParentSignal,
	createRecoveryHarness,
	healthSnapshot,
} from "./phase-six-fixtures.js";

describe("Phase 6 bounded recovery ownership", () => {
	it("uses one parent deadline across retries and terminates at the deadline with cleanup", async () => {
		const harness = createRecoveryHarness({
			max_attempts: 4,
			parent_deadline_ms: 250,
			retry_delays_ms: [100, 150, 300],
		});
		harness.ports.rendezvousBootstrap.mockRejectedValue(new Error("partition"));
		const coordinator = new ControlPlaneCoordinator(harness.options);
		const controller = new AbortController();

		const result = await coordinator.recover({ kind: "all-registries-failed" }, healthSnapshot(), controller.signal);

		expect(result.terminal).toBe(RecoveryTerminal.Deadline);
		expect(result.attempts).toBeLessThanOrEqual(4);
		expect(harness.scheduler.sleeps.reduce((total, delay) => total + delay, 0)).toBeLessThanOrEqual(250);
		expect(harness.events).toContainEqual({ kind: "terminal", reason: "deadline" });
		assertOneParentSignal(harness);
		assertBoundedEnvelope(result, harness);
		expect(controller.signal.aborted).toBe(false);
	});

	it("honors a caller AbortSignal without starting mechanisms and emits an aborted terminal plus cleanup", async () => {
		const harness = createRecoveryHarness();
		const coordinator = new ControlPlaneCoordinator(harness.options);
		const controller = new AbortController();
		controller.abort(new DOMException("fixture cancellation", "AbortError"));

		const result = await coordinator.recover({ kind: "everything-unavailable" }, healthSnapshot(), controller.signal);

		expect(result.attempts).toBe(0);
		expect(result.terminal).toBe(RecoveryTerminal.Aborted);
		expect(harness.ports.rendezvousBootstrap).not.toHaveBeenCalled();
		expect(harness.ports.relayReplace).not.toHaveBeenCalled();
		expect(harness.ports.syncFromDifferentPeer).not.toHaveBeenCalled();
		expect(controller.signal.aborted).toBe(true);
		expect(harness.events).toContainEqual({ kind: "terminal", reason: "aborted" });
		assertBoundedEnvelope(result, harness);
	});

	it("converts malformed hostile fault data into a typed terminal without throwing beyond the parent budget", async () => {
		const harness = createRecoveryHarness({ max_attempts: 2, parent_deadline_ms: 500, retry_delays_ms: [100] });
		const events = harness.events;
		const coordinator = new ControlPlaneCoordinator(harness.options);
		const controller = new AbortController();
		const hostileFault = {
			backendId: null,
			kind: "registry-failed",
			remainingBackendIds: ["registry-b", { poisoned: true }],
		} as unknown as RecoveryFault;

		const result = await coordinator.recover(hostileFault, healthSnapshot(), controller.signal);

		expect([RecoveryTerminal.Failed, RecoveryTerminal.Exhausted]).toContain(result.terminal);
		expect(result.attempts).toBeLessThanOrEqual(2);
		expect(events.some(({ kind }) => kind === "terminal")).toBe(true);
		expect(events).toContainEqual({ kind: "cleanup", outcome: "complete" });
		assertBoundedEnvelope(result, harness);
		expect(controller.signal.aborted).toBe(false);
	});

	it("isolates a hostile telemetry sink while preserving typed terminal and cleanup evidence", async () => {
		const harness = createRecoveryHarness();
		const durableEvents: ControlPlanePhaseSixEvent[] = [];
		const coordinator = new ControlPlaneCoordinator({
			...harness.options,
			sink: (event): void => {
				durableEvents.push(event);
				if (event.kind === "recovery") throw new Error("hostile sink");
			},
		});
		const controller = new AbortController();

		const result = await coordinator.recover({ kind: "dht-unavailable" }, healthSnapshot(), controller.signal);

		expect(result.terminal).toBe(RecoveryTerminal.Succeeded);
		expect(durableEvents.some(({ kind }) => kind === "recovery")).toBe(true);
		expect(durableEvents.some(({ kind }) => kind === "terminal")).toBe(true);
		expect(durableEvents).toContainEqual({ kind: "cleanup", outcome: "complete" });
		assertOneParentSignal(harness);
		assertBoundedResultOnly(result, harness.config.max_attempts, harness.config.parent_deadline_ms);
		expect(controller.signal.aborted).toBe(false);
	});
});

function assertBoundedResultOnly(
	result: Awaited<ReturnType<ControlPlaneCoordinator["recover"]>>,
	cap: number,
	deadline: number
): void {
	expect(result.attempts).toBeLessThanOrEqual(cap);
	expect(result.parentDeadlineAtMs).toBe(1_750_000_000_000 + deadline);
	expect(Object.values(RecoveryTerminal)).toContain(result.terminal);
	expect(result.cleanup).toEqual({ leakSample: { activeTimers: 0 }, outcome: "complete" });
}
