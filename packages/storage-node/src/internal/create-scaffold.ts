import {
	type AheDurableStore,
	type BlobDigest,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	type GenerationRef,
	type ObjectStoreState,
	type PresentHead,
	type StorageObjectId,
	type StoreCapabilities,
	type StoreResult,
} from "@ts-drp/storage";
import {
	evaluateStorageAdapterCommand,
	type PreparedStorageAdapterCommand,
	prepareStorageAdapterCommand,
	type StorageAdapterCommand,
	type StorageAdapterEvaluation,
	type StorageAdapterFact,
	type StorageAdapterWrite,
} from "@ts-drp/storage/adapter";
import { DatabaseSync } from "node:sqlite";

import type { SqliteAheDurableStoreOptions } from "../index.js";

export type SqliteMutationOperation = Exclude<StorageAdapterCommand["kind"], "getBlob" | "readObjectState">;

export type SqliteMutationFault = (
	checkpoint: Readonly<{ readonly edge: "before-commit"; readonly operation: "beginGeneration" }>
) => void;

export type SqliteMutationStatement =
	| "blob-insert"
	| "generation-insert"
	| "generation-update"
	| "head-upsert"
	| "object-ensure"
	| "promotion-insert";

export type SqliteCrashCheckpoint =
	| Readonly<{
			edge: "after-statement";
			occurrence: number;
			operation: SqliteMutationOperation;
			statement: SqliteMutationStatement;
	  }>
	| Readonly<{ edge: "after-commit" | "before-commit"; operation: SqliteMutationOperation }>;

export type SqliteCrashCheckpointObserver = (checkpoint: SqliteCrashCheckpoint) => void;

export type SqlitePragma = "foreign_keys" | "integrity_check" | "journal_mode" | "synchronous";

export type SqliteScaffoldInstrumentation = Readonly<{
	attemptInvalidForeignKeyInsert(): void;
	readPragma(pragma: SqlitePragma): unknown;
	store: AheDurableStore;
}>;

const STRICT_CAPABILITIES: Readonly<StoreCapabilities> = Object.freeze({
	durability: "strict",
	signingEligibility: "backend-capability-required",
});

const SCHEMA = `
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
`;

type DatabaseRow = Record<string, unknown>;

class SqliteAheDurableStore implements AheDurableStore {
	public readonly capabilities = STRICT_CAPABILITIES;
	private closed = false;

	public constructor(
		private readonly connection: DatabaseSync,
		private readonly fault?: SqliteMutationFault,
		private readonly crashObserver?: SqliteCrashCheckpointObserver
	) {}

	public readObjectState(objectId: StorageObjectId): Promise<StoreResult<ObjectStoreState>> {
		return this.run(commandWithKind("readObjectState", { objectId })) as Promise<StoreResult<ObjectStoreState>>;
	}

	public getBlob(digest: BlobDigest): Promise<StoreResult<Uint8Array | null>> {
		return this.run(commandWithKind("getBlob", { digest })) as Promise<StoreResult<Uint8Array | null>>;
	}

