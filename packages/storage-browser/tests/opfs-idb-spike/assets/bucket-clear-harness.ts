const DATABASE_NAME = "phase-2-spike-s3-bucket-clear-v1";
const STORE_NAME = "payloads";
const RECORD_KEY = "exact-idb-payload";
const FILE_NAME = "phase-2-spike-s3-exact-opfs-payload.bin";

interface ExactPayload {
	readonly opfsBytes: readonly number[];
	readonly idbValue: string;
}

interface PayloadObservation {
	readonly opfs: { readonly present: boolean; readonly exactBytes: boolean };
	readonly idb: { readonly present: boolean; readonly exactValue: boolean };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error), { once: true });
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
		transaction.addEventListener("error", () => reject(transaction.error), { once: true });
	});
}

async function deleteDatabase(): Promise<void> {
	await requestResult(indexedDB.deleteDatabase(DATABASE_NAME));
}

async function openDatabase(): Promise<IDBDatabase> {
	const request = indexedDB.open(DATABASE_NAME, 1);
	request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE_NAME), { once: true });
	return requestResult(request);
}

async function seedExactPayload(payload: ExactPayload): Promise<void> {
	await deleteDatabase();
	const root = await navigator.storage.getDirectory();
	await root.removeEntry(FILE_NAME).catch((error: unknown) => {
		if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
	});
	const file = await root.getFileHandle(FILE_NAME, { create: true });
	const writable = await file.createWritable();
	await writable.write(Uint8Array.from(payload.opfsBytes));
	await writable.close();

	const database = await openDatabase();
	const transaction = database.transaction(STORE_NAME, "readwrite", { durability: "strict" });
	transaction.objectStore(STORE_NAME).put(payload.idbValue, RECORD_KEY);
	await transactionDone(transaction);
	database.close();
}

async function readExactPayload(expected: ExactPayload): Promise<PayloadObservation> {
	let opfsBytes: Uint8Array | null = null;
	try {
		const root = await navigator.storage.getDirectory();
		const file = await (await root.getFileHandle(FILE_NAME)).getFile();
		opfsBytes = new Uint8Array(await file.arrayBuffer());
	} catch (error) {
		if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
	}

	let idbValue: unknown = undefined;
	const databases = await indexedDB.databases();
	let databaseExists = false;
	for (const databaseInfo of databases) {
		if (databaseInfo.name === DATABASE_NAME) databaseExists = true;
	}
	if (databaseExists) {
		const database = await openDatabase();
		const transaction = database.transaction(STORE_NAME, "readonly");
		idbValue = await requestResult(transaction.objectStore(STORE_NAME).get(RECORD_KEY));
		await transactionDone(transaction);
		database.close();
	}
	return {
		opfs: {
			present: opfsBytes !== null,
			exactBytes:
				opfsBytes !== null &&
				opfsBytes.length === expected.opfsBytes.length &&
				opfsBytes.every((byte, index) => byte === expected.opfsBytes[index]),
		},
		idb: { present: idbValue !== undefined, exactValue: idbValue === expected.idbValue },
	};
}

Object.assign(globalThis, {
	phase2SpikeS3: Object.freeze({ seedExactPayload, readExactPayload, deleteDatabase }),
});
