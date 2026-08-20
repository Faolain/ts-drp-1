import {
	type BlobDigest,
	digestBlob,
	type GenerationRef,
	parseGenerationId,
	parseStorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import * as browserRoot from "@ts-drp/storage-browser";

type ProbeStore = Readonly<{
	beginGeneration(input: unknown): Promise<StoreResult<unknown>>;
	close(): Promise<void>;
	probeBlobPresence?(digests: readonly BlobDigest[]): Promise<StoreResult<readonly boolean[]>>;
	putCachedBlob(input: unknown): Promise<StoreResult<unknown>>;
	recoverActiveGeneration(objectId: string): Promise<StoreResult<unknown>>;
}>;

const OBJECT_ID = must(parseStorageObjectId(`phase-2g-b:${"a".repeat(32)}`));
const GENERATION_ID = must(parseGenerationId("1".repeat(64)));

function must<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
	if (!result.ok) throw new Error("browser fixture parse failed");
	return result.value;
}

function digest(value: Uint8Array): BlobDigest {
	return must(digestBlob(value));
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("request failed")), { once: true });
	});
}

async function openRaw(databaseName: string): Promise<IDBDatabase> {
	return requestResult(indexedDB.open(databaseName));
}

async function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("transaction aborted")), {
			once: true,
		});
		transaction.addEventListener("error", () => reject(transaction.error ?? new Error("transaction failed")), {
			once: true,
		});
	});
}

function deleteDatabase(databaseName: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(databaseName);
		request.addEventListener("success", () => resolve(), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("delete failed")), { once: true });
	});
}

function reason(result: StoreResult<unknown>): string {
	return result.ok ? "OK" : result.reason;
}

