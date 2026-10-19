# Track L: reopen admission failure and close race

**Outcome:** IN PROGRESS.

### Brief (plan given to the agent) (2026-10-19 23:25 UTC)

Track L: fix two game-breaking bugs on the current maintenance path of the ts-drp repo (a TypeScript local-first CRDT meant to power real-time games). The user approved this track.

REPO AND BASE
- Main checkout: <repo>. You work in your own git worktree.
- Base: branch codex/phase3a1b-p6-golden-path at 9f606ce8. First check that your worktree HEAD is 9f606ce8. If it isn't, move to it with `git switch -C <your-branch> codex/phase3a1b-p6-golden-path`. `git reset --hard` is blocked by a hook.
- Recent history on that branch:
  - 4c4f192c, de70325e: added the opt-in lull API (`V3RoomSession.maintainRecoveryPool()`), the recipient lull boundary and FIFO-queued ingress during deferrable lulls.
  - 719e4732: Track G presentation overlay.
  - 75aa8807: Track H long-task cuts.
  - 742a517e..9f606ce8: Track K, recipient journal retention bounded past epoch 8.

THE TWO BUGS
Both were found by Track K; both predate it and reproduce on de70325e. Read Track K's write-up first, especially §5 "The recipient-lull skip" and §6: <evidence>/track-k/RESULT.md
K's bench scripts and runs are in <evidence>/track-k/bench/. Relevant runs: run-fix2-r12-lull and run-base2b-r5-lull. The test-only quiesce variant is healthy-grid.quiesce-variant.ts.

1. Reopen admission failure.
   - Sequence: a recipient's lull (`maintainRecoveryPool`) completes a retirement, then the room is closed (persisted), then reopened.
   - The close and the reopen succeed and the world matches. But no recipient ever receives or admits the creator's first continued-gameplay move: no delivery-branch events at all, and the test times out.
   - In a game, play silently stops after a restart.
   - K's lead (UNVERIFIED): a completed retirement control with throughEpoch + 1 === currentEpoch satisfies `creatorRetirementResumeRequested` in packages/node/src/v3-live.ts (K cited ~19170-19183; lines moved ~+80 since). That makes `needsOrdinaryReadinessRecovery` true (K cited ~19669-19672), and in the healthy flow only the next install clears it.
   - Verify or refute the lead with evidence before fixing anything.
2. Close race.
   - A `maintained` recipient lull fires an unawaited `roomTransport.requestRetainedHistory()` (packages/node/src/v3-room.ts ~6541-6544).
   - Peers serve that request while the room is closing. Their queued `republishRetained` finds the plane deactivated and fails with `not-active` (v3-live.ts ~16304, v3-room.ts ~3941).
   - The transport counts that as a join fault, so the persisted close fails.
   - A real game closing right after a lull would hit this, so fix it in the product, not only in the harness. Decide and justify: should close join or cancel the in-flight repair, or should a not-active republish during an orderly close not count as a fault? Never hide real faults.

ORDER OF WORK
1. Reproduce each bug deterministically at node level, as a new test that fails at 9f606ce8 (RED). Commit the RED tests first.
   - Model them on existing node tests that use real SQLite stores, e.g. tests/recipient-long-room-journal-retention-native.test.ts and the creator-recipient-recovery-pool tests.
2. Root-cause each bug with code citations.
3. Fix each with the smallest product change that keeps every guarantee. Commit each fix separately. Make the RED tests GREEN.
4. Remove the harness skip of the final recipient lull in tests/fixtures/startup-discovery/healthy-grid.ts (see the comment Track K corrected in 86dc4004), and commit that separately.
5. Grid acceptance, with the skip removed. Each of these must pass, including persisted close, reopen and continued gameplay:
   - 5, 8 and 12 rollovers with STARTUP_HEALTHY_GRID_POOL_LULL=1;
   - 8 rollovers with STARTUP_HEALTHY_GRID_POOL_LULL=concurrent;
   - 8 rollovers with STARTUP_HEALTHY_GRID_PRESENTATION=1.
   Also show with one paired comparison that seal, adoption, install and lull timings didn't regress.

GUARANTEES
- The golden-path guarantees G1–G28 are listed in <evidence>/track-r/GUARANTEES.md. Never weaken any of them.
- In your report, argue each guarantee your change touches, as Track K's RESULT.md §3.2 does.
- In particular, never let a reopened room admit moves before its readiness and recovery state is genuinely re-established; fix the condition, don't bypass it.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
- If a fix cannot keep a guarantee, stop, write down the counterexample and report. Don't work around it.

PARALLEL WORK
Track R3 is rewriting retirement into a single-database watermark design on another branch (worktree-agent-aeb6ebdfc4584ace2). It will rebase onto whatever you land. Keep your change minimal and local to the two bugs: no restructuring of retirement or maintenance code. List every file and function you touched.

HOW TO RUN THINGS
- Grid bench recipe:
  - Build a bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <new-outdir>`. The outdir must not exist.
  - Run: `STARTUP_HEALTHY_GRID_ROLLOVERS=<n> STARTUP_HEALTHY_GRID_POOL_LULL=1 STARTUP_EVIDENCE=<dir> STARTUP_ENTRY=r8-source-binding STARTUP_SOURCE_NATIVE_RESOURCES=1 STARTUP_ARTIFACTS=<outdir> pnpm exec playwright test --config tests/fixtures/startup-discovery/playwright.config.ts --project chromium -g "healthy native Grid integrates"`.
  - Summarize with `python3 <evidence>/track-k/bench/summary.py <dir>/report.json`.
- The bundle reads canonical, storage, storage-browser and compaction from dist, and node, protocol-v3 and seal from src.
  - Build dists in your worktree before bundling: `pnpm --filter @ts-drp/<pkg> build` for canonical, protocol-v3, compaction, storage, storage-browser, in that order. Compaction's build reads protocol-v3's dist.
- The Grid build imports untracked files under .logs/bounded-storage-lifecycle/r8-warm-capacity-01/. Copy that directory from the main checkout into your worktree, with the same path. Never commit it.
- Tests: run vitest from the repo root with `--exclude ".claude/**" --no-coverage`.
  - Compare suites per test against the base: node, plus the storage-node retirement tests.
  - Many RED/governance tests already fail on this branch, so judge only passed→failed changes, and rerun alone anything that looks like a timeout.
  - The machine is heavily loaded (load average 30–120), so expect timeouts, and use interleaved pairs for any timing claim.

HARD RULES
- `pnpm -r typecheck` must end at 0 errors. Run prettier on new files.
- Never run bare `tsc -p` without `--noEmit`. Compiled .js next to .ts shadows sources; the guard is `node scripts/check-shadowed-sources.mjs`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into your own scratch directory: <evidence>/track-l/
- Never delete logs.
- Don't kill processes you didn't start.
- Don't touch the main checkout, except to copy the .logs bench inputs out of it.
- Commit only on your own worktree branch. Never push.
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Keep PROGRESS.md in <evidence>/track-l/ current, and put the final write-up in RESULT.md there.

FINAL REPORT
- The commit list.
- For each bug:
  - reproduction;
  - root cause with code citations, including whether K's lead was right;
  - the fix and why it is safe;
  - the guarantee argument.
- Per-test suite diff against base.
- Typecheck result.
- A Grid acceptance table: each run, pass/fail, per-rollover costs.
- What remains, and the risks.

### Report returned by the agent

_No final report: the agent is still running._
