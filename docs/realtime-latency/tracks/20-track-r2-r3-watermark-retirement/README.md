# Track R2 / R3: single-database watermark retirement

**Outcome:** R2: prototype (84fd4c8f), kept under storage-browser tests/prototypes. R3: specs 14 and 14a-14f, and stage 1a of 14a (one room database, one retirement session per install), landed opt-in in 84fd4c8f..68b4168e; the default path is unchanged. Track L residuals 1 and 2 are fixed on the shared path. The latency goal is not met (creator lull -3% to -9%, recipient lull -4% to -6%), so the default flip is not in; slice 14b (Track M) is the next lever. See [RESULT.md](RESULT.md).

**Working documents in this folder:** [STEP4.md](STEP4.md), [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-19 20:15 UTC)

You are Track R2. You continue a stopped redesign track for the ts-drp repository. ts-drp is a TypeScript
local-first CRDT library that must power real-time games. Your job is to explore and actually attempt the most
viable alternatives from the Track E maintenance-latency redesign. You must not lose any golden-path guarantee
or objective.

#### Where you are

- You are in your own git worktree. It was branched from commit de70325e ("perf: move recovery-pool turnover off
  the gameplay path; fix repo typecheck"), which holds all integrated latency work (Tracks A, B and D plus the
  typecheck fixes). Confirm with `git log -1`. If your worktree is NOT at de70325e, run
  `git reset --hard de70325e` inside YOUR worktree only.
- Main checkout: <repo>. Do NOT edit anything there.
- You may commit on your own worktree branch. Never push. Never change other branches.
- Scratch root (read inputs from it; write your notes under track-r2/):
  <evidence>
- The machine is shared and heavily loaded (load average 30–110):
  - never kill processes you did not start;
  - a hook blocks `rm -rf`, `unlink` and `git checkout <ref> -- <path>`. Move files into scratch instead, and use
    `git show HEAD:path > path` to restore a file;
  - run vitest from the worktree root with `--exclude ".claude/**" --no-coverage`;
  - you may need `pnpm install --offline --ignore-scripts` in a fresh worktree;
  - packages consumed from dist need `pnpm --filter @ts-drp/<pkg> build`.

#### The problem, measured

- The Playwright "healthy native Grid integrates" benchmark covers 4 clients, a 64-member roster and 8
  rollovers, measured creator-local.
- At de70325e, seal t4–t7 is ~0.3–0.4 s and recipient install ~0.3–0.4 s. Bounded-recovery turnover now runs at
  an opt-in lull, `V3RoomSession.maintainRecoveryPool()`, and that lull still costs ~2.1–2.8 s per epoch on the
  creator.
- Track E proved this cost is architectural:
  - a no-op extra pass costs 0.44–0.86 s;
  - each epoch is 4 passes that re-read and re-authenticate everything (~11k IndexedDB requests, 98% repeated
    decodes) to make ~103 row writes;
  - each epoch also runs 4 cross-database two-phase commits over 6 databases.
- Track E's Chromium model puts watermark retirement at ~2.5 ms per epoch with one database (6.2 ms with six
  coordinator-free databases).
- Read these first:
  - scratchpad/track-e/ROOT-CAUSE.md
  - scratchpad/track-e/ALTERNATIVES.md
  - scratchpad/track-e/idbmodel/ (the Chromium models)

#### What the first Track R already established (do not redo it; build on it)

- scratchpad/track-r/GUARANTEES.md: the golden-path guarantee checklist G1–G28, with spec citations. It is the
  acceptance bar for everything you do. The line numbers in it refer to an older base, so re-verify the
  citations at de70325e.
  - The specs are specs/bounded-storage-lifecycle/README.md and requirements-to-evidence.md,
    specs/phase-6b-bounded-pruning/, specs/e3-e5-fabric-golden-path/README.md and
    docs/production-hardening/production-hardening-tdd-plan-v2.md.
- scratchpad/track-r/STEPS.md: verdicts on redesign steps 1–3.
  - Step 1 (revision counters + Web Locks replacing the keep-alive pump) is unsound as proposed:
    - G11: revision or incarnation alone is a modelled counterexample;
    - G12: Web Locks are not native exclusion;
    - G13: Web Locks are advisory only;
    - G6: same-origin rollback.
    Only cost reductions that keep the held native transaction semantics are allowed.
  - Step 2 (carry verified facts and skip fresh reads) is unsound beyond what is already landed (G5, G10, G11).
    The remaining waste is re-encoding rows only to compare or charge them, and removing it needs rows stored as
    exact canonical bytes.
  - Step 3 (fuse the four passes) is allowed by the spec, because stage exclusivity is an implementation choice.
    But it changes durable, protocol-visible formats:
    - a decision-carrier policy value;
    - source-proof digest domains;
    - the AHE control's single generationDrain;
    - evidence → summary eligibility sequencing.
    It must fit the 4 MiB maintenanceProofBytes budget, and it needs its own spec slice (Phase 6b scope says no
    wire-format or digest-domain change).
  - Step 4 (single-database watermark retirement) has no verdict yet. It is the only alternative modelled to
    reach milliseconds.
