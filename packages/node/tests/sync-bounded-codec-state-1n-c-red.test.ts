/**
 * Phase 1n-c amended RED: fixed sync ceilings and exact-request rotation are
 * owned by production node state/codec seams. Fixtures use creator-generated
 * object IDs; no plain/custom-ID compatibility path is exercised.
 */
import { MessageQueueManager } from "@ts-drp/message-queue";
import { HashGraph } from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	Message,
	MessageType,
	type ResolveConflictsType,
	SemanticsType,
	Sync,
	SyncAccept,
	type Vertex,
} from "@ts-drp/types";
import { Deferred } from "@ts-drp/utils/promise/deferred";
import { afterEach, describe, expect, test } from "vitest";

import { DRPNode } from "../src/index.js";
import { advertisedTheseHeads, prepareSyncSend, queueExactRequests } from "../src/sync-state.js";

const FALLBACK_PROTOCOL = "/drp/message/0.0.1";
const HEADS_CHUNK_PROTOCOL = "/drp/message/1.0.0/heads-chunk";
const REQUEST_HASH_FIELD_CAP = 32;
const OUTSTANDING_EXACT_CAP = 64;
const FALLBACK_HASH_CAP = 512;
const RESPONSE_VERTEX_CAP = 32;
const RESPONSE_BYTE_CAP = 262_144;
const RESPONSE_CHUNK_CAP = 4;

interface BoundedSyncRuntime {
	buildSyncPayloadForProtocol(input: {
		readonly objectId: string;
		readonly peerId: string;
		readonly protocol: typeof FALLBACK_PROTOCOL | typeof HEADS_CHUNK_PROTOCOL;
		readonly purpose: "inbound-reciprocity" | "scheduled-probe";
	}): Promise<Message>;
	buildSyncResponseChunks(input: {
		readonly objectId: string;
		readonly peerId: string;
		readonly request: Message;
	}): Promise<readonly Message[]>;
}

interface NegotiatedSyncNetwork {
	sendSyncMessage(
		peerId: string,
		payloadFactory: (selection: { readonly protocol: string }) => Message | Promise<Message>,
		options?: { readonly signal?: AbortSignal }
	): Promise<void>;
}

class CounterDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	value = 0;

	increment(value = "increment"): void {
		this.value += value.length === 0 ? 0 : 1;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

function makeNode(seed: string): DRPNode {
	return new DRPNode({
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			log_config: { level: "silent" },
		},
		keychain_config: { private_key_seed: seed },
		log_config: { level: "silent" },
	});
}

function bounded(node: DRPNode): BoundedSyncRuntime {
	return node as unknown as BoundedSyncRuntime;
}

function negotiated(node: DRPNode): NegotiatedSyncNetwork {
	return node.networkNode as unknown as NegotiatedSyncNetwork;
}

function exactHash(index: number): string {
	return index.toString(16).padStart(64, "0");
}

function requestMessage(objectId: string, sender: string, sync: Sync): Message {
	return Message.create({
		data: Sync.encode(sync).finish(),
		objectId,
		sender,
		type: MessageType.MESSAGE_TYPE_SYNC,
	});
}

function responseVertices(messages: readonly Message[]): Vertex[][] {
	return messages.map((message) => SyncAccept.decode(message.data).requested);
}

async function expectTypedRejection(promise: Promise<unknown>, code: string): Promise<void> {
	await expect(promise).rejects.toMatchObject({ code });
}

