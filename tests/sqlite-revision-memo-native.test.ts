import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { connectionRevision, RevisionReadMemo } from "../packages/storage-node/src/internal/sqlite-revision.js";

// Adversarial invalidation of RevisionReadMemo: a remembered read is served only while the connection's exact
// revision is unchanged. Any write by this connection (committed or rolled back), any commit by another
// connection (another store in this process included) and any schema change must make the next read load
// again; another connection's open (uncommitted) write is never seen; a write inside the window discards
// everything; a file replaced under the same path never makes the memo differ from what the same
// connection reads. Hits are private copies.

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
	const path = mkdtempSync(join(tmpdir(), "sqlite-revision-"));
	directories.push(path);
	return path;
}

function open(
	file = join(directory(), "db.sqlite"),
	mode = "WAL"
): { owner: DatabaseSync; other: DatabaseSync; file: string } {
	const owner = new DatabaseSync(file);
	owner.exec(`PRAGMA journal_mode=${mode}; CREATE TABLE IF NOT EXISTS t(k TEXT PRIMARY KEY, v BLOB)`);
	owner.prepare("INSERT OR REPLACE INTO t VALUES('a', x'01')").run();
	const other = new DatabaseSync(file);
	return { owner, other, file };
}

const fresh = (database: DatabaseSync): number[] => [
	...(database.prepare("SELECT v FROM t WHERE k='a'").get() as { v: Uint8Array }).v,
];

function readThrough(memo: RevisionReadMemo, database: DatabaseSync, loads: { count: number }): number[] {
	database.exec("BEGIN");
	try {
		memo.begin(database);
		const value = memo.load("a", () => {
			loads.count++;
			return (database.prepare("SELECT v FROM t WHERE k='a'").get() as { v: Uint8Array }).v;
		});
		// The memo never answers differently from the same connection in the same snapshot.
		expect([...value]).toEqual(fresh(database));
		return [...value];
	} finally {
		memo.end();
		database.exec("COMMIT");
	}
}

it("serves a remembered read only at an unchanged revision, as a private copy", () => {
	const { owner, other } = open();
	const memo = new RevisionReadMemo(16, 1 << 20);
	const loads = { count: 0 };
	expect(readThrough(memo, owner, loads)).toEqual([1]);
	expect(readThrough(memo, owner, loads)).toEqual([1]);
	expect(loads.count).toBe(1);
	// A hit is a private copy.
	owner.exec("BEGIN");
	memo.begin(owner);
	const first = memo.load("a", () => new Uint8Array());
	first[0] = 9;
	const second = memo.load("a", () => new Uint8Array());
	memo.end();
	owner.exec("COMMIT");
	expect([...second]).toEqual([1]);
	expect(first).not.toBe(second);
	expect(loads.count).toBe(1);

	// Another connection's commit.
	other.prepare("UPDATE t SET v=x'02' WHERE k='a'").run();
	expect(readThrough(memo, owner, loads)).toEqual([2]);
	expect(loads.count).toBe(2);

	// This connection's own commit.
	owner.prepare("UPDATE t SET v=x'03' WHERE k='a'").run();
	expect(readThrough(memo, owner, loads)).toEqual([3]);
	expect(loads.count).toBe(3);

	// A rolled-back own write discards the memo too (never proves a change, only costs a load).
	owner.exec("BEGIN IMMEDIATE");
	owner.prepare("UPDATE t SET v=x'04' WHERE k='a'").run();
	owner.exec("ROLLBACK");
	expect(readThrough(memo, owner, loads)).toEqual([3]);
	expect(loads.count).toBe(4);

	// A rolled-back write by another connection: no change, and nothing it wrote is ever served.
	other.exec("BEGIN IMMEDIATE");
	other.prepare("UPDATE t SET v=x'05' WHERE k='a'").run();
	other.exec("ROLLBACK");
	expect(readThrough(memo, owner, loads)).toEqual([3]);

	// A schema change by another connection.
	const before = connectionRevision(owner);
	other.exec("CREATE TABLE u(x)");
	expect(connectionRevision(owner)).not.toBe(before);
	const counted = loads.count;
	readThrough(memo, owner, loads);
	expect(loads.count).toBe(counted + 1);

	// Outside a begun window every read loads; begin outside a transaction is refused.
	memo.load("a", () => {
		loads.count++;
		return 0;
	});
	expect(loads.count).toBe(counted + 2);
	expect(() => memo.begin(owner)).toThrow("SQLITE_REVISION_OUTSIDE_TRANSACTION");
	owner.close();
	other.close();
});

