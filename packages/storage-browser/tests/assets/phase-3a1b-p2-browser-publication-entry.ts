import { encodeCanonical } from "@ts-drp/canonical";

import type {
	Phase3a1bP2BrowserDeathTuple,
	Phase3a1bP2Commit,
	Phase3a1bP2Scope,
	Phase3a1bP2Store,
} from "../../../../tests/fixtures/phase-3a1b-p2-outbox-publication-contract.js";
import { snapshotPhase3a1bP2Store } from "../../../../tests/fixtures/phase-3a1b-p2-outbox-publication-contract.js";
import { createBrowserDurableIssuanceStore } from "../../src/issuance.js";

declare global {
	interface Window {
		phase2e6Recover(databaseName: string, scenarioId: string, seededHead: never): Promise<unknown>;
		phase2e6RunControls(): Promise<unknown>;
		phase3a1bP2Control(databaseName: string): Promise<unknown>;
		phase3a1bP2Recover(databaseName: string, includeOther: boolean): Promise<unknown>;
		phase3a1bP2Relay?(observation: unknown, cellValue: number): Promise<void>;
		phase3a1bP2RunDeath(tuple: Phase3a1bP2BrowserDeathTuple, databaseName: string): Promise<unknown>;
	}
}

const SCOPE = Object.freeze({ author: "alice", objectId: "room:publication" });
const OTHER_SCOPE = Object.freeze({ author: "bob", objectId: "room:unaddressed" });

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.addEventListener("success", () => resolve(value.result), { once: true });
		value.addEventListener("error", () => reject(value.error), { once: true });
	});
}

function transaction(value: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		value.addEventListener("complete", () => resolve(), { once: true });
		value.addEventListener("abort", () => reject(value.error), { once: true });
		value.addEventListener("error", () => reject(value.error), { once: true });
	});
}

function publicError(error: unknown): Record<string, unknown> {
	return typeof error === "object" && error !== null
		? {
				code: Reflect.get(error, "code"),
				name: Reflect.get(error, "name"),
				retryClass: Reflect.get(error, "retryClass"),
				scope: Reflect.get(error, "scope"),
			}
		: { code: "NON_OBJECT" };
}

async function rejection(
	run: () => Promise<unknown>
): Promise<Readonly<{ error: unknown; shape: Record<string, unknown> }>> {
	try {
		await run();
	} catch (error) {
		return { error, shape: publicError(error) };
	}
	throw new TypeError("expected browser publication rejection");
}

async function deleteOutbox(primaryDatabaseName: string): Promise<void> {
	const database = await request(indexedDB.open(`${primaryDatabaseName}--drp-issuance-v1`));
	try {
		const tx = database.transaction(["issuanceOutbox"], "readwrite", { durability: "strict" });
		const done = transaction(tx);
		await request(tx.objectStore("issuanceOutbox").delete([SCOPE.objectId, SCOPE.author, 0]));
		await done;
	} finally {
		database.close();
	}
}

async function nativeCounts(primaryDatabaseName: string): Promise<readonly number[]> {
	const database = await request(indexedDB.open(`${primaryDatabaseName}--drp-issuance-v1`));
	try {
		const tx = database.transaction(["lineages", "issuedRecords", "issuanceOutbox"], "readonly", {
			durability: "strict",
		});
		const done = transaction(tx);
		const counts = await Promise.all(
			["lineages", "issuedRecords", "issuanceOutbox"].map((name) => request(tx.objectStore(name).count()))
		);
		await done;
		return counts;
	} finally {
		database.close();
	}
}

