import { multiaddr } from "@multiformats/multiaddr";

import { CIRCUIT_RELAY_V2_HOP_PROTOCOL, RELAY_RESERVATION_STATUS } from "./protocol.js";
import type {
	RelayCandidate,
	RelayInspection,
	RelayInspector,
	RelayReservationClient,
	RelayReservationFailure,
	RelayReservationWireResponse,
} from "./types.js";

export { decodeHopReservationResponse, Libp2pRelayClient, type Libp2pRelayClientOptions } from "./libp2p-client.js";
export { CIRCUIT_RELAY_V2_HOP_PROTOCOL, RELAY_RESERVATION_STATUS } from "./protocol.js";
export type {
	RelayCandidate,
	RelayCandidateOrigin,
	RelayInspection,
	RelayInspector,
	RelayReservationClient,
	RelayReservationFailure,
	RelayReservationWireResponse,
} from "./types.js";

export type RelayTransport = "wss" | "webtransport" | "webrtc-direct";

export interface RelayCandidateSource {
	getCandidates(queryKey: Uint8Array, signal: AbortSignal): AsyncIterable<RelayCandidate>;
}

export interface NodeRoutingPeerCandidate {
	readonly addresses: readonly string[];
	readonly peerId: string;
}

export interface BrowserRoutingPeerCandidate {
	readonly acceptedAddresses: readonly string[];
	readonly peerId: string;
	readonly protocols: readonly string[];
}

export interface NodeClosestPeerRouting {
	getClosestPeers(queryKey: Uint8Array, signal?: AbortSignal): AsyncIterable<NodeRoutingPeerCandidate>;
}

export interface BrowserClosestPeerRouting {
	getClosestPeers(queryKey: Uint8Array, signal: AbortSignal): AsyncIterable<BrowserRoutingPeerCandidate>;
}

export interface DnsaddrFallbackResult {
	readonly address?: string;
	readonly expiresAtMs?: number;
	readonly status: "aborted" | "accepted" | "empty" | "stale" | "timeout";
}

export interface DnsaddrFallback {
	acquire(signal: AbortSignal): Promise<DnsaddrFallbackResult>;
}

export interface RelayTransportProfile {
	readonly allowed: readonly RelayTransport[];
	readonly name: "broad-browser" | "wss-only";
}

export const RELAY_TRANSPORT_PROFILES = {
	broadBrowser: {
		allowed: ["wss", "webtransport", "webrtc-direct"],
		name: "broad-browser",
	},
	wssOnly: {
		allowed: ["wss"],
		name: "wss-only",
	},
} as const satisfies Record<string, RelayTransportProfile>;

export interface RelayPolicyLimits {
	readonly maxCandidates: number;
	readonly maxConcurrentReservations: number;
	readonly maxPerOperatorGroup: number;
	readonly maxQueuedCandidates: number;
	readonly ownedFallbackDeadlineMs: number;
	readonly perCandidateDeadlineMs: number;
	readonly refreshBeforeExpiryMs: number;
	readonly requiredOperatorGroups: number;
	readonly requiredReservations: number;
	readonly totalDeadlineMs: number;
}

export interface RelayAttempt {
	readonly address?: string;
	readonly candidate: RelayCandidate;
	readonly connectionId?: string;
	readonly finishedAtMs: number;
	readonly hopAdvertised: boolean;
	readonly identifyProtocols: readonly string[];
	readonly inspectionLatencyMs: number;
	readonly reservationLatencyMs: number;
	readonly reservationStatus?: number;
	readonly retryAfterMs?: number;
	readonly startedAtMs: number;
	readonly status:
		| "aborted"
		| "dial-refused"
		| "dial-timeout"
		| "duplicate"
		| "invalid-candidate"
		| "no-compatible-address"
		| "no-hop"
		| "operator-limit"
		| "release-failed"
		| "reserved"
		| "source-failed"
		| "source-timeout"
		| "transport-rate-limited"
		| RelayReservationFailure;
}

export interface ActiveRelayReservation {
	readonly candidate: RelayCandidate;
	readonly expiresAtMs: number;
	readonly limit: {
		readonly dataBytes?: number;
		readonly durationSeconds?: number;
	};
	readonly reservedAtMs: number;
}

export interface RelayPolicyResult {
	readonly attempts: readonly RelayAttempt[];
	readonly candidatesObserved: number;
	readonly durationMs: number;
	readonly fallback?: DnsaddrFallbackResult;
	readonly operatorGroups: readonly string[];
	readonly reservations: readonly ActiveRelayReservation[];
	readonly terminal: "aborted" | "exhausted" | "owned-fallback" | "reserved";
}

export interface RelayReplacementResult extends RelayPolicyResult {
	readonly reason: "control-disconnected" | "expired" | "refresh-refused" | "relay-disconnected";
	readonly replacedPeerId: string;
}

export interface RelayPolicyOptions {
	/**
	 * Deterministic localhost fixture only. It classifies `/ws` as the `wss`
	 * profile so the same bounded policy can exercise a non-TLS local relay.
	 */
	readonly allowInsecureWebSocketFixture?: boolean;
	readonly fallback?: DnsaddrFallback;
	readonly inspector: RelayInspector;
	readonly limits?: Partial<RelayPolicyLimits>;
	now?(): number;
	readonly reservationClient: RelayReservationClient;
	readonly source: RelayCandidateSource;
	readonly transportProfile?: RelayTransportProfile;
}

