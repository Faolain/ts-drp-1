/**
 * The page side of a room worker: commands out, results, refusals and latest-value streams in,
 * page hooks served to the worker. Transport-agnostic over a RoomWorkerPort (a dedicated Worker on
 * the page, or a MessagePort in tests); openRoomWorker (page.ts) binds it to a real Worker.
 */
import { contractEntry, type RoomWorkerContract } from "./contract.js";
import {
	decodeError,
	encodeError,
	RoomWorkerClosed,
	RoomWorkerCrashed,
	type RoomWorkerErrorCodec,
	RoomWorkerLimit,
	RoomWorkerProtocolError,
	RoomWorkerUnsupported,
} from "./errors.js";
import {
	ABORT_TAG,
	HANDLE_TAG,
	HOST_VALUE_MAX_DEPTH,
	type PageMessage,
	parseWorkerMessage,
	ROOM_WORKER_PROTOCOL,
	type RoomWorkerPort,
	type WorkerMessage,
} from "./protocol.js";

/** Calls in flight from one page client (bounded bridge work). */
export const ROOM_WORKER_DEFAULT_MAX_IN_FLIGHT = 256;
/** Page-owned hook handles the worker may hold at once. */
export const ROOM_WORKER_DEFAULT_MAX_HANDLES = 65_536;

// biome-ignore lint: an open signature map of commands.
export type CommandMap = { [name: string]: (...args: never[]) => unknown };

export type RoomWorkerState = "starting" | "ready" | "closing" | "closed" | "crashed";

/** A send command the worker refused: its correlation id (the value `send` returned) and error. */
export interface RoomWorkerSendRefusal {
	readonly id: number;
	readonly command: string;
	readonly error: Error;
}

/** Page storage the worker's storage writes through to (the page's localStorage, filtered). */
export interface RoomWorkerPageStorage {
	readonly entries: readonly (readonly [string, string])[];
	set(key: string, value: string): void;
	remove(key: string): void;
}

export interface RoomWorkerClientOptions<Commands extends CommandMap = CommandMap> {
	readonly contract: RoomWorkerContract;
	readonly port: RoomWorkerPort;
	/** Structured data the app's `open` receives in the worker. */
	readonly init: unknown;
	/** Page hooks the worker may call, by contract hook name. */
	readonly hooks?: Readonly<Record<string, (...args: never[]) => unknown>>;
	readonly errors?: readonly RoomWorkerErrorCodec[];
	readonly storage?: RoomWorkerPageStorage;
	/** Schedules a callback at the next page frame (default requestAnimationFrame). */
	frame?(callback: () => void): void;
	readonly maxInFlight?: number;
	readonly maxHandles?: number;
	/** Receives the worker's diagnostics; without it the worker sends none. */
	onDiagnostic?(name: string, value: unknown): void;
	/** Receives the worker's RTC bridge messages (page.ts). */
	readonly rtc?: Readonly<{ receive(message: unknown): void }>;
	/** Called once when the client stops for good (closed or crashed): terminate the worker here. */
	onStopped?(): void;
	/** Typing anchor only. */
	readonly commands?: Commands;
}

type Args<F> = F extends (...args: infer A) => unknown ? A : never;
type Result<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;

