import {
	BrowserRoutingClosestPeersSource,
	CIRCUIT_RELAY_V2_HOP_PROTOCOL,
	type DnsaddrFallback,
	type DnsaddrFallbackResult,
	RELAY_RESERVATION_STATUS,
	RELAY_TRANSPORT_PROFILES,
	type RelayAttempt,
	type RelayCandidate,
	type RelayInspection,
	type RelayInspector,
	RelayPolicy,
	type RelayPolicyLimits,
	type RelayPolicyResult,
	type RelayReservationClient,
	type RelayReservationWireResponse,
	type RelayTransportProfile,
} from "./index.js";
import type { BrowserRoutingPeer } from "../browser-routing/index.js";

const FIXTURE_NOW = 1_750_000_000_000;
const QUERY_KEY = new TextEncoder().encode("drp-relay-fixture-v1");

export const RELAY_FIXTURE_LIMITS = Object.freeze({
	maxCandidates: 6,
	maxConcurrentReservations: 2,
	maxPerOperatorGroup: 1,
	maxQueuedCandidates: 6,
	ownedFallbackDeadlineMs: 100,
	perCandidateDeadlineMs: 100,
	refreshBeforeExpiryMs: 30_000,
	requiredOperatorGroups: 2,
	requiredReservations: 2,
	totalDeadlineMs: 500,
} satisfies RelayPolicyLimits);

export type RelayFixtureScenario = "all-refused" | "mixed" | "stale-fallback" | "transport-profile";

export interface RelayFixtureAssertion {
	readonly actual: string;
	readonly expected: string;
	readonly label: string;
	readonly passed: boolean;
}

export interface RelayFixtureAttempt {
	readonly candidateAlias: string;
	readonly hopAdvertised: boolean;
	readonly origin: string;
	readonly operatorGroup: string;
	readonly queryDigest: string;
	readonly reservationStatus?: number;
	readonly resultIndex: number;
	readonly status: RelayAttempt["status"];
	readonly transport: string;
}

export interface RelayFixtureResult {
	readonly assertions: readonly RelayFixtureAssertion[];
	readonly attempts: readonly RelayFixtureAttempt[];
	readonly candidateCount: number;
	readonly fixtureLatencyMs: number;
	readonly limits: RelayPolicyLimits;
	readonly operatorGroups: readonly string[];
	readonly privateIdentifierFields: number;
	readonly reservationCount: number;
	readonly scenario: RelayFixtureScenario;
	readonly terminal: RelayPolicyResult["terminal"];
	readonly traceId: "relay-fixture-v1";
	readonly transportProfile: RelayTransportProfile["name"];
}

/**
 * Runs the Phase 06 relay lifecycle through the real browser closest-peer
 * adapter. Candidate data enters the policy only through the routing seam.
 * @param scenario - Deterministic failure or success scenario.
 * @param profile - Browser transport allowlist exercised by the policy.
 * @returns Sanitized relay decision evidence.
 */
