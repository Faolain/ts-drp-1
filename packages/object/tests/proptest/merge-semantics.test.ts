/**
 * Property b) MERGE COMMUTATIVITY / IDEMPOTENCY and c) LINEARIZATION
 * DETERMINISM over a fixed concurrent vertex set.
 *
 * Builds a converged "source" history with the randomized simulator, then
 * feeds the exact same vertex set to fresh observer replicas in different
 * random orders / with duplication, asserting all observers reach the same
 * state, frontier and linearized op order as the source.
 *
 * Run: pnpm vitest run packages/object/tests/proptest/merge-semantics.test.ts
 * Scale knobs (env): PROPTEST_SEEDS, PROPTEST_OPS, PROPTEST_REPLICAS.
 */
import {
	antiEntropy,
	assertConverged,
	checkProperty,
	CLOCK_BASE,
	linearizedHashes,
	type Replica,
	type SeededRandom,
	sortedFrontier,
	stateFingerprint,
	vertexHashes,
} from "@ts-drp/test-utils";
import { type Vertex } from "@ts-drp/types";
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { makeReplicas, runSim } from "./replicas.js";

beforeAll(() => {
	vi.useFakeTimers({ now: CLOCK_BASE });
});

afterAll(() => {
	vi.useRealTimers();
});

const SEEDS = Number(process.env.PROPTEST_SEEDS ?? 12);
const OPS = Number(process.env.PROPTEST_OPS ?? 30);
const REPLICAS = Number(process.env.PROPTEST_REPLICAS ?? 4);

const seeds = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i);

/**
 * merge a shuffled full batch repeatedly until everything applied (or give up)
 * @param observer
 * @param vertices
 * @param rand
 * @param maxPasses
 */
async function mergeUntilApplied(
	observer: Replica,
	vertices: Vertex[],
	rand: SeededRandom,
	maxPasses = 20
): Promise<void> {
	for (let pass = 0; pass < maxPasses; pass++) {
		const batch = rand.shuffle(vertices);
		const { applied } = await observer.obj.applyVertices(batch);
		if (applied) return;
	}
	throw new Error(
		`observer ${observer.peerId} never applied the full batch after ${maxPasses} shuffled passes ` +
			`(has ${vertexHashes(observer).length}, batch union ${new Set(vertices.map((v) => v.hash)).size})`
	);
}

describe("property: merge order-independence and idempotency", () => {
	it(
		"same vertex set, any order, duplicated: identical state/frontier/linearization",
		{ timeout: 600_000 },
		async () => {
			await checkProperty(
				"merge-commutativity",
				seeds(401, SEEDS),
				{ ops: OPS, replicaCount: REPLICAS },
				async (seed, ops, replicaCount) => {
					// build a concurrent history and converge it
					const { replicas, rand, stats } = await runSim({ seed, ops, replicaCount, dims: 2, boxes: 3 });
					await antiEntropy(replicas, rand, stats);
					assertConverged(replicas, `source seed=${seed}`);
					const source = replicas[0];
					const sourceVertices = source.obj.vertices;
					const want = {
						state: stateFingerprint(source),
						frontier: JSON.stringify(sortedFrontier(source)),
						linear: JSON.stringify(linearizedHashes(source)),
					};

					// observers: same object id + acl universe, fresh state, distinct orders
					const observers = makeReplicas(Math.max(3, replicaCount), 2).slice(0, 3);
					// observer 0: natural (causal) order, then everything AGAIN (idempotency)
					await observers[0].obj.applyVertices(sourceVertices);
					await observers[0].obj.applyVertices(sourceVertices);
					// observer 1: random shuffles until applied
					await mergeUntilApplied(observers[1], sourceVertices, rand);
					// observer 2: duplicated + shuffled batches (each vertex twice)
					await mergeUntilApplied(observers[2], [...sourceVertices, ...sourceVertices], rand);
					// idempotency again on observer 1
					await observers[1].obj.applyVertices(rand.shuffle(sourceVertices));

					for (const [i, o] of observers.entries()) {
						const got = {
							state: stateFingerprint(o),
							frontier: JSON.stringify(sortedFrontier(o)),
							linear: JSON.stringify(linearizedHashes(o)),
						};
						for (const key of ["state", "frontier", "linear"] as const) {
							if (got[key] !== want[key]) {
								throw new Error(
									`observer[${i}] ${key} differs from source (seed=${seed}):\n  want ${want[key]}\n  got  ${got[key]}`
								);
							}
						}
					}
				}
			);
		}
	);
});

describe("property: pairwise merge symmetry", () => {
	it("A.merge(B) and B.merge(A) end in identical state and frontier", { timeout: 600_000 }, async () => {
		await checkProperty(
			"merge-symmetry",
			seeds(501, SEEDS),
			{ ops: Math.max(8, Math.floor(OPS * 0.8)), replicaCount: 2 },
			async (seed, ops, replicaCount) => {
				// two replicas diverge with NO gossip at all, then exchange once each way
				const { replicas } = await runSim({
					seed,
					ops,
					replicaCount: Math.max(2, replicaCount),
					dims: 2,
					boxes: 2,
					sendProbability: 0,
				});
				const [a, b] = replicas;
				vi.advanceTimersByTime(1);
				await a.obj.applyVertices(b.obj.vertices);
				await b.obj.applyVertices(a.obj.vertices);
				// a merged first from an older b; one more reverse pass closes the loop
				await a.obj.applyVertices(b.obj.vertices);
				assertConverged([a, b], `seed=${seed} after symmetric exchange`);
				const la = JSON.stringify(linearizedHashes(a));
				const lb = JSON.stringify(linearizedHashes(b));
				if (la !== lb) throw new Error(`linearization asymmetry (seed=${seed}):\n  A ${la}\n  B ${lb}`);
			}
		);
	});
});
