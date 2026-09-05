import {
	type AppendAcceptedVertexInput,
	type AppendAcceptedVertexResult,
	captureLiveJournalInput,
	classifyLiveJournalMutationObservation,
	decideLiveJournalDuplicate,
	deriveLiveJournalSnapshot,
	type DurableLiveJournalStore,
	type InstallLiveJournalGenesisInput,
	type InstallLiveJournalGenesisResult,
	type LiveJournalAcceptedRow,
	type LiveJournalFailureKind,
	type LiveJournalPageInput,
	type LiveJournalPageResult,
	type LiveJournalReadinessInput,
	type LiveJournalReadinessResult,
	type LiveJournalScope,
	type LiveJournalSnapshotToken,
} from "@ts-drp/live-journal";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface NodeDurableLiveJournalStoreOptions {
	readonly primaryFilename: string;
}

type StoredScope = Readonly<{
	readonly scope: LiveJournalScope;
	readonly nextJournalSequence: number;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly detachedAnchorSignature: Uint8Array;
	readonly parametersDigest: string;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
}>;
type StoredRow = LiveJournalAcceptedRow;
type PendingRow =
	| Omit<Extract<StoredRow, { readonly sourceKind: "received" }>, "journalSequence">
	| Omit<Extract<StoredRow, { readonly sourceKind: "local-issued" }>, "journalSequence">;
type DurableSnapshot = Readonly<{ readonly scope: StoredScope; readonly rows: readonly StoredRow[] }>;
type AddressedSnapshot = Readonly<{
	readonly kind: "append-addressed";
	readonly row: StoredRow | null;
	readonly scope: StoredScope;
}>;
type VerifiedScopeWatermark = Readonly<{
	readonly dataVersion: number;
	readonly nextJournalSequence: number;
	readonly scope: LiveJournalScope;
}>;
type VersionedSnapshot = Readonly<{ readonly dataVersion: number; readonly snapshot: DurableSnapshot | null }>;
type VersionedAddressedSnapshot = Readonly<{ readonly dataVersion: number; readonly snapshot: AddressedSnapshot }>;
const UNSTABLE_VERSION = Symbol("unstable-data-version");

const SCOPES_DDL =
	"CREATE TABLE scopes (\n  object_id TEXT NOT NULL,\n  epoch INTEGER NOT NULL,\n  anchor_digest TEXT NOT NULL,\n  next_journal_sequence INTEGER NOT NULL,\n  exact_anchor_preimage BLOB NOT NULL,\n  detached_anchor_signature BLOB NOT NULL,\n  parameters_digest TEXT NOT NULL,\n  exact_parameters_carrier BLOB NOT NULL,\n  PRIMARY KEY (object_id, epoch, anchor_digest)\n) WITHOUT ROWID";
const ENTRIES_DDL =
	"CREATE TABLE accepted_entries (\n  object_id TEXT NOT NULL,\n  epoch INTEGER NOT NULL,\n  anchor_digest TEXT NOT NULL,\n  journal_sequence INTEGER NOT NULL,\n  source_kind TEXT NOT NULL,\n  vertex_digest TEXT NOT NULL,\n  received_preimage BLOB,\n  received_signature BLOB,\n  local_author TEXT,\n  local_author_sequence INTEGER,\n  PRIMARY KEY (object_id, epoch, anchor_digest, journal_sequence),\n  UNIQUE (object_id, epoch, anchor_digest, vertex_digest),\n  UNIQUE (object_id, epoch, anchor_digest, local_author, local_author_sequence),\n  CHECK (source_kind IN ('received', 'local-issued')),\n  CHECK (\n    (source_kind = 'received' AND received_preimage IS NOT NULL AND received_signature IS NOT NULL AND local_author IS NULL AND local_author_sequence IS NULL)\n    OR\n    (source_kind = 'local-issued' AND received_preimage IS NULL AND received_signature IS NULL AND local_author IS NOT NULL AND local_author_sequence IS NOT NULL)\n  )\n) WITHOUT ROWID";
const EXPECTED_CATALOG = [
	{
		name: "sqlite_autoindex_accepted_entries_2",
		sql: null,
		tbl_name: "accepted_entries",
		type: "index",
	},
	{
		name: "sqlite_autoindex_accepted_entries_3",
		sql: null,
		tbl_name: "accepted_entries",
		type: "index",
	},
	{ name: "accepted_entries", sql: ENTRIES_DDL, tbl_name: "accepted_entries", type: "table" },
	{ name: "scopes", sql: SCOPES_DDL, tbl_name: "scopes", type: "table" },
] as const;

