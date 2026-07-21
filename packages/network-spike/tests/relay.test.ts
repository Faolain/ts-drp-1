import { describe, expect, it } from "vitest";

import type { BrowserRoutingPeer } from "../src/browser-routing/index.js";
import type { RoutingPeer } from "../src/node-routing/index.js";
import { createRelayFixture } from "../src/relay/fixture.js";
import {
	BrowserRoutingClosestPeersSource,
	CIRCUIT_RELAY_V2_HOP_PROTOCOL,
	decodeHopReservationResponse,
	decodeRelayReservationResponse,
	type DnsaddrFallback,
	Libp2pRelayClient,
	NodeRoutingClosestPeersSource,
	RELAY_RESERVATION_STATUS,
	RELAY_TRANSPORT_PROFILES,
	type RelayCandidate,
	type RelayCandidateSource,
	RelayConnectionLostError,
	type RelayInspection,
	type RelayInspector,
	RelayPolicy,
	type RelayReservationClient,
	type RelayReservationWireResponse,
	RelayTransportRateLimitError,
} from "../src/relay/index.js";

const NOW = 1_750_000_000_000;
const QUERY = Uint8Array.from([1, 2, 3, 4]);

describe("relay closest-peer adapters", () => {
	it("preserves Node query and result provenance through the only Node adapter", async () => {
		const peers = [nodePeer("node-a"), nodePeer("node-b")];
		const source = new NodeRoutingClosestPeersSource(
			{
				async *getClosestPeers(key): AsyncIterable<RoutingPeer> {
					await Promise.resolve();
					expect(key).toEqual(QUERY);
					yield* peers;
				},
			},
			(peer) => `asn:${peer.peerId}`
		);
		const output = await collect(source);
		expect(output).toMatchObject([
			{
				operatorGroup: "asn:node-a",
				peerId: "node-a",
				provenance: {
					origin: "node-closest-peers",
					queryDigest: "query_5734a87d",
					resultIndex: 0,
					routingSource: "public-dht",
				},
			},
			{
				peerId: "node-b",
				provenance: { resultIndex: 1 },
			},
		]);
	});

	it("preserves delegated endpoint result provenance through the browser adapter", async () => {
		const source = new BrowserRoutingClosestPeersSource(
			{
				async *getClosestPeers(key): AsyncIterable<BrowserRoutingPeer> {
					await Promise.resolve();
					expect(key).toEqual(QUERY);
					yield browserPeer("browser-a", wss("browser-a"));
				},
			},
			() => "operator:red"
		);
		await expect(collect(source)).resolves.toMatchObject([
			{
				addresses: [wss("browser-a")],
				operatorGroup: "operator:red",
				protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
				provenance: {
					origin: "browser-closest-peers",
					queryDigest: "query_5734a87d",
					resultIndex: 0,
					routingSource: "delegated-routing",
				},
			},
		]);
	});

	it("caps and deduplicates candidate results before policy work", async () => {
		const source = sourceOf([candidate("a", "g1"), candidate("a", "g1"), candidate("b", "g2"), candidate("c", "g3")]);
		const { policy } = harness({ limits: { maxCandidates: 2, maxQueuedCandidates: 2 }, source });
		const result = await policy.acquire(QUERY, signal());
		expect(result.candidatesObserved).toBe(2);
		expect(result.terminal).toBe("reserved");
	});

	it("uses a conservative unknown group when an operator classifier throws", async () => {
		const source = new NodeRoutingClosestPeersSource(
			{
				async *getClosestPeers(): AsyncIterable<RoutingPeer> {
					await Promise.resolve();
					yield nodePeer("node-a");
				},
			},
			() => {
				throw new Error("classifier failed");
			}
		);
		await expect(collect(source)).resolves.toMatchObject([{ operatorGroup: "unknown" }]);
	});
});

