/**
 * Errors across the room worker boundary.
 *
 * The structured clone algorithm keeps an Error's message but drops its class and own fields, so a
 * room's typed refusal (V3RoomNotReachingHost and the rest) would reach the page as a bare Error.
 * Each side therefore encodes an error by an explicit codec table: the page decodes a real instance
 * of the same class (instanceof holds), with its name, message, data fields, cause chain and the
 * worker's stack. A class without a codec, or one whose fields cannot cross, arrives as
 * RoomWorkerRemoteError carrying its remote name: the page never guesses a type.
 */

/** How many causes below the thrown error cross the boundary. Deeper causes are cut. */
export const ROOM_WORKER_MAX_CAUSE_DEPTH = 4;

/** An error on the wire: structured-cloneable data only. */
export interface WireError {
	readonly codec: string | null;
	readonly name: string;
	readonly message: string;
	readonly fields: Readonly<Record<string, unknown>> | null;
	readonly stack: string | null;
	readonly cause: WireError | null;
}

type ErrorType<E extends Error> = abstract new (...args: never[]) => E;

/** How one error class crosses the boundary. */
export interface RoomWorkerErrorCodec<E extends Error = Error> {
	/** Stable id on the wire (class names do not survive minification). */
	readonly id: string;
	/** The class it encodes: an error matches only when this is its exact constructor. */
	readonly type: ErrorType<E>;
	encode(error: E): Readonly<Record<string, unknown>>;
	decode(fields: Readonly<Record<string, unknown>>, message: string, cause: Error | undefined): E;
}

const RESERVED = new Set(["name", "message", "stack", "cause"]);

function ownDataFields(error: Error): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const key of Object.keys(error))
		if (!RESERVED.has(key)) fields[key] = (error as unknown as Record<string, unknown>)[key];
	return fields;
}

/**
 * The codec of one error class. By default it copies the error's own enumerable data fields and
 * rebuilds a real Error object with the class's prototype (the class constructor does not run; the
 * copied fields are the state it set). A class that keeps state a data copy cannot carry (a symbol
 * brand, say) passes `construct` to rebuild through its own constructor.
 * @param id - Stable id on the wire.
 * @param type - The error class.
 * @param options - `construct`: rebuild an instance from the decoded fields, message and cause.
 * @returns The codec.
 */
export function errorCodec<E extends Error>(
	id: string,
	type: ErrorType<E>,
	options: Readonly<{
		construct?(fields: Readonly<Record<string, unknown>>, message: string, cause: Error | undefined): E;
	}> = {}
): RoomWorkerErrorCodec<E> {
	if (typeof id !== "string" || id.length === 0) throw new TypeError("room worker error codec id is invalid");
	if (typeof type !== "function" || !(type.prototype instanceof Error || (type as unknown) === Error))
		throw new TypeError("room worker error codec type is not an Error class");
	const construct = options.construct;
	return Object.freeze({
		id,
		type,
		encode: (error: E) => ownDataFields(error),
		decode: (fields: Readonly<Record<string, unknown>>, message: string, cause: Error | undefined): E => {
			if (construct !== undefined) return construct(fields, message, cause);
			const rebuilt = Reflect.construct(Error, cause === undefined ? [message] : [message, { cause }], type) as E;
			for (const [key, value] of Object.entries(fields)) Reflect.set(rebuilt, key, value);
			return rebuilt;
		},
	});
}

/** An error thrown in the worker whose class has no codec on this side. */
export class RoomWorkerRemoteError extends Error {
	readonly code = "ROOM_WORKER_REMOTE_ERROR";
	/**
	 * @param remoteName - The remote error's name.
	 * @param message - The remote error's message.
	 */
	constructor(
		readonly remoteName: string,
		message: string
	) {
		super(message);
		this.name = "RoomWorkerRemoteError";
	}
}

/**
 * The room worker stopped (terminated, crashed, or failed to start) while this call was in flight
 * or before it was made. The call's outcome is unknown: a durable command may already be admitted
 * in the room's storage. Reopen, then check the room's own state before offering it again.
 */
