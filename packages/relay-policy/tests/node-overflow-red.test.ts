import {
	CIRCUIT_RELAY_V2_HOP_PROTOCOL,
	CompositeRelayCandidateSource,
	EvidenceDerivedOperatorGroupClassifier,
	RELAY_RESERVATION_STATUS,
	type RelayCandidate,
	type RelayCandidateSource,
	type RelayInspection,
	type RelayInspector,
	RelayPolicy,
	type RelayReservationClient,
	type RelayReservationWireResponse,
} from "@ts-drp/relay-policy";
import { describe, expect, it, vi } from "vitest";

const NOW = 1_750_000_000_000;
const QUERY = Uint8Array.from([9, 8, 7, 6]);

describe("node relay overflow RED contracts", () => {
	it.each([
		["node-connected-hop", "connected-peers"],
		["configured-relay", "configured"],
	] as const)("preserves %s provenance when sanitizing an invalid candidate", async (origin, routingSource) => {
		const malformed = {
			addresses: Array.from({ length: 33 }, () => "/bad"),
			operatorGroup: "unknown",
			peerId: "malformed",
			protocols: [],
			provenance: { origin, queryDigest: "untrusted", resultIndex: 99, routingSource },
		} as unknown as RelayCandidate;
		const policy = createPolicy(sourceOf([malformed]), {
			requiredOperatorGroups: 1,
			requiredReservations: 1,
		});

		try {
			const result = await policy.acquire(QUERY, AbortSignal.timeout(1_000));
			expect(result.attempts).toContainEqual(
				expect.objectContaining({
					candidate: expect.objectContaining({ provenance: expect.objectContaining({ origin, routingSource }) }),
					status: "invalid-candidate",
				})
			);
		} finally {
			await policy.stop();
		}
	});

	it("accepts the 60s total deadline needed by a public Amino walk", async () => {
		const policy = createPolicy(sourceOf([]), { totalDeadlineMs: 60_000 });
		await policy.stop();
	});

	it("preserves and attempts a primary candidate collected before the source deadline", async () => {
		const reserve = vi.fn(() => Promise.resolve(okReservation()));
		const slowOverflow: RelayCandidateSource = {
			async *getCandidates(_queryKey, signal): AsyncIterable<RelayCandidate> {
				yield candidate("primary-fast", "verified:primary", "configured-fallback");
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		};
		const policy = createPolicy(
			slowOverflow,
			{
				perCandidateDeadlineMs: 10,
				requiredOperatorGroups: 1,
				requiredReservations: 1,
				totalDeadlineMs: 25,
			},
			reserve
		);

		try {
			const result = await policy.acquire(QUERY, AbortSignal.timeout(1_000));
			expect(reserve).toHaveBeenCalledWith(
				expect.objectContaining({ peerId: "primary-fast" }),
				expect.any(AbortSignal)
			);
			expect(result.attempts).toContainEqual(
				expect.objectContaining({ candidate: expect.objectContaining({ peerId: "primary-fast" }) })
			);
		} finally {
			await policy.stop();
		}
	});

	it("consults node overflow after diverse primary candidates are all offline", async () => {
		const overflowStarted = vi.fn();
		const source = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 2,
			sources: [
				{
					enabled: true,
					name: "configured",
					priority: "primary",
					source: sourceOf([
						attested("primary-a", "verified:primary-a", "configured-fallback"),
						attested("primary-b", "verified:primary-b", "configured-fallback"),
					]),
				},
				{
					degradedOverflowEligible: true,
					enabled: true,
					name: "node-closest-peers",
					priority: "overflow",
					source: trackedSource(overflowStarted, [
						attested("node-a", "verified:node-a", "node-connected-hop"),
						attested("node-b", "verified:node-b", "node-connected-hop"),
					]),
				},
			],
		});
		const policy = createPolicy(source, {}, undefined, {}, new Set(["primary-a", "primary-b"]));

		try {
			const result = await policy.acquire(QUERY, AbortSignal.timeout(1_000));
			expect(overflowStarted).toHaveBeenCalledOnce();
			expect(result.terminal).toBe("reserved");
			expect(result.reservations.map(({ candidate: item }) => item.peerId).sort()).toEqual(["node-a", "node-b"]);
		} finally {
			await policy.stop();
		}
	});

	it("accepts anonymous overflow relays as a degraded target without weakening verified primary diversity", async () => {
		const healthyOverflowStarted = vi.fn();
		const healthyPrimarySource = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 2,
			sources: [
				{
					enabled: true,
					name: "configured",
					priority: "primary",
					source: sourceOf([
						attested("verified-primary-a", "verified:primary-a", "configured-fallback"),
						attested("verified-primary-b", "verified:primary-b", "configured-fallback"),
					]),
				},
				{
					degradedOverflowEligible: true,
					enabled: true,
					name: "node-closest-peers",
					priority: "overflow",
					source: trackedSource(healthyOverflowStarted, [candidate("must-not-walk", "unknown", "node-connected-hop")]),
				},
			],
		});
		const healthyPrimaryPolicy = createPolicy(healthyPrimarySource);
		try {
			const primaryResult = await healthyPrimaryPolicy.acquire(QUERY, AbortSignal.timeout(1_000));
			expect(primaryResult.terminal).toBe("reserved");
			expect(primaryResult.operatorGroups).toEqual(["verified:primary-a", "verified:primary-b"]);
			expect(healthyOverflowStarted).not.toHaveBeenCalled();
		} finally {
			await healthyPrimaryPolicy.stop();
		}

		const degradedOverflowStarted = vi.fn();
		const degradedSource = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 2,
			sources: [
				{
					enabled: true,
					name: "configured",
					priority: "primary",
					source: sourceOf([]),
				},
				{
					degradedOverflowEligible: true,
					enabled: true,
					name: "node-closest-peers",
					priority: "overflow",
					source: trackedSource(degradedOverflowStarted, [
						candidate("anonymous-overflow-a", "unknown", "node-connected-hop"),
						candidate("anonymous-overflow-b", "unknown", "node-connected-hop"),
					]),
				},
			],
		});
		const degradedPolicy = createPolicy(degradedSource);
		try {
			const first = await degradedPolicy.acquire(QUERY, AbortSignal.timeout(1_000));
			expect(first.terminal).toBe("reserved");
			expect(first.reservations.map(({ candidate: item }) => item.peerId).sort()).toEqual([
				"anonymous-overflow-a",
				"anonymous-overflow-b",
			]);
			expect(first.operatorGroups).toEqual(["unknown"]);

			const second = await degradedPolicy.acquire(QUERY, AbortSignal.timeout(1_000));
			expect(second.terminal).toBe("reserved");
			expect(degradedOverflowStarted).toHaveBeenCalledOnce();
		} finally {
			await degradedPolicy.stop();
		}
	});

	it("reports an aborted acquisition before short-circuiting on existing degraded reservations", async () => {
		const source = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 2,
			sources: [
				{
					degradedOverflowEligible: true,
					enabled: true,
					name: "node-closest-peers",
					priority: "overflow",
					source: sourceOf([
						candidate("abort-existing-a", "unknown", "node-connected-hop"),
						candidate("abort-existing-b", "unknown", "node-connected-hop"),
					]),
				},
			],
		});
		const policy = createPolicy(source);

		try {
			await expect(policy.acquire(QUERY, AbortSignal.timeout(1_000))).resolves.toMatchObject({ terminal: "reserved" });
			const controller = new AbortController();
			controller.abort(new Error("caller cancelled"));
			await expect(policy.acquire(QUERY, controller.signal)).resolves.toMatchObject({ terminal: "aborted" });
		} finally {
			await policy.stop();
		}
	});

	it("relaxes anonymous diversity only for candidates collected from the actual overflow phase", async () => {
		const overflowStarted = vi.fn();
		const source = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 2,
			sources: [
				{
					enabled: true,
					name: "configured",
					priority: "primary",
					source: sourceOf([
						candidate("anonymous-primary-a", "unknown", "node-connected-hop"),
						candidate("anonymous-primary-b", "unknown", "node-connected-hop"),
					]),
				},
				{
					degradedOverflowEligible: true,
					enabled: true,
					name: "node-closest-peers",
					priority: "overflow",
					source: trackedSource(overflowStarted, [candidate("anonymous-overflow", "unknown", "node-connected-hop")]),
				},
			],
		});
		const policy = createPolicy(source);

		try {
			const result = await policy.acquire(QUERY, AbortSignal.timeout(1_000));
			expect(overflowStarted).toHaveBeenCalledOnce();
			expect(result.terminal).toBe("reserved");
			expect(result.reservations.map(({ candidate: item }) => item.peerId).sort()).toEqual([
				"anonymous-overflow",
				"anonymous-primary-a",
			]);
		} finally {
			await policy.stop();
		}
	});

	it("relaxes anonymous diversity only for overflow sources explicitly marked degraded-eligible", async () => {
		const source = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 2,
			sources: [
				{
					enabled: true,
					name: "configured",
					priority: "primary",
					source: sourceOf([]),
				},
				{
					degradedOverflowEligible: false,
					enabled: true,
					name: "delegated-closest-peers",
					priority: "overflow",
					source: sourceOf([
						candidate("delegated-a", "unknown", "browser-closest-peers"),
						candidate("delegated-b", "unknown", "browser-closest-peers"),
					]),
				},
				{
					degradedOverflowEligible: true,
					enabled: true,
					name: "node-closest-peers",
					priority: "overflow",
					source: sourceOf([
						candidate("node-eligible-a", "unknown", "node-connected-hop"),
						candidate("node-eligible-b", "unknown", "node-connected-hop"),
					]),
				},
			],
		});
		const policy = createPolicy(source);

		try {
			const result = await policy.acquire(QUERY, AbortSignal.timeout(1_000));
			expect(result.terminal).toBe("reserved");
			expect(
				result.reservations.filter(({ candidate: item }) => item.provenance.origin === "browser-closest-peers")
			).toHaveLength(1);
			expect(result.reservations).toContainEqual(
				expect.objectContaining({ candidate: expect.objectContaining({ peerId: "node-eligible-a" }) })
			);
			expect(result.attempts).toContainEqual(
				expect.objectContaining({
					candidate: expect.objectContaining({ peerId: "delegated-b" }),
					status: "operator-limit",
				})
			);
		} finally {
			await policy.stop();
		}
	});

	it("does not relax anonymous overflow on a browser composite without a degraded-eligible node source", async () => {
		const source = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 2,
			sources: [
				{
					degradedOverflowEligible: false,
					enabled: true,
					name: "delegated-closest-peers",
					priority: "overflow",
					source: sourceOf([
						candidate("browser-anonymous-a", "unknown", "browser-closest-peers"),
						candidate("browser-anonymous-b", "unknown", "browser-closest-peers"),
					]),
				},
			],
		});
		const policy = createPolicy(source);

		try {
			const result = await policy.acquire(QUERY, AbortSignal.timeout(1_000));
			expect(result.terminal).toBe("exhausted");
			expect(result.reservations).toHaveLength(1);
			expect(result.operatorGroups).toEqual(["unknown"]);
		} finally {
			await policy.stop();
		}
	});

	it("does not degrade overflow candidates carrying unverifiable operator evidence", async () => {
		const spoofed = (peerId: string): RelayCandidate => ({
			...candidate(peerId, "claimed:operator", "node-connected-hop"),
			operatorEvidence: {
				credential: `spoofed-${peerId}`,
				signedRecordDigest: `sha256:spoofed-${peerId}`,
			},
		});
		const source = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 2,
			sources: [
				{
					degradedOverflowEligible: true,
					enabled: true,
					name: "node-closest-peers",
					priority: "overflow",
					source: sourceOf([spoofed("spoofed-a"), spoofed("spoofed-b")]),
				},
			],
		});
		const policy = createPolicy(source);

		try {
			const result = await policy.acquire(QUERY, AbortSignal.timeout(1_000));
			expect(result.terminal).toBe("exhausted");
			expect(result.reservations).toHaveLength(1);
			expect(result.operatorGroups).toEqual(["unknown"]);
			expect(result.attempts).toContainEqual(
				expect.objectContaining({
					candidate: expect.objectContaining({ peerId: "spoofed-b" }),
					status: "operator-limit",
				})
			);
		} finally {
			await policy.stop();
		}
	});

	it("consults node overflow when the primary tier consumes the candidate cap but fails", async () => {
		const overflowStarted = vi.fn();
		const source = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 1,
			sources: [
				{
					enabled: true,
					name: "configured",
					priority: "primary",
					source: sourceOf([attested("primary-capped", "verified:primary", "configured-fallback")]),
				},
				{
					degradedOverflowEligible: true,
					enabled: true,
					name: "node-closest-peers",
					priority: "overflow",
					source: trackedSource(overflowStarted, [attested("node-after-cap", "verified:node", "node-connected-hop")]),
				},
			],
		});
		const policy = createPolicy(
			source,
			{ maxCandidates: 1, maxQueuedCandidates: 1, requiredOperatorGroups: 1, requiredReservations: 1 },
			undefined,
			{ "primary-capped": { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED } }
		);

		try {
			const result = await policy.acquire(QUERY, AbortSignal.timeout(1_000));
			expect(overflowStarted).toHaveBeenCalledOnce();
			expect(result.reservations).toMatchObject([{ candidate: { peerId: "node-after-cap" } }]);
		} finally {
			await policy.stop();
		}
	});

	it("re-collects node candidates after a relay disconnect instead of reusing a stale pool", async () => {
		let collections = 0;
		const queryKeys: Uint8Array[] = [];
		const changingSource: RelayCandidateSource = {
			async *getCandidates(queryKey): AsyncIterable<RelayCandidate> {
				await Promise.resolve();
				queryKeys.push(new Uint8Array(queryKey));
				collections += 1;
				if (collections === 1) {
					yield attested("initial-a", "verified:a", "configured-fallback");
					yield attested("initial-b", "verified:b", "configured-fallback");
					return;
				}
				yield attested("replacement-c", "verified:c", "node-connected-hop");
			},
		};
		const policy = createPolicy(changingSource);

		try {
			await expect(policy.acquire(QUERY, AbortSignal.timeout(1_000))).resolves.toMatchObject({ terminal: "reserved" });
			const replacement = await policy.replace("initial-a", "relay-disconnected", AbortSignal.timeout(1_000));
			expect(collections).toBe(2);
			expect(queryKeys).toEqual([QUERY, QUERY]);
			expect(replacement.reservations.map(({ candidate: item }) => item.peerId).sort()).toEqual([
				"initial-b",
				"replacement-c",
			]);
		} finally {
			await policy.stop();
		}
	});

	it("re-collects with the original query key when a near-expiry refresh is refused", async () => {
		let collections = 0;
		const queryKeys: Uint8Array[] = [];
		const responses: Record<string, RelayReservationWireResponse> = {};
		const changingSource: RelayCandidateSource = {
			async *getCandidates(queryKey): AsyncIterable<RelayCandidate> {
				await Promise.resolve();
				collections += 1;
				queryKeys.push(new Uint8Array(queryKey));
				if (collections === 1) {
					yield attested("refresh-a", "verified:a", "configured-fallback");
					yield attested("refresh-b", "verified:b", "configured-fallback");
					return;
				}
				yield attested("refresh-c", "verified:c", "node-connected-hop");
			},
		};
		const policy = createPolicy(changingSource, { refreshBeforeExpiryMs: 120_000 }, undefined, responses);

		try {
			await expect(policy.acquire(QUERY, AbortSignal.timeout(1_000))).resolves.toMatchObject({ terminal: "reserved" });
			responses["refresh-a"] = { status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED };
			const refreshed = await policy.refresh(AbortSignal.timeout(1_000));
			expect(collections).toBe(2);
			expect(queryKeys).toEqual([QUERY, QUERY]);
			expect(refreshed.terminal).toBe("reserved");
			expect(refreshed.reservations.map(({ candidate: item }) => item.peerId).sort()).toEqual([
				"refresh-b",
				"refresh-c",
			]);
		} finally {
			await policy.stop();
		}
	});

	it("keeps the original non-overflow collection window for a slow first candidate", async () => {
		vi.useFakeTimers();
		const slowDefaultSource: RelayCandidateSource = {
			async *getCandidates(): AsyncIterable<RelayCandidate> {
				await new Promise<void>((resolve) => setTimeout(resolve, 3_500));
				yield attested("slow-default-a", "verified:slow-a", "browser-closest-peers");
				yield attested("slow-default-b", "verified:slow-b", "browser-closest-peers");
			},
		};
		const policy = createPolicy(slowDefaultSource, {
			perCandidateDeadlineMs: 1_000,
			totalDeadlineMs: 5_000,
		});

		try {
			const acquisition = policy.acquire(QUERY, AbortSignal.timeout(10_000));
			await vi.advanceTimersByTimeAsync(3_500);
			await expect(acquisition).resolves.toMatchObject({
				reservations: [{ candidate: { peerId: "slow-default-a" } }, { candidate: { peerId: "slow-default-b" } }],
				terminal: "reserved",
			});
		} finally {
			await policy.stop();
			vi.useRealTimers();
		}
	});

	it("bounds slow primary collection so the overflow walk keeps its time floor", async () => {
		vi.useFakeTimers();
		const overflowStarted = vi.fn();
		const primaryAborted = vi.fn();
		let overflowStartedAtMs: number | undefined;
		const source = new CompositeRelayCandidateSource({
			requiredOperatorGroups: 2,
			sources: [
				{
					enabled: true,
					name: "configured",
					priority: "primary",
					source: {
						async *getCandidates(_queryKey, signal): AsyncIterable<RelayCandidate> {
							try {
								await new Promise<void>((resolve, reject) => {
									const timeout = setTimeout(resolve, 10_000);
									signal.addEventListener(
										"abort",
										() => {
											clearTimeout(timeout);
											reject(signal.reason);
										},
										{ once: true }
									);
								});
								yield attested("too-late-primary", "verified:primary", "configured-fallback");
							} finally {
								if (signal.aborted) primaryAborted();
							}
						},
					},
				},
				{
					degradedOverflowEligible: true,
					enabled: true,
					name: "node-closest-peers",
					priority: "overflow",
					source: {
						async *getCandidates(): AsyncIterable<RelayCandidate> {
							overflowStarted();
							overflowStartedAtMs = Date.now();
							await new Promise<void>((resolve) => setTimeout(resolve, 45_000));
							yield candidate("walk-a", "unknown", "node-connected-hop");
							yield candidate("walk-b", "unknown", "node-connected-hop");
						},
					},
				},
			],
		});
		const policy = createPolicy(source, {
			perCandidateDeadlineMs: 1_000,
			totalDeadlineMs: 55_000,
		});

		try {
			const startedAtMs = Date.now();
			const acquisition = policy.acquire(QUERY, AbortSignal.timeout(60_000));
			await vi.advanceTimersByTimeAsync(55_000);
			expect(primaryAborted).toHaveBeenCalledOnce();
			expect(overflowStarted).toHaveBeenCalledOnce();
			expect(overflowStartedAtMs).toBeLessThanOrEqual(startedAtMs + 5_000);
			await expect(acquisition).resolves.toMatchObject({
				reservations: [{ candidate: { peerId: "walk-a" } }, { candidate: { peerId: "walk-b" } }],
				terminal: "reserved",
			});
		} finally {
			await policy.stop();
			vi.useRealTimers();
		}
	});
});

