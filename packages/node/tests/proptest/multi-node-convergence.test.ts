/**
 * End-to-end multi-node convergence test with REAL DRPNode instances
 * (real libp2p / gossipsub / websockets on loopback) spawned in one process.
 *
 * 5 nodes concurrently move 2D boxes for several rounds; after each round we
 * wait (bounded) for every node to hold identical vertex sets, frontiers and
 * state. On a stall we capture per-node diagnostics (frontier, missing
 * vertices, protocol event counts), then nudge the stalled nodes with an
 * explicit sync and report whether they recover — that distinction
 * (self-healing vs permanently stuck) is the key output for debugging
 * production desync/lockup reports.
 *
 * Run: pnpm vitest run packages/node/tests/proptest/multi-node-convergence.test.ts
 */
import { SeededRandom } from "@ts-drp/test-utils";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
	type Cluster,
	clusterConverged,
	clusterReport,
	spawnCluster,
	stateFingerprint,
	vertexHashes,
	waitFor,
} from "./spawn.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const N = Number(process.env.PROPTEST_NODES ?? 5);
const ROUNDS = Number(process.env.PROPTEST_ROUNDS ?? 4);
const SEED = Number(process.env.PROPTEST_SEED ?? 42);
const CONVERGE_TIMEOUT_MS = 20_000;
const RECOVERY_TIMEOUT_MS = 15_000;
const MAX_RECOVERED_STALLS = 1;
// The production default remains 10s. This real-network convergence test uses
// an accelerated cadence so two complete five-node peer rotations fit inside
// its fixed 20s liveness bound even when gossip drops the final leaf updates.
const SYNC_INTERVAL_MS = 1_000;

