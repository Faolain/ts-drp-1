/* eslint-disable import/no-unresolved -- The future non-root owners are intentionally absent in RED. */
import {
	consumeSnapshotVerificationReceipt,
	verifySnapshotStreamWithReceipt,
} from "@ts-drp/compaction/snapshot-quarantine-receipt";
import { createBrowserSnapshotQuarantineStore } from "@ts-drp/storage-browser/snapshot-transfer";

import {
	createSnapshotQuarantineFixture,
	runSnapshotQuarantineBehaviorContract,
	type SnapshotQuarantineFixture,
} from "../../../../tests/fixtures/phase-4c-v3/snapshot-quarantine-contract.js";

function fixture(objectId = "phase-4c-b-browser"): SnapshotQuarantineFixture {
	return createSnapshotQuarantineFixture({ objectId });
}

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onerror = (): void => reject(request.error);
		request.onsuccess = (): void => resolvePromise();
	});
}

async function rawRows(databaseName: string): Promise<
	Readonly<{
		chunkFields: readonly string[];
		chunkLengths: readonly number[];
		chunks: number;
		schema: unknown;
		scopeFields: readonly string[];
		scopes: number;
	}>
> {
	const database = await new Promise<IDBDatabase>((resolvePromise, reject) => {
		const request = indexedDB.open(databaseName);
		request.onerror = (): void => reject(request.error);
		request.onsuccess = (): void => resolvePromise(request.result);
	});
	try {
		const transaction = database.transaction(["chunks", "scopes"], "readonly");
		const chunkRows = await new Promise<readonly Record<string, unknown>[]>((resolvePromise, reject) => {
			const request = transaction.objectStore("chunks").getAll();
			request.onerror = (): void => reject(request.error);
			request.onsuccess = (): void => resolvePromise(request.result);
		});
		const scopeRows = await new Promise<readonly Record<string, unknown>[]>((resolvePromise, reject) => {
			const request = transaction.objectStore("scopes").getAll();
			request.onerror = (): void => reject(request.error);
			request.onsuccess = (): void => resolvePromise(request.result);
		});
		const scopeStore = transaction.objectStore("scopes");
		return Object.freeze({
			chunkFields: Object.freeze(Object.keys(chunkRows[0] ?? {}).sort()),
			chunkLengths: Object.freeze(chunkRows.map((row) => (row.exactBytes as Uint8Array | undefined)?.byteLength ?? -1)),
			chunks: chunkRows.length,
			schema: Object.freeze({
				chunkKeyPath: database.transaction("chunks", "readonly").objectStore("chunks").keyPath,
				expiryIndex: scopeStore.indexNames.contains("expiryAsc"),
				scopeKeyPath: scopeStore.keyPath,
				stores: [...database.objectStoreNames],
				version: database.version,
			}),
			scopeFields: Object.freeze(Object.keys(scopeRows[0] ?? {}).sort()),
			scopes: scopeRows.length,
		});
	} finally {
		database.close();
	}
}

async function runLifecycle(): Promise<unknown> {
	const primaryDatabaseName = `phase4cb-${crypto.randomUUID()}`;
	const databaseName = `${primaryDatabaseName}--drp-snapshot-quarantine-v1`;
	const selected = fixture();
	const store = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
	const transcript = await runSnapshotQuarantineBehaviorContract({ fixture: selected, store: store as never });
	const afterCancel = await rawRows(databaseName);
	await store.close();
	await deleteDatabase(databaseName);
	return { ...transcript, afterCancel };
}

