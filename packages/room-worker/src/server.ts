/**
 * The worker side of a room worker: it opens the app's room with the page's init data, runs the
 * contract's commands in the page's order, publishes latest-value streams under the page's frame
 * credit, and reaches page hooks through handles the page owns. serveRoomWorker (worker.ts) binds it
 * to the worker's global scope.
 */
import { contractEntry, type RoomWorkerContract } from "./contract.js";
import {
	decodeError,
	encodeError,
	RoomWorkerClosed,
	type RoomWorkerErrorCodec,
	RoomWorkerProtocolError,
} from "./errors.js";
import {
	ABORT_TAG,
	HANDLE_TAG,
	HOST_VALUE_MAX_DEPTH,
	type PageMessage,
	parsePageMessage,
	ROOM_WORKER_PROTOCOL,
	type RoomWorkerPort,
	type WorkerMessage,
} from "./protocol.js";

/** Storage the worker's code sees: seeded from the page, writing through to it. */
export interface RoomWorkerStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface RoomWorkerContext<Init = unknown> {
	/** The page's init data. */
	readonly init: Init;
	/**
	 * Publishes a stream's newest value. The page sees at most one value per frame and always the
	 * newest; the value is cloned when it is sent, so it must not be mutated after it is emitted.
	 */
	emit(stream: string, value: unknown, transfer?: Transferable[]): void;
	/** A page hook, or undefined when the page provides none of that name. */
	hook(name: string): ((...args: unknown[]) => Promise<unknown>) | undefined;
	readonly storage: RoomWorkerStorage;
	/** Whether the page asked for diagnostics. */
	readonly diagnosticsEnabled: boolean;
	diagnostic(name: string, value: unknown): void;
}

export interface RoomWorkerSession {
	/** Structured data the page's `ready` resolves with. */
	readonly info?: unknown;
	/** The contract's commands, by name (own properties only are ever called). */
	readonly commands: Readonly<Record<string, (...args: never[]) => unknown>>;
	/** Closes the room (it joins admitted work) and its node. */
	close?(): void | Promise<void>;
}

export interface RoomWorkerApp<Init = unknown> {
	readonly contract: RoomWorkerContract;
	/** Codecs of the app's typed errors (they reach the page as the same classes). */
	readonly errors?: readonly RoomWorkerErrorCodec[];
	open(context: RoomWorkerContext<Init>): RoomWorkerSession | Promise<RoomWorkerSession>;
}

/**
 * Types an app definition (identity at runtime).
 * @param app - The app.
 * @returns The app.
 */
export function defineRoomWorkerApp<Init = unknown>(app: RoomWorkerApp<Init>): RoomWorkerApp<Init> {
	return app;
}

export interface RoomWorkerServerOptions {
	readonly port: RoomWorkerPort;
	readonly app: RoomWorkerApp<never> | RoomWorkerApp;
	/** Codecs besides the app's own; a function is read at each use (codecs loaded with the app). */
	readonly errors?: readonly RoomWorkerErrorCodec[] | (() => readonly RoomWorkerErrorCodec[]);
	/** Worker capabilities this host lacks; a non-empty list refuses to open (RoomWorkerUnsupported). */
	readonly missing?: readonly string[];
	/** Runs once the page's init arrives, before the app opens (worker.ts installs globals here). */
	beforeOpen?(
		context: Readonly<{
			init: unknown;
			diagnosticsEnabled: boolean;
			diagnostic: RoomWorkerContext["diagnostic"];
			post(message: unknown, transfer?: Transferable[]): void;
		}>
	): void | Promise<void>;
	/** Receives the page's RTC bridge messages. */
	readonly rtc?: Readonly<{ receive(message: unknown): void }>;
}

export interface RoomWorkerServer {
	/** The session once the page's init arrived, else 0. */
	readonly session: number;
	/** Posts an RTC bridge message to the page. */
	postRtc(message: unknown, transfer?: Transferable[]): void;
}

interface Stream {
	credit: boolean;
	pending: boolean;
	value: unknown;
	transfer: Transferable[];
}

