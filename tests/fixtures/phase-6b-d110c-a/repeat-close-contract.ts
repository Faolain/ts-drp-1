import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { type AccumulatorSnapshot, CompactMerkleAccumulator } from "@ts-drp/compaction";
// eslint-disable-next-line import/no-unresolved -- Workspace subpath resolves after the required package build.
import { createRecoverableFinalitySigner } from "@ts-drp/keychain/finality";
import type { LiveJournalAcceptedRow } from "@ts-drp/live-journal";
import { digestBlob, type GenerationRef } from "@ts-drp/storage";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type {
	CreatorLiveCloseHandle,
	CreatorLiveCloseResult,
	CreatorLiveCloseStatus,
} from "../../../packages/node/src/creator-close.js";
import {
	consumeCreatorAdoptionIntent,
	createCreatorAdoptionIntent,
	type CreatorAdoptionIntentMaterial,
} from "../../../packages/node/src/internal/creator-adoption-intent.js";
import type { V3PlaneHandle } from "../../../packages/node/src/v3-live.js";
import { contract, hexBytes } from "../phase-3a0-v3/controlled-anchor-trust.js";
import { openGenuineCreatorAdoptionFixture } from "../phase-6a-v3/creator-adoption-contract.js";
import { type D109dHotFixture, openD109dHotFixture } from "../phase-6b/runtime-reclamation-contract.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const execFileAsync = promisify(execFile);

export const D110C_A_HOSTILE_CARRIERS = Object.freeze([
	"root-inconsistent",
	"size-inconsistent",
	"missing",
	"malformed",
	"reset",
	"cross-room",
	"earlier-epoch",
] as const);

type D110cAHostileCarrier = (typeof D110C_A_HOSTILE_CARRIERS)[number];

export interface D110cAHostileCarrierEvidence {
	readonly carrier: D110cAHostileCarrier;
	readonly durableHeadUnchanged: boolean;
	readonly reason: string;
	readonly roomHeadUnchanged: boolean;
}

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
	readonly hostileCarrierRefusals: readonly D110cAHostileCarrierEvidence[];
	readonly overflowRefusal: string;
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

function changedDigest(value: unknown): string {
	return value === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
}

function mutatedProjection(
	bytes: Uint8Array,
	carrier: D110cAHostileCarrier,
	foreignHistory: AccumulatorSnapshot
): Uint8Array {
	const projection = { ...canonicalRecord(bytes) } as Record<string, unknown>;
	if (carrier === "root-inconsistent") projection.historyRoot = changedDigest(projection.historyRoot);
	else if (carrier === "size-inconsistent") projection.historySize = Number(projection.historySize) + 1;
	else if (carrier === "missing") Reflect.deleteProperty(projection, "compactHistory");
	else if (carrier === "malformed") projection.compactHistory = "not-an-accumulator";
	else if (carrier === "reset" || carrier === "earlier-epoch") {
		projection.compactHistory = new CompactMerkleAccumulator().snapshot();
	} else projection.compactHistory = foreignHistory;
	return encodeCanonical(projection);
}

function replacedProjectionMaterial(
	material: CreatorAdoptionIntentMaterial,
	mutantBytes: Uint8Array
): CreatorAdoptionIntentMaterial {
	const originalDigest = digestBlob(material.exactCanonicalProjectionBytes);
	const mutantDigest = digestBlob(mutantBytes);
	if (!originalDigest.ok || !mutantDigest.ok) throw new TypeError("D110C_A_PROJECTION_DIGEST_FAILED");
	const mutantRef = Object.freeze({ byteLength: mutantBytes.byteLength, digest: mutantDigest.value });
	const replaceRef = (ref: GenerationRef): GenerationRef =>
		ref.digest === originalDigest.value ? mutantRef : Object.freeze({ ...ref });
	const replaceCandidate = (
		candidate: Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>
	): Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }> =>
		candidate.ref.digest === originalDigest.value
			? Object.freeze({ bytes: Uint8Array.from(mutantBytes), ref: mutantRef })
			: Object.freeze({ bytes: Uint8Array.from(candidate.bytes), ref: Object.freeze({ ...candidate.ref }) });
	const successor = material.activation.successor;
	return Object.freeze({
		...material,
		activation: Object.freeze({
			...material.activation,
			successor: Object.freeze({
				...successor,
				candidates: Object.freeze(successor.candidates.map(replaceCandidate)),
				exactCanonicalProjectionBytes: Uint8Array.from(mutantBytes),
				references: Object.freeze(successor.references.map(replaceRef).sort(compareRef)),
			}),
		}),
		candidateReferences: Object.freeze(material.candidateReferences.map(replaceRef).sort(compareRef)),
		exactCanonicalProjectionBytes: Uint8Array.from(mutantBytes),
	});
}

function compareRef(left: GenerationRef, right: GenerationRef): number {
	return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
}

