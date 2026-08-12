import {
	assertDurableIssueScope,
	classifyDurableIssuanceTerminalSuppression,
	cloneDurableIssueCommit,
	compareDurableIssuanceCompoundKeys,
	copyAndValidateDurableIssueCommit,
	copyDurableIssuanceBytes,
	copyDurableIssueScope,
	createDurableIssuanceFailure,
	DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT,
	type DurableBuildAndSign,
	DurableIssuanceContractError,
	DurableIssuanceInvalidArgumentError,
	type DurableIssuanceNativeOutboxRecord,
	type DurableIssuanceOutboxRecord,
	type DurableIssuanceStore,
	type DurableIssueCommit,
	type DurableIssuedRecord,
	type DurableIssueScope,
	type DurableLineage,
	type DurableOutboxPageInput,
	durablePreimageMatchesScopeAndSequence,
	isValidDurableAuthorSequence,
	isValidDurableScopeField,
	MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT,
} from "@ts-drp/issuance-store";
import { DatabaseSync, type StatementSync } from "node:sqlite";

const DATABASE_SUFFIX = ".drp-issuance-v1.sqlite";
const SCHEMA_VERSION = 1;
const PAGE_SIZE = 4096;
const BUSY_TIMEOUT = 1000;

const LINEAGES_DDL =
	"CREATE TABLE lineages (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  next INTEGER NOT NULL CHECK(next BETWEEN 0 AND 9007199254740991),\n  exhausted INTEGER NOT NULL CHECK(exhausted IN (0,1)),\n  PRIMARY KEY (object_id,author)\n) WITHOUT ROWID";
const ISSUED_RECORDS_DDL =
	"CREATE TABLE issued_records (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  author_sequence INTEGER NOT NULL CHECK(author_sequence BETWEEN 0 AND 9007199254740991),\n  canonical_preimage BLOB NOT NULL CHECK(typeof(canonical_preimage) = 'blob' AND length(canonical_preimage) > 0),\n  digest BLOB NOT NULL CHECK(typeof(digest) = 'blob' AND length(digest) > 0),\n  signature BLOB NOT NULL CHECK(typeof(signature) = 'blob' AND length(signature) > 0),\n  PRIMARY KEY (object_id,author,author_sequence)\n) WITHOUT ROWID";
const ISSUANCE_OUTBOX_DDL =
	"CREATE TABLE issuance_outbox (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  author_sequence INTEGER NOT NULL CHECK(author_sequence BETWEEN 0 AND 9007199254740991),\n  digest BLOB NOT NULL CHECK(typeof(digest) = 'blob' AND length(digest) > 0),\n  publish_state TEXT NOT NULL CHECK(publish_state IN ('pending','published')),\n  PRIMARY KEY (object_id,author,author_sequence)\n) WITHOUT ROWID";

const DDL = Object.freeze([LINEAGES_DDL, ISSUED_RECORDS_DDL, ISSUANCE_OUTBOX_DDL] as const);
const EXPECTED_CATALOG = Object.freeze([
	Object.freeze({ name: "issuance_outbox", sql: ISSUANCE_OUTBOX_DDL, type: "table" }),
	Object.freeze({ name: "issued_records", sql: ISSUED_RECORDS_DDL, type: "table" }),
	Object.freeze({ name: "lineages", sql: LINEAGES_DDL, type: "table" }),
] as const);

