/**
 * The room worker wire grammar. Every message names the protocol and the session it belongs to;
 * each side accepts only exact shapes of its peer's kinds for its own session (a message of a
 * closed or replaced session is dropped, so nothing of a terminal session acts again).
 */
import { isCommandName } from "./contract.js";
import { isWireError, type WireError } from "./errors.js";

export const ROOM_WORKER_PROTOCOL = "ts-drp/room-worker/1" as const;
/** Arguments of one command. */
export const ROOM_WORKER_MAX_ARGS = 64;

type Header = Readonly<{ p: typeof ROOM_WORKER_PROTOCOL; s: number }>;

export type PageMessage = Header &
	(
		| Readonly<{
				k: "init";
				contract: Readonly<{ name: string; version: number }>;
				init: unknown;
				hooks: readonly string[];
				storage: readonly (readonly [string, string])[] | null;
				diagnostics: boolean;
		  }>
		| Readonly<{ k: "call" | "send"; id: number; name: string; args: readonly unknown[] }>
		| Readonly<{ k: "credit"; name: string }>
		| Readonly<{ k: "host-result"; id: number; ok: true; value: unknown }>
		| Readonly<{ k: "host-result"; id: number; ok: false; error: WireError }>
		| Readonly<{ k: "close" }>
		| Readonly<{ k: "rtc"; m: unknown }>
	);

export type WorkerMessage = Header &
	(
		| Readonly<{ k: "booted"; missing: readonly string[] }>
		| Readonly<{ k: "ready"; info: unknown }>
		| Readonly<{ k: "result"; id: number; ok: true; value: unknown }>
		| Readonly<{ k: "result"; id: number; ok: false; error: WireError }>
		| Readonly<{ k: "refused"; id: number; name: string; error: WireError }>
		| Readonly<{ k: "stream"; name: string; value: unknown }>
		| Readonly<{ k: "diagnostic"; name: string; value: unknown }>
		| Readonly<{
				k: "host-call";
				id: number;
				hook: string;
				handle: number | null;
				method: string | null;
				args: readonly unknown[];
		  }>
		| Readonly<{ k: "host-abort"; id: number }>
		| Readonly<{ k: "host-release"; handles: readonly number[] }>
		| Readonly<{ k: "storage"; key: string; value: string | null }>
		| Readonly<{ k: "closed" }>
		| Readonly<{ k: "fatal"; error: WireError }>
		| Readonly<{ k: "rtc"; m: unknown }>
	);

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const keys = Object.keys(value);
	return (
		keys.length === fields.length + 3 && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
	);
}

const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isArgs = (value: unknown): value is unknown[] => Array.isArray(value) && value.length <= ROOM_WORKER_MAX_ARGS;
const isString = (value: unknown, max = 1024): value is string => typeof value === "string" && value.length <= max;

function header(value: unknown, session: number, allowBoot = false): value is Record<string, unknown> {
	if (!isRecord(value) || value.p !== ROOM_WORKER_PROTOCOL || typeof value.k !== "string") return false;
	return value.s === session || (allowBoot && value.s === 0 && value.k === "booted");
}

/**
 * Parses a page message for the worker of `session`.
 * @param value - Untrusted message data.
 * @param session - The worker's session.
 * @returns The message, or undefined when it is not one.
 */