describe("Circuit Relay v2 reservation decoding", () => {
	it("distinguishes Identify without HOP support from a reservation result", async () => {
		const client = relayClientWith({ connection: true, protocols: ["/ipfs/id/1.0.0"] });
		await expect(client.inspect(validRelayCandidate(), "ignored", signal())).resolves.toMatchObject({
			hopAdvertised: false,
			outcome: "connected",
			protocols: ["/ipfs/id/1.0.0"],
		});
	});

	it("returns a typed inspection timeout when no connection appears", async () => {
		const client = relayClientWith({ connection: false, protocols: [] });
		await expect(client.inspect(validRelayCandidate(), "ignored", signal())).resolves.toMatchObject({
			hopAdvertised: false,
			outcome: "timeout",
			protocols: [],
		});
	});

	it("decodes an actual HOP RESERVE response with expiry and limits", () => {
		const expire = BigInt(Math.floor((NOW + 60_000) / 1_000));
		const response = decodeHopReservationResponse(
			protobufMessage(
				protobufBytes(3, protobufVarint(1, expire)),
				protobufBytes(4, protobufMessage(protobufVarint(1, BigInt(60)), protobufVarint(2, BigInt(1_024)))),
				protobufVarint(5, BigInt(RELAY_RESERVATION_STATUS.OK))
			)
		);
		expect(response).toEqual({
			limit: { data: BigInt(1_024), duration: 60 },
			reservation: { expire },
			status: RELAY_RESERVATION_STATUS.OK,
		});
	});

	it("keeps an explicit reservation refusal distinct from HOP advertisement", () => {
		expect(
			decodeHopReservationResponse(protobufVarint(5, BigInt(RELAY_RESERVATION_STATUS.RESERVATION_REFUSED)))
		).toEqual({ status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED });
	});

	it.each([
		new Uint8Array(),
		protobufMessage(protobufVarint(5, BigInt(100)), protobufVarint(5, BigInt(100))),
		Uint8Array.of(26, 5, 8),
	])("rejects malformed HOP response %#", (bytes) => {
		expect(() => decodeHopReservationResponse(bytes)).toThrow();
	});

	it("accepts only OK with a live reservation and preserves resource limits", () => {
		expect(
			decodeRelayReservationResponse(
				{
					limit: { data: BigInt(1_024), duration: 60 },
					reservation: { expire: BigInt(Math.floor((NOW + 60_000) / 1_000)) },
					status: RELAY_RESERVATION_STATUS.OK,
				},
				NOW
			)
		).toEqual({
			accepted: true,
			expiresAtMs: NOW + 60_000,
			limit: { dataBytes: 1_024, durationSeconds: 60 },
		});
	});

	it.each([
		[RELAY_RESERVATION_STATUS.RESERVATION_REFUSED, "refused"],
		[RELAY_RESERVATION_STATUS.RESOURCE_LIMIT_EXCEEDED, "resource-limit"],
		[RELAY_RESERVATION_STATUS.PERMISSION_DENIED, "permission-denied"],
		[RELAY_RESERVATION_STATUS.CONNECTION_FAILED, "connection-failed"],
		[RELAY_RESERVATION_STATUS.NO_RESERVATION, "no-reservation"],
		[RELAY_RESERVATION_STATUS.MALFORMED_MESSAGE, "malformed-response"],
		[RELAY_RESERVATION_STATUS.UNEXPECTED_MESSAGE, "unexpected-response"],
		[429, "unexpected-response"],
	] as const)("maps wire status %s to %s", (status, failure) => {
		expect(decodeRelayReservationResponse({ status }, NOW)).toEqual({ accepted: false, failure });
	});

	it("does not turn HOP support or an expired/missing reservation into acceptance", () => {
		expect(decodeRelayReservationResponse({ status: RELAY_RESERVATION_STATUS.OK }, NOW)).toEqual({
			accepted: false,
			failure: "malformed-response",
		});
		expect(
			decodeRelayReservationResponse(
				{ reservation: { expire: BigInt(Math.floor(NOW / 1_000)) }, status: RELAY_RESERVATION_STATUS.OK },
				NOW
			)
		).toEqual({ accepted: false, failure: "no-reservation" });
	});

	it("rejects malformed reservation resource limits instead of coercing them", () => {
		expect(
			decodeRelayReservationResponse(
				{
					limit: { data: Number.NaN, duration: -1 },
					reservation: { expire: Math.floor((NOW + 60_000) / 1_000) },
					status: RELAY_RESERVATION_STATUS.OK,
				},
				NOW
			)
		).toEqual({ accepted: false, failure: "malformed-response" });
	});
});

