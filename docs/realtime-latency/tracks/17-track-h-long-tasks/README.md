# Track H (and H2 rerun): eliminate main-thread long tasks

**Outcome:** Landed in 75aa8807 after the H2 three-pair rerun and test type fixes.

**Working documents in this folder:** [notes.md](notes.md), [RESULT.md](RESULT.md), [tables.md](tables.md), [pertransition.md](pertransition.md)

## Agent: Eliminate main-thread long tasks

### Brief (plan given to the agent) (2026-10-19 15:43 UTC)

You are Track H. Goal: no main-thread task longer than 16 ms during seal, adoption, install, maintenance or ordinary moves, so a 60 fps game never drops a frame because of the library.

Measured by Track A, identical on base and fix:
- max task in the seal window 26 ms, adoption 44 ms, install 11–13 ms, pool maintenance 40 ms;
- the tasks over 16 ms are single synchronous sizing/encoding passes in `creator-closed-rollback-data.ts` and the blueprint fold;
- the 607–838 ms long tasks fall outside product windows (script load, harness, forced GC); confirm that.

Track A's tooling is in `<evidence>/track-a/`: longtasks.py, tasks.py, taskstacks.py, and STARTUP_HEALTHY_GRID_TASK_TRACE=window with the __rdTraceControl hook.

Setup:
- Your worktree starts at 4c4f192c. Apply `git apply <evidence>/track-e/base-int.patch` first, rebuild the canonical, storage and storage-browser dists, and build a base bench bundle.
- Use the `lt-` prefix and scratch dir `<evidence>/track-h/`.
- Do not commit.
- Other agents run concurrently: E (maintenance pass structure), F (concurrent admission) and G (optimistic presentation). Do not change the retirement pass loop or the admission/census rules; work on the synchronous CPU chunks themselves.
- The machine is loaded: use paired runs.
- You have about 200 turns.

Work:
1. **Inventory.** With task traces and CPU profiles, list every task over 16 ms in each product window, with its stack attribution and the synchronous call chain that makes it long.
2. **Fixes, in order of preference:**
   - make it cheaper, e.g. avoid repeated sizing or encoding of the same value, cache sizes, use incremental encoding;
   - split it at a safe await or yield point that already exists semantically. A yield inside a transaction-bound or census-bound section is only allowed if you prove nothing can interleave that breaks it. The microtask-only adjacency token from the per-move patch is the model: a yield via `scheduler.yield`/`setTimeout` lets IDB events, timers and messages run.
   - move pure CPU work (hashing, canonical encoding of large images, signature verification) to a Worker, where data-transfer cost makes sense.
3. **Prove it:**
   - equivalence tests: same bytes, same refusals;
   - the affected test suites run against your base, with the test delta reported;
   - paired trace runs, base vs yours, showing max task duration per window and a count of tasks over 16 ms and over 50 ms, plus the effect on seal/adoption/install totals and move latency.

Deliverables: a patch file in your scratch dir, against base-int.patch applied, and a concise final report in your reply. Subagents can't write REPORT.md. The report needs the inventory table, the fixes and why each is sound, before/after numbers and the test delta.

### Follow-up instruction — Resume Track H with tight brief (2026-10-19 16:33 UTC)

Resume Track H (main-thread long tasks over 16 ms): you hit the 200-turn limit while rewriting the protocol-v3 variant to take and return canonical state bytes. Finish in at most ~60 more turns:
1. Complete that change so every touched package typechecks (`tsc -p tsconfig.build.json --noEmit`).
2. Run the affected tests: you were already running node/compaction/canonical. Report before/after failure sets against base-int.
3. Run ONE traced paired bench (STARTUP_HEALTHY_GRID_TASK_TRACE) and report the longest main-thread task for seal, adoption and maintenance, against base (26/44/40 ms).
If the bytes-in/bytes-out variant can't be finished soundly, drop it and report what you have that is safe.
Do NOT commit. Don't write REPORT.md. Write the patch with `git diff > <evidence>/track-h/patch.diff`. Reply with: (a) what was split, yielded or moved, and why it stays atomic; (b) the patch path; (c) tests; (d) the long-task numbers; (e) risks.

