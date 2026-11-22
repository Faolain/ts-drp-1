/* eslint-disable jsdoc/require-jsdoc -- this private module centralizes the bounded wire grammar */
import { invalidOption } from "./error.js";

export const WORKER_HOST_PROTOCOL = "ts-drp/worker-host" as const;
export const WORKER_HOST_PROTOCOL_VERSION = 1 as const;
export const WORKER_WIRE_ERROR_CODES = Object.freeze([
	"worker-internal",
	"worker-payload-invalid",
	"worker-task-failed",
	"worker-task-unknown",
] as const);

export type WorkerWireErrorCode = (typeof WORKER_WIRE_ERROR_CODES)[number];

export type HostToWorkerMessage =
	| Readonly<{
			protocol: typeof WORKER_HOST_PROTOCOL;
			version: typeof WORKER_HOST_PROTOCOL_VERSION;
			kind: "request";
			id: string;
			task: string;
			payload: Uint8Array;
	  }>
	| Readonly<{
			protocol: typeof WORKER_HOST_PROTOCOL;
			version: typeof WORKER_HOST_PROTOCOL_VERSION;
			kind: "cancel";
			id: string;
	  }>;

export type WorkerToHostMessage =
	| Readonly<{
			protocol: typeof WORKER_HOST_PROTOCOL;
			version: typeof WORKER_HOST_PROTOCOL_VERSION;
			kind: "ready";
			accepts: readonly string[];
	  }>
	| Readonly<{
			protocol: typeof WORKER_HOST_PROTOCOL;
			version: typeof WORKER_HOST_PROTOCOL_VERSION;
			kind: "chunk";
			id: string;
			sequence: number;
			payload: Uint8Array;
	  }>
	| Readonly<{
			protocol: typeof WORKER_HOST_PROTOCOL;
			version: typeof WORKER_HOST_PROTOCOL_VERSION;
			kind: "done" | "cancelled";
			id: string;
			chunks: number;
			bytes: number;
	  }>
	| Readonly<{
			protocol: typeof WORKER_HOST_PROTOCOL;
			version: typeof WORKER_HOST_PROTOCOL_VERSION;
			kind: "failed";
			id: string;
			code: WorkerWireErrorCode;
			message: string;
			chunks: number;
			bytes: number;
	  }>;

export const MAX_REQUEST_BYTES = 1_048_576;
export const MAX_CHUNK_BYTES = 65_536;
export const MAX_TASKS = 64;

const TASK_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const REQUEST_ID = /^[0-9a-f]{16}$/u;
const WIRE_ERROR_CODE_SET: ReadonlySet<string> = new Set(WORKER_WIRE_ERROR_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const expected = [...fields].sort();
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isTaskName(value: unknown): value is string {
	return typeof value === "string" && TASK_NAME.test(value);
}

export function isRequestId(value: unknown): value is string {
	if (typeof value !== "string" || !REQUEST_ID.test(value)) return false;
	const numeric = BigInt(`0x${value}`);
	return numeric > BigInt(0) && numeric <= BigInt(Number.MAX_SAFE_INTEGER);
}

export function normalizeBytes(value: Uint8Array): Uint8Array {
	return new Uint8Array(value);
}

export function isTightBytes(value: unknown, maximum: number): value is Uint8Array {
	return (
		value instanceof Uint8Array &&
		value.byteLength <= maximum &&
		value.byteOffset === 0 &&
		value.buffer instanceof ArrayBuffer &&
		value.buffer.byteLength === value.byteLength
	);
}

function isBoundedBytes(value: unknown, maximum: number): value is Uint8Array {
	return value instanceof Uint8Array && value.byteLength <= maximum;
}

export function requireTaskName(value: unknown, name = "task"): string {
	if (!isTaskName(value)) throw invalidOption(name, value);
	return value;
}

export function requireInputBytes(value: unknown, maximum: number, name: string): Uint8Array {
	if (!(value instanceof Uint8Array) || value.byteLength > maximum) throw invalidOption(name, value);
	return normalizeBytes(value);
}

export function validateAccepts(value: unknown): value is readonly string[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_TASKS)
		return false;
	const keys = Object.keys(value);
	if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) return false;
	let previous: string | undefined;
	for (const task of value) {
		if (!isTaskName(task) || (previous !== undefined && task <= previous)) return false;
		previous = task;
	}
	return true;
}

export function parseWorkerMessage(value: unknown): WorkerToHostMessage | undefined {
	if (!isRecord(value)) return undefined;
	if (value.protocol !== WORKER_HOST_PROTOCOL) return undefined;
	if (value.version !== WORKER_HOST_PROTOCOL_VERSION) return undefined;
	if (typeof value.kind !== "string") return undefined;

	switch (value.kind) {
		case "ready":
			if (!hasExactFields(value, ["protocol", "version", "kind", "accepts"])) return undefined;
			if (!validateAccepts(value.accepts)) return undefined;
			return value as WorkerToHostMessage;
		case "chunk":
			if (!hasExactFields(value, ["protocol", "version", "kind", "id", "sequence", "payload"])) return undefined;
			if (!isRequestId(value.id) || !isCount(value.sequence) || !isBoundedBytes(value.payload, MAX_CHUNK_BYTES)) {
				return undefined;
			}
			return value as WorkerToHostMessage;
		case "done":
		case "cancelled":
			if (!hasExactFields(value, ["protocol", "version", "kind", "id", "chunks", "bytes"])) return undefined;
			if (!isRequestId(value.id) || !isCount(value.chunks) || !isCount(value.bytes)) return undefined;
			return value as WorkerToHostMessage;
		case "failed":
			if (!hasExactFields(value, ["protocol", "version", "kind", "id", "code", "message", "chunks", "bytes"])) {
				return undefined;
			}
			if (
				!isRequestId(value.id) ||
				typeof value.code !== "string" ||
				!WIRE_ERROR_CODE_SET.has(value.code) ||
				typeof value.message !== "string" ||
				!isCount(value.chunks) ||
				!isCount(value.bytes)
			) {
				return undefined;
			}
			return value as WorkerToHostMessage;
		default:
			return undefined;
	}
}

export type ParsedHostMessage =
	| Readonly<{ message: HostToWorkerMessage }>
	| Readonly<{ recoverableId: string | undefined }>;

export function parseHostMessage(value: unknown): ParsedHostMessage {
	if (!isRecord(value)) return { recoverableId: undefined };
	const recoverableId = isRequestId(value.id) ? value.id : undefined;
	if (value.protocol !== WORKER_HOST_PROTOCOL || value.version !== WORKER_HOST_PROTOCOL_VERSION) {
		return { recoverableId };
	}
	if (value.kind === "request") {
		if (!hasExactFields(value, ["protocol", "version", "kind", "id", "task", "payload"])) {
			return { recoverableId };
		}
		if (!isRequestId(value.id) || !isTaskName(value.task) || !isBoundedBytes(value.payload, MAX_REQUEST_BYTES)) {
			return { recoverableId };
		}
		return { message: value as HostToWorkerMessage };
	}
	if (value.kind === "cancel") {
		if (!hasExactFields(value, ["protocol", "version", "kind", "id"]) || !isRequestId(value.id)) {
			return { recoverableId };
		}
		return { message: value as HostToWorkerMessage };
	}
	return { recoverableId };
}
