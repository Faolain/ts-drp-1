import { publicKeyFromProtobuf, publicKeyToProtobuf } from "@libp2p/crypto/keys";
import type { PrivateKey, PublicKey } from "@libp2p/interface";
import { peerIdFromPublicKey, peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { base64url } from "multiformats/bases/base64";

import { AddressPolicy, type AddressPolicyOptions, type Resolver } from "../probe/address-policy.js";

const encoder = new TextEncoder();
const RECORD_KIND = "ts-drp-rendezvous-record";
const NAMESPACE_PATTERN = /^drp-rendezvous:v1:[A-Za-z0-9_-]{22,86}$/u;
const SUPPORTED_CAPABILITIES = ["drp-gossipsub", "webrtc", "circuit-relay"] as const;

export type DrpCapability = (typeof SUPPORTED_CAPABILITIES)[number];
export type AdmissionMode = "open" | "invite" | "allowlist" | "proof-of-work";

export interface SignedDrpRecordPayloadV1 {
	readonly kind: typeof RECORD_KIND;
	readonly version: 1;
	readonly namespace: string;
	readonly peerId: string;
	readonly publicKey: string;
	readonly addresses: readonly string[];
	readonly capabilities: readonly DrpCapability[];
	readonly sequence: number;
	readonly issuedAtMs: number;
	readonly expiresAtMs: number;
}

export interface SignedDrpRecordV1 extends SignedDrpRecordPayloadV1 {
	readonly signature: string;
}

export interface UnsignedDrpRecordV1 {
	readonly namespace: string;
	readonly addresses: readonly string[];
	readonly capabilities: readonly DrpCapability[];
	readonly sequence: number;
	readonly issuedAtMs: number;
	readonly expiresAtMs: number;
}

export interface AdmissionDecision {
	readonly accepted: boolean;
	readonly mode: AdmissionMode;
	readonly reason?: string;
}

export interface RecordValidationContext {
	readonly admission?: AdmissionDecision;
	readonly expectedNamespace: string;
	readonly signal: AbortSignal;
}

export type RecordRejectionCode =
	| "admission-rejected"
	| "admission-required"
	| "expired"
	| "invalid-address"
	| "invalid-namespace"
	| "invalid-peer-id"
	| "invalid-public-key"
	| "invalid-sequence"
	| "invalid-shape"
	| "invalid-signature"
	| "invalid-time"
	| "issued-in-future"
	| "namespace-mismatch"
	| "non-canonical"
	| "oversized"
	| "peer-id-mismatch"
	| "replay-capacity-exceeded"
	| "replayed-sequence"
	| "response-cap-exceeded"
	| "ttl-out-of-range"
	| "too-many-addresses"
	| "too-many-capabilities"
	| "unsafe-address"
	| "unsupported-capability"
	| "unsupported-version";

export interface AcceptedRecord {
	readonly accepted: true;
	readonly admissionMode: AdmissionMode;
	readonly canonicalBytes: number;
	readonly record: SignedDrpRecordV1;
}

export interface RejectedRecord {
	readonly accepted: false;
	readonly code: RecordRejectionCode;
	readonly detail?: string;
}

export type RecordValidationResult = AcceptedRecord | RejectedRecord;

export interface RecordLimits {
	readonly maxAddresses: number;
	readonly maxCapabilities: number;
	readonly maxClockSkewMs: number;
	readonly maxRecordBytes: number;
	readonly maxReplayEntries: number;
	readonly maxResponseRecords: number;
	readonly maxTtlMs: number;
	readonly minTtlMs: number;
}

export const DEFAULT_RECORD_LIMITS: Readonly<RecordLimits> = Object.freeze({
	maxAddresses: 8,
	maxCapabilities: 3,
	maxClockSkewMs: 30_000,
	maxRecordBytes: 8_192,
	maxReplayEntries: 4_096,
	maxResponseRecords: 64,
	maxTtlMs: 300_000,
	minTtlMs: 10_000,
});

export interface RecordValidatorOptions {
	/** Explicit deterministic-fixture overrides; omission retains public-safe defaults. */
	readonly addressPolicyOptions?: Pick<
		AddressPolicyOptions,
		"allowInsecureWebSocket" | "allowLoopback" | "allowPrivate"
	>;
	readonly limits?: Partial<RecordLimits>;
	now?(): number;
	readonly resolver: Resolver;
}

/**
 * Signs canonical short-TTL rendezvous records with a libp2p identity key.
 * Private key material never enters the returned record.
 */
export class RecordSigner {
	readonly #privateKey: PrivateKey;

	/**
	 * Creates a signer for one supported libp2p identity.
	 * @param privateKey - Ed25519 or secp256k1 identity key kept in memory.
	 */
	constructor(privateKey: PrivateKey) {
		if (privateKey.type !== "Ed25519" && privateKey.type !== "secp256k1") {
			throw new Error("rendezvous records support Ed25519 and secp256k1 identity keys");
		}
		this.#privateKey = privateKey;
	}

	/**
	 * Canonicalizes and signs an unsigned rendezvous claim.
	 * @param input - Bounded record fields that exclude identity material.
	 * @param signal - Optional caller-owned cancellation signal.
	 * @returns A canonical record containing only the public key and signature.
	 */
	async sign(input: UnsignedDrpRecordV1, signal?: AbortSignal): Promise<SignedDrpRecordV1> {
		signal?.throwIfAborted();
		const publicKey = this.#privateKey.publicKey;
		const payload = canonicalizePayload({
			...input,
			kind: RECORD_KIND,
			peerId: peerIdFromPublicKey(publicKey).toString(),
			publicKey: encodeBase64Url(publicKeyToProtobuf(publicKey)),
			version: 1,
		});
		const signature = await this.#privateKey.sign(canonicalPayloadBytes(payload), { signal });
		signal?.throwIfAborted();
		return Object.freeze({ ...payload, signature: encodeBase64Url(signature) });
	}
}

/**
 * Owns authenticity, freshness, replay, address, capability, and explicit
 * admission-decision validation for signed rendezvous records.
 */
export class RecordValidator {
	readonly #limits: Readonly<RecordLimits>;
	readonly #now: () => number;
	readonly #policyOptions: RecordValidatorOptions["addressPolicyOptions"];
	readonly #resolver: Resolver;
	readonly #sequences = new Map<string, { expiresAtMs: number; sequence: number }>();

	/**
	 * Creates an isolated validator with its own replay ledger.
	 * @param options - Bounds, clock, and DNS resolver dependencies.
	 */
	constructor(options: RecordValidatorOptions) {
		this.#limits = validateLimits({ ...DEFAULT_RECORD_LIMITS, ...options.limits });
		this.#now = options.now ?? Date.now;
		this.#policyOptions = options.addressPolicyOptions;
		this.#resolver = options.resolver;
	}

	/**
	 * Validates one untrusted record and records its accepted sequence.
	 * @param input - Untrusted candidate value.
	 * @param context - Expected namespace, admission decision, and abort signal.
	 * @returns A typed acceptance or stable rejection code.
	 */
	async validate(input: unknown, context: RecordValidationContext): Promise<RecordValidationResult> {
		context.signal.throwIfAborted();
		const parsed = parseRecord(input);
		if (!parsed.ok) return parsed.rejection;
		const record = parsed.record;
		const serializedBytes = byteLength(record);
		if (serializedBytes > this.#limits.maxRecordBytes) {
			return reject("oversized", `${serializedBytes}/${this.#limits.maxRecordBytes} bytes`);
		}
		if (record.kind !== RECORD_KIND || record.version !== 1) return reject("unsupported-version");
		if (!NAMESPACE_PATTERN.test(record.namespace)) return reject("invalid-namespace");
		if (record.namespace !== context.expectedNamespace) return reject("namespace-mismatch");
		if (record.addresses.length > this.#limits.maxAddresses) {
			return reject("too-many-addresses", `${record.addresses.length}/${this.#limits.maxAddresses}`);
		}
		if (record.capabilities.length > this.#limits.maxCapabilities) {
			return reject("too-many-capabilities", `${record.capabilities.length}/${this.#limits.maxCapabilities}`);
		}
		if (!record.capabilities.every(isSupportedCapability)) return reject("unsupported-capability");
		if (!record.capabilities.includes("drp-gossipsub")) {
			return reject("unsupported-capability", "drp-gossipsub capability is required");
		}
		if (!Number.isSafeInteger(record.sequence) || record.sequence < 0) return reject("invalid-sequence");
		if (
			!Number.isSafeInteger(record.issuedAtMs) ||
			!Number.isSafeInteger(record.expiresAtMs) ||
			record.expiresAtMs <= record.issuedAtMs
		) {
			return reject("invalid-time");
		}
		const ttlMs = record.expiresAtMs - record.issuedAtMs;
		if (ttlMs < this.#limits.minTtlMs || ttlMs > this.#limits.maxTtlMs) {
			return reject("ttl-out-of-range", `${ttlMs} ms`);
		}
		const now = this.#now();
		if (record.issuedAtMs > now + this.#limits.maxClockSkewMs) return reject("issued-in-future");
		if (record.expiresAtMs <= now) return reject("expired");

		let canonical: SignedDrpRecordPayloadV1;
		try {
			canonical = canonicalizePayload(record);
		} catch {
			return reject("invalid-address");
		}
		if (!isCanonical(record, canonical)) return reject("non-canonical");

		let publicKey: PublicKey;
		try {
			const decoded = decodeCanonicalBase64Url(record.publicKey);
			publicKey = publicKeyFromProtobuf(decoded);
		} catch {
			return reject("invalid-public-key");
		}
		if (publicKey.type !== "Ed25519" && publicKey.type !== "secp256k1") {
			return reject("invalid-public-key", "unsupported key type");
		}
		try {
			peerIdFromString(record.peerId);
		} catch {
			return reject("invalid-peer-id");
		}
		if (peerIdFromPublicKey(publicKey).toString() !== record.peerId) return reject("peer-id-mismatch");

		let signature: Uint8Array;
		try {
			signature = decodeCanonicalBase64Url(record.signature);
		} catch {
			return reject("invalid-signature");
		}
		try {
			const valid = await publicKey.verify(canonicalPayloadBytes(canonical), signature, {
				signal: context.signal,
			});
			if (!valid) return reject("invalid-signature");
		} catch (error) {
			context.signal.throwIfAborted();
			return reject("invalid-signature", error instanceof Error ? error.message : undefined);
		}

		const sequenceKey = `${record.namespace}\u0000${record.peerId}`;
		this.#sweepExpiredReplayState(now);
		const prior = this.#sequences.get(sequenceKey);
		if (prior !== undefined && record.sequence <= prior.sequence) {
			return reject("replayed-sequence", `${record.sequence} <= ${prior.sequence}`);
		}
		if (prior === undefined && this.#sequences.size >= this.#limits.maxReplayEntries) {
			return reject("replay-capacity-exceeded", `${this.#sequences.size}/${this.#limits.maxReplayEntries}`);
		}

		const addressResult = await this.#validateAddresses(record, context.signal);
		if (addressResult !== undefined) return addressResult;

		if (context.admission === undefined) return reject("admission-required");
		if (!isAdmissionMode(context.admission.mode) || !context.admission.accepted) {
			return reject("admission-rejected", context.admission.reason);
		}

		this.#sequences.set(sequenceKey, { expiresAtMs: record.expiresAtMs, sequence: record.sequence });
		return {
			accepted: true,
			admissionMode: context.admission.mode,
			canonicalBytes: serializedBytes,
			record,
		};
	}

	/**
	 * Re-resolves and reclassifies a validated record immediately before dial.
	 * @param record - Previously accepted signed record.
	 * @param signal - Caller-owned dial attempt signal.
	 * @returns A typed address acceptance or rejection.
	 */
	async recheckAddressesAtDial(
		record: SignedDrpRecordV1,
		signal: AbortSignal
	): Promise<{ readonly accepted: true } | RejectedRecord> {
		signal.throwIfAborted();
		if (record.expiresAtMs <= this.#now()) return reject("expired", "record expired before dial");
		const rejection = await this.#validateAddresses(record, signal);
		return rejection ?? { accepted: true };
	}

	/**
	 * Validates a response without exceeding its record-count cap.
	 * @param input - Untrusted response candidates.
	 * @param context - Shared namespace, admission, and abort context.
	 * @returns One result per candidate, or one response-cap rejection.
	 */
	async validateResponse(
		input: readonly unknown[],
		context: RecordValidationContext
	): Promise<readonly RecordValidationResult[]> {
		context.signal.throwIfAborted();
		if (input.length > this.#limits.maxResponseRecords) {
			return [reject("response-cap-exceeded", `${input.length}/${this.#limits.maxResponseRecords}`)];
		}
		const results: RecordValidationResult[] = [];
		for (const candidate of input) {
			context.signal.throwIfAborted();
			results.push(await this.validate(candidate, context));
		}
		return results;
	}

	async #validateAddresses(record: SignedDrpRecordV1, signal: AbortSignal): Promise<RejectedRecord | undefined> {
		if (record.addresses.length === 0) return reject("invalid-address", "at least one address is required");
		const browserPolicy = new AddressPolicy({ ...this.#policyOptions, target: "browser" });
		const nodePolicy = new AddressPolicy({ ...this.#policyOptions, target: "node" });
		for (const address of record.addresses) {
			let canonical: string;
			let components: ReturnType<ReturnType<typeof multiaddr>["getComponents"]>;
			try {
				const parsed = multiaddr(address);
				canonical = parsed.toString();
				components = parsed.getComponents();
			} catch {
				return reject("invalid-address");
			}
			if (canonical !== address) return reject("non-canonical", "non-canonical multiaddr");
			const peerComponents = components.filter((component) => component.name === "p2p");
			if (peerComponents.at(-1)?.value !== record.peerId) {
				return reject("invalid-address", "last p2p component must match record peer");
			}
			const [browser, node] = await Promise.all([
				browserPolicy.evaluate(address, this.#resolver, signal),
				nodePolicy.evaluate(address, this.#resolver, signal),
			]);
			if (!browser.dialable && !node.dialable) {
				const reasons = [...new Set([...browser.reasons, ...node.reasons])];
				const unsafe = reasons.some((reason) => reason.startsWith("scope-") || reason === "dns-rebinding-risk");
				return reject(unsafe ? "unsafe-address" : "invalid-address", reasons.join(","));
			}
		}
	}

	#sweepExpiredReplayState(now: number): void {
		for (const [key, state] of this.#sequences) {
			if (state.expiresAtMs <= now) this.#sequences.delete(key);
		}
	}
}

/**
 * Encodes opaque namespace entropy in the versioned rendezvous domain.
 * @param bytes - Between 16 and 64 bytes of opaque entropy.
 * @returns A versioned namespace string without human-readable room data.
 */
export function createOpaqueNamespaceV1(bytes: Uint8Array): string {
	if (bytes.byteLength < 16 || bytes.byteLength > 64) {
		throw new Error("opaque namespace entropy must be 16..64 bytes");
	}
	return `drp-rendezvous:v1:${base64url.baseEncode(bytes)}`;
}

/**
 * Serializes the exact fixed-order payload covered by the signature.
 * @param record - Record payload to canonicalize.
 * @returns Canonical UTF-8 JSON bytes.
 */
export function canonicalPayloadBytes(record: SignedDrpRecordPayloadV1): Uint8Array {
	return encoder.encode(JSON.stringify(canonicalizePayload(record)));
}

function canonicalizePayload(record: SignedDrpRecordPayloadV1): SignedDrpRecordPayloadV1 {
	return {
		kind: RECORD_KIND,
		version: 1,
		namespace: record.namespace,
		peerId: record.peerId,
		publicKey: record.publicKey,
		addresses: [...new Set(record.addresses.map((address) => multiaddr(address).toString()))].sort(),
		capabilities: [...new Set(record.capabilities)].sort(),
		sequence: record.sequence,
		issuedAtMs: record.issuedAtMs,
		expiresAtMs: record.expiresAtMs,
	};
}

function parseRecord(
	input: unknown
): { ok: true; record: SignedDrpRecordV1 } | { ok: false; rejection: RejectedRecord } {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, rejection: reject("invalid-shape") };
	}
	const object = input as Record<string, unknown>;
	const expectedKeys = [
		"addresses",
		"capabilities",
		"expiresAtMs",
		"issuedAtMs",
		"kind",
		"namespace",
		"peerId",
		"publicKey",
		"sequence",
		"signature",
		"version",
	];
	if (
		Object.keys(object).length !== expectedKeys.length ||
		!expectedKeys.every((key) => Object.hasOwn(object, key)) ||
		!Array.isArray(object.addresses) ||
		!object.addresses.every((value) => typeof value === "string") ||
		!Array.isArray(object.capabilities) ||
		!object.capabilities.every((value) => typeof value === "string") ||
		typeof object.kind !== "string" ||
		typeof object.namespace !== "string" ||
		typeof object.peerId !== "string" ||
		typeof object.publicKey !== "string" ||
		typeof object.sequence !== "number" ||
		typeof object.issuedAtMs !== "number" ||
		typeof object.expiresAtMs !== "number" ||
		typeof object.signature !== "string" ||
		typeof object.version !== "number"
	) {
		return { ok: false, rejection: reject("invalid-shape") };
	}
	return { ok: true, record: object as unknown as SignedDrpRecordV1 };
}

function isCanonical(record: SignedDrpRecordV1, canonical: SignedDrpRecordPayloadV1): boolean {
	return (
		JSON.stringify(record.addresses) === JSON.stringify(canonical.addresses) &&
		JSON.stringify(record.capabilities) === JSON.stringify(canonical.capabilities)
	);
}

function isSupportedCapability(value: string): value is DrpCapability {
	return (SUPPORTED_CAPABILITIES as readonly string[]).includes(value);
}

function isAdmissionMode(value: string): value is AdmissionMode {
	return value === "open" || value === "invite" || value === "allowlist" || value === "proof-of-work";
}

function encodeBase64Url(bytes: Uint8Array): string {
	return base64url.baseEncode(bytes);
}

function decodeCanonicalBase64Url(value: string): Uint8Array {
	const decoded = base64url.baseDecode(value);
	if (encodeBase64Url(decoded) !== value) throw new Error("non-canonical base64url");
	return decoded;
}

function byteLength(value: unknown): number {
	try {
		return encoder.encode(JSON.stringify(value)).byteLength;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function reject(code: RecordRejectionCode, detail?: string): RejectedRecord {
	return detail === undefined ? { accepted: false, code } : { accepted: false, code, detail };
}

function validateLimits(limits: RecordLimits): Readonly<RecordLimits> {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
	}
	if (limits.maxAddresses > 64) throw new Error("maxAddresses cannot exceed 64");
	if (limits.maxCapabilities > SUPPORTED_CAPABILITIES.length) {
		throw new Error(`maxCapabilities cannot exceed ${SUPPORTED_CAPABILITIES.length}`);
	}
	if (limits.maxClockSkewMs > 300_000) throw new Error("maxClockSkewMs cannot exceed 300000");
	if (limits.maxRecordBytes > 16_384) throw new Error("maxRecordBytes cannot exceed 16384");
	if (limits.maxReplayEntries > 65_536) throw new Error("maxReplayEntries cannot exceed 65536");
	if (limits.maxResponseRecords > 256) throw new Error("maxResponseRecords cannot exceed 256");
	if (limits.maxTtlMs > 900_000) throw new Error("maxTtlMs cannot exceed 900000");
	if (limits.minTtlMs > limits.maxTtlMs) throw new Error("minTtlMs cannot exceed maxTtlMs");
	return Object.freeze({ ...limits });
}
