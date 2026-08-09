import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const ERROR_CODES = [
	"worker-host-aborted",
	"worker-host-cancelled",
	"worker-host-closed",
	"worker-host-consumer-abandoned",
	"worker-host-handshake-timeout",
	"worker-host-invalid-option",
	"worker-host-item-failed",
	"worker-host-limit-exceeded",
	"worker-host-protocol-violation",
	"worker-host-queue-overflow",
	"worker-host-source-failed",
	"worker-host-task-failed",
	"worker-host-worker-terminated",
] as const;

const METRIC_NAMES = [
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
] as const;

const TIMING_NAMES = ["batch-duration", "handshake-duration", "item-duration", "request-duration"] as const;
const TIMING_BOUNDS = [1, 4, 16, 64, 256, 1_024, 4_096] as const;
const ROOT_EXPORTS = [
	"WORKER_HOST_ERROR_CODES",
	"WORKER_HOST_METRIC_NAMES",
	"WORKER_HOST_TIMING_BUCKET_BOUNDS_MS",
	"WORKER_HOST_TIMING_NAMES",
	"WorkerHostError",
	"WorkerHostMetrics",
	"executeBounded",
	"isWorkerHostError",
] as const;

type CounterName = (typeof METRIC_NAMES)[number];
type TimingName = (typeof TIMING_NAMES)[number];
type BoundedItem<R> = Readonly<{ index: number; value: R }>;
type ExecuteOptions = Readonly<{
	batchSize?: number;
	maxBufferedResults?: number;
	maxItems?: number;
	metrics?: Metrics;
	signal?: AbortSignal;
}>;
type ExecuteBounded = <T, R>(
	source: AsyncIterable<T> | Iterable<T>,
	process: (item: T, index: number, signal: AbortSignal) => Promise<R> | R,
	options?: ExecuteOptions
) => AsyncGenerator<BoundedItem<R>, void, void>;
type Metrics = {
	drain(): unknown;
	increment(name: CounterName, amount?: number): void;
	observe(name: TimingName, milliseconds: number): void;
	snapshot(): unknown;
};
type RuntimeRoot = Partial<{
	WORKER_HOST_ERROR_CODES: readonly string[];
	WORKER_HOST_METRIC_NAMES: readonly string[];
	WORKER_HOST_TIMING_BUCKET_BOUNDS_MS: readonly number[];
	WORKER_HOST_TIMING_NAMES: readonly string[];
	WorkerHostError: new (...arguments_: unknown[]) => Error;
	WorkerHostMetrics: new () => Metrics;
	executeBounded: ExecuteBounded;
	isWorkerHostError(value: unknown): boolean;
}> &
	Record<string, unknown>;

let runtimePromise: Promise<RuntimeRoot> | undefined;
const restoreGlobals: (() => void)[] = [];

function deferred<T>(): Readonly<{
	promise: Promise<T>;
	reject(reason?: unknown): void;
	resolve(value: T): void;
}> {
	let reject!: (reason?: unknown) => void;
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		reject = rejectPromise;
		resolve = resolvePromise;
	});
	return { promise, reject, resolve };
}

async function loadRuntime(): Promise<RuntimeRoot> {
	runtimePromise ??= (async (): Promise<RuntimeRoot> => {
		const publicRoot = "@ts-drp/worker-host";
		try {
			return await vi.importActual<RuntimeRoot>(publicRoot);
		} catch {
			return {};
		}
	})();
	return runtimePromise;
}

async function runtimeExport<K extends keyof RuntimeRoot>(
	name: K,
	kind: "function" | "object"
): Promise<RuntimeRoot[K]> {
	const runtime = await loadRuntime();
	expect(runtime[name], `missing production export ${String(name)}`).toBeTypeOf(kind);
	return runtime[name];
}

async function executor(): Promise<ExecuteBounded> {
	return (await runtimeExport("executeBounded", "function")) as ExecuteBounded;
}

async function metricsConstructor(): Promise<new () => Metrics> {
	return (await runtimeExport("WorkerHostMetrics", "function")) as new () => Metrics;
}

async function collect<T>(iterator: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of iterator) values.push(value);
	return values;
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
	try {
		await operation;
	} catch (error) {
		return error;
	}
	throw new Error("expected rejection");
}

function ownRecords(value: unknown, seen = new Set<object>()): Record<string, unknown>[] {
	if (value === null || typeof value !== "object" || seen.has(value)) return [];
	seen.add(value);
	const record = value as Record<string, unknown>;
	return [record, ...Object.values(record).flatMap((child) => ownRecords(child, seen))];
}