export const DEFAULT_RELAY_POLICY_LIMITS: Readonly<RelayPolicyLimits> = Object.freeze({
	maxCandidates: 32,
	maxConcurrentReservations: 2,
	maxPerOperatorGroup: 1,
	maxQueuedCandidates: 32,
	ownedFallbackDeadlineMs: 1_000,
	perCandidateDeadlineMs: 1_000,
	refreshBeforeExpiryMs: 30_000,
	requiredOperatorGroups: 2,
	requiredReservations: 2,
	totalDeadlineMs: 5_000,
});

const MAX_QUEUED_OPERATIONS = 32;

/**
 * Adapts the Phase 02 closest-peer seam without inventing a second source of
 * relay candidates.
 */
export class NodeRoutingClosestPeersSource implements RelayCandidateSource {
	readonly #operatorGroup: (peer: NodeRoutingPeerCandidate) => string;
	readonly #routing: NodeClosestPeerRouting;

	/**
	 * @param routing - Phase 02 Node closest-peer seam.
	 * @param operatorGroup - Campaign-owned coarse operator classifier.
	 */
	constructor(
		routing: NodeClosestPeerRouting,
		operatorGroup: (peer: NodeRoutingPeerCandidate) => string = () => "unknown"
	) {
		this.#routing = routing;
		this.#operatorGroup = operatorGroup;
	}

	/**
	 * @param queryKey - Opaque routing query key.
	 * @param signal - Caller-owned cancellation signal.
	 * @yields Bounded Node candidates with query/result provenance.
	 */
	async *getCandidates(queryKey: Uint8Array, signal: AbortSignal): AsyncIterable<RelayCandidate> {
		const queryDigest = digestQueryKey(queryKey);
		let resultIndex = 0;
		for await (const peer of this.#routing.getClosestPeers(queryKey, signal)) {
			yield {
				addresses: [...peer.addresses],
				operatorGroup: safeOperatorGroup(() => this.#operatorGroup(peer)),
				peerId: peer.peerId,
				protocols: [],
				provenance: {
					origin: "node-closest-peers",
					queryDigest,
					resultIndex: resultIndex++,
					routingSource: "public-dht",
				},
			};
		}
	}
}

/**
 * Adapts the Phase 03 delegated closest-peer seam while retaining the exact
 * query and result provenance consumed by the relay policy.
 */
export class BrowserRoutingClosestPeersSource implements RelayCandidateSource {
	readonly #operatorGroup: (peer: BrowserRoutingPeerCandidate) => string;
	readonly #routing: BrowserClosestPeerRouting;

	/**
	 * @param routing - Phase 03 browser closest-peer seam.
	 * @param operatorGroup - Campaign-owned coarse operator classifier.
	 */
	constructor(
		routing: BrowserClosestPeerRouting,
		operatorGroup: (peer: BrowserRoutingPeerCandidate) => string = () => "unknown"
	) {
		this.#routing = routing;
		this.#operatorGroup = operatorGroup;
	}

	/**
	 * @param queryKey - Opaque routing query key.
	 * @param signal - Caller-owned cancellation signal.
	 * @yields Bounded browser candidates with query/result provenance.
	 */
	async *getCandidates(queryKey: Uint8Array, signal: AbortSignal): AsyncIterable<RelayCandidate> {
		const queryDigest = digestQueryKey(queryKey);
		let resultIndex = 0;
		for await (const peer of this.#routing.getClosestPeers(queryKey, signal)) {
			yield {
				addresses: [...peer.acceptedAddresses],
				operatorGroup: safeOperatorGroup(() => this.#operatorGroup(peer)),
				peerId: peer.peerId,
				protocols: [...peer.protocols],
				provenance: {
					origin: "browser-closest-peers",
					queryDigest,
					resultIndex: resultIndex++,
					routingSource: "delegated-routing",
				},
			};
		}
	}
}

/**
 * Decodes the actual Circuit Relay v2 reservation status. HOP advertisement is
 * deliberately absent from this function: protocol support is not acceptance.
 * @param response - Decoded Circuit Relay v2 wire response.
 * @param nowMs - Current policy time used to reject expired reservations.
 * @returns Typed acceptance with live expiry, or the exact refusal class.
 */
export function decodeRelayReservationResponse(
	response: RelayReservationWireResponse,
	nowMs: number
):
	| { readonly accepted: true; readonly expiresAtMs: number; readonly limit: ActiveRelayReservation["limit"] }
	| { readonly accepted: false; readonly failure: RelayReservationFailure } {
	if (response.status !== RELAY_RESERVATION_STATUS.OK) {
		return { accepted: false, failure: statusFailure(response.status) };
	}
	const expiration = response.reservation?.expire ?? response.expire;
	if (expiration === undefined) return { accepted: false, failure: "malformed-response" };
	const expiresAtMs = safeNumber(expiration) * 1_000;
	if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) {
		return { accepted: false, failure: "no-reservation" };
	}
	const dataBytes = response.limit?.data === undefined ? undefined : safeNumber(response.limit.data);
	const durationSeconds = response.limit?.duration === undefined ? undefined : safeNumber(response.limit.duration);
	if (
		(dataBytes !== undefined && !Number.isSafeInteger(dataBytes)) ||
		(durationSeconds !== undefined && !Number.isSafeInteger(durationSeconds))
	) {
		return { accepted: false, failure: "malformed-response" };
	}
	return {
		accepted: true,
		expiresAtMs,
		limit: {
			...(dataBytes === undefined ? {} : { dataBytes }),
			...(durationSeconds === undefined ? {} : { durationSeconds }),
		},
	};
}

/**
 * Single owner for acquisition, refresh, replacement, diversity, fallback, and
 * terminal cleanup. Public relays are tried only before the owned fallback.
 */
export class RelayPolicy {
	readonly #allowInsecureWebSocketFixture: boolean;
	readonly #fallback?: DnsaddrFallback;
	readonly #inspector: RelayInspector;
	readonly #limits: Readonly<RelayPolicyLimits>;
	readonly #now: () => number;
	readonly #reservationClient: RelayReservationClient;
	readonly #source: RelayCandidateSource;
	readonly #transportProfile: RelayTransportProfile;
	#active = new Map<string, ActiveRelayReservation>();
	#attemptedPeerIds = new Set<string>();
	#candidatePool: RelayCandidate[] = [];
	#pendingReleases = new Map<string, RelayCandidate>();
	#queuedOperations = 0;
	#stopped = false;
	#tail: Promise<void> = Promise.resolve();

