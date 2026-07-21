import {
	CIRCUIT_RELAY_V2_HOP_PROTOCOL,
	CompositeRelayCandidateSource,
	ConfiguredFallbackRelaySource,
	EvidenceDerivedOperatorGroupClassifier,
	RELAY_RESERVATION_STATUS,
	type RelayCandidate,
	type RelayCandidateSource,
	type RelayInspector,
	RelayPolicy,
	type RelayReservationClient,
	type RelayReservationLifecycleEvent,
} from "@ts-drp/relay-policy";
import type { SignedDrpRecordV1 } from "@ts-drp/rendezvous";
import { describe, expect, it, vi } from "vitest";

const NOW = 1_750_000_000_000;
const QUERY = Uint8Array.from([1, 2, 3, 4]);

describe("Phase 5 relay-policy regressions", () => {
	it("keeps an owned candidate when a later enabled child source throws", async () => {
		let throwingIteratorClosed = false;
		const source = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 1,
			sources: [
				{ enabled: true, name: "owned", priority: "primary", source: sourceOf([attested("owned", "verified:owned")]) },
				{
					enabled: true,
					name: "registry",
					priority: "primary",
					source: {
						async *getCandidates(): AsyncIterable<RelayCandidate> {
							try {
								await Promise.resolve();
								throw new Error("registry unavailable");
							} finally {
								throwingIteratorClosed = true;
							}
						},
					},
				},
			],
		});
		const policy = createPolicy(source, { requiredOperatorGroups: 1, requiredReservations: 1 });

		try {
			await expect(policy.acquire(QUERY, new AbortController().signal)).resolves.toMatchObject({
				reservations: [{ candidate: { peerId: "owned" } }],
				terminal: "reserved",
			});
			expect(throwingIteratorClosed).toBe(true);
		} finally {
			await policy.stop();
		}
	});

	it("rethrows AbortError from a child source and closes its iterator", async () => {
		let closed = false;
		const source = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 1,
			sources: [
				{
					enabled: true,
					name: "aborting",
					priority: "primary",
					source: {
						async *getCandidates(): AsyncIterable<RelayCandidate> {
							try {
								await Promise.resolve();
								throw new DOMException("cancelled", "AbortError");
							} finally {
								closed = true;
							}
						},
					},
				},
			],
		});

		await expect(collect(source)).rejects.toMatchObject({ name: "AbortError" });
		expect(closed).toBe(true);
	});

	it("preserves distinct configured evidence through the real classifier", async () => {
		const classifier = new EvidenceDerivedOperatorGroupClassifier({
			verify: vi.fn(() => Promise.reject(new Error("pre-verified configured evidence must not be reverified"))),
		});
		const source = new ConfiguredFallbackRelaySource({
			entries: [configuredEntry("owned-a", "verified:owned-a"), configuredEntry("owned-b", "verified:owned-b")],
		});
		const policy = createPolicy(source, { operatorGroupClassifier: classifier });

		try {
			const result = await policy.acquire(QUERY, new AbortController().signal);
			expect(result.terminal).toBe("reserved");
			expect(result.reservations).toHaveLength(2);
			expect(result.operatorGroups).toEqual(["verified:owned-a", "verified:owned-b"]);
		} finally {
			await policy.stop();
		}
	});

	it("does not count unknown reservations as operator diversity", async () => {
		const candidates = [
			attested("owned-a", "verified:owned-a"),
			...Array.from({ length: 50 }, (_, index) => candidate(`registry-${index}`, "unknown", "registry-relay-record")),
		];
		const classifier = new EvidenceDerivedOperatorGroupClassifier({
			verify: () => Promise.resolve({ verified: false }),
		});
		const policy = createPolicy(sourceOf(candidates), {
			maxCandidates: 64,
			maxQueuedCandidates: 64,
			operatorGroupClassifier: classifier,
		});

		try {
			const result = await policy.acquire(QUERY, new AbortController().signal);
			expect(result.terminal).toBe("exhausted");
			expect(result.operatorGroups).toEqual(["unknown", "verified:owned-a"]);
			expect(result.reservations).toHaveLength(2);
		} finally {
			await policy.stop();
		}
	});

	it("bounds classifier failures per candidate and continues collection", async () => {
		const classifier = {
			classify(item: RelayCandidate, signal: AbortSignal): Promise<string> {
				if (item.peerId === "bad-evidence") {
					return new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				}
				return Promise.resolve("verified:good");
			},
		};
		const policy = createPolicy(
			sourceOf([candidate("bad-evidence", "advertised:a"), candidate("good-evidence", "advertised:b")]),
			{
				operatorGroupClassifier: classifier,
				perCandidateDeadlineMs: 10,
				requiredOperatorGroups: 1,
				requiredReservations: 1,
			}
		);

		try {
			const result = await policy.acquire(QUERY, new AbortController().signal);
			expect(result.terminal).toBe("reserved");
			expect(result.reservations.some(({ candidate: item }) => item.peerId === "good-evidence")).toBe(true);
		} finally {
			await policy.stop();
		}
	});

	it("does not let an invalid duplicate suppress a later valid candidate", async () => {
		const invalid = { ...candidate("same-peer", "verified:bad"), addresses: Array.from({ length: 33 }, () => "/bad") };
		const composite = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 1,
			sources: [
				{ enabled: true, name: "bad", priority: "primary", source: sourceOf([invalid]) },
				{
					enabled: true,
					name: "good",
					priority: "primary",
					source: sourceOf([attested("same-peer", "verified:good")]),
				},
			],
		});
		const policy = createPolicy(composite, { requiredOperatorGroups: 1, requiredReservations: 1 });

		try {
			const result = await policy.acquire(QUERY, new AbortController().signal);
			expect(result.terminal).toBe("reserved");
			expect(result.attempts).toMatchObject([
				{ status: "invalid-candidate" },
				{ candidate: { peerId: "same-peer" }, status: "reserved" },
			]);
		} finally {
			await policy.stop();
		}
	});

	it("emits replacement telemetry only for a newly acquired relay", async () => {
		const failedEvents: RelayReservationLifecycleEvent[] = [];
		const failed = createPolicy(sourceOf([attested("a", "g1"), attested("b", "g2")]), {
			onReservationEvent: (event) => void failedEvents.push(event),
		});
		try {
			await failed.acquire(QUERY, new AbortController().signal);
			failedEvents.length = 0;
			await failed.replace("a", "relay-disconnected", new AbortController().signal);
			expect(failedEvents.some(({ outcome }) => outcome === "replaced")).toBe(false);
		} finally {
			await failed.stop();
		}

		const successEvents: RelayReservationLifecycleEvent[] = [];
		const success = createPolicy(sourceOf([attested("a", "g1"), attested("b", "g2"), attested("c", "g3")]), {
			maxCandidates: 3,
			maxQueuedCandidates: 3,
			maxConcurrentReservations: 1,
			onReservationEvent: (event) => void successEvents.push(event),
		});
		try {
			await success.acquire(QUERY, new AbortController().signal);
			successEvents.length = 0;
			await success.replace("a", "relay-disconnected", new AbortController().signal);
			expect(successEvents.filter(({ outcome }) => outcome === "replaced")).toEqual([
				{ outcome: "replaced", relayId: "c", replacedRelayId: "a" },
			]);
		} finally {
			await success.stop();
		}
	});
});

