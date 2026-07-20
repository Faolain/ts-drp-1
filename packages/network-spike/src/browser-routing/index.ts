import {
	delegatedRoutingV1HttpApiClient,
	type DelegatedRoutingV1HttpApiClient,
	type PeerRecord,
} from "@helia/delegated-routing-v1-http-api-client";
import type { ComponentLogger, Logger } from "@libp2p/interface";
import { defaultLogger } from "@libp2p/logger";
import { peerIdFromCID, peerIdFromString } from "@libp2p/peer-id";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { identity } from "multiformats/hashes/identity";

import { type AddressDecision, AddressPolicy, type Resolver } from "../probe/address-policy.js";

export const PUBLIC_DELEGATED_ROUTING_ACKNOWLEDGEMENT = "I_ACKNOWLEDGE_PUBLIC_DELEGATED_ROUTING";

const DEFAULT_LIMITS: BrowserRoutingLimits = {
	maxAddressesPerPeer: 16,
	maxEndpoints: 4,
	maxResponseBytes: 256 * 1024,
	maxResults: 32,
};

export interface BrowserRoutingEndpoint {
	id: string;
	url: string;
}

export interface BrowserRoutingLimits {
	maxAddressesPerPeer: number;
	maxEndpoints: number;
	maxResponseBytes: number;
	maxResults: number;
}

export interface BrowserRoutingOptions {
	/**
	 * Local fixture escape hatch. Production browser routing still rejects
	 * plaintext WebSockets even when loopback addresses are allowed.
	 */
	allowInsecureWebSocketFixture?: boolean;
	allowInsecureLoopback?: boolean;
	/** Local fixture escape hatch for loopback peer records. */
	allowLoopbackAddressFixture?: boolean;
	allowedOrigins: readonly string[];
	backoffBaseMs?: number;
	cacheTTLms?: number;
	endpoints: readonly BrowserRoutingEndpoint[];
	fetch?: typeof globalThis.fetch;
	limits?: Partial<BrowserRoutingLimits>;
	now?(): number;
	resolver: Resolver;
	sleep?(durationMs: number, signal: AbortSignal): Promise<void>;
	timeoutMs?: number;
}

export interface BrowserRoutingPeer {
	acceptedAddresses: string[];
	addressDecisions: Array<{ address: string; decision: AddressDecision }>;
	inputAddressCount: number;
	peerId: string;
	protocols: string[];
	rawAddresses: string[];
	truncatedAddressCount: number;
}

export type BrowserRoutingOperation = "find-peer" | "find-providers" | "get-closest-peers";
export type BrowserRoutingTerminal = "aborted" | "empty" | "exhausted" | "success";

export interface EndpointAttempt {
	backoffMs: number;
	durationMs: number;
	endpointId: string;
	error?: string;
	httpStatus?: number;
	retryAfterMs?: number;
	status: "aborted" | "empty" | "failure" | "success";
}

export interface BrowserRoutingTrace {
	acceptedAddressCount: number;
	attempts: EndpointAttempt[];
	cache: "disabled" | "hit" | "miss" | "stale";
	durationMs: number;
	finishedAtMs: number;
	operation: BrowserRoutingOperation;
	rawAddressCount: number;
	resultCount: number;
	startedAtMs: number;
	terminal: BrowserRoutingTerminal;
}

export interface BrowserRouting {
	readonly canProvide: false;
	readonly lastTrace: BrowserRoutingTrace | undefined;
	findPeer(peerId: string, signal: AbortSignal): Promise<BrowserRoutingPeer>;
	findProviders(cid: string, signal: AbortSignal): AsyncIterable<BrowserRoutingPeer>;
	getClosestPeers(key: Uint8Array, signal: AbortSignal): AsyncIterable<BrowserRoutingPeer>;
	stop(): Promise<void>;
}

interface EndpointState {
	failures: number;
	retryAtMs: number;
}

interface CacheEntry {
	expiresAtMs: number;
	peers: BrowserRoutingPeer[];
}

interface AttemptDiagnostics {
	errors: Error[];
	httpStatus?: number;
	retryAfterMs?: number;
}

