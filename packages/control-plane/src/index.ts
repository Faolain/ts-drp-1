import type {
	ControlPlaneEvent,
	ControlPlaneHealthState,
	ControlPlaneRecoveryAction,
	ControlPlaneRecoveryConfig,
} from "@ts-drp/types";

export type { ControlPlaneHealthState, ControlPlaneRecoveryConfig } from "@ts-drp/types";

export type RecoveryAction = ControlPlaneRecoveryAction;

export interface ControlPlaneRecoveryAttemptId {
	readonly action: RecoveryAction;
	readonly id: string;
	readonly terminal: Exclude<RecoveryTerminal, RecoveryTerminal.Succeeded>;
}

export type ControlPlaneHealthReason =
	| "delegated-router-failed"
	| "dht-unavailable"
	| "direct-connection-failed"
	| "failed-recovery-attempts"
	| "insufficient-mesh-diversity"
	| "no-active-traffic"
	| "no-authenticated-drp-peer"
	| "no-healthy-backend"
	| "no-live-reservation"
	| "no-rendezvous-replica"
	| "objects-not-synchronized"
	| "rendezvous-stale";

export interface ControlPlaneHealthInput {
	readonly authenticatedDrpPeerIds: readonly string[];
	readonly connectedBootstrapPeerIds: readonly string[];
	readonly directConnectionFailedPeerIds?: readonly string[];
	readonly failedRecoveryAttempts: readonly ControlPlaneRecoveryAttemptId[];
	readonly lostAuthenticatedPeerIds?: readonly string[];
	readonly healthyBackendCount: number;
	readonly liveReservations: readonly {
		readonly operatorGroup: string;
		readonly relayId: string;
	}[];
	readonly meshDiversity: {
		readonly authenticatedPeerCount: number;
		readonly operatorGroupCount: number;
		readonly transportCount: number;
	};
	readonly objectSynchronization: "behind" | "synchronized" | "unknown";
	readonly rendezvous: {
		readonly backends?: readonly {
			readonly id: string;
			readonly status: "empty" | "failed" | "succeeded";
		}[];
		readonly fresh: boolean;
		readonly replicaAvailability: "available" | "partial" | "unavailable";
		readonly replicaCount: number;
	};
	readonly routing?: {
		readonly failedRouterIds: readonly string[];
	};
	readonly traffic: {
		readonly directConnections: number;
		readonly relayedConnections: number;
	};
}

export interface ControlPlaneHealthSnapshot extends ControlPlaneHealthInput {
	readonly observedAtMs: number;
	readonly reasons: readonly ControlPlaneHealthReason[];
	readonly state: ControlPlaneHealthState;
}

export interface ControlPlaneHealthAggregatorOptions {
	now(): number;
}

/** Derives immutable status from authenticated data-plane and control-plane observations. */
export class ControlPlaneHealthAggregator {
	readonly #now: () => number;

	/** @param options - Injectable clock used by deterministic health observations. */
	constructor(options: ControlPlaneHealthAggregatorOptions) {
		this.#now = options.now;
	}