async function runPresenceContract(): Promise<unknown> {
	const factory = Reflect.get(browserRoot, "createBrowserAheDurableStore") as (
		options: Readonly<{ databaseName: string }>
	) => Promise<ProbeStore>;
	const positiveName = `phase-2g-b-positive-${crypto.randomUUID()}`;
	const substrateName = `phase-2g-b-substrate-${crypto.randomUUID()}`;
	const poisonName = `phase-2g-b-poison-${crypto.randomUUID()}`;
	const names = [positiveName, substrateName, poisonName];
	const bytesA = Uint8Array.of(1, 2, 3);
	const bytesB = Uint8Array.of(4, 5);
	const digestA = digest(bytesA);
	const digestB = digest(bytesB);
	const sortedDigests = [digestA, digestB].sort() as BlobDigest[];
	let positive: ProbeStore | undefined;
	let substrate: ProbeStore | undefined;
	let poisoned: ProbeStore | undefined;
	try {
		positive = await factory({ databaseName: positiveName });
		if (typeof positive.probeBlobPresence !== "function") {
			await positive.close();
			positive = undefined;
			return Object.freeze({ realProbe: false });
		}
		const references: readonly GenerationRef[] = [
			{ byteLength: bytesA.byteLength, digest: digestA },
			{ byteLength: bytesB.byteLength, digest: digestB },
		];
		const begun = await positive.beginGeneration({
			baseExpectedHead: { kind: "none", objectId: OBJECT_ID },
			closure: references,
			generationId: GENERATION_ID,
			objectId: OBJECT_ID,
		});
		if (!begun.ok) throw new Error(`positive begin failed: ${begun.reason}`);
		const put = await positive.putCachedBlob({
			bytes: bytesA,
			digest: digestA,
			generationId: GENERATION_ID,
			objectId: OBJECT_ID,
		});
		if (!put.ok) throw new Error(`positive put failed: ${put.reason}`);

		const transactionDescriptor = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "transaction");
		const getDescriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "get");
		const getKeyDescriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "getKey");
		if (
			transactionDescriptor === undefined ||
			getDescriptor === undefined ||
			getKeyDescriptor === undefined ||
			typeof transactionDescriptor.value !== "function" ||
			typeof getDescriptor.value !== "function" ||
			typeof getKeyDescriptor.value !== "function"
		) {
			throw new Error("IndexedDB methods are not instrumentable");
		}
		let readonlyBlobTransactions = 0;
		let blobGets = 0;
		let blobGetKeys = 0;
		Object.defineProperty(IDBDatabase.prototype, "transaction", {
			...transactionDescriptor,
			value: function transaction(
				this: IDBDatabase,
				storeNames: string | string[],
				mode?: IDBTransactionMode,
				options?: IDBTransactionOptions
			) {
				const namesValue = typeof storeNames === "string" ? [storeNames] : [...storeNames];
				if (mode === "readonly" && namesValue.length === 1 && namesValue[0] === "blobs") readonlyBlobTransactions += 1;
				return Reflect.apply(transactionDescriptor.value, this, [storeNames, mode, options]);
			},
		});
		Object.defineProperty(IDBObjectStore.prototype, "get", {
			...getDescriptor,
			value: function get(this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
				if (this.name === "blobs") blobGets += 1;
				return Reflect.apply(getDescriptor.value, this, [query]);
			},
		});
		Object.defineProperty(IDBObjectStore.prototype, "getKey", {
			...getKeyDescriptor,
			value: function getKey(this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
				if (this.name === "blobs") blobGetKeys += 1;
				return Reflect.apply(getKeyDescriptor.value, this, [query]);
			},
		});
		let first: StoreResult<readonly boolean[]>;
		let second: StoreResult<readonly boolean[]>;
		let detachedInput: StoreResult<readonly boolean[]>;
		try {
			first = await positive.probeBlobPresence(sortedDigests);
			second = await positive.probeBlobPresence(sortedDigests);
			const callerDigests = [...sortedDigests];
			const pendingDetachedInput = positive.probeBlobPresence(callerDigests);
			callerDigests.reverse();
			callerDigests[0] = digest(Uint8Array.of(9));
			detachedInput = await pendingDetachedInput;
		} finally {
			Object.defineProperty(IDBDatabase.prototype, "transaction", transactionDescriptor);
			Object.defineProperty(IDBObjectStore.prototype, "get", getDescriptor);
			Object.defineProperty(IDBObjectStore.prototype, "getKey", getKeyDescriptor);
		}
		if (!first.ok || !second.ok || !detachedInput.ok) throw new Error("positive presence probe failed");
		const expected = sortedDigests.map((item) => item === digestA);
		const positiveFacts = {
			blobGetKeys,
			blobGets,
			detachedResults: first.value !== second.value,
			first: [...first.value],
			frozenFirst: Object.isFrozen(first.value),
			inputDetached: [...detachedInput.value],
			readonlyBlobTransactions,
			second: [...second.value],
			expected,
		};
		await positive.close();
		const afterClose = await positive.probeBlobPresence(sortedDigests);
		positive = undefined;

		substrate = await factory({ databaseName: substrateName });
		if (typeof substrate.probeBlobPresence !== "function") throw new Error("probe disappeared");
		const fault = new Error("getKey substrate fault");
		const originalGetKey = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "getKey");
		if (originalGetKey === undefined || typeof originalGetKey.value !== "function") throw new Error("getKey absent");
		Object.defineProperty(IDBObjectStore.prototype, "getKey", {
			...originalGetKey,
			value: function getKey(this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
				if (this.name === "blobs") throw fault;
				return Reflect.apply(originalGetKey.value, this, [query]);
			},
		});
		let substrateResult: StoreResult<readonly boolean[]>;
		try {
			substrateResult = await substrate.probeBlobPresence([digestA]);
		} finally {
			Object.defineProperty(IDBObjectStore.prototype, "getKey", originalGetKey);
		}
		await substrate.close();
		substrate = undefined;

		poisoned = await factory({ databaseName: poisonName });
		if (typeof poisoned.probeBlobPresence !== "function") throw new Error("probe disappeared");
		const raw = await openRaw(poisonName);
		const corruptTransaction = raw.transaction("generations", "readwrite");
		corruptTransaction.objectStore("generations").put({
			generationId: GENERATION_ID,
			objectId: OBJECT_ID,
			record: Uint8Array.of(0),
		});
		await transactionDone(corruptTransaction);
		raw.close();
		const poisonCause = await poisoned.recoverActiveGeneration(OBJECT_ID);
		const afterPoison = await poisoned.probeBlobPresence([digestA]);
		await poisoned.close();
		poisoned = undefined;

		return Object.freeze({
			afterClose: reason(afterClose),
			afterPoison: reason(afterPoison),
			poisonCause: reason(poisonCause),
			positive: positiveFacts,
			realProbe: true,
			substrateCauseSame:
				!substrateResult.ok && substrateResult.reason === "SUBSTRATE_FAILURE" && substrateResult.cause === fault,
			substrateReason: reason(substrateResult),
		});
	} finally {
		await positive?.close();
		await substrate?.close();
		await poisoned?.close();
		await Promise.all(names.map(deleteDatabase));
	}
}

Reflect.set(globalThis, "phase2gBPresenceContract", Object.freeze({ run: runPresenceContract }));
