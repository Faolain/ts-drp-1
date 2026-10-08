import {
	type AheDurableStore,
	digestBlob,
	type ExpectedHead,
	type GenerationId,
	type NoHead,
	parseGenerationId,
	parseStorageObjectId,
	type StorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";

import {
	deletePhase2dDatabase,
	type Phase2e5InventoryTrace,
	rawPhase2e2Delete,
	withPhase2e5RequestInventoryTrace,
} from "../fixtures/idb-adapter-browser-oracle.js";
import { createPhase2d2aRedStore } from "../fixtures/idb-adapter-red-scaffold.js";

const OBJECT = must(parseStorageObjectId(`phase-2d2a-a:${"a".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("a".repeat(64)));
const GENERATION_B = must(parseGenerationId("b".repeat(64)));
const GENERATION_C = must(parseGenerationId("c".repeat(64)));
const PAYLOAD_A = Uint8Array.of(1, 2, 3, 4);
const PAYLOAD_B = Uint8Array.of(9, 8, 7);
const PAYLOAD_C = Uint8Array.of(5, 6);
const DIGEST_A = must(digestBlob(PAYLOAD_A));

type InventoryResult = Readonly<{
	id: string;
	result: string | readonly string[];
	requests: Phase2e5InventoryTrace<unknown>["requests"];
	transactions: Phase2e5InventoryTrace<unknown>["transactions"];
}>;

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new TypeError("invalid Phase 2e5 inventory fixture");
	return result.value;
}

function databaseName(label: string): string {
	return `phase-2e5-inventory-${label}-${crypto.randomUUID()}`;
}

function noHead(objectId: StorageObjectId): NoHead {
	return { kind: "none", objectId };
}

function outcome(result: StoreResult<unknown>): string {
	return result.ok ? "OK" : result.reason;
}

function inventoryResult(id: string, trace: Phase2e5InventoryTrace<unknown>): InventoryResult {
	return Object.freeze({
		id,
		requests: trace.requests,
		result:
			trace.result === undefined
				? "OK"
				: Array.isArray(trace.result)
					? Object.freeze(trace.result.map((result) => outcome(result)))
					: outcome(trace.result as StoreResult<unknown>),
		transactions: trace.transactions,
	});
}

async function begin(
	store: AheDurableStore,
	generationId: GenerationId,
	baseExpectedHead: ExpectedHead = noHead(OBJECT),
	payload = PAYLOAD_A
): Promise<StoreResult<unknown>> {
	const digest = must(digestBlob(payload));
	return store.beginGeneration({
		baseExpectedHead,
		closure: [{ byteLength: payload.byteLength, digest }],
		generationId,
		objectId: OBJECT,
	});
}

async function stageComplete(
	store: AheDurableStore,
	generationId: GenerationId,
	payload = PAYLOAD_A,
	baseExpectedHead: ExpectedHead = noHead(OBJECT)
): Promise<void> {
	const digest = must(digestBlob(payload));
	const begun = await begin(store, generationId, baseExpectedHead, payload);
	if (!begun.ok)
		throw new Error(
			`inventory begin failed: ${begun.reason}:${
				begun.reason === "SUBSTRATE_FAILURE"
					? JSON.stringify({
							keys: typeof begun.cause === "object" && begun.cause !== null ? Object.keys(begun.cause) : [],
							code:
								typeof begun.cause === "object" && begun.cause !== null ? String(Reflect.get(begun.cause, "code")) : "",
							message: begun.cause instanceof Error ? begun.cause.message : String(begun.cause),
							name:
								typeof begun.cause === "object" && begun.cause !== null
									? String(Reflect.get(begun.cause, "name"))
									: typeof begun.cause,
						})
					: ""
			}`
		);
	if (!(await store.putCachedBlob({ bytes: payload, digest, generationId, objectId: OBJECT })).ok)
		throw new Error("inventory cache failed");
	if (!(await store.promoteReference({ digest, generationId, objectId: OBJECT })).ok)
		throw new Error("inventory promotion failed");
	if (!(await store.completeGeneration({ generationId, objectId: OBJECT })).ok)
		throw new Error("inventory completion failed");
}

async function seedAdopted(name: string): Promise<Exclude<ExpectedHead, NoHead>> {
	const store = await createPhase2d2aRedStore({ databaseName: name });
	try {
		await stageComplete(store, GENERATION_A);
		const swapped = await store.swapHead({
			expectedHead: noHead(OBJECT),
			generationId: GENERATION_A,
			objectId: OBJECT,
		});
		if (!swapped.ok) throw new Error(`inventory adoption failed: ${swapped.reason}`);
		return swapped.value.head;
	} finally {
		await store.close();
	}
}

async function isolated(
	id: string,
	run: (name: string) => Promise<Phase2e5InventoryTrace<unknown>>
): Promise<InventoryResult> {
	const name = databaseName(id);
	try {
		try {
			return inventoryResult(id, await run(name));
		} catch (cause) {
			throw new Error(`${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runPhase2e5BrowserInventory(): Promise<readonly InventoryResult[]> {
	const rows: InventoryResult[] = [];
	rows.push(
		await isolated("read-head-empty", async (name) => {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			const trace = await withPhase2e5RequestInventoryTrace(() => store.readHead(OBJECT));
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("read-generation-page-empty", async (name) => {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			const trace = await withPhase2e5RequestInventoryTrace(() =>
				store.readGenerationPage({ limit: 2, objectId: OBJECT })
			);
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("get-blob-missing", async (name) => {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			const trace = await withPhase2e5RequestInventoryTrace(() => store.getBlob(DIGEST_A));
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("begin-generation-empty", async (name) => {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			const trace = await withPhase2e5RequestInventoryTrace(() => begin(store, GENERATION_A));
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("begin-generation-certificate-match", async (name) => {
			const adoptedHead = await seedAdopted(name);
			const store = await createPhase2d2aRedStore({ databaseName: name });
			if (!(await store.recoverActiveGeneration(OBJECT)).ok) throw new Error("inventory certificate seed failed");
			const trace = await withPhase2e5RequestInventoryTrace(() => begin(store, GENERATION_B, adoptedHead, PAYLOAD_B));
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("put-cached-blob-staged", async (name) => {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			await begin(store, GENERATION_A);
			const trace = await withPhase2e5RequestInventoryTrace(() =>
				store.putCachedBlob({ bytes: PAYLOAD_A, digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT })
			);
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("promote-reference-staged", async (name) => {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			await begin(store, GENERATION_A);
			await store.putCachedBlob({ bytes: PAYLOAD_A, digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT });
			const trace = await withPhase2e5RequestInventoryTrace(() =>
				store.promoteReference({ digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT })
			);
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("complete-generation-empty-recovery", async (name) => {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			await begin(store, GENERATION_A);
			await store.putCachedBlob({ bytes: PAYLOAD_A, digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT });
			await store.promoteReference({ digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT });
			const trace = await withPhase2e5RequestInventoryTrace(() =>
				store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT })
			);
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("swap-head-certificate-match", async (name) => {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			await stageComplete(store, GENERATION_A);
			const trace = await withPhase2e5RequestInventoryTrace(() =>
				store.swapHead({ expectedHead: noHead(OBJECT), generationId: GENERATION_A, objectId: OBJECT })
			);
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("swap-head-fresh-recovery", async (name) => {
			const seeded = await createPhase2d2aRedStore({ databaseName: name });
			await stageComplete(seeded, GENERATION_A);
			await seeded.close();
			const store = await createPhase2d2aRedStore({ databaseName: name });
			const trace = await withPhase2e5RequestInventoryTrace(() =>
				store.swapHead({ expectedHead: noHead(OBJECT), generationId: GENERATION_A, objectId: OBJECT })
			);
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("discard-generation-staged", async (name) => {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			await begin(store, GENERATION_A);
			const trace = await withPhase2e5RequestInventoryTrace(() =>
				store.discardGeneration({ generationId: GENERATION_A, objectId: OBJECT })
			);
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("recover-active-empty", async (name) => {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			const trace = await withPhase2e5RequestInventoryTrace(() => store.recoverActiveGeneration(OBJECT));
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("recover-active-adopted", async (name) => {
			await seedAdopted(name);
			const store = await createPhase2d2aRedStore({ databaseName: name });
			const trace = await withPhase2e5RequestInventoryTrace(() => store.recoverActiveGeneration(OBJECT));
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("begin-generation-stale-certificate-recovery", async (name) => {
			const firstHead = await seedAdopted(name);
			const first = await createPhase2d2aRedStore({ databaseName: name });
			if (!(await first.recoverActiveGeneration(OBJECT)).ok) throw new Error("inventory certificate seed failed");
			const second = await createPhase2d2aRedStore({ databaseName: name });
			await stageComplete(second, GENERATION_B, PAYLOAD_B, firstHead);
			const advanced = await second.swapHead({ expectedHead: firstHead, generationId: GENERATION_B, objectId: OBJECT });
			if (!advanced.ok) throw new Error(`inventory concurrent advance failed: ${advanced.reason}`);
			await rawPhase2e2Delete(name, "promotions", [OBJECT, GENERATION_B, must(digestBlob(PAYLOAD_B))]);
			const trace = await withPhase2e5RequestInventoryTrace(() => begin(first, GENERATION_C, firstHead, PAYLOAD_C));
			await first.close();
			await second.close();
			return trace;
		})
	);
	rows.push(
		await isolated("recover-active-queued-poison", async (name) => {
			await seedAdopted(name);
			await rawPhase2e2Delete(name, "promotions", [OBJECT, GENERATION_A, DIGEST_A]);
			const store = await createPhase2d2aRedStore({ databaseName: name });
			const trace = await withPhase2e5RequestInventoryTrace(() =>
				Promise.all([store.recoverActiveGeneration(OBJECT), store.recoverActiveGeneration(OBJECT)])
			);
			await store.close();
			return trace;
		})
	);
	rows.push(
		await isolated("close-idle", async (name) => {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			return withPhase2e5RequestInventoryTrace(() => store.close());
		})
	);
	return Object.freeze(rows);
}

Reflect.set(globalThis, "phase2e5BrowserInventoryHarness", Object.freeze({ runPhase2e5BrowserInventory }));
