import {
	createNostrRelayDirectory,
	createNostrSignerFromSecretKey,
	createNostrWebSocketRelayFactory,
	type NostrEvent,
	type NostrFilter,
	type NostrRelayConnection,
	type NostrRelayConnectionFactory,
	NostrWebSocketTransportError,
	type NostrWebSocketTransportOptions,
} from "@ts-drp/rendezvous";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NAMESPACE, NOW, signedFixture, validator } from "./fixtures.js";

const RELAY = { id: "relay-a", url: "wss://relay-a.example" } as const;

describe("Nostr WebSocket transport", () => {
	beforeEach(() => FakeWebSocket.reset());
	afterEach(() => vi.unstubAllGlobals());

	it("sends REQ, yields matching events through EOSE, sends CLOSE, and cleans up", async () => {
		const { connection, socket } = await openConnection();
		const filter: NostrFilter = { "#n": [NAMESPACE], "kinds": [30_078], "limit": 3 };
		const iterator = connection.query(filter, signal())[Symbol.asyncIterator]();
		const first = iterator.next();
		const subscriptionId = reqSubscriptionId(socket, filter);
		const events = [nostrEvent(1), nostrEvent(2), nostrEvent(3)];

		for (const event of events) socket.message(JSON.stringify(["EVENT", subscriptionId, event]));
		socket.message(JSON.stringify(["EOSE", subscriptionId]));
		expect(socket.sentFrames.filter((frame) => frame[0] === "CLOSE")).toHaveLength(1);

		expect(await first).toEqual({ done: false, value: events[0] });
		expect(await iterator.next()).toEqual({ done: false, value: events[1] });
		expect(await iterator.next()).toEqual({ done: false, value: events[2] });
		expect(await iterator.next()).toEqual({ done: true, value: undefined });
		expect(socket.sentFrames.filter((frame) => frame[0] === "CLOSE")).toHaveLength(1);

		await connection.close();
		expect(socket.listenerCount).toBe(0);
		expect(socket.closeCalls).toBe(1);
	});

	it("buffers events between consumer pulls and preserves their order", async () => {
		const { connection, socket } = await openConnection();
		const iterator = connection.query({}, signal())[Symbol.asyncIterator]();
		const first = iterator.next();
		const subscriptionId = reqSubscriptionId(socket, {});
		const events = [nostrEvent(4), nostrEvent(5), nostrEvent(6)];

		for (const event of events) socket.message(JSON.stringify(["EVENT", subscriptionId, event]));
		socket.message(JSON.stringify(["EOSE", subscriptionId]));
		await expect(first).resolves.toEqual({ done: false, value: events[0] });
		await Promise.resolve();

		await expect(iterator.next()).resolves.toEqual({ done: false, value: events[1] });
		await Promise.resolve();
		await expect(iterator.next()).resolves.toEqual({ done: false, value: events[2] });
		await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
		await connection.close();
	});

	it("drains an EOSE-completed query after the connection closes", async () => {
		const { connection, socket } = await openConnection();
		const iterator = connection.query({}, signal())[Symbol.asyncIterator]();
		const first = iterator.next();
		const subscriptionId = reqSubscriptionId(socket, {});
		const events = [nostrEvent(40), nostrEvent(41)];

		for (const event of events) socket.message(JSON.stringify(["EVENT", subscriptionId, event]));
		socket.message(JSON.stringify(["EOSE", subscriptionId]));
		await expect(first).resolves.toEqual({ done: false, value: events[0] });

		await connection.close();

		await expect(iterator.next()).resolves.toEqual({ done: false, value: events[1] });
		await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
		expect(socket.listenerCount).toBe(0);
	});

	it("skips malformed, wrong-shape, and mismatched-subscription frames", async () => {
		const { connection, socket } = await openConnection();
		const iterator = connection.query({}, signal())[Symbol.asyncIterator]();
		const pending = iterator.next();
		const subscriptionId = reqSubscriptionId(socket, {});
		const valid = nostrEvent(7);

		socket.message("not-json");
		socket.message(JSON.stringify({ type: "EVENT" }));
		socket.message(JSON.stringify(["EVENT", "another-subscription", nostrEvent(8)]));
		socket.message(JSON.stringify(["EVENT", subscriptionId, null]));
		socket.message(JSON.stringify(["EVENT", subscriptionId, valid]));
		socket.message(JSON.stringify(["EOSE", subscriptionId]));

		await expect(pending).resolves.toEqual({ done: false, value: valid });
		await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
		await connection.close();
	});

	it("treats relay CLOSED as a subscription failure without replying CLOSE", async () => {
		const { connection, socket } = await openConnection();
		const controller = new AbortController();
		const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
		const iterator = connection.query({}, controller.signal)[Symbol.asyncIterator]();
		const pending = iterator.next();
		const subscriptionId = reqSubscriptionId(socket, {});

		socket.message(JSON.stringify(["CLOSED", subscriptionId, "auth-required: sign in"]));

		await expect(pending).rejects.toMatchObject({
			message: expect.stringContaining("auth-required: sign in"),
			name: "NostrWebSocketTransportError",
		});
		expect(socket.sentFrames.filter((frame) => frame[0] === "CLOSE")).toHaveLength(0);
		expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
		await connection.close();
		expect(socket.listenerCount).toBe(0);
	});

	it("throws the abort reason after one event and cleans up the subscription", async () => {
		const { connection, socket } = await openConnection();
		const controller = new AbortController();
		const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
		const iterator = connection.query({}, controller.signal)[Symbol.asyncIterator]();
		const first = iterator.next();
		const subscriptionId = reqSubscriptionId(socket, {});
		const event = nostrEvent(9);
		const reason = new Error("caller stopped query");
		socket.message(JSON.stringify(["EVENT", subscriptionId, event]));

		await expect(first).resolves.toEqual({ done: false, value: event });
		const pending = iterator.next();
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
		expect(socket.sentFrames.filter((frame) => frame[0] === "CLOSE")).toHaveLength(1);
		expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
		await connection.close();
		expect(socket.listenerCount).toBe(0);
	});

	it("early iterator return closes exactly once, detaches abort, and leaves the socket usable", async () => {
		const { connection, socket } = await openConnection();
		const controller = new AbortController();
		const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
		const iterator = connection.query({}, controller.signal)[Symbol.asyncIterator]();
		const first = iterator.next();
		const subscriptionId = reqSubscriptionId(socket, {});
		const events = [nostrEvent(50), nostrEvent(51), nostrEvent(52)];

		for (const event of events) socket.message(JSON.stringify(["EVENT", subscriptionId, event]));
		await expect(first).resolves.toEqual({ done: false, value: events[0] });
		if (iterator.return === undefined) throw new Error("expected async iterator return");

		await expect(iterator.return()).resolves.toEqual({ done: true, value: undefined });
		expect(socket.sentFrames.filter((frame) => frame[0] === "CLOSE")).toHaveLength(1);
		expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));

		const publishedEvent = nostrEvent(53);
		const published = connection.publish(publishedEvent, signal());
		socket.message(JSON.stringify(["OK", publishedEvent.id, true, "still open"]));
		await expect(published).resolves.toEqual({ accepted: true, message: "still open" });
		await connection.close();
		expect(socket.listenerCount).toBe(0);
		expect(socket.closeCalls).toBe(1);
		expect(socket.sentFrames.filter((frame) => frame[0] === "CLOSE")).toHaveLength(1);
	});

	it("detaches query abort handling when close occurs while the generator is paused", async () => {
		const { connection, socket } = await openConnection();
		const controller = new AbortController();
		const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
		const iterator = connection.query({}, controller.signal)[Symbol.asyncIterator]();
		const first = iterator.next();
		const subscriptionId = reqSubscriptionId(socket, {});
		const event = nostrEvent(10);
		socket.message(JSON.stringify(["EVENT", subscriptionId, event]));
		await expect(first).resolves.toEqual({ done: false, value: event });

		await connection.close();

		expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
		await expect(iterator.next()).rejects.toBeInstanceOf(NostrWebSocketTransportError);
		expect(socket.listenerCount).toBe(0);
	});

	it.each(["error", "close"] as const)("throws when the socket emits %s mid-query and cleans up", async (kind) => {
		const { connection, socket } = await openConnection();
		const iterator = connection.query({}, signal())[Symbol.asyncIterator]();
		const pending = iterator.next();
		reqSubscriptionId(socket, {});

		if (kind === "error") socket.error();
		else socket.remoteClose();

		await expect(pending).rejects.toBeInstanceOf(NostrWebSocketTransportError);
		expect(socket.listenerCount).toBe(0);
		await connection.close();
	});

	it("publishes EVENT frames and resolves accepted and rejected matching OK replies", async () => {
		const { connection, socket } = await openConnection();
		const acceptedEvent = nostrEvent(10);
		const accepted = connection.publish(acceptedEvent, signal());
		expect(socket.sentFrames.at(-1)).toEqual(["EVENT", acceptedEvent]);
		socket.message(JSON.stringify(["OK", "unrelated-id", true, "ignored"]));
		socket.message(JSON.stringify(["OK", acceptedEvent.id, true, "stored"]));
		await expect(accepted).resolves.toEqual({ accepted: true, message: "stored" });

		const rejectedEvent = nostrEvent(11);
		const rejected = connection.publish(rejectedEvent, signal());
		socket.message(JSON.stringify(["OK", rejectedEvent.id, false, "blocked"]));
		await expect(rejected).resolves.toEqual({ accepted: false, message: "blocked" });
		await connection.close();
		expect(socket.listenerCount).toBe(0);
	});

	it("accepts an OK frame whose optional message is omitted", async () => {
		const { connection, socket } = await openConnection({ publishTimeoutMs: 5 });
		const event = nostrEvent(42);
		const published = connection.publish(event, signal());

		socket.message(JSON.stringify(["OK", event.id, true]));

		await expect(published).resolves.toEqual({ accepted: true, message: "" });
		await connection.close();
	});

	it("resolves concurrent publishes of the same event id FIFO and reuses the evicted queue", async () => {
		const { connection, socket } = await openConnection();
		const event = nostrEvent(60);
		const first = connection.publish(event, signal());
		const second = connection.publish(event, signal());

		socket.message(JSON.stringify(["OK", event.id, true, "first reply"]));
		socket.message(JSON.stringify(["OK", event.id, false, "second reply"]));

		await expect(Promise.all([first, second])).resolves.toEqual([
			{ accepted: true, message: "first reply" },
			{ accepted: false, message: "second reply" },
		]);

		expect(() => socket.message(JSON.stringify(["OK", event.id, true, "late reply"]))).not.toThrow();
		const third = connection.publish(event, signal());
		socket.message(JSON.stringify(["OK", event.id, true, "fresh queue"]));
		await expect(third).resolves.toEqual({ accepted: true, message: "fresh queue" });
		await connection.close();
	});

	it("ignores OK frames after a publish has resolved or timed out", async () => {
		const { connection, socket } = await openConnection({ publishTimeoutMs: 5 });
		const resolvedEvent = nostrEvent(61);
		const resolved = connection.publish(resolvedEvent, signal());
		socket.message(JSON.stringify(["OK", resolvedEvent.id, true, "stored"]));
		await expect(resolved).resolves.toEqual({ accepted: true, message: "stored" });

		expect(() => socket.message(JSON.stringify(["OK", resolvedEvent.id, true, "late"]))).not.toThrow();

		const timedOutEvent = nostrEvent(62);
		await expect(connection.publish(timedOutEvent, signal())).rejects.toThrow(/timed out/iu);
		expect(() => socket.message(JSON.stringify(["OK", timedOutEvent.id, true, "too late"]))).not.toThrow();
		await connection.close();
	});

	it("rejects publish timeout, caller abort, and close-before-OK without leaks", async () => {
		const timed = await openConnection({ publishTimeoutMs: 5 });
		await expect(timed.connection.publish(nostrEvent(12), signal())).rejects.toThrow(/timed out/iu);
		await timed.connection.close();

		const aborted = await openConnection();
		const controller = new AbortController();
		const reason = new Error("caller stopped publish");
		const abortedPublish = aborted.connection.publish(nostrEvent(13), controller.signal);
		controller.abort(reason);
		await expect(abortedPublish).rejects.toBe(reason);
		await aborted.connection.close();

		const closed = await openConnection();
		const closedPublish = closed.connection.publish(nostrEvent(14), signal());
		closed.socket.remoteClose();
		await expect(closedPublish).rejects.toBeInstanceOf(NostrWebSocketTransportError);

		for (const socket of FakeWebSocket.instances) expect(socket.listenerCount).toBe(0);
	});

	it("opens successfully and rejects every bounded pre-open failure path", async () => {
		const opened = await openConnection();
		await opened.connection.close();

		for (const failure of ["error", "close"] as const) {
			const pending = createFactory()({ ...RELAY }, signal());
			const socket = requiredLastSocket();
			if (failure === "error") socket.error();
			else socket.remoteClose();
			await expect(pending).rejects.toBeInstanceOf(NostrWebSocketTransportError);
			expect(socket.listenerCount).toBe(0);
			expect(socket.readyState).toBe(3);
			if (failure === "error") expect(socket.closeCalls).toBe(1);
		}

		const timeout = createFactory({ openTimeoutMs: 5 })({ ...RELAY }, signal());
		const timeoutSocket = requiredLastSocket();
		await expect(timeout).rejects.toThrow(/timed out/iu);
		expect(timeoutSocket.listenerCount).toBe(0);
		expect(timeoutSocket.closeCalls).toBe(1);

		const controller = new AbortController();
		const reason = new Error("already aborted");
		controller.abort(reason);
		const instanceCount = FakeWebSocket.instances.length;
		await expect(createFactory()({ ...RELAY }, controller.signal)).rejects.toBe(reason);
		expect(FakeWebSocket.instances).toHaveLength(instanceCount);
	});

	it("throws a typed configuration error when WebSocket is unavailable", () => {
		vi.stubGlobal("WebSocket", undefined);

		expect(() => createNostrWebSocketRelayFactory()).toThrow(NostrWebSocketTransportError);
		expect(() => createNostrWebSocketRelayFactory()).toThrow(/WebSocket.*available/iu);
	});

	it.each([
		["openTimeoutMs", { openTimeoutMs: 0 }],
		["publishTimeoutMs", { publishTimeoutMs: 0 }],
	] as const)("throws a typed configuration error for invalid %s", (name, options) => {
		expect(() => createFactory(options)).toThrow(NostrWebSocketTransportError);
		expect(() => createFactory(options)).toThrow(`${name} must be a positive integer`);
	});

	it("closes idempotently, removes listeners, and rejects operations after close", async () => {
		const { connection, socket } = await openConnection();

		await connection.close();
		await connection.close();

		expect(socket.closeCalls).toBe(1);
		expect(socket.listenerCount).toBe(0);
		await expect(connection.publish(nostrEvent(15), signal())).rejects.toBeInstanceOf(NostrWebSocketTransportError);
		const query = connection.query({}, signal())[Symbol.asyncIterator]();
		await expect(query.next()).rejects.toBeInstanceOf(NostrWebSocketTransportError);
	});

	it("round-trips register and discover through the real directory and frame transport", async () => {
		const storedEvents: NostrEvent[] = [];
		FakeWebSocket.autoOpen = true;
		FakeWebSocket.onSend = (socket, data): void => {
			const frame = JSON.parse(data) as unknown;
			if (!Array.isArray(frame)) return;
			if (frame[0] === "EVENT" && isNostrEvent(frame[1])) {
				storedEvents.push(frame[1]);
				socket.message(JSON.stringify(["OK", frame[1].id, true, "stored"]));
				return;
			}
			if (frame[0] === "REQ" && typeof frame[1] === "string") {
				for (const event of storedEvents) socket.message(JSON.stringify(["EVENT", frame[1], event]));
				socket.message(JSON.stringify(["EOSE", frame[1]]));
			}
		};
		const directory = createNostrRelayDirectory({
			connectionFactory: createFactory(),
			nostrSigner: createNostrSignerFromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
			now: (): number => NOW,
			relays: [{ ...RELAY }],
			validatorFactory: (): ReturnType<typeof validator> => validator(),
		});
		const record = await signedFixture(1_001);

		await expect(directory.register(record, signal())).resolves.toMatchObject({
			acceptedEndpointIds: [RELAY.id],
			sequence: record.sequence,
		});
		await expect(directory.discover(NAMESPACE, signal())).resolves.toMatchObject([
			{ admissionMode: "open", record, sourceEndpointId: RELAY.id },
		]);
		expect(storedEvents).toHaveLength(1);
		expect(FakeWebSocket.instances).toHaveLength(2);
		for (const socket of FakeWebSocket.instances) expect(socket.listenerCount).toBe(0);
	});
});

