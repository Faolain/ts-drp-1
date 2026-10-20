import {
	AHE_BOUNDED_READ_LIMITS,
	type AheDurableStore,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	encodeAheRetirementControl,
	encodeGenerationRecordV1,
	type ExpectedHead,
	type GenerationRecord,
	parseStorageObjectId,
} from "@ts-drp/storage";
import { BoundedReadBudgetError, isBoundedReadCorruption, PersistedStorageError } from "@ts-drp/storage/adapter";
import {
	AheReclamationError,
	type AheReclamationMaintenance,
	type AheReclamationPromotion,
	type AheReclamationReceipt,
	type AheReclamationSnapshot,
	bindAheReclamationMaintenance,
	captureAheReclamationInput,
	classifyAheReclamation,
	createAheReclamationError,
	createAheReclamationReceipt,
} from "@ts-drp/storage/maintenance";

import { runInternalPrimaryDispatch } from "./primary-dispatch.js";
import {
	admitBrowserRetirementControl,
	advanceBrowserRetirementControl,
	readBrowserRetirementControl,
} from "./retirement-control.js";
import {
	browserAheControlStores,
	PHASE_2D_BLOBS_STORE,
	PHASE_2D_GENERATIONS_STORE,
	PHASE_2D_OBJECTS_STORE,
	PHASE_2D_PROMOTIONS_STORE,
	roomStoreName,
} from "./schema-idb.js";

export type BrowserAheReclamationCrashEdge =
	| "after-floor-rewrite"
	| "after-promotion-delete"
	| "after-generation-delete"
	| "after-blob-delete"
	| "before-commit"
	| "after-commit";

export type BrowserAheReclamationCrashObserver = (
	edge: BrowserAheReclamationCrashEdge,
	transaction: IDBTransaction
) => void;

export type BrowserAheReclamationCountFault =
	| "blob delete"
	| "floor rewrite"
	| "generation delete"
	| "promotion delete";

export type BrowserAheReclamationLifecycle = Readonly<{
	acquireRecoveryTurn(): (() => void) | Promise<() => void>;
	finishOperation(): void;
	isClosed(): boolean;
	isPoisoned(): boolean;
	latchPoison(reason: "NON_CANONICAL_RECORD"): unknown;
	startOperation(): IDBDatabase | undefined;
}>;

type TransactionOutcome = Readonly<{ ok: true }> | Readonly<{ cause: unknown; ok: false }>;

const maintenanceByStore = new WeakMap<AheDurableStore, AheReclamationMaintenance>();
const crashObserverByStore = new WeakMap<AheDurableStore, BrowserAheReclamationCrashObserver>();
const countFaultByStore = new WeakMap<AheDurableStore, BrowserAheReclamationCountFault>();

function rowProperty(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function bytes(value: unknown): Uint8Array {
	if (!(value instanceof Uint8Array)) throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", "row bytes invalid");
	return new Uint8Array(value);
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
			() => resolve({ cause: transaction.error ?? observedError ?? new Error("transaction aborted"), ok: false }),
			{ once: true }
		);
		transaction.addEventListener(
			"error",
			() => {
				observedError ??= transaction.error ?? new Error("transaction failed");
			},
			{ once: true }
		);
	});
}

function abortIfActive(transaction: IDBTransaction): void {
	try {
		transaction.abort();
	} catch {
		// Preserve the primary classified failure.
	}
}

async function expectKey(
	store: AheDurableStore,
	objectStore: IDBObjectStore,
	key: IDBValidKey,
	expected: "absent" | "present",
	label: BrowserAheReclamationCountFault
): Promise<void> {
	const value = await requestValue(objectStore.getKey(key));
	const matches = expected === "present" ? value !== undefined : value === undefined;
	if (!matches || countFaultByStore.get(store) === label) {
		throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", `${label} count mismatch`);
	}
}