function namedValue(snapshot: unknown, name: string): unknown {
	for (const record of ownRecords(snapshot)) {
		if (Object.hasOwn(record, name)) return record[name];
	}
	return undefined;
}

function numericArrays(value: unknown): number[][] {
	return ownRecords(value).flatMap((record) =>
		Object.values(record).filter(
			(candidate): candidate is number[] =>
				Array.isArray(candidate) && candidate.every((item) => typeof item === "number")
		)
	);
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
	if (value === null || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const child of Object.values(value)) expectDeepFrozen(child, seen);
}

function expectWorkerHostError(
	error: unknown,
	code: string,
	root: RuntimeRoot
): asserts error is Error & {
	code: string;
	detail: Readonly<Record<string, unknown>>;
	suppressed: readonly unknown[];
} {
	expect(root.isWorkerHostError?.(error)).toBe(true);
	expect(error).toBeInstanceOf(root.WorkerHostError as new (...arguments_: unknown[]) => Error);
	expect(error).toMatchObject({ code });
	const candidate = error as { detail?: unknown; suppressed?: unknown };
	expect(Object.isFrozen(candidate.detail)).toBe(true);
	expect(Object.isFrozen(candidate.suppressed)).toBe(true);
}

function replaceGlobal(name: string, value: unknown): void {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
	restoreGlobals.push(() => {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, descriptor);
	});
}

afterEach(() => {
	for (const restore of restoreGlobals.splice(0).reverse()) restore();
	vi.restoreAllMocks();
});

describe("Phase 2f-a package and public root RED", () => {
	it("is a private zero-runtime-dependency ESM package exposing only the current root", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<
			string,
			unknown
		>;
		expect(manifest).toMatchObject({ name: "@ts-drp/worker-host", private: true, type: "module" });
		expect(manifest.dependencies).toBeUndefined();
		expect(Object.keys(manifest.exports as object)).toEqual(["."]);
	});

	it("publishes the exact bounded-runtime root surface and frozen registries", async () => {
		const runtime = await loadRuntime();
		expect(Object.keys(runtime).sort()).toEqual([...ROOT_EXPORTS].sort());
		expect(runtime.WORKER_HOST_ERROR_CODES).toEqual(ERROR_CODES);
		expect(runtime.WORKER_HOST_METRIC_NAMES).toEqual(METRIC_NAMES);
		expect(runtime.WORKER_HOST_TIMING_NAMES).toEqual(TIMING_NAMES);
		expect(runtime.WORKER_HOST_TIMING_BUCKET_BOUNDS_MS).toEqual(TIMING_BOUNDS);
		for (const registry of [
			runtime.WORKER_HOST_ERROR_CODES,
			runtime.WORKER_HOST_METRIC_NAMES,
			runtime.WORKER_HOST_TIMING_NAMES,
			runtime.WORKER_HOST_TIMING_BUCKET_BOUNDS_MS,
		]) {
			expect(Object.isFrozen(registry)).toBe(true);
		}
	});

	it("does not acquire the immutable reference runtime or unrelated owners", () => {
		let source = "";
		try {
			source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
		} catch {
			// Production is intentionally absent at RED.
		}
		expect(source).not.toMatch(/ahe-reference|processInBatches|Instrumentation/u);
		expect(source).not.toMatch(/@ts-drp\/(?:application|canonical|compaction|object|protocol-v3)/u);
	});
});

