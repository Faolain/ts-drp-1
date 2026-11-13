/**
 * The Grid zone's dedicated worker (opt-in, `?roomWorker`). It imports only light modules
 * statically: the room worker installs its RTC globals, and the harness observation is installed,
 * before zone-worker-app.ts (the node, the room, the network) is loaded.
 */
import { installV3RoomWorkerObservation } from "@ts-drp/example-v3-room/worker-observation";
import { serveRoomWorker } from "@ts-drp/room-worker/worker";
// @ts-expect-error -- the shim ships untyped through its package exports
import { Buffer } from "vite-plugin-node-polyfills/shims/buffer";
// @ts-expect-error -- the shim ships untyped through its package exports
import process from "vite-plugin-node-polyfills/shims/process";

import { ZONE_WORKER_CONTRACT } from "./zone-worker-contract";

// The page gets these Node globals from vite-plugin-node-polyfills; the room's dependencies expect
// them here too.
for (const [name, value] of [
	["Buffer", Buffer],
	["process", process],
	["global", globalThis],
] as const)
	if (Reflect.get(globalThis, name) === undefined) Reflect.set(globalThis, name, value);

serveRoomWorker({
	contract: ZONE_WORKER_CONTRACT,
	load: () => import("./zone-worker-app"),
	beforeOpen: ({ diagnosticsEnabled, diagnostic }) => {
		if (diagnosticsEnabled) installV3RoomWorkerObservation(diagnostic);
	},
});
