import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { type AccumulatorSnapshot, CompactMerkleAccumulator } from "@ts-drp/compaction";
// eslint-disable-next-line import/no-unresolved -- Workspace subpath resolves after the required package build.
import { createRecoverableFinalitySigner } from "@ts-drp/keychain/finality";
import type { LiveJournalAcceptedRow } from "@ts-drp/live-journal";
import type { GenerationRef } from "@ts-drp/storage";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
	CreatorLiveCloseHandle,
	CreatorLiveCloseResult,
	CreatorLiveCloseStatus,
} from "../../../packages/node/src/creator-close.js";
import type { V3PlaneHandle } from "../../../packages/node/src/v3-live.js";
import { contract, hexBytes } from "../phase-3a0-v3/controlled-anchor-trust.js";
import { type D109dHotFixture, openD109dHotFixture } from "../phase-6b/runtime-reclamation-contract.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

type StoreCloser = Readonly<{ close(): Promise<void> }>;

export interface D110cARepeatCloseEvidence {
	readonly actorStatusAfterClose: CreatorLiveCloseStatus;
	readonly actorStatusBeforeClose: CreatorLiveCloseStatus;
	readonly afterHead: Awaited<ReturnType<CreatorLiveCloseHandle["inspectDurableHead"]>>;
	readonly beforeHead: Awaited<ReturnType<CreatorLiveCloseHandle["inspectDurableHead"]>>;
	readonly closeAttempts: 1;
	readonly closeResult: CreatorLiveCloseResult;
	readonly closureBytes: Readonly<{ readonly after: number; readonly before: number; readonly delta: number }>;
	readonly cutValue: Readonly<Record<string, unknown>>;
	readonly duplicateCloseErrors: Readonly<{ readonly concurrent: string; readonly sequential: string }>;
	readonly independentHistory: Readonly<{
		readonly closeOrder: readonly string[];
		readonly historyRoot: string;
		readonly historySize: number;
		readonly previous: AccumulatorSnapshot;
		readonly previousRoot: string;
	}>;
	readonly issued: Readonly<Record<string, unknown>>;
	readonly previousHistoryAfter: AccumulatorSnapshot;
	readonly providerPresent: false;
	readonly published: Readonly<Record<string, unknown>>;
	readonly replacementActivationCalls: 0;
	readonly rebindReturnedSameHandle: true;
	readonly roomHeadAfter: Readonly<Record<string, unknown>> | undefined;
	readonly roomHeadBefore: Readonly<Record<string, unknown>> | undefined;
	readonly stalePredecessorError: string;
	readonly runtimeIdentity: Readonly<{
		readonly creatorCloseSourceUrl: string;
		readonly node: string;
		readonly storageNodeBuiltUrl: string;
	}>;
}

export interface D110cARepeatCloseFixture {
	readonly evidence: D110cARepeatCloseEvidence;
	close(): Promise<void>;
}

function copiedRoomHead(plane: V3PlaneHandle): Readonly<Record<string, unknown>> | undefined {
	const authority = plane.currentEphemeralAuthority();
	return authority === undefined
		? undefined
		: Object.freeze({
				aclDigest: authority.aclDigest,
				anchorDigest: authority.anchorDigest,
				epoch: authority.epoch,
				objectId: authority.objectId,
			});
}

function canonicalRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(bytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("D110C_A_CANONICAL_RECORD_INVALID");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

function copiedCompactHistory(bytes: Uint8Array): AccumulatorSnapshot {
	const compactHistory = canonicalRecord(bytes).compactHistory;
	if (compactHistory === null || typeof compactHistory !== "object" || Array.isArray(compactHistory)) {
		throw new TypeError("D110C_A_COMPACT_HISTORY_INVALID");
	}
	return CompactMerkleAccumulator.fromSnapshot(compactHistory as AccumulatorSnapshot).snapshot();
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rejectedMessage(task: Promise<unknown>, missing: string): Promise<string> {
	try {
		await task;
		throw new TypeError(missing);
	} catch (error) {
		if (error instanceof TypeError && error.message === missing) throw error;
		return error instanceof Error ? error.message : String(error);
	}
}

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolvePromise) => {
		const request = indexedDB.deleteDatabase(name);
		request.addEventListener("success", () => resolvePromise(), { once: true });
		request.addEventListener("error", () => resolvePromise(), { once: true });
		request.addEventListener("blocked", () => resolvePromise(), { once: true });
	});
}

async function bytesForRow(hot: D109dHotFixture, row: LiveJournalAcceptedRow): Promise<Uint8Array> {
	if (row.sourceKind === "received") return Uint8Array.from(row.exactCanonicalPreimageBytes);
	const issued = await hot.base.evidence.issuanceStore.readIssued(
		Object.freeze({ author: row.author, objectId: row.scope.objectId }),
		row.authorSequence
	);
	if (issued === null) throw new TypeError("D110C_A_ISSUED_ROW_UNAVAILABLE");
	return Uint8Array.from(issued.envelope.canonicalPreimageBytes);
}

