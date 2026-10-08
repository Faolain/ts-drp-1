import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShadowCloseObservation } from "./fixtures/phase-4d-v3/shadow-contract.js";
import {
	SHADOW_PROFILES,
	SHADOW_RUN_SCHEMA_VERSION,
	SHADOW_SEED_VECTOR,
	type ShadowRunReport,
} from "./fixtures/phase-4d-v3/shadow-runner-contract.js";
import {
	SHADOW_SOAK_ALERT_FOR,
	SHADOW_SOAK_ALERTS,
	SHADOW_SOAK_CYCLE_TIMEOUT_MS,
	SHADOW_SOAK_EVIDENCE_STALE_SECONDS,
	SHADOW_SOAK_HEARTBEAT_MS,
	SHADOW_SOAK_INPUT_KEYS,
	SHADOW_SOAK_JOB,
	SHADOW_SOAK_METRICS,
	SHADOW_SOAK_PROCESS_STALE_SECONDS,
	type ShadowSoakProcessModule,
	type ShadowTelemetryModule,
} from "./fixtures/phase-4d-v3/shadow-telemetry-contract.js";
import {
	assertIndependentTelemetryContract,
	boundedGenuineShard,
	deploymentSources,
	expectedEvidence,
	ObservedPrometheusPort,
	ObservedTracer,
} from "./fixtures/phase-4d-v3/shadow-telemetry-driver.js";

const OWNER_SPECIFIER = "@ts-drp/test-utils/shadow-telemetry";
let owner: ShadowTelemetryModule | undefined;
try {
	owner = await vi.importActual<ShadowTelemetryModule>(OWNER_SPECIFIER);
} catch {
	owner = undefined;
}
const ownerReady = owner !== undefined && typeof owner.startStandingShadowTelemetry === "function";
let processOwner: ShadowSoakProcessModule | undefined;
try {
	processOwner = await vi.importActual<ShadowSoakProcessModule>("../scripts/production-hardening/run-shadow-soak.js");
} catch {
	processOwner = undefined;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function requireOwner(): ShadowTelemetryModule {
	if (owner === undefined) throw new TypeError("shadow telemetry owner is absent");
	return owner;
}

function requireProcessOwner(): ShadowSoakProcessModule {
	if (processOwner === undefined) throw new TypeError("shadow telemetry process owner is absent");
	return processOwner;
}

function deferred<Value>(): Readonly<{
	readonly promise: Promise<Value>;
	resolve(value: Value): void;
}> {
	let resolvePromise: ((value: Value) => void) | undefined;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return Object.freeze({
		promise,
		resolve: (value: Value): void => {
			resolvePromise?.(value);
		},
	});
}

class ControlledFlush {
	readonly releases: Array<() => void> = [];
	calls = 0;

	flush = (): Promise<void> => {
		this.calls++;
		return new Promise((resolve) => {
			this.releases.push(resolve);
		});
	};

	releaseNext(): void {
		const release = this.releases.shift();
		if (release === undefined) throw new TypeError("no tracer flush is pending");
		release();
	}
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new TypeError("condition did not settle");
}

async function waitForIoCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new TypeError("I/O condition did not settle");
}

function completeReport(): ShadowRunReport {
	return Object.freeze({
		appliedVertices: SHADOW_PROFILES.nightly.epochs * 3,
		browsers: Object.freeze([]),
		completedEpochs: SHADOW_PROFILES.nightly.epochs,
		completedShards: SHADOW_PROFILES.nightly.shards,
		date: SHADOW_SEED_VECTOR.date,
		epochs: SHADOW_PROFILES.nightly.epochs,
		mismatches: Object.freeze([]),
		nonemptyStates: SHADOW_PROFILES.nightly.epochs,
		referenceSamples: SHADOW_PROFILES.nightly.referenceSamples,
		runtimes: Object.freeze(["node-22"]),
		schemaVersion: SHADOW_RUN_SCHEMA_VERSION,
		seed: SHADOW_SEED_VECTOR.seed,
		sha: SHADOW_SEED_VECTOR.sha,
		shards: SHADOW_PROFILES.nightly.shards,
		tier: "nightly",
	});
}