function createPolicy(
	source: RelayCandidateSource,
	limits: ConstructorParameters<typeof RelayPolicy>[0]["limits"] = {},
	reserve?: RelayReservationClient["reserve"],
	responses: Readonly<Record<string, RelayReservationWireResponse>> = {},
	offlinePeerIds: ReadonlySet<string> = new Set()
): RelayPolicy {
	const inspector: RelayInspector = {
		inspect: (item): Promise<RelayInspection> =>
			Promise.resolve({
				...(offlinePeerIds.has(item.peerId) ? {} : { connectionId: "fixture-connection" }),
				hopAdvertised: !offlinePeerIds.has(item.peerId),
				latencyMs: 1,
				outcome: offlinePeerIds.has(item.peerId) ? "refused" : "connected",
				protocols: offlinePeerIds.has(item.peerId) ? [] : [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
			}),
	};
	const reservationClient: RelayReservationClient = {
		refresh: (item, signal): Promise<RelayReservationWireResponse> => reservation(item, signal),
		release: (): Promise<void> => Promise.resolve(),
		reserve: reserve ?? ((item, signal): Promise<RelayReservationWireResponse> => reservation(item, signal)),
	};
	function reservation(item: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse> {
		signal.throwIfAborted();
		return Promise.resolve(responses[item.peerId] ?? okReservation());
	}
	return new RelayPolicy({
		inspector,
		limits: {
			maxCandidates: 8,
			maxConcurrentReservations: 1,
			maxPerOperatorGroup: 1,
			maxQueuedCandidates: 8,
			ownedFallbackDeadlineMs: 10,
			perCandidateDeadlineMs: 50,
			refreshBeforeExpiryMs: 30_000,
			requiredOperatorGroups: 2,
			requiredReservations: 2,
			totalDeadlineMs: 500,
			...limits,
		},
		now: () => NOW,
		operatorGroupClassifier: new EvidenceDerivedOperatorGroupClassifier({
			verify: (): Promise<{ readonly verified: false }> => Promise.resolve({ verified: false }),
		}),
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

function trackedSource(started: () => void, candidates: readonly RelayCandidate[]): RelayCandidateSource {
	return {
		async *getCandidates(): AsyncIterable<RelayCandidate> {
			await Promise.resolve();
			started();
			yield* candidates;
		},
	};
}

function attested(
	peerId: string,
	operatorGroup: string,
	origin: RelayCandidate["provenance"]["origin"]
): RelayCandidate {
	return {
		...candidate(peerId, operatorGroup, origin),
		operatorEvidence: { credentialDigest: `sha256:${peerId}`, operatorGroup, verified: true },
	};
}

function candidate(
	peerId: string,
	operatorGroup: string,
	origin: RelayCandidate["provenance"]["origin"]
): RelayCandidate {
	return {
		addresses: [`/dns4/${peerId}.example.test/tcp/443/wss/p2p/${peerId}`],
		operatorGroup,
		peerId,
		protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
		provenance: {
			origin,
			queryDigest: "query_5734a87d",
			resultIndex: 0,
			routingSource:
				origin === "configured-fallback"
					? "configured"
					: origin === "browser-closest-peers"
						? "delegated-routing"
						: "connected-peers",
		},
	};
}

function okReservation(): RelayReservationWireResponse {
	return {
		reservation: { expire: Math.floor((NOW + 60_000) / 1_000) },
		status: RELAY_RESERVATION_STATUS.OK,
	};
}