- In-progress, sound pump-cost reduction, in the stopped worktree
  <worktree agent-a775ab62f83b89066>/:
  - an uncommitted diff to packages/storage-browser/src/internal/native-read-reservation.ts (view it with
    `git -C <that worktree> diff`);
  - a new test, packages/storage-browser/tests/native-read-reservation-turn.test.ts;
  - scratchpad/track-r/diag-turnwait.patch.
  That worktree's base is 4c4f192c plus an integrated patch, which is equivalent to de70325e's src for those
  files except the typecheck changes. Salvage the work if it is sound and measurably helps: copy and review it.
  Do not commit in that old worktree.
- Prototype and harness:
  - scratchpad/track-r/v3proto/: epoch-retirement.mjs and its test, a Chromium bench page, run-bench.cjs and
    out-v3-1.json;
  - scratchpad/track-r/bench/: build.sh, run.sh, pairs.sh, summary.py, compare.py and te-totals.py. Paths
    inside the scripts may point at the old worktree, so adapt them.

#### What to do

1. Finish the Step 4 verdict. Design single-database watermark retirement against the real code: epoch-grouped
   keys with range delete, verify-on-arrival, incremental digests, and one monotone retirement watermark.
   - For EVERY guarantee G1–G28, state how the design satisfies it, or why it cannot.
   - Pay special attention to:
     - G5: durable bytes are untrusted; trust is re-verified on every open;
     - G8: a watermark or physical deletion alone is not authority;
     - G9: each owner rechecks its own monotone facts transactionally, right before deleting. One database
       transaction may make this stronger, not weaker;
     - G14 and G15: crash old-XOR-new; never delete too much;
     - G17: no resurrection or late writers;
     - G6 and G24: same-origin rollback and the startup floor;
     - G25: an authenticated migration from the six-database layout, with stale connections fenced;
     - G22: the proof budget.
   - Name the existing owners it replaces and the ones it keeps.
2. Pick the most viable alternative or combination by expected gain against guarantee risk, and IMPLEMENT it as
   far as you soundly can. Plausible orders:
   - (a) the pump-cost reduction plus any other in-place, format-preserving savings, landed with tests;
   - (b) stage fusion behind a new versioned policy or control kind, with migration, if the guarantee argument
     holds;
   - (c) a single-database watermark retirement store for the recovery-pool path behind an explicit opt-in or
     versioned format, with the old path kept until migration is proven.
   Prefer one change that lands, is correct and is measured over a broad half-built one. If a step cannot land
   without weakening a guarantee, say so precisely and stop that step. Never relax safety for latency (G26).
