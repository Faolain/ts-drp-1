import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { type Address, type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import {
	AddressPolicy,
	AdmissionPolicy,
	createRendezvousEnsemble,
	FixtureRegistryEndpoint,
	RecordSigner,
	RecordValidator,
	RegistryClient,
	RegistryServer,
	type RendezvousEnsemble,
	roomNamespace,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import type { DRPNetworkNode, DRPNodeConfig } from "@ts-drp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DRPNode } from "../src/index.js";

const NAMESPACE = `drp-network:v1:${"r".repeat(43)}`;
const INVITE = "room-presence-fallback-fixture-invite";
const JOINER_PEER_ID = "room-presence-fallback-reader";
const resolver = { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) };

interface DirectoryFixture {
	readonly endpoints: readonly [FixtureRegistryEndpoint, FixtureRegistryEndpoint];
	readonly ensemble: RendezvousEnsemble;
}

interface NodeFixture {
	readonly connect: ReturnType<typeof vi.fn>;
	readonly getAllPeers: ReturnType<typeof vi.fn>;
	readonly networkNode: DRPNetworkNode;
	readonly node: DRPNode;
}

describe("connectObject room-presence rendezvous fallback", () => {
	const nodes: DRPNode[] = [];
	const pending: Array<Promise<unknown>> = [];
	let unhandledRejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown): void => {
		unhandledRejections.push(reason);
	};

	beforeEach(() => {
		unhandledRejections = [];
		process.on("unhandledRejection", onUnhandledRejection);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
		await Promise.allSettled(pending.splice(0));
		await flushMicrotasks();
		process.off("unhandledRejection", onUnhandledRejection);
		expect(unhandledRejections).toEqual([]);
		vi.restoreAllMocks();
	});

	it("dials a validated room replica when the creator record is absent", async () => {
		const now = Date.now();
		const creator = await signedRecord(1, now, NAMESPACE, 4101);
		const id = objectId(creator, "creator-offline");
		const replica = await signedRecord(2, now, roomNamespace(id), 4102);
		const directory = await directoryFixture([replica], now);
		const fixture = await startedNode(directory.ensemble);
		nodes.push(fixture.node);

		pending.push(fixture.node.connectObject({ id }));

		await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledWith([...replica.addresses]), {
			timeout: 500,
		});
		expect(fixture.connect).toHaveBeenCalledTimes(1);
	});

	it("uses only the fast path when the creator record connects successfully", async () => {
		const now = Date.now();
		const creator = await signedRecord(3, now, NAMESPACE, 4103);
		const id = objectId(creator, "creator-online");
		const roomNamespaceValue = roomNamespace(id);
		const replica = await signedRecord(4, now, roomNamespaceValue, 4104);
		const directory = await directoryFixture([creator, replica], now);
		const roomDiscover = vi.spyOn(directory.endpoints[0], "discover");
		const fixture = await startedNode(directory.ensemble);
		fixture.connect.mockImplementation((addresses: readonly string[]): Promise<void> => {
			if (JSON.stringify(addresses) === JSON.stringify(creator.addresses)) {
				fixture.getAllPeers.mockReturnValue([creator.peerId]);
			}
			return Promise.resolve();
		});
		nodes.push(fixture.node);

		pending.push(fixture.node.connectObject({ id }));

		await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledWith([...creator.addresses]), {
			timeout: 500,
		});
		await flushMicrotasks();
		expect(roomDiscover).not.toHaveBeenCalledWith(
			expect.objectContaining({
				namespace: roomNamespaceValue,
			})
		);
		expect(fixture.connect).toHaveBeenCalledTimes(1);
		expect(fixture.connect).not.toHaveBeenCalledWith([...replica.addresses]);
	});

	it("does not dial a room record published by the joiner itself", async () => {
		const now = Date.now();
		const creator = await signedRecord(5, now, NAMESPACE, 4105);
		const id = objectId(creator, "self-record");
		const selfRecord = await signedRecord(6, now, roomNamespace(id), 4106);
		const directory = await directoryFixture([selfRecord], now);
		const roomDiscover = vi.spyOn(directory.endpoints[0], "discover");
		const fixture = await startedNode(directory.ensemble, selfRecord.peerId);
		nodes.push(fixture.node);

		pending.push(fixture.node.connectObject({ id }));

		await vi.waitFor(
			() =>
				expect(roomDiscover).toHaveBeenCalledWith(
					expect.objectContaining({
						namespace: roomNamespace(id),
					})
				),
			{ timeout: 500 }
		);
		expect(fixture.connect).not.toHaveBeenCalled();
	});

	it("skips targeted self-discovery but still dials another room replica", async () => {
		const now = Date.now();
		const creator = await signedRecord(7, now, NAMESPACE, 4107);
		const id = objectId(creator, "creator-is-self");
		const replica = await signedRecord(8, now, roomNamespace(id), 4108);
		const directory = await directoryFixture([replica], now);
		const fixture = await startedNode(directory.ensemble, creator.peerId);
		nodes.push(fixture.node);

		pending.push(fixture.node.connectObject({ id }));

		await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledWith([...replica.addresses]), {
			timeout: 500,
		});
		expect(fixture.connect).toHaveBeenCalledTimes(1);
	});

	it("caps a room fallback at eight validated distinct-address dials", async () => {
		const now = Date.now();
		const creator = await signedRecord(9, now, NAMESPACE, 4109);
		const id = objectId(creator, "bounded-room-fallback");
		const namespace = roomNamespace(id);
		const replicas = await Promise.all(
			Array.from({ length: 10 }, (_, offset) => signedRecord(20 + offset, now, namespace, 4200 + offset))
		);
		const directory = await directoryFixture(replicas, now);
		const fixture = await startedNode(directory.ensemble);
		nodes.push(fixture.node);

		pending.push(fixture.node.connectObject({ id }));

		await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledTimes(8), { timeout: 500 });
		await flushMicrotasks();
		expect(fixture.connect).toHaveBeenCalledTimes(8);
		expect(new Set(fixture.connect.mock.calls.map(([addresses]) => JSON.stringify(addresses))).size).toBe(8);
	});

	it("resolves without dialing when both creator and room namespaces are empty", async () => {
		vi.useFakeTimers();
		const now = Date.now();
		const creator = await signedRecord(40, now, NAMESPACE, 4140);
		const id = objectId(creator, "empty-directories");
		const directory = await directoryFixture([], now);
		const roomDiscover = vi.spyOn(directory.endpoints[0], "discover");
		const fixture = await startedNode(directory.ensemble);
		nodes.push(fixture.node);

		const connecting = fixture.node.connectObject({ id });
		await vi.advanceTimersByTimeAsync(5_000);

		expect(roomDiscover).toHaveBeenCalledWith(
			expect.objectContaining({
				namespace: roomNamespace(id),
			})
		);
		await expect(connecting).resolves.toMatchObject({ id });
		expect(fixture.connect).not.toHaveBeenCalled();
	});

	it("unsubscribe and stop abort an in-flight room fallback before a second replica dial", async () => {
		for (const [offset, lifecycle] of (["unsubscribe", "stop"] as const).entries()) {
			const now = Date.now();
			const creator = await signedRecord(41 + offset * 3, now, NAMESPACE, 4141 + offset * 3);
			const id = objectId(creator, `abort-${lifecycle}`);
			const namespace = roomNamespace(id);
			const replicas = [
				await signedRecord(42 + offset * 3, now, namespace, 4142 + offset * 3),
				await signedRecord(43 + offset * 3, now, namespace, 4143 + offset * 3),
			];
			const directory = await directoryFixture(replicas, now);
			let finishFirstDial: (() => void) | undefined;
			const firstDial = new Promise<void>((resolve) => {
				finishFirstDial = resolve;
			});
			const fixture = await startedNode(directory.ensemble);
			fixture.connect.mockImplementationOnce(() => firstDial);
			nodes.push(fixture.node);

			pending.push(fixture.node.connectObject({ id }));
			await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledTimes(1), { timeout: 500 });

			if (lifecycle === "unsubscribe") {
				fixture.node.unsubscribeObject(id);
			} else {
				await fixture.node.stop();
			}
			expect(fixture.node["_connectRendezvousControllers"].size).toBe(0);
			finishFirstDial?.();
			await flushMicrotasks();

			expect(fixture.connect).toHaveBeenCalledTimes(1);
		}
	});
});

