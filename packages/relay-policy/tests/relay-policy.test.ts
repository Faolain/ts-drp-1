import {
	CIRCUIT_RELAY_V2_HOP_PROTOCOL,
	decodeRelayReservationResponse,
	RELAY_RESERVATION_STATUS,
	type RelayCandidate,
	type RelayCandidateSource,
	type RelayInspection,
	type RelayInspector,
	RelayPolicy,
	type RelayReservationClient,
	type RelayReservationWireResponse,
} from "@ts-drp/relay-policy";
import { describe, expect, it } from "vitest";

const NOW = 1_750_000_000_000;
const QUERY = Uint8Array.from([1, 2, 3, 4]);

describe("Circuit Relay v2 reservation verification", () => {
	it("accepts only STATUS:OK with a live reservation and preserves resource limits", () => {
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

	it("does not turn HOP support or an expired/missing reservation into acceptance", () => {
		expect(decodeRelayReservationResponse({ status: RELAY_RESERVATION_STATUS.OK }, NOW)).toEqual({
			accepted: false,
			failure: "malformed-response",
		});
		expect(
			decodeRelayReservationResponse(
				{
					reservation: { expire: BigInt(Math.floor(NOW / 1_000)) },
					status: RELAY_RESERVATION_STATUS.OK,
				},
				NOW
			)
		).toEqual({ accepted: false, failure: "no-reservation" });
	});
});

describe("bounded relay policy", () => {
	it("caps and deduplicates RelayCandidateSource results before reservation work", async () => {
		const source = sourceOf([candidate("a", "g1"), candidate("a", "g1"), candidate("b", "g2"), candidate("c", "g3")]);
		const { policy } = harness({ limits: { maxCandidates: 2, maxQueuedCandidates: 2 }, source });
		const result = await policy.acquire(QUERY, signal());
		expect(result.candidatesObserved).toBe(2);
		expect(result.terminal).toBe("reserved");
	});

	it("measures unsupported HOP separately and never sends RESERVE", async () => {
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

	it("reserves two candidates from distinct operator groups", async () => {
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

	it("refreshes before expiry and replaces a refused refresh", async () => {
		const reservationClient = scriptedReservation({});
		const { policy } = harness({
			limits: { maxCandidates: 3, maxQueuedCandidates: 3 },
			reservationClient,
			source: sourceOf([candidate("a", "g1"), candidate("b", "g2"), candidate("c", "g3")]),
		});
		await policy.acquire(QUERY, signal());
		reservationClient.responses.a = { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED };
		const result = await policy.refresh(signal());
		expect(result.terminal).toBe("reserved");
		expect(result.reservations.map(({ candidate: item }) => item.peerId).sort()).toEqual(["b", "c"]);
		expect(reservationClient.releaseCalls).toBeGreaterThanOrEqual(1);
	});

	it("rotates a disconnected reservation and reports the replacement reason", async () => {
		const { policy } = harness({
			limits: { maxCandidates: 3, maxQueuedCandidates: 3 },
			source: sourceOf([candidate("a", "g1"), candidate("b", "g2"), candidate("c", "g3")]),
		});
		await policy.acquire(QUERY, signal());
		const result = await policy.replace("a", "relay-disconnected", signal());
		expect(result).toMatchObject({
			reason: "relay-disconnected",
			replacedPeerId: "a",
			terminal: "reserved",
		});
		expect(result.reservations.map(({ candidate: item }) => item.peerId).sort()).toEqual(["b", "c"]);
	});
});

function harness(
	options: {
		inspector?: RelayInspector;
		limits?: ConstructorParameters<typeof RelayPolicy>[0]["limits"];
		reservationClient?: ScriptedReservationClient;
		source?: RelayCandidateSource;
	} = {}
): { policy: RelayPolicy; reservationClient: ScriptedReservationClient } {
	const reservationClient = options.reservationClient ?? scriptedReservation({});
	return {
		policy: new RelayPolicy({
			fallback: { acquire: (): Promise<{ status: "empty" }> => Promise.resolve({ status: "empty" }) },
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
	readonly responses: Record<string, Error | RelayReservationWireResponse>;

	constructor(responses: Record<string, Error | RelayReservationWireResponse>) {
		this.responses = responses;
	}

	refresh(candidateItem: RelayCandidate, attemptSignal: AbortSignal): Promise<RelayReservationWireResponse> {
		this.refreshCalls++;
		return this.run(candidateItem, attemptSignal);
	}

	release(): Promise<void> {
		this.releaseCalls++;
		return Promise.resolve();
	}

	reserve(candidateItem: RelayCandidate, attemptSignal: AbortSignal): Promise<RelayReservationWireResponse> {
		this.reserveCalls++;
		return this.run(candidateItem, attemptSignal);
	}

	async run(candidateItem: RelayCandidate, attemptSignal: AbortSignal): Promise<RelayReservationWireResponse> {
		await Promise.resolve();
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			attemptSignal.throwIfAborted();
			const response = this.responses[candidateItem.peerId];
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
	responses: Record<string, Error | RelayReservationWireResponse>
): ScriptedReservationClient {
	return new ScriptedReservationClient(responses);
}

function scriptedInspector(outcomes: Record<string, RelayInspection>): RelayInspector {
	return {
		inspect(candidateItem): Promise<RelayInspection> {
			return Promise.resolve(outcomes[candidateItem.peerId] ?? connected());
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

function candidate(peerId: string, operatorGroup: string): RelayCandidate {
	return {
		addresses: [`/dns4/${peerId}.example/tcp/443/wss/p2p/${peerId}`],
		operatorGroup,
		peerId,
		protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
		provenance: {
			origin: "browser-closest-peers",
			queryDigest: "query_5734a87d",
			resultIndex: 0,
			routingSource: "delegated-routing",
		},
	};
}

function signal(): AbortSignal {
	return new AbortController().signal;
}
