import "fake-indexeddb/auto";
import {
	aheRetirementGenerationIdentity,
	digestBlob,
	encodeGenerationRecordV1,
	type AheDurableStore,
	type AheRetirementControl,
	type AheRetirementPreparation,
	type StoreResult,
} from "@ts-drp/storage";
import { describe, expect, it } from "vitest";

import { createBrowserAheDurableStore } from "../src/internal/idb-adapter.js";
import * as aheModule from "../src/internal/idb-adapter.js";
import { prepareBrowserRoomDatabase } from "../src/internal/schema-idb.js";
import { openInternalSealVoteStore } from "../src/internal/seal-vote-store.js";
import * as issuanceModule from "../src/issuance.js";
import { resolveBrowserDurableIssuancePruningMaintenance } from "../src/issuance-maintenance.js";
import * as journalModule from "../src/live-journal.js";
import * as maintenance from "../src/maintenance.js";
import * as snapshotModule from "../src/snapshot-transfer.js";

// Slice 14a (specs/bounded-storage-lifecycle/slices/14a-retention-database-format.md),
// RED items 4 and 5 at the owner boundary: each owner's existing retirement read and
// transitions run inside one room retirement session, write exactly what the owner's
// ordinary path writes, and leave nothing behind when the session aborts.
// fake-indexeddb is mechanism evidence only (native: 14f).

function must<T>(result: StoreResult<T>): T {
	if (!result.ok) throw new Error(result.reason);
	return result.value;
}

type Read = Readonly<Record<string, unknown>> & {
	control: Readonly<Record<string, unknown>>;
	release(): Promise<void>;
};
type Retirement = Readonly<{
	acquireAhe(store: AheDurableStore, objectId: string): Promise<StoreResult<Read>>;
	acquireSnapshot(store: unknown, input: Readonly<{ objectId: string }>): Promise<Read>;
	acquireJournal(store: unknown, input: Readonly<{ objectId: string }>): Promise<Readonly<Record<string, unknown>>>;
	acquireIssuance(input: Readonly<{ objectId: string }>): Promise<Read>;
	acquireSigning(input: Readonly<{ objectId: string }>, recovery?: boolean): Promise<Read>;
	checkpoint(): Promise<void>;
	commit(): Promise<void>;
	abort(cause?: unknown): Promise<void>;
}>;

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
const openAhe = (databaseName: string): Promise<Awaited<ReturnType<typeof createBrowserAheDurableStore>>> =>
	named<(input: Readonly<{ databaseName: string }>) => ReturnType<typeof createBrowserAheDurableStore>>(
		aheModule,
		"createBrowserRoomAheDurableStore"
	)({ databaseName });

let counter = 0;
const fresh = (label: string): string => `room-owner-retirement-${label}-${++counter}`;
const objectId = `room-retire:${"a".repeat(32)}` as never;
const withoutIncarnation = (control: unknown): unknown => ({ ...(control as object), incarnation: "*" });

async function seedAdopted(store: AheDurableStore) {
	const generationId = "b".repeat(64) as never,
		bytes = Uint8Array.of(1),
		digest = must(digestBlob(bytes));
	must(
		await store.beginGeneration({
			objectId,
			generationId,
			baseExpectedHead: { kind: "none", objectId },
			closure: [{ digest, byteLength: bytes.length }],
		})
	);
	must(await store.putCachedBlob({ objectId, generationId, digest, bytes }));
	must(await store.promoteReference({ objectId, generationId, digest }));
	must(await store.completeGeneration({ objectId, generationId }));
	const head = must(await store.swapHead({ objectId, generationId, expectedHead: { kind: "none", objectId } })).head;
	const generation = {
		objectId,
		generationId,
		state: "Adopted" as const,
		baseExpectedHead: { kind: "none" as const, objectId },
		closureDigest: head.closureDigest,
		closure: [{ digest, byteLength: bytes.length }],
	};
	const recordDigest = must(digestBlob(encodeGenerationRecordV1(generation)));
	const preparation: AheRetirementPreparation = {
		head,
		floorEpoch: 2,
		floorAnchor: "c".repeat(64),
		decisionDigest: "d".repeat(64),
		sourceProofDigest: "e".repeat(64),
		generationRecordDigests: [recordDigest],
		snapshotScopes: [],
		protectedIndices: [],
		retireIndices: [],
		domains: Array.from(
			{ length: 8 },
			(_, index) =>
				[2 ** index, new Uint8Array(32), new Uint8Array(32), 0, new Uint8Array(32), new Uint8Array(32), 0] as const
		),
	};
	const generations = {
		recordDigests: [recordDigest],
		identities: [{ generationId, identityDigest: aheRetirementGenerationIdentity(generation) }],
		protectedIndices: [0],
		retireIndices: [],
	};
	return { preparation, generations };
}

