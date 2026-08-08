import type { BlobDigest } from "@ts-drp/storage";

export interface Phase2dTransactionTrace {
	readonly durability: "default" | "relaxed" | "strict";
	readonly mode: "readonly" | "readwrite" | "versionchange";
	readonly operation: string;
	readonly stores: readonly string[];
}

export interface Phase2dStoreCallTrace {
	readonly method: "add" | "get" | "getAll" | "put";
	readonly operation: string;
	readonly store: string;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IDB request failed")), { once: true });
	});
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IDB transaction aborted")), {
			once: true,
		});
		transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IDB transaction failed")), {
			once: true,
		});
	});
}

/**
 * Deletes one isolated Phase 2d2a test database.
 * @param name - Isolated database name.
 */
export async function deletePhase2dDatabase(name: string): Promise<void> {
	await requestResult(indexedDB.deleteDatabase(name));
}

/**
 * Reads one physical row through the independent raw-IDB oracle.
 * @param name - Isolated database name.
 * @param storeName - Physical object-store name.
 * @param key - Native direct or compound key.
 * @returns The stored row, or undefined when absent.
 */
export async function rawPhase2dGet(
	name: string,
	storeName: string,
	key: string | readonly string[]
): Promise<unknown> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction(storeName, "readonly");
		const result = await requestResult(transaction.objectStore(storeName).get(key as IDBValidKey));
		await transactionCompletion(transaction);
		return result;
	} finally {
		database.close();
	}
}

/**
 * Counts one physical store through the independent raw-IDB oracle.
 * @param name - Isolated database name.
 * @param storeName - Physical object-store name.
 * @returns The exact row count.
 */
export async function rawPhase2dCount(name: string, storeName: string): Promise<number> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction(storeName, "readonly");
		const count = await requestResult(transaction.objectStore(storeName).count());
		await transactionCompletion(transaction);
		return count;
	} finally {
		database.close();
	}
}

/**
 * Injects corrupt bytes under an otherwise canonical digest for a negative control.
 * @param name - Isolated database name.
 * @param digest - Canonical blob key whose payload is corrupted.
 * @param bytes - Deliberately non-matching bytes.
 */
export async function rawPhase2dReplaceBlob(name: string, digest: BlobDigest, bytes: Uint8Array): Promise<void> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction("blobs", "readwrite", { durability: "strict" });
		transaction.objectStore("blobs").put({ bytes: new Uint8Array(bytes), digest });
		await transactionCompletion(transaction);
	} finally {
		database.close();
	}
}

/**
 * Injects a synchronous failure at the head-row write and restores the platform method.
 * @param run - Adapter operation expected to attempt a head write.
 * @returns The operation result.
 */
export async function withFailingHeadWrite<T>(run: () => Promise<T>): Promise<T> {
	const originalPut = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = function failingHeadPut(
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	): IDBRequest<IDBValidKey> {
		if (this.name === "objects") throw new DOMException("injected head write failure", "UnknownError");
		return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
	};
	try {
		return await run();
	} finally {
		IDBObjectStore.prototype.put = originalPut;
	}
}

/**
 * Records the real transaction, load and write calls made by one adapter scenario.
 * @param run - Scenario receiving a setter for the currently executing adapter operation.
 * @returns Exact transaction and physical store-call traces.
 */
export async function withPhase2dTransactionTrace<T>(run: (mark: (operation: string) => void) => Promise<T>): Promise<{
	readonly calls: Phase2dStoreCallTrace[];
	readonly result: T;
	readonly transactions: Phase2dTransactionTrace[];
}> {
	const originalTransaction = IDBDatabase.prototype.transaction;
	const originalAdd = IDBObjectStore.prototype.add;
	const originalGet = IDBObjectStore.prototype.get;
	const originalGetAll = IDBObjectStore.prototype.getAll;
	const originalPut = IDBObjectStore.prototype.put;
	const transactions: Phase2dTransactionTrace[] = [];
	const calls: Phase2dStoreCallTrace[] = [];
	let operation = "unscoped";
	const mark = (value: string): void => {
		operation = value;
	};
	IDBDatabase.prototype.transaction = function tracedTransaction(
		this: IDBDatabase,
		storeNames: string | string[],
		mode?: IDBTransactionMode,
		options?: IDBTransactionOptions
	): IDBTransaction {
		const transaction = originalTransaction.call(this, storeNames, mode, options);
		transactions.push({
			durability: transaction.durability,
			mode: transaction.mode,
			operation,
			stores: [...transaction.objectStoreNames].sort(),
		});
		return transaction;
	};
	IDBObjectStore.prototype.add = function tracedAdd(
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	): IDBRequest<IDBValidKey> {
		calls.push({ method: "add", operation, store: this.name });
		return key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
	};
	IDBObjectStore.prototype.get = function tracedGet(
		this: IDBObjectStore,
		query: IDBValidKey | IDBKeyRange
	): IDBRequest<unknown> {
		calls.push({ method: "get", operation, store: this.name });
		return originalGet.call(this, query);
	};
	IDBObjectStore.prototype.getAll = function tracedGetAll(
		this: IDBObjectStore,
		query?: IDBValidKey | IDBKeyRange | null,
		count?: number
	): IDBRequest<unknown[]> {
		calls.push({ method: "getAll", operation, store: this.name });
		return count === undefined ? originalGetAll.call(this, query) : originalGetAll.call(this, query, count);
	};
	IDBObjectStore.prototype.put = function tracedPut(
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	): IDBRequest<IDBValidKey> {
		calls.push({ method: "put", operation, store: this.name });
		return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
	};
	try {
		return { calls, result: await run(mark), transactions };
	} finally {
		IDBDatabase.prototype.transaction = originalTransaction;
		IDBObjectStore.prototype.add = originalAdd;
		IDBObjectStore.prototype.get = originalGet;
		IDBObjectStore.prototype.getAll = originalGetAll;
		IDBObjectStore.prototype.put = originalPut;
	}
}
