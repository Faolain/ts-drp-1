import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";

import type { ReadinessHoldPeer } from "./readiness-hold-room.js";

// Track X (decision row 61): an in-memory link of the creator-successor protocol between two peers
// of the readiness-hold room. The Writer's streams reach the handler the creator's own room
// installs (sealEpoch, exportCreatorSuccessor), with real request/response framing, so both
// sides' own deadlines apply unchanged. The same link as the row-61 RED, shared by its proofs.

/** One direction of an in-memory stream: frames in order, then an end or a failure. */
class FramePipe {
	readonly #frames: Uint8Array[] = [];
	#wake: (() => void) | undefined;
	#ended = false;
	#failure: Error | undefined;

	push(frame: Uint8Array): void {
		if (this.#ended || this.#failure !== undefined) throw new TypeError("TRACK_X_LINK_PIPE_CLOSED");
		this.#frames.push(Uint8Array.from(frame));
		this.#signal();
	}

	end(): void {
		this.#ended = true;
		this.#signal();
	}

	fail(reason: Error): void {
		this.#failure ??= reason;
		this.#signal();
	}

	async next(maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
		for (;;) {
			signal.throwIfAborted();
			const frame = this.#frames.shift();
			if (frame !== undefined) {
				if (frame.byteLength > maxBytes) throw new TypeError("TRACK_X_LINK_FRAME_LIMIT");
				return frame;
			}
			if (this.#failure !== undefined) throw this.#failure;
			if (this.#ended) throw new TypeError("TRACK_X_LINK_PIPE_ENDED");
			await new Promise<void>((resolve) => {
				const onAbort = (): void => {
					this.#wake = undefined;
					resolve();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				this.#wake = (): void => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				};
			});
		}
	}

	#signal(): void {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}
}

function pipeStream(
	peerId: string,
	inbox: FramePipe,
	outbox: FramePipe,
	onWrite: (bytes: Uint8Array) => void
): SnapshotChunkProtocolStream {
	return {
		peerId,
		abort: (reason) => {
			const error = reason ?? new Error("TRACK_X_LINK_STREAM_ABORTED");
			inbox.fail(error);
			outbox.fail(error);
		},
		close: () => {
			outbox.end();
			return Promise.resolve();
		},
		read: (maxBytes, options) => inbox.next(maxBytes, options.signal),
		write: (bytes, options) => {
			options.signal.throwIfAborted();
			onWrite(bytes);
			outbox.push(bytes);
			return Promise.resolve();
		},
	};
}

export interface SuccessorLinkFrame {
	/** Which side wrote the frame. */
	readonly from: "writer" | "creator";
	/** The frame's canonical `kind`, or "raw" for a frame that is not a canonical record (chunk bytes). */
	readonly kind: string;
	/** When it was written. */
	readonly at: number;
}

export interface SuccessorLinkOptions {
	/**
	 * Close the creator's port as the production port does (network node.ts
	 * createSnapshotChunkProtocolHost): abort its open inbound streams, then wait for every inbound
	 * handler to finish. Without it, close only removes the handler.
	 */
	readonly joinHandlersOnClose?: boolean;
}

export interface SuccessorLink {
	/** When the Writer sent each material request. */
	readonly requests: number[];
	/** When the creator wrote each material response. */
	readonly responses: number[];
	/** Every frame either side wrote on the link, in order. */
	readonly frames: SuccessorLinkFrame[];
	/** @returns How many of the creator's inbound handlers are still running. */
	activeHandlers(): number;
	/**
	 * Binds a reopened creator's network node to this link (the same peer), so its successor
	 * serving answers the streams this link's Writer port opens.
	 * @param networkNode - The reopened creator's network node.
	 */
	rebindCreator(networkNode: object): void;
	/**
	 * Binds a reopened Writer's network node to this link (the same peer).
	 * @param networkNode - The reopened Writer's network node.
	 */
	rebindWriter(networkNode: object): void;
	/**
	 * Sets the peers the creator's port reports as connected (default: the Writer).
	 * @param peers - The connected peers, or undefined for the default.
	 */
	setConnected(peers: readonly string[] | undefined): void;
	/**
	 * Opens one raw stream to the creator on the link (for frames the Writer's install never sends).
	 * @param peerId - The peer the creator sees on the stream (default: the Writer).
	 * @returns The requester's end of the stream.
	 */
	open(peerId?: string): Promise<SnapshotChunkProtocolStream>;
}

const frameKind = (bytes: Uint8Array): string => {
	try {
		const value = decodeCanonical(bytes) as { kind?: unknown } | null;
		return typeof value?.kind === "string" ? value.kind : "raw";
	} catch {
		return "raw";
	}
};

/**
 * Connects the Writer's creator-successor protocol port to the creator's.
 * @param creator - The creator peer.
 * @param writer - The Writer peer.
 * @param options - How the creator's port closes.
 * @returns The link's observations and a raw opener.
 */
export function linkSuccessorProtocol(
	creator: ReadinessHoldPeer,
	writer: ReadinessHoldPeer,
	options: SuccessorLinkOptions = {}
): SuccessorLink {
	const creatorPeer = creator.networkNode.peerId;
	const writerPeer = writer.networkNode.peerId;
	const requests: number[] = [];
	const responses: number[] = [];
	const frames: SuccessorLinkFrame[] = [];
	const inbound = new Map<SnapshotChunkProtocolStream, Promise<void>>();
	let handler: ((stream: SnapshotChunkProtocolStream) => Promise<void>) | undefined;
	let connected: readonly string[] | undefined;
	const creatorPort: SnapshotChunkProtocolPort = {
		localPeerId: creatorPeer,
		close: () => {
			handler = undefined;
			if (options.joinHandlersOnClose !== true) return Promise.resolve();
			for (const stream of [...inbound.keys()]) stream.abort(new Error("TRACK_X_LINK_PORT_CLOSED"));
			return Promise.allSettled([...inbound.values()]).then(() => undefined);
		},
		connectedPeers: () => [...(connected ?? [writerPeer])],
		open: () => Promise.reject(new TypeError("TRACK_X_LINK_CREATOR_DOES_NOT_DIAL")),
		serve: (next) => {
			handler = next;
			return () => {
				if (handler === next) handler = undefined;
			};
		},
	};
	const open = (peer: string, signal: AbortSignal, from = writerPeer): Promise<SnapshotChunkProtocolStream> => {
		signal.throwIfAborted();
		const serve = handler;
		if (peer !== creatorPeer || serve === undefined) return Promise.reject(new TypeError("TRACK_X_LINK_NO_SERVER"));
		const toCreator = new FramePipe();
		const toWriter = new FramePipe();
		let material = false;
		const served = pipeStream(from, toCreator, toWriter, (bytes) => {
			frames.push({ from: "creator", kind: frameKind(bytes), at: performance.now() });
			if (material) responses.push(performance.now());
		});
		const outbound = pipeStream(creatorPeer, toWriter, toCreator, (bytes) => {
			const kind = frameKind(bytes);
			frames.push({ from: "writer", kind, at: performance.now() });
			if (kind === "creator-successor-material-request") {
				material = true;
				requests.push(performance.now());
			}
		});
		const task = serve(served).finally(() => inbound.delete(served));
		inbound.set(served, task);
		void task.catch(() => undefined);
		return Promise.resolve(outbound);
	};
	const writerPort: SnapshotChunkProtocolPort = {
		localPeerId: writerPeer,
		close: () => Promise.resolve(),
		connectedPeers: () => [creatorPeer],
		open: (peer, openOptions) => open(peer, openOptions.signal),
		serve: () => () => undefined,
	};
	const rebindCreator = (networkNode: object): void => {
		Reflect.set(networkNode, "createSnapshotChunkProtocolHost", () => creatorPort);
	};
	const rebindWriter = (networkNode: object): void => {
		Reflect.set(networkNode, "createSnapshotChunkProtocolHost", () => writerPort);
	};
	rebindCreator(creator.networkNode);
	rebindWriter(writer.networkNode);
	return {
		requests,
		responses,
		frames,
		activeHandlers: () => inbound.size,
		rebindCreator,
		rebindWriter,
		setConnected: (peers) => {
			connected = peers === undefined ? undefined : [...peers];
		},
		open: (peerId) => open(creatorPeer, new AbortController().signal, peerId ?? writerPeer),
	};
}