describe("Phase 2f-a synchronous validation and error taxonomy RED", () => {
	it("rejects every invalid numeric option synchronously before pulling the source", async () => {
		const executeBounded = await executor();
		const root = await loadRuntime();
		const invalid = {
			batchSize: [0, -1, 1.5, 4_097, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53],
			maxBufferedResults: [0, -1, 1.5, 1_025, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53],
			maxItems: [0, -1, 1.5, 1_048_577, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53],
		} as const;
		for (const [name, values] of Object.entries(invalid)) {
			for (const value of values) {
				let pulls = 0;
				const source = {
					*[Symbol.iterator](): Iterator<number> {
						pulls += 1;
						yield 1;
					},
				};
				let error: unknown;
				try {
					executeBounded(source, (item) => item, { [name]: value });
				} catch (caught) {
					error = caught;
				}
				expectWorkerHostError(error, "worker-host-invalid-option", root);
				expect(pulls).toBe(0);
			}
		}
	});

	it("accepts exact option boundaries and default maxItems", async () => {
		const executeBounded = await executor();
		await expect(
			collect(executeBounded([1], (item) => item, { batchSize: 4_096, maxBufferedResults: 1_024, maxItems: 1 }))
		).resolves.toEqual([{ index: 0, value: 1 }]);
		expect(() => executeBounded([], (item) => item)).not.toThrow();
	});

	it("brands only closed worker-host errors without weakening the DRP brand", async () => {
		const executeBounded = await executor();
		const root = await loadRuntime();
		const error = ((): unknown => {
			try {
				return executeBounded([], (item) => item, { batchSize: 0 });
			} catch (caught) {
				return caught;
			}
		})();
		expectWorkerHostError(error, "worker-host-invalid-option", root);
		expect(root.isWorkerHostError?.({ code: "worker-host-invalid-option" })).toBe(false);
		expect(
			root.isWorkerHostError?.({
				[Symbol.for("@ts-drp/worker-host/WorkerHostError")]: true,
				code: "not-registered",
			})
		).toBe(false);
		expect(Symbol.for("@ts-drp/worker-host/WorkerHostError") in (error as object)).toBe(true);
		expect(Symbol.for("@ts-drp/errors/DRPError") in (error as object)).toBe(false);
	});
});

describe("Phase 2f-a ordered bounded execution RED", () => {
	it("prefers an async source, preserves promise-valued elements, and permits one processor in flight", async () => {
		const executeBounded = await executor();
		let inFlight = 0;
		let maximumInFlight = 0;
		let asyncIndex = 0;
		const promised = [Promise.resolve(7), Promise.resolve(8)];
		const source = {
			[Symbol.asyncIterator](): AsyncIterator<Promise<number>> {
				return {
					next: () =>
						Promise.resolve(
							asyncIndex < promised.length
								? { done: false as const, value: promised[asyncIndex++] as Promise<number> }
								: { done: true as const, value: undefined }
						),
				};
			},
			*[Symbol.iterator](): Iterator<Promise<number>> {
				yield Promise.resolve(99);
			},
		};
		const results = await collect(
			executeBounded(source, async (item, index) => {
				inFlight += 1;
				maximumInFlight = Math.max(maximumInFlight, inFlight);
				const wasPromise = item instanceof Promise;
				const value = await item;
				await Promise.resolve();
				inFlight -= 1;
				return `${index}:${value}:${wasPromise}`;
			})
		);
		expect(results).toEqual([
			{ index: 0, value: "0:7:true" },
			{ index: 1, value: "1:8:true" },
		]);
		expect(maximumInFlight).toBe(1);
	});

	it("drains 10,000 ordered results without returning a completed result array", async () => {
		const executeBounded = await executor();
		let yielded = 0;
		const stream = executeBounded(
			Array.from({ length: 10_000 }, (_, index) => index),
			(item, index) => item ^ index,
			{ batchSize: 4_096, maxBufferedResults: 7, maxItems: 10_000 }
		);
		expect(typeof stream[Symbol.asyncIterator]).toBe("function");
		for await (const result of stream) {
			expect(result).toEqual({ index: yielded, value: 0 });
			yielded += 1;
		}
		expect(yielded).toBe(10_000);
	});

	it("observably stops pulling when the FIFO result bound is full", async () => {
		const executeBounded = await executor();
		const Metrics = await metricsConstructor();
		const metrics = new Metrics();
		let pulls = 0;
		function* source(): Generator<number> {
			for (let index = 0; index < 20; index += 1) {
				pulls += 1;
				yield index;
			}
		}
		const stream = executeBounded(source(), (item) => item, { maxBufferedResults: 2, metrics });
		expect(await stream.next()).toEqual({ done: false, value: { index: 0, value: 0 } });
		await vi.waitFor(() => expect(pulls).toBe(3));
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(pulls).toBe(3);
		expect(await stream.next()).toEqual({ done: false, value: { index: 1, value: 1 } });
		await vi.waitFor(() => expect(pulls).toBe(4));
		await stream.return();
		expect(namedValue(metrics.snapshot(), "buffer-full-waits")).toBeGreaterThan(0);
	});

	it("enforces maxItems before processing the first excess element", async () => {
		const executeBounded = await executor();
		const root = await loadRuntime();
		let processed = 0;
		let closed = false;
		function* source(): Generator<number> {
			try {
				yield 1;
				yield 2;
				yield 3;
			} finally {
				closed = true;
			}
		}
		const stream = executeBounded(
			source(),
			(item) => {
				processed += 1;
				return item;
			},
			{ maxItems: 2 }
		);
		const values: BoundedItem<number>[] = [];
		let error: unknown;
		try {
			for await (const value of stream) values.push(value);
		} catch (caught) {
			error = caught;
		}
		expect(values).toEqual([
			{ index: 0, value: 1 },
			{ index: 1, value: 2 },
		]);
		expect(processed).toBe(2);
		expect(closed).toBe(true);
		expectWorkerHostError(error, "worker-host-limit-exceeded", root);
	});
});

