import {
	type AheDurableStore,
	type BlobDigest,
	type ExpectedHead,
	type GenerationId,
	type GenerationPage,
	type GenerationPageCursor,
	type GenerationRecord,
	type GenerationRef,
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
	type StorageAdapterCommand,
	type StorageAdapterEvaluation,
	type StorageAdapterFact,
	type StorageAdapterWrite,
} from "@ts-drp/storage/adapter";

import {
	openPhase2dInternalDatabase,
	PHASE_2D_BLOBS_STORE,
	PHASE_2D_GENERATIONS_STORE,
	PHASE_2D_OBJECTS_STORE,
	PHASE_2D_PROMOTIONS_STORE,
} from "./schema-idb.js";

export interface Phase2dAheDurableStoreOptions {
	readonly databaseName: string;
}

type Phase2dMutationOperation = Exclude<StorageAdapterCommand["kind"], "getBlob" | "readGenerationPage" | "readHead">;

type TransactionOutcome = Readonly<{ ok: true }> | Readonly<{ cause: unknown; ok: false }>;

const STRICT_CAPABILITIES: Readonly<StoreCapabilities> = Object.freeze({
	durability: "strict",
	signingEligibility: "backend-capability-required",
});

const OPERATION_STORES = Object.freeze({
	beginGeneration: Object.freeze([PHASE_2D_OBJECTS_STORE, PHASE_2D_GENERATIONS_STORE]),
	completeGeneration: Object.freeze([PHASE_2D_OBJECTS_STORE, PHASE_2D_GENERATIONS_STORE, PHASE_2D_PROMOTIONS_STORE]),
	discardGeneration: Object.freeze([PHASE_2D_OBJECTS_STORE, PHASE_2D_GENERATIONS_STORE]),
	getBlob: Object.freeze([PHASE_2D_BLOBS_STORE]),
	promoteReference: Object.freeze([
		PHASE_2D_OBJECTS_STORE,
		PHASE_2D_GENERATIONS_STORE,
		PHASE_2D_BLOBS_STORE,
		PHASE_2D_PROMOTIONS_STORE,
	]),
	putCachedBlob: Object.freeze([PHASE_2D_OBJECTS_STORE, PHASE_2D_GENERATIONS_STORE, PHASE_2D_BLOBS_STORE]),
	readGenerationPage: Object.freeze([PHASE_2D_GENERATIONS_STORE]),
	readHead: Object.freeze([PHASE_2D_OBJECTS_STORE]),
	swapHead: Object.freeze([PHASE_2D_OBJECTS_STORE, PHASE_2D_GENERATIONS_STORE]),
} satisfies Readonly<Record<StorageAdapterCommand["kind"], readonly string[]>>);

class StrictDurabilityCapabilityError extends Error {
	public readonly code = "NON_STRICT_DURABILITY";

	public constructor() {
		super("strict IndexedDB durability is required");
		this.name = "StrictDurabilityCapabilityError";
	}
}

class IdbAdapterLifecycle {
	private activeOperations = 0;
	private closePromise: Promise<void> | undefined;
	private connection: IDBDatabase | undefined;
	private poisoned = false;
	private resolveClose: (() => void) | undefined;

	public attach(database: IDBDatabase): void {
		if (this.closePromise !== undefined) {
			database.close();
			return;
		}
		if (this.connection !== undefined) throw new Error("IndexedDB lifecycle already attached");
		this.connection = database;
	}

	public startOperation(): IDBDatabase | undefined {
		const database = this.connection;
		if (database === undefined) return undefined;
		this.activeOperations += 1;
		return database;
	}

	public isPoisoned(): boolean {
		return this.poisoned;
	}

	public latchPoison(reason: PersistedStorageError["reason"]): StoreResult<never> {
		if (this.poisoned) return { ok: false, reason: "STORE_POISONED" };
		this.poisoned = true;
		return { ok: false, reason };
	}

	public finishOperation(): void {
		this.activeOperations -= 1;
		this.resolveIfQuiescent();
	}

