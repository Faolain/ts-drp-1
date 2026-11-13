import {
	advanceJournalRetirementMutationControl,
	type AppendAcceptedVertexInput,
	type AppendAcceptedVertexResult,
	captureJournalRetirementObject,
	captureJournalClosedMembershipInput,
	captureJournalClosedMembershipReadInput,
	captureJournalClosedMembershipObservation,
	type LiveJournalClosedMembershipReadResult,
	journalClosedMembershipCanExtend,
	captureLiveJournalAnchorReadObservation,
	captureLiveJournalHistoricalAnchorImportInput,
	captureLiveJournalInput,
	validateLiveJournalSnapshot,
	captureLiveJournalSignedAnchorReadInput,
	captureLiveJournalSignedAnchorReadObservation,
	captureSourceBoundJournalAppendInput,
	classifyLiveJournalMutationObservation,
	createJournalRetirementControlCodec,
	createJournalRetirementImageCapture,
	createLiveJournalSnapshotValidation,
	decideLiveJournalDuplicate,
	decodeJournalRetirementControl,
	decodeJournalRetirementNativeCarriers,
	encodeJournalRetirementNativeCarriers,
	deriveLiveJournalSnapshot,
	deriveLiveJournalSnapshotReadiness,
	type DurableLiveJournalStore,
	encodeJournalRetirementControl,
	type InstallLiveJournalGenesisInput,
	type InstallLiveJournalGenesisResult,
	journalRetirementAllows,
	journalRetirementCanonicalRow,
	type JournalRetirementDrainRow,
	journalRetirementFrameDigest,
	journalRetirementDrainItemCount,
	journalRetirementImageCountsFit,
	journalRetirementMutationAllows,
	LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES,
	LIVE_JOURNAL_RETIREMENT_LIMITS,
	type LiveJournalAcceptedRow,
	type LiveJournalAnchorReadInput,
	type LiveJournalAnchorReadResult,
	type LiveJournalFailureKind,
	type LiveJournalHistoricalAnchorImportInput,
	type LiveJournalHistoricalAnchorImportResult,
	type LiveJournalPageInput,
	type LiveJournalPageResult,
	type LiveJournalReadinessInput,
	type LiveJournalReadinessResult,
	type LiveJournalRetirementControl,
	type LiveJournalRetirementControlRead,
	type LiveJournalRetirementDrainSource,
	type LiveJournalRetirementImage,
	type LiveJournalRetirementImageObservation,
	type LiveJournalRetirementImageCurrentProbe,
	type LiveJournalRetirementImageReader,
	type LiveJournalRetirementResult,
	type LiveJournalScope,
	type LiveJournalSignedAnchorReadInput,
	type LiveJournalSignedAnchorReadResult,
	type LiveJournalSnapshotToken,
	reconstructJournalRetirementDrainSource,
	createJournalRetirementDrainSourceMemo,
} from "@ts-drp/live-journal";
import { compareBytes, encodeCanonical } from "@ts-drp/canonical";
import type { NativeReadReservation } from "@ts-drp/storage";
import { randomBytes } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { SqliteNativeReadReservationOwner } from "./internal/native-read-reservation.js";
import { iterateSqliteRows } from "./internal/sqlite-iterator.js";
import {
	beginJournalTransaction,
	type JournalImageCurrency,
	journalImageCurrency,
	journalImageRowKey,
	journalImageRowMatches,
	type JournalImageRowKey,
	journalRetirementImageMemo,
} from "./internal/journal-image-memo.js";
import { sqliteFilename } from "./internal/sqlite-filename.js";
import { enforceNativeLocalSessionFile, nativeLocalSessionSchemaRows, type LocalSessionLifetime } from "./internal/local-session-lifetime.js";
import type { NodeNativeReadPort } from "./index.js";
import { configuredStatement, iterationStatement } from "./internal/sqlite-statement-cache.js";

export interface NodeDurableLiveJournalStoreOptions {
	readonly primaryFilename: string;
	readonly initialization?: "create" | "reopen";
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
type VerifiedReplayBasis = Readonly<{
	readonly dataVersion: number;
	readonly scope: StoredScope;
	readonly token: LiveJournalSnapshotToken;
}>;
type ReplayPage = Readonly<{
	readonly afterSequence: number;
	readonly limit: number;
	readonly snapshot: LiveJournalSnapshotToken;
}>;
const UNSTABLE_VERSION = Symbol("unstable-data-version");

function sameNativeControl(left: Uint8Array | null, right: Uint8Array | null): boolean {
	return left === null || right === null
		? left === right
		: left.length === right.length && left.every((value, index) => value === right[index]);
}

const SCOPES_V2_DDL =
	"CREATE TABLE scopes (\n  object_id TEXT NOT NULL,\n  epoch INTEGER NOT NULL,\n  anchor_digest TEXT NOT NULL,\n  next_journal_sequence INTEGER NOT NULL,\n  exact_anchor_preimage BLOB NOT NULL,\n  detached_anchor_signature BLOB NOT NULL,\n  parameters_digest TEXT NOT NULL,\n  exact_parameters_carrier BLOB NOT NULL,\n  PRIMARY KEY (object_id, epoch, anchor_digest)\n) WITHOUT ROWID";
// Exact spelling SQLite preserves after the supported current-v2 ADD COLUMN.
const SCOPES_DDL = SCOPES_V2_DDL.replace(
	"exact_parameters_carrier BLOB NOT NULL,",
	"exact_parameters_carrier BLOB NOT NULL, closed_membership_bytes BLOB,"
);
const ENTRIES_DDL =
	"CREATE TABLE accepted_entries (\n  object_id TEXT NOT NULL,\n  epoch INTEGER NOT NULL,\n  anchor_digest TEXT NOT NULL,\n  journal_sequence INTEGER NOT NULL,\n  source_kind TEXT NOT NULL,\n  vertex_digest TEXT NOT NULL,\n  received_preimage BLOB,\n  received_signature BLOB,\n  local_author TEXT,\n  local_author_sequence INTEGER,\n  PRIMARY KEY (object_id, epoch, anchor_digest, journal_sequence),\n  UNIQUE (object_id, epoch, anchor_digest, vertex_digest),\n  UNIQUE (object_id, epoch, anchor_digest, local_author, local_author_sequence),\n  CHECK (source_kind IN ('received', 'local-issued')),\n  CHECK (\n    (source_kind = 'received' AND received_preimage IS NOT NULL AND received_signature IS NOT NULL AND local_author IS NULL AND local_author_sequence IS NULL)\n    OR\n    (source_kind = 'local-issued' AND received_preimage IS NULL AND received_signature IS NULL AND local_author IS NOT NULL AND local_author_sequence IS NOT NULL)\n  )\n) WITHOUT ROWID";
const RETIREMENT_V3_DDL =
	"CREATE TABLE retirement_controls (object_id TEXT PRIMARY KEY, record BLOB NOT NULL) WITHOUT ROWID";
const RETIREMENT_DDL = RETIREMENT_V3_DDL.replace("record BLOB NOT NULL)", "record BLOB NOT NULL, plan_record BLOB)");
// The native trigger also fences an already-open legacy connection: it cannot
// write without the current owner's connection-local predicate installed.
const RETIREMENT_TRIGGERS = ["accepted_entries", "scopes"]
	.flatMap((table) =>
		["DELETE", "INSERT", "UPDATE"].map((operation) => {
			const name = `retirement_${table}_${operation.toLowerCase()}`;
			const refs = operation === "UPDATE" ? ["OLD", "NEW"] : [operation === "DELETE" ? "OLD" : "NEW"];
			const conditions = refs
				.map((ref) => `journal_retirement_allows(${ref}.object_id,${ref}.epoch,${ref}.anchor_digest)=0`)
				.join(" OR ");
			return {
				name,
				sql: `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} WHEN ${conditions} BEGIN SELECT RAISE(ABORT,'retirement-fenced'); END`,
				tbl_name: table,
				type: "trigger",
			};
		})
	)
	.sort((a, b) => a.name.localeCompare(b.name));
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
	{ name: "retirement_controls", sql: RETIREMENT_DDL, tbl_name: "retirement_controls", type: "table" },
	{ name: "scopes", sql: SCOPES_DDL, tbl_name: "scopes", type: "table" },
	...RETIREMENT_TRIGGERS,
] as const;

function captureOptions(value: unknown): { primaryFilename: string; initialization: "create" | "reopen" } {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("malformed-input");
		const prototype = Object.getPrototypeOf(value);
		const keys = Reflect.ownKeys(value);
		const descriptor = Object.getOwnPropertyDescriptor(value, "primaryFilename");
		if (
			(prototype !== Object.prototype && prototype !== null) ||
			!keys.includes("primaryFilename") ||
			keys.some((key) => key !== "primaryFilename" && key !== "initialization") ||
			descriptor === undefined ||
			!("value" in descriptor) ||
			!descriptor.enumerable ||
			typeof descriptor.value !== "string" ||
			descriptor.value.length === 0 ||
			descriptor.value.includes("\0")
		) {
			throw new TypeError("malformed-input");
		}
		const mode = Object.getOwnPropertyDescriptor(value, "initialization");
		if (
			mode !== undefined &&
			(!("value" in mode) || !mode.enumerable || (mode.value !== "create" && mode.value !== "reopen"))
		)
			throw new TypeError("malformed-input");
		return { primaryFilename: descriptor.value, initialization: mode?.value ?? "create" };
	} catch (error) {
		if (error instanceof TypeError && error.message === "malformed-input") throw error;
		throw new TypeError("malformed-input");
	}
}

/** A readBigInts=false statement for one iterateSqliteRows iteration (exclusively checked out). */
function statement(database: DatabaseSync, sql: string): StatementSync {
	return iterationStatement(database, sql);
}

function scalar(database: DatabaseSync, sql: string): unknown {
	const row = configuredStatement(database, sql).get();
	return row === undefined ? undefined : Object.values(row)[0];
}

function dataVersion(database: DatabaseSync): number {
	const value = scalar(database, "PRAGMA main.data_version");
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("invalid-data-version");
	return value as number;
}

