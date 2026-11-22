import {
	bounded,
	check,
	type DiscoveryEnvironment,
	type Key,
	type Observation,
	reader,
	type Row,
	runDiscoveryCase,
} from "../../../../tests/fixtures/snapshot-declaration-discovery/contract.js";
import { fixture, receiptFor, stable } from "../../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import { createBrowserSnapshotQuarantineStore } from "../../src/snapshot-transfer.js";
import { createBrowserSnapshotQuarantineStore as createLegacy } from "../fixtures/legacy-snapshot-transfer.mjs";

const suffix = "--drp-snapshot-quarantine-v1";
function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.addEventListener("success", () => resolve(value.result), { once: true });
		value.addEventListener("error", () => reject(value.error), { once: true });
	});
}
function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.addEventListener("complete", () => resolve(), { once: true });
		tx.addEventListener("abort", () => reject(tx.error ?? new Error("native abort")), { once: true });
	});
}
function tuple(key: Key): IDBValidKey[] {
	return [key.objectId, key.epoch, key.anchor, key.manifestDigest];
}
function queryImage(value: unknown): unknown {
	if (value instanceof IDBKeyRange)
		return {
			lower: queryImage(value.lower),
			upper: queryImage(value.upper),
			lowerOpen: value.lowerOpen,
			upperOpen: value.upperOpen,
		};
	if (value instanceof Uint8Array || value instanceof ArrayBuffer) return { binaryBytes: value.byteLength };
	if (value instanceof Date) return { date: value.getTime() };
	if (Array.isArray(value)) return value.map(queryImage);
	return value;
}
export interface IDBObservation extends Observation {
	cursorAdvances: number;
	completes: number;
	aborts: number;
	transactionStores: string[][];
	values: { table: string; operation: string; present: boolean }[];
}
/**
 *
 * @param action
 */
export async function observeIDB(
	action: () => Promise<unknown>
): Promise<{ value: unknown; evidence: IDBObservation }> {
	const evidence: IDBObservation = {
		transactions: 0,
		modes: [],
		reads: [],
		writes: 0,
		terminal: false,
		cursorAdvances: 0,
		completes: 0,
		aborts: 0,
		transactionStores: [],
		values: [],
	};
	const restorers: (() => void)[] = [];
	const wrap = (
		prototype: object,
		name: string,
		create: (original: (...args: unknown[]) => unknown) => (this: unknown, ...args: unknown[]) => unknown
	): void => {
		const original = Object.getOwnPropertyDescriptor(prototype, name);
		if (!original || typeof original.value !== "function")
			throw new Error(`native instrumentation cannot wrap ${name}`);
		Object.defineProperty(prototype, name, {
			...original,
			value: create(original.value as (...args: unknown[]) => unknown),
		});
		restorers.push(() => Object.defineProperty(prototype, name, original));
	};
	wrap(
		IDBDatabase.prototype,
		"transaction",
		(original) =>
			function (...args): unknown {
				const tx = Reflect.apply(original, this, args) as IDBTransaction;
				evidence.transactions++;
				evidence.modes.push(tx.mode);
				evidence.transactionStores.push([...tx.objectStoreNames]);
				tx.addEventListener(
					"complete",
					() => {
						evidence.terminal = true;
						evidence.completes++;
					},
					{ once: true }
				);
				tx.addEventListener(
					"abort",
					() => {
						evidence.terminal = true;
						evidence.aborts++;
					},
					{ once: true }
				);
				return tx;
			}
	);
	for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype])
		for (const operation of ["get", "getAll", "getKey", "getAllKeys", "openCursor", "openKeyCursor", "count"]) {
			wrap(
				prototype,
				operation,
				(original) =>
					function (...args): unknown {
						const owner = this as IDBObjectStore | IDBIndex;
						const table = owner instanceof IDBIndex ? owner.objectStore.name : owner.name;
						evidence.reads.push({
							operation,
							table,
							query: queryImage(args[0]),
							...(typeof args[1] === "number" ? { count: args[1] } : {}),
						});
						const result = Reflect.apply(original, this, args) as IDBRequest<unknown>;
						result.addEventListener("success", () => {
							evidence.values.push({
								table,
								operation,
								present: result.result !== undefined && result.result !== null,
							});
						});
						return result;
					}
			);
		}
	for (const operation of ["put", "add", "delete", "clear"])
		wrap(
			IDBObjectStore.prototype,
			operation,
			(original) =>
				function (...args): unknown {
					evidence.writes++;
					return Reflect.apply(original, this, args);
				}
		);
	for (const operation of ["continue", "advance", "continuePrimaryKey"])
		wrap(
			IDBCursor.prototype,
			operation,
			(original) =>
				function (...args): unknown {
					evidence.cursorAdvances++;
					return Reflect.apply(original, this, args);
				}
		);
	try {
		return { value: await action(), evidence };
	} finally {
		for (const restore of restorers.reverse()) restore();
	}
}
/**
 *
 * @param primaryDatabaseName
 */
