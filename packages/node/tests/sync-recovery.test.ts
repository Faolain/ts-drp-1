/**
 * Contract: when SYNC_ACCEPT still leaves dependencies missing, retry SYNC with
 * that same sender at most three times. A fourth incomplete round must send no
 * further SYNC and must emit the existing DRP_SYNC_REJECTED diagnostic event.
 */
import {
	ActionType,
	type IDRP,
	type MergeResult,
	Message,
	MessageType,
	NodeEventName,
	type ResolveConflictsType,
	SemanticsType,
	SyncAccept,
	Update,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMessage, SYNC_RECOVERY_COOLDOWN_MS } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

class CounterDRP implements IDRP {
	semanticsType: SemanticsType = SemanticsType.pair;
	value = 0;

	increment(): void {
		this.value += 1;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

interface OutboxEntry {
	to: string;
	message: Message;
}

function captureDirectMessages(node: DRPNode): OutboxEntry[] {
	const outbox: OutboxEntry[] = [];
	vi.spyOn(node.networkNode, "sendMessage").mockImplementation((to: string, message: Message) => {
		outbox.push({ to, message });
		return Promise.resolve();
	});
	vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
	return outbox;
}

function syncMessages(outbox: OutboxEntry[]): OutboxEntry[] {
	return outbox.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC);
}

async function makeNode(seed: string): Promise<DRPNode> {
	const node = new DRPNode({
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			log_config: { level: "silent" },
		},
		keychain_config: { private_key_seed: seed },
		log_config: { level: "silent" },
	});
	await node.start();
	return node;
}

async function makeIncompleteAccept(sender: DRPNode, objectId: string): Promise<Message> {
	const object = await sender.createObject({ id: objectId, drp: new CounterDRP() });
	object.drp?.increment();
	object.drp?.increment();

	const leaf = object.vertices.at(-1);
	if (!leaf || leaf.dependencies.length === 0) {
		throw new Error("Expected a descendant vertex for the partial SYNC_ACCEPT fixture");
	}

	return Message.create({
		sender: sender.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
		objectId,
		data: SyncAccept.encode(
			SyncAccept.create({
				requested: [leaf],
				attestations: [],
				requesting: [],
			})
		).finish(),
	});
}

function makeEmptyAccept(sender: DRPNode, objectId: string): Message {
	return Message.create({
		sender: sender.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
		objectId,
		data: SyncAccept.encode(SyncAccept.create()).finish(),
	});
}

function makeIncompleteUpdate(incompleteAccept: Message): Message {
	const accept = SyncAccept.decode(incompleteAccept.data);
	return Message.create({
		sender: incompleteAccept.sender,
		type: MessageType.MESSAGE_TYPE_UPDATE,
		objectId: incompleteAccept.objectId,
		data: Update.encode(Update.create({ vertices: accept.requested })).finish(),
	});
}

