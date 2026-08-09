import { invalidOption, isWorkerHostError, WorkerHostError } from "./error.js";
import { WorkerHostMetrics } from "./metrics.js";
import { ResultRingBuffer } from "./ring-buffer.js";

export type BoundedProcessor<T, R> = (item: T, index: number, signal: AbortSignal) => R | Promise<R>;

export interface BoundedItem<R> {
	readonly index: number;
	readonly value: R;
}

export interface BoundedExecutionOptions {
	readonly batchSize?: number;
	readonly maxBufferedResults?: number;
	readonly maxItems?: number;
	readonly metrics?: WorkerHostMetrics;
	readonly signal?: AbortSignal;
}

interface ResolvedOptions {
	readonly batchSize: number;
	readonly maxBufferedResults: number;
	readonly maxItems: number;
	readonly metrics: WorkerHostMetrics | undefined;
	readonly signal: AbortSignal | undefined;
}

interface SchedulerLike {
	postTask?(callback: () => void, options: Readonly<{ priority: "background" }>): Promise<unknown>;
	yield?(): Promise<unknown>;
}

const DEFAULT_BATCH_SIZE = 256;
const DEFAULT_BUFFERED_RESULTS = 64;
const MAXIMUM_ITEMS = 1_048_576;

function boundedInteger(name: string, value: number | undefined, fallback: number, maximum: number): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) throw invalidOption(name, resolved);
	return resolved;
}

function isAbortSignal(value: unknown): value is AbortSignal {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as AbortSignal).aborted === "boolean" &&
		typeof (value as AbortSignal).addEventListener === "function" &&
		typeof (value as AbortSignal).removeEventListener === "function"
	);
}

function resolveOptions(options: BoundedExecutionOptions | undefined): ResolvedOptions {
	if (options !== undefined && (typeof options !== "object" || options === null)) {
		throw invalidOption("options", options);
	}
	const signal = options?.signal;
	if (signal !== undefined && !isAbortSignal(signal)) throw invalidOption("signal", signal);
	const metrics = options?.metrics;
	if (metrics !== undefined && !(metrics instanceof WorkerHostMetrics)) throw invalidOption("metrics", metrics);
	return {
		batchSize: boundedInteger("batchSize", options?.batchSize, DEFAULT_BATCH_SIZE, 4_096),
		maxBufferedResults: boundedInteger(
			"maxBufferedResults",
			options?.maxBufferedResults,
			DEFAULT_BUFFERED_RESULTS,
			1_024
		),
		maxItems: boundedInteger("maxItems", options?.maxItems, MAXIMUM_ITEMS, MAXIMUM_ITEMS),
		metrics,
		signal,
	};
}

function validateSource<T>(source: AsyncIterable<T> | Iterable<T>): void {
	if ((typeof source !== "object" && typeof source !== "function" && typeof source !== "string") || source === null) {
		throw invalidOption("source", source);
	}
	const candidate = source as Partial<AsyncIterable<T> & Iterable<T>>;
	if (typeof candidate[Symbol.asyncIterator] !== "function" && typeof candidate[Symbol.iterator] !== "function") {
		throw invalidOption("source", source);
	}
}

function sourceIterator<T>(source: AsyncIterable<T> | Iterable<T>): AsyncIterator<T> | Iterator<T> {
	const candidate = source as Partial<AsyncIterable<T> & Iterable<T>>;
	const asyncIterator = candidate[Symbol.asyncIterator];
	if (typeof asyncIterator === "function") return asyncIterator.call(candidate);
	return (candidate as Iterable<T>)[Symbol.iterator]();
}

function nowMilliseconds(): number {
	return typeof performance === "undefined" ? Date.now() : performance.now();
}

function elapsedMilliseconds(startedAt: number): number {
	return Math.max(0, nowMilliseconds() - startedAt);
}

