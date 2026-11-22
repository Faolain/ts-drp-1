import { encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import { createZoneStateKernel, type ZonePlacementGrowthProjection, type ZonePlacementGrowthSeed } from "../examples/grid/src/zone-state.js";

// Property (resumable seed): Grid's resumable seed of its state bound (beginPlacementGrowthProjection,
// walked in bounded byte steps over the base bytes) is the SAME projection as the synchronous seed
// (createPlacementGrowthProjection) for every material and every step budget, from 1 byte to the whole
// base: both refuse exactly the same bases, and accepted ones quote identically before and after any
// advance. Bases include room states reached by the reducer and hand-built states that break one rule
// the synchronous seed's capture or byte comparison enforces (block order, roster order and presence,
// approval order, fields, creator identity), plus random byte mutations.

const CREATOR = "a".repeat(64);
const PEER = "12D3KooWcreator";
const SEEDS = Number(process.env.RESUMABLE_SEED_PROPERTY_SEEDS ?? 300);

function prng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

function block(random: () => number, pool: number): Record<string, unknown> {
	return {
		action: "placeBlock",
		id: `id-${Math.floor(random() * pool)}-${"x".repeat(Math.floor(random() * 30))}`.slice(0, 4 + Math.floor(random() * 30)),
		kind: ["stone", "gold", "a", "obsidian-with-a-long-name"][Math.floor(random() * 4)] as string,
		x: Math.floor(random() * 2_000_000) - 1_000_000,
		y: Math.floor(random() * 300),
	};
}

function randomOperation(random: () => number, pool: number): Record<string, unknown> {
	const pick = random();
	if (pick < 0.8) return block(random, pool);
	if (pick < 0.9) return { action: "causalJoin" };
	const count = 2 + Math.floor(random() * 4);
	return {
		action: "applicationBatch",
		batch: { version: 1, entries: Array.from({ length: count }, (_, index) => ({ logicalTime: index, operation: block(random, pool) })) },
	};
}

const signer = (digit: string) => digit.repeat(64);
function outcome(random: () => number, id: string, sorted: boolean): Record<string, unknown> {
	const approvals = [
		{ signature: Uint8Array.from({ length: 64 }, () => Math.floor(random() * 256)), signer: signer("1") },
		{ signature: Uint8Array.from({ length: 64 }, () => Math.floor(random() * 256)), signer: signer("2") },
	];
	return {
		action: "commit-outcome-v1",
		proof: {
			action: "commit-outcome-v1",
			approvals: sorted ? approvals : approvals.reverse(),
			clientOperationId: id,
			exactCanonicalIntentBytes: Uint8Array.of(1, 2, 3),
			exactCanonicalPayloadBytes: Uint8Array.of(4, 5),
		},
	};
}

type Kernel = ReturnType<typeof createZoneStateKernel>;

/** A base state: a reducer-reached room state, or a hand-built state that may break one capture rule. */
function randomBase(kernel: Kernel, random: () => number, seed: number): Uint8Array {
	const pool = 1 + Math.floor(random() * 40);
	let state = kernel.apply(
		kernel.emptyState(),
		{ action: "installRoster", roster: { entries: [{ author: CREATOR, peerId: PEER, order: 0 }] } },
		CREATOR
	).state;
	for (let count = Math.floor(random() * 60); count > 0; count--) {
		try {
			state = kernel.apply(state, randomOperation(random, pool), CREATOR).state;
		} catch {
			/* refused: never admitted */
		}
	}
	const plain: Record<string, unknown> = {
		version: state.version,
		creatorAuthor: state.creatorAuthor,
		creatorPeerId: state.creatorPeerId,
		blocks: state.blocks.map((entry) => ({ ...entry })),
		outcomes: [] as unknown[],
		roster: [{ author: CREATOR, peerId: PEER, order: 0 }, { author: signer("3"), peerId: "12D3KooWpeer1", order: 1 }],
	};
	if (random() < 0.3) plain.outcomes = [outcome(random, "op-1", true), outcome(random, "op-2", true)];
	// A third of the bases break one rule (each rule in turn); the rest are room states.
	const broken = seed % 3 === 0 ? (seed / 3) % 12 : 0;
	switch (broken) {
		case 1: // unsorted blocks
			if ((plain.blocks as unknown[]).length > 1) (plain.blocks as unknown[]).reverse();
			break;
		case 2: // roster out of order
			(plain.roster as unknown[]).reverse();
			break;
		case 3: // approvals out of signer order
			plain.outcomes = [outcome(random, "op-1", false)];
			break;
		case 4: // no roster while blocks exist / an empty room
			plain.roster = [];
			if (random() < 0.5) plain.blocks = [];
			break;
		case 5: // an extra field
			plain.extra = 1;
			break;
		case 6: // a foreign creator
			plain.creatorAuthor = "b".repeat(64);
			break;
		case 7: // a missing field
			delete plain.outcomes;
			break;
		case 8: // a duplicate outcome id
			plain.outcomes = [outcome(random, "op-1", true), outcome(random, "op-1", true)];
			break;
		case 9: // blocks as an object
			plain.blocks = { first: (plain.blocks as unknown[])[0] ?? null };
			break;
		default:
			break;
	}
	const bytes = encodeCanonical(plain);
	if (broken === 10 && bytes.byteLength > 0) {
		const mutated = new Uint8Array(bytes);
		mutated[Math.floor(random() * mutated.byteLength)] = Math.floor(random() * 256);
		return mutated;
	}
	if (broken === 11) return bytes.subarray(0, Math.floor(random() * bytes.byteLength));
	return bytes;
}

function runSeed(seed: ZonePlacementGrowthSeed | undefined, budget: number): ZonePlacementGrowthProjection | undefined {
	if (seed === undefined) return undefined;
	try {
		for (let steps = 0; !seed.step(budget); steps++) if (steps > 1_000_000) throw new Error("seed made no progress");
	} catch (error) {
		if ((error as Error).message === "seed made no progress") throw error;
		return undefined;
	}
	return seed.finish();
}

function quotes(projection: ZonePlacementGrowthProjection, probes: readonly Record<string, unknown>[]): unknown {
	return {
		base: projection.quoteWithoutApplicationCandidate(),
		probes: probes.map((probe) => projection.quote(probe)),
		window: projection.quoteWindow({ maxAdditionalActions: 12, maxAdditionalOperationBytes: 1500 }),
	};
}

describe("Grid's resumable seed is its synchronous seed", () => {
	it("for every material and every step budget, from 1 byte to the whole base", () => {
		const kernel = createZoneStateKernel(CREATOR, PEER);
		const verdicts = { accepted: 0, refused: 0, budgets: 0 };
		for (let seed = 1; seed <= SEEDS; seed++) {
			const random = prng(seed);
			const bases = [randomBase(kernel, random, seed)];
			if (random() < 0.2) bases.push(randomBase(kernel, random, seed * 13 + 12));
			const operations = random() < 0.5 ? [] : Array.from({ length: Math.floor(random() * 6) }, () => randomOperation(random, 30));
			const material = {
				exactCanonicalBaseStateBytes: bases,
				currentOperations: operations,
				protectedOperations: [],
				recoveryOperations: random() < 0.2 ? [{ action: "causalJoin" }] : [],
			};
			const probes = Array.from({ length: 4 }, () => randomOperation(random, 30));
			const advance = Array.from({ length: 3 }, () => randomOperation(random, 30));
			const reference = kernel.createPlacementGrowthProjection(material);
			const expected = reference === undefined ? undefined : quotes(reference, probes);
			const advanced = reference === undefined ? undefined : (reference.advance(advance), quotes(reference, probes));
			const whole = Math.max(...bases.map((bytes) => bytes.byteLength), 1);
			const budgets = [...new Set([1, 2, 7, 64, 1 + Math.floor(random() * whole), whole])];
			for (const budget of budgets) {
				const projection = runSeed(kernel.beginPlacementGrowthProjection(material), budget);
				const where = `seed ${seed} budget ${budget}`;
				expect(projection === undefined, where).toBe(reference === undefined);
				if (projection === undefined) continue;
				expect(quotes(projection, probes), where).toEqual(expected);
				projection.advance(advance);
				expect(quotes(projection, probes), `${where} advanced`).toEqual(advanced);
				verdicts.budgets++;
			}
			verdicts[reference === undefined ? "refused" : "accepted"]++;
		}
		console.log(`GRID_RESUMABLE_SEED_PROPERTY ${JSON.stringify({ seeds: SEEDS, ...verdicts })}`);
		expect(verdicts.accepted).toBeGreaterThan(SEEDS / 2);
		expect(verdicts.refused).toBeGreaterThan(SEEDS / 5);
	});

	it("a refused seed stays refused and grants nothing", () => {
		const kernel = createZoneStateKernel(CREATOR, PEER);
		const bytes = encodeCanonical({ version: 2, creatorAuthor: CREATOR, creatorPeerId: PEER, blocks: [], outcomes: [], roster: [], extra: 1 });
		const seed = kernel.beginPlacementGrowthProjection({
			exactCanonicalBaseStateBytes: [bytes],
			currentOperations: [],
			protectedOperations: [],
			recoveryOperations: [],
		})!;
		expect(() => {
			while (!seed.step(1));
		}).toThrow();
		expect(() => seed.step(1)).toThrow();
		expect(seed.finish()).toBeUndefined();
	});
});
