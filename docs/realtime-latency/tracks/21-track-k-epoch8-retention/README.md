# Track K: epoch-8 recipient turnover refusal

**Outcome:** Landed in 742a517e, 86dc4004, 9f606ce8.

**Working documents in this folder:** [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-19 21:01 UTC)

You are Track K: root-cause and fix a long-room correctness bug in the ts-drp repository. ts-drp is a TypeScript
local-first CRDT library meant to power real-time games, whose rooms must live for thousands of epochs.

#### Where you are

- You are in your own git worktree, branched from commit de70325e on branch codex/phase3a1b-p6-golden-path.
  Confirm with `git log -1`; if it is not de70325e, run `git reset --hard de70325e` inside YOUR worktree only.
- Main checkout: <repo>. Do NOT edit it.
- Commit only on your own worktree branch. Never push.
- Scratch root (write notes under track-k/):
  <evidence>
- The machine is shared and heavily loaded:
  - never kill processes you did not start;
  - a hook blocks `rm -rf`, `unlink` and `git checkout <ref> -- <path>`. Move files to scratch instead, and use
    `git show HEAD:path > path` to restore a file;
  - run vitest from the worktree root with `--exclude ".claude/**" --no-coverage`;
  - you may need `pnpm install --offline --ignore-scripts`, and `pnpm --filter @ts-drp/<pkg> build` for packages
    consumed from dist.
- Another agent (Track R2) is redesigning recovery-pool maintenance cost in a different worktree. Keep your fix
  minimal and targeted; do not restructure maintenance. List every file you touch in your report.

#### The bug

- At epoch 8, recipient bounded-recovery turnover fails with "journal retirement refused: malformed-input".
  Observed cause so far: the protected scopes exceed the journal retirement limit of 7.
- It also fails at HEAD, without any opt-in lull: a 10-rollover run of the healthy Grid benchmark fails at
  recipient install t8.
- The benchmark masks it today:
  - tests/fixtures/startup-discovery/healthy-grid.ts around line 478 skips the recipient lull after the last
    rollover, with the comment "its original turnover is refused at epoch 8";
  - tests/fixtures/startup-discovery/r8-source-binding.pw.ts around line 166 mentions "Eight traverses the
    existing seven-generation recovery ceiling".
- packages/node/src/internal/creator-closed-rollback-data.ts contains the refusal text.

A room that cannot pass epoch 8 violates the golden path: hot state and protocol overhead must not grow with
room age, through thousands of epochs without resets.

#### What to do

