import { IDBDatabase as FakeDatabase, IDBFactory } from "fake-indexeddb";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type * as v8 from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createGridMemoryProfiler,
	type GridMemoryCheckpoint,
	shouldCaptureGridHeap,
} from "./fixtures/grid-memory-profiler.js";
import { censusGridStorage } from "./fixtures/grid-memory-storage-census.js";
import { encodeCanonical } from "../packages/canonical/src/index.js";
import { encodeGenerationRecordV1, encodeHeadRecordV1 } from "../packages/storage/src/codecs.js";
import type { ParseResult } from "../packages/storage/src/types.js";
import {
	digestBlob,
	digestClosure,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
} from "../packages/storage/src/values.js";

// These input/lifecycle controls do not generate real heap evidence.
vi.mock("node:v8", async (importOriginal) => ({
	...(await importOriginal<typeof v8>()),
	getHeapSnapshot: (): Readable => Readable.from(["synthetic-contract-snapshot"]),
}));

type CensusRow = {
	database: string;
	store: string;
	epoch: string;
	retentionStatus: string;
	rows: number;
	logicalPayloadBytes: number;
};

interface StoreFixture {
	name: string;
	keyPath: string | string[];
	indexes?: { name: string; keyPath: string; unique: boolean }[];
	values: readonly unknown[];
}

const temporaryRoots: string[] = [];

function parsed<T>(result: ParseResult<T>): T {
	if (!result.ok) throw new Error(`invalid storage fixture: ${result.reason}`);
	return result.value;
}

function request<T>(selected: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		selected.onsuccess = (): void => resolve(selected.result);
		selected.onerror = (): void => reject(selected.error);
	});
}

function completed(transaction: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		transaction.oncomplete = (): void => resolve();
		transaction.onabort = (): void => reject(transaction.error ?? new Error("fixture transaction aborted"));
		transaction.onerror = (): void => reject(transaction.error ?? new Error("fixture transaction failed"));
	});
}

async function seedDatabase(factory: IDBFactory, name: string, stores: readonly StoreFixture[]): Promise<void> {
	const opening = factory.open(name, 1);
	opening.onupgradeneeded = (): void => {
		for (const fixture of stores) {
			const store = opening.result.createObjectStore(fixture.name, { keyPath: fixture.keyPath, autoIncrement: false });
			for (const index of fixture.indexes ?? []) {
				store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: false });
			}
		}
	};
	const database = await request(opening);
	try {
		const writing = database.transaction(
			stores.map(({ name: store }) => store),
			"readwrite"
		);
		const done = completed(writing);
		for (const fixture of stores) {
			for (const value of fixture.values) writing.objectStore(fixture.name).put(value);
		}
		await done;
	} finally {
		database.close();
	}
}

function sumRows(rows: readonly CensusRow[], store: string): number {
	return rows.filter((row) => row.store === store).reduce((total, row) => total + row.rows, 0);
}

function sumBytes(rows: readonly CensusRow[], store: string): number {
	return rows.filter((row) => row.store === store).reduce((total, row) => total + row.logicalPayloadBytes, 0);
}

