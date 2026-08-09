import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
	bytes,
	GENERATION_A,
	GENERATION_B,
	GENERATION_C,
	noHead,
	OBJECT_A,
	OBJECT_B,
	presentHead,
	record,
	ref,
} from "./fixtures.js";
import {
	evaluateStorageAdapterCommand,
	prepareStorageAdapterCommand,
	type StorageAdapterFact,
	type StorageAdapterWrite,
} from "../src/adapter.js";
import { encodeGenerationRecordV1, encodeHeadRecordV1 } from "../src/codecs.js";
import { TransitionOwner } from "../src/internal/transition.js";
import { createMemoryAheDurableStore } from "../src/memory.js";
import type { GenerationRecord } from "../src/types.js";
import { parseGenerationId } from "../src/values.js";

const MAX_GENERATION_PAGE_ROWS = 128;

function objectFact(
	head: ReturnType<typeof noHead> | ReturnType<typeof presentHead>,
	generations: readonly GenerationRecord[]
): StorageAdapterFact {
	return {
		kind: "object-state",
		objectId: head.objectId,
		headRecord: head.kind === "none" ? null : encodeHeadRecordV1(head),
		generationRecords: generations.map(encodeGenerationRecordV1),
	};
}

function prepared(command: unknown): unknown {
	const result = prepareStorageAdapterCommand(command);
	return result.ok ? result.value : result;
}

async function callSplitRead(
	store: object,
	method: "readGenerationPage" | "readHead",
	input: unknown
): Promise<unknown> {
	const callable = Reflect.get(store, method);
	if (typeof callable !== "function") return { ok: false, reason: "SPLIT_READ_NOT_IMPLEMENTED" };
	return Reflect.apply(callable, store, [input]) as Promise<unknown>;
}

function writeKinds(writes: readonly StorageAdapterWrite[]): readonly string[] {
	return writes.map(({ kind }) => kind);
}

function generationIdAt(index: number): GenerationRecord["generationId"] {
	const parsed = parseGenerationId(index.toString(16).padStart(64, "0"));
	if (!parsed.ok) throw new Error(`invalid generated identity: ${parsed.reason}`);
	return parsed.value;
}

