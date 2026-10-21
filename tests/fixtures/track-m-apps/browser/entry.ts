import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { createBrowserRoomHeadAuthority } from "@ts-drp/storage-browser/room-head";

import { browserHostFor, hex, openRole } from "../long-room-core.js";
import type { LongRoomOptions, RoleEndpoint } from "../long-room-driver.js";

// Track M measurement, browser entry: ONE role (creator or recipient) of the Canvas / Chat
// long room (tests/fixtures/track-m-apps/long-room-core.ts) on the engine's own IndexedDB
// and Web Locks. The Playwright spec opens the creator and the recipient in two pages on two
// origins (two rooms of one object in one origin contend for the same Web Locks writer lock,
// `ts-drp:<topic>`) and drives them with tests/fixtures/track-m-apps/long-room-driver.ts.
// Hosts: "browser" = the default six-database host, "room" / "room-retention" = the room
// database without and with `roomRetention: true`; the external floor is the browser
// room-head authority in its own database. The recipient's material requests leave the page
// through `trackMAppsRelay` (exposed by the spec) to the creator page's `dispatch`.

type Method = Exclude<keyof RoleEndpoint, never>;

declare global {
	interface Window {
		trackMAppsRole: Readonly<{
			open(options: LongRoomOptions, index: 0 | 1, unique: string): Promise<void>;
			call(method: Method, args: readonly unknown[]): Promise<unknown>;
			shutdown(): Promise<void>;
		}>;
		trackMAppsRelay?(request: string): Promise<string[]>;
	}
}

const events: Readonly<Record<string, unknown>>[] = [];
Reflect.set(globalThis, "__warmProofEvent", (event: Readonly<Record<string, unknown>>) => {
	if (event !== null && typeof event === "object") events.push(event);
});
const track = Object.freeze({
	rooms: new Set<Readonly<{ close(): Promise<void> }>>(),
	heads: new Set<Readonly<{ close(): Promise<void> }>>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
});
let endpoint: RoleEndpoint | undefined;

// Measurement only (Track Y): `__cacheProbe` exists only in a TRACK_M_APPS_CACHE_PROBE=1 bundle. Each call runs
// inside a probe phase named after its method; the role's epoch is its authority epoch (the creator's advances
// when its adoption returns, the recipient's when its install returns); every drain of observer events (once per
// epoch, after both lulls) and the close flush the events to the spec's `__cacheProbeSink`.
const cacheProbe = Reflect.get(globalThis, "__cacheProbe") as
	| undefined
	| Readonly<{
			setContext(provider: () => { epoch: number; role: string }): void;
			enter(phase: string): void;
			exit(phase: string): void;
			flush(label: string): Promise<unknown>;
	  }>;
const probed = { epoch: 0, role: "unset" };
cacheProbe?.setContext(() => probed);
async function probedCall(method: Method, run: () => Promise<unknown>): Promise<unknown> {
	if (cacheProbe === undefined) return run();
	if (method === "close") await cacheProbe.flush(`e${probed.epoch}-before-close`);
	cacheProbe.enter(method);
	let result: unknown;
	try {
		result = await run();
	} finally {
		cacheProbe.exit(method);
	}
	if (method === "adopt" || method === "install") probed.epoch++;
	if (method === "drainEvents") await cacheProbe.flush(`e${probed.epoch}`);
	if (method === "close") await cacheProbe.flush("close");
	return result;
}

window.trackMAppsRole = Object.freeze({
	open: async (options: LongRoomOptions, index: 0 | 1, unique: string) => {
		if (options.host === "node") throw new TypeError("TRACK_M_APPS_BROWSER_HOST_REQUIRED");
		if (endpoint !== undefined) throw new TypeError("TRACK_M_APPS_ROLE_ALREADY_OPEN");
		const floorPrefix = `tma-floor-${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
		probed.role = index === 0 ? "creator" : "recipient";
		cacheProbe?.enter("open");
		endpoint = await openRole(options, index, {
			host: browserHostFor(options.host, unique),
			unique,
			openFloor: (name) =>
				createBrowserRoomHeadAuthority({ databaseName: `${floorPrefix}-${name}`, initialization: { kind: "create" } }),
			track,
			events,
			...(index === 1
				? {
						relay: (request: string): Promise<string[]> => {
							const relay = window.trackMAppsRelay;
							if (relay === undefined) throw new TypeError("TRACK_M_APPS_RELAY_REQUIRED");
							return relay(request);
						},
					}
				: {}),
		});
		cacheProbe?.exit("open");
	},
	call: (method: Method, args: readonly unknown[]): Promise<unknown> => {
		if (endpoint === undefined) return Promise.reject(new TypeError("TRACK_M_APPS_ROLE_NOT_OPEN"));
		const selected = endpoint[method] as (...values: unknown[]) => Promise<unknown>;
		return cacheProbe === undefined ? selected(...args) : probedCall(method, () => selected(...args));
	},
	shutdown: async () => {
		await Promise.allSettled([...track.rooms].map((room) => room.close()));
		await Promise.allSettled([...track.heads].map((head) => head.close()));
		await Promise.allSettled([...track.ports].map((port) => port.close()));
	},
});
document.title = "track-m-apps ready";