	public close(): Promise<void> {
		this.closePromise ??= new Promise((resolve) => {
			this.resolveClose = resolve;
		});
		const database = this.connection;
		if (database !== undefined) {
			this.connection = undefined;
			database.close();
		}
		this.resolveIfQuiescent();
		return this.closePromise;
	}

	private resolveIfQuiescent(): void {
		if (this.connection !== undefined || this.activeOperations !== 0) return;
		const resolve = this.resolveClose;
		this.resolveClose = undefined;
		if (resolve !== undefined) queueMicrotask(resolve);
	}
}

class PoisonedOperationError extends Error {
	public constructor() {
		super("operation observed a poisoned store");
		this.name = "PoisonedOperationError";
	}
}

class IdbAheDurableStore implements AheDurableStore {
	public readonly capabilities = STRICT_CAPABILITIES;

	public constructor(private readonly lifecycle: IdbAdapterLifecycle) {}

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
		return this.lifecycle.close();
	}

	private async run(command: unknown): Promise<StoreResult<unknown>> {
		const prepared = prepareStorageAdapterCommand(command);
		if (!prepared.ok) return prepared;
		const database = this.lifecycle.startOperation();
		if (database === undefined) {
			return evaluateStorageAdapterCommand(prepared.value, [{ kind: "store-closed" }]).result;
		}
		try {
			if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
			return await this.execute(database, prepared.value);
		} finally {
			this.lifecycle.finishOperation();
		}
	}

	private async execute(database: IDBDatabase, prepared: PreparedStorageAdapterCommand): Promise<StoreResult<unknown>> {
		const operation = prepared.command.kind;
		const mutation = isMutation(operation);
		let transaction: IDBTransaction | undefined;
		let completion: Promise<TransactionOutcome> | undefined;
		try {
			transaction = mutation
				? database.transaction([...OPERATION_STORES[operation]], "readwrite", { durability: "strict" })
				: database.transaction([...OPERATION_STORES[operation]], "readonly");
			completion = transactionOutcome(transaction);
			if (mutation && transaction.durability !== "strict") throw new StrictDurabilityCapabilityError();

			const facts = await this.loadFacts(transaction, prepared);
			const evaluation = evaluateStorageAdapterCommand(prepared, facts);
			if (!evaluation.result.ok) {
				abortIfActive(transaction);
				await completion;
				return evaluation.result;
			}
			if (mutation) await this.applyWrites(transaction, evaluation);
			const outcome = await completion;
			if (!outcome.ok) return substrateFailure(outcome.cause);
			return evaluation.result;
		} catch (cause) {
			const semanticResult =
				cause instanceof PersistedStorageError
					? this.lifecycle.latchPoison(cause.reason)
					: cause instanceof PoisonedOperationError
						? ({ ok: false, reason: "STORE_POISONED" } as const)
						: undefined;
			if (transaction !== undefined) abortIfActive(transaction);
			if (completion !== undefined) await completion;
			return semanticResult ?? substrateFailure(cause);
		}
	}

	private async loadFacts(
		transaction: IDBTransaction,
		prepared: PreparedStorageAdapterCommand
	): Promise<readonly StorageAdapterFact[]> {
		const facts: StorageAdapterFact[] = [];
		const objectStates = new Map<
			StorageObjectId,
			Readonly<{ head: ExpectedHead; generations: readonly GenerationRecord[] }>
		>();
		const loadedBlobs = new Set<BlobDigest>();
		const loadedPromotions = new Set<string>();
		for (const requirement of prepared.requirements) {
			switch (requirement.kind) {
				case "head": {
					const headRow = await this.request(transaction.objectStore(PHASE_2D_OBJECTS_STORE).get(requirement.objectId));
					const classified = classifyPersistedState({
						kind: "head",
						objectId: requirement.objectId,
						row:
							headRow === undefined
								? null
								: { objectId: rowProperty(headRow, "objectId"), record: rowProperty(headRow, "record") },
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
					const rows = await this.request(
						transaction
							.objectStore(PHASE_2D_GENERATIONS_STORE)
							.getAll(
								generationPageRange(requirement.objectId, requirement.afterGenerationId),
								requirement.limitPlusOne
							)
					);
					facts.push({
						afterGenerationId: requirement.afterGenerationId,
						generationRecords: rows.map((row) => boundGenerationRecord(row, requirement.objectId)),
						kind: "generation-page",
						objectId: requirement.objectId,
					});
					break;
				}
				case "object-state": {
					const headRow = await this.request(transaction.objectStore(PHASE_2D_OBJECTS_STORE).get(requirement.objectId));
					const rows = await this.request(
						transaction.objectStore(PHASE_2D_GENERATIONS_STORE).getAll(generationPrefix(requirement.objectId))
					);
					const classified = classifyPersistedState({
						generationRows: rows.map((row) => ({
							generationId: rowProperty(row, "generationId"),
							objectId: rowProperty(row, "objectId"),
							record: rowProperty(row, "record"),
						})),
						headRow:
							headRow === undefined
								? null
								: { objectId: rowProperty(headRow, "objectId"), record: rowProperty(headRow, "record") },
						kind: "physical",
						objectId: requirement.objectId,
					});
					if (!classified.ok) throw new PersistedStorageError(classified.reason);
					if (classified.value.kind !== "object-state") {
						throw new Error("persisted classifier returned the wrong fact kind");
					}
					facts.push(classified.value.fact);
					objectStates.set(requirement.objectId, classified.value.state);
					break;
				}
				case "blob":
					await this.loadBlob(transaction, requirement.digest, facts, loadedBlobs);
					break;
				case "promotion":
					await this.loadPromotion(transaction, requirement, facts, loadedPromotions);
					break;
				case "generation-closure": {
					const state = objectStates.get(requirement.objectId);
					if (state === undefined) throw new Error("generation closure loaded without its object state");
					const generation = state.generations.find((candidate) => candidate.generationId === requirement.generationId);
					for (const reference of generation?.closure ?? []) {
						await this.loadPromotion(
							transaction,
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

	private async request<T>(request: IDBRequest<T>): Promise<T> {
		const value = await requestValue(request);
		if (this.lifecycle.isPoisoned()) throw new PoisonedOperationError();
		return value;
	}

	private async loadBlob(
		transaction: IDBTransaction,
		digest: BlobDigest,
		facts: StorageAdapterFact[],
		loaded: Set<BlobDigest>
	): Promise<void> {
		if (loaded.has(digest)) return;
		const row = await this.request(transaction.objectStore(PHASE_2D_BLOBS_STORE).get(digest));
		facts.push({
			kind: "blob",
			digest,
			bytes: row === undefined ? null : (rowProperty(row, "bytes") as Uint8Array),
		});
		loaded.add(digest);
	}

	private async loadPromotion(
		transaction: IDBTransaction,
		scope: Readonly<{ objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }>,
		facts: StorageAdapterFact[],
		loaded: Set<string>
	): Promise<void> {
		const key = promotionKey(scope);
		if (loaded.has(key)) return;
		const row = await this.request(
			transaction.objectStore(PHASE_2D_PROMOTIONS_STORE).get([scope.objectId, scope.generationId, scope.digest])
		);
		if (row !== undefined) facts.push({ kind: "promotion", ...scope });
		loaded.add(key);
	}

	private async applyWrites(transaction: IDBTransaction, evaluation: StorageAdapterEvaluation): Promise<void> {
		for (const write of evaluation.writes) await this.applyWrite(transaction, write);
	}

	private async applyWrite(transaction: IDBTransaction, write: StorageAdapterWrite): Promise<void> {
		switch (write.kind) {
			case "replace-generation":
				await requestValue(
					transaction.objectStore(PHASE_2D_GENERATIONS_STORE).put({
						generationId: write.generationId,
						objectId: write.objectId,
						record: new Uint8Array(write.record),
					})
				);
				return;
			case "replace-head":
				await requestValue(
					transaction.objectStore(PHASE_2D_OBJECTS_STORE).put({
						objectId: write.objectId,
						record: new Uint8Array(write.record),
					})
				);
				return;
			case "insert-blob":
				await requestValue(
					transaction.objectStore(PHASE_2D_BLOBS_STORE).add({
						bytes: new Uint8Array(write.bytes),
						digest: write.digest,
					})
				);
				return;
			case "insert-promotion":
				await requestValue(
					transaction.objectStore(PHASE_2D_PROMOTIONS_STORE).add({
						digest: write.digest,
						generationId: write.generationId,
						objectId: write.objectId,
					})
				);
		}
	}
}

function isMutation(kind: StorageAdapterCommand["kind"]): kind is Phase2dMutationOperation {
	return kind !== "readHead" && kind !== "readGenerationPage" && kind !== "getBlob";
}

function commandWithKind(kind: StorageAdapterCommand["kind"], input: unknown): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return { kind, invalidInput: input };
	const descriptors = Object.getOwnPropertyDescriptors(input);
	if (Object.prototype.hasOwnProperty.call(descriptors, "kind")) return { kind, invalidInput: true };
	const command = { kind } as Record<PropertyKey, unknown>;
	Object.defineProperties(command, descriptors);
	return command;
}

function generationPrefix(objectId: StorageObjectId): IDBKeyRange {
	return IDBKeyRange.bound([objectId], [objectId, []]);
}

function generationPageRange(objectId: StorageObjectId, afterGenerationId: GenerationId | null): IDBKeyRange {
	return afterGenerationId === null
		? generationPrefix(objectId)
		: IDBKeyRange.bound([objectId, afterGenerationId], [objectId, []], true, false);
}

function rowProperty(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function boundGenerationRecord(row: unknown, objectId: StorageObjectId): Uint8Array {
	const classified = classifyPersistedState({
		kind: "generation",
		objectId,
		row: {
			generationId: rowProperty(row, "generationId"),
			objectId: rowProperty(row, "objectId"),
			record: rowProperty(row, "record"),
		},
	});
	if (!classified.ok) throw new PersistedStorageError(classified.reason);
	if (classified.value.kind !== "generation") throw new Error("persisted classifier returned the wrong fact kind");
	return classified.value.record;
}

function promotionKey(value: { objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }): string {
	return `${value.objectId}\0${value.generationId}\0${value.digest}`;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});
}

function transactionOutcome(transaction: IDBTransaction): Promise<TransactionOutcome> {
	return new Promise((resolve) => {
		let observedError: unknown;
		transaction.addEventListener("complete", () => resolve({ ok: true }), { once: true });
		transaction.addEventListener(
			"abort",
			() =>
				resolve({
					cause: transaction.error ?? observedError ?? new Error("IndexedDB transaction aborted"),
					ok: false,
				}),
			{ once: true }
		);
		transaction.addEventListener(
			"error",
			() => {
				observedError ??= transaction.error ?? new Error("IndexedDB transaction failed");
			},
			{ once: true }
		);
	});
}

function abortIfActive(transaction: IDBTransaction): void {
	try {
		transaction.abort();
	} catch {
		// The original semantic or substrate failure remains authoritative.
	}
}

function substrateFailure(cause: unknown): StoreResult<never> {
	return { ok: false, reason: "SUBSTRATE_FAILURE", cause };
}

/**
 * Creates the private production IndexedDB durable store.
 * @param options - Isolated schema-owned database options.
 * @returns A strict durable-store adapter over one validated connection.
 * @internal
 */
export async function createPhase2dAheDurableStore(options: Phase2dAheDurableStoreOptions): Promise<AheDurableStore> {
	const lifecycle = new IdbAdapterLifecycle();
	const opaqueDatabase = await openPhase2dInternalDatabase(options, () => {
		void lifecycle.close();
	});
	lifecycle.attach(opaqueDatabase as IDBDatabase);
	return new IdbAheDurableStore(lifecycle);
}
