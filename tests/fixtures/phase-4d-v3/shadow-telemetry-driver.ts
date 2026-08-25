/* eslint-disable jsdoc/require-jsdoc -- tests-only driver keeps deployment and metric oracles independent */
import type { IMetrics } from "@ts-drp/types";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

import type { ShadowCloseObservation } from "./shadow-contract.js";
import { buildShadowRun } from "./shadow-driver.js";
import type { ShadowRunReport, ShadowShardInput } from "./shadow-runner-contract.js";
import { cloneShardWithSeed } from "./shadow-runner-driver.js";
import {
	SHADOW_SOAK_ALERT_FOR,
	SHADOW_SOAK_ALERTS,
	SHADOW_SOAK_CYCLE_TIMEOUT_MS,
	SHADOW_SOAK_EVIDENCE_STALE_SECONDS,
	SHADOW_SOAK_HEARTBEAT_MS,
	SHADOW_SOAK_INPUT_KEYS,
	type SHADOW_SOAK_JOB,
	SHADOW_SOAK_METRICS,
	SHADOW_SOAK_PROCESS_STALE_SECONDS,
	type ShadowSoakGauge,
	type ShadowSoakMetricName,
	type ShadowSoakPrometheusPort,
} from "./shadow-telemetry-contract.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const DEPLOYMENT_PATHS = Object.freeze({
	alertmanager: path.join(REPOSITORY_ROOT, "docker/prometheus-metrics/alertmanager.yml.tmpl"),
	alerts: path.join(REPOSITORY_ROOT, "docker/prometheus-metrics/shadow-soak-alerts.yml"),
	compose: path.join(REPOSITORY_ROOT, "docker/prometheus-metrics/docker-compose.yml"),
	dockerfile: path.join(REPOSITORY_ROOT, "scripts/production-hardening/Dockerfile.shadow-soak"),
	prometheus: path.join(REPOSITORY_ROOT, "docker/prometheus-metrics/prometheus.yml"),
	runner: path.join(REPOSITORY_ROOT, "scripts/production-hardening/run-shadow-soak.ts"),
});

export interface MetricWrite {
	readonly labels: Readonly<Record<string, string>>;
	readonly name: ShadowSoakMetricName;
	readonly value: number;
}

export class ObservedPrometheusPort implements ShadowSoakPrometheusPort {
	readonly configs: Array<Readonly<{ help: string; labelNames: readonly string[]; name: ShadowSoakMetricName }>> = [];
	readonly pushes: Array<Readonly<{ groupings: Readonly<{ instance: string }>; jobName: string }>> = [];
	readonly writes: MetricWrite[] = [];
	pushFailure: Error | undefined;

	gauge(input: Readonly<{ help: string; labelNames: readonly string[]; name: ShadowSoakMetricName }>): ShadowSoakGauge {
		this.configs.push(Object.freeze({ ...input, labelNames: Object.freeze([...input.labelNames]) }));
		return {
			set: (labels, value): void => {
				this.writes.push(Object.freeze({ labels: Object.freeze({ ...labels }), name: input.name, value }));
			},
		};
	}

	pushStrict(
		input: Readonly<{ groupings: Readonly<{ instance: string }>; jobName: typeof SHADOW_SOAK_JOB }>
	): Promise<void> {
		this.pushes.push(Object.freeze({ groupings: Object.freeze({ ...input.groupings }), jobName: input.jobName }));
		return this.pushFailure === undefined ? Promise.resolve() : Promise.reject(this.pushFailure);
	}

	latest(name: ShadowSoakMetricName): MetricWrite | undefined {
		return this.writes.findLast((entry) => entry.name === name);
	}
}

export class ObservedTracer implements IMetrics {
	readonly names: string[] = [];
	readonly results: unknown[] = [];
	readonly failures: unknown[] = [];

	traceFunc<Args extends unknown[], Return>(
		name: string,
		fn: (...args: Args) => Return,
		_setAttributes?: (span: unknown, ...args: Args) => void,
		setResultAttributes?: (span: unknown, result: Awaited<Return>) => void
	): (...args: Args) => Return {
		return (...args: Args): Return => {
			this.names.push(name);
			try {
				const result = fn(...args);
				if (result instanceof Promise) {
					return result.then(
						(value) => {
							this.results.push(value);
							setResultAttributes?.({}, value as Awaited<Return>);
							return value;
						},
						(error: unknown) => {
							this.failures.push(error);
							throw error;
						}
					) as Return;
				}
				this.results.push(result);
				setResultAttributes?.({}, result as Awaited<Return>);
				return result;
			} catch (error) {
				this.failures.push(error);
				throw error;
			}
		};
	}
}