describe(`multi-node convergence: ${N} real DRPNodes, ${ROUNDS} rounds (seed=${SEED})`, () => {
	let cluster: Cluster;

	beforeAll(async () => {
		cluster = await spawnCluster(N, { syncIntervalMs: SYNC_INTERVAL_MS });
		const t = cluster.timings;
		console.log(
			`[spawn] N=${N} total=${t.totalMs.toFixed(0)}ms ` +
				`(bootstrap=${t.bootstrapMs.toFixed(0)}ms, nodeStart=${t.nodeStartMs.toFixed(0)}ms, ` +
				`mesh=${t.meshConnectMs.toFixed(0)}ms, objects=${t.objectSetupMs.toFixed(0)}ms)`
		);
	});

	afterAll(async () => {
		await cluster?.stop();
	});

	test("concurrent box moves converge every round; stalls are diagnosed", async () => {
		const rand = new SeededRandom(SEED);
		const boxes = ["box0", "box1", "box2"];
		const roundStats: string[] = [];
		let recoveredStalls = 0;

		for (let round = 0; round < ROUNDS; round++) {
			// every node applies 1-2 moves "simultaneously" (same tick)
			let opsThisRound = 0;
			for (const c of cluster.nodes) {
				const k = 1 + rand.int(2);
				for (let i = 0; i < k; i++) {
					c.obj.drp?.move(rand.pick(boxes), rand.int(100), rand.int(100));
					opsThisRound++;
				}
			}

			const t0 = performance.now();
			let convergedInTime = true;
			try {
				await waitFor(() => clusterConverged(cluster.nodes), CONVERGE_TIMEOUT_MS, `round ${round} convergence`);
			} catch {
				convergedInTime = false;
			}
			const dt = performance.now() - t0;
			let convergenceSummary = `converged in ${dt.toFixed(0)}ms`;

			if (!convergedInTime) {
				const stallReport = clusterReport(cluster.nodes);
				// Which node has the most vertices? Nudge everyone to sync from it.
				const best = [...cluster.nodes].sort((a, b) => vertexHashes(b).length - vertexHashes(a).length)[0];
				const syncTargets = cluster.nodes.filter((candidate) => candidate !== best);
				const recoveryStartedAt = performance.now();
				const syncResults = await Promise.allSettled(
					syncTargets.map(async (target) => {
						await target.node.syncObject(cluster.objectId, best.peerId);
						return target.index;
					})
				);
				const syncFailures = syncResults.flatMap((result, index) =>
					result.status === "rejected" ? [{ nodeIndex: syncTargets[index].index, reason: result.reason }] : []
				);
				let recoveryWaitError: unknown;
				try {
					await waitFor(() => clusterConverged(cluster.nodes), RECOVERY_TIMEOUT_MS, "post-nudge convergence window");
				} catch (error) {
					recoveryWaitError = error;
				}
				const recovered = recoveryWaitError === undefined;
				const recoveryMs = performance.now() - recoveryStartedAt;
				const postNudgeReport = clusterReport(cluster.nodes);
				const syncFailureReport =
					syncFailures.length === 0
						? ""
						: `Targeted sync send errors:\n${syncFailures
								.map(
									({ nodeIndex, reason }) =>
										`- node${nodeIndex}: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
								)
								.join("\n")}\n`;
				const diagnostic =
					`${recovered ? "RECOVERED AUTONOMOUS STALL" : "UNRECOVERED AUTONOMOUS STALL"} at round ${round} (seed=${SEED}, N=${N}): nodes did not converge within ${CONVERGE_TIMEOUT_MS}ms.\n` +
					(recovered
						? `The cluster converged during the ${RECOVERY_TIMEOUT_MS}ms post-nudge window after one targeted sync pass from node${best.index}; background anti-entropy remained active.\n`
						: `The cluster did not converge within ${RECOVERY_TIMEOUT_MS}ms after one targeted sync pass from node${best.index}; background anti-entropy remained active.\n`) +
					syncFailureReport +
					(recoveryWaitError === undefined
						? ""
						: `Post-nudge wait error: ${recoveryWaitError instanceof Error ? (recoveryWaitError.stack ?? recoveryWaitError.message) : String(recoveryWaitError)}\n`) +
					`--- state at stall ---\n${stallReport}\n` +
					`--- state after nudge ---\n${postNudgeReport}`;

				const diagnosticCauses = [
					...syncFailures.map(({ reason }) => reason),
					...(recoveryWaitError === undefined ? [] : [recoveryWaitError]),
				];
				const diagnosticCause =
					diagnosticCauses.length === 0
						? undefined
						: diagnosticCauses.length === 1
							? diagnosticCauses[0]
							: new AggregateError(diagnosticCauses, "Targeted sync pass and post-nudge wait errors");

				if (!recovered) {
					throw diagnosticCause === undefined
						? new Error(diagnostic)
						: new Error(diagnostic, { cause: diagnosticCause });
				}

				console.warn(diagnostic);
				recoveredStalls++;
				if (recoveredStalls > MAX_RECOVERED_STALLS) {
					const budgetDiagnostic =
						`${diagnostic}\nRecovered autonomous stall budget exceeded: ` +
						`${recoveredStalls} observed, maximum allowed ${MAX_RECOVERED_STALLS}.`;
					throw diagnosticCause === undefined
						? new Error(budgetDiagnostic)
						: new Error(budgetDiagnostic, { cause: diagnosticCause });
				}
				convergenceSummary =
					`transient autonomous stall after ${dt.toFixed(0)}ms; ` +
					`cluster converged during the post-nudge window in ${recoveryMs.toFixed(0)}ms ` +
					`(${recoveredStalls}/${MAX_RECOVERED_STALLS} recovered stall budget used)`;
			}

			roundStats.push(
				`[round ${round}] ops=${opsThisRound} ${convergenceSummary}, ` +
					`vertices=${vertexHashes(cluster.nodes[0]).length}`
			);
		}

		console.log(roundStats.join("\n"));
		console.log("[events per node]", cluster.nodes.map((c) => `node${c.index}=${JSON.stringify(c.events)}`).join(" "));

		// final strong assertion: identical serialized state everywhere
		const ref = stateFingerprint(cluster.nodes[0]);
		for (const c of cluster.nodes) expect(stateFingerprint(c)).toEqual(ref);
		expect(clusterConverged(cluster.nodes)).toBe(true);
	});
});