interface EndpointClientFactoryOptions {
	diagnostics: AttemptDiagnostics;
	endpoint: BrowserRoutingEndpoint;
	timeoutMs: number;
}

type EndpointClientFactory = (options: EndpointClientFactoryOptions) => DelegatedRoutingV1HttpApiClient;

/**
 * Raised when a successful delegated query has no browser-dialable peer.
 */
export class BrowserRoutingNotFoundError extends Error {
	/**
	 * @param message - Optional diagnostic override
	 */
	constructor(message = "delegated routing returned no browser-dialable peer") {
		super(message);
		this.name = "BrowserRoutingNotFoundError";
	}
}

/**
 * Raised after every configured delegated endpoint has failed.
 */
export class BrowserRoutingExhaustedError extends Error {
	readonly trace: BrowserRoutingTrace;

	/**
	 * @param trace - Complete ordered attempt trace for the failed operation
	 */
	constructor(trace: BrowserRoutingTrace) {
		super("all delegated routing endpoints failed");
		this.name = "BrowserRoutingExhaustedError";
		this.trace = trace;
	}
}

/**
 * Raised when a delegated response exceeds the configured byte cap.
 */
export class OversizedRoutingResponseError extends Error {
	/**
	 * @param maximumBytes - Configured maximum response size
	 */
	constructor(maximumBytes: number) {
		super(`delegated routing response exceeded ${maximumBytes} bytes`);
		this.name = "OversizedRoutingResponseError";
	}
}

/**
 * Browser-only delegated Routing V1 adapter.
 *
 * The installed Helia client intentionally remains the response parser. This
 * wrapper supplies the policy the dependency does not own: endpoint allowlists,
 * ordered failover, bounded backoff, response limits, strict diagnostics,
 * browser address filtering, and a small deterministic result cache.
 */
export class DelegatedBrowserRouting implements BrowserRouting {
	readonly canProvide = false as const;
	readonly #backoffBaseMs: number;
	readonly #cache = new Map<string, CacheEntry>();
	readonly #cacheTTLms: number;
	readonly #clientFactory: EndpointClientFactory;
	readonly #endpoints: readonly BrowserRoutingEndpoint[];
	readonly #endpointStates = new Map<string, EndpointState>();
	readonly #fetch: typeof globalThis.fetch;
	readonly #limits: Readonly<BrowserRoutingLimits>;
	readonly #now: () => number;
	readonly #policy: AddressPolicy;
	readonly #resolver: Resolver;
	readonly #sleep: (durationMs: number, signal: AbortSignal) => Promise<void>;
	readonly #timeoutMs: number;
	#lastTrace?: BrowserRoutingTrace;
	#operationTail: Promise<void> = Promise.resolve();
	#stopped = false;

