import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { bytes, GENERATION_A, GENERATION_B, must, noHead, OBJECT_A, presentHead, record, ref } from "./fixtures.js";
import { createTransitionHarness } from "./internal-harness.js";
import * as adapter from "../src/adapter.js";
import { encodeGenerationRecordV1 } from "../src/codecs.js";
import { createMemoryAheDurableStore, parseHeadRevision, type StoreResult } from "../src/index.js";

type RecoveryValue = Readonly<{
	kind: "active" | "empty";
	head: unknown;
	adoptedGeneration: unknown;
	recomputedClosureDigest: unknown;
	references: readonly unknown[];
}>;

type ClosureVerifierController = Readonly<{
	acceptBlob(session: unknown, bytes: Uint8Array | null): void;
	acceptPromotion(session: unknown, present: boolean): void;
	finish(session: unknown): StoreResult<unknown>;
	next(session: unknown): Readonly<{ kind: "blob" | "promotion"; reference: unknown }> | null;
	start(generation: unknown, mode: "adopted" | "candidate"): unknown;
}>;

function recover(target: object): StoreResult<RecoveryValue> {
	const method = Reflect.get(target, "recoverActiveGeneration");
	if (typeof method !== "function") {
		return { ok: false, reason: "SUBSTRATE_FAILURE", cause: "RECOVERY_NOT_IMPLEMENTED" };
	}
	return Reflect.apply(method, target, [OBJECT_A]) as StoreResult<RecoveryValue>;
}

async function recoverAsync(target: object): Promise<StoreResult<RecoveryValue>> {
	const method = Reflect.get(target, "recoverActiveGeneration");
	if (typeof method !== "function") {
		return { ok: false, reason: "SUBSTRATE_FAILURE", cause: "RECOVERY_NOT_IMPLEMENTED" };
	}
	return (await Reflect.apply(method, target, [OBJECT_A])) as StoreResult<RecoveryValue>;
}

function reason(result: StoreResult<unknown>): string {
	return result.ok ? "OK" : result.reason;
}

