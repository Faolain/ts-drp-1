import { type Hash } from "@ts-drp/types";

import { readCommittedProvenance } from "./authenticated-commit-registry.js";

/**
 * Test one hash against object-owned, call-local commit provenance.
 * @param target - Candidate genuine result or boundary error
 * @param hash - Exact authenticated hash whose commit is being credited
 * @returns Whether object internals recorded the commit on this identity
 */
export function wasAuthenticatedHashCommitted(target: unknown, hash: Hash): boolean {
	return readCommittedProvenance(target).includes(hash);
}
