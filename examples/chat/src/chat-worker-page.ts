/**
 * The Chat page with its room hosted in a room worker (the default; `?mainThread` opts out).
 *
 * The page keeps rendering, input, identity and the Writer-replica marks (localStorage, through the
 * `readWriterReplica`/`markWriterReplica` hooks); the worker (chat-worker.ts) runs the node and the
 * room. `window.__TS_DRP_CHAT_SESSION__.snapshot()` answers the worker's last published session
 * summary (peer id, relay reservations); `diagnostics()` reads the whole session snapshot.
 *
 * Crash ambiguity (the package README's rule): a send in flight when the worker dies rejects with
 * RoomWorkerCrashed and may have landed. The page keeps the text in the message box (it clears it
 * only on an accepted send); offering it again after a reload is a new message, so the person decides
 * whether it went out (the room's window shows it if it did).
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

import { type ChatPage, type ChatPageRoom, createChatPage, status, writerReplicaStorage } from "./chat-page";
import type { ChatHeadFactory, ChatView } from "./chat-room";
import {
	CHAT_WORKER_CONTRACT,
	type ChatWorkerCommands,
	type ChatWorkerInit,
	type ChatWorkerNetwork,
	type ChatWorkerReady,
	type ChatWorkerSessionSummary,
	type ChatWorkerStatus,
} from "./chat-worker-contract";

/** The page's control of the worker itself (tests and the FPS harness). */
export interface ChatRoomWorkerControl {
	/** Stops the worker now; calls in flight reject with RoomWorkerCrashed. */
	terminate(reason?: string): void;
	rtcStats(): Promise<RoomWorkerRtcStats>;
}

declare global {
	interface Window {
		__TS_DRP_CHAT_ROOM_WORKER__?: ChatRoomWorkerControl;
		__TS_DRP_CHAT_ROOM_WORKER_METER__?: RoomWorkerFrameMeterControl;
	}
}

/**
 * Open the Chat room in a room worker, with the main-thread page as its fallback when this browser
 * cannot host the room in a worker.
 * @param fallback - Opens the room on the main thread (chat-main-thread.ts's main), on this page.
 */
