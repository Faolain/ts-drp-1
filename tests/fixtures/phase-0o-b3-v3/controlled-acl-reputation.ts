import type { EquivocationScope } from "../../../packages/protocol-v3/src/index.js";

export interface DetachedAuthorReputationSlot {
	readonly scope: EquivocationScope;
	readonly digestHexes: readonly string[];
}
export interface DetachedAuthorReputationProjection {
	readonly author: string;
	readonly slots: readonly DetachedAuthorReputationSlot[];
}
export interface AuthorAclReputationPolicy {
	readonly maxReputationPenalty: number;
}
export interface AuthorAclReputationComposition {
	readonly author: string;
	readonly equivocatingSlotCount: number;
	readonly totalCanonicalPairCount: number;
	readonly reputationPenalty: number;
	readonly saturated: boolean;
}

type Mutant =
	| "array-dispatch"
	| "caller-count"
	| "cross-author"
	| "duplicate-union"
	| "forbidden-surface"
	| "global-cache"
	| "late-policy-read"
	| "local-slot-only"
	| "mutate-input"
	| "off-by-one"
	| "scope-collision"
	| "unsafe-policy"
	| "wall-clock"
	| "wrong-formula";
const mutant = process.env.PHASE_0O_B3_MUTANT as Mutant | undefined;
let cached: AuthorAclReputationComposition | undefined;

function copyScope(value: unknown, author: string): EquivocationScope {
	if (value === null || typeof value !== "object") throw new TypeError("reputation scope is malformed");
	const candidate = value as Partial<EquivocationScope>;
	const capturedAuthor = candidate.author;
	const objectId = candidate.objectId;
	const authorSequence = candidate.authorSequence;
	if (
		(capturedAuthor !== author && mutant !== "cross-author") ||
		typeof objectId !== "string" ||
		!Number.isSafeInteger(authorSequence) ||
		(authorSequence as number) < 0
	)
		throw new TypeError("reputation scope is malformed");
	return { author: capturedAuthor as string, objectId, authorSequence: authorSequence as number };
}
function copyDigests(value: unknown): string[] {
	if (!Array.isArray(value)) throw new TypeError("reputation digests are malformed");
	if (mutant === "array-dispatch") void value[Symbol.iterator]();
	const result: string[] = [];
	const length = value.length;
	for (let index = 0; index < length; index++) {
		const digest = value[index];
		if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest))
			throw new TypeError("reputation digest is malformed");
		result[result.length] = digest;
	}
	return result;
}
function has(values: readonly string[], value: string): boolean {
	for (let index = 0; index < values.length; index++) if (values[index] === value) return true;
	return false;
}
function sameScope(left: EquivocationScope, right: EquivocationScope): boolean {
	if (mutant === "scope-collision")
		return `${left.objectId}${left.authorSequence}` === `${right.objectId}${right.authorSequence}`;
	return (
		left.author === right.author && left.objectId === right.objectId && left.authorSequence === right.authorSequence
	);
}
function checkedPairCount(digestCount: number): number {
	const pairs = (digestCount * (digestCount - 1)) / 2;
	if (!Number.isSafeInteger(pairs)) throw new RangeError("canonical pair count exceeds safe integer");
	return pairs;
}

/**
 * Independent controlled implementation for the Phase 0o-b3 RED, selected only by the workflow environment.
 * @param uncapturedProjection - Caller-owned detached author digest-set projection.
 * @param uncapturedPolicy - Explicit pure ACL-visible reputation policy.
 * @returns A fresh minimal aggregate reputation observation.
 */
