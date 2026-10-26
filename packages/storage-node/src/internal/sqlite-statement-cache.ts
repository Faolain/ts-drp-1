import { DatabaseSync, type StatementSync } from "node:sqlite";

// Per-connection reuse of native prepared statements.
//
// Ownership: entries are keyed by the connection object, then by the exact SQL
// text, so a statement can never cross connections. node:sqlite finalizes every
// statement of a connection when it closes; each hit re-checks that, and a
// finalized hit drops the connection's whole entry. No statement therefore
// outlives its connection incarnation, including close() followed by open() on
// the same object. A closed connection reaches native prepare, which throws
// exactly as an uncached acquisition did.
//
// Retention: a StatementSync holds its DatabaseSync through a native strong
// reference, so a cache entry pins its connection regardless of JavaScript
// reachability; a WeakMap entry would never die and every connection ever
// opened would stay in the heap. Entries are therefore owned by a strong map
// and released by a sweep that drops every closed (finalized) connection.
// The sweep runs when the map reaches twice its live size after the previous
// sweep (at least SWEEP_FLOOR), so it is amortized O(1) per new connection and
// retained closed connections are bounded by the live set, not by history.
//
// Transparency: reuse applies only while prepare is the native implementation.
// When prepare has been replaced (instrumentation or fault injection), every
// acquisition goes through the replacement, uncached, and its statement is
// used exactly as the call site used a fresh one before.
//
// Statement state: node:sqlite resets a statement and clears its bindings on
// every all/get/run, so reuse is equivalent to a fresh statement. Cached
// statements are configured once with readBigInts=false (the Node default and
// what the module helpers set); callers never change their options. Sites that
// iterate, or set statement options, keep their own fresh statements: a shared
// live cursor would be reset by any other use of the same text.
const NATIVE_PREPARE = nativePrepare();
// A safety bound on distinct texts per connection; SQL texts are fixed or
// interpolate bounded constants, so this is never reached in practice.
const MAX_STATEMENTS_PER_CONNECTION = 1024;
const SWEEP_FLOOR = 16;
const connections = new Map<DatabaseSync, Map<string, StatementSync>>();
let sweepAt = SWEEP_FLOOR;

function sweepClosedConnections(): void {
	for (const [database, statements] of connections) {
		const first = statements.values().next();
		if (first.done === true || !live(first.value)) connections.delete(database);
	}
	sweepAt = Math.max(SWEEP_FLOOR, 2 * connections.size);
}

function nativePrepare(): DatabaseSync["prepare"] | undefined {
	const prepare = DatabaseSync.prototype.prepare;
	return typeof prepare === "function" &&
		/^function prepare\(\) \{\s*\[native code\]\s*\}$/u.test(Function.prototype.toString.call(prepare))
		? prepare
		: undefined;
}

function configured(statement: StatementSync): StatementSync {
	statement.setReadBigInts(false);
	return statement;
}

function live(statement: StatementSync): boolean {
	try {
		return typeof statement.sourceSQL === "string";
	} catch {
		return false; // "statement has been finalized": its connection incarnation ended.
	}
}

/**
 * Acquires the connection's prepared statement for exactly this SQL text.
 * Use only with all/get/run/columns; never iterate or change its options.
 * With an interposed prepare it returns the interposer's statement untouched.
 * @param database - Owning connection.
 * @param sql - Exact SQL text.
 * @returns A reset statement owned by this connection incarnation.
 */
export function cachedStatement(database: DatabaseSync, sql: string): StatementSync {
	return acquire(database, sql, false);
}

/**
 * As {@link cachedStatement}, for sites that always configured readBigInts=false
 * themselves; an interposed prepare's statement is configured the same way.
 * @param database - Owning connection.
 * @param sql - Exact SQL text.
 * @returns A reset, readBigInts=false statement owned by this connection incarnation.
 */
export function configuredStatement(database: DatabaseSync, sql: string): StatementSync {
	return acquire(database, sql, true);
}

function acquire(database: DatabaseSync, sql: string, configure: boolean): StatementSync {
	if (NATIVE_PREPARE === undefined || database.prepare !== NATIVE_PREPARE) {
		const interposed = database.prepare(sql);
		return configure ? configured(interposed) : interposed;
	}
	let statements = connections.get(database);
	const cached = statements?.get(sql);
	if (cached !== undefined) {
		if (live(cached)) return cached;
		connections.delete(database);
		statements = undefined;
	}
	const prepared = configured(database.prepare(sql));
	if (statements === undefined) {
		if (connections.size >= sweepAt) sweepClosedConnections();
		statements = new Map();
		connections.set(database, statements);
	}
	if (statements.size < MAX_STATEMENTS_PER_CONNECTION) statements.set(sql, prepared);
	return prepared;
}
