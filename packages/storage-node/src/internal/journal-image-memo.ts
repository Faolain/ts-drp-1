import { compareBytes } from "@ts-drp/canonical";
import type { LiveJournalRetirementImage } from "@ts-drp/live-journal";
import type { DatabaseSync } from "node:sqlite";

import { configuredStatement } from "./sqlite-statement-cache.js";

// Verify-once memo for live-journal retirement images, keyed by the exact
// native rows of one object.
//
// An image (its digest, counts and byte charge, plus the per-row frames when
// requested) is a pure function of the ordered sequence of rows it captured:
// table, column names and the exact column values. Unless the database is
// provably unchanged (below), a capture scans those rows freshly under its
// original transaction, runs every fence and count check, and compares each
// row with a private copy of the rows that produced a remembered image. Only a
// complete, in-order, value-exact match of every row returns the remembered
// result; any write, rollback, reopen or other connection's commit that changes
// a row changes what is scanned, and the capture then runs as before. Rows are
// not keyed by revision or row identity, so a scan needs no invalidation for
// soundness; bounds only cap memory. A frameless capture also keeps its rows'
// frames, so a later point read of the same rows needs no second capture.
//
// Remembered results are frozen primitives (the image) and private byte copies
// (frames and key values); callers receive fresh frame copies on every hit.
//
// Unchanged-database answers (no scan). A capture of committed rows also
// records the connection's currency: PRAGMA data_version (moves on every commit
// by any other connection this connection observes), total_changes() (moves on
// every row this connection inserts, updates or deletes, including writes later
// rolled back, and never moves back) and schema_version (catches DDL, which
// total_changes() does not count). Rows are committed rows when this connection
// has changed no row and run no DDL since a moment it was outside every
// transaction (beginJournalTransaction, recorded right after a successful BEGIN):
// otherwise an own uncommitted write could still roll back. While all three
// values equal a recorded currency and the rows are committed, the committed
// database the remembered capture scanned is the one a scan would read now, so
// the remembered result is returned without the scan. Any change, rollback,
// reopen, DDL or other commit moves a value, and the capture then runs as above.

/** A connection's change currency (see above): equal currencies of committed rows mean unchanged rows. */
export type JournalImageCurrency = Readonly<{ dataVersion: number; totalChanges: number; schemaVersion: number }>;

type NativeValue = string | number | null | Uint8Array;
/** One captured row: table, then alternating column names and private value copies. */
export type JournalImageRowKey = readonly unknown[];

/** One remembered verified capture. Its identity is private to this module's callers in this package. */
export interface JournalImageEntry {
	readonly rows: readonly JournalImageRowKey[];
	readonly image: LiveJournalRetirementImage;
	readonly frames: readonly Uint8Array[] | undefined;
	readonly bytes: number;
}

const ROW_OVERHEAD = 64,
	VALUE_OVERHEAD = 16;

/** Bounded per-connection memo of the last verified image of each object. */
export class JournalRetirementImageMemo {
	readonly #maxObjects: number;
	readonly #maxBytes: number;
	// Map insertion order is the eviction order; a hit refreshes its object.
	readonly #entries = new Map<string, JournalImageEntry>();
	// The currency of committed rows each remembered capture equals, when one was observed.
	readonly #currencies = new Map<string, JournalImageCurrency>();
	#bytes = 0;

	/**
	 * @param maxObjects - Hard bound on remembered objects.
	 * @param maxBytes - Hard bound on retained row and frame copies.
	 */
	public constructor(maxObjects: number, maxBytes: number) {
		this.#maxObjects = maxObjects;
		this.#maxBytes = maxBytes;
	}

	/**
	 * @param objectId - Object whose rows are about to be scanned.
	 * @param withFrames - Whether the capture must also deliver per-row frames.
	 * @returns The remembered rows and result to compare against, or undefined.
	 */
	public candidate(objectId: string, withFrames: boolean): Readonly<JournalImageEntry> | undefined {
		const entry = this.#entries.get(objectId);
		return entry === undefined || (withFrames && entry.frames === undefined) ? undefined : entry;
	}

	/**
	 * The remembered result for an unchanged database, without a scan.
	 * @param objectId - Object about to be captured.
	 * @param withFrames - Whether the capture must also deliver per-row frames.
	 * @param currency - The connection's currency now, defined only for committed rows.
	 * @returns The remembered entry when its recorded currency equals `currency`, refreshed; otherwise undefined.
	 */
	public unchanged(
		objectId: string,
		withFrames: boolean,
		currency: JournalImageCurrency | undefined
	): Readonly<JournalImageEntry> | undefined {
		if (currency === undefined) return undefined;
		const entry = this.candidate(objectId, withFrames),
			recorded = this.#currencies.get(objectId);
		if (entry === undefined || recorded === undefined || !sameCurrency(recorded, currency)) return undefined;
		this.touch(objectId);
		return entry;
	}

