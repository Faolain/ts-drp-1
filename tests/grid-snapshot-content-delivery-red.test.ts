/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent native observers retain actual runtime signatures. */
/* eslint-disable @typescript-eslint/consistent-type-imports -- importOriginal describes the observed production module. */
import "fake-indexeddb/auto";
import { verifySnapshotStreamWithReceipt } from "@ts-drp/compaction/snapshot-quarantine-receipt";
import { snapshotQuarantineContract, type SnapshotQuarantineDeclaration } from "@ts-drp/storage/snapshot-transfer";
import { createBrowserSnapshotQuarantineStore } from "@ts-drp/storage-browser/snapshot-transfer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverFixtureSnapshot, readFixtureSnapshotDeclaration } from "./fixtures/grid-snapshot-content-delivery.js";
import { createSnapshotQuarantineFixture } from "./fixtures/phase-4c-v3/snapshot-quarantine-contract.js";

const native = vi.hoisted(() => ({ completions: [] as { database: string; receipt: unknown; completed: boolean }[] }));
const sourceBoundary = vi.hoisted(() => ({
	resolved: undefined as undefined | ((index: number, bytes: Uint8Array | undefined) => void),
}));
vi.mock("../packages/compaction/dist/src/snapshot-quarantine-receipt.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("@ts-drp/compaction/snapshot-quarantine-receipt")>();
	return {
		...real,
		verifySnapshotStreamWithReceipt: (input: Parameters<typeof real.verifySnapshotStreamWithReceipt>[0]) =>
			real.verifySnapshotStreamWithReceipt({
				...input,
				source: {
					read: async (...args: Parameters<typeof input.source.read>) => {
						const bytes = await input.source.read(...args);
						sourceBoundary.resolved?.(args[0].index, bytes);
						return bytes;
					},
				},
			}),
	};
});
vi.mock("../packages/storage-browser/dist/src/snapshot-transfer.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("@ts-drp/storage-browser/snapshot-transfer")>();
	return {
		...real,
		createBrowserSnapshotQuarantineStore: async (
			...args: Parameters<typeof real.createBrowserSnapshotQuarantineStore>
		) => {
			const store = await real.createBrowserSnapshotQuarantineStore(...args);
			const open = store.openScope.bind(store);
			return {
				...store,
				openScope: async (...input: Parameters<typeof open>) => {
					const scope = await open(...input);
					const complete = scope.complete.bind(scope);
					return {
						...scope,
						complete: async (...completion: Parameters<typeof complete>) => {
							const event = { database: args[0].primaryDatabaseName, receipt: completion[0], completed: false };
							native.completions.push(event);
							const reference = await complete(...completion);
							event.completed = true;
							return reference;
						},
					};
				},
			};
		},
	};
});

