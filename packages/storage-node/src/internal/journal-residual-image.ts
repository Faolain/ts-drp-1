import { compareBytes } from "@ts-drp/canonical";
import {
	type JournalRetirementCapturedFrame,
	type JournalRetirementDrainItem,
	journalRetirementImageOfCapturedFrames,
	type LiveJournalRetirementControl,
	type LiveJournalRetirementImage,
	type LiveJournalScope,
} from "@ts-drp/live-journal";
import type { DatabaseSync } from "node:sqlite";

import type { JournalImageEntry, JournalImageRowKey } from "./journal-image-memo.js";

// Verified-once residual image of a live-journal drain (see the drain CAS in live-journal.ts).
//
// A drain batch deletes, inside one exclusive write transaction, exactly the plan items from its cursor
// on. The residual journal after the batch is then exactly the residual before it minus those rows,
// provided (all checked by the CAS): the rows before were verified in that same transaction (an image
// memo entry the transaction's own scan, match or unchanged answer returned); each DELETE removed one
// row by its primary key; and the connection's change count moved by exactly the number of deletions
// (total_changes() counts every row any statement or trigger program inserts, updates or deletes, so no
// other row changed) with no DDL. The residual entry is then derived from the verified entry's private
// rows and frames, and its image assembled from the frames' exact row syntax, instead of scanning and
// capturing every residual row again (O(rows) per batch, so O(rows x batches) per drain).
//
// The drain's native validation (validateDrainNativeRows) is a pure function of the plan, the cursor and
// the object's native rows (every column it reads is in the image's rows; the schema is fixed). So a
// validation is remembered against the exact plan bytes, the cursor and the verified entry of those
// rows, and holds again whenever that entry is verified current. The CAS extends it from cursor c to
// c + k when its exact deletions are plan items c .. c+k-1: retired items stay absent, kept items are
// unchanged, each prefix's count falls by its own deleted rows, and no header it reads was deleted.
//
// Debug mode (TS_DRP_DEBUG_RESIDUAL_IMAGE=1) also captures and validates every derived residual in full
// and refuses any divergence.

/** Work counts of residual-image derivation in this process. Measurement only, never authority. */
export interface JournalResidualImageCounts {
	/** Residual images derived from the previous verified residual minus a CAS's own exact deletions. */
	readonly derived: number;
	/** Derivations also captured and validated in full and compared (debug mode). */
	readonly crossChecked: number;
}
const residualWork = { derived: 0, crossChecked: 0 };

/** @returns This process's residual-image derivation counts so far. */
export function journalResidualImageCounts(): JournalResidualImageCounts {
	return Object.freeze({ ...residualWork });
}

/** Records one debug-mode cross-check (the caller compared a full capture and validation). */
export function countResidualCrossCheck(): void {
	residualWork.crossChecked++;
}

function frameKey(row: JournalImageRowKey): readonly unknown[] | undefined {
	const table = row[0];
	if (row[1] !== "object_id" || row[3] !== "epoch" || row[5] !== "anchor_digest") return undefined;
	if (table === "scopes") return [row[2], row[4], row[6]];
	if (table !== "accepted_entries" || row[7] !== "journal_sequence") return undefined;
	return [row[2], row[4], row[6], row[8]];
}

function sameScope(key: readonly unknown[], scope: LiveJournalScope): boolean {
	return key[0] === scope.objectId && key[1] === scope.epoch && key[2] === scope.anchorDigest;
}

/** A residual entry's rows, frames and image, before the memo remembers it. */
export type DerivedResidual = Readonly<{
	rows: readonly JournalImageRowKey[];
	frames: readonly Uint8Array[];
	image: LiveJournalRetirementImage;
}>;

/**
 * The verified entry's rows minus exactly the deleted items, with its exact image.
 * @param entry - The entry verified for the rows before the deletions, in the same transaction.
 * @param deletions - The items the transaction deleted, each one row by its primary key.
 * @returns The residual, or undefined when any deleted item is not exactly one of the entry's rows or a
 * frame is not of the capture's exact shape (the caller then captures the residual in full).
 */
