/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference. */
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";

import { dumpDatabase, type LullFixture, required, type SessionWrap } from "./room-retention-fixture.js";

// Track M (slices 14b/14e): raw-database and session probes shared by the trust and bounds
// tests. A probe writes to the room database only through its OWN IndexedDB connection,
// as another tab or a corrupting host would; it never reaches into a node or owner object.

export type Dump = Record<string, [unknown, unknown][]>;
export type Row = Readonly<{ store: string; key: unknown; value: unknown }>;

export const stable = (value: unknown): string =>
	JSON.stringify(value, (_key, item: unknown) =>
		item instanceof Uint8Array ? { $b: Buffer.from(item).toString("hex") } : (item as unknown)
	);
export const rowId = (store: string, key: unknown): string => `${store} ${stable(key)}`;

/** Stores whose rows only the five retirement owners write or delete. */
export const OWNED =
	/^(ahe:|journal:|snapshot:|issuance:|(sealEvidence|signerState|voteSlots|voteOutbox|storageMeta) )/;

/** Every owned row of a dump, by row id. */
export function ownedRows(dump: Dump): Map<string, string> {
	const out = new Map<string, string>();
	for (const [store, entries] of Object.entries(dump))
		for (const [key, value] of entries) {
			const id = rowId(store, key);
			if (OWNED.test(id)) out.set(id, stable(value));
		}
	return out;
}

/** The owned rows that differ between two dumps (added, removed or changed). */
export function ownedDifference(before: Dump, after: Dump): string[] {
	const left = ownedRows(before),
		right = ownedRows(after);
	const out: string[] = [];
	for (const [id, value] of left)
		if (right.get(id) !== value) out.push(right.has(id) ? `changed ${id}` : `removed ${id}`);
	for (const id of right.keys()) if (!left.has(id)) out.push(`added ${id}`);
	return out;
}

async function openRaw(database: string): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(database);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function done(transaction: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error ?? new Error("TRACK_M_PROBE_ABORTED"));
		transaction.onerror = () => undefined;
	});
}

