import {
	type AheRetirementControl,
	decodeAheRetirementControl,
	encodeAheRetirementControl,
	AHE_BOUNDED_READ_LIMITS as LIMITS,
	parseGenerationId,
	type StorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import {
	AHE_LOCAL_CONTROL_CENSUS_LIMITS,
	BoundedReadBudgetError,
	type BoundedReadNativeFacts,
	boundedRetirementAdmissionSteps,
	PersistedStorageError,
	type RetirementAdmission,
	type RetirementAdmissionRequest,
} from "@ts-drp/storage/adapter";

import {
	assertCurrentBrowserSchema,
	PHASE_2D_BLOBS_STORE,
	PHASE_2D_GENERATIONS_STORE,
	PHASE_2D_OBJECTS_STORE,
	PHASE_2D_PROMOTIONS_STORE,
	PHASE_5C_STORAGE_META_STORE,
} from "./schema-idb.js";

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function exactRow(value: unknown, keys: readonly string[]): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	return (
		Reflect.ownKeys(descriptors).length === keys.length &&
		keys.every((key) => descriptors[key] !== undefined && "value" in descriptors[key])
	);
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});
}

/**
 * One mechanical native loader shared by bounded reads and control admission. No transaction/cache/parser owner.
 * @param transaction
 * @param request
 */
export async function loadBrowserBoundedReadRequest(
	transaction: IDBTransaction,
	request: RetirementAdmissionRequest, facts?: BoundedReadNativeFacts
): Promise<unknown> {
	if (request.kind === "blob-preflight") return true; // IDB clones at its native get boundary.
	if (request.kind === "blob-census-preflight") {
		let total = 0;
		for (const reference of request.references) {
			const certified = facts?.within(transaction) ? facts.verifiedBlobLength(reference) : undefined;
			if (certified !== undefined) {
				total += certified;
				if (total > LIMITS.maxUnionBytes) return false;
				continue;
			}
			const row = await requestValue(transaction.objectStore(PHASE_2D_BLOBS_STORE).get(reference.digest));
			if (row === undefined) continue;
			if (!exactRow(row, ["digest", "bytes"]) || property(row, "digest") !== reference.digest)
				throw new PersistedStorageError("NON_CANONICAL_RECORD");
			const bytes = property(row, "bytes");
			if (bytes instanceof Uint8Array) {
				if (bytes.byteLength > LIMITS.maxBlobBytes) return false;
				total += bytes.byteLength;
				if (total > LIMITS.maxUnionBytes) return false;
			}
		}
		return true;
	}
	if (request.kind === "promotions") {
		const rows = await requestValue(
			transaction
				.objectStore(PHASE_2D_PROMOTIONS_STORE)
				.getAll(
					IDBKeyRange.bound([request.objectId], [request.objectId, []]),
					AHE_LOCAL_CONTROL_CENSUS_LIMITS.maxPromotions + 1
				)
		);
		return rows.map((row) => {
			if (!exactRow(row, ["objectId", "generationId", "digest"]) || property(row, "objectId") !== request.objectId)
				throw new PersistedStorageError("NON_CANONICAL_RECORD");
			return { generationId: property(row, "generationId"), digest: property(row, "digest") };
		});
	}
	if (request.kind === "keys") {
		const limit = LIMITS.maxObjectGenerations + 1;
		return new Promise((resolve, reject) => {
			const values: unknown[] = [];
			const store = transaction.objectStore(PHASE_2D_GENERATIONS_STORE);
			const cursorRequest = store.openKeyCursor(IDBKeyRange.lowerBound([request.objectId]));
			cursorRequest.onerror = (): void => reject(cursorRequest.error);
			cursorRequest.onsuccess = (): void => {
				const cursor = cursorRequest.result;
				if (cursor === null) {
					resolve(values);
					return;
				}
				if (!Array.isArray(cursor.key)) {
					values.push(null);
					resolve(values);
					return;
				}
				if (cursor.key[0] !== request.objectId) {
					resolve(values);
					return;
				}
				if (cursor.key.length !== 2 || typeof cursor.key[1] !== "string" || !parseGenerationId(cursor.key[1]).ok) {
					values.push(null);
					resolve(values);
					return;
				}
				values.push(cursor.key[1]);
				if (values.length === limit) {
					resolve(values);
					return;
				}
				cursor.continue();
			};
		});
	}
	if (request.kind === "promotion")
		return (
			(await requestValue(
				transaction
					.objectStore(PHASE_2D_PROMOTIONS_STORE)
					.getKey([request.objectId, request.generationId, request.digest])
			)) !== undefined
		);
	if (request.kind === "blob") {
		const row = await requestValue(transaction.objectStore(PHASE_2D_BLOBS_STORE).get(request.digest));
		if (row === undefined) return null;
		if (!exactRow(row, ["digest", "bytes"]) || property(row, "digest") !== request.digest)
			throw new PersistedStorageError("NON_CANONICAL_RECORD");
		return property(row, "bytes");
	}
	const head = request.kind === "head";
	const row = await requestValue(
		transaction
			.objectStore(head ? PHASE_2D_OBJECTS_STORE : PHASE_2D_GENERATIONS_STORE)
			.get(head ? request.objectId : [request.objectId, request.generationId])
	);
	if (row === undefined) return null;
	if (!exactRow(row, head ? ["objectId", "record"] : ["objectId", "generationId", "record"]))
		throw new PersistedStorageError("NON_CANONICAL_RECORD");
	return head
		? { objectId: property(row, "objectId"), record: property(row, "record") }
		: {
				objectId: property(row, "objectId"),
				generationId: property(row, "generationId"),
				record: property(row, "record"),
			};
}

