import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeSnapshotQuarantineStore as createLegacy } from "./fixtures/legacy-snapshot-transfer.mjs";
import {
	COMMON_CASES,
	expectedCommonCase,
	fixture,
	type LegacyStore,
	outcome,
	type OwnerImage,
	type RecoveryEnvironment,
	type RecoveryStore,
	runCommonCase,
	seedLegacy,
	stable,
} from "../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import * as sharedSnapshotContract from "../../storage/src/snapshot-transfer.js";
import { createNodeSnapshotQuarantineStore } from "../src/snapshot-transfer.js";

const directories: string[] = [];
const stores: LegacyStore[] = [];
const SOURCE_ROOT = resolve(import.meta.dirname, "../../..");
const SUFFIX = ".drp-snapshot-quarantine-v1.sqlite";

function image(primaryFilename: string, readBigInts = false): OwnerImage {
	const db = new DatabaseSync(`${primaryFilename}${SUFFIX}`, { readOnly: true });
	try {
		const rows = (sql: string): ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]> => {
			const statement = db.prepare(sql);
			statement.setReadBigInts(readBigInts);
			return statement.all();
		};
		const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
		const names = db
			.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','view') ORDER BY name")
			.all()
			.map(({ name }) => String(name));
		const scopeTable = version === 2 ? "snapshot_scopes_v2" : "snapshot_scopes";
		const chunkTable = version === 2 ? "snapshot_chunks_v2" : "snapshot_chunks";
		return {
			version,
			names,
			schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
			ownerRows: version === 2 ? db.prepare("SELECT * FROM snapshot_owner_v2").all() : [],
			durableScopes: rows(`SELECT * FROM ${scopeTable} ORDER BY object_id,epoch,anchor,manifest_digest`),
			durableChunks: rows(`SELECT * FROM ${chunkTable} ORDER BY object_id,epoch,anchor,manifest_digest,chunk_index`),
			scopes: rows(
				`SELECT object_id,epoch,anchor,manifest_digest,hex(exact_manifest_bytes) AS manifest,total_bytes,chunk_count,expires_at,state FROM ${scopeTable} ORDER BY object_id,epoch`
			),
			chunks: rows(
				`SELECT object_id,epoch,anchor,manifest_digest,chunk_index,chunk_digest,byte_length,hex(exact_bytes) AS bytes FROM ${chunkTable} ORDER BY object_id,epoch,chunk_index`
			),
		};
	} finally {
		db.close();
	}
}

function environment(): RecoveryEnvironment & { primaryFilename: string } {
	const directory = mkdtempSync(join(tmpdir(), "ts-drp-recovery-owner-red-"));
	directories.push(directory);
	const primaryFilename = join(directory, "primary.sqlite");
	return {
		primaryFilename,
		open: async (recoveryLimits, explicit): Promise<RecoveryStore> => {
			const store = createNodeSnapshotQuarantineStore({
				primaryFilename,
				...(recoveryLimits === undefined && explicit !== true ? {} : { recoveryLimits }),
			} as Parameters<typeof createNodeSnapshotQuarantineStore>[0]);
			stores.push(store);
			return Promise.resolve(store as unknown as RecoveryStore);
		},
		legacy: async (): Promise<LegacyStore> => {
			const store = createLegacy({ primaryFilename });
			stores.push(store);
			return Promise.resolve(store);
		},
		image: (): Promise<OwnerImage> => Promise.resolve(image(primaryFilename)),
		exists: (): Promise<boolean> => Promise.resolve(existsSync(`${primaryFilename}${SUFFIX}`)),
	};
}

