// DirectMessageSessions: the one owner of direct (peer-to-peer, non-gossip) message transport.
//
// Before track 46 every direct message opened its own libp2p stream: over WebRTC a new RTCDataChannel
// (createDataChannel on the main thread, DCEP), a multistream-select round trip, a FIN/FIN_ACK round
// trip, and 2-3 ms of CPU per message at both ends; and the 4th concurrent message on a connection was
// reset by the shared 3-stream sync limit. Now each connection carries at most one long-lived session
// stream per traffic class (direct-message.ts), opened lazily and reused for every frame.
//
// Flow control: libp2p's WebRTC streams have no read backpressure and its length-prefixed reader
// buffers without bound until it fails, so the receiver grants credit (frames, bytes) back on the same
// stream as it admits each frame to its message queue. The sender never has more than the
// protocol-fixed window outstanding, so a slow receiver holds at most one window (G21) and nothing is
// dropped by an overflow (G23). The sender's own queue is bounded too and refuses with a typed error.
//
// Completion: a send resolves when its frame was accepted by the stream (credit taken, write drained),
// never while it only waits in the queue. Abort before writing starts removes the frame; abort during
// the write lets the frame complete (a frame cannot be cut out of a shared stream) and rejects the
// caller. A session reset rejects the frame being written (its delivery is unknown) and carries the
// frames behind it to a reopened stream. A closed connection rejects everything queued for it, so no
// frame outlives the connection it was queued on (G4, G25).
//
// Compatibility (G25): a peer that does not speak the session protocol (UnsupportedProtocolError) is
// served over the legacy one-frame-per-stream protocol on that connection, as is a connection whose
// sessions keep failing, for a cooldown. Sync-family messages always take the legacy id, which is the
// negotiated sync fallback.
import type { Connection, Stream } from "@libp2p/interface";
import { lpStream } from "@libp2p/utils";

import {
	DIRECT_MESSAGE_MAX_FRAME_BYTES,
	DIRECT_MESSAGE_MAX_PREFIX_BYTES,
	DIRECT_SESSION_LIMITS,
	DIRECT_SESSION_PROTOCOLS,
	type DirectSessionClass,
	DirectMessageSendError,
	DRP_MESSAGE_PROTOCOL,
	LEGACY_CLOSE_DEADLINE_MS,
	LEGACY_MAX_CONCURRENT,
	LEGACY_QUEUE_BYTES,
	LEGACY_QUEUE_FRAMES,
	SESSION_FAILURE_WINDOW_MS,
	SESSION_FAILURES_BEFORE_LEGACY,
	SESSION_LEGACY_COOLDOWN_MS,
	SESSION_OPEN_DEADLINE_MS,
} from "./direct-message.js";
import { boundedLengthDecoder, uint8ArrayToStream } from "./stream.js";

/** Admit one received frame: decode, validate, record evidence, enqueue. Throwing refuses (resets) the stream. */
export type DirectFrameAdmission = (frame: Uint8Array, sender: string, protocol: string) => Promise<void>;

export interface DirectSendOptions {
	readonly signal?: AbortSignal;
	/** Sync-family messages keep the legacy protocol (the negotiated sync fallback). */
	readonly legacyOnly?: boolean;
	/** Measurement hook: the frame starts its write (after queueing and credit). */
	readonly onWriteStart?: () => void;
}

interface Pending {
	readonly bytes: Uint8Array;
	readonly signal?: AbortSignal;
	readonly onWriteStart?: () => void;
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
	started: boolean;
	settled: boolean;
	/** Removes the frame from whichever queue holds it now. */
	cancel?: () => void;
	detachAbort?: () => void;
}

const CREDIT_MAX_BYTES = 16;

/** Bytes in the varint encoding of `value`: the longest length prefix a frame of `value` bytes needs. */
function varintLength(value: number): number {
	let length = 1;
	for (let rest = value; rest >= 0x80; rest = Math.floor(rest / 0x80)) length++;
	return length;
}

