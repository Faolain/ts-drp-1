// Iteration statements are checked out exclusively: reused only after their iteration finished
// (exhausted, failed or closed early), never while a cursor is live, never across connections or
// after the connection closed, and always equivalent to a fresh statement.
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

import { iterateSqliteRows } from "../src/internal/sqlite-iterator.js";
import { iterationStatement } from "../src/internal/sqlite-statement-cache.js";

const SQL = "SELECT v FROM t WHERE v>=? ORDER BY v";
function open(): DatabaseSync {
	const database = new DatabaseSync(":memory:");
	database.exec("CREATE TABLE t(v INTEGER); INSERT INTO t VALUES (1),(2),(3)");
	return database;
}
const values = (database: DatabaseSync, from = 1): number[] =>
	[...iterateSqliteRows(iterationStatement(database, SQL), from)].map((row) => Number(row.v));

test("a finished iteration returns its statement; a live one never shares it", () => {
	const database = open();
	const first = iterationStatement(database, SQL);
	expect([...iterateSqliteRows(first, 1)].map((row) => Number(row.v))).toEqual([1, 2, 3]);
	// Exhausted: the same statement is reused, reset, with new bindings.
	const second = iterationStatement(database, SQL);
	expect(second).toBe(first);
	const live = iterateSqliteRows(second, 2);
	expect(Number(live.next().value?.v)).toBe(2);
	// While that cursor is live, the same text gets a different statement, and neither disturbs the other.
	const concurrent = iterationStatement(database, SQL);
	expect(concurrent).not.toBe(second);
	expect([...iterateSqliteRows(concurrent, 1)].map((row) => Number(row.v))).toEqual([1, 2, 3]);
	expect(Number(live.next().value?.v)).toBe(3);
	expect(live.next().done).toBe(true);
	database.close();
});

test("early close returns the statement; an abandoned cursor keeps it; results equal fresh statements", () => {
	const database = open();
	const statement = iterationStatement(database, SQL);
	for (const row of iterateSqliteRows(statement, 1)) {
		expect(Number(row.v)).toBe(1);
		break; // return(): the statement comes back reset
	}
	expect(iterationStatement(database, SQL)).toBe(statement);
	const abandoned = iterateSqliteRows(statement, 1);
	abandoned.next();
	// Never finished: not returned, so a new statement is prepared and the old cursor is intact.
	const other = iterationStatement(database, SQL);
	expect(other).not.toBe(statement);
	expect(values(database, 2)).toEqual([2, 3]);
	expect(Number(abandoned.next().value?.v)).toBe(2);
	expect([...database.prepare(SQL).iterate(1)].map((row) => Number(row.v))).toEqual(values(database));
	database.close();
});

test("statements never cross connections or survive close", () => {
	const a = open();
	const b = open();
	const fromA = iterationStatement(a, SQL);
	expect(values(a)).toEqual([1, 2, 3]);
	[...iterateSqliteRows(fromA, 1)];
	expect(iterationStatement(b, SQL)).not.toBe(fromA);
	a.close();
	const reopened = new DatabaseSync(":memory:");
	reopened.exec("CREATE TABLE t(v INTEGER); INSERT INTO t VALUES (9)");
	expect(values(reopened)).toEqual([9]);
	expect(() => iterationStatement(a, SQL)).toThrow();
	b.close();
	reopened.close();
});
