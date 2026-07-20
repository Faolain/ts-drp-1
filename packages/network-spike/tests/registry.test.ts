import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { describe, expect, it } from "vitest";

import type { BrowserRoutingPeer } from "../src/browser-routing/index.js";
import { createNodeRouting } from "../src/node-routing/index.js";
import { createOpaqueNamespaceV1, RecordSigner, RecordValidator, type SignedDrpRecordV1 } from "../src/record/index.js";
import { createRegistryFixture } from "../src/registry/fixture.js";
import {
	AdmissionPolicy,
	AnchorAdvertisementError,
	DhtAnchorPublisher,
	DhtAnchorResolver,
	FixtureRegistryEndpoint,
	namespaceAnchorCid,
	type ProofOfWorkChallengeV1,
	RegistryClient,
	type RegistryRegistrationRequest,
	RegistryServer,
	solveProofOfWork,
} from "../src/registry/index.js";

const NOW = 1_750_000_000_000;
const INVITE = "fixture-invite-token-32-characters";
const resolver = { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) };

describe("two-endpoint registry", () => {
	it("replicates to two independent endpoints and discovers through ordered failover", async () => {
		const record = await signedRecord(1);
		const primary = endpoint("primary");
		const secondary = endpoint("secondary");
		const client = registryClient([primary, secondary]);

		await expect(client.register(record, signal(), { kind: "invite", token: INVITE })).resolves.toMatchObject({
			acceptedEndpointIds: ["primary", "secondary"],
			sequence: 1,
		});
		primary.setAvailable(false);
		const discovered = await client.discover(record.namespace, signal());
		expect(discovered).toHaveLength(1);
		expect(discovered[0]).toMatchObject({
			admissionMode: "invite",
			record: { peerId: record.peerId, sequence: 1 },
			sourceEndpointId: "secondary",
		});
		expect(client.lastAttempts).toEqual([
			{ code: "endpoint-unavailable", endpointId: "primary", operation: "discover", status: "rejected" },
			{ endpointId: "secondary", operation: "discover", status: "accepted" },
		]);
		expect(JSON.stringify(client.lastAttempts)).not.toContain(INVITE);
	});

	it("reconciles healthy endpoints without rolling back a recovered stale replica", async () => {
		const first = await signedRecord(2);
		const second = await signedRecord(2, {
			issuedAtMs: NOW + 10_000,
			expiresAtMs: NOW + 70_000,
			sequence: 2,
		});
		const primary = endpoint("primary");
		const secondary = endpoint("secondary");
		const client = registryClient([primary, secondary]);
		await client.register(first, signal(), { kind: "invite", token: INVITE });
		primary.setAvailable(false);
		await client.register(second, signal(), { kind: "invite", token: INVITE });
		primary.setAvailable(true);

		expect(await client.discover(first.namespace, signal())).toMatchObject([
			{
				record: { peerId: first.peerId, sequence: 2 },
				sourceEndpointId: "secondary",
			},
		]);
		expect(client.lastAttempts).toEqual([
			{ endpointId: "primary", operation: "discover", status: "accepted" },
			{ endpointId: "secondary", operation: "discover", status: "accepted" },
		]);
	});

	it("refreshes monotonically and removes a record exactly at expiry", async () => {
		let now = NOW;
		const server = registryServer("primary", new AdmissionPolicy({ inviteToken: INVITE }), () => now);
		const first = await signedRecord(2);
		const second = await signedRecord(2, {
			issuedAtMs: NOW + 10_000,
			expiresAtMs: NOW + 70_000,
			sequence: 2,
		});
		const request = (record: SignedDrpRecordV1): RegistryRegistrationRequest => ({
			clientId: record.peerId,
			credential: { kind: "invite" as const, token: INVITE },
			record,
			signal: signal(),
		});

		expect(await server.register(request(first))).toMatchObject({ accepted: true, refreshed: false, sequence: 1 });
		expect(await server.register(request(second))).toMatchObject({ accepted: true, refreshed: true, sequence: 2 });
		expect(await server.register(request(first))).toMatchObject({
			accepted: false,
			code: "record-rejected",
			detail: "replayed-sequence",
		});
		now = second.expiresAtMs;
		expect(await server.discover({ clientId: "reader", namespace: second.namespace, signal: signal() })).toEqual({
			endpointId: "primary",
			records: [],
		});
	});

	it("rejects forged, oversized, future, and wrong-invite records without storing them", async () => {
		const record = await signedRecord(3);
		const server = registryServer("primary");
		const register = (candidate: SignedDrpRecordV1, token = INVITE): ReturnType<RegistryServer["register"]> =>
			server.register({
				clientId: candidate.peerId,
				credential: { kind: "invite", token },
				record: candidate,
				signal: signal(),
			});

		expect(await register(record, "wrong-token-long-enough")).toMatchObject({
			accepted: false,
			code: "admission-rejected",
		});
		expect(await register({ ...record, signature: mutate(record.signature) })).toMatchObject({
			accepted: false,
			code: "record-rejected",
			detail: "invalid-signature",
		});
		expect(await register({ ...record, signature: "A".repeat(9_000) })).toMatchObject({
			accepted: false,
			code: "record-rejected",
			detail: "oversized",
		});
		const future = await signedRecord(4, {
			issuedAtMs: NOW + 30_001,
			expiresAtMs: NOW + 90_001,
		});
		expect(await register(future)).toMatchObject({
			accepted: false,
			code: "record-rejected",
			detail: "issued-in-future",
		});
		expect(await register(record)).toMatchObject({ accepted: true });
	});

	it("binds registration accounting to the signed Peer ID", async () => {
		const record = await signedRecord(4);
		const server = registryServer("primary");
		expect(
			await server.register({
				clientId: "self-asserted-client",
				credential: { kind: "invite", token: INVITE },
				record,
				signal: signal(),
			})
		).toMatchObject({
			accepted: false,
			code: "invalid-client",
			detail: "registration rate key must equal the signed Peer ID",
		});
	});

	it("hard-bounds client tracking, rate, namespace, record, and response pressure", async () => {
		const server = registryServer("primary", new AdmissionPolicy({ inviteToken: INVITE }), () => NOW, {
			maxClients: 4,
			maxNamespaces: 2,
			maxRecordsPerClient: 1,
			maxRecordsPerNamespace: 1,
			maxRequestsPerNamespaceWindow: 2,
			maxRequestsPerWindow: 2,
			maxResponseRecords: 1,
		});
		const first = await signedRecord(5);
		const secondPeer = await signedRecord(6);
		const samePeerSecondNamespace = await signedRecord(5, { namespace: namespace(7) });
		const secondNamespace = await signedRecord(7, { namespace: namespace(7) });
		const thirdNamespace = await signedRecord(8, { namespace: namespace(8) });
		const register = (record: SignedDrpRecordV1): ReturnType<RegistryServer["register"]> =>
			server.register({
				clientId: record.peerId,
				credential: { kind: "invite", token: INVITE },
				record,
				signal: signal(),
			});

		expect(await register(first)).toMatchObject({ accepted: true });
		expect(await register(secondPeer)).toMatchObject({ code: "quota-exceeded" });
		expect(await register(samePeerSecondNamespace)).toMatchObject({ code: "quota-exceeded" });
		expect(await register(secondNamespace)).toMatchObject({ accepted: true });
		expect(await register(thirdNamespace)).toMatchObject({ code: "namespace-capacity-exceeded" });
		expect(await server.discover({ clientId: "client-c", namespace: first.namespace, signal: signal() })).toMatchObject(
			{
				code: "client-capacity-exceeded",
			}
		);
		expect(
			await server.discover({ clientId: first.peerId, namespace: first.namespace, signal: signal() })
		).toMatchObject({
			code: "rate-limited",
		});
	});

	it("reclaims rate-window client slots only after the configured window closes", async () => {
		let now = NOW;
		const server = registryServer("primary", new AdmissionPolicy({ inviteToken: INVITE }), () => now, {
			maxClients: 1,
			requestWindowMs: 1_000,
		});
		expect(await server.discover({ clientId: "client-a", namespace: namespace(1), signal: signal() })).toMatchObject({
			endpointId: "primary",
		});
		expect(await server.discover({ clientId: "client-b", namespace: namespace(1), signal: signal() })).toMatchObject({
			code: "client-capacity-exceeded",
		});
		now += 1_000;
		expect(await server.discover({ clientId: "client-b", namespace: namespace(1), signal: signal() })).toMatchObject({
			endpointId: "primary",
		});
	});

	it("enforces a namespace-client rate cap independently of the broader client window", async () => {
		const server = registryServer("primary", new AdmissionPolicy({ inviteToken: INVITE }), () => NOW, {
			maxRequestsPerNamespaceWindow: 2,
			maxRequestsPerWindow: 4,
		});
		for (const opaqueNamespace of [namespace(1), namespace(2)]) {
			expect(
				await server.discover({ clientId: "client-a", namespace: opaqueNamespace, signal: signal() })
			).toMatchObject({ endpointId: "primary" });
		}
		expect(await server.discover({ clientId: "client-a", namespace: namespace(1), signal: signal() })).toMatchObject({
			endpointId: "primary",
		});
		expect(await server.discover({ clientId: "client-a", namespace: namespace(1), signal: signal() })).toMatchObject({
			code: "rate-limited",
		});
	});

	it("reports one-endpoint and all-endpoint outage without unbounded retries", async () => {
		const primary = endpoint("primary");
		const secondary = endpoint("secondary");
		const client = registryClient([primary, secondary]);
		const record = await signedRecord(8);
		primary.setAvailable(false);
		expect(await client.register(record, signal(), { kind: "invite", token: INVITE })).toMatchObject({
			acceptedEndpointIds: ["secondary"],
		});
		secondary.setAvailable(false);
		await expect(client.discover(record.namespace, signal())).rejects.toMatchObject({
			name: "RegistryExhaustedError",
			operation: "discover",
			attempts: [
				{ code: "endpoint-unavailable", endpointId: "primary" },
				{ code: "endpoint-unavailable", endpointId: "secondary" },
			],
		});
		expect(client.lastAttempts).toHaveLength(2);
	});

	it("caps and revalidates malicious discovery responses at client ingress", async () => {
		const record = await signedRecord(9);
		const forged = { ...record, signature: mutate(record.signature) };
		const malicious = {
			id: "primary",
			register: (): ReturnType<RegistryServer["register"]> =>
				Promise.resolve({ accepted: false as const, code: "endpoint-unavailable" as const }),
			discover: (): ReturnType<RegistryServer["discover"]> =>
				Promise.resolve({
					endpointId: "primary",
					records: [
						{ admissionMode: "invite" as const, record: forged },
						...Array.from({ length: 64 }, () => ({ admissionMode: "invite" as const, record })),
					],
				}),
		};
		const secondary = endpoint("secondary");
		const client = registryClient([malicious, secondary], { maxResponseRecords: 64 });

		expect(await client.discover(record.namespace, signal())).toEqual([]);
		expect(client.lastAttempts).toEqual([
			{ code: "response-cap-exceeded", endpointId: "primary", operation: "discover", status: "rejected" },
			{ endpointId: "secondary", operation: "discover", status: "empty" },
		]);
	});

	it("fails over instead of treating an invalid non-empty response as an empty directory", async () => {
		const record = await signedRecord(90);
		const primary = {
			id: "primary",
			register: (): ReturnType<RegistryServer["register"]> =>
				Promise.resolve({ accepted: false as const, code: "endpoint-unavailable" as const }),
			discover: (): ReturnType<RegistryServer["discover"]> =>
				Promise.resolve({
					endpointId: "primary",
					records: [{ admissionMode: "invite" as const, record: { ...record, signature: mutate(record.signature) } }],
				}),
		};
		const client = registryClient([primary, endpoint("secondary")]);
		expect(await client.discover(record.namespace, signal())).toEqual([]);
		expect(client.lastAttempts).toEqual([
			{ code: "record-rejected", endpointId: "primary", operation: "discover", status: "rejected" },
			{ endpointId: "secondary", operation: "discover", status: "empty" },
		]);
	});

	it("converts endpoint exceptions and child timeouts into one bounded failover attempt", async () => {
		const throwing = {
			id: "primary",
			register: (): ReturnType<RegistryServer["register"]> => Promise.reject(new Error("transport-down")),
			discover: (): ReturnType<RegistryServer["discover"]> => Promise.reject(new Error("transport-down")),
		};
		const client = registryClient([throwing, endpoint("secondary")]);
		expect(await client.discover(namespace(1), signal())).toEqual([]);
		expect(client.lastAttempts).toEqual([
			{ code: "endpoint-unavailable", endpointId: "primary", operation: "discover", status: "rejected" },
			{ endpointId: "secondary", operation: "discover", status: "empty" },
		]);

		const hanging = {
			id: "primary",
			register: (): Promise<never> => new Promise(() => undefined),
			discover: (): Promise<never> => new Promise(() => undefined),
		};
		const started = performance.now();
		const bounded = new RegistryClient({
			backoffMs: 0,
			clientId: "browser-a",
			endpoints: [hanging, endpoint("secondary")],
			timeoutMs: 10,
			validatorFactory: (): RecordValidator => new RecordValidator({ now: (): number => NOW, resolver }),
		});
		expect(await bounded.discover(namespace(1), signal())).toEqual([]);
		expect(performance.now() - started).toBeLessThan(250);
		expect(bounded.lastAttempts).toEqual([
			{ code: "endpoint-unavailable", endpointId: "primary", operation: "discover", status: "rejected" },
			{ endpointId: "secondary", operation: "discover", status: "empty" },
		]);
	});

	it("propagates caller abort before contacting an endpoint", async () => {
		const controller = new AbortController();
		controller.abort(new Error("stop-registry"));
		await expect(
			registryClient([endpoint("primary"), endpoint("secondary")]).discover(namespace(1), controller.signal)
		).rejects.toThrow("stop-registry");
	});
});