function profilerPath(): string {
	const root = mkdtempSync(join(tmpdir(), "grid-attribution-contract-"));
	temporaryRoots.push(root);
	return join(root, "capture");
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("grid attribution physical storage census", () => {
	it("counts each physical row and recursive string/view bytes, not numeric declarations or view backing capacity", async () => {
		const factory = new IDBFactory();
		const database = "grid-census-payloads";
		// Deliberately generic rows exercise unknown-store census, not protocol admission.
		await seedDatabase(factory, database, [
			{
				name: "payloads",
				keyPath: "id",
				values: [
					{
						id: "one",
						epoch: 7,
						note: "é🙂",
						buffer: new ArrayBuffer(4),
						partial: new Uint8Array(new ArrayBuffer(16), 3, 2),
						view: new DataView(new ArrayBuffer(12), 4, 3),
						nested: {
							word: "z",
							numbers: [1, 2, 3],
							yes: true,
							totalBytes: 900_000,
							bytes: new Uint16Array([257, 513]),
						},
					},
					{ id: "two", epoch: 7, payload: new Uint8Array([1, 2]), totalBytes: 1_000_000 },
				],
			},
		]);
		const transactions = vi.spyOn(FakeDatabase.prototype, "transaction");
		const rows = await censusGridStorage({ factory, databaseNames: [database], currentEpoch: 7, now: 1000 });
		expect(rows).toEqual([
			{ database, store: "payloads", epoch: "7", retentionStatus: "current-epoch", rows: 2, logicalPayloadBytes: 28 },
		]);
		expect(transactions.mock.calls.length).toBeGreaterThan(0);
		expect(
			transactions.mock.calls.every(([, mode]) => mode === undefined || mode === "readonly"),
			"CENSUS_NEVER_MUTATES_STORAGE"
		).toBe(true);
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual([
				"database",
				"epoch",
				"logicalPayloadBytes",
				"retentionStatus",
				"rows",
				"store",
			]);
			expect(Object.values(row).every((value) => typeof value === "string" || typeof value === "number")).toBe(true);
		}
	});

	it("keeps absent and malformed epochs explicitly unknown instead of assigning the current epoch", async () => {
		const factory = new IDBFactory();
		const database = "grid-census-unknown";
		await seedDatabase(factory, database, [
			{
				name: "metadata",
				keyPath: "id",
				values: [
					{ id: "missing", payload: "x" },
					{ id: "malformed", epoch: "five", payload: "y" },
				],
			},
		]);
		const rows = await censusGridStorage({ factory, databaseNames: [database], currentEpoch: 5, now: 1000 });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			database,
			store: "metadata",
			epoch: "unknown",
			retentionStatus: "unknown",
			rows: 2,
		});
	});

	it("associates quarantine chunks with expiry/state by the entire object/epoch/anchor/manifest scope", async () => {
		const factory = new IDBFactory();
		const database = "grid-census--drp-snapshot-quarantine-v1";
		const objectA = `creator:${"a".repeat(32)}`;
		const objectB = `creator:${"b".repeat(32)}`;
		const anchorA = "a".repeat(64);
		const anchorB = "b".repeat(64);
		const manifestA = "c".repeat(64);
		const manifestB = "d".repeat(64);
		const scopes = [
			{ objectId: objectA, epoch: 2, anchor: anchorA, manifestDigest: manifestA, state: "verified", expiresAt: 2000 },
			{ objectId: objectA, epoch: 2, anchor: anchorB, manifestDigest: manifestA, state: "open", expiresAt: 999 },
			{ objectId: objectB, epoch: 2, anchor: anchorA, manifestDigest: manifestA, state: "poisoned", expiresAt: 1000 },
			{ objectId: objectA, epoch: 2, anchor: anchorA, manifestDigest: manifestB, state: "open", expiresAt: 999 },
		].map((scope) => ({
			...scope,
			chunkCount: 1,
			exactCanonicalManifestBytes: new Uint8Array([1, 2]),
			totalBytes: 9_000_000,
		}));
		const chunks = scopes.map(({ objectId, epoch, anchor, manifestDigest }, index) => ({
			objectId,
			epoch,
			anchor,
			manifestDigest,
			index: 0,
			digest: "e".repeat(64),
			byteLength: index + 1,
			exactBytes: new Uint8Array(index + 1),
		}));
		const firstChunk = chunks[0];
		if (firstChunk === undefined) throw new Error("MISSING_QUARANTINE_CONTROL_CHUNK");
		chunks.push({ ...firstChunk, manifestDigest: "f".repeat(64), byteLength: 5, exactBytes: new Uint8Array(5) });
		await seedDatabase(factory, database, [
			{
				name: "scopes",
				keyPath: ["objectId", "epoch", "anchor", "manifestDigest"],
				indexes: [{ name: "expiryAsc", keyPath: "expiresAt", unique: false }],
				values: scopes,
			},
			{ name: "chunks", keyPath: ["objectId", "epoch", "anchor", "manifestDigest", "index"], values: chunks },
		]);
		const rows = await censusGridStorage({ factory, databaseNames: [database], currentEpoch: 3, now: 1000 });
		const chunkRows = rows.filter((row) => row.store === "chunks");
		const stringsPerChunk = objectA.length + anchorA.length + manifestA.length + "e".repeat(64).length;
		expect(chunkRows).toEqual(
			expect.arrayContaining([
				{
					database,
					store: "chunks",
					epoch: "2",
					retentionStatus: "verified-unexpired",
					rows: 1,
					logicalPayloadBytes: stringsPerChunk + 1,
				},
				{
					database,
					store: "chunks",
					epoch: "2",
					retentionStatus: "open-expired",
					rows: 2,
					logicalPayloadBytes: 2 * stringsPerChunk + 2 + 4,
				},
				{
					database,
					store: "chunks",
					epoch: "2",
					retentionStatus: "poisoned-expired",
					rows: 1,
					logicalPayloadBytes: stringsPerChunk + 3,
				},
				{
					database,
					store: "chunks",
					epoch: "2",
					retentionStatus: "unknown",
					rows: 1,
					logicalPayloadBytes: stringsPerChunk + 5,
				},
			])
		);
		expect(chunkRows).toHaveLength(4);
		expect(sumRows(rows, "chunks")).toBe(5);
		expect(sumRows(rows, "scopes"), "OBSERVATION_DOES_NOT_SWEEP_EXPIRED_SCOPES").toBe(4);
	});

	it("counts an AHE blob once when several physical generations reference it", async () => {
		const factory = new IDBFactory();
		const database = "grid-census--ahe";
		const objectId = parsed(parseStorageObjectId(`creator:${"a".repeat(32)}`));
		const bytes = new Uint8Array(7);
		const digest = parsed(digestBlob(bytes));
		const closure = [{ digest, byteLength: bytes.byteLength }];
		const closureDigest = parsed(digestClosure(closure));
		const generations = (["Adopted", "Superseded"] as const).map((state, index) => {
			const generationId = parsed(parseGenerationId(String(index + 1).repeat(64)));
			return {
				objectId,
				generationId,
				record: encodeGenerationRecordV1({
					objectId,
					generationId,
					baseExpectedHead: { kind: "none", objectId },
					closureDigest,
					closure,
					state,
				}),
			};
		});
		await seedDatabase(factory, database, [
			{ name: "objects", keyPath: "objectId", values: [] },
			{ name: "generations", keyPath: ["objectId", "generationId"], values: generations },
			{ name: "blobs", keyPath: "digest", values: [{ digest, bytes }] },
			{ name: "promotions", keyPath: ["objectId", "generationId", "digest"], values: [] },
		]);
		const rows = await censusGridStorage({ factory, databaseNames: [database], currentEpoch: 20, now: 1000 });
		expect(sumRows(rows, "generations")).toBe(2);
		expect(sumRows(rows, "blobs"), "SHARED_REFERENCES_DO_NOT_DUPLICATE_PHYSICAL_BLOB").toBe(1);
		expect(sumBytes(rows, "blobs")).toBe(64 + 7);
		expect(rows.find((row) => row.store === "blobs")).toMatchObject({ epoch: "unknown", retentionStatus: "shared" });
	});

	it.each([
		{ label: "known plus unknown remains unknown", second: { payload: "opaque" }, expected: "unknown" },
		{ label: "distinct known epochs are shared", second: { epoch: 8 }, expected: "shared" },
	])("combines encoded AHE carrier epochs: $label", async ({ second, expected }) => {
		const factory = new IDBFactory();
		const database = `grid-census-ahe-combined-${expected}`;
		const objectId = parsed(parseStorageObjectId(`creator:${"c".repeat(32)}`));
		const generationId = parsed(parseGenerationId("3".repeat(64)));
		const blobs = [encodeCanonical({ epoch: 7 }), encodeCanonical(second)].map((bytes) => ({
			digest: parsed(digestBlob(bytes)),
			bytes,
		}));
		const closure = blobs.map(({ digest, bytes }) => ({ digest, byteLength: bytes.byteLength }));
		const closureDigest = parsed(digestClosure(closure));
		const generation = encodeGenerationRecordV1({
			objectId,
			generationId,
			baseExpectedHead: { kind: "none", objectId },
			closureDigest,
			closure,
			state: "Adopted",
		});
		const head = encodeHeadRecordV1({
			kind: "present",
			objectId,
			generationId,
			revision: parsed(parseHeadRevision(1)),
			closureDigest,
		});
		await seedDatabase(factory, database, [
			{ name: "objects", keyPath: "objectId", values: [{ objectId, record: head }] },
			{
				name: "generations",
				keyPath: ["objectId", "generationId"],
				values: [{ objectId, generationId, record: generation }],
			},
			{ name: "blobs", keyPath: "digest", values: blobs },
			{
				name: "promotions",
				keyPath: ["objectId", "generationId", "digest"],
				values: blobs.map(({ digest }) => ({ objectId, generationId, digest })),
			},
		]);
		const rows = await censusGridStorage({ factory, databaseNames: [database], currentEpoch: 7, now: 1000 });
		for (const [store, count] of [
			["objects", 1],
			["generations", 1],
			["promotions", 2],
		] as const) {
			expect(rows.filter((row) => row.store === store)).toEqual([
				expect.objectContaining({ database, store, epoch: expected, retentionStatus: "active", rows: count }),
			]);
		}
		expect(sumRows(rows, "blobs")).toBe(2);
		expect(sumBytes(rows, "blobs")).toBe(128 + blobs.reduce((total, blob) => total + blob.bytes.byteLength, 0));
		expect(
			rows
				.filter((row) => row.store === "blobs")
				.map((row) => row.epoch)
				.sort()
		).toEqual(["7", expected === "shared" ? "8" : "unknown"].sort());
	});

	it("rejects a missing database without creating it", async () => {
		const factory = new IDBFactory();
		const before = await factory.databases();
		const opening = vi.spyOn(factory, "open");
		await expect(
			censusGridStorage({ factory, databaseNames: ["missing"], currentEpoch: 0, now: 1000 })
		).rejects.toThrow();
		expect(await factory.databases()).toEqual(before);
		expect(opening).not.toHaveBeenCalled();
	});

	it.each(["throw", "abort"] as const)(
		"rejects a readonly transaction %s and closes the census connection",
		async (failure) => {
			const factory = new IDBFactory();
			const database = `grid-census-${failure}`;
			await seedDatabase(factory, database, [{ name: "payloads", keyPath: "id", values: [{ id: "one", epoch: 1 }] }]);
			const original = FakeDatabase.prototype.transaction;
			const closed = vi.spyOn(FakeDatabase.prototype, "close");
			vi.spyOn(FakeDatabase.prototype, "transaction").mockImplementation(function (
				this: IDBDatabase,
				...args: Parameters<IDBDatabase["transaction"]>
			): IDBTransaction {
				if (failure === "throw") throw new Error("CENSUS_READ_TRANSACTION_FAILED");
				const transaction = Reflect.apply(original, this, args) as IDBTransaction;
				queueMicrotask(() => transaction.abort());
				return transaction;
			});
			await expect(
				censusGridStorage({ factory, databaseNames: [database], currentEpoch: 1, now: 1000 })
			).rejects.toThrow();
			expect(
				closed.mock.contexts.some((connection) => connection instanceof FakeDatabase && connection.name === database),
				"FAILED_CENSUS_CONNECTION_CLOSED"
			).toBe(true);
		}
	);
});