export interface RoomWorkerClient<Commands extends CommandMap = CommandMap> {
	/** Resolves with the app's ready info once the room is open in the worker. */
	readonly ready: Promise<unknown>;
	readonly state: RoomWorkerState;
	/** The session this client and its worker share. */
	readonly session: number;
	call<Name extends keyof Commands & string>(
		name: Name,
		...args: Args<Commands[Name]>
	): Promise<Result<Commands[Name]>>;
	/**
	 * Sends a fire-and-forget command. Bad arguments throw here, synchronously.
	 * @returns The send's correlation id; a refusal in the worker carries it.
	 */
	send<Name extends keyof Commands & string>(name: Name, ...args: Args<Commands[Name]>): number;
	/** The newest value of a stream the page has received. */
	latest(stream: string): unknown;
	on(stream: string, listener: (value: unknown) => void): () => void;
	onRefused(listener: (refusal: RoomWorkerSendRefusal) => void): () => void;
	onCrash(listener: (error: RoomWorkerCrashed) => void): () => void;
	/** Closes the app's room in the worker (it joins admitted work), then stops. */
	close(): Promise<void>;
	/** Marks the worker stopped: every call in flight rejects with RoomWorkerCrashed. */
	crash(reason: string): void;
	/** Posts an RTC bridge message to the worker (page.ts). */
	postRtc(message: unknown, transfer?: Transferable[]): void;
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

interface PageHandle {
	readonly object: object;
	readonly methods: ReadonlySet<string>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function methodNames(value: object): string[] {
	const names = new Set<string>();
	for (
		let current: object | null = value;
		current !== null && current !== Object.prototype;
		current = Object.getPrototypeOf(current)
	)
		for (const key of Object.getOwnPropertyNames(current))
			if (key !== "constructor" && typeof Reflect.get(value, key) === "function") names.add(key);
	return [...names];
}

/**
 * Values the structured clone algorithm carries whole (their methods are their type's, not an API).
 * @param value
 */
export function isStructuredBuiltin(value: object): boolean {
	return (
		value instanceof Map ||
		value instanceof Set ||
		value instanceof Date ||
		value instanceof RegExp ||
		value instanceof Error ||
		(typeof Blob === "function" && value instanceof Blob)
	);
}

function newSession(): number {
	const random = new Uint32Array(1);
	crypto.getRandomValues(random);
	return ((random[0] ?? 0) % 2_147_483_646) + 1;
}

const defaultFrame = (callback: () => void): void => {
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => callback());
	else setTimeout(callback, 16);
};

/**
 * Creates the page side of a room worker over a port.
 * @param options - Contract, port, init data, hooks, codecs and page bindings.
 * @returns The client.
 */
export function createRoomWorkerClient<Commands extends CommandMap = CommandMap>(
	options: RoomWorkerClientOptions<Commands>
): RoomWorkerClient<Commands> {
	const { contract, port } = options;
	const codecs = options.errors ?? [];
	const frame = options.frame ?? defaultFrame;
	const maxInFlight = options.maxInFlight ?? ROOM_WORKER_DEFAULT_MAX_IN_FLIGHT;
	const maxHandles = options.maxHandles ?? ROOM_WORKER_DEFAULT_MAX_HANDLES;
	const session = newSession();
	let state: RoomWorkerState = "starting";
	let crashError: RoomWorkerCrashed | undefined;
	let nextId = 1;
	const pending = new Map<number, Pending>();
	const queued: PageMessage[] = [];
	const latestValues = new Map<string, unknown>();
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const refusalListeners = new Set<(refusal: RoomWorkerSendRefusal) => void>();
	const crashListeners = new Set<(error: RoomWorkerCrashed) => void>();
	const creditScheduled = new Set<string>();
	const handles = new Map<number, PageHandle>();
	const handleIds = new WeakMap<object, number>();
	let nextHandle = 1;
	const aborts = new Map<number, AbortController>();
	const hooks = new Map<string, (...args: never[]) => unknown>();
	for (const name of contract.hooks) {
		const hook = options.hooks === undefined ? undefined : contractEntry(options.hooks, name);
		if (typeof hook === "function") hooks.set(name, hook);
	}

	let readyResolve!: (info: unknown) => void;
	let readyReject!: (error: unknown) => void;
	const ready = new Promise<unknown>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	ready.catch(() => undefined);
	let closeResolve: (() => void) | undefined;
	let closing: Promise<void> | undefined;
	let stopped = false;

	const post = (message: PageMessage, transfer: Transferable[] = []): void => port.postMessage(message, transfer);
	const header = { p: ROOM_WORKER_PROTOCOL, s: session } as const;

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		port.removeEventListener("message", onMessage);
		handles.clear();
		for (const controller of aborts.values()) controller.abort(new RoomWorkerClosed());
		aborts.clear();
		options.onStopped?.();
	};

	const crash = (reason: string, cause?: Error): void => {
		if (state === "crashed" || state === "closed") return;
		state = "crashed";
		crashError = new RoomWorkerCrashed(reason);
		readyReject(cause ?? crashError);
		for (const entry of pending.values()) entry.reject(crashError);
		pending.clear();
		queued.length = 0;
		closeResolve?.();
		for (const listener of crashListeners) listener(crashError);
		stop();
	};

	const finishClose = (): void => {
		if (state === "closed" || state === "crashed") return;
		state = "closed";
		const closed = new RoomWorkerClosed();
		readyReject(closed);
		for (const entry of pending.values()) entry.reject(closed);
		pending.clear();
		queued.length = 0;
		closeResolve?.();
		stop();
	};

	const unavailable = (): Error | undefined => {
		if (state === "crashed") return crashError;
		if (state === "closing" || state === "closed") return new RoomWorkerClosed();
		return undefined;
	};

	const dispatch = (message: PageMessage): void => {
		if (state === "starting") queued.push(message);
		else post(message);
	};

