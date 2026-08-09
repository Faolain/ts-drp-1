import {
	type AheDurableStore,
	digestBlob,
	type ExpectedHead,
	type GenerationId,
	parseGenerationId,
	parseStorageObjectId,
	type StorageObjectId,
} from "@ts-drp/storage";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteAheDurableStore } from "../src/index.js";

const OBJECT_A = must(parseStorageObjectId(`phase-2e1-node-a:${"a".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("1".repeat(64)));
const GENERATION_B = must(parseGenerationId("2".repeat(64)));
const GENERATION_C = must(parseGenerationId("3".repeat(64)));
const temporaryDirectories: string[] = [];

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new Error("invalid Phase 2e1 fixture");
	return result.value;
}

function noHead(objectId: StorageObjectId = OBJECT_A): ExpectedHead {
	return { kind: "none", objectId };
}

async function databaseFilename(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-phase-2e1-node-"));
	temporaryDirectories.push(directory);
	return join(directory, "store.sqlite");
}

async function stage(
	store: AheDurableStore,
	generationId: GenerationId,
	payload: Uint8Array,
	baseExpectedHead: ExpectedHead
): Promise<void> {
	const digest = must(digestBlob(payload));
	const begun = await store.beginGeneration({
		baseExpectedHead,
		closure: [{ byteLength: payload.byteLength, digest }],
		generationId,
		objectId: OBJECT_A,
	});
	if (!begun.ok) throw new Error(`begin failed: ${begun.reason}`);
}

async function complete(store: AheDurableStore, generationId: GenerationId, payload: Uint8Array): Promise<void> {
	const digest = must(digestBlob(payload));
	for (const result of [
		await store.putCachedBlob({ bytes: payload, digest, generationId, objectId: OBJECT_A }),
		await store.promoteReference({ digest, generationId, objectId: OBJECT_A }),
		await store.completeGeneration({ generationId, objectId: OBJECT_A }),
	]) {
		if (!result.ok) throw new Error(`completion fixture failed: ${result.reason}`);
	}
}

async function splitRead(store: object, method: "readGenerationPage" | "readHead", input: unknown): Promise<unknown> {
	const callable = Reflect.get(store, method);
	if (typeof callable !== "function") return { ok: false, reason: "SPLIT_READ_NOT_IMPLEMENTED" };
	return Reflect.apply(callable, store, [input]) as Promise<unknown>;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { force: true, recursive: true });
});

describe("Phase 2e1 Node SQLite bounded-read RED", () => {
	it("reads one detached head and deterministic exclusive generation pages across reopen", async () => {
		const filename = await databaseFilename();
		let store = createSqliteAheDurableStore({ filename });
		const payloadA = Uint8Array.of(1);
		await stage(store, GENERATION_A, payloadA, noHead());
		await complete(store, GENERATION_A, payloadA);
		const swapped = await store.swapHead({ expectedHead: noHead(), generationId: GENERATION_A, objectId: OBJECT_A });
		if (!swapped.ok) throw new Error(`swap failed: ${swapped.reason}`);
		await stage(store, GENERATION_C, Uint8Array.of(3), swapped.value.head);
		await stage(store, GENERATION_B, Uint8Array.of(2), swapped.value.head);
		await store.close();

		store = createSqliteAheDurableStore({ filename });
		const firstHead = await splitRead(store, "readHead", OBJECT_A);
		expect.soft(firstHead).toMatchObject({
			ok: true,
			value: { generationId: GENERATION_A, kind: "present", objectId: OBJECT_A, revision: 1 },
		});
		const firstHeadValue = Reflect.get(firstHead as object, "value");
		if (typeof firstHeadValue === "object" && firstHeadValue !== null) {
			Reflect.set(firstHeadValue, "revision", 99);
		}
		expect.soft(await splitRead(store, "readHead", OBJECT_A)).toMatchObject({ ok: true, value: { revision: 1 } });

		const firstPage = await splitRead(store, "readGenerationPage", { limit: 2, objectId: OBJECT_A });
		expect.soft(firstPage).toMatchObject({
			ok: true,
			value: { generations: [{ generationId: GENERATION_A }, { generationId: GENERATION_B }] },
		});
		const pageValue = Reflect.get(firstPage as object, "value") as object | undefined;
		const cursor = pageValue === undefined ? undefined : Reflect.get(pageValue, "nextCursor");
		expect.soft(typeof cursor).toBe("string");
		const rows = (pageValue === undefined ? undefined : Reflect.get(pageValue, "generations")) as object[] | undefined;
		if (rows?.[0] !== undefined) Reflect.set(rows[0], "state", "Discarded");
		expect.soft(await splitRead(store, "readGenerationPage", { cursor, limit: 2, objectId: OBJECT_A })).toEqual({
			ok: true,
			value: {
				generations: [expect.objectContaining({ generationId: GENERATION_C, state: "Staged" })],
				nextCursor: null,
			},
		});
		expect.soft(await splitRead(store, "readGenerationPage", { limit: 1, objectId: OBJECT_A })).toMatchObject({
			ok: true,
			value: { generations: [{ generationId: GENERATION_A, state: "Adopted" }] },
		});
		await store.close();
	});

	it("retains the broad missing-head/surviving-Adopted rejection with zero mutation", async () => {
		const filename = await databaseFilename();
		let store = createSqliteAheDurableStore({ filename });
		const payload = Uint8Array.of(4, 5, 6);
		await stage(store, GENERATION_A, payload, noHead());
		await complete(store, GENERATION_A, payload);
		const adopted = await store.swapHead({
			expectedHead: noHead(),
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		if (!adopted.ok) throw new Error(`adoption failed: ${adopted.reason}`);
		await store.close();

		const corruptor = new DatabaseSync(filename);
		corruptor.prepare("UPDATE objects SET head_record = NULL WHERE object_id = ?").run(OBJECT_A);
		corruptor.close();

		store = createSqliteAheDurableStore({ filename });
		const rejected = await store.beginGeneration({
			baseExpectedHead: noHead(),
			closure: [{ byteLength: 1, digest: must(digestBlob(Uint8Array.of(9))) }],
			generationId: GENERATION_B,
			objectId: OBJECT_A,
		});
		expect(rejected).toMatchObject({ ok: false, reason: "SUBSTRATE_FAILURE" });
		await store.close();

		const oracle = new DatabaseSync(filename, { readOnly: true });
		try {
			expect(
				oracle.prepare("SELECT generation_id FROM generations WHERE object_id = ? ORDER BY generation_id").all(OBJECT_A)
			).toEqual([{ generation_id: GENERATION_A }]);
			expect(oracle.prepare("SELECT head_record FROM objects WHERE object_id = ?").get(OBJECT_A)).toEqual({
				head_record: null,
			});
		} finally {
			oracle.close();
		}
	});

	it("freezes bounded public SQL while leaving the accepted six-mutation inventory unchanged", async () => {
		const source = await readFile(new URL("../src/internal/create-scaffold.ts", import.meta.url), "utf8");
		expect.soft(source).toContain("readHead(objectId");
		expect.soft(source).toContain("readGenerationPage(input");
		expect
			.soft(source)
			.toMatch(
				/SELECT generation_id, record FROM generations WHERE object_id = \? AND generation_id > \? ORDER BY generation_id LIMIT \?/u
			);
		expect
			.soft(source)
			.toMatch(/SELECT generation_id, record FROM generations WHERE object_id = \? ORDER BY generation_id LIMIT \?/u);
		expect
			.soft(source)
			.toContain('prepare("SELECT generation_id, record FROM generations WHERE object_id = ? ORDER BY generation_id")');
		expect.soft(source).not.toContain('operation === "readObjectState"');
	});
});
