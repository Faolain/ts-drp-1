import { WorkerHostError as CodedError, invalidOption } from "./error.js";
import { WorkerHostMetrics } from "./metrics.js";
import {
	type HostToWorkerMessage,
	MAX_REQUEST_BYTES,
	normalizeBytes,
	parseWorkerMessage,
	requireInputBytes,
	requireTaskName,
	WORKER_HOST_PROTOCOL,
	WORKER_HOST_PROTOCOL_VERSION,
	type WorkerToHostMessage,
} from "./wire.js";

export { WORKER_HOST_PROTOCOL, WORKER_HOST_PROTOCOL_VERSION, WORKER_WIRE_ERROR_CODES } from "./wire.js";
export type { WorkerWireErrorCode } from "./wire.js";

export type WorkerHostState = "starting" | "ready" | "terminated" | "closed";

interface EndpointEvent {
	readonly data?: unknown;
}

type EndpointListener = (event: EndpointEvent) => void;

export interface WorkerHostEndpoint {
	addEventListener(type: "error" | "message" | "messageerror", listener: EndpointListener): void;
	removeEventListener(type: "error" | "message" | "messageerror", listener: EndpointListener): void;
	postMessage(message: unknown, transfer?: Transferable[]): void;
	terminate(): void;
}

export interface WorkerHostOptions {
	readonly endpoint: WorkerHostEndpoint;
	readonly readyTimeoutMs?: number;
	readonly cancelAckTimeoutMs?: number;
	readonly maxPendingRequests?: number;
	readonly maxInFlightRequests?: number;
	readonly maxBufferedChunks?: number;
	readonly maxBufferedBytes?: number;
	readonly maxChunksPerRequest?: number;
	readonly maxResultBytesPerRequest?: number;
	readonly metrics?: WorkerHostMetrics;
}

export interface WorkerHost {
	readonly state: WorkerHostState;
	submit(
		task: string,
		payload: Uint8Array,
		options?: Readonly<{ signal?: AbortSignal }>
	): AsyncGenerator<Uint8Array, void, void>;
	close(): void;
}

interface ResolvedHostOptions {
	readonly endpoint: WorkerHostEndpoint;
	readonly readyTimeoutMs: number;
	readonly cancelAckTimeoutMs: number;
	readonly maxPendingRequests: number;
	readonly maxInFlightRequests: number;
	readonly maxBufferedChunks: number;
	readonly maxBufferedBytes: number;
	readonly maxChunksPerRequest: number;
	readonly maxResultBytesPerRequest: number;
	readonly metrics: WorkerHostMetrics | undefined;
}

type RequestPhase = "pending" | "dispatched" | "cancelling";

interface RequestRecord {
	readonly id: string;
	readonly task: string;
	readonly payload: Uint8Array;
	readonly startedAt: number;
	readonly signal: AbortSignal | undefined;
	onAbort(): void;
	readonly chunks: Uint8Array[];
	phase: RequestPhase;
	nextSequence: number;
	receivedBytes: number;
	terminal: Readonly<{ error?: CodedError }> | undefined;
	wake: (() => void) | undefined;
	cancelTimer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_CANCEL_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 8;
const DEFAULT_MAX_BUFFERED_CHUNKS = 64;
const DEFAULT_MAX_BUFFERED_BYTES = 16_777_216;
const DEFAULT_MAX_CHUNKS_PER_REQUEST = 4_096;
const DEFAULT_MAX_RESULT_BYTES_PER_REQUEST = 16_777_216;

function boundedInteger(
	name: string,
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number
): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) throw invalidOption(name, resolved);
	return resolved;
}

function isAbortSignal(value: unknown): value is AbortSignal {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as AbortSignal).aborted === "boolean" &&
		typeof (value as AbortSignal).addEventListener === "function" &&
		typeof (value as AbortSignal).removeEventListener === "function"
	);
}

function isEndpoint(value: unknown): value is WorkerHostEndpoint {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<WorkerHostEndpoint>;
	return (
		typeof candidate.addEventListener === "function" &&
		typeof candidate.removeEventListener === "function" &&
		typeof candidate.postMessage === "function" &&
		typeof candidate.terminate === "function"
	);
}