async function loadSnapshot(
	transaction: IDBTransaction,
	objectId: string,
	bounded = false
): Promise<AheReclamationSnapshot> {
	const parsedObjectId = parseStorageObjectId(objectId);
	if (!parsedObjectId.ok) throw createAheReclamationError("AHE_RECLAMATION_INVALID_ARGUMENT", "object ID invalid");
	const objectRow = await requestValue(
		transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_OBJECTS_STORE)).get(objectId)
	);
	let head: ExpectedHead = { kind: "none", objectId: parsedObjectId.value };
	const headRecord = rowProperty(objectRow, "record");
	if (objectRow !== undefined && headRecord !== null && headRecord !== undefined) {
		const decoded = decodeHeadRecordV1(bytes(headRecord));
		if (!decoded.ok || decoded.value.objectId !== objectId) {
			throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", "head row was malformed or misbound");
		}
		head = decoded.value;
	}

	const generationRows = await requestValue(
		transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_GENERATIONS_STORE)).getAll()
	);
	const generations: GenerationRecord[] = [];
	for (const row of generationRows) {
		const decoded = decodeGenerationRecordV1(bytes(rowProperty(row, "record")));
		if (
			!decoded.ok ||
			decoded.value.objectId !== rowProperty(row, "objectId") ||
			decoded.value.generationId !== rowProperty(row, "generationId")
		) {
			throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", "generation row was malformed or misbound");
		}
		if (
			bounded &&
			decoded.value.objectId === objectId &&
			decoded.value.closure.length > AHE_BOUNDED_READ_LIMITS.maxClosureReferences
		)
			throw createAheReclamationError("AHE_RECLAMATION_RETRY_REQUIRED", "shared native closure exceeds bound");
		generations.push(decoded.value);
	}

	if (
		bounded &&
		generations.filter((row) => row.objectId === objectId).length > AHE_BOUNDED_READ_LIMITS.maxObjectGenerations
	)
		throw createAheReclamationError(
			"AHE_RECLAMATION_RETRY_REQUIRED",
			"addressed native generation census exceeds bound"
		);
	const promotionRows = await requestValue(
		transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_PROMOTIONS_STORE)).getAll()
	);
	const promotions = promotionRows.map(
		(row) =>
			({
				digest: rowProperty(row, "digest"),
				generationId: rowProperty(row, "generationId"),
				objectId: rowProperty(row, "objectId"),
			}) as AheReclamationPromotion
	);
	const digests = [...new Set(promotions.map(({ digest }) => digest))];
	const blobStore = transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_BLOBS_STORE));
	const blobs = [];
	for (const digest of digests) {
		const row = await requestValue(blobStore.get(digest));
		if (row !== undefined) {
			const capturedBytes = bytes(rowProperty(row, "bytes"));
			blobs.push({ bytes: capturedBytes, digest });
		}
	}
	return { blobs, generations, head, promotions } as AheReclamationSnapshot;
}

class BrowserAheReclamationMaintenance implements AheReclamationMaintenance {
	public constructor(
		private readonly store: AheDurableStore,
		private readonly lifecycle: BrowserAheReclamationLifecycle,
		private readonly databaseName: string
	) {}

	public async reclaimClosedEpoch(input: unknown): Promise<AheReclamationReceipt> {
		const captured = captureAheReclamationInput(input);
		return runInternalPrimaryDispatch({
			databaseName: this.databaseName,
			identity: "ahe-reclamation:v1",
			task: () => this.reclaimCaptured(captured),
		});
	}

