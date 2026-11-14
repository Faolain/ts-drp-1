import { issuanceSettlementReserveForecast } from "@ts-drp/issuance-store/maintenance";
import type { V3RoomAcceptedVertex } from "@ts-drp/node/v3-room";
import { encodeCanonical } from "@ts-drp/canonical";

/**
 * Creator-side forecast of each settlement Writer's own admission (fix/capacity-refusal-prompt-roll).
 *
 * A settlement-profile Writer admits a new own move only while its issuance image, plus one settlement
 * replacement for every own row of the move's epoch, fits its row and byte bound (issuance-store
 * issuanceSettlementReplacementReserveCharge). A refused move is never signed, so nothing about it reaches
 * the creator: without this forecast the Writer waits for the creator's budget or idle trigger. The
 * creator already admits every row of that Writer, and a Writer's author sequences are contiguous, so it
 * can bound the Writer's own rows: the rows of the epochs the Writer still retains (its own window,
 * V3_SETTLEMENT_OWN_WINDOW_EPOCHS = 4, plus one epoch for an install that skipped its turnover) and the
 * current epoch's rows, each at the widest preimage that Writer sent. The arithmetic is issuance-store's
 * (issuanceSettlementReserveForecast), shared with the Writer's own admission and never above it.
 *
 * Only admitted rows enter (the policy's `observe`). Bounded state (G21): per author, one entry per epoch
 * of the retained window, for at most V3_ROOM_WRITER_CAPACITY_AUTHORS_MAX authors; the least recently
 * active author is dropped first (its next rows start a new window, so its forecast is low until the
 * window refills; the budget and idle triggers still apply to it).
 *
 * Not covered: rows that never reach the creator (it cannot count them), and a Writer whose retention
 * stalls past the window (an author fence withheld). The silence trigger is the backstop for an
 * underestimate; the idle trigger remains the last one.
 */

/** Authors tracked at once; past it the least recently active is dropped. */
export const V3_ROOM_WRITER_CAPACITY_AUTHORS_MAX = 256;
/** Epochs before the current one whose own rows a Writer may still hold (own window 4, plus 1). */
export const V3_ROOM_WRITER_RETAINED_EPOCHS = 5;

type EpochSpan = { epoch: number; first: number; last: number };
type AuthorWindow = {
	spans: EpochSpan[];
	preimageBytes: number;
	lastAt: number;
	gapMs: number;
};

export type V3RoomWriterCapacityReading = Readonly<{
	author: string;
	/** Further own moves the Writer can surely admit in the current epoch. */
	moves: number;
	/** Share of the Writer's admission already used, 0..1 (moves left against moves admitted so far). */
	used: number;
	/** The Writer's recent gap between own moves (ms), for the trigger's margin and its silence. */
	gapMs: number;
}>;

export interface V3RoomWriterCapacity {
	/** One admitted vertex of the current epoch; returns that author's reading. */
	observe(vertex: Pick<V3RoomAcceptedVertex, "author" | "epoch" | "authorSequence"> & Partial<V3RoomAcceptedVertex>, epoch: number): V3RoomWriterCapacityReading | undefined;
	/** Authors tracked (tests, bounds). */
	size(): number;
}

/**
 * Creates the bounded per-author forecast.
 * @param input - The room's object, its dependency bound and the clock.
 * @param input.objectId - The room object.
 * @param input.maxDependencies - The room parameters' dependency bound.
 * @param input.now - Milliseconds clock.
 * @returns The forecast.
 */
export function createV3RoomWriterCapacity(input: Readonly<{ objectId: string; maxDependencies: number; now?: () => number }>): V3RoomWriterCapacity {
	const now = input.now ?? ((): number => performance.now());
	const authors = new Map<string, AuthorWindow>();
	// The row's canonical preimage is the canonical encoding of its registered fields, which the admitted
	// view carries (the digest is not one of them); a field the registry omits at its default only makes
	// this longer, so it bounds the Writer's preimage from above.
	const preimageLength = (vertex: Partial<V3RoomAcceptedVertex>): number | undefined => {
		const { digest: _digest, ...fields } = vertex;
		if (fields.operation === undefined || fields.dependencies === undefined || fields.anchor === undefined) return undefined;
		try {
			return encodeCanonical(fields).byteLength;
		} catch {
			return undefined;
		}
	};
	return Object.freeze({
		observe(vertex: Parameters<V3RoomWriterCapacity["observe"]>[0], epoch: number): V3RoomWriterCapacityReading | undefined {
			if (vertex.epoch !== epoch || !Number.isSafeInteger(vertex.authorSequence) || vertex.authorSequence < 0) return undefined;
			const length = preimageLength(vertex);
			// A vertex whose preimage cannot be rebuilt is not forecast (the budget and idle triggers apply).
			if (length === undefined) return undefined;
			const at = now();
			let window = authors.get(vertex.author);
			if (window === undefined) {
				if (authors.size >= V3_ROOM_WRITER_CAPACITY_AUTHORS_MAX) {
					let oldest: string | undefined;
					let oldestAt = Number.POSITIVE_INFINITY;
					for (const [author, entry] of authors)
						if (entry.lastAt < oldestAt) {
							oldestAt = entry.lastAt;
							oldest = author;
						}
					if (oldest !== undefined) authors.delete(oldest);
				}
				window = { spans: [], preimageBytes: 0, lastAt: at, gapMs: Number.POSITIVE_INFINITY };
				authors.set(vertex.author, window);
			} else {
				// Map order follows activity: the least recently active author is the first one dropped.
				authors.delete(vertex.author);
				authors.set(vertex.author, window);
				const gap = Math.max(0, at - window.lastAt);
				window.gapMs = Number.isFinite(window.gapMs) ? 0.75 * window.gapMs + 0.25 * gap : gap;
				window.lastAt = at;
			}
			window.preimageBytes = Math.max(window.preimageBytes, length);
			// Keep the retained window and the current epoch only (at most RETAINED + 1 spans).
			window.spans = window.spans.filter((span) => span.epoch >= epoch - V3_ROOM_WRITER_RETAINED_EPOCHS);
			let current = window.spans.find((span) => span.epoch === epoch);
			if (current === undefined) {
				current = { epoch, first: vertex.authorSequence, last: vertex.authorSequence };
				window.spans.push(current);
				window.spans.sort((left, right) => left.epoch - right.epoch);
			} else {
				current.first = Math.min(current.first, vertex.authorSequence);
				current.last = Math.max(current.last, vertex.authorSequence);
			}
			const earlier = window.spans.filter((span) => span.epoch < epoch);
			// Contiguous sequences: every own row from the oldest retained epoch's first row up to the last
			// row of an earlier epoch is held, seen or not; the current epoch's rows follow it.
			const previousLast = earlier.length === 0 ? current.first - 1 : Math.max(...earlier.map((span) => span.last));
			const oldestFirst = earlier.length === 0 ? current.first : (earlier[0] as EpochSpan).first;
			const retainedRows = Math.max(0, previousLast - oldestFirst + 1);
			const epochRows = Math.max(1, current.last - previousLast);
			const moves = issuanceSettlementReserveForecast({
				scope: { objectId: input.objectId, author: vertex.author },
				maxDependencies: input.maxDependencies,
				retainedRows,
				epochRows,
				rowPreimageBytes: window.preimageBytes,
			});
			return Object.freeze({
				author: vertex.author,
				moves,
				used: epochRows / (epochRows + moves),
				gapMs: window.gapMs,
			});
		},
		size: (): number => authors.size,
	});
}
