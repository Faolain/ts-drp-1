import { closeAll } from "./cleanup.js";
import type { NativeOwners } from "./types.js";
import { createBrowserAheDurableStore } from "../../../packages/storage-browser/dist/src/index.js";
import { createBrowserDurableIssuanceStore } from "../../../packages/storage-browser/dist/src/issuance.js";
import { createBrowserDurableLiveJournalStore } from "../../../packages/storage-browser/dist/src/live-journal.js";
import { createBrowserSnapshotQuarantineStore } from "../../../packages/storage-browser/dist/src/snapshot-transfer.js";
/**
 * Run the named pending-only fixture seam.
 * @param identity - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function browserSetupOwners(identity: string): Promise<NativeOwners> {
	const closers: Array<() => Promise<void>> = [];
	try {
		const ahe = await createBrowserAheDurableStore({ databaseName: identity + "--ahe" });
		closers.push(() => ahe.close());
		const issuance = await createBrowserDurableIssuanceStore({ primaryDatabaseName: identity });
		closers.push(() => issuance.close());
		const journal = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: identity });
		closers.push(() => journal.close());
		const snapshot = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName: identity });
		closers.push(() => snapshot.close());
		return { ahe, issuance, journal, snapshot, close: () => closeAll(closers) };
	} catch (error) {
		await closeAll(closers, { error });
		throw error;
	}
}
