import { type AnchorCase, anchorMaterial } from "./material.js";
import { type NativeAccess, recoverAnchorCase } from "./scenarios.js";
import { createBrowserDurableLiveJournalStore } from "../../../packages/storage-browser/dist/src/live-journal.js";

function openRaw(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(`${name}--drp-live-journal-v1`);
		request.onsuccess = (): void => resolve(request.result);
		request.onerror = (): void => reject(request.error);
		request.onupgradeneeded = (): void => {
			request.transaction?.abort();
			reject(new Error("raw observation must not create"));
		};
	});
}

function terminal(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = (): void => resolve();
		transaction.onabort = (): void => reject(transaction.error ?? new Error("native transaction aborted"));
		transaction.onerror = (): void => reject(transaction.error);
	});
}

async function census(name: string): Promise<unknown> {
	const database = await openRaw(name);
	try {
		const transaction = database.transaction(["scopes", "acceptedEntries"], "readonly");
		const done = terminal(transaction);
		const scopes = transaction.objectStore("scopes").getAll();
		const entries = transaction.objectStore("acceptedEntries").getAll();
		await done;
		return { entries: entries.result, scopes: scopes.result };
	} finally {
		database.close();
	}
}

async function mutate(name: string, id: AnchorCase, change: Parameters<NativeAccess["mutate"]>[0]): Promise<void> {
	const material = anchorMaterial(id === "non-genesis" ? 1 : 0);
	const key = [material.scope.objectId, material.scope.epoch, material.scope.anchorDigest];
	const database = await openRaw(name);
	try {
		const transaction = database.transaction("scopes", "readwrite", { durability: "strict" });
		const done = terminal(transaction);
		const store = transaction.objectStore("scopes");
		if (change === "delete") store.delete(key);
		else {
			const request = store.get(key);
			request.onsuccess = (): void => {
				const row = request.result as Record<string, unknown> | undefined;
				const value = row ?? {
					...material.scope,
					nextJournalSequence: 0,
					parametersDigest: material.scope.anchorDigest,
					detachedAnchorSignature: material.install.detachedAnchorSignature,
					exactCanonicalParametersCarrierBytes: material.install.exactCanonicalParametersCarrierBytes,
				};
				if (change === "unrelated-carriers") {
					value.detachedAnchorSignature = new Uint8Array(8193);
					value.exactCanonicalParametersCarrierBytes = "not-parameters";
					value.nextJournalSequence = -1;
				} else if (change === "scope") {
					const epochOne = anchorMaterial(1);
					store.delete(key);
					value.anchorDigest = epochOne.scope.anchorDigest;
					value.exactCanonicalAnchorPreimageBytes = epochOne.bytes;
				} else
					value.exactCanonicalAnchorPreimageBytes =
						change === "oversize"
							? new Uint8Array(8193).fill(7)
							: change === "empty"
								? new Uint8Array()
								: change === "non-byte"
									? "not-bytes"
									: change === "noncanonical"
										? Uint8Array.of(...material.bytes, 0)
										: change === "replacement"
											? Uint8Array.of(0)
											: anchorMaterial(0, { aclDigest: "9".repeat(64) }).bytes;
				store.put(value);
			};
		}
		await done;
	} finally {
		database.close();
	}
}

async function observe(
	call: () => Promise<unknown>,
	mode?: "failure" | "close-executing"
): Promise<{ result: unknown; trace: readonly unknown[] }> {
	const trace: unknown[] = [];
	const transaction = IDBDatabase.prototype.transaction;
	const originals = new Map<string, (...args: unknown[]) => unknown>();
	IDBDatabase.prototype.transaction = function (stores, access, options): IDBTransaction {
		const names = typeof stores === "string" ? stores : Array.from(stores);
		const created = transaction.call(this, names, access, options);
		trace.push({ mode: created.mode, stores: Array.from(created.objectStoreNames), operation: "transaction" });
		created.addEventListener("complete", () => trace.push({ operation: "complete" }));
		created.addEventListener("abort", () => trace.push({ operation: "abort" }));
		return created;
	};
	for (const name of [
		"get",
		"getKey",
		"getAll",
		"getAllKeys",
		"openCursor",
		"openKeyCursor",
		"count",
		"put",
		"add",
		"delete",
		"clear",
	] as const) {
		const original = IDBObjectStore.prototype[name] as (...args: unknown[]) => unknown;
		originals.set(name, original);
		(IDBObjectStore.prototype as unknown as Record<string, unknown>)[name] = function (
			this: IDBObjectStore,
			...args: unknown[]
		): unknown {
			trace.push({ operation: name, store: this.name, key: args[0] });
			const request = original.apply(this, args);
			if (mode === "failure") {
				mode = undefined;
				this.transaction.abort();
			}
			return request;
		};
	}
	try {
		return { result: await call(), trace };
	} finally {
		IDBDatabase.prototype.transaction = transaction;
		for (const [name, original] of originals)
			(IDBObjectStore.prototype as unknown as Record<string, unknown>)[name] = original;
	}
}

