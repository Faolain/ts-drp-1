import { database, done, request } from "./browser-owner.js";
import {
	type AheRetirementPreparation,
	aheRetirementGenerationIdentity,
	decodeGenerationRecordV1,
	digestBlob,
	encodeGenerationRecordV1,
	parseGenerationId,
	parseStorageObjectId,
	type StoreResult,
} from "../../../packages/storage/dist/src/index.js";
import { createBrowserAheDurableStore } from "../../../packages/storage-browser/dist/src/index.js";

export type RetirementImageMutation = "unchanged" | "generation" | "promotion" | "cached-blob";

/** New store-local completion law; no authenticated all-owner eligibility premise. */
export async function retirementBoundCompletion(name: string): Promise<unknown> {
	const old = await createBrowserAheDurableStore({ databaseName: name }),
		store = await createBrowserAheDurableStore({ databaseName: name });
	try {
		const objectId = must(parseStorageObjectId(`future-fence:${"a".repeat(32)}`)),
			generationId = must(parseGenerationId("a".repeat(64))),
			bytes = Uint8Array.of(1),
			digest = must(digestBlob(bytes)),
			noHead = { kind: "none" as const, objectId };
		must(
			await store.beginGeneration({
				objectId,
				generationId,
				baseExpectedHead: noHead,
				closure: [{ digest, byteLength: 1 }],
			})
		);
		must(await store.putCachedBlob({ objectId, generationId, digest, bytes }));
		must(await store.promoteReference({ objectId, generationId, digest }));
		must(await store.completeGeneration({ objectId, generationId }));
		const head = must(await store.swapHead({ objectId, generationId, expectedHead: noHead })).head,
			row = must(await store.readGenerationPage({ objectId, limit: 7 })).generations[0]!;
		const preparation: AheRetirementPreparation = {
			head,
			floorEpoch: 0,
			floorAnchor: "c".repeat(64),
			decisionDigest: "d".repeat(64),
			sourceProofDigest: "e".repeat(64),
			generationRecordDigests: [],
			snapshotScopes: [],
			protectedIndices: [],
			retireIndices: [],
			domains: Array.from(
				{ length: 8 },
				(_, i) =>
					[2 ** i, new Uint8Array(32), new Uint8Array(32), 0, new Uint8Array(32), new Uint8Array(32), 0] as const
			),
		};
		const acquire = store.acquireRetirementControl!.bind(store),
			generations = {
				recordDigests: [must(digestBlob(encodeGenerationRecordV1(row)))],
				identities: [{ generationId, identityDigest: aheRetirementGenerationIdentity(row) }],
				protectedIndices: [0],
				retireIndices: [],
			};
		const before = must(await acquire(objectId)).control;
		const incomplete = await must(await acquire(objectId)).prepareBound({
			preparation,
			generations: { ...generations, identities: [] },
		});
		must(await must(await acquire(objectId)).prepareBound({ preparation, generations }));
		const wrongDecision = await must(await acquire(objectId)).commitPrepared({
			decisionDigest: "f".repeat(64),
			sourceProofDigest: preparation.sourceProofDigest,
		});
		const completed = must(
			await must(await acquire(objectId)).commitPrepared({
				decisionDigest: preparation.decisionDigest,
				sourceProofDigest: preparation.sourceProofDigest,
			})
		);
		const forged = await must(await acquire(objectId)).stageNominatedFutureGeneration({ epoch: 1 });
		const begin = {
			objectId,
			generationId: must(parseGenerationId("b".repeat(64))),
			baseExpectedHead: head,
			closure: [],
		};
		const preopened = await old.beginGeneration(begin),
			fresh = await createBrowserAheDurableStore({ databaseName: name });
		try {
			return {
				before,
				incomplete,
				wrongDecision,
				completed,
				forged,
				preopened,
				fresh: await fresh.beginGeneration(begin),
				page: must(await fresh.readGenerationPage({ objectId, limit: 7 })),
				head: must(await fresh.readHead(objectId)),
			};
		} finally {
			await fresh.close();
		}
	} finally {
		await old.close();
		await store.close();
		await request(indexedDB.deleteDatabase(name));
	}
}

function must<T>(result: StoreResult<T> | Readonly<{ ok: false }> | Readonly<{ ok: true; value: T }>): T {
	if (!result.ok) throw new TypeError("native retirement image fixture failed");
	return result.value;
}

