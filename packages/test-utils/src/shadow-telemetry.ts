import type { IMetrics } from "@ts-drp/types";

import type { ShadowCloseObservation } from "./shadow-comparison.js";
import { runShadowTier, type ShadowRunReport, type ShadowShardInput } from "./shadow-runner.js";

const JOB_NAME = "ts-drp-shadow-soak";
const HEARTBEAT_MS = 60_000;
const CYCLE_TIMEOUT_MS = 45 * 60_000;
const PUSH_TIMEOUT_MS = 60_000;
const METRICS = Object.freeze({
	appliedVertices: "ts_drp_shadow_soak_applied_vertices",
	completedEpochs: "ts_drp_shadow_soak_completed_epochs",
	cycleDuration: "ts_drp_shadow_soak_cycle_duration_seconds",
	cycleInProgress: "ts_drp_shadow_soak_cycle_in_progress",
	cycleOvertime: "ts_drp_shadow_soak_cycle_overtime",
	cycleStarted: "ts_drp_shadow_soak_cycle_started_unixtime_seconds",
	evidenceHeartbeat: "ts_drp_shadow_soak_evidence_heartbeat_unixtime_seconds",
	lastComplete: "ts_drp_shadow_soak_last_complete_unixtime_seconds",
	mismatches: "ts_drp_shadow_soak_mismatches",
	nonemptyStates: "ts_drp_shadow_soak_nonempty_states",
	processHeartbeat: "ts_drp_shadow_soak_process_heartbeat_unixtime_seconds",
	referenceSamples: "ts_drp_shadow_soak_reference_samples",
	reportComplete: "ts_drp_shadow_soak_report_complete",
} as const);
const INPUT_KEYS = Object.freeze(["instance", "produceShard", "prometheus", "sha", "tracer"] as const);
const INSTANCE = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SHA = /^[0-9a-f]{40}$/u;

type MetricName = (typeof METRICS)[keyof typeof METRICS];

interface Gauge {
	set(labels: Readonly<Record<string, string>>, value: number): void;
}

interface PrometheusPort {
	gauge(input: Readonly<{ help: string; labelNames: readonly string[]; name: MetricName }>): Gauge;
	pushStrict(
		input: Readonly<{
			groupings: Readonly<{ instance: string }>;
			jobName: typeof JOB_NAME;
			signal: AbortSignal;
		}>
	): Promise<void>;
}

export interface StandingShadowTelemetryInput {
	readonly instance: string;
	produceShard(input: ShadowShardInput): Promise<readonly ShadowCloseObservation[]>;
	readonly prometheus: PrometheusPort;
	readonly sha: string;
	readonly tracer: IMetrics;
}

export interface StandingShadowTelemetrySnapshot {
	readonly lastReport?: ShadowRunReport;
	readonly state: "running" | "evidence" | "terminal" | "stopped";
}

export interface StandingShadowTelemetryHandle {
	readonly done: Promise<void>;
	readonly firstCycle: Promise<StandingShadowTelemetrySnapshot>;
	snapshot(): StandingShadowTelemetrySnapshot;
	stop(): Promise<void>;
}

class TerminalReportError extends Error {
	readonly report: ShadowRunReport;

	constructor(report: ShadowRunReport) {
		super("shadow comparison report is incomplete");
		this.name = "TerminalReportError";
		this.report = report;
	}
}

class CycleTimeoutError extends Error {
	constructor() {
		super("shadow comparison cycle exceeded 45 minutes");
		this.name = "CycleTimeoutError";
	}
}

function exactInput(input: StandingShadowTelemetryInput): void {
	const keys = Reflect.ownKeys(input);
	if (
		keys.length !== INPUT_KEYS.length ||
		!keys.every((key, index) => key === INPUT_KEYS[index]) ||
		!INSTANCE.test(input.instance) ||
		!SHA.test(input.sha) ||
		typeof input.produceShard !== "function" ||
		typeof input.prometheus?.gauge !== "function" ||
		typeof input.prometheus?.pushStrict !== "function" ||
		typeof input.tracer?.traceFunc !== "function"
	) {
		throw new TypeError("standing shadow telemetry input is invalid");
	}
}

