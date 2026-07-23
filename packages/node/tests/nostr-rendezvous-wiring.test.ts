import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import {
	createNostrSignerFromSecretKey,
	createNostrWebSocketRelayFactory,
	type NostrEvent,
	type NostrRelayConnectionFactory,
	NostrRelayDirectory,
	RecordSigner,
	RecordValidator,
	RegistryClient,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import type { ControlPlaneRendezvousConfig } from "@ts-drp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createConfiguredRendezvousRegistries,
	type CreateConfiguredRendezvousRegistriesParams,
	NostrRendezvousConfigurationError,
} from "../src/index.js";

const NOW = 1_750_000_000_000;
const NAMESPACE = `drp-network:v1:${"n".repeat(43)}`;
const KEYCHAIN_SECRET = new Uint8Array(32).fill(42);
const HTTP_ENDPOINTS = ["https://registry-one.example/", "https://registry-two.example/"] as const;

beforeEach(() => FakeWebSocket.reset());
afterEach(() => vi.unstubAllGlobals());

describe("createConfiguredRendezvousRegistries", () => {
	it("returns the existing RegistryClient for HTTP-only configuration", () => {
		const directory = createConfiguredRendezvousRegistries(
			params({ endpoints: HTTP_ENDPOINTS, namespace: NAMESPACE, publish: true })
		);

		expect(directory).toBeInstanceOf(RegistryClient);
		expect(directory).not.toBeInstanceOf(NostrRelayDirectory);
	});

	it("returns a NostrRelayDirectory whose derived signer round-trips over an injected WebSocket factory", async () => {
		const directory = createConfiguredRendezvousRegistries(
			params(
				{ namespace: NAMESPACE, nostr: { relays: ["wss://relay.example/"] }, publish: true },
				{ nostrConnectionFactory: fakeWebSocketFactory() }
			)
		);
		const record = await signedRecord(901);

		expect(directory).toBeInstanceOf(NostrRelayDirectory);
		if (directory === undefined) throw new Error("expected configured Nostr directory");
		await expect(directory.register(record, signal())).resolves.toMatchObject({
			acceptedEndpointIds: ["nostr-1"],
			sequence: record.sequence,
		});
		await expect(directory.discover(NAMESPACE, signal())).resolves.toMatchObject([
			{ admissionMode: "open", record, sourceEndpointId: "nostr-1" },
		]);
		expect(FakeWebSocket.events).toHaveLength(1);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it("composes HTTP and Nostr so discovery returns both backends' records", async () => {
		const httpRecord = await signedRecord(902);
		const nostrRecord = await signedRecord(903);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>((input) => {
				const url = new URL(String(input));
				if (url.pathname.endsWith("/v1/register")) {
					return Promise.resolve(
						jsonResponse({ accepted: true, endpointId: url.hostname, sequence: nostrRecord.sequence })
					);
				}
				return Promise.resolve(
					jsonResponse({
						endpointId: url.hostname,
						records: [{ admissionMode: "open", record: httpRecord }],
					})
				);
			})
		);
		const directory = createConfiguredRendezvousRegistries(
			params(
				{ endpoints: HTTP_ENDPOINTS, namespace: NAMESPACE, nostr: { relays: ["wss://relay.example/"] }, publish: true },
				{ nostrConnectionFactory: fakeWebSocketFactory() }
			)
		);
		if (directory === undefined) throw new Error("expected configured composite directory");
		await directory.register(nostrRecord, signal());

		const discovered = await directory.discover(NAMESPACE, signal());

		expect(discovered.map(({ record }) => record.peerId)).toEqual([httpRecord.peerId, nostrRecord.peerId]);
	});

	it("derives a deterministic transport signer distinct from the raw keychain key", async () => {
		const record = await signedRecord(904);
		for (const relay of ["wss://relay-one.example/", "wss://relay-two.example/"]) {
			const directory = createConfiguredRendezvousRegistries(
				params(
					{ namespace: NAMESPACE, nostr: { relays: [relay] }, publish: true },
					{ nostrConnectionFactory: fakeWebSocketFactory() }
				)
			);
			if (directory === undefined) throw new Error("expected configured Nostr directory");
			await directory.register(record, signal());
		}
		const rawKeyPublicKey = await createNostrSignerFromSecretKey(KEYCHAIN_SECRET).getPublicKey(signal());

		expect(FakeWebSocket.events.map(({ pubkey }) => pubkey)).toHaveLength(2);
		expect(FakeWebSocket.events[0]?.pubkey).toBe(FakeWebSocket.events[1]?.pubkey);
		expect(FakeWebSocket.events[0]?.pubkey).not.toBe(rawKeyPublicKey);
	});

	it("throws a typed configuration error for an invalid explicit secret key", () => {
		expect(() =>
			createConfiguredRendezvousRegistries(
				params(
					{
						namespace: NAMESPACE,
						nostr: { relays: ["wss://relay.example/"], secret_key: "not-32-byte-lowercase-hex" },
						publish: true,
					},
					{ nostrConnectionFactory: fakeWebSocketFactory() }
				)
			)
		).toThrow(NostrRendezvousConfigurationError);
	});

	it.each([
		["publish is omitted", { namespace: NAMESPACE, nostr: { relays: ["wss://relay.example/"] } }],
		[
			"global and Nostr publish are false",
			{
				namespace: NAMESPACE,
				nostr: { publish: false, relays: ["wss://relay.example/"] },
				publish: false,
			},
		],
	] as const)("keeps Nostr discovery available when %s", async (_scenario, rendezvousConfig) => {
		const directory = createConfiguredRendezvousRegistries(
			params(rendezvousConfig, { nostrConnectionFactory: fakeWebSocketFactory() })
		);

		expect(directory).toBeInstanceOf(NostrRelayDirectory);
		if (directory === undefined) throw new Error("expected discover-only Nostr directory");
		await expect(directory.discover(NAMESPACE, signal())).resolves.toEqual([]);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it("does not construct Nostr while the public rollout is disabled", () => {
		const enabledConfig: ControlPlaneRendezvousConfig = {
			namespace: NAMESPACE,
			nostr: { relays: ["wss://relay.example/"] },
			publish: true,
		};
		expect(
			createConfiguredRendezvousRegistries(params(enabledConfig, { publicRendezvousEnabled: false }))
		).toBeUndefined();
	});
});

function params(
	rendezvousConfig: ControlPlaneRendezvousConfig,
	overrides: Partial<CreateConfiguredRendezvousRegistriesParams> = {}
): CreateConfiguredRendezvousRegistriesParams {
	return {
		clientId: "peer-1",
		now: (): number => NOW,
		publicRendezvousEnabled: true,
		rendezvousConfig,
		secp256k1PrivateKey: KEYCHAIN_SECRET,
		validatorFactory,
		...overrides,
	};
}

function validatorFactory(): RecordValidator {
	return new RecordValidator({
		now: (): number => NOW,
		resolver: { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) },
	});
}

async function signedRecord(seedByte: number): Promise<SignedDrpRecordV1> {
	const key = await generateKeyPairFromSeed("Ed25519", new Uint8Array(32).fill(seedByte % 256));
	const peerId = peerIdFromPublicKey(key.publicKey).toString();
	return new RecordSigner(key).sign({
		addresses: [`/dns4/relay.example.test/tcp/443/wss/p2p/${peerId}`],
		capabilities: ["drp-gossipsub"],
		expiresAtMs: NOW + 60_000,
		issuedAtMs: NOW,
		namespace: NAMESPACE,
		sequence: 1,
	});
}

function fakeWebSocketFactory(): NostrRelayConnectionFactory {
	return createNostrWebSocketRelayFactory({ webSocketImpl: FakeWebSocket });
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status: 200 });
}

