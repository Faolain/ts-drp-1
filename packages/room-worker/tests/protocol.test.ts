import { describe, expect, it } from "vitest";

import {
	call,
	defineRoomWorkerContract,
	isCommandName,
	latest,
	parsePageMessage,
	parseWorkerMessage,
	ROOM_WORKER_PROTOCOL,
	send,
} from "@ts-drp/room-worker";

const header = { p: ROOM_WORKER_PROTOCOL, s: 7 };

describe("room worker protocol", () => {
	it("accepts the page's messages of the right session and shape", () => {
		expect(parsePageMessage({ ...header, k: "call", id: 1, name: "placeBlock", args: [{ id: "b" }] }, 7)).toMatchObject({ k: "call" });
		expect(parsePageMessage({ ...header, k: "send", id: 2, name: "fabric.run", args: [] }, 7)).toMatchObject({ k: "send" });
		expect(parsePageMessage({ ...header, k: "credit", name: "projection" }, 7)).toMatchObject({ k: "credit" });
		expect(parsePageMessage({ ...header, k: "close" }, 7)).toMatchObject({ k: "close" });
	});

	it("refuses another protocol, another session, a bad id or name, an unknown kind, extra fields", () => {
		const good = { ...header, k: "call", id: 1, name: "echo", args: [] };
		expect(parsePageMessage({ ...good, p: "other" }, 7)).toBeUndefined();
		expect(parsePageMessage(good, 8)).toBeUndefined();
		expect(parsePageMessage({ ...good, id: 0 }, 7)).toBeUndefined();
		expect(parsePageMessage({ ...good, id: 1.5 }, 7)).toBeUndefined();
		expect(parsePageMessage({ ...good, name: "__proto__" }, 7)).toBeUndefined();
		expect(parsePageMessage({ ...good, name: "a..b" }, 7)).toBeUndefined();
		expect(parsePageMessage({ ...good, args: "x" }, 7)).toBeUndefined();
		expect(parsePageMessage({ ...good, args: new Array(65).fill(0) }, 7)).toBeUndefined();
		expect(parsePageMessage({ ...good, k: "eval" }, 7)).toBeUndefined();
		expect(parsePageMessage({ ...good, extra: true }, 7)).toBeUndefined();
		expect(parsePageMessage(null, 7)).toBeUndefined();
		expect(parsePageMessage("call", 7)).toBeUndefined();
	});

	it("accepts the worker's booted message before a session exists", () => {
		expect(parseWorkerMessage({ p: ROOM_WORKER_PROTOCOL, s: 0, k: "booted", missing: [] }, 7)).toMatchObject({ k: "booted" });
		expect(parseWorkerMessage({ ...header, k: "result", id: 3, ok: true, value: 1 }, 7)).toMatchObject({ k: "result" });
		expect(parseWorkerMessage({ ...header, k: "result", id: 3, ok: true, value: 1 }, 9)).toBeUndefined();
	});

	it("command names are dotted identifiers, never prototype keys", () => {
		for (const name of ["move", "fabric.run", "a1.b2.c3"]) expect(isCommandName(name)).toBe(true);
		for (const name of ["", "1a", "a.", ".a", "__proto__", "constructor", "a.__proto__", "prototype", "x".repeat(65)])
			expect(isCommandName(name)).toBe(false);
	});

	it("a contract is checked and frozen", () => {
		const contract = defineRoomWorkerContract({
			name: "c",
			version: 1,
			commands: { move: send(), place: call() },
			streams: { projection: latest() },
			hooks: ["authority"],
		});
		expect(Object.isFrozen(contract)).toBe(true);
		expect(Object.isFrozen(contract.commands)).toBe(true);
		expect(() => defineRoomWorkerContract({ name: "c", version: 1, commands: { constructor: call() }, streams: {}, hooks: [] })).toThrow(
			TypeError
		);
		expect(() =>
			defineRoomWorkerContract({ name: "c", version: 0, commands: {}, streams: {}, hooks: [] })
		).toThrow(TypeError);
	});
});
