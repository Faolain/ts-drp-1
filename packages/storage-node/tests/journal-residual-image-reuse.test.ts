import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";

import { anchorMaterial } from "../../../tests/fixtures/journal-anchor-read/material.js";
import { decodeCanonical } from "../../canonical/dist/src/index.js";
// The adapter's own module instance (the package entry).
import { createJournalRetirementImageCapture, journalRetirementFrameDigest, journalRetirementImageOfCapturedFrames } from "@ts-drp/live-journal";
import { createNodeDurableLiveJournalStore, journalResidualImageCounts } from "../src/live-journal.js";

// A drain removes at most LIVE_JOURNAL_RETIREMENT_BATCH_ROWS items per batch, and every batch's control
// acquisitions, native CAS and readbacks need the residual journal image (the object's exact native rows).
// Scanning, capturing and validating that whole residual again at each of them costs O(rows) per
// acquisition, so O(rows x batches) per drain: the retiring close's seal pause. The residual image is
// verified once and then reused only while the bytes prove it is exactly the previous residual minus the
// retired items: the native CAS's own deletions, each of exactly one row the plan names, and no other row
// change (the connection's change count), under its exclusive write transaction; and, across transactions,
// an unchanged committed database (no other connection's commit, no own write, no DDL). The plan's
// own rows are validated once per plan, and its native rows once per drain, extended batch by batch.

// Native rows the store iterates (a full image scan reads each scope and accepted row once).
const work = vi.hoisted(() => ({ scanned: 0, captured: 0, validated: 0 }));
vi.mock("../src/internal/sqlite-iterator.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/internal/sqlite-iterator.js")>();
	return {
		...original,
		iterateSqliteRows: function* (...args: Parameters<typeof original.iterateSqliteRows>) {
			for (const row of original.iterateSqliteRows(...args)) {
				work.scanned++;
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
				capture: (...args: Parameters<typeof owner.capture>) => { work.captured++; return owner.capture(...args); },
				encode: (...args: Parameters<typeof owner.encode>) => { work.captured++; return owner.encode(...args); },
				release: () => owner.release(),
			});
		},
	};
});
// The adapter validates each drain plan row natively by its frame digest (one call per plan row validated).
vi.mock("@ts-drp/live-journal", async (importOriginal) => {
	const original = await importOriginal<typeof import("@ts-drp/live-journal")>();
	return {
		...original,
		journalRetirementFrameDigest: (...args: Parameters<typeof original.journalRetirementFrameDigest>) => {
			work.validated++;
			return original.journalRetirementFrameDigest(...args);
		},
	};
});

type Store = ReturnType<typeof createNodeDurableLiveJournalStore> &
	Required<Pick<ReturnType<typeof createNodeDurableLiveJournalStore>, "readRetirementImage" | "acquireRetirementControl">>;
function open(filename: string, reopen = false): Store {
	return createNodeDurableLiveJournalStore({ primaryFilename: filename, ...(reopen ? { initialization: "reopen" as const } : {}) }) as Store;
}
function must<T>(result: Readonly<{ ok: false }> | Readonly<{ ok: true; value: T }>): T {
	if (!result.ok) throw new TypeError(`journal fixture failed: ${JSON.stringify(result)}`);
	return result.value;
}
const ROWS = 120, EPOCHS = 20;

/**
 * An independent full capture of the object's native rows, straight from SQLite through the original
 * image capture: the golden residual image (digest, counts, frames) the store must return.
 */
function golden(raw: DatabaseSync, objectId: string) {
	const capture = createJournalRetirementImageCapture(), frames: Uint8Array[] = [];
	try {
		for (const row of raw.prepare("SELECT object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier,closed_membership_bytes FROM scopes WHERE object_id=? ORDER BY epoch,anchor_digest").all(objectId)) {
			const captured: Record<string, unknown> = { ...row };
			if (captured.closed_membership_bytes === null) delete captured.closed_membership_bytes;
			frames.push(capture.append("scopes", captured, [captured.object_id, captured.epoch, captured.anchor_digest])!);
		}
		for (const row of raw.prepare("SELECT object_id,epoch,anchor_digest,journal_sequence,source_kind,vertex_digest,received_preimage,received_signature,local_author,local_author_sequence FROM accepted_entries WHERE object_id=? ORDER BY epoch,anchor_digest,journal_sequence").all(objectId)) {
			const captured: Record<string, unknown> = { ...row };
			frames.push(capture.append("accepted_entries", captured, [captured.object_id, captured.epoch, captured.anchor_digest, captured.journal_sequence])!);
		}
		return { image: capture.finish(), frames };
	} finally { capture.release(); }
}

