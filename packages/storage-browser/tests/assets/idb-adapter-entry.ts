import {
	type AheDurableStore,
	digestBlob,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type ExpectedHead,
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
	gateNextPhase2dTransactionTerminal,
	type Phase2dTerminalGate,
	rawPhase2dCount,
	rawPhase2dGet,
	rawPhase2dReplaceBlob,
	requestPhase2dVersionchange,
	withFailingHeadWrite,
	withForcedPhase2dDurability,
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
const DIGEST_B = must(digestBlob(PAYLOAD_B));

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

function failureCause(result: StoreResult<unknown>): unknown {
	if (result.ok || result.reason !== "SUBSTRATE_FAILURE") return null;
	const candidate = result.cause as { readonly code?: unknown; readonly name?: unknown };
	return {
		code: candidate?.code ?? null,
		name: typeof candidate?.name === "string" ? candidate.name : null,
	};
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
	return beginFrom(store, objectId, generationId, noHead(objectId), payload);
}

function beginFrom(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId,
	baseExpectedHead: ExpectedHead,
	payload = PAYLOAD_A
): Promise<StoreResult<GenerationRecord>> {
	const digest = must(digestBlob(payload));
	return store.beginGeneration({
		baseExpectedHead,
		closure: [{ byteLength: payload.byteLength, digest }],
		generationId,
		objectId,
	});
}

async function stageComplete(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId,
	payload = PAYLOAD_A,
	baseExpectedHead: ExpectedHead = noHead(objectId)
): Promise<void> {
	const digest = must(digestBlob(payload));
	if (!(await beginFrom(store, objectId, generationId, baseExpectedHead, payload)).ok) throw new Error("begin failed");
	if (!(await store.putCachedBlob({ bytes: payload, digest, generationId, objectId })).ok)
		throw new Error("put failed");
	if (!(await store.promoteReference({ digest, generationId, objectId })).ok) throw new Error("promotion failed");
	if (!(await store.completeGeneration({ generationId, objectId })).ok) throw new Error("completion failed");
}

async function operationReasons(store: AheDurableStore): Promise<readonly string[]> {
	const commands = await Promise.all([
		store.readObjectState(OBJECT_A),
		store.getBlob(DIGEST_A),
		begin(store, OBJECT_A, GENERATION_A),
		store.putCachedBlob({ bytes: PAYLOAD_A, digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT_A }),
		store.promoteReference({ digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT_A }),
		store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A }),
		store.swapHead({ expectedHead: noHead(OBJECT_A), generationId: GENERATION_A, objectId: OBJECT_A }),
		store.discardGeneration({ generationId: GENERATION_A, objectId: OBJECT_A }),
	]);
	return commands.map(reason);
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
		const missing = await store.promoteReference({ digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT_A });
		await begin(store, OBJECT_A, GENERATION_B);
		await rawPhase2dReplaceBlob(name, DIGEST_A, Uint8Array.of(99));
		const corrupt = await store.promoteReference({ digest: DIGEST_A, generationId: GENERATION_B, objectId: OBJECT_A });
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

