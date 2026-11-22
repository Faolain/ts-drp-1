import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeJournalRetirementControl } from "@ts-drp/live-journal";
import { describe, expect, test, vi } from "vitest";

import { anchorMaterial } from "../../../tests/fixtures/journal-anchor-read/material.js";
import { createNodeDurableLiveJournalStore } from "../src/live-journal.js";

// Verify-once contract for the native live-journal retirement image. Every
// maintenance control acquisition, image point read and source-bound append
// re-captures every scope and accepted row of the object through the canonical
// capture codec and hashes the complete image, although the image is a pure
// function of the exact rows. Byte-identical rows need capturing once; any row
// change (own write, another connection, deletion, insertion) is captured again.
const work = vi.hoisted(() => ({ captured: 0, imageHash: 0 }));
// Native rows the store iterates (every full image scan reads each scope and accepted row).
const scans = vi.hoisted(() => ({ rows: 0 }));
vi.mock("../src/internal/sqlite-iterator.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/internal/sqlite-iterator.js")>();
	return {
		...original,
		iterateSqliteRows: function* (...args: Parameters<typeof original.iterateSqliteRows>) {
			for (const row of original.iterateSqliteRows(...args)) {
				scans.rows++;
				yield row;
			}
		},
	};
});
vi.mock("@ts-drp/canonical/encoding-capture", async (importOriginal) => {
	const original = await importOriginal<typeof import("@ts-drp/canonical/encoding-capture")>();
	return {
		...original,
		createCanonicalEncodingCapture: () => {
			const owner = original.createCanonicalEncodingCapture();
			return Object.freeze({
				capture: (...args: Parameters<typeof owner.capture>) => {
					work.captured++;
					return owner.capture(...args);
				},
				encode: (...args: Parameters<typeof owner.encode>) => {
					work.captured++;
					return owner.encode(...args);
				},
				release: () => owner.release(),
			});
		},
	};
});
vi.mock("@ts-drp/canonical", async (importOriginal) => {
	const original = await importOriginal<typeof import("@ts-drp/canonical")>();
	return {
		...original,
		hashDomain: (...args: Parameters<typeof original.hashDomain>) => {
			if (args[0] === "ts-drp/live-journal-retirement-image/v1") work.imageHash++;
			return original.hashDomain(...args);
		},
	};
});
async function measure<T>(operation: () => Promise<T>): Promise<[T, Readonly<{ captured: number; imageHash: number }>]> {
	work.captured = 0;
	work.imageHash = 0;
	const result = await operation();
	return [result, { ...work }];
}
function must<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
	if (!result.ok) throw new Error(`fixture refused: ${JSON.stringify(result)}`);
	return result.value;
}

const ROWS = 6;
async function journal() {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-journal-image-once-"));
	const primaryFilename = join(directory, "journal.sqlite");
	const current = anchorMaterial(0),
		selector = { objectId: current.scope.objectId };
	const open = () => {
		const store = createNodeDurableLiveJournalStore({ primaryFilename });
		if (!store.readRetirementImage || !store.acquireRetirementControl) throw new Error("journal retirement unavailable");
		return store as typeof store & Required<Pick<typeof store, "readRetirementImage" | "acquireRetirementControl">>;
	};
	const store = open();
	expect(await store.installGenesis(current.install)).toMatchObject({ ok: true });
	for (let ordinal = 0; ordinal < ROWS; ordinal++)
		expect(await store.appendAccepted({ scope: current.scope, sourceKind: "local-issued", author: "creator",
			authorSequence: ordinal, vertexDigest: ordinal.toString(16).repeat(64).slice(0, 64) })).toMatchObject({ ok: true });
	await must(await store.acquireRetirementControl(selector)).release();
	const raw = new DatabaseSync(`${primaryFilename}.drp-live-journal-v1.sqlite`);
	// The native write triggers consult the owner's retirement fence; this foreign writer bypasses it.
	raw.function("journal_retirement_allows", (_objectId, _epoch, _anchorDigest) => 1);
	return { directory, current, selector, store, raw, open };
}

