import { decodeCanonical } from "@ts-drp/canonical";
/* eslint-disable import/no-unresolved -- Fresh child resolves authenticated built workspace exports. */
import { verifyCreatorSuccessorAdoption } from "@ts-drp/node/creator-adoption";
import { activateCreatorSuccessorAdoption } from "@ts-drp/node/creator-adoption-activate";
import { commitCreatorSuccessorAdoption } from "@ts-drp/node/creator-adoption-commit";
import { bindCreatorLiveClose } from "@ts-drp/node/creator-close";
import {
	activateV3LivePlane,
	bindV3BlueprintLivePlane,
	prepareV3LiveGeneration,
	recoverV3LiveReplica,
	routeV3Ingress,
} from "@ts-drp/node/v3-live";
import { openBrowserSealEvidenceStore } from "@ts-drp/storage-browser/seal-evidence";
import { openBrowserSealVoteStore } from "@ts-drp/storage-browser/seal-vote";
import { createBrowserSnapshotQuarantineStore } from "@ts-drp/storage-browser/snapshot-transfer";
import { createSqliteAheDurableStore } from "@ts-drp/storage-node";
import { createNodeDurableIssuanceStore } from "@ts-drp/storage-node/issuance";
import { resolveNodeDurableIssuancePruningMaintenance } from "@ts-drp/storage-node/issuance-maintenance";
import { createNodeDurableLiveJournalStore } from "@ts-drp/storage-node/live-journal";
/* eslint-enable import/no-unresolved */

import {
	D110A_ACTIVE_ROOMS,
	D110A_BATCH_VERTICES_PER_OBJECT,
	D110A_OBJECT_EPOCHS,
	D110A_OPERATIONS_PER_OBJECT,
	D110A_TOTAL_BATCH_VERTICES,
	D110A_TOTAL_OPERATIONS,
	type D110aMemoryReading,
	type D110aObjectResult,
	type D110aProof,
	type D110aSample,
	d110aSemanticDigest,
	validateD110aProof,
} from "./retained-heap-contract.js";
import { createD109dReceipts, d109dCandidate, openD109dHotFixture } from "../phase-6b/runtime-reclamation-contract.js";

const D110A_CREATOR_MODULES = Object.freeze({
	activateCreatorSuccessorAdoption,
	activateV3LivePlane,
	bindCreatorLiveClose,
	bindV3BlueprintLivePlane,
	commitCreatorSuccessorAdoption,
	createBrowserSnapshotQuarantineStore,
	createNodeDurableIssuanceStore,
	createNodeDurableLiveJournalStore,
	createSqliteAheDurableStore,
	openBrowserSealEvidenceStore,
	openBrowserSealVoteStore,
	prepareV3LiveGeneration,
	recoverV3LiveReplica,
	resolveNodeDurableIssuancePruningMaintenance,
	routeV3Ingress,
	verifyCreatorSuccessorAdoption,
});

export interface D110aWorkerModules {
	readonly aheMaintenance: string;
	readonly closedEpochCleanup: string;
	readonly runtimeReclamation: string;
}

export interface D110aPreflightResult {
	readonly accountingDiagnostic: boolean;
	readonly appliedWorkloadOperations: number;
	readonly kind: "d110a-preflight-v1";
	readonly objectEpochs: 2;
	readonly samples: readonly D110aSample[];
	readonly successfulLifecycles: 2;
}

interface RetainedSuccessor {
	close(): Promise<void>;
}

function progress(message: Readonly<Record<string, unknown>>): void {
	process.send?.(Object.freeze({ kind: "progress", ...message }));
}

function objectId(index: number): string {
	return `creator:${index.toString(16).padStart(32, "0")}`;
}

function snapshotApplicationState(bytes: Uint8Array): number {
	const payload = decodeCanonical(bytes);
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
		throw new TypeError("D110A_PRE_CLOSE_STATE_MISSING");
	}
	const state = Reflect.get(payload, "application");
	if (typeof state !== "number" || !Number.isSafeInteger(state)) {
		throw new TypeError("D110A_PRE_CLOSE_STATE_MISSING");
	}
	return state;
}

function memoryReading(): D110aMemoryReading {
	const memory = process.memoryUsage();
	if (memory.arrayBuffers > memory.external) throw new TypeError("D110A_NODE_ACCOUNTING_DIAGNOSTIC_INVALID");
	return Object.freeze({
		arrayBuffers: memory.arrayBuffers,
		external: memory.external,
		heapUsed: memory.heapUsed,
		ownedBytes: memory.heapUsed + memory.arrayBuffers,
		rss: memory.rss,
	});
}

async function postGcReading(): Promise<D110aMemoryReading> {
	if (globalThis.gc === undefined) throw new TypeError("D110A_EXPOSE_GC_REQUIRED");
	for (let turn = 0; turn < 3; turn += 1) {
		globalThis.gc();
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
	}
	return memoryReading();
}

