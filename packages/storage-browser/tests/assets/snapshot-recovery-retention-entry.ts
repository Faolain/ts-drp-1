import {
	durableIssuancePruningMaintenanceForStore,
	ISSUANCE_RETIREMENT_LIMITS,
} from "@ts-drp/issuance-store/maintenance";
import { createBrowserDurableIssuanceStore } from "@ts-drp/storage-browser/issuance";

import { createSnapshotQuarantineFixture } from "../../../../tests/fixtures/phase-4c-v3/snapshot-quarantine-contract.js";
import { D109B_SCOPE, d109bIssue } from "../../../../tests/fixtures/phase-6b/issuance-retention-contract.js";
import {
	fixture,
	type LegacyStore,
	outcome,
	type OwnerImage,
	receiptFor,
	stable,
} from "../../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import {
	type OrphanedCloseScopeCase,
	retain,
	type RetentionCase,
	type RetentionEnvironment,
	runOrphanedCloseScopeCase,
	runRetentionCase,
	runTemporaryAdmissionCase,
	type TemporaryAdmissionCase,
} from "../../../../tests/fixtures/snapshot-recovery-retention/contract.js";
import { createBrowserSnapshotQuarantineStore } from "../../src/snapshot-transfer.js";
import { createBrowserSnapshotQuarantineStore as createLegacy } from "../fixtures/legacy-snapshot-transfer.mjs";

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.addEventListener("success", () => resolve(value.result), { once: true });
		value.addEventListener("error", () => reject(value.error), { once: true });
	});
}
function terminal(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.addEventListener("complete", () => resolve(), { once: true });
		tx.addEventListener("abort", () => reject(tx.error ?? new Error("native abort")), { once: true });
	});
}

export type NativeCase =
	| "strict-missing"
	| "strict-default"
	| "strict-relaxed"
	| "abort-after-write"
	| "late-abort"
	| "prevented-request-error"
	| "active-release"
	| "neighbor-isolation"
	| "cursor-key-row-mismatch"
	| "cursor-key-row-control"
	| "earlier-refusal-late-signal";

