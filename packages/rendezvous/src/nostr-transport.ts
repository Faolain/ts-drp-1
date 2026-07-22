import type {
	NostrEvent,
	NostrFilter,
	NostrPublishResult,
	NostrRelayConnection,
	NostrRelayConnectionFactory,
} from "./nostr.js";

const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

type NostrWebSocketEventType = "close" | "error" | "message" | "open";
type NostrWebSocketListener = (event: Event) => void;

interface NostrWebSocket {
	readonly readyState: number;
	addEventListener(type: NostrWebSocketEventType, listener: NostrWebSocketListener): void;
	close(): void;
	removeEventListener(type: NostrWebSocketEventType, listener: NostrWebSocketListener): void;
	send(data: string): void;
}

interface NostrWebSocketConstructor {
	new (url: string): NostrWebSocket;
}

/** Dependencies and transport-local timeouts for a NIP-01 WebSocket connection. */
export interface NostrWebSocketTransportOptions {
	readonly openTimeoutMs?: number;
	readonly publishTimeoutMs?: number;
	readonly webSocketImpl?: NostrWebSocketConstructor;
}

/** Typed terminal for WebSocket configuration, lifecycle, and protocol availability failures. */
export class NostrWebSocketTransportError extends Error {
	/** @param message - Stable caller-facing transport failure detail. */
	constructor(message: string) {
		super(message);
		this.name = "NostrWebSocketTransportError";
	}
}

interface SubscriptionState {
	aborted: boolean;
	complete: boolean;
	detachAbort?(): void;
	error?: NostrWebSocketTransportError;
	readonly events: NostrEvent[];
	readonly subscriptionId: string;
	wake?(): void;
	wireClosed: boolean;
}

interface PendingPublish {
	reject(error: unknown): void;
	resolve(result: NostrPublishResult): void;
}

/**
 * Creates a browser-safe NIP-01 relay connection factory.
 * @param options - Injectable WebSocket constructor and transport-local open/publish deadlines.
 * @returns A factory suitable for `NostrRelayDirectoryOptions.connectionFactory`.
 */
export function createNostrWebSocketRelayFactory(
	options: NostrWebSocketTransportOptions = {}
): NostrRelayConnectionFactory {
	const webSocketImpl = options.webSocketImpl ?? globalThis.WebSocket;
	if (webSocketImpl === undefined) {
		throw new NostrWebSocketTransportError(
			"WebSocket is not available in this environment; inject webSocketImpl to use the Nostr transport"
		);
	}
	const openTimeoutMs = positiveInteger(options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS, "openTimeoutMs");
	const publishTimeoutMs = positiveInteger(options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS, "publishTimeoutMs");

	return async (relay, signal): Promise<NostrRelayConnection> => {
		signal.throwIfAborted();
		let socket: NostrWebSocket;
		try {
			socket = new webSocketImpl(relay.url);
		} catch {
			throw new NostrWebSocketTransportError(`Failed to construct WebSocket for Nostr relay ${relay.id}`);
		}
		await waitForOpen(socket, relay.id, signal, openTimeoutMs);
		try {
			signal.throwIfAborted();
			return new WebSocketRelayConnection(socket, publishTimeoutMs);
		} catch (error) {
			closeSocket(socket);
			throw error;
		}
	};
}

class WebSocketRelayConnection implements NostrRelayConnection {
	readonly #socket: NostrWebSocket;
	readonly #publishTimeoutMs: number;
	readonly #publishes = new Map<string, Set<PendingPublish>>();
	readonly #queries = new Set<SubscriptionState>();
	readonly #subscriptions = new Map<string, SubscriptionState>();
	#closed = false;
	#subscriptionCounter = 0;

	readonly #onMessage = (event: Event): void => this.#handleMessage(event);
	readonly #onError = (): void => this.#terminate(new NostrWebSocketTransportError("Nostr relay socket error"), true);
	readonly #onClose = (): void => this.#terminate(new NostrWebSocketTransportError("Nostr relay socket closed"), false);

