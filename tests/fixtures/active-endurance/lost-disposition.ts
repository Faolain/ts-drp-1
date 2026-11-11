/**
 * Endurance conservation: how a Writer's move whose first copy the scripted wire dropped reached the
 * creator. It is carried when the creator admitted the exact source, or when the Writer's durable
 * settlement plan replaced it and every replacement chunk was admitted.
 */
export interface LostRowReplacement {
	readonly sourceDigest: string;
	readonly replacementDigests: readonly string[];
}

export interface LostRowDisposition {
	readonly carried: boolean;
	/** The digests the creator admitted that carry the move (the source itself, or the replacement chunks). */
	readonly acceptedDigests: readonly string[];
}

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
	const replacement = replacements.find((entry) => entry.sourceDigest === sourceDigest);
	const candidates = [sourceDigest, ...(replacement?.replacementDigests ?? [])];
	const admitted = await accepted(candidates);
	if (admitted[0] === true) return { carried: true, acceptedDigests: [sourceDigest] };
	const complete = candidates.length > 1 && admitted.slice(1).every(Boolean);
	return { carried: complete, acceptedDigests: complete ? candidates.slice(1) : [] };
}