function installBrowserStoreEnvironment(): void {
	if (typeof indexedDB !== "object") throw new TypeError("D110A_INDEXED_DB_MISSING");
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
	if (typeof navigator.storage?.estimate !== "function") throw new TypeError("D110A_NAVIGATOR_STORAGE_MISSING");
}

async function buildObjectEpoch(
	index: number,
	modules: D110aWorkerModules
): Promise<Readonly<{ readonly result: D110aObjectResult; readonly retained: RetainedSuccessor }>> {
	let appliedWorkloadOperations = 0;
	let preCloseState = -1;
	const fixture = await openD109dHotFixture({
		creator: {
			applicationBatch: true,
			beforeCreatorClose: async ({ firstLogicalTime, plane, signRegisteredVertexDigest }) => {
				let logicalTime = firstLogicalTime;
				let latest: Readonly<{ readonly authorSequence: number; readonly digest: string }> | undefined;
				for (let batchIndex = 0; batchIndex < D110A_BATCH_VERTICES_PER_OBJECT; batchIndex += 1) {
					const count = batchIndex === D110A_BATCH_VERTICES_PER_OBJECT - 1 ? 9 : 16;
					const operations = Object.freeze(
						Array.from({ length: count }, () =>
							Object.freeze({
								logicalTime: logicalTime++,
								operation: Object.freeze({ action: "add", value: 1 }),
							})
						)
					);
					const issued = await plane.issueLocal({ operations, signRegisteredVertexDigest });
					if (!issued.ok) throw new TypeError(`D110A_WORKLOAD_ISSUE_FAILED:${issued.kind}:${issued.detail}`);
					const published = await plane.publishPending();
					if (!published.ok || published.kind !== "published") {
						throw new TypeError(`D110A_WORKLOAD_PUBLISH_FAILED:${published.kind}`);
					}
					appliedWorkloadOperations += count;
					latest = Object.freeze({ authorSequence: issued.authorSequence, digest: issued.digest });
				}
				if (logicalTime !== 15_628 || appliedWorkloadOperations !== D110A_OPERATIONS_PER_OBJECT) {
					throw new TypeError("D110A_WORKLOAD_COUNT_INVALID");
				}
				if (latest === undefined) throw new TypeError("D110A_WORKLOAD_LAST_ISSUE_MISSING");
				return latest;
			},
			modules: D110A_CREATOR_MODULES,
			objectId: objectId(index),
		},
	});
	let retained = false;
	try {
		preCloseState = snapshotApplicationState(fixture.base.evidence.exactCanonicalPayloadBytes);
		if (preCloseState !== 15_628) throw new TypeError(`D110A_PRE_CLOSE_STATE_INVALID:${preCloseState}`);
		if (fixture.base.evidence.journalRows.length !== D110A_BATCH_VERTICES_PER_OBJECT + 2) {
			throw new TypeError("D110A_WORKLOAD_VERTEX_COUNT_INVALID");
		}
		const receipts = await createD109dReceipts(fixture, {
			closedEpochCleanup: modules.closedEpochCleanup,
		});
		const candidate = await d109dCandidate(modules.runtimeReclamation);
		if (candidate.reclaimInstalledV3Runtime === undefined) throw new TypeError("D110A_RECLAIM_OWNER_MISSING");
		const reclaimed = await candidate.reclaimInstalledV3Runtime({
			aheReceipt: receipts.aheReceipt,
			issuanceReceipt: receipts.issuanceReceipt,
			successor: fixture.successor,
		});
		if (reclaimed.ok !== true || reclaimed.replay !== false) {
			throw new TypeError(`D110A_RUNTIME_RECLAIM_FAILED:${String(reclaimed.code)}`);
		}
		const successorIssued = await fixture.successor.issueLocal({
			operations: Object.freeze([
				Object.freeze({ logicalTime: 15_628, operation: Object.freeze({ action: "add", value: 1 }) }),
			]),
			signRegisteredVertexDigest: fixture.base.signRegisteredVertexDigest,
		});
		if (!successorIssued.ok) {
			throw new TypeError(`D110A_SUCCESSOR_ISSUE_FAILED:${successorIssued.kind}:${successorIssued.detail}`);
		}
		const successorPublished = await fixture.successor.publishPending();
		if (!successorPublished.ok || successorPublished.kind !== "published") {
			throw new TypeError(`D110A_SUCCESSOR_PUBLISH_FAILED:${successorPublished.kind}`);
		}
		const close = fixture.close;
		retained = true;
		return Object.freeze({
			result: Object.freeze({
				appliedWorkloadOperations,
				objectId: fixture.base.evidence.current.head.objectId,
				postSuccessorState: preCloseState + 1,
				preCloseState,
			}),
			retained: Object.freeze({ close }),
		});
	} finally {
		if (!retained) await fixture.close();
	}
}

