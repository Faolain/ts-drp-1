/* eslint-disable import/no-unresolved -- Focused build plugin owns the causal maintenance alias. */
import { encodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueCommit, DurableIssueScope } from "@ts-drp/issuance-store";
import { createEphemeralDurableIssuanceStore } from "@ts-drp/issuance-store/conformance";

import {
	D109B_BROWSER_MAINTENANCE_READY,
	resolveBrowserDurableIssuancePruningMaintenance,
} from "#phase-6b-issuance-maintenance";
import { createBrowserDurableIssuanceStore } from "../../src/issuance.js";

const SCOPE = Object.freeze({ author: "a".repeat(64), objectId: `creator:${"b".repeat(32)}` });
const OTHER_SCOPE = Object.freeze({ author: "c".repeat(64), objectId: `creator:${"d".repeat(32)}` });

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
		? String(Reflect.get(error, "code"))
		: undefined;
}

async function capturedCode(run: () => Promise<unknown>): Promise<string | undefined> {
	try {
		await run();
		return undefined;
	} catch (error) {
		return errorCode(error);
	}
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolvePromise, reject) => {
		request.addEventListener("success", () => resolvePromise(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error), { once: true });
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise<void>((resolvePromise, reject) => {
		transaction.addEventListener("complete", () => resolvePromise(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
		transaction.addEventListener("error", () => reject(transaction.error), { once: true });
	});
}

function openNative(databaseName: string): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolvePromise, reject) => {
		const request = indexedDB.open(`${databaseName}--drp-issuance-v1`);
		request.addEventListener("success", () => resolvePromise(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error), { once: true });
	});
}

async function nativeLineage(databaseName: string): Promise<Record<string, unknown>> {
	const database = await openNative(databaseName);
	try {
		const transaction = database.transaction("lineages", "readonly");
		const row = (await requestValue(transaction.objectStore("lineages").get([SCOPE.objectId, SCOPE.author]))) as Record<
			string,
			unknown
		>;
		await transactionDone(transaction);
		return { keys: Object.keys(row).sort(), watermark: row.prunedThroughAuthorSequence ?? null };
	} finally {
		database.close();
	}
}

async function issue(
	store: DurableIssuanceStore,
	scope: DurableIssueScope,
	epoch: number,
	published = true
): Promise<DurableIssueCommit> {
	const commit = await store.transactIssue(scope, (authorSequence) => {
		const envelope = {
			canonicalPreimageBytes: encodeCanonical({
				author: scope.author,
				authorSequence,
				epoch,
				kind: "drp-vertex",
				objectId: scope.objectId,
				protocolMajor: 3,
			}),
			digest: Uint8Array.of(authorSequence + 1, epoch + 1),
			signature: Uint8Array.of(authorSequence + 11, epoch + 11),
		};
		return Promise.resolve({
			authorSequence,
			envelope,
			issuedRecord: { authorSequence, envelope, scope },
			outboxEntry: { authorSequence, envelope, scope },
		});
	});
	if (published) {
		await store.compareAndMarkOutboxPublished({
			authorSequence: commit.authorSequence,
			digest: commit.envelope.digest,
			scope,
		});
	}
	return commit;
}