interface HostPending {
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Creates the worker side of a room worker over a port.
 * @param options - Port, app, codecs and worker bindings.
 * @returns The server.
 */
export function createRoomWorkerServer(options: RoomWorkerServerOptions): RoomWorkerServer {
	const { port } = options;
	const app = options.app as RoomWorkerApp;
	const codecs = (): readonly RoomWorkerErrorCodec[] => [
		...(typeof options.errors === "function" ? options.errors() : (options.errors ?? [])),
		...(app.errors ?? []),
	];
	let session = 0;
	let opened: RoomWorkerSession | undefined;
	let opening = false;
	let closing = false;
	let closed = false;
	const waiting: PageMessage[] = [];
	const streams = new Map<string, Stream>();
	for (const name of Object.keys(app.contract.streams))
		streams.set(name, { credit: true, pending: false, value: undefined, transfer: [] });
	const hostPending = new Map<number, HostPending>();
	let nextHostCall = 1;
	let nextAbort = 1;
	const proxyHandles = new WeakMap<object, number>();
	const released: number[] = [];
	let releaseScheduled = false;
	const registry =
		typeof FinalizationRegistry === "function"
			? new FinalizationRegistry<number>((handle) => {
					released.push(handle);
					if (releaseScheduled || session === 0) return;
					releaseScheduled = true;
					setTimeout(() => {
						releaseScheduled = false;
						while (released.length > 0 && !closed)
							post({ ...header(), k: "host-release", handles: released.splice(0, 4096) });
					}, 0);
				})
			: undefined;

	const header = (): Readonly<{ p: typeof ROOM_WORKER_PROTOCOL; s: number }> => ({
		p: ROOM_WORKER_PROTOCOL,
		s: session,
	});
	const post = (message: WorkerMessage, transfer: Transferable[] = []): void => port.postMessage(message, transfer);
	const reply = (message: WorkerMessage, fallbackId?: number): void => {
		try {
			post(message);
		} catch (error) {
			// A value the structured clone algorithm refuses (a function, say) fails the call, typed.
			if (fallbackId !== undefined)
				post({ ...header(), k: "result", id: fallbackId, ok: false, error: encodeError(error, codecs()) });
		}
	};

	const sendStream = (name: string, entry: Stream): void => {
		const transfer = entry.transfer;
		entry.pending = false;
		entry.transfer = [];
		post({ ...header(), k: "stream", name, value: entry.value }, transfer);
	};
	// Read-your-writes: before a call's result, the page gets every stream value pending now.
	const flush = (): void => {
		for (const [name, entry] of streams) if (entry.pending) sendStream(name, entry);
	};

	// --- page hooks ----------------------------------------------------------------------------
	const encodeHostArgs = (value: unknown, depth: number, signals: AbortSignal[]): unknown => {
		if (depth > HOST_VALUE_MAX_DEPTH) throw new RoomWorkerProtocolError("a host argument is nested too deeply");
		if (typeof value === "function") throw new TypeError("a function cannot cross to a page hook");
		if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
			return value;
		if (typeof AbortSignal === "function" && value instanceof AbortSignal) {
			signals.push(value);
			return { [ABORT_TAG]: nextAbort + signals.length - 1 };
		}
		const handle = proxyHandles.get(value);
		if (handle !== undefined) return { [HANDLE_TAG]: handle };
		if (Array.isArray(value)) return value.map((entry) => encodeHostArgs(entry, depth + 1, signals));
		if (!isPlainRecord(value)) return value;
		const encoded: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			if (key === HANDLE_TAG || key === ABORT_TAG)
				throw new RoomWorkerProtocolError("a host argument uses a reserved key");
			encoded[key] = encodeHostArgs(value[key], depth + 1, signals);
		}
		return encoded;
	};

	const decodeHostValue = (value: unknown, depth: number): unknown => {
		if (depth > HOST_VALUE_MAX_DEPTH) throw new RoomWorkerProtocolError("a host value is nested too deeply");
		if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
			return value;
		if (Array.isArray(value)) return value.map((entry) => decodeHostValue(entry, depth + 1));
		if (!isPlainRecord(value)) return value;
		if (Object.prototype.hasOwnProperty.call(value, HANDLE_TAG)) {
			const id = value[HANDLE_TAG];
			const methods = value.methods;
			if (!Number.isSafeInteger(id) || !Array.isArray(methods) || !isPlainRecord(value.data))
				throw new RoomWorkerProtocolError("a page handle is malformed");
			const proxy: Record<string, unknown> = {};
			for (const [key, entry] of Object.entries(value.data)) proxy[key] = decodeHostValue(entry, depth + 1);
			for (const method of methods) {
				if (typeof method !== "string") throw new RoomWorkerProtocolError("a page handle method is malformed");
				proxy[method] = (...args: unknown[]): Promise<unknown> => hostCall("", id as number, method, args);
			}
			proxyHandles.set(proxy, id as number);
			registry?.register(proxy, id as number);
			return proxy;
		}
		const decoded: Record<string, unknown> = {};
		for (const key of Object.keys(value)) decoded[key] = decodeHostValue(value[key], depth + 1);
		return decoded;
	};

