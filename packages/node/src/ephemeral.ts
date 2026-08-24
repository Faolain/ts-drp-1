import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";
import {
	createEphemeralChannel,
	type EphemeralChannel,
	type EphemeralChannelOptions,
	type EphemeralIngress,
	inspectEphemeralDeliveryClass,
} from "@ts-drp/ephemeral";
import {
	DRP_MESSAGE_PROTOCOL,
	type DRPUnreliableWebRtcOwner,
	type DRPUnreliableWebRtcRoute,
	type DRPUnreliableWebRtcSnapshot,
} from "@ts-drp/network";
import { type DRPNetworkNode, type IDRP, type IDRPObject, Message, MessageType } from "@ts-drp/types";

const EPHEMERAL_TOPIC_DOMAIN = new TextEncoder().encode("ts-drp-ephemeral-topic-v1\u0000");
const EPHEMERAL_TRANSPORT_MAX_BYTES = 65_536;

interface ObjectRegistration {
	readonly channel: EphemeralChannel;
	readonly mode: "legacy" | "v3";
	readonly options: EphemeralChannelOptions;
	readonly rawRoute: DRPUnreliableWebRtcRoute | undefined;
}

interface TopicRegistration {
	readonly allowDirect: boolean;
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
	readonly #getObject: (objectId: string) => IDRPObject<IDRP> | undefined;
	readonly #networkNode: DRPNetworkNode;
	readonly #unreliableWebRtcOwner: DRPUnreliableWebRtcOwner | null;

