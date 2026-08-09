import {
	type AheDurableStore,
	type BlobDigest,
	digestBlob,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	parseGenerationId,
	type ParseResult,
	parseStorageObjectId,
	type StorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import { runStoreContract } from "@ts-drp/storage/contract";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import * as storageNode from "../src/index.js";
import { createInstrumentedSqliteAheDurableStore } from "../src/test-instrumentation.js";

const { createSqliteAheDurableStore } = storageNode;
const temporaryDirectories: string[] = [];

function must<T>(result: ParseResult<T>): T {
	if (!result.ok) throw new Error(`non-canonical test fixture: ${result.reason}`);
	return result.value;
}

const OBJECT_A = must(parseStorageObjectId(`sqlite-a:${"a".repeat(32)}`));
const OBJECT_B = must(parseStorageObjectId(`sqlite-b:${"b".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("1".repeat(64)));
const GENERATION_B = must(parseGenerationId("2".repeat(64)));

async function databaseFilename(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-storage-node-red-"));
	temporaryDirectories.push(directory);
	return join(directory, "store.sqlite");
}

function noHead(objectId: StorageObjectId): Readonly<{ kind: "none"; objectId: StorageObjectId }> {
	return { kind: "none", objectId };
}

type QuiescentStoreView = Readonly<{
	head: ExpectedHead;
	generations: readonly GenerationRecord[];
}>;

async function callSplitRead(
	store: object,
	method: "readGenerationPage" | "readHead",
	input: unknown
): Promise<StoreResult<unknown>> {
	const callable = Reflect.get(store, method);
	if (typeof callable !== "function")
		return { ok: false, reason: "SUBSTRATE_FAILURE", cause: "SPLIT_READ_NOT_IMPLEMENTED" };
	return Reflect.apply(callable, store, [input]) as Promise<StoreResult<unknown>>;
}

// Test-only aggregation at quiescent assertion points; pages are not presented as
// one public snapshot and this helper has no compatibility fallback.
async function readStoreView(store: object, objectId: StorageObjectId): Promise<StoreResult<QuiescentStoreView>> {
	const head = await callSplitRead(store, "readHead", objectId);
	if (!head.ok) return head;
	const generations: GenerationRecord[] = [];
	let cursor: unknown;
	do {
		const page = await callSplitRead(store, "readGenerationPage", { cursor, limit: 128, objectId });
		if (!page.ok) return page;
		const value = page.value as { readonly generations: readonly GenerationRecord[]; readonly nextCursor: unknown };
		generations.push(...value.generations);
		cursor = value.nextCursor;
	} while (cursor !== null);
	return { ok: true, value: { head: head.value as ExpectedHead, generations } };
}

async function begin(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId,
	bytes: Uint8Array
): Promise<GenerationRecord> {
	const digest = must(digestBlob(bytes));
	const result = await store.beginGeneration({
		objectId,
		generationId,
		baseExpectedHead: noHead(objectId),
		closure: [{ digest, byteLength: bytes.byteLength }],
	});
	if (!result.ok) throw new Error(`begin fixture failed: ${result.reason}`);
	return result.value;
}

function rawPragma(database: DatabaseSync, pragma: "integrity_check" | "journal_mode"): unknown {
	const row = database.prepare(`PRAGMA ${pragma}`).get();
	return row === undefined ? undefined : Object.values(row)[0];
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("Phase 2c-a Node SQLite strict store RED", () => {
	it("reports the exact frozen strict capability pair", async () => {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			engines?: { node?: unknown };
			exports?: Record<string, unknown>;
			private?: unknown;
		};
		expect({
			engines: manifest.engines,
			exportSubpaths: Object.keys(manifest.exports ?? {}),
			private: manifest.private,
		}).toEqual({
			engines: { node: ">=22.13.0" },
			exportSubpaths: ["."],
			private: true,
		});
		expect(Object.keys(storageNode)).toEqual(["createSqliteAheDurableStore"]);
		const store = createSqliteAheDurableStore({ filename: await databaseFilename() });
		expect(store.capabilities).toEqual({
			durability: "strict",
			signingEligibility: "backend-capability-required",
		});
		expect(Object.isFrozen(store.capabilities)).toBe(true);
		await store.close();
	});

	it("passes the common shared contract and executes its frozen strict branch", async () => {
		const filename = await databaseFilename();
		await expect(runStoreContract(() => createSqliteAheDurableStore({ filename }))).resolves.toEqual({
			durability: "strict",
			signingEligibility: "backend-capability-required",
		});
	});

	it("persists distinct structural object-generation tuples and blob bytes across close and reopen", async () => {
		const filename = await databaseFilename();
		const first = createSqliteAheDurableStore({ filename });
		const tuples = [
			{ bytes: Uint8Array.of(1, 2, 3), generationId: GENERATION_A, objectId: OBJECT_A },
			{ bytes: Uint8Array.of(4, 5, 6), generationId: GENERATION_B, objectId: OBJECT_A },
			{ bytes: Uint8Array.of(7, 8, 9), generationId: GENERATION_A, objectId: OBJECT_B },
		] as const;
		const expectedGenerations: GenerationRecord[] = [];
		const expectedBlobs: Array<Readonly<{ bytes: Uint8Array; digest: BlobDigest }>> = [];
		for (const tuple of tuples) {
			const digest = must(digestBlob(tuple.bytes));
			expectedGenerations.push(await begin(first, tuple.objectId, tuple.generationId, tuple.bytes));
			expect(
				await first.putCachedBlob({
					objectId: tuple.objectId,
					generationId: tuple.generationId,
					digest,
					bytes: tuple.bytes,
				})
			).toEqual({ ok: true, value: { inserted: true } });
			expectedBlobs.push({ bytes: tuple.bytes, digest });
		}
		await first.close();

		const reopened = createSqliteAheDurableStore({ filename });
		expect.soft(await readStoreView(reopened, OBJECT_A)).toEqual({
			ok: true,
			value: {
				head: noHead(OBJECT_A),
				generations: [expectedGenerations[0], expectedGenerations[1]],
			},
		});
		expect.soft(await readStoreView(reopened, OBJECT_B)).toEqual({
			ok: true,
			value: { head: noHead(OBJECT_B), generations: [expectedGenerations[2]] },
		});
		for (const { bytes, digest } of expectedBlobs) {
			expect.soft(await reopened.getBlob(digest)).toEqual({ ok: true, value: bytes });
		}
		await reopened.close();
	});

	it("creates a structural composite-key schema with WAL, FULL synchronous, foreign keys, and integrity", async () => {
		const filename = await databaseFilename();
		const instrumented = createInstrumentedSqliteAheDurableStore({ filename });
		const store = instrumented.store;
		const payload = Uint8Array.of(13, 14, 15);
		const digest = must(digestBlob(payload));
		await begin(store, OBJECT_A, GENERATION_A, payload);
		expect(
			await store.putCachedBlob({ objectId: OBJECT_A, generationId: GENERATION_A, digest, bytes: payload })
		).toEqual({ ok: true, value: { inserted: true } });

		expect.soft(instrumented.inspectConfiguration()).toEqual({
			foreignKeys: 1,
			integrityCheck: "ok",
			journalMode: "wal",
			synchronous: 2,
		});
		expect(() => instrumented.attemptInvalidForeignKeyInsert()).toThrow(/FOREIGN KEY constraint failed/u);
		await store.close();

		const database = new DatabaseSync(filename);
		try {
			const generationColumns = database.prepare("PRAGMA table_info(generations)").all() as Array<{
				name: string;
				pk: number;
			}>;
			const primaryKey = generationColumns
				.filter(({ pk }) => pk > 0)
				.sort((left, right) => left.pk - right.pk)
				.map(({ name, pk }) => ({ name, pk }));
			const persistedRows =
				generationColumns.length === 0
					? undefined
					: (database.prepare("SELECT count(*) AS count FROM generations").get() as { count: number }).count;

			expect.soft(rawPragma(database, "journal_mode")).toBe("wal");
			expect.soft(primaryKey).toEqual([
				{ name: "object_id", pk: 1 },
				{ name: "generation_id", pk: 2 },
			]);
			expect.soft(persistedRows).toBe(1);
			expect.soft(rawPragma(database, "integrity_check")).toBe("ok");
		} finally {
			database.close();
		}
	});

	it("rolls back and publishes nothing when a mutation fails immediately before commit", async () => {
		const filename = await databaseFilename();
		const injected = new Error("injected before-commit failure");
		const checkpoints: string[] = [];
		const instrumented = createInstrumentedSqliteAheDurableStore({ filename }, (checkpoint) => {
			checkpoints.push(`${checkpoint.operation}:${checkpoint.edge}`);
			if (checkpoints.length === 1) throw injected;
		});
		const store = instrumented.store;
		const payload = Uint8Array.of(7, 8, 9);
		const digest = must(digestBlob(payload));
		const result = await store.beginGeneration({
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			baseExpectedHead: noHead(OBJECT_A),
			closure: [{ digest, byteLength: payload.byteLength }],
		});

		expect.soft(checkpoints).toEqual(["beginGeneration:before-commit"]);
		expect.soft(result).toEqual({ ok: false, reason: "SUBSTRATE_FAILURE", cause: injected });
		expect.soft(await readStoreView(store, OBJECT_A)).toEqual({
			ok: true,
			value: { head: noHead(OBJECT_A), generations: [] },
		});
		expect.soft(await store.getBlob(digest)).toEqual({ ok: true, value: null });

		const retry = await store.beginGeneration({
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			baseExpectedHead: noHead(OBJECT_A),
			closure: [{ digest, byteLength: payload.byteLength }],
		});
		expect.soft(checkpoints).toEqual(["beginGeneration:before-commit", "beginGeneration:before-commit"]);
		expect.soft(retry.ok).toBe(true);
		expect.soft(await readStoreView(store, OBJECT_A)).toEqual({
			ok: true,
			value: {
				head: noHead(OBJECT_A),
				generations: retry.ok ? [retry.value] : [],
			},
		});
		await store.close();
	});

	it("detaches retained input and every returned byte array", async () => {
		const store = createSqliteAheDurableStore({ filename: await databaseFilename() });
		const input = Uint8Array.of(10, 11, 12);
		const expected = new Uint8Array(input);
		const digest = must(digestBlob(input));
		await begin(store, OBJECT_A, GENERATION_A, input);
		expect(await store.putCachedBlob({ objectId: OBJECT_A, generationId: GENERATION_A, digest, bytes: input })).toEqual(
			{
				ok: true,
				value: { inserted: true },
			}
		);
		input.fill(0);
		const first = await store.getBlob(digest);
		expect(first).toEqual({ ok: true, value: expected });
		if (!first.ok || first.value === null) throw new Error("expected stored bytes");
		first.value.fill(99);
		const second = await store.getBlob(digest);
		expect(second).toEqual({ ok: true, value: expected });
		expect(second.ok && second.value).not.toBe(first.value);
		await store.close();
	});

	it("gives own SharedArrayBuffer bytes precedence over an extra sibling without database mutation", async () => {
		const filename = await databaseFilename();
		const store = createSqliteAheDurableStore({ filename });
		const payload = Uint8Array.of(16, 17, 18);
		const digest = must(digestBlob(payload));
		await begin(store, OBJECT_A, GENERATION_A, payload);
		const before = await readStoreView(store, OBJECT_A);
		if (!before.ok) throw new Error(`split read fixture failed: ${before.reason}`);
		const ordinaryWithExtra = {
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			digest,
			bytes: payload,
			extra: true,
		};
		const shared = new Uint8Array(new SharedArrayBuffer(payload.byteLength));
		shared.set(payload);

		expect
			.soft(await store.putCachedBlob(ordinaryWithExtra as Parameters<AheDurableStore["putCachedBlob"]>[0]))
			.toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
		expect
			.soft(
				await store.putCachedBlob({ ...ordinaryWithExtra, bytes: shared } as Parameters<
					AheDurableStore["putCachedBlob"]
				>[0])
			)
			.toEqual({ ok: false, reason: "SHARED_BUFFER_INPUT" });
		expect.soft(await store.getBlob(digest)).toEqual({ ok: true, value: null });
		expect.soft(await readStoreView(store, OBJECT_A)).toEqual(before);
		await store.close();

		const database = new DatabaseSync(filename);
		try {
			expect.soft(database.prepare("SELECT count(*) AS count FROM blobs").get()).toEqual({ count: 0 });
		} finally {
			database.close();
		}
	});

	it("preserves closure reasons and lets STORE_CLOSED outrank semantic closure rejection", async () => {
		const store = createSqliteAheDurableStore({ filename: await databaseFilename() });
		const payload = Uint8Array.of(19, 20, 21);
		const digest = must(digestBlob(payload));
		const reference = { digest, byteLength: payload.byteLength };
		const cases = [
			{ closure: [], reason: "EMPTY_CLOSURE" },
			{ closure: [reference, reference], reason: "DUPLICATE_CLOSURE_REFERENCE" },
		] as const;

		for (const { closure, reason } of cases) {
			expect
				.soft(
					await store.beginGeneration({
						objectId: OBJECT_A,
						generationId: GENERATION_A,
						baseExpectedHead: noHead(OBJECT_A),
						closure,
					})
				)
				.toEqual({ ok: false, reason });
		}
		expect.soft(await readStoreView(store, OBJECT_A)).toEqual({
			ok: true,
			value: { head: noHead(OBJECT_A), generations: [] },
		});
		expect(
			await store.beginGeneration({
				objectId: OBJECT_B,
				generationId: GENERATION_A,
				baseExpectedHead: noHead(OBJECT_B),
				closure: [reference],
			})
		).toMatchObject({ ok: true });

		await store.close();
		for (const { closure } of cases) {
			expect
				.soft(
					await store.beginGeneration({
						objectId: OBJECT_A,
						generationId: GENERATION_A,
						baseExpectedHead: noHead(OBJECT_A),
						closure,
					})
				)
				.toEqual({ ok: false, reason: "STORE_CLOSED" });
		}
	});

	it("keeps legacy plain object IDs outside the greenfield adapter", async () => {
		const store = createSqliteAheDurableStore({ filename: await databaseFilename() });
		const result = await callSplitRead(store, "readHead", "plain-room-id" as StorageObjectId);
		expect(result).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
		await store.close();
	});
});
