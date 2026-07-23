import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { type Address, type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import {
	type AddressFilteredDrpRecord,
	AddressPolicy,
	AdmissionPolicy,
	createRendezvousEnsemble,
	FixtureRegistryEndpoint,
	RecordSigner,
	RecordValidator,
	RegistryClient,
	RegistryServer,
	type RendezvousEnsemble,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import type { DRPNetworkNode, DRPNodeConfig } from "@ts-drp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DRPNode } from "../src/index.js";

const NAMESPACE = `drp-network:v1:${"t".repeat(43)}`;
const INVITE = "targeted-connect-object-fixture-invite";
const resolver = { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) };

interface DirectoryFixture {
	readonly endpoints: readonly [FixtureRegistryEndpoint, FixtureRegistryEndpoint];
	readonly ensemble: RendezvousEnsemble;
	readonly other: SignedDrpRecordV1;
	readonly target: SignedDrpRecordV1;
}

interface NodeFixture {
	readonly connect: ReturnType<typeof vi.fn>;
	readonly getAllPeers: ReturnType<typeof vi.fn>;
	readonly networkNode: DRPNetworkNode;
	readonly node: DRPNode;
}

describe("connectObject targeted creator rendezvous", () => {
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

	it("dials only the creator's validated addresses through a real fixture-backed ensemble", async () => {
		const directory = await directoryFixture();
		const fixture = await startedNode(directory.ensemble);
		nodes.push(fixture.node);

		pending.push(fixture.node.connectObject({ id: objectId(directory.target, "eligible") }));

		await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledWith([...directory.target.addresses]), {
			timeout: 500,
		});
		expect(fixture.connect).toHaveBeenCalledTimes(1);
		expect(fixture.connect).not.toHaveBeenCalledWith([...directory.other.addresses]);
	});

	it("skips an already connected creator, then dials once the same creator is absent", async () => {
		const directory = await directoryFixture();
		const fixture = await startedNode(directory.ensemble);
		nodes.push(fixture.node);
		fixture.getAllPeers.mockReturnValue([directory.target.peerId]);
		const discoverSpies = directory.endpoints.map((endpoint) => vi.spyOn(endpoint, "discover"));

		pending.push(fixture.node.connectObject({ id: objectId(directory.target, "already-connected") }));
		await flushMicrotasks();
		expect(discoverSpies.every((discover) => discover.mock.calls.length === 0)).toBe(true);
		expect(fixture.connect).not.toHaveBeenCalled();

		fixture.getAllPeers.mockReturnValue([]);
		pending.push(fixture.node.connectObject({ id: objectId(directory.target, "now-absent") }));
		await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledTimes(1), { timeout: 500 });
		expect(fixture.connect).toHaveBeenCalledWith([...directory.target.addresses]);
	});

	it("skips an id without a creator commitment while the bound control still dials", async () => {
		const directory = await directoryFixture();
		const fixture = await startedNode(directory.ensemble);
		nodes.push(fixture.node);
		const discoverSpies = directory.endpoints.map((endpoint) => vi.spyOn(endpoint, "discover"));

		pending.push(fixture.node.connectObject({ id: "legacy-object-without-creator" }));
		await flushMicrotasks();
		expect(discoverSpies.every((discover) => discover.mock.calls.length === 0)).toBe(true);
		expect(fixture.connect).not.toHaveBeenCalled();

		pending.push(fixture.node.connectObject({ id: objectId(directory.target, "bound-control") }));
		await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledTimes(1), { timeout: 500 });
	});

	it("keeps connectObject non-fatal when every targeted registry lookup fails", async () => {
		const directory = await directoryFixture();
		for (const endpoint of directory.endpoints) endpoint.setAvailable(false);
		const discoverSpies = directory.endpoints.map((endpoint) => vi.spyOn(endpoint, "discover"));
		const fixture = await startedNode(directory.ensemble);
		nodes.push(fixture.node);
		vi.useFakeTimers();
		const id = objectId(directory.target, "lookup-failure");

		const connecting = fixture.node.connectObject({ id });
		await vi.advanceTimersByTimeAsync(5_000);

		expect(discoverSpies.reduce((count, discover) => count + discover.mock.calls.length, 0)).toBeGreaterThan(0);
		await expect(connecting).resolves.toMatchObject({ id });
		expect(fixture.connect).not.toHaveBeenCalled();
	});

	it("a second connectObject aborts the first targeted bootstrap and leaves one controller", async () => {
		const directory = await directoryFixture();
		const bootstrap = blockingEnsemble();
		const fixture = await startedNode(bootstrap.ensemble);
		nodes.push(fixture.node);
		const id = objectId(directory.target, "superseded");

		pending.push(fixture.node.connectObject({ id }));
		await vi.waitFor(() => expect(bootstrap.signals).toHaveLength(1));
		const firstSignal = bootstrap.signals[0];
		if (firstSignal === undefined) throw new Error("first targeted bootstrap signal was not captured");

		pending.push(fixture.node.connectObject({ id }));
		await vi.waitFor(() => expect(bootstrap.signals).toHaveLength(2));
		const secondSignal = bootstrap.signals[1];
		if (secondSignal === undefined) throw new Error("second targeted bootstrap signal was not captured");

		expect(firstSignal.aborted).toBe(true);
		expect(secondSignal.aborted).toBe(false);
		expect(fixture.node["_connectRendezvousControllers"].size).toBe(1);
		expect(fixture.node["_connectRendezvousControllers"].get(id)?.signal).toBe(secondSignal);
		bootstrap.releaseAll();
	});

	it("unsubscribeObject aborts an in-flight targeted bootstrap and prevents a later dial", async () => {
		const directory = await directoryFixture();
		const bootstrap = blockingEnsemble();
		const fixture = await startedNode(bootstrap.ensemble);
		nodes.push(fixture.node);
		const id = objectId(directory.target, "unsubscribe");

		pending.push(fixture.node.connectObject({ id }));
		await vi.waitFor(() => expect(bootstrap.signals).toHaveLength(1));
		const operationSignal = bootstrap.signals[0];
		if (operationSignal === undefined) throw new Error("targeted bootstrap signal was not captured");

		fixture.node.unsubscribeObject(id);
		expect(operationSignal.aborted).toBe(true);
		expect(fixture.node["_connectRendezvousControllers"].size).toBe(0);
		bootstrap.releaseAll();
		await flushMicrotasks();
		expect(fixture.connect).not.toHaveBeenCalled();
	});

	it("stop aborts an in-flight targeted bootstrap and empties the controller map", async () => {
		const directory = await directoryFixture();
		const bootstrap = blockingEnsemble();
		const fixture = await startedNode(bootstrap.ensemble);
		nodes.push(fixture.node);
		const id = objectId(directory.target, "stop");

		pending.push(fixture.node.connectObject({ id }));
		await vi.waitFor(() => expect(bootstrap.signals).toHaveLength(1));
		const operationSignal = bootstrap.signals[0];
		if (operationSignal === undefined) throw new Error("targeted bootstrap signal was not captured");

		await fixture.node.stop();
		expect(operationSignal.aborted).toBe(true);
		expect(fixture.node["_connectRendezvousControllers"].size).toBe(0);
		bootstrap.releaseAll();
		await flushMicrotasks();
		expect(fixture.connect).not.toHaveBeenCalled();
	});

	it("stops the dial loop after an abort during an in-flight connect", async () => {
		const directory = await directoryFixture();
		const firstAddress = directory.target.addresses[0];
		if (firstAddress === undefined) throw new Error("target fixture address is missing");
		const secondAddress = firstAddress.replace("/tcp/4100/", "/tcp/4200/");
		const bootstrap = staticEnsemble([
			filtered(directory.target, [firstAddress]),
			filtered(directory.target, [secondAddress]),
		]);
		let finishFirstDial: (() => void) | undefined;
		const firstDial = new Promise<void>((resolve) => {
			finishFirstDial = resolve;
		});
		const fixture = await startedNode(bootstrap);
		fixture.connect.mockImplementationOnce(() => firstDial);
		nodes.push(fixture.node);
		const id = objectId(directory.target, "abort-mid-dial");

		pending.push(fixture.node.connectObject({ id }));
		await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledTimes(1));
		fixture.node.unsubscribeObject(id);
		finishFirstDial?.();
		await flushMicrotasks();

		expect(fixture.connect).toHaveBeenCalledTimes(1);
		expect(fixture.connect).toHaveBeenCalledWith([firstAddress]);
	});

	it("rechecks the creator and deduplicates identical address sets without suppressing fresher addresses", async () => {
		const directory = await directoryFixture();
		const targetAddress = directory.target.addresses[0];
		const otherAddress = directory.other.addresses[0];
		if (targetAddress === undefined || otherAddress === undefined) {
			throw new Error("targeted rendezvous fixture addresses are missing");
		}
		const alternateAddress = targetAddress.replace("/tcp/4100/", "/tcp/4300/");
		const bootstrap = staticEnsemble([
			filtered(directory.other, [otherAddress]),
			filtered(directory.target, [targetAddress, alternateAddress]),
			filtered(directory.target, [alternateAddress, targetAddress]),
			filtered(directory.target, [alternateAddress]),
		]);
		const fixture = await startedNode(bootstrap);
		nodes.push(fixture.node);

		pending.push(fixture.node.connectObject({ id: objectId(directory.target, "defense-and-dedupe") }));
		await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledTimes(2));

		expect(fixture.connect.mock.calls).toEqual([[[targetAddress, alternateAddress]], [[alternateAddress]]]);
	});
});

