/**
 * The Grid page with its zone hosted in a room worker (opt-in: `?roomWorker`).
 *
 * The page keeps rendering, input and identity; the worker (zone-worker.ts) runs the node and the
 * room. `window.__TS_DRP_V3_ZONE__` has the main-thread zone's methods with two differences:
 * `snapshot()` returns the zone the worker last published (after any call resolves, it includes
 * that call's effects), with `refresh()` to ask for the current one, and `fabric.snapshot` is async.
 *
 * Crash ambiguity (the package README's rule, applied to Grid): a call in flight when the worker
 * dies rejects with RoomWorkerCrashed, and the room may already hold its effect. After reopen, a
 * placement is resolved by its block id: in the zone's blocks it landed, else it is offered again
 * (recoverBlockPlacement).
 */
import { acquireBrowserIdentity } from "@ts-drp/example-browser-network";
import {
	createV3RoomWorkerReservations,
	forwardV3RoomWorkerObservation,
	V3_ROOM_WORKER_ERROR_CODECS,
	V3RoomNotReachingHost,
	V3RoomReadOnly,
	V3RoomSuccessorUnavailable,
	v3RoomWorkerPeerCacheKeys,
} from "@ts-drp/example-v3-room";
import { RoomWorkerUnsupported } from "@ts-drp/room-worker";
import {
	openRoomWorker,
	type RoomWorkerHandle,
	type RoomWorkerMeter,
	type RoomWorkerSendRefusal,
} from "@ts-drp/room-worker/page";
import type { RoomWorkerRtcStats } from "@ts-drp/room-worker/worker";

import { bindControls } from "./controls";
import { env } from "./env";
import { getNetworkConfigFromEnv } from "./network-config";
import { createZonePresentation, enableUIControls, renderNetworkInfo } from "./render";
import type {
	V3ZoneApi,
	V3ZoneRoomHeadAuthorityForOpen,
	V3ZoneSettlementSourceApproval,
	V3ZoneSuccessorPublisher,
	ZoneBlock,
	ZoneFabricWorkbench,
	ZoneSnapshot,
	ZoneTransientSnapshot,
} from "./v3-zone";
import {
	ZONE_WORKER_CONTRACT,
	type ZoneWorkerCommands,
	type ZoneWorkerInit,
	type ZoneWorkerNetwork,
	type ZoneWorkerReady,
	type ZoneWorkerSessionSnapshot,
} from "./zone-worker-contract";

/** The zone's page API when the zone runs in a room worker. */
export interface V3ZoneWorkerApi extends Omit<V3ZoneApi, "fabric"> {
	readonly fabric: Readonly<{
		reset: ZoneFabricWorkbench["reset"];
		runTrial: ZoneFabricWorkbench["runTrial"];
		snapshot(trialId: string): Promise<ReturnType<ZoneFabricWorkbench["snapshot"]>>;
	}>;
	/** The zone as the worker holds it now (snapshot() is the last one it published). */
	refresh(): Promise<ZoneSnapshot>;
}

/** The page's control of the worker itself (tests and the FPS harness). */
export interface GridRoomWorkerControl {
	/** Stops the worker now; calls in flight reject with RoomWorkerCrashed. */
	terminate(reason?: string): void;
	/** Opens a new worker for this page's identity; the zone is then closed until create or join. */
	reopen(): Promise<void>;
	rtcStats(): Promise<RoomWorkerRtcStats>;
	/**
	 * Listens to a stream of the current worker, in order with the page's own listeners (they run
	 * first). A listener may terminate the worker: the messages after it are not handled.
	 */
	observe(stream: "projection" | "transient" | "network", listener: (value: unknown) => void): () => void;
	/** recoverBlockPlacement on this page's zone (reopen first). */
	recoverBlockPlacement(block: ZoneBlock): Promise<BlockPlacementRecovery>;
	/** The worker's send refusals, newest last (bounded). */
	readonly refusals: readonly Readonly<{ id: number; command: string; name: string; message: string }>[];
}

