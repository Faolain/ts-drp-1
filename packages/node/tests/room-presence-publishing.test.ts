import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { type Address, type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import {
	type AdmissionCredential,
	AdmissionPolicy,
	RecordValidator,
	RegistryServer,
	ROOM_NAMESPACE_PREFIX,
	roomNamespace,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import type { DRPNetworkNode, DRPNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRPNode } from "../src/index.js";

const NAMESPACE = `drp-network:v1:${"r".repeat(43)}`;
const ENDPOINTS = ["http://127.0.0.1:18101/room-presence-a", "http://127.0.0.1:18102/room-presence-b"] as const;

interface CapturedRegistration {
	readonly accepted?: boolean;
	readonly endpoint: string;
	readonly record: SignedDrpRecordV1;
}

interface PublishingHarness {
	readonly node: DRPNode;
	readonly registrations: CapturedRegistration[];
	runCycle(): Promise<readonly CapturedRegistration[]>;
}

interface RegistrationRunner {
	fn(): boolean | Promise<boolean>;
	stop(): void;
}

type RegistryTransportInstaller = (
	registrations: CapturedRegistration[],
	rejectRegistration: (record: SignedDrpRecordV1) => boolean
) => void;

describe("room presence rendezvous publishing", () => {
	const nodes: DRPNode[] = [];
	const pending: Array<Promise<unknown>> = [];

	afterEach(async () => {
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
		await Promise.allSettled(pending.splice(0));
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("publishes a room record alongside the main record after createObject", async () => {
		const fixture = await publishingHarness({ enabled: true });
		nodes.push(fixture.node);
		const object = await fixture.node.createObject({ id: "created-room" });

		const cycle = await fixture.runCycle();
		const roomRecord = cycle.find(({ record }) => record.namespace.startsWith(ROOM_NAMESPACE_PREFIX))?.record;

		expect(cycle.map(({ record }) => record.namespace)).toContain(NAMESPACE);
		expect(roomRecord, "the next registration cycle must advertise the created room").toBeDefined();
		expect(roomRecord).toMatchObject({
			namespace: roomNamespace(object.id),
			peerId: fixture.node.networkNode.peerId,
		});
	});

	it("publishes room presence after connectObject subscribes the joining replica", async () => {
		const fixture = await publishingHarness({ enabled: true });
		nodes.push(fixture.node);
		const id = "joined-room";
		const connecting = fixture.node.connectObject({ id });
		pending.push(connecting);
		await flushMicrotasks();

		const cycle = await fixture.runCycle();
		const roomRecord = cycle.find(({ record }) => record.namespace.startsWith(ROOM_NAMESPACE_PREFIX))?.record;
		fixture.node.unsubscribeObject(id);
		await connecting;

		expect(roomRecord, "a joining replica must advertise its subscribed room").toBeDefined();
		expect(roomRecord).toMatchObject({
			namespace: roomNamespace(id),
			peerId: fixture.node.networkNode.peerId,
		});
	});

	it("caps room advertisements without throwing when more rooms are subscribed", async () => {
		const fixture = await publishingHarness({ enabled: true, max_rooms: 2 });
		nodes.push(fixture.node);
		const ids = ["capped-room-a", "capped-room-b", "capped-room-c"];
		await expect(Promise.all(ids.map((id) => fixture.node.createObject({ id })))).resolves.toHaveLength(3);

		const cycle = await fixture.runCycle();
		const roomNamespaces = [
			...new Set(
				cycle.map(({ record }) => record.namespace).filter((namespace) => namespace.startsWith(ROOM_NAMESPACE_PREFIX))
			),
		];

		expect(roomNamespaces).toHaveLength(2);
		expect(new Set(roomNamespaces)).toEqual(new Set(ids.slice(0, 2).map((id) => roomNamespace(id))));
	});

	it("defaults to seven room advertisements so the main record fits the stock HTTP client quota", async () => {
		const fixture = await publishingHarness({ enabled: true });
		nodes.push(fixture.node);
		const ids = Array.from({ length: 8 }, (_, index) => `default-capped-room-${index}`);
		await Promise.all(ids.map((id) => fixture.node.createObject({ id })));

		const cycle = await fixture.runCycle();
		const roomNamespaces = new Set(
			cycle.map(({ record }) => record.namespace).filter((namespace) => namespace.startsWith(ROOM_NAMESPACE_PREFIX))
		);

		expect(roomNamespaces.size).toBe(7);
	});

	it("backfills a subscribed room on the next cycle after capacity is freed", async () => {
		const fixture = await publishingHarness({ enabled: true, max_rooms: 1 });
		nodes.push(fixture.node);
		const firstId = "backfill-room-a";
		const waitingId = "backfill-room-b";
		await fixture.node.createObject({ id: firstId });
		await fixture.node.createObject({ id: waitingId });

		const cappedCycle = await fixture.runCycle();
		expect(cappedCycle.map(({ record }) => record.namespace)).toContain(roomNamespace(firstId));
		expect(cappedCycle.map(({ record }) => record.namespace)).not.toContain(roomNamespace(waitingId));

		fixture.node.unsubscribeObject(firstId);
		const backfilledCycle = await fixture.runCycle();

		expect(backfilledCycle.map(({ record }) => record.namespace)).toContain(roomNamespace(waitingId));
	});

	it("rotates the first room registered on successive cycles", async () => {
		const fixture = await publishingHarness({ enabled: true, max_rooms: 3 });
		nodes.push(fixture.node);
		const ids = ["rotated-room-a", "rotated-room-b", "rotated-room-c"];
		await Promise.all(ids.map((id) => fixture.node.createObject({ id })));

		const firstCycle = await fixture.runCycle();
		const secondCycle = await fixture.runCycle();
		const roomNamespaces = ids.map((id) => roomNamespace(id));
		const roomOrder = (cycle: readonly CapturedRegistration[]): string[] =>
			cycle.map(({ record }) => record.namespace).filter((namespace) => namespace.startsWith(ROOM_NAMESPACE_PREFIX));

		expect(roomOrder(firstCycle)).toEqual(roomNamespaces);
		expect(roomOrder(secondCycle)).toEqual([...roomNamespaces.slice(1), ...roomNamespaces.slice(0, 1)]);
	});

	it("stops advertising an unsubscribed room on the next registration cycle", async () => {
		const fixture = await publishingHarness({ enabled: true });
		nodes.push(fixture.node);
		const id = "unsubscribed-room";
		await fixture.node.createObject({ id });

		const subscribedCycle = await fixture.runCycle();
		const advertisedNamespace = subscribedCycle.find(({ record }) => record.namespace.startsWith(ROOM_NAMESPACE_PREFIX))
			?.record.namespace;
		expect(advertisedNamespace, "the subscribed-room control must publish before unsubscribe").toBeDefined();
		expect(advertisedNamespace).toBe(roomNamespace(id));

		fixture.node.unsubscribeObject(id);
		const unsubscribedCycle = await fixture.runCycle();

		expect(unsubscribedCycle.map(({ record }) => record.namespace)).not.toContain(advertisedNamespace);
		expect(unsubscribedCycle.map(({ record }) => record.namespace)).toContain(NAMESPACE);
	});

	it("keeps room publishing off when room_presence is absent or disabled", async () => {
		const enabled = await publishingHarness({ enabled: true });
		const disabled = await publishingHarness({ enabled: false });
		const absent = await publishingHarness(undefined);
		nodes.push(enabled.node, disabled.node, absent.node);

		await enabled.node.createObject({ id: "enabled-control-room" });
		await disabled.node.createObject({ id: "disabled-room" });
		await absent.node.createObject({ id: "absent-room" });

		const [enabledCycle, disabledCycle, absentCycle] = await Promise.all([
			enabled.runCycle(),
			disabled.runCycle(),
			absent.runCycle(),
		]);

		expect(
			enabledCycle.some(({ record }) => record.namespace.startsWith(ROOM_NAMESPACE_PREFIX)),
			"the enabled positive control must publish room presence"
		).toBe(true);
		expect(disabledCycle.some(({ record }) => record.namespace.startsWith(ROOM_NAMESPACE_PREFIX))).toBe(false);
		expect(absentCycle.some(({ record }) => record.namespace.startsWith(ROOM_NAMESPACE_PREFIX))).toBe(false);
	});

	it("treats disabled room presence with max_rooms zero as inert configuration", async () => {
		const fixture = await publishingHarness({ enabled: false, max_rooms: 0 });
		nodes.push(fixture.node);
		await fixture.node.createObject({ id: "disabled-zero-room" });

		const cycle = await fixture.runCycle();

		expect(cycle.map(({ record }) => record.namespace)).toContain(NAMESPACE);
		expect(cycle.some(({ record }) => record.namespace.startsWith(ROOM_NAMESPACE_PREFIX))).toBe(false);
	});

	it("accepts a room record after unsubscribe and resubscribe against a real registry server", async () => {
		const fixture = await publishingHarness({ enabled: true, max_rooms: 1 }, () => false, installRealRegistryTransport);
		nodes.push(fixture.node);
		const id = "rejoined-room";
		const object = await fixture.node.createObject({ id });

		const firstCycle = await fixture.runCycle();
		const firstRoom = firstCycle.find(({ record }) => record.namespace === roomNamespace(id));
		if (firstRoom === undefined) throw new Error("first room registration was not captured");
		expect(firstRoom).toMatchObject({ accepted: true });

		fixture.node.unsubscribeObject(id);
		await new Promise((resolve) => setTimeout(resolve, 2));
		fixture.node.subscribeObject(object);
		const rejoinedCycle = await fixture.runCycle();
		const rejoinedRoom = rejoinedCycle.find(({ record }) => record.namespace === roomNamespace(id));

		if (rejoinedRoom === undefined) throw new Error("rejoined room registration was not captured");
		expect(rejoinedRoom).toMatchObject({ accepted: true });
		expect(rejoinedRoom.record.sequence).toBeGreaterThan(firstRoom.record.sequence);
	});

	it("isolates a failed room registration from the main record and other rooms in the same cycle", async () => {
		const failedId = "failed-room";
		const healthyId = "healthy-room";
		const fixture = await publishingHarness({ enabled: true }, (record) =>
			record.namespace.startsWith(ROOM_NAMESPACE_PREFIX)
		);
		nodes.push(fixture.node);
		await fixture.node.createObject({ id: failedId });
		await fixture.node.createObject({ id: healthyId });

		const cycle = await fixture.runCycle();
		const attemptedNamespaces = cycle.map(({ record }) => record.namespace);

		expect(
			attemptedNamespaces.some((namespace) => namespace.startsWith(ROOM_NAMESPACE_PREFIX)),
			"the cycle must attempt at least one room registration"
		).toBe(true);
		expect(attemptedNamespaces).toContain(roomNamespace(failedId));
		expect(attemptedNamespaces).toContain(NAMESPACE);
		expect(attemptedNamespaces).toContain(roomNamespace(healthyId));
	});
});

async function publishingHarness(
	roomPresence: { readonly enabled: boolean; readonly max_rooms?: number } | undefined,
	rejectRegistration: (record: SignedDrpRecordV1) => boolean = () => false,
	installTransport: RegistryTransportInstaller = stubRegistryTransport
): Promise<PublishingHarness> {
	const registrations: CapturedRegistration[] = [];
	installTransport(registrations, rejectRegistration);
	const node = new DRPNode(nodeConfig(roomPresence), {
		networkNode: fakeNetwork(),
		reconnect: false,
	});
	await node.start();
	await vi.waitFor(
		() =>
			expect(
				registrations.filter(({ endpoint, record }) => endpoint === ENDPOINTS[1] && record.namespace === NAMESPACE)
			).toHaveLength(1),
		{ timeout: 1_000 }
	);
	await node["_rendezvousRegistration"];
	const runner = node["_intervals"].get("interval::rendezvous");
	if (!isRegistrationRunner(runner)) {
		throw new Error("rendezvous registration runner was not installed");
	}
	runner.stop();

	return {
		node,
		registrations,
		runCycle: async (): Promise<readonly CapturedRegistration[]> => {
			const startIndex = registrations.length;
			await runner.fn();
			return registrations.slice(startIndex).filter(({ endpoint }) => endpoint === ENDPOINTS[0]);
		},
	};
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

function nodeConfig(
	roomPresence: { readonly enabled: boolean; readonly max_rooms?: number } | undefined
): DRPNodeConfig {
	return {
		keychain_config: { private_key_seed: `room-presence-${String(roomPresence?.enabled)}` },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			control_plane: {
				rollout: { public_components: { public_rendezvous: { enabled: true } } },
				rendezvous: {
					allow_insecure_loopback_fixture: true,
					endpoints: ENDPOINTS,
					namespace: NAMESPACE,
					publish: true,
					record_ttl_ms: 60_000,
					refresh_interval_ms: 1_000,
					...(roomPresence === undefined ? {} : { room_presence: roomPresence }),
				},
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
		getMultiaddrs: vi.fn((): string[] => [`/ip4/93.184.216.34/tcp/4500/p2p/${networkNode.peerId}`]),
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

function stubRegistryTransport(
	registrations: CapturedRegistration[],
	rejectRegistration: (record: SignedDrpRecordV1) => boolean
): void {
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof globalThis.fetch>((input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.pathname.endsWith("/v1/discover")) {
				return Promise.resolve(jsonResponse({ endpointId: url.port, records: [] }));
			}
			if (!url.pathname.endsWith("/v1/register") || typeof init?.body !== "string") {
				throw new Error(`unexpected registry fixture request: ${url.pathname}`);
			}
			const body = JSON.parse(init.body) as { readonly record?: SignedDrpRecordV1 };
			if (body.record === undefined) throw new Error("registry fixture registration omitted its record");
			const endpoint = ENDPOINTS.find((candidate) => new URL(candidate).port === url.port);
			if (endpoint === undefined) throw new Error(`unknown registry fixture endpoint: ${url.port}`);
			registrations.push({ accepted: !rejectRegistration(body.record), endpoint, record: body.record });
			if (rejectRegistration(body.record)) {
				return Promise.resolve(jsonResponse({ accepted: false, code: "endpoint-unavailable" }));
			}
			return Promise.resolve(
				jsonResponse({
					accepted: true,
					admissionMode: "open",
					endpointId: url.port,
					expiresAtMs: body.record.expiresAtMs,
					refreshed: false,
					sequence: body.record.sequence,
				})
			);
		})
	);
}

function installRealRegistryTransport(registrations: CapturedRegistration[]): void {
	const servers = new Map(
		ENDPOINTS.map((endpoint) => {
			const endpointId = new URL(endpoint).port;
			return [
				endpoint,
				new RegistryServer({
					endpointId,
					limits: { maxRequestsPerNamespaceWindow: 1_000, maxRequestsPerWindow: 1_000 },
					policy: new AdmissionPolicy({ allowUnsafeOpen: true, mode: "open" }),
					validator: new RecordValidator({
						resolver: { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) },
					}),
				}),
			] as const;
		})
	);
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof globalThis.fetch>(async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			const endpoint = ENDPOINTS.find((candidate) => new URL(candidate).port === url.port);
			const server = endpoint === undefined ? undefined : servers.get(endpoint);
			if (endpoint === undefined || server === undefined || typeof init?.body !== "string") {
				throw new Error(`unexpected real registry fixture request: ${url.pathname}`);
			}
			const body = JSON.parse(init.body) as {
				readonly credential?: AdmissionCredential;
				readonly namespace?: string;
				readonly record?: SignedDrpRecordV1;
			};
			const requestSignal = init.signal instanceof AbortSignal ? init.signal : new AbortController().signal;
			if (url.pathname.endsWith("/v1/discover") && body.namespace !== undefined) {
				const result = await server.discover({
					clientId: `room-reader-${url.port}`,
					namespace: body.namespace,
					signal: requestSignal,
				});
				return jsonResponse(result);
			}
			if (!url.pathname.endsWith("/v1/register") || body.record === undefined) {
				throw new Error(`unexpected real registry fixture request: ${url.pathname}`);
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

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status: 200,
	});
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
