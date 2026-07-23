import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { reconcileValidatedRecords, ReconciliationCapacityError } from "./reconciliation.js";
import {
	canonicalPayloadBytes,
	type RecordRejectionCode,
	type RecordValidator,
	type SignedDrpRecordPayloadV1,
	type SignedDrpRecordV1,
} from "./record.js";
import {
	type AdmissionCredential,
	type ClientRegistrationReceipt,
	DEFAULT_REGISTRY_LIMITS,
	type RegistryAttempt,
	type RegistryBackendSelection,
	RegistryExhaustedError,
	type RendezvousDirectory,
	type ValidatedDrpRecord,
} from "./registry.js";

const ADDRESSABLE_EVENT_KIND = 30_078;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 4_000;
const ENDPOINT_ID_PATTERN = /^[a-z0-9-]{1,32}$/u;
const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const HEX_SIGNATURE_PATTERN = /^[0-9a-f]{128}$/u;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** NIP-01 event transported by a relay connection. */
export interface NostrEvent {
	readonly id: string;
	readonly pubkey: string;
	readonly created_at: number;
	readonly kind: number;
	readonly tags: readonly (readonly string[])[];
	readonly content: string;
	readonly sig: string;
}

/** NIP-01 subscription filter supported by the injected connection seam. */
export interface NostrFilter {
	readonly kinds?: readonly number[];
	readonly limit?: number;
	readonly [tagName: `#${string}`]: readonly string[] | readonly number[] | number | undefined;
}

/** Relay acknowledgement for an EVENT publish. */
export interface NostrPublishResult {
	readonly accepted: boolean;
	readonly message?: string;
}

/** Stable identity and URL for one relay backend. */
export interface NostrRelayEndpoint {
	readonly id: string;
	readonly url: string;
}

/** Browser-safe relay connection seam used by production and fixture transports. */
export interface NostrRelayConnection {
	close(): Promise<void> | void;
	publish(event: NostrEvent, signal: AbortSignal): Promise<NostrPublishResult>;
	query(filter: NostrFilter, signal: AbortSignal): AsyncIterable<NostrEvent>;
}

/** Creates one bounded relay connection for an operation. */
export type NostrRelayConnectionFactory = (
	relay: NostrRelayEndpoint,
	signal: AbortSignal
) => Promise<NostrRelayConnection>;

/** Transport-only BIP-340 signer. It is never consulted for DRP authorization. */
export interface NostrSigner {
	getPublicKey(signal: AbortSignal): Promise<string> | string;
	signEventId(eventId: string, signal: AbortSignal): Promise<string> | string;
}

/** Hard bounds applied independently to each relay snapshot. */
export interface NostrRelayLimits {
	readonly maxResponseBytes?: number;
	readonly maxResponseRecords?: number;
	readonly requestTimeoutMs?: number;
}

/** Dependencies, endpoints, and fixture policy for a Nostr relay directory. */
export interface NostrRelayDirectoryOptions {
	readonly allow_insecure_loopback_fixture?: boolean;
	readonly connectionFactory: NostrRelayConnectionFactory;
	readonly limits?: NostrRelayLimits;
	readonly nostrSigner: NostrSigner;
	now(): number;
	readonly relays: readonly NostrRelayEndpoint[];
	validatorFactory(): RecordValidator;
}

interface RelayDiscoveryResult {
	readonly attempt: RegistryAttempt;
	readonly records?: readonly ValidatedDrpRecord[];
}

/** Typed terminal for invalid local Nostr signer configuration. */
export class NostrSignerConfigurationError extends Error {
	/** @param message - Stable caller-facing configuration detail. */
	constructor(message: string) {
		super(message);
		this.name = "NostrSignerConfigurationError";
	}
}

/** Typed terminal for an invalid local Nostr relay catalog. */
export class NostrRelayConfigurationError extends Error {
	/** @param message - Stable caller-facing configuration detail. */
	constructor(message: string) {
		super(message);
		this.name = "NostrRelayConfigurationError";
	}
}

/** Typed terminal when registration receives a DRP record that discovery would reject. */
export class NostrRecordValidationError extends Error {
	readonly code: RecordRejectionCode;

