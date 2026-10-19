/* eslint-disable import/no-unresolved -- Focused build plugin owns the causal maintenance alias. */
import {
	type AheDurableStore,
	type BlobDigest,
	createMemoryAheDurableStore,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestBlob,
	encodeAheRetirementControl,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	type HeadRevision,
	type NativeReadReservation,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type StorageObjectId,
} from "@ts-drp/storage";

import {
	D109C_BROWSER_MAINTENANCE_READY,
	resolveBrowserAheReclamationMaintenance,
} from "#phase-6b-ahe-reclamation-maintenance";
import { d109cBoundedCheckpoint, d109cMust } from "../../../../tests/fixtures/phase-6b/ahe-reclamation-contract.js";
import { createBrowserAheDurableStore } from "../../src/index.js";
import {
	type BrowserAheReclamationCrashEdge,
	installBrowserAheReclamationCountFault,
	installBrowserAheReclamationCrashObserver,
} from "../../src/internal/ahe-reclamation.js";
import {
	PHASE_2D_BLOBS_STORE,
	PHASE_2D_GENERATIONS_STORE,
	PHASE_2D_OBJECTS_STORE,
	PHASE_2D_PROMOTIONS_STORE,
	PHASE_5C_STORAGE_META_STORE,
	PHASE_5E_SCHEMA_VERSION,
} from "../../src/internal/schema-idb.js";

const OBJECT_ID = `creator:${"a".repeat(32)}` as StorageObjectId;
const OTHER_OBJECT_ID = `creator:${"b".repeat(32)}` as StorageObjectId;
const POLICY_DIGEST = "53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b";
const LINEAGE_MUTANTS = Object.freeze([
	"head-different",
	"revision-stale",
	"active-mismatch",
	"rollback-insufficient",
	"rollback-wrong-countable-pair",
	"identity-duplicate",
	"closure-changed",
	"state-changed",
	"floor-wrong",
	"former-parent-wrong",
	"lineage-gap",
	"lineage-cycle",
	"surviving-branch",
	"extra-target-row",
	"post-state-dangling-parent",
] as const);
const CORRUPTION_MUTANTS = Object.freeze([
	"retained-blob-missing",
	"retained-blob-corrupt",
	"promotion-missing",
	"promotion-extra",
	"promotion-wrong-digest",
	"target-generation-malformed",
	"unrelated-generation-malformed",
	"generation-key-record-mismatch",
	"partial-replay",
] as const);
const COUNT_MUTANTS = Object.freeze([
	"floor-update-count",
	"promotion-delete-count",
	"generation-delete-count",
	"blob-delete-count",
] as const);
const REFERENCE_CASES = Object.freeze([
	"retained-shared-blob",
	"cross-object-shared-blob",
	"candidate-only-blob",
	"unrelated-orphan-retained",
	"staged-partial-promotions",
	"discarded-partial-promotions",
] as const);

type SchedulingMode =
	| "abort"
	| "absent"
	| "delayed"
	| "granted"
	| "native"
	| "non-callable"
	| "off"
	| "reject"
	| "stale-late"
	| "throw"
	| "timeout"
	| "unavailable";

type LockCallback = (lock: unknown) => Promise<unknown> | unknown;

type InstalledLockMode = Readonly<{
	invokeDelayed(): Promise<void>;
	readonly names: readonly string[];
	readonly nativeAvailable: boolean;
	restore(): void;
	waitUntilRequested(): Promise<void>;
}>;

function generationId(index: number): GenerationId {
	return index.toString(16).padStart(64, "0") as GenerationId;
}

function noHead(objectId = OBJECT_ID): ExpectedHead {
	return { kind: "none", objectId };
}

function successful<T>(result: { ok: false; reason: string } | { ok: true; value: T }, label: string): T {
	if (result.ok === false) throw new TypeError(`D109C_BROWSER_${label}:${result.reason}`);
	return result.value;
}

async function failureCode(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
			? String(Reflect.get(error, "code"))
			: undefined;
	}
}

function installSchedulingLockMode(mode: SchedulingMode): InstalledLockMode {
	const ownDescriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
	const nativeLocks = Reflect.get(navigator, "locks") as unknown;
	const nativeRequest =
		nativeLocks !== null && typeof nativeLocks === "object" ? Reflect.get(nativeLocks, "request") : undefined;
	const nativeAvailable = typeof nativeRequest === "function";
	const names: string[] = [];
	let delayedCallback: LockCallback | undefined;
	let requested = false;
	let resolveRequested!: () => void;
	const requestedPromise = new Promise<void>((resolvePromise) => {
		resolveRequested = resolvePromise;
	});

	const replaceLocks = (value: unknown): void => {
		Object.defineProperty(navigator, "locks", { configurable: true, value });
	};
	if (mode === "absent") {
		replaceLocks(undefined);
	} else if (mode === "off") {
		replaceLocks(Object.freeze({}));
	} else if (mode === "non-callable") {
		replaceLocks(Object.freeze({ request: 1 }));
	} else if (mode !== "native") {
		const locks = {
			request(this: unknown, name: string, _options: unknown, callback: LockCallback): Promise<unknown> {
				if (this !== locks) throw new TypeError("D109E_LOCK_RECEIVER_LOST");
				names.push(name);
				if (!requested) {
					requested = true;
					resolveRequested();
				}
				if (mode === "throw") throw new TypeError("D109E_INJECTED_LOCK_THROW");
				if (mode === "reject") return Promise.reject(new TypeError("D109E_INJECTED_LOCK_REJECTION"));
				if (mode === "abort") return Promise.reject(new DOMException("injected abort", "AbortError"));
				if (mode === "unavailable") return Promise.resolve(callback(null));
				if (mode === "granted") return Promise.resolve(callback(Object.freeze({ name })));
				if (mode === "timeout") return new Promise(() => undefined);
				delayedCallback = callback;
				return new Promise(() => undefined);
			},
		};
		replaceLocks(Object.freeze(locks));
	}

	return Object.freeze({
		invokeDelayed: async () => {
			if (delayedCallback === undefined) throw new TypeError(`D109E_DELAYED_CALLBACK_MISSING:${mode}`);
			await delayedCallback(Object.freeze({ name: names[0] }));
		},
		names,
		nativeAvailable,
		restore: () => {
			if (ownDescriptor === undefined) {
				Reflect.deleteProperty(navigator, "locks");
			} else {
				Object.defineProperty(navigator, "locks", ownDescriptor);
			}
		},
		waitUntilRequested: async () => {
			if (mode === "delayed" || mode === "stale-late") await requestedPromise;
		},
	});
}

async function fiveGenerations(
	store: AheDurableStore,
	bytesForIndex: (index: number) => Uint8Array = (index) => Uint8Array.of(index, index + 1, index + 2),
	generationCount = 5
): Promise<Readonly<{ input: Record<string, unknown>; records: readonly GenerationRecord[] }>> {
	let head: ExpectedHead = successful(await store.readHead(OBJECT_ID), "HEAD");
	const records = [];
	for (let index = 1; index <= generationCount; index += 1) {
		const generationId = index.toString(16).padStart(64, "0") as GenerationId;
		const bytes = bytesForIndex(index);
		const digest = successful(digestBlob(bytes), "DIGEST");
		const closure = [{ byteLength: bytes.byteLength, digest }];
		successful(
			await store.beginGeneration({ baseExpectedHead: head, closure, generationId, objectId: OBJECT_ID }),
			"BEGIN"
		);
		successful(await store.putCachedBlob({ bytes, digest, generationId, objectId: OBJECT_ID }), "PUT");
		successful(await store.promoteReference({ digest, generationId, objectId: OBJECT_ID }), "PROMOTE");
		successful(await store.completeGeneration({ generationId, objectId: OBJECT_ID }), "COMPLETE");
		head = successful(await store.swapHead({ expectedHead: head, generationId, objectId: OBJECT_ID }), "SWAP").head;
	}
	records.push(...successful(await store.readGenerationPage({ limit: 16, objectId: OBJECT_ID }), "PAGE").generations);
	if (head.kind !== "present") throw new TypeError("D109C_BROWSER_HEAD_ABSENT");
	const byId = new Map(records.map((record) => [record.generationId, record]));
	const active = byId.get(head.generationId);
	const first =
		active?.baseExpectedHead.kind === "present" ? byId.get(active.baseExpectedHead.generationId) : undefined;
	const floor = first?.baseExpectedHead.kind === "present" ? byId.get(first.baseExpectedHead.generationId) : undefined;
	if (active === undefined || first === undefined || floor === undefined) throw new TypeError("D109C_BROWSER_LINEAGE");
	const retained = new Set([active.generationId, first.generationId, floor.generationId]);
	return {
		input: {
			activeGenerationId: active.generationId,
			availabilityPolicyDigest: POLICY_DIGEST,
			closedEpoch: 4,
			expectedHead: head,
			lineageFloor: {
				deleteGenerationIds: records
					.filter(({ generationId }) => !retained.has(generationId))
					.map(({ generationId }) => generationId)
					.sort(),
				expectedBaseExpectedHead: floor.baseExpectedHead,
				generationId: floor.generationId,
				replacementBaseExpectedHead: { kind: "none", objectId: OBJECT_ID },
			},
			objectId: OBJECT_ID,
			rollbackGenerationIds: [first.generationId, floor.generationId],
		},
		records,
	};
}

