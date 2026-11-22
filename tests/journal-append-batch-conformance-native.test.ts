import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { runJournalAppendBatchConformance } from "./fixtures/journal-append-batch/conformance.js";
import { createNodeDurableLiveJournalStore } from "../packages/storage-node/src/live-journal.js";

// appendAcceptedLocalBatch conformance on the SQLite journal (the IndexedDB journals run the same driver in
// packages/storage-browser/tests/journal-append-batch.pw.ts). Every native transaction the store opens is
// counted from its BEGIN: BEGIN IMMEDIATE is a write, a plain BEGIN a read.

const stores: DurableLiveJournalStore[] = [];
const directories: string[] = [];
afterEach(async () => {
	await Promise.allSettled(stores.splice(0).map((store) => store.close()));
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("journals a chunk's local rows in one write and one readback, whole or not at all, as the same singles", async () => {
	const exec = DatabaseSync.prototype.exec;
	const count = { writes: 0, reads: 0 };
	DatabaseSync.prototype.exec = function (sql: string): void {
		if (sql.startsWith("BEGIN IMMEDIATE")) count.writes += 1;
		else if (sql.startsWith("BEGIN")) count.reads += 1;
		return exec.call(this, sql);
	};
	try {
		const report = await runJournalAppendBatchConformance(
			(name) => {
				const directory = mkdtempSync(join(tmpdir(), `journal-append-batch-${name}-`));
				directories.push(directory);
				const store = createNodeDurableLiveJournalStore({ primaryFilename: join(directory, "journal.sqlite") });
				stores.push(store);
				return Promise.resolve(store);
			},
			{
				reset: () => {
					count.writes = 0;
					count.reads = 0;
				},
				read: () => ({ ...count }),
			}
		);
		process.stdout.write(`JOURNAL_APPEND_BATCH_CONFORMANCE sqlite ${JSON.stringify(report)}\n`);
		expectConformance(report);
	} finally {
		DatabaseSync.prototype.exec = exec;
	}
});

/**
 * The expectations every native journal meets (the browser harness repeats them).
 * @param report - The driver's report.
 */
function expectConformance(report: Record<string, unknown>): void {
	expect(report.shape).toEqual({ batch: "function" });
	expect(report.commit).toMatchObject({
		ok: true,
		sequences: [2, 3, 4, 5, 6, 7, 8, 9],
		singleSequences: [2, 3, 4, 5, 6, 7, 8, 9],
		digests: true,
		rowCountBefore: 2,
		rowCountAfter: 10,
		postimageIsRead: true,
		imageEqualsSingles: true,
		rowsEqualSingles: true,
		// One write transaction and one readback read for the whole chunk (singles: one write and its
		// readback reads per row).
		transactions: { writes: 1, reads: 1 },
	});
	expect(report.stale).toEqual({ ok: false, kind: "retirement-stale", unchanged: true });
	expect(report.refusals).toEqual({
		exact: "evidence-conflict",
		conflict: "evidence-conflict",
		repeated: "malformed-input",
		empty: "malformed-input",
		oversized: "malformed-input",
		unchanged: true,
		thenValid: [10, 11],
	});
}