describe("Phase 2f-a cooperative scheduling RED", () => {
	it("yields after each full batch and before the next source pull", async () => {
		const executeBounded = await executor();
		const releaseYield = deferred<undefined>();
		const schedulerYield = vi.fn(() => releaseYield.promise);
		replaceGlobal("scheduler", { yield: schedulerYield });
		let pulls = 0;
		function* source(): Generator<number> {
			for (let index = 0; index < 3; index += 1) {
				pulls += 1;
				yield index;
			}
		}
		const stream = executeBounded(source(), (item) => item, { batchSize: 2, maxBufferedResults: 3 });
		await stream.next();
		await vi.waitFor(() => expect(schedulerYield).toHaveBeenCalledOnce());
		expect(pulls).toBe(2);
		releaseYield.resolve(undefined);
		await vi.waitFor(() => expect(pulls).toBe(3));
		await collect(stream);
	});

	it("uses background postTask only when scheduler.yield is unavailable", async () => {
		const executeBounded = await executor();
		const postTask = vi.fn(async (callback: () => void, options: { priority: string }) => {
			await Promise.resolve();
			expect(options).toEqual({ priority: "background" });
			callback();
		});
		replaceGlobal("scheduler", { postTask });
		await collect(executeBounded([1, 2], (item) => item, { batchSize: 1 }));
		expect(postTask).toHaveBeenCalledTimes(2);
	});

	it("falls back to zero-delay setTimeout when the scheduler is unavailable", async () => {
		const executeBounded = await executor();
		replaceGlobal("scheduler", undefined);
		const timeout = vi.spyOn(globalThis, "setTimeout");
		await collect(executeBounded([1, 2], (item) => item, { batchSize: 1 }));
		expect(timeout.mock.calls.filter((call) => call[1] === 0)).toHaveLength(2);
	});

	it("checks cancellation after a cooperative yield before another pull", async () => {
		const executeBounded = await executor();
		const root = await loadRuntime();
		const controller = new AbortController();
		const releaseYield = deferred<undefined>();
		const schedulerYield = vi.fn(() => releaseYield.promise);
		replaceGlobal("scheduler", { yield: schedulerYield });
		let pulls = 0;
		function* source(): Generator<number> {
			for (let index = 0; index < 2; index += 1) {
				pulls += 1;
				yield index;
			}
		}
		const stream = executeBounded(source(), (item) => item, { batchSize: 1, signal: controller.signal });
		expect(await stream.next()).toEqual({ done: false, value: { index: 0, value: 0 } });
		await vi.waitFor(() => expect(schedulerYield).toHaveBeenCalledOnce());
		controller.abort("yield-stop");
		releaseYield.resolve(undefined);
		const error = await rejection(stream.next());
		expectWorkerHostError(error, "worker-host-aborted", root);
		expect(pulls).toBe(1);
	});
});