describe("Phase 2e1 bounded public reads RED", () => {
	it("replaces the runtime whole-state command with exact head and bounded page loads", () => {
		expect.soft(prepared({ kind: "readHead", objectId: OBJECT_A })).toEqual({
			command: { kind: "readHead", objectId: OBJECT_A },
			requirements: [{ kind: "head", objectId: OBJECT_A }],
		});
		expect.soft(prepared({ kind: "readGenerationPage", objectId: OBJECT_A, limit: 2 })).toEqual({
			command: { kind: "readGenerationPage", objectId: OBJECT_A, limit: 2 },
			requirements: [
				{
					afterGenerationId: null,
					kind: "generation-page",
					limitPlusOne: 3,
					objectId: OBJECT_A,
				},
			],
		});

		// This is the runtime-causal old-owner mutant: it is valid at the RED
		// baseline and loads every journal row, rather than merely missing a type.
		expect.soft(prepared({ kind: "readObjectState", objectId: OBJECT_A })).toEqual({
			ok: false,
			reason: "INVALID_ARGUMENT",
		});
	});

	it("returns detached empty/head/page/multipage values and binds an exclusive cursor to its object", async () => {
		const store = createMemoryAheDurableStore();
		expect.soft(await callSplitRead(store, "readHead", OBJECT_A)).toEqual({ ok: true, value: noHead() });
		expect.soft(await callSplitRead(store, "readGenerationPage", { objectId: OBJECT_A, limit: 2 })).toEqual({
			ok: true,
			value: { generations: [], nextCursor: null },
		});

		for (const [generationId, payload] of [
			[GENERATION_C, bytes(3)],
			[GENERATION_A, bytes(1)],
			[GENERATION_B, bytes(2)],
		] as const) {
			expect(
				await store.beginGeneration({
					baseExpectedHead: noHead(),
					closure: [ref(payload)],
					generationId,
					objectId: OBJECT_A,
				})
			).toMatchObject({ ok: true });
		}

		const first = await callSplitRead(store, "readGenerationPage", { objectId: OBJECT_A, limit: 2 });
		expect.soft(first).toMatchObject({
			ok: true,
			value: {
				generations: [{ generationId: GENERATION_A }, { generationId: GENERATION_B }],
			},
		});
		const firstValue = Reflect.get(first as object, "value") as object | undefined;
		const cursor = firstValue === undefined ? undefined : Reflect.get(firstValue, "nextCursor");
		expect.soft(typeof cursor).toBe("string");
		const firstRows = (firstValue === undefined ? undefined : Reflect.get(firstValue, "generations")) as
			| object[]
			| undefined;
		if (firstRows?.[0] !== undefined) Reflect.set(firstRows[0], "state", "Discarded");

		expect.soft(await callSplitRead(store, "readGenerationPage", { cursor, limit: 2, objectId: OBJECT_A })).toEqual({
			ok: true,
			value: {
				generations: [expect.objectContaining({ generationId: GENERATION_C, state: "Staged" })],
				nextCursor: null,
			},
		});
		expect.soft(await callSplitRead(store, "readGenerationPage", { objectId: OBJECT_A, limit: 1 })).toMatchObject({
			ok: true,
			value: { generations: [{ generationId: GENERATION_A, state: "Staged" }] },
		});
		expect.soft(await callSplitRead(store, "readGenerationPage", { cursor, limit: 2, objectId: OBJECT_B })).toEqual({
			ok: false,
			reason: "INVALID_ARGUMENT",
		});
		await store.close();
	});

	it("rejects every invalid limit or cursor before publishing a backend load", () => {
		for (const limit of [0, -1, 1.5, MAX_GENERATION_PAGE_ROWS + 1, Number.NaN]) {
			expect(prepared({ kind: "readGenerationPage", objectId: OBJECT_A, limit })).toEqual({
				ok: false,
				reason: "INVALID_ARGUMENT",
			});
		}
		for (const cursor of ["", "not-a-cursor", GENERATION_A, { objectId: OBJECT_A, generationId: GENERATION_A }]) {
			expect(prepared({ kind: "readGenerationPage", objectId: OBJECT_A, cursor, limit: 1 })).toEqual({
				ok: false,
				reason: "INVALID_ARGUMENT",
			});
		}
	});

	it("keeps public memory pages bounded without invoking the private broad mutation snapshot", async () => {
		const store = createMemoryAheDurableStore();
		const generationIds = Array.from({ length: MAX_GENERATION_PAGE_ROWS + 1 }, (_, index) => generationIdAt(index + 1));
		for (const generationId of generationIds) {
			const result = await store.beginGeneration({
				baseExpectedHead: noHead(),
				closure: [ref(bytes(1))],
				generationId,
				objectId: OBJECT_A,
			});
			if (!result.ok) throw new Error(`seed failed: ${result.reason}`);
		}

		const broadRead = vi.spyOn(TransitionOwner.prototype, "readObjectState").mockImplementation(() => {
			throw new Error("public bounded read invoked private broad state");
		});
		let publicReadError: unknown;
		try {
			expect.soft(await store.readHead(OBJECT_A)).toEqual({ ok: true, value: noHead() });
			const first = await store.readGenerationPage({ limit: MAX_GENERATION_PAGE_ROWS, objectId: OBJECT_A });
			if (!first.ok || first.value.nextCursor === null) throw new Error("expected bounded continuation cursor");
			expect.soft(first.value.generations).toHaveLength(MAX_GENERATION_PAGE_ROWS);
			expect.soft(first.value.generations[0]?.generationId).toBe(generationIds[0]);
			expect.soft(first.value.generations.at(-1)?.generationId).toBe(generationIds[MAX_GENERATION_PAGE_ROWS - 1]);
			expect
				.soft(
					await store.readGenerationPage({
						cursor: first.value.nextCursor,
						limit: MAX_GENERATION_PAGE_ROWS,
						objectId: OBJECT_A,
					})
				)
				.toEqual({
					ok: true,
					value: {
						generations: [expect.objectContaining({ generationId: generationIds[MAX_GENERATION_PAGE_ROWS] })],
						nextCursor: null,
					},
				});
			expect.soft(broadRead).not.toHaveBeenCalled();
		} catch (error) {
			publicReadError = error;
		} finally {
			broadRead.mockRestore();
			await store.close();
		}

		const mutationAuthority = new TransitionOwner("ephemeral");
		const internal = mutationAuthority.beginGeneration({
			baseExpectedHead: noHead(),
			closure: [ref(bytes(2))],
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		});
		expect.soft(internal.ok).toBe(true);
		expect.soft(mutationAuthority.readObjectState(OBJECT_A)).toMatchObject({
			ok: true,
			value: { generations: [{ generationId: GENERATION_A }] },
		});
		if (publicReadError !== undefined) throw publicReadError;
	});

	it("does not advertise independently fetched pages as one object snapshot", () => {
		const typeSource = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");
		expect.soft(typeSource).not.toContain("type ObjectStoreState");
		expect.soft(typeSource).not.toContain("readObjectState(");
		expect.soft(typeSource).not.toMatch(/(?:Object|Journal)Snapshot/u);
		expect.soft(typeSource).toContain("readHead(");
		expect.soft(typeSource).toContain("readGenerationPage(");
	});
});

