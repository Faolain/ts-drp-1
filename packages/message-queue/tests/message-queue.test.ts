import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageQueue } from "../src/message-queue.js";

describe("MessageQueue", () => {
	let queue: MessageQueue<string>;
	let messages: string[] = [];

	beforeEach(() => {
		queue = new MessageQueue<string>();
		messages = [];
	});

	afterEach(async () => {});

	describe("basic functionality", () => {
		it("joins every entered handler while close discards only unentered custody", async () => {
			let enter!: () => void, release!: () => void;
			const entered = new Promise<void>((resolve) => { enter = resolve; });
			const held = new Promise<void>((resolve) => { release = resolve; });
			const calls: string[] = [];
			queue.subscribe(async (message) => { calls.push(message); enter(); await held; });
			queue.subscribe((message) => { calls.push("second:" + message); });
			let joined = false;
			const first = queue.enqueueJoined("entered").then(() => { joined = true; });
			await entered;
			// Ordinary enqueue still means buffered, not joined.
			await queue.enqueue("ordinary-discarded");
			const discarded = queue.enqueueJoined("joined-discarded");
			const refused = expect(discarded).rejects.toThrow("Channel is closed");
			queue.close();
			await refused;
			expect(joined).toBe(false);
			release(); await first;
			expect(calls).toEqual(["entered", "second:entered"]);
		});

		it("discards a resolved receive before handler entry without releasing entered work", async () => {
			const handler = vi.fn();
			queue.subscribe(handler);
			// Enter the original receive wait before delivering and closing in one
			// synchronous turn; this exercises resolved-but-unentered custody.
			await Promise.resolve();
			const pending = queue.enqueueJoined("not-entered");
			const refused = expect(pending).rejects.toThrow("Channel is closed");
			queue.close(); await refused;
			await Promise.resolve(); await Promise.resolve();
			expect(handler).not.toHaveBeenCalled();
			queue.start(); await queue.enqueueJoined("after-restart");
			expect(handler).toHaveBeenCalledExactlyOnceWith("after-restart");
			queue.close();
		});

		it("preserves undefined rejection before either enqueue representation", async () => {
			const handler = vi.fn(); queue.subscribe(handler);
			await expect(queue.enqueue(undefined as unknown as string)).rejects.toThrow("Unexpected undefined value in channel");
			await expect(queue.enqueueJoined(undefined as unknown as string)).rejects.toThrow("Unexpected undefined value in channel");
			expect(handler).not.toHaveBeenCalled(); queue.close();
		});

		it("rejects excess joined sends without losing buffered custody", async () => {
			const bounded = new MessageQueue<string>({ id: "joined-capacity", maxSize: 1, logConfig: { level: "silent" } });
			const first = bounded.enqueueJoined("buffered"), second = bounded.enqueueJoined("blocked");
			const rejected = expect(bounded.enqueueJoined("excess")).rejects.toThrow("Channel pending send capacity exceeded");
			await rejected;
			const seen: string[] = [];
			bounded.subscribe((message) => { seen.push(message); });
			await Promise.all([first, second]);
			expect(seen).toEqual(["buffered", "blocked"]);
			bounded.close();
		});

		it("should process messages in order", async () => {
			const promises: Promise<void>[] = [];
			const resolvers: (() => void)[] = [];

			const createResolver = (): { handlerPromise: Promise<void>; resolveHandler(): void } => {
				let resolveHandler: () => void;
				const handlerPromise = new Promise<void>((resolve) => {
					resolveHandler = resolve;
				});
				// @ts-expect-error -- resolveHandler is set in the closure
				return { handlerPromise, resolveHandler };
			};

			for (let i = 0; i < 3; i++) {
				const { handlerPromise, resolveHandler } = createResolver();
				promises.push(handlerPromise);
				resolvers.push(resolveHandler);
			}

			let i = 0;
			const handler = vi.fn((msg: string) => {
				messages.push(msg);
				resolvers[i]();
				i++;
			});
			// Start subscription before enqueueing
			queue.subscribe(handler);

			// Enqueue messages
			await queue.enqueue("first");
			await queue.enqueue("second");
			await queue.enqueue("third");

			// Wait for messages to be processed
			await Promise.all(promises);
			// Close queue to stop subscription
			queue.close();

			expect(messages).toEqual(["first", "second", "third"]);
			expect(handler).toHaveBeenCalledTimes(3);
		});
	});

	describe("error handling", () => {
		it("should throw error when enqueueing to closed queue", async () => {
			queue.close();
			await expect(queue.enqueue("test")).rejects.toThrow("Message queue is closed");
		});
	});

	describe("queue closing", () => {
		it("should stop processing messages after closing", async () => {
			const messages: string[] = [];
			let resolveHandler: () => void;
			const handlerPromise = new Promise<void>((resolve) => {
				resolveHandler = resolve;
			});

			const handler = vi.fn((msg: string) => {
				messages.push(msg);
				resolveHandler();
			});

			queue.subscribe(handler);

			// Enqueue a message
			await queue.enqueue("test");

			// Wait for message to be processed
			await handlerPromise;
			// Close queue
			queue.close();

			// Try to enqueue after closing
			await expect(queue.enqueue("after-close")).rejects.toThrow("Message queue is closed");

			expect(messages).toEqual(["test"]);
			expect(handler).toHaveBeenCalledTimes(1);
		});
	});

	describe("queue multiple handlers", () => {
		it("should process messages in order", async () => {
			const messages: string[] = [];
			let resolveHandler1: () => void;
			let resolveHandler2: () => void;
			const handler1Promise = new Promise<void>((resolve) => {
				resolveHandler1 = resolve;
			});
			const handler2Promise = new Promise<void>((resolve) => {
				resolveHandler2 = resolve;
			});

			const handler1 = vi.fn((msg: string) => {
				messages.push(msg);
				resolveHandler1();
			});

			const handler2 = vi.fn((msg: string) => {
				messages.push(msg);
				resolveHandler2();
			});

			queue.subscribe(handler1);
			queue.subscribe(handler2);

			await queue.enqueue("test");
			// Wait for both handlers to process the message
			await Promise.all([handler1Promise, handler2Promise]);
			queue.close();

			expect(messages).toEqual(["test", "test"]);
			expect(handler1).toHaveBeenCalledTimes(1);
			expect(handler2).toHaveBeenCalledTimes(1);
		});

		it("should process messages in order multiple async handlers", async () => {
			const messages: string[] = [];
			let resolveHandler1: () => void;
			let resolveHandler2: () => void;
			const handler1Promise = new Promise<void>((resolve) => {
				resolveHandler1 = resolve;
			});
			const handler2Promise = new Promise<void>((resolve) => {
				resolveHandler2 = resolve;
			});

			const order: string[] = [];

			const handler1 = vi.fn(async (msg: string) => {
				messages.push(msg);
				order.push("handler1");
				await new Promise((resolve) => setTimeout(resolve, 10));
				resolveHandler1();
			});

			const handler2 = vi.fn(async (msg: string) => {
				messages.push(msg);
				order.push("handler2");
				await new Promise((resolve) => setTimeout(resolve, 10));
				resolveHandler2();
			});

			queue.subscribe(handler1);
			queue.subscribe(handler2);

			await queue.enqueue("test");
			// Wait for both handlers to process the message
			await Promise.all([handler1Promise, handler2Promise]);
			queue.close();

			expect(messages).toEqual(["test", "test"]);
			expect(order).toEqual(["handler1", "handler2"]);
			expect(handler1).toHaveBeenCalledTimes(1);
			expect(handler2).toHaveBeenCalledTimes(1);
		});
	});
});
