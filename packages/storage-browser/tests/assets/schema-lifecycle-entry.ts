import {
	openPhase2dBrowserDatabase,
	testOnlyAttemptStrictMutation,
	testOnlyRequestPhase2dUpgrade,
} from "../../src/internal/schema-idb.js";

const EXPECTED_SCHEMA_REASON = "unexpected browser storage schema/version";

interface SerializedError {
	readonly code: unknown;
	readonly message: string;
	readonly name: string;
}

function serializeError(error: unknown): SerializedError {
	const candidate = error as { readonly code?: unknown; readonly message?: unknown; readonly name?: unknown };
	return Object.freeze({
		code: candidate?.code ?? null,
		message: typeof candidate?.message === "string" ? candidate.message : String(error),
		name: typeof candidate?.name === "string" ? candidate.name : "UnknownError",
	});
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new TypeError("IDB request failed")), {
			once: true,
		});
	});
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new TypeError("transaction aborted")), {
			once: true,
		});
		transaction.addEventListener("error", () => reject(transaction.error ?? new TypeError("transaction failed")), {
			once: true,
		});
	});
}

async function deleteDatabase(databaseName: string): Promise<void> {
	await requestResult(indexedDB.deleteDatabase(databaseName));
}

async function createDatabase(
	databaseName: string,
	version: number,
	upgrade: (database: IDBDatabase) => void
): Promise<IDBDatabase> {
	const request = indexedDB.open(databaseName, version);
	request.addEventListener("upgradeneeded", () => upgrade(request.result), { once: true });
	return requestResult(request);
}

async function countGenerationRecords(databaseName: string): Promise<number> {
	const database = await requestResult(indexedDB.open(databaseName));
	try {
		if (!database.objectStoreNames.contains("generations")) return 0;
		const transaction = database.transaction("generations", "readonly");
		const count = await requestResult(transaction.objectStore("generations").count());
		await transactionCompletion(transaction);
		return count;
	} finally {
		database.close();
	}
}

async function runNativeCompoundPositiveControl(): Promise<unknown> {
	const databaseName = `phase-2d1-native-control-${crypto.randomUUID()}`;
	try {
		const database = await createDatabase(databaseName, 1, (upgradeDatabase) => {
			upgradeDatabase.createObjectStore("generations", { keyPath: ["objectId", "generationId"] });
			const votes = upgradeDatabase.createObjectStore("votes");
			votes.createIndex("by-object-epoch", ["objectId", "epoch"]);
		});
		const transaction = database.transaction("generations", "readwrite", { durability: "strict" });
		const store = transaction.objectStore("generations");
		store.add({ generationId: "b\u0000c", objectId: "a" });
		store.add({ generationId: "c", objectId: "a\u0000b" });
		await transactionCompletion(transaction);
		const generationKeyPath = database.transaction("generations").objectStore("generations").keyPath;
		const voteIndexKeyPath = database.transaction("votes").objectStore("votes").index("by-object-epoch").keyPath;
		database.close();
		return Object.freeze({
			count: await countGenerationRecords(databaseName),
			generationKeyPath,
			voteIndexKeyPath,
		});
	} finally {
		await deleteDatabase(databaseName);
	}
}

async function runLifecyclePositiveControl(): Promise<unknown> {
	const databaseName = `phase-2d1-lifecycle-control-${crypto.randomUUID()}`;
	try {
		const cooperative = await createDatabase(databaseName, 1, (database) => {
			database.createObjectStore("control");
		});
		let versionchangeObserved = false;
		cooperative.onversionchange = (): void => {
			versionchangeObserved = true;
			cooperative.close();
		};
		let cooperativeBlocked = false;
		const cooperativeUpgrade = indexedDB.open(databaseName, 2);
		cooperativeUpgrade.onblocked = (): void => {
			cooperativeBlocked = true;
		};
		const upgraded = await requestResult(cooperativeUpgrade);
		upgraded.close();

		const noncooperative = await requestResult(indexedDB.open(databaseName));
		let blockedObserved = false;
		const blockedUpgrade = indexedDB.open(databaseName, 3);
		blockedUpgrade.onblocked = (): void => {
			blockedObserved = true;
			noncooperative.close();
		};
		const finallyUpgraded = await requestResult(blockedUpgrade);
		finallyUpgraded.close();
		return Object.freeze({ blockedObserved, cooperativeBlocked, versionchangeObserved });
	} finally {
		await deleteDatabase(databaseName);
	}
}

async function runDecisionMismatch(): Promise<unknown> {
	const databaseName = `phase-2d1-decision-${crypto.randomUUID()}`;
	try {
		let error: SerializedError | null = null;
		try {
			await openPhase2dBrowserDatabase({
				databaseName,
				testOnlyDecisionBinding: { chosen: "idb-strict", linkSha256: "0".repeat(64) },
			});
		} catch (caught) {
			error = serializeError(caught);
		}
		const databases = await indexedDB.databases();
		let databaseCreated = false;
		for (const database of databases) {
			if (database.name === databaseName) databaseCreated = true;
		}
		return Object.freeze({
			databaseCreated,
			error,
		});
	} finally {
		await deleteDatabase(databaseName);
	}
}