describe("native live-journal retirement image verify-once work counts", () => {
	test("repeated image point reads and control acquisitions capture and hash unchanged rows once", async () => {
		const { directory, selector, store, raw } = await journal();
		try {
			const first = must(await store.readRetirementImage(selector));
			expect(first.image.rowCount).toBe(ROWS);
			const [reads, readWork] = await measure(async () => {
				const out = [];
				for (let read = 0; read < 6; read++) out.push(must(await store.readRetirementImage(selector)));
				return out;
			});
			console.info("six image point reads of 1 scope + 6 rows", JSON.stringify(readWork));
			for (const read of reads) {
				expect(read.image).toEqual(first.image);
				expect(read.canonicalRows).toEqual(first.canonicalRows);
			}
			expect(readWork).toEqual({ captured: 0, imageHash: 0 });
			const [, acquireWork] = await measure(async () => {
				for (let acquire = 0; acquire < 6; acquire++) await must(await store.acquireRetirementControl(selector)).release();
			});
			console.info("six control acquisitions of 1 scope + 6 rows", JSON.stringify(acquireWork));
			expect(acquireWork).toEqual({ captured: 0, imageHash: 0 });
		} finally {
			raw.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("native live-journal retirement image unchanged-database answers", () => {
	test("unchanged committed rows answer without a scan; any commit, DDL or own write scans again", async () => {
		const { directory, current, selector, store, raw } = await journal();
		const scanned = async <T>(operation: () => Promise<T>): Promise<[T, number, Readonly<{ captured: number; imageHash: number }>]> => {
			scans.rows = 0;
			const [result, counted] = await measure(operation);
			return [result, scans.rows, counted];
		};
		try {
			const first = must(await store.readRetirementImage(selector));
			// The read that verified the rows recorded the committed currency: no further scan.
			const [reads, readRows] = await scanned(async () => {
				const out = [];
				for (let read = 0; read < 4; read++) out.push(must(await store.readRetirementImage(selector)));
				return out;
			});
			expect(readRows).toBe(0);
			for (const read of reads) {
				expect(read.image).toEqual(first.image);
				expect(read.canonicalRows).toEqual(first.canonicalRows);
			}
			// Another connection's DDL that changes no row: scanned (and matched) again, then answered unscanned.
			raw.exec("CREATE TABLE unrelated(x)");
			const [afterDdl, ddlRows, ddlWork] = await scanned(async () => must(await store.readRetirementImage(selector)));
			expect(ddlRows).toBeGreaterThanOrEqual(ROWS + 1);
			expect(ddlWork).toEqual({ captured: 0, imageHash: 0 });
			expect(afterDdl.image).toEqual(first.image);
			expect((await scanned(async () => must(await store.readRetirementImage(selector))))[1]).toBe(0);
			// Another connection's commit that rewrites a value with itself: scanned again.
			raw.prepare("UPDATE accepted_entries SET vertex_digest=vertex_digest WHERE object_id=?").run(selector.objectId);
			const [, sameRows, sameWork] = await scanned(async () => must(await store.readRetirementImage(selector)));
			expect(sameRows).toBeGreaterThanOrEqual(ROWS + 1);
			expect(sameWork).toEqual({ captured: 0, imageHash: 0 });
			// Another connection's commit that changes a value: scanned, captured and hashed again.
			raw.prepare("UPDATE accepted_entries SET vertex_digest=? WHERE object_id=? AND local_author_sequence=?")
				.run("f".repeat(64), selector.objectId, 1);
			const [rewritten, rewriteRows, rewriteWork] = await scanned(async () => must(await store.readRetirementImage(selector)));
			expect(rewriteRows).toBeGreaterThanOrEqual(ROWS + 1);
			expect(rewriteWork.imageHash).toBe(1);
			expect(rewritten.image.imageDigest).not.toBe(first.image.imageDigest);
			// This connection's own append: scanned, captured and hashed again.
			expect(await store.appendAccepted({ scope: current.scope, sourceKind: "local-issued", author: "creator",
				authorSequence: ROWS, vertexDigest: "e".repeat(64) })).toMatchObject({ ok: true });
			const [appended, appendRows, appendWork] = await scanned(async () => must(await store.readRetirementImage(selector)));
			expect(appendRows).toBeGreaterThanOrEqual(ROWS + 2);
			expect(appendWork.imageHash).toBe(1);
			expect(appended.image.rowCount).toBe(ROWS + 1);
			expect((await scanned(async () => must(await store.readRetirementImage(selector))))[1]).toBe(0);
		} finally {
			raw.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("native live-journal retirement image after a source-bound append", () => {
	test("the append's own postimage capture answers the next point read: no second capture, hash or scan", async () => {
		const { directory, current, selector, store, raw, open } = await journal();
		let reopened: ReturnType<typeof open> | undefined;
		try {
			const before = must(await store.readRetirementImage(selector));
			const appended = await store.appendAccepted({ scope: current.scope, sourceKind: "local-issued", author: "creator",
				authorSequence: ROWS, vertexDigest: "e".repeat(64),
				expectedNativeImage: { imageDigest: before.image.imageDigest,
					controlBytes: before.control === null ? null : encodeJournalRetirementControl(before.control) } });
			if (!appended.ok || appended.nativeImage === undefined) throw new Error(`source-bound append refused: ${JSON.stringify(appended)}`);
			scans.rows = 0;
			const [after, afterWork] = await measure(async () => must(await store.readRetirementImage(selector)));
			expect(afterWork).toEqual({ captured: 0, imageHash: 0 });
			expect(scans.rows).toBe(0);
			expect(after.image.imageDigest).toBe(appended.nativeImage.imageDigest);
			expect(after.image.rowCount).toBe(ROWS + 1);
			// The remembered frames are exactly what a brand-new connection captures from scratch.
			await store.close();
			reopened = open();
			const fresh = must(await reopened.readRetirementImage(selector));
			expect(fresh.image).toEqual(after.image);
			expect(fresh.canonicalRows).toEqual(after.canonicalRows);
		} finally {
			raw.close();
			await (reopened ?? store).close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("native live-journal retirement image verify-once soundness", () => {
	test("own appends, another connection's rewrite, deletion and insertion are captured again", async () => {
		const { directory, current, selector, store, raw, open } = await journal();
		let reopened: ReturnType<typeof open> | undefined;
		try {
			const before = must(await store.readRetirementImage(selector));
			// Own append: one more row than the remembered image.
			expect(await store.appendAccepted({ scope: current.scope, sourceKind: "local-issued", author: "creator",
				authorSequence: ROWS, vertexDigest: "e".repeat(64) })).toMatchObject({ ok: true });
			const [appended, appendWork] = await measure(async () => must(await store.readRetirementImage(selector)));
			expect(appended.image.rowCount).toBe(ROWS + 1);
			expect(appended.image.imageDigest).not.toBe(before.image.imageDigest);
			expect(appendWork.imageHash).toBe(1);
			// Another connection rewrites one existing row value in place (same length).
			raw.prepare("UPDATE accepted_entries SET vertex_digest=? WHERE object_id=? AND local_author_sequence=?")
				.run("f".repeat(64), selector.objectId, 2);
			const [rewritten, rewriteWork] = await measure(async () => must(await store.readRetirementImage(selector)));
			expect(rewritten.image.rowCount).toBe(ROWS + 1);
			expect(rewritten.image.imageDigest).not.toBe(appended.image.imageDigest);
			expect(rewriteWork.imageHash).toBe(1);
			// Another connection deletes the last row: the scan is a strict prefix of the remembered rows.
			raw.prepare("DELETE FROM accepted_entries WHERE object_id=? AND local_author_sequence=?").run(selector.objectId, ROWS);
			const [deleted, deleteWork] = await measure(async () => must(await store.readRetirementImage(selector)));
			expect(deleted.image.rowCount).toBe(ROWS);
			expect(deleteWork.imageHash).toBe(1);
			// Each changed image equals what a brand-new connection captures from scratch.
			await store.close();
			reopened = open();
			const fresh = must(await reopened.readRetirementImage(selector));
			expect(fresh.image).toEqual(deleted.image);
			expect(fresh.canonicalRows).toEqual(deleted.canonicalRows);
		} finally {
			raw.close();
			await (reopened ?? store).close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("a refused capture is never remembered and the restored rows still verify", async () => {
		const { directory, selector, store, raw } = await journal();
		try {
			const before = must(await store.readRetirementImage(selector));
			// Within the per-blob SQL bound, but the complete image now exceeds its byte ceiling.
			raw.prepare("UPDATE scopes SET closed_membership_bytes=? WHERE object_id=?").run(new Uint8Array(2_097_152), selector.objectId);
			for (let read = 0; read < 2; read++) {
				const [refused, refusedWork] = await measure(() => store.readRetirementImage(selector));
				expect(refused.ok).toBe(false);
				expect(refusedWork.captured).toBeGreaterThan(0);
			}
			raw.prepare("UPDATE scopes SET closed_membership_bytes=NULL WHERE object_id=?").run(selector.objectId);
			const [restored, restoredWork] = await measure(async () => must(await store.readRetirementImage(selector)));
			expect(restored.image).toEqual(before.image);
			expect(restoredWork).toEqual({ captured: 0, imageHash: 0 });
		} finally {
			raw.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("a mutated returned row carrier never reaches a later read", async () => {
		const { directory, selector, store, raw } = await journal();
		try {
			const first = must(await store.readRetirementImage(selector));
			const pristine = first.canonicalRows.map((bytes) => bytes.slice());
			expect(Object.isFrozen(first.image)).toBe(true);
			for (const bytes of first.canonicalRows) bytes.fill(0);
			const second = must(await store.readRetirementImage(selector));
			expect(second.canonicalRows).toEqual(pristine);
			for (const bytes of second.canonicalRows) bytes.fill(0xff);
			const [third, thirdWork] = await measure(async () => must(await store.readRetirementImage(selector)));
			expect(third.canonicalRows).toEqual(pristine);
			expect(thirdWork).toEqual({ captured: 0, imageHash: 0 });
		} finally {
			raw.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
