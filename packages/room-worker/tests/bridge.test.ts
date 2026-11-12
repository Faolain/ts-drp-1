import {
	defineRoomWorkerContract,
	ROOM_WORKER_PROTOCOL,
	RoomWorkerClosed,
	RoomWorkerCrashed,
	RoomWorkerLimit,
	RoomWorkerProtocolError,
} from "@ts-drp/room-worker";
import { afterEach, describe, expect, it } from "vitest";

import { FieldError, type Harness, harness, settle } from "./fixture.js";

const open: Harness[] = [];
const make = (...args: Parameters<typeof harness>): Harness => {
	const created = harness(...args);
	open.push(created);
	return created;
};
afterEach(() => {
	for (const entry of open.splice(0)) {
		entry.page.close();
		entry.worker.close();
	}
});

describe("room worker bridge: commands", () => {
	it("opens the app with the page's init data and resolves ready with its info", async () => {
		const { client, log } = make();
		await expect(client.ready).resolves.toEqual({ opened: true });
		expect(client.state).toBe("ready");
		expect(log[0]).toEqual(["open", { room: "r1" }]);
	});

	it("a call resolves with the app's value; a typed rejection keeps its class and fields", async () => {
		const { client } = make();
		await client.ready;
		await expect(client.call("echo", { nested: [1, "two", new Uint8Array([3])] })).resolves.toEqual({
			nested: [1, "two", new Uint8Array([3])],
		});
		const refused = await client.call("fail", 12).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(FieldError);
		expect((refused as FieldError).epoch).toBe(12);
		await expect(client.call("nested.ping")).resolves.toBe("pong");
	});

	it("a send command validates on the page synchronously, exactly like the main-thread method", async () => {
		const { client } = make();
		await client.ready;
		expect(() => client.send("move", 0.5, 1)).toThrow(new TypeError("move is not an integer step"));
	});

	it("a refused send reaches the page with its correlation id and command name", async () => {
		const { client } = make();
		await client.ready;
		const refusals: unknown[] = [];
		client.onRefused((refusal) => refusals.push(refusal));
		const first = client.send("refuse", 3);
		const second = client.send("refuse", 4);
		expect(second).not.toBe(first);
		await settle();
		expect(refusals).toHaveLength(2);
		expect(refusals[0]).toMatchObject({ id: first, command: "refuse" });
		expect((refusals[0] as { error: FieldError }).error).toBeInstanceOf(FieldError);
		expect((refusals[1] as { id: number; error: FieldError }).id).toBe(second);
		expect((refusals[1] as { id: number; error: FieldError }).error.epoch).toBe(4);
	});

	it("commands reach the app in the page's order, sends and calls interleaved, none merged", async () => {
		const { client, log } = make();
		await client.ready;
		for (let index = 0; index < 50; index++) {
			client.send("move", index, -index);
			if (index % 10 === 0) void client.call("echo", index);
		}
		await client.call("echo", "done");
		const moves = log.filter((entry) => (entry as unknown[])[0] === "move");
		expect(moves).toEqual(Array.from({ length: 50 }, (_, index) => ["move", index, -index]));
	});

	it("refuses a command the contract does not name, on the page", async () => {
		const { client } = make();
		await client.ready;
		expect(() => client.send("echo" as "move", 1, 1)).toThrow(TypeError);
		await expect(client.call("move" as "echo", 1)).rejects.toThrow(TypeError);
		await expect(client.call("toString" as "echo", undefined)).rejects.toThrow(TypeError);
	});

	it("the worker refuses a forged command outside the contract", async () => {
		const { client, page } = make();
		await client.ready;
		const session = (client as unknown as { session: number }).session;
		const replies: unknown[] = [];
		page.addEventListener("message", (event) => replies.push(event.data));
		page.postMessage({ p: ROOM_WORKER_PROTOCOL, s: session, k: "call", id: 999_999, name: "secret", args: [] });
		await settle();
		const reply = replies.find((entry) => (entry as { id?: number }).id === 999_999) as { ok: boolean } | undefined;
		expect(reply?.ok).toBe(false);
	});

	it("bounds the calls in flight", async () => {
		const { client } = make({ maxInFlight: 2 });
		await client.ready;
		void client.call("hold");
		void client.call("hold");
		await expect(client.call("echo", 1)).rejects.toBeInstanceOf(RoomWorkerLimit);
	});

	it("refuses an app built for another contract version", async () => {
		const { client } = make({}, { version: 2 });
		await expect(client.ready).rejects.toBeInstanceOf(RoomWorkerProtocolError);
	});
});

describe("room worker bridge: streams", () => {
	it("a latest stream sends at most one value per page frame and always ends on the newest", async () => {
		const { client, context, flushFrames } = make();
		await client.ready;
		const seen: unknown[] = [];
		client.on("projection", (value) => seen.push(value));
		for (let index = 1; index <= 100; index++) context().emit("projection", { value: index });
		await settle();
		expect(seen).toEqual([{ value: 1 }]);
		flushFrames();
		await settle();
		expect(seen).toEqual([{ value: 1 }, { value: 100 }]);
		flushFrames();
		await settle();
		expect(seen).toHaveLength(2);
		expect(client.latest("projection")).toEqual({ value: 100 });
	});

	it("after a call resolves, the page has every stream value the worker had when it completed", async () => {
		const { client, context } = make();
		await client.ready;
		context().emit("projection", { value: 0 });
		await settle();
		await expect(client.call("emitThenReturn", 5)).resolves.toBe(5);
		expect(client.latest("projection")).toEqual({ value: 5 });
	});

	it("streams are independent", async () => {
		const { client, context, flushFrames } = make();
		await client.ready;
		context().emit("projection", { p: 1 });
		context().emit("transient", { t: 1 });
		context().emit("transient", { t: 2 });
		await settle();
		flushFrames();
		await settle();
		expect(client.latest("projection")).toEqual({ p: 1 });
		expect(client.latest("transient")).toEqual({ t: 2 });
	});
});

