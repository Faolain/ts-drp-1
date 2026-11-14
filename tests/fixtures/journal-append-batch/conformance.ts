import type { DurableLiveJournalStore, LiveJournalScope } from "@ts-drp/live-journal";

import { encodeJournalRetirementControl } from "../../../packages/live-journal/src/index.js";
import { anchorMaterial } from "../journal-anchor-read/material.js";

// appendAcceptedLocalBatch conformance, one driver for every native journal (the SQLite store in
// tests/journal-append-batch-conformance-native.test.ts, both IndexedDB stores in
// packages/storage-browser/tests/journal-append-batch.pw.ts). A drain chunk's freshly issued local rows
// are journaled in ONE native write transaction and read back in ONE read, instead of one write and its
// readback reads per row. The batch leaves exactly the native state the same rows appended singly (each
// source-bound, chained on the previous postimage) leave; it commits whole or refuses whole.

type NativeImage = Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }>;
type BatchRow = Readonly<{ author: string; authorSequence: number; vertexDigest: string }>;
type BatchResult =
	| Readonly<{
			ok: true;
			scope: LiveJournalScope;
			rows: readonly Readonly<{ journalSequence: number; vertexDigest: string }>[];
			nativeImage: NativeImage;
	  }>
	| Readonly<{ ok: false; kind: string }>;
type BatchStore = DurableLiveJournalStore & {
	appendAcceptedLocalBatch?(
		input: Readonly<{ scope: LiveJournalScope; rows: readonly BatchRow[]; expectedNativeImage: NativeImage }>
	): Promise<BatchResult>;
};
/** Native transactions the store opens while counting (write: readwrite / BEGIN IMMEDIATE; read: the rest). */
export interface TransactionCounter {
	reset(): void;
	read(): Readonly<{ writes: number; reads: number }>;
}

const SEEDED = 2;
const BATCH = 8;
const MAX_ROWS = 16;
const digest = (ordinal: number): string => ordinal.toString(16).padStart(2, "0").repeat(32);
const row = (authorSequence: number, vertexDigest = digest(authorSequence + 1)): BatchRow =>
	Object.freeze({ author: "writer", authorSequence, vertexDigest });

async function image(store: DurableLiveJournalStore, objectId: string): Promise<NativeImage & { rowCount: number }> {
	if (store.readRetirementImage === undefined) throw new Error("the journal has no retirement image read");
	const read = await store.readRetirementImage({ objectId });
	if (!read.ok) throw new Error(`retirement image refused: ${JSON.stringify(read)}`);
	return {
		imageDigest: read.value.image.imageDigest,
		controlBytes: read.value.control === null ? null : encodeJournalRetirementControl(read.value.control),
		rowCount: read.value.image.rowCount,
	};
}
async function rows(store: DurableLiveJournalStore, scope: LiveJournalScope): Promise<string> {
	const ready = await store.readiness({ scope });
	if (!ready.ok || !ready.ready) throw new Error(`readiness refused: ${JSON.stringify(ready)}`);
	const page = await store.readPage({ scope, snapshot: ready.snapshot, afterSequence: null, limit: 128 });
	if (!page.ok) throw new Error(`page refused: ${JSON.stringify(page)}`);
	return JSON.stringify(page.rows.map((value) => ({ ...value })));
}
const sameBytes = (left: Uint8Array | null, right: Uint8Array | null): boolean =>
	left === null || right === null
		? left === right
		: left.length === right.length && left.every((byte, index) => byte === right[index]);
const sameImage = (left: NativeImage, right: NativeImage): boolean =>
	left.imageDigest === right.imageDigest && sameBytes(left.controlBytes, right.controlBytes);
const nativeOf = (value: NativeImage): NativeImage => ({
	imageDigest: value.imageDigest,
	controlBytes: value.controlBytes,
});

/**
 * Runs the batched local journal append conformance over freshly opened journals.
 * @param open - Opens a fresh empty journal store under a name unique to the case.
 * @param counter - Counts the native transactions the store opens.
 * @returns A JSON report of every case (the harness asserts it).
 */