async function runNative(name: NativeCase, env: RetentionEnvironment, databaseName: string): Promise<unknown> {
	const store = await env.open();
	const selected = name.startsWith("cursor-key-row-")
		? createSnapshotQuarantineFixture({
				objectId: "retention-native",
				chunks: [new Uint8Array(131_072).fill(37), Uint8Array.of(1, 9, 4)],
			})
		: fixture("retention-native");
	const scope = await store.openScope(selected.declaration);
	await scope.complete(await receiptFor(scope, selected));
	if (name === "neighbor-isolation") {
		const neighbor = fixture("retention-native-z");
		const neighboringScope = await store.openScope(neighbor.declaration);
		await neighboringScope.complete(await receiptFor(neighboringScope, neighbor));
	}
	if (name === "earlier-refusal-late-signal")
		await env.fault(
			"owned-open-missing",
			selected.declaration.scope.objectId,
			selected.declaration.totalBytes + selected.declaration.exactCanonicalManifestBytes.byteLength
		);
	const beforeImage = await env.image();
	const before = stable(beforeImage);
	const controller = new AbortController();
	const nativeTransaction = IDBDatabase.prototype.transaction;
	const nativePut = IDBObjectStore.prototype.put;
	const nativeAbort = IDBTransaction.prototype.abort;
	const nativeGetAll = IDBObjectStore.prototype.getAll;
	const nativeGet = IDBObjectStore.prototype.get;
	const requestResultDescriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result");
	if (requestResultDescriptor?.get === undefined) throw new Error("native request result getter absent");
	const nativeObjectStore = IDBTransaction.prototype.objectStore;
	const valueDescriptor = Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype, "value");
	const keyDescriptors = ["key", "primaryKey"].map((property) => ({
		property,
		descriptor: Object.getOwnPropertyDescriptor(IDBCursor.prototype, property),
	}));
	if (valueDescriptor?.get === undefined) throw new Error("native cursor value getter absent");
	const evidence = {
		transactions: 0,
		transactionStores: [] as string[],
		keyOnlyControlRows: 0,
		writes: 0,
		storeAccess: 0,
		payloadBatches: 0,
		otherScopePayloads: 0,
		requestSuccess: 0,
		complete: 0,
		abort: 0,
		error: 0,
		settledAfterTerminal: false,
		abortThrew: false,
		lateCancellationDispatched: false,
		keyMismatchExposures: 0,
		keyMismatchWitnesses: [] as {
			property: string;
			nativeKey: IDBValidKey;
			exposedKey: IDBValidKey;
			nativeRowIndex: unknown;
			rowIndex: unknown;
		}[],
		requestedStrict: false,
		nativeReportedStrict: false,
		exposedDurability: null as string | null,
	};
	let target: IDBTransaction | undefined;
	let release: Promise<void> | undefined;
	for (const { property, descriptor } of keyDescriptors) {
		if (descriptor?.get === undefined) throw new Error(`native cursor ${property} getter absent`);
		Object.defineProperty(IDBCursor.prototype, property, {
			...descriptor,
			get: function (this: IDBCursorWithValue): IDBValidKey {
				const actual = Reflect.apply(descriptor.get as () => IDBValidKey, this, []) as IDBValidKey;
				const source = this.source instanceof IDBIndex ? this.source.objectStore : this.source;
				if (
					name.startsWith("cursor-key-row-") &&
					this instanceof IDBCursorWithValue &&
					source.transaction === target &&
					source.name === "chunks" &&
					Array.isArray(actual) &&
					actual.length === 5 &&
					actual[0] === selected.declaration.scope.objectId &&
					actual[4] === 0
				) {
					const exposed = [...actual];
					exposed[4] = 1;
					const row: unknown = Reflect.apply(valueDescriptor.get as () => unknown, this, []);
					evidence.keyMismatchExposures++;
					const rowIndex: unknown = row !== null && typeof row === "object" ? Reflect.get(row, "index") : null;
					evidence.keyMismatchWitnesses.push({
						property,
						nativeKey: actual,
						exposedKey: exposed,
						nativeRowIndex: rowIndex,
						rowIndex,
					});
					return exposed;
				}
				return actual;
			},
		});
	}
	IDBObjectStore.prototype.get = function (query): IDBRequest<unknown> {
		const result = nativeGet.call(this, query);
		if (
			name.startsWith("cursor-key-row-") &&
			this.transaction === target &&
			this.name === "chunks" &&
			Array.isArray(query) &&
			query.length === 5 &&
			query[0] === selected.declaration.scope.objectId &&
			query[4] === 0
		) {
			// Key-cursor/getAllKeys + per-chunk get is a legal alternate traversal.
			// Expose disagreement at its keyed result rather than demanding a value cursor.
			const occupied = beforeImage.durableChunks.find((row) => row.index === 1);
			if (occupied === undefined) throw new Error("synthetic observation control needs a second valid chunk");
			Object.defineProperty(result, "result", {
				configurable: true,
				get: (): unknown => {
					const actual: unknown = Reflect.apply(requestResultDescriptor.get as () => unknown, result, []);
					evidence.keyMismatchExposures++;
					evidence.keyMismatchWitnesses.push({
						property: "get.result",
						nativeKey: query,
						exposedKey: query,
						nativeRowIndex: actual !== null && typeof actual === "object" ? Reflect.get(actual, "index") : null,
						rowIndex: occupied.index,
					});
					return occupied;
				},
			});
		}
		return result;
	};
	IDBTransaction.prototype.objectStore = function (name): IDBObjectStore {
		if (this === target) evidence.storeAccess++;
		return nativeObjectStore.call(this, name);
	};
	IDBObjectStore.prototype.getAll = function (query, count): IDBRequest<unknown[]> {
		if (this.transaction === target && this.name === "chunks") evidence.payloadBatches++;
		return nativeGetAll.call(this, query, count);
	};
	Object.defineProperty(IDBCursorWithValue.prototype, "value", {
		...valueDescriptor,
		get: function (this: IDBCursorWithValue): unknown {
			const value: unknown = Reflect.apply(valueDescriptor.get as () => unknown, this, []);
			if (
				this.source instanceof IDBObjectStore &&
				this.source.transaction === target &&
				this.source.name === "chunks" &&
				value !== null &&
				typeof value === "object" &&
				Reflect.get(value, "objectId") !== selected.declaration.scope.objectId
			)
				evidence.otherScopePayloads++;
			return value;
		},
	});
	IDBTransaction.prototype.abort = function (): void {
		try {
			nativeAbort.call(this);
		} catch (error) {
			if (this === target) evidence.abortThrew = true;
			throw error;
		}
		if (this === target && name === "earlier-refusal-late-signal") controller.abort();
	};
	IDBDatabase.prototype.transaction = function (storeNames, mode, options): IDBTransaction {
		const tx = nativeTransaction.call(
			this,
			typeof storeNames === "string" ? storeNames : [...storeNames],
			mode,
			options
		);
		if (this.name !== databaseName || mode !== "readwrite") return tx;
		evidence.transactions++;
		if (target !== undefined) return tx;
		target = tx;
		evidence.transactionStores = [...tx.objectStoreNames].sort();
		evidence.requestedStrict = options?.durability === "strict";
		evidence.nativeReportedStrict = tx.durability === "strict";
		tx.addEventListener("complete", () => {
			evidence.complete++;
			if (name === "late-abort") {
				evidence.lateCancellationDispatched = true;
				controller.abort();
			}
		});
		tx.addEventListener("abort", () => {
			evidence.abort++;
		});
		tx.addEventListener("error", () => {
			evidence.error++;
		});
		if (name.startsWith("strict-"))
			Object.defineProperty(tx, "durability", {
				configurable: true,
				get: () => (name === "strict-missing" ? undefined : name.slice(7)),
			});
		evidence.exposedDurability = tx.durability ?? null;
		if (name === "prevented-request-error") {
			const owner = tx.objectStore("owner");
			const read = owner.get("owner");
			read.addEventListener("success", () => {
				const duplicate = owner.add(read.result);
				duplicate.addEventListener("error", (event) => event.preventDefault());
			});
		}
		return tx;
	};
	IDBObjectStore.prototype.put = function (value, key): IDBRequest<IDBValidKey> {
		const result = key === undefined ? nativePut.call(this, value) : nativePut.call(this, value, key);
		if (this.transaction === target) {
			evidence.writes++;
			result.addEventListener("success", () => {
				evidence.requestSuccess++;
				if (name === "abort-after-write") controller.abort();
				if (name === "active-release") release = scope.release();
			});
		}
		return result;
	};
	let result;
	try {
		if (name === "cursor-key-row-control") {
			// Independent platform controls: no adapter retention or durable row mutation.
			const db = await request(indexedDB.open(databaseName));
			try {
				const tx = db.transaction(["owner", "scopes", "chunks"], "readwrite", { durability: "strict" });
				const done = terminal(tx);
				await new Promise<void>((resolve, reject) => {
					const cursorRequest = tx.objectStore("chunks").openCursor();
					cursorRequest.addEventListener("error", () => reject(cursorRequest.error));
					cursorRequest.addEventListener("success", () => {
						const cursor = cursorRequest.result;
						if (cursor === null) {
							resolve();
							return;
						}
						// Access both native key properties and the untouched native row.
						void cursor.key;
						void cursor.primaryKey;
						void cursor.value;
						cursor.continue();
					});
				});
				const keys = await request(tx.objectStore("chunks").getAllKeys());
				const firstKey = keys[0];
				if (firstKey === undefined) throw new Error("native key-list control returned no keys");
				await request(tx.objectStore("chunks").get(firstKey));
				await new Promise<void>((resolve, reject) => {
					const cursorRequest = tx.objectStore("chunks").openKeyCursor();
					cursorRequest.addEventListener("error", () => reject(cursorRequest.error));
					cursorRequest.addEventListener("success", () => {
						const cursor = cursorRequest.result;
						if (cursor === null) {
							resolve();
							return;
						}
						void cursor.key;
						void cursor.primaryKey;
						evidence.keyOnlyControlRows++;
						cursor.continue();
					});
				});
				await done;
				result = { code: "none", detail: "Independent native platform control; adapter retention not called" };
			} finally {
				db.close();
			}
		} else result = await outcome(() => retain(scope, { signal: controller.signal }));
		evidence.settledAfterTerminal = evidence.complete + evidence.abort === 1;
		await release;
	} finally {
		IDBDatabase.prototype.transaction = nativeTransaction;
		IDBObjectStore.prototype.put = nativePut;
		IDBTransaction.prototype.abort = nativeAbort;
		IDBObjectStore.prototype.getAll = nativeGetAll;
		IDBObjectStore.prototype.get = nativeGet;
		IDBTransaction.prototype.objectStore = nativeObjectStore;
		Object.defineProperty(IDBCursorWithValue.prototype, "value", valueDescriptor);
		for (const { property, descriptor } of keyDescriptors)
			if (descriptor !== undefined) Object.defineProperty(IDBCursor.prototype, property, descriptor);
	}
	return {
		code: result.code,
		detail: result.detail ?? null,
		mechanism:
			evidence.transactions === 0 && result.detail?.includes("retainForRecovery API absent")
				? "MASKED_BY_ABSENT_RETENTION_API"
				: name.endsWith("-control")
					? "independent-native-platform-control"
					: "native-retention-transaction-observed",
		evidence,
		unchanged: before === stable(await env.image()),
		recoveryScopes: (await store.recoveryStatus()).recoveryScopes,
		injection: name.startsWith("cursor-key-row-")
			? "synthetic-native-cursor-observation-inline-key-row-storage-unchanged"
			: "native-transaction-instrumentation-not-disk-exhaustion",
	};
}

