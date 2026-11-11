/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc -- Test boundary preserves the production owners' inferred signatures. */
import { type Message, MessageType } from "@ts-drp/types";

import { DRPNetworkNode } from "../../../packages/network/src/node.js";
import { NodeEphemeralAdapter } from "../../../packages/node/src/ephemeral.js";
import { NodeRoomNetworkAdapter } from "../../../packages/node/src/room-network.js";
import { routeV3Ingress } from "../../../packages/node/src/v3-live.js";
import {
	ControlledRawBus,
	ControlledRawOwner,
} from "../../../packages/node/tests/fixtures/controlled-unreliable-webrtc.js";
import type { Delivery, Publication } from "../track-x/fence-delivery-room.js";

// Raw bytes are a controlled datagram boundary, NOT real WebRTC. The live room
// supplies all authority, ACLs, sequence filtering, codecs and channel queues.
class ReopenableRawOwner extends ControlledRawOwner {
	override openUnreliableWebRtcRoute(routeId: string) {
		for (const [key, route] of this.opened) if (route.closed) this.opened.delete(key);
		return super.openUnreliableWebRtcRoute(routeId);
	}
}

export async function nativePlayNetwork(delayMs = 20, peers = 2) {
	if (!Number.isSafeInteger(peers) || peers < 2) throw new Error("NATIVE_PLAY_PEER_COUNT");
	const raw = new ControlledRawBus(64);
	const running = Array.from(
		{ length: peers },
		() =>
			new DRPNetworkNode(
				{
					bootstrap_peers: [],
					listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
					log_config: { level: "silent" },
				},
				{ hostPolicy: { bootstrapDiscovery: false, coldStartPubsubDiscovery: false, gossipSubPeerExchange: false } }
			)
	);
	const observers = new Set<(delivery: Delivery) => void>();
	const losses = new Set<(delivery: Delivery) => boolean>();
	const pending = new Set<Promise<void>>();
	const registrations = new Map<
		string,
		{ network: DRPNetworkNode; adapter: NodeRoomNetworkAdapter; ephemeral: NodeEphemeralAdapter }
	>();
	const failures: unknown[] = [];
	// Per-peer custom message queues (a DRPNode's messageQueueManager for MESSAGE_TYPE_CUSTOM): the
	// pages' successor delivery runs on these over the same genuine direct streams.
	const customQueues = new Map<string, Map<string, (message: Message) => void | Promise<void>>>();
	let closing = false;
	const close = async () => {
		closing = true;
		await Promise.allSettled([...pending]);
		const rooms = await Promise.allSettled([...registrations.values()].map(({ adapter }) => adapter.closeAll()));
		for (const { ephemeral } of registrations.values()) {
			try {
				ephemeral.closeAll();
			} catch (cause) {
				failures.push(cause);
			}
		}
		const nodes = await Promise.allSettled(running.map((node) => node.stop()));
		return [
			...failures,
			...[...rooms, ...nodes].flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
		];
	};
	try {
		const starts = await Promise.allSettled(running.map((node) => node.start()));
		const failed = starts.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
		// A full mesh (two peers: the original single connection).
		for (let left = 0; left < running.length; left++)
			for (let right = left + 1; right < running.length; right++) {
				const from = running[left],
					to = running[right];
				if (from === undefined || to === undefined) throw new Error("NATIVE_PLAY_PEERS_MISSING");
				await from.connect(to.getMultiaddrs());
				raw.connect(from.peerId, to.peerId);
			}
		for (const network of running) {
			const ephemeral = new NodeEphemeralAdapter(network, new ReopenableRawOwner(raw, network.peerId));
			const adapter = new NodeRoomNetworkAdapter(network, ephemeral);
			registrations.set(network.peerId, { network, adapter, ephemeral });
			network.subscribeToMessageQueue((message: Message) => {
				if (closing) return;
				const custom =
					message.type === MessageType.MESSAGE_TYPE_CUSTOM
						? customQueues.get(network.peerId)?.get(message.objectId)
						: undefined;
				if (custom !== undefined) {
					const job = Promise.resolve()
						.then(() => custom(message))
						.catch((cause: unknown) => {
							failures.push(cause);
						});
					pending.add(job);
					void job.then(() => pending.delete(job));
					return;
				}
				const delivery: Delivery = {
					kind: network.gossipTopicFor(message) === undefined ? "direct" : "gossip",
					from: message.sender,
					to: network.peerId,
					message,
				};
				for (const observer of observers) observer(delivery);
				if ([...losses].some((lost) => lost(delivery))) return;
				// Preserve the exact Message object carrying genuine one-use ingress evidence.
				const job = new Promise<void>((resolve) =>
					setTimeout(() => {
						try {
							if (!closing && !adapter.route(message)) routeV3Ingress(network, message);
						} catch (cause) {
							failures.push(cause);
						} finally {
							resolve();
						}
					}, delayMs)
				);
				pending.add(job);
				void job.then(() => pending.delete(job));
			});
		}
		return {
			raw,
			peerIds: running.map((node) => node.peerId),
			close,
			node: (peerId: string) => {
				const selected = registrations.get(peerId);
				if (selected === undefined) throw new Error("NATIVE_PLAY_UNKNOWN_PEER");
				return selected;
			},
			observe: (observer: (delivery: Delivery) => void) => {
				observers.add(observer);
				return () => observers.delete(observer);
			},
			lose: (predicate: (delivery: Delivery) => boolean) => {
				losses.add(predicate);
				return () => losses.delete(predicate);
			},
			publications: [] as readonly Publication[],
			/**
			 * The peer's node as the pages' successor delivery uses a DRPNode (examples/v3-room
			 * successor-delivery `V3RoomSuccessorNode`): direct sends on the genuine node, and a custom
			 * message queue fed by its genuine ingress.
			 * @param peerId - The peer.
			 * @returns The node view.
			 */
			successorNode: (peerId: string) => {
				const selected = registrations.get(peerId);
				if (selected === undefined) throw new Error("NATIVE_PLAY_UNKNOWN_PEER");
				let queues = customQueues.get(peerId);
				if (queues === undefined) customQueues.set(peerId, (queues = new Map()));
				const owned = queues;
				return {
					networkNode: selected.network,
					messageQueueManager: {
						subscribe: (queueId: string, handler: (message: Message) => void | Promise<void>) => {
							owned.set(queueId, handler);
						},
						close: (queueId: string) => {
							owned.delete(queueId);
						},
					},
				};
			},
			// Joins observed ingress only; this is not a claim that sockets are quiescent.
			idle: async () => {
				while (pending.size > 0) await Promise.allSettled([...pending]);
			},
		};
	} catch (cause) {
		const cleanup = await close();
		if (cleanup.length > 0) throw new AggregateError([cause, ...cleanup], "native play setup failed");
		throw cause;
	}
}
