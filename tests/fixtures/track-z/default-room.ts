/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test fixture: transparent inference keeps the native capability signatures. */
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { createBrowserAheDurableStore } from "@ts-drp/storage-browser";
import { createBrowserDurableIssuanceStore } from "@ts-drp/storage-browser/issuance";
import { createBrowserDurableLiveJournalStore } from "@ts-drp/storage-browser/live-journal";
import {
	createBrowserRoomAheDurableStore,
	createBrowserRoomDurableIssuanceStore,
	createBrowserRoomSnapshotQuarantineStore,
} from "@ts-drp/storage-browser/maintenance";
import { createBrowserRoomHeadAuthority } from "@ts-drp/storage-browser/room-head";
import { openBrowserSealEvidenceStore } from "@ts-drp/storage-browser/seal-evidence";
import { openBrowserSealSigningStore } from "@ts-drp/storage-browser/seal-signing";
import { openBrowserSealVoteStore } from "@ts-drp/storage-browser/seal-vote";
import { createBrowserSnapshotQuarantineStore } from "@ts-drp/storage-browser/snapshot-transfer";
import { IDBFactory } from "fake-indexeddb";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeRoomHeadAuthority } from "../../../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../../../packages/storage-node/src/v3-room-host.js";
import { type LongRoomHost, openRole } from "../canvas-chat-lull/long-room-core.js";
import type { LongRoomOptions, RoleEndpoint } from "../canvas-chat-lull/long-room-driver.js";

// Track Z (the room database with retention as the default for new rooms). One long room
// of the shipped Canvas or Chat composition (tests/fixtures/canvas-chat-lull/long-room-core.ts
// `openRole`, unmodified), both roles in this process, driven WITHOUT explicit lulls:
// moves, seal, adoption, export and install per epoch. Hosts:
//
// - "default": no `storageHost`, so examples/v3-room `createV3RoomSession` chooses the host;
// - "six-database": the six-database layout the base default creates, passed explicitly
//   (the same owner factories as examples/v3-room's `browserStorageHost`, unprefixed names);
// - "node": the Node SQLite host.
//
// The browser hosts run on fake-indexeddb (mechanism evidence only, no engine timing), with
// a fresh IDBFactory per room so database names never leak between tests, and a FIFO Web
// Locks manager (Node has none). The external floor is SQLite on every host, as in
// tests/fixtures/canvas-chat-lull/node-long-room.ts, which this adapts.
//
// Both roles share one process and one `__warmProofEvent` observer, so every endpoint call
// runs in an AsyncLocalStorage context naming its role and each event is filed under the
// role whose call chain emitted it. Observation only: nothing here is a bound or a grant.

export type TrackZHost = "default" | "six-database" | "node";
export type Role = "creator" | "recipient";
export type ProofEvent = Readonly<Record<string, unknown>>;

type LockMode = "exclusive" | "shared";
function createProcessLockManager() {
	const held = new Map<string, { mode: LockMode; count: number }>();
	const queues = new Map<string, { mode: LockMode; grant(): void }[]>();
	const compatible = (lockName: string, mode: LockMode) => {
		const current = held.get(lockName);
		return current === undefined || (current.mode === "shared" && mode === "shared");
	};
	const pump = (lockName: string) => {
		const queue = queues.get(lockName) ?? [];
		while (queue.length > 0 && queue[0] !== undefined && compatible(lockName, queue[0].mode)) queue.shift()?.grant();
		if (queue.length === 0) queues.delete(lockName);
	};
	const request = async (lockName: string, ...rest: unknown[]) => {
		const callback = rest.at(-1) as (lock: unknown) => unknown;
		const lockOptions = (rest.length > 1 ? rest[0] : {}) as {
			mode?: LockMode;
			ifAvailable?: boolean;
			signal?: AbortSignal;
		};
		const mode = lockOptions.mode ?? "exclusive";
		if (lockOptions.ifAvailable === true && (!compatible(lockName, mode) || queues.has(lockName)))
			return await callback(null);
		await new Promise<void>((resolve, reject) => {
			const queue = queues.get(lockName) ?? [];
			const entry = {
				mode,
				grant: () => {
					held.set(lockName, { mode, count: (held.get(lockName)?.count ?? 0) + 1 });
					resolve();
				},
			};
			const signal = lockOptions.signal;
			if (signal !== undefined) {
				signal.throwIfAborted();
				signal.addEventListener(
					"abort",
					() => {
						const index = queue.indexOf(entry);
						if (index < 0) return;
						queue.splice(index, 1);
						reject(signal.reason);
					},
					{ once: true }
				);
			}
			queue.push(entry);
			queues.set(lockName, queue);
			pump(lockName);
		});
		try {
			return await callback(Object.freeze({ name: lockName, mode }));
		} finally {
			const current = held.get(lockName);
			if (current === undefined || current.count === 1) held.delete(lockName);
			else held.set(lockName, { mode: current.mode, count: current.count - 1 });
			pump(lockName);
		}
	};
	const query = () =>
		Promise.resolve({
			held: [...held].map(([lockName, { mode }]) => ({ name: lockName, mode })),
			pending: [...queues].flatMap(([lockName, queue]) => queue.map(({ mode }) => ({ name: lockName, mode }))),
		});
	return Object.freeze({ request, query });
}