function createFactory(
	options: Omit<NostrWebSocketTransportOptions, "webSocketImpl"> = {}
): NostrRelayConnectionFactory {
	return createNostrWebSocketRelayFactory({ ...options, webSocketImpl: FakeWebSocket });
}

async function openConnection(
	options: Omit<NostrWebSocketTransportOptions, "webSocketImpl"> = {}
): Promise<{ readonly connection: NostrRelayConnection; readonly socket: FakeWebSocket }> {
	const pending = createFactory(options)({ ...RELAY }, signal());
	const socket = requiredLastSocket();
	socket.open();
	return { connection: await pending, socket };
}

function requiredLastSocket(): FakeWebSocket {
	const socket = FakeWebSocket.instances.at(-1);
	if (socket === undefined) throw new Error("expected a fake WebSocket instance");
	return socket;
}

function reqSubscriptionId(socket: FakeWebSocket, filter: NostrFilter): string {
	const frame = socket.sentFrames.find((candidate) => candidate[0] === "REQ");
	expect(frame).toEqual(["REQ", expect.any(String), filter]);
	const subscriptionId = frame?.[1];
	if (typeof subscriptionId !== "string") throw new Error("expected a REQ subscription ID");
	return subscriptionId;
}

function signal(): AbortSignal {
	return new AbortController().signal;
}

