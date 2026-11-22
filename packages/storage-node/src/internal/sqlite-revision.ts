import type { DatabaseSync } from "node:sqlite";

import { cachedStatement } from "./sqlite-statement-cache.js";

// Exact revision of one SQLite connection's view of its database, and a memo of
// pure read results keyed on it.
//
// The revision is (total_changes, data_version, schema_version), read in one
// statement on the owning connection:
// - total_changes counts every row this connection inserted, updated or deleted
//   (trigger and cascade changes included, rolled-back changes included);
// - data_version changes whenever ANY other connection (this process or another)
//   committed to the file since this connection last read it;
// - schema_version changes on every schema change by any connection.
// So two equal revisions read on the same connection prove that no row and no
// schema changed in between. A changed revision only discards the memo; it
// never proves a change. Read inside an explicit transaction, the revision
// pins the transaction's snapshot: the memoized results equal what the reads
// would return in that transaction.
//
// Use: inside the caller's own read transaction, call `begin` once, then
// `load` for each pure read, then `end` before the transaction ends. A
// transaction that writes must not use the memo (a write before `begin` could
// later roll back without changing total_changes back); `end` discards
// everything if the revision moved during use.
// Every hit returns a private deep copy (bytes included), so no caller can
// alter a remembered value or observe another caller's object.

const REVISION_SQL =
	"SELECT total_changes() AS c,(SELECT data_version FROM pragma_data_version) AS d,(SELECT schema_version FROM pragma_schema_version) AS s";

/**
 * Reads the connection's exact revision (see the module comment).
 * @param database - Owning connection.
 * @returns Opaque revision text; equal texts on one connection prove an unchanged database.
 */
export function connectionRevision(database: DatabaseSync): string {
	const row = cachedStatement(database, REVISION_SQL).get();
	const { c, d, s } = (row ?? {}) as Record<string, unknown>;
	if (![c, d, s].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0))
		throw new Error("SQLITE_REVISION_UNAVAILABLE");
	return `${String(c)}:${String(d)}:${String(s)}`;
}

/**
 * A private deep copy of a native read result: bytes, arrays and plain records
 * are copied; primitives are returned as they are.
 * @param value - A value built only from primitives, Uint8Array, arrays and plain records.
 * A frozen array or record is copied frozen.
 * @returns The copy and its retained byte size, or undefined for any other shape.
 */
function copied(value: unknown): { value: unknown; bytes: number } | undefined {
	if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
		return { value, bytes: typeof value === "string" ? value.length * 2 : 8 };
	if (value instanceof Uint8Array) return { value: Uint8Array.prototype.slice.call(value), bytes: value.byteLength };
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		let bytes = 16;
		for (const item of value) {
			const next = copied(item);
			if (next === undefined) return undefined;
			out.push(next.value);
			bytes += next.bytes;
		}
		return { value: Object.isFrozen(value) ? Object.freeze(out) : out, bytes };
	}
	const prototype = Object.getPrototypeOf(value) as unknown;
	if (typeof value !== "object" || (prototype !== Object.prototype && prototype !== null)) return undefined;
	const out: Record<string, unknown> = {};
	let bytes = 16;
	for (const [key, item] of Object.entries(value)) {
		const next = copied(item);
		if (next === undefined) return undefined;
		out[key] = next.value;
		bytes += next.bytes + key.length * 2;
	}
	return { value: Object.isFrozen(value) ? Object.freeze(out) : out, bytes };
}

/** Bounded memo of pure read results for one connection, valid for one exact revision. */
export class RevisionReadMemo {
	#revision: string | undefined;
	#entries = new Map<string, unknown>();
	#bytes = 0;
	#current = false;
	#database: DatabaseSync | undefined;

	/**
	 * @param maxEntries - Hard bound on remembered results.
	 * @param maxBytes - Hard bound on retained copies.
	 */
	public constructor(
		private readonly maxEntries: number,
		private readonly maxBytes: number
	) {}

	/**
	 * Starts use inside the caller's read transaction: reads the revision and
	 * keeps the remembered results only if it is unchanged.
	 * @param database - The owning connection, inside its read transaction.
	 */
	public begin(database: DatabaseSync): void {
		this.#current = false;
		// Outside an explicit transaction the reads would not share one snapshot.
		if ((database as { isTransaction?: boolean }).isTransaction === false) throw new Error("SQLITE_REVISION_OUTSIDE_TRANSACTION");
		const revision = connectionRevision(database);
		if (revision !== this.#revision) this.clear();
		this.#revision = revision;
		this.#database = database;
		this.#current = true;
	}

	/**
	 * Ends use (before the transaction ends); the next use must begin again. If
	 * the connection wrote during use (a contract breach), everything is discarded.
	 */
	public end(): void {
		const database = this.#database;
		const current = this.#current;
		this.#current = false;
		this.#database = undefined;
		if (!current || database === undefined) return;
		try {
			if (connectionRevision(database) !== this.#revision) this.clear();
		} catch {
			this.clear();
		}
	}

	/** Discards every remembered result. */
	public clear(): void {
		this.#entries.clear();
		this.#bytes = 0;
		this.#revision = undefined;
	}

	/**
	 * Returns a private copy of the remembered result for `key`, or loads it.
	 * Outside a begun transaction it always loads. A failed load is not remembered.
	 * @param key - Exact identity of the pure read.
	 * @param load - The original read.
	 * @returns The read result (a private copy on a hit).
	 */
	public load<T>(key: string, load: () => T): T {
		if (!this.#current) return load();
		if (this.#entries.has(key)) return copied(this.#entries.get(key))?.value as T;
		const value = load();
		const kept = copied(value);
		if (kept !== undefined) {
			if (this.#entries.size >= this.maxEntries || this.#bytes + kept.bytes > this.maxBytes) {
				this.#entries.clear();
				this.#bytes = 0;
			}
			if (kept.bytes <= this.maxBytes) {
				this.#entries.set(key, kept.value);
				this.#bytes += kept.bytes;
			}
		}
		return value;
	}
}