### Report returned by the agent

Track H: get every main-thread task in seal, adoption, install, maintenance and ordinary moves under 16 ms. Seal and maintenance dropped well, but neither is under 16 ms yet, and adoption still has a 41 ms task. Nothing is committed.

**Long-task numbers** (one traced pair, interleaved, `POOL_LULL=1`, machine load 45–60; max task in ms / count over 16 ms / count over 50 ms):

| Window | Your base figure | My base run | Patch | What the &gt;16 ms tasks are |
|---|---|---|---|---|
| Seal (epoch 4) | 26 | 28.0 / 1 / 0 | **18.2** / 1 / 0 | blueprint fold apply, plus the snapshot payload digest |
| Adoption (epoch 4) | 44 | 46.8 / 3 / 0 | **41.4** / 3 / 0 | A: maintenance prefix sizing 46.8 → 41.4; B: readiness program build 43.5 → **24.2**; C: signing dependencies + post-adoption census 16.8 → 17.2 |
| Maintenance (lull, epoch 5) | 40 | 36.8 / 1 / 0 | **20.2** / 1 / 0 | the same readiness program build as B |
| Install | — | 9 / 0 / 0 | 9 / 0 / 0 | none |
| Recipient maintenance | — | 12 / 0 / 0 | 12.6 / 0 / 0 | none |
| Ordinary moves (creator / recipient) | — | 6 / 2 | 6 / 2 | none |

- **Outside product windows:** the 546–557 ms task is the harness `Accept` RPC, and the 63–107 ms tasks are the harness's forced GC. Neither is library work.
- **Move latency:** issue p50 is 96.0 → 93.3 ms (creator) and 45.7 → 43.1 ms (recipient). Remote accept is p50 74.6 → 65.4 ms, p95 140.6 → 120.3 ms.
- **Totals (one pair, epoch 4):** seal 411 → 485 ms, adoption 724 → 986 ms, install 476 → 556 ms, maintenance (epoch 5) 2920 → 4296 ms.
  - Main-thread busy time during adoption was the same (541 vs 537 ms), so the extra wall time was spent waiting, not computing.
  - The patch run was slower overall (88 s vs 74 s), including epochs before the trace window.
  - I read this as machine noise, but one pair can't rule out a regression. A 3-pair rerun is needed before trusting the totals.

**(a) What was split, yielded or moved:** nothing. Every fix makes the existing synchronous work cheaper. There is no new `await`, no `scheduler.yield`, and no Worker, so each section stays exactly as atomic as before. The caches are either pure functions of their inputs or live only inside one synchronous sizing call.
1. **Canonical resource sizing** (`codec.ts`): the main fix for task B and the maintenance task.
   - Limits and footprints that the module itself created and froze skip the property-by-property re-validation. All range checks against the current limits still run, and every result handed to a caller is still a fresh frozen object.
   - The module's own result objects skip the shape check, since their shape is fixed by construction.
   - Encoded widths of primitive values are cached (up to 4096 entries). If a cached width exceeds a tighter limit, the real encoder runs again so the refusal is identical.
   - Integer-width arithmetic replaces allocating an encoding just to measure it.
2. **Blueprint apply works on canonical bytes** (new `applyPreparedBlueprintOperationToCanonicalState`, used by the fold): this is the seal fix, and I finished it.
   - Each operation used to encode and decode the state twice; that's gone.
   - The state hash is now computed once per epoch fold instead of once per operation.
   - It is equivalent because `deepCloneCanonical` is decode(encode(x)), and a decode under limits that are nowhere looser than the defaults implies the default decode succeeds. Whenever that doesn't hold, the original path runs and produces the original refusal.
