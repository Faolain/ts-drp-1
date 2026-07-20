import { createTopicScoreParams } from "@libp2p/gossipsub/score";
import { multiaddr } from "@multiformats/multiaddr";
import { DRP_DISCOVERY_TOPIC, DRP_INTERVAL_DISCOVERY_TOPIC, Message, MessageType } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { type DRPNetworkHostFactory, type DRPNetworkHostFactoryContext, DRPNetworkNode } from "../src/node.js";

const config = {
	bootstrap_peers: [],
	listen_addresses: [] as string[],
	log_config: { level: "silent" as const },
};

const injectedFactory: DRPNetworkHostFactory = (context) =>
	context.createHost({
		services: {
			controlPlaneMarker: () => ({ owner: "injected" }),
		},
	});

describe("DRPNetworkNode host factory", () => {
	const startedNodes: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(
			startedNodes.splice(0).map(async (node) => {
				if (node["_node"]?.status !== "stopped") await node.stop();
			})
		);
	});

	test("builds through the production owner and retains core GossipSub", async () => {
		const hostFactory = vi.fn(injectedFactory);
		const node = new DRPNetworkNode(config, { hostFactory });
		startedNodes.push(node);

		await node.start();

		expect(hostFactory).toHaveBeenCalledOnce();
		expect(node["_node"]?.services.controlPlaneMarker).toEqual({ owner: "injected" });
		expect(node["_node"]?.services.pubsub).toBe(node["_pubsub"]);
		expect(node.getSubscribedTopics()).toEqual(
			expect.arrayContaining([DRP_DISCOVERY_TOPIC, DRP_INTERVAL_DISCOVERY_TOPIC])
		);
	});

	test("preserves production discovery and PX defaults in its immutable snapshot", async () => {
		let observedSnapshot: DRPNetworkHostFactoryContext["snapshot"] | undefined;
		const node = new DRPNetworkNode(config, {
			hostFactory: (context): ReturnType<DRPNetworkHostFactory> => {
				observedSnapshot = context.snapshot;
				return context.createHost();
			},
		});
		startedNodes.push(node);

		await node.start();

		expect(observedSnapshot).toEqual({
			bootstrapDiscovery: true,
			bootstrapPeerCount: 0,
			coldStartPubsubDiscovery: true,
			gossipSubPeerExchange: true,
			outboundAddressPolicy: "allow-all",
			peerDiscoveryModules: ["@libp2p/pubsub-peer-discovery"],
		});
		expect(Object.isFrozen(observedSnapshot)).toBe(true);
		expect(Object.isFrozen(observedSnapshot?.peerDiscoveryModules)).toBe(true);
	});

	test("fails closed with isolated discovery, PX, and the real outbound address gate", async () => {
		let observedSnapshot: DRPNetworkHostFactoryContext["snapshot"] | undefined;
		const denyDialMultiaddr = vi.fn(() => true);
		const node = new DRPNetworkNode(config, {
			hostFactory: (context): ReturnType<DRPNetworkHostFactory> => {
				observedSnapshot = context.snapshot;
				return context.createHost();
			},
			hostPolicy: {
				bootstrapDiscovery: false,
				coldStartPubsubDiscovery: false,
				gossipSubPeerExchange: false,
				denyDialMultiaddr,
			},
		});
		startedNodes.push(node);
		await node.start();

		expect(observedSnapshot).toEqual({
			bootstrapDiscovery: false,
			bootstrapPeerCount: 0,
			coldStartPubsubDiscovery: false,
			gossipSubPeerExchange: false,
			outboundAddressPolicy: "injected",
			peerDiscoveryModules: [],
		});

		const deniedAddress = multiaddr(
			"/ip4/127.0.0.1/tcp/65535/ws/p2p/16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5"
		);
		await expect(node.safeDial(deniedAddress)).rejects.toThrow();
		expect(denyDialMultiaddr).toHaveBeenCalledWith(deniedAddress);
	});

	test("reuses the injected factory across restart", async () => {
		const hostFactory = vi.fn(injectedFactory);
		const node = new DRPNetworkNode(config, { hostFactory });
		startedNodes.push(node);

		await node.start();
		const firstHost = node["_node"];
		await node.restart();

		expect(hostFactory).toHaveBeenCalledTimes(2);
		expect(node["_node"]).not.toBe(firstHost);
		expect(node["_node"]?.services.pubsub).toBe(node["_pubsub"]);
	});

	test("rejects attempts to replace the production data plane", async () => {
		const reservedServiceName: string = "pubsub";
		const replacePubsub: DRPNetworkHostFactory = ({ createHost }: DRPNetworkHostFactoryContext) =>
			createHost({
				services: {
					[reservedServiceName]: () => ({ replacement: true }),
				},
			});
		const node = new DRPNetworkNode(config, { hostFactory: replacePubsub });

		await expect(node.start()).rejects.toThrow('cannot replace reserved service "pubsub"');
		expect(node["_node"]).toBeUndefined();
	});

	test("stops a host when its injected factory fails after building", async () => {
		let builtHost: Awaited<ReturnType<DRPNetworkHostFactoryContext["createHost"]>> | undefined;
		const failAfterBuild: DRPNetworkHostFactory = async ({ createHost }) => {
			builtHost = await createHost();
			throw new Error("control-plane setup failed");
		};
		const node = new DRPNetworkNode(config, { hostFactory: failAfterBuild });

		await expect(node.start()).rejects.toThrow("control-plane setup failed");
		expect(builtHost?.status).toBe("stopped");
		expect(node["_node"]).toBeUndefined();
	});

	test("rejects concurrent host builds and cleans up the in-flight host", async () => {
		let firstBuild: ReturnType<DRPNetworkHostFactoryContext["createHost"]> | undefined;
		const buildTwice: DRPNetworkHostFactory = async ({ createHost }) => {
			firstBuild = createHost();
			const hosts = await Promise.all([firstBuild, createHost()]);
			return hosts[0];
		};
		const node = new DRPNetworkNode(config, { hostFactory: buildTwice });

		await expect(node.start()).rejects.toThrow("may build only one host per start");
		await expect(firstBuild).resolves.toHaveProperty("status", "stopped");
		expect(node["_node"]).toBeUndefined();
	});

	test("preserves the factory error when cleanup also fails", async () => {
		const factoryError = new Error("control-plane setup failed");
		const cleanupError = new Error("host cleanup failed");
		const failWithBrokenCleanup: DRPNetworkHostFactory = async ({ createHost }) => {
			const host = await createHost();
			vi.spyOn(host, "stop").mockRejectedValueOnce(cleanupError);
			throw factoryError;
		};
		const node = new DRPNetworkNode(config, { hostFactory: failWithBrokenCleanup });
		let failure: unknown;

		try {
			await node.start();
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(AggregateError);
		if (!(failure instanceof AggregateError)) throw new Error("Expected AggregateError");
		expect(failure.cause).toBe(factoryError);
		expect(failure.errors).toEqual([factoryError, cleanupError]);
	});
});

