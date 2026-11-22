import { compareBytes, decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { AHE_BOUNDED_READ_LIMITS, type NativeReadReservation } from "@ts-drp/storage";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { SqliteNativeReadReservationOwner } from "./native-read-reservation.js";
import { enforceNativeLocalSessionFile, nativeLocalSessionSchemaRows, type LocalSessionLifetime } from "./local-session-lifetime.js";
import { connectionRevision } from "./sqlite-revision.js";
import { cachedStatement } from "./sqlite-statement-cache.js";

export type SigningTable = "signerState" | "sealEvidence" | "voteSlots" | "voteOutbox";
export type SigningKey = readonly [string, number, string] | readonly [string, number, number, string, string];

const TABLES: readonly SigningTable[] = ["signerState", "sealEvidence", "voteSlots", "voteOutbox"];
const ROW_SCHEMA =
	"CREATE TABLE signing_rows (family TEXT NOT NULL CHECK(family IN ('signerState','sealEvidence','voteSlots','voteOutbox')), object_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991), row_key BLOB NOT NULL, value BLOB NOT NULL, PRIMARY KEY(family,row_key)) WITHOUT ROWID";
const META_SCHEMA = "CREATE TABLE signing_meta (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL) WITHOUT ROWID";
const LIMITS = { maxBytes: AHE_BOUNDED_READ_LIMITS.maxUnionBytes, maxDepth: 128, maxItems: 65_536 };
const safe = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && !value.includes("\0");

/**
 * Same key order as the signing image, independent of SQLite's blob/string collation.
 * @param a
 * @param b
 */
function compareKeys(a: SigningKey, b: SigningKey): number {
	for (let index = 0; index < a.length; index++) {
		const left = a[index],
			right = b[index];
		if (left === undefined || right === undefined) throw new Error("INVALID_SIGNING_ADDRESS");
		if (left === right) continue;
		if (typeof left !== typeof right) throw new Error("INVALID_SIGNING_ADDRESS");
		return left < right ? -1 : 1;
	}
	return 0;
}

function captureKey(table: SigningTable, value: unknown): SigningKey {
	const short = table === "signerState" || table === "sealEvidence";
	if (!Array.isArray(value) || value.length !== (short ? 3 : 5)) throw new TypeError("INVALID_SIGNING_ADDRESS");
	const fields = Object.getOwnPropertyDescriptors(value);
	if (Reflect.ownKeys(fields).length !== value.length + 1) throw new TypeError("INVALID_SIGNING_ADDRESS");
	const key: unknown[] = [];
	for (let index = 0; index < value.length; index++) {
		const field = fields[String(index)];
		if (field === undefined || !("value" in field) || !field.enumerable) throw new TypeError("INVALID_SIGNING_ADDRESS");
		key.push(field.value);
	}
	if (
		!TABLES.includes(table) ||
		!text(key[0]) ||
		!safe(key[1]) ||
		!text(key.at(-1)) ||
		(!short && (!safe(key[2]) || !["prepare", "commit", "round-change"].includes(key[3] as string)))
	)
		throw new TypeError("INVALID_SIGNING_ADDRESS");
	encodeCanonical(key, LIMITS);
	return Object.freeze(key) as SigningKey;
}

/**
 * Mechanical SQLite custody for signing rows. It owns no vote, evidence or
 * retirement eligibility: callers must supply the original protocol decisions.
 * Both signing factories share this filename/incarnation, not an in-memory shim.
 */
export class SqliteSigningDatabase {
	readonly incarnation: string;
	readonly #database: DatabaseSync;
	readonly #reads: SqliteNativeReadReservationOwner;
	readonly #filename: string;
	readonly #fileIdentity: Readonly<{ dev: number; ino: number }>;
	#closed = false;
	#transaction = false;
	#writing = false;
	#closing?: Promise<void>;
	#readGroup?: { ready: Promise<NativeReadReservation>; children: number; releasing: boolean };
	// Revision memo for the repeated mechanical checks (catalog shape, incarnation currency), keyed
	// on the connection's exact revision (sqlite-revision.ts: total_changes, data_version,
	// schema_version on this connection). Equal revisions prove no row and no schema changed:
	// another connection's commit moves data_version, any own write (rolled back too) moves
	// total_changes, any DDL moves schema_version. A memo is recorded only inside a read
	// transaction (never where an own uncommitted write could later roll back), and own writes
	// also clear it explicitly.
	#catalogAt: string | undefined;
	#currencyAt: string | undefined;
	// A transaction pins one snapshot: its revision is read once, and again after an own write.
	#transactionRevision: string | undefined;

	get hasNativeReads(): boolean {
		return this.#readGroup !== undefined;
	}

	/**
	 *
	 * @param options
	 */
	constructor(options: Readonly<{ filename: string; initialization: "create" | "reopen" }>, session?: LocalSessionLifetime) {
		const fields = Object.getOwnPropertyDescriptors(options);
		if (
			Reflect.ownKeys(fields).length !== 2 ||
			!fields.filename ||
			!("value" in fields.filename) ||
			!fields.initialization ||
			!("value" in fields.initialization) ||
			!text(fields.filename.value) ||
			!["create", "reopen"].includes(fields.initialization.value as string)
		)
			throw new TypeError("INVALID_SIGNING_DATABASE");
		const filename = resolve(fields.filename.value as string),
			uri = pathToFileURL(filename);
		uri.searchParams.set("mode", fields.initialization.value === "reopen" ? "rw" : "rwc");
		const database = new DatabaseSync(uri.href, { allowExtension: false, enableDoubleQuotedStringLiterals: false });
		try {
			enforceNativeLocalSessionFile(database, filename, session, fields.initialization.value === "create");
			database.exec("PRAGMA busy_timeout=1000");
			if (fields.initialization.value === "create") {
				database.exec("BEGIN IMMEDIATE");
				try {
					const catalog = nativeLocalSessionSchemaRows(
						database,
						cachedStatement(database, "SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all()
					);
					if (catalog.length === 0) {
						database.exec(ROW_SCHEMA);
						database.exec(META_SCHEMA);
						cachedStatement(database, "INSERT INTO signing_meta(key,value) VALUES('incarnation',?)").run(
							encodeCanonical({ key: "incarnation", value: randomBytes(16).toString("hex") })
						);
					}
					database.exec("COMMIT");
				} catch (cause) {
					database.exec("ROLLBACK");
					throw cause;
				}
			}
			const catalog = nativeLocalSessionSchemaRows(
				database,
				cachedStatement(
					database,
					"SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
				).all()
			);
			if (
				catalog.length !== 2 ||
				catalog[0]?.type !== "table" ||
				catalog[0]?.name !== "signing_meta" ||
				catalog[0]?.sql !== META_SCHEMA ||
				catalog[1]?.type !== "table" ||
				catalog[1]?.name !== "signing_rows" ||
				catalog[1]?.sql !== ROW_SCHEMA
			)
				throw new Error("SIGNING_UNSUPPORTED_SCHEMA");
			if (fields.initialization.value === "create") database.exec("PRAGMA journal_mode=WAL");
			if (cachedStatement(database, "PRAGMA journal_mode").get()?.journal_mode !== "wal")
				throw new Error("SIGNING_UNSUPPORTED_DURABILITY");
			database.exec("PRAGMA synchronous=FULL");
			const raw = cachedStatement(
				database,
				"SELECT length(value) AS bytes FROM signing_meta WHERE key='incarnation'"
			).get();
			if (!safe(raw?.bytes) || raw.bytes > LIMITS.maxBytes) throw new Error("STORAGE_LOSS");
			const value = decodeCanonical(
				cachedStatement(database, "SELECT value FROM signing_meta WHERE key='incarnation'").get()?.value as Uint8Array,
				LIMITS
			);
			if (
				value === null ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Reflect.get(value, "key") !== "incarnation" ||
				Reflect.ownKeys(value).length !== 2 ||
				typeof Reflect.get(value, "value") !== "string" ||
				!/^[0-9a-f]{32}$/u.test(Reflect.get(value, "value") as string)
			)
				throw new Error("STORAGE_LOSS");
			this.incarnation = Reflect.get(value, "value") as string;
		} catch (cause) {
			database.close();
			throw cause;
		}
		this.#database = database;
		this.#filename = filename;
		const identity = statSync(filename);
		this.#fileIdentity = { dev: identity.dev, ino: identity.ino };
		this.#reads = new SqliteNativeReadReservationOwner(filename);
	}

	/** Each physical alias must independently present the original native custody. */
	enforceLocalCustody(session?: LocalSessionLifetime): void {
		this.#open();
		enforceNativeLocalSessionFile(this.#database, this.#filename, session, false);
	}

	#open(): void {
		if (this.#closed) throw new Error("STORE_CLOSED");
	}
	#within(): void {
		this.#open();
		if (!this.#transaction) throw new Error("SIGNING_TRANSACTION_REQUIRED");
	}
	#write(): void {
		this.#within();
		if (!this.#writing) throw new Error("SIGNING_READ_ONLY");
		this.#catalogAt = this.#currencyAt = this.#transactionRevision = undefined;
	}
	/** The transaction's exact revision (read once per snapshot; again after an own write). */
	#revision(): string {
		this.#within();
		if (this.#transactionRevision !== undefined) return this.#transactionRevision;
		let value: string;
		try {
			value = connectionRevision(this.#database);
		} catch {
			throw new Error("STORAGE_LOSS");
		}
		return (this.#transactionRevision = value);
	}
	/** A memo may be recorded only where no own uncommitted write can exist. */
	#memoizable(): boolean {
		return !this.#writing;
	}
	/** The path still names the file this connection opened. */
	#identity(): void {
		this.#open();
		let identity: ReturnType<typeof statSync>;
		try {
			identity = statSync(this.#filename);
		} catch {
			throw new Error("STORAGE_LOSS");
		}
		if (identity.dev !== this.#fileIdentity.dev || identity.ino !== this.#fileIdentity.ino)
			throw new Error("STORAGE_LOSS");
	}
	/**
	 * File identity, and inside a transaction the catalog of that transaction's own snapshot (the
	 * schema every statement of the transaction runs against). Outside a transaction only the identity:
	 * every caller outside one enters a transaction next, whose snapshot catalog is checked before its
	 * first read and again before its commit.
	 */
	#mechanics(): void {
		this.#identity();
		if (!this.#transaction) return;
		const revision = this.#revision();
		if (this.#catalogAt === revision) return;
		const catalog = nativeLocalSessionSchemaRows(
			this.#database,
			cachedStatement(
				this.#database,
				"SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
			).all()
		);
		if (
			catalog.length !== 2 ||
			catalog[0]?.type !== "table" ||
			catalog[0]?.name !== "signing_meta" ||
			catalog[0]?.sql !== META_SCHEMA ||
			catalog[1]?.type !== "table" ||
			catalog[1]?.name !== "signing_rows" ||
			catalog[1]?.sql !== ROW_SCHEMA
		)
			throw new Error("SIGNING_UNSUPPORTED_SCHEMA");
		if (this.#memoizable()) this.#catalogAt = revision;
	}

	/**
	 * The synchronous body and commit are one actual SQLite atomic transaction.
	 * @param write
	 * @param action
	 */
	transact<T>(write: boolean, action: () => T): T {
		this.#open();
		if (this.#transaction) throw new Error("SIGNING_NESTED_TRANSACTION");
		this.#identity();
		this.#database.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
		this.#transaction = true;
		this.#writing = write;
		this.#transactionRevision = undefined;
		try {
			this.#mechanics();
			this.assertCurrency();
			const result = action();
			if (
				result !== null &&
				(typeof result === "object" || typeof result === "function") &&
				typeof Reflect.get(result, "then") === "function"
			)
				throw new TypeError("SIGNING_ASYNC_TRANSACTION_BODY");
			this.#mechanics();
			this.assertCurrency();
			this.#database.exec("COMMIT");
			this.#identity();
			return result;
		} catch (cause) {
			try {
				this.#database.exec("ROLLBACK");
			} catch {
				/* Preserve the initiating native failure. */
			}
			throw cause;
		} finally {
			this.#transaction = false;
			this.#writing = false;
			this.#transactionRevision = undefined;
		}
	}

	/**
	 *
	 * @param key
	 */
	getMeta(key: string): unknown {
		this.#within();
		const width = cachedStatement(this.#database, "SELECT length(value) AS bytes FROM signing_meta WHERE key=?").get(
			key
		);
		if (width === undefined) return undefined;
		if (!safe(width.bytes) || width.bytes > LIMITS.maxBytes) throw new Error("SIGNING_IMAGE_FULL");
		return decodeCanonical(
			cachedStatement(this.#database, "SELECT value FROM signing_meta WHERE key=?").get(key)?.value as Uint8Array,
			LIMITS
		);
	}

	/**
	 *
	 * @param key
	 * @param value
	 */
	putMeta(key: string, value: unknown): void {
		this.#write();
		cachedStatement(
			this.#database,
			"INSERT INTO signing_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
		).run(key, encodeCanonical(value, LIMITS));
	}

	/**
	 *
	 * @param table
	 * @param input
	 */
	get(table: SigningTable, input: SigningKey): unknown {
		this.#within();
		const key = encodeCanonical(captureKey(table, input), LIMITS);
		const width = cachedStatement(
			this.#database,
			"SELECT length(value) AS bytes FROM signing_rows WHERE family=? AND row_key=?"
		).get(table, key);
		if (width === undefined) return undefined;
		if (!safe(width.bytes) || width.bytes > LIMITS.maxBytes) throw new Error("SIGNING_IMAGE_FULL");
		return decodeCanonical(
			cachedStatement(this.#database, "SELECT value FROM signing_rows WHERE family=? AND row_key=?").get(table, key)
				?.value as Uint8Array,
			LIMITS
		);
	}

	/**
	 *
	 * @param table
	 * @param input
	 * @param value
	 * @param add
	 */
	put(table: SigningTable, input: SigningKey, value: unknown, add = false): void {
		this.#write();
		const key = captureKey(table, input);
		const sql = add
			? "INSERT INTO signing_rows(family,object_id,epoch,row_key,value) VALUES(?,?,?,?,?)"
			: "INSERT INTO signing_rows(family,object_id,epoch,row_key,value) VALUES(?,?,?,?,?) ON CONFLICT(family,row_key) DO UPDATE SET value=excluded.value";
		cachedStatement(this.#database, sql).run(
			table,
			key[0],
			key[1],
			encodeCanonical(key, LIMITS),
			encodeCanonical(value, LIMITS)
		);
	}

	/**
	 *
	 * @param table
	 * @param key
	 */
	delete(table: SigningTable, key: SigningKey): boolean {
		this.#write();
		return (
			cachedStatement(this.#database, "DELETE FROM signing_rows WHERE family=? AND row_key=?").run(
				table,
				encodeCanonical(captureKey(table, key), LIMITS)
			).changes === 1
		);
	}

	/**
	 * Admit row counts/key/value lengths before any native value blob is copied.
	 * @param table
	 * @param objectId
	 */
	rows(table: SigningTable, objectId: string): readonly Readonly<{ key: SigningKey; value: unknown }>[] {
		if (!text(objectId)) throw new TypeError("INVALID_SIGNING_ADDRESS");
		return this.#loadRows(table, objectId);
	}

	/** Existing all-row restore surface, bounded before native value loading. */
	allRows(table: SigningTable): readonly Readonly<{ key: SigningKey; value: unknown }>[] {
		return this.#loadRows(table);
	}

	#loadRows(table: SigningTable, objectId?: string): readonly Readonly<{ key: SigningKey; value: unknown }>[] {
		this.#within();
		if (!TABLES.includes(table)) throw new TypeError("INVALID_SIGNING_ADDRESS");
		const where = objectId === undefined ? "family=?" : "family=? AND object_id=?";
		const args = objectId === undefined ? [table] : [table, objectId];
		const count = cachedStatement(
			this.#database,
			`SELECT count(*) AS count,coalesce(sum(length(row_key)+length(value)),0) AS bytes FROM signing_rows WHERE ${where}`
		).get(...args);
		if (!safe(count?.count) || count.count > 65_536 || !safe(count.bytes) || count.bytes > LIMITS.maxBytes)
			throw new Error("SIGNING_IMAGE_FULL");
		const rows = cachedStatement(
			this.#database,
			`SELECT row_key,object_id,epoch,value FROM signing_rows WHERE ${where}`
		)
			.all(...args)
			.map((row) => {
				const key = captureKey(table, decodeCanonical(row.row_key as Uint8Array, LIMITS));
				if (key[0] !== row.object_id || key[1] !== row.epoch) throw new Error("INVALID_SIGNING_ADDRESS");
				return Object.freeze({ key, value: decodeCanonical(row.value as Uint8Array, LIMITS) });
			});
		return Object.freeze(rows.sort((a, b) => compareKeys(a.key, b.key)));
	}

	/**
	 * Whole addressed payload admission precedes native key/value loading. Frames remain separately charged.
	 * @param objectId
	 */
	assertImagePayloadBound(objectId: string): void {
		this.#within();
		if (!text(objectId)) throw new TypeError("INVALID_SIGNING_ADDRESS");
		const rows = cachedStatement(
			this.#database,
			"SELECT count(*) AS count,coalesce(sum(length(row_key)+length(value)),0) AS bytes FROM signing_rows WHERE object_id=?"
		).get(objectId);
		const meta = cachedStatement(
			this.#database,
			"SELECT coalesce(sum(length(value)),0) AS bytes FROM signing_meta WHERE key IN ('incarnation',?,?)"
		).get(`ahe-retirement:${objectId}`, `signing-retirement:${objectId}`);
		if (
			!safe(rows?.count) ||
			rows.count + 3 > 65_536 ||
			!safe(rows.bytes) ||
			!safe(meta?.bytes) ||
			rows.bytes + meta.bytes > LIMITS.maxBytes
		)
			throw new Error("SIGNING_IMAGE_FULL");
	}

	/**
	 *
	 */
	assertCurrency(): void {
		this.#within();
		const revision = this.#revision();
		if (this.#currencyAt === revision) return;
		const meta = this.getMeta("incarnation");
		if (
			meta === undefined ||
			compareBytes(encodeCanonical(meta), encodeCanonical({ key: "incarnation", value: this.incarnation })) !== 0
		)
			throw new Error("STORAGE_LOSS");
		if (this.#memoizable()) this.#currencyAt = revision;
	}

	/**
	 *
	 */
	async acquireNativeRead(session?: LocalSessionLifetime): Promise<NativeReadReservation> {
		this.enforceLocalCustody(session);
		this.#mechanics();
		if (this.#readGroup?.releasing) throw new Error("NATIVE_READ_RESERVATION_BUSY");
		const group = (this.#readGroup ??= { ready: this.#reads.acquire(session), children: 0, releasing: false });
		group.children++;
		let held: NativeReadReservation;
		let released = false;
		let releaseTask: Promise<void> | undefined;
		const release = (): Promise<void> => {
			released = true;
			return (releaseTask ??= (async (): Promise<void> => {
				group.children--;
				if (group.children !== 0) return;
				group.releasing = true;
				try {
					await (await group.ready).release();
				} finally {
					if (this.#readGroup === group) this.#readGroup = undefined;
				}
			})());
		};
		try {
			held = await group.ready;
			this.#mechanics();
			this.transact(false, () => this.assertCurrency());
		} catch (cause) {
			try {
				await release();
			} catch (cleanup) {
				throw new AggregateError([cause, cleanup], "signing native read acquisition failed", { cause });
			}
			throw cause;
		}
		return Object.freeze({
			check: async (): Promise<void> => {
				if (released) throw new Error("NATIVE_READ_RESERVATION_RELEASED");
				this.#mechanics();
				await held.check();
				this.transact(false, () => this.assertCurrency());
			},
			release,
		});
	}

	/**
	 *
	 */
	close(): Promise<void> {
		this.#closed = true;
		this.#reads.revoke();
		return (this.#closing ??= this.#reads.close().finally(() => this.#database.close()));
	}
}