async function runReceipt(): Promise<unknown> {
	const primaryDatabaseName = `phase4cb-${crypto.randomUUID()}`;
	const databaseName = `${primaryDatabaseName}--drp-snapshot-quarantine-v1`;
	const selected = fixture();
	const store = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
	const scope = await store.openScope(selected.declaration as never);
	const stream = verifySnapshotStreamWithReceipt({
		exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes as Uint8Array,
		expectedManifestDigest: (selected.declaration.scope as { manifestDigest: string }).manifestDigest,
		expectedScope: selected.declaration.scope as never,
		profile: { maxManifestBytes: 212_387, maxSnapshotBytes: 268_435_456, snapshotChunkBytes: 131_072 },
		quarantine: scope.verificationQuarantine,
		source: {
			read: (descriptor) => Promise.resolve(new Uint8Array(selected.chunks[descriptor.index] as Uint8Array)),
		},
	});
	const receipt = await stream.receipt;
	const completion = await stream.completion;
	const reference = await scope.complete(receipt);
	let replay = "none";
	try {
		consumeSnapshotVerificationReceipt({
			expectedScope: selected.declaration.scope as never,
			quarantine: scope.verificationQuarantine,
			receipt,
		});
	} catch (error) {
		replay = String(Reflect.get(error as object, "code"));
	}
	const rows = await rawRows(databaseName);
	await store.close();
	await deleteDatabase(databaseName);
	return { completion, reference, replay, rows };
}

async function runExpiry(): Promise<unknown> {
	const primaryDatabaseName = `phase4cb-${crypto.randomUUID()}`;
	const databaseName = `${primaryDatabaseName}--drp-snapshot-quarantine-v1`;
	const originalNow = Date.now;
	let now = 4_000;
	Date.now = (): number => now;
	const selected = fixture();
	try {
		const store = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
		const scope = await store.openScope(selected.declaration as never);
		const expiresAt = (await scope.status()).expiresAt;
		now = expiresAt - 1;
		const before = await store.sweepExpired();
		now = expiresAt;
		const at = await store.sweepExpired();
		const rows = await rawRows(databaseName);
		await store.close();
		return { at, before, expiresAt, rows };
	} finally {
		Date.now = originalNow;
		await deleteDatabase(databaseName);
	}
}

async function runDeathReopen(primaryDatabaseName: string): Promise<unknown> {
	const selected = createSnapshotQuarantineFixture({
		chunks: [new Uint8Array(131_072).fill(7)],
		objectId: "phase-4c-b-browser-death",
	});
	const store = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
	const scope = await store.openScope(selected.declaration);
	const missing = await scope.missingIndices();
	const rows = await rawRows(`${primaryDatabaseName}--drp-snapshot-quarantine-v1`);
	await store.close();
	return { missing, rows };
}

async function runSchema(): Promise<unknown> {
	const primaryDatabaseName = `phase4cb-${crypto.randomUUID()}`;
	const databaseName = `${primaryDatabaseName}--drp-snapshot-quarantine-v1`;
	const observedDurabilities: unknown[] = [];
	let estimateCalls = 0;
	const transaction = IDBDatabase.prototype.transaction;
	const estimateDescriptor = Object.getOwnPropertyDescriptor(navigator.storage, "estimate");
	IDBDatabase.prototype.transaction = function observedTransaction(
		storeNames: string | Iterable<string>,
		mode?: IDBTransactionMode,
		options?: IDBTransactionOptions
	): IDBTransaction {
		if (mode === "readwrite") observedDurabilities.push(options?.durability);
		return Reflect.apply(transaction, this, [storeNames, mode, options]);
	};
	Object.defineProperty(navigator.storage, "estimate", {
		configurable: true,
		value: (): Promise<StorageEstimate> => {
			estimateCalls += 1;
			return Promise.resolve({ quota: 1_073_741_824, usage: 0 });
		},
	});
	try {
		const store = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
		await store.openScope(fixture().declaration as never);
		const rows = await rawRows(databaseName);
		await store.close();
		return { ...rows, estimateCalls, strict: observedDurabilities.includes("strict") };
	} finally {
		IDBDatabase.prototype.transaction = transaction;
		if (estimateDescriptor === undefined) delete (navigator.storage as unknown as { estimate?: unknown }).estimate;
		else Object.defineProperty(navigator.storage, "estimate", estimateDescriptor);
		await deleteDatabase(databaseName);
	}
}