describe("bounded relay policy", () => {
	it("dials, identifies, checks HOP, decodes acceptance, and enforces two-group diversity", async () => {
		const { policy, reservationClient } = harness();
		const result = await policy.acquire(QUERY, signal());
		expect(result.terminal).toBe("reserved");
		expect(result.reservations).toHaveLength(2);
		expect(result.operatorGroups).toEqual(["g1", "g2"]);
		expect(result.attempts).toMatchObject([
			{ hopAdvertised: true, reservationStatus: 100, status: "reserved" },
			{ hopAdvertised: true, reservationStatus: 100, status: "reserved" },
		]);
		expect(reservationClient.maxActive).toBeLessThanOrEqual(2);
	});

	it("measures unsupported HOP separately and never sends a reservation", async () => {
		const reservationClient = scriptedReservation({});
		const { policy } = harness({
			inspector: scriptedInspector({
				a: { hopAdvertised: false, latencyMs: 1, outcome: "connected", protocols: ["/ipfs/id/1.0.0"] },
				b: { hopAdvertised: false, latencyMs: 1, outcome: "connected", protocols: ["/ipfs/id/1.0.0"] },
			}),
			reservationClient,
		});
		const result = await policy.acquire(QUERY, signal());
		expect(result.attempts.every(({ status }) => status === "no-hop")).toBe(true);
		expect(reservationClient.reserveCalls).toBe(0);
		expect(result.terminal).toBe("exhausted");
	});

	it("rotates across refused, full, rate-limited, and accepted candidates", async () => {
		const candidates = [
			candidate("refused", "g0"),
			candidate("full", "g0"),
			candidate("limited", "g0"),
			candidate("accepted-a", "g1"),
			candidate("accepted-b", "g2"),
		];
		const reservationClient = scriptedReservation({
			full: { status: RELAY_RESERVATION_STATUS.RESOURCE_LIMIT_EXCEEDED },
			limited: new RelayTransportRateLimitError(1_000),
			refused: { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED },
		});
		const { policy } = harness({ reservationClient, source: sourceOf(candidates) });
		const result = await policy.acquire(QUERY, signal());
		expect(result.terminal).toBe("reserved");
		expect(result.attempts.map(({ status }) => status)).toEqual([
			"refused",
			"resource-limit",
			"transport-rate-limited",
			"reserved",
			"reserved",
		]);
		expect(result.attempts[2]).toMatchObject({ retryAfterMs: 1_000 });
		expect(result.attempts[2]?.reservationStatus).toBeUndefined();
	});

	it("owns a literal per-candidate timeout even when the inspector ignores its signal", async () => {
		const inspector: RelayInspector = {
			inspect(candidate): Promise<RelayInspection> {
				if (candidate.peerId === "a") return new Promise(() => undefined);
				return Promise.resolve(connected());
			},
		};
		const { policy } = harness({
			inspector,
			limits: { perCandidateDeadlineMs: 10, totalDeadlineMs: 250 },
			source: sourceOf([candidate("a", "g0"), candidate("b", "g1"), candidate("c", "g2")]),
		});
		const started = performance.now();
		const result = await policy.acquire(QUERY, signal());
		expect(performance.now() - started).toBeLessThan(250);
		expect(result.attempts.map(({ status }) => status)).toContain("dial-timeout");
		expect(result.terminal).toBe("reserved");
	});

	it("owns a strict total public deadline when a dependency ignores cancellation", async () => {
		const { policy } = harness({
			inspector: { inspect: () => new Promise(() => undefined) },
			limits: { maxConcurrentReservations: 1, perCandidateDeadlineMs: 500, totalDeadlineMs: 10 },
			source: sourceOf([candidate("a", "g0"), candidate("b", "g1"), candidate("c", "g2")]),
		});
		const started = performance.now();
		const result = await policy.acquire(QUERY, signal());
		expect(performance.now() - started).toBeLessThan(100);
		expect(result.terminal).toBe("exhausted");
		expect(result.attempts).toMatchObject([{ status: "dial-timeout" }]);
	});

	it("rotates when the relay connection disappears during reservation signaling", async () => {
		const base = scriptedReservation({});
		const reservationClient: RelayReservationClient = {
			refresh: (candidateItem, attemptSignal) => base.refresh(candidateItem, attemptSignal),
			release: () => base.release(),
			reserve: (candidateItem, attemptSignal) =>
				candidateItem.peerId === "a"
					? Promise.reject(new RelayConnectionLostError())
					: base.reserve(candidateItem, attemptSignal),
		};
		const policy = new RelayPolicy({
			fallback: { acquire: (): Promise<{ status: "empty" }> => Promise.resolve({ status: "empty" }) },
			inspector: scriptedInspector({}),
			limits: {
				maxCandidates: 3,
				maxConcurrentReservations: 1,
				maxPerOperatorGroup: 1,
				maxQueuedCandidates: 3,
				ownedFallbackDeadlineMs: 20,
				perCandidateDeadlineMs: 50,
				refreshBeforeExpiryMs: 120_000,
				requiredOperatorGroups: 2,
				requiredReservations: 2,
				totalDeadlineMs: 500,
			},
			now: (): number => NOW,
			reservationClient,
			source: sourceOf([candidate("a", "g0"), candidate("b", "g1"), candidate("c", "g2")]),
		});
		const result = await policy.acquire(QUERY, signal());
		expect(result.terminal).toBe("reserved");
		expect(result.attempts.map(({ status }) => status)).toEqual(["connection-failed", "reserved", "reserved"]);
	});

	it("bounds reservation concurrency and releases surplus same-group races", async () => {
		const reservationClient = scriptedReservation({}, 5);
		const candidates = Array.from({ length: 8 }, (_, index) =>
			candidate(`peer-${index}`, index < 4 ? "g1" : `g${index}`)
		);
		const { policy } = harness({
			limits: { maxConcurrentReservations: 3, maxPerOperatorGroup: 1 },
			reservationClient,
			source: sourceOf(candidates),
		});
		const result = await policy.acquire(QUERY, signal());
		expect(reservationClient.maxActive).toBeLessThanOrEqual(3);
		expect(result.operatorGroups).toHaveLength(2);
		expect(new Set(result.operatorGroups).size).toBe(2);
		expect(reservationClient.releaseCalls).toBeGreaterThanOrEqual(1);
	});

	it("replaces same-group surplus so a later operator group can satisfy diversity", async () => {
		const { policy } = harness({
			limits: {
				maxConcurrentReservations: 1,
				maxPerOperatorGroup: 2,
				requiredOperatorGroups: 2,
				requiredReservations: 2,
			},
			source: sourceOf([candidate("same-a", "g1"), candidate("same-b", "g1"), candidate("other", "g2")]),
		});
		const result = await policy.acquire(QUERY, signal());
		expect(result.terminal).toBe("reserved");
		expect(result.reservations).toHaveLength(2);
		expect(result.operatorGroups).toEqual(["g1", "g2"]);
	});

	it("skips malformed routing results and records a typed sanitized attempt", async () => {
		const malformed = {
			addresses: [wss("bad")],
			operatorGroup: "not valid whitespace",
			peerId: "bad",
			protocols: [],
			provenance: {},
		} as unknown as RelayCandidate;
		const { policy } = harness({
			limits: { requiredOperatorGroups: 1, requiredReservations: 1 },
			source: sourceOf([malformed, candidate("valid", "g1")]),
		});
		const result = await policy.acquire(QUERY, signal());
		expect(result.terminal).toBe("reserved");
		expect(result.attempts).toMatchObject([
			{ candidate: { peerId: "invalid-candidate-0" }, status: "invalid-candidate" },
			{ candidate: { peerId: "valid" }, status: "reserved" },
		]);
	});

	it("enforces WSS-only versus broad browser transport profiles", async () => {
		const candidates = [
			candidate("wt", "g1", webtransport("wt")),
			candidate("rtc", "g2", webrtc("rtc")),
			candidate("ws", "g3", wss("ws")),
		];
		const broad = harness({ source: sourceOf(candidates) });
		const wssOnly = harness({ source: sourceOf(candidates), transportProfile: RELAY_TRANSPORT_PROFILES.wssOnly });
		expect((await broad.policy.acquire(QUERY, signal())).terminal).toBe("reserved");
		const narrow = await wssOnly.policy.acquire(QUERY, signal());
		expect(narrow.terminal).toBe("exhausted");
		expect(narrow.reservations).toHaveLength(1);
		expect(narrow.attempts.filter(({ status }) => status === "no-compatible-address")).toHaveLength(2);
	});

	it.each([
		[50, "reserved"],
		[75, "reserved"],
		[90, "exhausted"],
	] as const)("handles seeded %s%% undialable candidates", async (percentage, terminal) => {
		const candidates = Array.from({ length: 10 }, (_, index) => candidate(`seed-${index}`, `g${index}`));
		const undialable = Math.floor((candidates.length * percentage) / 100);
		const outcomes = Object.fromEntries(
			candidates
				.slice(0, undialable)
				.map(({ peerId }) => [
					peerId,
					{ hopAdvertised: false, latencyMs: 1, outcome: "refused", protocols: [] } satisfies RelayInspection,
				])
		);
		const { policy } = harness({
			inspector: scriptedInspector(outcomes),
			limits: { maxCandidates: 10, maxQueuedCandidates: 10 },
			source: sourceOf(candidates),
		});
		expect((await policy.acquire(QUERY, signal())).terminal).toBe(terminal);
	});

	it("falls back to a live owned DNSADDR after every public reservation is refused", async () => {
		const reservationClient = scriptedReservation({
			a: { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED },
			b: { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED },
		});
		const { policy } = harness({
			fallback: {
				acquire: () =>
					Promise.resolve({
						address: "/dnsaddr/owned.example/p2p/owned",
						expiresAtMs: NOW + 60_000,
						status: "accepted",
					}),
			},
			reservationClient,
		});
		const result = await policy.acquire(QUERY, signal());
		expect(result).toMatchObject({
			fallback: { status: "accepted" },
			terminal: "owned-fallback",
		});
	});

	it("keeps public search and owned fallback inside one total deadline", async () => {
		let fallbackAborted = false;
		const { policy } = harness({
			fallback: {
				acquire: (fallbackSignal) =>
					new Promise((_, reject) => {
						fallbackSignal.addEventListener(
							"abort",
							() => {
								fallbackAborted = true;
								reject(fallbackSignal.reason);
							},
							{ once: true }
						);
					}),
			},
			limits: { ownedFallbackDeadlineMs: 15, totalDeadlineMs: 20 },
			reservationClient: scriptedReservation({
				a: { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED },
				b: { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED },
			}),
		});
		const started = performance.now();
		const result = await policy.acquire(QUERY, signal());
		expect(performance.now() - started).toBeLessThan(250);
		expect(fallbackAborted).toBe(true);
		expect(result).toMatchObject({ fallback: { status: "timeout" }, terminal: "exhausted" });
	});

	it("reports caller cancellation during owned fallback as aborted", async () => {
		const controller = new AbortController();
		const { policy } = harness({
			fallback: {
				acquire: (fallbackSignal) =>
					new Promise((_, reject) => {
						fallbackSignal.addEventListener("abort", () => reject(fallbackSignal.reason), { once: true });
					}),
			},
			limits: { ownedFallbackDeadlineMs: 80, totalDeadlineMs: 100 },
			reservationClient: scriptedReservation({
				a: { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED },
				b: { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED },
			}),
		});
		setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 5);
		const result = await policy.acquire(QUERY, controller.signal);
		expect(result).toMatchObject({ fallback: { status: "aborted" }, terminal: "aborted" });
	});

	it("rejects stale DNSADDR fallback evidence and terminates exhausted", async () => {
		const { policy } = harness({
			fallback: {
				acquire: () =>
					Promise.resolve({
						address: "/dnsaddr/stale.example/p2p/owned",
						expiresAtMs: NOW,
						status: "accepted",
					}),
			},
			reservationClient: scriptedReservation({
				a: { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED },
				b: { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED },
			}),
		});
		expect(await policy.acquire(QUERY, signal())).toMatchObject({
			fallback: { status: "stale" },
			terminal: "exhausted",
		});
	});

	it("refreshes reservations before expiry and replaces a refused refresh", async () => {
		const source = sourceOf([candidate("a", "g1"), candidate("b", "g2"), candidate("c", "g3")]);
		const reservationClient = scriptedReservation({});
		const { policy } = harness({
			limits: { maxCandidates: 3, maxQueuedCandidates: 3 },
			reservationClient,
			source,
		});
		await policy.acquire(QUERY, signal());
		reservationClient.responses.a = { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED };
		const result = await policy.refresh(signal());
		expect(result.terminal).toBe("reserved");
		expect(result.reservations.map(({ candidate: item }) => item.peerId).sort()).toEqual(["b", "c"]);
		expect(reservationClient.releaseCalls).toBeGreaterThanOrEqual(1);
	});

	it.each(["control-disconnected", "relay-disconnected", "expired"] as const)(
		"rotates on %s and reports the replacement reason",
		async (reason) => {
			const { policy } = harness({
				limits: { maxCandidates: 3, maxQueuedCandidates: 3 },
				source: sourceOf([candidate("a", "g1"), candidate("b", "g2"), candidate("c", "g3")]),
			});
			await policy.acquire(QUERY, signal());
			const result = await policy.replace("a", reason, signal());
			expect(result).toMatchObject({ reason, replacedPeerId: "a", terminal: "reserved" });
			expect(result.reservations.map(({ candidate: item }) => item.peerId).sort()).toEqual(["b", "c"]);
		}
	);

	it("serializes acquire/replace ownership and releases every reservation on stop", async () => {
		const { policy, reservationClient } = harness({
			limits: { maxCandidates: 3, maxQueuedCandidates: 3 },
			source: sourceOf([candidate("a", "g1"), candidate("b", "g2"), candidate("c", "g3")]),
		});
		await policy.acquire(QUERY, signal());
		await Promise.all([policy.replace("a", "relay-disconnected", signal()), policy.refresh(signal())]);
		await policy.stop();
		expect(policy.activeReservations).toEqual([]);
		expect(reservationClient.releaseCalls).toBeGreaterThanOrEqual(3);
		await expect(policy.acquire(QUERY, signal())).rejects.toThrow("RelayPolicy is stopped");
	});

	it("caps the lifecycle-operation queue", async () => {
		const { policy } = harness({
			limits: { requiredOperatorGroups: 1, requiredReservations: 1 },
			source: sourceOf([candidate("a", "g1")]),
		});
		const operations = Array.from({ length: 33 }, () => policy.acquire(QUERY, signal()));
		const results = await Promise.allSettled(operations);
		expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
		expect(results.at(-1)).toMatchObject({
			reason: expect.objectContaining({ message: "RelayPolicy operation queue is full (32)" }),
			status: "rejected",
		});
	});

	it("validates caps, queue, diversity, and transport invariants", () => {
		expect(() => harness({ limits: { requiredOperatorGroups: 3, requiredReservations: 2 } })).toThrow(
			"requiredOperatorGroups"
		);
		expect(() => harness({ limits: { maxQueuedCandidates: 1, requiredReservations: 2 } })).toThrow(
			"maxQueuedCandidates"
		);
		expect(() =>
			harness({
				transportProfile: { allowed: ["wss", "webtransport"], name: "wss-only" },
			})
		).toThrow("wss-only");
	});
});

