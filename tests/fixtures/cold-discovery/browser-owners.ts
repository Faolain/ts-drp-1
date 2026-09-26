import type { NativeOwners } from "./types.js";
import { createBrowserAheDurableStore } from "../../../packages/storage-browser/dist/src/index.js";
import { createBrowserDurableIssuanceStore } from "../../../packages/storage-browser/dist/src/issuance.js";
import { createBrowserDurableLiveJournalStore } from "../../../packages/storage-browser/dist/src/live-journal.js";
import { createBrowserSnapshotQuarantineStore } from "../../../packages/storage-browser/dist/src/snapshot-transfer.js";

/**
 * Actual browser owners reopened by the persisted database identity.
 * @param identity
 */
export async function browserOwners(identity: string): Promise<NativeOwners> {
	const ahe = await createBrowserAheDurableStore({ databaseName: `${identity}--ahe` });
	const issuance = await createBrowserDurableIssuanceStore({ primaryDatabaseName: identity });
	const journal = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: identity });
	const snapshot = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName: identity });
	return {
		ahe,
		issuance,
		journal,
		snapshot,
		close: async (): Promise<void> => {
			await Promise.all([ahe.close(), issuance.close(), journal.close(), snapshot.close()]);
		},
	};
}