async function closeWindow(window: readonly RetainedSuccessor[]): Promise<void> {
	for (const retained of window) await retained.close();
}

async function execute(
	objectEpochs: number,
	modules: D110aWorkerModules
): Promise<
	Readonly<{
		readonly baseline: D110aMemoryReading;
		readonly results: readonly D110aObjectResult[];
		readonly samples: readonly D110aSample[];
		readonly window: readonly RetainedSuccessor[];
	}>
> {
	installBrowserStoreEnvironment();
	const baseline = await postGcReading();
	const results: D110aObjectResult[] = [];
	const samples: D110aSample[] = [];
	const window: RetainedSuccessor[] = [];
	try {
		for (let index = 0; index < objectEpochs; index += 1) {
			const completed = await buildObjectEpoch(index, modules);
			results.push(completed.result);
			window.push(completed.retained);
			if (window.length > D110A_ACTIVE_ROOMS) {
				const displaced = window.shift();
				if (displaced === undefined) throw new TypeError("D110A_ACTIVE_WINDOW_INVALID");
				await displaced.close();
			}
			const sample = Object.freeze({
				activeSuccessors: window.length,
				appliedWorkloadOperations: (index + 1) * D110A_OPERATIONS_PER_OBJECT,
				completedObjectEpochs: index + 1,
				eventLoopTurns: 3,
				gcTurns: 3,
				index,
				memory: await postGcReading(),
				phase: "during-execution" as const,
			});
			samples.push(sample);
			progress({
				activeSuccessors: sample.activeSuccessors,
				appliedWorkloadOperations: sample.appliedWorkloadOperations,
				completedObjectEpochs: sample.completedObjectEpochs,
			});
		}
		return Object.freeze({
			baseline,
			results: Object.freeze(results),
			samples: Object.freeze(samples),
			window: Object.freeze([...window]),
		});
	} catch (error) {
		await closeWindow(window);
		throw error;
	}
}

/**
 * Runs the identical two-object lifecycle without issuing a memory verdict.
 * @param modules - Authenticated built internal-module URLs.
 * @returns Two-object lifecycle and accounting diagnostics.
 */
export async function runD110aPreflight(modules: D110aWorkerModules): Promise<D110aPreflightResult> {
	const executed = await execute(2, modules);
	try {
		const accountingDiagnostic = executed.samples.every(({ memory }) => memory.arrayBuffers <= memory.external);
		if (!accountingDiagnostic || executed.window.length !== 2 || executed.results.length !== 2) {
			throw new TypeError("D110A_PREFLIGHT_WINDOW_CUSTODY_INVALID");
		}
		return Object.freeze({
			accountingDiagnostic,
			appliedWorkloadOperations: 2 * D110A_OPERATIONS_PER_OBJECT,
			kind: "d110a-preflight-v1" as const,
			objectEpochs: 2 as const,
			samples: executed.samples,
			successfulLifecycles: 2 as const,
		});
	} finally {
		await closeWindow(executed.window);
	}
}

/**
 * Runs and validates the sole full D.110a worker before final window close.
 * @param modules - Authenticated built internal-module URLs.
 * @returns Complete retained-heap proof.
 */
export async function runD110aFullWorker(modules: D110aWorkerModules): Promise<D110aProof> {
	const executed = await execute(D110A_OBJECT_EPOCHS, modules);
	const proof: D110aProof = Object.freeze({
		accounting: Object.freeze({
			admittedWorkloadOperations: D110A_TOTAL_OPERATIONS,
			appliedWorkloadOperations: D110A_TOTAL_OPERATIONS,
			nextSuccessorOperations: D110A_OBJECT_EPOCHS,
			successfulLifecycles: D110A_OBJECT_EPOCHS,
			workloadBatchVertices: D110A_TOTAL_BATCH_VERTICES,
		}),
		baseline: executed.baseline,
		finalWindowClosedAfterTerminalSample: true,
		measurement: Object.freeze({
			baselineSubtracted: false,
			sampleOrder: "execution",
			slopeEndIndex: 63,
			slopeMethod: "ols",
			slopeStartIndex: 32,
		}),
		objectResults: executed.results,
		repeatedSameObjectEpochs: false,
		samples: executed.samples,
		semanticDigest: d110aSemanticDigest(executed.results),
	});
	try {
		validateD110aProof(proof);
		if (executed.window.length !== D110A_ACTIVE_ROOMS) throw new TypeError("D110A_ACTIVE_WINDOW_INVALID");
		return proof;
	} finally {
		await closeWindow(executed.window);
	}
}
