import { privateKeyFromRaw, publicKeyFromRaw } from "@libp2p/crypto/keys";
import { type Address, type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { Keychain } from "@ts-drp/keychain";
import { createACL, createVertex, HashGraph } from "@ts-drp/object";
import {
	ACLGroup,
	type DRPNetworkNode,
	DrpType,
	type GroupPeerChangeHandler,
	type IDRP,
	type Message,
	MessageType,
	type NodeCreateObjectOptions,
	Operation,
	SemanticsType,
	Sync,
	SyncAccept,
	SyncReject,
	type Update,
	Update as UpdateCodec,
	type Vertex,
	Vertex as VertexCodec,
} from "@ts-drp/types";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { afterEach, beforeAll, describe, expect, it, test, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

const execFileAsync = promisify(execFile);

interface FakeNetworkControls {
	networkNode: DRPNetworkNode;
	sendMessage: ReturnType<typeof vi.fn>;
}

interface CompactHistoryIdentity {
	keychain: Keychain;
	peerId: string;
}

interface ArtifactProvenance {
	artifactMtimeMs: number;
	artifactSha256: string;
	objectModulePath: string;
	sourceMaxMtimeMs: number;
	sourceTreeSha256: string;
}

interface BoundedScaleResult {
	artifactProvenance: ArtifactProvenance;
	digest: string;
	nonRootVertices: number;
}

interface CompactScaleResult {
	artifactProvenance: ArtifactProvenance;
	availableNonRootPayloads: number;
	digest: string;
	knownNonRootHashes: number;
	payloadAvailabilityTruthful: boolean;
	retainedHeapBytes: number;
}

class CompactHistoryDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}
}

async function compactHistoryIdentity(seed: string): Promise<CompactHistoryIdentity> {
	const keychain = new Keychain({ private_key_seed: seed });
	await keychain.start();
	const publicKey = publicKeyFromRaw(uint8ArrayFromString(keychain.secp256k1PublicKey, "base64"));
	return { keychain, peerId: peerIdFromPublicKey(publicKey).toString() };
}

async function signedCompactHistory(author: CompactHistoryIdentity): Promise<readonly Vertex[]> {
	const signed = async (
		opType: string,
		value: unknown[],
		dependencies: string[],
		timestamp: number,
		drpType = DrpType.DRP
	): Promise<Vertex> => {
		const vertex = createVertex(author.peerId, Operation.create({ drpType, opType, value }), dependencies, timestamp);
		vertex.signature = await author.keychain.signWithSecp256k1(vertex.hash);
		return vertex;
	};
	const first = await signed("append", [1], [HashGraph.rootHash], 1_700_000_013_001);
	const grant = await signed(
		"grant",
		["phase-1i-b-node-guest", ACLGroup.Writer],
		[first.hash],
		1_700_000_013_002,
		DrpType.ACL
	);
	const vertices = [first, grant];
	for (let value = 2; value <= 6; value++) {
		vertices.push(
			await signed("append", [value], [vertices.at(-1)?.hash ?? HashGraph.rootHash], 1_700_000_013_001 + value)
		);
	}
	return vertices;
}

function cloneVertex(vertex: Vertex): Vertex {
	return VertexCodec.decode(VertexCodec.encode(vertex).finish());
}

