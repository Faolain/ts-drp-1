import { MessageQueueManager } from "@ts-drp/message-queue";
import type { IMessageQueueManagerOptions } from "@ts-drp/types";

export interface ObservedMessageReceipt<T> {
	readonly handlerStarted: boolean;
	readonly message: T;
	readonly outcome: "closed-before-start" | "enqueue-rejected" | "handler-settled" | "no-handler" | undefined;
	readonly processed: Promise<void>;
	readonly queueId: string;
	readonly sequence: number;
	readonly started: Promise<boolean>;
	readonly settled: boolean;
}

interface MutableReceipt<T> {
	readonly message: T;
	readonly processed: Promise<void>;
	readonly queueId: string;
	readonly sequence: number;
	readonly started: Promise<boolean>;
	handlerStarted: boolean;
	outcome: ObservedMessageReceipt<T>["outcome"];
	remainingHandlers: number;
	resolve(): void;
	resolveStarted(value: boolean): void;
	settled: boolean;
}

interface ReceiptWaiter<T> {
	reject(error: Error): void;
	resolve(receipt: ObservedMessageReceipt<T>): void;
}

/** Test-only queue manager that exposes one completion receipt per enqueue occurrence. */
export class ObservedMessageQueueManager<T> extends MessageQueueManager<T> {
	readonly #pending = new Map<string, MutableReceipt<T>[]>();
	readonly #subscriberCounts = new Map<string, number>();
	readonly #waiters: ReceiptWaiter<T>[] = [];
	#sequence = 0;

	/** @param options - Genuine queue limits and logging configuration. */
	constructor(options: IMessageQueueManagerOptions = {}) {
		super(options);
	}

	/**
	 * Enqueue without changing genuine queue behavior and publish its occurrence receipt.
	 * @param queueId - Genuine queue identifier.
	 * @param message - Exact message reference passed through unchanged.
	 */
	override async enqueue(queueId: string, message: T): Promise<void> {
		const normalized = queueId === "" ? "general" : queueId;
		let resolve!: () => void;
		let resolveStarted!: (value: boolean) => void;
		const processed = new Promise<void>((settled) => {
			resolve = settled;
		});
		const started = new Promise<boolean>((settled) => {
			resolveStarted = settled;
		});
		const mutable: MutableReceipt<T> = {
			handlerStarted: false,
			message,
			outcome: undefined,
			processed,
			queueId: normalized,
			remainingHandlers: this.#subscriberCounts.get(normalized) ?? 0,
			resolve,
			resolveStarted,
			sequence: this.#sequence++,
			started,
			settled: false,
		};
		const queue = this.#pending.get(normalized) ?? [];
		queue.push(mutable);
		this.#pending.set(normalized, queue);
		const publicReceipt = this.#publicReceipt(mutable);
		this.#waiters.shift()?.resolve(publicReceipt);
		try {
			await super.enqueue(queueId, message);
			if (mutable.remainingHandlers === 0) this.#settle(normalized, mutable, "no-handler");
		} catch (error) {
			this.#settle(normalized, mutable, "enqueue-rejected");
			throw error;
		}
	}

	/**
	 * Delegate the genuine handler and settle only its matching occurrence.
	 * @param queueId - Genuine queue identifier.
	 * @param handler - Genuine subscribed handler.
	 */
	override subscribe(queueId: string, handler: Parameters<MessageQueueManager<T>["subscribe"]>[1]): void {
		const normalized = queueId === "" ? "general" : queueId;
		this.#subscriberCounts.set(normalized, (this.#subscriberCounts.get(normalized) ?? 0) + 1);
		super.subscribe(queueId, async (message) => {
			const receipt = this.#pending.get(normalized)?.[0];
			if (receipt === undefined || receipt.message !== message) {
				throw new TypeError("observed queue occurrence order diverged");
			}
			if (!receipt.handlerStarted) {
				receipt.handlerStarted = true;
				receipt.resolveStarted(true);
			}
			try {
				await handler(message);
			} finally {
				receipt.remainingHandlers -= 1;
				if (receipt.remainingHandlers === 0) this.#settle(normalized, receipt, "handler-settled");
			}
		});
	}

	/**
	 * Close one genuine queue and forget observation state that cannot survive recreation.
	 * @param queueId - Genuine queue identifier.
	 */
	override close(queueId: string): void {
		const normalized = queueId === "" ? "general" : queueId;
		super.close(queueId);
		this.#subscriberCounts.delete(normalized);
		this.#detachClosedQueue(normalized);
		this.#rejectWaiters(normalized);
	}

	/** Close all genuine queues and reject observation waiters that cannot receive an occurrence. */
	override closeAll(): void {
		super.closeAll();
		this.#subscriberCounts.clear();
		for (const queueId of [...this.#pending.keys()]) this.#detachClosedQueue(queueId);
		this.#rejectWaiters("all queues");
	}

	/**
	 * Await the exact next enqueue occurrence receipt across genuine queues.
	 * @returns The next FIFO occurrence receipt.
	 */
	nextReceipt(): Promise<ObservedMessageReceipt<T>> {
		return new Promise((resolve, reject) => {
			this.#waiters.push({ reject, resolve });
		});
	}

	#publicReceipt(receipt: MutableReceipt<T>): ObservedMessageReceipt<T> {
		return Object.freeze({
			get handlerStarted() {
				return receipt.handlerStarted;
			},
			message: receipt.message,
			get outcome() {
				return receipt.outcome;
			},
			processed: receipt.processed,
			queueId: receipt.queueId,
			sequence: receipt.sequence,
			started: receipt.started,
			get settled() {
				return receipt.settled;
			},
		});
	}

	#settle(
		queueId: string,
		receipt: MutableReceipt<T>,
		outcome: Exclude<ObservedMessageReceipt<T>["outcome"], undefined>
	): void {
		if (receipt.settled) return;
		receipt.settled = true;
		receipt.outcome = outcome;
		if (!receipt.handlerStarted) receipt.resolveStarted(false);
		receipt.resolve();
		const queue = this.#pending.get(queueId);
		const index = queue?.indexOf(receipt) ?? -1;
		if (index >= 0) queue?.splice(index, 1);
		if (queue?.length === 0) this.#pending.delete(queueId);
	}

	#detachClosedQueue(queueId: string): void {
		for (const receipt of [...(this.#pending.get(queueId) ?? [])]) {
			if (!receipt.handlerStarted) this.#settle(queueId, receipt, "closed-before-start");
		}
		this.#pending.delete(queueId);
	}

	#rejectWaiters(queueId: string): void {
		for (const waiter of this.#waiters) {
			waiter.reject(new Error(`observed queue ${queueId} closed before the next occurrence`));
		}
		this.#waiters.length = 0;
	}
}