	const hostCall = (hook: string, handle: number | null, method: string | null, args: unknown[]): Promise<unknown> => {
		if (closed) return Promise.reject(new RoomWorkerClosed());
		const signals: AbortSignal[] = [];
		let encoded: unknown[];
		try {
			encoded = encodeHostArgs(args, 0, signals) as unknown[];
		} catch (error) {
			return Promise.reject(error);
		}
		const firstAbort = nextAbort;
		nextAbort += signals.length;
		const id = nextHostCall++;
		return new Promise<unknown>((resolve, reject) => {
			const cleanups: (() => void)[] = [];
			const settle = (): void => {
				hostPending.delete(id);
				for (const cleanup of cleanups) cleanup();
			};
			hostPending.set(id, {
				resolve: (value) => {
					settle();
					resolve(value);
				},
				reject: (error) => {
					settle();
					reject(error);
				},
			});
			signals.forEach((signal, index) => {
				const abortId = firstAbort + index;
				// The call settles in the worker the moment its signal aborts: the page's answer is not
				// awaited (a hook must settle on abort; an unresponsive page cannot hold the room).
				const onAbort = (): void => {
					if (!closed) post({ ...header(), k: "host-abort", id: abortId });
					hostPending.get(id)?.reject(signal.reason);
				};
				if (signal.aborted) queueMicrotask(onAbort);
				else {
					signal.addEventListener("abort", onAbort, { once: true });
					cleanups.push(() => signal.removeEventListener("abort", onAbort));
				}
			});
			post({ ...header(), k: "host-call", id, hook: handle === null ? hook : "handle", handle, method, args: encoded });
		});
	};

	// --- the app's context -----------------------------------------------------------------------
	const makeContext = (message: Extract<PageMessage, { k: "init" }>): RoomWorkerContext => {
		const store = new Map<string, string>(message.storage ?? []);
		const pageHooks = new Set(message.hooks.filter((name) => app.contract.hooks.includes(name)));
		const diagnosticsEnabled = message.diagnostics;
		return Object.freeze({
			init: message.init,
			emit(stream: string, value: unknown, transfer: Transferable[] = []): void {
				const entry = streams.get(stream);
				if (entry === undefined) throw new TypeError(`room worker stream ${stream} is not in the contract`);
				if (closed) return;
				entry.value = value;
				entry.transfer = transfer;
				entry.pending = true;
				if (entry.credit) {
					entry.credit = false;
					sendStream(stream, entry);
				}
			},
			hook(name: string) {
				if (!app.contract.hooks.includes(name)) throw new TypeError(`room worker hook ${name} is not in the contract`);
				if (!pageHooks.has(name)) return undefined;
				return (...args: unknown[]) => hostCall(name, null, null, args);
			},
			storage: Object.freeze({
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => {
					const text = String(value);
					store.set(key, text);
					if (!closed) post({ ...header(), k: "storage", key, value: text });
				},
				removeItem: (key: string) => {
					store.delete(key);
					if (!closed) post({ ...header(), k: "storage", key, value: null });
				},
			}),
			diagnosticsEnabled,
			diagnostic(name: string, value: unknown): void {
				if (diagnosticsEnabled && !closed) post({ ...header(), k: "diagnostic", name, value });
			},
		});
	};

	// --- commands --------------------------------------------------------------------------------
	const command = (message: Extract<PageMessage, { k: "call" | "send" }>): void => {
		const refuse = (error: unknown): void => {
			flush();
			if (message.k === "call")
				reply({ ...header(), k: "result", id: message.id, ok: false, error: encodeError(error, codecs()) });
			else post({ ...header(), k: "refused", id: message.id, name: message.name, error: encodeError(error, codecs()) });
		};
		if (closing || closed || opened === undefined) {
			refuse(new RoomWorkerClosed());
			return;
		}
		const spec = contractEntry(app.contract.commands, message.name);
		const commands = opened.commands;
		const fn = Object.prototype.hasOwnProperty.call(commands, message.name) ? commands[message.name] : undefined;
		if (spec?.kind !== message.k || typeof fn !== "function") {
			refuse(
				new RoomWorkerProtocolError(`command ${message.name} is not a ${message.k} command of ${app.contract.name}`)
			);
			return;
		}
		let result: unknown;
		try {
			// Invoked as the message arrives, so commands reach the room in the page's order.
			result = (fn as (...values: unknown[]) => unknown).apply(commands, message.args as unknown[]);
		} catch (error) {
			refuse(error);
			return;
		}
		if (message.k === "send") {
			if (result !== null && typeof result === "object" && typeof (result as PromiseLike<unknown>).then === "function")
				Promise.resolve(result).catch(refuse);
			return;
		}
		Promise.resolve(result).then((value) => {
			flush();
			reply({ ...header(), k: "result", id: message.id, ok: true, value }, message.id);
		}, refuse);
	};