export function assertIndependentTelemetryContract(): void {
	const names = Object.values(SHADOW_SOAK_METRICS);
	if (new Set(names).size !== names.length || names.some((name) => !/^ts_drp_shadow_soak_[a-z_]+$/u.test(name))) {
		throw new TypeError("shadow soak metric roster is not closed and unique");
	}
	if (
		SHADOW_SOAK_HEARTBEAT_MS !== 60_000 ||
		SHADOW_SOAK_PROCESS_STALE_SECONDS !== 120 ||
		SHADOW_SOAK_CYCLE_TIMEOUT_MS !== 2_700_000 ||
		SHADOW_SOAK_EVIDENCE_STALE_SECONDS !== 93_600 ||
		SHADOW_SOAK_ALERT_FOR !== "2m"
	) {
		throw new TypeError("shadow soak timing contract drifted");
	}
	if (
		SHADOW_SOAK_INPUT_KEYS.join(",") !== "instance,produceShard,prometheus,sha,tracer" ||
		SHADOW_SOAK_INPUT_KEYS.some((key) => /report|success|count|clock|duration|elapsed|browser/u.test(key))
	) {
		throw new TypeError("shadow soak input admits caller-selected evidence");
	}
	if (
		SHADOW_SOAK_ALERTS.length !== 6 ||
		new Set(SHADOW_SOAK_ALERTS.map(({ alert }) => alert)).size !== SHADOW_SOAK_ALERTS.length ||
		SHADOW_SOAK_ALERTS.some(({ expr }) => !expr.includes("ts_drp_shadow_soak_"))
	) {
		throw new TypeError("shadow soak alert contract drifted");
	}
}

export function expectedEvidence(
	report: ShadowRunReport,
	nowSeconds: number,
	durationSeconds: number
): Readonly<Partial<Record<ShadowSoakMetricName, number>>> {
	const complete =
		report.completedEpochs === report.epochs &&
		report.completedShards === report.shards &&
		report.mismatches.length === 0;
	const evidence: Partial<Record<ShadowSoakMetricName, number>> = {
		[SHADOW_SOAK_METRICS.appliedVertices]: report.appliedVertices,
		[SHADOW_SOAK_METRICS.completedEpochs]: report.completedEpochs,
		[SHADOW_SOAK_METRICS.cycleDuration]: durationSeconds,
		[SHADOW_SOAK_METRICS.cycleInProgress]: 0,
		[SHADOW_SOAK_METRICS.cycleOvertime]: 0,
		[SHADOW_SOAK_METRICS.cycleStarted]: nowSeconds - durationSeconds,
		[SHADOW_SOAK_METRICS.mismatches]: report.mismatches.length,
		[SHADOW_SOAK_METRICS.nonemptyStates]: report.nonemptyStates,
		[SHADOW_SOAK_METRICS.processHeartbeat]: nowSeconds,
		[SHADOW_SOAK_METRICS.referenceSamples]: report.referenceSamples,
		[SHADOW_SOAK_METRICS.reportComplete]: complete ? 1 : 0,
	};
	if (complete) {
		evidence[SHADOW_SOAK_METRICS.evidenceHeartbeat] = nowSeconds;
		evidence[SHADOW_SOAK_METRICS.lastComplete] = nowSeconds;
	}
	return Object.freeze(evidence);
}

const defaultObservations = await buildShadowRun();

export function boundedGenuineShard(input: ShadowShardInput): Promise<readonly ShadowCloseObservation[]> {
	return Promise.resolve(cloneShardWithSeed(defaultObservations, input.seed));
}

export function deploymentSources():
	| Readonly<{
			alertmanager: Readonly<Record<string, unknown>>;
			alerts: Readonly<Record<string, unknown>>;
			compose: Readonly<Record<string, unknown>>;
			dockerfile: string;
			prometheus: Readonly<Record<string, unknown>>;
			runner: string;
	  }>
	| undefined {
	try {
		const alertmanagerSource = readFileSync(DEPLOYMENT_PATHS.alertmanager, "utf8").replace(
			"__SHADOW_ALERT_WEBHOOK_URL__",
			"http://127.0.0.1:9/shadow-soak"
		);
		return Object.freeze({
			alertmanager: parseDocument(alertmanagerSource, { schema: "core" }).toJS() as Record<string, unknown>,
			alerts: parseDocument(readFileSync(DEPLOYMENT_PATHS.alerts, "utf8"), { schema: "core" }).toJS() as Record<
				string,
				unknown
			>,
			compose: parseDocument(readFileSync(DEPLOYMENT_PATHS.compose, "utf8"), { schema: "core" }).toJS() as Record<
				string,
				unknown
			>,
			dockerfile: readFileSync(DEPLOYMENT_PATHS.dockerfile, "utf8"),
			prometheus: parseDocument(readFileSync(DEPLOYMENT_PATHS.prometheus, "utf8"), { schema: "core" }).toJS() as Record<
				string,
				unknown
			>,
			runner: readFileSync(DEPLOYMENT_PATHS.runner, "utf8"),
		});
	} catch {
		return undefined;
	}
}