function captureOptions(value: unknown): string {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("malformed-input");
		const prototype = Object.getPrototypeOf(value);
		const keys = Reflect.ownKeys(value);
		const descriptor = Object.getOwnPropertyDescriptor(value, "primaryFilename");
		if (
			(prototype !== Object.prototype && prototype !== null) ||
			keys.length !== 1 ||
			keys[0] !== "primaryFilename" ||
			descriptor === undefined ||
			!("value" in descriptor) ||
			!descriptor.enumerable ||
			typeof descriptor.value !== "string" ||
			descriptor.value.length === 0 ||
			descriptor.value.includes("\0")
		) {
			throw new TypeError("malformed-input");
		}
		return descriptor.value;
	} catch (error) {
		if (error instanceof TypeError && error.message === "malformed-input") throw error;
		throw new TypeError("malformed-input");
	}
}

function statement(database: DatabaseSync, sql: string): StatementSync {
	const result = database.prepare(sql);
	result.setReadBigInts(false);
	return result;
}

function scalar(database: DatabaseSync, sql: string): unknown {
	const row = statement(database, sql).get();
	return row === undefined ? undefined : Object.values(row)[0];
}

function dataVersion(database: DatabaseSync): number {
	const value = scalar(database, "PRAGMA main.data_version");
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("invalid-data-version");
	return value as number;
}

