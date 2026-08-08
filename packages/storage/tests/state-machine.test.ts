import { describe, expect, it } from "vitest";

import {
	bytes,
	GENERATION_A,
	GENERATION_B,
	GENERATION_C,
	must,
	noHead,
	OBJECT_A,
	OBJECT_B,
	presentHead,
	record,
	ref,
} from "./fixtures.js";
import { createTransitionHarness } from "./internal-harness.js";
import {
	digestClosure,
	type GenerationRecord,
	type GenerationState,
	parseHeadRevision,
	type StoreResult,
} from "../src/index.js";

function reasonOf(result: StoreResult<unknown>): string {
	return result.ok ? "OK" : result.reason;
}

function stateOf(result: StoreResult<GenerationRecord>): GenerationState | undefined {
	return result.ok ? result.value.state : undefined;
}

describe("Phase 2a five-state journal", () => {
	it("keeps absent -> Staged as a non-vacuous positive control", () => {
		const harness = createTransitionHarness();
		const result = harness.beginGeneration({
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			baseExpectedHead: noHead(),
			closure: [ref(bytes(1))],
		});
		expect(stateOf(result)).toBe("Staged");
	});

	it("rejects empty before duplicate closure references and preserves state", () => {
		const harness = createTransitionHarness();
		const before = harness.readObjectState(OBJECT_A);
		const empty = harness.beginGeneration({
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			baseExpectedHead: noHead(),
			closure: [],
		});
		expect(reasonOf(empty)).toBe("EMPTY_CLOSURE");
		expect(harness.readObjectState(OBJECT_A)).toEqual(before);

		const duplicateRef = ref(bytes(1));
		const duplicate = harness.beginGeneration({
			objectId: OBJECT_A,
			generationId: GENERATION_B,
			baseExpectedHead: noHead(),
			closure: [duplicateRef, duplicateRef],
		});
		expect(reasonOf(duplicate)).toBe("DUPLICATE_CLOSURE_REFERENCE");
		expect(harness.readObjectState(OBJECT_A)).toEqual(before);
	});

	it.each(["Staged", "Complete", "Adopted", "Superseded", "Discarded"] as const)(
		"never reuses an extant %s generation key, even for equal/substitute/extra input",
		(state) => {
			const harness = createTransitionHarness();
			const existing = record({ state });
			harness.seedObjectState({ head: noHead(), generations: [existing] });
			for (const closure of [existing.closure, [ref(bytes(2))], [...existing.closure, ref(bytes(3))]]) {
				const before = harness.readObjectState(OBJECT_A);
				const result = harness.beginGeneration({
					objectId: OBJECT_A,
					generationId: GENERATION_A,
					baseExpectedHead: noHead(),
					closure,
				});
				expect(reasonOf(result)).toBe("GENERATION_EXISTS");
				expect(harness.readObjectState(OBJECT_A)).toEqual(before);
			}
		}
	);

	it("completes a three-reference Staged generation with genuine modeled promotion", () => {
		const harness = createTransitionHarness();
		const payloads = [bytes(1), bytes(2), bytes(3)];
		const closure = payloads.map(ref);
		harness.seedObjectState({ head: noHead(), generations: [record({ closure })] });
		for (let index = 0; index < closure.length; index++) {
			const item = closure[index];
			const payload = payloads[index];
			if (item === undefined || payload === undefined) throw new Error("fixture mismatch");
			harness.seedBlob(item.digest, payload);
			harness.markPromoted(OBJECT_A, GENERATION_A, item.digest);
		}
		expect(stateOf(harness.completeGeneration({ objectId: OBJECT_A, generationId: GENERATION_A }))).toBe("Complete");
	});

	it("accepts declared cache, idempotent promotion, and both legal discard edges", () => {
		const item = ref(bytes(1));
		for (const state of ["Staged", "Complete"] as const) {
			const harness = createTransitionHarness();
			harness.seedObjectState({ head: noHead(), generations: [record({ state, closure: [item] })] });
			if (state === "Staged") {
				expect(
					harness.putCachedBlob({
						objectId: OBJECT_A,
						generationId: GENERATION_A,
						digest: item.digest,
						bytes: bytes(1),
					})
				).toEqual({ ok: true, value: { inserted: true } });
				expect(
					harness.promoteReference({ objectId: OBJECT_A, generationId: GENERATION_A, digest: item.digest })
				).toEqual({ ok: true, value: undefined });
				expect(
					harness.promoteReference({ objectId: OBJECT_A, generationId: GENERATION_A, digest: item.digest })
				).toEqual({ ok: true, value: undefined });
			}
			expect(stateOf(harness.discardGeneration({ objectId: OBJECT_A, generationId: GENERATION_A }))).toBe("Discarded");
		}
	});

	it("rejects a three-reference completion when one reference is unpromoted", () => {
		const harness = createTransitionHarness();
		const payloads = [bytes(1), bytes(2), bytes(3)];
		const closure = payloads.map(ref).sort((left, right) => left.digest.localeCompare(right.digest));
		harness.seedObjectState({ head: noHead(), generations: [record({ closure })] });
		for (let index = 0; index < closure.length; index++) {
			const item = closure[index];
			if (item === undefined) throw new Error("fixture mismatch");
			const payload = payloads.find((value) => ref(value).digest === item.digest);
			if (payload === undefined) throw new Error("fixture mismatch");
			harness.seedBlob(item.digest, payload);
			if (index !== 1) harness.markPromoted(OBJECT_A, GENERATION_A, item.digest);
		}
		const before = harness.readObjectState(OBJECT_A);
		const result = harness.completeGeneration({ objectId: OBJECT_A, generationId: GENERATION_A });
		expect(reasonOf(result)).toBe("BLOB_UNPROMOTED");
		expect(harness.readObjectState(OBJECT_A)).toEqual(before);
	});

	it.each(["Complete", "Adopted", "Superseded", "Discarded"] as const)("rejects Complete from %s", (state) => {
		const harness = createTransitionHarness();
		harness.seedObjectState({ head: noHead(), generations: [record({ state })] });
		const before = harness.readObjectState(OBJECT_A);
		expect(reasonOf(harness.completeGeneration({ objectId: OBJECT_A, generationId: GENERATION_A }))).toBe(
			"ILLEGAL_TRANSITION"
		);
		expect(harness.readObjectState(OBJECT_A)).toEqual(before);
	});

	it.each(["Adopted", "Superseded", "Discarded"] as const)("rejects discard from terminal %s", (state) => {
		const harness = createTransitionHarness();
		harness.seedObjectState({ head: noHead(), generations: [record({ state })] });
		const before = harness.readObjectState(OBJECT_A);
		expect(reasonOf(harness.discardGeneration({ objectId: OBJECT_A, generationId: GENERATION_A }))).toBe(
			"ILLEGAL_TRANSITION"
		);
		expect(harness.readObjectState(OBJECT_A)).toEqual(before);
	});

	it.each(["Staged", "Adopted", "Superseded", "Discarded"] as const)("rejects adoption from %s", (state) => {
		const harness = createTransitionHarness();
		harness.seedObjectState({ head: noHead(), generations: [record({ state })] });
		const before = harness.readObjectState(OBJECT_A);
		expect(reasonOf(harness.swapHead({ objectId: OBJECT_A, generationId: GENERATION_A, expectedHead: noHead() }))).toBe(
			"CANDIDATE_NOT_COMPLETE"
		);
		expect(harness.readObjectState(OBJECT_A)).toEqual(before);
	});

	it.each(["Complete", "Adopted", "Superseded", "Discarded"] as const)(
		"rejects cache and promotion mutation outside Staged from %s",
		(state) => {
			const harness = createTransitionHarness();
			const item = ref(bytes(1));
			harness.seedObjectState({ head: noHead(), generations: [record({ state, closure: [item] })] });
			const before = harness.readObjectState(OBJECT_A);
			expect(
				reasonOf(
					harness.putCachedBlob({
						objectId: OBJECT_A,
						generationId: GENERATION_A,
						digest: item.digest,
						bytes: bytes(1),
					})
				)
			).toBe("ILLEGAL_TRANSITION");
			expect(harness.getBlob(item.digest)).toEqual({ ok: true, value: null });
			expect(
				reasonOf(harness.promoteReference({ objectId: OBJECT_A, generationId: GENERATION_A, digest: item.digest }))
			).toBe("ILLEGAL_TRANSITION");
			expect(harness.readObjectState(OBJECT_A)).toEqual(before);
		}
	);
});

