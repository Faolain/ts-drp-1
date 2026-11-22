# Track H (main-thread long tasks): go / no-go

## Verdict: NO-GO, because of typecheck only

The performance and test criteria pass. The typecheck criterion fails:

- **Long tasks improve.** The max task drops in seal, creator adoption and the creator lull. In each of those windows, every H run is below every BASE run.
- **Totals are not worse beyond noise.** Seal, adoption and lull are flat or better. Recipient install is +30 ms on the all-transition mean; that is within noise, as the section on totals below shows.
- **No new test failures.** Two tests went passed → failed in the full H run. Both were load timeouts, and both pass when rerun on H.
- **Typecheck regressed.** `pnpm -r typecheck` gives BASE **0 errors** and H **5 errors**, in 2 failed projects. All 5 errors are in H's two **new test files**, and the product sources typecheck clean. In detail:
  - `packages/canonical/tests/resource-sizing-differential.test.ts`:
    - (3,26) TS5097: the import path `../src/internal/codec.ts` ends in `.ts`, which needs `allowImportingTsExtensions`. The other canonical tests import `.js`.
    - (4,28) TS5097: the same problem for `./reference/codec-v1.ts`.
    - (31,24) TS2737: the BigInt literal `10n` is not allowed when the target is ES6.
  - `packages/compaction/tests/blueprint-canonical-state-equivalence.test.ts`:
    - (116,43) TS2571: `Object is of type 'unknown'`, from `failure(...).hasOwnProperty`.
    - (127,23) TS2379: under `exactOptionalPropertyTypes`, `EpochVertex["operation"]` includes `undefined`, so the `drp-vertex` literal is not assignable.

These are test-only fixes: use `.js` import paths, replace `10n` with `BigInt(10)`, and type the two compaction test expressions. Once they are fixed, H meets every criterion of the rule. I made no commit, because the verdict is NO-GO.

## Setup

- **Worktree:** `<worktree agent-ae5eae11263189894>/`, branch `worktree-agent-ae5eae11263189894`. HEAD was moved from d041baff to **de70325e** with `git switch -C`, because the hook blocks `git reset --hard`.
- **Bundles:** both are built from that worktree, in `track-h2/BASE` and `track-h2/H`.
  - **BASE** is de70325e plus only the `tests/fixtures/startup-discovery/healthy-grid.ts` hunk of `track-h/patch.diff`. That hunk is Track H's measurement-only trace window, which stops the trace after the gameplay that follows lull 5. Without it, the two bundles would trace different windows. I applied it to both bundles, which matches Track H's own BASE.
  - **H** is de70325e plus the full `patch.diff`.
- **Bundle inputs, checked with `metafile.json` and the markers in `inputs.py`:**
  - The bundle uses **canonical and compaction from both dist and src**. Compaction dist therefore also has to be rebuilt per variant, not only canonical, storage and storage-browser.
  - Protocol-v3 and node come only from src.
  - The H bundle contains every patch marker (`primitiveResourceWidth`, `applyPreparedBlueprintOperationToCanonicalState`, `generationSourceFromSelected`, `internKey`, `stateWithinLimits`). The BASE bundle contains none of them.
- **Note on Track H's own bundle.** Track H's `build-lt-fix4` bundle also pulled in `../../../packages/canonical/dist/src/internal/codec.js`, which is the **main checkout's** base codec dist (64,981 B), next to the fix dist. That happened because its `.logs` inputs resolved through the main checkout. My bundles have no such stray input.
- **`.logs` inputs:** I copied them into my worktree from a sibling worktree. They are byte-identical (`cmp`) to the copies restored in the main checkout.
- **Measurement:** Track H's method.
  - Settings: `STARTUP_HEALTHY_GRID_TASK_TRACE=window`, `POOL_LULL=1`, `ROLLOVERS=8`.
  - Long tasks are renderer-main `RunTask` events that overlap each product window. The analysis is in `analyze.py`, which reproduces `tasks.py` and `summary.py`.
  - The trace covers seal, creator adoption and recipient install of transition 4, and the creator lull labelled 5.