it("never sees another connection's open write, and reloads once it commits", () => {
	const { owner, other } = open();
	const memo = new RevisionReadMemo(16, 1 << 20);
	const loads = { count: 0 };
	expect(readThrough(memo, owner, loads)).toEqual([1]);
	other.exec("BEGIN IMMEDIATE");
	other.prepare("UPDATE t SET v=x'07' WHERE k='a'").run();
	// Open, uncommitted: the owner's snapshot and the memo both still hold the committed value.
	expect(readThrough(memo, owner, loads)).toEqual([1]);
	other.exec("COMMIT");
	expect(readThrough(memo, owner, loads)).toEqual([7]);
	expect(loads.count).toBe(2);
	owner.close();
	other.close();
});

it("discards everything when the connection writes inside the window (contract breach)", () => {
	const { owner } = open();
	const memo = new RevisionReadMemo(16, 1 << 20);
	const loads = { count: 0 };
	readThrough(memo, owner, loads);
	owner.exec("BEGIN IMMEDIATE");
	memo.begin(owner);
	memo.load("a", () => new Uint8Array([1]));
	owner.prepare("UPDATE t SET v=x'08' WHERE k='a'").run();
	memo.end();
	owner.exec("ROLLBACK");
	// The window's revision moved: nothing remembered survives, the next read loads.
	expect(readThrough(memo, owner, loads)).toEqual([1]);
	expect(loads.count).toBe(2);
	owner.close();
});

it("two stores in one process: each memo sees the other's commits; separate files are independent", () => {
	const { owner: first, other: second, file } = open();
	const memoA = new RevisionReadMemo(16, 1 << 20);
	const memoB = new RevisionReadMemo(16, 1 << 20);
	const loadsA = { count: 0 };
	const loadsB = { count: 0 };
	expect(readThrough(memoA, first, loadsA)).toEqual([1]);
	expect(readThrough(memoB, second, loadsB)).toEqual([1]);
	second.prepare("UPDATE t SET v=x'0a' WHERE k='a'").run();
	expect(readThrough(memoA, first, loadsA)).toEqual([10]);
	expect(readThrough(memoB, second, loadsB)).toEqual([10]);
	first.prepare("UPDATE t SET v=x'0b' WHERE k='a'").run();
	expect(readThrough(memoB, second, loadsB)).toEqual([11]);
	expect(readThrough(memoA, first, loadsA)).toEqual([11]);
	expect([loadsA.count, loadsB.count]).toEqual([3, 3]);

	// A store on another file: its writes do not concern this memo, and this file's writes do not hit it.
	const { owner: elsewhere } = open();
	const memoC = new RevisionReadMemo(16, 1 << 20);
	const loadsC = { count: 0 };
	expect(readThrough(memoC, elsewhere, loadsC)).toEqual([1]);
	first.prepare("UPDATE t SET v=x'0c' WHERE k='a'").run();
	expect(readThrough(memoC, elsewhere, loadsC)).toEqual([1]);
	expect(readThrough(memoA, first, loadsA)).toEqual([12]);
	expect(file).toBeTypeOf("string");
	for (const database of [first, second, elsewhere]) database.close();
});

it("a file replaced under the same path never makes the memo differ from its own connection", () => {
	// Rollback journal on both sides: a WAL file left beside the path would belong to the original.
	const { owner, other, file } = open(undefined, "DELETE");
	const memo = new RevisionReadMemo(16, 1 << 20);
	const loads = { count: 0 };
	expect(readThrough(memo, owner, loads)).toEqual([1]);
	// Build a different database and move it over the path while the owner keeps its descriptor.
	other.close();
	const replacement = join(directory(), "replacement.sqlite");
	const built = new DatabaseSync(replacement);
	built.exec(
		"PRAGMA journal_mode=DELETE; CREATE TABLE t(k TEXT PRIMARY KEY, v BLOB); INSERT INTO t VALUES('a', x'0f')"
	);
	built.close();
	renameSync(replacement, file);
	// The owner still reads its original file (whose identity the stores check separately): the memo
	// agrees with it (readThrough asserts equality with a fresh read), and a new connection on the path
	// sees the replacement.
	expect(readThrough(memo, owner, loads)).toEqual(fresh(owner));
	const reopened = new DatabaseSync(file);
	expect(fresh(reopened)).toEqual([15]);
	const loadsNew = { count: 0 };
	expect(readThrough(new RevisionReadMemo(16, 1 << 20), reopened, loadsNew)).toEqual([15]);
	reopened.close();
	owner.close();
});