function createFakeNetwork(): FakeNetworkControls {
	const groupHandlers: GroupPeerChangeHandler[] = [];
	const sendMessage = vi.fn(() => Promise.resolve());
	const networkNode = {
		membershipVerifier: undefined,
		peerId: "",
		start: vi.fn(function (this: DRPNetworkNode, rawPrivateKey?: Uint8Array): Promise<void> {
			if (rawPrivateKey === undefined) throw new Error("Expected the node identity key");
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
		getGroupPeers: vi.fn((): string[] => []),
		broadcastMessage: vi.fn(() => Promise.resolve()),
		sendMessage,
		sendGroupMessageRandomPeer: vi.fn(() => Promise.resolve()),
		subscribeToMessageQueue: vi.fn(),
		subscribeToGroupPeerChanges: vi.fn((handler) => {
			groupHandlers.push(handler);
			return (): void => {
				const index = groupHandlers.indexOf(handler);
				if (index !== -1) groupHandlers.splice(index, 1);
			};
		}),
	} satisfies DRPNetworkNode;
	return { networkNode, sendMessage };
}

let attacker: CompactHistoryIdentity;
let author: CompactHistoryIdentity;
const nodes: DRPNode[] = [];

beforeAll(async () => {
	[author, attacker] = await Promise.all([
		compactHistoryIdentity("phase-1i-b-node-author"),
		compactHistoryIdentity("phase-1i-b-node-attacker"),
	]);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
});

async function compactNodeObject(
	seed: string,
	objectId: string
): Promise<{
	controls: FakeNetworkControls;
	node: DRPNode;
	object: Awaited<ReturnType<DRPNode["createObject"]>>;
}> {
	const controls = createFakeNetwork();
	const node = new DRPNode(
		{ keychain_config: { private_key_seed: seed }, log_config: { level: "silent" } },
		{ networkNode: controls.networkNode, reconnect: false }
	);
	await node.start();
	nodes.push(node);
	const options = {
		acl: createACL({ admins: [author.peerId] }),
		drp: new CompactHistoryDRP(),
		history_storage: "compact",
		id: objectId,
		replica_mode: "observer",
	} satisfies NodeCreateObjectOptions<CompactHistoryDRP>;
	const object = await node.createObject(options);
	return { controls, node, object };
}

function updateMessage(sender: string, objectId: string, update: Update): Message {
	return {
		data: UpdateCodec.encode(update).finish(),
		objectId,
		sender,
		type: MessageType.MESSAGE_TYPE_UPDATE,
	};
}

describe("Phase 1i-b compact observer network boundaries", () => {
	it("authenticates both live UPDATE and SYNC_ACCEPT offers before inventory admission", async () => {
		const objectId = `${author.peerId}:phase-1i-b-network-ingress`;
		const { node, object } = await compactNodeObject("phase-1i-b-network-observer", objectId);
		const history = await signedCompactHistory(author);
		const first = history[0];
		const second = history[1];
		if (first === undefined || second === undefined) throw new Error("Expected signed ingress fixtures");
		const forgedFirst = cloneVertex(first);
		forgedFirst.signature = await attacker.keychain.signWithSecp256k1(forgedFirst.hash);

		await handleMessage(
			node,
			updateMessage(author.peerId, objectId, UpdateCodec.create({ attestations: [], vertices: [forgedFirst] }))
		);
		expect(object.getVertex(first.hash)).toBeUndefined();
		expect.soft(object.historyInventory, "missing authenticated history inventory").toBeDefined();
		if (object.historyInventory !== undefined) {
			expect(object.historyInventory.knownHashes).toEqual([HashGraph.rootHash]);
		}

		await handleMessage(
			node,
			updateMessage(author.peerId, objectId, UpdateCodec.create({ attestations: [], vertices: [first] }))
		);
		expect(object.getVertex(first.hash)).toEqual(first);

		const forgedSecond = cloneVertex(second);
		forgedSecond.signature = await attacker.keychain.signWithSecp256k1(forgedSecond.hash);
		const sync = (vertices: typeof history): Message => ({
			data: SyncAccept.encode(
				SyncAccept.create({ attestations: [], requested: [...vertices], requesting: [] })
			).finish(),
			objectId,
			sender: author.peerId,
			type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
		});
		await handleMessage(node, sync([forgedSecond]));
		expect(object.getVertex(second.hash)).toBeUndefined();
		await handleMessage(node, sync([second]));
		expect(object.getVertex(second.hash)).toEqual(second);

		expect.soft(object.historyInventory, "missing authenticated history inventory").toBeDefined();
		if (object.historyInventory === undefined) return;
		expect(object.historyInventory.knownHashes).toEqual([HashGraph.rootHash, first.hash, second.hash]);
		expect(new Set(object.historyInventory.knownHashes).size).toBe(3);
	});

	it("returns a typed history-unavailable SYNC_REJECT instead of serving a partial history", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
		const objectId = `${author.peerId}:phase-1i-b-sync-service`;
		const { controls, node, object } = await compactNodeObject("phase-1i-b-sync-observer", objectId);
		const history = await signedCompactHistory(author);
		await object.applyVertices([...history]);
		expect.soft(object.historyInventory, "missing authenticated history inventory").toBeDefined();
		if (object.historyInventory === undefined) return;
		const prunedHashes = object.historyInventory.knownHashes.filter(
			(hash: string) => !object.historyInventory.availablePayloadHashes.includes(hash)
		);
		expect(prunedHashes.length).toBeGreaterThan(0);

		await handleMessage(node, {
			data: Sync.encode(Sync.create({ vertexHashes: [HashGraph.rootHash] })).finish(),
			objectId,
			sender: "phase-1i-b-fresh-requester",
			type: MessageType.MESSAGE_TYPE_SYNC,
		});
		expect(controls.sendMessage).toHaveBeenCalledTimes(1);
		const [, response] = controls.sendMessage.mock.calls[0] as [string, Message];
		expect.soft(response.type).toBe(MessageType.MESSAGE_TYPE_SYNC_REJECT);
		expect(SyncReject.decode(response.data)).toEqual({
			missingHashes: prunedHashes,
			reason: "history-unavailable",
		});
		expect(response.type).not.toBe(MessageType.MESSAGE_TYPE_SYNC_ACCEPT);
	});

	it("keeps compact capability truth after public history-mode mutation attempts", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
		const objectId = `${author.peerId}:phase-1i-b-capability-state`;
		const { controls, node, object } = await compactNodeObject("phase-1i-b-capability-state-observer", objectId);
		const history = await signedCompactHistory(author);
		await expect(object.applyVertices([...history])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});

		const before = {
			historyInventory: structuredClone(object.historyInventory),
			historyStorage: object.historyStorage,
		};
		const missingHashes = before.historyInventory.knownHashes.filter(
			(hash) => !before.historyInventory.availablePayloadHashes.includes(hash)
		);
		expect(before.historyStorage).toBe("compact");
		expect(before.historyInventory.knownHashes.length).toBeGreaterThan(
			before.historyInventory.availablePayloadHashes.length
		);
		expect(missingHashes.length, "fixture must honestly prune authenticated payloads").toBeGreaterThan(0);
		for (const hash of missingHashes) {
			expect(object.getVertexPayload(hash)).toEqual({
				missingHashes: [hash],
				status: "history-unavailable",
			});
		}

		const mutableCapability: { historyStorage: "compact" | "full" } = object;
		try {
			mutableCapability.historyStorage = "full";
		} catch {
			// A getter-only public capability may reject ordinary strict-mode assignment.
		}
		const afterOrdinaryAssignment = object.historyStorage;
		let reflectiveMutationSucceeded = false;
		try {
			reflectiveMutationSucceeded = Reflect.set(object, "historyStorage", "full");
		} catch {
			// A hardened proxy may reject the reflective write rather than return false.
		}

		const rehydration = await object.rehydrateHistory([]);
		let authorshipDenied = false;
		try {
			object.drp?.append(99);
		} catch (error) {
			authorshipDenied = /compact.*author|author.*compact/i.test(String(error));
		}
		let finalityDenied = false;
		try {
			void object.finalityStore;
		} catch (error) {
			finalityDenied = /observer.*finality|finality.*observer/i.test(String(error));
		}

		controls.sendMessage.mockClear();
		await handleMessage(node, {
			data: Sync.encode(Sync.create({ vertexHashes: [HashGraph.rootHash] })).finish(),
			objectId,
			sender: "phase-1i-b-capability-state-requester",
			type: MessageType.MESSAGE_TYPE_SYNC,
		});
		const response = controls.sendMessage.mock.calls[0]?.[1] as Message | undefined;
		const decodedRejection =
			response?.type === MessageType.MESSAGE_TYPE_SYNC_REJECT ? SyncReject.decode(response.data) : undefined;
		const after = object.historyInventory;

		expect({
			authorshipDenied,
			availablePayloadsUnchanged:
				after.availablePayloadHashes.length === before.historyInventory.availablePayloadHashes.length &&
				after.availablePayloadHashes.every(
					(hash, index) => hash === before.historyInventory.availablePayloadHashes[index]
				),
			capabilityInternallyConsistent:
				object.historyStorage === "compact" || after.availablePayloadHashes.length === after.knownHashes.length,
			decodedRejection,
			finalityDenied,
			historyInventory: after,
			historyStorageAfterOrdinaryAssignment: afterOrdinaryAssignment,
			historyStorageAfterRehydration: object.historyStorage,
			missingPayloadsRemainUnavailable: missingHashes.every(
				(hash) => object.getVertexPayload(hash).status === "history-unavailable"
			),
			reflectiveMutationSucceeded,
			rehydrationStatus: rehydration.status,
			replicaMode: object.replicaMode,
			syncResponseCount: controls.sendMessage.mock.calls.length,
			syncResponseType: response?.type,
		}).toEqual({
			authorshipDenied: true,
			availablePayloadsUnchanged: true,
			capabilityInternallyConsistent: true,
			decodedRejection: { missingHashes, reason: "history-unavailable" },
			finalityDenied: true,
			historyInventory: before.historyInventory,
			historyStorageAfterOrdinaryAssignment: "compact",
			historyStorageAfterRehydration: "compact",
			missingPayloadsRemainUnavailable: true,
			reflectiveMutationSucceeded: false,
			rehydrationStatus: "rejected",
			replicaMode: "observer",
			syncResponseCount: 1,
			syncResponseType: MessageType.MESSAGE_TYPE_SYNC_REJECT,
		});
	});
});