function resolveOptions(options: WorkerHostOptions): ResolvedHostOptions {
	if (typeof options !== "object" || options === null) throw invalidOption("options", options);
	if (!isEndpoint(options.endpoint)) throw invalidOption("endpoint", options.endpoint);
	if (options.metrics !== undefined && !(options.metrics instanceof WorkerHostMetrics)) {
		throw invalidOption("metrics", options.metrics);
	}
	return {
		endpoint: options.endpoint,
		readyTimeoutMs: boundedInteger("readyTimeoutMs", options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS, 100, 60_000),
		cancelAckTimeoutMs: boundedInteger(
			"cancelAckTimeoutMs",
			options.cancelAckTimeoutMs,
			DEFAULT_CANCEL_ACK_TIMEOUT_MS,
			100,
			60_000
		),
		maxPendingRequests: boundedInteger(
			"maxPendingRequests",
			options.maxPendingRequests,
			DEFAULT_MAX_PENDING_REQUESTS,
			1,
			1_024
		),
		maxInFlightRequests: boundedInteger(
			"maxInFlightRequests",
			options.maxInFlightRequests,
			DEFAULT_MAX_IN_FLIGHT_REQUESTS,
			1,
			64
		),
		maxBufferedChunks: boundedInteger(
			"maxBufferedChunks",
			options.maxBufferedChunks,
			DEFAULT_MAX_BUFFERED_CHUNKS,
			1,
			256
		),
		maxBufferedBytes: boundedInteger(
			"maxBufferedBytes",
			options.maxBufferedBytes,
			DEFAULT_MAX_BUFFERED_BYTES,
			65_536,
			268_435_456
		),
		maxChunksPerRequest: boundedInteger(
			"maxChunksPerRequest",
			options.maxChunksPerRequest,
			DEFAULT_MAX_CHUNKS_PER_REQUEST,
			1,
			16_384
		),
		maxResultBytesPerRequest: boundedInteger(
			"maxResultBytesPerRequest",
			options.maxResultBytesPerRequest,
			DEFAULT_MAX_RESULT_BYTES_PER_REQUEST,
			65_536,
			268_435_456
		),
		metrics: options.metrics,
	};
}

function nowMilliseconds(): number {
	return typeof performance === "undefined" ? Date.now() : performance.now();
}

function elapsedMilliseconds(startedAt: number): number {
	return Math.max(0, nowMilliseconds() - startedAt);
}

function error(
	code: ConstructorParameters<typeof CodedError>[0],
	message: string,
	detail: Readonly<Record<string, unknown>> = {},
	cause?: unknown
): CodedError {
	return new CodedError(code, message, cause === undefined ? { detail } : { cause, detail });
}

function failedStream(failure: CodedError): AsyncGenerator<Uint8Array, void, void> {
	return (async function* (): AsyncGenerator<Uint8Array, void, void> {
		await Promise.resolve();
		yield* [] as Uint8Array[];
		throw failure;
	})();
}

/**
 * Binds a bounded request lifecycle to one already-constructed worker endpoint.
 * @param options - Endpoint, fixed limits, deadlines, and optional metrics owner.
 * @returns The host lifecycle and ordered request-stream API.
 */
