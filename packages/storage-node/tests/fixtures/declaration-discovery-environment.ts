import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import { createNodeSnapshotQuarantineStore as createLegacy } from "./legacy-snapshot-transfer.mjs";
import {
	bounded,
	check,
	type DiscoveryEnvironment,
	type Key,
	type Observation,
	preCopy,
	SQLITE_MATERIALIZATION_LIMITS,
} from "../../../../tests/fixtures/snapshot-declaration-discovery/contract.js";
import { fixture } from "../../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import { createNodeSnapshotQuarantineStore } from "../../src/snapshot-transfer.js";

const columns: Record<string, string> = {
	objectId: "object_id",
	epoch: "epoch",
	anchor: "anchor",
	manifestDigest: "manifest_digest",
	exactCanonicalManifestBytes: "exact_manifest_bytes",
	totalBytes: "total_bytes",
	chunkCount: "chunk_count",
	expiresAt: "expires_at",
	state: "state",
	retention: "retention",
	incarnation: "incarnation",
	descriptors: "descriptors",
};
export const suffix = ".drp-snapshot-quarantine-v1.sqlite";
const where = "object_id=? AND epoch=? AND anchor=? AND manifest_digest=?";
function parameters(key: Key): SQLInputValue[] {
	return [key.objectId, key.epoch, key.anchor, key.manifestDigest];
}
function readable(value: unknown): unknown {
	if (typeof value === "bigint")
		return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
			? Number(value)
			: { unsafeInteger: value.toString() };
	if (value instanceof Uint8Array) return value;
	if (Array.isArray(value)) return value.map(readable);
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, readable(field)]));
	return value;
}
function rows(db: DatabaseSync, sql: string): unknown {
	const statement = db.prepare(sql);
	statement.setReadBigInts(true);
	return readable(statement.all());
}

export interface SQLiteObservation extends Observation {
	materialized: {
		sql: string;
		operation: string;
		fields: { name: string; type: string; bytes?: number; value?: unknown; fingerprint?: string }[];
	}[];
	terminalEvents: string[];
}

/**
 * Observe the actual native bridge's results, before the adapter receives them.
 * @param action
 */
export async function observeSQLite(
	action: () => Promise<unknown>
): Promise<{ value: unknown; evidence: SQLiteObservation }> {
	const evidence: SQLiteObservation = {
		transactions: 0,
		modes: [],
		reads: [],
		writes: 0,
		terminal: false,
		materialized: [],
		terminalEvents: [],
	};
	const prepare = DatabaseSync.prototype.prepare;
	const exec = DatabaseSync.prototype.exec;
	const inspect = (sql: string, operation: string, value: unknown, appendTo?: number): number => {
		const table = /snapshot_chunks_v2/i.test(sql) ? "chunks" : /snapshot_scopes_v2/i.test(sql) ? "scopes" : "other";
		const rows = Array.isArray(value) ? value : [value];
		const fields = rows.flatMap((row) =>
			row && typeof row === "object"
				? Object.entries(row).map(([name, field]) => ({
						name,
						type: ArrayBuffer.isView(field) ? "bytes" : typeof field,
						...(typeof field === "string"
							? {
									bytes: Buffer.byteLength(field),
									value: field.length < 100 ? field : "OVERSIZED_TEXT",
									fingerprint: createHash("sha256").update(field).digest("hex"),
								}
							: ArrayBuffer.isView(field)
								? {
										bytes: field.byteLength,
										fingerprint: createHash("sha256")
											.update(new Uint8Array(field.buffer, field.byteOffset, field.byteLength))
											.digest("hex"),
									}
								: { value: field }),
					}))
				: []
		);
		const values = rows.map((row) =>
			row && typeof row === "object"
				? Object.fromEntries(
						Object.entries(row).map(([name, field]) => [
							name,
							ArrayBuffer.isView(field)
								? new Uint8Array(Math.min(field.byteLength, 1))
								: typeof field === "string" && field.length > 100
									? "OVERSIZED_TEXT"
									: field,
						])
					)
				: row
		);
		if (appendTo !== undefined) {
			const materialized = evidence.materialized[appendTo];
			const read = evidence.reads[appendTo];
			if (!materialized || !read || !Array.isArray(read.value)) throw new Error("iterator observation absent");
			materialized.fields.push(...fields);
			read.value.push(...values);
			return appendTo;
		}
		evidence.materialized.push({ sql, operation, fields });
		evidence.reads.push({ operation, table, query: sql, value: values });
		return evidence.reads.length - 1;
	};
	DatabaseSync.prototype.exec = function (sql: string): void {
		if (/BEGIN\s+IMMEDIATE/i.test(sql)) {
			evidence.transactions++;
			evidence.modes.push("BEGIN IMMEDIATE");
		}
		if (/\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP)\b/i.test(sql)) evidence.writes++;
		Reflect.apply(exec, this, [sql]);
		if (/\b(COMMIT|ROLLBACK)\b/i.test(sql)) {
			evidence.terminal = true;
			evidence.terminalEvents.push(sql);
		}
	};
	DatabaseSync.prototype.prepare = function (sql: string): StatementSync {
		const nativePrepare = prepare.bind(this);
		const statement = Reflect.apply(prepare, this, [sql]) as StatementSync;
		return new Proxy(statement, {
			get(target, property): unknown {
				const member: unknown = Reflect.get(target, property, target);
				if (typeof member !== "function") return member;
				return (...args: unknown[]): unknown => {
					if (property === "run" && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) evidence.writes++;
					const returned: unknown = Reflect.apply(member, target, args);
					let details: string[] | undefined;
					let observationIndex: number | undefined;
					if (property === "get" || property === "all" || property === "iterate") {
						observationIndex = inspect(sql, String(property), property === "iterate" ? [] : returned);
						if (/snapshot_scopes_v2/i.test(sql)) {
							// Diagnostic prepare bypasses the observer, never executing the measured query twice.
							const plan = nativePrepare(`EXPLAIN QUERY PLAN ${sql}`);
							const result = Reflect.apply(plan.all, plan, args) as Record<string, unknown>[];
							const read = evidence.reads.at(-1);
							details = result.map((row) => String(row.detail));
							if (read) read.plan = details;
						}
					}
					if (property === "iterate") {
						const iterable = returned as Iterable<unknown>;
						return (function* (): Generator<unknown> {
							for (const row of iterable) {
								inspect(sql, "iterate", row, observationIndex);
								yield row;
							}
						})();
					}
					return returned;
				};
			},
		});
	};
	try {
		return { value: await action(), evidence };
	} finally {
		DatabaseSync.prototype.prepare = prepare;
		DatabaseSync.prototype.exec = exec;
	}
}

