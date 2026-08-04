import { type Address, type PeerId } from "@libp2p/interface";
import { MessageQueue, MessageQueueManager } from "@ts-drp/message-queue";
import {
	type DRPNetworkNode,
	type GroupPeerChangeHandler,
	type IMessageQueueHandler,
	Message,
	MessageType,
} from "@ts-drp/types";
import { Deferred } from "@ts-drp/utils/promise/deferred";
import { describe, expect, it, vi } from "vitest";

import { DRPNode } from "../src/index.js";

interface FakeNetworkControls {
	emit(message: Message): Promise<void>;
	networkNode: DRPNetworkNode;
	subscribeToMessageQueue: ReturnType<typeof vi.fn>;
}

function createFakeNetwork(): FakeNetworkControls {
	const central = new MessageQueue<Message>({ id: "network-central", maxSize: 4 });
	let wasClosed = false;
	const subscribeToMessageQueue = vi.fn((handler: IMessageQueueHandler<Message>) => central.subscribe(handler));
	const groupHandlers = new Set<GroupPeerChangeHandler>();
	const networkNode = {
		membershipVerifier: undefined,
		peerId: "",
		start: vi.fn(function (this: DRPNetworkNode): Promise<void> {
			if (wasClosed) central.start();
			wasClosed = false;
			this.peerId = "queue-isolation-peer";
			return Promise.resolve();
		}),
		stop: vi.fn((): Promise<void> => {
			central.close();
			wasClosed = true;
			return Promise.resolve();
		}),
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
		sendMessage: vi.fn(() => Promise.resolve()),
		sendGroupMessageRandomPeer: vi.fn(() => Promise.resolve()),
		subscribeToMessageQueue,
		subscribeToGroupPeerChanges: vi.fn((handler: GroupPeerChangeHandler) => {
			groupHandlers.add(handler);
			return (): void => {
				groupHandlers.delete(handler);
			};
		}),
	} satisfies DRPNetworkNode;
	return { emit: (message) => central.enqueue(message), networkNode, subscribeToMessageQueue };
}

function message(objectId: string, sequence: number): Message {
	return Message.create({
		data: Uint8Array.of(sequence),
		objectId,
		sender: "remote-peer",
		type: MessageType.MESSAGE_TYPE_CUSTOM,
	});
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<false>((resolve) => {
				timeout = setTimeout(() => resolve(false), milliseconds);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

describe("Phase 1h network-to-object queue isolation", () => {
	it("delivers object B while object A's full queue is blocked without weakening A's FIFO serialization", async () => {
		const fake = createFakeNetwork();
		const node = new DRPNode(
			{ keychain_config: { private_key_seed: "phase-1h-isolation" }, log_config: { level: "silent" } },
			{ networkNode: fake.networkNode, reconnect: false }
		);
		await node.start();
		node.messageQueueManager.closeAll();
		node.messageQueueManager = new MessageQueueManager<Message>({
			maxQueueSize: 1,
			logConfig: { level: "silent" },
		});
		const manager = node.messageQueueManager;
		const firstAStarted = new Deferred<void>();
		const releaseA = new Deferred<void>();
		const thirdARouteStarted = new Deferred<void>();
		const bDelivered = new Deferred<void>();
		const routed: string[] = [];
		const aStarted: number[] = [];
		const aFinished: number[] = [];
		const bCalls: number[] = [];
		const unhandled: unknown[] = [];
		let activeAHandlers = 0;
		let maxActiveAHandlers = 0;
		let thirdARouteFinished = false;
		const recordUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		const realEnqueue = manager.enqueue.bind(manager);
		vi.spyOn(manager, "enqueue").mockImplementation(async (queueId, queuedMessage) => {
			const sequence = queuedMessage.data[0];
			routed.push(`${queueId}:${sequence}`);
			if (queueId === "object-a" && sequence === 3) thirdARouteStarted.resolve();
			await realEnqueue(queueId, queuedMessage);
			if (queueId === "object-a" && sequence === 3) thirdARouteFinished = true;
		});

		process.on("unhandledRejection", recordUnhandled);
		manager.subscribe("object-a", async (queuedMessage) => {
			const sequence = queuedMessage.data[0];
			activeAHandlers += 1;
			maxActiveAHandlers = Math.max(maxActiveAHandlers, activeAHandlers);
			aStarted.push(sequence);
			if (sequence === 1) {
				firstAStarted.resolve();
				await releaseA.promise;
			}
			aFinished.push(sequence);
			activeAHandlers -= 1;
		});
		manager.subscribe("object-b", (queuedMessage) => {
			bCalls.push(queuedMessage.data[0]);
			bDelivered.resolve();
		});

		try {
			await fake.emit(message("object-a", 1));
			await firstAStarted.promise;
			await fake.emit(message("object-a", 2));
			await fake.emit(message("object-a", 3));
			await thirdARouteStarted.promise;

			await fake.emit(message("object-b", 1));
			const bArrivedBeforeARelease = await settlesWithin(bDelivered.promise, 50);

			expect.soft(bArrivedBeforeARelease, "object B must cross the central fanout within 50 ms").toBe(true);
			expect.soft(aStarted, "object A remains blocked on its first handler").toEqual([1]);
			expect.soft(aFinished).toEqual([]);
			expect.soft(thirdARouteFinished, "A's third route remains backpressured").toBe(false);

			releaseA.resolve();
			await bDelivered.promise;
			await vi.waitFor(() => expect(aFinished).toEqual([1, 2, 3]));

			expect.soft(aStarted).toEqual([1, 2, 3]);
			expect.soft(maxActiveAHandlers, "object A handlers stay serial").toBe(1);
			expect.soft(thirdARouteFinished).toBe(true);
			expect.soft(bCalls, "object B is delivered exactly once").toEqual([1]);
			expect.soft(routed).toEqual(["object-a:1", "object-a:2", "object-a:3", "object-b:1"]);
			await new Promise(process.nextTick);
			expect.soft(unhandled).toEqual([]);
		} finally {
			releaseA.resolve();
			process.off("unhandledRejection", recordUnhandled);
			await node.stop();
		}
	});

	it("delivers no-pressure traffic once and does not duplicate the central subscription after restart", async () => {
		const fake = createFakeNetwork();
		const node = new DRPNode(
			{ keychain_config: { private_key_seed: "phase-1h-control" }, log_config: { level: "silent" } },
			{ networkNode: fake.networkNode, reconnect: false }
		);
		await node.start();
		const delivered = new Deferred<void>();
		const calls: string[] = [];
		const record = (queuedMessage: Message): void => {
			calls.push(`${queuedMessage.objectId}:${queuedMessage.data[0]}`);
			if (calls.length === 2) delivered.resolve();
		};
		node.messageQueueManager.subscribe("object-a", record);
		node.messageQueueManager.subscribe("object-b", record);

		try {
			await fake.emit(message("object-a", 1));
			await fake.emit(message("object-b", 1));
			await delivered.promise;
			expect(calls).toEqual(["object-a:1", "object-b:1"]);

			await node.restart();
			await fake.emit(message("object-b", 2));
			await vi.waitFor(() => expect(calls).toEqual(["object-a:1", "object-b:1", "object-b:2"]));
			expect(fake.subscribeToMessageQueue).toHaveBeenCalledOnce();
		} finally {
			await node.stop();
		}
	});
});
