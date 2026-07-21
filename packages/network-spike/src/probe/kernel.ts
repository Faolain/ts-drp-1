import type { AddressPolicy, Resolver } from "@ts-drp/rendezvous";

import {
	parseProbeEvent,
	PROBE_EVENT_SCHEMA_VERSION,
	type ProbeEvent,
	type ProbeEventDetails,
	type ProbeEventKind,
} from "./events.js";

const MAX_DEFERRED_CLEANUPS = 64;
const MAX_PROBE_EVENTS = 2_048;
const FAILURE_CODE_PATTERN = /^[a-z0-9-]+$/u;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/u;
const RUNNER_LIFECYCLE_EVENT_KINDS = new Set<ProbeEventKind>(["cleanup", "redaction", "resource-sample", "terminal"]);

export interface Clock {
	clearTimer(handle: unknown): void;
	now(): number;
	setTimer(callback: () => void, delayMs: number): unknown;
	sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface RandomSource {
	next(): number;
}

export interface FetchResponse {
	json(): Promise<unknown>;
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

export type FetchLike = (input: string, init: { method?: string; signal: AbortSignal }) => Promise<FetchResponse>;

export interface Dialer {
	dial(address: string, signal: AbortSignal): Promise<{ latencyMs: number; transport: string }>;
}

export interface NetworkObservationSink {
	record(event: ProbeEvent): void;
}

export interface ResourceSampler {
	sample(): { activeTimers: number; heapBytes?: number; openHandles: number };
}

export interface ProbeFailure {
	code: string;
	message: string;
	retryable: boolean;
}

export type ProbeExecution<Value> = { status: "success"; value: Value } | { failure: ProbeFailure; status: "failure" };

export interface Probe<Value> {
	readonly id: string;
	run(context: ProbeContext): Promise<ProbeExecution<Value>>;
}

export interface ProbeContext {
	readonly addressPolicy: AddressPolicy;
	readonly clock: Clock;
	readonly dialer: Dialer;
	readonly fetch: FetchLike;
	readonly random: RandomSource;
	readonly resolver: Resolver;
	readonly signal: AbortSignal;
	defer(cleanup: (signal: AbortSignal) => Promise<void> | void): void;
	emit<Kind extends ProbeEventKind>(kind: Kind, details: ProbeEventDetails<Kind>): void;
	throwIfAborted(): void;
}

export type ProbeRunResult<Value> =
	| {
			durationMs: number;
			events: readonly ProbeEvent[];
			status: "success";
			value: Value;
	  }
	| {
			durationMs: number;
			events: readonly ProbeEvent[];
			failure: ProbeFailure;
			status: "failure";
	  }
	| {
			durationMs: number;
			events: readonly ProbeEvent[];
			reason: "external" | "timeout";
			status: "aborted";
	  };

export interface ProbeRunnerDependencies {
	addressPolicy: AddressPolicy;
	clock: Clock;
	dialer: Dialer;
	fetch: FetchLike;
	random: RandomSource;
	resolver: Resolver;
	resourceSampler: ResourceSampler;
	sink: NetworkObservationSink;
}

export interface ProbeRunnerOptions {
	cleanupTimeoutMs: number;
	parentTimeoutMs: number;
	runId: string;
}

class ProbeAbort extends Error {
	readonly reason: "external" | "timeout";

	constructor(reason: "external" | "timeout") {
		super(`probe ${reason}`);
		this.reason = reason;
	}
}

/** Executes probes under one parent budget and owns telemetry and LIFO cleanup. */
export class ProbeRunner {
	readonly #dependencies: ProbeRunnerDependencies;
	readonly #options: Readonly<ProbeRunnerOptions>;

	/**
	 * Creates a bounded runner.
	 * @param dependencies - Injectable side-effect boundaries.
	 * @param options - Frozen parent and cleanup budgets.
	 */
	constructor(dependencies: ProbeRunnerDependencies, options: ProbeRunnerOptions) {
		if (
			!Number.isInteger(options.parentTimeoutMs) ||
			options.parentTimeoutMs <= 0 ||
			options.parentTimeoutMs > 30_000
		) {
			throw new Error("parent probe timeout must be within 1..30000ms");
		}
		if (
			!Number.isInteger(options.cleanupTimeoutMs) ||
			options.cleanupTimeoutMs <= 0 ||
			options.cleanupTimeoutMs > 5_000
		) {
			throw new Error("cleanup timeout must be within 1..5000ms");
		}
		if (typeof options.runId !== "string" || !IDENTIFIER_PATTERN.test(options.runId)) {
			throw new Error("probe run ID must contain 1..128 safe identifier characters");
		}
		this.#dependencies = dependencies;
		this.#options = Object.freeze({ ...options });
	}

