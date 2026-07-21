import * as relayPolicy from "@ts-drp/relay-policy";
import { describe, expect, it, vi } from "vitest";

const NETWORK_ID = "abcdefghijklmnopqrstuv";
const RELAY_NAMESPACE = `drp-relays:v1:${NETWORK_ID}`;
const RELAY_NAMESPACE_CID = "bafkreihsg6uuljfhwpwztgxqy47gugpgluh5xsyvafirz5cwlprxwegyha";
const QUERY = Uint8Array.from([1, 2, 3, 4]);

type NewOrigin = "cached-relay" | "configured-fallback" | "dht-relay-provider" | "registry-relay-record";
type NewRoutingSource = "configured" | "delegated-routing" | "peer-cache" | "public-dht" | "registry";

interface PhaseFiveCandidate {
	readonly addresses: readonly string[];
	readonly operatorGroup: string;
	readonly peerId: string;
	readonly protocols: readonly string[];
	readonly provenance: {
		readonly origin: NewOrigin;
		readonly queryDigest: string;
		readonly resultIndex: number;
		readonly routingSource: NewRoutingSource;
	};
}

interface PhaseFiveSource {
	getCandidates(queryKey: Uint8Array, signal: AbortSignal): AsyncIterable<PhaseFiveCandidate>;
}

type SourceConstructor<Options> = new (options: Options) => PhaseFiveSource;

interface VerifiedOperatorEvidence {
	readonly credentialDigest: string;
	readonly operatorGroup: string;
	readonly verified: true;
}

interface SignedRelayRecord {
	readonly addresses: readonly string[];
	readonly capabilities: readonly ("drp-gossipsub" | "relay-client" | "relay-hop-v2-service" | "webrtc")[];
	readonly expiresAtMs: number;
	readonly issuedAtMs: number;
	readonly kind: "ts-drp-rendezvous-record";
	readonly namespace: string;
	readonly peerId: string;
	readonly publicKey: string;
	readonly sequence: number;
	readonly signature: string;
	readonly version: 1;
}

interface ValidatedRelayRecord {
	readonly admissionMode: "invite";
	readonly record: SignedRelayRecord;
	readonly sourceEndpointId: string;
}