async function run(databaseName: string): Promise<Record<string, unknown>> {
	const store = await createBrowserAheDurableStore({ databaseName });
	const maintenance = resolveBrowserAheReclamationMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
	const memory = createMemoryAheDurableStore();
	const memoryDenied = resolveBrowserAheReclamationMaintenance(memory) === undefined;
	await memory.close();
	let liveStore: AheDurableStore | undefined = store;
	try {
		const { input } = await fiveGenerations(store);
		const receipt = await maintenance.reclaimClosedEpoch(input);
		await store.close();
		liveStore = undefined;
		const closedPromise = maintenance.reclaimClosedEpoch(input);
		const asynchronousClosed = closedPromise instanceof Promise;
		const closedCode = await failureCode(closedPromise);
		const invalidCode = await failureCode(maintenance.reclaimClosedEpoch({}));
		const reopened = await createBrowserAheDurableStore({ databaseName });
		liveStore = reopened;
		const reopenedMaintenance = resolveBrowserAheReclamationMaintenance(reopened);
		if (reopenedMaintenance === undefined) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
		const replay = await reopenedMaintenance.reclaimClosedEpoch(input);
		const head = successful(await reopened.readHead(OBJECT_ID), "REOPEN_HEAD");
		const bytes = Uint8Array.of(6, 7, 8);
		const digest = successful(digestBlob(bytes), "SUCCESSOR_DIGEST");
		const successorId = generationId(6);
		successful(
			await reopened.beginGeneration({
				baseExpectedHead: head,
				closure: [{ byteLength: bytes.byteLength, digest }],
				generationId: successorId,
				objectId: OBJECT_ID,
			}),
			"SUCCESSOR_BEGIN"
		);
		successful(
			await reopened.putCachedBlob({ bytes, digest, generationId: successorId, objectId: OBJECT_ID }),
			"SUCCESSOR_PUT"
		);
		successful(
			await reopened.promoteReference({ digest, generationId: successorId, objectId: OBJECT_ID }),
			"SUCCESSOR_PROMOTE"
		);
		successful(
			await reopened.completeGeneration({ generationId: successorId, objectId: OBJECT_ID }),
			"SUCCESSOR_COMPLETE"
		);
		const successor = successful(
			await reopened.swapHead({ expectedHead: head, generationId: successorId, objectId: OBJECT_ID }),
			"SUCCESSOR_SWAP"
		);
		return {
			asynchronousClosed,
			closedCode,
			copiedDenied: resolveBrowserAheReclamationMaintenance({ ...store }) === undefined,
			facadeKeys: [...Object.keys(store), ...Object.getOwnPropertyNames(Object.getPrototypeOf(store))]
				.filter((key) => key !== "constructor")
				.sort(),
			memoryDenied,
			invalidCode,
			proxyDenied: resolveBrowserAheReclamationMaintenance(new Proxy(store, {})) === undefined,
			receipt,
			replay,
			successor,
		};
	} finally {
		await liveStore?.close();
	}
}

async function runPositiveControls(prefix: string): Promise<Record<string, unknown>> {
	const emptyStore = await createBrowserAheDurableStore({ databaseName: `${prefix}-empty` });
	try {
		const maintenance = resolveBrowserAheReclamationMaintenance(emptyStore);
		if (maintenance === undefined) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
		const fixture = await fiveGenerations(emptyStore, undefined, 3);
		const receipt = await maintenance.reclaimClosedEpoch(fixture.input);
		if (receipt.deletedGenerationIds.length !== 0 || receipt.floor.normalizedThisCall) {
			throw new TypeError("D109C_BROWSER_EMPTY_PREFIX_INVALID");
		}
	} finally {
		await emptyStore.close();
	}

	const databaseName = `${prefix}-concurrent`;
	const firstStore = await createBrowserAheDurableStore({ databaseName });
	const secondStore = await createBrowserAheDurableStore({ databaseName });
	try {
		const fixture = await fiveGenerations(firstStore);
		const firstMaintenance = resolveBrowserAheReclamationMaintenance(firstStore);
		const secondMaintenance = resolveBrowserAheReclamationMaintenance(secondStore);
		if (firstMaintenance === undefined || secondMaintenance === undefined) {
			throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
		}
		const receipts = await Promise.all([
			firstMaintenance.reclaimClosedEpoch(fixture.input),
			secondMaintenance.reclaimClosedEpoch(fixture.input),
		]);
		const deleted = receipts.map(({ deletedGenerationIds }) => deletedGenerationIds.length).sort();
		if (deleted.join(",") !== "0,2") throw new TypeError(`D109C_BROWSER_CONCURRENCY_INVALID:${deleted.join(",")}`);
		return Object.freeze({ concurrentDeletedCounts: Object.freeze(deleted), empty: true });
	} finally {
		await Promise.all([firstStore.close(), secondStore.close()]);
	}
}

async function prepareSchedulingScenario(databaseName: string): Promise<Record<string, unknown>> {
	const store = await createBrowserAheDurableStore({ databaseName });
	try {
		return structuredClone((await fiveGenerations(store)).input);
	} finally {
		await store.close();
	}
}

async function runPreparedCleanup(
	databaseName: string,
	input: Record<string, unknown>,
	mode: SchedulingMode
): Promise<Record<string, unknown>> {
	const store = await createBrowserAheDurableStore({ databaseName });
	const maintenance = resolveBrowserAheReclamationMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
	let transactionEntries = 0;
	installBrowserAheReclamationCrashObserver(store, (edge: BrowserAheReclamationCrashEdge) => {
		if (edge === "before-commit") transactionEntries += 1;
	});
	const locks = installSchedulingLockMode(mode);
	try {
		const receipt = await maintenance.reclaimClosedEpoch(input);
		if (mode === "stale-late") {
			await locks.invokeDelayed();
			await Promise.resolve();
		}
		return Object.freeze({
			names: Object.freeze([...locks.names]),
			nativeAvailable: locks.nativeAvailable,
			receipt,
			transactionEntries,
		});
	} finally {
		locks.restore();
		await store.close();
	}
}

async function runSchedulingMode(databaseName: string, mode: SchedulingMode): Promise<Record<string, unknown>> {
	const input = await prepareSchedulingScenario(databaseName);
	return runPreparedCleanup(databaseName, input, mode);
}

async function triggerVersionchange(databaseName: string): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const request = indexedDB.open(databaseName, PHASE_5E_SCHEMA_VERSION + 1);
		request.addEventListener(
			"upgradeneeded",
			() => {
				request.transaction?.abort();
			},
			{ once: true }
		);
		request.addEventListener("error", () => resolvePromise(), { once: true });
		request.addEventListener("blocked", () => reject(new TypeError("D109E_VERSIONCHANGE_BLOCKED")), { once: true });
		request.addEventListener(
			"success",
			() => {
				request.result.close();
				reject(new TypeError("D109E_VERSIONCHANGE_UPGRADE_COMMITTED"));
			},
			{ once: true }
		);
	});
}

async function runLifecycleScenario(
	databaseName: string,
	event: "close" | "versionchange"
): Promise<Record<string, unknown>> {
	const input = await prepareSchedulingScenario(databaseName);
	const before = await databaseImage(databaseName);
	const store = await createBrowserAheDurableStore({ databaseName });
	const maintenance = resolveBrowserAheReclamationMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
	let transactionEntries = 0;
	installBrowserAheReclamationCrashObserver(store, (edge: BrowserAheReclamationCrashEdge) => {
		if (edge === "before-commit") transactionEntries += 1;
	});
	const delayed = installSchedulingLockMode("delayed");
	let restored = false;
	try {
		const pending = maintenance.reclaimClosedEpoch(input);
		await delayed.waitUntilRequested();
		if (event === "close") await store.close();
		else await triggerVersionchange(databaseName);
		await delayed.invokeDelayed().catch(() => undefined);
		const code = await failureCode(pending);
		const unchangedBeforeTakeover = (await databaseImage(databaseName)) === before;
		delayed.restore();
		restored = true;
		const granted = installSchedulingLockMode("granted");
		try {
			const successor = await createBrowserAheDurableStore({ databaseName });
			try {
				const successorMaintenance = resolveBrowserAheReclamationMaintenance(successor);
				if (successorMaintenance === undefined) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
				const receipt = await successorMaintenance.reclaimClosedEpoch(input);
				return Object.freeze({ code, receipt, transactionEntries, unchangedBeforeTakeover });
			} finally {
				await successor.close();
			}
		} finally {
			granted.restore();
		}
	} finally {
		if (!restored) delayed.restore();
		await store.close();
	}
}