async function directoryFixture(records: readonly SignedDrpRecordV1[], now: number): Promise<DirectoryFixture> {
	const servers = ["room-registry-a", "room-registry-b"].map(
		(endpointId) =>
			new RegistryServer({
				endpointId,
				limits: { maxRequestsPerNamespaceWindow: 1_000, maxRequestsPerWindow: 1_000 },
				now: (): number => now,
				policy: new AdmissionPolicy({ inviteToken: INVITE }),
				validator: validator(now),
			})
	);
	for (const record of records) {
		for (const server of servers) {
			await server.register({
				clientId: record.peerId,
				credential: { kind: "invite", token: INVITE },
				record,
				signal: signal(),
			});
		}
	}
	const endpoints = servers.map((server) => new FixtureRegistryEndpoint(server)) as [
		FixtureRegistryEndpoint,
		FixtureRegistryEndpoint,
	];
	const registries = new RegistryClient({
		backoffMs: 0,
		clientId: JOINER_PEER_ID,
		endpoints,
		timeoutMs: 1_000,
		validatorFactory: (): RecordValidator => validator(now),
	});
	const ensemble = createRendezvousEnsemble({
		addressPolicy: { policy: new AddressPolicy({ target: "node" }), resolver },
		limits: { timeoutMs: 1_000 },
		now: () => now,
		registries,
		validatorFactory: () => validator(now),
	});
	return { endpoints, ensemble };
}