export async function mainWithRoomWorker(fallback: (page: ChatPage) => Promise<void>): Promise<void> {
	const page = createChatPage();
	const identity = await acquireBrowserIdentity({
		lockPrefix: "ts-drp:chat:v3:identity-slot",
		seedKey: "ts-drp:chat:v3:identity-seed",
	});
	// The bridge meter (`?roomWorkerMeter`): per frame, the bridge's main-thread cost (library) and the
	// Chat rendering it ran (app).
	const meter = new URLSearchParams(window.location.search).has("roomWorkerMeter")
		? createRoomWorkerFrameMeter()
		: undefined;
	const render = meter === undefined ? (draw: () => void): void => draw() : meter.render;
	const config = getNetworkConfigFromEnv(readBrowserNetworkEnv(import.meta.env), window.location.origin);
	const init: ChatWorkerInit = { seed: identity.seed, origin: window.location.origin };
	const onDiagnostic = forwardV3RoomWorkerObservation();
	// The native read reservations the worker holds through the page's authority: released when the
	// worker stops, as a dead process's native locks are.
	const reservations = createV3RoomWorkerReservations();
	const hooks: Record<string, (...args: never[]) => unknown> = {
		roomHeadAuthorityForOpen: reservations.wrap((context: Parameters<ChatHeadFactory>[0]) => {
			const factory = window.__TS_DRP_CHAT_ROOM_HEAD_AUTHORITY_FOR_OPEN__;
			if (typeof factory !== "function")
				throw new TypeError("Chat room-head authority is unavailable: the application host must configure its factory");
			return factory(context);
		}),
		readWriterReplica: (key: string) => writerReplicaStorage.read(key),
		markWriterReplica: (key: string, writer: boolean) => writerReplicaStorage.mark(key, writer),
	};
	const approve = window.__TS_DRP_CHAT_SETTLEMENT_SOURCE_APPROVAL__;
	if (approve !== undefined) hooks.approveSettlementSourceSelection = approve;
	const publish = window.__TS_DRP_CHAT_SUCCESSOR_PUBLISHER__;
	if (publish !== undefined) hooks.publishSuccessor = publish;

	let handle: RoomWorkerHandle<ChatWorkerCommands> | undefined;
	let session: ChatWorkerSessionSummary | undefined;
	const room: ChatPageRoom = {
		open: (operation, invite) => (handle as RoomWorkerHandle<ChatWorkerCommands>).call("open", operation, invite),
		send: (text) => (handle as RoomWorkerHandle<ChatWorkerCommands>).call("send", text),
		changeWriter: (kind, target) => (handle as RoomWorkerHandle<ChatWorkerCommands>).call("changeWriter", kind, target),
	};
	let bound = false;
	let viewed = false;
	const openWorker = async (): Promise<ChatWorkerReady> => {
		const opening = openRoomWorker<ChatWorkerCommands>({
			spawn: () => new Worker(new URL("./chat-worker.ts", import.meta.url), { type: "module", name: "chat-room" }),
			contract: CHAT_WORKER_CONTRACT,
			init,
			hooks,
			errors: V3_ROOM_WORKER_ERROR_CODECS,
			localStorageKeys: v3RoomWorkerPeerCacheKeys(config),
			...(meter === undefined ? {} : { meter }),
			...(onDiagnostic === undefined ? {} : { onDiagnostic }),
		});
		handle = opening;
		opening.on("chat", (value) => {
			viewed = true;
			render(() => page.view(value as ChatView));
		});
		opening.on("network", (value) => {
			const next = value as ChatWorkerNetwork;
			render(() => page.network(next));
			if (next.dialable && !bound) {
				bound = true;
				render(() => page.bind(room));
			}
		});
		opening.on("session", (value) => {
			session = value as ChatWorkerSessionSummary;
		});
		opening.on("status", (value) => {
			const next = value as ChatWorkerStatus;
			status(next.message, next.state);
		});
		opening.onCrash((error) => {
			console.error("Chat room worker stopped", error);
			page.unload();
			status("The chat stopped. Reload the page to reopen it.", "error");
			void reservations.releaseAll();
		});
		return (await opening.ready) as ChatWorkerReady;
	};
	let unloadHandler: (() => void) | undefined;
	try {
		let ready: ChatWorkerReady;
		try {
			ready = await openWorker();
		} catch (error) {
			if (!(error instanceof RoomWorkerUnsupported)) throw error;
			// This browser cannot host the room in a worker: the main-thread page, as without the option.
			console.warn("Chat room worker unsupported; opening the room on the main thread", error.missing);
			handle = undefined;
			identity.release();
			return await fallback(page);
		}
		const opened = handle as RoomWorkerHandle<ChatWorkerCommands>;
		session ??= ready.session;
		if (!viewed) render(() => page.view(ready.view));
		window.__TS_DRP_CHAT_SESSION__ = Object.freeze({
			snapshot: () => session ?? ready.session,
			/** The whole session snapshot (with its control-plane event log), read from the worker. */
			diagnostics: () => opened.call("session"),
		});
		window.__TS_DRP_CHAT_ROOM_WORKER__ = Object.freeze({
			terminate: (reason?: string) => opened.terminate(reason),
			rtcStats: () => opened.call("rtcStats"),
		});
		if (meter !== undefined) window.__TS_DRP_CHAT_ROOM_WORKER_METER__ = meter.control;
		window.dispatchEvent(new CustomEvent("ts-drp:chat-ready", { detail: ready.session }));
		unloadHandler = (): void => {
			page.unload();
			// The document owns the Web Lock until termination (as on the main thread). The worker's
			// close joins admitted work before its node stops.
			void opened.close().catch((error: unknown) => console.error("Failed to close the chat room worker", error));
		};
		window.addEventListener("beforeunload", unloadHandler, { once: true });
		console.log("Started chat room worker", ready.peerId);
	} catch (error) {
		delete window.__TS_DRP_CHAT_SESSION__;
		delete window.__TS_DRP_CHAT_ROOM_WORKER__;
		if (unloadHandler !== undefined) window.removeEventListener("beforeunload", unloadHandler);
		await handle?.close().catch(() => undefined);
		identity.release();
		throw error;
	}
}
