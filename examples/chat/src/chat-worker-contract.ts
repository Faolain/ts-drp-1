/**
 * The Chat room's room worker contract (the default: the room runs in a dedicated worker;
 * `?mainThread` opts out). The only code the page and the worker share; it must stay light: no room,
 * node or network imports.
 */
import { call, defineRoomWorkerContract, latest } from "@ts-drp/room-worker";
import type { RoomWorkerRtcStats } from "@ts-drp/room-worker/worker";

import type { ChatNetworkView, ChatOpenRole, ChatSendOutcome, ChatStatusState, ChatView } from "./chat-room";

export const CHAT_WORKER_CONTRACT = defineRoomWorkerContract({
	name: "ts-drp/chat-room",
	version: 1,
	commands: {
		open: call(),
		send: call(),
		changeWriter: call(),
		close: call(),
		session: call(),
		rtcStats: call(),
	},
	// The chat view (projection) and the peer panel are frame-paced; the session summary changes rarely.
	// The status line shows only the newest status, so the newest is the one that matters; a call's
	// result reaches the page after every status the worker emitted before it (the bridge flushes
	// pending stream values before a result), so a status the page sets on a result is never
	// overwritten by an older one.
	streams: { chat: latest(), network: latest(), session: latest(), status: latest({ pace: "message" }) },
	hooks: [
		"roomHeadAuthorityForOpen",
		"approveSettlementSourceSelection",
		"publishSuccessor",
		"readWriterReplica",
		"markWriterReplica",
	],
});

/** What the page sends the worker when it opens the room there. */
export interface ChatWorkerInit {
	/** The page's identity seed (acquireBrowserIdentity); the worker derives the signing key. */
	readonly seed: string;
	/** The page's origin (the network config resolves fixture endpoints against it). */
	readonly origin: string;
}

/**
 * The session summary the worker streams when it changes: what the page's `__TS_DRP_CHAT_SESSION__`
 * snapshot answers synchronously. The whole diagnostics (with the control-plane event log) are the
 * `session` call.
 */
export interface ChatWorkerSessionSummary {
	readonly peerId: string;
	readonly relayReservations: readonly unknown[];
}

/** The network stream: the peer panel and the node's dialability. */
export interface ChatWorkerNetwork extends ChatNetworkView {
	readonly dialable: boolean;
}

/** The status stream. */
export interface ChatWorkerStatus {
	readonly message: string;
	readonly state: ChatStatusState;
}

/** The worker's ready info. */
export interface ChatWorkerReady {
	readonly peerId: string;
	readonly view: ChatView;
	readonly session: ChatWorkerSessionSummary;
}

/** The contract's commands, typed as the worker implements them. */
export interface ChatWorkerCommands {
	[name: string]: (...args: never[]) => unknown;
	open(operation: "create" | "join", invite: string): Promise<Readonly<{ view: ChatView; role: ChatOpenRole }>>;
	send(text: string): Promise<ChatSendOutcome>;
	changeWriter(kind: "grant" | "revoke", target: string): Promise<boolean>;
	close(): Promise<void>;
	session(): object;
	rtcStats(): RoomWorkerRtcStats;
}
