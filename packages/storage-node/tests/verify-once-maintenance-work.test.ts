import {
	type AheRetirementPreparation,
	decodeAheRetirementControl,
	digestBlob,
	encodeAheRetirementControl,
	parseGenerationId,
	parseStorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test, vi } from "vitest";

import { anchorMaterial } from "../../../tests/fixtures/journal-anchor-read/material.js";
import { createSqliteAheDurableStore } from "../src/index.js";
import { createNodeDurableLiveJournalStore } from "../src/live-journal.js";

// Counts the actual codec work underneath the native AHE maintenance entry
// points: control admission (acquire), image point reads and control compare.
const work = vi.hoisted(() => ({ encode: 0, decode: 0, hash: 0 }));
vi.mock("@ts-drp/canonical", async (importOriginal) => {
	const original = await importOriginal<typeof import("@ts-drp/canonical")>();
	return {
		...original,
		encodeCanonical: (...args: Parameters<typeof original.encodeCanonical>) => {
			work.encode++;
			return original.encodeCanonical(...args);
		},
		decodeCanonical: (...args: Parameters<typeof original.decodeCanonical>) => {
			work.decode++;
			return original.decodeCanonical(...args);
		},
		hashDomain: (...args: Parameters<typeof original.hashDomain>) => {
			work.hash++;
			return original.hashDomain(...args);
		},
	};
});
vi.mock("@ts-drp/canonical/exact", async (importOriginal) => {
	const original = await importOriginal<typeof import("@ts-drp/canonical/exact")>();
	return {
		...original,
		decodeCanonicalExactness: (...args: Parameters<typeof original.decodeCanonicalExactness>) => {
			work.decode++;
			return original.decodeCanonicalExactness(...args);
		},
	};
});
async function measure<T>(operation: () => Promise<T>): Promise<[T, Readonly<{ encode: number; decode: number; hash: number }>]> {
	work.encode = 0;
	work.decode = 0;
	work.hash = 0;
	const result = await operation();
	return [result, { ...work }];
}

function must<T>(result: StoreResult<T> | Readonly<{ ok: false }> | Readonly<{ ok: true; value: T }>): T {
	if (!result.ok) throw new Error(`fixture refused: ${JSON.stringify(result)}`);
	return result.value;
}

