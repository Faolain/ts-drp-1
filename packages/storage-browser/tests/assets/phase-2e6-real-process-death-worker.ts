import {
	type AheDurableStore,
	digestBlob,
	type ExpectedHead,
	type GenerationId,
	type NoHead,
	parseGenerationId,
	parseStorageObjectId,
	type StorageObjectId,
} from "@ts-drp/storage";

import { createPhase2dAheDurableStore } from "../../src/internal/idb-adapter.js";
import {
	type Phase2e6DatabaseLifecycleTrace,
	tracePhase2e6DatabaseLifecycle,
	withPhase2e6SettlementTrace,
} from "../fixtures/idb-adapter-browser-oracle.js";
import type { Phase2e6DeclaredEdge } from "../fixtures/phase-2e6-real-process-death-contract.js";

const OBJECT = must(parseStorageObjectId(`phase-2e6-object:${"a".repeat(32)}`));
const SENTINEL_OBJECT = must(parseStorageObjectId(`phase-2e6-sentinel:${"f".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("a".repeat(64)));
const GENERATION_B = must(parseGenerationId("b".repeat(64)));
const SENTINEL_GENERATION = must(parseGenerationId("f".repeat(64)));
const PAYLOAD_A = Uint8Array.of(1, 2, 3, 4);
const PAYLOAD_B = Uint8Array.of(9, 8, 7);

interface RunMessage {
	readonly databaseName: string;
	readonly edge: Phase2e6DeclaredEdge;
	readonly kind: "run";
	readonly signal: SharedArrayBuffer;
	readonly version: 1;
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new TypeError("invalid Phase 2e6 fixture");
	return result.value;
}

function noHead(objectId: StorageObjectId): NoHead {
	return { kind: "none", objectId };
}

function begin(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId,
	baseExpectedHead: ExpectedHead = noHead(objectId),
	payload = PAYLOAD_A
): ReturnType<AheDurableStore["beginGeneration"]> {
	const digest = must(digestBlob(payload));
	return store.beginGeneration({
		baseExpectedHead,
		closure: [{ byteLength: payload.byteLength, digest }],
		generationId,
		objectId,
	});
}

async function stageCandidate(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId,
	payload = PAYLOAD_A
): Promise<void> {
	const digest = must(digestBlob(payload));
	if (!(await begin(store, objectId, generationId, noHead(objectId), payload)).ok) throw new Error("seed begin failed");
	if (!(await store.putCachedBlob({ bytes: payload, digest, generationId, objectId })).ok)
		throw new Error("seed blob failed");
	if (!(await store.promoteReference({ digest, generationId, objectId })).ok) throw new Error("seed promotion failed");
}

async function stageComplete(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId,
	payload = PAYLOAD_A
): Promise<void> {
	await stageCandidate(store, objectId, generationId, payload);
	if (!(await store.completeGeneration({ generationId, objectId })).ok) throw new Error("seed complete failed");
}

async function seed(databaseName: string, scenarioId: string): Promise<ExpectedHead> {
	const store = await createPhase2dAheDurableStore({ databaseName });
	try {
		if (!(await begin(store, SENTINEL_OBJECT, SENTINEL_GENERATION, noHead(SENTINEL_OBJECT), PAYLOAD_B)).ok)
			throw new Error("distinguishing sentinel did not commit");
		if (scenarioId === "begin-generation-certificate-match") {
			await stageComplete(store, OBJECT, GENERATION_A);
			const swapped = await store.swapHead({
				expectedHead: noHead(OBJECT),
				generationId: GENERATION_A,
				objectId: OBJECT,
			});
			if (!swapped.ok) throw new Error("adopted-head seed failed");
			return swapped.value.head;
		}
		if (scenarioId === "put-cached-blob-staged" || scenarioId === "discard-generation-staged") {
			if (!(await begin(store, OBJECT, GENERATION_A)).ok) throw new Error("staged generation seed failed");
		}
		if (scenarioId === "promote-reference-staged") {
			if (!(await begin(store, OBJECT, GENERATION_A)).ok) throw new Error("promotion generation seed failed");
			const digest = must(digestBlob(PAYLOAD_A));
			if (!(await store.putCachedBlob({ bytes: PAYLOAD_A, digest, generationId: GENERATION_A, objectId: OBJECT })).ok)
				throw new Error("promotion blob seed failed");
		}
		if (scenarioId === "complete-generation-empty-recovery") await stageCandidate(store, OBJECT, GENERATION_A);
		if (scenarioId === "swap-head-certificate-match" || scenarioId === "swap-head-fresh-recovery")
			await stageComplete(store, OBJECT, GENERATION_A);
		return noHead(OBJECT);
	} finally {
		await store.close();
	}
}

async function executeOperation(
	store: AheDurableStore,
	scenarioId: string,
	seededHead: ExpectedHead
): Promise<unknown> {
	const digest = must(digestBlob(PAYLOAD_A));
	switch (scenarioId) {
		case "begin-generation-empty":
			return begin(store, OBJECT, GENERATION_A);
		case "begin-generation-certificate-match":
			return begin(store, OBJECT, GENERATION_B, seededHead, PAYLOAD_B);
		case "put-cached-blob-staged":
			return store.putCachedBlob({ bytes: PAYLOAD_A, digest, generationId: GENERATION_A, objectId: OBJECT });
		case "promote-reference-staged":
			return store.promoteReference({ digest, generationId: GENERATION_A, objectId: OBJECT });
		case "complete-generation-empty-recovery":
			return store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT });
		case "swap-head-certificate-match":
		case "swap-head-fresh-recovery":
			return store.swapHead({ expectedHead: noHead(OBJECT), generationId: GENERATION_A, objectId: OBJECT });
		case "discard-generation-staged":
			return store.discardGeneration({ generationId: GENERATION_A, objectId: OBJECT });
		default:
			throw new TypeError(`undeclared Phase 2e6 scenario: ${scenarioId}`);
	}
}

function exactRun(value: unknown): RunMessage {
	if (typeof value !== "object" || value === null) throw new TypeError("invalid run message");
	const candidate = value as Record<string, unknown>;
	if (
		candidate.kind !== "run" ||
		candidate.version !== 1 ||
		typeof candidate.databaseName !== "string" ||
		!(candidate.signal instanceof SharedArrayBuffer) ||
		typeof candidate.edge !== "object" ||
		candidate.edge === null
	)
		throw new TypeError("invalid run message");
	return candidate as unknown as RunMessage;
}

self.addEventListener("message", (event: MessageEvent<unknown>) => {
	void (async (): Promise<void> => {
		let store: AheDurableStore | undefined;
		let lifecycleTrace: Phase2e6DatabaseLifecycleTrace | undefined;
		try {
			const input = exactRun(event.data);
			const seededHead = await seed(input.databaseName, input.edge.scenarioId);
			lifecycleTrace = tracePhase2e6DatabaseLifecycle();
			store = await createPhase2dAheDurableStore({ databaseName: input.databaseName });
			const activeStore = store;
			if (
				input.edge.scenarioId === "begin-generation-certificate-match" ||
				input.edge.scenarioId === "swap-head-certificate-match"
			) {
				const warm = await store.recoverActiveGeneration(OBJECT);
				if (!warm.ok) throw new Error("certificate-match warmup failed");
			}
			const observed = await withPhase2e6SettlementTrace(
				input.edge,
				input.signal,
				(trace, transactionCount) =>
					self.postMessage({
						crossOriginIsolated,
						databaseCreateCountAfterSeed: lifecycleTrace?.createCount,
						databaseDeleteCount: lifecycleTrace?.deleteCount,
						edgeId: input.edge.id,
						kind: "armed",
						seededHead,
						trace,
						transactionCount,
						version: 1,
					}),
				() => executeOperation(activeStore, input.edge.scenarioId, seededHead)
			);
			self.postMessage({
				crossOriginIsolated,
				edgeId: input.edge.id,
				kind: "premature-public-result",
				ok:
					typeof observed.result === "object" &&
					observed.result !== null &&
					Reflect.get(observed.result, "ok") === true,
				trace: observed.trace,
				version: 1,
			});
		} catch (error) {
			self.postMessage({ detail: error instanceof Error ? error.message : String(error), kind: "failure", version: 1 });
		} finally {
			lifecycleTrace?.restore();
			await store?.close();
		}
	})();
});

self.postMessage({ crossOriginIsolated, kind: "ready", version: 1 });
