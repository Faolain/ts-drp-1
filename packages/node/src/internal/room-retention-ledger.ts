/**
 * Slice 14b stage 2 (Track M2): the bounded in-memory ledger of verified facts of one
 * live room session, on a room host that opted into retention.
 *
 * - It holds only immutable signed facts, keyed by the exact bytes they were verified
 *   from: successor trusts, AHE generations authenticated as historical, and retained
 *   closed-cut source proofs. It never holds currency, controls, a census, floor
 *   state, accounting or authorization.
 * - One ledger belongs to one plane chain. It is created only by a complete verified
 *   (stage 1) boundary, forked to the successor plane only across a genuine handoff
 *   (the transport-reusing activation), and released with its plane. A reopen, a
 *   non-genuine recovery or a cold plane starts without one.
 * - A record replaces the previous one whole. Facts older than the window are evicted;
 *   a record over the byte cap is refused and the ledger is cleared, never kept in part.
 */

/** The facts verified for one epoch (by the epoch they belong to). */
export interface RoomRetentionLedgerEpochFacts {
	/**
	 * Genuine verified trusts, by the fact they were verified with: `<fact key>#trust` and
	 * `<fact key>#predecessor`.
	 */
	readonly trusts: ReadonlyMap<string, object>;
	/** Exact keys of generations of this epoch authenticated as historical. */
	readonly excluded: ReadonlySet<string>;
	/** Exact keys of retained closed-cut source proofs of this epoch. */
	readonly cuts: ReadonlySet<string>;
	/** Retained size of these facts (their keys and trusts), charged against the byte cap. */
	readonly bytes: number;
}

/** One boundary's record. Identities only outside the per-epoch facts. */
export interface RoomRetentionLedgerRecord {
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
	/** The stable epoch of the boundary whose verification recorded it. */
	readonly boundaryEpoch: number;
	/** That boundary's authenticated current anchor: the next boundary's must chain to it. */
	readonly boundaryAnchorDigest: string;
	/** Every generation authenticated as historical at that boundary (record digests). */
	readonly excluded: readonly string[];
	/** Identities that boundary's applied decision retired: one reappearing is a rollback. */
	readonly retired: readonly string[];
	readonly epochs: ReadonlyMap<number, RoomRetentionLedgerEpochFacts>;
}

/** Bounds of one ledger (14e). Test hooks may only lower them. */
export interface RoomRetentionLedgerBounds {
	readonly maxEpochs: number;
	readonly maxBytes: number;
}

/** The ledger of one plane chain. */
export interface RoomRetentionLedger {
	/** Process-unique identity of the session's ledger, carried across genuine handoffs. */
	readonly id: number;
	/** The number of genuine handoffs this ledger was forked across. */
	readonly generation: number;
	readonly released: boolean;
	/** The current record, or undefined when the ledger holds no facts. */
	current(): RoomRetentionLedgerRecord | undefined;
	/**
	 * Replaces the record whole: evicts epochs below the window, then refuses (and
	 * clears the ledger) when the rest exceeds the byte cap.
	 */
	record(
		record: RoomRetentionLedgerRecord,
		bounds: RoomRetentionLedgerBounds
	): Readonly<{ ok: true } | { ok: false; reason: "capacity" | "released" }>;
	/** Discards every fact (a mismatch, a refusal, or a stale or poisoned read). */
	drop(): void;
	/** Moves the facts to the successor plane of a genuine handoff and releases this one. */
	fork(): RoomRetentionLedger;
	/** Discards every fact; the ledger cannot be used again. */
	release(): void;
	/** Facts held: epochs and the exact bytes they were verified from. */
	size(): Readonly<{ epochs: number; bytes: number }>;
}

let nextLedgerId = 1;

function recordBytes(record: RoomRetentionLedgerRecord): number {
	let bytes = 0;
	for (const facts of record.epochs.values()) bytes += facts.bytes;
	for (const digest of [...record.excluded, ...record.retired]) bytes += digest.length;
	bytes += record.boundaryAnchorDigest.length;
	return bytes;
}

function makeLedger(
	id: number,
	generation: number,
	initial: RoomRetentionLedgerRecord | undefined
): RoomRetentionLedger {
	let record = initial;
	let released = false;
	const ledger: RoomRetentionLedger = Object.freeze({
		id,
		generation,
		get released(): boolean {
			return released;
		},
		current: (): RoomRetentionLedgerRecord | undefined => (released ? undefined : record),
		record: (next: RoomRetentionLedgerRecord, bounds: RoomRetentionLedgerBounds) => {
			if (released) return Object.freeze({ ok: false as const, reason: "released" as const });
			const floor = next.boundaryEpoch - Math.max(0, bounds.maxEpochs);
			const epochs = new Map([...next.epochs].filter(([epoch]) => epoch >= floor));
			const bounded: RoomRetentionLedgerRecord = Object.freeze({ ...next, epochs });
			if (recordBytes(bounded) > bounds.maxBytes) {
				record = undefined;
				return Object.freeze({ ok: false as const, reason: "capacity" as const });
			}
			record = bounded;
			return Object.freeze({ ok: true as const });
		},
		drop: (): void => {
			record = undefined;
		},
		fork: (): RoomRetentionLedger => {
			const successor = makeLedger(id, generation + 1, released ? undefined : record);
			released = true;
			record = undefined;
			return successor;
		},
		release: (): void => {
			released = true;
			record = undefined;
		},
		size: () =>
			Object.freeze(
				record === undefined || released
					? { epochs: 0, bytes: 0 }
					: { epochs: record.epochs.size, bytes: recordBytes(record) }
			),
	});
	return ledger;
}

/**
 * The retained size a record would have under these bounds, after window eviction.
 * @param record - A boundary's record.
 * @param bounds - The ledger's bounds.
 * @returns Its retained bytes, as `record` would charge them against the byte cap.
 */
export function roomRetentionLedgerRecordBytes(
	record: RoomRetentionLedgerRecord,
	bounds: RoomRetentionLedgerBounds
): number {
	const floor = record.boundaryEpoch - Math.max(0, bounds.maxEpochs);
	return recordBytes({ ...record, epochs: new Map([...record.epochs].filter(([epoch]) => epoch >= floor)) });
}

/**
 * A new empty ledger for a plane that has none (its first verified boundary).
 * @returns The ledger, at generation 0 under a new identity.
 */
export function createRoomRetentionLedger(): RoomRetentionLedger {
	return makeLedger(nextLedgerId++, 0, undefined);
}