describe("Phase 2f-a cancellation, failure, and abandonment RED", () => {
	it("checks cancellation before pull and after pull before processing", async () => {
		const executeBounded = await executor();
		const root = await loadRuntime();
		const preAborted = new AbortController();
		preAborted.abort("pre-abort");
		let prePulls = 0;
		const preSource = {
			*[Symbol.iterator](): Iterator<number> {
				prePulls += 1;
				yield 1;
			},
		};
		const preError = await rejection(executeBounded(preSource, (item) => item, { signal: preAborted.signal }).next());
		expectWorkerHostError(preError, "worker-host-aborted", root);
		expect(prePulls).toBe(0);

		const duringPull = new AbortController();
		const processor = vi.fn((item: number) => item);
		let pulls = 0;
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator]: () => ({
				next: (): Promise<IteratorResult<number>> => {
					pulls += 1;
					duringPull.abort("pull-abort");
					return Promise.resolve({ done: false as const, value: 1 });
				},
			}),
		};
		const pullError = await rejection(executeBounded(source, processor, { signal: duringPull.signal }).next());
		expectWorkerHostError(pullError, "worker-host-aborted", root);
		expect(pulls).toBe(1);
		expect(processor).not.toHaveBeenCalled();
	});

	it("uses a linked signal and checks caller cancellation around every item", async () => {
		const executeBounded = await executor();
		const root = await loadRuntime();
		const controller = new AbortController();
		const work = deferred<number>();
		let linkedSignal: AbortSignal | undefined;
		const stream = executeBounded(
			[1, 2],
			(_item, _index, signal) => {
				linkedSignal = signal;
				return work.promise;
			},
			{ signal: controller.signal }
		);
		const pending = stream.next();
		await vi.waitFor(() => expect(linkedSignal).toBeDefined());
		expect(linkedSignal).not.toBe(controller.signal);
		controller.abort("caller-stop");
		expect(linkedSignal?.aborted).toBe(true);
		work.resolve(1);
		const error = await rejection(pending);
		expectWorkerHostError(error, "worker-host-aborted", root);
		expect(linkedSignal?.reason).toBe("caller-stop");
	});

	it("discards the current result and starts no next item when aborted during processing", async () => {
		const executeBounded = await executor();
		const root = await loadRuntime();
		const Metrics = await metricsConstructor();
		const metrics = new Metrics();
		const controller = new AbortController();
		const indexes: number[] = [];
		const stream = executeBounded(
			[1, 2],
			(item, index) => {
				indexes.push(index);
				controller.abort("between-items");
				return item;
			},
			{ metrics, signal: controller.signal }
		);
		const error = await rejection(stream.next());
		expectWorkerHostError(error, "worker-host-aborted", root);
		expect(indexes).toEqual([0]);
		expect(namedValue(metrics.snapshot(), "items-discarded")).toBe(1);
	});

	it("wakes a full-buffer wait on cancellation and discards buffered work without another pull", async () => {
		const executeBounded = await executor();
		const root = await loadRuntime();
		const Metrics = await metricsConstructor();
		const metrics = new Metrics();
		const controller = new AbortController();
		let pulls = 0;
		function* source(): Generator<number> {
			for (let index = 0; index < 4; index += 1) {
				pulls += 1;
				yield index;
			}
		}
		const stream = executeBounded(source(), (item) => item, {
			maxBufferedResults: 1,
			metrics,
			signal: controller.signal,
		});
		expect(await stream.next()).toEqual({ done: false, value: { index: 0, value: 0 } });
		await vi.waitFor(() => expect(pulls).toBe(2));
		controller.abort("buffer-stop");
		const error = await rejection(stream.next());
		expectWorkerHostError(error, "worker-host-aborted", root);
		expect(pulls).toBe(2);
		expect(namedValue(metrics.snapshot(), "items-discarded")).toBeGreaterThanOrEqual(1);
	});

	it("gives same-turn external abort precedence and suppresses the item failure", async () => {
		const executeBounded = await executor();
		const root = await loadRuntime();
		const controller = new AbortController();
		const work = deferred<number>();
		const itemFailure = new Error("item failed in abort turn");
		const pending = executeBounded([1], () => work.promise, { signal: controller.signal }).next();
		await Promise.resolve();
		controller.abort("cancel-first");
		work.reject(itemFailure);
		const error = await rejection(pending);
		expectWorkerHostError(error, "worker-host-aborted", root);
		expect((error as { suppressed: readonly unknown[] }).suppressed).toContain(itemFailure);
	});

	it("gives same-turn external abort precedence and suppresses the source failure", async () => {
		const executeBounded = await executor();
		const root = await loadRuntime();
		const controller = new AbortController();
		const nextCalled = deferred<undefined>();
		const sourceNext = deferred<IteratorResult<number>>();
		const sourceFailure = new Error("source failed in abort turn");
		const processor = vi.fn((item: number) => item);
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator]: () => ({
				next: (): Promise<IteratorResult<number>> => {
					nextCalled.resolve(undefined);
					return sourceNext.promise;
				},
			}),
		};
		const pending = executeBounded(source, processor, { signal: controller.signal }).next();
		await nextCalled.promise;
		controller.abort("cancel-source-first");
		sourceNext.reject(sourceFailure);
		const error = await rejection(pending);
		expectWorkerHostError(error, "worker-host-aborted", root);
		expect((error as { suppressed: readonly unknown[] }).suppressed).toContain(sourceFailure);
		expect(processor).not.toHaveBeenCalled();
	});

	it("maps sync/async source and processor failures to the closed taxonomy with causes", async () => {
		const executeBounded = await executor();
		const root = await loadRuntime();
		const failures = [
			{
				code: "worker-host-source-failed",
				cause: new Error("sync source"),
				run(cause: Error): Promise<unknown> {
					const source = {
						[Symbol.iterator]: () => ({
							next: (): IteratorResult<number> => {
								throw cause;
							},
						}),
					} as Iterable<number>;
					return executeBounded(source, (item) => item).next();
				},
			},
			{
				code: "worker-host-source-failed",
				cause: new Error("async source"),
				run(cause: Error): Promise<unknown> {
					const source = {
						[Symbol.asyncIterator]: () => ({
							next: (): Promise<IteratorResult<number>> => Promise.reject(cause),
						}),
					} as AsyncIterable<number>;
					return executeBounded(source, (item) => item).next();
				},
			},
			{
				code: "worker-host-item-failed",
				cause: new Error("processor"),
				run(cause: Error): Promise<unknown> {
					return executeBounded([1], () => {
						throw cause;
					}).next();
				},
			},
		] as const;
		for (const fixture of failures) {
			const error = await rejection(fixture.run(fixture.cause));
			expectWorkerHostError(error, fixture.code, root);
			expect((error as Error).cause).toBe(fixture.cause);
		}
	});

	it("accounts for item failure without publishing a successful item", async () => {
		const executeBounded = await executor();
		const Metrics = await metricsConstructor();
		const metrics = new Metrics();
		await expect(
			collect(executeBounded([1], () => Promise.reject(new Error("no item")), { metrics }))
		).rejects.toThrow();
		const snapshot = metrics.snapshot();
		expect(namedValue(snapshot, "source-elements-pulled")).toBe(1);
		expect(namedValue(snapshot, "items-failed")).toBe(1);
		expect(namedValue(snapshot, "items-processed")).toBe(0);
	});

	it("abandons without a second consumer error, aborts linked work, and awaits processor/source cleanup", async () => {
		const executeBounded = await executor();
		const secondWork = deferred<number>();
		const sourceReturned = deferred<undefined>();
		const sourceReturn = vi.fn(async () => {
			await Promise.resolve();
			sourceReturned.resolve(undefined);
			return { done: true as const, value: undefined };
		});
		let nextIndex = 0;
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator]: () => ({
				next: () => Promise.resolve({ done: false as const, value: nextIndex++ }),
				return: sourceReturn,
			}),
		};
		let linkedSignal: AbortSignal | undefined;
		const stream = executeBounded(
			source,
			(item, index, signal) => {
				linkedSignal = signal;
				return index === 0 ? item : secondWork.promise;
			},
			{ maxBufferedResults: 1 }
		);
		expect(await stream.next()).toEqual({ done: false, value: { index: 0, value: 0 } });
		await vi.waitFor(() => expect(nextIndex).toBe(2));
		const abandoned = stream.return();
		await sourceReturned.promise;
		expect(linkedSignal?.aborted).toBe(true);
		let settled = false;
		void abandoned.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		secondWork.resolve(1);
		await expect(abandoned).resolves.toEqual({ done: true, value: undefined });
		expect(sourceReturn).toHaveBeenCalledOnce();
	});
});