export function browserEnvironment(primaryDatabaseName: string): DiscoveryEnvironment {
	const name = primaryDatabaseName + suffix;
	const use = async <T>(
		stores: string[],
		mode: IDBTransactionMode,
		action: (tx: IDBTransaction) => Promise<T>
	): Promise<T> => {
		const db = await request(indexedDB.open(name));
		try {
			const tx = db.transaction(stores, mode);
			const terminal = done(tx);
			const result = await action(tx);
			await terminal;
			return result;
		} finally {
			db.close();
		}
	};
	return {
		backend: "indexeddb",
		open: () => createBrowserSnapshotQuarantineStore({ primaryDatabaseName }),
		legacy: () => createLegacy({ primaryDatabaseName }),
		image: () =>
			use(["owner", "scopes", "chunks"], "readonly", async (tx) => ({
				version: tx.db.version,
				schema: [...tx.db.objectStoreNames].map((name) => {
					const store = tx.objectStore(name);
					return {
						name,
						keyPath: store.keyPath,
						indexes: [...store.indexNames].map((name) => {
							const index = store.index(name);
							return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
						}),
					};
				}),
				owner: await request(tx.objectStore("owner").getAll()),
				scopes: await request(tx.objectStore("scopes").getAll()),
				chunks: await request(tx.objectStore("chunks").getAll()),
			})),
		row: (key) =>
			use(["scopes"], "readonly", async (tx) => {
				const row = (await request(tx.objectStore("scopes").get(tuple(key)))) as Row | undefined;
				if (!row) throw new Error("exact fixture row absent");
				return {
					...row,
					descriptors: Array.isArray(row.descriptors) ? JSON.stringify(row.descriptors) : row.descriptors,
				};
			}),
		put: (row) =>
			use(["scopes"], "readwrite", async (tx) => {
				let descriptors = row.descriptors;
				if (typeof descriptors === "string") {
					try {
						descriptors = JSON.parse(descriptors) as unknown;
					} catch {
						/* Preserve hostile storage representation. */
					}
				}
				await request(tx.objectStore("scopes").put({ ...row, descriptors }));
			}),
		remove: (key) =>
			use(["scopes", "chunks"], "readwrite", async (tx) => {
				await request(tx.objectStore("scopes").delete(tuple(key)));
				const chunks = tx.objectStore("chunks");
				const keys = await request(
					chunks.getAllKeys(IDBKeyRange.bound([...tuple(key), -Infinity], [...tuple(key), []]))
				);
				for (const chunk of keys) await request(chunks.delete(chunk));
			}),
		chunks: (key, operation) =>
			use(["chunks"], "readwrite", async (tx) => {
				const chunks = tx.objectStore("chunks");
				const rows = (await request(
					chunks.getAll(IDBKeyRange.bound([...tuple(key), -Infinity], [...tuple(key), []]))
				)) as Row[];
				for (const row of rows) {
					if (operation === "delete") await request(chunks.delete([...tuple(key), Number(row.index)]));
					else
						await request(
							chunks.put({
								...row,
								...(operation === "descriptor"
									? { digest: "invalid" }
									: { exactBytes: new Uint8Array(Number(row.byteLength)) }),
							})
						);
				}
			}),
		observe: observeIDB,
		failStorage: async (action): Promise<unknown> => {
			const original = IDBDatabase.prototype.transaction;
			let reached = false;
			IDBDatabase.prototype.transaction = function (): IDBTransaction {
				reached = true;
				throw new DOMException("injected native transaction failure", "UnknownError");
			};
			try {
				return await action();
			} finally {
				IDBDatabase.prototype.transaction = original;
				check(reached, true, "native failure hook reached");
			}
		},
		nativeControl: async (): Promise<unknown> => {
			const store = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
			await store.close();
			const missingKey: Key = { objectId: "none", epoch: 1, anchor: "a", manifestDigest: "b" };
			const observed = await observeIDB(() =>
				use(["scopes", "chunks"], "readonly", async (tx) => {
					await request(tx.objectStore("scopes").get(["none", 1, "a", "b"]));
					await request(tx.objectStore("chunks").getAll());
				})
			);
			check(
				observed.evidence.reads.map((read) => read.table),
				["scopes", "chunks"],
				"actual native observation"
			);
			let rejected = false;
			try {
				bounded(observed.evidence, true, "indexeddb", missingKey);
			} catch {
				rejected = true;
			}
			check(rejected, true, "validator rejects forbidden native chunk read");
			await use(["scopes"], "readwrite", async (tx) => {
				await request(
					tx.objectStore("scopes").put({ objectId: "control", epoch: 1, anchor: "a", manifestDigest: "b" })
				);
			});
			const exactKey: Key = { objectId: "control", epoch: 1, anchor: "a", manifestDigest: "b" };
			const exactTuple = tuple(exactKey);
			for (const [query, refuse] of [
				[exactTuple, false],
				[IDBKeyRange.only(exactTuple), false],
				[exactTuple.slice(0, 3), true],
				[
					IDBKeyRange.bound(
						exactTuple.slice(0, 3),
						[exactKey.objectId, exactKey.epoch, exactKey.anchor + "\0"],
						false,
						true
					),
					true,
				],
				[[exactKey.objectId, exactKey.epoch, exactKey.anchor, "wrong-digest"], true],
			] as [IDBValidKey | IDBKeyRange, boolean][]) {
				const observed = await observeIDB(() =>
					use(["scopes"], "readonly", async (tx) => {
						await request(tx.objectStore("scopes").get(query));
					})
				);
				let detected = false;
				try {
					bounded(observed.evidence, true, "indexeddb", exactKey);
				} catch {
					detected = true;
				}
				check(detected, refuse, "native exact-get selector control");
			}
			for (const advance of [false, true]) {
				const probe = await observeIDB(() =>
					use(["scopes"], "readonly", async (tx) => {
						await request(tx.objectStore("scopes").get(["none", 1, "a", "b"]));
						await new Promise<void>((resolve, reject) => {
							const cursor = tx.objectStore("scopes").openKeyCursor();
							cursor.onerror = (): void => reject(cursor.error);
							cursor.onsuccess = (): void => {
								if (advance && cursor.result) cursor.result.continue();
								else resolve();
							};
						});
					})
				);
				check(probe.evidence.cursorAdvances, advance ? 1 : 0, "actual native cursor advance telemetry");
				let detected = false;
				try {
					bounded(probe.evidence, false, "indexeddb", missingKey);
				} catch {
					detected = true;
				}
				check(detected, advance, "validator accepts stopped cursor and rejects native continuation");
			}
			return { native: true, instrumented: true, invalidObservationRejected: true };
		},
	};
}
async function run(name: string, setupOnly = false): Promise<unknown> {
	const primaryDatabaseName = `discovery-${crypto.randomUUID()}`;
	try {
		return await runDiscoveryCase(name, browserEnvironment(primaryDatabaseName), setupOnly);
	} finally {
		await request(indexedDB.deleteDatabase(primaryDatabaseName + suffix));
	}
}
async function seedFresh(primaryDatabaseName: string): Promise<unknown> {
	const env = browserEnvironment(primaryDatabaseName);
	const store = await env.open();
	const selected = fixture("discovery-fresh");
	try {
		const scope = await store.openScope(selected.declaration);
		await scope.complete(await receiptFor(scope, selected));
		await scope.retainForRecovery();
		return {
			key: selected.declaration.scope,
			expected: {
				kind: "present",
				declaration: selected.declaration,
				state: "verified",
				retention: "recovery",
				expiresAt: (await scope.status()).expiresAt,
			},
			image: stable(await env.image()),
		};
	} finally {
		await store.close();
	}
}
async function fresh(input: { primaryDatabaseName: string; key: Key }): Promise<unknown> {
	check(Object.keys(input).sort(), ["key", "primaryDatabaseName"], "fresh caller exact boundary");
	const env = browserEnvironment(input.primaryDatabaseName);
	const store = await env.open();
	try {
		return { result: await reader(store).lookupRecoveryDeclaration(input.key), image: stable(await env.image()) };
	} finally {
		await store.close();
	}
}
declare global {
	interface Window {
		runSnapshotDeclarationDiscovery(name: string, setupOnly?: boolean): Promise<unknown>;
		seedSnapshotDeclarationDiscovery(primaryDatabaseName: string): Promise<unknown>;
		reopenSnapshotDeclarationDiscovery(input: { primaryDatabaseName: string; key: Key }): Promise<unknown>;
		deleteSnapshotDeclarationDiscovery(primaryDatabaseName: string): Promise<unknown>;
	}
}
window.runSnapshotDeclarationDiscovery = run;
window.seedSnapshotDeclarationDiscovery = seedFresh;
window.reopenSnapshotDeclarationDiscovery = fresh;
window.deleteSnapshotDeclarationDiscovery = (name): Promise<unknown> =>
	request(indexedDB.deleteDatabase(name + suffix));