	constructor(socket: NostrWebSocket, publishTimeoutMs: number) {
		this.#socket = socket;
		this.#publishTimeoutMs = publishTimeoutMs;
		socket.addEventListener("message", this.#onMessage);
		socket.addEventListener("error", this.#onError);
		socket.addEventListener("close", this.#onClose);
	}

	close(): void {
		this.#terminate(new NostrWebSocketTransportError("Nostr relay connection closed"), true);
	}

	publish(event: NostrEvent, signal: AbortSignal): Promise<NostrPublishResult> {
		try {
			this.#assertOpen();
			signal.throwIfAborted();
		} catch (error) {
			return Promise.reject(error);
		}

		return new Promise<NostrPublishResult>((resolve, reject) => {
			let settled = false;
			const pending: PendingPublish = {
				reject: (error: unknown): void => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(error);
				},
				resolve: (result: NostrPublishResult): void => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve(result);
				},
			};
			const abort = (): void => pending.reject(signal.reason);
			const cleanup = (): void => {
				clearTimeout(timeout);
				signal.removeEventListener("abort", abort);
				const matching = this.#publishes.get(event.id);
				matching?.delete(pending);
				if (matching?.size === 0) this.#publishes.delete(event.id);
			};

			const matching = this.#publishes.get(event.id) ?? new Set<PendingPublish>();
			matching.add(pending);
			this.#publishes.set(event.id, matching);
			signal.addEventListener("abort", abort, { once: true });
			const timeout = setTimeout(
				() =>
					pending.reject(new NostrWebSocketTransportError(`Nostr publish timed out after ${this.#publishTimeoutMs}ms`)),
				this.#publishTimeoutMs
			);
			try {
				this.#socket.send(JSON.stringify(["EVENT", event]));
			} catch {
				pending.reject(new NostrWebSocketTransportError("Failed to send Nostr EVENT frame"));
			}
		});
	}

	async *query(filter: NostrFilter, signal: AbortSignal): AsyncIterable<NostrEvent> {
		this.#assertOpen();
		signal.throwIfAborted();
		const subscriptionId = `ts-drp-${this.#subscriptionCounter}`;
		this.#subscriptionCounter += 1;
		const state: SubscriptionState = {
			aborted: false,
			complete: false,
			events: [],
			subscriptionId,
			wireClosed: false,
		};
		const abort = (): void => {
			state.aborted = true;
			state.events.length = 0;
			this.#releaseQuery(state);
			state.wake?.();
		};
		state.detachAbort = (): void => signal.removeEventListener("abort", abort);
		signal.addEventListener("abort", abort, { once: true });
		this.#queries.add(state);
		this.#subscriptions.set(subscriptionId, state);

		try {
			this.#socket.send(JSON.stringify(["REQ", subscriptionId, filter]));
			while (true) {
				if (state.aborted) return;
				const event = state.events.shift();
				if (event !== undefined) {
					yield event;
					continue;
				}
				if (state.error !== undefined) throw state.error;
				if (state.complete) return;
				await new Promise<void>((resolve) => {
					state.wake = resolve;
				});
				state.wake = undefined;
			}
		} catch (error) {
			if (error instanceof NostrWebSocketTransportError) throw error;
			throw new NostrWebSocketTransportError("Failed to send or receive Nostr subscription frames");
		} finally {
			this.#releaseQuery(state);
			state.wake = undefined;
		}
	}

	#assertOpen(): void {
		if (this.#closed || this.#socket.readyState !== SOCKET_OPEN) {
			throw new NostrWebSocketTransportError("Nostr relay connection is closed");
		}
	}

