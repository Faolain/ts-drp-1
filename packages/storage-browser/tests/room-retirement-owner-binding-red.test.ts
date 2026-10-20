import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import { prepareBrowserRoomDatabase } from "../src/internal/schema-idb.js";
import * as issuanceModule from "../src/issuance.js";
import * as maintenance from "../src/maintenance.js";
import * as signingModule from "../src/seal-signing.js";

// Slice 14a (specs/bounded-storage-lifecycle/slices/14a-retention-database-format.md),
// RED item 5 at the owner boundary: when the caller names the owner, the session
// acts only for a genuine, open room-mode owner of its own database, and applies that
// owner's captured incarnation and lifetime exactly as its ordinary path does.
// fake-indexeddb is mechanism evidence only (native: 14f).

type Read = Readonly<Record<string, unknown>> & {
	control: Readonly<Record<string, unknown>>;
	release(): Promise<void>;
};
type Retirement = Readonly<{
	acquireIssuance(input: Readonly<{ objectId: string }>, store?: unknown): Promise<Read>;
	acquireSigning(input: Readonly<{ objectId: string }>, recovery?: boolean, store?: unknown): Promise<Read>;
	commit(): Promise<void>;
	abort(cause?: unknown): Promise<void>;
}>;
type Closeable = { close(): Promise<void> };

function named<T>(module: object, name: string): T {
	const value = Reflect.get(module, name) as T | undefined;
	if (typeof value !== "function") throw new Error(`${name} is missing`);
	return value;
}
const openRetirement = (databaseName: string): Promise<Retirement> =>
	named<(input: Readonly<{ databaseName: string }>) => Promise<Retirement>>(
		maintenance,
		"openBrowserRoomRetirement"
	)({ databaseName });
const openRoomIssuance = (databaseName: string): Promise<Closeable> =>
	named<(input: Readonly<{ databaseName: string }>) => Promise<Closeable>>(
		issuanceModule,
		"createBrowserRoomDurableIssuanceStore"
	)({ databaseName });
const openRoomVote = (databaseName: string): Promise<Closeable & { store: object }> =>
	named<(input: Readonly<{ databaseName: string }>) => Promise<Closeable & { store: object }>>(
		signingModule,
		"openBrowserRoomSealVoteStore"
	)({ databaseName });

let counter = 0;
const fresh = (label: string): string => `room-owner-binding-${label}-${++counter}`;
const objectId = `room-bind:${"a".repeat(32)}`;
const p = {
	throughEpoch: 3,
	decisionDigest: "d".repeat(64),
	sourceProofDigest: "e".repeat(64),
	protectedRecords: [],
};

describe("14a session acquisition bound to a named owner", () => {
	it("acts for a genuine open room issuance store of its own database", async () => {
		const name = fresh("issuance");
		await prepareBrowserRoomDatabase({ databaseName: name });
		const store = await openRoomIssuance(name);
		try {
			const retirement = await openRetirement(name);
			const read = (await retirement.acquireIssuance({ objectId }, store)) as Record<string, any>;
			await read.prepareFence(p);
			await retirement.commit();
		} finally {
			await store.close();
		}
	});

	it("refuses a legacy, foreign-database or closed issuance store before any write", async () => {
		const name = fresh("issuance-refusal"),
			other = fresh("issuance-other");
		await prepareBrowserRoomDatabase({ databaseName: name });
		await prepareBrowserRoomDatabase({ databaseName: other });
		const legacy = (await issuanceModule.createBrowserDurableIssuanceStore({
			primaryDatabaseName: `${name}-legacy`,
		})) as unknown as Closeable;
		const foreign = await openRoomIssuance(other);
		const closed = await openRoomIssuance(name);
		await closed.close();
		const retirement = await openRetirement(name);
		try {
			await expect(retirement.acquireIssuance({ objectId }, legacy)).rejects.toThrow();
			await expect(retirement.acquireIssuance({ objectId }, foreign)).rejects.toThrow();
			await expect(retirement.acquireIssuance({ objectId }, closed)).rejects.toThrow();
			await expect(retirement.acquireIssuance({ objectId }, {})).rejects.toThrow();
		} finally {
			await retirement.abort();
			await Promise.all([legacy.close(), foreign.close()]);
		}
	});

	it("acts for a genuine open room vote facet of its own database", async () => {
		const name = fresh("signing");
		await prepareBrowserRoomDatabase({ databaseName: name });
		const vote = await openRoomVote(name);
		try {
			const retirement = await openRetirement(name);
			const read = (await retirement.acquireSigning({ objectId }, true, vote.store)) as Record<string, any>;
			expect(
				(
					await read.prepareFence({
						throughEpoch: 3,
						protectedEpochs: [],
						decisionDigest: "d".repeat(64),
						sourceProofDigest: "e".repeat(64),
					})
				).ok
			).toBe(true);
			await retirement.commit();
		} finally {
			await vote.close();
		}
	});

	it("refuses a legacy, foreign-database or closed signing facet before any write", async () => {
		const name = fresh("signing-refusal"),
			other = fresh("signing-other");
		await prepareBrowserRoomDatabase({ databaseName: name });
		await prepareBrowserRoomDatabase({ databaseName: other });
		const legacy = await signingModule.openBrowserSealVoteStore({ databaseName: `${name}-legacy` });
		const foreign = await openRoomVote(other);
		const closed = await openRoomVote(name);
		await closed.close();
		const retirement = await openRetirement(name);
		try {
			await expect(retirement.acquireSigning({ objectId }, true, legacy.store)).rejects.toThrow();
			await expect(retirement.acquireSigning({ objectId }, true, foreign.store)).rejects.toThrow();
			await expect(retirement.acquireSigning({ objectId }, true, closed.store)).rejects.toThrow();
			await expect(retirement.acquireSigning({ objectId }, true, {})).rejects.toThrow();
		} finally {
			await retirement.abort();
			await Promise.all([legacy.close(), foreign.close()]);
		}
	});
});
