import { decodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DetachedClosureCandidate } from "@ts-drp/control-plane";
import { inspectCreatorTrustAdvance } from "@ts-drp/control-plane/creator-trust-advance";
import { inspectBoundedCreatorTrustAdvance } from "@ts-drp/control-plane/creator-trust-checkpoint-advance";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import {
	CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL,
	CREATOR_ISSUANCE_RETIREMENT_KIND,
	type CreatorIssuanceRetirementIdentity,
	openCreatorIssuanceRetirement,
	resolveCreatorIssuanceRetirement,
} from "@ts-drp/protocol-v3/creator-issuance-retirement";
import { digestBlob, type GenerationRef } from "@ts-drp/storage";

export interface CreatorTransitionClosure {
	readonly candidates: readonly DetachedClosureCandidate[];
	readonly closure: readonly GenerationRef[];
}

export interface InspectCreatorTransitionAdvanceInput {
	readonly current: CreatorTransitionClosure;
	readonly currentTrust: CurrentAnchorTrust;
	readonly mode: "stage" | "verify";
	readonly proofRefs: readonly GenerationRef[];
	readonly proposed: CreatorTransitionClosure;
	readonly successorTrust: CurrentAnchorTrust;
}

export type InspectCreatorTransitionAdvanceResult =
	| Readonly<{ readonly ok: false; readonly reason: string }>
	| Readonly<{
			readonly kind: "successor";
			readonly ok: true;
			readonly proposed: CreatorTransitionClosure;
	  }>;

export interface VerifiedCreatorHistoricalIssuance {
	readonly __verifiedCreatorHistoricalIssuance?: never;
}

const verifiedHistoricalIssuance = new WeakMap<VerifiedCreatorHistoricalIssuance, CreatorIssuanceRetirementIdentity>();

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

function sameRef(left: GenerationRef, right: GenerationRef): boolean {
	return left.byteLength === right.byteLength && left.digest === right.digest;
}

function exactCandidate(candidate: DetachedClosureCandidate): boolean {
	const digest = digestBlob(candidate.bytes);
	return digest.ok && digest.value === candidate.ref.digest && candidate.bytes.byteLength === candidate.ref.byteLength;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function retirementCandidates(closure: CreatorTransitionClosure): readonly DetachedClosureCandidate[] {
	return closure.candidates.filter((candidate) => record(candidate)?.kind === CREATOR_ISSUANCE_RETIREMENT_KIND);
}

function exactClosureOccurrence(closure: readonly GenerationRef[], candidate: DetachedClosureCandidate): boolean {
	return closure.filter((ref) => sameRef(ref, candidate.ref)).length === 1;
}

function openedRetirement(
	candidate: DetachedClosureCandidate,
	floorTrust: CurrentAnchorTrust,
	cut: DetachedClosureCandidate,
	qc: DetachedClosureCandidate
):
	| Readonly<{
			readonly candidate: DetachedClosureCandidate;
			readonly identity: CreatorIssuanceRetirementIdentity;
	  }>
	| undefined {
	const decodedCut = record(cut);
	if (
		!exactCandidate(candidate) ||
		!exactCandidate(cut) ||
		!exactCandidate(qc) ||
		typeof decodedCut?.snapshotManifestDigest !== "string"
	) {
		return undefined;
	}
	const opened = openCreatorIssuanceRetirement({
		exactCanonicalRecordBytes: candidate.bytes,
		expectedCommitQcRef: qc.ref,
		expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)),
		expectedSnapshotManifestDigest: decodedCut.snapshotManifestDigest,
		floorTrust,
	});
	if (!opened.ok) return undefined;
	const identity = resolveCreatorIssuanceRetirement(opened.capability);
	return identity === undefined ||
		decodedCut.kind !== "drp-hard-epoch-cut" ||
		decodedCut.objectId !== identity.objectId ||
		decodedCut.epoch !== identity.closedEpoch ||
		decodedCut.previousAnchor !== identity.closedAnchorDigest
		? undefined
		: Object.freeze({ candidate, identity });
}

/**
 * Opens the sole retirement carrier in one authenticated successor generation.
 * The returned capability is private to the Node lifecycle and cannot be
 * manufactured from durable row bytes alone.
 * @param input - Exact successor closure and its independently authenticated floor.
 * @returns An opaque historical-issuance capability or undefined on any ambiguity.
 */
