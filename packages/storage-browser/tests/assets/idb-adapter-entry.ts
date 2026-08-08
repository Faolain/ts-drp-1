import {
	type AheDurableStore,
	digestBlob,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type GenerationId,
	type GenerationRecord,
	type NoHead,
	parseGenerationId,
	parseStorageObjectId,
	type StorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import { runStoreContract } from "@ts-drp/storage/contract";

import {
	deletePhase2dDatabase,
	rawPhase2dCount,
	rawPhase2dGet,
	rawPhase2dReplaceBlob,
	withFailingHeadWrite,
	withPhase2dTransactionTrace,
} from "../fixtures/idb-adapter-browser-oracle.js";
import { createPhase2d2aRedStore } from "../fixtures/idb-adapter-red-scaffold.js";

const OBJECT_A = must(parseStorageObjectId(`phase-2d2a-a:${"a".repeat(32)}`));
const OBJECT_B = must(parseStorageObjectId(`phase-2d2a-b:${"b".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("a".repeat(64)));
const GENERATION_B = must(parseGenerationId("b".repeat(64)));
const GENERATION_C = must(parseGenerationId("c".repeat(64)));
const PAYLOAD_A = Uint8Array.of(1, 2, 3, 4);
const PAYLOAD_B = Uint8Array.of(9, 8, 7);
const DIGEST_A = must(digestBlob(PAYLOAD_A));

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new TypeError("invalid Phase 2d2a fixture");
	return result.value;
}

function databaseName(label: string): string {
	return `phase-2d2a-${label}-${crypto.randomUUID()}`;
}

function noHead(objectId: StorageObjectId): NoHead {
	return { kind: "none" as const, objectId };
}

function reason(result: StoreResult<unknown>): string {
	return result.ok ? "OK" : result.reason;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function begin(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId,
	payload = PAYLOAD_A
): Promise<StoreResult<GenerationRecord>> {
	const digest = must(digestBlob(payload));
	return store.beginGeneration({
		baseExpectedHead: noHead(objectId),
		closure: [{ byteLength: payload.byteLength, digest }],
		generationId,
		objectId,
	});
}

async function stageComplete(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId,
	payload = PAYLOAD_A
): Promise<void> {
	const digest = must(digestBlob(payload));
	if (!(await begin(store, objectId, generationId, payload)).ok) throw new Error("begin failed");
	if (!(await store.putCachedBlob({ bytes: payload, digest, generationId, objectId })).ok)
		throw new Error("put failed");
	if (!(await store.promoteReference({ digest, generationId, objectId })).ok) throw new Error("promotion failed");
	if (!(await store.completeGeneration({ generationId, objectId })).ok) throw new Error("completion failed");
}

async function runSharedContract(): Promise<unknown> {
	const name = databaseName("contract");
	try {
		try {
			const capabilities = await runStoreContract(() => createPhase2d2aRedStore({ databaseName: name }));
			return { capabilities, ok: true };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error), ok: false };
		}
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runPersistenceAndCopies(): Promise<unknown> {
	const name = databaseName("persistence");
	try {
		let store = await createPhase2d2aRedStore({ databaseName: name });
		await stageComplete(store, OBJECT_A, GENERATION_A);
		const swap = await store.swapHead({
			expectedHead: noHead(OBJECT_A),
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		await store.close();
		store = await createPhase2d2aRedStore({ databaseName: name });
		const firstState = await store.readObjectState(OBJECT_A);
		const firstBlob = await store.getBlob(DIGEST_A);
		const generation = firstState.ok ? firstState.value.generations[0] : undefined;
		const head = firstState.ok ? firstState.value.head : undefined;
		const rawGeneration = (await rawPhase2dGet(name, "generations", [OBJECT_A, GENERATION_A])) as
			| { readonly record?: Uint8Array }
			| undefined;
		const rawHead = (await rawPhase2dGet(name, "objects", OBJECT_A)) as { readonly record?: Uint8Array } | undefined;
		const canonicalGeneration = generation === undefined ? undefined : encodeGenerationRecordV1(generation);
		const canonicalHead = head?.kind === "present" ? encodeHeadRecordV1(head) : undefined;
		if (firstBlob.ok && firstBlob.value !== null) firstBlob.value.fill(0);
		if (firstState.ok) Reflect.set(firstState.value.head, "objectId", OBJECT_B);
		const secondState = await store.readObjectState(OBJECT_A);
		const secondBlob = await store.getBlob(DIGEST_A);
		await store.close();
		return {
			blobDetached: secondBlob.ok && secondBlob.value !== null && bytesEqual(secondBlob.value, PAYLOAD_A),
			generationCanonical:
				rawGeneration?.record instanceof Uint8Array &&
				canonicalGeneration !== undefined &&
				bytesEqual(rawGeneration.record, canonicalGeneration),
			headCanonical:
				rawHead?.record instanceof Uint8Array &&
				canonicalHead !== undefined &&
				bytesEqual(rawHead.record, canonicalHead),
			reopened: reason(secondState) === "OK" && reason(secondBlob) === "OK",
			stateDetached: secondState.ok && secondState.value.head.objectId === OBJECT_A,
			swap: reason(swap),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runClosureIntegrity(): Promise<unknown> {
	const name = databaseName("closure");
	try {
		const store = await createPhase2d2aRedStore({ databaseName: name });
		await begin(store, OBJECT_A, GENERATION_A);
		const missing = await store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A });
		await begin(store, OBJECT_A, GENERATION_B);
		await rawPhase2dReplaceBlob(name, DIGEST_A, Uint8Array.of(99));
		const corrupt = await store.completeGeneration({ generationId: GENERATION_B, objectId: OBJECT_A });
		const state = await store.readObjectState(OBJECT_A);
		await store.close();
		return {
			corrupt: reason(corrupt),
			missing: reason(missing),
			states: state.ok ? state.value.generations.map(({ state: value }) => value) : [],
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runImmutableAndIdempotent(): Promise<unknown> {
	const name = databaseName("immutable");
	try {
		const store = await createPhase2d2aRedStore({ databaseName: name });
		await begin(store, OBJECT_A, GENERATION_A);
		await begin(store, OBJECT_B, GENERATION_B);
		const same = await Promise.all([
			store.putCachedBlob({ bytes: PAYLOAD_A, digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT_A }),
			store.putCachedBlob({ bytes: PAYLOAD_A, digest: DIGEST_A, generationId: GENERATION_B, objectId: OBJECT_B }),
		]);
		const repeat = await store.putCachedBlob({
			bytes: PAYLOAD_A,
			digest: DIGEST_A,
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		const firstPromotion = await store.promoteReference({
			digest: DIGEST_A,
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		const repeatedPromotion = await store.promoteReference({
			digest: DIGEST_A,
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		await store.close();
		return {
			promotionCount: await rawPhase2dCount(name, "promotions"),
			promotions: [reason(firstPromotion), reason(repeatedPromotion)],
			repeat: repeat.ok ? repeat.value : { reason: repeat.reason },
			same: same.map((result) => (result.ok ? result.value : { reason: result.reason })),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runCompetingCas(): Promise<unknown> {
	const name = databaseName("cas");
	try {
		const store = await createPhase2d2aRedStore({ databaseName: name });
		await stageComplete(store, OBJECT_A, GENERATION_A);
		await stageComplete(store, OBJECT_A, GENERATION_B);
		const swaps = await Promise.all(
			[GENERATION_A, GENERATION_B].map((generationId) =>
				store.swapHead({ expectedHead: noHead(OBJECT_A), generationId, objectId: OBJECT_A })
			)
		);
		const state = await store.readObjectState(OBJECT_A);
		await store.close();
		return {
			adopted: state.ok ? state.value.generations.filter(({ state: value }) => value === "Adopted").length : 0,
			complete: state.ok ? state.value.generations.filter(({ state: value }) => value === "Complete").length : 0,
			outcomes: swaps.map(reason).sort(),
			revision: state.ok && state.value.head.kind === "present" ? state.value.head.revision : null,
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runAtomicRollback(): Promise<unknown> {
	const name = databaseName("rollback");
	try {
		const store = await createPhase2d2aRedStore({ databaseName: name });
		await stageComplete(store, OBJECT_A, GENERATION_A);
		const result = await withFailingHeadWrite(() =>
			store.swapHead({
				expectedHead: noHead(OBJECT_A),
				generationId: GENERATION_A,
				objectId: OBJECT_A,
			})
		);
		const state = await store.readObjectState(OBJECT_A);
		await store.close();
		return {
			generationState: state.ok ? state.value.generations[0]?.state : null,
			head: state.ok ? state.value.head.kind : null,
			objectRows: await rawPhase2dCount(name, "objects"),
			reason: reason(result),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runSameDigestDifferentBytes(): Promise<unknown> {
	const name = databaseName("conflict");
	try {
		const store = await createPhase2d2aRedStore({ databaseName: name });
		await begin(store, OBJECT_A, GENERATION_A);
		await begin(store, OBJECT_B, GENERATION_B);
		const outcomes = await Promise.all([
			store.putCachedBlob({ bytes: PAYLOAD_A, digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT_A }),
			store.putCachedBlob({ bytes: PAYLOAD_B, digest: DIGEST_A, generationId: GENERATION_B, objectId: OBJECT_B }),
		]);
		const stored = await store.getBlob(DIGEST_A);
		await store.close();
		return {
			immutableConflicts: outcomes.filter((result) => !result.ok && result.reason === "IMMUTABLE_CONFLICT").length,
			insertions: outcomes.filter((result) => result.ok && result.value.inserted).length,
			storedIsWinner:
				stored.ok &&
				stored.value !== null &&
				(bytesEqual(stored.value, PAYLOAD_A) || bytesEqual(stored.value, PAYLOAD_B)),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runOwnershipTrace(): Promise<unknown> {
	const name = databaseName("ownership");
	try {
		const store = await createPhase2d2aRedStore({ databaseName: name });
		const { calls, transactions } = await withPhase2dTransactionTrace(async (mark) => {
			mark("readObjectState");
			await store.readObjectState(OBJECT_A);
			mark("getBlob");
			await store.getBlob(DIGEST_A);
			mark("beginGeneration");
			await begin(store, OBJECT_A, GENERATION_C);
			mark("putCachedBlob");
			await store.putCachedBlob({ bytes: PAYLOAD_A, digest: DIGEST_A, generationId: GENERATION_C, objectId: OBJECT_A });
			mark("promoteReference");
			await store.promoteReference({ digest: DIGEST_A, generationId: GENERATION_C, objectId: OBJECT_A });
			mark("completeGeneration");
			await store.completeGeneration({ generationId: GENERATION_C, objectId: OBJECT_A });
			mark("swapHead");
			await store.swapHead({ expectedHead: noHead(OBJECT_A), generationId: GENERATION_C, objectId: OBJECT_A });
		});
		await store.close();
		return {
			reads: calls.filter((call) => call.method === "get" || call.method === "getAll"),
			transactions,
			writes: calls.filter((call) => call.method === "add" || call.method === "put"),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

const harness = Object.freeze({
	runAtomicRollback,
	runClosureIntegrity,
	runCompetingCas,
	runImmutableAndIdempotent,
	runOwnershipTrace,
	runPersistenceAndCopies,
	runSameDigestDifferentBytes,
	runSharedContract,
});

Reflect.set(globalThis, "phase2d2aAdapterHarness", harness);
