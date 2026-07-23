import {
	AllowlistVerifier,
	constantTimeEqual,
	InviteVerifier,
	type InviteCredential as MembershipInviteCredential,
} from "@ts-drp/membership";
import { base64url } from "multiformats/bases/base64";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

import type { AddressDecision } from "./address-policy.js";
import { reconcileValidatedRecords, ReconciliationCapacityError } from "./reconciliation.js";
import { type AdmissionDecision, type AdmissionMode, type RecordValidator, type SignedDrpRecordV1 } from "./record.js";

const encoder = new TextEncoder();
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export type RegistryRejectionCode =
	| "admission-rejected"
	| "client-capacity-exceeded"
	| "endpoint-unavailable"
	| "invalid-client"
	| "namespace-capacity-exceeded"
	| "proof-challenge-capacity"
	| "proof-challenge-expired"
	| "proof-challenge-invalid"
	| "proof-challenge-replayed"
	| "quota-exceeded"
	| "rate-limited"
	| "record-rejected"
	| "response-cap-exceeded";

export interface RegistryLimits {
	readonly maxClients: number;
	readonly maxEndpoints: number;
	readonly maxNamespaces: number;
	readonly maxRecordsPerClient: number;
	readonly maxRecordsPerNamespace: number;
	readonly maxRequestsPerNamespaceWindow: number;
	readonly maxRequestsPerWindow: number;
	readonly maxResponseRecords: number;
	readonly requestWindowMs: number;
}

export const DEFAULT_REGISTRY_LIMITS: Readonly<RegistryLimits> = Object.freeze({
	maxClients: 256,
	maxEndpoints: 4,
	maxNamespaces: 64,
	maxRecordsPerClient: 8,
	maxRecordsPerNamespace: 64,
	maxRequestsPerNamespaceWindow: 15,
	maxRequestsPerWindow: 30,
	maxResponseRecords: 64,
	requestWindowMs: 60_000,
});

export type InviteCredential = MembershipInviteCredential;

export interface ProofOfWorkCredential {
	readonly challenge: ProofOfWorkChallengeV1;
	readonly counter: number;
	readonly kind: "proof-of-work";
}

export type AdmissionCredential = InviteCredential | ProofOfWorkCredential;

export interface AdmissionRequest {
	readonly clientId: string;
	readonly credential?: AdmissionCredential;
	readonly record: SignedDrpRecordV1;
	readonly signal: AbortSignal;
}

export interface ProofOfWorkChallengeV1 {
	readonly clientId: string;
	readonly difficultyBits: number;
	readonly expiresAtMs: number;
	readonly issuedAtMs: number;
	readonly kind: "ts-drp-registry-proof";
	readonly namespace: string;
	readonly nonce: string;
	readonly peerId: string;
	readonly tag: string;
	readonly version: 1;
}

export interface ProofOfWorkLimits {
	readonly challengeTtlMs: number;
	readonly maxDifficultyBits: number;
	readonly maxIterations: number;
	readonly maxOutstandingChallenges: number;
	readonly minDifficultyBits: number;
	readonly pressureStep: number;
}

export const DEFAULT_PROOF_OF_WORK_LIMITS: Readonly<ProofOfWorkLimits> = Object.freeze({
	challengeTtlMs: 30_000,
	maxDifficultyBits: 15,
	maxIterations: 262_144,
	maxOutstandingChallenges: 128,
	minDifficultyBits: 8,
	pressureStep: 16,
});

export type AdmissionPolicyOptions =
	| { readonly inviteToken: string; readonly mode?: "invite" }
	| { readonly allowUnsafeOpen: true; readonly mode: "open" }
	| { readonly allowedPeerIds: readonly string[]; readonly mode: "allowlist" }
	| {
			readonly limits?: Partial<ProofOfWorkLimits>;
			readonly mode: "proof-of-work";
			nonce?(): Uint8Array;
			readonly secret: Uint8Array;
	  };

interface StoredChallenge {
	readonly challenge: ProofOfWorkChallengeV1;
	used: boolean;
}

/**
 * Runtime-selectable registry admission owner. Invite is the safe PoC default;
 * open admission requires an explicit Sybil-unsafe acknowledgement.
 */
export class AdmissionPolicy {
	readonly mode: AdmissionMode;
	readonly #allowlistVerifier: AllowlistVerifier | undefined;
	readonly #inviteVerifier: InviteVerifier | undefined;
	readonly #now: () => number;
	readonly #nonce: () => Uint8Array;
	readonly #proofChallenges = new Map<string, StoredChallenge>();
	readonly #proofLimits: Readonly<ProofOfWorkLimits>;
	readonly #secret: Uint8Array | undefined;