	/**
	 * @param input - Typed node observations.
	 * @returns The typed deeply immutable health snapshot.
	 */
	aggregate(input: ControlPlaneHealthInput): ControlPlaneHealthSnapshot {
		const authenticatedDrpPeerIds = Object.freeze([...input.authenticatedDrpPeerIds]);
		const connectedBootstrapPeerIds = Object.freeze([...input.connectedBootstrapPeerIds]);
		const directConnectionFailedPeerIds = Object.freeze([...(input.directConnectionFailedPeerIds ?? [])]);
		const failedRecoveryAttempts = Object.freeze(
			input.failedRecoveryAttempts.map((attempt) => Object.freeze({ ...attempt }))
		);
		const lostAuthenticatedPeerIds = Object.freeze([...(input.lostAuthenticatedPeerIds ?? [])]);
		const liveReservations = Object.freeze(
			input.liveReservations.map((reservation) => Object.freeze({ ...reservation }))
		);
		const meshDiversity = Object.freeze({ ...input.meshDiversity });
		const rendezvous = Object.freeze({
			...input.rendezvous,
			...(input.rendezvous.backends === undefined
				? {}
				: {
						backends: Object.freeze(input.rendezvous.backends.map((backend) => Object.freeze({ ...backend }))),
					}),
		});
		const routing =
			input.routing === undefined
				? undefined
				: Object.freeze({ failedRouterIds: Object.freeze([...input.routing.failedRouterIds]) });
		const traffic = Object.freeze({ ...input.traffic });
		const reasons: ControlPlaneHealthReason[] = [];

		if (authenticatedDrpPeerIds.length === 0) reasons.push("no-authenticated-drp-peer");
		if (input.objectSynchronization === "behind") reasons.push("objects-not-synchronized");
		if (!rendezvous.fresh) reasons.push("rendezvous-stale");
		if (rendezvous.replicaAvailability === "unavailable" || rendezvous.replicaCount <= 0) {
			reasons.push("no-rendezvous-replica");
		}
		if (input.healthyBackendCount <= 0) reasons.push("no-healthy-backend");
		if (liveReservations.length === 0) reasons.push("no-live-reservation");
		if (traffic.directConnections + traffic.relayedConnections <= 0) reasons.push("no-active-traffic");
		if (
			meshDiversity.authenticatedPeerCount <= 0 ||
			meshDiversity.operatorGroupCount <= 0 ||
			meshDiversity.transportCount <= 0
		) {
			reasons.push("insufficient-mesh-diversity");
		}
		if (failedRecoveryAttempts.length > 0) reasons.push("failed-recovery-attempts");
		if ((routing?.failedRouterIds.length ?? 0) > 0) reasons.push("delegated-router-failed");
		if (directConnectionFailedPeerIds.length > 0) reasons.push("direct-connection-failed");
		if (rendezvous.backends?.some(({ id, status }) => id === "dht-anchor" && status === "failed") === true) {
			reasons.push("dht-unavailable");
		}

		const allRequiredSignalsHealthy =
			authenticatedDrpPeerIds.length > 0 &&
			input.objectSynchronization !== "behind" &&
			rendezvous.fresh &&
			rendezvous.replicaAvailability !== "unavailable" &&
			rendezvous.replicaCount > 0 &&
			input.healthyBackendCount > 0 &&
			liveReservations.length > 0 &&
			meshDiversity.authenticatedPeerCount > 0 &&
			meshDiversity.operatorGroupCount > 0 &&
			meshDiversity.transportCount > 0 &&
			(routing?.failedRouterIds.length ?? 0) === 0 &&
			traffic.directConnections + traffic.relayedConnections > 0;
		const state: ControlPlaneHealthState =
			failedRecoveryAttempts.length > 0 ? "recovering" : allRequiredSignalsHealthy ? "healthy" : "degraded";

		return Object.freeze({
			authenticatedDrpPeerIds,
			connectedBootstrapPeerIds,
			directConnectionFailedPeerIds,
			failedRecoveryAttempts,
			healthyBackendCount: input.healthyBackendCount,
			liveReservations,
			lostAuthenticatedPeerIds,
			meshDiversity,
			objectSynchronization: input.objectSynchronization,
			observedAtMs: this.#now(),
			reasons: Object.freeze(reasons),
			rendezvous,
			...(routing === undefined ? {} : { routing }),
			state,
			traffic,
		});
	}
}

export enum RecoveryTerminal {
	Aborted = "aborted",
	Deadline = "deadline",
	Exhausted = "exhausted",
	Failed = "failed",
	Succeeded = "succeeded",
}

export type RecoveryFault =
	| { readonly backendId: string; readonly kind: "registry-failed"; readonly remainingBackendIds: readonly string[] }
	| { readonly kind: "all-registries-failed" }
	| { readonly routerId: string; readonly kind: "delegated-router-failed" }
	| { readonly kind: "relay-disconnected"; readonly operatorGroup?: string; readonly relayId?: string }
	| { readonly kind: "direct-connection-failed"; readonly peerId: string }
	| { readonly kind: "dht-unavailable" }
	| { readonly authenticatedAlternates: readonly string[]; readonly kind: "peer-disappeared"; readonly peerId: string }
	| { readonly kind: "everything-unavailable" }
	| {
			readonly kind: "total-control-plane-outage";
			readonly registries: readonly string[];
			readonly relays: readonly string[];
			readonly routers: readonly string[];
	  };

export interface ControlPlaneScheduler {
	clear(handle: unknown): void;
	now(): number;
	pendingCount(): number;
	schedule(delayMs: number, callback: () => void): unknown;
	sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

/** Browser-safe scheduler used when a host does not inject its own deterministic clock. */
export class SystemControlPlaneScheduler implements ControlPlaneScheduler {
	readonly #handles = new Set<ReturnType<typeof globalThis.setTimeout>>();

	/** @param handle - A scheduler-owned timer handle. */
	clear(handle: unknown): void {
		for (const candidate of this.#handles) {
			if (candidate !== handle) continue;
			globalThis.clearTimeout(candidate);
			this.#handles.delete(candidate);
			return;
		}
	}

	/** @returns Wall-clock time in milliseconds. */
	now(): number {
		return Date.now();
	}

	/** @returns The number of scheduler-owned pending timers. */
	pendingCount(): number {
		return this.#handles.size;
	}

	/**
	 * @param delayMs - Delay before the callback. @param callback - Scheduler-owned callback.
	 * @param callback
	 */
	schedule(delayMs: number, callback: () => void): unknown {
		const handle = globalThis.setTimeout((): void => {
			this.#handles.delete(handle);
			callback();
		}, delayMs);
		this.#handles.add(handle);
		(handle as ReturnType<typeof globalThis.setTimeout> & { unref?(): void }).unref?.();
		return handle;
	}

	/**
	 * @param delayMs - Bounded retry delay.
	 * @param signal - Parent recovery cancellation signal.
	 */
	sleep(delayMs: number, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			const timer: { handle?: ReturnType<typeof globalThis.setTimeout> } = {};
			const cleanup = (): void => {
				signal.removeEventListener("abort", abort);
				if (timer.handle !== undefined) this.#handles.delete(timer.handle);
			};
			const abort = (): void => {
				if (timer.handle !== undefined) globalThis.clearTimeout(timer.handle);
				cleanup();
				reject(signal.reason);
			};
			const handle = globalThis.setTimeout(() => {
				cleanup();
				resolve();
			}, delayMs);
			timer.handle = handle;
			this.#handles.add(handle);
			signal.addEventListener("abort", abort, { once: true });
		});
	}
}

