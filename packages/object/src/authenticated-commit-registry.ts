import { type Hash } from "@ts-drp/types";

const committedProvenance = new WeakMap<object, readonly Hash[]>();
const EMPTY_COMMITTED_PROVENANCE: readonly Hash[] = Object.freeze([]);

/**
 * Bind an immutable commit snapshot to an object-owned result identity.
 * @param target - Genuine result, partial result, or boundary error
 * @param hashes - Hashes physically committed by this exact apply call
 */
export function recordCommittedProvenance(target: object, hashes: Iterable<Hash>): void {
	committedProvenance.set(target, Object.freeze([...new Set(hashes)]));
}

/**
 * Read hashes bound to the exact supplied identity.
 * @param target - Candidate result identity
 * @returns Frozen call-local hashes, or a shared frozen empty value
 */
export function readCommittedProvenance(target: unknown): readonly Hash[] {
	if ((typeof target !== "object" || target === null) && typeof target !== "function") {
		return EMPTY_COMMITTED_PROVENANCE;
	}
	return committedProvenance.get(target) ?? EMPTY_COMMITTED_PROVENANCE;
}
