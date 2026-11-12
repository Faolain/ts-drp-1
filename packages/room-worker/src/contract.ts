/**
 * A room worker contract: the closed set of commands the page may send to the app's room in the
 * worker, the streams the worker publishes back, and the page hooks the worker may call. It is the
 * only code page and worker share, so it must stay light (no room or network imports).
 */

const COMMAND_SEGMENT = /^[A-Za-z][A-Za-z0-9]{0,31}$/u;
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
	"toString",
	"valueOf",
]);

/**
 * Whether a value is a command or stream name: dotted identifiers, never a prototype key.
 * @param value - Candidate.
 * @returns Whether it is a valid name.
 */
export function isCommandName(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
	return value.split(".").every((segment) => COMMAND_SEGMENT.test(segment) && !FORBIDDEN_SEGMENTS.has(segment));
}

/**
 * A command the page awaits: its result (or typed refusal) comes back as a promise.
 */
export interface CallCommand {
	readonly kind: "call";
}

/**
 * A fire-and-forget command for the hot path (a move). `validate` runs on the page synchronously and
 * throws exactly what the main-thread method throws for bad arguments; a refusal in the worker
 * reaches the page's refusal listener with the send's correlation id.
 */
export interface SendCommand {
	readonly kind: "send";
	validate?(...args: never[]): void;
}

export type CommandSpec = CallCommand | SendCommand;

/** A latest-value stream: the page sees at most one value per frame and always the newest. */
export interface LatestStream {
	readonly kind: "latest";
}

export type StreamSpec = LatestStream;

/** @returns A call command. */
export const call = (): CallCommand => Object.freeze({ kind: "call" });

/**
 * @param validate - Synchronous page-side argument check.
 * @returns A send command.
 */
export const send = <Args extends unknown[]>(validate?: (...args: Args) => void): SendCommand =>
	Object.freeze(
		validate === undefined
			? { kind: "send" as const }
			: { kind: "send" as const, validate: validate as unknown as (...args: never[]) => void }
	);

/** @returns A latest-value stream. */
export const latest = (): LatestStream => Object.freeze({ kind: "latest" });

export interface RoomWorkerContract {
	/** The app's contract name; page and worker must agree. */
	readonly name: string;
	/** Bumped on any change; a page and a worker bundle of different versions refuse each other. */
	readonly version: number;
	readonly commands: Readonly<Record<string, CommandSpec>>;
	readonly streams: Readonly<Record<string, StreamSpec>>;
	/** Page hooks the worker may call (host-owned authorities and policies). */
	readonly hooks: readonly string[];
}

/**
 * Checks and freezes a contract.
 * @param contract - The contract.
 * @returns The same contract, frozen.
 */
export function defineRoomWorkerContract<Contract extends RoomWorkerContract>(contract: Contract): Contract {
	if (typeof contract.name !== "string" || contract.name.length === 0 || contract.name.length > 128)
		throw new TypeError("room worker contract name is invalid");
	if (!Number.isSafeInteger(contract.version) || contract.version < 1)
		throw new TypeError("room worker contract version is invalid");
	for (const [name, spec] of Object.entries(contract.commands)) {
		if (!isCommandName(name)) throw new TypeError(`room worker command name ${name} is invalid`);
		if (spec?.kind !== "call" && spec?.kind !== "send") throw new TypeError(`room worker command ${name} has no kind`);
	}
	for (const [name, spec] of Object.entries(contract.streams)) {
		if (!isCommandName(name)) throw new TypeError(`room worker stream name ${name} is invalid`);
		if (spec?.kind !== "latest") throw new TypeError(`room worker stream ${name} has no kind`);
	}
	for (const name of contract.hooks)
		if (!isCommandName(name)) throw new TypeError(`room worker hook name ${name} is invalid`);
	Object.freeze(contract.commands);
	Object.freeze(contract.streams);
	Object.freeze(contract.hooks);
	return Object.freeze(contract);
}

/**
 * Own-property lookup of a contract entry (never inherited keys).
 * @param table
 * @param name
 */
export function contractEntry<Value>(table: Readonly<Record<string, Value>>, name: string): Value | undefined {
	return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
}
