import { decodeCanonical } from "@ts-drp/canonical";
import type { DetachedClosureCandidate } from "@ts-drp/control-plane";
import { inspectCreatorTrustAdvance } from "@ts-drp/control-plane/creator-trust-advance";
import { inspectBoundedCreatorTrustAdvance } from "@ts-drp/control-plane/creator-trust-checkpoint-advance";
import type { GenerationRef } from "@ts-drp/storage";

export interface CreatorTransitionClosure {
	readonly candidates: readonly DetachedClosureCandidate[];
	readonly closure: readonly GenerationRef[];
}

export interface InspectCreatorTransitionAdvanceInput {
	readonly current: CreatorTransitionClosure;
	readonly mode: "stage" | "verify";
	readonly proofRefs: readonly GenerationRef[];
	readonly proposed: CreatorTransitionClosure;
}

export type InspectCreatorTransitionAdvanceResult =
	| Readonly<{ readonly ok: false; readonly reason: string }>
	| Readonly<{
			readonly kind: "successor";
			readonly ok: true;
			readonly proposed: CreatorTransitionClosure;
	  }>;

function record(candidate: DetachedClosureCandidate): Readonly<Record<string, unknown>> | undefined {
	try {
		const decoded = decodeCanonical(candidate.bytes);
		return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
			? (decoded as Readonly<Record<string, unknown>>)
			: undefined;
	} catch {
		return undefined;
	}
}

function compareRef(left: GenerationRef, right: GenerationRef): number {
	return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
}

function uniqueCandidate(
	candidates: readonly DetachedClosureCandidate[],
	kind: string,
	epoch: number,
	phase?: string
): DetachedClosureCandidate | undefined {
	const matches = candidates.filter((candidate) => {
		const decoded = record(candidate);
		return (
			decoded?.kind === kind &&
			(decoded.kind === "drp-anchor-trust-state" ? decoded.currentEpoch : decoded.epoch) === epoch &&
			(phase === undefined || decoded.phase === phase)
		);
	});
	return matches.length === 1 ? matches[0] : undefined;
}

function failure(reason: string): InspectCreatorTransitionAdvanceResult {
	return Object.freeze({ ok: false as const, reason });
}

/**
 * Selects the compatibility or bounded transition predicate and owns stale-ref derivation.
 * @param input - Current/proposed closure pair, new proof refs, and staging/verification mode.
 * @returns The authenticated proposal (normalized only for in-memory staging) or a rejection.
 */
export function inspectCreatorTransitionAdvance(
	input: InspectCreatorTransitionAdvanceInput
): InspectCreatorTransitionAdvanceResult {
	try {
		const trustCandidates = input.current.candidates.filter(
			(candidate) => record(candidate)?.kind === "drp-anchor-trust-state"
		);
		if (trustCandidates.length !== 1) return failure("TRUST_CLOSURE_INVALID");
		const trust = record(trustCandidates[0] as DetachedClosureCandidate);
		if (typeof trust?.currentEpoch !== "number" || !Number.isSafeInteger(trust.currentEpoch)) {
			return failure("TRUST_CLOSURE_INVALID");
		}
		if (trust.currentEpoch === 0) {
			const result = inspectCreatorTrustAdvance(input);
			return result.ok
				? Object.freeze({ kind: result.kind, ok: true as const, proposed: input.proposed })
				: failure(result.reason);
		}
		const retiringEpoch = trust.currentEpoch - 1;
		const retiringCut = uniqueCandidate(input.current.candidates, "drp-hard-epoch-cut", retiringEpoch);
		const retiringQc = uniqueCandidate(input.current.candidates, "drp-seal-qc", retiringEpoch, "commit");
		const retiringAcl = uniqueCandidate(input.current.candidates, "drp-v3-latched-acl", retiringEpoch);
		if (retiringCut === undefined || retiringQc === undefined || retiringAcl === undefined) {
			return failure("RETIRING_PROOF_REFS_INVALID");
		}
		const retiring = new Set([retiringCut.ref.digest, retiringQc.ref.digest, retiringAcl.ref.digest]);
		const proposed =
			input.mode === "stage"
				? Object.freeze({
						candidates: Object.freeze(
							input.proposed.candidates.filter((candidate) => !retiring.has(candidate.ref.digest))
						),
						closure: Object.freeze(input.proposed.closure.filter((ref) => !retiring.has(ref.digest)).sort(compareRef)),
					})
				: input.proposed;
		const result = inspectBoundedCreatorTrustAdvance({
			current: input.current,
			proofRefs: input.proofRefs,
			proposed,
			retiringPredecessorAclRef: retiringAcl.ref,
			retiringProofRefs: [retiringCut.ref, retiringQc.ref],
		});
		return result.ok ? Object.freeze({ kind: result.kind, ok: true as const, proposed }) : failure(result.reason);
	} catch {
		return failure("TRUST_CLOSURE_INVALID");
	}
}
