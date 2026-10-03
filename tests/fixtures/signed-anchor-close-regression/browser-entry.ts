import { createBrowserDurableLiveJournalStore } from "../../../packages/storage-browser/dist/src/live-journal.js";
import { causal, positive, scope, type Operation } from "./causal.js";

function request<T>(native: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		native.addEventListener("success", () => resolve(native.result), { once: true });
		native.addEventListener("error", () => reject(native.error), { once: true });
	});
}
function done(native: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		native.addEventListener("complete", () => resolve(), { once: true });
		native.addEventListener("abort", () => reject(native.error ?? new Error("native transaction aborted")), {
			once: true,
		});
	});
}

Object.assign(globalThis, {
	captureCloseRun: async (primaryDatabaseName: string, operation: Operation | "positive") => {
		const actualName = primaryDatabaseName + "--drp-live-journal-v1";
		const store = await createBrowserDurableLiveJournalStore({ primaryDatabaseName });
		let receipt: unknown;
		try {
			if (operation === "positive") receipt = await positive(store);
			else {
				const observed = await causal(store, operation);
				const db = await request(indexedDB.open(actualName));
				try {
					const tx = db.transaction("scopes", "readonly"),
						terminal = done(tx);
					const row = await request(tx.objectStore("scopes").get([scope.objectId, scope.epoch, scope.anchorDigest]));
					await terminal;
					receipt = {
						...observed,
						rows:
							row === undefined
								? []
								: [
										{
											objectId: row.objectId,
											epoch: row.epoch,
											anchorDigest: row.anchorDigest,
											nextJournalSequence: row.nextJournalSequence,
										},
									],
					};
				} finally {
					db.close();
				}
			}
		} finally {
			await store.close();
			// Delete only this random test-owned name after store and inspection close.
			await new Promise<void>((resolve, reject) => {
				const deletion = indexedDB.deleteDatabase(actualName);
				deletion.onsuccess = () => resolve();
				deletion.onerror = () => reject(deletion.error);
				deletion.onblocked = () => reject(new Error("OWNED_DATABASE_DELETE_BLOCKED:" + actualName));
			});
		}
		return {
			owner: "actual Chromium IndexedDB",
			operation,
			actualName,
			receipt,
			lifecycleJoined: true,
			cleanupTerminal: "success",
		};
	},
});
