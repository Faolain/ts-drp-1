import {
	type AheDurableStore,
	digestBlob,
	digestClosure,
	encodeGenerationRecordV1,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	parseGenerationId,
	parseStorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteAheDurableStore } from "../src/index.js";

const OBJECT_A = must(parseStorageObjectId(`phase-2e4-node-a:${"a".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("a".repeat(64)));
const GENERATION_B = must(parseGenerationId("b".repeat(64)));
const GENERATION_C = must(parseGenerationId("c".repeat(64)));
const PAYLOAD_A = Uint8Array.of(1, 2, 3);
const PAYLOAD_B = Uint8Array.of(4, 5, 6);
const temporaryDirectories: string[] = [];

type RecoveryValue = Readonly<{ kind: "active" | "empty" }>;

function must<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
	if (!result.ok) throw new Error("invalid Phase 2e4 Node fixture");
	return result.value;
}

function noHead(): ExpectedHead {
	return { kind: "none", objectId: OBJECT_A };
}

function reason(result: StoreResult<unknown>): string {
	return result.ok ? "OK" : result.reason;
}

async function filename(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-phase-2e4-node-"));
	temporaryDirectories.push(directory);
	return join(directory, "store.sqlite");
}

async function recover(store: AheDurableStore): Promise<StoreResult<RecoveryValue>> {
	const method = Reflect.get(store, "recoverActiveGeneration");
	if (typeof method !== "function") return { ok: false, reason: "SUBSTRATE_FAILURE", cause: "NO_RECOVERY" };
	return Reflect.apply(method, store, [OBJECT_A]) as Promise<StoreResult<RecoveryValue>>;
}

async function stage(
	store: AheDurableStore,
	generationId: GenerationId,
	payload: Uint8Array,
	baseExpectedHead: ExpectedHead
): Promise<GenerationRecord> {
	const digest = must(digestBlob(payload));
	const begun = await store.beginGeneration({
		baseExpectedHead,
		closure: [{ byteLength: payload.byteLength, digest }],
		generationId,
		objectId: OBJECT_A,
	});
	if (!begun.ok) throw new Error(`begin failed: ${begun.reason}`);
	return begun.value;
}

async function cacheAndPromote(store: AheDurableStore, generationId: GenerationId, payload: Uint8Array): Promise<void> {
	const digest = must(digestBlob(payload));
	const cached = await store.putCachedBlob({ bytes: payload, digest, generationId, objectId: OBJECT_A });
	if (!cached.ok) throw new Error(`cache failed: ${cached.reason}`);
	const promoted = await store.promoteReference({ digest, generationId, objectId: OBJECT_A });
	if (!promoted.ok) throw new Error(`promotion failed: ${promoted.reason}`);
}

async function stageComplete(
	store: AheDurableStore,
	generationId: GenerationId,
	payload: Uint8Array,
	baseExpectedHead: ExpectedHead
): Promise<GenerationRecord> {
	await stage(store, generationId, payload, baseExpectedHead);
	await cacheAndPromote(store, generationId, payload);
	const completed = await store.completeGeneration({ generationId, objectId: OBJECT_A });
	if (!completed.ok) throw new Error(`complete failed: ${completed.reason}`);
	return completed.value;
}

async function seedAdopted(databaseFilename: string): Promise<ExpectedHead> {
	const store = createSqliteAheDurableStore({ filename: databaseFilename });
	await stageComplete(store, GENERATION_A, PAYLOAD_A, noHead());
	const swapped = await store.swapHead({ expectedHead: noHead(), generationId: GENERATION_A, objectId: OBJECT_A });
	if (!swapped.ok) throw new Error(`swap failed: ${swapped.reason}`);
	await store.close();
	return swapped.value.head;
}

function physicalSnapshot(databaseFilename: string): unknown {
	const database = new DatabaseSync(databaseFilename, { readOnly: true });
	try {
		return {
			blobs: database
				.prepare("SELECT digest, typeof(bytes) AS type, hex(bytes) AS bytes FROM blobs ORDER BY digest")
				.all(),
			generations: database
				.prepare(
					"SELECT typeof(generation_id) AS id_type, hex(generation_id) AS id, hex(record) AS record FROM generations ORDER BY generation_id"
				)
				.all(),
			heads: database
				.prepare("SELECT object_id, typeof(head_record) AS type, hex(head_record) AS record FROM objects")
				.all(),
			promotions: database
				.prepare("SELECT object_id, generation_id, digest FROM promotions ORDER BY object_id, generation_id, digest")
				.all(),
		};
	} finally {
		database.close();
	}
}

async function withOneGenerationReadFailure<T>(run: () => Promise<T>): Promise<T> {
	type Prototype = { prepare: DatabaseSync["prepare"] };
	const prototype = DatabaseSync.prototype as unknown as Prototype;
	const originalPrepare = prototype.prepare;
	let injected = false;
	prototype.prepare = function failingPrepare(this: DatabaseSync, sql: string): ReturnType<DatabaseSync["prepare"]> {
		const statement = originalPrepare.call(this, sql);
		if (!sql.includes("FROM generations") || !sql.includes("LIMIT")) return statement;
		return new Proxy(statement, {
			get(target, property, receiver): unknown {
				const value = Reflect.get(target, property, receiver);
				if (property !== "all" || typeof value !== "function") return value;
				return (...args: unknown[]): unknown => {
					if (!injected) {
						injected = true;
						throw new Error("PHASE_2E4_INJECTED_GENERATION_READ_FAILURE");
					}
					return Reflect.apply(value, target, args);
				};
			},
		}) as ReturnType<DatabaseSync["prepare"]>;
	};
	try {
		return await run();
	} finally {
		prototype.prepare = originalPrepare;
	}
}

async function countGenerationPageReads<T>(run: () => Promise<T>): Promise<Readonly<{ count: number; result: T }>> {
	type Prototype = { prepare: DatabaseSync["prepare"] };
	const prototype = DatabaseSync.prototype as unknown as Prototype;
	const originalPrepare = prototype.prepare;
	let count = 0;
	prototype.prepare = function countingPrepare(this: DatabaseSync, sql: string): ReturnType<DatabaseSync["prepare"]> {
		if (sql.includes("FROM generations") && sql.includes("LIMIT")) count++;
		return originalPrepare.call(this, sql);
	};
	try {
		const result = await run();
		return { count, result };
	} finally {
		prototype.prepare = originalPrepare;
	}
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { force: true, recursive: true });
});

describe("Phase 2e4 SQLite lifecycle/backend RED", () => {
	it("re-verifies unchanged-head state explicitly, poisons one handle, and redetects the root after reopen", async () => {
		const databaseFilename = await filename();
		await seedAdopted(databaseFilename);
		const digest = must(digestBlob(PAYLOAD_A));
		const first = createSqliteAheDurableStore({ filename: databaseFilename });
		expect.soft(reason(await recover(first))).toBe("OK");

		const database = new DatabaseSync(databaseFilename);
		try {
			database.prepare("UPDATE blobs SET bytes = ? WHERE digest = ?").run(Uint8Array.of(0), digest);
		} finally {
			database.close();
		}
		expect.soft(reason(await recover(first))).toBe("ADOPTED_BLOB_CORRUPT");
		expect.soft(reason(await recover(first))).toBe("STORE_POISONED");
		await first.close();
		expect.soft(reason(await recover(first))).toBe("STORE_CLOSED");

		const reopened = createSqliteAheDurableStore({ filename: databaseFilename });
		expect.soft(reason(await recover(reopened))).toBe("ADOPTED_BLOB_CORRUPT");
		expect.soft(reason(await reopened.readHead(OBJECT_A))).toBe("STORE_POISONED");
		await reopened.close();

		const repair = new DatabaseSync(databaseFilename);
		try {
			repair.prepare("UPDATE blobs SET bytes = ? WHERE digest = ?").run(PAYLOAD_A, digest);
		} finally {
			repair.close();
		}
		const repaired = createSqliteAheDurableStore({ filename: databaseFilename });
		expect.soft(reason(await recover(repaired))).toBe("OK");
		await repaired.close();
	});

	it.each([
		["unpromoted", "BLOB_UNPROMOTED"],
		["missing", "BLOB_MISSING"],
		["corrupt", "BLOB_CORRUPT"],
	] as const)("re-verifies %s physical evidence before swap with zero writes", async (damage, expected) => {
		const databaseFilename = await filename();
		const store = createSqliteAheDurableStore({ filename: databaseFilename });
		await stageComplete(store, GENERATION_A, PAYLOAD_A, noHead());
		const digest = must(digestBlob(PAYLOAD_A));
		const database = new DatabaseSync(databaseFilename);
		try {
			if (damage === "unpromoted")
				database
					.prepare("DELETE FROM promotions WHERE object_id = ? AND generation_id = ? AND digest = ?")
					.run(OBJECT_A, GENERATION_A, digest);
			else if (damage === "missing") {
				database.exec("PRAGMA foreign_keys = OFF");
				database.prepare("DELETE FROM blobs WHERE digest = ?").run(digest);
			} else database.prepare("UPDATE blobs SET bytes = ? WHERE digest = ?").run(Uint8Array.of(0), digest);
		} finally {
			database.close();
		}
		const before = physicalSnapshot(databaseFilename);
		const failed = await store.swapHead({ expectedHead: noHead(), generationId: GENERATION_A, objectId: OBJECT_A });
		expect.soft(reason(failed)).toBe(expected);
		expect.soft(physicalSnapshot(databaseFilename)).toEqual(before);
		expect.soft(reason(await store.readHead(OBJECT_A))).toBe("OK");

		const repair = new DatabaseSync(databaseFilename);
		try {
			if (damage === "unpromoted") {
				repair
					.prepare("INSERT INTO promotions(object_id, generation_id, digest) VALUES (?, ?, ?)")
					.run(OBJECT_A, GENERATION_A, digest);
			} else if (damage === "missing") {
				repair.prepare("INSERT INTO blobs(digest, bytes) VALUES (?, ?)").run(digest, PAYLOAD_A);
			} else {
				repair.prepare("UPDATE blobs SET bytes = ? WHERE digest = ?").run(PAYLOAD_A, digest);
			}
		} finally {
			repair.close();
		}
		expect
			.soft(reason(await store.swapHead({ expectedHead: noHead(), generationId: GENERATION_A, objectId: OBJECT_A })))
			.toBe("OK");
		await store.close();
	});

	it("invalidates a stale certificate and verifies another handle's adopted closure before evaluating", async () => {
		const databaseFilename = await filename();
		const firstHead = await seedAdopted(databaseFilename);
		const first = createSqliteAheDurableStore({ filename: databaseFilename });
		const second = createSqliteAheDurableStore({ filename: databaseFilename });
		expect.soft(reason(await recover(first))).toBe("OK");
		await stageComplete(second, GENERATION_B, PAYLOAD_B, firstHead);
		const advanced = await second.swapHead({ expectedHead: firstHead, generationId: GENERATION_B, objectId: OBJECT_A });
		if (!advanced.ok) throw new Error(`advance failed: ${advanced.reason}`);
		const digest = must(digestBlob(PAYLOAD_B));
		const corrupt = new DatabaseSync(databaseFilename);
		try {
			corrupt
				.prepare("DELETE FROM promotions WHERE object_id = ? AND generation_id = ? AND digest = ?")
				.run(OBJECT_A, GENERATION_B, digest);
		} finally {
			corrupt.close();
		}
		const before = physicalSnapshot(databaseFilename);
		const stale = await first.beginGeneration({
			baseExpectedHead: firstHead,
			closure: [{ byteLength: 1, digest: must(digestBlob(Uint8Array.of(99))) }],
			generationId: GENERATION_C,
			objectId: OBJECT_A,
		});
		expect.soft(reason(stale)).toBe("ADOPTED_BLOB_UNPROMOTED");
		expect.soft(physicalSnapshot(databaseFilename)).toEqual(before);
		expect.soft(reason(await first.readHead(OBJECT_A))).toBe("STORE_POISONED");
		await first.close();
		await second.close();
	});

	it("rejects completion without promotion, then permits promotion and retry", async () => {
		const databaseFilename = await filename();
		const store = createSqliteAheDurableStore({ filename: databaseFilename });
		await stage(store, GENERATION_A, PAYLOAD_A, noHead());
		const digest = must(digestBlob(PAYLOAD_A));
		expect
			.soft(
				reason(await store.putCachedBlob({ bytes: PAYLOAD_A, digest, generationId: GENERATION_A, objectId: OBJECT_A }))
			)
			.toBe("OK");
		expect
			.soft(reason(await store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A })))
			.toBe("BLOB_UNPROMOTED");
		expect
			.soft(reason(await store.promoteReference({ digest, generationId: GENERATION_A, objectId: OBJECT_A })))
			.toBe("OK");
		expect.soft(reason(await store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A }))).toBe("OK");
		await store.close();
	});

	it("does not poison on a genuine substrate failure and retries recovery on the next call", async () => {
		const databaseFilename = await filename();
		const store = createSqliteAheDurableStore({ filename: databaseFilename });
		await stage(store, GENERATION_A, PAYLOAD_A, noHead());
		await cacheAndPromote(store, GENERATION_A, PAYLOAD_A);
		expect.soft(reason(await recover(store))).toBe("OK");
		const failed = await withOneGenerationReadFailure(() => recover(store));
		expect.soft(reason(failed)).toBe("SUBSTRATE_FAILURE");
		const retry = await countGenerationPageReads(() =>
			store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A })
		);
		expect.soft(reason(retry.result)).toBe("OK");
		expect.soft(retry.count).toBeGreaterThanOrEqual(1);
		expect.soft(reason(await store.readHead(OBJECT_A))).toBe("OK");
		await store.close();
	});

	it("classifies non-byte candidate and adopted blob rows without backend drift", async () => {
		const candidateFilename = await filename();
		const candidate = createSqliteAheDurableStore({ filename: candidateFilename });
		await stage(candidate, GENERATION_A, PAYLOAD_A, noHead());
		await cacheAndPromote(candidate, GENERATION_A, PAYLOAD_A);
		const digest = must(digestBlob(PAYLOAD_A));
		const candidateDatabase = new DatabaseSync(candidateFilename);
		try {
			candidateDatabase.prepare("UPDATE blobs SET bytes = ? WHERE digest = ?").run("not-bytes", digest);
		} finally {
			candidateDatabase.close();
		}
		expect
			.soft(reason(await candidate.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A })))
			.toBe("BLOB_CORRUPT");
		expect.soft(reason(await candidate.readHead(OBJECT_A))).toBe("OK");
		await candidate.close();

		const adoptedFilename = await filename();
		await seedAdopted(adoptedFilename);
		const adoptedDatabase = new DatabaseSync(adoptedFilename);
		try {
			adoptedDatabase.prepare("UPDATE blobs SET bytes = ? WHERE digest = ?").run("not-bytes", digest);
		} finally {
			adoptedDatabase.close();
		}
		const adopted = createSqliteAheDurableStore({ filename: adoptedFilename });
		expect.soft(reason(await recover(adopted))).toBe("ADOPTED_BLOB_CORRUPT");
		expect.soft(reason(await recover(adopted))).toBe("STORE_POISONED");
		await adopted.close();
	});

	it("accepts a legitimate null no-head row and rejects a surviving adopted row", async () => {
		const databaseFilename = await filename();
		const created = createSqliteAheDurableStore({ filename: databaseFilename });
		await created.close();
		const database = new DatabaseSync(databaseFilename);
		try {
			database.prepare("INSERT INTO objects(object_id, head_record) VALUES (?, NULL)").run(OBJECT_A);
		} finally {
			database.close();
		}
		const empty = createSqliteAheDurableStore({ filename: databaseFilename });
		expect.soft(reason(await recover(empty))).toBe("OK");
		await empty.close();

		const adoptedFilename = await filename();
		await seedAdopted(adoptedFilename);
		const corrupt = new DatabaseSync(adoptedFilename);
		try {
			corrupt.prepare("UPDATE objects SET head_record = NULL WHERE object_id = ?").run(OBJECT_A);
		} finally {
			corrupt.close();
		}
		const surviving = createSqliteAheDurableStore({ filename: adoptedFilename });
		expect.soft(reason(await recover(surviving))).toBe("NON_CANONICAL_RECORD");
		expect.soft(reason(await recover(surviving))).toBe("STORE_POISONED");
		await surviving.close();
	});

	it("fails closed at a non-text recovery cursor instead of repeating its page", async () => {
		const databaseFilename = await filename();
		const created = createSqliteAheDurableStore({ filename: databaseFilename });
		await created.close();
		const payload = Uint8Array.of(42);
		const reference = { byteLength: 1, digest: must(digestBlob(payload)) };
		const closureDigest = must(digestClosure([reference]));
		const database = new DatabaseSync(databaseFilename);
		try {
			database.prepare("INSERT INTO objects(object_id, head_record) VALUES (?, NULL)").run(OBJECT_A);
			const insert = database.prepare("INSERT INTO generations(object_id, generation_id, record) VALUES (?, ?, ?)");
			for (let index = 0; index < 128; index++) {
				const generationId = must(parseGenerationId((index + 16).toString(16).padStart(64, "0")));
				const record: GenerationRecord = {
					baseExpectedHead: noHead(),
					closure: [reference],
					closureDigest,
					generationId,
					objectId: OBJECT_A,
					state: "Discarded",
				};
				insert.run(OBJECT_A, generationId, encodeGenerationRecordV1(record));
			}
			for (let index = 0; index < 129; index++) {
				const canonicalId = must(parseGenerationId((index + 512).toString(16).padStart(64, "0")));
				const record: GenerationRecord = {
					baseExpectedHead: noHead(),
					closure: [reference],
					closureDigest,
					generationId: canonicalId,
					objectId: OBJECT_A,
					state: "Discarded",
				};
				insert.run(OBJECT_A, Uint8Array.of(index >> 8, index & 255), encodeGenerationRecordV1(record));
			}
		} finally {
			database.close();
		}

		type Prototype = { prepare: DatabaseSync["prepare"] };
		const prototype = DatabaseSync.prototype as unknown as Prototype;
		const originalPrepare = prototype.prepare;
		let pageQueries = 0;
		prototype.prepare = function guardedPrepare(this: DatabaseSync, sql: string): ReturnType<DatabaseSync["prepare"]> {
			const statement = originalPrepare.call(this, sql);
			if (!sql.includes("FROM generations") || !sql.includes("LIMIT")) return statement;
			return new Proxy(statement, {
				get(target, property, receiver): unknown {
					const value = Reflect.get(target, property, receiver);
					if (property !== "all" || typeof value !== "function") return value;
					return (...args: unknown[]): unknown => {
						pageQueries++;
						if (pageQueries > 3) throw new Error("PHASE_2E4_CURSOR_WATCHDOG");
						return Reflect.apply(value, target, args);
					};
				},
			}) as ReturnType<DatabaseSync["prepare"]>;
		};
		try {
			const store = createSqliteAheDurableStore({ filename: databaseFilename });
			expect.soft(reason(await recover(store))).toBe("NON_CANONICAL_RECORD");
			expect.soft(pageQueries).toBeLessThanOrEqual(2);
			expect.soft(reason(await recover(store))).toBe("STORE_POISONED");
			await store.close();
		} finally {
			prototype.prepare = originalPrepare;
		}
	});
});