describe("relay browser fixture", () => {
	it.each([
		["mixed", "broad-browser", "reserved", 2],
		["mixed", "wss-only", "exhausted", 1],
		["all-refused", "broad-browser", "owned-fallback", 0],
		["stale-fallback", "broad-browser", "exhausted", 0],
	] as const)("matches %s / %s deterministic evidence", async (scenario, profile, terminal, reservationCount) => {
		const result = await createRelayFixture(
			scenario,
			profile === "wss-only" ? RELAY_TRANSPORT_PROFILES.wssOnly : RELAY_TRANSPORT_PROFILES.broadBrowser
		);
		expect(result.assertions.filter(({ passed }) => !passed)).toEqual([]);
		expect(result).toMatchObject({ privateIdentifierFields: 0, reservationCount, terminal });
	});
});

function harness(
	options: {
		fallback?: DnsaddrFallback;
		inspector?: RelayInspector;
		limits?: ConstructorParameters<typeof RelayPolicy>[0]["limits"];
		reservationClient?: ScriptedReservationClient;
		source?: RelayCandidateSource;
		transportProfile?: ConstructorParameters<typeof RelayPolicy>[0]["transportProfile"];
	} = {}
): { policy: RelayPolicy; reservationClient: ScriptedReservationClient } {
	const reservationClient = options.reservationClient ?? scriptedReservation({});
	return {
		policy: new RelayPolicy({
			fallback: options.fallback ?? { acquire: () => Promise.resolve({ status: "empty" }) },
			inspector: options.inspector ?? scriptedInspector({}),
			limits: {
				maxCandidates: 32,
				maxConcurrentReservations: 2,
				maxPerOperatorGroup: 1,
				maxQueuedCandidates: 32,
				ownedFallbackDeadlineMs: 20,
				perCandidateDeadlineMs: 50,
				refreshBeforeExpiryMs: 120_000,
				requiredOperatorGroups: 2,
				requiredReservations: 2,
				totalDeadlineMs: 500,
				...options.limits,
			},
			now: () => NOW,
			reservationClient,
			source: options.source ?? sourceOf([candidate("a", "g1"), candidate("b", "g2")]),
			transportProfile: options.transportProfile,
		}),
		reservationClient,
	};
}