export function parsePageMessage(value: unknown, session: number): PageMessage | undefined {
	if (!header(value, session)) return undefined;
	switch (value.k) {
		case "init":
			return exact(value, ["contract", "init", "hooks", "storage", "diagnostics"]) &&
				isRecord(value.contract) &&
				isString(value.contract.name, 128) &&
				Number.isSafeInteger(value.contract.version) &&
				Array.isArray(value.hooks) &&
				value.hooks.every((hook) => isCommandName(hook)) &&
				(value.storage === null ||
					(Array.isArray(value.storage) &&
						value.storage.every(
							(entry) =>
								Array.isArray(entry) && entry.length === 2 && isString(entry[0]) && typeof entry[1] === "string"
						))) &&
				typeof value.diagnostics === "boolean"
				? (value as PageMessage)
				: undefined;
		case "call":
		case "send":
			return exact(value, ["id", "name", "args"]) && isId(value.id) && isCommandName(value.name) && isArgs(value.args)
				? (value as PageMessage)
				: undefined;
		case "credit":
			return exact(value, ["name"]) && isCommandName(value.name) ? (value as PageMessage) : undefined;
		case "host-result":
			if (!isId(value.id) || typeof value.ok !== "boolean") return undefined;
			if (value.ok) return exact(value, ["id", "ok", "value"]) ? (value as PageMessage) : undefined;
			return exact(value, ["id", "ok", "error"]) && isWireError(value.error) ? (value as PageMessage) : undefined;
		case "close":
			return exact(value, []) ? (value as PageMessage) : undefined;
		case "rtc":
			return exact(value, ["m"]) && isRecord(value.m) ? (value as PageMessage) : undefined;
		default:
			return undefined;
	}
}

/**
 * Parses a worker message for the page of `session` (a boot message has no session yet).
 * @param value - Untrusted message data.
 * @param session - The page client's session.
 * @returns The message, or undefined when it is not one.
 */
export function parseWorkerMessage(value: unknown, session: number): WorkerMessage | undefined {
	if (!header(value, session, true)) return undefined;
	switch (value.k) {
		case "booted":
			return exact(value, ["missing"]) &&
				Array.isArray(value.missing) &&
				value.missing.every((entry) => isString(entry, 64))
				? (value as WorkerMessage)
				: undefined;
		case "ready":
			return exact(value, ["info"]) ? (value as WorkerMessage) : undefined;
		case "result":
			if (!isId(value.id) || typeof value.ok !== "boolean") return undefined;
			if (value.ok) return exact(value, ["id", "ok", "value"]) ? (value as WorkerMessage) : undefined;
			return exact(value, ["id", "ok", "error"]) && isWireError(value.error) ? (value as WorkerMessage) : undefined;
		case "refused":
			return exact(value, ["id", "name", "error"]) &&
				isId(value.id) &&
				isCommandName(value.name) &&
				isWireError(value.error)
				? (value as WorkerMessage)
				: undefined;
		case "stream":
		case "diagnostic":
			return exact(value, ["name", "value"]) && isCommandName(value.name) ? (value as WorkerMessage) : undefined;
		case "host-call":
			return exact(value, ["id", "hook", "handle", "method", "args"]) &&
				isId(value.id) &&
				isCommandName(value.hook) &&
				(value.handle === null || isId(value.handle)) &&
				(value.method === null || isCommandName(value.method)) &&
				(value.handle === null) === (value.method === null) &&
				isArgs(value.args)
				? (value as WorkerMessage)
				: undefined;
		case "host-abort":
			return exact(value, ["id"]) && isId(value.id) ? (value as WorkerMessage) : undefined;
		case "host-release":
			return exact(value, ["handles"]) &&
				Array.isArray(value.handles) &&
				value.handles.length <= 4096 &&
				value.handles.every(isId)
				? (value as WorkerMessage)
				: undefined;
		case "storage":
			return exact(value, ["key", "value"]) &&
				isString(value.key) &&
				(value.value === null || typeof value.value === "string")
				? (value as WorkerMessage)
				: undefined;
		case "closed":
			return exact(value, []) ? (value as WorkerMessage) : undefined;
		case "fatal":
			return exact(value, ["error"]) && isWireError(value.error) ? (value as WorkerMessage) : undefined;
		case "rtc":
			return exact(value, ["m"]) && isRecord(value.m) ? (value as WorkerMessage) : undefined;
		default:
			return undefined;
	}
}

/** A port: a dedicated Worker on the page, the worker's global scope inside it, or a MessagePort. */
export interface RoomWorkerPort {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
	removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

// Values crossing as host hook arguments or results carry two reserved tags: a page-owned handle
// (an object with methods the worker may call) and a worker-owned abort signal.
export const HANDLE_TAG = "ts-drp/room-worker/handle";
export const ABORT_TAG = "ts-drp/room-worker/abort";
/** Depth to which host values are walked for handles and signals. */
export const HOST_VALUE_MAX_DEPTH = 16;