const roleContext = new AsyncLocalStorage<Role>();

function inRole(role: Role, endpoint: RoleEndpoint): RoleEndpoint {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(endpoint))
		out[key] =
			typeof value === "function"
				? (...args: unknown[]) => roleContext.run(role, () => (value as (...a: unknown[]) => unknown)(...args))
				: value;
	return Object.freeze(out) as unknown as RoleEndpoint;
}

/**
 * Every database the current IDBFactory holds.
 * @returns Sorted `[name, version]` pairs.
 */
export async function databaseLayout(): Promise<readonly (readonly [string, number])[]> {
	const listed = await indexedDB.databases();
	return listed
		.flatMap(({ name, version }) => (name === undefined ? [] : [[name, version ?? 0] as const]))
		.sort(([left], [right]) => left.localeCompare(right));
}

const AHE_SUFFIX = "--ahe";
const baseName = (name: string) => (name.endsWith(AHE_SUFFIX) ? name.slice(0, -AHE_SUFFIX.length) : name);

/** The six-database owner factories, exactly as examples/v3-room's `browserStorageHost` composes them. */
const sixDatabaseHost = Object.freeze({
	openAhe: (databaseName: string) => createBrowserAheDurableStore({ databaseName }),
	openIssuance: (primaryDatabaseName: string) => createBrowserDurableIssuanceStore({ primaryDatabaseName }),
	openJournal: (primaryDatabaseName: string) => createBrowserDurableLiveJournalStore({ primaryDatabaseName }),
	openSnapshots: (primaryDatabaseName: string) => createBrowserSnapshotQuarantineStore({ primaryDatabaseName }),
	openSealVote: (databaseName: string) => openBrowserSealVoteStore({ databaseName }),
	openSealEvidence: (databaseName: string) => openBrowserSealEvidenceStore({ databaseName }),
	openCreatorSigningStores: (databaseName: string) => openBrowserSealSigningStore({ databaseName }),
	openRoomHead: (
		databaseName: string,
		initialization: Parameters<typeof createBrowserRoomHeadAuthority>[0]["initialization"]
	) => createBrowserRoomHeadAuthority({ databaseName, initialization }),
});

/**
 * Observation handles that follow the layout the room actually has: the room-database
 * owners over a version-7 database, the six-database owners otherwise. Opening the wrong
 * family would create or upgrade a database the test then observes.
 */
const layoutObserver = Object.freeze({
	openIssuance: async (name: string) =>
		(await roomLayout(name))
			? createBrowserRoomDurableIssuanceStore({ databaseName: name })
			: createBrowserDurableIssuanceStore({ primaryDatabaseName: name }),
	openAhe: async (name: string) =>
		(await roomLayout(baseName(name)))
			? createBrowserRoomAheDurableStore({ databaseName: baseName(name) })
			: createBrowserAheDurableStore({ databaseName: name }),
	openSnapshots: async (name: string) =>
		(await roomLayout(name))
			? createBrowserRoomSnapshotQuarantineStore({ databaseName: name })
			: createBrowserSnapshotQuarantineStore({ primaryDatabaseName: name }),
});

