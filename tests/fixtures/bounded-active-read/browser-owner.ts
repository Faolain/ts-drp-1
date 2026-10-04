/* eslint-disable jsdoc/require-jsdoc -- Test-owned AHE result/key visibility extension. */
import { check, type Edit, type Environment, type Image, OBJECT, type Trace } from "./contract.js";
import { createBrowserAheDurableStore } from "../../../packages/storage-browser/dist/src/index.js";
import { observeIDB } from "../../../packages/storage-browser/tests/assets/snapshot-declaration-discovery-entry.js";

export function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.addEventListener("success", () => resolve(value.result));
		value.addEventListener("error", () => reject(value.error));
	});
}
export function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.addEventListener("complete", () => resolve());
		tx.addEventListener("abort", () => reject(tx.error ?? new Error("native abort")));
	});
}
export async function database(name: string): Promise<IDBDatabase> {
	return request(indexedDB.open(name));
}
export function environment(name: string): Environment {
	async function use<T>(action: (db: IDBDatabase) => Promise<T>): Promise<T> {
		const db = await database(name);
		try {
			return await action(db);
		} finally {
			db.close();
		}
	}
	const observe: Environment["observe"] = async (action, boundary, nativeHook) => {
		const transaction = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "transaction"),
			descriptors = new Map<string, PropertyDescriptor>();
		check(transaction, "native transaction descriptor present");
		const reads: Trace["reads"] = [],
			terminalKinds: string[] = [],
			materialEvents: string[] = [];
		Object.defineProperty(IDBDatabase.prototype, "transaction", {
			...transaction,
			value: function (this: IDBDatabase, ...args: unknown[]): IDBTransaction {
				const tx = Reflect.apply(transaction.value as (...args: unknown[]) => IDBTransaction, this, args);
				boundary?.("start");
				tx.addEventListener("complete", () => {
					terminalKinds.push("complete");
					boundary?.("terminal");
				});
				tx.addEventListener("abort", () => {
					terminalKinds.push("abort");
					boundary?.("terminal");
				});
				return tx;
			},
		});
		for (const method of ["get", "getAllKeys", "getKey", "openCursor", "openKeyCursor"]) {
			const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, method);
			check(descriptor, "native object-store descriptor present");
			descriptors.set(method, descriptor);
			Object.defineProperty(IDBObjectStore.prototype, method, {
				...descriptor,
				value: function (this: IDBObjectStore, ...args: unknown[]): IDBRequest {
					const native = Reflect.apply(descriptor.value as (...args: unknown[]) => IDBRequest, this, args),
						table = this.name;
					if (table === "blobs" && method === "get") materialEvents.push("request:" + String(args[0]));
					nativeHook?.("request", table, method, () => this.transaction.abort(), args[0]);
					const fields: NonNullable<Trace["reads"][number]["fields"]> = [];
					const entry: Trace["reads"][number] = { table, operation: method, query: args[0], fields };
					reads.push(entry);
					native.addEventListener("success", () => {
						if (table === "blobs" && method === "get") materialEvents.push("success:" + String(args[0]));
						nativeHook?.("success", table, method, () => this.transaction.abort(), args[0]);
						const value: unknown = native.result;
						if (value && typeof value === "object" && !Array.isArray(value)) {
							for (const [field, bytes] of Object.entries(value))
								if (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)
									fields.push({ name: field, type: "bytes", bytes: bytes.byteLength });
						}
						if (method !== "get") {
							const key = value instanceof IDBCursor ? value.key : value;
							fields.push({
								name: "native_key_shape",
								type: Array.isArray(key) ? "array" : typeof key,
								value: key instanceof ArrayBuffer ? { nativeBinaryBytes: key.byteLength } : key,
							});
						}
					});
					return native;
				},
			});
		}
		try {
			const observed = await observeIDB(action as () => Promise<unknown>);
			let next = 0;
			return {
				value: observed.value as Awaited<ReturnType<typeof action>>,
				evidence: {
					modes: observed.evidence.modes,
					writes: observed.evidence.writes,
					terminals: observed.evidence.completes + observed.evidence.aborts,
					terminalKinds,
					materialEvents,
					transactionStores: observed.evidence.transactionStores,
					reads: observed.evidence.reads.map((read) => {
						const materialized = reads[next];
						if (materialized?.table === read.table && materialized.operation === read.operation) {
							next++;
							return { ...read, fields: materialized.fields };
						}
						return read;
					}),
				},
			};
		} finally {
			Object.defineProperty(IDBDatabase.prototype, "transaction", transaction);
			for (const [method, descriptor] of descriptors)
				Object.defineProperty(IDBObjectStore.prototype, method, descriptor);
		}
	};
	return {
		backend: "idb",
		open: () => createBrowserAheDurableStore({ databaseName: name }),
		observe,
		image: (): Promise<Image> =>
			use(async (db) => {
				const tx = db.transaction(["objects", "generations", "blobs", "promotions"], "readonly"),
					completion = done(tx);
				const [heads, generations, blobs, promotions] = await Promise.all(
					["objects", "generations", "blobs", "promotions"].map((table) => request(tx.objectStore(table).getAll()))
				);
				await completion;
				return { heads, generations, blobs, promotions } as Image;
			}),
		edit: (value: Edit): Promise<void> =>
			use(async (db) => {
				const table =
					value.kind === "head"
						? "objects"
						: value.kind === "generation" || value.kind === "delete-generation"
							? "generations"
							: value.kind === "blob"
								? "blobs"
								: "promotions";
				const tx = db.transaction(table, "readwrite"),
					completion = done(tx),
					store = tx.objectStore(table);
				if (value.kind === "head") store.put({ objectId: OBJECT, record: value.record });
				if (value.kind === "generation") {
					if (!value.insert) store.delete([OBJECT, value.generationId] as IDBValidKey[]);
					store.put({ objectId: OBJECT, generationId: value.replaceId ?? value.generationId, record: value.record });
				}
				if (value.kind === "delete-generation") store.delete([OBJECT, value.generationId] as IDBValidKey[]);
				if (value.kind === "blob") {
					if (value.bytes === null) store.delete(value.digest);
					else store.put({ digest: value.digest, bytes: value.bytes });
				}
				if (value.kind === "promotion") {
					if (value.add) store.put({ objectId: OBJECT, generationId: value.generationId, digest: value.digest });
					else store.delete([OBJECT, value.generationId, value.digest] as IDBValidKey[]);
				}
				await completion;
			}),
		control: async (): Promise<Trace> =>
			(
				await observe(() =>
					use(async (db) => {
						const tx = db.transaction(["generations", "blobs"], "readonly"),
							completion = done(tx);
						// Keys-only census includes nested arrays above the legacy upper bound; no value scan.
						const rows = await request(tx.objectStore("generations").getAllKeys(IDBKeyRange.lowerBound([OBJECT]), 8));
						if (rows.length === 0) throw new Error("native control exact keys absent");
						await completion;
					})
				)
			).evidence,
	};
}
