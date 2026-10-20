/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test fixture: transparent inference keeps the native capability signatures. */
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { browserHostFor, type LongRoomHost, openRole } from "./long-room-core.js";
import {
	driveLongRoom,
	type HostKind,
	labelOf,
	type LongRoomOptions,
	type LongRoomRun,
	type RoleEndpoint,
	type StoreCensus,
} from "./long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../../../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../../../packages/storage-node/src/v3-room-host.js";

export type {
	AppKind,
	BoundMode,
	EpochRecord,
	HostKind,
	LongRoomOptions,
	LongRoomRun,
	RecipientMode,
} from "./long-room-driver.js";
export { RETIREMENT_SELECTION } from "./long-room-driver.js";

// Track Q (Canvas and Chat creator lull), Node wrapper: both roles of a long room
// (long-room-core.ts `openRole`) in this process, driven by long-room-driver.ts. Adapted
// from Track M's tests/fixtures/track-m-apps/app-long-room.ts (da3704ac) without its
// retention host.
//
// Both roles share one process and one global proof-event observer, so every endpoint
// call runs inside an AsyncLocalStorage context naming its role, and the observer files
// each event under the role whose call chain emitted it. Events with no role context are
// kept apart and never counted for either role.
//
// Hosts: "node" = the default Node SQLite host (createNodeV3RoomStorageHost); "browser" = the
// default six-database browser host on fake-indexeddb; "room" = the browser room-database
// host on fake-indexeddb. fake-indexeddb is mechanism evidence only (no engine timing). The
// external floor is SQLite on every host here. A persisted reopen is supported on the node
// host only.

const directories = new Set<string>();
const track = Object.freeze({
	rooms: new Set<Readonly<{ close(): Promise<void> }>>(),
	heads: new Set<Readonly<{ close(): Promise<void> }>>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
});

/** Joins every owner the run opened and removes its directories; call from afterEach. */
export async function closeLongRooms(): Promise<unknown[]> {
	const joined = await Promise.allSettled([...track.rooms].map((room) => room.close()));
	track.rooms.clear();
	const floorJoined = await Promise.allSettled([...track.heads].map((head) => head.close()));
	track.heads.clear();
	const portJoined = await Promise.allSettled([...track.ports].map((port) => port.close()));
	track.ports.clear();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
	return [...joined, ...floorJoined, ...portJoined].flatMap((result) =>
		result.status === "rejected" ? [result.reason] : []
	);
}

// ---------------------------------------------------------------------------------------
// Process environment for the browser hosts: fake-indexeddb and a FIFO Web Locks manager
// (Node has none), installed only while a browser-host run is active.

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

type Role = "creator" | "recipient";
const roleContext = new AsyncLocalStorage<Role>();

/** Installs the role-filing event observer (and, for browser hosts, fake-indexeddb and Web Locks). */
async function installEnvironment(
	host: HostKind,
	observe: (role: Role | undefined, event: Readonly<Record<string, unknown>>) => void
): Promise<() => void> {
	if (host !== "node") await import("fake-indexeddb/auto");
	const previousObserver = Reflect.get(globalThis, "__warmProofEvent");
	Reflect.set(globalThis, "__warmProofEvent", (event: Readonly<Record<string, unknown>>) => {
		if (event !== null && typeof event === "object") observe(roleContext.getStore(), event);
	});
	const previousLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
	if (host !== "node")
		Object.defineProperty(navigator, "locks", { configurable: true, value: createProcessLockManager() });
	return () => {
		Reflect.set(globalThis, "__warmProofEvent", previousObserver);
		if (host === "node") return;
		if (previousLocks === undefined) Reflect.deleteProperty(navigator, "locks");
		else Object.defineProperty(navigator, "locks", previousLocks);
	};
}

/** Every endpoint call runs in its role's context, so its proof events are filed under it. */
function inRole(role: Role, endpoint: RoleEndpoint): RoleEndpoint {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(endpoint))
		out[key] =
			typeof value === "function"
				? (...args: unknown[]) => roleContext.run(role, () => (value as (...a: unknown[]) => unknown)(...args))
				: value;
	return Object.freeze(out) as unknown as RoleEndpoint;
}

// ---------------------------------------------------------------------------------------
// Node SQLite census (observation only).

const SQLITE_FAMILIES = ["ahe", "issuance", "journal", "snapshots", "signing"] as const;
// The issuance, journal and snapshot owners open `<primary>.<suffix>` (packages/storage-node
// v3-room-host `declareNativeFile`); the AHE and signing owners open the primary file.
const SQLITE_SUFFIX: Readonly<Record<(typeof SQLITE_FAMILIES)[number], string>> = {
	ahe: "",
	issuance: ".drp-issuance-v1.sqlite",
	journal: ".drp-live-journal-v1.sqlite",
	snapshots: ".drp-snapshot-quarantine-v1.sqlite",
	signing: "",
};
const sqliteFile = (directory: string, family: (typeof SQLITE_FAMILIES)[number], name: string) =>
	join(
		directory,
		`${createHash("sha256")
			.update(JSON.stringify([family, name]))
			.digest("hex")}.sqlite${SQLITE_SUFFIX[family]}`
	);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Rows and BLOB/TEXT payload bytes of every table of one role's SQLite owners. */