## Runs: order BASE, H, H, BASE, BASE, H. All 6 passed.

| run | bundle | test ms | 1-min load before | 1-min load after | trace tasks | trace max ms |
|---|---|---|---|---|---|---|
| r1 | BASE | 71216 | 30.66 | 21.83 | 119265 | 520.4 |
| r2 | H | 69174 | 21.83 | 19.24 | 117345 | 518.0 |
| r3 | H | 81626 | 19.24 | 30.63 | 119046 | 513.3 |
| r4 | BASE | 76867 | 30.63 | 42.22 | 119007 | 524.7 |
| r5 | BASE | 71506 | 42.22 | 29.88 | 120828 | 531.7 |
| r6 | H | 71080 | 29.88 | 37.71 | 116030 | 534.7 |

The pairs, in execution order, are (r1 BASE, r2 H), (r4 BASE, r3 H) and (r5 BASE, r6 H). The trace max of about 520 ms appears in both variants and overlaps none of the four measured windows below; every per-window max is under 60 ms.

## Traced windows: total ms and long tasks

Values are per run in the order r1/r4/r5 for BASE and r2/r3/r6 for H.

| window | metric | BASE runs | BASE mean | H runs | H mean | H − BASE |
|---|---|---|---|---|---|---|
| seal t4 (creator) | total ms | 667.1 / 461.9 / 670.7 | 599.9 | 418.4 / 682.3 / 437.1 | 512.6 | −87.3 |
| | max task ms | 24.1 / 26.4 / 26.1 | **25.5** | 17.5 / 17.2 / 18.5 | **17.7** | **−7.8** |
| | tasks >16 ms | 1 / 1 / 1 | 1.00 | 1 / 1 / 1 | 1.00 | 0 |
| | tasks >50 ms | 0 / 0 / 0 | 0 | 0 / 0 / 0 | 0 | 0 |
| creator adoption t4 | total ms | 645.0 / 728.7 / 783.6 | 719.1 | 688.8 / 682.5 / 733.6 | 701.6 | −17.5 |
| | max task ms | 42.4 / 43.2 / 58.3 | **48.0** | 37.7 / 36.7 / 40.3 | **38.2** | **−9.7** |
| | tasks >16 ms | 2 / 2 / 3 | 2.33 | 3 / 2 / 3 | 2.67 | +0.33 (see the note) |
| | tasks >50 ms | 0 / 0 / 1 | 0.33 | 0 / 0 / 0 | 0 | −0.33 |
| recipient install t4 | total ms | 375.9 / 541.9 / 429.0 | 448.9 | 553.3 / 497.8 / 422.7 | 491.3 | +42.3 |
| | max task ms | 6.8 / 10.5 / 9.1 | 8.8 | 6.9 / 8.6 / 6.8 | 7.4 | −1.4 |
| | tasks >16 ms | 0 / 0 / 0 | 0 | 0 / 0 / 0 | 0 | 0 |
| | tasks >50 ms | 0 / 0 / 0 | 0 | 0 / 0 / 0 | 0 | 0 |
| creator lull t5 | total ms | 4028.6 / 3938.1 / 3657.0 | 3874.6 | 2745.9 / 3214.5 / 3095.5 | 3018.6 | −855.9 |
| | max task ms | 42.2 / 36.0 / 38.6 | **38.9** | 26.5 / 21.2 / 21.5 | **23.1** | **−15.9** |
| | tasks >16 ms | 1 / 1 / 1 | 1.00 | 1 / 1 / 1 | 1.00 | 0 |
| | tasks >50 ms | 0 / 0 / 0 | 0 | 0 / 0 / 0 | 0 | 0 |

**Note on the adoption tasks over 16 ms.** These are the individual tasks above 16 ms in the adoption window:

| variant | r-a | r-b | r-c |
|---|---|---|---|
| BASE (r1, r4, r5) | [41.6, 42.4] | [43.2, 42.9] | [16.8, 58.3, 44.2] |
| H (r2, r3, r6) | [16.4, 37.7, 25.1] | [36.7, 23.3] | [16.3, 40.3, 24.5] |

