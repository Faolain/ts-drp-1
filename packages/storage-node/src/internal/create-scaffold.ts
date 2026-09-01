import {
	type ActiveGenerationSnapshot,
	type AheDurableStore,
	type BlobDigest,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	type ExpectedHead,
	type GenerationId,
	type GenerationPage,
	type GenerationPageCursor,
	type GenerationRecord,
	type GenerationRef,
	parseGenerationId,
	type PresentHead,
	type StorageObjectId,
	type StoreCapabilities,
	type StoreResult,
} from "@ts-drp/storage";
import {
	classifyPersistedState,
	evaluateStorageAdapterCommand,
	PersistedStorageError,
	type PreparedStorageAdapterCommand,
	prepareStorageAdapterCommand,
	storageAdapterClosureVerifier,
	type StorageAdapterCommand,
	type StorageAdapterEvaluation,
	type StorageAdapterFact,
	type StorageAdapterWrite,
} from "@ts-drp/storage/adapter";
import { DatabaseSync } from "node:sqlite";

import type { SqliteAheDurableStoreOptions } from "../index.js";
import { registerNodeAheReclamationMaintenance } from "./ahe-reclamation.js";

export type SqliteMutationOperation = Exclude<
	StorageAdapterCommand["kind"],
	"getBlob" | "readGenerationPage" | "readHead"
>;

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
const EXPECTED_COLUMNS = Object.freeze({
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
	blobs: Object.freeze([]),
	generations: Object.freeze(["objects:object_id:object_id"]),
	objects: Object.freeze([]),
	promotions: Object.freeze([
		"blobs:digest:digest",
		"generations:generation_id:generation_id",
		"generations:object_id:object_id",
	]),
} as const);

class SqliteAheDurableStore implements AheDurableStore {
	public readonly capabilities = STRICT_CAPABILITIES;
	private closed = false;
	private poisoned = false;
	private readonly recoveryCertificates = new Map<StorageObjectId, string>();

	public constructor(
		private readonly connection: DatabaseSync,
		private readonly fault?: SqliteMutationFault,
		private readonly crashObserver?: SqliteCrashCheckpointObserver
	) {
		registerNodeAheReclamationMaintenance(this, connection, {
			isClosed: () => this.closed,
			isPoisoned: () => this.poisoned,
			latchPoison: () => {
				this.poisoned = true;
				this.recoveryCertificates.clear();
			},
		});
	}

	public readHead(objectId: StorageObjectId): Promise<StoreResult<ExpectedHead>> {
		return this.run(commandWithKind("readHead", { objectId })) as Promise<StoreResult<ExpectedHead>>;
	}

	public readGenerationPage(input: {
		readonly objectId: StorageObjectId;
		readonly cursor?: GenerationPageCursor;
		readonly limit: number;
	}): Promise<StoreResult<GenerationPage>> {
		return this.run(commandWithKind("readGenerationPage", input)) as Promise<StoreResult<GenerationPage>>;
	}

	public getBlob(digest: BlobDigest): Promise<StoreResult<Uint8Array | null>> {
		return this.run(commandWithKind("getBlob", { digest })) as Promise<StoreResult<Uint8Array | null>>;
	}
	public recoverActiveGeneration(objectId: StorageObjectId): Promise<StoreResult<ActiveGenerationSnapshot>> {
		const prepared = prepareStorageAdapterCommand({ kind: "readHead", objectId });
		if (!prepared.ok) return Promise.resolve(prepared);
		if (this.closed) return Promise.resolve({ ok: false, reason: "STORE_CLOSED" });
		if (this.poisoned) return Promise.resolve({ ok: false, reason: "STORE_POISONED" });
		return Promise.resolve(this.recoverTransaction(objectId));
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
			this.recoveryCertificates.clear();
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
		if (this.poisoned) return Promise.resolve({ ok: false, reason: "STORE_POISONED" });
		return Promise.resolve(this.execute(prepared.value));
	}

