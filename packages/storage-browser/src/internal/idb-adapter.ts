import { encodeCanonical } from "@ts-drp/canonical";
import {
	type ActiveGenerationSnapshot,
	type AheBoundedReadAcquisition,
	type AheBoundedReadInput,
	type AheBoundedRecoveryRoleRead,
	type AheBoundedRecoveryRoleReadInput,
	type AheBoundedRecoveryRoleStore,
	type AheRetirementAdmissionImage,
	type AheRetirementControl,
	type AheRetirementControlRead,
	aheRetirementGenerationBindingMatches,
	aheRetirementNativeCommands,
	type AheRetirementNativeMutation,
	aheRetirementReclamationMatches,
	type BlobDigest,
	type BlobExistencePort,
	createAheRetirementControlRead,
	decodeAheRetirementControl,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	encodeAheRetirementControl,
	type ExpectedHead,
	type GenerationId,
	type GenerationPage,
	type GenerationPageCursor,
	type GenerationRecord,
	type GenerationRef,
	parseBlobDigest,
	parseStorageObjectId,
	type PresentHead,
	type StorageObjectId,
	type StoreCapabilities,
	type StoreResult,
} from "@ts-drp/storage";
import {
	boundedActiveReadSteps,
	boundedHeadSteps,
	BoundedReadBudgetError,
	BoundedReadNativeFacts,
	type BoundedReadRequest,
	boundedRecoveryRoleReadSteps,
	classifyPersistedState,
	createBoundedReadAcquisition,
	createBoundedRecoveryRoleRead,
	evaluateStorageAdapterCommand,
	isBoundedReadCorruption,
	PersistedStorageError,
	prepareBoundedRead,
	prepareBoundedRecoveryRoleRead,
	type PreparedStorageAdapterCommand,
	prepareStorageAdapterCommand,
	storageAdapterClosureVerifier,
	type StorageAdapterCommand,
	type StorageAdapterEvaluation,
	type StorageAdapterFact,
	type StorageAdapterWrite,
} from "@ts-drp/storage/adapter";

import { applyBrowserBoundedAheReclamation, registerBrowserAheReclamationMaintenance } from "./ahe-reclamation.js";
import {
	captureNativeReadReservationInput,
	isNativeReadReservationTransaction,
	nativeReadonlyTransaction,
	nativeReadReservationCheck,
	NativeReadReservationOwner,
	type NativeReadReservationPort,
	nativeReadReservationTransaction,
	needsNativeReadReservationTurn,
	runNativeReservedRead,
} from "./native-read-reservation.js";
import {
	admitBrowserRetirementControl,
	advanceBrowserRetirementControl,
	BrowserBoundedReadPrefetch,
	loadBrowserBoundedReadRequest,
	readBrowserRetirementControl,
	writeBrowserRetirementControl,
} from "./retirement-control.js";
import {
	browserAheControlStores,
	openBrowserRoomOwnerConnection,
	openPhase2dInternalDatabase,
	PHASE_2D_BLOBS_STORE,
	PHASE_2D_GENERATIONS_STORE,
	PHASE_2D_OBJECTS_STORE,
	PHASE_2D_PROMOTIONS_STORE,
	roomStoreName,
	roomStoreNames,
} from "./schema-idb.js";

export interface BrowserAheDurableStoreOptions {
	readonly databaseName: string;
}

export type BrowserAheDurableStore = AheBoundedRecoveryRoleStore & BlobExistencePort & NativeReadReservationPort;

type Phase2dMutationOperation = Exclude<StorageAdapterCommand["kind"], "getBlob" | "readGenerationPage" | "readHead">;

type TransactionOutcome = Readonly<{ ok: true }> | Readonly<{ cause: unknown; ok: false }>;