async function startedNode(ensemble: RendezvousEnsemble, selfPeerId = JOINER_PEER_ID): Promise<NodeFixture> {
	const getAllPeers = vi.fn((): string[] => []);
	const connect = vi.fn((): Promise<void> => Promise.resolve());
	const networkNode = fakeNetwork(connect, getAllPeers, selfPeerId);
	const node = new DRPNode(nodeConfig(), { networkNode, reconnect: false });
	await node.start();
	node["_rendezvous"] = ensemble;
	return { connect, getAllPeers, networkNode, node };
}

function nodeConfig(): DRPNodeConfig {
	return {
		keychain_config: { private_key_seed: JOINER_PEER_ID },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			control_plane: {
				rendezvous: {
					namespace: NAMESPACE,
					publish: false,
				},
			},
		},
	} as DRPNodeConfig;
}

function fakeNetwork(
	connect: ReturnType<typeof vi.fn>,
	getAllPeers: ReturnType<typeof vi.fn>,
	selfPeerId: string
): DRPNetworkNode {
	const networkNode = {
		membershipVerifier: undefined,
		peerId: "",
		start: vi.fn(function (this: DRPNetworkNode): Promise<void> {
			this.peerId = selfPeerId;
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
		connect,
		disconnect: vi.fn((): Promise<void> => Promise.resolve()),
		getPeerMultiaddrs: vi.fn((_peerId: PeerId | string): Promise<Address[]> => Promise.resolve([])),
		getBootstrapNodes: vi.fn((): string[] => []),
		getSubscribedTopics: vi.fn((): string[] => []),
		getMultiaddrs: vi.fn((): string[] => []),
		getAllPeers,
		getGroupPeers: vi.fn((): string[] => []),
		broadcastMessage: vi.fn((): Promise<void> => Promise.resolve()),
		sendMessage: vi.fn((): Promise<void> => Promise.resolve()),
		sendGroupMessageRandomPeer: vi.fn((): Promise<void> => Promise.resolve()),
		subscribeToMessageQueue: vi.fn((): void => undefined),
		subscribeToGroupPeerChanges: vi.fn((): (() => void) => (): void => undefined),
	} satisfies DRPNetworkNode;
	return networkNode;
}

async function signedRecord(index: number, now: number, namespace: string, port: number): Promise<SignedDrpRecordV1> {
	const key = await generateKeyPairFromSeed(
		"Ed25519",
		Uint8Array.from({ length: 32 }, (_, offset) => (index * 31 + offset * 11) % 256)
	);
	const peerId = peerIdFromPublicKey(key.publicKey).toString();
	return new RecordSigner(key).sign({
		addresses: [`/ip4/93.184.216.34/tcp/${port}/p2p/${peerId}`],
		capabilities: ["drp-gossipsub"],
		expiresAtMs: now + 60_000,
		issuedAtMs: now,
		namespace,
		sequence: 1,
	});
}

function validator(now: number): RecordValidator {
	return new RecordValidator({ now: () => now, resolver });
}

function objectId(record: SignedDrpRecordV1, salt: string): string {
	return `${record.peerId}:${salt}`;
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function signal(): AbortSignal {
	return new AbortController().signal;
}
