/* eslint-disable @typescript-eslint/explicit-function-return-type -- Measurement fixture: transparent inference keeps the native capability signatures. */
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { browserHostFor, type LongRoomHost, openRole, required } from "./long-room-core.js";
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
	EpochRecord,
	HostKind,
	LongRoomOptions,
	LongRoomRun,
	RecipientMode,
	RoleEndpoint,
	StoreCensus,
} from "./long-room-driver.js";
export { required } from "./long-room-core.js";

// Track M measurement (Canvas and Chat), Node wrapper: both roles of a long room
// (tests/fixtures/track-m-apps/long-room-core.ts `openRole`) in this process, driven by
// tests/fixtures/track-m-apps/long-room-driver.ts through genuine seal, adoption, install
// and both roles' recovery-pool lulls, with a per-store row and byte census of each role
// after every install and after every lull, and wall-clock latency per transition.
// Observation only: the census opens its own read-only connections (SQLite) or its own
// IndexedDB connection and never reaches into a node or owner object.
//
// Hosts: "node" = the default Node SQLite host (createNodeV3RoomStorageHost); "browser" = the
// default six-database browser host (examples/v3-room's owner factories) on fake-indexeddb;
// "room" and "room-retention" = the browser room-database host on fake-indexeddb, without and
// with `roomRetention: true`. fake-indexeddb is mechanism evidence only (no engine timing).
// The external floor is SQLite on every host here. Node has no Web Locks writer lock, so
// both roles of one object can share this process.
//
// Environment: TRACK_M_APPS_OUT=<dir> (JSONL per run, TRACK_M_APPS_TREE names the tree),
// TRACK_M_APPS_VERBOSE=1, TRACK_M_APPS_SETTLE_MS=<ms> (yield before each seal).

const directories = new Set<string>();
const track = Object.freeze({
	rooms: new Set<Readonly<{ close(): Promise<void> }>>(),
	heads: new Set<Readonly<{ close(): Promise<void> }>>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
});

/** Joins every owner the measurement opened; call from afterEach. */
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
export function createProcessLockManager() {
	const held = new Map<string, { mode: LockMode; count: number }>();
	const queues = new Map<string, { mode: LockMode; grant(): void }[]>();
	const compatible = (lockName: string, mode: LockMode) => {
		const current = held.get(lockName);
		return current === undefined || (current.mode === "shared" && mode === "shared");
	};
	const pump = (lockName: string) => {
		const queue = queues.get(lockName) ?? [];
		while (queue.length > 0 && compatible(lockName, required(queue[0]).mode)) required(queue.shift()).grant();
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
			const current = required(held.get(lockName));
			if (current.count === 1) held.delete(lockName);
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

/** Installs the event observer (and, for browser hosts, fake-indexeddb and Web Locks); returns the restore. */
export async function installEnvironment(
	host: HostKind,
	observe: (event: Readonly<Record<string, unknown>>) => void
): Promise<() => void> {
	if (host !== "node") await import("fake-indexeddb/auto");
	const previousObserver = Reflect.get(globalThis, "__warmProofEvent");
	Reflect.set(globalThis, "__warmProofEvent", (event: Readonly<Record<string, unknown>>) => {
		if (event !== null && typeof event === "object") observe(event);
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

function nodeHostFor(kind: HostKind, directory: string): LongRoomHost {
	if (kind !== "node") return browserHostFor(kind, directory);
	const storageHost = createNodeV3RoomStorageHost({ directory, initialization: () => "create" });
	// Separate observation handles over the same files (never the room's own owners).
	const observe = createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" });
	return Object.freeze({
		storageHost,
		observe: observe as unknown as LongRoomHost["observe"],
		census: (name: string) => Promise.resolve(sqliteCensus(directory, name)),
	});
}

/**
 * Runs one long room in this process.
 * @param options - The room.
 * @param wrap - Optional observation wrapper around the two endpoints (e.g. a profiler around
 * the creator's issue); it must forward every call unchanged.
 * @returns Every epoch's record.
 */
export async function runLongRoom(
	options: LongRoomOptions,
	wrap?: (creator: RoleEndpoint, recipient: RoleEndpoint) => readonly [RoleEndpoint, RoleEndpoint]
): Promise<LongRoomRun> {
	const label = labelOf(options);
	const directory = mkdtempSync(join(tmpdir(), "track-m-apps-"));
	directories.add(directory);
	const events: Readonly<Record<string, unknown>>[] = [];
	const restore = await installEnvironment(options.host, (event) => events.push(event));
	const out = process.env.TRACK_M_APPS_OUT;
	const tree = process.env.TRACK_M_APPS_TREE ?? "unknown";
	if (out !== undefined) mkdirSync(out, { recursive: true });
	const settle = process.env.TRACK_M_APPS_SETTLE_MS;
	// One JSONL per run: a repeated label in the same directory takes the next free suffix.
	let file = out === undefined ? undefined : join(out, `${label}-${tree}.jsonl`);
	for (let suffix = 1; file !== undefined && out !== undefined && existsSync(file); suffix++)
		file = join(out, `${label}-${tree}-${suffix}.jsonl`);
	let completed = 0;
	const started = Date.now();
	try {
		const host = nodeHostFor(options.host, directory);
		const openFloor = (name: string) =>
			createNodeRoomHeadAuthority({
				filename: join(directory, `${name}-external-floor.sqlite`),
				initialization: { kind: "create" },
			});
		// One process: the global observer's events go to the creator endpoint only.
		const creator = await openRole(options, 0, { host, unique: directory, openFloor, track, events });
		const recipient = await openRole(options, 1, {
			host,
			unique: directory,
			openFloor,
			track,
			relay: (request) => creator.dispatch(request),
		});
		return await driveLongRoom(options, wrap === undefined ? [creator, recipient] : wrap(creator, recipient), {
			...(settle === undefined ? {} : { settleMs: Number(settle) }),
			write: (record) => {
				completed = record.epoch;
				if (file !== undefined) appendFileSync(file, `${JSON.stringify({ label, tree, ...record })}\n`);
			},
			log: (line) => {
				if (process.env.TRACK_M_APPS_VERBOSE === "1") process.stdout.write(`${line}\n`);
			},
		});
	} catch (error) {
		// Failures land beside the runs (which epoch's transition refused, and why).
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

/** Parses a comma list from the environment, restricted to the allowed values. */
export function selection<Value extends string>(name: string, allowed: readonly Value[], fallback: readonly Value[]) {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return [...fallback];
	const values = raw.split(",").map((value) => value.trim());
	for (const value of values)
		if (!allowed.includes(value as Value)) throw new TypeError(`TRACK_M_APPS_SELECTION ${name}=${value}`);
	return values as Value[];
}
