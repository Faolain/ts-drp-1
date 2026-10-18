import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";
import {
	createEphemeralChannel,
	type EphemeralChannel,
	type EphemeralChannelOptions,
	type EphemeralIngress,
	type EphemeralTransportPort,
	inspectEphemeralDeliveryClass,
} from "@ts-drp/ephemeral";
import {
	DRP_MESSAGE_PROTOCOL,
	type DRPUnreliableWebRtcOwner,
	type DRPUnreliableWebRtcRoute,
	type DRPUnreliableWebRtcSnapshot,
} from "@ts-drp/network";
import { type DRPNetworkNode, Message, MessageType } from "@ts-drp/types";

const EPHEMERAL_TOPIC_DOMAIN = new TextEncoder().encode("ts-drp-ephemeral-topic-v1\u0000");
const EPHEMERAL_TRANSPORT_MAX_BYTES = 65_536;

interface ObjectRegistration {
	readonly channel: EphemeralChannel;
	readonly options: EphemeralChannelOptions;
	readonly rawRoute: DRPUnreliableWebRtcRoute | undefined;
	reconcileRaw(): void;
}

interface TopicRegistration {
	listener: ((ingress: EphemeralIngress) => void) | undefined;
}

/** Live v3 authorization projected from accepted durable room history. */
export interface EphemeralAuthorizationProvider {
	authorForPeer(peerId: string): string | undefined;
	currentAuthority():
		| Readonly<{
				readonly aclDigest: string;
				readonly anchorDigest: string;
				readonly epoch: number;
				readonly objectId: string;
		  }>
		| undefined;
	isCurrentWriter(author: string): boolean;
}

/** Owns the private network boundary behind DRPNode.openEphemeral. */
export class NodeEphemeralAdapter {
	readonly #byObject = new Map<string, ObjectRegistration>();
	readonly #byTopic = new Map<string, TopicRegistration>();
	readonly #networkNode: DRPNetworkNode;
	readonly #unreliableWebRtcOwner: DRPUnreliableWebRtcOwner | null;

	/**
	 * Create one adapter for one node instance.
	 * @param networkNode Exact signed network boundary.
	 * @param unreliableWebRtcOwner Narrow raw owner available only on the default network implementation.
	 */
	constructor(networkNode: DRPNetworkNode, unreliableWebRtcOwner: DRPUnreliableWebRtcOwner | null) {
		this.#networkNode = networkNode;
		this.#unreliableWebRtcOwner = unreliableWebRtcOwner;
	}