async function runCarriers(): Promise<unknown> {
	const primaryDatabaseName = `phase4cb-${crypto.randomUUID()}`;
	const databaseName = `${primaryDatabaseName}--drp-snapshot-quarantine-v1`;
	const selected = fixture("phase-4c-b-carrier");
	const cleanManifest = new Uint8Array(selected.declaration.exactCanonicalManifestBytes);
	const store = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
	const opening = store.openScope(selected.declaration as never);
	selected.declaration.exactCanonicalManifestBytes.fill(0);
	const scope = await opening;
	await scope.release();
	const reopened = await store.openScope({
		...selected.declaration,
		exactCanonicalManifestBytes: cleanManifest,
	} as never);
	const status = await reopened.status();
	const descriptor = selected.declaration.chunks[0];
	const cleanChunk = new Uint8Array(selected.chunks[0] as Uint8Array);
	const mutableChunk = new Uint8Array(cleanChunk);
	const reopenedPort = reopened.verificationQuarantine.open(new AbortController().signal);
	const writing = reopenedPort.write(descriptor as never, mutableChunk);
	mutableChunk.fill(0);
	await writing;
	const firstRead = await reopenedPort.read(descriptor as never);
	firstRead?.fill(0);
	const detachedRead = await reopenedPort.read(descriptor as never);
	let hostile = "none";
	try {
		await store.openScope({
			...selected.declaration,
			exactCanonicalManifestBytes: new Uint8Array(212_388),
			scope: { ...selected.declaration.scope, objectId: "phase-4c-b-hostile" },
		} as never);
	} catch (error) {
		hostile = String(Reflect.get(error as object, "code"));
	}
	const controller = new AbortController();
	const abortedPort = reopened.verificationQuarantine.open(controller.signal);
	controller.abort(new Error("stop-before-write"));
	let aborted = "none";
	try {
		await abortedPort.write(selected.declaration.chunks[2] as never, selected.chunks[2] as Uint8Array);
	} catch (error) {
		aborted = String(Reflect.get(error as object, "code"));
	}
	const admitted = reopened.verificationQuarantine.open(new AbortController().signal);
	const admittedWrite = admitted.write(selected.declaration.chunks[2] as never, selected.chunks[2] as Uint8Array);
	const closing = store.close();
	await admittedWrite;
	await closing;
	let afterClose = "none";
	try {
		await admitted.write(selected.declaration.chunks[1] as never, selected.chunks[1] as Uint8Array);
	} catch (error) {
		afterClose = String(Reflect.get(error as object, "code"));
	}
	await deleteDatabase(databaseName);
	return {
		afterClose,
		aborted,
		detachedRead: detachedRead?.byteLength === 131_072 && detachedRead.every((byte) => byte === 1),
		hostile,
		status,
	};
}

async function runUnsupportedSchema(): Promise<unknown> {
	const primaryDatabaseName = `phase4cb-${crypto.randomUUID()}`;
	const databaseName = `${primaryDatabaseName}--drp-snapshot-quarantine-v1`;
	await new Promise<void>((resolvePromise, reject) => {
		const request = indexedDB.open(databaseName, 2);
		request.onerror = (): void => reject(request.error);
		request.onupgradeneeded = (): void => request.result.createObjectStore("foreign");
		request.onsuccess = (): void => {
			request.result.close();
			resolvePromise();
		};
	});
	let code = "none";
	try {
		await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
	} catch (error) {
		code = String(Reflect.get(error as object, "code"));
	}
	await deleteDatabase(databaseName);
	return { code };
}

declare global {
	interface Window {
		phase4cBRun(
			caseId: "carriers" | "death-reopen" | "expiry" | "lifecycle" | "receipt" | "schema" | "unsupported-schema",
			input?: string
		): Promise<unknown>;
	}
}

window.phase4cBRun = async (caseId, input): Promise<unknown> => {
	if (caseId === "carriers") return runCarriers();
	if (caseId === "death-reopen") {
		if (input === undefined) throw new TypeError("death-reopen requires a database name");
		return runDeathReopen(input);
	}
	if (caseId === "expiry") return runExpiry();
	if (caseId === "lifecycle") return runLifecycle();
	if (caseId === "receipt") return runReceipt();
	if (caseId === "unsupported-schema") return runUnsupportedSchema();
	return runSchema();
};
