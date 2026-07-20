/**
 * Spawn-cost probe: how expensive is it to boot N real DRPNodes (+ 1
 * bootstrap relay) in one process, mesh them, create a shared object and
 * push one round of ops through? Prints a timing breakdown per N.
 *
 * Run: pnpm vitest run packages/node/tests/proptest/spawn-scaling.test.ts
 * Env: PROPTEST_SCALE_NS="3,6,9" to choose cluster sizes.
 */
import { describe, expect, test, vi } from "vitest";

import { clusterConverged, clusterReport, spawnCluster, waitFor } from "./spawn.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

const NS = (process.env.PROPTEST_SCALE_NS ?? "3,6,9").split(",").map(Number);

describe("spawn scaling of real DRPNode clusters", () => {
	test(`cluster sizes ${NS.join(", ")}: spawn timings and one convergence round`, async () => {
		const results: string[] = [];
		for (const n of NS) {
			const cluster = await spawnCluster(n, {
				objectId: `scaling-object-${n}`,
				syncIntervalMs: 1_000,
			});
			try {
				const t = cluster.timings;
				// one round of concurrent ops on every node
				for (const [i, c] of cluster.nodes.entries()) c.obj.drp?.move(`box${i % 3}`, i, i);
				const t0 = performance.now();
				let converged = true;
				try {
					await waitFor(() => clusterConverged(cluster.nodes), 30_000, `N=${n} one-round convergence`);
				} catch {
					converged = false;
				}
				const convergeMs = performance.now() - t0;
				results.push(
					`N=${n}: spawn total=${t.totalMs.toFixed(0)}ms ` +
						`(bootstrap=${t.bootstrapMs.toFixed(0)}, nodeStart=${t.nodeStartMs.toFixed(0)}, ` +
						`mesh=${t.meshConnectMs.toFixed(0)}, objects=${t.objectSetupMs.toFixed(0)}) ` +
						`bootstrapRedials=${cluster.bootstrapRedials} ` +
						`one-round convergence=${converged ? `${convergeMs.toFixed(0)}ms` : `TIMED OUT`}`
				);
				if (!converged) {
					results.push(clusterReport(cluster.nodes));
				}
				expect(converged, `N=${n} failed to converge:\n${clusterReport(cluster.nodes)}`).toBe(true);
			} finally {
				await cluster.stop();
			}
		}
		console.log(results.join("\n"));
	});
});
