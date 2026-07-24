import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { type Address, type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import {
	type AdmissionCredential,
	AdmissionPolicy,
	RecordValidator,
	RegistryServer,
	roomNamespace,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import type { DRPNetworkNode, DRPNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRPNode } from "../src/index.js";

const NOW = 1_750_000_000_000;
const NAMESPACE = `drp-network:v1:${"q".repeat(43)}`;
const ENDPOINTS = ["http://127.0.0.1:18201/quota-a", "http://127.0.0.1:18202/quota-b"] as const;

interface CapturedRegistration {
	readonly accepted: boolean;
	readonly endpoint: string;
	readonly record: SignedDrpRecordV1;
}

interface RegistrationRunner {
	fn(): boolean | Promise<boolean>;
	stop(): void;
}

describe("room presence retirement", () => {
	let node: DRPNode | undefined;

	afterEach(async () => {
		await node?.stop();
		node = undefined;
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("frees registry quota after unsubscribe so a replacement room is admitted within six seconds", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const registrations: CapturedRegistration[] = [];
		installRegistryTransport(registrations);
		node = new DRPNode(nodeConfig(), { networkNode: fakeNetwork(), reconnect: false });

		await node.start();
		await flushMicrotasks();
		await node["_rendezvousRegistration"];
		const runner = node["_intervals"].get("interval::rendezvous");
		if (!isRegistrationRunner(runner)) throw new Error("rendezvous registration runner was not installed");
		runner.stop();

		const retiredRoomId = "quota-room-a";
		await node.createObject({ id: retiredRoomId });
		const firstCycleStart = registrations.length;
		await runner.fn();
		const firstRoom = registrations
			.slice(firstCycleStart)
			.find(({ endpoint, record }) => endpoint === ENDPOINTS[0] && record.namespace === roomNamespace(retiredRoomId));
		expect(firstRoom).toMatchObject({ accepted: true });

		node.unsubscribeObject(retiredRoomId);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(5_500);

		const replacementRoomId = "quota-room-b";
		await node.createObject({ id: replacementRoomId });
		const replacementCycleStart = registrations.length;
		await runner.fn();
		const replacementRoom = registrations
			.slice(replacementCycleStart)
			.find(
				({ endpoint, record }) => endpoint === ENDPOINTS[0] && record.namespace === roomNamespace(replacementRoomId)
			);

		expect(replacementRoom).toMatchObject({ accepted: true });
	});
});

function installRegistryTransport(registrations: CapturedRegistration[]): void {
	const servers = new Map(
		ENDPOINTS.map((endpoint) => [
			endpoint,
			new RegistryServer({
				endpointId: new URL(endpoint).port,
				limits: {
					maxRecordsPerClient: 2,
					maxRequestsPerNamespaceWindow: 1_000,
					maxRequestsPerWindow: 1_000,
				},
				now: Date.now,
				policy: new AdmissionPolicy({ allowUnsafeOpen: true, mode: "open" }),
				validator: new RecordValidator({
					now: Date.now,
					resolver: { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) },
				}),
			}),
		])
	);
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof globalThis.fetch>(async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			const endpoint = ENDPOINTS.find((candidate) => new URL(candidate).port === url.port);
			const server = endpoint === undefined ? undefined : servers.get(endpoint);
			if (endpoint === undefined || server === undefined || typeof init?.body !== "string") {
				throw new Error(`unexpected registry fixture request: ${url.pathname}`);
			}
			const body = JSON.parse(init.body) as {
				readonly credential?: AdmissionCredential;
				readonly namespace?: string;
				readonly record?: SignedDrpRecordV1;
			};
			const requestSignal = init.signal instanceof AbortSignal ? init.signal : signal();
			if (url.pathname.endsWith("/v1/discover") && body.namespace !== undefined) {
				return jsonResponse(
					await server.discover({
						clientId: `quota-reader-${url.port}`,
						namespace: body.namespace,
						signal: requestSignal,
					})
				);
			}
			if (!url.pathname.endsWith("/v1/register") || body.record === undefined) {
				throw new Error(`unexpected registry fixture request: ${url.pathname}`);
			}
			const result = await server.register({
				clientId: body.record.peerId,
				...(body.credential === undefined ? {} : { credential: body.credential }),
				record: body.record,
				signal: requestSignal,
			});
			registrations.push({ accepted: result.accepted, endpoint, record: body.record });
			return jsonResponse(result);
		})
	);
}

function nodeConfig(): DRPNodeConfig {
	return {
		keychain_config: { private_key_seed: "room-presence-retraction" },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			control_plane: {
				rendezvous: {
					allow_insecure_loopback_fixture: true,
					endpoints: ENDPOINTS,
					namespace: NAMESPACE,
					publish: true,
					record_ttl_ms: 60_000,
					refresh_interval_ms: 1_000,
					room_presence: { enabled: true, max_rooms: 1 },
				},
				rollout: { public_components: { public_rendezvous: { enabled: true } } },
			},
		},
	} as DRPNodeConfig;
}

function fakeNetwork(): DRPNetworkNode {
	const networkNode = {
		membershipVerifier: undefined,
		peerId: "",
		start: vi.fn((rawPrivateKey?: Uint8Array): Promise<void> => {
			if (rawPrivateKey === undefined) return Promise.reject(new Error("fixture identity key is required"));
			networkNode.peerId = peerIdFromPublicKey(privateKeyFromRaw(rawPrivateKey).publicKey).toString();
			return Promise.resolve();
		}),
		stop: vi.fn((): Promise<void> => Promise.resolve()),
		restart: vi.fn((): Promise<void> => Promise.resolve()),
		isDialable: vi.fn((): Promise<boolean> => Promise.resolve(false)),
		changeTopicScoreParams: vi.fn((): void => undefined),
		removeTopicScoreParams: vi.fn((): void => undefined),
		subscribe: vi.fn((): void => undefined),
		unsubscribe: vi.fn((): void => undefined),
		connectToBootstraps: vi.fn((): Promise<void> => Promise.resolve()),
		connect: vi.fn((): Promise<void> => Promise.resolve()),
		disconnect: vi.fn((): Promise<void> => Promise.resolve()),
		getPeerMultiaddrs: vi.fn((_peerId: PeerId | string): Promise<Address[]> => Promise.resolve([])),
		getBootstrapNodes: vi.fn((): string[] => []),
		getSubscribedTopics: vi.fn((): string[] => []),
		getMultiaddrs: vi.fn((): string[] => [`/ip4/93.184.216.34/tcp/4803/p2p/${networkNode.peerId}`]),
		getAllPeers: vi.fn((): string[] => []),
		getGroupPeers: vi.fn((): string[] => []),
		broadcastMessage: vi.fn((): Promise<void> => Promise.resolve()),
		sendMessage: vi.fn((): Promise<void> => Promise.resolve()),
		sendGroupMessageRandomPeer: vi.fn((): Promise<void> => Promise.resolve()),
		subscribeToMessageQueue: vi.fn((): void => undefined),
		subscribeToGroupPeerChanges: vi.fn((): (() => void) => (): void => undefined),
	} satisfies DRPNetworkNode;
	return networkNode;
}

function isRegistrationRunner(value: unknown): value is RegistrationRunner {
	return (
		typeof value === "object" &&
		value !== null &&
		"fn" in value &&
		typeof value.fn === "function" &&
		"stop" in value &&
		typeof value.stop === "function"
	);
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status: 200,
	});
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function signal(): AbortSignal {
	return new AbortController().signal;
}