	private async reclaimCaptured(
		captured: ReturnType<typeof captureAheReclamationInput>
	): Promise<AheReclamationReceipt> {
		const database = this.lifecycle.startOperation();
		if (database === undefined) {
			throw createAheReclamationError("AHE_RECLAMATION_STORE_CLOSED", "store is closed");
		}
		const turn = this.lifecycle.acquireRecoveryTurn();
		const release = typeof turn === "function" ? turn : await turn;
		let transaction: IDBTransaction | undefined;
		let completion: Promise<TransactionOutcome> | undefined;
		let committed = false;
		try {
			if (this.lifecycle.isClosed()) {
				throw createAheReclamationError("AHE_RECLAMATION_STORE_CLOSED", "store closed before reclamation");
			}
			if (this.lifecycle.isPoisoned()) {
				throw createAheReclamationError("AHE_RECLAMATION_STORE_POISONED", "store is poisoned");
			}
			transaction = database.transaction(browserAheControlStores(database), "readwrite", { durability: "strict" });
			completion = transactionOutcome(transaction);
			if (transaction.durability !== "strict") {
				throw createAheReclamationError("AHE_RECLAMATION_SUBSTRATE_FAILURE", "strict durability unavailable");
			}
			const control = await readBrowserRetirementControl(transaction, captured.objectId);
			if (control !== null && (control.active !== null || control.completed !== null))
				throw createAheReclamationError(
					"AHE_RECLAMATION_RETRY_REQUIRED",
					"native AHE retirement reservation prevents reclamation"
				);
			if (control?.revision === Number.MAX_SAFE_INTEGER)
				throw createAheReclamationError("AHE_RECLAMATION_RETRY_REQUIRED", "native control revision exhausted");
			if (control !== null) {
				const admitted = await admitBrowserRetirementControl(
					transaction,
					captured.objectId,
					encodeAheRetirementControl(control)
				);
				if (!admitted.ok)
					throw createAheReclamationError(
						isBoundedReadCorruption(admitted) ? "AHE_RECLAMATION_CORRUPT" : "AHE_RECLAMATION_RETRY_REQUIRED",
						`native control admission refused: ${admitted.reason}`
					);
			}
			const decision = await applyBrowserBoundedAheReclamation(transaction, this.store, captured);
			const observer = crashObserverByStore.get(this.store);
			const advanced = await advanceBrowserRetirementControl(transaction, control);
			if (!advanced.ok)
				throw createAheReclamationError(
					isBoundedReadCorruption(advanced) ? "AHE_RECLAMATION_CORRUPT" : "AHE_RECLAMATION_RETRY_REQUIRED",
					`native post-control admission refused: ${advanced.reason}`
				);
			observer?.("before-commit", transaction);
			transaction.commit();
			const outcome = await completion;
			if (!outcome.ok) throw outcome.cause;
			committed = true;
			observer?.("after-commit", transaction);
			return createAheReclamationReceipt(decision);
		} catch (error) {
			if (!committed && transaction !== undefined) abortIfActive(transaction);
			if (!committed && completion !== undefined) await completion;
			if (error instanceof BoundedReadBudgetError)
				throw createAheReclamationError(
					"AHE_RECLAMATION_RETRY_REQUIRED",
					"native local-control census budget exceeded",
					error
				);
			if (error instanceof PersistedStorageError) {
				this.lifecycle.latchPoison("NON_CANONICAL_RECORD");
				throw createAheReclamationError(
					"AHE_RECLAMATION_CORRUPT",
					"native local-control metadata or census invalid",
					error
				);
			}
			if (error instanceof AheReclamationError) {
				if (error.code === "AHE_RECLAMATION_CORRUPT") this.lifecycle.latchPoison("NON_CANONICAL_RECORD");
				throw error;
			}
			throw createAheReclamationError("AHE_RECLAMATION_SUBSTRATE_FAILURE", "IndexedDB reclamation failed", error);
		} finally {
			release();
			this.lifecycle.finishOperation();
		}
	}
}

/**
 * Applies the original classified OLD/NEW rewrite in its caller-owned native
 * transaction. Bounded retirement is mechanical CAS enforcement, not eligibility.
 * @param transaction Original native transaction/connection.
 * @param store Exact maintenance facade.
 * @param captured Original detached reclamation input.
 * @param bounded Whether the existing seven-row admission and fixed16 deletes apply.
 * @returns The original exact reclamation decision; caller still joins COMMIT.
 */
