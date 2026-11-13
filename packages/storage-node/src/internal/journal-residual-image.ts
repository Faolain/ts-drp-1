// Verified-once residual image of a live-journal drain (see live-journal.ts, the native drain CAS).

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