describe("runtime admission policies", () => {
	it("makes invite the safe default, allowlists exact peers, and gates Sybil-unsafe open mode", async () => {
		expect(() => new AdmissionPolicy({ inviteToken: "too-short" })).toThrow("at least 16");
		expect(() => new AdmissionPolicy({ mode: "open" } as never)).toThrow();
		expect(
			() =>
				new AdmissionPolicy({
					limits: { maxDifficultyBits: 17, maxIterations: 1_024 },
					mode: "proof-of-work",
					secret: new Uint8Array(32),
				})
		).toThrow("eight difficulty search spaces");
		const record = await signedRecord(10);
		const allowlist = new AdmissionPolicy({ allowedPeerIds: [record.peerId], mode: "allowlist" });
		expect(await allowlist.evaluate({ clientId: "a", record, signal: signal() })).toEqual({
			accepted: true,
			mode: "allowlist",
		});
		const other = await signedRecord(11);
		expect(await allowlist.evaluate({ clientId: "a", record: other, signal: signal() })).toMatchObject({
			accepted: false,
			reason: "peer-not-allowlisted",
		});
		expect(
			await new AdmissionPolicy({ allowUnsafeOpen: true, mode: "open" }).evaluate({
				clientId: "a",
				record,
				signal: signal(),
			})
		).toMatchObject({ accepted: true, mode: "open", reason: "explicit-sybil-unsafe-canary" });
	});

	it("keeps explicit open admission bounded under a multi-identity Sybil flood", async () => {
		const server = registryServer("primary", new AdmissionPolicy({ allowUnsafeOpen: true, mode: "open" }), () => NOW, {
			maxClients: 3,
			maxRecordsPerNamespace: 8,
		});
		for (const index of [20, 21, 22]) {
			const record = await signedRecord(index);
			expect(
				await server.register({
					clientId: record.peerId,
					record,
					signal: signal(),
				})
			).toMatchObject({ accepted: true, admissionMode: "open" });
		}
		const blocked = await signedRecord(23);
		expect(
			await server.register({
				clientId: blocked.peerId,
				record: blocked,
				signal: signal(),
			})
		).toMatchObject({ accepted: false, code: "client-capacity-exceeded" });
	});

	it("bounds proof challenge capacity, adaptive difficulty, CPU work, expiry, replay, and bypass", async () => {
		let now = NOW;
		let nonce = 0;
		const policy = new AdmissionPolicy(
			{
				limits: {
					challengeTtlMs: 1_000,
					maxDifficultyBits: 10,
					maxIterations: 16_384,
					maxOutstandingChallenges: 2,
					minDifficultyBits: 8,
					pressureStep: 1,
				},
				mode: "proof-of-work",
				nonce: (): Uint8Array => Uint8Array.from({ length: 16 }, () => nonce++),
				secret: new Uint8Array(32).fill(7),
			},
			() => now
		);
		const record = await signedRecord(12);
		const secondRecord = await signedRecord(13);
		const thirdRecord = await signedRecord(14);
		const first = await policy.issueChallenge(record.namespace, record.peerId, record.peerId, signal());
		expect(isChallenge(first) && first.difficultyBits).toBe(8);
		expect(await policy.issueChallenge(record.namespace, record.peerId, record.peerId, signal())).toBe(first);
		const second = await policy.issueChallenge(
			secondRecord.namespace,
			secondRecord.peerId,
			secondRecord.peerId,
			signal()
		);
		expect(isChallenge(second) && second.difficultyBits).toBe(9);
		expect(
			await policy.issueChallenge(thirdRecord.namespace, thirdRecord.peerId, thirdRecord.peerId, signal())
		).toMatchObject({ code: "proof-challenge-capacity" });
		expect(await policy.issueChallenge(record.namespace, "rotated-client", record.peerId, signal())).toMatchObject({
			code: "proof-challenge-invalid",
		});
		if (!isChallenge(first)) throw new Error("missing proof challenge");
		const solved = await solveProofOfWork(first, 16_384, signal());
		expect(solved.iterations).toBeLessThanOrEqual(16_384);
		expect(solved.durationMs).toBeGreaterThanOrEqual(0);
		const accepted = await policy.evaluate({
			clientId: record.peerId,
			credential: { challenge: first, counter: solved.counter, kind: "proof-of-work" },
			record,
			signal: signal(),
		});
		expect(accepted).toEqual({ accepted: true, mode: "proof-of-work" });
		expect(
			await policy.evaluate({
				clientId: record.peerId,
				credential: { challenge: first, counter: solved.counter, kind: "proof-of-work" },
				record,
				signal: signal(),
			})
		).toMatchObject({ accepted: false, reason: "proof-challenge-replayed" });
		if (!isChallenge(second)) throw new Error("missing second proof challenge");
		expect(
			await policy.evaluate({
				clientId: "wrong-client",
				credential: { challenge: second, counter: 0, kind: "proof-of-work" },
				record: secondRecord,
				signal: signal(),
			})
		).toMatchObject({ accepted: false, reason: "proof-challenge-invalid" });
		now = second.expiresAtMs;
		expect(
			await policy.evaluate({
				clientId: secondRecord.peerId,
				credential: { challenge: second, counter: 0, kind: "proof-of-work" },
				record: secondRecord,
				signal: signal(),
			})
		).toMatchObject({ accepted: false, reason: "proof-challenge-expired" });
	});
});

