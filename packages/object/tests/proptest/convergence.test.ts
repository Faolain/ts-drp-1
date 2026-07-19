/**
 * Property a) CONVERGENCE and d) PARTITION/HEAL for DRPObject replicas,
 * driven by the seeded randomized harness (no networking, pure objects).
 *
 * Run: pnpm vitest run packages/object/tests/proptest/convergence.test.ts
 *
 * Scale knobs (env): PROPTEST_SEEDS (seeds per property), PROPTEST_OPS,
 * PROPTEST_REPLICAS — defaults are CI-friendly; crank them for bug hunts.
 *
 * On failure the error message contains `seed=... ops=... replicas=...` — the
 * exact minimal reproduction (harness shrinks automatically).
 */
import {
	antiEntropy,
	assertConverged,
	checkProperty,
	CLOCK_BASE,
	linearizedHashes,
	SeededRandom,
} from "@ts-drp/test-utils";
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { makeReplicas, runSim } from "./replicas.js";

beforeAll(() => {
	vi.useFakeTimers({ now: CLOCK_BASE });
});

afterAll(() => {
	vi.useRealTimers();
});

const SEEDS = Number(process.env.PROPTEST_SEEDS ?? 20);
const OPS = Number(process.env.PROPTEST_OPS ?? 50);
const REPLICAS = Number(process.env.PROPTEST_REPLICAS ?? 5);

const seeds = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i);

describe("property: convergence under randomized gossip (2D box game)", () => {
	it("all replicas converge to identical state + frontier after full propagation", { timeout: 600_000 }, async () => {
		await checkProperty(
			"convergence-2d",
			seeds(1, SEEDS),
			{ ops: OPS, replicaCount: REPLICAS },
			async (seed, ops, replicaCount) => {
				const { replicas, rand, stats } = await runSim({ seed, ops, replicaCount, dims: 2, boxes: 3 });
				await antiEntropy(replicas, rand, stats);
				assertConverged(replicas, `seed=${seed}`);
			}
		);
	});
});

describe("property: convergence under randomized gossip (3D box game)", () => {
	it("all replicas converge to identical state + frontier after full propagation", { timeout: 600_000 }, async () => {
		await checkProperty(
			"convergence-3d",
			seeds(101, Math.max(6, Math.floor(SEEDS / 2))),
			{ ops: Math.max(10, Math.floor(OPS * 0.8)), replicaCount: Math.max(2, REPLICAS - 1) },
			async (seed, ops, replicaCount) => {
				const { replicas, rand, stats } = await runSim({ seed, ops, replicaCount, dims: 3, boxes: 3 });
				await antiEntropy(replicas, rand, stats);
				assertConverged(replicas, `seed=${seed}`);
			}
		);
	});
});

describe("property: convergence under hostile network (loss, dup, reorder, long delays, tied timestamps)", () => {
	it("all replicas converge despite heavy loss/duplication/reordering", { timeout: 600_000 }, async () => {
		await checkProperty(
			"convergence-hostile",
			seeds(601, SEEDS),
			{ ops: OPS, replicaCount: REPLICAS },
			async (seed, ops, replicaCount) => {
				const { replicas, rand, stats } = await runSim({
					seed,
					ops,
					replicaCount,
					dims: 2,
					boxes: 2,
					sendProbability: 0.9,
					duplicateProbability: 0.5,
					subsetProbability: 0.6,
					maxDelaySteps: 25,
					minTickMs: 0,
				});
				await antiEntropy(replicas, rand, stats);
				assertConverged(replicas, `seed=${seed}`);
			}
		);
	});
});