async function tracedMark(
	store: Phase3a1bP2Store,
	input: Parameters<Phase3a1bP2Store["compareAndMarkOutboxPublished"]>[0]
): Promise<readonly Record<string, unknown>[]> {
	const trace: Record<string, unknown>[] = [];
	const originalTransaction = IDBDatabase.prototype.transaction;
	const originalGet = IDBObjectStore.prototype.get;
	const originalPut = IDBObjectStore.prototype.put;
	const ids = new WeakMap<IDBTransaction, string>();
	let ordinal = 0;
	IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>): IDBTransaction {
		const tx = Reflect.apply(originalTransaction, this, args) as IDBTransaction;
		const id = `transaction-${++ordinal}`;
		ids.set(tx, id);
		trace.push({
			databaseName: this.name,
			durability: args[2]?.durability,
			id,
			kind: "transaction",
			mode: tx.mode,
			stores: [...tx.objectStoreNames].sort(),
		});
		tx.addEventListener("complete", () => trace.push({ id, kind: "complete" }), { once: true });
		return tx;
	};
	IDBObjectStore.prototype.get = function (...args: Parameters<IDBObjectStore["get"]>): IDBRequest {
		const value = Reflect.apply(originalGet, this, args) as IDBRequest;
		value.addEventListener(
			"success",
			() => trace.push({ id: ids.get(this.transaction), key: args[0], kind: "get", store: this.name }),
			{
				once: true,
			}
		);
		return value;
	};
	IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>): IDBRequest {
		const value = Reflect.apply(originalPut, this, args) as IDBRequest;
		value.addEventListener(
			"success",
			() =>
				trace.push({
					id: ids.get(this.transaction),
					key: value.result,
					kind: "put",
					publishState: Reflect.get(args[0] as object, "publishState"),
					store: this.name,
					value: {
						author: Reflect.get(args[0] as object, "author"),
						authorSequence: Reflect.get(args[0] as object, "authorSequence"),
						digest: [...(Reflect.get(args[0] as object, "digest") as Uint8Array)],
						objectId: Reflect.get(args[0] as object, "objectId"),
						publishState: Reflect.get(args[0] as object, "publishState"),
					},
				}),
			{
				once: true,
			}
		);
		return value;
	};
	try {
		await store.compareAndMarkOutboxPublished(input);
		return trace;
	} finally {
		IDBDatabase.prototype.transaction = originalTransaction;
		IDBObjectStore.prototype.get = originalGet;
		IDBObjectStore.prototype.put = originalPut;
	}
}

function controlCommit(authorSequence: number, scope: Phase3a1bP2Scope = SCOPE): Phase3a1bP2Commit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({ ...scope, authorSequence }),
		digest: Uint8Array.of(41, 0xd1),
		signature: Uint8Array.of(41, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope },
		outboxEntry: { authorSequence, envelope, scope },
	};
}