declare global {
	interface Window {
		journalAnchorSetup(name: string, id: AnchorCase): Promise<unknown>;
		journalAnchorRecover(name: string, id: AnchorCase): Promise<unknown>;
		journalAnchorControl(name: string, id: AnchorCase): Promise<unknown>;
		journalAnchorGetKeyControl(name: string): Promise<unknown>;
		journalAnchorRemove(name: string): Promise<void>;
	}
}

window.journalAnchorSetup = async (name, id): Promise<unknown> => {
	const material = anchorMaterial(id === "non-genesis" ? 1 : 0);
	const owner = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: name });
	let installed;
	try {
		installed = await (material.scope.epoch === 0
			? owner.installGenesis(material.install)
			: owner.installEpochAnchor(material.install));
	} finally {
		await owner.close();
	}
	return { census: await census(name), installed, expectedScope: material.scope, realm: performance.timeOrigin };
};
window.journalAnchorRecover = async (name, id): Promise<unknown> => {
	const native: NativeAccess = {
		census: () => census(name),
		mutate: (change) => mutate(name, id, change),
		observe,
		open: () => createBrowserDurableLiveJournalStore({ primaryDatabaseName: name }),
	};
	return { ...(await recoverAnchorCase(native, id)), realm: performance.timeOrigin };
};
window.journalAnchorControl = async (name, id): Promise<unknown> => {
	const material = anchorMaterial(id === "non-genesis" ? 1 : 0);
	const initial = (await census(name)) as { scopes: Record<string, unknown>[]; entries: unknown[] };
	const before = Array.from(initial.scopes[0]?.exactCanonicalAnchorPreimageBytes as Uint8Array);
	await mutate(name, id, "oversize");
	const oversized = (await census(name)) as { scopes: Record<string, unknown>[] };
	const nativeBytes = oversized.scopes[0]?.exactCanonicalAnchorPreimageBytes as Uint8Array;
	return {
		before,
		expectedBytes: Array.from(material.bytes),
		nativeLength: nativeBytes.length,
		entries: initial.entries.length,
		realm: performance.timeOrigin,
		qualification: "actual native IDB whole-row clone; not accessor GREEN",
	};
};
window.journalAnchorGetKeyControl = async (name): Promise<unknown> => {
	const material = anchorMaterial();
	const key = [material.scope.objectId, material.scope.epoch, material.scope.anchorDigest];
	const range = IDBKeyRange.bound(
		[material.scope.objectId, material.scope.epoch],
		[material.scope.objectId, material.scope.epoch, []]
	);
	const database = await openRaw(name);
	const originalGet = IDBObjectStore.prototype.get;
	const originalGetKey = IDBObjectStore.prototype.getKey;
	const originalTransaction = IDBDatabase.prototype.transaction;
	const query = async (): Promise<unknown> => {
		const transaction = database.transaction("scopes", "readonly");
		const done = terminal(transaction);
		const store = transaction.objectStore("scopes");
		const exact = store.get(key);
		const occupancy = store.getKey(range);
		let successes = 0;
		for (const request of [exact, occupancy]) request.addEventListener("success", () => successes++);
		const nativeRequests = [exact, occupancy].every(
			(request) => request instanceof IDBRequest && request.source === store && request.transaction === transaction
		);
		await done;
		return {
			exactBytes: Array.from(
				(exact.result as { exactCanonicalAnchorPreimageBytes: Uint8Array }).exactCanonicalAnchorPreimageBytes
			),
			occupancyKey: occupancy.result,
			nativeRequests,
			readyStates: [exact.readyState, occupancy.readyState],
			successes,
			terminal: "complete",
		};
	};
	try {
		const baseline = await query();
		const observed = await observe(query);
		return {
			baseline,
			observed: observed.result,
			traces: observed.trace,
			key,
			expectedBytes: Array.from(material.bytes),
			rangeArgumentSame: observed.trace.some(
				(entry) =>
					(entry as { operation: string; key: unknown }).operation === "getKey" &&
					(entry as { key: unknown }).key === range
			),
			prototypesRestored:
				IDBObjectStore.prototype.get === originalGet &&
				IDBObjectStore.prototype.getKey === originalGetKey &&
				IDBDatabase.prototype.transaction === originalTransaction,
			realm: performance.timeOrigin,
		};
	} finally {
		database.close();
	}
};
window.journalAnchorRemove = (name): Promise<void> =>
	new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(`${name}--drp-live-journal-v1`);
		request.onsuccess = (): void => resolve();
		request.onerror = (): void => reject(request.error);
		request.onblocked = (): void => reject(new Error("fixture leaked an owner"));
	});