async function runBoundedCompletionTrace(): Promise<unknown> {
	const name = databaseName("bounded-completion");
	try {
		const store = await createPhase2d2aRedStore({ databaseName: name });
		const begun = await store.beginGeneration({
			baseExpectedHead: noHead(OBJECT_A),
			closure: [
				{ byteLength: PAYLOAD_A.byteLength, digest: DIGEST_A },
				{ byteLength: PAYLOAD_B.byteLength, digest: DIGEST_B },
			],
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		if (!begun.ok) throw new Error(`begin failed: ${begun.reason}`);
		for (const [digest, payload] of [
			[DIGEST_A, PAYLOAD_A],
			[DIGEST_B, PAYLOAD_B],
		] as const) {
			const cached = await store.putCachedBlob({
				bytes: payload,
				digest,
				generationId: GENERATION_A,
				objectId: OBJECT_A,
			});
			if (!cached.ok) throw new Error(`cache failed: ${cached.reason}`);
			const promoted = await store.promoteReference({ digest, generationId: GENERATION_A, objectId: OBJECT_A });
			if (!promoted.ok) throw new Error(`promotion failed: ${promoted.reason}`);
		}
		const traced = await withPhase2dTransactionTrace(async (mark) => {
			mark("completeGeneration");
			return store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A });
		});
		await store.close();
		return {
			reads: traced.calls.filter((call) => call.method === "get" || call.method === "getAll"),
			result: traced.result.ok
				? { reason: "OK", state: traced.result.value.state }
				: { reason: traced.result.reason, state: null },
			transactions: traced.transactions,
			writes: traced.calls.filter((call) => call.method === "add" || call.method === "put"),
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
		const beforeRetry = await store.readObjectState(OBJECT_A);
		const rowsBeforeRetry = await rawPhase2dCount(name, "objects");
		const retry = await store.swapHead({
			expectedHead: noHead(OBJECT_A),
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		const afterRetry = await store.readObjectState(OBJECT_A);
		await store.close();
		return {
			afterRetry: {
				generationState: afterRetry.ok ? afterRetry.value.generations[0]?.state : null,
				head: afterRetry.ok ? afterRetry.value.head.kind : null,
				objectRows: await rawPhase2dCount(name, "objects"),
				reason: reason(retry),
				revision: afterRetry.ok && afterRetry.value.head.kind === "present" ? afterRetry.value.head.revision : null,
			},
			beforeRetry: {
				generationState: beforeRetry.ok ? beforeRetry.value.generations[0]?.state : null,
				head: beforeRetry.ok ? beforeRetry.value.head.kind : null,
				objectRows: rowsBeforeRetry,
				reason: reason(result),
			},
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
		await begin(store, OBJECT_A, GENERATION_B);
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
			mark("discardGeneration");
			await store.discardGeneration({ generationId: GENERATION_B, objectId: OBJECT_A });
		});
		await store.close();
		return {
			ranges: calls
				.filter((call) => call.method === "getAll")
				.map(({ operation, query, store }) => ({ operation, query, store })),
			reads: calls
				.filter((call) => call.method === "get" || call.method === "getAll")
				.map(({ method, operation, store }) => ({ method, operation, store })),
			transactions,
			writes: calls.filter((call) => call.method === "add" || call.method === "put"),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runCloseQuiescence(): Promise<unknown> {
	const name = databaseName("close-quiescence");
	let gate: Phase2dTerminalGate<StoreResult<GenerationRecord>> | undefined;
	try {
		const store = await createPhase2d2aRedStore({ databaseName: name });
		gate = gateNextPhase2dTransactionTerminal(() => begin(store, OBJECT_A, GENERATION_A));
		await gate.started;
		const settlementOrder: string[] = [];
		const operation = gate.operation.then((result) => {
			settlementOrder.push("operation");
			return result;
		});
		const close = store.close().then(() => {
			settlementOrder.push("close");
		});
		const firstSettlement = await Promise.race([
			close.then(() => "close" as const),
			gate.terminalObserved.then(() => "transaction-terminal" as const),
		]);
		gate.release();
		const operationResult = await operation;
		await close;
		return {
			firstSettlement,
			operation: reason(operationResult),
			postClose: await operationReasons(store),
			settlementOrder,
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		gate?.release();
		await deletePhase2dDatabase(name);
	}
}

async function runVersionchangeClosure(): Promise<unknown> {
	const name = databaseName("versionchange");
	try {
		const store = await createPhase2d2aRedStore({ databaseName: name });
		await requestPhase2dVersionchange(name, 2);
		const postVersionchange = await operationReasons(store);
		await store.close();
		return { postVersionchange };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runStrictDurabilityEvidence(): Promise<unknown> {
	const scenarios: unknown[] = [];
	for (const [index, observed] of (["default", "relaxed", "strict"] as const).entries()) {
		const name = databaseName(`durability-${observed}`);
		try {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			const generationId = [GENERATION_A, GENERATION_B, GENERATION_C][index];
			if (generationId === undefined) throw new TypeError("missing generation fixture");
			const evidence = await withForcedPhase2dDurability(observed, () => begin(store, OBJECT_A, generationId));
			await store.close();
			scenarios.push({
				cause: failureCause(evidence.result),
				generationRows: await rawPhase2dCount(name, "generations"),
				observed: evidence.observed,
				reason: reason(evidence.result),
				requested: evidence.requested,
				writes: evidence.writes,
			});
		} finally {
			await deletePhase2dDatabase(name);
		}
	}
	return scenarios;
}

async function runSupersedingSwap(): Promise<unknown> {
	const name = databaseName("superseding-swap");
	try {
		const store = await createPhase2d2aRedStore({ databaseName: name });
		await stageComplete(store, OBJECT_A, GENERATION_A);
		const firstSwap = await store.swapHead({
			expectedHead: noHead(OBJECT_A),
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		if (!firstSwap.ok) throw new Error(`first swap failed: ${firstSwap.reason}`);
		await stageComplete(store, OBJECT_A, GENERATION_B, PAYLOAD_B, firstSwap.value.head);
		const traced = await withPhase2dTransactionTrace(async (mark) => {
			mark("swapHeadRevision2");
			return store.swapHead({
				expectedHead: firstSwap.value.head,
				generationId: GENERATION_B,
				objectId: OBJECT_A,
			});
		});
		const state = await store.readObjectState(OBJECT_A);
		await store.close();
		return {
			generations: state.ok
				? state.value.generations.map(({ generationId, state: generationState }) => ({
						generationId,
						state: generationState,
					}))
				: [],
			head:
				state.ok && state.value.head.kind === "present"
					? { generationId: state.value.head.generationId, revision: state.value.head.revision }
					: null,
			result: traced.result.ok
				? { reason: "OK", supersededGenerationId: traced.result.value.supersededGenerationId }
				: { reason: traced.result.reason, supersededGenerationId: null },
			transactions: traced.transactions,
			writes: traced.calls.filter((call) => call.method === "add" || call.method === "put"),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

const harness = Object.freeze({
	runAtomicRollback,
	runBoundedCompletionTrace,
	runCloseQuiescence,
	runClosureIntegrity,
	runCompetingCas,
	runImmutableAndIdempotent,
	runOwnershipTrace,
	runPersistenceAndCopies,
	runSameDigestDifferentBytes,
	runSharedContract,
	runStrictDurabilityEvidence,
	runSupersedingSwap,
	runVersionchangeClosure,
});

Reflect.set(globalThis, "phase2d2aAdapterHarness", harness);
