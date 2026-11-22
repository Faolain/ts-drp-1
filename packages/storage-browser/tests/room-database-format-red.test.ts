import "fake-indexeddb/auto";
import { decodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import * as schemaModule from "../src/internal/schema-idb.js";

// Slice 14a (specs/bounded-storage-lifecycle/slices/14a-retention-database-format.md),
// RED items 1 and 3: the room database catalog, its upgrade and stale-code fence,
// and the per-owner isolation of held read views. fake-indexeddb is mechanism
// evidence only; native three-engine evidence belongs to slice 14f.

type RoomPreparation = Readonly<{ state: "ready" | "migrating" }>;
interface RoomSchemaModule {
	prepareBrowserRoomDatabase(input: Readonly<{ databaseName: string }>): Promise<RoomPreparation>;
	openPhase2dBrowserDatabase(input: Readonly<{ databaseName: string }>): Promise<{ version: number; close(): void }>;
	openPhase2dInternalDatabase(input: Readonly<{ databaseName: string }>, onVersionChange: () => void): Promise<unknown>;
}
const schema = schemaModule as unknown as RoomSchemaModule;
const prepare = (databaseName: string): Promise<RoomPreparation> => {
	const prepareRoom = Reflect.get(schemaModule, "prepareBrowserRoomDatabase") as
		| RoomSchemaModule["prepareBrowserRoomDatabase"]
		| undefined;
	if (typeof prepareRoom !== "function") return Promise.reject(new Error("prepareBrowserRoomDatabase is missing"));
	return prepareRoom({ databaseName });
};

type StoreShape = Readonly<{
	keyPath: string | readonly string[] | null;
	indexes: readonly Readonly<{ name: string; keyPath: string | readonly string[]; unique: boolean }>[];
}>;
const plain = (keyPath: string | readonly string[] | null): StoreShape => ({ keyPath, indexes: [] });
const SIGNING_AND_LEGACY: Readonly<Record<string, StoreShape>> = {
	objects: plain("objectId"),
	generations: plain(["objectId", "generationId"]),
	blobs: plain("digest"),
	promotions: plain(["objectId", "generationId", "digest"]),
	storageMeta: plain("key"),
	voteSlots: plain(["objectId", "epoch", "round", "phase", "signerId"]),
	signerState: plain(["objectId", "epoch", "signerId"]),
	voteOutbox: plain(["objectId", "epoch", "round", "phase", "signerId"]),
	sealEvidence: plain(["objectId", "epoch", "signerId"]),
};
const ROOM_CATALOG: Readonly<Record<string, StoreShape>> = {
	...SIGNING_AND_LEGACY,
	"ahe:objects": plain("objectId"),
	"ahe:generations": plain(["objectId", "generationId"]),
	"ahe:blobs": plain("digest"),
	"ahe:promotions": plain(["objectId", "generationId", "digest"]),
	"ahe:storageMeta": plain("key"),
	"snapshot:scopes": {
		keyPath: ["objectId", "epoch", "anchor", "manifestDigest"],
		indexes: [{ name: "expiryAsc", keyPath: "expiresAt", unique: false }],
	},
	"snapshot:chunks": plain(["objectId", "epoch", "anchor", "manifestDigest", "index"]),
	"snapshot:owner": plain("id"),
	"snapshot:retirementControls": plain(null),
	"journal:scopes": plain(["objectId", "epoch", "anchorDigest"]),
	"journal:acceptedEntries": {
		keyPath: ["objectId", "epoch", "anchorDigest", "journalSequence"],
		indexes: [
			{ name: "digestUniq", keyPath: ["objectId", "epoch", "anchorDigest", "vertexDigest"], unique: true },
			{
				name: "localRefUniq",
				keyPath: ["objectId", "epoch", "anchorDigest", "localAuthor", "localAuthorSequence"],
				unique: true,
			},
		],
	},
	"journal:retirementControls": plain("objectId"),
	"issuance:lineages": plain(["objectId", "author"]),
	"issuance:settlementPlans": plain(["objectId", "author"]),
	"issuance:issuedRecords": plain(["objectId", "author", "authorSequence"]),
	"issuance:issuanceOutbox": plain(["objectId", "author", "authorSequence"]),
	"issuance:retirementControls": plain("objectId"),
	"room:layout": plain(null),
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
async function rawOpen(name: string): Promise<IDBDatabase> {
	return request(indexedDB.open(name));
}
function keyPathOf(value: string | string[] | null): string | readonly string[] | null {
	return Array.isArray(value) ? [...value] : value;
}
async function catalog(name: string): Promise<Readonly<{ version: number; stores: Record<string, unknown> }>> {
	const db = await rawOpen(name);
	try {
		const names = [...db.objectStoreNames];
		const stores: Record<string, unknown> = {};
		if (names.length > 0) {
			const tx = db.transaction(names, "readonly");
			for (const storeName of names) {
				const store = tx.objectStore(storeName);
				expect(store.autoIncrement).toBe(false);
				stores[storeName] = {
					keyPath: keyPathOf(store.keyPath),
					indexes: [...store.indexNames].map((indexName) => {
						const index = store.index(indexName);
						expect(index.multiEntry).toBe(false);
						return { name: indexName, keyPath: keyPathOf(index.keyPath), unique: index.unique };
					}),
				};
			}
			await terminal(tx);
		}
		return { version: db.version, stores };
	} finally {
		db.close();
	}
}
async function rows(name: string, store: string): Promise<readonly Readonly<{ key: IDBValidKey; value: unknown }>[]> {
	const db = await rawOpen(name);
	try {
		const tx = db.transaction(store, "readonly"),
			done = terminal(tx);
		const [keys, values] = await Promise.all([
			request(tx.objectStore(store).getAllKeys()),
			request(tx.objectStore(store).getAll()),
		]);
		await done;
		return keys.map((key, index) => ({ key, value: values[index] }));
	} finally {
		db.close();
	}
}
function layoutValue(entries: readonly Readonly<{ key: IDBValidKey; value: unknown }>[], key: string): unknown {
	const entry = entries.find((candidate) => candidate.key === key);
	if (entry === undefined) return undefined;
	expect(entry.value).toBeInstanceOf(Uint8Array);
	return decodeCanonical(entry.value as Uint8Array);
}
let counter = 0;
const fresh = (label: string): string => `room-format-${label}-${++counter}`;

describe("14a room database format", () => {
	it("creates exactly the version-7 room catalog and a ready layout from an empty database", async () => {
		const name = fresh("empty");
		await expect(prepare(name)).resolves.toEqual({ state: "ready" });
		const observed = await catalog(name);
		expect(observed.version).toBe(7);
		expect(Object.keys(observed.stores).sort()).toEqual(Object.keys(ROOM_CATALOG).sort());
		for (const [storeName, shape] of Object.entries(ROOM_CATALOG)) expect(observed.stores[storeName]).toEqual(shape);
		const layout = await rows(name, "room:layout");
		expect(layout.map((entry) => entry.key).sort()).toEqual(["layout", "ready"]);
		expect(layoutValue(layout, "layout")).toEqual({ version: 1, kind: "room-database-layout-1" });
		expect(layoutValue(layout, "ready")).toEqual({ version: 1, kind: "room-database-ready-1", sources: [] });
		for (const meta of ["storageMeta", "ahe:storageMeta"]) {
			const metadata = await rows(name, meta);
			expect(metadata).toHaveLength(1);
			expect(metadata[0]?.key).toBe("incarnation");
			expect(metadata[0]?.value).toEqual({ key: "incarnation", value: expect.stringMatching(/^[0-9a-f]{32}$/u) });
		}
		const incarnations = await Promise.all(
			["storageMeta", "ahe:storageMeta"].map(async (meta) => (await rows(name, meta))[0]?.value)
		);
		expect(incarnations[0]).not.toEqual(incarnations[1]);
	});

	it("upgrades a version-6 room database to a migrating layout and keeps every version-6 row", async () => {
		const name = fresh("v6");
		const legacy = await schema.openPhase2dBrowserDatabase({ databaseName: name });
		legacy.close();
		const before = await rows(name, "storageMeta");
		expect(before).toHaveLength(1);
		await expect(prepare(name)).resolves.toEqual({ state: "migrating" });
		const observed = await catalog(name);
		expect(observed.version).toBe(7);
		expect(Object.keys(observed.stores).sort()).toEqual(Object.keys(ROOM_CATALOG).sort());
		expect(await rows(name, "storageMeta")).toEqual(before);
		const layout = await rows(name, "room:layout");
		expect(layout.map((entry) => entry.key)).toEqual(["layout"]);
		expect(layoutValue(layout, "layout")).toEqual({ version: 1, kind: "room-database-layout-1" });
		// A second preparation observes the same migrating layout and writes nothing.
		await expect(prepare(name)).resolves.toEqual({ state: "migrating" });
		expect(await rows(name, "room:layout")).toEqual(layout);
	});

	it("is idempotent on a ready version-7 database", async () => {
		const name = fresh("ready");
		await prepare(name);
		const layout = await rows(name, "room:layout");
		const meta = await rows(name, "ahe:storageMeta");
		await expect(prepare(name)).resolves.toEqual({ state: "ready" });
		expect(await rows(name, "room:layout")).toEqual(layout);
		expect(await rows(name, "ahe:storageMeta")).toEqual(meta);
	});

	it("refuses unsupported versions and catalogs with zero changes", async () => {
		// A version-5 database: the room upgrade only starts from 0 or 6.
		const v5 = fresh("v5");
		const opened = await request(
			(() => {
				const r = indexedDB.open(v5, 5);
				r.onupgradeneeded = (): void => {
					r.result.createObjectStore("storageMeta", { keyPath: "key" });
				};
				return r;
			})()
		);
		opened.close();
		await expect(prepare(v5)).rejects.toMatchObject({ code: "UNEXPECTED_SCHEMA_VERSION" });
		expect(await catalog(v5)).toEqual({ version: 5, stores: { storageMeta: plain("key") } });

		// A version-6 database with an unexpected extra store.
		const rebuilt = fresh("v6-extra");
		const raw = await request(
			(() => {
				const r = indexedDB.open(rebuilt, 6);
				r.onupgradeneeded = (): void => {
					for (const [storeName, shape] of Object.entries(SIGNING_AND_LEGACY))
						r.result.createObjectStore(storeName, {
							keyPath: Array.isArray(shape.keyPath) ? [...shape.keyPath] : (shape.keyPath as string),
						});
					r.result.createObjectStore("unexpected");
				};
				return r;
			})()
		);
		raw.close();
		const rebuiltBefore = await catalog(rebuilt);
		await expect(prepare(rebuilt)).rejects.toMatchObject({ code: "UNEXPECTED_SCHEMA_VERSION" });
		expect(await catalog(rebuilt)).toEqual(rebuiltBefore);

		// A version-7 database that is not the room catalog.
		const foreign = fresh("v7-foreign");
		const seven = await request(
			(() => {
				const r = indexedDB.open(foreign, 7);
				r.onupgradeneeded = (): void => {
					r.result.createObjectStore("room:layout");
				};
				return r;
			})()
		);
		seven.close();
		await expect(prepare(foreign)).rejects.toMatchObject({ code: "UNEXPECTED_SCHEMA_VERSION" });
		expect(await catalog(foreign)).toEqual({ version: 7, stores: { "room:layout": plain(null) } });
	});

	it("fences version-6 code out of a version-7 room database and closes open version-6 connections", async () => {
		const name = fresh("fence");
		let closedByVersionChange = false;
		await schema.openPhase2dInternalDatabase({ databaseName: name }, () => {
			closedByVersionChange = true;
		});
		await expect(prepare(name)).resolves.toEqual({ state: "migrating" });
		expect(closedByVersionChange).toBe(true);
		await expect(schema.openPhase2dBrowserDatabase({ databaseName: name })).rejects.toMatchObject({
			code: "UNEXPECTED_SCHEMA_VERSION",
		});
		expect((await catalog(name)).version).toBe(7);
	});
});