	/**
	 * @param options - One explicit admission mode and its bounded dependencies.
	 * @param now - Injectable clock for deterministic expiry tests.
	 */
	constructor(options: AdmissionPolicyOptions, now: () => number = Date.now) {
		this.mode = options.mode ?? "invite";
		this.#now = now;
		this.#allowlistVerifier =
			options.mode === "allowlist" ? new AllowlistVerifier({ allowedPeerIds: options.allowedPeerIds }) : undefined;
		this.#inviteVerifier =
			options.mode === undefined || options.mode === "invite"
				? new InviteVerifier({ inviteToken: options.inviteToken })
				: undefined;
		this.#secret = options.mode === "proof-of-work" ? new Uint8Array(options.secret) : undefined;
		this.#nonce =
			options.mode === "proof-of-work" && options.nonce !== undefined
				? options.nonce
				: (): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(16));
		this.#proofLimits = validateProofLimits({
			...DEFAULT_PROOF_OF_WORK_LIMITS,
			...(options.mode === "proof-of-work" ? options.limits : undefined),
		});
		if (this.mode === "open" && (!("allowUnsafeOpen" in options) || options.allowUnsafeOpen !== true)) {
			throw new Error("open admission requires explicit opt-in");
		}
		if (this.mode === "proof-of-work" && this.#secret?.byteLength !== 32) {
			throw new Error("proof-of-work secret must be exactly 32 bytes");
		}
	}

	/**
	 * Issues one bounded, versioned proof-of-work challenge.
	 * @param namespace - Opaque rendezvous namespace bound into the proof.
	 * @param clientId - Bounded client identity bound into the proof.
	 * @param peerId - Publisher identity bound into the proof.
	 * @param signal - Caller-owned cancellation signal.
	 * @returns Challenge or a typed capacity rejection.
	 */
	async issueChallenge(
		namespace: string,
		clientId: string,
		peerId: string,
		signal: AbortSignal
	): Promise<ProofOfWorkChallengeV1 | RegistryRejection> {
		signal.throwIfAborted();
		if (!CLIENT_ID_PATTERN.test(clientId) || clientId !== peerId) {
			return rejection("proof-challenge-invalid", "invalid challenge binding");
		}
		if (this.mode !== "proof-of-work" || this.#secret === undefined) {
			return rejection("proof-challenge-invalid", "proof-of-work admission is disabled");
		}
		this.#sweepChallenges();
		for (const stored of this.#proofChallenges.values()) {
			if (
				!stored.used &&
				stored.challenge.clientId === clientId &&
				stored.challenge.peerId === peerId &&
				stored.challenge.namespace === namespace
			) {
				return stored.challenge;
			}
		}
		if (this.#proofChallenges.size >= this.#proofLimits.maxOutstandingChallenges) {
			return rejection("proof-challenge-capacity");
		}
		const issuedAtMs = this.#now();
		const nonce = base64url.baseEncode(this.#nonce());
		const difficultyBits = Math.min(
			this.#proofLimits.maxDifficultyBits,
			this.#proofLimits.minDifficultyBits + Math.floor(this.#proofChallenges.size / this.#proofLimits.pressureStep)
		);
		const unsigned = {
			clientId,
			difficultyBits,
			expiresAtMs: issuedAtMs + this.#proofLimits.challengeTtlMs,
			issuedAtMs,
			kind: "ts-drp-registry-proof" as const,
			namespace,
			nonce,
			peerId,
			version: 1 as const,
		};
		const tag = await hmacBase64Url(this.#secret, encoder.encode(JSON.stringify(unsigned)));
		const challenge = Object.freeze({ ...unsigned, tag });
		this.#proofChallenges.set(nonce, { challenge, used: false });
		return challenge;
	}

	/**
	 * Evaluates the selected policy without embedding credentials in the record.
	 * @param request - Registration identity, record, credential, and signal.
	 * @returns Explicit decision consumed by `RecordValidator`.
	 */
	async evaluate(request: AdmissionRequest): Promise<AdmissionDecision> {
		switch (this.mode) {
			case "open": {
				request.signal.throwIfAborted();
				return { accepted: true, mode: "open", reason: "explicit-sybil-unsafe-canary" };
			}
			case "allowlist": {
				if (this.#allowlistVerifier === undefined) throw new Error("allowlist verifier is not configured");
				return this.#allowlistVerifier.verify({ peerId: request.record.peerId, signal: request.signal });
			}
			case "invite": {
				if (this.#inviteVerifier === undefined) throw new Error("invite verifier is not configured");
				return this.#inviteVerifier.verify({
					credential: request.credential?.kind === "invite" ? request.credential : undefined,
					peerId: request.record.peerId,
					signal: request.signal,
				});
			}
			case "proof-of-work":
				request.signal.throwIfAborted();
				return this.#verifyProof(request);
		}
	}

	async #verifyProof(request: AdmissionRequest): Promise<AdmissionDecision> {
		if (this.#secret === undefined) {
			return { accepted: false, mode: "proof-of-work", reason: "proof-challenge-invalid" };
		}
		const credential = request.credential;
		if (credential?.kind !== "proof-of-work") {
			return { accepted: false, mode: "proof-of-work", reason: "proof-missing" };
		}
		const stored = this.#proofChallenges.get(credential.challenge.nonce);
		if (stored === undefined) {
			return { accepted: false, mode: "proof-of-work", reason: "proof-challenge-invalid" };
		}
		if (stored.used) return { accepted: false, mode: "proof-of-work", reason: "proof-challenge-replayed" };
		if (stored.challenge.expiresAtMs <= this.#now()) {
			this.#proofChallenges.delete(stored.challenge.nonce);
			return { accepted: false, mode: "proof-of-work", reason: "proof-challenge-expired" };
		}
		if (
			JSON.stringify(stored.challenge) !== JSON.stringify(credential.challenge) ||
			stored.challenge.namespace !== request.record.namespace ||
			stored.challenge.clientId !== request.clientId ||
			stored.challenge.peerId !== request.record.peerId ||
			!Number.isSafeInteger(credential.counter) ||
			credential.counter < 0 ||
			credential.counter >= this.#proofLimits.maxIterations
		) {
			return { accepted: false, mode: "proof-of-work", reason: "proof-challenge-invalid" };
		}
		const { tag: _tag, ...unsignedChallenge } = stored.challenge;
		const expectedTag = await hmacBase64Url(this.#secret, encoder.encode(JSON.stringify(unsignedChallenge)));
		if (!constantTimeEqual(stored.challenge.tag, expectedTag)) {
			return { accepted: false, mode: "proof-of-work", reason: "proof-challenge-invalid" };
		}
		const proofBytes = encoder.encode(`${JSON.stringify(stored.challenge)}:${credential.counter}`);
		const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", proofBytes));
		if (!hasLeadingZeroBits(digest, stored.challenge.difficultyBits)) {
			return { accepted: false, mode: "proof-of-work", reason: "proof-insufficient" };
		}
		stored.used = true;
		return { accepted: true, mode: "proof-of-work" };
	}

	#sweepChallenges(): void {
		const now = this.#now();
		for (const [nonce, stored] of this.#proofChallenges) {
			if (stored.challenge.expiresAtMs <= now) this.#proofChallenges.delete(nonce);
		}
	}
}