async function epochOneRows(hot: D109dHotFixture): Promise<readonly LiveJournalAcceptedRow[]> {
	const scope = Object.freeze({ anchorDigest: hot.oracle.anchorDigest, epoch: 1, objectId: hot.oracle.objectId });
	const readiness = await hot.base.journal.readiness({ scope });
	if (!readiness.ok || !readiness.ready) throw new TypeError("D110C_A_JOURNAL_UNAVAILABLE");
	const rows: LiveJournalAcceptedRow[] = [];
	let afterSequence: number | null = null;
	for (;;) {
		const page = await hot.base.journal.readPage({ afterSequence, limit: 128, scope, snapshot: readiness.snapshot });
		if (!page.ok) throw new TypeError("D110C_A_JOURNAL_PAGE_UNAVAILABLE");
		rows.push(...page.rows);
		if (page.nextSequence === null) return Object.freeze(rows);
		afterSequence = page.nextSequence;
	}
}

async function independentHistory(
	hot: D109dHotFixture,
	previous: AccumulatorSnapshot
): Promise<D110cARepeatCloseEvidence["independentHistory"]> {
	const rows = await epochOneRows(hot);
	const dependencies = new Map<string, readonly string[]>();
	for (const row of rows) {
		const record = canonicalRecord(await bytesForRow(hot, row));
		if (!Array.isArray(record.dependencies) || !record.dependencies.every((value) => typeof value === "string")) {
			throw new TypeError("D110C_A_VERTEX_DEPENDENCIES_INVALID");
		}
		dependencies.set(
			row.vertexDigest,
			Object.freeze(record.dependencies.filter((value) => value !== hot.oracle.anchorDigest)) as readonly string[]
		);
	}
	const ordered: string[] = [];
	const completed = new Set<string>();
	while (ordered.length < rows.length) {
		const ready = [...dependencies]
			.filter(([digest, values]) => !completed.has(digest) && values.every((value) => completed.has(value)))
			.map(([digest]) => digest)
			.sort();
		if (ready.length === 0) throw new TypeError("D110C_A_VERTEX_ORDER_INVALID");
		for (const digest of ready) {
			completed.add(digest);
			ordered.push(digest);
		}
	}
	const accumulator = CompactMerkleAccumulator.fromSnapshot(previous);
	for (let index = 0; index < ordered.length; index += 1) {
		accumulator.append(
			encodeCanonical({
				epoch: 1,
				kind: "drp-history-leaf",
				objectId: hot.oracle.objectId,
				ordinal: previous.size + index,
				protocolMajor: 3,
				vertexHash: ordered[index],
			})
		);
	}
	return Object.freeze({
		closeOrder: Object.freeze(ordered),
		historyRoot: lowerHex(accumulator.root()),
		historySize: accumulator.size,
		previous,
		previousRoot: lowerHex(CompactMerkleAccumulator.fromSnapshot(previous).root()),
	});
}

async function blobForRef(hot: D109dHotFixture, ref: GenerationRef): Promise<Uint8Array> {
	const value = await hot.base.evidence.aheBackend.getBlob(ref.digest);
	if (!value.ok || value.value === null || value.value.byteLength !== ref.byteLength) {
		throw new TypeError("D110C_A_CLOSURE_BLOB_UNAVAILABLE");
	}
	return Uint8Array.from(value.value);
}

/**
 * Executes a genuine adopted epoch-one close against the authenticated prior-history carrier.
 * @returns Retained GREEN evidence and a cooperative cleanup owner.
 */