function admit(database: DatabaseSync): void {
	database.exec("PRAGMA busy_timeout=1000");
	database.exec("PRAGMA synchronous=FULL");
	const initial = statement(database, "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
	const fresh = initial.length === 0 && scalar(database, "PRAGMA user_version") === 0;
	if (fresh) {
		database.exec("PRAGMA page_size=4096");
		if (String(scalar(database, "PRAGMA journal_mode=WAL")).toLowerCase() !== "wal") {
			throw new Error("durability-unavailable");
		}
		database.exec("BEGIN IMMEDIATE");
		try {
			database.exec(SCOPES_DDL);
			database.exec(ENTRIES_DDL);
			database.exec("PRAGMA user_version=1");
			database.exec("COMMIT");
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// The original schema creation error owns the failure identity.
			}
			throw error;
		}
	}
	const catalog = statement(database, "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
	if (
		catalog.length !== EXPECTED_CATALOG.length ||
		catalog.some((row, index) => {
			const expected = EXPECTED_CATALOG[index];
			return (
				expected === undefined ||
				row.type !== expected.type ||
				row.name !== expected.name ||
				row.tbl_name !== expected.tbl_name ||
				row.sql !== expected.sql
			);
		}) ||
		scalar(database, "PRAGMA user_version") !== 1 ||
		scalar(database, "PRAGMA page_size") !== 4096 ||
		String(scalar(database, "PRAGMA journal_mode")).toLowerCase() !== "wal" ||
		scalar(database, "PRAGMA synchronous") !== 2 ||
		scalar(database, "PRAGMA busy_timeout") !== 1000
	) {
		throw new Error("unsupported-schema");
	}
}

function scopeParameters(scope: LiveJournalScope): readonly [string, number, string] {
	return [scope.objectId, scope.epoch, scope.anchorDigest];
}

function copyBlob(value: unknown): Uint8Array {
	return new Uint8Array(value as Uint8Array);
}

function sqlText(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function sqlBlob(value: Uint8Array): string {
	return `X'${Buffer.from(value).toString("hex")}'`;
}

function readScope(database: DatabaseSync, scope: LiveJournalScope): StoredScope | null {
	const row = statement(
		database,
		"SELECT object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?"
	).get(...scopeParameters(scope));
	if (row === undefined) return null;
	return {
		detachedAnchorSignature: copyBlob(row.detached_anchor_signature),
		exactCanonicalAnchorPreimageBytes: copyBlob(row.exact_anchor_preimage),
		exactCanonicalParametersCarrierBytes: copyBlob(row.exact_parameters_carrier),
		nextJournalSequence: row.next_journal_sequence as number,
		parametersDigest: row.parameters_digest as string,
		scope: { anchorDigest: row.anchor_digest as string, epoch: row.epoch as number, objectId: row.object_id as string },
	};
}

function readScopeWriter(database: DatabaseSync, scope: LiveJournalScope): StoredScope | null {
	const row = statement(
		database,
		"SELECT object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?"
	).get(...scopeParameters(scope));
	if (row === undefined) return null;
	return {
		detachedAnchorSignature: copyBlob(row.detached_anchor_signature),
		exactCanonicalAnchorPreimageBytes: copyBlob(row.exact_anchor_preimage),
		exactCanonicalParametersCarrierBytes: copyBlob(row.exact_parameters_carrier),
		nextJournalSequence: row.next_journal_sequence as number,
		parametersDigest: row.parameters_digest as string,
		scope: { anchorDigest: row.anchor_digest as string, epoch: row.epoch as number, objectId: row.object_id as string },
	};
}

function rowFromSql(row: Readonly<Record<string, unknown>>): StoredRow {
	const scope = {
		anchorDigest: row.anchor_digest as string,
		epoch: row.epoch as number,
		objectId: row.object_id as string,
	};
	return row.source_kind === "received"
		? {
				detachedSignature: copyBlob(row.received_signature),
				exactCanonicalPreimageBytes: copyBlob(row.received_preimage),
				journalSequence: row.journal_sequence as number,
				scope,
				sourceKind: "received",
				vertexDigest: row.vertex_digest as string,
			}
		: {
				author: row.local_author as string,
				authorSequence: row.local_author_sequence as number,
				journalSequence: row.journal_sequence as number,
				scope,
				sourceKind: row.source_kind as "local-issued",
				vertexDigest: row.vertex_digest as string,
			};
}

function readRows(database: DatabaseSync, scope: LiveJournalScope): readonly StoredRow[] {
	return statement(
		database,
		"SELECT object_id,epoch,anchor_digest,journal_sequence,source_kind,vertex_digest,received_preimage,received_signature,local_author,local_author_sequence FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=? ORDER BY journal_sequence"
	)
		.all(...scopeParameters(scope))
		.map(rowFromSql);
}

const ROW_COLUMNS =
	"object_id,epoch,anchor_digest,journal_sequence,source_kind,vertex_digest,received_preimage,received_signature,local_author,local_author_sequence";

function readRowBySequence(database: DatabaseSync, scope: LiveJournalScope, journalSequence: number): StoredRow | null {
	const row = statement(
		database,
		`SELECT ${ROW_COLUMNS} FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=? AND journal_sequence=?`
	).get(...scopeParameters(scope), journalSequence);
	return row === undefined ? null : rowFromSql(row);
}

function readRowByDigest(database: DatabaseSync, scope: LiveJournalScope, vertexDigest: string): StoredRow | undefined {
	const row = statement(
		database,
		`SELECT ${ROW_COLUMNS} FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=? AND vertex_digest=?`
	).get(...scopeParameters(scope), vertexDigest);
	return row === undefined ? undefined : rowFromSql(row);
}

function readRowByLocalReference(
	database: DatabaseSync,
	scope: LiveJournalScope,
	author: string,
	authorSequence: number
): StoredRow | undefined {
	const row = statement(
		database,
		`SELECT ${ROW_COLUMNS} FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=? AND local_author=? AND local_author_sequence=?`
	).get(...scopeParameters(scope), author, authorSequence);
	return row === undefined ? undefined : rowFromSql(row);
}

function readSnapshot(database: DatabaseSync, scope: LiveJournalScope): DurableSnapshot | null {
	const selectedScope = readScope(database, scope);
	const rows = readRows(database, scope);
	return selectedScope === null ? null : { rows, scope: selectedScope };
}

function readVersionedSnapshotReadonly(
	database: DatabaseSync,
	scope: LiveJournalScope
): VersionedSnapshot | typeof UNSTABLE_VERSION {
	const before = dataVersion(database);
	database.exec("BEGIN");
	try {
		const inside = dataVersion(database);
		const snapshot = readSnapshot(database, scope);
		database.exec("COMMIT");
		const after = dataVersion(database);
		return before === inside && inside === after ? { dataVersion: after, snapshot } : UNSTABLE_VERSION;
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// Preserve the read failure.
		}
		throw error;
	}
}

function readVersionedAddressedSnapshotReadonly(
	database: DatabaseSync,
	scope: LiveJournalScope,
	journalSequence: number
): VersionedAddressedSnapshot | typeof UNSTABLE_VERSION {
	const before = dataVersion(database);
	database.exec("BEGIN");
	try {
		const inside = dataVersion(database);
		const storedScope = readScope(database, scope);
		const row = readRowBySequence(database, scope, journalSequence);
		if (storedScope === null) throw new Error("missing-addressed-scope");
		database.exec("COMMIT");
		const after = dataVersion(database);
		return before === inside && inside === after
			? { dataVersion: after, snapshot: { kind: "append-addressed", row, scope: storedScope } }
			: UNSTABLE_VERSION;
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// Preserve the read failure.
		}
		throw error;
	}
}

const WRONG_SCOPE_SNAPSHOT = Symbol("wrong-scope-snapshot");

