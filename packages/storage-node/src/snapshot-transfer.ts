/// <reference types="node" />

import { consumeSnapshotVerificationReceipt } from "@ts-drp/compaction/snapshot-quarantine-receipt";
import {
	SNAPSHOT_QUARANTINE_RETENTION_MS,
	type SnapshotChunkDescriptor,
	snapshotQuarantineContract,
	type SnapshotQuarantineDeclaration,
	type SnapshotQuarantinePort,
	type SnapshotQuarantineScope,
	type SnapshotQuarantineScopeKey,
	type SnapshotQuarantineStatus,
	type SnapshotQuarantineStore,
	type SnapshotRecoveryChunkReader,
	type SnapshotRecoveryDeclarationLookup,
	type SnapshotRecoveryInspection,
	type SnapshotRecoveryLimits,
	type SnapshotRecoveryOwnerStatus,
	type SnapshotRecoveryProtection,
	type SnapshotRecoveryRoleInventory,
	type SnapshotRecoveryStore,
	snapshotRetirementContract,
	type SnapshotRetirementControl,
	type SnapshotRetirementImage,
	type SnapshotVerificationQuarantine,
	type SnapshotVerificationReceipt,
	type VerifiedSnapshotQuarantineReference,
} from "@ts-drp/storage/snapshot-transfer";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { acquireSnapshotDependencyLock } from "./internal/snapshot-dependency-lock.js";
import { enforceNativeLocalSessionFile, nativeLocalSessionSchemaRows, type LocalSessionLifetime } from "./internal/local-session-lifetime.js";
import { sqliteFilename } from "./internal/sqlite-filename.js";
import { iterateSqliteRows } from "./internal/sqlite-iterator.js";
import { cachedStatement } from "./internal/sqlite-statement-cache.js";

export interface NodeSnapshotQuarantineStoreOptions {
	readonly primaryFilename: string;
	readonly recoveryLimits?: SnapshotRecoveryLimits;
	readonly initialization?: "create" | "reopen";
}

const {
	captureDeclaration,
	captureDescriptor,
	captureExactBytes: exactBytes,
	createError: failure,
	isError,
} = snapshotQuarantineContract;
type CapturedDeclaration = SnapshotQuarantineDeclaration;
type RecoveryRoleReceipt = Awaited<
	ReturnType<NonNullable<SnapshotRecoveryStore<SnapshotVerificationReceipt>["reconcileRecoveryRoles"]>>
>;
const intrinsicJSONParse = JSON.parse;
const intrinsicSyntaxError = SyntaxError;

function promiseCapture<Result>(operation: () => Promise<Result>): Promise<Result> {
	try {
		return operation();
	} catch (error) {
		return Promise.reject(error);
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted === true) throw failure("aborted", "snapshot quarantine operation was aborted", signal.reason);
}

function exactRecord(value: unknown, fields: readonly string[]): value is Readonly<Record<string, unknown>> {
	return (
		value !== null &&
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype &&
		Reflect.ownKeys(value).length === fields.length &&
		fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
	);
}

function captureOptions(value: unknown): {
	primaryFilename: string;
	recoveryLimits: SnapshotRecoveryLimits | undefined;
	initialization: "create" | "reopen";
} {
	if (
		!exactRecord(value, ["primaryFilename"]) &&
		!exactRecord(value, ["primaryFilename", "recoveryLimits"]) &&
		!exactRecord(value, ["primaryFilename", "initialization"]) &&
		!exactRecord(value, ["primaryFilename", "recoveryLimits", "initialization"])
	) {
		throw failure("malformed-input", "node snapshot quarantine options are malformed");
	}
	const primaryFilename = value.primaryFilename;
	if (typeof primaryFilename !== "string" || primaryFilename === "") {
		throw failure("malformed-input", "node snapshot quarantine options are malformed");
	}
	const initialization = Object.prototype.hasOwnProperty.call(value, "initialization")
		? value.initialization
		: "create";
	if (initialization !== "create" && initialization !== "reopen")
		throw failure("malformed-input", "node snapshot initialization is malformed");
	return {
		primaryFilename,
		initialization,
		recoveryLimits: Object.prototype.hasOwnProperty.call(value, "recoveryLimits")
			? snapshotQuarantineContract.captureRecoveryLimits(value.recoveryLimits)
			: undefined,
	};
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function keyParameters(scope: SnapshotQuarantineScopeKey): readonly [string, number, string, string] {
	return [scope.objectId, scope.epoch, scope.anchor, scope.manifestDigest];
}

const transactionModes = new WeakMap<DatabaseSync, "readonly" | "readwrite">();
function runTransaction<Result>(
	database: DatabaseSync,
	operation: () => Result,
	mode: "readonly" | "readwrite" = "readwrite"
): Result {
	database.exec(mode === "readonly" ? "BEGIN" : "BEGIN IMMEDIATE");
	transactionModes.set(database, mode);
	try {
		const result = operation();
		database.exec("COMMIT");
		return result;
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// Preserve the operation failure.
		}
		throw error;
	} finally {
		transactionModes.delete(database);
	}
}

const scopeColumns = [
	"object_id",
	"epoch",
	"anchor",
	"manifest_digest",
	"exact_manifest_bytes",
	"total_bytes",
	"chunk_count",
	"expires_at",
	"state",
] as const;
const chunkColumns = [
	"object_id",
	"epoch",
	"anchor",
	"manifest_digest",
	"chunk_index",
	"chunk_digest",
	"byte_length",
	"exact_bytes",
] as const;
const ownerColumns = [
	"id",
	"max_recovery_scopes",
	"max_recovery_content_bytes",
	"recovery_scopes",
	"recovery_content_bytes",
	"legacy_unclassified_scopes",
	"legacy_unclassified_content_bytes",
] as const;
function validateTable(database: DatabaseSync, name: string, columns: readonly string[], primary: number): void {
	const rows = cachedStatement(database, `PRAGMA table_xinfo(${name})`).all();
	const integer = new Set([
		"epoch",
		"total_bytes",
		"chunk_count",
		"expires_at",
		"chunk_index",
		"byte_length",
		...ownerColumns,
	]);
	const layout = cachedStatement(database, "SELECT wr,strict FROM pragma_table_list WHERE name=?").get(name);
	const indexes = cachedStatement(database, `PRAGMA index_list(${name})`).all();
	if (
		layout?.wr !== 1 ||
		layout.strict !== 0 ||
		rows.length !== columns.length ||
		indexes.length !== 1 ||
		indexes[0]?.origin !== "pk" ||
		indexes[0]?.unique !== 1 ||
		indexes[0]?.partial !== 0 ||
		rows.some(
			(row, index) =>
				row.name !== columns[index] ||
				row.type !==
					(integer.has(String(row.name)) ? "INTEGER" : String(row.name).includes("bytes") ? "BLOB" : "TEXT") ||
				Number(row.pk) !== (index < primary ? index + 1 : 0) ||
				Number(row.notnull) !==
					(row.name === "descriptors" ||
					row.name === "received_certificate_bytes" ||
					row.name === "classification_intent"
						? 0
						: 1) ||
				Number(row.hidden) !== 0
		)
	) {
		throw failure("unsupported-schema", "Node snapshot quarantine table schema is unsupported");
	}
}