export async function openD110cARepeatCloseFixture(): Promise<D110cARepeatCloseFixture> {
	const hot = await openD109dHotFixture();
	const primaryDatabaseName = `d110c-a-seal-${crypto.randomUUID()}`;
	const snapshotDatabaseName = `d110c-a-snapshot-${crypto.randomUUID()}`;
	const closers: StoreCloser[] = [];
	let closeHandle: CreatorLiveCloseHandle | undefined;
	let closed = false;
	const cleanup = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		await closeHandle?.stop().catch(() => undefined);
		await Promise.all(closers.map((closer) => closer.close().catch(() => undefined)));
		await hot.close();
		await Promise.all([deleteDatabase(primaryDatabaseName), deleteDatabase(snapshotDatabaseName)]);
	};
	try {
		const plane = hot.successor as V3PlaneHandle;
		const issued = await hot.successor.issueLocal({
			operations: Object.freeze([
				Object.freeze({ logicalTime: 41, operation: Object.freeze({ action: "add", value: 11 }) }),
			]),
			signRegisteredVertexDigest: hot.base.signRegisteredVertexDigest,
		});
		if (issued.ok !== true) throw new TypeError(`D110C_A_POST_ADOPTION_ISSUE_FAILED:${String(issued.kind)}`);
		const published = await hot.successor.publishPending();
		if (published.ok !== true) throw new TypeError(`D110C_A_POST_ADOPTION_PUBLISH_FAILED:${String(published.kind)}`);
		const previousHistory = copiedCompactHistory(hot.base.evidence.exactCanonicalProjectionBytes);
		const signer = await createRecoverableFinalitySigner({ seed: hexBytes(contract.privateKeySeedHex) });
		const [vote, evidenceStore, snapshotStore] = await Promise.all([
			hot.base.modules.openBrowserSealVoteStore({ databaseName: primaryDatabaseName }),
			hot.base.modules.openBrowserSealEvidenceStore({ databaseName: primaryDatabaseName }),
			hot.base.modules.createBrowserSnapshotQuarantineStore({ primaryDatabaseName: snapshotDatabaseName }),
		]);
		closers.push(vote, evidenceStore, snapshotStore);
		if (vote.observation.incarnation !== evidenceStore.observation.incarnation) {
			throw new TypeError("D110C_A_SEAL_INCARNATION_MISMATCH");
		}
		const bindInput = {
			evidenceStore: evidenceStore.store,
			exactCanonicalAvailabilityPolicyBytes: encodeCanonical({
				minLocalCopies: 1,
				minMirrorReceipts: 0,
				minRollbackGenerations: 2,
				mode: "local-only",
			}),
			onObservation: () => undefined,
			plane,
			signer: signer.signer,
			snapshotStore,
			storageIncarnation: vote.observation.incarnation,
			voteStore: vote.store,
		} as const;
		const bound = await hot.base.modules.bindCreatorLiveClose(bindInput);
		if (!bound.ok) throw new TypeError(`D110C_A_CLOSE_BIND_FAILED:${bound.reason}`);
		closeHandle = bound.handle;
		const rebound = await hot.base.modules.bindCreatorLiveClose(bindInput);
		if (!rebound.ok || rebound.handle !== closeHandle) throw new TypeError("D110C_A_REBIND_IDENTITY_FAILED");
		const roomHeadBefore = copiedRoomHead(plane);
		const beforeHead = await closeHandle.inspectDurableHead();
		const actorStatusBeforeClose = closeHandle.status();
		const closeTask = closeHandle.close();
		const concurrentCloseError = rejectedMessage(closeHandle.close(), "D110C_A_CONCURRENT_CLOSE_UNEXPECTED_SUCCESS");
		const closeResult = await closeTask;
		const sequentialCloseError = await rejectedMessage(
			closeHandle.close(),
			"D110C_A_SEQUENTIAL_CLOSE_UNEXPECTED_SUCCESS"
		);
		const stalePredecessorError = await rejectedMessage(
			(hot.predecessor as CreatorLiveCloseHandle).close(),
			"D110C_A_STALE_PREDECESSOR_UNEXPECTED_SUCCESS"
		);
		const afterHead = await closeHandle.inspectDurableHead();
		const cutValue = canonicalRecord(await blobForRef(hot, closeResult.cutValueRef));
		const independentlyDerived = await independentHistory(hot, previousHistory);
		const beforeBytes = beforeHead.references.reduce((total, ref) => total + ref.byteLength, 0);
		const afterBytes = afterHead.references.reduce((total, ref) => total + ref.byteLength, 0);
		return Object.freeze({
			close: cleanup,
			evidence: Object.freeze({
				actorStatusAfterClose: closeHandle.status(),
				actorStatusBeforeClose,
				afterHead,
				beforeHead,
				closeAttempts: 1 as const,
				closeResult,
				closureBytes: Object.freeze({ after: afterBytes, before: beforeBytes, delta: afterBytes - beforeBytes }),
				cutValue,
				duplicateCloseErrors: Object.freeze({
					concurrent: await concurrentCloseError,
					sequential: sequentialCloseError,
				}),
				independentHistory: independentlyDerived,
				issued,
				previousHistoryAfter: copiedCompactHistory(hot.base.evidence.exactCanonicalProjectionBytes),
				providerPresent: false as const,
				published,
				replacementActivationCalls: 0 as const,
				rebindReturnedSameHandle: true as const,
				roomHeadAfter: copiedRoomHead(plane),
				roomHeadBefore,
				stalePredecessorError,
				runtimeIdentity: Object.freeze({
					creatorCloseSourceUrl: pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/creator-close.ts")).href,
					node: process.version,
					storageNodeBuiltUrl: pathToFileURL(resolve(REPOSITORY_ROOT, "packages/storage-node/dist/src/index.js")).href,
				}),
			}),
		});
	} catch (error) {
		await cleanup();
		throw error;
	}
}
