import { afterEach, describe, expect, it } from "vitest";

import { type Harness, harness, settle } from "./fixture.js";

/**
 * With a meter, the page measures the bridge's latency: each stream value carries when the app emitted
 * it and when the worker sent it, and each command reports when the page posted it and when the worker
 * handled it. Without one, no message carries times. Measurement only.
 */
const open: Harness[] = [];
afterEach(() => {
	for (const entry of open.splice(0)) {
		entry.page.close();
		entry.worker.close();
	}
});

describe("room worker: bridge latency measurement", () => {
	it("reports stream and command times in order when the page measures", async () => {
		const streams: [string, number, number, number][] = [];
		const commands: [string, number, number][] = [];
		const created = harness({
			measure: {
				stream: (name, emittedAt, sentAt, receivedAt) => streams.push([name, emittedAt, sentAt, receivedAt]),
				command: (name, postedAt, handledAt) => commands.push([name, postedAt, handledAt]),
			},
		});
		open.push(created);
		await created.client.ready;
		await created.client.call("emitThenReturn", 1);
		await settle();
		expect(commands.map(([name]) => name)).toEqual(["emitThenReturn"]);
		const [, postedAt, handledAt] = commands[0] as [string, number, number];
		expect(handledAt).toBeGreaterThanOrEqual(postedAt);
		expect(streams.map(([name]) => name)).toEqual(["projection"]);
		const [, emittedAt, sentAt, receivedAt] = streams[0] as [string, number, number, number];
		expect(sentAt).toBeGreaterThanOrEqual(emittedAt);
		expect(receivedAt).toBeGreaterThanOrEqual(sentAt);
	});

	it("sends no times without a meter", async () => {
		const created = harness();
		open.push(created);
		const wire: unknown[] = [];
		created.page.addEventListener("message", (event) => wire.push(event.data));
		created.worker.addEventListener("message", (event) => wire.push(event.data));
		await created.client.ready;
		await created.client.call("emitThenReturn", 1);
		await settle();
		expect(wire.length).toBeGreaterThan(0);
		const timed = wire.filter((entry) => {
			const message = entry as { k?: unknown; measure?: unknown };
			return "t" in message || message.k === "measure" || message.measure === true;
		});
		expect(timed).toEqual([]);
	});
});
