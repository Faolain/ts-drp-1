// Adversarial invalidation at the revision-memo call sites of the steady move path: the signing
// database's catalog/incarnation checks and the room head's readRetirementImage. Each case shows a
// stale value is never served: the memoized answer always equals what the same connection reads
// uncached (or the check refuses), for another connection's commit, an own commit, own and foreign
// rolled-back writes, another connection's open write, a write inside a still-open transaction, DDL,
// a file replaced under the same path, two stores in one process, and a reopened connection (whose
// revision restarts).
// Positive controls show the memo does hit when nothing changed.
import { encodeCanonical } from "@ts-drp/canonical";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { SqliteSigningDatabase } from "../src/internal/signing-database.js";
import { createNodeRoomHeadAuthority, type NodeRoomHeadAuthority } from "../src/room-head.js";

const directories: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function file(name: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-revision-sites-"));
	directories.push(directory);
	return join(directory, name);
}
function raw(path: string): DatabaseSync {
	const database = new DatabaseSync(path);
	database.exec("PRAGMA busy_timeout=1000");
	closers.push(() => {
		if (database.isOpen) database.close();
	});
	return database;
}
/**
 * Counts executions of statements whose SQL matches (a statement-level spy, restored after the test).
 * @param pattern
 */
function spy(pattern: RegExp): { readonly count: number } {
	const counter = { count: 0 };
	const prototype = StatementSync.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	for (const method of ["get", "all", "iterate", "run"]) {
		const original = prototype[method];
		if (original === undefined) throw new TypeError(`StatementSync.${method} is missing`);
		prototype[method] = function (this: StatementSync, ...args: unknown[]): unknown {
			if (pattern.test(this.sourceSQL)) counter.count++;
			return original.apply(this, args);
		};
		closers.push(() => {
			prototype[method] = original;
		});
	}
	return counter;
}

// ---------------------------------------------------------------- signing database
function signing(path: string, initialization: "create" | "reopen" = "create"): SqliteSigningDatabase {
	const database = new SqliteSigningDatabase({ filename: path, initialization });
	closers.push(() => database.close());
	return database;
}
const read = (database: SqliteSigningDatabase): unknown =>
	database.transact(false, () => database.getMeta("incarnation"));
const incarnationBytes = (value: string): Uint8Array => encodeCanonical({ key: "incarnation", value });

test("signing database: catalog and incarnation memos hit only at an unchanged revision", async () => {
	const path = await file("signing.sqlite");
	const database = signing(path);
	const catalog = spy(/FROM sqlite_schema/u);
	const incarnation = spy(/FROM signing_meta WHERE key=\?/u);
	read(database);
	const [catalogAfterFirst, metaAfterFirst] = [catalog.count, incarnation.count];
	read(database);
	read(database);
	// Positive control: unchanged revision, no catalog scan and only the body's own getMeta.
	expect(catalog.count).toBe(catalogAfterFirst);
	expect(incarnation.count - metaAfterFirst).toBe(2 * 2); // getMeta = width + value statement

	// Another connection commits an unrelated row: revision moves, both checks run again (and pass).
	const other = raw(path);
	other.prepare("INSERT INTO signing_meta(key,value) VALUES('unrelated', x'00')").run();
	const before = catalog.count;
	read(database);
	expect(catalog.count).toBeGreaterThan(before);

	// Another connection commits a foreign incarnation: refused, never the remembered acceptance.
	other.prepare("UPDATE signing_meta SET value=? WHERE key='incarnation'").run(incarnationBytes("foreign"));
	expect(() => read(database)).toThrow("STORAGE_LOSS");
	other.prepare("UPDATE signing_meta SET value=? WHERE key='incarnation'").run(incarnationBytes(database.incarnation));
	read(database);

	// A foreign write that is rolled back changes nothing and is never seen.
	other.exec("BEGIN IMMEDIATE");
	other.prepare("UPDATE signing_meta SET value=? WHERE key='incarnation'").run(incarnationBytes("rolled-back"));
	other.exec("ROLLBACK");
	read(database);

	// Another connection's open (uncommitted) write is invisible; once committed it is refused.
	other.exec("BEGIN IMMEDIATE");
	other.prepare("UPDATE signing_meta SET value=? WHERE key='incarnation'").run(incarnationBytes("open"));
	read(database);
	other.exec("COMMIT");
	expect(() => read(database)).toThrow("STORAGE_LOSS");
	other.prepare("UPDATE signing_meta SET value=? WHERE key='incarnation'").run(incarnationBytes(database.incarnation));
	read(database);

	// Foreign DDL: schema_version moves and the catalog check refuses the changed schema.
	other.exec("CREATE TABLE intruder(x)");
	expect(() => read(database)).toThrow("SIGNING_UNSUPPORTED_SCHEMA");
	other.exec("DROP TABLE intruder");
	read(database);
});