3. Prove it.
   - Write unit and property tests for the new invariants: crash points between every step, replays, stale
     writers, rollback of the watermark, and poisoned bytes.
   - Run the affected package suites (node, storage, storage-browser, storage-node, seal) before and after, and
     diff per-test outcomes. Pre-existing failures are fine and numerous (for example, 150 known failures in
     storage-node plus the shared fixtures). Any NEW failure must be explained or fixed.
   - Keep `pnpm -r typecheck` at 0 errors.
   - Run the Grid benchmark as interleaved pairs (base, mine, mine, base), at least 2 pairs, with
     STARTUP_HEALTHY_GRID_POOL_LULL=1. Report seal, install, lull p50/max per epoch, creator issue p50, and the
     1-minute load.
   - How to build and run the benchmark:
     - Bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <outdir>`.
       It consumes canonical, storage and storage-browser from dist, so rebuild them with
       `pnpm --filter @ts-drp/<pkg> build` (mtime-based; touch restored files). Node, protocol-v3 and seal come
       from src.
     - Run: `STARTUP_HEALTHY_GRID_ROLLOVERS=8 STARTUP_HEALTHY_GRID_POOL_LULL=1 STARTUP_EVIDENCE=<dir>
       STARTUP_ENTRY=r8-source-binding STARTUP_SOURCE_NATIVE_RESOURCES=1 STARTUP_ARTIFACTS=<outdir> pnpm exec
       playwright test --config tests/fixtures/startup-discovery/playwright.config.ts --project chromium -g
       "healthy native Grid integrates"`.
     - Spans are in the report attachment "healthy-native-integrated-result".

#### Deliverables (write to scratchpad/track-r2/, and summarize in your final message)

- STEP4.md: the Step 4 design and the per-guarantee argument.
- RESULT.md, covering:
  - what you implemented;
  - the guarantee-by-guarantee argument for it;
  - the test before/after diff;
  - the paired benchmark numbers;
  - what remains, and the spec slices it needs.
- Your work committed on your worktree branch, plus a patch file in scratchpad/track-r2/.
- In your final message: the worktree path, the branch name and the commit hashes, then 10–20 lines of results.
  Report outcomes faithfully. If something did not work or was not measured, say so.

### Follow-up instruction — tell Track R2 .logs harness files location (2026-10-19 21:57 UTC)

FYI: the Grid benchmark's untracked .logs inputs are in the main checkout at .logs/bounded-storage-lifecycle/r8-warm-capacity-01/. The harness imports grid-candidate-01/grid-corpus.ts and worker-transport.ts from there. They were briefly moved to <archive>/untracked-logs/ (paths preserved) and have been restored. If a bundle build fails with "Could not resolve ../../../.logs/...", copy that directory into your worktree; never move it. Also: main's branch now has three new commits on top of de70325e (6bb9616d shadowed-source guard, 6fc82c6e Playwright import fix, 719e4732 opt-in speculative presentation in v3-room/v3-live). Keep your base at de70325e; I will integrate. No reply needed.

### Report returned by the agent (2026-10-19 22:03 UTC)

Track R2 is done. The Step 4 design holds up on paper. I built it as an opt-in prototype with crash, replay and poison tests, but it is not wired into Grid, so Grid latency is unchanged. The pump-cost change measured no gain and was not committed.

- Worktree: <worktree agent-aeb6ebdfc4584ace2>/
- Branch: worktree-agent-aeb6ebdfc4584ace2, on base de70325e. Nothing pushed.
- Commit: 676b09c1 "test: prototype single-database epoch retirement with crash, replay and poison tests". The bench inputs I copied in under `.logs/` are untracked and not committed.
- Patch: <evidence>/track-r2/track-r2.patch
- Design and per-guarantee argument (G1–G28): <evidence>/track-r2/STEP4.md
- Full results: <evidence>/track-r2/RESULT.md

Results:
1. **Step 4 verdict.** A single-database watermark retirement can meet G1–G27; G28 (native evidence on three engines plus SIGKILL) is still owed. It only holds if:
   - stored rows are re-verified on arrival and on every open; Track E's "trusted after ingress" is rejected under G5/G8;
   - the watermark is only a write fence, an index and a resume point, never authority;
   - the host floor stays in its own database, fenced per owner first, then one strict retention transaction runs.
2. **It cannot replace production this cycle.** It changes the database layout (against the 6B:63 non-goal) and needs an authenticated migration from the six databases (G25) plus native evidence. Six spec slices are needed first, S1–S6 (format, trust, host floor, migration, bounds, evidence).
3. **What I committed.** The prototype is `packages/storage-browser/tests/prototypes/epoch-retirement-store.ts` (967 lines), with 29 passing fake-indexeddb tests and one fast-check property. The tests cover a crash at each step, idempotent replay, stale writers, a rolled-back watermark or database, poisoned bytes and blobs, pending/malformed rows blocking only their owner (G19), budget and cap, and four migration tests.
4. **Why it sits under `tests/`.** In `src/` it produced 144 IDB-ownership governance violations. Promoting it means registering it as a reviewed owner.
5. **Design bug found and fixed.** A scope-wide floor fence hid pending issuance rows, violating G19. The fence is now per owner, and a test plus a mutant pin it.
6. **Mutation check.** 17 of 18 mutants killed. The survivor only matters with two migrators running at once.
7. **Micro-bench (Chromium, strict durability, about 170 KiB retired per epoch).** Retire p50 is 6.7–7.1 ms (p95 9.1–10.2, max 16–28). Verify-on-open is 5.6–7.4 ms using SHA-256, not Ed25519. Today's lull is 2.4–3.0 s.
8. **Grid bundle.** The build from 676b09c1 is byte-identical to base, so its Grid latency is base by construction.
9. **Pump change not committed.** It was salvaged and reviewed as sound, and 2 of its 6 tests fail on base. In 4 interleaved blocks (16 runs, `STARTUP_HEALTHY_GRID_POOL_LULL=1`), base vs mine:

   | Measure | base | mine |
   |---|---|---|
   | Median lull mean (ms) | 2682 | 2691 |
   | Seal (ms) | 368 | 336 |
   | Install (ms) | 393 | 424 |
   | Creator issue p50 (ms) | 90.2 | 85.8 |

   Per-block ratios were 0.86–1.15 and 1-minute load ran 22–103, so there is no measurable gain. The patch and its tests are in the scratchpad (`pump-not-landed.patch` and `draft/`).
10. **Stage fusion (option b) not attempted.** It needs a durable format and policy change behind a spec slice.
11. **Test before/after.**
    - node (934) and the seal root tests (12) are unchanged; `packages/seal` has no tests.
    - storage-browser: +29 tests. The 2 governance tests I broke with the first placement were fixed by the move (37/37 on a rerun of 676b09c1). Two build/pack tests hit their 30 s timeout at load 70+ and pass on rerun. One test flipped from failing to passing.
    - storage-node has 4 new failures. The 3 SIGKILL tests (10 s child timeouts) fail the same way on the pristine tree with my files removed. The process-race test is flaky in both directions. None of them imports the new files.
12. **Typecheck.** `pnpm -r typecheck` reports 0 errors.
13. **Remaining work.** Wire the planner to build the retirement decision and retire the current four-pass loop, then measure verify-on-open with real Ed25519 signatures. Once retirement drops to milliseconds, the 200–270 ms readiness capture becomes the lull's floor.

### Follow-up instruction — Track R3: integrate watermark retirement (2026-10-19 22:54 UTC)

Approved: integrate single-database watermark retirement into production. Write spec slices S1–S6 first, then implement (Track R3).

The user approved the path from your STEP4.md §6 and RESULT.md §6. You designed it, so you own it end to end, in your worktree (<worktree agent-aeb6ebdfc4584ace2>/).

GOAL
Bring creator and recipient maintenance (lull, seal, install) down from ~2.4–3.0 s per epoch to the millisecond range. Keep every golden-path guarantee G1–G28, as listed in <evidence>/track-r/GUARANTEES.md, under the conditions you found: re-verify on arrival and on every open; the watermark is only a fence, index and resume point; the host floor stays a separate database, fenced per owner.

STARTING POINT
1. Rebase your branch onto codex/phase3a1b-p6-golden-path, now at 75aa8807, with `git rebase`. It now also contains:
   - 6bb9616d: shadowed-source guard;
   - 6fc82c6e: Playwright canonical import;
   - 719e4732: Track G, opt-in presentation overlay;
   - 75aa8807: Track H, long-task cuts in codec.ts, blueprint-fold.ts, creator-closed-rollback-data.ts and protocol-v3 index.ts.
   Keep your prototype commit 676b09c1 as the starting code.
2. Track K is running in parallel on branch worktree-agent-a7dca3b495f91714f (commits d9f55ea9 "bound recipient journal retention and snapshot hole order past epoch 8" and a00c0e91). It touches the same retention area:
   - Read its diff before designing the recipient path. Don't duplicate or contradict it.
   - When it lands I'll message you to rebase onto it.

ORDER OF WORK (follow the repo's spec-first process: specs/README.md, specs/bounded-storage-lifecycle/README.md, and how its slices/, requirements-to-evidence.md and evidence.md are written)
1. Spec slices S1–S6 as repo documents in the existing slice format:
   - S1: format;
   - S2: trust;
   - S3: host floor fence and crash matrix;
   - S4: migration from the current stores, including the unverifiable-row policy;
   - S5: bounds and charges (G21, G22);
   - S6: three-engine + SIGKILL + multi-tab versionchange evidence (G28).
   Each slice maps its requirements to G1–G28. State exactly how it supersedes the Phase 6b non-goals (specs/phase-6b-bounded-pruning/README.md "Non-goals"), and limit that to retirement only. Commit the specs on their own first.
2. RED tests per slice, committed before the code that turns them green.
3. Production implementation:
   - the retention database;
   - verify-on-arrival and verify-on-open;
   - the per-owner retiredThrough floor fence;
   - migration with the crash matrix;
   - caps and charges;
   - the RetirementDecision planner wired into creator-closed-rollback-data.ts and into the recipient install/lull path.
4. Keep the current path selectable. Make "new path on by default" a separate final commit, and only when:
   - the S6 evidence passes on Chromium, Firefox and WebKit;
   - the golden-path suites show no new failures against base, compared per test.
   Otherwise leave it opt-in and say why.
5. Benchmark with at least 3 interleaved pairs of the healthy native Grid run (base vs new, 8 rollovers, LULL=1 and concurrent):
   - per transition: seal, creator adoption, recipient install, creator lull, recipient lull;
   - per-move visible/durable latency during the lull;
   - longest main-thread task per window.

HARD RULES
- Never weaken G1–G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
- If a step cannot keep a guarantee, stop that step, write down the counterexample and hand back. Don't work around it.
- Commits on your own branch are fine. Don't push, and don't touch codex/phase3a1b-p6-golden-path or the main checkout; I review and merge.
- Commit messages end with: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- `pnpm -r typecheck` must stay at 0 errors. Run prettier on new files.
- Never run bare `tsc -p` without `--noEmit`: compiled .js next to .ts shadows sources (guard: node scripts/check-shadowed-sources.mjs).
- The dcg hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into the scratchpad instead.
- Never delete logs.
- The Grid bench imports the untracked .logs/bounded-storage-lifecycle/r8-warm-capacity-01/: copy it from the main checkout if your worktree lacks it.
- The bundle reads canonical, storage, storage-browser and compaction from dist. Rebuild those per variant; build protocol-v3 dist before compaction.
- The machine is loaded (load average 30–120), so compare interleaved pairs, never single runs.
- Don't kill processes you didn't start.
- When running vitest from the root, use `--exclude ".claude/**"`.

PROGRESS AND REPORT
Keep <evidence>/track-r3/PROGRESS.md current: which stage you're at, the commits so far, and any blocker.

When done, or blocked on a guarantee, hand back with:
- the commit list;
- a per-slice summary;
- a table of G1–G28, each with its status and the test that evidences it;
- the S6 evidence results per engine;
- bench numbers against base;
- whether the default flip is in;
- what remains, and the risks.

### Follow-up instruction — Tell R3: Track K landed, rebase (2026-10-19 23:19 UTC)

Track K has landed: rebase your branch onto codex/phase3a1b-p6-golden-path, now at 9f606ce8.

New on that branch:
- 742a517e: bounds recipient journal retention past epoch 8.
  - A received certificate no longer marks every older scope uncollectible once its scope is protected and its generation consumers are covered.
  - The recipient records its own closed-membership carrier at install (recordReceivedClosedMembership in v3-live.ts, via creator-close.ts and creator-adoption.ts).
  - New recipient-only entry reconcileCreatorReceivedSnapshotRecoveryRoles, which asks for one extra fresh pass after a generation drain.
  - Protected snapshot holes are sorted numerically (packages/storage/src/snapshot-transfer.ts).
- 86dc4004, 9f606ce8: Grid harness now accepts 8..32 rollovers; public wrapper signature restored.
- Regression test: tests/recipient-long-room-journal-retention-native.test.ts (16 epochs, creator and recipient, journal constant from epoch 8).
- Track K's write-up and its G1–G28 argument: <evidence>/track-k/RESULT.md

Your retention database must keep these semantics, and that regression test must stay green with the new path on.

Two open bugs K found that sit in your area. Read RESULT.md §5 "The recipient-lull skip" and §6.
1. Reopen admission (predates K; also fails on de70325e at 5 rollovers).
   - After a recipient lull completes a retirement, a persisted close and reopen leaves recipients that never admit the next live move.
   - K's unverified lead: a completed control with throughEpoch + 1 === currentEpoch satisfies creatorRetirementResumeRequested (v3-live.ts ~19170), so needsOrdinaryReadinessRecovery stays true until the next install.
2. Close race. The final lull's unawaited requestRetainedHistory (v3-room.ts ~6541) races the persisted close, and peers report not-active.

Don't fix these on the old path yet; I'm asking the user how to handle them. But your design must not reproduce bug 1. Add one acceptance check: a Grid run with the final recipient lull NOT skipped must pass the persisted close, the reopen and continued gameplay on the new path. If you find the root cause on the way, write it in PROGRESS.md.

### Follow-up instruction — Tell R3 Track L owns reopen/close bugs (2026-10-19 23:26 UTC)

The user approved Track L, which now owns both bugs (reopen admission after a recipient lull, and the close race) on the current path.

- It works on its own branch. It will make small, local changes around creatorRetirementResumeRequested / needsOrdinaryReadinessRecovery in v3-live.ts, the lull's requestRetainedHistory in v3-room.ts, and close handling. It will also remove the harness skip of the final recipient lull.
- Don't edit those spots yourself. Expect one more rebase when L lands.
- The acceptance check I gave you still applies: the new path must pass a Grid run with the final recipient lull NOT skipped.

### Follow-up instruction — Tell R3 to cite sources, not bare G-ids (2026-10-19 23:27 UTC)

Spec slices you commit to the repo must not refer to bare G-ids alone.

The G1–G28 checklist exists only in the session scratchpad (track-r/GUARANTEES.md), so a repo reader can't resolve "G15". Do either of these:
(a) cite the original spec or plan line next to each G-id, e.g. "G15 (6B:183-184, PLAN:1277)";
or (b) commit the checklist with its source column into specs/bounded-storage-lifecycle/ as part of S1, and link it from each slice.

Prefer (b), and keep the source citations there current with your rebased line numbers.

### Follow-up instruction — Tell R3 guarantees file is now in the repo (2026-10-19 23:36 UTC)

The G1–G28 checklist is now in the repo: specs/bounded-storage-lifecycle/golden-path-guarantees.md (commit 1c6a8259 on codex/phase3a1b-p6-golden-path). Rebase onto it, and edit that file rather than creating your own copy.

- As part of S1, refresh its source line numbers to the current tree. They were taken at 40c0895b; the header says so.
- Link your slices to it, e.g. `[G15](../golden-path-guarantees.md)` plus the source.
- Every track's brief, reports and decisions are now in docs/realtime-latency/; yours are under tracks/20-track-r2-r3-watermark-retirement/. When you finish, add your final write-up there as RESULT.md, with local paths written as `<evidence>/...` (that placeholder stands for the scratchpad root). I'll update the README's decision log when I merge.

### Follow-up instruction — Tell R3: Track L landed, rebase (2026-10-20 01:36 UTC)

Track L has landed: rebase onto codex/phase3a1b-p6-golden-path, now at 4bb6bc7d.

What changed:
- f9828cd0: an orderly close cancels the retained republish it is serving (the v3-room.ts retained publisher callback).
- 2cb1a9fc and 9379fc48: a reopened recipient discharges its completed-retirement halt.
  - It runs a new resume block in v3-room.ts, `maintainCreatorRecipientRecoveryPool({resume: true})`, which goes through `runCreatorReceivedRecoveryMaintenance` with `resume` and `creatorCloseRegistration(…, "recipient-resume")`.
  - It re-runs the original received reconstruction with `requireClosedWorkflowCompletion`, gated by the creator's `completedRequestMatches` predicate.
- 504e4035: the Grid harness runs the final recipient lull again (no skip). Your acceptance check is now just the normal Grid run with LULL=1.
- New test: tests/recipient-lull-reopen-close-native.test.ts. It must stay green with your path on.
- Write-up: docs/realtime-latency/tracks/22-track-l-reopen-and-close/RESULT.md.

L left one open bug in your area. A recipient reopened after only 4 epochs is refused with RECOVERY_CERTIFICATE_UNPROVEN_ABSENCE, because `acquireCreatorSnapshotRetirementReconstructionRequest` passes no `previousCertificate`; 5 and 8 epochs pass.
- Your design must not have this failure.
- If the old path keeps it, note it in PROGRESS.md with the root cause.
- Also make sure an active (unfinished) retirement intent at recipient reopen can be resumed on your path. On the old path it halts the recipient permanently.

### Report returned by the agent (2026-10-20 03:42 UTC)

#### Track R3 handback: single-database watermark retirement

The latency goal is not met, and the default flip is not in. What landed is stage 1a of slice 14a, and it is opt-in. It is correct and it passes the golden path, but on its own it saves only 3–9% on the creator lull and 4–6% on the recipient lull. Reaching the millisecond range needs slice 14b, which is not built. No guarantee was weakened. Both Track L residuals are fixed.

**Where things are**
- Worktree `<worktree agent-aeb6ebdfc4584ace2>/`, branch `worktree-agent-aeb6ebdfc4584ace2`, base 4bb6bc7d. Nothing pushed.
- Full record: `docs/realtime-latency/tracks/20-track-r2-r3-watermark-retirement/RESULT.md` (R3 section first, R2 below it), commit 68b4168e.
- Notes: `<evidence>/track-r3/PROGRESS.md`.

##### Commits (oldest first)

| Commit | What |
|---|---|
| 84fd4c8f | R2 prototype |
| d3cc655d | specs 14 and 14a–14f (S1–S6), on their own |
| 4f0d5e60 / 0d6258e3 | 14c RED / GREEN |
| 9080246e, 04f7b009 / b087617b | 14a format: RED, RED fixture fix / GREEN |
| 166c0d9c / 372e465c | room session RED / GREEN |
| 2fee9234 / 0c4e0309 | owner facets RED / GREEN |
| c0729b23 / 59d23366 | named-owner binding RED / GREEN |
| 2ff759bb / a2a77ebd | residual 1 RED / fix |
| 4ffb9574 / 6e9a7899 | node room install RED / GREEN |
| 3bc4edfc | residual 2 fix (its RED is a case in 4ffb9574) |
| 981bb354 | Grid opt-in |
| 6c18b0c2 | 14f native cases 1–4 |
| 0eb4d0a6 / a07e3206 | legacy-room refusal RED / fix |
| cd9d2d88 | spec statuses, 14f evidence record, requirements-to-evidence row 14 |
| 8955d40d | prettier on the two R2 prototype files |
| 68b4168e | RESULT.md and README outcome line |

- 04f7b009 changed a RED I had written, before its GREEN. The fixture used an object id the storage layer rejects; the assertion is unchanged.
- No pre-existing RED or governance test, frozen artifact, registry or vector was edited.
- Commit trailer: your brief says "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>", but the harness requires "Claude Opus 5.5 (1M context)". Every commit uses the harness line.

##### Per slice
- **14a (S1): stage 1a landed, opt-in.**
  - A version-7 room database holding the five owners in disjoint namespaces, with their formats unchanged.
  - A room retirement session: one strict read-write transaction over every room store, with checkpoint, commit and abort.
  - Session facets that run each owner's original transitions inside it.
  - The node install runs in that session: T1, a checkpoint, the floor in its own database, then T2. `verifyCompleted` and the drains still run after the commit.
  - Selection: the opt-in host `createBrowserV3RoomDatabaseStorageHost()` in the example, and `STARTUP_HEALTHY_GRID_ROOM_DATABASE=1` for the Grid.
  - Not landed: "one verified decision, one transaction" with marks as write fences.
- **14b (S2): not started.** This is the latency lever.
- **14c (S3):** storage half only (floor version 2 with per-owner fences, opt-in). The node does not write or check the fence yet.
- **14d (S4): not started.** Instead, the room host refuses an existing six-database room with `V3_ROOM_DATABASE_MIGRATION_UNAVAILABLE` before it writes anything.
- **14e (S5): not started.**
- **14f (S6): partial.**

##### Track L residuals (both fixed on the shared path, so the old path no longer has them)
1. **Four-epoch reopen refused with `UNPROVEN_ABSENCE`.**
   - Cause: `acquireCreatorSnapshotRetirementReconstructionRequest` checked absence against the current certificate only. After four rollovers the current Cut still classifies a scope this copy retired under its previous certificate.
   - Fix: the reopen passes the previous Cut (epoch − 1) and the predecessor trust. The law is unchanged.
   - `tests/recipient-lull-reopen-four-epochs-native.test.ts` passes 3/3.
2. **An unfinished retirement intent at recipient reopen halted the recipient for good.**
   - Cause: the resume gate in `runCreatorReceivedRecoveryMaintenance` accepted only `active === null`, so nothing ever discharged the halt.
   - Fix: it also accepts this copy's own active intent at the same head. The original reconstruction then completes that same intent, with source proof and decision checked equal to the fresh ones, or it refuses.
   - Evidence: a crash-injection case in `tests/room-database-retirement-native.test.ts`. There is no SQLite crash injection for this.

##### G1–G28
The full table, with the evidencing test for each id, is in RESULT.md §5. Summary:
- **Kept, every id except G28.** The session runs the existing transitions, checks and charges unchanged.
- **G9 is stronger.** Each owner's recheck and its write now share one native transaction.
- **G25 is kept by refusal.** There is no migration, and existing rooms are refused before anything changes.
- **G15** is covered for abort and failure, not yet for SIGKILL.
- **G22:** the proof-accounting test shows the same 20 failures as base, with identical names.
- **G28 is PARTIAL:** SIGKILL cases 5–9 and the long-room bounds (case 11) were not run.

##### 14f (S6) evidence per engine
- Playwright config `playwright.room-retirement-session-native.config.ts`: 18 of 18 pass.

| Case | Chromium 151.0.7922.34 | Firefox 153.0 | WebKit 26.5 |
|---|---|---|---|
| 1–4, plus not-ready refusal | pass | pass | pass |
| 5–9 (SIGKILL, migration) | OPEN | OPEN | OPEN |
| 10 (Grid golden path) | pass | n/a | n/a |
| 11 (long room with bounds) | OPEN | n/a | n/a |

##### Bench against base
Healthy native Grid, 8 rollovers, 3 interleaved ABBA pairs per mode. All 12 runs passed, and every room run committed 54 sessions with no aborts. Steady medians in ms:

| Window | LULL=1 base | LULL=1 room | Concurrent base | Concurrent room |
|---|---|---|---|---|
| Seal | 292 | 291 | 310 | 313 |
| Creator adoption | 524 | 520 | 592 | 591 |
| Recipient install | 349 | 364 | 414 | 422 |
| Creator lull | 2450 | 2376 (−3%) | 2937 | 2667 (−9%) |
| Recipient lull | 1350 | 1272 (−6%) | 1503 | 1437 (−4%) |

- **Recipient install tail is wider on the room path:** p90 380→462 and 424→528 ms. Unresolved with only 3 pairs.
- **Session hold:** p50 106–116 ms, max about 380 ms per install.
- **Per-move latency during lulls (concurrent):**
  - creator-lull moves: visible p50 2096→1913 ms;
  - recipient-lull moves: visible p50 1065→983 ms;
  - issue time is unchanged;
  - durable latency was not measured, because this harness mode records no receipt stages.
- **Longest main-thread task:** no window gets worse (for example, creator lull max 31–34 ms on both).
- **Why the gain is small:** stage 1a removes only transaction overhead. Re-authentication on every pass (about 45% of a lull), the two-phase commit's steps, the `verifyCompleted` readbacks and the drains all remain.
- **16 rollovers, one run per path:**
  - Both paths reach epoch 16 with close, reopen and continued gameplay.
  - Both then fail the same harness check: the proof-event buffer overflows (`proofEventsTruncated`).
  - Storage is identical on both paths. The creator is flat.
  - Every recipient's issuance grows by 3 issued and 3 outbox rows per epoch, on both paths. This was already happening before this work, and it matters for G1 and case 11.

##### Suites against base
- **node:** 0 new failures (48 failing, the same as Track L's head).
- **storage and storage-browser:** 625 of 625 pass. Vitest still exits 1 because of an RPC timeout under load.
- **storage-node retirement set:** 0 new failures.
- **Root set** (92 filters, which vitest matched to 187 files): 0 new per-test failures. I ran the 70 failing files again with every changed code file swapped back to 4bb6bc7d, then restored and verified the tree.
  - One test fails at both with a different message at head (envelope purity). Rerun alone, it fails exactly as at base.
- **Room-path tests:** room test 4/4, Track L's reopen-close 3/3, Track K's long-room retention 2/2, four-epoch 3/3.
- **Checks:** `pnpm -r typecheck` reports 0 errors, and the shadowed-sources guard is clean.

##### Default flip: not in
- 14f is incomplete: no SIGKILL cases and no long-room bounds.
- 14b, 14d and 14e are not built. Without 14d an existing room cannot move to the room database.
- Flipping it would buy little latency anyway.

##### What remains, in order
1. **14b:** a ledger of verified facts, verify-on-open, and one decision per epoch. This is the only path to the millisecond range.
2. **Wire 14c into the node.**
3. **14d migration**, with its crash matrix.
4. **14e:** the per-transaction cap and charge-before-delete.
5. **14f:** SIGKILL cases 5–9, then case 11. Case 11 also needs the recipient issuance growth fixed or bounded, and a proof-event budget that survives 16 rollovers.

##### Risks
- **Lock hold:** the session holds every room store for about 100–380 ms per install, and the recipient install tail is wider.
- **Web Locks:** the snapshot owner refuses retirement without them. Node tests must install a lock manager.
- **One module instance:** room owners and the session registry must load from one module instance. `./maintenance` re-exports every room factory, and a bundle that aliases storage-browser to a file needs a `maintenance` alias.
- **Filtered issuance facade:** new facades must keep the maintenance-capability link to the genuine store. Otherwise the room path refuses with `RETENTION_FOREIGN_OWNER`, which fails closed.
- **Shared-path residual fixes** also change the default path.

##### Other notes
- `installClosedRetirementSource` keeps its name and body, because a source-shape test and the Grid's `build.ts` read it by name. A separate wrapper opens the session.
- I copied the `node_datachannel.node` binary from the main checkout's `node_modules` into the worktree's `node_modules`. The main checkout was only read.
- The bench bundle was built before a07e3206. That commit only adds a startup version probe in the example host and does not touch the retirement path.
- The untracked `.logs/bounded-storage-lifecycle/r8-warm-capacity-01/` stays uncommitted.
