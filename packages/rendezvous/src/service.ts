import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type {
	AdmissionCredential,
	RegistrationReceipt,
	RegistryDiscoveryReceipt,
	RegistryRejection,
	RegistryServer,
	SignedDrpRecordV1,
} from "./index.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface RegistryHttpServiceOptions {
	readonly host?: string;
	readonly port?: number;
	readonly requestTimeoutMs?: number;
	readonly server: Pick<RegistryServer, "discover" | "register">;
}

export interface RegistryHttpService {
	readonly url: string;
	close(): Promise<void>;
}

/**
 * Starts the Node-only bounded HTTP adapter for a registry server.
 * @param options - Bind address, request deadline, and registry implementation.
 * @returns A listening service with forceful lifecycle cleanup.
 */
export async function createRegistryHttpService(options: RegistryHttpServiceOptions): Promise<RegistryHttpService> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 0;
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("registry service port is invalid");
	const requestTimeoutMs = boundedInteger(
		options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
		1,
		30_000,
		"requestTimeoutMs"
	);
	const httpServer = createServer(
		(request, response) => void handleRequest(request, response, options.server, requestTimeoutMs)
	);
	httpServer.requestTimeout = requestTimeoutMs;
	httpServer.headersTimeout = requestTimeoutMs;
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			httpServer.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			httpServer.off("error", onError);
			resolve();
		};
		httpServer.once("error", onError);
		httpServer.once("listening", onListening);
		httpServer.listen(port, host);
	});
	const address = httpServer.address();
	if (address === null || typeof address === "string") throw new Error("registry service did not bind a TCP address");
	const urlHost = address.address.includes(":") ? `[${address.address}]` : address.address;
	let closed = false;
	return Object.freeze({
		url: `http://${urlHost}:${address.port}/`,
		close: async (): Promise<void> => {
			if (closed) return;
			closed = true;
			const closing = new Promise<void>((resolve, reject) => {
				httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
			});
			httpServer.closeAllConnections();
			await closing;
		},
	});
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	registry: Pick<RegistryServer, "discover" | "register">,
	requestTimeoutMs: number
): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new Error("registry service request timed out"));
		request.socket.destroy();
	}, requestTimeoutMs);
	const onClose = (): void => {
		if (!request.complete) controller.abort(new Error("registry HTTP client disconnected"));
	};
	request.once("close", onClose);
	try {
		if (request.method !== "POST") return sendJson(response, 405, rejection("endpoint-unavailable"));
		if (request.url !== "/v1/register" && request.url !== "/v1/discover") {
			return sendJson(response, 404, rejection("endpoint-unavailable"));
		}
		if (!isJsonContentType(request.headers["content-type"])) {
			return sendJson(response, 415, rejection("record-rejected"));
		}
		const contentLength = parseContentLength(request.headers["content-length"]);
		if (contentLength === undefined) return sendJson(response, 400, rejection("record-rejected"));
		if (contentLength > MAX_REQUEST_BYTES) {
			response.setHeader("connection", "close");
			return sendJson(response, 413, rejection("record-rejected"));
		}
		const body = parseJson(await readRequestBody(request, controller.signal));
		if (request.url === "/v1/register") {
			if (!isObject(body) || !("record" in body) || !isObject(body.record) || typeof body.record.peerId !== "string") {
				return sendJson(response, 400, rejection("record-rejected"));
			}
			const result = await registry.register({
				clientId: body.record.peerId,
				...(body.credential === undefined ? {} : { credential: body.credential as AdmissionCredential }),
				record: body.record as unknown as SignedDrpRecordV1,
				signal: controller.signal,
			});
			return sendJson(response, 200, result);
		}
		if (request.url === "/v1/discover") {
			if (!isObject(body) || typeof body.namespace !== "string") {
				return sendJson(response, 400, rejection("record-rejected"));
			}
			const result = await registry.discover({
				clientId: transportClientId(request),
				namespace: body.namespace,
				signal: controller.signal,
			});
			return sendJson(response, 200, result);
		}
	} catch (error) {
		if (controller.signal.aborted) response.destroy();
		else if (!response.headersSent) {
			if (error instanceof RequestBodyTooLargeError) response.setHeader("connection", "close");
			sendJson(response, error instanceof RequestBodyTooLargeError ? 413 : 400, rejection("endpoint-unavailable"));
		} else response.destroy();
	} finally {
		clearTimeout(timeout);
		request.off("close", onClose);
	}
}

function readRequestBody(request: IncomingMessage, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let received = 0;
		const cleanup = (): void => {
			request.off("data", onData);
			request.off("end", onEnd);
			request.off("error", onError);
			signal.removeEventListener("abort", onAbort);
		};
		const onData = (chunk: Buffer): void => {
			received += chunk.byteLength;
			if (received > MAX_REQUEST_BYTES) onError(new RequestBodyTooLargeError());
			else chunks.push(chunk);
		};
		const onEnd = (): void => {
			cleanup();
			resolve(Buffer.concat(chunks).toString("utf8"));
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const onAbort = (): void => onError(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
		request.on("data", onData);
		request.once("end", onEnd);
		request.once("error", onError);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

class RequestBodyTooLargeError extends Error {
	constructor() {
		super("registry request cap exceeded");
		this.name = "RequestBodyTooLargeError";
	}
}

function parseContentLength(value: string | undefined): number | undefined {
	if (value === undefined) return 0;
	if (!/^\d+$/u.test(value)) return;
	const length = Number(value);
	return Number.isSafeInteger(length) ? length : undefined;
}

function sendJson(
	response: ServerResponse,
	status: number,
	value: RegistryDiscoveryReceipt | RegistrationReceipt | RegistryRejection
): void {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"content-length": Buffer.byteLength(body),
		"content-type": "application/json",
	});
	response.end(body);
}

function transportClientId(request: IncomingMessage): string {
	const address = request.socket.remoteAddress ?? "unknown";
	return `http-${address.replaceAll(/[^A-Za-z0-9_-]/gu, "-").slice(0, 59)}`;
}

function parseJson(value: string): unknown {
	return JSON.parse(value) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonContentType(value: string | undefined): boolean {
	return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function rejection(code: RegistryRejection["code"]): RegistryRejection {
	return { accepted: false, code };
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
	}
	return value;
}
