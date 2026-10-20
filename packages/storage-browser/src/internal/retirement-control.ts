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
	roomStoreName,
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

/** Blob gets kept in flight ahead of the serial step that consumes them. */
const BLOB_PREFETCH_WINDOW = 16;

/**
 * Pipelines the exact gets ONE serial step driver is about to issue, in ONE
 * native transaction. The driver issues no write while it runs, so a get sent
 * early returns exactly what the same get would return when its step arrives.
 * Each value is consumed once by its own step and every check stays with that
 * step. Nothing outlives the drive; no other transaction or caller sees it.
 */
export class BrowserBoundedReadPrefetch {
	readonly #transaction: IDBTransaction;
	readonly #generations = new Map<string, Promise<unknown>>();
	readonly #blobs = new Map<string, Promise<unknown>>();
	readonly #promotions = new Map<string, Promise<ReadonlySet<string> | undefined>>();
	#queued: string[] = [];
	constructor(transaction: IDBTransaction) {
		this.#transaction = transaction;
	}
	#issue(read: () => IDBRequest): Promise<unknown> | undefined {
		try {
			const pending = requestValue(read());
			// A get the serial driver never reaches is never observed; its consuming
			// step, when it exists, still receives the original rejection.
			void pending.catch(() => undefined);
			return pending;
		} catch {
			// The serial get at its own step reports the native refusal itself.
			return undefined;
		}
	}
	generations(transaction: IDBTransaction, objectId: string, keys: readonly unknown[]): void {
		if (transaction !== this.#transaction) return;
		for (const key of keys) {
			if (typeof key !== "string") continue;
			const address = JSON.stringify([objectId, key]);
			if (this.#generations.has(address)) continue;
			const pending = this.#issue(() => transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_GENERATIONS_STORE)).get([objectId, key]));
			if (pending !== undefined) this.#generations.set(address, pending);
		}
	}
	takeGeneration(transaction: IDBTransaction, objectId: string, generationId: string): Promise<unknown> | undefined {
		if (transaction !== this.#transaction) return undefined;
		const address = JSON.stringify([objectId, generationId]);
		const pending = this.#generations.get(address);
		this.#generations.delete(address);
		return pending;
	}
	/** Membership of ONE exact promotion key from one complete key read of the
	 * object's promotion range; undefined when that read is not complete. */
	async promotion(transaction: IDBTransaction, objectId: string, generationId: string, digest: string):
		Promise<boolean | undefined> {
		if (transaction !== this.#transaction) return undefined;
		let keys = this.#promotions.get(objectId);
		if (keys === undefined) {
			const limit = AHE_LOCAL_CONTROL_CENSUS_LIMITS.maxPromotions + 1;
			const read = this.#issue(() =>
				transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_PROMOTIONS_STORE)).getAllKeys(exactObjectKeyRange(objectId), limit));
			if (read === undefined) return undefined;
			// Any incomplete or failed read leaves each step to its own exact getKey.
			keys = read.then((rows) => {
				const all = rows as IDBValidKey[];
				if (all.length >= limit) return undefined;
				// Only an all-string stored key can equal an all-string requested key.
				return new Set(all.flatMap((key) =>
					Array.isArray(key) && key.every((part) => typeof part === "string") ? [JSON.stringify(key)] : []));
			}, () => undefined);
			this.#promotions.set(objectId, keys);
		}
		const set = await keys;
		return set?.has(JSON.stringify([objectId, generationId, digest]));
	}
	blobs(transaction: IDBTransaction, digests: readonly string[]): void {
		if (transaction !== this.#transaction) return;
		this.#queued = digests.filter((digest, index) => digests.indexOf(digest) === index && !this.#blobs.has(digest));
		this.#fill();
	}
	#fill(): void {
		while (this.#blobs.size < BLOB_PREFETCH_WINDOW && this.#queued.length !== 0) {
			const digest = this.#queued.shift()!;
			const pending = this.#issue(() => this.#transaction.objectStore(roomStoreName(this.#transaction.db, "ahe", PHASE_2D_BLOBS_STORE)).get(digest));
			if (pending === undefined) {
				this.#queued.length = 0;
				return;
			}
			this.#blobs.set(digest, pending);
		}
	}
	takeBlob(transaction: IDBTransaction, digest: string): Promise<unknown> | undefined {
		if (transaction !== this.#transaction) return undefined;
		const pending = this.#blobs.get(digest);
		if (pending === undefined) return undefined;
		this.#blobs.delete(digest);
		this.#fill();
		return pending;
	}
}

function exactObjectKeyRange(objectId: string): IDBKeyRange {
	// Exactly the keys whose first component is objectId: every such array key
	// sorts at or above [objectId] and below [objectId + "\0"], the immediate
	// successor string; every other key lies outside.
	return IDBKeyRange.bound([objectId], [objectId + "\0"], false, true);
}

/**
 * One mechanical native loader shared by bounded reads and control admission. No transaction/cache/parser owner.
 * @param transaction
 * @param request
 * @param facts
 * @param prefetch - Optional pipeline for this one drive; never changes a result.
 */
export async function loadBrowserBoundedReadRequest(
	transaction: IDBTransaction,
	request: RetirementAdmissionRequest, facts?: BoundedReadNativeFacts, prefetch?: BrowserBoundedReadPrefetch
): Promise<unknown> {
	if (request.kind === "blob-preflight") {
		// IDB clones at its native get boundary. The listed blobs are exactly the
		// gets this driver issues next; send them ahead in this transaction.
		prefetch?.blobs(transaction, request.references.map((reference) => reference.digest));
		return true;
	}
	if (request.kind === "blob-census-preflight") {
		let total = 0;
		for (const reference of request.references) {
			const certified = facts?.within(transaction) ? facts.verifiedBlobLength(reference) : undefined;
			if (certified !== undefined) {
				total += certified;
				if (total > LIMITS.maxUnionBytes) return false;
				continue;
			}
			const row = await requestValue(transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_BLOBS_STORE)).get(reference.digest));
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
				.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_PROMOTIONS_STORE))
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
		// One bounded native key read returns the same ordered prefix the former
		// key cursor walked from [objectId] until its first foreign key.
		const keys = await requestValue(
			transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_GENERATIONS_STORE)).getAllKeys(exactObjectKeyRange(request.objectId), limit)
		);
		const values: unknown[] = [];
		for (const key of keys) {
			if (!Array.isArray(key) || key.length !== 2 || typeof key[1] !== "string" || !parseGenerationId(key[1]).ok) {
				values.push(null);
				break;
			}
			values.push(key[1]);
		}
		prefetch?.generations(transaction, request.objectId, values);
		return values;
	}
	if (request.kind === "promotion") {
		const known = await prefetch?.promotion(transaction, request.objectId, request.generationId, request.digest);
		if (known !== undefined) return known;
		return (
			(await requestValue(
				transaction
					.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_PROMOTIONS_STORE))
					.getKey([request.objectId, request.generationId, request.digest])
			)) !== undefined
		);
	}
	if (request.kind === "blob") {
		const row = await (prefetch?.takeBlob(transaction, request.digest) ??
			requestValue(transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_2D_BLOBS_STORE)).get(request.digest)));
		if (row === undefined) return null;
		if (!exactRow(row, ["digest", "bytes"]) || property(row, "digest") !== request.digest)
			throw new PersistedStorageError("NON_CANONICAL_RECORD");
		return property(row, "bytes");
	}
	const head = request.kind === "head";
	const row = await ((head ? undefined : prefetch?.takeGeneration(transaction, request.objectId, request.generationId)) ??
		requestValue(
			transaction
				.objectStore(roomStoreName(transaction.db, "ahe", head ? PHASE_2D_OBJECTS_STORE : PHASE_2D_GENERATIONS_STORE))
				.get(head ? request.objectId : [request.objectId, request.generationId])
		));
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
	const row = await requestValue(transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_5C_STORAGE_META_STORE)).get(controlKey(objectId)));
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
	const prefetch = new BrowserBoundedReadPrefetch(transaction);
	try {
		let step = steps.next();
		while (!step.done) step = steps.next(await loadBrowserBoundedReadRequest(transaction, step.value, retained, prefetch));
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
	const store = transaction.objectStore(roomStoreName(transaction.db, "ahe", PHASE_5C_STORAGE_META_STORE));
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
