import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";

import { censusGridStorage } from "./fixtures/grid-memory-storage-census.js";
import { encodeCanonical } from "../packages/canonical/src/index.js";
import { encodeGenerationRecordV1, encodeHeadRecordV1 } from "../packages/storage/src/codecs.js";
import type { ExpectedHead, ParseResult } from "../packages/storage/src/types.js";
import {
	digestBlob,
	digestClosure,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
} from "../packages/storage/src/values.js";

function parsed<T>(result: ParseResult<T>): T {
	if (!result.ok) throw new Error(`invalid lineage fixture: ${result.reason}`);
	return result.value;
}

it("attributes rollback only to the active head's two actual ancestors, not older or disconnected Superseded rows", async () => {
	const factory = new IDBFactory();
	const name = "grid-census-actual-rollback-lineage";
	const objectId = parsed(parseStorageObjectId(`creator:${"d".repeat(32)}`));
	let parent: ExpectedHead = { kind: "none", objectId };
	const generations = [];
	const blobs = [];
	for (const epoch of [3, 4, 5, 6, 7]) {
		const generationId = parsed(parseGenerationId(String(epoch).repeat(64)));
		const bytes = encodeCanonical({ epoch });
		const digest = parsed(digestBlob(bytes));
		const closure = [{ digest, byteLength: bytes.byteLength }];
		const closureDigest = parsed(digestClosure(closure));
		generations.push({
			objectId,
			generationId,
			record: encodeGenerationRecordV1({
				objectId,
				generationId,
				baseExpectedHead: epoch === 4 ? { kind: "none", objectId } : parent,
				closure,
				closureDigest,
				state: epoch === 7 ? "Adopted" : "Superseded",
			}),
		});
		blobs.push({ digest, bytes });
		parent = { kind: "present", objectId, generationId, revision: parsed(parseHeadRevision(epoch)), closureDigest };
	}
	const opening = factory.open(name, 1);
	opening.onupgradeneeded = (): void => {
		opening.result.createObjectStore("objects", { keyPath: "objectId" });
		opening.result.createObjectStore("generations", { keyPath: ["objectId", "generationId"] });
		opening.result.createObjectStore("blobs", { keyPath: "digest" });
		opening.result.createObjectStore("promotions", { keyPath: ["objectId", "generationId", "digest"] });
	};
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		opening.onsuccess = (): void => resolve(opening.result);
		opening.onerror = (): void => reject(opening.error);
	});
	try {
		const transaction = database.transaction(["objects", "generations", "blobs", "promotions"], "readwrite");
		const done = new Promise<void>((resolve, reject) => {
			transaction.oncomplete = (): void => resolve();
			transaction.onabort = (): void => reject(transaction.error);
			transaction.onerror = (): void => reject(transaction.error);
		});
		transaction.objectStore("objects").put({ objectId, record: encodeHeadRecordV1(parent) });
		for (const generation of generations) transaction.objectStore("generations").put(generation);
		for (const blob of blobs) transaction.objectStore("blobs").put(blob);
		await done;
	} finally {
		database.close();
	}
	const rows = await censusGridStorage({ factory, databaseNames: [name], currentEpoch: 7, now: 1000 });
	for (const store of ["generations", "blobs"]) {
		expect(
			rows
				.filter((row) => row.store === store)
				.map(({ epoch, retentionStatus, rows: count }) => ({ epoch, retentionStatus, count }))
				.sort((a, b) => a.epoch.localeCompare(b.epoch))
		).toEqual([
			{ epoch: "3", retentionStatus: "superseded", count: 1 },
			{ epoch: "4", retentionStatus: "superseded", count: 1 },
			{ epoch: "5", retentionStatus: "rollback", count: 1 },
			{ epoch: "6", retentionStatus: "rollback", count: 1 },
			{ epoch: "7", retentionStatus: "active", count: 1 },
		]);
	}
	expect(rows.find((row) => row.store === "objects")).toMatchObject({ epoch: "7", retentionStatus: "active", rows: 1 });
});