	const close = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		try {
			await opened?.close?.();
		} catch (error) {
			if (session !== 0)
				post({ ...header(), k: "diagnostic", name: "close-failed", value: encodeError(error, codecs()) });
		}
		closed = true;
		for (const entry of hostPending.values()) entry.reject(new RoomWorkerClosed());
		hostPending.clear();
		if (session !== 0) post({ ...header(), k: "closed" });
		port.removeEventListener("message", onMessage);
	};

	const open = async (message: Extract<PageMessage, { k: "init" }>): Promise<void> => {
		if (message.contract.name !== app.contract.name || message.contract.version !== app.contract.version) {
			post({
				...header(),
				k: "fatal",
				error: encodeError(
					new RoomWorkerProtocolError(
						`the page speaks ${message.contract.name} v${message.contract.version}, this worker ${app.contract.name} v${app.contract.version}`
					),
					codecs()
				),
			});
			closed = true;
			return;
		}
		const context = makeContext(message);
		try {
			await options.beforeOpen?.({
				init: message.init,
				diagnosticsEnabled: context.diagnosticsEnabled,
				diagnostic: context.diagnostic,
				post: (value, transfer) => port.postMessage(value, transfer ?? []),
			});
			const session_ = await app.open(context);
			if (session_ === null || typeof session_ !== "object" || typeof session_.commands !== "object")
				throw new RoomWorkerProtocolError("the app's open returned no commands");
			opened = session_;
			reply({ ...header(), k: "ready", info: session_.info ?? null });
		} catch (error) {
			post({ ...header(), k: "fatal", error: encodeError(error, codecs()) });
			closed = true;
			return;
		}
		for (const queued of waiting.splice(0)) handle(queued);
	};

	function handle(message: PageMessage): void {
		switch (message.k) {
			case "init":
				return;
			case "call":
			case "send":
				if (opening && opened === undefined && !closed) waiting.push(message);
				else command(message);
				return;
			case "credit": {
				const entry = streams.get(message.name);
				if (entry === undefined) return;
				if (entry.pending) sendStream(message.name, entry);
				else entry.credit = true;
				return;
			}
			case "host-result": {
				const entry = hostPending.get(message.id);
				if (entry === undefined) return;
				if (message.ok) {
					let value: unknown;
					try {
						value = decodeHostValue(message.value, 0);
					} catch (error) {
						entry.reject(error);
						return;
					}
					entry.resolve(value);
				} else entry.reject(decodeError(message.error, codecs()));
				return;
			}
			case "close":
				if (opening && opened === undefined && !closed) waiting.push(message);
				else void close();
				return;
			case "rtc":
				options.rtc?.receive(message.m);
				return;
		}
	}

	function onMessage(event: MessageEvent): void {
		if (session === 0) {
			// Only an init opens a session; it names the session every later message must carry.
			const data = event.data as Record<string, unknown> | null;
			const candidate = data !== null && typeof data === "object" ? data.s : undefined;
			if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) return;
			const message = parsePageMessage(event.data, candidate as number);
			if (message?.k !== "init") return;
			session = candidate as number;
			if ((options.missing ?? []).length > 0) {
				post({ p: ROOM_WORKER_PROTOCOL, s: 0, k: "booted", missing: options.missing ?? [] });
				closed = true;
				return;
			}
			opening = true;
			void open(message);
			return;
		}
		const message = parsePageMessage(event.data, session);
		if (message === undefined || (closed && message.k !== "host-result")) return;
		handle(message);
	}

	port.addEventListener("message", onMessage);
	return {
		get session(): number {
			return session;
		},
		postRtc(message: unknown, transfer: Transferable[] = []): void {
			if (session !== 0 && !closed) post({ ...header(), k: "rtc", m: message }, transfer);
		},
	};
}
