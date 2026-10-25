import { compareBytes } from "@ts-drp/canonical";
import type { LiveJournalRetirementImage } from "@ts-drp/live-journal";
import type { DatabaseSync } from "node:sqlite";

// Verify-once memo for live-journal retirement images, keyed by the exact
// native rows of one object.
//
// An image (its digest, counts and byte charge, plus the per-row frames when
// requested) is a pure function of the ordered sequence of rows it captured:
// table, column names and the exact column values. Every capture still scans
// those rows freshly under its original transaction, runs every fence and
// count check, and compares each row with a private copy of the rows that
// produced a remembered image. Only a complete, in-order, value-exact match of
// every row returns the remembered result; any write, rollback, reopen or
// other connection's commit that changes a row changes what is scanned, and the
// capture then runs as before. Nothing is keyed by revision or row identity,
// so nothing needs invalidating for soundness; bounds only cap memory.
//
// Remembered results are frozen primitives (the image) and private byte copies
// (frames and key values); callers receive fresh frame copies on every hit.

type NativeValue = string | number | null | Uint8Array;
/** One captured row: table, then alternating column names and private value copies. */
export type JournalImageRowKey = readonly unknown[];

interface JournalImageEntry {
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
	 * Refreshes recency after a complete exact match of every scanned row.
	 * @param objectId - Matched object.
	 */
	public touch(objectId: string): void {
		const entry = this.#entries.get(objectId);
		if (entry === undefined) return;
		this.#entries.delete(objectId);
		this.#entries.set(objectId, entry);
	}

	/**
	 * Remembers a successfully finished capture under private copies of its rows.
	 * @param objectId - Captured object.
	 * @param rows - Row keys from {@link journalImageRowKey}, in capture order.
	 * @param image - The finished frozen image.
	 * @param frames - The frames that capture produced, when requested.
	 */
	public remember(
		objectId: string,
		rows: readonly JournalImageRowKey[],
		image: LiveJournalRetirementImage,
		frames: readonly Uint8Array[] | undefined
	): void {
		const prior = this.#entries.get(objectId);
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
		if (bytes > this.#maxBytes) return;
		this.#entries.set(objectId, Object.freeze({ rows: Object.freeze([...rows]), image,
			frames: copies === undefined ? undefined : Object.freeze(copies), bytes }));
		this.#bytes += bytes;
		while (this.#entries.size > this.#maxObjects || this.#bytes > this.#maxBytes) {
			const [oldest, entry] = this.#entries.entries().next().value!;
			this.#entries.delete(oldest);
			this.#bytes -= entry.bytes;
		}
	}

	/** @returns Remembered object and byte counts, for bound tests. */
	public size(): Readonly<{ objects: number; bytes: number }> {
		return { objects: this.#entries.size, bytes: this.#bytes };
	}
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