describe("Phase 2f-a caller-owned fixed telemetry RED", () => {
	it("keeps exact frozen registries, rejects invalid names/values, and isolates owners", async () => {
		const Metrics = await metricsConstructor();
		const root = await loadRuntime();
		const first = new Metrics();
		const second = new Metrics();
		const initial = first.snapshot();
		for (const name of METRIC_NAMES) expect(namedValue(initial, name)).toBe(0);
		for (const name of TIMING_NAMES) expect(namedValue(initial, name)).toBeDefined();
		for (const operation of [
			(): void => first.increment("unknown" as CounterName),
			(): void => first.increment("items-processed", -1),
			(): void => first.increment("items-processed", 1.5),
			(): void => first.increment("items-processed", Number.NaN),
			(): void => first.increment("items-processed", Number.POSITIVE_INFINITY),
			(): void => first.increment("items-processed", Number.MAX_SAFE_INTEGER + 1),
			(): void => first.observe("unknown" as TimingName, 1),
			(): void => first.observe("item-duration", -1),
			(): void => first.observe("item-duration", Number.NaN),
			(): void => first.observe("item-duration", Number.POSITIVE_INFINITY),
		]) {
			let error: unknown;
			try {
				operation();
			} catch (caught) {
				error = caught;
			}
			expectWorkerHostError(error, "worker-host-invalid-option", root);
		}
		first.increment("items-processed", 2);
		expect(namedValue(first.snapshot(), "items-processed")).toBe(2);
		expect(namedValue(second.snapshot(), "items-processed")).toBe(0);
		second.increment("items-processed");
		expect(namedValue(second.snapshot(), "items-processed")).toBe(1);
	});

	it("saturates counts/totals and uses upper-inclusive fixed histogram buckets plus overflow", async () => {
		const Metrics = await metricsConstructor();
		const metrics = new Metrics();
		metrics.increment("items-processed", Number.MAX_SAFE_INTEGER);
		metrics.increment("items-processed", 10);
		expect(namedValue(metrics.snapshot(), "items-processed")).toBe(Number.MAX_SAFE_INTEGER);
		for (const value of [
			1, 1.001, 4, 4.001, 16, 16.001, 64, 64.001, 256, 256.001, 1_024, 1_024.001, 4_096, 4_096.001,
		]) {
			metrics.observe("item-duration", value);
		}
		const timing = namedValue(metrics.snapshot(), "item-duration");
		expect(timing).toBeDefined();
		expect(numericArrays(timing)).toContainEqual([1, 2, 2, 2, 2, 2, 2, 1]);
		metrics.observe("item-duration", Number.MAX_SAFE_INTEGER);
		metrics.observe("item-duration", Number.MAX_SAFE_INTEGER);
		const saturatedLeaves = ownRecords(namedValue(metrics.snapshot(), "item-duration"))
			.flatMap(Object.values)
			.filter((value): value is number => typeof value === "number");
		expect(saturatedLeaves.filter((value) => value === Number.MAX_SAFE_INTEGER).length).toBeGreaterThanOrEqual(2);
	});

	it("returns fresh deeply frozen bounded snapshots and atomically drains to zero", async () => {
		const Metrics = await metricsConstructor();
		const metrics = new Metrics();
		metrics.increment("source-elements-pulled", 3);
		for (let index = 0; index < 10_000; index += 1) metrics.observe("item-duration", index % 17);
		const first = metrics.snapshot();
		const second = metrics.snapshot();
		expect(first).not.toBe(second);
		expectDeepFrozen(first);
		expectDeepFrozen(second);
		expect(JSON.stringify(first).length).toBeLessThan(10_000);
		const drained = metrics.drain();
		expect(namedValue(drained, "source-elements-pulled")).toBe(3);
		const empty = metrics.snapshot();
		expect(namedValue(empty, "source-elements-pulled")).toBe(0);
		const remainingNumbers = ownRecords(empty)
			.flatMap((record) => [...Object.values(record), ...numericArrays(record).flat()])
			.filter((value): value is number => typeof value === "number");
		expect(
			remainingNumbers.every((value) => value === 0 || TIMING_BOUNDS.includes(value as (typeof TIMING_BOUNDS)[number]))
		).toBe(true);
	});

	it("records executor counters only in the explicitly supplied owner", async () => {
		const executeBounded = await executor();
		const Metrics = await metricsConstructor();
		const metrics = new Metrics();
		await collect(executeBounded([1, 2, 3], (item) => item, { batchSize: 2, metrics }));
		const snapshot = metrics.snapshot();
		expect(namedValue(snapshot, "source-elements-pulled")).toBe(3);
		expect(namedValue(snapshot, "items-processed")).toBe(3);
		expect(namedValue(snapshot, "batches-completed")).toBe(1);
		expect(namedValue(snapshot, "item-duration")).toBeDefined();
	});

	it("clamps regressing internal item and batch clock deltas to zero", async () => {
		const executeBounded = await executor();
		const Metrics = await metricsConstructor();
		const now = vi
			.fn()
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(80)
			.mockReturnValueOnce(10)
			.mockReturnValueOnce(5)
			.mockReturnValue(0);
		replaceGlobal("performance", { now });
		replaceGlobal("scheduler", { yield: () => Promise.resolve() });
		const metrics = new Metrics();

		await expect(
			collect(executeBounded(["item"], (item, index) => `${index}:${item}`, { batchSize: 1, metrics }))
		).resolves.toEqual([{ index: 0, value: "0:item" }]);
		const snapshot = metrics.snapshot() as {
			readonly timings: Readonly<
				Record<TimingName, Readonly<{ buckets: readonly number[]; count: number; maxMs: number; totalMs: number }>>
			>;
		};
		for (const name of ["item-duration", "batch-duration"] as const) {
			expect(snapshot.timings[name]).toMatchObject({ count: 1, maxMs: 0, totalMs: 0 });
			expect(snapshot.timings[name].buckets[0]).toBe(1);
		}
	});
});

