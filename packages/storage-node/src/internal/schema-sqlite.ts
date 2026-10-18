import type { DatabaseSync } from "node:sqlite";
import { nativeLocalSessionSchemaRows, nativeLocalSessionSchemaExtraRows } from "./local-session-lifetime.js";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS objects (
  object_id TEXT PRIMARY KEY,
  head_record BLOB
);
CREATE TABLE IF NOT EXISTS generations (
  object_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  record BLOB NOT NULL,
  PRIMARY KEY (object_id, generation_id),
  FOREIGN KEY (object_id) REFERENCES objects(object_id)
);
CREATE TABLE IF NOT EXISTS blobs (
  digest TEXT PRIMARY KEY,
  bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS promotions (
  object_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  PRIMARY KEY (object_id, generation_id, digest),
  FOREIGN KEY (object_id, generation_id) REFERENCES generations(object_id, generation_id),
  FOREIGN KEY (digest) REFERENCES blobs(digest)
);
CREATE TABLE IF NOT EXISTS retirement_controls (
  object_id TEXT PRIMARY KEY,
  record BLOB NOT NULL
) WITHOUT ROWID;
`;

type DatabaseRow = Record<string, unknown>;
const EXPECTED_COLUMNS = Object.freeze({
	retirement_controls: Object.freeze([
		Object.freeze({ name: "object_id", notnull: 1, pk: 1, type: "TEXT" }),
		Object.freeze({ name: "record", notnull: 1, pk: 0, type: "BLOB" }),
	]),
	blobs: Object.freeze([
		Object.freeze({ name: "digest", notnull: 0, pk: 1, type: "TEXT" }),
		Object.freeze({ name: "bytes", notnull: 1, pk: 0, type: "BLOB" }),
	]),
	generations: Object.freeze([
		Object.freeze({ name: "object_id", notnull: 1, pk: 1, type: "TEXT" }),
		Object.freeze({ name: "generation_id", notnull: 1, pk: 2, type: "TEXT" }),
		Object.freeze({ name: "record", notnull: 1, pk: 0, type: "BLOB" }),
	]),
	objects: Object.freeze([
		Object.freeze({ name: "object_id", notnull: 0, pk: 1, type: "TEXT" }),
		Object.freeze({ name: "head_record", notnull: 0, pk: 0, type: "BLOB" }),
	]),
	promotions: Object.freeze([
		Object.freeze({ name: "object_id", notnull: 1, pk: 1, type: "TEXT" }),
		Object.freeze({ name: "generation_id", notnull: 1, pk: 2, type: "TEXT" }),
		Object.freeze({ name: "digest", notnull: 1, pk: 3, type: "TEXT" }),
	]),
} as const);

const EXPECTED_FOREIGN_KEY_COLUMNS = Object.freeze({
	retirement_controls: Object.freeze([]),
	blobs: Object.freeze([]),
	generations: Object.freeze(["objects:object_id:object_id"]),
	objects: Object.freeze([]),
	promotions: Object.freeze([
		"blobs:digest:digest",
		"generations:generation_id:generation_id",
		"generations:object_id:object_id",
	]),
} as const);

/**
 * Authenticates the supported native version, exact catalog and physical layout in this transaction.
 * @param connection - Owning native transaction connection.
 * @param version - Explicit supported current or migration-beforeimage version.
 * @returns Whether schema objects, constraints, keys and physical form are supported.
 */
export function hasExpectedPhysicalSchema(connection: DatabaseSync, version: 0 | 1 | 2 = 2): boolean {
	if (connection.prepare("PRAGMA user_version").get()?.user_version !== version) return false;
	const legacy = version === 0;
	const expectedNames = Object.keys(EXPECTED_COLUMNS)
		.filter((name) => !legacy || name !== "retirement_controls")
		.sort();
	const tables = nativeLocalSessionSchemaRows(connection, connection
		.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT ?")
		.all(expectedNames.length + 1 + nativeLocalSessionSchemaExtraRows(connection)) as DatabaseRow[]);
	if (tables.length !== expectedNames.length || tables.some((row, index) => row.name !== expectedNames[index])) {
		return false;
	}
	// Exact original table definitions bind constraints/collation and WITHOUT ROWID.
	// Reject any additional native executable/view/index schema before using custody.
	const compact = (sql: string): string =>
		sql
			.replace(/IF NOT EXISTS/giu, "")
			.replace(/\s+/gu, "")
			.toLowerCase();
	const definitions = new Map(
		[...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\([\s\S]*?\)(?: WITHOUT ROWID)?;/gu)].map((match) => [
			match[1],
			compact(match[0].slice(0, -1)),
		])
	);
	const catalog = nativeLocalSessionSchemaRows(connection, connection
		.prepare(
			"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' OR type='index' ORDER BY type,name LIMIT ?"
		)
		.all(expectedNames.length * 2 + 1 + nativeLocalSessionSchemaExtraRows(connection)) as DatabaseRow[]);
	const expectedIndexNames = expectedNames
		.filter((name) => name !== "retirement_controls")
		.map((name) => `sqlite_autoindex_${name}_1`);
	if (catalog.length !== expectedNames.length + expectedIndexNames.length) return false;
	for (const entry of catalog) {
		if (entry.type === "table") {
			if (
				typeof entry.name !== "string" ||
				!expectedNames.includes(entry.name) ||
				typeof entry.sql !== "string" ||
				compact(entry.sql) !== definitions.get(entry.name)
			)
				return false;
		} else if (entry.type === "index") {
			if (
				typeof entry.name !== "string" ||
				!expectedIndexNames.includes(entry.name) ||
				entry.sql !== null ||
				typeof entry.tbl_name !== "string" ||
				entry.name !== `sqlite_autoindex_${entry.tbl_name}_1`
			)
				return false;
		} else return false;
	}
	for (const tableName of expectedNames as (keyof typeof EXPECTED_COLUMNS)[]) {
		const indexes = connection.prepare(`PRAGMA index_list("${tableName}")`).all() as DatabaseRow[];
		if (
			indexes.length !== 1 ||
			indexes[0]?.name !== `sqlite_autoindex_${tableName}_1` ||
			indexes[0].origin !== "pk" ||
			Number(indexes[0].unique) !== 1 ||
			Number(indexes[0].partial) !== 0
		)
			return false;
		const columns = connection.prepare(`PRAGMA table_info("${tableName}")`).all() as DatabaseRow[];
		const expectedColumns = EXPECTED_COLUMNS[tableName];
		if (
			columns.length !== expectedColumns.length ||
			columns.some((column, index) => {
				const expected = expectedColumns[index];
				return (
					expected === undefined ||
					column.name !== expected.name ||
					column.type !== expected.type ||
					Number(column.notnull) !== expected.notnull ||
					Number(column.pk) !== expected.pk ||
					column.dflt_value !== null
				);
			})
		) {
			return false;
		}
		const foreignKeyColumns = (connection.prepare(`PRAGMA foreign_key_list("${tableName}")`).all() as DatabaseRow[])
			.map((row) => `${String(row.table)}:${String(row.from)}:${String(row.to)}`)
			.sort();
		const expectedForeignKeyColumns = [...EXPECTED_FOREIGN_KEY_COLUMNS[tableName]].sort();
		if (
			foreignKeyColumns.length !== expectedForeignKeyColumns.length ||
			foreignKeyColumns.some((value, index) => value !== expectedForeignKeyColumns[index])
		) {
			return false;
		}
	}
	return true;
}
