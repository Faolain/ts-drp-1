import {
	ActionType,
	type DrpType,
	type IACL,
	type IDRP,
	type ResolveConflictsType,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { type PostOperation } from "../src/operation.js";
import { createPipeline } from "../src/pipeline/pipeline.js";
import { DRPProxy, type DRPProxyChainArgs, trackMutations } from "../src/proxy.js";

describe("DRPProxy", () => {
	// Mock types and interfaces
	interface MockDRP extends IDRP {
		testMethod(arg: string): string;
		query_something(): void;
		resolveConflicts(vertices: Vertex[]): ResolveConflictsType;
	}

	const mockVertex: Vertex = {
		hash: "test-hash",
		peerId: "test-peer",
		operation: {
			drpType: "DRP",
			opType: "test",
			value: [],
		},
		dependencies: [],
		timestamp: 0,
		signature: new Uint8Array(),
	};

	const mockACL: IACL = {
		id: "test-acl",
		type: "acl",
		data: {},
		semanticsType: SemanticsType.pair,
		permissionless: false,
		grant: () => {},
		revoke: () => {},
		setKey: () => {},
		query_hasPermission: () => false,
		query_getPermissions: () => [],
		query_getKeys: () => [],
		query_getKey: () => undefined,
		query_getFinalitySigners: () => new Map(),
		query_isAdmin: () => false,
		query_isFinalitySigner: () => false,
		query_isWriter: () => false,
		query_getPeerKey: () => undefined,
		resolveConflicts: (_vertices: Vertex[]): ResolveConflictsType => ({ action: ActionType.Nop }),
	};

	const mockDRP: MockDRP = {
		id: "test-drp",
		type: "drp",
		data: {},
		semanticsType: SemanticsType.pair,
		testMethod: (arg: string) => `test-${arg}`,
		query_something: () => {},
		resolveConflicts: (_vertices: Vertex[]): ResolveConflictsType => ({ action: ActionType.Nop }),
	};

	const mockPipeline = createPipeline<DRPProxyChainArgs, PostOperation<IDRP>>(({ prop, args }) => ({
		stop: false,
		result: {
			isACL: false,
			vertex: mockVertex,
			lcaResult: { lca: "test-lca", linearizedVertices: [] },
			drpVertices: [mockVertex],
			aclVertices: [mockVertex],
			acl: mockACL,
			drp: mockDRP,
			result: `processed-${prop}-${args[0]}`,
		},
	}));

	it("should create a proxy instance", () => {
		const proxy = new DRPProxy(mockDRP, mockPipeline, "drp" as DrpType);
		expect(proxy).toBeDefined();
		expect(proxy.proxy).toBeDefined();
	});

	it("should intercept method calls and process them through pipeline", () => {
		const proxy = new DRPProxy(mockDRP, mockPipeline, "drp" as DrpType);
		const result = proxy.proxy.testMethod("value");

		expect(result).toBe("processed-testMethod-value");
	});

	it("should not intercept query methods", () => {
		const proxy = new DRPProxy(mockDRP, mockPipeline, "drp" as DrpType);
		const originalQueryMethod = mockDRP.query_something;

		expect(proxy.proxy.query_something).toBe(originalQueryMethod);
	});

	it("should not intercept resolveConflicts method", () => {
		const proxy = new DRPProxy(mockDRP, mockPipeline, "drp" as DrpType);
		const originalResolveMethod = mockDRP.resolveConflicts;

		expect(proxy.proxy.resolveConflicts).toBe(originalResolveMethod);
	});

	it("should pass through non-function properties", () => {
		const proxy = new DRPProxy(mockDRP, mockPipeline, "drp" as DrpType);

		expect(proxy.proxy.id).toBe(mockDRP.id);
		expect(proxy.proxy.type).toBe(mockDRP.type);
		expect(proxy.proxy.data).toBe(mockDRP.data);
		expect(proxy.proxy.semanticsType).toBe(mockDRP.semanticsType);
	});

	it("should handle pipeline errors gracefully", () => {
		const errorPipeline = createPipeline<DRPProxyChainArgs, PostOperation<IDRP>>(() => {
			throw new Error("Pipeline error");
		});

		const proxy = new DRPProxy(mockDRP, errorPipeline, "drp" as DrpType);

		expect(() => proxy.proxy.testMethod("value")).toThrow("Pipeline error");
	});
});

describe("trackMutations", () => {
	it("tracks nested collection values reached through iteration", () => {
		const state = { items: new Map([["item", { value: 1 }]]) };
		const tracked = trackMutations(state);

		for (const item of tracked.proxy.items.values()) item.value = 2;

		expect(tracked.hasChanges()).toBe(true);
		expect(state.items.get("item")?.value).toBe(2);
	});

	it("preserves Map identity and callback contracts while detecting only effective writes", () => {
		const rawKey = { id: "key" };
		const rawValue = { count: 1 };
		const state = { items: new Map([[rawKey, rawValue]]) };
		const tracked = trackMutations(state);
		const proxyKey = [...tracked.proxy.items.keys()][0];
		const proxyValue = tracked.proxy.items.get(proxyKey);
		const callbackContext = { calls: 0 };

		expect(proxyKey).not.toBe(rawKey);
		expect(proxyValue).not.toBe(rawValue);
		expect(tracked.proxy.items.size).toBe(1);
		expect(tracked.proxy.items.has(rawKey)).toBe(true);
		expect(tracked.proxy.items.has(proxyKey)).toBe(true);
		expect(tracked.proxy.items.get(rawKey)).toBe(proxyValue);
		expect([...tracked.proxy.items.values()]).toEqual([proxyValue]);
		expect([...tracked.proxy.items.entries()]).toEqual([[proxyKey, proxyValue]]);
		expect([...tracked.proxy.items]).toEqual([[proxyKey, proxyValue]]);
		tracked.proxy.items.forEach(function (this: typeof callbackContext, value, key, collection) {
			this.calls++;
			expect(value).toBe(proxyValue);
			expect(key).toBe(proxyKey);
			expect(collection).toBe(tracked.proxy.items);
		}, callbackContext);
		expect(callbackContext.calls).toBe(1);

		expect(tracked.proxy.items.set(proxyKey, { count: 1 })).toBe(tracked.proxy.items);
		expect(tracked.proxy.items.delete({ id: "key" })).toBe(false);
		expect(tracked.hasChanges()).toBe(false);
		expect(state.items.get(rawKey)).not.toBe(rawValue);

		const replacementProxyValue = tracked.proxy.items.get(proxyKey);
		expect(replacementProxyValue).not.toBe(proxyValue);
		if (!replacementProxyValue) throw new Error("replacement Map value was not retained");
		replacementProxyValue.count = 2;
		expect(tracked.hasChanges()).toBe(true);
		expect(state.items.get(rawKey)?.count).toBe(2);

		const added = trackMutations({ items: new Map([["one", 1]]) });
		added.proxy.items.set("two", 2);
		expect(added.hasChanges()).toBe(true);
		expect(added.proxy.items.size).toBe(2);

		const updatedState = { items: new Map([["one", { count: 1 }]]) };
		const updated = trackMutations(updatedState);
		updated.proxy.items.set("one", { count: 2 });
		expect(updated.hasChanges()).toBe(true);
		expect(updatedState.items.get("one")?.count).toBe(2);
		expect(updated.proxy.items.size).toBe(1);

		const deleted = trackMutations({ items: new Map([["one", 1]]) });
		expect(deleted.proxy.items.delete("one")).toBe(true);
		expect(deleted.hasChanges()).toBe(true);
		expect(deleted.proxy.items.size).toBe(0);

		const cleared = trackMutations({ items: new Map([["one", 1]]) });
		cleared.proxy.items.clear();
		expect(cleared.hasChanges()).toBe(true);
		expect(cleared.proxy.items.size).toBe(0);

		const empty = trackMutations({ items: new Map<string, number>() });
		empty.proxy.items.clear();
		expect(empty.hasChanges()).toBe(false);
		expect(empty.proxy.items.size).toBe(0);
	});

	it("preserves Set identity and callback contracts while detecting only effective writes", () => {
		const rawValue = { count: 1 };
		const state = { items: new Set([rawValue]) };
		const tracked = trackMutations(state);
		const proxyValue = [...tracked.proxy.items.values()][0];
		const callbackContext = { calls: 0 };

		expect(proxyValue).not.toBe(rawValue);
		expect(tracked.proxy.items.size).toBe(1);
		expect(tracked.proxy.items.has(rawValue)).toBe(true);
		expect(tracked.proxy.items.has(proxyValue)).toBe(true);
		expect([...tracked.proxy.items.keys()]).toEqual([proxyValue]);
		expect([...tracked.proxy.items.entries()]).toEqual([[proxyValue, proxyValue]]);
		expect([...tracked.proxy.items]).toEqual([proxyValue]);
		tracked.proxy.items.forEach(function (this: typeof callbackContext, value, key, collection) {
			this.calls++;
			expect(value).toBe(proxyValue);
			expect(key).toBe(proxyValue);
			expect(collection).toBe(tracked.proxy.items);
		}, callbackContext);
		expect(callbackContext.calls).toBe(1);

		expect(tracked.proxy.items.add(proxyValue)).toBe(tracked.proxy.items);
		expect(tracked.proxy.items.delete({ count: 1 })).toBe(false);
		proxyValue.count = 1;
		expect(tracked.hasChanges()).toBe(false);

		proxyValue.count = 2;
		expect(tracked.hasChanges()).toBe(true);
		expect(rawValue.count).toBe(2);

		const distinctValue = { count: 1 };
		const addedState = { items: new Set([{ count: 1 }]) };
		const added = trackMutations(addedState);
		expect(added.proxy.items.add(distinctValue)).toBe(added.proxy.items);
		expect(added.hasChanges()).toBe(true);
		expect(added.proxy.items.size).toBe(2);
		expect(addedState.items.has(distinctValue)).toBe(true);

		const deleted = trackMutations({ items: new Set([1]) });
		expect(deleted.proxy.items.delete(1)).toBe(true);
		expect(deleted.hasChanges()).toBe(true);
		expect(deleted.proxy.items.size).toBe(0);

		const cleared = trackMutations({ items: new Set([1]) });
		cleared.proxy.items.clear();
		expect(cleared.hasChanges()).toBe(true);
		expect(cleared.proxy.items.size).toBe(0);

		const empty = trackMutations({ items: new Set<number>() });
		empty.proxy.items.clear();
		expect(empty.hasChanges()).toBe(false);
		expect(empty.proxy.items.size).toBe(0);
	});

	it("treats Date reads and idempotent setters as no-ops but tracks effective date changes", () => {
		const state = { updatedAt: new Date("2025-01-01T00:00:00.000Z") };
		const tracked = trackMutations(state);
		const originalTime = state.updatedAt.getTime();

		expect(tracked.proxy.updatedAt.toISOString()).toBe("2025-01-01T00:00:00.000Z");
		expect(tracked.hasChanges()).toBe(false);
		expect(tracked.proxy.updatedAt.setTime(originalTime)).toBe(originalTime);
		expect(tracked.hasChanges()).toBe(false);

		tracked.proxy.updatedAt.setTime(originalTime + 1);
		expect(tracked.hasChanges()).toBe(true);
		expect(state.updatedAt.getTime()).toBe(originalTime + 1);

		const invalid = trackMutations({ updatedAt: new Date(Number.NaN) });
		expect(invalid.proxy.updatedAt.setTime(Number.NaN)).toBeNaN();
		expect(invalid.hasChanges()).toBe(false);
	});

	it("ignores nested writes reached through root context but tracks effective property deletion", () => {
		const state = {
			context: { cache: new Map([["item", { count: 1 }]]) },
			value: { count: 1 },
		};
		const tracked = trackMutations(state);
		const originalKeys = Reflect.ownKeys(state);

		const cachedItem = tracked.proxy.context.cache.get("item");
		if (!cachedItem) throw new Error("context cache fixture was not retained");
		cachedItem.count = 2;
		expect(tracked.hasChanges()).toBe(false);
		tracked.proxy.context.cache.set("other", { count: 3 });
		expect(tracked.hasChanges()).toBe(false);
		expect(state.context.cache.get("item")?.count).toBe(2);
		expect(state.context.cache.get("other")?.count).toBe(3);

		expect(Reflect.deleteProperty(tracked.proxy, "missing")).toBe(true);
		expect(tracked.hasChanges()).toBe(false);
		expect(Reflect.ownKeys(state)).toEqual(originalKeys);
		expect(Reflect.deleteProperty(tracked.proxy, "value")).toBe(true);
		expect(tracked.hasChanges()).toBe(true);
		expect("value" in state).toBe(false);
	});
});
