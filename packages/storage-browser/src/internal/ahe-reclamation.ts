import {
	type AheDurableStore,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	encodeGenerationRecordV1,
	type ExpectedHead,
	type GenerationRecord,
	parseStorageObjectId,
} from "@ts-drp/storage";
import {
	AheReclamationError,
	type AheReclamationMaintenance,
	type AheReclamationPromotion,
	type AheReclamationReceipt,
	type AheReclamationSnapshot,
	captureAheReclamationInput,
	classifyAheReclamation,
	createAheReclamationError,
	createAheReclamationReceipt,
} from "@ts-drp/storage/maintenance";

import {
	PHASE_2D_BLOBS_STORE,
	PHASE_2D_GENERATIONS_STORE,
	PHASE_2D_OBJECTS_STORE,
	PHASE_2D_PROMOTIONS_STORE,
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

async function loadSnapshot(transaction: IDBTransaction, objectId: string): Promise<AheReclamationSnapshot> {
	const parsedObjectId = parseStorageObjectId(objectId);
	if (!parsedObjectId.ok) throw createAheReclamationError("AHE_RECLAMATION_INVALID_ARGUMENT", "object ID invalid");
	const objectRow = await requestValue(transaction.objectStore(PHASE_2D_OBJECTS_STORE).get(objectId));
	let head: ExpectedHead = { kind: "none", objectId: parsedObjectId.value };
	const headRecord = rowProperty(objectRow, "record");
	if (objectRow !== undefined && headRecord !== null && headRecord !== undefined) {
		const decoded = decodeHeadRecordV1(bytes(headRecord));
		if (!decoded.ok || decoded.value.objectId !== objectId) {
			throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", "head row was malformed or misbound");
		}
		head = decoded.value;
	}

	const generationRows = await requestValue(transaction.objectStore(PHASE_2D_GENERATIONS_STORE).getAll());
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
		generations.push(decoded.value);
	}

	const promotionRows = await requestValue(transaction.objectStore(PHASE_2D_PROMOTIONS_STORE).getAll());
	const promotions = promotionRows.map(
		(row) =>
			({
				digest: rowProperty(row, "digest"),
				generationId: rowProperty(row, "generationId"),
				objectId: rowProperty(row, "objectId"),
			}) as AheReclamationPromotion
	);
	const digests = [...new Set(promotions.map(({ digest }) => digest))];
	const blobStore = transaction.objectStore(PHASE_2D_BLOBS_STORE);
	const blobs = [];
	for (const digest of digests) {
		const row = await requestValue(blobStore.get(digest));
		if (row !== undefined) blobs.push({ bytes: bytes(rowProperty(row, "bytes")), digest });
	}
	return { blobs, generations, head, promotions } as AheReclamationSnapshot;
}

class BrowserAheReclamationMaintenance implements AheReclamationMaintenance {
	public constructor(
		private readonly store: AheDurableStore,
		private readonly lifecycle: BrowserAheReclamationLifecycle
	) {}

	public async reclaimClosedEpoch(input: unknown): Promise<AheReclamationReceipt> {
		const captured = captureAheReclamationInput(input);
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
			transaction = database.transaction(
				[PHASE_2D_BLOBS_STORE, PHASE_2D_GENERATIONS_STORE, PHASE_2D_OBJECTS_STORE, PHASE_2D_PROMOTIONS_STORE],
				"readwrite",
				{ durability: "strict" }
			);
			completion = transactionOutcome(transaction);
			if (transaction.durability !== "strict") {
				throw createAheReclamationError("AHE_RECLAMATION_SUBSTRATE_FAILURE", "strict durability unavailable");
			}
			const decision = classifyAheReclamation(captured, await loadSnapshot(transaction, captured.objectId));
			const observer = crashObserverByStore.get(this.store);
			if (decision.floor.normalizedThisCall) {
				const generationStore = transaction.objectStore(PHASE_2D_GENERATIONS_STORE);
				const floorKey = [captured.objectId, captured.lineageFloor.generationId];
				await expectKey(this.store, generationStore, floorKey, "present", "floor rewrite");
				await requestValue(
					generationStore.put({
						generationId: captured.lineageFloor.generationId,
						objectId: captured.objectId,
						record: encodeGenerationRecordV1(decision.floor.rewrittenGeneration),
					})
				);
				await expectKey(this.store, generationStore, floorKey, "present", "floor rewrite");
				observer?.("after-floor-rewrite", transaction);
			}
			const promotionStore = transaction.objectStore(PHASE_2D_PROMOTIONS_STORE);
			for (const promotion of decision.deletePromotions) {
				const key = [promotion.objectId, promotion.generationId, promotion.digest];
				await expectKey(this.store, promotionStore, key, "present", "promotion delete");
				await requestValue(promotionStore.delete(key));
				await expectKey(this.store, promotionStore, key, "absent", "promotion delete");
			}
			if (decision.floor.normalizedThisCall) observer?.("after-promotion-delete", transaction);
			const generationStore = transaction.objectStore(PHASE_2D_GENERATIONS_STORE);
			for (const generationId of decision.deleteGenerationIds) {
				const key = [captured.objectId, generationId];
				await expectKey(this.store, generationStore, key, "present", "generation delete");
				await requestValue(generationStore.delete(key));
				await expectKey(this.store, generationStore, key, "absent", "generation delete");
			}
			if (decision.floor.normalizedThisCall) observer?.("after-generation-delete", transaction);
			const blobStore = transaction.objectStore(PHASE_2D_BLOBS_STORE);
			for (const digest of decision.deleteBlobDigests) {
				await expectKey(this.store, blobStore, digest, "present", "blob delete");
				await requestValue(blobStore.delete(digest));
				await expectKey(this.store, blobStore, digest, "absent", "blob delete");
			}
			if (decision.floor.normalizedThisCall) observer?.("after-blob-delete", transaction);

			const post = classifyAheReclamation(captured, await loadSnapshot(transaction, captured.objectId));
			if (
				post.floor.normalizedThisCall ||
				post.deleteGenerationIds.length !== 0 ||
				post.deletePromotions.length !== 0 ||
				post.deleteBlobDigests.length !== 0
			) {
				throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", "post-state was not a complete replay");
			}
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
 * Registers maintenance authority for one genuine IndexedDB facade.
 * @param store - Exact facade identity.
 * @param lifecycle - Owning facade lifecycle controls.
 */
export function registerBrowserAheReclamationMaintenance(
	store: AheDurableStore,
	lifecycle: BrowserAheReclamationLifecycle
): void {
	maintenanceByStore.set(store, new BrowserAheReclamationMaintenance(store, lifecycle));
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
