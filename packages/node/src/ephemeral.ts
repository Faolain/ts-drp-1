import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";
import {
	createEphemeralChannel,
	type EphemeralChannel,
	type EphemeralChannelOptions,
	type EphemeralIngress,
} from "@ts-drp/ephemeral";
import { type DRPNetworkNode, type IDRP, type IDRPObject, Message, MessageType } from "@ts-drp/types";

const EPHEMERAL_TOPIC_DOMAIN = new TextEncoder().encode("ts-drp-ephemeral-topic-v1\u0000");
const EPHEMERAL_TRANSPORT_MAX_BYTES = 65_536;

interface ObjectRegistration {
	readonly channel: EphemeralChannel;
	readonly options: EphemeralChannelOptions;
}

interface TopicRegistration {
	listener: ((ingress: EphemeralIngress) => void) | undefined;
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
		for (const { channel } of [...this.#byObject.values()]) channel.close();
	}

	/** Close the channel whose durable object is leaving this node. */
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
		if (Object.keys(options).sort().join(",") !== "maxMessageBytes,maxSequencedKeys") {
			throw new TypeError("ephemeral channel options differ");
		}
		const existing = this.#byObject.get(objectId);
		if (existing !== undefined) {
			if (
				existing.options.maxMessageBytes !== options.maxMessageBytes ||
				existing.options.maxSequencedKeys !== options.maxSequencedKeys
			) {
				throw new Error("ephemeral channel options differ from the active object channel");
			}
			return existing.channel;
		}
		if (this.#getObject(objectId) === undefined) throw new Error("ephemeral channel requires a connected object");
		const topic = ephemeralTopicFor(objectId);
		const registration: TopicRegistration = { listener: undefined };
		const channel = createEphemeralChannel(
			{
				localPeerId: this.#networkNode.peerId,
				maxEnvelopeBytes: EPHEMERAL_TRANSPORT_MAX_BYTES,
				isAuthorized: (sender): boolean => {
					const currentObject = this.#getObject(objectId);
					return (
						currentObject !== undefined &&
						this.#networkNode.getGroupPeers(topic).includes(sender) &&
						currentObject.acl.query_isWriter(sender)
					);
				},
				onMessage: (listener): (() => void) => {
					registration.listener = listener;
					return (): void => {
						if (registration.listener === listener) registration.listener = undefined;
					};
				},
				send: (bytes): Promise<boolean> => this.#send(topic, bytes),
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
		this.#byObject.set(objectId, { channel, options: { ...options } });
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
		const topic = this.#networkNode.gossipTopicFor(message);
		if (topic === undefined) return false;
		const registration = this.#byTopic.get(topic);
		if (registration === undefined) return false;
		if (message.objectId !== topic || message.data.byteLength > EPHEMERAL_TRANSPORT_MAX_BYTES) return true;
		registration.listener?.({ bytes: message.data.slice(), sender: message.sender });
		return true;
	}

	async #send(topic: string, bytes: Uint8Array): Promise<boolean> {
		if (bytes.byteLength > EPHEMERAL_TRANSPORT_MAX_BYTES) return false;
		const message = Message.create({
			data: bytes.slice(),
			objectId: topic,
			sender: this.#networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_CUSTOM,
		});
		try {
			return await this.#networkNode.publishMessage(topic, message);
		} catch {
			return false;
		}
	}
}

function ephemeralTopicFor(objectId: string): string {
	return `/ts-drp/ephemeral/1/${bytesToHex(sha256(concatBytes(EPHEMERAL_TOPIC_DOMAIN, new TextEncoder().encode(objectId))))}`;
}