function controlKey(objectId: StorageObjectId): string {
	return `ahe-retirement:${objectId}`;
}

/**
 * Strict addressed read in the original caller transaction. Native format, never protocol proof.
 * @param transaction
 * @param objectId
 */
export async function readBrowserRetirementControl(
	transaction: IDBTransaction,
	objectId: StorageObjectId
): Promise<AheRetirementControl | null> {
	try {
		assertCurrentBrowserSchema(transaction);
	} catch {
		throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
	}
	const row = await requestValue(transaction.objectStore(PHASE_5C_STORAGE_META_STORE).get(controlKey(objectId)));
	if (row === undefined) return null;
	if (!exactRow(row, ["key", "record"]) || property(row, "key") !== controlKey(objectId))
		throw new PersistedStorageError("NON_CANONICAL_RECORD");
	const bytes = property(row, "record");
	if (!(bytes instanceof Uint8Array)) throw new PersistedStorageError("NON_CANONICAL_RECORD");
	const decoded = decodeAheRetirementControl(bytes);
	if (!decoded.ok) {
		if (decoded.reason === "READ_BUDGET_EXCEEDED") throw new BoundedReadBudgetError();
		throw new PersistedStorageError("NON_CANONICAL_RECORD");
	}
	if (decoded.value.objectId !== objectId) throw new PersistedStorageError("NON_CANONICAL_RECORD");
	return decoded.value;
}

/**
 * Sole shared census, including addressed metadata charge, within original native transaction.
 * @param transaction
 * @param objectId
 * @param bytes
 */
export async function admitBrowserRetirementControl(
	transaction: IDBTransaction,
	objectId: StorageObjectId,
	bytes: Uint8Array | null, facts?: BoundedReadNativeFacts
): Promise<StoreResult<RetirementAdmission>> {
	const retained = facts?.within(transaction) ? facts : undefined;
	const steps = boundedRetirementAdmissionSteps(objectId, bytes?.byteLength ?? null, true, retained);
	try {
		let step = steps.next();
		while (!step.done) step = steps.next(await loadBrowserBoundedReadRequest(transaction, step.value, retained));
		return step.value;
	} catch (cause) {
		if (cause instanceof BoundedReadBudgetError) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
		throw cause;
	}
}

/**
 * Native request success is provisional; caller must join its original transaction outcome.
 * @param transaction
 * @param control
 * @param birth
 */
export async function writeBrowserRetirementControl(
	transaction: IDBTransaction,
	control: AheRetirementControl,
	birth: boolean
): Promise<void> {
	const row = { key: controlKey(control.objectId), record: encodeAheRetirementControl(control) };
	const store = transaction.objectStore(PHASE_5C_STORAGE_META_STORE);
	await requestValue(birth ? store.add(row) : store.put(row));
}

/**
 * Post-write revision/census guard in the SAME original mutation transaction.
 * @param transaction
 * @param control
 */
export async function advanceBrowserRetirementControl(
	transaction: IDBTransaction,
	control: AheRetirementControl | null
): Promise<StoreResult<void>> {
	if (control === null) return { ok: true, value: undefined };
	if (control.revision === Number.MAX_SAFE_INTEGER) return { ok: false, reason: "REVISION_EXHAUSTED" };
	const next = { ...control, revision: control.revision + 1 };
	const admitted = await admitBrowserRetirementControl(transaction, control.objectId, encodeAheRetirementControl(next));
	if (!admitted.ok) return admitted;
	await writeBrowserRetirementControl(transaction, next, false);
	return { ok: true, value: undefined };
}