/** One raw read of a row (its own connection, its own transaction). */
export async function readRow(database: string, store: string, key: unknown): Promise<unknown> {
	const db = await openRaw(database);
	try {
		const transaction = db.transaction([store], "readonly");
		const request = transaction.objectStore(store).get(key as IDBValidKey);
		const value = await new Promise<unknown>((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		await done(transaction);
		return value;
	} finally {
		db.close();
	}
}

/**
 * One raw write as a foreign connection: puts each row (in-line or out-of-line key) and
 * deletes each key, in one strict transaction.
 * @returns Resolves when that transaction commits; `started` once it was issued.
 */
export function foreignWrite(
	database: string,
	puts: readonly Row[],
	deletes: readonly Readonly<{ store: string; key: unknown }>[] = []
): Readonly<{ started: Promise<void>; committed: Promise<void> }> {
	let issued: () => void = () => undefined;
	const started = new Promise<void>((resolve) => {
		issued = resolve;
	});
	const committed = (async () => {
		const db = await openRaw(database);
		try {
			const stores = [...new Set([...puts.map((row) => row.store), ...deletes.map((row) => row.store)])];
			const transaction = db.transaction(stores, "readwrite", { durability: "strict" });
			const completion = done(transaction);
			for (const row of puts) {
				const store = transaction.objectStore(row.store);
				if (store.keyPath === null) store.put(row.value, row.key as IDBValidKey);
				else store.put(row.value);
			}
			for (const row of deletes) transaction.objectStore(row.store).delete(row.key as IDBValidKey);
			issued();
			await completion;
		} finally {
			db.close();
		}
	})();
	return Object.freeze({ started, committed });
}

/** Every key of one store (raw). */
export async function rowsOf(database: string, store: string): Promise<[unknown, unknown][]> {
	return (await dumpDatabase(database))[store] ?? [];
}

/** Flips the low bit of the last byte of the first byte field found (depth-first), or of a hex string. */
export function flipped(value: unknown): unknown {
	let changed = false;
	const walk = (item: unknown): unknown => {
		if (changed) return item;
		if (item instanceof Uint8Array) {
			const copy = Uint8Array.from(item);
			copy[copy.length - 1] = required(copy[copy.length - 1]) ^ 1;
			changed = true;
			return copy;
		}
		if (Array.isArray(item)) return item.map(walk);
		if (item !== null && typeof item === "object") {
			const out: Record<string, unknown> = {};
			for (const [key, field] of Object.entries(item)) out[key] = walk(field);
			return out;
		}
		return item;
	};
	const bytes = walk(value);
	if (changed) return bytes;
	const hex = (item: unknown): unknown => {
		if (changed) return item;
		if (typeof item === "string" && /^[0-9a-f]{64}$/.test(item)) {
			changed = true;
			return item.slice(0, -1) + (item.endsWith("0") ? "1" : "0");
		}
		if (Array.isArray(item)) return item.map(hex);
		if (item !== null && typeof item === "object") {
			const out: Record<string, unknown> = {};
			for (const [key, field] of Object.entries(item)) out[key] = hex(field);
			return out;
		}
		return item;
	};
	const result = hex(value);
	if (!changed) throw new TypeError("TRACK_M_NOTHING_TO_FLIP");
	return result;
}

/**
 * The same control with its revision advanced by two (a later, well-formed control), in
 * the control's own stored form: canonical bytes, a `record` carrier, a `value` row, or
 * the plain control.
 */
export function advancedControl(value: unknown): unknown {
	const bump = (control: unknown): unknown => {
		const record = control as Record<string, unknown>;
		if (typeof record.revision !== "number") throw new TypeError("TRACK_M_CONTROL_SHAPE");
		return { ...record, revision: record.revision + 2 };
	};
	const recode = (bytes: Uint8Array): Uint8Array => encodeCanonical(bump(decodeCanonical(bytes)));
	if (value instanceof Uint8Array) return recode(value);
	const row = value as Record<string, unknown>;
	if (row.record instanceof Uint8Array) return { ...row, record: recode(row.record) };
	if (
		row.value !== null &&
		typeof row.value === "object" &&
		typeof (row.value as Record<string, unknown>).revision === "number"
	)
		return { ...row, value: bump(row.value) };
	return bump(row);
}

/** What a hooked retention session saw and did. */
export interface RetentionTrap {
	/** Sessions in which `planRetention` was called (retention sessions). */
	readonly sessions: number;
	readonly plans: number;
	readonly applies: number;
	readonly checkpoints: number;
}

export interface RetentionHooks {
	/** Before the node's FIRST planRetention of a session (nothing of it has run yet). */
	beforeFirstPlan?(
		input: Readonly<{
			database: string;
			selection: Readonly<Record<string, unknown>>;
			owners: unknown;
			session: Record<string, unknown>;
		}>
	): Promise<void> | void;
	/** After each planRetention (its transaction is held). */
	afterPlan?(
		input: Readonly<{ database: string; planned: unknown; selection: Readonly<Record<string, unknown>> }>
	): Promise<void> | void;
	/** After each applyRetention returned (before its checkpoint). */
	afterApply?(
		input: Readonly<{
			database: string;
			applied: Readonly<Record<string, unknown>>;
			selection: Readonly<Record<string, unknown>>;
		}>
	): Promise<void> | void;
	/** After each checkpoint or commit committed. */
	afterCommit?(input: Readonly<{ database: string; kind: "checkpoint" | "commit" }>): Promise<void> | void;
	/** After an abort of a retention session finished. */
	afterAbort?(input: Readonly<{ database: string; cause: unknown }>): Promise<void> | void;
}

/**
 * Installs hooks around every room retirement session the node opens on this fixture's
 * host. Only sessions that call `planRetention` (the retention path) reach the hooks.
 */
export function trapRetention(fixture: LullFixture, hooks: RetentionHooks) {
	const counts = { sessions: 0, plans: 0, applies: 0, checkpoints: 0 };
	const wrap: SessionWrap = (session, _label, database) => {
		let retention = false;
		const call = (name: string) => session[name] as (...args: unknown[]) => Promise<unknown>;
		return Object.freeze({
			...session,
			planRetention: async (...args: unknown[]) => {
				const selection = args[1] as Readonly<Record<string, unknown>>;
				if (!retention) {
					retention = true;
					counts.sessions++;
					await hooks.beforeFirstPlan?.({ database, selection, owners: args[0], session });
				}
				counts.plans++;
				const planned = await call("planRetention")(...args);
				await hooks.afterPlan?.({ database, planned, selection });
				return planned;
			},
			applyRetention: async (...args: unknown[]) => {
				counts.applies++;
				const applied = (await call("applyRetention")(...args)) as Readonly<Record<string, unknown>>;
				await hooks.afterApply?.({ database, applied, selection: args[1] as Readonly<Record<string, unknown>> });
				return applied;
			},
			checkpoint: async () => {
				await call("checkpoint")();
				if (retention) {
					counts.checkpoints++;
					await hooks.afterCommit?.({ database, kind: "checkpoint" });
				}
			},
			commit: async () => {
				await call("commit")();
				if (retention) await hooks.afterCommit?.({ database, kind: "commit" });
			},
			abort: async (cause?: unknown) => {
				await call("abort")(cause);
				if (retention) await hooks.afterAbort?.({ database, cause });
			},
		});
	};
	fixture.host.setWrap(wrap);
	return Object.freeze({
		counts: (): RetentionTrap => ({ ...counts }),
		release: () => fixture.host.setWrap(undefined),
	});
}
