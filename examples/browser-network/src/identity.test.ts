import { afterEach, expect, test, vi } from "vitest";

import { acquireBrowserIdentity, type BrowserIdentityLease } from "./identity";

const leases = new Set<BrowserIdentityLease>();
afterEach(() => {
	for (const lease of leases) lease.release();
	leases.clear();
	vi.unstubAllGlobals();
});

function installBrowserPremise(): Readonly<{ held: Set<string>; seeds: Map<string, string> }> {
	const held = new Set<string>();
	const seeds = new Map<string, string>();
	// Deterministic browser-mechanics premise. Actual Web Locks/storage behavior
	// is exercised by the app browser launcher, not claimed by this unit double.
	vi.stubGlobal("navigator", {
		locks: {
			async request(name: string, _options: unknown, use: (lock: object | null) => Promise<void>): Promise<void> {
				if (held.has(name)) return use(null);
				held.add(name);
				try {
					await use({});
				} finally {
					held.delete(name);
				}
			},
		},
	});
	vi.stubGlobal("localStorage", {
		getItem: (key: string): string | null => seeds.get(key) ?? null,
		setItem: (key: string, value: string): void => {
			seeds.set(key, value);
		},
	});
	return { held, seeds };
}
const namespace = Object.freeze({ lockPrefix: "test:author-slot", seedKey: "test:author-seed" });
async function acquire(): Promise<BrowserIdentityLease> {
	const lease = await acquireBrowserIdentity(namespace);
	leases.add(lease);
	return lease;
}

test("shared browser author owner preserves durable slots and prevents concurrent seed reuse", async () => {
	const { held, seeds } = installBrowserPremise();
	const [first, second] = await Promise.all([acquire(), acquire()]);
	expect(first.seed).toMatch(/^[0-9a-f]{64}$/u);
	expect(second.seed).not.toBe(first.seed);
	expect(seeds.get(namespace.seedKey)).toBe(first.seed);
	expect(seeds.get(`${namespace.seedKey}:1`)).toBe(second.seed);
	expect([...held]).toEqual([`${namespace.lockPrefix}:0`, `${namespace.lockPrefix}:1`]);
	first.release();
	first.release();
	const replacement = await acquire();
	expect(replacement.seed).toBe(first.seed);
	expect(held.size).toBe(2);
});

test("missing lock custody and exhausted slot capacity refuse instead of minting a fallback author", async () => {
	vi.stubGlobal("navigator", {});
	await expect(acquire()).rejects.toThrow("v3 browser identity locks are unavailable");
	const { held, seeds } = installBrowserPremise();
	for (let slot = 0; slot < 64; slot += 1) held.add(`${namespace.lockPrefix}:${slot}`);
	await expect(acquire()).rejects.toThrow("v3 browser identity capacity is exhausted");
	expect(seeds.size).toBe(0);
});

test("storage failure releases the exact acquired slot and preserves its original error", async () => {
	const { held } = installBrowserPremise();
	const original = new Error("AUTHOR_STORAGE_UNAVAILABLE");
	vi.stubGlobal("localStorage", {
		getItem(): never {
			throw original;
		},
	});
	await expect(acquire()).rejects.toBe(original);
	expect(held.size).toBe(0);
	installBrowserPremise();
	expect((await acquire()).seed).toMatch(/^[0-9a-f]{64}$/u);
});