The extra count in H comes from a task of about 16.3–16.8 ms that sits on the threshold (it appears in 1 BASE run and 2 H runs). The two real adoption tasks shrink from about 43 + 43 ms to about 38 + 24 ms. Total time in tasks over 16 ms in this window falls from a mean of 96.5 ms to 73.4 ms.

The recipient tasks are the same three install windows of a shared renderer, and none of them is over 16 ms in either variant.

## Totals: are they worse beyond noise?

Pair deltas (H − BASE) on the traced-window totals, in ms:

| window | pair 1 | pair 2 | pair 3 | mean | BASE spread (max − min) |
|---|---|---|---|---|---|
| seal t4 | −248.7 | +220.4 | −233.6 | −87.3 | 208.8 |
| adoption t4 | +43.8 | −46.2 | −50.0 | −17.5 | 138.6 |
| install t4 | +177.4 | −44.1 | −6.3 | +42.3 | 166.0 |
| lull t5 | −1282.7 | −723.6 | −561.5 | −855.9 | 371.6 |

All-transition totals: each run's mean over its transitions, most of which fall outside the trace. These are the less noisy totals.

| window | BASE runs | BASE mean | H runs | H mean | H − BASE | pair deltas |
|---|---|---|---|---|---|---|
| seal t0–7 | 321.6 / 319.3 / 311.1 | 317.4 | 322.3 / 336.8 / 293.9 | 317.7 | +0.3 | +0.7 / +17.5 / −17.2 |
| adoption t0–7 | 561.9 / 620.0 / 580.5 | 587.5 | 545.5 / 617.6 / 596.4 | 586.5 | −0.9 | −16.4 / −2.4 / +15.9 |
| install t0–7 | 354.1 / 421.6 / 354.0 | 376.6 | 395.3 / 399.1 / 425.7 | 406.7 | +30.1 | +41.2 / −22.5 / +71.8 |
| lull t4–8, maintained | 3110.6 / 3091.2 / 3032.9 | 3078.2 | 2839.8 / 3332.0 / 2897.3 | 3023.0 | −55.2 | −270.8 / +240.7 / −135.6 |

Paired per-transition deltas (`pertransition.md`):

| window | n | mean | median | SE | H slower in |
|---|---|---|---|---|---|
| seal | 24 | +0.3 | −11.3 | 21.2 | 11/24 |
| adoption | 24 | −0.9 | −28.0 | 31.0 | 11/24 |
| install | 24 | +30.1 | +4.8 | 19.7 | 12/24 |
| lull | 15 | −55.2 | −118.9 | 144.2 | 7/15 |

Reading of these numbers:

- **Seal and adoption are flat on totals.** Their long-task maxima improve.
- **Install leans worse at +30 ms (8%), but within noise.**
  - The pair deltas change sign, and the median paired delta is +4.8 ms.
  - The BASE-to-BASE spread of the run means is 67.6 ms.
  - H touches nothing on the install path that adds work; blueprint-fold apply now does fewer encodes and decodes.
  - Install is still the metric to watch in any future run.
- **The lull is −856 ms in the traced window, consistent across all 3 pairs, but flat (−55 ± 144) when untraced.** The V8 CPU-profiler trace category inflates the call-heavy sizing code that H trims, so the traced lull speed-up overstates the untraced gain. The untraced lull at t7 and t8 is slower in H only because of r3, the run made during a load spike (3803 and 3906 ms).
- **Secondary metrics are noisy.** These are means; they are not part of the rule.
  - Remote accept p50 went 61.3 → 67.0 ms, and p95 went 126.5 → 153.6 ms. The p95 is driven by r3 at 216.6 ms.
  - Creator issue p50 went 89.5 → 85.2 ms.
  - Track H's own pair showed the opposite direction on accept latency.

## Correctness

### H's new tests

All pass on H, in the full run and in the rerun:

- `resource-sizing-differential`: 3 of 3 tests. It compares results and refusals against the frozen `reference/codec-v1.ts` over 2 × 4,000 random cases, with cold and warm caches.
- `blueprint-canonical-state-equivalence`: 3 of 3 tests. It covers bytes, digests, outputs and refusals against an oracle of the pre-change machine, and checks that a fold hashes once.
- `blueprint-owned-fork` (modified): 5 of 5.

