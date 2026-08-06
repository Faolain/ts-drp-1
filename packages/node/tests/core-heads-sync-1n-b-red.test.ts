/**
 * Phase 1n-b RED: default anti-entropy exchanges causal heads and remembers a
 * per-peer shared cut. Full hash inventories remain an explicit fallback, not
 * the default probe. True missing dependencies are requested by hash and
 * duplicate/out-of-order deliveries do not amplify recovery.
 */
import { BinaryReader } from "@bufbuild/protobuf/wire";
import { DRP_HEADS_CHUNK_PROTOCOL, type NegotiatedSyncSender, type SelectedSyncProtocol } from "@ts-drp/network";
import { createACL, HashGraph } from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	type IDRPObject,
	Message,
	MessageType,
	type ResolveConflictsType,
	SemanticsType,
	Sync,
	SyncAccept,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMessage, signGeneratedVertices } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

interface SyncWire {
	fallbackHashes: string[];
	heads: string[];
	requestedHashes: string[];
	sharedHeads: string[];
}

interface Outbound {
	message: Message;
	to: string;
}

const HEADS_SELECTION = Object.freeze({
	mode: "heads-chunk",
	protocol: DRP_HEADS_CHUNK_PROTOCOL,
} satisfies SelectedSyncProtocol);

const outboundByNode = new WeakMap<DRPNode, Outbound[]>();

function syncSender(node: () => DRPNode): NegotiatedSyncSender {
	function outbound(): Outbound[] {
		const capture = outboundByNode.get(node());
		if (capture === undefined) throw new Error("Expected outbound capture");
		return capture;
	}
	return {
		async sendSyncMessage(to, payloadFactory): Promise<void> {
			const message = await payloadFactory(HEADS_SELECTION);
			outbound().push({ message, to });
		},
		sendSyncResponseMessage(to, message): Promise<void> {
			outbound().push({ message, to });
			return Promise.resolve();
		},
	};
}

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

async function makeNode(seed: string): Promise<DRPNode> {
	const node: DRPNode = new DRPNode(
		{
			network_config: {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
			},
			keychain_config: { private_key_seed: seed },
			log_config: { level: "silent" },
		},
		{ syncSender: syncSender(() => node) }
	);
	await node.start();
	return node;
}

function captureOutbound(node: DRPNode, outbound: Outbound[]): void {
	outboundByNode.set(node, outbound);
	vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
}

function coordinatedACL(nodes: readonly DRPNode[]): ReturnType<typeof createACL> {
	const acl = createACL({ admins: nodes.map(({ networkNode }) => networkNode.peerId) });
	for (const node of nodes) {
		acl.context = { caller: node.networkNode.peerId };
		acl.setKey(node.keychain.blsPublicKey);
	}
	acl.context = { caller: "" };
	return acl;
}

async function makeReplicas(nodes: readonly DRPNode[]): Promise<{ id: string; objects: IDRPObject<CounterDRP>[] }> {
	const creator = await nodes[0].createObject({ acl: coordinatedACL(nodes), drp: new CounterDRP() });
	const objects: IDRPObject<CounterDRP>[] = [creator];
	for (const node of nodes.slice(1)) {
		objects.push(
			await node.createObject({
				acl: coordinatedACL(nodes),
				drp: new CounterDRP(),
				id: creator.id,
			})
		);
	}
	return { id: creator.id, objects };
}

function nonRoot(vertices: readonly Vertex[]): Vertex[] {
	return vertices.filter(({ hash }) => hash !== HashGraph.rootHash);
}

function heads(vertices: readonly Vertex[]): string[] {
	const dependedUpon = new Set(vertices.flatMap(({ dependencies }) => dependencies));
	return vertices.filter(({ hash }) => !dependedUpon.has(hash)).map(({ hash }) => hash);
}

function decodeSyncWire(data: Uint8Array): SyncWire {
	const result: SyncWire = { fallbackHashes: [], heads: [], requestedHashes: [], sharedHeads: [] };
	const reader = new BinaryReader(data);
	while (reader.pos < reader.len) {
		const tag = reader.uint32();
		const field = tag >>> 3;
		if ((tag & 7) === 2 && field >= 1 && field <= 4) {
			const value = reader.string();
			if (field === 1) result.fallbackHashes.push(value);
			else if (field === 2) result.heads.push(value);
			else if (field === 3) result.sharedHeads.push(value);
			else result.requestedHashes.push(value);
			continue;
		}
		reader.skip(tag & 7);
	}
	return result;
}