async function advanceToGenerationSix(store: AheDurableStore): Promise<ExpectedHead> {
	const head = successful(await store.readHead(OBJECT_ID), "SCHEDULING_HEAD");
	const bytes = Uint8Array.of(6, 7, 8);
	const digest = successful(digestBlob(bytes), "SCHEDULING_DIGEST");
	const id = generationId(6);
	successful(
		await store.beginGeneration({
			baseExpectedHead: head,
			closure: [{ byteLength: bytes.byteLength, digest }],
			generationId: id,
			objectId: OBJECT_ID,
		}),
		"SCHEDULING_BEGIN"
	);
	successful(await store.putCachedBlob({ bytes, digest, generationId: id, objectId: OBJECT_ID }), "SCHEDULING_PUT");
	successful(await store.promoteReference({ digest, generationId: id, objectId: OBJECT_ID }), "SCHEDULING_PROMOTE");
	successful(await store.completeGeneration({ generationId: id, objectId: OBJECT_ID }), "SCHEDULING_COMPLETE");
	return successful(
		await store.swapHead({ expectedHead: head, generationId: id, objectId: OBJECT_ID }),
		"SCHEDULING_SWAP"
	).head;
}

async function runChangedPreconditionScenario(databaseName: string): Promise<Record<string, unknown>> {
	const store = await createBrowserAheDurableStore({ databaseName });
	const maintenance = resolveBrowserAheReclamationMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
	const { input } = await fiveGenerations(store);
	let transactionEntries = 0;
	installBrowserAheReclamationCrashObserver(store, (edge: BrowserAheReclamationCrashEdge) => {
		if (edge === "before-commit") transactionEntries += 1;
	});
	const delayed = installSchedulingLockMode("delayed");
	try {
		const pending = maintenance.reclaimClosedEpoch(input);
		await delayed.waitUntilRequested();
		const advanced = await advanceToGenerationSix(store);
		const readBack = successful(await store.readHead(OBJECT_ID), "SCHEDULING_READ_BACK");
		const baseline = await databaseImage(databaseName);
		await delayed.invokeDelayed().catch(() => undefined);
		const code = await failureCode(pending);
		return Object.freeze({
			advanced,
			code,
			imageUnchanged: (await databaseImage(databaseName)) === baseline,
			readBack,
			transactionEntries,
		});
	} finally {
		delayed.restore();
		await store.close();
	}
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolvePromise, reject) => {
		request.addEventListener("success", () => resolvePromise(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("D109C_BROWSER_IDB_REQUEST_FAILED")), {
			once: true,
		});
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		transaction.addEventListener("complete", () => resolvePromise(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("D109C_BROWSER_IDB_ABORT")), {
			once: true,
		});
		transaction.addEventListener("error", () => reject(transaction.error ?? new Error("D109C_BROWSER_IDB_ERROR")), {
			once: true,
		});
	});
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
	return new Promise((resolvePromise, reject) => {
		const request = indexedDB.open(databaseName);
		request.addEventListener("success", () => resolvePromise(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("D109C_BROWSER_IDB_OPEN_FAILED")), {
			once: true,
		});
	});
}

const AHE_STORES = [
	PHASE_2D_BLOBS_STORE,
	PHASE_2D_GENERATIONS_STORE,
	PHASE_2D_OBJECTS_STORE,
	PHASE_2D_PROMOTIONS_STORE,
] as const;

async function withRawDatabase<T>(
	databaseName: string,
	mode: IDBTransactionMode,
	runTransaction: (transaction: IDBTransaction) => Promise<T>
): Promise<T> {
	const database = await openDatabase(databaseName);
	try {
		const transaction = database.transaction(AHE_STORES, mode, { durability: "strict" });
		const completion = transactionDone(transaction);
		const value = await runTransaction(transaction);
		if (mode === "readwrite") transaction.commit();
		await completion;
		return value;
	} finally {
		database.close();
	}
}

function normalized(value: unknown): unknown {
	if (value instanceof Uint8Array) return [...value];
	if (Array.isArray(value)) return value.map(normalized);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]));
	}
	return value;
}

async function databaseImage(databaseName: string): Promise<string> {
	return withRawDatabase(databaseName, "readonly", async (transaction) =>
		JSON.stringify(
			normalized({
				blobs: await requestValue(transaction.objectStore(PHASE_2D_BLOBS_STORE).getAll()),
				generations: await requestValue(transaction.objectStore(PHASE_2D_GENERATIONS_STORE).getAll()),
				objects: await requestValue(transaction.objectStore(PHASE_2D_OBJECTS_STORE).getAll()),
				promotions: await requestValue(transaction.objectStore(PHASE_2D_PROMOTIONS_STORE).getAll()),
			})
		)
	);
}

async function generationRecord(transaction: IDBTransaction, id: string): Promise<GenerationRecord> {
	const row = (await requestValue(transaction.objectStore(PHASE_2D_GENERATIONS_STORE).get([OBJECT_ID, id]))) as
		| { readonly record?: unknown }
		| undefined;
	if (!(row?.record instanceof Uint8Array)) throw new TypeError("D109C_BROWSER_NATIVE_RECORD_MISSING");
	const decoded = decodeGenerationRecordV1(row.record);
	if (decoded.ok === false) throw new TypeError(`D109C_BROWSER_NATIVE_RECORD_INVALID:${decoded.reason}`);
	return decoded.value;
}

async function replaceGeneration(
	transaction: IDBTransaction,
	key: string,
	record: GenerationRecord | Uint8Array
): Promise<void> {
	await requestValue(
		transaction.objectStore(PHASE_2D_GENERATIONS_STORE).put({
			generationId: key,
			objectId: OBJECT_ID,
			record: record instanceof Uint8Array ? record : encodeGenerationRecordV1(record),
		})
	);
}

type MutableRequest = Record<string, unknown> & {
	expectedHead: Record<string, unknown>;
	lineageFloor: Record<string, unknown> & { deleteGenerationIds: string[] };
	rollbackGenerationIds: string[];
};

function mutableRequest(input: Record<string, unknown>): MutableRequest {
	return structuredClone(input) as MutableRequest;
}

