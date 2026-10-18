import {
	encodeJournalRetirementControl,
	LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES,
	type LiveJournalRetirementImageObservation,
} from "@ts-drp/live-journal";
import type { NativeReadReservation } from "@ts-drp/storage";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

import { anchorMaterial } from "../../../tests/fixtures/journal-anchor-read/material.js";
import { createSnapshotQuarantineFixture } from "../../../tests/fixtures/phase-4c-v3/snapshot-quarantine-contract.js";
import { receiptFor } from "../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import { createSqliteAheDurableStore } from "../src/index.js";
import { SqliteNativeReadReservationOwner } from "../src/internal/native-read-reservation.js";
import { acquireSnapshotDependencyLock } from "../src/internal/snapshot-dependency-lock.js";
import { createNodeDurableIssuanceStore } from "../src/issuance.js";
import { createNodeDurableLiveJournalStore } from "../src/live-journal.js";
import { createNodeSnapshotQuarantineStore } from "../src/snapshot-transfer.js";

type CustodyPort = {
	acquireNativeReadReservation(input: { objectId: string }): Promise<NativeReadReservation>;
	close(): Promise<void>;
};
const objectId = anchorMaterial().scope.objectId;
function nativeSnapshotStore(
	options: Parameters<typeof createNodeSnapshotQuarantineStore>[0]
): Required<ReturnType<typeof createNodeSnapshotQuarantineStore>> {
	const store = createNodeSnapshotQuarantineStore(options);
	for (const port of [
		"acquireRecoveryDependencyProtection",
		"acquireRecoveryRetirementExclusion",
		"captureRecoveryRoleInventory",
		"reconcileRecoveryRoles",
		"readRetirementImage",
	] as const)
		if (typeof store[port] !== "function") throw new Error(`snapshot native port missing: ${port}`);
	return store as Required<ReturnType<typeof createNodeSnapshotQuarantineStore>>;
}
function fixtureAt(
	fixtures: readonly ReturnType<typeof createSnapshotQuarantineFixture>[],
	index: number
): ReturnType<typeof createSnapshotQuarantineFixture> {
	const selected = fixtures[index];
	if (selected === undefined) throw new Error("snapshot fixture index is invalid");
	return selected;
}

