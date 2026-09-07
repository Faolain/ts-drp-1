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
	type SnapshotRecoveryInspection,
	type SnapshotRecoveryLimits,
	type SnapshotRecoveryOwnerStatus,
	type SnapshotVerificationQuarantine,
	type SnapshotVerificationReceipt,
	type VerifiedSnapshotQuarantineReference,
} from "@ts-drp/storage/snapshot-transfer";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

export interface NodeSnapshotQuarantineStoreOptions {
	readonly primaryFilename: string;
	readonly recoveryLimits?: SnapshotRecoveryLimits;
}

const {
	captureDeclaration,
	captureDescriptor,
	captureExactBytes: exactBytes,
	createError: failure,
	isError,
} = snapshotQuarantineContract;
type CapturedDeclaration = SnapshotQuarantineDeclaration;

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
} {
	if (!exactRecord(value, ["primaryFilename"]) && !exactRecord(value, ["primaryFilename", "recoveryLimits"])) {
		throw failure("malformed-input", "node snapshot quarantine options are malformed");
	}
	const primaryFilename = value.primaryFilename;
	if (typeof primaryFilename !== "string" || primaryFilename === "") {
		throw failure("malformed-input", "node snapshot quarantine options are malformed");
	}
	return {
		primaryFilename,
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

function runTransaction<Result>(database: DatabaseSync, operation: () => Result): Result {
	database.exec("BEGIN IMMEDIATE");
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
	const rows = database.prepare(`PRAGMA table_xinfo(${name})`).all();
	const integer = new Set([
		"epoch",
		"total_bytes",
		"chunk_count",
		"expires_at",
		"chunk_index",
		"byte_length",
		...ownerColumns,
	]);
	const layout = database.prepare("SELECT wr,strict FROM pragma_table_list WHERE name=?").get(name);
	const indexes = database.prepare(`PRAGMA index_list(${name})`).all();
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
				Number(row.notnull) !== (row.name === "descriptors" ? 0 : 1) ||
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
		String(database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.sql)
	);
}
function assertSchemaSql(database: DatabaseSync, table: string, expected: readonly string[]): void {
	const actual = schemaSql(database, table);
	if (!expected.some((sql) => normalizeSchemaSql(sql) === actual))
		throw failure("unsupported-schema", "Node snapshot quarantine constraints are unsupported");
}
function validateSchema(database: DatabaseSync, version: number): void {
	const suffix = version === 1 ? "" : "_v2";
	const names = database
		.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
		.all()
		.map((row) => row.name);
	const expected =
		version === 1
			? ["snapshot_chunks", "snapshot_scopes"]
			: ["snapshot_chunks_v2", "snapshot_owner_v2", "snapshot_scopes_v2"];
	if (
		JSON.stringify(names) !== JSON.stringify(expected) ||
		database.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger','view')").all().length !== 0
	)
		throw failure("unsupported-schema", "Node snapshot quarantine schema is unsupported");

	const scopeBase = `CREATE TABLE snapshot_scopes${suffix}(object_id TEXT NOT NULL,epoch INTEGER NOT NULL,anchor TEXT NOT NULL,manifest_digest TEXT NOT NULL,exact_manifest_bytes BLOB NOT NULL,total_bytes INTEGER NOT NULL,chunk_count INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL`;
	const scopeEnd = ",PRIMARY KEY(object_id,epoch,anchor,manifest_digest)) WITHOUT ROWID";
	assertSchemaSql(
		database,
		"snapshot_scopes" + suffix,
		version === 1
			? [scopeBase + scopeEnd]
			: [
					scopeBase + ",retention TEXT NOT NULL,incarnation TEXT NOT NULL,descriptors TEXT" + scopeEnd,
					scopeBase +
						",retention TEXT NOT NULL DEFAULT 'legacy-unclassified',incarnation TEXT NOT NULL DEFAULT '',descriptors TEXT" +
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
		version === 1 ? scopeColumns : [...scopeColumns, "retention", "incarnation", "descriptors"],
		4
	);
	validateTable(database, "snapshot_chunks" + suffix, chunkColumns, 5);
	const fk = database.prepare(`PRAGMA foreign_key_list(snapshot_chunks${suffix})`).all();
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
		database.prepare(`PRAGMA foreign_key_list(snapshot_scopes${suffix})`).all().length !== 0
	)
		throw failure("unsupported-schema", "Node snapshot quarantine foreign key schema is unsupported");
	if (version === 2) {
		validateTable(database, "snapshot_owner_v2", ownerColumns, 1);
		assertSchemaSql(database, "snapshot_owner_v2", [
			`CREATE TABLE snapshot_owner_v2(
 id INTEGER NOT NULL PRIMARY KEY,max_recovery_scopes INTEGER NOT NULL,max_recovery_content_bytes INTEGER NOT NULL,
 recovery_scopes INTEGER NOT NULL,recovery_content_bytes INTEGER NOT NULL,
 legacy_unclassified_scopes INTEGER NOT NULL,legacy_unclassified_content_bytes INTEGER NOT NULL) WITHOUT ROWID`,
		]);
	}
	if (database.prepare("PRAGMA foreign_key_check").get() !== undefined)
		throw failure("unsupported-schema", "snapshot quarantine foreign key data is unsupported");
}
function ownerStatus(database: DatabaseSync): SnapshotRecoveryOwnerStatus {
	const count = database.prepare("SELECT COUNT(*) AS count FROM snapshot_owner_v2").get()?.count;
	const row = database.prepare("SELECT * FROM snapshot_owner_v2 WHERE id=1").get();
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
	return Object.freeze({
		limits,
		recoveryScopes,
		recoveryContentBytes,
		legacyUnclassifiedScopes,
		legacyUnclassifiedContentBytes,
		migration: legacyUnclassifiedScopes === 0 ? "ready" : "classification-required",
	});
}
function admitSchema(database: DatabaseSync, supplied: SnapshotRecoveryLimits | undefined): void {
	runTransaction(database, () => {
		const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
		const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
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
		} else if (version !== 2) {
			throw failure("unsupported-schema", "Node snapshot quarantine schema is unsupported");
		}
		if (version !== 2) {
			let count = 0,
				content = 0;
			const selection =
				"SELECT object_id,epoch,anchor,manifest_digest,total_bytes,length(exact_manifest_bytes) AS manifest_length FROM snapshot_scopes_v2";
			const first = database.prepare(`${selection} ORDER BY object_id,epoch,anchor,manifest_digest LIMIT 1`);
			const next = database.prepare(
				`${selection} WHERE (object_id,epoch,anchor,manifest_digest) > (?,?,?,?) ORDER BY object_id,epoch,anchor,manifest_digest LIMIT 1`
			);
			const update = database.prepare(
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
			database
				.prepare("INSERT INTO snapshot_owner_v2 VALUES(1,?,?,0,0,?,?)")
				.run(limits.maxRecoveryScopes, limits.maxRecoveryContentBytes, count, content);
			database.exec("PRAGMA user_version=2");
		}
		validateSchema(database, 2);
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
	options: NodeSnapshotQuarantineStoreOptions
): SnapshotQuarantineStore<SnapshotVerificationReceipt> {
	const { primaryFilename, recoveryLimits } = captureOptions(options);
	let acquired: DatabaseSync | undefined;
	try {
		const database = new DatabaseSync(`${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`);
		acquired = database;
		database.exec(
			"PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;"
		);
		admitSchema(database, recoveryLimits);
	} catch (error) {
		acquired?.close();
		if (isError(error)) throw error;
		throw failure("storage-failed", "Node snapshot quarantine admission failed", error);
	}
	const database = acquired;
	let closed = false;
	let terminated = false;
	let closing: Promise<void> | undefined;
	let tail = Promise.resolve();
	const schedule = <Result>(operation: () => Result | Promise<Result>): Promise<Result> => {
		if (closed) return Promise.reject(failure("closed", "snapshot quarantine store is closed"));
		const selected = tail
			.then(() => {
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
		return selected;
	};

	const requireMutable = (): void => {
		if (ownerStatus(database).migration !== "ready")
			throw failure("migration-required", "snapshot legacy classification is required");
	};
	const sweep = (now: number): number => {
		if (ownerStatus(database).migration !== "ready") return 0;
		return Number(
			database.prepare("DELETE FROM snapshot_scopes_v2 WHERE expires_at <= ? AND retention='temporary'").run(now)
				.changes
		);
	};
	const recorded = (
		declaration: CapturedDeclaration,
		incarnation?: string
	): Record<string, SQLOutputValue> | undefined => {
		const selector = database
			.prepare("SELECT * FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? LIMIT 1")
			.get(declaration.scope.objectId, declaration.scope.epoch, declaration.scope.anchor);
		if (selector === undefined) return undefined;
		if (
			typeof selector.incarnation !== "string" ||
			selector.incarnation.length === 0 ||
			!["open", "verified", "poisoned"].includes(String(selector.state)) ||
			!["temporary", "recovery", "legacy-unclassified"].includes(String(selector.retention)) ||
			(selector.retention === "legacy-unclassified") !== (selector.descriptors === null) ||
			(selector.descriptors !== null && typeof selector.descriptors !== "string")
		)
			throw failure("poisoned", "snapshot quarantine scope row is malformed");
		if (incarnation !== undefined && selector.incarnation !== incarnation)
			throw failure("stale-scope", "snapshot quarantine handle belongs to an earlier incarnation");
		if (
			selector.manifest_digest !== declaration.scope.manifestDigest ||
			!sameBytes(
				new Uint8Array(selector.exact_manifest_bytes as Uint8Array),
				declaration.exactCanonicalManifestBytes
			) ||
			Number(selector.total_bytes) !== declaration.totalBytes ||
			Number(selector.chunk_count) !== declaration.chunks.length ||
			(selector.descriptors !== null && selector.descriptors !== JSON.stringify(declaration.chunks))
		)
			throw failure("conflict", "snapshot quarantine declaration conflicts with durable state");
		if (selector.descriptors === null) {
			for (const row of database
				.prepare(
					"SELECT chunk_index,chunk_digest,byte_length FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
				)
				.iterate(...keyParameters(declaration.scope))) {
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
			database
				.prepare(
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
	const recoveryStatus: SnapshotQuarantineStore<SnapshotVerificationReceipt>["recoveryStatus"] = (options = {}) =>
		promiseCapture(() => {
			const signal = options.signal;
			throwIfAborted(signal);
			return schedule(() =>
				runTransaction(database, () => {
					throwIfAborted(signal);
					return ownerStatus(database);
				})
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
						if (existing === undefined) {
							requireMutable();
							incarnation = randomUUID();
							database
								.prepare(
									"INSERT INTO snapshot_scopes_v2(object_id,epoch,anchor,manifest_digest,exact_manifest_bytes,total_bytes,chunk_count,expires_at,state,retention,incarnation,descriptors) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
								)
								.run(
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
											const row = database
												.prepare(
													"SELECT chunk_digest,byte_length,exact_bytes FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=?"
												)
												.get(...keyParameters(declaration.scope), descriptor.index);
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
												const existing = database
													.prepare(
														"SELECT chunk_digest,byte_length,exact_bytes FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=?"
													)
													.get(...keyParameters(declaration.scope), descriptor.index);
												if (existing !== undefined) {
													const stored = new Uint8Array(existing.exact_bytes as Uint8Array);
													if (
														existing.chunk_digest !== descriptor.digest ||
														Number(existing.byte_length) !== descriptor.byteLength ||
														!sameBytes(stored, bytes)
													) {
														database
															.prepare(
																"UPDATE snapshot_scopes_v2 SET state='poisoned' WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
															)
															.run(...keyParameters(declaration.scope));
														conflict = true;
													}
													return;
												}
												database
													.prepare(
														"INSERT INTO snapshot_chunks_v2(object_id,epoch,anchor,manifest_digest,chunk_index,chunk_digest,byte_length,exact_bytes) VALUES(?,?,?,?,?,?,?,?)"
													)
													.run(
														...keyParameters(declaration.scope),
														descriptor.index,
														descriptor.digest,
														descriptor.byteLength,
														bytes
													);
												database
													.prepare(
														"UPDATE snapshot_scopes_v2 SET expires_at=? WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
													)
													.run(Date.now() + SNAPSHOT_QUARANTINE_RETENTION_MS, ...keyParameters(declaration.scope));
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
										database
											.prepare(
												"DELETE FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
											)
											.run(...keyParameters(declaration.scope));
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
										database
											.prepare(
												"SELECT COUNT(*) AS count FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
											)
											.get(...keyParameters(declaration.scope))?.count
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
										const transition = database
											.prepare(
												"UPDATE snapshot_scopes_v2 SET state='verified' WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND state='open'"
											)
											.run(...keyParameters(declaration.scope));
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
					retainForRecovery: (options: Readonly<{ readonly signal?: AbortSignal }> = {}) =>
						promiseCapture(() => {
							const signal = options.signal;
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
									if (row.retention === "recovery") return;
									const recoveryScopes = snapshotQuarantineContract.addRecoveryContentBytes(owner.recoveryScopes, 1);
									const recoveryContentBytes = snapshotQuarantineContract.addRecoveryContentBytes(
										owner.recoveryContentBytes,
										snapshotQuarantineContract.recoveryContentBytes(
											declaration.totalBytes,
											declaration.exactCanonicalManifestBytes.byteLength
										)
									);
									if (
										recoveryScopes > owner.limits.maxRecoveryScopes ||
										recoveryContentBytes > owner.limits.maxRecoveryContentBytes
									)
										throw failure("recovery-full", "snapshot recovery capacity is full");
									database
										.prepare(
											"UPDATE snapshot_scopes_v2 SET retention='recovery' WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
										)
										.run(...keyParameters(declaration.scope));
									database
										.prepare("UPDATE snapshot_owner_v2 SET recovery_scopes=?,recovery_content_bytes=? WHERE id=1")
										.run(recoveryScopes, recoveryContentBytes);
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

	const close = (): Promise<void> => {
		if (closing !== undefined) return closing;
		closed = true;
		closing = tail.then(() => {
			terminated = true;
			database.close();
		});
		return closing;
	};

	return Object.freeze({ close, inspectRecovery, recoveryStatus, openScope, sweepExpired });
}
