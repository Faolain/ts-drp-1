import { join } from "node:path";

import { closeAll } from "./cleanup.js";
import type { NativeOwners } from "./types.js";
import { createSqliteAheDurableStore } from "../../../packages/storage-node/dist/src/index.js";
import { createNodeDurableIssuanceStore } from "../../../packages/storage-node/dist/src/issuance.js";
import { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/dist/src/live-journal.js";
import { createNodeSnapshotQuarantineStore } from "../../../packages/storage-node/dist/src/snapshot-transfer.js";
/**
 * Run the named pending-only fixture seam.
 * @param identity - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function nodeSetupOwners(identity: string): Promise<NativeOwners> {
	const closers: Array<() => Promise<void>> = [];
	try {
		const ahe = createSqliteAheDurableStore({ filename: join(identity, "ahe.sqlite") });
		closers.push(() => ahe.close());
		const issuance = createNodeDurableIssuanceStore({ primaryFilename: join(identity, "issuance.sqlite") });
		closers.push(() => issuance.close());
		const journal = createNodeDurableLiveJournalStore({ primaryFilename: join(identity, "journal.sqlite") });
		closers.push(() => journal.close());
		const snapshot = createNodeSnapshotQuarantineStore({ primaryFilename: join(identity, "snapshot.sqlite") });
		closers.push(() => snapshot.close());
		return { ahe, issuance, journal, snapshot, close: () => closeAll(closers) };
	} catch (error) {
		await closeAll(closers, { error });
		throw error;
	}
}