interface BlockingEnsemble {
	readonly ensemble: RendezvousEnsemble;
	releaseAll(): void;
	readonly signals: AbortSignal[];
}

function blockingEnsemble(): BlockingEnsemble {
	const releases: Array<() => void> = [];
	const signals: AbortSignal[] = [];
	const ensemble: RendezvousEnsemble = {
		bootstrap: (_namespace, operationSignal): AsyncIterable<AddressFilteredDrpRecord> => ({
			[Symbol.asyncIterator]: (): AsyncIterator<AddressFilteredDrpRecord> => {
				signals.push(operationSignal);
				return {
					next: (): Promise<IteratorResult<AddressFilteredDrpRecord>> =>
						new Promise((resolve) => releases.push(() => resolve({ done: true, value: undefined }))),
				};
			},
		}),
		discover: () => Promise.resolve([]),
		lastTrace: undefined,
		register: () => Promise.reject(new Error("registration unavailable")),
	};
	return {
		ensemble,
		releaseAll: (): void => {
			for (const release of releases.splice(0)) release();
		},
		signals,
	};
}

function staticEnsemble(records: readonly AddressFilteredDrpRecord[]): RendezvousEnsemble {
	return {
		bootstrap: (): AsyncIterable<AddressFilteredDrpRecord> => {
			let index = 0;
			const iterator: AsyncIterableIterator<AddressFilteredDrpRecord> = {
				[Symbol.asyncIterator](): AsyncIterableIterator<AddressFilteredDrpRecord> {
					return iterator;
				},
				next: (): Promise<IteratorResult<AddressFilteredDrpRecord>> => {
					const record = records[index];
					index += 1;
					return Promise.resolve(
						record === undefined ? { done: true, value: undefined } : { done: false, value: record }
					);
				},
			};
			return iterator;
		},
		discover: () => Promise.resolve([]),
		lastTrace: undefined,
		register: () => Promise.reject(new Error("registration unavailable")),
	};
}