	/**
	 * @param code - Stable DRP record rejection code.
	 * @param detail - Optional sanitized validation detail.
	 */
	constructor(code: RecordRejectionCode, detail?: string) {
		super(
			detail === undefined
				? `Nostr registration record rejected: ${code}`
				: `Nostr registration record rejected: ${code} (${detail})`
		);
		this.name = "NostrRecordValidationError";
		this.code = code;
	}
}

/**
 * Creates a browser-safe BIP-340 signer from a 32-byte Nostr transport key.
 * @param secretKey - Nostr transport secret, copied and retained by the signer.
 * @returns A signer suitable for `NostrRelayDirectoryOptions`.
 */
export function createNostrSignerFromSecretKey(secretKey: Uint8Array): NostrSigner {
	if (secretKey.byteLength !== 32) {
		throw new NostrSignerConfigurationError("Nostr secret key must be exactly 32-byte binary data");
	}
	const retainedSecretKey = new Uint8Array(secretKey);
	const publicKey = bytesToHex(schnorr.getPublicKey(retainedSecretKey));
	return Object.freeze({
		getPublicKey: (signal: AbortSignal): string => {
			signal.throwIfAborted();
			return publicKey;
		},
		signEventId: (eventId: string, signal: AbortSignal): string => {
			signal.throwIfAborted();
			if (!HEX_PUBLIC_KEY_PATTERN.test(eventId)) throw new Error("Nostr event ID must be 32-byte lowercase hex");
			const signature = bytesToHex(schnorr.sign(hexToBytes(eventId), retainedSecretKey));
			signal.throwIfAborted();
			return signature;
		},
	});
}

/**
 * NIP-78 rendezvous backend. Nostr is transport only; every embedded record is
 * revalidated by the DRP identity validator before it can be returned.
 */
export class NostrRelayDirectory implements RendezvousDirectory {
	readonly #connectionFactory: NostrRelayConnectionFactory;
	readonly #maxResponseBytes: number;
	readonly #maxResponseRecords: number;
	readonly #nostrSigner: NostrSigner;
	readonly #now: () => number;
	readonly #relays: readonly NostrRelayEndpoint[];
	readonly #requestTimeoutMs: number;
	readonly #validatorFactory: () => RecordValidator;
	readonly #lastCreatedAtByReplacementKey = new Map<string, number>();
	#lastAttempts: readonly RegistryAttempt[] = [];