export interface RecoveryMechanismResult {
	readonly terminal: "failed" | "succeeded";
}

export interface ControlPlaneMechanismPorts {
	continueRelayed(request: { readonly peerId: string }, signal: AbortSignal): Promise<RecoveryMechanismResult>;
	disconnectPeer(peerId: string, signal: AbortSignal): Promise<void>;
	registryCooldown(request: { readonly backendId: string; readonly untilMs: number }): void;
	relayReplace(
		request: { readonly excludedOperatorGroup?: string; readonly relayId?: string },
		reason: "relay-disconnected",
		signal: AbortSignal
	): Promise<RecoveryMechanismResult>;
	rendezvousBootstrap(
		request: {
			readonly excludeBackendIds?: readonly string[];
			readonly preferredRegistryIds?: readonly string[];
			readonly sources: readonly ("cache" | "dht-anchor" | "registries" | "signed-invite")[];
		},
		signal: AbortSignal
	): Promise<RecoveryMechanismResult>;
	routerFallback(
		request: {
			readonly failedRouterId: string;
			readonly sources: readonly ("alternate-router" | "registry-records")[];
		},
		signal: AbortSignal
	): Promise<RecoveryMechanismResult>;
	syncFromDifferentPeer(
		request: { readonly candidates: readonly string[]; readonly excludedPeerId: string },
		signal: AbortSignal
	): Promise<RecoveryMechanismResult>;
	preserveLocalState(snapshot: ReadonlyMap<string, unknown>): Promise<RecoveryMechanismResult>;
}

export type ControlPlanePhaseSixEvent = Extract<
	ControlPlaneEvent,
	{ readonly kind: "cleanup" | "health" | "recovery" | "terminal" }
>;

export interface RecoveryOperationResult {
	readonly id: string;
	readonly terminal: RecoveryTerminal;
}

export interface RecoveryResult {
	readonly attempts: number;
	readonly cleanup: {
		readonly leakSample: { readonly activeTimers: number };
		readonly outcome: "complete" | "failed";
	};
	readonly maxAttempts: number;
	readonly operations: readonly RecoveryOperationResult[];
	readonly parentDeadlineAtMs: number;
	readonly preservedLocalState: boolean;
	readonly terminal: RecoveryTerminal;
}

export interface ControlPlaneCoordinatorOptions {
	readonly config: ControlPlaneRecoveryConfig;
	getLocalState(): ReadonlyMap<string, unknown>;
	readonly ports: ControlPlaneMechanismPorts;
	readStatus?(): ControlPlaneHealthSnapshot;
	readonly scheduler: ControlPlaneScheduler;
	sink(event: ControlPlanePhaseSixEvent): void;
	subscribeStatus?(listener: (status: ControlPlaneHealthSnapshot) => void): () => void;
}

interface RecoveryOperation {
	readonly id: string;
	run(signal: AbortSignal): Promise<RecoveryMechanismResult>;
}

interface RecoveryPlan {
	readonly action: RecoveryAction;
	readonly operations: readonly RecoveryOperation[];
	readonly preserveLocalState: boolean;
}

interface NormalizedRecoveryConfig {
	readonly backendCooldownMs: number;
	readonly healthPollIntervalMs: number;
	readonly maxAttempts: number;
	readonly parentDeadlineMs: number;
	readonly retryDelaysMs: readonly number[];
	readonly recoveryBackoffMs: number;
	readonly startupGraceMs: number;
}

/** Owns bounded Phase 6 recovery orchestration. */
export class ControlPlaneCoordinator {
	readonly #activeRecoveries = new Set<Promise<RecoveryResult>>();
	readonly #cooledDownBackends = new Map<string, number>();
	readonly #config: NormalizedRecoveryConfig;
	readonly #getLocalState: () => ReadonlyMap<string, unknown>;
	readonly #ports: ControlPlaneMechanismPorts;
	readonly #readStatus: (() => ControlPlaneHealthSnapshot) | undefined;
	readonly #scheduler: ControlPlaneScheduler;
	readonly #sink: (event: ControlPlanePhaseSixEvent) => void;
	readonly #subscribeStatus: ((listener: (status: ControlPlaneHealthSnapshot) => void) => () => void) | undefined;
	#lifecycleController: AbortController | undefined;
	#lastObservedStatus: ControlPlaneHealthSnapshot | undefined;
	#nextRecoveryAtMs = 0;
	#startedAtMs = 0;
	readonly #lifecycleTimers = new Set<unknown>();
	#observationTimer: unknown | undefined;
	#failedRecoveryAttempts: readonly ControlPlaneRecoveryAttemptId[] = Object.freeze([]);
	#unsubscribeStatus: (() => void) | undefined;

	/** @param options - Injected policy, mechanisms, scheduler, state, and telemetry. */
	constructor(options: ControlPlaneCoordinatorOptions) {
		this.#config = normalizeConfig(options.config);
		this.#getLocalState = options.getLocalState;
		this.#ports = options.ports;
		this.#readStatus = options.readStatus;
		this.#scheduler = options.scheduler;
		this.#sink = options.sink;
		this.#subscribeStatus = options.subscribeStatus;
	}

