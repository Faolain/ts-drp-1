// Direct (peer-to-peer, non-gossip) message wire constants, owned by DirectMessageSessions
// (direct-sessions.ts). Track 46: docs/realtime-latency/tracks/46-network-stream-reuse.
//
// A direct message is one encoded `Message`, carried as one varint-length-prefixed frame:
// - on a long-lived session stream per (connection, traffic class) between peers that both speak a
//   session protocol below; or
// - on the legacy protocol, one frame per stream, for peers that do not (G25: both ids stay handled,
//   so old and new code interoperate in both directions).
//
// The session window is fixed by the protocol version: a receiver may hold at most `windowFrames`
// frames and `windowBytes` frame-body bytes that it has not yet admitted to its message queue, and the
// sender never exceeds that without a credit grant. Changing a window number is a new protocol id.

/** Legacy: one frame per stream (also the negotiated sync fallback; see sync.ts). */
export { DRP_MESSAGE_PROTOCOL } from "./sync.js";

/** Realtime class: frames of at most `DIRECT_SESSION_LIMITS.rt.maxFrameBytes` (moves, room control). */
export const DRP_MESSAGE_SESSION_RT_PROTOCOL = "/drp/message/1.0.0/session/rt";
/** Bulk class: larger frames (successor offers, large replay rows). */
export const DRP_MESSAGE_SESSION_BULK_PROTOCOL = "/drp/message/1.0.0/session/bulk";

export type DirectSessionClass = "rt" | "bulk";

export interface DirectSessionLimits {
	/** Largest frame body this class carries; the receiver refuses (resets) anything larger. */
	readonly maxFrameBytes: number;
	/** Receiver-held, not-yet-admitted frames the sender may have outstanding (protocol-fixed). */
	readonly windowFrames: number;
	/** Receiver-held, not-yet-admitted frame-body bytes the sender may have outstanding (protocol-fixed). */
	readonly windowBytes: number;
	/** Sender-side frames waiting for credit or for the frame ahead of them. */
	readonly queueFrames: number;
	/** Sender-side bytes waiting for credit or for the frame ahead of them. */
	readonly queueBytes: number;
}

const MIB = 1024 * 1024;

/** The largest frame any direct message protocol carries (stream.ts MAX_FRAME_BYTES). */
export const DIRECT_MESSAGE_MAX_FRAME_BYTES = 4 * MIB;
/** A frame-length prefix is a varint of at most four bytes for frames up to 4 MiB. */
export const DIRECT_MESSAGE_MAX_PREFIX_BYTES = 4;

export const DIRECT_SESSION_LIMITS: Readonly<Record<DirectSessionClass, DirectSessionLimits>> = Object.freeze({
	rt: Object.freeze({
		maxFrameBytes: 16 * 1024,
		windowFrames: 32,
		windowBytes: 256 * 1024,
		queueFrames: 64,
		queueBytes: 512 * 1024,
	}),
	bulk: Object.freeze({
		maxFrameBytes: DIRECT_MESSAGE_MAX_FRAME_BYTES,
		windowFrames: 2,
		windowBytes: DIRECT_MESSAGE_MAX_FRAME_BYTES,
		queueFrames: 4,
		queueBytes: 8 * MIB,
	}),
});

export const DIRECT_SESSION_PROTOCOLS: Readonly<Record<DirectSessionClass, string>> = Object.freeze({
	rt: DRP_MESSAGE_SESSION_RT_PROTOCOL,
	bulk: DRP_MESSAGE_SESSION_BULK_PROTOCOL,
});

/**
 * Inbound session streams per class per connection. One is the steady state; the second covers the
 * moment a sender reopens after a reset before this end has seen the old stream close.
 */
export const DIRECT_SESSION_MAX_STREAMS = 2;

/**
 * Legacy protocol bounds. Each inbound legacy stream may buffer one whole 4 MiB frame, so the
 * per-connection inbound bound stays where the shared sync registration had it (3 streams, 12 MiB):
 * raising it would raise worst-case buffered bytes per connection. A new sender never needs more:
 * it holds at most `LEGACY_MAX_CONCURRENT` legacy streams per connection, released only once the
 * stream is closed at both ends, and queues the rest within `LEGACY_QUEUE_*`. That leaves one of an
 * old receiver's three streams for the negotiated sync fallback, which shares this protocol id there.
 */
export const LEGACY_MAX_INBOUND_STREAMS = 3;
export const LEGACY_MAX_OUTBOUND_STREAMS = 3;
export const LEGACY_MAX_CONCURRENT = 2;
export const LEGACY_QUEUE_FRAMES = 64;
export const LEGACY_QUEUE_BYTES = 8 * MIB;

/**
 * Opening a session: one negotiation deadline, and the reopen budget after which a connection uses
 * the legacy protocol for a while instead of reopening again.
 */
export const SESSION_OPEN_DEADLINE_MS = 10_000;
export const SESSION_FAILURE_WINDOW_MS = 10_000;
export const SESSION_FAILURES_BEFORE_LEGACY = 3;
export const SESSION_LEGACY_COOLDOWN_MS = 30_000;
/** How long a legacy sender waits for the remote end to close before releasing its slot anyway. */
export const LEGACY_CLOSE_DEADLINE_MS = 10_000;

/**
 * Whether an authenticated stream protocol carries direct messages (session or legacy). Sync-family
 * protocols that are not also the legacy id (heads-chunk) are not direct-message protocols.
 * @param protocol - The negotiated protocol recorded in ingress evidence.
 * @returns True for the legacy id and both session ids.
 */
export function isDirectMessageProtocol(protocol: string): boolean {
	return (
		protocol === "/drp/message/0.0.1" ||
		protocol === DRP_MESSAGE_SESSION_RT_PROTOCOL ||
		protocol === DRP_MESSAGE_SESSION_BULK_PROTOCOL
	);
}

export type DirectMessageSendErrorCode =
	| "DIRECT_DIAL_FAILED"
	| "DIRECT_FRAME_TOO_LARGE"
	| "DIRECT_SEND_QUEUE_FULL"
	| "DIRECT_CONNECTION_CLOSED"
	| "DIRECT_SESSION_RESET"
	| "DIRECT_LEGACY_SEND_FAILED"
	| "DIRECT_SESSIONS_CLOSED";

/** A direct message that was not handed to the transport (or whose write failed part-way). */
export class DirectMessageSendError extends Error {
	readonly code: DirectMessageSendErrorCode;

	constructor(code: DirectMessageSendErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DirectMessageSendError";
		this.code = code;
	}
}