	/**
	 * @param options - Routing, inspection, reservation, fallback, and bound dependencies.
	 */
	constructor(options: RelayPolicyOptions) {
		this.#allowInsecureWebSocketFixture = options.allowInsecureWebSocketFixture === true;
		this.#source = options.source;
		this.#inspector = options.inspector;
		this.#reservationClient = options.reservationClient;
		this.#fallback = options.fallback;
		this.#limits = Object.freeze(parseLimits(options.limits));
		this.#transportProfile = parseTransportProfile(options.transportProfile ?? RELAY_TRANSPORT_PROFILES.broadBrowser);
		this.#now = options.now ?? Date.now;
	}

	/**
	 * @returns Defensive snapshots of live public relay reservations.
	 */
	get activeReservations(): readonly ActiveRelayReservation[] {
		return [...this.#active.values()].map(cloneReservation);
	}

	/** @returns Whether this policy owns a configured DNSADDR fallback. */
	get hasOwnedFallback(): boolean {
		return this.#fallback !== undefined;
	}

	/**
	 * @param queryKey - Opaque closest-peer routing key.
	 * @param signal - Caller-owned cancellation signal.
	 * @returns Typed reserved, fallback, exhausted, or aborted outcome.
	 */
	acquire(queryKey: Uint8Array, signal: AbortSignal): Promise<RelayPolicyResult> {
		return this.#enqueue(async () => {
			this.#assertRunning();
			const startedAtMs = this.#now();
			const startedAtMonotonicMs = monotonicNow();
			this.#attemptedPeerIds.clear();
			const attempts: RelayAttempt[] = [];
			const fallbackBudgetMs = this.#fallback === undefined ? 0 : this.#limits.ownedFallbackDeadlineMs;
			const publicCollectionBudgetMs = Math.max(1, this.#limits.totalDeadlineMs - fallbackBudgetMs);
			try {
				const collected = await withDeadline(
					(collectionSignal) => collectCandidates(this.#source, queryKey, collectionSignal, this.#limits, this.#now),
					signal,
					publicCollectionBudgetMs
				);
				this.#candidatePool = collected.candidates;
				attempts.push(...collected.attempts);
			} catch (error) {
				this.#candidatePool = [];
				if (signal.aborted) return this.#result("aborted", attempts, startedAtMs);
				attempts.push(
					baseAttempt(
						syntheticCandidate(queryKey),
						startedAtMs,
						this.#now(),
						error instanceof RelayDeadlineError ? "source-timeout" : "source-failed"
					)
				);
			}
			return this.#acquireFromPool(signal, attempts, startedAtMs, startedAtMonotonicMs);
		});
	}

	/**
	 * @param signal - Caller-owned cancellation signal.
	 * @returns Refreshed state after rotating refused or expired reservations.
	 */
	refresh(signal: AbortSignal): Promise<RelayPolicyResult> {
		return this.#enqueue(async () => {
			this.#assertRunning();
			const startedAtMs = this.#now();
			const startedAtMonotonicMs = monotonicNow();
			const attempts: RelayAttempt[] = [];
			const failures: Array<{ peerId: string; reason: RelayReplacementResult["reason"] }> = [];
			for (const reservation of this.#active.values()) {
				if (reservation.expiresAtMs - this.#now() > this.#limits.refreshBeforeExpiryMs) continue;
				const attemptStartedAtMs = this.#now();
				try {
					const response = await withDeadline(
						(signalForAttempt) => this.#reservationClient.refresh(reservation.candidate, signalForAttempt),
						signal,
						this.#limits.perCandidateDeadlineMs
					);
					const decoded = decodeRelayReservationResponse(response, this.#now());
					if (!decoded.accepted) {
						attempts.push(
							reservationAttempt(
								reservation.candidate,
								attemptStartedAtMs,
								this.#now(),
								decoded.failure,
								response.status
							)
						);
						failures.push({ peerId: reservation.candidate.peerId, reason: "refresh-refused" });
						continue;
					}
					this.#active.set(reservation.candidate.peerId, {
						candidate: reservation.candidate,
						expiresAtMs: decoded.expiresAtMs,
						limit: decoded.limit,
						reservedAtMs: this.#now(),
					});
					attempts.push(
						reservationAttempt(reservation.candidate, attemptStartedAtMs, this.#now(), "reserved", response.status)
					);
				} catch (error) {
					const status =
						error instanceof RelayTransportRateLimitError ? "transport-rate-limited" : deadlineFailure(error, signal);
					attempts.push(reservationAttempt(reservation.candidate, attemptStartedAtMs, this.#now(), status));
					if (status === "aborted") return this.#result("aborted", attempts, startedAtMs);
					failures.push({ peerId: reservation.candidate.peerId, reason: "refresh-refused" });
				}
			}
			for (const failure of failures) await this.#drop(failure.peerId);
			if (failures.length > 0) {
				const replacement = await this.#acquireFromPool(signal, attempts, startedAtMs, startedAtMonotonicMs);
				return replacement;
			}
			return this.#result("reserved", attempts, startedAtMs);
		});
	}

	/**
	 * @param peerId - Lost or expired reserved relay.
	 * @param reason - Lifecycle signal that caused replacement.
	 * @param signal - Caller-owned cancellation signal.
	 * @returns Replacement outcome with the triggering reason.
	 */
	replace(
		peerId: string,
		reason: RelayReplacementResult["reason"],
		signal: AbortSignal
	): Promise<RelayReplacementResult> {
		return this.#enqueue(async () => {
			this.#assertRunning();
			const startedAtMs = this.#now();
			const startedAtMonotonicMs = monotonicNow();
			await this.#drop(peerId);
			const result = await this.#acquireFromPool(signal, [], startedAtMs, startedAtMonotonicMs);
			return { ...result, reason, replacedPeerId: peerId };
		});
	}

