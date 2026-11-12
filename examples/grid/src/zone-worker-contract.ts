/**
 * The Grid zone's room worker contract (opt-in: `?roomWorker` hosts the zone in a dedicated worker).
 * The only code the page and the worker share: command names and kinds, the move validator, the
 * streams and the page hooks. It must stay light: no room, node or network imports.
 */
import { call, defineRoomWorkerContract, latest, send } from "@ts-drp/room-worker";
import type { RoomWorkerRtcStats } from "@ts-drp/room-worker/worker";

import type { NetworkInfo } from "./render";
import type { V3ZoneApi, ZoneFabricWorkbench, ZoneSnapshot } from "./v3-zone";

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/**
 * The page-side check of a move, as createV3ZoneApi's move() checks its step. The position bound
 * itself is checked in the worker (it knows the position); a refusal there reaches the page's
 * refusal listener with the move's correlation id.
 * @param dx - Horizontal step.
 * @param dy - Vertical step.
 */
export function validateZoneMove(dx: unknown, dy: unknown): void {
	if (
		!Number.isInteger(dx) ||
		!Number.isInteger(dy) ||
		(dx as number) < INT32_MIN ||
		(dx as number) > INT32_MAX ||
		(dy as number) < INT32_MIN ||
		(dy as number) > INT32_MAX
	)
		throw new TypeError("v3 zone movement is outside its integer range");
}

export const ZONE_WORKER_CONTRACT = defineRoomWorkerContract({
	name: "ts-drp/grid-zone",
	version: 2,
	commands: {
		"move": send(validateZoneMove),
		"snapshot": call(),
		"create": call(),
		"join": call(),
		"close": call(),
		"stop": call(),
		"placeBlock": call(),
		"sealEpoch": call(),
		"exportCreatorSuccessor": call(),
		"adoptCreatorSuccessor": call(),
		"installCreatorSuccessor": call(),
		"rehearseMigration": call(),
		"activateMigration": call(),
		"approveTradeIntent": call(),
		"prepareTradeIntent": call(),
		"finalizeTradeIntent": call(),
		"commitTradeIntent": call(),
		"publishAoiPopulation": call(),
		"fabric.reset": call(),
		"fabric.runTrial": call(),
		"fabric.snapshot": call(),
		"rtcStats": call(),
		"session": call(),
	},
	// Movement (transient) is message-paced: a remote move reaches the page one round trip after the
	// worker emits it, not a frame later. The projection and the network panel stay frame-paced.
	streams: { projection: latest(), transient: latest({ pace: "message" }), network: latest() },
	hooks: ["roomHeadAuthorityForOpen", "approveSettlementSourceSelection", "publishSuccessor"],
});

/** What the page sends the worker when it opens the zone there. */
export interface ZoneWorkerInit {
	/** The page's identity seed (acquireBrowserIdentity); the worker derives the signing key. */
	readonly seed: string;
	/** The page's origin (the network config resolves fixture endpoints against it). */
	readonly origin: string;
}

/** The network session's diagnostics (the modular session's snapshot, or the peer id alone). */
export type ZoneWorkerSessionSnapshot = Readonly<{ readonly peerId: string }> & Readonly<Record<string, unknown>>;

/** The worker's ready info. */
export interface ZoneWorkerReady {
	readonly peerId: string;
	readonly snapshot: ZoneSnapshot;
	readonly session: ZoneWorkerSessionSnapshot;
}

/**
 * The network stream: the page's network panel and the node's dialability, sent when they change. The
 * session diagnostics are not streamed: their control-plane event log grows for the session's life, so
 * the page reads them on demand with the `session` call, as the main-thread page does.
 */
export interface ZoneWorkerNetwork extends NetworkInfo {
	readonly dialable: boolean;
}

/**
 * Builds the network stream's value.
 * @param info - The network panel.
 * @param dialable - Whether the node is dialable.
 * @returns The stream value.
 */
export function zoneWorkerNetwork(info: NetworkInfo, dialable: boolean): ZoneWorkerNetwork {
	return { peerId: info.peerId, peers: info.peers, topics: info.topics, dialable };
}

/** The contract's commands, typed as the worker implements them. */
export interface ZoneWorkerCommands {
	[name: string]: (...args: never[]) => unknown;
	"move": V3ZoneApi["move"];
	"snapshot": V3ZoneApi["snapshot"];
	"create": V3ZoneApi["create"];
	"join": V3ZoneApi["join"];
	"close": V3ZoneApi["close"];
	"stop"(): Promise<void>;
	"placeBlock": V3ZoneApi["placeBlock"];
	"sealEpoch": V3ZoneApi["sealEpoch"];
	"exportCreatorSuccessor": V3ZoneApi["exportCreatorSuccessor"];
	"adoptCreatorSuccessor": V3ZoneApi["adoptCreatorSuccessor"];
	"installCreatorSuccessor": V3ZoneApi["installCreatorSuccessor"];
	"rehearseMigration": V3ZoneApi["rehearseMigration"];
	"activateMigration": V3ZoneApi["activateMigration"];
	"approveTradeIntent": V3ZoneApi["approveTradeIntent"];
	"prepareTradeIntent": V3ZoneApi["prepareTradeIntent"];
	"finalizeTradeIntent": V3ZoneApi["finalizeTradeIntent"];
	"commitTradeIntent": V3ZoneApi["commitTradeIntent"];
	"publishAoiPopulation": V3ZoneApi["publishAoiPopulation"];
	"fabric.reset": ZoneFabricWorkbench["reset"];
	"fabric.runTrial": ZoneFabricWorkbench["runTrial"];
	"fabric.snapshot": ZoneFabricWorkbench["snapshot"];
	"rtcStats"(): RoomWorkerRtcStats;
	"session"(): ZoneWorkerSessionSnapshot;
}
