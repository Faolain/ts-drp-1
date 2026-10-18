import { bls } from "@chainsafe/bls/herumi";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { type Address, type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { Signature } from "@noble/secp256k1";
import { createACL, createPermissionlessACL, createVertex, HashGraph } from "@ts-drp/object";
import {
	type DRPNetworkNode,
	DrpType,
	type GroupPeerChangeHandler,
	type IACL,
	type IDRP,
	type Message,
	MessageType,
	type NodeConnectObjectOptions,
	type NodeCreateObjectOptions,
	Operation,
	SemanticsType,
	Sync,
	SyncAccept,
	Update,
	type Vertex,
	Vertex as VertexCodec,
} from "@ts-drp/types";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMessage, verifyACLIncomingVertices } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

const finalityConstructions = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../object/src/finality/index.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	const FinalityStore = actual["FinalityStore"];
	if (typeof FinalityStore !== "function") throw new TypeError("Expected the production FinalityStore constructor");
	return {
		...actual,
		FinalityStore: new Proxy(FinalityStore, {
			construct(target, args, newTarget): object {
				finalityConstructions.count++;
				return Reflect.construct(target, args, newTarget) as object;
			},
		}),
	};
});

const execFileAsync = promisify(execFile);

type PreDriftHashGraphPrototype = HashGraph & {
	enableHistoryCompaction?(): void;
	hasVertex?(hash: string): boolean;
};

function installObserverPreDriftControl(): () => void {
	const prototype = HashGraph.prototype as PreDriftHashGraphPrototype;
	const enableDescriptor = Object.getOwnPropertyDescriptor(prototype, "enableHistoryCompaction");
	const hasDescriptor = Object.getOwnPropertyDescriptor(prototype, "hasVertex");
	const installedEnable = typeof prototype.enableHistoryCompaction !== "function";
	const installedHas = typeof prototype.hasVertex !== "function";
	if (installedEnable) {
		Object.defineProperty(prototype, "enableHistoryCompaction", {
			configurable: true,
			value: (): void => undefined,
			writable: true,
		});
	}
	if (installedHas) {
		Object.defineProperty(prototype, "hasVertex", {
			configurable: true,
			value(this: HashGraph, hash: string): boolean {
				return this.vertices.has(hash);
			},
			writable: true,
		});
	}
	return (): void => {
		if (installedEnable) {
			if (enableDescriptor === undefined) delete prototype.enableHistoryCompaction;
			else Object.defineProperty(prototype, "enableHistoryCompaction", enableDescriptor);
		}
		if (installedHas) {
			if (hasDescriptor === undefined) delete prototype.hasVertex;
			else Object.defineProperty(prototype, "hasVertex", hasDescriptor);
		}
	};
}

class ProductPathDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}

	query_values(): number[] {
		return [...this.values];
	}
}

type Phase1iNodeCreateObjectOptions<T extends IDRP> = NodeCreateObjectOptions<T> & {
	replica_mode: "observer" | "writer";
};

interface FakeNetworkControls {
	broadcastMessage: ReturnType<typeof vi.fn>;
	networkNode: DRPNetworkNode;
	sendMessage: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
}

function createFakeNetwork(): FakeNetworkControls {
	const messageHandlers: Array<(message: Message) => Promise<void>> = [];
	const groupHandlers: GroupPeerChangeHandler[] = [];
	const subscribe = vi.fn();
	const broadcastMessage = vi.fn(() => Promise.resolve());
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
		subscribe,
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
		broadcastMessage,
		publishMessage: vi.fn((): Promise<true> => Promise.resolve(true)),
		gossipTopicFor: vi.fn((): undefined => undefined),
		sendMessage,
		sendGroupMessageRandomPeer: vi.fn(() => Promise.resolve()),
		subscribeToMessageQueue: vi.fn((handler) => {
			messageHandlers.push(handler);
		}),
		subscribeToGroupPeerChanges: vi.fn((handler) => {
			groupHandlers.push(handler);
			return (): void => {
				const index = groupHandlers.indexOf(handler);
				if (index !== -1) groupHandlers.splice(index, 1);
			};
		}),
	} satisfies DRPNetworkNode;
	return { broadcastMessage, networkNode, sendMessage, subscribe };
}

