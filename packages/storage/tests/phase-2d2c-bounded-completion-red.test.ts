import { describe, expect, it } from "vitest";

import { bytes, GENERATION_A, noHead, OBJECT_A, record, ref } from "./fixtures.js";
import { createTransitionHarness } from "./internal-harness.js";
import type { StoreResult } from "../src/types.js";

function reason(result: StoreResult<unknown>): string {
	return result.ok ? "OK" : result.reason;
}

describe("Phase 2d2c bounded closure completion RED", () => {
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
		{ cache: "missing", bytes: undefined, expected: "BLOB_MISSING" },
		{ cache: "wrong length", bytes: bytes(99), expected: "BLOB_CORRUPT" },
		{ cache: "wrong digest", bytes: bytes(99, 98, 97), expected: "BLOB_CORRUPT" },
	] as const)(
		"rechecks recorded promotion evidence and rejects when cached bytes later become $cache",
		({ bytes: cached, expected }) => {
			const payload = bytes(10, 11, 12);
			const reference = ref(payload);
			const harness = createTransitionHarness();
			harness.seedObjectState({ head: noHead(), generations: [record({ closure: [reference] })] });
			harness.markPromoted(OBJECT_A, GENERATION_A, reference.digest);
			if (cached !== undefined) harness.seedBlob(reference.digest, cached);
			const before = harness.readObjectState(OBJECT_A);

			expect(reason(harness.completeGeneration({ objectId: OBJECT_A, generationId: GENERATION_A }))).toBe(expected);
			expect(harness.readObjectState(OBJECT_A)).toEqual(before);
		}
	);

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
