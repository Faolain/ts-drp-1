import {
	consumeSnapshotVerificationReceipt,
	verifySnapshotStreamWithReceipt,
} from "@ts-drp/compaction/snapshot-quarantine-receipt";

import {
	createSnapshotQuarantineFixture,
	runSnapshotQuarantineBehaviorContract,
	type SnapshotQuarantineFixture,
} from "../../../../tests/fixtures/phase-4c-v3/snapshot-quarantine-contract.js";
import { createBrowserSnapshotQuarantineStore } from "../../src/snapshot-transfer.js";

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
		scopeDetails: readonly Readonly<{ objectId: unknown; state: unknown; expiresAt: unknown }>[];
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
			scopeDetails: scopeRows.map(({ objectId, state, expiresAt }) => ({ objectId, state, expiresAt })),
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

function requiredFixtureValue<T>(value: T | undefined): T {
	if (value === undefined) throw new TypeError("mixed expiry fixture value is absent");
	return value;
}

async function runMixedExpiry(observeStreaming = false): Promise<unknown> {
	const primaryDatabaseName = `phase4cb-mixed-${crypto.randomUUID()}`;
	const databaseName = `${primaryDatabaseName}--drp-snapshot-quarantine-v1`;
	const originalNow = Date.now;
	const originalGetAll = IDBIndex.prototype.getAll;
	const originalOpenCursor = IDBIndex.prototype.openCursor;
	const expiryRequests = { bulkRequests: 0, maximumBulkRows: 0, cursorRequests: 0, cursorRows: 0 };
	if (observeStreaming) {
		IDBIndex.prototype.getAll = function (...args): IDBRequest<unknown[]> {
			const request = originalGetAll.apply(this, args);
			if (this.name === "expiryAsc" && this.objectStore.transaction.db.name === databaseName) {
				expiryRequests.bulkRequests += 1;
				request.addEventListener(
					"success",
					() => {
						expiryRequests.maximumBulkRows = Math.max(expiryRequests.maximumBulkRows, request.result.length);
					},
					{ once: true }
				);
			}
			return request;
		};
		IDBIndex.prototype.openCursor = function (...args): IDBRequest<IDBCursorWithValue | null> {
			const request = originalOpenCursor.apply(this, args);
			if (this.name === "expiryAsc" && this.objectStore.transaction.db.name === databaseName) {
				expiryRequests.cursorRequests += 1;
				request.addEventListener("success", () => {
					if (request.result !== null) expiryRequests.cursorRows += 1;
				});
			}
			return request;
		};
	}
	const extraExpiredScopes = observeStreaming ? 32 : 0;
	let now = 4_000;
	Date.now = (): number => now;
	let store: Awaited<ReturnType<typeof createBrowserSnapshotQuarantineStore>> | undefined;
	const verifiedFixture = fixture("mixed-verified");
	const interruptedFixture = fixture("mixed-interrupted");
	const refreshedFixture = fixture("mixed-refreshed");
	const youngerFixture = fixture("mixed-younger");
	const verify = async (
		scope: Awaited<ReturnType<NonNullable<typeof store>["openScope"]>>,
		selected: SnapshotQuarantineFixture
	): Promise<void> => {
		const stream = verifySnapshotStreamWithReceipt({
			exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
			expectedManifestDigest: selected.declaration.scope.manifestDigest,
			expectedScope: selected.declaration.scope,
			profile: { maxManifestBytes: 212_387, maxSnapshotBytes: 268_435_456, snapshotChunkBytes: 131_072 },
			quarantine: scope.verificationQuarantine,
			source: {
				read: (descriptor) => Promise.resolve(new Uint8Array(requiredFixtureValue(selected.chunks[descriptor.index]))),
			},
		});
		await scope.complete(await stream.receipt);
		await stream.completion;
	};
	try {
		store = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
		const verified = await store.openScope(verifiedFixture.declaration);
		await verify(verified, verifiedFixture);
		const verifiedStatus = await verified.status();
		await verified.release();
		for (let index = 0; index < extraExpiredScopes; index++) {
			const selected = createSnapshotQuarantineFixture({
				objectId: `mixed-extra-${index}`,
				chunks: [new Uint8Array(16)],
			});
			const scope = await store.openScope(selected.declaration);
			await scope.release();
		}
		const interrupted = await store.openScope(interruptedFixture.declaration);
		await interrupted.verificationQuarantine
			.open(new AbortController().signal)
			.write(
				requiredFixtureValue(interruptedFixture.declaration.chunks[0]),
				requiredFixtureValue(interruptedFixture.chunks[0])
			);
		await interrupted.release();
		const refreshed = await store.openScope(refreshedFixture.declaration);
		const port = refreshed.verificationQuarantine.open(new AbortController().signal);
		await port.write(
			requiredFixtureValue(refreshedFixture.declaration.chunks[0]),
			requiredFixtureValue(refreshedFixture.chunks[0])
		);
		const originalExpiry = (await refreshed.status()).expiresAt;
		now = 4_100;
		await port.write(
			requiredFixtureValue(refreshedFixture.declaration.chunks[1]),
			requiredFixtureValue(refreshedFixture.chunks[1])
		);
		const refreshedExpiry = (await refreshed.status()).expiresAt;
		now = 4_200;
		await port.write(
			requiredFixtureValue(refreshedFixture.declaration.chunks[1]),
			requiredFixtureValue(refreshedFixture.chunks[1])
		);
		const duplicateExpiry = (await refreshed.status()).expiresAt;
		await refreshed.release();
		now = 4_300;
		const younger = await store.openScope(youngerFixture.declaration);
		await younger.verificationQuarantine
			.open(new AbortController().signal)
			.write(
				requiredFixtureValue(youngerFixture.declaration.chunks[0]),
				requiredFixtureValue(youngerFixture.chunks[0])
			);
		const youngerExpiry = (await younger.status()).expiresAt;
		await younger.release();
		await store.close();
		store = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
		const reopenedBeforeExpiry = await rawRows(databaseName);
		now = originalExpiry - 1;
		const before = await store.sweepExpired();
		now = originalExpiry;
		const elapsedOnly = await rawRows(databaseName);
		const at = await store.sweepExpired();
		const afterExplicit = await rawRows(databaseName);
		const resumed = await store.openScope(refreshedFixture.declaration);
		const missingBeforeResume = await resumed.missingIndices();
		const resumedPort = resumed.verificationQuarantine.open(new AbortController().signal);
		const exact = await resumedPort.read(requiredFixtureValue(refreshedFixture.declaration.chunks[0]));
		const survivorExact =
			exact?.byteLength === requiredFixtureValue(refreshedFixture.chunks[0]).byteLength &&
			exact.every((byte, index) => byte === requiredFixtureValue(refreshedFixture.chunks[0])[index]);
		await resumedPort.write(
			requiredFixtureValue(refreshedFixture.declaration.chunks[2]),
			requiredFixtureValue(refreshedFixture.chunks[2])
		);
		const completedExpiry = (await resumed.status()).expiresAt;
		// A completion refresh must be distinguishable from the final chunk write.
		now += 1;
		await verify(resumed, refreshedFixture);
		const resumedStatus = await resumed.status();
		await resumed.release();
		now = youngerExpiry;
		await store.close();
		store = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
		const openedStoreOnly = await rawRows(databaseName);
		const maintenance = await store.openScope(fixture("mixed-maintenance").declaration);
		const afterImplicit = await rawRows(databaseName);
		await maintenance.release();
		return {
			extraExpiredScopes,
			expiryRequests,
			verifiedStatus,
			originalExpiry,
			refreshedExpiry,
			duplicateExpiry,
			youngerExpiry,
			reopenedBeforeExpiry,
			before,
			elapsedOnly,
			at,
			afterExplicit,
			missingBeforeResume,
			survivorExact,
			completedExpiry,
			resumedStatus,
			openedStoreOnly,
			afterImplicit,
		};
	} finally {
		Date.now = originalNow;
		IDBIndex.prototype.getAll = originalGetAll;
		IDBIndex.prototype.openCursor = originalOpenCursor;
		try {
			await store?.close();
		} finally {
			await deleteDatabase(databaseName);
		}
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
			caseId:
				| "carriers"
				| "death-reopen"
				| "expiry"
				| "mixed-expiry"
				| "streaming-expiry"
				| "lifecycle"
				| "receipt"
				| "schema"
				| "unsupported-schema",
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
	if (caseId === "mixed-expiry") return runMixedExpiry();
	if (caseId === "streaming-expiry") return runMixedExpiry(true);
	if (caseId === "lifecycle") return runLifecycle();
	if (caseId === "receipt") return runReceipt();
	if (caseId === "unsupported-schema") return runUnsupportedSchema();
	return runSchema();
};
