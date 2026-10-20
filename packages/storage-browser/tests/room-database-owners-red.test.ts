import "fake-indexeddb/auto";
import { encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import * as aheModule from "../src/internal/idb-adapter.js";
import * as schemaModule from "../src/internal/schema-idb.js";
import * as issuanceModule from "../src/issuance.js";
import * as journalModule from "../src/live-journal.js";
import * as signingModule from "../src/seal-signing.js";
import * as snapshotModule from "../src/snapshot-transfer.js";

// Slice 14a (specs/bounded-storage-lifecycle/slices/14a-retention-database-format.md),
// RED item 3 and the owner half of item 1: owners open the room database only in
// room mode, never upgrade it, check only their own namespace, and keep their held
// read views inside it. fake-indexeddb is mechanism evidence only (native: 14f).

type Closeable = Readonly<{ close(): Promise<void> }>;
type Factory = (input: Readonly<{ databaseName: string }>) => Promise<Closeable>;
function factory(module: object, name: string): Factory {
	return (input) => {
		const candidate = Reflect.get(module, name) as Factory | undefined;
		if (typeof candidate !== "function") return Promise.reject(new Error(`${name} is missing`));
		return candidate(input);
	};
}
const OWNERS: readonly Readonly<{ owner: string; open: Factory }>[] = [
	{ owner: "ahe", open: factory(aheModule, "createBrowserRoomAheDurableStore") },
	{ owner: "journal", open: factory(journalModule, "createBrowserRoomLiveJournalStore") },
	{ owner: "snapshot", open: factory(snapshotModule, "createBrowserRoomSnapshotQuarantineStore") },
	{ owner: "issuance", open: factory(issuanceModule, "createBrowserRoomDurableIssuanceStore") },
	{ owner: "signing-vote", open: factory(signingModule, "openBrowserRoomSealVoteStore") },
	{ owner: "signing-evidence", open: factory(signingModule, "openBrowserRoomSealEvidenceStore") },
	{ owner: "signing", open: factory(signingModule, "openBrowserRoomSealSigningStore") },
];
const prepare = (databaseName: string): Promise<unknown> => {
	const prepareRoom = Reflect.get(schemaModule, "prepareBrowserRoomDatabase") as
		| ((input: Readonly<{ databaseName: string }>) => Promise<unknown>)
		| undefined;
	if (typeof prepareRoom !== "function") return Promise.reject(new Error("prepareBrowserRoomDatabase is missing"));
	return prepareRoom({ databaseName });
};

function request<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = (): void => resolve(r.result);
		r.onerror = (): void => reject(r.error);
	});
}
function terminal(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = (): void => resolve();
		tx.onabort = (): void => reject(tx.error ?? new Error("aborted"));
	});
}
async function databaseVersion(name: string): Promise<number | undefined> {
	const listed = await indexedDB.databases();
	return listed.find((entry) => entry.name === name)?.version;
}
async function snapshotCatalog(name: string): Promise<readonly string[]> {
	const db = await request(indexedDB.open(name));
	try {
		return [...db.objectStoreNames];
	} finally {
		db.close();
	}
}
let counter = 0;
const fresh = (label: string): string => `room-owners-${label}-${++counter}`;

