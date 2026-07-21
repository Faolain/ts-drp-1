import type { ValidatedDrpRecord } from "./registry.js";

interface ReconciliationOptions {
	readonly maxRecords?: number;
	readonly now?: number;
}

/** Raised internally when one candidate union exceeds its caller-owned cap. */
export class ReconciliationCapacityError extends Error {
	/** Creates the fixed reconciliation-cap error. */
	constructor() {
		super("reconciled record cap exceeded");
		this.name = "ReconciliationCapacityError";
	}
}

/**
 * Unions validated record sets, retaining the highest fresh sequence per peer
 * and dropping both sides of an equal-sequence conflict.
 * @param recordSets - Independently validated source snapshots.
 * @param options - Internal clock and union bound overrides.
 * @returns A stable Peer-ID ordered snapshot.
 */
export function reconcileValidatedRecords(
	recordSets: readonly (readonly ValidatedDrpRecord[])[],
	options: ReconciliationOptions = {}
): readonly ValidatedDrpRecord[] {
	const now = options.now ?? Date.now();
	const maximum = options.maxRecords ?? Number.POSITIVE_INFINITY;
	const candidates = new Map<string, ValidatedDrpRecord>();
	const conflictedPeerIds = new Set<string>();

	for (const recordSet of recordSets) {
		for (const candidate of recordSet) {
			if (candidate.record.expiresAtMs <= now || conflictedPeerIds.has(candidate.record.peerId)) continue;
			const existing = candidates.get(candidate.record.peerId);
			if (existing === undefined) {
				if (candidates.size >= maximum) throw new ReconciliationCapacityError();
				candidates.set(candidate.record.peerId, candidate);
				continue;
			}
			if (candidate.record.sequence > existing.record.sequence) {
				candidates.set(candidate.record.peerId, candidate);
				continue;
			}
			if (
				candidate.record.sequence === existing.record.sequence &&
				JSON.stringify(candidate.record) !== JSON.stringify(existing.record)
			) {
				candidates.delete(candidate.record.peerId);
				conflictedPeerIds.add(candidate.record.peerId);
			}
		}
	}

	return [...candidates.values()].sort((left, right) => left.record.peerId.localeCompare(right.record.peerId));
}