async function runFreshSchema(): Promise<unknown> {
	const databaseName = `phase-2d1-schema-${crypto.randomUUID()}`;
	try {
		let handle;
		try {
			handle = await openPhase2dBrowserDatabase({ databaseName });
		} catch (error) {
			return Object.freeze({ kind: "open-error", error: serializeError(error) });
		}
		handle.close();
		const database = await requestResult(indexedDB.open(databaseName));
		try {
			const generationStore = database.transaction("generations").objectStore("generations");
			const votesStore = database.transaction("votes").objectStore("votes");
			return Object.freeze({
				generationKeyPath: generationStore.keyPath,
				kind: "opened",
				version: database.version,
				voteIndexKeyPath: votesStore.index("by-object-epoch").keyPath,
			});
		} finally {
			database.close();
		}
	} finally {
		await deleteDatabase(databaseName);
	}
}

async function runStrictMutation(observedDurability: IDBTransactionDurability): Promise<unknown> {
	const databaseName = `phase-2d1-strict-${crypto.randomUUID()}`;
	try {
		let result: unknown = null;
		let error: SerializedError | null = null;
		try {
			result = await testOnlyAttemptStrictMutation({
				databaseName,
				testOnlyForcedObservedDurability: observedDurability,
			});
		} catch (caught) {
			error = serializeError(caught);
		}
		return Object.freeze({ committedRecords: await countGenerationRecords(databaseName), error, result });
	} finally {
		await deleteDatabase(databaseName);
	}
}

async function runCooperativeVersionchange(): Promise<unknown> {
	const databaseName = `phase-2d1-cooperative-${crypto.randomUUID()}`;
	try {
		let handle;
		try {
			handle = await openPhase2dBrowserDatabase({ databaseName });
		} catch (error) {
			return Object.freeze({ kind: "open-error", error: serializeError(error) });
		}
		let blocked = false;
		const upgrade = indexedDB.open(databaseName, 2);
		upgrade.onblocked = (): void => {
			blocked = true;
		};
		const upgraded = await requestResult(upgrade);
		upgraded.close();
		handle.close();
		return Object.freeze({ blocked, kind: "upgraded" });
	} finally {
		await deleteDatabase(databaseName);
	}
}

async function runBlockedUpgrade(): Promise<unknown> {
	const databaseName = `phase-2d1-blocked-${crypto.randomUUID()}`;
	let blocker: IDBDatabase | null = null;
	try {
		const seeded = await createDatabase(databaseName, 1, (database) => {
			database.createObjectStore("generations", { keyPath: ["objectId", "generationId"] });
			const votes = database.createObjectStore("votes");
			votes.createIndex("by-object-epoch", ["objectId", "epoch"]);
		});
		seeded.close();
		blocker = await requestResult(indexedDB.open(databaseName));
		const started = performance.now();
		let error: SerializedError | null = null;
		try {
			await testOnlyRequestPhase2dUpgrade({
				blockedTimeoutMilliseconds: 250,
				databaseName,
				targetVersion: 2,
			});
		} catch (caught) {
			error = serializeError(caught);
		}
		return Object.freeze({ elapsedMilliseconds: performance.now() - started, error });
	} finally {
		blocker?.close();
		await deleteDatabase(databaseName);
	}
}

async function runUnexpectedSchemaAndVersion(): Promise<unknown> {
	const malformedName = `phase-2d1-malformed-${crypto.randomUUID()}`;
	const futureName = `phase-2d1-future-${crypto.randomUUID()}`;
	try {
		const malformed = await createDatabase(malformedName, 1, (database) => {
			database.createObjectStore("generations", { keyPath: "encodedKey" });
			database.createObjectStore("votes");
		});
		malformed.close();
		const future = await createDatabase(futureName, 2, (database) => {
			database.createObjectStore("generations", { keyPath: ["objectId", "generationId"] });
			const votes = database.createObjectStore("votes");
			votes.createIndex("by-object-epoch", ["objectId", "epoch"]);
		});
		future.close();
		const errors: SerializedError[] = [];
		for (const databaseName of [malformedName, futureName]) {
			try {
				const opened = await openPhase2dBrowserDatabase({ databaseName });
				opened.close();
			} catch (error) {
				errors.push(serializeError(error));
			}
		}
		return Object.freeze({ errors, expectedReason: EXPECTED_SCHEMA_REASON });
	} finally {
		await deleteDatabase(malformedName);
		await deleteDatabase(futureName);
	}
}

Object.defineProperty(globalThis, "phase2dSchemaHarness", {
	configurable: false,
	enumerable: false,
	value: Object.freeze({
		runBlockedUpgrade,
		runCooperativeVersionchange,
		runDecisionMismatch,
		runFreshSchema,
		runLifecyclePositiveControl,
		runNativeCompoundPositiveControl,
		runStrictMutation,
		runUnexpectedSchemaAndVersion,
	}),
	writable: false,
});