/**
 *
 * @param primaryFilename
 */
export function sqliteEnvironment(primaryFilename: string): DiscoveryEnvironment {
	const filename = `${primaryFilename}${suffix}`;
	const use = <T>(action: (database: DatabaseSync) => T): T => {
		const db = new DatabaseSync(filename);
		try {
			return action(db);
		} finally {
			db.close();
		}
	};
	return {
		backend: "sqlite",
		open: () => Promise.resolve(createNodeSnapshotQuarantineStore({ primaryFilename })),
		legacy: () => Promise.resolve(createLegacy({ primaryFilename })),
		image: () =>
			Promise.resolve(
				use((db) => ({
					schema: rows(db, "SELECT * FROM sqlite_schema ORDER BY name"),
					version: rows(db, "PRAGMA user_version"),
					owner: rows(db, "SELECT * FROM snapshot_owner_v2 ORDER BY id"),
					scopes: rows(db, "SELECT * FROM snapshot_scopes_v2 ORDER BY object_id,epoch,anchor,manifest_digest"),
					chunks: rows(
						db,
						"SELECT * FROM snapshot_chunks_v2 ORDER BY object_id,epoch,anchor,manifest_digest,chunk_index"
					),
				}))
			),
		row: (key) =>
			Promise.resolve(
				use((db) => {
					const row = db.prepare(`SELECT * FROM snapshot_scopes_v2 WHERE ${where}`).get(...parameters(key));
					if (!row) throw new Error("exact fixture row absent");
					return Object.fromEntries(Object.entries(columns).map(([name, column]) => [name, row[column]]));
				})
			),
		put: (row): Promise<void> => {
			use((db) => {
				db.prepare(
					`INSERT OR REPLACE INTO snapshot_scopes_v2 (${Object.values(columns).join(",")}) VALUES (${Object.keys(
						columns
					)
						.map(() => "?")
						.join(",")})`
				).run(...Object.keys(columns).map((name) => row[name] as SQLInputValue));
			});
			return Promise.resolve();
		},
		remove: (key): Promise<void> => {
			use((db) => {
				db.exec("PRAGMA foreign_keys=ON");
				db.prepare(`DELETE FROM snapshot_scopes_v2 WHERE ${where}`).run(...parameters(key));
			});
			return Promise.resolve();
		},
		chunks: (key, operation): Promise<void> => {
			use((db) => {
				db.prepare(
					operation === "delete"
						? `DELETE FROM snapshot_chunks_v2 WHERE ${where}`
						: operation === "descriptor"
							? `UPDATE snapshot_chunks_v2 SET chunk_digest='invalid' WHERE ${where}`
							: `UPDATE snapshot_chunks_v2 SET exact_bytes=zeroblob(byte_length) WHERE ${where}`
				).run(...parameters(key));
			});
			return Promise.resolve();
		},
		observe: observeSQLite,
		failStorage: async (action): Promise<unknown> => {
			const original = DatabaseSync.prototype.exec;
			let reached = false;
			DatabaseSync.prototype.exec = function (sql: string): void {
				if (/BEGIN/i.test(sql)) {
					reached = true;
					throw new Error("injected native transaction failure");
				}
				Reflect.apply(original, this, [sql]);
			};
			try {
				return await action();
			} finally {
				DatabaseSync.prototype.exec = original;
				check(reached, true, "native failure hook reached");
			}
		},
		nativeControl: async (): Promise<unknown> => {
			const store = createNodeSnapshotQuarantineStore({ primaryFilename });
			const selected = fixture("discovery-native-control");
			await store.openScope(selected.declaration);
			const longKey: Key = { ...selected.declaration.scope, objectId: "x".repeat(5000) };
			await store.openScope({ ...selected.declaration, scope: longKey });
			await store.close();
			const result = await observeSQLite(() => {
				use((db) => {
					db.exec("BEGIN IMMEDIATE");
					db.prepare(
						"SELECT * FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
					).get("none", 1, "a", "b");
					db.prepare("SELECT chunk_index FROM snapshot_chunks_v2").all();
					db.exec("COMMIT");
				});
				return Promise.resolve(undefined);
			});
			check(result.evidence.transactions, 1, "instrumented native begin");
			check(
				result.evidence.reads.map((read) => read.table),
				["scopes", "chunks"],
				"instrumented actual native operations"
			);
			let rejected = false;
			try {
				bounded(result.evidence, true, "sqlite");
			} catch {
				rejected = true;
			}
			check(rejected, true, "bound validator detects forbidden native chunk read");
			for (const scan of [false, true]) {
				const probe = await observeSQLite(() =>
					Promise.resolve(
						use((db) => {
							db.exec("BEGIN IMMEDIATE");
							db.prepare(`SELECT 1 FROM snapshot_scopes_v2 WHERE ${where}`).get("none", 1, "a", "b");
							db.prepare(
								scan
									? "SELECT 1 FROM snapshot_scopes_v2 AS s WHERE substr(object_id,1)=? AND epoch=? AND anchor=? LIMIT 1"
									: "SELECT 1 FROM snapshot_scopes_v2 AS s WHERE object_id=? AND epoch=? AND anchor=? LIMIT 1"
							).get("none", 1, "a");
							db.exec("COMMIT");
						})
					)
				);
				let detected = false;
				try {
					bounded(probe.evidence, false, "sqlite");
				} catch {
					detected = true;
				}
				check(detected, scan, "actual native query plan distinguishes SEARCH from SCAN");
			}
			for (const control of [
				{ exact: true, probes: 0, first: false, iterate: false, reject: false },
				{ exact: true, probes: 1, first: false, iterate: false, reject: true },
				{ exact: false, probes: 1, first: false, iterate: false, reject: false },
				{ exact: false, probes: 1, first: false, iterate: true, reject: false },
				{ exact: false, probes: 2, first: false, iterate: false, reject: true },
				{ exact: false, probes: 1, first: true, iterate: false, reject: true },
			]) {
				const key = { ...selected.declaration.scope, ...(control.exact ? {} : { manifestDigest: "ee".repeat(32) }) };
				const observed = await observeSQLite(() =>
					Promise.resolve(
						use((db) => {
							db.exec("BEGIN IMMEDIATE");
							const probe = (): void => {
								const statement = db.prepare(
									"SELECT 1 FROM snapshot_scopes_v2 AS s WHERE object_id=? AND epoch=? AND anchor=? LIMIT 1"
								);
								const args = [key.objectId, key.epoch, key.anchor];
								if (control.iterate) Array.from(statement.iterate(...args));
								else statement.get(...args);
							};
							if (control.first) probe();
							db.prepare(
								`SELECT typeof(exact_manifest_bytes) AS manifest_type FROM snapshot_scopes_v2 WHERE ${where}`
							).get(...parameters(key));
							db.prepare(`SELECT 1 FROM snapshot_scopes_v2 WHERE ${where}`).get(...parameters(key));
							if (!control.first) for (let index = 0; index < control.probes; index++) probe();
							db.exec("COMMIT");
						})
					)
				);
				let detected = false;
				try {
					bounded(observed.evidence, control.exact, "sqlite");
				} catch {
					detected = true;
				}
				check(detected, control.reject, `native miss-only occupancy control ${JSON.stringify(control)}`);
			}
			const nul = use((db) =>
				db
					.prepare("SELECT length(?) AS characters, length(CAST(? AS BLOB)) AS bytes")
					.get("x\0" + "x".repeat(65536), "x\0" + "x".repeat(65536))
			);
			check(nul, { characters: 1, bytes: 65538 }, "native NUL byte-length control");
			const project = async (
				sql: string,
				args: SQLInputValue[],
				rejected: { value: unknown; maxBytes: number } | undefined,
				refuse: boolean,
				label: string
			): Promise<void> => {
				const observed = await observeSQLite(() => Promise.resolve(use((db) => db.prepare(sql).get(...args))));
				let detected = false;
				try {
					await preCopy(observed.evidence, rejected);
				} catch {
					detected = true;
				}
				check(detected, refuse, label);
			};
			for (const [value, limit] of [
				[new Uint8Array(SQLITE_MATERIALIZATION_LIMITS.blobBytes + 1), SQLITE_MATERIALIZATION_LIMITS.blobBytes],
				["z".repeat(SQLITE_MATERIALIZATION_LIMITS.textBytes + 1), SQLITE_MATERIALIZATION_LIMITS.textBytes],
			] as const) {
				await project(
					"SELECT ? AS raw_alias",
					[value],
					{ value, maxBytes: limit },
					true,
					"native over-global-cap copy rejected"
				);
				await project(
					"SELECT substr(?,1,?) AS bounded_alias",
					[value, limit],
					{ value, maxBytes: limit },
					false,
					"native bounded projection permitted at representation cap"
				);
			}
			for (const limit of [
				SQLITE_MATERIALIZATION_LIMITS.stateBytes,
				SQLITE_MATERIALIZATION_LIMITS.retentionBytes,
				SQLITE_MATERIALIZATION_LIMITS.incarnationBytes,
			]) {
				const value = "x".repeat(100000);
				const rejected = { value, maxBytes: limit };
				await project(
					"SELECT ? AS raw_token_alias",
					[value],
					rejected,
					true,
					"native token overrun below global text cap rejected by exact fingerprint"
				);
				await project(
					"SELECT ? AS unrelated_equal_length",
					["y".repeat(value.length)],
					rejected,
					false,
					"unrelated same-size native output permitted"
				);
				await project(
					"SELECT substr(?,1,?) AS bounded_alias",
					[value, limit],
					rejected,
					false,
					"short bounded token projection permitted"
				);
				await project(
					"SELECT typeof(?) AS kind,length(CAST(? AS BLOB)) AS bytes,?=? AS equality",
					[value, value, value, value],
					rejected,
					false,
					"native type byte-length and equality scalars permitted"
				);
			}
			await project(
				"SELECT ? AS unrelated_bytes",
				[new Uint8Array(100000).fill(2)],
				{ value: new Uint8Array(100000).fill(1), maxBytes: 36 },
				false,
				"unrelated same-size native bytes permitted"
			);
			await project(
				"SELECT typeof(?) AS manifest_type,? AS retention",
				["not-bytes", "temporary"],
				{ value: "not-bytes", maxBytes: SQLITE_MATERIALIZATION_LIMITS.blobBytes },
				false,
				"nine-byte collision is not value identity"
			);
			const nulValue = "x\0" + "x".repeat(300000);
			await project(
				"SELECT ? AS native_nul_prefix",
				[nulValue],
				{ value: nulValue, maxBytes: 36 },
				false,
				"native NUL prefix is bounded JS materialization"
			);
			await project(
				"SELECT substr(?,1,1) AS bounded_nul_prefix",
				[nulValue],
				{ value: nulValue, maxBytes: 36 },
				false,
				"legal bounded NUL projection permitted"
			);
			await project(
				"SELECT ? AS short_wrong_type",
				[Uint8Array.of(1)],
				{ value: Uint8Array.of(1), maxBytes: 8 },
				false,
				"small wrong type has a separate poisoned oracle, not an allocation violation"
			);
			for (const [projection, args, refuse] of [
				["object_id AS aliased_metadata", parameters(longKey), true],
				[
					"object_id=? AS same_identity,typeof(object_id) AS key_type,length(CAST(object_id AS BLOB)) AS key_bytes",
					[longKey.objectId, ...parameters(longKey)],
					false,
				],
				["? AS unrelated_same_size", ["y".repeat(5000), ...parameters(longKey)], false],
			] as const) {
				const observed = await observeSQLite(() =>
					Promise.resolve(
						use((db) => {
							db.exec("BEGIN IMMEDIATE");
							const value = db.prepare(`SELECT ${projection} FROM snapshot_scopes_v2 WHERE ${where}`).get(...args);
							db.exec("COMMIT");
							return value;
						})
					)
				);
				bounded(observed.evidence, true, "sqlite");
				await preCopy(observed.evidence);
				let detected = false;
				try {
					await preCopy(observed.evidence, { value: longKey.objectId, maxBytes: 0 });
				} catch {
					detected = true;
				}
				check(detected, refuse, "native stored long-key copy control");
			}
			return { native: true, instrumented: true, invalidObservationRejected: true, nul };
		},
	};
}
