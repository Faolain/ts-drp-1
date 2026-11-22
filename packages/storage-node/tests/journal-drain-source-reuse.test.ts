import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

import { anchorMaterial } from "../../../tests/fixtures/journal-anchor-read/material.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "../../canonical/dist/src/index.js";
// The adapter's own module instance (the package entry), whose counters its reads advance.
import { journalRetirementDrainSourceCounts, journalRetirementFrameDigest } from "@ts-drp/live-journal";
import { createNodeDurableLiveJournalStore } from "../src/live-journal.js";

// A drain's ORIGINAL source (the journal image before the drain) does not change while the drain runs:
// each batch only moves rows from "present" to "retired". Every control acquisition and image read
// during the drain must still return that exact source (a mid-drain read carries it as drainSource).
// Re-deriving it on each of them decodes every frame, rebuilds every retired row and re-encodes the
// whole image: O(rows x batches) per drain, and the largest part of a retiring close (the 8.2 s seal
// for 238 rows, .logs/realtime-resume-2026-11-10/lull/probe-mfill400). The source is derived once per drain
// and reused, with each later read checked byte for byte against the residual journal.

type Store = ReturnType<typeof createNodeDurableLiveJournalStore> &
	Required<Pick<ReturnType<typeof createNodeDurableLiveJournalStore>, "readRetirementImage" | "acquireRetirementControl">>;
function open(filename: string, reopen = false): Store {
	return createNodeDurableLiveJournalStore({ primaryFilename: filename, ...(reopen ? { initialization: "reopen" as const } : {}) }) as Store;
}
function must<T>(result: Readonly<{ ok: false }> | Readonly<{ ok: true; value: T }>): T {
	if (!result.ok) throw new TypeError(`journal fixture failed: ${JSON.stringify(result)}`);
	return result.value;
}
const digest = (value: unknown) => Buffer.from(hashDomain("ts-drp/test-drain-source/v1", encodeCanonical(value))).toString("hex");
const ROWS = 70;

async function drainingJournal() {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-drain-source-reuse-"));
	const filename = join(directory, "journal.sqlite");
	const store = open(filename);
	const materials = Array.from({ length: 20 }, (_, epoch) => anchorMaterial(epoch));
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
	const expected = { control: source.control, image: source.image, canonicalRows: source.canonicalRows };
	return { directory, filename, store, selector, expected, items: rows.length + headers.length };
}

test("a drain derives its original source once and returns it byte for byte at every batch and after reopen", async () => {
	const fixture = await drainingJournal();
	let { store } = fixture;
	const { selector, expected } = fixture;
	try {
		const golden = digest(expected);
		const before = journalRetirementDrainSourceCounts();
		let batches = 0, reads = 0;
		for (;;) {
			const batch = must(await store.acquireRetirementControl(selector));
			const cursor = batch.control.drain!.cursor;
			if (cursor === fixture.items) { await batch.release(); break; }
			must(await batch.drainBatch()); await batch.release(); batches++;
			const read = must(await store.readRetirementImage(selector)); reads++;
			expect(digest(read.drainSource), `batch ${batches}`).toBe(golden);
			expect(read.drainSource).toEqual(expected);
		}
		expect(batches).toBeGreaterThanOrEqual(6);
		const work = journalRetirementDrainSourceCounts();
		// Every acquisition and read above needed the source: 2 per batch plus the final acquisition.
		expect(work.derivations + work.reuses - before.derivations - before.reuses).toBeGreaterThanOrEqual(2 * batches + 1);
		expect(work.derivations - before.derivations, "one derivation for the whole drain").toBe(1);
		// A reopened adapter derives it once more, and returns the same bytes.
		await store.close(); store = open(fixture.filename, true);
		const reopened = must(await store.readRetirementImage(selector));
		expect(digest(reopened.drainSource)).toBe(golden);
		expect(journalRetirementDrainSourceCounts().derivations - work.derivations).toBe(1);
	} finally { await store.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("a reused drain source never masks a changed residual journal row", async () => {
	const fixture = await drainingJournal();
	const { store, selector } = fixture;
	const raw = new DatabaseSync(`${fixture.filename}.drp-live-journal-v1.sqlite`);
	// The journal's triggers call the adapter's retirement predicate; this outside writer allows its edit.
	raw.function("journal_retirement_allows", (_objectId: unknown, _epoch: unknown, _anchor: unknown) => 1);
	try {
		const first = must(await store.acquireRetirementControl(selector)); must(await first.drainBatch()); await first.release();
		const partial = must(await store.readRetirementImage(selector));
		expect(partial.drainSource).toEqual(fixture.expected);
		// A residual (not yet retired) row changes underneath the drain.
		const changed = raw.prepare("UPDATE accepted_entries SET vertex_digest=? WHERE journal_sequence=(SELECT MAX(journal_sequence) FROM accepted_entries WHERE epoch=1)")
			.run("9".repeat(64));
		expect(Number(changed.changes)).toBe(1);
		expect((await store.readRetirementImage(selector)).ok).toBe(false);
		expect((await store.acquireRetirementControl(selector)).ok).toBe(false);
	} finally { raw.close(); await store.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("debug mode cross-checks every reused drain source against a fresh derivation", async () => {
	const prior = process.env.TS_DRP_DEBUG_DRAIN_SOURCE;
	process.env.TS_DRP_DEBUG_DRAIN_SOURCE = "1";
	const fixture = await drainingJournal();
	const { store, selector } = fixture;
	try {
		const before = journalRetirementDrainSourceCounts();
		for (let batch = 0; batch < 3; batch++) {
			const read = must(await store.acquireRetirementControl(selector)); must(await read.drainBatch()); await read.release();
			expect(must(await store.readRetirementImage(selector)).drainSource).toEqual(fixture.expected);
		}
		const work = journalRetirementDrainSourceCounts();
		// Each reuse was also derived afresh and compared (a divergence throws and the read fails).
		expect(work.reuses - before.reuses).toBeGreaterThan(0);
		expect(work.derivations - before.derivations).toBe(1 + work.reuses - before.reuses);
	} finally {
		if (prior === undefined) delete process.env.TS_DRP_DEBUG_DRAIN_SOURCE; else process.env.TS_DRP_DEBUG_DRAIN_SOURCE = prior;
		await store.close(); await rm(fixture.directory, { recursive: true, force: true });
	}
});
