/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
/* eslint-disable jsdoc/require-jsdoc -- Isolated native persistence fixture. */
import { decodeHeadRecordV1, encodeHeadRecordV1 } from "@ts-drp/storage";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";

import { requireThat } from "./proof.js";
import type { Floor, NativeImage, NativePort } from "./types.js";
const fixtureDatabases = new WeakSet<DatabaseSync>(),
	fixtureStatements = new WeakMap<StatementSync, string>();
function use<T>(filename: string, call: (db: DatabaseSync) => T): T {
	const db = new DatabaseSync(filename);
	fixtureDatabases.add(db);
	try {
		return call(db);
	} finally {
		db.close();
	}
}
export function nodePort(identity: string): NativePort {
	const ahe = join(identity, "ahe.sqlite"),
		snapshot = join(identity, "snapshot.sqlite.drp-snapshot-quarantine-v1.sqlite"),
		journal = join(identity, "journal.sqlite.drp-live-journal-v1.sqlite"),
		floor = join(identity, "host-floor.sqlite");
	return {
		image: () =>
			Promise.resolve(
				use(
					ahe,
					(db) =>
						({
							heads: db.prepare("SELECT object_id AS objectId,head_record AS record FROM objects").all(),
							generations: db
								.prepare("SELECT object_id AS objectId,generation_id AS generationId,record FROM generations")
								.all(),
							blobs: db.prepare("SELECT digest,bytes FROM blobs").all(),
							promotions: db
								.prepare("SELECT object_id AS objectId,generation_id AS generationId,digest FROM promotions")
								.all(),
						}) as unknown as NativeImage
				)
			),
		replace: (image) => {
			use(ahe, (db) => {
				db.exec("PRAGMA foreign_keys=OFF");
				db.exec("BEGIN IMMEDIATE");
				try {
					for (const table of ["promotions", "generations", "blobs", "objects"]) db.exec("DELETE FROM " + table);
					for (const r of image.heads)
						db.prepare("INSERT INTO objects(object_id,head_record) VALUES(?,?)").run(r.objectId, r.record);
					for (const r of image.generations)
						db.prepare("INSERT INTO generations(object_id,generation_id,record) VALUES(?,?,?)").run(
							r.objectId,
							r.generationId,
							r.record
						);
					for (const r of image.blobs) db.prepare("INSERT INTO blobs(digest,bytes) VALUES(?,?)").run(r.digest, r.bytes);
					for (const r of image.promotions)
						db.prepare("INSERT INTO promotions(object_id,generation_id,digest) VALUES(?,?,?)").run(
							r.objectId,
							r.generationId,
							r.digest
						);
					db.exec("COMMIT");
				} catch (e) {
					db.exec("ROLLBACK");
					throw e;
				}
			});
			return Promise.resolve();
		},
		readFloor: () =>
			Promise.resolve(
				use(floor, (db) => {
					const r = db.prepare("SELECT state FROM floor WHERE id=1").get();
					return r ? (JSON.parse(String(r.state)) as Floor) : null;
				})
			),
		writeFloor: (state) => {
			use(floor, (db) => {
				db.exec("CREATE TABLE IF NOT EXISTS floor(id INTEGER PRIMARY KEY,state TEXT NOT NULL)");
				db.prepare("INSERT INTO floor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state").run(
					JSON.stringify(state)
				);
			});
			return Promise.resolve();
		},
		snapshotFault: (fault, objectId, epoch) => {
			use(snapshot, (db) => {
				const rows = db.prepare("SELECT * FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=?").all(objectId, epoch);
				requireThat(rows.length === 1, "unique actual snapshot mutation");
				const r = rows[0]!;
				const key = [objectId, epoch, String(r.anchor), String(r.manifest_digest)] as const,
					where = "WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?";
				if (fault === "older-missing-chunk") db.prepare("DELETE FROM snapshot_chunks_v2 " + where).run(...key);
				else if (fault === "older-corrupt-chunk") {
					const chunk = db.prepare("SELECT * FROM snapshot_chunks_v2 " + where + " LIMIT 1").get(...key);
					requireThat(chunk, "real prior chunk");
					const bytes = Uint8Array.from(chunk.exact_bytes as Uint8Array);
					bytes[bytes.length - 1] ^= 1;
					db.prepare("UPDATE snapshot_chunks_v2 SET exact_bytes=? " + where).run(bytes, ...key);
				} else if (fault === "older-replaced")
					db.prepare("UPDATE snapshot_scopes_v2 SET incarnation=? " + where).run("replacement-" + Date.now(), ...key);
				else {
					const charge = Number(r.total_bytes) + (r.exact_manifest_bytes as Uint8Array).length;
					db.prepare(
						"UPDATE snapshot_owner_v2 SET recovery_scopes=recovery_scopes-1,recovery_content_bytes=recovery_content_bytes-? WHERE id=1"
					).run(charge);
					if (fault === "older-missing-manifest") db.prepare("DELETE FROM snapshot_scopes_v2 " + where).run(...key);
					else if (fault === "legacy" || fault === "not-ready") {
						db.prepare(
							"UPDATE snapshot_owner_v2 SET legacy_unclassified_scopes=legacy_unclassified_scopes+1,legacy_unclassified_content_bytes=legacy_unclassified_content_bytes+? WHERE id=1"
						).run(charge);
						db.prepare("UPDATE snapshot_scopes_v2 SET retention='legacy-unclassified',descriptors=NULL " + where).run(
							...key
						);
					} else
						db.prepare("UPDATE snapshot_scopes_v2 SET retention='temporary',state=? " + where).run(
							fault === "open" ? "open" : "verified",
							...key
						);
				}
			});
			return Promise.resolve();
		},
		journalFault: (fault, objectId, epoch) => {
			use(journal, (db) => {
				if (fault === "missing-anchor")
					db.prepare("DELETE FROM scopes WHERE object_id=? AND epoch=?").run(objectId, epoch);
				if (fault === "anchor-neighbor")
					db.prepare("UPDATE scopes SET anchor_digest=? WHERE object_id=? AND epoch=?").run(
						"e".repeat(64),
						objectId,
						epoch
					);
				if (fault === "anchor-cap")
					db.prepare("UPDATE scopes SET exact_anchor_preimage=? WHERE object_id=? AND epoch=?").run(
						new Uint8Array(8193),
						objectId,
						epoch
					);
			});
			return Promise.resolve();
		},
		prepareReplacement: async (objectId, epoch) => {
			const db = new DatabaseSync(snapshot),
				r = db.prepare("SELECT * FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=?").get(objectId, epoch);
			requireThat(r, "actual replacement scope");
			fixtureDatabases.add(db);
			const sql =
					"UPDATE snapshot_scopes_v2 SET incarnation=? WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?",
				update = db.prepare(sql);
			fixtureStatements.set(update, sql);
			return {
				run: () => {
					update.run("replacement-" + Date.now(), objectId, epoch, r.anchor, r.manifest_digest);
					return Promise.resolve();
				},
				close: () => {
					db.close();
					return Promise.resolve();
				},
			};
		},
		prepareStaleHead: async (objectId) => {
			const db = new DatabaseSync(ahe);
			fixtureDatabases.add(db);
			const row = db.prepare("SELECT head_record FROM objects WHERE object_id=?").get(objectId);
			requireThat(row, "actual head row");
			const h = decodeHeadRecordV1(row.head_record as Uint8Array);
			requireThat(h.ok && h.value.kind === "present", "actual head metadata");
			const bytes = encodeHeadRecordV1({ ...h.value, revision: (h.value.revision + 1) as typeof h.value.revision }),
				sql = "UPDATE objects SET head_record=? WHERE object_id=?",
				statement = db.prepare(sql);
			fixtureStatements.set(statement, sql);
			return {
				run: () => {
					statement.run(bytes, objectId);
					return Promise.resolve();
				},
				close: () => {
					db.close();
					return Promise.resolve();
				},
			};
		},
		observe: async <T>(call: () => Promise<T>, nativeChunk?: () => void) => {
			const prepare = DatabaseSync.prototype.prepare,
				exec = DatabaseSync.prototype.exec;
			const originals = new Map(
				["get", "all", "run"].map((m) => [m, Object.getOwnPropertyDescriptor(StatementSync.prototype, m)!])
			);
			const sqls = new WeakMap<StatementSync, string>(),
				fixtures = new WeakSet<StatementSync>(),
				empty = () => ({ modes: [] as string[], terminals: [] as string[], writes: 0, reads: [] as unknown[] });
			const evidence = { ...empty(), fixture: empty() };
			DatabaseSync.prototype.prepare = function (sql) {
				const s = Reflect.apply(prepare, this, [sql]);
				sqls.set(s, sql);
				if (fixtureDatabases.has(this)) fixtures.add(s);
				return s;
			};
			DatabaseSync.prototype.exec = function (sql) {
				const result = Reflect.apply(exec, this, [sql]),
					target = fixtureDatabases.has(this) ? evidence.fixture : evidence;
				if (/^BEGIN/u.test(sql)) target.modes.push(sql);
				if (/^(COMMIT|ROLLBACK)/u.test(sql)) target.terminals.push(sql);
				if (/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/u.test(sql)) target.writes++;
				return result;
			};
			for (const [m, d] of originals)
				Object.defineProperty(StatementSync.prototype, m, {
					...d,
					value: function (this: StatementSync, ...args: unknown[]) {
						const fixture = fixtures.has(this) || fixtureStatements.has(this),
							target = fixture ? evidence.fixture : evidence,
							sql = sqls.get(this) ?? fixtureStatements.get(this) ?? "";
						const value = Reflect.apply(d.value, this, args);
						if (m === "run" && /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/iu.test(sql)) target.writes++;
						else
							target.reads.push({
								sql,
								operation: m,
								parameters: args,
								rows: (Array.isArray(value) ? value : [value]).map((r) =>
									r && typeof r === "object"
										? Object.fromEntries(
												Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? { nativeBytes: v.length } : v])
											)
										: r
								),
							});
						if (!fixture && m === "get" && value && /FROM snapshot_chunks_v2/u.test(sql) && /exact_bytes/u.test(sql))
							nativeChunk?.();
						return value;
					},
				});
			try {
				return { value: await call(), evidence };
			} finally {
				DatabaseSync.prototype.prepare = prepare;
				DatabaseSync.prototype.exec = exec;
				for (const [m, d] of originals) Object.defineProperty(StatementSync.prototype, m, d);
			}
		},
	};
}
