import { Logger } from "@ts-drp/logger";
import { type LoggerOptions } from "@ts-drp/types";
import { Deferred } from "@ts-drp/utils/promise/deferred";
export interface ChannelOptions {
	capacity?: number;
	logOptions?: LoggerOptions;
}

/** Error raised when an operation cannot complete because its channel closed. */
export class ChannelClosedError extends Error {
	/** Create a channel-closure error. */
	constructor() {
		super("Channel is closed");
		this.name = "ChannelClosedError";
	}
}

/** Error raised when a channel cannot retain another pending send. */
export class ChannelCapacityError extends Error {
	/** Create a channel-capacity error. */
	constructor() {
		super("Channel pending send capacity exceeded");
		this.name = "ChannelCapacityError";
	}
}

/**
 * Channel is a class that implements a simple message queue.
 * It provides methods to send and receive messages.
 * @template T - The type of messages that the channel will handle
 */
export class Channel<T> {
	private readonly values: Array<T> = [];
	private readonly sends: Array<{ value: T; signal: Deferred<void> }> = [];
	private readonly receives: Array<Deferred<T>> = [];
	private readonly options: Required<ChannelOptions>;
	private readonly logger: Logger;
	private isClosed: boolean = false;

	/**
	 * Constructor for Channel
	 * @param options - The options for the channel
	 */
	constructor(options: ChannelOptions = {}) {
		this.options = {
			capacity: options.capacity ?? 1000,
			logOptions: options.logOptions ?? {
				level: "info",
			},
		};
		this.logger = new Logger("drp::channel", this.options.logOptions);
	}

	/**
	 * Send a message to the channel
	 * @param value - The value to send to the channel
	 */
	async send(value: T): Promise<void> {
		if (this.isClosed) {
			throw new ChannelClosedError();
		}

		if (value === undefined) {
			throw new Error("Unexpected undefined value in channel");
		}

		// if there are pending receives, deliver immediately
		if (this.receives.length > 0) {
			const recv = this.receives.shift();
			if (recv) {
				recv.resolve(value);
			}
			return;
		}

		// Preserve older blocked sends before admitting a new value to the buffer.
		if (this.sends.length === 0 && this.values.length < this.options.capacity) {
			this.values.push(value);
			return;
		}

		// Bound pending sends to one buffer-capacity, while retaining one rendezvous
		// sender for a capacity-zero channel.
		const pendingSendCapacity = Math.max(1, this.options.capacity);
		if (this.sends.length >= pendingSendCapacity) {
			throw new ChannelCapacityError();
		}

		const signal = new Deferred<void>();
		this.sends.push({ value, signal });
		await signal.promise;
	}

	/**
	 * Receive a message from the channel
	 * @returns The value received from the channel
	 */
	async receive(): Promise<T> {
		if (this.isClosed) {
			throw new ChannelClosedError();
		}

		// if there are values in the buffer, return the first one
		if (this.values.length > 0) {
			const value = this.values.shift();
			if (value === undefined) {
				throw new Error("Unexpected undefined value in channel");
			}

			// Refill the freed slot from the oldest blocked sender before a newer
			// send can consume it.
			const send = this.sends.shift();
			if (send) {
				this.values.push(send.value);
				send.signal.resolve();
			}
			return value;
		}

		// if there are pending sends, accept the first one
		if (this.sends.length > 0) {
			const send = this.sends.shift();
			if (send) {
				const value = send.value;
				send.signal.resolve();
				return value;
			}
		}

		// if there are no values or pending sends, wait for a send
		const signal = new Deferred<T>();
		this.receives.push(signal);
		return signal.promise;
	}

	/**
	 * Close the channel
	 */
	close(): void {
		this.isClosed = true;
		this.values.splice(0);
		while (this.sends.length > 0) {
			this.sends.shift()?.signal.reject(new ChannelClosedError());
		}
		while (this.receives.length > 0) {
			this.receives.shift()?.reject(new ChannelClosedError());
		}
	}

	/**
	 * Reopen the channel with no buffered values or pending operations.
	 */
	start(): void {
		if (!this.isClosed) {
			this.logger.warn("Channel is already started");
			return;
		}
		this.values.splice(0);
		this.sends.splice(0);
		this.receives.splice(0);
		this.isClosed = false;
	}
}
