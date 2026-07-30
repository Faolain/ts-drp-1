import type { EquivocationScope } from "../../../packages/protocol-v3/src/index.js";

export interface DetachedAuthorGossipSlot {
	readonly scope: EquivocationScope;
	readonly digestHexes: readonly string[];
}

export interface DetachedAuthorGossipProjection {
	readonly author: string;
	readonly slots: readonly DetachedAuthorGossipSlot[];
}

export interface AuthorGossipBudgetPolicy {
	readonly maxGossipPairCount: number;
}

export interface AuthorGossipPair {
	readonly scope: EquivocationScope;
	readonly lesserDigestHex: string;
	readonly greaterDigestHex: string;
}

export interface AuthorGossipBudgetComposition {
	readonly author: string;
	readonly selectedPairs: readonly AuthorGossipPair[];
	readonly totalPairCount: number;
	readonly suppressedPairCount: number;
	readonly saturated: boolean;
}

type Mutant =
	| "array-dispatch"
	| "caller-count"
	| "double-count"
	| "global-cache"
	| "late-policy-read"
	| "local-slot-only"
	| "off-by-one"
	| "ordered-pair"
	| "self-pair"
	| "saturation-adjacent-read"
	| "saturation-mutates"
	| "unstable-order"
	| "unsafe-policy"
	| "wall-clock"
	| "forbidden-surface"
	| "mutate-input";

const mutant = process.env.PHASE_0O_B2_MUTANT as Mutant | undefined;
let cachedComposition: AuthorGossipBudgetComposition | undefined;

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function copyScope(value: unknown, author: string): EquivocationScope {
	if (value === null || typeof value !== "object") throw new TypeError("gossip slot scope is malformed");
	const candidate = value as Partial<EquivocationScope>;
	const capturedAuthor = candidate.author;
	const capturedAuthorSequence = candidate.authorSequence;
	const capturedObjectId = candidate.objectId;
	if (
		capturedAuthor !== author ||
		typeof capturedObjectId !== "string" ||
		!Number.isSafeInteger(capturedAuthorSequence) ||
		(capturedAuthorSequence as number) < 0
	) {
		throw new TypeError("gossip slot scope is malformed");
	}
	return {
		author: capturedAuthor,
		authorSequence: capturedAuthorSequence as number,
		objectId: capturedObjectId,
	};
}

function scopeKey(scope: EquivocationScope): string {
	return `${scope.objectId.length}:${scope.objectId}|${scope.authorSequence}`;
}

function copyDigests(values: unknown): string[] {
	if (!Array.isArray(values)) throw new TypeError("gossip slot digests are malformed");
	if (mutant === "array-dispatch") void values[Symbol.iterator]();
	const copied: string[] = [];
	const length = values.length;
	for (let index = 0; index < length; index++) {
		const digest = values[index];
		if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
			throw new TypeError("gossip slot digest is malformed");
		}
		copied[copied.length] = digest;
	}
	return copied;
}

function includes(values: readonly string[], sought: string): boolean {
	for (let index = 0; index < values.length; index++) {
		if (values[index] === sought) return true;
	}
	return false;
}

function insertionSort<Value>(values: Value[], compare: (left: Value, right: Value) => number): void {
	for (let index = 1; index < values.length; index++) {
		const value = values[index] as Value;
		let target = index;
		while (target > 0 && compare(value, values[target - 1] as Value) < 0) {
			values[target] = values[target - 1] as Value;
			target--;
		}
		values[target] = value;
	}
}

function comparePairs(left: AuthorGossipPair, right: AuthorGossipPair): number {
	return (
		compareStrings(left.scope.objectId, right.scope.objectId) ||
		left.scope.authorSequence - right.scope.authorSequence ||
		compareStrings(left.lesserDigestHex, right.lesserDigestHex) ||
		compareStrings(left.greaterDigestHex, right.greaterDigestHex)
	);
}

/**
 * Independent controlled implementation for the frozen Phase 0o-b2 RED.
 * @param uncapturedProjection - Caller-provided detached author digest-set projection.
 * @param uncapturedPolicy - Explicit pure gossip selection policy.
 * @returns Deterministically selected author-wide canonical pair tuples.
 */