type AheRead = Readonly<{
	control: AheRetirementControl;
	prepareBound(input: unknown): Promise<StoreResult<unknown>>;
	commitPrepared(input: unknown): Promise<StoreResult<unknown>>;
	release(): Promise<void>;
}>;

describe("14a owner retirement inside one room session", () => {
	it("refuses a database that is not a ready room", async () => {
		await expect(openRetirement(fresh("missing"))).rejects.toThrow();
	});

	it("AHE prepare and commit in one session write exactly the ordinary path's control", async () => {
		const ordinaryName = fresh("ahe-ordinary"),
			sessionName = fresh("ahe-session");
		await prepareBrowserRoomDatabase({ databaseName: ordinaryName });
		await prepareBrowserRoomDatabase({ databaseName: sessionName });
		const ordinary = await openAhe(ordinaryName),
			inSession = await openAhe(sessionName);
		try {
			const plan = await seedAdopted(ordinary);
			await seedAdopted(inSession);
			const labels = { decisionDigest: "d".repeat(64), sourceProofDigest: "e".repeat(64) };

			const first = must(await ordinary.acquireRetirementControl!(objectId)) as unknown as AheRead;
			must(await first.prepareBound(plan));
			await first.release();
			const second = must(await ordinary.acquireRetirementControl!(objectId)) as unknown as AheRead;
			must(await second.commitPrepared(labels));
			await second.release();
			const expected = must(await ordinary.readRetirementImage!(objectId));

			const retirement = await openRetirement(sessionName);
			const prepare = must(await retirement.acquireAhe(inSession, objectId)) as unknown as AheRead;
			must(await prepare.prepareBound(plan));
			const commit = must(await retirement.acquireAhe(inSession, objectId)) as unknown as AheRead;
			expect(commit.control.active).not.toBeNull();
			must(await commit.commitPrepared(labels));
			await retirement.commit();
			const actual = must(await inSession.readRetirementImage!(objectId));

			expect(withoutIncarnation(actual.control)).toEqual(withoutIncarnation(expected.control));
			expect(actual.head).toEqual(expected.head);
			expect(actual.metadataBytes).toBe(expected.metadataBytes);
		} finally {
			await Promise.all([ordinary.close(), inSession.close()]);
		}
	});

	it("leaves no AHE control behind when the session aborts", async () => {
		const name = fresh("ahe-abort");
		await prepareBrowserRoomDatabase({ databaseName: name });
		const store = await openAhe(name);
		try {
			const plan = await seedAdopted(store);
			const retirement = await openRetirement(name);
			const read = must(await retirement.acquireAhe(store, objectId)) as unknown as AheRead;
			must(await read.prepareBound(plan));
			await retirement.abort(new Error("test abort"));
			// The birth and the prepared fence were in the aborted transaction.
			expect(await store.readRetirementImage!(objectId)).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
		} finally {
			await store.close();
		}
	});

	it("refuses an AHE store that is not a room-mode store of this database", async () => {
		const name = fresh("ahe-foreign");
		await prepareBrowserRoomDatabase({ databaseName: name });
		const legacy = await createBrowserAheDurableStore({ databaseName: `${name}--legacy` });
		const other = fresh("ahe-other");
		await prepareBrowserRoomDatabase({ databaseName: other });
		const foreign = await openAhe(other);
		const retirement = await openRetirement(name);
		try {
			await expect(retirement.acquireAhe(legacy, objectId)).rejects.toThrow();
			await expect(retirement.acquireAhe(foreign, objectId)).rejects.toThrow();
		} finally {
			await retirement.abort();
			await Promise.all([legacy.close(), foreign.close()]);
		}
	});

	it("issuance prepare and commit in one session write exactly the ordinary path's control", async () => {
		const open = named<(input: Readonly<{ databaseName: string }>) => Promise<Record<string, unknown>>>(
			issuanceModule,
			"createBrowserRoomDurableIssuanceStore"
		);
		const ordinaryName = fresh("issuance-ordinary"),
			sessionName = fresh("issuance-session");
		await prepareBrowserRoomDatabase({ databaseName: ordinaryName });
		await prepareBrowserRoomDatabase({ databaseName: sessionName });
		type IssuanceNative = {
			acquireRetirementControl(input: Readonly<{ objectId: string }>): Promise<Read & Record<string, any>>;
		};
		const nativeOf = (store: unknown): IssuanceNative =>
			resolveBrowserDurableIssuancePruningMaintenance(store as never) as unknown as IssuanceNative;
		const ordinaryStore = (await open({ databaseName: ordinaryName })) as { close(): Promise<void> };
		const ordinary = nativeOf(ordinaryStore);
		const p = {
			throughEpoch: 3,
			decisionDigest: "d".repeat(64),
			sourceProofDigest: "e".repeat(64),
			protectedRecords: [],
		};
		try {
			await (await ordinary.acquireRetirementControl({ objectId })).prepareFence(p);
			await (await ordinary.acquireRetirementControl({ objectId })).commitPrepared();
			const expected = (await ordinary.acquireRetirementControl({ objectId })).control;

			const retirement = await openRetirement(sessionName);
			await ((await retirement.acquireIssuance({ objectId })) as Record<string, any>).prepareFence(p);
			await ((await retirement.acquireIssuance({ objectId })) as Record<string, any>).commitPrepared();
			await retirement.commit();
			const reader = (await open({ databaseName: sessionName })) as { close(): Promise<void> };
			try {
				const actual = (await nativeOf(reader).acquireRetirementControl({ objectId })).control;
				expect(withoutIncarnation(actual)).toEqual(withoutIncarnation(expected));
			} finally {
				await reader.close();
			}
		} finally {
			await ordinaryStore.close();
		}
	});

	it("signing prepare and commit in one session write exactly the ordinary path's control", async () => {
		const ordinaryName = fresh("signing-ordinary"),
			sessionName = fresh("signing-session");
		await prepareBrowserRoomDatabase({ databaseName: ordinaryName });
		await prepareBrowserRoomDatabase({ databaseName: sessionName });
		const ordinary = await openInternalSealVoteStore({ databaseName: ordinaryName }, true);
		const p = {
			throughEpoch: 3,
			protectedEpochs: [],
			decisionDigest: "d".repeat(64),
			sourceProofDigest: "e".repeat(64),
		};
		try {
			const first = (await ordinary.acquireRecoveryRetirementObservation({ objectId })) as unknown as Read &
				Record<string, any>;
			expect((await first.prepareFence(p)).ok).toBe(true);
			const second = (await ordinary.acquireRecoveryRetirementObservation({ objectId })) as unknown as Read &
				Record<string, any>;
			expect((await second.commitPrepared()).ok).toBe(true);
			const expected = (await ordinary.acquireRecoveryRetirementObservation({ objectId })) as unknown as Read;
			await expected.release();

			const retirement = await openRetirement(sessionName);
			const prepare = (await retirement.acquireSigning({ objectId }, true)) as Record<string, any>;
			expect((await prepare.prepareFence(p)).ok).toBe(true);
			const commit = (await retirement.acquireSigning({ objectId }, true)) as Record<string, any>;
			expect((await commit.commitPrepared()).ok).toBe(true);
			await retirement.commit();
			const reader = await openInternalSealVoteStore({ databaseName: sessionName }, true);
			try {
				const actual = (await reader.acquireRecoveryRetirementObservation({ objectId })) as unknown as Read;
				expect(withoutIncarnation(actual.control)).toEqual(withoutIncarnation(expected.control));
				await actual.release();
			} finally {
				await reader.close();
			}
		} finally {
			await ordinary.close();
		}
	});

	it("journal and snapshot refuse an uninstalled object exactly as their ordinary paths do", async () => {
		const name = fresh("uninstalled");
		await prepareBrowserRoomDatabase({ databaseName: name });
		const journal = (await named<(input: Readonly<{ databaseName: string }>) => Promise<Record<string, any>>>(
			journalModule,
			"createBrowserRoomLiveJournalStore"
		)({ databaseName: name })) as Record<string, any>;
		const snapshot = (await named<(input: Readonly<{ databaseName: string }>) => Promise<Record<string, any>>>(
			snapshotModule,
			"createBrowserRoomSnapshotQuarantineStore"
		)({ databaseName: name })) as Record<string, any>;
		try {
			const ordinaryJournal = await journal.acquireRetirementControl({ objectId });
			const ordinarySnapshot = await snapshot.acquireRetirementControl({ objectId }).then(
				() => "acquired",
				(error: { code?: string }) => error.code
			);
			const retirement = await openRetirement(name);
			try {
				expect(await retirement.acquireJournal(journal, { objectId })).toEqual(ordinaryJournal);
				expect(
					await retirement.acquireSnapshot(snapshot, { objectId }).then(
						() => "acquired",
						(error: { code?: string }) => error.code
					)
				).toBe(ordinarySnapshot);
			} finally {
				await retirement.abort();
			}
		} finally {
			await Promise.all([journal.close(), snapshot.close()]);
		}
	});
});
