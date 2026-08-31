import { encodeCanonical } from "@ts-drp/canonical";
import type { DurableIssueScope } from "@ts-drp/issuance-store";

import { createBrowserDurableIssuanceStore } from "../../src/issuance.js";
import {
	D109B_BROWSER_MAINTENANCE_READY,
	resolveBrowserDurableIssuancePruningMaintenance,
} from "#phase-6b-issuance-maintenance";

const SCOPE = Object.freeze({ author: "a".repeat(64), objectId: `creator:${"b".repeat(32)}` });

async function issue(
	store: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>>,
	scope: DurableIssueScope,
	epoch: number
): Promise<void> {
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
	await store.compareAndMarkOutboxPublished({
		authorSequence: commit.authorSequence,
		digest: commit.envelope.digest,
		scope,
	});
}

async function run(databaseName: string): Promise<Readonly<Record<string, unknown>>> {
	const first = await createBrowserDurableIssuanceStore({ primaryDatabaseName: databaseName });
	const maintenance = resolveBrowserDurableIssuancePruningMaintenance(first);
	if (maintenance === undefined) throw new TypeError("D109B_BROWSER_MAINTENANCE_MISSING");
	await issue(first, SCOPE, 4);
	await issue(first, SCOPE, 4);
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
	await first.close();
	const reopened = await createBrowserDurableIssuanceStore({ primaryDatabaseName: databaseName });
	try {
		const reopenedMaintenance = resolveBrowserDurableIssuancePruningMaintenance(reopened);
		if (reopenedMaintenance === undefined) throw new TypeError("D109B_BROWSER_REOPEN_MAINTENANCE_MISSING");
		const state = await reopenedMaintenance.inspectPruningState(SCOPE);
		await issue(reopened, SCOPE, 5);
		return Object.freeze({
			facadeKeys: Object.keys(reopened).sort(),
			lineage: await reopened.readLineage(SCOPE),
			outbox: (await reopened.readOutboxPage({ scope: SCOPE })).map(({ commit }) => commit.authorSequence),
			receipt,
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

Object.assign(globalThis, {
	phase6bIssuanceRetention: Object.freeze({ ready: D109B_BROWSER_MAINTENANCE_READY, run }),
});
