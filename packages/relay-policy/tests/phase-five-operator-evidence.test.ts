import {
	CIRCUIT_RELAY_V2_HOP_PROTOCOL,
	RELAY_RESERVATION_STATUS,
	type RelayCandidate,
	type RelayCandidateSource,
	type RelayInspector,
	RelayPolicy,
	type RelayReservationClient,
} from "@ts-drp/relay-policy";
import * as relayPolicy from "@ts-drp/relay-policy";
import { describe, expect, it, vi } from "vitest";

const NOW = 1_750_000_000_000;
const QUERY = Uint8Array.from([1, 2, 3, 4]);

interface OperatorEvidence {
	readonly credential: string;
	readonly signedRecordDigest: string;
}

interface EvidenceCandidate extends RelayCandidate {
	readonly advertisedOperatorGroup?: string;
	readonly operatorEvidence?: OperatorEvidence;
}

interface OperatorGroupClassifier {
	classify(candidate: EvidenceCandidate, signal: AbortSignal): Promise<string>;
}

type EvidenceDerivedOperatorGroupClassifierConstructor = new (options: {
	verify(
		evidence: OperatorEvidence,
		signal: AbortSignal
	): Promise<{ readonly operatorGroup?: string; readonly verified: boolean }>;
}) => OperatorGroupClassifier;

describe("Phase 5 evidence-derived relay operator groups", () => {
	it("exports a classifier that ignores an unverified advertised operator label", async () => {
		const verify = vi.fn();
		const classifier = classifierFrom({ verify });
		const advertised = evidenceCandidate("relay-a", "advertised:independent-a");

		await expect(classifier.classify(advertised, new AbortController().signal)).resolves.toBe("unknown");
		expect(verify).toHaveBeenCalledTimes(0);
	});

	it("uses a verifier-backed group from signed-record evidence instead of the advertised label", async () => {
		const controller = new AbortController();
		const verify = vi.fn((evidence: OperatorEvidence, signal: AbortSignal) => {
			expect(signal).toBe(controller.signal);
			expect(evidence).toEqual({
				credential: "operator-a",
				signedRecordDigest: "sha256:signed-record-relay-a",
			});
			return Promise.resolve({ operatorGroup: "verified:operator-a", verified: true });
		});
		const classifier = classifierFrom({ verify });
		const evidenced = evidenceCandidate("relay-a", "advertised:fake-group", "operator-a");

		await expect(classifier.classify(evidenced, controller.signal)).resolves.toBe("verified:operator-a");
		expect(verify).toHaveBeenCalledTimes(1);
	});

	it("collapses distinct unverified advertisements into one group at the diversity gate", async () => {
		const classifier: OperatorGroupClassifier = {
			classify: (candidate): Promise<string> =>
				Promise.resolve(candidate.operatorEvidence === undefined ? "unknown" : candidate.operatorGroup),
		};
		const policy = policyWith(
			[evidenceCandidate("relay-a", "advertised:operator-a"), evidenceCandidate("relay-b", "advertised:operator-b")],
			classifier
		);

		try {
			const result = await policy.acquire(QUERY, new AbortController().signal);

			expect(result.terminal).toBe("exhausted");
			expect(result.reservations).toHaveLength(1);
			expect(result.operatorGroups).toEqual(["unknown"]);
		} finally {
			await expect(policy.stop()).resolves.toBeUndefined();
		}
	});

	it("accepts two distinct evidence-backed groups and reaches the two-reservation diversity target", async () => {
		const classifier: OperatorGroupClassifier = {
			classify: (candidate): Promise<string> => {
				const credential = candidate.operatorEvidence?.credential;
				return Promise.resolve(credential === undefined ? "unknown" : `verified:${credential}`);
			},
		};
		const policy = policyWith(
			[
				evidenceCandidate("relay-a", "same-untrusted-advertisement", "operator-a"),
				evidenceCandidate("relay-b", "same-untrusted-advertisement", "operator-b"),
			],
			classifier
		);

		try {
			const result = await policy.acquire(QUERY, new AbortController().signal);

			expect(result.terminal).toBe("reserved");
			expect(result.reservations).toHaveLength(2);
			expect(result.operatorGroups).toEqual(["verified:operator-a", "verified:operator-b"]);
		} finally {
			await expect(policy.stop()).resolves.toBeUndefined();
		}
	});
});

function classifierFrom(options: {
	verify(
		evidence: OperatorEvidence,
		signal: AbortSignal
	): Promise<{ readonly operatorGroup?: string; readonly verified: boolean }>;
}): OperatorGroupClassifier {
	const Constructor = (
		relayPolicy as unknown as {
			EvidenceDerivedOperatorGroupClassifier?: EvidenceDerivedOperatorGroupClassifierConstructor;
		}
	).EvidenceDerivedOperatorGroupClassifier;
	expect(
		Constructor,
		"Phase 5 must export EvidenceDerivedOperatorGroupClassifier so advertisements cannot self-assign diversity"
	).toBeTypeOf("function");
	if (Constructor === undefined) throw new Error("EvidenceDerivedOperatorGroupClassifier is not exported");
	return new Constructor(options);
}

function policyWith(
	candidates: readonly EvidenceCandidate[],
	operatorGroupClassifier: OperatorGroupClassifier
): RelayPolicy {
	const source: RelayCandidateSource = {
		async *getCandidates(): AsyncIterable<RelayCandidate> {
			await Promise.resolve();
			yield* candidates;
		},
	};
	const inspector: RelayInspector = {
		inspect: (): Promise<{
			connectionId: string;
			hopAdvertised: true;
			latencyMs: number;
			outcome: "connected";
			protocols: string[];
		}> =>
			Promise.resolve({
				connectionId: "fixture-connection",
				hopAdvertised: true,
				latencyMs: 1,
				outcome: "connected",
				protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
			}),
	};
	const reservationClient: RelayReservationClient = {
		refresh: () => Promise.resolve(okReservation()),
		release: () => Promise.resolve(),
		reserve: () => Promise.resolve(okReservation()),
	};
	const options = {
		inspector,
		limits: {
			maxCandidates: 8,
			maxConcurrentReservations: 2,
			maxPerOperatorGroup: 1,
			maxQueuedCandidates: 8,
			ownedFallbackDeadlineMs: 10,
			perCandidateDeadlineMs: 50,
			refreshBeforeExpiryMs: 30_000,
			requiredOperatorGroups: 2,
			requiredReservations: 2,
			totalDeadlineMs: 250,
		},
		now: () => NOW,
		operatorGroupClassifier,
		reservationClient,
		source,
	} as ConstructorParameters<typeof RelayPolicy>[0] & { readonly operatorGroupClassifier: OperatorGroupClassifier };
	return new RelayPolicy(options);
}

function evidenceCandidate(peerId: string, advertisedOperatorGroup: string, credential?: string): EvidenceCandidate {
	return {
		addresses: [`/dns4/${peerId}.example.test/tcp/443/wss/p2p/${peerId}`],
		advertisedOperatorGroup,
		operatorGroup: advertisedOperatorGroup,
		...(credential === undefined
			? {}
			: { operatorEvidence: { credential, signedRecordDigest: `sha256:signed-record-${peerId}` } }),
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

function okReservation(): { readonly reservation: { readonly expire: number }; readonly status: number } {
	return {
		reservation: { expire: Math.floor((NOW + 60_000) / 1_000) },
		status: RELAY_RESERVATION_STATUS.OK,
	};
}
