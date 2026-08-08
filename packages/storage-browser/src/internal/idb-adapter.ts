import {
	type AheDurableStore,
	type BlobDigest,
	decodeGenerationRecordV1,
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

type Phase2dMutationOperation = Exclude<StorageAdapterCommand["kind"], "getBlob" | "readObjectState">;

type Lifecycle = { closed: boolean };

type TransactionOutcome = Readonly<{ ok: true }> | Readonly<{ cause: unknown; ok: false }>;

const STRICT_CAPABILITIES: Readonly<StoreCapabilities> = Object.freeze({
	durability: "strict",
	signingEligibility: "backend-capability-required",
});

const OPERATION_STORES = Object.freeze({
	beginGeneration: Object.freeze([PHASE_2D_OBJECTS_STORE, PHASE_2D_GENERATIONS_STORE]),
	completeGeneration: Object.freeze([
		PHASE_2D_OBJECTS_STORE,
		PHASE_2D_GENERATIONS_STORE,
		PHASE_2D_BLOBS_STORE,
		PHASE_2D_PROMOTIONS_STORE,
	]),
	discardGeneration: Object.freeze([PHASE_2D_OBJECTS_STORE, PHASE_2D_GENERATIONS_STORE]),
	getBlob: Object.freeze([PHASE_2D_BLOBS_STORE]),
	promoteReference: Object.freeze([
		PHASE_2D_OBJECTS_STORE,
		PHASE_2D_GENERATIONS_STORE,
		PHASE_2D_BLOBS_STORE,
		PHASE_2D_PROMOTIONS_STORE,
	]),
	putCachedBlob: Object.freeze([PHASE_2D_OBJECTS_STORE, PHASE_2D_GENERATIONS_STORE, PHASE_2D_BLOBS_STORE]),
	readObjectState: Object.freeze([PHASE_2D_OBJECTS_STORE, PHASE_2D_GENERATIONS_STORE]),
	swapHead: Object.freeze([PHASE_2D_OBJECTS_STORE, PHASE_2D_GENERATIONS_STORE]),
} satisfies Readonly<Record<StorageAdapterCommand["kind"], readonly string[]>>);

class StrictDurabilityCapabilityError extends Error {
	public readonly code = "NON_STRICT_DURABILITY";

	public constructor() {
		super("strict IndexedDB durability is required");
		this.name = "StrictDurabilityCapabilityError";
	}
}

class IdbAheDurableStore implements AheDurableStore {
	public readonly capabilities = STRICT_CAPABILITIES;

	public constructor(
		private readonly database: IDBDatabase,
		private readonly lifecycle: Lifecycle
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
		if (!this.lifecycle.closed) {
			this.lifecycle.closed = true;
			this.database.close();
		}
		return Promise.resolve();
	}

	private async run(command: unknown): Promise<StoreResult<unknown>> {
		const prepared = prepareStorageAdapterCommand(command);
		if (!prepared.ok) return prepared;
		if (this.lifecycle.closed) {
			return evaluateStorageAdapterCommand(prepared.value, [{ kind: "store-closed" }]).result;
		}
		return this.execute(prepared.value);
	}

	private async execute(prepared: PreparedStorageAdapterCommand): Promise<StoreResult<unknown>> {
		const operation = prepared.command.kind;
		const mutation = isMutation(operation);
		let transaction: IDBTransaction | undefined;
		let completion: Promise<TransactionOutcome> | undefined;
		try {
			transaction = mutation
				? this.database.transaction([...OPERATION_STORES[operation]], "readwrite", { durability: "strict" })
				: this.database.transaction([...OPERATION_STORES[operation]], "readonly");
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
			if (transaction !== undefined) abortIfActive(transaction);
			if (completion !== undefined) await completion;
			return substrateFailure(cause);
		}
	}

	private async loadFacts(
		transaction: IDBTransaction,
		prepared: PreparedStorageAdapterCommand
	): Promise<readonly StorageAdapterFact[]> {
		const facts: StorageAdapterFact[] = [];
		const generationRows = new Map<StorageObjectId, readonly unknown[]>();
		const loadedBlobs = new Set<BlobDigest>();
		const loadedPromotions = new Set<string>();
		for (const requirement of prepared.requirements) {
			switch (requirement.kind) {
				case "object-state": {
					const headRow = await requestValue(transaction.objectStore(PHASE_2D_OBJECTS_STORE).get(requirement.objectId));
					const rows = await requestValue(
						transaction.objectStore(PHASE_2D_GENERATIONS_STORE).getAll(generationPrefix(requirement.objectId))
					);
					facts.push({
						kind: "object-state",
						objectId: requirement.objectId,
						headRecord: headRow === undefined ? null : (rowProperty(headRow, "record") as Uint8Array),
						generationRecords: rows.map((row) => rowProperty(row, "record") as Uint8Array),
					});
					generationRows.set(requirement.objectId, rows);
					break;
				}
				case "blob":
					await this.loadBlob(transaction, requirement.digest, facts, loadedBlobs);
					break;
				case "promotion":
					await this.loadPromotion(transaction, requirement, facts, loadedPromotions);
					break;
				case "generation-closure": {
					const rows = generationRows.get(requirement.objectId);
					if (rows === undefined) throw new Error("generation closure loaded without its object state");
					const row = rows.find((candidate) => rowProperty(candidate, "generationId") === requirement.generationId);
					const record = rowProperty(row, "record");
					if (!(record instanceof Uint8Array)) break;
					const decoded = decodeGenerationRecordV1(new Uint8Array(record));
					if (
						!decoded.ok ||
						decoded.value.objectId !== requirement.objectId ||
						decoded.value.generationId !== requirement.generationId
					) {
						break;
					}
					for (const reference of decoded.value.closure) {
						await this.loadBlob(transaction, reference.digest, facts, loadedBlobs);
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

	private async loadBlob(
		transaction: IDBTransaction,
		digest: BlobDigest,
		facts: StorageAdapterFact[],
		loaded: Set<BlobDigest>
	): Promise<void> {
		if (loaded.has(digest)) return;
		const row = await requestValue(transaction.objectStore(PHASE_2D_BLOBS_STORE).get(digest));
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
		const row = await requestValue(
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

function generationPrefix(objectId: StorageObjectId): IDBKeyRange {
	return IDBKeyRange.bound([objectId], [objectId, []]);
}

function rowProperty(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
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
	const lifecycle: Lifecycle = { closed: false };
	const opaqueDatabase = await openPhase2dInternalDatabase(options, () => {
		lifecycle.closed = true;
	});
	return new IdbAheDurableStore(opaqueDatabase as IDBDatabase, lifecycle);
}