export class RoomWorkerCrashed extends Error {
	readonly code = "ROOM_WORKER_CRASHED";
	/** @param reason - Why the worker stopped. */
	constructor(readonly reason: string) {
		super(`the room worker stopped: ${reason}`);
		this.name = "RoomWorkerCrashed";
	}
}

/** A call made after the room worker was closed. Nothing was sent. */
export class RoomWorkerClosed extends Error {
	readonly code = "ROOM_WORKER_CLOSED";
	/**
	 *
	 */
	constructor() {
		super("the room worker is closed");
		this.name = "RoomWorkerClosed";
	}
}

/** This browser cannot host the room in a worker; the app keeps the room on the main thread. */
export class RoomWorkerUnsupported extends Error {
	readonly code = "ROOM_WORKER_UNSUPPORTED";
	/** @param missing - The worker capabilities that are absent. */
	constructor(readonly missing: readonly string[]) {
		super(`this browser cannot host the room in a worker: missing ${missing.join(", ")}`);
		this.name = "RoomWorkerUnsupported";
	}
}

/** A bounded bridge resource is full. Nothing was sent. */
export class RoomWorkerLimit extends Error {
	readonly code = "ROOM_WORKER_LIMIT";
	/**
	 * @param resource - The bounded resource.
	 * @param limit - Its bound.
	 */
	constructor(
		readonly resource: "calls" | "handles",
		readonly limit: number
	) {
		super(`the room worker's ${resource} bound (${limit}) is reached`);
		this.name = "RoomWorkerLimit";
	}
}

/** A message that breaks the room worker protocol, or an app built for another contract. */
export class RoomWorkerProtocolError extends Error {
	readonly code = "ROOM_WORKER_PROTOCOL";
	/** @param detail - What was wrong. */
	constructor(readonly detail: string) {
		super(`room worker protocol: ${detail}`);
		this.name = "RoomWorkerProtocolError";
	}
}

const LIBRARY_CODECS: readonly RoomWorkerErrorCodec[] = Object.freeze([
	errorCodec("RoomWorkerRemoteError", RoomWorkerRemoteError),
	errorCodec("RoomWorkerCrashed", RoomWorkerCrashed),
	errorCodec("RoomWorkerClosed", RoomWorkerClosed),
	errorCodec("RoomWorkerUnsupported", RoomWorkerUnsupported),
	errorCodec("RoomWorkerLimit", RoomWorkerLimit),
	errorCodec("RoomWorkerProtocolError", RoomWorkerProtocolError),
]);

// The standard classes rebuild through their own constructors, as a structured clone does.
const STANDARD: Readonly<Record<string, new (message?: string, options?: ErrorOptions) => Error>> = Object.freeze({
	Error,
	EvalError,
	RangeError,
	ReferenceError,
	SyntaxError,
	TypeError,
	URIError,
});
const DOM_EXCEPTION = "DOMException";

function table(codecs: readonly RoomWorkerErrorCodec[]): Map<string, RoomWorkerErrorCodec> {
	const byId = new Map<string, RoomWorkerErrorCodec>();
	for (const codec of [...LIBRARY_CODECS, ...codecs]) {
		const existing = byId.get(codec.id);
		if (existing !== undefined && existing !== codec && existing.type !== codec.type)
			throw new TypeError(`room worker error codec id ${codec.id} is registered twice`);
		byId.set(codec.id, codec);
	}
	return byId;
}

function cloneable(value: unknown): boolean {
	try {
		structuredClone(value);
		return true;
	} catch {
		return false;
	}
}

function standardName(error: Error): string | undefined {
	if (typeof DOMException === "function" && error instanceof DOMException) return DOM_EXCEPTION;
	const constructor = Object.getPrototypeOf(error)?.constructor as unknown;
	for (const [name, type] of Object.entries(STANDARD)) if (constructor === type) return name;
	return undefined;
}