describe("property: checkpoint replay under hostile network", () => {
	const checkpointSuffixSize = 24;
	let previousCheckpointSuffixSize: string | undefined;

	beforeAll(() => {
		previousCheckpointSuffixSize = process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
		process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = String(checkpointSuffixSize);
	});

	afterAll(() => {
		if (previousCheckpointSuffixSize === undefined) {
			delete process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
		} else {
			process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = previousCheckpointSuffixSize;
		}
	});

	it("converges after crossing several checkpoint boundaries", { timeout: 600_000 }, async () => {
		await checkProperty(
			"convergence-checkpoint-replay",
			seeds(701, 3),
			{ ops: 120, replicaCount: 4 },
			async (seed, ops, replicaCount) => {
				const { replicas, rand, stats } = await runSim({
					seed,
					ops,
					replicaCount,
					dims: 2,
					boxes: 2,
					sendProbability: 0.9,
					duplicateProbability: 0.5,
					subsetProbability: 0.6,
					maxDelaySteps: 25,
					minTickMs: 0,
				});
				await antiEntropy(replicas, rand, stats);
				for (const replica of replicas) {
					if (replica.obj.vertices.length <= checkpointSuffixSize * 3) {
						throw new Error(
							`checkpoint run did not cross three suffix boundaries: ${replica.peerId} has ${replica.obj.vertices.length} vertices`
						);
					}
				}
				assertConverged(replicas, `seed=${seed} checkpointSuffixSize=${checkpointSuffixSize}`);
			}
		);
	});
});

describe("property: linearization determinism after convergence", () => {
	it(
		"converged replicas linearize the identical vertex set to the identical op order",
		{ timeout: 600_000 },
		async () => {
			await checkProperty(
				"linearization-determinism",
				seeds(201, Math.max(6, Math.floor(SEEDS / 2))),
				{ ops: Math.max(10, Math.floor(OPS * 0.8)), replicaCount: Math.max(2, REPLICAS - 1) },
				async (seed, ops, replicaCount) => {
					const { replicas, rand, stats } = await runSim({ seed, ops, replicaCount, dims: 2, boxes: 2 });
					await antiEntropy(replicas, rand, stats);
					assertConverged(replicas, `seed=${seed}`);
					const ref = linearizedHashes(replicas[0]);
					const repeated = linearizedHashes(replicas[0]);
					if (JSON.stringify(repeated) !== JSON.stringify(ref)) {
						throw new Error(`unchanged graph returned unstable linearization arrays (seed=${seed})`);
					}
					for (const r of replicas.slice(1)) {
						const other = linearizedHashes(r);
						if (JSON.stringify(other) !== JSON.stringify(ref)) {
							throw new Error(
								`linearization mismatch between ${replicas[0].peerId} and ${r.peerId}:\n` +
									`  ${ref.map((h) => h.slice(0, 8)).join(" -> ")}\n` +
									`  ${other.map((h) => h.slice(0, 8)).join(" -> ")}`
							);
						}
					}
				}
			);
		}
	);
});

describe("property: partition / heal", () => {
	it("groups progressing independently converge after healing", { timeout: 600_000 }, async () => {
		await checkProperty(
			"partition-heal",
			seeds(301, Math.max(6, Math.floor(SEEDS / 2))),
			{ ops: Math.max(10, Math.floor(OPS * 0.75)), replicaCount: Math.max(4, REPLICAS + 1) },
			async (seed, ops, replicaCount) => {
				const rand0 = new SeededRandom(seed * 7 + 1);
				// random partition into 2-3 groups
				const groupCount = replicaCount <= 3 ? 2 : rand0.intBetween(2, 3);
				const partitions: number[][] = Array.from({ length: groupCount }, () => []);
				for (let i = 0; i < replicaCount; i++) partitions[i < groupCount ? i : rand0.int(groupCount)].push(i);

				const replicas = makeReplicas(replicaCount, 2);
				// phase 1: some shared history so partitions diverge from a common base
				const phase1 = await runSim({ seed, ops: Math.max(4, Math.floor(ops / 4)), replicaCount, dims: 2 }, replicas);
				await antiEntropy(replicas, phase1.rand, phase1.stats);

				// phase 2: partitioned progress (gossip only within groups)
				const phase2 = await runSim({ seed: seed + 1, ops, replicaCount, dims: 2, partitions }, replicas);

				// heal: full anti-entropy across everyone
				await antiEntropy(replicas, phase2.rand, phase2.stats);
				assertConverged(replicas, `seed=${seed} partitions=${JSON.stringify(partitions)}`);
			}
		);
	});
});