describe("DHT anchor comparison", () => {
	it("publishes the versioned anchor CID through the real local Node DHT lifecycle", async () => {
		const server = await createNodeRouting({
			limits: { maxResults: 2 },
			mode: "server",
			network: "local",
		});
		const publisher = await createNodeRouting({
			bootstrapPeers: [],
			mode: "client",
			network: "local",
		});
		try {
			const status = await server.status(signal());
			const address = status.addresses.find(({ decision }) => decision.dialable)?.address;
			if (address === undefined) throw new Error("local anchor server has no dialable address");
			await publisher.connect(address.includes("/p2p/") ? address : `${address}/p2p/${server.peerId}`, signal());
			await publisher.waitForRoutingTable(1, signal());
			const anchor = new DhtAnchorPublisher(publisher);
			const opaqueNamespace = namespace(19);
			const publication = await anchor.publish(opaqueNamespace, signal());
			const providers: string[] = [];
			for await (const provider of server.findProviders(publication.cid, signal())) {
				providers.push(provider.peerId);
			}
			expect(publication.cid).toBe(await namespaceAnchorCid(opaqueNamespace));
			expect(providers).toContain(publisher.peerId);
			await anchor.stop(opaqueNamespace, signal());
			expect(publisher.measurements.some(({ operation }) => operation === "cancelReprovide")).toBe(true);
		} finally {
			await Promise.allSettled([publisher.stop(), server.stop()]);
		}
	}, 10_000);

	it("derives a stable versioned CID and refuses to advertise a browser peer", async () => {
		const opaqueNamespace = namespace(20);
		expect(await namespaceAnchorCid(opaqueNamespace)).toBe(await namespaceAnchorCid(opaqueNamespace));
		expect(await namespaceAnchorCid(opaqueNamespace)).not.toBe(await namespaceAnchorCid(namespace(21)));
		const calls: string[] = [];
		const cancelled: string[] = [];
		const publisher = new DhtAnchorPublisher({
			cancelReprovide: (cid: string): Promise<void> => {
				cancelled.push(cid);
				return Promise.resolve();
			},
			peerId: "anchor-peer",
			provide: (cid: string): Promise<{ cid: string }> => {
				calls.push(cid);
				return Promise.resolve({ cid });
			},
		});
		await expect(publisher.publish(opaqueNamespace, signal(), "browser-peer")).rejects.toBeInstanceOf(
			AnchorAdvertisementError
		);
		const published = await publisher.publish(opaqueNamespace, signal());
		expect(published).toMatchObject({ anchorPeerId: "anchor-peer", cid: calls[0], receipt: { cid: calls[0] } });
		expect(calls).toHaveLength(1);
		await publisher.publish(opaqueNamespace, signal());
		expect(calls).toHaveLength(2);
		await publisher.stop(opaqueNamespace, signal());
		expect(cancelled).toEqual([published.cid]);
	});

	it("resolves only capped Node-anchor candidates through delegated provider lookup", async () => {
		const peers = [
			routingPeer("unconfigured-provider"),
			routingPeer("anchor-a"),
			routingPeer("anchor-b"),
			routingPeer("anchor-c"),
		];
		const resolver = new DhtAnchorResolver(
			{
				async *findProviders(): AsyncIterable<BrowserRoutingPeer> {
					await Promise.resolve();
					yield* peers;
				},
			},
			["anchor-a", "anchor-b", "anchor-c"]
		);
		const result = await resolver.resolve(namespace(22), signal(), 2);
		expect(result.semantics).toBe("configured-node-anchor-only");
		expect(result.providers.map(({ peerId }) => peerId)).toEqual(["anchor-a", "anchor-b"]);
	});
});