const suffix = "--drp-snapshot-quarantine-v1";
const profile = {
	maxManifestBytes: snapshotQuarantineContract.limits.maxManifestBytes,
	maxSnapshotBytes: snapshotQuarantineContract.limits.maxSnapshotBytes,
	snapshotChunkBytes: snapshotQuarantineContract.limits.snapshotChunkBytes,
};
type Fixture = ReturnType<typeof createSnapshotQuarantineFixture>;
type Row = Record<string, unknown>;
let sequence = 700000;
const names: string[] = [];
function pair(): { source: string; target: string } {
	const family = `d110c-f5b-parent-${++sequence}-peer-`;
	const source = family + "0";
	const target = family + "1";
	names.push(source + suffix, target + suffix);
	return { source, target };
}
function fixture(objectId = "delivery-object", epoch = 4): Fixture {
	return createSnapshotQuarantineFixture({
		objectId,
		epoch,
		chunks: [new Uint8Array(131072).fill(7), Uint8Array.of(2, 3, 4)],
	});
}
function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.addEventListener("success", () => resolve(value.result));
		value.addEventListener("error", () => reject(value.error));
	});
}
function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.addEventListener("complete", () => resolve());
		tx.addEventListener("abort", () => reject(tx.error ?? new Error("aborted")));
	});
}
async function image(primary: string): Promise<Record<string, { keys: IDBValidKey[]; rows: Row[] }>> {
	const database = await request(indexedDB.open(primary + suffix));
	try {
		const tx = database.transaction([...database.objectStoreNames], "readonly");
		const complete = done(tx);
		const entries = await Promise.all(
			[...database.objectStoreNames].map(async (name) => {
				const store = tx.objectStore(name);
				return [
					name,
					{ keys: await request(store.getAllKeys()), rows: (await request(store.getAll())) as Row[] },
				] as const;
			})
		);
		await complete;
		return Object.fromEntries(entries);
	} finally {
		database.close();
	}
}
async function mutate(primary: string, storeName: string, action: (store: IDBObjectStore) => void): Promise<void> {
	const database = await request(indexedDB.open(primary + suffix));
	try {
		const tx = database.transaction(storeName, "readwrite", { durability: "strict" });
		const complete = done(tx);
		action(tx.objectStore(storeName));
		await complete;
	} finally {
		database.close();
	}
}
async function seed(primary: string, selected: Fixture, owned = false, partial = false): Promise<void> {
	const store = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName: primary });
	const scope = await store.openScope(selected.declaration);
	try {
		if (partial) {
			const port = scope.verificationQuarantine.open(new AbortController().signal);
			try {
				await port.write(selected.declaration.chunks[0], selected.chunks[0]);
			} finally {
				await port.discard();
			}
		} else {
			const stream = verifySnapshotStreamWithReceipt({
				exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.declaration.scope.manifestDigest,
				expectedScope: selected.declaration.scope,
				profile,
				quarantine: scope.verificationQuarantine,
				source: { read: (descriptor) => Promise.resolve(selected.chunks[descriptor.index]) },
			});
			for await (const bytes of stream) expect(bytes.byteLength).toBeGreaterThan(0);
			await stream.completion;
			expect(await scope.complete(await stream.receipt), "SETUP_NATIVE_COMPLETE_REFERENCE_FORWARDED").toEqual({
				chunkCount: selected.declaration.chunks.length,
				exactByteLength: selected.declaration.totalBytes,
				scope: selected.declaration.scope,
			});
			if (owned) {
				await scope.retainForRecovery();
				expect((await scope.status()).retention, "SETUP_GENUINE_NATIVE_RETENTION").toBe("recovery");
			}
		}
	} finally {
		await scope.release();
		await store.close();
	}
}
function input(pairing: ReturnType<typeof pair>, selected: Fixture): Parameters<typeof deliverFixtureSnapshot>[0] {
	return {
		sourcePrimaryDatabaseName: pairing.source,
		targetPrimaryDatabaseName: pairing.target,
		objectId: selected.declaration.scope.objectId,
		closedEpoch: selected.declaration.scope.epoch,
	};
}
function local(primary: string, selected: Fixture): Parameters<typeof readFixtureSnapshotDeclaration>[0] {
	return {
		primaryDatabaseName: primary,
		objectId: selected.declaration.scope.objectId,
		closedEpoch: selected.declaration.scope.epoch,
	};
}
async function content(primary: string, selected: Fixture, declaration: SnapshotQuarantineDeclaration): Promise<void> {
	expect(declaration).toEqual(selected.declaration);
	const stored = await image(primary);
	const scope = stored.scopes.rows.find((row) => row.manifestDigest === declaration.scope.manifestDigest);
	expect(scope).toMatchObject({
		state: "verified",
		exactCanonicalManifestBytes: declaration.exactCanonicalManifestBytes,
	});
	const chunks = stored.chunks.rows
		.filter((row) => row.manifestDigest === declaration.scope.manifestDigest)
		.sort((a, b) => Number(a.index) - Number(b.index));
	expect(chunks.map((row) => row.exactBytes)).toEqual(selected.chunks);
}
interface Access {
	database: string;
	store: string;
	method: string;
	rows: number;
	query: unknown;
	keys: unknown[];
}
async function schema(primary: string): Promise<{
	version: number;
	stores: {
		name: string;
		keyPath: string | string[] | null;
		autoIncrement: boolean;
		indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
	}[];
}> {
	const database = await request(indexedDB.open(primary + suffix));
	try {
		const tx = database.transaction([...database.objectStoreNames], "readonly"),
			complete = done(tx);
		const stores = [...database.objectStoreNames].map((name) => {
			const store = tx.objectStore(name);
			return {
				name,
				keyPath: store.keyPath,
				autoIncrement: store.autoIncrement,
				indexes: [...store.indexNames].map((indexName) => {
					const index = store.index(indexName);
					return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
				}),
			};
		});
		await complete;
		return { version: database.version, stores };
	} finally {
		database.close();
	}
}
function telemetry(source: string, target: string): Access[] {
	const events: Access[] = [];
	for (const method of [
		"getAll",
		"getAllKeys",
		"get",
		"getKey",
		"count",
		"openCursor",
		"openKeyCursor",
		"put",
		"add",
		"clear",
	] as const) {
		const original = IDBObjectStore.prototype[method];
		vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
			const result = Reflect.apply(original, this, args) as IDBRequest;
			if (this.transaction.db.name === source + suffix || this.transaction.db.name === target + suffix) {
				const event: Access = {
					database: this.transaction.db.name,
					store: this.name,
					method,
					rows: 0,
					query: args[0],
					keys: [],
				};
				events.push(event);
				result.addEventListener("success", () => {
					const value: unknown = result.result;
					event.rows +=
						Array.isArray(value) && method !== "getKey"
							? value.length
							: value === null || value === undefined
								? 0
								: method === "count"
									? Number(value)
									: 1;
					if (method === "openCursor" || method === "openKeyCursor") {
						if (value !== null) event.keys.push((value as IDBCursor).primaryKey);
					} else if (method === "get" && value !== undefined) {
						const row = value as Row;
						event.keys.push(
							args[0] instanceof IDBKeyRange
								? [
										row.objectId,
										row.epoch,
										row.anchor,
										row.manifestDigest,
										...(this.name === "chunks" ? [row.index] : []),
									]
								: args[0]
						);
					} else if (method === "getKey" && value !== undefined) event.keys.push(value);
					else if (method === "getAll")
						for (const row of value as Row[])
							event.keys.push([row.objectId, row.epoch, row.anchor, row.manifestDigest]);
					else if (method === "getAllKeys") event.keys.push(...(value as IDBValidKey[]));
				});
			}
			return result;
		});
	}
	for (const method of ["get", "getKey", "getAll", "getAllKeys", "openCursor", "openKeyCursor", "count"] as const) {
		const original = IDBIndex.prototype[method];
		vi.spyOn(IDBIndex.prototype, method).mockImplementation(function (this: IDBIndex, ...args: unknown[]) {
			const result = Reflect.apply(original, this, args) as IDBRequest;
			if (this.objectStore.transaction.db.name === source + suffix) {
				const event: Access = {
					database: source + suffix,
					store: this.objectStore.name,
					method: "index." + method,
					rows: 0,
					query: args[0],
					keys: [],
				};
				events.push(event);
				result.addEventListener("success", () => {
					const value: unknown = result.result;
					event.rows +=
						Array.isArray(value) && method !== "getKey"
							? value.length
							: value === null || value === undefined
								? 0
								: typeof value === "number"
									? value
									: 1;
					if (method === "openCursor" || method === "openKeyCursor") {
						if (value !== null) event.keys.push((value as IDBCursor).primaryKey);
					} else if (method === "getAll")
						for (const row of value as Row[])
							event.keys.push([row.objectId, row.epoch, row.anchor, row.manifestDigest]);
					else if (method === "get" && value !== undefined) {
						const row = value as Row;
						event.keys.push([row.objectId, row.epoch, row.anchor, row.manifestDigest]);
					} else if (method === "getAllKeys") event.keys.push(...(value as IDBValidKey[]));
					else if (method === "getKey" && value !== undefined) event.keys.push(value);
				});
			}
			return result;
		});
	}
	return events;
}
function boundedHeaders(events: Access[], source: string, selected: Fixture): void {
	const accesses = events.filter((event) => event.database === source + suffix && event.store === "scopes");
	expect(accesses.length, "SOURCE_HEADER_SELECTION_REQUIRED").toBeGreaterThan(0);
	expect(
		new Set(accesses.flatMap((event) => event.keys.map((key) => JSON.stringify(key)))).size,
		"SOURCE_VISITS_AT_MOST_TWO_DISTINCT_CANDIDATES"
	).toBeLessThanOrEqual(2);
	for (const event of accesses.filter((event) => event.method === "count" || event.method === "index.count"))
		expect(event.rows, "SOURCE_CENSUS_CANNOT_SCAN_PAST_SECOND_CANDIDATE").toBeLessThanOrEqual(2);
	for (const event of accesses)
		for (const key of event.keys)
			expect((key as unknown[]).slice(0, 2), "SOURCE_ONLY_SELECTED_OBJECT_EPOCH").toEqual([
				selected.declaration.scope.objectId,
				selected.declaration.scope.epoch,
			]);
	expect(
		events.filter((event) => event.database === source + suffix && event.store === "owner"),
		"NO_SOURCE_OWNER_ROW_READ"
	).toEqual([]);
}
interface SourceResult {
	store: string;
	method: string;
	transaction: IDBTransaction;
	request: IDBRequest;
	key: unknown;
	row: Row;
}
/**
 * Observes actual result events; setup/image readers run before this is installed.
 * @param primary - Exact source primary name.
 * @param observe - Detached event observer or explicit fault injector.
 */
