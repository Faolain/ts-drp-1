import { openPhase2dBrowserDatabase, testOnlyRequestPhase2dUpgrade } from "../../src/internal/schema-idb.js";

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

interface CorrectedSchemaOptions {
	readonly autoIncrement?: string;
	readonly extraIndex?: string;
	readonly extraStore?: boolean;
	readonly omitStore?: string;
	readonly swappedKey?: string;
	readonly wrongKey?: string;
}

function createPrivateV1Schema(database: IDBDatabase, options: CorrectedSchemaOptions = {}): void {
	const create = (name: string, keyPath: string | string[] | undefined): IDBObjectStore | undefined => {
		if (options.omitStore === name) return undefined;
		const selectedKeyPath =
			options.wrongKey === name
				? `${name}WrongKey`
				: options.swappedKey === name && Array.isArray(keyPath)
					? [...keyPath].reverse()
					: keyPath;
		return database.createObjectStore(name, {
			autoIncrement: options.autoIncrement === name,
			...(selectedKeyPath === undefined ? {} : { keyPath: selectedKeyPath }),
		});
	};
	const objects = create("objects", "objectId");
	const generations = create("generations", ["objectId", "generationId"]);
	const blobs = create("blobs", "digest");
	const promotions = create("promotions", ["objectId", "generationId", "digest"]);
	const stores = { blobs, generations, objects, promotions };
	const indexedStore = options.extraIndex === undefined ? undefined : stores[options.extraIndex as keyof typeof stores];
	indexedStore?.createIndex("unexpected", "unexpected");
	if (options.extraStore === true) database.createObjectStore("unexpected");
}

function createHistoricalFiveStoreSchema(database: IDBDatabase): void {
	createPrivateV1Schema(database);
	const votes = database.createObjectStore("votes");
	votes.createIndex("by-object-epoch", ["objectId", "epoch"]);
}

function schemaDescription(database: IDBDatabase): readonly unknown[] {
	const names = [...database.objectStoreNames];
	const transaction = database.transaction(names, "readonly");
	return names.map((name) => {
		const store = transaction.objectStore(name);
		return Object.freeze({
			autoIncrement: store.autoIncrement,
			indexes: [...store.indexNames].map((indexName) => {
				const index = store.index(indexName);
				return Object.freeze({
					keyPath: index.keyPath,
					multiEntry: index.multiEntry,
					name: index.name,
					unique: index.unique,
				});
			}),
			keyPath: store.keyPath,
			name: store.name,
		});
	});
}

async function runNativeCompoundPositiveControl(): Promise<unknown> {
	const databaseName = `phase-2d1-native-control-${crypto.randomUUID()}`;
	try {
		const database = await createDatabase(databaseName, 1, (upgradeDatabase) => {
			upgradeDatabase.createObjectStore("generations", { keyPath: ["objectId", "generationId"] });
		});
		const transaction = database.transaction("generations", "readwrite", { durability: "strict" });
		const store = transaction.objectStore("generations");
		store.add({ generationId: "b\u0000c", objectId: "a" });
		store.add({ generationId: "c", objectId: "a\u0000b" });
		await transactionCompletion(transaction);
		const generationKeyPath = database.transaction("generations").objectStore("generations").keyPath;
		database.close();
		return Object.freeze({
			count: await countGenerationRecords(databaseName),
			generationKeyPath,
		});
	} finally {
		await deleteDatabase(databaseName);
	}
}

async function runPromotionCompoundPositiveControl(): Promise<unknown> {
	const databaseName = `phase-2d1-promotion-control-${crypto.randomUUID()}`;
	try {
		const database = await createDatabase(databaseName, 1, (upgradeDatabase) => {
			upgradeDatabase.createObjectStore("promotions", {
				keyPath: ["objectId", "generationId", "digest"],
			});
		});
		const transaction = database.transaction("promotions", "readwrite", { durability: "strict" });
		const store = transaction.objectStore("promotions");
		store.add({ digest: "c\u0000d", generationId: "b", objectId: "a" });
		store.add({ digest: "d", generationId: "b\u0000c", objectId: "a" });
		await transactionCompletion(transaction);
		const inspection = database.transaction("promotions", "readonly").objectStore("promotions");
		const promotionKeyPath = inspection.keyPath;
		const count = await requestResult(inspection.count());
		database.close();
		return Object.freeze({ count, promotionKeyPath });
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
		return await openAndDescribeProductionSchema(databaseName);
	} finally {
		await deleteDatabase(databaseName);
	}
}

async function runExistingCorrectSchema(): Promise<unknown> {
	const databaseName = `phase-2d1-existing-schema-${crypto.randomUUID()}`;
	try {
		const seeded = await createDatabase(databaseName, 1, (database) => createPrivateV1Schema(database));
		seeded.close();
		return await openAndDescribeProductionSchema(databaseName);
	} finally {
		await deleteDatabase(databaseName);
	}
}