let fixtureSeed = 0;
async function fixture() {
	const seed = ++fixtureSeed;
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-verify-once-"));
	const filename = join(directory, "store.sqlite");
	const store = createSqliteAheDurableStore({ filename });
	const raw = new DatabaseSync(filename);
	const objectId = must(parseStorageObjectId(`verify-once:${seed.toString(16).padStart(32, "0")}`));
	const noHead = { kind: "none" as const, objectId };
	const blobs = Array.from({ length: 6 }, (_, index) => {
		const bytes = new Uint8Array(2048);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + index * 5 + seed) & 0xff;
		return { bytes, digest: must(digestBlob(bytes)) };
	});
	let head: Awaited<ReturnType<typeof store.readHead>> extends StoreResult<infer H> ? H : never = noHead;
	for (const [index, slice] of [blobs.slice(0, 3), blobs.slice(3)].entries()) {
		const generationId = must(parseGenerationId(`${seed.toString(16)}${index}`.padStart(64, "a")));
		must(
			await store.beginGeneration({
				objectId,
				generationId,
				baseExpectedHead: head,
				closure: slice
					.map((blob) => ({ digest: blob.digest, byteLength: blob.bytes.byteLength }))
					.sort((a, b) => a.digest.localeCompare(b.digest)),
			})
		);
		for (const blob of slice) {
			must(await store.putCachedBlob({ objectId, generationId, digest: blob.digest, bytes: blob.bytes }));
			must(await store.promoteReference({ objectId, generationId, digest: blob.digest }));
		}
		must(await store.completeGeneration({ objectId, generationId }));
		head = must(await store.swapHead({ objectId, generationId, expectedHead: head })).head;
	}
	if (!store.acquireRetirementControl || !store.readRetirementImage || !store.readRetirementControl)
		throw new Error("AHE retirement ports unavailable");
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
			(_, i) => [2 ** i, new Uint8Array(32), new Uint8Array(32), 0, new Uint8Array(32), new Uint8Array(32), 0] as const
		),
	};
	return {
		store,
		raw,
		objectId,
		head,
		blobs,
		preparation,
		acquire: store.acquireRetirementControl.bind(store),
		image: store.readRetirementImage.bind(store),
		control: store.readRetirementControl.bind(store),
		controlRow: () =>
			raw.prepare("SELECT record FROM retirement_controls WHERE object_id=?").get(objectId)?.record as Uint8Array,
		async dispose() {
			raw.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

describe("native AHE maintenance verifies each exact byte string once", () => {
	test("control admission, image point and control compare do no repeated codec work in steady state", async () => {
		const f = await fixture();
		try {
			// Warm: birth the control and admit the image once.
			await must(await f.acquire(f.objectId)).release();
			must(await f.image(f.objectId));
			const [view, acquire] = await measure(async () => must(await f.acquire(f.objectId)));
			const [, image] = await measure(async () => must(await f.image(f.objectId)));
			const [prepared, compare] = await measure(() => view.prepare(f.preparation));
			expect(prepared).toMatchObject({ ok: true, value: { active: { phase: "prepared" } } });
			await view.release();
			const counts = { acquire, image, compare };
			console.info("native AHE steady-state work", JSON.stringify(counts));
			// Control admission: held row bytes and the admitted image are reused.
			expect(acquire).toEqual({ encode: 0, decode: 0, hash: 0 });
			// Image point: the held control bytes and admitted image are reused.
			expect(image).toEqual({ encode: 0, decode: 0, hash: 0 });
			// Compare: encode the proposed head and this fresh view's own head once
			// each (the latter is then held), encode the NEW control once and
			// verify the NEW row once (decode + canonical re-encode).
			expect(compare).toEqual({ encode: 4, decode: 1, hash: 0 });
			// Held bytes are exactly the canonical encoding of the readback.
			const readback = must(await f.control(f.objectId));
			expect(encodeAheRetirementControl(readback!)).toEqual(f.controlRow());
		} finally {
			await f.dispose();
		}
	});

	test("another connection's control rewrite, corruption, blob and generation change are never served stale", async () => {
		const f = await fixture();
		try {
			await must(await f.acquire(f.objectId)).release();
			must(await f.image(f.objectId));
			const before = must(await f.image(f.objectId));
			const original = f.controlRow();
			const control = must(decodeAheRetirementControl(original));
			// A valid same-length rewrite by another connection is read as written.
			const rewritten = encodeAheRetirementControl({ ...control, revision: control.revision + 1 });
			expect(rewritten.byteLength).toBe(original.byteLength);
			f.raw.prepare("UPDATE retirement_controls SET record=? WHERE object_id=?").run(rewritten, f.objectId);
			expect(must(await f.control(f.objectId))?.revision).toBe(control.revision + 1);
			expect(must(await f.image(f.objectId)).control?.revision).toBe(control.revision + 1);
			// A view acquired before another connection's rewrite is stale.
			const view = must(await f.acquire(f.objectId));
			f.raw.prepare("UPDATE retirement_controls SET record=? WHERE object_id=?").run(original, f.objectId);
			expect(await view.prepare(f.preparation)).toEqual({ ok: false, reason: "READ_STALE_ROLE_VIEW" });
			await view.release();
			// An in-place blob corruption keeps its digest key but not its bytes.
			const victim = f.blobs[4]!,
				corrupt = victim.bytes.slice();
			corrupt[1000] ^= 1;
			f.raw.prepare("UPDATE blobs SET bytes=? WHERE digest=?").run(corrupt, victim.digest);
			expect(await f.image(f.objectId)).toEqual({ ok: false, reason: "BLOB_CORRUPT" });
			f.raw.prepare("UPDATE blobs SET bytes=? WHERE digest=?").run(victim.bytes, victim.digest);
			expect(must(await f.image(f.objectId))).toEqual(before);
			// A noncanonical same-length control row is refused and poisons.
			const noncanonical = original.slice();
			noncanonical[noncanonical.length - 1] ^= 0xff;
			f.raw.prepare("UPDATE retirement_controls SET record=? WHERE object_id=?").run(noncanonical, f.objectId);
			expect(await f.acquire(f.objectId)).toEqual({ ok: false, reason: "NON_CANONICAL_RECORD" });
			expect(await f.acquire(f.objectId)).toEqual({ ok: false, reason: "STORE_POISONED" });
		} finally {
			await f.dispose();
		}
	});

	test("reopen reads the reopened file's bytes, not a prior connection's verification", async () => {
		const f = await fixture();
		const filename = (f.raw as unknown as { location(): string }).location();
		try {
			await must(await f.acquire(f.objectId)).release();
			const before = must(await f.image(f.objectId));
			await f.store.close();
			const original = f.controlRow(),
				control = must(decodeAheRetirementControl(original));
			f.raw
				.prepare("UPDATE retirement_controls SET record=? WHERE object_id=?")
				.run(encodeAheRetirementControl({ ...control, revision: control.revision + 5 }), f.objectId);
			const reopened = createSqliteAheDurableStore({ filename });
			try {
				const after = must(await reopened.readRetirementImage!(f.objectId));
				expect(after.control?.revision).toBe(control.revision + 5);
				expect(after.imageDigest).toBe(before.imageDigest);
			} finally {
				await reopened.close();
			}
		} finally {
			await f.dispose();
		}
	});

	test("journal control readback decodes and verifies identical control bytes once", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-drp-verify-once-journal-"));
		const primaryFilename = join(directory, "journal.sqlite");
		const store = createNodeDurableLiveJournalStore({ primaryFilename });
		const raw = new DatabaseSync(`${primaryFilename}.drp-live-journal-v1.sqlite`);
		try {
			const current = anchorMaterial(0),
				selector = { objectId: current.scope.objectId };
			if (!store.readRetirementImage || !store.acquireRetirementControl) throw new Error("journal retirement unavailable");
			must(await store.installGenesis(current.install));
			const born = must(await store.acquireRetirementControl(selector));
			await born.release();
			const first = must(await store.readRetirementImage(selector));
			const [second, journal] = await measure(async () => must(await store.readRetirementImage!(selector)));
			console.info("journal image point steady-state control work", JSON.stringify(journal));
			expect(second.control).toEqual(first.control);
			expect(second.control).not.toBe(first.control);
			// The control is not decoded or canonically re-verified again, and the
			// freshly scanned rows equal the remembered image's rows, so the image
			// is not re-hashed either. What remains is the exposed exact control
			// carrier encoding (encode 1).
			expect(journal).toEqual({ encode: 1, decode: 0, hash: 0 });
			// Another connection's same-length noncanonical control rewrite is refused.
			const row = raw.prepare("SELECT record FROM retirement_controls WHERE object_id=?").get(selector.objectId)
				?.record as Uint8Array;
			const corrupt = row.slice();
			corrupt[corrupt.length - 1] ^= 0xff;
			raw.prepare("UPDATE retirement_controls SET record=? WHERE object_id=?").run(corrupt, selector.objectId);
			expect((await store.readRetirementImage(selector)).ok).toBe(false);
		} finally {
			raw.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