type HeldAheRetirementAdmissionImage = Readonly<{transaction: IDBTransaction; objectId: StorageObjectId;
	controlBytes: Uint8Array | null; head: ExpectedHead; imageDigest: string; metadataBytes: number}>;

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
	private readReservations: NativeReadReservationOwner | undefined;
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
		this.readReservations = new NativeReadReservationOwner(database);
	}

	public acquireNativeReadReservation(input: {
		readonly objectId: string;
	}): ReturnType<NativeReadReservationOwner["acquire"]> {
		if (this.connection === undefined || this.readReservations === undefined) throw new Error("STORE_CLOSED");
		if (this.poisoned) throw new Error("STORE_POISONED");
		return this.readReservations.acquire(input);
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
		if (this.closePromise !== undefined) return this.closePromise;
		for (const invalidate of this.invalidators) invalidate();
		const operationsJoined = new Promise<void>((resolve) => {
			this.resolveClose = resolve;
		});
		this.closePromise = Promise.all([operationsJoined, this.readReservations?.close()]).then(() => undefined);
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
	#heldRetirementImage?: HeldAheRetirementAdmissionImage;
	#heldBoundedReadFacts?: BoundedReadNativeFacts;

	public constructor(private readonly lifecycle: IdbAdapterLifecycle) {
		lifecycle.onInvalidation(() => {
			this.recoveryCertificates.clear();
			this.#heldRetirementImage = undefined;
			this.#heldBoundedReadFacts = undefined;
		});
	}

	public readHead(objectId: StorageObjectId): Promise<StoreResult<ExpectedHead>> {
		return this.run(commandWithKind("readHead", { objectId })) as Promise<StoreResult<ExpectedHead>>;
	}

	public async readRetirementControl(objectId: StorageObjectId): Promise<StoreResult<AheRetirementControl | null>> {
		const prepared = prepareStorageAdapterCommand({ kind: "readHead", objectId });
		if (!prepared.ok) return prepared;
		const database = this.lifecycle.startOperation();
		if (!database) return { ok: false, reason: "STORE_CLOSED" };
		if (needsNativeReadReservationTurn(database)) {
			try {
				return await runNativeReservedRead(database, () => this.readRetirementControl(objectId));
			} catch (cause) {
				if (this.lifecycle.isClosed()) return { ok: false, reason: "STORE_CLOSED" };
				if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
				return substrateFailure(cause);
			} finally {
				this.lifecycle.finishOperation();
			}
		}
		let tx: IDBTransaction | undefined, done: Promise<TransactionOutcome> | undefined;
		try {
			if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
			tx = nativeReadonlyTransaction(database, browserAheControlStores(database));
			done = transactionOutcome(tx);
			const value = await readBrowserRetirementControl(tx, objectId),
				joined = await joinTransactionOutcome(tx, done);
			return joined.ok ? { ok: true, value } : substrateFailure(joined.cause);
		} catch (cause) {
			if (tx) abortIfActive(tx);
			if (done && tx) await joinTransactionOutcome(tx, done);
			return substrateFailure(cause);
		} finally {
			this.lifecycle.finishOperation();
		}
	}

	public async acquireNativeReadReservation(input: {
		readonly objectId: string;
	}): ReturnType<NativeReadReservationOwner["acquire"]> {
		const objectId = captureNativeReadReservationInput(input);
		if (!parseStorageObjectId(objectId).ok) throw new TypeError("INVALID_ARGUMENT");
		this.#heldRetirementImage = undefined;
		this.#heldBoundedReadFacts = undefined;
		const original = await this.lifecycle.acquireNativeReadReservation({ objectId });
		return Object.freeze({check: () => original.check(), release: () => {
			// Revoke reuse immediately, before joining any admitted native work.
			this.#heldRetirementImage = undefined;
			this.#heldBoundedReadFacts = undefined;
			return original.release();
		}});
	}

	private detachedHeldRetirementImage(image: HeldAheRetirementAdmissionImage): StoreResult<AheRetirementAdmissionImage> {
		const control = image.controlBytes === null ? null : decodeAheRetirementControl(image.controlBytes);
		if (control !== null && !control.ok) return control;
		return {ok: true, value: Object.freeze({control: control?.value ?? null,
			head: Object.freeze({...image.head}), imageDigest: image.imageDigest, metadataBytes: image.metadataBytes})};
	}

	public readRetirementImage(
		objectId: StorageObjectId
	): Promise<StoreResult<Pick<AheRetirementControlRead, "control" | "head" | "imageDigest" | "metadataBytes">>> {
		return this.readRetirementImagePoint(objectId, false);
	}

	public readRetirementAdmissionImage(objectId: StorageObjectId): Promise<StoreResult<AheRetirementAdmissionImage>> {
		return this.readRetirementImagePoint(objectId, true);
	}

	private readRetirementImagePoint(
		objectId: StorageObjectId,
		allowAbsent: false
	): Promise<StoreResult<Pick<AheRetirementControlRead, "control" | "head" | "imageDigest" | "metadataBytes">>>;
	private readRetirementImagePoint(
		objectId: StorageObjectId,
		allowAbsent: true,
		poisonFailures?: boolean
	): Promise<StoreResult<AheRetirementAdmissionImage>>;
	private async readRetirementImagePoint(
		objectId: StorageObjectId,
		allowAbsent: boolean,
		poisonFailures = false
	): Promise<StoreResult<AheRetirementAdmissionImage>> {
		const prepared = prepareStorageAdapterCommand({ kind: "readHead", objectId });
		if (!prepared.ok) return prepared;
		const database = this.lifecycle.startOperation();
		if (!database) return { ok: false, reason: "STORE_CLOSED" };
		if (needsNativeReadReservationTurn(database)) {
			try {
				return await runNativeReservedRead(database, () => allowAbsent
					? this.readRetirementImagePoint(objectId, true, poisonFailures)
					: this.readRetirementImage(objectId));
			} catch (cause) {
				return substrateFailure(cause);
			} finally {
				this.lifecycle.finishOperation();
			}
		}
		let tx: IDBTransaction | undefined, done: Promise<TransactionOutcome> | undefined;
		try {
			if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
			tx = nativeReadonlyTransaction(database, browserAheControlStores(database));
			done = transactionOutcome(tx);
			if (isNativeReadReservationTransaction(tx)) {
				await nativeReadReservationCheck(tx);
				const prior = this.#heldRetirementImage;
				if (prior?.transaction === tx && prior.objectId === objectId) {
					const joined = await joinTransactionOutcome(tx, done);
					if (!joined.ok) return substrateFailure(joined.cause);
					if (this.lifecycle.isClosed()) return {ok: false, reason: "STORE_CLOSED"};
					if (this.lifecycle.isPoisoned()) return {ok: false, reason: "STORE_POISONED"};
					if (nativeReadReservationTransaction(database) !== tx) throw new Error("NATIVE_READ_RESERVATION_LOST");
					if (!allowAbsent && prior.controlBytes === null) return {ok: false, reason: "INVALID_ARGUMENT"};
					return this.detachedHeldRetirementImage(prior);
				}
			} else this.#heldRetirementImage = undefined;
			const control = await readBrowserRetirementControl(tx, objectId);
			if (control === null && !allowAbsent) {
				const joined = await joinTransactionOutcome(tx, done);
				return joined.ok ? { ok: false, reason: "INVALID_ARGUMENT" } : substrateFailure(joined.cause);
			}
			const retained = this.#heldBoundedReadFacts;
			const facts = isNativeReadReservationTransaction(tx) && retained?.matches(this, tx, objectId) ? retained : undefined;
			if (facts === undefined) this.#heldBoundedReadFacts = undefined;
			const bytes = control === null ? null : encodeAheRetirementControl(control),
				head = await this.requiredHeadObservation(tx, objectId),
				image = await admitBrowserRetirementControl(tx, objectId, bytes, facts),
				joined = await joinTransactionOutcome(tx, done);
			if (!joined.ok) return substrateFailure(joined.cause);
			if (!image.ok) {
				if (poisonFailures) this.latchControlFailure(image);
				return image;
			}
			if (isNativeReadReservationTransaction(tx)) {
				if (this.lifecycle.isClosed()) return {ok: false, reason: "STORE_CLOSED"};
				if (this.lifecycle.isPoisoned()) return {ok: false, reason: "STORE_POISONED"};
				if (nativeReadReservationTransaction(database) !== tx) throw new Error("NATIVE_READ_RESERVATION_LOST");
				const admitted = Object.freeze({transaction: tx, objectId, controlBytes: bytes,
					head: Object.freeze({...head.head}), imageDigest: image.value.imageDigest, metadataBytes: bytes?.byteLength ?? 0});
				this.#heldRetirementImage = admitted;
				return this.detachedHeldRetirementImage(admitted);
			}
			return {
				ok: true,
				value: Object.freeze({
					control,
					head: head.head,
					imageDigest: image.value.imageDigest,
					metadataBytes: bytes?.byteLength ?? 0,
				}),
			};
		} catch (cause) {
			if (tx) abortIfActive(tx);
			if (done && tx) await joinTransactionOutcome(tx, done);
			if (poisonFailures && cause instanceof BoundedReadBudgetError) return {ok: false, reason: "READ_BUDGET_EXCEEDED"};
			if (poisonFailures && cause instanceof PersistedStorageError) return this.lifecycle.latchPoison(cause.reason);
			return substrateFailure(cause);
		} finally {
			this.lifecycle.finishOperation();
		}
	}

	/** Existing metadata is observed by the original complete RO owner. Only
	 * missing-metadata birth and the returned one-use mutation enter strict RW.
	 * No RO result grants mutation authority: runControl rechecks exact control,
	 * head and the full native image in its own fresh RW before every effect. */
	public async acquireRetirementControl(objectId: StorageObjectId): Promise<StoreResult<AheRetirementControlRead>> {
		const observed = await this.readRetirementImagePoint(objectId, true, true);
		if (!observed.ok) return observed;
		const { control, head, imageDigest } = observed.value;
		// This RO has completed/joined. The original birth path independently
		// rereads absence, admits the whole current image and writes strict RW;
		// concurrent birth is therefore observed, never overwritten from this RO.
		if (control === null) return this.runControl(objectId);
		if (this.lifecycle.isClosed()) return {ok: false, reason: "STORE_CLOSED"};
		if (this.lifecycle.isPoisoned()) return {ok: false, reason: "STORE_POISONED"};
		const bytes = encodeAheRetirementControl(control);
		return {ok: true, value: createAheRetirementControlRead(control, head, imageDigest,
			(next, mutation) => this.runControl(objectId, {bytes, head: headFingerprint(head), imageDigest, next,
				...(mutation ? {mutation} : {})}), this)};
	}

	private runControl(objectId: StorageObjectId): Promise<StoreResult<AheRetirementControlRead>>;
	private runControl(
		objectId: StorageObjectId,
		compare: Readonly<{
			bytes: Uint8Array;
			head: string;
			imageDigest: string;
			next: AheRetirementControl;
			mutation?: AheRetirementNativeMutation;
		}>
	): Promise<StoreResult<AheRetirementControl>>;
	private async runControl(
		objectId: StorageObjectId,
		compare?: Readonly<{
			bytes: Uint8Array;
			head: string;
			imageDigest: string;
			next: AheRetirementControl;
			mutation?: AheRetirementNativeMutation;
		}>
	): Promise<StoreResult<AheRetirementControlRead | AheRetirementControl>> {
		const database = this.lifecycle.startOperation();
		if (database === undefined) return { ok: false, reason: "STORE_CLOSED" };
		const turn = this.lifecycle.acquireRecoveryTurn();
		const releaseTurn = typeof turn === "function" ? turn : await turn;
		let transaction: IDBTransaction | undefined;
		let completion: Promise<TransactionOutcome> | undefined;
		let postimage: string | undefined;
		let nextControl: AheRetirementControl | undefined;
		try {
			if (this.lifecycle.isClosed()) return { ok: false, reason: "STORE_CLOSED" };
			if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
			transaction = database.transaction(browserAheControlStores(database), "readwrite", { durability: "strict" });
			completion = transactionOutcome(transaction);
			if (transaction.durability !== "strict") throw new StrictDurabilityCapabilityError();
			const current = await readBrowserRetirementControl(transaction, objectId);
			const observed = await this.requiredHeadObservation(transaction, objectId);
			if (
				compare !== undefined &&
				(current === null ||
					!equalBytes(encodeAheRetirementControl(current), compare.bytes) ||
					headFingerprint(observed.head) !== compare.head)
			) {
				abortIfActive(transaction);
				await joinTransactionOutcome(transaction, completion);
				return { ok: false, reason: "READ_STALE_ROLE_VIEW" };
			}
			const control = compare?.next ??
				current ?? {
					kind: "ahe-retirement-control-2" as const,
					objectId,
					incarnation: controlIncarnation(),
					revision: 0,
					sequence: 0,
					active: null,
					completed: null,
				};
			const bytes = encodeAheRetirementControl(control);
			const admitted = await admitBrowserRetirementControl(transaction, objectId, bytes);
			if (!admitted.ok) {
				abortIfActive(transaction);
				await joinTransactionOutcome(transaction, completion);
				this.latchControlFailure(admitted);
				return admitted;
			}
			if (compare !== undefined && admitted.value.imageDigest !== compare.imageDigest) {
				abortIfActive(transaction);
				await joinTransactionOutcome(transaction, completion);
				return { ok: false, reason: "READ_STALE_ROLE_VIEW" };
			}
			if (compare !== undefined) {
				const mutationBefore = compare.mutation;
				const records = admitted.value.generations.map((g) => g.recordDigest);
				if (
					!current ||
					!aheRetirementGenerationBindingMatches(current, admitted.value.generations) ||
					(mutationBefore?.kind !== "reclaim" &&
						!aheRetirementGenerationBindingMatches(control, admitted.value.generations))
				) {
					abortIfActive(transaction);
					await joinTransactionOutcome(transaction, completion);
					return { ok: false, reason: "READ_STALE_ROLE_VIEW" };
				}
				const mutation = compare.mutation;
				if (mutation?.kind === "reclaim") {
					if (
						!aheRetirementReclamationMatches(
							current,
							control,
							mutation.source,
							admitted.value.imageDigest,
							admitted.value.generations
						)
					) {
						abortIfActive(transaction);
						await joinTransactionOutcome(transaction, completion);
						return { ok: false, reason: "READ_STALE_ROLE_VIEW" };
					}
					await applyBrowserBoundedAheReclamation(transaction, this, mutation.source.reclamation, true);
				} else if (mutation) {
					const candidate = admitted.value.generations.find((g) => g.generationId === mutation.material.generationId);
					const resuming = mutation.kind === "stage" && current.nominee != null;
					const existingDigest = mutation.material.existingGenerationRecordDigest;
					const nominatingExisting = mutation.kind === "stage" && !resuming && existingDigest !== undefined;
					if (
						(mutation.kind === "stage" && !resuming && !nominatingExisting && (candidate !== undefined || records.length >= 7)) ||
						(nominatingExisting && (candidate?.recordDigest !== existingDigest || control.nominee?.recordDigest !== existingDigest ||
							mutation.material.blobs.length !== 0)) ||
						(resuming &&
							(candidate?.recordDigest !== current.nominee?.recordDigest ||
								!equalBytes(encodeCanonical(current.nominee), encodeCanonical(control.nominee)))) ||
						(mutation.kind === "publish" && candidate?.recordDigest !== current.nominee?.recordDigest)
					) {
						abortIfActive(transaction);
						await joinTransactionOutcome(transaction, completion);
						return { ok: false, reason: "RETIREMENT_FENCED" };
					}
					if (nominatingExisting) {
						const prepared = prepareStorageAdapterCommand({kind: "completeGeneration", objectId,
							generationId: mutation.material.generationId});
						if (!prepared.ok) throw new TypeError("existing native future command is invalid");
						const authorized = await this.verifyCandidate(transaction, objectId, mutation.material.generationId,
							await this.loadFacts(transaction, prepared.value));
						if (!authorized?.ok) {
							abortIfActive(transaction);
							await joinTransactionOutcome(transaction, completion);
							return authorized ?? {ok: false, reason: "INVALID_ARGUMENT"};
						}
					}
					for (const command of resuming || nominatingExisting ? [] : aheRetirementNativeCommands(mutation)) {
						const prepared = prepareStorageAdapterCommand(command);
						if (!prepared.ok) {
							abortIfActive(transaction);
							await joinTransactionOutcome(transaction, completion);
							return prepared;
						}
						const facts = await this.loadFacts(transaction, prepared.value);
						let evaluation = evaluateStorageAdapterCommand(prepared.value, facts);
						if (prepared.value.command.kind === "completeGeneration" || prepared.value.command.kind === "swapHead") {
							const authorized = await this.verifyCandidate(
								transaction,
								objectId,
								mutation.material.generationId,
								facts
							);
							if (!authorized?.ok) {
								abortIfActive(transaction);
								await joinTransactionOutcome(transaction, completion);
								return authorized ?? { ok: false, reason: "INVALID_ARGUMENT" };
							}
							evaluation = evaluateStorageAdapterCommand(prepared.value, facts, authorized.value);
						}
						if (!evaluation.result.ok) {
							abortIfActive(transaction);
							await joinTransactionOutcome(transaction, completion);
							return evaluation.result;
						}
						await this.applyWrites(transaction, evaluation);
					}
				}
				// A metadata-only prepare/commit has changed no generation, blob,
				// promotion or head in this SAME strict native RW transaction. The
				// first census already admitted these exact next-control bytes. Do
				// not reconstruct that identical whole image a second time. Actual
				// stage/publish/reclaim commands still require their fresh postimage
				// census; every branch retains independent native readback below.
				const after = mutation === undefined ? admitted :
					await admitBrowserRetirementControl(transaction, objectId, bytes);
				if (!after.ok) {
					abortIfActive(transaction);
					await joinTransactionOutcome(transaction, completion);
					this.latchControlFailure(after);
					return after;
				}
				if (!aheRetirementGenerationBindingMatches({ ...control, binding: null }, after.value.generations)) {
					abortIfActive(transaction);
					await joinTransactionOutcome(transaction, completion);
					return { ok: false, reason: "READ_STALE_ROLE_VIEW" };
				}
				if (
					mutation?.kind === "stage" &&
					after.value.generations.find((g) => g.generationId === mutation.material.generationId)?.recordDigest !==
						control.nominee?.recordDigest
				) {
					abortIfActive(transaction);
					await joinTransactionOutcome(transaction, completion);
					return { ok: false, reason: "NON_CANONICAL_RECORD" };
				}
				if (mutation?.kind === "reclaim" && after.value.imageDigest !== mutation.source.postImageDigest) {
					abortIfActive(transaction);
					await joinTransactionOutcome(transaction, completion);
					return { ok: false, reason: "READ_STALE_ROLE_VIEW" };
				}
				postimage = after.value.imageDigest;
				nextControl = control;
			}
			if (compare !== undefined || current === null)
				await writeBrowserRetirementControl(transaction, control, current === null);
			const outcome = await joinTransactionOutcome(transaction, completion);
			if (compare !== undefined && postimage !== undefined) {
				const readback = await this.readControlPostimage(database, control, postimage);
				if (readback.ok) return readback;
				if (!outcome.ok) return substrateFailure(outcome.cause);
				return readback;
			}
			if (!outcome.ok) return substrateFailure(outcome.cause);
			return {
				ok: true,
				value: createAheRetirementControlRead(
					control,
					observed.head,
					admitted.value.imageDigest,
					(next, mutation) =>
						this.runControl(objectId, {
							bytes,
							head: headFingerprint(observed.head),
							imageDigest: admitted.value.imageDigest,
							next,
							...(mutation ? { mutation } : {}),
						}),
					this
				),
			};
		} catch (cause) {
			if (transaction !== undefined) abortIfActive(transaction);
			if (completion !== undefined) await joinTransactionOutcome(transaction, completion);
			if (nextControl && postimage !== undefined) {
				const readback = await this.readControlPostimage(database, nextControl, postimage);
				if (readback.ok) return readback;
			}
			if (cause instanceof BoundedReadBudgetError) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
			if (cause instanceof PersistedStorageError) return this.lifecycle.latchPoison(cause.reason);
			return substrateFailure(cause);
		} finally {
			releaseTurn();
			this.lifecycle.finishOperation();
		}
	}

	private async readControlPostimage(
		database: IDBDatabase,
		next: AheRetirementControl,
		imageDigest: string
	): Promise<StoreResult<AheRetirementControl>> {
		const tx = nativeReadonlyTransaction(database, browserAheControlStores(database)),
			done = transactionOutcome(tx);
		try {
			const current = await readBrowserRetirementControl(tx, next.objectId),
				image = await admitBrowserRetirementControl(tx, next.objectId, encodeAheRetirementControl(next));
			const matches =
				current !== null &&
				equalBytes(encodeAheRetirementControl(current), encodeAheRetirementControl(next)) &&
				image.ok &&
				image.value.imageDigest === imageDigest;
			const joined = await joinTransactionOutcome(tx, done);
			return !joined.ok
				? substrateFailure(joined.cause)
				: matches
					? { ok: true, value: next }
					: { ok: false, reason: "READ_STALE_ROLE_VIEW" };
		} catch (cause) {
			abortIfActive(tx);
			await joinTransactionOutcome(tx, done);
			return substrateFailure(cause);
		}
	}

	private latchControlFailure(result: StoreResult<unknown>): void {
		if (isBoundedReadCorruption(result)) {
			this.recoveryCertificates.clear();
			this.lifecycle.latchPoison("NON_CANONICAL_RECORD");
		}
	}

	public acquireBoundedActiveRead(input: AheBoundedReadInput): Promise<StoreResult<AheBoundedReadAcquisition>> {
		const prepared = prepareBoundedRead(input);
		if (!prepared.ok) return Promise.resolve(prepared);
		return this.runBoundedSteps(facts => boundedActiveReadSteps(prepared.value, facts), false, undefined, undefined,
			prepared.value.objectId).then((result) =>
			!result.ok
				? result
				: {
						ok: true,
						value: createBoundedReadAcquisition(result.value, (head, released) =>
							this.runBoundedSteps(boundedHeadSteps(head.objectId), true, released)
						),
					}
		);
	}

	public acquireBoundedRecoveryRoleRead(
		input: AheBoundedRecoveryRoleReadInput
	): Promise<StoreResult<AheBoundedRecoveryRoleRead>> {
		const prepared = prepareBoundedRecoveryRoleRead(input);
		if (!prepared.ok) return Promise.resolve(prepared);
		// One still-live reader owns only the weak identity of its latest FULLY
		// verified native basis, not cached material or authority. The first check
		// in every different reservation must run the complete verifier, even when
		// head/epoch/bytes look identical; only that successful native terminal may
		// bind this existing logical reader to the NEW original physical exclusion.
		let heldCapture: WeakRef<IDBTransaction> | undefined;
		return this.runBoundedSteps(facts => boundedRecoveryRoleReadSteps(prepared.value, facts), false, undefined,
			transaction => { heldCapture = new WeakRef(transaction); }, prepared.value.objectId).then((result) =>
			!result.ok
				? result
				: {
						ok: true,
						value: createBoundedRecoveryRoleRead(result.value, (steps, released) =>
							this.checkBoundedRecoveryRoleCurrency(steps, released, heldCapture,
								transaction => { heldCapture = new WeakRef(transaction); })
						),
					}
		);
	}

	private async checkBoundedRecoveryRoleCurrency(
		steps: Generator<BoundedReadRequest, StoreResult<Readonly<{kind: "current"}>>, unknown>,
		released: () => boolean,
		heldCapture: WeakRef<IDBTransaction> | undefined,
		captureHeldTransaction: (transaction: IDBTransaction) => void
	): Promise<StoreResult<Readonly<{kind: "current"}>>> {
		const database = this.lifecycle.startOperation();
		if (database === undefined) return {ok: false, reason: "STORE_CLOSED"};
		try {
			if (this.lifecycle.isPoisoned()) return {ok: false, reason: "STORE_POISONED"};
			if (released()) return {ok: false, reason: "READ_RELEASED"};
			const captured = heldCapture?.deref();
			if (captured === undefined || nativeReadReservationTransaction(database) !== captured)
				return await this.runBoundedSteps(steps, false, released, captureHeldTransaction);
			// The exact all-store RO still excludes every native writer. Its complete
			// captured census/material therefore cannot change. Check the genuine
			// native transaction freshly, rather than loading/hashing it all again.
			const current = nativeReadReservationCheck(captured);
			if (current === undefined) return await this.runBoundedSteps(steps, false, released, captureHeldTransaction);
			await current;
			if (this.lifecycle.isClosed()) return {ok: false, reason: "STORE_CLOSED"};
			if (this.lifecycle.isPoisoned()) return {ok: false, reason: "STORE_POISONED"};
			if (released()) return {ok: false, reason: "READ_RELEASED"};
			if (nativeReadReservationTransaction(database) !== captured)
				return await this.runBoundedSteps(steps, false, released, captureHeldTransaction);
			// createBoundedRecoveryRoleRead still performs its original final
			// borrowed-buffer integrity sweep synchronously before public delivery.
			return {ok: true, value: Object.freeze({kind: "current"})};
		} catch (cause) {
			return substrateFailure(cause);
		} finally {
			this.lifecycle.finishOperation();
		}
	}

	private async runBoundedSteps<T>(
		steps: Generator<BoundedReadRequest, StoreResult<T>, unknown> |
			((facts: BoundedReadNativeFacts | undefined) => Generator<BoundedReadRequest, StoreResult<T>, unknown>),
		headOnly: boolean,
		released?: () => boolean,
		captureHeldTransaction?: (transaction: IDBTransaction) => void,
		factObjectId?: StorageObjectId
	): Promise<StoreResult<T>> {
		const database = this.lifecycle.startOperation();
		if (database === undefined) return { ok: false, reason: "STORE_CLOSED" };
		if (needsNativeReadReservationTurn(database)) {
			try {
				return await runNativeReservedRead(database, () => this.runBoundedSteps(steps, headOnly, released, captureHeldTransaction, factObjectId));
			} catch (cause) {
				if (this.lifecycle.isClosed()) return { ok: false, reason: "STORE_CLOSED" };
				if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
				if (released?.()) return { ok: false, reason: "READ_RELEASED" };
				return substrateFailure(cause);
			} finally {
				this.lifecycle.finishOperation();
			}
		}
		let releaseTurn = (): void => undefined;
		let transaction: IDBTransaction | undefined;
		let completion: Promise<TransactionOutcome> | undefined;
		try {
			const reserved = nativeReadReservationTransaction(database);
			// A recovery/control RW may already own the JavaScript turn while
			// waiting behind this physical RO. Its held-view reads must not wait
			// behind that same write. Ordinary reads retain the existing turn law.
			if (reserved === undefined) {
				const turn = this.lifecycle.acquireRecoveryTurn();
				releaseTurn = typeof turn === "function" ? turn : await turn;
			}
			if (this.lifecycle.isClosed()) return { ok: false, reason: "STORE_CLOSED" };
			if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
			if (released?.()) return { ok: false, reason: "READ_RELEASED" };
			transaction =
				reserved ??
				nativeReadonlyTransaction(database, roomStoreNames(database, "ahe", headOnly ? [PHASE_2D_OBJECTS_STORE] : allAuthorityStores()));
			completion = transactionOutcome(transaction);
			const facts = typeof steps === "function" && reserved !== undefined && factObjectId !== undefined
				? new BoundedReadNativeFacts(this, transaction, factObjectId) : undefined;
			const driver = typeof steps === "function" ? steps(facts) : steps;
			const prefetch = new BrowserBoundedReadPrefetch(transaction);
			let step = driver.next();
			while (!step.done) step = driver.next(await this.loadBoundedRequest(transaction, step.value, prefetch));
			const outcome = await joinTransactionOutcome(transaction, completion);
			if (!outcome.ok) return substrateFailure(outcome.cause);
			if (isBoundedReadCorruption(step.value)) {
				this.recoveryCertificates.clear();
				this.lifecycle.latchPoison("NON_CANONICAL_RECORD");
			}
			if (step.value.ok && reserved !== undefined && (captureHeldTransaction !== undefined || facts !== undefined)) {
				if (this.lifecycle.isClosed()) return {ok: false, reason: "STORE_CLOSED"};
				if (this.lifecycle.isPoisoned()) return {ok: false, reason: "STORE_POISONED"};
				if (released?.()) return {ok: false, reason: "READ_RELEASED"};
				if (nativeReadReservationTransaction(database) !== transaction) throw new Error("NATIVE_READ_RESERVATION_LOST");
				captureHeldTransaction?.(transaction);
				if (facts?.matches(this, transaction, factObjectId!)) this.#heldBoundedReadFacts = facts;
			}
			return step.value;
		} catch (cause) {
			if (transaction !== undefined) abortIfActive(transaction);
			if (completion !== undefined) await joinTransactionOutcome(transaction, completion);
			if (cause instanceof BoundedReadBudgetError) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
			if (cause instanceof PersistedStorageError) {
				this.recoveryCertificates.clear();
				return this.lifecycle.latchPoison(cause.reason);
			}
			return substrateFailure(cause);
		} finally {
			releaseTurn();
			this.lifecycle.finishOperation();
		}
	}

	private async loadBoundedRequest(transaction: IDBTransaction, request: BoundedReadRequest,
		prefetch?: BrowserBoundedReadPrefetch): Promise<unknown> {
		return loadBrowserBoundedReadRequest(transaction, request, undefined, prefetch);
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
		if (needsNativeReadReservationTurn(database)) {
			try {
				return await runNativeReservedRead(database, () => this.probeBlobPresence(copied));
			} catch (cause) {
				if (this.lifecycle.isClosed()) return { ok: false, reason: "STORE_CLOSED" };
				if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
				return substrateFailure(cause);
			} finally {
				this.lifecycle.finishOperation();
			}
		}
		let transaction: IDBTransaction | undefined;
		let completion: Promise<TransactionOutcome> | undefined;
		try {
			if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
			transaction = nativeReadonlyTransaction(database, roomStoreName(database, "ahe", PHASE_2D_BLOBS_STORE));
			completion = transactionOutcome(transaction);
			const store = transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_BLOBS_STORE));
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
			const outcome = await joinTransactionOutcome(transaction, completion);
			if (!outcome.ok) return substrateFailure(outcome.cause);
			if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
			return { ok: true, value: Object.freeze(values) };
		} catch (cause) {
			if (transaction !== undefined) abortIfActive(transaction);
			if (completion !== undefined) await joinTransactionOutcome(transaction, completion);
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
			return await (isMutation(prepared.value.command.kind)
				? this.execute(database, prepared.value)
				: runNativeReservedRead(database, () => this.execute(database, prepared.value)));
		} catch (cause) {
			if (this.lifecycle.isClosed()) return { ok: false, reason: "STORE_CLOSED" };
			if (this.lifecycle.isPoisoned()) return { ok: false, reason: "STORE_POISONED" };
			return substrateFailure(cause);
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
			let headObservation: TransactionHeadObservation | undefined;
			let control: AheRetirementControl | null = null;
			transaction = mutation
				? database.transaction(browserAheControlStores(database), "readwrite", {
						durability: "strict",
					})
				: nativeReadonlyTransaction(database, roomStoreNames(database, "ahe", OPERATION_STORES[operation]));
			completion = transactionOutcome(transaction);
			if (mutation && transaction.durability !== "strict") throw new StrictDurabilityCapabilityError();
			if (mutation) {
				if (!("objectId" in prepared.command)) throw new Error("mutation command lacks object scope");
				control = await readBrowserRetirementControl(transaction, prepared.command.objectId);
				if (control !== null && (control.active !== null || control.completed !== null)) {
					abortIfActive(transaction);
					await joinTransactionOutcome(transaction, completion);
					return { ok: false, reason: "RETIREMENT_FENCED" };
				}
				if (control?.revision === Number.MAX_SAFE_INTEGER) {
					abortIfActive(transaction);
					await joinTransactionOutcome(transaction, completion);
					return { ok: false, reason: "REVISION_EXHAUSTED" };
				}
				if (control !== null) {
					const admitted = await admitBrowserRetirementControl(
						transaction,
						control.objectId,
						encodeAheRetirementControl(control)
					);
					if (!admitted.ok) {
						abortIfActive(transaction);
						await joinTransactionOutcome(transaction, completion);
						this.latchControlFailure(admitted);
						return admitted;
					}
				}
				const observed = await this.observeHead(transaction, prepared.command.objectId);
				if (!observed.ok) {
					abortIfActive(transaction);
					await joinTransactionOutcome(transaction, completion);
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
					await joinTransactionOutcome(transaction, completion);
					return this.lifecycle.latchPoison(recovered.reason as PersistedStorageError["reason"]);
				}
			}

			const facts = await this.loadFacts(transaction, prepared, headObservation);
			let evaluation = evaluateStorageAdapterCommand(prepared, facts);
			if (prepared.command.kind === "completeGeneration" || prepared.command.kind === "swapHead") {
				if (!evaluation.result.ok && evaluation.result.reason !== "INVALID_ARGUMENT") {
					abortIfActive(transaction);
					await joinTransactionOutcome(transaction, completion);
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
					await joinTransactionOutcome(transaction, completion);
					return authorization ?? { ok: false, reason: "INVALID_ARGUMENT" };
				}
				evaluation = evaluateStorageAdapterCommand(prepared, facts, authorization.value);
			}
			if (!evaluation.result.ok) {
				abortIfActive(transaction);
				await joinTransactionOutcome(transaction, completion);
				return evaluation.result;
			}
			if (mutation) {
				await this.applyWrites(transaction, evaluation);
				const advanced = await advanceBrowserRetirementControl(transaction, control);
				if (!advanced.ok) {
					abortIfActive(transaction);
					await joinTransactionOutcome(transaction, completion);
					this.latchControlFailure(advanced);
					return advanced;
				}
			}
			const outcome = await joinTransactionOutcome(transaction, completion);
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
			if (cause instanceof BoundedReadBudgetError) {
				if (transaction !== undefined) abortIfActive(transaction);
				if (completion !== undefined) await joinTransactionOutcome(transaction, completion);
				return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
			}
			const semanticResult =
				cause instanceof PersistedStorageError
					? this.lifecycle.latchPoison(cause.reason)
					: cause instanceof PoisonedOperationError
						? ({ ok: false, reason: "STORE_POISONED" } as const)
						: undefined;
			if (transaction !== undefined) abortIfActive(transaction);
			if (completion !== undefined) await joinTransactionOutcome(transaction, completion);
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
							.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_GENERATIONS_STORE))
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
			transaction = database.transaction(browserAheControlStores(database), "readwrite", { durability: "strict" });
			completion = transactionOutcome(transaction);
			if (transaction.durability !== "strict") throw new StrictDurabilityCapabilityError();
			const control = await readBrowserRetirementControl(transaction, objectId);
			if (control !== null) {
				const admitted = await admitBrowserRetirementControl(
					transaction,
					objectId,
					encodeAheRetirementControl(control)
				);
				if (!admitted.ok) {
					abortIfActive(transaction);
					await joinTransactionOutcome(transaction, completion);
					this.latchControlFailure(admitted);
					return admitted;
				}
			}
			const result = await this.recoverWithinTransaction(transaction, objectId);
			if (!result.ok) {
				abortIfActive(transaction);
				await joinTransactionOutcome(transaction, completion);
				return this.lifecycle.latchPoison(result.reason as PersistedStorageError["reason"]);
			}
			const outcome = await joinTransactionOutcome(transaction, completion);
			if (!outcome.ok) {
				this.recoveryCertificates.clear();
				return substrateFailure(outcome.cause);
			}
			const snapshot = freezeRecoverySnapshot(result.value);
			this.recoveryCertificates.set(objectId, headFingerprint(snapshot.head));
			return { ok: true, value: snapshot };
		} catch (cause) {
			if (transaction !== undefined) abortIfActive(transaction);
			if (completion !== undefined) await joinTransactionOutcome(transaction, completion);
			if (cause instanceof PoisonedOperationError) return { ok: false, reason: "STORE_POISONED" };
			if (cause instanceof BoundedReadBudgetError) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
			if (cause instanceof PersistedStorageError) return this.lifecycle.latchPoison(cause.reason);
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
		const row = await this.request(transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_OBJECTS_STORE)).get(objectId));
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
				transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_GENERATIONS_STORE)).getAll(generationPageRange(objectId, after), 129)
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
		const row = await this.request(transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_GENERATIONS_STORE)).get([objectId, generationId]));
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
								.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_PROMOTIONS_STORE))
								.get([objectId, generation.generationId, verificationRequest.reference.digest])
						: transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_BLOBS_STORE)).get(verificationRequest.reference.digest);
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
		const row = await this.request(transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_BLOBS_STORE)).get(digest));
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
			transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_PROMOTIONS_STORE)).get([scope.objectId, scope.generationId, scope.digest])
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
					transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_GENERATIONS_STORE)).put({
						generationId: write.generationId,
						objectId: write.objectId,
						record: new Uint8Array(write.record),
					})
				);
				return;
			case "replace-head":
				await requestValue(
					transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_OBJECTS_STORE)).put({
						objectId: write.objectId,
						record: new Uint8Array(write.record),
					})
				);
				return;
			case "insert-blob":
				await requestValue(
					transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_BLOBS_STORE)).add({
						bytes: new Uint8Array(write.bytes),
						digest: write.digest,
					})
				);
				return;
			case "insert-promotion":
				await requestValue(
					transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_PROMOTIONS_STORE)).add({
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

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

function controlIncarnation(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});
}