async function drainingJournal() {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-residual-image-reuse-"));
	const filename = join(directory, "journal.sqlite");
	const store = open(filename);
	const materials = Array.from({ length: EPOCHS }, (_, epoch) => anchorMaterial(epoch));
	const selector = { objectId: materials[0]!.scope.objectId };
	must(await store.installGenesis(materials[0]!.install));
	for (const material of materials.slice(1)) must(await store.installEpochAnchor(material.install));
	for (let sequence = 0; sequence < ROWS; sequence++)
		must(await store.appendAccepted({ scope: materials[1]!.scope, sourceKind: "local-issued", author: "creator",
			authorSequence: sequence, vertexDigest: sequence.toString(16).padStart(64, "0") }));
	const prepare = must(await store.acquireRetirementControl(selector));
	must(await prepare.prepareFence({ throughEpoch: 18, protectedScopes: [materials[18]!.scope], decisionDigest: "e".repeat(64), sourceProofDigest: "f".repeat(64) }));
	await prepare.release();
	const commit = must(await store.acquireRetirementControl(selector));
	must(await commit.commitPrepared()); await commit.release();
	const source = must(await store.readRetirementImage(selector));
	if (source.control === null) throw new Error("fence control missing");
	const rows = source.canonicalRows.flatMap(bytes => {
		const [table, , row] = decodeCanonical(bytes) as [string, unknown, Record<string, unknown>];
		return table === "accepted_entries" ? [{ journalSequence: row.journal_sequence as number, vertexDigest: row.vertex_digest as string,
			author: row.local_author as string, authorSequence: row.local_author_sequence as number, nativeFrameDigest: journalRetirementFrameDigest(bytes) }] : [];
	});
	const headers = source.canonicalRows.flatMap(bytes => {
		const [table, key] = decodeCanonical(bytes) as [string, unknown[]];
		return table === "scopes" && typeof key[1] === "number" && key[1] >= 2 && key[1] <= 17
			? [{ scope: materials[key[1]]!.scope, exactCanonicalNativeFrameBytes: bytes }] : [];
	});
	const plan = { baseControl: source.control, sourceImage: source.image, prefixes: [{ scope: materials[1]!.scope, highWatermark: ROWS, rows }],
		retiredEmptyHeaders: headers, protectedHeaderScopes: [materials[0]!.scope, materials[18]!.scope, materials[19]!.scope] };
	const begin = must(await store.acquireRetirementControl(selector)); must(await begin.beginDrain(plan)); await begin.release();
	const raw = new DatabaseSync(`${filename}.drp-live-journal-v1.sqlite`);
	// The journal's triggers call the adapter's retirement predicate; this outside connection allows its edits.
	raw.function("journal_retirement_allows", (_objectId: unknown, _epoch: unknown, _anchor: unknown) => 1);
	return { directory, filename, store, raw, selector, sourceRows: source.canonicalRows.length, items: rows.length + headers.length };
}

/** One batch the way the creator's close drains (drainClosedJournalDetails): acquire and drain, then read back. */
async function batch(store: Store, selector: Readonly<{ objectId: string }>) {
	const drain = must(await store.acquireRetirementControl(selector));
	must(await drain.drainBatch()); await drain.release();
	const readback = must(await store.acquireRetirementControl(selector));
	const control = readback.control, image = readback.image, rows = readback.readExactCanonicalRows();
	await readback.release();
	const read = must(await store.readRetirementImage(selector));
	return { control, image, rows, read };
}