describe("Phase 5 relay candidate sources", () => {
	it("maps only signed registry relay-service records from the frozen relay namespace", async () => {
		const relay = validated(relayRecord("registry-relay", ["relay-hop-v2-service"]));
		const nonRelay = validated(relayRecord("ordinary-peer", ["drp-gossipsub"]));
		const discover = vi.fn((namespace: string, signal: AbortSignal): Promise<readonly ValidatedRelayRecord[]> => {
			expect(namespace).toBe(RELAY_NAMESPACE);
			expect(signal.aborted).toBe(false);
			return Promise.resolve([relay, nonRelay]);
		});
		const Constructor = requireConstructor<{
			readonly directory: {
				discover(namespace: string, signal: AbortSignal): Promise<readonly ValidatedRelayRecord[]>;
			};
			readonly networkId: string;
		}>("RegistryRelayRecordSource");
		const source = new Constructor({ directory: { discover }, networkId: NETWORK_ID });
		const output = await collect(source);

		expect(output).toMatchObject([
			{
				addresses: relay.record.addresses,
				peerId: relay.record.peerId,
				protocols: [relayPolicy.CIRCUIT_RELAY_V2_HOP_PROTOCOL],
				provenance: { origin: "registry-relay-record", resultIndex: 0, routingSource: "registry" },
			},
		]);
		expectValid(output);
		expect(discover).toHaveBeenCalledTimes(1);
	});

	it("reads cached successful relay records through the injected peer-cache seam", async () => {
		const cached = validated(relayRecord("cached-relay", ["relay-hop-v2-service"]), "peer-cache");
		const list = vi.fn((namespace: string, signal: AbortSignal): Promise<readonly ValidatedRelayRecord[]> => {
			expect(namespace).toBe(RELAY_NAMESPACE);
			expect(signal.aborted).toBe(false);
			return Promise.resolve([cached]);
		});
		const Constructor = requireConstructor<{
			readonly cache: { list(namespace: string, signal: AbortSignal): Promise<readonly ValidatedRelayRecord[]> };
			readonly networkId: string;
		}>("CachedSuccessfulRelaySource");
		const source = new Constructor({ cache: { list }, networkId: NETWORK_ID });
		const output = await collect(source);

		expect(output).toMatchObject([
			{
				peerId: cached.record.peerId,
				provenance: { origin: "cached-relay", routingSource: "peer-cache" },
			},
		]);
		expectValid(output);
		expect(list).toHaveBeenCalledTimes(1);
	});

	it.each(["RegistryRelayRecordSource", "CachedSuccessfulRelaySource"] as const)(
		"filters expired records in %s using the client clock",
		async (sourceName) => {
			const expired = validated({ ...relayRecord("expired-relay", ["relay-hop-v2-service"]), expiresAtMs: 99 });
			const live = validated({ ...relayRecord("live-relay", ["relay-hop-v2-service"]), expiresAtMs: 101 });
			const records = [expired, live];
			const Constructor = requireConstructor<{
				readonly cache?: { list(namespace: string, signal: AbortSignal): Promise<readonly ValidatedRelayRecord[]> };
				readonly directory?: {
					discover(namespace: string, signal: AbortSignal): Promise<readonly ValidatedRelayRecord[]>;
				};
				readonly networkId: string;
				now(): number;
			}>(sourceName);
			const source = new Constructor({
				...(sourceName === "RegistryRelayRecordSource"
					? { directory: { discover: (): Promise<readonly ValidatedRelayRecord[]> => Promise.resolve(records) } }
					: { cache: { list: (): Promise<readonly ValidatedRelayRecord[]> => Promise.resolve(records) } }),
				networkId: NETWORK_ID,
				now: () => 100,
			});

			await expect(collect(source)).resolves.toMatchObject([{ peerId: "live-relay" }]);
		}
	);

	it("turns signed configured entries into the owned fallback floor", async () => {
		const record = relayRecord("owned-relay", ["relay-hop-v2-service"]);
		const evidence = verifiedEvidence("operator:owned");
		const Constructor = requireConstructor<{
			readonly entries: readonly {
				readonly operatorEvidence: VerifiedOperatorEvidence;
				readonly record: SignedRelayRecord;
			}[];
		}>("ConfiguredFallbackRelaySource");
		const source = new Constructor({ entries: [{ operatorEvidence: evidence, record }] });
		const output = await collect(source);

		expect(output).toMatchObject([
			{
				addresses: record.addresses,
				operatorGroup: "operator:owned",
				peerId: record.peerId,
				provenance: { origin: "configured-fallback", routingSource: "configured" },
			},
		]);
		expectValid(output);
	});

	it.each(["public-dht", "delegated-routing"] as const)(
		"finds relay-CID providers through an injected %s routing seam",
		async (routingSource) => {
			let iteratorClosed = false;
			const findProviders = vi.fn(async function* (
				cid: unknown,
				signal: AbortSignal
			): AsyncIterable<{ addresses: string[]; peerId: string }> {
				try {
					await Promise.resolve();
					expect(String(cid)).toBe(RELAY_NAMESPACE_CID);
					expect(signal.aborted).toBe(false);
					yield { addresses: [address("provider-a")], peerId: "provider-a" };
				} finally {
					iteratorClosed = true;
				}
			});
			const Constructor = requireConstructor<{
				readonly networkId: string;
				readonly routing: {
					findProviders(cid: unknown, signal: AbortSignal): AsyncIterable<{ addresses: string[]; peerId: string }>;
				};
				readonly routingSource: typeof routingSource;
			}>("DhtRelayProviderSource");
			const source = new Constructor({ networkId: NETWORK_ID, routing: { findProviders }, routingSource });
			const output = await collect(source);

			expect(output).toMatchObject([
				{
					peerId: "provider-a",
					provenance: { origin: "dht-relay-provider", routingSource },
				},
			]);
			expectValid(output);
			expect(findProviders).toHaveBeenCalledTimes(1);
			expect(iteratorClosed).toBe(true);
		}
	);

	it("accepts every Phase 5 provenance origin while continuing to reject unknown origins", () => {
		const isValidCandidate = (
			relayPolicy as unknown as {
				isValidCandidate?(candidate: unknown): candidate is PhaseFiveCandidate;
			}
		).isValidCandidate;
		expect(isValidCandidate, "Phase 5 must export the candidate boundary validator").toBeTypeOf("function");
		if (isValidCandidate === undefined) throw new Error("isValidCandidate is not exported");

		for (const [index, origin] of (
			[
				"registry-relay-record",
				"cached-relay",
				"configured-fallback",
				"dht-relay-provider",
			] satisfies readonly NewOrigin[]
		).entries()) {
			expect(isValidCandidate(candidate(`relay-${index}`, origin)), origin).toBe(true);
		}
		expect(
			isValidCandidate({
				...candidate("garbage", "configured-fallback"),
				provenance: { ...candidate("garbage", "configured-fallback").provenance, origin: "advertised-by-stranger" },
			})
		).toBe(false);
	});

	it("propagates cancellation to provider routing and closes the provider iterator", async () => {
		const controller = new AbortController();
		let activeIterators = 0;
		const Constructor = requireConstructor<{
			readonly networkId: string;
			readonly routing: {
				findProviders(cid: unknown, signal: AbortSignal): AsyncIterable<{ addresses: string[]; peerId: string }>;
			};
			readonly routingSource: "public-dht";
		}>("DhtRelayProviderSource");
		const source = new Constructor({
			networkId: NETWORK_ID,
			routing: {
				async *findProviders(_cid, signal): AsyncIterable<{ addresses: string[]; peerId: string }> {
					activeIterators++;
					try {
						yield { addresses: [address("provider-a")], peerId: "provider-a" };
						await abort(signal);
						signal.throwIfAborted();
					} finally {
						activeIterators--;
					}
				},
			},
			routingSource: "public-dht",
		});
		const iterator = source.getCandidates(QUERY, controller.signal)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { peerId: "provider-a" } });
		controller.abort(new DOMException("test cancellation", "AbortError"));
		await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
		expect(activeIterators).toBe(0);
	});
});