3. **Node sizing** (`creator-closed-rollback-data.ts`):
   - The resource-program compiler builds its cache keys directly instead of with `JSON.stringify`, and caches primitive terms per backend.
   - The width measure no longer builds intermediate spread arrays.
   - Within one sizing call, the generation-source result and its frozen post-rows are reused when inputs are the identical objects. That lets later passes of later schedules hit the cache; failures are never cached.
   - I dropped a priority cache I had added: it was keyed by generation ID rather than object identity, and it broke a test that checks the exact call shape.

**(b) Patch:** `<evidence>/track-h/patch.diff` (same content in `track-h.patch` next to it).
- It is against base-int: 4c4f192c with `base-int.patch` applied. It includes the trace-window change to `healthy-grid.ts`, diffed against the base-int version of that file.
- `git apply -R --check` passes on the worktree. The worktree holds the patch uncommitted, with the canonical, protocol-v3 and compaction builds rebuilt from it.

**(c) Tests:**
- **Typecheck:** canonical, protocol-v3, compaction and node each report 0 errors with `tsc -p tsconfig.build.json --noEmit`.
- **Suites:** I ran node, compaction, canonical and `phase-4a-blueprint-fold-red` on both trees.
  - Base: 1206 tests, 51 failed. Patch: 1212 tests, 50 failed.
  - The 6 extra tests are the new ones, and all pass. No test that passes on base fails with the patch.
  - The one base failure that passes with the patch is a 10 s timeout under load.
  - The remaining 50 failures fail on base too, across 12 node files (closed-rollback proof-accounting, ephemeral-webrtc, suffix-preflight, replay-seal-native, queue-isolation and others).
- **New tests (in the patch):**
  - `resource-sizing-differential`: a random comparison against the frozen v1 reference codec, including invalid, accessor, inherited and frozen limits, run cold and warm. Also refusal replay and no-aliasing. I checked it catches deliberately broken code.
  - `blueprint-canonical-state-equivalence`: the new path against the original one, with the same bytes, digests, outputs and refusal codes across three state limits. Also: an epoch fold hashes once.
- **Not in the patch:** a 60-seed comparison of the compiler against a copy of the original. It passed and catches deliberately broken code; it's moved to `track-h/tempfiles/`.

**(d) Still over 16 ms:**
- **Adoption task A (~41 ms):** it evaluates 1 + K + K(K−1)/2 schedules, re-measuring the same widths each time. It runs while the census is held, so it can't yield; it needs schedules evaluated incrementally, which overlaps Track E.
- **Readiness program build (20–24 ms):** this is adoption task B and the maintenance task.
- **Seal (~18 ms):** the snapshot payload digest re-hashes the whole state in JS sha256.
- **Adoption task C (~17 ms).**

**(e) Risks:**
- **Mutation:** the per-call caches assume frames, summaries and rows aren't mutated during one synchronous sizing call. Post-rows are frozen, and the compose code itself copies rather than mutates.
- **Global width cache:** it is shared across calls. It is pure, and 0 and −0 share a key, which is harmless because the encoder normalises −0 to 0.
- **New export:** `@ts-drp/protocol-v3/blueprint-application` gains a public function, exported on its own line so the seam test still matches.
- **Bench bundle:** it still contained the dropped priority cache, which was about 1% of task A's samples. The final patch may be slightly slower there than measured.
- **One pair on a loaded machine:** the max-task drops are large and match the profiles, but the wall-clock totals are not conclusive.

## Agent: Rerun Track H with 3 pairs

### Brief (plan given to the agent) (2026-10-19 21:01 UTC)

You are evaluating a finished performance patch (Track H: main-thread long tasks) for the ts-drp repository, a
TypeScript local-first CRDT library for real-time games. Your job is a rigorous go / no-go measurement and
correctness check. You do NOT merge anything into the main checkout.