test("a drain verifies its residual image once and returns the exact residual at every batch and after reopen", async () => {
	const fixture = await drainingJournal();
	let { store } = fixture;
	const { selector, raw } = fixture;
	try {
		const start = { ...work }, derivedBefore = journalResidualImageCounts().derived;
		let batches = 0;
		for (;;) {
			const { control, image, rows, read } = await batch(store, selector);
			batches++;
			const pause = { ...work };
			const expected = golden(raw, selector.objectId);
			Object.assign(work, pause);
			expect(image, `batch ${batches} control image`).toEqual(expected.image);
			expect(rows, `batch ${batches} control rows`).toEqual(expected.frames);
			expect(read.image, `batch ${batches} read image`).toEqual(expected.image);
			expect(read.canonicalRows, `batch ${batches} read rows`).toEqual(expected.frames);
			expect(control.drain!.residualImageDigest).toBe(expected.image.imageDigest);
			if (control.drain!.cursor === fixture.items) break;
		}
		expect(batches).toBeGreaterThanOrEqual(8);
		const spent = { scanned: work.scanned - start.scanned, captured: work.captured - start.captured, validated: work.validated - start.validated };
		console.info(`drain of ${fixture.items} items (${fixture.sourceRows} source rows) in ${batches} batches`, JSON.stringify(spent));
		// O(rows) per drain, not O(rows x batches): at most one further scan and capture of the source's
		// rows, and one native validation of each plan row, for the whole drain.
		expect(spent.scanned, "rows scanned per drain").toBeLessThanOrEqual(2 * fixture.sourceRows);
		expect(spent.captured, "rows captured per drain").toBeLessThanOrEqual(2 * fixture.sourceRows);
		expect(spent.validated, "plan rows validated per drain").toBeLessThanOrEqual(2 * fixture.items);
		expect(journalResidualImageCounts().derived - derivedBefore, "each batch derives its residual").toBeGreaterThanOrEqual(batches);
		// A reopened adapter scans and captures once more, and returns the same bytes.
		const last = golden(raw, selector.objectId);
		await store.close(); store = open(fixture.filename, true);
		const reopened = must(await store.readRetirementImage(selector));
		expect(reopened.image).toEqual(last.image);
		expect(reopened.canonicalRows).toEqual(last.frames);
	} finally { raw.close(); await store.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("a reused residual never masks another connection's change to a residual row, header or control", async () => {
	for (const edit of [
		"UPDATE accepted_entries SET vertex_digest='9999999999999999999999999999999999999999999999999999999999999999' WHERE journal_sequence=(SELECT MAX(journal_sequence) FROM accepted_entries WHERE epoch=1)",
		"DELETE FROM accepted_entries WHERE journal_sequence=(SELECT MAX(journal_sequence) FROM accepted_entries WHERE epoch=1)",
		"UPDATE scopes SET next_journal_sequence=next_journal_sequence+1 WHERE epoch=1",
		"DELETE FROM scopes WHERE epoch=17",
	]) {
		const fixture = await drainingJournal();
		const { store, selector, raw } = fixture;
		try {
			await batch(store, selector);
			await batch(store, selector);
			expect(Number(raw.prepare(edit).run().changes), edit).toBe(1);
			expect((await store.readRetirementImage(selector)).ok, edit).toBe(false);
			expect((await store.acquireRetirementControl(selector)).ok, edit).toBe(false);
		} finally { raw.close(); await store.close(); await rm(fixture.directory, { recursive: true, force: true }); }
	}
});

test("an unrelated commit by another connection makes the next read verify the residual again, with the same bytes", async () => {
	const fixture = await drainingJournal();
	const { store, selector, raw } = fixture;
	try {
		await batch(store, selector);
		raw.exec("CREATE TABLE IF NOT EXISTS outside_marker(x)");
		raw.prepare("INSERT INTO outside_marker VALUES(1)").run();
		const before = work.scanned;
		const read = must(await store.readRetirementImage(selector));
		expect(work.scanned - before, "another connection's commit makes the read scan").toBeGreaterThan(0);
		const pause = { ...work }, expected = golden(raw, selector.objectId); Object.assign(work, pause);
		expect(read.image).toEqual(expected.image);
		expect(read.canonicalRows).toEqual(expected.frames);
		// The drain continues to completion from the re-verified image.
		for (;;) { const next = await batch(store, selector); if (next.control.drain!.cursor === fixture.items) break; }
	} finally { raw.close(); await store.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("debug mode cross-checks every derived residual against a full native capture and validation", async () => {
	const prior = process.env.TS_DRP_DEBUG_RESIDUAL_IMAGE;
	process.env.TS_DRP_DEBUG_RESIDUAL_IMAGE = "1";
	const fixture = await drainingJournal();
	const { store, selector, raw } = fixture;
	try {
		const before = journalResidualImageCounts();
		for (;;) {
			const { control, read } = await batch(store, selector);
			const pause = { ...work }, expected = golden(raw, selector.objectId); Object.assign(work, pause);
			expect(read.image).toEqual(expected.image);
			if (control.drain!.cursor === fixture.items) break;
		}
		const after = journalResidualImageCounts();
		expect(after.derived - before.derived).toBeGreaterThan(0);
		// Each derivation was also captured and validated in full, and compared (a divergence throws).
		expect(after.crossChecked - before.crossChecked).toBe(after.derived - before.derived);
	} finally {
		if (prior === undefined) delete process.env.TS_DRP_DEBUG_RESIDUAL_IMAGE; else process.env.TS_DRP_DEBUG_RESIDUAL_IMAGE = prior;
		raw.close(); await store.close(); await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("the residual image assembled from a capture's frames equals a full capture of the same rows, for every subset", () => {
	// Scopes with, without and with a NULL closed membership, received rows with native blobs, local rows, multibyte text.
	const scopes = Array.from({ length: 5 }, (_, epoch) => ({ object_id: "room-\u00e9", epoch, anchor_digest: `${epoch}`.repeat(64),
		next_journal_sequence: epoch * 3, exact_anchor_preimage: new Uint8Array(40 + epoch).fill(epoch), detached_anchor_signature: new Uint8Array(64).fill(9),
		parameters_digest: "p".repeat(64), exact_parameters_carrier: new Uint8Array(300).fill(epoch + 1),
		...(epoch % 2 === 0 ? { closed_membership_bytes: new Uint8Array(17).fill(3) } : epoch === 3 ? { closed_membership_bytes: null } : {}) }));
	const rows = Array.from({ length: 300 }, (_, sequence) => sequence % 3 === 0
		? { object_id: "room-\u00e9", epoch: 1, anchor_digest: "1".repeat(64), journal_sequence: sequence, source_kind: "received",
			vertex_digest: sequence.toString(16).padStart(64, "0"), received_preimage: new Uint8Array(200 + sequence).fill(sequence & 0xff),
			received_signature: new Uint8Array(64).fill(1), local_author: null, local_author_sequence: null }
		: { object_id: "room-\u00e9", epoch: 1, anchor_digest: "1".repeat(64), journal_sequence: sequence, source_kind: "local-issued",
			vertex_digest: sequence.toString(16).padStart(64, "0"), received_preimage: null, received_signature: null,
			local_author: "creator-\u4e16", local_author_sequence: sequence });
	const capture = (keep: (table: string, index: number) => boolean) => {
		const owner = createJournalRetirementImageCapture(), frames: { table: string; key: unknown[]; bytes: Uint8Array }[] = [];
		scopes.forEach((row, index) => { if (keep("scopes", index)) { const key = [row.object_id, row.epoch, row.anchor_digest];
			frames.push({ table: "scopes", key, bytes: owner.append("scopes", { ...row }, key)! }); } });
		rows.forEach((row, index) => { if (keep("accepted_entries", index)) { const key = [row.object_id, row.epoch, row.anchor_digest, row.journal_sequence];
			frames.push({ table: "accepted_entries", key, bytes: owner.append("accepted_entries", { ...row }, key)! }); } });
		return { image: owner.finish(), frames };
	};
	const all = capture(() => true);
	expect(journalRetirementImageOfCapturedFrames(all.frames)).toEqual(all.image);
	let seed = 7;
	const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	for (let trial = 0; trial < 40; trial++) {
		const keepScopes = scopes.map(() => random() < 0.7), keepRows = rows.map(() => random() < (trial % 4) / 4 + 0.1);
		const keep = (table: string, index: number) => (table === "scopes" ? keepScopes : keepRows)[index]!;
		const subset = all.frames.filter((frame, index) => keep(frame.table, frame.table === "scopes" ? index : index - scopes.length));
		expect(journalRetirementImageOfCapturedFrames(subset), `trial ${trial}`).toEqual(capture(keep).image);
	}
	expect(journalRetirementImageOfCapturedFrames([])).toEqual(capture(() => false).image);
	// A frame that is not exactly the capture's [table, key, row] shape is not assembled (the caller captures).
	const first = all.frames[0]!;
	expect(journalRetirementImageOfCapturedFrames([{ ...first, key: [...first.key.slice(0, 2), "x".repeat(64)] }])).toBeUndefined();
	expect(journalRetirementImageOfCapturedFrames([{ ...first, table: "accepted_entries" }])).toBeUndefined();
	const truncated = first.bytes.slice(); truncated[1] = 0x02;
	expect(journalRetirementImageOfCapturedFrames([{ ...first, bytes: truncated }])).toBeUndefined();
});