window.phase3a1bP2Control = async (primaryDatabaseName): Promise<unknown> => {
	const first = (await createBrowserDurableIssuanceStore({ primaryDatabaseName })) as unknown as Phase3a1bP2Store;
	const selected = await first.transactIssue(SCOPE, (ordinal) => Promise.resolve(controlCommit(ordinal)));
	const other = await first.transactIssue(OTHER_SCOPE, (ordinal) =>
		Promise.resolve(controlCommit(ordinal, OTHER_SCOPE))
	);
	try {
		const absent = await rejection(() =>
			first.compareAndMarkOutboxPublished({ authorSequence: 1, digest: selected.envelope.digest, scope: SCOPE })
		);
		const foreign = await rejection(() =>
			first.compareAndMarkOutboxPublished({ authorSequence: 0, digest: Uint8Array.of(0xfe), scope: SCOPE })
		);
		const digest = new Uint8Array(selected.envelope.digest);
		const firstPromise = tracedMark(first, { authorSequence: 0, digest, scope: { ...SCOPE } });
		digest.fill(0);
		const firstTrace = await firstPromise;
		const repeatTrace = await tracedMark(first, {
			authorSequence: 0,
			digest: new Uint8Array(selected.envelope.digest),
			scope: SCOPE,
		});
		const second = (await createBrowserDurableIssuanceStore({ primaryDatabaseName })) as unknown as Phase3a1bP2Store;
		const crossInput = { authorSequence: 0, digest: new Uint8Array(other.envelope.digest), scope: OTHER_SCOPE };
		const crossTrace: Record<string, unknown>[] = [];
		const originalTransaction = IDBDatabase.prototype.transaction;
		const originalPut = IDBObjectStore.prototype.put;
		IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>): IDBTransaction {
			const transaction = Reflect.apply(originalTransaction, this, args) as IDBTransaction;
			crossTrace.push({
				databaseName: this.name,
				durability: args[2]?.durability,
				kind: "transaction",
				mode: transaction.mode,
				stores: [...transaction.objectStoreNames].sort(),
			});
			return transaction;
		};
		IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>): IDBRequest {
			const result = Reflect.apply(originalPut, this, args) as IDBRequest;
			result.addEventListener(
				"success",
				() =>
					crossTrace.push({
						key: result.result,
						kind: "put",
						publishState: Reflect.get(args[0] as object, "publishState"),
						store: this.name,
						value: {
							author: Reflect.get(args[0] as object, "author"),
							authorSequence: Reflect.get(args[0] as object, "authorSequence"),
							digest: [...(Reflect.get(args[0] as object, "digest") as Uint8Array)],
							objectId: Reflect.get(args[0] as object, "objectId"),
							publishState: Reflect.get(args[0] as object, "publishState"),
						},
					}),
				{ once: true }
			);
			return result;
		};
		try {
			await Promise.all([
				first.compareAndMarkOutboxPublished(crossInput),
				second.compareAndMarkOutboxPublished({ ...crossInput, digest: new Uint8Array(crossInput.digest) }),
			]);
		} finally {
			IDBDatabase.prototype.transaction = originalTransaction;
			IDBObjectStore.prototype.put = originalPut;
		}
		await second.close();
		await first.close();
		const closed = await rejection(() =>
			first.compareAndMarkOutboxPublished({ authorSequence: 0, digest: selected.envelope.digest, scope: SCOPE })
		);
		const reopened = (await createBrowserDurableIssuanceStore({ primaryDatabaseName })) as unknown as Phase3a1bP2Store;
		const reopenTrace = await tracedMark(reopened, {
			authorSequence: 0,
			digest: new Uint8Array(selected.envelope.digest),
			scope: SCOPE,
		});
		const snapshot = await snapshotPhase3a1bP2Store(reopened, [SCOPE, OTHER_SCOPE]);
		await reopened.close();

		const corruptName = `${primaryDatabaseName}-corrupt`;
		const corruptSeed = (await createBrowserDurableIssuanceStore({
			primaryDatabaseName: corruptName,
		})) as unknown as Phase3a1bP2Store;
		const corruptCommit = await corruptSeed.transactIssue(SCOPE, (ordinal) => Promise.resolve(controlCommit(ordinal)));
		await corruptSeed.close();
		await deleteOutbox(corruptName);
		const corrupt = (await createBrowserDurableIssuanceStore({
			primaryDatabaseName: corruptName,
		})) as unknown as Phase3a1bP2Store;
		const corruption = await rejection(() =>
			corrupt.compareAndMarkOutboxPublished({
				authorSequence: 0,
				digest: new Uint8Array(corruptCommit.envelope.digest),
				scope: SCOPE,
			})
		);
		const latched = await rejection(() => corrupt.readLineage(SCOPE));
		await corrupt.close();
		return {
			absent: absent.shape,
			closed: closed.shape,
			corruption: corruption.shape,
			corruptionIdentity: corruption.error === latched.error,
			crossTrace,
			firstKeys: Object.keys(first).sort(),
			firstPrototypeIsNull: Object.getPrototypeOf(first) === null,
			firstTrace,
			foreign: foreign.shape,
			reopenTrace,
			repeatTrace,
			snapshot,
		};
	} finally {
		await first.close();
	}
};

window.phase3a1bP2RunDeath = (tuple, primaryDatabaseName): Promise<unknown> =>
	new Promise((resolve, reject) => {
		const worker = new Worker("./phase-3a1b-p2-worker.js", { type: "module" });
		const signal = new SharedArrayBuffer(4);
		const cell = new Int32Array(signal);
		worker.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
			if (event.data.kind === "ready") {
				worker.postMessage({ kind: "run", primaryDatabaseName, signal, tuple });
				return;
			}
			if (event.data.kind === "worker-error") {
				void window.phase3a1bP2Relay?.(event.data, Atomics.load(cell, 0));
				reject(new TypeError(String(event.data.detail)));
				return;
			}
			if (event.data.kind === "armed") {
				void window.phase3a1bP2Relay?.(event.data, Atomics.load(cell, 0));
				resolve(event.data);
			}
		});
	});

window.phase3a1bP2Recover = async (primaryDatabaseName, includeOther): Promise<unknown> => {
	const store = (await createBrowserDurableIssuanceStore({ primaryDatabaseName })) as unknown as Phase3a1bP2Store;
	try {
		return {
			counts: await nativeCounts(primaryDatabaseName),
			keys: Object.keys(store).sort(),
			prototypeIsNull: Object.getPrototypeOf(store) === null,
			snapshot: await snapshotPhase3a1bP2Store(store, includeOther ? [SCOPE, OTHER_SCOPE] : [SCOPE]),
		};
	} finally {
		await store.close();
	}
};