class ScriptedReservationClient implements RelayReservationClient {
	active = 0;
	maxActive = 0;
	refreshCalls = 0;
	releaseCalls = 0;
	reserveCalls = 0;
	readonly delayMs: number;
	readonly responses: Record<string, Error | RelayReservationWireResponse>;

	constructor(responses: Record<string, Error | RelayReservationWireResponse>, delayMs = 0) {
		this.responses = responses;
		this.delayMs = delayMs;
	}

	refresh(candidate: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse> {
		this.refreshCalls++;
		return this.run(candidate, signal);
	}

	release(): Promise<void> {
		this.releaseCalls++;
		return Promise.resolve();
	}

	reserve(candidate: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse> {
		this.reserveCalls++;
		return this.run(candidate, signal);
	}

	async run(candidate: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse> {
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
			if (signal.aborted) throw signal.reason;
			const response = this.responses[candidate.peerId];
			if (response instanceof Error) throw response;
			return (
				response ?? {
					limit: { data: 10_000, duration: 60 },
					reservation: { expire: Math.floor((NOW + 60_000) / 1_000) },
					status: RELAY_RESERVATION_STATUS.OK,
				}
			);
		} finally {
			this.active--;
		}
	}
}

function scriptedReservation(
	responses: Record<string, Error | RelayReservationWireResponse>,
	delayMs = 0
): ScriptedReservationClient {
	return new ScriptedReservationClient(responses, delayMs);
}

function scriptedInspector(outcomes: Record<string, RelayInspection>): RelayInspector {
	return {
		inspect(candidate): Promise<RelayInspection> {
			return Promise.resolve(outcomes[candidate.peerId] ?? connected());
		},
	};
}

function connected(): RelayInspection {
	return {
		connectionId: "fixture-connection",
		hopAdvertised: true,
		latencyMs: 1,
		outcome: "connected",
		protocols: ["/ipfs/id/1.0.0", CIRCUIT_RELAY_V2_HOP_PROTOCOL],
	};
}

function sourceOf(candidates: readonly RelayCandidate[]): RelayCandidateSource {
	return {
		async *getCandidates(): AsyncIterable<RelayCandidate> {
			await Promise.resolve();
			yield* candidates;
		},
	};
}

async function collect(source: RelayCandidateSource): Promise<RelayCandidate[]> {
	const output: RelayCandidate[] = [];
	for await (const candidateItem of source.getCandidates(QUERY, signal())) output.push(candidateItem);
	return output;
}

function candidate(peerId: string, operatorGroup: string, address = wss(peerId)): RelayCandidate {
	return {
		addresses: [address],
		operatorGroup,
		peerId,
		protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
		provenance: {
			origin: "browser-closest-peers",
			queryDigest: "query_5734a87d",
			resultIndex: Number(peerId.replace(/\D/gu, "")) || 0,
			routingSource: "delegated-routing",
		},
	};
}

function nodePeer(peerId: string): RoutingPeer {
	return {
		addresses: [wss(peerId)],
		addressDecisions: [],
		inputAddressCount: 1,
		peerId,
		truncatedAddressCount: 0,
	};
}

function browserPeer(peerId: string, address: string): BrowserRoutingPeer {
	return {
		acceptedAddresses: [address],
		addressDecisions: [],
		inputAddressCount: 1,
		peerId,
		protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
		rawAddresses: [address],
		truncatedAddressCount: 0,
	};
}

function wss(peerId: string): string {
	return `/dns4/${peerId}.example/tcp/443/wss/p2p/${peerId}`;
}

function webtransport(peerId: string): string {
	return `/dns4/${peerId}.example/udp/443/quic-v1/webtransport/p2p/${peerId}`;
}

function webrtc(peerId: string): string {
	return `/dns4/${peerId}.example/udp/443/webrtc-direct/p2p/${peerId}`;
}

function signal(): AbortSignal {
	return AbortSignal.timeout(2_000);
}

function validRelayCandidate(): RelayCandidate {
	return candidate(
		"QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
		"fixture",
		"/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN"
	);
}

function relayClientWith(options: { readonly connection: boolean; readonly protocols: string[] }): Libp2pRelayClient {
	return new Libp2pRelayClient({
		connect: (): Promise<void> => Promise.resolve(),
		disconnect: (): Promise<void> => Promise.resolve(),
		host: {
			components: { transportManager: { getListeners: () => [], listen: () => Promise.resolve() } },
			getConnections: () => (options.connection ? [{ id: "connection-1" }] : []),
			getMultiaddrs: () => [],
			peerStore: { get: () => Promise.resolve({ protocols: options.protocols }) },
		} as never,
		identifyTimeoutMs: 1,
		reservationTimeoutMs: 1,
	});
}

function protobufMessage(...fields: Uint8Array[]): Uint8Array {
	const length = fields.reduce((total, field) => total + field.byteLength, 0);
	const output = new Uint8Array(length);
	let offset = 0;
	for (const field of fields) {
		output.set(field, offset);
		offset += field.byteLength;
	}
	return output;
}

function protobufBytes(field: number, value: Uint8Array): Uint8Array {
	return protobufMessage(encodeVarint(BigInt((field << 3) | 2)), encodeVarint(BigInt(value.byteLength)), value);
}

function protobufVarint(field: number, value: bigint): Uint8Array {
	return protobufMessage(encodeVarint(BigInt(field << 3)), encodeVarint(value));
}

function encodeVarint(input: bigint): Uint8Array {
	const bytes: number[] = [];
	let value = input;
	do {
		let byte = Number(value & BigInt(0x7f));
		value >>= BigInt(7);
		if (value > BigInt(0)) byte |= 0x80;
		bytes.push(byte);
	} while (value > BigInt(0));
	return Uint8Array.from(bytes);
}
