/* eslint-disable import/no-unresolved -- Focused build plugin owns the causal maintenance alias. */
import {
	type AheDurableStore,
	createMemoryAheDurableStore,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestBlob,
	encodeGenerationRecordV1,
	type ExpectedHead,
	type GenerationRecord,
} from "@ts-drp/storage";

import {
	D109C_BROWSER_MAINTENANCE_READY,
	resolveBrowserAheReclamationMaintenance,
} from "#phase-6b-ahe-reclamation-maintenance";
import { createBrowserAheDurableStore } from "../../src/index.js";
import { installBrowserAheReclamationCountFault } from "../../src/internal/ahe-reclamation.js";
import {
	PHASE_2D_BLOBS_STORE,
	PHASE_2D_GENERATIONS_STORE,
	PHASE_2D_OBJECTS_STORE,
	PHASE_2D_PROMOTIONS_STORE,
} from "../../src/internal/schema-idb.js";

const OBJECT_ID = `creator:${"a".repeat(32)}`;
const OTHER_OBJECT_ID = `creator:${"b".repeat(32)}`;
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

function generationId(index: number): string {
	return index.toString(16).padStart(64, "0");
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

async function fiveGenerations(
	store: AheDurableStore,
	bytesForIndex: (index: number) => Uint8Array = (index) => Uint8Array.of(index, index + 1, index + 2),
	generationCount = 5
): Promise<Readonly<{ input: Record<string, unknown>; records: readonly GenerationRecord[] }>> {
	let head: ExpectedHead = successful(await store.readHead(OBJECT_ID), "HEAD");
	const records = [];
	for (let index = 1; index <= generationCount; index += 1) {
		const generationId = index.toString(16).padStart(64, "0");
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
					revision: 2,
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

Reflect.set(
	globalThis,
	"phase6bAheReclamation",
	Object.freeze({
		ready: D109C_BROWSER_MAINTENANCE_READY,
		run,
		runCrashMatrix,
		runMutantMatrix,
		runPositiveControls,
		runReferenceMatrix,
		workerUrl,
	})
);
