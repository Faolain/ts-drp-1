import { encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import { createZoneStateKernel } from "../examples/grid/src/zone-state.js";

// Property (room state limit, bound path): the room's admission refuses a move when the
// application's own state bound passes the room's limit (readOrdinaryApplicationResourceBound, the
// bound the creator's proof book charges). That is safe only if the exact encoded state never
// exceeds the bound. Grid's bound is an incremental max-per-ID projection over a base state and every
// operation advanced into it, in ANY subset and order. Checked here over random operation sequences
// that re-place ids with longer and shorter variants (the max-per-ID case), batches, causal joins and
// roster declarations, and over random reorderings of the same operations.

const CREATOR = "a".repeat(64);
const PEER = "12D3KooWcreator";
const SEEDS = Number(process.env.STATE_BOUND_PROPERTY_SEEDS ?? 200);

function prng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

function randomOperation(random: () => number, pool: number): Record<string, unknown> {
	const pick = random();
	const block = () => ({
		action: "placeBlock",
		id: `id-${Math.floor(random() * pool)}-${"x".repeat(Math.floor(random() * 40))}`.slice(0, 8 + Math.floor(random() * 40)),
		kind: ["stone", "gold", "a", "obsidian-with-a-long-name"][Math.floor(random() * 4)] as string,
		x: Math.floor(random() * 2_000_000) - 1_000_000,
		y: Math.floor(random() * 300),
	});
	if (pick < 0.75) return block();
	if (pick < 0.85) return { action: "causalJoin" };
	if (pick < 0.95) {
		const count = 2 + Math.floor(random() * 4);
		return {
			action: "applicationBatch",
			batch: { version: 1, entries: Array.from({ length: count }, (_, index) => ({ logicalTime: index, operation: block() })) },
		};
	}
	const members = 1 + Math.floor(random() * 3);
	return {
		action: "installRoster",
		roster: {
			entries: Array.from({ length: members }, (_, index) => ({
				author: index === 0 ? CREATOR : String(index).repeat(64).slice(0, 64),
				peerId: `12D3KooWpeer${index}`,
				order: index,
			})),
		},
	};
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
	const result = [...values];
	for (let index = result.length - 1; index > 0; index--) {
		const other = Math.floor(random() * (index + 1));
		[result[index], result[other]] = [result[other] as T, result[index] as T];
	}
	return result;
}

describe("Grid's state bound dominates every exact state", () => {
	it("over random sequences, re-placed variants, batches, joins and roster declarations, in any order", () => {
		const kernel = createZoneStateKernel(CREATOR, PEER);
		let checked = 0;
		let tightest = Number.POSITIVE_INFINITY;
		for (let seed = 1; seed <= SEEDS; seed++) {
			const random = prng(seed);
			const pool = 1 + Math.floor(random() * 24);
			// A base state reached by some admitted prefix (sealed exactly as the room seals it).
				// A room's state always starts with the creator's roster installed (its first move); a state with
				// blocks and no installed roster is not a room state, and the bound declines it (undefined: the
				// admission falls back to the exact fold).
			let base = kernel.apply(
					kernel.emptyState(),
					{ action: "installRoster", roster: { entries: [{ author: CREATOR, peerId: PEER, order: 0 }] } },
					CREATOR
				).state;
			for (let count = Math.floor(random() * 12); count > 0; count--) {
				try {
					base = kernel.apply(base, randomOperation(random, pool), CREATOR).state;
				} catch {
					/* an operation the reducer refuses is never admitted */
				}
			}
			const baseBytes = encodeCanonical(base);
			const projection = kernel.createPlacementGrowthProjection({
				exactCanonicalBaseStateBytes: [baseBytes],
				currentOperations: [],
				protectedOperations: [],
				recoveryOperations: [],
			});
			expect(projection, `seed ${seed}: the bound covers its own base`).toBeDefined();
			expect(baseBytes.byteLength).toBeLessThanOrEqual(projection!.quoteWithoutApplicationCandidate()!.byteLength);
			let state = base;
			const admitted: Record<string, unknown>[] = [];
			for (let count = 0; count < 40; count++) {
				const operation = randomOperation(random, pool);
				const quote = projection!.quote(operation);
				let next;
				try {
					next = kernel.apply(state, operation, CREATOR).state;
				} catch {
					continue;
				}
				expect(quote, `seed ${seed}: the bound covers ${String(operation.action)}`).toBeDefined();
				const exact = encodeCanonical(next).byteLength;
				expect(exact, `seed ${seed} step ${count}: exact ${exact} <= bound ${quote!.byteLength}`).toBeLessThanOrEqual(
					quote!.byteLength
				);
				tightest = Math.min(tightest, quote!.byteLength - exact);
				expect(projection!.advance([operation])).toBe(true);
				state = next;
				admitted.push(operation);
				checked++;
			}
			// Any other order of the same admitted operations stays within the advanced bound.
			const bound = projection!.quoteWithoutApplicationCandidate()!.byteLength;
			for (let order = 0; order < 4; order++) {
				let reordered = base;
				for (const operation of shuffled(admitted, random)) {
					try {
						reordered = kernel.apply(reordered, operation, CREATOR).state;
					} catch {
						/* refused in this order: not admitted in it */
					}
					expect(encodeCanonical(reordered).byteLength).toBeLessThanOrEqual(bound);
				}
			}
		}
		console.log(`GRID_STATE_BOUND_PROPERTY ${JSON.stringify({ seeds: SEEDS, checked, tightestSlack: tightest })}`);
		expect(checked).toBeGreaterThan(SEEDS);
	});
});
