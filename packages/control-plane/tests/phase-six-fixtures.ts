import {
	type ControlPlaneCoordinatorOptions,
	type ControlPlaneHealthSnapshot,
	type ControlPlaneMechanismPorts,
	type ControlPlanePhaseSixEvent,
	type ControlPlaneRecoveryConfig,
	type RecoveryMechanismResult,
	type RecoveryResult,
	RecoveryTerminal,
} from "@ts-drp/control-plane";
import { expect, vi } from "vitest";

export const START_MS = 1_750_000_000_000;

/** Deterministic scheduler with no platform timers. */
export class ManualRecoveryScheduler {
	readonly sleeps: number[] = [];
	#nowMs = START_MS;
	#pending = 0;
	#nextHandle = 1;
	readonly #scheduled = new Map<number, { readonly atMs: number; callback(): void }>();

	/**
	 * @param _handle - Opaque handle accepted by the production scheduler contract.
	 * @param handle
	 */
	clear(handle: unknown): void {
		if (typeof handle === "number" && this.#scheduled.delete(handle)) this.#pending -= 1;
	}

	/** @param delayMs - Deterministic elapsed time to add. */
	advanceBy(delayMs: number): void {
		const targetMs = this.#nowMs + delayMs;
		while (true) {
			const next = [...this.#scheduled.entries()]
				.filter(([, scheduled]) => scheduled.atMs <= targetMs)
				.sort((left, right) => left[1].atMs - right[1].atMs)[0];
			if (next === undefined) break;
			const [handle, scheduled] = next;
			this.#scheduled.delete(handle);
			this.#pending -= 1;
			this.#nowMs = scheduled.atMs;
			scheduled.callback();
		}
		this.#nowMs = targetMs;
	}

	/** @returns Current fake time. */
	now(): number {
		return this.#nowMs;
	}

	/** @returns Count of scheduler-owned pending operations. */
	pendingCount(): number {
		return this.#pending;
	}

	/**
	 * @param delayMs - Fake-clock delay. @param callback - Callback to run when advanced.
	 * @param callback
	 */
	schedule(delayMs: number, callback: () => void): unknown {
		const handle = this.#nextHandle++;
		this.#scheduled.set(handle, { atMs: this.#nowMs + delayMs, callback });
		this.#pending += 1;
		return handle;
	}

	/**
	 * @param delayMs - Deterministic delay to consume.
	 * @param signal - Parent recovery cancellation signal.
	 */
	async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		this.#pending += 1;
		this.sleeps.push(delayMs);
		this.#nowMs += delayMs;
		this.#pending -= 1;
		await Promise.resolve();
		signal.throwIfAborted();
	}
}

export interface RecoveryHarness {
	readonly config: ControlPlaneRecoveryConfig;
	readonly events: ControlPlanePhaseSixEvent[];
	readonly localState: Map<string, unknown>;
	readonly options: ControlPlaneCoordinatorOptions;
	readonly ports: ControlPlaneMechanismPorts & {
		readonly continueRelayed: ReturnType<typeof vi.fn>;
		readonly disconnectPeer: ReturnType<typeof vi.fn>;
		readonly preserveLocalState: ReturnType<typeof vi.fn>;
		readonly registryCooldown: ReturnType<typeof vi.fn>;
		readonly relayReplace: ReturnType<typeof vi.fn>;
		readonly rendezvousBootstrap: ReturnType<typeof vi.fn>;
		readonly routerFallback: ReturnType<typeof vi.fn>;
		readonly syncFromDifferentPeer: ReturnType<typeof vi.fn>;
	};
	readonly scheduler: ManualRecoveryScheduler;
}

/**
 * @param overrides - Optional recovery policy overrides.
 * @returns Socket-free recovery harness.
 */
export function createRecoveryHarness(overrides: Partial<ControlPlaneRecoveryConfig> = {}): RecoveryHarness {
	const config: ControlPlaneRecoveryConfig = {
		backend_cooldown_ms: 1_000,
		max_attempts: 3,
		parent_deadline_ms: 10_000,
		retry_delays_ms: [100, 200],
		...overrides,
	};
	const events: ControlPlanePhaseSixEvent[] = [];
	const scheduler = new ManualRecoveryScheduler();
	const succeeded = (): Promise<RecoveryMechanismResult> => Promise.resolve({ terminal: "succeeded" });
	const ports = {
		continueRelayed: vi.fn(succeeded),
		disconnectPeer: vi.fn(() => Promise.resolve()),
		preserveLocalState: vi.fn(succeeded),
		registryCooldown: vi.fn(),
		relayReplace: vi.fn(succeeded),
		rendezvousBootstrap: vi.fn(succeeded),
		routerFallback: vi.fn(succeeded),
		syncFromDifferentPeer: vi.fn(succeeded),
	} satisfies ControlPlaneMechanismPorts;
	const localState = new Map<string, unknown>([["object-1", { value: "durable-local-value" }]]);
	return {
		config,
		events,
		localState,
		options: {
			config,
			getLocalState: (): ReadonlyMap<string, unknown> => localState,
			ports,
			scheduler,
			sink: (event): void => void events.push(event),
		},
		ports,
		scheduler,
	};
}

/**
 * @param overrides - Optional status field overrides.
 * @returns Typed healthy baseline snapshot.
 */
export function healthSnapshot(overrides: Partial<ControlPlaneHealthSnapshot> = {}): ControlPlaneHealthSnapshot {
	return {
		authenticatedDrpPeerIds: ["authenticated-peer-a", "authenticated-peer-b"],
		connectedBootstrapPeerIds: [],
		failedRecoveryAttempts: [],
		healthyBackendCount: 3,
		liveReservations: [
			{ operatorGroup: "operator-a", relayId: "relay-a" },
			{ operatorGroup: "operator-b", relayId: "relay-b" },
		],
		meshDiversity: { authenticatedPeerCount: 2, operatorGroupCount: 2, transportCount: 2 },
		objectSynchronization: "synchronized",
		observedAtMs: START_MS,
		reasons: [],
		rendezvous: { fresh: true, replicaAvailability: "available", replicaCount: 3 },
		state: "healthy",
		traffic: { directConnections: 1, relayedConnections: 1 },
		...overrides,
	};
}

/**
 * @param result - Coordinator terminal evidence.
 * @param harness - Deterministic ownership harness.
 */
export function assertBoundedEnvelope(result: RecoveryResult, harness: RecoveryHarness): void {
	expect(result.parentDeadlineAtMs).toBe(START_MS + harness.config.parent_deadline_ms);
	expect(result.maxAttempts).toBe(harness.config.max_attempts);
	expect(result.attempts).toBeLessThanOrEqual(harness.config.max_attempts);
	expect(Object.values(RecoveryTerminal)).toContain(result.terminal);
	expect(result.cleanup).toEqual({
		leakSample: { activeTimers: 0 },
		outcome: "complete",
	});
	expect(harness.scheduler.pendingCount()).toBe(0);
	expect(harness.events.some(({ kind }) => kind === "terminal")).toBe(true);
	expect(harness.events).toContainEqual({ kind: "cleanup", outcome: "complete" });
}

/** @param harness - Harness whose mechanism calls must share one signal. */
export function assertOneParentSignal(harness: RecoveryHarness): void {
	const signals = [
		...harness.ports.continueRelayed.mock.calls.map((call) => call[1]),
		...harness.ports.disconnectPeer.mock.calls.map((call) => call[1]),
		...harness.ports.relayReplace.mock.calls.map((call) => call[2]),
		...harness.ports.rendezvousBootstrap.mock.calls.map((call) => call[1]),
		...harness.ports.routerFallback.mock.calls.map((call) => call[1]),
		...harness.ports.syncFromDifferentPeer.mock.calls.map((call) => call[1]),
	].filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
	expect(signals.length).toBeGreaterThan(0);
	expect(new Set(signals)).toHaveLength(1);
}
