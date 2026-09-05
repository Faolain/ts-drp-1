import {
	type AheDurableStore,
	digestBlob,
	type GenerationId,
	parseGenerationId,
	parseStorageObjectId,
	type StorageObjectId,
} from "@ts-drp/storage";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteAheDurableStore } from "../src/index.js";

const OBJECT_A = must(parseStorageObjectId(`sqlite-2d2c:${"a".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("c".repeat(64)));
const temporaryDirectories: string[] = [];

function must<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
	if (!result.ok) throw new Error("invalid Phase 2d2c fixture");
	return result.value;
}

async function databaseFilename(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-storage-node-2d2c-red-"));
	temporaryDirectories.push(directory);
	return join(directory, "store.sqlite");
}

async function prepareTwoReferenceGeneration(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId
): Promise<readonly Uint8Array[]> {
	const payloads = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6)];
	const references = payloads.map((payload) => ({
		byteLength: payload.byteLength,
		digest: must(digestBlob(payload)),
	}));
	const begun = await store.beginGeneration({
		baseExpectedHead: { kind: "none", objectId },
		closure: references,
		generationId,
		objectId,
	});
	if (!begun.ok) throw new Error(`begin failed: ${begun.reason}`);
	for (let index = 0; index < references.length; index++) {
		const reference = references[index];
		const payload = payloads[index];
		if (reference === undefined || payload === undefined) throw new Error("closure fixture mismatch");
		const cached = await store.putCachedBlob({ bytes: payload, digest: reference.digest, generationId, objectId });
		if (!cached.ok) throw new Error(`cache failed: ${cached.reason}`);
		const promoted = await store.promoteReference({ digest: reference.digest, generationId, objectId });
		if (!promoted.ok) throw new Error(`promotion failed: ${promoted.reason}`);
	}
	return payloads;
}

async function withSqliteStatementTrace<T>(run: () => Promise<T>): Promise<Readonly<{ result: T; sql: string[] }>> {
	type MutableDatabasePrototype = {
		exec: DatabaseSync["exec"];
		prepare: DatabaseSync["prepare"];
	};
	const prototype = DatabaseSync.prototype as unknown as MutableDatabasePrototype;
	const originalExec = prototype.exec;
	const originalPrepare = prototype.prepare;
	const sql: string[] = [];
	prototype.exec = function tracedExec(this: DatabaseSync, statement: string): void {
		sql.push(statement);
		originalExec.call(this, statement);
	};
	prototype.prepare = function tracedPrepare(
		this: DatabaseSync,
		statement: string
	): ReturnType<DatabaseSync["prepare"]> {
		sql.push(statement);
		return originalPrepare.call(this, statement);
	};
	try {
		return { result: await run(), sql };
	} finally {
		prototype.exec = originalExec;
		prototype.prepare = originalPrepare;
	}
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { force: true, recursive: true });
});

describe("Phase 2d2c SQLite bounded completion RED", () => {
	it("reverifies each promoted blob incrementally inside the real completion transaction", async () => {
		const store = createSqliteAheDurableStore({ filename: await databaseFilename() });
		const payloads = await prepareTwoReferenceGeneration(store, OBJECT_A, GENERATION_A);
		const traced = await withSqliteStatementTrace(() =>
			store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT_A })
		);

		expect.soft(traced.result).toMatchObject({ ok: true, value: { state: "Complete" } });
		expect.soft(traced.sql.filter((sql) => sql === "BEGIN IMMEDIATE")).toHaveLength(1);
		expect.soft(traced.sql.filter((sql) => sql === "COMMIT")).toHaveLength(1);
		expect.soft(traced.sql.filter((sql) => sql.startsWith("SELECT 1 FROM promotions"))).toHaveLength(2);
		expect.soft(traced.sql.filter((sql) => sql.startsWith("SELECT bytes FROM blobs"))).toHaveLength(2);
		expect.soft(traced.sql.filter((sql) => sql.startsWith("UPDATE generations SET record"))).toHaveLength(1);
		for (const payload of payloads) {
			const blob = await store.getBlob(must(digestBlob(payload)));
			expect.soft(blob).toEqual({ ok: true, value: payload });
		}
		await store.close();
	});
});