test("R10 SQLite snapshot path aliases share the same native coordination identity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-r10-snapshot-alias-"));
	const primaryFilename = join(directory, "source.sqlite");
	const store = nativeSnapshotStore({ primaryFilename });
	let alias: ReturnType<typeof nativeSnapshotStore> | undefined;
	const selected = createSnapshotQuarantineFixture({ objectId: "r10-alias", epoch: 0, chunks: [Uint8Array.of(3, 5)] });
	try {
		const scope = await store.openScope(selected.declaration);
		try {
			await scope.complete(await receiptFor(scope, selected));
			await scope.retainForRecovery();
		} finally {
			await scope.release();
		}
		await symlink(directory, join(directory, "alias"), "dir");
		alias = nativeSnapshotStore({
			primaryFilename: join(directory, "alias", "source.sqlite"),
			initialization: "reopen",
		});
		const held = await store.acquireRecoveryDependencyProtection(selected.declaration.scope);
		if (held.kind !== "held") throw new Error("snapshot protection unsupported");
		try {
			await expect(
				alias.acquireRecoveryRetirementExclusion({ scopes: [selected.declaration.scope] })
			).rejects.toMatchObject({ code: "recovery-full" });
		} finally {
			await held.protection.release();
		}
		const resumed = await alias.acquireRecoveryRetirementExclusion({ scopes: [selected.declaration.scope] });
		await resumed.check();
		await resumed.release();
		expect((await readdir(directory)).filter((name) => /dependency-\d+\.sqlite$/u.test(name))).toHaveLength(1);
	} finally {
		await alias?.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("R10 SQLite snapshot schema5 reopen preserves source and missing stable locks refuse recreation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-r10-snapshot-reopen-"));
	const primaryFilename = join(directory, "source.sqlite");
	let store = nativeSnapshotStore({ primaryFilename });
	const selected = createSnapshotQuarantineFixture({ objectId: "r10-reopen", epoch: 0, chunks: [Uint8Array.of(3, 5)] });
	try {
		const scope = await store.openScope(selected.declaration);
		try {
			await scope.complete(await receiptFor(scope, selected));
			await scope.retainForRecovery();
		} finally {
			await scope.release();
		}
		const before = await store.readRetirementImage({ objectId: "r10-reopen" });
		await store.close();
		// Exact already-supported schema5 image, before any coordination binding.
		const old = new DatabaseSync(`${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`);
		old.exec("DROP TABLE snapshot_dependency_slots; PRAGMA user_version=5");
		old.close();
		store = nativeSnapshotStore({ primaryFilename, initialization: "reopen" });
		expect(await store.readRetirementImage({ objectId: "r10-reopen" })).toEqual(before);
		const held = await store.acquireRecoveryDependencyProtection(selected.declaration.scope);
		if (held.kind !== "held") throw new Error("snapshot protection unsupported");
		await held.protection.release();
		await unlink(`${primaryFilename}.drp-snapshot-quarantine-v1.sqlite.dependency-0.sqlite`);
		await expect(store.acquireRecoveryDependencyProtection(selected.declaration.scope)).rejects.toMatchObject({
			code: "storage-failed",
		});
		expect((await readdir(directory)).filter((name) => /dependency-\d+\.sqlite$/u.test(name))).toHaveLength(0);
		expect(await store.readRetirementImage({ objectId: "r10-reopen" })).toEqual(before);
	} finally {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("R10 SQLite snapshot slot reuse refuses an old still-held native exclusion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-r10-snapshot-reuse-"));
	const primaryFilename = join(directory, "source.sqlite");
	const store = nativeSnapshotStore({ primaryFilename });
	const selected = [0, 1, 2].map((epoch) =>
		createSnapshotQuarantineFixture({ objectId: "r10-reuse", epoch, chunks: [Uint8Array.of(epoch, 5)] })
	);
	let held: Awaited<ReturnType<NonNullable<typeof store.acquireRecoveryRetirementExclusion>>> | undefined;
	try {
		for (const item of selected.slice(0, 2)) {
			const scope = await store.openScope(item.declaration);
			try {
				await scope.complete(await receiptFor(scope, item));
				await scope.retainForRecovery();
			} finally {
				await scope.release();
			}
		}
		held = await store.acquireRecoveryRetirementExclusion({ scopes: [fixtureAt(selected, 0).declaration.scope] });
		const inventory = await store.captureRecoveryRoleInventory({ objectId: "r10-reuse" });
		await store.reconcileRecoveryRoles({
			custody: inventory.custody,
			protectedScopes: [fixtureAt(selected, 1).declaration.scope],
		});
		await held.check(); // public exclusion still holds after lawful deletion
		const next = await store.openScope(fixtureAt(selected, 2).declaration);
		try {
			await next.complete(await receiptFor(next, fixtureAt(selected, 2)));
			await next.retainForRecovery();
		} finally {
			await next.release();
		}
		const before = await store.readRetirementImage({ objectId: "r10-reuse" });
		await expect(
			store.acquireRecoveryDependencyProtection(fixtureAt(selected, 2).declaration.scope)
		).rejects.toMatchObject({
			code: "recovery-full",
		});
		expect(await store.readRetirementImage({ objectId: "r10-reuse" })).toEqual(before);
		await held.release();
		const resumed = await store.acquireRecoveryDependencyProtection(fixtureAt(selected, 2).declaration.scope);
		if (resumed.kind !== "held") throw new Error("snapshot protection unsupported");
		await resumed.protection.check();
		await resumed.protection.release();
		expect((await readdir(directory)).filter((name) => /dependency-\d+\.sqlite$/u.test(name))).toHaveLength(1);
	} finally {
		await held?.release();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("R10 SQLite snapshot acquisition rejects a stale binding after independent lawful retirement", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-r10-snapshot-stale-"));
	const primaryFilename = join(directory, "source.sqlite");
	const store = nativeSnapshotStore({ primaryFilename });
	const selected = [0, 1].map((epoch) =>
		createSnapshotQuarantineFixture({ objectId: "r10-stale", epoch, chunks: [Uint8Array.of(epoch, 5)] })
	);
	const moduleUrl = pathToFileURL(join(import.meta.dirname, "../dist/src/snapshot-transfer.js")).href;
	const originalExec = DatabaseSync.prototype.exec;
	let armed = false,
		reached = false;
	try {
		for (const item of selected) {
			const scope = await store.openScope(item.declaration);
			try {
				await scope.complete(await receiptFor(scope, item));
				await scope.retainForRecovery();
			} finally {
				await scope.release();
			}
		}
		DatabaseSync.prototype.exec = function (sql: string): void {
			originalExec.call(this, sql);
			if (!armed || reached || sql !== "COMMIT") return;
			// The binding-allocation transaction has committed, but the requesting
			// async frame has not yet obtained its physical shared lock.
			if (
				this.prepare("SELECT 1 FROM sqlite_schema WHERE name='snapshot_dependency_slots'").get() === undefined ||
				this.prepare("SELECT 1 FROM snapshot_dependency_slots WHERE epoch=0").get() === undefined
			)
				return;
			reached = true;
			const child = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`
import {createNodeSnapshotQuarantineStore} from ${JSON.stringify(moduleUrl)};
const store=createNodeSnapshotQuarantineStore({primaryFilename:process.argv[1],initialization:'reopen'});
try {
 const inventory=await store.captureRecoveryRoleInventory({objectId:'r10-stale'});
 const result=await store.reconcileRecoveryRoles({custody:inventory.custody,protectedScopes:[${JSON.stringify(fixtureAt(selected, 1).declaration.scope)}]});
 console.log(JSON.stringify(result));
} finally {await store.close();}
`,
					primaryFilename,
				],
				{ encoding: "utf8", timeout: 5000 }
			);
			expect(child.status, child.stderr).toBe(0);
			expect(JSON.parse(child.stdout)).toMatchObject({ retiredScopes: [fixtureAt(selected, 0).declaration.scope] });
		};
		armed = true;
		await expect(
			store.acquireRecoveryDependencyProtection(fixtureAt(selected, 0).declaration.scope)
		).rejects.toMatchObject({
			code: "stale-scope",
		});
		expect(reached).toBe(true);
		DatabaseSync.prototype.exec = originalExec;
		const legitimate = await store.acquireRecoveryDependencyProtection(fixtureAt(selected, 1).declaration.scope);
		if (legitimate.kind !== "held") throw new Error("snapshot protection unsupported");
		await legitimate.protection.check();
		await legitimate.protection.release();
	} finally {
		DatabaseSync.prototype.exec = originalExec;
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("R10 SQLite snapshot exclusion spans independent processes and SIGKILL joins native release", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-r10-snapshot-process-"));
	const primaryFilename = join(directory, "source.sqlite");
	const store = nativeSnapshotStore({ primaryFilename });
	const selected = createSnapshotQuarantineFixture({
		objectId: "r10-process",
		epoch: 0,
		chunks: [Uint8Array.of(3, 5)],
	});
	const scope = await store.openScope(selected.declaration);
	const moduleUrl = pathToFileURL(join(import.meta.dirname, "../dist/src/snapshot-transfer.js")).href;
	const childScript = `
import {createNodeSnapshotQuarantineStore} from ${JSON.stringify(moduleUrl)};
const [filename, serialized, mode] = process.argv.slice(1);
const store=createNodeSnapshotQuarantineStore({primaryFilename: filename, initialization:'reopen'});
try {
 const scope=JSON.parse(serialized);
 const held= mode==='exclusive' ? await store.acquireRecoveryRetirementExclusion({scopes:[scope]}) : (await store.acquireRecoveryDependencyProtection(scope)).protection;
 await held.check();
 if(mode==='hold') {process.on('message',()=>{}); process.send({kind:'held',pid:process.pid}); await new Promise(()=>{});}
 else {await held.release(); console.log(JSON.stringify({code:'none'}));}
} catch(error) {console.log(JSON.stringify({code:error.code??'unclassified',message:error.message}));}
finally {await store.close();}
`;
	const probe = (mode: "shared" | "exclusive"): Readonly<{ code: string }> => {
		const child = spawnSync(
			process.execPath,
			["--input-type=module", "-e", childScript, primaryFilename, JSON.stringify(selected.declaration.scope), mode],
			{ encoding: "utf8", timeout: 5000 }
		);
		expect(child.status, child.stderr).toBe(0);
		return JSON.parse(child.stdout.trim());
	};
	let foreign: ReturnType<typeof spawn> | undefined;
	let held: Awaited<ReturnType<NonNullable<typeof store.acquireRecoveryRetirementExclusion>>> | undefined;
	try {
		await scope.complete(await receiptFor(scope, selected));
		await scope.retainForRecovery();
		await scope.release();
		const shared = await store.acquireRecoveryDependencyProtection(selected.declaration.scope);
		if (shared.kind !== "held") throw new Error("snapshot protection unsupported");
		expect(probe("shared")).toMatchObject({ code: "none" });
		expect(probe("exclusive")).toMatchObject({ code: "recovery-full" });
		await shared.protection.release();
		held = await store.acquireRecoveryRetirementExclusion({ scopes: [selected.declaration.scope] });
		expect(probe("shared")).toMatchObject({ code: "recovery-full" });
		await held.release();
		foreign = spawn(
			process.execPath,
			["--input-type=module", "-e", childScript, primaryFilename, JSON.stringify(selected.declaration.scope), "hold"],
			{ stdio: ["ignore", "pipe", "pipe", "ipc"] }
		);
		const child = foreign;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("snapshot dependency child did not acquire")), 5000);
			child.once("error", reject);
			child.on("message", (message) => {
				if (
					typeof message === "object" &&
					message !== null &&
					Reflect.get(message, "kind") === "held" &&
					Reflect.get(message, "pid") === child.pid
				) {
					clearTimeout(timeout);
					resolve();
				}
			});
		});
		const before = await store.readRetirementImage({ objectId: "r10-process" });
		await expect(
			store.acquireRecoveryRetirementExclusion({ scopes: [selected.declaration.scope] })
		).rejects.toMatchObject({ code: "recovery-full" });
		expect(await store.readRetirementImage({ objectId: "r10-process" })).toEqual(before);
		const exited = new Promise<void>((resolve) =>
			child.once("close", (code, signal) => {
				expect(code).toBeNull();
				expect(signal).toBe("SIGKILL");
				resolve();
			})
		);
		child.kill("SIGKILL");
		await exited;
		held = await store.acquireRecoveryRetirementExclusion({ scopes: [selected.declaration.scope] });
		await held.check();
		await held.release();
		expect(await store.readRetirementImage({ objectId: "r10-process" })).toEqual(before);
	} finally {
		if (foreign !== undefined && foreign.exitCode === null && foreign.signalCode === null) {
			const join = new Promise<void>((resolve) => foreign.once("close", () => resolve()));
			foreign.kill("SIGKILL");
			await join;
		}
		await held?.release();
		await scope.release();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 15000);

