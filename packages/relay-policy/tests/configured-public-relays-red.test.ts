import * as relayPolicy from "@ts-drp/relay-policy";
import {
	ConfiguredPublicRelaySource,
	ConfiguredRelayValidationError,
	EvidenceDerivedOperatorGroupClassifier,
	type RelayCandidate,
	type RelayCandidateSource,
	type RelayInspection,
	type RelayInspector,
	RelayPolicy,
	type RelayReservationClient,
	type RelayReservationWireResponse,
} from "@ts-drp/relay-policy";
import { describe, expect, it } from "vitest";

const PEER_ID = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";
const SECOND_PEER_ID = "QmQCU2EcMqAqQPR2i9bV9aayZivWoHLMEZ2f9uZeX6NLGy";
const CONFIGURED_MULTIADDRS = [
	`/dns4/relay.example.test/tcp/443/wss/p2p/${PEER_ID}`,
	`/ip4/1.2.3.4/udp/443/quic-v1/webtransport/p2p/${PEER_ID}`,
	`/ip4/1.2.3.4/udp/9090/webrtc-direct/p2p/${PEER_ID}`,
	`/ip4/1.2.3.4/tcp/4001/p2p/${PEER_ID}`,
	`/ip4/1.2.3.4/udp/4001/quic-v1/p2p/${PEER_ID}`,
] as const;

interface ConfiguredCandidate {
	readonly addresses: readonly string[];
	readonly operatorEvidence?: {
		readonly credentialDigest: string;
		readonly operatorGroup: string;
		readonly verified: true;
	};
	readonly operatorGroup: string;
	readonly peerId: string;
	readonly protocols: readonly string[];
	readonly provenance: {
		readonly origin: "configured-relay";
		readonly queryDigest: string;
		readonly resultIndex: number;
		readonly routingSource: "configured";
	};
}

interface ConfiguredSource {
	getCandidates(queryKey: Uint8Array, signal: AbortSignal): AsyncIterable<ConfiguredCandidate>;
}

type ConfiguredSourceConstructor = new (options: { readonly multiaddrs: readonly string[] }) => ConfiguredSource;

describe("ConfiguredPublicRelaySource RED contracts", () => {
	it("groups a first-class configured multiaddr list into HOP candidates without discovery", async () => {
		const source = new (configuredSourceConstructor())({ multiaddrs: CONFIGURED_MULTIADDRS });
		const candidates: ConfiguredCandidate[] = [];
		for await (const candidate of source.getCandidates(Uint8Array.from([5, 5]), new AbortController().signal)) {
			candidates.push(candidate);
		}

		expect(candidates).toEqual([
			{
				addresses: [...CONFIGURED_MULTIADDRS],
				operatorEvidence: {
					credentialDigest: PEER_ID,
					operatorGroup: "configured:0",
					verified: true,
				},
				operatorGroup: "configured:0",
				peerId: PEER_ID,
				protocols: [relayPolicy.CIRCUIT_RELAY_V2_HOP_PROTOCOL],
				provenance: {
					origin: "configured-relay",
					queryDigest: "query_586a3b9f",
					resultIndex: 0,
					routingSource: "configured",
				},
			},
		]);
	});

	it.each([1, 2] as const)(
		"reaches terminal reserved for %i trusted configured relay group(s) with the real policy",
		async (targetReservations) => {
			const multiaddrs = [
				CONFIGURED_MULTIADDRS[0],
				`/dns4/second-relay.example.test/tcp/443/wss/p2p/${SECOND_PEER_ID}`,
			].slice(0, targetReservations);
			const source = new (configuredSourceConstructor())({ multiaddrs });
			const policy = configuredRelayPolicy(source, targetReservations);

			try {
				const result = await policy.acquire(Uint8Array.from([2, 4]), AbortSignal.timeout(1_000));

				expect(result.terminal).toBe("reserved");
				expect(result.reservations).toHaveLength(targetReservations);
				expect(new Set(result.operatorGroups)).toHaveProperty("size", targetReservations);
				expect(result.attempts).not.toContainEqual(expect.objectContaining({ status: "operator-limit" }));
			} finally {
				await policy.stop();
			}
		}
	);

	it("accepts terminal dnsaddr peer forms pasted by operators", async () => {
		const address = `/dnsaddr/relay.example.test/p2p/${PEER_ID}`;
		const source = new ConfiguredPublicRelaySource({ multiaddrs: [address] });
		const policy = configuredRelayPolicy(source, 1);

		try {
			await expect(collectConfigured(source)).resolves.toMatchObject([{ addresses: [address], peerId: PEER_ID }]);
			await expect(policy.acquire(Uint8Array.from([2, 4]), AbortSignal.timeout(1_000))).resolves.toMatchObject({
				terminal: "reserved",
			});
		} finally {
			await policy.stop();
		}
	});

	it("rejects relay endpoints with a typed configured-relay validation error", () => {
		const circuitAddress = `/dns4/relay.example.test/tcp/443/wss/p2p/${PEER_ID}/p2p-circuit/p2p/${SECOND_PEER_ID}`;

		expect(() => new ConfiguredPublicRelaySource({ multiaddrs: [circuitAddress] })).toThrow(
			ConfiguredRelayValidationError
		);
		expect(() => new ConfiguredPublicRelaySource({ multiaddrs: ["not-a-multiaddr"] })).toThrow(
			ConfiguredRelayValidationError
		);
	});
});

