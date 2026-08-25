import type { BlobDigest } from "@ts-drp/storage";

import type {
	Phase2e6DeclaredEdge,
	Phase2e6PersistentImage,
	Phase2e6TraceEvent,
} from "./phase-2e6-real-process-death-contract.js";

export interface Phase2dTransactionTrace {
	readonly durability: "default" | "relaxed" | "strict";
	readonly mode: "readonly" | "readwrite" | "versionchange";
	readonly operation: string;
	readonly stores: readonly string[];
}

export interface Phase2e6DatabaseLifecycleTrace {
	readonly createCount: number;
	readonly deleteCount: number;
	restore(): void;
}

const PHASE_2E6_STORE_NAMES = ["objects", "generations", "blobs", "promotions"] as const;
const CURRENT_PRIMARY_DATABASE_VERSION = 2;

/**
 * Counts post-seed database creation/deletion calls in one browser realm.
 * @returns Exact live counters and a restoration boundary.
 */
export function tracePhase2e6DatabaseLifecycle(): Phase2e6DatabaseLifecycleTrace {
	const originalCreateObjectStore = IDBDatabase.prototype.createObjectStore;
	const originalDeleteDatabase = IDBFactory.prototype.deleteDatabase;
	let createCount = 0;
	let deleteCount = 0;
	IDBDatabase.prototype.createObjectStore = function phase2e6CreateObjectStore(
		this: IDBDatabase,
		name: string,
		options?: IDBObjectStoreParameters
	): IDBObjectStore {
		createCount += 1;
		return originalCreateObjectStore.call(this, name, options);
	};
	IDBFactory.prototype.deleteDatabase = function phase2e6DeleteDatabase(
		this: IDBFactory,
		name: string
	): IDBOpenDBRequest {
		deleteCount += 1;
		return originalDeleteDatabase.call(this, name);
	};
	return {
		get createCount(): number {
			return createCount;
		},
		get deleteCount(): number {
			return deleteCount;
		},
		restore: (): void => {
			IDBDatabase.prototype.createObjectStore = originalCreateObjectStore;
			IDBFactory.prototype.deleteDatabase = originalDeleteDatabase;
		},
	};
}

/**
 * Finds one exact current primary database before any recovery open can create it.
 * @param databaseName - Exact database identity selected before process death.
 * @returns The unique matching persisted name, or null.
 */
export async function rawPhase2e6DatabaseIdentity(databaseName: string): Promise<string | null> {
	let matchCount = 0;
	let matchedName: string | null = null;
	for (const database of await indexedDB.databases()) {
		if (database.name !== databaseName || database.version !== CURRENT_PRIMARY_DATABASE_VERSION) continue;
		matchCount += 1;
		matchedName = database.name;
	}
	return matchCount === 1 ? matchedName : null;
}

/**
 * Reads the actual schema identity of an existing production browser store.
 * @param databaseName - Exact production database identity.
 * @returns Version and native schema store-name projection.
 */
export async function rawPhase2hDatabaseSchema(
	databaseName: string
): Promise<Readonly<{ storeNames: readonly string[]; version: number }>> {
	const database = await requestResult(indexedDB.open(databaseName));
	try {
		return Object.freeze({
			storeNames: Object.freeze([...database.objectStoreNames]),
			version: database.version,
		});
	} finally {
		database.close();
	}
}

function phase2e6Plain(value: unknown): unknown {
	if (value instanceof Uint8Array) return [...value];
	if (Array.isArray(value)) return value.map(phase2e6Plain);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, phase2e6Plain(nested)]));
}

/**
 * Reads the exact four-store persistent image through readonly raw IndexedDB.
 * @param databaseName - Existing database reopened after process death.
 * @returns Plain detached rows in native key order.
 */