	// --- host hooks: values the page hands the worker -------------------------------------------
	const encodeHostValue = (value: unknown, depth: number): unknown => {
		if (depth > HOST_VALUE_MAX_DEPTH) throw new RoomWorkerProtocolError("a host value is nested too deeply");
		if (typeof value === "function") throw new TypeError("a page hook value cannot be a bare function");
		if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
			return value;
		if (Array.isArray(value)) return value.map((entry) => encodeHostValue(entry, depth + 1));
		if (isStructuredBuiltin(value)) return value;
		const plain = isPlainRecord(value);
		// A record exposes its own function properties; a class instance its methods.
		const methods = plain
			? Object.keys(value).filter((key) => typeof (value as Record<string, unknown>)[key] === "function")
			: methodNames(value);
		const data: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			if (key === HANDLE_TAG || key === ABORT_TAG)
				throw new RoomWorkerProtocolError("a host value uses a reserved key");
			const entry = (value as Record<string, unknown>)[key];
			if (typeof entry !== "function") data[key] = encodeHostValue(entry, depth + 1);
		}
		if (methods.length === 0) return data;
		let id = handleIds.get(value);
		if (id === undefined) {
			if (handles.size >= maxHandles) throw new RoomWorkerLimit("handles", maxHandles);
			id = nextHandle++;
			handleIds.set(value, id);
			handles.set(id, { object: value, methods: new Set(methods) });
		}
		return { [HANDLE_TAG]: id, data, methods };
	};

	const decodeHostArgs = (value: unknown, depth: number, used: number[]): unknown => {
		if (depth > HOST_VALUE_MAX_DEPTH) throw new RoomWorkerProtocolError("a host argument is nested too deeply");
		if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
			return value;
		if (Array.isArray(value)) return value.map((entry) => decodeHostArgs(entry, depth + 1, used));
		if (!isPlainRecord(value)) return value;
		const keys = Object.keys(value);
		if (keys.length === 1 && keys[0] === ABORT_TAG) {
			const id = value[ABORT_TAG];
			if (!Number.isSafeInteger(id)) throw new RoomWorkerProtocolError("an abort reference is invalid");
			let controller = aborts.get(id as number);
			if (controller === undefined) {
				controller = new AbortController();
				aborts.set(id as number, controller);
			}
			used.push(id as number);
			return controller.signal;
		}
		if (keys.length === 1 && keys[0] === HANDLE_TAG) {
			const handle = handles.get(value[HANDLE_TAG] as number);
			if (handle === undefined) throw new RoomWorkerProtocolError("a handle reference is unknown");
			return handle.object;
		}
		const decoded: Record<string, unknown> = {};
		for (const key of keys) decoded[key] = decodeHostArgs(value[key], depth + 1, used);
		return decoded;
	};

	const serveHostCall = (message: Extract<WorkerMessage, { k: "host-call" }>): void => {
		const used: number[] = [];
		Promise.resolve()
			.then(() => {
				const args = decodeHostArgs(message.args, 0, used) as unknown[];
				if (message.handle === null) {
					const hook = hooks.get(message.hook);
					if (hook === undefined) throw new TypeError(`page hook ${message.hook} is unavailable`);
					return (hook as (...values: unknown[]) => unknown)(...args);
				}
				const handle = handles.get(message.handle);
				if (handle === undefined || message.method === null || !handle.methods.has(message.method))
					throw new TypeError(`page handle method ${String(message.method)} is unavailable`);
				return (Reflect.get(handle.object, message.method) as (...values: unknown[]) => unknown).apply(
					handle.object,
					args
				);
			})
			.then(
				(value) => {
					if (stopped) return;
					post({ ...header, k: "host-result", id: message.id, ok: true, value: encodeHostValue(value, 0) });
				},
				(error: unknown) => {
					if (stopped) return;
					post({ ...header, k: "host-result", id: message.id, ok: false, error: encodeError(error, codecs) });
				}
			)
			.catch((error: unknown) => {
				if (!stopped)
					post({ ...header, k: "host-result", id: message.id, ok: false, error: encodeError(error, codecs) });
			})
			.finally(() => {
				for (const id of used) aborts.delete(id);
			});
	};

	// --- incoming ---------------------------------------------------------------------------------
	const deliver = (name: string, value: unknown): void => {
		latestValues.set(name, value);
		for (const listener of listeners.get(name) ?? []) listener(value);
		if (creditScheduled.has(name)) return;
		creditScheduled.add(name);
		frame(() => {
			creditScheduled.delete(name);
			if (!stopped) post({ ...header, k: "credit", name });
		});
	};

	function onMessage(event: MessageEvent): void {
		const message = parseWorkerMessage(event.data, session);
		if (message === undefined || stopped) return;
		switch (message.k) {
			case "booted":
				if (message.missing.length > 0) crash("unsupported", new RoomWorkerUnsupported(message.missing));
				return;
			case "ready":
				if (state !== "starting") return;
				state = "ready";
				for (const entry of queued.splice(0)) post(entry);
				readyResolve(message.info);
				return;
			case "result": {
				const entry = pending.get(message.id);
				if (entry === undefined) return;
				pending.delete(message.id);
				if (message.ok) entry.resolve(message.value);
				else entry.reject(decodeError(message.error, codecs));
				return;
			}
			case "refused": {
				const refusal = Object.freeze({
					id: message.id,
					command: message.name,
					error: decodeError(message.error, codecs),
				});
				for (const listener of refusalListeners) listener(refusal);
				return;
			}
			case "stream":
				if (contractEntry(contract.streams, message.name) !== undefined) deliver(message.name, message.value);
				return;
			case "diagnostic":
				options.onDiagnostic?.(message.name, message.value);
				return;
			case "host-call":
				serveHostCall(message);
				return;
			case "host-abort":
				aborts.get(message.id)?.abort(new DOMException("aborted by the room worker", "AbortError"));
				aborts.delete(message.id);
				return;
			case "host-release":
				for (const id of message.handles) {
					const handle = handles.get(id);
					if (handle !== undefined) handleIds.delete(handle.object);
					handles.delete(id);
				}
				return;
			case "storage":
				if (options.storage === undefined) return;
				if (message.value === null) options.storage.remove(message.key);
				else options.storage.set(message.key, message.value);
				return;
			case "closed":
				finishClose();
				return;
			case "fatal": {
				const error = decodeError(message.error, codecs);
				crash(error.message, error);
				return;
			}
			case "rtc":
				options.rtc?.receive(message.m);
				return;
		}
	}

	port.addEventListener("message", onMessage);
	post({
		...header,
		k: "init",
		contract: { name: contract.name, version: contract.version },
		init: options.init,
		hooks: [...hooks.keys()],
		storage:
			options.storage === undefined ? null : options.storage.entries.map(([key, value]) => [key, value] as const),
		diagnostics: options.onDiagnostic !== undefined,
	});

	return {
		ready,
		get state(): RoomWorkerState {
			return state;
		},
		session,
		call<Name extends keyof Commands & string>(
			name: Name,
			...args: Args<Commands[Name]>
		): Promise<Result<Commands[Name]>> {
			const refused = unavailable();
			if (refused !== undefined) return Promise.reject(refused);
			const spec = contractEntry(contract.commands, name);
			if (spec?.kind !== "call")
				return Promise.reject(new TypeError(`room worker command ${name} is not a call command`));
			if (pending.size >= maxInFlight) return Promise.reject(new RoomWorkerLimit("calls", maxInFlight));
			const id = nextId++;
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
				dispatch({ ...header, k: "call", id, name, args });
			});
		},
		send<Name extends keyof Commands & string>(name: Name, ...args: Args<Commands[Name]>): number {
			const refused = unavailable();
			if (refused !== undefined) throw refused;
			const spec = contractEntry(contract.commands, name);
			if (spec?.kind !== "send") throw new TypeError(`room worker command ${name} is not a send command`);
			spec.validate?.(...(args as never[]));
			const id = nextId++;
			dispatch({ ...header, k: "send", id, name, args });
			return id;
		},
		latest: (stream) => latestValues.get(stream),
		on(stream, listener) {
			if (contractEntry(contract.streams, stream) === undefined)
				throw new TypeError(`room worker stream ${stream} is unknown`);
			let set = listeners.get(stream);
			if (set === undefined) listeners.set(stream, (set = new Set()));
			set.add(listener);
			return () => set.delete(listener);
		},
		onRefused(listener) {
			refusalListeners.add(listener);
			return () => refusalListeners.delete(listener);
		},
		onCrash(listener) {
			crashListeners.add(listener);
			return () => crashListeners.delete(listener);
		},
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			if (state === "closed" || state === "crashed") return Promise.resolve();
			closing = new Promise<void>((resolve) => {
				closeResolve = resolve;
			});
			const wasStarting = state === "starting";
			state = "closing";
			if (wasStarting) queued.length = 0;
			post({ ...header, k: "close" });
			return closing;
		},
		crash: (reason) => crash(reason),
		postRtc(message: unknown, transfer: Transferable[] = []): void {
			if (!stopped) post({ ...header, k: "rtc", m: message }, transfer);
		},
	};
}