describe("Phase 2a head CAS and atomicity", () => {
	it("exact none-head swap succeeds at revision 1", () => {
		const harness = createTransitionHarness();
		harness.seedObjectState({ head: noHead(), generations: [record({ state: "Complete" })] });
		const result = harness.swapHead({ objectId: OBJECT_A, generationId: GENERATION_A, expectedHead: noHead() });
		expect(result).toMatchObject({ ok: true, value: { head: { revision: 1 }, supersededGenerationId: null } });
	});

	it("exact present-head swap supersedes the former generation", () => {
		const harness = createTransitionHarness();
		const previous = record({ state: "Adopted", generationId: GENERATION_A });
		const head = presentHead({ generationId: GENERATION_A, closureDigest: previous.closureDigest });
		const next = record({
			state: "Complete",
			generationId: GENERATION_B,
			baseExpectedHead: head,
		});
		harness.seedObjectState({ head, generations: [previous, next] });
		const result = harness.swapHead({ objectId: OBJECT_A, generationId: GENERATION_B, expectedHead: head });
		expect(result).toMatchObject({
			ok: true,
			value: { head: { revision: 2, generationId: GENERATION_B }, supersededGenerationId: GENERATION_A },
		});
		const state = harness.readObjectState(OBJECT_A);
		expect(state.ok && state.value.generations.map(({ generationId, state }) => [generationId, state])).toEqual([
			[GENERATION_A, "Superseded"],
			[GENERATION_B, "Adopted"],
		]);
	});

	it("rejects stale and none-vs-present expected heads without mutation", () => {
		const harness = createTransitionHarness();
		const old = record({ state: "Adopted" });
		const current = presentHead({ closureDigest: old.closureDigest });
		const candidate = record({ state: "Complete", generationId: GENERATION_B, baseExpectedHead: current });
		harness.seedObjectState({ head: current, generations: [old, candidate] });
		for (const expectedHead of [noHead(), { ...current, revision: must(parseHeadRevision(2)) }]) {
			const before = harness.readObjectState(OBJECT_A);
			const result = harness.swapHead({ objectId: OBJECT_A, generationId: GENERATION_B, expectedHead });
			expect(reasonOf(result)).toBe("HEAD_CONFLICT");
			expect(harness.readObjectState(OBJECT_A)).toEqual(before);
		}
	});

	it("rejects captured-base mismatch after the request matches the current head", () => {
		const harness = createTransitionHarness();
		const old = record({ state: "Adopted" });
		const current = presentHead({ closureDigest: old.closureDigest });
		const candidate = record({ state: "Complete", generationId: GENERATION_B, baseExpectedHead: noHead() });
		harness.seedObjectState({ head: current, generations: [old, candidate] });
		const before = harness.readObjectState(OBJECT_A);
		expect(reasonOf(harness.swapHead({ objectId: OBJECT_A, generationId: GENERATION_B, expectedHead: current }))).toBe(
			"BASE_HEAD_MISMATCH"
		);
		expect(harness.readObjectState(OBJECT_A)).toEqual(before);
	});

	it("rejects cross-object embedded heads as INVALID_ARGUMENT before lookup", () => {
		const harness = createTransitionHarness();
		const foreignHead = noHead(OBJECT_B);
		const result = harness.beginGeneration({
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			baseExpectedHead: foreignHead,
			closure: [ref(bytes(1))],
		});
		expect(reasonOf(result)).toBe("INVALID_ARGUMENT");
		expect(harness.readObjectState(OBJECT_A)).toEqual({
			ok: true,
			value: { head: noHead(), generations: [] },
		});
	});

	it("linearizes competing exact-CAS swaps with one winner", async () => {
		const harness = createTransitionHarness();
		harness.seedObjectState({
			head: noHead(),
			generations: [
				record({ state: "Complete", generationId: GENERATION_A }),
				record({ state: "Complete", generationId: GENERATION_B }),
			],
		});
		const outcomes = await Promise.all(
			[GENERATION_A, GENERATION_B].map((generationId) =>
				harness.swapHead({ objectId: OBJECT_A, generationId, expectedHead: noHead() })
			)
		);
		expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
		expect(outcomes.filter((result) => reasonOf(result) === "HEAD_CONFLICT")).toHaveLength(1);
		const final = harness.readObjectState(OBJECT_A);
		expect(final.ok && final.value.generations.filter(({ state }) => state === "Adopted")).toHaveLength(1);
		expect(final.ok && final.value.generations.filter(({ state }) => state === "Complete")).toHaveLength(1);
	});

	it("rejects maximum-revision increment without wrap or mutation", () => {
		const harness = createTransitionHarness();
		const old = record({ state: "Adopted" });
		const maxHead = presentHead({
			closureDigest: old.closureDigest,
			revision: must(parseHeadRevision(Number.MAX_SAFE_INTEGER)),
		});
		const candidate = record({ state: "Complete", generationId: GENERATION_B, baseExpectedHead: maxHead });
		harness.seedObjectState({ head: maxHead, generations: [old, candidate] });
		const before = harness.readObjectState(OBJECT_A);
		expect(reasonOf(harness.swapHead({ objectId: OBJECT_A, generationId: GENERATION_B, expectedHead: maxHead }))).toBe(
			"REVISION_EXHAUSTED"
		);
		expect(harness.readObjectState(OBJECT_A)).toEqual(before);
	});
});