function readReplaySnapshotReadonly(
	database: DatabaseSync,
	scope: LiveJournalScope
): DurableSnapshot | null | typeof WRONG_SCOPE_SNAPSHOT {
	database.exec("BEGIN");
	try {
		const row = statement(
			database,
			"SELECT object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier FROM scopes WHERE object_id=? AND epoch=? ORDER BY (anchor_digest=?) DESC LIMIT 1"
		).get(scope.objectId, scope.epoch, scope.anchorDigest);
		const rows = readRows(database, scope);
		database.exec("COMMIT");
		if (row === undefined) return null;
		if (row.anchor_digest !== scope.anchorDigest) return WRONG_SCOPE_SNAPSHOT;
		return {
			rows,
			scope: {
				detachedAnchorSignature: copyBlob(row.detached_anchor_signature),
				exactCanonicalAnchorPreimageBytes: copyBlob(row.exact_anchor_preimage),
				exactCanonicalParametersCarrierBytes: copyBlob(row.exact_parameters_carrier),
				nextJournalSequence: row.next_journal_sequence as number,
				parametersDigest: row.parameters_digest as string,
				scope: {
					anchorDigest: row.anchor_digest as string,
					epoch: row.epoch as number,
					objectId: row.object_id as string,
				},
			},
		};
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// Preserve the read failure.
		}
		throw error;
	}
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function sameInstalledScope(left: StoredScope, right: StoredScope): boolean {
	return (
		left.scope.objectId === right.scope.objectId &&
		left.scope.epoch === right.scope.epoch &&
		left.scope.anchorDigest === right.scope.anchorDigest &&
		left.parametersDigest === right.parametersDigest &&
		sameBytes(left.exactCanonicalAnchorPreimageBytes, right.exactCanonicalAnchorPreimageBytes) &&
		sameBytes(left.detachedAnchorSignature, right.detachedAnchorSignature) &&
		sameBytes(left.exactCanonicalParametersCarrierBytes, right.exactCanonicalParametersCarrierBytes)
	);
}

function existingProbe(row: StoredRow | undefined): Readonly<Record<string, unknown>> | null {
	return row === undefined
		? null
		: row.sourceKind === "received"
			? {
					detachedSignature: row.detachedSignature,
					exactCanonicalPreimageBytes: row.exactCanonicalPreimageBytes,
					journalSequence: row.journalSequence,
					sourceKind: row.sourceKind,
					vertexDigest: row.vertexDigest,
				}
			: {
					author: row.author,
					authorSequence: row.authorSequence,
					journalSequence: row.journalSequence,
					sourceKind: row.sourceKind,
					vertexDigest: row.vertexDigest,
				};
}

function failed(kind: LiveJournalFailureKind): Readonly<{ readonly kind: LiveJournalFailureKind; readonly ok: false }> {
	return Object.freeze({ kind, ok: false });
}

function captureAddressedClosure(snapshot: DurableSnapshot): DurableSnapshot | undefined {
	try {
		const captured = deriveLiveJournalSnapshot({ durable: snapshot } as never);
		if (captured.ok !== true) return undefined;
		return { rows: captured.rows, scope: snapshot.scope };
	} catch {
		return undefined;
	}
}

/**
 * Creates the strict Node live-journal capability.
 * @param options - Exact primary SQLite filename options.
 * @returns A strict six-method live-journal capability.
 */
