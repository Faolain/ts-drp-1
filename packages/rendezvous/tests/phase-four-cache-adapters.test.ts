import type { SignedDrpRecordV1, ValidatedDrpRecord } from "@ts-drp/rendezvous";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fixtureInput, fixtureSigner, NAMESPACE, NOW } from "./fixtures.js";

interface StoredPeerRecord {
	readonly admissionMode: ValidatedDrpRecord["admissionMode"];
	readonly cachedAtMs: number;
	readonly record: SignedDrpRecordV1;
	readonly sourceEndpointId: string;
}

interface PeerCacheStore {
	load(): Promise<readonly StoredPeerRecord[]>;
	save(records: readonly StoredPeerRecord[]): Promise<void>;
}

interface StorageLike {
	getItem(key: string): string | null;
	removeItem(key: string): void;
	setItem(key: string, value: string): void;
}

interface BrowserCacheModule {
	LocalStoragePeerCacheStore: new (options: {
		readonly key: string;
		onPersistenceError?(event: {
			readonly kind: "peer-cache-persistence";
			readonly operation: "load" | "save";
			readonly outcome: "failed";
		}): void;
		readonly storage?: StorageLike;
	}) => PeerCacheStore;
	createPeerCache(options: {
		clock?(): number;
		readonly max: number;
		onPersistenceError?(event: {
			readonly kind: "peer-cache-persistence";
			readonly operation: "load" | "save";
			readonly outcome: "failed";
		}): void;
		readonly store: PeerCacheStore;
	}): {
		list(namespace: string, signal: AbortSignal): Promise<readonly ValidatedDrpRecord[]>;
		put(record: ValidatedDrpRecord | SignedDrpRecordV1): Promise<void>;
	};
}

interface NodeCacheModule {
	FsPeerCacheStore: new (options: { readonly path: string }) => PeerCacheStore;
}

describe("Phase 4b runtime-specific peer-cache stores", () => {
	it("exports a browser-safe localStorage adapter from the main entry", async () => {
		const loaded = (await import("@ts-drp/rendezvous")) as unknown as Partial<BrowserCacheModule>;
		expect(loaded.LocalStoragePeerCacheStore, "the main entry must export LocalStoragePeerCacheStore").toBeTypeOf(
			"function"
		);
		if (loaded.LocalStoragePeerCacheStore === undefined) return;
		const values = new Map<string, string>();
		const storage: StorageLike = {
			getItem: (key) => values.get(key) ?? null,
			removeItem: (key) => void values.delete(key),
			setItem: (key, value) => void values.set(key, value),
		};
		const record = await storedRecord(701);
		const writer = new loaded.LocalStoragePeerCacheStore({ key: "phase-four-cache", storage });
		await writer.save([record]);

		const reader = new loaded.LocalStoragePeerCacheStore({ key: "phase-four-cache", storage });
		await expect(reader.load()).resolves.toEqual([record]);
	});

	it("exports the fs adapter only from the Node subpath and round-trips atomically in the OS temp directory", async () => {
		const loaded = await loadNodeCacheModule();
		if (loaded === undefined) return;
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "ts-drp-peer-cache-"));
		const path = join(temporaryDirectory, "peers.json");
		try {
			const record = await storedRecord(702);
			const writer = new loaded.FsPeerCacheStore({ path });
			await writer.save([record]);
			const serialized = await readFile(path, "utf8");
			expect(serialized).not.toContain("privateKey");

			const reader = new loaded.FsPeerCacheStore({ path });
			await expect(reader.load()).resolves.toEqual([record]);
		} finally {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it.each(["blocked", "quota", "absent"] as const)(
		"keeps an in-memory cache hit when localStorage is %s",
		async (failure) => {
			const loaded = (await import("@ts-drp/rendezvous")) as unknown as Partial<BrowserCacheModule>;
			expect(loaded.LocalStoragePeerCacheStore).toBeTypeOf("function");
			expect(loaded.createPeerCache).toBeTypeOf("function");
			if (loaded.LocalStoragePeerCacheStore === undefined || loaded.createPeerCache === undefined) return;
			const events: Array<{ readonly operation: "load" | "save" }> = [];
			const storage: StorageLike | undefined =
				failure === "absent"
					? undefined
					: {
							getItem: (): string | null => {
								if (failure === "blocked") throw new Error("localStorage disabled");
								return null;
							},
							removeItem: (): void => undefined,
							setItem: (): never => {
								throw new DOMException("quota exceeded", "QuotaExceededError");
							},
						};
			const store = new loaded.LocalStoragePeerCacheStore({
				key: `phase-four-${failure}`,
				onPersistenceError: (event): void => void events.push(event),
				storage,
			});
			const cache = loaded.createPeerCache({
				clock: () => NOW,
				max: 4,
				onPersistenceError: (event) => events.push(event),
				store,
			});
			const record = await storedRecord(710 + ["blocked", "quota", "absent"].indexOf(failure));

			await expect(cache.put(record.record)).resolves.toBeUndefined();
			await expect(cache.list(NAMESPACE, AbortSignal.timeout(100))).resolves.toMatchObject([
				{ record: { peerId: record.record.peerId } },
			]);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "peer-cache-persistence", operation: "save", outcome: "failed" }),
				])
			);
		}
	);
});

async function loadNodeCacheModule(): Promise<NodeCacheModule | undefined> {
	let loaded: Partial<NodeCacheModule> = {};
	try {
		loaded = (await import(
			/* @vite-ignore */ new URL("../src/node.ts", import.meta.url).href
		)) as Partial<NodeCacheModule>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/node\.ts|load url|does the file exist/iu.test(message)) throw error;
	}
	expect(loaded.FsPeerCacheStore, "@ts-drp/rendezvous/node must export FsPeerCacheStore").toBeTypeOf("function");
	return loaded.FsPeerCacheStore === undefined ? undefined : (loaded as NodeCacheModule);
}

async function storedRecord(index: number): Promise<StoredPeerRecord> {
	const { peerId, signer } = await fixtureSigner(index);
	const record = await signer.sign(
		fixtureInput(peerId, {
			addresses: [`/ip4/93.184.216.34/tcp/443/wss/p2p/${peerId}`],
			expiresAtMs: NOW + 60_000,
			issuedAtMs: NOW,
		})
	);
	return { admissionMode: "invite", cachedAtMs: NOW, record, sourceEndpointId: "authenticated-session" };
}