	/** Close every active channel before node shutdown. */
	closeAll(): void {
		let failure: unknown;
		for (const { channel } of [...this.#byObject.values()]) {
			try {
				channel.close();
			} catch (error) {
				failure ??= error;
			}
		}
		try {
			this.#unreliableWebRtcOwner?.close();
		} catch (error) {
			failure ??= error;
		}
		if (failure !== undefined) throw failure;
	}

	/**
	 * Close the channel whose durable object is leaving this node.
	 * @param objectId Durable object identity.
	 */
	close(objectId: string): void {
		this.#byObject.get(objectId)?.channel.close();
	}

	/**
	 * Read detached raw WebRTC evidence for one active authorized object.
	 * @param objectId Durable v3 room identity.
	 * @returns Current raw owner snapshot, or undefined outside an active v3 route.
	 */
	unreliableWebRtcSnapshot(objectId: string): DRPUnreliableWebRtcSnapshot | undefined {
		return this.#byObject.get(objectId)?.rawRoute?.snapshot();
	}

	/**
	 * Open one channel from an authenticated peer-to-author roster and current writer projection.
	 * @param objectId Durable v3 room identity.
	 * @param provider Live authorization projected from accepted durable vertices.
	 * @param options Closed channel limits.
	 * @returns The existing identically-configured channel or a newly activated one.
	 */
	openAuthorized(
		objectId: string,
		provider: EphemeralAuthorizationProvider,
		options: EphemeralChannelOptions
	): EphemeralChannel {
		if (Object.keys(options).sort().join(",") !== "maxMessageBytes,maxSequencedKeys,maxSequencedSenders") {
			throw new TypeError("ephemeral channel options differ");
		}
		const existing = this.#byObject.get(objectId);
		if (existing !== undefined) {
			if (
				existing.options.maxMessageBytes !== options.maxMessageBytes ||
				existing.options.maxSequencedKeys !== options.maxSequencedKeys ||
				existing.options.maxSequencedSenders !== options.maxSequencedSenders
			) {
				throw new Error("ephemeral channel options differ from the active object channel");
			}
			existing.reconcileRaw();
			return existing.channel;
		}
		const topic = ephemeralTopicFor(objectId);
		const registration: TopicRegistration = { listener: undefined };
		const rawRoute = this.#unreliableWebRtcOwner?.openUnreliableWebRtcRoute(topic);
		let unsubscribeRaw = (): void => undefined;
		let unsubscribeGroupPeers = (): void => undefined;
		let unsubscribePeerConnections = (): void => undefined;
		const currentAuthority = (): ReturnType<EphemeralAuthorizationProvider["currentAuthority"]> => {
			const authority = provider.currentAuthority();
			return authority?.objectId === objectId ? authority : undefined;
		};
		const transportPeers = (): readonly string[] => {
			return [
				...new Set([
					...this.#networkNode.getAllPeers(),
					...this.#networkNode.getGroupPeers(topic),
					...(rawRoute?.snapshot().links.map(({ peerId }) => peerId) ?? []),
				]),
			];
		};
		const authorizedPeers = (): readonly string[] => {
			if (currentAuthority() === undefined) return [];
			return transportPeers()
				.filter((peerId) => {
					const author = provider.authorForPeer(peerId);
					return author !== undefined && provider.isCurrentWriter(author);
				})
				.sort();
		};
		const reconcileRaw = (): void => {
			if (rawRoute === undefined) return;
			const peers = authorizedPeers();
			if (peers.length === 0) return;
			void rawRoute.reconcile(peers).catch(() => undefined);
		};
		const nativeTransport: EphemeralTransportPort &
			EphemeralAuthorizationProvider & {
				onPeerDisconnect(listener: (peerId: string) => void): () => void;
			} = {
			authorizedPeers,
			authorForPeer: (peerId: string): string | undefined => provider.authorForPeer(peerId),
			currentAuthority,
			isCurrentWriter: (author: string): boolean => provider.isCurrentWriter(author),
			onPeerDisconnect: (listener: (peerId: string) => void): (() => void) => {
				const subscribe = this.#networkNode.subscribeToPeerDisconnects;
				return subscribe === undefined ? (): void => undefined : subscribe.call(this.#networkNode, listener);
			},
			localPeerId: this.#networkNode.peerId,
			maxEnvelopeBytes: (deliveryClass): number =>
				deliveryClass === "reliable-unordered" ? EPHEMERAL_TRANSPORT_MAX_BYTES : (rawRoute?.maxPayloadBytes ?? 0),
			isAuthorized: (sender): boolean => {
				if (currentAuthority() === undefined) return false;
				const author = provider.authorForPeer(sender);
				return author !== undefined && transportPeers().includes(sender) && provider.isCurrentWriter(author);
			},
			onMessage: (listener): (() => void) => {
				registration.listener = (ingress): void => {
					const deliveryClass = inspectEphemeralDeliveryClass(ingress.bytes);
					if (deliveryClass !== undefined && deliveryClass !== "reliable-unordered") {
						return;
					}
					listener(ingress);
				};
				unsubscribeRaw =
					rawRoute?.onMessage((ingress): void => {
						const deliveryClass = inspectEphemeralDeliveryClass(ingress.bytes);
						if (deliveryClass === "reliable-unordered") return;
						listener(ingress);
						reconcileRaw();
					}) ?? ((): void => undefined);
				return (): void => {
					registration.listener = undefined;
					unsubscribeRaw();
					unsubscribeRaw = (): void => undefined;
				};
			},
			restartUnreliable: (): Promise<void> => rawRoute?.restart() ?? Promise.resolve(),
			send: async (input): Promise<boolean> => {
				const authorized = authorizedPeers();
				const recipients = input.recipients === "all" ? authorized : input.recipients;
				if (!recipients.every((peerId) => authorized.includes(peerId))) return false;
				if (input.class === "reliable-unordered") {
					return this.#sendDirect(topic, input.bytes, recipients, input.signal);
				}
				if (recipients.length === 0) return false;
				if (rawRoute === undefined) return false;
				if (input.recipients === "all") {
					const results = await Promise.all(recipients.map((peerId) => rawRoute.send([peerId], input.bytes)));
					return results.some(Boolean);
				}
				return rawRoute.send(recipients, input.bytes);
			},
			close: (): void => {
				try {
					unsubscribeRaw();
					unsubscribeGroupPeers();
					unsubscribePeerConnections();
					rawRoute?.close();
					this.#networkNode.unsubscribe(topic);
				} finally {
					this.#byObject.delete(objectId);
					this.#byTopic.delete(topic);
				}
			},
		};
		const channel = createEphemeralChannel(nativeTransport, options);
		this.#byObject.set(objectId, {
			channel,
			options: { ...options },
			rawRoute,
			reconcileRaw,
		});
		this.#byTopic.set(topic, registration);
		try {
			this.#networkNode.subscribe(topic);
			if (rawRoute !== undefined) {
				const subscribeGroupPeers = this.#networkNode.subscribeToGroupPeerChanges;
				if (typeof subscribeGroupPeers === "function") {
					unsubscribeGroupPeers = subscribeGroupPeers.call(this.#networkNode, (change): void => {
						if (change.topic === topic) reconcileRaw();
					});
				}
				const subscribePeerConnections = this.#networkNode.subscribeToPeerConnections;
				if (typeof subscribePeerConnections === "function") {
					unsubscribePeerConnections = subscribePeerConnections.call(this.#networkNode, reconcileRaw);
				}
				reconcileRaw();
			}
		} catch (error) {
			channel.close();
			throw error;
		}
		return channel;
	}

