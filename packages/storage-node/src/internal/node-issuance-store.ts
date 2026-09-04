import {
	applySettlementPlanEffect,
	assertDurableIssueScope,
	captureSettlementPlanWriteInput,
	classifyDurableIssuanceTerminalSuppression,
	cloneDurableIssueCommit,
	cloneSettlementPlan,
	compareDurableIssuanceCompoundKeys,
	copyAndValidateDurableIssueCommit,
	copyDurableIssuanceBytes,
	copyDurableIssueScope,
	copySettlementPlan,
	createDurableIssuanceFailure,
	DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT,
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
	MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT,
	type SettlementPlan,
} from "@ts-drp/issuance-store";
import {
	bindDurableIssuancePruningMaintenance,
	captureDurableIssuancePruningInput,
	createDurableIssuancePruningReceipt,
	createDurableIssuancePruningState,
	createDurableIssuanceRecordPrunedError,
	decodeDurableIssuancePreimage,
	durableIssuanceAddressIsPruned,
	durableIssuanceLineageConsumed,
	durableIssuanceLineagesEqual,
	type DurableIssuancePruningReceipt,
	type DurableIssuancePruningState,
	DurableIssuanceRecordPrunedError,
	settlementPlanPermitsAuthenticatedPruning,
} from "@ts-drp/issuance-store/maintenance";
import { DatabaseSync, type StatementSync } from "node:sqlite";

const DATABASE_SUFFIX = ".drp-issuance-v1.sqlite";
const SCHEMA_VERSION = 3;
const PAGE_SIZE = 4096;
const BUSY_TIMEOUT = 1000;

const LINEAGES_V1_DDL =
	"CREATE TABLE lineages (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  next INTEGER NOT NULL CHECK(next BETWEEN 0 AND 9007199254740991),\n  exhausted INTEGER NOT NULL CHECK(exhausted IN (0,1)),\n  PRIMARY KEY (object_id,author)\n) WITHOUT ROWID";
const LINEAGES_DDL =
	"CREATE TABLE lineages (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  next INTEGER NOT NULL CHECK(next BETWEEN 0 AND 9007199254740991),\n  exhausted INTEGER NOT NULL CHECK(exhausted IN (0,1)),\n  pruned_through_author_sequence INTEGER CHECK(pruned_through_author_sequence IS NULL OR pruned_through_author_sequence BETWEEN 0 AND 9007199254740991),\n  PRIMARY KEY (object_id,author)\n) WITHOUT ROWID";
const ISSUED_RECORDS_DDL =
	"CREATE TABLE issued_records (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  author_sequence INTEGER NOT NULL CHECK(author_sequence BETWEEN 0 AND 9007199254740991),\n  canonical_preimage BLOB NOT NULL CHECK(typeof(canonical_preimage) = 'blob' AND length(canonical_preimage) > 0),\n  digest BLOB NOT NULL CHECK(typeof(digest) = 'blob' AND length(digest) > 0),\n  signature BLOB NOT NULL CHECK(typeof(signature) = 'blob' AND length(signature) > 0),\n  PRIMARY KEY (object_id,author,author_sequence)\n) WITHOUT ROWID";
const ISSUANCE_OUTBOX_DDL =
	"CREATE TABLE issuance_outbox (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  author_sequence INTEGER NOT NULL CHECK(author_sequence BETWEEN 0 AND 9007199254740991),\n  digest BLOB NOT NULL CHECK(typeof(digest) = 'blob' AND length(digest) > 0),\n  publish_state TEXT NOT NULL CHECK(publish_state IN ('pending','published')),\n  PRIMARY KEY (object_id,author,author_sequence)\n) WITHOUT ROWID";
const SETTLEMENT_PLANS_DDL =
	"CREATE TABLE settlement_plans (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),\n  fence_sequence INTEGER CHECK(fence_sequence IS NULL OR fence_sequence BETWEEN 0 AND 9007199254740991),\n  entries_json TEXT NOT NULL CHECK(typeof(entries_json) = 'text' AND length(entries_json) > 0),\n  PRIMARY KEY (object_id,author)\n) WITHOUT ROWID";