it("keeps the freshly built signed 64-vertex writer/full-observer provenance control green", async () => {
	const helper = new URL("./helpers/observer-mode-scale.ts", import.meta.url);
	const run = async (replicaMode: "observer" | "writer"): Promise<BoundedScaleResult> => {
		const { stdout } = await execFileAsync(
			process.execPath,
			["--expose-gc", "--import", "tsx", helper.pathname, replicaMode, "64"],
			{ maxBuffer: 1024 * 1024, timeout: 30_000 }
		);
		const line = stdout
			.trim()
			.split("\n")
			.findLast((candidate) => candidate.startsWith("{"));
		if (line === undefined) throw new Error(`${replicaMode} bounded control emitted no JSON result`);
		return JSON.parse(line) as BoundedScaleResult;
	};
	const writer = await run("writer");
	const observer = await run("observer");
	expect(writer.nonRootVertices).toBe(64);
	expect(observer.nonRootVertices).toBe(64);
	expect(observer.digest).toBe(writer.digest);
	expect(observer.artifactProvenance).toEqual(writer.artifactProvenance);
	expect(writer.artifactProvenance.artifactMtimeMs).toBeGreaterThanOrEqual(writer.artifactProvenance.sourceMaxMtimeMs);
	expect(writer.artifactProvenance.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(writer.artifactProvenance.sourceTreeSha256).toMatch(/^[0-9a-f]{64}$/);
});

test.skipIf(process.env.RUN_PHASE_1I_B_SCALE !== "true")(
	"freshly built 100k compact observer retains below 25% of writer heap with truthful inventory",
	async () => {
		const helper = new URL("./helpers/compact-history-scale-1i-b.ts", import.meta.url);
		const run = async (profile: "compact" | "writer"): Promise<CompactScaleResult> => {
			const { stdout } = await execFileAsync(
				process.execPath,
				["--expose-gc", "--import", "tsx", helper.pathname, profile, "100000"],
				{ maxBuffer: 1024 * 1024, timeout: 20 * 60 * 1000 }
			);
			const line = stdout
				.trim()
				.split("\n")
				.findLast((candidate) => candidate.startsWith("{"));
			if (line === undefined) throw new Error(`${profile} scale worker emitted no JSON result`);
			return JSON.parse(line) as CompactScaleResult;
		};

		const writer = await run("writer");
		const compact = await run("compact");
		const ratio = compact.retainedHeapBytes / writer.retainedHeapBytes;
		console.info(JSON.stringify({ compact, gate: "phase-1i-b-100k-compact-history", ratio, writer }));
		const expectedObjectModule = new URL("../../object/dist/src/index.js", import.meta.url).pathname;

		expect(writer.knownNonRootHashes).toBe(100_000);
		expect(compact.knownNonRootHashes).toBe(100_000);
		expect(writer.availableNonRootPayloads).toBe(100_000);
		expect(compact.availableNonRootPayloads).toBeLessThan(compact.knownNonRootHashes);
		expect(writer.payloadAvailabilityTruthful).toBe(true);
		expect(compact.payloadAvailabilityTruthful).toBe(true);
		expect(compact.digest).toBe(writer.digest);
		expect(writer.artifactProvenance).toEqual(compact.artifactProvenance);
		expect(writer.artifactProvenance.objectModulePath).toBe(expectedObjectModule);
		expect(writer.artifactProvenance.artifactMtimeMs).toBeGreaterThanOrEqual(
			writer.artifactProvenance.sourceMaxMtimeMs
		);
		expect(writer.artifactProvenance.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(writer.artifactProvenance.sourceTreeSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(writer.retainedHeapBytes).toBeGreaterThan(0);
		expect(compact.retainedHeapBytes).toBeGreaterThan(0);
		expect(ratio).toBeLessThan(0.25);
	},
	45 * 60 * 1000
);
