/**
 * Endurance conservation: how a Writer's move whose first copy the scripted wire dropped reached the
 * creator. It is carried when the creator admitted the exact source, or when the Writer's durable
 * settlement plan replaced it and every replacement chunk is carried in turn.
 *
 * The chain is followed to its end: a replacement the creator closed an epoch without (the Writer's
 * rebased moves count toward the next epoch's budget, so the creator can close it while the tail of
 * that batch is in flight) is itself replaced by the Writer's settlement after the next install.
 * Strict: every hop is a plan entry of the Writer's durable settlement plan (the caller asserts none
 * dangles), every leaf is a digest the creator admitted, and a chain that ends anywhere else, cycles
 * or exceeds the hop bound is a lost move.
 */
export interface LostRowReplacement {
	readonly sourceDigest: string;
	readonly replacementDigests: readonly string[];
}

export interface LostRowDisposition {
	readonly carried: boolean;
	/** The digests the creator admitted that carry the move (the source itself, or the chain's admitted leaves). */
	readonly acceptedDigests: readonly string[];
}

/** More replacement hops than this for one move is treated as lost (each hop is one closed epoch). */
const MAX_REPLACEMENT_HOPS = 32;

/**
 * @param sourceDigest - The dropped first copy.
 * @param replacements - The Writer's durable settlement plan entries (source digest to replacement chunk digests).
 * @param accepted - The creator's admission of each digest, in order.
 */
export async function lostRowDisposition(
	sourceDigest: string,
	replacements: readonly LostRowReplacement[],
	accepted: (digests: readonly string[]) => Promise<readonly boolean[]>
): Promise<LostRowDisposition> {
	const bySource = new Map(replacements.map((entry) => [entry.sourceDigest, entry.replacementDigests]));
	const leaves: string[] = [];
	const carried = async (digest: string, path: ReadonlySet<string>): Promise<boolean> => {
		if ((await accepted([digest]))[0] === true) {
			leaves.push(digest);
			return true;
		}
		const next = bySource.get(digest) ?? [];
		if (next.length === 0 || path.size >= MAX_REPLACEMENT_HOPS) return false;
		const extended = new Set(path).add(digest);
		for (const replacement of next) {
			if (extended.has(replacement) || !(await carried(replacement, extended))) return false;
		}
		return true;
	};
	const result = await carried(sourceDigest, new Set());
	return { carried: result, acceptedDigests: result ? leaves : [] };
}

/** A dropped first copy the conservation check must account for, and when it was dropped (ms, the probe's clock). */
export interface DroppedRow {
	readonly digest: string;
	readonly droppedAt: number;
}

/** The peers' state the dropped-row accounting reads. */
export interface DroppedRowProbe {
	/** The author's durable settlement plan entries (re-read on each evaluation). */
	replacements(): Promise<readonly LostRowReplacement[]>;
	/** The receiver's admission of each digest, in order. */
	accepted(digests: readonly string[]): Promise<readonly boolean[]>;
	/** When the receiver admitted each digest (same clock as `droppedAt`), or null; optional. */
	admittedAt?(digests: readonly string[]): Promise<readonly (number | null)[]>;
	/** Whether the author holds a durable hand-back record for one of these digests, and whether it was re-offered and admitted. */
	handBack(digests: ReadonlySet<string>): Promise<"none" | "pending" | "reoffered-admitted">;
	/** How many adoptions the receiver has made so far. */
	adoptions(): Promise<number>;
	/** Drives delivery between evaluations (flush, re-offer, install published offers). */
	progress(): Promise<void>;
	/** The diagnostic dump a failure carries. */
	diag(row: DroppedRow): Promise<Readonly<Record<string, unknown>>>;
}

export interface DroppedRowClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export interface DroppedRowOptions {
	/** The fixed cap added to the start of the wait, or to the next adoption when one happens during it. */
	readonly capMs: number;
	readonly pollMs: number;
}

export interface DroppedRowAccounted {
	readonly digest: string;
	readonly how: "exact" | "replaced" | "handed-back";
	readonly acceptedDigests: readonly string[];
	/** From the drop to the admission that carries the move. */
	readonly latencyMs: number;
}

/**
 * Accounts for every dropped first copy at an epoch's conservation check: each must be admitted exactly
 * or carried by a complete replacement chain (lostRowDisposition).
 * @param rows - The dropped first copies of this epoch.
 * @param probe - The peers' state.
 * @param clock - Time source.
 * @param _options - Wait bound.
 * @returns How each row was carried.
 */
export async function accountDroppedRows(
	rows: readonly DroppedRow[],
	probe: DroppedRowProbe,
	clock: DroppedRowClock,
	_options: DroppedRowOptions
): Promise<readonly DroppedRowAccounted[]> {
	const accounted: DroppedRowAccounted[] = [];
	const replacements = await probe.replacements();
	for (const row of rows) {
		const disposition = await lostRowDisposition(row.digest, replacements, (digests) => probe.accepted(digests));
		if (!disposition.carried)
			throw new Error(`dropped source ${row.digest} admitted exactly or by every durable replacement chunk`);
		accounted.push({
			digest: row.digest,
			how:
				disposition.acceptedDigests.length === 1 && disposition.acceptedDigests[0] === row.digest
					? "exact"
					: "replaced",
			acceptedDigests: disposition.acceptedDigests,
			latencyMs: clock.now() - row.droppedAt,
		});
	}
	return accounted;
}