function assertAtomicAuthoritySource(source: string): void {
	for (const obsolete of ['kind: "object-state"', 'kind: "generation-closure"']) {
		if (source.includes(obsolete)) throw new Error(`obsolete authority remains: ${obsolete}`);
	}
	if (/kind:\s*["']verified["']/.test(source)) throw new Error("backend-forgeable verified fact remains");
	if (!source.includes("recoverActiveGeneration")) throw new Error("mandatory recovery owner is absent");
	if (!source.includes('kind: "generation"')) throw new Error("addressed generation owner is absent");
}

describe("Phase 2e3 shared recovery and authority flip RED", () => {
	it("publishes the exact bounded recovery method and no closure bytes", () => {
		const types = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");
		expect.soft(types).toContain("recoverActiveGeneration(objectId: StorageObjectId)");
		expect.soft(types).toContain('kind: "empty"');
		expect.soft(types).toContain('kind: "active"');
		expect.soft(types).not.toMatch(/Recovery[^;{]*bytes|Recovery[\s\S]{0,500}Uint8Array/);
	});

	it("returns the exact empty result from internal and public memory owners", async () => {
		const harness = createTransitionHarness();
		const expected = {
			ok: true,
			value: {
				kind: "empty",
				head: noHead(),
				adoptedGeneration: null,
				recomputedClosureDigest: null,
				references: [],
			},
		} as const;
		expect.soft(recover(harness)).toEqual(expected);
		const memory = createMemoryAheDurableStore();
		expect.soft(await recoverAsync(memory)).toEqual(expected);
		await memory.close();
	});

	it("returns detached verification-at-snapshot metadata for an active generation", () => {
		const payloads = [bytes(1, 2, 3), bytes(4, 5, 6)];
		const adopted = record({ closure: payloads.map(ref), state: "Adopted" });
		const head = presentHead({ closureDigest: adopted.closureDigest, revision: must(parseHeadRevision(5)) });
		const harness = createTransitionHarness();
		harness.seedObjectState({ head, generations: [adopted] });
		for (let index = 0; index < payloads.length; index++) {
			const payload = payloads[index];
			const reference = adopted.closure[index];
			if (payload === undefined || reference === undefined) throw new Error("fixture mismatch");
			harness.seedBlob(reference.digest, payload);
			harness.markPromoted(OBJECT_A, GENERATION_A, reference.digest);
		}

		const first = recover(harness);
		expect(first).toEqual({
			ok: true,
			value: {
				kind: "active",
				head,
				adoptedGeneration: adopted,
				recomputedClosureDigest: adopted.closureDigest,
				references: adopted.closure,
			},
		});
		if (first.ok) {
			try {
				(first.value.references as unknown[]).splice(0);
				(Reflect.get(first.value, "head") as { revision: number }).revision = 1;
			} catch {
				// A deeply frozen result is also detached from the retained authority.
			}
		}
		expect(recover(harness)).toEqual({
			ok: true,
			value: {
				kind: "active",
				head,
				adoptedGeneration: adopted,
				recomputedClosureDigest: adopted.closureDigest,
				references: adopted.closure,
			},
		});
	});

	it("reproduces the bounded-only revision-reset mutant and requires recovery to kill it", () => {
		const adopted = record({ state: "Adopted" });
		const head = presentHead({ closureDigest: adopted.closureDigest, revision: must(parseHeadRevision(5)) });
		const candidate = record({ generationId: GENERATION_B, state: "Complete" });

		// Executable mutant: a bounded-only evaluator sees no head and only G2. It
		// accepts and resets revision to one, exactly the unsafe 2e counterexample.
		const boundedOnly = createTransitionHarness();
		boundedOnly.seedObjectState({ head: noHead(), generations: [candidate] });
		const unsafe = boundedOnly.swapHead({ objectId: OBJECT_A, generationId: GENERATION_B, expectedHead: noHead() });
		expect(unsafe).toMatchObject({ ok: true, value: { head: { generationId: GENERATION_B, revision: 1 } } });

		const corruptedFullState = createTransitionHarness();
		corruptedFullState.seedObjectState({ head: noHead(), generations: [adopted, candidate] });
		expect(reason(recover(corruptedFullState))).toBe("NON_CANONICAL_RECORD");
		expect(
			corruptedFullState.swapHead({ objectId: OBJECT_A, generationId: GENERATION_B, expectedHead: noHead() })
		).toEqual({ ok: false, reason: "NON_CANONICAL_RECORD" });

		// The intact rev-5 state is a positive control for the reproduced lineage.
		const intact = createTransitionHarness();
		intact.seedObjectState({ head, generations: [adopted, candidate] });
		expect(intact.readObjectState(OBJECT_A)).toMatchObject({ ok: true, value: { head: { revision: 5 } } });
	});

	it("rechecks promoted candidate bytes in canonical order before completion", () => {
		const payloads = [bytes(7, 8, 9), bytes(10, 11, 12)];
		const references = payloads.map(ref);
		const firstReference = references[0];
		const secondReference = references[1];
		const secondPayload = payloads[1];
		if (firstReference === undefined || secondReference === undefined || secondPayload === undefined) {
			throw new Error("two-reference fixture mismatch");
		}
		const harness = createTransitionHarness();
		harness.seedObjectState({ head: noHead(), generations: [record({ closure: references })] });
		for (const reference of references) harness.markPromoted(OBJECT_A, GENERATION_A, reference.digest);
		harness.seedBlob(secondReference.digest, secondPayload);
		expect(reason(harness.completeGeneration({ objectId: OBJECT_A, generationId: GENERATION_A }))).toBe("BLOB_MISSING");

		const lengthFirst = createTransitionHarness();
		lengthFirst.seedObjectState({ head: noHead(), generations: [record({ closure: references })] });
		for (const reference of references) lengthFirst.markPromoted(OBJECT_A, GENERATION_A, reference.digest);
		lengthFirst.seedBlob(firstReference.digest, bytes(1));
		lengthFirst.seedBlob(secondReference.digest, secondPayload);
		expect(reason(lengthFirst.completeGeneration({ objectId: OBJECT_A, generationId: GENERATION_A }))).toBe(
			"BLOB_CORRUPT"
		);
	});

	it("publishes one runtime-neutral verifier controller and opaque candidate authorization", () => {
		const controller = Reflect.get(adapter, "storageAdapterClosureVerifier") as ClosureVerifierController | undefined;
		expect(controller).toBeDefined();
		if (controller === undefined) return;
		expect(Object.keys(controller).sort()).toEqual(["acceptBlob", "acceptPromotion", "finish", "next", "start"]);

		const payloads = [bytes(1, 2, 3), bytes(4, 5, 6)];
		const generation = record({ closure: payloads.map(ref) });
		const session = controller.start(generation, "candidate");
		for (let index = 0; index < payloads.length; index++) {
			expect.soft(controller.next(session)).toEqual({ kind: "promotion", reference: generation.closure[index] });
			controller.acceptPromotion(session, true);
			expect.soft(controller.next(session)).toEqual({ kind: "blob", reference: generation.closure[index] });
			controller.acceptBlob(session, payloads[index] ?? null);
		}
		expect.soft(controller.next(session)).toBeNull();
		const authorization = controller.finish(session);
		expect.soft(authorization.ok).toBe(true);

		const prepared = adapter.prepareStorageAdapterCommand({
			generationId: GENERATION_A,
			kind: "completeGeneration",
			objectId: OBJECT_A,
		});
		if (!prepared.ok || !authorization.ok) return;
		const facts = [
			{
				generationId: GENERATION_A,
				generationRecord: encodeGenerationRecordV1(generation),
				kind: "generation",
				objectId: OBJECT_A,
			},
		];
		const evaluate = adapter.evaluateStorageAdapterCommand as unknown as (
			command: unknown,
			loaded: readonly unknown[],
			authorization?: unknown
		) => unknown;
		expect.soft(evaluate(prepared.value, facts, authorization.value)).toMatchObject({
			result: { ok: true, value: { state: "Complete" } },
			writes: [{ kind: "replace-generation" }],
		});
		expect.soft(evaluate(prepared.value, facts, Object.freeze({}))).toEqual({
			result: { ok: false, reason: "INVALID_ARGUMENT" },
			writes: [],
		});
	});

	it("rejects dual, batch and forgeable authority forms with a deterministic mutant control", () => {
		const safeShape = `recoverActiveGeneration\nkind: "head"\nkind: "generation"\nkind: "generation-page"\nkind: "promotion"\nkind: "blob"`;
		expect(() => assertAtomicAuthoritySource(safeShape)).not.toThrow();
		expect(() => assertAtomicAuthoritySource(safeShape.replace('kind: "generation"', ""))).toThrow(/addressed/);
		expect(() => assertAtomicAuthoritySource(`${safeShape}\nkind: "verified"`)).toThrow(/forgeable/);
		expect(() => assertAtomicAuthoritySource(`${safeShape}\nkind: "object-state"`)).toThrow(/obsolete/);

		const adapter = readFileSync(new URL("../src/adapter.ts", import.meta.url), "utf8");
		expect(() => assertAtomicAuthoritySource(adapter)).not.toThrow();
		let verifier = "";
		try {
			verifier = readFileSync(new URL("../src/internal/closure-verifier.ts", import.meta.url), "utf8");
		} catch {
			// The unchanged RED has no shared verifier owner yet.
		}
		expect.soft(verifier).toContain("digestBlob(");
		expect.soft(verifier).not.toMatch(/\basync\b|\bPromise\b/);
	});
});