export async function createRelayFixture(
	scenario: RelayFixtureScenario = "mixed",
	profile: RelayTransportProfile = RELAY_TRANSPORT_PROFILES.broadBrowser
): Promise<RelayFixtureResult> {
	let now = FIXTURE_NOW;
	const peers = fixturePeers();
	const routing = {
		async *getClosestPeers(): AsyncIterable<BrowserRoutingPeer> {
			await Promise.resolve();
			for (const peer of peers) yield peer;
		},
	};
	const source = new BrowserRoutingClosestPeersSource(routing, (peer) => peer.peerId.split("-")[1] ?? "unknown");
	const inspector = fixtureInspector(scenario);
	const reservationClient = new FixtureReservationClient(scenario, () => now);
	const fallback = fixtureFallback(scenario, () => now);
	const policy = new RelayPolicy({
		fallback,
		inspector,
		limits: RELAY_FIXTURE_LIMITS,
		now: (): number => now,
		reservationClient,
		source,
		transportProfile: profile,
	});
	const startedAt = performance.now();
	const result = await policy.acquire(QUERY_KEY, AbortSignal.timeout(1_000));
	const fixtureLatencyMs = performance.now() - startedAt;
	const initialReservations = result.reservations.length;
	let refreshTerminal = result.terminal;
	if (scenario === "mixed" && result.terminal === "reserved") {
		now += 35_000;
		refreshTerminal = (await policy.refresh(AbortSignal.timeout(1_000))).terminal;
	}
	const attempts = sanitizeAttempts(result.attempts);
	const assertions = [
		assertion("Routing provenance retained", attempts[0]?.origin ?? "missing", "browser-closest-peers"),
		assertion(
			"HOP measured separately",
			String(attempts.some((attempt) => attempt.hopAdvertised && attempt.status !== "reserved")),
			"true"
		),
		assertion("Terminal outcome", result.terminal, expectedTerminal(scenario, profile)),
		assertion("Reservation count", String(initialReservations), expectedReservationCount(scenario, profile)),
		assertion("Operator diversity", String(result.operatorGroups.length), expectedOperatorGroups(scenario, profile)),
		assertion(
			"Refresh lifecycle",
			refreshTerminal,
			scenario === "mixed" && profile.name === "broad-browser" ? "reserved" : expectedTerminal(scenario, profile)
		),
		assertion(
			"Actual reservation status decoded",
			String(attempts.some((attempt) => attempt.reservationStatus === RELAY_RESERVATION_STATUS.OK)),
			(scenario === "mixed" || scenario === "transport-profile") && result.reservations.length > 0 ? "true" : "false"
		),
		assertion(
			"Raw Peer IDs present",
			String(attempts.some((attempt) => attempt.candidateAlias.startsWith("relay-"))),
			"false"
		),
	];
	await policy.stop();
	return {
		assertions,
		attempts,
		candidateCount: result.candidatesObserved,
		fixtureLatencyMs,
		limits: { ...RELAY_FIXTURE_LIMITS },
		operatorGroups: result.operatorGroups,
		privateIdentifierFields: countPrivateIdentifiers(attempts),
		reservationCount: initialReservations,
		scenario,
		terminal: result.terminal,
		traceId: "relay-fixture-v1",
		transportProfile: profile.name,
	};
}

function fixturePeers(): BrowserRoutingPeer[] {
	return [
		peer("relay-A-timeout", ["/dns4/a.invalid/tcp/443/wss/p2p/relay-A-timeout"]),
		peer("relay-A-nohop", ["/dns4/b.invalid/tcp/443/wss/p2p/relay-A-nohop"]),
		peer("relay-A-full", ["/dns4/c.invalid/udp/443/quic-v1/webtransport/p2p/relay-A-full"]),
		peer("relay-B-accept", ["/dns4/d.invalid/tcp/443/wss/p2p/relay-B-accept"]),
		peer("relay-C-accept", ["/dns4/e.invalid/udp/443/webrtc-direct/p2p/relay-C-accept"]),
		peer("relay-D-refuse", ["/dns4/f.invalid/tcp/443/wss/p2p/relay-D-refuse"]),
	];
}

function peer(peerId: string, addresses: string[]): BrowserRoutingPeer {
	return {
		acceptedAddresses: addresses,
		addressDecisions: [],
		inputAddressCount: addresses.length,
		peerId,
		protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
		rawAddresses: addresses,
		truncatedAddressCount: 0,
	};
}

function fixtureInspector(scenario: RelayFixtureScenario): RelayInspector {
	return {
		async inspect(candidate: RelayCandidate, _address: string, signal: AbortSignal): Promise<RelayInspection> {
			await Promise.resolve();
			if (signal.aborted) throw signal.reason;
			if (candidate.peerId.endsWith("timeout")) {
				return { hopAdvertised: false, latencyMs: 80, outcome: "timeout", protocols: [] };
			}
			if (candidate.peerId.endsWith("nohop")) {
				return { hopAdvertised: false, latencyMs: 7, outcome: "connected", protocols: ["/ipfs/id/1.0.0"] };
			}
			return {
				connectionId: `fixture-${candidate.provenance.resultIndex}`,
				hopAdvertised: true,
				latencyMs: scenario === "all-refused" ? 12 : 9,
				outcome: "connected",
				protocols: ["/ipfs/id/1.0.0", CIRCUIT_RELAY_V2_HOP_PROTOCOL],
			};
		},
	};
}

class FixtureReservationClient implements RelayReservationClient {
	readonly #now: () => number;
	readonly #scenario: RelayFixtureScenario;

	constructor(scenario: RelayFixtureScenario, now: () => number) {
		this.#scenario = scenario;
		this.#now = now;
	}