export function composeAuthorGossipBudget(
	uncapturedProjection: DetachedAuthorGossipProjection,
	uncapturedPolicy: AuthorGossipBudgetPolicy
): AuthorGossipBudgetComposition {
	if (
		uncapturedProjection === null ||
		typeof uncapturedProjection !== "object" ||
		uncapturedPolicy === null ||
		typeof uncapturedPolicy !== "object"
	) {
		throw new TypeError("gossip budget inputs are required");
	}
	if (mutant === "wall-clock") void Date.now();
	if (mutant === "forbidden-surface") void (uncapturedProjection as { readonly pending?: unknown }).pending;
	const maxGossipPairCount = uncapturedPolicy.maxGossipPairCount;
	if (!Number.isSafeInteger(maxGossipPairCount) || (maxGossipPairCount < 0 && mutant !== "unsafe-policy")) {
		throw new RangeError("maxGossipPairCount must be a nonnegative safe integer");
	}
	if (mutant === "global-cache" && maxGossipPairCount === 17 && cachedComposition !== undefined) {
		return cachedComposition;
	}
	if (mutant === "saturation-adjacent-read" && maxGossipPairCount === 2) {
		void (uncapturedProjection as { readonly futureReputation?: unknown }).futureReputation;
	}
	if (mutant === "late-policy-read" && maxGossipPairCount === 8) void uncapturedPolicy.maxGossipPairCount;
	const author = uncapturedProjection.author;
	const capturedSlots = uncapturedProjection.slots;
	if (typeof author !== "string" || !Array.isArray(capturedSlots)) {
		throw new TypeError("gossip projection is malformed");
	}
	if (mutant === "array-dispatch") void capturedSlots[Symbol.iterator]();

	const merged: Array<{ scope: EquivocationScope; digestHexes: string[] }> = [];
	const slotCount =
		mutant === "local-slot-only" && maxGossipPairCount === 5 ? Math.min(1, capturedSlots.length) : capturedSlots.length;
	for (let index = 0; index < slotCount; index++) {
		const candidate = capturedSlots[index];
		if (candidate === null || typeof candidate !== "object") throw new TypeError("gossip slot is malformed");
		const scope = copyScope(candidate.scope, author);
		const digestHexes = copyDigests(candidate.digestHexes);
		let target = -1;
		for (let mergedIndex = 0; mergedIndex < merged.length; mergedIndex++) {
			if (scopeKey((merged[mergedIndex] as { scope: EquivocationScope }).scope) === scopeKey(scope)) {
				target = mergedIndex;
				break;
			}
		}
		if (target === -1 || (mutant === "double-count" && maxGossipPairCount === 7)) {
			merged[merged.length] = { scope, digestHexes: [] };
			target = merged.length - 1;
		}
		const union = (merged[target] as { digestHexes: string[] }).digestHexes;
		for (let digestIndex = 0; digestIndex < digestHexes.length; digestIndex++) {
			const digest = digestHexes[digestIndex] as string;
			if (!includes(union, digest) || (mutant === "double-count" && maxGossipPairCount === 7)) {
				union[union.length] = digest;
			}
		}
	}

	const pairs: AuthorGossipPair[] = [];
	for (let slotIndex = 0; slotIndex < merged.length; slotIndex++) {
		const slot = merged[slotIndex] as { scope: EquivocationScope; digestHexes: string[] };
		if (
			!(mutant === "ordered-pair" && maxGossipPairCount === 9) &&
			!(mutant === "unstable-order" && maxGossipPairCount === 6)
		) {
			insertionSort(slot.digestHexes, compareStrings);
		}
		for (let leftIndex = 0; leftIndex < slot.digestHexes.length; leftIndex++) {
			const rightStart = mutant === "self-pair" && maxGossipPairCount === 10 ? leftIndex : leftIndex + 1;
			for (let rightIndex = rightStart; rightIndex < slot.digestHexes.length; rightIndex++) {
				const left = slot.digestHexes[leftIndex] as string;
				const right = slot.digestHexes[rightIndex] as string;
				if (left === right && !(mutant === "self-pair" && maxGossipPairCount === 10)) continue;
				const keepEncounterOrder = mutant === "ordered-pair" && maxGossipPairCount === 9;
				const lesser = keepEncounterOrder ? left : left < right ? left : right;
				const greater = keepEncounterOrder ? right : left < right ? right : left;
				let exists = false;
				for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
					const existing = pairs[pairIndex] as AuthorGossipPair;
					if (
						existing.scope.author === slot.scope.author &&
						existing.scope.objectId === slot.scope.objectId &&
						existing.scope.authorSequence === slot.scope.authorSequence &&
						existing.lesserDigestHex === lesser &&
						existing.greaterDigestHex === greater
					) {
						exists = true;
						break;
					}
				}
				if (!exists || (mutant === "double-count" && maxGossipPairCount === 7)) {
					pairs[pairs.length] = {
						scope: { ...slot.scope },
						lesserDigestHex: lesser,
						greaterDigestHex: greater,
					};
				}
			}
		}
	}
	if (!(mutant === "unstable-order" && maxGossipPairCount === 6)) insertionSort(pairs, comparePairs);

	const authoritativeTotal =
		mutant === "caller-count"
			? ((uncapturedProjection as { readonly totalPairCount?: number }).totalPairCount ?? pairs.length)
			: pairs.length;
	const limit =
		mutant === "off-by-one" && maxGossipPairCount === 3
			? Math.min(pairs.length, maxGossipPairCount + 1)
			: Math.min(pairs.length, maxGossipPairCount);
	const selectedPairs: AuthorGossipPair[] = [];
	for (let index = 0; index < limit; index++) {
		const pair = pairs[index] as AuthorGossipPair;
		selectedPairs[index] = {
			scope: { ...pair.scope },
			lesserDigestHex: pair.lesserDigestHex,
			greaterDigestHex: pair.greaterDigestHex,
		};
	}
	if (mutant === "mutate-input" && maxGossipPairCount === 12) {
		(capturedSlots[0] as { digestHexes: string[] }).digestHexes[0] = "ee".repeat(32);
	}
	if (mutant === "saturation-mutates" && maxGossipPairCount === 2) {
		(capturedSlots[0] as { digestHexes: string[] }).digestHexes[0] = "ff".repeat(32);
	}
	const result: AuthorGossipBudgetComposition = {
		author,
		selectedPairs,
		totalPairCount: authoritativeTotal,
		suppressedPairCount: authoritativeTotal - selectedPairs.length,
		saturated: authoritativeTotal > maxGossipPairCount,
	};
	if (mutant === "global-cache" && maxGossipPairCount === 17) cachedComposition = result;
	return result;
}