async function applyMutant(
	databaseName: string,
	input: Record<string, unknown>,
	mutant: string
): Promise<Readonly<{ code: string; request: MutableRequest }>> {
	const request = mutableRequest(input);
	const corrupt = "AHE_RECLAMATION_CORRUPT";
	const retry = "AHE_RECLAMATION_RETRY_REQUIRED";
	if (mutant === "head-different") {
		request.expectedHead.closureDigest = "f".repeat(64);
		return { code: retry, request };
	}
	if (mutant === "revision-stale") {
		request.expectedHead.revision = 4;
		return { code: retry, request };
	}
	if (mutant === "active-mismatch") {
		request.activeGenerationId = generationId(4);
		return { code: "AHE_RECLAMATION_INVALID_ARGUMENT", request };
	}
	if (mutant === "rollback-insufficient" || mutant === "rollback-wrong-countable-pair" || mutant === "floor-wrong") {
		const second = mutant === "rollback-insufficient" ? generationId(9) : generationId(2);
		request.rollbackGenerationIds = [
			mutant === "rollback-wrong-countable-pair" ? generationId(3) : generationId(4),
			second,
		];
		if (mutant === "rollback-wrong-countable-pair") {
			request.lineageFloor.deleteGenerationIds = [generationId(1), generationId(4)];
		} else if (mutant === "floor-wrong") {
			request.lineageFloor.deleteGenerationIds = [generationId(1), generationId(3)];
		}
		request.lineageFloor.generationId = second;
		request.lineageFloor.expectedBaseExpectedHead = noHead();
		return { code: retry, request };
	}
	if (mutant === "former-parent-wrong") {
		request.lineageFloor.expectedBaseExpectedHead = noHead();
		return { code: retry, request };
	}
	await withRawDatabase(databaseName, "readwrite", async (transaction) => {
		const first = await generationRecord(transaction, generationId(1));
		const second = await generationRecord(transaction, generationId(2));
		const active = await generationRecord(transaction, generationId(5));
		if (mutant === "identity-duplicate" || mutant === "generation-key-record-mismatch") {
			await replaceGeneration(transaction, first.generationId, second);
		} else if (mutant === "closure-changed") {
			await replaceGeneration(transaction, active.generationId, {
				...active,
				closure: second.closure,
				closureDigest: second.closureDigest,
			});
		} else if (mutant === "state-changed") {
			await replaceGeneration(transaction, active.generationId, { ...active, state: "Superseded" });
		} else if (mutant === "lineage-gap") {
			await requestValue(
				transaction
					.objectStore(PHASE_2D_PROMOTIONS_STORE)
					.delete([OBJECT_ID, first.generationId, first.closure[0]?.digest])
			);
			await requestValue(transaction.objectStore(PHASE_2D_GENERATIONS_STORE).delete([OBJECT_ID, first.generationId]));
		} else if (mutant === "lineage-cycle") {
			await replaceGeneration(transaction, first.generationId, {
				...first,
				baseExpectedHead: {
					closureDigest: second.closureDigest,
					generationId: second.generationId,
					kind: "present",
					objectId: OBJECT_ID,
					revision: 2 as HeadRevision,
				},
			});
		} else if (
			mutant === "surviving-branch" ||
			mutant === "extra-target-row" ||
			mutant === "post-state-dangling-parent"
		) {
			const id = generationId(mutant === "extra-target-row" ? 7 : mutant === "surviving-branch" ? 8 : 9);
			const extra: GenerationRecord = {
				...first,
				baseExpectedHead: mutant === "extra-target-row" ? noHead() : second.baseExpectedHead,
				generationId: id,
				state: "Staged",
			};
			await replaceGeneration(transaction, id, extra);
			if (mutant === "post-state-dangling-parent") {
				const floor = await generationRecord(transaction, generationId(3));
				await replaceGeneration(transaction, floor.generationId, { ...floor, baseExpectedHead: noHead() });
				for (const idToDelete of [generationId(1), generationId(2)]) {
					const record = await generationRecord(transaction, idToDelete);
					for (const reference of record.closure) {
						await requestValue(
							transaction.objectStore(PHASE_2D_PROMOTIONS_STORE).delete([OBJECT_ID, idToDelete, reference.digest])
						);
					}
					await requestValue(transaction.objectStore(PHASE_2D_GENERATIONS_STORE).delete([OBJECT_ID, idToDelete]));
				}
			}
		} else if (mutant === "retained-blob-missing" || mutant === "retained-blob-corrupt") {
			const digest = active.closure[0]?.digest;
			if (digest === undefined) throw new TypeError("D109C_BROWSER_DIGEST_MISSING");
			if (mutant === "retained-blob-missing") {
				await requestValue(transaction.objectStore(PHASE_2D_BLOBS_STORE).delete(digest));
			} else {
				await requestValue(transaction.objectStore(PHASE_2D_BLOBS_STORE).put({ bytes: Uint8Array.of(0), digest }));
			}
		} else if (mutant === "promotion-missing") {
			await requestValue(
				transaction
					.objectStore(PHASE_2D_PROMOTIONS_STORE)
					.delete([OBJECT_ID, active.generationId, active.closure[0]?.digest])
			);
		} else if (mutant === "promotion-extra" || mutant === "promotion-wrong-digest") {
			const digest = second.closure[0]?.digest;
			if (digest === undefined) throw new TypeError("D109C_BROWSER_DIGEST_MISSING");
			await requestValue(
				transaction.objectStore(PHASE_2D_PROMOTIONS_STORE).put({
					digest,
					generationId: active.generationId,
					objectId: OBJECT_ID,
				})
			);
		} else if (mutant === "target-generation-malformed") {
			await replaceGeneration(transaction, first.generationId, Uint8Array.of(0));
		} else if (mutant === "unrelated-generation-malformed") {
			await requestValue(
				transaction.objectStore(PHASE_2D_OBJECTS_STORE).put({ objectId: OTHER_OBJECT_ID, record: null })
			);
			await requestValue(
				transaction.objectStore(PHASE_2D_GENERATIONS_STORE).put({
					generationId: generationId(9),
					objectId: OTHER_OBJECT_ID,
					record: Uint8Array.of(0),
				})
			);
		} else if (mutant === "partial-replay") {
			const floor = await generationRecord(transaction, generationId(3));
			await replaceGeneration(transaction, floor.generationId, { ...floor, baseExpectedHead: noHead() });
			for (const reference of first.closure) {
				await requestValue(
					transaction.objectStore(PHASE_2D_PROMOTIONS_STORE).delete([OBJECT_ID, first.generationId, reference.digest])
				);
			}
			await requestValue(transaction.objectStore(PHASE_2D_GENERATIONS_STORE).delete([OBJECT_ID, first.generationId]));
		}
	});
	return { code: mutant === "surviving-branch" || mutant === "extra-target-row" ? retry : corrupt, request };
}

function countFault(mutant: string): "blob delete" | "floor rewrite" | "generation delete" | "promotion delete" {
	switch (mutant) {
		case "floor-update-count":
			return "floor rewrite";
		case "promotion-delete-count":
			return "promotion delete";
		case "generation-delete-count":
			return "generation delete";
		case "blob-delete-count":
			return "blob delete";
		default:
			throw new TypeError(`D109C_BROWSER_COUNT_MUTANT_UNKNOWN:${mutant}`);
	}
}

async function runMutantMatrix(prefix: string): Promise<Record<string, unknown>> {
	const cases = [...LINEAGE_MUTANTS, ...CORRUPTION_MUTANTS, ...COUNT_MUTANTS];
	const results: Array<Readonly<{ code: string; mutant: string; poisoned: boolean }>> = [];
	for (const mutant of cases) {
		const databaseName = `${prefix}-${mutant}`;
		const store = await createBrowserAheDurableStore({ databaseName });
		const maintenance = resolveBrowserAheReclamationMaintenance(store);
		if (maintenance === undefined) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
		try {
			const { input } = await fiveGenerations(store);
			let request = mutableRequest(input);
			let expectedCode = "AHE_RECLAMATION_CORRUPT";
			if ((COUNT_MUTANTS as readonly string[]).includes(mutant)) {
				installBrowserAheReclamationCountFault(store, countFault(mutant));
			} else {
				({ code: expectedCode, request } = await applyMutant(databaseName, input, mutant));
			}
			const before = await databaseImage(databaseName);
			let error: unknown;
			try {
				await maintenance.reclaimClosedEpoch(request);
			} catch (candidate) {
				error = candidate;
			}
			const code =
				typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
					? String(Reflect.get(error, "code"))
					: undefined;
			if (code !== expectedCode || !Object.isFrozen(error)) {
				throw new TypeError(`D109C_BROWSER_MUTANT_CODE:${mutant}:${String(code)}:${expectedCode}`);
			}
			if ((await databaseImage(databaseName)) !== before) {
				throw new TypeError(`D109C_BROWSER_MUTANT_COMMITTED:${mutant}`);
			}
			const ordinary = await store.readHead(OBJECT_ID);
			const poisoned = ordinary.ok === false && ordinary.reason === "STORE_POISONED";
			if (expectedCode === "AHE_RECLAMATION_CORRUPT" ? !poisoned : ordinary.ok === false) {
				throw new TypeError(`D109C_BROWSER_MUTANT_LIFECYCLE:${mutant}`);
			}
			results.push(Object.freeze({ code: expectedCode, mutant, poisoned }));
		} finally {
			await store.close();
		}
	}
	return Object.freeze({ cases: Object.freeze(results), total: results.length });
}

async function addOtherGeneration(
	store: AheDurableStore,
	input: Readonly<{
		closure: readonly GenerationRecord["closure"][number][];
		complete?: boolean;
		discard?: boolean;
		promote: readonly GenerationRecord["closure"][number]["digest"][];
	}>
): Promise<void> {
	const id = generationId(9);
	const head = successful(await store.readHead(OTHER_OBJECT_ID), "OTHER_HEAD");
	successful(
		await store.beginGeneration({
			baseExpectedHead: head,
			closure: input.closure,
			generationId: id,
			objectId: OTHER_OBJECT_ID,
		}),
		"OTHER_BEGIN"
	);
	for (const digest of input.promote) {
		successful(await store.promoteReference({ digest, generationId: id, objectId: OTHER_OBJECT_ID }), "OTHER_PROMOTE");
	}
	if (input.complete)
		successful(await store.completeGeneration({ generationId: id, objectId: OTHER_OBJECT_ID }), "OTHER_COMPLETE");
	if (input.discard)
		successful(await store.discardGeneration({ generationId: id, objectId: OTHER_OBJECT_ID }), "OTHER_DISCARD");
}

async function blobCount(databaseName: string): Promise<number> {
	return withRawDatabase(databaseName, "readonly", async (transaction) =>
		requestValue(transaction.objectStore(PHASE_2D_BLOBS_STORE).count())
	);
}