describe("Phase 2f-a causal mutant and harness controls", () => {
	async function probeEarlyStreaming(candidate: ExecuteBounded): Promise<void> {
		const releaseTail = deferred<undefined>();
		async function* source(): AsyncGenerator<number> {
			yield 1;
			await releaseTail.promise;
			yield 2;
		}
		const stream = candidate(source(), (item) => item, { maxBufferedResults: 1 });
		try {
			await expect(stream.next()).resolves.toEqual({ done: false, value: { index: 0, value: 1 } });
		} finally {
			releaseTail.resolve(undefined);
			await stream.return?.();
		}
	}

	it("accepts a genuinely streaming control and kills the immutable runtime's collect-all defect", async () => {
		const control: ExecuteBounded = <T, R>(
			source: AsyncIterable<T> | Iterable<T>,
			process: (item: T, index: number, signal: AbortSignal) => Promise<R> | R
		): AsyncGenerator<BoundedItem<R>, void, void> =>
			(async function* (): AsyncGenerator<BoundedItem<R>, void, void> {
				let index = 0;
				for await (const item of source) {
					yield { index, value: await process(item, index, new AbortController().signal) };
					index += 1;
				}
			})();
		await expect(probeEarlyStreaming(control)).resolves.toBeUndefined();

		const collectAllMutant = (<T, R>(
			source: AsyncIterable<T> | Iterable<T>,
			process: (item: T, index: number, signal: AbortSignal) => Promise<R> | R
		): unknown =>
			(async (): Promise<BoundedItem<R>[]> => {
				const results: BoundedItem<R>[] = [];
				let index = 0;
				for await (const item of source) {
					results.push({ index, value: await process(item, index, new AbortController().signal) });
					index += 1;
				}
				return results;
			})()) as ExecuteBounded;
		await expect(probeEarlyStreaming(collectAllMutant)).rejects.toThrow();
	});

	it("kills batch-zero deferred validation and caller-signal reuse mutants without hanging", async () => {
		const deferredValidationMutant = (<T, R>(
			source: AsyncIterable<T> | Iterable<T>,
			process: (item: T, index: number, signal: AbortSignal) => Promise<R> | R
		): AsyncGenerator<BoundedItem<R>, void, void> =>
			(async function* (): AsyncGenerator<BoundedItem<R>, void, void> {
				let index = 0;
				for await (const item of source) {
					yield { index, value: await process(item, index, new AbortController().signal) };
					index += 1;
				}
			})()) as ExecuteBounded;
		expect(() => deferredValidationMutant([1], (item) => item, { batchSize: 0 })).not.toThrow();
		// The production assertion is the inverse, so this mutant is killed before
		// the historical zero-step loop can monopolize the test process.

		const caller = new AbortController();
		let observed: AbortSignal | undefined;
		const callerSignalReuseMutant: ExecuteBounded = <T, R>(
			source: AsyncIterable<T> | Iterable<T>,
			process: (item: T, index: number, signal: AbortSignal) => Promise<R> | R,
			options?: ExecuteOptions
		): AsyncGenerator<BoundedItem<R>, void, void> =>
			(async function* (): AsyncGenerator<BoundedItem<R>, void, void> {
				let index = 0;
				for await (const item of source) {
					const signal = options?.signal ?? new AbortController().signal;
					yield { index, value: await process(item, index, signal) };
					index += 1;
				}
			})();
		await callerSignalReuseMutant(
			[1],
			(_item, _index, signal) => {
				observed = signal;
				return 1;
			},
			{ signal: caller.signal }
		).next();
		expect(observed).toBe(caller.signal);
	});

	it("kills unbounded metric cardinality and retained raw-timing-sample mutants", () => {
		class LegacyInstrumentationMutant {
			readonly counters = new Map<string, number>();
			readonly timings = new Map<string, number[]>();

			increment(name: string, amount = 1): void {
				this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
			}

			observe(name: string, value: number): void {
				const values = this.timings.get(name) ?? [];
				values.push(value);
				this.timings.set(name, values);
			}
		}

		const mutant = new LegacyInstrumentationMutant();
		mutant.increment("attacker-cardinality");
		for (let index = 0; index < 10_000; index += 1) mutant.observe("item-duration", index);
		expect(() => mutant.increment("attacker-cardinality")).not.toThrow();
		expect(mutant.counters.has("attacker-cardinality")).toBe(true);
		expect(mutant.timings.get("item-duration")).toHaveLength(10_000);
		// The production telemetry assertions require rejection, fixed registries,
		// saturation, and a bounded histogram snapshot, so each defect is causal.
	});
});