export function deriveResidual(entry: Readonly<JournalImageEntry>, deletions: readonly JournalRetirementDrainItem[]):
	DerivedResidual | undefined {
	const frames = entry.frames;
	if (frames === undefined || frames.length !== entry.rows.length) return undefined;
	const keys = entry.rows.map(frameKey);
	const deleted = new Uint8Array(keys.length);
	for (const selected of deletions) {
		let found = -1;
		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];
			if (key === undefined) return undefined;
			const table = entry.rows[index]![0];
			const matches = "row" in selected
				? table === "accepted_entries" && sameScope(key, selected.scope) && key[3] === selected.row.journalSequence
				: table === "scopes" && sameScope(key, selected.scope);
			if (!matches) continue;
			if (found !== -1 || deleted[index] === 1) return undefined;
			found = index;
		}
		if (found === -1) return undefined;
		deleted[found] = 1;
	}
	const rows: JournalImageRowKey[] = [], kept: Uint8Array[] = [], captured: JournalRetirementCapturedFrame[] = [];
	for (let index = 0; index < keys.length; index++) {
		if (deleted[index] === 1) continue;
		const row = entry.rows[index]!, bytes = frames[index]!;
		rows.push(row);
		kept.push(bytes);
		captured.push({ table: row[0] as string, key: keys[index]!, bytes });
	}
	const image = journalRetirementImageOfCapturedFrames(captured);
	if (image === undefined) return undefined;
	residualWork.derived++;
	return Object.freeze({ rows: Object.freeze(rows), frames: Object.freeze(kept), image });
}

/**
 * Whether a batch's deletions are exactly the plan's items from the control's cursor on, so the
 * validation at the old cursor extends to the new one (see above).
 * @param actual - The control the transaction read (validated at its cursor).
 * @param next - The control the transaction writes.
 * @param deletions - The transaction's exact deletions, in order.
 * @returns Whether next's validation follows from actual's and the exact deletions.
 */
export function extendsDrainValidation(
	actual: LiveJournalRetirementControl,
	next: LiveJournalRetirementControl,
	deletions: readonly JournalRetirementDrainItem[]
): boolean {
	const state = actual.drain, after = next.drain;
	if (state == null || after == null || after.cursor !== state.cursor + deletions.length) return false;
	const plan = state.plan;
	let index = 0, matched = 0;
	const inBatch = (): boolean => index >= state.cursor && index < after.cursor;
	for (const prefix of plan.prefixes) {
		for (const row of prefix.rows) {
			if (inBatch()) {
				const selected = deletions[index - state.cursor];
				if (selected === undefined || !("row" in selected) || selected.row.journalSequence !== row.journalSequence ||
					selected.scope.objectId !== prefix.scope.objectId || selected.scope.epoch !== prefix.scope.epoch ||
					selected.scope.anchorDigest !== prefix.scope.anchorDigest) return false;
				matched++;
			}
			index++;
		}
	}
	for (const header of plan.retiredEmptyHeaders ?? []) {
		if (inBatch()) {
			const selected = deletions[index - state.cursor];
			if (selected === undefined || "row" in selected || selected.scope.objectId !== header.scope.objectId ||
				selected.scope.epoch !== header.scope.epoch || selected.scope.anchorDigest !== header.scope.anchorDigest) return false;
			// A deleted header must not be one a prefix's validation reads.
			if (plan.prefixes.some((prefix) => prefix.scope.objectId === header.scope.objectId &&
				prefix.scope.epoch === header.scope.epoch && prefix.scope.anchorDigest === header.scope.anchorDigest)) return false;
			matched++;
		}
		index++;
	}
	return matched === deletions.length;
}

// The last native drain validation of each connection: one drain at a time, retained with the connection.
const validations = new WeakMap<DatabaseSync, Readonly<{ entry: object; planBytes: Uint8Array; cursor: number }>>();

/**
 * @param database - The connection.
 * @param entry - The image entry verified current for the object's rows in this transaction.
 * @param planBytes - The exact plan carrier bytes the control was decoded from.
 * @param cursor - The control's cursor.
 * @returns Whether the drain's native rows were validated for exactly this plan, cursor and rows.
 */
export function drainValidated(database: DatabaseSync, entry: object, planBytes: Uint8Array, cursor: number): boolean {
	const known = validations.get(database);
	return known !== undefined && known.entry === entry && known.cursor === cursor && compareBytes(known.planBytes, planBytes) === 0;
}

/**
 * Remembers a successful native drain validation (see {@link drainValidated}).
 * @param database - The connection.
 * @param entry - The image entry verified current for the validated rows.
 * @param planBytes - The exact plan carrier bytes.
 * @param cursor - The validated cursor.
 */
export function rememberDrainValidated(database: DatabaseSync, entry: object, planBytes: Uint8Array, cursor: number): void {
	validations.set(database, Object.freeze({ entry, planBytes: planBytes.slice(), cursor }));
}