export async function rawPhase2e6PersistentImage(databaseName: string): Promise<Phase2e6PersistentImage> {
	const database = await requestResult(indexedDB.open(databaseName));
	try {
		const transaction = database.transaction([...PHASE_2E6_STORE_NAMES], "readonly");
		const completion = transactionCompletion(transaction);
		const rows = await Promise.all(
			PHASE_2E6_STORE_NAMES.map((storeName) => requestResult(transaction.objectStore(storeName).getAll()))
		);
		await completion;
		return Object.freeze({
			blobs: Object.freeze(phase2e6Plain(rows[2]) as readonly unknown[]),
			generations: Object.freeze(phase2e6Plain(rows[1]) as readonly unknown[]),
			objects: Object.freeze(phase2e6Plain(rows[0]) as readonly unknown[]),
			promotions: Object.freeze(phase2e6Plain(rows[3]) as readonly unknown[]),
		});
	} finally {
		database.close();
	}
}

/**
 * Intercepts actual adapter request settlements before adapter listeners run.
 * @param edge - Exact data-derived arm edge.
 * @param signal - Worker-owned blocking signal.
 * @param onArm - Synchronous relay invoked at the requested settlement.
 * @param run - Actual adapter operation to observe.
 * @returns Operation result and exact occurrence-sensitive trace.
 */
export async function withPhase2e6SettlementTrace<T>(
	edge: Phase2e6DeclaredEdge,
	signal: SharedArrayBuffer,
	onArm: (trace: readonly Phase2e6TraceEvent[], transactionCount: number) => void,
	run: () => Promise<T>
): Promise<{ readonly result: T; readonly trace: readonly Phase2e6TraceEvent[] }> {
	const originalTransaction = IDBDatabase.prototype.transaction;
	const originalTransactionAddEventListener = IDBTransaction.prototype.addEventListener;
	const originalAdd = IDBObjectStore.prototype.add;
	const originalGet = IDBObjectStore.prototype.get;
	const originalGetAll = IDBObjectStore.prototype.getAll;
	const originalPut = IDBObjectStore.prototype.put;
	const trace: Phase2e6TraceEvent[] = [];
	let requestIndex = 0;
	let transactionCount = 0;
	const target = edge.id.replace(/\/after$/u, "/success");
	const reached = (event: Phase2e6TraceEvent): void => {
		trace.push(Object.freeze(event));
		if (event.id !== target) return;
		const cell = new Int32Array(signal);
		if (Atomics.compareExchange(cell, 0, 0, 1) !== 0) throw new Error("requested arm reached more than once");
		onArm(Object.freeze([...trace]), transactionCount);
		Atomics.wait(cell, 0, 1);
	};
	const observe = <TResult>(
		kind: "add" | "get" | "getAll" | "put",
		store: string,
		request: IDBRequest<TResult>
	): IDBRequest<TResult> => {
		const base = `${edge.scenarioId}/request-${String(requestIndex++).padStart(2, "0")}-${kind}-${store}`;
		reached({ id: `${base}/created`, kind: "request-created" });
		request.addEventListener("success", () => reached({ id: `${base}/success`, kind: "request-success" }), {
			once: true,
		});
		return request;
	};
	IDBDatabase.prototype.transaction = function phase2e6Transaction(
		this: IDBDatabase,
		stores: string | string[],
		mode?: IDBTransactionMode,
		options?: IDBTransactionOptions
	): IDBTransaction {
		const transaction = originalTransaction.call(this, stores, mode, options);
		transactionCount += 1;
		originalTransactionAddEventListener.call(
			transaction,
			"complete",
			() => reached({ id: `${edge.scenarioId}/transaction-terminal-complete/success`, kind: "transaction-complete" }),
			{ once: true }
		);
		return transaction;
	};
	IDBObjectStore.prototype.add = function phase2e6Add(
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	): IDBRequest<IDBValidKey> {
		return observe(
			"add",
			this.name,
			key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key)
		);
	};
	IDBObjectStore.prototype.get = function phase2e6Get(
		this: IDBObjectStore,
		query: IDBValidKey | IDBKeyRange
	): IDBRequest<unknown> {
		return observe("get", this.name, originalGet.call(this, query));
	};
	IDBObjectStore.prototype.getAll = function phase2e6GetAll(
		this: IDBObjectStore,
		query?: IDBValidKey | IDBKeyRange | null,
		count?: number
	): IDBRequest<unknown[]> {
		return observe(
			"getAll",
			this.name,
			count === undefined ? originalGetAll.call(this, query) : originalGetAll.call(this, query, count)
		);
	};
	IDBObjectStore.prototype.put = function phase2e6Put(
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	): IDBRequest<IDBValidKey> {
		return observe(
			"put",
			this.name,
			key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key)
		);
	};
	try {
		return { result: await run(), trace: Object.freeze([...trace]) };
	} finally {
		IDBDatabase.prototype.transaction = originalTransaction;
		IDBTransaction.prototype.addEventListener = originalTransactionAddEventListener;
		IDBObjectStore.prototype.add = originalAdd;
		IDBObjectStore.prototype.get = originalGet;
		IDBObjectStore.prototype.getAll = originalGetAll;
		IDBObjectStore.prototype.put = originalPut;
	}
}