	/**
	 * Create one adapter for one node instance.
	 * @param networkNode Exact signed network boundary.
	 * @param getObject Current object lookup.
	 * @param unreliableWebRtcOwner Narrow raw owner available only on the default network implementation.
	 */
	constructor(
		networkNode: DRPNetworkNode,
		getObject: (objectId: string) => IDRPObject<IDRP> | undefined,
		unreliableWebRtcOwner: DRPUnreliableWebRtcOwner | null
	) {
		this.#networkNode = networkNode;
		this.#getObject = getObject;
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
	 * Open or retrieve an object-bound channel.
	 * @param objectId Connected object identity.
	 * @param options Closed channel limits.
	 * @returns One object-bound channel.
	 */
	open(objectId: string, options: EphemeralChannelOptions): EphemeralChannel {
		return this.openAuthorized(
			objectId,
			{
				authorForPeer: (peerId): string | undefined => peerId,
				currentAuthority: () => undefined,
				isCurrentWriter: (author): boolean => this.#getObject(objectId)?.acl.query_isWriter(author) === true,
			},
			options,
			true
		);
	}

	/**
	 * Open one channel from an authenticated peer-to-author roster and current writer projection.
	 * @param objectId Durable v3 room identity.
	 * @param provider Live authorization projected from accepted durable vertices.
	 * @param options Closed channel limits.
	 * @param requireLegacyObject Whether the legacy object store must contain the room identity.
	 * @returns The existing identically-configured channel or a newly activated one.
	 */
	openAuthorized(
		objectId: string,
		provider: EphemeralAuthorizationProvider,
		options: EphemeralChannelOptions,
		requireLegacyObject = false
	): EphemeralChannel {
		if (Object.keys(options).sort().join(",") !== "maxMessageBytes,maxSequencedKeys,maxSequencedSenders") {
			throw new TypeError("ephemeral channel options differ");
		}
		const existing = this.#byObject.get(objectId);
		if (existing !== undefined) {
			const mode = requireLegacyObject ? "legacy" : "v3";
			if (
				existing.mode !== mode ||
				existing.options.maxMessageBytes !== options.maxMessageBytes ||
				existing.options.maxSequencedKeys !== options.maxSequencedKeys ||
				existing.options.maxSequencedSenders !== options.maxSequencedSenders
			) {
				throw new Error("ephemeral channel options differ from the active object channel");
			}
			return existing.channel;
		}
		if (requireLegacyObject && this.#getObject(objectId) === undefined) {
			throw new Error("ephemeral channel requires a connected object");
		}
		const topic = ephemeralTopicFor(objectId);
		const registration: TopicRegistration = { allowDirect: !requireLegacyObject, listener: undefined };
		const rawRoute = requireLegacyObject ? undefined : this.#unreliableWebRtcOwner?.openUnreliableWebRtcRoute(topic);
		let unsubscribeRaw = (): void => undefined;
		let unsubscribeGroupPeers = (): void => undefined;
		let unsubscribePeerConnections = (): void => undefined;
		const currentAuthority = (): ReturnType<EphemeralAuthorizationProvider["currentAuthority"]> => {
			const authority = provider.currentAuthority();
			return authority?.objectId === objectId ? authority : undefined;
		};
		const transportPeers = (): readonly string[] =>
			requireLegacyObject
				? this.#networkNode.getGroupPeers(topic)
				: [...new Set([...this.#networkNode.getAllPeers(), ...this.#networkNode.getGroupPeers(topic)])];
		const authorizedPeers = (): readonly string[] => {
			if (!requireLegacyObject && currentAuthority() === undefined) return [];
			return transportPeers()
				.filter((peerId) => {
					const author = provider.authorForPeer(peerId);
					return author !== undefined && provider.isCurrentWriter(author);
				})
				.sort();
		};
		const reconcileRaw = (): void => {
			if (rawRoute === undefined) return;
			void rawRoute.reconcile(authorizedPeers()).catch(() => undefined);
		};
		const channel = createEphemeralChannel(
			{
				authorizedPeers,
				...(requireLegacyObject
					? {}
					: {
							authorForPeer: (peerId: string): string | undefined => provider.authorForPeer(peerId),
							currentAuthority,
							isCurrentWriter: (author: string): boolean => provider.isCurrentWriter(author),
							onPeerDisconnect: (listener: (peerId: string) => void): (() => void) => {
								const subscribe = this.#networkNode.subscribeToPeerDisconnects;
								return subscribe === undefined ? (): void => undefined : subscribe.call(this.#networkNode, listener);
							},
						}),
				localPeerId: this.#networkNode.peerId,
				maxEnvelopeBytes: (deliveryClass): number =>
					requireLegacyObject || deliveryClass === "reliable-unordered"
						? EPHEMERAL_TRANSPORT_MAX_BYTES
						: (rawRoute?.maxPayloadBytes ?? 0),
				isAuthorized: (sender): boolean => {
					if (!requireLegacyObject && currentAuthority() === undefined) return false;
					const author = provider.authorForPeer(sender);
					return author !== undefined && transportPeers().includes(sender) && provider.isCurrentWriter(author);
				},
				onMessage: (listener): (() => void) => {
					registration.listener = (ingress): void => {
						const deliveryClass = inspectEphemeralDeliveryClass(ingress.bytes);
						if (!requireLegacyObject && deliveryClass !== undefined && deliveryClass !== "reliable-unordered") {
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
				send: async (input): Promise<boolean> => {
					if (input.recipients !== "all") return Promise.resolve(false);
					if (requireLegacyObject || input.class === "reliable-unordered") {
						return this.#send(topic, input.bytes, requireLegacyObject ? Object.freeze([]) : authorizedPeers());
					}
					if (rawRoute === undefined) return false;
					const peers = authorizedPeers();
					if (peers.length === 0) return false;
					const results = await Promise.all(peers.map((peerId) => rawRoute.send([peerId], input.bytes)));
					return results.some(Boolean);
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
			},
			options
		);
		this.#byObject.set(objectId, {
			channel,
			mode: requireLegacyObject ? "legacy" : "v3",
			options: { ...options },
			rawRoute,
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
			transport.sender !== evidence.message.sender ||
			!registration.allowDirect
		) {
			return true;
		}
		registration.listener?.({ bytes: evidence.message.data.slice(), sender: evidence.message.sender });
		return true;
	}

	async #send(topic: string, bytes: Uint8Array, peers: readonly string[]): Promise<boolean> {
		if (bytes.byteLength > EPHEMERAL_TRANSPORT_MAX_BYTES) return false;
		const message = Message.create({
			data: bytes.slice(),
			objectId: topic,
			sender: this.#networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_CUSTOM,
		});
		const [gossip] = await Promise.allSettled([
			this.#networkNode.publishMessage(topic, message),
			...peers.map((peerId) => this.#networkNode.sendMessage(peerId, message)),
		]);
		return gossip?.status === "fulfilled" && gossip.value === true;
	}
}

function ephemeralTopicFor(objectId: string): string {
	return `/ts-drp/ephemeral/1/${bytesToHex(sha256(concatBytes(EPHEMERAL_TOPIC_DOMAIN, new TextEncoder().encode(objectId))))}`;
}
