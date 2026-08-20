import { type Hash } from "@ts-drp/types";

const clockPendingByOutcome = new WeakMap<object, readonly Hash[]>();

/**
 * Associate receiver-clock-pending hashes with a module-owned outcome object.
 * The association is deliberately out-of-band: callers cannot forge it by
 * copying fields, symbols, tuples, or error messages.
 * @param target - Object-owned result or error receiving provenance.
 * @param hashes - Exact receiver-clock-pending hashes associated with the outcome.
 */
export function recordClockPendingProvenance(target: object, hashes: readonly Hash[]): void {
	const pending: Hash[] = [];
	const seen = new Set<Hash>();
	for (const hash of hashes) {
		if (seen.has(hash)) continue;
		seen.add(hash);
		pending.push(hash);
	}
	clockPendingByOutcome.set(target, Object.freeze(pending));
}

/**
 * Read the immutable provenance associated with an object-owned outcome.
 * @param target - Candidate object-owned result or error.
 * @returns Exact authenticated pending hashes, or an empty array for every unowned value.
 */
export function readClockPendingProvenance(target: unknown): readonly Hash[] {
	if ((typeof target !== "object" || target === null) && typeof target !== "function") return [];
	return clockPendingByOutcome.get(target) ?? [];
}
