import { MessageQueueManager } from "@ts-drp/message-queue";
import { type IDRP, type IDRPObject, IntervalRunnerState, Message, MessageType } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DRPNode } from "../../src/index.js";

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

function updateMessage(node: DRPNode, objectId: string): Message {
	return Message.create({
		sender: node.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_UPDATE,
		data: new Uint8Array(),
		objectId,
	});
}

describe("DRPNode lifecycle restoration", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("restart restores object queues, gossip topics, and running per-object intervals", async () => {
		const objectId = "restart-lockup-object";
		const node = makeNode("restart-lockup");
		nodes.push(node);
		await node.start();
		await node.createObject({ id: objectId });

		const objectHandler = vi.fn<(message: Message) => void>();
		const discoveryHandler = vi.fn<(message: Message) => void>();
		node.messageQueueManager.subscribe(objectId, objectHandler);
		node.messageQueueManager.subscribe("discovery", discoveryHandler);

		await node.restart();

		const intervalKeys = [`interval:discovery::${objectId}`, `interval:sync::${objectId}`];
		for (const key of intervalKeys) {
			expect(node["_intervals"].get(key)?.state).toBe(IntervalRunnerState.Running);
		}
		expect(node.networkNode.getSubscribedTopics()).toContain(objectId);

		const message = updateMessage(node, objectId);

		await expect(node.dispatchMessage(message)).resolves.toBeUndefined();
		await vi.waitFor(() => expect(objectHandler).toHaveBeenCalledWith(message));

		const discoveryMessage = Message.create({
			sender: node.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_DRP_DISCOVERY,
			data: new Uint8Array(),
			objectId,
		});

		await expect(node.dispatchMessage(discoveryMessage)).resolves.toBeUndefined();
		await vi.waitFor(() => expect(discoveryHandler).toHaveBeenCalledWith(discoveryMessage));
	}, 30_000);

	test("stop then start restores delivery for a previously subscribed object", async () => {
		const objectId = "stop-start-object";
		const node = makeNode("stop-start-lockup");
		nodes.push(node);
		await node.start();
		await node.createObject({ id: objectId });
		const handler = vi.fn<(message: Message) => void>();
		node.messageQueueManager.subscribe(objectId, handler);

		await node.stop();
		nodes.splice(nodes.indexOf(node), 1);
		await node.start();
		nodes.push(node);
		const message = updateMessage(node, objectId);

		await expect(node.dispatchMessage(message)).resolves.toBeUndefined();
		await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(message));
		expect(node.networkNode.getSubscribedTopics()).toContain(objectId);
	}, 30_000);

	test("create, unsubscribe, and re-subscribe revives object delivery", async () => {
		const objectId = "resubscribe-object";
		const node = makeNode("resubscribe-lockup");
		nodes.push(node);
		await node.start();
		const object = await node.createObject({ id: objectId });
		node.unsubscribeObject(objectId);

		node.subscribeObject(object);
		const handler = vi.fn<(message: Message) => void>();
		node.messageQueueManager.subscribe(objectId, handler);
		const message = updateMessage(node, objectId);

		await expect(node.dispatchMessage(message)).resolves.toBeUndefined();
		await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(message));
	}, 30_000);
});

describe("DRPNode object subscription capacity", () => {
	test("surfaces queue exhaustion before subscribing the object or its gossip topic", () => {
		const node = new DRPNode({ log_config: { level: "silent" } });
		node.messageQueueManager = new MessageQueueManager<Message>({
			maxQueues: 0,
			logConfig: { level: "silent" },
		});
		const objectSubscribe = vi.fn();
		const object = {
			id: "over-capacity-object",
			subscribe: objectSubscribe,
		} as unknown as IDRPObject<IDRP>;
		const gossipSubscribe = vi.spyOn(node.networkNode, "subscribe").mockImplementation(() => undefined);

		try {
			expect(() => node.subscribeObject(object)).toThrow("Max number of queues reached");
			expect(gossipSubscribe).not.toHaveBeenCalled();
			expect(objectSubscribe).not.toHaveBeenCalled();
		} finally {
			node.messageQueueManager.closeAll();
		}
	});

	test("rolls back queue capacity when object.subscribe throws", () => {
		const node = new DRPNode({ log_config: { level: "silent" } });
		node.messageQueueManager = new MessageQueueManager<Message>({
			maxQueues: 1,
			logConfig: { level: "silent" },
		});
		const throwingObject = {
			id: "throwing-object",
			subscribe: vi.fn(() => {
				throw new Error("subscriber install failed");
			}),
		} as unknown as IDRPObject<IDRP>;
		const validObject = {
			id: "valid-object",
			subscribe: vi.fn(),
		} as unknown as IDRPObject<IDRP>;
		vi.spyOn(node.networkNode, "subscribe").mockImplementation(() => undefined);

		try {
			expect(() => node.subscribeObject(throwingObject)).toThrow("subscriber install failed");
			expect(() => node.subscribeObject(validObject)).not.toThrow();
		} finally {
			node.messageQueueManager.closeAll();
		}
	});
});
