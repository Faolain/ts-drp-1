import type { SignedDrpRecordV1, ValidatedDrpRecord } from "@ts-drp/rendezvous";
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

interface PeerCache {
	put(record: ValidatedDrpRecord | SignedDrpRecordV1): Promise<void>;
	list(namespace: string, signal: AbortSignal): Promise<readonly ValidatedDrpRecord[]>;
	prune(): Promise<void>;
}

interface PhaseFourPeerCacheModule {
	InMemoryPeerCacheStore: new (initial?: readonly StoredPeerRecord[]) => PeerCacheStore;
	createPeerCache(options: { clock?(): number; readonly max: number; readonly store: PeerCacheStore }): PeerCache;
}

describe("Phase 4b bounded authenticated-peer cache", () => {
	it("uses insertion/update LRU eviction and never persists more than max entries", async () => {
		const phaseFour = await loadPeerCacheModule();
		if (phaseFour === undefined) return;
		const store = new phaseFour.InMemoryPeerCacheStore();
		const cache = phaseFour.createPeerCache({ clock: () => NOW, max: 2, store });
		const oldest = await publicRecord(401, { sequence: 1 });
		const second = await publicRecord(402);
		const refreshedOldest = await publicRecord(401, { sequence: 2 });
		const newest = await publicRecord(403);

		for (const record of [oldest, second, refreshedOldest, newest]) await cache.put(validated(record));

		const listed = await cache.list(NAMESPACE, AbortSignal.timeout(100));
		expect(listed.map(({ record }) => record.peerId)).toEqual([refreshedOldest.peerId, newest.peerId]);
		expect(listed.find(({ record }) => record.peerId === oldest.peerId)?.record.sequence).toBe(2);
		expect(await store.load()).toHaveLength(2);
	});

	it("drops expired entries on list using the client clock and persists the pruning", async () => {
		const phaseFour = await loadPeerCacheModule();
		if (phaseFour === undefined) return;
		let now = NOW;
		const store = new phaseFour.InMemoryPeerCacheStore();
		const cache = phaseFour.createPeerCache({ clock: () => now, max: 4, store });
		const record = await publicRecord(404, { expiresAtMs: NOW + 10_000 });
		await cache.put(validated(record));

		now = record.expiresAtMs;
		expect(await cache.list(NAMESPACE, AbortSignal.timeout(100))).toEqual([]);
		expect(await store.load()).toEqual([]);
	});

	it.each(["unsigned", "tampered"] as const)(
		"rejects %s input instead of trusting a stored validation label",
		async (kind) => {
			const phaseFour = await loadPeerCacheModule();
			if (phaseFour === undefined) return;
			const store = new phaseFour.InMemoryPeerCacheStore();
			const cache = phaseFour.createPeerCache({ clock: () => NOW, max: 4, store });
			const signed = await publicRecord(405);
			const { signature: _signature, ...unsigned } = signed;
			const candidate =
				kind === "unsigned"
					? (unsigned as unknown as SignedDrpRecordV1)
					: ({ ...signed, signature: mutate(signed.signature) } as SignedDrpRecordV1);

			await expect(cache.put(validated(candidate))).rejects.toThrow(/signature|unsigned|authenticated/iu);
			expect(await store.load()).toEqual([]);
		}
	);

	it("rejects an already-expired signed record on put", async () => {
		const phaseFour = await loadPeerCacheModule();
		if (phaseFour === undefined) return;
		const store = new phaseFour.InMemoryPeerCacheStore();
		const cache = phaseFour.createPeerCache({ clock: () => NOW + 60_000, max: 4, store });
		const expired = await publicRecord(408, { expiresAtMs: NOW + 10_000 });

		await expect(cache.put(validated(expired))).rejects.toThrow(/expired|fresh/iu);
		expect(await store.load()).toEqual([]);
	});

	it("returns only the highest sequence for a peer", async () => {
		const phaseFour = await loadPeerCacheModule();
		if (phaseFour === undefined) return;
		const store = new phaseFour.InMemoryPeerCacheStore();
		const cache = phaseFour.createPeerCache({ clock: () => NOW, max: 4, store });
		const first = await publicRecord(406, { sequence: 1 });
		const second = await publicRecord(406, { sequence: 2 });

		await cache.put(validated(first));
		await cache.put(validated(second));

		expect(await cache.list(NAMESPACE, AbortSignal.timeout(100))).toMatchObject([
			{ record: { peerId: first.peerId, sequence: 2 } },
		]);
	});

	it("round-trips authenticated records through a shared in-memory store", async () => {
		const phaseFour = await loadPeerCacheModule();
		if (phaseFour === undefined) return;
		const store = new phaseFour.InMemoryPeerCacheStore();
		const writer = phaseFour.createPeerCache({ clock: () => NOW, max: 4, store });
		const record = await publicRecord(407);
		await writer.put(record);

		const reader = phaseFour.createPeerCache({ clock: () => NOW, max: 4, store });
		expect(await reader.list(NAMESPACE, AbortSignal.timeout(100))).toMatchObject([
			{ record: { peerId: record.peerId, sequence: record.sequence } },
		]);
	});
});

async function loadPeerCacheModule(): Promise<PhaseFourPeerCacheModule | undefined> {
	const loaded = (await import("@ts-drp/rendezvous")) as unknown as Partial<PhaseFourPeerCacheModule>;
	expect(loaded.createPeerCache, "Phase 4b must export createPeerCache").toBeTypeOf("function");
	expect(loaded.InMemoryPeerCacheStore, "Phase 4b must export the in-memory PeerCacheStore").toBeTypeOf("function");
	if (loaded.createPeerCache === undefined || loaded.InMemoryPeerCacheStore === undefined) return undefined;
	return loaded as PhaseFourPeerCacheModule;
}

function validated(record: SignedDrpRecordV1): ValidatedDrpRecord {
	return { admissionMode: "invite", record, sourceEndpointId: "authenticated-session" };
}

async function publicRecord(
	index: number,
	overrides: Partial<ReturnType<typeof fixtureInput>> = {}
): Promise<SignedDrpRecordV1> {
	const { peerId, signer } = await fixtureSigner(index);
	return signer.sign(
		fixtureInput(peerId, {
			addresses: [`/ip4/93.184.216.34/tcp/443/wss/p2p/${peerId}`],
			expiresAtMs: NOW + 60_000,
			issuedAtMs: NOW,
			...overrides,
		})
	);
}

function mutate(value: string): string {
	return `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
}
