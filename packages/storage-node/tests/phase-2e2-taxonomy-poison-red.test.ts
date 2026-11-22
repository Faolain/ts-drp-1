import {
	type AheDurableStore,
	digestBlob,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
} from "@ts-drp/storage";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteAheDurableStore } from "../src/index.js";

const OBJECT_A = must(parseStorageObjectId(`phase-2e2-node-a:${"a".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("a".repeat(64)));
const GENERATION_B = must(parseGenerationId("b".repeat(64)));
const GENERATION_C = must(parseGenerationId("c".repeat(64)));
const PAYLOAD_A = Uint8Array.of(1, 2, 3);
const PAYLOAD_B = Uint8Array.of(4, 5, 6);
const temporaryDirectories: string[] = [];

type Corruption =
	| "absent-head-target"
	| "closure-mismatch"
	| "malformed-generation"
	| "malformed-head"
	| "multiple-adopted"
	| "non-adopted-head-target"
	| "physical-key-mismatch"
	| "unsupported-generation"
	| "unsupported-head";

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new TypeError("invalid Phase 2e2 Node fixture");
	return result.value;
}

function noHead(): ExpectedHead {
	return { kind: "none", objectId: OBJECT_A };
}

async function databaseFilename(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-phase-2e2-node-"));
	temporaryDirectories.push(directory);
	return join(directory, "store.sqlite");
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

async function complete(store: AheDurableStore, generationId: GenerationId, payload: Uint8Array): Promise<void> {
	const digest = must(digestBlob(payload));
	for (const result of [
		await store.putCachedBlob({ bytes: payload, digest, generationId, objectId: OBJECT_A }),
		await store.promoteReference({ digest, generationId, objectId: OBJECT_A }),
		await store.completeGeneration({ generationId, objectId: OBJECT_A }),
	]) {
		if (!result.ok) throw new Error(`completion failed: ${result.reason}`);
	}
}

async function seedCanonicalJournal(
	filename: string
): Promise<Readonly<{ adopted: GenerationRecord; staged: GenerationRecord }>> {
	const store = createSqliteAheDurableStore({ filename });
	const begunA = await stage(store, GENERATION_A, PAYLOAD_A, noHead());
	await complete(store, GENERATION_A, PAYLOAD_A);
	const adopted = await store.swapHead({ expectedHead: noHead(), generationId: GENERATION_A, objectId: OBJECT_A });
	if (!adopted.ok) throw new Error(`adoption failed: ${adopted.reason}`);
	const staged = await stage(store, GENERATION_B, PAYLOAD_B, adopted.value.head);
	await store.close();
	return { adopted: { ...begunA, state: "Adopted" }, staged };
}

function futureVersionEnvelope(v1: Uint8Array): Uint8Array {
	const bytes = new Uint8Array(v1);
	if (bytes.at(-1) !== 2) throw new Error("canonical v1 envelope encoding changed");
	bytes[bytes.length - 1] = 4;
	return bytes;
}

function corruptJournal(
	filename: string,
	corruption: Corruption,
	fixture: Readonly<{ adopted: GenerationRecord; staged: GenerationRecord }>
): void {
	const database = new DatabaseSync(filename);
	try {
		if (corruption === "absent-head-target") database.exec("PRAGMA foreign_keys = OFF");
		switch (corruption) {
			case "unsupported-generation":
				database
					.prepare("UPDATE generations SET record = ? WHERE object_id = ? AND generation_id = ?")
					.run(futureVersionEnvelope(encodeGenerationRecordV1(fixture.staged)), OBJECT_A, GENERATION_B);
				break;
			case "unsupported-head":
				database.prepare("UPDATE objects SET head_record = ? WHERE object_id = ?").run(
					futureVersionEnvelope(
						encodeHeadRecordV1({
							closureDigest: fixture.adopted.closureDigest,
							generationId: GENERATION_A,
							kind: "present",
							objectId: OBJECT_A,
							revision: must(parseHeadRevision(1)),
						})
					),
					OBJECT_A
				);
				break;
			case "malformed-generation":
				database
					.prepare("UPDATE generations SET record = ? WHERE object_id = ? AND generation_id = ?")
					.run(Uint8Array.of(255), OBJECT_A, GENERATION_B);
				break;
			case "malformed-head":
				database.prepare("UPDATE objects SET head_record = ? WHERE object_id = ?").run(Uint8Array.of(255), OBJECT_A);
				break;
			case "absent-head-target":
				database
					.prepare("DELETE FROM generations WHERE object_id = ? AND generation_id = ?")
					.run(OBJECT_A, GENERATION_A);
				break;
			case "non-adopted-head-target":
				database
					.prepare("UPDATE generations SET record = ? WHERE object_id = ? AND generation_id = ?")
					.run(encodeGenerationRecordV1({ ...fixture.adopted, state: "Complete" }), OBJECT_A, GENERATION_A);
				break;
			case "closure-mismatch":
				database.prepare("UPDATE objects SET head_record = ? WHERE object_id = ?").run(
					encodeHeadRecordV1({
						closureDigest: fixture.staged.closureDigest,
						generationId: GENERATION_A,
						kind: "present",
						objectId: OBJECT_A,
						revision: must(parseHeadRevision(1)),
					}),
					OBJECT_A
				);
				break;
			case "multiple-adopted":
				database
					.prepare("UPDATE generations SET record = ? WHERE object_id = ? AND generation_id = ?")
					.run(encodeGenerationRecordV1({ ...fixture.staged, state: "Adopted" }), OBJECT_A, GENERATION_B);
				break;
			case "physical-key-mismatch":
				database
					.prepare("UPDATE generations SET generation_id = ? WHERE object_id = ? AND generation_id = ?")
					.run(GENERATION_C, OBJECT_A, GENERATION_B);
		}
	} finally {
		database.close();
	}
}

function snapshot(filename: string): unknown {
	const database = new DatabaseSync(filename, { readOnly: true });
	try {
		return {
			blobs: database.prepare("SELECT digest, hex(bytes) AS bytes FROM blobs ORDER BY digest").all(),
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

async function beginTouch(store: AheDurableStore): Promise<unknown> {
	return store.beginGeneration({
		baseExpectedHead: noHead(),
		closure: [{ byteLength: 1, digest: must(digestBlob(Uint8Array.of(9))) }],
		generationId: GENERATION_C,
		objectId: OBJECT_A,
	});
}

async function recoverActive(store: AheDurableStore): Promise<unknown> {
	const method = Reflect.get(store, "recoverActiveGeneration");
	if (typeof method !== "function") {
		return { cause: "RECOVERY_NOT_IMPLEMENTED", ok: false, reason: "SUBSTRATE_FAILURE" };
	}
	return Reflect.apply(method, store, [OBJECT_A]) as Promise<unknown>;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { force: true, recursive: true });
});

describe("Phase 2e2 Node persisted taxonomy RED", () => {
	for (const [corruption, expectedReason] of [
		["unsupported-generation", "UNSUPPORTED_STORAGE_SCHEMA"],
		["unsupported-head", "UNSUPPORTED_STORAGE_SCHEMA"],
		["malformed-generation", "NON_CANONICAL_RECORD"],
		["malformed-head", "NON_CANONICAL_RECORD"],
		["absent-head-target", "NON_CANONICAL_RECORD"],
		["non-adopted-head-target", "NON_CANONICAL_RECORD"],
		["closure-mismatch", "NON_CANONICAL_RECORD"],
		["multiple-adopted", "NON_CANONICAL_RECORD"],
		["physical-key-mismatch", "NON_CANONICAL_RECORD"],
	] as const) {
		it(`classifies ${corruption} once and performs zero writes`, async () => {
			const filename = await databaseFilename();
			const fixture = await seedCanonicalJournal(filename);
			corruptJournal(filename, corruption, fixture);
			const before = snapshot(filename);
			const store = createSqliteAheDurableStore({ filename });
			expect.soft(await recoverActive(store)).toEqual({ ok: false, reason: expectedReason });
			expect.soft(snapshot(filename)).toEqual(before);
			await store.close();
		});
	}

	it("latches the first persisted root before later calls and lets close outrank poison", async () => {
		const filename = await databaseFilename();
		const fixture = await seedCanonicalJournal(filename);
		corruptJournal(filename, "malformed-generation", fixture);
		const before = snapshot(filename);
		const store = createSqliteAheDurableStore({ filename });
		expect.soft(await recoverActive(store)).toEqual({ ok: false, reason: "NON_CANONICAL_RECORD" });
		expect.soft(await store.readHead(OBJECT_A)).toEqual({ ok: false, reason: "STORE_POISONED" });
		expect.soft(await recoverActive(store)).toEqual({ ok: false, reason: "STORE_POISONED" });
		expect.soft(snapshot(filename)).toEqual(before);
		await expect(store.close()).resolves.toBeUndefined();
		await expect(store.close()).resolves.toBeUndefined();
		expect.soft(await store.readHead(OBJECT_A)).toEqual({ ok: false, reason: "STORE_CLOSED" });
	});

	it("keeps caller validation distinct and non-poisoning with zero writes", async () => {
		const filename = await databaseFilename();
		const store = createSqliteAheDurableStore({ filename });
		const before = snapshot(filename);
		expect.soft(await Reflect.apply(store.beginGeneration, store, [{}])).toEqual({
			ok: false,
			reason: "INVALID_ARGUMENT",
		});
		expect.soft(snapshot(filename)).toEqual(before);
		expect.soft(await store.readHead(OBJECT_A)).toEqual({ ok: true, value: noHead() });
		expect.soft(await beginTouch(store)).toMatchObject({ ok: true });
		await store.close();
	});

	it("rejects an incompatible physical schema at open with no handle or data write", async () => {
		const filename = await databaseFilename();
		const corruptor = new DatabaseSync(filename);
		corruptor.exec("CREATE TABLE objects (wrong_column TEXT PRIMARY KEY)");
		corruptor.close();
		const before = new DatabaseSync(filename, { readOnly: true });
		const rowCountBefore = (before.prepare("SELECT count(*) AS count FROM objects").get() as { count: number }).count;
		before.close();
		let opened = false;
		let handle: AheDurableStore | undefined;
		let reason: unknown;
		try {
			handle = createSqliteAheDurableStore({ filename });
			opened = true;
		} catch (error) {
			reason = Reflect.get(Object(error), "reason");
		}
		await handle?.close();
		expect.soft({ opened, reason }).toEqual({ opened: false, reason: "UNSUPPORTED_STORAGE_SCHEMA" });
		const after = new DatabaseSync(filename, { readOnly: true });
		expect
			.soft((after.prepare("SELECT count(*) AS count FROM objects").get() as { count: number }).count)
			.toBe(rowCountBefore);
		after.close();
	});
});