async function runReferenceMatrix(prefix: string): Promise<Record<string, unknown>> {
	const passed: string[] = [];
	for (const caseId of REFERENCE_CASES) {
		const databaseName = `${prefix}-${caseId}`;
		const store = await createBrowserAheDurableStore({ databaseName });
		const maintenance = resolveBrowserAheReclamationMaintenance(store);
		if (maintenance === undefined) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
		try {
			const fixture = await fiveGenerations(store, (index) =>
				caseId === "retained-shared-blob" && index === 3
					? Uint8Array.of(1, 2, 3)
					: Uint8Array.of(index, index + 1, index + 2)
			);
			const firstDigest = fixture.records.find(({ generationId: id }) => id === generationId(1))?.closure[0]?.digest;
			const secondDigest = fixture.records.find(({ generationId: id }) => id === generationId(2))?.closure[0]?.digest;
			if (firstDigest === undefined || secondDigest === undefined) {
				throw new TypeError("D109C_BROWSER_REFERENCE_DIGEST_MISSING");
			}
			if (caseId === "cross-object-shared-blob") {
				await addOtherGeneration(store, {
					closure: [{ byteLength: 3, digest: firstDigest }],
					complete: true,
					promote: [firstDigest],
				});
			} else if (caseId === "unrelated-orphan-retained") {
				const bytes = Uint8Array.of(240, 241, 242);
				const digest = successful(digestBlob(bytes), "ORPHAN_DIGEST");
				await withRawDatabase(databaseName, "readwrite", async (transaction) => {
					await requestValue(transaction.objectStore(PHASE_2D_BLOBS_STORE).put({ bytes, digest }));
				});
			} else if (caseId === "staged-partial-promotions" || caseId === "discarded-partial-promotions") {
				await addOtherGeneration(store, {
					closure: [
						{ byteLength: 3, digest: firstDigest },
						{ byteLength: 3, digest: secondDigest },
					].sort((left, right) => left.digest.localeCompare(right.digest)),
					discard: caseId === "discarded-partial-promotions",
					promote: [firstDigest],
				});
			}
			const before = await blobCount(databaseName);
			const receipt = await maintenance.reclaimClosedEpoch(fixture.input);
			if (receipt.deletedGenerationIds.join(",") !== [generationId(1), generationId(2)].join(",")) {
				throw new TypeError(`D109C_BROWSER_REFERENCE_GENERATIONS:${caseId}`);
			}
			const first = successful(await store.getBlob(firstDigest), "REFERENCE_FIRST_BLOB");
			if (
				caseId === "retained-shared-blob" ||
				caseId === "cross-object-shared-blob" ||
				caseId === "staged-partial-promotions" ||
				caseId === "discarded-partial-promotions"
			) {
				if (first === null) throw new TypeError(`D109C_BROWSER_REFERENCE_LOST:${caseId}`);
			} else if (caseId === "candidate-only-blob") {
				if (first !== null || successful(await store.getBlob(secondDigest), "REFERENCE_SECOND_BLOB") !== null) {
					throw new TypeError("D109C_BROWSER_CANDIDATE_BLOB_RETAINED");
				}
			} else if ((await blobCount(databaseName)) !== before - 2) {
				throw new TypeError("D109C_BROWSER_ORPHAN_REMOVED");
			}
			passed.push(caseId);
		} finally {
			await store.close();
		}
	}
	return Object.freeze({ cases: Object.freeze(passed), total: passed.length });
}

type ReopenShape = Readonly<{
	blobs: number;
	floorNormalized: boolean;
	generationIds: readonly string[];
	headGenerationId: string;
	promotions: number;
}>;

async function reopenedShape(databaseName: string): Promise<ReopenShape> {
	return withRawDatabase(databaseName, "readonly", async (transaction) => {
		const generations = (await requestValue(transaction.objectStore(PHASE_2D_GENERATIONS_STORE).getAll())) as Array<{
			readonly generationId: string;
			readonly objectId: string;
			readonly record: Uint8Array;
		}>;
		const target = generations
			.filter(({ objectId }) => objectId === OBJECT_ID)
			.sort((left, right) => left.generationId.localeCompare(right.generationId));
		const floor = target.find(({ generationId: id }) => id === generationId(3));
		if (floor === undefined) throw new TypeError("D109C_BROWSER_REOPEN_FLOOR_MISSING");
		const decodedFloor = decodeGenerationRecordV1(floor.record);
		if (decodedFloor.ok === false) throw new TypeError("D109C_BROWSER_REOPEN_FLOOR_INVALID");
		const object = (await requestValue(transaction.objectStore(PHASE_2D_OBJECTS_STORE).get(OBJECT_ID))) as
			| { readonly record?: unknown }
			| undefined;
		if (!(object?.record instanceof Uint8Array)) throw new TypeError("D109C_BROWSER_REOPEN_HEAD_MISSING");
		const head = decodeHeadRecordV1(object.record);
		if (head.ok === false || head.value.kind !== "present") throw new TypeError("D109C_BROWSER_REOPEN_HEAD_INVALID");
		return Object.freeze({
			blobs: await requestValue(transaction.objectStore(PHASE_2D_BLOBS_STORE).count()),
			floorNormalized: decodedFloor.value.baseExpectedHead.kind === "none",
			generationIds: Object.freeze(target.map(({ generationId: id }) => id)),
			headGenerationId: head.value.generationId,
			promotions: await requestValue(transaction.objectStore(PHASE_2D_PROMOTIONS_STORE).count()),
		});
	});
}

async function terminateWorkerAt(databaseName: string, edge: string): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const worker = new Worker(workerUrl(), { type: "module" });
		const timer = setTimeout(() => {
			worker.terminate();
			reject(new TypeError(`D109C_BROWSER_WORKER_TIMEOUT:${edge}`));
		}, 15_000);
		worker.addEventListener("error", (event) => {
			clearTimeout(timer);
			worker.terminate();
			reject(new TypeError(`D109C_BROWSER_WORKER_ERROR:${edge}:${event.message}`));
		});
		worker.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
			if (event.data.kind === "ready") {
				worker.postMessage({ databaseName, edge });
			} else if (event.data.kind === "checkpoint" && event.data.edge === edge) {
				clearTimeout(timer);
				worker.terminate();
				resolvePromise();
			} else if (event.data.kind === "worker-error") {
				clearTimeout(timer);
				worker.terminate();
				reject(new TypeError(`D109C_BROWSER_WORKER_FAILURE:${edge}:${String(event.data.message)}`));
			}
		});
	});
}

async function runCrashMatrix(prefix: string): Promise<Record<string, unknown>> {
	const edges = [
		"after-floor-rewrite",
		"after-promotion-delete",
		"after-generation-delete",
		"after-blob-delete",
		"before-commit",
		"after-commit",
	] as const;
	const results: Array<Readonly<{ edge: string; state: "complete-new" | "old" }>> = [];
	for (const edge of edges) {
		const databaseName = `${prefix}-${edge}`;
		await terminateWorkerAt(databaseName, edge);
		const shape = await reopenedShape(databaseName);
		const old =
			shape.generationIds.length === 5 && !shape.floorNormalized && shape.promotions === 5 && shape.blobs === 5;
		const completeNew =
			shape.generationIds.join(",") === generationId(3) + "," + generationId(4) + "," + generationId(5) &&
			shape.floorNormalized &&
			shape.promotions === 3 &&
			shape.blobs === 3;
		if (Number(old) + Number(completeNew) !== 1 || completeNew !== (edge === "after-commit")) {
			throw new TypeError(`D109C_BROWSER_CRASH_STATE:${edge}:${JSON.stringify(shape)}`);
		}
		if (shape.headGenerationId !== generationId(5)) throw new TypeError(`D109C_BROWSER_CRASH_HEAD:${edge}`);
		results.push(Object.freeze({ edge, state: completeNew ? "complete-new" : "old" }));
	}
	return Object.freeze({ cases: Object.freeze(results), total: results.length });
}

function workerUrl(): string {
	return new URL("./phase-6b-ahe-reclamation-worker.js", import.meta.url).href;
}

type BoundedCheckpointCase = "shared" | "atomic" | "currency";
type BoundedNativeRows = Record<string, unknown>[];

/**
 * Complete quiescent native image includes the original metadata store.
 * @param databaseName - Existing original native database.
 * @param mode - Exact native transaction mode.
 * @param action - Test-only operation on the actual transaction.
 * @returns Actual return after native terminal join.
 */
async function boundedCheckpointTransaction<T>(
	databaseName: string,
	mode: IDBTransactionMode,
	action: (transaction: IDBTransaction) => Promise<T>
): Promise<T> {
	const db = await openDatabase(databaseName);
	const transaction = db.transaction([...AHE_STORES, PHASE_5C_STORAGE_META_STORE], mode, { durability: "strict" });
	const done = transactionDone(transaction);
	try {
		const value = await action(transaction);
		if (mode === "readwrite") transaction.commit();
		await done;
		return value;
	} catch (cause) {
		try {
			transaction.abort();
		} catch {
			/* Retain original cause after terminal. */
		}
		await done.catch(() => undefined);
		throw cause;
	} finally {
		db.close();
	}
}