test("signing database: own writes - committed, rolled back, and inside the open transaction", async () => {
	const path = await file("signing.sqlite");
	const database = signing(path);
	read(database);
	// A write inside the still-open transaction is checked at its end: an own incarnation change is
	// refused there (the memo recorded before the write is never consulted after it).
	expect(() =>
		database.transact(true, () => {
			database.putMeta("incarnation", { key: "incarnation", value: "own" });
			return null;
		})
	).toThrow("STORAGE_LOSS");
	read(database);
	// A rolled-back own write (body throws after writing): the next transaction re-checks and passes.
	const catalog = spy(/FROM sqlite_schema/u);
	expect(() =>
		database.transact(true, () => {
			database.putMeta("incarnation", { key: "incarnation", value: "rolled-back" });
			throw new Error("BODY_FAILED");
		})
	).toThrow("BODY_FAILED");
	const afterRollback = catalog.count;
	expect(read(database)).toEqual({ key: "incarnation", value: database.incarnation });
	// total_changes moved with the rolled-back write, so the read transaction checked again.
	expect(catalog.count).toBeGreaterThan(afterRollback);
	// A committed own write of an unrelated row: the next read transaction checks again and passes.
	database.transact(true, () => database.putMeta("unrelated", 1));
	const afterCommit = catalog.count;
	read(database);
	expect(catalog.count).toBeGreaterThan(afterCommit);
});

test("signing database: a file replaced under the same path, two stores, and a reopened connection", async () => {
	const first = await file("a.sqlite");
	const second = await file("b.sqlite");
	const a = signing(first);
	const b = signing(second);
	read(a);
	read(b);
	// Two stores in one process: a foreign incarnation in b's file refuses b only.
	raw(second).prepare("UPDATE signing_meta SET value=? WHERE key='incarnation'").run(incarnationBytes("foreign"));
	read(a);
	expect(() => read(b)).toThrow("STORAGE_LOSS");
	// Replace a's file under its path with another valid signing store: identity refuses before any memo.
	const replacement = await file("replacement.sqlite");
	await signing(replacement).close();
	await rename(replacement, first);
	expect(() => read(a)).toThrow("STORAGE_LOSS");
	// A reopened connection starts its own revision (and memo): it reads the file now at the path.
	const reopened = signing(first, "reopen");
	expect(read(reopened)).toEqual({ key: "incarnation", value: reopened.incarnation });
	expect(reopened.incarnation).not.toBe(a.incarnation);
});

// ---------------------------------------------------------------- room head
const scope = { objectId: "revision-sites-room", pinnedGenesisAnchorDigest: "0".repeat(64) };
const head = { objectId: scope.objectId, epoch: 0, currentAnchorDigest: scope.pinnedGenesisAnchorDigest };
function roomHead(path: string, kind: "create" | "reopen"): NodeRoomHeadAuthority {
	const authority = createNodeRoomHeadAuthority({ filename: path, initialization: { kind } });
	closers.push(() => authority.close());
	return authority;
}
/**
 * readRetirementImage must always agree with the same connection's uncached read.
 * @param authority
 */
async function agrees(authority: NodeRoomHeadAuthority): Promise<unknown> {
	const image = await authority.readRetirementImage({ scope });
	const current = await authority.read({ scope });
	expect(current.ok && image.state).toEqual(current.ok && current.state);
	return image;
}