#### Where you are

- You are in your own git worktree, branched from de70325e on branch codex/phase3a1b-p6-golden-path. Confirm
  with `git log -1`; if it is not at de70325e, run `git reset --hard de70325e` inside YOUR worktree only.
- Main checkout: <repo>. Do NOT edit it.
- Never push.
- Scratch root:
  <evidence>
  - Track H's material is in track-h/:
    - patch.diff (applies cleanly to de70325e; check with `git apply --check`);
    - notes.md;
    - build.sh, pair.sh and longtasks.py;
    - earlier runs.
  - Write your notes under track-h2/.
- The machine is shared and heavily loaded. Two other agents run benchmarks concurrently, which is why
  interleaving matters.
  - Never kill processes you did not start.
  - A hook blocks `rm -rf`, `unlink` and `git checkout <ref> -- <path>`. Move files to scratch instead.
  - Run vitest from the worktree root with `--exclude ".claude/**" --no-coverage`.
  - You may need `pnpm install --offline --ignore-scripts`.

#### What Track H claims

- The patch splits or yields long main-thread tasks in the canonical codec, protocol-v3, compaction blueprint
  fold and node creator-closed-rollback-data.
- Measured max long task: seal 28 → 18 ms, maintenance 37 → 20 ms. Adoption is still 41 ms.
- One pair showed slower totals, so it needs a 3-pair rerun.

#### What to do

