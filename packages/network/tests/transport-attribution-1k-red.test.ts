/**
 * Phase 1k corrective RED: resource accounting must use authenticated ingress
 * provenance, never the sender string claimed by the application envelope.
 */
import { type GossipSub, type GossipsubMessage } from "@libp2p/gossipsub";
import { type DRPNetworkNodeConfig, Message, MessageType } from "@ts-drp/types";
import { afterEach, describe, expect, test } from "vitest";

import { DRPNetworkNode } from "../src/node.js";

const config: DRPNetworkNodeConfig = {
	bootstrap_peers: [],
	listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
	log_config: { level: "silent" },
};

function makeNode(): DRPNetworkNode {
	return new DRPNetworkNode(config, {
		hostPolicy: {
			bootstrapDiscovery: false,
			coldStartPubsubDiscovery: false,
			gossipSubPeerExchange: false,
		},
	});
}

function appMessage(sender: string, objectId: string): Message {
	return Message.create({
		data: new TextEncoder().encode(objectId),
		objectId,
		sender,
		type: MessageType.MESSAGE_TYPE_CUSTOM,
	});
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

describe("Phase 1k authenticated transport attribution", () => {
	const running: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(running.splice(0).map((node) => node.stop()));
	});

	test("direct protocol ingress replaces a spoofed envelope sender with connection.remotePeer", async () => {
		const sender = makeNode();
		const receiver = makeNode();
		const victim = makeNode();
		running.push(sender, receiver, victim);
		await Promise.all(running.map((node) => node.start()));
		await sender.connect(receiver.getMultiaddrs());

		const received: Message[] = [];
		receiver.subscribeToMessageQueue((message) => {
			received.push(message);
		});

		await sender.sendMessage(receiver.peerId, appMessage(victim.peerId, "phase-1k-direct-spoof"));
		await waitFor(() => received.length === 1, "the spoofed direct message");
		await sender.sendMessage(receiver.peerId, appMessage(sender.peerId, "phase-1k-direct-honest"));
		await waitFor(() => received.length === 2, "the honest direct message");

		expect(received.map(({ objectId, sender: attributedSender }) => [objectId, attributedSender])).toEqual([
			["phase-1k-direct-spoof", sender.peerId],
			["phase-1k-direct-honest", sender.peerId],
		]);
	});

	test("signed gossipsub ingress attributes the original publisher rather than a claimed victim", async () => {
		const publisher = makeNode();
		const receiver = makeNode();
		const victim = makeNode();
		running.push(publisher, receiver, victim);
		await Promise.all(running.map((node) => node.start()));
		await publisher.connect(receiver.getMultiaddrs());

		const topic = "phase-1k-transport-attribution";
		publisher.subscribe(topic);
		receiver.subscribe(topic);
		await waitFor(
			() => publisher.getGroupPeers(topic).includes(receiver.peerId),
			"the signed publisher-receiver topic path"
		);

		const received: Message[] = [];
		receiver.subscribeToMessageQueue((message) => {
			received.push(message);
		});
		const receiverPubsub = receiver["_pubsub"] as GossipSub;
		const ingress: GossipsubMessage[] = [];
		receiverPubsub.addEventListener("gossipsub:message", (event) => {
			if (event.detail.msg.topic === topic) ingress.push(event.detail);
		});

		await publisher.broadcastMessage(topic, appMessage(victim.peerId, "phase-1k-gossipsub-spoof"));
		await waitFor(() => received.length === 1 && ingress.length === 1, "the spoofed signed gossipsub message");
		await publisher.broadcastMessage(topic, appMessage(publisher.peerId, "phase-1k-gossipsub-honest"));
		await waitFor(() => received.length === 2 && ingress.length === 2, "the honest signed gossipsub message");

		for (const event of ingress) {
			expect(event.msg.type).toBe("signed");
			if (event.msg.type !== "signed") throw new Error("StrictSign gossipsub delivered an unsigned message");
			expect(event.msg.from.toString()).toBe(publisher.peerId);
			expect(event.propagationSource.toString()).toBe(publisher.peerId);
		}
		expect(received.map(({ objectId, sender: attributedSender }) => [objectId, attributedSender])).toEqual([
			["phase-1k-gossipsub-spoof", publisher.peerId],
			["phase-1k-gossipsub-honest", publisher.peerId],
		]);
	}, 20_000);
});