export interface ProofSolveResult {
	readonly counter: number;
	readonly durationMs: number;
	readonly iterations: number;
}

/**
 * Solves a bounded proof challenge for fixture/browser cost measurement.
 * @param challenge - Server-issued challenge.
 * @param maxIterations - Client-side hard CPU/work cap.
 * @param signal - Caller-owned cancellation signal.
 * @returns Counter and measured work, or an error when the cap is exhausted.
 */
export async function solveProofOfWork(
	challenge: ProofOfWorkChallengeV1,
	maxIterations: number,
	signal: AbortSignal
): Promise<ProofSolveResult> {
	if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 1_048_576) {
		throw new Error("maxIterations must be between 1 and 1048576");
	}
	const started = performance.now();
	for (let counter = 0; counter < maxIterations; counter += 1) {
		signal.throwIfAborted();
		const bytes = encoder.encode(`${JSON.stringify(challenge)}:${counter}`);
		const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
		if (hasLeadingZeroBits(digest, challenge.difficultyBits)) {
			return { counter, durationMs: performance.now() - started, iterations: counter + 1 };
		}
	}
	throw new Error(`proof-of-work exhausted ${maxIterations} iterations`);
}

export interface RegistryRegistrationRequest {
	/** Must equal the signed record Peer ID; it is not a caller-selected quota bucket. */
	readonly clientId: string;
	readonly credential?: AdmissionCredential;
	readonly record: SignedDrpRecordV1;
	readonly signal: AbortSignal;
}

export interface RegistryDiscoveryRequest {
	/**
	 * Endpoint/transport-derived rate key. Network adapters must not populate
	 * this from an untrusted request-body field.
	 */
	readonly clientId: string;
	readonly namespace: string;
	readonly signal: AbortSignal;
}

export interface RegistryRejection {
	readonly accepted: false;
	readonly code: RegistryRejectionCode;
	readonly detail?: string;
}

export interface RegistrationReceipt {
	readonly accepted: true;
	readonly admissionMode: AdmissionMode;
	readonly endpointId: string;
	readonly expiresAtMs: number;
	readonly refreshed: boolean;
	readonly sequence: number;
}

export interface RegistryRecordEnvelope {
	readonly admissionMode: AdmissionMode;
	readonly record: SignedDrpRecordV1;
}

export interface RegistryDiscoveryReceipt {
	readonly endpointId: string;
	readonly records: readonly RegistryRecordEnvelope[];
}

export interface RegistryEndpoint {
	readonly id: string;
	discover(request: RegistryDiscoveryRequest): Promise<RegistryDiscoveryReceipt | RegistryRejection>;
	register(request: RegistryRegistrationRequest): Promise<RegistrationReceipt | RegistryRejection>;
}

interface StoredRecord {
	readonly admissionMode: AdmissionMode;
	readonly clientId: string;
	record: SignedDrpRecordV1;
}

interface ClientWindow {
	count: number;
	readonly namespaceCounts: Map<string, number>;
	startedAtMs: number;
}

export interface RegistryServerOptions {
	readonly endpointId: string;
	readonly limits?: Partial<RegistryLimits>;
	now?(): number;
	readonly policy: AdmissionPolicy;
	readonly validator: RecordValidator;
}

/**
 * Bounded spike-local registry storage. The service validates every ingress,
 * retains no admission credential, and removes expired records before reads.
 */
export class RegistryServer implements RegistryEndpoint {
	readonly id: string;
	readonly #clientWindows = new Map<string, ClientWindow>();
	readonly #limits: Readonly<RegistryLimits>;
	readonly #now: () => number;
	readonly #policy: AdmissionPolicy;
	readonly #records = new Map<string, Map<string, StoredRecord>>();
	readonly #validator: RecordValidator;

	/**
	 * @param options - Endpoint identity, validator, admission policy, and caps.
	 */
	constructor(options: RegistryServerOptions) {
		this.id = validateEndpointId(options.endpointId);
		this.#limits = validateRegistryLimits({ ...DEFAULT_REGISTRY_LIMITS, ...options.limits });
		this.#now = options.now ?? Date.now;
		this.#policy = options.policy;
		this.#validator = options.validator;
	}