function sourceResults(primary: string, observe: (event: SourceResult) => void): void {
	function attach(store: IDBObjectStore, method: string, args: unknown[], result: IDBRequest): void {
		if (store.transaction.db.name !== primary + suffix) return;
		result.addEventListener("success", () => {
			const value: unknown = result.result;
			if (value === undefined || value === null) return;
			if (method.endsWith("openCursor")) {
				const cursor = value as IDBCursorWithValue;
				observe({
					store: store.name,
					method,
					transaction: store.transaction,
					request: result,
					key: cursor.primaryKey,
					row: cursor.value as Row,
				});
			} else if (method.endsWith("getAll")) {
				for (const row of value as Row[])
					observe({
						store: store.name,
						method,
						transaction: store.transaction,
						request: result,
						key: [
							row.objectId,
							row.epoch,
							row.anchor,
							row.manifestDigest,
							...(store.name === "chunks" ? [row.index] : []),
						],
						row,
					});
			} else {
				const row = value as Row;
				observe({
					store: store.name,
					method,
					transaction: store.transaction,
					request: result,
					key:
						method === "get" && !(args[0] instanceof IDBKeyRange)
							? args[0]
							: [row.objectId, row.epoch, row.anchor, row.manifestDigest],
					row,
				});
			}
		});
	}
	for (const method of ["get", "getAll", "openCursor"] as const) {
		const original = IDBObjectStore.prototype[method];
		vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
			const result = Reflect.apply(original, this, args) as IDBRequest;
			attach(this, method, args, result);
			return result;
		});
		const originalIndex = IDBIndex.prototype[method];
		vi.spyOn(IDBIndex.prototype, method).mockImplementation(function (this: IDBIndex, ...args: unknown[]) {
			const result = Reflect.apply(originalIndex, this, args) as IDBRequest;
			attach(this.objectStore, "index." + method, args, result);
			return result;
		});
	}
}
async function rejected(operation: Promise<unknown>): Promise<boolean> {
	try {
		await operation;
		return false;
	} catch {
		return true;
	}
}
afterEach(async () => {
	vi.restoreAllMocks();
	sourceBoundary.resolved = undefined;
	native.completions = [];
	for (const name of names.splice(0)) await request(indexedDB.deleteDatabase(name));
});