/**
 * One message kind's share of the library cost: its handlings and posts, and what it spent in frames
 * whose library cost exceeded half a millisecond.
 */
export interface GridRoomWorkerMeterKind {
	readonly count: number;
	readonly totalMs: number;
	readonly maxMs: number;
	readonly heavyFrames: number;
	readonly heavyMs: number;
}

/** Per-frame main-thread cost of the bridge (library) and of Grid's DOM rendering (app). */
export interface GridRoomWorkerMeter {
	read(): Readonly<{
		library: readonly number[];
		render: readonly number[];
		dropped: number;
		kinds: Readonly<Record<string, GridRoomWorkerMeterKind>>;
	}>;
	reset(): void;
}

declare global {
	interface Window {
		__TS_DRP_GRID_ROOM_WORKER__?: GridRoomWorkerControl;
		__TS_DRP_GRID_ROOM_WORKER_METER__?: GridRoomWorkerMeter;
	}
}

const REFUSAL_LIMIT = 64;
const METER_FRAME_LIMIT = 100_000;

/**
 * How a recovered placement was resolved: it had already landed (not offered again), it was offered
 * again and accepted, or it was offered again and the room kept it (a member that does not reach its
 * creator yet: the room offers it itself once it can, so the app must not offer it a third time).
 */
export type BlockPlacementRecovery = "landed" | "offered" | "kept";

/**
 * Recover a placement whose call ended without an answer (the worker crashed): reopen and rejoin
 * first, then call this. The reopened room's durable projection includes every move this author's
 * room admitted, delivered or not, so a block already there landed and is not offered again;
 * otherwise it is offered once.
 * @param zone - The reopened zone.
 * @param block - The placement whose outcome is unknown.
 * @returns How the placement was resolved.
 */
export async function recoverBlockPlacement(zone: V3ZoneWorkerApi, block: ZoneBlock): Promise<BlockPlacementRecovery> {
	const current = await zone.refresh();
	if (current.blocks.some((placed) => placed.id === block.id)) return "landed";
	try {
		await zone.placeBlock(block);
		return "offered";
	} catch (error) {
		// Typed room refusals cross the worker boundary as their own classes.
		if (
			error instanceof V3RoomReadOnly ||
			error instanceof V3RoomSuccessorUnavailable ||
			error instanceof V3RoomNotReachingHost
		)
			return "kept";
		throw error;
	}
}

interface BridgeMeter extends RoomWorkerMeter {
	readonly control: GridRoomWorkerMeter;
	/** Runs Grid's rendering, counted as app cost. */
	render(draw: () => void): void;
	/** Wraps a frame callback whose work is Grid's rendering. */
	renderFrame(callback: FrameRequestCallback): FrameRequestCallback;
}

/**
 * The bridge meter (`?roomWorkerMeter`): each page frame's worker-message handling and posts, less
 * the Grid rendering they ran, is the library's cost; Grid's rendering (projection, network panel,
 * the transient frame) is the app's. Totals are exact; a cost lands in the frame its handler ran.
 */
