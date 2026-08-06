/**
 * Phase 1n-c corrective RED: public peerless sync must select one existing
 * group peer and use the same negotiated payload builder as targeted sync.
 * The socket-free network derives the production node identity from its real
 * key, and objects use production-generated creator-bound IDs.
 */
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { type Address, type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import {
	DRP_HEADS_CHUNK_PROTOCOL,
	DRP_MESSAGE_PROTOCOL,
	type NegotiatedSyncSender,
	type SelectedSyncProtocol,
} from "@ts-drp/network";
import { HashGraph } from "@ts-drp/object";
import {
	ActionType,
	type DRPNetworkNode,
	type GroupPeerChangeHandler,
	type IDRP,
	type IDRPObject,
	Message,
	MessageType,
	type ResolveConflictsType,
	SemanticsType,
	Sync,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DRPNode } from "../src/index.js";
import {
	advertisedTheseHeads,
	prepareSyncSend,
	previewSyncSend,
	queueExactRequests,
	recordSharedHeads,
} from "../src/sync-state.js";

const FALLBACK_SELECTION = {
	mode: "fallback",
	protocol: DRP_MESSAGE_PROTOCOL,
} as const satisfies SelectedSyncProtocol;
const HEADS_SELECTION = {
	mode: "heads-chunk",
	protocol: DRP_HEADS_CHUNK_PROTOCOL,
} as const satisfies SelectedSyncProtocol;
const FALLBACK_HASH_CAP = 512;
const REQUEST_BYTE_CAP = 65_536;

class CounterDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	value = 0;

	increment(): void {
		this.value += 1;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

interface TransmittedSync {
	readonly message: Message;
	readonly peerId: string;
}

class CapturingSyncSender implements NegotiatedSyncSender {
	readonly invocations: string[] = [];
	readonly transmitted: TransmittedSync[] = [];

	constructor(
		readonly selection: SelectedSyncProtocol,
		private readonly events: string[]
	) {}

	async sendSyncMessage(
		peerId: string,
		payloadFactory: (selection: SelectedSyncProtocol) => Message | Promise<Message>
	): Promise<void> {
		this.invocations.push(peerId);
		this.events.push(`negotiated:${peerId}`);
		this.events.push("payload-factory");
		const message = await payloadFactory(this.selection);
		this.transmitted.push({ message, peerId });
		this.events.push("transmitted");
	}

	sendSyncResponseMessage(): Promise<void> {
		return Promise.resolve();
	}
}

interface FakeNetwork {
	readonly genericSyncSend: ReturnType<typeof vi.fn>;
	readonly getGroupPeers: ReturnType<typeof vi.fn>;
	readonly networkNode: DRPNetworkNode;
	setGroupPeers(peers: readonly string[]): void;
}

function createFakeNetwork(events: string[]): FakeNetwork {
	let peers: readonly string[] = [];
	const groupHandlers: GroupPeerChangeHandler[] = [];
	const genericSyncSend = vi.fn((_group: string, _message: Message): Promise<void> => {
		events.push("generic-random-send");
		return Promise.resolve();
	});
	const getGroupPeers = vi.fn((_group: string): string[] => {
		events.push("group-peers");
		return [...peers];
	});
	const networkNode = {
		membershipVerifier: undefined,
		peerId: "",
		start: vi.fn(function (this: DRPNetworkNode, rawPrivateKey?: Uint8Array): Promise<void> {
			if (rawPrivateKey === undefined) throw new Error("Expected the production node identity key");
			this.peerId = peerIdFromPublicKey(privateKeyFromRaw(rawPrivateKey).publicKey).toString();
			return Promise.resolve();
		}),
		stop: vi.fn(() => Promise.resolve()),
		restart: vi.fn(() => Promise.resolve()),
		isDialable: vi.fn(() => Promise.resolve(false)),
		changeTopicScoreParams: vi.fn(),
		removeTopicScoreParams: vi.fn(),
		subscribe: vi.fn(),
		unsubscribe: vi.fn(),
		connectToBootstraps: vi.fn(() => Promise.resolve()),
		connect: vi.fn(() => Promise.resolve()),
		disconnect: vi.fn(() => Promise.resolve()),
		getPeerMultiaddrs: vi.fn((_peerId: PeerId | string): Promise<Address[]> => Promise.resolve([])),
		getBootstrapNodes: vi.fn((): string[] => []),
		getSubscribedTopics: vi.fn((): string[] => []),
		getMultiaddrs: vi.fn((): string[] => []),
		getAllPeers: vi.fn((): string[] => []),
		getGroupPeers,
		broadcastMessage: vi.fn(() => Promise.resolve()),
		sendMessage: vi.fn(() => Promise.resolve()),
		sendGroupMessageRandomPeer: genericSyncSend,
		subscribeToMessageQueue: vi.fn(),
		subscribeToGroupPeerChanges: vi.fn((handler: GroupPeerChangeHandler) => {
			groupHandlers.push(handler);
			return (): void => {
				const index = groupHandlers.indexOf(handler);
				if (index !== -1) groupHandlers.splice(index, 1);
			};
		}),
	} satisfies DRPNetworkNode;
	return {
		genericSyncSend,
		getGroupPeers,
		networkNode,
		setGroupPeers(nextPeers): void {
			peers = [...nextPeers];
		},
	};
}

interface Harness {
	readonly events: string[];
	readonly network: FakeNetwork;
	readonly node: DRPNode;
	readonly object: IDRPObject<CounterDRP>;
	readonly peerId: string;
	readonly sender: CapturingSyncSender;
}

let harnessIndex = 0;

async function makeHarness(selection: SelectedSyncProtocol): Promise<Harness> {
	const events: string[] = [];
	const network = createFakeNetwork(events);
	const sender = new CapturingSyncSender(selection, events);
	const node = new DRPNode(
		{
			interval_sync_options: { interval: 60_000 },
			keychain_config: { private_key_seed: `phase-1n-c-peerless-${harnessIndex++}` },
			log_config: { level: "silent" },
		},
		{ networkNode: network.networkNode, reconnect: false, syncSender: sender }
	);
	await node.start();
	const object = await node.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
	// The periodic owner is irrelevant to this manual public-call test.
	for (const interval of node["_intervals"].values()) interval.stop();
	node["_intervals"].clear();
	events.length = 0;
	const peerId = peerIdFromPublicKey(
		privateKeyFromRaw(Uint8Array.from({ length: 32 }, (_, index) => index + harnessIndex)).publicKey
	).toString();
	return { events, network, node, object, peerId, sender };
}

function exactHash(index: number): string {
	return index.toString(16).padStart(64, "0");
}

function decoded(message: Message): Sync {
	return Sync.decode(message.data);
}

function genericDiagnostics(network: FakeNetwork): {
	readonly encodedByteLengths: number[];
	readonly sendCount: number;
	readonly vertexHashCounts: number[];
} {
	const messages = network.genericSyncSend.mock.calls.map(([, message]) => message as Message);
	return {
		encodedByteLengths: messages.map((message) => Message.encode(message).finish().byteLength),
		sendCount: messages.length,
		vertexHashCounts: messages.map((message) => decoded(message).vertexHashes.length),
	};
}

async function rejectionFrom(promise: Promise<void>): Promise<unknown> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

function expectUnmutatedExactLifecycle(harness: Harness, outstanding: string): void {
	expect.soft(previewSyncSend(harness.node, harness.object.id, harness.peerId, "scheduled-probe")).toMatchObject({
		requestedHashes: [outstanding],
		send: true,
	});
	for (let attempt = 0; attempt < 3; attempt++) {
		expect.soft(prepareSyncSend(harness.node, harness.object.id, harness.peerId, "scheduled-probe")).toMatchObject({
			requestedHashes: [outstanding],
			send: true,
		});
	}
	expect.soft(prepareSyncSend(harness.node, harness.object.id, harness.peerId, "scheduled-probe").send).toBe(false);
	expect
		.soft(advertisedTheseHeads(harness.node, harness.object.id, harness.peerId, harness.object.getHistoryHeads()))
		.toBe(false);
}

describe("Phase 1n-c peerless negotiated sync egress", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("selects one group peer before fallback construction and rejects 513 hashes without transmission or accounting", async () => {
		const harness = await makeHarness(FALLBACK_SELECTION);
		nodes.push(harness.node);
		harness.network.setGroupPeers([harness.peerId]);
		while (harness.object.historyInventory.knownHashes.length <= FALLBACK_HASH_CAP) harness.object.drp?.increment();
		expect(harness.object.historyInventory.knownHashes).toHaveLength(FALLBACK_HASH_CAP + 1);
		const outstanding = exactHash(10_001);
		expect(queueExactRequests(harness.node, harness.object.id, harness.peerId, [outstanding])).toBe(true);

		const rejection = await rejectionFrom(harness.node.syncObject(harness.object.id));
		expect.soft(rejection).toMatchObject({ code: "SYNC_FALLBACK_LIMIT" });
		expect.soft(harness.network.getGroupPeers).toHaveBeenCalledWith(harness.object.id);
		expect.soft(harness.events.slice(0, 3)).toEqual(["group-peers", `negotiated:${harness.peerId}`, "payload-factory"]);
		expect.soft(harness.sender.invocations).toEqual([harness.peerId]);
		expect.soft(harness.sender.transmitted).toEqual([]);
		expect.soft(genericDiagnostics(harness.network)).toEqual({
			encodedByteLengths: [],
			sendCount: 0,
			vertexHashCounts: [],
		});
		expectUnmutatedExactLifecycle(harness, outstanding);
	});

	test("rejects a within-count fallback whose complete Message exceeds 65,536 bytes without transmission or accounting", async () => {
		const harness = await makeHarness(FALLBACK_SELECTION);
		nodes.push(harness.node);
		harness.network.setGroupPeers([harness.peerId]);
		const longHashes = Array.from({ length: 40 }, (_, index) => `${index}:`.padEnd(1_800, "x"));
		const realInventoryGetter = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(harness.object),
			"historyInventory"
		)?.get;
		if (realInventoryGetter === undefined) throw new Error("Expected the real history inventory owner");
		Object.defineProperty(harness.object, "historyInventory", {
			configurable: true,
			get: () => ({ ...realInventoryGetter.call(harness.object), knownHashes: longHashes }),
		});
		const candidate = Message.create({
			data: Sync.encode(Sync.create({ vertexHashes: longHashes })).finish(),
			objectId: harness.object.id,
			sender: harness.node.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_SYNC,
		});
		expect(longHashes.length).toBeLessThanOrEqual(FALLBACK_HASH_CAP);
		expect(Message.encode(candidate).finish().byteLength).toBeGreaterThan(REQUEST_BYTE_CAP);
		const outstanding = exactHash(10_002);
		expect(queueExactRequests(harness.node, harness.object.id, harness.peerId, [outstanding])).toBe(true);

		const rejection = await rejectionFrom(harness.node.syncObject(harness.object.id));
		expect.soft(rejection).toMatchObject({ code: "SYNC_FALLBACK_LIMIT" });
		expect.soft(harness.sender.invocations).toEqual([harness.peerId]);
		expect.soft(harness.sender.transmitted).toEqual([]);
		expect.soft(genericDiagnostics(harness.network)).toEqual({
			encodedByteLengths: [],
			sendCount: 0,
			vertexHashCounts: [],
		});
		expectUnmutatedExactLifecycle(harness, outstanding);
	});

	test("routes one ordinary complete fallback inventory through the negotiated sender only", async () => {
		const harness = await makeHarness(FALLBACK_SELECTION);
		nodes.push(harness.node);
		harness.network.setGroupPeers([harness.peerId]);
		for (let index = 0; index < 4; index++) harness.object.drp?.increment();
		const inventory = [...harness.object.historyInventory.knownHashes];

		await harness.node.syncObject(harness.object.id);

		expect.soft(harness.sender.invocations).toEqual([harness.peerId]);
		expect.soft(harness.sender.transmitted).toHaveLength(1);
		const message = harness.sender.transmitted[0]?.message;
		expect.soft(message).toBeDefined();
		if (message !== undefined) {
			expect.soft(decoded(message)).toMatchObject({
				heads: [],
				requestedHashes: [],
				sharedHeads: [],
				vertexHashes: inventory,
			});
		}
		expect.soft(genericDiagnostics(harness.network)).toEqual({
			encodedByteLengths: [],
			sendCount: 0,
			vertexHashCounts: [],
		});
		expect
			.soft(advertisedTheseHeads(harness.node, harness.object.id, harness.peerId, harness.object.getHistoryHeads()))
			.toBe(false);
	});

	test("lets heads selection build heads, shared, and exact fields through the same peerless call", async () => {
		const harness = await makeHarness(HEADS_SELECTION);
		nodes.push(harness.node);
		harness.network.setGroupPeers([harness.peerId]);
		harness.object.drp?.increment();
		harness.object.drp?.increment();
		const exact = exactHash(10_003);
		expect(queueExactRequests(harness.node, harness.object.id, harness.peerId, [exact])).toBe(true);
		recordSharedHeads(harness.node, harness.object.id, harness.peerId, [HashGraph.rootHash]);

		await harness.node.syncObject(harness.object.id);

		expect.soft(harness.sender.invocations).toEqual([harness.peerId]);
		expect.soft(harness.sender.transmitted).toHaveLength(1);
		const message = harness.sender.transmitted[0]?.message;
		expect.soft(message).toBeDefined();
		if (message !== undefined) {
			expect.soft(decoded(message)).toMatchObject({
				heads: harness.object.getHistoryHeads(),
				requestedHashes: [exact],
				sharedHeads: [HashGraph.rootHash],
				vertexHashes: [],
			});
		}
		expect.soft(genericDiagnostics(harness.network)).toEqual({
			encodedByteLengths: [],
			sendCount: 0,
			vertexHashCounts: [],
		});
		expect
			.soft(advertisedTheseHeads(harness.node, harness.object.id, harness.peerId, harness.object.getHistoryHeads()))
			.toBe(true);
	});

	test("is inert without a group peer and fabricates no transmission or lifecycle accounting", async () => {
		const harness = await makeHarness(HEADS_SELECTION);
		nodes.push(harness.node);
		harness.network.setGroupPeers([]);
		const outstanding = exactHash(10_004);
		expect(queueExactRequests(harness.node, harness.object.id, harness.peerId, [outstanding])).toBe(true);

		await harness.node.syncObject(harness.object.id);

		expect.soft(harness.network.getGroupPeers).toHaveBeenCalledWith(harness.object.id);
		expect.soft(harness.sender.invocations).toEqual([]);
		expect.soft(harness.sender.transmitted).toEqual([]);
		expect.soft(genericDiagnostics(harness.network)).toEqual({
			encodedByteLengths: [],
			sendCount: 0,
			vertexHashCounts: [],
		});
		expectUnmutatedExactLifecycle(harness, outstanding);
	});
});
