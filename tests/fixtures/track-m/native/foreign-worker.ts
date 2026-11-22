import { rowDigest } from "./dump.js";

// Track M, slice 14f case 3: a foreign writer on its OWN thread and connection. It starts
// one strict read-write transaction over stores the retention transaction (step B) holds:
// it reads one owner control, puts and deletes a scratch row (a net no-op), and reports
// when its requests were issued and when it completed, on a shared order counter.

interface Request {
	readonly kind: "foreign-request";
	readonly database: string;
	readonly stores: readonly string[];
	readonly put: Readonly<{ store: string; key: IDBValidKey; value: unknown }>;
	readonly read: Readonly<{ store: string; key: IDBValidKey }>;
	readonly order: Int32Array;
}

function open(database: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const r = indexedDB.open(database);
		r.onsuccess = (): void => resolve(r.result);
		r.onerror = (): void => reject(r.error ?? new Error("TRACK_M_14F_FOREIGN_OPEN"));
	});
}

self.addEventListener("message", (event: MessageEvent<Request>): void => {
	const data = event.data;
	if (data?.kind !== "foreign-request") return;
	void (async (): Promise<void> => {
		const db = await open(data.database);
		const transaction = db.transaction([...data.stores], "readwrite", { durability: "strict" });
		const read = transaction.objectStore(data.read.store).get(data.read.key);
		const store = transaction.objectStore(data.put.store);
		if (store.keyPath === null) store.put(data.put.value, data.put.key);
		else store.put(data.put.value);
		store.delete(data.put.key);
		const issuedAt = Atomics.add(data.order, 0, 1);
		postMessage({ kind: "foreign-issued", issuedAt, durability: transaction.durability, mode: transaction.mode });
		transaction.oncomplete = (): void => {
			const completedAt = Atomics.add(data.order, 0, 1);
			db.close();
			postMessage({
				kind: "foreign-done",
				ok: true,
				issuedAt,
				completedAt,
				readDigest: rowDigest(data.read.key, read.result),
			});
		};
		transaction.onabort = (): void => {
			db.close();
			postMessage({ kind: "foreign-done", ok: false, error: String(transaction.error) });
		};
	})().catch((error: unknown) => postMessage({ kind: "foreign-done", ok: false, error: String(error) }));
});
