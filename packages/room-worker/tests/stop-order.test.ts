import { defineRoomWorkerContract } from "@ts-drp/room-worker";
import { openRoomWorker } from "@ts-drp/room-worker/page";
import { afterEach, describe, expect, it } from "vitest";

import { type Harness, harness, settle } from "./fixture.js";

/**
 * What the page lent a worker (a native read reservation, say) is released from onCrash. It must be
 * released only once the worker is stopped for good: never because a call is slow, and never before
 * worker.terminate() has run. A live worker that lost its reservation could read a torn image.
 */
const open: Harness[] = [];
afterEach(() => {
	for (const entry of open.splice(0)) {
		entry.page.close();
		entry.worker.close();
	}
});

describe("room worker: a worker is stopped before onCrash runs", () => {
	it("a slow but alive worker is never declared crashed: its call stays pending, no onCrash", async () => {
		const events: string[] = [];
		const created = harness({ onStopped: () => events.push("stopped") });
		open.push(created);
		const { client, releaseHold } = created;
		await client.ready;
		client.onCrash(() => events.push("crash"));
		let settled = false;
		const slow = client.call("hold").then(() => (settled = true));
		// Long past any plausible response time: the bridge has no timeout that stops a worker.
		await new Promise((resolve) => setTimeout(resolve, 300));
		await settle();
		expect(settled).toBe(false);
		expect(client.state).toBe("ready");
		expect(events).toEqual([]);
		releaseHold("late but alive");
		await slow;
		expect(events).toEqual([]);
	});

	it("the client stops (onStopped: the page terminates the worker) before any onCrash listener runs", async () => {
		const events: string[] = [];
		const created = harness({ onStopped: () => events.push("stopped") });
		open.push(created);
		const { client } = created;
		await client.ready;
		client.onCrash(() => events.push("crash"));
		client.crash("test");
		expect(events).toEqual(["stopped", "crash"]);
	});

	it("openRoomWorker's terminate() runs worker.terminate() before any onCrash listener", () => {
		const events: string[] = [];
		const restore = Reflect.get(globalThis, "RTCPeerConnection") as unknown;
		const restoreWorker = Reflect.get(globalThis, "Worker") as unknown;
		Reflect.set(globalThis, "RTCPeerConnection", function RTCPeerConnection(): void {});
		Reflect.set(globalThis, "Worker", function Worker(): void {});
		try {
			const fake = {
				postMessage: (): void => undefined,
				addEventListener: (): void => undefined,
				removeEventListener: (): void => undefined,
				terminate: (): void => void events.push("terminate"),
			};
			const handle = openRoomWorker({
				spawn: () => fake as unknown as Worker,
				contract: defineRoomWorkerContract({ name: "stop-order", version: 1, commands: {}, streams: {}, hooks: [] }),
				init: null,
			});
			handle.onCrash(() => events.push("crash"));
			handle.terminate("test");
			expect(events).toEqual(["terminate", "crash"]);
		} finally {
			Reflect.set(globalThis, "RTCPeerConnection", restore);
			Reflect.set(globalThis, "Worker", restoreWorker);
		}
	});
});