async function run(databaseName: string): Promise<Readonly<Record<string, unknown>>> {
	const first = await createBrowserDurableIssuanceStore({ primaryDatabaseName: databaseName });
	const maintenance = resolveBrowserDurableIssuancePruningMaintenance(first);
	if (maintenance === undefined) throw new TypeError("D109B_BROWSER_MAINTENANCE_MISSING");
	const copiedFacadeDenied = resolveBrowserDurableIssuancePruningMaintenance({ ...first }) === undefined;
	const proxyFacadeDenied = resolveBrowserDurableIssuancePruningMaintenance(new Proxy(first, {})) === undefined;
	const foreign = createEphemeralDurableIssuanceStore();
	const crossBackendDenied = resolveBrowserDurableIssuancePruningMaintenance(foreign) === undefined;
	await foreign.close();
	const firstCommit = await issue(first, SCOPE, 4);
	await issue(first, SCOPE, 4);
	await issue(first, OTHER_SCOPE, 4);
	const legacyLineage = await nativeLineage(databaseName);
	const before = await maintenance.inspectPruningState(SCOPE);
	const receipt = await maintenance.prunePublishedPrefix({
		closedEpoch: 4,
		commitQcRef: { byteLength: 32, digest: "e".repeat(64) },
		expectedLineage: before.lineage,
		expectedPrunedThroughAuthorSequence: before.prunedThroughAuthorSequence,
		scope: SCOPE,
		snapshotManifestDigest: "f".repeat(64),
		throughAuthorSequence: 0,
	});
	const replay = await maintenance.prunePublishedPrefix({
		closedEpoch: 4,
		commitQcRef: { byteLength: 32, digest: "e".repeat(64) },
		expectedLineage: before.lineage,
		expectedPrunedThroughAuthorSequence: before.prunedThroughAuthorSequence,
		scope: SCOPE,
		snapshotManifestDigest: "f".repeat(64),
		throughAuthorSequence: 0,
	});
	const lateExact = await capturedCode(() =>
		first.compareAndMarkOutboxPublished({ authorSequence: 0, digest: firstCommit.envelope.digest, scope: SCOPE })
	);
	const lateWrong = await capturedCode(() =>
		first.compareAndMarkOutboxPublished({ authorSequence: 0, digest: Uint8Array.of(255), scope: SCOPE })
	);
	await first.close();
	const reopened = await createBrowserDurableIssuanceStore({ primaryDatabaseName: databaseName });
	try {
		const reopenedMaintenance = resolveBrowserDurableIssuancePruningMaintenance(reopened);
		if (reopenedMaintenance === undefined) throw new TypeError("D109B_BROWSER_REOPEN_MAINTENANCE_MISSING");
		const state = await reopenedMaintenance.inspectPruningState(SCOPE);
		await issue(reopened, SCOPE, 5);
		return Object.freeze({
			crossBackendDenied,
			copiedFacadeDenied,
			facadeKeys: Object.keys(reopened).sort(),
			lineage: await reopened.readLineage(SCOPE),
			lateExact,
			lateWrong,
			legacyLineage,
			numericLineage: await nativeLineage(databaseName),
			outbox: (await reopened.readOutboxPage({ scope: SCOPE })).map(({ commit }) => commit.authorSequence),
			otherScope: (await reopened.readOutboxPage({ scope: OTHER_SCOPE })).map(({ commit }) => commit.authorSequence),
			proxyFacadeDenied,
			prunedRead: await reopened.readIssued(SCOPE, 0),
			receipt,
			replayRange: replay.deletedAuthorSequenceRange,
			state,
			version: await new Promise<number>((resolvePromise, reject) => {
				const request = indexedDB.open(`${databaseName}--drp-issuance-v1`);
				request.addEventListener("success", () => {
					const version = request.result.version;
					request.result.close();
					resolvePromise(version);
				});
				request.addEventListener("error", () => reject(request.error), { once: true });
			}),
		});
	} finally {
		await reopened.close();
	}
}