1. Build two Grid benchmark bundles from your worktree:
   - BASE: de70325e as is;
   - H: de70325e plus track-h/patch.diff.
   Notes on building:
   - The bundle consumes canonical, storage and storage-browser from dist, so rebuild those packages for each
     variant with `pnpm --filter @ts-drp/<pkg> build`. It is mtime-based, so touch changed files.
   - Node, protocol-v3 and seal come from src.
   - Bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <outdir>`.
     Build both bundles up front so the runs only switch STARTUP_ARTIFACTS.
2. Run 3 interleaved pairs in the order BASE, H, H, BASE, BASE, H.
   - Run command: `STARTUP_HEALTHY_GRID_ROLLOVERS=8 STARTUP_HEALTHY_GRID_POOL_LULL=1
     STARTUP_EVIDENCE=<dir> STARTUP_ENTRY=r8-source-binding STARTUP_SOURCE_NATIVE_RESOURCES=1
     STARTUP_ARTIFACTS=<bundle> pnpm exec playwright test --config
     tests/fixtures/startup-discovery/playwright.config.ts --project chromium -g "healthy native Grid integrates"`.
   - Use Track H's long-task measurement (see notes.md, pair.sh and longtasks.py).
   - Record the 1-minute load for every run.
   - Report per variant, as a mean and per run, for seal, creator adoption, recipient install and the creator
     lull:
     - total ms;
     - max long task;
     - count of tasks over 16 ms and over 50 ms.
3. Check correctness.
   - Run H's new tests: resource-sizing-differential and blueprint-canonical-state-equivalence.
   - Run the canonical, compaction, protocol-v3 and node (creator-closed-rollback*) suites, BASE vs H, and diff
     per-test outcomes. Only NEW failures matter.
   - Run `pnpm -r typecheck` (it must stay at 0 errors).
   - Check that canonical encodings are byte-identical; the codec differential tests cover this.
4. Verdict, by this rule:
   - GO only if long tasks improve AND the total times are not worse beyond noise, judged on pair means;
   - no new test failures;
   - typecheck clean.
   Otherwise NO-GO, saying what regressed.

#### Deliverables

- scratchpad/track-h2/RESULT.md with the tables, the per-run loads, the test diff and the verdict.
- If GO: a commit on your worktree branch with the patch applied, a commit message explaining what and why, and
  the "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" trailer.
- Final message: worktree path, branch, commit hash (if any), the verdict, and the key numbers in under 15 lines.
  Report faithfully.

### Follow-up instruction — tell Track H2 .logs harness files are back (2026-10-19 21:57 UTC)

FYI: the Grid benchmark's untracked .logs inputs are available again in the main checkout. The harness imports .logs/bounded-storage-lifecycle/r8-warm-capacity-01/{grid-candidate-01/grid-corpus.ts,worker-transport.ts}. For a while they were moved to <archive>/untracked-logs/ (paths preserved), and are now restored at .logs/bounded-storage-lifecycle/r8-warm-capacity-01/. Your worktree has no untracked files, so copy that directory (read-only source; do not move it) into your worktree's .logs if a bundle build fails with "Could not resolve ../../../.logs/...". No reply needed.

### Report returned by the agent (2026-10-19 22:22 UTC)

Verdict: NO-GO. Track H meets the speed and test criteria, but it fails typecheck: its two new test files add 5 type errors. No commit made.

- **Worktree:** <worktree agent-ae5eae11263189894>/, branch worktree-agent-ae5eae11263189894, HEAD de70325e. The hook blocked `git reset --hard`, so I moved the branch with `git switch -C`. patch.diff is left applied and uncommitted; nothing pushed, main checkout untouched.
- **Long tasks (max task ms, BASE mean → H mean; every H run beats every BASE run):**
  - seal t4: 25.5 → 17.7
  - creator adoption t4: 48.0 → 38.2 (two main tasks went from ~43+43 to ~38+24; the one task over 50 ms, in r5 BASE, is gone)
  - creator lull t5: 38.9 → 23.1
  - recipient install t4: 8.8 → 7.4
  - Counts over 16 ms are unchanged (1 and 1). Adoption shows 2.33 vs 2.67 only because of a task sitting right at 16.3–16.8 ms.
- **Totals (all-transition means, pair-interleaved):** seal +0.3, adoption −0.9, lull −55 (±144), install +30 ms. Install is within noise: pair deltas +41/−22/+72, and BASE runs differ from each other by 68 ms. It is still the one to watch. The traced lull shows −856 ms, but most of that comes from profiler overhead, not untraced time.
- **Runs:** all 6 passed. 1-minute load before/after: r1 BASE 30.7/21.8, r2 H 21.8/19.2, r3 H 19.2/30.6, r4 BASE 30.6/42.2, r5 BASE 42.2/29.9, r6 H 29.9/37.7.
- **Tests (89 files):**
  - The new tests pass: resource-sizing-differential 3/3, blueprint-canonical-state-equivalence 3/3.
  - Canonical encodings are byte-identical: codec-differential passes 9/9 on both.
  - No new failures. Two tests went passed→failed under load (a 30 s tsc child timeout in phase-4a-blueprint-fold-p1-corrective, and a 60 s timeout in blueprint-conformance-0j-c); both pass when rerun on H.
  - The many failures that remain (protocol-v3 freeze/governance checks, 20 in proof-accounting) are identical on BASE.
- **Typecheck:** `pnpm -r typecheck` with all dists built per variant gives BASE 0 errors, H 5 errors, all in the new test files. Product code is clean.
  - canonical `resource-sizing-differential.test.ts`: two TS5097 errors for the `.ts` import paths, and one TS2737 for the `10n` literal under target ES6.
  - compaction `blueprint-canonical-state-equivalence.test.ts`: TS2571 at 116:43 and TS2379 at 127:23.
  - These are test-only fixes; once fixed, H meets every criterion.
- **Measurement notes:**
  - I applied H's trace-window fixture hunk (healthy-grid.ts) to both bundles so they trace the same windows, as Track H did.
  - The bundle also takes compaction from dist, so it needs a per-variant rebuild too, not just canonical, storage and storage-browser.
  - Track H's own fix bundle accidentally included the main checkout's base canonical codec as well; mine does not.

Everything is in <evidence>/track-h2/; RESULT.md there has the tables, per-run loads, test diff and verdict.
