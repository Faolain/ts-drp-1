import type { V3RoomSuccessorNode } from "@ts-drp/example-v3-room";
import { Message, MessageType } from "@ts-drp/types";

// The v3-chat demo's network is a BroadcastChannel between same-origin pages, not libp2p. Its
// successor delivery and successor material ride the same kind of channel: the shared delivery
// (examples/v3-room successor-delivery) gets a node view with direct sends and a custom message
// queue, and the room gets snapshot protocol ports whose streams are channel frames between two
// peers. Same-page ports of one peer and protocol share one server (the latest `serve` wins).

type Signal = Readonly<{ readonly signal: AbortSignal }>;
/** The room's snapshot protocol stream (structurally `SnapshotChunkProtocolStream` of @ts-drp/network). */
interface SnapshotChunkProtocolStream {
	readonly peerId: string;
	abort(reason?: Error): void;
	close(): Promise<void>;
	read(maxBytes: number, options: Signal): Promise<Uint8Array>;
	write(exactBytes: Uint8Array, options: Signal): Promise<void>;
}
/** The room's snapshot protocol port (structurally `SnapshotChunkProtocolPort` of @ts-drp/network). */
export interface SnapshotChunkProtocolPort {
	readonly localPeerId: string;
	close(): Promise<void>;
	connectedPeers(): readonly string[];
	open(peerId: string, options: Signal): Promise<SnapshotChunkProtocolStream>;
	serve(handler: (stream: SnapshotChunkProtocolStream) => Promise<void>): () => void;
}

type Frame = Readonly<{
	kind: "ts-drp-v3-chat-stream";
	protocol: string;
	streamId: string;
	from: string;
	to: string;
	op: "open" | "data" | "close" | "abort";
	bytes?: Uint8Array;
}>;
type CustomFrame = Readonly<{
	kind: "ts-drp-v3-chat-custom";
	from: string;
	to: string;
	objectId: string;
	data: Uint8Array;
}>;

const servers = new Map<string, symbol>();
const STREAM_FRAME_MAX_BYTES = 1 << 20;