	/** @returns Immutable operation failures from the most recently completed recovery. */
	get failedRecoveryAttempts(): readonly ControlPlaneRecoveryAttemptId[] {
		return this.#failedRecoveryAttempts;
	}

	/**
	 * @param fault - Typed failure that selected recovery.
	 * @param status - Latest health snapshot.
	 * @param signal - Caller cancellation signal.
	 * @returns A bounded typed terminal and cleanup record.
	 */
	async recover(
		fault: RecoveryFault,
		status: ControlPlaneHealthSnapshot,
		signal: AbortSignal
	): Promise<RecoveryResult> {
		const startedAtMs = safeNow(this.#scheduler);
		const baselineTimers = safePendingCount(this.#scheduler);
		const parentDeadlineAtMs = startedAtMs + this.#config.parentDeadlineMs;
		const parent = new AbortController();
		const deadlineReason = new DOMException("control-plane recovery deadline exceeded", "TimeoutError");
		const deadlineHandle = this.#scheduler.schedule(this.#config.parentDeadlineMs, (): void => {
			parent.abort(deadlineReason);
		});
		const forwardAbort = (): void => parent.abort(signal.reason);
		if (signal.aborted) forwardAbort();
		else signal.addEventListener("abort", forwardAbort, { once: true });
		let attempts = 0;
		let preservedLocalState = false;
		let terminal = RecoveryTerminal.Failed;
		const operations: RecoveryOperationResult[] = [];

		this.#emit({ kind: "health", state: isHealthState(status?.state) ? status.state : "degraded" });
		let planAction: RecoveryAction | undefined;
		try {
			if (parent.signal.aborted) {
				terminal = RecoveryTerminal.Aborted;
			} else if (safeNow(this.#scheduler) >= parentDeadlineAtMs) {
				terminal = RecoveryTerminal.Deadline;
			} else {
				const plan = this.#planFor(fault, status);
				planAction = plan?.action;
				if (plan === undefined) {
					terminal = RecoveryTerminal.Failed;
				} else {
					let preservationSucceeded = true;
					if (plan.preserveLocalState) {
						try {
							parent.signal.throwIfAborted();
							const result = await runMechanismWithSignal(
								this.#ports.preserveLocalState(this.#getLocalState()),
								parent.signal
							);
							preservedLocalState = result.terminal === "succeeded";
							preservationSucceeded = preservedLocalState;
						} catch {
							terminal = parent.signal.aborted
								? terminalForAbort(parent.signal, deadlineReason)
								: RecoveryTerminal.Failed;
							preservationSucceeded = false;
						}
					}
					if (preservationSucceeded) {
						terminal = await this.#runPlan(plan, parent.signal, parentDeadlineAtMs, operations, (value): void => {
							attempts = value;
						});
					}
				}
			}
		} catch {
			terminal = parent.signal.aborted ? terminalForAbort(parent.signal, deadlineReason) : RecoveryTerminal.Failed;
		} finally {
			this.#scheduler.clear(deadlineHandle);
			signal.removeEventListener("abort", forwardAbort);
			if (!parent.signal.aborted) parent.abort(new DOMException("recovery scope closed", "AbortError"));
		}
		this.#failedRecoveryAttempts = Object.freeze(
			planAction === undefined || terminal === RecoveryTerminal.Succeeded
				? []
				: operations
						.filter(
							(
								operation
							): operation is RecoveryOperationResult & {
								readonly terminal: Exclude<RecoveryTerminal, RecoveryTerminal.Succeeded>;
							} => operation.terminal !== RecoveryTerminal.Succeeded
						)
						.map(({ id, terminal: operationTerminal }) =>
							Object.freeze({ action: planAction, id, terminal: operationTerminal })
						)
		);

		const cleanup = cleanupEvidence(this.#scheduler, baselineTimers);
		this.#emit({ kind: "terminal", reason: terminalReason(terminal) });
		this.#emit({ kind: "cleanup", outcome: cleanup.outcome });
		return Object.freeze({
			attempts,
			cleanup,
			maxAttempts: this.#config.maxAttempts,
			operations: Object.freeze(operations),
			parentDeadlineAtMs,
			preservedLocalState,
			terminal,
		});
	}

	/** Starts health observation and recovery ownership. */
	start(): void {
		if (this.#lifecycleController !== undefined) return;
		this.#lifecycleController = new AbortController();
		this.#startedAtMs = safeNow(this.#scheduler);
		this.#nextRecoveryAtMs = this.#startedAtMs + this.#config.startupGraceMs;
		const observe = (status: ControlPlaneHealthSnapshot): void => this.#observe(status);
		try {
			this.#unsubscribeStatus = this.#subscribeStatus?.(observe);
		} catch {
			this.#unsubscribeStatus = undefined;
		}
		if (this.#readStatus !== undefined) {
			try {
				observe(this.#readStatus());
			} catch {
				this.#emit({ kind: "health", state: "degraded" });
			}
		}
		this.#scheduleObservation(this.#nextRecoveryAtMs);
	}

	/** @returns Completion after coordinator resources are cleaned. */
	async stop(): Promise<void> {
		const controller = this.#lifecycleController;
		if (controller === undefined && this.#unsubscribeStatus === undefined) return;
		this.#lifecycleController = undefined;
		try {
			this.#unsubscribeStatus?.();
		} catch {
			// Status observers do not own coordinator cleanup.
		}
		this.#unsubscribeStatus = undefined;
		controller?.abort(new DOMException("control-plane coordinator stopped", "AbortError"));
		for (const handle of this.#lifecycleTimers) this.#scheduler.clear(handle);
		this.#lifecycleTimers.clear();
		this.#observationTimer = undefined;
		await Promise.allSettled([...this.#activeRecoveries]);
		const cleanup = cleanupEvidence(this.#scheduler);
		this.#emit({ kind: "terminal", reason: "stopped" });
		this.#emit({ kind: "cleanup", outcome: cleanup.outcome });
	}

	#emit(event: ControlPlanePhaseSixEvent): void {
		try {
			this.#sink(event);
		} catch {
			// Observability must never change recovery behavior.
		}
	}

	#observe(status: ControlPlaneHealthSnapshot): void {
		const controller = this.#lifecycleController;
		if (controller === undefined || controller.signal.aborted) return;
		const previousStatus = this.#lastObservedStatus;
		this.#lastObservedStatus = status;
		if (status.state === "healthy") {
			this.#emit({ kind: "health", state: "healthy" });
			this.#scheduleObservation(safeNow(this.#scheduler) + this.#config.healthPollIntervalMs);
			return;
		}
		if (this.#activeRecoveries.size > 0) return;
		const nowMs = safeNow(this.#scheduler);
		if (nowMs < this.#nextRecoveryAtMs) {
			this.#scheduleObservation(this.#nextRecoveryAtMs);
			return;
		}
		const fault = classifyObservedFault(status, previousStatus);
		if (fault === undefined) {
			this.#emit({ kind: "health", state: status.state });
			this.#scheduleObservation(nowMs + this.#config.healthPollIntervalMs);
			return;
		}
		const recovery = this.recover(fault, status, controller.signal);
		this.#activeRecoveries.add(recovery);
		void recovery.finally((): void => {
			this.#activeRecoveries.delete(recovery);
			this.#nextRecoveryAtMs = safeNow(this.#scheduler) + this.#config.recoveryBackoffMs;
			this.#scheduleObservation(this.#nextRecoveryAtMs);
		});
	}

	#scheduleObservation(atMs: number): void {
		if (this.#readStatus === undefined || this.#lifecycleController?.signal.aborted !== false) return;
		if (this.#observationTimer !== undefined) return;
		const delayMs = Math.max(0, atMs - safeNow(this.#scheduler));
		const handle = this.#scheduler.schedule(delayMs, (): void => {
			this.#lifecycleTimers.delete(handle);
			this.#observationTimer = undefined;
			try {
				const status = this.#readStatus?.() ?? this.#lastObservedStatus;
				if (status !== undefined) this.#observe(status);
			} catch {
				this.#emit({ kind: "health", state: "degraded" });
			}
		});
		this.#lifecycleTimers.add(handle);
		this.#observationTimer = handle;
	}

	async #runPlan(
		plan: RecoveryPlan,
		signal: AbortSignal,
		parentDeadlineAtMs: number,
		operationResults: RecoveryOperationResult[],
		setAttempts: (attempts: number) => void
	): Promise<RecoveryTerminal> {
		for (let attempt = 1; attempt <= this.#config.maxAttempts; attempt += 1) {
			if (signal.aborted) return abortTerminal(signal);
			if (safeNow(this.#scheduler) >= parentDeadlineAtMs) return RecoveryTerminal.Deadline;
			setAttempts(attempt);
			this.#emit({ attempt, kind: "recovery", outcome: "attempt", recovery: plan.action });

			let recovered = false;
			for (const operation of plan.operations) {
				const result = await runOperation(operation, signal);
				operationResults.push(result);
				if (result.terminal === RecoveryTerminal.Succeeded) recovered = true;
			}

			if (signal.aborted) return abortTerminal(signal);
			if (safeNow(this.#scheduler) >= parentDeadlineAtMs) return RecoveryTerminal.Deadline;
			if (recovered) {
				this.#emit({ attempt, kind: "recovery", outcome: "succeeded", recovery: plan.action });
				return RecoveryTerminal.Succeeded;
			}
			this.#emit({ attempt, kind: "recovery", outcome: "failed", recovery: plan.action });
			if (attempt >= this.#config.maxAttempts) return RecoveryTerminal.Exhausted;

			const configuredDelay = this.#config.retryDelaysMs[attempt - 1];
			if (configuredDelay === undefined) return RecoveryTerminal.Exhausted;
			const remainingMs = parentDeadlineAtMs - safeNow(this.#scheduler);
			if (remainingMs <= 0) return RecoveryTerminal.Deadline;
			const delayMs = Math.min(configuredDelay, remainingMs);
			try {
				await this.#scheduler.sleep(delayMs, signal);
			} catch {
				return signal.aborted ? abortTerminal(signal) : RecoveryTerminal.Failed;
			}
			if (safeNow(this.#scheduler) >= parentDeadlineAtMs) return RecoveryTerminal.Deadline;
		}
		return RecoveryTerminal.Exhausted;
	}

	#planFor(fault: RecoveryFault, status: ControlPlaneHealthSnapshot): RecoveryPlan | undefined {
		if (!isRecord(fault) || typeof fault.kind !== "string") return undefined;
		switch (fault.kind) {
			case "registry-failed":
				return this.#registryFailurePlan(fault);
			case "all-registries-failed":
				// A point-in-time "all registries failed" observation (often a transient or aborted
				// discover trace) must still RE-ATTEMPT registries — they recover, and a peer whose only
				// discovery path is registries would otherwise be stranded — alongside the fallbacks.
				// Cooled-down backends remain excluded by #registryRequest.
				return singleOperationPlan("fallback-rendezvous", "registries", false, (signal) =>
					this.#ports.rendezvousBootstrap(
						this.#registryRequest(["registries", "dht-anchor", "cache", "signed-invite"]),
						signal
					)
				);
			case "delegated-router-failed":
				if (typeof fault.routerId !== "string") return undefined;
				return singleOperationPlan("fallback-router", `router:${fault.routerId}`, false, (signal) =>
					this.#ports.routerFallback(
						{ failedRouterId: fault.routerId, sources: ["alternate-router", "registry-records"] },
						signal
					)
				);
			case "relay-disconnected":
				if (
					(fault.operatorGroup !== undefined && typeof fault.operatorGroup !== "string") ||
					(fault.relayId !== undefined && typeof fault.relayId !== "string")
				) {
					return undefined;
				}
				return singleOperationPlan("replace-relay", `relay:${fault.relayId ?? "unknown"}`, false, (signal) =>
					this.#ports.relayReplace(
						{
							...(fault.operatorGroup === undefined ? {} : { excludedOperatorGroup: fault.operatorGroup }),
							...(fault.relayId === undefined ? {} : { relayId: fault.relayId }),
						},
						"relay-disconnected",
						signal
					)
				);
			case "direct-connection-failed":
				if (typeof fault.peerId !== "string") return undefined;
				return singleOperationPlan("retain-relayed", `peer:${fault.peerId}`, false, (signal) =>
					this.#ports.continueRelayed({ peerId: fault.peerId }, signal)
				);
			case "dht-unavailable":
				return singleOperationPlan("retain-registries", "registries", false, (signal) =>
					this.#ports.rendezvousBootstrap(this.#registryRequest(["registries"]), signal)
				);
			case "peer-disappeared": {
				if (typeof fault.peerId !== "string" || !isStringArray(fault.authenticatedAlternates)) return undefined;
				const candidates = fault.authenticatedAlternates.filter((peerId) => peerId !== fault.peerId);
				return singleOperationPlan("sync-another-peer", `peer:${fault.peerId}`, false, (signal) =>
					this.#ports.syncFromDifferentPeer({ candidates, excludedPeerId: fault.peerId }, signal)
				);
			}
			case "everything-unavailable":
				return singleOperationPlan("bounded-retry", "rendezvous", true, (signal) =>
					this.#ports.rendezvousBootstrap(
						this.#registryRequest(["registries", "dht-anchor", "cache", "signed-invite"]),
						signal
					)
				);
			case "total-control-plane-outage":
				return this.#totalOutagePlan(fault, status);
			default:
				return undefined;
		}
	}

	#registryFailurePlan(fault: Record<string, unknown>): RecoveryPlan | undefined {
		if (typeof fault.backendId !== "string" || !isStringArray(fault.remainingBackendIds)) return undefined;
		const nowMs = safeNow(this.#scheduler);
		for (const [backendId, untilMs] of this.#cooledDownBackends) {
			if (untilMs <= nowMs) this.#cooledDownBackends.delete(backendId);
		}
		const currentCooldown = this.#cooledDownBackends.get(fault.backendId) ?? 0;
		if (currentCooldown <= nowMs) {
			const untilMs = nowMs + this.#config.backendCooldownMs;
			try {
				this.#ports.registryCooldown({ backendId: fault.backendId, untilMs });
			} catch {
				return undefined;
			}
			this.#cooledDownBackends.set(fault.backendId, untilMs);
		}
		const excludeBackendIds = [...this.#cooledDownBackends.keys()];
		const preferredRegistryIds = fault.remainingBackendIds.filter(
			(backendId) => !this.#cooledDownBackends.has(backendId)
		);
		return singleOperationPlan("continue-registries", `registry:${fault.backendId}`, false, (signal) =>
			this.#ports.rendezvousBootstrap(
				{
					excludeBackendIds,
					preferredRegistryIds,
					sources: ["registries"],
				},
				signal
			)
		);
	}

	#registryRequest(sources: readonly ("cache" | "dht-anchor" | "registries" | "signed-invite")[]): {
		readonly excludeBackendIds?: readonly string[];
		readonly sources: readonly ("cache" | "dht-anchor" | "registries" | "signed-invite")[];
	} {
		this.#pruneCooldowns();
		const excludeBackendIds = sources.includes("registries") ? [...this.#cooledDownBackends.keys()] : [];
		return excludeBackendIds.length === 0 ? { sources } : { excludeBackendIds, sources };
	}

	#pruneCooldowns(): void {
		const nowMs = safeNow(this.#scheduler);
		for (const [backendId, untilMs] of this.#cooledDownBackends) {
			if (untilMs <= nowMs) this.#cooledDownBackends.delete(backendId);
		}
	}

	#totalOutagePlan(fault: Record<string, unknown>, status: ControlPlaneHealthSnapshot): RecoveryPlan | undefined {
		if (!isStringArray(fault.registries) || !isStringArray(fault.relays) || !isStringArray(fault.routers)) {
			return undefined;
		}
		const operations: RecoveryOperation[] = [
			{
				id: "registries",
				run: (signal): Promise<RecoveryMechanismResult> =>
					this.#ports.rendezvousBootstrap(
						{
							excludeBackendIds: [
								...new Set([
									...(fault.registries as readonly string[]),
									...(this.#registryRequest(["registries"]).excludeBackendIds ?? []),
								]),
							],
							sources: ["dht-anchor", "cache", "signed-invite"],
						},
						signal
					),
			},
			{
				id: "routers",
				run: (signal): Promise<RecoveryMechanismResult> =>
					runRouterFallbacks(this.#ports, fault.routers as readonly string[], signal),
			},
			...fault.relays.map((relayId) => ({
				id: `relay:${relayId}`,
				run: (signal: AbortSignal): Promise<RecoveryMechanismResult> => {
					const reservation = status.liveReservations.find((candidate) => candidate.relayId === relayId);
					return this.#ports.relayReplace(
						{ ...(reservation === undefined ? {} : { excludedOperatorGroup: reservation.operatorGroup }), relayId },
						"relay-disconnected",
						signal
					);
				},
			})),
		];
		return { action: "bounded-retry", operations, preserveLocalState: true };
	}
}

function normalizeConfig(config: ControlPlaneRecoveryConfig): NormalizedRecoveryConfig {
	const maxAttempts = boundedConfigInteger(config.max_attempts, 1, 100, "max_attempts");
	const parentDeadlineMs = boundedConfigInteger(config.parent_deadline_ms, 1, 300_000, "parent_deadline_ms");
	const retryDelays =
		config.retry_delays_ms ??
		Array.from({ length: Math.max(0, maxAttempts - 1) }, (_, index) => Math.min(100 * 2 ** index, 30_000));
	if (!Array.isArray(retryDelays)) throw new Error("control_plane.recovery.retry_delays_ms must be an array");
	if (retryDelays.length > 100) {
		throw new Error("control_plane.recovery.retry_delays_ms must contain at most 100 entries");
	}
	return Object.freeze({
		backendCooldownMs: boundedConfigInteger(config.backend_cooldown_ms, 0, 86_400_000, "backend_cooldown_ms"),
		healthPollIntervalMs: boundedConfigInteger(
			config.health_poll_interval_ms ?? 1_000,
			100,
			300_000,
			"health_poll_interval_ms"
		),
		maxAttempts,
		parentDeadlineMs,
		recoveryBackoffMs: boundedConfigInteger(
			config.recovery_backoff_ms ?? parentDeadlineMs,
			1,
			300_000,
			"recovery_backoff_ms"
		),
		retryDelaysMs: Object.freeze(
			retryDelays.map((value, index) => boundedConfigInteger(value, 0, 300_000, `retry_delays_ms[${index}]`))
		),
		startupGraceMs: boundedConfigInteger(config.startup_grace_ms ?? 1_000, 0, 300_000, "startup_grace_ms"),
	});
}

function boundedConfigInteger(value: number, minimum: number, maximum: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`control_plane.recovery.${field} must be an integer within ${minimum}..${maximum}`);
	}
	return value;
}

function singleOperationPlan(
	action: RecoveryAction,
	id: string,
	preserveLocalState: boolean,
	run: (signal: AbortSignal) => Promise<RecoveryMechanismResult>
): RecoveryPlan {
	return { action, operations: [{ id, run }], preserveLocalState };
}

async function runOperation(operation: RecoveryOperation, signal: AbortSignal): Promise<RecoveryOperationResult> {
	if (signal.aborted) return { id: operation.id, terminal: abortTerminal(signal) };
	try {
		const result = await runMechanismWithSignal(operation.run(signal), signal);
		return {
			id: operation.id,
			terminal: result.terminal === "succeeded" ? RecoveryTerminal.Succeeded : RecoveryTerminal.Failed,
		};
	} catch {
		return {
			id: operation.id,
			terminal: signal.aborted ? abortTerminal(signal) : RecoveryTerminal.Failed,
		};
	}
}

async function runRouterFallbacks(
	ports: ControlPlaneMechanismPorts,
	routerIds: readonly string[],
	signal: AbortSignal
): Promise<RecoveryMechanismResult> {
	for (const failedRouterId of routerIds) {
		try {
			const result = await ports.routerFallback(
				{ failedRouterId, sources: ["alternate-router", "registry-records"] },
				signal
			);
			if (result.terminal === "succeeded") return result;
		} catch {
			if (signal.aborted) throw signal.reason;
		}
	}
	return { terminal: "failed" };
}

function safeNow(scheduler: ControlPlaneScheduler): number {
	try {
		const value = scheduler.now();
		return Number.isFinite(value) ? value : 0;
	} catch {
		return 0;
	}
}

function cleanupEvidence(scheduler: ControlPlaneScheduler, baselineTimers = 0): RecoveryResult["cleanup"] {
	const activeTimers = Math.max(0, safePendingCount(scheduler) - baselineTimers);
	return Object.freeze({
		leakSample: Object.freeze({ activeTimers }),
		outcome: activeTimers === 0 ? "complete" : "failed",
	});
}

function safePendingCount(scheduler: ControlPlaneScheduler): number {
	try {
		return Math.max(0, scheduler.pendingCount());
	} catch {
		return 0;
	}
}

function terminalReason(
	terminal: RecoveryTerminal
): Extract<ControlPlanePhaseSixEvent, { kind: "terminal" }>["reason"] {
	switch (terminal) {
		case RecoveryTerminal.Aborted:
			return "aborted";
		case RecoveryTerminal.Deadline:
			return "deadline";
		case RecoveryTerminal.Succeeded:
			return "succeeded";
		case RecoveryTerminal.Exhausted:
			return "exhausted";
		case RecoveryTerminal.Failed:
			return "failed";
	}
}

function isHealthState(value: unknown): value is ControlPlaneHealthState {
	return value === "degraded" || value === "healthy" || value === "recovering";
}

function runMechanismWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => {
			cleanup();
			reject(signal.reason);
		};
		const cleanup = (): void => signal.removeEventListener("abort", abort);
		signal.addEventListener("abort", abort, { once: true });
		void operation.then(
			(value): void => {
				cleanup();
				resolve(value);
			},
			(error: unknown): void => {
				cleanup();
				reject(error);
			}
		);
	});
}

function abortTerminal(signal: AbortSignal): RecoveryTerminal {
	return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
		? RecoveryTerminal.Deadline
		: RecoveryTerminal.Aborted;
}

function terminalForAbort(signal: AbortSignal, deadlineReason: DOMException): RecoveryTerminal {
	return signal.reason === deadlineReason ? RecoveryTerminal.Deadline : abortTerminal(signal);
}

function classifyObservedFault(
	status: ControlPlaneHealthSnapshot,
	previous: ControlPlaneHealthSnapshot | undefined
): RecoveryFault | undefined {
	const genuineTotalOutage =
		status.authenticatedDrpPeerIds.length === 0 &&
		status.traffic.directConnections + status.traffic.relayedConnections === 0;
	if (genuineTotalOutage) return { kind: "everything-unavailable" };
	const failedRouterId = status.routing?.failedRouterIds[0];
	if (failedRouterId !== undefined) return { kind: "delegated-router-failed", routerId: failedRouterId };
	const directFailurePeerId = status.directConnectionFailedPeerIds?.[0];
	if (directFailurePeerId !== undefined) return { kind: "direct-connection-failed", peerId: directFailurePeerId };
	if (status.reasons.includes("dht-unavailable")) return { kind: "dht-unavailable" };
	const registryBackends =
		status.rendezvous.backends?.filter(
			({ id }) => id !== "cache" && id !== "dht-anchor" && id !== "invite" && id !== "peer-exchange"
		) ?? [];
	const failedBackends = registryBackends.filter(({ status: backendStatus }) => backendStatus === "failed");
	const healthyBackends = registryBackends.filter(({ status: backendStatus }) => backendStatus !== "failed");
	const singleFailedBackend = failedBackends.length === 1 ? failedBackends[0] : undefined;
	if (singleFailedBackend !== undefined && healthyBackends.length > 0) {
		return {
			backendId: singleFailedBackend.id,
			kind: "registry-failed",
			remainingBackendIds: healthyBackends.map(({ id }) => id),
		};
	}
	if (failedBackends.length > 0 && healthyBackends.length === 0) return { kind: "all-registries-failed" };
	const lostPeerId = status.lostAuthenticatedPeerIds?.[0];
	if (lostPeerId !== undefined && status.objectSynchronization === "behind") {
		return {
			authenticatedAlternates: status.authenticatedDrpPeerIds,
			kind: "peer-disappeared",
			peerId: lostPeerId,
		};
	}
	if (status.reasons.includes("no-live-reservation")) {
		const lostReservation = previous?.liveReservations.find(
			({ relayId }) => !status.liveReservations.some((candidate) => candidate.relayId === relayId)
		);
		return {
			kind: "relay-disconnected",
			...(lostReservation === undefined
				? {}
				: { operatorGroup: lostReservation.operatorGroup, relayId: lostReservation.relayId }),
		};
	}
	if (
		status.reasons.includes("no-healthy-backend") ||
		status.reasons.includes("rendezvous-stale") ||
		status.reasons.includes("no-rendezvous-replica")
	) {
		return { kind: "all-registries-failed" };
	}
	if (status.objectSynchronization === "behind") {
		const previousPeerId = previous?.authenticatedDrpPeerIds.find(
			(peerId) => !status.authenticatedDrpPeerIds.includes(peerId)
		);
		if (previousPeerId !== undefined) {
			return {
				authenticatedAlternates: status.authenticatedDrpPeerIds,
				kind: "peer-disappeared",
				peerId: previousPeerId,
			};
		}
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}
