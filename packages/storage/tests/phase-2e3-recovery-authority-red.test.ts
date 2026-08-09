import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
	bytes,
	GENERATION_A,
	GENERATION_B,
	must,
	noHead,
	OBJECT_A,
	OBJECT_B,
	presentHead,
	record,
	ref,
} from "./fixtures.js";
import { createTransitionHarness } from "./internal-harness.js";
import * as adapter from "../src/adapter.js";
import { decodeGenerationRecordV1, encodeGenerationRecordV1 } from "../src/codecs.js";
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
		const payloads = [bytes(1, 2, 3), bytes(4, 5, 6)];
		const callerGeneration = record({ closure: payloads.map(ref) });
		const canonicalBytes = encodeGenerationRecordV1(callerGeneration);
		const independentlyDecoded = decodeGenerationRecordV1(new Uint8Array(canonicalBytes));
		if (!independentlyDecoded.ok) throw new Error(`canonical fixture failed decode: ${independentlyDecoded.reason}`);
		const canonicalGeneration = independentlyDecoded.value;
		const differentBaseGeneration = {
			...canonicalGeneration,
			baseExpectedHead: presentHead({
				closureDigest: canonicalGeneration.closureDigest,
				generationId: GENERATION_B,
			}),
		};

		// Executable calibration: a mutable session and a token bound to only the
		// old four-field subset are both exploitable by ordinary reflective code.
		const weakSession = { generation: canonicalGeneration, index: 0, phase: "promotion" };
		const weakFinish = (): boolean => weakSession.phase === "complete";
		expect(Reflect.set(weakSession, "phase", "complete")).toBe(true);
		expect(weakFinish()).toBe(true);
		const weakAuthorization = { generation: canonicalGeneration };
		const weakAccepts = (generation: typeof canonicalGeneration): boolean =>
			weakAuthorization.generation.objectId === generation.objectId &&
			weakAuthorization.generation.generationId === generation.generationId &&
			weakAuthorization.generation.closureDigest === generation.closureDigest &&
			weakAuthorization.generation.state === generation.state;
		expect(weakAccepts(differentBaseGeneration)).toBe(true);

		const controller = Reflect.get(adapter, "storageAdapterClosureVerifier") as ClosureVerifierController | undefined;
		expect(controller).toBeDefined();
		if (controller === undefined) return;
		expect(Object.keys(controller).sort()).toEqual(["acceptBlob", "acceptPromotion", "finish", "next", "start"]);

		const earlySession = controller.start(canonicalGeneration, "candidate");
		expect.soft(typeof earlySession).toBe("object");
		expect.soft(Object.isFrozen(earlySession)).toBe(true);
		expect.soft(Reflect.ownKeys(earlySession as object)).toEqual([]);
		for (const [property, value] of [
			["generation", differentBaseGeneration],
			["index", canonicalGeneration.closure.length],
			["phase", "complete"],
		] as const) {
			expect.soft(Reflect.set(earlySession as object, property, value), property).toBe(false);
			expect
				.soft(Reflect.defineProperty(earlySession as object, property, { configurable: true, value }), property)
				.toBe(false);
		}
		try {
			(earlySession as { phase?: unknown }).phase = "complete";
		} catch {
			// Strict-mode assignment may throw instead of returning false.
		}
		expect.soft(Reflect.ownKeys(earlySession as object)).toEqual([]);
		expect.soft(controller.finish(earlySession)).toMatchObject({ ok: false });

		const verify = (session: unknown): StoreResult<unknown> => {
			for (let index = 0; index < payloads.length; index++) {
				const expectedPromotion = {
					kind: "promotion",
					reference: canonicalGeneration.closure[index],
				} as const;
				const offeredPromotion = controller.next(session);
				expect.soft(offeredPromotion).toEqual(expectedPromotion);
				if (index === 0 && offeredPromotion !== null) {
					const hostileReference = ref(bytes(9, 9, 9));
					const offeredReference = Reflect.get(offeredPromotion, "reference") as object;
					Reflect.set(offeredPromotion, "kind", "blob");
					Reflect.set(offeredPromotion, "reference", hostileReference);
					Reflect.set(offeredReference, "digest", hostileReference.digest);
					Reflect.set(offeredReference, "byteLength", hostileReference.byteLength);
					expect.soft(controller.next(session)).toEqual(expectedPromotion);
				}
				controller.acceptPromotion(session, true);
				expect.soft(controller.next(session)).toEqual({
					kind: "blob",
					reference: canonicalGeneration.closure[index],
				});
				controller.acceptBlob(session, payloads[index] ?? null);
			}
			expect.soft(controller.next(session)).toBeNull();
			return controller.finish(session);
		};

		const detachedSession = controller.start(callerGeneration, "candidate");
		(callerGeneration.closure as unknown as unknown[]).splice(0, callerGeneration.closure.length, ref(bytes(9)));
		expect.soft(Reflect.set(callerGeneration.baseExpectedHead, "objectId", OBJECT_B)).toBe(true);
		expect
			.soft(
				Reflect.set(
					callerGeneration,
					"baseExpectedHead",
					presentHead({ closureDigest: callerGeneration.closureDigest, generationId: GENERATION_B })
				)
			)
			.toBe(true);
		expect.soft(Reflect.set(callerGeneration, "state", "Discarded")).toBe(true);
		const detachedAuthorization = verify(detachedSession);
		expect.soft(detachedAuthorization.ok).toBe(true);
		if (!detachedAuthorization.ok) return;
		expect.soft(typeof detachedAuthorization.value).toBe("object");
		expect.soft(Object.isFrozen(detachedAuthorization.value)).toBe(true);
		expect.soft(Reflect.ownKeys(detachedAuthorization.value as object)).toEqual([]);

		const prepared = adapter.prepareStorageAdapterCommand({
			generationId: GENERATION_A,
			kind: "completeGeneration",
			objectId: OBJECT_A,
		});
		if (!prepared.ok) return;
		const facts = (generationRecord: Uint8Array): readonly unknown[] => [
			{
				generationId: GENERATION_A,
				generationRecord,
				kind: "generation",
				objectId: OBJECT_A,
			},
		];
		const evaluate = adapter.evaluateStorageAdapterCommand as unknown as (
			command: unknown,
			loaded: readonly unknown[],
			authorization?: unknown
		) => unknown;
		expect.soft(independentlyDecoded.value).not.toBe(callerGeneration);
		expect.soft(evaluate(prepared.value, facts(canonicalBytes), detachedAuthorization.value)).toMatchObject({
			result: { ok: true, value: { state: "Complete" } },
			writes: [{ kind: "replace-generation" }],
		});

		const bindingAuthorization = verify(controller.start(canonicalGeneration, "candidate"));
		if (!bindingAuthorization.ok) return;
		expect
			.soft(
				evaluate(prepared.value, facts(encodeGenerationRecordV1(differentBaseGeneration)), bindingAuthorization.value)
			)
			.toEqual({
				result: { ok: false, reason: "INVALID_ARGUMENT" },
				writes: [],
			});
		expect.soft(evaluate(prepared.value, facts(canonicalBytes), Object.freeze({}))).toEqual({
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