async function boundedCheckpointImage(
	databaseName: string
): Promise<Record<"objects" | "generations" | "promotions" | "blobs" | "metadata", BoundedNativeRows>> {
	return boundedCheckpointTransaction(databaseName, "readonly", async (transaction) => ({
		objects: (await requestValue(transaction.objectStore(PHASE_2D_OBJECTS_STORE).getAll())) as BoundedNativeRows,
		generations: (await requestValue(
			transaction.objectStore(PHASE_2D_GENERATIONS_STORE).getAll()
		)) as BoundedNativeRows,
		promotions: (await requestValue(transaction.objectStore(PHASE_2D_PROMOTIONS_STORE).getAll())) as BoundedNativeRows,
		blobs: (await requestValue(transaction.objectStore(PHASE_2D_BLOBS_STORE).getAll())) as BoundedNativeRows,
		metadata: (await requestValue(transaction.objectStore(PHASE_5C_STORAGE_META_STORE).getAll())) as BoundedNativeRows,
	}));
}

function boundedCheckpointEqual(actual: unknown, expected: unknown, site: string): void {
	if (JSON.stringify(normalized(actual)) !== JSON.stringify(normalized(expected)))
		throw new TypeError(`D109C_BOUND_NATIVE_IMAGE:${site}`);
}

/**
 * Native mechanical inputs only; the public rollover remains the authentic eligibility test.
 * @param databaseName - Original native fixture database.
 * @param kind - New selected mechanical control.
 * @returns Actual bounded native outcomes after joined cleanup.
 */
async function runBoundedCheckpoint(
	databaseName: string,
	kind: BoundedCheckpointCase
): Promise<Record<string, unknown>> {
	let store = await createBrowserAheDurableStore({ databaseName });
	const originalDelete = IDBObjectStore.prototype.delete;
	try {
		const fixture = await d109cBoundedCheckpoint(store, kind === "shared");
		if (!store.acquireRetirementControl || !store.readRetirementImage) throw new TypeError("D109C_BOUND_PORT_MISSING");
		const before = await boundedCheckpointImage(databaseName);
		const controlKey = `ahe-retirement:${fixture.objectId}`;
		const controlRow = before.metadata.find((row) => row.key === controlKey);
		if (!(controlRow?.record instanceof Uint8Array)) throw new TypeError("D109C_BOUND_CONTROL_MISSING");
		if (kind === "currency") {
			for (const method of ["stageNominatedFutureGeneration", "publishNominatedFutureGeneration"] as const) {
				const view = d109cMust(await store.acquireRetirementControl(fixture.objectId));
				try {
					boundedCheckpointEqual(await view[method]({}), { ok: false, reason: "RETIREMENT_FENCED" }, method);
				} finally {
					await view.release();
				}
				boundedCheckpointEqual(await boundedCheckpointImage(databaseName), before, method);
			}
			const pending = d109cMust(await store.acquireRetirementControl(fixture.objectId));
			try {
				boundedCheckpointEqual(
					await pending.prepareBound({ preparation: fixture.preparation, generations: fixture.source.generations }),
					{ ok: false, reason: "RETIREMENT_FENCED" },
					"pending-prepare"
				);
			} finally {
				await pending.release();
			}
			boundedCheckpointEqual(await boundedCheckpointImage(databaseName), before, "pending-prepare-image");
			for (const mutation of ["head", "image", "incarnation", "revision", "source", "decision"] as const) {
				const stale = d109cMust(await store.acquireRetirementControl(fixture.objectId));
				const headRow = before.objects.find((row) => row.objectId === fixture.objectId);
				const generationRow = before.generations.find(
					(row) => row.objectId === fixture.objectId && row.generationId === generationId(3)
				);
				if (!headRow || !generationRow) throw new TypeError("D109C_BOUND_STALE_ROWS_MISSING");
				try {
					await boundedCheckpointTransaction(databaseName, "readwrite", async (tx) => {
						if (mutation === "head")
							await requestValue(
								tx.objectStore(PHASE_2D_OBJECTS_STORE).put({
									...headRow,
									record: encodeHeadRecordV1({
										...fixture.head,
										revision: d109cMust(parseHeadRevision(fixture.head.revision + 1)),
									}),
								})
							);
						else if (mutation === "image") {
							if (!(generationRow.record instanceof Uint8Array))
								throw new TypeError("D109C_BOUND_STALE_GENERATION_BYTES");
							const row = d109cMust(decodeGenerationRecordV1(generationRow.record));
							await requestValue(
								tx.objectStore(PHASE_2D_GENERATIONS_STORE).put({
									...generationRow,
									record: encodeGenerationRecordV1({
										...row,
										baseExpectedHead: { kind: "none", objectId: fixture.objectId },
									}),
								})
							);
						} else {
							const control = stale.control,
								completed = control.completed;
							if (!completed?.generationDrain) throw new TypeError("D109C_BOUND_STALE_DRAIN_MISSING");
							const changed =
								mutation === "incarnation"
									? { ...control, incarnation: "f".repeat(64) }
									: mutation === "revision"
										? { ...control, revision: control.revision + 1 }
										: mutation === "decision"
											? { ...control, completed: { ...completed, decisionDigest: "f".repeat(64) } }
											: {
													...control,
													completed: {
														...completed,
														generationDrain: {
															...completed.generationDrain,
															source: { ...completed.generationDrain.source, resumeBasisDigest: "f".repeat(64) },
														},
													},
												};
							await requestValue(
								tx
									.objectStore(PHASE_5C_STORAGE_META_STORE)
									.put({ ...controlRow, record: encodeAheRetirementControl(changed) })
							);
						}
					});
					const changed = await boundedCheckpointImage(databaseName);
					boundedCheckpointEqual(
						await stale.reclaimBoundedGeneration(),
						{ ok: false, reason: "READ_STALE_ROLE_VIEW" },
						mutation
					);
					boundedCheckpointEqual(await boundedCheckpointImage(databaseName), changed, `${mutation}-refusal`);
				} finally {
					await stale.release();
					await boundedCheckpointTransaction(databaseName, "readwrite", async (tx) => {
						await requestValue(tx.objectStore(PHASE_5C_STORAGE_META_STORE).put(controlRow));
						await requestValue(tx.objectStore(PHASE_2D_OBJECTS_STORE).put(headRow));
						await requestValue(tx.objectStore(PHASE_2D_GENERATIONS_STORE).put(generationRow));
					});
				}
				boundedCheckpointEqual(await boundedCheckpointImage(databaseName), before, `${mutation}-restore`);
			}
		}
		if (kind === "atomic") {
			let deletes = 0;
			IDBObjectStore.prototype.delete = function (query: IDBValidKey | IDBKeyRange): IDBRequest<undefined> {
				const request = Reflect.apply(originalDelete, this, [query]) as IDBRequest<undefined>;
				if (this.transaction.db.name === databaseName && ++deletes === 2)
					request.addEventListener("success", () => this.transaction.abort(), { once: true });
				return request;
			};
			const abortView = d109cMust(await store.acquireRetirementControl(fixture.objectId));
			try {
				const refused = await abortView.reclaimBoundedGeneration();
				if (refused.ok || refused.reason !== "SUBSTRATE_FAILURE")
					throw new TypeError("D109C_BOUND_REAL_ABORT_NOT_REFUSED");
			} finally {
				IDBObjectStore.prototype.delete = originalDelete;
				await abortView.release();
			}
			if (deletes !== 2) throw new TypeError("D109C_BOUND_SECOND_DELETE_NOT_REACHED");
			boundedCheckpointEqual(await boundedCheckpointImage(databaseName), before, "actual-delete-abort-old");
			await store.close();
			store = await createBrowserAheDurableStore({ databaseName });
		}
		if (!store.acquireRetirementControl || !store.readRetirementImage)
			throw new TypeError("D109C_BOUND_REOPEN_PORT_MISSING");
		const view = d109cMust(await store.acquireRetirementControl(fixture.objectId));
		const pendingControl = view.control;
		let deleteCount = 0;
		IDBObjectStore.prototype.delete = function (query: IDBValidKey | IDBKeyRange): IDBRequest<undefined> {
			if (this.transaction.db.name === databaseName) deleteCount++;
			return Reflect.apply(originalDelete, this, [query]) as IDBRequest<undefined>;
		};
		let completed;
		try {
			const operation = view.reclaimBoundedGeneration();
			if (kind === "atomic") {
				const loss = new Error("test-owned joined reclaim delivery loss");
				try {
					await operation.then((result) => {
						d109cMust(result);
						throw loss;
					});
				} catch (cause) {
					if (cause !== loss) throw cause;
				}
				// No successful mutation result is accepted after the lost delivery:
				// recover exact NEW from an independent original point read.
				completed = d109cMust(await store.readRetirementImage(fixture.objectId)).control;
			} else completed = d109cMust(await operation);
		} finally {
			IDBObjectStore.prototype.delete = originalDelete;
			await view.release();
		}
		boundedCheckpointEqual(
			completed,
			{
				...pendingControl,
				revision: pendingControl.revision + 1,
				completed: {
					...pendingControl.completed,
					generationHoles: fixture.source.postGenerations.recordDigests,
					generationIdentities: fixture.source.postGenerations.identities,
					generationDrain: { source: fixture.source, phase: "complete" },
				},
			},
			"complete-control"
		);
		const after = await boundedCheckpointImage(databaseName);
		boundedCheckpointEqual(after.objects, before.objects, "head-unchanged");
		boundedCheckpointEqual(
			after.generations,
			before.generations
				.filter((row) => row.objectId !== fixture.objectId || row.generationId !== generationId(1))
				.map((row) =>
					row.objectId === fixture.objectId && row.generationId === generationId(2)
						? { ...row, record: encodeGenerationRecordV1(fixture.decision.floor.rewrittenGeneration) }
						: row
				),
			"exact-generation-rows"
		);
		boundedCheckpointEqual(
			after.promotions,
			before.promotions.filter((row) => row.objectId !== fixture.objectId || row.generationId !== generationId(1)),
			"exact-promotion-rows"
		);
		boundedCheckpointEqual(
			after.blobs,
			before.blobs.filter((row) => !fixture.decision.deleteBlobDigests.includes(row.digest as BlobDigest)),
			"exact-blob-rows"
		);
		boundedCheckpointEqual(
			after.metadata,
			before.metadata.map((row) =>
				row.key === controlKey ? { ...row, record: encodeAheRetirementControl(completed) } : row
			),
			"exact-all-metadata"
		);
		const actualDeletes =
			before.generations.length -
			after.generations.length +
			before.promotions.length -
			after.promotions.length +
			before.blobs.length -
			after.blobs.length;
		if (actualDeletes !== deleteCount || deleteCount !== (kind === "shared" ? 14 : 15))
			throw new TypeError("D109C_BOUND_NATIVE_DELETE_COUNT");
		if (kind === "shared")
			boundedCheckpointEqual(
				d109cMust(await store.getBlob(fixture.shared.digest)),
				Uint8Array.of(1, 0, 101),
				"foreign-shared-payload"
			);
		const point = d109cMust(await store.readRetirementImage(fixture.objectId));
		if (point.imageDigest !== fixture.source.postImageDigest) throw new TypeError("D109C_BOUND_POST_IMAGE");
		boundedCheckpointEqual(point.head, fixture.head, "post-head");
		await store.close();
		store = await createBrowserAheDurableStore({ databaseName });
		if (!store.readRetirementImage || !store.acquireRetirementControl) throw new TypeError("D109C_BOUND_COLD_PORT");
		boundedCheckpointEqual(d109cMust(await store.readRetirementImage(fixture.objectId)), point, "same-db-reopen");
		boundedCheckpointEqual(await boundedCheckpointImage(databaseName), after, "cold-full-native-image");
		if (kind === "currency") {
			const fresh = d109cMust(await store.acquireRetirementControl(fixture.objectId));
			const nextPreparation = {
				...fixture.preparation,
				floorEpoch: 4,
				decisionDigest: "1".repeat(64),
				sourceProofDigest: "2".repeat(64),
				generationRecordDigests: fixture.source.postGenerations.recordDigests,
			};
			delete nextPreparation.generationSource;
			try {
				d109cMust(
					await fresh.prepareBound({ preparation: nextPreparation, generations: fixture.source.postGenerations })
				);
			} finally {
				await fresh.release();
			}
			const commit = d109cMust(await store.acquireRetirementControl(fixture.objectId));
			try {
				const current = d109cMust(
					await commit.commitPrepared({
						decisionDigest: nextPreparation.decisionDigest,
						sourceProofDigest: nextPreparation.sourceProofDigest,
					})
				);
				if (current.completed?.throughEpoch !== 4 || current.completed.generationDrain)
					throw new TypeError("D109C_BOUND_FRESH_PREPARATION");
			} finally {
				await commit.release();
			}
			const future = d109cMust(await store.acquireRetirementControl(fixture.objectId));
			try {
				boundedCheckpointEqual(
					await future.stageNominatedFutureGeneration({}),
					{ ok: false, reason: "INVALID_ARGUMENT" },
					"untrusted-future-after-completion"
				);
			} finally {
				await future.release();
			}
		}
		return {
			kind,
			passed: true,
			deleteCount,
			singleGeneration: true,
			foreignSharedRetained: kind === "shared",
			actualAbortOld: kind === "atomic",
			joinedCompleteNew: true,
			coldSameNative: true,
			staleCases: kind === "currency" ? 6 : 0,
			pendingRefusals: kind === "currency" ? 3 : 0,
		};
	} finally {
		IDBObjectStore.prototype.delete = originalDelete;
		await store.close();
	}
}

