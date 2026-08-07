import { describe, expect, it } from "vitest";

import { runStoreContract } from "../src/contract.js";
import {
	type AheDurableStore,
	createMemoryAheDurableStore,
	parseGenerationId,
	type StoreResult,
} from "../src/index.js";

type Invocation = () => Promise<unknown>;
type Interceptor = (property: PropertyKey, invoke: Invocation, args: readonly unknown[]) => Promise<unknown>;

function adaptStore(store: AheDurableStore, interceptor: Interceptor): AheDurableStore {
	return new Proxy(store, {
		get(target, property, receiver): unknown {
			const value: unknown = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]): Promise<unknown> =>
				interceptor(property, () => Promise.resolve(Reflect.apply(value, target, args)), args);
		},
	});
}

function delayedMethodStore(
	store: AheDurableStore,
	delayedMethod: "beginGeneration" | "putCachedBlob"
): AheDurableStore {
	return adaptStore(store, async (property, invoke) => {
		if (property === delayedMethod) await Promise.resolve();
		return invoke();
	});
}

function aliasedOutputStore(store: AheDurableStore, aliasedMethod: "getBlob" | "readObjectState"): AheDurableStore {
	let aliasedResult: unknown;
	return adaptStore(store, async (property, invoke) => {
		if (property !== aliasedMethod) return invoke();
		if (aliasedResult === undefined) aliasedResult = await invoke();
		return aliasedResult;
	});
}

function mutatingRepeatedBeginStore(store: AheDurableStore): AheDurableStore {
	let beginCount = 0;
	return adaptStore(store, async (property, invoke, args) => {
		if (property !== "beginGeneration") return invoke();
		beginCount++;
		if (beginCount === 1) return invoke();
		const input = args[0];
		if (typeof input === "object" && input !== null && "objectId" in input && "generationId" in input) {
			await store.discardGeneration({
				objectId: input.objectId as Parameters<AheDurableStore["discardGeneration"]>[0]["objectId"],
				generationId: input.generationId as Parameters<AheDurableStore["discardGeneration"]>[0]["generationId"],
			});
		}
		return { ok: false, reason: "GENERATION_EXISTS" } satisfies StoreResult<unknown>;
	});
}

function isPutInput(value: unknown): value is Parameters<AheDurableStore["putCachedBlob"]>[0] {
	return typeof value === "object" && value !== null && "digest" in value && "bytes" in value;
}

function mutatingUndeclaredPutStore(store: AheDurableStore): AheDurableStore {
	let declaredDigest: string | undefined;
	const sideGeneration = parseGenerationId("d".repeat(64));
	if (!sideGeneration.ok) throw new Error("side generation fixture must be canonical");

	return adaptStore(store, async (property, invoke, args) => {
		if (property === "beginGeneration") {
			const input = args[0];
			if (typeof input === "object" && input !== null && "closure" in input && Array.isArray(input.closure)) {
				const first = input.closure[0];
				if (typeof first === "object" && first !== null && "digest" in first && typeof first.digest === "string") {
					declaredDigest = first.digest;
				}
			}
			return invoke();
		}
		if (property !== "putCachedBlob" || !isPutInput(args[0]) || args[0].digest === declaredDigest) return invoke();

		const input = args[0];
		const rejection = await invoke();
		await store.beginGeneration({
			objectId: input.objectId,
			generationId: sideGeneration.value,
			baseExpectedHead: { kind: "none", objectId: input.objectId },
			closure: [{ digest: input.digest, byteLength: input.bytes.byteLength }],
		});
		await store.putCachedBlob({ ...input, generationId: sideGeneration.value });
		return rejection;
	});
}

function nonPersistentDiscardStore(store: AheDurableStore): AheDurableStore {
	let staged: unknown;
	return adaptStore(store, async (property, invoke) => {
		if (property === "beginGeneration") {
			staged = await invoke();
			return staged;
		}
		if (property !== "discardGeneration") return invoke();
		if (
			typeof staged === "object" &&
			staged !== null &&
			"ok" in staged &&
			staged.ok === true &&
			"value" in staged &&
			typeof staged.value === "object" &&
			staged.value !== null
		) {
			return { ok: true, value: { ...staged.value, state: "Discarded" } } satisfies StoreResult<unknown>;
		}
		return invoke();
	});
}

describe("Phase 2a shared contract runner closure matrix", () => {
	it.each(["beginGeneration", "putCachedBlob"] as const)(
		"rejects an adapter that consumes caller-owned %s input after a microtask",
		async (method) => {
			await expect(runStoreContract(() => delayedMethodStore(createMemoryAheDurableStore(), method))).rejects.toThrow(
				/AheDurableStore contract violation/
			);
		}
	);

	it.each(["getBlob", "readObjectState"] as const)(
		"rejects an adapter that reuses aliased %s output",
		async (method) => {
			await expect(runStoreContract(() => aliasedOutputStore(createMemoryAheDurableStore(), method))).rejects.toThrow(
				/AheDurableStore contract violation/
			);
		}
	);

	it("rejects an exact repeated-begin reason when the adapter mutates the journal", async () => {
		await expect(runStoreContract(() => mutatingRepeatedBeginStore(createMemoryAheDurableStore()))).rejects.toThrow(
			/AheDurableStore contract violation/
		);
	});

	it("rejects an exact undeclared-put reason when the adapter mutates state and the global blob", async () => {
		await expect(runStoreContract(() => mutatingUndeclaredPutStore(createMemoryAheDurableStore()))).rejects.toThrow(
			/AheDurableStore contract violation/
		);
	});

	it("rejects an adapter that reports Discarded without persisting it", async () => {
		await expect(runStoreContract(() => nonPersistentDiscardStore(createMemoryAheDurableStore()))).rejects.toThrow(
			/AheDurableStore contract violation/
		);
	});

	it("uses a fresh factory instance and closes it on each independent invocation", async () => {
		const stores: AheDurableStore[] = [];
		let closeCount = 0;
		const factory = (): AheDurableStore => {
			const store = createMemoryAheDurableStore();
			stores.push(store);
			return adaptStore(store, async (property, invoke) => {
				if (property === "close") closeCount++;
				return invoke();
			});
		};

		await runStoreContract(factory);
		await runStoreContract(factory);

		expect(stores).toHaveLength(2);
		expect(stores[0]).not.toBe(stores[1]);
		expect(closeCount).toBe(2);
	});

	it("preserves the primary conformance error when close also throws", async () => {
		const store = adaptStore(createMemoryAheDurableStore(), async (property, invoke) => {
			if (property === "getBlob") {
				await invoke();
				return { ok: true, value: null };
			}
			if (property === "close") {
				await invoke();
				throw new Error("secondary close failure");
			}
			return invoke();
		});

		await expect(runStoreContract(() => store)).rejects.toThrow(
			"AheDurableStore contract violation at getBlob: expected detached bytes matching the cached payload"
		);
	});
});