export function createNodeDurableLiveJournalStore(
	options: NodeDurableLiveJournalStoreOptions
): DurableLiveJournalStore {
	const filename = captureOptions(options);
	const database = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`, {
		allowExtension: false,
		enableDoubleQuotedStringLiterals: false,
		enableForeignKeyConstraints: false,
		readOnly: false,
	});
	try {
		admit(database);
	} catch (error) {
		database.close();
		throw error;
	}
	let closed = false;
	let poisoned = false;
	let closePromise: Promise<void> | undefined;
	const verifiedScopes = new Map<string, VerifiedScopeWatermark>();
	const watermarkKey = (scope: LiveJournalScope): string =>
		JSON.stringify([scope.objectId, scope.epoch, scope.anchorDigest]);
	const invalidateWatermark = (scope: LiveJournalScope): void => {
		verifiedScopes.delete(watermarkKey(scope));
	};
	const establishWatermark = (scope: StoredScope, version: number): void => {
		verifiedScopes.set(watermarkKey(scope.scope), {
			dataVersion: version,
			nextJournalSequence: scope.nextJournalSequence,
			scope: Object.freeze({ ...scope.scope }),
		});
	};
	const matchesWatermark = (scope: StoredScope, version: number): boolean => {
		const watermark = verifiedScopes.get(watermarkKey(scope.scope));
		return (
			watermark !== undefined &&
			watermark.dataVersion === version &&
			watermark.nextJournalSequence === scope.nextJournalSequence &&
			watermark.scope.objectId === scope.scope.objectId &&
			watermark.scope.epoch === scope.scope.epoch &&
			watermark.scope.anchorDigest === scope.scope.anchorDigest
		);
	};
	const unavailable = (): ReturnType<typeof failed> | undefined =>
		poisoned ? failed("store-poisoned") : closed ? failed("store-closed") : undefined;

	const classify = (
		actual: unknown,
		before: unknown,
		target: Readonly<Record<string, unknown>>
	): LiveJournalFailureKind | undefined => {
		let decision: unknown;
		try {
			decision = classifyLiveJournalMutationObservation({ actual, before, target } as never);
		} catch {
			decision = "mixed";
		}
		if (decision === "exact-new") return undefined;
		if (decision === "exact-old") return "substrate-failure";
		if (decision === "unreadable") return "outcome-unknown";
		if (decision === "mixed") {
			poisoned = true;
			return "store-poisoned";
		}
		return "internal-invariant";
	};

	const install = (
		operation: "install" | "installEpochAnchor",
		input: InstallLiveJournalGenesisInput
	): InstallLiveJournalGenesisResult => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let captured: ReturnType<typeof captureLiveJournalInput>;
		try {
			captured = captureLiveJournalInput(operation, input);
			if (captured.ok !== true) return failed(captured.kind);
		} catch {
			return failed("malformed-input");
		}
		const selected = captured.value as Readonly<{ readonly stored: StoredScope; readonly parametersDigest: string }>;
		let before: DurableSnapshot | null = null;
		let idempotent = false;
		let rejected: LiveJournalFailureKind | undefined;
		let writeVersion: number | undefined;
		try {
			database.exec("BEGIN IMMEDIATE");
			writeVersion = dataVersion(database);
			const installed = readScopeWriter(database, selected.stored.scope);
			const storedRows = readRows(database, selected.stored.scope);
			if (installed === null) {
				if (storedRows.length !== 0) rejected = "store-poisoned";
				else {
					database.exec(
						`INSERT INTO scopes(object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier) VALUES(${sqlText(selected.stored.scope.objectId)},${selected.stored.scope.epoch},${sqlText(selected.stored.scope.anchorDigest)},0,${sqlBlob(selected.stored.exactCanonicalAnchorPreimageBytes)},${sqlBlob(selected.stored.detachedAnchorSignature)},${sqlText(selected.stored.parametersDigest)},${sqlBlob(selected.stored.exactCanonicalParametersCarrierBytes)})`
					);
					statement(
						database,
						"UPDATE scopes SET next_journal_sequence=next_journal_sequence WHERE object_id=? AND epoch=? AND anchor_digest=?"
					).run(...scopeParameters(selected.stored.scope));
				}
			} else {
				before = captureAddressedClosure({ rows: storedRows, scope: installed }) ?? null;
				if (before === null) rejected = "store-poisoned";
				else if (sameInstalledScope(before.scope, selected.stored)) idempotent = true;
				else rejected = "genesis-conflict";
			}
			if (rejected === undefined) database.exec("COMMIT");
			else database.exec("ROLLBACK");
		} catch {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the substrate failure.
			}
			invalidateWatermark(selected.stored.scope);
			return failed("substrate-failure");
		}
		let observation: VersionedSnapshot | typeof UNSTABLE_VERSION | undefined;
		try {
			observation = readVersionedSnapshotReadonly(database, selected.stored.scope);
		} catch {
			invalidateWatermark(selected.stored.scope);
			observation = undefined;
		}
		const actual = observation === undefined || observation === UNSTABLE_VERSION ? undefined : observation.snapshot;
		if (rejected !== undefined) {
			invalidateWatermark(selected.stored.scope);
			if (rejected === "store-poisoned") poisoned = true;
			if (actual === undefined && rejected !== "store-poisoned") return failed("outcome-unknown");
			if (actual !== undefined && actual !== null && captureAddressedClosure(actual) === undefined) {
				poisoned = true;
				return failed("store-poisoned");
			}
			return failed(rejected);
		}
		const capturedActual = actual === undefined || actual === null ? actual : captureAddressedClosure(actual);
		if (actual !== undefined && actual !== null && capturedActual === undefined) {
			invalidateWatermark(selected.stored.scope);
			poisoned = true;
			return failed("store-poisoned");
		}
		const kind = classify(capturedActual, before, { kind: "install", scope: selected.stored });
		if (kind !== undefined) {
			invalidateWatermark(selected.stored.scope);
			return failed(kind);
		}
		if (
			capturedActual !== undefined &&
			capturedActual !== null &&
			observation !== undefined &&
			observation !== UNSTABLE_VERSION &&
			observation.dataVersion === writeVersion
		) {
			establishWatermark(capturedActual.scope, observation.dataVersion);
		}
		return Object.freeze({
			idempotent,
			ok: true,
			parametersDigest: selected.parametersDigest,
			scope: Object.freeze({ ...selected.stored.scope }),
		});
	};
	const installGenesis = (input: InstallLiveJournalGenesisInput): Promise<InstallLiveJournalGenesisResult> =>
		Promise.resolve(install("install", input));
	const installEpochAnchor = (input: InstallLiveJournalGenesisInput): Promise<InstallLiveJournalGenesisResult> =>
		Promise.resolve(install("installEpochAnchor", input));

	// eslint-disable-next-line @typescript-eslint/require-await -- SQLite work is synchronous behind the async port.
	const appendAccepted = async (input: AppendAcceptedVertexInput): Promise<AppendAcceptedVertexResult> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let captured: ReturnType<typeof captureLiveJournalInput>;
		try {
			captured = captureLiveJournalInput("append", input);
			if (captured.ok !== true) return failed(captured.kind);
		} catch {
			return failed("malformed-input");
		}
		let candidate = captured.value as PendingRow;
		let before: DurableSnapshot | AddressedSnapshot | null = null;
		let row: StoredRow | undefined;
		let idempotent = false;
		let rejected: LiveJournalFailureKind | undefined;
		let writeVersion: number | undefined;
		let addressed = false;
		try {
			database.exec("BEGIN IMMEDIATE");
			const scope = readScopeWriter(database, candidate.scope);
			writeVersion = dataVersion(database);
			let storedRows: readonly StoredRow[] | undefined;
			addressed = scope !== null && matchesWatermark(scope, writeVersion);
			if (scope === null || !addressed) storedRows = readRows(database, candidate.scope);
			if (scope === null) {
				invalidateWatermark(candidate.scope);
				if (storedRows?.length !== 0) rejected = "store-poisoned";
				else {
					rejected =
						statement(database, "SELECT 1 AS present FROM main.scopes WHERE object_id=? AND epoch=? LIMIT 1").get(
							candidate.scope.objectId,
							candidate.scope.epoch
						) === undefined
							? "not-installed"
							: "wrong-scope";
				}
			} else {
				before = addressed
					? { kind: "append-addressed", row: null, scope }
					: (captureAddressedClosure({ rows: storedRows ?? [], scope }) ?? null);
				if (before === null) rejected = "store-poisoned";
				else {
					const structural = captureLiveJournalInput("received", candidate);
					if (structural.ok !== true) rejected = structural.kind;
					else candidate = structural.value as PendingRow;
				}
			}
			if (rejected === undefined && scope !== null && before !== null) {
				let fullRows = "rows" in before ? before.rows : undefined;
				let digestRow = addressed
					? readRowByDigest(database, candidate.scope, candidate.vertexDigest)
					: fullRows?.find(({ vertexDigest }) => vertexDigest === candidate.vertexDigest);
				let referenceRow: StoredRow | undefined;
				if (candidate.sourceKind === "local-issued") {
					const { author, authorSequence } = candidate;
					referenceRow = addressed
						? readRowByLocalReference(database, candidate.scope, author, authorSequence)
						: fullRows?.find(
								(item) =>
									item.sourceKind === "local-issued" && item.author === author && item.authorSequence === authorSequence
							);
				}
				let decision = decideLiveJournalDuplicate({
					candidate,
					digestRow: existingProbe(digestRow),
					referenceRow: existingProbe(referenceRow),
				} as never) as Readonly<Record<string, unknown>>;
				if (addressed && decision.action !== "append") {
					fullRows = readRows(database, candidate.scope);
					before = captureAddressedClosure({ rows: fullRows, scope }) ?? null;
					addressed = false;
					if (before === null) rejected = "store-poisoned";
					else {
						digestRow = fullRows.find(({ vertexDigest }) => vertexDigest === candidate.vertexDigest);
						if (candidate.sourceKind === "local-issued") {
							const { author, authorSequence } = candidate;
							referenceRow = fullRows.find(
								(item) =>
									item.sourceKind === "local-issued" && item.author === author && item.authorSequence === authorSequence
							);
						} else referenceRow = undefined;
						decision = decideLiveJournalDuplicate({
							candidate,
							digestRow: existingProbe(digestRow),
							referenceRow: existingProbe(referenceRow),
						} as never) as Readonly<Record<string, unknown>>;
					}
				}
				if (rejected === undefined && decision.action === "conflict") rejected = "evidence-conflict";
				else if (decision.action === "idempotent") {
					row = digestRow ?? referenceRow;
					if (row === undefined) rejected = "internal-invariant";
					else idempotent = true;
				} else if (decision.action === "append") {
					const journalSequence = scope.nextJournalSequence;
					database.exec(
						`INSERT INTO accepted_entries(object_id,epoch,anchor_digest,journal_sequence,source_kind,vertex_digest,received_preimage,received_signature,local_author,local_author_sequence) VALUES(${sqlText(candidate.scope.objectId)},${candidate.scope.epoch},${sqlText(candidate.scope.anchorDigest)},${journalSequence},${sqlText(candidate.sourceKind)},${sqlText(candidate.vertexDigest)},${candidate.sourceKind === "received" ? sqlBlob(candidate.exactCanonicalPreimageBytes) : "NULL"},${candidate.sourceKind === "received" ? sqlBlob(candidate.detachedSignature) : "NULL"},${candidate.sourceKind === "local-issued" ? sqlText(candidate.author) : "NULL"},${candidate.sourceKind === "local-issued" ? candidate.authorSequence : "NULL"})`
					);
					const update = statement(
						database,
						"UPDATE scopes SET next_journal_sequence=? WHERE object_id=? AND epoch=? AND anchor_digest=? AND next_journal_sequence=?"
					).run(journalSequence + 1, ...scopeParameters(candidate.scope), journalSequence);
					if (update.changes !== 1) rejected = "internal-invariant";
					else row = { ...candidate, journalSequence } as StoredRow;
				} else rejected = "internal-invariant";
			}
			if (rejected === undefined) database.exec("COMMIT");
			else database.exec("ROLLBACK");
		} catch {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the substrate failure.
			}
			invalidateWatermark(candidate.scope);
			return failed("substrate-failure");
		}
		if (rejected !== undefined) {
			invalidateWatermark(candidate.scope);
			let actual: DurableSnapshot | null | undefined;
			try {
				const observed = readVersionedSnapshotReadonly(database, candidate.scope);
				actual = observed === UNSTABLE_VERSION ? undefined : observed.snapshot;
			} catch {
				actual = undefined;
			}
			if (rejected === "store-poisoned") poisoned = true;
			if (actual === undefined && rejected !== "store-poisoned") return failed("outcome-unknown");
			if (actual !== undefined && actual !== null && captureAddressedClosure(actual) === undefined) {
				poisoned = true;
				return failed("store-poisoned");
			}
			return failed(rejected);
		}
		if (row === undefined) return failed("internal-invariant");
		let kind: LiveJournalFailureKind | undefined;
		if (addressed && !idempotent) {
			let observed: VersionedAddressedSnapshot | typeof UNSTABLE_VERSION | undefined;
			try {
				observed = readVersionedAddressedSnapshotReadonly(database, candidate.scope, row.journalSequence);
			} catch {
				observed = undefined;
			}
			if (observed === undefined) {
				kind = classify(undefined, before, { kind: "append", row });
			} else if (
				observed !== UNSTABLE_VERSION &&
				observed.dataVersion === writeVersion &&
				observed.snapshot.scope.nextJournalSequence === row.journalSequence + 1
			) {
				kind = classify(observed.snapshot, before, { kind: "append", row });
				if (kind === undefined) establishWatermark(observed.snapshot.scope, observed.dataVersion);
			} else {
				let fallback: VersionedSnapshot | typeof UNSTABLE_VERSION | undefined;
				try {
					fallback = readVersionedSnapshotReadonly(database, candidate.scope);
				} catch {
					fallback = undefined;
				}
				if (fallback === undefined || fallback === UNSTABLE_VERSION) kind = "outcome-unknown";
				else {
					const actual = fallback.snapshot;
					if (actual !== null && captureAddressedClosure(actual) === undefined) kind = "store-poisoned";
					else {
						const targetPresent = actual?.rows.some(({ journalSequence }) => journalSequence === row.journalSequence);
						const fallbackActual =
							actual !== null && before !== null && "kind" in before && targetPresent !== true
								? {
										kind: "append-addressed" as const,
										row: actual.rows.find(({ journalSequence }) => journalSequence === row.journalSequence) ?? null,
										scope: actual.scope,
									}
								: actual;
						kind = classify(fallbackActual, targetPresent === true ? null : before, { kind: "append", row });
						if (kind === undefined && actual !== null) establishWatermark(actual.scope, fallback.dataVersion);
					}
				}
			}
		} else {
			let observed: VersionedSnapshot | typeof UNSTABLE_VERSION | undefined;
			try {
				observed = readVersionedSnapshotReadonly(database, candidate.scope);
			} catch {
				observed = undefined;
			}
			if (observed === undefined || observed === UNSTABLE_VERSION) kind = "outcome-unknown";
			else {
				const actual = observed.snapshot;
				if (actual !== null && captureAddressedClosure(actual) === undefined) kind = "store-poisoned";
				else {
					kind = classify(actual, before, { kind: "append", row });
					if (kind === undefined && actual !== null) establishWatermark(actual.scope, observed.dataVersion);
				}
			}
		}
		if (kind !== undefined) {
			invalidateWatermark(candidate.scope);
			if (kind === "store-poisoned") poisoned = true;
			return failed(kind);
		}
		return Object.freeze({
			idempotent,
			journalSequence: row.journalSequence,
			ok: true,
			scope: Object.freeze({ ...row.scope }),
			sourceKind: row.sourceKind,
			vertexDigest: row.vertexDigest,
		});
	};

	// eslint-disable-next-line @typescript-eslint/require-await -- SQLite work is synchronous behind the async port.
	const readiness = async (input: LiveJournalReadinessInput): Promise<LiveJournalReadinessResult> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let scope: LiveJournalScope;
		try {
			const captured = captureLiveJournalInput("readiness", input);
			if (captured.ok !== true) return failed(captured.kind);
			scope = captured.value as LiveJournalScope;
		} catch {
			return failed("malformed-input");
		}
		let durable: DurableSnapshot | null | typeof WRONG_SCOPE_SNAPSHOT;
		try {
			durable = readReplaySnapshotReadonly(database, scope);
		} catch {
			return failed("substrate-failure");
		}
		if (durable === WRONG_SCOPE_SNAPSHOT) return failed("wrong-scope");
		if (durable === null) return Object.freeze({ kind: "not-installed", ok: true, ready: false });
		let derived: Readonly<Record<string, unknown>>;
		try {
			derived = deriveLiveJournalSnapshot({ durable } as never) as Readonly<Record<string, unknown>>;
			if (derived.ok !== true) {
				poisoned = true;
				return failed("store-poisoned");
			}
		} catch {
			return failed("internal-invariant");
		}
		return Object.freeze({
			ok: true,
			ready: true,
			rowCount: (derived.rows as readonly unknown[]).length,
			scope: Object.freeze({ ...scope }),
			snapshot: derived.token as LiveJournalSnapshotToken,
		}) as LiveJournalReadinessResult;
	};

	// eslint-disable-next-line @typescript-eslint/require-await -- SQLite work is synchronous behind the async port.
	const readPage = async (input: LiveJournalPageInput): Promise<LiveJournalPageResult> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let page: Readonly<Record<string, unknown>>;
		try {
			const captured = captureLiveJournalInput("page", input);
			if (captured.ok !== true) return failed(captured.kind);
			page = captured.value as Readonly<Record<string, unknown>>;
		} catch {
			return failed("malformed-input");
		}
		const scope = page.scope as LiveJournalScope;
		let durable: DurableSnapshot | null | typeof WRONG_SCOPE_SNAPSHOT;
		try {
			durable = readReplaySnapshotReadonly(database, scope);
		} catch {
			return failed("substrate-failure");
		}
		if (durable === WRONG_SCOPE_SNAPSHOT) return failed("wrong-scope");
		if (durable === null) return failed("not-installed");
		const supplied = page.snapshot as LiveJournalSnapshotToken;
		let derived: Readonly<Record<string, unknown>>;
		try {
			derived = deriveLiveJournalSnapshot({
				durable,
				highWatermark: supplied.highWatermark,
				supplied,
			} as never) as Readonly<Record<string, unknown>>;
			if (derived.ok !== true) {
				const kind = derived.kind as LiveJournalFailureKind;
				if (kind === "store-poisoned") poisoned = true;
				return failed(kind);
			}
		} catch {
			return failed("internal-invariant");
		}
		const rows = (derived.rows as readonly StoredRow[]).filter(
			({ journalSequence }) => journalSequence > (page.afterSequence as number)
		);
		const selected = Object.freeze(rows.slice(0, page.limit as number));
		const nextSequence =
			selected.length < rows.length ? (selected[selected.length - 1]?.journalSequence ?? null) : null;
		return Object.freeze({
			nextSequence,
			ok: true,
			rows: selected,
			scope: Object.freeze({ ...scope }),
			snapshot: derived.token,
		}) as LiveJournalPageResult;
	};

	const close = (): Promise<void> => {
		if (closePromise !== undefined) return closePromise;
		closed = true;
		closePromise = Promise.resolve().then(() => {
			try {
				database.close();
			} catch {
				// Close is idempotent and never rejects.
			}
		});
		return closePromise;
	};

	return Object.freeze({ appendAccepted, close, installEpochAnchor, installGenesis, readiness, readPage });
}
