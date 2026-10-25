import { CANONICAL_SETTLEMENT_PLAN_STORAGE_KIND, issuanceLegacySettlementPlanEntriesJson } from "@ts-drp/issuance-store/maintenance";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import {
	applySettlementPlanEffect,
	assertDurableIssueScope,
	assertSettlementPlanProgressTransition,
	captureSettlementPlanWriteInput,
	classifyDurableIssuanceTerminalSuppression,
	cloneDurableIssueCommit,
	cloneSettlementPlan,
	compareDurableIssuanceCompoundKeys,
	copyAndValidateDurableIssueCommit,
	copyDurableIssuanceBytes,
	copyDurableIssueScope,
	copySettlementPlan,
	copySettlementPlanEffect,
	createDurableIssuanceFailure,
	DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT,
	detachIssuanceVerifiedValue,
	type DurableBuildAndSign,
	DurableIssuanceContractError,
	DurableIssuanceInvalidArgumentError,
	type DurableIssuanceNativeOutboxRecord,
	type DurableIssuanceOutboxRecord,
	type DurableIssuanceStore,
	DurableIssuanceUnknownOutcomeError,
	type DurableIssueCommit,
	type DurableIssuedRecord,
	type DurableIssueScope,
	type DurableLineage,
	type DurableOutboxPageInput,
	type DurableOutboxPublicationTransitionInput,
	durablePreimageMatchesScopeAndSequence,
	isClosedDurableIssuanceRecord,
	isValidDurableAuthorSequence,
	isValidDurableScopeField,
	IssuanceVerifiedOnceText,
	MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT,
	type SettlementPlan,
	settlementPlanHasExactEffectLink,
	settlementReplacementLastLogicalTime,
} from "@ts-drp/issuance-store";
import {
	advanceIssuanceRetirementControl,
	assertIssuanceInheritedTargetPruningAllowed,
	assertIssuanceRetirementPlanAllowed,
	assertIssuanceRetirementPreparationRows,
	assertIssuanceRetirementPruningAllowed,
	bindDurableIssuancePruningMaintenance,
	captureDurableIssuancePruningInput,
	captureDurableIssuanceRecoveryCensusInput,
	captureIssuanceNativeSignContext,
	captureIssuanceNativeSignInput,
	captureIssuancePendingUnsignedIntent,
	captureIssuanceRetirementObject,
	createDurableIssuancePruningReceipt,
	createDurableIssuancePruningState,
	createDurableIssuanceRecordPrunedError,
	createIssuanceRetirementControlRead,
	decodeDurableIssuancePreimage,
	decodeIssuanceRetirementControl,
	durableIssuanceAddressIsPruned,
	durableIssuanceLineageConsumed,
	durableIssuanceLineagesEqual,
	type DurableIssuancePendingUnsignedIntent,
	type DurableIssuancePruningReceipt,
	type DurableIssuancePruningState,
	DurableIssuanceRecordPrunedError,
	type DurableIssuanceRecoveryCensus,
	type DurableIssuanceRecoveryCensusInput,
	type DurableIssuanceRecoveryCensusCurrentProbe,
	type DurableIssuanceRecoveryCensusReader,
	type DurableIssuanceRetirementControl,
	type DurableIssuanceRetirementControlRead,
	encodeIssuanceRetirementControl,
	ISSUANCE_RETIREMENT_LIMITS,
	issuanceRetirementAllows,
	issuanceRetirementBytesEqual,
	issuanceRetirementHex,
	issuanceRetirementImage,
	issuanceRetirementRefusal,
	issuanceRetirementTransitionRows,
	issuanceUnsignedPostimageCharge,
	issuanceUnsignedPostimageWidths,
	issuanceUnsignedOwnMaterialByteLength,
	joinIssuanceNativeSign,
	type IssuanceRetirementRows,
	assertSettlementExpiryPublicationExclusive,
	settlementEntryIsAuthenticatedExpiry,
	settlementPlanPermitsAuthenticatedPruning,
} from "@ts-drp/issuance-store/maintenance";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { SqliteNativeReadReservationOwner } from "./native-read-reservation.js";
import type { NodeNativeReadPort } from "../index.js";
import { iterateSqliteRows } from "./sqlite-iterator.js";
import { sqliteFilename } from "./sqlite-filename.js";
import { configuredStatement } from "./sqlite-statement-cache.js";

const DATABASE_SUFFIX = ".drp-issuance-v1.sqlite";
const SCHEMA_VERSION = 5;
const PAGE_SIZE = 4096;
const BUSY_TIMEOUT = 1000;

const LINEAGES_V1_DDL =
	"CREATE TABLE lineages (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  next INTEGER NOT NULL CHECK(next BETWEEN 0 AND 9007199254740991),\n  exhausted INTEGER NOT NULL CHECK(exhausted IN (0,1)),\n  PRIMARY KEY (object_id,author)\n) WITHOUT ROWID";
const LINEAGES_V4_DDL =
	"CREATE TABLE lineages (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  next INTEGER NOT NULL CHECK(next BETWEEN 0 AND 9007199254740991),\n  exhausted INTEGER NOT NULL CHECK(exhausted IN (0,1)),\n  pruned_through_author_sequence INTEGER CHECK(pruned_through_author_sequence IS NULL OR pruned_through_author_sequence BETWEEN 0 AND 9007199254740991),\n  PRIMARY KEY (object_id,author)\n) WITHOUT ROWID";
const LINEAGES_DDL =
	"CREATE TABLE lineages (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  next INTEGER NOT NULL CHECK(next BETWEEN 0 AND 9007199254740991),\n  exhausted INTEGER NOT NULL CHECK(exhausted IN (0,1)),\n  pruned_through_author_sequence INTEGER CHECK(pruned_through_author_sequence IS NULL OR pruned_through_author_sequence BETWEEN 0 AND 9007199254740991),\n  pending_unsigned BLOB CHECK(pending_unsigned IS NULL OR (typeof(pending_unsigned) = 'blob' AND length(pending_unsigned) > 0)),\n  PRIMARY KEY (object_id,author)\n) WITHOUT ROWID";
const ISSUED_RECORDS_DDL =
	"CREATE TABLE issued_records (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  author_sequence INTEGER NOT NULL CHECK(author_sequence BETWEEN 0 AND 9007199254740991),\n  canonical_preimage BLOB NOT NULL CHECK(typeof(canonical_preimage) = 'blob' AND length(canonical_preimage) > 0),\n  digest BLOB NOT NULL CHECK(typeof(digest) = 'blob' AND length(digest) > 0),\n  signature BLOB NOT NULL CHECK(typeof(signature) = 'blob' AND length(signature) > 0),\n  PRIMARY KEY (object_id,author,author_sequence)\n) WITHOUT ROWID";
const ISSUANCE_OUTBOX_DDL =
	"CREATE TABLE issuance_outbox (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  author_sequence INTEGER NOT NULL CHECK(author_sequence BETWEEN 0 AND 9007199254740991),\n  digest BLOB NOT NULL CHECK(typeof(digest) = 'blob' AND length(digest) > 0),\n  publish_state TEXT NOT NULL CHECK(publish_state IN ('pending','published')),\n  PRIMARY KEY (object_id,author,author_sequence)\n) WITHOUT ROWID";
const SETTLEMENT_PLANS_DDL =
	"CREATE TABLE settlement_plans (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),\n  fence_sequence INTEGER CHECK(fence_sequence IS NULL OR fence_sequence BETWEEN 0 AND 9007199254740991),\n  entries_json TEXT NOT NULL CHECK(typeof(entries_json) = 'text' AND length(entries_json) > 0),\n  PRIMARY KEY (object_id,author)\n) WITHOUT ROWID";

const V3_DDL = Object.freeze([LINEAGES_DDL, ISSUED_RECORDS_DDL, ISSUANCE_OUTBOX_DDL, SETTLEMENT_PLANS_DDL] as const);
const V3_EXPECTED_CATALOG = Object.freeze([
	Object.freeze({ name: "issuance_outbox", sql: ISSUANCE_OUTBOX_DDL, type: "table" }),
	Object.freeze({ name: "issued_records", sql: ISSUED_RECORDS_DDL, type: "table" }),
	Object.freeze({ name: "lineages", sql: LINEAGES_V4_DDL, type: "table" }),
	Object.freeze({ name: "settlement_plans", sql: SETTLEMENT_PLANS_DDL, type: "table" }),
] as const);

const RETIREMENT_DDL =
	"CREATE TABLE retirement_controls (object_id TEXT PRIMARY KEY NOT NULL, record BLOB NOT NULL) WITHOUT ROWID";
const RETIREMENT_TRIGGERS = ["lineages", "issued_records", "issuance_outbox", "settlement_plans"]
	.flatMap((table) =>
		["INSERT", "UPDATE", "DELETE"].map((op) => {
			const name = `issuance_retirement_${table}_${op.toLowerCase()}`;
			const row = op === "DELETE" ? "OLD" : "NEW";
			const address =
				table === "issued_records" && op !== "DELETE"
					? ` OR issuance_retirement_record(${row}.object_id,${row}.author,${row}.author_sequence,${row}.canonical_preimage,${row}.digest) != 1`
					: "";
			return {
				name,
				table,
				sql: `CREATE TRIGGER ${name} BEFORE ${op} ON ${table} WHEN issuance_retirement_connection(${row}.object_id) != 1${address} BEGIN SELECT RAISE(ABORT, 'issuance retirement fence'); END`,
			};
		})
	)
	.sort((a, b) => a.name.localeCompare(b.name));
const DDL = [...V3_DDL, RETIREMENT_DDL, ...RETIREMENT_TRIGGERS.map((t) => t.sql)];
const EXPECTED_CATALOG = [
	...V3_EXPECTED_CATALOG.map((row) => (row.name === "lineages" ? { ...row, sql: LINEAGES_DDL } : row)),
	{ name: "retirement_controls", sql: RETIREMENT_DDL, type: "table" },
]
	.sort((a, b) => a.name.localeCompare(b.name))
	.concat(RETIREMENT_TRIGGERS.map((t) => ({ name: t.name, sql: t.sql, type: "trigger", table: t.table })));
const V4_EXPECTED_CATALOG = EXPECTED_CATALOG.map((row) =>
	row.name === "lineages" ? { ...row, sql: LINEAGES_V4_DDL } : row
);

const V2_EXPECTED_CATALOG = Object.freeze([
	Object.freeze({ name: "issuance_outbox", sql: ISSUANCE_OUTBOX_DDL, type: "table" }),
	Object.freeze({ name: "issued_records", sql: ISSUED_RECORDS_DDL, type: "table" }),
	Object.freeze({ name: "lineages", sql: LINEAGES_V4_DDL, type: "table" }),
] as const);
const V1_EXPECTED_CATALOG = Object.freeze([
	Object.freeze({ name: "issuance_outbox", sql: ISSUANCE_OUTBOX_DDL, type: "table" }),
	Object.freeze({ name: "issued_records", sql: ISSUED_RECORDS_DDL, type: "table" }),
	Object.freeze({ name: "lineages", sql: LINEAGES_V1_DDL, type: "table" }),
] as const);

interface NativeLineage extends DurableLineage {
	readonly pendingUnsigned?: DurableIssuancePendingUnsignedIntent;
	readonly present: boolean;
	readonly prunedThroughAuthorSequence: number | null;
}

interface NativeLineageRow extends DurableIssueScope, NativeLineage {}

interface NativeIssuedRow extends DurableIssueScope {
	readonly authorSequence: number;
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

interface NativeOutboxRow extends DurableIssueScope {
	readonly authorSequence: number;
	readonly digest: Uint8Array;
	readonly publishState: "pending" | "published";
}

interface TerminalReadback {
	readonly issuedRecord: DurableIssuedRecord | null;
	readonly lineage: DurableLineage;
	readonly outboxRecord: DurableIssuanceNativeOutboxRecord | null;
	readonly prunedThroughAuthorSequence: number | null;
}

function invalid(message: string): DurableIssuanceInvalidArgumentError {
	return new DurableIssuanceInvalidArgumentError(message);
}

function failure(
	code: Exclude<DurableIssuanceContractError["code"], "ISSUANCE_INVALID_ARGUMENT" | "ISSUANCE_OUTCOME_UNKNOWN">,
	message: string
): DurableIssuanceContractError {
	return createDurableIssuanceFailure(code, message);
}

function errorNumber(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const value = Reflect.get(error, "errcode");
	return typeof value === "number" ? value : undefined;
}

function errorText(error: unknown): string {
	if (error instanceof Error) return `${error.message} ${String(Reflect.get(error, "errstr") ?? "")}`;
	return String(error);
}

function mapSubstrate(error: unknown, message: string, fallback: "permanent" | "transient" = "transient"): Error {
	if (
		error instanceof DurableIssuanceContractError ||
		error instanceof DurableIssuanceInvalidArgumentError ||
		error instanceof DurableIssuanceRecordPrunedError
	) {
		return error;
	}
	const number = errorNumber(error);
	const text = errorText(error);
	if (number === 5 || number === 6 || /\b(?:busy|locked)\b/iu.test(text)) {
		return createDurableIssuanceFailure("ISSUANCE_SUBSTRATE_FAILURE", message, "transient");
	}
	if (number === 7 || number === 13 || /\b(?:full|no memory|out of memory)\b/iu.test(text)) {
		return createDurableIssuanceFailure("ISSUANCE_SUBSTRATE_FAILURE", message, "resource-exhausted");
	}
	return createDurableIssuanceFailure("ISSUANCE_SUBSTRATE_FAILURE", message, fallback);
}

function capturePrimaryFilename(value: unknown): { primaryFilename: string; initialization: "create" | "reopen" } {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("options must be plain");
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw invalid("options must be plain");
		const keys = Reflect.ownKeys(value);
		if (
			!keys.includes("primaryFilename") ||
			keys.some((key) => key !== "primaryFilename" && key !== "initialization")
		) {
			throw invalid("options must contain primaryFilename and optional initialization");
		}
		const mode = Object.getOwnPropertyDescriptor(value, "initialization");
		if (
			mode !== undefined &&
			(!("value" in mode) || !mode.enumerable || (mode.value !== "create" && mode.value !== "reopen"))
		)
			throw invalid("initialization must be create or reopen");
		const descriptor = Object.getOwnPropertyDescriptor(value, "primaryFilename");
		if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
			throw invalid("primaryFilename must be an enumerable data property");
		}
		if (typeof descriptor.value !== "string" || descriptor.value.length === 0 || descriptor.value.includes("\0")) {
			throw invalid("primaryFilename must be a representable non-empty primitive string");
		}
		return { primaryFilename: descriptor.value, initialization: mode?.value ?? "create" };
	} catch (error) {
		if (error instanceof DurableIssuanceInvalidArgumentError) throw error;
		throw invalid("options could not be inspected as a closed record");
	}
}

function statement(database: DatabaseSync, sql: string): StatementSync {
	const prepared = database.prepare(sql);
	prepared.setReadBigInts(false);
	return prepared;
}

function scalar(database: DatabaseSync, sql: string): unknown {
	const row = configuredStatement(database, sql).get();
	return row === undefined ? undefined : Object.values(row)[0];
}