function filtered(record: SignedDrpRecordV1, acceptedAddresses: readonly string[]): AddressFilteredDrpRecord {
	return {
		acceptedAddresses,
		admissionMode: "invite",
		record,
		sourceEndpointId: "controlled-test",
	};
}

async function directoryFixture(): Promise<DirectoryFixture> {
	const now = Date.now();
	const target = await signedRecord(1, now);
	const other = await signedRecord(2, now);
	const servers = ["target-registry-a", "target-registry-b"].map(
		(endpointId) =>
			new RegistryServer({
				endpointId,
				limits: { maxRequestsPerNamespaceWindow: 1_000, maxRequestsPerWindow: 1_000 },
				now: (): number => now,
				policy: new AdmissionPolicy({ inviteToken: INVITE }),
				validator: validator(now),
			})
	);
	for (const record of [target, other]) {
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
		clientId: "targeted-object-reader",
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
	return { endpoints, ensemble, other, target };
}

async function startedNode(ensemble: RendezvousEnsemble): Promise<NodeFixture> {
	const getAllPeers = vi.fn((): string[] => []);
	const connect = vi.fn((): Promise<void> => Promise.resolve());
	const networkNode = fakeNetwork(connect, getAllPeers);
	const node = new DRPNode(nodeConfig(), { networkNode, reconnect: false });
	await node.start();
	node["_rendezvous"] = ensemble;
	return { connect, getAllPeers, networkNode, node };
}

function nodeConfig(): DRPNodeConfig {
	return {
		keychain_config: { private_key_seed: "targeted-connect-object-reader" },
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

function fakeNetwork(connect: ReturnType<typeof vi.fn>, getAllPeers: ReturnType<typeof vi.fn>): DRPNetworkNode {
	const networkNode = {
		membershipVerifier: undefined,
		peerId: "",
		start: vi.fn(function (this: DRPNetworkNode): Promise<void> {
			this.peerId = "targeted-connect-object-reader";
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

async function signedRecord(index: number, now: number): Promise<SignedDrpRecordV1> {
	const key = await generateKeyPairFromSeed(
		"Ed25519",
		Uint8Array.from({ length: 32 }, (_, offset) => (index * 29 + offset * 7) % 256)
	);
	const peerId = peerIdFromPublicKey(key.publicKey).toString();
	return new RecordSigner(key).sign({
		addresses: [`/ip4/93.184.216.34/tcp/4100/p2p/${peerId}`],
		capabilities: ["drp-gossipsub"],
		expiresAtMs: now + 60_000,
		issuedAtMs: now,
		namespace: NAMESPACE,
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