async function cooperativeYield(): Promise<void> {
	const scheduler = (globalThis as typeof globalThis & { scheduler?: SchedulerLike }).scheduler;
	if (typeof scheduler?.yield === "function") {
		await scheduler.yield();
		return;
	}
	if (typeof scheduler?.postTask === "function") {
		const postTask = scheduler.postTask.bind(scheduler);
		await new Promise<void>((resolve, reject) => {
			try {
				void postTask(resolve, { priority: "background" }).catch(reject);
			} catch (error) {
				reject(error);
			}
		});
		return;
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function abortError(reason: unknown, suppressed: readonly unknown[] = []): WorkerHostError {
	return new WorkerHostError("worker-host-aborted", "Bounded execution aborted", {
		detail: { reason },
		suppressed,
	});
}

function failureError(
	code: "worker-host-item-failed" | "worker-host-source-failed",
	cause: unknown,
	detail: Readonly<Record<string, unknown>> = {}
): WorkerHostError {
	return new WorkerHostError(code, code === "worker-host-item-failed" ? "Item processing failed" : "Source failed", {
		cause,
		detail,
	});
}

function appendSuppressed(error: WorkerHostError, suppressed: unknown): WorkerHostError {
	return new WorkerHostError(error.code, error.message, {
		cause: error.cause,
		detail: error.detail,
		suppressed: [...error.suppressed, suppressed],
	});
}

function incrementDiscarded(metrics: WorkerHostMetrics | undefined, amount: number): void {
	if (amount > 0) metrics?.increment("items-discarded", amount);
}

/**
 * Streams ordered processed results through one bounded producer lifecycle.
 * @param source - Preferred async or fallback synchronous input source.
 * @param process - Sole in-flight item processor.
 * @param options - Validated bounds, cancellation, and optional telemetry owner.
 * @returns An ordered bounded async result stream.
 */
export function executeBounded<T, R>(
	source: AsyncIterable<T> | Iterable<T>,
	process: BoundedProcessor<T, R>,
	options?: BoundedExecutionOptions
): AsyncGenerator<BoundedItem<R>, void, void> {
	validateSource(source);
	if (typeof process !== "function") throw invalidOption("processor", process);
	const resolved = resolveOptions(options);

	return (async function* (): AsyncGenerator<BoundedItem<R>, void, void> {
		const linkedController = new AbortController();
		const queue = new ResultRingBuffer<BoundedItem<R>>(resolved.maxBufferedResults, resolved.metrics);
		let iterator: AsyncIterator<T> | Iterator<T> | undefined;
		let sourceFinished = false;
		let sourceClosePromise: Promise<void> | undefined;
		let callerAborted = resolved.signal?.aborted ?? false;
		let callerAbortReason = resolved.signal?.reason;
		let abandoned = false;
		let producerSettled = false;
		let terminalObserved = false;
		const closeSource = (): Promise<void> => {
			if (sourceFinished || iterator === undefined) return Promise.resolve();
			const activeIterator = iterator;
			sourceClosePromise ??= Promise.resolve().then(() => {
				if (sourceFinished) return;
				const returnSource: unknown = activeIterator.return;
				if (typeof returnSource !== "function") return;
				const callable = returnSource as (this: typeof activeIterator) => unknown;
				return Promise.resolve(callable.call(activeIterator)).then(() => undefined);
			});
			return sourceClosePromise;
		};
		const onCallerAbort = (): void => {
			callerAborted = true;
			callerAbortReason = resolved.signal?.reason;
			if (!linkedController.signal.aborted) linkedController.abort(callerAbortReason);
			if (producerSettled) {
				incrementDiscarded(resolved.metrics, queue.abort(abortError(callerAbortReason)));
			} else {
				incrementDiscarded(resolved.metrics, queue.discard());
			}
			void closeSource().catch(() => undefined);
		};
		resolved.signal?.addEventListener("abort", onCallerAbort, { once: true });
		if (callerAborted && !linkedController.signal.aborted) linkedController.abort(callerAbortReason);

		const producer = (async (): Promise<void> => {
			let failure: WorkerHostError | undefined;
			let rawFailure: unknown;
			let index = 0;
			let batchStartedAt = nowMilliseconds();
			try {
				if (callerAborted) throw abortError(callerAbortReason);
				try {
					iterator = sourceIterator(source);
				} catch (error) {
					rawFailure = error;
					throw failureError("worker-host-source-failed", error);
				}
				while (true) {
					const capacity = queue.waitForCapacity(linkedController.signal);
					if (capacity !== undefined && !(await capacity)) {
						if (abandoned) break;
						if (callerAborted) throw abortError(callerAbortReason);
					}
					if (abandoned) break;
					if (callerAborted) throw abortError(callerAbortReason);
					if (index > 0 && index % resolved.batchSize === 0) {
						resolved.metrics?.increment("batches-completed");
						resolved.metrics?.observe("batch-duration", elapsedMilliseconds(batchStartedAt));
						try {
							await cooperativeYield();
						} catch (error) {
							rawFailure = error;
							throw new WorkerHostError("worker-host-task-failed", "Cooperative scheduling failed", {
								cause: error,
							});
						}
						if (callerAborted) throw abortError(callerAbortReason, rawFailure === undefined ? [] : [rawFailure]);
						if (abandoned) break;
						batchStartedAt = nowMilliseconds();
					}

					let next: IteratorResult<T>;
					try {
						next = await iterator.next();
					} catch (error) {
						rawFailure = error;
						if (callerAborted) throw abortError(callerAbortReason, [error]);
						throw failureError("worker-host-source-failed", error);
					}
					if (callerAborted) throw abortError(callerAbortReason);
					if (abandoned) break;
					if (next.done === true) {
						sourceFinished = true;
						break;
					}
					resolved.metrics?.increment("source-elements-pulled");
					if (index >= resolved.maxItems) {
						throw new WorkerHostError("worker-host-limit-exceeded", "Maximum item count exceeded", {
							detail: { maxItems: resolved.maxItems },
						});
					}
					if (callerAborted) throw abortError(callerAbortReason);

					const itemStartedAt = nowMilliseconds();
					let value: R;
					try {
						value = await process(next.value, index, linkedController.signal);
					} catch (error) {
						resolved.metrics?.increment("items-failed");
						resolved.metrics?.observe("item-duration", elapsedMilliseconds(itemStartedAt));
						rawFailure = error;
						if (callerAborted) throw abortError(callerAbortReason, [error]);
						throw failureError("worker-host-item-failed", error, { index });
					}
					resolved.metrics?.observe("item-duration", elapsedMilliseconds(itemStartedAt));
					if (callerAborted) {
						resolved.metrics?.increment("items-discarded");
						throw abortError(callerAbortReason);
					}
					if (abandoned) {
						resolved.metrics?.increment("items-discarded");
						break;
					}

					const enqueued = await queue.enqueue({ index, value }, linkedController.signal);
					if (!enqueued) {
						resolved.metrics?.increment("items-discarded");
						if (abandoned) break;
						if (callerAborted) throw abortError(callerAbortReason);
						throw new WorkerHostError("worker-host-closed", "Bounded execution queue closed");
					}
					resolved.metrics?.increment("items-processed");
					index += 1;
				}
			} catch (error) {
				failure = isWorkerHostError(error)
					? error
					: new WorkerHostError("worker-host-task-failed", "Bounded execution failed", { cause: error });
			} finally {
				if (!sourceFinished && iterator !== undefined) {
					try {
						await closeSource();
					} catch (error) {
						if (callerAborted) {
							const suppressed = rawFailure === undefined ? [error] : [rawFailure, error];
							failure = abortError(callerAbortReason, suppressed);
						} else if (failure === undefined) {
							failure = failureError("worker-host-source-failed", error);
						} else {
							failure = appendSuppressed(failure, error);
						}
					}
				}
				producerSettled = true;
				if (abandoned) queue.finish();
				else queue.finish(failure);
			}
		})();

		try {
			while (true) {
				let next;
				try {
					next = await queue.dequeue();
				} catch (error) {
					terminalObserved = true;
					throw error;
				}
				if (next.done) {
					terminalObserved = true;
					return;
				}
				yield next.value;
			}
		} finally {
			if (!terminalObserved) {
				abandoned = true;
				if (!linkedController.signal.aborted) {
					linkedController.abort(
						new WorkerHostError("worker-host-consumer-abandoned", "Bounded execution consumer abandoned")
					);
				}
				incrementDiscarded(resolved.metrics, queue.discard());
				void closeSource().catch(() => undefined);
			}
			await producer;
			resolved.signal?.removeEventListener("abort", onCallerAbort);
		}
	})();
}