function normalizeSchemaSql(sql: string): string {
	return sql
		.split(/('(?:''|[^'])*')/u)
		.map((part, index) => (index % 2 === 1 ? part : part.replace(/[\s"]/gu, "").toLowerCase()))
		.join("");
}
function schemaSql(database: DatabaseSync, table: string): string {
	return normalizeSchemaSql(
		String(cachedStatement(database, "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.sql)
	);
}
function assertSchemaSql(database: DatabaseSync, table: string, expected: readonly string[]): void {
	const actual = schemaSql(database, table);
	if (!expected.some((sql) => normalizeSchemaSql(sql) === actual))
		throw failure("unsupported-schema", "Node snapshot quarantine constraints are unsupported");
}
function validateSchema(database: DatabaseSync, version: number): void {
	const suffix = version === 1 ? "" : "_v2";
	const names = nativeLocalSessionSchemaRows(
		database,
		cachedStatement(database, "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
	).map((row) => row.name);
	const expected =
		version >= 6
			? [
					"snapshot_chunks_v2",
					"snapshot_dependency_slots",
					"snapshot_owner_v2",
					"snapshot_retirement_controls",
					"snapshot_scopes_v2",
				]
			: version === 1
				? ["snapshot_chunks", "snapshot_scopes"]
				: version >= 4
					? ["snapshot_chunks_v2", "snapshot_owner_v2", "snapshot_retirement_controls", "snapshot_scopes_v2"]
					: ["snapshot_chunks_v2", "snapshot_owner_v2", "snapshot_scopes_v2"];
	if (
		JSON.stringify(names) !== JSON.stringify(expected) ||
		(version < 4 &&
			cachedStatement(database, "SELECT name FROM sqlite_schema WHERE type IN ('trigger','view')").all().length !== 0)
	)
		throw failure("unsupported-schema", "Node snapshot quarantine schema is unsupported");

	const scopeBase = `CREATE TABLE snapshot_scopes${suffix}(object_id TEXT NOT NULL,epoch INTEGER NOT NULL,anchor TEXT NOT NULL,manifest_digest TEXT NOT NULL,exact_manifest_bytes BLOB NOT NULL,total_bytes INTEGER NOT NULL,chunk_count INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL`;
	const scopeEnd = ",PRIMARY KEY(object_id,epoch,anchor,manifest_digest)) WITHOUT ROWID";
	const certificateColumn = version >= 3 ? ",received_certificate_bytes BLOB" : "";
	assertSchemaSql(
		database,
		"snapshot_scopes" + suffix,
		version === 1
			? [scopeBase + scopeEnd]
			: [
					scopeBase +
						",retention TEXT NOT NULL,incarnation TEXT NOT NULL,descriptors TEXT" +
						certificateColumn +
						scopeEnd,
					scopeBase +
						",retention TEXT NOT NULL DEFAULT 'legacy-unclassified',incarnation TEXT NOT NULL DEFAULT '',descriptors TEXT" +
						certificateColumn +
						scopeEnd,
				]
	);
	assertSchemaSql(database, "snapshot_chunks" + suffix, [
		`CREATE TABLE snapshot_chunks${suffix}(
 object_id TEXT NOT NULL,epoch INTEGER NOT NULL,anchor TEXT NOT NULL,manifest_digest TEXT NOT NULL,
 chunk_index INTEGER NOT NULL,chunk_digest TEXT NOT NULL,byte_length INTEGER NOT NULL,exact_bytes BLOB NOT NULL,
 PRIMARY KEY(object_id,epoch,anchor,manifest_digest,chunk_index),
 FOREIGN KEY(object_id,epoch,anchor,manifest_digest) REFERENCES snapshot_scopes${suffix}(object_id,epoch,anchor,manifest_digest) ON DELETE CASCADE
 ) WITHOUT ROWID`,
	]);
	validateTable(
		database,
		"snapshot_scopes" + suffix,
		version === 1
			? scopeColumns
			: [
					...scopeColumns,
					"retention",
					"incarnation",
					"descriptors",
					...(version >= 3 ? ["received_certificate_bytes"] : []),
				],
		4
	);
	validateTable(database, "snapshot_chunks" + suffix, chunkColumns, 5);
	const fk = cachedStatement(database, `PRAGMA foreign_key_list(snapshot_chunks${suffix})`).all();
	if (
		fk.length !== 4 ||
		fk.some(
			(row, index) =>
				row.table !== "snapshot_scopes" + suffix ||
				row.from !== scopeColumns[index] ||
				row.to !== scopeColumns[index] ||
				row.on_delete !== "CASCADE" ||
				row.on_update !== "NO ACTION" ||
				Number(row.id) !== 0 ||
				Number(row.seq) !== index
		) ||
		cachedStatement(database, `PRAGMA foreign_key_list(snapshot_scopes${suffix})`).all().length !== 0
	)
		throw failure("unsupported-schema", "Node snapshot quarantine foreign key schema is unsupported");
	if (version >= 2) {
		validateTable(
			database,
			"snapshot_owner_v2",
			[...ownerColumns, ...(version >= 5 ? ["classification_intent"] : [])],
			1
		);
		assertSchemaSql(database, "snapshot_owner_v2", [
			`CREATE TABLE snapshot_owner_v2(
 id INTEGER NOT NULL PRIMARY KEY,max_recovery_scopes INTEGER NOT NULL,max_recovery_content_bytes INTEGER NOT NULL,
 recovery_scopes INTEGER NOT NULL,recovery_content_bytes INTEGER NOT NULL,
 legacy_unclassified_scopes INTEGER NOT NULL,legacy_unclassified_content_bytes INTEGER NOT NULL${version >= 5 ? ",classification_intent TEXT" : ""}) WITHOUT ROWID`,
		]);
	}
	if (cachedStatement(database, "PRAGMA foreign_key_check").get() !== undefined)
		throw failure("unsupported-schema", "snapshot quarantine foreign key data is unsupported");
	if (version >= 6) {
		assertSchemaSql(database, "snapshot_dependency_slots", [snapshotDependencySlotsSql]);
		const indexes = cachedStatement(database, "PRAGMA index_list(snapshot_dependency_slots)").all();
		if (
			indexes.length !== 2 ||
			indexes.some((row) => row.unique !== 1 || row.partial !== 0 || !["pk", "u"].includes(String(row.origin)))
		)
			throw failure("unsupported-schema", "snapshot dependency slot indexes are unsupported");
	}
}
function ownerStatus(database: DatabaseSync): SnapshotRecoveryOwnerStatus {
	const count = cachedStatement(database, "SELECT COUNT(*) AS count FROM snapshot_owner_v2").get()?.count;
	const row = cachedStatement(database, "SELECT * FROM snapshot_owner_v2 WHERE id=1").get();
	if (count !== 1 || row?.id !== 1) throw failure("unsupported-schema", "Node snapshot owner metadata is unsupported");
	const limits = snapshotQuarantineContract.captureRecoveryLimits({
		maxRecoveryScopes: Number(row.max_recovery_scopes),
		maxRecoveryContentBytes: Number(row.max_recovery_content_bytes),
	});
	const checked = (value: unknown): number => {
		if (typeof value !== "number") throw failure("storage-failed", "snapshot owner accounting is invalid");
		return snapshotQuarantineContract.addRecoveryContentBytes(0, value);
	};
	const recoveryScopes = checked(row.recovery_scopes);
	const recoveryContentBytes = checked(row.recovery_content_bytes);
	const legacyUnclassifiedScopes = checked(row.legacy_unclassified_scopes);
	const legacyUnclassifiedContentBytes = checked(row.legacy_unclassified_content_bytes);
	let classificationIntent: SnapshotRecoveryOwnerStatus["classificationIntent"];
	if (row.classification_intent !== null && row.classification_intent !== undefined) {
		if (
			typeof row.classification_intent !== "string" ||
			Buffer.byteLength(row.classification_intent) > snapshotQuarantineContract.maxClassificationIntentBytes
		)
			throw failure("poisoned", "snapshot inherited intent pointer is invalid");
		classificationIntent = snapshotQuarantineContract.captureClassificationIntent(
			intrinsicJSONParse(row.classification_intent)
		);
		const native = cachedStatement(database, "SELECT record FROM snapshot_retirement_controls WHERE object_id=?").get(
			classificationIntent.objectId
		);
		if (native === undefined) throw failure("poisoned", "snapshot inherited intent control is absent");
		const control = snapshotRetirementContract.decodeControl(native.record);
		if (
			control.objectId !== classificationIntent.objectId ||
			control.active !== null ||
			control.completed === null ||
			control.completed.decisionDigest !== classificationIntent.decisionDigest ||
			control.completed.sourceProofDigest !== classificationIntent.sourceProofDigest
		)
			throw failure("poisoned", "snapshot inherited intent control disagrees with its pointer");
	}
	return Object.freeze({
		limits,
		recoveryScopes,
		recoveryContentBytes,
		legacyUnclassifiedScopes,
		legacyUnclassifiedContentBytes,
		migration:
			legacyUnclassifiedScopes === 0 && classificationIntent === undefined ? "ready" : "classification-required",
		...(classificationIntent === undefined ? {} : { classificationIntent }),
	});
}
const snapshotControlSql =
	"CREATE TABLE snapshot_retirement_controls(object_id TEXT NOT NULL PRIMARY KEY,record BLOB NOT NULL) WITHOUT ROWID";
const snapshotDependencySlotsSql = `CREATE TABLE snapshot_dependency_slots(
 slot INTEGER NOT NULL PRIMARY KEY CHECK(slot>=0),object_id TEXT,epoch INTEGER,anchor TEXT,manifest_digest TEXT,incarnation TEXT NOT NULL,
 CHECK((object_id IS NULL AND epoch IS NULL AND anchor IS NULL AND manifest_digest IS NULL) OR (object_id IS NOT NULL AND epoch IS NOT NULL AND anchor IS NOT NULL AND manifest_digest IS NOT NULL)),
 UNIQUE(object_id,epoch,anchor,manifest_digest),
 FOREIGN KEY(object_id,epoch,anchor,manifest_digest) REFERENCES snapshot_scopes_v2(object_id,epoch,anchor,manifest_digest) ON DELETE SET NULL) WITHOUT ROWID`;
function snapshotTriggerSql(): string[] {
	const result: string[] = [];
	for (const table of ["snapshot_scopes_v2", "snapshot_chunks_v2", "snapshot_owner_v2"])
		for (const event of ["INSERT", "UPDATE", "DELETE"]) {
			const sources = event === "UPDATE" ? ["OLD", "NEW"] : [event === "DELETE" ? "OLD" : "NEW"];
			const checks = sources
				.map((row) => {
					if (table === "snapshot_owner_v2") return "SELECT snapshot_writer_v4('owner','','','','','');";
					const incarnation =
						table === "snapshot_scopes_v2"
							? `${row}.incarnation`
							: `coalesce((SELECT incarnation FROM snapshot_scopes_v2 WHERE object_id=${row}.object_id AND epoch=${row}.epoch AND anchor=${row}.anchor AND manifest_digest=${row}.manifest_digest),'')`;
					return `SELECT snapshot_writer_v4('${event}',${row}.object_id,${row}.epoch,${row}.anchor,${row}.manifest_digest,${incarnation});`;
				})
				.join(" ");
			result.push(
				`CREATE TRIGGER snapshot_v4_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} BEGIN ${checks} END`
			);
		}
	return result;
}
function admitSchema(
	database: DatabaseSync,
	supplied: SnapshotRecoveryLimits | undefined,
	initialization: "create" | "reopen" = "create"
): void {
	runTransaction(database, () => {
		const version = Number(cachedStatement(database, "PRAGMA user_version").get()?.user_version);
		if (initialization === "reopen" && version !== 5 && version !== 6)
			throw failure("unsupported-schema", "snapshot reopen requires its complete current schema");
		const tables = nativeLocalSessionSchemaRows(
			database,
			cachedStatement(database, "SELECT name FROM sqlite_schema WHERE type='table'").all()
		);
		if (version === 0 && tables.length === 0) {
			database.exec(`
 CREATE TABLE snapshot_scopes_v2(
 object_id TEXT NOT NULL, epoch INTEGER NOT NULL, anchor TEXT NOT NULL, manifest_digest TEXT NOT NULL,
 exact_manifest_bytes BLOB NOT NULL, total_bytes INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, state TEXT NOT NULL, retention TEXT NOT NULL, incarnation TEXT NOT NULL, descriptors TEXT,
 PRIMARY KEY(object_id,epoch,anchor,manifest_digest)) WITHOUT ROWID;
 CREATE TABLE snapshot_chunks_v2(
 object_id TEXT NOT NULL, epoch INTEGER NOT NULL, anchor TEXT NOT NULL, manifest_digest TEXT NOT NULL,
 chunk_index INTEGER NOT NULL, chunk_digest TEXT NOT NULL, byte_length INTEGER NOT NULL, exact_bytes BLOB NOT NULL,
 PRIMARY KEY(object_id,epoch,anchor,manifest_digest,chunk_index),
 FOREIGN KEY(object_id,epoch,anchor,manifest_digest) REFERENCES snapshot_scopes_v2(object_id,epoch,anchor,manifest_digest) ON DELETE CASCADE
 ) WITHOUT ROWID;`);
		} else if (version === 1) {
			validateSchema(database, 1);
			database.exec(`
 ALTER TABLE snapshot_scopes RENAME TO snapshot_scopes_v2;
 ALTER TABLE snapshot_chunks RENAME TO snapshot_chunks_v2;
 ALTER TABLE snapshot_scopes_v2 ADD COLUMN retention TEXT NOT NULL DEFAULT 'legacy-unclassified';
 ALTER TABLE snapshot_scopes_v2 ADD COLUMN incarnation TEXT NOT NULL DEFAULT '';
 ALTER TABLE snapshot_scopes_v2 ADD COLUMN descriptors TEXT;`);
		} else if (version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6) {
			throw failure("unsupported-schema", "Node snapshot quarantine schema is unsupported");
		}
		if (version < 2) {
			let count = 0,
				content = 0;
			const selection =
				"SELECT object_id,epoch,anchor,manifest_digest,total_bytes,length(exact_manifest_bytes) AS manifest_length FROM snapshot_scopes_v2";
			const first = database.prepare(`${selection} ORDER BY object_id,epoch,anchor,manifest_digest LIMIT 1`);
			const next = database.prepare(
				`${selection} WHERE (object_id,epoch,anchor,manifest_digest) > (?,?,?,?) ORDER BY object_id,epoch,anchor,manifest_digest LIMIT 1`
			);
			const update = cachedStatement(
				database,
				"UPDATE snapshot_scopes_v2 SET incarnation=? WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
			);
			first.setReadBigInts(true);
			next.setReadBigInts(true);
			// Each get finishes before its UPDATE; only the immutable primary key advances traversal.
			let row = first.get();
			while (row !== undefined) {
				const key = [
					row.object_id as string,
					row.epoch as bigint,
					row.anchor as string,
					row.manifest_digest as string,
				] as const;
				const charge = snapshotQuarantineContract.recoveryContentBytes(
					Number(row.total_bytes),
					Number(row.manifest_length)
				);
				count = snapshotQuarantineContract.addRecoveryContentBytes(count, 1);
				content = snapshotQuarantineContract.addRecoveryContentBytes(content, charge);
				update.run(randomUUID(), ...key);
				row = next.get(...key);
			}
			const limits = supplied ?? snapshotQuarantineContract.defaultRecoveryLimits;
			database.exec(`CREATE TABLE snapshot_owner_v2(
 id INTEGER NOT NULL PRIMARY KEY, max_recovery_scopes INTEGER NOT NULL, max_recovery_content_bytes INTEGER NOT NULL,
 recovery_scopes INTEGER NOT NULL, recovery_content_bytes INTEGER NOT NULL,
 legacy_unclassified_scopes INTEGER NOT NULL, legacy_unclassified_content_bytes INTEGER NOT NULL) WITHOUT ROWID;`);
			cachedStatement(database, "INSERT INTO snapshot_owner_v2 VALUES(1,?,?,0,0,?,?)").run(
				limits.maxRecoveryScopes,
				limits.maxRecoveryContentBytes,
				count,
				content
			);
			database.exec("PRAGMA user_version=2");
		}
		if (version < 3) {
			validateSchema(database, 2);
			database.exec("ALTER TABLE snapshot_scopes_v2 ADD COLUMN received_certificate_bytes BLOB");
			database.exec("PRAGMA user_version=3");
		}
		if (version < 4) {
			validateSchema(database, 3);
			database.exec(snapshotControlSql);
			for (const sql of snapshotTriggerSql()) database.exec(sql);
			database.exec("PRAGMA user_version=4");
		}
		if (version < 5) {
			validateSchema(database, 4);
			database.exec("ALTER TABLE snapshot_owner_v2 ADD COLUMN classification_intent TEXT");
			database.exec("PRAGMA user_version=5");
		}
		if (version < 6) {
			validateSchema(database, 5);
			database.exec(snapshotDependencySlotsSql);
			database.exec("PRAGMA user_version=6");
		}
		validateSchema(database, 6);
		assertSchemaSql(database, "snapshot_retirement_controls", [snapshotControlSql]);
		const expectedTriggers = snapshotTriggerSql().map(normalizeSchemaSql).sort();
		const actualTriggers = cachedStatement(database, "SELECT sql FROM sqlite_schema WHERE type='trigger'")
			.all()
			.map((r) => normalizeSchemaSql(String(r.sql)))
			.sort();
		if (
			JSON.stringify(actualTriggers) !== JSON.stringify(expectedTriggers) ||
			cachedStatement(database, "SELECT 1 FROM sqlite_schema WHERE type='view' LIMIT 1").get() !== undefined
		)
			throw failure("unsupported-schema", "snapshot native writer predicates differ");
		const persisted = ownerStatus(database).limits;
		if (
			supplied !== undefined &&
			(supplied.maxRecoveryScopes !== persisted.maxRecoveryScopes ||
				supplied.maxRecoveryContentBytes !== persisted.maxRecoveryContentBytes)
		)
			throw failure("policy-mismatch", "snapshot recovery policy differs from the durable owner");
	});
}

/**
 * Creates the dedicated WAL/FULL Node snapshot quarantine store.
 * @param options - Exact primary SQLite filename owner.
 * @returns Closed durable snapshot-quarantine capability.
 */
export function createNodeSnapshotQuarantineStore(
	options: NodeSnapshotQuarantineStoreOptions,
	session?: LocalSessionLifetime
): SnapshotRecoveryStore<SnapshotVerificationReceipt> {
	const { primaryFilename, recoveryLimits, initialization } = captureOptions(options);
	session?.assertCurrent();
	let acquired: DatabaseSync | undefined;
	let canonicalFilename: string;
	try {
		const database = new DatabaseSync(
			sqliteFilename(`${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`, initialization)
		);
		acquired = database;
		enforceNativeLocalSessionFile(database, `${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`, session, initialization !== "reopen");
		canonicalFilename = realpathSync(`${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`);
		if (
			initialization === "reopen" &&
			String(cachedStatement(database, "PRAGMA journal_mode").get()?.journal_mode).toLowerCase() !== "wal"
		)
			throw failure("unsupported-schema", "snapshot reopen requires durable WAL storage");
		database.exec(
			"PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;"
		);
		admitSchema(database, recoveryLimits, initialization);
	} catch (error) {
		acquired?.close();
		if (isError(error)) throw error;
		throw failure("storage-failed", "Node snapshot quarantine admission failed", error);
	}
	const database = acquired;
	const readControl = (objectId: string): SnapshotRetirementControl | null => {
		const row = cachedStatement(
			database,
			`SELECT length(record) AS size,CASE WHEN typeof(record)='blob' AND length(record) BETWEEN 1 AND ${snapshotRetirementContract.maxImageBytes} THEN record ELSE NULL END AS record FROM snapshot_retirement_controls WHERE object_id=?`
		).get(objectId);
		if (row === undefined) return null;
		const control = snapshotRetirementContract.decodeControl(row.record);
		if (control.objectId !== objectId) throw failure("poisoned", "snapshot retirement control key disagrees");
		return control;
	};
	let authenticatedRoleDeletion = false;
	database.function("snapshot_writer_v4", (event, objectId, epoch, anchor, manifestDigest, incarnation) => {
		if (event === "owner") return 1;
		const scope = snapshotQuarantineContract.captureRecoveryDependencyScope({
			objectId,
			epoch,
			anchor,
			manifestDigest,
		});
		const control = readControl(scope.objectId);
		if (
			event === "DELETE" &&
			typeof incarnation === "string" &&
			snapshotRetirementContract.protected(control, scope, incarnation)
		)
			throw failure("recovery-owned", "snapshot native protected hole cannot be deleted");
		if (event === "DELETE" && authenticatedRoleDeletion) return 1;
		let selectedIncarnation = typeof incarnation === "string" && incarnation !== "" ? incarnation : undefined;
		// A cascading chunk deletion follows its already-admitted parent DELETE.
		if (event === "DELETE" && selectedIncarnation === undefined)
			selectedIncarnation =
				control?.active?.preparation.protectedScopes.find((s) => JSON.stringify(s.scope) === JSON.stringify(scope))
					?.incarnation ??
				control?.completed?.protectedScopes.find((s) => JSON.stringify(s.scope) === JSON.stringify(scope))?.incarnation;
		if (!snapshotRetirementContract.allows(control, scope, selectedIncarnation))
			throw failure("stale-scope", "snapshot native scope is retired");
		return 1;
	});
	database.function("snapshot_collectible_v4", (objectId, epoch, anchor, manifestDigest, incarnation) => {
		const scope = snapshotQuarantineContract.captureRecoveryDependencyScope({
				objectId,
				epoch,
				anchor,
				manifestDigest,
			}),
			control = readControl(scope.objectId);
		return typeof incarnation === "string" &&
			snapshotRetirementContract.allows(control, scope, incarnation) &&
			!snapshotRetirementContract.protected(control, scope, incarnation)
			? 1
			: 0;
	});
	const nativeImage = (objectId: string, classificationSource = false): SnapshotRetirementImage => {
		const owner = ownerStatus(database);
		const restoredOwner = classificationSource ? snapshotQuarantineContract.classificationSourceOwner(owner) : owner;
		const remaining = new Set(
			classificationSource
				? owner.classificationIntent!.promoted.map((row) => JSON.stringify(keyParameters(row.scope)))
				: []
		);
		// Native image observation includes held inherited debt without granting
		// a role. The original public mutation barrier remains unchanged.
		const count = Number(
			cachedStatement(database, "SELECT count(*) AS n FROM snapshot_scopes_v2 WHERE object_id=?").get(objectId)?.n
		);
		let metadataBytes = Number(
			cachedStatement(
				database,
				"SELECT coalesce(sum(length(exact_manifest_bytes)+coalesce(length(CAST(descriptors AS BLOB)),0)+coalesce(length(received_certificate_bytes),0)+length(CAST(object_id AS BLOB))+length(CAST(anchor AS BLOB))+length(CAST(manifest_digest AS BLOB))+length(CAST(incarnation AS BLOB))+length(CAST(state AS BLOB))+length(CAST(retention AS BLOB))+512),0) AS n FROM snapshot_scopes_v2 WHERE object_id=?"
			).get(objectId)?.n
		);
		const chunks = cachedStatement(
			database,
			"SELECT count(*) AS n,coalesce(sum(length(exact_bytes)),0) AS bytes,max(length(exact_bytes)) AS largest FROM snapshot_chunks_v2 WHERE object_id=?"
		).get(objectId);
		const chunkCount = Number(chunks?.n);
		if (
			!Number.isSafeInteger(count) ||
			count > snapshotRetirementContract.maxScopes ||
			!Number.isSafeInteger(metadataBytes) ||
			metadataBytes > snapshotRetirementContract.maxImageBytes ||
			!Number.isSafeInteger(chunkCount) ||
			chunkCount > snapshotRetirementContract.maxChunks ||
			Number(chunks?.bytes) > snapshotQuarantineContract.limits.maxSnapshotBytes ||
			Number(chunks?.largest ?? 0) > snapshotQuarantineContract.limits.snapshotChunkBytes
		)
			throw failure("recovery-full", "snapshot retirement capture exceeds native entitlement");
		let imageDigest = snapshotRetirementContract.imageDigest({ objectId, owner: restoredOwner });
		const scopes: SnapshotRetirementImage["scopes"][number][] = [];
		const rows = cachedStatement(
			database,
			"SELECT * FROM snapshot_scopes_v2 WHERE object_id=? ORDER BY epoch,anchor,manifest_digest"
		).all(objectId);
		for (const row of rows) {
			const scope = snapshotQuarantineContract.captureRecoveryDependencyScope({
				objectId: row.object_id,
				epoch: row.epoch,
				anchor: row.anchor,
				manifestDigest: row.manifest_digest,
			});
			const metadata = readRecoveryMetadata(scope);
			if (metadata === undefined) throw failure("poisoned", "snapshot retirement metadata is absent");
			const prior = classificationSource
				? owner.classificationIntent!.promoted.find(
						(pair) => JSON.stringify(keyParameters(pair.scope)) === JSON.stringify(keyParameters(scope))
					)
				: undefined;
			if (
				prior !== undefined &&
				(metadata.observation.retention !== "recovery" ||
					metadata.observation.state !== "verified" ||
					metadata.incarnation !== prior.incarnation ||
					metadata.observation.declaration.totalBytes +
						metadata.observation.declaration.exactCanonicalManifestBytes.byteLength !==
						prior.contentBytes ||
					row.descriptors !== JSON.stringify(metadata.observation.declaration.chunks))
			)
				throw failure("poisoned", "snapshot inherited postimage disagrees with exact source subset");
			const sourceRow = prior === undefined ? row : { ...row, retention: "legacy-unclassified", descriptors: null };
			if (prior !== undefined) {
				remaining.delete(JSON.stringify(keyParameters(scope)));
				metadataBytes +=
					Buffer.byteLength("legacy-unclassified") -
					Buffer.byteLength("recovery") -
					Buffer.byteLength(String(row.descriptors));
			}
			scopes.push(Object.freeze({ scope, incarnation: metadata.incarnation }));
			imageDigest = snapshotRetirementContract.imageDigest({ prior: imageDigest, row: sourceRow });
		}
		if (remaining.size !== 0) throw failure("incomplete", "snapshot inherited source subset is missing");
		const query = database.prepare(
			"SELECT * FROM snapshot_chunks_v2 WHERE object_id=? ORDER BY epoch,anchor,manifest_digest,chunk_index"
		);
		for (const row of iterateSqliteRows(query, objectId)) {
			const scope = snapshotQuarantineContract.captureRecoveryDependencyScope({
				objectId: row.object_id,
				epoch: row.epoch,
				anchor: row.anchor,
				manifestDigest: row.manifest_digest,
			});
			const metadata = readRecoveryMetadata(scope);
			if (metadata === undefined || !(row.exact_bytes instanceof Uint8Array))
				throw failure("poisoned", "snapshot retirement chunk is orphaned");
			const descriptor = {
				index: Number(row.chunk_index),
				digest: String(row.chunk_digest),
				byteLength: Number(row.byte_length),
			};
			snapshotQuarantineContract.validateRecoveryChunk(metadata.observation.declaration, descriptor, row.exact_bytes);
			imageDigest = snapshotRetirementContract.imageDigest({
				prior: imageDigest,
				key: keyParameters(scope),
				index: descriptor.index,
				digest: descriptor.digest,
				byteLength: descriptor.byteLength,
			});
		}
		// Keep the StatementSync strongly alive until iteration ends (native API lifetime).
		void query.sourceSQL;
		return Object.freeze({ imageDigest, scopeCount: count, chunkCount, metadataBytes, scopes: Object.freeze(scopes) });
	};
	let closed = false;
	let terminated = false;
	let closing: Promise<void> | undefined;
	let tail = Promise.resolve();
	const schedule = <Result>(operation: () => Result | Promise<Result>): Promise<Result> => {
		try { session?.assertCurrent(); } catch (primary) { return Promise.reject(primary); }
		if (closed) return Promise.reject(failure("closed", "snapshot quarantine store is closed"));
		const selected = tail
			.then(() => {
				session?.assertCurrent();
				if (terminated) throw failure("closed", "snapshot quarantine store is closed");
				return operation();
			})
			.catch((error: unknown) => {
				if (isError(error)) throw error;
				throw failure("storage-failed", "Node snapshot quarantine operation failed", error);
			});
		tail = selected.then(
			() => undefined,
			() => undefined
		);
		return session ? session.run(() => selected) : selected;
	};

	const requireMutable = (): void => {
		if (ownerStatus(database).migration !== "ready")
			throw failure("migration-required", "snapshot legacy classification is required");
	};
	type BorrowedExclusion = Readonly<{ check(): Promise<void>; release(): Promise<void> }>;
	const dependencyGuards = new Set<{
		invalidate(): void;
		join(): Promise<void>;
		readonly released: Promise<void>;
		owns(scopes: readonly SnapshotQuarantineScopeKey[]): boolean;
		borrow(): BorrowedExclusion;
		protection: SnapshotRecoveryProtection;
	}>();
	const dependencyKey = (scope: SnapshotQuarantineScopeKey): string => JSON.stringify(keyParameters(scope));
	const lockFilename = (slot: number): string => `${canonicalFilename}.dependency-${slot}.sqlite`;
	const allocateDependencySlot = (
		scope: SnapshotQuarantineScopeKey
	): Readonly<{ slot: number; incarnation: string }> => {
		const metadata = readRecoveryMetadata(scope);
		if (
			metadata === undefined ||
			metadata.observation.state !== "verified" ||
			!["recovery", "legacy-unclassified"].includes(metadata.observation.retention)
		)
			throw failure("stale-scope", "snapshot dependency is not verified native recovery custody");
		const declared = ownerStatus(database).limits.maxRecoveryScopes;
		const bound =
			declared > Number.MAX_SAFE_INTEGER - snapshotRetirementContract.maxScopes
				? Number.MAX_SAFE_INTEGER
				: declared + snapshotRetirementContract.maxScopes;
		const existing = cachedStatement(
			database,
			"SELECT slot,incarnation FROM snapshot_dependency_slots WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
		).get(...keyParameters(scope));
		if (existing !== undefined) {
			if (
				typeof existing.slot !== "number" ||
				!Number.isSafeInteger(existing.slot) ||
				existing.slot < 0 ||
				existing.slot >= bound ||
				existing.incarnation !== metadata.incarnation
			)
				throw failure("poisoned", "snapshot dependency slot is not bound to its native incarnation");
			return { slot: existing.slot, incarnation: metadata.incarnation };
		}
		const free = cachedStatement(
			database,
			"SELECT slot FROM snapshot_dependency_slots WHERE object_id IS NULL ORDER BY slot LIMIT 1"
		).get();
		const slot = Number(
			free?.slot ??
				cachedStatement(database, "SELECT coalesce(max(slot)+1,0) AS slot FROM snapshot_dependency_slots").get()?.slot
		);
		if (!Number.isSafeInteger(slot) || slot < 0 || slot >= bound)
			throw failure("recovery-full", "snapshot dependency native slots are exhausted");
		// A released binding can still have admitted work finishing under its old
		// native lock. Reuse refuses until that physical lock joins; never unlink.
		let initialized: ReturnType<typeof acquireSnapshotDependencyLock>;
		try {
			initialized = acquireSnapshotDependencyLock(lockFilename(slot), "exclusive", free === undefined);
		} catch (cause) {
			if (typeof cause === "object" && cause !== null && Reflect.get(cause, "errcode") === 5)
				throw failure("recovery-full", "snapshot dependency slot is still held by admitted work", cause);
			throw cause;
		}
		try {
			if (free === undefined)
				cachedStatement(database, "INSERT INTO snapshot_dependency_slots VALUES(?,?,?,?,?,?)").run(
					slot,
					...keyParameters(scope),
					metadata.incarnation
				);
			else
				cachedStatement(
					database,
					"UPDATE snapshot_dependency_slots SET object_id=?,epoch=?,anchor=?,manifest_digest=?,incarnation=? WHERE slot=? AND object_id IS NULL"
				).run(...keyParameters(scope), metadata.incarnation, slot);
		} finally {
			initialized.release();
		}
		return { slot, incarnation: metadata.incarnation };
	};
	const acquireDependencyLocks = async (
		scopes: readonly SnapshotQuarantineScopeKey[],
		mode: "shared" | "exclusive"
	): Promise<SnapshotRecoveryProtection> => {
		session?.assertCurrent();
		if (closed) throw failure("closed", "snapshot quarantine store is closed");
		const joined = session?.enter();
		let releaseHandle: (() => void) | undefined;
		try { releaseHandle = session?.reserveNativeHandle(); }
		catch (primary) { joined?.(); throw primary; }
		let resolveReleased!: () => void, rejectReleased!: (cause: unknown) => void;
		const released = new Promise<void>((resolve, reject) => { resolveReleased = resolve; rejectReleased = reject; });
		void released.catch(() => undefined);
		let alive = true;
		const native: ReturnType<typeof acquireSnapshotDependencyLock>[] = [];
		const acquired: Readonly<{ scope: SnapshotQuarantineScopeKey; slot: number; incarnation: string }>[] = [];
		const admitted = new Set<Promise<void>>();
		let finishAcquisition!: () => void;
		const acquisitionFinished = new Promise<void>((resolve) => {
			finishAcquisition = resolve;
		});
		const invalidate = (): void => {
			alive = false;
		};
		let terminal: Promise<void> | undefined;
		const release = (): Promise<void> => {
			invalidate();
			return (terminal ??= acquisitionFinished.then(async () => {
				await Promise.all([...admitted]);
				const failures: unknown[] = [];
				for (const lock of native.reverse())
					try {
						lock.release();
					} catch (cause) {
						failures.push(cause);
					}
				dependencyGuards.delete(owner);
				if (!failures.length) try { releaseHandle?.(); } catch (cause) { failures.push(cause); }
				if (!failures.length) { joined?.(); resolveReleased(); }
				if (failures.length) {
					const cause = new AggregateError(failures, "snapshot dependency native release failed", { cause: failures[0] });
					session?.fail(cause); rejectReleased(cause); throw cause;
				}
			}));
		};
		const checkPhysical = (): void => {
			session?.assertCurrent();
			if (native.length !== scopes.length) throw failure("stale-scope", "snapshot dependency lock was lost");
			for (const lock of native) lock.check();
		};
		const protection: SnapshotRecoveryProtection = Object.freeze({
			check: function (this: SnapshotRecoveryProtection): Promise<void> {
				return promiseCapture(() => {
					if (this !== protection) throw failure("invalid-carrier", "snapshot protection is foreign or copied");
					if (!alive || closed) throw failure("stale-scope", "snapshot dependency lock is no longer admitted");
					checkPhysical();
					return Promise.resolve();
				});
			},
			release: function (this: SnapshotRecoveryProtection): Promise<void> {
				return promiseCapture(() => {
					if (this !== protection) throw failure("invalid-carrier", "snapshot protection is foreign or copied");
					return release();
				});
			},
		});
		const owner = {
			invalidate,
			join: release,
			released,
			protection,
			owns: (selected: readonly SnapshotQuarantineScopeKey[]): boolean =>
				mode === "exclusive" &&
				alive &&
				!closed &&
				native.length === scopes.length &&
				selected.every((scope) => scopes.some((held) => dependencyKey(held) === dependencyKey(scope))),
			borrow: (): BorrowedExclusion => {
				if (mode !== "exclusive" || !alive || closed)
					throw failure("stale-scope", "snapshot retirement lock is no longer admitted");
				checkPhysical();
				let finish!: () => void;
				const pending = new Promise<void>((resolve) => {
					finish = resolve;
				});
				admitted.add(pending);
				let completed = false;
				return {
					check: () =>
						promiseCapture(() => {
							if (completed) throw failure("stale-scope", "snapshot retirement lock was released");
							checkPhysical();
							return Promise.resolve();
						}),
					release: (): Promise<void> => {
						if (!completed) {
							completed = true;
							admitted.delete(pending);
							finish();
						}
						return Promise.resolve();
					},
				};
			},
		};
		dependencyGuards.add(owner);
		try {
			for (const scope of scopes) {
				if (!alive || closed) throw failure("closed", "snapshot quarantine store is closed");
				const binding = await schedule(() => runTransaction(database, () => allocateDependencySlot(scope)));
				if (!alive || closed) throw failure("closed", "snapshot quarantine store is closed");
				try {
					native.push(acquireSnapshotDependencyLock(lockFilename(binding.slot), mode));
				} catch (cause) {
					if (typeof cause === "object" && cause !== null && Reflect.get(cause, "errcode") === 5)
						throw failure("recovery-full", "snapshot dependency is held by another operation", cause);
					throw cause;
				}
				acquired.push({ scope, ...binding });
			}
			await schedule(() =>
				runTransaction(
					database,
					() => {
						checkPhysical();
						for (const binding of acquired) {
							const metadata = readRecoveryMetadata(binding.scope);
							const slot = cachedStatement(
								database,
								"SELECT slot,incarnation FROM snapshot_dependency_slots WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
							).get(...keyParameters(binding.scope));
							if (
								metadata === undefined ||
								metadata.incarnation !== binding.incarnation ||
								metadata.observation.state !== "verified" ||
								!["recovery", "legacy-unclassified"].includes(metadata.observation.retention) ||
								slot?.slot !== binding.slot ||
								slot.incarnation !== binding.incarnation
							)
								throw failure("stale-scope", "snapshot dependency native binding changed before delivery");
						}
					},
					"readonly"
				)
			);
			await protection.check();
			return protection;
		} catch (primary) {
			invalidate();
			finishAcquisition();
			const capturedPrimary = isError(primary)
				? primary
				: failure("storage-failed", "snapshot native dependency acquisition failed", primary);
			try {
				await release();
			} catch (cleanup) {
				throw new AggregateError([capturedPrimary, cleanup], "snapshot dependency acquisition and release failed", {
					cause: capturedPrimary,
				});
			}
			throw capturedPrimary;
		} finally {
			finishAcquisition();
		}
	};
	const acquireRecoveryDependencyProtection: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["acquireRecoveryDependencyProtection"]
	> = (input) =>
		promiseCapture(() =>
			acquireDependencyLocks([snapshotQuarantineContract.captureRecoveryDependencyScope(input)], "shared").then(
				(protection) => Object.freeze({ kind: "held" as const, protection })
			)
		);
	const acquireRecoveryRetirementExclusion: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["acquireRecoveryRetirementExclusion"]
	> = (input) =>
		promiseCapture(() =>
			acquireDependencyLocks(snapshotQuarantineContract.captureRecoveryRetirementScopes(input), "exclusive")
		);
	const sweep = (now: number): number => {
		if (ownerStatus(database).migration !== "ready") return 0;
		return Number(
			cachedStatement(
				database,
				"DELETE FROM snapshot_scopes_v2 WHERE expires_at <= ? AND retention='temporary' AND snapshot_collectible_v4(object_id,epoch,anchor,manifest_digest,incarnation)=1"
			).run(now).changes
		);
	};
	const recorded = (
		declaration: CapturedDeclaration,
		incarnation?: string
	): Record<string, SQLOutputValue> | undefined => {
		const validCertificate = `(received_certificate_bytes IS NULL OR (typeof(received_certificate_bytes)='blob' AND length(received_certificate_bytes) BETWEEN 1 AND ${snapshotQuarantineContract.receivedCertificateWrapperMaxBytes}))`;
		const selectors = cachedStatement(
			database,
			`SELECT object_id,epoch,anchor,manifest_digest,exact_manifest_bytes,total_bytes,chunk_count,expires_at,state,retention,incarnation,descriptors,${validCertificate} AS certificate_valid,CASE WHEN ${validCertificate} THEN received_certificate_bytes ELSE NULL END AS received_certificate_bytes FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? LIMIT 2`
		).all(declaration.scope.objectId, declaration.scope.epoch, declaration.scope.anchor);
		if (selectors.length > 1) throw failure("conflict", "snapshot recovery identity has ambiguous custody");
		const selector = selectors[0];
		if (selector === undefined) return undefined;
		if (
			selector.certificate_valid !== 1 ||
			typeof selector.incarnation !== "string" ||
			selector.incarnation.length === 0 ||
			!["open", "verified", "poisoned"].includes(String(selector.state)) ||
			!["temporary", "recovery", "legacy-unclassified"].includes(String(selector.retention)) ||
			(selector.retention === "legacy-unclassified") !== (selector.descriptors === null) ||
			(selector.descriptors !== null && typeof selector.descriptors !== "string")
		)
			throw failure("poisoned", "snapshot quarantine scope row is malformed");
		const certificate = snapshotQuarantineContract.openReceivedCertificate(
			selector.incarnation as string,
			selector.received_certificate_bytes
		);
		if (certificate !== null && (selector.retention !== "recovery" || selector.state !== "verified"))
			throw failure("poisoned", "certificate is not owned by verified recovery custody");
		if (incarnation !== undefined && selector.incarnation !== incarnation)
			throw failure("stale-scope", "snapshot quarantine handle belongs to an earlier incarnation");
		if (
			transactionModes.get(database) === "readwrite" &&
			!snapshotRetirementContract.allows(
				readControl(declaration.scope.objectId),
				declaration.scope,
				String(selector.incarnation)
			)
		)
			throw failure("stale-scope", "snapshot scope is retired");
		if (
			selector.manifest_digest !== declaration.scope.manifestDigest ||
			!sameBytes(
				new Uint8Array(selector.exact_manifest_bytes as Uint8Array),
				declaration.exactCanonicalManifestBytes
			) ||
			Number(selector.total_bytes) !== declaration.totalBytes ||
			Number(selector.chunk_count) !== declaration.chunks.length ||
			(selector.descriptors !== null &&
				JSON.stringify(
					snapshotQuarantineContract.captureRecoveryDescriptorCarrier(
						intrinsicJSONParse(String(selector.descriptors)),
						declaration.scope,
						String(selector.incarnation)
					).chunks
				) !== JSON.stringify(declaration.chunks))
		)
			throw failure("conflict", "snapshot quarantine declaration conflicts with durable state");
		if (selector.descriptors === null) {
			for (const row of iterateSqliteRows(
				database.prepare(
					"SELECT chunk_index,chunk_digest,byte_length FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
				),
				...keyParameters(declaration.scope)
			)) {
				const expected = declaration.chunks[Number(row.chunk_index)];
				if (
					expected === undefined ||
					expected.digest !== row.chunk_digest ||
					expected.byteLength !== Number(row.byte_length)
				)
					throw failure("conflict", "snapshot legacy chunk identity conflicts with declaration");
			}
		}
		return selector;
	};
	const statusOf = (
		declaration: CapturedDeclaration,
		row: NonNullable<ReturnType<typeof recorded>>
	): SnapshotQuarantineStatus => {
		const occupied = new Set(
			cachedStatement(
				database,
				"SELECT chunk_index FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
			)
				.all(...keyParameters(declaration.scope))
				.map((row) => Number(row.chunk_index))
		);
		return Object.freeze({
			expiresAt: Number(row.expires_at),
			kind: row.state as SnapshotQuarantineStatus["kind"],
			retention: row.retention as SnapshotQuarantineStatus["retention"],
			missingIndices: Object.freeze(
				declaration.chunks.filter(({ index }) => !occupied.has(index)).map(({ index }) => index)
			),
		});
	};
	const inspectRecovery: SnapshotQuarantineStore<SnapshotVerificationReceipt>["inspectRecovery"] = (
		input,
		options = {}
	) =>
		promiseCapture(() => {
			const declaration = captureDeclaration(input);
			const signal = options.signal;
			throwIfAborted(signal);
			return schedule(() =>
				runTransaction(database, (): SnapshotRecoveryInspection => {
					throwIfAborted(signal);
					const row = recorded(declaration);
					return row === undefined
						? Object.freeze({ kind: "missing" })
						: Object.freeze({ kind: "present", status: statusOf(declaration, row) });
				})
			);
		});
	const readRecoveryMetadata = (
		scope: SnapshotQuarantineScopeKey,
		read?: Readonly<{ declaration: SnapshotQuarantineDeclaration; incarnation?: string }>
	):
		| {
				observation: Extract<SnapshotRecoveryDeclarationLookup, { kind: "present" }>;
				incarnation: string;
				certificate: Uint8Array | null;
				certificateContentBytes: number;
				carrier: unknown;
		  }
		| undefined => {
		const limits = snapshotQuarantineContract.limits;
		// The current writer's compact ASCII JSON: brackets, descriptors, commas.
		const descriptorBytes =
			2 +
			limits.maxChunks *
				JSON.stringify({
					index: limits.maxChunks - 1,
					byteLength: limits.snapshotChunkBytes,
					digest: "f".repeat(64),
				}).length +
			limits.maxChunks -
			1;
		const exact = "FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?";
		// Scalar predicates prevent native-to-JS copies of corrupt TEXT/BLOB values,
		// including TEXT whose character length stops at an embedded NUL.
		const preflight = cachedStatement(
			database,
			`SELECT (
		typeof(exact_manifest_bytes)='blob' AND length(exact_manifest_bytes) BETWEEN 1 AND ${limits.maxManifestBytes}
		AND typeof(state)='text' AND length(CAST(state AS BLOB)) BETWEEN 1 AND 8 AND instr(state,char(0))=0
		AND typeof(retention)='text' AND length(CAST(retention AS BLOB)) BETWEEN 1 AND 19 AND instr(retention,char(0))=0
		AND typeof(incarnation)='text' AND length(CAST(incarnation AS BLOB)) BETWEEN 1 AND 36
		AND (received_certificate_bytes IS NULL OR (typeof(received_certificate_bytes)='blob' AND length(received_certificate_bytes) BETWEEN 1 AND ${snapshotQuarantineContract.receivedCertificateWrapperMaxBytes} AND state='verified' AND retention='recovery'))
		AND (descriptors IS NULL OR (typeof(descriptors)='text' AND length(CAST(descriptors AS BLOB)) BETWEEN 1 AND ${descriptorBytes} AND instr(descriptors,char(0))=0))
		AND typeof(total_bytes)='integer' AND total_bytes BETWEEN 1 AND ${limits.maxSnapshotBytes}
		AND typeof(chunk_count)='integer' AND chunk_count BETWEEN 1 AND ${limits.maxChunks}
		AND typeof(expires_at)='integer' AND expires_at BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
				) AS valid ${exact}`
			)
			.get(...keyParameters(scope));
		if (preflight === undefined) return undefined;
		if (preflight.valid !== 1) throw failure("poisoned", "snapshot recovery metadata exceeds its durable envelope");
		// The exact primary key already binds identity. Reuse the captured key;
		// never materialize another unbounded copy of the persisted objectId.
		const row = cachedStatement(
			database,
			`SELECT exact_manifest_bytes,total_bytes,chunk_count,expires_at,state,retention,incarnation,descriptors,received_certificate_bytes ${exact}`
		).get(...keyParameters(scope));
		if (row === undefined) throw failure("storage-failed", "snapshot exact row vanished within its transaction");
		if ((row.retention === "legacy-unclassified") !== (row.descriptors === null))
			throw failure("poisoned", "snapshot descriptor nullness disagrees with retention");
		let descriptors: unknown = null;
		if (row.descriptors !== null) {
			if (typeof row.descriptors !== "string") throw failure("poisoned", "snapshot durable descriptors must be text");
			try {
				descriptors = intrinsicJSONParse(row.descriptors);
			} catch (error) {
				if (error instanceof intrinsicSyntaxError)
					throw failure("poisoned", "snapshot durable descriptors are invalid", error);
				throw failure("storage-failed", "snapshot durable descriptors processing failed", error);
			}
		}
		const observation = snapshotQuarantineContract.validateRecoveryManifest(
			scope,
			{
				exactCanonicalManifestBytes: row.exact_manifest_bytes,
				totalBytes: row.total_bytes,
				chunkCount: row.chunk_count,
				expiresAt: row.expires_at,
				state: row.state,
				retention: row.retention,
				incarnation: row.incarnation,
				descriptors,
			},
			read
		);
		const certificate = snapshotQuarantineContract.openReceivedCertificate(
			row.incarnation as string,
			row.received_certificate_bytes
		);
		return {
			observation,
			incarnation: row.incarnation as string,
			certificate,
			certificateContentBytes: certificate === null ? 0 : (row.received_certificate_bytes as Uint8Array).byteLength,
			carrier: descriptors,
		};
	};
	const inventories = new WeakMap<
		object,
		Readonly<{ objectId: string } & Omit<SnapshotRecoveryRoleInventory, "custody">>
	>();
	const roleInventory = (objectId: string): Omit<SnapshotRecoveryRoleInventory, "custody"> => {
		const owner = ownerStatus(database);
		if (owner.legacyUnclassifiedScopes > snapshotRetirementContract.maxScopes)
			throw failure("recovery-full", "snapshot inherited census exceeds bounded work");
		if (owner.recoveryScopes > snapshotQuarantineContract.defaultRecoveryLimits.maxRecoveryScopes)
			throw failure("recovery-full", "snapshot role census exceeds the bounded recovery pool");
		const unclassified = cachedStatement(
			database,
			"SELECT 1 AS bad FROM snapshot_scopes_v2 WHERE object_id=? AND (retention NOT IN ('temporary','recovery','legacy-unclassified') OR typeof(retention)<>'text') LIMIT 1"
		).get(objectId);
		if (unclassified !== undefined) throw failure("migration-required", "snapshot role is unclassified");
		const legacyScopes: NonNullable<SnapshotRecoveryRoleInventory["legacyScopes"]>[number][] = [];
		const legacyBounds = cachedStatement(
			database,
			"SELECT count(*) AS n,coalesce(sum(length(exact_manifest_bytes)),0) AS bytes FROM snapshot_scopes_v2 WHERE object_id=? AND retention='legacy-unclassified'"
		).get(objectId);
		if (
			cachedStatement(
				database,
				`SELECT 1 AS bad FROM snapshot_scopes_v2 WHERE object_id=? AND retention='legacy-unclassified' AND (
			typeof(epoch)<>'integer' OR epoch<0 OR epoch>${Number.MAX_SAFE_INTEGER}
			OR typeof(anchor)<>'text' OR length(CAST(anchor AS BLOB))<>64 OR instr(anchor,char(0))<>0
			OR typeof(manifest_digest)<>'text' OR length(CAST(manifest_digest AS BLOB))<>64 OR instr(manifest_digest,char(0))<>0) LIMIT 1`
				)
				.get(objectId) !== undefined
		)
			throw failure("poisoned", "snapshot inherited census has an invalid bounded key");
		if (
			!Number.isSafeInteger(Number(legacyBounds?.n)) ||
			Number(legacyBounds?.n) > snapshotRetirementContract.maxScopes ||
			!Number.isSafeInteger(Number(legacyBounds?.bytes)) ||
			Number(legacyBounds?.bytes) > snapshotRetirementContract.maxImageBytes
		)
			throw failure("recovery-full", "snapshot inherited manifests exceed bounded work");
		for (const key of iterateSqliteRows(
			database.prepare(
				"SELECT epoch,anchor,manifest_digest FROM snapshot_scopes_v2 WHERE object_id=? AND retention='legacy-unclassified' ORDER BY epoch,anchor,manifest_digest"
			),
			objectId
		)) {
			const scope = snapshotQuarantineContract.captureScope({
				objectId,
				epoch: key.epoch,
				anchor: key.anchor,
				manifestDigest: key.manifest_digest,
			});
			const metadata = readRecoveryMetadata(scope);
			if (metadata === undefined || metadata.observation.retention !== "legacy-unclassified")
				throw failure("poisoned", "snapshot inherited census changed");
			const observation = metadata.observation;
			legacyScopes.push(
				Object.freeze({
					scope,
					incarnation: metadata.incarnation,
					state: observation.state,
					expiresAt: observation.expiresAt,
					contentBytes: snapshotQuarantineContract.recoveryContentBytes(
						observation.declaration.totalBytes,
						observation.declaration.exactCanonicalManifestBytes.byteLength
					),
				})
			);
		}
		const count = Number(
			cachedStatement(
				database,
				"SELECT count(*) AS count FROM snapshot_scopes_v2 WHERE object_id=? AND retention='recovery'"
			).get(objectId)?.count
		);
		if (
			!Number.isSafeInteger(count) ||
			count < 0 ||
			count > snapshotQuarantineContract.defaultRecoveryLimits.maxRecoveryScopes
		)
			throw failure("recovery-full", "snapshot role census exceeds the bounded recovery pool");
		// Scalar predicates bound persisted key copies before native-to-JS allocation.
		const rows = cachedStatement(
			database,
			`SELECT epoch,anchor,manifest_digest FROM snapshot_scopes_v2 WHERE object_id=? AND retention='recovery'
			AND typeof(epoch)='integer' AND epoch BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
			AND typeof(anchor)='text' AND length(CAST(anchor AS BLOB))=64 AND instr(anchor,char(0))=0
			AND typeof(manifest_digest)='text' AND length(CAST(manifest_digest AS BLOB))=64 AND instr(manifest_digest,char(0))=0
			ORDER BY epoch,anchor,manifest_digest LIMIT 5`
			)
			.all(objectId);
		if (rows.length !== count) throw failure("poisoned", "snapshot role census has an invalid key");
		const scopes = rows.map((row) => {
			const scope = snapshotQuarantineContract.captureScope({
				objectId,
				epoch: Number(row.epoch),
				anchor: row.anchor,
				manifestDigest: row.manifest_digest,
			});
			const metadata = readRecoveryMetadata(scope);
			if (
				metadata === undefined ||
				metadata.observation.state !== "verified" ||
				metadata.observation.retention !== "recovery"
			)
				throw failure("poisoned", "snapshot role census is not verified");
			const declaration = metadata.observation.declaration;
			const chunkCount = Number(
				cachedStatement(
					database,
					"SELECT count(*) AS count FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
				).get(...keyParameters(scope))?.count
			);
			if (chunkCount !== declaration.chunks.length) throw failure("incomplete", "snapshot role closure is incomplete");
			for (const descriptor of declaration.chunks) {
				const valid = cachedStatement(
					database,
					`SELECT (typeof(exact_bytes)='blob' AND length(exact_bytes)=? AND typeof(byte_length)='integer' AND byte_length=? AND chunk_digest=?) AS valid FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=?`
				).get(
					descriptor.byteLength,
					descriptor.byteLength,
					descriptor.digest,
					...keyParameters(scope),
					descriptor.index
				);
				if (valid?.valid !== 1) throw failure("poisoned", "snapshot role chunk exceeds its exact envelope");
				const chunk = cachedStatement(
					database,
					"SELECT exact_bytes FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=?"
				).get(...keyParameters(scope), descriptor.index);
				const bytes = chunk?.exact_bytes;
				if (!(bytes instanceof Uint8Array)) throw failure("poisoned", "snapshot role chunk is absent");
				snapshotQuarantineContract.validateRecoveryChunk(declaration, descriptor, bytes);
			}
			const carrier = snapshotQuarantineContract.captureRecoveryDescriptorCarrier(
				metadata.carrier,
				scope,
				metadata.incarnation
			);
			return Object.freeze({
				scope,
				incarnation: metadata.incarnation,
				contentBytes: snapshotQuarantineContract.addRecoveryContentBytes(
					snapshotQuarantineContract.recoveryContentBytes(
						declaration.totalBytes,
						declaration.exactCanonicalManifestBytes.byteLength,
						metadata.certificateContentBytes
					),
					carrier.extraContentBytes
				),
				...(carrier.retirement === undefined ? {} : { retirement: carrier.retirement }),
			});
		});
		if (
			scopes.length > owner.recoveryScopes ||
			scopes.reduce((sum, row) => sum + row.contentBytes, 0) > owner.recoveryContentBytes
		)
			throw failure("poisoned", "snapshot role accounting is inconsistent");
		if (
			legacyScopes.length > owner.legacyUnclassifiedScopes ||
			legacyScopes.reduce((sum, row) => snapshotQuarantineContract.addRecoveryContentBytes(sum, row.contentBytes), 0) >
				owner.legacyUnclassifiedContentBytes
		)
			throw failure("poisoned", "snapshot inherited accounting is inconsistent");
		return Object.freeze({
			scopes: Object.freeze(scopes),
			owner,
			...(owner.migration === "ready" ? {} : { legacyScopes: Object.freeze(legacyScopes) }),
		});
	};
	const captureRecoveryRoleInventory: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["captureRecoveryRoleInventory"]
	> = (input, options = {}) =>
		promiseCapture(() => {
			const objectId = snapshotQuarantineContract.captureRecoveryRoleObject(input),
				signal = options.signal;
			throwIfAborted(signal);
			return schedule(() =>
				runTransaction(
					database,
					() => {
						throwIfAborted(signal);
						const captured = roleInventory(objectId),
							custody = Object.freeze({});
						throwIfAborted(signal);
						inventories.set(custody, Object.freeze({ objectId, ...captured }));
						return Object.freeze({ custody, ...captured });
					},
					"readonly"
				)
			);
		});
	const reconcileRecoveryRoles: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["reconcileRecoveryRoles"]
	> = (input, options = {}) =>
		promiseCapture(() => {
			const custody = snapshotQuarantineContract.captureRecoveryRoleCustody(input),
				signal = options.signal;
			const inventory = inventories.get(custody);
			if (inventory === undefined)
				throw failure("invalid-carrier", "snapshot role inventory is foreign, copied or consumed");
			const captured = snapshotQuarantineContract.captureRecoveryRoleProtection(input);
			inventories.delete(captured.custody);
			throwIfAborted(signal);
			const decision =
				captured.retirementDecision === undefined
					? undefined
					: snapshotQuarantineContract.consumeRecoveryRoleRetirementDecision(
							captured.retirementDecision,
							store,
							captured.custody,
							captured.protectedScopes
						);
			const protectedKeys = new Set(captured.protectedScopes.map(dependencyKey));
			const exclusionScopes =
				decision?.classification === undefined
					? inventory.scopes.filter((row) => !protectedKeys.has(dependencyKey(row.scope))).map((row) => row.scope)
					: (inventory.legacyScopes ?? [])
							.filter((row) => protectedKeys.has(dependencyKey(row.scope)))
							.map((row) => row.scope);
			return (async (): Promise<RecoveryRoleReceipt> => {
				let acquiredProtection: SnapshotRecoveryProtection | undefined;
				let borrowed: BorrowedExclusion | undefined;
				let primary: unknown;
				let failed = false;
				let result: RecoveryRoleReceipt | undefined;
				try {
					if (exclusionScopes.length !== 0) {
						const scopes = snapshotQuarantineContract.captureRecoveryRetirementScopes({ scopes: exclusionScopes });
						let owner = [...dependencyGuards].find((guard) => guard.owns(scopes));
						if (owner === undefined) {
							acquiredProtection = await acquireDependencyLocks(scopes, "exclusive");
							owner = [...dependencyGuards].find(
								(guard) => guard.protection === acquiredProtection && guard.owns(scopes)
							);
						}
						if (owner === undefined) throw failure("stale-scope", "snapshot backend exclusion is unavailable");
						borrowed = owner.borrow();
					}
					result = await schedule(async () => {
						await borrowed?.check();
						let beforeFrontierImage:
							| Readonly<{ control: SnapshotRetirementControl | null; image: ReturnType<typeof nativeImage> }>
							| undefined;
						let afterFrontierImage: typeof beforeFrontierImage;
						const perform = (): Awaited<
							ReturnType<NonNullable<SnapshotRecoveryStore<SnapshotVerificationReceipt>["reconcileRecoveryRoles"]>>
						> =>
							runTransaction(database, () => {
								throwIfAborted(signal);
								const current = roleInventory(inventory.objectId);
								if (
									JSON.stringify(current) !==
									JSON.stringify({
										scopes: inventory.scopes,
										owner: inventory.owner,
										...(inventory.legacyScopes === undefined ? {} : { legacyScopes: inventory.legacyScopes }),
									})
								)
									throw failure("stale-scope", "snapshot role inventory changed before retirement");
								if (decision?.classification !== undefined) {
									if (nativeImage(inventory.objectId).imageDigest !== decision.classification.expectedImageDigest)
										throw failure("stale-scope", "snapshot inherited whole source changed before classification");
									beforeFrontierImage = {
										control: readControl(inventory.objectId),
										image: nativeImage(inventory.objectId),
									};
									const result = snapshotQuarantineContract.recoveryClassificationAccounting(
										current,
										decision,
										readControl(inventory.objectId)
									);
									for (const row of result.promoted) {
										const metadata = readRecoveryMetadata(row.scope);
										if (metadata === undefined) throw failure("incomplete", "snapshot inherited source disappeared");
										// Original reader validates canonical descriptors and every native
										// chunk before any inherited classification mutation.
										const declaration = metadata.observation.declaration;
										const chunks = Number(
											cachedStatement(
												database,
												"SELECT count(*) AS n FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
											).get(...keyParameters(row.scope))?.n
										);
										if (chunks !== declaration.chunks.length)
											throw failure("incomplete", "snapshot inherited closure is incomplete");
										for (const descriptor of declaration.chunks) {
											const chunk = cachedStatement(
												database,
												"SELECT exact_bytes,byte_length,chunk_digest FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=?"
											).get(...keyParameters(row.scope), descriptor.index);
											if (
												chunk?.byte_length !== descriptor.byteLength ||
												chunk?.chunk_digest !== descriptor.digest ||
												!(chunk?.exact_bytes instanceof Uint8Array)
											)
												throw failure("poisoned", "snapshot inherited chunk is inconsistent");
											snapshotQuarantineContract.validateRecoveryChunk(declaration, descriptor, chunk.exact_bytes);
										}
										cachedStatement(
											database,
											"UPDATE snapshot_scopes_v2 SET retention='recovery',descriptors=? WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
										).run(JSON.stringify(declaration.chunks), ...keyParameters(row.scope));
									}
									cachedStatement(
										database,
										"UPDATE snapshot_owner_v2 SET recovery_scopes=?,recovery_content_bytes=?,legacy_unclassified_scopes=?,legacy_unclassified_content_bytes=?,classification_intent=? WHERE id=1"
									).run(
										result.owner.recoveryScopes,
										result.owner.recoveryContentBytes,
										result.owner.legacyUnclassifiedScopes,
										result.owner.legacyUnclassifiedContentBytes,
										result.owner.classificationIntent === undefined
											? null
											: JSON.stringify(result.owner.classificationIntent)
									);
									afterFrontierImage = {
										control: readControl(inventory.objectId),
										image: nativeImage(inventory.objectId),
									};
									return Object.freeze({
										retiredScopes: Object.freeze([]),
										recoveryScopes: result.owner.recoveryScopes,
										recoveryContentBytes: result.owner.recoveryContentBytes,
									});
								}
								if (current.owner.migration !== "ready")
									throw failure("migration-required", "snapshot legacy classification is required");
								const keys = new Set(captured.protectedScopes.map((scope) => JSON.stringify(keyParameters(scope))));
								if (
									captured.protectedScopes.some(
										(scope) =>
											scope.objectId !== inventory.objectId ||
											!current.scopes.some(
												(row) => JSON.stringify(keyParameters(row.scope)) === JSON.stringify(keyParameters(scope))
											)
									)
								)
									throw failure("incomplete", "snapshot protected role is absent from the complete census");
								const retired = current.scopes.filter((row) => !keys.has(JSON.stringify(keyParameters(row.scope))));
								const priorFrontier = readControl(inventory.objectId);
								const frontier = snapshotRetirementContract.turnoverFrontier(
									priorFrontier,
									decision,
									retired.map((row) => ({ scope: row.scope, incarnation: row.incarnation }))
								);
								if (
									current.scopes.some(
										(row) =>
											keys.has(JSON.stringify(keyParameters(row.scope))) &&
											!snapshotRetirementContract.allows(frontier, row.scope, row.incarnation)
									) ||
									retired.some((row) => snapshotRetirementContract.protected(frontier, row.scope, row.incarnation))
								)
									throw failure(
										"stale-scope",
										"snapshot role reconciliation contradicts the native protected frontier"
									);
								if (frontier !== priorFrontier)
									beforeFrontierImage = { control: priorFrontier, image: nativeImage(inventory.objectId) };
								const recoveryScopes = current.owner.recoveryScopes - retired.length;
								let recoveryContentBytes =
									current.owner.recoveryContentBytes - retired.reduce((sum, row) => sum + row.contentBytes, 0);
								if (recoveryScopes < 0 || recoveryContentBytes < 0)
									throw failure("poisoned", "snapshot role accounting would underflow");
								if (decision !== undefined) {
									const survivor = current.scopes.find(
										(row) =>
											JSON.stringify(keyParameters(row.scope)) === JSON.stringify(keyParameters(decision.survivorScope))
									);
									if (
										survivor === undefined ||
										!keys.has(JSON.stringify(keyParameters(survivor.scope))) ||
										retired.length === 0
									)
										throw failure(
											"invalid-carrier",
											"snapshot retirement survivor or classified scopes are unavailable"
										);
									const metadata = readRecoveryMetadata(survivor.scope);
									if (metadata === undefined) throw failure("incomplete", "snapshot retirement survivor vanished");
									const update = snapshotQuarantineContract.recoveryRetirementCarrier(
										decision,
										{ scope: survivor.scope, incarnation: survivor.incarnation },
										retired.map((row) => ({ scope: row.scope, incarnation: row.incarnation })),
										metadata.carrier
									);
									recoveryContentBytes += update.contentByteDelta;
									if (
										!Number.isSafeInteger(recoveryContentBytes) ||
										recoveryContentBytes < 0 ||
										recoveryContentBytes > current.owner.limits.maxRecoveryContentBytes
									)
										throw failure("recovery-full", "snapshot retirement metadata exceeds the recovery budget");
									cachedStatement(
										database,
										"UPDATE snapshot_scopes_v2 SET descriptors=? WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
									).run(JSON.stringify(update.carrier), ...keyParameters(survivor.scope));
								}
								if (frontier !== priorFrontier && frontier !== null)
									cachedStatement(database, "UPDATE snapshot_retirement_controls SET record=? WHERE object_id=?").run(
										snapshotRetirementContract.encodeControl(frontier),
										inventory.objectId
									);
								throwIfAborted(signal);
								authenticatedRoleDeletion = true;
								try {
									for (const row of retired)
										cachedStatement(
											database,
											"DELETE FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
										).run(...keyParameters(row.scope));
								} finally {
									authenticatedRoleDeletion = false;
								}
								cachedStatement(
									database,
									"UPDATE snapshot_owner_v2 SET recovery_scopes=?,recovery_content_bytes=? WHERE id=1"
								).run(recoveryScopes, recoveryContentBytes);
								if (beforeFrontierImage !== undefined)
									afterFrontierImage = {
										control: readControl(inventory.objectId),
										image: nativeImage(inventory.objectId),
									};
								return Object.freeze({
									retiredScopes: Object.freeze(retired.map((row) => row.scope)),
									recoveryScopes,
									recoveryContentBytes,
								});
							});
						let result: ReturnType<typeof perform> | undefined;
						const errors: unknown[] = [];
						try {
							result = perform();
						} catch (error) {
							errors.push(error);
						}
						if (beforeFrontierImage !== undefined) {
							try {
								const actual = runTransaction(
									database,
									() => ({ control: readControl(inventory.objectId), image: nativeImage(inventory.objectId) }),
									"readonly"
								);
								const encoded = JSON.stringify(actual);
								if (
									result !== undefined
										? encoded !== JSON.stringify(afterFrontierImage)
										: encoded !== JSON.stringify(beforeFrontierImage) && encoded !== JSON.stringify(afterFrontierImage)
								)
									throw failure("stale-scope", "snapshot turnover frontier readback disagrees with native outcome");
							} catch (error) {
								errors.push(error);
							}
						}
						if (errors.length === 1) throw errors[0];
						if (errors.length > 1)
							throw new AggregateError(errors, "snapshot turnover and frontier readback failed", { cause: errors[0] });
						if (result === undefined) throw failure("storage-failed", "snapshot turnover native result is unavailable");
						await borrowed?.check();
						return result;
					});
				} catch (cause) {
					failed = true;
					primary = cause;
				}
				const failures: unknown[] = [];
				try {
					await borrowed?.release();
				} catch (cause) {
					failures.push(cause);
				}
				try {
					await acquiredProtection?.release();
				} catch (cause) {
					failures.push(cause);
				}
				if (failures.length) {
					if (failed) failures.unshift(primary);
					throw new AggregateError(failures, "snapshot retirement native cleanup failed", { cause: failures[0] });
				}
				if (failed) throw primary;
				if (result === undefined) throw failure("storage-failed", "snapshot retirement result is unavailable");
				return result;
			})();
		});
	const lookupRecoveryDeclaration: SnapshotRecoveryStore<SnapshotVerificationReceipt>["lookupRecoveryDeclaration"] = (
		input,
		options = {}
	) =>
		promiseCapture(() => {
			const scope = snapshotQuarantineContract.captureScope(input);
			const signal = options.signal;
			throwIfAborted(signal);
			return schedule(() =>
				runTransaction(
					database,
					() => {
						throwIfAborted(signal);
						const metadata = readRecoveryMetadata(scope);
						if (metadata !== undefined) return metadata.observation;
						if (
							cachedStatement(
								database,
								"SELECT 1 AS occupied FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? LIMIT 1"
							).get(scope.objectId, scope.epoch, scope.anchor) !== undefined
						)
							throw failure("conflict", "snapshot identity is occupied by another digest");
						return Object.freeze({ kind: "missing" as const });
					},
					"readonly"
				)
			);
		});
	const lookupReceivedRecoveryCertificate: SnapshotRecoveryStore<SnapshotVerificationReceipt>["lookupReceivedRecoveryCertificate"] =
		(input) =>
			promiseCapture(() => {
				const selector = snapshotQuarantineContract.captureRecoverySelector(input);
				return schedule(() =>
					runTransaction(
						database,
						() => {
							const rows = cachedStatement(
								database,
								"SELECT CASE WHEN typeof(manifest_digest)='text' AND length(CAST(manifest_digest AS BLOB))=64 THEN manifest_digest ELSE NULL END AS manifest_digest FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? LIMIT 2"
							).all(selector.objectId, selector.epoch, selector.anchor);
							if (rows.length > 1) throw failure("conflict", "snapshot recovery identity has ambiguous custody");
							if (rows.length === 0) return null;
							const scope = snapshotQuarantineContract.captureScope({
								...selector,
								manifestDigest: rows[0]?.manifest_digest,
							});
							const metadata = readRecoveryMetadata(scope);
							if (metadata === undefined)
								throw failure("storage-failed", "native certificate row vanished within transaction");
							return metadata.certificate === null
								? null
								: Object.freeze({
										scope,
										incarnation: metadata.incarnation,
										exactReceivedCertificateBytes: metadata.certificate,
									});
						},
						"readonly"
					)
				);
			});
	const occupiedRecoveryScope = (scope: SnapshotQuarantineScopeKey): SnapshotQuarantineScopeKey | undefined => {
		const row = cachedStatement(
			database,
			"SELECT CASE WHEN typeof(manifest_digest)='text' AND length(CAST(manifest_digest AS BLOB))=64 THEN manifest_digest ELSE NULL END AS manifest_digest FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? LIMIT 1"
		).get(scope.objectId, scope.epoch, scope.anchor);
		if (row === undefined) return undefined;
		if (typeof row.manifest_digest !== "string" || !/^[0-9a-f]{64}$/u.test(row.manifest_digest))
			throw failure("poisoned", "snapshot occupied identity is malformed");
		return { ...scope, manifestDigest: row.manifest_digest };
	};
	const acquireRecoveryRead: SnapshotRecoveryStore<SnapshotVerificationReceipt>["acquireRecoveryRead"] = (
		input,
		options = {}
	) =>
		promiseCapture(() => {
			// Private request identity never aliases the returned observation.
			const declaration = captureDeclaration(input);
			snapshotQuarantineContract.validateRecoveryManifest(declaration);
			const signal = options.signal;
			throwIfAborted(signal);
			return schedule(() => {
				if (closed) throw failure("closed", "snapshot quarantine store is closed");
				throwIfAborted(signal);
				const metadata = runTransaction(
					database,
					() => {
						throwIfAborted(signal);
						const found = readRecoveryMetadata(declaration.scope, { declaration });
						if (found === undefined) {
							if (
								cachedStatement(
									database,
									"SELECT 1 AS occupied FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? LIMIT 1"
								).get(declaration.scope.objectId, declaration.scope.epoch, declaration.scope.anchor) !== undefined
							)
								throw failure("conflict", "snapshot identity is occupied by another digest");
							throwIfAborted(signal);
							return undefined;
						}
						throwIfAborted(signal);
						return found;
					},
					"readonly"
				);
				if (metadata === undefined) return Object.freeze({ kind: "missing" as const });
				let released = false;
				let drain = Promise.resolve();
				const ensureReader = (): void => {
					if (released || closed) throw failure("closed", "snapshot recovery reader is closed");
				};
				const reader: SnapshotRecoveryChunkReader = Object.freeze({
					read: (input: SnapshotChunkDescriptor, options: Readonly<{ signal?: AbortSignal }> = {}) =>
						promiseCapture(() => {
							const descriptor = captureDescriptor(input, declaration);
							const readSignal = options.signal;
							ensureReader();
							throwIfAborted(readSignal);
							const selected = schedule(() => {
								ensureReader();
								throwIfAborted(readSignal);
								return runTransaction(
									database,
									() => {
										throwIfAborted(readSignal);
										let current = readRecoveryMetadata(declaration.scope, {
											declaration,
											incarnation: metadata.incarnation,
										});
										if (current === undefined) {
											const occupied = occupiedRecoveryScope(declaration.scope);
											if (occupied !== undefined)
												current = readRecoveryMetadata(occupied, { declaration, incarnation: metadata.incarnation });
										}
										if (current === undefined) {
											throwIfAborted(readSignal);
											return undefined;
										}
										throwIfAborted(readSignal);
										// CASE guards the native BLOB projection, not merely a later JS copy.
										const chunk = cachedStatement(
											database,
											"SELECT CASE WHEN typeof(chunk_digest)='text' AND length(CAST(chunk_digest AS BLOB))=64 THEN chunk_digest ELSE NULL END AS chunk_digest,CASE WHEN typeof(byte_length)='integer' THEN byte_length ELSE NULL END AS byte_length,length(exact_bytes) AS actual_length,CASE WHEN typeof(exact_bytes)='blob' AND length(exact_bytes) BETWEEN 1 AND ? THEN exact_bytes ELSE NULL END AS exact_bytes FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=?"
										).get(descriptor.byteLength, ...keyParameters(declaration.scope), descriptor.index);
										if (chunk === undefined) {
											throwIfAborted(readSignal);
											return undefined;
										}
										if (
											chunk.chunk_digest !== descriptor.digest ||
											chunk.byte_length !== descriptor.byteLength ||
											chunk.actual_length !== descriptor.byteLength ||
											!(chunk.exact_bytes instanceof Uint8Array)
										)
											throw failure("poisoned", "snapshot recovery chunk row is corrupt");
										snapshotQuarantineContract.validateRecoveryChunk(declaration, descriptor, chunk.exact_bytes);
										throwIfAborted(readSignal);
										return new Uint8Array(chunk.exact_bytes);
									},
									"readonly"
								);
							});
							drain = selected.then(
								() => undefined,
								() => undefined
							);
							return selected;
						}),
					release: () => {
						released = true;
						return drain;
					},
				});
				return Object.freeze({
					...metadata.observation,
					state: metadata.observation.state as "open" | "verified",
					reader,
				});
			});
		});
	const recoveryStatus: SnapshotQuarantineStore<SnapshotVerificationReceipt>["recoveryStatus"] = (options = {}) =>
		promiseCapture(() => {
			const signal = options.signal;
			throwIfAborted(signal);
			return schedule(() =>
				runTransaction(
					database,
					() => {
						throwIfAborted(signal);
						return ownerStatus(database);
					},
					"readonly"
				)
			);
		});

	const openScope = (
		declarationInput: SnapshotQuarantineDeclaration,
		optionsInput: Readonly<{ readonly signal?: AbortSignal }> = {}
	): Promise<SnapshotQuarantineScope<SnapshotVerificationReceipt>> => {
		return promiseCapture(() => {
			const declaration = captureDeclaration(declarationInput);
			const signal = optionsInput.signal;
			throwIfAborted(signal);
			return schedule(() => {
				throwIfAborted(signal);

				let incarnation = "";
				try {
					runTransaction(database, () => {
						sweep(Date.now());
						const existing = recorded(declaration);
						if (
							!snapshotRetirementContract.allows(
								readControl(declaration.scope.objectId),
								declaration.scope,
								existing === undefined ? undefined : String(existing.incarnation)
							)
						)
							throw failure("stale-scope", "snapshot scope is retired");
						if (existing === undefined) {
							requireMutable();
							// Native rows are the admission authority across handles and
							// reopen. The original sweep preserves protected past-TTL rows;
							// every remaining temporary status still consumes capacity.
							const usage = cachedStatement(
								database,
								"SELECT count(*) AS scopes,COALESCE(sum(total_bytes),0) AS bytes FROM snapshot_scopes_v2 WHERE retention='temporary'"
							).get();
							snapshotQuarantineContract.assertTemporaryAdmission(
								Number(usage?.scopes) + 1,
								Number(usage?.bytes) + declaration.totalBytes
							);
							// Validate bounded persisted declarations through the existing
							// codec/pre-copy envelope. No chunk payload is materialized.
							const temporary = cachedStatement(
								database,
								"SELECT object_id,epoch,anchor,manifest_digest FROM snapshot_scopes_v2 WHERE retention='temporary' LIMIT ?"
							).all(snapshotQuarantineContract.temporaryLimits.maxTemporaryScopes);
							let reserved = declaration.totalBytes;
							for (const row of temporary) {
								const selected = snapshotQuarantineContract.captureRecoveryDependencyScope({
									objectId: row.object_id,
									epoch: row.epoch,
									anchor: row.anchor,
									manifestDigest: row.manifest_digest,
								});
								const metadata = readRecoveryMetadata(selected);
								if (metadata === undefined) throw failure("poisoned", "temporary snapshot metadata is absent");
								reserved = snapshotQuarantineContract.addRecoveryContentBytes(
									reserved,
									metadata.observation.declaration.totalBytes
								);
							}
							snapshotQuarantineContract.assertTemporaryAdmission(temporary.length + 1, reserved);
							incarnation = randomUUID();
							cachedStatement(
								database,
								"INSERT INTO snapshot_scopes_v2(object_id,epoch,anchor,manifest_digest,exact_manifest_bytes,total_bytes,chunk_count,expires_at,state,retention,incarnation,descriptors) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
							).run(
								...keyParameters(declaration.scope),
								declaration.exactCanonicalManifestBytes,
								declaration.totalBytes,
								declaration.chunks.length,
								Date.now() + SNAPSHOT_QUARANTINE_RETENTION_MS,
								"open",
								"temporary",
								incarnation,
								JSON.stringify(declaration.chunks)
							);
						} else incarnation = String(existing.incarnation);
					});
				} catch (error) {
					if (isError(error)) throw error;
					throw failure("storage-failed", "Node snapshot quarantine open failed", error);
				}

				let released = false;
				let canceled = false;
				const ensureSession = (): void => {
					if (released || terminated) throw failure("closed", "snapshot quarantine scope is closed");
				};
				const descriptorAt = (value: unknown): SnapshotChunkDescriptor => {
					const descriptor = captureDescriptor(value);
					const expected = declaration.chunks[descriptor.index];
					if (
						expected === undefined ||
						expected.byteLength !== descriptor.byteLength ||
						expected.digest !== descriptor.digest
					) {
						throw failure("malformed-input", "snapshot chunk descriptor is foreign to this scope");
					}
					return expected;
				};

				const liveRow = (): NonNullable<ReturnType<typeof recorded>> => {
					const row = recorded(declaration, incarnation);
					if (row === undefined) throw failure("expired", "snapshot quarantine scope is absent");
					return row;
				};
				const queryStatus = (): SnapshotQuarantineStatus => statusOf(declaration, liveRow());
				const verificationQuarantine: SnapshotVerificationQuarantine = Object.freeze({
					open(portSignal: AbortSignal): SnapshotQuarantinePort {
						ensureSession();
						if (closed) throw failure("closed", "snapshot quarantine store is closed");
						let portClosed = false;
						const ensurePort = (): void => {
							ensureSession();
							if (portClosed) throw failure("closed", "snapshot quarantine port is closed");
							throwIfAborted(portSignal);
						};
						const port: SnapshotQuarantinePort = Object.freeze({
							discard: () => {
								if (portClosed) return Promise.resolve();
								portClosed = true;
								return Promise.resolve();
							},
							read: (descriptorInput: SnapshotChunkDescriptor) => {
								return promiseCapture(() => {
									const descriptor = descriptorAt(descriptorInput);
									ensurePort();
									return schedule(() =>
										runTransaction(database, () => {
											ensurePort();
											if (recorded(declaration, incarnation) === undefined) return undefined;
											const row = cachedStatement(
												database,
												"SELECT chunk_digest,byte_length,exact_bytes FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=?"
											).get(...keyParameters(declaration.scope), descriptor.index);
											if (row === undefined) return undefined;
											const bytes = new Uint8Array(row.exact_bytes as Uint8Array);
											if (
												row.chunk_digest !== descriptor.digest ||
												Number(row.byte_length) !== descriptor.byteLength ||
												bytes.byteLength !== descriptor.byteLength
											) {
												throw failure("poisoned", "snapshot quarantine chunk row is corrupt");
											}
											return new Uint8Array(bytes);
										})
									);
								});
							},
							write: (descriptorInput: SnapshotChunkDescriptor, exactBytesInput: Uint8Array) => {
								return promiseCapture(() => {
									const descriptor = descriptorAt(descriptorInput);
									const bytes = exactBytes(exactBytesInput, "snapshot chunk", descriptor.byteLength);
									if (bytes.byteLength !== descriptor.byteLength) {
										throw failure("malformed-input", "snapshot chunk length is invalid");
									}
									ensurePort();
									return schedule(() => {
										ensurePort();
										let conflict = false;
										try {
											runTransaction(database, () => {
												const row = liveRow();
												requireMutable();
												if (row.state === "poisoned" || (row.retention === "recovery" && row.state !== "verified"))
													throw failure("poisoned", "snapshot quarantine is poisoned");
												if (row.state === "verified")
													throw failure("closed", "verified snapshot quarantine is immutable");
												const existing = cachedStatement(
													database,
													"SELECT chunk_digest,byte_length,exact_bytes FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=?"
												).get(...keyParameters(declaration.scope), descriptor.index);
												if (existing !== undefined) {
													const stored = new Uint8Array(existing.exact_bytes as Uint8Array);
													if (
														existing.chunk_digest !== descriptor.digest ||
														Number(existing.byte_length) !== descriptor.byteLength ||
														!sameBytes(stored, bytes)
													) {
														cachedStatement(
															database,
															"UPDATE snapshot_scopes_v2 SET state='poisoned' WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
														).run(...keyParameters(declaration.scope));
														conflict = true;
													}
													return;
												}
												cachedStatement(
													database,
													"INSERT INTO snapshot_chunks_v2(object_id,epoch,anchor,manifest_digest,chunk_index,chunk_digest,byte_length,exact_bytes) VALUES(?,?,?,?,?,?,?,?)"
												).run(
													...keyParameters(declaration.scope),
													descriptor.index,
													descriptor.digest,
													descriptor.byteLength,
													bytes
												);
												cachedStatement(
													database,
													"UPDATE snapshot_scopes_v2 SET expires_at=? WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
												).run(Date.now() + SNAPSHOT_QUARANTINE_RETENTION_MS, ...keyParameters(declaration.scope));
											});
										} catch (error) {
											if (isError(error)) throw error;
											throw failure("storage-failed", "Node snapshot chunk write failed", error);
										}
										if (conflict) throw failure("conflict", "snapshot chunk conflicts with occupied bytes");
									});
								});
							},
						});
						return port;
					},
				});

				const scope: SnapshotQuarantineScope<SnapshotVerificationReceipt> = Object.freeze({
					cancel: (cancelOptions: Readonly<{ readonly signal?: AbortSignal }> = {}) =>
						promiseCapture(() => {
							ensureSession();
							throwIfAborted(cancelOptions.signal);
							if (closed) throw failure("closed", "snapshot quarantine store is closed");
							if (canceled) return Promise.resolve();
							return schedule(() => {
								ensureSession();
								throwIfAborted(cancelOptions.signal);
								try {
									runTransaction(database, () => {
										const row = recorded(declaration, incarnation);
										requireMutable();
										if (row?.retention === "recovery")
											throw failure("recovery-owned", "snapshot recovery ownership prevents cancellation");
										if (
											row !== undefined &&
											snapshotRetirementContract.protected(
												readControl(declaration.scope.objectId),
												declaration.scope,
												String(row.incarnation)
											)
										)
											throw failure("recovery-owned", "snapshot native protected hole prevents cancellation");
										cachedStatement(
											database,
											"DELETE FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
										).run(...keyParameters(declaration.scope));
									});
									canceled = true;
								} catch (error) {
									if (isError(error)) throw error;
									throw failure("storage-failed", "Node snapshot quarantine cancel failed", error);
								}
							});
						}),
					complete: (
						receipt: SnapshotVerificationReceipt,
						completeOptions: Readonly<{ readonly signal?: AbortSignal }> = {}
					) => {
						throwIfAborted(completeOptions.signal);
						return schedule(() => {
							ensureSession();
							throwIfAborted(completeOptions.signal);
							try {
								return runTransaction(database, () => {
									const row = liveRow();
									requireMutable();
									if (row.state === "poisoned" || (row.retention === "recovery" && row.state !== "verified"))
										throw failure("poisoned", "snapshot quarantine is poisoned");
									if (row.state !== "open" && row.state !== "verified")
										throw failure("poisoned", "snapshot quarantine state is invalid");
									const status = statusOf(declaration, row);
									if (status.missingIndices.length !== 0)
										throw failure("incomplete", "snapshot quarantine is incomplete");
									const occupied = Number(
										cachedStatement(
											database,
											"SELECT COUNT(*) AS count FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
										).get(...keyParameters(declaration.scope))?.count
									);
									if (occupied !== declaration.chunks.length)
										throw failure("poisoned", "snapshot quarantine chunk closure is invalid");
									let completion;
									try {
										completion = consumeSnapshotVerificationReceipt({
											expectedScope: declaration.scope,
											quarantine: verificationQuarantine,
											receipt,
										});
									} catch (error) {
										throw failure("receipt-invalid", "snapshot verification receipt is invalid", error);
									}
									if (
										completion.chunkCount !== declaration.chunks.length ||
										completion.exactByteLength !== declaration.totalBytes ||
										completion.manifestDigest !== declaration.scope.manifestDigest
									) {
										throw failure("receipt-invalid", "snapshot verification completion does not match the scope");
									}
									if (status.kind === "open") {
										const transition = cachedStatement(
											database,
											"UPDATE snapshot_scopes_v2 SET state='verified' WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND state='open'"
										).run(...keyParameters(declaration.scope));
										if (Number(transition.changes) !== 1)
											throw failure("poisoned", "snapshot quarantine completion lost its state transition");
									}
									return Object.freeze({
										chunkCount: declaration.chunks.length,
										exactByteLength: declaration.totalBytes,
										scope: declaration.scope,
									}) satisfies VerifiedSnapshotQuarantineReference;
								});
							} catch (error) {
								if (isError(error)) throw error;
								throw failure("storage-failed", "Node snapshot quarantine completion failed", error);
							}
						});
					},
					missingIndices: (missingOptions: Readonly<{ readonly signal?: AbortSignal }> = {}) => {
						throwIfAborted(missingOptions.signal);
						return schedule(() => {
							ensureSession();
							throwIfAborted(missingOptions.signal);
							return runTransaction(database, () => queryStatus().missingIndices);
						});
					},
					release: () => {
						released = true;
						return Promise.resolve();
					},
					retainForRecovery: (options = {}) =>
						promiseCapture(() => {
							const { signal, exactReceivedCertificateBytes } =
								snapshotQuarantineContract.captureRetentionOptions(options);
							ensureSession();
							throwIfAborted(signal);
							return schedule(() => {
								ensureSession();
								throwIfAborted(signal);
								return runTransaction(database, () => {
									const row = liveRow();
									const owner = ownerStatus(database);
									if (owner.migration !== "ready")
										throw failure("migration-required", "snapshot legacy classification is required");
									if (row.state === "poisoned" || (row.retention === "recovery" && row.state !== "verified"))
										throw failure("poisoned", "snapshot quarantine is poisoned");
									if (row.retention === "temporary" && Number(row.expires_at) <= Date.now())
										throw failure("expired", "temporary snapshot quarantine has expired");
									if (row.state !== "verified") throw failure("incomplete", "snapshot quarantine is not verified");
									snapshotQuarantineContract.validateRecoveryManifest(declaration);
									let count = 0;
									const selection =
										"SELECT chunk_index,chunk_digest,byte_length,exact_bytes FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?";
									const first = database.prepare(`${selection} ORDER BY chunk_index LIMIT 1`);
									const next = database.prepare(`${selection} AND chunk_index>? ORDER BY chunk_index LIMIT 1`);
									first.setReadBigInts(true);
									next.setReadBigInts(true);
									// Completed keyset reads keep no native iterator or previous payload alive.
									let chunk = first.get(...keyParameters(declaration.scope));
									while (chunk !== undefined) {
										snapshotQuarantineContract.validateRecoveryChunk(
											declaration,
											{
												index: (typeof chunk.chunk_index === "bigint"
													? Number(chunk.chunk_index)
													: chunk.chunk_index) as number,
												digest: chunk.chunk_digest as string,
												byteLength: (typeof chunk.byte_length === "bigint"
													? Number(chunk.byte_length)
													: chunk.byte_length) as number,
											},
											chunk.exact_bytes as Uint8Array
										);
										count += 1;
										const index = chunk.chunk_index as bigint;
										chunk = undefined;
										chunk = next.get(...keyParameters(declaration.scope), index);
									}
									if (count !== declaration.chunks.length)
										throw failure("incomplete", "snapshot quarantine closure is incomplete");
									const existingCertificate = snapshotQuarantineContract.openReceivedCertificate(
										incarnation,
										row.received_certificate_bytes
									);
									if (row.retention === "recovery") {
										if (
											exactReceivedCertificateBytes !== undefined &&
											(existingCertificate === null || !sameBytes(existingCertificate, exactReceivedCertificateBytes))
										)
											throw failure(
												existingCertificate === null ? "recovery-owned" : "conflict",
												"received recovery certificate cannot be added or replaced"
											);
										return;
									}
									const wrapper =
										exactReceivedCertificateBytes === undefined
											? null
											: snapshotQuarantineContract.wrapReceivedCertificate(incarnation, exactReceivedCertificateBytes);
									const recoveryScopes = snapshotQuarantineContract.addRecoveryContentBytes(owner.recoveryScopes, 1);
									const recoveryContentBytes = snapshotQuarantineContract.addRecoveryContentBytes(
										owner.recoveryContentBytes,
										snapshotQuarantineContract.recoveryContentBytes(
											declaration.totalBytes,
											declaration.exactCanonicalManifestBytes.byteLength,
											wrapper?.byteLength ?? 0
										)
									);
									if (
										recoveryScopes > owner.limits.maxRecoveryScopes ||
										recoveryContentBytes > owner.limits.maxRecoveryContentBytes
									)
										throw failure("recovery-full", "snapshot recovery capacity is full");
									cachedStatement(
										database,
										"UPDATE snapshot_scopes_v2 SET retention='recovery',received_certificate_bytes=? WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
									).run(wrapper, ...keyParameters(declaration.scope));
									cachedStatement(
										database,
										"UPDATE snapshot_owner_v2 SET recovery_scopes=?,recovery_content_bytes=? WHERE id=1"
									).run(recoveryScopes, recoveryContentBytes);
									// Retention at epoch E supersedes every temporary quarantine of the
									// same object below E: no install can retain it again (each retains
									// at or above its current head), so a receive that died after opening
									// it (then a checkpoint past it) would otherwise leave a non-role scope
									// below the head until the TTL. Same collectible predicate as the sweep:
									// protected, retired or in-flight-intent rows stay (fail closed).
									if (readControl(declaration.scope.objectId)?.active == null)
										cachedStatement(
											database,
											"DELETE FROM snapshot_scopes_v2 WHERE object_id=? AND epoch<? AND retention='temporary' AND snapshot_collectible_v4(object_id,epoch,anchor,manifest_digest,incarnation)=1"
										).run(declaration.scope.objectId, declaration.scope.epoch);
								});
							});
						}),
					scope: declaration.scope,
					status: (statusOptions: Readonly<{ readonly signal?: AbortSignal }> = {}) => {
						throwIfAborted(statusOptions.signal);
						return schedule(() => {
							ensureSession();
							throwIfAborted(statusOptions.signal);
							return runTransaction(database, queryStatus);
						});
					},
					verificationQuarantine,
				});
				return scope;
			});
		});
	};

	const sweepExpired = (options: Readonly<{ readonly signal?: AbortSignal }> = {}): Promise<number> => {
		throwIfAborted(options.signal);
		return schedule(() => {
			throwIfAborted(options.signal);
			try {
				return runTransaction(database, () => sweep(Date.now()));
			} catch (error) {
				if (isError(error)) throw error;
				throw failure("storage-failed", "Node snapshot quarantine sweep failed", error);
			}
		});
	};

	const readRetirementAdmissionImage: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["readRetirementAdmissionImage"]
	> = (input) =>
		promiseCapture(() => {
			const objectId = snapshotRetirementContract.captureObject(input);
			return schedule(() => {
				const captured = runTransaction(
					database,
					() =>
						Object.freeze({
							control: readControl(objectId),
							image: nativeImage(objectId),
							...(ownerStatus(database).classificationIntent?.objectId === objectId
								? { classificationSource: nativeImage(objectId, true) }
								: {}),
						}),
					"readonly"
				);
				return captured;
			});
		});
	const readRetirementImage: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["readRetirementImage"]
	> = async (input) => {
		const captured = await readRetirementAdmissionImage(input);
		if (captured.image.scopeCount === 0 && captured.control === null)
			throw failure("incomplete", "snapshot retirement object is not installed");
		return captured;
	};
	const acquireRetirementControl: NonNullable<
		SnapshotRecoveryStore<SnapshotVerificationReceipt>["acquireRetirementControl"]
	> = (input) =>
		promiseCapture(() => {
			const objectId = snapshotRetirementContract.captureObject(input);
			return schedule(() => {
				const captured = runTransaction(
					database,
					() => ({ control: readControl(objectId), image: nativeImage(objectId) }),
					"readonly"
				);
				if (captured.image.scopeCount === 0 && captured.control === null)
					throw failure("incomplete", "snapshot retirement object is not installed");
				let control = captured.control;
				if (control === null) {
					const born: SnapshotRetirementControl = {
						kind: "snapshot-retirement-control-1",
						objectId,
						incarnation: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
						revision: 0,
						sequence: 0,
						active: null,
						completed: null,
					};
					let primary: unknown;
					try {
						runTransaction(database, () => {
							if (readControl(objectId) !== null || nativeImage(objectId).imageDigest !== captured.image.imageDigest)
								throw failure("stale-scope", "snapshot control birth image changed");
							cachedStatement(database, "INSERT INTO snapshot_retirement_controls VALUES(?,?)").run(
								objectId,
								snapshotRetirementContract.encodeControl(born)
							);
						});
					} catch (error) {
						primary = error;
					}
					const after = runTransaction(
						database,
						() => ({ control: readControl(objectId), image: nativeImage(objectId) }),
						"readonly"
					);
					if (
						after.control === null ||
						!sameBytes(
							snapshotRetirementContract.encodeControl(after.control),
							snapshotRetirementContract.encodeControl(born)
						) ||
						after.image.imageDigest !== captured.image.imageDigest
					) {
						if (primary !== undefined) throw primary;
						throw failure("storage-failed", "snapshot control birth outcome is unknown");
					}
					control = after.control;
				}
				const expected = snapshotRetirementContract.encodeControl(control);
				return snapshotRetirementContract.createRead(
					control,
					captured.image,
					(next) =>
						schedule(() => {
							let primary: unknown;
							try {
								runTransaction(database, () => {
									const actual = readControl(objectId);
									if (
										actual === null ||
										!sameBytes(snapshotRetirementContract.encodeControl(actual), expected) ||
										nativeImage(objectId).imageDigest !== captured.image.imageDigest
									)
										throw failure("stale-scope", "snapshot retirement native image changed");
									cachedStatement(database, "UPDATE snapshot_retirement_controls SET record=? WHERE object_id=?").run(
										snapshotRetirementContract.encodeControl(next),
										objectId
									);
								});
							} catch (error) {
								primary = error;
							}
							const after = runTransaction(
								database,
								() => ({ control: readControl(objectId), image: nativeImage(objectId) }),
								"readonly"
							);
							if (
								after.control !== null &&
								sameBytes(
									snapshotRetirementContract.encodeControl(after.control),
									snapshotRetirementContract.encodeControl(next)
								) &&
								after.image.imageDigest === captured.image.imageDigest
							)
								return after.control;
							if (primary !== undefined) throw primary;
							throw failure("storage-failed", "snapshot retirement delivery outcome is unknown");
						}),
					() => Promise.resolve()
				);
			});
		});
	const close = (): Promise<void> => {
		if (closing !== undefined) return closing;
		closed = true;
		for (const guard of dependencyGuards) guard.invalidate();
		closing = tail.then(async () => {
			terminated = true;
			const failures = (await Promise.allSettled([...dependencyGuards].map((guard) => session ? guard.released : guard.join()))).flatMap(
				(result) => (result.status === "rejected" ? [result.reason as unknown] : [])
			);
			try {
				database.close();
			} catch (cause) {
				failures.push(cause);
			}
			if (failures.length)
				throw new AggregateError(failures, "snapshot store joined close failed", { cause: failures[0] });
			session?.closedOwner(store);
		});
		return closing;
	};

	const store = Object.freeze({
		close,
		readRetirementImage,
		readRetirementAdmissionImage,
		acquireRetirementControl,
		captureRecoveryRoleInventory,
		reconcileRecoveryRoles,
		inspectRecovery,
		lookupRecoveryDeclaration,
		lookupReceivedRecoveryCertificate,
		acquireRecoveryRead,
		acquireRecoveryDependencyProtection,
		acquireRecoveryRetirementExclusion,
		recoveryStatus,
		openScope,
		sweepExpired,
	});
	return store;
}
