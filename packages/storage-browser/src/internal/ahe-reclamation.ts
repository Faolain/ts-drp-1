import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	AHE_BOUNDED_READ_LIMITS,
	type AheDurableStore,
	type AheRetirementControl,
	aheRetirementGenerationBindingMatches,
	aheRetirementGenerationIdentity,
	captureAheRetirementControl,
	captureAheRetirementGenerationSource,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestBlob,
	encodeAheRetirementControl,
	encodeGenerationRecordV1,
	type ExpectedHead,
	type GenerationRecord,
	parseStorageObjectId,
} from "@ts-drp/storage";
import {
	AHE_LOCAL_CONTROL_CENSUS_LIMITS,
	BoundedReadBudgetError,
	isBoundedReadCorruption,
	PersistedStorageError,
} from "@ts-drp/storage/adapter";
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
import {
	roomRetentionControlDigest,
	type RoomRetentionLabels,
	type RoomRetentionProofBook,
	RoomRetentionRefusal,
} from "@ts-drp/storage/room-head";

import { runInternalPrimaryDispatch } from "./primary-dispatch.js";
import {
	admitBrowserRetirementControl,
	advanceBrowserRetirementControl,
	readBrowserRetirementControl,
} from "./retirement-control.js";
import {
	chargeRetentionRow,
	type RoomRetentionDraftDelete,
	type RoomRetentionDraftRewrite,
	type RoomRetentionSection,
	type RoomRetentionSectionDraft,
	type RoomRetentionTarget,
	retentionStale,
	retentionValueDigest,
} from "./room-retention.js";
import {
	browserAheControlStores,
	PHASE_2D_BLOBS_STORE,
	PHASE_2D_GENERATIONS_STORE,
	PHASE_2D_OBJECTS_STORE,
	PHASE_2D_PROMOTIONS_STORE,
	PHASE_5C_STORAGE_META_STORE,
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

const RETENTION_IMAGE_DOMAIN = "ts-drp-storage/retirement-image/v1";
const RETENTION_INCARNATION_DOMAIN = "ts-drp/closed-snapshot-incarnation/v1";
const RETENTION_SMALL_LIMITS = { maxBytes: 65_536, maxItems: 4096, maxDepth: 16 };
const RETENTION_IMAGE_LIMITS = {
	maxBytes:
		AHE_BOUNDED_READ_LIMITS.maxHeadBytes +
		AHE_BOUNDED_READ_LIMITS.maxObjectGenerations * (AHE_BOUNDED_READ_LIMITS.maxGenerationBytes + 8) +
		AHE_LOCAL_CONTROL_CENSUS_LIMITS.maxPromotions * 256 +
		256,
	maxItems: 32 + AHE_BOUNDED_READ_LIMITS.maxObjectGenerations * 4 + AHE_LOCAL_CONTROL_CENSUS_LIMITS.maxPromotions * 12,
	maxDepth: 3,
};

function aheRetentionCorrupt(detail: string): never {
	throw new RoomRetentionRefusal("RETENTION_CORRUPT", `ahe:${detail}`);
}

function retentionHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function recordBytes(record: GenerationRecord): Uint8Array {
	return encodeGenerationRecordV1(record);
}

function recordDigest(record: GenerationRecord): string {
	const digest = digestBlob(recordBytes(record));
	if (!digest.ok) return aheRetentionCorrupt("record-digest");
	return digest.value;
}

/** One room's AHE rows as read inside the acting transaction, with their exact stored rows. */
interface AheRetentionState {
	readonly headRow: unknown;
	readonly head: ExpectedHead;
	readonly generations: Map<string, Readonly<{ record: GenerationRecord; raw: unknown; key: readonly string[] }>>;
	readonly foreign: readonly GenerationRecord[];
	readonly promotions: Map<string, Readonly<{ promotion: AheReclamationPromotion; raw: unknown; key: readonly string[] }>>;
	readonly blobs: Map<string, Readonly<{ bytes: Uint8Array; raw: unknown }>>;
}

async function loadRetentionState(
	transaction: IDBTransaction,
	objectId: string,
	book: RoomRetentionProofBook
): Promise<AheRetentionState> {
	const store = (logical: string): IDBObjectStore => transaction.objectStore(roomStoreName(transaction.db, "ahe", logical));
	const headRow = await requestValue(store(PHASE_2D_OBJECTS_STORE).get(objectId));
	if (headRow === undefined) return aheRetentionCorrupt("head-absent");
	chargeRetentionRow(book, "ahe", PHASE_2D_OBJECTS_STORE, objectId, headRow);
	const decodedHead = decodeHeadRecordV1(bytes(rowProperty(headRow, "record")));
	if (!decodedHead.ok || decodedHead.value.objectId !== objectId) return aheRetentionCorrupt("head");
	const generations = new Map<string, Readonly<{ record: GenerationRecord; raw: unknown; key: readonly string[] }>>();
	const foreign: GenerationRecord[] = [];
	// 14e: every census read is bounded before it is issued: `getAll(undefined, bound + 1)`
	// over the whole store. A room database holds one object: another object's rows would
	// widen the original classifier's view (shared blobs) beyond this bound, so they retain.
	const generationBound = AHE_BOUNDED_READ_LIMITS.maxObjectGenerations;
	const generationStore = store(PHASE_2D_GENERATIONS_STORE);
	const generationRows = await requestValue(generationStore.getAll(undefined, generationBound + 1));
	if (generationRows.length > generationBound) throw new RoomRetentionRefusal("RETENTION_CAPACITY", "ahe:generations");
	if (generationRows.some((raw) => rowProperty(raw, "objectId") !== objectId))
		throw new RoomRetentionRefusal("RETENTION_CAPACITY", "ahe:foreign-generations");
	for (const raw of generationRows) {
		const decoded = decodeGenerationRecordV1(bytes(rowProperty(raw, "record")));
		if (
			!decoded.ok ||
			decoded.value.objectId !== rowProperty(raw, "objectId") ||
			decoded.value.generationId !== rowProperty(raw, "generationId") ||
			decoded.value.objectId !== objectId
		)
			return aheRetentionCorrupt("generation");
		const key = [objectId, decoded.value.generationId];
		chargeRetentionRow(book, "ahe", PHASE_2D_GENERATIONS_STORE, key, raw);
		if (decoded.value.closure.length > AHE_BOUNDED_READ_LIMITS.maxClosureReferences)
			throw new RoomRetentionRefusal("RETENTION_CAPACITY", "ahe:closure");
		generations.set(decoded.value.generationId, Object.freeze({ record: decoded.value, raw, key }));
	}
	if (generations.size > AHE_BOUNDED_READ_LIMITS.maxObjectGenerations)
		throw new RoomRetentionRefusal("RETENTION_CAPACITY", "ahe:generations");
	const promotions = new Map<string, Readonly<{ promotion: AheReclamationPromotion; raw: unknown; key: readonly string[] }>>();
	const promotionBound = generationBound * AHE_BOUNDED_READ_LIMITS.maxClosureReferences;
	const promotionStore = store(PHASE_2D_PROMOTIONS_STORE);
	const promotionRows = await requestValue(promotionStore.getAll(undefined, promotionBound + 1));
	if (promotionRows.length > promotionBound) throw new RoomRetentionRefusal("RETENTION_CAPACITY", "ahe:promotions");
	if (promotionRows.some((raw) => rowProperty(raw, "objectId") !== objectId))
		throw new RoomRetentionRefusal("RETENTION_CAPACITY", "ahe:foreign-promotions");
	for (const raw of promotionRows) {
		const promotion = {
			digest: rowProperty(raw, "digest"),
			generationId: rowProperty(raw, "generationId"),
			objectId: rowProperty(raw, "objectId"),
		} as AheReclamationPromotion;
		const key = [promotion.objectId, promotion.generationId, promotion.digest] as string[];
		if (promotion.objectId === objectId) chargeRetentionRow(book, "ahe", PHASE_2D_PROMOTIONS_STORE, key, raw);
		promotions.set(JSON.stringify(key), Object.freeze({ promotion, raw, key }));
	}
	const blobs = new Map<string, Readonly<{ bytes: Uint8Array; raw: unknown }>>();
	// The classifier's blobs (every promoted digest, as the original loader reads them)
	// and the census's present referenced blobs (every closure reference of the object).
	const wanted = new Set<string>([...promotions.values()].map((row) => row.promotion.digest));
	for (const row of generations.values()) for (const ref of row.record.closure) wanted.add(ref.digest);
	for (const digest of wanted) {
		const raw = await requestValue(store(PHASE_2D_BLOBS_STORE).get(digest));
		if (raw === undefined) continue;
		chargeRetentionRow(book, "ahe", PHASE_2D_BLOBS_STORE, digest, raw);
		blobs.set(digest, Object.freeze({ bytes: bytes(rowProperty(raw, "bytes")), raw }));
	}
	return { headRow, head: decodedHead.value, generations, foreign, promotions, blobs };
}

function retentionSnapshot(state: AheRetentionState): AheReclamationSnapshot {
	const promoted = new Set([...state.promotions.values()].map((row) => row.promotion.digest as string));
	return {
		blobs: [...state.blobs]
			.filter(([digest]) => promoted.has(digest))
			.map(([digest, row]) => ({ bytes: new Uint8Array(row.bytes), digest })),
		generations: [...state.foreign, ...[...state.generations.values()].map((row) => row.record)],
		head: state.head,
		promotions: [...state.promotions.values()].map((row) => row.promotion),
	} as unknown as AheReclamationSnapshot;
}

/** The object's generation rows in native key order. */
function retentionRows(state: AheRetentionState): readonly GenerationRecord[] {
	return [...state.generations.values()]
		.map((row) => row.record)
		.sort((left, right) => (left.generationId < right.generationId ? -1 : left.generationId > right.generationId ? 1 : 0));
}

function retentionCensus(state: AheRetentionState): Readonly<{
	recordDigests: readonly string[];
	identities: readonly Readonly<{ generationId: string; identityDigest: string }>[];
}> {
	const rows = retentionRows(state);
	return {
		recordDigests: rows.map(recordDigest),
		identities: rows.map((row) => ({ generationId: row.generationId, identityDigest: aheRetirementGenerationIdentity(row) })),
	};
}

/**
 * The original native census image digest over an in-memory state: the same head,
 * generation records, promotion pairs and present referenced blobs the native census
 * commits, so a unit's source and post digests are checked exactly as the original
 * reclamation checks them against the native census.
 * @param state - In-memory room AHE rows.
 * @returns The image digest.
 */
function retentionImageDigest(state: AheRetentionState): string {
	const rows = retentionRows(state);
	const promoted = [...state.promotions.values()]
		.filter((row) => row.promotion.objectId === rowProperty(state.headRow, "objectId"))
		.map((row) => `${row.promotion.generationId}:${row.promotion.digest}`)
		.sort();
	const referenced = new Set<string>();
	for (const row of rows) for (const ref of row.closure) referenced.add(ref.digest);
	const present = [...referenced].filter((digest) => state.blobs.has(digest)).sort();
	const imageBytes = encodeCanonical(
		{
			head: bytes(rowProperty(state.headRow, "record")),
			generations: rows.map(recordBytes),
			promotions: promoted,
			presentBlobs: present,
		},
		RETENTION_IMAGE_LIMITS
	);
	return retentionHex(hashDomain(RETENTION_IMAGE_DOMAIN, imageBytes));
}

function retentionReclamationRefusal(cause: unknown): never {
	if (cause instanceof RoomRetentionRefusal) throw cause;
	if (cause instanceof AheReclamationError && cause.code === "AHE_RECLAMATION_CORRUPT")
		return aheRetentionCorrupt(`reclamation:${cause.message}`);
	if (cause instanceof AheReclamationError) return retentionStale(`ahe:reclamation:${cause.message}`);
	throw cause;
}

/**
 * Slices 14a/14b step B: the AHE owner's retention section. Inside the acting room
 * transaction it reads the control, admits the original native census, and loads the
 * room's generation, promotion and blob rows (each charged at its exact canonical
 * length). It then applies the planner's ordered generation units one after another to
 * that in-memory image, each exactly as the original bounded reclamation applies its one
 * unit: the unit's source census and image digest must equal the current image, the
 * original reclamation classifier decides every delete and floor rewrite, the post
 * replay must be pure, and the post census and image digest must equal the unit's. Every
 * delete names the exact stored row it removes. The target control is the completed
 * kind-3 control the original prepare, commit and reclaim reach for the same labels,
 * without participant domains or a drain (one transaction has nothing to resume).
 */
export const aheRetentionSection: RoomRetentionSection = Object.freeze<RoomRetentionSection>({
	owner: "ahe" as const,
	prepare: ({ session, selection, book, context }) =>
		session.run(async (transaction) => {
			const objectId = selection.objectId,
				through = selection.throughEpoch;
			const parsed = parseStorageObjectId(objectId);
			if (!parsed.ok) return aheRetentionCorrupt("object");
			const metaStore = transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_5C_STORAGE_META_STORE));
			const controlKey = `ahe-retirement:${objectId}`;
			const rawControl = await requestValue(metaStore.get(controlKey));
			if (rawControl === undefined) return retentionStale("ahe:control-absent");
			const base = chargeRetentionRow(book, "ahe", PHASE_5C_STORAGE_META_STORE, controlKey, rawControl);
			let control: AheRetirementControl | null;
			let admitted: Awaited<ReturnType<typeof admitBrowserRetirementControl>>;
			try {
				control = await readBrowserRetirementControl(transaction, parsed.value);
				if (control === null) return retentionStale("ahe:control-absent");
				admitted = await admitBrowserRetirementControl(transaction, parsed.value, encodeAheRetirementControl(control));
			} catch (cause) {
				if (cause instanceof BoundedReadBudgetError) throw new RoomRetentionRefusal("RETENTION_CAPACITY", "ahe:census");
				if (cause instanceof PersistedStorageError) return aheRetentionCorrupt("control");
				throw cause;
			}
			if (!admitted.ok)
				throw admitted.reason === "READ_BUDGET_EXCEEDED"
					? new RoomRetentionRefusal("RETENTION_CAPACITY", "ahe:census")
					: new RoomRetentionRefusal("RETENTION_CORRUPT", `ahe:census:${admitted.reason}`);
			// The original bound-prepare preconditions.
			if (
				control.active !== null ||
				control.nominee ||
				control.binding ||
				control.completed?.generationDrain?.phase === "pending" ||
				(control.completed !== null && control.kind !== "ahe-retirement-control-3")
			)
				retentionStale("ahe:fenced");
			if (control.revision >= Number.MAX_SAFE_INTEGER - 1 || control.sequence === Number.MAX_SAFE_INTEGER)
				retentionStale("ahe:revision");
			if (!aheRetirementGenerationBindingMatches(control, admitted.value.generations)) retentionStale("ahe:binding");
			const state = await loadRetentionState(transaction, objectId, book);
			if (retentionImageDigest(state) !== admitted.value.imageDigest) aheRetentionCorrupt("image-census");
			// Survivors (14b): the head, its rollbacks and every generation exactly as verified.
			if (retentionImageDigest(state) !== selection.survivors.aheImage) retentionStale("ahe:survivors");
			const deletes: RoomRetentionDraftDelete[] = [];
			const rewritten = new Map<string, RoomRetentionDraftRewrite>();
			const original = new Map([...state.generations].map(([id, row]) => [id, row]));
			const originalPromotions = new Map(state.promotions);
			const originalBlobs = new Map(state.blobs);
			const generationDeletes: string[] = [],
				promotionDeletes: string[] = [],
				blobDeletes: string[] = [];
			const headBytes = encodeCanonical(state.head, RETENTION_SMALL_LIMITS);
			for (const value of selection.ahe.units) {
				let unit: ReturnType<typeof captureAheRetirementGenerationSource>;
				try {
					unit = captureAheRetirementGenerationSource(value);
				} catch {
					return aheRetentionCorrupt("unit");
				}
				const census = retentionCensus(state);
				if (
					unit.reclamation.objectId !== objectId ||
					unit.reclamation.closedEpoch !== through ||
					!equalRetentionBytes(encodeCanonical(unit.reclamation.expectedHead, RETENTION_SMALL_LIMITS), headBytes) ||
					JSON.stringify(unit.generations.recordDigests) !== JSON.stringify(census.recordDigests) ||
					JSON.stringify(unit.generations.identities) !== JSON.stringify(census.identities) ||
					unit.sourceImageDigest !== retentionImageDigest(state)
				)
					retentionStale("ahe:unit-source");
				let decision: ReturnType<typeof classifyAheReclamation>;
				try {
					decision = classifyAheReclamation(unit.reclamation, retentionSnapshot(state));
				} catch (cause) {
					return retentionReclamationRefusal(cause);
				}
				if (
					decision.deleteGenerationIds.length > 1 ||
					decision.deleteGenerationIds.length + decision.deletePromotions.length + decision.deleteBlobDigests.length > 16
				)
					throw new RoomRetentionRefusal("RETENTION_CAPACITY", "ahe:unit");
				const rewrite = (record: GenerationRecord): void => {
					const prior = original.get(record.generationId);
					if (prior === undefined || !state.generations.has(record.generationId)) return aheRetentionCorrupt("rewrite");
					const value = { generationId: record.generationId, objectId, record: recordBytes(record) };
					rewritten.set(
						record.generationId,
						Object.freeze({
							store: PHASE_2D_GENERATIONS_STORE,
							key: prior.key,
							before: chargeRetentionRow(book, "ahe", PHASE_2D_GENERATIONS_STORE, prior.key, prior.raw, false),
							after: retentionValueDigest(PHASE_2D_GENERATIONS_STORE, prior.key, value),
							value,
						})
					);
					state.generations.set(record.generationId, Object.freeze({ record, raw: value, key: prior.key }));
				};
				for (const source of decision.independentSourceFloors ?? [])
					if (source.normalizedThisCall) rewrite(source.rewrittenGeneration);
				if (decision.floor.normalizedThisCall) rewrite(decision.floor.rewrittenGeneration);
				for (const promotion of decision.deletePromotions) {
					const id = JSON.stringify([promotion.objectId, promotion.generationId, promotion.digest]);
					if (!state.promotions.has(id) || !originalPromotions.has(id)) return aheRetentionCorrupt("promotion");
					state.promotions.delete(id);
					promotionDeletes.push(id);
				}
				for (const generationId of decision.deleteGenerationIds) {
					if (!state.generations.has(generationId) || !original.has(generationId)) return aheRetentionCorrupt("generation");
					state.generations.delete(generationId);
					rewritten.delete(generationId);
					generationDeletes.push(generationId);
				}
				for (const digest of decision.deleteBlobDigests) {
					if (!state.blobs.has(digest) || !originalBlobs.has(digest)) return aheRetentionCorrupt("blob");
					state.blobs.delete(digest);
					blobDeletes.push(digest);
				}
				let post: ReturnType<typeof classifyAheReclamation>;
				try {
					post = classifyAheReclamation(unit.reclamation, retentionSnapshot(state));
				} catch (cause) {
					return retentionReclamationRefusal(cause);
				}
				if (
					post.floor.normalizedThisCall ||
					post.independentSourceFloors?.some((source) => source.normalizedThisCall) ||
					post.deleteGenerationIds.length !== 0 ||
					post.deletePromotions.length !== 0 ||
					post.deleteBlobDigests.length !== 0
				)
					aheRetentionCorrupt("post-replay");
				const after = retentionCensus(state);
				if (
					JSON.stringify(unit.postGenerations.recordDigests) !== JSON.stringify(after.recordDigests) ||
					JSON.stringify(unit.postGenerations.identities) !== JSON.stringify(after.identities) ||
					unit.postImageDigest !== retentionImageDigest(state)
				)
					retentionStale("ahe:unit-post");
			}
			for (const id of promotionDeletes) {
				const row = originalPromotions.get(id)!;
				deletes.push(
					Object.freeze({
						store: PHASE_2D_PROMOTIONS_STORE,
						key: row.key,
						digest: chargeRetentionRow(book, "ahe", PHASE_2D_PROMOTIONS_STORE, row.key, row.raw, false),
					})
				);
			}
			for (const generationId of generationDeletes) {
				const row = original.get(generationId)!;
				deletes.push(
					Object.freeze({
						store: PHASE_2D_GENERATIONS_STORE,
						key: row.key,
						digest: chargeRetentionRow(book, "ahe", PHASE_2D_GENERATIONS_STORE, row.key, row.raw, false),
					})
				);
			}
			for (const digest of blobDeletes) {
				const row = originalBlobs.get(digest)!;
				deletes.push(
					Object.freeze({
						store: PHASE_2D_BLOBS_STORE,
						key: digest,
						digest: chargeRetentionRow(book, "ahe", PHASE_2D_BLOBS_STORE, digest, row.raw, false),
					})
				);
			}
			const rewrites = [...rewritten.values()];
			// Snapshot holes: every surviving recovery snapshot at or below the frontier.
			const survivors = context.snapshotSurvivors;
			if (survivors === undefined) return retentionStale("ahe:snapshot-order");
			const snapshotHoles = survivors
				.filter((row) => row.scope.epoch <= through)
				.map((row) =>
					Object.freeze({
						epoch: row.scope.epoch,
						anchor: row.scope.anchor,
						manifestDigest: row.scope.manifestDigest,
						incarnationDigest: retentionHex(
							hashDomain(
								RETENTION_INCARNATION_DOMAIN,
								encodeCanonical({ scope: row.scope, incarnation: row.incarnation }, RETENTION_SMALL_LIMITS)
							)
						),
					})
				);
			if (snapshotHoles.length > 4) throw new RoomRetentionRefusal("RETENTION_CAPACITY", "ahe:snapshot-holes");
			const completed = control.completed;
			if (
				completed !== null &&
				(through < completed.throughEpoch ||
					snapshotHoles
						.filter((hole) => hole.epoch <= completed.throughEpoch)
						.some(
							(hole) =>
								!completed.snapshotHoles.some((prior) =>
									equalRetentionBytes(
										encodeCanonical(prior, RETENTION_SMALL_LIMITS),
										encodeCanonical(hole, RETENTION_SMALL_LIMITS)
									)
								)
						))
			)
				retentionStale("ahe:monotone");
			const post = retentionCensus(state);
			const current = control;
			const section: RoomRetentionSectionDraft = Object.freeze({
				owner: "ahe" as const,
				base,
				control: roomRetentionControlDigest(encodeAheRetirementControl(current)),
				through,
				census: admitted.value.imageDigest,
				deletes: Object.freeze(deletes),
				rewrites: Object.freeze(rewrites),
				compose: async (labels: RoomRetentionLabels) => {
					let next: AheRetirementControl;
					try {
						next = captureAheRetirementControl({
							kind: "ahe-retirement-control-3",
							objectId,
							incarnation: current.incarnation,
							revision: current.revision + 2,
							sequence: current.sequence + 1,
							completed: {
								throughEpoch: through,
								decisionDigest: labels.decisionDigest,
								sourceProofDigest: labels.sourceProofDigest,
								snapshotHoles,
								generationHoles: post.recordDigests,
								generationIdentities: post.identities,
							},
							active: null,
							binding: null,
							nominee: null,
						});
					} catch {
						return retentionStale("ahe:transition");
					}
					const value = { key: controlKey, record: encodeAheRetirementControl(next) };
					return Object.freeze({
						value,
						digest: retentionValueDigest(PHASE_5C_STORAGE_META_STORE, controlKey, value),
						control: roomRetentionControlDigest(value.record),
					});
				},
				write: (target: RoomRetentionTarget, writeBook: RoomRetentionProofBook) =>
					session.run(async (writer) => {
						const writeStore = (logical: string): IDBObjectStore =>
							writer.objectStore(roomStoreName(writer.db, "ahe", logical));
						for (const row of rewrites) {
							writeBook.write({ kind: "rewrite", owner: "ahe", store: row.store });
							await requestValue(writeStore(row.store).put(row.value));
						}
						for (const row of deletes) {
							writeBook.write({ kind: "delete", owner: "ahe", store: row.store });
							await requestValue(writeStore(row.store).delete(row.key as IDBValidKey));
						}
						writeBook.write({ kind: "control", owner: "ahe" });
						await requestValue(writeStore(PHASE_5C_STORAGE_META_STORE).put(target.value));
					}),
			});
			return section;
		}),
});

function equalRetentionBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
	return true;
}