describe("registry comparison fixture", () => {
	it("matches every deterministic oracle and emits no credential fields", async () => {
		const fixture = await createRegistryFixture();
		expect(fixture.cases).toHaveLength(10);
		expect(fixture.cases.every(({ passed }) => passed)).toBe(true);
		expect(fixture.admission.map(({ mode, registrationResult }) => [mode, registrationResult])).toEqual([
			["invite", "accepted"],
			["allowlist", "accepted"],
			["open", "accepted"],
			["proof-of-work", "accepted"],
		]);
		expect(fixture.privateCredentialFields).toBe(0);
		expect(fixture.comparison.every(({ dependencyHops, operationMs }) => dependencyHops > 0 && operationMs >= 0)).toBe(
			true
		);
		expect(JSON.stringify(fixture)).not.toContain(INVITE);
		expect(fixture.comparison).toHaveLength(2);
		expect(fixture.digest).toMatch(/^sha256:[A-Za-z0-9_-]{16}$/u);
	});
});

function endpoint(id: string): FixtureRegistryEndpoint {
	return new FixtureRegistryEndpoint(registryServer(id));
}

function registryServer(
	id: string,
	policy = new AdmissionPolicy({ inviteToken: INVITE }),
	now: () => number = () => NOW,
	limits?: ConstructorParameters<typeof RegistryServer>[0]["limits"]
): RegistryServer {
	return new RegistryServer({
		endpointId: id,
		limits,
		now,
		policy,
		validator: new RecordValidator({ now, resolver }),
	});
}