async function joinTransactionOutcome(
	transaction: IDBTransaction | undefined,
	completion: Promise<TransactionOutcome>
): Promise<TransactionOutcome> {
	if (transaction !== undefined && isNativeReadReservationTransaction(transaction)) {
		try {
			await nativeReadReservationCheck(transaction);
			return { ok: true };
		} catch (cause) {
			return { ok: false, cause };
		}
	}
	return completion;
}

function transactionOutcome(transaction: IDBTransaction): Promise<TransactionOutcome> {
	if (isNativeReadReservationTransaction(transaction)) return Promise.resolve({ ok: true });
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
	if (isNativeReadReservationTransaction(transaction)) return;
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
		void lifecycle.close().catch(() => undefined);
	});
	lifecycle.attach(opaqueDatabase as IDBDatabase);
	const store = new IdbAheDurableStore(lifecycle);
	registerBrowserAheReclamationMaintenance(store, lifecycle, options.databaseName);
	return store;
}

/**
 * Creates the AHE durable store inside a ready version-7 room database (slice 14a).
 * The store keeps every operation, row format and refusal of the dedicated store; only
 * its stores live in the `ahe:` namespace of the room database and its held read
 * views cover only that namespace. It never creates or upgrades the room database.
 * @param options - The room database name.
 * @returns A strict durable-store adapter over its own room connection.
 */
export async function createBrowserRoomAheDurableStore(
	options: BrowserAheDurableStoreOptions
): Promise<BrowserAheDurableStore> {
	if (options === null || typeof options !== "object" || typeof options.databaseName !== "string")
		throw new TypeError("INVALID_ARGUMENT");
	const databaseName = options.databaseName;
	const lifecycle = new IdbAdapterLifecycle();
	const database = await openBrowserRoomOwnerConnection(databaseName, "ahe", () => {
		void lifecycle.close().catch(() => undefined);
	});
	lifecycle.attach(database);
	const store = new IdbAheDurableStore(lifecycle);
	// The dispatch identity of the dedicated `${N}--ahe` database is kept for the room namespace.
	registerBrowserAheReclamationMaintenance(store, lifecycle, `${databaseName}--ahe`);
	return store;
}