const DDL = Object.freeze([LINEAGES_DDL, ISSUED_RECORDS_DDL, ISSUANCE_OUTBOX_DDL, SETTLEMENT_PLANS_DDL] as const);
const EXPECTED_CATALOG = Object.freeze([
	Object.freeze({ name: "issuance_outbox", sql: ISSUANCE_OUTBOX_DDL, type: "table" }),
	Object.freeze({ name: "issued_records", sql: ISSUED_RECORDS_DDL, type: "table" }),
	Object.freeze({ name: "lineages", sql: LINEAGES_DDL, type: "table" }),
	Object.freeze({ name: "settlement_plans", sql: SETTLEMENT_PLANS_DDL, type: "table" }),
] as const);
const V2_EXPECTED_CATALOG = Object.freeze([
	Object.freeze({ name: "issuance_outbox", sql: ISSUANCE_OUTBOX_DDL, type: "table" }),
	Object.freeze({ name: "issued_records", sql: ISSUED_RECORDS_DDL, type: "table" }),
	Object.freeze({ name: "lineages", sql: LINEAGES_DDL, type: "table" }),
] as const);
const V1_EXPECTED_CATALOG = Object.freeze([
	Object.freeze({ name: "issuance_outbox", sql: ISSUANCE_OUTBOX_DDL, type: "table" }),
	Object.freeze({ name: "issued_records", sql: ISSUED_RECORDS_DDL, type: "table" }),
	Object.freeze({ name: "lineages", sql: LINEAGES_V1_DDL, type: "table" }),
] as const);

interface NativeLineage extends DurableLineage {
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

function capturePrimaryFilename(value: unknown): string {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("options must be plain");
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw invalid("options must be plain");
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 1 || keys[0] !== "primaryFilename") {
			throw invalid("options must contain only primaryFilename");
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, "primaryFilename");
		if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
			throw invalid("primaryFilename must be an enumerable data property");
		}
		if (typeof descriptor.value !== "string" || descriptor.value.length === 0 || descriptor.value.includes("\0")) {
			throw invalid("primaryFilename must be a representable non-empty primitive string");
		}
		return descriptor.value;
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
	const row = statement(database, sql).get();
	return row === undefined ? undefined : Object.values(row)[0];
}

