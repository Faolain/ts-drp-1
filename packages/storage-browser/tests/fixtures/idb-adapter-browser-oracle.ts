import type { BlobDigest } from "@ts-drp/storage";

export interface Phase2dTransactionTrace {
	readonly durability: "default" | "relaxed" | "strict";
	readonly mode: "readonly" | "readwrite" | "versionchange";
	readonly operation: string;
	readonly stores: readonly string[];
}

export interface Phase2dStoreCallTrace {
	readonly method: "add" | "get" | "getAll" | "put";
	readonly count?: number;
	readonly operation: string;
	readonly query?: Readonly<{
		readonly lower: unknown;
		readonly lowerOpen: boolean;
		readonly upper: unknown;
		readonly upperOpen: boolean;
	}>;
	readonly store: string;
}

export interface Phase2dTerminalGate<T> {
	readonly operation: Promise<T>;
	release(): void;
	readonly started: Promise<void>;
	readonly terminalObserved: Promise<void>;
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
 * Clears one physical head through the independent raw-IDB corruption oracle.
 * @param name - Isolated database name.
 * @param objectId - Creator-bound object whose adopted generation survives.
 */
export async function rawPhase2dClearHead(name: string, objectId: string): Promise<void> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction("objects", "readwrite", { durability: "strict" });
		transaction.objectStore("objects").put({ objectId, record: null });
		await transactionCompletion(transaction);
	} finally {
		database.close();
	}
}

/**
 * Copies one canonical generation record under a deliberately different physical key.
 * @param name - Isolated database name.
 * @param objectId - Object component of both compound keys.
 * @param sourceGenerationId - Canonical source row whose record bytes are retained.
 * @param physicalGenerationId - Deliberately mismatched physical key component.
 */
export async function rawPhase2dAliasGenerationRecord(
	name: string,
	objectId: string,
	sourceGenerationId: string,
	physicalGenerationId: string
): Promise<void> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction("generations", "readwrite", { durability: "strict" });
		const store = transaction.objectStore("generations");
		const source = await requestResult(store.get([objectId, sourceGenerationId]));
		const record = typeof source === "object" && source !== null ? Reflect.get(source, "record") : undefined;
		if (!(record instanceof Uint8Array)) throw new Error("source generation row is missing canonical bytes");
		store.put({ generationId: physicalGenerationId, objectId, record: new Uint8Array(record) });
		await transactionCompletion(transaction);
	} finally {
		database.close();
	}
}

/**
 * Requests a real version upgrade and waits for the upgraded connection to open.
 * @param name - Isolated database name.
 * @param version - Higher schema version used only to trigger versionchange.
 */
export async function requestPhase2dVersionchange(name: string, version: number): Promise<void> {
	const database = await requestResult(indexedDB.open(name, version));
	database.close();
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
 * Gates delivery of the next real readwrite transaction's terminal event to the
 * adapter while independently exposing when Chromium emitted that event.
 * @param run - Starts exactly one adapter mutation.
 * @returns The operation and explicit deterministic gate controls.
 */
export function gateNextPhase2dTransactionTerminal<T>(run: () => Promise<T>): Phase2dTerminalGate<T> {
	const originalTransaction = IDBDatabase.prototype.transaction;
	const originalAddEventListener = IDBTransaction.prototype.addEventListener;
	let selected: IDBTransaction | undefined;
	let releaseGate: (() => void) | undefined;
	let startedGate: (() => void) | undefined;
	let terminalGate: (() => void) | undefined;
	const released = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	const started = new Promise<void>((resolve) => {
		startedGate = resolve;
	});
	const terminalObserved = new Promise<void>((resolve) => {
		terminalGate = resolve;
	});

	IDBDatabase.prototype.transaction = function gatedTransaction(
		this: IDBDatabase,
		storeNames: string | string[],
		mode?: IDBTransactionMode,
		options?: IDBTransactionOptions
	): IDBTransaction {
		const transaction = originalTransaction.call(this, storeNames, mode, options);
		if (selected === undefined && transaction.mode === "readwrite") {
			selected = transaction;
			startedGate?.();
		}
		return transaction;
	};
	IDBTransaction.prototype.addEventListener = function gatedTerminalListener(
		this: IDBTransaction,
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions
	): void {
		if (listener === null) return;
		if (this !== selected || (type !== "complete" && type !== "abort")) {
			originalAddEventListener.call(this, type, listener, options);
			return;
		}
		const terminalListener = listener;
		originalAddEventListener.call(
			this,
			type,
			(event: Event) => {
				terminalGate?.();
				void released.then(() => {
					if (typeof terminalListener === "function") terminalListener.call(event.currentTarget, event);
					else terminalListener.handleEvent(event);
				});
			},
			options
		);
	};

	let operation: Promise<T>;
	try {
		operation = run();
	} finally {
		IDBDatabase.prototype.transaction = originalTransaction;
		IDBTransaction.prototype.addEventListener = originalAddEventListener;
	}
	return Object.freeze({
		operation,
		release: (): void => releaseGate?.(),
		started,
		terminalObserved,
	});
}

/**
 * Forces only the live observed durability of one real adapter transaction.
 * The adapter's requested options and physical writes remain independently
 * recorded.
 * @param observed - Observation exposed to production.
 * @param run - Starts exactly one real adapter mutation.
 * @returns The requested/observed durability, result and exact physical writes.
 */
export async function withForcedPhase2dDurability<T>(
	observed: "default" | "relaxed" | "strict",
	run: () => Promise<T>
): Promise<{
	readonly observed: "default" | "relaxed" | "strict";
	readonly requested: "default" | "relaxed" | "strict" | undefined;
	readonly result: T;
	readonly writes: readonly string[];
}> {
	const originalTransaction = IDBDatabase.prototype.transaction;
	const originalAdd = IDBObjectStore.prototype.add;
	const originalPut = IDBObjectStore.prototype.put;
	let requested: "default" | "relaxed" | "strict" | undefined;
	const writes: string[] = [];
	IDBDatabase.prototype.transaction = function forcedDurabilityTransaction(
		this: IDBDatabase,
		storeNames: string | string[],
		mode?: IDBTransactionMode,
		options?: IDBTransactionOptions
	): IDBTransaction {
		const transaction = originalTransaction.call(this, storeNames, mode, options);
		if (transaction.mode === "readwrite") {
			requested = options?.durability;
			Object.defineProperty(transaction, "durability", {
				configurable: true,
				get: () => observed,
			});
		}
		return transaction;
	};
	IDBObjectStore.prototype.add = function forcedDurabilityAdd(
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	): IDBRequest<IDBValidKey> {
		writes.push(`add:${this.name}`);
		return key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
	};
	IDBObjectStore.prototype.put = function forcedDurabilityPut(
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	): IDBRequest<IDBValidKey> {
		writes.push(`put:${this.name}`);
		return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
	};
	try {
		const result = await run();
		return Object.freeze({ observed, requested, result, writes: Object.freeze([...writes]) });
	} finally {
		IDBDatabase.prototype.transaction = originalTransaction;
		IDBObjectStore.prototype.add = originalAdd;
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
		calls.push({
			...(count === undefined ? {} : { count }),
			method: "getAll",
			operation,
			...(query instanceof IDBKeyRange
				? {
						query: {
							lower: query.lower,
							lowerOpen: query.lowerOpen,
							upper: query.upper,
							upperOpen: query.upperOpen,
						},
					}
				: {}),
			store: this.name,
		});
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