	public beginGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		baseExpectedHead: ExpectedHead;
		closure: readonly GenerationRef[];
	}): Promise<StoreResult<GenerationRecord>> {
		return this.run(commandWithKind("beginGeneration", input)) as Promise<StoreResult<GenerationRecord>>;
	}

	public putCachedBlob(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
		bytes: Uint8Array;
	}): Promise<StoreResult<{ inserted: boolean }>> {
		return this.run(commandWithKind("putCachedBlob", input)) as Promise<StoreResult<{ inserted: boolean }>>;
	}

	public promoteReference(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
	}): Promise<StoreResult<undefined>> {
		return this.run(commandWithKind("promoteReference", input)) as Promise<StoreResult<undefined>>;
	}

	public completeGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
	}): Promise<StoreResult<GenerationRecord>> {
		return this.run(commandWithKind("completeGeneration", input)) as Promise<StoreResult<GenerationRecord>>;
	}

	public swapHead(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		expectedHead: ExpectedHead;
	}): Promise<StoreResult<{ head: PresentHead; supersededGenerationId: GenerationId | null }>> {
		return this.run(commandWithKind("swapHead", input)) as Promise<
			StoreResult<{ head: PresentHead; supersededGenerationId: GenerationId | null }>
		>;
	}

	public discardGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
	}): Promise<StoreResult<GenerationRecord>> {
		return this.run(commandWithKind("discardGeneration", input)) as Promise<StoreResult<GenerationRecord>>;
	}

	public close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			this.connection.close();
		}
		return Promise.resolve();
	}

	private run(command: unknown): Promise<StoreResult<unknown>> {
		const prepared = prepareStorageAdapterCommand(command);
		if (!prepared.ok) return Promise.resolve(prepared);
		if (this.closed) {
			return Promise.resolve(evaluateStorageAdapterCommand(prepared.value, [{ kind: "store-closed" }]).result);
		}
		return Promise.resolve(this.execute(prepared.value));
	}

	private execute(prepared: PreparedStorageAdapterCommand): StoreResult<unknown> {
		const operation = prepared.command.kind;
		const mutation = isMutation(operation);
		const readTransaction = operation === "readObjectState";
		let transactionActive = false;
		let result: StoreResult<unknown>;
		try {
			if (mutation) {
				this.connection.exec("BEGIN IMMEDIATE");
				transactionActive = true;
			} else if (readTransaction) {
				this.connection.exec("BEGIN");
				transactionActive = true;
			}
			const facts = this.loadFacts(prepared);
			const evaluation = evaluateStorageAdapterCommand(prepared, facts);
			if (!evaluation.result.ok) {
				if (transactionActive) {
					this.connection.exec("ROLLBACK");
					transactionActive = false;
				}
				return evaluation.result;
			}
			if (mutation) {
				this.applyWrites(evaluation, operation);
				if (this.crashObserver === undefined) {
					if (operation === "beginGeneration") this.fault?.({ operation, edge: "before-commit" });
				} else {
					this.crashObserver({ operation, edge: "before-commit" });
				}
			}
			if (transactionActive) {
				this.connection.exec("COMMIT");
				transactionActive = false;
			}
			result = evaluation.result;
		} catch (cause) {
			if (transactionActive) {
				try {
					this.connection.exec("ROLLBACK");
				} catch {
					// The primary substrate failure remains the public cause.
				}
			}
			return { ok: false, reason: "SUBSTRATE_FAILURE", cause };
		}
		if (mutation) this.crashObserver?.({ operation, edge: "after-commit" });
		return result;
	}

	private loadFacts(prepared: PreparedStorageAdapterCommand): readonly StorageAdapterFact[] {
		const facts: StorageAdapterFact[] = [];
		const objectStates = new Map<StorageObjectId, ObjectStoreState>();
		const loadedBlobs = new Set<BlobDigest>();
		const loadedPromotions = new Set<string>();
		for (const requirement of prepared.requirements) {
			switch (requirement.kind) {
				case "object-state": {
					const loaded = this.loadObjectState(requirement.objectId);
					facts.push(loaded.fact);
					objectStates.set(requirement.objectId, loaded.state);
					break;
				}
				case "blob":
					this.loadBlob(requirement.digest, facts, loadedBlobs);
					break;
				case "promotion":
					this.loadPromotion(requirement, facts, loadedPromotions);
					break;
				case "generation-closure": {
					const state = objectStates.get(requirement.objectId);
					if (state === undefined) throw new Error("generation closure loaded without its object state");
					const generation = state.generations.find((record) => record.generationId === requirement.generationId);
					for (const reference of generation?.closure ?? []) {
						this.loadPromotion(
							{
								objectId: requirement.objectId,
								generationId: requirement.generationId,
								digest: reference.digest,
							},
							facts,
							loadedPromotions
						);
					}
					break;
				}
			}
		}
		return facts;
	}

	private loadObjectState(objectId: StorageObjectId): Readonly<{
		fact: Extract<StorageAdapterFact, { kind: "object-state" }>;
		state: ObjectStoreState;
	}> {
		const object = this.connection.prepare("SELECT head_record FROM objects WHERE object_id = ?").get(objectId) as
			| DatabaseRow
			| undefined;
		let head: ExpectedHead = { kind: "none", objectId };
		let headRecord: Uint8Array | null = null;
		if (object !== undefined && object.head_record !== null) {
			headRecord = databaseBytes(object.head_record);
			const decoded = decodeHeadRecordV1(headRecord);
			if (!decoded.ok || decoded.value.kind !== "present" || decoded.value.objectId !== objectId) {
				throw new Error("invalid persisted head record");
			}
			head = decoded.value;
		}
		const rows = this.connection
			.prepare("SELECT generation_id, record FROM generations WHERE object_id = ? ORDER BY generation_id")
			.all(objectId) as DatabaseRow[];
		const generationRecords: Uint8Array[] = [];
		const generations: GenerationRecord[] = [];
		for (const row of rows) {
			const record = databaseBytes(row.record);
			const decoded = decodeGenerationRecordV1(record);
			if (!decoded.ok || decoded.value.objectId !== objectId || decoded.value.generationId !== row.generation_id) {
				throw new Error("invalid persisted generation record");
			}
			generationRecords.push(record);
			generations.push(decoded.value);
		}
		const adopted = generations.filter(({ state }) => state === "Adopted");
		if (head.kind === "none" && adopted.length !== 0) {
			throw new Error("persisted adopted generation has no head");
		}
		if (
			head.kind === "present" &&
			(adopted.length !== 1 ||
				adopted[0]?.generationId !== head.generationId ||
				adopted[0].closureDigest !== head.closureDigest)
		) {
			throw new Error("persisted head does not name its exact adopted generation");
		}
		return {
			fact: { kind: "object-state", objectId, headRecord, generationRecords },
			state: { head, generations },
		};
	}

	private loadBlob(digest: BlobDigest, facts: StorageAdapterFact[], loaded: Set<BlobDigest>): void {
		if (loaded.has(digest)) return;
		const row = this.connection.prepare("SELECT bytes FROM blobs WHERE digest = ?").get(digest) as
			| DatabaseRow
			| undefined;
		facts.push({ kind: "blob", digest, bytes: row === undefined ? null : databaseBytes(row.bytes) });
		loaded.add(digest);
	}

	private loadPromotion(
		scope: Readonly<{ objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }>,
		facts: StorageAdapterFact[],
		loaded: Set<string>
	): void {
		const key = `${scope.objectId}\0${scope.generationId}\0${scope.digest}`;
		if (loaded.has(key)) return;
		const row = this.connection
			.prepare("SELECT 1 FROM promotions WHERE object_id = ? AND generation_id = ? AND digest = ?")
			.get(scope.objectId, scope.generationId, scope.digest);
		if (row !== undefined) facts.push({ kind: "promotion", ...scope });
		loaded.add(key);
	}

	private applyWrites(evaluation: StorageAdapterEvaluation, operation: SqliteMutationOperation): void {
		const occurrences = new Map<SqliteMutationStatement, number>();
		const observe = (statement: SqliteMutationStatement): void => {
			if (this.crashObserver === undefined) return;
			const occurrence = (occurrences.get(statement) ?? 0) + 1;
			occurrences.set(statement, occurrence);
			this.crashObserver({ edge: "after-statement", occurrence, operation, statement });
		};
		for (const write of evaluation.writes) this.applyWrite(write, observe);
	}

	private applyWrite(write: StorageAdapterWrite, observe: (statement: SqliteMutationStatement) => void): void {
		switch (write.kind) {
			case "replace-generation": {
				const decoded = decodeGenerationRecordV1(write.record);
				if (
					!decoded.ok ||
					decoded.value.objectId !== write.objectId ||
					decoded.value.generationId !== write.generationId
				) {
					throw new Error("adapter emitted an invalid generation write");
				}
				this.connection
					.prepare("INSERT OR IGNORE INTO objects(object_id, head_record) VALUES (?, NULL)")
					.run(write.objectId);
				observe("object-ensure");
				const exists = this.connection
					.prepare("SELECT 1 FROM generations WHERE object_id = ? AND generation_id = ?")
					.get(write.objectId, write.generationId);
				const statement =
					exists === undefined
						? this.connection.prepare("INSERT INTO generations(object_id, generation_id, record) VALUES (?, ?, ?)")
						: this.connection.prepare("UPDATE generations SET record = ? WHERE object_id = ? AND generation_id = ?");
				const result =
					exists === undefined
						? statement.run(write.objectId, write.generationId, new Uint8Array(write.record))
						: statement.run(new Uint8Array(write.record), write.objectId, write.generationId);
				observe(exists === undefined ? "generation-insert" : "generation-update");
				requireOneChange(result.changes, "generation write");
				return;
			}
			case "replace-head": {
				const decoded = decodeHeadRecordV1(write.record);
				if (!decoded.ok || decoded.value.kind !== "present" || decoded.value.objectId !== write.objectId) {
					throw new Error("adapter emitted an invalid head write");
				}
				const result = this.connection
					.prepare(
						"INSERT INTO objects(object_id, head_record) VALUES (?, ?) " +
							"ON CONFLICT(object_id) DO UPDATE SET head_record = excluded.head_record"
					)
					.run(write.objectId, new Uint8Array(write.record));
				observe("head-upsert");
				requireOneChange(result.changes, "head write");
				return;
			}
			case "insert-blob": {
				const result = this.connection
					.prepare("INSERT INTO blobs(digest, bytes) VALUES (?, ?)")
					.run(write.digest, new Uint8Array(write.bytes));
				observe("blob-insert");
				requireOneChange(result.changes, "blob insert");
				return;
			}
			case "insert-promotion": {
				const result = this.connection
					.prepare("INSERT INTO promotions(object_id, generation_id, digest) VALUES (?, ?, ?)")
					.run(write.objectId, write.generationId, write.digest);
				observe("promotion-insert");
				requireOneChange(result.changes, "promotion insert");
			}
		}
	}
}

