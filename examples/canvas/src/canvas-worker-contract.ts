/**
 * The Canvas room's room worker contract (the default: the room runs in a dedicated worker;
 * `?mainThread` opts out). The only code the page and the worker share; it must stay light: no room,
 * node or network imports.
 */
import { call, defineRoomWorkerContract, latest } from "@ts-drp/room-worker";
import type { RoomWorkerRtcStats } from "@ts-drp/room-worker/worker";

import type { CanvasNetworkView, CanvasView } from "./canvas-room";

export const CANVAS_WORKER_CONTRACT = defineRoomWorkerContract({
	name: "ts-drp/canvas-room",
	version: 1,
	commands: {
		open: call(),
		paint: call(),
		view: call(),
		close: call(),
		session: call(),
		rtcStats: call(),
	},
	// The canvas (projection) and the peer panel are frame-paced; the session summary changes rarely.
	streams: { canvas: latest(), network: latest(), session: latest() },
	hooks: ["roomHeadAuthorityForOpen", "approveSettlementSourceSelection", "publishSuccessor"],
});

/** What the page sends the worker when it opens the room there. */
export interface CanvasWorkerInit {
	/** The page's identity seed (acquireBrowserIdentity); the worker derives the signing key. */
	readonly seed: string;
	/** The page's origin (the network config resolves fixture endpoints against it). */
	readonly origin: string;
}

/**
 * The session summary the worker streams when it changes: what the page's `__TS_DRP_CANVAS_SESSION__`
 * snapshot answers synchronously. The whole diagnostics (with the control-plane event log) are the
 * `session` call.
 */
export interface CanvasWorkerSessionSummary {
	readonly peerId: string;
	readonly relayReservations: readonly unknown[];
}

/** The network stream: the peer panel and the node's dialability. */
export interface CanvasWorkerNetwork extends CanvasNetworkView {
	readonly dialable: boolean;
}

/** The worker's ready info. */
export interface CanvasWorkerReady {
	readonly peerId: string;
	readonly view: CanvasView;
	readonly session: CanvasWorkerSessionSummary;
}

/** The contract's commands, typed as the worker implements them. */
export interface CanvasWorkerCommands {
	[name: string]: (...args: never[]) => unknown;
	open(operation: "create" | "join", invite: string): Promise<CanvasView>;
	paint(x: number, y: number, rgb: readonly [number, number, number]): Promise<void>;
	view(): CanvasView;
	close(): Promise<void>;
	session(): object;
	rtcStats(): RoomWorkerRtcStats;
}