	/**
	 * Refreshes recency after a complete exact match of every scanned row.
	 * @param objectId - Matched object.
	 * @param currency - The currency of the committed rows just scanned, if they were committed.
	 */
	public touch(objectId: string, currency?: JournalImageCurrency): void {
		const entry = this.#entries.get(objectId);
		if (entry === undefined) return;
		this.#entries.delete(objectId);
		this.#entries.set(objectId, entry);
		if (currency !== undefined) this.#currencies.set(objectId, currency);
	}

	/**
	 * Remembers a successfully finished capture under private copies of its rows.
	 * @param objectId - Captured object.
	 * @param rows - Row keys from {@link journalImageRowKey}, in capture order.
	 * @param image - The finished frozen image.
	 * @param frames - The frames that capture produced, when requested.
	 * @param currency - The currency of the committed rows captured, if they were committed.
	 */
	public remember(
		objectId: string,
		rows: readonly JournalImageRowKey[],
		image: LiveJournalRetirementImage,
		frames: readonly Uint8Array[] | undefined,
		currency?: JournalImageCurrency
	): Readonly<JournalImageEntry> | undefined {
		const prior = this.#entries.get(objectId);
		this.#currencies.delete(objectId);
		if (prior !== undefined) {
			this.#entries.delete(objectId);
			this.#bytes -= prior.bytes;
		}
		let bytes = 0;
		for (const row of rows) {
			bytes += ROW_OVERHEAD;
			for (const value of row) bytes += VALUE_OVERHEAD + valueBytes(value);
		}
		const copies = frames?.map((frame) => frame.slice());
		for (const frame of copies ?? []) bytes += VALUE_OVERHEAD + frame.byteLength;
		if (bytes > this.#maxBytes) return undefined;
		const entry: JournalImageEntry = Object.freeze({ rows: Object.freeze([...rows]), image,
			frames: copies === undefined ? undefined : Object.freeze(copies), bytes });
		this.#entries.set(objectId, entry);
		this.#bytes += bytes;
		if (currency !== undefined) this.#currencies.set(objectId, currency);
		while (this.#entries.size > this.#maxObjects || this.#bytes > this.#maxBytes) {
			const [oldest, evicted] = this.#entries.entries().next().value!;
			this.#entries.delete(oldest);
			this.#currencies.delete(oldest);
			this.#bytes -= evicted.bytes;
		}
		return this.#entries.get(objectId) === entry ? entry : undefined;
	}

	/**
	 * @param objectId - Remembered object.
	 * @returns Its remembered entry (the one the last capture, match or unchanged answer of it verified), if any.
	 */
	public current(objectId: string): Readonly<JournalImageEntry> | undefined {
		return this.#entries.get(objectId);
	}

	/**
	 * Records the currency of committed rows that a still-current entry equals, after the caller proved
	 * the committed database is exactly the rows that entry captured (see the drain CAS in live-journal.ts).
	 * @param objectId - Remembered object.
	 * @param entry - The entry the caller proved; nothing is recorded when it is no longer current.
	 * @param currency - The connection's currency of those committed rows.
	 */
	public adopt(objectId: string, entry: Readonly<JournalImageEntry>, currency: JournalImageCurrency): void {
		if (this.#entries.get(objectId) === entry) this.#currencies.set(objectId, currency);
	}

	/** @returns Remembered object and byte counts, for bound tests. */
	public size(): Readonly<{ objects: number; bytes: number }> {
		return { objects: this.#entries.size, bytes: this.#bytes };
	}
}

function sameCurrency(left: JournalImageCurrency, right: JournalImageCurrency): boolean {
	return (
		left.dataVersion === right.dataVersion &&
		left.totalChanges === right.totalChanges &&
		left.schemaVersion === right.schemaVersion
	);
}

// The currency of each connection right after its last successful BEGIN: a
// moment it was outside every transaction, so every own change before it is
// committed or rolled back. Retained per connection object, unreachable with it.
const outsideTransaction = new WeakMap<DatabaseSync, JournalImageCurrency>();

/**
 * @param database - The connection.
 * @returns Its currency now (inside or outside a transaction), whether or not its rows are committed.
 */
export function journalConnectionCurrency(database: DatabaseSync): JournalImageCurrency {
	return readCurrency(database);
}

function readCurrency(database: DatabaseSync): JournalImageCurrency {
	const row = configuredStatement(
		database,
		"SELECT (SELECT data_version FROM pragma_data_version) AS d,total_changes() AS t,(SELECT schema_version FROM pragma_schema_version) AS s"
	).get();
	const dataVersion = row?.d,
		totalChanges = row?.t,
		schemaVersion = row?.s;
	if (!Number.isSafeInteger(dataVersion) || !Number.isSafeInteger(totalChanges) || !Number.isSafeInteger(schemaVersion))
		throw new Error("store-poisoned");
	return Object.freeze({
		dataVersion: dataVersion as number,
		totalChanges: totalChanges as number,
		schemaVersion: schemaVersion as number,
	});
}

/**
 * Begins a transaction and records the connection's change count at that moment
 * (BEGIN itself changes no row, and succeeds only outside every transaction).
 * @param database - The connection.
 * @param sql - "BEGIN" or "BEGIN IMMEDIATE".
 */
export function beginJournalTransaction(database: DatabaseSync, sql: "BEGIN" | "BEGIN IMMEDIATE"): void {
	database.exec(sql);
	try {
		outsideTransaction.set(database, readCurrency(database));
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

/**
 * The connection's currency, read before any row of the capture: the first read
 * of a transaction fixes its snapshot, and data_version then describes it.
 * @param database - The connection, inside a transaction begun by {@link beginJournalTransaction} or later.
 * @returns The currency when every visible row is committed (no own row change and
 * no DDL since the connection was last outside a transaction); otherwise undefined.
 */
export function journalImageCurrency(database: DatabaseSync): JournalImageCurrency | undefined {
	const currency = readCurrency(database),
		outside = outsideTransaction.get(database);
	return outside !== undefined &&
		outside.totalChanges === currency.totalChanges &&
		outside.schemaVersion === currency.schemaVersion
		? currency
		: undefined;
}

function valueBytes(value: unknown): number {
	if (typeof value === "string") return value.length * 2;
	return value instanceof Uint8Array ? value.byteLength : 8;
}

/**
 * Private key of one captured row. Only native SQLite scalar values are keyable.
 * @param table - Native table name.
 * @param row - The exact captured row, after any membership substitution.
 * @returns A frozen key with private byte copies, or undefined for any other value.
 */
export function journalImageRowKey(table: string, row: Readonly<Record<string, unknown>>): JournalImageRowKey | undefined {
	const key: unknown[] = [table];
	for (const column of Object.keys(row)) {
		const value = row[column];
		if (!nativeValue(value)) return undefined;
		key.push(column, value instanceof Uint8Array ? value.slice() : value);
	}
	return Object.freeze(key);
}

/**
 * Exact comparison of a scanned row with a remembered key.
 * @param key - Remembered row key.
 * @param table - Native table name of the scanned row.
 * @param row - The exact captured row, after any membership substitution.
 * @returns Whether table, column order and every value are identical.
 */
export function journalImageRowMatches(key: JournalImageRowKey, table: string, row: Readonly<Record<string, unknown>>): boolean {
	const columns = Object.keys(row);
	if (key.length !== 1 + 2 * columns.length || key[0] !== table) return false;
	for (let index = 0; index < columns.length; index++) {
		const column = columns[index]!,
			remembered = key[1 + 2 * index + 1],
			value = row[column];
		if (key[1 + 2 * index] !== column || !nativeValue(value)) return false;
		if (value instanceof Uint8Array) {
			if (!(remembered instanceof Uint8Array) || compareBytes(remembered, value) !== 0) return false;
		} else if (!Object.is(remembered, value)) return false;
	}
	return true;
}

function nativeValue(value: unknown): value is NativeValue {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		(value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype)
	);
}

// Retained per connection object and unreachable with it. 4 objects and 8 MiB
// cover several full-size (2 MiB) images with their frames.
const memos = new WeakMap<DatabaseSync, JournalRetirementImageMemo>();

/**
 * @param database - The connection whose captures are memoized.
 * @returns That connection's memo.
 */
export function journalRetirementImageMemo(database: DatabaseSync): JournalRetirementImageMemo {
	let memo = memos.get(database);
	if (memo === undefined) {
		memo = new JournalRetirementImageMemo(4, 8 * 1024 * 1024);
		memos.set(database, memo);
	}
	return memo;
}