describe("14a owners in room mode", () => {
	it("opens every owner on a ready room database and closes it", async () => {
		const name = fresh("ready");
		await prepare(name);
		for (const { owner, open } of OWNERS) {
			const opened = await open({ databaseName: name }).catch((error: unknown) => {
				throw new Error(`${owner} did not open in room mode`, { cause: error });
			});
			await opened.close();
		}
		expect(await databaseVersion(name)).toBe(7);
	});

	it("never creates or upgrades the room database", async () => {
		for (const { owner, open } of OWNERS) {
			const missing = fresh(`missing-${owner}`);
			await expect(open({ databaseName: missing }), owner).rejects.toThrow();
			expect(await databaseVersion(missing), owner).toBeUndefined();

			const six = fresh(`six-${owner}`);
			const legacy = await schemaModule.openPhase2dBrowserDatabase({ databaseName: six });
			legacy.close();
			const before = await snapshotCatalog(six);
			await expect(open({ databaseName: six }), owner).rejects.toThrow();
			expect(await databaseVersion(six), owner).toBe(6);
			expect(await snapshotCatalog(six), owner).toEqual(before);
		}
	});

	it("refuses a migrating layout", async () => {
		const name = fresh("migrating");
		const legacy = await schemaModule.openPhase2dBrowserDatabase({ databaseName: name });
		legacy.close();
		await prepare(name);
		for (const { owner, open } of OWNERS) await expect(open({ databaseName: name }), owner).rejects.toThrow();
	});

	it("checks only its own namespace catalog", async () => {
		const name = fresh("namespace");
		await prepare(name);
		// Rebuild the same room at a raw version 8 whose journal namespace lost an index.
		const db = await request(
			(() => {
				const r = indexedDB.open(name, 8);
				r.onupgradeneeded = (): void => {
					r.transaction!.objectStore("journal:acceptedEntries").deleteIndex("localRefUniq");
				};
				return r;
			})()
		);
		db.close();
		// Version 8 is not the room version: every owner refuses, nothing is changed.
		for (const { owner, open } of OWNERS) await expect(open({ databaseName: name }), owner).rejects.toThrow();
		expect(await databaseVersion(name)).toBe(8);

		// At version 7, a damaged journal namespace refuses only the journal owner.
		const damaged = fresh("namespace-7");
		await prepare(damaged);
		const raw = await request(indexedDB.open(damaged));
		const names = [...raw.objectStoreNames];
		const tx = raw.transaction(names, "readonly");
		const shapes = await Promise.all(
			names.map(async (storeName) => {
				const store = tx.objectStore(storeName);
				const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
				return {
					name: storeName,
					keyPath: store.keyPath,
					indexes: [...store.indexNames].map((indexName) => {
						const index = store.index(indexName);
						return { name: indexName, keyPath: index.keyPath, unique: index.unique };
					}),
					keys,
					values,
				};
			})
		);
		await terminal(tx);
		raw.close();
		const copy = fresh("namespace-7-copy");
		const rebuilt = await request(
			(() => {
				const r = indexedDB.open(copy, 7);
				r.onupgradeneeded = (): void => {
					for (const shape of shapes) {
						const store = r.result.createObjectStore(
							shape.name,
							shape.keyPath === null ? {} : { keyPath: shape.keyPath }
						);
						for (const index of shape.indexes)
							if (!(shape.name === "journal:acceptedEntries" && index.name === "localRefUniq"))
								store.createIndex(index.name, index.keyPath, { unique: index.unique });
						shape.values.forEach((value, index) =>
							shape.keyPath === null ? store.add(value, shape.keys[index]) : store.add(value)
						);
					}
				};
				return r;
			})()
		);
		rebuilt.close();
		const layout = shapes.find((shape) => shape.name === "room:layout");
		expect([...(layout?.keys ?? [])].sort()).toEqual(["layout", "ready"]);
		expect(layout?.values[layout.keys.indexOf("layout")]).toEqual(
			encodeCanonical({ version: 1, kind: "room-database-layout-1" })
		);
		for (const { owner, open } of OWNERS) {
			if (owner === "journal") {
				await expect(open({ databaseName: copy }), owner).rejects.toThrow();
				continue;
			}
			const opened = await open({ databaseName: copy });
			await opened.close();
		}
	});

	it("keeps an AHE held read view inside the AHE namespace", async () => {
		const name = fresh("isolation");
		await prepare(name);
		const ahe = (await factory(aheModule, "createBrowserRoomAheDurableStore")({ databaseName: name })) as Closeable & {
			acquireNativeReadReservation(input: Readonly<{ objectId: string }>): Promise<{ release(): Promise<void> }>;
		};
		const reservation = await ahe.acquireNativeReadReservation({ objectId: "isolation-object" });
		const other = await request(indexedDB.open(name));
		try {
			const settle = async (stores: string[], put: (tx: IDBTransaction) => void): Promise<"committed" | "waiting"> => {
				const tx = other.transaction(stores, "readwrite", { durability: "strict" });
				put(tx);
				return Promise.race([
					terminal(tx).then(() => "committed" as const),
					new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 200)),
				]);
			};
			// Signing and journal writers are not blocked by the AHE view.
			await expect(
				settle(["voteSlots"], (tx) =>
					tx.objectStore("voteSlots").put({ objectId: "o", epoch: 1, round: 0, phase: "p", signerId: "s" })
				)
			).resolves.toBe("committed");
			await expect(
				settle(["journal:retirementControls"], (tx) =>
					tx.objectStore("journal:retirementControls").put({ objectId: "isolation-object", record: new Uint8Array(1) })
				)
			).resolves.toBe("committed");
			// An AHE-namespace writer waits for the view.
			const blocked = other.transaction(["ahe:objects"], "readwrite", { durability: "strict" });
			blocked.objectStore("ahe:objects").put({ objectId: "isolation-object" });
			const done = terminal(blocked).then(() => "committed" as const);
			await expect(
				Promise.race([done, new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 200))])
			).resolves.toBe("waiting");
			await reservation.release();
			await expect(done).resolves.toBe("committed");
		} finally {
			other.close();
			await ahe.close();
		}
	});
});
