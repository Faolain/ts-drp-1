import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { createBrowserRoomHeadAuthority } from "@ts-drp/storage-browser/room-head";

import { browserHostFor, hex, openRole } from "../long-room-core.js";
import type { LongRoomOptions, RoleEndpoint } from "../long-room-driver.js";

// Track Q, browser entry: ONE role (creator or recipient) of the Canvas / Chat long room
// (tests/fixtures/canvas-chat-lull/long-room-core.ts) on the engine's own IndexedDB and Web
// Locks (Track M's tests/fixtures/track-m-apps/browser/entry.ts, da3704ac, without its
// retention host). The Playwright spec opens the creator and the recipient in two pages on
// two origins (two rooms of one object in one origin contend for the same Web Locks writer
// lock) and drives them with long-room-driver.ts. The external floor is the browser
// room-head authority in its own database. The recipient's material requests leave the page
// through `canvasChatLullRelay` (exposed by the spec) to the creator page's `dispatch`.
// Long tasks (PerformanceObserver "longtask", Chromium) are kept per page and read per epoch.

type Method = keyof RoleEndpoint;

declare global {
	interface Window {
		canvasChatLullRole: Readonly<{
			open(options: LongRoomOptions, index: 0 | 1, unique: string): Promise<void>;
			call(method: Method, args: readonly unknown[]): Promise<unknown>;
			/** Long tasks since the previous read: count, longest and total duration (ms). */
			longTasks(): Readonly<{ count: number; longest: number; total: number; supported: boolean }>;
			shutdown(): Promise<void>;
		}>;
		canvasChatLullRelay?(request: string): Promise<string[]>;
	}
}

const events: Readonly<Record<string, unknown>>[] = [];
// Synchronous listeners (the creator's lull-ingress trigger, long-room-core.ts).
const listeners = new Set<(event: Readonly<Record<string, unknown>>) => void>();
Reflect.set(globalThis, "__warmProofEvent", (event: Readonly<Record<string, unknown>>) => {
	if (event === null || typeof event !== "object") return;
	events.push(event);
	for (const listener of listeners) listener(event);
});
const subscribe = (listener: (event: Readonly<Record<string, unknown>>) => void): (() => void) => {
	listeners.add(listener);
	return () => void listeners.delete(listener);
};
let tasks: number[] = [];
const longTaskSupported =
	typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask");
if (longTaskSupported)
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) tasks.push(entry.duration);
	}).observe({ type: "longtask", buffered: true });
const track = Object.freeze({
	rooms: new Set<Readonly<{ close(): Promise<void> }>>(),
	heads: new Set<Readonly<{ close(): Promise<void> }>>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
});
let endpoint: RoleEndpoint | undefined;

window.canvasChatLullRole = Object.freeze({
	open: async (options: LongRoomOptions, index: 0 | 1, unique: string) => {
		if (options.host === "node") throw new TypeError("CANVAS_CHAT_LULL_BROWSER_HOST_REQUIRED");
		if (endpoint !== undefined) throw new TypeError("CANVAS_CHAT_LULL_ROLE_ALREADY_OPEN");
		const floorPrefix = `ccl-floor-${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
		endpoint = await openRole(options, index, {
			host: browserHostFor(options.host, unique),
			unique,
			openFloor: (name) =>
				createBrowserRoomHeadAuthority({ databaseName: `${floorPrefix}-${name}`, initialization: { kind: "create" } }),
			track,
			events,
			subscribe,
			...(index === 1
				? {
						relay: (request: string): Promise<string[]> => {
							const relay = window.canvasChatLullRelay;
							if (relay === undefined) throw new TypeError("CANVAS_CHAT_LULL_RELAY_REQUIRED");
							return relay(request);
						},
					}
				: {}),
		});
		tasks = [];
	},
	call: (method: Method, args: readonly unknown[]): Promise<unknown> => {
		if (endpoint === undefined) return Promise.reject(new TypeError("CANVAS_CHAT_LULL_ROLE_NOT_OPEN"));
		const selected = endpoint[method] as (...values: unknown[]) => Promise<unknown>;
		return selected(...args);
	},
	longTasks: () => {
		const read = tasks;
		tasks = [];
		return Object.freeze({
			count: read.length,
			longest: read.reduce((max, value) => Math.max(max, value), 0),
			total: read.reduce((sum, value) => sum + value, 0),
			supported: longTaskSupported,
		});
	},
	shutdown: async () => {
		await Promise.allSettled([...track.rooms].map((room) => room.close()));
		await Promise.allSettled([...track.heads].map((head) => head.close()));
		await Promise.allSettled([...track.ports].map((port) => port.close()));
	},
});
document.title = "canvas-chat-lull ready";