export interface Phase2dStoreCallTrace {
	readonly method: "add" | "get" | "getAll" | "put";
	readonly count?: number;
	readonly key?: unknown;
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

export interface Phase2e5RequestTrace {
	readonly count?: number;
	readonly kind: "add" | "get" | "getAll" | "put";
	readonly store: string;
	readonly transaction: number;
}

export interface Phase2e5TransactionTrace {
	readonly durability: "default" | "relaxed" | "strict";
	readonly id: number;
	readonly mode: "readonly" | "readwrite" | "versionchange";
	readonly requestedDurability: "default" | "relaxed" | "strict" | null;
	readonly stores: readonly string[];
	readonly terminal: "abort" | "complete" | null;
}

export interface Phase2e5InventoryTrace<T> {
	readonly requests: readonly Phase2e5RequestTrace[];
	readonly result: T;
	readonly transactions: readonly Phase2e5TransactionTrace[];
}

export interface Phase2gQuotaFaultArm {
	readonly requestIndex?: number;
	readonly target: "creation" | "settlement" | "terminal";
	readonly terminalWriteIndex?: number;
}

export interface Phase2gQuotaFaultTrace<T> extends Phase2e5InventoryTrace<T> {
	readonly fault: DOMException;
	readonly faultArmed: boolean;
	readonly faultsFired: number;
	readonly operationReturnedAfterTerminal: boolean;
	readonly selectedRequestError: unknown;
	readonly selectedOccurrenceInTrace: boolean;
	readonly settlementAbortAttributedToRequestError: boolean;
	readonly settlementExplicitHarnessAbortCalls: number;
	readonly settlementIndependentAbortScheduled: boolean;
	readonly settlementNativeRequestFailureObserved: boolean;
	readonly settlementNativeRequestFailureDefaultAllowed: boolean;
	readonly settlementRequestErrorBeforeAbortConsequence: boolean;
	readonly settlementRequestErrorEvents: number;
	readonly settlementRequestErrorIsSameRealmQuotaFault: boolean;
	readonly settlementRequestReadyStateDoneAtTrustedError: boolean;
	readonly settlementSyntheticDispatchCalls: number;
	readonly settlementSyntheticRequestSuccessEvents: number;
	readonly settlementRequestSuccessEvents: number;
	readonly settlementTransactionAbortAfterRequestError: boolean;
	readonly settlementTransactionAbortAfterTrustedRequestError: boolean;
	readonly settlementTrustedRequestErrorEvents: number;
	readonly settlementTrustedRequestSuccessEvents: number;
	readonly settlementTrustedTransactionAbortEvents: number;
	readonly writesObserved: number;
}

const PHASE_2G_SETTLEMENT_CANARY_OBJECT_ID = `phase-2g-c-unrelated:${"d".repeat(32)}`;
const PHASE_2G_SETTLEMENT_CANARY_GENERATION_ID = "d".repeat(64);
const PHASE_2G_SETTLEMENT_CANARY_DIGEST = "b0deb0cf0cf838277980653bc734cde47177b91cf3e4f29914fb03fcab69c3db";

function phase2gSettlementCollision(storeName: string): unknown {
	switch (storeName) {
		case "blobs":
			return { digest: PHASE_2G_SETTLEMENT_CANARY_DIGEST };
		case "generations":
			return {
				generationId: PHASE_2G_SETTLEMENT_CANARY_GENERATION_ID,
				objectId: PHASE_2G_SETTLEMENT_CANARY_OBJECT_ID,
			};
		case "objects":
			return { objectId: PHASE_2G_SETTLEMENT_CANARY_OBJECT_ID };
		case "promotions":
			return {
				digest: PHASE_2G_SETTLEMENT_CANARY_DIGEST,
				generationId: PHASE_2G_SETTLEMENT_CANARY_GENERATION_ID,
				objectId: PHASE_2G_SETTLEMENT_CANARY_OBJECT_ID,
			};
		default:
			throw new Error(`Phase 2g settlement selected an unknown store: ${storeName}`);
	}
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
 * Reads exact raw rows for Phase 2e2 zero-write comparisons.
 * @param name - Isolated database name.
 * @returns Exact rows from every storage-owned store.
 */
export async function rawPhase2e2Snapshot(name: string): Promise<unknown> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction(["objects", "generations", "blobs", "promotions"], "readonly");
		const snapshot = await Promise.all(
			["objects", "generations", "blobs", "promotions"].map(async (storeName) => {
				const rows = await requestResult(transaction.objectStore(storeName).getAll());
				return [storeName, rows] as const;
			})
		);
		await transactionCompletion(transaction);
		return snapshot;
	} finally {
		database.close();
	}
}