function signal(): AbortSignal {
	return new AbortController().signal;
}

function isNostrEvent(value: unknown): value is NostrEvent {
	return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string";
}

type FakeSocketEventType = "close" | "error" | "message" | "open";
type FakeSocketListener = (event: Event) => void;

class FakeWebSocket {
	static events: NostrEvent[] = [];
	static instances: FakeWebSocket[] = [];

	static reset(): void {
		this.events = [];
		this.instances = [];
	}

	readyState = 0;
	readonly #listeners = new Map<FakeSocketEventType, Set<FakeSocketListener>>();

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => this.#dispatch("open", new Event("open")));
	}

	addEventListener(type: FakeSocketEventType, listener: FakeSocketListener): void {
		const listeners = this.#listeners.get(type) ?? new Set<FakeSocketListener>();
		listeners.add(listener);
		this.#listeners.set(type, listeners);
	}

	removeEventListener(type: FakeSocketEventType, listener: FakeSocketListener): void {
		this.#listeners.get(type)?.delete(listener);
	}

	send(data: string): void {
		const frame = JSON.parse(data) as unknown;
		if (!Array.isArray(frame)) return;
		if (frame[0] === "EVENT" && isNostrEvent(frame[1])) {
			FakeWebSocket.events.push(frame[1]);
			this.#message(JSON.stringify(["OK", frame[1].id, true, "stored"]));
			return;
		}
		if (frame[0] === "REQ" && typeof frame[1] === "string") {
			for (const event of FakeWebSocket.events) this.#message(JSON.stringify(["EVENT", frame[1], event]));
			this.#message(JSON.stringify(["EOSE", frame[1]]));
		}
	}

	close(): void {
		this.readyState = 3;
	}

	#dispatch(type: FakeSocketEventType, event: Event): void {
		if (type === "open") this.readyState = 1;
		for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
	}

	#message(data: string): void {
		this.#dispatch("message", new MessageEvent<string>("message", { data }));
	}
}