async function runSemantics(prefix: string): Promise<Readonly<Record<string, unknown>>> {
	const pending = await createBrowserDurableIssuanceStore({ primaryDatabaseName: `${prefix}-pending` });
	const pendingOwner = resolveBrowserDurableIssuancePruningMaintenance(pending);
	if (pendingOwner === undefined) throw new TypeError("D109B_BROWSER_MAINTENANCE_MISSING");
	await issue(pending, SCOPE, 8);
	await issue(pending, SCOPE, 8, false);
	const pendingState = await pendingOwner.inspectPruningState(SCOPE);
	const pendingCode = await capturedCode(() =>
		pendingOwner.prunePublishedPrefix({
			closedEpoch: 8,
			commitQcRef: { byteLength: 32, digest: "e".repeat(64) },
			expectedLineage: pendingState.lineage,
			expectedPrunedThroughAuthorSequence: pendingState.prunedThroughAuthorSequence,
			scope: SCOPE,
			snapshotManifestDigest: "f".repeat(64),
			throughAuthorSequence: 1,
		})
	);
	const wrongEpochCode = await capturedCode(() =>
		pendingOwner.prunePublishedPrefix({
			closedEpoch: 7,
			commitQcRef: { byteLength: 32, digest: "e".repeat(64) },
			expectedLineage: pendingState.lineage,
			expectedPrunedThroughAuthorSequence: pendingState.prunedThroughAuthorSequence,
			scope: SCOPE,
			snapshotManifestDigest: "f".repeat(64),
			throughAuthorSequence: 0,
		})
	);
	const pendingLineage = await pending.readLineage(SCOPE);
	await pending.close();

	const staleLineage = await createBrowserDurableIssuanceStore({ primaryDatabaseName: `${prefix}-lineage` });
	const staleLineageOwner = resolveBrowserDurableIssuancePruningMaintenance(staleLineage);
	if (staleLineageOwner === undefined) throw new TypeError("D109B_BROWSER_MAINTENANCE_MISSING");
	await issue(staleLineage, SCOPE, 9);
	const staleLineageState = await staleLineageOwner.inspectPruningState(SCOPE);
	await issue(staleLineage, SCOPE, 9);
	const staleLineageCode = await capturedCode(() =>
		staleLineageOwner.prunePublishedPrefix({
			closedEpoch: 9,
			commitQcRef: { byteLength: 32, digest: "e".repeat(64) },
			expectedLineage: staleLineageState.lineage,
			expectedPrunedThroughAuthorSequence: staleLineageState.prunedThroughAuthorSequence,
			scope: SCOPE,
			snapshotManifestDigest: "f".repeat(64),
			throughAuthorSequence: 0,
		})
	);
	await staleLineage.close();

	const staleWatermark = await createBrowserDurableIssuanceStore({ primaryDatabaseName: `${prefix}-watermark` });
	const staleWatermarkOwner = resolveBrowserDurableIssuancePruningMaintenance(staleWatermark);
	if (staleWatermarkOwner === undefined) throw new TypeError("D109B_BROWSER_MAINTENANCE_MISSING");
	await issue(staleWatermark, SCOPE, 10);
	await issue(staleWatermark, SCOPE, 10);
	const staleWatermarkState = await staleWatermarkOwner.inspectPruningState(SCOPE);
	const pruningInput = (
		throughAuthorSequence: number,
		state = staleWatermarkState
	): Readonly<Record<string, unknown>> => ({
		closedEpoch: 10,
		commitQcRef: { byteLength: 32, digest: "e".repeat(64) },
		expectedLineage: state.lineage,
		expectedPrunedThroughAuthorSequence: state.prunedThroughAuthorSequence,
		scope: SCOPE,
		snapshotManifestDigest: "f".repeat(64),
		throughAuthorSequence,
	});
	await staleWatermarkOwner.prunePublishedPrefix(pruningInput(0));
	const staleWatermarkCode = await capturedCode(() => staleWatermarkOwner.prunePublishedPrefix(pruningInput(1)));
	const refreshedWatermark = await staleWatermarkOwner.inspectPruningState(SCOPE);
	await staleWatermarkOwner.prunePublishedPrefix(pruningInput(1, refreshedWatermark));
	await staleWatermark.close();

	const laterEpoch = await createBrowserDurableIssuanceStore({ primaryDatabaseName: `${prefix}-later` });
	const laterOwner = resolveBrowserDurableIssuancePruningMaintenance(laterEpoch);
	if (laterOwner === undefined) throw new TypeError("D109B_BROWSER_MAINTENANCE_MISSING");
	await issue(laterEpoch, SCOPE, 14);
	await issue(laterEpoch, SCOPE, 14);
	const firstState = await laterOwner.inspectPruningState(SCOPE);
	await laterOwner.prunePublishedPrefix({ ...pruningInput(1, firstState), closedEpoch: 14 });
	await issue(laterEpoch, SCOPE, 15);
	await issue(laterEpoch, SCOPE, 15);
	const secondState = await laterOwner.inspectPruningState(SCOPE);
	const laterReceipt = await laterOwner.prunePublishedPrefix({ ...pruningInput(3, secondState), closedEpoch: 15 });
	const laterOutbox = await laterEpoch.readOutboxPage({ scope: SCOPE });
	await laterEpoch.close();

	return Object.freeze({
		laterOutbox: laterOutbox.length,
		laterRange: laterReceipt.deletedAuthorSequenceRange,
		pendingCode,
		pendingLineage,
		staleLineageCode,
		staleWatermarkCode,
		wrongEpochCode,
	});
}