function sqliteCensus(directory: string, name: string): StoreCensus {
	const out: Record<string, readonly [number, number]> = {};
	for (const family of SQLITE_FAMILIES) {
		const filename = sqliteFile(directory, family, family === "ahe" ? `${name}--ahe` : name);
		if (!existsSync(filename)) {
			out[`${family}:#missing`] = [1, 0];
			continue;
		}
		const database = new DatabaseSync(filename, { readOnly: true });
		try {
			const tables = database
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all()
				.map((row) => String(row.name));
			for (const table of tables) {
				const columns = database
					.prepare(`PRAGMA table_info(${quote(table)})`)
					.all()
					.map((column) => quote(String(column.name)));
				const payload = columns
					.map((column) => `CASE WHEN typeof(${column}) IN ('blob','text') THEN length(${column}) ELSE 0 END`)
					.join(" + ");
				const row = database
					.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(${payload || "0"}), 0) AS bytes FROM ${quote(table)}`)
					.get() as { rows: number; bytes: number };
				out[`${family}:${table}`] = [Number(row.rows), Number(row.bytes)];
			}
		} finally {
			database.close();
		}
		const wal = `${filename}-wal`;
		out[`${family}:#file`] = [1, statSync(filename).size + (existsSync(wal) ? statSync(wal).size : 0)];
	}
	return Object.freeze(out);
}

function nodeHostFor(kind: HostKind, directory: string, reopen: boolean): LongRoomHost {
	if (kind !== "node") {
		if (reopen) throw new TypeError("CANVAS_CHAT_LULL_REOPEN_NODE_ONLY");
		return browserHostFor(kind, directory);
	}
	const storageHost = createNodeV3RoomStorageHost({ directory, initialization: () => (reopen ? "reopen" : "create") });
	// Separate observation handles over the same files (never the room's own owners).
	const observe = createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" });
	return Object.freeze({
		storageHost,
		observe: observe as unknown as LongRoomHost["observe"],
		census: (name: string) => Promise.resolve(sqliteCensus(directory, name)),
	});
}

export interface RunHooks {
	/** Macrotask yield before each seal (default 300 ms, Track M finding 5). */
	readonly settleMs?: number;
	/** JSONL output directory (one file per run) and the tree label. */
	readonly out?: string;
	readonly tree?: string;
	readonly verbose?: boolean;
}

/**
 * Runs one long room in this process.
 * @param options - The room.
 * @param hooks - Output and timing hooks.
 * @returns Every epoch's record, and the events no role's call chain emitted.
 */
export async function runLongRoom(
	options: LongRoomOptions,
	hooks: RunHooks = {}
): Promise<LongRoomRun & Readonly<{ unattributed: number }>> {
	const label = labelOf(options);
	const directory = mkdtempSync(join(tmpdir(), "canvas-chat-lull-"));
	directories.add(directory);
	const events: Record<Role, Readonly<Record<string, unknown>>[]> = { creator: [], recipient: [] };
	// Synchronous per-role listeners (the creator's lull-ingress trigger, long-room-core.ts).
	const listeners: Record<Role, Set<(event: Readonly<Record<string, unknown>>) => void>> = {
		creator: new Set(),
		recipient: new Set(),
	};
	const subscribe = (role: Role) => (listener: (event: Readonly<Record<string, unknown>>) => void) => {
		listeners[role].add(listener);
		return () => void listeners[role].delete(listener);
	};
	let unattributed = 0;
	const restore = await installEnvironment(options.host, (role, event) => {
		if (role === undefined) unattributed++;
		else {
			events[role].push(event);
			for (const listener of listeners[role]) listener(event);
		}
	});
	const out = hooks.out;
	const tree = hooks.tree ?? "unknown";
	if (out !== undefined) mkdirSync(out, { recursive: true });
	let file = out === undefined ? undefined : join(out, `${label}-${tree}.jsonl`);
	for (let suffix = 1; file !== undefined && out !== undefined && existsSync(file); suffix++)
		file = join(out, `${label}-${tree}-${suffix}.jsonl`);
	let completed = 0;
	const started = Date.now();
	const open = async (reopen: boolean): Promise<readonly [RoleEndpoint, RoleEndpoint]> => {
		const host = nodeHostFor(options.host, directory, reopen);
		const openFloor = (name: string) =>
			createNodeRoomHeadAuthority({
				filename: join(directory, `${name}-external-floor.sqlite`),
				initialization: { kind: reopen ? "reopen" : "create" },
			});
		// Fresh per-role event lists for each opening: a reopened endpoint drains from zero.
		events.creator = [];
		events.recipient = [];
		const creatorEvents = events.creator;
		const recipientEvents = events.recipient;
		const creator = inRole(
			"creator",
			await roleContext.run("creator", () =>
				openRole(options, 0, {
					host,
					unique: directory,
					openFloor,
					track,
					events: creatorEvents,
					subscribe: subscribe("creator"),
				})
			)
		);
		const recipient = inRole(
			"recipient",
			await roleContext.run("recipient", () =>
				openRole(options, 1, {
					host,
					unique: directory,
					openFloor,
					track,
					events: recipientEvents,
					subscribe: subscribe("recipient"),
					relay: (request) => creator.dispatch(request),
				})
			)
		);
		return [creator, recipient] as const;
	};
	try {
		let endpoints = await open(false);
		return {
			...(await driveLongRoom(options, endpoints, {
				settleMs: hooks.settleMs ?? 300,
				reopen: async () => {
					await endpoints[1].close();
					await endpoints[0].close();
					endpoints = await open(true);
					return endpoints;
				},
				write: (record) => {
					completed = record.epoch;
					if (file !== undefined) appendFileSync(file, `${JSON.stringify({ label, tree, ...record })}\n`);
				},
				log: (line) => {
					if (hooks.verbose === true) process.stdout.write(`${line}\n`);
				},
			})),
			unattributed,
		};
	} catch (error) {
		if (out !== undefined)
			appendFileSync(
				join(out, "failures.jsonl"),
				`${JSON.stringify({ label, tree, file, completed, failedEpoch: completed + 1, elapsedMs: Date.now() - started, error: String(error) })}\n`
			);
		throw error;
	} finally {
		restore();
	}
}