function admit(database: DatabaseSync, initialization: "create" | "reopen" = "create"): void {
	database.exec("PRAGMA busy_timeout=1000");
	database.exec("PRAGMA synchronous=FULL");
	const initial = nativeLocalSessionSchemaRows(
		database,
		configuredStatement(database, "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all()
	);
	const version = scalar(database, "PRAGMA user_version");
	if (initialization === "reopen" && version !== 2 && version !== 3 && version !== 4)
		throw new Error("unsupported-schema");
	const fresh = initial.length === 0 && version === 0;
	const v3Catalog = EXPECTED_CATALOG.map((row) =>
		row.name === "retirement_controls" ? { ...row, sql: RETIREMENT_V3_DDL } : row
	);
	const currentV3 =
		version === 3 &&
		initial.length === v3Catalog.length &&
		initial.every((row, index) => {
			const expected = v3Catalog[index];
			return expected !== undefined && Object.entries(expected).every(([key, value]) => row[key] === value);
		});
	const v2Catalog = v3Catalog.map((row) => (row.name === "scopes" ? { ...row, sql: SCOPES_V2_DDL } : row));
	const currentV2 =
		version === 2 &&
		initial.length === v2Catalog.length &&
		initial.every((row, index) => {
			const expected = v2Catalog[index];
			return expected !== undefined && Object.entries(expected).every(([key, value]) => row[key] === value);
		});
	const legacyCatalog = v2Catalog.filter((row) => row.type !== "trigger" && row.name !== "retirement_controls");
	const legacy =
		version === 1 &&
		initial.length === legacyCatalog.length &&
		initial.every((row, index) => {
			const expected = legacyCatalog[index];
			return expected !== undefined && Object.entries(expected).every(([key, value]) => row[key] === value);
		});
	if (fresh || legacy || currentV2 || currentV3) {
		database.exec("PRAGMA page_size=4096");
		if (String(scalar(database, "PRAGMA journal_mode=WAL")).toLowerCase() !== "wal") {
			throw new Error("durability-unavailable");
		}
		database.exec("BEGIN IMMEDIATE");
		try {
			const locked = nativeLocalSessionSchemaRows(
				database,
				configuredStatement(database, "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all()
			);
			if (scalar(database, "PRAGMA user_version") !== version || JSON.stringify(locked) !== JSON.stringify(initial))
				throw new Error("unsupported-schema");
			if (fresh) {
				database.exec(SCOPES_DDL);
				database.exec(ENTRIES_DDL);
			}
			if (!fresh && !currentV3) database.exec("ALTER TABLE scopes ADD COLUMN closed_membership_bytes BLOB");
			if (currentV2 || currentV3) database.exec("ALTER TABLE retirement_controls ADD COLUMN plan_record BLOB");
			if (!currentV2 && !currentV3) {
				database.exec(RETIREMENT_DDL);
				for (const trigger of RETIREMENT_TRIGGERS) database.exec(trigger.sql);
			}
			if (currentV2 || currentV3) {
				// Finish each bounded point read before rewriting that same WITHOUT ROWID
				// record. An open table iterator can revisit the rewritten payload.
				const old = configuredStatement(
					database,
					"SELECT object_id, CASE WHEN typeof(record)='blob' AND length(record)<=? THEN record ELSE NULL END AS record FROM retirement_controls WHERE object_id>? ORDER BY object_id LIMIT 1"
				);
				let priorObjectId = "";
				for (;;) {
					const row = old.get(LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES, priorObjectId);
					if (row === undefined) break;
					const control = decodeJournalRetirementControl(row.record);
					if (control.objectId !== row.object_id) throw new Error("store-poisoned");
					writeRetirementControl(database, control);
					priorObjectId = control.objectId;
				}
			}
			database.exec("PRAGMA user_version=4");
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
	const catalog = nativeLocalSessionSchemaRows(
		database,
		configuredStatement(database, "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all()
	);
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
		scalar(database, "PRAGMA user_version") !== 4 ||
		scalar(database, "PRAGMA page_size") !== 4096 ||
		String(scalar(database, "PRAGMA journal_mode")).toLowerCase() !== "wal" ||
		scalar(database, "PRAGMA synchronous") !== 2 ||
		scalar(database, "PRAGMA busy_timeout") !== 1000
	) {
		throw new Error("unsupported-schema");
	}
}

function readRetirementNativeCarriers(
	database: DatabaseSync,
	objectId: string
): Readonly<{record: unknown; planRecord: unknown}> | undefined {
	const bounded =
		"typeof(record)='blob' AND length(record)>0 AND (plan_record IS NULL OR (typeof(plan_record)='blob' AND length(plan_record)>0)) AND length(record)+COALESCE(length(plan_record),0)<=?";
	const row = configuredStatement(
		database,
		`SELECT CASE WHEN ${bounded} THEN record ELSE NULL END AS record, CASE WHEN ${bounded} THEN plan_record ELSE NULL END AS plan_record, plan_record IS NOT NULL AS has_plan FROM retirement_controls WHERE object_id=?`
	).get(LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES, LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES, objectId);
	if (row === undefined) return undefined;
	if (row.has_plan === 1 && row.plan_record === null) throw new Error("store-poisoned");
	return {record: row.record, planRecord: row.plan_record === null ? undefined : row.plan_record};
}
function readRetirementControl(
	database: DatabaseSync,
	objectId: string,
	codec?: ReturnType<typeof createJournalRetirementControlCodec>
): LiveJournalRetirementControl | null {
	const row = readRetirementNativeCarriers(database, objectId);
	if (row === undefined) {codec?.clear(); return null;}
	const control = (codec?.decode ?? decodeJournalRetirementNativeCarriers)(
		row.record,
		row.planRecord
	);
	if (control.objectId !== objectId) throw new Error("store-poisoned");
	return control;
}
function writeRetirementControl(database: DatabaseSync, value: LiveJournalRetirementControl): void {
	const carriers = encodeJournalRetirementNativeCarriers(value);
	writeRetirementNativeCarriers(database, value.objectId, carriers);
}
// Only the captured one-use view postimage or the full public encoder above
// supplies these carriers. This is syntax reuse, never a native currency check.
function writeRetirementNativeCarriers(
	database: DatabaseSync,
	objectId: string,
	carriers: Readonly<{controlBytes: Uint8Array; planBytes?: Uint8Array}>
): void {
	configuredStatement(
		database,
		"INSERT INTO retirement_controls(object_id,record,plan_record) VALUES(?,?,?) ON CONFLICT(object_id) DO UPDATE SET record=excluded.record,plan_record=CASE WHEN retirement_controls.plan_record IS excluded.plan_record THEN retirement_controls.plan_record ELSE excluded.plan_record END"
	).run(objectId, carriers.controlBytes, carriers.planBytes ?? null);
}
function sameRetirementNativeCarriers(
	a: ReturnType<typeof encodeJournalRetirementNativeCarriers>,
	b: ReturnType<typeof encodeJournalRetirementNativeCarriers>
): boolean {
	return (
		sameBytes(a.controlBytes, b.controlBytes) &&
		(a.planBytes === undefined || b.planBytes === undefined
			? a.planBytes === b.planBytes
			: sameBytes(a.planBytes, b.planBytes))
	);
}
type JournalMembershipWrite = Readonly<{
	scope: LiveJournalScope;
	bytes: Uint8Array;
	clearScopes: readonly LiveJournalScope[];
}>;
function retirementImage(
	database: DatabaseSync,
	objectId: string,
	frames?: Uint8Array[],
	membershipWrite?: JournalMembershipWrite
): LiveJournalRetirementImage {
	// Read first: it fixes the transaction's snapshot that every row below is read from.
	const currency = membershipWrite === undefined ? journalImageCurrency(database) : undefined,
		memo = journalRetirementImageMemo(database);
	const unchanged = memo.unchanged(objectId, frames !== undefined, currency);
	if (unchanged !== undefined) {
		if (frames !== undefined) for (const frame of unchanged.frames!) frames.push(frame.slice());
		return unchanged.image;
	}
	if (frames !== undefined) return captureRetirementImage(database, objectId, memo, currency, frames, true, membershipWrite);
	// A frameless capture also keeps its rows' frames for a later point read of the same rows (which
	// would otherwise capture and hash every row again). Frames add only their own byte ceiling: a
	// capture refused there is redone exactly as a frameless capture, so it charges and refuses as before.
	try {
		return captureRetirementImage(database, objectId, memo, currency, [], false, membershipWrite);
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "retirement-fenced") throw error;
		return captureRetirementImage(database, objectId, memo, currency, undefined, false, membershipWrite);
	}
}
/**
 * One scan and capture of the object's native rows (see retirementImage).
 * @param frames - Receives the rows' frames, when defined: the caller's, or a private array only the memo keeps.
 * @param framesRequested - Whether the caller requested the frames (a remembered capture must then have them).
 */
function captureRetirementImage(
	database: DatabaseSync,
	objectId: string,
	memo: ReturnType<typeof journalRetirementImageMemo>,
	currency: JournalImageCurrency | undefined,
	frames: Uint8Array[] | undefined,
	framesRequested: boolean,
	membershipWrite: JournalMembershipWrite | undefined
): LiveJournalRetirementImage {
	const count = (table: string): number => {
		const row = configuredStatement(database, `SELECT count(*) AS n FROM ${table} WHERE object_id=?`).get(objectId);
		if (row === undefined || !Number.isSafeInteger(row.n)) throw new Error("store-poisoned");
		return row.n as number;
	};
	if (!journalRetirementImageCountsFit(count("scopes"), count("accepted_entries")))
		throw new Error("retirement-fenced");
	if (
		configuredStatement(
			database,
			"SELECT 1 AS invalid FROM scopes WHERE object_id=? AND closed_membership_bytes IS NOT NULL AND (typeof(closed_membership_bytes)<>'blob' OR length(closed_membership_bytes)=0 OR length(closed_membership_bytes)>?) LIMIT 1"
		).get(objectId, LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes) !== undefined
	)
		throw new Error("retirement-fenced");
	const capture = createJournalRetirementImageCapture();
	// Verify once per exact rows: a remembered image is reused only when every
	// scanned row matches it exactly and in order. Matched rows wait, bounded by
	// that already-charged image, and are captured in their original order as
	// soon as any row differs, so a changed image is charged exactly as before.
	const known = memo.candidate(objectId, framesRequested),
		firstFrame = frames?.length ?? 0,
		keys: JournalImageRowKey[] = [],
		deferred: [table: "scopes" | "accepted_entries", row: Record<string, unknown>, key: unknown[] | undefined][] = [];
	let matching = known !== undefined,
		keyable = true;
	const append = (table: "scopes" | "accepted_entries", row: Record<string, unknown>, key: unknown[] | undefined): void => {
		const frame = capture.append(table, row, key);
		if (frame !== undefined) frames!.push(frame);
	};
	const diverge = (): void => {
		matching = false;
		for (const [table, row, key] of deferred) append(table, row, key);
		deferred.length = 0;
	};
	const collect = (table: "scopes" | "accepted_entries"): void => {
		// Bound native BLOB extraction, then charge each row before retaining the next.
		const columns =
			table === "scopes"
				? "object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier,closed_membership_bytes"
				: "object_id,epoch,anchor_digest,journal_sequence,source_kind,vertex_digest,received_preimage,received_signature,local_author,local_author_sequence";
		const blobs =
			table === "scopes"
				? ["exact_anchor_preimage", "detached_anchor_signature", "exact_parameters_carrier", "closed_membership_bytes"]
				: ["received_preimage", "received_signature"];
		const selected = columns
			.split(",")
			.map((k) =>
				blobs.includes(k)
					? `CASE WHEN ${k} IS NULL OR length(${k})<=${LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes} THEN ${k} ELSE NULL END AS ${k}`
					: k
			)
			.join(",");
		const query = statement(
			database,
			`SELECT ${selected} FROM ${table} WHERE object_id=? ORDER BY epoch,anchor_digest${table === "scopes" ? "" : ",journal_sequence"}`
		);
		for (const row of iterateSqliteRows(query, objectId)) {
			if (
				(table === "scopes" && blobs.filter((k) => k !== "closed_membership_bytes").some((k) => row[k] === null)) ||
				(table !== "scopes" && row.source_kind === "received" && blobs.some((k) => row[k] === null))
			)
				throw new Error("retirement-fenced");
			const captured = { ...row };
			if (table === "scopes" && captured.closed_membership_bytes === null) delete captured.closed_membership_bytes;
			if (table === "scopes" && membershipWrite !== undefined) {
				const matches = (scope: LiveJournalScope): boolean =>
					scope.objectId === captured.object_id &&
					scope.epoch === captured.epoch &&
					scope.anchorDigest === captured.anchor_digest;
				if (membershipWrite.clearScopes.some(matches)) delete captured.closed_membership_bytes;
				if (matches(membershipWrite.scope)) captured.closed_membership_bytes = membershipWrite.bytes;
			}
			let key: unknown[] | undefined;
			if (frames !== undefined) {
				key = [captured.object_id, captured.epoch, captured.anchor_digest];
				if (table !== "scopes") key.push(captured.journal_sequence);
			}
			if (matching) {
				const remembered = known!.rows[keys.length];
				if (remembered !== undefined && journalImageRowMatches(remembered, table, captured)) {
					keys.push(remembered);
					deferred.push([table, captured, key]);
					continue;
				}
				diverge();
			}
			if (keyable) {
				const rowKey = journalImageRowKey(table, captured);
				if (rowKey === undefined) keyable = false;
				else keys.push(rowKey);
			}
			append(table, captured, key);
		}
		// Keep the original StatementSync alive through iterator completion. The
		// iterator alone does not own its statement on the installed Node runtime.
		if (!query.sourceSQL.startsWith("SELECT ")) throw new Error("store-poisoned");
	};
	try {
		collect("scopes");
		collect("accepted_entries");
		if (matching && keys.length === known!.rows.length) {
			memo.touch(objectId, currency);
			if (framesRequested) for (const frame of known!.frames!) frames!.push(frame.slice());
			return known!.image;
		}
		if (matching) diverge();
		const image = capture.finish();
		if (keyable) memo.remember(objectId, keys, image, frames?.slice(firstFrame), currency);
		return image;
	} finally { capture.release(); }
}
function admitJournalMutation(database: DatabaseSync, selected: LiveJournalScope): LiveJournalRetirementControl | null {
	const control = readRetirementControl(database, selected.objectId);
	if (!journalRetirementAllows(control, selected)) throw new Error("retirement-fenced");
	if (control?.revision === Number.MAX_SAFE_INTEGER) throw new Error("retirement-exhausted");
	return control;
}
function advanceJournalMutation(
	database: DatabaseSync,
	control: LiveJournalRetirementControl | null,
	clearCompletedMembership: (scope: LiveJournalScope) => void
): void {
	if (control !== null) {
		if (
			control.drain != null &&
			control.drain.cursor < journalRetirementDrainItemCount(control.drain.plan)
		)
			throw new Error("retirement-fenced");
		if (control.drain != null) {
			for (const prefix of control.drain.plan.prefixes) clearCompletedMembership(prefix.scope);
		}
		writeRetirementControl(database, advanceJournalRetirementMutationControl(control));
	}
}

/** Exact received frame or original SQLite local-row codec for a drained source.
 * The descriptor is not authentication; the original caller reauthenticates it. */
function retirementFrame(selected: JournalRetirementDrainRow): Uint8Array {
	const { scope, row } = selected;
	if (row.exactCanonicalNativeFrameBytes !== undefined) return row.exactCanonicalNativeFrameBytes.slice();
	return journalRetirementCanonicalRow("accepted_entries", [...scopeParameters(scope), row.journalSequence], {
		object_id: scope.objectId,
		epoch: scope.epoch,
		anchor_digest: scope.anchorDigest,
		journal_sequence: row.journalSequence,
		source_kind: "local-issued",
		vertex_digest: row.vertexDigest,
		received_preimage: null,
		received_signature: null,
		local_author: row.author,
		local_author_sequence: row.authorSequence,
	});
}

function validateDrainNativeRows(database: DatabaseSync, control: LiveJournalRetirementControl): void {
	const state = control.drain;
	if (state == null) return;
	let index = 0;
	for (const prefix of state.plan.prefixes) {
		const header = readScope(database, prefix.scope);
		if (header === null || header.nextJournalSequence !== prefix.highWatermark) throw new Error("retirement-stale");
		const removed = Math.max(0, Math.min(prefix.rows.length, state.cursor - index));
		const count = configuredStatement(
			database,
			"SELECT count(*) AS n FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=?"
		).get(...scopeParameters(prefix.scope));
		if (count?.n !== prefix.highWatermark - removed) throw new Error("retirement-stale");
		for (const row of prefix.rows) {
			const selected = { scope: prefix.scope, row };
			const expected = retirementFrame(selected);
			if (journalRetirementFrameDigest(expected) !== row.nativeFrameDigest) throw new Error("retirement-stale");
			const actual = configuredStatement(
				database,
				`SELECT ${ROW_COLUMNS} FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=? AND journal_sequence=?`
			).get(...scopeParameters(prefix.scope), row.journalSequence);
			if (index++ < state.cursor) {
				if (actual !== undefined) throw new Error("retirement-stale");
			} else if (
				actual === undefined ||
				actual.source_kind !== (row.exactCanonicalNativeFrameBytes === undefined ? "local-issued" : "received") ||
				!sameBytes(
					journalRetirementCanonicalRow("accepted_entries", [...scopeParameters(prefix.scope), row.journalSequence], {
						...actual,
					}),
					expected
				)
			)
				throw new Error("retirement-stale");
		}
	}
	for (const selected of state.plan.retiredEmptyHeaders ?? []) {
		const actual = configuredStatement(
			database,
			"SELECT * FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?"
		).get(...scopeParameters(selected.scope));
		if (actual?.closed_membership_bytes === null) delete actual.closed_membership_bytes;
		const count = configuredStatement(
			database,
			"SELECT count(*) AS n FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=?"
		).get(...scopeParameters(selected.scope));
		if (count?.n !== 0) throw new Error("retirement-stale");
		if (index++ < state.cursor) {
			if (actual !== undefined) throw new Error("retirement-stale");
		} else if (actual === undefined || !sameBytes(journalRetirementCanonicalRow("scopes", scopeParameters(selected.scope), { ...actual }), selected.exactCanonicalNativeFrameBytes))
			throw new Error("retirement-stale");
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
	const row = configuredStatement(
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
	const row = configuredStatement(
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

type SignedScopeRead =
	| Readonly<{ readonly ok: true; readonly stored: StoredScope | null }>
	| Extract<LiveJournalSignedAnchorReadResult, { readonly ok: false }>;

function readSignedScope(database: DatabaseSync, input: LiveJournalSignedAnchorReadInput): SignedScopeRead {
	// All physical metadata and every carrier are gated before their projection into JS.
	const row = configuredStatement(
		database,
		`WITH addressed AS (
			SELECT *, typeof(object_id)='text' AND length(CAST(object_id AS BLOB)) BETWEEN 1 AND 4096
				AND typeof(epoch)='integer' AND epoch BETWEEN 0 AND 9007199254740991
				AND typeof(anchor_digest)='text' AND length(anchor_digest)=64 AND length(CAST(anchor_digest AS BLOB))=64
				AND anchor_digest NOT GLOB '*[^0-9a-f]*'
				AND typeof(next_journal_sequence)='integer' AND next_journal_sequence BETWEEN 0 AND 9007199254740991
				AND typeof(parameters_digest)='text' AND length(parameters_digest)=64 AND length(CAST(parameters_digest AS BLOB))=64
				AND parameters_digest NOT GLOB '*[^0-9a-f]*'
				AND typeof(exact_anchor_preimage)='blob' AND length(exact_anchor_preimage) BETWEEN 1 AND 8192
				AND typeof(detached_anchor_signature)='blob' AND length(detached_anchor_signature)=64
				AND typeof(exact_parameters_carrier)='blob' AND length(exact_parameters_carrier) BETWEEN 1 AND 65536 AS physical_valid
			FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?
		), gated AS (
			SELECT *, physical_valid AND length(exact_anchor_preimage)<=8192
				AND length(exact_parameters_carrier)<=65536
				AND length(exact_anchor_preimage)+64+length(exact_parameters_carrier)<=? AS admitted
			FROM addressed
		)
		SELECT CASE WHEN NOT physical_valid THEN 'store-poisoned'
			WHEN NOT admitted THEN 'read-budget-exceeded' ELSE 'present' END AS kind,
			CASE WHEN admitted THEN object_id ELSE NULL END AS object_id,
			CASE WHEN admitted THEN epoch ELSE NULL END AS epoch,
			CASE WHEN admitted THEN anchor_digest ELSE NULL END AS anchor_digest,
			CASE WHEN admitted THEN next_journal_sequence ELSE NULL END AS next_journal_sequence,
			CASE WHEN admitted THEN parameters_digest ELSE NULL END AS parameters_digest,
			CASE WHEN admitted THEN exact_anchor_preimage ELSE NULL END AS exact_anchor_preimage,
			CASE WHEN admitted THEN detached_anchor_signature ELSE NULL END AS detached_anchor_signature,
			CASE WHEN admitted THEN exact_parameters_carrier ELSE NULL END AS exact_parameters_carrier
		FROM gated`
	).get(...scopeParameters(input.scope), input.maxBytes);
	if (row === undefined) return { ok: true, stored: null };
	if (row.kind === "store-poisoned" || row.kind === "read-budget-exceeded") {
		return Object.freeze({ kind: row.kind, ok: false });
	}
	if (row.kind !== "present") return failed("internal-invariant");
	const captured = captureLiveJournalSignedAnchorReadObservation(input, {
		detachedAnchorSignature: row.detached_anchor_signature,
		exactCanonicalAnchorPreimageBytes: row.exact_anchor_preimage,
		exactCanonicalParametersCarrierBytes: row.exact_parameters_carrier,
		nextJournalSequence: row.next_journal_sequence,
		parametersDigest: row.parameters_digest,
		scope: { anchorDigest: row.anchor_digest, epoch: row.epoch, objectId: row.object_id },
	});
	return captured.ok ? { ok: true, stored: captured.value } : captured;
}

type EmptyClosureRead =
	| Readonly<{ readonly ok: true; readonly kind: "empty"; readonly snapshot: DurableSnapshot | null }>
	| Readonly<{ readonly ok: true; readonly kind: "populated" }>
	| Extract<LiveJournalSignedAnchorReadResult, { readonly ok: false }>;

function readEmptyClosure(database: DatabaseSync, input: LiveJournalSignedAnchorReadInput): EmptyClosureRead {
	const scope = readSignedScope(database, input);
	// Probe by complete scope regardless of the physical sequence key's type or value.
	const exists =
		configuredStatement(
			database,
			"SELECT 1 AS present FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=? LIMIT 1"
		).get(...scopeParameters(input.scope)) !== undefined;
	if (!scope.ok) return scope;
	if (scope.stored === null) return exists ? failed("store-poisoned") : { kind: "empty", ok: true, snapshot: null };
	if ((scope.stored.nextJournalSequence === 0) === exists) return failed("store-poisoned");
	if (exists) return { kind: "populated", ok: true };
	const snapshot = captureAddressedClosure({ rows: [], scope: scope.stored });
	return snapshot === undefined ? failed("store-poisoned") : { kind: "empty", ok: true, snapshot };
}

function readEmptyClosureReadonly(database: DatabaseSync, input: LiveJournalSignedAnchorReadInput): EmptyClosureRead {
	database.exec("BEGIN");
	try {
		const result = readEmptyClosure(database, input);
		database.exec("COMMIT");
		return result;
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// A read failure remains unreadable, never proof of an empty closure.
		}
		throw error;
	}
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
	return configuredStatement(
		database,
		"SELECT object_id,epoch,anchor_digest,journal_sequence,source_kind,vertex_digest,received_preimage,received_signature,local_author,local_author_sequence FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=? ORDER BY journal_sequence"
	)
		.all(...scopeParameters(scope))
		.map(rowFromSql);
}

const ROW_COLUMNS =
	"object_id,epoch,anchor_digest,journal_sequence,source_kind,vertex_digest,received_preimage,received_signature,local_author,local_author_sequence";

function readRowBySequence(database: DatabaseSync, scope: LiveJournalScope, journalSequence: number): StoredRow | null {
	const row = configuredStatement(
		database,
		`SELECT ${ROW_COLUMNS} FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=? AND journal_sequence=?`
	).get(...scopeParameters(scope), journalSequence);
	return row === undefined ? null : rowFromSql(row);
}

function readRowByDigest(database: DatabaseSync, scope: LiveJournalScope, vertexDigest: string): StoredRow | undefined {
	const row = configuredStatement(
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
	const row = configuredStatement(
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

type ReplayRead =
	| Readonly<{
			readonly kind: "complete";
			readonly dataVersion: number | undefined;
			readonly snapshot: DurableSnapshot | null | typeof WRONG_SCOPE_SNAPSHOT;
	  }>
	| Readonly<{ readonly kind: "page"; readonly rows: readonly StoredRow[] }>
	| Readonly<{ readonly kind: "ready"; readonly token: LiveJournalSnapshotToken }>
	| typeof UNSTABLE_VERSION;

function sameReplayToken(left: LiveJournalSnapshotToken, right: LiveJournalSnapshotToken): boolean {
	return (
		left.kind === right.kind &&
		left.scope.objectId === right.scope.objectId &&
		left.scope.epoch === right.scope.epoch &&
		left.scope.anchorDigest === right.scope.anchorDigest &&
		left.highWatermark === right.highWatermark &&
		left.genesisDigest === right.genesisDigest &&
		left.parametersDigest === right.parametersDigest &&
		left.orderedRowDigest === right.orderedRowDigest &&
		left.snapshotDigest === right.snapshotDigest
	);
}

function replayScopeFromSql(row: Readonly<Record<string, unknown>>): StoredScope {
	return {
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
	};
}

function readReplaySnapshotReadonly(
	database: DatabaseSync,
	scope: LiveJournalScope,
	codec: ReturnType<typeof createJournalRetirementControlCodec>,
	basis?: VerifiedReplayBasis,
	page?: ReplayPage
): ReplayRead {
	const before = dataVersion(database);
	database.exec("BEGIN");
	try {
		const carriers = readRetirementNativeCarriers(database, scope.objectId);
		if (carriers === undefined) codec.clear();
		else {
			const fence = codec.readFence(carriers.record, carriers.planRecord, scope);
			if (fence.objectId !== scope.objectId) throw new Error("store-poisoned");
			if (!fence.allowed) throw new Error("retirement-fenced");
		}
		const inside = dataVersion(database);
		const reusable =
			basis !== undefined &&
			before === inside &&
			inside === basis.dataVersion &&
			(page !== undefined
				? sameReplayToken(page.snapshot, basis.token)
				: scope.objectId === basis.token.scope.objectId &&
					scope.epoch === basis.token.scope.epoch &&
					scope.anchorDigest === basis.token.scope.anchorDigest &&
					basis.token.highWatermark === basis.scope.nextJournalSequence);
		const row = reusable
			? configuredStatement(
					database,
					"SELECT object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?"
				).get(...scopeParameters(scope))
			: configuredStatement(
					database,
					"SELECT object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier FROM scopes WHERE object_id=? AND epoch=? ORDER BY (anchor_digest=?) DESC LIMIT 1"
				).get(scope.objectId, scope.epoch, scope.anchorDigest);
		const stored =
			reusable && row !== undefined && row.anchor_digest === scope.anchorDigest ? replayScopeFromSql(row) : undefined;
		// This is a reuse of a previously validated complete native closure, not
		// authority from a caller token or from LIMIT alone. Own writers invalidate
		// the basis; foreign commits invalidate SQLite's connection-local version.
		const addressed =
			reusable &&
			stored !== undefined &&
			stored.nextJournalSequence === basis.scope.nextJournalSequence &&
			sameInstalledScope(stored, basis.scope);
		const rows =
			addressed && page !== undefined
				? configuredStatement(
						database,
						`SELECT ${ROW_COLUMNS} FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=? AND journal_sequence>? AND journal_sequence<? ORDER BY journal_sequence LIMIT ?`
					)
						.all(...scopeParameters(scope), page.afterSequence, page.snapshot.highWatermark, page.limit + 1)
						.map(rowFromSql)
				: addressed
					? []
					: readRows(database, scope);
		database.exec("COMMIT");
		// Preserve the original full-reader precedence: requested rows are read
		// and joined before absence/wrong-anchor decisions, and only a selected
		// matching header is copied. Unrelated malformed headers do not own errors.
		if (row === undefined) return { kind: "complete", dataVersion: undefined, snapshot: null };
		if (row.anchor_digest !== scope.anchorDigest) {
			return { kind: "complete", dataVersion: undefined, snapshot: WRONG_SCOPE_SNAPSHOT };
		}
		const completeScope = stored ?? replayScopeFromSql(row);
		const after = dataVersion(database);
		const stable = before === inside && inside === after;
		if (addressed)
			return !stable
				? UNSTABLE_VERSION
				: page === undefined
					? { kind: "ready", token: basis!.token }
					: { kind: "page", rows };
		return {
			kind: "complete",
			dataVersion: stable ? after : undefined,
			snapshot: { rows, scope: completeScope },
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

function captureAddressedClosure(
	snapshot: DurableSnapshot,
	validation?: ReturnType<typeof createLiveJournalSnapshotValidation>
): DurableSnapshot | undefined {
	try {
		const captured = validateLiveJournalSnapshot({ durable: snapshot, validation } as never);
		if (captured.ok !== true) return undefined;
		// Only this adapter's fresh private native row/header captures reach
		// this function. Shared validation returns no borrowed rows or token.
		return snapshot;
	} catch {
		return undefined;
	}
}

/**
 * Creates the strict Node live-journal capability.
 * @param options - Exact primary SQLite filename options.
 * @returns The strict live-journal capability.
 */
export function createNodeDurableLiveJournalStore(
	options: NodeDurableLiveJournalStoreOptions,
	session?: LocalSessionLifetime
): DurableLiveJournalStore & NodeNativeReadPort {
	const { primaryFilename: filename, initialization } = captureOptions(options);
	const retirementCodec = createJournalRetirementControlCodec();
	session?.assertCurrent();
	const database = new DatabaseSync(sqliteFilename(`${filename}.drp-live-journal-v1.sqlite`, initialization), {
		allowExtension: false,
		enableDoubleQuotedStringLiterals: false,
		enableForeignKeyConstraints: false,
		readOnly: false,
	});
	// Only fixed synchronous detail DELETEs and completed-prefix membership
	// UPDATEs may cross the permanent scope fence. No callback/await or untrusted
	// SQL runs while this gate is set; other connections retain their denying predicate.
	let deletingScope: LiveJournalScope | undefined;
	const advanceMutation = (control: LiveJournalRetirementControl | null): void =>
		advanceJournalMutation(database, control, (scope) => {
			// Only exact scopes in the completed native drain may shed this opaque
			// witness. No callback/await crosses this fixed connection-local gate.
			deletingScope = scope;
			try {
				configuredStatement(
					database,
					"UPDATE scopes SET closed_membership_bytes=NULL WHERE object_id=? AND epoch=? AND anchor_digest=? AND closed_membership_bytes IS NOT NULL"
				).run(...scopeParameters(scope));
			} finally {
				deletingScope = undefined;
			}
		});
	try {
		enforceNativeLocalSessionFile(database, `${filename}.drp-live-journal-v1.sqlite`, session, initialization !== "reopen");
		database.function("journal_retirement_allows", (objectId, epoch, anchorDigest) => {
			if (
				typeof objectId !== "string" ||
				typeof epoch !== "number" ||
				!Number.isSafeInteger(epoch) ||
				epoch < 0 ||
				typeof anchorDigest !== "string"
			)
				return 0;
			if (
				deletingScope?.objectId === objectId &&
				deletingScope.epoch === epoch &&
				deletingScope.anchorDigest === anchorDigest
			)
				return 1;
			return journalRetirementMutationAllows(readRetirementControl(database, objectId, retirementCodec), {
				objectId,
				epoch,
				anchorDigest,
			})
				? 1
				: 0;
		});
		admit(database, initialization);
	} catch (error) {
		database.close();
		throw error;
	}
	let closed = false;
	let poisoned = false;
	let closePromise: Promise<void> | undefined;
	// Same bounded leaf-validation owner as the browser backend. Each consumer
	// still reads actual native contents and checks complete sequence/order,
	// duplicate identities, context, control and currency before delivery.
	let snapshotValidation = createLiveJournalSnapshotValidation();
	const resetSnapshotValidation = (): void => {
		snapshotValidation.release();
		if (!closed && !poisoned) snapshotValidation = createLiveJournalSnapshotValidation();
	};
	const poison = (): void => {
		poisoned = true;
		snapshotValidation.release();
	};
	const readReservations = new SqliteNativeReadReservationOwner(`${filename}.drp-live-journal-v1.sqlite`, session);
	// Opaque identities carry no native handle or byte payload. Probes may outlive
	// release without retaining any ended reservation or image through WeakRef's
	// same-job keep-alive semantics (SQLite reads can all join synchronously).
	let retirementLeaseToken: object | undefined;
	// One bounded detached image, valid only under this owner's exact native
	// BEGIN IMMEDIATE reservation. It is never used by mutations or readback.
	// The drain's original source, derived once per drain and reused while the residual frames match it exactly.
	const drainSourceMemo = createJournalRetirementDrainSourceMemo();
	let heldRetirementImage: Readonly<{
		lease: NativeReadReservation;
		objectId: string;
		controlBytes?: Uint8Array;
		planBytes?: Uint8Array;
		image: LiveJournalRetirementImage;
		frames: readonly Uint8Array[];
		token: object;
		enrollment: { observations: WeakMap<LiveJournalRetirementImageObservation, true> };
	}> | undefined;
	// One token/version and one full header (three byte carriers): no retained
	// accepted rows or per-history cache.
	let verifiedReplay: VerifiedReplayBasis | undefined;
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
	const unavailable = (): ReturnType<typeof failed> | undefined => {
		session?.assertCurrent();
		if (poisoned) retirementCodec.clear();
		return poisoned ? failed("store-poisoned") : closed ? failed("store-closed") : undefined;
	};

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
			poison();
			return "store-poisoned";
		}
		return "internal-invariant";
	};

	const install = (
		operation: "install" | "installEpochAnchor",
		input: InstallLiveJournalGenesisInput
	): InstallLiveJournalGenesisResult => {
		verifiedReplay = undefined;
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
			const retirement = admitJournalMutation(database, selected.stored.scope);
			writeVersion = dataVersion(database);
			const installed = readScopeWriter(database, selected.stored.scope);
			const storedRows = readRows(database, selected.stored.scope);
			if (installed === null) {
				if (storedRows.length !== 0) rejected = "store-poisoned";
				else {
					database.exec(
						`INSERT INTO scopes(object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier) VALUES(${sqlText(selected.stored.scope.objectId)},${selected.stored.scope.epoch},${sqlText(selected.stored.scope.anchorDigest)},0,${sqlBlob(selected.stored.exactCanonicalAnchorPreimageBytes)},${sqlBlob(selected.stored.detachedAnchorSignature)},${sqlText(selected.stored.parametersDigest)},${sqlBlob(selected.stored.exactCanonicalParametersCarrierBytes)})`
					);
					configuredStatement(
						database,
						"UPDATE scopes SET next_journal_sequence=next_journal_sequence WHERE object_id=? AND epoch=? AND anchor_digest=?"
					).run(...scopeParameters(selected.stored.scope));
				}
			} else {
				before = captureAddressedClosure({ rows: storedRows, scope: installed }, snapshotValidation) ?? null;
				if (before === null) rejected = "store-poisoned";
				else if (sameInstalledScope(before.scope, selected.stored)) idempotent = true;
				else rejected = "genesis-conflict";
			}
			if (rejected === undefined) {
				if (!idempotent) advanceMutation(retirement);
				database.exec("COMMIT");
			} else database.exec("ROLLBACK");
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the substrate failure.
			}
			invalidateWatermark(selected.stored.scope);
			return failed(
				error instanceof Error && (error.message === "retirement-fenced" || error.message === "retirement-exhausted")
					? error.message
					: "substrate-failure"
			);
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
			if (rejected === "store-poisoned") poison();
			if (actual === undefined && rejected !== "store-poisoned") return failed("outcome-unknown");
			if (actual !== undefined && actual !== null && captureAddressedClosure(actual, snapshotValidation) === undefined) {
				poison();
				return failed("store-poisoned");
			}
			return failed(rejected);
		}
		const capturedActual =
			actual === undefined || actual === null ? actual : captureAddressedClosure(actual, snapshotValidation);
		if (actual !== undefined && actual !== null && capturedActual === undefined) {
			invalidateWatermark(selected.stored.scope);
			poison();
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
		verifiedReplay = undefined;
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let captured: ReturnType<typeof captureLiveJournalInput>;
		let expectedNativeImage: Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }> | undefined;
		try {
			if (Object.getOwnPropertyDescriptor(input, "expectedNativeImage") !== undefined) {
				const source = captureSourceBoundJournalAppendInput(input);
				if (!source.ok) return failed(source.kind);
				expectedNativeImage = source.value.expectedNativeImage;
				captured = Object.freeze({ ok: true, value: source.value.row });
			} else captured = captureLiveJournalInput("append", input);
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
		let nativeImage: Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }> | undefined;
		try {
			beginJournalTransaction(database, "BEGIN IMMEDIATE");
			if (expectedNativeImage !== undefined) {
				const image = retirementImage(database, candidate.scope.objectId),
					control = readRetirementControl(database, candidate.scope.objectId, retirementCodec);
				const controlBytes = control === null ? null : encodeJournalRetirementControl(control);
				if (
					image.imageDigest !== expectedNativeImage.imageDigest ||
					!sameNativeControl(controlBytes, expectedNativeImage.controlBytes)
				) {
					database.exec("ROLLBACK");
					return failed("retirement-stale");
				}
			}
			const retirement = admitJournalMutation(database, candidate.scope);
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
						configuredStatement(database, "SELECT 1 AS present FROM main.scopes WHERE object_id=? AND epoch=? LIMIT 1").get(
							candidate.scope.objectId,
							candidate.scope.epoch
						) === undefined
							? "not-installed"
							: "wrong-scope";
				}
			} else {
				before = addressed
					? { kind: "append-addressed", row: null, scope }
					: (captureAddressedClosure({ rows: storedRows ?? [], scope }, snapshotValidation) ?? null);
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
					before = captureAddressedClosure({ rows: fullRows, scope }, snapshotValidation) ?? null;
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
					const update = configuredStatement(
						database,
						"UPDATE scopes SET next_journal_sequence=? WHERE object_id=? AND epoch=? AND anchor_digest=? AND next_journal_sequence=?"
					).run(journalSequence + 1, ...scopeParameters(candidate.scope), journalSequence);
					if (update.changes !== 1) rejected = "internal-invariant";
					else row = { ...candidate, journalSequence } as StoredRow;
				} else rejected = "internal-invariant";
			}
			if (rejected === undefined) {
				if (!idempotent) advanceMutation(retirement);
				if (expectedNativeImage !== undefined) {
					const image = retirementImage(database, candidate.scope.objectId),
						control = readRetirementControl(database, candidate.scope.objectId, retirementCodec);
					nativeImage = Object.freeze({
						imageDigest: image.imageDigest,
						controlBytes: control === null ? null : encodeJournalRetirementControl(control),
					});
				}
				database.exec("COMMIT");
			} else database.exec("ROLLBACK");
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the substrate failure.
			}
			invalidateWatermark(candidate.scope);
			return failed(
				error instanceof Error && (error.message === "retirement-fenced" || error.message === "retirement-exhausted")
					? error.message
					: "substrate-failure"
			);
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
			if (rejected === "store-poisoned") poison();
			if (actual === undefined && rejected !== "store-poisoned") return failed("outcome-unknown");
			if (actual !== undefined && actual !== null && captureAddressedClosure(actual, snapshotValidation) === undefined) {
				poison();
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
					if (actual !== null && captureAddressedClosure(actual, snapshotValidation) === undefined) kind = "store-poisoned";
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
				if (actual !== null && captureAddressedClosure(actual, snapshotValidation) === undefined) kind = "store-poisoned";
				else {
					kind = classify(actual, before, { kind: "append", row });
					if (kind === undefined && actual !== null) establishWatermark(actual.scope, observed.dataVersion);
				}
			}
		}
		if (kind !== undefined) {
			invalidateWatermark(candidate.scope);
			if (kind === "store-poisoned") poison();
			return failed(kind);
		}
		if (expectedNativeImage !== undefined) {
			if (nativeImage === undefined) return failed("internal-invariant");
			let active = false;
			try {
				beginJournalTransaction(database, "BEGIN");
				active = true;
				const image = retirementImage(database, candidate.scope.objectId),
					control = readRetirementControl(database, candidate.scope.objectId, retirementCodec);
				const controlBytes = control === null ? null : encodeJournalRetirementControl(control);
				database.exec("COMMIT");
				active = false;
				if (image.imageDigest !== nativeImage.imageDigest || !sameNativeControl(controlBytes, nativeImage.controlBytes))
					return failed("outcome-unknown");
			} catch {
				if (active)
					try {
						database.exec("ROLLBACK");
					} catch {
						/* retain unknown debt */
					}
				return failed("outcome-unknown");
			}
		}
		return Object.freeze({
			idempotent,
			journalSequence: row.journalSequence,
			ok: true,
			scope: Object.freeze({ ...row.scope }),
			sourceKind: row.sourceKind,
			...(nativeImage === undefined ? {} : { nativeImage }),
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
		let read: ReplayRead;
		try {
			read = readReplaySnapshotReadonly(database, scope, retirementCodec, verifiedReplay);
			if (read === UNSTABLE_VERSION) {
				verifiedReplay = undefined;
				read = readReplaySnapshotReadonly(database, scope, retirementCodec);
			}
		} catch (error) {
			return failed(
				error instanceof Error && error.message === "retirement-fenced" ? "stale-snapshot" : "substrate-failure"
			);
		}
		if (read !== UNSTABLE_VERSION && read.kind === "ready")
			return Object.freeze({
				ok: true,
				ready: true,
				rowCount: read.token.highWatermark,
				scope: Object.freeze({ ...scope }),
				snapshot: read.token,
			});
		if (read === UNSTABLE_VERSION || read.kind !== "complete") return failed("internal-invariant");
		const durable = read.snapshot;
		if (durable === WRONG_SCOPE_SNAPSHOT) return failed("wrong-scope");
		if (durable === null) return Object.freeze({ kind: "not-installed", ok: true, ready: false });
		let derived: Readonly<Record<string, unknown>>;
		try {
			derived = deriveLiveJournalSnapshotReadiness({ durable, validation: snapshotValidation } as never) as Readonly<
				Record<string, unknown>
			>;
			if (derived.ok !== true) {
				poison();
				return failed("store-poisoned");
			}
		} catch {
			return failed("internal-invariant");
		}
		verifiedReplay =
			read.dataVersion === undefined
				? undefined
				: {
						dataVersion: read.dataVersion,
						scope: durable.scope,
						token: derived.token as LiveJournalSnapshotToken,
					};
		return Object.freeze({
			ok: true,
			ready: true,
			rowCount: derived.rowCount as number,
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
		const supplied = page.snapshot as LiveJournalSnapshotToken;
		let read: ReplayRead;
		try {
			read = readReplaySnapshotReadonly(database, scope, retirementCodec, verifiedReplay, page as ReplayPage);
			if (read === UNSTABLE_VERSION) {
				verifiedReplay = undefined;
				read = readReplaySnapshotReadonly(database, scope, retirementCodec);
			}
		} catch (error) {
			return failed(
				error instanceof Error && error.message === "retirement-fenced" ? "stale-snapshot" : "substrate-failure"
			);
		}
		if (read === UNSTABLE_VERSION) return failed("internal-invariant");
		if (read.kind === "ready") return failed("internal-invariant");
		if (read.kind === "page") {
			const selected = Object.freeze(
				read.rows
					.slice(0, page.limit as number)
					.map((row) => Object.freeze({ ...row, scope: Object.freeze({ ...row.scope }) }))
			);
			return Object.freeze({
				nextSequence:
					selected.length < read.rows.length ? (selected[selected.length - 1]?.journalSequence ?? null) : null,
				ok: true,
				rows: selected,
				scope: Object.freeze({ ...scope }),
				snapshot: supplied,
			}) as LiveJournalPageResult;
		}
		verifiedReplay = undefined;
		const durable = read.snapshot;
		if (durable === WRONG_SCOPE_SNAPSHOT) return failed("wrong-scope");
		if (durable === null) return failed("not-installed");
		let derived: Readonly<Record<string, unknown>>;
		try {
			derived = deriveLiveJournalSnapshot({
				durable,
				validation: snapshotValidation,
				highWatermark: supplied.highWatermark,
				supplied,
			} as never) as Readonly<Record<string, unknown>>;
			if (derived.ok !== true) {
				const kind = derived.kind as LiveJournalFailureKind;
				if (kind === "store-poisoned") poison();
				return failed(kind);
			}
		} catch {
			return failed("internal-invariant");
		}
		verifiedReplay =
			read.dataVersion === undefined
				? undefined
				: {
						dataVersion: read.dataVersion,
						scope: durable.scope,
						token: derived.token as LiveJournalSnapshotToken,
					};
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

	// eslint-disable-next-line @typescript-eslint/require-await -- SQLite work is synchronous behind the async port.
	const readAnchorPreimage = async (input: LiveJournalAnchorReadInput): Promise<LiveJournalAnchorReadResult> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		const captured = captureLiveJournalInput("anchorRead", input);
		if (!captured.ok) return failed(captured.kind);
		const selected = captured.value as LiveJournalAnchorReadInput;
		const unavailableAfterCapture = unavailable();
		if (unavailableAfterCapture !== undefined) return unavailableAfterCapture;
		let result: LiveJournalAnchorReadResult;
		try {
			database.exec("BEGIN");
			// Exact equality to the captured canonical key bounds every projected key.
			// CASE short-circuits the BLOB projection until physical type/length and allowance pass.
			const row = configuredStatement(
				database,
				`WITH addressed AS (
					SELECT object_id, epoch, anchor_digest, exact_anchor_preimage,
						typeof(object_id)='text' AND length(CAST(object_id AS BLOB)) BETWEEN 1 AND 4096
						AND typeof(epoch)='integer' AND epoch BETWEEN 0 AND 9007199254740991
						AND typeof(anchor_digest)='text' AND length(CAST(anchor_digest AS BLOB))=64
						AND anchor_digest NOT GLOB '*[^0-9a-f]*' AS key_valid
					FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?
				)
				SELECT CASE
					WHEN NOT key_valid OR typeof(exact_anchor_preimage)!='blob' OR length(exact_anchor_preimage)=0 THEN 'store-poisoned'
					WHEN length(exact_anchor_preimage)>? THEN 'read-budget-exceeded'
					ELSE 'present' END AS kind,
					CASE WHEN key_valid AND typeof(exact_anchor_preimage)='blob'
						AND length(exact_anchor_preimage)>0 AND length(exact_anchor_preimage)<=?
						THEN exact_anchor_preimage ELSE NULL END AS exact_anchor_preimage
				FROM addressed`
			).get(...scopeParameters(selected.scope), selected.maxBytes, selected.maxBytes);
			if (row === undefined) result = Object.freeze({ kind: "missing", ok: true });
			else if (row.kind === "store-poisoned") result = failed("store-poisoned");
			else if (row.kind === "read-budget-exceeded") result = Object.freeze({ kind: "read-budget-exceeded", ok: false });
			else if (row.kind === "present") {
				result = captureLiveJournalAnchorReadObservation(selected, {
					exactCanonicalAnchorPreimageBytes: row.exact_anchor_preimage,
					scope: selected.scope,
				});
			} else result = failed("internal-invariant");
			database.exec("COMMIT");
		} catch {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the original native transaction failure.
			}
			return failed("substrate-failure");
		}
		if (!result.ok && result.kind === "store-poisoned") poison();
		return result;
	};

	// eslint-disable-next-line @typescript-eslint/require-await -- SQLite work is synchronous behind the async port.
	const readSignedAnchorEnvelope = async function (
		input: LiveJournalSignedAnchorReadInput
	): Promise<LiveJournalSignedAnchorReadResult> {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		const captured = captureLiveJournalSignedAnchorReadInput(input);
		if (!captured.ok) return captured;
		const unavailableAfterCapture = unavailable();
		if (unavailableAfterCapture !== undefined) return unavailableAfterCapture;
		let result: SignedScopeRead;
		try {
			database.exec("BEGIN");
			result = readSignedScope(database, captured.value);
			database.exec("COMMIT");
		} catch {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the native transaction failure, not an absence result.
			}
			return failed("substrate-failure");
		}
		if (!result.ok) {
			if (result.kind === "store-poisoned") poison();
			return result;
		}
		if (result.stored === null) return Object.freeze({ kind: "missing", ok: true });
		const stored = result.stored;
		return Object.freeze({
			kind: "present",
			ok: true,
			parametersDigest: stored.parametersDigest,
			scope: stored.scope,
			envelope: Object.freeze({
				objectId: stored.scope.objectId,
				exactCanonicalAnchorPreimageBytes: stored.exactCanonicalAnchorPreimageBytes,
				detachedAnchorSignature: stored.detachedAnchorSignature,
				exactCanonicalParametersCarrierBytes: stored.exactCanonicalParametersCarrierBytes,
			}),
		});
	};

	// SQLite point reads complete synchronously inside the admitted native owner.
	const readClosedMembership: NonNullable<DurableLiveJournalStore["readClosedMembership"]> = async input => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let selected: ReturnType<typeof captureJournalClosedMembershipReadInput>;
		try { selected = captureJournalClosedMembershipReadInput(input); }
		catch { return failed("malformed-input"); }
		const afterCapture = unavailable();
		if (afterCapture !== undefined) return afterCapture;
		let result: LiveJournalClosedMembershipReadResult;
		try {
			database.exec("BEGIN");
			// CASE prevents SQLite from copying an oversized BLOB into JavaScript.
			const row = configuredStatement(
				database,
				`SELECT CASE
				WHEN closed_membership_bytes IS NULL THEN 'missing'
				WHEN typeof(closed_membership_bytes)!='blob' OR length(closed_membership_bytes)=0
					OR length(closed_membership_bytes)>? THEN 'store-poisoned'
				WHEN length(closed_membership_bytes)>? THEN 'read-budget-exceeded'
				ELSE 'present' END AS kind,
				CASE WHEN typeof(closed_membership_bytes)='blob' AND length(closed_membership_bytes)>0
					AND length(closed_membership_bytes)<=? THEN closed_membership_bytes ELSE NULL END AS bytes
				FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?`).get(
				LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes, selected.maxBytes, selected.maxBytes, ...scopeParameters(selected.scope));
			if (row === undefined || row.kind === "missing") result = Object.freeze({ok: true, kind: "missing"});
			else if (row.kind === "store-poisoned") result = failed("store-poisoned");
			else if (row.kind === "read-budget-exceeded") result = Object.freeze({ok: false, kind: "read-budget-exceeded"});
			else if (row.kind === "present") result = captureJournalClosedMembershipObservation(selected, selected.scope, row.bytes);
			else result = failed("internal-invariant");
			database.exec("COMMIT");
		} catch {
			try { database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
			return failed("substrate-failure");
		}
		if (!result.ok && result.kind === "store-poisoned") poison();
		return result;
	};

	const importHistoricalAnchor = async (
		input: LiveJournalHistoricalAnchorImportInput
		// eslint-disable-next-line @typescript-eslint/require-await -- SQLite work is synchronous behind the async port.
	): Promise<LiveJournalHistoricalAnchorImportResult> => {
		verifiedReplay = undefined;
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		const captured = captureLiveJournalHistoricalAnchorImportInput(input);
		if (!captured.ok) return captured;
		const unavailableAfterCapture = unavailable();
		if (unavailableAfterCapture !== undefined) return unavailableAfterCapture;
		const selected = captured.value;
		const request = { maxBytes: selected.maxBytes, scope: selected.stored.scope };
		let before: DurableSnapshot | null = null;
		let idempotent = false;
		let rejected: Extract<LiveJournalHistoricalAnchorImportResult, { readonly ok: false }> | undefined;
		let admitted = false;
		try {
			database.exec("BEGIN IMMEDIATE");
			const retirement = admitJournalMutation(database, request.scope);
			const closure = readEmptyClosure(database, request);
			if (!closure.ok) rejected = closure;
			else if (closure.kind === "populated") rejected = Object.freeze({ kind: "import-populated", ok: false });
			else {
				before = closure.snapshot;
				if (before !== null) {
					if (sameInstalledScope(before.scope, selected.stored)) idempotent = true;
					else rejected = failed("genesis-conflict");
				}
				if (rejected === undefined) {
					admitted = true;
					if (before === null) {
						database.exec(
							`INSERT INTO scopes(object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier) VALUES(${sqlText(request.scope.objectId)},${request.scope.epoch},${sqlText(request.scope.anchorDigest)},0,${sqlBlob(selected.stored.exactCanonicalAnchorPreimageBytes)},${sqlBlob(selected.stored.detachedAnchorSignature)},${sqlText(selected.parametersDigest)},${sqlBlob(selected.stored.exactCanonicalParametersCarrierBytes)})`
						);
					}
				}
			}
			if (rejected === undefined && !idempotent) advanceMutation(retirement);
			database.exec(rejected === undefined ? "COMMIT" : "ROLLBACK");
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message === "retirement-fenced" || error.message === "retirement-exhausted")
			) {
				try {
					database.exec("ROLLBACK");
				} catch {
					/* The native transaction may already be terminal; preserve primary/readback. */
				}
				return failed(error.message);
			}
			try {
				database.exec("ROLLBACK");
			} catch {
				// COMMIT may already have completed. The fresh native observation owns the outcome.
			}
			if (!admitted && rejected === undefined) return failed("substrate-failure");
		}
		if (rejected !== undefined) {
			if (rejected.kind === "store-poisoned") poison();
			return rejected;
		}
		let actual: DurableSnapshot | null | undefined;
		try {
			const closure = readEmptyClosureReadonly(database, request);
			if (!closure.ok) {
				if (closure.kind === "store-poisoned") {
					poison();
					return closure;
				}
				actual = undefined;
			} else actual = closure.kind === "empty" ? closure.snapshot : undefined;
		} catch {
			actual = undefined;
		}
		const kind = classify(actual, before, { kind: "install", scope: selected.stored });
		return kind === undefined
			? Object.freeze({ idempotent, ok: true, parametersDigest: selected.parametersDigest, scope: request.scope })
			: failed(kind);
	};

	// eslint-disable-next-line @typescript-eslint/require-await -- SQLite mutation and joined readback are synchronous behind this port.
	const recordClosedMembership: NonNullable<DurableLiveJournalStore["recordClosedMembership"]> = async (input) => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let selected: ReturnType<typeof captureJournalClosedMembershipInput>;
		try {
			selected = captureJournalClosedMembershipInput(input);
		} catch {
			return failed("malformed-input");
		}
		verifiedReplay = undefined;
		verifiedScopes.clear();
		resetSnapshotValidation();
		let active = false,
			attempted = false,
			idempotent = false;
		let expectedAfter: Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }> | undefined;
		let refusal: LiveJournalFailureKind | undefined;
		try {
			database.exec("BEGIN IMMEDIATE");
			active = true;
			const before = retirementImage(database, selected.scope.objectId, []);
			const control = readRetirementControl(database, selected.scope.objectId, retirementCodec);
			const bytes = control === null ? null : encodeJournalRetirementControl(control);
			if (
				before.imageDigest !== selected.expectedNativeImage.imageDigest ||
				!sameNativeControl(bytes, selected.expectedNativeImage.controlBytes)
			)
				refusal = "retirement-stale";
			else {
				const installed = readScopeWriter(database, selected.scope);
				const current = configuredStatement(
					database,
					"SELECT closed_membership_bytes FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?"
				).get(...scopeParameters(selected.scope));
				if (installed === null || current === undefined) refusal = "not-installed";
				else if (current.closed_membership_bytes !== null &&
					sameBytes(copyBlob(current.closed_membership_bytes), selected.exactCanonicalMembershipBytes)) {
					idempotent = true;
					expectedAfter = { imageDigest: before.imageDigest, controlBytes: bytes };
				} else if (current.closed_membership_bytes !== null &&
					!journalClosedMembershipCanExtend(copyBlob(current.closed_membership_bytes), selected.exactCanonicalMembershipBytes))
					refusal = "evidence-conflict";
				else {
					const mutation = admitJournalMutation(database, selected.scope);
					if (!journalRetirementMutationAllows(mutation, selected.scope)) refusal = "retirement-fenced";
					else {
						const after = retirementImage(database, selected.scope.objectId, [], {
							scope: selected.scope,
							bytes: selected.exactCanonicalMembershipBytes,
							clearScopes: mutation?.drain?.plan.prefixes.map((p) => p.scope) ?? [],
						});
						const next = mutation === null ? null : advanceJournalRetirementMutationControl(mutation);
						expectedAfter = {
							imageDigest: after.imageDigest,
							controlBytes: next === null ? null : encodeJournalRetirementControl(next),
						};
						attempted = true;
						configuredStatement(
							database,
							"UPDATE scopes SET closed_membership_bytes=? WHERE object_id=? AND epoch=? AND anchor_digest=? AND closed_membership_bytes IS ?"
						).run(selected.exactCanonicalMembershipBytes, ...scopeParameters(selected.scope), current.closed_membership_bytes);
						advanceMutation(mutation);
						if (retirementImage(database, selected.scope.objectId, []).imageDigest !== after.imageDigest)
							throw new Error("retirement-stale");
					}
				}
			}
			if (refusal !== undefined) {
				database.exec("ROLLBACK");
				active = false;
				return failed(refusal);
			}
			database.exec("COMMIT");
			active = false;
		} catch (error) {
			if (active)
				try {
					database.exec("ROLLBACK");
				} catch {
					/* Commit may already be terminal; exact readback owns the outcome. */
				}
			active = false;
			if (!attempted)
				return failed(
					error instanceof Error &&
						(error.message === "retirement-fenced" ||
							error.message === "retirement-exhausted" ||
							error.message === "retirement-stale")
						? error.message
						: "substrate-failure"
				);
		}
		if (expectedAfter === undefined) return failed("outcome-unknown");
		try {
			database.exec("BEGIN");
			active = true;
			const actualImage = retirementImage(database, selected.scope.objectId, []),
				actual = readRetirementControl(database, selected.scope.objectId, retirementCodec);
			const actualBytes = actual === null ? null : encodeJournalRetirementControl(actual);
			database.exec("COMMIT");
			active = false;
			if (
				actualImage.imageDigest === expectedAfter.imageDigest &&
				sameNativeControl(actualBytes, expectedAfter.controlBytes)
			)
				return { ok: true, value: { idempotent, ...expectedAfter } };
			if (
				actualImage.imageDigest === selected.expectedNativeImage.imageDigest &&
				sameNativeControl(actualBytes, selected.expectedNativeImage.controlBytes)
			)
				return failed("substrate-failure");
			return failed("outcome-unknown");
		} catch {
			if (active)
				try {
					database.exec("ROLLBACK");
				} catch {
					/* Preserve unreadable readback. */
				}
			return failed("outcome-unknown");
		}
	};
	const readRetirementImage: LiveJournalRetirementImageReader = async (
		input: Readonly<{ objectId: string }>
	): Promise<LiveJournalRetirementResult<LiveJournalRetirementImageObservation>> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let objectId: string;
		try {
			objectId = captureJournalRetirementObject(input);
		} catch {
			return failed("malformed-input");
		}
		const afterInput = unavailable();
		if (afterInput !== undefined) return afterInput;
		let active = false;
		try {
			const lease = readReservations.current();
			if (heldRetirementImage !== undefined &&
				(heldRetirementImage.lease !== lease || heldRetirementImage.objectId !== objectId))
				heldRetirementImage = undefined;
			if (lease !== undefined) {
				await lease.check();
				if (readReservations.current() !== lease) return failed("retirement-released");
				const after = unavailable(); if (after !== undefined) return after;
			}
			const basis = heldRetirementImage;
			let frames: Uint8Array[], image: LiveJournalRetirementImage, control: LiveJournalRetirementControl | null;
			if (basis !== undefined) {
				frames = basis.frames.map(bytes => bytes.slice());
				image = Object.freeze({...basis.image});
				control = basis.controlBytes === undefined ? null :
					retirementCodec.decode(basis.controlBytes.slice(), basis.planBytes?.slice());
			} else {
				frames = [];
				beginJournalTransaction(database, "BEGIN");
				active = true;
				image = retirementImage(database, objectId, frames);
				control = readRetirementControl(database, objectId, retirementCodec);
			}
			const drainSource = reconstructJournalRetirementDrainSource(control, image, frames, retirementFrame, drainSourceMemo);
			if (basis === undefined) {
				if (drainSource !== undefined && control !== null) validateDrainNativeRows(database, control);
				database.exec("COMMIT");
				active = false;
			}
			if (lease !== undefined) {
				await lease.check();
				if (readReservations.current() !== lease) return failed("retirement-released");
			}
			const after = unavailable(); if (after !== undefined) return after;
			if (image.scopeCount === 0) return failed("not-installed");
			if (basis === undefined && lease !== undefined) {
				const carriers = control === null ? undefined : retirementCodec.encode(control);
				heldRetirementImage = Object.freeze({lease, objectId,
					...(carriers === undefined ? {} : {controlBytes: carriers.controlBytes.slice(),
						...(carriers.planBytes === undefined ? {} : {planBytes: carriers.planBytes.slice()})}),
					image: Object.freeze({...image}), frames: Object.freeze(frames.map(bytes => bytes.slice())), token: Object.freeze({}),
					enrollment: {observations: new WeakMap()}});
			}
			const observation: LiveJournalRetirementImageObservation = Object.freeze({
					control,
					exactCanonicalControlCarriers: Object.freeze(
						control === null
							? []
							: (() => {
									const bytes = retirementCodec.encode(control);
									return [bytes.controlBytes, ...(bytes.planBytes === undefined ? [] : [bytes.planBytes])];
								})()
					),
					image,
					canonicalRows: Object.freeze(frames),
					...(drainSource === undefined ? {} : { drainSource }),
			});
			if (lease !== undefined && heldRetirementImage?.lease === lease && heldRetirementImage.objectId === objectId)
				heldRetirementImage.enrollment.observations = new WeakMap([[observation, true]]);
			return Object.freeze({ok: true, value: observation});
		} catch (error) {
			heldRetirementImage = undefined;
			if (active)
				try {
					database.exec("ROLLBACK");
				} catch {
					/* Preserve the original capture failure. */
				}
			return failed(
				error instanceof Error && (error.message === "retirement-fenced" || error.message === "retirement-stale")
					? error.message
					: "substrate-failure"
			);
		}
	};
	// Capture only lightweight tokens in escaping probes, never an old basis,
	// returned observation or native lease (not even through a weak reference).
	const createCurrentProbe = (token: object, leaseToken: object): LiveJournalRetirementImageCurrentProbe => {
		const probe: LiveJournalRetirementImageCurrentProbe = Object.freeze({
			checkCurrent: async function (this: LiveJournalRetirementImageCurrentProbe): Promise<LiveJournalRetirementResult<null>> {
				if (this !== probe) return failed("malformed-input");
				const blocked = unavailable(); if (blocked !== undefined) return blocked;
				try {
					const lease = readReservations.current();
					if (lease === undefined || retirementLeaseToken !== leaseToken) return failed("retirement-released");
					// Enter the original native check on every successful delivery. No
					// previous request, encoded image or authority substitutes for it.
					await lease.check();
					const after = unavailable(); if (after !== undefined) return after;
					if (readReservations.current() !== lease || retirementLeaseToken !== leaseToken) return failed("retirement-released");
					return heldRetirementImage?.token === token
						? Object.freeze({ok: true, value: null}) : failed("retirement-stale");
				} catch { return failed("substrate-failure"); }
			},
		});
		return probe;
	};
	Object.defineProperty(readRetirementImage, "captureCurrentProbe", {value: function (this: LiveJournalRetirementImageReader,
		observation: LiveJournalRetirementImageObservation): LiveJournalRetirementImageCurrentProbe | undefined {
		if (this !== readRetirementImage || unavailable() !== undefined) return undefined;
		const basis = heldRetirementImage;
		if (basis === undefined || !basis.enrollment.observations.has(observation)) return undefined;
		basis.enrollment.observations.delete(observation);
		try {
			if (readReservations.current() !== basis.lease || retirementLeaseToken === undefined) return undefined;
			const carriers = observation.control === null ? undefined : encodeJournalRetirementNativeCarriers(observation.control);
			const expected = basis.controlBytes === undefined ? [] : [basis.controlBytes, ...(basis.planBytes === undefined ? [] : [basis.planBytes])];
			if ((carriers === undefined) !== (basis.controlBytes === undefined) || carriers !== undefined &&
				(!sameNativeControl(carriers.controlBytes, basis.controlBytes!) || !sameNativeControl(carriers.planBytes ?? null, basis.planBytes ?? null)) ||
				observation.exactCanonicalControlCarriers.length !== expected.length ||
				observation.exactCanonicalControlCarriers.some((bytes, i) => compareBytes(bytes, expected[i]!) !== 0) ||
				observation.canonicalRows.length !== basis.frames.length ||
				observation.canonicalRows.some((bytes, i) => compareBytes(bytes, basis.frames[i]!) !== 0) ||
				compareBytes(encodeCanonical(observation.image), encodeCanonical(basis.image)) !== 0) return undefined;
			const control = basis.controlBytes === undefined ? null :
					retirementCodec.decode(basis.controlBytes.slice(), basis.planBytes?.slice());
			const drainSource = reconstructJournalRetirementDrainSource(control, basis.image, basis.frames, retirementFrame, drainSourceMemo);
			if ((drainSource === undefined) !== (observation.drainSource === undefined) || drainSource !== undefined &&
				compareBytes(encodeCanonical(drainSource), encodeCanonical(observation.drainSource)) !== 0) return undefined;
		} catch { return undefined; }
		return createCurrentProbe(basis.token, retirementLeaseToken!);
	}});
	Object.freeze(readRetirementImage);
	const acquireRetirementControl = async (
		input: Readonly<{ objectId: string }>
		// eslint-disable-next-line @typescript-eslint/require-await -- Original SQLite work is synchronous behind the async port.
	): Promise<LiveJournalRetirementResult<LiveJournalRetirementControlRead>> => {
		const blocked = unavailable();
		if (blocked !== undefined) return blocked;
		let objectId: string;
		try {
			objectId = captureJournalRetirementObject(input);
		} catch {
			return failed("malformed-input");
		}
		const afterInput = unavailable();
		if (afterInput !== undefined) return afterInput;
		let current: LiveJournalRetirementControl, image: LiveJournalRetirementImage;
		resetSnapshotValidation();
		let drainSource: LiveJournalRetirementDrainSource | undefined;
		const frames: Uint8Array[] = [];
		let active = false;
		try {
			// Fully join the native RO image before any control-birth RW attempt.
			database.exec("BEGIN");
			active = true;
			image = retirementImage(database, objectId, frames);
			if (image.scopeCount === 0) {
				database.exec("COMMIT");
				active = false;
				return failed("not-installed");
			}
			const prior = readRetirementControl(database, objectId, retirementCodec);
			drainSource = reconstructJournalRetirementDrainSource(prior, image, frames, retirementFrame, drainSourceMemo);
			if (drainSource !== undefined && prior !== null) validateDrainNativeRows(database, prior);
			database.exec("COMMIT");
			active = false;
			if (prior !== null) current = prior;
			else {
				const beforeBirth = unavailable();
				if (beforeBirth !== undefined) return beforeBirth;
				const born = {
					kind: "v3-live-journal-retirement-control-1" as const,
					objectId,
					incarnation: randomBytes(32).toString("hex"),
					revision: 0,
					sequence: 0,
					active: null,
					completed: null,
				};
				database.exec("BEGIN IMMEDIATE");
				active = true;
				const actual = readRetirementControl(database, objectId, retirementCodec);
				if (actual !== null || retirementImage(database, objectId).imageDigest !== image.imageDigest) {
					database.exec("ROLLBACK");
					active = false;
					return failed("retirement-stale");
				}
				writeRetirementControl(database, born);
				try {
					database.exec("COMMIT");
					active = false;
				} catch {
					try {
						database.exec("ROLLBACK");
					} catch {
						/* The native transaction may already be terminal; preserve primary/readback. */
					}
					active = false;
				}
				database.exec("BEGIN");
				active = true;
				const readback = readRetirementControl(database, objectId, retirementCodec),
					after = retirementImage(database, objectId);
				database.exec("COMMIT");
				active = false;
				if (
					readback === null ||
					!sameBytes(encodeJournalRetirementControl(readback), encodeJournalRetirementControl(born)) ||
					after.imageDigest !== image.imageDigest
				)
					return failed("outcome-unknown");
				current = readback;
			}
		} catch (error) {
			if (active)
				try {
					database.exec("ROLLBACK");
				} catch {
					/* The native transaction may already be terminal; preserve primary/readback. */
				}
			return failed(
				error instanceof Error && error.message === "retirement-fenced" ? "retirement-fenced" : "substrate-failure"
			);
		}
		const expected = retirementCodec.encode(current);
		return {
			ok: true,
			value: retirementCodec.createRead(
				current,
				image,
				// eslint-disable-next-line @typescript-eslint/require-await -- Native CAS/readback synchronously joins before delivery.
				async (next, deletions, nextCarriers) => {
					const blocked = unavailable();
					if (blocked !== undefined) return blocked;
					let active = false,
						attempted = false;
					try {
						database.exec("BEGIN IMMEDIATE");
						active = true;
						const actual = readRetirementControl(database, objectId, retirementCodec),
							nativeImage = retirementImage(database, objectId);
						if (
							actual === null ||
							!sameRetirementNativeCarriers(retirementCodec.encode(actual), expected) ||
							nativeImage.imageDigest !== image.imageDigest
						) {
							database.exec("ROLLBACK");
							active = false;
							return failed("retirement-stale");
						}
						if (deletions !== undefined && deletions.length > 0) {
							validateDrainNativeRows(database, actual);
							attempted = true;
							for (const selected of deletions) {
								try {
									deletingScope = selected.scope;
									const deleted =
										"row" in selected
											? configuredStatement(
													database,
													"DELETE FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=? AND journal_sequence=?"
												).run(...scopeParameters(selected.scope), selected.row.journalSequence)
											: configuredStatement(
													database,
													"DELETE FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?"
												).run(...scopeParameters(selected.scope));
									if (deleted.changes !== 1) throw new Error("retirement-stale");
									invalidateWatermark(selected.scope);
									verifiedReplay = undefined;
								} finally {
									deletingScope = undefined;
								}
							}
							if (
								next.drain == null ||
								retirementImage(database, objectId).imageDigest !== next.drain.residualImageDigest
							)
								throw new Error("retirement-stale");
							validateDrainNativeRows(database, next);
						} else if (next.drain != null && actual.drain == null) validateDrainNativeRows(database, next);
						attempted = true;
						writeRetirementNativeCarriers(database, objectId, nextCarriers);
						database.exec("COMMIT");
						active = false;
					} catch {
						if (active)
							try {
								database.exec("ROLLBACK");
							} catch {
								/* The native transaction may already be terminal; preserve primary/readback. */
							}
						if (!attempted) return failed("substrate-failure");
					}
					// Delivery/COMMIT throws do not prove absence. Join a fresh whole native image.
					try {
						database.exec("BEGIN");
						active = true;
						const actual = readRetirementControl(database, objectId, retirementCodec),
							nativeImage = retirementImage(database, objectId);
						database.exec("COMMIT");
						active = false;
						if (actual === null) return failed("outcome-unknown");
						const bytes = retirementCodec.encode(actual);
						const nextImage =
							deletions !== undefined && deletions.length > 0 ? next.drain?.residualImageDigest : image.imageDigest;
						if (
							sameRetirementNativeCarriers(bytes, nextCarriers) &&
							nativeImage.imageDigest === nextImage
						)
							return { ok: true, value: actual };
						if (sameRetirementNativeCarriers(bytes, expected) && nativeImage.imageDigest === image.imageDigest)
							return failed("substrate-failure");
						return failed("outcome-unknown");
					} catch {
						if (active)
							try {
								database.exec("ROLLBACK");
							} catch {
								/* The native transaction may already be terminal; preserve primary/readback. */
							}
						return failed("outcome-unknown");
					}
				},
				frames,
				drainSource
			),
		};
	};
	const close = (): Promise<void> => {
		if (closePromise !== undefined) return closePromise;
		closed = true;
		snapshotValidation.release();
		retirementCodec.clear();
		heldRetirementImage = undefined;
		retirementLeaseToken = undefined;
		verifiedReplay = undefined;
		const readJoined = readReservations.close();
		closePromise = Promise.resolve()
			.then(() => {
				try {
					database.close();
				} catch {
					// Close is idempotent and never rejects.
				}
			})
			.then(() => readJoined).finally(() => retirementCodec.release()).then(() => session?.closedOwner(store));
		return closePromise;
	};

	const store = Object.freeze({
		readClosedMembership,
		recordClosedMembership,
		readRetirementImage,
		acquireRetirementControl,
		acquireNativeReadReservation: async (input: Readonly<{ objectId: string }>) => {
			const blocked = unavailable();
			if (blocked !== undefined) throw new Error(blocked.kind);
			captureJournalRetirementObject(input);
			const lease = await readReservations.acquire();
			const token = Object.freeze({});
			retirementLeaseToken = token;
			return Object.freeze({check: () => lease.check(), release: (): Promise<void> => {
				if (heldRetirementImage?.lease === lease) heldRetirementImage = undefined;
				if (retirementLeaseToken === token) retirementLeaseToken = undefined;
				return lease.release();
			}});
		},
		appendAccepted,
		close,
		installEpochAnchor,
		installGenesis,
		importHistoricalAnchor,
		readAnchorPreimage,
		readSignedAnchorEnvelope,
		readiness,
		readPage,
	});
	return store;
}