export function createWorkerHost(options: WorkerHostOptions): WorkerHost {
	const resolved = resolveOptions(options);
	const { endpoint, metrics } = resolved;
	let state: WorkerHostState = "starting";
	let accepts: ReadonlySet<string> | undefined;
	let nextRequestNumber = 1;
	let inFlight = 0;
	let retainedBytes = 0;
	let endpointTerminated = false;
	let readyTimer: ReturnType<typeof setTimeout> | undefined;
	const startedAt = nowMilliseconds();
	const pending: RequestRecord[] = [];
	const open = new Map<string, RequestRecord>();

	const removeListeners = (): void => {
		endpoint.removeEventListener("message", onMessage);
		endpoint.removeEventListener("messageerror", onMessageError);
		endpoint.removeEventListener("error", onError);
	};

	const terminateEndpoint = (): void => {
		if (endpointTerminated) return;
		endpointTerminated = true;
		endpoint.terminate();
	};

	const wake = (request: RequestRecord): void => {
		const waiter = request.wake;
		request.wake = undefined;
		waiter?.();
	};

	const discardChunks = (request: RequestRecord): void => {
		for (const chunk of request.chunks) retainedBytes -= chunk.byteLength;
		request.chunks.length = 0;
	};

	const removePending = (request: RequestRecord): void => {
		const index = pending.indexOf(request);
		if (index >= 0) pending.splice(index, 1);
	};

	const cleanupRequest = (request: RequestRecord): void => {
		request.signal?.removeEventListener("abort", request.onAbort);
		if (request.cancelTimer !== undefined) clearTimeout(request.cancelTimer);
		request.cancelTimer = undefined;
		open.delete(request.id);
		if (request.phase === "pending") removePending(request);
		else inFlight -= 1;
		metrics?.observe("request-duration", elapsedMilliseconds(request.startedAt));
	};

	const flush = (): void => {
		if (state !== "ready" || accepts === undefined) return;
		while (inFlight < resolved.maxInFlightRequests && pending.length > 0) {
			const request = pending.shift();
			if (request === undefined || request.terminal !== undefined) continue;
			if (!accepts.has(request.task)) {
				request.terminal = {
					error: error("worker-host-task-failed", "Worker does not accept task", {
						task: request.task,
						wireCode: "worker-task-unknown",
					}),
				};
				cleanupRequest(request);
				wake(request);
				continue;
			}
			request.phase = "dispatched";
			inFlight += 1;
			metrics?.increment("requests-dispatched");
			const message: HostToWorkerMessage = {
				protocol: WORKER_HOST_PROTOCOL,
				version: WORKER_HOST_PROTOCOL_VERSION,
				kind: "request",
				id: request.id,
				task: request.task,
				payload: request.payload,
			};
			try {
				endpoint.postMessage(message, [request.payload.buffer]);
			} catch (cause) {
				terminateHost("terminated", error("worker-host-worker-terminated", "Worker endpoint post failed", {}, cause));
				return;
			}
		}
	};

	const settle = (request: RequestRecord, terminal: Readonly<{ error?: CodedError }>, discard: boolean): void => {
		if (request.terminal !== undefined) return;
		if (discard) discardChunks(request);
		request.terminal = terminal;
		cleanupRequest(request);
		wake(request);
		flush();
	};

	const terminateHost = (nextState: "closed" | "terminated", failure: CodedError): void => {
		if (state === "closed" || state === "terminated") return;
		state = nextState;
		if (readyTimer !== undefined) clearTimeout(readyTimer);
		readyTimer = undefined;
		removeListeners();
		terminateEndpoint();
		for (const request of [...open.values()]) settle(request, { error: failure }, true);
	};

	const protocolViolation = (): void => {
		terminateHost("terminated", error("worker-host-protocol-violation", "Worker protocol violation"));
	};

	const postCancel = (request: RequestRecord): boolean => {
		if (request.phase === "cancelling") return true;
		if (request.phase !== "dispatched") return false;
		request.phase = "cancelling";
		const message: HostToWorkerMessage = {
			protocol: WORKER_HOST_PROTOCOL,
			version: WORKER_HOST_PROTOCOL_VERSION,
			kind: "cancel",
			id: request.id,
		};
		try {
			endpoint.postMessage(message);
		} catch (cause) {
			terminateHost("terminated", error("worker-host-worker-terminated", "Worker endpoint cancel failed", {}, cause));
			return false;
		}
		return true;
	};

	const cancel = (request: RequestRecord): void => {
		if (request.terminal !== undefined) return;
		if (request.phase === "pending") {
			settle(request, { error: error("worker-host-cancelled", "Worker request cancelled") }, true);
			return;
		}
		if (!postCancel(request) || request.cancelTimer !== undefined) return;
		request.cancelTimer = setTimeout(() => {
			terminateHost(
				"terminated",
				error("worker-host-worker-terminated", "Worker cancellation acknowledgement timed out")
			);
		}, resolved.cancelAckTimeoutMs);
	};

	const routeChunk = (message: Extract<WorkerToHostMessage, { kind: "chunk" }>, request: RequestRecord): void => {
		if (request.phase === "cancelling") {
			metrics?.increment("chunks-dropped-after-cancel");
			return;
		}
		if (message.sequence !== request.nextSequence) {
			protocolViolation();
			return;
		}
		const nextChunks = request.nextSequence + 1;
		const nextBytes = request.receivedBytes + message.payload.byteLength;
		if (
			request.chunks.length >= resolved.maxBufferedChunks ||
			retainedBytes + message.payload.byteLength > resolved.maxBufferedBytes ||
			nextChunks > resolved.maxChunksPerRequest ||
			nextBytes > resolved.maxResultBytesPerRequest
		) {
			postCancel(request);
			settle(
				request,
				{
					error: error("worker-host-limit-exceeded", "Worker result exceeded a configured bound", {
						id: request.id,
					}),
				},
				true
			);
			return;
		}
		const payload = normalizeBytes(message.payload);
		request.nextSequence = nextChunks;
		request.receivedBytes = nextBytes;
		request.chunks.push(payload);
		retainedBytes += payload.byteLength;
		wake(request);
	};

	const routeTerminal = (
		message: Exclude<WorkerToHostMessage, { kind: "ready" | "chunk" }>,
		request: RequestRecord
	): void => {
		if (request.phase === "cancelling") {
			settle(request, { error: error("worker-host-cancelled", "Worker request cancelled") }, true);
			return;
		}
		if (message.chunks !== request.nextSequence || message.bytes !== request.receivedBytes) {
			protocolViolation();
			return;
		}
		if (message.kind === "failed") {
			settle(
				request,
				{
					error: error("worker-host-task-failed", message.message, {
						wireCode: message.code,
					}),
				},
				true
			);
			return;
		}
		if (message.kind === "cancelled") {
			settle(request, { error: error("worker-host-cancelled", "Worker request cancelled") }, true);
			return;
		}
		settle(request, {}, false);
	};

	const routeMessage = (message: WorkerToHostMessage): void => {
		if (message.kind === "ready") {
			if (state !== "starting") {
				protocolViolation();
				return;
			}
			state = "ready";
			accepts = new Set(message.accepts);
			if (readyTimer !== undefined) clearTimeout(readyTimer);
			readyTimer = undefined;
			metrics?.observe("handshake-duration", elapsedMilliseconds(startedAt));
			flush();
			return;
		}

		const request = open.get(message.id);
		if (request === undefined) {
			const issued = BigInt(`0x${message.id}`);
			if (issued > BigInt(0) && issued < BigInt(nextRequestNumber)) {
				metrics?.increment("stale-messages-ignored");
				return;
			}
			protocolViolation();
			return;
		}
		if (request.phase === "pending") {
			protocolViolation();
			return;
		}
		if (message.kind === "chunk") routeChunk(message, request);
		else routeTerminal(message, request);
	};

	function onMessage(event: EndpointEvent): void {
		if (state === "closed" || state === "terminated") return;
		let message: WorkerToHostMessage | undefined;
		try {
			message = parseWorkerMessage(event.data);
		} catch {
			protocolViolation();
			return;
		}
		if (message === undefined) {
			protocolViolation();
			return;
		}
		routeMessage(message);
	}

	function onMessageError(): void {
		terminateHost("terminated", error("worker-host-protocol-violation", "Worker message could not be cloned"));
	}

	function onError(): void {
		terminateHost("terminated", error("worker-host-worker-terminated", "Worker endpoint failed"));
	}

	endpoint.addEventListener("message", onMessage);
	endpoint.addEventListener("messageerror", onMessageError);
	endpoint.addEventListener("error", onError);
	readyTimer = setTimeout(() => {
		terminateHost("terminated", error("worker-host-handshake-timeout", "Worker ready handshake timed out"));
	}, resolved.readyTimeoutMs);

	const submit = (
		taskValue: string,
		payloadValue: Uint8Array,
		submitOptions?: Readonly<{ signal?: AbortSignal }>
	): AsyncGenerator<Uint8Array, void, void> => {
		if (state === "closed" || state === "terminated") throw error("worker-host-closed", "Worker host is closed");
		const task = requireTaskName(taskValue);
		const payload = requireInputBytes(payloadValue, MAX_REQUEST_BYTES, "payload");
		if (submitOptions !== undefined && (typeof submitOptions !== "object" || submitOptions === null)) {
			throw invalidOption("submit options", submitOptions);
		}
		const signal = submitOptions?.signal;
		if (signal !== undefined && !isAbortSignal(signal)) throw invalidOption("signal", signal);
		if (signal?.aborted === true) {
			return failedStream(error("worker-host-cancelled", "Worker request cancelled"));
		}
		if (
			(state === "starting" || inFlight >= resolved.maxInFlightRequests) &&
			pending.length >= resolved.maxPendingRequests
		) {
			throw error("worker-host-queue-overflow", "Worker request queue is full");
		}
		if (nextRequestNumber > Number.MAX_SAFE_INTEGER) {
			throw error("worker-host-limit-exceeded", "Worker request id space exhausted");
		}
		const id = nextRequestNumber.toString(16).padStart(16, "0");
		nextRequestNumber += 1;
		const request: RequestRecord = {
			id,
			task,
			payload,
			startedAt: nowMilliseconds(),
			signal,
			onAbort(): void {
				cancel(request);
			},
			chunks: [],
			phase: "pending",
			nextSequence: 0,
			receivedBytes: 0,
			terminal: undefined,
			wake: undefined,
			cancelTimer: undefined,
		};
		open.set(id, request);
		pending.push(request);
		metrics?.increment("requests-queued");
		signal?.addEventListener("abort", request.onAbort, { once: true });
		flush();

		return (async function* (): AsyncGenerator<Uint8Array, void, void> {
			let terminalObserved = false;
			try {
				while (true) {
					while (request.chunks.length === 0 && request.terminal === undefined) {
						await new Promise<void>((resolve) => {
							request.wake = resolve;
						});
					}
					const chunk = request.chunks.shift();
					if (chunk !== undefined) {
						retainedBytes -= chunk.byteLength;
						yield chunk;
						continue;
					}
					const terminal = request.terminal;
					if (terminal !== undefined) {
						terminalObserved = true;
						if (terminal.error !== undefined) throw terminal.error;
						return;
					}
				}
			} finally {
				if (!terminalObserved) cancel(request);
			}
		})();
	};

	return {
		get state(): WorkerHostState {
			return state;
		},
		submit,
		close(): void {
			if (state === "closed") return;
			if (state === "terminated") {
				state = "closed";
				return;
			}
			terminateHost("closed", error("worker-host-closed", "Worker host closed"));
		},
	};
}