	private execute(prepared: PreparedStorageAdapterCommand): StoreResult<unknown> {
		const operation = prepared.command.kind;
		const mutation = isMutation(operation);
		let transactionActive = false;
		let result: StoreResult<unknown>;
		try {
			if (mutation) {
				this.connection.exec("BEGIN IMMEDIATE");
				transactionActive = true;
				if (!("objectId" in prepared.command)) throw new Error("mutation command lacks object scope");
				const recovered = this.ensureCertificate(
					prepared.command.objectId,
					operation === "completeGeneration" || operation === "swapHead"
				);
				if (!recovered.ok) {
					this.poisoned = true;
					this.connection.exec("ROLLBACK");
					transactionActive = false;
					return recovered;
				}
			}
			const facts = this.loadFacts(prepared);
			let evaluation = evaluateStorageAdapterCommand(prepared, facts);
			if (prepared.command.kind === "completeGeneration" || prepared.command.kind === "swapHead") {
				if (!evaluation.result.ok && evaluation.result.reason !== "INVALID_ARGUMENT") {
					this.connection.exec("ROLLBACK");
					transactionActive = false;
					return evaluation.result;
				}
				const authorization = this.verifyCandidate(prepared.command.objectId, prepared.command.generationId, facts);
				if (authorization === undefined || !authorization.ok) {
					this.connection.exec("ROLLBACK");
					transactionActive = false;
					return authorization ?? { ok: false, reason: "INVALID_ARGUMENT" };
				}
				evaluation = evaluateStorageAdapterCommand(prepared, facts, authorization.value);
			}
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
			if (mutation && operation === "swapHead" && result.ok) {
				const swap = result.value as Readonly<{ head: PresentHead }>;
				this.recoveryCertificates.set(prepared.command.objectId, headFingerprint(swap.head));
			}
		} catch (cause) {
			this.recoveryCertificates.clear();
			const persistedReason = cause instanceof PersistedStorageError ? cause.reason : undefined;
			if (persistedReason !== undefined) this.poisoned = true;
			if (transactionActive) {
				try {
					this.connection.exec("ROLLBACK");
				} catch {
					// The primary substrate failure remains the public cause.
				}
			}
			return persistedReason === undefined
				? { ok: false, reason: "SUBSTRATE_FAILURE", cause }
				: { ok: false, reason: persistedReason };
		}
		if (mutation) this.crashObserver?.({ operation, edge: "after-commit" });
		return result;
	}