function encodeOne(error: unknown, byId: Map<string, RoomWorkerErrorCodec>, depth: number): WireError {
	if (!(error instanceof Error))
		return { codec: null, name: "Error", message: String(error), fields: null, stack: null, cause: null };
	const cause =
		error.cause === undefined || depth >= ROOM_WORKER_MAX_CAUSE_DEPTH ? null : encodeOne(error.cause, byId, depth + 1);
	const stack = typeof error.stack === "string" ? error.stack : null;
	const constructor = Object.getPrototypeOf(error)?.constructor as unknown;
	for (const codec of byId.values()) {
		if (codec.type !== constructor) continue;
		const fields = codec.encode(error);
		if (!cloneable(fields)) break;
		return { codec: codec.id, name: error.name, message: error.message, fields, stack, cause };
	}
	const standard = standardName(error);
	if (standard !== undefined && (standard === DOM_EXCEPTION || Object.keys(ownDataFields(error)).length === 0))
		return { codec: `std:${standard}`, name: error.name, message: error.message, fields: null, stack, cause };
	return { codec: null, name: error.name, message: error.message, fields: null, stack, cause };
}

/**
 * Encodes a thrown value for the wire.
 * @param error - The thrown value.
 * @param codecs - The app's codecs (the library's own errors and the standard classes need none).
 * @returns Its structured-cloneable form.
 */
export function encodeError(error: unknown, codecs: readonly RoomWorkerErrorCodec[] = []): WireError {
	return encodeOne(error, table(codecs), 0);
}

function decodeOne(wire: WireError, byId: Map<string, RoomWorkerErrorCodec>): Error {
	const cause = wire.cause === null ? undefined : decodeOne(wire.cause, byId);
	let error: Error;
	const codec = wire.codec === null ? undefined : byId.get(wire.codec);
	if (codec !== undefined) error = codec.decode(wire.fields ?? {}, wire.message, cause);
	else if (wire.codec === `std:${DOM_EXCEPTION}` && typeof DOMException === "function")
		error = new DOMException(wire.message, wire.name);
	else if (wire.codec?.startsWith("std:") === true && STANDARD[wire.codec.slice(4)] !== undefined) {
		const Standard = STANDARD[wire.codec.slice(4)] as NonNullable<(typeof STANDARD)[string]>;
		error = cause === undefined ? new Standard(wire.message) : new Standard(wire.message, { cause });
		if (error.name !== wire.name) error.name = wire.name;
	} else {
		error = new RoomWorkerRemoteError(wire.name, wire.message);
		if (cause !== undefined)
			Object.defineProperty(error, "cause", { value: cause, configurable: true, writable: true });
	}
	if (codec !== undefined && error.name !== wire.name) error.name = wire.name;
	if (wire.stack !== null) {
		Object.defineProperty(error, "remoteStack", { value: wire.stack, configurable: true, writable: true });
		Object.defineProperty(error, "stack", { value: wire.stack, configurable: true, writable: true });
	}
	return error;
}

/**
 * Decodes an error from the wire.
 * @param wire - Its structured-cloneable form.
 * @param codecs - The app's codecs.
 * @returns A real error: the registered class, a standard class, or RoomWorkerRemoteError.
 */
export function decodeError(wire: WireError, codecs: readonly RoomWorkerErrorCodec[] = []): Error {
	return decodeOne(wire, table(codecs));
}

/**
 * Validates an untrusted wire error's shape (bounded depth).
 * @param value - Candidate.
 * @param depth - Current depth.
 * @returns Whether it is a WireError.
 */
export function isWireError(value: unknown, depth = 0): value is WireError {
	if (typeof value !== "object" || value === null || depth > ROOM_WORKER_MAX_CAUSE_DEPTH + 1) return false;
	const record = value as Record<string, unknown>;
	return (
		(record.codec === null || typeof record.codec === "string") &&
		typeof record.name === "string" &&
		typeof record.message === "string" &&
		(record.fields === null || (typeof record.fields === "object" && !Array.isArray(record.fields))) &&
		(record.stack === null || typeof record.stack === "string") &&
		(record.cause === null || isWireError(record.cause, depth + 1))
	);
}
