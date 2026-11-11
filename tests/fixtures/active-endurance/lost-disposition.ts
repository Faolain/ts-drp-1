/**
 * Endurance conservation: how a Writer's move whose first copy the scripted wire dropped reached the
 * creator. It is carried when the creator admitted the exact source, or when the Writer's durable
 * settlement plan replaced it and every replacement chunk is carried in turn.
 *
 * The chain is followed to its end: a replacement the creator closed an epoch without (the Writer's
 * rebased moves count toward the next epoch's budget, so the creator can close it while the tail of
 * that batch is in flight) is itself replaced by the Writer's settlement after the next install.
 * Strict: every hop is a plan entry of the Writer's durable settlement plan (the caller asserts none
 * dangles), every leaf is a digest the creator admitted, and a chain that ends anywhere else, cycles
 * or exceeds the hop bound is a lost move.
 */
export interface LostRowReplacement {
	readonly sourceDigest: string;
	readonly replacementDigests: readonly string[];
}

export interface LostRowDisposition {
	readonly carried: boolean;
	/** The digests the creator admitted that carry the move (the source itself, or the chain's admitted leaves). */
	readonly acceptedDigests: readonly string[];
}

/** More replacement hops than this for one move is treated as lost (each hop is one closed epoch). */
const MAX_REPLACEMENT_HOPS = 32;

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
	const bySource = new Map(replacements.map((entry) => [entry.sourceDigest, entry.replacementDigests]));
	const leaves: string[] = [];
	const carried = async (digest: string, path: ReadonlySet<string>): Promise<boolean> => {
		if ((await accepted([digest]))[0] === true) {
			leaves.push(digest);
			return true;
		}
		const next = bySource.get(digest) ?? [];
		if (next.length === 0 || path.size >= MAX_REPLACEMENT_HOPS) return false;
		const extended = new Set(path).add(digest);
		for (const replacement of next) {
			if (extended.has(replacement) || !(await carried(replacement, extended))) return false;
		}
		return true;
	};
	const result = await carried(sourceDigest, new Set());
	return { carried: result, acceptedDigests: result ? leaves : [] };
}
