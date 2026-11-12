/**
 * Page entry of @ts-drp/room-worker: open an app's room in a dedicated worker.
 *
 * The page keeps rendering, input, identity and the real RTCPeerConnections; the worker owns the
 * node, the room, its IndexedDB stores, the codec and signing. See the package README for the rules
 * (what crosses, crash ambiguity, fallback when the browser cannot host the room in a worker).
 */
import {
	type CommandMap,
	createRoomWorkerClient,
	type RoomWorkerClient,
	type RoomWorkerClientOptions,
	type RoomWorkerPageStorage,
} from "./client.js";
import { RoomWorkerUnsupported } from "./errors.js";
import type { RoomWorkerPort } from "./protocol.js";
import { createPageRtcHost } from "./rtc-page.js";

export {
	createRoomWorkerClient,
	isStructuredBuiltin,
	ROOM_WORKER_DEFAULT_MAX_HANDLES,
	ROOM_WORKER_DEFAULT_MAX_IN_FLIGHT,
	type CommandMap,
	type RoomWorkerClient,
	type RoomWorkerClientOptions,
	type RoomWorkerPageStorage,
	type RoomWorkerSendRefusal,
	type RoomWorkerState,
} from "./client.js";
export { createPageRtcHost, type PageRtcHost } from "./rtc-page.js";

export interface OpenRoomWorkerOptions<Commands extends CommandMap = CommandMap>
	extends Omit<RoomWorkerClientOptions<Commands>, "port" | "rtc" | "onStopped" | "storage"> {
	/** Creates the app's worker: `new Worker(new URL("./room.worker.ts", import.meta.url), { type: "module" })`. */
	spawn(): Worker;
	/** localStorage keys the worker's storage mirrors (the browser-local peer cache key, say). */
	readonly localStorageKeys?: readonly string[];
	/** Uncaught errors inside the worker (default console.error). They do not stop the room. */
	onWorkerError?(message: string): void;
	/**
	 * Measures the bridge's main-thread cost: each worker message's handling (its kind, and the time
	 * its listeners took, rendering included) and each post. Measurement only.
	 */
	readonly meter?: RoomWorkerMeter;
}

export interface RoomWorkerMeter {
	/** A worker message was handled; `kind` is its protocol kind, refined by stream, hook or RTC operation. */
	message(kind: string, ms: number): void;
	/** A message was posted to the worker; `kind` as for message. */
	post(kind: string, ms: number): void;
}

/**
 * A message's kind for the meter: the protocol kind, refined by stream name, host hook and method,
 * command name or RTC operation.
 * @param data - A protocol message.
 * @returns The kind.
 */
function meterKind(data: unknown): string {
	if (typeof data !== "object" || data === null) return "unknown";
	const message = data as { k?: unknown; name?: unknown; hook?: unknown; method?: unknown; m?: unknown };
	if (typeof message.k !== "string") return "unknown";
	switch (message.k) {
		case "stream":
		case "call":
		case "send":
		case "credit":
		case "refused":
			return `${message.k}:${String(message.name)}`;
		case "host-call":
			return `host-call:${String(message.hook)}.${String(message.method)}`;
		case "rtc": {
			const rtc = message.m as { t?: unknown; method?: unknown } | null;
			return `rtc:${String(rtc?.t)}${typeof rtc?.method === "string" ? `.${rtc.method}` : ""}`;
		}
		default:
			return message.k;
	}
}

function meteredPort(worker: Worker, meter: RoomWorkerMeter): RoomWorkerPort {
	const wrapped = new Map<(event: MessageEvent) => void, (event: MessageEvent) => void>();
	return {
		postMessage(message, transfer = []): void {
			const started = performance.now();
			worker.postMessage(message, transfer);
			meter.post(meterKind(message), performance.now() - started);
		},
		addEventListener(type, listener): void {
			const measured = (event: MessageEvent): void => {
				const started = performance.now();
				const data: unknown = event.data;
				listener(event);
				meter.message(meterKind(data), performance.now() - started);
			};
			wrapped.set(listener, measured);
			worker.addEventListener(type, measured);
		},
		removeEventListener(type, listener): void {
			const measured = wrapped.get(listener);
			if (measured === undefined) return;
			wrapped.delete(listener);
			worker.removeEventListener(type, measured);
		},
	};
}

export interface RoomWorkerHandle<Commands extends CommandMap = CommandMap> extends RoomWorkerClient<Commands> {
	/**
	 * Stops the worker now (a browser SIGKILL for the room): calls in flight reject with
	 * RoomWorkerCrashed and their outcome is unknown until the room is reopened.
	 */
	terminate(reason?: string): void;
}

function pageStorage(keys: readonly string[]): RoomWorkerPageStorage {
	const allowed = new Set(keys);
	const entries: [string, string][] = [];
	for (const key of allowed) {
		const value = localStorage.getItem(key);
		if (value !== null) entries.push([key, value]);
	}
	return {
		entries,
		set: (key, value): void => {
			if (allowed.has(key)) localStorage.setItem(key, value);
		},
		remove: (key): void => {
			if (allowed.has(key)) localStorage.removeItem(key);
		},
	};
}

/**
 * Opens an app's room in a dedicated worker. `ready` rejects with RoomWorkerUnsupported when this
 * browser cannot host it there; the app then opens the room on the main thread as before.
 * @param options - The worker factory, contract, init data, hooks, codecs and page bindings.
 * @returns The handle; await `ready` before relying on the room.
 */
export function openRoomWorker<Commands extends CommandMap = CommandMap>(
	options: OpenRoomWorkerOptions<Commands>
): RoomWorkerHandle<Commands> {
	const missing = [
		...(typeof Worker === "function" ? [] : ["Worker"]),
		...(typeof RTCPeerConnection === "function" ? [] : ["RTCPeerConnection"]),
	];
	if (missing.length > 0) throw new RoomWorkerUnsupported(missing);
	const worker = options.spawn();
	// The RTC host posts through the client only once the worker asks it for a connection.
	const rtcHost = createPageRtcHost((message, transfer) => client.postRtc(message, transfer));
	let terminated = false;
	const terminateWorker = (): void => {
		if (terminated) return;
		terminated = true;
		worker.terminate();
		rtcHost.close();
	};
	const client = createRoomWorkerClient<Commands>({
		...options,
		port: options.meter === undefined ? (worker as unknown as RoomWorkerPort) : meteredPort(worker, options.meter),
		...(options.localStorageKeys === undefined ? {} : { storage: pageStorage(options.localStorageKeys) }),
		rtc: { receive: (message) => rtcHost.receive(message) },
		onStopped: terminateWorker,
	});
	worker.addEventListener("error", (event) => {
		const text = `room worker error: ${event.message}`;
		if (options.onWorkerError !== undefined) options.onWorkerError(text);
		else console.error(text);
	});
	// A message that cannot be deserialized breaks the protocol's order: the room's state as the page
	// sees it is no longer trustworthy, so the worker is stopped.
	worker.addEventListener("messageerror", () => client.crash("a worker message could not be deserialized"));
	const handle = Object.create(client) as RoomWorkerHandle<Commands>;
	Object.defineProperty(handle, "terminate", {
		value: (reason = "terminated by the page") => {
			// The worker is terminated before onCrash listeners release what the page lent it.
			terminateWorker();
			client.crash(reason);
		},
	});
	return handle;
}