	/**
	 * @param options - Endpoint, cache, timeout, and address-policy dependencies
	 * @param clientFactory - Test seam; production uses the maintained Helia client
	 */
	constructor(options: BrowserRoutingOptions, clientFactory: EndpointClientFactory = createHeliaClient) {
		this.#policy = new AddressPolicy({
			allowInsecureWebSocket: options.allowInsecureWebSocketFixture,
			allowLoopback: options.allowLoopbackAddressFixture,
			target: "browser",
		});
		this.#limits = Object.freeze(parseLimits(options.limits));
		this.#endpoints = validateEndpoints(options, this.#limits);
		this.#resolver = options.resolver;
		this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.#now = options.now ?? Date.now;
		this.#sleep = options.sleep ?? abortableDelay;
		this.#timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 1, 30_000, "timeoutMs");
		this.#cacheTTLms = boundedInteger(options.cacheTTLms ?? 60_000, 0, 300_000, "cacheTTLms");
		this.#backoffBaseMs = boundedInteger(options.backoffBaseMs ?? 100, 1, 2_000, "backoffBaseMs");
		this.#clientFactory = clientFactory;
		for (const endpoint of this.#endpoints) this.#endpointStates.set(endpoint.id, { failures: 0, retryAtMs: 0 });
	}

	/**
	 * Return a defensive copy of the latest operational diagnostic trace.
	 * @returns The latest trace, or undefined before the first operation
	 */
	get lastTrace(): BrowserRoutingTrace | undefined {
		return this.#lastTrace === undefined ? undefined : cloneTrace(this.#lastTrace);
	}

	/**
	 * Find one browser-dialable peer.
	 * @param peerId - Peer ID to resolve
	 * @param signal - Caller-owned cancellation signal
	 * @returns The first validated browser-dialable peer
	 */
	async findPeer(peerId: string, signal: AbortSignal): Promise<BrowserRoutingPeer> {
		const id = peerIdFromString(peerId);
		const peers = await this.#enqueue(() =>
			this.#execute("find-peer", `peer:${id}`, signal, (client, boundedSignal) =>
				client.getPeers(id.toCID(), { signal: boundedSignal })
			)
		);
		const peer = peers[0];
		if (peer === undefined) throw new BrowserRoutingNotFoundError();
		return peer;
	}

	/**
	 * Find browser-dialable providers for a CID.
	 * @param cid - Content identifier to resolve
	 * @param signal - Caller-owned cancellation signal
	 * @yields Validated browser-dialable provider records
	 */
	async *findProviders(cid: string, signal: AbortSignal): AsyncIterable<BrowserRoutingPeer> {
		const parsedCid = CID.parse(cid);
		const peers = await this.#enqueue(() =>
			this.#execute("find-providers", `providers:${parsedCid}`, signal, (client, boundedSignal) =>
				client.getProviders(parsedCid, { signal: boundedSignal })
			)
		);
		yield* peers;
	}

	/**
	 * Find browser-dialable peers closest to a routing key.
	 * @param key - Opaque routing key bytes
	 * @param signal - Caller-owned cancellation signal
	 * @yields Validated browser-dialable peer records
	 */
	async *getClosestPeers(key: Uint8Array, signal: AbortSignal): AsyncIterable<BrowserRoutingPeer> {
		const cid = CID.createV1(raw.code, identity.digest(key));
		const peers = await this.#enqueue(() =>
			this.#execute("get-closest-peers", `closest:${cid}`, signal, (client, boundedSignal) =>
				client.getClosestPeers(cid, { signal: boundedSignal })
			)
		);
		yield* peers;
	}

	/**
	 * Stop new work, clear cached results, and await the active operation.
	 */
	async stop(): Promise<void> {
		this.#stopped = true;
		this.#cache.clear();
		await this.#operationTail;
	}

	async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#operationTail;
		let release = (): void => undefined;
		this.#operationTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	async #execute(
		operation: BrowserRoutingOperation,
		cacheKey: string,
		signal: AbortSignal,
		invoke: (client: DelegatedRoutingV1HttpApiClient, signal: AbortSignal) => AsyncIterable<PeerRecord>
	): Promise<BrowserRoutingPeer[]> {
		if (this.#stopped) throw new Error("BrowserRouting is stopped");
		const startedAtMs = this.#now();
		const attempts: EndpointAttempt[] = [];
		if (signal.aborted) {
			this.#recordTrace(operation, this.#cacheTTLms === 0 ? "disabled" : "miss", attempts, startedAtMs, [], "aborted");
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		const cached = this.#cache.get(cacheKey);
		let cache: BrowserRoutingTrace["cache"] = this.#cacheTTLms === 0 ? "disabled" : "miss";
		if (cached !== undefined) {
			if (cached.expiresAtMs > startedAtMs) {
				cache = "hit";
				const peers = clonePeers(cached.peers);
				this.#recordTrace(operation, cache, attempts, startedAtMs, peers, peers.length === 0 ? "empty" : "success");
				return peers;
			}
			cache = "stale";
			this.#cache.delete(cacheKey);
		}

		for (const endpoint of this.#endpoints) {
			const state = this.#endpointStates.get(endpoint.id);
			if (state === undefined) throw new Error(`missing endpoint state for ${endpoint.id}`);
			const backoffMs = Math.max(0, state.retryAtMs - this.#now());
			if (backoffMs > 0) {
				try {
					await this.#sleep(backoffMs, signal);
				} catch (error) {
					if (!signal.aborted) throw error;
					attempts.push({
						backoffMs,
						durationMs: 0,
						endpointId: endpoint.id,
						error: errorMessage(error),
						status: "aborted",
					});
					this.#recordTrace(operation, cache, attempts, startedAtMs, [], "aborted");
					throw signal.reason ?? error;
				}
			}
			const attemptStartedAt = this.#now();
			const diagnostics: AttemptDiagnostics = { errors: [] };
			const client = this.#clientFactory({ diagnostics, endpoint, timeoutMs: this.#timeoutMs });
			const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]);
			try {
				const records = await withScopedFetch(
					this.#fetch,
					endpoint,
					this.#limits.maxResponseBytes,
					diagnostics,
					this.#now,
					async () => {
						await client.start();
						const output: PeerRecord[] = [];
						for await (const record of invoke(client, boundedSignal)) {
							output.push(record);
							if (output.length >= this.#limits.maxResults) break;
						}
						return output;
					}
				);
				if (
					diagnostics.errors.length > 0 ||
					(diagnostics.httpStatus !== undefined && diagnostics.httpStatus >= 400 && diagnostics.httpStatus !== 404)
				) {
					throw diagnostics.errors[0] ?? new Error(`delegated endpoint returned HTTP ${diagnostics.httpStatus}`);
				}
				const peers = await this.#sanitizeRecords(records, signal);
				state.failures = 0;
				state.retryAtMs = 0;
				attempts.push({
					backoffMs,
					durationMs: this.#now() - attemptStartedAt,
					endpointId: endpoint.id,
					...(diagnostics.httpStatus === undefined ? {} : { httpStatus: diagnostics.httpStatus }),
					status: peers.length === 0 ? "empty" : "success",
				});
				if (this.#cacheTTLms > 0) {
					this.#cache.set(cacheKey, {
						expiresAtMs: this.#now() + this.#cacheTTLms,
						peers: clonePeers(peers),
					});
				}
				this.#recordTrace(operation, cache, attempts, startedAtMs, peers, peers.length === 0 ? "empty" : "success");
				return peers;
			} catch (error) {
				if (signal.aborted) {
					attempts.push({
						backoffMs,
						durationMs: this.#now() - attemptStartedAt,
						endpointId: endpoint.id,
						error: errorMessage(error),
						status: "aborted",
					});
					this.#recordTrace(operation, cache, attempts, startedAtMs, [], "aborted");
					throw signal.reason ?? error;
				}
				state.failures++;
				const retryAfterMs =
					diagnostics.retryAfterMs ?? Math.min(this.#backoffBaseMs * 2 ** Math.max(0, state.failures - 1), 2_000);
				state.retryAtMs = this.#now() + retryAfterMs;
				attempts.push({
					backoffMs,
					durationMs: this.#now() - attemptStartedAt,
					endpointId: endpoint.id,
					error: errorMessage(error),
					...(diagnostics.httpStatus === undefined ? {} : { httpStatus: diagnostics.httpStatus }),
					retryAfterMs,
					status: "failure",
				});
			} finally {
				await client.stop().catch(() => undefined);
			}
		}

		const trace = this.#recordTrace(operation, cache, attempts, startedAtMs, [], "exhausted");
		throw new BrowserRoutingExhaustedError(trace);
	}

	async #sanitizeRecords(records: PeerRecord[], signal: AbortSignal): Promise<BrowserRoutingPeer[]> {
		const peers: BrowserRoutingPeer[] = [];
		for (const record of records) {
			throwIfAborted(signal);
			const peerId = peerIdFromCID(record.ID).toString();
			const inputAddresses = (record.Addrs ?? []).map((address) => address.toString());
			const rawAddresses = inputAddresses.slice(0, this.#limits.maxAddressesPerPeer);
			const plan = await this.#policy.plan(
				rawAddresses.map((address, index) => ({
					address,
					addressPseudonym: `address-${index + 1}`,
					candidatePseudonym: "delegated-peer",
				})),
				this.#resolver,
				signal,
				this.#limits.maxAddressesPerPeer
			);
			const addressDecisions = [...plan.accepted, ...plan.rejected].map(({ candidate, decision }) => ({
				address: candidate.address,
				decision,
			}));
			const acceptedAddresses = plan.accepted.map(({ candidate }) => candidate.address);
			if (acceptedAddresses.length === 0) continue;
			peers.push({
				acceptedAddresses,
				addressDecisions,
				inputAddressCount: inputAddresses.length,
				peerId,
				protocols: [...new Set(record.Protocols ?? [])].slice(0, 32),
				rawAddresses,
				truncatedAddressCount: Math.max(0, inputAddresses.length - rawAddresses.length),
			});
		}
		return peers;
	}

	#recordTrace(
		operation: BrowserRoutingOperation,
		cache: BrowserRoutingTrace["cache"],
		attempts: EndpointAttempt[],
		startedAtMs: number,
		peers: BrowserRoutingPeer[],
		terminal: BrowserRoutingTerminal
	): BrowserRoutingTrace {
		const finishedAtMs = this.#now();
		const trace: BrowserRoutingTrace = {
			acceptedAddressCount: peers.reduce((total, peer) => total + peer.acceptedAddresses.length, 0),
			attempts: attempts.map((attempt) => ({ ...attempt })),
			cache,
			durationMs: Math.max(0, finishedAtMs - startedAtMs),
			finishedAtMs,
			operation,
			rawAddressCount: peers.reduce((total, peer) => total + peer.rawAddresses.length, 0),
			resultCount: peers.length,
			startedAtMs,
			terminal,
		};
		this.#lastTrace = trace;
		return cloneTrace(trace);
	}
}