function createPolicy(
	source: RelayCandidateSource,
	overrides: Partial<ConstructorParameters<typeof RelayPolicy>[0]["limits"]> &
		Pick<ConstructorParameters<typeof RelayPolicy>[0], "onReservationEvent" | "operatorGroupClassifier"> = {}
): RelayPolicy {
	const inspector: RelayInspector = {
		inspect: () =>
			Promise.resolve({
				connectionId: "fixture",
				hopAdvertised: true,
				latencyMs: 1,
				outcome: "connected" as const,
				protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
			}),
	};
	const reservationClient: RelayReservationClient = {
		refresh: () => Promise.resolve(okReservation()),
		release: () => Promise.resolve(),
		reserve: () => Promise.resolve(okReservation()),
	};
	const { onReservationEvent, operatorGroupClassifier, ...limitOverrides } = overrides;
	return new RelayPolicy({
		inspector,
		limits: {
			maxCandidates: 32,
			maxConcurrentReservations: 2,
			maxPerOperatorGroup: 1,
			maxQueuedCandidates: 32,
			ownedFallbackDeadlineMs: 10,
			perCandidateDeadlineMs: 50,
			refreshBeforeExpiryMs: 30_000,
			requiredOperatorGroups: 2,
			requiredReservations: 2,
			totalDeadlineMs: 500,
			...limitOverrides,
		},
		now: () => NOW,
		onReservationEvent,
		operatorGroupClassifier,
		reservationClient,
		source,
	});
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
	for await (const item of source.getCandidates(QUERY, new AbortController().signal)) output.push(item);
	return output;
}

function attested(peerId: string, operatorGroup: string): RelayCandidate {
	return {
		...candidate(peerId, operatorGroup, "configured-fallback"),
		operatorEvidence: { credentialDigest: `sha256:${peerId}`, operatorGroup, verified: true },
	};
}

function candidate(
	peerId: string,
	operatorGroup: string,
	origin: RelayCandidate["provenance"]["origin"] = "browser-closest-peers"
): RelayCandidate {
	const routingSource =
		origin === "configured-fallback"
			? "configured"
			: origin === "registry-relay-record"
				? "registry"
				: "delegated-routing";
	return {
		addresses: [`/dns4/${peerId}.example.test/tcp/443/wss/p2p/${peerId}`],
		operatorGroup,
		peerId,
		protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
		provenance: { origin, queryDigest: "query_5734a87d", resultIndex: 0, routingSource },
	};
}

function configuredEntry(peerId: string, operatorGroup: string): {
	readonly operatorEvidence: { readonly credentialDigest: string; readonly operatorGroup: string; readonly verified: true };
	readonly record: SignedDrpRecordV1;
} {
	return {
		operatorEvidence: { credentialDigest: `sha256:${peerId}`, operatorGroup, verified: true },
		record: {
			addresses: [`/dns4/${peerId}.example.test/tcp/443/wss/p2p/${peerId}`],
			capabilities: ["relay-hop-v2-service"],
			expiresAtMs: NOW + 60_000,
			issuedAtMs: NOW,
			kind: "ts-drp-rendezvous-record",
			namespace: "drp-relays:v1:fixture-network",
			peerId,
			publicKey: `public-${peerId}`,
			sequence: 1,
			signature: `signature-${peerId}`,
			version: 1,
		},
	};
}

function okReservation(): { readonly reservation: { readonly expire: number }; readonly status: number } {
	return {
		reservation: { expire: Math.floor((NOW + 60_000) / 1_000) },
		status: RELAY_RESERVATION_STATUS.OK,
	};
}
