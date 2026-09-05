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
import { createBrowserAheDurableStore } from "@ts-drp/storage-browser";

import {
	deletePhase2dDatabase,
	rawPhase2dGet,
	rawPhase2e2Delete,
	rawPhase2e2Put,
	rawPhase2e6DatabaseIdentity,
	rawPhase2e6PersistentImage,
	withPhase2e5RequestInventoryTrace,
	withPhase2gQuotaFaultTrace,
} from "./idb-adapter-browser-oracle.js";
import type { Phase2e5ObservedRow } from "./phase-2e5-browser-request-inventory.js";
import {
	derivePhase2gQuotaEdges,
	type Phase2gPhysicalRow,
	phase2gQuotaCaseErrors,
	type Phase2gQuotaCaseEvidence,
	type Phase2gQuotaEdge,
	phase2gQuotaInventoryErrors,
	phase2gRejectedInputErrors,
	type Phase2gRejectedInputEvidence,
	type Phase2gWholeImage,
	PHASE_2G_QUOTA_REQUEST_INVENTORY,
} from "./phase-2g-c-quota-fault-contract.js";

const SUBJECT = must(parseStorageObjectId(`phase-2g-c:${"c".repeat(32)}`));
const UNRELATED = must(parseStorageObjectId(`phase-2g-c-unrelated:${"d".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("a".repeat(64)));
const GENERATION_B = must(parseGenerationId("b".repeat(64)));
const UNRELATED_GENERATION = must(parseGenerationId("d".repeat(64)));
const PAYLOAD_A = Uint8Array.of(1, 3, 5, 7);
const PAYLOAD_B = Uint8Array.of(2, 4, 6, 8, 10);
const UNRELATED_PAYLOAD = Uint8Array.of(91, 92, 93, 94, 95, 96);
const GLOBAL_PAYLOAD = Uint8Array.of(201, 202, 203, 204, 205, 206, 207);
const STORE_NAMES = ["blobs", "generations", "objects", "promotions"] as const;

type PresentHead = Exclude<ExpectedHead, NoHead>;

interface Scenario {
	readonly databaseName: string;
	run(): Promise<StoreResult<unknown>>;
	readonly store: AheDurableStore;
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new TypeError("invalid Phase 2g-c quota instrument fixture");
	return result.value;
}

function noHead(objectId: StorageObjectId): NoHead {
	return { kind: "none", objectId };
}

function outcome(result: StoreResult<unknown>): string {
	return result.ok ? "OK" : result.reason;
}

async function begin(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId,
	payload: Uint8Array,
	baseExpectedHead: ExpectedHead
): Promise<StoreResult<unknown>> {
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
	payload: Uint8Array,
	baseExpectedHead: ExpectedHead
): Promise<void> {
	const digest = must(digestBlob(payload));
	const results = [
		await begin(store, objectId, generationId, payload, baseExpectedHead),
		await store.putCachedBlob({ bytes: payload, digest, generationId, objectId }),
		await store.promoteReference({ digest, generationId, objectId }),
		await store.completeGeneration({ generationId, objectId }),
	];
	const failure = results.find((result) => !result.ok);
	if (failure !== undefined && !failure.ok) throw new Error(`quota scenario seed failed: ${failure.reason}`);
}

async function seedUnrelated(store: AheDurableStore, databaseName: string): Promise<PresentHead> {
	await stageComplete(store, UNRELATED, UNRELATED_GENERATION, UNRELATED_PAYLOAD, noHead(UNRELATED));
	const adopted = await store.swapHead({
		expectedHead: noHead(UNRELATED),
		generationId: UNRELATED_GENERATION,
		objectId: UNRELATED,
	});
	if (!adopted.ok) throw new Error(`unrelated adoption failed: ${adopted.reason}`);
	const recovered = await store.recoverActiveGeneration(UNRELATED);
	if (!recovered.ok) throw new Error(`unrelated recovery certificate failed: ${recovered.reason}`);
	await rawPhase2e2Put(databaseName, "blobs", {
		bytes: new Uint8Array(GLOBAL_PAYLOAD),
		digest: must(digestBlob(GLOBAL_PAYLOAD)),
	});
	return adopted.value.head;
}

function scenarioOperation(
	store: AheDurableStore,
	scenarioId: string,
	presentHead?: PresentHead
): () => Promise<StoreResult<unknown>> {
	const digestA = must(digestBlob(PAYLOAD_A));
	switch (scenarioId) {
		case "begin-generation-empty":
			return () => begin(store, SUBJECT, GENERATION_A, PAYLOAD_A, noHead(SUBJECT));
		case "begin-generation-certificate-match":
			if (presentHead === undefined) throw new Error("certificate-match scenario lacks a present head");
			return () => begin(store, SUBJECT, GENERATION_B, PAYLOAD_B, presentHead);
		case "put-cached-blob-staged":
			return () =>
				store.putCachedBlob({ bytes: PAYLOAD_A, digest: digestA, generationId: GENERATION_A, objectId: SUBJECT });
		case "promote-reference-staged":
			return () => store.promoteReference({ digest: digestA, generationId: GENERATION_A, objectId: SUBJECT });
		case "complete-generation-empty-recovery":
			return () => store.completeGeneration({ generationId: GENERATION_A, objectId: SUBJECT });
		case "swap-head-certificate-match":
		case "swap-head-fresh-recovery":
			return () => store.swapHead({ expectedHead: noHead(SUBJECT), generationId: GENERATION_A, objectId: SUBJECT });
		case "discard-generation-staged":
			return () => store.discardGeneration({ generationId: GENERATION_A, objectId: SUBJECT });
		case "swap-head-present-supersession":
			if (presentHead === undefined) throw new Error("present-head scenario lacks a present head");
			return () => store.swapHead({ expectedHead: presentHead, generationId: GENERATION_B, objectId: SUBJECT });
		default:
			throw new Error(`unknown trace-derived quota scenario: ${scenarioId}`);
	}
}

async function createScenario(scenarioId: string, databaseName: string): Promise<Scenario> {
	let store = await createBrowserAheDurableStore({ databaseName });
	await seedUnrelated(store, databaseName);
	const digestA = must(digestBlob(PAYLOAD_A));
	let presentHead: PresentHead | undefined;
	switch (scenarioId) {
		case "begin-generation-empty":
			break;
		case "begin-generation-certificate-match": {
			await stageComplete(store, SUBJECT, GENERATION_A, PAYLOAD_A, noHead(SUBJECT));
			const adopted = await store.swapHead({
				expectedHead: noHead(SUBJECT),
				generationId: GENERATION_A,
				objectId: SUBJECT,
			});
			if (!adopted.ok) throw new Error(`subject adoption failed: ${adopted.reason}`);
			presentHead = adopted.value.head;
			const recovered = await store.recoverActiveGeneration(SUBJECT);
			if (!recovered.ok) throw new Error(`subject recovery certificate failed: ${recovered.reason}`);
			break;
		}
		case "put-cached-blob-staged":
			await begin(store, SUBJECT, GENERATION_A, PAYLOAD_A, noHead(SUBJECT));
			break;
		case "promote-reference-staged":
			await begin(store, SUBJECT, GENERATION_A, PAYLOAD_A, noHead(SUBJECT));
			await store.putCachedBlob({ bytes: PAYLOAD_A, digest: digestA, generationId: GENERATION_A, objectId: SUBJECT });
			break;
		case "complete-generation-empty-recovery":
			await begin(store, SUBJECT, GENERATION_A, PAYLOAD_A, noHead(SUBJECT));
			await store.putCachedBlob({ bytes: PAYLOAD_A, digest: digestA, generationId: GENERATION_A, objectId: SUBJECT });
			await store.promoteReference({ digest: digestA, generationId: GENERATION_A, objectId: SUBJECT });
			break;
		case "swap-head-certificate-match":
			await stageComplete(store, SUBJECT, GENERATION_A, PAYLOAD_A, noHead(SUBJECT));
			break;
		case "swap-head-fresh-recovery": {
			await stageComplete(store, SUBJECT, GENERATION_A, PAYLOAD_A, noHead(SUBJECT));
			await store.close();
			store = await createBrowserAheDurableStore({ databaseName });
			const recovered = await store.recoverActiveGeneration(UNRELATED);
			if (!recovered.ok) throw new Error(`reopened unrelated recovery certificate failed: ${recovered.reason}`);
			break;
		}
		case "discard-generation-staged":
			await begin(store, SUBJECT, GENERATION_A, PAYLOAD_A, noHead(SUBJECT));
			break;
		case "swap-head-present-supersession": {
			await stageComplete(store, SUBJECT, GENERATION_A, PAYLOAD_A, noHead(SUBJECT));
			const adopted = await store.swapHead({
				expectedHead: noHead(SUBJECT),
				generationId: GENERATION_A,
				objectId: SUBJECT,
			});
			if (!adopted.ok) throw new Error(`present-head first adoption failed: ${adopted.reason}`);
			presentHead = adopted.value.head;
			await stageComplete(store, SUBJECT, GENERATION_B, PAYLOAD_B, presentHead);
			break;
		}
		default:
			await store.close();
			throw new Error(`unknown trace-derived quota scenario: ${scenarioId}`);
	}
	return { databaseName, run: scenarioOperation(store, scenarioId, presentHead), store };
}

async function openExistingScenario(scenarioId: string, databaseName: string): Promise<Scenario> {
	const store = await createBrowserAheDurableStore({ databaseName });
	const headResult =
		scenarioId === "begin-generation-certificate-match" || scenarioId === "swap-head-present-supersession"
			? await store.readHead(SUBJECT)
			: undefined;
	const presentHead = headResult?.ok === true && headResult.value.kind === "present" ? headResult.value : undefined;
	if (headResult !== undefined && presentHead === undefined)
		throw new Error(`existing ${scenarioId} subject head is not present`);
	return { databaseName, run: scenarioOperation(store, scenarioId, presentHead), store };
}

function canonicalPhysical(value: unknown): unknown {
	if (value instanceof Uint8Array) return { $bytes: [...value] };
	if (Array.isArray(value)) return value.map(canonicalPhysical);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, canonicalPhysical(nested)])
	);
}

function physicalHex(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(canonicalPhysical(value)));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rowProperty(row: unknown, key: string): unknown {
	return typeof row === "object" && row !== null ? Reflect.get(row, key) : undefined;
}

function physicalKey(storeName: (typeof STORE_NAMES)[number], row: unknown): unknown {
	switch (storeName) {
		case "blobs":
			return rowProperty(row, "digest");
		case "generations":
			return [rowProperty(row, "objectId"), rowProperty(row, "generationId")];
		case "objects":
			return rowProperty(row, "objectId");
		case "promotions":
			return [rowProperty(row, "objectId"), rowProperty(row, "generationId"), rowProperty(row, "digest")];
	}
}

function physicalRows(
	storeName: (typeof STORE_NAMES)[number],
	rows: readonly unknown[]
): readonly Phase2gPhysicalRow[] {
	return Object.freeze(
		rows.map((row) =>
			Object.freeze({ keyBytesHex: physicalHex(physicalKey(storeName, row)), valueBytesHex: physicalHex(row) })
		)
	);
}

async function rawWholeImage(databaseName: string): Promise<Phase2gWholeImage> {
	if ((await rawPhase2e6DatabaseIdentity(databaseName)) !== databaseName)
		throw new Error("quota oracle did not find one exact schema-v1 database");
	const image = await rawPhase2e6PersistentImage(databaseName);
	return Object.freeze({
		schemaVersion: 1,
		storeCensus: Object.freeze([...STORE_NAMES].sort()),
		stores: Object.freeze({
			blobs: physicalRows("blobs", image.blobs),
			generations: physicalRows("generations", image.generations),
			objects: physicalRows("objects", image.objects),
			promotions: physicalRows("promotions", image.promotions),
		}),
	});
}

async function rawPromotion(databaseName: string): Promise<unknown> {
	const digest = must(digestBlob(UNRELATED_PAYLOAD));
	const value = await rawPhase2dGet(databaseName, "promotions", [UNRELATED, UNRELATED_GENERATION, digest]);
	if (value === undefined) throw new Error("unrelated promotion canary is absent");
	return value;
}

async function replacePromotion(databaseName: string, value: unknown | undefined): Promise<void> {
	const digest = must(digestBlob(UNRELATED_PAYLOAD));
	if (value === undefined)
		await rawPhase2e2Delete(databaseName, "promotions", [UNRELATED, UNRELATED_GENERATION, digest]);
	else await rawPhase2e2Put(databaseName, "promotions", value);
}

async function observeScenario(scenarioId: string): Promise<Phase2e5ObservedRow> {
	const databaseName = `phase-2g-c-observe-${crypto.randomUUID()}`;
	let scenario: Scenario | undefined;
	try {
		scenario = await createScenario(scenarioId, databaseName);
		const trace = await withPhase2e5RequestInventoryTrace(scenario.run);
		for (const request of trace.requests) {
			if (!STORE_NAMES.includes(request.store as (typeof STORE_NAMES)[number]))
				throw new Error(`quota trace observed unknown store: ${request.store}`);
		}
		for (const transaction of trace.transactions) {
			if (
				(transaction.durability !== "default" && transaction.durability !== "strict") ||
				(transaction.mode !== "readonly" && transaction.mode !== "readwrite") ||
				(transaction.requestedDurability !== null && transaction.requestedDurability !== "strict") ||
				(transaction.terminal !== "abort" && transaction.terminal !== "complete") ||
				transaction.stores.some((store) => !STORE_NAMES.includes(store as (typeof STORE_NAMES)[number]))
			)
				throw new Error("quota trace observed transaction metadata outside the declared vocabulary");
		}
		return Object.freeze({
			id: scenarioId,
			requests: trace.requests as Phase2e5ObservedRow["requests"],
			result: outcome(trace.result),
			transactions: trace.transactions as Phase2e5ObservedRow["transactions"],
		});
	} finally {
		await scenario?.store.close();
		await deletePhase2dDatabase(databaseName);
	}
}

async function certificateWasCleared(scenario: Scenario): Promise<boolean> {
	const promotion = await rawPromotion(scenario.databaseName);
	await replacePromotion(scenario.databaseName, undefined);
	try {
		const result = await scenario.store.completeGeneration({
			generationId: UNRELATED_GENERATION,
			objectId: UNRELATED,
		});
		return !result.ok && result.reason === "ADOPTED_BLOB_UNPROMOTED";
	} finally {
		await replacePromotion(scenario.databaseName, promotion);
	}
}

export interface Phase2gQuotaCaseObservation {
	readonly caseEvidence: Phase2gQuotaCaseEvidence;
	readonly recoveredHead: PresentHead;
}

/**
 * Runs one exact derived quota edge through the source-owned Phase 2g-c instrument.
 * @param edge - Exact trace-derived quota edge selected by the caller.
 * @returns Complete case evidence plus the genuine old present head observed after reopen.
 */
export async function runPhase2gQuotaCaseObservation(edge: Phase2gQuotaEdge): Promise<Phase2gQuotaCaseObservation> {
	const faultName = `phase-2g-c-fault-${crypto.randomUUID()}`;
	const expectedName = `phase-2g-c-expected-${crypto.randomUUID()}`;
	let faultScenario: Scenario | undefined;
	let expectedScenario: Scenario | undefined;
	let retryScenario: Scenario | undefined;
	try {
		faultScenario = await createScenario(edge.scenarioId, faultName);
		expectedScenario = await createScenario(edge.scenarioId, expectedName);
		const before = await rawWholeImage(faultName);
		const terminalWriteIndex =
			edge.target === "terminal"
				? PHASE_2G_QUOTA_REQUEST_INVENTORY.find(({ id }) => id === edge.scenarioId)?.requests.findLastIndex(
						({ kind }) => kind === "add" || kind === "put"
					)
				: undefined;
		const faultTrace = await withPhase2gQuotaFaultTrace(
			{ requestIndex: edge.requestIndex, target: edge.target, terminalWriteIndex },
			faultScenario.run
		);
		const stillOpen = await faultScenario.store.readHead(SUBJECT);
		const expectedResult = await expectedScenario.run();
		if (!expectedResult.ok) throw new Error(`isolated expected-new scenario failed: ${expectedResult.reason}`);
		const expectedNew = await rawWholeImage(expectedName);
		await expectedScenario.store.close();
		expectedScenario = undefined;
		const certificateCleared = await certificateWasCleared(faultScenario);
		await faultScenario.store.close();
		faultScenario = undefined;
		const afterReopen = await rawWholeImage(faultName);
		retryScenario = await openExistingScenario(edge.scenarioId, faultName);
		const recovered = await retryScenario.store.readHead(UNRELATED);
		if (!recovered.ok || recovered.value.kind !== "present")
			throw new Error("quota oracle did not recover the old present head after reopen");
		const retryResult = await retryScenario.run();
		const retry = await rawWholeImage(faultName);
		await retryScenario.store.close();
		retryScenario = undefined;
		const cause =
			!faultTrace.result.ok && faultTrace.result.reason === "SUBSTRATE_FAILURE" ? faultTrace.result.cause : undefined;
		const caseEvidence = Object.freeze({
			adapterObservedIdenticalSettlementCause:
				edge.target === "settlement" && cause !== undefined && cause === faultTrace.selectedRequestError,
			afterReopen,
			before,
			causeIsSameObject: cause === faultTrace.fault,
			causeIsSameRealmDOMException: cause instanceof DOMException,
			causeName: cause instanceof DOMException ? cause.name : "",
			edgeId: edge.id,
			expectedNew,
			faultsFired: faultTrace.faultsFired,
			operationReturnedAfterTerminal: faultTrace.operationReturnedAfterTerminal,
			quotaReasonAbsent: !faultTrace.result.ok && faultTrace.result.reason !== ("QUOTA_EXCEEDED" as string),
			resultReason: outcome(faultTrace.result),
			retry,
			retryResult: outcome(retryResult),
			selectedOccurrenceInTrace: faultTrace.selectedOccurrenceInTrace,
			settlementAbortAttributedToRequestError: faultTrace.settlementAbortAttributedToRequestError,
			settlementExplicitHarnessAbortCalls: faultTrace.settlementExplicitHarnessAbortCalls,
			settlementIndependentAbortScheduled: faultTrace.settlementIndependentAbortScheduled,
			settlementNativeRequestFailureObserved: faultTrace.settlementNativeRequestFailureObserved,
			settlementNativeRequestFailureDefaultAllowed: faultTrace.settlementNativeRequestFailureDefaultAllowed,
			settlementRequestErrorBeforeAbortConsequence: faultTrace.settlementRequestErrorBeforeAbortConsequence,
			settlementRequestErrorEvents: faultTrace.settlementRequestErrorEvents,
			settlementRequestErrorIsSameRealmQuotaFault: faultTrace.settlementRequestErrorIsSameRealmQuotaFault,
			settlementRequestReadyStateDoneAtTrustedError: faultTrace.settlementRequestReadyStateDoneAtTrustedError,
			settlementRequestSuccessEvents: faultTrace.settlementRequestSuccessEvents,
			settlementSyntheticDispatchCalls: faultTrace.settlementSyntheticDispatchCalls,
			settlementSyntheticRequestSuccessEvents: faultTrace.settlementSyntheticRequestSuccessEvents,
			settlementTransactionAbortAfterRequestError: faultTrace.settlementTransactionAbortAfterRequestError,
			settlementTransactionAbortAfterTrustedRequestError: faultTrace.settlementTransactionAbortAfterTrustedRequestError,
			settlementTrustedRequestErrorEvents: faultTrace.settlementTrustedRequestErrorEvents,
			settlementTrustedRequestSuccessEvents: faultTrace.settlementTrustedRequestSuccessEvents,
			settlementTrustedTransactionAbortEvents: faultTrace.settlementTrustedTransactionAbortEvents,
			staleRecoveryCertificateCleared: certificateCleared,
			storeRemainedOpenAndUnpoisoned: stillOpen.ok,
		});
		return Object.freeze({ caseEvidence, recoveredHead: recovered.value });
	} finally {
		await faultScenario?.store.close();
		await expectedScenario?.store.close();
		await retryScenario?.store.close();
		await deletePhase2dDatabase(faultName);
		await deletePhase2dDatabase(expectedName);
	}
}

async function rejectedInputEvidence(semantic: boolean): Promise<Phase2gRejectedInputEvidence> {
	const databaseName = `phase-2g-c-rejected-${crypto.randomUUID()}`;
	let scenario: Scenario | undefined;
	try {
		scenario = await createScenario("begin-generation-empty", databaseName);
		const activeScenario = scenario;
		if (semantic) {
			const first = await activeScenario.run();
			if (!first.ok) throw new Error(`semantic rejection seed failed: ${first.reason}`);
		}
		const stagedEdge: Phase2gQuotaEdge = {
			id: "rejected-input/request-02-put-generations/creation",
			requestIndex: 2,
			scenarioId: "rejected-input",
			target: "creation",
		};
		const run: Scenario["run"] = semantic
			? (): Promise<StoreResult<unknown>> =>
					begin(activeScenario.store, SUBJECT, GENERATION_A, PAYLOAD_A, noHead(SUBJECT))
			: (): Promise<StoreResult<unknown>> =>
					activeScenario.store.beginGeneration({
						baseExpectedHead: noHead(SUBJECT),
						closure: [],
						generationId: "not-a-generation" as GenerationId,
						objectId: SUBJECT,
					});
		const trace = await withPhase2gQuotaFaultTrace(
			{ requestIndex: stagedEdge.requestIndex, target: stagedEdge.target },
			run
		);
		return Object.freeze({
			faultArmed: trace.faultArmed,
			faultsFired: trace.faultsFired,
			resultReason: outcome(trace.result),
			writesObserved: trace.writesObserved,
		});
	} finally {
		await scenario?.store.close();
		await deletePhase2dDatabase(databaseName);
	}
}

/**
 * Runs the declared traces and every edge derived from those observations.
 * @returns Complete matrix evidence and all contract mismatches.
 */
export async function runPhase2gDeterministicMatrix(): Promise<
	Readonly<{
		cases: readonly Phase2gQuotaCaseEvidence[];
		errors: readonly string[];
		testInstrumentPresent: boolean;
	}>
> {
	const observed: Phase2e5ObservedRow[] = [];
	for (const row of PHASE_2G_QUOTA_REQUEST_INVENTORY) observed.push(await observeScenario(row.id));
	const errors = [...phase2gQuotaInventoryErrors(observed)];
	const edges = derivePhase2gQuotaEdges(observed);
	const cases: Phase2gQuotaCaseEvidence[] = [];
	for (const edge of edges) {
		const evidence = (await runPhase2gQuotaCaseObservation(edge)).caseEvidence;
		cases.push(evidence);
		errors.push(...phase2gQuotaCaseErrors(edge, evidence).map((error) => `${edge.id}: ${error}`));
	}
	for (const semantic of [false, true]) {
		const evidence = await rejectedInputEvidence(semantic);
		errors.push(
			...phase2gRejectedInputErrors(evidence).map((error) => `rejected-${semantic ? "semantic" : "invalid"}: ${error}`)
		);
	}
	return Object.freeze({
		cases: Object.freeze(cases),
		errors: Object.freeze(errors),
		testInstrumentPresent: observed.length === PHASE_2G_QUOTA_REQUEST_INVENTORY.length && cases.length === edges.length,
	});
}

let engineDatabaseName: string | undefined;

/**
 * Creates the schema before Playwright applies Chromium's origin quota override.
 * @returns Completion after the empty control database is durable and closed.
 */
export async function preparePhase2gEngineQuotaControl(): Promise<void> {
	engineDatabaseName = `phase-2g-c-engine-${crypto.randomUUID()}`;
	const store = await createBrowserAheDurableStore({ databaseName: engineDatabaseName });
	await store.close();
}

/**
 * Performs the bounded real write after Chromium's supported quota override.
 * @param supportedOverrideAttempted - Whether the preceding CDP override call completed successfully.
 * @returns Engine-created quota evidence from the bounded IndexedDB write.
 */
export async function runPhase2gEngineQuotaControl(supportedOverrideAttempted: boolean): Promise<
	Readonly<{
		engineControlPresent: boolean;
		evidence: Readonly<{
			capBytes: number;
			elapsedMilliseconds: number;
			engineGenerated: boolean;
			faultProduced: boolean;
			name: string;
			supportedOverrideAttempted: boolean;
			timeoutMilliseconds: number;
		}>;
	}>
> {
	if (engineDatabaseName === undefined) throw new Error("engine quota database was not prepared before override");
	const started = performance.now();
	const timeoutMilliseconds = 15_000;
	const capBytes = 16 * 1024 * 1024;
	let observed: unknown;
	let store: AheDurableStore | undefined;
	try {
		store = await createBrowserAheDurableStore({ databaseName: engineDatabaseName });
		const result = await begin(store, SUBJECT, GENERATION_A, PAYLOAD_A, noHead(SUBJECT));
		if (!result.ok && result.reason === "SUBSTRATE_FAILURE") observed = result.cause;
	} finally {
		await store?.close();
		await deletePhase2dDatabase(engineDatabaseName);
		engineDatabaseName = undefined;
	}
	const elapsedMilliseconds = performance.now() - started;
	const genuine = observed instanceof DOMException && observed.name === "QuotaExceededError";
	return Object.freeze({
		engineControlPresent: supportedOverrideAttempted && genuine && elapsedMilliseconds <= timeoutMilliseconds,
		evidence: Object.freeze({
			capBytes,
			elapsedMilliseconds,
			engineGenerated: genuine,
			faultProduced: genuine,
			name: observed instanceof DOMException ? observed.name : "",
			supportedOverrideAttempted,
			timeoutMilliseconds,
		}),
	});
}