function registryClient(
	endpoints: ConstructorParameters<typeof RegistryClient>[0]["endpoints"],
	limits?: ConstructorParameters<typeof RegistryClient>[0]["limits"]
): RegistryClient {
	return new RegistryClient({
		backoffMs: 0,
		clientId: "browser-a",
		endpoints,
		limits,
		timeoutMs: 1_000,
		validatorFactory: () => new RecordValidator({ now: () => NOW, resolver }),
	});
}

async function signedRecord(
	index: number,
	overrides: Partial<Parameters<RecordSigner["sign"]>[0]> = {}
): Promise<SignedDrpRecordV1> {
	const key = await generateKeyPairFromSeed("Ed25519", seed(index));
	const peerId = peerIdFromPublicKey(key.publicKey).toString();
	return new RecordSigner(key).sign({
		addresses: [`/dns4/relay.example.test/tcp/443/wss/p2p/${peerId}`],
		capabilities: ["drp-gossipsub", "webrtc"],
		expiresAtMs: NOW + 60_000,
		issuedAtMs: NOW,
		namespace: namespace(1),
		sequence: 1,
		...overrides,
	});
}

function namespace(index: number): string {
	return createOpaqueNamespaceV1(Uint8Array.from({ length: 32 }, (_, offset) => (index + offset) % 256));
}

function seed(index: number): Uint8Array {
	return Uint8Array.from({ length: 32 }, (_, offset) => (index * 17 + offset) % 256);
}

function signal(): AbortSignal {
	return new AbortController().signal;
}

function mutate(value: string): string {
	return `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
}

function isChallenge(value: ProofOfWorkChallengeV1 | { accepted: false }): value is ProofOfWorkChallengeV1 {
	return "kind" in value && value.kind === "ts-drp-registry-proof";
}

function routingPeer(peerId: string): BrowserRoutingPeer {
	return {
		acceptedAddresses: [],
		addressDecisions: [],
		inputAddressCount: 0,
		peerId,
		protocols: [],
		rawAddresses: [],
		truncatedAddressCount: 0,
	};
}
