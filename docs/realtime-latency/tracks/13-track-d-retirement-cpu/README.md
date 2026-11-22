# Track D: shrink retirement maintenance CPU

**Outcome:** Landed in de70325e (browser bounded-read prefetch; ~-36% per-epoch maintenance, 2x target not met).

**Working documents in this folder:** [DESIGN.md](DESIGN.md), [NUMBERS.md](NUMBERS.md), [TESTS.md](TESTS.md)

### Brief (plan given to the agent) (2026-10-19 14:17 UTC)

You are a fork of me. Everything up to commit 4c4f192c is committed; your worktree starts from it. Objective: real-time games. You own TRACK D: make the recovery-pool retirement work itself cheap. Today it costs ~3.0–3.3 s per epoch from epoch 3 whether it runs in the seal or at the lull (`pool-maintenance-lull` spans; run with STARTUP_HEALTHY_GRID_POOL_LULL=1). Moving it only relocates the cost; shrink it.

Known targets:
- closedRetirementEqual encodes both sides to compare them (~0.6 s per run).
- Repeated whole signing/journal image acquisition and comparison across cleanup checkpoints (named as a remaining target in commit 3c5bb123's message).
- Retirement-control encode/capture repeated (~0.8 s per run). Earlier analysis: the captured value holds mutable byte arrays and capture may normalize, so identity caching was unsound as-is; consider content-keyed or exact-bytes approaches instead.
- inspectTrustClosure / authenticate / acquireRecoveryRoleCertificate repeated per pass.
- Bounded census reads (runBoundedSteps, roleCensusSteps, logicalByteRow encoding just for byte counts).
- encodeCanonical spread across many callers.

Profile a lull run (STARTUP_HEALTHY_GRID_CPU_PROFILE=1; scratchpad profrun.sh, spanprof.py, callers.py and callees.py) restricted to the pool-maintenance-lull windows. Then cut the top costs with verify-once / exact-input reuse inside one maintenance job, keeping every fresh native currency check, authorization and full proof charge at its original boundary. Target at least a 2× reduction in per-epoch maintenance wall time. If the structure allows it cheaply, also make the job yield between bounded steps so no single task exceeds ~16 ms.

Scope:
- Yours: the maintenance and reconciliation parts of creator-closed-rollback-data.ts (reconcileCreatorBoundedRecoveryMaintenance, reconcileSnapshotRecoveryRoles, installClosedRetirementSource, applyClosedEpochRetirementIntent and their helpers), runtime-reclamation.ts, closed-epoch-cleanup, packages/storage and storage-browser retirement code, and packages/canonical.
- Other agents own the per-move admission code (acquireCreatorOrdinaryIssuanceMaintenanceProof, reserveCreatorOrdinaryFinishingCapacity and nearby), the creator maintainRecoveryPool region, ingress queuing, and recipient install. Keep your hunks out of those regions.
- Do not touch packages/storage-browser/src/internal/native-read-reservation.ts.

Rules:
- Build dists first: canonical, storage, storage-browser and control-plane. Copy the gitignored benchmark .logs inputs if needed.
- Never use rm -rf. Commit only in your worktree branch; do not push.
- Name benchmark runs with an `rd2-` prefix and use interleaved paired runs at 8 rollovers, with and without the lull.
- Report per-epoch lull maintenance time, seal t4–t7 without the lull, and the CPU-profile top costs before and after.
- Tests: affected node and storage suites before and after (`--exclude ".claude/**"`).

Deliverables in scratchpad/track-d/: DESIGN.md (soundness per reused fact), patch.diff (against 4c4f192c), the test comparison, and the numbers. Keep the final report concise.

### Follow-up instruction — Resume Track D after turn limit (2026-10-19 15:17 UTC)

Continue Track D from where you stopped (turn limit hit mid-edit: rewriting finishSorted allocation-free). Be economical with turns: finish or revert that codec change (if you keep it, the canonical codec-differential tests must pass), keep only changes that are sound and measurably help, get canonical/storage/storage-browser/node typechecking, run the affected canonical + storage + storage-browser tests against a baseline, and do one or two interleaved paired bench runs (rd2- prefix) with STARTUP_HEALTHY_GRID_POOL_LULL=1 against your base build, reporting the per-epoch pool-maintenance cost (the ~3 s figure) and seal t4–t7. Then finish with a concise final report in your reply (what changed, soundness argument, measured before/after, test delta, path to a patch file in scratchpad/track-d/). Subagents can't write REPORT.md, so put it in the reply. Do not commit; leave changes in the worktree.

### Report returned by the agent

Task: cut the recovery-pool retirement maintenance cost per epoch (target ≥2×) without moving any fresh native check, authorization or proof charge, and leave the result uncommitted.

**The 2× target is not met.** Paired runs show the per-epoch maintenance going from about 3.4 s to about 2.2 s (−36%). The patched runs happened to land at lower machine load, so part of that drop is load, not the change.

Nothing is committed; the changes are in the worktree (9 files, +387/−257). Patch: `<evidence>/track-d/patch.diff` (against 4c4f192c).

**Where the time goes:** each epoch runs 4 passes. Each pass re-acquires recovery data, plans, and installs a two-phase commit across about 6 participants, at fresh native boundaries. About a third of the time is idle, waiting on IndexedDB. Of the CPU, the canonical codec is the largest single owner (about 27%); the rest is spread across dozens of 10–60 ms verifiers. No single in-scope cost dominates.

**What changed:**
1. **Read-ahead in the retirement admission check** (`bounded-read.ts`, `retirement-control.ts`, `idb-adapter.ts`). The check now announces the blobs it is about to read, and the browser loader sends those reads early, up to 16 at a time, in the same transaction. Generation records and promotion keys are read ahead the same way, and the key cursor became one bounded key read over the exact object range.
   - Why it's sound: reads in one IndexedDB transaction run in order, and nothing writes between the early read and the step that uses it (every caller waits for the whole check before writing).
   - Every check still runs at its original step, and a failed early read goes back to that step's own read.
2. **Bulk reads instead of cursor walks** in `live-journal.ts`, `browser-issuance-store.ts`, `snapshot-transfer.ts` and `signing-retirement.ts`. Each runs after the existing count, in the same transaction, limited to count+1 rows. Rows come back in the same key order, the original per-row checks run in the original order, and the existing row-count check still catches any mismatch. The chunks cursor, which carries payload bytes, is unchanged.
3. **Canonical encoder** (`codec.ts`): sorting object entries no longer allocates, the count header and integers are written without BigInt, and output bytes are identical. The comparison tests against the frozen reference encoder pass. In a microbenchmark, encoding object-heavy values is 25–30% faster.

The soundness argument for each change is in `DESIGN.md`.

**Before/after** (8 rollovers, lull on, runs ordered patched–base–base–patched):

| run | load | maintenance p50 per epoch | sum of 8 | seal t4 / t5 / t6 / t7 |
|---|---|---|---|---|
| patched, run 1 | 40 | 2095 ms | 11085 | 301 / 277 / 271 / 271 |
| base, run 1 | 76 | 3638 ms | 19294 | 796 / 512 / 668 / 461 |
| base, run 2 | 65 | 3118 ms | 17285 | 406 / 507 / 844 / 455 |
| patched, run 2 | 45 | 2218 ms | 12358 | 355 / 300 / 340 / 278 |

- Recipient install t7 went from about 1.7–1.8 s to about 1.03–1.06 s, and the creator's per-move p50 from 98–105 ms to 68–75 ms.
- **The machine was shared, so treat these as noisy.** An earlier build with only the read changes (no encoder change) gave 2843 ms at load 30, against 3291 ms for base at load 55.
- Its CPU profile showed the same CPU per epoch as the baseline (11.4 s vs 11.2 s over 8 epochs). So the read changes reduce IndexedDB requests and their per-request cost, not CPU.
- I did not take a profiled run of the final build.

**Tests:** baseline and patched give identical results, with dists rebuilt after each switch.
- **Typecheck:** the build configs for canonical, storage, storage-browser and node have 0 errors in both states.
- **canonical:** 37/37.
- **storage:** 264/264.
- **storage-browser:** 284 pass and 10 fail in both, the same 10 tests.
  - 9 are governance/package-shape tests that fail on project-config type errors.
  - 1 is journal-image-single-capture.

**What still blocks 2×, all outside Track D's scope:**
- The HeldReadView `#pump` keep-alive in `native-read-reservation.ts`: more than half of all IndexedDB requests per pass.
- `readCreatorRecoveryDependencyCensus` in v3-live: about 46 transactions per pass.
- psource: about 250–300 ms per epoch.
- Merging passes, or reusing one pass's recovery read in the next, would remove the fresh-census boundaries, so I didn't do it.

Files are in `<evidence>/track-d/`:
- `patch.diff`
- `DESIGN.md`
- `NUMBERS.md`
- `TESTS.md`