/**
 * Create the production delegated browser-routing adapter.
 * @param options - Endpoint, bounds, cache, and address-policy dependencies
 * @returns A lookup-only browser routing surface
 */
export function createBrowserRouting(options: BrowserRoutingOptions): BrowserRouting {
	return new DelegatedBrowserRouting(options);
}

function createHeliaClient(options: EndpointClientFactoryOptions): DelegatedRoutingV1HttpApiClient {
	return delegatedRoutingV1HttpApiClient({
		cacheTTL: 0,
		concurrentRequests: 1,
		filterAddrs: ["webtransport", "webrtc-direct", "wss", "p2p-circuit"],
		timeout: options.timeoutMs,
		url: options.endpoint.url,
	})({
		logger: diagnosticLogger(options.diagnostics),
	});
}

function diagnosticLogger(diagnostics: AttemptDiagnostics): ComponentLogger {
	const base = defaultLogger();
	return {
		forComponent(name: string): Logger {
			return wrapLogger(base.forComponent(name), diagnostics);
		},
	};
}

function wrapLogger(base: Logger, diagnostics: AttemptDiagnostics): Logger {
	const output = ((formatter: unknown, ...args: unknown[]) => base(formatter, ...args)) as Logger;
	output.error = (formatter: unknown, ...args: unknown[]): void => {
		const error = args.find((value): value is Error => value instanceof Error);
		diagnostics.errors.push(error ?? new Error(String(formatter)));
		base.error(formatter, ...args);
	};
	output.trace = (formatter: unknown, ...args: unknown[]): void => base.trace(formatter, ...args);
	output.enabled = base.enabled;
	output.newScope = (name: string): Logger => wrapLogger(base.newScope(name), diagnostics);
	return output;
}

