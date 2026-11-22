/**
 * Worker entry of @ts-drp/room-worker. An app's worker file is a few lines:
 *
 *     import { serveRoomWorker } from "@ts-drp/room-worker/worker";
 *     import { contract } from "./room-contract.js";
 *     serveRoomWorker({ contract, load: () => import("./room-worker-app.js") });
 *
 * The app module is imported only after the RTC globals are installed (network modules capture
 * them when evaluated), so it must not be imported statically by the worker file.
 */
import type { RoomWorkerContract } from "./contract.js";
import type { RoomWorkerErrorCodec } from "./errors.js";
import type { RoomWorkerPort } from "./protocol.js";
import { installWorkerRtc } from "./rtc-worker.js";
import {
	createRoomWorkerServer,
	type RoomWorkerApp,
	type RoomWorkerServer,
	type RoomWorkerServerOptions,
} from "./server.js";

export {
	createRoomWorkerServer,
	defineRoomWorkerApp,
	type RoomWorkerApp,
	type RoomWorkerContext,
	type RoomWorkerServer,
	type RoomWorkerServerOptions,
	type RoomWorkerSession,
	type RoomWorkerStorage,
} from "./server.js";
export { installWorkerRtc, roomWorkerRtcStats, type RoomWorkerRtcStats, type WorkerRtc } from "./rtc-worker.js";

/** What a dedicated worker must have to host a room. */
export const ROOM_WORKER_REQUIRED_GLOBALS = Object.freeze(["RTCDataChannel", "indexedDB", "WebSocket", "crypto"]);

export interface ServeRoomWorkerOptions {
	readonly contract: RoomWorkerContract;
	/** Loads the app (its default export, or the app itself), after the worker's globals exist. */
	load(): Promise<RoomWorkerApp<never> | RoomWorkerApp | { readonly default: RoomWorkerApp<never> | RoomWorkerApp }>;
	readonly errors?: readonly RoomWorkerErrorCodec[];
	/** Globals the room needs here (default ROOM_WORKER_REQUIRED_GLOBALS). */
	readonly requires?: readonly string[];
	readonly beforeOpen?: RoomWorkerServerOptions["beforeOpen"];
}

/**
 * Serves an app's room from this dedicated worker.
 * @param options - Contract, app loader, codecs.
 * @returns The server.
 */
export function serveRoomWorker(options: ServeRoomWorkerOptions): RoomWorkerServer {
	const scope = globalThis as unknown as RoomWorkerPort;
	const missing = (options.requires ?? ROOM_WORKER_REQUIRED_GLOBALS).filter(
		(name) => Reflect.get(globalThis, name) === undefined
	);
	let server: RoomWorkerServer | undefined = undefined;
	let loadedErrors: readonly RoomWorkerErrorCodec[] = [];
	const rtc = installWorkerRtc((message, transfer) => server?.postRtc(message, transfer));
	const app: RoomWorkerApp = {
		contract: options.contract,
		async open(context) {
			const loaded = await options.load();
			const selected = ("default" in loaded ? loaded.default : loaded) as RoomWorkerApp;
			if (selected.contract.name !== options.contract.name || selected.contract.version !== options.contract.version)
				throw new TypeError("the loaded room worker app speaks another contract than its worker file");
			loadedErrors = selected.errors ?? [];
			return selected.open(context);
		},
	};
	server = createRoomWorkerServer({
		port: scope,
		app,
		errors: () => [...(options.errors ?? []), ...loadedErrors],
		missing,
		...(options.beforeOpen === undefined ? {} : { beforeOpen: options.beforeOpen }),
		rtc,
	});
	return server;
}
