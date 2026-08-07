import { describe, expect, it } from "vitest";

import { bytes, digestOf, GENERATION_A, GENERATION_B, noHead, OBJECT_A, OBJECT_B, ref } from "./fixtures.js";
import { runStoreContract, STORE_CONTRACT_SCENARIOS } from "../src/contract.js";
import * as contractSurface from "../src/contract.js";
import {
	type AheDurableStore,
	createMemoryAheDurableStore,
	type GenerationRecord,
	type GenerationRef,
	type StoreResult,
} from "../src/index.js";
import * as storageSurface from "../src/index.js";

function reasonOf(result: StoreResult<unknown>): string {
	return result.ok ? "OK" : result.reason;
}

async function beginOne(
	store: AheDurableStore,
	objectId = OBJECT_A,
	generationId = GENERATION_A
): Promise<{ payload: Uint8Array; item: GenerationRef; begun: GenerationRecord }> {
	const payload = bytes(1, 2, 3);
	const item = ref(payload);
	const begun = await store.beginGeneration({
		objectId,
		generationId,
		baseExpectedHead: noHead(objectId),
		closure: [item],
	});
	if (!begun.ok) throw new Error(`positive begin failed: ${begun.reason}`);
	return { payload, item, begun: begun.value };
}

function observeStore(
	store: AheDurableStore,
	calls: string[],
	options: { readonly corruptBlobRead?: boolean } = {}
): AheDurableStore {
	return new Proxy(store, {
		get(target, property, receiver): unknown {
			const value: unknown = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			return async (...args: unknown[]): Promise<unknown> => {
				if (typeof property === "string") calls.push(property);
				const result: unknown = await Reflect.apply(value, target, args);
				if (property === "getBlob" && options.corruptBlobRead === true) {
					return { ok: true, value: null };
				}
				return result;
			};
		},
	});
}

