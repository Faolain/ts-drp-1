import { compareBytes } from "@ts-drp/canonical";
import { AHE_BOUNDED_READ_LIMITS, digestBlob, type GenerationRef } from "@ts-drp/storage";

import { deriveCreatorCloseHistory } from "./creator-close-history.js";
import { canonicalCreatorDataRecord, creatorDataDigest } from "./creator-snapshot-data.js";

type TransitionCandidate = Readonly<{ bytes: Uint8Array; ref: GenerationRef }>;

/**
 * Reverses only the authenticated adoption projection replacement. This is a
 * logical decision closure, never a fabricated native generation or custody.
 */
export function deriveReceivedCreatorTransitionCandidates(
	currentCandidates: readonly TransitionCandidate[],
	candidateCandidates: readonly TransitionCandidate[],
	epoch: number
): readonly TransitionCandidate[] | undefined {
	const unique = (candidates: readonly TransitionCandidate[], kind: string): TransitionCandidate | undefined => {
		const matches = candidates.filter((candidate) => canonicalCreatorDataRecord(candidate.bytes)?.kind === kind);
		return matches.length === 1 ? matches[0] : undefined;
	};
	const sameRef = (a: GenerationRef, b: GenerationRef): boolean =>
		a.digest === b.digest && a.byteLength === b.byteLength;
	const predecessor = unique(currentCandidates, epoch === 0 ? "v3-live-generation-1" : "v3-live-generation-2");
	const successor = unique(candidateCandidates, "v3-live-generation-2");
	const cut = unique(candidateCandidates, "drp-hard-epoch-cut");
	const history = successor === undefined || cut === undefined ? undefined : deriveCreatorCloseHistory({
		exactCanonicalProjectionBytes: successor.bytes,
		exactCanonicalCutValueBytes: cut.bytes,
	});
	const trust = unique(currentCandidates, "drp-anchor-trust-state");
	const anchorBytes = trust === undefined ? undefined : canonicalCreatorDataRecord(trust.bytes)?.exactCanonicalCurrentAnchorPreimageBytes;
	const anchor = anchorBytes instanceof Uint8Array ? canonicalCreatorDataRecord(anchorBytes) : undefined;
	const acl = candidateCandidates.filter(({ bytes }) => creatorDataDigest("ts-drp/latched-acl/v3", bytes) === anchor?.aclDigest);
	if (predecessor === undefined || successor === undefined || cut === undefined || history === undefined || acl.length !== 1)
		return undefined;
	const retainedHistories = candidateCandidates.filter(({ bytes }) => canonicalCreatorDataRecord(bytes)?.kind === "creator-close-history-1");
	if (retainedHistories.length > 1 || retainedHistories.some((entry) => !sameRef(entry.ref, history.ref) || compareBytes(entry.bytes, history.bytes) !== 0))
		return undefined;
	const predecessorAcl = acl[0] as TransitionCandidate;
	const proposed = [
		...candidateCandidates.filter(({ ref }) => !sameRef(ref, successor.ref) &&
			(!sameRef(ref, predecessorAcl.ref) || currentCandidates.some((candidate) => sameRef(candidate.ref, ref)))),
		{ bytes: predecessor.bytes, ref: predecessor.ref },
		...(retainedHistories.length === 0 ? [history] : []),
	].sort((a, b) => a.ref.digest.localeCompare(b.ref.digest));
	return matchesCreatorAdoptionReferences({
		pendingReferences: proposed.map(({ ref }) => ref),
		predecessorLiveRef: predecessor.ref,
		exactCanonicalProjectionBytes: successor.bytes,
		exactCanonicalCutValueBytes: cut.bytes,
		predecessorExactCanonicalLatchedAclBytes: predecessorAcl.bytes,
	}, candidateCandidates.map(({ ref }) => ref)) ? Object.freeze(proposed) : undefined;
}