	/**
	 *
	 */
	async stop(): Promise<void> {
		this.#stopped = true;
		await this.#tail;
		const reservations = [
			...this.#active.values(),
			...[...this.#pendingReleases.values()].map((candidate) => ({
				candidate,
				expiresAtMs: 0,
				limit: {},
				reservedAtMs: 0,
			})),
		];
		this.#active.clear();
		this.#pendingReleases.clear();
		await Promise.allSettled(reservations.map(({ candidate }) => this.#reservationClient.release(candidate)));
		this.#candidatePool = [];
		this.#attemptedPeerIds.clear();
	}

	async #acquireFromPool(
		signal: AbortSignal,
		initialAttempts: RelayAttempt[] = [],
		startedAtMs = this.#now(),
		startedAtMonotonicMs = monotonicNow()
	): Promise<RelayPolicyResult> {
		const attempts = initialAttempts;
		const totalController = new AbortController();
		const elapsedMs = Math.max(0, monotonicNow() - startedAtMonotonicMs);
		const fallbackBudgetMs = this.#fallback === undefined ? 0 : this.#limits.ownedFallbackDeadlineMs;
		const remainingPublicMs = Math.max(1, this.#limits.totalDeadlineMs - elapsedMs - fallbackBudgetMs);
		const totalTimer = setTimeout(
			() => totalController.abort(new RelayDeadlineError("total relay deadline exceeded")),
			remainingPublicMs
		);
		const boundedSignal = AbortSignal.any([signal, totalController.signal]);
		try {
			const pending = this.#candidatePool.filter(
				({ peerId }) => !this.#active.has(peerId) && !this.#attemptedPeerIds.has(peerId)
			);
			let cursor = 0;
			const workerCount = Math.min(this.#limits.maxConcurrentReservations, pending.length);
			const workers = Array.from({ length: workerCount }, async () => {
				while (!boundedSignal.aborted && cursor < pending.length && !this.#requirementsMet()) {
					const candidate = pending[cursor++];
					if (candidate === undefined) return;
					const attempt = await this.#attemptCandidate(candidate, boundedSignal, signal);
					attempts.push(attempt);
				}
			});
			await Promise.all(workers);
			if (this.#requirementsMet()) return this.#result("reserved", attempts, startedAtMs);
			if (signal.aborted) return this.#result("aborted", attempts, startedAtMs);
			if (this.#fallback === undefined) return this.#result("exhausted", attempts, startedAtMs);
			const remainingTotalMs = Math.max(0, this.#limits.totalDeadlineMs - (monotonicNow() - startedAtMonotonicMs));
			const fallback = await this.#tryFallback(signal, remainingTotalMs);
			if (fallback.status === "aborted") return this.#result("aborted", attempts, startedAtMs, fallback);
			if (fallback.status === "accepted") return this.#result("owned-fallback", attempts, startedAtMs, fallback);
			return this.#result("exhausted", attempts, startedAtMs, fallback);
		} finally {
			clearTimeout(totalTimer);
		}
	}

	async #attemptCandidate(
		candidate: RelayCandidate,
		signal: AbortSignal,
		callerSignal: AbortSignal
	): Promise<RelayAttempt> {
		const startedAtMs = this.#now();
		this.#attemptedPeerIds.add(candidate.peerId);
		if (this.#active.has(candidate.peerId)) return baseAttempt(candidate, startedAtMs, this.#now(), "duplicate");
		const operatorCount = [...this.#active.values()].filter(
			(reservation) => reservation.candidate.operatorGroup === candidate.operatorGroup
		).length;
		if (operatorCount >= this.#limits.maxPerOperatorGroup) {
			return baseAttempt(candidate, startedAtMs, this.#now(), "operator-limit");
		}
		const address = selectAddress(
			candidate.addresses,
			this.#transportProfile.allowed,
			this.#allowInsecureWebSocketFixture
		);
		if (address === undefined) return baseAttempt(candidate, startedAtMs, this.#now(), "no-compatible-address");
		let inspection: RelayInspection;
		try {
			inspection = await withDeadline(
				(attemptSignal) => this.#inspector.inspect(candidate, address, attemptSignal),
				signal,
				this.#limits.perCandidateDeadlineMs
			);
		} catch (error) {
			return {
				...baseAttempt(candidate, startedAtMs, this.#now(), deadlineDialStatus(error, callerSignal)),
				address,
			};
		}
		if (inspection.outcome !== "connected") {
			return {
				...baseAttempt(
					candidate,
					startedAtMs,
					this.#now(),
					inspection.outcome === "timeout"
						? "dial-timeout"
						: inspection.outcome === "aborted"
							? "aborted"
							: "dial-refused"
				),
				address,
				connectionId: inspection.connectionId,
				hopAdvertised: inspection.hopAdvertised,
				identifyProtocols: [...inspection.protocols],
				inspectionLatencyMs: boundedNatural(inspection.latencyMs),
			};
		}
		if (!inspection.hopAdvertised || !inspection.protocols.includes(CIRCUIT_RELAY_V2_HOP_PROTOCOL)) {
			return {
				...baseAttempt(candidate, startedAtMs, this.#now(), "no-hop"),
				address,
				connectionId: inspection.connectionId,
				hopAdvertised: inspection.hopAdvertised,
				identifyProtocols: [...inspection.protocols],
				inspectionLatencyMs: boundedNatural(inspection.latencyMs),
			};
		}
		const reservationStartedAt = this.#now();
		try {
			const response = await withDeadline(
				(attemptSignal) => this.#reservationClient.reserve(candidate, attemptSignal),
				signal,
				this.#limits.perCandidateDeadlineMs
			);
			const decoded = decodeRelayReservationResponse(response, this.#now());
			if (!decoded.accepted) {
				return {
					address,
					candidate,
					connectionId: inspection.connectionId,
					finishedAtMs: this.#now(),
					hopAdvertised: true,
					identifyProtocols: [...inspection.protocols],
					inspectionLatencyMs: boundedNatural(inspection.latencyMs),
					reservationLatencyMs: Math.max(0, this.#now() - reservationStartedAt),
					reservationStatus: response.status,
					startedAtMs,
					status: decoded.failure,
				};
			}
			const reservation: ActiveRelayReservation = {
				candidate,
				expiresAtMs: decoded.expiresAtMs,
				limit: decoded.limit,
				reservedAtMs: this.#now(),
			};
			if (this.#active.has(candidate.peerId)) {
				const released = await this.#release(candidate);
				return {
					address,
					candidate,
					connectionId: inspection.connectionId,
					finishedAtMs: this.#now(),
					hopAdvertised: true,
					identifyProtocols: [...inspection.protocols],
					inspectionLatencyMs: boundedNatural(inspection.latencyMs),
					reservationLatencyMs: Math.max(0, this.#now() - reservationStartedAt),
					reservationStatus: response.status,
					startedAtMs,
					status: released ? "duplicate" : "release-failed",
				};
			}
			const groupCount = [...this.#active.values()].filter(
				(active) => active.candidate.operatorGroup === candidate.operatorGroup
			).length;
			if (groupCount >= this.#limits.maxPerOperatorGroup || this.#requirementsMet()) {
				const released = await this.#release(candidate);
				return {
					address,
					candidate,
					connectionId: inspection.connectionId,
					finishedAtMs: this.#now(),
					hopAdvertised: true,
					identifyProtocols: [...inspection.protocols],
					inspectionLatencyMs: boundedNatural(inspection.latencyMs),
					reservationLatencyMs: Math.max(0, this.#now() - reservationStartedAt),
					reservationStatus: response.status,
					startedAtMs,
					status: released ? "operator-limit" : "release-failed",
				};
			}
			if (this.#active.size >= this.#limits.requiredReservations) {
				const counts = new Map<string, number>();
				for (const active of this.#active.values()) {
					counts.set(active.candidate.operatorGroup, (counts.get(active.candidate.operatorGroup) ?? 0) + 1);
				}
				const surplus = [...this.#active.values()].find(
					(active) => (counts.get(active.candidate.operatorGroup) ?? 0) > 1
				);
				if (surplus !== undefined) await this.#drop(surplus.candidate.peerId);
			}
			this.#active.set(candidate.peerId, reservation);
			return {
				address,
				candidate,
				connectionId: inspection.connectionId,
				finishedAtMs: this.#now(),
				hopAdvertised: true,
				identifyProtocols: [...inspection.protocols],
				inspectionLatencyMs: boundedNatural(inspection.latencyMs),
				reservationLatencyMs: Math.max(0, this.#now() - reservationStartedAt),
				reservationStatus: response.status,
				startedAtMs,
				status: "reserved",
			};
		} catch (error) {
			if (error instanceof RelayTransportRateLimitError) {
				return {
					address,
					candidate,
					connectionId: inspection.connectionId,
					finishedAtMs: this.#now(),
					hopAdvertised: true,
					identifyProtocols: [...inspection.protocols],
					inspectionLatencyMs: boundedNatural(inspection.latencyMs),
					reservationLatencyMs: Math.max(0, this.#now() - reservationStartedAt),
					retryAfterMs: error.retryAfterMs,
					startedAtMs,
					status: "transport-rate-limited",
				};
			}
			return {
				address,
				candidate,
				connectionId: inspection.connectionId,
				finishedAtMs: this.#now(),
				hopAdvertised: true,
				identifyProtocols: [...inspection.protocols],
				inspectionLatencyMs: boundedNatural(inspection.latencyMs),
				reservationLatencyMs: Math.max(0, this.#now() - reservationStartedAt),
				startedAtMs,
				status: deadlineFailure(error, callerSignal),
			};
		}
	}

	async #tryFallback(signal: AbortSignal, remainingTotalMs: number): Promise<DnsaddrFallbackResult> {
		const fallback = this.#fallback;
		if (fallback === undefined) return { status: "empty" };
		if (signal.aborted) return { status: "aborted" };
		if (remainingTotalMs < 1) return { status: "timeout" };
		try {
			const result = await withDeadline(
				(attemptSignal) => fallback.acquire(attemptSignal),
				signal,
				Math.max(1, Math.min(this.#limits.ownedFallbackDeadlineMs, Math.floor(remainingTotalMs)))
			);
			if (
				result.status === "accepted" &&
				(result.address === undefined || result.expiresAtMs === undefined || result.expiresAtMs <= this.#now())
			) {
				return { status: "stale" };
			}
			return { ...result };
		} catch {
			return { status: signal.aborted ? "aborted" : "timeout" };
		}
	}

	#requirementsMet(): boolean {
		if (this.#active.size < this.#limits.requiredReservations) return false;
		return (
			new Set([...this.#active.values()].map(({ candidate }) => candidate.operatorGroup)).size >=
			this.#limits.requiredOperatorGroups
		);
	}

	#result(
		terminal: RelayPolicyResult["terminal"],
		attempts: RelayAttempt[],
		startedAtMs: number,
		fallback?: DnsaddrFallbackResult
	): RelayPolicyResult {
		return {
			attempts: attempts.map(cloneAttempt),
			candidatesObserved: this.#candidatePool.length,
			durationMs: Math.max(0, this.#now() - startedAtMs),
			...(fallback === undefined ? {} : { fallback: { ...fallback } }),
			operatorGroups: [...new Set([...this.#active.values()].map(({ candidate }) => candidate.operatorGroup))].sort(),
			reservations: this.activeReservations,
			terminal,
		};
	}

	async #drop(peerId: string): Promise<void> {
		const reservation = this.#active.get(peerId);
		if (reservation === undefined) return;
		this.#active.delete(peerId);
		await this.#release(reservation.candidate);
	}

	async #release(candidate: RelayCandidate): Promise<boolean> {
		try {
			await this.#reservationClient.release(candidate);
			this.#pendingReleases.delete(candidate.peerId);
			return true;
		} catch {
			this.#pendingReleases.set(candidate.peerId, cloneCandidate(candidate));
			return false;
		}
	}

	async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#queuedOperations >= MAX_QUEUED_OPERATIONS) {
			throw new Error(`RelayPolicy operation queue is full (${MAX_QUEUED_OPERATIONS})`);
		}
		this.#queuedOperations++;
		const previous = this.#tail;
		let release = (): void => undefined;
		this.#tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			this.#queuedOperations--;
			release();
		}
	}

	#assertRunning(): void {
		if (this.#stopped) throw new Error("RelayPolicy is stopped");
	}
}

interface CandidateCollectionResult {
	readonly attempts: RelayAttempt[];
	readonly candidates: RelayCandidate[];
}

async function collectCandidates(
	source: RelayCandidateSource,
	queryKey: Uint8Array,
	signal: AbortSignal,
	limits: RelayPolicyLimits,
	now: () => number
): Promise<CandidateCollectionResult> {
	const attempts: RelayAttempt[] = [];
	const candidates: RelayCandidate[] = [];
	const seen = new Set<string>();
	let observations = 0;
	const observationCap = Math.min(512, Math.max(limits.maxCandidates, limits.maxQueuedCandidates) * 4);
	for await (const candidate of source.getCandidates(queryKey, signal)) {
		observations++;
		if (observations > observationCap) break;
		if (candidates.length >= limits.maxCandidates || candidates.length >= limits.maxQueuedCandidates) break;
		if (!isValidCandidate(candidate)) {
			const observedAtMs = now();
			attempts.push(
				baseAttempt(
					sanitizeInvalidCandidate(candidate, queryKey, observations - 1),
					observedAtMs,
					now(),
					"invalid-candidate"
				)
			);
			continue;
		}
		if (seen.has(candidate.peerId)) continue;
		seen.add(candidate.peerId);
		candidates.push(cloneCandidate(candidate));
	}
	return { attempts, candidates };
}

async function withDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	parent: AbortSignal,
	timeoutMs: number
): Promise<T> {
	if (parent.aborted) throw parent.reason ?? new DOMException("Aborted", "AbortError");
	const controller = new AbortController();
	let rejectParent = (_reason: unknown): void => undefined;
	const parentAbort = new Promise<never>((_, reject) => {
		rejectParent = reject;
	});
	const onAbort = (): void => {
		const reason = parent.reason ?? new DOMException("Aborted", "AbortError");
		controller.abort(reason);
		rejectParent(reason);
	};
	parent.addEventListener("abort", onAbort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			const error = new RelayDeadlineError(`relay attempt exceeded ${timeoutMs} ms`);
			controller.abort(error);
			reject(error);
		}, timeoutMs);
	});
	const work = operation(controller.signal);
	void work.catch(() => undefined);
	try {
		return await Promise.race([work, timeout, parentAbort]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		parent.removeEventListener("abort", onAbort);
	}
}

/**
 *
 */
export class RelayDeadlineError extends Error {
	/**
	 * @param message - Deadline diagnostic.
	 */
	constructor(message: string) {
		super(message);
		this.name = "RelayDeadlineError";
	}
}

/**
 *
 */
export class RelayConnectionLostError extends Error {
	/**
	 * @param message - Connection-loss diagnostic.
	 */
	constructor(message = "relay connection lost during reservation signaling") {
		super(message);
		this.name = "RelayConnectionLostError";
	}
}

/**
 * Signals a throttle imposed by a transport, proxy, or reservation-client
 * wrapper. It is intentionally separate from Circuit Relay v2 wire statuses.
 */
export class RelayTransportRateLimitError extends Error {
	readonly retryAfterMs: number;

	/**
	 * @param retryAfterMs - Bounded transport retry delay.
	 */
	constructor(retryAfterMs: number) {
		super("relay reservation transport rate limited");
		this.name = "RelayTransportRateLimitError";
		this.retryAfterMs = boundedNatural(retryAfterMs);
	}
}

function parseLimits(input: Partial<RelayPolicyLimits> | undefined): RelayPolicyLimits {
	const limits = { ...DEFAULT_RELAY_POLICY_LIMITS, ...input };
	boundedInteger(limits.maxCandidates, 1, 128, "maxCandidates");
	boundedInteger(limits.maxConcurrentReservations, 1, 8, "maxConcurrentReservations");
	boundedInteger(limits.maxPerOperatorGroup, 1, 8, "maxPerOperatorGroup");
	boundedInteger(limits.maxQueuedCandidates, 1, 128, "maxQueuedCandidates");
	boundedInteger(limits.ownedFallbackDeadlineMs, 1, 10_000, "ownedFallbackDeadlineMs");
	boundedInteger(limits.perCandidateDeadlineMs, 1, 10_000, "perCandidateDeadlineMs");
	boundedInteger(limits.refreshBeforeExpiryMs, 1, 300_000, "refreshBeforeExpiryMs");
	boundedInteger(limits.requiredOperatorGroups, 1, 8, "requiredOperatorGroups");
	boundedInteger(limits.requiredReservations, 1, 8, "requiredReservations");
	boundedInteger(limits.totalDeadlineMs, 1, 30_000, "totalDeadlineMs");
	if (limits.requiredReservations > limits.maxCandidates) {
		throw new Error("requiredReservations must not exceed maxCandidates");
	}
	if (limits.requiredOperatorGroups > limits.requiredReservations) {
		throw new Error("requiredOperatorGroups must not exceed requiredReservations");
	}
	if (limits.maxQueuedCandidates < limits.requiredReservations) {
		throw new Error("maxQueuedCandidates must cover requiredReservations");
	}
	if (limits.maxPerOperatorGroup * limits.requiredOperatorGroups < limits.requiredReservations) {
		throw new Error("operator-group capacity cannot satisfy requiredReservations");
	}
	return limits;
}

function parseTransportProfile(profile: RelayTransportProfile): RelayTransportProfile {
	if (profile.name !== "wss-only" && profile.name !== "broad-browser") throw new Error("unknown transport profile");
	const allowed = [...new Set(profile.allowed)];
	if (allowed.length === 0 || allowed.some((transport) => !isRelayTransport(transport))) {
		throw new Error("transport profile must contain supported relay transports");
	}
	if (profile.name === "wss-only" && (allowed.length !== 1 || allowed[0] !== "wss")) {
		throw new Error("wss-only profile may contain only wss");
	}
	return { allowed, name: profile.name };
}

function isValidCandidate(candidate: unknown): candidate is RelayCandidate {
	if (candidate === null || typeof candidate !== "object") return false;
	const item = candidate as Partial<RelayCandidate>;
	if (typeof item.peerId !== "string" || item.peerId.length < 1 || item.peerId.length > 128) return false;
	if (
		!Array.isArray(item.addresses) ||
		item.addresses.length > 32 ||
		item.addresses.some((value) => typeof value !== "string")
	) {
		return false;
	}
	if (
		!Array.isArray(item.protocols) ||
		item.protocols.length > 64 ||
		item.protocols.some((value) => typeof value !== "string")
	) {
		return false;
	}
	if (typeof item.operatorGroup !== "string" || !isOperatorGroup(item.operatorGroup)) return false;
	const provenance = item.provenance;
	if (provenance === null || typeof provenance !== "object") return false;
	return (
		(provenance.origin === "browser-closest-peers" || provenance.origin === "node-closest-peers") &&
		typeof provenance.queryDigest === "string" &&
		provenance.queryDigest.length <= 64 &&
		Number.isSafeInteger(provenance.resultIndex) &&
		provenance.resultIndex >= 0 &&
		(provenance.routingSource === "delegated-routing" || provenance.routingSource === "public-dht")
	);
}

function isOperatorGroup(value: string): boolean {
	return /^[a-zA-Z0-9._:-]{1,64}$/u.test(value);
}

function safeOperatorGroup(classify: () => string): string {
	try {
		const group = classify();
		return isOperatorGroup(group) ? group : "unknown";
	} catch {
		return "unknown";
	}
}

function selectAddress(
	addresses: readonly string[],
	allowed: readonly RelayTransport[],
	allowInsecureWebSocketFixture = false
): string | undefined {
	for (const transport of allowed) {
		const address = addresses.find(
			(candidate) => addressTransport(candidate, allowInsecureWebSocketFixture) === transport
		);
		if (address !== undefined) return address;
	}
	return undefined;
}

function addressTransport(address: string, allowInsecureWebSocketFixture = false): RelayTransport | "unsupported" {
	let names: string[];
	try {
		names = multiaddr(address)
			.getComponents()
			.map(({ name }) => name);
	} catch {
		return "unsupported";
	}
	if (names.includes("wss")) return "wss";
	if (allowInsecureWebSocketFixture && names.includes("ws") && !names.includes("tls")) return "wss";
	if (names.includes("webtransport")) return "webtransport";
	if (names.includes("webrtc-direct")) return "webrtc-direct";
	return "unsupported";
}

function statusFailure(status: number): RelayReservationFailure {
	switch (status) {
		case RELAY_RESERVATION_STATUS.RESERVATION_REFUSED:
			return "refused";
		case RELAY_RESERVATION_STATUS.RESOURCE_LIMIT_EXCEEDED:
			return "resource-limit";
		case RELAY_RESERVATION_STATUS.PERMISSION_DENIED:
			return "permission-denied";
		case RELAY_RESERVATION_STATUS.CONNECTION_FAILED:
			return "connection-failed";
		case RELAY_RESERVATION_STATUS.NO_RESERVATION:
			return "no-reservation";
		case RELAY_RESERVATION_STATUS.MALFORMED_MESSAGE:
			return "malformed-response";
		case RELAY_RESERVATION_STATUS.UNEXPECTED_MESSAGE:
			return "unexpected-response";
		default:
			return "unexpected-response";
	}
}

function deadlineFailure(error: unknown, parent: AbortSignal): RelayReservationFailure {
	if (parent.aborted) return "aborted";
	if (error instanceof RelayConnectionLostError) return "connection-failed";
	return error instanceof RelayDeadlineError ? "timeout" : "refused";
}

function deadlineDialStatus(error: unknown, parent: AbortSignal): RelayAttempt["status"] {
	if (parent.aborted) return "aborted";
	return error instanceof RelayDeadlineError ? "dial-timeout" : "dial-refused";
}

function baseAttempt(
	candidate: RelayCandidate,
	startedAtMs: number,
	finishedAtMs: number,
	status: RelayAttempt["status"]
): RelayAttempt {
	return {
		candidate,
		finishedAtMs,
		hopAdvertised: false,
		identifyProtocols: [],
		inspectionLatencyMs: 0,
		reservationLatencyMs: 0,
		startedAtMs,
		status,
	};
}

function reservationAttempt(
	candidate: RelayCandidate,
	startedAtMs: number,
	finishedAtMs: number,
	status: RelayAttempt["status"],
	reservationStatus?: number
): RelayAttempt {
	return {
		...baseAttempt(candidate, startedAtMs, finishedAtMs, status),
		reservationLatencyMs: Math.max(0, finishedAtMs - startedAtMs),
		...(reservationStatus === undefined ? {} : { reservationStatus }),
	};
}

function cloneCandidate(candidate: RelayCandidate): RelayCandidate {
	return {
		addresses: [...candidate.addresses],
		operatorGroup: candidate.operatorGroup,
		peerId: candidate.peerId,
		protocols: [...candidate.protocols],
		provenance: { ...candidate.provenance },
	};
}

function cloneReservation(reservation: ActiveRelayReservation): ActiveRelayReservation {
	return {
		candidate: cloneCandidate(reservation.candidate),
		expiresAtMs: reservation.expiresAtMs,
		limit: { ...reservation.limit },
		reservedAtMs: reservation.reservedAtMs,
	};
}

function cloneAttempt(attempt: RelayAttempt): RelayAttempt {
	return {
		...attempt,
		candidate: cloneCandidate(attempt.candidate),
		identifyProtocols: [...attempt.identifyProtocols],
	};
}

function digestQueryKey(key: Uint8Array): string {
	let hash = 0x811c9dc5;
	for (const byte of key) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193);
	}
	return `query_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function syntheticCandidate(queryKey: Uint8Array): RelayCandidate {
	return {
		addresses: [],
		operatorGroup: "unknown",
		peerId: "candidate-source",
		protocols: [],
		provenance: {
			origin: "browser-closest-peers",
			queryDigest: digestQueryKey(queryKey),
			resultIndex: 0,
			routingSource: "delegated-routing",
		},
	};
}

function sanitizeInvalidCandidate(candidate: unknown, queryKey: Uint8Array, resultIndex: number): RelayCandidate {
	const value = candidate !== null && typeof candidate === "object" ? (candidate as Partial<RelayCandidate>) : {};
	const provenance =
		value.provenance !== null && typeof value.provenance === "object"
			? (value.provenance as Partial<RelayCandidate["provenance"]>)
			: {};
	const origin = provenance.origin === "node-closest-peers" ? "node-closest-peers" : ("browser-closest-peers" as const);
	return {
		addresses: [],
		operatorGroup: "unknown",
		peerId: `invalid-candidate-${resultIndex}`,
		protocols: [],
		provenance: {
			origin,
			queryDigest: digestQueryKey(queryKey),
			resultIndex,
			routingSource: origin === "node-closest-peers" ? "public-dht" : "delegated-routing",
		},
	};
}

function monotonicNow(): number {
	return typeof performance === "undefined" ? Date.now() : performance.now();
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
	}
	return value;
}

function boundedNatural(value: number): number {
	if (!Number.isFinite(value) || value < 0) return 0;
	return Math.floor(value);
}

function safeNumber(value: bigint | number): number {
	const number = typeof value === "bigint" ? Number(value) : value;
	return Number.isSafeInteger(number) && number >= 0 ? number : Number.NaN;
}

function isRelayTransport(value: string): value is RelayTransport {
	return value === "wss" || value === "webtransport" || value === "webrtc-direct";
}
