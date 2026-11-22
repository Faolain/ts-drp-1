/**
 * The Canvas page with its room hosted in a room worker (the default; `?mainThread` opts out).
 *
 * The page keeps rendering, input and identity; the worker (canvas-worker.ts) runs the node and the
 * room. `window.__TS_DRP_CANVAS_SESSION__.snapshot()` answers the worker's last published session
 * summary (peer id, relay reservations); `diagnostics()` reads the whole session snapshot.
 *
 * Crash ambiguity (the package README's rule): a paint in flight when the worker dies rejects with
 * RoomWorkerCrashed and may have landed. A paint is one fresh intent per click with a random color,
 * never re-offered by the page, so a lost reply loses nothing but the status line.
 */
import {
	acquireBrowserIdentity,
	getNetworkConfigFromEnv,
	readBrowserNetworkEnv,
} from "@ts-drp/example-browser-network";
import {
	createV3RoomWorkerReservations,
	forwardV3RoomWorkerObservation,
	V3_ROOM_WORKER_ERROR_CODECS,
	v3RoomWorkerPeerCacheKeys,
} from "@ts-drp/example-v3-room";
import { RoomWorkerUnsupported } from "@ts-drp/room-worker";
import {
	createRoomWorkerFrameMeter,
	openRoomWorker,
	type RoomWorkerFrameMeterControl,
	type RoomWorkerHandle,
} from "@ts-drp/room-worker/page";
import type { RoomWorkerRtcStats } from "@ts-drp/room-worker/worker";

import { type CanvasPageRoom, connectionStatus, createCanvasPage } from "./canvas-page";
import type { CanvasHeadFactory, CanvasView } from "./canvas-room";
import {
	CANVAS_WORKER_CONTRACT,
	type CanvasWorkerCommands,
	type CanvasWorkerInit,
	type CanvasWorkerNetwork,
	type CanvasWorkerReady,
	type CanvasWorkerSessionSummary,
} from "./canvas-worker-contract";

/** The page's control of the worker itself (tests and the FPS harness). */
export interface CanvasRoomWorkerControl {
	/** Stops the worker now; calls in flight reject with RoomWorkerCrashed. */
	terminate(reason?: string): void;
	rtcStats(): Promise<RoomWorkerRtcStats>;
}

declare global {
	interface Window {
		__TS_DRP_CANVAS_ROOM_WORKER__?: CanvasRoomWorkerControl;
		__TS_DRP_CANVAS_ROOM_WORKER_METER__?: RoomWorkerFrameMeterControl;
	}
}

/**
 * Open the Canvas room in a room worker, with the main-thread page as its fallback when this browser
 * cannot host the room in a worker.
 * @param fallback - Opens the room on the main thread (canvas-main-thread.ts's main).
 */
