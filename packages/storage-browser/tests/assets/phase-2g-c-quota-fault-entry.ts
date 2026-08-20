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
	withPhase2e5RequestInventoryTrace,
} from "../fixtures/idb-adapter-browser-oracle.js";
import { createPhase2d2aRedStore } from "../fixtures/idb-adapter-red-scaffold.js";
import {
	preparePhase2gEngineQuotaControl,
	runPhase2gDeterministicMatrix,
	runPhase2gEngineQuotaControl,
} from "../fixtures/phase-2g-c-quota-fault-instrument.js";

const OBJECT = must(parseStorageObjectId(`phase-2g-c:${"c".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("a".repeat(64)));
const GENERATION_B = must(parseGenerationId("b".repeat(64)));
const PAYLOAD_A = Uint8Array.of(1, 3, 5, 7);
const PAYLOAD_B = Uint8Array.of(2, 4, 6, 8, 10);

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new TypeError("invalid Phase 2g-c browser fixture");
	return result.value;
}

function noHead(objectId: StorageObjectId): NoHead {
	return { kind: "none", objectId };
}

async function stageComplete(
	store: AheDurableStore,
	generationId: GenerationId,
	payload: Uint8Array,
	baseExpectedHead: ExpectedHead
): Promise<void> {
	const digest = must(digestBlob(payload));
	const results: StoreResult<unknown>[] = [];
	results.push(
		await store.beginGeneration({
			baseExpectedHead,
			closure: [{ byteLength: payload.byteLength, digest }],
			generationId,
			objectId: OBJECT,
		})
	);
	results.push(await store.putCachedBlob({ bytes: payload, digest, generationId, objectId: OBJECT }));
	results.push(await store.promoteReference({ digest, generationId, objectId: OBJECT }));
	results.push(await store.completeGeneration({ generationId, objectId: OBJECT }));
	const failure = results.find((result) => !result.ok);
	if (failure !== undefined && !failure.ok) throw new Error(`Phase 2g-c seed failed: ${failure.reason}`);
}

async function runPresentHeadTrace(): Promise<
	Readonly<{
		id: string;
		requests: Phase2e5InventoryTrace<unknown>["requests"];
		result: string;
		transactions: Phase2e5InventoryTrace<unknown>["transactions"];
	}>
> {
	const databaseName = `phase-2g-c-present-${crypto.randomUUID()}`;
	try {
		const store = await createPhase2d2aRedStore({ databaseName });
		await stageComplete(store, GENERATION_A, PAYLOAD_A, noHead(OBJECT));
		const first = await store.swapHead({ expectedHead: noHead(OBJECT), generationId: GENERATION_A, objectId: OBJECT });
		if (!first.ok) throw new Error(`Phase 2g-c first adoption failed: ${first.reason}`);
		await stageComplete(store, GENERATION_B, PAYLOAD_B, first.value.head);
		const trace = await withPhase2e5RequestInventoryTrace(() =>
			store.swapHead({ expectedHead: first.value.head, generationId: GENERATION_B, objectId: OBJECT })
		);
		await store.close();
		return Object.freeze({
			id: "swap-head-present-supersession",
			requests: trace.requests,
			result: trace.result.ok ? "OK" : trace.result.reason,
			transactions: trace.transactions,
		});
	} finally {
		await deletePhase2dDatabase(databaseName);
	}
}

function runDeterministicMatrix(): Promise<unknown> {
	return runPhase2gDeterministicMatrix();
}

function runEngineGeneratedControl(supportedOverrideAttempted: boolean): Promise<unknown> {
	return runPhase2gEngineQuotaControl(supportedOverrideAttempted);
}

Reflect.set(
	globalThis,
	"phase2gCQuotaFaultHarness",
	Object.freeze({
		prepareEngineGeneratedControl: preparePhase2gEngineQuotaControl,
		runDeterministicMatrix,
		runEngineGeneratedControl,
		runPresentHeadTrace,
	})
);