function headsSyncMessage(sender: DRPNode, objectId: string, input: Partial<SyncWire> = {}): Message {
	const writer = Sync.encode(Sync.create({ vertexHashes: input.fallbackHashes ?? [] }));
	for (const hash of input.heads ?? []) writer.uint32(18).string(hash);
	for (const hash of input.sharedHeads ?? []) writer.uint32(26).string(hash);
	for (const hash of input.requestedHashes ?? []) writer.uint32(34).string(hash);
	return Message.create({
		data: writer.finish(),
		objectId,
		sender: sender.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC,
	});
}

function accept(sender: DRPNode, objectId: string, requested: readonly Vertex[]): Message {
	return Message.create({
		data: SyncAccept.encode(SyncAccept.create({ requested: [...requested] })).finish(),
		objectId,
		sender: sender.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
	});
}

function takeDirect(outbound: Outbound[], type: MessageType): Outbound {
	const index = outbound.findIndex(({ message }) => message.type === type);
	if (index < 0) throw new Error(`Expected outbound message type ${type}`);
	const [entry] = outbound.splice(index, 1);
	return entry;
}

async function deliverAll(outbound: Outbound[], nodes: readonly DRPNode[], limit = 32): Promise<void> {
	const byPeer = new Map(nodes.map((node) => [node.networkNode.peerId, node]));
	let delivered = 0;
	while (outbound.length !== 0) {
		if (delivered++ >= limit) throw new Error(`Message delivery exceeded ${limit} steps`);
		const entry = outbound.shift();
		if (!entry) break;
		const recipient = byPeer.get(entry.to);
		if (!recipient) throw new Error(`Unknown recipient ${entry.to}`);
		await handleMessage(recipient, Message.decode(Message.encode(entry.message).finish()), HEADS_SELECTION);
	}
}

