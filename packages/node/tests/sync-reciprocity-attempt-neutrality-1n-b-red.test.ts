/**
 * Phase 1n-b corrective RED: inbound heads reciprocity may advertise heads and
 * shared cuts, but it never re-carries or charges an unchanged exact request.
 */
import { BinaryReader } from "@bufbuild/protobuf/wire";
import type { NegotiatedSyncSender } from "@ts-drp/network";
import { createACL, HashGraph } from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	type IDRPObject,
	Message,
	MessageType,
	NodeEventName,
	type ResolveConflictsType,
	SemanticsType,
	Sync,
	SyncAccept,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMessage, signGeneratedVertices } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

interface Outbound {
	message: Message;
	to: string;
}

const outboundByNode = new WeakMap<DRPNode, Outbound[]>();

function syncSender(node: () => DRPNode): NegotiatedSyncSender {
	function outbound(): Outbound[] {
		const capture = outboundByNode.get(node());
		if (capture === undefined) throw new Error("Expected outbound capture");
		return capture;
	}
	return {
		async sendSyncMessage(to, payloadFactory): Promise<void> {
			const message = await payloadFactory({
				mode: "heads-chunk",
				protocol: "/drp/message/1.0.0/heads-chunk",
			});
			outbound().push({ message, to });
		},
		sendSyncResponseMessage(to, message): Promise<void> {
			outbound().push({ message, to });
			return Promise.resolve();
		},
	};
}

interface SyncWire {
	heads: string[];
	requestedHashes: string[];
	sharedHeads: string[];
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
			interval_sync_options: { interval: 60_000 },
			log_config: { level: "silent" },
		},
		{ syncSender: syncSender(() => node) }
	);
	await node.start();
	return node;
}