function isMutation(kind: StorageAdapterCommand["kind"]): kind is SqliteMutationOperation {
	return kind !== "readObjectState" && kind !== "getBlob";
}

function commandWithKind(kind: StorageAdapterCommand["kind"], input: unknown): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return { kind, invalidInput: input };
	const descriptors = Object.getOwnPropertyDescriptors(input);
	if (Object.prototype.hasOwnProperty.call(descriptors, "kind")) return { kind, invalidInput: true };
	const command = { kind } as Record<PropertyKey, unknown>;
	Object.defineProperties(command, descriptors);
	return command;
}

function databaseBytes(value: unknown): Uint8Array {
	if (!(value instanceof Uint8Array)) throw new Error("SQLite returned a non-BLOB value");
	return new Uint8Array(value);
}

function requireOneChange(changes: number | bigint, label: string): void {
	if (Number(changes) !== 1) throw new Error(`${label} did not affect exactly one row`);
}

function configureConnection(connection: DatabaseSync): void {
	connection.exec("PRAGMA busy_timeout = 1000");
	connection.exec("PRAGMA journal_mode = WAL");
	connection.exec("PRAGMA synchronous = FULL");
	connection.exec("PRAGMA foreign_keys = ON");
	connection.exec(SCHEMA);
}

/**
 * Creates the production SQLite store.
 * @param options - File-backed SQLite options.
 * @param fault - Optional bounded test-only fault callback.
 * @returns A strict store over one configured connection.
 * @internal
 */
