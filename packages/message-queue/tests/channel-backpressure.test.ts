import { describe, expect, it, vi } from "vitest";

import * as channelExports from "../src/channel.js";

type ChannelState<T> = {
	receives: unknown[];
	sends: Array<{ value: T }>;
	values: T[];
};

type SendOutcome = { status: "fulfilled" } | { reason: unknown; status: "rejected" };
type ErrorConstructor = new (...args: never[]) => Error;

const observe = (promise: Promise<void>, index: number, outcomes: Array<SendOutcome | undefined>): Promise<void> =>
	promise.then(
		() => {
			outcomes[index] = { status: "fulfilled" };
		},
		(reason: unknown) => {
			outcomes[index] = { reason, status: "rejected" };
		}
	);

describe("Channel bounded backpressure", () => {
	it("preserves normal send/receive behavior", async () => {
		const channel = new channelExports.Channel<string>({ capacity: 2 });

		await channel.send("first");
		await channel.send("second");

		expect(await channel.receive()).toBe("first");
		expect(await channel.receive()).toBe("second");
		channel.close();
	});

	it("reuses positive capacity after a receive", async () => {
		const channel = new channelExports.Channel<string>({ capacity: 1 });

		await channel.send("first");
		expect(await channel.receive()).toBe("first");
		await channel.send("second");
		expect(await channel.receive()).toBe("second");
		channel.close();
	});

	it("bounds 100,000 fire-and-forget sends and preserves FIFO through capacity reuse", async () => {
		const capacity = 32;
		const sendCount = 100_000;
		const expectedInitiallyAccepted = capacity * 2;
		const expectedPromptRejections = sendCount - expectedInitiallyAccepted;
		const channel = new channelExports.Channel<number>({ capacity });
		const state = channel as unknown as ChannelState<number>;
		const outcomes: Array<SendOutcome | undefined> = new Array(sendCount + 1);
		const observed: Promise<void>[] = [];
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const startedAt = performance.now();
		const startingMemory = process.memoryUsage();
		let peakPendingSends = 0;

		for (let index = 0; index < sendCount; index++) {
			// This is deliberately the network producer shape: invoke, attach rejection immediately, do not await.
			observed.push(observe(channel.send(index), index, outcomes));
			peakPendingSends = Math.max(peakPendingSends, state.sends.length);
		}

		// Prompt capacity rejection is a synchronous send decision observed by the next microtask turn.
		await Promise.resolve();
		await Promise.resolve();

		const promptOutcomes = Array.from({ length: sendCount }, (_, index) => outcomes[index]);
		const promptFulfilled = promptOutcomes.filter((outcome) => outcome?.status === "fulfilled");
		const promptRejected = promptOutcomes.filter(
			(outcome): outcome is Extract<SendOutcome, { status: "rejected" }> => outcome?.status === "rejected"
		);
		const promptPending = promptOutcomes.filter((outcome) => outcome === undefined);
		const capacityError = (channelExports as typeof channelExports & { ChannelCapacityError?: ErrorConstructor })
			.ChannelCapacityError;

		expect.soft(peakPendingSends, "peak internal pending sends").toBeLessThanOrEqual(capacity);
		expect.soft(state.sends, "current internal pending sends").toHaveLength(capacity);
		expect.soft(promptFulfilled, "buffered sends accepted immediately").toHaveLength(capacity);
		expect.soft(promptPending, "bounded pending sends awaiting capacity").toHaveLength(capacity);
		expect.soft(promptRejected, "every excess send rejects promptly").toHaveLength(expectedPromptRejections);
		expect.soft(capacityError, "stable exported capacity error type").toBeTypeOf("function");
		expect
			.soft(
				promptRejected.every(({ reason }) => capacityError !== undefined && reason instanceof capacityError),
				"all prompt rejections use ChannelCapacityError"
			)
			.toBe(true);
		expect
			.soft(new Set(promptRejected.map(({ reason }) => (reason as Error).constructor)).size, "one stable error class")
			.toBe(1);
		expect
			.soft(new Set(promptRejected.map(({ reason }) => (reason as Error).name)), "one stable error name")
			.toEqual(new Set(["ChannelCapacityError"]));

		const received: number[] = [await channel.receive()];
		await Promise.resolve();
		await Promise.resolve();
		expect.soft(outcomes[capacity], "oldest pending send is admitted when capacity is reused").toEqual({
			status: "fulfilled",
		});

		const reusedIndex = sendCount;
		observed.push(observe(channel.send(reusedIndex), reusedIndex, outcomes));
		await Promise.resolve();
		await Promise.resolve();
		expect.soft(outcomes[reusedIndex], "new send waits behind older accepted sends").toBeUndefined();
		expect.soft(state.sends, "reused capacity remains bounded").toHaveLength(capacity);

		const expectedFifo = [...Array.from({ length: expectedInitiallyAccepted }, (_, index) => index), reusedIndex];
		const remainingAvailable = Math.min(expectedFifo.length - 1, state.values.length + state.sends.length);
		for (let index = 0; index < remainingAvailable; index++) {
			received.push(await channel.receive());
		}
		expect.soft(received, "accepted values remain FIFO across capacity reuse").toEqual(expectedFifo);

		channel.close();
		await Promise.all(observed);

		const finalFulfilled = outcomes.filter((outcome) => outcome?.status === "fulfilled");
		const finalRejected = outcomes.filter((outcome) => outcome?.status === "rejected");
		expect.soft(finalFulfilled, "every accepted send settles").toHaveLength(expectedFifo.length);
		expect.soft(finalRejected, "all excess sends remain settled").toHaveLength(expectedPromptRejections);
		expect
			.soft(
				Array.from(outcomes).every((outcome) => outcome !== undefined),
				"no send promise remains unresolved"
			)
			.toBe(true);
		expect.soft(state.values, "buffer cleanup").toHaveLength(0);
		expect.soft(state.sends, "pending-send cleanup").toHaveLength(0);
		expect.soft(state.receives, "pending-receive/listener cleanup").toHaveLength(0);
		expect.soft(timeoutSpy, "channel must not accumulate timeout cleanup").not.toHaveBeenCalled();
		expect.soft(intervalSpy, "channel must not accumulate interval cleanup").not.toHaveBeenCalled();

		const endingMemory = process.memoryUsage();
		process.stdout.write(
			`${JSON.stringify({
				channelBackpressureDiagnostics: {
					elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
					heapDeltaBytes: endingMemory.heapUsed - startingMemory.heapUsed,
					peakPendingSends,
					promptFulfilled: promptFulfilled.length,
					promptPending: promptPending.length,
					promptRejected: promptRejected.length,
					rssDeltaBytes: endingMemory.rss - startingMemory.rss,
				},
			})}\n`
		);
		timeoutSpy.mockRestore();
		intervalSpy.mockRestore();
	}, 15_000); // The longer timeout is isolated to the required 100k leak contract; ordinary controls stay small.
});