async function run(name: RetentionCase | NativeCase | `temporary-${TemporaryAdmissionCase}`): Promise<unknown> {
	const primaryDatabaseName = `retention-red-${crypto.randomUUID()}`;
	const databaseName = `${primaryDatabaseName}--drp-snapshot-quarantine-v1`;
	const stores: LegacyStore[] = [];
	const existing = async (): Promise<IDBDatabase> => {
		if (!(await indexedDB.databases()).some((row) => row.name === databaseName))
			throw new Error("inspection must not create missing database");
		return request(indexedDB.open(databaseName));
	};
	const env: RetentionEnvironment = {
		open: async (recoveryLimits) => {
			const store = await createBrowserSnapshotQuarantineStore({
				primaryDatabaseName,
				...(recoveryLimits === undefined ? {} : { recoveryLimits }),
			} as Parameters<typeof createBrowserSnapshotQuarantineStore>[0]);
			stores.push(store);
			return store;
		},
		legacy: async () => {
			const store = await createLegacy({ primaryDatabaseName });
			stores.push(store);
			return store;
		},
		exists: async () => (await indexedDB.databases()).some((row) => row.name === databaseName),
		image: async (): Promise<OwnerImage> => {
			const db = await existing();
			try {
				const tx = db.transaction([...db.objectStoreNames], "readonly");
				const done = terminal(tx);
				const schema = [...db.objectStoreNames].map((key) => {
					const value = tx.objectStore(key);
					return {
						name: key,
						keyPath: value.keyPath,
						autoIncrement: value.autoIncrement,
						indexes: [...value.indexNames],
					};
				});
				const [scopes, chunks, ownerRows, chunkKeys] = await Promise.all([
					request(tx.objectStore("scopes").getAll()) as Promise<Record<string, unknown>[]>,
					request(tx.objectStore("chunks").getAll()) as Promise<Record<string, unknown>[]>,
					request(tx.objectStore("owner").getAll()),
					request(tx.objectStore("chunks").getAllKeys()),
				]);
				await done;
				return {
					version: db.version,
					names: [...db.objectStoreNames],
					schema: { stores: schema, chunkKeys },
					ownerRows,
					durableScopes: scopes,
					durableChunks: chunks,
					scopes,
					chunks,
				};
			} finally {
				db.close();
			}
		},
		fault: async (kind, objectId, charge) => {
			const db = await existing();
			try {
				const tx = db.transaction(["scopes", "chunks", "owner"], "readwrite", { durability: "strict" });
				const done = terminal(tx);
				const scopes = tx.objectStore("scopes"),
					chunks = tx.objectStore("chunks"),
					owner = tx.objectStore("owner");
				const rows = (await request(scopes.getAll())) as Record<string, unknown>[];
				const row = rows.find((value) => value.objectId === objectId);
				if (row === undefined) throw new Error("fault injection target absent");
				if (kind === "identity-conflict") scopes.put({ ...row, totalBytes: Number(row.totalBytes) + 1 });
				if (kind === "poisoned-state") scopes.put({ ...row, state: "poisoned" });
				const key = [row.objectId, row.epoch, row.anchor, row.manifestDigest] as IDBValidKey[];
				const chunk = (await request(chunks.get([...key, 0]))) as Record<string, unknown>;
				if (kind.startsWith("owned-")) {
					scopes.put({ ...row, retention: "recovery", state: kind === "owned-verified-missing" ? "verified" : "open" });
					const ownerRow = (await request(owner.get("owner"))) as Record<string, unknown>;
					owner.put({ ...ownerRow, recoveryScopes: 1, recoveryContentBytes: charge });
				}
				if (kind === "extra" || kind === "missing-extra" || kind === "extra-oversized" || kind === "extra-string")
					chunks.put({
						...chunk,
						index: kind === "extra-oversized" ? 99999 : kind === "extra-string" ? "unexpected" : -1,
					});
				if (kind === "descriptor-corrupt") chunks.put({ ...chunk, digest: "invalid" });
				if (kind.includes("missing")) chunks.delete([...key, 0]);
				if (kind === "owned-open-conflict" || kind === "owned-open-missing-conflict") {
					const occupied =
						kind === "owned-open-missing-conflict"
							? ((await request(chunks.get([...key, 1]))) as Record<string, unknown>)
							: chunk;
					if (!(occupied.exactBytes instanceof Uint8Array)) throw new Error("occupied fault target bytes absent");
					chunks.put({ ...occupied, exactBytes: new Uint8Array(occupied.exactBytes.byteLength) });
				}
				if (kind === "corrupt") chunks.put({ ...chunk, exactBytes: new Uint8Array(4) });
				await done;
			} finally {
				db.close();
			}
		},
	};
	try {
		if (
			[
				"strict-missing",
				"strict-default",
				"strict-relaxed",
				"abort-after-write",
				"late-abort",
				"prevented-request-error",
				"active-release",
				"neighbor-isolation",
				"cursor-key-row-mismatch",
				"cursor-key-row-control",
				"earlier-refusal-late-signal",
			].includes(name)
		)
			return await runNative(name as NativeCase, env, databaseName);
		if (name.startsWith("temporary-"))
			return await runTemporaryAdmissionCase(name.slice(10) as TemporaryAdmissionCase, env);
		if (name.startsWith("orphaned-"))
			return await runOrphanedCloseScopeCase(name.slice(9) as OrphanedCloseScopeCase, env);
		return await runRetentionCase(name as RetentionCase, env);
	} finally {
		for (const store of stores) await store.close();
		await request(indexedDB.deleteDatabase(databaseName));
	}
}
declare global {
	interface Window {
		runSnapshotRecoveryRetention(
			name: RetentionCase | NativeCase | `temporary-${TemporaryAdmissionCase}` | `orphaned-${OrphanedCloseScopeCase}`
		): Promise<unknown>;
		runSnapshotRetirementSourceImage(): Promise<unknown>;
		runIssuanceRetirementSourceControl(): Promise<unknown>;
	}
}
window.runSnapshotRecoveryRetention = run;
window.runIssuanceRetirementSourceControl = async (): Promise<unknown> => {
	const primaryDatabaseName = `issuance-source-control-${crypto.randomUUID()}`;
	let store = await createBrowserDurableIssuanceStore({ primaryDatabaseName });
	try {
		await d109bIssue(store, D109B_SCOPE, 1);
		const owner = durableIssuancePruningMaintenanceForStore(store);
		if (owner?.readBoundedRecoveryCensus === undefined || owner.acquireRetirementControl === undefined)
			throw new Error("native census absent");
		const input = { objectId: D109B_SCOPE.objectId, limits: ISSUANCE_RETIREMENT_LIMITS };
		const before = await owner.readBoundedRecoveryCensus(input);
		const acquire: unknown = Reflect.get(store, "acquireNativeReadReservation");
		if (typeof acquire !== "function") throw new Error("original native reservation absent");
		const held = (await Reflect.apply(acquire, store, [{ objectId: input.objectId }])) as {
			check(): Promise<void>;
			release(): Promise<void>;
		};
		const nativeTransaction = IDBDatabase.prototype.transaction;
		let transactions = 0;
		IDBDatabase.prototype.transaction = function (...args): IDBTransaction {
			if (this.name === `${primaryDatabaseName}--drp-issuance-v1`) transactions++;
			return Reflect.apply(nativeTransaction, this, args) as IDBTransaction;
		};
		let borrowed;
		let birthRefused;
		try {
			borrowed = await owner.readBoundedRecoveryCensus(input);
			birthRefused = await outcome(() => owner.acquireRetirementControl?.({ objectId: input.objectId }));
			await held.check();
		} finally {
			IDBDatabase.prototype.transaction = nativeTransaction;
			await held.release();
		}
		const first = await owner.acquireRetirementControl({ objectId: input.objectId });
		const born = await owner.readBoundedRecoveryCensus(input);
		const prepared = await first.prepareFence({
			decisionDigest: "33".repeat(32),
			sourceProofDigest: "44".repeat(32),
			throughEpoch: 0,
			protectedRecords: [],
		});
		await first.release();
		const during = await owner.readBoundedRecoveryCensus(input);
		const second = await owner.acquireRetirementControl({ objectId: input.objectId });
		const completed = await second.commitPrepared();
		await second.release();
		const after = await owner.readBoundedRecoveryCensus(input);
		await store.close();
		store = await createBrowserDurableIssuanceStore({ primaryDatabaseName });
		const reopened = durableIssuancePruningMaintenanceForStore(store);
		if (reopened?.readBoundedRecoveryCensus === undefined) throw new Error("reopened native census absent");
		return {
			nullableControl: before.control === null,
			borrowedExact: stable(before) === stable(borrowed),
			borrowedTransactions: transactions,
			birthRefusal: birthRefused.code,
			birthRefusalDetail: birthRefused.detail,
			bornExact: stable(born.control) === stable(first.control),
			preparedExact: stable(during.control) === stable(prepared),
			completedExact: stable(after.control) === stable(completed),
			dataUnchanged: [born, during, after].every(
				(value) => stable(value.rows) === stable(before.rows) && stable(value.image) === stable(before.image)
			),
			reopenedExact: stable(await reopened.readBoundedRecoveryCensus(input)) === stable(after),
		};
	} finally {
		await store.close();
		await request(indexedDB.deleteDatabase(`${primaryDatabaseName}--drp-issuance-v1`));
	}
};
window.runSnapshotRetirementSourceImage = async (): Promise<unknown> => {
	const primaryDatabaseName = `snapshot-source-image-${crypto.randomUUID()}`;
	const databaseName = `${primaryDatabaseName}--drp-snapshot-quarantine-v1`;
	const objectId = "snapshot-source-image";
	let owner = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
	let raw: IDBDatabase | undefined;
	try {
		for (const epoch of [0, 1]) {
			const selected = createSnapshotQuarantineFixture({ objectId, epoch, chunks: [Uint8Array.of(3, 5, 8)] });
			const scope = await owner.openScope(selected.declaration);
			try {
				await scope.complete(await receiptFor(scope, selected));
				if (epoch === 0) await scope.retainForRecovery();
			} finally {
				await scope.release();
			}
		}
		const read = owner.readRetirementImage;
		const acquire = owner.acquireRetirementControl;
		const inventory = owner.captureRecoveryRoleInventory;
		if (read === undefined || acquire === undefined || inventory === undefined)
			throw new Error("native source port absent");
		const before = await read({ objectId });
		const census = await inventory({ objectId });
		if (!(await indexedDB.databases()).some((row) => row.name === databaseName))
			throw new Error("inspection must not create native owner");
		raw = await request(indexedDB.open(databaseName));
		const inspect = raw.transaction("retirementControls", "readonly");
		const inspected = terminal(inspect);
		const controlsBefore = await request(inspect.objectStore("retirementControls").count());
		await inspected;
		const view = await acquire({ objectId });
		let borrowed;
		let transactions = 0;
		const nativeTransaction = IDBDatabase.prototype.transaction;
		IDBDatabase.prototype.transaction = function (...args): IDBTransaction {
			if (this.name === databaseName) transactions++;
			return Reflect.apply(nativeTransaction, this, args) as IDBTransaction;
		};
		try {
			borrowed = await read({ objectId });
		} finally {
			IDBDatabase.prototype.transaction = nativeTransaction;
			await view.release();
		}
		const stale = await acquire({ objectId });
		// Queue a genuine foreign RW behind the held native RO, then let prepare join
		// that RO. The queued metadata change precedes its original fresh-image CAS.
		const drift = raw.transaction("scopes", "readwrite", { durability: "strict" });
		const drifted = terminal(drift);
		const rows = request(drift.objectStore("scopes").getAll()) as Promise<Record<string, unknown>[]>;
		const mutation = rows.then((values) => {
			const temporary = values.find((row) => row.objectId === objectId && row.epoch === 1);
			if (temporary === undefined || typeof temporary.expiresAt !== "number")
				throw new Error("temporary metadata absent");
			drift.objectStore("scopes").put({ ...temporary, expiresAt: temporary.expiresAt + 1 });
		});
		const refused = await outcome(() =>
			stale.prepareFence({
				decisionDigest: "33".repeat(32),
				sourceProofDigest: "44".repeat(32),
				throughEpoch: 0,
				protectedScopes: stale.image.scopes.filter((entry) => entry.scope.epoch === 0),
			})
		);
		await mutation;
		await drifted;
		const changed = await read({ objectId });
		const censusAfter = await inventory({ objectId });
		raw.close();
		raw = undefined;
		await owner.close();
		owner = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
		const reopened = owner.readRetirementImage;
		if (reopened === undefined) throw new Error("reopened source port absent");
		return {
			controlsBefore,
			nullControl: before.control === null,
			scopeCount: before.image.scopeCount,
			chunkCount: before.image.chunkCount,
			recoveryScopeCount: census.scopes.length,
			borrowedTransactions: transactions,
			birthPreservedImage: stable(borrowed.image) === stable(before.image),
			borrowedExactControl: stable(borrowed.control) === stable(view.control),
			temporaryDriftChangesImage: changed.image.imageDigest !== before.image.imageDigest,
			recoveryInventoryUnchanged: stable(censusAfter.scopes) === stable(census.scopes),
			refusal: refused.code,
			refusalPreservedControl: stable(changed.control) === stable(stale.control),
			reopenedExact: stable(await reopened({ objectId })) === stable(changed),
		};
	} finally {
		raw?.close();
		await owner.close();
		await request(indexedDB.deleteDatabase(databaseName));
	}
};
