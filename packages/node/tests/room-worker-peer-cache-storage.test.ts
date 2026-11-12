import type { ControlPlanePeerCacheConfig } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRPNode } from "../src/index.js";

// A room hosted in a dedicated worker has no localStorage: its page passes the worker a storage
// adapter for the browser-local peer cache (@ts-drp/room-worker mirrors it into the page's
// localStorage). Without an adapter the cache keeps using globalThis.localStorage, as before.

interface StorageSpy {
	getItem(key: string): string | null;
	removeItem(key: string): void;
	setItem(key: string, value: string): void;
}

const spyStorage = (): StorageSpy & { reads: string[] } => {
	const reads: string[] = [];
	return {
		reads,
		getItem: (key: string) => {
			reads.push(key);
			return null;
		},
		removeItem: () => undefined,
		setItem: () => undefined,
	};
};

type CacheFactory = (
	config: ControlPlanePeerCacheConfig,
	validatorFactory: () => unknown
) => Promise<{ list(namespace: string, signal: AbortSignal): Promise<readonly unknown[]> }>;

const cacheFactory = (): CacheFactory => {
	const node = new DRPNode({ keychain_config: { private_key_seed: "room-worker-peer-cache" } });
	return (node as unknown as { _createRendezvousCache: CacheFactory })._createRendezvousCache.bind(node);
};

afterEach(() => vi.unstubAllGlobals());

describe("browser-local peer cache storage", () => {
	it("reads through the storage adapter the config names", async () => {
		const storage = spyStorage();
		const ambient = spyStorage();
		vi.stubGlobal("localStorage", ambient);
		const cache = await cacheFactory()(
			{ enabled: true, max: 4, persistence: "browser-local", key: "worker-cache", storage },
			() => ({})
		);
		await cache.list("ns", new AbortController().signal);
		expect(storage.reads).toEqual(["worker-cache"]);
		expect(ambient.reads).toEqual([]);
	});

	it("keeps using globalThis.localStorage when the config names no adapter", async () => {
		const ambient = spyStorage();
		vi.stubGlobal("localStorage", ambient);
		const cache = await cacheFactory()({ enabled: true, max: 4, persistence: "browser-local", key: "page-cache" }, () => ({}));
		await cache.list("ns", new AbortController().signal);
		expect(ambient.reads).toEqual(["page-cache"]);
	});
});
