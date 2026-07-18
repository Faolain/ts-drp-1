import { Channel, MessageQueue } from "@ts-drp/message-queue";
import { describe, expect, it, vi } from "vitest";

describe("message-queue lifecycle through the public package API", () => {
	it("keeps an already-open channel open when start() is called", async () => {
		const channel = new Channel<string>();

		channel.start();

		const roundTrip = async (): Promise<string> => {
			await channel.send("hello");
			return channel.receive();
		};
		await expect(roundTrip()).resolves.toBe("hello");
	});

	it("revives a MessageQueue and its existing subscribers after close() then start()", async () => {
		const queue = new MessageQueue<string>({ id: "public-api-restart" });
		const handler = vi.fn<(message: string) => void>();
		queue.subscribe(handler);

		queue.close();
		queue.start();

		await expect(queue.enqueue("after-restart")).resolves.toBeUndefined();
		await vi.waitFor(() => expect(handler).toHaveBeenCalledWith("after-restart"));
	});
});
