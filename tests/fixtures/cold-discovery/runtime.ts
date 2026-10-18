import type { Effects } from "./types.js";
import { MessageQueueManager } from "../../../packages/message-queue/dist/src/index.js";
import type { DRPNetworkNode, Message } from "../../../packages/types/dist/src/index.js";

/**
 * Local transport bindings count effects without replacing any durable owner.
 * @param label
 * @param effects
 */
export function runtime(
	label: string,
	effects?: Effects
): { messageQueueManager: MessageQueueManager<Message>; networkNode: DRPNetworkNode; onAdmittedVertex(): void } {
	const topics = new Set<string>();
	const outgoing = (): Promise<void> => {
		if (effects !== undefined) effects.publications += 1;
		return Promise.resolve();
	};
	const networkNode = {
		peerId: label,
		membershipVerifier: undefined,
		broadcastMessage: outgoing,
		changeTopicScoreParams: () => undefined,
		connect: () => Promise.resolve(),
		connectToBootstraps: () => Promise.resolve(),
		disconnect: () => Promise.resolve(),
		getAllPeers: () => [],
		getBootstrapNodes: () => [],
		getGroupPeers: () => [],
		getMultiaddrs: () => ["/ip4/127.0.0.1/tcp/1"],
		getPeerMultiaddrs: () => Promise.resolve([]),
		getSubscribedTopics: () => [...topics],
		gossipTopicFor: () => undefined,
		isDialable: () => Promise.resolve(true),
		onGroupPeerChange: () => (): undefined => undefined,
		publishMessage: () => {
			if (effects !== undefined) effects.publications += 1;
			return Promise.resolve(true);
		},
		removeTopicScoreParams: () => undefined,
		restart: () => Promise.resolve(),
		sendGroupMessage: outgoing,
		sendMessage: outgoing,
		sendMessageToRandomPeer: outgoing,
		start: () => Promise.resolve(),
		stop: () => Promise.resolve(),
		subscribe: (topic: string) => {
			topics.add(topic);
			if (effects !== undefined) effects.subscriptions += 1;
		},
		subscribeToMessageQueue: () => undefined,
		unsubscribe: (topic: string) => {
			topics.delete(topic);
		},
	} as unknown as DRPNetworkNode;
	return {
		messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
		networkNode,
		onAdmittedVertex: (): undefined => undefined,
	};
}
