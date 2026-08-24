import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";
import {
	createEphemeralChannel,
	type EphemeralChannel,
	type EphemeralChannelOptions,
	type EphemeralIngress,
} from "@ts-drp/ephemeral";
import { DRP_MESSAGE_PROTOCOL } from "@ts-drp/network";
import { type DRPNetworkNode, type IDRP, type IDRPObject, Message, MessageType } from "@ts-drp/types";

const EPHEMERAL_TOPIC_DOMAIN = new TextEncoder().encode("ts-drp-ephemeral-topic-v1\u0000");
const EPHEMERAL_TRANSPORT_MAX_BYTES = 65_536;

interface ObjectRegistration {
	readonly channel: EphemeralChannel;
	readonly mode: "legacy" | "v3";
	readonly options: EphemeralChannelOptions;
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

	/**
	 * Create one adapter for one node instance.
	 * @param networkNode Exact signed network boundary.
	 * @param getObject Current object lookup.
	 */
	constructor(networkNode: DRPNetworkNode, getObject: (objectId: string) => IDRPObject<IDRP> | undefined) {
		this.#networkNode = networkNode;
		this.#getObject = getObject;
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
				maxEnvelopeBytes: (): number => EPHEMERAL_TRANSPORT_MAX_BYTES,
				isAuthorized: (sender): boolean => {
					if (!requireLegacyObject && currentAuthority() === undefined) return false;
					const author = provider.authorForPeer(sender);
					return author !== undefined && transportPeers().includes(sender) && provider.isCurrentWriter(author);
				},
				onMessage: (listener): (() => void) => {
					registration.listener = listener;
					return (): void => {
						if (registration.listener === listener) registration.listener = undefined;
					};
				},
				send: (input): Promise<boolean> => {
					if (input.recipients !== "all") return Promise.resolve(false);
					return this.#send(topic, input.bytes, requireLegacyObject ? Object.freeze([]) : authorizedPeers());
				},
				close: (): void => {
					try {
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
		});
		this.#byTopic.set(topic, registration);
		try {
			this.#networkNode.subscribe(topic);
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