function catalog(database: DatabaseSync): readonly Record<string, unknown>[] {
	return nativeLocalSessionSchemaRows(
		database,
		configuredStatement(database, "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all()
	);
}

function catalogMatches(
	rows: readonly Record<string, unknown>[],
	expectedCatalog: readonly Readonly<{ name: string; sql: string; type: string; table?: string }>[] = EXPECTED_CATALOG
): boolean {
	return (
		rows.length === expectedCatalog.length &&
		rows.every((row, index) => {
			const expected = expectedCatalog[index];
			return (
				expected !== undefined &&
				row.type === expected.type &&
				row.name === expected.name &&
				row.tbl_name === (expected.table ?? expected.name) &&
				row.sql === expected.sql
			);
		})
	);
}

function unsupported(message: string): DurableIssuanceContractError {
	return failure("ISSUANCE_UNSUPPORTED_SCHEMA", message);
}

function verifyAuthority(database: DatabaseSync): void {
	if (
		scalar(database, "PRAGMA busy_timeout") !== BUSY_TIMEOUT ||
		scalar(database, "PRAGMA synchronous") !== 2 ||
		scalar(database, "PRAGMA user_version") !== SCHEMA_VERSION ||
		scalar(database, "PRAGMA page_size") !== PAGE_SIZE ||
		String(scalar(database, "PRAGMA journal_mode")).toLowerCase() !== "wal" ||
		!catalogMatches(catalog(database))
	) {
		throw unsupported("issuance SQLite authority is unsupported");
	}
}

function migrateUnsignedLineage(database: DatabaseSync): void {
	database.exec("ALTER TABLE lineages RENAME TO lineages_v4");
	database.exec(LINEAGES_DDL);
	database.exec(
		"INSERT INTO lineages (object_id,author,next,exhausted,pruned_through_author_sequence) SELECT object_id,author,next,exhausted,pruned_through_author_sequence FROM lineages_v4"
	);
	database.exec("DROP TABLE lineages_v4");
}

function admit(database: DatabaseSync, initialization: "create" | "reopen" = "create"): void {
	database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT}`);
	if (scalar(database, "PRAGMA busy_timeout") !== BUSY_TIMEOUT) {
		throw failure("ISSUANCE_DURABILITY_UNAVAILABLE", "SQLite busy timeout could not be established");
	}
	database.exec("PRAGMA synchronous=FULL");
	if (scalar(database, "PRAGMA synchronous") !== 2) {
		throw failure("ISSUANCE_DURABILITY_UNAVAILABLE", "SQLite FULL synchronous mode could not be established");
	}
	if (initialization === "reopen") {
		verifyAuthority(database);
		return;
	}

	const initialCatalog = catalog(database);
	const initialVersion = scalar(database, "PRAGMA user_version");
	const initiallyFresh = initialCatalog.length === 0 && initialVersion === 0;
	if (initiallyFresh) {
		database.exec(`PRAGMA page_size=${PAGE_SIZE}`);
		if (scalar(database, "PRAGMA page_size") !== PAGE_SIZE) {
			throw failure("ISSUANCE_DURABILITY_UNAVAILABLE", "SQLite page size could not be established");
		}
		const journalResult = scalar(database, "PRAGMA journal_mode=WAL");
		if (String(journalResult).toLowerCase() !== "wal") {
			throw failure("ISSUANCE_DURABILITY_UNAVAILABLE", "SQLite WAL mode could not be established");
		}
	} else if (
		scalar(database, "PRAGMA page_size") !== PAGE_SIZE ||
		String(scalar(database, "PRAGMA journal_mode")).toLowerCase() !== "wal"
	) {
		throw unsupported("existing issuance SQLite authority is unsupported");
	}
	database.exec("BEGIN IMMEDIATE");
	try {
		const lockedCatalog = catalog(database);
		const lockedVersion = scalar(database, "PRAGMA user_version");
		if (lockedCatalog.length === 0 && lockedVersion === 0) {
			for (const sql of DDL) database.exec(sql);
			database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
		} else if (lockedVersion === 1 && catalogMatches(lockedCatalog, V1_EXPECTED_CATALOG)) {
			database.exec("ALTER TABLE lineages RENAME TO lineages_v1");
			database.exec(LINEAGES_DDL);
			database.exec(
				"INSERT INTO lineages (object_id,author,next,exhausted,pruned_through_author_sequence) SELECT object_id,author,next,exhausted,NULL FROM lineages_v1"
			);
			database.exec("DROP TABLE lineages_v1");
			database.exec(SETTLEMENT_PLANS_DDL);
			database.exec(RETIREMENT_DDL);
			for (const t of RETIREMENT_TRIGGERS) database.exec(t.sql);
			database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
		} else if (lockedVersion === 2 && catalogMatches(lockedCatalog, V2_EXPECTED_CATALOG)) {
			migrateUnsignedLineage(database);
			database.exec(SETTLEMENT_PLANS_DDL);
			database.exec(RETIREMENT_DDL);
			for (const t of RETIREMENT_TRIGGERS) database.exec(t.sql);
			database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
		} else if (lockedVersion === 3 && catalogMatches(lockedCatalog, V3_EXPECTED_CATALOG)) {
			migrateUnsignedLineage(database);
			database.exec(RETIREMENT_DDL);
			for (const t of RETIREMENT_TRIGGERS) database.exec(t.sql);
			database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
		} else if (lockedVersion === 4 && catalogMatches(lockedCatalog, V4_EXPECTED_CATALOG)) {
			for (const trigger of RETIREMENT_TRIGGERS) database.exec(`DROP TRIGGER ${trigger.name}`);
			migrateUnsignedLineage(database);
			for (const trigger of RETIREMENT_TRIGGERS) database.exec(trigger.sql);
			database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
		} else if (lockedVersion !== SCHEMA_VERSION || !catalogMatches(lockedCatalog)) {
			throw unsupported("existing issuance SQLite authority is unsupported");
		}
		if (!catalogMatches(catalog(database)) || scalar(database, "PRAGMA user_version") !== SCHEMA_VERSION) {
			throw unsupported("issuance SQLite authority did not match its exact v3 schema");
		}
		database.exec("COMMIT");
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// Preserve the admission failure.
		}
		throw error;
	}
	verifyAuthority(database);
}

function rawLineage(value: unknown, present: boolean, scope?: DurableIssueScope): NativeLineage | undefined {
	if (!present) return { exhausted: false, next: 0, present: false, prunedThroughAuthorSequence: null };
	if (typeof value !== "object" || value === null) return undefined;
	const next = Reflect.get(value, "next");
	const exhausted = Reflect.get(value, "exhausted");
	const watermark = Reflect.get(value, "pruned_through_author_sequence");
	if (
		!isValidDurableAuthorSequence(next) ||
		(exhausted !== 0 && exhausted !== 1) ||
		(exhausted === 1 && next !== Number.MAX_SAFE_INTEGER) ||
		(watermark !== null && !isValidDurableAuthorSequence(watermark)) ||
		(watermark !== null && !durableIssuanceLineageConsumed({ exhausted: exhausted === 1, next }, watermark))
	) {
		return undefined;
	}
	let pendingUnsigned: DurableIssuancePendingUnsignedIntent | undefined;
	const rawPending = Reflect.get(value, "pending_unsigned");
	if (rawPending !== null && rawPending !== undefined) {
		if (!(rawPending instanceof Uint8Array) || scope === undefined) return undefined;
		try {
			pendingUnsigned = captureIssuancePendingUnsignedIntent(decodeCanonical(rawPending), scope);
		} catch {
			return undefined;
		}
		if (!issuanceRetirementBytesEqual(encodeCanonical(pendingUnsigned), rawPending)) return undefined;
		if (pendingUnsigned.authorSequence !== next || exhausted === 1) return undefined;
	}
	return {
		exhausted: exhausted === 1,
		next,
		present: true,
		prunedThroughAuthorSequence: watermark,
		...(pendingUnsigned === undefined ? {} : { pendingUnsigned }),
	};
}

function copyLineageRow(value: unknown): NativeLineageRow | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const objectId = Reflect.get(value, "object_id");
	const author = Reflect.get(value, "author");
	const lineage = rawLineage(value, true, { objectId: objectId as string, author: author as string });
	if (!isValidDurableScopeField(objectId) || !isValidDurableScopeField(author) || lineage === undefined) {
		return undefined;
	}
	return { author, objectId, ...lineage };
}

function readNativeLineage(
	database: DatabaseSync,
	scope: DurableIssueScope,
	authority: "snapshot" | "writer" = "snapshot"
): NativeLineage | undefined {
	const table = authority === "writer" ? "lineages" : "main.lineages";
	const pendingSize = configuredStatement(
		database,
		`SELECT length(pending_unsigned) AS n FROM ${table} WHERE object_id=? AND author=?`
	).get(scope.objectId, scope.author)?.n;
	if (
		pendingSize !== undefined &&
		pendingSize !== null &&
		(typeof pendingSize !== "number" || pendingSize > ISSUANCE_RETIREMENT_LIMITS.maxBytes)
	)
		throw issuanceRetirementRefusal("issuance unsigned metadata exceeds bound");
	const row = configuredStatement(
		database,
		`SELECT next,exhausted,pruned_through_author_sequence,pending_unsigned FROM ${table} WHERE object_id=? AND author=?`
	).get(scope.objectId, scope.author);
	return rawLineage(row, row !== undefined, scope);
}

function copyIssuedRow(value: unknown): NativeIssuedRow | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const objectId = Reflect.get(value, "object_id");
	const author = Reflect.get(value, "author");
	const authorSequence = Reflect.get(value, "author_sequence");
	const canonicalPreimageBytes = copyDurableIssuanceBytes(Reflect.get(value, "canonical_preimage"));
	const digest = copyDurableIssuanceBytes(Reflect.get(value, "digest"));
	const signature = copyDurableIssuanceBytes(Reflect.get(value, "signature"));
	if (
		!isValidDurableScopeField(objectId) ||
		!isValidDurableScopeField(author) ||
		!isValidDurableAuthorSequence(authorSequence) ||
		canonicalPreimageBytes === undefined ||
		digest === undefined ||
		signature === undefined ||
		!durablePreimageMatchesScopeAndSequence(canonicalPreimageBytes, { author, objectId }, authorSequence)
	) {
		return undefined;
	}
	return { author, authorSequence, canonicalPreimageBytes, digest, objectId, signature };
}

function copyOutboxRow(value: unknown): NativeOutboxRow | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const objectId = Reflect.get(value, "object_id");
	const author = Reflect.get(value, "author");
	const authorSequence = Reflect.get(value, "author_sequence");
	const digest = copyDurableIssuanceBytes(Reflect.get(value, "digest"));
	const publishState = Reflect.get(value, "publish_state");
	if (
		!isValidDurableScopeField(objectId) ||
		!isValidDurableScopeField(author) ||
		!isValidDurableAuthorSequence(authorSequence) ||
		digest === undefined ||
		(publishState !== "pending" && publishState !== "published")
	) {
		return undefined;
	}
	return { author, authorSequence, digest, objectId, publishState };
}

function settlementPlanEntriesJson(plan: SettlementPlan): string {
	if (plan.sourceContexts !== undefined) return JSON.stringify({kind: CANONICAL_SETTLEMENT_PLAN_STORAGE_KIND,
		bytes: Buffer.from(encodeCanonical(plan, {maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes, maxDepth: 12,
			maxItems: ISSUANCE_RETIREMENT_LIMITS.maxRows * 32})).toString("base64")});
	return issuanceLegacySettlementPlanEntriesJson(plan);
}

// Verify-once memo for stored settlement-plan rows, keyed by every row field the
// verification reads (address, revision, fence and the exact stored entries text).
// A write, rollback, reopen or another connection's write changes that key, so an
// entry is only ever returned for an identical row. Entries never escape.
const verifiedSettlementPlanRows = new IssuanceVerifiedOnceText<SettlementPlan>({
	maxEntries: 64,
	maxChars: 8 * (Math.ceil(ISSUANCE_RETIREMENT_LIMITS.maxBytes / 3) * 4 + 64),
});
let settlementPlanRowCountsBase = { verifications: 0, hits: 0 };
/**
 * Diagnostic work counts for stored settlement-plan row verification.
 * @returns Full verifications and memo hits since the last reset.
 */
export function nodeSettlementPlanRowVerificationCounts(): Readonly<{ verifications: number; hits: number }> {
	const counts = verifiedSettlementPlanRows.counts();
	return {
		verifications: counts.verifications - settlementPlanRowCountsBase.verifications,
		hits: counts.hits - settlementPlanRowCountsBase.hits,
	};
}
/** Resets the diagnostic work counts and keeps every verified result. */
export function resetNodeSettlementPlanRowVerificationCounts(): void {
	settlementPlanRowCountsBase = verifiedSettlementPlanRows.counts();
}
/** Drops every verified result and resets the diagnostic work counts. Never needed for soundness. */
export function clearNodeSettlementPlanRowVerifiedOnce(): void {
	verifiedSettlementPlanRows.clear();
	resetNodeSettlementPlanRowVerificationCounts();
}
const exactRowInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0);

function copySettlementPlanRow(value: unknown, scope: DurableIssueScope): SettlementPlan | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const objectId = Reflect.get(value, "object_id");
	const author = Reflect.get(value, "author");
	const revision = Reflect.get(value, "revision");
	const fenceSequence = Reflect.get(value, "fence_sequence");
	const entriesJson = Reflect.get(value, "entries_json");
	if (objectId !== scope.objectId || author !== scope.author || typeof entriesJson !== "string") return undefined;
	const row = { object_id: objectId, author, revision, fence_sequence: fenceSequence, entries_json: entriesJson };
	// Only exact scalar rows are memoized; any other shape is verified afresh every time.
	if (!exactRowInteger(revision) || (fenceSequence !== null && !exactRowInteger(fenceSequence)))
		return verifySettlementPlanRow(row, scope);
	// The JSON prefix is self-delimiting, so the key is injective over the read fields.
	const key = JSON.stringify([objectId, author, revision, fenceSequence]) + entriesJson;
	const plan = verifiedSettlementPlanRows.verify(key, () => verifySettlementPlanRow(row, scope));
	return plan === undefined ? undefined : detachIssuanceVerifiedValue(plan);
}

function verifySettlementPlanRow(value: unknown, scope: DurableIssueScope): SettlementPlan | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const objectId = Reflect.get(value, "object_id");
	const author = Reflect.get(value, "author");
	const revision = Reflect.get(value, "revision");
	const fenceSequence = Reflect.get(value, "fence_sequence");
	const entriesJson = Reflect.get(value, "entries_json");
	if (objectId !== scope.objectId || author !== scope.author || typeof entriesJson !== "string") return undefined;
	try {
		const decoded: unknown = JSON.parse(entriesJson);
		if (isClosedDurableIssuanceRecord(decoded, ["kind", "bytes"]) && decoded.kind === CANONICAL_SETTLEMENT_PLAN_STORAGE_KIND) {
			if (typeof decoded.bytes !== "string" || decoded.bytes.length > Math.ceil(ISSUANCE_RETIREMENT_LIMITS.maxBytes / 3) * 4)
				return undefined;
			const bytes = Buffer.from(decoded.bytes, "base64");
			if (bytes.toString("base64") !== decoded.bytes || bytes.byteLength > ISSUANCE_RETIREMENT_LIMITS.maxBytes) return undefined;
			const plan = copySettlementPlan(decodeCanonical(bytes), scope);
			return plan !== undefined && plan.revision === revision && plan.fenceSequence === fenceSequence ? plan : undefined;
		}
		if (!Array.isArray(decoded)) return undefined;
		const entries = decoded.map((entry) => {
			if (typeof entry !== "object" || entry === null) {
				return entry;
			}
			const sourceDigest = Reflect.get(entry, "sourceDigest");
			if (
				!Array.isArray(sourceDigest) ||
				sourceDigest.length === 0 ||
				sourceDigest.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
			) {
				return entry;
			}
			const inheritance = Reflect.get(entry, "inheritance");
			let decodedInheritance: unknown;
			if (inheritance !== undefined) {
				if (typeof inheritance !== "object" || inheritance === null) return entry;
				const targetVertexDigest = Reflect.get(inheritance, "targetVertexDigest");
				if (
					!Array.isArray(targetVertexDigest) ||
					targetVertexDigest.length !== 32 ||
					targetVertexDigest.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
				)
					return entry;
				decodedInheritance = { ...inheritance, targetVertexDigest: Uint8Array.from(targetVertexDigest as number[]) };
			}
			const replacementProgress = Reflect.get(entry, "replacementProgress");
			const transformRefusal=Reflect.get(entry,"transformRefusal");
			let decodedRefusal:unknown;
			if(transformRefusal!==undefined) {
				if(typeof transformRefusal!=="object" || transformRefusal===null)return entry;
				const proposed=Reflect.get(transformRefusal,"proposedIntentDigest");
				if(!Array.isArray(proposed)||proposed.length!==32||proposed.some(byte=>!Number.isInteger(byte)||byte<0||byte>255))return entry;
				decodedRefusal={...transformRefusal,proposedIntentDigest:Uint8Array.from(proposed as number[])};
			}
			if (replacementProgress !== undefined) {
				if (typeof replacementProgress !== "object" || replacementProgress === null) return entry;
				const intentDigest = Reflect.get(replacementProgress, "intentDigest");
				if (
					!Array.isArray(intentDigest) ||
					intentDigest.length !== 32 ||
					intentDigest.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
				) {
					return entry;
				}
				return {
					...entry,
					...(inheritance === undefined ? {} : { inheritance: decodedInheritance }),
					...(transformRefusal===undefined?{}:{transformRefusal:decodedRefusal}),
					replacementProgress: {
						...replacementProgress,
						intentDigest: Uint8Array.from(intentDigest as number[]),
					},
					sourceDigest: Uint8Array.from(sourceDigest as number[]),
				};
			}
			return {
				...entry,
				...(inheritance === undefined ? {} : { inheritance: decodedInheritance }),
				...(transformRefusal===undefined?{}:{transformRefusal:decodedRefusal}),
				sourceDigest: Uint8Array.from(sourceDigest as number[]),
			};
		});
		return copySettlementPlan({ entries, fenceSequence, revision, scope }, scope);
	} catch {
		return undefined;
	}
}

function readSettlementPlanRow(database: DatabaseSync, scope: DurableIssueScope): SettlementPlan | null | undefined {
	const raw = configuredStatement(
		database,
		"SELECT object_id,author,revision,fence_sequence,entries_json FROM settlement_plans WHERE object_id=? AND author=?"
	).get(scope.objectId, scope.author);
	return raw === undefined ? null : copySettlementPlanRow(raw, scope);
}

function issuedCommit(row: NativeIssuedRow): DurableIssueCommit {
	const scope = { author: row.author, objectId: row.objectId };
	const envelope = {
		canonicalPreimageBytes: new Uint8Array(row.canonicalPreimageBytes),
		digest: new Uint8Array(row.digest),
		signature: new Uint8Array(row.signature),
	};
	return cloneDurableIssueCommit({
		authorSequence: row.authorSequence,
		envelope,
		issuedRecord: { authorSequence: row.authorSequence, envelope, scope },
		outboxEntry: { authorSequence: row.authorSequence, envelope, scope },
	});
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameLineage(left: NativeLineage, right: NativeLineage): boolean {
	return left.present === right.present && left.next === right.next && left.exhausted === right.exhausted;
}

function readRetirementControl(database: DatabaseSync, objectId: string): DurableIssuanceRetirementControl | null {
	return readRetirementControlRecord(database, objectId)?.control ?? null;
}
/**
 * Reads the control and its exact stored bytes. Decoding refuses unless
 * `encodeIssuanceRetirementControl(control)` is exactly the stored record, so `bytes`
 * is that encoding without re-encoding the control (and its embedded plans) again.
 */
function readRetirementControlRecord(
	database: DatabaseSync,
	objectId: string
): Readonly<{ control: DurableIssuanceRetirementControl; bytes: Uint8Array }> | null {
	const length = configuredStatement(database, "SELECT length(record) AS size FROM retirement_controls WHERE object_id=?").get(
		objectId
	);
	if (!length) return null;
	if (typeof length.size !== "number" || length.size > ISSUANCE_RETIREMENT_LIMITS.maxBytes)
		throw issuanceRetirementRefusal("issuance retirement control exceeds bound");
	const record = (
		configuredStatement(database, "SELECT record FROM retirement_controls WHERE object_id=?").get(objectId) as {
			record: unknown;
		}
	).record;
	const control = decodeIssuanceRetirementControl(record);
	return { control, bytes: new Uint8Array(record as Uint8Array) };
}
function registerRetirementConnection(database: DatabaseSync): void {
	database.function("issuance_retirement_connection", (objectId) => {
		try {
			if (typeof objectId !== "string") return 0;
			readRetirementControl(database, objectId);
			return 1;
		} catch {
			return 0;
		}
	});
	database.function("issuance_retirement_record", (objectId, author, sequence, preimage, digest) => {
		try {
			return typeof objectId === "string" &&
				typeof author === "string" &&
				typeof sequence === "number" &&
				preimage instanceof Uint8Array &&
				digest instanceof Uint8Array &&
				issuanceRetirementAllows(
					readRetirementControl(database, objectId),
					{ objectId, author },
					sequence,
					preimage,
					digest
				)
				? 1
				: 0;
		} catch {
			return 0;
		}
	});
}
function retirementRows(
	database: DatabaseSync,
	objectId: string,
	limits: Readonly<{ maxRows: number; maxBytes: number }> = ISSUANCE_RETIREMENT_LIMITS
): IssuanceRetirementRows {
	const tables = ["lineages", "issued_records", "issuance_outbox", "settlement_plans"];
	let count = 0;
	for (const table of tables) {
		const n = (
			configuredStatement(database, `SELECT count(*) AS n FROM ${table} WHERE object_id=?`).get(objectId) as { n: unknown }
		).n;
		if (typeof n !== "number") throw issuanceRetirementRefusal("issuance retirement census unreadable");
		count += n;
	}
	if (count > limits.maxRows) throw issuanceRetirementRefusal("issuance retirement census exceeds bound");
	const issuedBytes = (
		configuredStatement(
			database,
			"SELECT coalesce(sum(length(canonical_preimage)+length(digest)+length(signature)),0) AS n FROM issued_records WHERE object_id=?"
		).get(objectId) as { n: unknown }
	).n;
	const planBytes = (
		configuredStatement(
			database,
			"SELECT coalesce(sum(length(CAST(entries_json AS BLOB))),0) AS n FROM settlement_plans WHERE object_id=?"
		).get(objectId) as { n: unknown }
	).n;
	const pendingBytes = (
		configuredStatement(
			database,
			"SELECT coalesce(sum(length(pending_unsigned)),0) AS n FROM lineages WHERE object_id=?"
		).get(objectId) as { n: unknown }
	).n;
	if (
		typeof issuedBytes !== "number" ||
		typeof planBytes !== "number" ||
		typeof pendingBytes !== "number" ||
		issuedBytes + planBytes + pendingBytes > limits.maxBytes
	)
		throw issuanceRetirementRefusal("issuance retirement native bytes exceed bound");
	let bytes = 0;
	const collect = <T>(table: string, parse: (r: unknown) => T | undefined): T[] => {
		const query = statement(
			database,
			`SELECT * FROM ${table} WHERE object_id=? ORDER BY author${table === "issued_records" || table === "issuance_outbox" ? ",author_sequence" : ""}`
		);
		const rows: T[] = [];
		for (const raw of iterateSqliteRows(query, objectId)) {
			const parsed = parse(raw);
			if (!parsed) throw issuanceRetirementRefusal("issuance retirement native row unclassified");
			bytes += encodeCanonical(parsed, {
				maxBytes: limits.maxBytes,
				maxDepth: 16,
				maxItems: ISSUANCE_RETIREMENT_LIMITS.maxRows * 32,
			}).length;
			if (bytes > limits.maxBytes) throw issuanceRetirementRefusal("issuance retirement rows exceed bound");
			rows.push(parsed);
		}
		void query.sourceSQL;
		return rows;
	};
	return {
		lineages: collect("lineages", (raw) => {
			const r = copyLineageRow(raw);
			return (
				r && {
					author: r.author,
					objectId: r.objectId,
					next: r.next,
					exhausted: r.exhausted,
					prunedThroughAuthorSequence: r.prunedThroughAuthorSequence,
					...(r.pendingUnsigned === undefined ? {} : { pendingUnsigned: r.pendingUnsigned }),
				}
			);
		}),
		issued: collect("issued_records", copyIssuedRow),
		outbox: collect("issuance_outbox", copyOutboxRow),
		plans: collect("settlement_plans", (raw) => {
			const r = raw as { object_id: string; author: string };
			return copySettlementPlanRow(raw, { objectId: r.object_id, author: r.author });
		}),
	};
}
function assertRetirementRow(
	database: DatabaseSync,
	scope: DurableIssueScope,
	seq: number,
	preimage: Uint8Array,
	digest: Uint8Array
): void {
	const lineage = readNativeLineage(database, scope, "writer");
	const pending = lineage?.pendingUnsigned;
	if (
		pending !== undefined &&
		seq === pending.authorSequence &&
		(!issuanceRetirementBytesEqual(pending.canonicalPreimageBytes, preimage) ||
			!issuanceRetirementBytesEqual(pending.digest, digest))
	)
		throw issuanceRetirementRefusal("issuance unsigned identity is unresolved");
	if (!issuanceRetirementAllows(readRetirementControl(database, scope.objectId), scope, seq, preimage, digest))
		throw issuanceRetirementRefusal("issued epoch is retired");
}
function reserveUnsignedIntent(
	database: DatabaseSync,
	scope: DurableIssueScope,
	captured: ReturnType<typeof captureIssuanceNativeSignInput>,
	context: Parameters<NonNullable<Parameters<DurableBuildAndSign>[1]>>[2],
	ordinaryRows?: IssuanceRetirementRows
): NativeLineage {
	const current = readNativeLineage(database, scope, "writer");
	if (!current || current.exhausted || current.next !== captured.sequence)
		throw issuanceRetirementRefusal("native unsigned lineage changed");
	if (
		context !== undefined &&
		!isClosedDurableIssuanceRecord(context, Object.hasOwn(context, "planEffect") ? ["planEffect"] : [])
	)
		throw invalid("native unsigned settlement context is malformed");
	const planEffect = context?.planEffect === undefined ? undefined : copySettlementPlanEffect(context.planEffect);
	if (context?.planEffect !== undefined && planEffect === undefined)
		throw invalid("native unsigned settlement effect is malformed");
	const plan = planEffect === undefined ? undefined : readSettlementPlanRow(database, scope);
	if (planEffect !== undefined && !plan)
		throw issuanceRetirementRefusal("native unsigned settlement plan is unavailable");
	const priorControl = readRetirementControl(database, scope.objectId);
	const control: DurableIssuanceRetirementControl = priorControl ?? {
		kind: "v3-issuance-retirement-control-1",
		objectId: scope.objectId,
		incarnation: issuanceRetirementHex(globalThis.crypto.getRandomValues(new Uint8Array(32))),
		revision: 0,
		sequence: 0,
		active: null,
		completed: null,
	};
	const requested = captureIssuancePendingUnsignedIntent(
		{
			kind: "v3-issuance-pending-unsigned-1",
			incarnation: control.incarnation,
			authorSequence: captured.sequence,
			canonicalPreimageBytes: captured.bytes,
			digest: captured.digest,
			phase: "reserved",
			...(planEffect === undefined ? {} : { planEffect, exactCanonicalPlanBytes: encodeCanonical(plan) }),
		},
		scope
	);
	const old = current.pendingUnsigned;
	if (
		old !== undefined &&
		!issuanceRetirementBytesEqual(encodeCanonical({ ...old, phase: "reserved" }), encodeCanonical(requested))
	)
		throw issuanceRetirementRefusal("native unsigned identity or context is unresolved");
	const pending = old ?? requested;
	const priorRows = ordinaryRows ?? retirementRows(database, scope.objectId);
	const normalized = {
		...scope,
		next: current.next,
		exhausted: current.exhausted,
		prunedThroughAuthorSequence: current.prunedThroughAuthorSequence,
		pendingUnsigned: pending,
	};
	const rows = {
		...priorRows,
		lineages: current.present
			? priorRows.lineages.map((row) => (row.author === scope.author ? normalized : row))
			: [...priorRows.lineages, normalized],
	};
	if (ordinaryRows === undefined) {
		issuanceRetirementImage(rows, scope.objectId); // reserved postimage, including exact unknown debt bytes
		issuanceUnsignedPostimageCharge(rows, scope, pending); // eventual pair + exact prospective plan
	} else {
		// The exact initial native image is still held by this writer. NONE's
		// own pending phase changes only this lineage/control. Size the original
		// complete postimages without constructing/hash-reading new full images.
		if (planEffect !== undefined || ordinaryRows.plans.length !== 0)
			throw issuanceRetirementRefusal("ordinary unsigned source has settlement work");
		issuanceUnsignedPostimageWidths(ordinaryRows, scope, {
			kind: "v3-issuance-pending-unsigned-1", authorSequence: captured.sequence,
			canonicalPreimageBytes: captured.bytes, digest: captured.digest,
		}, priorControl);
	}
	assertRetirementRow(database, scope, captured.sequence, captured.bytes, captured.digest);
	if (priorControl === null)
		configuredStatement(database, "INSERT INTO retirement_controls (object_id,record) VALUES(?,?)").run(
			scope.objectId,
			encodeIssuanceRetirementControl(control)
		);
	if (old === undefined) {
		if (current.present)
			configuredStatement(database, "UPDATE lineages SET pending_unsigned=? WHERE object_id=? AND author=?").run(
				encodeCanonical(pending),
				scope.objectId,
				scope.author
			);
		else
			configuredStatement(
				database,
				"INSERT INTO lineages (object_id,author,next,exhausted,pending_unsigned) VALUES(?,?,?,0,?)"
			).run(scope.objectId, scope.author, current.next, encodeCanonical(pending));
		bumpRetirement(database, scope.objectId);
	}
	return { ...current, present: true, pendingUnsigned: pending };
}

function bumpRetirement(database: DatabaseSync, objectId: string): void {
	const current = readRetirementControl(database, objectId);
	if (current)
		configuredStatement(database, "UPDATE retirement_controls SET record=? WHERE object_id=?").run(
			encodeIssuanceRetirementControl(advanceIssuanceRetirementControl(current)),
			objectId
		);
}

import type { LocalSessionLifetime } from "./local-session-lifetime.js";
import { enforceNativeLocalSessionFile, nativeLocalSessionSchemaRows } from "./local-session-lifetime.js";

class NodeIssuanceImplementation {
	readonly #database: DatabaseSync;
	readonly #filename: string;
	readonly #readReservations: SqliteNativeReadReservationOwner;
	readonly #signOperations = new Set<Promise<unknown>>();
	readonly #signReleases = new Set<() => Promise<void>>();
	#closed = false;
	#closePromise?: Promise<void>;
	#poison?: DurableIssuanceContractError;
	#censusLease?: {
		readonly native: Awaited<ReturnType<SqliteNativeReadReservationOwner["acquire"]>>;
		readonly token: object;
		readonly pending: Set<Promise<boolean>>;
		releasing: boolean;
		release(): Promise<void>;
	};
	#censusEnrollment?: {
		readonly leaseToken: object;
		readonly token: object;
		readonly observations: WeakMap<DurableIssuanceRecoveryCensus, Readonly<{
			input: DurableIssuanceRecoveryCensusInput; exactValueBytes: Uint8Array;
		}>>;
	};

	constructor(database: DatabaseSync, filename: string, readonly session?: LocalSessionLifetime) {
		this.#database = database;
		this.#filename = filename;
		this.#readReservations = new SqliteNativeReadReservationOwner(filename, session);
	}

	async acquireNativeReadReservation(
		input: Readonly<{ objectId: string }>
	): ReturnType<SqliteNativeReadReservationOwner["acquire"]> {
		this.#assertAvailable();
		captureIssuanceRetirementObject(input);
		const native = await this.#readReservations.acquire();
		const pending = new Set<Promise<boolean>>(), token = Object.freeze({});
		let terminal: Promise<void> | undefined;
		const lease = {native, pending, token, releasing: false, release: (): Promise<void> => {
			// Revoke before the first await. Escaping probes retain tokens only,
			// never an observation, its encoded image, or this native lease.
			lease.releasing = true;
			if (this.#censusEnrollment?.leaseToken === token) this.#censusEnrollment = undefined;
			return terminal ??= Promise.allSettled([...pending]).then(async () => {
				try { await native.release(); }
				finally { if (this.#censusLease === lease) this.#censusLease = undefined; }
			});
		}};
		this.#censusLease = lease;
		try {
			this.#assertAvailable();
			return Object.freeze({check: () => lease.releasing
				? Promise.reject(new Error("NATIVE_READ_RESERVATION_RELEASED")) : native.check(), release: lease.release});
		} catch (primary) {
			try { await lease.release(); }
			catch (cleanup) { throw new AggregateError([primary, cleanup], "native issuance read acquisition cleanup failed", {cause: primary}); }
			throw primary;
		}
	}
	// Native point capture is synchronous; the Promise port retains rejected argument/native failures.
	// eslint-disable-next-line @typescript-eslint/require-await
	async readBoundedRecoveryCensus(input: unknown): Promise<DurableIssuanceRecoveryCensus> {
		this.#assertAvailable();
		this.#censusEnrollment = undefined;
		const captured = captureDurableIssuanceRecoveryCensusInput(input);
		let began = false;
		try {
			this.#database.exec("BEGIN");
			began = true;
			const rows = retirementRows(this.#database, captured.objectId, captured.limits);
			const image = issuanceRetirementImage(rows, captured.objectId);
			const control = readRetirementControl(this.#database, captured.objectId);
			if (image.logicalBytes > captured.limits.maxBytes)
				throw issuanceRetirementRefusal("issuance recovery census exceeds byte entitlement");
			this.#database.exec("COMMIT");
			began = false;
			this.#assertAvailable();
			const observation = { rows, image, control }, lease = this.#censusLease;
			if (lease !== undefined && !lease.releasing && this.#readReservations.current() === lease.native) {
				// The original complete native read above has validated every row,
				// preimage, plan and issued/outbox pair. Enrollment is optional DATA
				// correspondence for this exact held writer exclusion, not authority.
				try {
					const observations = new WeakMap<DurableIssuanceRecoveryCensus, Readonly<{
						input: DurableIssuanceRecoveryCensusInput; exactValueBytes: Uint8Array;
					}>>();
					observations.set(observation, {input: captured, exactValueBytes: encodeCanonical(observation)});
					this.#censusEnrollment = {leaseToken: lease.token, token: Object.freeze({}), observations};
				} catch { /* Optional capture cannot narrow the original full read. */ }
			}
			return observation;
		} finally {
			if (began) {
				try {
					this.#database.exec("ROLLBACK");
				} catch {
					/* Preserve source failure. */
				}
			}
		}
	}

	captureRecoveryCensusCurrentProbe(input: DurableIssuanceRecoveryCensusInput,
		observation: DurableIssuanceRecoveryCensus): DurableIssuanceRecoveryCensusCurrentProbe | undefined {
		this.#assertAvailable();
		const basis = this.#censusEnrollment, lease = this.#censusLease;
		if (basis === undefined || lease === undefined || lease.releasing || basis.leaseToken !== lease.token ||
			this.#readReservations.current() !== lease.native) return undefined;
		const enrolled = basis.observations.get(observation);
		if (enrolled === undefined) return undefined;
		try {
			const captured = captureDurableIssuanceRecoveryCensusInput(input);
			if (captured.objectId !== enrolled.input.objectId || captured.limits.maxRows !== enrolled.input.limits.maxRows ||
				captured.limits.maxBytes !== enrolled.input.limits.maxBytes ||
				!isClosedDurableIssuanceRecord(observation, ["rows", "image", "control"]) ||
				!issuanceRetirementBytesEqual(encodeCanonical(observation), enrolled.exactValueBytes) ||
				this.#censusEnrollment !== basis || this.#censusLease !== lease || lease.releasing ||
				this.#readReservations.current() !== lease.native) return undefined;
		} catch { return undefined; }
		basis.observations.delete(observation);
		return this.#createCensusCurrentProbe(lease.token, basis.token);
	}

	#createCensusCurrentProbe(leaseToken: object, imageToken: object): DurableIssuanceRecoveryCensusCurrentProbe {
		const implementation = this;
		const probe: DurableIssuanceRecoveryCensusCurrentProbe = Object.freeze({
			checkCurrent: function (this: DurableIssuanceRecoveryCensusCurrentProbe): Promise<boolean> {
				if (this !== probe) return Promise.reject(invalid("native census probe is foreign"));
				return implementation.#checkCensusCurrent(leaseToken, imageToken);
			},
		});
		return probe;
	}

	#checkCensusCurrent(leaseToken: object, imageToken: object): Promise<boolean> {
		const lease = this.#censusLease;
		const task = Promise.resolve().then(async () => {
			this.#assertAvailable();
			if (lease === undefined || lease.releasing || lease.token !== leaseToken ||
				this.#censusEnrollment?.token !== imageToken || this.#readReservations.current() !== lease.native) return false;
			try {
				await lease.native.check();
				this.#assertAvailable();
				return this.#censusLease === lease && !lease.releasing && this.#censusEnrollment?.token === imageToken &&
					this.#readReservations.current() === lease.native;
			} catch (cause) { this.#censusEnrollment = undefined; throw cause; }
		});
		lease?.pending.add(task); this.#signOperations.add(task);
		void task.then(() => {lease?.pending.delete(task); this.#signOperations.delete(task);},
			() => {lease?.pending.delete(task); this.#signOperations.delete(task);});
		return task;
	}

	withNativeSignAdmission(input: unknown, sign: () => Promise<Uint8Array>): Promise<Uint8Array> {
		const operation = this.session ? this.session.run(() => this.#withNativeSignAdmission(input, sign)) : this.#withNativeSignAdmission(input, sign);
		this.#signOperations.add(operation);
		void operation.then(
			() => this.#signOperations.delete(operation),
			() => this.#signOperations.delete(operation)
		);
		return operation;
	}
	// Promise rejection and synchronous native admission precede callback entry.
	// eslint-disable-next-line @typescript-eslint/require-await
	async #withNativeSignAdmission(input: unknown, sign: () => Promise<Uint8Array>): Promise<Uint8Array> {
		this.#assertAvailable();
		const captured = captureIssuanceNativeSignInput(input);
		this.session?.assertOwnedAuthor(captured.scope.author);
		if (typeof sign !== "function") throw invalid("native sign continuation must be a function");
		// WAL readers do not exclude native writers. This real BEGIN IMMEDIATE
		// holds SQLite's writer reservation but changes no row/schema/control.
		const releaseLocal = this.session?.reserveNativeHandle();
		let acquired: DatabaseSync | undefined;
		try { acquired = new DatabaseSync(this.#filename, {
			allowExtension: false,
			enableDoubleQuotedStringLiterals: false,
			enableForeignKeyConstraints: false,
		}); enforceNativeLocalSessionFile(acquired, this.#filename, this.session, false); } catch (primary) {
			try { acquired?.close(); } catch (cleanup) { this.session?.fail(cleanup); throw new AggregateError([primary, cleanup], "native sign acquisition and native close failed", { cause: primary }); }
			try { releaseLocal?.(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "native sign acquisition and local release failed", { cause: primary }); }
			throw primary;
		}
		const database = acquired;
		let released = false,
			began = false;
		let releasePromise: Promise<void> | undefined;
		const release = (): Promise<void> =>
			(releasePromise ??= new Promise<void>((resolve, reject) => {
				released = true;
				const failures: unknown[] = [];
				if (began)
					try {
						database.exec("ROLLBACK");
					} catch (error) {
						failures.push(error);
					}
				try {
					database.close();
				} catch (error) {
					failures.push(error);
				}
				this.#signReleases.delete(release);
				if (!failures.length) try { releaseLocal?.(); } catch (cause) { failures.push(cause); }
				if (failures.length === 1) reject(failures[0]);
				else if (failures.length)
					reject(new AggregateError(failures, "native sign reservation release failed", { cause: failures[0] }));
				else resolve();
			}));
		this.#signReleases.add(release);
		// Native BEGIN/check happen synchronously before the original crypto task.
		return joinIssuanceNativeSign(
			// eslint-disable-next-line @typescript-eslint/require-await
			async () => {
				this.#assertAvailable();
				if (released) throw issuanceRetirementRefusal("native sign reservation released");
				if (!began) {
					database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT}`);
					database.exec("BEGIN IMMEDIATE");
					began = true;
					if (scalar(database, "PRAGMA user_version") !== SCHEMA_VERSION || !catalogMatches(catalog(database)))
						throw unsupported("native sign schema changed");
				}
				const lineage = readNativeLineage(database, captured.scope, "writer");
				if (!lineage || lineage.exhausted || lineage.next !== captured.sequence)
					throw issuanceRetirementRefusal("native sign lineage changed");
				assertRetirementRow(database, captured.scope, captured.sequence, captured.bytes, captured.digest);
			},
			release,
			() => this.session ? this.session.withOwnedOperationSigning(captured.digest, sign) : sign()
		);
	}

	// Async preserves promise rejection for input/native failures.
	// eslint-disable-next-line @typescript-eslint/require-await
	async acquireRetirementControl(input: { readonly objectId: string }): Promise<DurableIssuanceRetirementControlRead> {
		this.#assertAvailable();
		const objectId = captureIssuanceRetirementObject(input);
		let snapshot = this.#retirementSnapshot(objectId);
		if (snapshot.control === null) {
			const incarnation = issuanceRetirementHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
			const born: DurableIssuanceRetirementControl = {
				kind: "v3-issuance-retirement-control-1",
				objectId,
				incarnation,
				revision: 0,
				sequence: 0,
				active: null,
				completed: null,
			};
			let began = false;
			try {
				this.#database.exec("BEGIN IMMEDIATE");
				began = true;
				const currentRows = retirementRows(this.#database, objectId);
				if (
					readRetirementControl(this.#database, objectId) !== null ||
					issuanceRetirementImage(currentRows, objectId).imageDigest !== snapshot.image.imageDigest
				)
					throw issuanceRetirementRefusal("issuance retirement birth stale");
				configuredStatement(this.#database, "INSERT INTO retirement_controls(object_id,record) VALUES(?,?)").run(
					objectId,
					encodeIssuanceRetirementControl(born)
				);
				this.#database.exec("COMMIT");
				began = false;
			} catch (error) {
				if (began) {
					try {
						this.#database.exec("ROLLBACK");
					} catch {
						/* Preserve first error. */
					}
				}
				const observed = this.#retirementSnapshot(objectId);
				if (
					!observed.control ||
					!issuanceRetirementBytesEqual(
						encodeIssuanceRetirementControl(observed.control),
						encodeIssuanceRetirementControl(born)
					) ||
					observed.image.imageDigest !== snapshot.image.imageDigest
				)
					throw error;
			}
			snapshot = this.#retirementSnapshot(objectId);
		}
		const control = snapshot.control as DurableIssuanceRetirementControl;
		const captured = snapshot.image;
		// Native SQLite CAS is synchronous; the capability keeps async delivery.
		// eslint-disable-next-line @typescript-eslint/require-await
		return createIssuanceRetirementControlRead(control, captured, async (next, p) => {
			this.#assertAvailable();
			const expectedRows = issuanceRetirementTransitionRows(control, next, snapshot.rows);
			const expectedImage = issuanceRetirementImage(expectedRows, objectId);
			let began = false;
			let primary: unknown;
			try {
				this.#database.exec("BEGIN IMMEDIATE");
				began = true;
				const current = readRetirementControl(this.#database, objectId);
				const rows = retirementRows(this.#database, objectId);
				if (
					!current ||
					!issuanceRetirementBytesEqual(
						encodeIssuanceRetirementControl(current),
						encodeIssuanceRetirementControl(control)
					) ||
					issuanceRetirementImage(rows, objectId).imageDigest !== captured.imageDigest
				)
					throw issuanceRetirementRefusal("issuance retirement source stale");
				if (p) assertIssuanceRetirementPreparationRows(current, p, rows);
				const targetRows = issuanceRetirementTransitionRows(current, next, rows);
				if (issuanceRetirementImage(targetRows, objectId).imageDigest !== expectedImage.imageDigest)
					throw issuanceRetirementRefusal("issuance retirement target stale");
				for (let index = 0; index < rows.plans.length; index++) {
					const before = rows.plans[index]!, after = targetRows.plans[index]!;
					if (after === before) continue;
					const written = configuredStatement(
						this.#database,
						"UPDATE settlement_plans SET revision=?,fence_sequence=?,entries_json=? WHERE object_id=? AND author=? AND revision=?"
					).run(
						after.revision,
						after.fenceSequence,
						settlementPlanEntriesJson(after),
						after.scope.objectId,
						after.scope.author,
						before.revision
					);
					if (written.changes !== 1) throw issuanceRetirementRefusal("issuance retirement plan CAS stale");
				}
				configuredStatement(this.#database, "UPDATE retirement_controls SET record=? WHERE object_id=?").run(
					encodeIssuanceRetirementControl(next),
					objectId
				);
				this.#database.exec("COMMIT");
				began = false;
			} catch (error) {
				primary = error;
				if (began) {
					try {
						this.#database.exec("ROLLBACK");
					} catch {
						/* Readback owns ambiguity. */
					}
				}
			}
			let observed: {
				rows: IssuanceRetirementRows;
				image: ReturnType<typeof issuanceRetirementImage>;
				control: DurableIssuanceRetirementControl | null;
			};
			try {
				observed = this.#retirementSnapshot(objectId);
			} catch {
				throw new DurableIssuanceContractError("ISSUANCE_OUTCOME_UNKNOWN", "issuance retirement outcome unknown");
			}
			if (
				observed.control &&
				issuanceRetirementBytesEqual(
					encodeIssuanceRetirementControl(observed.control),
					encodeIssuanceRetirementControl(next)
				) &&
				observed.image.imageDigest === expectedImage.imageDigest
			)
				return observed.control;
			if (
				observed.control &&
				issuanceRetirementBytesEqual(
					encodeIssuanceRetirementControl(observed.control),
					encodeIssuanceRetirementControl(control)
				) &&
				observed.image.imageDigest === captured.imageDigest
			)
				throw primary === undefined
					? issuanceRetirementRefusal("issuance retirement unchanged")
					: mapSubstrate(primary, "issuance retirement transition failed");
			throw primary instanceof DurableIssuanceContractError || primary instanceof DurableIssuanceInvalidArgumentError
				? primary
				: new DurableIssuanceContractError("ISSUANCE_OUTCOME_UNKNOWN", "issuance retirement readback ambiguous");
		});
	}
	#retirementSnapshot(objectId: string): {
		rows: IssuanceRetirementRows;
		image: ReturnType<typeof issuanceRetirementImage>;
		control: DurableIssuanceRetirementControl | null;
	} {
		this.#assertAvailable();
		let began = false;
		try {
			this.#database.exec("BEGIN");
			began = true;
			const rows = retirementRows(this.#database, objectId);
			const image = issuanceRetirementImage(rows, objectId);
			const control = readRetirementControl(this.#database, objectId);
			this.#database.exec("COMMIT");
			began = false;
			return { rows, image, control };
		} finally {
			if (began) {
				try {
					this.#database.exec("ROLLBACK");
				} catch {
					/* Preserve source failure. */
				}
			}
		}
	}

	close(): Promise<void> {
		if (this.#closePromise !== undefined) return this.#closePromise;
		this.#closed = true;
		this.#censusEnrollment = undefined;
		this.#readReservations.revoke();
		try {
			this.#database.close();
		} catch {
			// Close is an idempotent, non-rejecting capability operation.
		}
		const releases = Array.from(this.#signReleases);
		const readJoined = this.session || this.#censusLease === undefined
			? this.#readReservations.close()
			: this.#censusLease.release().then(() => this.#readReservations.close());
		// Revoke admission now; exclusion outlives already-entered crypto.
		this.#closePromise = Promise.allSettled(this.#signOperations).then(async () => {
			const joined = await Promise.allSettled([readJoined, ...releases.map((release) => release())]);
			const failures = joined
				.filter((r): r is PromiseRejectedResult => r.status === "rejected")
				.map((r) => r.reason as unknown);
			if (failures.length === 1) throw failures[0];
			if (failures.length) throw new AggregateError(failures, "native sign close failed", { cause: failures[0] });
		});
		return this.#closePromise;
	}

	// Async is intentional: input and availability failures are Promise rejections.
	// eslint-disable-next-line @typescript-eslint/require-await
	async compareAndMarkOutboxPublished(input: DurableOutboxPublicationTransitionInput): Promise<void> {
		this.#assertAvailable();
		const captured = this.#capturePublicationInput(input);
		let began = false;
		let committing = false;
		try {
			this.#database.exec("BEGIN IMMEDIATE");
			began = true;
			const observation = this.#queryTerminal(captured.scope, captured.authorSequence);
			const status = this.#publicationStatus(observation, captured);
			if (observation.issuedRecord)
				assertRetirementRow(
					this.#database,
					captured.scope,
					captured.authorSequence,
					observation.issuedRecord.envelope.canonicalPreimageBytes,
					observation.issuedRecord.envelope.digest
				);
			if (status === "never-issued") {
				this.#database.exec("ROLLBACK");
				began = false;
				throw invalid("publication address has never been issued");
			}
			if (status === "pruned") {
				this.#database.exec("ROLLBACK");
				began = false;
				throw createDurableIssuanceRecordPrunedError(captured.scope, captured.authorSequence);
			}
			if (status === "foreign-digest") {
				this.#database.exec("ROLLBACK");
				began = false;
				throw invalid("publication digest does not identify the issued closure");
			}
			if (status === "corrupt") throw this.#latchCorruption("publication closure is incomplete or malformed");
			const expiryPlan = readSettlementPlanRow(this.#database, captured.scope);
			if (expiryPlan === undefined) throw this.#latchCorruption("stored settlement plan is malformed");
			assertSettlementExpiryPublicationExclusive(expiryPlan, [{authorSequence: captured.authorSequence, publishState: "published"}]);
			if (status === "pending") {
				const changes = configuredStatement(
					this.#database,
					"UPDATE issuance_outbox SET publish_state = 'published' WHERE object_id=? AND author=? AND author_sequence=? AND digest=? AND publish_state = 'pending'"
				).run(captured.scope.objectId, captured.scope.author, captured.authorSequence, captured.digest).changes;
				if (changes !== 1) throw this.#latchCorruption("publication update changed an impossible row count");
			}
			bumpRetirement(this.#database, captured.scope.objectId);
			committing = true;
			this.#database.exec("COMMIT");
			began = false;
			committing = false;
		} catch (error) {
			if (began || committing) {
				try {
					this.#database.exec("ROLLBACK");
				} catch {
					// Preserve the publication failure.
				}
			}
			if (committing) return this.#classifyPublicationReadback(captured, "ambiguous");
			if (error === this.#poison) throw error;
			if (error instanceof DurableIssuanceInvalidArgumentError) throw error;
			throw mapSubstrate(error, "publication write failed");
		}
		return this.#classifyPublicationReadback(captured, "success");
	}

	// Async is intentional: all capability failures are Promise rejections.
	// eslint-disable-next-line @typescript-eslint/require-await
	async readLineage(scope: DurableIssueScope): Promise<DurableLineage> {
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		const detached = copyDurableIssueScope(scope);
		try {
			const lineage = readNativeLineage(this.#database, detached);
			if (lineage === undefined) throw this.#latchCorruption("stored lineage is malformed");
			return { exhausted: lineage.exhausted, next: lineage.next };
		} catch (error) {
			throw this.#mapOperationError(error, "lineage read failed");
		}
	}

	// Async is intentional: all capability failures are Promise rejections.
	// eslint-disable-next-line @typescript-eslint/require-await
	async readIssued(scope: DurableIssueScope, authorSequence: number): Promise<DurableIssueCommit | null> {
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		if (!isValidDurableAuthorSequence(authorSequence)) throw invalid("authorSequence must be a safe ordinal");
		const detached = copyDurableIssueScope(scope);
		let observation: TerminalReadback;
		try {
			observation = this.#readTerminal(detached, authorSequence);
		} catch (error) {
			throw this.#mapOperationError(error, "issued-record read failed");
		}
		if (observation.issuedRecord === null && observation.outboxRecord === null) {
			if (
				durableIssuanceLineageConsumed(observation.lineage, authorSequence) &&
				!durableIssuanceAddressIsPruned(observation.prunedThroughAuthorSequence, authorSequence)
			) {
				throw this.#latchCorruption("consumed issued closure is absent above the pruning watermark");
			}
			return null;
		}
		if (
			observation.issuedRecord === null ||
			observation.outboxRecord === null ||
			observation.issuedRecord.authorSequence !== authorSequence ||
			observation.outboxRecord.authorSequence !== authorSequence ||
			!bytesEqual(observation.issuedRecord.envelope.digest, observation.outboxRecord.digest) ||
			!durableIssuanceLineageConsumed(observation.lineage, authorSequence) ||
			durableIssuanceAddressIsPruned(observation.prunedThroughAuthorSequence, authorSequence)
		) {
			throw this.#latchCorruption("stored issued closure is incomplete or malformed");
		}
		return cloneDurableIssueCommit({
			authorSequence,
			envelope: observation.issuedRecord.envelope,
			issuedRecord: observation.issuedRecord,
			outboxEntry: observation.issuedRecord,
		});
	}

	// Async is intentional: all capability failures are Promise rejections.
	// eslint-disable-next-line @typescript-eslint/require-await
	async readSettlementPlan(scope: DurableIssueScope): Promise<SettlementPlan | null> {
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		const detached = copyDurableIssueScope(scope);
		try {
			const plan = readSettlementPlanRow(this.#database, detached);
			if (plan === undefined) throw this.#latchCorruption("stored settlement plan is malformed");
			return plan === null ? null : cloneSettlementPlan(plan);
		} catch (error) {
			throw this.#mapOperationError(error, "settlement plan read failed");
		}
	}

	transactWriteSettlementPlan(input: unknown): Promise<SettlementPlan> {
		let captured: ReturnType<typeof captureSettlementPlanWriteInput>;
		try {
			captured = captureSettlementPlanWriteInput(input);
			this.session?.assertOwnedAuthor(captured.scope.author);
			this.#assertAvailable();
		} catch (error) {
			return Promise.reject(error);
		}
		let began = false;
		try {
			this.#database.exec("BEGIN IMMEDIATE");
			began = true;
			const current = readSettlementPlanRow(this.#database, captured.scope);
			if (current === undefined) throw this.#latchCorruption("stored settlement plan is malformed");
			if ((current?.revision ?? null) !== captured.expectedRevision) {
				throw failure("ISSUANCE_RETRY_REQUIRED", "settlement plan revision changed");
			}
			assertSettlementPlanProgressTransition(current, captured.plan);
			assertSettlementExpiryPublicationExclusive(
				captured.plan,
				captured.plan.entries
					.filter((entry) => entry.sourceObjectId === undefined && settlementEntryIsAuthenticatedExpiry(entry))
					.flatMap((entry) => {
						const row = configuredStatement(
							this.#database,
							"SELECT publish_state FROM issuance_outbox WHERE object_id=? AND author=? AND author_sequence=?"
						).get(captured.scope.objectId, captured.scope.author, entry.sourceSequence);
						const state = row === undefined ? undefined : Reflect.get(row, "publish_state");
						if (row !== undefined && state !== "pending" && state !== "published")
							throw this.#latchCorruption("stored outbox publication state is malformed");
						return state === undefined
							? []
							: [{ authorSequence: entry.sourceSequence, publishState: state as "pending" | "published" }];
					})
			);
			const retired = readRetirementControl(this.#database, captured.scope.objectId);
			if (retired)
				assertIssuanceRetirementPlanAllowed(
					retired,
					captured.plan,
					retirementRows(this.#database, captured.scope.objectId)
				);
			const changes =
				current === null
					? configuredStatement(
							this.#database,
							"INSERT INTO settlement_plans (object_id,author,revision,fence_sequence,entries_json) VALUES(?,?,?,?,?)"
						).run(
							captured.scope.objectId,
							captured.scope.author,
							captured.plan.revision,
							captured.plan.fenceSequence,
							settlementPlanEntriesJson(captured.plan)
						).changes
					: configuredStatement(
							this.#database,
							"UPDATE settlement_plans SET revision=?,fence_sequence=?,entries_json=? WHERE object_id=? AND author=? AND revision=?"
						).run(
							captured.plan.revision,
							captured.plan.fenceSequence,
							settlementPlanEntriesJson(captured.plan),
							captured.scope.objectId,
							captured.scope.author,
							captured.expectedRevision
						).changes;
			if (changes !== 1) throw this.#latchCorruption("settlement plan CAS changed an impossible row count");
			bumpRetirement(this.#database, captured.scope.objectId);
			this.#database.exec("COMMIT");
			began = false;
			return Promise.resolve(cloneSettlementPlan(captured.plan));
		} catch (error) {
			if (began) {
				try {
					this.#database.exec("ROLLBACK");
				} catch {
					// Preserve the settlement plan failure.
				}
			}
			return Promise.reject(this.#mapOperationError(error, "settlement plan write failed"));
		}
	}

	// Async is intentional: all capability failures are Promise rejections.
	// eslint-disable-next-line @typescript-eslint/require-await
	async readOutboxPage(input: DurableOutboxPageInput = {}): Promise<readonly DurableIssuanceOutboxRecord[]> {
		this.#assertAvailable();
		const parsed = this.#parsePageInput(input);
		try {
			this.#database.exec("BEGIN");
			const lineageRows = iterateSqliteRows(
				statement(this.#database, "SELECT object_id,author,next,exhausted,pruned_through_author_sequence FROM lineages")
			);
			// Even unused foreign lineages remain part of global validation.
			for (const raw of lineageRows) {
				const row = copyLineageRow(raw);
				if (row === undefined) throw this.#latchCorruption("stored lineage is malformed");
			}
			const issuedRows = iterateSqliteRows(
				statement(
					this.#database,
					"SELECT i.object_id,i.author,i.author_sequence,i.canonical_preimage,i.digest,i.signature," +
						"o.digest AS outbox_digest,o.publish_state,l.next AS lineage_next,l.exhausted AS lineage_exhausted," +
						"l.pruned_through_author_sequence AS lineage_watermark FROM issued_records AS i " +
						"LEFT JOIN issuance_outbox AS o ON o.object_id=i.object_id AND o.author=i.author AND o.author_sequence=i.author_sequence " +
						"LEFT JOIN lineages AS l ON l.object_id=i.object_id AND l.author=i.author"
				)
			);
			const records: { issued: NativeIssuedRow; publishState: "pending" | "published" }[] = [];
			for (const raw of issuedRows) {
				const issued = copyIssuedRow(raw);
				if (issued === undefined) throw this.#latchCorruption("stored issued record is malformed");
				const row = copyOutboxRow({
					object_id: raw.object_id,
					author: raw.author,
					author_sequence: raw.author_sequence,
					digest: raw.outbox_digest,
					publish_state: raw.publish_state,
				});
				if (row === undefined) throw this.#latchCorruption("stored outbox row is malformed");
				if (!bytesEqual(issued.digest, row.digest)) {
					throw this.#latchCorruption("outbox has no matching issued record");
				}
				const lineage = copyLineageRow({
					object_id: raw.object_id,
					author: raw.author,
					next: raw.lineage_next,
					exhausted: raw.lineage_exhausted,
					pruned_through_author_sequence: raw.lineage_watermark,
				});
				if (
					lineage === undefined ||
					!durableIssuanceLineageConsumed(lineage, row.authorSequence) ||
					durableIssuanceAddressIsPruned(lineage.prunedThroughAuthorSequence, row.authorSequence)
				) {
					throw this.#latchCorruption("stored outbox closure was not consumed by lineage");
				}
				const key = this.#issuedKey(issued);
				if (
					(parsed.scope !== undefined && !this.#sameScope(issued, parsed.scope)) ||
					(parsed.afterKey !== null && compareDurableIssuanceCompoundKeys(key, parsed.afterKey) <= 0)
				)
					continue;
				// SQLite BINARY order is not the shared UTF-16 order. Select the
				// smallest requested page without retaining or sorting all history.
				let low = 0,
					high = records.length;
				while (low < high) {
					const middle = Math.floor((low + high) / 2);
					const prior = records[middle];
					if (prior === undefined) throw new Error("outbox page selection changed");
					if (compareDurableIssuanceCompoundKeys(this.#issuedKey(prior.issued), key) < 0) low = middle + 1;
					else high = middle;
				}
				if (low < parsed.limit) {
					records.splice(low, 0, { issued, publishState: row.publishState });
					if (records.length > parsed.limit) records.pop();
				}
			}
			const orphan = configuredStatement(
				this.#database,
				"SELECT o.object_id FROM issuance_outbox AS o LEFT JOIN issued_records AS i " +
					"ON i.object_id=o.object_id AND i.author=o.author AND i.author_sequence=o.author_sequence " +
					"WHERE i.object_id IS NULL LIMIT 1"
			).get();
			if (orphan !== undefined) throw this.#latchCorruption("outbox has no matching issued record");
			this.#database.exec("COMMIT");
			return records.map(({ issued, publishState }) => ({
				commit: cloneDurableIssueCommit(issuedCommit(issued)),
				publishState,
			}));
		} catch (error) {
			try {
				this.#database.exec("ROLLBACK");
			} catch {
				// Preserve the read failure.
			}
			throw this.#mapOperationError(error, "outbox read failed");
		}
	}

	transactIssue(scope: DurableIssueScope, buildAndSign: DurableBuildAndSign): Promise<DurableIssueCommit> {
		this.session?.assertCurrent();
		this.session?.assertOwnedAuthor(scope.author);
		// Install the outer job before any native hook can invoke a signer or
		// reenter close. An arbitrary builder that never enters the hook is not
		// admitted native work and retains the original nonjoining contract.
		let resolveJob!: (value: DurableIssueCommit) => void;
		let rejectJob!: (cause: unknown) => void;
		const operation = new Promise<DurableIssueCommit>((resolve, reject) => {
			resolveJob = resolve;
			rejectJob = reject;
		});
		// #transactIssue retains the original synchronous callback entry schedule;
		// the deferred handle already exists if native entry reenters close.
		let finishSession: (() => void) | undefined;
		const running = this.#transactIssue(scope, buildAndSign, () => {
			finishSession ??= this.session?.enter();
			this.#signOperations.add(operation);
		});
		void running.then(
			(value) => { finishSession?.(); resolveJob(value); },
			(primary: unknown) => { finishSession?.(); rejectJob(primary); }
		);
		void operation.then(
			() => this.#signOperations.delete(operation),
			() => this.#signOperations.delete(operation)
		);
		return operation;
	}

	async #transactIssue(
		scope: DurableIssueScope,
		buildAndSign: DurableBuildAndSign,
		enter: () => void
	): Promise<DurableIssueCommit> {
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		if (typeof buildAndSign !== "function") throw invalid("buildAndSign must be a function");
		const detached = copyDurableIssueScope(scope);
		let prior: NativeLineage;
		try {
			const observed = readNativeLineage(this.#database, detached);
			if (observed === undefined) throw this.#latchCorruption("stored lineage is malformed");
			prior = observed;
		} catch (error) {
			throw this.#mapOperationError(error, "lineage selection failed");
		}
		if (prior.exhausted) throw failure("ISSUANCE_EXHAUSTED", "author sequence is exhausted");
		let database: DatabaseSync | undefined;
		let admitted: ReturnType<typeof captureIssuanceNativeSignInput> | undefined;
		let hookEnded = false;
		let signing: Promise<Uint8Array> | undefined;
		let cryptoEntered = false;
		let inheritedEntered = prior.pendingUnsigned?.phase === "entered";
		let ownedPending: DurableIssuancePendingUnsignedIntent | undefined;
		let primaryFailed = false;
		let primary: unknown;
		try {
			const nativeSignAdmission: NonNullable<Parameters<DurableBuildAndSign>[1]> = (bytes, sign, context) => {
				this.#assertAvailable();
				if (hookEnded || admitted !== undefined) throw invalid("native issue sign admission is one-use");
				const captured = captureIssuanceNativeSignInput({ scope: detached, exactCanonicalUnsignedVertexBytes: bytes });
				const capturedContext = captureIssuanceNativeSignContext(context);
				if (captured.sequence !== prior.next || typeof sign !== "function")
					throw invalid("native issue sign input changed");
				enter();
				admitted = captured;
				database = new DatabaseSync(this.#filename, {
					allowExtension: false,
					enableDoubleQuotedStringLiterals: false,
					enableForeignKeyConstraints: false,
				});
				enforceNativeLocalSessionFile(database, this.#filename, this.session, false);
				database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT}`);
				database.exec("PRAGMA synchronous=FULL");
				registerRetirementConnection(database);
				database.exec("BEGIN IMMEDIATE");
				verifyAuthority(database);
				const current = readNativeLineage(database, detached, "writer");
				inheritedEntered ||= current?.pendingUnsigned?.phase === "entered";
				let quoteCurrency =
					capturedContext?.expectedIssuanceImageDigest === undefined
						? undefined
						: {
								imageDigest: capturedContext.expectedIssuanceImageDigest,
								controlBytes: capturedContext.expectedIssuanceControlBytes ?? null,
							};
				let ordinaryRows: IssuanceRetirementRows | undefined;
				let ordinaryDataVersion: number | undefined;
				let ordinaryTotalChanges: number | undefined;
				const dataVersion = (): number => {
					const row = configuredStatement(database as DatabaseSync, "PRAGMA main.data_version").get();
					if (typeof row?.data_version !== "number" || !Number.isSafeInteger(row.data_version) || row.data_version < 0)
						throw issuanceRetirementRefusal("native issuance data version is unavailable");
					return row.data_version;
				};
				const totalChanges = (): number => {
					const row = configuredStatement(database as DatabaseSync, "SELECT total_changes() AS changes").get();
					if (typeof row?.changes !== "number" || !Number.isSafeInteger(row.changes) || row.changes < 0)
						throw issuanceRetirementRefusal("native issuance change count is unavailable");
					return row.changes;
				};
				const readQuoteCurrency = (): NonNullable<typeof quoteCurrency> => {
					const rows = retirementRows(database as DatabaseSync, detached.objectId);
					const image = issuanceRetirementImage(rows, detached.objectId);
					if (capturedContext?.planEffect === undefined && rows.plans.length === 0) {
						ordinaryRows = rows;
						ordinaryDataVersion = dataVersion();
						ordinaryTotalChanges = totalChanges();
					}
					const control = readRetirementControlRecord(database as DatabaseSync, detached.objectId);
					return {
						imageDigest: image.imageDigest,
						controlBytes: control === null ? null : control.bytes,
					};
				};
				const checkQuoteCurrency = (): void => {
					if (quoteCurrency === undefined) return;
					// Compare only this writer connection's values. SQLite changes
					// data_version for commits by ANY other connection, not for this
					// connection's own commits. Each point is under BEGIN IMMEDIATE;
					// no callback can mutate this private connection between phases.
					if (ordinaryDataVersion !== undefined) {
						if (dataVersion() !== ordinaryDataVersion || totalChanges() !== ordinaryTotalChanges)
							throw issuanceRetirementRefusal("native issuance quote currency changed");
						const bytes = readRetirementControlRecord(database as DatabaseSync, detached.objectId)?.bytes ?? null;
						if (bytes === null ? quoteCurrency.controlBytes !== null : quoteCurrency.controlBytes === null ||
							!issuanceRetirementBytesEqual(bytes, quoteCurrency.controlBytes))
							throw issuanceRetirementRefusal("native issuance quote control changed");
						return;
					}
					const actual = readQuoteCurrency();
					if (
						actual.imageDigest !== quoteCurrency.imageDigest ||
						(actual.controlBytes === null
							? quoteCurrency.controlBytes !== null
							: quoteCurrency.controlBytes === null ||
								!issuanceRetirementBytesEqual(actual.controlBytes, quoteCurrency.controlBytes))
					)
						throw issuanceRetirementRefusal("native issuance quote currency changed");
				};
				const retainOwnQuotePostimage = (ownChanges: number): void => {
					if (quoteCurrency === undefined) return;
					if (ordinaryDataVersion === undefined) { quoteCurrency = readQuoteCurrency(); return; }
					if (dataVersion() !== ordinaryDataVersion || ordinaryTotalChanges === undefined ||
						!Number.isSafeInteger(ordinaryTotalChanges + ownChanges) || totalChanges() !== ordinaryTotalChanges + ownChanges)
						throw issuanceRetirementRefusal("native issuance quote currency changed");
					ordinaryTotalChanges += ownChanges;
					const control = readRetirementControlRecord(database as DatabaseSync, detached.objectId);
					quoteCurrency = {...quoteCurrency, controlBytes: control === null ? null : control.bytes};
				};
				checkQuoteCurrency();
				if (!current || !sameLineage(current, prior) || current.exhausted)
					throw issuanceRetirementRefusal("native sign lineage changed");
				// Quote currency is checked above, not persisted as unsigned identity.
				const reservedChanges = Number(quoteCurrency?.controlBytes === null) + (current.pendingUnsigned === undefined ? 2 : 0);
				prior = reserveUnsignedIntent(
					database,
					detached,
					captured,
					capturedContext?.planEffect === undefined ? undefined : { planEffect: capturedContext.planEffect },
					ordinaryRows
				);
				ownedPending = prior.pendingUnsigned;
				// Carry only this writer's exact own postimage across each COMMIT/BEGIN
				// gap. A foreign author/control change cannot inherit the old quote.
				retainOwnQuotePostimage(reservedChanges);
				// A provisional ordinal is durable before any crypto. No signature or
				// eligibility is inferred from this mechanical native intent.
				database.exec("COMMIT");
				database.exec("BEGIN IMMEDIATE");
				this.#assertAvailable();
				const reserved = readNativeLineage(database, detached, "writer");
				// A foreign SAME-intent retry may enter crypto (or consume this
				// ordinal) in the prior writer gap. Record that uncertainty before
				// a stale quote can fail; local callback count is not cancellation.
				inheritedEntered ||=
					reserved?.pendingUnsigned?.phase === "entered" ||
					(reserved !== undefined &&
						(reserved.next > captured.sequence || (reserved.exhausted && reserved.next === captured.sequence)));
				checkQuoteCurrency();
				if (
					reserved?.pendingUnsigned === undefined ||
					!ownedPending ||
					!issuanceRetirementBytesEqual(encodeCanonical(reserved.pendingUnsigned), encodeCanonical(ownedPending))
				)
					throw issuanceRetirementRefusal("native unsigned reservation changed");
				const enteringChanges = ownedPending.phase !== "entered" ? 2 : 0;
				if (ownedPending.phase !== "entered") {
					ownedPending = { ...ownedPending, phase: "entered" };
					configuredStatement(database, "UPDATE lineages SET pending_unsigned=? WHERE object_id=? AND author=?").run(
						encodeCanonical(ownedPending),
						detached.objectId,
						detached.author
					);
					bumpRetirement(database, detached.objectId);
				}
				retainOwnQuotePostimage(enteringChanges);
				database.exec("COMMIT"); // entered marker survives an escaped signature
				database.exec("BEGIN IMMEDIATE");
				checkQuoteCurrency();
				const entered = readNativeLineage(database, detached, "writer");
				if (
					entered?.pendingUnsigned === undefined ||
					!issuanceRetirementBytesEqual(encodeCanonical(entered.pendingUnsigned), encodeCanonical(ownedPending)) ||
					readRetirementControl(database, detached.objectId)?.incarnation !== ownedPending.incarnation
				)
					throw issuanceRetirementRefusal("native unsigned entered source changed");
				if (ordinaryRows === undefined)
					issuanceUnsignedPostimageCharge(retirementRows(database, detached.objectId), detached, ownedPending);
				// The ordinary bound was proved from the complete entry image before
				// reserve. Fresh version/control and exact own-lineage checks above
				// establish that only the already-sized phases have occurred.
				assertRetirementRow(database, detached, captured.sequence, captured.bytes, captured.digest);
				// Keep this exact writer connection until builder, commit and original
				// terminal observation join; do not roll back merely when crypto returns.
				signing = Promise.resolve()
					.then(() => {
						this.#assertAvailable();
						cryptoEntered = true;
						// This fresh path has the same exact native entered intent and
						// joined writer custody as resume admission above. Enter its
						// exact digest turn before the owned signer checks admission.
						return this.session ? this.session.withOwnedOperationSigning(captured.digest, sign) : sign();
					})
					.then((signature) => {
						this.#assertAvailable();
						if (!(signature instanceof Uint8Array) || signature.byteLength !== 64)
							throw invalid("native registered signature is malformed");
						return signature;
					});
				// The builder may ignore the returned promise. Track and handle the
				// entire admitted chain, including validation/close refusal, while
				// retaining its rejection for the original job's await/finally join.
				void signing.catch(() => undefined);
				return signing;
			};
			const built = await buildAndSign(prior.next, nativeSignAdmission);
			hookEnded = true;
			if (signing !== undefined) await signing;
			const candidate = copyAndValidateDurableIssueCommit(built, detached, prior.next);
			this.#assertAvailable();
			if (
				admitted !== undefined &&
				(!issuanceRetirementBytesEqual(candidate.envelope.canonicalPreimageBytes, admitted.bytes) ||
					!issuanceRetirementBytesEqual(candidate.envelope.digest, admitted.digest))
			)
				throw invalid("native issue candidate differs from admitted unsigned bytes");
			return this.#commitCandidate(detached, prior, candidate, database, database !== undefined);
		} catch (error) {
			primaryFailed = true;
			// A committed/inherited entered marker is uncertainty even when this
			// attempt has not invoked crypto. Preserve its original refusal cause.
			const enteredUncertainty = cryptoEntered || inheritedEntered || ownedPending?.phase === "entered";
			primary =
				enteredUncertainty &&
				!this.#closed &&
				error !== this.#poison &&
				!this.#hasCode(error, "ISSUANCE_OUTCOME_UNKNOWN")
					? new DurableIssuanceUnknownOutcomeError(detached, { cause: error })
					: error;
			throw primary;
		} finally {
			hookEnded = true;
			// Even a builder that throws without awaiting its signer cannot cause
			// close to release native exclusion before entered crypto joins.
			if (signing !== undefined) await signing.catch(() => undefined);
			if (database !== undefined) {
				let cleanup: unknown;
				try {
					try {
						database.exec("ROLLBACK");
					} catch {
						/* terminal may already have joined */
					}
					// Only this original job's knowledge that crypto NEVER entered can
					// cancel the exact durable intent. Entered OLD remains cold debt.
					// A foreign process may have entered the SAME intent between the
					// marker COMMIT and this writer BEGIN. Local no-entry cannot cancel
					// an entered marker; only the still-reserved intent is definitive.
					if (!cryptoEntered && !inheritedEntered && ownedPending?.phase === "reserved") {
						database.exec("BEGIN IMMEDIATE");
						const actual = readNativeLineage(database, detached, "writer")?.pendingUnsigned;
						if (
							actual !== undefined &&
							issuanceRetirementBytesEqual(encodeCanonical(actual), encodeCanonical(ownedPending))
						) {
							configuredStatement(database, "UPDATE lineages SET pending_unsigned=NULL WHERE object_id=? AND author=?").run(
								detached.objectId,
								detached.author
							);
							bumpRetirement(database, detached.objectId);
						}
						database.exec("COMMIT");
					}
				} catch (error) {
					cleanup = error;
				}
				try {
					database.close();
				} catch (error) {
					cleanup = cleanup === undefined ? error : new AggregateError([cleanup, error], "native issue release failed");
				}
				if (cleanup !== undefined)
					throw primaryFailed
						? new AggregateError([primary, cleanup], "native issue and release failed", { cause: primary })
						: cleanup;
			}
		}
	}

	async inspectPruningState(scope: DurableIssueScope): Promise<DurableIssuancePruningState> {
		await Promise.resolve();
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		const detached = copyDurableIssueScope(scope);
		try {
			this.#database.exec("BEGIN");
			const lineage = readNativeLineage(this.#database, detached, "writer");
			if (lineage === undefined) throw this.#latchCorruption("stored lineage is malformed");
			this.#database.exec("COMMIT");
			return createDurableIssuancePruningState(
				detached,
				{ exhausted: lineage.exhausted, next: lineage.next },
				lineage.prunedThroughAuthorSequence
			);
		} catch (error) {
			try {
				this.#database.exec("ROLLBACK");
			} catch {
				// Preserve the inspection failure.
			}
			throw this.#mapOperationError(error, "pruning-state inspection failed");
		}
	}

	pruneAuthenticatedSettledPrefix(input: unknown): Promise<DurableIssuancePruningReceipt> {
		return this.#prunePrefix(input, true);
	}

	prunePublishedPrefix(input: unknown): Promise<DurableIssuancePruningReceipt> {
		return this.#prunePrefix(input, false);
	}

	#prunePrefix(input: unknown, authenticatedSettled: boolean): Promise<DurableIssuancePruningReceipt> {
		let captured: ReturnType<typeof captureDurableIssuancePruningInput>;
		try {
			captured = captureDurableIssuancePruningInput(input);
			this.#assertAvailable();
		} catch (error) {
			return Promise.reject(error);
		}
		let began = false;
		try {
			this.#database.exec("BEGIN IMMEDIATE");
			began = true;
			const current = readNativeLineage(this.#database, captured.scope, "writer");
			if (current?.pendingUnsigned !== undefined)
				throw issuanceRetirementRefusal("issuance pruning has unresolved unsigned intent");
			if (current === undefined) throw this.#latchCorruption("stored lineage is malformed");
			const lineage = { exhausted: current.exhausted, next: current.next };
			let plan: SettlementPlan | null | undefined;
			if (authenticatedSettled) {
				plan = readSettlementPlanRow(this.#database, captured.scope);
				if (plan === undefined) throw this.#latchCorruption("stored settlement plan is malformed");
				if (!settlementPlanPermitsAuthenticatedPruning(plan)) {
					throw failure("ISSUANCE_RETRY_REQUIRED", "settlement plan is incomplete");
				}
			}
			if (
				captured.expectedPrunedThroughAuthorSequence !== null &&
				(captured.expectedPrunedThroughAuthorSequence > captured.throughAuthorSequence ||
					!durableIssuanceLineageConsumed(captured.expectedLineage, captured.expectedPrunedThroughAuthorSequence))
			) {
				throw invalid("expected pruning state is internally impossible");
			}
			if (
				current.prunedThroughAuthorSequence === captured.throughAuthorSequence &&
				durableIssuanceLineagesEqual(lineage, captured.expectedLineage)
			) {
				this.#database.exec("COMMIT");
				began = false;
				return Promise.resolve(createDurableIssuancePruningReceipt(captured, lineage, null));
			}
			if (
				current.prunedThroughAuthorSequence !== captured.expectedPrunedThroughAuthorSequence ||
				!durableIssuanceLineagesEqual(lineage, captured.expectedLineage)
			) {
				throw failure("ISSUANCE_RETRY_REQUIRED", "issuance pruning state changed");
			}
			if (
				(current.prunedThroughAuthorSequence !== null &&
					captured.throughAuthorSequence <= current.prunedThroughAuthorSequence) ||
				!durableIssuanceLineageConsumed(lineage, captured.throughAuthorSequence)
			) {
				throw invalid("selected pruning boundary is invalid");
			}
			const from = current.prunedThroughAuthorSequence === null ? 0 : current.prunedThroughAuthorSequence + 1;
			assertIssuanceRetirementPruningAllowed(
				readRetirementControl(this.#database, captured.scope.objectId),
				captured.scope,
				from,
				captured.throughAuthorSequence
			);
			assertIssuanceInheritedTargetPruningAllowed(
				retirementRows(this.#database, captured.scope.objectId).plans,
				captured.scope,
				from,
				captured.throughAuthorSequence
			);
			if (!authenticatedSettled) {
				plan = readSettlementPlanRow(this.#database, captured.scope);
				if (plan === undefined) throw this.#latchCorruption("stored settlement plan is malformed");
			}
			if (
				!authenticatedSettled &&
				plan?.entries.some(
					(entry) =>
						entry.replacementSequence === null &&
						entry.sourceSequence >= from &&
						entry.sourceSequence <= captured.throughAuthorSequence
				)
			) {
				throw failure("ISSUANCE_RETRY_REQUIRED", "settlement plan still references the selected prefix");
			}
			for (let pageFrom = from; pageFrom <= captured.throughAuthorSequence; pageFrom += 64) {
				const pageThrough = Math.min(captured.throughAuthorSequence, pageFrom + 63);
				const issuedRows = configuredStatement(
					this.#database,
					"SELECT object_id,author,author_sequence,canonical_preimage,digest,signature FROM issued_records WHERE object_id=? AND author=? AND author_sequence BETWEEN ? AND ? ORDER BY author_sequence"
				).all(captured.scope.objectId, captured.scope.author, pageFrom, pageThrough);
				const outboxRows = configuredStatement(
					this.#database,
					"SELECT object_id,author,author_sequence,digest,publish_state FROM issuance_outbox WHERE object_id=? AND author=? AND author_sequence BETWEEN ? AND ? ORDER BY author_sequence"
				).all(captured.scope.objectId, captured.scope.author, pageFrom, pageThrough);
				const expectedCount = pageThrough - pageFrom + 1;
				if (issuedRows.length !== expectedCount || outboxRows.length !== expectedCount) {
					throw this.#latchCorruption("selected issuance prefix is incomplete");
				}
				for (let index = 0; index < expectedCount; index += 1) {
					const authorSequence = pageFrom + index;
					const issued = copyIssuedRow(issuedRows[index]);
					const outbox = copyOutboxRow(outboxRows[index]);
					if (
						issued === undefined ||
						outbox === undefined ||
						issued.authorSequence !== authorSequence ||
						outbox.authorSequence !== authorSequence ||
						!bytesEqual(issued.digest, outbox.digest)
					) {
						throw this.#latchCorruption("selected issuance prefix is malformed");
					}
					const decoded = decodeDurableIssuancePreimage(issued.canonicalPreimageBytes, captured.scope, authorSequence);
					if (decoded === undefined) throw this.#latchCorruption("selected issuance preimage is malformed");
					if (
						(authenticatedSettled && decoded.epoch > captured.closedEpoch) ||
						(!authenticatedSettled && decoded.epoch !== captured.closedEpoch)
					) {
						throw invalid("selected issuance row belongs to another epoch");
					}
					if (!authenticatedSettled && outbox.publishState === "pending") {
						throw failure("ISSUANCE_RETRY_REQUIRED", "selected issuance prefix is not published");
					}
				}
			}
			const issuedChanges = configuredStatement(
				this.#database,
				"DELETE FROM issued_records WHERE object_id=? AND author=? AND author_sequence BETWEEN ? AND ?"
			).run(captured.scope.objectId, captured.scope.author, from, captured.throughAuthorSequence).changes;
			if (issuedChanges !== captured.throughAuthorSequence - from + 1) {
				throw this.#latchCorruption("issued deletion changed an impossible row count");
			}
			const outboxChanges = configuredStatement(
				this.#database,
				"DELETE FROM issuance_outbox WHERE object_id=? AND author=? AND author_sequence BETWEEN ? AND ?"
			).run(captured.scope.objectId, captured.scope.author, from, captured.throughAuthorSequence).changes;
			if (outboxChanges !== captured.throughAuthorSequence - from + 1) {
				throw this.#latchCorruption("outbox deletion changed an impossible row count");
			}
			const watermarkChanges = configuredStatement(
				this.#database,
				"UPDATE lineages SET pruned_through_author_sequence=? WHERE object_id=? AND author=? AND next=? AND exhausted=? AND ((pruned_through_author_sequence IS NULL AND ? IS NULL) OR pruned_through_author_sequence=?)"
			).run(
				captured.throughAuthorSequence,
				captured.scope.objectId,
				captured.scope.author,
				lineage.next,
				lineage.exhausted ? 1 : 0,
				current.prunedThroughAuthorSequence,
				current.prunedThroughAuthorSequence
			).changes;
			if (watermarkChanges !== 1) {
				throw this.#latchCorruption("watermark update changed an impossible row count");
			}
			bumpRetirement(this.#database, captured.scope.objectId);
			this.#database.exec("COMMIT");
			began = false;
			return Promise.resolve(createDurableIssuancePruningReceipt(captured, lineage, from));
		} catch (error) {
			if (began) {
				try {
					this.#database.exec("ROLLBACK");
				} catch {
					// Preserve the pruning failure.
				}
			}
			return Promise.reject(this.#mapOperationError(error, "issuance pruning failed"));
		}
	}

	#commitCandidate(
		scope: DurableIssueScope,
		prior: NativeLineage,
		candidate: DurableIssueCommit,
		database = this.#database,
		alreadyBegan = false
	): DurableIssueCommit {
		let began = alreadyBegan;
		let committing = false;
		let expectedPlan: SettlementPlan | undefined;
		try {
			if (!alreadyBegan) database.exec("BEGIN IMMEDIATE");
			began = true;
			const current = readNativeLineage(database, scope, "writer");
			assertRetirementRow(
				database,
				scope,
				candidate.authorSequence,
				candidate.envelope.canonicalPreimageBytes,
				candidate.envelope.digest
			);
			if (current?.pendingUnsigned !== undefined) {
				const pending = current.pendingUnsigned;
				if (
					pending.incarnation !== readRetirementControl(database, scope.objectId)?.incarnation ||
					!issuanceRetirementBytesEqual(
						encodeCanonical(pending.planEffect ?? null),
						encodeCanonical(candidate.planEffect ?? null)
					)
				)
					throw issuanceRetirementRefusal("issuance unsigned settlement or incarnation changed");
				if (
					pending.planEffect !== undefined &&
					!issuanceRetirementBytesEqual(
						encodeCanonical(readSettlementPlanRow(database, scope)),
						pending.exactCanonicalPlanBytes!
					)
				)
					throw issuanceRetirementRefusal("issuance unsigned settlement source changed");
			}
			if (current === undefined) throw this.#latchCorruption("stored lineage is malformed");
			if (!sameLineage(current, prior) || current.exhausted || candidate.authorSequence !== current.next) {
				database.exec("ROLLBACK");
				began = false;
				throw failure("ISSUANCE_RETRY_REQUIRED", "author sequence changed while signing");
			}
			if (candidate.planEffect !== undefined) {
				const plan = readSettlementPlanRow(database, scope);
				if (plan === undefined) throw this.#latchCorruption("stored settlement plan is malformed");
				if (plan === null) throw failure("ISSUANCE_RETRY_REQUIRED", "settlement plan is absent");
				const updated = applySettlementPlanEffect(
					plan,
					candidate.planEffect,
					candidate.authorSequence,
					settlementReplacementLastLogicalTime(candidate)
				);
				expectedPlan = updated;
				const planChanges = configuredStatement(
					database,
					"UPDATE settlement_plans SET revision=?,fence_sequence=?,entries_json=? WHERE object_id=? AND author=? AND revision=?"
				).run(
					updated.revision,
					updated.fenceSequence,
					settlementPlanEntriesJson(updated),
					scope.objectId,
					scope.author,
					plan.revision
				).changes;
				if (planChanges !== 1) throw this.#latchCorruption("settlement plan effect changed an impossible row count");
			}
			const exhausted = prior.next === Number.MAX_SAFE_INTEGER;
			const next = exhausted ? prior.next : prior.next + 1;
			let lineageChanges: number | bigint;
			if (!prior.present) {
				lineageChanges = configuredStatement(
					database,
					"INSERT INTO lineages (object_id,author,next,exhausted) VALUES(?,?,?,?)"
				).run(scope.objectId, scope.author, next, exhausted ? 1 : 0).changes;
			} else {
				lineageChanges = configuredStatement(
					database,
					"UPDATE lineages SET next=?,exhausted=?,pending_unsigned=NULL WHERE object_id=? AND author=? AND next=? AND exhausted=?"
				).run(next, exhausted ? 1 : 0, scope.objectId, scope.author, prior.next, prior.exhausted ? 1 : 0).changes;
			}
			if (lineageChanges !== 1) throw this.#latchCorruption("lineage CAS changed an impossible row count");
			const issuedChanges = configuredStatement(
				database,
				"INSERT INTO issued_records (object_id,author,author_sequence,canonical_preimage,digest,signature) VALUES(?,?,?,?,?,?)"
			).run(
				scope.objectId,
				scope.author,
				candidate.authorSequence,
				candidate.envelope.canonicalPreimageBytes,
				candidate.envelope.digest,
				candidate.envelope.signature
			).changes;
			if (issuedChanges !== 1) throw this.#latchCorruption("issued insert changed an impossible row count");
			const outboxChanges = configuredStatement(
				database,
				"INSERT INTO issuance_outbox (object_id,author,author_sequence,digest,publish_state) VALUES(?,?,?,?,?)"
			).run(scope.objectId, scope.author, candidate.authorSequence, candidate.envelope.digest, "pending").changes;
			if (outboxChanges !== 1) throw this.#latchCorruption("outbox insert changed an impossible row count");
			if (expectedPlan !== undefined) {
				const retired = readRetirementControl(database, scope.objectId);
				if (retired)
					assertIssuanceRetirementPlanAllowed(retired, expectedPlan, retirementRows(database, scope.objectId));
			}
			bumpRetirement(database, scope.objectId);
			committing = true;
			database.exec("COMMIT");
			began = false;
			committing = false;
		} catch (error) {
			if (began || committing) {
				try {
					database.exec("ROLLBACK");
				} catch {
					// Preserve the mutation failure.
				}
			}
			if (committing) return this.#classifyAfterTerminalSuppression(scope, prior, candidate, expectedPlan, database);
			if (error === this.#poison) throw error;
			if (this.#hasCode(error, "ISSUANCE_RETRY_REQUIRED")) throw error;
			if (this.#isConstraint(error)) throw this.#latchCorruption("issuance child-key collision");
			throw mapSubstrate(error, "issuance write failed");
		}
		return this.#classifyAfterTerminalSuppression(scope, prior, candidate, expectedPlan, database);
	}

	#classifyAfterTerminalSuppression(
		scope: DurableIssueScope,
		prior: NativeLineage,
		candidate: DurableIssueCommit,
		expectedPlan?: SettlementPlan,
		database = this.#database
	): DurableIssueCommit {
		const priorLineage = { exhausted: prior.exhausted, next: prior.next };
		let observation: TerminalReadback;
		try {
			observation = this.#readTerminal(scope, candidate.authorSequence, candidate, expectedPlan, database);
		} catch (error) {
			if (error === this.#poison) throw error;
			const committed = classifyDurableIssuanceTerminalSuppression({
				candidate,
				observation: { unreadable: true },
				priorLineage,
				scope,
			});
			return committed;
		}
		try {
			const committed = classifyDurableIssuanceTerminalSuppression({
				candidate,
				observation,
				priorLineage,
				scope,
			});
			return committed;
		} catch (error) {
			if (this.#hasCode(error, "ISSUANCE_RECOVERY_CORRUPT")) {
				throw this.#latchCorruption("terminal issuance readback is corrupt");
			}
			throw error;
		}
	}

	#assertPlanEffectReadback(
		plan: SettlementPlan | null,
		observation: TerminalReadback,
		candidate: DurableIssueCommit,
		expectedPlan?: SettlementPlan
	): void {
		const effect = candidate.planEffect;
		if (effect === undefined) return;
		const linked = settlementPlanHasExactEffectLink(plan, effect, candidate.authorSequence);
		if ((observation.issuedRecord !== null) !== linked) {
			throw this.#latchCorruption("issued row and settlement plan link are inconsistent");
		}
		if (
			linked &&
			(plan === null ||
				expectedPlan === undefined ||
				JSON.stringify(cloneSettlementPlan(plan)) !== JSON.stringify(cloneSettlementPlan(expectedPlan)))
		) {
			throw this.#latchCorruption("settlement plan differs from the committed revision and exact effect");
		}
	}

	#readTerminal(
		scope: DurableIssueScope,
		authorSequence: number,
		candidate?: DurableIssueCommit,
		expectedPlan?: SettlementPlan,
		database = this.#database
	): TerminalReadback {
		database.exec("BEGIN");
		try {
			const observation = this.#queryTerminal(scope, authorSequence, database);
			if (candidate?.planEffect !== undefined) {
				const plan = readSettlementPlanRow(database, scope);
				if (plan === undefined) throw this.#latchCorruption("stored settlement plan is malformed");
				this.#assertPlanEffectReadback(plan, observation, candidate, expectedPlan);
			}
			database.exec("COMMIT");
			return observation;
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the snapshot failure.
			}
			throw error;
		}
	}

	#queryTerminal(scope: DurableIssueScope, authorSequence: number, database = this.#database): TerminalReadback {
		const lineage = readNativeLineage(database, scope, "writer");
		const issuedRaw = configuredStatement(
			database,
			"SELECT object_id,author,author_sequence,canonical_preimage,digest,signature FROM issued_records WHERE object_id=? AND author=? AND author_sequence=?"
		).get(scope.objectId, scope.author, authorSequence);
		const outboxRaw = configuredStatement(
			database,
			"SELECT object_id,author,author_sequence,digest,publish_state FROM issuance_outbox WHERE object_id=? AND author=? AND author_sequence=?"
		).get(scope.objectId, scope.author, authorSequence);
		const issued = issuedRaw === undefined ? null : copyIssuedRow(issuedRaw);
		const outbox = outboxRaw === undefined ? null : copyOutboxRow(outboxRaw);
		if (lineage === undefined || issued === undefined || outbox === undefined) {
			throw this.#latchCorruption("terminal readback contains a malformed row");
		}
		return {
			issuedRecord:
				issued === null
					? null
					: {
							authorSequence: issued.authorSequence,
							envelope: {
								canonicalPreimageBytes: issued.canonicalPreimageBytes,
								digest: issued.digest,
								signature: issued.signature,
							},
							scope: { author: issued.author, objectId: issued.objectId },
						},
			lineage: { exhausted: lineage.exhausted, next: lineage.next },
			outboxRecord:
				outbox === null
					? null
					: {
							authorSequence: outbox.authorSequence,
							digest: outbox.digest,
							publishState: outbox.publishState,
							scope: { author: outbox.author, objectId: outbox.objectId },
						},
			prunedThroughAuthorSequence: lineage.prunedThroughAuthorSequence,
		};
	}

	#capturePublicationInput(input: DurableOutboxPublicationTransitionInput): DurableOutboxPublicationTransitionInput {
		try {
			if (!isClosedDurableIssuanceRecord(input, ["authorSequence", "digest", "scope"])) {
				throw invalid("publication input must be an exact own-data record");
			}
			assertDurableIssueScope(input.scope);
			const scope = copyDurableIssueScope(input.scope);
			if (!isValidDurableAuthorSequence(input.authorSequence)) {
				throw invalid("publication input contains an invalid ordinal");
			}
			const digest = copyDurableIssuanceBytes(input.digest);
			if (digest === undefined) throw invalid("publication input contains an invalid digest");
			return { authorSequence: input.authorSequence, digest, scope };
		} catch (error) {
			if (error instanceof DurableIssuanceInvalidArgumentError) throw error;
			throw invalid("publication input could not be inspected as a closed record");
		}
	}

	#publicationStatus(
		observation: TerminalReadback,
		input: DurableOutboxPublicationTransitionInput
	): "corrupt" | "foreign-digest" | "never-issued" | "pending" | "pruned" | "published" {
		const { issuedRecord, lineage, outboxRecord, prunedThroughAuthorSequence } = observation;
		const consumed = durableIssuanceLineageConsumed(lineage, input.authorSequence);
		if (issuedRecord === null && outboxRecord === null && !consumed) return "never-issued";
		if (
			issuedRecord === null &&
			outboxRecord === null &&
			consumed &&
			durableIssuanceAddressIsPruned(prunedThroughAuthorSequence, input.authorSequence)
		) {
			return "pruned";
		}
		if (issuedRecord === null || outboxRecord === null || !consumed) return "corrupt";
		if (durableIssuanceAddressIsPruned(prunedThroughAuthorSequence, input.authorSequence)) return "corrupt";
		if (
			issuedRecord.authorSequence !== input.authorSequence ||
			outboxRecord.authorSequence !== input.authorSequence ||
			!this.#sameScope(issuedRecord.scope, input.scope) ||
			!this.#sameScope(outboxRecord.scope, input.scope) ||
			!bytesEqual(issuedRecord.envelope.digest, outboxRecord.digest) ||
			!durablePreimageMatchesScopeAndSequence(
				issuedRecord.envelope.canonicalPreimageBytes,
				input.scope,
				input.authorSequence
			)
		) {
			return "corrupt";
		}
		if (!bytesEqual(issuedRecord.envelope.digest, input.digest)) return "foreign-digest";
		return outboxRecord.publishState;
	}

	#classifyPublicationReadback(input: DurableOutboxPublicationTransitionInput, commit: "ambiguous" | "success"): void {
		this.#assertAvailable();
		let observation: TerminalReadback;
		try {
			observation = this.#readTerminal(input.scope, input.authorSequence);
		} catch (error) {
			if (error === this.#poison || error instanceof DurableIssuanceContractError) throw error;
			throw new DurableIssuanceUnknownOutcomeError(input.scope);
		}
		this.#assertAvailable();
		const status = this.#publicationStatus(observation, input);
		if (status === "published") return;
		if (status === "pruned") throw createDurableIssuanceRecordPrunedError(input.scope, input.authorSequence);
		if (status === "pending" && commit === "ambiguous") {
			throw createDurableIssuanceFailure(
				"ISSUANCE_SUBSTRATE_FAILURE",
				"publication commit did not become durable",
				"transient"
			);
		}
		throw this.#latchCorruption("publication terminal readback is incomplete or malformed");
	}

	#assertAvailable(): void {
		this.session?.assertCurrent();
		if (this.#poison !== undefined) throw this.#poison;
		if (this.#closed) throw failure("ISSUANCE_STORE_CLOSED", "durable issuance store is closed");
	}

	#latchCorruption(message: string): DurableIssuanceContractError {
		this.#poison ??= Object.freeze(failure("ISSUANCE_RECOVERY_CORRUPT", message));
		return this.#poison;
	}

	#mapOperationError(error: unknown, message: string): Error {
		if (error === this.#poison && this.#poison !== undefined) return this.#poison;
		if (error instanceof DurableIssuanceInvalidArgumentError) return error;
		if (error instanceof DurableIssuanceRecordPrunedError) return error;
		if (error instanceof DurableIssuanceContractError) return error;
		return mapSubstrate(error, message);
	}

	#isConstraint(error: unknown): boolean {
		return errorNumber(error) === 19 || /\bconstraint\b/iu.test(errorText(error));
	}

	#hasCode(error: unknown, code: string): boolean {
		return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
	}

	#parsePageInput(input: DurableOutboxPageInput): {
		afterKey: readonly [string, string, number] | null;
		limit: number;
		scope?: DurableIssueScope;
	} {
		if (!this.#closedPageInput(input)) throw invalid("page input must be a closed record");
		if (input.scope !== undefined) assertDurableIssueScope(input.scope);
		const limit = input.limit === undefined ? DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT : input.limit;
		if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT) {
			throw invalid("page limit is outside the closed range");
		}
		const afterKey = input.afterKey ?? null;
		if (
			afterKey !== null &&
			(!Array.isArray(afterKey) ||
				afterKey.length !== 3 ||
				!isValidDurableScopeField(afterKey[0]) ||
				!isValidDurableScopeField(afterKey[1]) ||
				!isValidDurableAuthorSequence(afterKey[2]))
		) {
			throw invalid("afterKey must be a valid compound key");
		}
		return {
			afterKey: afterKey as readonly [string, string, number] | null,
			limit,
			...(input.scope === undefined ? {} : { scope: copyDurableIssueScope(input.scope) }),
		};
	}

	#closedPageInput(value: unknown): value is DurableOutboxPageInput {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const allowed = ["afterKey", "limit", "scope"];
		return Reflect.ownKeys(value).every((key) => {
			if (typeof key !== "string" || !allowed.includes(key)) return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
		});
	}

	#issuedKey(issued: NativeIssuedRow): readonly [string, string, number] {
		return [issued.objectId, issued.author, issued.authorSequence];
	}

	#sameScope(left: DurableIssueScope, right: DurableIssueScope): boolean {
		return left.author === right.author && left.objectId === right.objectId;
	}
}

const maintenanceByStore = new WeakMap<
	DurableIssuanceStore,
	Readonly<{
		readonly readBoundedRecoveryCensus: DurableIssuanceRecoveryCensusReader;
		inspectPruningState(scope: DurableIssueScope): Promise<DurableIssuancePruningState>;
		pruneAuthenticatedSettledPrefix(input: unknown): Promise<DurableIssuancePruningReceipt>;
		prunePublishedPrefix(input: unknown): Promise<DurableIssuancePruningReceipt>;
	}>
>();

/**
 * Creates one exact Node SQLite issuance capability.
 * @param options - Untrusted exact Node factory options.
 * @returns A frozen plain eight-method facade.
 */
export function createNodeDurableIssuanceStoreImplementation(
	options: unknown,
	session?: LocalSessionLifetime
): DurableIssuanceStore & NodeNativeReadPort {
	const { primaryFilename, initialization } = capturePrimaryFilename(options);
	session?.assertCurrent();
	let database: DatabaseSync;
	try {
		database = new DatabaseSync(sqliteFilename(`${primaryFilename}${DATABASE_SUFFIX}`, initialization), {
			allowExtension: false,
			enableDoubleQuotedStringLiterals: false,
			enableForeignKeyConstraints: false,
			readOnly: false,
		});
	} catch (error) {
		throw mapSubstrate(error, "issuance SQLite authority could not be opened", "permanent");
	}
	try {
		enforceNativeLocalSessionFile(database, `${primaryFilename}${DATABASE_SUFFIX}`, session, initialization !== "reopen");
		registerRetirementConnection(database);
		admit(database, initialization);
		const implementation = new NodeIssuanceImplementation(database, `${primaryFilename}${DATABASE_SUFFIX}`, session);
		let closePromise: Promise<void> | undefined;
		const store = Object.freeze({
			acquireNativeReadReservation: (input: Readonly<{ objectId: string }>) =>
				implementation.acquireNativeReadReservation(input),
			close: (): Promise<void> => closePromise ??= implementation.close().then(() => session?.closedOwner(store)),
			compareAndMarkOutboxPublished: (input: DurableOutboxPublicationTransitionInput) =>
				implementation.compareAndMarkOutboxPublished(input),
			readIssued: (scope: DurableIssueScope, authorSequence: number) =>
				implementation.readIssued(scope, authorSequence),
			readLineage: (scope: DurableIssueScope) => implementation.readLineage(scope),
			readOutboxPage: (input?: DurableOutboxPageInput) => implementation.readOutboxPage(input),
			readSettlementPlan: (scope: DurableIssueScope) => implementation.readSettlementPlan(scope),
			transactIssue: (scope: DurableIssueScope, buildAndSign: DurableBuildAndSign) =>
				implementation.transactIssue(scope, buildAndSign),
			transactWriteSettlementPlan: (input: unknown) => implementation.transactWriteSettlementPlan(input),
		});
		const readBoundedRecoveryCensus: DurableIssuanceRecoveryCensusReader = (input) => implementation.readBoundedRecoveryCensus(input);
		Object.defineProperty(readBoundedRecoveryCensus, "captureCurrentProbe", {value: function (
			this: DurableIssuanceRecoveryCensusReader, input: DurableIssuanceRecoveryCensusInput, observation: DurableIssuanceRecoveryCensus
		) {
			return this === readBoundedRecoveryCensus ? implementation.captureRecoveryCensusCurrentProbe(input, observation) : undefined;
		}});
		Object.freeze(readBoundedRecoveryCensus);
		const maintenance = Object.freeze({
			readBoundedRecoveryCensus,
			readOrdinarySignMaterialByteLength: issuanceUnsignedOwnMaterialByteLength,
			withNativeSignAdmission: (input: unknown, sign: () => Promise<Uint8Array>) =>
				implementation.withNativeSignAdmission(input, sign),
			acquireRetirementControl: (input: { readonly objectId: string }) =>
				implementation.acquireRetirementControl(input),
			inspectPruningState: (scope: DurableIssueScope) => implementation.inspectPruningState(scope),
			pruneAuthenticatedSettledPrefix: (input: unknown) => implementation.pruneAuthenticatedSettledPrefix(input),
			prunePublishedPrefix: (input: unknown) => implementation.prunePublishedPrefix(input),
		});
		maintenanceByStore.set(store, maintenance);
		if (!bindDurableIssuancePruningMaintenance(store, maintenance)) {
			throw new TypeError("node issuance maintenance was already bound");
		}
		return store;
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// Admission may not have an active transaction.
		}
		try {
			database.close();
		} catch {
			// Preserve the admission failure.
		}
		if (error instanceof DurableIssuanceContractError) throw error;
		throw mapSubstrate(error, "issuance SQLite admission failed", "permanent");
	}
}

/**
 * Resolves the private pruning implementation for one exact Node facade.
 * @param store - Candidate ordinary issuance facade.
 * @returns Its private maintenance capability, when identity matches.
 */
export function nodeIssuancePruningMaintenanceForStore(store: DurableIssuanceStore):
	| Readonly<{
			readonly readBoundedRecoveryCensus: DurableIssuanceRecoveryCensusReader;
			inspectPruningState(scope: DurableIssueScope): Promise<DurableIssuancePruningState>;
			pruneAuthenticatedSettledPrefix(input: unknown): Promise<DurableIssuancePruningReceipt>;
			prunePublishedPrefix(input: unknown): Promise<DurableIssuancePruningReceipt>;
	  }>
	| undefined {
	return maintenanceByStore.get(store);
}