export interface CreatorAdoptionReferenceInput {
	readonly pendingReferences: readonly GenerationRef[];
	readonly predecessorLiveRef: GenerationRef;
	readonly exactCanonicalProjectionBytes: Uint8Array;
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly predecessorExactCanonicalLatchedAclBytes: Uint8Array;
}

function deriveReferences(
	input: CreatorAdoptionReferenceInput,
	retainStandaloneHistory: boolean
): readonly GenerationRef[] | undefined {
	const history = deriveCreatorCloseHistory(input);
	if (
		history === undefined ||
		input.pendingReferences.length > AHE_BOUNDED_READ_LIMITS.maxClosureReferences ||
		new Set(input.pendingReferences.map((ref) => ref.digest)).size !== input.pendingReferences.length ||
		input.pendingReferences.filter(
			(ref) => ref.digest === history.ref.digest && ref.byteLength === history.ref.byteLength
		).length !== 1 ||
		input.pendingReferences.filter(
			(ref) => ref.digest === input.predecessorLiveRef.digest && ref.byteLength === input.predecessorLiveRef.byteLength
		).length !== 1
	)
		return undefined;
	const refs = input.pendingReferences.filter(
		(ref) =>
			ref.digest !== input.predecessorLiveRef.digest && (retainStandaloneHistory || ref.digest !== history.ref.digest)
	);
	for (const bytes of [input.exactCanonicalProjectionBytes, input.predecessorExactCanonicalLatchedAclBytes]) {
		const digest = digestBlob(bytes);
		if (!digest.ok) return undefined;
		const prior = refs.find((ref) => ref.digest === digest.value);
		if (prior !== undefined && prior.byteLength !== bytes.byteLength) return undefined;
		if (prior === undefined) refs.push(Object.freeze({ digest: digest.value, byteLength: bytes.byteLength }));
	}
	return refs.length > AHE_BOUNDED_READ_LIMITS.maxClosureReferences ||
		new Set(refs.map(({ digest }) => digest)).size !== refs.length
		? undefined
		: Object.freeze(refs.sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0)));
}

/**
 * Derives new adoption references with history owned by the authenticated live projection.
 * @param input Actual pending closure, authenticated Cut, projection and closed ACL.
 * @returns Exact bounded references, or undefined on inconsistent identity.
 */
export function deriveCreatorAdoptionReferences(
	input: CreatorAdoptionReferenceInput
): readonly GenerationRef[] | undefined {
	return deriveReferences(input, false);
}

/**
 * Reconstructs only the supported readable pre-embedding durable representation.
 * Used for exact existing row/certificate identity, never new close production.
 * Eight-ref rows remain refused. Remove this boundary only after supported old
 * readable rows/certificates have been authenticated and drained or migrated.
 * @param input Authenticated pending proof and exact projected history.
 * @returns The old exact bounded closure, or undefined.
 */
export function deriveLegacyCreatorAdoptionReferences(
	input: CreatorAdoptionReferenceInput
): readonly GenerationRef[] | undefined {
	return deriveReferences(input, true);
}

/**
 * Validates an actual durable closure against the one shared representation law.
 * No unknown ref, changed length or unauthenticated history is normalized away.
 * @param input Independently authenticated proof/projection/ACL identity.
 * @param actual Actual native closure, with its original durable digest checked by its owner.
 * @returns Whether it is the new form or the exact supported readable old form.
 */
export function matchesCreatorAdoptionReferences(
	input: CreatorAdoptionReferenceInput,
	actual: readonly GenerationRef[]
): boolean {
	if (
		actual.length > AHE_BOUNDED_READ_LIMITS.maxClosureReferences ||
		new Set(actual.map((ref) => ref.digest)).size !== actual.length
	)
		return false;
	return [false, true].some((retainStandaloneHistory) => {
		const expected = deriveReferences(input, retainStandaloneHistory);
		return (
			expected !== undefined &&
			expected.length === actual.length &&
			expected.every((ref) =>
				actual.some((value) => value.digest === ref.digest && value.byteLength === ref.byteLength)
			)
		);
	});
}