async function mutateNative(databaseName: string, mutant: string): Promise<void> {
	const database = await openNative(databaseName);
	try {
		const transaction = database.transaction(["issuedRecords", "issuanceOutbox"], "readwrite");
		const issued = transaction.objectStore("issuedRecords");
		const outbox = transaction.objectStore("issuanceOutbox");
		const sequence = mutant === "epoch-regression" || mutant === "sequence-gap" ? 1 : 0;
		const key = [SCOPE.objectId, SCOPE.author, sequence];
		if (mutant === "issued-only") await requestValue(outbox.delete(key));
		else if (mutant === "outbox-only") await requestValue(issued.delete(key));
		else if (mutant === "sequence-gap") {
			await requestValue(issued.delete(key));
			await requestValue(outbox.delete(key));
		} else if (mutant === "digest-mismatch") {
			const row = (await requestValue(outbox.get(key))) as Record<string, unknown>;
			await requestValue(outbox.put({ ...row, digest: Uint8Array.of(255) }));
		} else {
			const row = (await requestValue(issued.get(key))) as Record<string, unknown>;
			let canonicalPreimageBytes: Uint8Array;
			if (mutant === "canonical-malformed") canonicalPreimageBytes = Uint8Array.of(0);
			else {
				canonicalPreimageBytes = encodeCanonical({
					...SCOPE,
					author: mutant === "scope-wrong" ? "z".repeat(64) : SCOPE.author,
					authorSequence: mutant === "ordinal-wrong" ? sequence + 1 : sequence,
					epoch: mutant === "epoch-wrong" ? 5 : mutant === "epoch-regression" ? 3 : 4,
					kind: mutant === "vertex-kind-wrong" ? "not-a-vertex" : "drp-vertex",
					protocolMajor: mutant === "protocol-major-wrong" ? 2 : 3,
				});
			}
			await requestValue(issued.put({ ...row, canonicalPreimageBytes }));
		}
		await transactionDone(transaction);
	} finally {
		database.close();
	}
}

async function runNativeMutants(prefix: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
	const mutants = [
		"canonical-malformed",
		"vertex-kind-wrong",
		"protocol-major-wrong",
		"scope-wrong",
		"ordinal-wrong",
		"epoch-wrong",
		"issued-only",
		"outbox-only",
		"digest-mismatch",
		"sequence-gap",
		"epoch-regression",
	] as const;
	const results: Readonly<Record<string, unknown>>[] = [];
	for (const mutant of mutants) {
		const databaseName = `${prefix}-${mutant}`;
		const seeded = await createBrowserDurableIssuanceStore({ primaryDatabaseName: databaseName });
		for (let index = 0; index < 3; index += 1) await issue(seeded, SCOPE, 4);
		await seeded.close();
		await mutateNative(databaseName, mutant);
		const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: databaseName });
		const owner = resolveBrowserDurableIssuancePruningMaintenance(store);
		if (owner === undefined) throw new TypeError("D109B_BROWSER_MAINTENANCE_MISSING");
		const state = await owner.inspectPruningState(SCOPE);
		const code = await capturedCode(() =>
			owner.prunePublishedPrefix({
				closedEpoch: 4,
				commitQcRef: { byteLength: 32, digest: "e".repeat(64) },
				expectedLineage: state.lineage,
				expectedPrunedThroughAuthorSequence: state.prunedThroughAuthorSequence,
				scope: SCOPE,
				snapshotManifestDigest: "f".repeat(64),
				throughAuthorSequence: 2,
			})
		);
		await store.close();
		const database = await openNative(databaseName);
		try {
			const transaction = database.transaction(["issuedRecords", "issuanceOutbox", "lineages"], "readonly");
			const [issuedCount, outboxCount, lineage] = await Promise.all([
				requestValue(transaction.objectStore("issuedRecords").count()),
				requestValue(transaction.objectStore("issuanceOutbox").count()),
				requestValue(transaction.objectStore("lineages").get([SCOPE.objectId, SCOPE.author])),
			]);
			await transactionDone(transaction);
			results.push(
				Object.freeze({
					code,
					issuedCount,
					mutant,
					outboxCount,
					watermark: (lineage as Record<string, unknown>).prunedThroughAuthorSequence ?? null,
				})
			);
		} finally {
			database.close();
		}
	}
	return Object.freeze(results);
}

Object.assign(globalThis, {
	phase6bIssuanceRetention: Object.freeze({
		ready: D109B_BROWSER_MAINTENANCE_READY,
		run,
		runNativeMutants,
		runSemantics,
	}),
});
