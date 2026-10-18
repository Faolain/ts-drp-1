import { Logger } from "@ts-drp/logger";
import type { IMessageQueue, IMessageQueueHandler, IMessageQueueOptions } from "@ts-drp/types";
import { handlePromiseOrValue } from "@ts-drp/utils";

import { Channel, ChannelClosedError } from "./channel.js";

interface QueuedEntry<T> {
	readonly message: T;
	readonly joined?: Readonly<{ resolve(): void; reject(error: unknown): void }>;
}

/**
 * A message queue.
 */
export class MessageQueue<T> implements IMessageQueue<T> {
	private readonly options: Required<IMessageQueueOptions>;
	private channel: Channel<QueuedEntry<T>>;
	// Only unentered joined entries. Entered handlers retain custody until join,
	// even if close discards the remainder of this generation.
	private readonly unenteredJoined = new Set<QueuedEntry<T>>();
	private isActive: boolean = true;
	// List of subscriber handlers
	private subscribers: Array<(message: T) => void | Promise<void>> = [];
	// A flag to ensure the fanout loop starts only once
	private fanoutLoopStarted: boolean = false;
	// Completion of the latest generation, used to preserve serial delivery across restarts.
	private fanoutLoopDone: Promise<void> = Promise.resolve();
	private logger: Logger;

	/**
	 * Create a new message queue.
	 * @param options The options for the message queue.
	 */
	constructor(options: IMessageQueueOptions = { id: "default" }) {
		this.options = this.getOptions(options);
		this.channel = new Channel<QueuedEntry<T>>({ capacity: this.options.maxSize });
		this.logger = new Logger(`drp::message-queue::${this.options.id}`, this.options.logConfig);
	}

	private getOptions(options: IMessageQueueOptions): Required<IMessageQueueOptions> {
		return {
			id: options.id,
			maxSize: options.maxSize ?? 1000,
			logConfig: options.logConfig ?? {
				level: "info",
			},
		};
	}

	/**
	 * Enqueue a new message.
	 * @param message The message to enqueue.
	 */
	async enqueue(message: T): Promise<void> {
		if (!this.isActive) {
			throw new Error("Message queue is closed");
		}
		if (message === undefined) throw new Error("Unexpected undefined value in channel");
		await this.channel.send({ message });
	}

	/**
	 * Enqueue with custody through all entered handlers. This is a lifetime join,
	 * not an application-success acknowledgment. Unentered close/capacity refusal
	 * rejects; a handler failure keeps the existing logged fanout semantics.
	 * @param message - Message whose owner needs joined/discard completion.
	 * @returns Completion after fanout joins, or rejection before entry.
	 */
	enqueueJoined(message: T): Promise<void> {
		if (!this.isActive) return Promise.reject(new Error("Message queue is closed"));
		if (message === undefined) return Promise.reject(new Error("Unexpected undefined value in channel"));
		let resolve!: () => void;
		let reject!: (error: unknown) => void;
		const completion = new Promise<void>((ok, fail) => {
			resolve = ok;
			reject = fail;
		});
		const entry: QueuedEntry<T> = { message, joined: { resolve, reject } };
		this.unenteredJoined.add(entry);
		void this.channel.send(entry).catch((error: unknown) => {
			this.unenteredJoined.delete(entry);
			reject(error);
		});
		return completion;
	}

	/**
	 * Register a subscriber's handler.
	 * The handler will be called for every message enqueued.
	 * @param handler - The handler to register.
	 */
	subscribe(handler: IMessageQueueHandler<T>): void {
		this.subscribers.push(handler);
		this.startFanoutLoop();
	}

	private startFanoutLoop(): void {
		if (this.fanoutLoopStarted || !this.isActive || this.subscribers.length === 0) {
			return;
		}
		this.fanoutLoopStarted = true;
		const channel = this.channel;
		const previousLoopDone = this.fanoutLoopDone;
		this.fanoutLoopDone = this.runFanoutLoop(channel, previousLoopDone);
	}

	/**
	 * A continuous loop that receives messages from the central channel
	 * and fans them out to all registered subscriber handlers.
	 * @param channel - The channel owned by this fanout loop generation.
	 * @param previousLoopDone - Completion of the preceding generation.
	 */
	private async runFanoutLoop(channel: Channel<QueuedEntry<T>>, previousLoopDone: Promise<void>): Promise<void> {
		try {
			await previousLoopDone;
			while (this.isActive && channel === this.channel) {
				try {
					const entry = await channel.receive();
					this.unenteredJoined.delete(entry);
					// A receive may have resolved just before close. It has not entered
					// any handler yet and must not execute after its discard/refund.
					if (!this.isActive || channel !== this.channel) {
						entry.joined?.reject(new ChannelClosedError());
						break;
					}
					const message = entry.message;
					try {
						for (const handler of this.subscribers) {
							try {
								await handlePromiseOrValue(handler, (handler) => handler(message));
								this.logger.trace(`queue::processed message ${message}`);
							} catch (error) {
								this.logger.error(`queue::error processing message ${message}:`, error);
							}
						}
					} finally {
						entry.joined?.resolve();
					}
				} catch (error) {
					// When the channel is closed, exit the loop.
					if (error instanceof ChannelClosedError) {
						break;
					} else {
						this.logger.error("Error in fanout loop:", error);
					}
				}
			}
		} finally {
			if (channel === this.channel) {
				this.fanoutLoopStarted = false;
			}
		}
	}

	/**
	 * Close the message queue.
	 */
	close(): void {
		if (!this.isActive) {
			this.logger.warn("Message queue is already closed");
			return;
		}
		this.isActive = false;
		this.channel.close();
		for (const entry of this.unenteredJoined) entry.joined?.reject(new ChannelClosedError());
		this.unenteredJoined.clear();
	}

	/**
	 * Start the message queue.
	 */
	start(): void {
		if (this.isActive) {
			this.logger.warn("Message queue is already started");
			return;
		}
		this.isActive = true;
		this.channel = new Channel<QueuedEntry<T>>({ capacity: this.options.maxSize, logOptions: this.options.logConfig });
		this.fanoutLoopStarted = false;
		this.startFanoutLoop();
	}
}