describe("Phase 4d-c standing shadow telemetry RED", () => {
	it("pins an independent closed metric, clock, alert, and caller-authority contract", () => {
		expect(assertIndependentTelemetryContract()).toBeUndefined();
		expect(SHADOW_SOAK_INPUT_KEYS).toEqual(["instance", "produceShard", "prometheus", "sha", "tracer"]);
		expect(SHADOW_SOAK_HEARTBEAT_MS).toBeLessThan(SHADOW_SOAK_PROCESS_STALE_SECONDS * 1000);
		expect(SHADOW_SOAK_CYCLE_TIMEOUT_MS).toBe(2_700_000);
		expect(SHADOW_SOAK_EVIDENCE_STALE_SECONDS).toBe(93_600);
		expect(SHADOW_SOAK_ALERT_FOR).toBe("2m");
		const expected = expectedEvidence(completeReport(), 2_000, 25);
		expect(expected).toMatchObject({
			[SHADOW_SOAK_METRICS.appliedVertices]: 30_000,
			[SHADOW_SOAK_METRICS.completedEpochs]: 10_000,
			[SHADOW_SOAK_METRICS.cycleDuration]: 25,
			[SHADOW_SOAK_METRICS.evidenceHeartbeat]: 2_000,
			[SHADOW_SOAK_METRICS.lastComplete]: 2_000,
			[SHADOW_SOAK_METRICS.mismatches]: 0,
			[SHADOW_SOAK_METRICS.nonemptyStates]: 10_000,
			[SHADOW_SOAK_METRICS.referenceSamples]: 1_000,
			[SHADOW_SOAK_METRICS.reportComplete]: 1,
		});
		const incomplete = expectedEvidence(
			Object.freeze({
				...completeReport(),
				mismatches: Object.freeze([
					Object.freeze({ epoch: 1, kind: "state-mismatch" as const, seed: SHADOW_SEED_VECTOR.seed }),
				]),
			}),
			2_000,
			25
		);
		expect(incomplete[SHADOW_SOAK_METRICS.reportComplete]).toBe(0);
		expect(incomplete).not.toHaveProperty(SHADOW_SOAK_METRICS.evidenceHeartbeat);
		expect(incomplete).not.toHaveProperty(SHADOW_SOAK_METRICS.lastComplete);
		expect(SHADOW_SOAK_ALERTS).toHaveLength(6);
	});

	it("has exactly one missing standing telemetry owner readiness failure", () => {
		expect(ownerReady).toBe(true);
	});

	it.skipIf(!ownerReady)("invokes the real nightly runner and derives every evidence gauge", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
		const prometheus = new ObservedPrometheusPort();
		const tracer = new ObservedTracer();
		const calls: number[] = [];
		const handle = requireOwner().startStandingShadowTelemetry({
			instance: "soak-a",
			produceShard: (input) => {
				calls.push(input.seed);
				return boundedGenuineShard(input);
			},
			prometheus,
			sha: SHADOW_SEED_VECTOR.sha,
			tracer,
		});
		const first = await handle.firstCycle;
		expect(first.state).toBe("evidence");
		expect(first.lastReport).toMatchObject(completeReport());
		expect(calls).toHaveLength(SHADOW_PROFILES.nightly.shards);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.completedEpochs)?.value).toBe(10_000);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.appliedVertices)?.value).toBe(30_000);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.nonemptyStates)?.value).toBe(10_000);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.referenceSamples)?.value).toBe(1_000);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.mismatches)?.value).toBe(0);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.reportComplete)?.value).toBe(1);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.evidenceHeartbeat)?.value).toBe(Date.now() / 1000);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.lastComplete)?.value).toBe(Date.now() / 1000);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.cycleInProgress)?.value).toBe(0);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.cycleOvertime)?.value).toBe(0);
		const cycleDuration = prometheus.latest(SHADOW_SOAK_METRICS.cycleDuration)?.value;
		if (cycleDuration === undefined) throw new TypeError("cycle duration evidence is absent");
		expect(Number.isFinite(cycleDuration)).toBe(true);
		expect(cycleDuration).toBeGreaterThanOrEqual(0);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.cycleStarted)?.value).toBeLessThanOrEqual(Date.now() / 1000);
		expect(prometheus.pushes).toContainEqual({ groupings: { instance: "soak-a" }, jobName: SHADOW_SOAK_JOB });
		expect(tracer.names).toEqual(["phase4d.shadow-soak.cycle"]);
		for (const config of prometheus.configs) {
			expect(config.labelNames.every((label) => ["instance", "kind", "tier"].includes(label))).toBe(true);
			expect(config.labelNames).not.toEqual(expect.arrayContaining(["seed", "epoch", "sha"]));
		}
		await handle.stop();
		expect(handle.snapshot().state).toBe("stopped");
	});

	it.skipIf(!ownerReady)(
		"separates process liveness from first evidence and rejects overlapping or repeated-day work",
		async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
			const prometheus = new ObservedPrometheusPort();
			const tracer = new ObservedTracer();
			let releaseFirst: ((value: readonly ShadowCloseObservation[]) => void) | undefined;
			let calls = 0;
			const handle = requireOwner().startStandingShadowTelemetry({
				instance: "soak-waiting",
				produceShard: (input) => {
					calls++;
					if (calls !== 1) return boundedGenuineShard(input);
					return new Promise((resolve) => {
						releaseFirst = resolve;
					});
				},
				prometheus,
				sha: SHADOW_SEED_VECTOR.sha,
				tracer,
			});
			await vi.advanceTimersByTimeAsync(SHADOW_SOAK_HEARTBEAT_MS);
			expect(prometheus.latest(SHADOW_SOAK_METRICS.processHeartbeat)).toBeDefined();
			expect(prometheus.latest(SHADOW_SOAK_METRICS.evidenceHeartbeat)).toBeUndefined();
			expect(prometheus.latest(SHADOW_SOAK_METRICS.cycleInProgress)?.value).toBe(1);
			const firstShard = await boundedGenuineShard({ closes: 100, seed: SHADOW_SEED_VECTOR.seed });
			releaseFirst?.(firstShard);
			await handle.firstCycle;
			expect(calls).toBe(100);
			await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
			expect(calls).toBe(100);
			await vi.advanceTimersByTimeAsync(60 * 60_000);
			expect(calls).toBe(200);
			await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
			expect(calls).toBe(200);
			await handle.stop();
		}
	);

	it.skipIf(!ownerReady)("keeps mismatch evidence terminal and propagates strict delivery failure", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
		const prometheus = new ObservedPrometheusPort();
		const tracer = new ObservedTracer();
		let calls = 0;
		const handle = requireOwner().startStandingShadowTelemetry({
			instance: "soak-mismatch",
			produceShard: async (input) => {
				calls++;
				const shard = await boundedGenuineShard(input);
				const first = shard[0];
				if (first === undefined) throw new TypeError("shadow shard is empty");
				return [{ ...first, archival: { ...first.archival, stateDigest: "00".repeat(32) } }, ...shard.slice(1)];
			},
			prometheus,
			sha: SHADOW_SEED_VECTOR.sha,
			tracer,
		});
		expect((await handle.firstCycle).state).toBe("terminal");
		expect(prometheus.latest(SHADOW_SOAK_METRICS.mismatches)?.value).toBe(1);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.reportComplete)?.value).toBe(0);
		expect(prometheus.latest(SHADOW_SOAK_METRICS.evidenceHeartbeat)).toBeUndefined();
		expect(prometheus.latest(SHADOW_SOAK_METRICS.lastComplete)).toBeUndefined();
		expect(tracer.failures).toHaveLength(1);
		const mismatchCalls = calls;
		await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
		expect(calls).toBe(mismatchCalls);
		expect(prometheus.pushes.length).toBeGreaterThan(1);
		await handle.stop();

		const failing = new ObservedPrometheusPort();
		failing.pushFailure = new Error("push rejected");
		const failingTracer = new ObservedTracer();
		const failed = requireOwner().startStandingShadowTelemetry({
			instance: "soak-push-failure",
			produceShard: boundedGenuineShard,
			prometheus: failing,
			sha: SHADOW_SEED_VECTOR.sha,
			tracer: failingTracer,
		});
		await expect(failed.done).rejects.toThrow(/push rejected/u);
		expect(failingTracer.failures).toHaveLength(1);
	});

	it.skipIf(!ownerReady)(
		"terminalizes an overtime cycle, suppresses its late result, and republishes evidence",
		async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
			const prometheus = new ObservedPrometheusPort();
			const tracer = new ObservedTracer();
			const held = deferred<readonly ShadowCloseObservation[]>();
			let calls = 0;
			let holdNextCycle = false;
			const handle = requireOwner().startStandingShadowTelemetry({
				instance: "soak-overtime",
				produceShard: (input) => {
					calls++;
					return holdNextCycle ? held.promise : boundedGenuineShard(input);
				},
				prometheus,
				sha: SHADOW_SEED_VECTOR.sha,
				tracer,
			});
			expect((await handle.firstCycle).state).toBe("evidence");
			expect(calls).toBe(100);
			expect(prometheus.latest(SHADOW_SOAK_METRICS.reportComplete)?.value).toBe(1);
			holdNextCycle = true;
			await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
			expect(calls).toBe(101);
			await vi.advanceTimersByTimeAsync(SHADOW_SOAK_CYCLE_TIMEOUT_MS);
			expect(handle.snapshot().state).toBe("terminal");
			expect(calls).toBe(101);
			expect(prometheus.latest(SHADOW_SOAK_METRICS.cycleOvertime)?.value).toBe(1);
			expect(prometheus.latest(SHADOW_SOAK_METRICS.cycleInProgress)?.value).toBe(0);
			expect(prometheus.latest(SHADOW_SOAK_METRICS.reportComplete)?.value).toBe(0);
			expect(prometheus.latest(SHADOW_SOAK_METRICS.evidenceHeartbeat)).toBeDefined();
			expect(prometheus.latest(SHADOW_SOAK_METRICS.lastComplete)).toBeDefined();
			expect(tracer.failures).toHaveLength(1);
			const pushesAtTerminal = prometheus.pushes.length;
			await vi.advanceTimersByTimeAsync(2 * SHADOW_SOAK_HEARTBEAT_MS);
			expect(prometheus.pushes.length).toBeGreaterThan(pushesAtTerminal);
			const lateShard = await boundedGenuineShard({ closes: 100, seed: SHADOW_SEED_VECTOR.seed });
			held.resolve(lateShard);
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toBe(101);
			expect(handle.snapshot().state).toBe("terminal");
			expect(prometheus.latest(SHADOW_SOAK_METRICS.cycleOvertime)?.value).toBe(1);
			await handle.stop();
		}
	);

	it.skipIf(!ownerReady)("awaits tracer flush on mismatch, strict-push failure, SIGINT, and SIGTERM", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
		const lifecycleOwner = requireProcessOwner();

		const mismatchPrometheus = new ObservedPrometheusPort();
		const mismatchHandle = requireOwner().startStandingShadowTelemetry({
			instance: "soak-flush-mismatch",
			produceShard: async (input) => {
				const shard = await boundedGenuineShard(input);
				const first = shard[0];
				if (first === undefined) throw new TypeError("shadow shard is empty");
				return [{ ...first, archival: { ...first.archival, stateDigest: "00".repeat(32) } }, ...shard.slice(1)];
			},
			prometheus: mismatchPrometheus,
			sha: SHADOW_SEED_VECTOR.sha,
			tracer: new ObservedTracer(),
		});
		const mismatchSignal = deferred<"SIGINT" | "SIGTERM">();
		const mismatchFlush = new ControlledFlush();
		let mismatchSettled = false;
		const mismatchLifecycle = lifecycleOwner
			.superviseStandingShadowTelemetry({
				flush: mismatchFlush.flush,
				handle: mismatchHandle,
				signal: mismatchSignal.promise,
			})
			.finally(() => {
				mismatchSettled = true;
			});
		expect((await mismatchHandle.firstCycle).state).toBe("terminal");
		await waitForCondition(() => mismatchFlush.calls === 1);
		expect(mismatchSettled).toBe(false);
		mismatchFlush.releaseNext();
		await Promise.resolve();
		expect(mismatchSettled).toBe(false);
		mismatchSignal.resolve("SIGTERM");
		await waitForCondition(() => mismatchFlush.calls === 2);
		expect(mismatchSettled).toBe(false);
		mismatchFlush.releaseNext();
		await mismatchLifecycle;

		const failingPrometheus = new ObservedPrometheusPort();
		failingPrometheus.pushFailure = new Error("strict push failed");
		const failingHandle = requireOwner().startStandingShadowTelemetry({
			instance: "soak-flush-push",
			produceShard: boundedGenuineShard,
			prometheus: failingPrometheus,
			sha: SHADOW_SEED_VECTOR.sha,
			tracer: new ObservedTracer(),
		});
		const neverSignal = deferred<"SIGINT" | "SIGTERM">();
		const failureFlush = new ControlledFlush();
		let failureSettled = false;
		const failingLifecycle = lifecycleOwner
			.superviseStandingShadowTelemetry({
				flush: failureFlush.flush,
				handle: failingHandle,
				signal: neverSignal.promise,
			})
			.then(
				() => ({ error: undefined }),
				(error: unknown) => ({ error })
			)
			.finally(() => {
				failureSettled = true;
			});
		await waitForCondition(() => failureFlush.calls === 1);
		expect(failureSettled).toBe(false);
		failureFlush.releaseNext();
		const failedResult = await failingLifecycle;
		expect(failedResult.error).toBeInstanceOf(Error);
		expect(String(failedResult.error)).toMatch(/strict push failed/u);

		for (const signalName of ["SIGINT", "SIGTERM"] as const) {
			const handle = requireOwner().startStandingShadowTelemetry({
				instance: `soak-flush-${signalName.toLowerCase()}`,
				produceShard: boundedGenuineShard,
				prometheus: new ObservedPrometheusPort(),
				sha: SHADOW_SEED_VECTOR.sha,
				tracer: new ObservedTracer(),
			});
			const signal = deferred<"SIGINT" | "SIGTERM">();
			const flush = new ControlledFlush();
			let settled = false;
			const lifecycle = lifecycleOwner
				.superviseStandingShadowTelemetry({ flush: flush.flush, handle, signal: signal.promise })
				.finally(() => {
					settled = true;
				});
			await handle.firstCycle;
			signal.resolve(signalName);
			await waitForCondition(() => flush.calls === 1);
			expect(settled).toBe(false);
			flush.releaseNext();
			await lifecycle;
			expect(handle.snapshot().state).toBe("stopped");
		}

		const activeRelease = deferred<readonly ShadowCloseObservation[]>();
		let activeInput: Parameters<typeof boundedGenuineShard>[0] | undefined;
		const activeHandle = requireOwner().startStandingShadowTelemetry({
			instance: "soak-flush-active",
			produceShard: (input) => {
				activeInput = input;
				return activeRelease.promise;
			},
			prometheus: new ObservedPrometheusPort(),
			sha: SHADOW_SEED_VECTOR.sha,
			tracer: new ObservedTracer(),
		});
		const activeSignal = deferred<"SIGINT" | "SIGTERM">();
		const activeFlush = new ControlledFlush();
		const activeLifecycle = lifecycleOwner.superviseStandingShadowTelemetry({
			flush: activeFlush.flush,
			handle: activeHandle,
			signal: activeSignal.promise,
		});
		await waitForCondition(() => activeInput !== undefined);
		activeSignal.resolve("SIGTERM");
		await Promise.resolve();
		expect(activeFlush.calls).toBe(0);
		activeRelease.resolve(await boundedGenuineShard(activeInput as Parameters<typeof boundedGenuineShard>[0]));
		await waitForCondition(() => activeFlush.calls === 1);
		activeFlush.releaseNext();
		await activeLifecycle;
		expect(activeHandle.snapshot().state).toBe("stopped");
	});

	it.skipIf(!ownerReady)("rejects Pushgateway redirects and server errors with the real client", async () => {
		let status = 202;
		const bodies: string[] = [];
		const methods: string[] = [];
		const paths: string[] = [];
		let holdResponse = false;
		const server = createServer((request, response) => {
			request.on("error", () => undefined);
			methods.push(request.method ?? "");
			paths.push(request.url ?? "");
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => {
				body += chunk;
			});
			request.on("end", () => {
				bodies.push(body);
				if (!holdResponse) response.writeHead(status).end();
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const address = server.address();
			if (address === null || typeof address === "string") throw new TypeError("test server address is invalid");
			const module = (await import("../packages/network/src/metrics/prometheus.js")) as unknown as {
				createMetricsRegister(url: string): {
					gauge(input: Readonly<{ help: string; labelNames: string[]; name: string }>): {
						set(labels: Readonly<Record<string, string>>, value: number): void;
					};
					pushMetricsOrThrow(
						jobName: string,
						groupings: Readonly<Record<string, string>>,
						signal?: AbortSignal
					): Promise<void>;
				};
			};
			const register = module.createMetricsRegister(`http://127.0.0.1:${address.port}`);
			register
				.gauge({ help: "phase4d strict push proof", labelNames: ["instance"], name: "phase4d_strict_push_proof" })
				.set({ instance: "soak-http" }, 1);
			await expect(register.pushMetricsOrThrow(SHADOW_SOAK_JOB, { instance: "soak-http" })).resolves.toBeUndefined();
			status = 302;
			await expect(register.pushMetricsOrThrow(SHADOW_SOAK_JOB, { instance: "soak-http" })).rejects.toThrow(/302/u);
			status = 500;
			await expect(register.pushMetricsOrThrow(SHADOW_SOAK_JOB, { instance: "soak-http" })).rejects.toThrow(/500/u);
			expect(bodies[0]).toContain("phase4d_strict_push_proof");
			expect(methods).toEqual(["PUT", "PUT", "PUT"]);
			expect(paths).toEqual([
				`/metrics/job/${SHADOW_SOAK_JOB}/instance/soak-http`,
				`/metrics/job/${SHADOW_SOAK_JOB}/instance/soak-http`,
				`/metrics/job/${SHADOW_SOAK_JOB}/instance/soak-http`,
			]);
			holdResponse = true;
			const abort = new AbortController();
			const pending = register.pushMetricsOrThrow(SHADOW_SOAK_JOB, { instance: "soak-http" }, abort.signal);
			await waitForIoCondition(() => methods.length === 4);
			abort.abort(new Error("strict push cancelled"));
			await expect(pending).rejects.toThrow(/abort|cancel/u);
			expect(methods[3]).toBe("PUT");
		} finally {
			const closed = once(server, "close");
			server.close();
			await closed;
		}
	});

	it.skipIf(!ownerReady)("pins the genuine daemon, image, freshness rules, and alert delivery path", () => {
		const sources = deploymentSources();
		expect(sources).toBeDefined();
		const serializedCompose = JSON.stringify(sources?.compose);
		expect(serializedCompose).toContain("shadow-soak");
		expect(serializedCompose).toContain("alertmanager");
		expect(serializedCompose).toContain("SHADOW_ALERT_WEBHOOK_URL");
		const alertGroups = (sources?.alerts as { groups?: Array<{ rules?: unknown[] }> } | undefined)?.groups;
		const rules = alertGroups?.flatMap((group) => group.rules ?? []) as
			| Array<{ alert?: string; expr?: string; for?: string }>
			| undefined;
		expect(rules).toHaveLength(SHADOW_SOAK_ALERTS.length);
		expect(
			rules?.map((rule) => ({
				alert: rule.alert,
				expr: rule.expr?.replace(/\s+/gu, " ").trim(),
				for: rule.for,
			}))
		).toEqual(SHADOW_SOAK_ALERTS.map((rule) => ({ ...rule, for: SHADOW_SOAK_ALERT_FOR })));
		const prometheus = sources?.prometheus as
			| {
					alerting?: { alertmanagers?: Array<{ static_configs?: Array<{ targets?: string[] }> }> };
					rule_files?: string[];
			  }
			| undefined;
		expect(prometheus?.rule_files).toContain("shadow-soak-alerts.yml");
		expect(prometheus?.alerting?.alertmanagers?.[0]?.static_configs?.[0]?.targets).toContain("alertmanager:9093");
		const alertmanager = sources?.alertmanager as
			| {
					receivers?: Array<{ name?: string; webhook_configs?: Array<{ url?: string }> }>;
					route?: { receiver?: string };
			  }
			| undefined;
		expect(alertmanager?.route?.receiver).toBe("shadow-soak-webhook");
		expect(alertmanager?.receivers).toContainEqual(
			expect.objectContaining({
				name: "shadow-soak-webhook",
				webhook_configs: expect.arrayContaining([expect.objectContaining({ url: "http://127.0.0.1:9/shadow-soak" })]),
			})
		);
		expect(sources?.runner).toContain("buildShadowRun");
		expect(sources?.runner).toContain("startStandingShadowTelemetry");
		expect(sources?.runner).toContain("pushMetricsOrThrow");
		expect(sources?.runner).toContain("flush");
		expect(sources?.runner).toContain("SIGTERM");
		expect(sources?.runner).not.toMatch(/report\s*:/u);
		expect(sources?.dockerfile).toContain("pnpm build:packages");
		expect(sources?.dockerfile).toContain("run-shadow-soak");
	});
});
