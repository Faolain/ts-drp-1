import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
	DEFAULT_REGISTRY_LIMITS,
	type RecordValidationContext,
	type RecordValidator,
	type RegistryAttempt,
	RegistryExhaustedError,
	type RendezvousDirectory,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it, vi } from "vitest";

import { NAMESPACE, NOW, signedFixture, validator } from "./fixtures.js";

interface NostrEvent {
	readonly id: string;
	readonly pubkey: string;
	readonly created_at: number;
	readonly kind: number;
	readonly tags: readonly (readonly string[])[];
	readonly content: string;
	readonly sig: string;
}

interface NostrFilter {
	readonly kinds?: readonly number[];
	readonly limit?: number;
	readonly [tagName: `#${string}`]: readonly string[] | readonly number[] | number | undefined;
}

interface NostrPublishResult {
	readonly accepted: boolean;
	readonly message?: string;
}

interface NostrRelayEndpoint {
	readonly id: string;
	readonly url: string;
}

interface NostrRelayConnection {
	close(): Promise<void> | void;
	publish(event: NostrEvent, signal: AbortSignal): Promise<NostrPublishResult>;
	query(filter: NostrFilter, signal: AbortSignal): AsyncIterable<NostrEvent>;
}

type NostrRelayConnectionFactory = (relay: NostrRelayEndpoint, signal: AbortSignal) => Promise<NostrRelayConnection>;

interface NostrSigner {
	getPublicKey(signal: AbortSignal): Promise<string> | string;
	signEventId(eventId: string, signal: AbortSignal): Promise<string> | string;
}

interface NostrRelayDirectoryOptions {
	readonly allow_insecure_loopback_fixture?: boolean;
	readonly connectionFactory: NostrRelayConnectionFactory;
	readonly limits?: {
		readonly maxResponseRecords?: number;
		readonly requestTimeoutMs?: number;
	};
	readonly nostrSigner: NostrSigner;
	now(): number;
	readonly relays: readonly NostrRelayEndpoint[];
	validatorFactory(): RecordValidator;
}

interface NostrRelayDirectory extends RendezvousDirectory {
	readonly lastAttempts: readonly RegistryAttempt[];
}

interface NostrDirectoryModule {
	readonly NostrRelayDirectory: new (options: NostrRelayDirectoryOptions) => NostrRelayDirectory;
	readonly NostrRecordValidationError: new (code: string, detail?: string) => Error & { readonly code: string };
	readonly NostrRelayConfigurationError: new (message: string) => Error;
	readonly NostrSignerConfigurationError: new (message: string) => Error;
	createNostrSignerFromSecretKey(secretKey: Uint8Array): NostrSigner;
	createNostrRelayDirectory(options: NostrRelayDirectoryOptions): NostrRelayDirectory;
}

const TRANSPORT_PUBLIC_KEY = "11".repeat(32);
const TRANSPORT_SIGNATURE = "22".repeat(64);
const OTHER_NAMESPACE = `drp-network:v1:${"b".repeat(43)}`;
const encoder = new TextEncoder();

