import { join } from "node:path";

import type { NativeOwners } from "./types.js";
import { createSqliteAheDurableStore } from "../../../packages/storage-node/dist/src/index.js";
import { createNodeDurableIssuanceStore } from "../../../packages/storage-node/dist/src/issuance.js";
import { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/dist/src/live-journal.js";
import { createNodeSnapshotQuarantineStore } from "../../../packages/storage-node/dist/src/snapshot-transfer.js";

/**
 * Reopen four native SQLite owners by identity only.
 * @param identity
 */
export function nodeOwners(identity: string): NativeOwners {
	const ahe = createSqliteAheDurableStore({ filename: join(identity, "ahe.sqlite") });
	const issuance = createNodeDurableIssuanceStore({ primaryFilename: join(identity, "issuance.sqlite") });
	const journal = createNodeDurableLiveJournalStore({ primaryFilename: join(identity, "journal.sqlite") });
	const snapshot = createNodeSnapshotQuarantineStore({ primaryFilename: join(identity, "snapshot.sqlite") });
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