function encodeVarint(value: number, into: number[]): void {
	let rest = value;
	while (rest >= 0x80) {
		into.push((rest & 0x7f) | 0x80);
		rest = Math.floor(rest / 0x80);
	}
	into.push(rest);
}

function encodeCredit(frames: number, bytes: number): Uint8Array {
	const out: number[] = [];
	encodeVarint(frames, out);
	encodeVarint(bytes, out);
	return Uint8Array.from(out);
}

function decodeCredit(data: Uint8Array): { frames: number; bytes: number } {
	const values: number[] = [];
	let value = 0;
	let scale = 1;
	for (let index = 0; index < data.byteLength; index++) {
		const byte = data[index];
		value += (byte & 0x7f) * scale;
		scale *= 0x80;
		if ((byte & 0x80) === 0) {
			values.push(value);
			value = 0;
			scale = 1;
		} else if (scale > 2 ** 35) throw new RangeError("direct session credit varint too long");
	}
	if (values.length !== 2 || value !== 0 || scale !== 1) throw new RangeError("malformed direct session credit");
	const [frames, bytes] = values as [number, number];
	return { frames, bytes };
}

function settle(pending: Pending, error?: unknown): void {
	if (pending.settled) return;
	pending.settled = true;
	pending.detachAbort?.();
	if (error === undefined) pending.resolve();
	else pending.reject(error);
}

function isOpen(stream: Stream): boolean {
	return stream.status === "open";
}

function waitClosed(stream: Stream, timeoutMs: number): Promise<void> {
	if (stream.status !== "open" && stream.status !== "closing") return Promise.resolve();
	return new Promise<void>((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			stream.removeEventListener("close", done);
			resolve();
		};
		const timer = setTimeout(done, timeoutMs);
		stream.addEventListener("close", done, { once: true });
	});
}

/** One connection's direct transport: a session per class, plus the legacy sender. */
class ConnectionDirect {
	readonly #sessions: Partial<Record<DirectSessionClass, OutboundSession>> = {};
	readonly legacy: LegacySender;
	#unsupported = false;
	#legacyUntil = 0;
	readonly #failures: number[] = [];
	#openFailures = 0;
	#closed?: DirectMessageSendError;

	constructor(
		readonly connection: Connection,
		private readonly onClose: (direct: ConnectionDirect) => void
	) {
		this.legacy = new LegacySender(connection);
		connection.addEventListener(
			"close",
			() => this.close(new DirectMessageSendError("DIRECT_CONNECTION_CLOSED", "Direct-message connection closed")),
			{ once: true }
		);
	}