describe("NostrRelayDirectory", () => {
	it("exports a constructible directory and factory through the public package", async () => {
		const loaded = await loadNostrModule();

		expect(loaded.createNostrRelayDirectory, "rendezvous must export createNostrRelayDirectory").toBeTypeOf("function");
		expect(loaded.NostrRelayDirectory, "rendezvous must export NostrRelayDirectory").toBeTypeOf("function");
	});

	it("publishes to every relay and succeeds when at least one relay accepts", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const pool = new FakeRelayPool([
			new FakeRelay("relay-a"),
			new FakeRelay("relay-b", { publish: { accepted: false, message: "blocked" } }),
			new FakeRelay("relay-c", { publish: new Error("socket closed") }),
		]);
		const directory = createDirectory(options(pool));
		const record = await signedFixture(701);

		await expect(directory.register(record, signal())).resolves.toEqual({
			acceptedEndpointIds: ["relay-a"],
			attempts: [
				{ endpointId: "relay-a", operation: "register", status: "accepted" },
				{ code: "endpoint-unavailable", endpointId: "relay-b", operation: "register", status: "rejected" },
				{ code: "endpoint-unavailable", endpointId: "relay-c", operation: "register", status: "rejected" },
			],
			sequence: record.sequence,
		});
		expect(pool.relays.map((relay) => relay.publishCalls)).toEqual([1, 1, 1]);
		expect(pool.activeConnections).toBe(0);
	});

	it("throws a typed register exhaustion after every relay rejects or fails", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const pool = new FakeRelayPool([
			new FakeRelay("relay-a", { publish: { accepted: false } }),
			new FakeRelay("relay-b", { publish: new Error("offline") }),
		]);
		const directory = createDirectory(options(pool));

		const terminal = await captureRejection(directory.register(await signedFixture(702), signal()));

		expect(terminal).toBeInstanceOf(RegistryExhaustedError);
		expect(terminal).toMatchObject({
			operation: "register",
			attempts: [
				{ code: "endpoint-unavailable", endpointId: "relay-a", operation: "register", status: "rejected" },
				{ code: "endpoint-unavailable", endpointId: "relay-b", operation: "register", status: "rejected" },
			],
		});
		expect(pool.activeConnections).toBe(0);
	});

	it("rejects an invalid record before signing or publishing", async () => {
		const loaded = await loadNostrModule();
		expect(loaded.NostrRecordValidationError).toBeTypeOf("function");
		const createDirectory = await loadFactory();
		if (createDirectory === undefined || loaded.NostrRecordValidationError === undefined) return;
		const relay = new FakeRelay("relay-a");
		const pool = new FakeRelayPool([relay]);
		const directory = createDirectory(options(pool));
		const expired = await signedFixture(723, { expiresAtMs: NOW - 1, issuedAtMs: NOW - 60_001 });

		const terminal = await captureRejection(directory.register(expired, signal()));

		expect(terminal).toBeInstanceOf(loaded.NostrRecordValidationError);
		expect(terminal).toMatchObject({ code: "expired" });
		expect(pool.signerCalls).toEqual([]);
		expect(relay.publishCalls).toBe(0);
		expect(pool.activeConnections).toBe(0);
	});

	it("bounds a hanging publish, reports endpoint-unavailable, and still accepts another relay", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const hanging = new FakeRelay("hanging-relay", { publish: "hang" });
		const pool = new FakeRelayPool([hanging, new FakeRelay("healthy-relay")]);
		const directory = createDirectory(options(pool, { limits: { requestTimeoutMs: 20 } }));
		const record = await signedFixture(717);
		const startedAt = performance.now();

		await expect(directory.register(record, signal())).resolves.toEqual({
			acceptedEndpointIds: ["healthy-relay"],
			attempts: [
				{
					code: "endpoint-unavailable",
					endpointId: "hanging-relay",
					operation: "register",
					status: "rejected",
				},
				{ endpointId: "healthy-relay", operation: "register", status: "accepted" },
			],
			sequence: record.sequence,
		});
		expect(performance.now() - startedAt).toBeLessThan(500);
		expect(hanging.abortListenerCount).toBe(0);
		expect(pool.activeConnections).toBe(0);
	});

	it("bounds a signer that never resolves before opening relay connections", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const relay = new FakeRelay("relay-a");
		const pool = new FakeRelayPool([relay]);
		const hangingSigner: NostrSigner = {
			getPublicKey: (): Promise<string> => new Promise<string>(() => undefined),
			signEventId: (): string => TRANSPORT_SIGNATURE,
		};
		const directory = createDirectory(options(pool, { limits: { requestTimeoutMs: 20 }, nostrSigner: hangingSigner }));
		const terminal = directory.register(await signedFixture(721), signal());
		const outcome = await Promise.race([
			terminal.then(
				() => "resolved",
				() => "rejected"
			),
			new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 150)),
		]);

		expect(outcome).toBe("rejected");
		await expect(terminal).rejects.toThrow(/timed out/iu);
		expect(relay.publishCalls).toBe(0);
		expect(pool.activeConnections).toBe(0);
	});

	it("rejects a caller-aborted signing deadline without a macrotask delay", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const pool = new FakeRelayPool([new FakeRelay("relay-a")]);
		const hangingSigner: NostrSigner = {
			getPublicKey: (): Promise<string> => new Promise<string>(() => undefined),
			signEventId: (): string => TRANSPORT_SIGNATURE,
		};
		const directory = createDirectory(options(pool, { nostrSigner: hangingSigner }));
		const controller = new AbortController();
		const reason = new Error("caller stopped signing");
		const terminal = directory.register(await signedFixture(722), controller.signal);
		let observed: unknown;
		void terminal.catch((error: unknown) => {
			observed = error;
		});

		controller.abort(reason);
		for (let index = 0; index < 10; index += 1) await Promise.resolve();

		expect(observed).toBe(reason);
		await expect(terminal).rejects.toBe(reason);
		expect(pool.activeConnections).toBe(0);
	});

	it("emits a NIP-01 addressable event with deterministic replacement and advisory expiry tags", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const relay = new FakeRelay("relay-a");
		const pool = new FakeRelayPool([relay]);
		const directory = createDirectory(options(pool));
		const first = await signedFixture(703);
		const replacement = await signedFixture(703, {
			expiresAtMs: NOW + 70_000,
			issuedAtMs: NOW + 10_000,
			sequence: 2,
		});
		const otherPeer = await signedFixture(704);

		await expect(directory.register(first, signal())).resolves.toMatchObject({ sequence: 1 });
		const firstEvent = relay.publishedEvents[0];
		await expect(directory.register(replacement, signal())).resolves.toMatchObject({ sequence: 2 });
		const replacementEvent = relay.publishedEvents[1];
		await expect(directory.register(otherPeer, signal())).resolves.toMatchObject({ sequence: 1 });

		expect(firstEvent).toBeDefined();
		expect(replacementEvent).toBeDefined();
		if (firstEvent === undefined || replacementEvent === undefined) return;
		expect(firstEvent.kind).toBeGreaterThanOrEqual(30_000);
		expect(firstEvent.kind).toBeLessThanOrEqual(39_999);
		expect(firstEvent.created_at).toBe(Math.floor(NOW / 1_000));
		expect(replacementEvent.created_at).toBeGreaterThan(firstEvent.created_at);
		expect(firstEvent.pubkey).toBe(TRANSPORT_PUBLIC_KEY);
		expect(firstEvent.pubkey).toMatch(/^[0-9a-f]{64}$/u);
		expect(firstEvent.id).toMatch(/^[0-9a-f]{64}$/u);
		expect(firstEvent.sig).toMatch(/^[0-9a-f]{128}$/u);
		expect(firstEvent.sig).toBe(TRANSPORT_SIGNATURE);
		expect(firstEvent.content).toBe(JSON.stringify(first));
		expect(JSON.parse(firstEvent.content)).toEqual(first);
		expect(firstEvent.tags).toContainEqual(["expiration", String(Math.floor(first.expiresAtMs / 1_000))]);
		expect(firstEvent.tags.some((tag) => tag[1] === first.namespace)).toBe(true);
		const firstD = requiredTag(firstEvent, "d");
		const replacementD = requiredTag(replacementEvent, "d");
		const otherD = requiredTag(relay.publishedEvents[2] as NostrEvent, "d");
		expect(replacementD).toBe(firstD);
		expect(otherD).not.toBe(firstD);
		expect(relay.storedEvents).toHaveLength(2);
		expect(relay.storedEvents).toContain(replacementEvent);
		expect(relay.storedEvents).not.toContain(firstEvent);
		expect(await nip01Id(firstEvent)).toBe(firstEvent.id);
		expect(await nip01Id(replacementEvent)).toBe(replacementEvent.id);
		expect(pool.signerCalls).toEqual([firstEvent.id, replacementEvent.id, relay.publishedEvents[2]?.id]);
		expect(pool.activeConnections).toBe(0);
	});

	it("signs a published NIP-01 event with the real BIP-340 signer", async () => {
		const loaded = await loadNostrModule();
		expect(loaded.createNostrSignerFromSecretKey).toBeTypeOf("function");
		if (loaded.createNostrSignerFromSecretKey === undefined) return;
		const relay = new FakeRelay("relay-a");
		const pool = new FakeRelayPool([relay]);
		const secretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
		const nostrSigner = loaded.createNostrSignerFromSecretKey(secretKey);
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const directory = createDirectory(options(pool, { nostrSigner }));

		await directory.register(await signedFixture(720), signal());

		const event = relay.publishedEvents[0];
		expect(event).toBeDefined();
		if (event === undefined) return;
		expect(event.id).toBe(await nip01Id(event));
		expect(event.pubkey).toBe(await nostrSigner.getPublicKey(signal()));
		expect(schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))).toBe(true);
	});

	it("rejects a malformed Nostr secret key with a typed public error", async () => {
		const loaded = await loadNostrModule();
		expect(loaded.createNostrSignerFromSecretKey).toBeTypeOf("function");
		expect(loaded.NostrSignerConfigurationError).toBeTypeOf("function");
		if (loaded.createNostrSignerFromSecretKey === undefined || loaded.NostrSignerConfigurationError === undefined) {
			return;
		}

		expect(() => loaded.createNostrSignerFromSecretKey?.(new Uint8Array(31))).toThrow(
			loaded.NostrSignerConfigurationError
		);
		expect(() => loaded.createNostrSignerFromSecretKey?.(new Uint8Array(31))).toThrow(/32-byte/iu);
	});

	it("queries every relay, revalidates with open admission, and reconciles the highest sequence", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const older = await signedFixture(705);
		const newer = await signedFixture(705, {
			expiresAtMs: NOW + 70_000,
			issuedAtMs: NOW + 10_000,
			sequence: 2,
		});
		const other = await signedFixture(706);
		const pool = new FakeRelayPool([
			new FakeRelay("relay-a", { events: [await eventFor(older), await eventFor(other)] }),
			new FakeRelay("relay-b", { events: [await eventFor(newer)] }),
		]);
		const contexts: RecordValidationContext[] = [];
		let validatorCount = 0;
		const directory = createDirectory(
			options(pool, {
				validatorFactory: (): RecordValidator => {
					validatorCount += 1;
					const instance = validator();
					const validate = instance.validate.bind(instance);
					vi.spyOn(instance, "validate").mockImplementation(async (input, context) => {
						contexts.push(context);
						return validate(input, context);
					});
					return instance;
				},
			})
		);

		const discovered = await directory.discover(NAMESPACE, signal());
		expect(discovered).toHaveLength(2);
		expect(discovered.find(({ record }) => record.peerId === other.peerId)).toMatchObject({
			admissionMode: "open",
			sourceEndpointId: "relay-a",
		});
		expect(discovered.find(({ record }) => record.peerId === newer.peerId)).toMatchObject({
			admissionMode: "open",
			record: { sequence: 2 },
			sourceEndpointId: "relay-b",
		});
		expect(validatorCount).toBe(2);
		expect(contexts).toHaveLength(3);
		for (const context of contexts) {
			expect(context).toMatchObject({ admission: { accepted: true, mode: "open" }, expectedNamespace: NAMESPACE });
			expect(context.signal).toBeInstanceOf(AbortSignal);
		}
		expect(pool.relays.map((relay) => relay.queryCalls)).toEqual([1, 1]);
		expect(pool.relays.flatMap((relay) => relay.filters).every(filterContainsNamespace)).toBe(true);
		expect(pool.activeConnections).toBe(0);
	});

	it("honors excluded relay IDs and preferred relay order", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const pool = new FakeRelayPool([new FakeRelay("relay-a"), new FakeRelay("relay-b"), new FakeRelay("relay-c")]);
		const directory = createDirectory(options(pool));

		await expect(
			directory.discover(NAMESPACE, signal(), {
				excludeBackendIds: ["relay-a"],
				preferredRegistryIds: ["relay-c", "relay-b"],
			})
		).resolves.toEqual([]);
		expect(pool.connectionOrder).toEqual(["relay-c", "relay-b"]);
		expect(directory.lastAttempts).toEqual([
			{ endpointId: "relay-c", operation: "discover", status: "empty" },
			{ endpointId: "relay-b", operation: "discover", status: "empty" },
		]);
		expect(pool.activeConnections).toBe(0);
	});

	it("rejects an invalid embedded DRP signature even when the Nostr envelope is well formed", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const record = await signedFixture(707);
		const otherwiseValid = await signedFixture(718);
		const forged = { ...record, signature: mutate(record.signature) };
		const pool = new FakeRelayPool([
			new FakeRelay("forged-relay", {
				events: [await eventFor(forged), null as unknown as NostrEvent, await eventFor(otherwiseValid)],
			}),
			new FakeRelay("healthy-relay"),
		]);
		const directory = createDirectory(options(pool));

		await expect(directory.discover(NAMESPACE, signal())).resolves.toMatchObject([
			{ record: { peerId: otherwiseValid.peerId }, sourceEndpointId: "forged-relay" },
		]);
		expect(directory.lastAttempts).toEqual([
			{ endpointId: "forged-relay", operation: "discover", status: "accepted" },
			{ endpointId: "healthy-relay", operation: "discover", status: "empty" },
		]);
		expect(pool.activeConnections).toBe(0);
	});

	it("drops a relay snapshot whose content was tampered while retaining an honest peer", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const tamperedRecord = await signedFixture(708);
		const honestRecord = await signedFixture(709);
		const tampered = { ...tamperedRecord, addresses: [honestRecord.addresses[0] as string] };
		const pool = new FakeRelayPool([
			new FakeRelay("tampering-relay", { events: [await eventFor(tampered)] }),
			new FakeRelay("honest-relay", { events: [await eventFor(honestRecord, "77".repeat(32))] }),
		]);
		const directory = createDirectory(options(pool));

		const discovered = await directory.discover(NAMESPACE, signal());

		expect(discovered.map(({ record }) => record.peerId)).toEqual([honestRecord.peerId]);
		expect(discovered.some(({ record }) => record.peerId === tamperedRecord.peerId)).toBe(false);
		expect(pool.activeConnections).toBe(0);
	});

	it("rejects embedded Peer ID/public-key mismatch and a signed record from another namespace", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const first = await signedFixture(710);
		const otherIdentity = await signedFixture(711);
		const mismatchedIdentity = { ...first, peerId: otherIdentity.peerId };
		const wrongNamespace = await signedFixture(712, { namespace: OTHER_NAMESPACE });
		const pool = new FakeRelayPool([
			new FakeRelay("identity-relay", { events: [await eventFor(mismatchedIdentity)] }),
			new FakeRelay("namespace-relay", { events: [await eventFor(wrongNamespace)] }),
			new FakeRelay("healthy-relay"),
		]);
		const directory = createDirectory(options(pool));

		await expect(directory.discover(NAMESPACE, signal())).resolves.toEqual([]);
		expect(directory.lastAttempts).toEqual([
			{ endpointId: "identity-relay", operation: "discover", status: "empty" },
			{ endpointId: "namespace-relay", operation: "discover", status: "empty" },
			{ endpointId: "healthy-relay", operation: "discover", status: "empty" },
		]);
		expect(pool.activeConnections).toBe(0);
	});

	it("enforces embedded expiry locally even when a relay still returns the event", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const expired = await signedFixture(713, { expiresAtMs: NOW - 1, issuedAtMs: NOW - 60_001 });
		const nip40ExpiredRecord = await signedFixture(719);
		const nip40ExpiredEvent = await eventFor(nip40ExpiredRecord);
		const expiredTagIndex = nip40ExpiredEvent.tags.findIndex((tag) => tag[0] === "expiration");
		const expiredTags = nip40ExpiredEvent.tags.map((tag, index) =>
			index === expiredTagIndex ? (["expiration", String(Math.floor(NOW / 1_000) - 1)] as const) : tag
		);
		const taggedEvent = await eventWithTags(nip40ExpiredEvent, expiredTags);
		const nip40Expired = { ...taggedEvent, id: "00".repeat(32), sig: "not-a-valid-envelope-signature" };
		const fresh = await signedFixture(714);
		const pool = new FakeRelayPool([
			new FakeRelay("stale-relay", { events: [await eventFor(expired)] }),
			new FakeRelay("nip40-stale-relay", { events: [nip40Expired] }),
			new FakeRelay("fresh-relay", { events: [await eventFor(fresh)] }),
		]);
		const directory = createDirectory(options(pool));

		const discovered = await directory.discover(NAMESPACE, signal());
		expect(discovered.map(({ record }) => record.peerId)).toEqual(
			expect.arrayContaining([nip40ExpiredRecord.peerId, fresh.peerId])
		);
		expect(discovered.map(({ record }) => record.peerId)).not.toContain(expired.peerId);
		expect(directory.lastAttempts[0]).toMatchObject({
			endpointId: "stale-relay",
			status: "empty",
		});
		expect(directory.lastAttempts[1]).toMatchObject({
			endpointId: "nip40-stale-relay",
			status: "accepted",
		});
		expect(pool.activeConnections).toBe(0);
	});

	it("drops both equal-sequence conflicting records returned by independent relays", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const first = await signedFixture(715);
		const conflict = await signedFixture(715, {
			addresses: [first.addresses[0]?.replace("/4001/", "/4002/") as string],
		});
		const pool = new FakeRelayPool([
			new FakeRelay("relay-a", { events: [await eventFor(first)] }),
			new FakeRelay("relay-b", { events: [await eventFor(conflict)] }),
		]);
		const directory = createDirectory(options(pool));

		await expect(directory.discover(NAMESPACE, signal())).resolves.toEqual([]);
		expect(directory.lastAttempts.every(({ status }) => status === "accepted")).toBe(true);
		expect(pool.activeConnections).toBe(0);
	});

	it("accepts a DRP-signed record published under an unrelated Nostr transport key", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const record = await signedFixture(716);
		const unrelatedNostrKey = "ab".repeat(32);
		const event = await eventFor(record, unrelatedNostrKey);
		const pool = new FakeRelayPool([new FakeRelay("relay-a", { events: [event] })]);
		const directory = createDirectory(options(pool));

		expect(unrelatedNostrKey).not.toContain(record.peerId);
		await expect(directory.discover(NAMESPACE, signal())).resolves.toMatchObject([
			{ admissionMode: "open", record: { peerId: record.peerId }, sourceEndpointId: "relay-a" },
		]);
		expect(pool.activeConnections).toBe(0);
	});

	it("requires at least one uniquely named secure relay and gates plaintext loopback fixtures", async () => {
		const loaded = await loadNostrModule();
		const createDirectory = loaded.createNostrRelayDirectory;
		expect(createDirectory).toBeTypeOf("function");
		expect(loaded.NostrRelayConfigurationError).toBeTypeOf("function");
		if (createDirectory === undefined || loaded.NostrRelayConfigurationError === undefined) return;
		const pool = new FakeRelayPool([]);
		const construct =
			(relays: readonly NostrRelayEndpoint[], allow = false): (() => NostrRelayDirectory) =>
			() =>
				createDirectory(options(pool, { allow_insecure_loopback_fixture: allow, relays }));

		expect(construct([])).toThrow(/at least one|requires.*relay/iu);
		expect(construct([{ id: "relay-a", url: "wss://relay.example" }])).not.toThrow();
		expect(construct([{ id: "relay-a", url: "ws://relay.example" }])).toThrow(/wss|loopback/iu);
		expect(construct([{ id: "relay-a", url: "ws://relay.example" }], true)).toThrow(/wss|loopback/iu);
		expect(construct([{ id: "relay-a", url: "ws://127.0.0.1:7447" }], true)).not.toThrow();
		expect(construct([{ id: "relay-a", url: "ws://localhost:7447" }], true)).not.toThrow();
		expect(construct([{ id: "relay-a", url: "https://relay.example" }])).toThrow(/wss/iu);
		expect(construct([{ id: "relay-a", url: "not a URL" }])).toThrow();
		expect(construct([{ id: "BAD ID", url: "wss://relay.example" }])).toThrow(/id/iu);
		expect(
			construct([
				{ id: "relay-a", url: "wss://one.example" },
				{ id: "relay-a", url: "wss://two.example" },
			])
		).toThrow(/unique/iu);
		expect(
			construct([
				{ id: "relay-a", url: "wss://relay.example" },
				{ id: "relay-b", url: "wss://relay.example/" },
			])
		).toThrow(loaded.NostrRelayConfigurationError);
		expect(
			construct([
				{ id: "relay-a", url: "wss://relay.example" },
				{ id: "relay-b", url: "wss://relay.example/" },
			])
		).toThrow(/URL.*unique|unique.*URL/iu);
	});

	it("keeps early valid records when a relay flood reaches the response cap", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const cap = DEFAULT_REGISTRY_LIMITS.maxResponseRecords;
		const floodHonest = await signedFixture(800);
		const healthyHonest = await signedFixture(900);
		const malformed = { ...(await eventFor(floodHonest)), content: "{" };
		const pool = new FakeRelayPool([
			new FakeRelay("flood-relay", {
				events: [await eventFor(floodHonest), ...Array.from({ length: cap + 1 }, () => malformed)],
			}),
			new FakeRelay("healthy-relay", { events: [await eventFor(healthyHonest)] }),
		]);
		const directory = createDirectory(options(pool));

		const discovered = await directory.discover(NAMESPACE, signal());
		expect(discovered).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					record: expect.objectContaining({ peerId: floodHonest.peerId }),
					sourceEndpointId: "flood-relay",
				}),
				expect.objectContaining({
					record: expect.objectContaining({ peerId: healthyHonest.peerId }),
					sourceEndpointId: "healthy-relay",
				}),
			])
		);
		expect(directory.lastAttempts).toEqual([
			{ endpointId: "flood-relay", operation: "discover", status: "accepted" },
			{ endpointId: "healthy-relay", operation: "discover", status: "accepted" },
		]);
		expect(pool.activeConnections).toBe(0);
	});

	it("times out a relay that never completes EOSE, cleans up, and returns a responsive result", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const record = await signedFixture(901);
		const hanging = new FakeRelay("hanging-relay", { query: "hang" });
		const pool = new FakeRelayPool([hanging, new FakeRelay("healthy-relay", { events: [await eventFor(record)] })]);
		const directory = createDirectory(options(pool, { limits: { requestTimeoutMs: 20 } }));
		const startedAt = performance.now();

		await expect(directory.discover(NAMESPACE, signal())).resolves.toMatchObject([
			{ record: { peerId: record.peerId }, sourceEndpointId: "healthy-relay" },
		]);
		expect(performance.now() - startedAt).toBeLessThan(500);
		expect(directory.lastAttempts[0]).toEqual({
			code: "endpoint-unavailable",
			endpointId: "hanging-relay",
			operation: "discover",
			status: "rejected",
		});
		expect(hanging.abortListenerCount).toBe(0);
		expect(pool.activeConnections).toBe(0);
	});

	it("propagates caller abort promptly and removes relay listeners and connections", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const hanging = new FakeRelay("hanging-relay", { query: "hang" });
		const pool = new FakeRelayPool([hanging]);
		const directory = createDirectory(options(pool, { limits: { requestTimeoutMs: 1_000 } }));
		const controller = new AbortController();
		const reason = new Error("caller stopped discovery");
		const startedAt = performance.now();
		const terminal = directory.discover(NAMESPACE, controller.signal);
		setTimeout(() => controller.abort(reason), 10);

		await expect(terminal).rejects.toBe(reason);
		expect(performance.now() - startedAt).toBeLessThan(250);
		expect(hanging.abortListenerCount).toBe(0);
		expect(pool.activeConnections).toBe(0);
	});

	it("throws discover exhaustion when no relay reaches a healthy terminal", async () => {
		const createDirectory = await loadFactory();
		if (createDirectory === undefined) return;
		const pool = new FakeRelayPool([
			new FakeRelay("relay-a", { query: new Error("offline") }),
			new FakeRelay("relay-b", { query: new Error("refused") }),
		]);
		const directory = createDirectory(options(pool));

		const terminal = await captureRejection(directory.discover(NAMESPACE, signal()));

		expect(terminal).toBeInstanceOf(RegistryExhaustedError);
		expect(terminal).toMatchObject({
			operation: "discover",
			attempts: [
				{ code: "endpoint-unavailable", endpointId: "relay-a", operation: "discover", status: "rejected" },
				{ code: "endpoint-unavailable", endpointId: "relay-b", operation: "discover", status: "rejected" },
			],
		});
		expect(pool.activeConnections).toBe(0);
	});
});