	private loadFacts(prepared: PreparedStorageAdapterCommand): readonly StorageAdapterFact[] {
		const facts: StorageAdapterFact[] = [];
		const loadedBlobs = new Set<BlobDigest>();
		const loadedPromotions = new Set<string>();
		for (const requirement of prepared.requirements) {
			switch (requirement.kind) {
				case "head": {
					const row = this.connection
						.prepare("SELECT head_record FROM objects WHERE object_id = ?")
						.get(requirement.objectId) as DatabaseRow | undefined;
					const classified = classifyPersistedState({
						kind: "head",
						objectId: requirement.objectId,
						row: row === undefined ? null : { objectId: requirement.objectId, record: row.head_record },
					});
					if (!classified.ok) throw new PersistedStorageError(classified.reason);
					if (classified.value.kind !== "head") throw new Error("persisted classifier returned the wrong fact kind");
					facts.push({
						headRecord: classified.value.record,
						kind: "head",
						objectId: requirement.objectId,
					});
					break;
				}
				case "generation-page": {
					const rows = (
						requirement.afterGenerationId === null
							? this.connection
									.prepare(
										"SELECT generation_id, record FROM generations WHERE object_id = ? ORDER BY generation_id LIMIT ?"
									)
									.all(requirement.objectId, requirement.limitPlusOne)
							: this.connection
									.prepare(
										"SELECT generation_id, record FROM generations WHERE object_id = ? AND generation_id > ? ORDER BY generation_id LIMIT ?"
									)
									.all(requirement.objectId, requirement.afterGenerationId, requirement.limitPlusOne)
					) as DatabaseRow[];
					facts.push({
						afterGenerationId: requirement.afterGenerationId,
						generationRecords: rows.map((row) => boundGenerationRecord(row, requirement.objectId)),
						kind: "generation-page",
						objectId: requirement.objectId,
					});
					break;
				}
				case "generation":
					this.loadGeneration(requirement.objectId, requirement.generationId, facts);
					break;
				case "blob":
					this.loadBlob(requirement.digest, facts, loadedBlobs);
					break;
				case "promotion":
					this.loadPromotion(requirement, facts, loadedPromotions);
					break;
			}
		}
		if (prepared.command.kind === "swapHead") {
			const headFact = facts.find(
				(fact): fact is Extract<StorageAdapterFact, { kind: "head" }> => fact.kind === "head"
			);
			const decoded =
				headFact?.headRecord === null || headFact === undefined ? undefined : decodeHeadRecordV1(headFact.headRecord);
			if (
				decoded?.ok === true &&
				decoded.value.kind === "present" &&
				decoded.value.generationId !== prepared.command.generationId
			)
				this.loadGeneration(prepared.command.objectId, decoded.value.generationId, facts);
		}
		return facts;
	}
	private loadGeneration(objectId: StorageObjectId, generationId: GenerationId, facts: StorageAdapterFact[]): void {
		const row = this.connection
			.prepare("SELECT record FROM generations WHERE object_id = ? AND generation_id = ?")
			.get(objectId, generationId) as DatabaseRow | undefined;
		if (row === undefined) {
			facts.push({ kind: "generation", objectId, generationId, generationRecord: null });
			return;
		}
		const classified = classifyPersistedState({
			kind: "generation",
			objectId,
			row: { objectId, generationId, record: row.record },
		});
		if (!classified.ok) throw new PersistedStorageError(classified.reason);
		if (classified.value.kind !== "generation") throw new Error("persisted classifier returned wrong kind");
		facts.push({ kind: "generation", objectId, generationId, generationRecord: classified.value.record });
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

	private recoverTransaction(objectId: StorageObjectId): StoreResult<ActiveGenerationSnapshot> {
		let active = false;
		try {
			this.connection.exec("BEGIN IMMEDIATE");
			active = true;
			const result = this.recoverWithinTransaction(objectId);
			if (!result.ok) {
				this.poisoned = true;
				this.connection.exec("ROLLBACK");
				active = false;
				return result;
			}
			this.connection.exec("COMMIT");
			active = false;
			const snapshot = freezeRecoverySnapshot(result.value);
			this.recoveryCertificates.set(objectId, headFingerprint(snapshot.head));
			return { ok: true, value: snapshot };
		} catch (cause) {
			this.recoveryCertificates.clear();
			if (active)
				try {
					this.connection.exec("ROLLBACK");
				} catch {
					/* preserve cause */
				}
			return { ok: false, reason: "SUBSTRATE_FAILURE", cause };
		}
	}

	private ensureCertificate(objectId: StorageObjectId, required: boolean): StoreResult<undefined> {
		const head = this.readHeadWithinTransaction(objectId);
		if (!head.ok) return head;
		if (this.recoveryCertificates.get(objectId) === headFingerprint(head.value)) return { ok: true, value: undefined };
		if (!required && !this.recoveryCertificates.has(objectId)) return { ok: true, value: undefined };
		const recovered = this.recoverWithinTransaction(objectId);
		if (!recovered.ok) return recovered;
		this.recoveryCertificates.set(objectId, headFingerprint(recovered.value.head));
		return { ok: true, value: undefined };
	}

	private readHeadWithinTransaction(objectId: StorageObjectId): StoreResult<ExpectedHead> {
		const row = this.connection.prepare("SELECT head_record FROM objects WHERE object_id = ?").get(objectId) as
			| DatabaseRow
			| undefined;
		const classified = classifyPersistedState({
			kind: "head",
			objectId,
			row: row === undefined ? null : { objectId, record: row.head_record },
		});
		return classified.ok && classified.value.kind === "head"
			? { ok: true, value: classified.value.head }
			: (classified as StoreResult<ExpectedHead>);
	}

	private recoverWithinTransaction(objectId: StorageObjectId): StoreResult<ActiveGenerationSnapshot> {
		const headResult = this.readHeadWithinTransaction(objectId);
		if (!headResult.ok) return headResult;
		let after: string | null = null;
		let adopted: GenerationRecord | null = null;
		let adoptedCount = 0;
		let failure: "NON_CANONICAL_RECORD" | "UNSUPPORTED_STORAGE_SCHEMA" | undefined;
		for (;;) {
			const rows = (
				after === null
					? this.connection
							.prepare(
								"SELECT generation_id, record FROM generations WHERE object_id = ? ORDER BY generation_id LIMIT ?"
							)
							.all(objectId, 129)
					: this.connection
							.prepare(
								"SELECT generation_id, record FROM generations WHERE object_id = ? AND generation_id > ? ORDER BY generation_id LIMIT ?"
							)
							.all(objectId, after, 129)
			) as DatabaseRow[];
			for (const row of rows) {
				const classified = classifyPersistedState({
					kind: "generation",
					objectId,
					row: { objectId, generationId: row.generation_id, record: row.record },
				});
				if (!classified.ok)
					failure =
						failure === "UNSUPPORTED_STORAGE_SCHEMA" || classified.reason === "UNSUPPORTED_STORAGE_SCHEMA"
							? "UNSUPPORTED_STORAGE_SCHEMA"
							: "NON_CANONICAL_RECORD";
				else if (classified.value.kind === "generation" && classified.value.generation.state === "Adopted") {
					adoptedCount++;
					adopted ??= classified.value.generation;
				}
			}
			if (rows.length < 129) break;
			const cursor = rows.at(-1)?.generation_id;
			if (typeof cursor !== "string") return { ok: false, reason: "NON_CANONICAL_RECORD" };
			const parsedCursor = parseGenerationId(cursor);
			if (!parsedCursor.ok) return { ok: false, reason: "NON_CANONICAL_RECORD" };
			after = parsedCursor.value;
		}
		if (failure !== undefined) return { ok: false, reason: failure };
		const head = headResult.value;
		if (head.kind === "none")
			return adoptedCount === 0
				? {
						ok: true,
						value: { kind: "empty", head, adoptedGeneration: null, recomputedClosureDigest: null, references: [] },
					}
				: { ok: false, reason: "NON_CANONICAL_RECORD" };
		if (
			adoptedCount !== 1 ||
			adopted === null ||
			adopted.generationId !== head.generationId ||
			adopted.closureDigest !== head.closureDigest
		)
			return { ok: false, reason: "NON_CANONICAL_RECORD" };
		const verified = this.verifyClosure(objectId, adopted, "adopted");
		if (!verified.ok) return verified;
		return {
			ok: true,
			value: {
				kind: "active",
				head: { ...head },
				adoptedGeneration: {
					...adopted,
					baseExpectedHead: { ...adopted.baseExpectedHead },
					closure: adopted.closure.map((r) => ({ ...r })),
				},
				recomputedClosureDigest: adopted.closureDigest,
				references: adopted.closure.map((r) => ({ ...r })),
			},
		};
	}

	private verifyCandidate(
		objectId: StorageObjectId,
		generationId: GenerationId,
		facts: readonly StorageAdapterFact[]
	): StoreResult<unknown> | undefined {
		const fact = facts.find(
			(value): value is Extract<StorageAdapterFact, { kind: "generation" }> =>
				value.kind === "generation" && value.objectId === objectId && value.generationId === generationId
		);
		if (fact?.generationRecord === null || fact === undefined) return undefined;
		const decoded = decodeGenerationRecordV1(fact.generationRecord);
		if (!decoded.ok) return { ok: false, reason: "NON_CANONICAL_RECORD" };
		return this.verifyClosure(objectId, decoded.value, "candidate");
	}

	private verifyClosure(
		objectId: StorageObjectId,
		generation: GenerationRecord,
		mode: "adopted" | "candidate"
	): StoreResult<unknown> {
		const session = storageAdapterClosureVerifier.start(generation, mode);
		for (
			let request = storageAdapterClosureVerifier.next(session);
			request !== null;
			request = storageAdapterClosureVerifier.next(session)
		) {
			if (request.kind === "promotion") {
				const present =
					this.connection
						.prepare("SELECT 1 FROM promotions WHERE object_id = ? AND generation_id = ? AND digest = ?")
						.get(objectId, generation.generationId, request.reference.digest) !== undefined;
				storageAdapterClosureVerifier.acceptPromotion(session, present);
			} else {
				const row = this.connection
					.prepare("SELECT bytes FROM blobs WHERE digest = ?")
					.get(request.reference.digest) as DatabaseRow | undefined;
				storageAdapterClosureVerifier.acceptBlob(session, row === undefined ? null : row.bytes);
			}
		}
		return storageAdapterClosureVerifier.finish(session);
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
	return kind !== "readHead" && kind !== "readGenerationPage" && kind !== "getBlob";
}

function headFingerprint(head: ExpectedHead): string {
	return head.kind === "none"
		? `none\0${head.objectId}`
		: `present\0${head.objectId}\0${head.generationId}\0${head.revision}\0${head.closureDigest}`;
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

function boundGenerationRecord(row: DatabaseRow, objectId: StorageObjectId): Uint8Array {
	const classified = classifyPersistedState({
		kind: "generation",
		objectId,
		row: { generationId: row.generation_id, objectId, record: row.record },
	});
	if (!classified.ok) throw new PersistedStorageError(classified.reason);
	if (classified.value.kind !== "generation") throw new Error("persisted classifier returned the wrong fact kind");
	return classified.value.record;
}

function requireOneChange(changes: number | bigint, label: string): void {
	if (Number(changes) !== 1) throw new Error(`${label} did not affect exactly one row`);
}

function hasExpectedPhysicalSchema(connection: DatabaseSync): boolean {
	const tables = connection
		.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
		.all() as DatabaseRow[];
	const expectedNames = Object.keys(EXPECTED_COLUMNS).sort();
	if (tables.length !== expectedNames.length || tables.some((row, index) => row.name !== expectedNames[index])) {
		return false;
	}
	for (const tableName of expectedNames as (keyof typeof EXPECTED_COLUMNS)[]) {
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

function configureConnection(connection: DatabaseSync): void {
	connection.exec("PRAGMA busy_timeout = 1000");
	connection.exec("PRAGMA foreign_keys = ON");
	const tableCount = (
		connection
			.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.get() as DatabaseRow
	).count;
	if (Number(tableCount) === 0) {
		connection.exec("BEGIN IMMEDIATE");
		try {
			connection.exec(SCHEMA);
			if (!hasExpectedPhysicalSchema(connection)) throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
			connection.exec("COMMIT");
		} catch (error) {
			try {
				connection.exec("ROLLBACK");
			} catch {
				// Preserve the primary schema-creation failure.
			}
			throw error;
		}
	}
	if (!hasExpectedPhysicalSchema(connection)) throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
	connection.exec("PRAGMA journal_mode = WAL");
	connection.exec("PRAGMA synchronous = FULL");
}

function freezeRecoverySnapshot(snapshot: ActiveGenerationSnapshot): ActiveGenerationSnapshot {
	if (snapshot.kind === "empty")
		return Object.freeze({
			...snapshot,
			head: Object.freeze({ ...snapshot.head }),
			references: Object.freeze([] as []),
		});
	return Object.freeze({
		...snapshot,
		head: Object.freeze({ ...snapshot.head }),
		adoptedGeneration: Object.freeze({
			...snapshot.adoptedGeneration,
			baseExpectedHead: Object.freeze({ ...snapshot.adoptedGeneration.baseExpectedHead }),
			closure: Object.freeze(snapshot.adoptedGeneration.closure.map((reference) => Object.freeze({ ...reference }))),
		}),
		references: Object.freeze(snapshot.references.map((reference) => Object.freeze({ ...reference }))),
	});
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