async function runHistoricalFiveStoreSchema(): Promise<unknown> {
	const databaseName = `phase-2d2d-historical-five-store-${crypto.randomUUID()}`;
	try {
		const seeded = await createDatabase(databaseName, 1, (database) => createHistoricalFiveStoreSchema(database));
		seeded.close();
		let opening: unknown;
		try {
			const opened = await openPhase2dBrowserDatabase({ databaseName });
			opening = Object.freeze({ kind: "accepted", version: opened.version });
			opened.close();
		} catch (error) {
			opening = Object.freeze({ error: serializeError(error), kind: "rejected" });
		}
		const afterAttempt = await openAndDescribeRawSchema(databaseName);
		return Object.freeze({ afterAttempt, opening });
	} finally {
		await deleteDatabase(databaseName);
	}
}

async function openAndDescribeRawSchema(databaseName: string): Promise<unknown> {
	const database = await requestResult(indexedDB.open(databaseName));
	try {
		return Object.freeze({
			stores: schemaDescription(database),
			version: database.version,
		});
	} finally {
		database.close();
	}
}

async function openAndDescribeProductionSchema(databaseName: string): Promise<unknown> {
	let handle;
	try {
		handle = await openPhase2dBrowserDatabase({ databaseName });
	} catch (error) {
		return Object.freeze({ kind: "open-error", error: serializeError(error) });
	}
	handle.close();
	const database = await requestResult(indexedDB.open(databaseName));
	try {
		return Object.freeze({
			kind: "opened",
			stores: schemaDescription(database),
			version: database.version,
		});
	} finally {
		database.close();
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
		const seeded = await createDatabase(databaseName, 1, (database) => createPrivateV1Schema(database));
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

async function runUnexpectedPrivateV1Schemas(): Promise<unknown> {
	const scenarios: readonly Readonly<{ name: string; options?: CorrectedSchemaOptions; legacyTwoStore?: true }>[] = [
		{ legacyTwoStore: true, name: "legacy-two-store" },
		...(["objects", "generations", "blobs", "promotions"] as const).map((omitStore) => ({
			name: `missing-${omitStore}`,
			options: { omitStore },
		})),
		{ name: "extra-store", options: { extraStore: true } },
		...(["objects", "generations", "blobs", "promotions"] as const).map((wrongKey) => ({
			name: `wrong-${wrongKey}-key`,
			options: { wrongKey },
		})),
		{ name: "swapped-generations-key-order", options: { swappedKey: "generations" } },
		{ name: "swapped-promotions-key-order", options: { swappedKey: "promotions" } },
		...(["objects", "blobs"] as const).map((autoIncrement) => ({
			name: `${autoIncrement}-auto-increment`,
			options: { autoIncrement },
		})),
		...(["objects", "generations", "blobs", "promotions"] as const).map((extraIndex) => ({
			name: `${extraIndex}-extra-index`,
			options: { extraIndex },
		})),
	];
	const accepted: string[] = [];
	const rejected: string[] = [];
	for (const scenario of scenarios) {
		const databaseName = `phase-2d1-malformed-${scenario.name}-${crypto.randomUUID()}`;
		try {
			const seeded = await createDatabase(databaseName, 1, (database) => {
				if (scenario.legacyTwoStore === true) {
					database.createObjectStore("generations", { keyPath: ["objectId", "generationId"] });
					database.createObjectStore("objects", { keyPath: "objectId" });
				} else createPrivateV1Schema(database, scenario.options);
			});
			seeded.close();
			try {
				const opened = await openPhase2dBrowserDatabase({ databaseName });
				opened.close();
				accepted.push(scenario.name);
			} catch (error) {
				if (serializeError(error).code !== "UNEXPECTED_SCHEMA_VERSION") throw error;
				rejected.push(scenario.name);
			}
		} finally {
			await deleteDatabase(databaseName);
		}
	}
	return Object.freeze({ accepted, rejected });
}

async function runUnexpectedSchemaAndVersion(): Promise<unknown> {
	const malformedName = `phase-2d1-malformed-${crypto.randomUUID()}`;
	const futureName = `phase-2d1-future-${crypto.randomUUID()}`;
	try {
		const malformed = await createDatabase(malformedName, 1, (database) =>
			createPrivateV1Schema(database, { wrongKey: "generations" })
		);
		malformed.close();
		const future = await createDatabase(futureName, 2, (database) => createPrivateV1Schema(database));
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
		runExistingCorrectSchema,
		runFreshSchema,
		runHistoricalFiveStoreSchema,
		runLifecyclePositiveControl,
		runNativeCompoundPositiveControl,
		runPromotionCompoundPositiveControl,
		runUnexpectedPrivateV1Schemas,
		runUnexpectedSchemaAndVersion,
	}),
	writable: false,
});
