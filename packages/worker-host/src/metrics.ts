import { invalidOption } from "./error.js";

export const WORKER_HOST_METRIC_NAMES = Object.freeze([
	"batches-completed",
	"buffer-full-waits",
	"chunks-dropped-after-cancel",
	"items-discarded",
	"items-failed",
	"items-processed",
	"requests-dispatched",
	"requests-queued",
	"source-elements-pulled",
	"stale-messages-ignored",
] as const);

export const WORKER_HOST_TIMING_NAMES = Object.freeze([
	"batch-duration",
	"handshake-duration",
	"item-duration",
	"request-duration",
] as const);

export const WORKER_HOST_TIMING_BUCKET_BOUNDS_MS = Object.freeze([1, 4, 16, 64, 256, 1_024, 4_096] as const);

export type WorkerHostMetricName = (typeof WORKER_HOST_METRIC_NAMES)[number];
export type WorkerHostTimingName = (typeof WORKER_HOST_TIMING_NAMES)[number];

export interface WorkerHostTimingSnapshot {
	readonly count: number;
	readonly totalMs: number;
	readonly maxMs: number;
	readonly buckets: readonly number[];
}

export interface WorkerHostMetricsSnapshot {
	readonly counters: Readonly<Record<WorkerHostMetricName, number>>;
	readonly timings: Readonly<Record<WorkerHostTimingName, WorkerHostTimingSnapshot>>;
}

interface MutableTiming {
	count: number;
	totalMs: number;
	maxMs: number;
	readonly buckets: number[];
}

const METRIC_NAME_SET: ReadonlySet<string> = new Set(WORKER_HOST_METRIC_NAMES);
const TIMING_NAME_SET: ReadonlySet<string> = new Set(WORKER_HOST_TIMING_NAMES);
const MAXIMUM = Number.MAX_SAFE_INTEGER;

function saturatingAdd(left: number, right: number): number {
	return left >= MAXIMUM - right ? MAXIMUM : left + right;
}

function createCounters(): Record<WorkerHostMetricName, number> {
	return Object.fromEntries(WORKER_HOST_METRIC_NAMES.map((name) => [name, 0])) as Record<WorkerHostMetricName, number>;
}

function createTimings(): Record<WorkerHostTimingName, MutableTiming> {
	return Object.fromEntries(
		WORKER_HOST_TIMING_NAMES.map((name) => [
			name,
			{ count: 0, totalMs: 0, maxMs: 0, buckets: Array<number>(8).fill(0) },
		])
	) as Record<WorkerHostTimingName, MutableTiming>;
}

function timingBucket(milliseconds: number): number {
	for (let index = 0; index < WORKER_HOST_TIMING_BUCKET_BOUNDS_MS.length; index += 1) {
		if (milliseconds <= WORKER_HOST_TIMING_BUCKET_BOUNDS_MS[index]) return index;
	}
	return WORKER_HOST_TIMING_BUCKET_BOUNDS_MS.length;
}

function freezeSnapshot(
	counters: Readonly<Record<WorkerHostMetricName, number>>,
	timings: Readonly<Record<WorkerHostTimingName, MutableTiming>>
): WorkerHostMetricsSnapshot {
	const counterSnapshot = Object.freeze({ ...counters });
	const timingSnapshot = Object.fromEntries(
		WORKER_HOST_TIMING_NAMES.map((name) => {
			const timing = timings[name];
			return [
				name,
				Object.freeze({
					buckets: Object.freeze([...timing.buckets]),
					count: timing.count,
					maxMs: timing.maxMs,
					totalMs: timing.totalMs,
				}),
			];
		})
	) as Record<WorkerHostTimingName, WorkerHostTimingSnapshot>;
	return Object.freeze({ counters: counterSnapshot, timings: Object.freeze(timingSnapshot) });
}

/** Caller-owned fixed-cardinality counters and timing histograms. */
export class WorkerHostMetrics {
	#counters = createCounters();
	#timings = createTimings();

	/**
	 * Increments a registered counter by a nonnegative safe integer.
	 * @param name - Registered counter name.
	 * @param amount - Nonnegative safe-integer increment.
	 */
	increment(name: WorkerHostMetricName, amount = 1): void {
		if (!METRIC_NAME_SET.has(name)) throw invalidOption("metric name", name);
		if (!Number.isSafeInteger(amount) || amount < 0) throw invalidOption("metric increment", amount);
		this.#counters[name] = saturatingAdd(this.#counters[name], amount);
	}

	/**
	 * Observes a finite nonnegative millisecond duration.
	 * @param name - Registered timing name.
	 * @param milliseconds - Observed finite duration.
	 */
	observe(name: WorkerHostTimingName, milliseconds: number): void {
		if (!TIMING_NAME_SET.has(name)) throw invalidOption("timing name", name);
		if (!Number.isFinite(milliseconds) || milliseconds < 0) {
			throw invalidOption("timing value", milliseconds);
		}
		const timing = this.#timings[name];
		timing.count = saturatingAdd(timing.count, 1);
		timing.totalMs = saturatingAdd(timing.totalMs, milliseconds);
		timing.maxMs = Math.max(timing.maxMs, milliseconds);
		const bucket = timingBucket(milliseconds);
		timing.buckets[bucket] = saturatingAdd(timing.buckets[bucket], 1);
	}

	/**
	 * Returns a fresh deeply frozen copy of the current metrics.
	 * @returns An immutable fixed-cardinality snapshot.
	 */
	snapshot(): WorkerHostMetricsSnapshot {
		return freezeSnapshot(this.#counters, this.#timings);
	}

	/**
	 * Returns the current snapshot and resets every fixed metric atomically.
	 * @returns The immutable pre-reset snapshot.
	 */
	drain(): WorkerHostMetricsSnapshot {
		const snapshot = freezeSnapshot(this.#counters, this.#timings);
		this.#counters = createCounters();
		this.#timings = createTimings();
		return snapshot;
	}
}