/**
 * Exercises the native mechanical CAS; input commitments do not authenticate a protocol plan.
 * @param name - Owned fresh test database.
 * @param mutation - Original native foreign-write boundary.
 * @returns Actual delivered result and exact native control/head observations.
 */
export async function retirementImageCAS(name: string, mutation: RetirementImageMutation): Promise<unknown> {
	const store = await createBrowserAheDurableStore({ databaseName: name });
	const raw = await database(name);
	try {
		const objectId = must(parseStorageObjectId(`retirement-image:${"a".repeat(32)}`));
		const currentId = must(parseGenerationId("a".repeat(64)));
		const stagedId = must(parseGenerationId("b".repeat(64)));
		const currentBytes = Uint8Array.of(1),
			stagedBytes = Uint8Array.of(2);
		const currentDigest = must(digestBlob(currentBytes)),
			stagedDigest = must(digestBlob(stagedBytes));
		const noHead = { kind: "none" as const, objectId };
		must(
			await store.beginGeneration({
				objectId,
				generationId: currentId,
				baseExpectedHead: noHead,
				closure: [{ digest: currentDigest, byteLength: 1 }],
			})
		);
		must(await store.putCachedBlob({ objectId, generationId: currentId, digest: currentDigest, bytes: currentBytes }));
		must(await store.promoteReference({ objectId, generationId: currentId, digest: currentDigest }));
		must(await store.completeGeneration({ objectId, generationId: currentId }));
		const head = must(await store.swapHead({ objectId, generationId: currentId, expectedHead: noHead })).head;
		must(
			await store.beginGeneration({
				objectId,
				generationId: stagedId,
				baseExpectedHead: head,
				closure: [{ digest: stagedDigest, byteLength: 1 }],
			})
		);
		if (mutation === "promotion")
			must(await store.putCachedBlob({ objectId, generationId: stagedId, digest: stagedDigest, bytes: stagedBytes }));
		if (store.acquireRetirementControl === undefined) throw new TypeError("retirement control is unavailable");
		const control = must(await store.acquireRetirementControl(objectId));
		const preparation: AheRetirementPreparation = {
			head,
			floorEpoch: 2,
			floorAnchor: "c".repeat(64),
			decisionDigest: "d".repeat(64),
			sourceProofDigest: "e".repeat(64),
			generationRecordDigests: [],
			snapshotScopes: [],
			protectedIndices: [],
			retireIndices: [],
			domains: Array.from(
				{ length: 8 },
				(_, i) =>
					[2 ** i, new Uint8Array(32), new Uint8Array(32), 0, new Uint8Array(32), new Uint8Array(32), 0] as const
			),
		};
		const readControl = async (): Promise<Uint8Array> => {
			const tx = raw.transaction("storageMeta", "readonly"),
				completion = done(tx);
			const row = await request(tx.objectStore("storageMeta").get(`ahe-retirement:${objectId}`));
			await completion;
			return row.record as Uint8Array;
		};
		const before = await readControl();
		if (mutation !== "unchanged") {
			const table = mutation === "generation" ? "generations" : mutation === "promotion" ? "promotions" : "blobs";
			const tx = raw.transaction(table, "readwrite", { durability: "strict" }),
				completion = done(tx);
			const rows = tx.objectStore(table);
			if (mutation === "generation") {
				const row = await request(rows.get([objectId, stagedId]));
				const generation = must(decodeGenerationRecordV1(row.record as Uint8Array));
				await request(rows.put({ ...row, record: encodeGenerationRecordV1({ ...generation, state: "Discarded" }) }));
			} else if (mutation === "promotion")
				await request(rows.put({ objectId, generationId: stagedId, digest: stagedDigest }));
			else await request(rows.put({ digest: stagedDigest, bytes: stagedBytes }));
			await completion;
		}
		const result = await control.prepare(preparation);
		const after = await readControl(),
			currentHead = must(await store.readHead(objectId));
		await control.release();
		return {
			mutation,
			result,
			imageDigest: control.imageDigest,
			controlUnchanged: before.byteLength === after.byteLength && before.every((n, i) => n === after[i]),
			headUnchanged: JSON.stringify(currentHead) === JSON.stringify(head),
		};
	} finally {
		raw.close();
		await store.close();
		await request(indexedDB.deleteDatabase(name));
	}
}
