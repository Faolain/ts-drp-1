/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc -- Test boundary preserves the production owners' inferred signatures. */
import type { Message } from "@ts-drp/types";

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
		if (this.opened.get(routeId)?.closed === true) this.opened.delete(routeId);
		return super.openUnreliableWebRtcRoute(routeId);
	}
}

export async function nativePlayNetwork(delayMs = 20) {
	const raw = new ControlledRawBus();
	const running = Array.from(
		{ length: 2 },
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
		const [left, right] = running;
		if (left === undefined || right === undefined) throw new Error("NATIVE_PLAY_PEERS_MISSING");
		await left.connect(right.getMultiaddrs());
		raw.connect(left.peerId, right.peerId);
		for (const network of running) {
			const ephemeral = new NodeEphemeralAdapter(network, new ReopenableRawOwner(raw, network.peerId));
			const adapter = new NodeRoomNetworkAdapter(network, ephemeral);
			registrations.set(network.peerId, { network, adapter, ephemeral });
			network.subscribeToMessageQueue((message: Message) => {
				if (closing) return;
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