async function productNode(seed: string): Promise<{ controls: FakeNetworkControls; node: DRPNode }> {
	const controls = createFakeNetwork();
	const node = new DRPNode(
		{
			keychain_config: { private_key_seed: seed },
			log_config: { level: "silent" },
		},
		{ networkNode: controls.networkNode, reconnect: false }
	);
	await node.start();
	return { controls, node };
}

function updatesFor(controls: FakeNetworkControls, objectId: string): Message[] {
	return controls.broadcastMessage.mock.calls
		.map(([, message]) => message as Message)
		.filter(({ objectId: id, type }) => id === objectId && type === MessageType.MESSAGE_TYPE_UPDATE);
}

function attestationUpdatesFor(controls: FakeNetworkControls, objectId: string): Message[] {
	return controls.broadcastMessage.mock.calls
		.map(([, message]) => message as Message)
		.filter(({ objectId: id, type }) => id === objectId && type === MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE);
}

function sharedRoomACL(nodes: readonly DRPNode[]): IACL {
	const acl = createACL({ admins: nodes.map(({ networkNode }) => networkNode.peerId) });
	for (const node of nodes) {
		acl.context = { caller: node.networkNode.peerId };
		acl.setKey(node.keychain.blsPublicKey);
	}
	acl.context = { caller: "" };
	return acl;
}

async function phase1iPair(
	sourceRuntime: Awaited<ReturnType<typeof productNode>>,
	observerRuntime: Awaited<ReturnType<typeof productNode>>,
	objectId: string
): Promise<{
	constructionsBeforeObserver: number;
	observer: Awaited<ReturnType<DRPNode["createObject"]>>;
	source: Awaited<ReturnType<DRPNode["createObject"]>>;
}> {
	const roomNodes = [sourceRuntime.node, observerRuntime.node];
	const sourceOptions = {
		acl: sharedRoomACL(roomNodes),
		drp: new ProductPathDRP(),
		id: objectId,
		replica_mode: "writer",
	} satisfies Phase1iNodeCreateObjectOptions<ProductPathDRP>;
	const source = await sourceRuntime.node.createObject(sourceOptions);
	const constructionsBeforeObserver = finalityConstructions.count;
	const observerOptions = {
		acl: sharedRoomACL(roomNodes),
		drp: new ProductPathDRP(),
		id: objectId,
		replica_mode: "observer",
	} satisfies Phase1iNodeCreateObjectOptions<ProductPathDRP>;
	const observer = await observerRuntime.node.createObject(observerOptions);
	return { constructionsBeforeObserver, observer, source };
}

async function latestUpdate(controls: FakeNetworkControls, objectId: string, count: number): Promise<Update> {
	await vi.waitFor(() => expect(updatesFor(controls, objectId)).toHaveLength(count));
	const message = updatesFor(controls, objectId).at(-1);
	if (message === undefined) throw new Error(`Expected UPDATE for ${objectId}`);
	return Update.decode(message.data);
}

