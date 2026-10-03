/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/explicit-function-return-type -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
/* eslint-disable jsdoc/require-jsdoc -- Native IndexedDB setup mutations and identity-preserving observation. */
import { decodeHeadRecordV1, encodeHeadRecordV1 } from "@ts-drp/storage";

import { requireThat } from "./proof.js";
import type { Floor, NativeImage, NativePort } from "./types.js";
import { database, done, request } from "../bounded-active-read/browser-owner.js";
const fixtureDatabases = new WeakSet<IDBDatabase>();
async function use<T>(name: string, call: (db: IDBDatabase) => Promise<T>): Promise<T> {
	const db = await database(name);
	fixtureDatabases.add(db);
	try {
		return await call(db);
	} finally {
		db.close();
	}
}
export function browserPort(identity: string): NativePort {
	const ahe = identity + "--ahe",
		snapshot = identity + "--drp-snapshot-quarantine-v1",
		journal = identity + "--drp-live-journal-v1",
		floor = identity + "--host-floor";
	return {
		image: () =>
			use(ahe, async (db) => {
				const tables = ["objects", "generations", "blobs", "promotions"],
					tx = db.transaction(tables, "readonly"),
					terminal = done(tx);
				const rows = await Promise.all(tables.map((t) => request(tx.objectStore(t).getAll())));
				await terminal;
				return { heads: rows[0], generations: rows[1], blobs: rows[2], promotions: rows[3] } as NativeImage;
			}),
		replace: (image) =>
			use(ahe, async (db) => {
				const tables = ["objects", "generations", "blobs", "promotions"],
					tx = db.transaction(tables, "readwrite"),
					terminal = done(tx);
				const values = [image.heads, image.generations, image.blobs, image.promotions];
				for (let i = 0; i < tables.length; i++) {
					const store = tx.objectStore(tables[i]!);
					store.clear();
					for (const r of values[i]!) store.put(r);
				}
				await terminal;
			}),
		readFloor: () =>
			use(floor, async (db) => {
				const tx = db.transaction("floor", "readonly"),
					terminal = done(tx),
					state = await request(tx.objectStore("floor").get(1));
				await terminal;
				return (state?.state ?? null) as Floor | null;
			}),
		writeFloor: async (state) => {
			const opening = indexedDB.open(floor, 1);
			opening.addEventListener("upgradeneeded", () => opening.result.createObjectStore("floor", { keyPath: "id" }));
			const db = await request(opening);
			fixtureDatabases.add(db);
			try {
				const tx = db.transaction("floor", "readwrite"),
					terminal = done(tx);
				tx.objectStore("floor").put({ id: 1, state });
				await terminal;
			} finally {
				db.close();
			}
		},
		snapshotFault: (fault, objectId, epoch) =>
			use(snapshot, async (db) => {
				const tx = db.transaction(["scopes", "chunks", "owner"], "readwrite"),
					terminal = done(tx),
					scopes = tx.objectStore("scopes"),
					chunks = tx.objectStore("chunks"),
					owner = tx.objectStore("owner");
				const matches = (await request(scopes.getAll())).filter((r) => r.objectId === objectId && r.epoch === epoch);
				requireThat(matches.length === 1, "unique actual snapshot mutation");
				const r = matches[0],
					key = [objectId, epoch, r.anchor, r.manifestDigest],
					range = IDBKeyRange.bound([...key, 0], [...key, Number.MAX_SAFE_INTEGER]);
				if (fault === "older-missing-chunk") chunks.delete(range);
				else if (fault === "older-corrupt-chunk") {
					const actual = (await request(chunks.getAll(range)))[0];
					requireThat(actual, "actual old chunk");
					actual.exactBytes = Uint8Array.from(actual.exactBytes);
					actual.exactBytes[actual.exactBytes.length - 1] ^= 1;
					chunks.put(actual);
				} else if (fault === "older-replaced") scopes.put({ ...r, incarnation: "replacement-" + Date.now() });
				else {
					const o = await request(owner.get("owner"));
					o.recoveryScopes--;
					o.recoveryContentBytes -= r.totalBytes + r.exactCanonicalManifestBytes.length;
					if (fault === "older-missing-manifest") {
						scopes.delete(key);
						chunks.delete(range);
					} else if (fault === "legacy" || fault === "not-ready") {
						o.legacyUnclassifiedScopes++;
						o.legacyUnclassifiedContentBytes += r.totalBytes + r.exactCanonicalManifestBytes.length;
						scopes.put({ ...r, retention: "legacy-unclassified", descriptors: null });
					} else scopes.put({ ...r, retention: "temporary", state: fault === "open" ? "open" : "verified" });
					owner.put(o);
				}
				await terminal;
			}),
		journalFault: (fault, objectId, epoch) =>
			use(journal, async (db) => {
				const tx = db.transaction("scopes", "readwrite"),
					terminal = done(tx),
					store = tx.objectStore("scopes"),
					rows = await request(store.getAll());
				for (const r of rows)
					if (r.objectId === objectId && r.epoch === epoch) {
						if (fault === "missing-anchor" || fault === "anchor-neighbor")
							store.delete([objectId, epoch, r.anchorDigest]);
						if (fault === "anchor-neighbor") store.put({ ...r, anchorDigest: "e".repeat(64) });
						if (fault === "anchor-cap") store.put({ ...r, exactCanonicalAnchorPreimageBytes: new Uint8Array(8193) });
					}
				await terminal;
			}),
		prepareReplacement: async (objectId, epoch) => {
			const db = await database(snapshot),
				read = db.transaction("scopes", "readonly"),
				readTerminal = done(read),
				rows = await request(read.objectStore("scopes").getAll());
			await readTerminal;
			const matches = rows.filter((r) => r.objectId === objectId && r.epoch === epoch);
			requireThat(matches.length === 1, "actual replacement scope");
			fixtureDatabases.add(db);
			return {
				run: () => {
					const tx = db.transaction("scopes", "readwrite"),
						terminal = done(tx);
					tx.objectStore("scopes").put({ ...matches[0], incarnation: "replacement-" + Date.now() });
					return terminal;
				},
				close: () => {
					db.close();
					return Promise.resolve();
				},
			};
		},
		prepareStaleHead: async (objectId) => {
			const db = await database(ahe);
			fixtureDatabases.add(db);
			const read = db.transaction("objects", "readonly"),
				terminal = done(read),
				row = await request(read.objectStore("objects").get(objectId));
			await terminal;
			requireThat(row, "actual head row");
			const h = decodeHeadRecordV1(row.record);
			requireThat(h.ok && h.value.kind === "present", "actual head metadata");
			const record = encodeHeadRecordV1({ ...h.value, revision: (h.value.revision + 1) as typeof h.value.revision });
			return {
				run: () => {
					const tx = db.transaction("objects", "readwrite"),
						settled = done(tx);
					tx.objectStore("objects").put({ ...row, record });
					return settled;
				},
				close: () => {
					db.close();
					return Promise.resolve();
				},
			};
		},
		observe: async <T>(call: () => Promise<T>, nativeChunk?: () => void) => {
			const transaction = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "transaction")!,
				originals = new Map(
					["get", "getAll", "getAllKeys", "getKey", "openCursor", "openKeyCursor", "put", "add", "delete", "clear"].map(
						(m) => [m, Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, m)!]
					)
				);
			const empty = () => ({ modes: [] as string[], terminals: [] as string[], writes: 0, reads: [] as unknown[] });
			const evidence = { ...empty(), fixture: empty() };
			Object.defineProperty(IDBDatabase.prototype, "transaction", {
				...transaction,
				value: function (this: IDBDatabase, ...args: unknown[]) {
					const tx = Reflect.apply(transaction.value, this, args) as IDBTransaction;
					const target = fixtureDatabases.has(this) ? evidence.fixture : evidence;
					target.modes.push(tx.mode);
					tx.addEventListener("complete", () => target.terminals.push("complete"));
					tx.addEventListener("abort", () => target.terminals.push("abort"));
					return tx;
				},
			});
			for (const [m, d] of originals)
				Object.defineProperty(IDBObjectStore.prototype, m, {
					...d,
					value: function (this: IDBObjectStore, ...args: unknown[]) {
						const fixture = fixtureDatabases.has(this.transaction.db),
							target = fixture ? evidence.fixture : evidence;
						const native = Reflect.apply(d.value, this, args) as IDBRequest;
						if (["put", "add", "delete", "clear"].includes(m)) target.writes++;
						else {
							const entry = { table: this.name, operation: m, parameters: args, terminal: "pending", nativeBytes: 0 };
							target.reads.push(entry);
							native.addEventListener("success", () => {
								entry.terminal = "success";
								const r = native.result;
								if (r && typeof r === "object")
									for (const v of Object.values(r)) if (v instanceof Uint8Array) entry.nativeBytes += v.length;
								if (!fixture && this.name === "chunks" && m === "get" && r) nativeChunk?.();
							});
							native.addEventListener("error", () => (entry.terminal = "error"));
						}
						return native;
					},
				});
			try {
				return { value: await call(), evidence };
			} finally {
				Object.defineProperty(IDBDatabase.prototype, "transaction", transaction);
				for (const [m, d] of originals) Object.defineProperty(IDBObjectStore.prototype, m, d);
			}
		},
	};
}
