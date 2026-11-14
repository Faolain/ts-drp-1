import type { DurableIssuanceStore } from "@ts-drp/issuance-store";

import { runBatchConformance } from "../../../../tests/fixtures/issuance-batch/conformance.js";
import { prepareBrowserRoomDatabase } from "../../src/internal/schema-idb.js";
import { createBrowserDurableIssuanceStore, createBrowserRoomDurableIssuanceStore } from "../../src/issuance.js";

// transactIssueBatch conformance on IndexedDB: the same driver the SQLite store runs
// (tests/issuance-batch-conformance-native.test.ts), over the legacy and the room store.
Reflect.set(globalThis, "runIssuanceBatch", async (mode: string) => {
	const opened: DurableIssuanceStore[] = [];
	const run = crypto.randomUUID();
	try {
		return await runBatchConformance(async (name) => {
			const databaseName = `issuance-batch-${mode}-${name}-${run}`;
			let store: DurableIssuanceStore;
			if (mode === "legacy") store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: databaseName });
			else {
				await prepareBrowserRoomDatabase({ databaseName });
				store = await createBrowserRoomDurableIssuanceStore({ databaseName });
			}
			opened.push(store);
			return store;
		}, true);
	} finally {
		await Promise.allSettled(opened.map((store) => store.close()));
	}
});