**Byte-identical canonical encodings:** `codec-differential` passes 9 of 9 on both BASE and H.

### Suite diff: BASE vs H

- **Test set:** 89 files, the same file list for both variants; the BASE run has the 2 new files absent.
  - `packages/canonical/tests/*`
  - `packages/compaction/tests/*`
  - `tests/protocol-v3-*` and `tests/phase-4a-blueprint-fold*`
  - `packages/node/tests/creator-closed-rollback*`, plus the 24 node test files that import `creator-closed-rollback-data`
- **How it was run:**
  - `vitest run --exclude ".claude/**" --no-coverage --testTimeout=60000`. I raised the timeout from 10 s because the shared machine is loaded.
  - The dists of each variant were rebuilt before its run: canonical, compaction and protocol-v3.
  - The dists of the unchanged packages were shared between the two runs.
- **Results by suite:**

| suite | BASE pass / fail | H pass / fail |
|---|---|---|
| canonical | 37 / 0 | 40 / 0 |
| compaction | 83 / 0 | 86 / 0 |
| node rollback-data importers | 398 / 8, plus 1 file that fails to load | identical |
| node creator-closed-rollback-proof-accounting | 331 / 20 | 331 / 20 (the same tests) |
| protocol-v3 and blueprint-fold (`tests/`) | 362 / 618 | 363 / 617 |

The failures that exist in both variants come from this environment's frozen-artifact and governance hash checks, plus `pin is not defined` and similar. They occur identically in BASE.

- **Per-test delta from BASE to H** (`tests-H3.json` vs `tests-BASE1.json`):
  - 6 new tests: None → passed.
  - 3 tests went failed → passed. These are spawn timeouts in `protocol-v3-issuance-exhaustion-n1prime-c` (2 tests) and `protocol-v3-shipped-electron-gate-0j-d`.
  - 2 tests went passed → failed. Both are load timeouts, and both pass on a rerun on H (`probe-H-rerun.json`, 33 of 33 pass, 1 skipped, the same as BASE):
    - `phase-4a-blueprint-fold-p1-corrective-red` › "accepts the public add_mul operation type without a cast". Its `spawnSync tsc` hit the test's own 30 s timeout and returned status null. Run directly, that `tsc -p tests/fixtures/phase-4a-v3/tsconfig.corrective.json` exits 0 on H in 1 s, and on BASE in 2 s.
    - `protocol-v3-blueprint-conformance-0j-c` › "fails closed for thenable…" timed out at 60 s.
  - **Net: no new failures.**

### Typecheck

`pnpm -r --no-bail typecheck` was run with every `packages/*` dist built from the same variant's sources. Each package was built separately with `pnpm --filter <pkg> build`, in dependency order.

| | error lines | failed projects |
|---|---|---|
| BASE | **0** | 0 |
| H | **5** | 2 (canonical, compaction) |

The 5 errors are the ones listed in the verdict. I first ran both variants with only some package dists built; there too, the only difference between BASE and H was those same 5 errors (`typecheck-*-partialdist.*`).

## Files

All files are in `<evidence>/track-h2/`:

- **Bundles:** `BASE/` and `H/`.
- **Runs:** `run-r{1..6}-*` holds the report, trace, log, `meta.json` (exit code and loads) and `metrics.json`.
- **Tables:** `tables.md` and `pertransition.md`.
- **Tests:** `tests-BASE1.*`, `tests-H3.*` and `probe-H-rerun.*`.
- **Typecheck:** `typecheck-{BASE,H}-full.*` and `typecheck-*-partialdist.*`.
- **Scripts:** `build.sh`, `run.sh`, `pairs.sh`, `analyze.py`, `aggregate.py`, `pertransition.py`, `tests.sh`, `testsum.py`, `typecheck.sh`, `variant.sh`, `dists-all.sh` and `topo.py`.

The worktree is left with `track-h/patch.diff` applied and **uncommitted**, on top of de70325e. Nothing was pushed, and the main checkout was not touched.