export function openVerifiedCreatorHistoricalIssuance(
	input: Readonly<{
		readonly closure: CreatorTransitionClosure;
		readonly floorTrust: CurrentAnchorTrust;
	}>
): VerifiedCreatorHistoricalIssuance | undefined {
	try {
		if (input.floorTrust.currentEpoch < 1) return undefined;
		const closedEpoch = input.floorTrust.currentEpoch - 1;
		const retirement = retirementCandidates(input.closure);
		const cut = uniqueCandidate(input.closure.candidates, "drp-hard-epoch-cut", closedEpoch);
		const qc = uniqueCandidate(input.closure.candidates, "drp-seal-qc", closedEpoch, "commit");
		if (
			retirement.length !== 1 ||
			cut === undefined ||
			qc === undefined ||
			!exactClosureOccurrence(input.closure.closure, retirement[0] as DetachedClosureCandidate)
		) {
			return undefined;
		}
		const opened = openedRetirement(retirement[0] as DetachedClosureCandidate, input.floorTrust, cut, qc);
		if (
			opened === undefined ||
			opened.identity.closedEpoch !== closedEpoch ||
			opened.identity.successorEpoch !== input.floorTrust.currentEpoch ||
			opened.identity.successorAnchorDigest !== input.floorTrust.currentAnchorDigest
		) {
			return undefined;
		}
		const capability = Object.freeze({}) as VerifiedCreatorHistoricalIssuance;
		verifiedHistoricalIssuance.set(capability, opened.identity);
		return capability;
	} catch {
		return undefined;
	}
}

/**
 * Resolves a detached identity from a genuine Node-private capability.
 * @param capability - Capability returned by openVerifiedCreatorHistoricalIssuance.
 * @returns A detached frozen identity or undefined for foreign custody.
 */
export function resolveVerifiedCreatorHistoricalIssuance(
	capability: VerifiedCreatorHistoricalIssuance
): CreatorIssuanceRetirementIdentity | undefined {
	const identity = verifiedHistoricalIssuance.get(capability);
	return identity === undefined
		? undefined
		: Object.freeze({
				...identity,
				commitQcRef: Object.freeze({ ...identity.commitQcRef }),
				observedLineage: Object.freeze({ ...identity.observedLineage }),
			});
}