describe("fixture snapshot content delivery — patched IndexedDB API evidence, not native durability", () => {
	it("native control forwards a genuine receipt and promotes through strict patched transactions", async () => {
		const p = pair(),
			selected = fixture();
		const reads: number[] = [];
		sourceBoundary.resolved = (index) => {
			reads.push(index);
		};
		await seed(p.source, selected, true);
		sourceBoundary.resolved = undefined;
		expect(reads, "NATIVE_CONTROL_PROVES_VERIFIER_SOURCE_OBSERVER_IS_ACTIVE").toEqual([0, 1]);
		expect(native.completions).toEqual([{ database: p.source, receipt: expect.any(Object), completed: true }]);
		const actual = await image(p.source);
		expect(actual.owner.rows[0]).toMatchObject({
			recoveryScopes: 1,
			recoveryContentBytes:
				selected.declaration.totalBytes + selected.declaration.exactCanonicalManifestBytes.byteLength,
		});
		expect(actual.scopes.rows[0]).toMatchObject({ retention: "recovery", state: "verified" });
	});
	it("telemetry control observes source object and index routes while excluding destination index scans", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		await seed(p.target, selected);
		const events = telemetry(p.source, p.target);
		for (const primary of [p.source, p.target]) {
			const database = await request(indexedDB.open(primary + suffix));
			try {
				const tx = database.transaction("scopes", "readonly"),
					complete = done(tx),
					store = tx.objectStore("scopes");
				await request(store.getAll());
				await request(store.index("expiryAsc").getAll());
				await new Promise<void>((resolve, reject) => {
					const cursor = store.index("expiryAsc").openCursor();
					cursor.addEventListener("error", () => reject(cursor.error));
					cursor.addEventListener("success", () => {
						if (cursor.result === null) resolve();
						else cursor.result.continue();
					});
				});
				await complete;
			} finally {
				database.close();
			}
		}
		expect(
			events
				.filter((event) => event.database === p.source + suffix)
				.map((event) => ({ method: event.method, rows: event.rows }))
		).toEqual([
			{ method: "getAll", rows: 1 },
			{ method: "index.getAll", rows: 1 },
			{ method: "index.openCursor", rows: 1 },
		]);
		expect(events.filter((event) => event.database === p.target + suffix && event.method.startsWith("index."))).toEqual(
			[]
		);
	});
	it("ordinary temporary delivery preserves selected content and the complete source image", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const before = await image(p.source);
		const result = await deliverFixtureSnapshot(input(p, selected));
		await content(p.target, selected, result);
		expect(await image(p.source)).toEqual(before);
	});
	it("readonly source extraction leaves an expired temporary sibling sentinel untouched", async () => {
		const p = pair(),
			selected = fixture(),
			sentinel = fixture("expired-sentinel", 3);
		await seed(p.source, selected);
		await seed(p.source, sentinel);
		const old = await image(p.source);
		const row = old.scopes.rows.find((value) => value.objectId === "expired-sentinel");
		await mutate(p.source, "scopes", (store) => {
			store.put({ ...row, expiresAt: 1 });
		});
		const before = await image(p.source);
		const modes: string[] = [];
		const transaction = IDBDatabase.prototype.transaction;
		vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
			this: IDBDatabase,
			...args: Parameters<typeof transaction>
		) {
			if (this.name === p.source + suffix) modes.push(args[1] ?? "readonly");
			return Reflect.apply(transaction, this, args);
		});
		await content(p.target, selected, await deliverFixtureSnapshot(input(p, selected)));
		expect(modes.length).toBeGreaterThan(0);
		expect(modes.every((mode) => mode === "readonly")).toBe(true);
		expect(await image(p.source)).toEqual(before);
	});
	it("genuinely recovery-owned source yields temporary destination content with independent incarnation", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected, true);
		const before = await image(p.source);
		const result = await deliverFixtureSnapshot(input(p, selected));
		await content(p.target, selected, result);
		const after = await image(p.target);
		expect(after.scopes.rows[0].retention).toBe("temporary");
		expect(after.scopes.rows[0].incarnation).not.toBe(before.scopes.rows[0].incarnation);
		expect(after.owner.rows[0]).toMatchObject({ recoveryScopes: 0, recoveryContentBytes: 0 });
		expect(await image(p.source)).toEqual(before);
	});
	it("unrelated recovery-owned destination and its accounting survive delivery", async () => {
		const p = pair(),
			selected = fixture(),
			protectedSnapshot = fixture("protected", 2);
		await seed(p.source, selected);
		await seed(p.target, protectedSnapshot, true);
		const before = await image(p.target);
		await deliverFixtureSnapshot(input(p, selected));
		const after = await image(p.target);
		expect(after.owner).toEqual(before.owner);
		expect(after.scopes.rows).toEqual(expect.arrayContaining(before.scopes.rows));
		expect(after.chunks.rows).toEqual(expect.arrayContaining(before.chunks.rows));
	});
	it("destination-owned durable limits survive ordinary content admission", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const store = await createBrowserSnapshotQuarantineStore({
			primaryDatabaseName: p.target,
			recoveryLimits: { maxRecoveryScopes: 2, maxRecoveryContentBytes: 268_435_456 },
		});
		await store.close();
		const before = await image(p.target);
		await deliverFixtureSnapshot(input(p, selected));
		expect((await image(p.target)).owner).toEqual(before.owner);
	});
	it("refused delivery preserves unrelated recovery-owned destination content and accounting", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		await seed(p.target, fixture("protected-refusal", 2), true);
		const before = await image(p.target),
			source = await image(p.source);
		await mutate(p.source, "chunks", (store) => {
			store.delete(source.chunks.keys[1]);
		});
		expect(await rejected(deliverFixtureSnapshot(input(p, selected)))).toBe(true);
		const after = await image(p.target);
		expect(after.owner).toEqual(before.owner);
		expect(after.scopes.rows).toEqual(expect.arrayContaining(before.scopes.rows));
		expect(after.chunks.rows).toEqual(expect.arrayContaining(before.chunks.rows));
	});
	it("selected epoch only is admitted, without copying sibling source epochs", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		await seed(p.source, fixture("delivery-object", 3));
		await deliverFixtureSnapshot(input(p, selected));
		expect((await image(p.target)).scopes.rows.map((row) => row.epoch)).toEqual([4]);
	});
	it.each([false, true])(
		"exact existing destination reuses bytes through genuine completion (owned=%s)",
		async (owned) => {
			const p = pair(),
				selected = fixture();
			await seed(p.source, selected);
			await seed(p.target, selected, owned);
			const before = await image(p.target);
			native.completions = [];
			const events = telemetry(p.source, p.target);
			const result = await deliverFixtureSnapshot(input(p, selected));
			vi.restoreAllMocks();
			expect(result).toEqual(selected.declaration);
			boundedHeaders(events, p.source, selected);
			expect(events.filter((e) => e.database === p.source + suffix && e.store === "chunks")).toEqual([]);
			expect(
				events.filter(
					(e) => e.database === p.target + suffix && e.store === "chunks" && ["put", "add", "clear"].includes(e.method)
				)
			).toEqual([]);
			expect(native.completions.filter((e) => e.database === p.target)).toEqual([
				{ database: p.target, receipt: expect.any(Object), completed: true },
			]);
			expect(await image(p.target)).toEqual(before);
		}
	);
	it("partial destination reads exactly the missing source descriptor and completes natively", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		await seed(p.target, selected, false, true);
		native.completions = [];
		const events = telemetry(p.source, p.target);
		const result = await deliverFixtureSnapshot(input(p, selected));
		vi.restoreAllMocks();
		await content(p.target, selected, result);
		const reads = events.filter((e) => e.database === p.source + suffix && e.store === "chunks");
		boundedHeaders(events, p.source, selected);
		expect(reads.map((e) => ({ method: e.method, query: e.query }))).toEqual([
			{
				method: "get",
				query: [
					selected.declaration.scope.objectId,
					4,
					selected.declaration.scope.anchor,
					selected.declaration.scope.manifestDigest,
					1,
				],
			},
		]);
		expect(native.completions.filter((e) => e.database === p.target && e.completed)).toHaveLength(1);
	});
	it("bounded selector visits no historical payloads and at most two matching scope rows", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		for (let epoch = 0; epoch < 4; epoch++) await seed(p.source, fixture("history", epoch));
		const events = telemetry(p.source, p.target);
		expect(await readFixtureSnapshotDeclaration(local(p.source, selected))).toEqual(selected.declaration);
		const accesses = events.filter((e) => e.database === p.source + suffix);
		boundedHeaders(events, p.source, selected);
		expect(accesses.filter((e) => e.store === "chunks")).toEqual([]);
	});
	it("ambiguous prefix stops after two visited candidates even when three exist", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const current = await image(p.source);
		await mutate(p.source, "scopes", (store) => {
			store.put({ ...current.scopes.rows[0], manifestDigest: "ee".repeat(32), state: "open" });
			store.put({ ...current.scopes.rows[0], manifestDigest: "ff".repeat(32), state: "poisoned" });
		});
		const events = telemetry(p.source, p.target);
		const refused = await rejected(readFixtureSnapshotDeclaration(local(p.source, selected)));
		boundedHeaders(events, p.source, selected);
		expect(refused).toBe(true);
	});
	it("fresh transfer bounds source selection and payload reads independently of destination admission", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		for (let epoch = 0; epoch < 4; epoch++) await seed(p.source, fixture("history", epoch));
		const events = telemetry(p.source, p.target);
		await deliverFixtureSnapshot(input(p, selected));
		boundedHeaders(events, p.source, selected);
		const chunks = events.filter((event) => event.database === p.source + suffix && event.store === "chunks");
		expect(chunks.map((event) => ({ method: event.method, key: event.query }))).toEqual(
			selected.declaration.chunks.map((descriptor) => ({
				method: "get",
				key: [
					selected.declaration.scope.objectId,
					4,
					selected.declaration.scope.anchor,
					selected.declaration.scope.manifestDigest,
					descriptor.index,
				],
			}))
		);
	});
	it("requested chunks share readonly header rechecks and expose copied bytes only after transaction completion", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const results: SourceResult[] = [],
			completed = new Set<IDBTransaction>(),
			observedTransactions = new Set<IDBTransaction>();
		sourceResults(p.source, (event) => {
			results.push(event);
			if (!observedTransactions.has(event.transaction)) {
				observedTransactions.add(event.transaction);
				event.transaction.addEventListener("complete", () => {
					completed.add(event.transaction);
				});
			}
		});
		const reads: number[] = [];
		sourceBoundary.resolved = (index, bytes) => {
			reads.push(index);
			const fetched = results.findLast((event) => event.store === "chunks" && event.row.index === index);
			expect(fetched, "SOURCE_DESCRIPTOR_HAS_ACTUAL_REQUEST_RESULT").toBeDefined();
			if (fetched === undefined || bytes === undefined) throw new Error("SOURCE_DESCRIPTOR_RESULT_MISSING");
			expect(fetched.transaction.mode).toBe("readonly");
			expect(completed.has(fetched.transaction), "SOURCE_BYTES_NOT_EXPOSED_BEFORE_TX_COMPLETE").toBe(true);
			expect(
				results.some(
					(event) =>
						event.store === "scopes" &&
						event.transaction === fetched.transaction &&
						event.row.incarnation !== undefined &&
						event.row.manifestDigest === selected.declaration.scope.manifestDigest
				),
				"SAME_TRANSACTION_SELECTED_HEADER_RECHECK"
			).toBe(true);
			const raw = fetched.row.exactBytes;
			expect(raw).toBeInstanceOf(Uint8Array);
			if (!(raw instanceof Uint8Array)) throw new Error("SOURCE_BYTES_SHAPE");
			expect(bytes).not.toBe(raw);
			expect(bytes.buffer, "SOURCE_BYTES_OWN_COPIED_BUFFER").not.toBe(raw.buffer);
			const copy = new Uint8Array(bytes);
			raw.fill(0);
			expect(bytes).toEqual(copy);
		};
		const result = await deliverFixtureSnapshot(input(p, selected));
		sourceBoundary.resolved = undefined;
		vi.restoreAllMocks();
		expect(reads, "GENUINE_VERIFIER_SOURCE_CALLBACKS_OBSERVED").toEqual([0, 1]);
		await content(p.target, selected, result);
	});
	it("the requested object selects among verified peers at the same epoch", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		await seed(p.source, fixture("other-object"));
		expect(await readFixtureSnapshotDeclaration(local(p.source, selected))).toEqual(selected.declaration);
	});
	it("caller object identity cannot be silently replaced by the stored row", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		expect(await rejected(readFixtureSnapshotDeclaration({ ...local(p.source, selected), objectId: "absent" }))).toBe(
			true
		);
	});
	it.each(["open", "poisoned"])(
		"a second same-prefix %s candidate refuses instead of being filtered out",
		async (state) => {
			const p = pair(),
				selected = fixture();
			await seed(p.source, selected);
			const before = await image(p.source);
			await mutate(p.source, "scopes", (store) => {
				store.put({ ...before.scopes.rows[0], manifestDigest: "ff".repeat(32), state });
			});
			expect(await rejected(readFixtureSnapshotDeclaration(local(p.source, selected)))).toBe(true);
		}
	);
	it.each(
		(["open", "poisoned"] as const).flatMap((state) =>
			(["local", "transfer"] as const).map((mode) => [state, mode] as const)
		)
	)("a lone %s source candidate refuses (%s)", async (state, mode) => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const genuine = await image(p.source);
		expect(genuine.scopes.rows, "SETUP_ONE_GENUINE_VERIFIED_CANDIDATE").toHaveLength(1);
		expect(genuine.scopes.rows[0].state).toBe("verified");
		await mutate(p.source, "scopes", (store) => {
			store.put({ ...genuine.scopes.rows[0], state });
		});
		const before = await image(p.source);
		expect(before, "SETUP_ONLY_CANDIDATE_STATE_CHANGED").toEqual({
			...genuine,
			scopes: { ...genuine.scopes, rows: [{ ...genuine.scopes.rows[0], state }] },
		});
		const refused = await rejected(
			mode === "local"
				? readFixtureSnapshotDeclaration(local(p.source, selected))
				: deliverFixtureSnapshot(input(p, selected))
		);
		expect({ refused, image: await image(p.source) }).toEqual({ refused: true, image: before });
	});
	it.each(["incarnation", "descriptors", "manifest"])("v2 %s damage refuses lookup", async (kind) => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const before = await image(p.source),
			row = { ...before.scopes.rows[0] };
		if (kind === "manifest") row.exactCanonicalManifestBytes = Uint8Array.of(0);
		else row[kind] = null;
		await mutate(p.source, "scopes", (store) => {
			store.put(row);
		});
		expect(await rejected(readFixtureSnapshotDeclaration(local(p.source, selected)))).toBe(true);
	});
	it.each(["missing", "corrupt", "shape"])("requested %s chunk cannot resolve successful delivery", async (kind) => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const before = await image(p.source);
		await mutate(p.source, "chunks", (store) => {
			if (kind === "missing") store.delete(before.chunks.keys[1]);
			else store.put({ ...before.chunks.rows[1], exactBytes: kind === "shape" ? "not-bytes" : new Uint8Array(3) });
		});
		expect(await rejected(deliverFixtureSnapshot(input(p, selected)))).toBe(true);
	});
	it.each(["transfer", "local"])("already aborted %s cannot resolve a declaration", async (mode) => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const signal = AbortSignal.abort("fixture abort");
		expect(
			await rejected(
				mode === "transfer"
					? deliverFixtureSnapshot({ ...input(p, selected), signal })
					: readFixtureSnapshotDeclaration({ ...local(p.source, selected), signal })
			)
		).toBe(true);
	});
	it.each(["wrong-family", "creator-target", "fresh-source", "leading-zero", "suffixed"])(
		"invalid transfer namespace %s refuses",
		async (variant) => {
			const p = pair(),
				selected = fixture();
			await seed(p.source, selected);
			const args = { ...input(p, selected) };
			if (variant === "wrong-family") args.targetPrimaryDatabaseName = "d110c-f5b-parent-999-peer-1";
			if (variant === "creator-target") args.targetPrimaryDatabaseName = p.source;
			if (variant === "fresh-source") args.sourcePrimaryDatabaseName += "-fresh";
			if (variant === "leading-zero") args.targetPrimaryDatabaseName = p.target.slice(0, -1) + "01";
			if (variant === "suffixed") args.sourcePrimaryDatabaseName += suffix;
			expect(await rejected(deliverFixtureSnapshot(args))).toBe(true);
		}
	);
	it("valid fresh destination receives selected content", async () => {
		const p = pair(),
			selected = fixture();
		p.target += "-fresh";
		names.push(p.target + suffix);
		await seed(p.source, selected);
		await content(p.target, selected, await deliverFixtureSnapshot(input(p, selected)));
	});
	it.each(["transfer", "local"])("absent source %s refuses without creating a database", async (mode) => {
		const p = pair(),
			selected = fixture();
		const before = await indexedDB.databases();
		expect(
			await rejected(
				mode === "transfer"
					? deliverFixtureSnapshot(input(p, selected))
					: readFixtureSnapshotDeclaration(local(p.source, selected))
			)
		).toBe(true);
		expect(await indexedDB.databases()).toEqual(before);
	});
	it("deletion ordered ahead of source open wins the race without recreation", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const open = indexedDB.open.bind(indexedDB);
		const ordering: string[] = [];
		let injected = false;
		vi.spyOn(indexedDB, "open").mockImplementation((...args: Parameters<typeof indexedDB.open>) => {
			if (args[0] === p.source + suffix && !injected) {
				injected = true;
				ordering.push("delete-request");
				const deletion = indexedDB.deleteDatabase(args[0]);
				deletion.addEventListener("success", () => ordering.push("delete-success"));
				ordering.push("source-open-request");
				const opening = open(...args);
				opening.addEventListener("upgradeneeded", () => ordering.push("source-upgrade"));
				return opening;
			}
			return open(...args);
		});
		expect(await rejected(deliverFixtureSnapshot(input(p, selected)))).toBe(true);
		console.info(
			"FIXTURE_DELIVERY_OBSERVATION",
			JSON.stringify({ kind: "ordered-source-deletion", ordering, databases: await indexedDB.databases() })
		);
		expect(ordering).toEqual(["delete-request", "source-open-request", "delete-success", "source-upgrade"]);
		expect((await indexedDB.databases()).some((db) => db.name === p.source + suffix)).toBe(false);
	});
	it("already-v2 legacy hold refuses without modifying destination image", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		await seed(p.target, fixture("legacy"));
		const current = await image(p.target);
		await mutate(p.target, "scopes", (store) => {
			store.put({ ...current.scopes.rows[0], retention: "legacy-unclassified", descriptors: null });
		});
		await mutate(p.target, "owner", (store) => {
			store.put({
				...current.owner.rows[0],
				migration: "classification-required",
				legacyUnclassifiedScopes: 1,
				legacyUnclassifiedContentBytes:
					Number(current.scopes.rows[0].totalBytes) +
					(current.scopes.rows[0].exactCanonicalManifestBytes as Uint8Array).byteLength,
			});
		});
		const before = await image(p.target);
		const outcome = await deliverFixtureSnapshot(input(p, selected)).then(
			() => ({ refused: false, code: undefined }),
			(error: unknown) => ({
				refused: true,
				code: typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined,
			})
		);
		expect({ ...outcome, image: await image(p.target) }).toEqual({
			refused: true,
			code: "migration-required",
			image: before,
		});
	});
	it("source incarnation replacement is ordered after header capture and before subsequent chunk results", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const before = await image(p.source),
			database = await request(indexedDB.open(p.source + suffix));
		const ordering: string[] = [];
		let mutation: Promise<void> | undefined;
		sourceResults(p.source, (event) => {
			if (
				event.store === "scopes" &&
				event.row.objectId === selected.declaration.scope.objectId &&
				mutation === undefined
			) {
				ordering.push("selected-header-captured");
				const tx = database.transaction("scopes", "readwrite", { durability: "strict" });
				mutation = done(tx).then(() => {
					ordering.push("replacement-committed");
				});
				tx.objectStore("scopes").put({ ...before.scopes.rows[0], incarnation: "replacement-incarnation" });
			} else if (event.store === "chunks" && mutation !== undefined) ordering.push("post-capture-chunk-result");
		});
		try {
			const refused = await rejected(deliverFixtureSnapshot(input(p, selected)));
			await mutation;
			ordering.push("attempt-settled");
			console.info(
				"FIXTURE_DELIVERY_OBSERVATION",
				JSON.stringify({ kind: "source-incarnation-replacement", ordering, refused })
			);
			expect(ordering[0], "SETUP_ACTUAL_SOURCE_HEADER_CAPTURE").toBe("selected-header-captured");
			const committed = ordering.indexOf("replacement-committed");
			expect(committed, "SETUP_DURABLE_REPLACEMENT_COMMITTED").toBeGreaterThan(0);
			const chunk = ordering.indexOf("post-capture-chunk-result");
			if (chunk !== -1) expect(chunk, "REPLACEMENT_PRECEDES_SUBSEQUENT_REQUESTED_CONTENT").toBeGreaterThan(committed);
			expect(refused).toBe(true);
		} finally {
			database.close();
		}
	});
	it("source scope native key and exposed row disagreement refuses independently of chunk damage", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const before = await image(p.source);
		const witnesses: { nativeKey: unknown; exposedObjectId: unknown }[] = [];
		sourceResults(p.source, (event) => {
			if (event.store === "scopes" && event.row.objectId === selected.declaration.scope.objectId) {
				const key = event.method.endsWith("openCursor") ? event.key : before.scopes.keys[0];
				event.row.objectId = "exposed-row-disagrees";
				witnesses.push({ nativeKey: key, exposedObjectId: event.row.objectId });
			}
		});
		expect(await rejected(readFixtureSnapshotDeclaration(local(p.source, selected)))).toBe(true);
		expect(witnesses.length, "SETUP_SCOPE_KEY_ROW_MISMATCH_EXPOSED").toBeGreaterThan(0);
		for (const witness of witnesses) {
			expect((witness.nativeKey as unknown[])[0]).toBe(selected.declaration.scope.objectId);
			expect(witness.exposedObjectId).toBe("exposed-row-disagrees");
		}
	});
	it("native key and exposed requested chunk identity disagreement refuses", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		let mismatches = 0;
		for (const method of ["get", "getAll", "openCursor"] as const) {
			const original = IDBObjectStore.prototype[method];
			vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (
				this: IDBObjectStore,
				...args: unknown[]
			) {
				const result = Reflect.apply(original, this, args) as IDBRequest;
				if (this.transaction.db.name === p.source + suffix && this.name === "chunks")
					result.addEventListener("success", () => {
						const value: unknown = result.result;
						if (value === undefined || value === null) return;
						if (Array.isArray(value)) {
							const rows = value as Row[];
							if (rows.length) {
								Object.defineProperty(result, "result", {
									configurable: true,
									value: rows.map((row, index) => (index === 0 ? { ...row, index: 99 } : row)),
								});
								mismatches++;
							}
						} else if (method === "openCursor") {
							const cursor = value as IDBCursorWithValue;
							const row = cursor.value as Row;
							Object.defineProperty(cursor, "value", { configurable: true, value: { ...row, index: 99 } });
							mismatches++;
						} else {
							Object.defineProperty(result, "result", { configurable: true, value: { ...(value as Row), index: 99 } });
							mismatches++;
						}
					});
				return result;
			});
		}
		const refused = await rejected(deliverFixtureSnapshot(input(p, selected)));
		expect(mismatches, "SETUP_REQUEST_RESULT_IDENTITY_DISAGREEMENT_EXPOSED").toBeGreaterThan(0);
		expect(refused).toBe(true);
	});
	it("local invalid primary-name grammar cannot discover a declaration", async () => {
		const selected = fixture(),
			primary = "fixture-invalid-name-" + ++sequence;
		names.push(primary + suffix);
		await seed(primary, selected);
		expect(await rejected(readFixtureSnapshotDeclaration(local(primary, selected)))).toBe(true);
	});
	it("local already-suffixed primary name refuses without creating a double-suffixed database", async () => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		names.push(p.source + suffix + suffix);
		const before = await image(p.source),
			databases = await indexedDB.databases();
		expect(databases.some((database) => database.name === p.source + suffix + suffix)).toBe(false);
		const refused = await rejected(readFixtureSnapshotDeclaration(local(p.source + suffix, selected)));
		expect({ refused, databases: await indexedDB.databases(), image: await image(p.source) }).toEqual({
			refused: true,
			databases,
			image: before,
		});
	});
	it.each(["creator", "recipient", "fresh"])(
		"local valid %s identity discovers its own exact declaration",
		async (kind) => {
			const p = pair(),
				selected = fixture();
			const primary = kind === "creator" ? p.source : kind === "recipient" ? p.target : p.target + "-fresh";
			if (kind === "fresh") names.push(primary + suffix);
			await seed(primary, selected);
			expect(await readFixtureSnapshotDeclaration(local(primary, selected))).toEqual(selected.declaration);
		}
	);
	it.each(["local", "transfer"])("supported v1 source %s refuses without source migration", async (mode) => {
		const p = pair(),
			selected = fixture();
		await seed(p.target, selected);
		const current = await image(p.target);
		const opening = indexedDB.open(p.source + suffix, 1);
		opening.onupgradeneeded = () => {
			const database = opening.result;
			database.createObjectStore("chunks", { keyPath: ["objectId", "epoch", "anchor", "manifestDigest", "index"] });
			database
				.createObjectStore("scopes", { keyPath: ["objectId", "epoch", "anchor", "manifestDigest"] })
				.createIndex("expiryAsc", "expiresAt");
		};
		const database = await request(opening);
		try {
			const tx = database.transaction(["scopes", "chunks"], "readwrite", { durability: "strict" }),
				complete = done(tx);
			for (const row of current.scopes.rows) {
				const legacy = { ...row };
				delete legacy.retention;
				delete legacy.incarnation;
				delete legacy.descriptors;
				tx.objectStore("scopes").put(legacy);
			}
			for (const row of current.chunks.rows) tx.objectStore("chunks").put(row);
			await complete;
		} finally {
			database.close();
		}
		const before = await image(p.source),
			databases = await indexedDB.databases();
		const refused = await rejected(
			mode === "local"
				? readFixtureSnapshotDeclaration(local(p.source, selected))
				: deliverFixtureSnapshot(input(p, selected))
		);
		expect({ refused, image: await image(p.source), databases: await indexedDB.databases() }).toEqual({
			refused: true,
			image: before,
			databases,
		});
	});
	it.each(["local", "transfer"] as const)("stored-row anchor disagrees with unchanged manifest (%s)", async (mode) => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const genuine = await image(p.source),
			anchor = "ff".repeat(32);
		expect(selected.declaration.scope.anchor, "SETUP_DISTINCT_MANIFEST_ANCHOR").not.toBe(anchor);
		await mutate(p.source, "scopes", (store) => {
			store.delete(genuine.scopes.keys[0]);
			store.put({ ...genuine.scopes.rows[0], anchor });
		});
		await mutate(p.source, "chunks", (store) => {
			for (const [index, row] of genuine.chunks.rows.entries()) {
				store.delete(genuine.chunks.keys[index]);
				store.put({ ...row, anchor });
			}
		});
		const before = await image(p.source);
		expect(before.scopes.rows, "SETUP_ONE_ROW_WITH_ONLY_ALTERED_ANCHOR").toEqual([
			{ ...genuine.scopes.rows[0], anchor },
		]);
		expect(before.scopes.keys).toEqual([
			[
				selected.declaration.scope.objectId,
				selected.declaration.scope.epoch,
				anchor,
				selected.declaration.scope.manifestDigest,
			],
		]);
		expect(before.chunks.rows, "SETUP_CHUNKS_COHERENT_WITH_STORED_ROW").toEqual(
			genuine.chunks.rows.map((row) => ({ ...row, anchor }))
		);
		expect(before.chunks.keys).toEqual(
			selected.declaration.chunks.map((descriptor) => [
				selected.declaration.scope.objectId,
				selected.declaration.scope.epoch,
				anchor,
				selected.declaration.scope.manifestDigest,
				descriptor.index,
			])
		);
		const refused = await rejected(
			mode === "local"
				? readFixtureSnapshotDeclaration(local(p.source, selected))
				: deliverFixtureSnapshot(input(p, selected))
		);
		expect({ refused, image: await image(p.source) }).toEqual({ refused: true, image: before });
	});
	it.each(
		(
			["descriptor-digest", "descriptor-length", "total-bytes", "chunk-count", "descriptors-and-summary"] as const
		).flatMap((kind) => (["local", "transfer"] as const).map((mode) => [kind, mode] as const))
	)("well-formed source metadata %s refuses (%s)", async (kind, mode) => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const current = await image(p.source),
			row = structuredClone(current.scopes.rows[0]);
		const descriptors = row.descriptors as { byteLength: number; digest: string; index: number }[];
		if (kind === "descriptor-digest") descriptors[1].digest = "ff".repeat(32);
		if (kind === "descriptor-length" || kind === "descriptors-and-summary") descriptors[1].byteLength -= 1;
		if (kind === "total-bytes" || kind === "descriptors-and-summary") row.totalBytes = Number(row.totalBytes) - 1;
		if (kind === "chunk-count") row.chunkCount = Number(row.chunkCount) + 1;
		await mutate(p.source, "scopes", (store) => {
			store.put(row);
		});
		const before = await image(p.source);
		expect(before.scopes.rows[0], "SETUP_ALTERED_METADATA_PERSISTED").toEqual(row);
		expect(row.exactCanonicalManifestBytes, "SETUP_MANIFEST_BYTES_UNCHANGED").toEqual(
			selected.declaration.exactCanonicalManifestBytes
		);
		expect(
			descriptors.every(
				(descriptor) =>
					Number.isSafeInteger(descriptor.byteLength) &&
					descriptor.byteLength > 0 &&
					/^[a-f0-9]{64}$/u.test(descriptor.digest)
			),
			"SETUP_DESCRIPTOR_FIELDS_REMAIN_WELL_FORMED"
		).toBe(true);
		const refused = await rejected(
			mode === "local"
				? readFixtureSnapshotDeclaration(local(p.source, selected))
				: deliverFixtureSnapshot(input(p, selected))
		);
		expect({ refused, image: await image(p.source) }).toEqual({ refused: true, image: before });
	});
	it.each(
		(["extra-store", "scope-key-path", "owner-key-path", "expiry-index", "chunk-index"] as const).flatMap((kind) =>
			(["local", "transfer"] as const).map((mode) => [kind, mode] as const)
		)
	)("unsupported v2 source schema %s refuses unchanged (%s)", async (kind, mode) => {
		const p = pair(),
			selected = fixture();
		await seed(p.target, selected);
		const genuine = await image(p.target),
			expected = await schema(p.target);
		if (kind === "extra-store")
			expected.stores.push({ name: "unexpected", keyPath: "id", autoIncrement: false, indexes: [] });
		const scopeSchema = expected.stores.find((store) => store.name === "scopes");
		const ownerSchema = expected.stores.find((store) => store.name === "owner");
		const chunkSchema = expected.stores.find((store) => store.name === "chunks");
		if (scopeSchema === undefined || ownerSchema === undefined || chunkSchema === undefined)
			throw new Error("SETUP_NATIVE_SCHEMA_STORES_MISSING");
		if (kind === "scope-key-path") scopeSchema.keyPath = "objectId";
		if (kind === "owner-key-path") ownerSchema.keyPath = "migration";
		if (kind === "expiry-index") scopeSchema.indexes[0].keyPath = "epoch";
		if (kind === "chunk-index")
			chunkSchema.indexes.push({ name: "unexpected", keyPath: "index", unique: false, multiEntry: false });
		const opening = indexedDB.open(p.source + suffix, 2);
		opening.onupgradeneeded = () => {
			for (const spec of expected.stores) {
				const store = opening.result.createObjectStore(spec.name, {
					keyPath: spec.keyPath,
					autoIncrement: spec.autoIncrement,
				});
				for (const index of spec.indexes)
					store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
			}
		};
		const database = await request(opening);
		try {
			const tx = database.transaction(["scopes", "chunks", "owner"], "readwrite", { durability: "strict" }),
				complete = done(tx);
			for (const name of ["scopes", "chunks", "owner"])
				for (const row of genuine[name].rows) tx.objectStore(name).put(row);
			await complete;
		} finally {
			database.close();
		}
		const before = { image: await image(p.source), schema: await schema(p.source) };
		expect(before.schema, "SETUP_EXACT_RAW_V2_SCHEMA_FAULT").toEqual(expected);
		const refused = await rejected(
			mode === "local"
				? readFixtureSnapshotDeclaration(local(p.source, selected))
				: deliverFixtureSnapshot(input(p, selected))
		);
		expect({ refused, image: await image(p.source), schema: await schema(p.source) }).toEqual({
			refused: true,
			...before,
		});
	});
});

