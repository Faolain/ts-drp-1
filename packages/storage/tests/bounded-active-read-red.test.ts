import { expect, it } from "vitest";

import {
	check,
	type Environment,
	EPHEMERAL_CASES,
	type Image,
	must,
	OBJECT,
	run,
	setup,
} from "../../../tests/fixtures/bounded-active-read/contract.js";
import { createMemoryAheDurableStore, type GenerationRef } from "../dist/src/index.js";

for (const name of EPHEMERAL_CASES)
	it(`ephemeral required bounded AHE read ${name}`, async () => {
		const store = createMemoryAheDurableStore();
		const image = async (): Promise<Image> => {
			const head = must(await store.readHead(OBJECT)),
				records = must(await store.readGenerationPage({ objectId: OBJECT, limit: 128 })).generations;
			const refs = new Map<string, GenerationRef>(records.flatMap((g) => g.closure.map((r) => [r.digest, r] as const)));
			const codec = await import("../dist/src/index.js");
			return {
				heads: [{ objectId: OBJECT, record: head.kind === "none" ? null : codec.encodeHeadRecordV1(head) }],
				generations: records.map((g) => ({
					objectId: OBJECT,
					generationId: g.generationId,
					record: codec.encodeGenerationRecordV1(g),
				})),
				blobs: await Promise.all(
					[...refs.values()].map(async (ref) => {
						const bytes = must(await store.getBlob(ref.digest));
						check(bytes, "ephemeral staged blob present");
						return { digest: ref.digest, bytes };
					})
				),
				promotions: [],
			}; // No promotion authority exists in the ephemeral owner; do not fabricate it from refs.
		};
		const env: Environment = {
			backend: "ephemeral",
			open: () => Promise.resolve(store),
			image,
			edit: () => Promise.reject(new Error("no test-only mutation of ephemeral private owner")),
			observe: async (action) => ({
				value: await action(),
				evidence: { modes: [], reads: [], writes: 0, terminals: 0 },
			}),
			control: () => Promise.resolve({ modes: [], reads: [], writes: 0, terminals: 0 }),
		};
		try {
			expect(store.capabilities).toEqual({ durability: "ephemeral", signingEligibility: "never" });
			await setup(name, env, false);
			const result = await run(name, env);
			console.log(JSON.stringify({ lane: "bounded-ahe-ephemeral", result }));
			expect(result, JSON.stringify(result)).toMatchObject({ case: name, passed: true });
		} finally {
			await store.close();
		}
	});

for (const name of ["empty", "invalid-and-closed", "detached-input"] as const)
	it(`ephemeral public read ${name}`, async () => {
		const store = createMemoryAheDurableStore();
		try {
			const method: unknown = Reflect.get(store, "acquireBoundedActiveRead");
			expect(typeof method, "WIRING_RED: required ephemeral acquireBoundedActiveRead absent").toBe("function");
			const { LIMITS, OTHER } = await import("../../../tests/fixtures/bounded-active-read/contract.js");
			const invoke = (input: unknown): Promise<unknown> =>
				Reflect.apply(method as (...args: unknown[]) => Promise<unknown>, store, [input]);
			if (name === "empty")
				expect(await invoke({ objectId: OBJECT, ancestorCount: 2, limits: LIMITS })).toMatchObject({
					ok: true,
					value: { kind: "empty", head: { objectId: OBJECT, kind: "none" } },
				});
			if (name === "detached-input") {
				const input = { objectId: OBJECT, ancestorCount: 0, limits: { ...LIMITS } },
					pending = invoke(input);
				input.objectId = OTHER;
				input.ancestorCount = 1;
				Reflect.set(input.limits, "maxObjectGenerations", 999);
				expect(await pending).toMatchObject({
					ok: true,
					value: { kind: "empty", head: { objectId: OBJECT, kind: "none" } },
				});
			}
			if (name === "invalid-and-closed") {
				await store.close();
				expect(await invoke({ objectId: OBJECT, ancestorCount: 1, limits: LIMITS })).toMatchObject({
					ok: false,
					reason: "INVALID_ARGUMENT",
				});
				expect(await invoke({ objectId: OBJECT, ancestorCount: 0, limits: LIMITS })).toMatchObject({
					ok: false,
					reason: "STORE_CLOSED",
				});
			}
		} finally {
			await store.close();
		}
	});