describe("Phase 2a ref-major precedence", () => {
	it("reports a lower-digest unpromoted ref before a higher-digest missing ref", () => {
		const harness = createTransitionHarness();
		const closure = [ref(bytes(10)), ref(bytes(20)), ref(bytes(30))].sort((left, right) =>
			left.digest.localeCompare(right.digest)
		);
		const lower = closure[0];
		const middle = closure[1];
		if (lower === undefined || middle === undefined) throw new Error("fixture mismatch");
		harness.seedObjectState({ head: noHead(), generations: [record({ closure })] });
		harness.seedBlob(lower.digest, bytes(10));
		harness.seedBlob(middle.digest, bytes(20));
		harness.markPromoted(OBJECT_A, GENERATION_A, middle.digest);
		const before = harness.readObjectState(OBJECT_A);
		const result = harness.completeGeneration({ objectId: OBJECT_A, generationId: GENERATION_A });
		expect(reasonOf(result)).toBe("BLOB_UNPROMOTED");
		expect(harness.readObjectState(OBJECT_A)).toEqual(before);
	});

	it.each([
		{ cache: "missing", bytes: undefined },
		{ cache: "corrupt", bytes: bytes(9) },
		{ cache: "valid", bytes: bytes(1) },
	] as const)(
		"returns BLOB_UNPROMOTED when promotion evidence is absent and cached bytes are $cache",
		({ bytes: cacheBytes }) => {
			const item = ref(bytes(1));
			const harness = createTransitionHarness();
			harness.seedObjectState({ head: noHead(), generations: [record({ closure: [item] })] });
			if (cacheBytes !== undefined) harness.seedBlob(item.digest, cacheBytes);
			const before = harness.readObjectState(OBJECT_A);
			const result = harness.completeGeneration({ objectId: OBJECT_A, generationId: GENERATION_A });
			expect(reasonOf(result)).toBe("BLOB_UNPROMOTED");
			expect(harness.readObjectState(OBJECT_A)).toEqual(before);
		}
	);

	it("keeps closure digest captured at begin instead of accepting a substitute", () => {
		const harness = createTransitionHarness();
		const closure = [ref(bytes(1))];
		const begun = harness.beginGeneration({
			objectId: OBJECT_A,
			generationId: GENERATION_C,
			baseExpectedHead: noHead(),
			closure,
		});
		if (!begun.ok) throw new Error("positive begin failed");
		const expectedDigest = must(digestClosure(closure));
		closure.push(ref(bytes(2)));
		const state = harness.readObjectState(OBJECT_A);
		expect(state.ok && state.value.generations[0]?.closureDigest).toBe(expectedDigest);
		expect(state.ok && state.value.generations[0]?.closure).toHaveLength(1);
	});
});
