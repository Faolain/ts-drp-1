import { invalidOption } from "./error.js";
import {
	MAX_CHUNK_BYTES,
	MAX_TASKS,
	normalizeBytes,
	parseHostMessage,
	requireTaskName,
	WORKER_HOST_PROTOCOL,
	WORKER_HOST_PROTOCOL_VERSION,
	type WorkerToHostMessage,
	type WorkerWireErrorCode,
} from "./wire.js";

interface ScopeEvent {
	readonly data?: unknown;
}

type ScopeListener = (event: ScopeEvent) => void;

export interface WorkerHostScope {
	addEventListener(type: "message", listener: ScopeListener): void;
	removeEventListener(type: "message", listener: ScopeListener): void;
	postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface WorkerTaskContext {
	readonly signal: AbortSignal;
	emit(payload: Uint8Array): void;
}

export type WorkerTaskHandler = (payload: Uint8Array, context: WorkerTaskContext) => void | Promise<void>;

interface ActiveTask {
	readonly controller: AbortController;
	readonly completionWaiters: Set<() => void>;
	complete(): void;
	chunks: number;
	bytes: number;
	settled: boolean;
}

const INSTALLED_SCOPES = new WeakSet<object>();

function isScope(value: unknown): value is WorkerHostScope {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<WorkerHostScope>;
	return (
		typeof candidate.addEventListener === "function" &&
		typeof candidate.removeEventListener === "function" &&
		typeof candidate.postMessage === "function"
	);
}

function terminal(kind: "cancelled" | "done", id: string, chunks: number, bytes: number): WorkerToHostMessage {
	return { protocol: WORKER_HOST_PROTOCOL, version: WORKER_HOST_PROTOCOL_VERSION, kind, id, chunks, bytes };
}

function failed(
	id: string,
	code: WorkerWireErrorCode,
	message: string,
	chunks: number,
	bytes: number
): WorkerToHostMessage {
	return {
		protocol: WORKER_HOST_PROTOCOL,
		version: WORKER_HOST_PROTOCOL_VERSION,
		kind: "failed",
		id,
		code,
		message,
		chunks,
		bytes,
	};
}

/**
 * Installs one bounded task registry on a worker-like scope and announces readiness.
 * @param scope - Worker-owned message endpoint.
 * @param tasks - Fixed task-name to handler registry.
 */
export function serveWorkerTasks(scope: WorkerHostScope, tasks: Readonly<Record<string, WorkerTaskHandler>>): void {
	if (!isScope(scope)) throw invalidOption("scope", scope);
	if (typeof tasks !== "object" || tasks === null) throw invalidOption("tasks", tasks);
	if (INSTALLED_SCOPES.has(scope)) throw invalidOption("scope installation", scope);
	const names = Object.keys(tasks).sort();
	if (names.length > MAX_TASKS) throw invalidOption("task count", names.length);
	const registry = new Map<string, WorkerTaskHandler>();
	for (const name of names) {
		requireTaskName(name, "task name");
		const handler = tasks[name];
		if (typeof handler !== "function") throw invalidOption("task handler", handler);
		registry.set(name, handler);
	}

	const active = new Map<string, ActiveTask>();
	let highestRequestId = BigInt(0);

	const post = (message: WorkerToHostMessage, payload?: Uint8Array): void => {
		scope.postMessage(message, payload === undefined ? undefined : [payload.buffer]);
	};

	const postFailure = (id: string, code: WorkerWireErrorCode, message: string, chunks = 0, bytes = 0): void => {
		post(failed(id, code, message, chunks, bytes));
	};

	const postRecoverableFailure = (id: string): void => {
		const numericId = BigInt(`0x${id}`);
		const prior = [...active.entries()]
			.filter(([activeId]) => BigInt(`0x${activeId}`) < numericId)
			.map(([, task]) => task);
		if (prior.length === 0) {
			postFailure(id, "worker-payload-invalid", "Worker request payload is invalid");
			return;
		}
		let remaining = prior.length;
		const release = (): void => {
			remaining -= 1;
			if (remaining === 0) postFailure(id, "worker-payload-invalid", "Worker request payload is invalid");
		};
		for (const task of prior) task.completionWaiters.add(release);
	};

	const handleRequest = (message: Readonly<{ id: string; task: string; payload: Uint8Array }>): void => {
		const numericId = BigInt(`0x${message.id}`);
		if (numericId <= highestRequestId || active.has(message.id)) {
			postFailure(message.id, "worker-payload-invalid", "Request id is not monotone");
			return;
		}
		highestRequestId = numericId;
		const handler = registry.get(message.task);
		if (handler === undefined) {
			postFailure(message.id, "worker-task-unknown", "Worker task is unknown");
			return;
		}
		const completionWaiters = new Set<() => void>();
		const task: ActiveTask = {
			controller: new AbortController(),
			completionWaiters,
			complete(): void {
				for (const waiter of completionWaiters) waiter();
				completionWaiters.clear();
			},
			chunks: 0,
			bytes: 0,
			settled: false,
		};
		active.set(message.id, task);
		const context: WorkerTaskContext = {
			signal: task.controller.signal,
			emit(payloadValue: Uint8Array): void {
				if (task.settled) throw invalidOption("emit after settlement", payloadValue);
				if (
					!(payloadValue instanceof Uint8Array) ||
					payloadValue.byteLength > MAX_CHUNK_BYTES ||
					payloadValue.byteOffset !== 0 ||
					!(payloadValue.buffer instanceof ArrayBuffer) ||
					payloadValue.buffer.byteLength !== payloadValue.byteLength
				) {
					throw invalidOption("emitted payload", payloadValue);
				}
				const payload = payloadValue;
				const sequence = task.chunks;
				const byteLength = payload.byteLength;
				const chunk: WorkerToHostMessage = {
					protocol: WORKER_HOST_PROTOCOL,
					version: WORKER_HOST_PROTOCOL_VERSION,
					kind: "chunk",
					id: message.id,
					sequence,
					payload,
				};
				post(chunk, payload);
				task.chunks += 1;
				task.bytes += byteLength;
			},
		};

		let result: void | Promise<void>;
		try {
			result = handler(normalizeBytes(message.payload), context);
		} catch {
			task.settled = true;
			active.delete(message.id);
			try {
				postFailure(message.id, "worker-task-failed", "Worker task failed", task.chunks, task.bytes);
			} finally {
				task.complete();
			}
			return;
		}
		void Promise.resolve(result)
			.then(
				() => {
					if (task.settled) return;
					task.settled = true;
					active.delete(message.id);
					try {
						post(terminal(task.controller.signal.aborted ? "cancelled" : "done", message.id, task.chunks, task.bytes));
					} finally {
						task.complete();
					}
				},
				() => {
					if (task.settled) return;
					task.settled = true;
					active.delete(message.id);
					try {
						if (task.controller.signal.aborted) {
							post(terminal("cancelled", message.id, task.chunks, task.bytes));
						} else {
							postFailure(message.id, "worker-task-failed", "Worker task failed", task.chunks, task.bytes);
						}
					} finally {
						task.complete();
					}
				}
			)
			.catch(() => {
				if (task.settled) return;
				task.settled = true;
				active.delete(message.id);
				try {
					postFailure(message.id, "worker-internal", "Worker endpoint failed", task.chunks, task.bytes);
				} catch {
					// A broken endpoint has no further recoverable wire action.
				}
			});
	};

	const onMessage = (event: ScopeEvent): void => {
		const parsed = parseHostMessage(event.data);
		if (!("message" in parsed)) {
			if (parsed.recoverableId !== undefined) {
				postRecoverableFailure(parsed.recoverableId);
			}
			return;
		}
		if (parsed.message.kind === "cancel") {
			active.get(parsed.message.id)?.controller.abort();
			return;
		}
		handleRequest(parsed.message);
	};

	INSTALLED_SCOPES.add(scope);
	scope.addEventListener("message", onMessage);
	post({
		protocol: WORKER_HOST_PROTOCOL,
		version: WORKER_HOST_PROTOCOL_VERSION,
		kind: "ready",
		accepts: names,
	});
}
