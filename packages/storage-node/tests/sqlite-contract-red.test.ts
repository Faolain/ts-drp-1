import {
	type AheDurableStore,
	digestBlob,
	type GenerationId,
	parseGenerationId,
	type ParseResult,
	parseStorageObjectId,
	type StorageObjectId,
} from "@ts-drp/storage";
import { runStoreContract } from "@ts-drp/storage/contract";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteAheDurableStore } from "../src/index.js";
import { createInstrumentedSqliteAheDurableStore } from "../src/test-instrumentation.js";

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

async function begin(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId,
	bytes: Uint8Array
): Promise<void> {
	const digest = must(digestBlob(bytes));
	const result = await store.beginGeneration({
		objectId,
		generationId,
		baseExpectedHead: noHead(objectId),
		closure: [{ digest, byteLength: bytes.byteLength }],
	});
	if (!result.ok) throw new Error(`begin fixture failed: ${result.reason}`);
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("Phase 2c-a Node SQLite strict store RED", () => {
	it("reports the exact frozen strict capability pair", async () => {
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
		const bytesA = Uint8Array.of(1, 2, 3);
		const bytesB = Uint8Array.of(4, 5, 6);
		const digestA = must(digestBlob(bytesA));
		const digestB = must(digestBlob(bytesB));
		await begin(first, OBJECT_A, GENERATION_B, bytesA);
		await begin(first, OBJECT_B, GENERATION_A, bytesB);
		expect(
			await first.putCachedBlob({ objectId: OBJECT_A, generationId: GENERATION_B, digest: digestA, bytes: bytesA })
		).toEqual({
			ok: true,
			value: { inserted: true },
		});
		expect(
			await first.putCachedBlob({ objectId: OBJECT_B, generationId: GENERATION_A, digest: digestB, bytes: bytesB })
		).toEqual({
			ok: true,
			value: { inserted: true },
		});
		await first.close();

		const reopened = createSqliteAheDurableStore({ filename });
		const stateA = await reopened.readObjectState(OBJECT_A);
		const stateB = await reopened.readObjectState(OBJECT_B);
		expect.soft(stateA.ok && stateA.value.generations.map(({ generationId }) => generationId)).toEqual([GENERATION_B]);
		expect.soft(stateB.ok && stateB.value.generations.map(({ generationId }) => generationId)).toEqual([GENERATION_A]);
		expect.soft(await reopened.getBlob(digestA)).toEqual({ ok: true, value: bytesA });
		expect.soft(await reopened.getBlob(digestB)).toEqual({ ok: true, value: bytesB });
		await reopened.close();
	});

	it("creates a structural composite-key schema with WAL, FULL synchronous, foreign keys, and integrity", async () => {
		const filename = await databaseFilename();
		const instrumented = createInstrumentedSqliteAheDurableStore({ filename });
		const configuration = instrumented.inspectConfiguration();
		const store = instrumented.store;
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

			expect.soft(configuration).toEqual({
				foreignKeys: true,
				integrityCheck: "ok",
				journalMode: "wal",
				synchronous: "full",
			});
			expect.soft(primaryKey).toEqual([
				{ name: "object_id", pk: 1 },
				{ name: "generation_id", pk: 2 },
			]);
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
			throw injected;
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
		expect.soft(await store.readObjectState(OBJECT_A)).toEqual({
			ok: true,
			value: { head: noHead(OBJECT_A), generations: [] },
		});
		expect.soft(await store.getBlob(digest)).toEqual({ ok: true, value: null });
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

	it("keeps legacy plain object IDs outside the greenfield adapter", async () => {
		const store = createSqliteAheDurableStore({ filename: await databaseFilename() });
		const result = await store.readObjectState("plain-room-id" as StorageObjectId);
		expect(result).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
		await store.close();
	});
});