class ChannelStream implements SnapshotChunkProtocolStream {
	readonly #frames: Uint8Array[] = [];
	readonly #waiters: { resolve(): void }[] = [];
	#ended = false;
	constructor(
		readonly peerId: string,
		private readonly send: (op: Frame["op"], bytes?: Uint8Array) => void,
		private readonly forget: () => void
	) {}
	push(bytes: Uint8Array): void {
		if (this.#ended) return;
		this.#frames.push(bytes);
		for (const waiter of this.#waiters.splice(0)) waiter.resolve();
	}
	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.forget();
		for (const waiter of this.#waiters.splice(0)) waiter.resolve();
	}
	abort(): void {
		if (this.#ended) return;
		this.send("abort");
		this.end();
	}
	close(): Promise<void> {
		if (!this.#ended) this.send("close");
		this.end();
		return Promise.resolve();
	}
	async read(maxBytes: number, options: Signal): Promise<Uint8Array> {
		for (;;) {
			options.signal.throwIfAborted();
			const frame = this.#frames.shift();
			if (frame !== undefined) {
				if (frame.byteLength > maxBytes) throw new TypeError("v3 chat stream frame exceeds the read limit");
				return frame;
			}
			if (this.#ended) throw new TypeError("v3 chat stream is closed");
			await new Promise<void>((resolve, reject) => {
				const onAbort = (): void => reject(options.signal.reason);
				options.signal.addEventListener("abort", onAbort, { once: true });
				this.#waiters.push({
					resolve: () => {
						options.signal.removeEventListener("abort", onAbort);
						resolve();
					},
				});
			});
		}
	}
	write(exactBytes: Uint8Array, options: Signal): Promise<void> {
		options.signal.throwIfAborted();
		if (this.#ended) return Promise.reject(new TypeError("v3 chat stream is closed"));
		if (exactBytes.byteLength > STREAM_FRAME_MAX_BYTES)
			return Promise.reject(new TypeError("v3 chat stream frame is too large"));
		this.send("data", Uint8Array.from(exactBytes));
		return Promise.resolve();
	}
}

/**
 * A snapshot protocol port on the demo's channel.
 * @param peerId - This peer.
 * @param channelName - The room's channel.
 * @param knownPeerIds - Every peer of the demo.
 * @param protocol - The snapshot protocol this port carries.
 * @returns The port.
 */
export function createV3ChatSnapshotPort(
	peerId: string,
	channelName: string,
	knownPeerIds: readonly string[],
	protocol: string
): SnapshotChunkProtocolPort {
	const channel = new BroadcastChannel(`${channelName}--snapshot`);
	const streams = new Map<string, ChannelStream>();
	const serverKey = `${channelName}\u0000${peerId}\u0000${protocol}`;
	let token: symbol | undefined;
	let handler: ((stream: SnapshotChunkProtocolStream) => Promise<void>) | undefined;
	let closed = false;
	const stream = (streamId: string, remote: string): ChannelStream => {
		const created = new ChannelStream(
			remote,
			(op, bytes) => {
				if (closed) return;
				const frame: Frame = {
					kind: "ts-drp-v3-chat-stream",
					protocol,
					streamId,
					from: peerId,
					to: remote,
					op,
					...(bytes === undefined ? {} : { bytes }),
				};
				channel.postMessage(frame);
			},
			() => streams.delete(streamId)
		);
		streams.set(streamId, created);
		return created;
	};
	channel.addEventListener("message", (event: MessageEvent<unknown>) => {
		const frame = event.data as Partial<Frame> | null;
		if (closed || frame === null || typeof frame !== "object" || frame.kind !== "ts-drp-v3-chat-stream") return;
		if (
			frame.to !== peerId ||
			frame.protocol !== protocol ||
			typeof frame.streamId !== "string" ||
			typeof frame.from !== "string"
		)
			return;
		if (frame.op === "open") {
			if (handler === undefined || token === undefined || servers.get(serverKey) !== token) return;
			const inbound = stream(frame.streamId, frame.from);
			void handler(inbound)
				.catch(() => undefined)
				.finally(() => void inbound.close());
			return;
		}
		const selected = streams.get(frame.streamId);
		if (selected === undefined) return;
		if (frame.op === "data" && frame.bytes instanceof Uint8Array) selected.push(frame.bytes);
		else if (frame.op === "close" || frame.op === "abort") selected.end();
	});
	return Object.freeze({
		localPeerId: peerId,
		connectedPeers: (): readonly string[] => knownPeerIds.filter((known) => known !== peerId),
		open: (remote: string, options: Signal): Promise<SnapshotChunkProtocolStream> => {
			options.signal.throwIfAborted();
			if (closed) return Promise.reject(new TypeError("v3 chat snapshot port is closed"));
			const streamId = crypto.randomUUID();
			const outbound = stream(streamId, remote);
			const frame: Frame = { kind: "ts-drp-v3-chat-stream", protocol, streamId, from: peerId, to: remote, op: "open" };
			channel.postMessage(frame);
			return Promise.resolve(outbound);
		},
		serve: (selected: (stream: SnapshotChunkProtocolStream) => Promise<void>): (() => void) => {
			handler = selected;
			token = Symbol(serverKey);
			servers.set(serverKey, token);
			const mine = token;
			return () => {
				if (servers.get(serverKey) === mine) servers.delete(serverKey);
				if (token === mine) {
					token = undefined;
					handler = undefined;
				}
			};
		},
		close: (): Promise<void> => {
			if (closed) return Promise.resolve();
			closed = true;
			if (token !== undefined && servers.get(serverKey) === token) servers.delete(serverKey);
			for (const selected of [...streams.values()]) selected.end();
			channel.close();
			return Promise.resolve();
		},
	});
}

/**
 * The node view the shared successor delivery runs on: direct sends and a custom message queue on
 * the demo's channel.
 * @param peerId - This peer.
 * @param channelName - The room's channel.
 * @param knownPeerIds - Every peer of the demo.
 * @returns The node view and its close.
 */
export function createV3ChatSuccessorNode(
	peerId: string,
	channelName: string,
	knownPeerIds: readonly string[]
): V3RoomSuccessorNode & { close(): void } {
	const channel = new BroadcastChannel(`${channelName}--successor`);
	const queues = new Map<string, (message: Message) => void | Promise<void>>();
	channel.addEventListener("message", (event: MessageEvent<unknown>) => {
		const frame = event.data as Partial<CustomFrame> | null;
		if (frame === null || typeof frame !== "object" || frame.kind !== "ts-drp-v3-chat-custom") return;
		if (frame.to !== peerId || typeof frame.from !== "string" || typeof frame.objectId !== "string") return;
		if (!(frame.data instanceof Uint8Array)) return;
		const handler = queues.get(frame.objectId);
		if (handler === undefined) return;
		void handler(
			Message.create({
				sender: frame.from,
				type: MessageType.MESSAGE_TYPE_CUSTOM,
				objectId: frame.objectId,
				data: frame.data,
			})
		);
	});
	return {
		networkNode: {
			peerId,
			getAllPeers: (): string[] => knownPeerIds.filter((known) => known !== peerId),
			sendMessage: (target: string, message: Message): Promise<void> => {
				const frame: CustomFrame = {
					kind: "ts-drp-v3-chat-custom",
					from: peerId,
					to: target,
					objectId: message.objectId,
					data: Uint8Array.from(message.data),
				};
				channel.postMessage(frame);
				return Promise.resolve();
			},
		},
		messageQueueManager: {
			subscribe: (queueId: string, handler: (message: Message) => void | Promise<void>): void => {
				queues.set(queueId, handler);
			},
			close: (queueId: string): void => {
				queues.delete(queueId);
			},
		},
		close: (): void => {
			queues.clear();
			channel.close();
		},
	};
}