/**
 * Replaces one raw row to seed a persisted-corruption case.
 * @param name - Isolated database name.
 * @param storeName - Physical store to alter.
 * @param row - Test-owned raw row.
 */
export async function rawPhase2e2Put(name: string, storeName: string, row: unknown): Promise<void> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction(storeName, "readwrite", { durability: "strict" });
		transaction.objectStore(storeName).put(row);
		await transactionCompletion(transaction);
	} finally {
		database.close();
	}
}

/**
 * Inserts a bounded test-owned batch in one transaction for the Phase 2e3
 * multi-page recovery fixture. This remains the sole raw-IDB corruption owner.
 * @param name - Isolated database name.
 * @param storeName - Physical store to alter.
 * @param rows - Test-owned raw rows.
 */
export async function rawPhase2e3PutMany(name: string, storeName: string, rows: readonly unknown[]): Promise<void> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction(storeName, "readwrite", { durability: "strict" });
		const store = transaction.objectStore(storeName);
		for (const row of rows) store.put(row);
		await transactionCompletion(transaction);
	} finally {
		database.close();
	}
}

/**
 * Deterministic control for the one-authoritative-blob-request probe. The
 * `batched` mutant deliberately issues both gets before either settles.
 * @param name - Isolated database name.
 * @param digests - Two physical blob keys.
 * @param batched - Whether to issue the unsafe batched mutant.
 */
export async function probePhase2e3BlobRequestPeak(
	name: string,
	digests: readonly [string, string],
	batched: boolean
): Promise<void> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction("blobs", "readonly");
		const store = transaction.objectStore("blobs");
		if (batched) {
			await Promise.all([requestResult(store.get(digests[0])), requestResult(store.get(digests[1]))]);
		} else {
			await requestResult(store.get(digests[0]));
			await requestResult(store.get(digests[1]));
		}
		await transactionCompletion(transaction);
	} finally {
		database.close();
	}
}

/**
 * Deletes one raw row to seed a relational contradiction.
 * @param name - Isolated database name.
 * @param storeName - Physical store to alter.
 * @param key - Direct or compound physical key.
 */
export async function rawPhase2e2Delete(
	name: string,
	storeName: string,
	key: string | readonly string[]
): Promise<void> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction(storeName, "readwrite", { durability: "strict" });
		transaction.objectStore(storeName).delete(key as IDBValidKey);
		await transactionCompletion(transaction);
	} finally {
		database.close();
	}
}

/**
 * Creates one incompatible v1 database without invoking production opening.
 * @param name - Isolated database name.
 */
export async function rawPhase2e2CreateWrongSchema(name: string): Promise<void> {
	await deletePhase2dDatabase(name);
	const request = indexedDB.open(name, 1);
	request.addEventListener(
		"upgradeneeded",
		() => {
			request.result.createObjectStore("objects", { keyPath: "wrongKey" });
		},
		{ once: true }
	);
	const database = await requestResult(request);
	database.close();
}

/**
 * Injects one read failure without intercepting any write request.
 * @param run - Adapter operation expected to read the generation journal.
 * @returns The adapter operation result.
 */
