import { Logger } from "@ts-drp/logger";
import type { IMessageQueue, IMessageQueueHandler, IMessageQueueOptions } from "@ts-drp/types";
import { handlePromiseOrValue } from "@ts-drp/utils";

import { Channel, ChannelClosedError } from "./channel.js";

/**
 * A message queue.
 */
export class MessageQueue<T> implements IMessageQueue<T> {
	private readonly options: Required<IMessageQueueOptions>;
	private channel: Channel<T>;
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
		this.channel = new Channel<T>({ capacity: this.options.maxSize });
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
		await this.channel.send(message);
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
	private async runFanoutLoop(channel: Channel<T>, previousLoopDone: Promise<void>): Promise<void> {
		try {
			await previousLoopDone;
			while (this.isActive && channel === this.channel) {
				try {
					const message = await channel.receive();

					for (const handler of this.subscribers) {
						try {
							await handlePromiseOrValue(handler, (handler) => handler(message));
							this.logger.trace(`queue::processed message ${message}`);
						} catch (error) {
							this.logger.error(`queue::error processing message ${message}:`, error);
						}
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
		this.channel = new Channel<T>({ capacity: this.options.maxSize, logOptions: this.options.logConfig });
		this.fanoutLoopStarted = false;
		this.startFanoutLoop();
	}
}