describe("Phase 2a shared contract and honest memory capabilities", () => {
	it("exports a frozen data-only corpus and common runner", async () => {
		expect(Object.isFrozen(STORE_CONTRACT_SCENARIOS)).toBe(true);
		expect(STORE_CONTRACT_SCENARIOS.map(({ branch }) => branch)).toEqual(["common", "common", "strict"]);
		expect(await runStoreContract(createMemoryAheDurableStore)).toEqual({
			durability: "ephemeral",
			signingEligibility: "never",
		});
	});

	it("runs the common ephemeral scenario against the supplied store", async () => {
		const calls: string[] = [];
		const capabilities = await runStoreContract(() => observeStore(createMemoryAheDurableStore(), calls));

		expect(capabilities).toEqual({ durability: "ephemeral", signingEligibility: "never" });
		const requiredCalls = ["beginGeneration", "putCachedBlob", "getBlob", "readObjectState", "discardGeneration"];
		let previousIndex = -1;
		for (const requiredCall of requiredCalls) {
			const index = calls.indexOf(requiredCall, previousIndex + 1);
			expect(index).toBeGreaterThan(previousIndex);
			previousIndex = index;
		}
		expect(calls.filter((call) => call === "close")).toHaveLength(1);
		expect(calls.at(-1)).toBe("close");
	});

	it("rejects when a supplied store lies about an observable common step", async () => {
		await expect(
			runStoreContract(() =>
				observeStore(createMemoryAheDurableStore(), [], {
					corruptBlobRead: true,
				})
			)
		).rejects.toThrow();
	});

	it("does not export the transition owner, harness, or a signing-capability predicate", () => {
		for (const surface of [storageSurface, contractSurface]) {
			expect(Object.keys(surface)).not.toContain("PermissiveTransitionOwner");
			expect(Object.keys(surface)).not.toContain("createTransitionHarness");
			expect(Object.keys(surface)).not.toContain("isSigningEligible");
		}
	});

	it("cannot be relabeled strict or signing-eligible by an environment override", () => {
		const controls = globalThis as typeof globalThis & { TS_DRP_STRICT_STORAGE?: string };
		controls.TS_DRP_STRICT_STORAGE = "1";
		try {
			const store = createMemoryAheDurableStore();
			expect(store.capabilities).toEqual({ durability: "ephemeral", signingEligibility: "never" });
			expect(Object.isFrozen(store.capabilities)).toBe(true);
			expect("sign" in store).toBe(false);
		} finally {
			delete controls.TS_DRP_STRICT_STORAGE;
		}
	});

	it.each(["declared", "undeclared", "absent", "unknown-generation"] as const)(
		"returns DURABILITY_UNAVAILABLE before lookup/integrity for %s promotion",
		async (kind) => {
			const store = createMemoryAheDurableStore();
			const { item } = await beginOne(store);
			const digest = kind === "declared" || kind === "absent" ? item.digest : digestOf(bytes(9));
			const generationId = kind === "unknown-generation" ? GENERATION_B : GENERATION_A;
			const result = await store.promoteReference({ objectId: OBJECT_A, generationId, digest });
			expect(reasonOf(result)).toBe("DURABILITY_UNAVAILABLE");
		}
	);

	it("keeps exported memory completion and adoption impossible", async () => {
		const store = createMemoryAheDurableStore();
		const { payload, item } = await beginOne(store);
		expect(
			await store.putCachedBlob({
				objectId: OBJECT_A,
				generationId: GENERATION_A,
				digest: item.digest,
				bytes: payload,
			})
		).toEqual({ ok: true, value: { inserted: true } });
		const complete = await store.completeGeneration({ objectId: OBJECT_A, generationId: GENERATION_A });
		expect(reasonOf(complete)).toBe("BLOB_UNPROMOTED");
		const swap = await store.swapHead({ objectId: OBJECT_A, generationId: GENERATION_A, expectedHead: noHead() });
		expect(reasonOf(swap)).toBe("CANDIDATE_NOT_COMPLETE");
	});

	it("rejects an undeclared cached blob without publishing it", async () => {
		const store = createMemoryAheDurableStore();
		await beginOne(store);
		const undeclared = digestOf(bytes(9));
		const result = await store.putCachedBlob({
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			digest: undeclared,
			bytes: bytes(9),
		});
		expect(reasonOf(result)).toBe("BLOB_NOT_REFERENCED");
		expect(await store.getBlob(undeclared)).toEqual({ ok: true, value: null });
	});

	it("returns GENERATION_EXISTS for equal, substitute, and extra repeated begin", async () => {
		const store = createMemoryAheDurableStore();
		const first = await beginOne(store);
		const before = await store.readObjectState(OBJECT_A);
		for (const closure of [[first.item], [ref(bytes(4))], [first.item, ref(bytes(5))]]) {
			const result = await store.beginGeneration({
				objectId: OBJECT_A,
				generationId: GENERATION_A,
				baseExpectedHead: noHead(),
				closure,
			});
			expect(reasonOf(result)).toBe("GENERATION_EXISTS");
			expect(await store.readObjectState(OBJECT_A)).toEqual(before);
		}
	});

	it("copies input before retention and returns fresh blob bytes", async () => {
		const store = createMemoryAheDurableStore();
		const { payload, item } = await beginOne(store);
		await store.putCachedBlob({ objectId: OBJECT_A, generationId: GENERATION_A, digest: item.digest, bytes: payload });
		payload[0] = 99;
		const first = await store.getBlob(item.digest);
		expect(first).toEqual({ ok: true, value: bytes(1, 2, 3) });
		if (!first.ok || first.value === null) throw new Error("positive get failed");
		first.value[1] = 88;
		expect(await store.getBlob(item.digest)).toEqual({ ok: true, value: bytes(1, 2, 3) });
	});

	it("rejects SharedArrayBuffer-backed put before retention", async () => {
		const store = createMemoryAheDurableStore();
		const { item } = await beginOne(store);
		const shared = new Uint8Array(new SharedArrayBuffer(item.byteLength));
		const result = await store.putCachedBlob({
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			digest: item.digest,
			bytes: shared,
		});
		expect(reasonOf(result)).toBe("SHARED_BUFFER_INPUT");
		expect(await store.getBlob(item.digest)).toEqual({ ok: true, value: null });
	});

	it("gives an own data SharedArrayBuffer bytes field precedence over malformed siblings", async () => {
		const store = createMemoryAheDurableStore();
		const { item } = await beginOne(store);
		const before = await store.readObjectState(OBJECT_A);
		const shared = new Uint8Array(new SharedArrayBuffer(item.byteLength));
		const input = {
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			digest: item.digest,
			bytes: shared,
			extra: "malformed",
		};
		const result = await store.putCachedBlob(input);

		expect(reasonOf(result)).toBe("SHARED_BUFFER_INPUT");
		expect(await store.getBlob(item.digest)).toEqual({ ok: true, value: null });
		expect(await store.readObjectState(OBJECT_A)).toEqual(before);
	});

	it("rejects an accessor bytes field without invoking it", async () => {
		const store = createMemoryAheDurableStore();
		const { payload, item } = await beginOne(store);
		let getterCalls = 0;
		const input = {
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			digest: item.digest,
			get bytes(): Uint8Array {
				getterCalls++;
				return payload;
			},
		};

		expect(reasonOf(await store.putCachedBlob(input))).toBe("INVALID_ARGUMENT");
		expect(getterCalls).toBe(0);
		expect(await store.getBlob(item.digest)).toEqual({ ok: true, value: null });
	});

	it("rejects an inherited bytes field", async () => {
		const store = createMemoryAheDurableStore();
		const { payload, item } = await beginOne(store);
		const input = Object.assign(Object.create({ bytes: payload }) as Record<string, unknown>, {
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			digest: item.digest,
		});

		expect(reasonOf(await store.putCachedBlob(input as never))).toBe("INVALID_ARGUMENT");
		expect(await store.getBlob(item.digest)).toEqual({ ok: true, value: null });
	});

	it("rejects an ordinary non-Uint8Array bytes field", async () => {
		const store = createMemoryAheDurableStore();
		const { item } = await beginOne(store);
		const result = await store.putCachedBlob({
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			digest: item.digest,
			bytes: [1, 2, 3] as never,
		});

		expect(reasonOf(result)).toBe("INVALID_ARGUMENT");
		expect(await store.getBlob(item.digest)).toEqual({ ok: true, value: null });
	});

	it("global same-byte races have exactly one insertion and one idempotent success", async () => {
		const store = createMemoryAheDurableStore();
		const left = await beginOne(store, OBJECT_A, GENERATION_A);
		await store.beginGeneration({
			objectId: OBJECT_B,
			generationId: GENERATION_B,
			baseExpectedHead: noHead(OBJECT_B),
			closure: [left.item],
		});
		const outcomes = await Promise.all([
			store.putCachedBlob({
				objectId: OBJECT_A,
				generationId: GENERATION_A,
				digest: left.item.digest,
				bytes: left.payload,
			}),
			store.putCachedBlob({
				objectId: OBJECT_B,
				generationId: GENERATION_B,
				digest: left.item.digest,
				bytes: bytes(...left.payload),
			}),
		]);
		const inserted = outcomes.flatMap((result) => (result.ok ? [result.value.inserted] : []));
		expect(inserted.sort()).toEqual([false, true]);
	});

	it("global conflicting-byte races choose one immutable winner", async () => {
		const store = createMemoryAheDurableStore();
		const left = await beginOne(store, OBJECT_A, GENERATION_A);
		await store.beginGeneration({
			objectId: OBJECT_B,
			generationId: GENERATION_B,
			baseExpectedHead: noHead(OBJECT_B),
			closure: [left.item],
		});
		const outcomes = await Promise.all([
			store.putCachedBlob({
				objectId: OBJECT_A,
				generationId: GENERATION_A,
				digest: left.item.digest,
				bytes: left.payload,
			}),
			store.putCachedBlob({
				objectId: OBJECT_B,
				generationId: GENERATION_B,
				digest: left.item.digest,
				bytes: bytes(9, 9, 9),
			}),
		]);
		expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
		expect(outcomes.filter((result) => reasonOf(result) === "IMMUTABLE_CONFLICT")).toHaveLength(1);
	});

	it("close is idempotent and every later method returns STORE_CLOSED", async () => {
		const store = createMemoryAheDurableStore();
		await store.close();
		await store.close();
		expect(reasonOf(await store.readObjectState(OBJECT_A))).toBe("STORE_CLOSED");
		expect(store.capabilities).toEqual({ durability: "ephemeral", signingEligibility: "never" });
	});

	it("sorts generation output and isolates returned journal records", async () => {
		const store = createMemoryAheDurableStore();
		await beginOne(store, OBJECT_A, GENERATION_B);
		await beginOne(store, OBJECT_A, GENERATION_A);
		const first = await store.readObjectState(OBJECT_A);
		expect(first.ok && first.value.generations.map(({ generationId }) => generationId)).toEqual([
			GENERATION_A,
			GENERATION_B,
		]);
		if (!first.ok) throw new Error("positive read failed");
		const firstRecord = first.value.generations[0] as GenerationRecord;
		(firstRecord as { state: string }).state = "Discarded";
		(first.value.generations as GenerationRecord[]).push(firstRecord);
		const second = await store.readObjectState(OBJECT_A);
		expect(second.ok && second.value.generations).toHaveLength(2);
		expect(second.ok && second.value.generations[0]?.state).toBe("Staged");
	});
});
