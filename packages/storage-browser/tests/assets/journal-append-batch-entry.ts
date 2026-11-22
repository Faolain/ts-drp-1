import type { DurableLiveJournalStore } from "@ts-drp/live-journal";

import { runJournalAppendBatchConformance } from "../../../../tests/fixtures/journal-append-batch/conformance.js";
import { prepareBrowserRoomDatabase } from "../../src/internal/schema-idb.js";
import { createBrowserDurableLiveJournalStore, createBrowserRoomLiveJournalStore } from "../../src/live-journal.js";

// appendAcceptedLocalBatch conformance on IndexedDB: the same driver the SQLite journal runs
// (tests/journal-append-batch-conformance-native.test.ts), over the legacy and the room journal. Every
// native transaction the page opens is counted from IDBDatabase.transaction: readwrite is a write, the
// rest reads.
Reflect.set(globalThis, "runJournalAppendBatch", async (mode: string) => {
	const opened: DurableLiveJournalStore[] = [];
	const run = crypto.randomUUID();
	const count = { writes: 0, reads: 0 };
	const transaction = IDBDatabase.prototype.transaction;
	IDBDatabase.prototype.transaction = function (
		this: IDBDatabase,
		...args: Parameters<IDBDatabase["transaction"]>
	): IDBTransaction {
		if (args[1] === "readwrite") count.writes += 1;
		else count.reads += 1;
		return transaction.apply(this, args);
	};
	try {
		return await runJournalAppendBatchConformance(
			async (name) => {
				const databaseName = `journal-append-batch-${mode}-${name}-${run}`;
				let store: DurableLiveJournalStore;
				if (mode === "legacy")
					store = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: databaseName });
				else {
					await prepareBrowserRoomDatabase({ databaseName });
					store = await createBrowserRoomLiveJournalStore({ databaseName });
				}
				opened.push(store);
				return store;
			},
			{
				reset: () => {
					count.writes = 0;
					count.reads = 0;
				},
				read: () => ({ ...count }),
			}
		);
	} finally {
		IDBDatabase.prototype.transaction = transaction;
		await Promise.allSettled(opened.map((store) => store.close()));
	}
});
