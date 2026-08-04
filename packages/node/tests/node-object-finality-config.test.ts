import { bls } from "@chainsafe/bls/herumi";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { type Address, type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { Signature } from "@noble/secp256k1";
import { createACL } from "@ts-drp/object";
import {
	type DRPNetworkNode,
	type GroupPeerChangeHandler,
	type IACL,
	type IDRP,
	type Message,
	MessageType,
	type NodeConnectObjectOptions,
	type NodeCreateObjectOptions,
	SemanticsType,
	Update,
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
	subscribe: ReturnType<typeof vi.fn>;
}

function createFakeNetwork(): FakeNetworkControls {
	const messageHandlers: Array<(message: Message) => Promise<void>> = [];
	const groupHandlers: GroupPeerChangeHandler[] = [];
	const subscribe = vi.fn();
	const broadcastMessage = vi.fn(() => Promise.resolve());
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
		sendMessage: vi.fn(() => Promise.resolve()),
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
	return { broadcastMessage, networkNode, subscribe };
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

	afterEach(async () => {
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

	test.skipIf(process.env.RUN_PHASE_1I_SCALE !== "true")(
		"100k observer retained heap is below 25% of the writer replica",
		async () => {
			const helper = new URL("./helpers/observer-mode-scale.ts", import.meta.url);
			const run = async (
				replicaMode: "observer" | "writer"
			): Promise<{ digest: string; nonRootVertices: number; retainedHeapBytes: number }> => {
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
					digest: string;
					nonRootVertices: number;
					retainedHeapBytes: number;
				};
			};

			const writer = await run("writer");
			const observer = await run("observer");
			const ratio = observer.retainedHeapBytes / writer.retainedHeapBytes;
			console.info(JSON.stringify({ gate: "phase-1i-100k-observer-heap", writer, observer, ratio }));

			expect(writer.nonRootVertices).toBe(100_000);
			expect(observer.nonRootVertices).toBe(100_000);
			expect(observer.digest).toBe(writer.digest);
			expect(writer.retainedHeapBytes).toBeGreaterThan(0);
			expect(observer.retainedHeapBytes).toBeGreaterThan(0);
			expect(ratio).toBeLessThan(0.25);
		},
		35 * 60 * 1000
	);
});
