import {
	type AheDurableStore,
	digestBlob,
	digestClosure,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteAheDurableStore } from "../src/index.js";

const OBJECT_A = must(parseStorageObjectId(`phase-2e3-node-a:${"a".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("a".repeat(64)));
const GENERATION_B = must(parseGenerationId("b".repeat(64)));
const GENERATION_C = must(parseGenerationId("c".repeat(64)));
const PAYLOAD_A = Uint8Array.of(1, 2, 3);
const PAYLOAD_B = Uint8Array.of(4, 5, 6);
const temporaryDirectories: string[] = [];

type RecoveryValue = Readonly<{
	kind: "active" | "empty";
	head: ExpectedHead;
	adoptedGeneration: GenerationRecord | null;
	recomputedClosureDigest: string | null;
	references: readonly Readonly<{ byteLength: number; digest: string }>[];
}>;

function must<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
	if (!result.ok) throw new Error("invalid Phase 2e3 Node fixture");
	return result.value;
}

function noHead(): ExpectedHead {
	return { kind: "none", objectId: OBJECT_A };
}

function futureVersionEnvelope(v1: Uint8Array): Uint8Array {
	const bytes = new Uint8Array(v1);
	if (bytes.at(-1) !== 2) throw new Error("canonical v1 envelope encoding changed");
	bytes[bytes.length - 1] = 4;
	return bytes;
}

async function filename(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-phase-2e3-node-"));
	temporaryDirectories.push(directory);
	return join(directory, "store.sqlite");
}

async function recover(store: AheDurableStore): Promise<StoreResult<RecoveryValue>> {
	const method = Reflect.get(store, "recoverActiveGeneration");
	if (typeof method !== "function") {
		return { ok: false, reason: "SUBSTRATE_FAILURE", cause: "RECOVERY_NOT_IMPLEMENTED" };
	}
	return (await Reflect.apply(method, store, [OBJECT_A])) as StoreResult<RecoveryValue>;
}

async function stage(
	store: AheDurableStore,
	generationId: GenerationId,
	payload: Uint8Array,
	baseExpectedHead: ExpectedHead
): Promise<GenerationRecord> {
	const digest = must(digestBlob(payload));
	const result = await store.beginGeneration({
		baseExpectedHead,
		closure: [{ byteLength: payload.byteLength, digest }],
		generationId,
		objectId: OBJECT_A,
	});
	if (!result.ok) throw new Error(`begin failed: ${result.reason}`);
	return result.value;
}

async function cacheAndPromote(store: AheDurableStore, generationId: GenerationId, payload: Uint8Array): Promise<void> {
	const digest = must(digestBlob(payload));
	for (const result of [
		await store.putCachedBlob({ bytes: payload, digest, generationId, objectId: OBJECT_A }),
		await store.promoteReference({ digest, generationId, objectId: OBJECT_A }),
	]) {
		if (!result.ok) throw new Error(`promotion fixture failed: ${result.reason}`);
	}
}

async function complete(store: AheDurableStore, generationId: GenerationId): Promise<GenerationRecord> {
	const result = await store.completeGeneration({ generationId, objectId: OBJECT_A });
	if (!result.ok) throw new Error(`completion fixture failed: ${result.reason}`);
	return result.value;
}

function snapshot(databaseFilename: string): unknown {
	const database = new DatabaseSync(databaseFilename, { readOnly: true });
	try {
		return {
			blobs: database
				.prepare("SELECT digest, typeof(bytes) AS type, hex(bytes) AS bytes FROM blobs ORDER BY digest")
				.all(),
			generations: database
				.prepare(
					"SELECT object_id, generation_id, hex(record) AS record FROM generations ORDER BY object_id, generation_id"
				)
				.all(),
			objects: database.prepare("SELECT object_id, hex(head_record) AS head FROM objects ORDER BY object_id").all(),
			promotions: database
				.prepare("SELECT object_id, generation_id, digest FROM promotions ORDER BY object_id, generation_id, digest")
				.all(),
		};
	} finally {
		database.close();
	}
}

async function seedAdopted(
	databaseFilename: string
): Promise<Readonly<{ adopted: GenerationRecord; head: ExpectedHead }>> {
	const store = createSqliteAheDurableStore({ filename: databaseFilename });
	await stage(store, GENERATION_A, PAYLOAD_A, noHead());
	await cacheAndPromote(store, GENERATION_A, PAYLOAD_A);
	await complete(store, GENERATION_A);
	const swapped = await store.swapHead({ expectedHead: noHead(), generationId: GENERATION_A, objectId: OBJECT_A });
	if (!swapped.ok) throw new Error(`swap fixture failed: ${swapped.reason}`);
	const adopted = await store.readGenerationPage({ limit: 1, objectId: OBJECT_A });
	if (!adopted.ok || adopted.value.generations[0] === undefined) throw new Error("adopted fixture missing");
	await store.close();
	return { adopted: adopted.value.generations[0], head: swapped.value.head };
}

async function seedPromotedCandidate(databaseFilename: string): Promise<void> {
	const store = createSqliteAheDurableStore({ filename: databaseFilename });
	await stage(store, GENERATION_A, PAYLOAD_A, noHead());
	await cacheAndPromote(store, GENERATION_A, PAYLOAD_A);
	await store.close();
}

async function seedTwoReferenceCandidate(
	databaseFilename: string,
	promoteFirst: boolean,
	promoteSecond: boolean
): Promise<readonly [string, string]> {
	const store = createSqliteAheDurableStore({ filename: databaseFilename });
	const references = [PAYLOAD_A, PAYLOAD_B].map((payload) => ({
		byteLength: payload.byteLength,
		digest: must(digestBlob(payload)),
	}));
	const begun = await store.beginGeneration({
		baseExpectedHead: noHead(),
		closure: references,
		generationId: GENERATION_A,
		objectId: OBJECT_A,
	});
	if (!begun.ok) throw new Error(`two-reference begin failed: ${begun.reason}`);
	for (let index = 0; index < references.length; index++) {
		const reference = references[index];
		const payload = [PAYLOAD_A, PAYLOAD_B][index];
		if (reference === undefined || payload === undefined) throw new Error("two-reference fixture mismatch");
		const cached = await store.putCachedBlob({
			bytes: payload,
			digest: reference.digest,
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		if (!cached.ok) throw new Error(`two-reference cache failed: ${cached.reason}`);
		if (index === 0 ? promoteFirst : promoteSecond) {
			const promoted = await store.promoteReference({
				digest: reference.digest,
				generationId: GENERATION_A,
				objectId: OBJECT_A,
			});
			if (!promoted.ok) throw new Error(`two-reference promotion failed: ${promoted.reason}`);
		}
	}
	await store.close();
	const first = references[0];
	const second = references[1];
	if (first === undefined || second === undefined) throw new Error("two-reference fixture missing");
	return [first.digest, second.digest];
}

async function traceSql<T>(run: () => Promise<T>): Promise<
	Readonly<{
		bindings: readonly Readonly<{ args: readonly unknown[]; method: string; sql: string }>[];
		result: T;
		sql: string[];
	}>
> {
	type Prototype = { exec: DatabaseSync["exec"]; prepare: DatabaseSync["prepare"] };
	const prototype = DatabaseSync.prototype as unknown as Prototype;
	const originalExec = prototype.exec;
	const originalPrepare = prototype.prepare;
	const sql: string[] = [];
	const bindings: Array<Readonly<{ args: readonly unknown[]; method: string; sql: string }>> = [];
	prototype.exec = function tracedExec(this: DatabaseSync, statement: string): void {
		sql.push(statement);
		originalExec.call(this, statement);
	};
	prototype.prepare = function tracedPrepare(
		this: DatabaseSync,
		statement: string
	): ReturnType<DatabaseSync["prepare"]> {
		sql.push(statement);
		const prepared = originalPrepare.call(this, statement);
		return new Proxy(prepared, {
			get(target, property, receiver): unknown {
				const value = Reflect.get(target, property, receiver);
				if (typeof value !== "function" || !["all", "get", "run"].includes(String(property))) return value;
				return (...args: unknown[]): unknown => {
					bindings.push({ args, method: String(property), sql: statement });
					return Reflect.apply(value, target, args);
				};
			},
		}) as ReturnType<DatabaseSync["prepare"]>;
	};
	try {
		return { bindings, result: await run(), sql };
	} finally {
		prototype.exec = originalExec;
		prototype.prepare = originalPrepare;
	}
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { force: true, recursive: true });
});

describe("Phase 2e3 SQLite atomic recovery RED", () => {
	it("positive control keeps caller validation nonpoisoning and close precedence intact", async () => {
		const databaseFilename = await filename();
		const store = createSqliteAheDurableStore({ filename: databaseFilename });
		expect.soft(await Reflect.apply(store.beginGeneration, store, [{}])).toEqual({
			ok: false,
			reason: "INVALID_ARGUMENT",
		});
		expect.soft(await store.readHead(OBJECT_A)).toEqual({ ok: true, value: noHead() });
		await store.close();
		expect.soft(await store.readHead(OBJECT_A)).toEqual({ ok: false, reason: "STORE_CLOSED" });
	});

	it("deletes the monolithic Node mutation loader instead of retaining dual authority", () => {
		const source = readFileSync(new URL("../src/internal/create-scaffold.ts", import.meta.url), "utf8");
		expect.soft(source).not.toContain('case "object-state"');
		expect.soft(source).not.toContain("loadObjectState(");
		expect.soft(source).not.toContain("generation closure loaded without its object state");
	});

	it("returns exact empty and detached active verification metadata", async () => {
		const emptyStore = createSqliteAheDurableStore({ filename: await filename() });
		expect(await recover(emptyStore)).toEqual({
			ok: true,
			value: {
				kind: "empty",
				head: noHead(),
				adoptedGeneration: null,
				recomputedClosureDigest: null,
				references: [],
			},
		});
		await emptyStore.close();

		const activeFilename = await filename();
		const fixture = await seedAdopted(activeFilename);
		const activeStore = createSqliteAheDurableStore({ filename: activeFilename });
		const active = await recover(activeStore);
		expect(active).toEqual({
			ok: true,
			value: {
				kind: "active",
				head: fixture.head,
				adoptedGeneration: fixture.adopted,
				recomputedClosureDigest: fixture.adopted.closureDigest,
				references: fixture.adopted.closure,
			},
		});
		if (active.ok) {
			try {
				(active.value.references as unknown[]).splice(0);
			} catch {
				// Deeply frozen output also proves it cannot mutate retained state.
			}
		}
		expect(await recover(activeStore)).toMatchObject({ ok: true, value: { references: fixture.adopted.closure } });
		await activeStore.close();
	});

	it("walks more than 128 generation rows with bounded page queries in one transaction", async () => {
		const databaseFilename = await filename();
		const created = createSqliteAheDurableStore({ filename: databaseFilename });
		await created.close();
		const payload = Uint8Array.of(42);
		const reference = { byteLength: 1, digest: must(digestBlob(payload)) };
		const closureDigest = must(digestClosure([reference]));
		const records: GenerationRecord[] = [];
		for (let index = 0; index < 130; index++) {
			const generationId = must(parseGenerationId((index + 16).toString(16).padStart(64, "0")));
			records.push({
				baseExpectedHead: noHead(),
				closure: [reference],
				closureDigest,
				generationId,
				objectId: OBJECT_A,
				state: "Discarded",
			});
		}
		const database = new DatabaseSync(databaseFilename);
		try {
			database.prepare("INSERT INTO objects(object_id, head_record) VALUES (?, NULL)").run(OBJECT_A);
			const insert = database.prepare("INSERT INTO generations(object_id, generation_id, record) VALUES (?, ?, ?)");
			for (const generation of records) {
				insert.run(OBJECT_A, generation.generationId, encodeGenerationRecordV1(generation));
			}
		} finally {
			database.close();
		}

		const store = createSqliteAheDurableStore({ filename: databaseFilename });
		const traced = await traceSql(() => recover(store));
		expect.soft(traced.result).toMatchObject({ ok: true, value: { kind: "empty" } });
		const pageQueries = traced.sql.filter(
			(sql) => sql.includes("FROM generations") && sql.includes("ORDER BY generation_id") && sql.includes("LIMIT")
		);
		expect.soft(pageQueries.length).toBeGreaterThanOrEqual(2);
		expect.soft(traced.sql.filter((sql) => sql === "BEGIN IMMEDIATE")).toHaveLength(1);
		expect.soft(traced.sql.filter((sql) => sql === "COMMIT")).toHaveLength(1);
		expect.soft(traced.sql.some((sql) => sql.includes("FROM generations") && !sql.includes("LIMIT"))).toBe(false);
		await store.close();
	});

	it("preserves unsupported-over-noncanonical precedence across recovery pages", async () => {
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
			for (let index = 0; index < 130; index++) {
				const generationId = must(parseGenerationId((index + 16).toString(16).padStart(64, "0")));
				const generation: GenerationRecord = {
					baseExpectedHead: noHead(),
					closure: [reference],
					closureDigest,
					generationId,
					objectId: OBJECT_A,
					state: "Discarded",
				};
				const canonical = encodeGenerationRecordV1(generation);
				const bytes = index === 0 ? Uint8Array.of(255) : index === 129 ? futureVersionEnvelope(canonical) : canonical;
				insert.run(OBJECT_A, generationId, bytes);
			}
		} finally {
			database.close();
		}
		const before = snapshot(databaseFilename);
		const store = createSqliteAheDurableStore({ filename: databaseFilename });
		const traced = await traceSql(() => recover(store));
		expect.soft(traced.result).toEqual({ ok: false, reason: "UNSUPPORTED_STORAGE_SCHEMA" });
		expect
			.soft(traced.sql.filter((sql) => sql.includes("FROM generations") && sql.includes("LIMIT")).length)
			.toBeGreaterThanOrEqual(2);
		expect.soft(snapshot(databaseFilename)).toEqual(before);
		expect.soft(await store.readHead(OBJECT_A)).toEqual({ ok: false, reason: "STORE_POISONED" });
		await store.close();
	});

	it("recovers before the G1-rev5 head-deletion swap and performs zero writes", async () => {
		const databaseFilename = await filename();
		const first = await seedAdopted(databaseFilename);
		if (first.head.kind !== "present") throw new Error("head fixture missing");
		const revisionFive = must(parseHeadRevision(5));
		const headFive = { ...first.head, revision: revisionFive };
		const database = new DatabaseSync(databaseFilename);
		try {
			database
				.prepare("UPDATE objects SET head_record = ? WHERE object_id = ?")
				.run(encodeHeadRecordV1(headFive), OBJECT_A);
		} finally {
			database.close();
		}
		const staging = createSqliteAheDurableStore({ filename: databaseFilename });
		await stage(staging, GENERATION_B, PAYLOAD_B, headFive);
		await cacheAndPromote(staging, GENERATION_B, PAYLOAD_B);
		await complete(staging, GENERATION_B);
		await staging.close();
		const corrupt = new DatabaseSync(databaseFilename);
		try {
			corrupt.prepare("UPDATE objects SET head_record = NULL WHERE object_id = ?").run(OBJECT_A);
		} finally {
			corrupt.close();
		}
		const before = snapshot(databaseFilename);
		const store = createSqliteAheDurableStore({ filename: databaseFilename });
		const traced = await traceSql(() =>
			store.swapHead({ expectedHead: noHead(), generationId: GENERATION_B, objectId: OBJECT_A })
		);
		expect.soft(traced.result).toEqual({ ok: false, reason: "NON_CANONICAL_RECORD" });
		expect.soft(snapshot(databaseFilename)).toEqual(before);
		expect.soft(await store.readHead(OBJECT_A)).toEqual({ ok: false, reason: "STORE_POISONED" });
		expect.soft(traced.sql.some((sql) => sql.includes("LIMIT"))).toBe(true);
		expect.soft(traced.sql.some((sql) => sql.includes("SELECT bytes FROM blobs"))).toBe(false);
		await store.close();
	});

	it("invalidates a recovered certificate when another handle changes the head", async () => {
		const databaseFilename = await filename();
		const fixture = await seedAdopted(databaseFilename);
		const staging = createSqliteAheDurableStore({ filename: databaseFilename });
		await stage(staging, GENERATION_B, PAYLOAD_B, fixture.head);
		await cacheAndPromote(staging, GENERATION_B, PAYLOAD_B);
		await complete(staging, GENERATION_B);
		await staging.close();

		const firstHandle = createSqliteAheDurableStore({ filename: databaseFilename });
		const secondHandle = createSqliteAheDurableStore({ filename: databaseFilename });
		expect.soft(await recover(firstHandle)).toMatchObject({ ok: true, value: { head: fixture.head } });
		const advanced = await secondHandle.swapHead({
			expectedHead: fixture.head,
			generationId: GENERATION_B,
			objectId: OBJECT_A,
		});
		if (!advanced.ok) throw new Error(`concurrent head advance failed: ${advanced.reason}`);
		const before = snapshot(databaseFilename);
		const traced = await traceSql(() =>
			firstHandle.beginGeneration({
				baseExpectedHead: fixture.head,
				closure: [{ byteLength: 1, digest: must(digestBlob(Uint8Array.of(99))) }],
				generationId: GENERATION_C,
				objectId: OBJECT_A,
			})
		);
		expect.soft(traced.result).toEqual({ ok: false, reason: "BASE_HEAD_MISMATCH" });
		expect.soft(snapshot(databaseFilename)).toEqual(before);
		expect.soft(traced.sql.some((sql) => sql.includes("FROM generations") && sql.includes("LIMIT"))).toBe(true);
		await firstHandle.close();
		await secondHandle.close();
	});

	it.each([
		["missing", null, "BLOB_MISSING"],
		["wrong length", Uint8Array.of(9), "BLOB_CORRUPT"],
		["wrong digest", Uint8Array.of(9, 8, 7), "BLOB_CORRUPT"],
		["wrong type", "not-bytes", "BLOB_CORRUPT"],
	] as const)("reverifies a promoted candidate with %s cached bytes", async (_name, replacement, expected) => {
		const databaseFilename = await filename();
		await seedPromotedCandidate(databaseFilename);
		const digest = must(digestBlob(PAYLOAD_A));
		const database = new DatabaseSync(databaseFilename);
		try {
			if (replacement === null) {
				database.exec("PRAGMA foreign_keys = OFF");
				database.prepare("DELETE FROM blobs WHERE digest = ?").run(digest);
			} else database.prepare("UPDATE blobs SET bytes = ? WHERE digest = ?").run(replacement, digest);
		} finally {
			database.close();
		}
		const before = snapshot(databaseFilename);
		const store = createSqliteAheDurableStore({ filename: databaseFilename });
		const traced = await traceSql(() => store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A }));
		expect.soft(traced.result).toEqual({ ok: false, reason: expected });
		expect.soft(snapshot(databaseFilename)).toEqual(before);
		expect.soft(await store.readHead(OBJECT_A)).toEqual({ ok: true, value: noHead() });
		expect.soft(traced.sql.filter((sql) => sql.startsWith("SELECT bytes FROM blobs"))).toHaveLength(1);
		await store.close();
	});

	it("requests two promoted references strictly in closure order", async () => {
		const databaseFilename = await filename();
		const [firstDigest, secondDigest] = await seedTwoReferenceCandidate(databaseFilename, true, true);
		const database = new DatabaseSync(databaseFilename);
		try {
			database.exec("PRAGMA foreign_keys = OFF");
			database.prepare("DELETE FROM blobs WHERE digest = ?").run(secondDigest);
		} finally {
			database.close();
		}
		const before = snapshot(databaseFilename);
		const store = createSqliteAheDurableStore({ filename: databaseFilename });
		const traced = await traceSql(() => store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A }));
		const verificationCalls = traced.bindings
			.filter(({ sql }) => sql.startsWith("SELECT 1 FROM promotions") || sql.startsWith("SELECT bytes FROM blobs"))
			.map(({ args, sql }) => ({ args, kind: sql.startsWith("SELECT 1") ? "promotion" : "blob" }));
		expect.soft(verificationCalls).toEqual([
			{ args: [OBJECT_A, GENERATION_A, firstDigest], kind: "promotion" },
			{ args: [firstDigest], kind: "blob" },
			{ args: [OBJECT_A, GENERATION_A, secondDigest], kind: "promotion" },
			{ args: [secondDigest], kind: "blob" },
		]);
		expect.soft(traced.result).toEqual({ ok: false, reason: "BLOB_MISSING" });
		expect.soft(snapshot(databaseFilename)).toEqual(before);
		await store.close();
	});

	it("stops at the first canonical unpromoted reference without reading a later corrupt blob", async () => {
		const databaseFilename = await filename();
		const [firstDigest, secondDigest] = await seedTwoReferenceCandidate(databaseFilename, false, true);
		const database = new DatabaseSync(databaseFilename);
		try {
			database.prepare("UPDATE blobs SET bytes = ? WHERE digest = ?").run(Uint8Array.of(0), secondDigest);
		} finally {
			database.close();
		}
		const before = snapshot(databaseFilename);
		const store = createSqliteAheDurableStore({ filename: databaseFilename });
		const traced = await traceSql(() => store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A }));
		const verificationCalls = traced.bindings.filter(
			({ sql }) => sql.startsWith("SELECT 1 FROM promotions") || sql.startsWith("SELECT bytes FROM blobs")
		);
		expect.soft(verificationCalls).toEqual([
			{
				args: [OBJECT_A, GENERATION_A, firstDigest],
				method: "get",
				sql: expect.stringMatching(/^SELECT 1 FROM promotions/),
			},
		]);
		expect.soft(traced.result).toEqual({ ok: false, reason: "BLOB_UNPROMOTED" });
		expect.soft(snapshot(databaseFilename)).toEqual(before);
		await store.close();
	});

	it.each([
		["promotion", "ADOPTED_BLOB_UNPROMOTED"],
		["blob", "ADOPTED_BLOB_MISSING"],
		["corrupt", "ADOPTED_BLOB_CORRUPT"],
	] as const)("poisons on the first adopted %s failure", async (damage, expected) => {
		const databaseFilename = await filename();
		await seedAdopted(databaseFilename);
		const digest = must(digestBlob(PAYLOAD_A));
		const database = new DatabaseSync(databaseFilename);
		try {
			if (damage === "promotion") database.prepare("DELETE FROM promotions WHERE digest = ?").run(digest);
			if (damage === "blob") {
				database.exec("PRAGMA foreign_keys = OFF");
				database.prepare("DELETE FROM blobs WHERE digest = ?").run(digest);
			}
			if (damage === "corrupt")
				database.prepare("UPDATE blobs SET bytes = ? WHERE digest = ?").run(Uint8Array.of(0), digest);
		} finally {
			database.close();
		}
		const before = snapshot(databaseFilename);
		const store = createSqliteAheDurableStore({ filename: databaseFilename });
		expect.soft(await recover(store)).toEqual({ ok: false, reason: expected });
		expect.soft(snapshot(databaseFilename)).toEqual(before);
		expect.soft(await store.readHead(OBJECT_A)).toEqual({ ok: false, reason: "STORE_POISONED" });
		await expect(store.close()).resolves.toBeUndefined();
		expect.soft(await recover(store)).toEqual({ ok: false, reason: "STORE_CLOSED" });
	});
});