async function collectConfigured(source: RelayCandidateSource): Promise<RelayCandidate[]> {
	const candidates: RelayCandidate[] = [];
	for await (const candidate of source.getCandidates(Uint8Array.from([5, 5]), new AbortController().signal)) {
		candidates.push(candidate);
	}
	return candidates;
}

function configuredRelayPolicy(source: RelayCandidateSource, targetReservations: number): RelayPolicy {
	const now = 1_750_000_000_000;
	const inspector: RelayInspector = {
		inspect: (): Promise<RelayInspection> =>
			Promise.resolve({
				connectionId: "configured-relay-fixture",
				hopAdvertised: true,
				latencyMs: 1,
				outcome: "connected",
				protocols: [relayPolicy.CIRCUIT_RELAY_V2_HOP_PROTOCOL],
			}),
	};
	const reservationClient: RelayReservationClient = {
		refresh: (_candidate, signal): Promise<RelayReservationWireResponse> => grantedReservation(signal, now),
		release: (): Promise<void> => Promise.resolve(),
		reserve: (_candidate, signal): Promise<RelayReservationWireResponse> => grantedReservation(signal, now),
	};
	return new RelayPolicy({
		inspector,
		limits: {
			maxCandidates: 4,
			maxConcurrentReservations: 1,
			maxPerOperatorGroup: 1,
			maxQueuedCandidates: 4,
			ownedFallbackDeadlineMs: 10,
			perCandidateDeadlineMs: 50,
			refreshBeforeExpiryMs: 30_000,
			requiredOperatorGroups: targetReservations,
			requiredReservations: targetReservations,
			totalDeadlineMs: 500,
		},
		now: (): number => now,
		operatorGroupClassifier: new EvidenceDerivedOperatorGroupClassifier({
			verify: (): Promise<{ readonly verified: false }> => Promise.resolve({ verified: false }),
		}),
		reservationClient,
		source,
	});
}

function grantedReservation(signal: AbortSignal, now: number): Promise<RelayReservationWireResponse> {
	signal.throwIfAborted();
	return Promise.resolve({
		reservation: { expire: Math.floor((now + 60_000) / 1_000) },
		status: 100,
	});
}

function configuredSourceConstructor(): ConfiguredSourceConstructor {
	const Constructor = (relayPolicy as unknown as { ConfiguredPublicRelaySource?: ConfiguredSourceConstructor })
		.ConfiguredPublicRelaySource;
	expect(Constructor, "relay-policy must export ConfiguredPublicRelaySource").toBeTypeOf("function");
	if (Constructor === undefined) throw new Error("ConfiguredPublicRelaySource is not exported");
	return Constructor;
}
