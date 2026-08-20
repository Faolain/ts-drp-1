import type { WorkerHostMetrics } from "./metrics.js";

export type QueueResult<T> = Readonly<{ done: false; value: T }> | Readonly<{ done: true }>;

/** Fixed-capacity FIFO shared by one producer and one async consumer. */
export class ResultRingBuffer<T> {
	readonly #entries: (T | undefined)[];
	readonly #metrics: WorkerHostMetrics | undefined;
	#count = 0;
	#head = 0;
	#tail = 0;
	#terminal: Readonly<{ error?: unknown }> | undefined;
	#dataWaiter: (() => void) | undefined;
	#spaceWaiter: (() => void) | undefined;

	/**
	 * Creates an empty queue with a hard result capacity.
	 * @param capacity - Maximum retained result count.
	 * @param metrics - Optional caller-owned metrics sink.
	 */
	constructor(capacity: number, metrics: WorkerHostMetrics | undefined) {
		this.#entries = Array<T | undefined>(capacity).fill(undefined);
		this.#metrics = metrics;
	}

	/**
	 * Waits for capacity when necessary and appends one result.
	 * @param value - Result to retain.
	 * @param signal - Linked execution signal.
	 * @returns Whether the result was enqueued before termination.
	 */
	async enqueue(value: T, signal: AbortSignal): Promise<boolean> {
		const capacity = this.waitForCapacity(signal);
		if (capacity !== undefined && !(await capacity)) return false;
		if (signal.aborted || this.#terminal !== undefined) return false;
		this.#entries[this.#tail] = value;
		this.#tail = (this.#tail + 1) % this.#entries.length;
		this.#count += 1;
		this.#wakeData();
		return true;
	}

	/**
	 * Returns a wait only when capacity is currently exhausted.
	 * @param signal - Linked execution signal.
	 * @returns A capacity wait, or undefined when capacity is immediately available.
	 */
	waitForCapacity(signal: AbortSignal): Promise<boolean> | undefined {
		if (this.#count < this.#entries.length) return undefined;
		this.#metrics?.increment("buffer-full-waits");
		return this.#waitForSpace(signal).then(() => !signal.aborted && this.#terminal === undefined);
	}

	/**
	 * Removes the oldest result or observes the terminal queue state.
	 * @returns The oldest result or the completed discriminator.
	 */
	async dequeue(): Promise<QueueResult<T>> {
		while (this.#count === 0 && this.#terminal === undefined) await this.#waitForData();
		if (this.#count > 0) {
			const value = this.#entries[this.#head] as T;
			this.#entries[this.#head] = undefined;
			this.#head = (this.#head + 1) % this.#entries.length;
			this.#count -= 1;
			this.#wakeSpace();
			return { done: false, value };
		}
		if (this.#terminal?.error !== undefined) throw this.#terminal.error;
		return { done: true };
	}

	/**
	 * Drops every retained result and returns the exact discarded count.
	 * @returns Number of discarded results.
	 */
	discard(): number {
		const discarded = this.#count;
		this.#entries.fill(undefined);
		this.#count = 0;
		this.#head = 0;
		this.#tail = 0;
		this.#wakeSpace();
		this.#wakeData();
		return discarded;
	}

	/**
	 * Records the producer terminal exactly once.
	 * @param error - Optional terminal failure.
	 */
	finish(error?: unknown): void {
		if (this.#terminal !== undefined) return;
		this.#terminal = error === undefined ? {} : { error };
		this.#wakeData();
		this.#wakeSpace();
	}

	/**
	 * Replaces an open or successful terminal with an abort and discards retained results.
	 * @param error - Abort error visible to the consumer.
	 * @returns The exact discarded result count.
	 */
	abort(error: unknown): number {
		const previousError = this.#terminal?.error;
		const discarded = this.discard();
		if (previousError === undefined) this.#terminal = { error };
		this.#wakeData();
		this.#wakeSpace();
		return discarded;
	}

	#waitForData(): Promise<void> {
		return new Promise((resolve) => {
			this.#dataWaiter = resolve;
		});
	}

	#waitForSpace(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const settle = (): void => {
				signal.removeEventListener("abort", settle);
				if (this.#spaceWaiter === settle) this.#spaceWaiter = undefined;
				resolve();
			};
			this.#spaceWaiter = settle;
			signal.addEventListener("abort", settle, { once: true });
		});
	}

	#wakeData(): void {
		const waiter = this.#dataWaiter;
		this.#dataWaiter = undefined;
		waiter?.();
	}

	#wakeSpace(): void {
		const waiter = this.#spaceWaiter;
		this.#spaceWaiter = undefined;
		waiter?.();
	}
}