	send(pending: Pending, legacyOnly: boolean): void {
		if (this.#closed !== undefined) return settle(pending, this.#closed);
		if (this.connection.status !== "open") {
			this.close(new DirectMessageSendError("DIRECT_CONNECTION_CLOSED", "Direct-message connection is closed"));
			return settle(pending, this.#closed);
		}
		if (legacyOnly || this.useLegacy()) return this.legacy.enqueue(pending);
		const cls: DirectSessionClass = pending.bytes.byteLength <= DIRECT_SESSION_LIMITS.rt.maxFrameBytes ? "rt" : "bulk";
		let session = this.#sessions[cls];
		if (session === undefined) this.#sessions[cls] = session = new OutboundSession(this, cls);
		session.enqueue(pending);
	}

	useLegacy(): boolean {
		return this.#unsupported || Date.now() < this.#legacyUntil;
	}

	markUnsupported(): void {
		this.#unsupported = true;
	}

	/**
	 * A session stream failed. Too many failures inside the rolling window, or too many failed opens in
	 * a row with no successful open between them (opens that each run to the full negotiation deadline
	 * are spaced wider than the window), put the connection on the legacy protocol for a cooldown.
	 * @param open - Whether the failure was an open (negotiation) rather than the loss of an open stream.
	 */
	recordFailure(open: boolean): void {
		const now = Date.now();
		this.#failures.push(now);
		while (this.#failures.length > 0 && now - (this.#failures[0] ?? now) > SESSION_FAILURE_WINDOW_MS) this.#failures.shift();
		if (open) this.#openFailures++;
		if (this.#failures.length >= SESSION_FAILURES_BEFORE_LEGACY || this.#openFailures >= SESSION_FAILURES_BEFORE_LEGACY) {
			this.#failures.length = 0;
			this.#openFailures = 0;
			this.#legacyUntil = now + SESSION_LEGACY_COOLDOWN_MS;
		}
	}

	recordOpened(): void {
		this.#openFailures = 0;
	}

	close(error: DirectMessageSendError): void {
		if (this.#closed !== undefined) return;
		this.#closed = error;
		for (const session of Object.values(this.#sessions)) session?.close(error);
		this.legacy.close(error);
		this.onClose(this);
	}
}

/** One long-lived session stream for one traffic class on one connection. */
class OutboundSession {
	readonly #limits;
	readonly #protocol: string;
	readonly #queue: Pending[] = [];
	#queuedBytes = 0;
	#creditFrames = 0;
	#creditBytes = 0;
	#state: "idle" | "opening" | "open" | "closed" = "idle";
	#stream?: Stream;
	#lp?: ReturnType<typeof lpStream>;
	#writing = false;
	#opening?: AbortController;
	#closed?: DirectMessageSendError;

	constructor(
		private readonly owner: ConnectionDirect,
		cls: DirectSessionClass
	) {
		this.#limits = DIRECT_SESSION_LIMITS[cls];
		this.#protocol = DIRECT_SESSION_PROTOCOLS[cls];
	}

	enqueue(pending: Pending): void {
		if (this.#closed !== undefined) return settle(pending, this.#closed);
		if (
			this.#queue.length >= this.#limits.queueFrames ||
			this.#queuedBytes + pending.bytes.byteLength > this.#limits.queueBytes
		) {
			return settle(
				pending,
				new DirectMessageSendError("DIRECT_SEND_QUEUE_FULL", `Direct-message ${this.#protocol} send queue is full`)
			);
		}
		this.#queue.push(pending);
		this.#queuedBytes += pending.bytes.byteLength;
		pending.cancel = (): void => this.#remove(pending);
		this.#pump();
	}

	#remove(pending: Pending): void {
		const index = this.#queue.indexOf(pending);
		if (index < 0) return;
		this.#queue.splice(index, 1);
		this.#queuedBytes -= pending.bytes.byteLength;
		// The new head may fit the credit the removed one was waiting for.
		if (index === 0) this.#pump();
	}

	#pump(): void {
		if (this.#closed !== undefined || this.#queue.length === 0) return;
		if (this.#state === "idle") {
			void this.#open();
			return;
		}
		if (this.#state !== "open" || this.#writing) return;
		const head = this.#queue[0];
		if (head === undefined) return;
		if (this.#creditFrames < 1 || this.#creditBytes < head.bytes.byteLength) return;
		void this.#write(head);
	}

	async #open(): Promise<void> {
		this.#state = "opening";
		const opening = (this.#opening = new AbortController());
		let stream: Stream;
		try {
			stream = await this.owner.connection.newStream(this.#protocol, {
				signal: AbortSignal.any([opening.signal, AbortSignal.timeout(SESSION_OPEN_DEADLINE_MS)]),
			});
		} catch (error) {
			if (this.#closed !== undefined) return;
			this.#opening = undefined;
			this.#state = "idle";
			if (error instanceof Error && error.name === "UnsupportedProtocolError") this.owner.markUnsupported();
			else this.owner.recordFailure(true);
			if (this.owner.useLegacy()) this.#handOffToLegacy();
			else if (this.owner.connection.status !== "open")
				this.close(new DirectMessageSendError("DIRECT_CONNECTION_CLOSED", "Direct-message connection closed"));
			// A transient failure reopens at once; the failure budget above bounds the retries.
			else this.#pump();
			return;
		}
		this.#opening = undefined;
		if (this.#closed !== undefined) {
			stream.abort(this.#closed);
			return;
		}
		this.owner.recordOpened();
		this.#stream = stream;
		this.#lp = lpStream(stream, {
			maxDataLength: CREDIT_MAX_BYTES,
			lengthDecoder: boundedLengthDecoder(varintLength(CREDIT_MAX_BYTES)),
		});
		this.#creditFrames = this.#limits.windowFrames;
		this.#creditBytes = this.#limits.windowBytes;
		this.#state = "open";
		void this.#readCredit(stream, this.#lp);
		this.#pump();
	}

	#handOffToLegacy(): void {
		const waiting = this.#queue.splice(0);
		this.#queuedBytes = 0;
		for (const pending of waiting) this.owner.legacy.enqueue(pending);
	}

	async #readCredit(stream: Stream, lp: ReturnType<typeof lpStream>): Promise<void> {
		try {
			for (;;) {
				const credit = decodeCredit((await lp.read()).subarray());
				this.#creditFrames = Math.min(this.#limits.windowFrames, this.#creditFrames + credit.frames);
				this.#creditBytes = Math.min(this.#limits.windowBytes, this.#creditBytes + credit.bytes);
				this.#pump();
			}
		} catch (error) {
			this.#lost(stream, error);
		}
	}

	async #write(pending: Pending): Promise<void> {
		const stream = this.#stream;
		const lp = this.#lp;
		if (stream === undefined || lp === undefined) return;
		this.#queue.shift();
		this.#queuedBytes -= pending.bytes.byteLength;
		pending.started = true;
		pending.cancel = undefined;
		this.#creditFrames -= 1;
		this.#creditBytes -= pending.bytes.byteLength;
		this.#writing = true;
		pending.onWriteStart?.();
		try {
			await lp.write(pending.bytes);
			settle(pending, pending.signal?.aborted === true ? pending.signal.reason : undefined);
		} catch (cause) {
			settle(
				pending,
				pending.signal?.aborted === true
					? pending.signal.reason
					: new DirectMessageSendError("DIRECT_SESSION_RESET", "The direct-message session reset during a write", {
							cause,
						})
			);
			this.#lost(stream, cause);
		} finally {
			this.#writing = false;
			this.#pump();
		}
	}

	/** The stream ended (reset, abort, close, malformed credit): reopen for the frames still waiting. */
	#lost(stream: Stream, cause: unknown): void {
		if (this.#stream !== stream) return;
		this.#stream = undefined;
		this.#lp = undefined;
		if (isOpen(stream)) stream.abort(cause instanceof Error ? cause : new Error(String(cause)));
		if (this.#closed !== undefined) return;
		this.#state = "idle";
		this.owner.recordFailure(false);
		if (this.owner.useLegacy()) this.#handOffToLegacy();
		else this.#pump();
	}

	close(error: DirectMessageSendError): void {
		if (this.#closed !== undefined) return;
		this.#closed = error;
		this.#state = "closed";
		this.#opening?.abort(error);
		this.#opening = undefined;
		for (const pending of this.#queue.splice(0)) settle(pending, error);
		this.#queuedBytes = 0;
		const stream = this.#stream;
		this.#stream = undefined;
		this.#lp = undefined;
		if (stream !== undefined && isOpen(stream)) stream.abort(error);
	}
}

/** The legacy protocol: one frame per stream, at most LEGACY_MAX_CONCURRENT at once per connection. */
class LegacySender {
	readonly #queue: Pending[] = [];
	#queuedBytes = 0;
	#active = 0;
	readonly #streams = new Set<Stream>();
	readonly #opening = new Set<AbortController>();
	#closed?: DirectMessageSendError;

	constructor(private readonly connection: Connection) {}

	enqueue(pending: Pending): void {
		if (this.#closed !== undefined) return settle(pending, this.#closed);
		if (this.#queue.length >= LEGACY_QUEUE_FRAMES || this.#queuedBytes + pending.bytes.byteLength > LEGACY_QUEUE_BYTES) {
			return settle(pending, new DirectMessageSendError("DIRECT_SEND_QUEUE_FULL", "Direct-message legacy send queue is full"));
		}
		this.#queue.push(pending);
		this.#queuedBytes += pending.bytes.byteLength;
		pending.cancel = (): void => {
			const index = this.#queue.indexOf(pending);
			if (index < 0) return;
			this.#queue.splice(index, 1);
			this.#queuedBytes -= pending.bytes.byteLength;
		};
		this.#pump();
	}

	#pump(): void {
		while (this.#closed === undefined && this.#active < LEGACY_MAX_CONCURRENT) {
			const pending = this.#queue.shift();
			if (pending === undefined) return;
			this.#queuedBytes -= pending.bytes.byteLength;
			pending.started = true;
			pending.cancel = undefined;
			this.#active++;
			void this.#run(pending);
		}
	}

	async #run(pending: Pending): Promise<void> {
		let stream: Stream | undefined;
		const abort = (): void => {
			if (stream !== undefined && isOpen(stream))
				stream.abort(pending.signal?.reason instanceof Error ? pending.signal.reason : new Error("direct message send aborted"));
		};
		const opening = new AbortController();
		this.#opening.add(opening);
		try {
			try {
				stream = await this.connection.newStream(DRP_MESSAGE_PROTOCOL, {
					signal: AbortSignal.any([opening.signal, pending.signal ?? AbortSignal.timeout(SESSION_OPEN_DEADLINE_MS)]),
				});
			} finally {
				this.#opening.delete(opening);
			}
			this.#streams.add(stream);
			// Closed while negotiating: the frame was already out of the queue, so refuse it here.
			if (this.#closed !== undefined) {
				stream.abort(this.#closed);
				throw this.#closed;
			}
			pending.signal?.addEventListener("abort", abort, { once: true });
			pending.signal?.throwIfAborted();
			pending.onWriteStart?.();
			await uint8ArrayToStream(stream, pending.bytes);
			settle(pending);
		} catch (cause) {
			settle(
				pending,
				pending.signal?.aborted === true
					? pending.signal.reason
					: (this.#closed ??
							new DirectMessageSendError("DIRECT_LEGACY_SEND_FAILED", "Direct message legacy stream failed", { cause }))
			);
		} finally {
			pending.signal?.removeEventListener("abort", abort);
			// Release the slot only once the remote end closed too, so this sender never has more legacy
			// streams open than an old receiver's inbound limit counts.
			if (stream !== undefined) {
				await waitClosed(stream, LEGACY_CLOSE_DEADLINE_MS);
				this.#streams.delete(stream);
			}
			this.#active--;
			this.#pump();
		}
	}

	close(error: DirectMessageSendError): void {
		if (this.#closed !== undefined) return;
		this.#closed = error;
		for (const pending of this.#queue.splice(0)) settle(pending, error);
		this.#queuedBytes = 0;
		for (const opening of this.#opening) opening.abort(error);
		for (const stream of this.#streams) if (isOpen(stream)) stream.abort(error);
	}
}

export class DirectMessageSessions {
	readonly #connections = new Map<Connection, ConnectionDirect>();
	readonly #inbound = new Set<Stream>();
	#closed?: DirectMessageSendError;

	constructor(private readonly admit: DirectFrameAdmission) {}

	/**
	 * Send one encoded Message to the peer at the other end of a connection.
	 * @param connection - An open connection to the peer.
	 * @param bytes - The encoded Message (one frame).
	 * @param options - Abort signal, legacy-only (sync family), measurement hook.
	 * @returns Resolves when the frame was accepted by the stream; rejects with a typed error otherwise.
	 */
	send(connection: Connection, bytes: Uint8Array, options: DirectSendOptions = {}): Promise<void> {
		if (this.#closed !== undefined) return Promise.reject(this.#closed);
		if (bytes.byteLength > DIRECT_MESSAGE_MAX_FRAME_BYTES) {
			return Promise.reject(
				new DirectMessageSendError(
					"DIRECT_FRAME_TOO_LARGE",
					`Direct message is ${bytes.byteLength} bytes, above ${DIRECT_MESSAGE_MAX_FRAME_BYTES}`
				)
			);
		}
		const signal = options.signal;
		if (signal?.aborted === true) return Promise.reject(signal.reason);
		return new Promise<void>((resolve, reject) => {
			const pending: Pending = {
				bytes,
				signal,
				onWriteStart: options.onWriteStart,
				resolve,
				reject,
				started: false,
				settled: false,
			};
			if (signal !== undefined) {
				const onAbort = (): void => {
					if (pending.started) return;
					pending.cancel?.();
					settle(pending, signal.reason);
				};
				signal.addEventListener("abort", onAbort, { once: true });
				pending.detachAbort = (): void => signal.removeEventListener("abort", onAbort);
			}
			let direct = this.#connections.get(connection);
			if (direct === undefined) {
				direct = new ConnectionDirect(connection, (closed) => {
					if (this.#connections.get(closed.connection) === closed) this.#connections.delete(closed.connection);
				});
				this.#connections.set(connection, direct);
			}
			direct.send(pending, options.legacyOnly === true);
		});
	}

	/**
	 * Serve one inbound session stream: read frames, admit each to the message queue in order, and grant
	 * credit back as each is admitted. Anything malformed, oversized or refused resets the stream.
	 * @param stream - The negotiated inbound session stream.
	 * @param connection - Its connection (the authenticated remote peer).
	 * @param cls - The traffic class the negotiated protocol names.
	 */
	async serve(stream: Stream, connection: Connection, cls: DirectSessionClass): Promise<void> {
		if (this.#closed !== undefined) {
			stream.abort(this.#closed);
			return;
		}
		const limits = DIRECT_SESSION_LIMITS[cls];
		const sender = connection.remotePeer.toString();
		const lp = lpStream(stream, {
			maxDataLength: limits.maxFrameBytes,
			lengthDecoder: boundedLengthDecoder(varintLength(limits.maxFrameBytes)),
			maxBufferSize: limits.windowBytes + limits.windowFrames * DIRECT_MESSAGE_MAX_PREFIX_BYTES,
		});
		this.#inbound.add(stream);
		let grantFrames = 0;
		let grantBytes = 0;
		let grants = Promise.resolve();
		const grant = (bytes: number): void => {
			const first = grantFrames === 0;
			grantFrames++;
			grantBytes += bytes;
			if (!first) return;
			grants = grants.then(async () => {
				const frames = grantFrames;
				const granted = grantBytes;
				grantFrames = 0;
				grantBytes = 0;
				if (isOpen(stream)) await lp.write(encodeCredit(frames, granted));
			});
			grants.catch(() => undefined);
		};
		try {
			for (;;) {
				let frame: Uint8Array;
				try {
					frame = (await lp.read()).subarray();
				} catch (error) {
					if (error instanceof Error && error.name === "UnexpectedEOFError") break;
					throw error;
				}
				await this.admit(frame, sender, stream.protocol);
				grant(frame.byteLength);
			}
			await grants.catch(() => undefined);
			if (isOpen(stream)) await stream.close();
		} catch (error) {
			if (isOpen(stream) || stream.status === "closing") stream.abort(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.#inbound.delete(stream);
		}
	}

	/** Node stop: everything queued is rejected and every session stream is aborted. */
	closeAll(): void {
		if (this.#closed !== undefined) return;
		this.#closed = new DirectMessageSendError("DIRECT_SESSIONS_CLOSED", "Direct-message sessions are closed");
		for (const direct of [...this.#connections.values()]) direct.close(this.#closed);
		this.#connections.clear();
		for (const stream of this.#inbound) if (isOpen(stream)) stream.abort(this.#closed);
		this.#inbound.clear();
	}
}