describe("fixture snapshot exact object/epoch prefix — malformed key boundaries", () => {
	it.each(
		(["empty", "nonempty"] as const).flatMap((kind) =>
			(["local", "transfer"] as const).map((mode) => [kind, mode] as const)
		)
	)("same-prefix %s array anchor refuses (%s)", async (kind, mode) => {
		const p = pair(),
			selected = fixture();
		await seed(p.source, selected);
		const genuine = await image(p.source),
			anchor = kind === "empty" ? [] : ["malformed-array-anchor"];
		expect(genuine.scopes.rows, "SETUP_ONE_NATIVE_VERIFIED_SCOPE").toHaveLength(1);
		await mutate(p.source, "scopes", (store) => {
			store.put({ ...genuine.scopes.rows[0], anchor });
		});
		const before = await image(p.source);
		expect(before.scopes.rows, "SETUP_ONLY_ADDED_ARRAY_ANCHOR_ROW").toEqual([
			genuine.scopes.rows[0],
			{ ...genuine.scopes.rows[0], anchor },
		]);
		expect(
			before.scopes.keys.filter(
				(key) =>
					Array.isArray(key) &&
					key[0] === selected.declaration.scope.objectId &&
					key[1] === selected.declaration.scope.epoch
			),
			"SETUP_TWO_EXACT_OBJECT_EPOCH_KEYS"
		).toEqual([
			genuine.scopes.keys[0],
			[
				selected.declaration.scope.objectId,
				selected.declaration.scope.epoch,
				anchor,
				selected.declaration.scope.manifestDigest,
			],
		]);
		expect(before.chunks).toEqual(genuine.chunks);
		expect(before.owner).toEqual(genuine.owner);
		expect((await indexedDB.databases()).some((database) => database.name === p.target + suffix)).toBe(false);
		const refused = await rejected(
			mode === "local"
				? readFixtureSnapshotDeclaration(local(p.source, selected))
				: deliverFixtureSnapshot(input(p, selected))
		);
		expect({
			refused,
			source: await image(p.source),
			targetExists: (await indexedDB.databases()).some((database) => database.name === p.target + suffix),
		}).toEqual({ refused: true, source: before, targetExists: false });
	});
	it.each([
		{ name: "fractional neighbors", epoch: 4, requestedEpoch: 4, neighbors: [3.5, 4.000000000000001, 4.5] },
		{ name: "zero", epoch: 0, requestedEpoch: 0, neighbors: [-Number.MIN_VALUE, Number.MIN_VALUE] },
		{ name: "negative-zero caller", epoch: 0, requestedEpoch: -0, neighbors: [-Number.MIN_VALUE, Number.MIN_VALUE] },
		{
			name: "maximum safe epoch",
			epoch: Number.MAX_SAFE_INTEGER,
			requestedEpoch: Number.MAX_SAFE_INTEGER,
			neighbors: [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1],
		},
	])(
		"exact prefix preserves $name without visiting neighboring epochs",
		async ({ epoch, requestedEpoch, neighbors }) => {
			const p = pair(),
				selected = fixture("delivery-object", epoch);
			await seed(p.source, selected);
			const genuine = await image(p.source);
			await mutate(p.source, "scopes", (store) => {
				for (const neighboringEpoch of neighbors) store.put({ ...genuine.scopes.rows[0], epoch: neighboringEpoch });
			});
			const before = await image(p.source);
			expect(
				before.scopes.rows.map((row) => row.epoch),
				"SETUP_EXACT_DISTINCT_EPOCH_KEYS"
			).toEqual([epoch, ...neighbors].sort((left, right) => left - right));
			const observedRows: SourceResult[] = [];
			sourceResults(p.source, (event) => {
				if (event.store === "scopes") observedRows.push(event);
			});
			const declaration = await readFixtureSnapshotDeclaration({
				...local(p.source, selected),
				closedEpoch: requestedEpoch,
			});
			vi.restoreAllMocks();
			expect(declaration).toEqual(selected.declaration);
			expect(observedRows.length, "ACTUAL_SELECTED_HEADER_OBSERVED").toBeGreaterThan(0);
			for (const event of observedRows) {
				expect(event.row.objectId).toBe(selected.declaration.scope.objectId);
				expect(event.row.epoch, "NO_NEIGHBORING_EPOCH_ROW_VISITED").toBe(epoch);
				expect(event.key).toEqual(genuine.scopes.keys[0]);
			}
			expect(await image(p.source)).toEqual(before);
		}
	);
});