/**
 * Native noncreating absence and complete-image control, without protocol authority.
 * @param databaseName - Fresh original IndexedDB database, reused across cold reopen.
 * @returns Exact checks only after the original store cleanup joins.
 */
async function runRetirementAdmissionImage(databaseName: string): Promise<Record<string, unknown>> {
	let store = await createBrowserAheDurableStore({ databaseName });
	let held: NativeReadReservation | undefined;
	let foreign: IDBDatabase | undefined;
	let foreignDone: Promise<void> | undefined;
	try {
		const objectId = d109cMust(parseStorageObjectId(`admission-image:${"c".repeat(32)}`)),
			currentId = d109cMust(parseGenerationId("c".repeat(64))),
			stagedId = d109cMust(parseGenerationId("d".repeat(64))),
			bytes = Uint8Array.of(1),
			digest = d109cMust(digestBlob(bytes)),
			stagedBytes = Uint8Array.of(2),
			stagedDigest = d109cMust(digestBlob(stagedBytes)),
			absent = { kind: "none" as const, objectId };
		d109cMust(
			await store.beginGeneration({
				objectId,
				generationId: currentId,
				baseExpectedHead: absent,
				closure: [{ digest, byteLength: bytes.byteLength }],
			})
		);
		d109cMust(await store.putCachedBlob({ objectId, generationId: currentId, digest, bytes }));
		d109cMust(await store.promoteReference({ objectId, generationId: currentId, digest }));
		d109cMust(await store.completeGeneration({ objectId, generationId: currentId }));
		const head = d109cMust(await store.swapHead({ objectId, generationId: currentId, expectedHead: absent })).head;
		d109cMust(
			await store.beginGeneration({
				objectId,
				generationId: stagedId,
				baseExpectedHead: head,
				closure: [{ digest: stagedDigest, byteLength: stagedBytes.byteLength }],
			})
		);
		if (!store.readRetirementAdmissionImage || !store.readRetirementImage || !store.acquireRetirementControl)
			throw new TypeError("R8_ABSENT_ADMISSION_IMAGE_READER_UNAVAILABLE");
		const before = await boundedCheckpointImage(databaseName),
			point = d109cMust(await store.readRetirementAdmissionImage(objectId));
		const originalBlob = before.blobs.find((row) => row.digest === digest);
		if (originalBlob === undefined) throw new TypeError("R8_ADMISSION_ORIGINAL_BLOB_UNAVAILABLE");
		boundedCheckpointEqual(point.head, head, "admission-head");
		if (point.control !== null || point.metadataBytes !== 0 || !/^[0-9a-f]{64}$/u.test(point.imageDigest))
			throw new TypeError("R8_ABSENT_ADMISSION_IMAGE_METADATA");
		if (!Object.isFrozen(point)) throw new TypeError("R8_ABSENT_ADMISSION_IMAGE_MUTABLE");
		boundedCheckpointEqual(d109cMust(await store.readRetirementAdmissionImage(objectId)), point, "admission-repeat");
		boundedCheckpointEqual(
			await store.readRetirementImage(objectId),
			{ ok: false, reason: "INVALID_ARGUMENT" },
			"old-absent-contract"
		);
		boundedCheckpointEqual(await boundedCheckpointImage(databaseName), before, "admission-no-birth");
		await boundedCheckpointTransaction(databaseName, "readwrite", async (tx) => {
			await requestValue(tx.objectStore(PHASE_2D_BLOBS_STORE).put({ digest: stagedDigest, bytes: stagedBytes }));
		});
		const changed = d109cMust(await store.readRetirementAdmissionImage(objectId));
		if (changed.imageDigest === point.imageDigest || changed.control !== null || changed.metadataBytes !== 0)
			throw new TypeError("R8_ABSENT_ADMISSION_IMAGE_CURRENCY");
		const changedNative = await boundedCheckpointImage(databaseName);
		boundedCheckpointEqual(changedNative.metadata, before.metadata, "optional-blob-no-birth");
		await boundedCheckpointTransaction(databaseName, "readwrite", async (tx) => {
			await requestValue(tx.objectStore(PHASE_2D_BLOBS_STORE).delete(digest));
		});
		const missingNative = await boundedCheckpointImage(databaseName);
		boundedCheckpointEqual(
			await store.readRetirementAdmissionImage(objectId),
			{ ok: false, reason: "ADOPTED_BLOB_MISSING" },
			"absent-control-required-byte-refusal"
		);
		boundedCheckpointEqual(await boundedCheckpointImage(databaseName), missingNative, "missing-byte-no-mutation");
		await boundedCheckpointTransaction(databaseName, "readwrite", async (tx) => {
			await requestValue(tx.objectStore(PHASE_2D_BLOBS_STORE).put(originalBlob));
		});
		boundedCheckpointEqual(await boundedCheckpointImage(databaseName), changedNative, "required-byte-restored");
		await store.close();
		store = await createBrowserAheDurableStore({ databaseName });
		if (!store.readRetirementAdmissionImage || !store.readRetirementImage || !store.acquireRetirementControl)
			throw new TypeError("R8_ABSENT_ADMISSION_IMAGE_REOPEN_UNAVAILABLE");
		boundedCheckpointEqual(
			d109cMust(await store.readRetirementAdmissionImage(objectId)),
			changed,
			"admission-same-db-reopen"
		);
		const view = d109cMust(await store.acquireRetirementControl(objectId));
		try {
			const present = d109cMust(await store.readRetirementAdmissionImage(objectId));
			boundedCheckpointEqual(
				present,
				d109cMust(await store.readRetirementImage(objectId)),
				"admission-old-present-contract"
			);
			boundedCheckpointEqual(present.control, view.control, "admission-genuine-native-birth");
			if (present.imageDigest !== changed.imageDigest || present.metadataBytes !== view.metadataBytes)
				throw new TypeError("R8_ADMISSION_IMAGE_PRESENT_WIDTH");
		} finally {
			await view.release();
		}
		const descriptors = new Map<string, PropertyDescriptor>();
		let measuring = false, rawReads = 0, captureLease = false;
		const captured = {heldTransaction: undefined as IDBTransaction | undefined};
		for (const name of ["get", "getAll", "openCursor", "getKey"]) {
			const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, name);
			if (descriptor === undefined || typeof descriptor.value !== "function") throw new TypeError("R8_HELD_NATIVE_REQUEST_UNAVAILABLE");
			descriptors.set(name, descriptor);
			Object.defineProperty(IDBObjectStore.prototype, name, {...descriptor, value: function (this: IDBObjectStore, ...args: unknown[]): unknown {
				if (captureLease && name === "getKey") captured.heldTransaction = this.transaction;
				if (measuring && name !== "getKey" && (this.name === PHASE_2D_BLOBS_STORE ||
					this.name === PHASE_2D_GENERATIONS_STORE || this.name === PHASE_2D_PROMOTIONS_STORE)) rawReads++;
				return Reflect.apply(descriptor.value as (...input: unknown[]) => unknown, this, args);
			}});
		}
		const measured = async () => {
			rawReads = 0; measuring = true;
			try {return {value: await store.readRetirementAdmissionImage!(objectId), rawReads};}
			finally {measuring = false;}
		};
		const acquire = async () => {
			captureLease = true;
			try {held = await store.acquireNativeReadReservation({objectId});}
			finally {captureLease = false;}
		};
		try {
			await acquire();
			const first = await measured(), repeated = await measured();
			if (first.rawReads === 0 || repeated.rawReads !== 0) throw new TypeError("R8_HELD_RAW_ADMISSION_NOT_ONCE");
			const firstValue = d109cMust(first.value), repeatedValue = d109cMust(repeated.value);
			boundedCheckpointEqual(firstValue, repeatedValue, "held-exact-image");
			if (firstValue.head === repeatedValue.head || firstValue.control === repeatedValue.control || firstValue.control === null)
				throw new TypeError("R8_HELD_PUBLIC_DTO_ALIAS");
			Reflect.set(firstValue.control, "incarnation", "caller-mutated-incarnation");
			boundedCheckpointEqual(d109cMust((await measured()).value), repeatedValue, "held-private-image-isolation");
			foreign = await openDatabase(databaseName);
			const writer = foreign.transaction([PHASE_2D_BLOBS_STORE], "readwrite", {durability: "strict"});
			foreignDone = transactionDone(writer); void foreignDone.catch(() => undefined);
			let writerDelivered = false;
			writer.objectStore(PHASE_2D_BLOBS_STORE).delete(stagedDigest).addEventListener("success", () => {writerDelivered = true;}, {once: true});
			writer.commit();
			await held!.check();
			boundedCheckpointEqual(d109cMust((await measured()).value), repeatedValue, "held-foreign-write-exclusion");
			if (writerDelivered) throw new TypeError("R8_HELD_FOREIGN_WRITE_ENTERED");
			await held!.release();
			try {await held!.check(); throw new TypeError("R8_HELD_RELEASE_NOT_REVOKED");}
			catch (cause) {if (cause instanceof TypeError && cause.message === "R8_HELD_RELEASE_NOT_REVOKED") throw cause;}
			held = undefined;
			await foreignDone; foreignDone = undefined; foreign.close(); foreign = undefined;
			await acquire();
			const afterWrite = await measured();
			if (afterWrite.rawReads === 0 || d109cMust(afterWrite.value).imageDigest === repeatedValue.imageDigest)
				throw new TypeError("R8_HELD_REACQUIRE_REUSED_OLD_IMAGE");
			if ((await measured()).rawReads !== 0) throw new TypeError("R8_HELD_REACQUIRE_RAW_REPEAT");
			await held!.release(); held = undefined;
			await boundedCheckpointTransaction(databaseName, "readwrite", async tx => {
				await requestValue(tx.objectStore(PHASE_2D_BLOBS_STORE).put({digest, bytes: Uint8Array.of(255)}));
			});
			const originalRefusal = await store.readRetirementAdmissionImage(objectId);
			if (originalRefusal.ok) throw new TypeError("R8_HELD_PRELEASE_CORRUPTION_ACCEPTED");
			await acquire();
			const corrupt = await measured();
			if (corrupt.rawReads === 0) throw new TypeError("R8_HELD_PRELEASE_CORRUPTION_NOT_SCANNED");
			boundedCheckpointEqual(corrupt.value, originalRefusal, "held-original-same-count-corruption-refusal");
			await held!.release(); held = undefined;
			await boundedCheckpointTransaction(databaseName, "readwrite", async tx => {
				await requestValue(tx.objectStore(PHASE_2D_BLOBS_STORE).put({digest, bytes}));
			});
			await acquire(); d109cMust((await measured()).value);
			if (captured.heldTransaction === undefined) throw new TypeError("R8_HELD_NATIVE_TRANSACTION_NOT_CAPTURED");
			captured.heldTransaction.abort();
			let failedJoin = false;
			try {await held!.release();} catch {failedJoin = true;}
			if (!failedJoin) throw new TypeError("R8_HELD_UNEXPECTED_ABORT_JOIN_ACCEPTED");
			held = undefined;
			await acquire();
			if ((await measured()).rawReads === 0) throw new TypeError("R8_HELD_FAILED_JOIN_REUSE");
			await store.close();
			let revoked = false; try {await held!.check();} catch {revoked = true;}
			if (!revoked) throw new TypeError("R8_HELD_CLOSED_LEASE_NOT_REVOKED");
			await held!.release(); held = undefined;
		} finally {for (const [name, descriptor] of descriptors) Object.defineProperty(IDBObjectStore.prototype, name, descriptor);}
		await store.close();
		boundedCheckpointEqual(
			await store.readRetirementAdmissionImage(objectId),
			{ ok: false, reason: "STORE_CLOSED" },
			"admission-closed"
		);
		return {
			absentNoncreating: true,
			completeImage: true,
			requiredByteRefusal: true,
			sameDatabaseReopen: true,
			genuineBirthCompatible: true,
			closedRefusal: true,
			heldRawAdmissionOnce: true,
			heldForeignWriteExclusion: true,
			heldPublicDtoIsolation: true,
			heldReacquireFreshImage: true,
			heldSameCountCorruptionRefusal: true,
			heldFailedJoinPreserved: true,
		};
	} finally {
		await held?.release();
		await foreignDone;
		foreign?.close();
		await store.close();
	}
}

Reflect.set(
	globalThis,
	"phase6bAheReclamation",
	Object.freeze({
		runRetirementAdmissionImage,
		runBoundedCheckpoint,
		prepareSchedulingScenario,
		ready: D109C_BROWSER_MAINTENANCE_READY,
		run,
		runChangedPreconditionScenario,
		runCrashMatrix,
		runLifecycleScenario,
		runMutantMatrix,
		runPositiveControls,
		runPreparedCleanup,
		runReferenceMatrix,
		runSchedulingMode,
		workerUrl,
	})
);
