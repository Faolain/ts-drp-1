/* eslint-disable jsdoc/require-jsdoc -- Narrow test-owned AHE visibility extension to the accepted observer. */
import { DatabaseSync, type SQLInputValue, StatementSync } from "node:sqlite";

import { check, type Edit, type Environment, type Image, OBJECT, type Trace } from "./contract.js";
import { createSqliteAheDurableStore } from "../../../packages/storage-node/dist/src/index.js";
import { observeSQLite } from "../../../packages/storage-node/tests/fixtures/declaration-discovery-environment.js";

const table = (sql: string): string =>
	["generations", "promotions", "blobs", "objects"].find((name) => new RegExp("\\b" + name + "\\b", "iu").test(sql)) ??
	"other";
export function environment(filename: string): Environment {
	function use<T>(action: (db: DatabaseSync) => T): T {
		const db = new DatabaseSync(filename);
		try {
			return action(db);
		} finally {
			db.close();
		}
	}
	const observe: Environment["observe"] = async (action, boundary) => {
		const exec = DatabaseSync.prototype.exec,
			prepare = DatabaseSync.prototype.prepare;
		const members = new Map(
			["get", "all", "iterate"].map((name) => {
				const descriptor = Object.getOwnPropertyDescriptor(StatementSync.prototype, name);
				check(descriptor, "native statement descriptor present");
				return [name, descriptor] as const;
			})
		);
		const sqls = new WeakMap<StatementSync, string>(),
			calls: { sql: string; operation: string; parameters: unknown[] }[] = [],
			modes: string[] = [];
		let terminals = 0;
		DatabaseSync.prototype.prepare = function (sql: string): StatementSync {
			const statement = Reflect.apply(prepare, this, [sql]) as StatementSync;
			sqls.set(statement, sql);
			return statement;
		};
		DatabaseSync.prototype.exec = function (sql: string): void {
			Reflect.apply(exec, this, [sql]);
			if (/^\s*BEGIN\b/iu.test(sql)) {
				modes.push(sql);
				boundary?.("start");
			}
			if (/^\s*(?:COMMIT|ROLLBACK)\b/iu.test(sql)) {
				terminals++;
				boundary?.("terminal");
			}
		};
		for (const [name, descriptor] of members)
			Object.defineProperty(StatementSync.prototype, name, {
				...descriptor,
				value: function (this: StatementSync, ...args: unknown[]): unknown {
					calls.push({ sql: sqls.get(this) ?? "", operation: name, parameters: args });
					return Reflect.apply(descriptor.value as (...args: unknown[]) => unknown, this, args);
				},
			});
		try {
			const observed = await observeSQLite(action as () => Promise<unknown>);
			let call = 0;
			const reads: Trace["reads"] = observed.evidence.materialized.map((entry) => {
				let candidate = calls[call];
				while (candidate && (candidate.sql !== entry.sql || candidate.operation !== entry.operation)) {
					candidate = calls[++call];
				}
				return {
					table: table(entry.sql),
					operation: entry.operation,
					query: entry.sql,
					parameters: calls[call++]?.parameters,
					fields: entry.fields,
				};
			});
			return {
				value: observed.value as Awaited<ReturnType<typeof action>>,
				evidence: { modes, terminals, writes: observed.evidence.writes, reads },
			};
		} finally {
			DatabaseSync.prototype.exec = exec;
			DatabaseSync.prototype.prepare = prepare;
			for (const [name, descriptor] of members) Object.defineProperty(StatementSync.prototype, name, descriptor);
		}
	};
	return {
		backend: "sqlite",
		open: () => Promise.resolve(createSqliteAheDurableStore({ filename })),
		observe,
		image: (): Promise<Image> =>
			Promise.resolve(
				use((db) => ({
					heads: db
						.prepare("SELECT object_id AS objectId,head_record AS record FROM objects ORDER BY object_id")
						.all() as Image["heads"],
					generations: db
						.prepare(
							"SELECT object_id AS objectId,generation_id AS generationId,record FROM generations ORDER BY object_id,generation_id"
						)
						.all() as Image["generations"],
					blobs: db.prepare("SELECT digest,bytes FROM blobs ORDER BY digest").all() as Image["blobs"],
					promotions: db
						.prepare(
							"SELECT object_id AS objectId,generation_id AS generationId,digest FROM promotions ORDER BY object_id,generation_id,digest"
						)
						.all() as Image["promotions"],
				}))
			),
		edit: (value: Edit): Promise<void> => {
			use((db) => {
				db.exec("PRAGMA foreign_keys=OFF"); // External hostile persistence setup only; never a product-call repair.
				if (value.kind === "head")
					db.prepare("UPDATE objects SET head_record=? WHERE object_id=?").run(value.record, OBJECT);
				if (value.kind === "generation")
					db.prepare("UPDATE generations SET generation_id=?,record=? WHERE object_id=? AND generation_id=?").run(
						(value.replaceId ?? value.generationId) as SQLInputValue,
						value.record,
						OBJECT,
						value.generationId as SQLInputValue
					);
				if (value.kind === "delete-generation")
					db.prepare("DELETE FROM generations WHERE object_id=? AND generation_id=?").run(
						OBJECT,
						value.generationId as SQLInputValue
					);
				if (value.kind === "blob") {
					if (value.bytes === null) db.prepare("DELETE FROM blobs WHERE digest=?").run(value.digest);
					else db.prepare("UPDATE blobs SET bytes=? WHERE digest=?").run(value.bytes, value.digest);
				}
				if (value.kind === "promotion")
					db.prepare("DELETE FROM promotions WHERE object_id=? AND generation_id=? AND digest=?").run(
						OBJECT,
						value.generationId as SQLInputValue,
						value.digest
					);
			});
			return Promise.resolve();
		},
		control: async (): Promise<Trace> =>
			(
				await observe(() =>
					Promise.resolve(
						use((db) => {
							db.exec("BEGIN");
							const keys = db
								.prepare(
									"SELECT CASE WHEN typeof(generation_id)='text' AND length(CAST(generation_id AS BLOB))=64 THEN generation_id ELSE NULL END AS gated_key,typeof(generation_id) AS key_type,length(CAST(generation_id AS BLOB)) AS key_bytes FROM generations WHERE object_id=? ORDER BY generation_id LIMIT 8"
								)
								.all(OBJECT);
							if (keys.length === 0) throw new Error("native control actual keys absent");
							db.prepare("SELECT length(record) AS record_bytes FROM generations WHERE object_id=? LIMIT 1").get(
								OBJECT
							);
							db.prepare("SELECT length(bytes) AS blob_bytes FROM blobs LIMIT 1").get();
							db.exec("COMMIT");
						})
					)
				)
			).evidence,
	};
}