	refresh(candidate: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse> {
		return this.reserve(candidate, signal);
	}

	release(): Promise<void> {
		return Promise.resolve();
	}

	reserve(candidate: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse> {
		if (signal.aborted) return Promise.reject(signal.reason);
		if (this.#scenario === "all-refused" || this.#scenario === "stale-fallback") {
			return Promise.resolve({ status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED });
		}
		if (candidate.peerId.endsWith("full")) {
			return Promise.resolve({ status: RELAY_RESERVATION_STATUS.RESOURCE_LIMIT_EXCEEDED });
		}
		if (candidate.peerId.endsWith("refuse")) {
			return Promise.resolve({ status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED });
		}
		return Promise.resolve({
			limit: { data: 1_048_576, duration: 120 },
			reservation: { expire: Math.floor((this.#now() + 60_000) / 1_000) },
			status: RELAY_RESERVATION_STATUS.OK,
		});
	}
}

function fixtureFallback(scenario: RelayFixtureScenario, now: () => number): DnsaddrFallback {
	return {
		acquire(): Promise<DnsaddrFallbackResult> {
			if (scenario === "stale-fallback") {
				return Promise.resolve({
					address: "/dnsaddr/stale.invalid/p2p/owned",
					expiresAtMs: now() - 1,
					status: "accepted",
				});
			}
			if (scenario === "all-refused") {
				return Promise.resolve({
					address: "/dnsaddr/owned.invalid/p2p/owned",
					expiresAtMs: now() + 60_000,
					status: "accepted",
				});
			}
			return Promise.resolve({ status: "empty" });
		},
	};
}

function sanitizeAttempts(attempts: readonly RelayAttempt[]): RelayFixtureAttempt[] {
	const aliases = new Map<string, string>();
	return attempts.map((attempt) => {
		let alias = aliases.get(attempt.candidate.peerId);
		if (alias === undefined) {
			alias = `candidate-${aliases.size + 1}`;
			aliases.set(attempt.candidate.peerId, alias);
		}
		return {
			candidateAlias: alias,
			hopAdvertised: attempt.hopAdvertised,
			origin: attempt.candidate.provenance.origin,
			operatorGroup: attempt.candidate.operatorGroup,
			queryDigest: attempt.candidate.provenance.queryDigest,
			...(attempt.reservationStatus === undefined ? {} : { reservationStatus: attempt.reservationStatus }),
			resultIndex: attempt.candidate.provenance.resultIndex,
			status: attempt.status,
			transport: attempt.address === undefined ? "none" : transport(attempt.address),
		};
	});
}

function expectedTerminal(
	scenario: RelayFixtureScenario,
	profile: RelayTransportProfile = RELAY_TRANSPORT_PROFILES.broadBrowser
): RelayPolicyResult["terminal"] {
	if (scenario === "mixed" || scenario === "transport-profile") {
		return profile.name === "broad-browser" ? "reserved" : "exhausted";
	}
	if (scenario === "all-refused") return "owned-fallback";
	return "exhausted";
}

function expectedReservationCount(scenario: RelayFixtureScenario, profile: RelayTransportProfile): string {
	if (scenario !== "mixed" && scenario !== "transport-profile") return "0";
	return profile.name === "broad-browser" ? "2" : "1";
}

function expectedOperatorGroups(scenario: RelayFixtureScenario, profile: RelayTransportProfile): string {
	if (scenario !== "mixed" && scenario !== "transport-profile") return "0";
	return profile.name === "broad-browser" ? "2" : "1";
}

function assertion(label: string, actual: string, expected: string): RelayFixtureAssertion {
	return { actual, expected, label, passed: actual === expected };
}

function countPrivateIdentifiers(attempts: readonly RelayFixtureAttempt[]): number {
	return attempts.reduce(
		(total, attempt) =>
			total +
			Object.entries(attempt).filter(
				([key, value]) =>
					typeof value === "string" && (key.toLowerCase().includes("peerid") || value.startsWith("relay-"))
			).length,
		0
	);
}

function transport(address: string): string {
	if (address.includes("/webtransport")) return "webtransport";
	if (address.includes("/webrtc-direct")) return "webrtc-direct";
	if (address.includes("/wss")) return "wss";
	return "unsupported";
}