function nostrEvent(index: number): NostrEvent {
	return {
		id: index.toString(16).padStart(64, "0"),
		pubkey: "11".repeat(32),
		created_at: Math.floor(NOW / 1_000) + index,
		kind: 30_078,
		tags: [["n", NAMESPACE]],
		content: JSON.stringify({ index }),
		sig: "22".repeat(64),
	};
}

function isNostrEvent(value: unknown): value is NostrEvent {
	return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string";
}

type FakeSocketEventType = "close" | "error" | "message" | "open";
type FakeSocketListener = (event: Event) => void;

class FakeWebSocket {
	static autoOpen = false;
	static instances: FakeWebSocket[] = [];
	static onSend: ((socket: FakeWebSocket, data: string) => void) | undefined;

	static reset(): void {
		this.autoOpen = false;
		this.instances = [];
		this.onSend = undefined;
	}

	readonly url: string;
	readyState = 0;
	closeCalls = 0;
	readonly sent: string[] = [];
	readonly #listeners = new Map<FakeSocketEventType, Set<FakeSocketListener>>();

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
		if (FakeWebSocket.autoOpen) queueMicrotask(() => this.open());
	}

	get listenerCount(): number {
		return [...this.#listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
	}

	get sentFrames(): readonly unknown[][] {
		return this.sent.map((data) => JSON.parse(data) as unknown[]);
	}

	addEventListener(type: FakeSocketEventType, listener: FakeSocketListener): void {
		const listeners = this.#listeners.get(type) ?? new Set<FakeSocketListener>();
		listeners.add(listener);
		this.#listeners.set(type, listeners);
	}

	removeEventListener(type: FakeSocketEventType, listener: FakeSocketListener): void {
		this.#listeners.get(type)?.delete(listener);
	}

	send(data: string): void {
		if (this.readyState !== 1) throw new Error("fake WebSocket is not open");
		this.sent.push(data);
		FakeWebSocket.onSend?.(this, data);
	}

	close(): void {
		this.closeCalls += 1;
		this.readyState = 3;
	}

	open(): void {
		if (this.readyState !== 0) return;
		this.readyState = 1;
		this.dispatch("open", new Event("open"));
	}

	message(data: string): void {
		if (this.readyState !== 1) return;
		this.dispatch("message", new MessageEvent<string>("message", { data }));
	}

	error(): void {
		this.dispatch("error", new Event("error"));
	}

	remoteClose(): void {
		this.readyState = 3;
		this.dispatch("close", new Event("close"));
	}

	private dispatch(type: FakeSocketEventType, event: Event): void {
		for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
	}
}