	/**
	 * Validates and stores or refreshes one record.
	 * @param request - Untrusted registration request.
	 * @returns Typed acceptance or stable rejection.
	 */
	async register(request: RegistryRegistrationRequest): Promise<RegistrationReceipt | RegistryRejection> {
		request.signal.throwIfAborted();
		if (request.clientId !== request.record.peerId) {
			return rejection("invalid-client", "registration rate key must equal the signed Peer ID");
		}
		const rateRejection = this.#consumeRequest(request.clientId, request.record.namespace);
		if (rateRejection !== undefined) return rateRejection;
		this.#sweepExpired();
		const namespaceRecords = this.#records.get(request.record.namespace);
		const existing = namespaceRecords?.get(request.record.peerId);
		if (existing !== undefined && request.record.sequence <= existing.record.sequence) {
			return rejection("record-rejected", "replayed-sequence");
		}
		if (existing === undefined) {
			if (namespaceRecords === undefined && this.#records.size >= this.#limits.maxNamespaces) {
				return rejection("namespace-capacity-exceeded");
			}
			if ((namespaceRecords?.size ?? 0) >= this.#limits.maxRecordsPerNamespace) {
				return rejection("quota-exceeded", "namespace record quota");
			}
			if (this.#countClientRecords(request.clientId) >= this.#limits.maxRecordsPerClient) {
				return rejection("quota-exceeded", "client record quota");
			}
		}
		const admission = await this.#policy.evaluate(request);
		const validation = await this.#validator.validate(request.record, {
			admission,
			expectedNamespace: request.record.namespace,
			signal: request.signal,
		});
		if (!validation.accepted) {
			return rejection(
				validation.code === "admission-rejected" ? "admission-rejected" : "record-rejected",
				validation.code
			);
		}
		const records = namespaceRecords ?? new Map<string, StoredRecord>();
		records.set(request.record.peerId, {
			admissionMode: validation.admissionMode,
			clientId: request.clientId,
			record: validation.record,
		});
		if (namespaceRecords === undefined) this.#records.set(request.record.namespace, records);
		return {
			accepted: true,
			admissionMode: validation.admissionMode,
			endpointId: this.id,
			expiresAtMs: request.record.expiresAtMs,
			refreshed: existing !== undefined,
			sequence: request.record.sequence,
		};
	}

	/**
	 * Returns a capped, freshness-filtered namespace snapshot.
	 * @param request - Namespace and bounded client identity.
	 * @returns Sanitized endpoint receipt or typed rejection.
	 */
	discover(request: RegistryDiscoveryRequest): Promise<RegistryDiscoveryReceipt | RegistryRejection> {
		request.signal.throwIfAborted();
		const rateRejection = this.#consumeRequest(request.clientId, request.namespace);
		if (rateRejection !== undefined) return Promise.resolve(rateRejection);
		this.#sweepExpired();
		const records = [...(this.#records.get(request.namespace)?.values() ?? [])];
		if (records.length > this.#limits.maxResponseRecords) {
			return Promise.resolve(rejection("response-cap-exceeded"));
		}
		return Promise.resolve({
			endpointId: this.id,
			records: records
				.sort((left, right) => left.record.peerId.localeCompare(right.record.peerId))
				.map(({ admissionMode, record }) => ({ admissionMode, record })),
		});
	}

	#consumeRequest(clientId: string, namespace: string): RegistryRejection | undefined {
		if (!CLIENT_ID_PATTERN.test(clientId)) return rejection("invalid-client");
		const now = this.#now();
		for (const [trackedClientId, window] of this.#clientWindows) {
			if (now - window.startedAtMs >= this.#limits.requestWindowMs) {
				this.#clientWindows.delete(trackedClientId);
			}
		}
		const existing = this.#clientWindows.get(clientId);
		if (existing === undefined) {
			if (this.#clientWindows.size >= this.#limits.maxClients) return rejection("client-capacity-exceeded");
			this.#clientWindows.set(clientId, {
				count: 1,
				namespaceCounts: new Map([[namespace, 1]]),
				startedAtMs: now,
			});
			return;
		}
		if (now - existing.startedAtMs >= this.#limits.requestWindowMs) {
			existing.count = 1;
			existing.namespaceCounts.clear();
			existing.namespaceCounts.set(namespace, 1);
			existing.startedAtMs = now;
			return;
		}
		existing.count += 1;
		const namespaceCount = (existing.namespaceCounts.get(namespace) ?? 0) + 1;
		existing.namespaceCounts.set(namespace, namespaceCount);
		if (
			existing.count > this.#limits.maxRequestsPerWindow ||
			namespaceCount > this.#limits.maxRequestsPerNamespaceWindow
		) {
			return rejection("rate-limited");
		}
	}

	#countClientRecords(clientId: string): number {
		let count = 0;
		for (const records of this.#records.values()) {
			for (const record of records.values()) if (record.clientId === clientId) count += 1;
		}
		return count;
	}

	#sweepExpired(): void {
		const now = this.#now();
		for (const [namespace, records] of this.#records) {
			for (const [peerId, stored] of records) {
				if (stored.record.expiresAtMs <= now) records.delete(peerId);
			}
			if (records.size === 0) this.#records.delete(namespace);
		}
	}
}