async function hostileCarrierRefusal(
	carrier: D110cAHostileCarrier,
	foreignHistory: AccumulatorSnapshot
): Promise<D110cAHostileCarrierEvidence> {
	const base = await openGenuineCreatorAdoptionFixture();
	const primaryDatabaseName = `d110c-a-hostile-seal-${crypto.randomUUID()}`;
	const snapshotDatabaseName = `d110c-a-hostile-snapshot-${crypto.randomUUID()}`;
	const closers: StoreCloser[] = [];
	let successor: V3PlaneHandle | undefined;
	try {
		const verified = await base.modules.verifyCreatorSuccessorAdoption({ catalog: base.catalog, handle: base.handle });
		if (!verified.ok) throw new TypeError(`D110C_A_HOSTILE_VERIFY_FAILED:${verified.kind}`);
		const material = consumeCreatorAdoptionIntent(verified.intent, base.handle);
		if (material === undefined) throw new TypeError("D110C_A_HOSTILE_INTENT_UNAVAILABLE");
		const mutant = mutatedProjection(material.exactCanonicalProjectionBytes, carrier, foreignHistory);
		const replacement = replacedProjectionMaterial(material, mutant);
		const committed = await base.modules.commitCreatorSuccessorAdoption({
			handle: base.handle,
			intent: createCreatorAdoptionIntent(base.handle, replacement),
		});
		if (!committed.ok) throw new TypeError(`D110C_A_HOSTILE_COMMIT_FAILED:${committed.kind}`);
		const activated = await base.modules.activateCreatorSuccessorAdoption({
			capability: committed.capability,
			expectedRoomHead: Object.freeze({
				currentAnchorDigest: String(committed.descriptor.anchorDigest),
				epoch: Number(committed.descriptor.epoch),
				objectId: String(committed.descriptor.objectId),
			}),
			handle: base.handle,
			...base.runtimeBindings,
		});
		if (!activated.ok || activated.handle === null || typeof activated.handle !== "object") {
			throw new TypeError(`D110C_A_HOSTILE_ACTIVATION_FAILED:${String(activated.kind)}`);
		}
		successor = activated.handle as V3PlaneHandle;
		const beforeRoomHead = copiedRoomHead(successor);
		const beforeDurable = await base.evidence.aheBackend.recoverActiveGeneration(base.scope.objectId);
		const signer = await createRecoverableFinalitySigner({ seed: hexBytes(contract.privateKeySeedHex) });
		const [vote, evidenceStore, snapshotStore] = await Promise.all([
			base.modules.openBrowserSealVoteStore({ databaseName: primaryDatabaseName }),
			base.modules.openBrowserSealEvidenceStore({ databaseName: primaryDatabaseName }),
			base.modules.createBrowserSnapshotQuarantineStore({ primaryDatabaseName: snapshotDatabaseName }),
		]);
		closers.push(vote, evidenceStore, snapshotStore);
		const bound = await base.modules.bindCreatorLiveClose({
			evidenceStore: evidenceStore.store,
			exactCanonicalAvailabilityPolicyBytes: encodeCanonical({
				minLocalCopies: 1,
				minMirrorReceipts: 0,
				minRollbackGenerations: 2,
				mode: "local-only",
			}),
			onObservation: () => undefined,
			plane: successor,
			signer: signer.signer,
			snapshotStore,
			storageIncarnation: vote.observation.incarnation,
			voteStore: vote.store,
		});
		const afterDurable = await base.evidence.aheBackend.recoverActiveGeneration(base.scope.objectId);
		return Object.freeze({
			carrier,
			durableHeadUnchanged: JSON.stringify(afterDurable) === JSON.stringify(beforeDurable),
			reason: bound.ok ? "UNEXPECTED_SUCCESS" : bound.reason,
			roomHeadUnchanged: JSON.stringify(copiedRoomHead(successor)) === JSON.stringify(beforeRoomHead),
		});
	} finally {
		await Promise.resolve(successor?.deactivate()).catch(() => undefined);
		await Promise.all(closers.map((closer) => closer.close().catch(() => undefined)));
		await base.close();
		await Promise.all([deleteDatabase(primaryDatabaseName), deleteDatabase(snapshotDatabaseName)]);
	}
}

async function hostileCarrierRefusals(): Promise<readonly D110cAHostileCarrierEvidence[]> {
	const foreign = await openGenuineCreatorAdoptionFixture({ objectId: `creator:${"b".repeat(32)}` });
	let foreignHistory: AccumulatorSnapshot;
	try {
		foreignHistory = CompactMerkleAccumulator.fromSnapshot(foreign.evidence.history.historySnapshot).snapshot();
	} finally {
		await foreign.close();
	}
	const output: D110cAHostileCarrierEvidence[] = [];
	for (const carrier of D110C_A_HOSTILE_CARRIERS) output.push(await hostileCarrierRefusal(carrier, foreignHistory));
	return Object.freeze(output);
}

async function overflowRefusal(): Promise<string> {
	const child = resolve(import.meta.dirname, "overflow-bind-child.mjs");
	const completed = await execFileAsync(process.execPath, ["--import", "tsx", child], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
	});
	const parsed = JSON.parse(completed.stdout.trim()) as Readonly<{ readonly reason?: unknown }>;
	return typeof parsed.reason === "string" ? parsed.reason : "D110C_A_OVERFLOW_CHILD_INVALID";
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
	const [carrierRefusals, overflow] = await Promise.all([hostileCarrierRefusals(), overflowRefusal()]);
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
				hostileCarrierRefusals: carrierRefusals,
				overflowRefusal: overflow,
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