describe("Phase 2e1 command-owned write RED", () => {
	it("emits one exact ordered write set for every successful command and zero writes on rejection", () => {
		const payload = bytes(1, 2, 3);
		const item = ref(payload);
		const staged = record({ closure: [item] });
		const adopted = record({ closure: [item], generationId: GENERATION_A, state: "Adopted" });
		const head = presentHead({ closureDigest: adopted.closureDigest });
		const candidate = record({
			baseExpectedHead: head,
			closure: [item],
			generationId: GENERATION_B,
			state: "Complete",
		});
		const facts = {
			empty: objectFact(noHead(), []),
			staged: objectFact(noHead(), [staged]),
			swap: objectFact(head, [adopted, candidate]),
		};
		const promotion: StorageAdapterFact = {
			digest: item.digest,
			generationId: GENERATION_A,
			kind: "promotion",
			objectId: OBJECT_A,
		};
		const scenarios = [
			{
				command: {
					baseExpectedHead: noHead(),
					closure: [item],
					generationId: GENERATION_A,
					kind: "beginGeneration",
					objectId: OBJECT_A,
				},
				facts: [facts.empty],
				writes: ["replace-generation"],
			},
			{
				command: {
					bytes: payload,
					digest: item.digest,
					generationId: GENERATION_A,
					kind: "putCachedBlob",
					objectId: OBJECT_A,
				},
				facts: [facts.staged, { bytes: null, digest: item.digest, kind: "blob" }],
				writes: ["insert-blob"],
			},
			{
				command: {
					digest: item.digest,
					generationId: GENERATION_A,
					kind: "promoteReference",
					objectId: OBJECT_A,
				},
				facts: [facts.staged, { bytes: payload, digest: item.digest, kind: "blob" }],
				writes: ["insert-promotion"],
			},
			{
				command: { generationId: GENERATION_A, kind: "completeGeneration", objectId: OBJECT_A },
				facts: [facts.staged, promotion],
				writes: ["replace-generation"],
			},
			{
				command: {
					expectedHead: head,
					generationId: GENERATION_B,
					kind: "swapHead",
					objectId: OBJECT_A,
				},
				facts: [facts.swap],
				writes: ["replace-generation", "replace-generation", "replace-head"],
			},
			{
				command: { generationId: GENERATION_A, kind: "discardGeneration", objectId: OBJECT_A },
				facts: [facts.staged],
				writes: ["replace-generation"],
			},
		] as const;

		for (const scenario of scenarios) {
			const command = prepareStorageAdapterCommand(scenario.command);
			if (!command.ok) throw new Error(`fixture failed preparation: ${command.reason}`);
			const accepted = evaluateStorageAdapterCommand(command.value, scenario.facts);
			expect.soft(accepted.result.ok, scenario.command.kind).toBe(true);
			expect.soft(writeKinds(accepted.writes), scenario.command.kind).toEqual(scenario.writes);
			const rejected = evaluateStorageAdapterCommand(command.value, [{ kind: "store-closed" }]);
			expect.soft(rejected, `${scenario.command.kind} rejection`).toEqual({
				result: { ok: false, reason: "STORE_CLOSED" },
				writes: [],
			});
		}
	});

	it("deletes the generic whole-state diff owner without replacing it with a test analyzer", () => {
		const source = readFileSync(new URL("../src/adapter.ts", import.meta.url), "utf8");
		expect.soft(source).not.toContain("appendStateWrites(");
		expect.soft(source).not.toMatch(/beforeState|afterState/u);
	});

	it("keeps the broad exactly-one-Adopted authority live for mutation facts", () => {
		const survivingAdopted = record({ generationId: GENERATION_A, state: "Adopted" });
		const command = prepareStorageAdapterCommand({
			baseExpectedHead: noHead(),
			closure: [ref(bytes(9))],
			generationId: GENERATION_B,
			kind: "beginGeneration",
			objectId: OBJECT_A,
		});
		if (!command.ok) throw new Error(`fixture failed preparation: ${command.reason}`);
		expect(evaluateStorageAdapterCommand(command.value, [objectFact(noHead(), [survivingAdopted])])).toEqual({
			result: { ok: false, reason: "INVALID_ARGUMENT" },
			writes: [],
		});
	});
});