export async function withFailingGenerationRead<T>(run: () => Promise<T>): Promise<T> {
	const originalGetAll = IDBObjectStore.prototype.getAll;
	IDBObjectStore.prototype.getAll = function failingGenerationRead(
		this: IDBObjectStore,
		query?: IDBValidKey | IDBKeyRange | null,
		count?: number
	): IDBRequest<unknown[]> {
		if (this.name === "generations") throw new DOMException("injected generation read failure", "UnknownError");
		return originalGetAll.call(this, query, count);
	};
	try {
		return await run();
	} finally {
		IDBObjectStore.prototype.getAll = originalGetAll;
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
	readonly peakOutstandingBlobGets: number;
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
	let outstandingBlobGets = 0;
	let peakOutstandingBlobGets = 0;
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
		const phase2e3KeyTrace = /authority-gap|recoverActiveGeneration|reverify|incremental|batched/.test(operation);
		calls.push({ ...(phase2e3KeyTrace ? { key: query } : {}), method: "get", operation, store: this.name });
		const request = originalGet.call(this, query);
		if (this.name === "blobs") {
			outstandingBlobGets++;
			peakOutstandingBlobGets = Math.max(peakOutstandingBlobGets, outstandingBlobGets);
			const release = (): void => {
				outstandingBlobGets--;
			};
			request.addEventListener("success", release, { once: true });
			request.addEventListener("error", release, { once: true });
		}
		return request;
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
		const result = await run(mark);
		return { calls, peakOutstandingBlobGets, result, transactions };
	} finally {
		IDBDatabase.prototype.transaction = originalTransaction;
		IDBObjectStore.prototype.add = originalAdd;
		IDBObjectStore.prototype.get = originalGet;
		IDBObjectStore.prototype.getAll = originalGetAll;
		IDBObjectStore.prototype.put = originalPut;
	}
}

/**
 * Observes one or more production-adapter transactions as a closed request
 * creation sequence. It deliberately records no request settlement timing.
 * @param run - Starts the real adapter path under observation.
 * @returns Exact transaction metadata, request creation order and result.
 */
export async function withPhase2e5RequestInventoryTrace<T>(run: () => Promise<T>): Promise<Phase2e5InventoryTrace<T>> {
	const originalTransaction = IDBDatabase.prototype.transaction;
	const originalTransactionAddEventListener = IDBTransaction.prototype.addEventListener;
	const originalAdd = IDBObjectStore.prototype.add;
	const originalGet = IDBObjectStore.prototype.get;
	const originalGetAll = IDBObjectStore.prototype.getAll;
	const originalPut = IDBObjectStore.prototype.put;
	const transactions: Array<{
		durability: "default" | "relaxed" | "strict";
		id: number;
		mode: "readonly" | "readwrite" | "versionchange";
		requestedDurability: "default" | "relaxed" | "strict" | null;
		stores: readonly string[];
		terminal: "abort" | "complete" | null;
	}> = [];
	const requests: Phase2e5RequestTrace[] = [];

	const transactionId = (): number => {
		if (transactions.length !== 1) throw new Error("Phase 2e5 observed a request outside its sole transaction");
		return 0;
	};

	IDBDatabase.prototype.transaction = function phase2e5InventoryTransaction(
		this: IDBDatabase,
		storeNames: string | string[],
		mode?: IDBTransactionMode,
		options?: IDBTransactionOptions
	): IDBTransaction {
		const transaction = originalTransaction.call(this, storeNames, mode, options);
		const id = transactions.length;
		const trace = {
			durability: transaction.durability,
			id,
			mode: transaction.mode,
			requestedDurability: options?.durability ?? null,
			stores: [...transaction.objectStoreNames].sort(),
			terminal: null as "abort" | "complete" | null,
		};
		transactions.push(trace);
		originalTransactionAddEventListener.call(
			transaction,
			"complete",
			() => {
				trace.terminal = "complete";
			},
			{ once: true }
		);
		originalTransactionAddEventListener.call(
			transaction,
			"abort",
			() => {
				trace.terminal = "abort";
			},
			{ once: true }
		);
		return transaction;
	};
	IDBObjectStore.prototype.add = function phase2e5InventoryAdd(
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	): IDBRequest<IDBValidKey> {
		requests.push({ kind: "add", store: this.name, transaction: transactionId() });
		return key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
	};
	IDBObjectStore.prototype.get = function phase2e5InventoryGet(
		this: IDBObjectStore,
		query: IDBValidKey | IDBKeyRange
	): IDBRequest<unknown> {
		requests.push({ kind: "get", store: this.name, transaction: transactionId() });
		return originalGet.call(this, query);
	};
	IDBObjectStore.prototype.getAll = function phase2e5InventoryGetAll(
		this: IDBObjectStore,
		query?: IDBValidKey | IDBKeyRange | null,
		count?: number
	): IDBRequest<unknown[]> {
		requests.push({
			...(count === undefined ? {} : { count }),
			kind: "getAll",
			store: this.name,
			transaction: transactionId(),
		});
		return count === undefined ? originalGetAll.call(this, query) : originalGetAll.call(this, query, count);
	};
	IDBObjectStore.prototype.put = function phase2e5InventoryPut(
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	): IDBRequest<IDBValidKey> {
		requests.push({ kind: "put", store: this.name, transaction: transactionId() });
		return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
	};
	try {
		const result = await run();
		return {
			requests: Object.freeze(requests.map((request) => Object.freeze({ ...request }))),
			result,
			transactions: Object.freeze(transactions.map((transaction) => Object.freeze({ ...transaction }))),
		};
	} finally {
		IDBDatabase.prototype.transaction = originalTransaction;
		IDBTransaction.prototype.addEventListener = originalTransactionAddEventListener;
		IDBObjectStore.prototype.add = originalAdd;
		IDBObjectStore.prototype.get = originalGet;
		IDBObjectStore.prototype.getAll = originalGetAll;
		IDBObjectStore.prototype.put = originalPut;
	}
}