function catalog(database: DatabaseSync): readonly Record<string, unknown>[] {
	return statement(database, "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
}

function catalogMatches(
	rows: readonly Record<string, unknown>[],
	expectedCatalog: typeof EXPECTED_CATALOG | typeof V2_EXPECTED_CATALOG | typeof V1_EXPECTED_CATALOG = EXPECTED_CATALOG
): boolean {
	return (
		rows.length === expectedCatalog.length &&
		rows.every((row, index) => {
			const expected = expectedCatalog[index];
			return (
				expected !== undefined &&
				row.type === expected.type &&
				row.name === expected.name &&
				row.tbl_name === expected.name &&
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

function admit(database: DatabaseSync): void {
	database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT}`);
	if (scalar(database, "PRAGMA busy_timeout") !== BUSY_TIMEOUT) {
		throw failure("ISSUANCE_DURABILITY_UNAVAILABLE", "SQLite busy timeout could not be established");
	}
	database.exec("PRAGMA synchronous=FULL");
	if (scalar(database, "PRAGMA synchronous") !== 2) {
		throw failure("ISSUANCE_DURABILITY_UNAVAILABLE", "SQLite FULL synchronous mode could not be established");
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
			database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
		} else if (lockedVersion === 2 && catalogMatches(lockedCatalog, V2_EXPECTED_CATALOG)) {
			database.exec(SETTLEMENT_PLANS_DDL);
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

function rawLineage(value: unknown, present: boolean): NativeLineage | undefined {
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
	return { exhausted: exhausted === 1, next, present: true, prunedThroughAuthorSequence: watermark };
}

function copyLineageRow(value: unknown): NativeLineageRow | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const objectId = Reflect.get(value, "object_id");
	const author = Reflect.get(value, "author");
	const lineage = rawLineage(value, true);
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
	const row = statement(
		database,
		`SELECT next,exhausted,pruned_through_author_sequence FROM ${table} WHERE object_id=? AND author=?`
	).get(scope.objectId, scope.author);
	return rawLineage(row, row !== undefined);
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
	return JSON.stringify(
		plan.entries.map((entry) => ({
			disposition: entry.disposition,
			replacementSequence: entry.replacementSequence,
			sourceDigest: [...entry.sourceDigest],
			sourceSequence: entry.sourceSequence,
		}))
	);
}

function copySettlementPlanRow(value: unknown, scope: DurableIssueScope): SettlementPlan | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const objectId = Reflect.get(value, "object_id");
	const author = Reflect.get(value, "author");
	const revision = Reflect.get(value, "revision");
	const fenceSequence = Reflect.get(value, "fence_sequence");
	const entriesJson = Reflect.get(value, "entries_json");
	if (objectId !== scope.objectId || author !== scope.author || typeof entriesJson !== "string") return undefined;
	try {
		const decoded: unknown = JSON.parse(entriesJson);
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
			return { ...entry, sourceDigest: Uint8Array.from(sourceDigest as number[]) };
		});
		return copySettlementPlan({ entries, fenceSequence, revision, scope }, scope);
	} catch {
		return undefined;
	}
}

function readSettlementPlanRow(database: DatabaseSync, scope: DurableIssueScope): SettlementPlan | null | undefined {
	const raw = statement(
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

class NodeIssuanceImplementation {
	readonly #database: DatabaseSync;
	#closed = false;
	#closePromise?: Promise<void>;
	#poison?: DurableIssuanceContractError;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	close(): Promise<void> {
		if (this.#closePromise !== undefined) return this.#closePromise;
		this.#closed = true;
		try {
			this.#database.close();
		} catch {
			// Close is an idempotent, non-rejecting capability operation.
		}
		this.#closePromise = Promise.resolve();
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
			if (status === "pending") {
				const changes = statement(
					this.#database,
					"UPDATE issuance_outbox SET publish_state = 'published' WHERE object_id=? AND author=? AND author_sequence=? AND digest=? AND publish_state = 'pending'"
				).run(captured.scope.objectId, captured.scope.author, captured.authorSequence, captured.digest).changes;
				if (changes !== 1) throw this.#latchCorruption("publication update changed an impossible row count");
			}
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
			const changes =
				current === null
					? statement(
							this.#database,
							"INSERT INTO settlement_plans (object_id,author,revision,fence_sequence,entries_json) VALUES(?,?,?,?,?)"
						).run(
							captured.scope.objectId,
							captured.scope.author,
							captured.plan.revision,
							captured.plan.fenceSequence,
							settlementPlanEntriesJson(captured.plan)
						).changes
					: statement(
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
			const lineageRows = statement(
				this.#database,
				"SELECT object_id,author,next,exhausted,pruned_through_author_sequence FROM lineages"
			).all();
			const issuedRows = statement(
				this.#database,
				"SELECT object_id,author,author_sequence,canonical_preimage,digest,signature FROM issued_records"
			).all();
			const outboxRows = statement(
				this.#database,
				"SELECT object_id,author,author_sequence,digest,publish_state FROM issuance_outbox"
			).all();
			this.#database.exec("COMMIT");
			const lineageByScope = new Map<string, NativeLineage>();
			for (const raw of lineageRows) {
				const row = copyLineageRow(raw);
				if (row === undefined) throw this.#latchCorruption("stored lineage is malformed");
				lineageByScope.set(this.#scopeKey(row), row);
			}
			const issuedByKey = new Map<string, NativeIssuedRow>();
			for (const raw of issuedRows) {
				const row = copyIssuedRow(raw);
				if (row === undefined) throw this.#latchCorruption("stored issued record is malformed");
				issuedByKey.set(this.#key(row, row.authorSequence), row);
			}
			const records: DurableIssuanceOutboxRecord[] = [];
			for (const raw of outboxRows) {
				const row = copyOutboxRow(raw);
				if (row === undefined) throw this.#latchCorruption("stored outbox row is malformed");
				const issued = issuedByKey.get(this.#key(row, row.authorSequence));
				if (issued === undefined || !bytesEqual(issued.digest, row.digest)) {
					throw this.#latchCorruption("outbox has no matching issued record");
				}
				const lineage = lineageByScope.get(this.#scopeKey(row));
				if (
					lineage === undefined ||
					!durableIssuanceLineageConsumed(lineage, row.authorSequence) ||
					durableIssuanceAddressIsPruned(lineage.prunedThroughAuthorSequence, row.authorSequence)
				) {
					throw this.#latchCorruption("stored outbox closure was not consumed by lineage");
				}
				issuedByKey.delete(this.#key(row, row.authorSequence));
				records.push({ commit: issuedCommit(issued), publishState: row.publishState });
			}
			if (issuedByKey.size !== 0) throw this.#latchCorruption("issued record has no matching outbox row");
			return records
				.filter(({ commit }) => parsed.scope === undefined || this.#sameScope(commit.issuedRecord.scope, parsed.scope))
				.sort((left, right) =>
					compareDurableIssuanceCompoundKeys(this.#commitKey(left.commit), this.#commitKey(right.commit))
				)
				.filter(
					({ commit }) =>
						parsed.afterKey === null || compareDurableIssuanceCompoundKeys(this.#commitKey(commit), parsed.afterKey) > 0
				)
				.slice(0, parsed.limit)
				.map(({ commit, publishState }) => ({ commit: cloneDurableIssueCommit(commit), publishState }));
		} catch (error) {
			try {
				this.#database.exec("ROLLBACK");
			} catch {
				// Preserve the read failure.
			}
			throw this.#mapOperationError(error, "outbox read failed");
		}
	}

	async transactIssue(scope: DurableIssueScope, buildAndSign: DurableBuildAndSign): Promise<DurableIssueCommit> {
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
		const built = await buildAndSign(prior.next);
		const candidate = copyAndValidateDurableIssueCommit(built, detached, prior.next);
		this.#assertAvailable();
		return this.#commitCandidate(detached, prior, candidate);
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
				const issuedRows = statement(
					this.#database,
					"SELECT object_id,author,author_sequence,canonical_preimage,digest,signature FROM issued_records WHERE object_id=? AND author=? AND author_sequence BETWEEN ? AND ? ORDER BY author_sequence"
				).all(captured.scope.objectId, captured.scope.author, pageFrom, pageThrough);
				const outboxRows = statement(
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
			const issuedChanges = statement(
				this.#database,
				"DELETE FROM issued_records WHERE object_id=? AND author=? AND author_sequence BETWEEN ? AND ?"
			).run(captured.scope.objectId, captured.scope.author, from, captured.throughAuthorSequence).changes;
			if (issuedChanges !== captured.throughAuthorSequence - from + 1) {
				throw this.#latchCorruption("issued deletion changed an impossible row count");
			}
			const outboxChanges = statement(
				this.#database,
				"DELETE FROM issuance_outbox WHERE object_id=? AND author=? AND author_sequence BETWEEN ? AND ?"
			).run(captured.scope.objectId, captured.scope.author, from, captured.throughAuthorSequence).changes;
			if (outboxChanges !== captured.throughAuthorSequence - from + 1) {
				throw this.#latchCorruption("outbox deletion changed an impossible row count");
			}
			const watermarkChanges = statement(
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

	#commitCandidate(scope: DurableIssueScope, prior: NativeLineage, candidate: DurableIssueCommit): DurableIssueCommit {
		let began = false;
		let committing = false;
		try {
			this.#database.exec("BEGIN IMMEDIATE");
			began = true;
			const current = readNativeLineage(this.#database, scope, "writer");
			if (current === undefined) throw this.#latchCorruption("stored lineage is malformed");
			if (!sameLineage(current, prior) || current.exhausted || candidate.authorSequence !== current.next) {
				this.#database.exec("ROLLBACK");
				began = false;
				throw failure("ISSUANCE_RETRY_REQUIRED", "author sequence changed while signing");
			}
			if (candidate.planEffect !== undefined) {
				const plan = readSettlementPlanRow(this.#database, scope);
				if (plan === undefined) throw this.#latchCorruption("stored settlement plan is malformed");
				if (plan === null) throw failure("ISSUANCE_RETRY_REQUIRED", "settlement plan is absent");
				const updated = applySettlementPlanEffect(plan, candidate.planEffect, candidate.authorSequence);
				const planChanges = statement(
					this.#database,
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
				lineageChanges = statement(
					this.#database,
					"INSERT INTO lineages (object_id,author,next,exhausted) VALUES(?,?,?,?)"
				).run(scope.objectId, scope.author, next, exhausted ? 1 : 0).changes;
			} else {
				lineageChanges = statement(
					this.#database,
					"UPDATE lineages SET next=?,exhausted=? WHERE object_id=? AND author=? AND next=? AND exhausted=?"
				).run(next, exhausted ? 1 : 0, scope.objectId, scope.author, prior.next, prior.exhausted ? 1 : 0).changes;
			}
			if (lineageChanges !== 1) throw this.#latchCorruption("lineage CAS changed an impossible row count");
			const issuedChanges = statement(
				this.#database,
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
			const outboxChanges = statement(
				this.#database,
				"INSERT INTO issuance_outbox (object_id,author,author_sequence,digest,publish_state) VALUES(?,?,?,?,?)"
			).run(scope.objectId, scope.author, candidate.authorSequence, candidate.envelope.digest, "pending").changes;
			if (outboxChanges !== 1) throw this.#latchCorruption("outbox insert changed an impossible row count");
			committing = true;
			this.#database.exec("COMMIT");
			began = false;
			committing = false;
		} catch (error) {
			if (began || committing) {
				try {
					this.#database.exec("ROLLBACK");
				} catch {
					// Preserve the mutation failure.
				}
			}
			if (committing) return this.#classifyAfterTerminalSuppression(scope, prior, candidate);
			if (error === this.#poison) throw error;
			if (this.#hasCode(error, "ISSUANCE_RETRY_REQUIRED")) throw error;
			if (this.#isConstraint(error)) throw this.#latchCorruption("issuance child-key collision");
			throw mapSubstrate(error, "issuance write failed");
		}
		return this.#classifyAfterTerminalSuppression(scope, prior, candidate);
	}

	#classifyAfterTerminalSuppression(
		scope: DurableIssueScope,
		prior: NativeLineage,
		candidate: DurableIssueCommit
	): DurableIssueCommit {
		const priorLineage = { exhausted: prior.exhausted, next: prior.next };
		let observation: TerminalReadback;
		try {
			observation = this.#readTerminal(scope, candidate.authorSequence, candidate);
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
		candidate: DurableIssueCommit
	): void {
		const effect = candidate.planEffect;
		if (effect === undefined) return;
		const linked =
			effect.kind === "fence"
				? plan?.fenceSequence === candidate.authorSequence
				: plan?.entries.some(
						(entry) =>
							entry.sourceSequence === effect.sourceSequence && entry.replacementSequence === candidate.authorSequence
					);
		if ((observation.issuedRecord !== null) !== linked) {
			throw this.#latchCorruption("issued row and settlement plan link are inconsistent");
		}
	}

	#readTerminal(scope: DurableIssueScope, authorSequence: number, candidate?: DurableIssueCommit): TerminalReadback {
		this.#database.exec("BEGIN");
		try {
			const observation = this.#queryTerminal(scope, authorSequence);
			if (candidate?.planEffect !== undefined) {
				const plan = readSettlementPlanRow(this.#database, scope);
				if (plan === undefined) throw this.#latchCorruption("stored settlement plan is malformed");
				this.#assertPlanEffectReadback(plan, observation, candidate);
			}
			this.#database.exec("COMMIT");
			return observation;
		} catch (error) {
			try {
				this.#database.exec("ROLLBACK");
			} catch {
				// Preserve the snapshot failure.
			}
			throw error;
		}
	}

	#queryTerminal(scope: DurableIssueScope, authorSequence: number): TerminalReadback {
		const lineage = readNativeLineage(this.#database, scope, "writer");
		const issuedRaw = statement(
			this.#database,
			"SELECT object_id,author,author_sequence,canonical_preimage,digest,signature FROM issued_records WHERE object_id=? AND author=? AND author_sequence=?"
		).get(scope.objectId, scope.author, authorSequence);
		const outboxRaw = statement(
			this.#database,
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

	#key(scope: DurableIssueScope, authorSequence: number): string {
		return `${this.#scopeKey(scope)}:${authorSequence}`;
	}

	#scopeKey(scope: DurableIssueScope): string {
		return `${scope.objectId.length}:${scope.objectId}${scope.author.length}:${scope.author}`;
	}

	#commitKey(commit: DurableIssueCommit): readonly [string, string, number] {
		return [commit.outboxEntry.scope.objectId, commit.outboxEntry.scope.author, commit.authorSequence];
	}

	#sameScope(left: DurableIssueScope, right: DurableIssueScope): boolean {
		return left.author === right.author && left.objectId === right.objectId;
	}
}

const maintenanceByStore = new WeakMap<
	DurableIssuanceStore,
	Readonly<{
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
export function createNodeDurableIssuanceStoreImplementation(options: unknown): DurableIssuanceStore {
	const primaryFilename = capturePrimaryFilename(options);
	let database: DatabaseSync;
	try {
		database = new DatabaseSync(`${primaryFilename}${DATABASE_SUFFIX}`, {
			allowExtension: false,
			enableDoubleQuotedStringLiterals: false,
			enableForeignKeyConstraints: false,
			readOnly: false,
		});
	} catch (error) {
		throw mapSubstrate(error, "issuance SQLite authority could not be opened", "permanent");
	}
	try {
		admit(database);
		const implementation = new NodeIssuanceImplementation(database);
		const store = Object.freeze({
			close: (): Promise<void> => implementation.close(),
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
		const maintenance = Object.freeze({
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
			inspectPruningState(scope: DurableIssueScope): Promise<DurableIssuancePruningState>;
			pruneAuthenticatedSettledPrefix(input: unknown): Promise<DurableIssuancePruningReceipt>;
			prunePublishedPrefix(input: unknown): Promise<DurableIssuancePruningReceipt>;
	  }>
	| undefined {
	return maintenanceByStore.get(store);
}
