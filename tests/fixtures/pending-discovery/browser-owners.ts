import { closeAll } from "./cleanup.js";
import type { RecoveryOwners } from "./types.js";
import { createBrowserAheDurableStore } from "../../../packages/storage-browser/dist/src/index.js";
import { createBrowserSnapshotQuarantineStore } from "../../../packages/storage-browser/dist/src/snapshot-transfer.js";
/**
 * Run the named pending-only fixture seam.
 * @param identity - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function browserOwners(identity: string): Promise<RecoveryOwners> {
	const closers: Array<() => Promise<void>> = [];
	try {
		const ahe = await createBrowserAheDurableStore({ databaseName: identity + "--ahe" });
		closers.push(() => ahe.close());
		const snapshot = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName: identity });
		closers.push(() => snapshot.close());
		return { ahe, snapshot, close: () => closeAll(closers) };
	} catch (error) {
		await closeAll(closers, { error });
		throw error;
	}
}
