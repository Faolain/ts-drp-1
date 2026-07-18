import type { IMessageQueueManager } from "@ts-drp/types";
import { Deferred } from "@ts-drp/utils/promise/deferred";
import { describe, expect, it, vi } from "vitest";

import { Channel } from "../src/channel.js";
import { MessageQueueManager } from "../src/message-queue-manager.js";
import { MessageQueue } from "../src/message-queue.js";

describe("Channel lifecycle", () => {
	it("reopens an empty channel when start() is called", async () => {
		const channel = new Channel<string>();
		await channel.send("discarded-on-close");
		channel.close();

		channel.start();

		const receive = channel.receive();
		const status = await Promise.race([receive.then(() => "received"), Promise.resolve("pending")]);
		expect(status).toBe("pending");
		await channel.send("after-restart");
		await expect(receive).resolves.toBe("after-restart");
	});
});

describe("MessageQueue lifecycle", () => {
	it("restarts fanout to subscribers that existed before close()", async () => {
		const queue = new MessageQueue<string>({ id: "restart" });
		const handler = vi.fn<(message: string) => void>();
		queue.subscribe(handler);
		await queue.enqueue("before-close");
		await vi.waitFor(() => expect(handler).toHaveBeenCalledWith("before-close"));

		queue.close();
		queue.start();

		await expect(queue.enqueue("after-restart")).resolves.toBeUndefined();
		await vi.waitFor(() => expect(handler).toHaveBeenCalledWith("after-restart"));
	});

	it("rejects an enqueue blocked by backpressure when close() is called", async () => {
		const queue = new MessageQueue<string>({ id: "blocked-enqueue", maxSize: 1 });
		await queue.enqueue("buffered");
		const blockedEnqueue = queue.enqueue("blocked");

		queue.close();

		await expect(blockedEnqueue).rejects.toThrow(/closed/i);
	});

	it("serializes handlers across close/start generations", async () => {
		const queue = new MessageQueue<string>({ id: "generation-overlap" });
		const firstHandlerStarted = new Deferred<void>();
		const releaseFirstHandler = new Deferred<void>();
		const calls: string[] = [];
		let concurrent = 0;
		let maxConcurrent = 0;
		queue.subscribe(async (message) => {
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			calls.push(`start:${message}`);
			if (message === "old-generation") {
				firstHandlerStarted.resolve();
				await releaseFirstHandler.promise;
			}
			calls.push(`end:${message}`);
			concurrent -= 1;
		});

		await queue.enqueue("old-generation");
		await firstHandlerStarted.promise;
		queue.close();
		queue.start();
		await queue.enqueue("new-generation");
		await new Promise(process.nextTick);

		expect(maxConcurrent).toBe(1);
		expect(calls).toEqual(["start:old-generation"]);

		releaseFirstHandler.resolve();
		await vi.waitFor(() =>
			expect(calls).toEqual([
				"start:old-generation",
				"end:old-generation",
				"start:new-generation",
				"end:new-generation",
			])
		);
		expect(maxConcurrent).toBe(1);
		queue.close();
	});
});

describe("MessageQueueManager delivery contracts", () => {
	// Unknown-queue enqueue rejects instead of buffering. This is the smallest
	// non-lossy contract because both network fanout call sites already handle a
	// rejected promise, while DRPNode.dispatchMessage propagates it to its caller.
	it("rejects enqueue for an unknown queue id instead of silently dropping the message", async () => {
		const manager = new MessageQueueManager<string>({ logConfig: { level: "silent" } });

		await expect(manager.enqueue("not-subscribed", "must-not-be-lost")).rejects.toThrow(/queue.*not found/i);
	});

	it("admits at least 101 object queues with the default capacity", () => {
		const manager = new MessageQueueManager<string>({ logConfig: { level: "silent" } });
		const handler = vi.fn<(message: string) => void>();

		try {
			manager.subscribe("discovery", handler);
			for (let index = 0; index < 101; index += 1) {
				manager.subscribe(`object-${index}`, handler);
			}
			expect(() => manager.subscribe("object-101", handler)).toThrow("Max number of queues reached");
		} finally {
			manager.closeAll();
		}
	});

	it("keeps delivering another queue after closing a full queue with a blocked enqueue", async () => {
		const manager = new MessageQueueManager<string>({ maxQueueSize: 1, logConfig: { level: "silent" } });
		const slowStarted = new Deferred<void>();
		const releaseSlow = new Deferred<void>();
		manager.subscribe("doomed", async (message) => {
			if (message === "in-flight") {
				slowStarted.resolve();
				await releaseSlow.promise;
			}
		});
		const healthyHandler = vi.fn<(message: string) => void>();
		manager.subscribe("healthy", healthyHandler);

		await manager.enqueue("doomed", "in-flight");
		await slowStarted.promise;
		await manager.enqueue("doomed", "buffered");
		const blocked = manager.enqueue("doomed", "blocked");
		manager.close("doomed");

		await expect(blocked).rejects.toThrow(/closed/i);
		await expect(manager.enqueue("healthy", "still-delivered")).resolves.toBeUndefined();
		await vi.waitFor(() => expect(healthyHandler).toHaveBeenCalledWith("still-delivered"));
		releaseSlow.resolve();
		manager.closeAll();
	});

	it("recreates a queue when subscribing after close", async () => {
		const manager = new MessageQueueManager<string>({ logConfig: { level: "silent" } });
		manager.subscribe("resubscribe", vi.fn());
		manager.close("resubscribe");
		const handler = vi.fn<(message: string) => void>();

		manager.subscribe("resubscribe", handler);
		await manager.enqueue("resubscribe", "revived");

		await vi.waitFor(() => expect(handler).toHaveBeenCalledWith("revived"));
		manager.closeAll();
	});

	it("releases a closed queue capacity slot", () => {
		const manager = new MessageQueueManager<string>({ maxQueues: 1, logConfig: { level: "silent" } });
		manager.subscribe("first", vi.fn());
		manager.close("first");

		expect(() => manager.subscribe("second", vi.fn())).not.toThrow();
		manager.closeAll();
	});

	it("does not leak capacity across 150 subscribe/unsubscribe cycles", () => {
		const manager = new MessageQueueManager<string>({ maxQueues: 1, logConfig: { level: "silent" } });
		for (let index = 0; index < 150; index += 1) {
			manager.subscribe(`cycled-${index}`, vi.fn());
			manager.close(`cycled-${index}`);
		}

		expect(() => manager.subscribe("after-cycles", vi.fn())).not.toThrow();
		manager.closeAll();
	});

	it("exposes startAll through the manager interface", () => {
		const manager: IMessageQueueManager<string> = new MessageQueueManager<string>({
			logConfig: { level: "silent" },
		});
		manager.closeAll();
		manager.startAll();
		manager.closeAll();
	});
});
