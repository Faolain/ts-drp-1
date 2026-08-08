import { describe, expect, it } from "vitest";

import { bytes, GENERATION_A, noHead, OBJECT_A, record, ref } from "./fixtures.js";
import { createTransitionHarness } from "./internal-harness.js";
import {
	evaluateStorageAdapterCommand,
	prepareStorageAdapterCommand,
	type StorageAdapterFact,
} from "../src/adapter.js";
import { encodeGenerationRecordV1 } from "../src/codecs.js";
import type { GenerationRecord, StoreResult } from "../src/types.js";

function reason(result: StoreResult<unknown>): string {
	return result.ok ? "OK" : result.reason;
}

function objectFact(generation: GenerationRecord): StorageAdapterFact {
	return {
		kind: "object-state",
		objectId: OBJECT_A,
		headRecord: null,
		generationRecords: [encodeGenerationRecordV1(generation)],
	};
}

function promotion(digest: GenerationRecord["closure"][number]["digest"]): StorageAdapterFact {
	return { kind: "promotion", objectId: OBJECT_A, generationId: GENERATION_A, digest };
}

describe("Phase 2d2c bounded closure completion RED", () => {
	it("accepts exact object and promotion facts with zero blob values", () => {
		const payloads = [bytes(1, 2, 3), bytes(4, 5, 6)];
		const generation = record({ closure: payloads.map(ref) });
		const prepared = prepareStorageAdapterCommand({
			kind: "completeGeneration",
			objectId: OBJECT_A,
			generationId: GENERATION_A,
		});
		if (!prepared.ok) throw new Error(`completion preparation failed: ${prepared.reason}`);
		const exactFacts = [objectFact(generation), ...generation.closure.map(({ digest }) => promotion(digest))];
		const completed = { ...generation, state: "Complete" as const };

		expect(evaluateStorageAdapterCommand(prepared.value, exactFacts)).toEqual({
			result: { ok: true, value: completed },
			writes: [
				{
					kind: "replace-generation",
					objectId: OBJECT_A,
					generationId: GENERATION_A,
					record: encodeGenerationRecordV1(completed),
				},
			],
		});
	});

	it("rejects an over-supplied closure blob fact set", () => {
		const payloads = [bytes(1, 2, 3), bytes(4, 5, 6)];
		const generation = record({ closure: payloads.map(ref) });
		const prepared = prepareStorageAdapterCommand({
			kind: "completeGeneration",
			objectId: OBJECT_A,
			generationId: GENERATION_A,
		});
		if (!prepared.ok) throw new Error(`completion preparation failed: ${prepared.reason}`);
		const facts: StorageAdapterFact[] = [
			objectFact(generation),
			...generation.closure.map(({ digest }) => promotion(digest)),
			...generation.closure.map((reference) => {
				const payload = payloads.find((candidate) => ref(candidate).digest === reference.digest);
				if (payload === undefined) throw new Error("closure fixture mismatch");
				return { kind: "blob" as const, digest: reference.digest, bytes: payload };
			}),
		];

		expect(evaluateStorageAdapterCommand(prepared.value, facts)).toEqual({
			result: { ok: false, reason: "INVALID_ARGUMENT" },
			writes: [],
		});
	});

	it("returns BLOB_UNPROMOTED from promotion-only facts when one closure promotion is absent", () => {
		const generation = record({ closure: [ref(bytes(1, 2, 3)), ref(bytes(4, 5, 6))] });
		const prepared = prepareStorageAdapterCommand({
			kind: "completeGeneration",
			objectId: OBJECT_A,
			generationId: GENERATION_A,
		});
		if (!prepared.ok) throw new Error(`completion preparation failed: ${prepared.reason}`);
		const first = generation.closure[0];
		if (first === undefined) throw new Error("closure fixture mismatch");

		expect(evaluateStorageAdapterCommand(prepared.value, [objectFact(generation), promotion(first.digest)])).toEqual({
			result: { ok: false, reason: "BLOB_UNPROMOTED" },
			writes: [],
		});
	});

	it.each([
		{ cache: "missing", bytes: undefined },
		{ cache: "corrupt", bytes: bytes(99) },
	] as const)("classifies absent promotion as BLOB_UNPROMOTED when cached bytes are $cache", ({ bytes: cached }) => {
		const payload = bytes(7, 8, 9);
		const reference = ref(payload);
		const harness = createTransitionHarness();
		harness.seedObjectState({ head: noHead(), generations: [record({ closure: [reference] })] });
		if (cached !== undefined) harness.seedBlob(reference.digest, cached);
		const before = harness.readObjectState(OBJECT_A);

		expect(reason(harness.completeGeneration({ objectId: OBJECT_A, generationId: GENERATION_A }))).toBe(
			"BLOB_UNPROMOTED"
		);
		expect(harness.readObjectState(OBJECT_A)).toEqual(before);
	});

	it.each([
		{ cache: "missing", bytes: undefined },
		{ cache: "corrupt", bytes: bytes(99) },
	] as const)("trusts recorded promotion evidence when cached bytes later become $cache", ({ bytes: cached }) => {
		const payload = bytes(10, 11, 12);
		const reference = ref(payload);
		const harness = createTransitionHarness();
		harness.seedObjectState({ head: noHead(), generations: [record({ closure: [reference] })] });
		harness.markPromoted(OBJECT_A, GENERATION_A, reference.digest);
		if (cached !== undefined) harness.seedBlob(reference.digest, cached);

		expect(harness.completeGeneration({ objectId: OBJECT_A, generationId: GENERATION_A })).toMatchObject({
			ok: true,
			value: { state: "Complete" },
		});
	});

	it("keeps promoteReference as the exact missing and corrupt blob owner", () => {
		const payload = bytes(13, 14, 15);
		const reference = ref(payload);
		const missing = createTransitionHarness();
		missing.seedObjectState({ head: noHead(), generations: [record({ closure: [reference] })] });
		expect(
			reason(missing.promoteReference({ objectId: OBJECT_A, generationId: GENERATION_A, digest: reference.digest }))
		).toBe("BLOB_MISSING");

		const corrupt = createTransitionHarness();
		corrupt.seedObjectState({ head: noHead(), generations: [record({ closure: [reference] })] });
		corrupt.seedBlob(reference.digest, bytes(99));
		expect(
			reason(corrupt.promoteReference({ objectId: OBJECT_A, generationId: GENERATION_A, digest: reference.digest }))
		).toBe("BLOB_CORRUPT");

		const valid = createTransitionHarness();
		valid.seedObjectState({ head: noHead(), generations: [record({ closure: [reference] })] });
		valid.seedBlob(reference.digest, payload);
		expect(
			valid.promoteReference({ objectId: OBJECT_A, generationId: GENERATION_A, digest: reference.digest })
		).toEqual({
			ok: true,
			value: undefined,
		});
	});
});
