import { describe, expect, it } from "vitest";

import { bytes, must, OBJECT_A, presentHead, record, ref } from "./fixtures.js";
import { createTransitionHarness } from "./internal-harness.js";
import type { GenerationId, GenerationRecord } from "../src/types.js";
import { parseGenerationId } from "../src/values.js";

const JOURNAL_ROWS = 320;

function generationIdAt(index: number): GenerationId {
	return must(parseGenerationId(index.toString(16).padStart(64, "0")));
}

function generationRecords(adoptedIndexes: ReadonlySet<number>): GenerationRecord[] {
	return Array.from({ length: JOURNAL_ROWS }, (_, offset) => {
		const index = offset + 1;
		return record({
			generationId: generationIdAt(index),
			state: adoptedIndexes.has(index) ? "Adopted" : "Staged",
		});
	});
}

/**
 * Replaces retained generation rows with transparent probes after fixture
 * seeding, without adding a production instrumentation surface.
 * @param harness - Package-internal transition owner under test.
 * @returns The generation IDs whose closure payload was materialized.
 */
function observeClosureReads(harness: object): Set<GenerationId> {
	const objects = Reflect.get(harness, "objects") as unknown;
	if (!(objects instanceof Map)) throw new Error("transition object registry is unavailable");
	const retainedObject = (objects as Map<unknown, unknown>).get(OBJECT_A);
	if (typeof retainedObject !== "object" || retainedObject === null) {
		throw new Error("seeded transition object is unavailable");
	}
	const generations = Reflect.get(retainedObject, "generations") as unknown;
	if (!(generations instanceof Map)) throw new Error("retained generation registry is unavailable");

	const closureReads = new Set<GenerationId>();
	for (const [key, value] of generations as Map<unknown, unknown>) {
		if (typeof key !== "string" || typeof value !== "object" || value === null) {
			throw new Error("unexpected retained generation shape");
		}
		const generationId = must(parseGenerationId(key));
		generations.set(
			key,
			new Proxy(value, {
				get(target, property, receiver): unknown {
					if (property === "closure") closureReads.add(generationId);
					return Reflect.get(target, property, receiver);
				},
			})
		);
	}
	return closureReads;
}

describe("Phase 2e3 recovery transient-memory bound RED", () => {
	it("walks the full journal but materializes only the late sole adopted closure", () => {
		const adoptedGenerationId = generationIdAt(JOURNAL_ROWS);
		const generations = generationRecords(new Set([JOURNAL_ROWS]));
		const payload = bytes(1);
		const reference = ref(payload);
		const adoptedWithKnownPayload = record({
			closure: [reference],
			generationId: adoptedGenerationId,
			state: "Adopted",
		});
		generations[JOURNAL_ROWS - 1] = adoptedWithKnownPayload;

		const harness = createTransitionHarness();
		harness.seedObjectState({
			head: presentHead({
				closureDigest: adoptedWithKnownPayload.closureDigest,
				generationId: adoptedGenerationId,
			}),
			generations,
		});
		harness.seedBlob(reference.digest, payload);
		harness.markPromoted(OBJECT_A, adoptedGenerationId, reference.digest);
		const closureReads = observeClosureReads(harness);

		const recovered = harness.recoverActiveGeneration(OBJECT_A);
		expect(recovered).toMatchObject({
			ok: true,
			value: {
				adoptedGeneration: { generationId: adoptedGenerationId },
				kind: "active",
				references: [reference],
			},
		});
		expect(closureReads.size).toBe(1);
		expect(closureReads.has(adoptedGenerationId)).toBe(true);
	});

	it("finds a second late adopted row without materializing any closure", () => {
		const firstAdoptedId = generationIdAt(1);
		const generations = generationRecords(new Set([1, JOURNAL_ROWS]));
		const firstAdopted = generations[0];
		if (firstAdopted === undefined) throw new Error("first adopted fixture is unavailable");
		const harness = createTransitionHarness();
		harness.seedObjectState({
			head: presentHead({ closureDigest: firstAdopted.closureDigest, generationId: firstAdoptedId }),
			generations,
		});
		const closureReads = observeClosureReads(harness);

		expect(harness.recoverActiveGeneration(OBJECT_A)).toEqual({ ok: false, reason: "NON_CANONICAL_RECORD" });
		expect(closureReads.size).toBe(0);
		expect(harness.readObjectState(OBJECT_A)).toEqual({ ok: false, reason: "STORE_POISONED" });
	});
});
