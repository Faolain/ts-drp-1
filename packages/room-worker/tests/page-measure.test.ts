import { defineRoomWorkerContract } from "@ts-drp/room-worker";
import { openRoomWorker } from "@ts-drp/room-worker/page";
import { describe, expect, it } from "vitest";

/** openRoomWorker measures bridge latency when its meter can receive it, and only then. */
describe("room worker: openRoomWorker passes a latency meter on", () => {
	const initOf = (meter: unknown): Record<string, unknown> => {
		const posted: unknown[] = [];
		const restore = Reflect.get(globalThis, "RTCPeerConnection") as unknown;
		const restoreWorker = Reflect.get(globalThis, "Worker") as unknown;
		Reflect.set(globalThis, "RTCPeerConnection", function RTCPeerConnection(): void {});
		Reflect.set(globalThis, "Worker", function Worker(): void {});
		try {
			const fake = {
				postMessage: (message: unknown): void => void posted.push(message),
				addEventListener: (): void => undefined,
				removeEventListener: (): void => undefined,
				terminate: (): void => undefined,
			};
			const handle = openRoomWorker({
				spawn: () => fake as unknown as Worker,
				contract: defineRoomWorkerContract({ name: "measure", version: 1, commands: {}, streams: {}, hooks: [] }),
				init: null,
				meter: meter as never,
			});
			handle.terminate("test");
			return posted[0] as Record<string, unknown>;
		} finally {
			Reflect.set(globalThis, "RTCPeerConnection", restore);
			Reflect.set(globalThis, "Worker", restoreWorker);
		}
	};

	it("asks the worker for times when the meter has stream and command", () => {
		const meter = { message: (): void => undefined, post: (): void => undefined };
		expect(initOf({ ...meter, stream: (): void => undefined, command: (): void => undefined }).measure).toBe(true);
		expect(initOf(meter).measure).toBe(false);
	});
});
