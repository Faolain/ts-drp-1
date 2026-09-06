import {
	type AheDurableStore,
	decodeGenerationRecordV1,
	digestBlob,
	digestClosure,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	type NoHead,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type StorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import { runStoreContract } from "@ts-drp/storage/contract";

import {
	deletePhase2dDatabase,
	gateNextPhase2dTransactionTerminal,
	type Phase2dTerminalGate,
	probePhase2e3BlobRequestPeak,
	rawPhase2dAliasGenerationRecord,
	rawPhase2dCount,
	rawPhase2dGet,
	rawPhase2dReplaceBlob,
	rawPhase2e2CreateWrongSchema,
	rawPhase2e2Delete,
	rawPhase2e2Put,
	rawPhase2e2Snapshot,
	rawPhase2e3PutMany,
	requestPhase2dVersionchange,
	withFailingGenerationRead,
	withFailingHeadWrite,
	withForcedPhase2dDurability,
	withPhase2dTransactionTrace,
} from "../fixtures/idb-adapter-browser-oracle.js";
import { createPhase2d2aRedStore } from "../fixtures/idb-adapter-red-scaffold.js";

const OBJECT_A = must(parseStorageObjectId(`phase-2d2a-a:${"a".repeat(32)}`));
const OBJECT_B = must(parseStorageObjectId(`phase-2d2a-b:${"b".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("a".repeat(64)));
const GENERATION_X = must(parseGenerationId(`${"a".repeat(63)}f`));
const GENERATION_B = must(parseGenerationId("b".repeat(64)));
const GENERATION_C = must(parseGenerationId("c".repeat(64)));
const GENERATION_D = must(parseGenerationId("d".repeat(64)));
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

async function splitRead(
	store: object,
	method: "readGenerationPage" | "readHead",
	input: unknown
): Promise<StoreResult<unknown>> {
	const callable = Reflect.get(store, method);
	if (typeof callable !== "function") {
		return { ok: false, reason: "SUBSTRATE_FAILURE", cause: new Error("SPLIT_READ_NOT_IMPLEMENTED") };
	}
	return Reflect.apply(callable, store, [input]) as Promise<StoreResult<unknown>>;
}

async function recoverActive(store: object, objectId: StorageObjectId): Promise<StoreResult<unknown>> {
	const callable = Reflect.get(store, "recoverActiveGeneration");
	if (typeof callable !== "function") {
		return { ok: false, reason: "SUBSTRATE_FAILURE", cause: "RECOVERY_NOT_IMPLEMENTED" };
	}
	return Reflect.apply(callable, store, [objectId]) as Promise<StoreResult<unknown>>;
}

type QuiescentStoreView = Readonly<{
	head: ExpectedHead;
	generations: readonly GenerationRecord[];
}>;

// Test-only aggregation at quiescent assertion points. The public pages remain
// independently consistent, and this helper has no whole-state fallback.
async function readStoreView(store: object, objectId: StorageObjectId): Promise<StoreResult<QuiescentStoreView>> {
	const head = await splitRead(store, "readHead", objectId);
	if (!head.ok) return head;
	const generations: GenerationRecord[] = [];
	let cursor: unknown;
	do {
		const page = await splitRead(store, "readGenerationPage", {
			...(cursor === undefined ? {} : { cursor }),
			limit: 128,
			objectId,
		});
		if (!page.ok) return page;
		const value = page.value as { readonly generations: readonly GenerationRecord[]; readonly nextCursor: unknown };
		generations.push(...value.generations);
		cursor = value.nextCursor;
	} while (cursor !== null);
	return { ok: true, value: { head: head.value as ExpectedHead, generations } };
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
		splitRead(store, "readHead", OBJECT_A),
		splitRead(store, "readGenerationPage", { limit: 128, objectId: OBJECT_A }),
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
		const firstState = await readStoreView(store, OBJECT_A);
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
		const secondState = await readStoreView(store, OBJECT_A);
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
		const state = await readStoreView(store, OBJECT_A);
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
			blobReads: traced.calls.filter((call) => call.method === "get" && call.store === "blobs").length,
			peakOutstandingBlobGets: traced.peakOutstandingBlobGets,
			promotionReads: traced.calls.filter((call) => call.method === "get" && call.store === "promotions").length,
			result: traced.result.ok
				? { reason: "OK", state: traced.result.value.state }
				: { reason: traced.result.reason, state: null },
			transactions: traced.transactions,
			unboundedGenerationReads: traced.calls.filter(
				(call) => call.method === "getAll" && call.store === "generations" && call.count === undefined
			).length,
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
		const state = await readStoreView(store, OBJECT_A);
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
		const beforeRetry = await readStoreView(store, OBJECT_A);
		const rowsBeforeRetry = await rawPhase2dCount(name, "objects");
		const retry = await store.swapHead({
			expectedHead: noHead(OBJECT_A),
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		const afterRetry = await readStoreView(store, OBJECT_A);
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

async function runPhase2e1BoundedReads(): Promise<unknown> {
	const name = databaseName("phase-2e1-bounded-reads");
	try {
		const store = await createPhase2d2aRedStore({ databaseName: name });
		const emptyHead = await splitRead(store, "readHead", OBJECT_A);
		const emptyPage = await splitRead(store, "readGenerationPage", { limit: 2, objectId: OBJECT_A });
		await stageComplete(store, OBJECT_A, GENERATION_A);
		const swapped = await store.swapHead({
			expectedHead: noHead(OBJECT_A),
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		if (!swapped.ok) throw new Error(`fixture swap failed: ${swapped.reason}`);
		await beginFrom(store, OBJECT_A, GENERATION_C, swapped.value.head, PAYLOAD_B);
		await beginFrom(store, OBJECT_A, GENERATION_B, swapped.value.head, PAYLOAD_A);

		const firstHead = await splitRead(store, "readHead", OBJECT_A);
		const headValue = firstHead.ok ? firstHead.value : undefined;
		if (typeof headValue === "object" && headValue !== null) Reflect.set(headValue, "revision", 99);
		const secondHead = await splitRead(store, "readHead", OBJECT_A);
		const firstPage = await splitRead(store, "readGenerationPage", { limit: 2, objectId: OBJECT_A });
		const pageValue =
			firstPage.ok && typeof firstPage.value === "object" && firstPage.value !== null ? firstPage.value : undefined;
		const cursor = pageValue === undefined ? undefined : Reflect.get(pageValue, "nextCursor");
		const pageRows = pageValue === undefined ? undefined : Reflect.get(pageValue, "generations");
		if (Array.isArray(pageRows) && typeof pageRows[0] === "object" && pageRows[0] !== null) {
			Reflect.set(pageRows[0], "state", "Discarded");
		}
		const finalPage = await splitRead(store, "readGenerationPage", { cursor, limit: 2, objectId: OBJECT_A });
		const detachedPage = await splitRead(store, "readGenerationPage", { limit: 1, objectId: OBJECT_A });
		const invalidTrace = await withPhase2dTransactionTrace(async () =>
			Promise.all([
				...([0, -1, 1.5, 129] as const).map((limit) =>
					splitRead(store, "readGenerationPage", { limit, objectId: OBJECT_A })
				),
				splitRead(store, "readGenerationPage", { cursor: "not-a-cursor", limit: 1, objectId: OBJECT_A }),
				splitRead(store, "readGenerationPage", { cursor, limit: 1, objectId: OBJECT_B }),
			])
		);
		await store.close();
		return {
			detachedHeadRevision:
				secondHead.ok &&
				typeof secondHead.value === "object" &&
				secondHead.value !== null &&
				Reflect.get(secondHead.value, "revision"),
			detachedPageState:
				detachedPage.ok &&
				typeof detachedPage.value === "object" &&
				detachedPage.value !== null &&
				Array.isArray(Reflect.get(detachedPage.value, "generations"))
					? Reflect.get(Reflect.get(detachedPage.value, "generations")[0] as object, "state")
					: null,
			emptyHead,
			emptyPage,
			finalPage,
			firstHead,
			firstPage,
			invalidBackendCalls: invalidTrace.calls.length,
			invalidReasons: invalidTrace.result.map(reason),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runPhase2e1PhysicalKeyMismatch(): Promise<unknown> {
	const name = databaseName("phase-2e1-physical-key-mismatch");
	try {
		let store = await createPhase2d2aRedStore({ databaseName: name });
		if (!(await begin(store, OBJECT_A, GENERATION_B, PAYLOAD_A)).ok) throw new Error("generation B seed failed");
		if (!(await begin(store, OBJECT_A, GENERATION_C, PAYLOAD_B)).ok) throw new Error("generation C seed failed");
		if (!(await begin(store, OBJECT_A, GENERATION_D, PAYLOAD_A)).ok) throw new Error("generation D seed failed");
		await store.close();
		await rawPhase2dAliasGenerationRecord(name, OBJECT_A, GENERATION_C, GENERATION_A);
		await rawPhase2dAliasGenerationRecord(name, OBJECT_A, GENERATION_D, GENERATION_X);

		store = await createPhase2d2aRedStore({ databaseName: name });
		const page = await splitRead(store, "readGenerationPage", { limit: 1, objectId: OBJECT_A });
		const pageValue = page.ok && typeof page.value === "object" && page.value !== null ? page.value : undefined;
		const publishedRows = pageValue === undefined ? undefined : Reflect.get(pageValue, "generations");
		const publishedGenerationIds = Array.isArray(publishedRows)
			? publishedRows.map((row) => (typeof row === "object" && row !== null ? Reflect.get(row, "generationId") : null))
			: [];
		const cursor = pageValue === undefined ? undefined : Reflect.get(pageValue, "nextCursor");
		const continuation =
			typeof cursor === "string"
				? await splitRead(store, "readGenerationPage", { cursor, limit: 1, objectId: OBJECT_A })
				: undefined;
		const continuationValue =
			continuation?.ok === true && typeof continuation.value === "object" && continuation.value !== null
				? continuation.value
				: undefined;
		const continuationRows =
			continuationValue === undefined ? undefined : Reflect.get(continuationValue, "generations");
		const continuationGenerationIds = Array.isArray(continuationRows)
			? continuationRows.map((row) =>
					typeof row === "object" && row !== null ? Reflect.get(row, "generationId") : null
				)
			: [];
		await store.close();

		const rows = await Promise.all(
			[GENERATION_A, GENERATION_X, GENERATION_B, GENERATION_C, GENERATION_D].map(async (physicalGenerationId) => {
				const row = (await rawPhase2dGet(name, "generations", [OBJECT_A, physicalGenerationId])) as
					| { readonly generationId?: unknown; readonly record?: unknown }
					| undefined;
				const decoded = row?.record instanceof Uint8Array ? decodeGenerationRecordV1(row.record) : undefined;
				return {
					canonicalGenerationId: decoded?.ok === true ? decoded.value.generationId : null,
					physicalGenerationId: row?.generationId ?? null,
				};
			})
		);
		return {
			continuationGenerationIds,
			pageReason: reason(page),
			publishedGenerationIds,
			rowCount: await rawPhase2dCount(name, "generations"),
			rows,
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

type Phase2e2Corruption =
	| "absent-head-target"
	| "closure-mismatch"
	| "malformed-generation"
	| "malformed-head"
	| "multiple-adopted"
	| "non-adopted-head-target"
	| "physical-key-mismatch"
	| "unsupported-generation"
	| "unsupported-head";

function futureVersionEnvelope(v1: Uint8Array): Uint8Array {
	const bytes = new Uint8Array(v1);
	if (bytes.at(-1) !== 2) throw new Error("canonical v1 envelope encoding changed");
	bytes[bytes.length - 1] = 4;
	return bytes;
}

async function seedPhase2e2Journal(
	name: string
): Promise<Readonly<{ adopted: GenerationRecord; staged: GenerationRecord }>> {
	const store = await createPhase2d2aRedStore({ databaseName: name });
	await stageComplete(store, OBJECT_A, GENERATION_A);
	const swapped = await store.swapHead({
		expectedHead: noHead(OBJECT_A),
		generationId: GENERATION_A,
		objectId: OBJECT_A,
	});
	if (!swapped.ok) throw new Error(`fixture swap failed: ${swapped.reason}`);
	const staged = await beginFrom(store, OBJECT_A, GENERATION_B, swapped.value.head, PAYLOAD_B);
	if (!staged.ok) throw new Error(`fixture staging failed: ${staged.reason}`);
	await store.close();
	const adoptedRow = (await rawPhase2dGet(name, "generations", [OBJECT_A, GENERATION_A])) as
		| { readonly record?: unknown }
		| undefined;
	if (!(adoptedRow?.record instanceof Uint8Array)) throw new Error("missing adopted fixture row");
	const adopted = decodeGenerationRecordV1(adoptedRow.record);
	if (!adopted.ok) throw new Error(`invalid adopted fixture row: ${adopted.reason}`);
	return { adopted: adopted.value, staged: staged.value };
}

async function corruptPhase2e2Journal(
	name: string,
	corruption: Phase2e2Corruption,
	fixture: Readonly<{ adopted: GenerationRecord; staged: GenerationRecord }>
): Promise<void> {
	switch (corruption) {
		case "unsupported-generation":
			await rawPhase2e2Put(name, "generations", {
				generationId: GENERATION_B,
				objectId: OBJECT_A,
				record: futureVersionEnvelope(encodeGenerationRecordV1(fixture.staged)),
			});
			return;
		case "unsupported-head":
			await rawPhase2e2Put(name, "objects", {
				objectId: OBJECT_A,
				record: futureVersionEnvelope(
					encodeHeadRecordV1({
						closureDigest: fixture.adopted.closureDigest,
						generationId: GENERATION_A,
						kind: "present",
						objectId: OBJECT_A,
						revision: must(parseHeadRevision(1)),
					})
				),
			});
			return;
		case "malformed-generation":
			await rawPhase2e2Put(name, "generations", {
				generationId: GENERATION_B,
				objectId: OBJECT_A,
				record: Uint8Array.of(255),
			});
			return;
		case "malformed-head":
			await rawPhase2e2Put(name, "objects", { objectId: OBJECT_A, record: Uint8Array.of(255) });
			return;
		case "absent-head-target":
			await rawPhase2e2Delete(name, "generations", [OBJECT_A, GENERATION_A]);
			return;
		case "non-adopted-head-target":
			await rawPhase2e2Put(name, "generations", {
				generationId: GENERATION_A,
				objectId: OBJECT_A,
				record: encodeGenerationRecordV1({ ...fixture.adopted, state: "Complete" }),
			});
			return;
		case "closure-mismatch":
			await rawPhase2e2Put(name, "objects", {
				objectId: OBJECT_A,
				record: encodeHeadRecordV1({
					closureDigest: fixture.staged.closureDigest,
					generationId: GENERATION_A,
					kind: "present",
					objectId: OBJECT_A,
					revision: must(parseHeadRevision(1)),
				}),
			});
			return;
		case "multiple-adopted":
			await rawPhase2e2Put(name, "generations", {
				generationId: GENERATION_B,
				objectId: OBJECT_A,
				record: encodeGenerationRecordV1({ ...fixture.staged, state: "Adopted" }),
			});
			return;
		case "physical-key-mismatch":
			await rawPhase2e2Put(name, "generations", {
				generationId: GENERATION_C,
				objectId: OBJECT_A,
				record: encodeGenerationRecordV1(fixture.staged),
			});
	}
}

function phase2e2MutationTouch(
	store: AheDurableStore,
	generationId = GENERATION_C
): Promise<StoreResult<GenerationRecord>> {
	return begin(store, OBJECT_A, generationId, Uint8Array.of(7));
}

async function runPhase2e2TaxonomyMatrix(): Promise<unknown> {
	const results: unknown[] = [];
	for (const [corruption, expected] of [
		["unsupported-generation", "UNSUPPORTED_STORAGE_SCHEMA"],
		["unsupported-head", "UNSUPPORTED_STORAGE_SCHEMA"],
		["malformed-generation", "NON_CANONICAL_RECORD"],
		["malformed-head", "NON_CANONICAL_RECORD"],
		["absent-head-target", "NON_CANONICAL_RECORD"],
		["non-adopted-head-target", "NON_CANONICAL_RECORD"],
		["closure-mismatch", "NON_CANONICAL_RECORD"],
		["multiple-adopted", "NON_CANONICAL_RECORD"],
		["physical-key-mismatch", "NON_CANONICAL_RECORD"],
	] as const) {
		const name = databaseName(`phase-2e2-${corruption}`);
		try {
			const fixture = await seedPhase2e2Journal(name);
			await corruptPhase2e2Journal(name, corruption, fixture);
			const before = await rawPhase2e2Snapshot(name);
			const store = await createPhase2d2aRedStore({ databaseName: name });
			const result = await recoverActive(store, OBJECT_A);
			await store.close();
			results.push({
				corruption,
				expected,
				reason: reason(result),
				zeroWrites: deepBytesEqual(before, await rawPhase2e2Snapshot(name)),
			});
		} finally {
			await deletePhase2dDatabase(name);
		}
	}
	return results;
}

function deepBytesEqual(left: unknown, right: unknown): boolean {
	if (left instanceof Uint8Array && right instanceof Uint8Array) return bytesEqual(left, right);
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, index) => deepBytesEqual(value, right[index]));
	}
	if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
		const leftRecord = left as Record<string, unknown>;
		const rightRecord = right as Record<string, unknown>;
		const keys = Object.keys(leftRecord);
		return (
			keys.length === Object.keys(rightRecord).length &&
			keys.every((key) => deepBytesEqual(leftRecord[key], rightRecord[key]))
		);
	}
	return Object.is(left, right);
}

async function runPhase2e2PoisonLifecycle(): Promise<unknown> {
	const name = databaseName("phase-2e2-poison-lifecycle");
	try {
		const fixture = await seedPhase2e2Journal(name);
		await corruptPhase2e2Journal(name, "malformed-generation", fixture);
		const before = await rawPhase2e2Snapshot(name);
		const store = await createPhase2d2aRedStore({ databaseName: name });
		const first = recoverActive(store, OBJECT_A);
		const queued = recoverActive(store, OBJECT_A);
		const firstResult = await first;
		const queuedResult = await queued;
		const later = await splitRead(store, "readHead", OBJECT_A);
		const zeroWrites = deepBytesEqual(before, await rawPhase2e2Snapshot(name));
		await store.close();
		await store.close();
		const afterClose = await splitRead(store, "readHead", OBJECT_A);
		return {
			afterClose: reason(afterClose),
			first: reason(firstResult),
			later: reason(later),
			queued: reason(queuedResult),
			zeroWrites,
		};
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runPhase2e2Controls(): Promise<unknown> {
	const name = databaseName("phase-2e2-controls");
	try {
		const store = await createPhase2d2aRedStore({ databaseName: name });
		const before = await rawPhase2e2Snapshot(name);
		const invalid = (await Reflect.apply(store.beginGeneration, store, [{}])) as StoreResult<unknown>;
		const invalidZeroWrites = deepBytesEqual(before, await rawPhase2e2Snapshot(name));
		const valid = await phase2e2MutationTouch(store, GENERATION_A);
		const beforeSubstrate = await rawPhase2e2Snapshot(name);
		const substrate = await withFailingGenerationRead(() => recoverActive(store, OBJECT_A));
		const substrateZeroWrites = deepBytesEqual(beforeSubstrate, await rawPhase2e2Snapshot(name));
		await store.close();
		return {
			invalid: reason(invalid),
			invalidZeroWrites,
			substrate: reason(substrate),
			substrateZeroWrites,
			valid: reason(valid),
		};
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runPhase2e2OpenFailure(): Promise<unknown> {
	const name = databaseName("phase-2e2-open-failure");
	try {
		await rawPhase2e2CreateWrongSchema(name);
		let handle: AheDurableStore | undefined;
		let failureReason: unknown;
		try {
			handle = await createPhase2d2aRedStore({ databaseName: name });
		} catch (error) {
			failureReason = Reflect.get(Object(error), "reason");
		}
		await handle?.close();
		return { handleReturned: handle !== undefined, reason: failureReason };
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function seedPhase2e3Adopted(name: string): Promise<Readonly<{ adopted: GenerationRecord; head: ExpectedHead }>> {
	const store = await createPhase2d2aRedStore({ databaseName: name });
	await stageComplete(store, OBJECT_A, GENERATION_A);
	const swapped = await store.swapHead({
		expectedHead: noHead(OBJECT_A),
		generationId: GENERATION_A,
		objectId: OBJECT_A,
	});
	if (!swapped.ok) throw new Error(`Phase 2e3 fixture swap failed: ${swapped.reason}`);
	await store.close();
	const row = (await rawPhase2dGet(name, "generations", [OBJECT_A, GENERATION_A])) as
		| { readonly record?: unknown }
		| undefined;
	if (!(row?.record instanceof Uint8Array)) throw new Error("Phase 2e3 adopted row missing");
	const decoded = decodeGenerationRecordV1(row.record);
	if (!decoded.ok) throw new Error(`Phase 2e3 adopted row invalid: ${decoded.reason}`);
	return { adopted: decoded.value, head: swapped.value.head };
}

async function runPhase2e3RecoveryShapes(): Promise<unknown> {
	const emptyName = databaseName("phase-2e3-empty");
	const activeName = databaseName("phase-2e3-active");
	try {
		const emptyStore = await createPhase2d2aRedStore({ databaseName: emptyName });
		const empty = await recoverActive(emptyStore, OBJECT_A);
		await emptyStore.close();

		const fixture = await seedPhase2e3Adopted(activeName);
		const activeStore = await createPhase2d2aRedStore({ databaseName: activeName });
		const first = await recoverActive(activeStore, OBJECT_A);
		if (first.ok) {
			try {
				const references = Reflect.get(first.value as object, "references");
				if (Array.isArray(references)) references.splice(0);
			} catch {
				// Deeply frozen output is an equally valid detachment boundary.
			}
		}
		const second = await recoverActive(activeStore, OBJECT_A);
		await activeStore.close();
		return { empty, expected: fixture, first, second };
	} finally {
		await deletePhase2dDatabase(emptyName);
		await deletePhase2dDatabase(activeName);
	}
}

async function runPhase2e3MultiPageRecovery(): Promise<unknown> {
	const name = databaseName("phase-2e3-multi-page");
	try {
		const created = await createPhase2d2aRedStore({ databaseName: name });
		await created.close();
		const payload = Uint8Array.of(42);
		const reference = { byteLength: payload.byteLength, digest: must(digestBlob(payload)) };
		const closureDigest = must(digestClosure([reference]));
		const rows: unknown[] = [];
		for (let index = 0; index < 130; index++) {
			const generationId = must(parseGenerationId((index + 16).toString(16).padStart(64, "0")));
			const generation: GenerationRecord = {
				baseExpectedHead: noHead(OBJECT_A),
				closure: [reference],
				closureDigest,
				generationId,
				objectId: OBJECT_A,
				state: "Discarded",
			};
			rows.push({ generationId, objectId: OBJECT_A, record: encodeGenerationRecordV1(generation) });
		}
		await rawPhase2e3PutMany(name, "generations", rows);
		const store = await createPhase2d2aRedStore({ databaseName: name });
		const traced = await withPhase2dTransactionTrace(async (mark) => {
			mark("recoverActiveGeneration");
			return recoverActive(store, OBJECT_A);
		});
		await store.close();
		return {
			generationReads: traced.calls.filter(
				(call) => call.operation === "recoverActiveGeneration" && call.store === "generations"
			),
			result: traced.result,
			transactions: traced.transactions.filter((transaction) => transaction.operation === "recoverActiveGeneration"),
		};
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runPhase2e3AuthorityGap(): Promise<unknown> {
	const name = databaseName("phase-2e3-authority-gap");
	try {
		const fixture = await seedPhase2e3Adopted(name);
		if (fixture.head.kind !== "present") throw new Error("Phase 2e3 head fixture missing");
		const headFive = { ...fixture.head, revision: must(parseHeadRevision(5)) };
		await rawPhase2e2Put(name, "objects", { objectId: OBJECT_A, record: encodeHeadRecordV1(headFive) });

		const staging = await createPhase2d2aRedStore({ databaseName: name });
		await stageComplete(staging, OBJECT_A, GENERATION_B, PAYLOAD_B, headFive);
		await staging.close();
		await rawPhase2e2Delete(name, "objects", OBJECT_A);

		const before = await rawPhase2e2Snapshot(name);
		const store = await createPhase2d2aRedStore({ databaseName: name });
		const traced = await withPhase2dTransactionTrace(async (mark) => {
			mark("swapHead-authority-gap");
			return store.swapHead({
				expectedHead: noHead(OBJECT_A),
				generationId: GENERATION_B,
				objectId: OBJECT_A,
			});
		});
		const afterRoot = await splitRead(store, "readHead", OBJECT_A);
		await store.close();
		return {
			afterRoot: reason(afterRoot),
			boundedGenerationReads: traced.calls.filter(
				(call) =>
					call.operation === "swapHead-authority-gap" && call.store === "generations" && call.count !== undefined
			).length,
			blobReads: traced.calls.filter(
				(call) => call.operation === "swapHead-authority-gap" && call.store === "blobs" && call.method === "get"
			).length,
			reason: reason(traced.result),
			transactions: traced.transactions.filter((transaction) => transaction.operation === "swapHead-authority-gap"),
			writes: traced.calls.filter(
				(call) => call.operation === "swapHead-authority-gap" && (call.method === "add" || call.method === "put")
			),
			zeroWrites: deepBytesEqual(before, await rawPhase2e2Snapshot(name)),
		};
	} finally {
		await deletePhase2dDatabase(name);
	}
}

async function runPhase2e3VerifierMatrix(): Promise<unknown> {
	const candidate: unknown[] = [];
	for (const [damage, replacement, expected] of [
		["missing", null, "BLOB_MISSING"],
		["wrong-length", Uint8Array.of(9), "BLOB_CORRUPT"],
		["wrong-digest", Uint8Array.of(9, 8, 7, 6), "BLOB_CORRUPT"],
		["wrong-type", "not-bytes", "BLOB_CORRUPT"],
	] as const) {
		const name = databaseName(`phase-2e3-candidate-${damage}`);
		try {
			let store = await createPhase2d2aRedStore({ databaseName: name });
			const begun = await begin(store, OBJECT_A, GENERATION_A, PAYLOAD_A);
			if (!begun.ok) throw new Error(`candidate begin failed: ${begun.reason}`);
			if (
				!(
					await store.putCachedBlob({
						bytes: PAYLOAD_A,
						digest: DIGEST_A,
						generationId: GENERATION_A,
						objectId: OBJECT_A,
					})
				).ok
			)
				throw new Error("candidate cache failed");
			if (!(await store.promoteReference({ digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT_A })).ok)
				throw new Error("candidate promotion failed");
			await store.close();
			if (replacement === null) await rawPhase2e2Delete(name, "blobs", DIGEST_A);
			else await rawPhase2e2Put(name, "blobs", { bytes: replacement, digest: DIGEST_A });
			const before = await rawPhase2e2Snapshot(name);
			store = await createPhase2d2aRedStore({ databaseName: name });
			const traced = await withPhase2dTransactionTrace(async (mark) => {
				mark("completeGeneration-reverify");
				return store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A });
			});
			const later = await splitRead(store, "readHead", OBJECT_A);
			await store.close();
			candidate.push({
				blobReads: traced.calls.filter(
					(call) => call.operation === "completeGeneration-reverify" && call.store === "blobs" && call.method === "get"
				).length,
				damage,
				expected,
				later: reason(later),
				reason: reason(traced.result),
				zeroWrites: deepBytesEqual(before, await rawPhase2e2Snapshot(name)),
			});
		} finally {
			await deletePhase2dDatabase(name);
		}
	}
	const incrementalName = databaseName("phase-2e3-incremental");
	let incremental: unknown;
	try {
		let store = await createPhase2d2aRedStore({ databaseName: incrementalName });
		const begun = await store.beginGeneration({
			baseExpectedHead: noHead(OBJECT_A),
			closure: [
				{ byteLength: PAYLOAD_A.byteLength, digest: DIGEST_A },
				{ byteLength: PAYLOAD_B.byteLength, digest: DIGEST_B },
			],
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		if (!begun.ok) throw new Error(`incremental begin failed: ${begun.reason}`);
		for (const [digest, payload] of [
			[DIGEST_A, PAYLOAD_A],
			[DIGEST_B, PAYLOAD_B],
		] as const) {
			if (!(await store.putCachedBlob({ bytes: payload, digest, generationId: GENERATION_A, objectId: OBJECT_A })).ok)
				throw new Error("incremental cache failed");
			if (!(await store.promoteReference({ digest, generationId: GENERATION_A, objectId: OBJECT_A })).ok)
				throw new Error("incremental promotion failed");
		}
		await store.close();
		await rawPhase2e2Delete(incrementalName, "blobs", DIGEST_B);
		store = await createPhase2d2aRedStore({ databaseName: incrementalName });
		const traced = await withPhase2dTransactionTrace(async (mark) => {
			mark("completeGeneration-incremental");
			return store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A });
		});
		await store.close();
		const mutant = await withPhase2dTransactionTrace(async (mark) => {
			mark("batched-blob-mutant");
			return probePhase2e3BlobRequestPeak(incrementalName, [DIGEST_A, DIGEST_B], true);
		});
		incremental = {
			blobKeys: traced.calls
				.filter(
					(call) =>
						call.operation === "completeGeneration-incremental" && call.store === "blobs" && call.method === "get"
				)
				.map(({ key }) => key),
			expectedKeys: [DIGEST_A, DIGEST_B],
			mutantPeak: mutant.peakOutstandingBlobGets,
			peak: traced.peakOutstandingBlobGets,
			reason: reason(traced.result),
			writes: traced.calls.filter(
				(call) =>
					call.operation === "completeGeneration-incremental" && (call.method === "add" || call.method === "put")
			),
		};
	} finally {
		await deletePhase2dDatabase(incrementalName);
	}
	const adopted: unknown[] = [];
	for (const [damage, expected] of [
		["unpromoted", "ADOPTED_BLOB_UNPROMOTED"],
		["missing", "ADOPTED_BLOB_MISSING"],
		["corrupt", "ADOPTED_BLOB_CORRUPT"],
	] as const) {
		const name = databaseName(`phase-2e3-adopted-${damage}`);
		try {
			await seedPhase2e3Adopted(name);
			if (damage === "unpromoted") {
				await rawPhase2e2Delete(name, "promotions", [OBJECT_A, GENERATION_A, DIGEST_A]);
			} else if (damage === "missing") {
				await rawPhase2e2Delete(name, "blobs", DIGEST_A);
			} else {
				await rawPhase2e2Put(name, "blobs", { bytes: Uint8Array.of(0), digest: DIGEST_A });
			}
			const before = await rawPhase2e2Snapshot(name);
			const store = await createPhase2d2aRedStore({ databaseName: name });
			const first = await recoverActive(store, OBJECT_A);
			const later = await recoverActive(store, OBJECT_A);
			const zeroWrites = deepBytesEqual(before, await rawPhase2e2Snapshot(name));
			await store.close();
			const afterClose = await recoverActive(store, OBJECT_A);
			adopted.push({
				afterClose: reason(afterClose),
				damage,
				expected,
				first: reason(first),
				later: reason(later),
				zeroWrites,
			});
		} finally {
			await deletePhase2dDatabase(name);
		}
	}
	return { adopted, candidate, incremental };
}

async function runPhase2e4LifecycleMatrix(): Promise<unknown> {
	const explicitName = databaseName("phase-2e4-explicit-reopen");
	const concurrentName = databaseName("phase-2e4-concurrent");
	const completionName = databaseName("phase-2e4-completion");
	const substrateName = databaseName("phase-2e4-substrate");
	try {
		await seedPhase2e3Adopted(explicitName);
		let explicitStore = await createPhase2d2aRedStore({ databaseName: explicitName });
		const initial = await recoverActive(explicitStore, OBJECT_A);
		await rawPhase2e2Put(explicitName, "blobs", { bytes: Uint8Array.of(0), digest: DIGEST_A });
		const unchangedHeadRoot = await recoverActive(explicitStore, OBJECT_A);
		const poisoned = await recoverActive(explicitStore, OBJECT_A);
		await explicitStore.close();
		const closed = await recoverActive(explicitStore, OBJECT_A);
		explicitStore = await createPhase2d2aRedStore({ databaseName: explicitName });
		const reopenedRoot = await recoverActive(explicitStore, OBJECT_A);
		await explicitStore.close();
		await rawPhase2e2Put(explicitName, "blobs", { bytes: PAYLOAD_A, digest: DIGEST_A });
		const repaired = await createPhase2d2aRedStore({ databaseName: explicitName });
		const repairedResult = await recoverActive(repaired, OBJECT_A);
		await repaired.close();

		const firstHead = await seedPhase2e3Adopted(concurrentName);
		const first = await createPhase2d2aRedStore({ databaseName: concurrentName });
		const second = await createPhase2d2aRedStore({ databaseName: concurrentName });
		await recoverActive(first, OBJECT_A);
		await stageComplete(second, OBJECT_A, GENERATION_B, PAYLOAD_B, firstHead.head);
		const advanced = await second.swapHead({
			expectedHead: firstHead.head,
			generationId: GENERATION_B,
			objectId: OBJECT_A,
		});
		if (!advanced.ok) throw new Error(`Phase 2e4 concurrent advance failed: ${advanced.reason}`);
		await rawPhase2e2Delete(concurrentName, "promotions", [OBJECT_A, GENERATION_B, DIGEST_B]);
		const beforeStale = await rawPhase2e2Snapshot(concurrentName);
		const staleTrace = await withPhase2dTransactionTrace(async (mark) => {
			mark("phase2e4-stale-certificate");
			return beginFrom(first, OBJECT_A, GENERATION_C, firstHead.head, Uint8Array.of(7));
		});
		const staleLater = await splitRead(first, "readHead", OBJECT_A);
		await first.close();
		await second.close();

		const completion = await createPhase2d2aRedStore({ databaseName: completionName });
		const begun = await begin(completion, OBJECT_A, GENERATION_A);
		if (!begun.ok) throw new Error(`Phase 2e4 completion begin failed: ${begun.reason}`);
		const cached = await completion.putCachedBlob({
			bytes: PAYLOAD_A,
			digest: DIGEST_A,
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		if (!cached.ok) throw new Error(`Phase 2e4 completion cache failed: ${cached.reason}`);
		const beforePromotion = await completion.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A });
		const promoted = await completion.promoteReference({
			digest: DIGEST_A,
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		const afterPromotion = await completion.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A });
		await completion.close();

		const substrate = await createPhase2d2aRedStore({ databaseName: substrateName });
		const substrateBegun = await begin(substrate, OBJECT_A, GENERATION_A);
		if (!substrateBegun.ok) throw new Error(`Phase 2e4 substrate begin failed: ${substrateBegun.reason}`);
		await substrate.putCachedBlob({
			bytes: PAYLOAD_A,
			digest: DIGEST_A,
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		await substrate.promoteReference({ digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT_A });
		await recoverActive(substrate, OBJECT_A);
		const substrateFailure = await withFailingGenerationRead(() => recoverActive(substrate, OBJECT_A));
		const substrateRetryTrace = await withPhase2dTransactionTrace(async (mark) => {
			mark("phase2e4-substrate-retry");
			return substrate.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A });
		});
		const substrateLater = await splitRead(substrate, "readHead", OBJECT_A);
		await substrate.close();

		return {
			completion: {
				afterPromotion: reason(afterPromotion),
				beforePromotion: reason(beforePromotion),
				promoted: reason(promoted),
			},
			concurrent: {
				later: reason(staleLater),
				reason: reason(staleTrace.result),
				recoveryPages: staleTrace.calls.filter(
					(call) =>
						call.operation === "phase2e4-stale-certificate" && call.store === "generations" && call.method === "getAll"
				).length,
				zeroWrites: deepBytesEqual(beforeStale, await rawPhase2e2Snapshot(concurrentName)),
				writes: staleTrace.calls.filter((call) => call.method === "add" || call.method === "put"),
			},
			explicit: {
				closed: reason(closed),
				initial: reason(initial),
				poisoned: reason(poisoned),
				reopenedRoot: reason(reopenedRoot),
				repaired: reason(repairedResult),
				unchangedHeadRoot: reason(unchangedHeadRoot),
			},
			substrate: {
				failure: reason(substrateFailure),
				later: reason(substrateLater),
				recoveryPages: substrateRetryTrace.calls.filter(
					(call) =>
						call.operation === "phase2e4-substrate-retry" && call.store === "generations" && call.method === "getAll"
				).length,
				retry: reason(substrateRetryTrace.result),
			},
		};
	} finally {
		await Promise.all(
			[explicitName, concurrentName, completionName, substrateName].map((name) => deletePhase2dDatabase(name))
		);
	}
}

async function runPhase2e4PhysicalDamageMatrix(): Promise<unknown> {
	const swaps: unknown[] = [];
	for (const [damage, expected] of [
		["unpromoted", "BLOB_UNPROMOTED"],
		["missing", "BLOB_MISSING"],
		["corrupt", "BLOB_CORRUPT"],
	] as const) {
		const name = databaseName(`phase-2e4-swap-${damage}`);
		try {
			const store = await createPhase2d2aRedStore({ databaseName: name });
			await stageComplete(store, OBJECT_A, GENERATION_A);
			if (damage === "unpromoted") await rawPhase2e2Delete(name, "promotions", [OBJECT_A, GENERATION_A, DIGEST_A]);
			else if (damage === "missing") await rawPhase2e2Delete(name, "blobs", DIGEST_A);
			else await rawPhase2e2Put(name, "blobs", { bytes: Uint8Array.of(0), digest: DIGEST_A });
			const before = await rawPhase2e2Snapshot(name);
			const result = await store.swapHead({
				expectedHead: noHead(OBJECT_A),
				generationId: GENERATION_A,
				objectId: OBJECT_A,
			});
			const later = await splitRead(store, "readHead", OBJECT_A);
			const zeroWrites = deepBytesEqual(before, await rawPhase2e2Snapshot(name));
			if (damage === "unpromoted")
				await rawPhase2e2Put(name, "promotions", {
					digest: DIGEST_A,
					generationId: GENERATION_A,
					objectId: OBJECT_A,
				});
			else await rawPhase2e2Put(name, "blobs", { bytes: PAYLOAD_A, digest: DIGEST_A });
			const retry = reason(
				await store.swapHead({
					expectedHead: noHead(OBJECT_A),
					generationId: GENERATION_A,
					objectId: OBJECT_A,
				})
			);
			await store.close();
			swaps.push({
				damage,
				expected,
				later: reason(later),
				reason: reason(result),
				retry,
				zeroWrites,
			});
		} finally {
			await deletePhase2dDatabase(name);
		}
	}

	const candidateTypeName = databaseName("phase-2e4-candidate-type");
	const adoptedTypeName = databaseName("phase-2e4-adopted-type");
	const nullName = databaseName("phase-2e4-null-head");
	const orphanName = databaseName("phase-2e4-null-head-adopted");
	try {
		const candidate = await createPhase2d2aRedStore({ databaseName: candidateTypeName });
		const begun = await begin(candidate, OBJECT_A, GENERATION_A);
		if (!begun.ok) throw new Error("Phase 2e4 candidate type begin failed");
		await candidate.putCachedBlob({
			bytes: PAYLOAD_A,
			digest: DIGEST_A,
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		await candidate.promoteReference({ digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT_A });
		await rawPhase2e2Put(candidateTypeName, "blobs", { bytes: "not-bytes", digest: DIGEST_A });
		const candidateType = await candidate.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A });
		const candidateLater = await splitRead(candidate, "readHead", OBJECT_A);
		await candidate.close();

		await seedPhase2e3Adopted(adoptedTypeName);
		await rawPhase2e2Put(adoptedTypeName, "blobs", { bytes: "not-bytes", digest: DIGEST_A });
		const adopted = await createPhase2d2aRedStore({ databaseName: adoptedTypeName });
		const adoptedType = await recoverActive(adopted, OBJECT_A);
		const adoptedLater = await recoverActive(adopted, OBJECT_A);
		await adopted.close();

		const nullCreated = await createPhase2d2aRedStore({ databaseName: nullName });
		await nullCreated.close();
		await rawPhase2e2Put(nullName, "objects", { objectId: OBJECT_A, record: null });
		const empty = await createPhase2d2aRedStore({ databaseName: nullName });
		const nullHead = await recoverActive(empty, OBJECT_A);
		await empty.close();

		await seedPhase2e3Adopted(orphanName);
		await rawPhase2e2Put(orphanName, "objects", { objectId: OBJECT_A, record: null });
		const orphan = await createPhase2d2aRedStore({ databaseName: orphanName });
		const survivingAdopted = await recoverActive(orphan, OBJECT_A);
		const orphanLater = await recoverActive(orphan, OBJECT_A);
		await orphan.close();

		return {
			nullRows: {
				empty: reason(nullHead),
				orphanLater: reason(orphanLater),
				survivingAdopted: reason(survivingAdopted),
			},
			swaps,
			wrongTypes: {
				adopted: reason(adoptedType),
				adoptedLater: reason(adoptedLater),
				candidate: reason(candidateType),
				candidateLater: reason(candidateLater),
			},
		};
	} finally {
		await Promise.all(
			[candidateTypeName, adoptedTypeName, nullName, orphanName].map((name) => deletePhase2dDatabase(name))
		);
	}
}

async function runPhase2e4CloseAndPoisonQueue(): Promise<unknown> {
	const closeName = databaseName("phase-2e4-close-recovery");
	const poisonName = databaseName("phase-2e4-poison-queue");
	let gate: Phase2dTerminalGate<StoreResult<unknown>> | undefined;
	try {
		const closeStore = await createPhase2d2aRedStore({ databaseName: closeName });
		gate = gateNextPhase2dTransactionTerminal(() => recoverActive(closeStore, OBJECT_A));
		await gate.started;
		const operation = gate.operation;
		const close = closeStore.close();
		const queuedAfterClose = await splitRead(closeStore, "readHead", OBJECT_A);
		const firstSettlement = await Promise.race([
			close.then(() => "close" as const),
			gate.terminalObserved.then(() => "transaction-terminal" as const),
		]);
		gate.release();
		const operationResult = await operation;
		await close;
		const laterAfterClose = await splitRead(closeStore, "readHead", OBJECT_A);

		const fixture = await seedPhase2e3Adopted(poisonName);
		await rawPhase2e2Delete(poisonName, "promotions", [OBJECT_A, GENERATION_A, DIGEST_A]);
		const poisonStore = await createPhase2d2aRedStore({ databaseName: poisonName });
		const traced = await withPhase2dTransactionTrace(async (mark) => {
			mark("phase2e4-poison-queue");
			return Promise.all([recoverActive(poisonStore, OBJECT_A), recoverActive(poisonStore, OBJECT_A)]);
		});
		const laterPoison = await recoverActive(poisonStore, OBJECT_A);
		await poisonStore.close();
		const authoritativeScans = traced.calls.filter(
			(call) =>
				call.operation === "phase2e4-poison-queue" &&
				((call.store === "objects" && call.method === "get") ||
					(call.store === "generations" && call.method === "getAll"))
		);
		return {
			close: {
				firstSettlement,
				later: reason(laterAfterClose),
				operation: reason(operationResult),
				queued: reason(queuedAfterClose),
			},
			poison: {
				authoritativeScans: authoritativeScans.length,
				fixtureHead: fixture.head,
				later: reason(laterPoison),
				results: traced.result.map(reason),
				writes: traced.calls.filter((call) => call.method === "add" || call.method === "put"),
			},
		};
	} finally {
		gate?.release();
		await Promise.all([deletePhase2dDatabase(closeName), deletePhase2dDatabase(poisonName)]);
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
		const state = await readStoreView(store, OBJECT_A);
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
	runPhase2e1BoundedReads,
	runPhase2e1PhysicalKeyMismatch,
	runPhase2e2Controls,
	runPhase2e2OpenFailure,
	runPhase2e2PoisonLifecycle,
	runPhase2e2TaxonomyMatrix,
	runPhase2e3AuthorityGap,
	runPhase2e3MultiPageRecovery,
	runPhase2e3RecoveryShapes,
	runPhase2e3VerifierMatrix,
	runPhase2e4CloseAndPoisonQueue,
	runPhase2e4LifecycleMatrix,
	runPhase2e4PhysicalDamageMatrix,
	runPersistenceAndCopies,
	runSameDigestDifferentBytes,
	runSharedContract,
	runStrictDurabilityEvidence,
	runSupersedingSwap,
	runVersionchangeClosure,
});

Reflect.set(globalThis, "phase2d2aAdapterHarness", harness);
