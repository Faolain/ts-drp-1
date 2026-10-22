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

export interface SuccessorLink {
	/** When the Writer sent each material request. */
	readonly requests: number[];
	/** When the creator wrote each material response. */
	readonly responses: number[];
	/**
	 * Opens one raw Writer-to-creator stream on the link (for frames the Writer's install never sends).
	 * @returns The Writer's end of the stream.
	 */
	open(): Promise<SnapshotChunkProtocolStream>;
}

/**
 * Connects the Writer's creator-successor protocol port to the creator's.
 * @param creator - The creator peer.
 * @param writer - The Writer peer.
 * @returns The link's observations and a raw opener.
 */
export function linkSuccessorProtocol(creator: ReadinessHoldPeer, writer: ReadinessHoldPeer): SuccessorLink {
	const creatorPeer = creator.networkNode.peerId;
	const writerPeer = writer.networkNode.peerId;
	const requests: number[] = [];
	const responses: number[] = [];
	let handler: ((stream: SnapshotChunkProtocolStream) => Promise<void>) | undefined;
	const creatorPort: SnapshotChunkProtocolPort = {
		localPeerId: creatorPeer,
		close: () => {
			handler = undefined;
			return Promise.resolve();
		},
		connectedPeers: () => [writerPeer],
		open: () => Promise.reject(new TypeError("TRACK_X_LINK_CREATOR_DOES_NOT_DIAL")),
		serve: (next) => {
			handler = next;
			return () => {
				if (handler === next) handler = undefined;
			};
		},
	};
	const open = (peer: string, signal: AbortSignal): Promise<SnapshotChunkProtocolStream> => {
		signal.throwIfAborted();
		const serve = handler;
		if (peer !== creatorPeer || serve === undefined) return Promise.reject(new TypeError("TRACK_X_LINK_NO_SERVER"));
		const toCreator = new FramePipe();
		const toWriter = new FramePipe();
		let material = false;
		const inbound = pipeStream(writerPeer, toCreator, toWriter, () => {
			if (material) responses.push(performance.now());
		});
		const outbound = pipeStream(creatorPeer, toWriter, toCreator, (bytes) => {
			const request = decodeCanonical(bytes) as { kind?: unknown };
			if (request?.kind === "creator-successor-material-request") {
				material = true;
				requests.push(performance.now());
			}
		});
		void serve(inbound);
		return Promise.resolve(outbound);
	};
	const writerPort: SnapshotChunkProtocolPort = {
		localPeerId: writerPeer,
		close: () => Promise.resolve(),
		connectedPeers: () => [creatorPeer],
		open: (peer, options) => open(peer, options.signal),
		serve: () => () => undefined,
	};
	Reflect.set(creator.networkNode, "createSnapshotChunkProtocolHost", () => creatorPort);
	Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => writerPort);
	return { requests, responses, open: () => open(creatorPeer, new AbortController().signal) };
}