export async function mainWithRoomWorker(fallback: () => Promise<void>): Promise<void> {
	const identity = await acquireBrowserIdentity({
		lockPrefix: "ts-drp:canvas:v3:identity-slot",
		seedKey: "ts-drp:canvas:v3:identity-seed",
	});
	const page = createCanvasPage();
	// The bridge meter (`?roomWorkerMeter`): per frame, the bridge's main-thread cost (library) and the
	// Canvas rendering it ran (app).
	const meter = new URLSearchParams(window.location.search).has("roomWorkerMeter")
		? createRoomWorkerFrameMeter()
		: undefined;
	const render = meter === undefined ? (draw: () => void): void => draw() : meter.render;
	const config = getNetworkConfigFromEnv(readBrowserNetworkEnv(import.meta.env), window.location.origin);
	const init: CanvasWorkerInit = { seed: identity.seed, origin: window.location.origin };
	const onDiagnostic = forwardV3RoomWorkerObservation();
	// The native read reservations the worker holds through the page's authority: released when the
	// worker stops, as a dead process's native locks are.
	const reservations = createV3RoomWorkerReservations();
	const hooks: Record<string, (...args: never[]) => unknown> = {
		roomHeadAuthorityForOpen: reservations.wrap((context: Parameters<CanvasHeadFactory>[0]) => {
			const factory = window.__TS_DRP_CANVAS_ROOM_HEAD_AUTHORITY_FOR_OPEN__;
			if (typeof factory !== "function")
				throw new TypeError(
					"canvas room-head authority is unavailable: the application host must configure its factory"
				);
			return factory(context);
		}),
	};
	const approve = window.__TS_DRP_CANVAS_SETTLEMENT_SOURCE_APPROVAL__;
	if (approve !== undefined) hooks.approveSettlementSourceSelection = approve;
	const publish = window.__TS_DRP_CANVAS_SUCCESSOR_PUBLISHER__;
	if (publish !== undefined) hooks.publishSuccessor = publish;

	let handle: RoomWorkerHandle<CanvasWorkerCommands> | undefined;
	let session: CanvasWorkerSessionSummary | undefined;
	const room: CanvasPageRoom = {
		open: (operation, invite) => (handle as RoomWorkerHandle<CanvasWorkerCommands>).call("open", operation, invite),
		paint: (x, y, rgb) => (handle as RoomWorkerHandle<CanvasWorkerCommands>).call("paint", x, y, rgb),
		close: () => (handle as RoomWorkerHandle<CanvasWorkerCommands>).call("close"),
	};
	let bound = false;
	const openWorker = async (): Promise<CanvasWorkerReady> => {
		const opening = openRoomWorker<CanvasWorkerCommands>({
			spawn: () => new Worker(new URL("./canvas-worker.ts", import.meta.url), { type: "module", name: "canvas-room" }),
			contract: CANVAS_WORKER_CONTRACT,
			init,
			hooks,
			errors: V3_ROOM_WORKER_ERROR_CODECS,
			localStorageKeys: v3RoomWorkerPeerCacheKeys(config),
			...(meter === undefined ? {} : { meter }),
			...(onDiagnostic === undefined ? {} : { onDiagnostic }),
		});
		handle = opening;
		opening.on("canvas", (value) => render(() => page.view(value as CanvasView)));
		opening.on("network", (value) => {
			const next = value as CanvasWorkerNetwork;
			render(() => page.network(next));
			if (next.dialable && !bound) {
				bound = true;
				render(() => page.bind(room));
			}
		});
		opening.on("session", (value) => {
			session = value as CanvasWorkerSessionSummary;
		});
		opening.onCrash((error) => {
			console.error("Canvas room worker stopped", error);
			connectionStatus("The canvas stopped. Reload the page to reopen it.", "error");
			void reservations.releaseAll();
		});
		return (await opening.ready) as CanvasWorkerReady;
	};
	let unloadHandler: (() => void) | undefined;
	try {
		let ready: CanvasWorkerReady;
		try {
			ready = await openWorker();
		} catch (error) {
			if (!(error instanceof RoomWorkerUnsupported)) throw error;
			// This browser cannot host the room in a worker: the main-thread page, as without the option.
			console.warn("Canvas room worker unsupported; opening the room on the main thread", error.missing);
			handle = undefined;
			identity.release();
			return await fallback();
		}
		const opened = handle as RoomWorkerHandle<CanvasWorkerCommands>;
		session ??= ready.session;
		render(() => page.view(ready.view));
		window.__TS_DRP_CANVAS_SESSION__ = Object.freeze({
			snapshot: () => session ?? ready.session,
			/** The whole session snapshot (with its control-plane event log), read from the worker. */
			diagnostics: () => opened.call("session"),
		});
		window.__TS_DRP_CANVAS_ROOM_WORKER__ = Object.freeze({
			terminate: (reason?: string) => opened.terminate(reason),
			rtcStats: () => opened.call("rtcStats"),
		});
		if (meter !== undefined) window.__TS_DRP_CANVAS_ROOM_WORKER_METER__ = meter.control;
		window.dispatchEvent(new CustomEvent("ts-drp:canvas-ready", { detail: ready.session }));
		unloadHandler = (): void => {
			page.unload();
			// The document owns the Web Lock until termination (as on the main thread). The worker's
			// close joins admitted work before its node stops.
			void opened.close().catch((error: unknown) => console.error("Failed to close the canvas room worker", error));
		};
		window.addEventListener("beforeunload", unloadHandler, { once: true });
		console.log("Started canvas room worker", ready.peerId);
	} catch (error) {
		delete window.__TS_DRP_CANVAS_SESSION__;
		delete window.__TS_DRP_CANVAS_ROOM_WORKER__;
		if (unloadHandler !== undefined) window.removeEventListener("beforeunload", unloadHandler);
		await handle?.close().catch(() => undefined);
		identity.release();
		connectionStatus("Canvas could not start. Check the configured identity and network.", "error");
		throw error;
	}
}