describe("SYNC_ACCEPT recovery", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("re-requests missing dependencies from the same SYNC_ACCEPT sender", async () => {
		const objectId = "sync-accept-retry-object";
		const receiver = await makeNode("sync-accept-retry-receiver");
		const sender = await makeNode("sync-accept-retry-sender");
		nodes.push(receiver, sender);
		const outbox = captureDirectMessages(receiver);
		captureDirectMessages(sender);
		const receiverObject = await receiver.createObject({ id: objectId, drp: new CounterDRP() });
		const mergeResults: MergeResult[] = [];
		const merge = receiverObject.merge.bind(receiverObject);
		vi.spyOn(receiverObject, "merge").mockImplementation(async (vertices) => {
			const result = await merge(vertices);
			mergeResults.push(result);
			return result;
		});
		const incompleteAccept = await makeIncompleteAccept(sender, objectId);

		await handleMessage(receiver, incompleteAccept);

		expect(mergeResults[0]?.[1].length).toBeGreaterThan(0);
		expect(syncMessages(outbox)).toHaveLength(1);
		expect(syncMessages(outbox)[0].to).toBe(sender.networkNode.peerId);
		expect(syncMessages(outbox)[0].message.objectId).toBe(objectId);
	}, 20_000);

	test("stops after three incomplete rounds and emits DRP_SYNC_REJECTED", async () => {
		const objectId = "sync-accept-bounded-retry-object";
		const receiver = await makeNode("sync-accept-bounded-receiver");
		const sender = await makeNode("sync-accept-bounded-sender");
		nodes.push(receiver, sender);
		const outbox = captureDirectMessages(receiver);
		captureDirectMessages(sender);
		await receiver.createObject({ id: objectId, drp: new CounterDRP() });
		const incompleteAccept = await makeIncompleteAccept(sender, objectId);
		const rejected = vi.fn();
		receiver.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);

		for (let round = 0; round < 4; round++) {
			await handleMessage(receiver, incompleteAccept);
		}

		expect(syncMessages(outbox)).toHaveLength(3);
		expect(syncMessages(outbox).every(({ to }) => to === sender.networkNode.peerId)).toBe(true);
		expect(rejected).toHaveBeenCalledTimes(1);
		expect(rejected.mock.calls[0]?.[0].detail).toEqual({
			id: objectId,
			peerId: sender.networkNode.peerId,
			retries: 3,
		});
	}, 20_000);

	test("opens a fresh recovery episode after the rejection cooldown", async () => {
		const objectId = "sync-accept-cooldown-object";
		const receiver = await makeNode("sync-accept-cooldown-receiver");
		const sender = await makeNode("sync-accept-cooldown-sender");
		nodes.push(receiver, sender);
		const outbox = captureDirectMessages(receiver);
		captureDirectMessages(sender);
		await receiver.createObject({ id: objectId, drp: new CounterDRP() });
		const incompleteAccept = await makeIncompleteAccept(sender, objectId);
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		for (let round = 0; round < 5; round++) await handleMessage(receiver, incompleteAccept);
		expect(syncMessages(outbox)).toHaveLength(3);

		now += SYNC_RECOVERY_COOLDOWN_MS;
		await handleMessage(receiver, incompleteAccept);

		expect(syncMessages(outbox)).toHaveLength(4);
	}, 20_000);

	test("an empty SYNC_ACCEPT neither resets the episode nor emits accepted", async () => {
		const objectId = "sync-accept-empty-object";
		const receiver = await makeNode("sync-accept-empty-receiver");
		const sender = await makeNode("sync-accept-empty-sender");
		nodes.push(receiver, sender);
		const outbox = captureDirectMessages(receiver);
		captureDirectMessages(sender);
		await receiver.createObject({ id: objectId, drp: new CounterDRP() });
		const incompleteAccept = await makeIncompleteAccept(sender, objectId);
		const accepted = vi.fn();
		const rejected = vi.fn();
		receiver.addEventListener(NodeEventName.DRP_SYNC_ACCEPTED, accepted);
		receiver.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);

		await handleMessage(receiver, incompleteAccept);
		await handleMessage(receiver, incompleteAccept);
		await handleMessage(receiver, makeEmptyAccept(sender, objectId));
		await handleMessage(receiver, incompleteAccept);
		await handleMessage(receiver, incompleteAccept);

		expect(syncMessages(outbox)).toHaveLength(3);
		expect(rejected).toHaveBeenCalledTimes(1);
		expect(accepted).not.toHaveBeenCalled();
	}, 20_000);

	test("missing-dependency UPDATEs obey the exhausted episode cooldown", async () => {
		const objectId = "update-recovery-cooldown-object";
		const receiver = await makeNode("update-recovery-receiver");
		const sender = await makeNode("update-recovery-sender");
		nodes.push(receiver, sender);
		const outbox = captureDirectMessages(receiver);
		captureDirectMessages(sender);
		await receiver.createObject({ id: objectId, drp: new CounterDRP() });
		const incompleteAccept = await makeIncompleteAccept(sender, objectId);
		const incompleteUpdate = makeIncompleteUpdate(incompleteAccept);
		let now = 2_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		for (let round = 0; round < 4; round++) await handleMessage(receiver, incompleteAccept);
		for (let update = 0; update < 5; update++) await handleMessage(receiver, incompleteUpdate);

		expect(syncMessages(outbox)).toHaveLength(3);

		now += SYNC_RECOVERY_COOLDOWN_MS;
		await handleMessage(receiver, incompleteUpdate);
		expect(syncMessages(outbox)).toHaveLength(4);
	}, 20_000);

	test("unsubscribeObject clears recovery state for that object", async () => {
		const objectId = "unsubscribe-recovery-object";
		const receiver = await makeNode("unsubscribe-recovery-receiver");
		const sender = await makeNode("unsubscribe-recovery-sender");
		nodes.push(receiver, sender);
		const outbox = captureDirectMessages(receiver);
		captureDirectMessages(sender);
		await receiver.createObject({ id: objectId, drp: new CounterDRP() });
		const incompleteAccept = await makeIncompleteAccept(sender, objectId);

		for (let round = 0; round < 3; round++) await handleMessage(receiver, incompleteAccept);
		receiver.unsubscribeObject(objectId);
		await receiver.createObject({ id: objectId, drp: new CounterDRP() });
		await handleMessage(receiver, incompleteAccept);

		expect(syncMessages(outbox)).toHaveLength(4);
	}, 20_000);
});