export async function applyBrowserBoundedAheReclamation(
	transaction: IDBTransaction,
	store: AheDurableStore,
	captured: ReturnType<typeof captureAheReclamationInput>,
	bounded = false
): Promise<ReturnType<typeof classifyAheReclamation>> {
	const decision = classifyAheReclamation(captured, await loadSnapshot(transaction, captured.objectId, bounded));
	if (
		bounded &&
		(decision.deleteGenerationIds.length > 1 ||
			decision.deleteGenerationIds.length + decision.deletePromotions.length + decision.deleteBlobDigests.length > 16)
	)
		throw createAheReclamationError("AHE_RECLAMATION_RETRY_REQUIRED", "bounded native reclamation exceeds fixed batch");
	const observer = crashObserverByStore.get(store);
	for (const source of decision.independentSourceFloors ?? [])
		if (source.normalizedThisCall) {
			const generationStore = transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_GENERATIONS_STORE)),
				key = [captured.objectId, source.generation.generationId];
			await expectKey(store, generationStore, key, "present", "floor rewrite");
			await requestValue(
				generationStore.put({
					generationId: source.generation.generationId,
					objectId: captured.objectId,
					record: encodeGenerationRecordV1(source.rewrittenGeneration),
				})
			);
			await expectKey(store, generationStore, key, "present", "floor rewrite");
		}
	if (decision.floor.normalizedThisCall) {
		const generationStore = transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_GENERATIONS_STORE));
		const floorKey = [captured.objectId, captured.lineageFloor.generationId];
		await expectKey(store, generationStore, floorKey, "present", "floor rewrite");
		await requestValue(
			generationStore.put({
				generationId: captured.lineageFloor.generationId,
				objectId: captured.objectId,
				record: encodeGenerationRecordV1(decision.floor.rewrittenGeneration),
			})
		);
		await expectKey(store, generationStore, floorKey, "present", "floor rewrite");
		observer?.("after-floor-rewrite", transaction);
	}
	const promotionStore = transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_PROMOTIONS_STORE));
	for (const promotion of decision.deletePromotions) {
		const key = [promotion.objectId, promotion.generationId, promotion.digest];
		await expectKey(store, promotionStore, key, "present", "promotion delete");
		await requestValue(promotionStore.delete(key));
		await expectKey(store, promotionStore, key, "absent", "promotion delete");
	}
	if (decision.floor.normalizedThisCall) observer?.("after-promotion-delete", transaction);
	const generationStore = transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_GENERATIONS_STORE));
	for (const generationId of decision.deleteGenerationIds) {
		const key = [captured.objectId, generationId];
		await expectKey(store, generationStore, key, "present", "generation delete");
		await requestValue(generationStore.delete(key));
		await expectKey(store, generationStore, key, "absent", "generation delete");
	}
	if (decision.floor.normalizedThisCall) observer?.("after-generation-delete", transaction);
	const blobStore = transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_BLOBS_STORE));
	for (const digest of decision.deleteBlobDigests) {
		await expectKey(store, blobStore, digest, "present", "blob delete");
		await requestValue(blobStore.delete(digest));
		await expectKey(store, blobStore, digest, "absent", "blob delete");
	}
	if (decision.floor.normalizedThisCall) observer?.("after-blob-delete", transaction);

	const post = classifyAheReclamation(captured, await loadSnapshot(transaction, captured.objectId, bounded));
	if (
		post.floor.normalizedThisCall ||
		post.independentSourceFloors?.some((source) => source.normalizedThisCall) ||
		post.deleteGenerationIds.length !== 0 ||
		post.deletePromotions.length !== 0 ||
		post.deleteBlobDigests.length !== 0
	) {
		throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", "post-state was not a complete replay");
	}
	return decision;
}

/**
 * Registers maintenance authority for one genuine IndexedDB facade.
 * @param store - Exact facade identity.
 * @param lifecycle - Owning facade lifecycle controls.
 * @param databaseName - Exact adapter-owned database identity.
 */
export function registerBrowserAheReclamationMaintenance(
	store: AheDurableStore,
	lifecycle: BrowserAheReclamationLifecycle,
	databaseName: string
): void {
	const maintenance = new BrowserAheReclamationMaintenance(store, lifecycle, databaseName);
	if (!bindAheReclamationMaintenance(store, maintenance)) {
		throw new TypeError("AHE maintenance facade is already registered");
	}
	maintenanceByStore.set(store, maintenance);
}

/**
 * Resolves maintenance only for the registered facade identity.
 * @param store - Candidate facade identity.
 * @returns The identity-bound maintenance owner, if registered.
 */
export function browserAheReclamationMaintenanceForStore(
	store: AheDurableStore
): AheReclamationMaintenance | undefined {
	return maintenanceByStore.get(store);
}

/**
 * Installs the maintenance-only worker-termination observer for a package-local test.
 * @param store - Exact registered IndexedDB facade.
 * @param observer - Fixed checkpoint observer.
 */
export function installBrowserAheReclamationCrashObserver(
	store: AheDurableStore,
	observer: BrowserAheReclamationCrashObserver
): void {
	if (!maintenanceByStore.has(store)) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
	crashObserverByStore.set(store, observer);
}

/**
 * Installs one fixed maintenance-only count mismatch for a package-local browser test.
 * @param store - Exact registered IndexedDB facade.
 * @param fault - Fixed row-count category to misreport.
 */
export function installBrowserAheReclamationCountFault(
	store: AheDurableStore,
	fault: BrowserAheReclamationCountFault
): void {
	if (!maintenanceByStore.has(store)) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
	countFaultByStore.set(store, fault);
}