describe("Phase 1n-c bounded sync codec and exact state", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("caps outstanding exact hashes at 64 and rotates deterministic 32-hash chunks in one lifecycle", async () => {
		const owner = makeNode("phase-1n-c-exact-owner");
		const peer = makeNode("phase-1n-c-exact-peer");
		nodes.push(owner, peer);
		await Promise.all(nodes.map((node) => node.start()));
		const object = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		const offered = Array.from({ length: OUTSTANDING_EXACT_CAP + 7 }, (_, index) => exactHash(index + 1));

		expect(queueExactRequests(owner, object.id, peer.networkNode.peerId, offered)).toBe(true);
		const attemptOne = prepareSyncSend(owner, object.id, peer.networkNode.peerId, "scheduled-probe");
		const attemptTwo = prepareSyncSend(owner, object.id, peer.networkNode.peerId, "scheduled-probe");
		const attemptThree = prepareSyncSend(owner, object.id, peer.networkNode.peerId, "scheduled-probe");

		expect(attemptOne.requestedHashes).toEqual(offered.slice(0, REQUEST_HASH_FIELD_CAP));
		expect(attemptTwo.requestedHashes).toEqual(offered.slice(REQUEST_HASH_FIELD_CAP, OUTSTANDING_EXACT_CAP));
		expect(attemptThree.requestedHashes).toEqual(offered.slice(0, REQUEST_HASH_FIELD_CAP));
		expect(new Set([...attemptOne.requestedHashes, ...attemptTwo.requestedHashes]).size).toBe(OUTSTANDING_EXACT_CAP);
		expect([...attemptOne.requestedHashes, ...attemptTwo.requestedHashes, ...attemptThree.requestedHashes]).not.toEqual(
			expect.arrayContaining(offered.slice(OUTSTANDING_EXACT_CAP))
		);
	});

	test("builds one complete compatible fallback and rejects count overflow before advertisement", async () => {
		const owner = makeNode("phase-1n-c-fallback-owner");
		const peer = makeNode("phase-1n-c-fallback-peer");
		const capPeer = makeNode("phase-1n-c-fallback-cap-peer");
		nodes.push(owner, peer, capPeer);
		await Promise.all(nodes.map((node) => node.start()));
		const object = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		for (let index = 0; index < 4; index++) object.drp?.increment();
		const outstanding = exactHash(9_001);
		expect(queueExactRequests(owner, object.id, peer.networkNode.peerId, [outstanding])).toBe(true);

		const boundedPayload = await bounded(owner).buildSyncPayloadForProtocol({
			objectId: object.id,
			peerId: peer.networkNode.peerId,
			protocol: FALLBACK_PROTOCOL,
			purpose: "scheduled-probe",
		});
		const boundedWire = Sync.decode(boundedPayload.data);
		expect(boundedWire.vertexHashes).toEqual(object.historyInventory.knownHashes);
		expect(boundedWire.heads).toEqual([]);
		expect(boundedWire.sharedHeads).toEqual([]);
		expect(boundedWire.requestedHashes).toEqual([]);
		expect(advertisedTheseHeads(owner, object.id, peer.networkNode.peerId, object.getHistoryHeads())).toBe(false);
		expect(prepareSyncSend(owner, object.id, peer.networkNode.peerId, "scheduled-probe")).toMatchObject({
			requestedHashes: [outstanding],
			send: true,
		});
		expect(prepareSyncSend(owner, object.id, peer.networkNode.peerId, "scheduled-probe")).toMatchObject({
			requestedHashes: [outstanding],
			send: true,
		});
		expect(prepareSyncSend(owner, object.id, peer.networkNode.peerId, "scheduled-probe").send).toBe(false);

		for (let index = object.historyInventory.knownHashes.length; index <= FALLBACK_HASH_CAP; index++) {
			object.drp?.increment();
		}
		expect(object.historyInventory.knownHashes.length).toBe(FALLBACK_HASH_CAP + 1);
		const capOutstanding = exactHash(9_002);
		expect(queueExactRequests(owner, object.id, capPeer.networkNode.peerId, [capOutstanding])).toBe(true);
		await expectTypedRejection(
			bounded(owner).buildSyncPayloadForProtocol({
				objectId: object.id,
				peerId: capPeer.networkNode.peerId,
				protocol: FALLBACK_PROTOCOL,
				purpose: "scheduled-probe",
			}),
			"SYNC_FALLBACK_LIMIT"
		);
		for (let attempt = 0; attempt < 3; attempt++) {
			expect(prepareSyncSend(owner, object.id, capPeer.networkNode.peerId, "scheduled-probe")).toMatchObject({
				requestedHashes: [capOutstanding],
				send: true,
			});
		}
		expect(prepareSyncSend(owner, object.id, capPeer.networkNode.peerId, "scheduled-probe").send).toBe(false);
		expect(advertisedTheseHeads(owner, object.id, capPeer.networkNode.peerId, object.getHistoryHeads())).toBe(false);
	});

	test("emits only four deterministic 32-vertex protobuf chunks as a topological progress prefix", async () => {
		const owner = makeNode("phase-1n-c-response-owner");
		const peer = makeNode("phase-1n-c-response-peer");
		nodes.push(owner, peer);
		await Promise.all(nodes.map((node) => node.start()));
		const object = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		for (let index = 0; index < RESPONSE_VERTEX_CAP * RESPONSE_CHUNK_CAP + 1; index++) object.drp?.increment();
		const request = requestMessage(object.id, peer.networkNode.peerId, Sync.create({ heads: [HashGraph.rootHash] }));

		const chunks = await bounded(owner).buildSyncResponseChunks({
			objectId: object.id,
			peerId: peer.networkNode.peerId,
			request,
		});
		const vertices = responseVertices(chunks);
		const expected = object.vertices
			.filter(({ hash }) => hash !== HashGraph.rootHash)
			.slice(0, RESPONSE_VERTEX_CAP * RESPONSE_CHUNK_CAP);
		expect(vertices.map((chunk) => chunk.length)).toEqual(Array(RESPONSE_CHUNK_CAP).fill(RESPONSE_VERTEX_CAP));
		expect(vertices.flat().map(({ hash }) => hash)).toEqual(expected.map(({ hash }) => hash));
		expect(chunks.every((chunk) => Message.encode(chunk).finish().byteLength <= RESPONSE_BYTE_CAP)).toBe(true);
		expect(chunks).toHaveLength(RESPONSE_CHUNK_CAP);
	});

	test("measures the heads request cap from actual protobuf bytes before advertisement or attempt charge", async () => {
		const owner = makeNode("phase-1n-c-request-bytes-owner");
		const peer = makeNode("phase-1n-c-request-bytes-peer");
		nodes.push(owner, peer);
		await Promise.all(nodes.map((node) => node.start()));
		const object = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		const oversized = Array.from({ length: REQUEST_HASH_FIELD_CAP }, (_, index) => `${index}`.padEnd(2_050, "x"));
		expect(Sync.encode(Sync.create({ requestedHashes: oversized })).finish().byteLength).toBeGreaterThan(65_536);
		expect(queueExactRequests(owner, object.id, peer.networkNode.peerId, oversized)).toBe(true);

		await expectTypedRejection(
			bounded(owner).buildSyncPayloadForProtocol({
				objectId: object.id,
				peerId: peer.networkNode.peerId,
				protocol: HEADS_CHUNK_PROTOCOL,
				purpose: "scheduled-probe",
			}),
			"SYNC_REQUEST_LIMIT"
		);
		expect(advertisedTheseHeads(owner, object.id, peer.networkNode.peerId, object.getHistoryHeads())).toBe(false);
		for (let attempt = 0; attempt < 3; attempt++) {
			expect(prepareSyncSend(owner, object.id, peer.networkNode.peerId, "scheduled-probe").send).toBe(true);
		}
		expect(prepareSyncSend(owner, object.id, peer.networkNode.peerId, "scheduled-probe").send).toBe(false);
	});

	test("rejects one oversized response vertex without returning a partial chunk", async () => {
		const owner = makeNode("phase-1n-c-oversized-owner");
		const peer = makeNode("phase-1n-c-oversized-peer");
		nodes.push(owner, peer);
		await Promise.all(nodes.map((node) => node.start()));
		const object = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		object.drp?.increment("x".repeat(RESPONSE_BYTE_CAP + 1));
		const request = requestMessage(object.id, peer.networkNode.peerId, Sync.create({ heads: [HashGraph.rootHash] }));

		await expectTypedRejection(
			bounded(owner).buildSyncResponseChunks({
				objectId: object.id,
				peerId: peer.networkNode.peerId,
				request,
			}),
			"SYNC_RESPONSE_VERTEX_LIMIT"
		);
	});

	test("bounds one real connection at one active plus two queued sends while another object crosses", async () => {
		const sender = makeNode("phase-1n-c-admission-sender");
		const crossingSender = makeNode("phase-1n-c-admission-crossing-sender");
		const receiver = makeNode("phase-1n-c-admission-receiver");
		nodes.push(sender, crossingSender, receiver);
		await Promise.all(nodes.map((node) => node.start()));
		const receiverAddresses = receiver.networkNode.getMultiaddrs();
		if (receiverAddresses === undefined) throw new Error("Expected receiver listen addresses");
		await sender.networkNode.connect(receiverAddresses);
		await crossingSender.networkNode.connect(receiverAddresses);
		const objectA = await receiver.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		const objectB = await receiver.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		receiver.unsubscribeObject(objectA.id);
		receiver.unsubscribeObject(objectB.id);
		receiver.messageQueueManager.closeAll();
		receiver.messageQueueManager = new MessageQueueManager<Message>({
			maxQueueSize: 1,
			logConfig: { level: "silent" },
		});
		const releaseFirst = new Deferred<void>();
		const releaseSecond = new Deferred<void>();
		const objectBCrossed = new Deferred<void>();
		let aAdmissions = 0;
		receiver.messageQueueManager.subscribe(objectA.id, async () => {
			aAdmissions++;
			if (aAdmissions === 1) await releaseFirst.promise;
			if (aAdmissions === 2) await releaseSecond.promise;
		});
		receiver.messageQueueManager.subscribe(objectB.id, () => objectBCrossed.resolve());
		const payload = (objectId: string): Message =>
			Message.create({
				data: Sync.encode(Sync.create({ heads: [HashGraph.rootHash] })).finish(),
				objectId,
				type: MessageType.MESSAGE_TYPE_SYNC,
			});
		const sendA = (): Promise<void> =>
			negotiated(sender).sendSyncMessage(receiver.networkNode.peerId, () => payload(objectA.id));

		try {
			await sendA();
			await sendA();
			const settled: string[] = [];
			const active = sendA().then(
				() => settled.push("active:resolved"),
				(error: { code?: string }) => settled.push(`active:${error.code ?? "rejected"}`)
			);
			const queuedOne = sendA().then(
				() => settled.push("queued-1:resolved"),
				(error: { code?: string }) => settled.push(`queued-1:${error.code ?? "rejected"}`)
			);
			const queuedTwo = sendA().then(
				() => settled.push("queued-2:resolved"),
				(error: { code?: string }) => settled.push(`queued-2:${error.code ?? "rejected"}`)
			);
			await expect(sendA()).rejects.toMatchObject({ code: "SYNC_SEND_QUEUE_FULL" });
			expect(settled).toEqual([]);

			await negotiated(crossingSender).sendSyncMessage(receiver.networkNode.peerId, () => payload(objectB.id));
			await objectBCrossed.promise;
			expect(settled).toEqual([]);

			releaseFirst.resolve();
			await active;
			expect(settled).toEqual(["active:resolved"]);

			await sender.networkNode.disconnect(receiver.networkNode.peerId);
			await Promise.all([queuedOne, queuedTwo]);
			expect(settled).toEqual([
				"active:resolved",
				"queued-1:SYNC_CONNECTION_CLOSED",
				"queued-2:SYNC_CONNECTION_CLOSED",
			]);
		} finally {
			releaseFirst.resolve();
			releaseSecond.resolve();
		}
	});
});