export function composeAuthorAclReputation(
	uncapturedProjection: DetachedAuthorReputationProjection,
	uncapturedPolicy: AuthorAclReputationPolicy
): AuthorAclReputationComposition {
	if (
		uncapturedProjection === null ||
		typeof uncapturedProjection !== "object" ||
		uncapturedPolicy === null ||
		typeof uncapturedPolicy !== "object"
	)
		throw new TypeError("reputation inputs are required");
	const maxReputationPenalty = uncapturedPolicy.maxReputationPenalty;
	if (!Number.isSafeInteger(maxReputationPenalty) || (maxReputationPenalty < 0 && mutant !== "unsafe-policy"))
		throw new RangeError("maxReputationPenalty must be a nonnegative safe integer");
	if (mutant === "wall-clock" && maxReputationPenalty === 17) void Date.now();
	if (mutant === "forbidden-surface" && maxReputationPenalty === 17)
		void (uncapturedProjection as { readonly pendingRows?: unknown }).pendingRows;
	if (mutant === "late-policy-read" && maxReputationPenalty === 8) void uncapturedPolicy.maxReputationPenalty;
	if (mutant === "global-cache" && maxReputationPenalty === 17 && cached !== undefined) return cached;
	const author = uncapturedProjection.author;
	const slots = uncapturedProjection.slots;
	if (typeof author !== "string" || !Array.isArray(slots)) throw new TypeError("reputation projection is malformed");
	const normalized: Array<{ scope: EquivocationScope; digests: string[] }> = [];
	const slotCount =
		mutant === "local-slot-only" && maxReputationPenalty === 5 ? Math.min(1, slots.length) : slots.length;
	for (let index = 0; index < slotCount; index++) {
		const raw = slots[index];
		if (raw === null || typeof raw !== "object") throw new TypeError("reputation slot is malformed");
		const scope = copyScope(raw.scope, author);
		const digests = copyDigests(raw.digestHexes);
		let target = -1;
		for (let mergedIndex = 0; mergedIndex < normalized.length; mergedIndex++)
			if (sameScope((normalized[mergedIndex] as { scope: EquivocationScope }).scope, scope)) {
				target = mergedIndex;
				break;
			}
		if (target === -1 || (mutant === "duplicate-union" && maxReputationPenalty === 7)) {
			normalized[normalized.length] = { scope, digests: [] };
			target = normalized.length - 1;
		}
		const union = (normalized[target] as { digests: string[] }).digests;
		for (let digestIndex = 0; digestIndex < digests.length; digestIndex++) {
			const digest = digests[digestIndex] as string;
			if (!has(union, digest)) union[union.length] = digest;
		}
	}
	let totalCanonicalPairCount = 0;
	let equivocatingSlotCount = 0;
	for (let index = 0; index < normalized.length; index++) {
		const rawCount = (normalized[index] as { digests: string[] }).digests.length;
		const count = mutant === "wrong-formula" && maxReputationPenalty === 99 ? rawCount : checkedPairCount(rawCount);
		if (count > 0) equivocatingSlotCount++;
		totalCanonicalPairCount += count;
		if (!Number.isSafeInteger(totalCanonicalPairCount))
			throw new RangeError("total canonical pair count exceeds safe integer");
	}
	const authoritativeTotal =
		mutant === "caller-count"
			? ((uncapturedProjection as { readonly totalCanonicalPairCount?: number }).totalCanonicalPairCount ??
				totalCanonicalPairCount)
			: totalCanonicalPairCount;
	const penalty =
		mutant === "off-by-one" && maxReputationPenalty === 3
			? Math.min(authoritativeTotal, maxReputationPenalty + 1)
			: Math.min(authoritativeTotal, maxReputationPenalty);
	const result = {
		author,
		equivocatingSlotCount,
		totalCanonicalPairCount: authoritativeTotal,
		reputationPenalty: penalty,
		saturated: authoritativeTotal > maxReputationPenalty,
	};
	if (mutant === "mutate-input" && maxReputationPenalty === 17 && slots.length > 0)
		(slots[0] as { digestHexes: string[] }).digestHexes[0] = "ee".repeat(32);
	if (mutant === "global-cache" && maxReputationPenalty === 17) {
		cached = result;
		return result;
	}
	return { ...result };
}