describe("Phase 1n-b core heads synchronization", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("uses heads and a remembered shared cut so probe and response cost follow the delta", async () => {
		const ahead = await makeNode("phase-1n-b-delta-ahead");
		const behind = await makeNode("phase-1n-b-delta-behind");
		nodes.push(ahead, behind);
		const outbound: Outbound[] = [];
		captureOutbound(ahead, outbound);
		captureOutbound(behind, outbound);
		const {
			id,
			objects: [aheadObject, behindObject],
		} = await makeReplicas([ahead, behind]);

		for (let index = 0; index < 32; index++) aheadObject.drp?.increment();
		await signGeneratedVertices(ahead, aheadObject.vertices);
		await expect(behindObject.merge(nonRoot(aheadObject.vertices))).resolves.toEqual([true, [], []]);

		// Sending a head is not proof that the remote possesses it. The first
		// equal-head probe must therefore leave that head unshared until reciprocal
		// wire evidence arrives.
		await behind.syncObject(id, ahead.networkNode.peerId);
		const sharedCut = heads(behindObject.vertices);
		const establishingProbe = takeDirect(outbound, MessageType.MESSAGE_TYPE_SYNC);
		expect(decodeSyncWire(establishingProbe.message.data).sharedHeads).not.toEqual(expect.arrayContaining(sharedCut));
		// Drop that probe after send completion, then try again. A send-only ledger
		// would now falsely advertise the unacknowledged head as shared.
		await behind.syncObject(id, ahead.networkNode.peerId);
		const unacknowledgedRetry = takeDirect(outbound, MessageType.MESSAGE_TYPE_SYNC);
		expect(decodeSyncWire(unacknowledgedRetry.message.data).sharedHeads).not.toEqual(expect.arrayContaining(sharedCut));
		await handleMessage(ahead, Message.decode(Message.encode(unacknowledgedRetry.message).finish()), HEADS_SELECTION);
		const reciprocalProof = takeDirect(outbound, MessageType.MESSAGE_TYPE_SYNC);
		expect(decodeSyncWire(reciprocalProof.message.data)).toMatchObject({
			fallbackHashes: [],
			heads: sharedCut,
		});
		await handleMessage(behind, Message.decode(Message.encode(reciprocalProof.message).finish()), HEADS_SELECTION);
		expect(outbound).toHaveLength(0);

		aheadObject.drp?.increment();
		aheadObject.drp?.increment();
		await signGeneratedVertices(ahead, aheadObject.vertices);
		const expectedDelta = nonRoot(aheadObject.vertices).slice(nonRoot(behindObject.vertices).length);
		let behindInventoryReads = 0;
		const behindInventoryGetter = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(behindObject),
			"historyInventory"
		)?.get;
		if (!behindInventoryGetter) throw new Error("Expected real historyInventory getter");
		Object.defineProperty(behindObject, "historyInventory", {
			configurable: true,
			get: () => {
				behindInventoryReads++;
				return behindInventoryGetter.call(behindObject);
			},
		});
		await behind.syncObject(id, ahead.networkNode.peerId);
		const probe = takeDirect(outbound, MessageType.MESSAGE_TYPE_SYNC);
		const probeWire = decodeSyncWire(probe.message.data);

		expect.soft(probeWire.fallbackHashes).toEqual([]);
		expect.soft(probeWire.heads).toEqual(heads(behindObject.vertices));
		expect.soft(probeWire.sharedHeads).toEqual(expect.arrayContaining(sharedCut));
		expect.soft(probe.message.data.byteLength).toBeLessThan(512);
		expect.soft(behindInventoryReads).toBe(0);

		let aheadVertexMaterializations = 0;
		const aheadVerticesGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(aheadObject), "vertices")?.get;
		if (!aheadVerticesGetter) throw new Error("Expected real vertices getter");
		Object.defineProperty(aheadObject, "vertices", {
			configurable: true,
			get: () => {
				aheadVertexMaterializations++;
				return aheadVerticesGetter.call(aheadObject);
			},
		});
		await handleMessage(ahead, Message.decode(Message.encode(probe.message).finish()), HEADS_SELECTION);
		expect.soft(aheadVertexMaterializations).toBe(0);
		const response = takeDirect(outbound, MessageType.MESSAGE_TYPE_SYNC_ACCEPT);
		const responsePayload = SyncAccept.decode(response.message.data);
		expect(responsePayload.requested.map(({ hash }) => hash)).toEqual(expectedDelta.map(({ hash }) => hash));
		expect(responsePayload.requesting).toEqual([]);

		await handleMessage(behind, Message.decode(Message.encode(response.message).finish()), HEADS_SELECTION);
		expect(behindObject.drp?.value).toBe(aheadObject.drp?.value);
		expect(new Set(behindObject.vertices.map(({ hash }) => hash))).toEqual(
			new Set(aheadObject.vertices.map(({ hash }) => hash))
		);
	}, 20_000);

	test("recurses only through true missing dependencies and deduplicates leaf-first reoffers", async () => {
		const sender = await makeNode("phase-1n-b-recursive-sender");
		const receiver = await makeNode("phase-1n-b-recursive-receiver");
		nodes.push(sender, receiver);
		const outbound: Outbound[] = [];
		captureOutbound(sender, outbound);
		captureOutbound(receiver, outbound);
		const {
			id,
			objects: [senderObject, receiverObject],
		} = await makeReplicas([sender, receiver]);

		for (let index = 0; index < 3; index++) senderObject.drp?.increment();
		await signGeneratedVertices(sender, senderObject.vertices);
		const [ancestor, parent, leaf] = nonRoot(senderObject.vertices);

		await handleMessage(receiver, accept(sender, id, [leaf]));
		const firstRequest = takeDirect(outbound, MessageType.MESSAGE_TYPE_SYNC);
		expect(decodeSyncWire(firstRequest.message.data)).toMatchObject({
			fallbackHashes: [],
			requestedHashes: [parent.hash],
		});

		await handleMessage(receiver, accept(sender, id, [leaf]));
		expect(outbound.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(0);

		await handleMessage(receiver, accept(sender, id, [parent]));
		const secondRequest = takeDirect(outbound, MessageType.MESSAGE_TYPE_SYNC);
		expect(decodeSyncWire(secondRequest.message.data)).toMatchObject({
			fallbackHashes: [],
			requestedHashes: [ancestor.hash],
		});

		await handleMessage(receiver, accept(sender, id, [parent]));
		expect(outbound.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(0);

		await handleMessage(receiver, accept(sender, id, [ancestor]));
		await handleMessage(receiver, accept(sender, id, [leaf, parent]));
		await handleMessage(receiver, accept(sender, id, [parent, leaf]));

		expect(receiverObject.drp?.value).toBe(senderObject.drp?.value);
		expect(new Set(receiverObject.vertices.map(({ hash }) => hash))).toEqual(
			new Set(senderObject.vertices.map(({ hash }) => hash))
		);
		expect(outbound.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(0);
	}, 20_000);

	test("advancing shared heads does not forget a later old-branch injection", async () => {
		const left = await makeNode("phase-1n-b-old-branch-left");
		const right = await makeNode("phase-1n-b-old-branch-right");
		const oldBranch = await makeNode("phase-1n-b-old-branch-author");
		nodes.push(left, right, oldBranch);
		const outbound: Outbound[] = [];
		for (const node of nodes) captureOutbound(node, outbound);
		const {
			id,
			objects: [leftObject, rightObject, oldBranchObject],
		} = await makeReplicas(nodes);

		for (let index = 0; index < 4; index++) leftObject.drp?.increment();
		await signGeneratedVertices(left, leftObject.vertices);
		const commonHistory = nonRoot(leftObject.vertices);
		await expect(rightObject.merge(commonHistory)).resolves.toEqual([true, [], []]);
		await expect(oldBranchObject.merge(commonHistory)).resolves.toEqual([true, [], []]);
		const oldSharedCut = heads(leftObject.vertices);

		leftObject.drp?.increment();
		rightObject.drp?.increment();
		await signGeneratedVertices(left, leftObject.vertices);
		await signGeneratedVertices(right, rightObject.vertices);
		await left.syncObject(id, right.networkNode.peerId);
		await deliverAll(outbound, nodes);
		expect(new Set(leftObject.vertices.map(({ hash }) => hash))).toEqual(
			new Set(rightObject.vertices.map(({ hash }) => hash))
		);

		oldBranchObject.drp?.increment();
		await signGeneratedVertices(oldBranch, oldBranchObject.vertices);
		const injected = oldBranchObject.vertices.at(-1);
		if (!injected) throw new Error("Expected old-branch vertex");
		await expect(rightObject.merge([injected])).resolves.toEqual([true, [], []]);

		await left.syncObject(id, right.networkNode.peerId);
		const probe = takeDirect(outbound, MessageType.MESSAGE_TYPE_SYNC);
		const probeWire = decodeSyncWire(probe.message.data);
		expect.soft(probeWire.fallbackHashes).toEqual([]);
		expect.soft(probeWire.sharedHeads).toEqual(expect.arrayContaining(oldSharedCut));
		await handleMessage(right, Message.decode(Message.encode(probe.message).finish()), HEADS_SELECTION);

		const response = takeDirect(outbound, MessageType.MESSAGE_TYPE_SYNC_ACCEPT);
		expect(SyncAccept.decode(response.message.data).requested.map(({ hash }) => hash)).toEqual([injected.hash]);
		await handleMessage(left, Message.decode(Message.encode(response.message).finish()), HEADS_SELECTION);
		expect(leftObject.getVertex(injected.hash)).toBeDefined();
		expect(new Set(leftObject.vertices.map(({ hash }) => hash))).toEqual(
			new Set(rightObject.vertices.map(({ hash }) => hash))
		);
	}, 20_000);

	test("retains field-1 full hash inventory as the mandatory fallback", async () => {
		const ahead = await makeNode("phase-1n-b-fallback-ahead");
		const behind = await makeNode("phase-1n-b-fallback-behind");
		nodes.push(ahead, behind);
		const outbound: Outbound[] = [];
		captureOutbound(ahead, outbound);
		captureOutbound(behind, outbound);
		const {
			id,
			objects: [aheadObject, behindObject],
		} = await makeReplicas([ahead, behind]);

		for (let index = 0; index < 4; index++) aheadObject.drp?.increment();
		await signGeneratedVertices(ahead, aheadObject.vertices);
		await expect(behindObject.merge(nonRoot(aheadObject.vertices).slice(0, 2))).resolves.toEqual([true, [], []]);

		const fallback = headsSyncMessage(behind, id, {
			fallbackHashes: [...behindObject.historyInventory.knownHashes],
		});
		await handleMessage(ahead, Message.decode(Message.encode(fallback).finish()));
		const response = takeDirect(outbound, MessageType.MESSAGE_TYPE_SYNC_ACCEPT);
		const missing = aheadObject.vertices.slice(behindObject.vertices.length).map(({ hash }) => hash);
		expect(SyncAccept.decode(response.message.data).requested.map(({ hash }) => hash)).toEqual(missing);
	}, 20_000);
});