	/**
	 * Claim exact signed custom ingress owned by an active channel.
	 * @param message Attributed network message.
	 * @returns Whether this adapter owns the message.
	 */
	route(message: Message): boolean {
		if (message.type !== MessageType.MESSAGE_TYPE_CUSTOM) return false;
		const gossipTopic = this.#networkNode.gossipTopicFor(message);
		const selectedTopic = message.objectId;
		const registration = this.#byTopic.get(selectedTopic);
		if (registration === undefined) return false;
		const evidence = this.#networkNode.claimIngressEvidence?.(message);
		if (evidence === undefined || evidence.message.data.byteLength > EPHEMERAL_TRANSPORT_MAX_BYTES) {
			return true;
		}
		const transport = evidence.transport;
		if (gossipTopic !== undefined) {
			if (
				transport.kind !== "signed-gossip" ||
				transport.topic !== selectedTopic ||
				transport.sender !== evidence.message.sender
			) {
				return true;
			}
		} else if (
			transport.kind !== "authenticated-stream" ||
			transport.protocol !== DRP_MESSAGE_PROTOCOL ||
			transport.sender !== evidence.message.sender
		) {
			return true;
		}
		registration.listener?.({ bytes: evidence.message.data.slice(), sender: evidence.message.sender });
		return true;
	}

	async #sendDirect(
		topic: string,
		bytes: Uint8Array,
		peers: readonly string[],
		signal?: AbortSignal
	): Promise<boolean> {
		if (bytes.byteLength > EPHEMERAL_TRANSPORT_MAX_BYTES || peers.length === 0) return false;
		const message = Message.create({
			data: bytes.slice(),
			objectId: topic,
			sender: this.#networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_CUSTOM,
		});
		const results = await Promise.allSettled(
			peers.map(async (peerId) => this.#networkNode.sendMessage(peerId, message, { signal }))
		);
		return results.every(({ status }) => status === "fulfilled");
	}
}

function ephemeralTopicFor(objectId: string): string {
	return `/ts-drp/ephemeral/1/${bytesToHex(sha256(concatBytes(EPHEMERAL_TOPIC_DOMAIN, new TextEncoder().encode(objectId))))}`;
}