describe("Phase 1c public node finality configuration", () => {
	const nodes: DRPNode[] = [];
	let restoreObserverControl: (() => void) | undefined;

	function enableObserverControl(): void {
		if (restoreObserverControl !== undefined) throw new Error("Observer causal control is already installed");
		restoreObserverControl = installObserverPreDriftControl();
	}

	afterEach(async () => {
		restoreObserverControl?.();
		restoreObserverControl = undefined;
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
		finalityConstructions.count = 0;
	});

	test("createObject forwards a room-scoped disabled finality config without weakening vertex handling", async () => {
		const { controls, node } = await productNode("phase-1c-public-create");
		nodes.push(node);
		const acl = createACL({ admins: [node.networkNode.peerId] });
		acl.context = { caller: node.networkNode.peerId };
		acl.setKey(node.keychain.blsPublicKey);
		acl.context = { caller: "" };
		const options = {
			acl,
			drp: new ProductPathDRP(),
			finality_config: { enabled: false },
			id: "phase-1c-public-create-disabled",
		} satisfies NodeCreateObjectOptions<ProductPathDRP>;

		const disabled = await node.createObject(options);
		const enabledSibling = await node.createObject({
			acl: createPermissionlessACL(),
			drp: new ProductPathDRP(),
			id: "phase-1c-public-create-enabled",
		});
		const blsSigns = vi.spyOn(node.keychain, "signWithBls");

		disabled.drp?.append(7);
		const update = await latestUpdate(controls, disabled.id, 1);

		expect.soft(node.get(disabled.id)).toBe(disabled);
		expect.soft(node.messageQueueManager.hasQueue(disabled.id)).toBe(true);
		expect.soft(controls.subscribe).toHaveBeenCalledWith(disabled.id);
		expect.soft(disabled.finalityStore.enabled).toBe(false);
		expect.soft(enabledSibling.finalityStore.enabled).toBe(true);
		expect.soft(disabled.finalityStore.states.size).toBe(0);
		expect.soft(blsSigns).toHaveBeenCalledTimes(0);
		expect.soft(update.attestations).toEqual([]);
		expect.soft(attestationUpdatesFor(controls, disabled.id)).toEqual([]);
		expect.soft(update.vertices).toHaveLength(1);
		expect.soft(update.vertices[0]?.signature).toHaveLength(65);
		expect.soft(verifyACLIncomingVertices(update.vertices)).toHaveLength(1);
		expect(disabled.drp?.query_values()).toEqual([7]);
	});

	test("connectObject independently forwards disabled finality config and keeps a default sibling enabled", async () => {
		const { controls, node } = await productNode("phase-1c-public-connect");
		nodes.push(node);
		vi.useFakeTimers();
		const disabledId = `${node.networkNode.peerId}:phase-1c-public-connect-disabled`;
		const enabledId = `${node.networkNode.peerId}:phase-1c-public-connect-enabled`;
		const options = {
			drp: new ProductPathDRP(),
			finality_config: { enabled: false },
			id: disabledId,
		} satisfies NodeConnectObjectOptions<ProductPathDRP>;
		const disabledConnection = node.connectObject(options);
		const enabledConnection = node.connectObject({ drp: new ProductPathDRP(), id: enabledId });
		await vi.advanceTimersByTimeAsync(5_000);
		const [disabled, enabledSibling] = await Promise.all([disabledConnection, enabledConnection]);
		vi.useRealTimers();
		const blsSigns = vi.spyOn(node.keychain, "signWithBls");

		disabled.acl.context = { caller: node.networkNode.peerId };
		disabled.acl.setKey(node.keychain.blsPublicKey);
		await latestUpdate(controls, disabled.id, 1);
		disabled.drp?.append(11);
		const update = await latestUpdate(controls, disabled.id, 2);

		expect.soft(node.get(disabled.id)).toBe(disabled);
		expect.soft(node.messageQueueManager.hasQueue(disabled.id)).toBe(true);
		expect.soft(controls.subscribe).toHaveBeenCalledWith(disabled.id);
		expect.soft(disabled.finalityStore.enabled).toBe(false);
		expect.soft(enabledSibling.finalityStore.enabled).toBe(true);
		expect.soft(disabled.finalityStore.states.size).toBe(0);
		expect.soft(blsSigns).toHaveBeenCalledTimes(0);
		expect.soft(update.attestations).toEqual([]);
		expect.soft(attestationUpdatesFor(controls, disabled.id)).toEqual([]);
		expect.soft(update.vertices[0]?.signature).toHaveLength(65);
		expect.soft(verifyACLIncomingVertices(update.vertices)).toHaveLength(1);
		expect(disabled.drp?.query_values()).toEqual([11]);
	});

	test("observer mode keeps authenticated convergence but owns no writer-only vertex work", async () => {
		enableObserverControl();
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "3");
		const sourceRuntime = await productNode("phase-1i-observer-source");
		const observerRuntime = await productNode("phase-1i-observer-replica");
		nodes.push(sourceRuntime.node, observerRuntime.node);
		const objectId = `${sourceRuntime.node.networkNode.peerId}:phase-1i-observer-mode`;
		const { constructionsBeforeObserver, observer, source } = await phase1iPair(
			sourceRuntime,
			observerRuntime,
			objectId
		);

		for (const value of [11, 12]) source.drp?.append(value);
		await vi.waitFor(() => expect(updatesFor(sourceRuntime.controls, objectId)).toHaveLength(2));
		const preCheckpointVertices = source.vertices.slice(1);
		for (const { hash } of preCheckpointVertices) {
			const [aclState, drpState] = source.getSerializedStates(hash);
			expect.soft(aclState).toBeDefined();
			expect.soft(drpState).toBeDefined();
		}
		const preCheckpointUpdatesByVertex = new Map(
			updatesFor(sourceRuntime.controls, objectId).map((message) => [
				Update.decode(message.data).vertices[0]?.hash,
				message,
			])
		);
		const preCheckpointUpdates = preCheckpointVertices.map(({ hash }) => {
			const message = preCheckpointUpdatesByVertex.get(hash);
			if (message === undefined) throw new Error(`Expected writer UPDATE for ${hash}`);
			return message;
		});
		const secpRecoveries = vi.spyOn(Signature.prototype, "recoverPublicKey");
		const blsVerifications = vi.spyOn(bls, "verify");
		const observerBlsSigns = vi.spyOn(observerRuntime.node.keychain, "signWithBls");
		for (const update of preCheckpointUpdates) await handleMessage(observerRuntime.node, update);
		const retainedObserverNonCheckpointPairs = preCheckpointVertices.filter(({ hash }) => {
			const [aclState, drpState] = observer.getSerializedStates(hash);
			return aclState !== undefined || drpState !== undefined;
		}).length;
		expect
			.soft(retainedObserverNonCheckpointPairs, "observer retained pre-checkpoint per-vertex snapshot pairs")
			.toBe(0);

		source.drp?.append(13);
		await vi.waitFor(() => expect(updatesFor(sourceRuntime.controls, objectId)).toHaveLength(3));
		const updatesByVertex = new Map(
			updatesFor(sourceRuntime.controls, objectId).map((message) => [
				Update.decode(message.data).vertices[0]?.hash,
				message,
			])
		);
		const writerVertices = source.vertices.slice(1);
		const updates = writerVertices.map(({ hash }) => {
			const message = updatesByVertex.get(hash);
			if (message === undefined) throw new Error(`Expected writer UPDATE for ${hash}`);
			return message;
		});
		const writerAttestations = updates.flatMap(({ data }) => Update.decode(data).attestations);

		expect.soft(writerVertices).toHaveLength(3);
		expect.soft(writerAttestations).toHaveLength(3);
		expect.soft(writerVertices.every(({ signature }) => signature.length === 65)).toBe(true);
		expect.soft(source.finalityStore.states.size).toBe(3);
		const checkpointUpdate = updates[2];
		if (checkpointUpdate === undefined) throw new Error("Expected the checkpoint-boundary UPDATE");
		await handleMessage(observerRuntime.node, checkpointUpdate);

		expect
			.soft(secpRecoveries, "observer ingress must authenticate every novel vertex exactly once")
			.toHaveBeenCalledTimes(3);
		expect.soft(blsVerifications, "observer ingress must not verify legacy attestations").toHaveBeenCalledTimes(0);
		expect.soft(observerBlsSigns, "observer ingress must not generate legacy attestations").toHaveBeenCalledTimes(0);
		expect
			.soft(finalityConstructions.count, "observer lifetime must not initialize the writer finality store")
			.toBe(constructionsBeforeObserver);
		const checkpointHash = writerVertices[2]?.hash;
		if (checkpointHash === undefined) throw new Error("Expected the checkpoint frontier hash");
		const [checkpointACL, checkpointDRP] = observer.getSerializedStates(checkpointHash);
		expect.soft(checkpointACL, "observer checkpoint ACL snapshot remains available").toBeDefined();
		expect.soft(checkpointDRP, "observer checkpoint DRP snapshot remains available").toBeDefined();

		expect.soft(observer.vertices.map(({ hash }) => hash)).toEqual(source.vertices.map(({ hash }) => hash));
		expect.soft(observer.drp?.query_values()).toEqual(source.drp?.query_values());
		expect(
			observerRuntime.controls.broadcastMessage.mock.calls.filter(
				([, message]) => (message as Message).type === MessageType.MESSAGE_TYPE_UPDATE
			)
		).toHaveLength(0);
	});

	test("observer mode still rejects a signature that does not recover to the claimed author", async () => {
		enableObserverControl();
		const sourceRuntime = await productNode("phase-1i-signature-source");
		const observerRuntime = await productNode("phase-1i-signature-observer");
		nodes.push(sourceRuntime.node, observerRuntime.node);
		const objectId = `${sourceRuntime.node.networkNode.peerId}:phase-1i-signature-rejection`;
		const { observer, source } = await phase1iPair(sourceRuntime, observerRuntime, objectId);

		source.drp?.append(21);
		const validUpdate = await latestUpdate(sourceRuntime.controls, objectId, 1);
		const valid = validUpdate.vertices[0];
		if (valid === undefined) throw new Error("Expected the writer positive-control vertex");
		const forged = {
			...valid,
			signature: await observerRuntime.node.keychain.signWithSecp256k1(valid.hash),
		};
		const recoveries = vi.spyOn(Signature.prototype, "recoverPublicKey");
		await handleMessage(observerRuntime.node, {
			sender: sourceRuntime.node.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_UPDATE,
			objectId,
			data: Update.encode(Update.create({ vertices: [forged], attestations: [] })).finish(),
		});

		expect(recoveries).toHaveBeenCalledTimes(1);
		expect(observer.getVertex(valid.hash)).toBeUndefined();
		expect(observer.drp?.query_values()).toEqual([]);
	});

	test("observer finality access throws publicly and never constructs or attaches a store", async () => {
		enableObserverControl();
		const sourceRuntime = await productNode("phase-1i-finality-source");
		const observerRuntime = await productNode("phase-1i-finality-observer");
		nodes.push(sourceRuntime.node, observerRuntime.node);
		const objectId = `${sourceRuntime.node.networkNode.peerId}:phase-1i-finality-boundary`;
		const { constructionsBeforeObserver, observer, source } = await phase1iPair(
			sourceRuntime,
			observerRuntime,
			objectId
		);
		expect(finalityConstructions.count).toBe(constructionsBeforeObserver);

		let accessOutcome: { error: unknown; kind: "threw" } | { kind: "returned"; value: unknown };
		try {
			accessOutcome = { kind: "returned", value: observer.finalityStore };
		} catch (error) {
			accessOutcome = { error, kind: "threw" };
		}
		expect.soft(accessOutcome.kind, "observer finality access must fail explicitly").toBe("threw");
		if (accessOutcome.kind === "threw") {
			expect.soft(accessOutcome.error).toBeInstanceOf(Error);
			expect.soft(String(accessOutcome.error)).toMatch(/observer.*finality|finality.*observer/i);
		}
		expect
			.soft(finalityConstructions.count, "the failed public read must not construct a FinalityStore")
			.toBe(constructionsBeforeObserver);

		source.drp?.append(51);
		const update = await latestUpdate(sourceRuntime.controls, objectId, 1);
		await handleMessage(observerRuntime.node, {
			data: Update.encode(update).finish(),
			objectId,
			sender: sourceRuntime.node.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_UPDATE,
		});
		expect(observer.drp?.query_values()).toEqual([51]);
		expect
			.soft(finalityConstructions.count, "the observer lifetime must remain free of construction or attachment")
			.toBe(constructionsBeforeObserver);
		expect(attestationUpdatesFor(observerRuntime.controls, objectId)).toEqual([]);
	});

	test("authorized observer authorship emits one secp256k1 UPDATE without BLS and rejects unauthorized authorship", async () => {
		enableObserverControl();
		const sourceRuntime = await productNode("phase-1i-authorship-source");
		const observerRuntime = await productNode("phase-1i-authorship-observer");
		nodes.push(sourceRuntime.node, observerRuntime.node);
		const objectId = `${sourceRuntime.node.networkNode.peerId}:phase-1i-authorized-observer`;
		const { observer, source } = await phase1iPair(sourceRuntime, observerRuntime, objectId);
		const secpSigns = vi.spyOn(observerRuntime.node.keychain, "signWithSecp256k1");
		const blsSigns = vi.spyOn(observerRuntime.node.keychain, "signWithBls");

		observer.drp?.append(61);
		const update = await latestUpdate(observerRuntime.controls, objectId, 1);
		expect(update.vertices).toHaveLength(1);
		expect(update.vertices[0]?.signature).toHaveLength(65);
		expect(verifyACLIncomingVertices(update.vertices)).toHaveLength(1);
		expect(update.attestations).toEqual([]);
		expect(secpSigns).toHaveBeenCalledTimes(1);
		expect(blsSigns).toHaveBeenCalledTimes(0);
		expect(attestationUpdatesFor(observerRuntime.controls, objectId)).toEqual([]);

		const authoredMessage = updatesFor(observerRuntime.controls, objectId)[0];
		if (authoredMessage === undefined) throw new Error("Expected the observer-authored UPDATE");
		await handleMessage(sourceRuntime.node, authoredMessage);
		expect(source.drp?.query_values()).toEqual([61]);

		const unauthorizedId = `${sourceRuntime.node.networkNode.peerId}:phase-1i-unauthorized-observer`;
		const unauthorizedOptions = {
			acl: createACL({ admins: [sourceRuntime.node.networkNode.peerId] }),
			drp: new ProductPathDRP(),
			id: unauthorizedId,
			replica_mode: "observer",
		} satisfies Phase1iNodeCreateObjectOptions<ProductPathDRP>;
		const unauthorized = await observerRuntime.node.createObject(unauthorizedOptions);
		expect(() => unauthorized.drp?.append(62)).toThrow(/Not a writer/);
		expect(updatesFor(observerRuntime.controls, unauthorizedId)).toEqual([]);
		expect(unauthorized.vertices).toHaveLength(1);
		expect(unauthorized.drp?.query_values()).toEqual([]);
		expect(secpSigns).toHaveBeenCalledTimes(1);
		expect(blsSigns).toHaveBeenCalledTimes(0);
	});

	test("observer serves complete signed checkpoint and branch history through the real sync handlers", async () => {
		enableObserverControl();
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
		const sourceRuntime = await productNode("phase-1i-sync-source");
		const observerRuntime = await productNode("phase-1i-sync-observer");
		const freshRuntime = await productNode("phase-1i-sync-fresh");
		nodes.push(sourceRuntime.node, observerRuntime.node, freshRuntime.node);
		const objectId = `${sourceRuntime.node.networkNode.peerId}:phase-1i-observer-sync-source`;
		const { observer, source } = await phase1iPair(sourceRuntime, observerRuntime, objectId);
		const sharedACL = sharedRoomACL([sourceRuntime.node, observerRuntime.node]);
		const freshOptions = {
			acl: sharedACL,
			drp: new ProductPathDRP(),
			id: objectId,
			replica_mode: "writer",
		} satisfies Phase1iNodeCreateObjectOptions<ProductPathDRP>;
		const fresh = await freshRuntime.node.createObject(freshOptions);
		const authored = async (value: number, dependencies: string[], timestamp: number): Promise<Vertex> => {
			const vertex = createVertex(
				sourceRuntime.node.networkNode.peerId,
				Operation.create({ drpType: DrpType.DRP, opType: "append", value: [value] }),
				dependencies,
				timestamp
			);
			vertex.signature = await sourceRuntime.node.keychain.signWithSecp256k1(vertex.hash);
			return vertex;
		};
		const first = await authored(71, [HashGraph.rootHash], 1_700_000_003_001);
		const checkpoint = await authored(72, [first.hash], 1_700_000_003_002);
		const left = await authored(73, [checkpoint.hash], 1_700_000_003_003);
		const right = await authored(74, [checkpoint.hash], 1_700_000_003_004);
		const join = await authored(75, [left.hash, right.hash], 1_700_000_003_005);
		const history = [first, checkpoint, left, right, join];
		await expect(source.applyVertices(history)).resolves.toMatchObject({ applied: true, invalid: [], missing: [] });
		await expect(observer.applyVertices(history)).resolves.toMatchObject({ applied: true, invalid: [], missing: [] });

		await handleMessage(observerRuntime.node, {
			data: Sync.encode(Sync.create({ vertexHashes: fresh.vertices.map(({ hash }) => hash) })).finish(),
			objectId,
			sender: freshRuntime.node.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_SYNC,
		});
		expect(observerRuntime.controls.sendMessage).toHaveBeenCalledTimes(1);
		const [, responseMessage] = observerRuntime.controls.sendMessage.mock.calls[0] as [string, Message];
		expect(responseMessage.type).toBe(MessageType.MESSAGE_TYPE_SYNC_ACCEPT);
		const response = SyncAccept.decode(responseMessage.data);
		expect(response.attestations).toEqual([]);
		expect(response.requesting).toEqual([]);
		expect(response.requested.map((vertex) => VertexCodec.encode(vertex).finish())).toEqual(
			observer.vertices.slice(1).map((vertex) => VertexCodec.encode(vertex).finish())
		);
		await handleMessage(freshRuntime.node, responseMessage);
		expect(fresh.vertices.map(({ hash }) => hash)).toEqual(observer.vertices.map(({ hash }) => hash));
		expect(fresh.drp?.query_values()).toEqual(observer.drp?.query_values());
		for (const vertex of history) expect(fresh.getVertex(vertex.hash)).toEqual(vertex);
	});

	test.skipIf(process.env.RUN_PHASE_1I_SCALE !== "true")(
		"freshly built 100k observer retained heap is below 60% of the writer replica",
		async () => {
			const helper = new URL("./helpers/observer-mode-scale.ts", import.meta.url);
			const run = async (
				replicaMode: "observer" | "writer"
			): Promise<{
				artifactProvenance: {
					artifactMtimeMs: number;
					artifactSha256: string;
					objectModulePath: string;
					sourceMaxMtimeMs: number;
					sourceTreeSha256: string;
				};
				digest: string;
				nonRootVertices: number;
				retainedHeapBytes: number;
			}> => {
				const { stdout } = await execFileAsync(
					process.execPath,
					["--expose-gc", "--import", "tsx", helper.pathname, replicaMode, "100000"],
					{ maxBuffer: 1024 * 1024, timeout: 15 * 60 * 1000 }
				);
				const line = stdout
					.trim()
					.split("\n")
					.findLast((candidate) => candidate.startsWith("{"));
				if (line === undefined) throw new Error(`${replicaMode} scale worker emitted no JSON result`);
				return JSON.parse(line) as {
					artifactProvenance: {
						artifactMtimeMs: number;
						artifactSha256: string;
						objectModulePath: string;
						sourceMaxMtimeMs: number;
						sourceTreeSha256: string;
					};
					digest: string;
					nonRootVertices: number;
					retainedHeapBytes: number;
				};
			};

			const writer = await run("writer");
			const observer = await run("observer");
			const ratio = observer.retainedHeapBytes / writer.retainedHeapBytes;
			console.info(JSON.stringify({ gate: "phase-1i-100k-observer-heap", writer, observer, ratio }));
			const expectedObjectModule = new URL("../../object/dist/src/index.js", import.meta.url).pathname;

			expect(writer.nonRootVertices).toBe(100_000);
			expect(observer.nonRootVertices).toBe(100_000);
			expect(observer.digest).toBe(writer.digest);
			expect(writer.artifactProvenance).toEqual(observer.artifactProvenance);
			expect(writer.artifactProvenance.objectModulePath).toBe(expectedObjectModule);
			expect(writer.artifactProvenance.artifactMtimeMs).toBeGreaterThanOrEqual(
				writer.artifactProvenance.sourceMaxMtimeMs
			);
			expect(writer.artifactProvenance.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
			expect(writer.artifactProvenance.sourceTreeSha256).toMatch(/^[0-9a-f]{64}$/);
			expect(writer.retainedHeapBytes).toBeGreaterThan(0);
			expect(observer.retainedHeapBytes).toBeGreaterThan(0);
			expect(ratio).toBeLessThan(0.6);
		},
		35 * 60 * 1000
	);
});