function authenticatedRetirementPair(input: InspectCreatorTransitionAdvanceInput):
	| Readonly<{
			readonly current?: DetachedClosureCandidate;
			readonly proposed: DetachedClosureCandidate;
	  }>
	| undefined {
	if (
		input.currentTrust.currentEpoch < 0 ||
		input.successorTrust.currentEpoch !== input.currentTrust.currentEpoch + 1 ||
		input.currentTrust.objectId !== input.successorTrust.objectId ||
		input.currentTrust.genesisAnchorDigest !== input.successorTrust.genesisAnchorDigest ||
		input.proofRefs.length !== 2
	) {
		return undefined;
	}
	const currentMatches = retirementCandidates(input.current);
	const proposedMatches = retirementCandidates(input.proposed);
	if (proposedMatches.length !== 1 || currentMatches.length !== (input.currentTrust.currentEpoch === 0 ? 0 : 1)) {
		return undefined;
	}
	const proposedRetirement = proposedMatches[0] as DetachedClosureCandidate;
	if (!exactClosureOccurrence(input.proposed.closure, proposedRetirement)) return undefined;
	if (
		currentMatches.length === 1 &&
		!exactClosureOccurrence(input.current.closure, currentMatches[0] as DetachedClosureCandidate)
	) {
		return undefined;
	}
	const proposedCut = input.proposed.candidates.find((candidate) =>
		sameRef(candidate.ref, input.proofRefs[0] as GenerationRef)
	);
	const proposedQc = input.proposed.candidates.find((candidate) =>
		sameRef(candidate.ref, input.proofRefs[1] as GenerationRef)
	);
	if (proposedCut === undefined || proposedQc === undefined) return undefined;
	const openedProposed = openedRetirement(proposedRetirement, input.successorTrust, proposedCut, proposedQc);
	if (
		openedProposed === undefined ||
		openedProposed.identity.closedEpoch !== input.currentTrust.currentEpoch ||
		openedProposed.identity.closedAnchorDigest !== input.currentTrust.currentAnchorDigest
	) {
		return undefined;
	}
	if (input.currentTrust.currentEpoch === 0) {
		return openedProposed.identity.priorAdmittedAuthorSequence === null &&
			openedProposed.identity.priorRetirementCandidateDigest === CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL
			? Object.freeze({ proposed: openedProposed.candidate })
			: undefined;
	}
	const currentCandidate = currentMatches[0] as DetachedClosureCandidate;
	const retiringCut = uniqueCandidate(
		input.current.candidates,
		"drp-hard-epoch-cut",
		input.currentTrust.currentEpoch - 1
	);
	const retiringQc = uniqueCandidate(
		input.current.candidates,
		"drp-seal-qc",
		input.currentTrust.currentEpoch - 1,
		"commit"
	);
	if (retiringCut === undefined || retiringQc === undefined) return undefined;
	const openedCurrent = openedRetirement(currentCandidate, input.currentTrust, retiringCut, retiringQc);
	return openedCurrent !== undefined &&
		openedProposed.identity.author === openedCurrent.identity.author &&
		openedProposed.identity.priorRetirementCandidateDigest === currentCandidate.ref.digest &&
		openedProposed.identity.priorAdmittedAuthorSequence === openedCurrent.identity.admittedAuthorSequence &&
		openedProposed.identity.admittedAuthorSequence >= openedCurrent.identity.admittedAuthorSequence
		? Object.freeze({ current: currentCandidate, proposed: openedProposed.candidate })
		: undefined;
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
		const retirement = authenticatedRetirementPair(input);
		if (retirement === undefined) return failure("TRUST_CLOSURE_INVALID");
		const withoutRetirement = (
			closure: CreatorTransitionClosure,
			candidate?: DetachedClosureCandidate
		): CreatorTransitionClosure =>
			candidate === undefined
				? closure
				: Object.freeze({
						candidates: Object.freeze(closure.candidates.filter((item) => !sameRef(item.ref, candidate.ref))),
						closure: Object.freeze(closure.closure.filter((ref) => !sameRef(ref, candidate.ref))),
					});
		const normalizedCurrent = withoutRetirement(input.current, retirement.current);
		const normalizedProposed = withoutRetirement(input.proposed, retirement.proposed);
		const trustCandidates = input.current.candidates.filter(
			(candidate) => record(candidate)?.kind === "drp-anchor-trust-state"
		);
		if (trustCandidates.length !== 1) return failure("TRUST_CLOSURE_INVALID");
		const trust = record(trustCandidates[0] as DetachedClosureCandidate);
		if (typeof trust?.currentEpoch !== "number" || !Number.isSafeInteger(trust.currentEpoch)) {
			return failure("TRUST_CLOSURE_INVALID");
		}
		if (trust.currentEpoch === 0) {
			const result = inspectCreatorTrustAdvance({
				current: normalizedCurrent,
				proofRefs: input.proofRefs,
				proposed: normalizedProposed,
			});
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
		const proposedWithoutRetiring =
			input.mode === "stage"
				? Object.freeze({
						candidates: Object.freeze(
							normalizedProposed.candidates.filter((candidate) => !retiring.has(candidate.ref.digest))
						),
						closure: Object.freeze(
							normalizedProposed.closure.filter((ref) => !retiring.has(ref.digest)).sort(compareRef)
						),
					})
				: normalizedProposed;
		const result = inspectBoundedCreatorTrustAdvance({
			current: normalizedCurrent,
			proofRefs: input.proofRefs,
			proposed: proposedWithoutRetiring,
			retiringPredecessorAclRef: retiringAcl.ref,
			retiringProofRefs: [retiringCut.ref, retiringQc.ref],
		});
		if (!result.ok) return failure(result.reason);
		const proposed =
			input.mode === "verify"
				? input.proposed
				: Object.freeze({
						candidates: Object.freeze(
							[...proposedWithoutRetiring.candidates, retirement.proposed].sort((left, right) =>
								compareRef(left.ref, right.ref)
							)
						),
						closure: Object.freeze([...proposedWithoutRetiring.closure, retirement.proposed.ref].sort(compareRef)),
					});
		return Object.freeze({ kind: result.kind, ok: true as const, proposed });
	} catch {
		return failure("TRUST_CLOSURE_INVALID");
	}
}
