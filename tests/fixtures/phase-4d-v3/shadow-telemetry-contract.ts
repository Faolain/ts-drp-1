import type { IMetrics } from "@ts-drp/types";

import type { ShadowCloseObservation } from "./shadow-contract.js";
import type { ShadowRunReport, ShadowShardInput } from "./shadow-runner-contract.js";

export const SHADOW_SOAK_JOB = "ts-drp-shadow-soak";
export const SHADOW_SOAK_HEARTBEAT_MS = 60_000;
export const SHADOW_SOAK_PROCESS_STALE_SECONDS = 120;
export const SHADOW_SOAK_CYCLE_TIMEOUT_MS = 45 * 60_000;
export const SHADOW_SOAK_EVIDENCE_STALE_SECONDS = 26 * 60 * 60;
export const SHADOW_SOAK_ALERT_FOR = "2m";
export const SHADOW_SOAK_INPUT_KEYS = Object.freeze([
	"instance",
	"produceShard",
	"prometheus",
	"sha",
	"tracer",
] as const);

export const SHADOW_SOAK_METRICS = Object.freeze({
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

export const SHADOW_SOAK_ALERTS = Object.freeze([
	Object.freeze({
		alert: "ShadowSoakProcessStale",
		expr: `time() - ${SHADOW_SOAK_METRICS.processHeartbeat} > ${SHADOW_SOAK_PROCESS_STALE_SECONDS}`,
	}),
	Object.freeze({
		alert: "ShadowSoakCycleOvertime",
		expr: `${SHADOW_SOAK_METRICS.cycleInProgress} == 1 and time() - ${SHADOW_SOAK_METRICS.cycleStarted} > ${SHADOW_SOAK_CYCLE_TIMEOUT_MS / 1000}`,
	}),
	Object.freeze({
		alert: "ShadowSoakFirstEvidenceMissing",
		expr: `(${SHADOW_SOAK_METRICS.cycleInProgress} == 0 and time() - ${SHADOW_SOAK_METRICS.cycleStarted} > ${SHADOW_SOAK_CYCLE_TIMEOUT_MS / 1000}) unless on(instance) ${SHADOW_SOAK_METRICS.evidenceHeartbeat}`,
	}),
	Object.freeze({
		alert: "ShadowSoakEvidenceStale",
		expr: `time() - ${SHADOW_SOAK_METRICS.evidenceHeartbeat} > ${SHADOW_SOAK_EVIDENCE_STALE_SECONDS}`,
	}),
	Object.freeze({
		alert: "ShadowSoakReportIncomplete",
		expr: `${SHADOW_SOAK_METRICS.evidenceHeartbeat} and on(instance) ${SHADOW_SOAK_METRICS.reportComplete} == 0`,
	}),
	Object.freeze({
		alert: "ShadowSoakMismatch",
		expr: `${SHADOW_SOAK_METRICS.mismatches} > 0`,
	}),
] as const);

export type ShadowSoakMetricName = (typeof SHADOW_SOAK_METRICS)[keyof typeof SHADOW_SOAK_METRICS];

export interface ShadowSoakGauge {
	set(labels: Readonly<Record<string, string>>, value: number): void;
}

export interface ShadowSoakPrometheusPort {
	gauge(input: Readonly<{ help: string; labelNames: readonly string[]; name: ShadowSoakMetricName }>): ShadowSoakGauge;
	pushStrict(
		input: Readonly<{ groupings: Readonly<{ instance: string }>; jobName: typeof SHADOW_SOAK_JOB }>
	): Promise<void>;
}

export interface ShadowSoakInput {
	readonly instance: string;
	produceShard(input: ShadowShardInput): Promise<readonly ShadowCloseObservation[]>;
	readonly prometheus: ShadowSoakPrometheusPort;
	readonly sha: string;
	readonly tracer: IMetrics;
}

export interface ShadowSoakSnapshot {
	readonly lastReport?: ShadowRunReport;
	readonly state: "running" | "evidence" | "terminal" | "stopped";
}

export interface StandingShadowTelemetryHandle {
	readonly done: Promise<void>;
	readonly firstCycle: Promise<ShadowSoakSnapshot>;
	snapshot(): ShadowSoakSnapshot;
	stop(): Promise<void>;
}

export interface ShadowTelemetryModule {
	startStandingShadowTelemetry(input: ShadowSoakInput): StandingShadowTelemetryHandle;
}

export interface ShadowSoakProcessModule {
	superviseStandingShadowTelemetry(
		input: Readonly<{
			flush(): Promise<void>;
			readonly handle: StandingShadowTelemetryHandle;
			readonly signal: Promise<"SIGINT" | "SIGTERM">;
		}>
	): Promise<void>;
}