test("R10 SQLite snapshot scoped custody permits disjoint committed retirement and joins admitted work", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-r10-snapshot-scoped-"));
	const primaryFilename = join(directory, "source.sqlite");
	let store = nativeSnapshotStore({ primaryFilename });
	const selected = [0, 1, 2].map((epoch) =>
		createSnapshotQuarantineFixture({ objectId: "r10-scoped", epoch, chunks: [Uint8Array.of(epoch, 3, 5)] })
	);
	const seed = async (index: number): Promise<void> => {
		const fixture = fixtureAt(selected, index);
		const scope = await store.openScope(fixture.declaration);
		try {
			await scope.complete(await receiptFor(scope, fixture));
			await scope.retainForRecovery();
		} finally {
			await scope.release();
		}
	};
	let protectedHold: Awaited<ReturnType<NonNullable<typeof store.acquireRecoveryDependencyProtection>>> | undefined;
	let exclusion: Awaited<ReturnType<NonNullable<typeof store.acquireRecoveryRetirementExclusion>>> | undefined;
	try {
		await seed(0);
		await seed(1);
		protectedHold = await store.acquireRecoveryDependencyProtection(fixtureAt(selected, 1).declaration.scope);
		expect(protectedHold.kind).toBe("held");
		if (protectedHold.kind !== "held") throw new Error("snapshot protection unsupported");
		const refusing = await store.acquireRecoveryDependencyProtection(fixtureAt(selected, 0).declaration.scope);
		if (refusing.kind !== "held") throw new Error("snapshot protection unsupported");
		const before = await store.readRetirementImage({ objectId: "r10-scoped" });
		await expect(
			store.acquireRecoveryRetirementExclusion({ scopes: [fixtureAt(selected, 0).declaration.scope] })
		).rejects.toMatchObject({ code: "recovery-full" });
		expect(await store.readRetirementImage({ objectId: "r10-scoped" })).toEqual(before);
		await refusing.protection.release();
		exclusion = await store.acquireRecoveryRetirementExclusion({ scopes: [fixtureAt(selected, 0).declaration.scope] });
		const inventory = await store.captureRecoveryRoleInventory({ objectId: "r10-scoped" });
		const retirement = store.reconcileRecoveryRoles({
			custody: inventory.custody,
			protectedScopes: [fixtureAt(selected, 1).declaration.scope],
		});
		// Borrowing is admitted synchronously by the original backend owner. Public
		// revocation refuses new work but cannot release the admitted native lock.
		const release = exclusion.release();
		const slotDb = new DatabaseSync(`${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`, { readOnly: true });
		const slot = Number(slotDb.prepare("SELECT slot FROM snapshot_dependency_slots WHERE epoch=0").get()?.slot);
		slotDb.close();
		expect(() =>
			acquireSnapshotDependencyLock(
				`${primaryFilename}.drp-snapshot-quarantine-v1.sqlite.dependency-${slot}.sqlite`,
				"shared"
			)
		).toThrow("database is locked");
		await expect(exclusion.check()).rejects.toMatchObject({ code: "stale-scope" });
		expect(await retirement).toMatchObject({
			retiredScopes: [fixtureAt(selected, 0).declaration.scope],
			recoveryScopes: 1,
		});
		await release;
		await protectedHold.protection.check();
		// A distinct native connection observes the committed deletion while the
		// retained dependency still holds its genuine lock.
		const readback = new DatabaseSync(`${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`, { readOnly: true });
		expect(readback.prepare("SELECT epoch FROM snapshot_scopes_v2 ORDER BY epoch").all()).toEqual([{ epoch: 1 }]);
		readback.close();
		await seed(2);
		const next = await store.acquireRecoveryDependencyProtection(fixtureAt(selected, 2).declaration.scope);
		if (next.kind !== "held") throw new Error("snapshot protection unsupported");
		await next.protection.check();
		await next.protection.release();
		expect((await readdir(directory)).filter((name) => /dependency-\d+\.sqlite$/u.test(name))).toHaveLength(2);
		await protectedHold.protection.release();
		await store.close();
		store = nativeSnapshotStore({ primaryFilename, initialization: "reopen" });
		const reopened = await store.acquireRecoveryDependencyProtection(fixtureAt(selected, 2).declaration.scope);
		if (reopened.kind !== "held") throw new Error("snapshot protection unsupported");
		await reopened.protection.check();
		await store.close();
		await expect(reopened.protection.check()).rejects.toMatchObject({ code: "stale-scope" });
	} finally {
		await exclusion?.release();
		if (protectedHold?.kind === "held") await protectedHold.protection.release();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("R10 SQLite snapshot exposes dependency protection and exact retirement exclusion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-r10-snapshot-ports-"));
	const store = nativeSnapshotStore({ primaryFilename: join(directory, "source.sqlite") });
	try {
		expect(typeof store.acquireRecoveryDependencyProtection).toBe("function");
		expect(typeof store.acquireRecoveryRetirementExclusion).toBe("function");
	} finally {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("R10 SQLite WAL reads and whole-store reservations are not disjoint snapshot exclusion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-r10-snapshot-lock-boundary-"));
	const filename = join(directory, "source.sqlite");
	const owningWriter = new DatabaseSync(filename);
	let observer: DatabaseSync | undefined;
	let held: NativeReadReservation | undefined;
	const reservations = new SqliteNativeReadReservationOwner(filename);
	try {
		owningWriter.exec(
			"PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0; CREATE TABLE scopes(id TEXT PRIMARY KEY, value TEXT); INSERT INTO scopes VALUES('protected','exact'),('retiring','old')"
		);
		observer = new DatabaseSync(filename);
		observer.exec("BEGIN");
		expect(observer.prepare("SELECT value FROM scopes WHERE id='protected'").get()?.value).toBe("exact");
		// WAL snapshot visibility is not exclusion: a separate connection can delete.
		owningWriter.exec("BEGIN IMMEDIATE; DELETE FROM scopes WHERE id='protected'; COMMIT");
		expect(owningWriter.prepare("SELECT value FROM scopes WHERE id='protected'").get()).toBeUndefined();
		expect(observer.prepare("SELECT value FROM scopes WHERE id='protected'").get()?.value).toBe("exact");
		observer.exec("ROLLBACK");
		owningWriter.exec("INSERT INTO scopes VALUES('protected','exact')");
		held = await reservations.acquire();
		await held.check();
		// The existing genuine native reservation blocks both the independent process
		// and the original owner, including a lawful unrelated-scope mutation.
		expect(writer(filename)).toMatchObject({ status: 5, stdout: "busy\n" });
		expect(() => owningWriter.exec("BEGIN IMMEDIATE")).toThrow("database is locked");
		await held.release();
		owningWriter.exec("BEGIN IMMEDIATE; DELETE FROM scopes WHERE id='retiring'; COMMIT");
		expect(owningWriter.prepare("SELECT value FROM scopes WHERE id='protected'").get()?.value).toBe("exact");
		expect(owningWriter.prepare("SELECT value FROM scopes WHERE id='retiring'").get()).toBeUndefined();
	} finally {
		await held?.release();
		await reservations.close();
		observer?.close();
		owningWriter.close();
		await rm(directory, { recursive: true, force: true });
	}
});
function writer(filename: string): { status: number | null; stdout: string; stderr: string } {
	return spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import {DatabaseSync} from 'node:sqlite';
		const db=new DatabaseSync(process.argv[1]);
		db.exec('PRAGMA busy_timeout=0');
		try {db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); console.log('reserved');}
		catch(e) {console.log(e.errcode===5?'busy':e.message); process.exitCode=e.errcode===5?5:1;}
		finally {db.close();}
	`,
			filename,
		],
		{ encoding: "utf8", timeout: 5000 }
	);
}
function logicalImage(filename: string): unknown {
	const db = new DatabaseSync(filename, { readOnly: true });
	try {
		const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
		const tables = schema.filter(
			(row) => row.type === "table" && typeof row.name === "string" && !row.name.startsWith("sqlite_")
		);
		return { schema, rows: tables.map((row) => [row.name, db.prepare(`SELECT * FROM "${row.name}"`).all()]) };
	} finally {
		db.close();
	}
}

for (const kind of ["ahe", "issuance", "journal"] as const)
	test(`R8 SQLite ${kind} custody excludes independent process writers and joins without native mutation`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "ts-drp-r8-native-custody-")),
			base = join(dir, "source.sqlite");
		const store = (kind === "ahe"
			? createSqliteAheDurableStore({ filename: base })
			: kind === "issuance"
				? createNodeDurableIssuanceStore({ primaryFilename: base })
				: createNodeDurableLiveJournalStore({ primaryFilename: base })) as unknown as CustodyPort;
		const filename =
			kind === "ahe" ? base : `${base}.drp-${kind === "issuance" ? "issuance" : "live-journal"}-v1.sqlite`;
		let held: NativeReadReservation | undefined;
		try {
			const before = logicalImage(filename);
			expect(writer(filename).status).toBe(0);
			held = await store.acquireNativeReadReservation({ objectId });
			await held.check();
			expect(writer(filename)).toMatchObject({ status: 5, stdout: "busy\n" });
			expect(logicalImage(filename)).toEqual(before);
			await expect(store.acquireNativeReadReservation({ objectId })).rejects.toThrow("BUSY");
			await held.release();
			await held.release();
			await expect(held.check()).rejects.toThrow("RELEASED");
			expect(writer(filename).status).toBe(0);
			held = await store.acquireNativeReadReservation({ objectId });
			await store.close();
			await expect(held.check()).rejects.toThrow("RELEASED");
			await expect(store.acquireNativeReadReservation({ objectId })).rejects.toThrow();
			expect(writer(filename).status).toBe(0);
			expect(logicalImage(filename)).toEqual(before);
		} finally {
			await held?.release();
			await store.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

test("R8 SQLite source custody never creates a missing store", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ts-drp-r8-native-missing-")),
		filename = join(dir, "missing.sqlite");
	const owner = new SqliteNativeReadReservationOwner(filename);
	try {
		await expect(owner.acquire()).rejects.toThrow();
		await expect(stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await owner.close();
		await rm(dir, { recursive: true, force: true });
	}
});

for (const kind of ["ahe", "issuance", "journal"] as const)
	test(`R8 SQLite ${kind} close revokes an acquisition before delivery`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "ts-drp-r8-native-close-")),
			base = join(dir, "source.sqlite");
		const store = (kind === "ahe"
			? createSqliteAheDurableStore({ filename: base })
			: kind === "issuance"
				? createNodeDurableIssuanceStore({ primaryFilename: base })
				: createNodeDurableLiveJournalStore({ primaryFilename: base })) as unknown as CustodyPort;
		const filename =
			kind === "ahe" ? base : `${base}.drp-${kind === "issuance" ? "issuance" : "live-journal"}-v1.sqlite`;
		try {
			const before = logicalImage(filename),
				acquiring = store.acquireNativeReadReservation({ objectId });
			const closed = store.close();
			await expect(acquiring).rejects.toThrow("RELEASED");
			await closed;
			expect(writer(filename).status).toBe(0);
			expect(logicalImage(filename)).toEqual(before);
		} finally {
			await store.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

test("R8 SQLite source-bound append refuses stale control even when whole row image is unchanged", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ts-drp-r8-native-control-")),
		filename = join(dir, "source.sqlite");
	const store = createNodeDurableLiveJournalStore({ primaryFilename: filename });
	if (store.readRetirementImage === undefined || store.acquireRetirementControl === undefined)
		throw new Error("native journal currency API unavailable");
	const readImage = store.readRetirementImage.bind(store),
		acquireControl = store.acquireRetirementControl.bind(store);
	try {
		const material = anchorMaterial();
		expect(await store.installGenesis(material.install)).toMatchObject({ ok: true });
		const before = await readImage({ objectId });
		if (!before.ok) throw new Error(before.kind);
		expect(before.value.control).toBeNull();
		expect(await acquireControl({ objectId })).toMatchObject({ ok: true });
		const after = await readImage({ objectId });
		if (!after.ok) throw new Error(after.kind);
		expect(after.value.image).toEqual(before.value.image);
		const nativeBefore = logicalImage(`${filename}.drp-live-journal-v1.sqlite`);
		expect(
			await store.appendAccepted({
				scope: material.scope,
				sourceKind: "local-issued",
				author: "native-author",
				authorSequence: 0,
				vertexDigest: "a".repeat(64),
				expectedNativeImage: { imageDigest: before.value.image.imageDigest, controlBytes: null },
			})
		).toEqual({ ok: false, kind: "retirement-stale" });
		expect(logicalImage(`${filename}.drp-live-journal-v1.sqlite`)).toEqual(nativeBefore);
	} finally {
		await store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

// Storage fixture carriers are not an external authentication claim. These tests
// discharge native currency/postimage mechanics only, not source authorization.
test("R8 SQLite source-bound append verifies complete image and control with earlier-scope and idempotent postimages", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ts-drp-r8-native-append-")),
		filename = join(dir, "source.sqlite");
	const store = createNodeDurableLiveJournalStore({ primaryFilename: filename });
	if (store.readRetirementImage === undefined || store.acquireRetirementControl === undefined)
		throw new Error("native journal currency API unavailable");
	const readImage = store.readRetirementImage.bind(store),
		acquireControl = store.acquireRetirementControl.bind(store);
	const current = anchorMaterial(0),
		successor = anchorMaterial(1);
	const local = {
		scope: current.scope,
		sourceKind: "local-issued" as const,
		author: "native-author",
		authorSequence: 0,
		vertexDigest: "a".repeat(64),
	};
	const read = async (): Promise<{
		value: LiveJournalRetirementImageObservation;
		checkpoint: { imageDigest: string; controlBytes: Uint8Array | null };
	}> => {
		const value = await readImage({ objectId });
		if (!value.ok) throw new Error(value.kind);
		return {
			value: value.value,
			checkpoint: {
				imageDigest: value.value.image.imageDigest,
				controlBytes: value.value.control === null ? null : encodeJournalRetirementControl(value.value.control),
			},
		};
	};
	try {
		expect(await store.installGenesis(current.install)).toMatchObject({ ok: true });
		expect(await store.installEpochAnchor(successor.install)).toMatchObject({ ok: true });
		expect(await acquireControl({ objectId })).toMatchObject({ ok: true });
		const before = await read();
		const appended = await store.appendAccepted({ ...local, expectedNativeImage: before.checkpoint });
		expect(appended).toMatchObject({ ok: true, idempotent: false, journalSequence: 0 });
		if (!appended.ok) throw new Error(appended.kind);
		const after = await read();
		expect(appended.nativeImage).toEqual(after.checkpoint);
		expect(after.value.image.rowCount).toBe(before.value.image.rowCount + 1);
		if (before.value.control === null || after.value.control === null) throw new Error("native control disappeared");
		expect(after.value.control.revision).toBe(before.value.control.revision + 1);
		const duplicate = await store.appendAccepted({ ...local, expectedNativeImage: after.checkpoint });
		expect(duplicate).toMatchObject({ ok: true, idempotent: true, nativeImage: after.checkpoint });
		expect(await read()).toEqual(after);
		expect(
			await store.appendAccepted({
				...local,
				authorSequence: 1,
				vertexDigest: "b".repeat(64),
				expectedNativeImage: before.checkpoint,
			})
		).toEqual({ ok: false, kind: "retirement-stale" });
		expect(await read()).toEqual(after);
		expect(
			await store.appendAccepted({
				...local,
				expectedNativeImage: {
					...after.checkpoint,
					controlBytes: new Uint8Array(LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES + 1),
				},
			})
		).toEqual({ ok: false, kind: "malformed-input" });
		expect(await read()).toEqual(after);
	} finally {
		await store.close();
		await rm(dir, { recursive: true, force: true });
	}
});