export async function runJournalAppendBatchConformance(
	open: (name: string) => Promise<DurableLiveJournalStore>,
	counter: TransactionCounter
): Promise<Record<string, unknown>> {
	const material = anchorMaterial(0);
	const { scope } = material;
	const seeded = async (name: string): Promise<BatchStore> => {
		const store = (await open(name)) as BatchStore;
		const installed = await store.installGenesis(material.install);
		if (!installed.ok) throw new Error(`genesis refused: ${JSON.stringify(installed)}`);
		for (let sequence = 0; sequence < SEEDED; sequence++) {
			const appended = await store.appendAccepted({ scope, sourceKind: "local-issued", ...row(sequence) });
			if (!appended.ok) throw new Error(`seed refused: ${JSON.stringify(appended)}`);
		}
		return store;
	};
	const report: Record<string, unknown> = {};
	const batched = await seeded("batched");
	report.shape = { batch: typeof batched.appendAcceptedLocalBatch };
	if (typeof batched.appendAcceptedLocalBatch !== "function") return report;
	const singles = await seeded("singles");
	const chunk = Array.from({ length: BATCH }, (_, index) => row(SEEDED + index));

	// The same rows appended singly, each source-bound on the previous postimage (the per-row path today).
	let chained = nativeOf(await image(singles, scope.objectId));
	const singleSequences: number[] = [];
	counter.reset();
	for (const value of chunk) {
		const appended = await singles.appendAccepted({
			scope,
			sourceKind: "local-issued",
			...value,
			expectedNativeImage: chained,
		});
		if (!appended.ok || appended.nativeImage === undefined)
			throw new Error(`single refused: ${JSON.stringify(appended)}`);
		singleSequences.push(appended.journalSequence);
		chained = appended.nativeImage;
	}
	const singleTransactions = counter.read();

	const before = await image(batched, scope.objectId);
	counter.reset();
	const committed = await batched.appendAcceptedLocalBatch({
		scope,
		rows: chunk,
		expectedNativeImage: nativeOf(before),
	});
	const transactions = counter.read();
	if (!committed.ok) {
		report.commit = { ok: false, kind: committed.kind };
		return report;
	}
	const after = await image(batched, scope.objectId);
	const singlesAfter = await image(singles, scope.objectId);
	report.commit = {
		ok: true,
		sequences: committed.rows.map((value) => value.journalSequence),
		singleSequences,
		digests:
			committed.rows.map((value) => value.vertexDigest).join() === chunk.map((value) => value.vertexDigest).join(),
		rowCountBefore: before.rowCount,
		rowCountAfter: after.rowCount,
		postimageIsRead: sameImage(committed.nativeImage, after),
		imageEqualsSingles: sameImage(after, singlesAfter) && sameImage(committed.nativeImage, chained),
		rowsEqualSingles: (await rows(batched, scope)) === (await rows(singles, scope)),
		transactions,
		singleTransactions,
	};

	// A stale expected image refuses the whole batch with nothing written.
	const stale = await batched.appendAcceptedLocalBatch({
		scope,
		rows: [row(SEEDED + BATCH)],
		expectedNativeImage: nativeOf(before),
	});
	report.stale = { ...stale, unchanged: sameImage(await image(batched, scope.objectId), after) };

	// A row already journaled (exactly, or as another digest at the same local reference) refuses the whole
	// batch with nothing written; so does a batch repeating a row of its own.
	const next = (offset: number): BatchRow => row(SEEDED + BATCH + offset);
	const current = nativeOf(after);
	const exact = await batched.appendAcceptedLocalBatch({
		scope,
		rows: [next(0), row(SEEDED), next(1)],
		expectedNativeImage: current,
	});
	const conflict = await batched.appendAcceptedLocalBatch({
		scope,
		rows: [next(0), next(1), row(SEEDED + 1, digest(200))],
		expectedNativeImage: current,
	});
	const repeated = await batched.appendAcceptedLocalBatch({
		scope,
		rows: [next(0), next(0)],
		expectedNativeImage: current,
	});
	const empty = await batched.appendAcceptedLocalBatch({ scope, rows: [], expectedNativeImage: current });
	const oversized = await batched.appendAcceptedLocalBatch({
		scope,
		rows: Array.from({ length: MAX_ROWS + 1 }, (_, index) => next(index)),
		expectedNativeImage: current,
	});
	const unchanged = sameImage(await image(batched, scope.objectId), after);
	// Nothing was poisoned: the next valid batch commits.
	const valid = await batched.appendAcceptedLocalBatch({
		scope,
		rows: [next(0), next(1)],
		expectedNativeImage: current,
	});
	report.refusals = {
		exact: exact.ok ? "ok" : exact.kind,
		conflict: conflict.ok ? "ok" : conflict.kind,
		repeated: repeated.ok ? "ok" : repeated.kind,
		empty: empty.ok ? "ok" : empty.kind,
		oversized: oversized.ok ? "ok" : oversized.kind,
		unchanged,
		thenValid: valid.ok ? valid.rows.map((value) => value.journalSequence) : valid.kind,
	};
	return report;
}