function createBridgeMeter(): BridgeMeter {
	let library = 0;
	let render = 0;
	// Grid rendering run by the worker message being handled (its listeners render synchronously).
	let renderInMessage = 0;
	let dropped = 0;
	const libraryFrames: number[] = [];
	const renderFrames: number[] = [];
	type Kind = { count: number; totalMs: number; maxMs: number; heavyFrames: number; heavyMs: number };
	const kinds = new Map<string, Kind>();
	const frameKinds = new Map<string, number>();
	const charge = (kind: string, ms: number): void => {
		library += ms;
		let entry = kinds.get(kind);
		if (entry === undefined) {
			entry = { count: 0, totalMs: 0, maxMs: 0, heavyFrames: 0, heavyMs: 0 };
			kinds.set(kind, entry);
		}
		entry.count++;
		entry.totalMs += ms;
		entry.maxMs = Math.max(entry.maxMs, ms);
		frameKinds.set(kind, (frameKinds.get(kind) ?? 0) + ms);
	};
	const tick = (): void => {
		if (libraryFrames.length < METER_FRAME_LIMIT) {
			libraryFrames.push(library);
			renderFrames.push(render);
		} else dropped++;
		if (library > 0.5)
			for (const [kind, ms] of frameKinds) {
				const entry = kinds.get(kind);
				if (entry === undefined) continue;
				entry.heavyFrames++;
				entry.heavyMs += ms;
			}
		frameKinds.clear();
		library = 0;
		render = 0;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	const timed = (draw: () => void): number => {
		const started = performance.now();
		let spent = 0;
		try {
			draw();
		} finally {
			spent = performance.now() - started;
			render += spent;
		}
		return spent;
	};
	const meter: BridgeMeter = {
		message(kind, ms) {
			charge(kind, Math.max(0, ms - renderInMessage));
			renderInMessage = 0;
		},
		post(kind, ms) {
			charge(`post:${kind}`, ms);
		},
		render(draw) {
			renderInMessage += timed(draw);
		},
		renderFrame: (callback) => (time) => void timed(() => callback(time)),
		control: {
			read: () => ({
				library: [...libraryFrames],
				render: [...renderFrames],
				dropped,
				kinds: Object.fromEntries([...kinds].map(([kind, entry]) => [kind, { ...entry }])),
			}),
			reset: () => {
				libraryFrames.length = 0;
				renderFrames.length = 0;
				kinds.clear();
				frameKinds.clear();
				dropped = 0;
			},
		},
	};
	return meter;
}

interface OpenedZoneWorker {
	readonly handle: RoomWorkerHandle<ZoneWorkerCommands>;
	readonly ready: ZoneWorkerReady;
}

/**
 * Open the Grid zone in a room worker: the worker page (`?roomWorker`), with the main-thread page
 * as its fallback when this browser cannot host the room in a worker.
 * @param fallback - Opens the zone on the main thread (main-thread.ts's main).
 */
export async function mainWithRoomWorker(fallback: () => Promise<void>): Promise<void> {
	const identity = await acquireBrowserIdentity({
		lockPrefix: "ts-drp:grid:v3-zone:identity-slot",
		seedKey: "ts-drp:grid:v3-zone:identity-seed",
	});
	const target = window as typeof window & {
		__TS_DRP_GRID_SESSION__?: Readonly<{
			node: undefined;
			/** The session diagnostics, read from the worker on demand. */
			snapshot(): Promise<ZoneWorkerSessionSnapshot>;
			stop(): Promise<void>;
		}>;
		__TS_DRP_V3_ZONE__?: V3ZoneWorkerApi;
	};
	const params = new URLSearchParams(window.location.search);
	const meter = params.has("roomWorkerMeter") ? createBridgeMeter() : undefined;
	const render = meter === undefined ? (draw: () => void): void => draw() : meter.render;
	const presentation = createZonePresentation(
		meter === undefined
			? (callback): number => requestAnimationFrame(callback)
			: (callback): number => requestAnimationFrame(meter.renderFrame(callback))
	);
	const config = getNetworkConfigFromEnv(env, window.location.origin);
	const init: ZoneWorkerInit = { seed: identity.seed, origin: window.location.origin };
	const refusals: { id: number; command: string; name: string; message: string }[] = [];
	const onDiagnostic = forwardV3RoomWorkerObservation();

	let current: OpenedZoneWorker | undefined;
	let snapshot: ZoneSnapshot | undefined;
	let transient: ZoneTransientSnapshot | undefined;
	let controlsEnabled = false;

	// The native read reservations the worker holds through the page's authority: released when the
	// worker stops, as a dead process's native locks are.
	const reservations = createV3RoomWorkerReservations();
	const hooks: Record<string, (...args: never[]) => unknown> = {
		roomHeadAuthorityForOpen: reservations.wrap((context: Parameters<V3ZoneRoomHeadAuthorityForOpen>[0]) => {
			const factory = window.__TS_DRP_GRID_ROOM_HEAD_AUTHORITY_FOR_OPEN__;
			if (typeof factory !== "function")
				throw new TypeError(
					"v3 zone room-head authority is unavailable: the application host must configure its factory"
				);
			return factory(context);
		}),
	};
	const approve: V3ZoneSettlementSourceApproval | undefined = window.__TS_DRP_GRID_SETTLEMENT_SOURCE_APPROVAL__;
	if (approve !== undefined) hooks.approveSettlementSourceSelection = approve;
	const publish: V3ZoneSuccessorPublisher | undefined = window.__TS_DRP_GRID_SUCCESSOR_PUBLISHER__;
	if (publish !== undefined) hooks.publishSuccessor = publish;

	const open = async (): Promise<OpenedZoneWorker> => {
		const handle = openRoomWorker<ZoneWorkerCommands>({
			spawn: () => new Worker(new URL("./zone-worker.ts", import.meta.url), { type: "module", name: "grid-zone" }),
			contract: ZONE_WORKER_CONTRACT,
			init,
			hooks,
			errors: V3_ROOM_WORKER_ERROR_CODECS,
			localStorageKeys: v3RoomWorkerPeerCacheKeys(config),
			...(meter === undefined ? {} : { meter }),
			...(onDiagnostic === undefined ? {} : { onDiagnostic }),
		});
		handle.on("projection", (value) => {
			const next = value as ZoneSnapshot;
			snapshot = next;
			transient = undefined;
			render(() => presentation.projection(next));
		});
		handle.on("transient", (value) => {
			const next = value as ZoneTransientSnapshot;
			transient = next;
			render(() => presentation.transient(next));
		});
		handle.on("network", (value) => {
			const next = value as ZoneWorkerNetwork;
			render(() => renderNetworkInfo(next));
			if (next.dialable && !controlsEnabled) {
				controlsEnabled = true;
				enableUIControls();
			}
		});
		handle.onRefused((refusal: RoomWorkerSendRefusal) => {
			if (refusals.length === REFUSAL_LIMIT) refusals.shift();
			refusals.push({
				id: refusal.id,
				command: refusal.command,
				name: refusal.error.name,
				message: refusal.error.message,
			});
			console.error(`room worker refused ${refusal.command} #${refusal.id}`, refusal.error);
		});
		handle.onCrash((error) => {
			console.error("Grid room worker stopped", error);
			void reservations.releaseAll();
		});
		const ready = (await handle.ready) as ZoneWorkerReady;
		snapshot = ready.snapshot;
		transient = undefined;
		render(() => presentation.projection(ready.snapshot));
		return { handle, ready };
	};

	const worker = (): RoomWorkerHandle<ZoneWorkerCommands> => {
		if (current === undefined) throw new TypeError("v3 zone room worker is not open");
		return current.handle;
	};
	const call: RoomWorkerHandle<ZoneWorkerCommands>["call"] = (name, ...args) => worker().call(name, ...args);
	const currentSnapshot = (): ZoneSnapshot => {
		if (snapshot === undefined) throw new TypeError("v3 zone room worker is not open");
		// The newest transient positions of the same zone, over the last durable projection.
		return transient === undefined || transient.zoneId !== snapshot.zoneId
			? snapshot
			: { ...snapshot, transientPositions: transient.transientPositions };
	};

	const zone: V3ZoneWorkerApi = Object.freeze({
		move(dx: number, dy: number): void {
			// As the main-thread zone: no move until the zone is open. Bad steps throw here.
			if (current === undefined || snapshot?.ready !== true) return;
			current.handle.send("move", dx, dy);
		},
		snapshot: currentSnapshot,
		refresh: async (): Promise<ZoneSnapshot> => {
			snapshot = await call("snapshot");
			transient = undefined;
			return snapshot;
		},
		create: (enrollments: string | readonly string[]) => call("create", enrollments),
		join: (invite: string) => call("join", invite),
		close: () => call("close"),
		placeBlock: (block: ZoneBlock) => call("placeBlock", block),
		sealEpoch: () => call("sealEpoch"),
		exportCreatorSuccessor: () => call("exportCreatorSuccessor"),
		adoptCreatorSuccessor: () => call("adoptCreatorSuccessor"),
		installCreatorSuccessor: (request: Parameters<V3ZoneApi["installCreatorSuccessor"]>[0]) =>
			call("installCreatorSuccessor", request),
		rehearseMigration: () => call("rehearseMigration"),
		activateMigration: (receipt: Parameters<V3ZoneApi["activateMigration"]>[0]) => call("activateMigration", receipt),
		approveTradeIntent: (input: Parameters<V3ZoneApi["approveTradeIntent"]>[0]) => call("approveTradeIntent", input),
		prepareTradeIntent: (input: Parameters<V3ZoneApi["prepareTradeIntent"]>[0]) => call("prepareTradeIntent", input),
		finalizeTradeIntent: (input: Parameters<V3ZoneApi["finalizeTradeIntent"]>[0]) => call("finalizeTradeIntent", input),
		commitTradeIntent: (input: Parameters<V3ZoneApi["commitTradeIntent"]>[0]) => call("commitTradeIntent", input),
		publishAoiPopulation: (input: Parameters<V3ZoneApi["publishAoiPopulation"]>[0]) =>
			call("publishAoiPopulation", input),
		fabric: Object.freeze({
			reset: (trialId: string) => call("fabric.reset", trialId),
			runTrial: (input: Parameters<ZoneFabricWorkbench["runTrial"]>[0]) => call("fabric.runTrial", input),
			snapshot: (trialId: string) => call("fabric.snapshot", trialId),
		}),
	});

	const session = Object.freeze({
		node: undefined,
		// Asynchronous here: the diagnostics live in the worker and are read on demand.
		snapshot: (): Promise<ZoneWorkerSessionSnapshot> => call("session"),
		stop: (): Promise<void> => call("stop"),
	});
	let unloadHandler: (() => void) | undefined;
	try {
		try {
			current = await open();
		} catch (error) {
			if (!(error instanceof RoomWorkerUnsupported)) throw error;
			// This browser cannot host the room in a worker: the main-thread page, as without the option.
			console.warn("Grid room worker unsupported; opening the zone on the main thread", error.missing);
			presentation.close();
			identity.release();
			return await fallback();
		}
		target.__TS_DRP_GRID_SESSION__ = session;
		target.__TS_DRP_V3_ZONE__ = zone;
		window.__TS_DRP_GRID_ROOM_WORKER__ = Object.freeze({
			terminate: (reason?: string) => worker().terminate(reason),
			reopen: async (): Promise<void> => {
				current?.handle.terminate("reopened by the page");
				current = undefined;
				snapshot = undefined;
				transient = undefined;
				await reservations.releaseAll();
				current = await open();
			},
			rtcStats: () => call("rtcStats"),
			observe: (stream: "projection" | "transient" | "network", listener: (value: unknown) => void) =>
				worker().on(stream, listener),
			recoverBlockPlacement: (block: ZoneBlock) => recoverBlockPlacement(zone, block),
			refusals,
		});
		if (meter !== undefined) window.__TS_DRP_GRID_ROOM_WORKER_METER__ = meter.control;
		window.dispatchEvent(new CustomEvent("ts-drp:grid-ready", { detail: current.ready.session }));
		bindControls(zone);
		unloadHandler = (): void => {
			presentation.close();
			// The document owns the Web Lock until termination (as on the main thread). The worker's
			// close joins admitted work before its node stops.
			void current?.handle.close().catch((error: unknown) => console.error("Failed to close grid room worker", error));
		};
		window.addEventListener("beforeunload", unloadHandler, { once: true });
		console.log("Started v3 zone room worker", current.ready.peerId);
	} catch (error) {
		presentation.close();
		delete target.__TS_DRP_GRID_SESSION__;
		delete target.__TS_DRP_V3_ZONE__;
		delete window.__TS_DRP_GRID_ROOM_WORKER__;
		if (unloadHandler !== undefined) window.removeEventListener("beforeunload", unloadHandler);
		await current?.handle.close().catch(() => undefined);
		identity.release();
		throw error;
	}
}