interface NativeLineage extends DurableLineage {
	readonly present: boolean;
}

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
	if (error instanceof DurableIssuanceContractError || error instanceof DurableIssuanceInvalidArgumentError) {
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

function catalogMatches(rows: readonly Record<string, unknown>[]): boolean {
	return (
		rows.length === EXPECTED_CATALOG.length &&
		rows.every((row, index) => {
			const expected = EXPECTED_CATALOG[index];
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
	const initialPageSize = scalar(database, "PRAGMA page_size");
	const initialJournal = String(scalar(database, "PRAGMA journal_mode")).toLowerCase();
	const fresh = initialCatalog.length === 0 && initialVersion === 0;
	if (!fresh) {
		if (
			initialVersion !== SCHEMA_VERSION ||
			initialPageSize !== PAGE_SIZE ||
			initialJournal !== "wal" ||
			!catalogMatches(initialCatalog)
		) {
			throw unsupported("existing issuance SQLite authority is unsupported");
		}
		verifyAuthority(database);
		return;
	}

	database.exec(`PRAGMA page_size=${PAGE_SIZE}`);
	if (scalar(database, "PRAGMA page_size") !== PAGE_SIZE) {
		throw failure("ISSUANCE_DURABILITY_UNAVAILABLE", "SQLite page size could not be established");
	}
	const journalResult = scalar(database, "PRAGMA journal_mode=WAL");
	if (String(journalResult).toLowerCase() !== "wal") {
		throw failure("ISSUANCE_DURABILITY_UNAVAILABLE", "SQLite WAL mode could not be established");
	}
	database.exec("BEGIN IMMEDIATE");
	try {
		for (const sql of DDL) database.exec(sql);
		database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
		if (!catalogMatches(catalog(database)) || scalar(database, "PRAGMA user_version") !== SCHEMA_VERSION) {
			throw unsupported("fresh issuance SQLite authority did not match its exact schema");
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
	if (!present) return { exhausted: false, next: 0, present: false };
	if (typeof value !== "object" || value === null) return undefined;
	const next = Reflect.get(value, "next");
	const exhausted = Reflect.get(value, "exhausted");
	if (
		!isValidDurableAuthorSequence(next) ||
		(exhausted !== 0 && exhausted !== 1) ||
		(exhausted === 1 && next !== Number.MAX_SAFE_INTEGER)
	) {
		return undefined;
	}
	return { exhausted: exhausted === 1, next, present: true };
}

function readNativeLineage(
	database: DatabaseSync,
	scope: DurableIssueScope,
	authority: "snapshot" | "writer" = "snapshot"
): NativeLineage | undefined {
	const table = authority === "writer" ? "lineages" : "main.lineages";
	const row = statement(database, `SELECT next,exhausted FROM ${table} WHERE object_id=? AND author=?`).get(
		scope.objectId,
		scope.author
	);
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
		if (observation.issuedRecord === null && observation.outboxRecord === null) return null;
		if (
			observation.issuedRecord === null ||
			observation.outboxRecord === null ||
			observation.issuedRecord.authorSequence !== authorSequence ||
			observation.outboxRecord.authorSequence !== authorSequence ||
			!bytesEqual(observation.issuedRecord.envelope.digest, observation.outboxRecord.digest) ||
			!(
				observation.lineage.next > authorSequence ||
				(observation.lineage.exhausted && observation.lineage.next === authorSequence)
			)
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
	async readOutboxPage(input: DurableOutboxPageInput = {}): Promise<readonly DurableIssuanceOutboxRecord[]> {
		this.#assertAvailable();
		const parsed = this.#parsePageInput(input);
		try {
			this.#database.exec("BEGIN");
			const issuedRows = statement(
				this.#database,
				"SELECT object_id,author,author_sequence,canonical_preimage,digest,signature FROM issued_records"
			).all();
			const outboxRows = statement(
				this.#database,
				"SELECT object_id,author,author_sequence,digest,publish_state FROM issuance_outbox"
			).all();
			this.#database.exec("COMMIT");
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
			observation = this.#readTerminal(scope, candidate.authorSequence);
		} catch (error) {
			if (error === this.#poison) throw error;
			return classifyDurableIssuanceTerminalSuppression({
				candidate,
				observation: { unreadable: true },
				priorLineage,
				scope,
			});
		}
		try {
			return classifyDurableIssuanceTerminalSuppression({
				candidate,
				observation,
				priorLineage,
				scope,
			});
		} catch (error) {
			if (this.#hasCode(error, "ISSUANCE_RECOVERY_CORRUPT")) {
				throw this.#latchCorruption("terminal issuance readback is corrupt");
			}
			throw error;
		}
	}

	#readTerminal(scope: DurableIssueScope, authorSequence: number): TerminalReadback {
		this.#database.exec("BEGIN");
		try {
			const lineage = readNativeLineage(this.#database, scope, "writer");
			const issuedRaw = statement(
				this.#database,
				"SELECT object_id,author,author_sequence,canonical_preimage,digest,signature FROM issued_records WHERE object_id=? AND author=? AND author_sequence=?"
			).get(scope.objectId, scope.author, authorSequence);
			const outboxRaw = statement(
				this.#database,
				"SELECT object_id,author,author_sequence,digest,publish_state FROM issuance_outbox WHERE object_id=? AND author=? AND author_sequence=?"
			).get(scope.objectId, scope.author, authorSequence);
			this.#database.exec("COMMIT");
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
			};
		} catch (error) {
			try {
				this.#database.exec("ROLLBACK");
			} catch {
				// Preserve the snapshot failure.
			}
			throw error;
		}
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
		return `${scope.objectId.length}:${scope.objectId}${scope.author.length}:${scope.author}:${authorSequence}`;
	}

	#commitKey(commit: DurableIssueCommit): readonly [string, string, number] {
		return [commit.outboxEntry.scope.objectId, commit.outboxEntry.scope.author, commit.authorSequence];
	}

	#sameScope(left: DurableIssueScope, right: DurableIssueScope): boolean {
		return left.author === right.author && left.objectId === right.objectId;
	}
}

/**
 * Creates one exact Node SQLite issuance capability.
 * @param options - Untrusted exact Node factory options.
 * @returns A frozen plain five-method facade.
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
		return Object.freeze({
			close: (): Promise<void> => implementation.close(),
			readIssued: (scope: DurableIssueScope, authorSequence: number) =>
				implementation.readIssued(scope, authorSequence),
			readLineage: (scope: DurableIssueScope) => implementation.readLineage(scope),
			readOutboxPage: (input?: DurableOutboxPageInput) => implementation.readOutboxPage(input),
			transactIssue: (scope: DurableIssueScope, buildAndSign: DurableBuildAndSign) =>
				implementation.transactIssue(scope, buildAndSign),
		});
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