function installDocumentedCursorRepeat(
	primaryFilename: string,
	table: "snapshot_scopes" | "snapshot_scopes_v2"
): {
	readonly evidence: {
		selects: number;
		updates: number;
		overlaps: number;
		injections: number;
		resumedAfterUpdate: number;
	};
	restore(): void;
} {
	const evidence = { selects: 0, updates: 0, overlaps: 0, injections: 0, resumedAfterUpdate: 0 };
	const originalPrepare = DatabaseSync.prototype.prepare;
	const originalExec = DatabaseSync.prototype.exec;
	type Row = Record<string, unknown>;
	type Cursor = { connection: DatabaseSync; last?: Row; repeated?: Row };
	const active = new Set<Cursor>();
	const targets = new WeakMap<DatabaseSync, boolean>();
	const targetFilename = realpathSync(`${primaryFilename}${SUFFIX}`);
	let armed = false;
	let steps = 0;
	const targetsOwner = (db: DatabaseSync): boolean => {
		let target = targets.get(db);
		if (target === undefined) {
			target = originalPrepare
				.call(db, "PRAGMA database_list")
				.all()
				.some((row) => row.file === targetFilename);
			targets.set(db, target);
		}
		return target;
	};
	const normal = (sql: string): string =>
		sql
			.replace(/["`[\]]/gu, "")
			.replace(/\s+/gu, " ")
			.toUpperCase();
	const selectsTable = (sql: string): boolean =>
		new RegExp(`\\bSELECT\\b.*\\bFROM ${table.toUpperCase()}\\b`, "u").test(normal(sql));
	const updatesTable = (sql: string): boolean =>
		new RegExp(`\\bUPDATE(?: OR \\w+)? ${table.toUpperCase()}\\b`, "u").test(normal(sql));
	const afterUpdate = (db: DatabaseSync, sql: string): void => {
		if (!targetsOwner(db) || !updatesTable(sql)) return;
		evidence.updates += 1;
		for (const cursor of active) {
			if (cursor.connection !== db || cursor.last === undefined) continue;
			evidence.overlaps += 1;
			if (!armed) {
				cursor.repeated = { ...cursor.last };
				armed = true;
			}
		}
	};
	DatabaseSync.prototype.exec = function observedExec(sql): void {
		originalExec.call(this, sql);
		afterUpdate(this, sql);
	};
	DatabaseSync.prototype.prepare = function observedPrepare(sql): ReturnType<typeof originalPrepare> {
		const statement = originalPrepare.call(this, sql);
		if (!targetsOwner(this)) return statement;
		const observed = { connection: this };
		if (updatesTable(sql)) {
			const run = statement.run;
			statement.run = function observedRun(...args: unknown[]): ReturnType<typeof run> {
				const result = Reflect.apply(run, this, args) as ReturnType<typeof run>;
				afterUpdate(observed.connection, sql);
				return result;
			};
		}
		if (selectsTable(sql)) {
			evidence.selects += 1;
			const iterate = statement.iterate;
			statement.iterate = function observedIterate(...args: unknown[]): ReturnType<typeof iterate> {
				const native = Reflect.apply(iterate, this, args) as ReturnType<typeof iterate>;
				const cursor: Cursor = { connection: observed.connection };
				function* repeatAfterRealOverlap(): Generator<Row, undefined, unknown> {
					try {
						while (true) {
							if (++steps > 128) throw new Error("bounded cursor-repeat fixture exhausted its step budget");
							const next = native.next();
							if (next.done === true) return;
							cursor.last = next.value;
							active.add(cursor);
							yield next.value;
							if (cursor.repeated !== undefined) {
								evidence.resumedAfterUpdate += 1;
								evidence.injections += 1;
								const repeated = cursor.repeated;
								cursor.repeated = undefined;
								yield repeated;
							}
						}
					} finally {
						active.delete(cursor);
						native.return?.();
					}
				}
				return repeatAfterRealOverlap() as ReturnType<typeof iterate>;
			};
		}
		return statement;
	};
	return {
		evidence,
		restore: (): void => {
			DatabaseSync.prototype.prepare = originalPrepare;
			DatabaseSync.prototype.exec = originalExec;
		},
	};
}

function assertCommittedMigration(primaryFilename: string, before: OwnerImage, after: OwnerImage, debt: number): void {
	expect(after.ownerRows).toEqual([
		{
			id: 1,
			max_recovery_scopes: 4,
			max_recovery_content_bytes: 268_435_456,
			recovery_scopes: 0,
			recovery_content_bytes: 0,
			legacy_unclassified_scopes: 2,
			legacy_unclassified_content_bytes: debt,
		},
	]);
	expect(after.durableScopes).toHaveLength(2);
	const incarnations = new Set<unknown>();
	for (const row of after.durableScopes) {
		expect(row.retention).toBe("legacy-unclassified");
		expect(row.descriptors).toBeNull();
		expect(typeof row.incarnation).toBe("string");
		expect(String(row.incarnation).length).toBeGreaterThan(0);
		incarnations.add(row.incarnation);
	}
	expect(incarnations.size).toBe(2);
	expect(
		after.durableScopes.map((row) =>
			Object.fromEntries(
				Object.entries(row).filter(([key]) => !["retention", "incarnation", "descriptors"].includes(key))
			)
		)
	).toEqual(before.durableScopes);
	expect(after.durableChunks).toEqual(before.durableChunks);
	const db = new DatabaseSync(`${primaryFilename}${SUFFIX}`, { readOnly: true });
	try {
		const scope = [
			"object_id",
			"epoch",
			"anchor",
			"manifest_digest",
			"exact_manifest_bytes",
			"total_bytes",
			"chunk_count",
			"expires_at",
			"state",
			"retention",
			"incarnation",
			"descriptors",
		];
		const chunks = [
			"object_id",
			"epoch",
			"anchor",
			"manifest_digest",
			"chunk_index",
			"chunk_digest",
			"byte_length",
			"exact_bytes",
		];
		const owner = [
			"id",
			"max_recovery_scopes",
			"max_recovery_content_bytes",
			"recovery_scopes",
			"recovery_content_bytes",
			"legacy_unclassified_scopes",
			"legacy_unclassified_content_bytes",
		];
		const integers = new Set([
			"epoch",
			"total_bytes",
			"chunk_count",
			"expires_at",
			"chunk_index",
			"byte_length",
			...owner,
		]);
		for (const [table, columns, primary] of [
			["snapshot_scopes_v2", scope, 4],
			["snapshot_chunks_v2", chunks, 5],
			["snapshot_owner_v2", owner, 1],
		] as const) {
			expect(db.prepare(`PRAGMA table_xinfo(${table})`).all()).toEqual(
				columns.map((name, cid) => ({
					cid,
					name,
					type: integers.has(name)
						? "INTEGER"
						: name === "exact_manifest_bytes" || name === "exact_bytes"
							? "BLOB"
							: "TEXT",
					notnull: name === "descriptors" ? 0 : 1,
					dflt_value: name === "retention" ? "'legacy-unclassified'" : name === "incarnation" ? "''" : null,
					pk: cid < primary ? cid + 1 : 0,
					hidden: 0,
				}))
			);
			expect(db.prepare("SELECT wr,strict FROM pragma_table_list WHERE name=?").get(table)).toEqual({
				wr: 1,
				strict: 0,
			});
			expect(db.prepare(`PRAGMA index_list(${table})`).all()).toEqual([
				{ seq: 0, name: `sqlite_autoindex_${table}_1`, unique: 1, origin: "pk", partial: 0 },
			]);
		}
		expect(db.prepare("PRAGMA foreign_key_list(snapshot_chunks_v2)").all()).toEqual(
			scope.slice(0, 4).map((name, seq) => ({
				id: 0,
				seq,
				table: "snapshot_scopes_v2",
				from: name,
				to: name,
				on_update: "NO ACTION",
				on_delete: "CASCADE",
				match: "NONE",
			}))
		);
		expect(db.prepare("PRAGMA foreign_key_list(snapshot_scopes_v2)").all()).toEqual([]);
		expect(db.prepare("PRAGMA foreign_key_list(snapshot_owner_v2)").all()).toEqual([]);
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('view','trigger')").all()).toEqual([]);
	} finally {
		db.close();
	}
}

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close().catch(() => undefined);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("1a-0 Node snapshot recovery owner RED", () => {
	it("has one frozen shared snapshot contract runtime roster", () => {
		expect(Object.keys(sharedSnapshotContract).sort()).toEqual([
			"SNAPSHOT_QUARANTINE_RETENTION_MS",
			"snapshotQuarantineContract",
		]);
		const contract = Reflect.get(sharedSnapshotContract, "snapshotQuarantineContract") as Record<string, unknown>;
		expect(Object.isFrozen(contract)).toBe(true);
		expect(Object.isFrozen(contract.limits) && Object.isFrozen(contract.defaultRecoveryLimits)).toBe(true);
		expect(Object.keys(contract).sort()).toEqual([
			"addRecoveryContentBytes",
			"captureDeclaration",
			"captureDescriptor",
			"captureExactBytes",
			"captureRecoveryLimits",
			"createError",
			"defaultRecoveryLimits",
			"isError",
			"limits",
			"recoveryContentBytes",
			"validateRecoveryChunk",
			"validateRecoveryManifest",
		]);
		expect(contract.limits).toEqual({
			maxManifestBytes: 212_387,
			maxChunks: 2_048,
			maxSnapshotBytes: 268_435_456,
			snapshotChunkBytes: 131_072,
		});
		expect(contract.defaultRecoveryLimits).toEqual({ maxRecoveryScopes: 4, maxRecoveryContentBytes: 268_435_456 });
	});
	for (const name of COMMON_CASES)
		it(name, async () => {
			expect(await runCommonCase(name, environment())).toEqual(expectedCommonCase(name));
		});

	it("freezes real v1 source and mechanical runtime bytes", () => {
		const files = {
			"tests/fixtures/snapshot-recovery-owner/legacy-node-snapshot-transfer.source.txt":
				"e1fdd51fd533e38a61721949283c8f50879d5c540b235d36161f6e03821c3903",
			"packages/storage-node/tests/fixtures/legacy-snapshot-transfer.mjs":
				"8c85b21feeff0c41aa6d23cc54a4ff97dcac52865fd9b5f8e46e92b99e93b22d",
			"tests/fixtures/snapshot-recovery-owner/legacy-browser-snapshot-transfer.source.txt":
				"b00cbf948eb4ae8b647c5ee5a576f5da3c380e411ecf98dc64453a847cfce820",
			"packages/storage-browser/tests/fixtures/legacy-snapshot-transfer.mjs":
				"e5656d7d60285c2798a1852160868c27c4b91f2813d22e7fd26874aa9b68c0da",
		};
		for (const [file, hash] of Object.entries(files))
			expect(
				createHash("sha256")
					.update(readFileSync(resolve(SOURCE_ROOT, file)))
					.digest("hex")
			).toBe(hash);
	});

	it("metadata-only corruption controls are visible and rejected before any repairing reopen", async () => {
		const env = environment();
		const seeded = await seedLegacy(env);
		await seeded.old.close();
		const legacy = await env.image();
		const store = await env.open();
		await store.close();
		const committed = await env.image();
		assertCommittedMigration(env.primaryFilename, legacy, committed, seeded.debt);
		const db = new DatabaseSync(`${env.primaryFilename}${SUFFIX}`);
		try {
			for (const mutation of [
				"UPDATE snapshot_scopes_v2 SET retention='temporary'",
				"UPDATE snapshot_scopes_v2 SET incarnation=''",
				"UPDATE snapshot_scopes_v2 SET descriptors='[]'",
				"UPDATE snapshot_owner_v2 SET legacy_unclassified_content_bytes=0",
				"UPDATE snapshot_owner_v2 SET recovery_scopes=1",
				"DELETE FROM snapshot_owner_v2",
			]) {
				db.exec("BEGIN IMMEDIATE");
				db.exec(mutation);
				db.exec("COMMIT");
				const corrupted = await env.image();
				expect(corrupted.scopes).toEqual(committed.scopes);
				expect(corrupted.chunks).toEqual(committed.chunks);
				expect(stable(corrupted)).not.toBe(stable(committed));
				expect(() => assertCommittedMigration(env.primaryFilename, legacy, corrupted, seeded.debt), mutation).toThrow();
				// Restore only these test-owned corruption controls, never through the production factory.
				db.exec("BEGIN IMMEDIATE");
				for (const row of committed.durableScopes)
					db.prepare(
						"UPDATE snapshot_scopes_v2 SET retention=?,incarnation=?,descriptors=? WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
					).run(
						String(row.retention),
						String(row.incarnation),
						null,
						String(row.object_id),
						Number(row.epoch),
						String(row.anchor),
						String(row.manifest_digest)
					);
				db.exec("DELETE FROM snapshot_owner_v2");
				db.prepare("INSERT INTO snapshot_owner_v2 VALUES(1,4,268435456,0,0,2,?)").run(seeded.debt);
				db.exec("COMMIT");
				expect(await env.image()).toEqual(committed);
			}
		} finally {
			db.close();
		}
	});

	it("fences the actual already-open old factory connection and its prepared/new v1 SQL", async () => {
		const env = environment();
		const originalPrepare = DatabaseSync.prototype.prepare;
		const observedConnections = new Set<DatabaseSync>();
		DatabaseSync.prototype.prepare = function observePrepare(sql): ReturnType<typeof originalPrepare> {
			if (sql.includes("snapshot_scopes")) observedConnections.add(this);
			return originalPrepare.call(this, sql);
		};
		let seeded: Awaited<ReturnType<typeof seedLegacy>>;
		try {
			seeded = await seedLegacy(env);
		} finally {
			DatabaseSync.prototype.prepare = originalPrepare;
		}
		expect(observedConnections.size).toBe(1);
		const connection = observedConnections.values().next().value;
		if (connection === undefined) throw new Error("actual old factory connection was not observed");
		const prepared = connection.prepare("DELETE FROM snapshot_scopes WHERE object_id=?");
		const oldScope = await seeded.old.openScope(seeded.unfinished.declaration);
		const upgraded = await env.open();
		const before = await env.image();
		const preparedResult = await outcome(() => prepared.run(seeded.unfinished.declaration.scope.objectId));
		const newStatement = await outcome(() =>
			connection
				.prepare("DELETE FROM snapshot_scopes WHERE object_id=?")
				.run(seeded.verified.declaration.scope.objectId)
		);
		const oldCancel = await outcome(() => oldScope.cancel());
		const oldSweep = await outcome(() => seeded.old.sweepExpired());
		const oldOpen = await outcome(() => seeded.old.openScope(fixture("stale-client-create").declaration));
		const after = await env.image();
		expect({
			version: before.version,
			names: before.names,
			preparedRejected: preparedResult.code !== "none",
			newRejected: newStatement.code !== "none",
			oldRejected: [oldCancel, oldSweep, oldOpen].every(({ code }) => code !== "none"),
			unchanged: stable(before) === stable(after),
		}).toEqual({
			version: 2,
			names: ["snapshot_chunks_v2", "snapshot_owner_v2", "snapshot_scopes_v2"],
			preparedRejected: true,
			newRejected: true,
			oldRejected: true,
			unchanged: true,
		});
		await upgraded.close();
	});

	it("preserves foreign-key cascade semantics under the canonical new names", async () => {
		const env = environment();
		const seeded = await seedLegacy(env);
		await seeded.old.close();
		await env.open();
		const db = new DatabaseSync(`${env.primaryFilename}${SUFFIX}`);
		try {
			db.exec("PRAGMA foreign_keys=ON");
			const fks = db.prepare("PRAGMA foreign_key_list(snapshot_chunks_v2)").all();
			expect(fks).toHaveLength(4);
			expect(fks.every((row) => row.table === "snapshot_scopes_v2" && row.on_delete === "CASCADE")).toBe(true);
			// Roll back this test-only substrate probe; it is not an owner-authorized deletion.
			db.exec("BEGIN IMMEDIATE");
			db.prepare("DELETE FROM snapshot_scopes_v2 WHERE object_id=?").run(seeded.verified.declaration.scope.objectId);
			expect(
				db
					.prepare("SELECT COUNT(*) AS count FROM snapshot_chunks_v2 WHERE object_id=?")
					.get(seeded.verified.declaration.scope.objectId)?.count
			).toBe(0);
			db.exec("ROLLBACK");
		} finally {
			db.close();
		}
	});

	it("rejects malformed v1 constraints without mutating the unsupported schema", async () => {
		const env = environment();
		const old = await env.legacy();
		await old.close();
		const db = new DatabaseSync(`${env.primaryFilename}${SUFFIX}`);
		try {
			db.exec(
				"ALTER TABLE snapshot_chunks RENAME TO old_chunks; CREATE TABLE snapshot_chunks AS SELECT * FROM old_chunks; DROP TABLE old_chunks;"
			);
		} finally {
			db.close();
		}
		const before = image(env.primaryFilename);
		const result = await outcome(() => env.open());
		expect(result.code).toBe("unsupported-schema");
		expect(image(env.primaryFilename)).toEqual(before);
	});

	it("rejects v1 NOCASE identity collation despite matching columns and key constraints", async () => {
		const env = environment();
		const old = await env.legacy();
		await old.close();
		const db = new DatabaseSync(`${env.primaryFilename}${SUFFIX}`);
		try {
			const scopeSql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='snapshot_scopes'").get()?.sql);
			const chunksSql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='snapshot_chunks'").get()?.sql);
			expect(scopeSql).toContain("object_id TEXT NOT NULL");
			db.exec("DROP TABLE snapshot_chunks");
			db.exec("DROP TABLE snapshot_scopes");
			db.exec(scopeSql.replace("object_id TEXT NOT NULL", "object_id TEXT COLLATE NOCASE NOT NULL"));
			db.exec(chunksSql.replace("object_id TEXT NOT NULL", "object_id TEXT COLLATE NOCASE NOT NULL"));
		} finally {
			db.close();
		}
		const before = await env.image();
		expect((await outcome(() => env.open())).code).toBe("unsupported-schema");
		expect(await env.image()).toEqual(before);
	});

	it("rolls back legacy arithmetic overflow without truncating old rows", async () => {
		const env = environment();
		const seeded = await seedLegacy(env);
		await seeded.old.close();
		const db = new DatabaseSync(`${env.primaryFilename}${SUFFIX}`);
		try {
			db.prepare("UPDATE snapshot_scopes SET total_bytes=? WHERE object_id=?").run(
				Number.MAX_SAFE_INTEGER,
				seeded.unfinished.declaration.scope.objectId
			);
		} finally {
			db.close();
		}
		const before = await env.image();
		const result = await outcome(() => env.open());
		expect(result.code).toBe("storage-failed");
		expect(await env.image()).toEqual(before);
	});

	for (const selected of ["unfinished", "verified"] as const)
		it(`adjacent unsafe bigint 9007199254740993 on ${selected} is refused without rounding into admitted debt`, async () => {
			const env = environment();
			const seeded = await seedLegacy(env);
			await seeded.old.close();
			const db = new DatabaseSync(`${env.primaryFilename}${SUFFIX}`);
			try {
				db.prepare("UPDATE snapshot_scopes SET total_bytes=? WHERE object_id=?").run(
					BigInt("9007199254740993"),
					seeded[selected].declaration.scope.objectId
				);
			} finally {
				db.close();
			}
			const before = image(env.primaryFilename, true);
			expect(
				before.durableScopes.find((row) => row.object_id === seeded[selected].declaration.scope.objectId)?.total_bytes
			).toBe(BigInt("9007199254740993"));
			expect((await outcome(() => env.open())).code).toBe("storage-failed");
			expect(image(env.primaryFilename, true)).toEqual(before);
		});

	it("sweep preserves unsupported-schema classification for missing owner metadata without mutation", async () => {
		const env = environment();
		const seeded = await seedLegacy(env);
		await seeded.old.close();
		const store = await env.open();
		const db = new DatabaseSync(`${env.primaryFilename}${SUFFIX}`);
		try {
			db.exec("DELETE FROM snapshot_owner_v2");
		} finally {
			db.close();
		}
		const before = await env.image();
		const result = await outcome(() => store.sweepExpired());
		expect(await env.image()).toEqual(before);
		expect(result.code).toBe("unsupported-schema");
	});

	for (const mode of ["unfinished", "completed"] as const)
		it(`documented cursor-repeat injection control: ${mode} native selection`, async () => {
			const env = environment();
			const seeded = await seedLegacy(env);
			await seeded.old.close();
			const before = await env.image();
			const db = new DatabaseSync(`${env.primaryFilename}${SUFFIX}`);
			const hook = installDocumentedCursorRepeat(env.primaryFilename, "snapshot_scopes");
			let visited = 0;
			try {
				db.exec("BEGIN IMMEDIATE");
				const select = db.prepare("SELECT object_id,epoch FROM snapshot_scopes ORDER BY object_id,epoch");
				const rows = mode === "unfinished" ? select.iterate() : select.all();
				for (const row of rows) {
					visited += 1;
					db.prepare("UPDATE snapshot_scopes SET expires_at=expires_at+1 WHERE object_id=?").run(String(row.object_id));
				}
				db.exec("ROLLBACK");
			} finally {
				hook.restore();
				db.close();
			}
			expect(hook.evidence.selects).toBe(1);
			expect(hook.evidence.updates).toBe(mode === "unfinished" ? 3 : 2);
			expect(hook.evidence.injections).toBe(mode === "unfinished" ? 1 : 0);
			expect(hook.evidence.resumedAfterUpdate).toBe(mode === "unfinished" ? 1 : 0);
			expect(hook.evidence.overlaps).toBe(mode === "unfinished" ? 3 : 0);
			expect(visited).toBe(mode === "unfinished" ? 3 : 2);
			expect(await env.image()).toEqual(before);
		});

	it("documented-repeat fault-model guard preserves exact debt using completed selections", async () => {
		const env = environment();
		const seeded = await seedLegacy(env);
		await seeded.old.close();
		const before = await env.image();
		const hook = installDocumentedCursorRepeat(env.primaryFilename, "snapshot_scopes_v2");
		let opened: Awaited<ReturnType<typeof outcome>>;
		try {
			opened = await outcome(() => env.open());
		} finally {
			hook.restore();
		}
		expect(opened.code, JSON.stringify(hook.evidence)).toBe("none");
		expect(hook.evidence.selects).toBeGreaterThan(0);
		expect(hook.evidence.updates).toBe(2);
		expect({
			overlaps: hook.evidence.overlaps,
			injections: hook.evidence.injections,
			resumedAfterUpdate: hook.evidence.resumedAfterUpdate,
		}).toEqual({ overlaps: 0, injections: 0, resumedAfterUpdate: 0 });
		const after = await env.image();
		expect(after.scopes).toEqual(before.scopes);
		expect(after.chunks).toEqual(before.chunks);
		expect(after.ownerRows, `DOCUMENTED_REPEAT_FAULT_MODEL_TELEMETRY: ${JSON.stringify(hook.evidence)}`).toMatchObject([
			{
				legacy_unclassified_scopes: 2,
				legacy_unclassified_content_bytes: seeded.debt,
			},
		]);
		assertCommittedMigration(env.primaryFilename, before, after, seeded.debt);
		const store = opened.value as RecoveryStore;
		expect(await store.recoveryStatus()).toMatchObject({
			legacyUnclassifiedScopes: 2,
			legacyUnclassifiedContentBytes: seeded.debt,
		});
		expect(await env.image()).toEqual(after);
	});

	it("serializes first-open policy across two actual Node processes", async () => {
		const env = environment();
		const bundle = join(directories[directories.length - 1] ?? "", "policy-child.mjs");
		await build({
			entryPoints: [resolve(import.meta.dirname, "fixtures/recovery-owner-policy-child.ts")],
			bundle: true,
			platform: "node",
			format: "esm",
			outfile: bundle,
		});
		const policies = [
			{ maxRecoveryScopes: 2, maxRecoveryContentBytes: 40_000 },
			{ maxRecoveryScopes: 3, maxRecoveryContentBytes: 50_000 },
		];
		const children = policies.map((policy) =>
			spawn(process.execPath, [bundle, env.primaryFilename, JSON.stringify(policy)], {
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			})
		);
		const ready = new Set<number>();
		const results = await Promise.all(
			children.map(
				(child, index) =>
					new Promise<{ code: string; terminal: number | null; signal: string | null }>((resolvePromise, reject) => {
						let code = "no-result";
						const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
						child.on("error", reject);
						child.on("message", (message) => {
							if (message !== null && typeof message === "object" && Reflect.get(message, "kind") === "ready") {
								ready.add(index);
								if (ready.size === 2) for (const peer of children) peer.send({ kind: "go" });
							} else if (message !== null && typeof message === "object" && Reflect.get(message, "kind") === "result")
								code = String(Reflect.get(message, "code"));
						});
						child.on("exit", (terminal, signal) => {
							clearTimeout(timer);
							resolvePromise({ code, terminal, signal });
						});
					})
			)
		);
		expect(ready.size).toBe(2);
		expect(results.every(({ terminal, signal }) => terminal === 0 && signal === null)).toBe(true);
		for (const [index, result] of results.entries())
			if (result.code === "storage-failed") result.code = (await outcome(() => env.open(policies[index]))).code;
		expect(results.map(({ code }) => code).sort()).toEqual(["none", "policy-mismatch"]);
		const owner = await (await env.open()).recoveryStatus();
		expect(owner.limits).toEqual(policies[results.findIndex(({ code }) => code === "none")]);
	});

	for (const target of ["after-mutation", "after-commit"] as const)
		it(`real process death ${target} preserves complete schema and exact payload`, async () => {
			const env = environment();
			const seeded = await seedLegacy(env);
			await seeded.old.close();
			const before = await env.image();
			const bundle = join(directories[directories.length - 1] ?? "", "migration-child.mjs");
			await build({
				entryPoints: [resolve(import.meta.dirname, "fixtures/recovery-owner-migration-child.ts")],
				bundle: true,
				platform: "node",
				format: "esm",
				outfile: bundle,
			});
			const evidence = await new Promise<{
				checkpoint: unknown;
				code: number | null;
				signal: string | null;
				stderr: string;
			}>((resolvePromise, reject) => {
				const child = spawn(process.execPath, [bundle, env.primaryFilename, target], {
					stdio: ["ignore", "ignore", "pipe", "ipc"],
				});
				let checkpoint: unknown;
				let stderr = "";
				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
				child.on("error", reject);
				child.on("message", (message) => {
					checkpoint = message;
					if (message !== null && typeof message === "object" && Reflect.get(message, "kind") === "checkpoint")
						child.kill("SIGKILL");
				});
				child.on("exit", (code, signal) => {
					clearTimeout(timer);
					resolvePromise({ checkpoint, code, signal, stderr });
				});
			});
			expect(evidence, "MIGRATION_EDGE_NOT_REACHED: do not replace an interior crash with a clean open").toMatchObject({
				checkpoint: { kind: "checkpoint", target },
				code: null,
				signal: "SIGKILL",
			});
			const after = await env.image();
			expect(after.version).toBe(target === "after-mutation" ? 1 : 2);
			expect(after.names).toEqual(
				target === "after-mutation"
					? ["snapshot_chunks", "snapshot_scopes"]
					: ["snapshot_chunks_v2", "snapshot_owner_v2", "snapshot_scopes_v2"]
			);
			expect(after.scopes).toEqual(before.scopes);
			expect(after.chunks).toEqual(before.chunks);
			if (target === "after-mutation") expect(after).toEqual(before);
			else {
				assertCommittedMigration(env.primaryFilename, before, after, seeded.debt);
				const reopened = await env.open();
				expect(await reopened.recoveryStatus()).toEqual({
					limits: { maxRecoveryScopes: 4, maxRecoveryContentBytes: 268_435_456 },
					recoveryScopes: 0,
					recoveryContentBytes: 0,
					legacyUnclassifiedScopes: 2,
					legacyUnclassifiedContentBytes: seeded.debt,
					migration: "classification-required",
				});
				expect(await env.image(), "factory reopen/status must not repair a premature partial commit").toEqual(after);
			}
		});
});