	/**
	 * @param options - Validated relay catalog, signer, connection seam, clock, and bounds.
	 */
	constructor(options: NostrRelayDirectoryOptions) {
		if (options.relays.length < 1 || options.relays.length > DEFAULT_REGISTRY_LIMITS.maxEndpoints) {
			throw new Error(
				`Nostr directory requires at least one and at most ${DEFAULT_REGISTRY_LIMITS.maxEndpoints} relays`
			);
		}
		const ids = options.relays.map(({ id }) => validateEndpointId(id));
		if (new Set(ids).size !== ids.length) throw new Error("Nostr relay IDs must be unique");
		const relays = options.relays.map((relay) =>
			Object.freeze({
				id: relay.id,
				url: validateRelayUrl(relay.url, options.allow_insecure_loopback_fixture === true).toString(),
			})
		);
		if (new Set(relays.map(({ url }) => url)).size !== relays.length) {
			throw new NostrRelayConfigurationError("Nostr relay URLs must be unique after normalization");
		}
		this.#relays = relays;
		this.#maxResponseBytes = boundedInteger(
			options.limits?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
			1_024,
			1024 * 1024,
			"maxResponseBytes"
		);
		this.#maxResponseRecords = boundedInteger(
			options.limits?.maxResponseRecords ?? DEFAULT_REGISTRY_LIMITS.maxResponseRecords,
			1,
			256,
			"maxResponseRecords"
		);
		this.#requestTimeoutMs = boundedInteger(
			options.limits?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			1,
			30_000,
			"requestTimeoutMs"
		);
		this.#connectionFactory = options.connectionFactory;
		this.#nostrSigner = options.nostrSigner;
		this.#now = options.now;
		this.#validatorFactory = options.validatorFactory;
	}

	/** @returns Last sanitized relay-attempt trace. */
	get lastAttempts(): readonly RegistryAttempt[] {
		return this.#lastAttempts;
	}

	/**
	 * Publishes one signed DRP record to every relay and succeeds on one acknowledgement.
	 * @param record - Canonical signed DRP record embedded in the event content.
	 * @param signal - Caller-owned cancellation signal.
	 * @param _credential - Ignored backend credential; Nostr publication admission is relay-owned.
	 * @returns Ordered per-relay attempts and the replicated record sequence.
	 */
	async register(
		record: SignedDrpRecordV1,
		signal: AbortSignal,
		_credential?: AdmissionCredential
	): Promise<ClientRegistrationReceipt> {
		signal.throwIfAborted();
		const checked = await this.#validatorFactory().validate(record, {
			admission: { accepted: true, mode: "open" },
			expectedNamespace: record.namespace,
			signal,
		});
		if (!checked.accepted) throw new NostrRecordValidationError(checked.code, checked.detail);
		const event = await withDeadline(signal, this.#requestTimeoutMs, (deadlineSignal) =>
			this.#createEvent(checked.record, deadlineSignal)
		);
		const attempts = await Promise.all(this.#relays.map((relay) => this.#publishToRelay(relay, event, signal)));
		signal.throwIfAborted();
		this.#lastAttempts = Object.freeze(attempts);
		const acceptedEndpointIds = attempts
			.filter(({ status }) => status === "accepted")
			.map(({ endpointId }) => endpointId);
		if (acceptedEndpointIds.length === 0) throw new RegistryExhaustedError("register", attempts);
		return { acceptedEndpointIds, attempts, sequence: record.sequence };
	}

	/**
	 * Queries selected relays, rejects invalid snapshots, and reconciles valid DRP records.
	 * @param namespace - Expected opaque DRP namespace.
	 * @param signal - Caller-owned cancellation signal.
	 * @param selection - Relay exclusion and preference controls.
	 * @returns Highest-sequence, conflict-free, fresh validated records.
	 */
	async discover(
		namespace: string,
		signal: AbortSignal,
		selection: RegistryBackendSelection = {}
	): Promise<readonly ValidatedDrpRecord[]> {
		signal.throwIfAborted();
		const relays = selectedRelays(this.#relays, selection);
		const results = await Promise.all(relays.map((relay) => this.#queryRelay(relay, namespace, signal, selection)));
		signal.throwIfAborted();

		const attempts: RegistryAttempt[] = [];
		const acceptedRecordSets: Array<readonly ValidatedDrpRecord[]> = [];
		let healthyRelayCount = 0;
		for (const result of results) {
			if (result.records === undefined) {
				attempts.push(result.attempt);
				continue;
			}
			try {
				reconcileValidatedRecords([...acceptedRecordSets, result.records], {
					maxRecords: this.#maxResponseRecords,
					now: this.#now(),
				});
			} catch (error) {
				if (!(error instanceof ReconciliationCapacityError)) throw error;
				attempts.push(rejectedAttempt(result.attempt.endpointId, "discover", "response-cap-exceeded"));
				continue;
			}
			acceptedRecordSets.push(result.records);
			healthyRelayCount += 1;
			attempts.push(result.attempt);
		}
		this.#lastAttempts = Object.freeze(attempts);
		if (healthyRelayCount === 0) throw new RegistryExhaustedError("discover", attempts);
		return reconcileValidatedRecords(acceptedRecordSets, {
			maxRecords: this.#maxResponseRecords,
			now: this.#now(),
		});
	}

	async #createEvent(record: SignedDrpRecordV1, signal: AbortSignal): Promise<NostrEvent> {
		const pubkey = await this.#nostrSigner.getPublicKey(signal);
		signal.throwIfAborted();
		if (!HEX_PUBLIC_KEY_PATTERN.test(pubkey)) throw new Error("Nostr public key must be 32-byte lowercase hex");
		const canonicalPayload = JSON.parse(decoder.decode(canonicalPayloadBytes(record))) as SignedDrpRecordPayloadV1;
		const content = JSON.stringify({ ...canonicalPayload, signature: record.signature });
		const d = replacementKey(record.namespace, record.peerId);
		const wallClockSeconds = Math.floor(this.#now() / 1_000);
		const createdAt = Math.max(wallClockSeconds, (this.#lastCreatedAtByReplacementKey.get(d) ?? -1) + 1);
		this.#lastCreatedAtByReplacementKey.set(d, createdAt);
		const unsigned = {
			pubkey,
			created_at: createdAt,
			kind: ADDRESSABLE_EVENT_KIND,
			tags: [
				["d", d],
				["n", record.namespace],
				["expiration", String(Math.floor(record.expiresAtMs / 1_000))],
			] as const,
			content,
		};
		const id = eventId(unsigned);
		const sig = await this.#nostrSigner.signEventId(id, signal);
		signal.throwIfAborted();
		if (!HEX_SIGNATURE_PATTERN.test(sig)) throw new Error("Nostr signature must be 64-byte lowercase hex");
		return Object.freeze({ ...unsigned, id, sig });
	}

	async #publishToRelay(
		relay: NostrRelayEndpoint,
		event: NostrEvent,
		parentSignal: AbortSignal
	): Promise<RegistryAttempt> {
		try {
			const result = await this.#withConnection(relay, parentSignal, (connection, signal) =>
				connection.publish(event, signal)
			);
			return result.accepted
				? { endpointId: relay.id, operation: "register", status: "accepted" }
				: rejectedAttempt(relay.id, "register", "endpoint-unavailable");
		} catch {
			parentSignal.throwIfAborted();
			return rejectedAttempt(relay.id, "register", "endpoint-unavailable");
		}
	}

	async #queryRelay(
		relay: NostrRelayEndpoint,
		namespace: string,
		parentSignal: AbortSignal,
		selection: RegistryBackendSelection
	): Promise<RelayDiscoveryResult> {
		try {
			const records = await this.#withConnection(relay, parentSignal, async (connection, signal) => {
				let receivedBytes = 0;
				const validator = this.#validatorFactory();
				const validated: ValidatedDrpRecord[] = [];
				const filter: NostrFilter =
					selection.targetPeerId === undefined
						? {
								"#n": [namespace],
								"kinds": [ADDRESSABLE_EVENT_KIND],
								"limit": this.#maxResponseRecords + 1,
							}
						: {
								"#d": [replacementKey(namespace, selection.targetPeerId)],
								"kinds": [ADDRESSABLE_EVENT_KIND],
								"limit": this.#maxResponseRecords + 1,
							};
				for await (const event of connection.query(filter, signal)) {
					signal.throwIfAborted();
					const eventBytes = serializedByteLength(event);
					if (eventBytes === undefined) continue;
					if (receivedBytes + eventBytes > this.#maxResponseBytes) break;
					receivedBytes += eventBytes;
					const embedded = parseEmbeddedRecord(event);
					if (embedded === undefined) continue;
					const checked = await validator.validate(embedded, {
						admission: { accepted: true, mode: "open" },
						expectedNamespace: namespace,
						signal,
					});
					if (!checked.accepted) continue;
					if (selection.targetPeerId !== undefined && checked.record.peerId !== selection.targetPeerId) {
						continue;
					}
					validated.push({
						admissionMode: "open",
						record: checked.record,
						sourceEndpointId: relay.id,
					});
					// Open admission cannot prevent an attacker from occupying every valid-record
					// slot or the byte budget on one relay; independent relays provide the fallback.
					if (validated.length >= this.#maxResponseRecords) break;
				}
				return validated;
			});
			return {
				attempt: {
					endpointId: relay.id,
					operation: "discover",
					status: records.length === 0 ? "empty" : "accepted",
				},
				records,
			};
		} catch {
			parentSignal.throwIfAborted();
			return { attempt: rejectedAttempt(relay.id, "discover", "endpoint-unavailable") };
		}
	}

	async #withConnection<Value>(
		relay: NostrRelayEndpoint,
		parentSignal: AbortSignal,
		operation: (connection: NostrRelayConnection, signal: AbortSignal) => Promise<Value>
	): Promise<Value> {
		let connection: NostrRelayConnection | undefined;
		let finished = false;
		try {
			return await withDeadline(parentSignal, this.#requestTimeoutMs, async (signal) => {
				const created = await this.#connectionFactory(relay, signal);
				if (finished) {
					await closeConnection(created, this.#requestTimeoutMs);
					signal.throwIfAborted();
					throw new Error("Nostr relay connection completed after its operation");
				}
				connection = created;
				return operation(created, signal);
			});
		} finally {
			finished = true;
			if (connection !== undefined) await closeConnection(connection, this.#requestTimeoutMs);
		}
	}
}

/**
 * Creates a validated Nostr relay directory.
 * @param options - Relay catalog and injected operation dependencies.
 * @returns A directory implementing the shared rendezvous contract.
 */
export function createNostrRelayDirectory(options: NostrRelayDirectoryOptions): NostrRelayDirectory {
	return new NostrRelayDirectory(options);
}

function parseEmbeddedRecord(event: NostrEvent): unknown | undefined {
	// The relay-controlled Nostr envelope is untrusted transport metadata. Only
	// the embedded DRP signature, namespace, identity, and expiry authorize it.
	try {
		const parsed = JSON.parse(event.content) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function eventId(event: Omit<NostrEvent, "id" | "sig"> | NostrEvent): string {
	const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
	return bytesToHex(sha256(encoder.encode(serialized)));
}

function replacementKey(namespace: string, peerId: string): string {
	return bytesToHex(sha256(encoder.encode(JSON.stringify(["ts-drp-rendezvous", namespace, peerId]))));
}

function serializedByteLength(value: unknown): number | undefined {
	try {
		return encoder.encode(JSON.stringify(value)).byteLength;
	} catch {
		return undefined;
	}
}

function selectedRelays(
	relays: readonly NostrRelayEndpoint[],
	selection: RegistryBackendSelection
): readonly NostrRelayEndpoint[] {
	const excluded = new Set(selection.excludeBackendIds ?? []);
	const preferredOrder = new Map((selection.preferredRegistryIds ?? []).map((id, index) => [id, index]));
	return relays
		.filter(({ id }) => !excluded.has(id))
		.sort((left, right) => {
			const leftOrder = preferredOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
			const rightOrder = preferredOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
			return leftOrder - rightOrder;
		});
}

function rejectedAttempt(
	endpointId: string,
	operation: "discover" | "register",
	code: "endpoint-unavailable" | "response-cap-exceeded"
): RegistryAttempt {
	return { code, endpointId, operation, status: "rejected" };
}

function validateEndpointId(value: string): string {
	if (!ENDPOINT_ID_PATTERN.test(value)) throw new Error("invalid Nostr relay ID");
	return value;
}

function validateRelayUrl(input: string, allowInsecureLoopback: boolean): URL {
	const url = new URL(input);
	if (url.username !== "" || url.password !== "") throw new Error("Nostr relay URL must not contain credentials");
	if (url.search !== "" || url.hash !== "") throw new Error("Nostr relay URL must not contain query or fragment");
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
	if (url.protocol !== "wss:" && !(allowInsecureLoopback && loopback && url.protocol === "ws:")) {
		throw new Error("Nostr relay URL must use WSS (plaintext WS is allowed only for an explicit loopback fixture)");
	}
	return url;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
	}
	return value;
}

async function closeConnection(connection: NostrRelayConnection, timeoutMs: number): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve(connection.close()),
			new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, Math.min(timeoutMs, 100));
			}),
		]);
	} catch {
		// Cleanup is best effort and must not replace the operation's typed terminal.
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

async function withDeadline<Value>(
	parent: AbortSignal,
	timeoutMs: number,
	operation: (signal: AbortSignal) => Promise<Value>
): Promise<Value> {
	parent.throwIfAborted();
	const controller = new AbortController();
	const abortFromParent = (): void => controller.abort(parent.reason);
	parent.addEventListener("abort", abortFromParent, { once: true });
	const timeout = setTimeout(
		() => controller.abort(new Error(`Nostr relay timed out after ${timeoutMs}ms`)),
		timeoutMs
	);
	const aborted = new Promise<never>((_resolve, reject) => {
		controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
	});
	try {
		return await Promise.race([operation(controller.signal), aborted]);
	} finally {
		clearTimeout(timeout);
		parent.removeEventListener("abort", abortFromParent);
	}
}
