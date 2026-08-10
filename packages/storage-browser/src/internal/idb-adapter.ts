import {
	type ActiveGenerationSnapshot,
	type AheDurableStore,
	type BlobDigest,
	type BlobExistencePort,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	type ExpectedHead,
	type GenerationId,
	type GenerationPage,
	type GenerationPageCursor,
	type GenerationRecord,
	type GenerationRef,
	parseBlobDigest,
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

import {
	openPhase2dInternalDatabase,
	PHASE_2D_BLOBS_STORE,
	PHASE_2D_GENERATIONS_STORE,
	PHASE_2D_OBJECTS_STORE,
	PHASE_2D_PROMOTIONS_STORE,
} from "./schema-idb.js";

export interface BrowserAheDurableStoreOptions {
	readonly databaseName: string;
}

export type BrowserAheDurableStore = AheDurableStore & BlobExistencePort;

type Phase2dMutationOperation = Exclude<StorageAdapterCommand["kind"], "getBlob" | "readGenerationPage" | "readHead">;

type TransactionOutcome = Readonly<{ ok: true }> | Readonly<{ cause: unknown; ok: false }>;

type HeadFact = Extract<StorageAdapterFact, { kind: "head" }>;

type TransactionHeadObservation = Readonly<{
	fact: HeadFact;
	head: ExpectedHead;
}>;

type TransactionHeadObservationResult =
	| Readonly<{ ok: true; value: TransactionHeadObservation }>
	| Readonly<{ ok: false; reason: PersistedStorageError["reason"] }>;

const STRICT_CAPABILITIES: Readonly<StoreCapabilities> = Object.freeze({
	durability: "strict",
	signingEligibility: "backend-capability-required",
});

const OPERATION_STORES = Object.freeze({
	beginGeneration: Object.freeze([PHASE_2D_GENERATIONS_STORE, PHASE_2D_OBJECTS_STORE]),
	completeGeneration: Object.freeze([
		PHASE_2D_BLOBS_STORE,
		PHASE_2D_GENERATIONS_STORE,
		PHASE_2D_OBJECTS_STORE,
		PHASE_2D_PROMOTIONS_STORE,
	]),
	discardGeneration: Object.freeze([PHASE_2D_GENERATIONS_STORE, PHASE_2D_OBJECTS_STORE]),
	getBlob: Object.freeze([PHASE_2D_BLOBS_STORE]),
	promoteReference: Object.freeze([
		PHASE_2D_OBJECTS_STORE,
		PHASE_2D_GENERATIONS_STORE,
		PHASE_2D_BLOBS_STORE,
		PHASE_2D_PROMOTIONS_STORE,
	]),
	putCachedBlob: Object.freeze([PHASE_2D_BLOBS_STORE, PHASE_2D_GENERATIONS_STORE, PHASE_2D_OBJECTS_STORE]),
	readGenerationPage: Object.freeze([PHASE_2D_GENERATIONS_STORE]),
	readHead: Object.freeze([PHASE_2D_OBJECTS_STORE]),
	swapHead: Object.freeze([
		PHASE_2D_BLOBS_STORE,
		PHASE_2D_GENERATIONS_STORE,
		PHASE_2D_OBJECTS_STORE,
		PHASE_2D_PROMOTIONS_STORE,
	]),
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
	private recoveryActive = false;
	private readonly recoveryWaiters: Array<(release: () => void) => void> = [];
	private resolveClose: (() => void) | undefined;
	private readonly invalidators = new Set<() => void>();

	public onInvalidation(invalidator: () => void): void {
		this.invalidators.add(invalidator);
	}

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

	public isClosed(): boolean {
		return this.connection === undefined;
	}

	public acquireRecoveryTurn(): (() => void) | Promise<() => void> {
		if (!this.recoveryActive) {
			this.recoveryActive = true;
			return () => this.releaseRecoveryTurn();
		}
		return new Promise((resolve) => this.recoveryWaiters.push(resolve));
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
		for (const invalidate of this.invalidators) invalidate();
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

	private releaseRecoveryTurn(): void {
		const next = this.recoveryWaiters.shift();
		if (next === undefined) {
			this.recoveryActive = false;
			return;
		}
		next(() => this.releaseRecoveryTurn());
	}
}

class PoisonedOperationError extends Error {
	public constructor() {
		super("operation observed a poisoned store");
		this.name = "PoisonedOperationError";
	}
}

class IdbAheDurableStore implements BrowserAheDurableStore {
	public readonly capabilities = STRICT_CAPABILITIES;
	private readonly recoveryCertificates = new Map<StorageObjectId, string>();

	public constructor(private readonly lifecycle: IdbAdapterLifecycle) {
		lifecycle.onInvalidation(() => this.recoveryCertificates.clear());
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

	public async probeBlobPresence(digests: readonly BlobDigest[]): Promise<StoreResult<readonly boolean[]>> {
		const copied = copyPresenceDigests(digests);
		if (copied === undefined) return { ok: false, reason: "INVALID_ARGUMENT" };
		const database = this.lifecycle.startOperation();
		if (database === undefined) return { ok: false, reason: "STORE_CLOSED" };
		let transaction: IDBTransaction | undefined;
		let completion: Promise<TransactionOutcome> | undefined;
		try {
			if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
			transaction = database.transaction(PHASE_2D_BLOBS_STORE, "readonly");
			completion = transactionOutcome(transaction);
			const store = transaction.objectStore(PHASE_2D_BLOBS_STORE);
			const uniqueDigests: BlobDigest[] = [];
			const uniqueIndex: Record<string, number> = Object.create(null) as Record<string, number>;
			for (const digest of copied) {
				if (uniqueIndex[digest] !== undefined) continue;
				uniqueIndex[digest] = uniqueDigests.length;
				uniqueDigests.push(digest);
			}
			const uniqueValues = await Promise.all(
				uniqueDigests.map(async (digest) => (await this.request(store.getKey(digest))) !== undefined)
			);
			const values = copied.map((digest) => uniqueValues[uniqueIndex[digest] ?? -1] ?? false);
			const outcome = await completion;
			if (!outcome.ok) return substrateFailure(outcome.cause);
			if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
			return { ok: true, value: Object.freeze(values) };
		} catch (cause) {
			if (transaction !== undefined) abortIfActive(transaction);
			if (completion !== undefined) await completion;
			return cause instanceof PoisonedOperationError
				? { ok: false, reason: "STORE_POISONED" }
				: substrateFailure(cause);
		} finally {
			this.lifecycle.finishOperation();
		}
	}

	public recoverActiveGeneration(objectId: StorageObjectId): Promise<StoreResult<ActiveGenerationSnapshot>> {
		const prepared = prepareStorageAdapterCommand({ kind: "readHead", objectId });
		if (!prepared.ok) return Promise.resolve(prepared);
		return this.runRecovery(objectId);
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
		this.recoveryCertificates.clear();
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
			const objectId = "objectId" in prepared.command ? prepared.command.objectId : undefined;
			let headObservation: TransactionHeadObservation | undefined;
			const authorityStores =
				mutation &&
				objectId !== undefined &&
				(operation === "completeGeneration" || operation === "swapHead" || this.recoveryCertificates.has(objectId));
			transaction = mutation
				? database.transaction(authorityStores ? allAuthorityStores() : [...OPERATION_STORES[operation]], "readwrite", {
						durability: "strict",
					})
				: database.transaction([...OPERATION_STORES[operation]], "readonly");
			completion = transactionOutcome(transaction);
			if (mutation && transaction.durability !== "strict") throw new StrictDurabilityCapabilityError();
			if (mutation) {
				if (!("objectId" in prepared.command)) throw new Error("mutation command lacks object scope");
				const observed = await this.observeHead(transaction, prepared.command.objectId);
				if (!observed.ok) {
					abortIfActive(transaction);
					await completion;
					return this.lifecycle.latchPoison(observed.reason);
				}
				headObservation = observed.value;
				const recovered = await this.ensureCertificate(
					transaction,
					headObservation,
					operation === "completeGeneration" || operation === "swapHead"
				);
				if (!recovered.ok) {
					abortIfActive(transaction);
					await completion;
					return this.lifecycle.latchPoison(recovered.reason as PersistedStorageError["reason"]);
				}
			}

			const facts = await this.loadFacts(transaction, prepared, headObservation);
			let evaluation = evaluateStorageAdapterCommand(prepared, facts);
			if (prepared.command.kind === "completeGeneration" || prepared.command.kind === "swapHead") {
				if (!evaluation.result.ok && evaluation.result.reason !== "INVALID_ARGUMENT") {
					abortIfActive(transaction);
					await completion;
					return evaluation.result;
				}
				const authorization = await this.verifyCandidate(
					transaction,
					prepared.command.objectId,
					prepared.command.generationId,
					facts
				);
				if (authorization === undefined || !authorization.ok) {
					abortIfActive(transaction);
					await completion;
					return authorization ?? { ok: false, reason: "INVALID_ARGUMENT" };
				}
				evaluation = evaluateStorageAdapterCommand(prepared, facts, authorization.value);
			}
			if (!evaluation.result.ok) {
				abortIfActive(transaction);
				await completion;
				return evaluation.result;
			}
			if (mutation) await this.applyWrites(transaction, evaluation);
			const outcome = await completion;
			if (!outcome.ok) {
				this.recoveryCertificates.clear();
				return substrateFailure(outcome.cause);
			}
			if (operation === "swapHead" && evaluation.result.ok) {
				const value = evaluation.result.value as Readonly<{ head: PresentHead }>;
				this.recoveryCertificates.set(prepared.command.objectId, headFingerprint(value.head));
			}
			return evaluation.result;
		} catch (cause) {
			this.recoveryCertificates.clear();
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
		prepared: PreparedStorageAdapterCommand,
		headObservation?: TransactionHeadObservation
	): Promise<readonly StorageAdapterFact[]> {
		const facts: StorageAdapterFact[] = [];
		const loadedBlobs = new Set<BlobDigest>();
		const loadedPromotions = new Set<string>();
		for (const requirement of prepared.requirements) {
			switch (requirement.kind) {
				case "head": {
					const observed = headObservation ?? (await this.requiredHeadObservation(transaction, requirement.objectId));
					if (observed.fact.objectId !== requirement.objectId)
						throw new Error("transaction head observation has the wrong object scope");
					facts.push(observed.fact);
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
				case "generation":
					await this.loadGeneration(transaction, requirement.objectId, requirement.generationId, facts);
					break;
				case "blob":
					await this.loadBlob(transaction, requirement.digest, facts, loadedBlobs);
					break;
				case "promotion":
					await this.loadPromotion(transaction, requirement, facts, loadedPromotions);
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
				await this.loadGeneration(transaction, prepared.command.objectId, decoded.value.generationId, facts);
		}
		return facts;
	}

	private async request<T>(request: IDBRequest<T>): Promise<T> {
		const value = await requestValue(request);
		if (this.lifecycle.isPoisoned()) throw new PoisonedOperationError();
		return value;
	}

	private async runRecovery(objectId: StorageObjectId): Promise<StoreResult<ActiveGenerationSnapshot>> {
		const database = this.lifecycle.startOperation();
		if (database === undefined) return { ok: false, reason: "STORE_CLOSED" };
		const recoveryTurn = this.lifecycle.acquireRecoveryTurn();
		const releaseRecoveryTurn = typeof recoveryTurn === "function" ? recoveryTurn : await recoveryTurn;
		let transaction: IDBTransaction | undefined;
		let completion: Promise<TransactionOutcome> | undefined;
		try {
			if (this.lifecycle.isClosed()) return { ok: false, reason: "STORE_CLOSED" };
			if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
			transaction = database.transaction(allAuthorityStores(), "readwrite", { durability: "strict" });
			completion = transactionOutcome(transaction);
			if (transaction.durability !== "strict") throw new StrictDurabilityCapabilityError();
			const result = await this.recoverWithinTransaction(transaction, objectId);
			if (!result.ok) {
				abortIfActive(transaction);
				await completion;
				return this.lifecycle.latchPoison(result.reason as PersistedStorageError["reason"]);
			}
			const outcome = await completion;
			if (!outcome.ok) {
				this.recoveryCertificates.clear();
				return substrateFailure(outcome.cause);
			}
			const snapshot = freezeRecoverySnapshot(result.value);
			this.recoveryCertificates.set(objectId, headFingerprint(snapshot.head));
			return { ok: true, value: snapshot };
		} catch (cause) {
			if (transaction !== undefined) abortIfActive(transaction);
			if (completion !== undefined) await completion;
			if (cause instanceof PoisonedOperationError) return { ok: false, reason: "STORE_POISONED" };
			this.recoveryCertificates.clear();
			return substrateFailure(cause);
		} finally {
			releaseRecoveryTurn();
			this.lifecycle.finishOperation();
		}
	}

	private async observeHead(
		transaction: IDBTransaction,
		objectId: StorageObjectId
	): Promise<TransactionHeadObservationResult> {
		const row = await this.request(transaction.objectStore(PHASE_2D_OBJECTS_STORE).get(objectId));
		const classified = classifyPersistedState({
			kind: "head",
			objectId,
			row: row === undefined ? null : { objectId: rowProperty(row, "objectId"), record: rowProperty(row, "record") },
		});
		if (!classified.ok) return classified;
		if (classified.value.kind !== "head") throw new Error("persisted classifier returned the wrong fact kind");
		return {
			ok: true,
			value: {
				fact: { headRecord: classified.value.record, kind: "head", objectId },
				head: classified.value.head,
			},
		};
	}

	private async requiredHeadObservation(
		transaction: IDBTransaction,
		objectId: StorageObjectId
	): Promise<TransactionHeadObservation> {
		const observed = await this.observeHead(transaction, objectId);
		if (!observed.ok) throw new PersistedStorageError(observed.reason);
		return observed.value;
	}

	private async ensureCertificate(
		transaction: IDBTransaction,
		headObservation: TransactionHeadObservation,
		required: boolean
	): Promise<StoreResult<undefined>> {
		const objectId = headObservation.fact.objectId;
		if (this.recoveryCertificates.get(objectId) === headFingerprint(headObservation.head))
			return { ok: true, value: undefined };
		if (!required && !this.recoveryCertificates.has(objectId)) return { ok: true, value: undefined };
		const recovered = await this.recoverWithinTransaction(transaction, objectId, headObservation);
		if (!recovered.ok) return recovered;
		this.recoveryCertificates.set(objectId, headFingerprint(recovered.value.head));
		return { ok: true, value: undefined };
	}

	private async recoverWithinTransaction(
		transaction: IDBTransaction,
		objectId: StorageObjectId,
		headObservation?: TransactionHeadObservation
	): Promise<StoreResult<ActiveGenerationSnapshot>> {
		const observed: TransactionHeadObservationResult =
			headObservation === undefined
				? await this.observeHead(transaction, objectId)
				: { ok: true, value: headObservation };
		if (!observed.ok) return observed;
		if (observed.value.fact.objectId !== objectId)
			throw new Error("transaction head observation has the wrong object scope");
		let after: GenerationId | null = null;
		let adopted: GenerationRecord | null = null;
		let count = 0;
		let failure: "NON_CANONICAL_RECORD" | "UNSUPPORTED_STORAGE_SCHEMA" | undefined;
		for (;;) {
			const rows = await this.request(
				transaction.objectStore(PHASE_2D_GENERATIONS_STORE).getAll(generationPageRange(objectId, after), 129)
			);
			for (const row of rows) {
				const classified = classifyPersistedState({
					kind: "generation",
					objectId,
					row: {
						objectId: rowProperty(row, "objectId"),
						generationId: rowProperty(row, "generationId"),
						record: rowProperty(row, "record"),
					},
				});
				if (!classified.ok)
					failure =
						failure === "UNSUPPORTED_STORAGE_SCHEMA" || classified.reason === "UNSUPPORTED_STORAGE_SCHEMA"
							? "UNSUPPORTED_STORAGE_SCHEMA"
							: "NON_CANONICAL_RECORD";
				else if (classified.value.kind === "generation" && classified.value.generation.state === "Adopted") {
					count++;
					adopted ??= classified.value.generation;
				}
			}
			if (rows.length < 129) break;
			const last = rowProperty(rows.at(-1), "generationId");
			if (typeof last !== "string") return { ok: false, reason: "NON_CANONICAL_RECORD" };
			after = last as GenerationId;
		}
		if (failure !== undefined) return { ok: false, reason: failure };
		const head = observed.value.head;
		if (head.kind === "none")
			return count === 0
				? {
						ok: true,
						value: { kind: "empty", head, adoptedGeneration: null, recomputedClosureDigest: null, references: [] },
					}
				: { ok: false, reason: "NON_CANONICAL_RECORD" };
		if (
			count !== 1 ||
			adopted === null ||
			adopted.generationId !== head.generationId ||
			adopted.closureDigest !== head.closureDigest
		)
			return { ok: false, reason: "NON_CANONICAL_RECORD" };
		const verified = await this.verifyClosure(transaction, objectId, adopted, "adopted");
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

	private async loadGeneration(
		transaction: IDBTransaction,
		objectId: StorageObjectId,
		generationId: GenerationId,
		facts: StorageAdapterFact[]
	): Promise<void> {
		const row = await this.request(transaction.objectStore(PHASE_2D_GENERATIONS_STORE).get([objectId, generationId]));
		if (row === undefined) {
			facts.push({ kind: "generation", objectId, generationId, generationRecord: null });
			return;
		}
		const classified = classifyPersistedState({
			kind: "generation",
			objectId,
			row: {
				objectId: rowProperty(row, "objectId"),
				generationId: rowProperty(row, "generationId"),
				record: rowProperty(row, "record"),
			},
		});
		if (!classified.ok) throw new PersistedStorageError(classified.reason);
		if (classified.value.kind !== "generation") throw new Error("wrong classifier kind");
		facts.push({ kind: "generation", objectId, generationId, generationRecord: classified.value.record });
	}

	private async verifyCandidate(
		transaction: IDBTransaction,
		objectId: StorageObjectId,
		generationId: GenerationId,
		facts: readonly StorageAdapterFact[]
	): Promise<StoreResult<unknown> | undefined> {
		const fact = facts.find(
			(value): value is Extract<StorageAdapterFact, { kind: "generation" }> =>
				value.kind === "generation" && value.objectId === objectId && value.generationId === generationId
		);
		if (fact?.generationRecord === null || fact === undefined) return undefined;
		const decoded = decodeGenerationRecordV1(fact.generationRecord);
		if (!decoded.ok) return { ok: false, reason: "NON_CANONICAL_RECORD" };
		return this.verifyClosure(transaction, objectId, decoded.value, "candidate");
	}

	private verifyClosure(
		transaction: IDBTransaction,
		objectId: StorageObjectId,
		generation: GenerationRecord,
		mode: "adopted" | "candidate"
	): Promise<StoreResult<unknown>> {
		const session = storageAdapterClosureVerifier.start(generation, mode);
		return new Promise((resolve, reject) => {
			const advance = (): void => {
				if (this.lifecycle.isPoisoned()) {
					reject(new PoisonedOperationError());
					return;
				}
				const verificationRequest = storageAdapterClosureVerifier.next(session);
				if (verificationRequest === null) {
					resolve(storageAdapterClosureVerifier.finish(session));
					return;
				}
				const request =
					verificationRequest.kind === "promotion"
						? transaction
								.objectStore(PHASE_2D_PROMOTIONS_STORE)
								.get([objectId, generation.generationId, verificationRequest.reference.digest])
						: transaction.objectStore(PHASE_2D_BLOBS_STORE).get(verificationRequest.reference.digest);
				request.addEventListener(
					"success",
					() => {
						if (verificationRequest.kind === "promotion")
							storageAdapterClosureVerifier.acceptPromotion(session, request.result !== undefined);
						else
							storageAdapterClosureVerifier.acceptBlob(
								session,
								request.result === undefined ? null : rowProperty(request.result, "bytes")
							);
						advance();
					},
					{ once: true }
				);
				request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
					once: true,
				});
			};
			advance();
		});
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

function allAuthorityStores(): string[] {
	return [PHASE_2D_BLOBS_STORE, PHASE_2D_GENERATIONS_STORE, PHASE_2D_OBJECTS_STORE, PHASE_2D_PROMOTIONS_STORE];
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

function copyPresenceDigests(value: unknown): readonly BlobDigest[] | undefined {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1 || !keys.includes("length")) return undefined;
	const copied: BlobDigest[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
			return undefined;
		}
		const parsed = typeof descriptor.value === "string" ? parseBlobDigest(descriptor.value) : undefined;
		if (parsed?.ok !== true) return undefined;
		copied.push(parsed.value);
	}
	return copied;
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

function headFingerprint(head: ExpectedHead): string {
	return head.kind === "none"
		? `none\0${head.objectId}`
		: `present\0${head.objectId}\0${head.generationId}\0${head.revision}\0${head.closureDigest}`;
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

function freezeRecoverySnapshot(snapshot: ActiveGenerationSnapshot): ActiveGenerationSnapshot {
	if (snapshot.kind === "empty") {
		return Object.freeze({
			...snapshot,
			head: Object.freeze({ ...snapshot.head }),
			references: Object.freeze([] as []),
		});
	}
	const adoptedGeneration = Object.freeze({
		...snapshot.adoptedGeneration,
		baseExpectedHead: Object.freeze({ ...snapshot.adoptedGeneration.baseExpectedHead }),
		closure: Object.freeze(snapshot.adoptedGeneration.closure.map((reference) => Object.freeze({ ...reference }))),
	});
	return Object.freeze({
		...snapshot,
		head: Object.freeze({ ...snapshot.head }),
		adoptedGeneration,
		references: Object.freeze(snapshot.references.map((reference) => Object.freeze({ ...reference }))),
	});
}

/**
 * Creates the production IndexedDB durable store.
 * @param options - Isolated schema-owned database options.
 * @returns A strict durable-store adapter over one validated connection.
 */
export async function createBrowserAheDurableStore(
	options: BrowserAheDurableStoreOptions
): Promise<BrowserAheDurableStore> {
	const lifecycle = new IdbAdapterLifecycle();
	const opaqueDatabase = await openPhase2dInternalDatabase(options, () => {
		void lifecycle.close();
	});
	lifecycle.attach(opaqueDatabase as IDBDatabase);
	return new IdbAheDurableStore(lifecycle);
}