1. Reproduce it deterministically.
   - Prefer a node or unit-level reproduction (for example, drive a recipient through 10+ epochs with the existing
     genuine fixtures in packages/node/tests and tests/fixtures/phase-6a-v3).
   - Also reproduce it with the Grid benchmark at 10+ rollovers:
     - Bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <outdir>`.
     - Run: `STARTUP_HEALTHY_GRID_ROLLOVERS=<n> STARTUP_EVIDENCE=<dir> STARTUP_ENTRY=r8-source-binding
       STARTUP_SOURCE_NATIVE_RESOURCES=1 STARTUP_ARTIFACTS=<outdir> pnpm exec playwright test --config
       tests/fixtures/startup-discovery/playwright.config.ts --project chromium -g "healthy native Grid integrates"`.
     - Check which rollover counts the harness accepts and extend it if needed. Add
       STARTUP_HEALTHY_GRID_POOL_LULL=1 to exercise the recipient lull.
2. Root-cause it. Answer:
   - Why do the protected scopes keep growing on a recipient?
   - Is something not released or retired that should be, or is the limit of 7 a wrong bound for a valid steady
     state?
   - Does the creator have the same latent issue at higher epochs?
   Cite code locations.
3. Fix it without weakening any golden-path guarantee.
   - The checklist is scratchpad/track-r/GUARANTEES.md (G1–G28, with spec citations; re-verify line numbers).
     Especially relevant:
     - G1: no growth with room age;
     - G18: protected set = current head + exactly two usable rollbacks + bounded pending + shared bytes;
     - G21: bounded work with reviewed limits, not post-hoc constants;
     - G7, G9, G14, G15, G17: one retirement owner, transactional recheck, crash old-XOR-new, no resurrection.
   - Prefer fixing the leak over raising a limit. If the correct fix really is a different bound, derive it from
     the spec's protected-set definition and flag it as a policy change.
4. Prove it.
   - Write a regression test that drives 16+ epochs on a recipient, and on the creator too if relevant.
   - Before/after per-test diff of the node, storage, storage-browser and storage-node suites. There are many
     pre-existing failures, so only NEW failures matter, and you must explain or fix them.
   - Keep `pnpm -r typecheck` at 0 errors.
   - Run the Grid benchmark at 10+ rollovers with STARTUP_HEALTHY_GRID_POOL_LULL=1, and with the recipient-lull
     skip removed, to show it passes. Update the benchmark comment and skip if they are no longer needed.

#### Deliverables

- scratchpad/track-k/RESULT.md:
  - the reproduction;
  - the root cause, with code citations;
  - the fix and its guarantee argument;
  - the test before/after diff;
  - the benchmark result.
- Commits on your worktree branch, plus scratchpad/track-k/fix.patch.
- Final message: worktree path, branch, commit hashes, and 10–20 lines of results. Report faithfully. If you
  could not reproduce or fix it, say exactly how far you got.

### Follow-up instruction — tell Track K .logs harness files are back (2026-10-19 21:57 UTC)

FYI: the Grid benchmark's untracked .logs inputs are available again in the main checkout. The harness imports .logs/bounded-storage-lifecycle/r8-warm-capacity-01/{grid-candidate-01/grid-corpus.ts,worker-transport.ts}. For a while they were moved to <archive>/untracked-logs/ (paths preserved), and are now restored at .logs/bounded-storage-lifecycle/r8-warm-capacity-01/. Your worktree has no untracked files, so copy that directory (read-only source; do not move it) into your worktree's .logs if a bundle build fails with "Could not resolve ../../../.logs/...". No reply needed.

### Report returned by the agent (2026-10-19 23:00 UTC)

Track K is done: the epoch-8 recipient refusal is reproduced, root-caused and fixed, and all three commits are on my worktree branch (not pushed). Without the lull, the Grid benchmark passes at 10 rollovers; with the lull it passes at 12 only with the final recipient lull still skipped. Removing that skip exposes two other failures, one confirmed pre-existing on de70325e.

- **Worktree:** <worktree agent-a7dca3b495f91714f>/
- **Branch:** worktree-agent-a7dca3b495f91714f (parent de70325e)
- **Commits:**
  - d9f55ea9 fix: bound recipient journal retention and snapshot hole order past epoch 8
  - a00c0e91 test: keep the final recipient lull skipped in the Grid bench, with the real reason
  - 53d1a43e refactor: keep the public role-reconciliation wrapper signature unchanged
- **Patch:** <evidence>/track-k/fix.patch
- **Write-up:** <evidence>/track-k/RESULT.md (code citations and the G1–G28 argument are there)

**Reproduction.** A new node test, `tests/recipient-long-room-journal-retention-native.test.ts`, drives 16 epochs on real SQLite stores. On the base code the recipient's protected scopes grow by one per epoch, from [0,1,2] at epoch 4 to [0..6] at epoch 8, which is the limit of 7. The next install fails with "journal retirement refused: malformed-input". The Grid benchmark at 10 rollovers fails the same way at `recipient-install-8:1`.

**Root cause.** It is a leak, not a wrong bound. The leak-free creator holds exactly 2 protected scopes (k-3, k-2), and no limit was changed. A scope that is never collectible stays protected forever (`creator-closed-rollback-data.ts` ~19324-19335), and on a recipient three things made every scope uncollectible:
1. Any received recovery certificate marked the whole journal as unclassified replay (~21226), so every older scope was kept as "source-coverage-incomplete".
2. Recipients never recorded a closed-membership carrier, which the creator records at close (creator-close.ts ~4035-4064). Without it no recipient scope can be classified collectible.
3. The recipient's single turnover pass was spent on a generation drain, which suppresses journal prefixes. A scope is only classifiable in a short window, so scope k-3 was stranded.

**Creator.** Its journal does not leak. It had a separate latent bug: the storage contract sorted protected snapshot holes as text, putting epoch 10 before 9, so the seal after epoch 11 failed with "native metadata source or phase changed". Every room would hit this at 9|10, 99|100, and so on.

**Fix.**
- A received certificate is narrowly classified: it no longer marks every older scope uncollectible once its scope is protected and its generation consumers are covered.
- The recipient records its own carrier at install, only when its graph matches the authenticated close set exactly.
- One extra fresh pass is requested only through a new recipient-only entry, `reconcileCreatorReceivedSnapshotRecoveryRoles`.
- Protected holes are sorted numerically in `packages/storage/src/snapshot-transfer.ts`.

**Results.**
- **Regression test:** at HEAD, both tests pass (exit 0). The recipient and creator journals are identical and constant from epoch 8 to 16: 8 headers, 6 rows, protected [k-3, k-2].
- **Suite diff (before vs after):** no new failures in storage, storage-browser or storage-node.
  - Node had 2 new failures. Both were existing tests pinning the public wrapper's 5-parameter signature; 53d1a43e restores the wrapper exactly, and both pass on a targeted rerun.
  - The other differences are load-sensitive multi-process tests, or the same environment failures as on base.
- **Typecheck:** `pnpm -r typecheck` has 0 errors.
- **Grid at HEAD:**
  - 10 rollovers without lull passes.
  - 12 rollovers with `STARTUP_HEALTHY_GRID_POOL_LULL=1` passes, with every lull maintained.
  - 16-rollover runs complete every rollover, including recipient lulls e8..e16. They fail only on a harness limit: a 50,000-event cap in `critical-observer.ts:297`.

**Recipient-lull skip.** I kept the skip and corrected its comment. With it removed, every lull now succeeds, but two other failures appear:
- **Close race:** the final lull's unawaited history repair (v3-room.ts:6541-6544) races the persisted close, and peers report not-active.
- **Restart failure:** after a lull and a persisted reopen, recipients never accept the next live move. This also happens on de70325e at 5 rollovers, so it predates this fix. It breaks gameplay after a restart, so it probably needs its own track (Track R2's area). My unverified guess is that the reopen sees a just-completed retirement and holds back admission (v3-live.ts:19170).

**Remaining risks.**
- The carrier is recorded only on exact graph agreement and not in crash-recovery install paths. Each miss leaves one scope protected forever; eight would bring the refusal back.
- Rooms that already leaked scopes are not repaired; they stay fail-closed until an explicit migration.

**Files touched.**
- `packages/node/src/internal/creator-closed-rollback-data.ts`
- `packages/node/src/creator-adoption.ts`
- `packages/node/src/v3-live.ts`
- `packages/node/src/creator-close.ts`
- `packages/storage/src/snapshot-transfer.ts` (storage dist rebuilt, untracked)
- `tests/recipient-long-room-journal-retention-native.test.ts` (new)
- `tests/fixtures/startup-discovery/healthy-grid.ts` (accepts 4, 5 or 8..32 rollovers; skip comment)
- `tests/fixtures/startup-discovery/r8-source-binding.pw.ts` (same range)

I did not touch the main checkout, the maintenance structure or any limit. The `.logs` bench inputs stay uncommitted. The base comparison ran in a copy-on-write clone at `scratchpad/track-k/basetree`, which can be deleted.