describe("grid attribution checkpoint and profiler input contract", () => {
	function validCheckpoint(transitions = 1, terminalAccounting = false): GridMemoryCheckpoint {
		return {
			epoch: transitions - (terminalAccounting ? 0 : 1),
			transitions,
			terminalAccounting,
			objectId: `creator:${"a".repeat(32)}`,
			databaseNames: [],
			owners: { live: 1 },
		};
	}

	it("rejects finish before the full checkpoint and terminal accounting sequence", async () => {
		vi.stubGlobal("gc", () => undefined);
		vi.stubGlobal("indexedDB", new IDBFactory());
		const profiler = createGridMemoryProfiler({ directory: profilerPath() });
		try {
			expect(() => profiler.finish()).toThrow(/incomplete/iu);
			await profiler.checkpoint(validCheckpoint());
			expect(() => profiler.finish()).toThrow(/incomplete/iu);
		} finally {
			profiler.close();
		}
	});

	it("rejects early and repeated terminal accounting with synthetic snapshot streams", async () => {
		vi.stubGlobal("gc", () => undefined);
		vi.stubGlobal("indexedDB", new IDBFactory());
		const profiler = createGridMemoryProfiler({ directory: profilerPath() });
		try {
			await expect(profiler.checkpoint(validCheckpoint(1, true))).rejects.toThrow();
			await expect(profiler.checkpoint(validCheckpoint(30, true))).rejects.toThrow();
			for (let transitions = 1; transitions <= 30; transitions += 1) {
				await profiler.checkpoint(validCheckpoint(transitions));
			}
			expect(() => profiler.finish()).toThrow(/incomplete/iu);
			await profiler.checkpoint(validCheckpoint(30, true));
			await expect(profiler.checkpoint(validCheckpoint(30, true))).rejects.toThrow();
			expect(() => profiler.finish()).not.toThrow();
			expect(() => profiler.finish()).toThrow();
		} finally {
			profiler.close();
		}
	});

	it.each(["extra-field", "owner-symbol", "owner-accessor"] as const)(
		"rejects hidden live references in checkpoint input: %s",
		async (kind) => {
			vi.stubGlobal("gc", () => undefined);
			vi.stubGlobal("indexedDB", new IDBFactory());
			const checkpoint = validCheckpoint();
			const accessor = vi.fn(() => 1);
			if (kind === "extra-field") Object.assign(checkpoint, { retainedWorkload: { graph: new Map() } });
			if (kind === "owner-symbol")
				Object.defineProperty(checkpoint.owners, Symbol("workload"), { value: { graph: new Map() } });
			if (kind === "owner-accessor")
				Object.defineProperty(checkpoint.owners, "hidden", { enumerable: true, get: accessor });
			const profiler = createGridMemoryProfiler({ directory: profilerPath() });
			try {
				await expect(profiler.checkpoint(checkpoint)).rejects.toThrow();
				expect(accessor, "VALIDATION_MUST_NOT_INVOKE_OWNER_ACCESSORS").not.toHaveBeenCalled();
			} finally {
				profiler.close();
			}
		}
	);

	it("selects only transition 10/20/30 once, excluding terminal accounting", () => {
		const captured = new Set<number>();
		const selected: number[] = [];
		for (let transitions = 0; transitions <= 31; transitions += 1) {
			if (shouldCaptureGridHeap({ transitions, terminalAccounting: false }, captured)) {
				selected.push(transitions);
				captured.add(transitions);
			}
			expect(shouldCaptureGridHeap({ transitions, terminalAccounting: false }, captured)).toBe(false);
		}
		expect(selected).toEqual([10, 20, 30]);
		for (const transitions of [10, 20, 30]) {
			expect(shouldCaptureGridHeap({ transitions, terminalAccounting: true }, new Set())).toBe(false);
		}
	});

	it("fails construction without exposed GC before creating evidence", () => {
		vi.stubGlobal("gc", undefined);
		const directory = profilerPath();
		expect(() => createGridMemoryProfiler({ directory })).toThrow(/gc/iu);
		expect(existsSync(directory)).toBe(false);
	});

	it("requires a fresh exclusive output directory and preserves existing evidence", () => {
		// Input-contract tests never select a heap checkpoint; this sentinel does not
		// substitute for actual exposed GC in the separate profiling workload.
		vi.stubGlobal("gc", () => undefined);
		const directory = profilerPath();
		const profiler = createGridMemoryProfiler({ directory });
		profiler.close();
		const before = readdirSync(directory).sort();
		expect(() => createGridMemoryProfiler({ directory })).toThrow();
		expect(readdirSync(directory).sort()).toEqual(before);
	});

	it.each([{ payload: {} }, [1], "one", Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects nonscalar/nonfinite owner values without heap capture: %j",
		async (value) => {
			vi.stubGlobal("gc", () => undefined);
			const profiler = createGridMemoryProfiler({ directory: profilerPath() });
			try {
				await expect(
					profiler.checkpoint({
						epoch: 0,
						transitions: 1,
						terminalAccounting: false,
						objectId: `creator:${"a".repeat(32)}`,
						databaseNames: [],
						owners: { live: value } as unknown as Readonly<Record<string, number>>,
					})
				).rejects.toThrow(/owner|scalar|finite/iu);
			} finally {
				profiler.close();
			}
		}
	);
});