describe("room worker bridge: message-paced streams (movement)", () => {
	it("a message-paced stream sends its next value as soon as the page has handled one, not at a frame", async () => {
		const { client, context, frames } = make();
		await client.ready;
		const seen: unknown[] = [];
		client.on("movement", (value) => seen.push(value));
		for (let index = 1; index <= 3; index++) {
			context().emit("movement", { m: index });
			await settle();
		}
		expect(frames).toHaveLength(0);
		expect(seen).toEqual([{ m: 1 }, { m: 2 }, { m: 3 }]);
	});

	it("keeps one value in flight: a burst reaches the page as its first and newest values", async () => {
		const { client, context } = make();
		await client.ready;
		const seen: unknown[] = [];
		client.on("movement", (value) => seen.push(value));
		for (let index = 1; index <= 5; index++) context().emit("movement", { m: index });
		await settle();
		expect(seen).toEqual([{ m: 1 }, { m: 5 }]);
	});

	it("rejects an unknown pace", () => {
		expect(() =>
			defineRoomWorkerContract({
				name: "bad",
				version: 1,
				commands: {},
				streams: { s: { kind: "latest", pace: "never" } as never },
				hooks: [],
			})
		).toThrow(TypeError);
	});
});

describe("room worker bridge: lifecycle", () => {
	it("close runs the app's close once; later calls reject RoomWorkerClosed", async () => {
		const { client, closed } = make();
		await client.ready;
		await client.close();
		await client.close();
		expect(closed.count).toBe(1);
		expect(client.state).toBe("closed");
		await expect(client.call("echo", 1)).rejects.toBeInstanceOf(RoomWorkerClosed);
		expect(() => client.send("move", 1, 1)).toThrow(RoomWorkerClosed);
	});

	it("a crash rejects every call in flight with RoomWorkerCrashed and ignores a late reply", async () => {
		const { client, releaseHold } = make();
		await client.ready;
		const crashes: unknown[] = [];
		client.onCrash((error) => crashes.push(error));
		const pending = client.call("hold");
		await settle();
		client.crash("terminated by the test");
		releaseHold("late");
		const rejected = await pending.catch((error: unknown) => error);
		expect(rejected).toBeInstanceOf(RoomWorkerCrashed);
		expect((rejected as RoomWorkerCrashed).reason).toBe("terminated by the test");
		await settle();
		expect(crashes).toHaveLength(1);
		expect(client.state).toBe("crashed");
		await expect(client.call("echo", 1)).rejects.toBeInstanceOf(RoomWorkerCrashed);
	});

	it("drops a message from another session", async () => {
		const { client, worker } = make();
		await client.ready;
		const session = (client as unknown as { session: number }).session;
		worker.postMessage({
			p: ROOM_WORKER_PROTOCOL,
			s: session + 1,
			k: "stream",
			name: "projection",
			value: { forged: true },
		});
		await settle();
		expect(client.latest("projection")).toBeUndefined();
	});
});

describe("room worker bridge: host hooks, storage, diagnostics", () => {
	it("a page hook returns data and a handle whose own methods only the worker may call", async () => {
		const { client } = make();
		await client.ready;
		const result = (await client.call("useHook")) as {
			scope: string;
			bytes: number[];
			doubled: number;
			refused: string;
		};
		expect(result.scope).toBe("scope:o1");
		expect(result.bytes).toEqual([1, 2, 3]);
		expect(result.doubled).toBe(42);
		expect(result.refused).toBe("secret absent");
	});

	it("an absent page hook is undefined in the worker", async () => {
		const { client } = make({ hooks: {} });
		await client.ready;
		await expect(client.call("useHook")).resolves.toBe("no hook");
	});

	it("an aborted hook call settles in the worker at once, and the page's signal aborts", async () => {
		const { client, pageAbortSignals } = make();
		await client.ready;
		await expect(client.call("abortHook")).resolves.toBe("cancelled by the room");
		await settle();
		expect(pageAbortSignals).toHaveLength(1);
		expect(pageAbortSignals[0]?.aborted).toBe(true);
	});

	it("worker storage is seeded from the page and writes through to it", async () => {
		const written: [string, string][] = [];
		const { client } = make({
			storage: {
				entries: [["peer-cache", "cached"]],
				set: (key, value) => written.push([key, value]),
				remove: () => undefined,
			},
		});
		await client.ready;
		await expect(client.call("storage", "peer-cache", "fresh")).resolves.toBe("cached");
		await settle();
		expect(written).toEqual([["peer-cache-written", "fresh"]]);
	});

	it("diagnostics arrive in order when the page asks for them, and not otherwise", async () => {
		const seen: unknown[] = [];
		const { client, context } = make({ onDiagnostic: (name, value) => seen.push([name, value]) });
		await client.ready;
		for (let index = 0; index < 5; index++) context().diagnostic("stage", { index });
		await settle();
		expect(seen).toEqual(Array.from({ length: 5 }, (_, index) => ["stage", { index }]));

		const quiet = make();
		await quiet.client.ready;
		expect(quiet.context().diagnosticsEnabled).toBe(false);
	});
});
