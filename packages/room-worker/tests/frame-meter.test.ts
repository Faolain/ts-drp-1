import { createRoomWorkerFrameMeter } from "@ts-drp/room-worker/page";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** The bridge's per-frame meter: library cost less the app's rendering, and the app's named stages. */
describe("room worker: frame meter", () => {
	let frames: FrameRequestCallback[] = [];
	let restore: unknown;
	const frame = (): void => {
		const pending = frames;
		frames = [];
		for (const callback of pending) callback(0);
	};
	beforeEach(() => {
		frames = [];
		restore = Reflect.get(globalThis, "requestAnimationFrame");
		Reflect.set(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback): number => {
			frames.push(callback);
			return frames.length;
		});
	});
	afterEach(() => {
		Reflect.set(globalThis, "requestAnimationFrame", restore);
	});

	it("charges a message's handling less the app rendering it ran, per frame and per kind", () => {
		const meter = createRoomWorkerFrameMeter();
		meter.post("send:move", 0.25);
		meter.message("stream:projection", 2);
		frame();
		const reading = meter.control.read();
		expect(reading.library).toHaveLength(1);
		expect(reading.library[0]).toBeCloseTo(2.25, 6);
		expect(reading.kinds["post:send:move"]).toMatchObject({ count: 1, heavyFrames: 1 });
		expect(reading.kinds["stream:projection"]).toMatchObject({ count: 1, totalMs: 2, maxMs: 2, heavyFrames: 1 });
	});

	it("samples only the stages the app names, under the app's names", () => {
		const meter = createRoomWorkerFrameMeter({
			commands: { move: "moveHop" },
			streams: { transient: ["transientPacing", "transientHop", "transientFrameWait"] },
		});
		meter.command?.("move", 100, 103);
		meter.command?.("placeBlock", 100, 150);
		meter.stream?.("transient", 10, 14, 20);
		meter.stream?.("projection", 10, 50, 90);
		const reading = meter.control.read();
		expect(Object.keys(reading.latency).sort()).toEqual([
			"moveHop",
			"transientFrameWait",
			"transientHop",
			"transientPacing",
		]);
		expect(reading.latency.moveHop).toEqual([3]);
		expect(reading.latency.transientPacing).toEqual([4]);
		expect(reading.latency.transientHop).toEqual([6]);
		// The frame wait is taken when a renderFrame callback runs after the value was handled.
		expect(reading.latency.transientFrameWait).toEqual([]);
		meter.renderFrame(() => undefined)(0);
		expect(meter.control.read().latency.transientFrameWait).toHaveLength(1);
		meter.control.reset();
		expect(meter.control.read().latency.moveHop).toEqual([]);
	});
});