async function roomLayout(name: string): Promise<boolean> {
	return (await databaseLayout()).some(([database, version]) => database === name && version === 7);
}

function hostFor(kind: TrackZHost, directory: string, reopen: boolean): LongRoomHost {
	const noCensus = () => Promise.resolve(Object.freeze({}));
	if (kind === "node") {
		const storageHost = createNodeV3RoomStorageHost({
			directory,
			initialization: () => (reopen ? "reopen" : "create"),
		});
		const observe = createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" });
		return Object.freeze({
			storageHost,
			observe: observe as unknown as LongRoomHost["observe"],
			census: noCensus,
		});
	}
	return Object.freeze({
		storageHost: kind === "default" ? undefined : sixDatabaseHost,
		observe: layoutObserver as unknown as LongRoomHost["observe"],
		census: noCensus,
	});
}

export interface TrackZRoom {
	readonly creator: RoleEndpoint;
	readonly recipient: RoleEndpoint;
	readonly events: Readonly<Record<Role, ProofEvent[]>>;
	/** The last author sequence of each role's rows delivered to the other role (kept across a reopen). */
	readonly delivered: (number | null)[];
	/** Events no role's call chain emitted. */
	unattributed(): number;
	/** Closes both roles and reopens them from their persisted stores on `host`. */
	reopen(host: TrackZHost): Promise<void>;
	close(): Promise<unknown[]>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens a new long room of both roles. Browser hosts get a fresh fake-indexeddb factory.
 * @param options - The room (`host` is ignored; `kind` selects the host).
 * @param kind - The host.
 * @returns Both endpoints, their filed proof events, reopen and close.
 */
export async function openTrackZRoom(options: LongRoomOptions, kind: TrackZHost): Promise<TrackZRoom> {
	if (kind !== "node") {
		await import("fake-indexeddb/auto");
		Reflect.set(globalThis, "indexedDB", new IDBFactory());
	}
	const directory = mkdtempSync(join(tmpdir(), "track-z-default-room-"));
	const track = Object.freeze({
		rooms: new Set<Readonly<{ close(): Promise<void> }>>(),
		heads: new Set<Readonly<{ close(): Promise<void> }>>(),
		ports: new Set<SnapshotChunkProtocolPort>(),
	});
	const events: Record<Role, ProofEvent[]> = { creator: [], recipient: [] };
	const listeners: Record<Role, Set<(event: ProofEvent) => void>> = { creator: new Set(), recipient: new Set() };
	let unattributed = 0;
	const previousObserver = Reflect.get(globalThis, "__warmProofEvent");
	Reflect.set(globalThis, "__warmProofEvent", (event: ProofEvent) => {
		if (event === null || typeof event !== "object") return;
		const role = roleContext.getStore();
		if (role === undefined) unattributed++;
		else {
			events[role].push(event);
			for (const listener of listeners[role]) listener(event);
		}
	});
	const previousLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
	if (kind !== "node")
		Object.defineProperty(navigator, "locks", { configurable: true, value: createProcessLockManager() });
	const restore = () => {
		Reflect.set(globalThis, "__warmProofEvent", previousObserver);
		if (kind === "node") return;
		if (previousLocks === undefined) Reflect.deleteProperty(navigator, "locks");
		else Object.defineProperty(navigator, "locks", previousLocks);
	};
	const open = async (host: TrackZHost, reopen: boolean) => {
		const roomHost = hostFor(host, directory, reopen);
		const openFloor = (name: string) =>
			createNodeRoomHeadAuthority({
				filename: join(directory, `${name}-external-floor.sqlite`),
				initialization: { kind: reopen ? "reopen" : "create" },
			});
		const subscribe = (role: Role) => (listener: (event: ProofEvent) => void) => {
			listeners[role].add(listener);
			return () => void listeners[role].delete(listener);
		};
		const creator = inRole(
			"creator",
			await roleContext.run("creator", () =>
				openRole(options, 0, {
					host: roomHost,
					unique: directory,
					openFloor,
					track,
					events: events.creator,
					subscribe: subscribe("creator"),
				})
			)
		);
		const recipient = inRole(
			"recipient",
			await roleContext.run("recipient", () =>
				openRole(options, 1, {
					host: roomHost,
					unique: directory,
					openFloor,
					track,
					events: events.recipient,
					subscribe: subscribe("recipient"),
					relay: (request) => creator.dispatch(request),
				})
			)
		);
		return [creator, recipient] as const;
	};
	let endpoints: readonly [RoleEndpoint, RoleEndpoint];
	try {
		endpoints = await open(kind, false);
	} catch (error) {
		restore();
		throw error;
	}
	let closed = false;
	return {
		get creator() {
			return endpoints[0];
		},
		get recipient() {
			return endpoints[1];
		},
		events,
		delivered: [null, null],
		unattributed: () => unattributed,
		reopen: async (host: TrackZHost) => {
			await endpoints[1].close();
			await endpoints[0].close();
			endpoints = await open(host, true);
		},
		close: async () => {
			if (closed) return [];
			closed = true;
			const joined = await Promise.allSettled([...track.rooms].map((room) => room.close()));
			const heads = await Promise.allSettled([...track.heads].map((head) => head.close()));
			const ports = await Promise.allSettled([...track.ports].map((port) => port.close()));
			restore();
			rmSync(directory, { recursive: true, force: true });
			return [...joined, ...heads, ...ports].flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		},
	};
}

/**
 * Plays `epochs` epochs on the room with no explicit lull: each Writer's moves (delivered to
 * the other role before the next move), a 300 ms yield before the seal (Track M finding 5),
 * seal, adoption, export and install.
 * @param room - The room.
 * @param options - The room options (`moves`, `recipient`).
 * @param epochs - Epochs to play, continuing from the room's current epoch.
 * @param first - The 0-based epoch to start at (after a reopen).
 */
export async function playEpochs(room: TrackZRoom, options: LongRoomOptions, epochs: number, first = 0): Promise<void> {
	const writerRecipient = options.recipient === "writer";
	const delivered = room.delivered;
	const role = (index: 0 | 1) => (index === 0 ? room.creator : room.recipient);
	const flush = async (from: 0 | 1) => {
		const rows = await role(from).published(delivered[from] ?? null);
		const last = rows.at(-1);
		if (last === undefined) return;
		await role(from === 0 ? 1 : 0).receive(rows);
		delivered[from] = last.authorSequence;
	};
	for (let epoch = first; epoch < first + epochs; epoch++) {
		for (let ordinal = 0; ordinal < options.moves; ordinal++) {
			await room.creator.issue(epoch, ordinal);
			await flush(0);
			if (!writerRecipient) continue;
			await room.recipient.issue(epoch, ordinal);
			await flush(1);
		}
		const [left, right] = await Promise.all([room.creator.state(), room.recipient.state()]);
		if (left !== right) throw new TypeError(`TRACK_Z_PROJECTIONS_DIFFER epoch=${epoch + 1}`);
		await sleep(300);
		await room.creator.seal(epoch);
		await room.creator.adopt();
		const exported = await room.creator.exportOffer();
		await room.recipient.install(exported.offer);
		const authority = await room.recipient.authorityEpoch();
		if (authority !== epoch + 1) throw new TypeError(`TRACK_Z_INSTALL_EPOCH ${String(authority)}`);
	}
}

/**
 * Groups one role's `recovery-pool-lull` proof events by the epoch each lull ran at.
 * @param events - The role's proof events.
 * @returns The lull events per epoch.
 */
export function lullsByEpoch(events: readonly ProofEvent[]): Map<number, ProofEvent[]> {
	const out = new Map<number, ProofEvent[]>();
	for (const event of events)
		if (event.kind === "recovery-pool-lull") {
			const epoch = Number(event.epoch);
			out.set(epoch, [...(out.get(epoch) ?? []), event]);
		}
	return out;
}