test("room head: readRetirementImage memo against other connections, rollbacks, open writes and DDL", async () => {
	const path = await file("head.sqlite");
	const owner = roomHead(path, "create");
	const created = await owner.create({ scope, stable: head });
	if (!created.ok || created.state === null) throw new Error("create failed");
	const loads = spy(/SELECT image FROM room_head/u);
	const first = await agrees(owner);
	const afterFirst = loads.count;
	expect(await owner.readRetirementImage({ scope })).toBe(first);
	expect(loads.count).toBe(afterFirst); // positive control: the hit loaded nothing

	// Another connection of this process (a second authority) commits a successor: never the memo.
	const other = roomHead(path, "reopen");
	const begun = await other.begin({
		scope,
		expected: created.state,
		next: { ...head, epoch: 1, currentAnchorDigest: "1".repeat(64) },
	});
	expect(begun.ok).toBe(true);
	const afterForeign = (await agrees(owner)) as { state: { pending: unknown } };
	expect(afterForeign.state.pending).not.toBeNull();

	// A foreign write rolled back: unchanged and equal; an open foreign write: invisible until commit.
	const sql = raw(path);
	const imageBefore = await agrees(owner);
	sql.exec("BEGIN IMMEDIATE");
	sql.prepare("UPDATE room_head SET image=x'00' WHERE id=1").run();
	sql.exec("ROLLBACK");
	expect(await agrees(owner)).toEqual(imageBefore);
	sql.exec("BEGIN IMMEDIATE");
	sql.prepare("UPDATE room_head SET image=x'00' WHERE id=1").run();
	expect(await owner.readRetirementImage({ scope })).toEqual(imageBefore);
	sql.exec("COMMIT");
	// The committed corrupt image is refused, never answered from the memo.
	await expect(owner.readRetirementImage({ scope })).rejects.toThrow();
	sql.close();

	// Foreign DDL moves schema_version: the next read loads again (and still agrees).
	const repaired = await file("head2.sqlite");
	const fresh = roomHead(repaired, "create");
	await fresh.create({ scope, stable: head });
	await agrees(fresh);
	const ddl = raw(repaired);
	ddl.exec("CREATE TABLE intruder(x)");
	const beforeDdl = loads.count;
	await fresh.readRetirementImage({ scope });
	expect(loads.count).toBe(beforeDdl + 1);
});

test("room head: own commit, a file replaced under the same path, two stores, reopen", async () => {
	const path = await file("head.sqlite");
	const owner = roomHead(path, "create");
	const created = await owner.create({ scope, stable: head });
	if (!created.ok || created.state === null) throw new Error("create failed");
	await agrees(owner);
	// Own commit (transact(true)): the next image is the new state.
	const begun = await owner.begin({
		scope,
		expected: created.state,
		next: { ...head, epoch: 1, currentAnchorDigest: "1".repeat(64) },
	});
	if (!begun.ok || begun.state === null) throw new Error("begin failed");
	const afterOwn = (await agrees(owner)) as { state: unknown };
	expect(afterOwn.state).toEqual(begun.state);

	// Two stores in one process: a second room head file never answers from the first's memo.
	const otherPath = await file("other.sqlite");
	const second = roomHead(otherPath, "create");
	await second.create({ scope, stable: head });
	const secondImage = (await agrees(second)) as { state: unknown };
	expect(secondImage.state).toEqual(created.state);
	expect(((await agrees(owner)) as { state: unknown }).state).toEqual(begun.state);

	// A file replaced under the path: the old connection keeps reading the file it opened, and the
	// memo never differs from that connection's uncached read; a reopened authority (the restored
	// creator case: new connection, new memo) reads the file now at the path.
	await second.close();
	await rename(otherPath, path);
	await agrees(owner);
	// (Which rows that new connection sees while the old connection's WAL files still sit beside the
	// path is SQLite's business, not the memo's; the memo only ever agrees with its own connection.)
	const reopened = roomHead(path, "reopen");
	await agrees(reopened);
});