function utcDate(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

function complete(report: ShadowRunReport): boolean {
	return (
		report.completedEpochs === report.epochs &&
		report.completedShards === report.shards &&
		report.mismatches.length === 0
	);
}

function frozenSnapshot(
	state: StandingShadowTelemetrySnapshot["state"],
	report: ShadowRunReport | undefined
): StandingShadowTelemetrySnapshot {
	return Object.freeze(report === undefined ? { state } : { lastReport: report, state });
}

/**
 * Runs the genuine nightly comparator on a daily cadence and publishes bounded diagnostics.
 * @param input - Captured deployment identity, genuine producer and diagnostic sinks.
 * @returns A stoppable standing telemetry handle.
 */
export function startStandingShadowTelemetry(input: StandingShadowTelemetryInput): StandingShadowTelemetryHandle {
	exactInput(input);
	const labels = Object.freeze({ instance: input.instance, tier: "nightly" });
	const mismatchLabels = (kind: string): Readonly<Record<string, string>> =>
		Object.freeze({ instance: input.instance, kind, tier: "nightly" });
	const gauges = Object.freeze(
		Object.fromEntries(
			Object.entries(METRICS).map(([key, name]) => [
				key,
				input.prometheus.gauge({
					help: `Phase 4d standing shadow soak ${key}`,
					labelNames: key === "mismatches" ? ["instance", "kind", "tier"] : ["instance", "tier"],
					name,
				}),
			])
		) as Record<keyof typeof METRICS, Gauge>
	);
	let state: StandingShadowTelemetrySnapshot["state"] = "running";
	let lastReport: ShadowRunReport | undefined;
	let lastAttemptDate: string | undefined;
	let lastCompleteSeconds: number | undefined;
	let evidenceHeartbeatSeconds: number | undefined;
	let cycleStartedSeconds = Date.now() / 1000;
	let cycleDurationSeconds = 0;
	let cycleInProgress = 0;
	let cycleOvertime = 0;
	let stopped = false;
	let running = false;
	let generation = 0;
	let pushTail = Promise.resolve();
	let activeCycle = Promise.resolve();
	const lifetime = new AbortController();
	let firstCycleSettled = false;
	let resolveFirstCycle: ((snapshot: StandingShadowTelemetrySnapshot) => void) | undefined;
	const firstCycle = new Promise<StandingShadowTelemetrySnapshot>((resolve) => {
		resolveFirstCycle = resolve;
	});
	let resolveDone: (() => void) | undefined;
	let rejectDone: ((error: unknown) => void) | undefined;
	const done = new Promise<void>((resolve, reject) => {
		resolveDone = resolve;
		rejectDone = reject;
	});

	const snapshot = (): StandingShadowTelemetrySnapshot => frozenSnapshot(state, lastReport);
	const settleFirstCycle = (): void => {
		if (firstCycleSettled) return;
		firstCycleSettled = true;
		resolveFirstCycle?.(snapshot());
	};
	const writeGauges = (): void => {
		const nowSeconds = Date.now() / 1000;
		gauges.processHeartbeat.set(labels, nowSeconds);
		gauges.cycleInProgress.set(labels, cycleInProgress);
		gauges.cycleOvertime.set(labels, cycleOvertime);
		gauges.cycleStarted.set(labels, cycleStartedSeconds);
		gauges.cycleDuration.set(labels, cycleDurationSeconds);
		if (lastReport !== undefined) {
			gauges.appliedVertices.set(labels, lastReport.appliedVertices);
			gauges.completedEpochs.set(labels, lastReport.completedEpochs);
			gauges.nonemptyStates.set(labels, lastReport.nonemptyStates);
			gauges.referenceSamples.set(labels, lastReport.referenceSamples);
			gauges.reportComplete.set(labels, state !== "terminal" && complete(lastReport) ? 1 : 0);
			const mismatch = lastReport.mismatches[0];
			gauges.mismatches.set(mismatchLabels(mismatch?.kind ?? "none"), lastReport.mismatches.length);
		} else if (state === "terminal") {
			gauges.reportComplete.set(labels, 0);
		}
		if (lastCompleteSeconds !== undefined) gauges.lastComplete.set(labels, lastCompleteSeconds);
		if (evidenceHeartbeatSeconds !== undefined) gauges.evidenceHeartbeat.set(labels, evidenceHeartbeatSeconds);
	};
	const fatal = (error: unknown): void => {
		if (stopped) return;
		stopped = true;
		state = "terminal";
		generation++;
		clearInterval(heartbeat);
		lifetime.abort(error);
		settleFirstCycle();
		rejectDone?.(error);
	};
	const push = (): Promise<void> => {
		pushTail = pushTail.then(async () => {
			if (stopped) return;
			writeGauges();
			await input.prometheus.pushStrict({
				groupings: { instance: input.instance },
				jobName: JOB_NAME,
				signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(PUSH_TIMEOUT_MS)]),
			});
		});
		pushTail.catch(fatal);
		return pushTail;
	};
	const runCycle = async (): Promise<void> => {
		if (stopped || running || state === "terminal") return;
		running = true;
		const cycleGeneration = ++generation;
		const date = utcDate(Date.now());
		lastAttemptDate = date;
		cycleStartedSeconds = Date.now() / 1000;
		cycleDurationSeconds = 0;
		cycleInProgress = 1;
		cycleOvertime = 0;
		state = "running";
		const monotonicStarted = performance.now();
		let pushed = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => reject(new CycleTimeoutError()), CYCLE_TIMEOUT_MS);
		});
		const tracedCycle = input.tracer.traceFunc("phase4d.shadow-soak.cycle", async (): Promise<ShadowRunReport> => {
			const report = await Promise.race([
				runShadowTier({
					browsers: [],
					date,
					produceShard: async (shardInput) => {
						if (stopped || state === "terminal" || generation !== cycleGeneration) {
							throw new TypeError("shadow cycle is no longer current");
						}
						return input.produceShard(shardInput);
					},
					runtimes: [`node-${process.versions.node.split(".")[0]}`],
					sha: input.sha,
					tier: "nightly",
				}),
				timedOut,
			]);
			if (!complete(report)) throw new TerminalReportError(report);
			if (stopped || generation !== cycleGeneration) return report;
			lastReport = report;
			state = "evidence";
			const nowSeconds = Date.now() / 1000;
			lastCompleteSeconds = nowSeconds;
			evidenceHeartbeatSeconds = nowSeconds;
			cycleDurationSeconds = Math.max(0, (performance.now() - monotonicStarted) / 1000);
			cycleInProgress = 0;
			running = false;
			await push();
			pushed = true;
			return report;
		});
		try {
			await tracedCycle();
		} catch (error) {
			if (stopped || generation !== cycleGeneration) return;
			state = "terminal";
			generation++;
			if (error instanceof TerminalReportError) lastReport = error.report;
			if (error instanceof CycleTimeoutError) cycleOvertime = 1;
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
			if (!stopped && (generation === cycleGeneration || state === "terminal")) {
				cycleDurationSeconds = Math.max(0, (performance.now() - monotonicStarted) / 1000);
				cycleInProgress = 0;
				running = false;
				if (!pushed) await push().catch(() => undefined);
				settleFirstCycle();
			}
		}
	};
	const heartbeatTick = (): void => {
		if (stopped) return;
		void push();
		if (state !== "terminal" && !running && utcDate(Date.now()) !== lastAttemptDate) {
			activeCycle = runCycle();
		}
	};
	const heartbeat = setInterval(heartbeatTick, HEARTBEAT_MS);
	activeCycle = runCycle();

	const stop = async (): Promise<void> => {
		if (state === "stopped") return;
		stopped = true;
		generation++;
		clearInterval(heartbeat);
		lifetime.abort(new Error("standing shadow telemetry stopped"));
		await activeCycle.catch(() => undefined);
		await pushTail.catch(() => undefined);
		state = "stopped";
		settleFirstCycle();
		resolveDone?.();
	};
	return Object.freeze({ done, firstCycle, snapshot, stop });
}