function requireConstructor<Options>(name: string): SourceConstructor<Options> {
	const Constructor = (relayPolicy as unknown as Record<string, SourceConstructor<Options> | undefined>)[name];
	expect(Constructor, `Phase 5 must export ${name}`).toBeTypeOf("function");
	if (Constructor === undefined) throw new Error(`${name} is not exported`);
	return Constructor;
}

function expectValid(candidates: readonly PhaseFiveCandidate[]): void {
	const isValidCandidate = (
		relayPolicy as unknown as { isValidCandidate?(candidate: unknown): candidate is PhaseFiveCandidate }
	).isValidCandidate;
	expect(isValidCandidate, "Phase 5 source output must pass the exported candidate boundary validator").toBeTypeOf(
		"function"
	);
	if (isValidCandidate === undefined) throw new Error("isValidCandidate is not exported");
	for (const candidateItem of candidates) expect(isValidCandidate(candidateItem)).toBe(true);
}

async function collect(source: PhaseFiveSource, signal = new AbortController().signal): Promise<PhaseFiveCandidate[]> {
	const output: PhaseFiveCandidate[] = [];
	for await (const candidateItem of source.getCandidates(QUERY, signal)) output.push(candidateItem);
	return output;
}

function candidate(peerId: string, origin: NewOrigin): PhaseFiveCandidate {
	const routingSource: NewRoutingSource =
		origin === "configured-fallback"
			? "configured"
			: origin === "registry-relay-record"
				? "registry"
				: origin === "cached-relay"
					? "peer-cache"
					: "public-dht";
	return {
		addresses: [address(peerId)],
		operatorGroup: "unknown",
		peerId,
		protocols: [relayPolicy.CIRCUIT_RELAY_V2_HOP_PROTOCOL],
		provenance: { origin, queryDigest: "query_5734a87d", resultIndex: 0, routingSource },
	};
}

function relayRecord(peerId: string, capabilities: SignedRelayRecord["capabilities"]): SignedRelayRecord {
	return {
		addresses: [address(peerId)],
		capabilities,
		expiresAtMs: 2_000_000_060_000,
		issuedAtMs: 1_750_000_000_000,
		kind: "ts-drp-rendezvous-record",
		namespace: RELAY_NAMESPACE,
		peerId,
		publicKey: `fixture-public-key-${peerId}`,
		sequence: 1,
		signature: `fixture-signature-${peerId}`,
		version: 1,
	};
}

function validated(record: SignedRelayRecord, sourceEndpointId = "registry-a"): ValidatedRelayRecord {
	return { admissionMode: "invite", record, sourceEndpointId };
}

function verifiedEvidence(operatorGroup: string): VerifiedOperatorEvidence {
	return { credentialDigest: `sha256:${operatorGroup}`, operatorGroup, verified: true };
}

function address(peerId: string): string {
	return `/dns4/${peerId}.example.test/tcp/443/wss/p2p/${peerId}`;
}

function abort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