let fetchScopeTail: Promise<void> = Promise.resolve();

async function withScopedFetch<T>(
	fetchImplementation: typeof globalThis.fetch,
	endpoint: BrowserRoutingEndpoint,
	maximumBytes: number,
	diagnostics: AttemptDiagnostics,
	now: () => number,
	operation: () => Promise<T>
): Promise<T> {
	const previous = fetchScopeTail;
	let release = (): void => undefined;
	fetchScopeTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
		const endpointUrl = new URL(endpoint.url);
		if (requestUrl.origin !== endpointUrl.origin || !requestUrl.pathname.startsWith(endpointUrl.pathname)) {
			return originalFetch(input, init);
		}
		const response = await fetchImplementation(input, {
			...init,
			credentials: "omit",
			redirect: "error",
			referrerPolicy: "no-referrer",
		});
		diagnostics.httpStatus = response.status;
		diagnostics.retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now);
		return boundedResponse(response, maximumBytes);
	};
	try {
		return await operation();
	} finally {
		globalThis.fetch = originalFetch;
		release();
	}
}

function boundedResponse(response: Response, maximumBytes: number): Response {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
		throw new OversizedRoutingResponseError(maximumBytes);
	}
	if (response.body === null) return response;
	const reader = response.body.getReader();
	let received = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller): Promise<void> {
			const next = await reader.read();
			if (next.done) {
				controller.close();
				return;
			}
			received += next.value.byteLength;
			if (received > maximumBytes) {
				await reader.cancel();
				controller.error(new OversizedRoutingResponseError(maximumBytes));
				return;
			}
			controller.enqueue(next.value);
		},
		cancel(reason): Promise<void> {
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
}