class FakeRelay {
	readonly id: string;
	abortListenerCount = 0;
	readonly filters: NostrFilter[] = [];
	publishCalls = 0;
	readonly publishedEvents: NostrEvent[] = [];
	queryCalls = 0;
	readonly storedEvents: NostrEvent[] = [];
	readonly #publishBehavior: NostrPublishResult | "hang" | Error;
	readonly #queryBehavior: "events" | "hang" | Error;

	constructor(
		id: string,
		options: {
			readonly events?: readonly NostrEvent[];
			readonly publish?: NostrPublishResult | "hang" | Error;
			readonly query?: "hang" | Error;
		} = {}
	) {
		this.id = id;
		this.#publishBehavior = options.publish ?? { accepted: true };
		this.#queryBehavior = options.query ?? "events";
		this.storedEvents.push(...(options.events ?? []));
	}

	async publish(event: NostrEvent, signal: AbortSignal): Promise<NostrPublishResult> {
		this.publishCalls += 1;
		this.publishedEvents.push(event);
		signal.throwIfAborted();
		if (this.#publishBehavior instanceof Error) throw this.#publishBehavior;
		if (this.#publishBehavior === "hang") return this.waitForAbort(signal);
		if (this.#publishBehavior.accepted) this.storeReplaceable(event);
		return this.#publishBehavior;
	}

	async *query(filter: NostrFilter, signal: AbortSignal): AsyncIterable<NostrEvent> {
		this.queryCalls += 1;
		this.filters.push(filter);
		signal.throwIfAborted();
		if (this.#queryBehavior instanceof Error) throw this.#queryBehavior;
		if (this.#queryBehavior === "hang") {
			await this.waitForAbort(signal);
			return;
		}
		for (const event of this.storedEvents) {
			signal.throwIfAborted();
			yield event;
		}
	}

	private storeReplaceable(event: NostrEvent): void {
		const d = requiredTag(event, "d");
		const prior = this.storedEvents.findIndex(
			(candidate) =>
				candidate.pubkey === event.pubkey && candidate.kind === event.kind && requiredTag(candidate, "d") === d
		);
		if (prior === -1) this.storedEvents.push(event);
		else this.storedEvents.splice(prior, 1, event);
	}

	private async waitForAbort(signal: AbortSignal): Promise<never> {
		let listener: (() => void) | undefined;
		try {
			await new Promise<never>((_resolve, reject) => {
				listener = (): void => reject(signal.reason);
				this.abortListenerCount += 1;
				signal.addEventListener("abort", listener, { once: true });
			});
			throw new Error("unreachable relay hang terminal");
		} finally {
			if (listener !== undefined) {
				signal.removeEventListener("abort", listener);
				this.abortListenerCount -= 1;
			}
		}
	}
}

class FakeRelayPool {
	activeConnections = 0;
	readonly connectionOrder: string[] = [];
	readonly relays: readonly FakeRelay[];
	readonly signerCalls: string[] = [];

	constructor(relays: readonly FakeRelay[]) {
		this.relays = relays;
	}

	readonly connectionFactory: NostrRelayConnectionFactory = (endpoint, signal) => {
		signal.throwIfAborted();
		const relay = this.relays.find(({ id }) => id === endpoint.id);
		if (relay === undefined) throw new Error(`unknown fake relay ${endpoint.id}`);
		this.connectionOrder.push(endpoint.id);
		this.activeConnections += 1;
		let closed = false;
		return Promise.resolve({
			close: (): void => {
				if (closed) return;
				closed = true;
				this.activeConnections -= 1;
			},
			publish: (event, operationSignal) => relay.publish(event, operationSignal),
			query: (filter, operationSignal) => relay.query(filter, operationSignal),
		});
	};

	readonly signer: NostrSigner = {
		getPublicKey: (operationSignal): string => {
			operationSignal.throwIfAborted();
			return TRANSPORT_PUBLIC_KEY;
		},
		signEventId: (eventId, operationSignal): string => {
			operationSignal.throwIfAborted();
			this.signerCalls.push(eventId);
			return TRANSPORT_SIGNATURE;
		},
	};
}

function options(pool: FakeRelayPool, overrides: Partial<NostrRelayDirectoryOptions> = {}): NostrRelayDirectoryOptions {
	return {
		connectionFactory: pool.connectionFactory,
		nostrSigner: pool.signer,
		now: (): number => NOW,
		relays: pool.relays.map(({ id }) => ({ id, url: `wss://${id}.example` })),
		validatorFactory: (): RecordValidator => validator(),
		...overrides,
	};
}

async function loadNostrModule(): Promise<Partial<NostrDirectoryModule>> {
	return (await import("@ts-drp/rendezvous")) as unknown as Partial<NostrDirectoryModule>;
}

async function loadFactory(): Promise<NostrDirectoryModule["createNostrRelayDirectory"] | undefined> {
	const loaded = await loadNostrModule();
	expect(loaded.createNostrRelayDirectory, "rendezvous must export createNostrRelayDirectory").toBeTypeOf("function");
	return loaded.createNostrRelayDirectory;
}

async function eventFor(record: SignedDrpRecordV1, pubkey = TRANSPORT_PUBLIC_KEY): Promise<NostrEvent> {
	const unsigned = {
		pubkey,
		created_at: Math.floor(NOW / 1_000),
		kind: 30_078,
		tags: [
			["d", `fixture:${record.namespace}:${record.peerId}`],
			["n", record.namespace],
			["expiration", String(Math.floor(record.expiresAtMs / 1_000))],
		] as const,
		content: JSON.stringify(record),
	};
	const id = await nip01Id(unsigned);
	return { ...unsigned, id, sig: TRANSPORT_SIGNATURE };
}

async function eventWithTags(event: NostrEvent, tags: readonly (readonly string[])[]): Promise<NostrEvent> {
	const unsigned = {
		pubkey: event.pubkey,
		created_at: event.created_at,
		kind: event.kind,
		tags,
		content: event.content,
	};
	return { ...unsigned, id: await nip01Id(unsigned), sig: TRANSPORT_SIGNATURE };
}

async function nip01Id(event: Omit<NostrEvent, "id" | "sig"> | NostrEvent): Promise<string> {
	const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
	const digest = await sha256.digest(encoder.encode(serialized));
	return bytesToHex(digest.digest);
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requiredTag(event: NostrEvent, name: string): string {
	const value = event.tags.find((tag) => tag[0] === name)?.[1];
	if (value === undefined) throw new Error(`fixture expected ${name} tag`);
	return value;
}

function filterContainsNamespace(filter: NostrFilter): boolean {
	return Object.entries(filter).some(
		([key, value]) => key.startsWith("#") && Array.isArray(value) && value.includes(NAMESPACE)
	);
}

function mutate(value: string): string {
	return `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
}

function signal(): AbortSignal {
	return new AbortController().signal;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		throw new Error("expected operation to reject");
	} catch (error) {
		return error;
	}
}