/** Independently stoppable in-memory endpoint used by deterministic fixtures. */
export class FixtureRegistryEndpoint implements RegistryEndpoint {
	readonly id: string;
	readonly #server: RegistryServer;
	#available = true;

	/**
	 * @param server - Independently configured in-memory endpoint.
	 */
	constructor(server: RegistryServer) {
		this.id = server.id;
		this.#server = server;
	}

	/**
	 * @param available - Whether the fixture endpoint accepts calls.
	 */
	setAvailable(available: boolean): void {
		this.#available = available;
	}

	/**
	 * @param request - Registration forwarded when the endpoint is available.
	 * @returns Server receipt or an endpoint-unavailable rejection.
	 */
	register(request: RegistryRegistrationRequest): Promise<RegistrationReceipt | RegistryRejection> {
		if (!this.#available) return Promise.resolve(rejection("endpoint-unavailable"));
		return this.#server.register(request);
	}

	/**
	 * @param request - Discovery forwarded when the endpoint is available.
	 * @returns Server snapshot or an endpoint-unavailable rejection.
	 */
	discover(request: RegistryDiscoveryRequest): Promise<RegistryDiscoveryReceipt | RegistryRejection> {
		if (!this.#available) return Promise.resolve(rejection("endpoint-unavailable"));
		return this.#server.discover(request);
	}
}

export interface RegistryAttempt {
	readonly endpointId: string;
	readonly operation: "discover" | "register";
	readonly status: "accepted" | "empty" | "rejected";
	readonly code?: RegistryRejectionCode;
}

export interface RegistryClientOptions {
	readonly backoffMs?: number;
	readonly clientId: string;
	readonly endpoints: readonly RegistryEndpoint[];
	readonly limits?: Partial<Pick<RegistryLimits, "maxEndpoints" | "maxResponseRecords">>;
	sleep?(durationMs: number, signal: AbortSignal): Promise<void>;
	readonly timeoutMs?: number;
	validatorFactory(): RecordValidator;
}

export interface ClientRegistrationReceipt {
	readonly acceptedEndpointIds: readonly string[];
	readonly attempts: readonly RegistryAttempt[];
	readonly sequence: number;
}

export interface ValidatedDrpRecord {
	readonly admissionMode: AdmissionMode;
	readonly record: SignedDrpRecordV1;
	readonly sourceEndpointId: string;
}

/** Minimal discovery seam shared by registry-backed rendezvous implementations. */
export interface RendezvousDirectory {
	discover(
		namespace: string,
		signal: AbortSignal,
		selection?: RegistryBackendSelection
	): Promise<readonly ValidatedDrpRecord[]>;
	register(
		record: SignedDrpRecordV1,
		signal: AbortSignal,
		credential?: AdmissionCredential
	): Promise<ClientRegistrationReceipt>;
}

export interface RegistryBackendSelection {
	readonly excludeBackendIds?: readonly string[];
	readonly preferredRegistryIds?: readonly string[];
	readonly targetPeerId?: string;
}

/**
 * Ordered multi-endpoint registry client. Registration replicates to every
 * endpoint; discovery reconciles every healthy endpoint so recovery cannot
 * roll a publisher back to a lower signed sequence.
 */
export class RegistryClient implements RendezvousDirectory {
	readonly #backoffMs: number;
	readonly #clientId: string;
	readonly #endpoints: readonly RegistryEndpoint[];
	readonly #maxResponseRecords: number;
	readonly #sleep: (durationMs: number, signal: AbortSignal) => Promise<void>;
	readonly #timeoutMs: number;
	readonly #validatorFactory: () => RecordValidator;
	#lastAttempts: readonly RegistryAttempt[] = [];

	/**
	 * @param options - Ordered endpoints, validation factory, and hard bounds.
	 */
	constructor(options: RegistryClientOptions) {
		if (!CLIENT_ID_PATTERN.test(options.clientId)) throw new Error("invalid registry client ID");
		const maxEndpoints = options.limits?.maxEndpoints ?? DEFAULT_REGISTRY_LIMITS.maxEndpoints;
		if (options.endpoints.length < 2 || options.endpoints.length > maxEndpoints) {
			throw new Error(`registry client requires 2..${maxEndpoints} endpoints`);
		}
		const ids = options.endpoints.map(({ id }) => validateEndpointId(id));
		if (new Set(ids).size !== ids.length) throw new Error("registry endpoint IDs must be unique");
		this.#clientId = options.clientId;
		this.#endpoints = [...options.endpoints];
		this.#maxResponseRecords = options.limits?.maxResponseRecords ?? DEFAULT_REGISTRY_LIMITS.maxResponseRecords;
		this.#timeoutMs = options.timeoutMs ?? 4_000;
		this.#backoffMs = options.backoffMs ?? 100;
		this.#sleep = options.sleep ?? defaultSleep;
		this.#validatorFactory = options.validatorFactory;
		if (
			!Number.isSafeInteger(this.#timeoutMs) ||
			this.#timeoutMs < 1 ||
			this.#timeoutMs > 30_000 ||
			!Number.isSafeInteger(this.#backoffMs) ||
			this.#backoffMs < 0 ||
			this.#backoffMs > 5_000
		) {
			throw new Error("invalid registry client timing bounds");
		}
	}

	/** @returns Last sanitized endpoint-attempt trace. */
	get lastAttempts(): readonly RegistryAttempt[] {
		return this.#lastAttempts;
	}

	/**
	 * Registers with every endpoint, succeeding when at least one accepts.
	 * @param record - Signed record.
	 * @param signal - Parent operation signal.
	 * @param credential - External admission credential, never retained.
	 * @returns Replication receipt and sanitized ordered attempts.
	 */
	async register(
		record: SignedDrpRecordV1,
		signal: AbortSignal,
		credential?: AdmissionCredential
	): Promise<ClientRegistrationReceipt> {
		const attempts: RegistryAttempt[] = [];
		const acceptedEndpointIds: string[] = [];
		for (const [index, endpoint] of this.#endpoints.entries()) {
			signal.throwIfAborted();
			if (index > 0 && this.#backoffMs > 0) await this.#sleep(this.#backoffMs, signal);
			let result: RegistrationReceipt | RegistryRejection;
			try {
				result = await withAttemptDeadline(signal, this.#timeoutMs, (attemptSignal) =>
					endpoint.register({
						clientId: record.peerId,
						credential,
						record,
						signal: attemptSignal,
					})
				);
			} catch {
				signal.throwIfAborted();
				result = rejection("endpoint-unavailable", "endpoint call failed or timed out");
			}
			if (result.accepted) {
				acceptedEndpointIds.push(endpoint.id);
				attempts.push({ endpointId: endpoint.id, operation: "register", status: "accepted" });
			} else {
				attempts.push({ code: result.code, endpointId: endpoint.id, operation: "register", status: "rejected" });
			}
		}
		this.#lastAttempts = Object.freeze(attempts);
		if (acceptedEndpointIds.length === 0) throw new RegistryExhaustedError("register", attempts);
		return { acceptedEndpointIds, attempts, sequence: record.sequence };
	}

	/**
	 * Discovers across healthy endpoints, validates every ingress, and keeps the
	 * highest signed sequence for each publisher.
	 * @param namespace - Expected opaque namespace.
	 * @param signal - Parent operation signal.
	 * @param selection
	 * @returns Fresh, signature-validated records.
	 */
	async discover(
		namespace: string,
		signal: AbortSignal,
		selection: RegistryBackendSelection = {}
	): Promise<readonly ValidatedDrpRecord[]> {
		const attempts: RegistryAttempt[] = [];
		const acceptedRecordSets: ValidatedDrpRecord[][] = [];
		let healthyDirectoryCount = 0;
		const endpoints = selectedRegistryEndpoints(this.#endpoints, selection);
		for (const [index, endpoint] of endpoints.entries()) {
			signal.throwIfAborted();
			if (index > 0 && this.#backoffMs > 0) await this.#sleep(this.#backoffMs, signal);
			let result: RegistryDiscoveryReceipt | RegistryRejection;
			try {
				result = await withAttemptDeadline(signal, this.#timeoutMs, (attemptSignal) =>
					endpoint.discover({
						clientId: this.#clientId,
						namespace,
						signal: attemptSignal,
					})
				);
			} catch {
				signal.throwIfAborted();
				result = rejection("endpoint-unavailable", "endpoint call failed or timed out");
			}
			if (!("records" in result)) {
				attempts.push({ code: result.code, endpointId: endpoint.id, operation: "discover", status: "rejected" });
				continue;
			}
			if (result.records.length > this.#maxResponseRecords) {
				attempts.push({
					code: "response-cap-exceeded",
					endpointId: endpoint.id,
					operation: "discover",
					status: "rejected",
				});
				continue;
			}
			const validator = this.#validatorFactory();
			const validated: ValidatedDrpRecord[] = [];
			let validationFailed = false;
			for (const envelope of result.records) {
				const checked = await validator.validate(envelope.record, {
					admission: { accepted: true, mode: envelope.admissionMode },
					expectedNamespace: namespace,
					signal,
				});
				if (checked.accepted) {
					validated.push({
						admissionMode: checked.admissionMode,
						record: checked.record,
						sourceEndpointId: endpoint.id,
					});
				} else {
					validationFailed = true;
				}
			}
			if (validationFailed) {
				attempts.push({
					code: "record-rejected",
					endpointId: endpoint.id,
					operation: "discover",
					status: "rejected",
				});
				continue;
			}
			try {
				reconcileValidatedRecords([...acceptedRecordSets, validated], {
					maxRecords: this.#maxResponseRecords,
					now: Number.NEGATIVE_INFINITY,
				});
			} catch (error) {
				if (!(error instanceof ReconciliationCapacityError)) throw error;
				attempts.push({
					code: "response-cap-exceeded",
					endpointId: endpoint.id,
					operation: "discover",
					status: "rejected",
				});
				continue;
			}
			acceptedRecordSets.push(validated);
			healthyDirectoryCount += 1;
			attempts.push({
				endpointId: endpoint.id,
				operation: "discover",
				status: validated.length === 0 ? "empty" : "accepted",
			});
		}
		this.#lastAttempts = Object.freeze(attempts);
		if (healthyDirectoryCount > 0) {
			const reconciled = reconcileValidatedRecords(acceptedRecordSets, {
				maxRecords: this.#maxResponseRecords,
				now: Number.NEGATIVE_INFINITY,
			});
			return selection.targetPeerId === undefined
				? reconciled
				: reconciled.filter(({ record }) => record.peerId === selection.targetPeerId);
		}
		throw new RegistryExhaustedError("discover", attempts);
	}
}

function selectedRegistryEndpoints(
	endpoints: readonly RegistryEndpoint[],
	selection: RegistryBackendSelection
): readonly RegistryEndpoint[] {
	const excluded = new Set(selection.excludeBackendIds ?? []);
	const available = endpoints.filter(({ id }) => !excluded.has(id));
	const preferredOrder = new Map((selection.preferredRegistryIds ?? []).map((id, index) => [id, index]));
	return available.sort((left, right) => {
		const leftOrder = preferredOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
		const rightOrder = preferredOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
		return leftOrder - rightOrder;
	});
}

/**
 *
 */
export class RegistryExhaustedError extends Error {
	readonly attempts: readonly RegistryAttempt[];
	readonly operation: "discover" | "register";

	/**
	 * @param operation - Failed operation.
	 * @param attempts - Complete sanitized endpoint trace.
	 */
	constructor(operation: "discover" | "register", attempts: readonly RegistryAttempt[]) {
		super(`all registry endpoints rejected ${operation}`);
		this.name = "RegistryExhaustedError";
		this.operation = operation;
		this.attempts = Object.freeze([...attempts]);
	}
}

export interface AnchorPublicationReceipt {
	readonly cid: string;
}

export interface NodeAnchorRouting {
	readonly peerId: string;
	cancelReprovide(cid: string, signal?: AbortSignal): Promise<void>;
	provide(cid: string, signal?: AbortSignal): Promise<AnchorPublicationReceipt>;
}

export interface AnchorProviderPeer {
	readonly acceptedAddresses: readonly string[];
	readonly addressDecisions: Array<{ address: string; decision: AddressDecision }>;
	readonly inputAddressCount: number;
	readonly peerId: string;
	readonly protocols: readonly string[];
	readonly rawAddresses: readonly string[];
	readonly truncatedAddressCount: number;
}

export interface BrowserProviderRouting {
	findProviders(cid: string, signal: AbortSignal): AsyncIterable<AnchorProviderPeer>;
}

export interface DhtAnchorPublication {
	readonly anchorPeerId: string;
	readonly cid: string;
	readonly receipt: AnchorPublicationReceipt;
}

/**
 *
 */
export class AnchorAdvertisementError extends Error {
	/** Creates the fixed anchor-only advertisement error. */
	constructor() {
		super("a DHT anchor may advertise only its own Node peer");
		this.name = "AnchorAdvertisementError";
	}
}

/**
 * Publishes the deterministic namespace CID from one Node anchor. The optional
 * advertised peer argument exists only to make browser-provider rejection
 * explicit and testable.
 */
export class DhtAnchorPublisher {
	readonly #anchor: NodeAnchorRouting;

	/**
	 * @param anchor - Node routing owner whose own Peer ID is published.
	 */
	constructor(anchor: NodeAnchorRouting) {
		this.#anchor = anchor;
	}

	/**
	 * @param namespace - Opaque namespace.
	 * @param signal - Parent operation signal.
	 * @param advertisedPeerId - Must equal the Node anchor.
	 * @returns Anchor-only publication receipt.
	 */
	async publish(
		namespace: string,
		signal: AbortSignal,
		advertisedPeerId: string = this.#anchor.peerId
	): Promise<DhtAnchorPublication> {
		if (advertisedPeerId !== this.#anchor.peerId) throw new AnchorAdvertisementError();
		const cid = await namespaceAnchorCid(namespace);
		const receipt = await this.#anchor.provide(cid, signal);
		return { anchorPeerId: this.#anchor.peerId, cid, receipt };
	}

	/**
	 * Cancels NodeRouting's owned reprovide lifecycle for the namespace CID.
	 * @param namespace - Opaque namespace whose anchor publication is stopping.
	 * @param signal - Parent operation signal.
	 */
	async stop(namespace: string, signal: AbortSignal): Promise<void> {
		await this.#anchor.cancelReprovide(await namespaceAnchorCid(namespace), signal);
	}
}

export interface DhtAnchorResolution {
	readonly cid: string;
	readonly providers: readonly AnchorProviderPeer[];
	readonly semantics: "configured-node-anchor-only";
}

/**
 * Resolves DHT providers only when they match the explicitly configured Node
 * anchor identities. Unrecognized providers never inherit anchor semantics.
 */
export class DhtAnchorResolver {
	readonly #allowedAnchorPeerIds: ReadonlySet<string>;
	readonly #routing: BrowserProviderRouting;

	/**
	 * @param routing - Browser delegated provider lookup owner.
	 * @param allowedAnchorPeerIds - Explicit Node anchor identities for the namespace.
	 */
	constructor(routing: BrowserProviderRouting, allowedAnchorPeerIds: readonly string[]) {
		if (allowedAnchorPeerIds.length < 1 || allowedAnchorPeerIds.length > 32) {
			throw new Error("DHT anchor resolver requires 1..32 configured Node anchors");
		}
		this.#routing = routing;
		this.#allowedAnchorPeerIds = new Set(allowedAnchorPeerIds);
	}

	/**
	 * @param namespace - Opaque namespace.
	 * @param signal - Parent operation signal.
	 * @param maxProviders - Hard result cap.
	 * @returns Node anchor candidates; never a browser-provider claim.
	 */
	async resolve(namespace: string, signal: AbortSignal, maxProviders = 8): Promise<DhtAnchorResolution> {
		if (!Number.isSafeInteger(maxProviders) || maxProviders < 1 || maxProviders > 32) {
			throw new Error("maxProviders must be between 1 and 32");
		}
		const cid = await namespaceAnchorCid(namespace);
		const providers: AnchorProviderPeer[] = [];
		for await (const provider of this.#routing.findProviders(cid, signal)) {
			if (!this.#allowedAnchorPeerIds.has(provider.peerId)) continue;
			providers.push(provider);
			if (providers.length >= maxProviders) break;
		}
		return { cid, providers, semantics: "configured-node-anchor-only" };
	}
}

/**
 * Derives the versioned raw CID used only to discover a Node anchor.
 * @param namespace - Opaque versioned namespace.
 * @returns Stable CID string.
 */
export async function namespaceAnchorCid(namespace: string): Promise<string> {
	const digest = await sha256.digest(encoder.encode(`ts-drp-anchor:v1:${namespace}`));
	return CID.createV1(raw.code, digest).toString();
}

function rejection(code: RegistryRejectionCode, detail?: string): RegistryRejection {
	return detail === undefined ? { accepted: false, code } : { accepted: false, code, detail };
}

function validateEndpointId(value: string): string {
	if (!/^[a-z0-9-]{1,32}$/u.test(value)) throw new Error("invalid registry endpoint ID");
	return value;
}

function validateRegistryLimits(limits: RegistryLimits): Readonly<RegistryLimits> {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
	}
	if (limits.maxClients > 4_096) throw new Error("maxClients cannot exceed 4096");
	if (limits.maxEndpoints > 8) throw new Error("maxEndpoints cannot exceed 8");
	if (limits.maxNamespaces > 1_024) throw new Error("maxNamespaces cannot exceed 1024");
	if (limits.maxRecordsPerClient > 64) throw new Error("maxRecordsPerClient cannot exceed 64");
	if (limits.maxRecordsPerNamespace > 256) throw new Error("maxRecordsPerNamespace cannot exceed 256");
	if (limits.maxRequestsPerNamespaceWindow > 1_000) {
		throw new Error("maxRequestsPerNamespaceWindow cannot exceed 1000");
	}
	if (limits.maxRequestsPerWindow > 1_000) throw new Error("maxRequestsPerWindow cannot exceed 1000");
	if (limits.maxResponseRecords > 256) throw new Error("maxResponseRecords cannot exceed 256");
	if (limits.requestWindowMs > 3_600_000) throw new Error("requestWindowMs cannot exceed 3600000");
	return Object.freeze({ ...limits });
}

function validateProofLimits(limits: ProofOfWorkLimits): Readonly<ProofOfWorkLimits> {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
	}
	if (limits.minDifficultyBits > limits.maxDifficultyBits || limits.maxDifficultyBits > 17) {
		throw new Error("proof difficulty must be ordered and at most 17 bits");
	}
	if (limits.challengeTtlMs > 300_000) throw new Error("challengeTtlMs cannot exceed 300000");
	if (limits.maxIterations > 1_048_576) throw new Error("maxIterations cannot exceed 1048576");
	if (limits.maxIterations < 8 * 2 ** limits.maxDifficultyBits) {
		throw new Error("maxIterations must cover at least eight difficulty search spaces");
	}
	if (limits.maxOutstandingChallenges > 1_024) throw new Error("maxOutstandingChallenges cannot exceed 1024");
	if (limits.pressureStep > limits.maxOutstandingChallenges) {
		throw new Error("pressureStep cannot exceed maxOutstandingChallenges");
	}
	return Object.freeze({ ...limits });
}

async function hmacBase64Url(secret: Uint8Array, value: Uint8Array): Promise<string> {
	const key = await globalThis.crypto.subtle.importKey("raw", secret, { hash: "SHA-256", name: "HMAC" }, false, [
		"sign",
	]);
	return base64url.baseEncode(new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, value)));
}

function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
	let remaining = bits;
	for (const byte of bytes) {
		if (remaining <= 0) return true;
		const inspected = Math.min(8, remaining);
		if (byte >> (8 - inspected) !== 0) return false;
		remaining -= inspected;
	}
	return remaining <= 0;
}

async function withAttemptDeadline<Value>(
	parent: AbortSignal,
	timeoutMs: number,
	operation: (signal: AbortSignal) => Promise<Value>
): Promise<Value> {
	parent.throwIfAborted();
	const controller = new AbortController();
	const abortFromParent = (): void => controller.abort(parent.reason);
	parent.addEventListener("abort", abortFromParent, { once: true });
	const timeout = setTimeout(
		() => controller.abort(new Error(`registry endpoint timed out after ${timeoutMs}ms`)),
		timeoutMs
	);
	const aborted = new Promise<never>((_resolve, rejectPromise) => {
		controller.signal.addEventListener("abort", () => rejectPromise(controller.signal.reason), { once: true });
	});
	try {
		return await Promise.race([operation(controller.signal), aborted]);
	} finally {
		clearTimeout(timeout);
		parent.removeEventListener("abort", abortFromParent);
	}
}

function defaultSleep(durationMs: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, rejectPromise) => {
		const timeout = setTimeout(resolve, durationMs);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				rejectPromise(signal.reason);
			},
			{ once: true }
		);
	});
}