interface ConformanceTrace {
	events: string[];
	mode: "default" | "injected";
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function runConformance(mode: ConformanceTrace["mode"]): Promise<ConformanceTrace> {
	const dependencies = mode === "injected" ? { hostFactory: injectedFactory } : undefined;
	const listenConfig = {
		...config,
		listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
	};
	const sender = new DRPNetworkNode(listenConfig, dependencies);
	const receiver = new DRPNetworkNode(listenConfig, dependencies);
	const events: string[] = [];
	const received: string[] = [];
	const topic = "host-factory-conformance";
	let cycle: "initial" | "restart" = "initial";
	const observedGroupCycles = new Set<"initial" | "restart">();

	receiver.subscribeToMessageQueue((message) => {
		received.push(message.objectId);
		events.push(`message:${message.objectId}:${message.type}`);
		return Promise.resolve();
	});
	sender.subscribeToGroupPeerChanges((change) => {
		if (change.topic === topic && change.subscribed && !observedGroupCycles.has(cycle)) {
			observedGroupCycles.add(cycle);
			events.push(`group:joined:${cycle}`);
		}
	});

	const connectAndSubscribe = async (): Promise<void> => {
		await sender.connect(receiver.getMultiaddrs());
		await waitFor(
			() => sender.getAllPeers().includes(receiver.peerId) && receiver.getAllPeers().includes(sender.peerId),
			`${cycle} direct connection`
		);
		events.push(`connection:open:${cycle}`);

		sender.subscribe(topic);
		receiver.subscribe(topic);
		await waitFor(
			() =>
				sender.getGroupPeers(topic).includes(receiver.peerId) && receiver.getGroupPeers(topic).includes(sender.peerId),
			`${cycle} GossipSub topic membership`
		);
		await waitFor(() => observedGroupCycles.has(cycle), `${cycle} group membership notification`);
	};

	try {
		await sender.start();
		await receiver.start();
		events.push("lifecycle:started");

		await connectAndSubscribe();

		const topicScore = createTopicScoreParams({ topicWeight: 0.5 });
		sender.changeTopicScoreParams(topic, topicScore);
		expect(sender["_pubsub"]?.score.params.topics[topic]).toBe(topicScore);
		sender.removeTopicScoreParams(topic);
		expect(sender["_pubsub"]?.score.params.topics[topic]).toBeUndefined();
		events.push("score:changed-removed");

		const directIds = ["direct-0", "direct-1", "direct-2"];
		for (const objectId of directIds) {
			await sender.sendMessage(
				receiver.peerId,
				Message.create({ sender: sender.peerId, objectId, type: MessageType.MESSAGE_TYPE_CUSTOM })
			);
		}
		await waitFor(() => received.length === directIds.length, "ordered direct message dispatch");
		expect(received).toEqual(directIds);
		events.push("send:direct-ordered");

		const broadcastIds = ["broadcast-0", "broadcast-1"];
		for (const objectId of broadcastIds) {
			await sender.broadcastMessage(
				topic,
				Message.create({ sender: sender.peerId, objectId, type: MessageType.MESSAGE_TYPE_UPDATE })
			);
		}
		await waitFor(
			() => received.length === directIds.length + broadcastIds.length,
			"ordered broadcast message dispatch"
		);
		expect(received).toEqual([...directIds, ...broadcastIds]);
		events.push("send:broadcast-ordered");

		const initialSenderHost = sender["_node"];
		const initialReceiverHost = receiver["_node"];
		await sender.stop();
		await receiver.stop();
		expect(initialSenderHost?.status).toBe("stopped");
		expect(initialReceiverHost?.status).toBe("stopped");
		events.push("lifecycle:stopped");

		cycle = "restart";
		await sender.start();
		await receiver.start();
		expect(sender["_node"]).not.toBe(initialSenderHost);
		expect(receiver["_node"]).not.toBe(initialReceiverHost);
		expect(sender["_node"]?.services.pubsub).toBe(sender["_pubsub"]);
		expect(receiver["_node"]?.services.pubsub).toBe(receiver["_pubsub"]);
		events.push("lifecycle:restarted");
		await connectAndSubscribe();

		await sender.sendMessage(
			receiver.peerId,
			Message.create({ sender: sender.peerId, objectId: "post-restart", type: MessageType.MESSAGE_TYPE_CUSTOM })
		);
		await waitFor(() => received.at(-1) === "post-restart", "post-restart queue dispatch");
		expect(received).toEqual([...directIds, ...broadcastIds, "post-restart"]);
		events.push("send:post-restart");

		const finalSenderHost = sender["_node"];
		const finalReceiverHost = receiver["_node"];
		await sender.stop();
		await receiver.stop();
		expect(finalSenderHost?.status).toBe("stopped");
		expect(finalReceiverHost?.status).toBe("stopped");
		events.push("cleanup:complete");
	} finally {
		await Promise.allSettled([sender.stop(), receiver.stop()]);
	}

	return { events, mode };
}

describe("default and injected host conformance", () => {
	test("produce identical production data-plane traces", async () => {
		const defaultTrace = await runConformance("default");
		const injectedTrace = await runConformance("injected");

		expect(injectedTrace.events).toEqual(defaultTrace.events);
	}, 30_000);
});
