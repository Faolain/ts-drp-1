import {
	type AheDurableStore,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestBlob,
	type ExpectedHead,
	type GenerationId,
	parseGenerationId,
	parseStorageObjectId,
	type PresentHead,
	type StorageObjectId,
} from "@ts-drp/storage";

import { createBrowserAheDurableStore } from "../../src/index.js";
import {
	rawPhase2e6DatabaseIdentity,
	rawPhase2e6PersistentImage,
	tracePhase2e6DatabaseLifecycle,
} from "../fixtures/idb-adapter-browser-oracle.js";
import { PHASE_2E6_DECLARED_EDGES } from "../fixtures/phase-2e6-real-process-death-contract.js";

const OBJECT = must(parseStorageObjectId(`phase-2e6-object:${"a".repeat(32)}`));
const SENTINEL_OBJECT = must(parseStorageObjectId(`phase-2e6-sentinel:${"f".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("a".repeat(64)));
const GENERATION_B = must(parseGenerationId("b".repeat(64)));
const SENTINEL_GENERATION = must(parseGenerationId("f".repeat(64)));
const PAYLOAD_A = Uint8Array.of(1, 2, 3, 4);
const PAYLOAD_B = Uint8Array.of(9, 8, 7);

interface WorkerObservation {
	readonly crossOriginIsolated?: boolean;
	readonly detail?: string;
	readonly edgeId?: string;
	readonly instrumented?: boolean;
	readonly kind: string;
	readonly ok?: boolean;
	readonly trace?: readonly unknown[];
	readonly version: number;
}

declare global {
	interface Window {
		phase2e6Relay?(observation: WorkerObservation, cellValue: number): Promise<void>;
		phase2e6Recover(databaseName: string, scenarioId: string, seededHead: ExpectedHead): Promise<unknown>;
		phase2e6RunOne(edge: (typeof PHASE_2E6_DECLARED_EDGES)[number], databaseName: string): Promise<WorkerObservation>;
		phase2e6RunControls(): Promise<unknown>;
	}
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new TypeError("invalid Phase 2e6 fixture");
	return result.value;
}

function noHead(objectId: StorageObjectId): ExpectedHead {
	return { kind: "none", objectId };
}

function plain(value: unknown): unknown {
	if (value instanceof Uint8Array) return [...value];
	if (Array.isArray(value)) return value.map(plain);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, plain(nested)]));
}

function rawHead(image: Awaited<ReturnType<typeof rawPhase2e6PersistentImage>>): ExpectedHead {
	const objectRows = image.objects as readonly Readonly<{ objectId?: unknown; record?: unknown }>[];
	const row = objectRows.find((candidate) => candidate.objectId === OBJECT);
	return row?.record === undefined
		? noHead(OBJECT)
		: must(decodeHeadRecordV1(Uint8Array.from(row.record as readonly number[])));
}

function headToken(head: ExpectedHead): string | null {
	return head.kind === "none"
		? null
		: JSON.stringify({
				closureDigest: head.closureDigest,
				generationId: head.generationId,
				revision: head.revision,
			});
}

function advances(previous: ExpectedHead, next: ExpectedHead): boolean {
	return next.kind === "present" && (previous.kind === "none" || next.revision > previous.revision);
}

function resultReason(result: { readonly ok: true } | { readonly ok: false; readonly reason: string }): string {
	return result.ok ? "OK" : result.reason;
}

async function stageComplete(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId,
	payload: Uint8Array,
	baseExpectedHead: ExpectedHead
): Promise<void> {
	const digest = must(digestBlob(payload));
	const begun = await store.beginGeneration({
		baseExpectedHead,
		closure: [{ byteLength: payload.byteLength, digest }],
		generationId,
		objectId,
	});
	if (!begun.ok) throw new Error(`control begin failed: ${begun.reason}`);
	const blob = await store.putCachedBlob({ bytes: payload, digest, generationId, objectId });
	if (!blob.ok) throw new Error(`control blob failed: ${blob.reason}`);
	const promotion = await store.promoteReference({ digest, generationId, objectId });
	if (!promotion.ok) throw new Error(`control promotion failed: ${promotion.reason}`);
	const complete = await store.completeGeneration({ generationId, objectId });
	if (!complete.ok) throw new Error(`control complete failed: ${complete.reason}`);
}

async function recoverDatabase(databaseName: string, scenarioId: string, seededHead: ExpectedHead): Promise<unknown> {
	const recoveredDatabaseName = await rawPhase2e6DatabaseIdentity(databaseName);
	if (recoveredDatabaseName === null) throw new Error("exact seeded database identity is absent before recovery");
	const lifecycle = tracePhase2e6DatabaseLifecycle();
	let store: AheDurableStore | undefined;
	try {
		store = await createBrowserAheDurableStore({ databaseName });
		const recovery = await store.recoverActiveGeneration(OBJECT);
		const recoveredHeadResult = await store.readHead(OBJECT);
		const sentinelPage = await store.readGenerationPage({ limit: 128, objectId: SENTINEL_OBJECT });
		if (!recovery.ok || !recoveredHeadResult.ok || !sentinelPage.ok)
			throw new Error(
				`fresh recovery failed: ${[recovery, recoveredHeadResult, sentinelPage].map(resultReason).join("/")}`
			);
		const recoveredImage = await rawPhase2e6PersistentImage(databaseName);
		const decodedRawHead = rawHead(recoveredImage);
		const generationRows = recoveredImage.generations as readonly Readonly<{
			generationId?: unknown;
			objectId?: unknown;
			record?: unknown;
		}>[];
		const rawSentinel = generationRows.find(
			(row) => row.objectId === SENTINEL_OBJECT && row.generationId === SENTINEL_GENERATION
		);
		const decodedSentinel =
			rawSentinel?.record === undefined
				? undefined
				: decodeGenerationRecordV1(Uint8Array.from(rawSentinel.record as readonly number[]));
		const publicSentinel = sentinelPage.value.generations.find(
			({ generationId, objectId }) => generationId === SENTINEL_GENERATION && objectId === SENTINEL_OBJECT
		);
		const sentinelRetained =
			decodedSentinel?.ok === true &&
			decodedSentinel.value.state === "Staged" &&
			publicSentinel !== undefined &&
			JSON.stringify(plain(decodedSentinel.value)) === JSON.stringify(plain(publicSentinel));
		const recoveredHead = recoveredHeadResult.value;
		const rawHeadConsistent = headToken(decodedRawHead) === headToken(recoveredHead);
		let head: unknown = {
			kind: "unchanged",
			old: headToken(seededHead),
			recovered: headToken(recoveredHead),
		};
		if (scenarioId.startsWith("swap-head-")) {
			let completeNew: PresentHead;
			let newHeadConsistent: boolean;
			if (recoveredHead.kind === "none") {
				const retry = await store.swapHead({
					expectedHead: recoveredHead,
					generationId: GENERATION_A,
					objectId: OBJECT,
				});
				if (!retry.ok) throw new Error(`old-state swap retry failed: ${retry.reason}`);
				completeNew = retry.value.head;
				const retryHead = await store.readHead(OBJECT);
				const retryRecovery = await store.recoverActiveGeneration(OBJECT);
				const retryRawHead = rawHead(await rawPhase2e6PersistentImage(databaseName));
				newHeadConsistent =
					retryHead.ok &&
					retryRecovery.ok &&
					retryRecovery.value.kind === "active" &&
					headToken(retry.value.head) === headToken(retryHead.value) &&
					headToken(retry.value.head) === headToken(retryRecovery.value.head) &&
					headToken(retry.value.head) === headToken(retryRawHead) &&
					retryRecovery.value.recomputedClosureDigest === retry.value.head.closureDigest;
			} else {
				completeNew = recoveredHead;
				newHeadConsistent =
					rawHeadConsistent &&
					recovery.value.kind === "active" &&
					recovery.value.head.generationId === recoveredHead.generationId &&
					recovery.value.recomputedClosureDigest === recoveredHead.closureDigest;
			}
			head = {
				kind: "swap",
				monotone:
					newHeadConsistent &&
					rawHeadConsistent &&
					advances(seededHead, completeNew) &&
					(recoveredHead.kind === "none"
						? recovery.value.kind === "empty"
						: recovery.value.kind === "active" &&
							recovery.value.head.generationId === recoveredHead.generationId &&
							recovery.value.recomputedClosureDigest === recoveredHead.closureDigest),
				new: headToken(completeNew),
				old: headToken(seededHead),
				recovered: headToken(recoveredHead),
			};
		}
		return {
			databaseCreateCountAfterSeed: lifecycle.createCount,
			databaseDeleteCount: lifecycle.deleteCount,
			databaseIdentityPreserved: recoveredDatabaseName === databaseName && sentinelRetained,
			head,
			recoveredDatabaseName,
			recoveredImage,
			recoveryResult: resultReason(recovery),
			sentinelRetained,
		};
	} finally {
		await store?.close();
		lifecycle.restore();
	}
}

async function runControls(): Promise<unknown> {
	const databaseName = `phase-2e6-controls-${crypto.randomUUID()}`;
	const first = await createBrowserAheDurableStore({ databaseName });
	const observer = await createBrowserAheDurableStore({ databaseName });
	try {
		await stageComplete(first, OBJECT, GENERATION_A, PAYLOAD_A, noHead(OBJECT));
		const adoptedA = await first.swapHead({
			expectedHead: noHead(OBJECT),
			generationId: GENERATION_A,
			objectId: OBJECT,
		});
		if (!adoptedA.ok) throw new Error(`control first adoption failed: ${adoptedA.reason}`);
		const sameBefore = await observer.recoverActiveGeneration(OBJECT);
		const sameAfter = await observer.recoverActiveGeneration(OBJECT);
		const same =
			sameBefore.ok &&
			sameAfter.ok &&
			sameBefore.value.head.kind === "present" &&
			sameAfter.value.head.kind === "present" &&
			headToken(sameBefore.value.head) === headToken(sameAfter.value.head)
				? "MONOTONE"
				: "REGRESSED";
		await stageComplete(first, OBJECT, GENERATION_B, PAYLOAD_B, adoptedA.value.head);
		const stale = await first.swapHead({ expectedHead: noHead(OBJECT), generationId: GENERATION_B, objectId: OBJECT });
		const advanced = await first.swapHead({
			expectedHead: adoptedA.value.head,
			generationId: GENERATION_B,
			objectId: OBJECT,
		});
		if (!advanced.ok) throw new Error(`control future adoption failed: ${advanced.reason}`);
		const futureRead = await observer.recoverActiveGeneration(OBJECT);
		const future =
			futureRead.ok && futureRead.value.head.kind === "present" && advances(adoptedA.value.head, futureRead.value.head)
				? "MONOTONE"
				: "REGRESSED";
		const rollbackAttempt = await observer.swapHead({
			expectedHead: adoptedA.value.head,
			generationId: GENERATION_A,
			objectId: OBJECT,
		});
		const finalHead = await observer.readHead(OBJECT);
		const rollback =
			!rollbackAttempt.ok &&
			finalHead.ok &&
			finalHead.value.kind === "present" &&
			headToken(finalHead.value) === headToken(advanced.value.head)
				? "MONOTONE"
				: "REGRESSED";
		return {
			competingRecovery: { future, rollback, same },
			diagnostic: {
				advanced: advanced.ok ? headToken(advanced.value.head) : resultReason(advanced),
				finalHead: finalHead.ok ? headToken(finalHead.value) : resultReason(finalHead),
				futureRead: futureRead.ok ? headToken(futureRead.value.head) : resultReason(futureRead),
				rollbackAttempt: resultReason(rollbackAttempt),
				sameAfter: sameAfter.ok ? headToken(sameAfter.value.head) : resultReason(sameAfter),
				sameBefore: sameBefore.ok ? headToken(sameBefore.value.head) : resultReason(sameBefore),
				staleAttempt: resultReason(stale),
			},
			staleExpectedRevision: stale.ok ? "OK" : stale.reason,
		};
	} finally {
		await Promise.all([first.close(), observer.close()]);
	}
}

function observeWorker(
	edge: (typeof PHASE_2E6_DECLARED_EDGES)[number],
	databaseName = `phase-2e6-red-${crypto.randomUUID()}`
): Promise<WorkerObservation> {
	return new Promise((resolve, reject) => {
		const worker = new Worker("/phase-2e6-real-process-death-worker.js", { type: "module" });
		const signal = new SharedArrayBuffer(4);
		const cell = new Int32Array(signal);
		const timer = setTimeout(() => {
			worker.terminate();
			reject(new Error(`arm timeout: ${edge.id}`));
		}, 10_000);
		let ready = false;
		worker.addEventListener("message", (event: MessageEvent<unknown>) => {
			if (typeof event.data !== "object" || event.data === null) {
				clearTimeout(timer);
				worker.terminate();
				reject(new Error("Worker emitted a non-object"));
				return;
			}
			const message = event.data as WorkerObservation;
			if (message.kind === "ready") {
				if (ready) {
					clearTimeout(timer);
					worker.terminate();
					reject(new Error("Worker emitted duplicate ready"));
					return;
				}
				ready = true;
				worker.postMessage({
					databaseName,
					edge,
					kind: "run",
					signal,
					version: 1,
				});
				return;
			}
			if (message.kind === "armed" && window.phase2e6Relay !== undefined) {
				void window.phase2e6Relay(message, Atomics.load(cell, 0));
				return;
			}
			clearTimeout(timer);
			worker.terminate();
			resolve(message);
		});
		worker.addEventListener("error", (error) => {
			clearTimeout(timer);
			worker.terminate();
			reject(error);
		});
	});
}

window.phase2e6RunOne = (edge, databaseName): Promise<WorkerObservation> => observeWorker(edge, databaseName);
window.phase2e6Recover = recoverDatabase;
window.phase2e6RunControls = runControls;

async function runPhase2e6RedProbe(): Promise<readonly WorkerObservation[]> {
	if (!crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
		throw new TypeError("Phase 2e6 requires COOP/COEP and SharedArrayBuffer");
	}
	const observations: WorkerObservation[] = [];
	for (const edge of PHASE_2E6_DECLARED_EDGES) observations.push(await observeWorker(edge));
	return Object.freeze(observations);
}

Reflect.set(globalThis, "phase2e6RealProcessDeathHarness", Object.freeze({ runPhase2e6RedProbe }));