export function createSqliteScaffold(
	options: SqliteAheDurableStoreOptions,
	fault?: SqliteMutationFault
): AheDurableStore {
	return createInstrumentedSqliteScaffold(options, fault).store;
}

/**
 * Creates the store and exact live-connection probes used by the package-local RED.
 * @param options - File-backed SQLite options.
 * @param fault - Optional bounded test-only fault callback.
 * @param crashObserver - Optional expanded process-death checkpoint observer.
 * @returns Store and non-exported connection instrumentation.
 * @internal
 */
export function createInstrumentedSqliteScaffold(
	options: SqliteAheDurableStoreOptions,
	fault?: SqliteMutationFault,
	crashObserver?: SqliteCrashCheckpointObserver
): SqliteScaffoldInstrumentation {
	const connection = new DatabaseSync(options.filename);
	try {
		configureConnection(connection);
	} catch (error) {
		connection.close();
		throw error;
	}
	return {
		attemptInvalidForeignKeyInsert: (): void => {
			connection.exec(
				"CREATE TEMP TABLE phase_2c_parent(id INTEGER PRIMARY KEY);" +
					"CREATE TEMP TABLE phase_2c_child(parent_id INTEGER REFERENCES phase_2c_parent(id));"
			);
			try {
				connection.prepare("INSERT INTO phase_2c_child(parent_id) VALUES (?)").run(1);
			} finally {
				connection.exec("DROP TABLE phase_2c_child;DROP TABLE phase_2c_parent;");
			}
		},
		readPragma: (pragma): unknown => {
			const row = connection.prepare(`PRAGMA ${pragma}`).get();
			return row === undefined ? undefined : Object.values(row)[0];
		},
		store: new SqliteAheDurableStore(connection, fault, crashObserver),
	};
}