/**
 * Injects one genuine same-realm quota exception at a trace-selected write edge.
 * Creation throws before the native request is returned, settlement replaces
 * the selected write with a native duplicate-key failure, and
 * terminal aborts after the final declared write settles but before transaction
 * completion.
 * @param arm - Trace-derived request or terminal occurrence.
 * @param run - Starts the real adapter operation under the fault instrument.
 * @returns Exact request/transaction trace, original quota cause, and counters.
 */
export async function withPhase2gQuotaFaultTrace<T>(
	arm: Phase2gQuotaFaultArm,
	run: () => Promise<T>
): Promise<Phase2gQuotaFaultTrace<T>> {
	const originalTransaction = IDBDatabase.prototype.transaction;
	const originalRequestAddEventListener = IDBRequest.prototype.addEventListener;
	const originalTransactionAddEventListener = IDBTransaction.prototype.addEventListener;
	const originalAbort = IDBTransaction.prototype.abort;
	const nativeRequestErrorGetter = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "error")?.get;
	if (nativeRequestErrorGetter === undefined) throw new Error("native IDBRequest.error getter is unavailable");
	const originalAdd = IDBObjectStore.prototype.add;
	const originalGet = IDBObjectStore.prototype.get;
	const originalGetAll = IDBObjectStore.prototype.getAll;
	const originalPut = IDBObjectStore.prototype.put;
	const requests: Phase2e5RequestTrace[] = [];
	const transactions: Array<{
		durability: "default" | "relaxed" | "strict";
		id: number;
		mode: "readonly" | "readwrite" | "versionchange";
		requestedDurability: "default" | "relaxed" | "strict" | null;
		stores: readonly string[];
		terminal: "abort" | "complete" | null;
	}> = [];
	const fault = new DOMException("quota exceeded", "QuotaExceededError");
	let faultsFired = 0;
	let eventOrder = 0;
	let selectedRequestError: unknown;
	let settlementAbortConsequenceOrder = 0;
	const settlementExplicitHarnessAbortCalls = 0;
	const settlementIndependentAbortScheduled = false;
	let settlementNativeRequestFailureObserved = false;
	let settlementNativeRequestFailureDefaultAllowed = false;
	let settlementRequestErrorEvents = 0;
	let settlementRequestErrorOrder = 0;
	let settlementRequestReadyStateDoneAtTrustedError = false;
	let settlementRequestSuccessEvents = 0;
	const settlementSyntheticDispatchCalls = 0;
	let settlementSyntheticRequestSuccessEvents = 0;
	let settlementTransactionAbortOrder = 0;
	let settlementTrustedRequestErrorEvents = 0;
	let settlementTrustedRequestErrorOrder = 0;
	let settlementTrustedRequestSuccessEvents = 0;
	let settlementTrustedTransactionAbortEvents = 0;
	let terminalCount = 0;
	let writesObserved = 0;

	const transactionId = (): number => {
		if (transactions.length !== 1) throw new Error("Phase 2g observed a request outside its sole transaction");
		return 0;
	};
	IDBDatabase.prototype.transaction = function phase2gQuotaTransaction(
		this: IDBDatabase,
		storeNames: string | string[],
		mode?: IDBTransactionMode,
		options?: IDBTransactionOptions
	): IDBTransaction {
		const transaction = originalTransaction.call(this, storeNames, mode, options);
		const trace = {
			durability: transaction.durability,
			id: transactions.length,
			mode: transaction.mode,
			requestedDurability: options?.durability ?? null,
			stores: [...transaction.objectStoreNames].sort(),
			terminal: null as "abort" | "complete" | null,
		};
		transactions.push(trace);
		originalTransactionAddEventListener.call(
			transaction,
			"complete",
			() => {
				trace.terminal = "complete";
				terminalCount++;
			},
			{ once: true }
		);
		originalTransactionAddEventListener.call(
			transaction,
			"abort",
			(event: Event) => {
				settlementTransactionAbortOrder = ++eventOrder;
				settlementAbortConsequenceOrder = settlementTransactionAbortOrder;
				if (event.isTrusted) settlementTrustedTransactionAbortEvents++;
				trace.terminal = "abort";
				terminalCount++;
			},
			{ once: true }
		);
		return transaction;
	};

	const observe = <TResult>(
		kind: Phase2e5RequestTrace["kind"],
		store: IDBObjectStore,
		invoke: () => IDBRequest<TResult>,
		count?: number
	): IDBRequest<TResult> => {
		const requestIndex = requests.length;
		requests.push({ ...(count === undefined ? {} : { count }), kind, store: store.name, transaction: transactionId() });
		const write = kind === "add" || kind === "put";
		if (write) writesObserved++;
		if (write && arm.target === "creation" && arm.requestIndex === requestIndex) {
			faultsFired++;
			throw fault;
		}
		const selectedSettlement = write && arm.target === "settlement" && arm.requestIndex === requestIndex;
		const request = selectedSettlement
			? (originalAdd.call(store, phase2gSettlementCollision(store.name)) as unknown as IDBRequest<TResult>)
			: invoke();
		if (selectedSettlement) {
			const transaction = request.transaction;
			if (transaction === null) throw new Error("selected quota request has no transaction");
			Object.defineProperty(request, "error", { configurable: true, get: () => fault });
			originalRequestAddEventListener.call(
				request,
				"error",
				() => {
					settlementRequestErrorEvents++;
					settlementRequestErrorOrder = ++eventOrder;
					selectedRequestError = request.error;
				},
				{ once: true }
			);
			originalRequestAddEventListener.call(
				request,
				"success",
				() => {
					settlementRequestSuccessEvents++;
					++eventOrder;
				},
				{ once: true }
			);
			originalRequestAddEventListener.call(request, "error", (event: Event) => {
				if (!event.isTrusted) return;
				faultsFired++;
				settlementTrustedRequestErrorEvents++;
				settlementTrustedRequestErrorOrder = ++eventOrder;
				settlementRequestReadyStateDoneAtTrustedError ||= request.readyState === "done";
				if (request.readyState === "done") {
					const nativeError = nativeRequestErrorGetter.call(request);
					settlementNativeRequestFailureObserved ||=
						nativeError instanceof DOMException && nativeError.name !== "AbortError";
				}
				queueMicrotask(() => {
					settlementNativeRequestFailureDefaultAllowed ||= !event.defaultPrevented;
				});
			});
			originalRequestAddEventListener.call(request, "success", (event: Event) => {
				if (event.isTrusted) settlementTrustedRequestSuccessEvents++;
				else settlementSyntheticRequestSuccessEvents++;
			});
		}
		if (write && arm.target === "terminal" && arm.terminalWriteIndex === requestIndex) {
			const transaction = request.transaction;
			if (transaction === null) throw new Error("terminal quota request has no transaction");
			originalTransactionAddEventListener.call(
				request,
				"success",
				() => {
					faultsFired++;
					Object.defineProperty(transaction, "error", { configurable: true, get: () => fault });
					originalAbort.call(transaction);
				},
				{ once: true }
			);
		}
		return request;
	};

	IDBObjectStore.prototype.add = function phase2gQuotaAdd(
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	): IDBRequest<IDBValidKey> {
		return observe("add", this, () =>
			key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key)
		);
	};
	IDBObjectStore.prototype.get = function phase2gQuotaGet(
		this: IDBObjectStore,
		query: IDBValidKey | IDBKeyRange
	): IDBRequest<unknown> {
		return observe("get", this, () => originalGet.call(this, query));
	};
	IDBObjectStore.prototype.getAll = function phase2gQuotaGetAll(
		this: IDBObjectStore,
		query?: IDBValidKey | IDBKeyRange | null,
		count?: number
	): IDBRequest<unknown[]> {
		return observe(
			"getAll",
			this,
			() => (count === undefined ? originalGetAll.call(this, query) : originalGetAll.call(this, query, count)),
			count
		);
	};
	IDBObjectStore.prototype.put = function phase2gQuotaPut(
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	): IDBRequest<IDBValidKey> {
		return observe("put", this, () =>
			key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key)
		);
	};

	try {
		const result = await run();
		const selectedOccurrenceInTrace =
			arm.target === "terminal"
				? arm.terminalWriteIndex !== undefined && ["add", "put"].includes(requests[arm.terminalWriteIndex]?.kind ?? "")
				: arm.requestIndex !== undefined && requests[arm.requestIndex] !== undefined;
		return {
			fault,
			faultArmed: true,
			faultsFired,
			operationReturnedAfterTerminal: transactions.length > 0 && terminalCount === transactions.length,
			requests: Object.freeze(requests.map((request) => Object.freeze({ ...request }))),
			result,
			selectedRequestError,
			selectedOccurrenceInTrace,
			settlementAbortAttributedToRequestError:
				settlementRequestErrorOrder > 0 &&
				settlementRequestErrorOrder < settlementAbortConsequenceOrder &&
				!settlementIndependentAbortScheduled,
			settlementExplicitHarnessAbortCalls,
			settlementIndependentAbortScheduled,
			settlementNativeRequestFailureObserved,
			settlementNativeRequestFailureDefaultAllowed,
			settlementRequestErrorBeforeAbortConsequence:
				settlementRequestErrorOrder > 0 && settlementRequestErrorOrder < settlementAbortConsequenceOrder,
			settlementRequestErrorEvents,
			settlementRequestErrorIsSameRealmQuotaFault:
				selectedRequestError === fault &&
				selectedRequestError instanceof DOMException &&
				selectedRequestError.name === "QuotaExceededError",
			settlementRequestReadyStateDoneAtTrustedError,
			settlementRequestSuccessEvents,
			settlementSyntheticDispatchCalls,
			settlementSyntheticRequestSuccessEvents,
			settlementTransactionAbortAfterRequestError:
				settlementRequestErrorOrder > 0 && settlementRequestErrorOrder < settlementTransactionAbortOrder,
			settlementTransactionAbortAfterTrustedRequestError:
				settlementTrustedRequestErrorOrder > 0 && settlementTrustedRequestErrorOrder < settlementTransactionAbortOrder,
			settlementTrustedRequestErrorEvents,
			settlementTrustedRequestSuccessEvents,
			settlementTrustedTransactionAbortEvents,
			transactions: Object.freeze(transactions.map((transaction) => Object.freeze({ ...transaction }))),
			writesObserved,
		};
	} finally {
		IDBDatabase.prototype.transaction = originalTransaction;
		IDBTransaction.prototype.addEventListener = originalTransactionAddEventListener;
		IDBObjectStore.prototype.add = originalAdd;
		IDBObjectStore.prototype.get = originalGet;
		IDBObjectStore.prototype.getAll = originalGetAll;
		IDBObjectStore.prototype.put = originalPut;
	}
}