	/**
	 * Runs one probe and always returns a typed terminal outcome.
	 * @param probe - Probe implementation.
	 * @param externalSignal - Optional caller cancellation.
	 * @returns Terminal result with its complete ordered event stream.
	 */
	async run<Value>(probe: Probe<Value>, externalSignal?: AbortSignal): Promise<ProbeRunResult<Value>> {
		if (typeof probe.id !== "string" || !IDENTIFIER_PATTERN.test(probe.id)) {
			throw new Error("probe ID must contain 1..128 safe identifier characters");
		}
		let dependencyFailure: Error | undefined;
		let lastClockNow = 0;
		const readClockNow = (): number => {
			try {
				const current = this.#dependencies.clock.now();
				if (!Number.isFinite(current)) throw new Error("clock returned a non-finite timestamp");
				lastClockNow = current;
			} catch (error) {
				dependencyFailure ??= error instanceof Error ? error : new Error(String(error));
			}
			return lastClockNow;
		};
		const startedAt = readClockNow();
		const controller = new AbortController();
		const cleanupController = new AbortController();
		const events: ProbeEvent[] = [];
		const cleanups: Array<(signal: AbortSignal) => Promise<void> | void> = [];
		let sinkFailure: Error | undefined;
		let resourceLimitFailure: ProbeFailure | undefined;
		let contractFailure: ProbeFailure | undefined;
		let probeEventCount = 0;
		let probeContextOpen = true;
		let abortReason: "external" | "timeout" = "timeout";

		const recordEvent = <Kind extends ProbeEventKind>(
			kind: Kind,
			details: ProbeEventDetails<Kind>,
			atMs: number
		): void => {
			const event = deepFreeze(
				parseProbeEvent({
					atMs,
					details,
					kind,
					probeId: probe.id,
					runId: this.#options.runId,
					schemaVersion: PROBE_EVENT_SCHEMA_VERSION,
					sequence: events.length,
				})
			);
			events.push(event);
			try {
				this.#dependencies.sink.record(event);
			} catch (error) {
				sinkFailure ??= error instanceof Error ? error : new Error(String(error));
			}
		};
		const emit = <Kind extends ProbeEventKind>(kind: Kind, details: ProbeEventDetails<Kind>): void => {
			recordEvent(kind, details, Math.max(0, Math.round(readClockNow() - startedAt)));
		};
		const emitFromProbe = <Kind extends ProbeEventKind>(kind: Kind, details: ProbeEventDetails<Kind>): void => {
			if (!probeContextOpen) throw new Error("probe event stream is closed");
			if (RUNNER_LIFECYCLE_EVENT_KINDS.has(kind)) {
				contractFailure ??= {
					code: "probe-contract-violation",
					message: `probe cannot emit runner-owned ${kind} events`,
					retryable: false,
				};
				throw new Error(contractFailure.message);
			}
			if (probeEventCount >= MAX_PROBE_EVENTS) {
				resourceLimitFailure ??= {
					code: "resource-limit",
					message: `probe event cap exceeded (${MAX_PROBE_EVENTS})`,
					retryable: false,
				};
				throw new Error(resourceLimitFailure.message);
			}
			probeEventCount += 1;
			emit(kind, details);
		};
		const emitResourceSample = (): void => {
			try {
				emit("resource-sample", this.#dependencies.resourceSampler.sample());
			} catch (error) {
				dependencyFailure ??= error instanceof Error ? error : new Error(String(error));
			}
		};

		const onExternalAbort = (): void => {
			abortReason = "external";
			controller.abort();
		};
		externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
		if (externalSignal?.aborted === true) onExternalAbort();

		let parentTimer: unknown;
		let parentTimerSet = false;
		try {
			parentTimer = this.#dependencies.clock.setTimer(() => {
				abortReason = "timeout";
				controller.abort();
			}, this.#options.parentTimeoutMs);
			parentTimerSet = true;
		} catch (error) {
			dependencyFailure ??= error instanceof Error ? error : new Error(String(error));
		}
		const context: ProbeContext = {
			addressPolicy: this.#dependencies.addressPolicy,
			clock: this.#dependencies.clock,
			defer: (cleanup): void => {
				if (!probeContextOpen) throw new Error("probe cleanup registration is closed");
				if (cleanups.length >= MAX_DEFERRED_CLEANUPS) {
					resourceLimitFailure ??= {
						code: "resource-limit",
						message: `deferred cleanup cap exceeded (${MAX_DEFERRED_CLEANUPS})`,
						retryable: false,
					};
					throw new Error(resourceLimitFailure.message);
				}
				cleanups.push(cleanup);
			},
			dialer: this.#dependencies.dialer,
			emit: emitFromProbe,
			fetch: this.#dependencies.fetch,
			random: this.#dependencies.random,
			resolver: this.#dependencies.resolver,
			signal: controller.signal,
			throwIfAborted: (): void => {
				if (controller.signal.aborted) throw new ProbeAbort(abortReason);
			},
		};

		emit("redaction", {
			namespaces: "per-run-pseudonyms",
			operatorDiversity: "aggregate-only",
			peerIds: "per-run-pseudonyms",
		});
		emitResourceSample();

		let terminal:
			| { status: "success"; value: Value }
			| { failure: ProbeFailure; status: "failure" }
			| { reason: "external" | "timeout"; status: "aborted" };
		let rejectAbort: (() => void) | undefined;
		try {
			if (dependencyFailure !== undefined) {
				terminal = dependencyFailureResult(dependencyFailure);
			} else {
				const abortPromise = new Promise<never>((_resolve, reject) => {
					rejectAbort = (): void => reject(new ProbeAbort(abortReason));
					if (controller.signal.aborted) rejectAbort();
					else controller.signal.addEventListener("abort", rejectAbort, { once: true });
				});
				const execution = await Promise.race([probe.run(context), abortPromise]);
				if (!isProbeExecution(execution)) {
					terminal = {
						failure: {
							code: "malformed-result",
							message: "probe returned a value outside the ProbeExecution union",
							retryable: false,
						},
						status: "failure",
					};
				} else {
					terminal = execution;
				}
			}
		} catch (error) {
			if (controller.signal.aborted) {
				terminal = { reason: abortReason, status: "aborted" };
			} else if (error instanceof ProbeAbort) {
				terminal = { reason: error.reason, status: "aborted" };
			} else {
				terminal = dependencyFailureResult(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			probeContextOpen = false;
			if (rejectAbort !== undefined) controller.signal.removeEventListener("abort", rejectAbort);
		}

		emit("cleanup", { completed: 0, failed: 0, phase: "start", registered: cleanups.length });
		let completed = 0;
		let failed = 0;
		try {
			({ completed, failed } = await runBoundedCleanups(
				cleanups.reverse(),
				cleanupController,
				this.#dependencies.clock,
				this.#options.cleanupTimeoutMs
			));
		} catch (error) {
			dependencyFailure ??= error instanceof Error ? error : new Error(String(error));
		}
		if (parentTimerSet) {
			try {
				this.#dependencies.clock.clearTimer(parentTimer);
			} catch (error) {
				dependencyFailure ??= error instanceof Error ? error : new Error(String(error));
			}
		}
		externalSignal?.removeEventListener("abort", onExternalAbort);
		emit("cleanup", { completed, failed, phase: "finish", registered: cleanups.length });
		emitResourceSample();

		const durationMs = Math.max(0, Math.round(readClockNow() - startedAt));
		if (failed > 0) {
			terminal = {
				failure: {
					code: "cleanup-failure",
					message: `${failed} registered cleanup operation(s) failed or timed out`,
					retryable: false,
				},
				status: "failure",
			};
		} else if (resourceLimitFailure !== undefined) {
			terminal = { failure: resourceLimitFailure, status: "failure" };
		} else if (contractFailure !== undefined) {
			terminal = { failure: contractFailure, status: "failure" };
		} else if (dependencyFailure !== undefined) {
			terminal = dependencyFailureResult(dependencyFailure);
		} else if (sinkFailure !== undefined) {
			terminal = {
				failure: {
					code: "observation-sink-failure",
					message: sinkFailure.message,
					retryable: false,
				},
				status: "failure",
			};
		}

		recordEvent(
			"terminal",
			{
				durationMs,
				reason:
					terminal.status === "success"
						? "completed"
						: terminal.status === "aborted"
							? terminal.reason
							: terminal.failure.code,
				status: terminal.status === "aborted" && terminal.reason === "timeout" ? "timeout" : terminal.status,
			},
			durationMs
		);
		if (
			sinkFailure !== undefined &&
			(terminal.status !== "failure" || terminal.failure.code !== "observation-sink-failure")
		) {
			terminal = {
				failure: {
					code: "observation-sink-failure",
					message: sinkFailure.message,
					retryable: false,
				},
				status: "failure",
			};
			const recordedTerminal = events.at(-1);
			if (recordedTerminal === undefined) throw new Error("terminal event was not recorded");
			events[events.length - 1] = deepFreeze(
				parseProbeEvent({
					...recordedTerminal,
					details: {
						durationMs,
						reason: terminal.failure.code,
						status: "failure",
					},
				})
			);
		}

		return { ...terminal, durationMs, events: Object.freeze(events.slice()) } as ProbeRunResult<Value>;
	}
}

/** Browser- and Node-compatible real clock. */
export class SystemClock implements Clock {
	/**
	 * Clears a real timer.
	 * @param handle - Handle returned by setTimer.
	 */
	clearTimer(handle: unknown): void {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	}

	/**
	 * Reads the monotonic clock.
	 * @returns Current monotonic milliseconds.
	 */
	now(): number {
		return performance.now();
	}

	/**
	 * Schedules a callback.
	 * @param callback - Timer callback.
	 * @param delayMs - Nonnegative delay.
	 * @returns Opaque timer handle.
	 */
	setTimer(callback: () => void, delayMs: number): unknown {
		return setTimeout(callback, delayMs);
	}

	/**
	 * Sleeps until the delay elapses or cancellation wins.
	 * @param delayMs - Nonnegative delay.
	 * @param signal - Cancellation signal.
	 * @returns Completion promise.
	 */
	sleep(delayMs: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const finish = (): void => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
			const timer = setTimeout(finish, delayMs);
			const onAbort = (): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				reject(new ProbeAbort("external"));
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

/** Small deterministic random source used by fixtures and retry jitter. */
export class SeededRandom implements RandomSource {
	#state: number;

	/**
	 * Creates a xorshift32 stream.
	 * @param seed - Nonzero 32-bit seed.
	 */
	constructor(seed: number) {
		this.#state = seed === 0 ? 0x9e3779b9 : seed | 0;
	}

	/**
	 * Produces the next deterministic sample.
	 * @returns A value in [0, 1).
	 */
	next(): number {
		let state = this.#state;
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		this.#state = state | 0;
		return (state >>> 0) / 0x1_0000_0000;
	}
}

function isProbeExecution<Value>(value: unknown): value is ProbeExecution<Value> {
	if (value === null || typeof value !== "object" || !("status" in value)) return false;
	if (value.status === "success") {
		return "value" in value && hasExactKeys(value, ["status", "value"]);
	}
	if (value.status !== "failure" || !("failure" in value)) return false;
	const failure = value.failure;
	return (
		hasExactKeys(value, ["failure", "status"]) &&
		failure !== null &&
		typeof failure === "object" &&
		hasExactKeys(failure, ["code", "message", "retryable"]) &&
		"code" in failure &&
		typeof failure.code === "string" &&
		failure.code.length <= 64 &&
		FAILURE_CODE_PATTERN.test(failure.code) &&
		"message" in failure &&
		typeof failure.message === "string" &&
		"retryable" in failure &&
		typeof failure.retryable === "boolean"
	);
}

function hasExactKeys(value: object, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function dependencyFailureResult(error: Error): { failure: ProbeFailure; status: "failure" } {
	return {
		failure: {
			code: "dependency-failure",
			message: error.message,
			retryable: false,
		},
		status: "failure",
	};
}

function deepFreeze<Value>(value: Value): Value {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value)) deepFreeze(nested);
	return Object.freeze(value);
}

async function runBoundedCleanups(
	cleanups: Array<(signal: AbortSignal) => Promise<void> | void>,
	controller: AbortController,
	clock: Clock,
	timeoutMs: number
): Promise<{ completed: number; failed: number }> {
	if (cleanups.length === 0) return { completed: 0, failed: 0 };
	let completed = 0;
	let failed = 0;
	let timedOut = false;
	let stopped = false;
	let timer: unknown;
	const timeout = new Promise<void>((resolve) => {
		timer = clock.setTimer(() => {
			timedOut = true;
			stopped = true;
			controller.abort();
			resolve();
		}, timeoutMs);
	});
	const work = (async (): Promise<void> => {
		for (const cleanup of cleanups) {
			if (stopped) break;
			try {
				const result = cleanup(controller.signal);
				if (result !== undefined) await result;
				completed += 1;
			} catch {
				failed += 1;
			}
		}
	})();
	try {
		await Promise.race([work, timeout]);
		if (timedOut) failed = cleanups.length - completed;
	} finally {
		clock.clearTimer(timer);
	}
	return { completed, failed };
}