	#handleMessage(event: Event): void {
		const frame = parseFrame(event);
		if (frame === undefined) return;
		if (frame[0] === "EVENT") {
			const subscriptionId = frame[1];
			const nostrEvent = frame[2];
			if (typeof subscriptionId !== "string" || !isNostrEvent(nostrEvent)) return;
			const state = this.#subscriptions.get(subscriptionId);
			if (state === undefined || state.complete || state.aborted || state.error !== undefined) return;
			state.events.push(nostrEvent);
			state.wake?.();
			return;
		}
		if (frame[0] === "EOSE" || frame[0] === "CLOSED") {
			const subscriptionId = frame[1];
			if (typeof subscriptionId !== "string") return;
			const state = this.#subscriptions.get(subscriptionId);
			if (state === undefined) return;
			state.complete = true;
			this.#closeSubscriptionWire(state);
			state.wake?.();
			return;
		}
		if (frame[0] !== "OK") return;
		const eventId = frame[1];
		const accepted = frame[2];
		const message = frame[3];
		if (typeof eventId !== "string" || typeof accepted !== "boolean" || typeof message !== "string") return;
		const pending = this.#publishes.get(eventId)?.values().next().value;
		pending?.resolve({ accepted, message });
	}

	#sendSubscriptionClose(subscriptionId: string): void {
		if (this.#closed || this.#socket.readyState !== SOCKET_OPEN) return;
		try {
			this.#socket.send(JSON.stringify(["CLOSE", subscriptionId]));
		} catch {
			// Best-effort subscription cleanup must not replace its terminal result.
		}
	}

	#closeSubscriptionWire(state: SubscriptionState): void {
		if (state.wireClosed) return;
		state.wireClosed = true;
		if (this.#subscriptions.get(state.subscriptionId) === state) {
			this.#subscriptions.delete(state.subscriptionId);
		}
		this.#sendSubscriptionClose(state.subscriptionId);
	}

	#releaseQuery(state: SubscriptionState): void {
		this.#queries.delete(state);
		this.#closeSubscriptionWire(state);
		state.detachAbort?.();
		state.detachAbort = undefined;
	}

	#terminate(error: NostrWebSocketTransportError, close: boolean): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket.removeEventListener("message", this.#onMessage);
		this.#socket.removeEventListener("error", this.#onError);
		this.#socket.removeEventListener("close", this.#onClose);

		for (const pendingSet of [...this.#publishes.values()]) {
			for (const pending of [...pendingSet]) pending.reject(error);
		}
		this.#publishes.clear();
		for (const state of [...this.#queries]) {
			state.events.length = 0;
			state.error = error;
			this.#releaseQuery(state);
			state.wake?.();
		}
		this.#queries.clear();
		this.#subscriptions.clear();
		if (close) closeSocket(this.#socket);
	}
}

function parseFrame(event: Event): unknown[] | undefined {
	if (!("data" in event) || typeof event.data !== "string") return undefined;
	try {
		const parsed = JSON.parse(event.data) as unknown;
		return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isNostrEvent(value: unknown): value is NostrEvent {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"id" in value &&
		typeof value.id === "string" &&
		"pubkey" in value &&
		typeof value.pubkey === "string" &&
		"created_at" in value &&
		Number.isSafeInteger(value.created_at) &&
		"kind" in value &&
		Number.isSafeInteger(value.kind) &&
		"tags" in value &&
		Array.isArray(value.tags) &&
		value.tags.every((tag) => Array.isArray(tag) && tag.every((entry) => typeof entry === "string")) &&
		"content" in value &&
		typeof value.content === "string" &&
		"sig" in value &&
		typeof value.sig === "string"
	);
}

async function waitForOpen(
	socket: NostrWebSocket,
	relayId: string,
	signal: AbortSignal,
	timeoutMs: number
): Promise<void> {
	if (socket.readyState === SOCKET_OPEN) return;
	if (socket.readyState !== SOCKET_CONNECTING) {
		closeSocket(socket);
		throw new NostrWebSocketTransportError(`Nostr relay ${relayId} socket closed before opening`);
	}
	signal.throwIfAborted();

	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const cleanup = (): void => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
		};
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			cleanup();
			closeSocket(socket);
			reject(error);
		};
		const onAbort = (): void => fail(signal.reason);
		const onOpen = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};
		const onError = (): void =>
			fail(new NostrWebSocketTransportError(`Nostr relay ${relayId} socket errored before opening`));
		const onClose = (): void =>
			fail(new NostrWebSocketTransportError(`Nostr relay ${relayId} socket closed before opening`));
		const timeout = setTimeout(
			() => fail(new NostrWebSocketTransportError(`Nostr relay ${relayId} open timed out after ${timeoutMs}ms`)),
			timeoutMs
		);

		signal.addEventListener("abort", onAbort, { once: true });
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
	});
}

function closeSocket(socket: NostrWebSocket): void {
	if (socket.readyState !== SOCKET_CONNECTING && socket.readyState !== SOCKET_OPEN) return;
	try {
		socket.close();
	} catch {
		// Cleanup is best effort after the transport has already reached a terminal.
	}
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
	return value;
}