function captureOutbound(node: DRPNode): Outbound[] {
	const outbound: Outbound[] = [];
	outboundByNode.set(node, outbound);
	vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
	return outbound;
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

function historyHeads(vertices: readonly Vertex[]): string[] {
	const dependedUpon = new Set(vertices.flatMap(({ dependencies }) => dependencies));
	return vertices.filter(({ hash }) => !dependedUpon.has(hash)).map(({ hash }) => hash);
}

function decodeSyncWire(data: Uint8Array): SyncWire {
	const result: SyncWire = { heads: [], requestedHashes: [], sharedHeads: [] };
	const reader = new BinaryReader(data);
	while (reader.pos < reader.len) {
		const tag = reader.uint32();
		const field = tag >>> 3;
		if ((tag & 7) === 2 && field >= 2 && field <= 4) {
			const value = reader.string();
			if (field === 2) result.heads.push(value);
			else if (field === 3) result.sharedHeads.push(value);
			else result.requestedHashes.push(value);
			continue;
		}
		reader.skip(tag & 7);
	}
	return result;
}

function syncMessage(sender: DRPNode, objectId: string, wire: SyncWire): Message {
	const writer = Sync.encode(Sync.create());
	for (const hash of wire.heads) writer.uint32(18).string(hash);
	for (const hash of wire.sharedHeads) writer.uint32(26).string(hash);
	for (const hash of wire.requestedHashes) writer.uint32(34).string(hash);
	return Message.create({
		data: writer.finish(),
		objectId,
		sender: sender.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC,
	});
}

function incompleteAccept(sender: DRPNode, objectId: string, leaf: Vertex): Message {
	return Message.create({
		data: SyncAccept.encode(SyncAccept.create({ requested: [leaf] })).finish(),
		objectId,
		sender: sender.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
	});
}

async function deliver(receiver: DRPNode, message: Message): Promise<void> {
	await handleMessage(receiver, Message.decode(Message.encode(message).finish()));
}

function syncOutbounds(outbound: readonly Outbound[], objectId: string, peerId: string): Outbound[] {
	return outbound.filter(
		({ message, to }) =>
			to === peerId && message.objectId === objectId && message.type === MessageType.MESSAGE_TYPE_SYNC
	);
}

describe("Phase 1n-b inbound reciprocity attempt neutrality", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("repeated no-delta heads reciprocity preserves the scheduled exact-request budget", async () => {
		const sender = await makeNode("phase-1n-b-reciprocity-sender");
		const receiver = await makeNode("phase-1n-b-reciprocity-receiver");
		nodes.push(sender, receiver);
		const outbound = captureOutbound(receiver);
		const {
			id,
			objects: [senderObject, receiverObject],
		} = await makeReplicas([sender, receiver]);

		receiverObject.drp?.increment();
		await signGeneratedVertices(receiver, receiverObject.vertices);
		const localL1 = historyHeads(receiverObject.vertices);
		senderObject.drp?.increment();
		senderObject.drp?.increment();
		await signGeneratedVertices(sender, senderObject.vertices);
		const [parent, leaf] = nonRoot(senderObject.vertices);
		if (parent === undefined || leaf === undefined) throw new Error("Expected signed parent and leaf vertices");

		const rejected = vi.fn();
		receiver.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
		try {
			await deliver(receiver, incompleteAccept(sender, id, leaf));
			const discovery = syncOutbounds(outbound, id, sender.networkNode.peerId);
			expect(discovery).toHaveLength(1);
			expect(decodeSyncWire(discovery[0].message.data)).toMatchObject({
				heads: localL1,
				requestedHashes: [parent.hash],
			});

			receiverObject.drp?.increment();
			await signGeneratedVertices(receiver, receiverObject.vertices);
			const [localL2] = historyHeads(receiverObject.vertices);
			if (localL2 === undefined) throw new Error("Expected an advanced local head");

			const repeated = syncMessage(sender, id, {
				heads: [HashGraph.rootHash],
				requestedHashes: [],
				sharedHeads: [localL2],
			});
			const variant = syncMessage(sender, id, {
				heads: [HashGraph.rootHash],
				requestedHashes: [],
				sharedHeads: [HashGraph.rootHash, localL2],
			});
			const reciprocityStart = outbound.length;
			await deliver(receiver, repeated);
			await deliver(receiver, repeated);
			await deliver(receiver, variant);
			await deliver(receiver, repeated);

			const reciprocal = syncOutbounds(outbound.slice(reciprocityStart), id, sender.networkNode.peerId);
			expect(reciprocal.map(({ message }) => decodeSyncWire(message.data).requestedHashes)).toEqual(
				reciprocal.map(() => [])
			);
			expect(
				outbound.slice(reciprocityStart).some(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT)
			).toBe(false);
			expect(rejected).not.toHaveBeenCalled();

			const scheduledStart = outbound.length;
			await receiver.syncObject(id, sender.networkNode.peerId);
			await receiver.syncObject(id, sender.networkNode.peerId);
			const scheduled = syncOutbounds(outbound.slice(scheduledStart), id, sender.networkNode.peerId);
			expect(scheduled.map(({ message }) => decodeSyncWire(message.data).requestedHashes)).toEqual([
				[parent.hash],
				[parent.hash],
			]);
			expect(rejected).not.toHaveBeenCalled();

			const attemptFourStart = outbound.length;
			await receiver.syncObject(id, sender.networkNode.peerId);
			expect(outbound).toHaveLength(attemptFourStart);
			expect(rejected).toHaveBeenCalledTimes(1);
			expect(rejected.mock.calls[0]?.[0].detail).toEqual({
				id,
				peerId: sender.networkNode.peerId,
				retries: 3,
			});
		} finally {
			receiver.removeEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
		}
	}, 20_000);

	test("a genuinely new unknown head sends attempt one once and identical replay stays neutral", async () => {
		const sender = await makeNode("phase-1n-b-unknown-head-sender");
		const receiver = await makeNode("phase-1n-b-unknown-head-receiver");
		nodes.push(sender, receiver);
		const outbound = captureOutbound(receiver);
		const {
			id,
			objects: [senderObject],
		} = await makeReplicas([sender, receiver]);

		senderObject.drp?.increment();
		await signGeneratedVertices(sender, senderObject.vertices);
		const [unknownHead] = historyHeads(senderObject.vertices);
		if (unknownHead === undefined) throw new Error("Expected a signed unknown head");
		const discovery = syncMessage(sender, id, {
			heads: [unknownHead],
			requestedHashes: [],
			sharedHeads: [HashGraph.rootHash],
		});

		await deliver(receiver, discovery);
		await deliver(receiver, discovery);
		expect(
			syncOutbounds(outbound, id, sender.networkNode.peerId).map(
				({ message }) => decodeSyncWire(message.data).requestedHashes
			)
		).toEqual([[unknownHead]]);
	}, 20_000);
});