function validateEndpoints(
	options: BrowserRoutingOptions,
	limits: BrowserRoutingLimits
): readonly BrowserRoutingEndpoint[] {
	if (options.endpoints.length < 1 || options.endpoints.length > limits.maxEndpoints) {
		throw new Error(`delegated endpoint count must be within 1..${limits.maxEndpoints}`);
	}
	const allowedOrigins = new Set(options.allowedOrigins.map((origin) => new URL(origin).origin));
	const ids = new Set<string>();
	return Object.freeze(
		options.endpoints.map((endpoint) => {
			if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(endpoint.id) || ids.has(endpoint.id)) {
				throw new Error(`invalid or duplicate delegated endpoint id "${endpoint.id}"`);
			}
			ids.add(endpoint.id);
			const url = new URL(endpoint.url);
			if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
				throw new Error(`delegated endpoint "${endpoint.id}" must not contain credentials, query, or fragment`);
			}
			const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
			if (
				url.protocol !== "https:" &&
				!(options.allowInsecureLoopback === true && loopback && url.protocol === "http:")
			) {
				throw new Error(`delegated endpoint "${endpoint.id}" must use HTTPS`);
			}
			if (!allowedOrigins.has(url.origin)) {
				throw new Error(`delegated endpoint "${endpoint.id}" is not on the origin allowlist`);
			}
			if (!url.pathname.endsWith("/")) url.pathname += "/";
			return Object.freeze({ id: endpoint.id, url: url.toString() });
		})
	);
}

function parseLimits(input: Partial<BrowserRoutingLimits> | undefined): BrowserRoutingLimits {
	return {
		maxAddressesPerPeer: boundedInteger(
			input?.maxAddressesPerPeer ?? DEFAULT_LIMITS.maxAddressesPerPeer,
			1,
			64,
			"maxAddressesPerPeer"
		),
		maxEndpoints: boundedInteger(input?.maxEndpoints ?? DEFAULT_LIMITS.maxEndpoints, 1, 8, "maxEndpoints"),
		maxResponseBytes: boundedInteger(
			input?.maxResponseBytes ?? DEFAULT_LIMITS.maxResponseBytes,
			1024,
			1024 * 1024,
			"maxResponseBytes"
		),
		maxResults: boundedInteger(input?.maxResults ?? DEFAULT_LIMITS.maxResults, 1, 64, "maxResults"),
	};
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
	}
	return value;
}

function parseRetryAfter(value: string | null, now: () => number): number | undefined {
	if (value === null) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1000), 2_000);
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return undefined;
	return Math.min(Math.max(0, timestamp - now()), 2_000);
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(onResolve, durationMs);
		const onAbort = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		};
		function onResolve(): void {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function clonePeers(peers: BrowserRoutingPeer[]): BrowserRoutingPeer[] {
	return peers.map((peer) => ({
		...peer,
		acceptedAddresses: [...peer.acceptedAddresses],
		addressDecisions: peer.addressDecisions.map(({ address, decision }) => ({
			address,
			decision: {
				...decision,
				reasons: [...decision.reasons],
				resolvedScopes: [...decision.resolvedScopes],
				transports: [...decision.transports],
			},
		})),
		protocols: [...peer.protocols],
		rawAddresses: [...peer.rawAddresses],
	}));
}

function cloneTrace(trace: BrowserRoutingTrace): BrowserRoutingTrace {
	return {
		...trace,
		attempts: trace.attempts.map((attempt) => ({ ...attempt })),
	};
}
